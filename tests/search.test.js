/**
 * 跨課程全域搜尋(searchFilesAcrossCourses)的回歸測試。
 * 索引表每列格式:[時間, 類型, 課程標籤, 檔名, Drive連結, 來源, 備註]
 */
const test = require('node:test');
const assert = require('node:assert');
const { loadCodeGs, makeProps, makeSheet, toHost } = require('./helpers/apps-script-env');

function envWithRows(rows) {
  const sheet = makeSheet(rows);
  return loadCodeGs({
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet }) }
  });
}

const props = makeProps({ SHEET_ID: 'sheet-id' });

function row(time, type, tag, filename, note) {
  return [new Date(time), type, tag, filename, 'https://drive.example/d/' + filename, 'PWA', note || ''];
}

test('可以用檔名搜到', () => {
  const env = envWithRows([row('2026-07-20T10:00:00Z', '照片', 'Python機器學習課', 'photo_001.jpg')]);

  const results = toHost(env.searchFilesAcrossCourses('photo_001', props));

  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].filename, 'photo_001.jpg');
});

test('可以用備註(Podcast 集數標題)搜到', () => {
  const env = envWithRows([
    row('2026-07-20T10:00:00Z', 'Podcast', '兆華與股惑仔', 'EP1143.mp3', '兆華開盤前瞻 EP1143')
  ]);

  const results = toHost(env.searchFilesAcrossCourses('開盤前瞻', props));

  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].note, '兆華開盤前瞻 EP1143');
});

test('可以用課程標籤搜到,而且結果會帶上課程標籤(前端要靠它顯示是哪門課)', () => {
  const env = envWithRows([row('2026-07-20T10:00:00Z', '筆記', '日本親子遊2026', '筆記_20260720')]);

  const results = toHost(env.searchFilesAcrossCourses('日本親子', props));

  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].tag, '日本親子遊2026');
});

test('比對不分大小寫', () => {
  const env = envWithRows([row('2026-07-20T10:00:00Z', '文件', 'Docker課', 'Dockerfile-note.txt')]);

  assert.strictEqual(toHost(env.searchFilesAcrossCourses('dockerfile', props)).length, 1);
  assert.strictEqual(toHost(env.searchFilesAcrossCourses('DOCKERFILE', props)).length, 1);
});

test('空字串或只有空白的關鍵字一律回傳空陣列,不會變成「列出全部」', () => {
  const env = envWithRows([
    row('2026-07-20T10:00:00Z', '照片', 'A課', 'a.jpg'),
    row('2026-07-21T10:00:00Z', '照片', 'B課', 'b.jpg')
  ]);

  assert.deepStrictEqual(toHost(env.searchFilesAcrossCourses('', props)), []);
  assert.deepStrictEqual(toHost(env.searchFilesAcrossCourses('   ', props)), []);
});

test('沒有命中時回傳空陣列', () => {
  const env = envWithRows([row('2026-07-20T10:00:00Z', '照片', 'A課', 'a.jpg')]);

  assert.deepStrictEqual(toHost(env.searchFilesAcrossCourses('完全不存在的關鍵字', props)), []);
});

test('索引表只有標題列(沒有任何資料)時不會爆掉', () => {
  const env = envWithRows([]);

  assert.deepStrictEqual(toHost(env.searchFilesAcrossCourses('任何字', props)), []);
});

test('結果依時間新到舊排序', () => {
  const env = envWithRows([
    row('2026-07-10T10:00:00Z', '照片', '課', 'target-old.jpg'),
    row('2026-07-25T10:00:00Z', '照片', '課', 'target-new.jpg'),
    row('2026-07-18T10:00:00Z', '照片', '課', 'target-mid.jpg')
  ]);

  const results = toHost(env.searchFilesAcrossCourses('target', props));

  assert.deepStrictEqual(
    results.map((r) => r.filename),
    ['target-new.jpg', 'target-mid.jpg', 'target-old.jpg']
  );
});

test('命中太多時最多只回 100 筆,避免一次吐一大串', () => {
  const rows = [];
  for (let i = 0; i < 250; i++) {
    rows.push(row('2026-07-20T10:00:00Z', '照片', '課', 'target-' + i + '.jpg'));
  }
  const env = envWithRows(rows);

  assert.strictEqual(toHost(env.searchFilesAcrossCourses('target', props)).length, 100);
});
