/**
 * Podcast 分段下載 + 串流上傳 Drive 的回歸測試(downloadAndUploadNextChunk)。
 *
 * 為什麼特別測這一塊:這裡踩過一個很痛的雷 —— UrlFetchApp 抓大檔案超過 Apps Script
 * 隱性上限時會「安靜截斷」:HTTP 還是 200、不丟例外,但內容只有一部分,結果把不完整
 * 的音檔當成功存進 Drive,使用者聽到一半才發現。現在的防線是「每一段都比對長度,
 * 對不上就直接失敗」,這條防線一旦被改壞不會有任何徵兆,所以要用測試守住。
 */
const test = require('node:test');
const assert = require('node:assert');
const { loadCodeGs, makeUrlFetchApp } = require('./helpers/apps-script-env');

const AUDIO_URL = 'https://example.com/ep.mp3';
const UPLOAD_URL = 'https://upload.example.com/session';

function newJob() {
  return {
    status: 'downloading',
    audioUrl: AUDIO_URL,
    uploadUrl: UPLOAD_URL,
    contentType: 'audio/mpeg',
    offset: 0,
    totalSize: null,
    driveFileId: null
  };
}

/**
 * 模擬「來源音檔主機 + Drive 分段上傳端點」。
 * content 一律用 { length: N } 這種只有長度的假物件:受測邏輯只讀 bytes.length,
 * 不會逐 byte 取值,所以模擬幾十 MB 的檔案也不用真的配置記憶體。
 */
function makeHandler(totalSize, opts) {
  opts = opts || {};
  return function (url, options) {
    if (url === AUDIO_URL) {
      const m = options.headers.Range.match(/bytes=(\d+)-(\d+)/);
      const start = Number(m[1]);
      const end = Math.min(Number(m[2]), totalSize - 1);
      if (opts.noRangeSupport && start === 0) {
        return { code: 200, content: { length: totalSize } };
      }
      if (opts.downloadFails) return { code: 404 };
      let len = end - start + 1;
      if (opts.truncateChunkStartingAt === start) len = Math.floor(len / 2); // 模擬安靜截斷
      const headers = opts.omitContentRange
        ? {}
        : { 'Content-Range': 'bytes ' + start + '-' + end + '/' + totalSize };
      return { code: 206, headers: headers, content: { length: len } };
    }
    if (url === UPLOAD_URL) {
      const m = options.headers['Content-Range'].match(/bytes (\d+)-(\d+)\/(\d+)/);
      const isFinal = Number(m[2]) + 1 === Number(m[3]);
      if (opts.uploadFailsMidway && !isFinal) return { code: 500 };
      return isFinal
        ? { code: 200, text: JSON.stringify({ id: 'drive-file-id' }) }
        : { code: 308 };
    }
    throw new Error('測試沒預期到的網址:' + url);
  };
}

function runToCompletion(env, job, maxRounds) {
  let rounds = 0;
  while (rounds < (maxRounds || 50)) {
    rounds++;
    if (env.downloadAndUploadNextChunk(job)) return rounds;
  }
  throw new Error('超過預期輪數還沒下載完');
}

test('多段接力:offset 逐段推進,最後收斂到檔案總長度', () => {
  const CHUNK = loadCodeGs().evaluate('PODCAST_CHUNK_SIZE');
  const totalSize = CHUNK * 2 + 1024 * 1024; // 兩整段 + 一段零頭
  const urlFetch = makeUrlFetchApp(makeHandler(totalSize));
  const env = loadCodeGs({ UrlFetchApp: urlFetch });
  const job = newJob();

  const rounds = runToCompletion(env, job);

  assert.strictEqual(rounds, 3, '應該剛好三段');
  assert.strictEqual(job.offset, totalSize);
  assert.strictEqual(job.totalSize, totalSize);
  assert.strictEqual(job.driveFileId, 'drive-file-id', '最後一段要拿到 Drive 檔案 id');
});

test('多段接力:總長度取自伺服器回應的 Content-Range,不是來源自己宣告的值', () => {
  // 踩過的雷:podcast RSS 的 <enclosure length> 在某些平台是沒意義的假值(例如 1),
  // 所以總長度只能信任下載當下伺服器回的 Content-Range。
  const CHUNK = loadCodeGs().evaluate('PODCAST_CHUNK_SIZE');
  const totalSize = CHUNK + 500;
  const env = loadCodeGs({ UrlFetchApp: makeUrlFetchApp(makeHandler(totalSize)) });
  const job = newJob();

  env.downloadAndUploadNextChunk(job);

  assert.strictEqual(job.totalSize, totalSize);
});

test('上傳到 Drive 的 Content-Range 標頭要連續、不重疊、不漏 byte', () => {
  const CHUNK = loadCodeGs().evaluate('PODCAST_CHUNK_SIZE');
  const totalSize = CHUNK * 2 + 777;
  const urlFetch = makeUrlFetchApp(makeHandler(totalSize));
  const env = loadCodeGs({ UrlFetchApp: urlFetch });

  runToCompletion(env, newJob());

  const ranges = urlFetch.calls
    .filter((c) => c.url === UPLOAD_URL)
    .map((c) => c.options.headers['Content-Range']);
  assert.deepStrictEqual(ranges, [
    'bytes 0-' + (CHUNK - 1) + '/' + totalSize,
    'bytes ' + CHUNK + '-' + (CHUNK * 2 - 1) + '/' + totalSize,
    'bytes ' + CHUNK * 2 + '-' + (totalSize - 1) + '/' + totalSize
  ]);
});

test('非最後一段被安靜截斷時要直接失敗,不能默默上傳半段', () => {
  const CHUNK = loadCodeGs().evaluate('PODCAST_CHUNK_SIZE');
  const totalSize = CHUNK * 3;
  const urlFetch = makeUrlFetchApp(makeHandler(totalSize, { truncateChunkStartingAt: CHUNK }));
  const env = loadCodeGs({ UrlFetchApp: urlFetch });
  const job = newJob();

  env.downloadAndUploadNextChunk(job); // 第一段正常
  assert.throws(() => env.downloadAndUploadNextChunk(job), /沒抓完整/);

  // 而且被截斷的那一段絕對不能已經被送去 Drive
  const uploadedStarts = urlFetch.calls
    .filter((c) => c.url === UPLOAD_URL)
    .map((c) => c.options.headers['Content-Range']);
  assert.strictEqual(uploadedStarts.length, 1, '只有第一段該被上傳');
});

test('來源不支援分段下載(直接回 200 完整內容)時,一次上傳完成', () => {
  const totalSize = 3 * 1024 * 1024;
  const urlFetch = makeUrlFetchApp(makeHandler(totalSize, { noRangeSupport: true }));
  const env = loadCodeGs({ UrlFetchApp: urlFetch });
  const job = newJob();

  assert.strictEqual(env.downloadAndUploadNextChunk(job), true);
  assert.strictEqual(job.totalSize, totalSize);
  assert.strictEqual(job.offset, totalSize);
  assert.strictEqual(job.driveFileId, 'drive-file-id');
  assert.strictEqual(urlFetch.calls.filter((c) => c.url === AUDIO_URL).length, 1);
});

test('讀不到 Content-Range 時要失敗,而不是拿不確定的長度硬做', () => {
  const env = loadCodeGs({ UrlFetchApp: makeUrlFetchApp(makeHandler(1024, { omitContentRange: true })) });

  assert.throws(() => env.downloadAndUploadNextChunk(newJob()), /讀不到檔案總長度/);
});

test('來源網址失效(非 206)時要失敗', () => {
  const env = loadCodeGs({ UrlFetchApp: makeUrlFetchApp(makeHandler(1024, { downloadFails: true })) });

  assert.throws(() => env.downloadAndUploadNextChunk(newJob()), /下載失敗/);
});

test('中段上傳 Drive 失敗(非 308)時要失敗', () => {
  const CHUNK = loadCodeGs().evaluate('PODCAST_CHUNK_SIZE');
  const env = loadCodeGs({
    UrlFetchApp: makeUrlFetchApp(makeHandler(CHUNK * 2, { uploadFailsMidway: true }))
  });

  assert.throws(() => env.downloadAndUploadNextChunk(newJob()), /上傳到 Drive/);
});

test('分段大小必須是 256KiB 的整數倍(Drive 分段上傳對非最後一段的硬性規定)', () => {
  const CHUNK = loadCodeGs().evaluate('PODCAST_CHUNK_SIZE');

  assert.strictEqual(CHUNK % (256 * 1024), 0);
});
