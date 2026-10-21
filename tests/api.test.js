/**
 * Web API(doGet)與 Podcast 背景工作狀態機的回歸測試。
 *
 * 這兩塊的共通點:壞掉的時候不會有明顯徵兆 —— doGet 丟例外會被前端一律顯示成「離線中」,
 * 背景工作卡住則是畫面永遠停在「下載中」、或在背後無限重排觸發器默默燒配額。
 */
const test = require('node:test');
const assert = require('node:assert');
const { loadCodeGs, makeProps, makeSheet, makeFile } = require('./helpers/apps-script-env');

const PASS_KEY = 'secret-key';

/** jsonResponse 回傳的是 ContentService 物件,替身把內容放在 _text */
function body(result) {
  return JSON.parse(result._text);
}

function makeScriptApp() {
  const created = [];
  return {
    created: created,
    getOAuthToken: function () { return 'fake-token'; },
    newTrigger: function (fn) {
      return {
        timeBased: function () {
          return {
            after: function (ms) {
              return { create: function () { created.push({ fn: fn, ms: ms }); } };
            }
          };
        }
      };
    }
  };
}

// ---------------- doGet ----------------

test('doGet:底層丟例外時回傳 JSON 錯誤,而不是讓 Apps Script 吐 HTML 錯誤頁', () => {
  // 以前沒有這層保護:例外 → HTML 錯誤頁 → 前端 r.json() 爆掉 → 一律顯示「離線中」,
  // 真正的原因完全看不到。
  const props = makeProps({ PASS_KEY: PASS_KEY, SHEET_ID: 'sheet-id' });
  const env = loadCodeGs({
    PropertiesService: { getScriptProperties: () => props },
    SpreadsheetApp: {
      openById: () => { throw new Error('索引表被刪掉了'); }
    }
  });

  const res = body(env.doGet({ parameter: { action: 'listFiles', course: 'A課', passKey: PASS_KEY } }));

  assert.strictEqual(res.ok, false);
  assert.match(res.error, /索引表被刪掉了/);
});

test('doGet:金鑰不對時回傳 unauthorized', () => {
  const props = makeProps({ PASS_KEY: PASS_KEY });
  const env = loadCodeGs({ PropertiesService: { getScriptProperties: () => props } });

  const res = body(env.doGet({ parameter: { action: 'courses', passKey: '猜錯的金鑰' } }));

  assert.deepStrictEqual([res.ok, res.error], [false, 'unauthorized']);
});

test('doGet:沒有參數時回傳健康檢查訊息(瀏覽器直接開網址的情境)', () => {
  const props = makeProps({ PASS_KEY: PASS_KEY });
  const env = loadCodeGs({ PropertiesService: { getScriptProperties: () => props } });

  assert.strictEqual(body(env.doGet({ parameter: {} })).ok, true);
});

test('doGet:連 e 本身都沒有時也不會爆掉(在編輯器裡手動執行的情境)', () => {
  const props = makeProps({ PASS_KEY: PASS_KEY });
  const env = loadCodeGs({ PropertiesService: { getScriptProperties: () => props } });

  assert.strictEqual(body(env.doGet()).ok, true);
});

test('doGet:searchFiles 正常走完,結果帶課程標籤', () => {
  const rows = [[
    new Date('2026-07-20T10:00:00Z'), 'Podcast', '兆華與股惑仔', 'EP1143.mp3',
    'https://drive.google.com/file/d/ep1143/view', 'Podcast', '兆華開盤前瞻 EP1143'
  ]];
  const props = makeProps({ PASS_KEY: PASS_KEY, SHEET_ID: 'sheet-id' });
  const env = loadCodeGs({
    PropertiesService: { getScriptProperties: () => props },
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => makeSheet(rows) }) }
  });

  const res = body(env.doGet({ parameter: { action: 'searchFiles', q: '開盤前瞻', passKey: PASS_KEY } }));

  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.files.length, 1);
  assert.strictEqual(res.files[0].tag, '兆華與股惑仔');
});

test('doGet:podcastJobStatus 要回傳 updatedAt,前端才分得出「還在跑」和「早就死了」', () => {
  const job = {
    status: 'downloading', tag: 'A課', episodeTitle: 'EP1',
    offset: 100, totalSize: 1000, error: null, resultUrl: null, resultName: null,
    startedAt: '2026-07-20T10:00:00.000Z', updatedAt: '2026-07-20T10:05:00.000Z'
  };
  const props = makeProps({ PASS_KEY: PASS_KEY, PODCAST_JOB: JSON.stringify(job) });
  const env = loadCodeGs({ PropertiesService: { getScriptProperties: () => props } });

  const res = body(env.doGet({ parameter: { action: 'podcastJobStatus', passKey: PASS_KEY } }));

  assert.strictEqual(res.job.updatedAt, '2026-07-20T10:05:00.000Z');
});

// ---------------- processPodcastJob 狀態機 ----------------

function podcastEnv(job, opts) {
  opts = opts || {};
  const props = makeProps({ PODCAST_JOB: JSON.stringify(job), SHEET_ID: 'sheet-id' });
  const scriptApp = makeScriptApp();
  const sheet = makeSheet([]);
  const env = loadCodeGs({
    PropertiesService: { getScriptProperties: () => props },
    ScriptApp: scriptApp,
    LockService: {
      getScriptLock: () => ({
        waitLock: () => {
          if (opts.lockBusy) throw new Error('lock timeout');
          return true;
        },
        releaseLock: () => {}
      })
    },
    DriveApp: { getFileById: () => makeFile({ id: 'drive-file-id', name: 'EP1.mp3' }) },
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet }) }
  });
  return { env: env, props: props, scriptApp: scriptApp, sheet: sheet,
           job: () => JSON.parse(props.getProperty('PODCAST_JOB')) };
}

const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();

test('卡在收尾階段超過安全上限時要中止,不能無限重排觸發器', () => {
  // 先前只有下載階段有 3 小時保護,收尾階段沒有:搶不到鎖就每 5 秒排一個觸發器,
  // 永遠不會停,而且完全沒有徵兆,只會默默燒配額。
  const ctx = podcastEnv(
    { status: 'finalizing', startedAt: hoursAgo(4), updatedAt: hoursAgo(4), driveFileId: 'drive-file-id' },
    { lockBusy: true }
  );

  ctx.env.processPodcastJob();

  assert.strictEqual(ctx.job().status, 'error');
  assert.match(ctx.job().error, /安全上限/);
  assert.strictEqual(ctx.scriptApp.created.length, 0, '中止後不該再排觸發器');
});

test('下載階段超過安全上限一樣要中止', () => {
  const ctx = podcastEnv({ status: 'downloading', startedAt: hoursAgo(4), updatedAt: hoursAgo(4) });

  ctx.env.processPodcastJob();

  assert.strictEqual(ctx.job().status, 'error');
  assert.strictEqual(ctx.scriptApp.created.length, 0);
});

test('已經完成的工作即使很久以前,也不該被改成失敗', () => {
  const ctx = podcastEnv({ status: 'done', startedAt: hoursAgo(99), updatedAt: hoursAgo(99) });

  ctx.env.processPodcastJob();

  assert.strictEqual(ctx.job().status, 'done');
});

test('收尾階段還在安全時間內:成功寫入索引表並標記完成', () => {
  const ctx = podcastEnv({
    status: 'finalizing', startedAt: hoursAgo(0.2), updatedAt: hoursAgo(0.2),
    driveFileId: 'drive-file-id', tag: 'A課', fileName: 'EP1.mp3', episodeTitle: 'EP1 完整標題'
  });

  ctx.env.processPodcastJob();

  assert.strictEqual(ctx.job().status, 'done');
  assert.strictEqual(ctx.sheet._rows.length, 1);
  assert.strictEqual(ctx.sheet._rows[0][6], 'EP1 完整標題', '備註欄要存集數標題');
});

test('收尾階段搶不到鎖、但還在安全時間內:排觸發器稍後重試,不放棄', () => {
  const ctx = podcastEnv(
    { status: 'finalizing', startedAt: hoursAgo(0.2), updatedAt: hoursAgo(0.2), driveFileId: 'drive-file-id' },
    { lockBusy: true }
  );

  ctx.env.processPodcastJob();

  assert.strictEqual(ctx.job().status, 'finalizing');
  assert.strictEqual(ctx.scriptApp.created.length, 1);
  assert.strictEqual(ctx.scriptApp.created[0].fn, 'processPodcastJob');
});
