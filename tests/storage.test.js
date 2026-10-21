/**
 * 空間統計與清理的回歸測試。
 *
 * 設計上最關鍵的一點:清理後「音檔刪掉、紀錄留著」—— 做法是把索引表的 Drive連結 清空。
 * 對帳只追蹤連結解析得出檔案 ID 的列,所以這些列不會被當成失效紀錄刪掉。
 * 這個互動一旦壞掉,使用者清理完之後紀錄會在下次對帳時整列消失,連標題跟來源連結都沒了。
 */
const test = require('node:test');
const assert = require('node:assert');
const { loadCodeGs, makeFolder, makeFile, makeProps, makeSheet, makeUrlFetchApp, toHost } = require('./helpers/apps-script-env');

/** 索引表 9 欄:時間,類型,課程標籤,檔名,Drive連結,來源,備註,大小,來源連結 */
function row(opts) {
  return [
    opts.time || new Date('2026-07-20T10:00:00Z'),
    opts.type || 'Podcast',
    opts.tag || 'A課',
    opts.filename || 'file.mp3',
    opts.cleaned ? '' : ('https://drive.google.com/file/d/' + (opts.id || 'f1') + '/view'),
    opts.source || 'Podcast',
    opts.note || '',
    opts.size === undefined ? 1000 : opts.size,
    opts.sourceUrl || ''
  ];
}

function envWith(rows, extra) {
  const sheet = makeSheet(rows);
  const props = makeProps({ SHEET_ID: 'sheet-id', PASS_KEY: 'k' });
  const env = loadCodeGs(Object.assign({
    PropertiesService: { getScriptProperties: () => props },
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet }) }
  }, extra || {}));
  return { env, sheet, props };
}

// ---------------- 空間統計 ----------------

test('getLibraryUsage:依類型加總,已清理的列不計入', () => {
  const ctx = envWith([
    row({ id: 'a', type: 'Podcast', size: 100 }),
    row({ id: 'b', type: 'Podcast', size: 200 }),
    row({ id: 'c', type: '照片', size: 50 }),
    row({ id: 'd', type: 'Podcast', size: 999, cleaned: true }) // 已清理,檔案已經不在了
  ]);

  const usage = toHost(ctx.env.getLibraryUsage(ctx.props));

  assert.strictEqual(usage.byType['Podcast'], 300);
  assert.strictEqual(usage.byType['照片'], 50);
  assert.strictEqual(usage.total, 350);
  assert.strictEqual(usage.cleanedCount, 1);
});

test('getLibraryUsage:統計還沒有大小資料的列數,好誠實告訴使用者數字偏低', () => {
  const ctx = envWith([
    row({ id: 'a', size: 100 }),
    row({ id: 'b', size: '' }), // 舊資料,還沒被對帳回填
    row({ id: 'c', size: '' })
  ]);

  assert.strictEqual(toHost(ctx.env.getLibraryUsage(ctx.props)).unknownCount, 2);
});

test('getLibraryUsage:索引表是空的也不會爆', () => {
  const ctx = envWith([]);

  assert.deepStrictEqual(toHost(ctx.env.getLibraryUsage(ctx.props)).total, 0);
});

test('getDriveQuota:解析 Drive 回傳的容量,並帶出垃圾桶佔用', () => {
  const ctx = envWith([], {
    UrlFetchApp: makeUrlFetchApp(() => ({
      code: 200,
      text: JSON.stringify({ storageQuota: {
        limit: '16106127360', usage: '11000000000', usageInDrive: '9000000000', usageInDriveTrash: '1400000000'
      } })
    }))
  });

  const q = toHost(ctx.env.getDriveQuota());

  assert.strictEqual(q.limit, 16106127360);
  assert.strictEqual(q.usage, 11000000000);
  assert.strictEqual(q.trash, 1400000000, '垃圾桶佔用要能看到,否則使用者會以為刪了就釋放了');
});

test('getDriveQuota:沒有容量上限的帳號回傳 0,不會變成 NaN', () => {
  const ctx = envWith([], {
    UrlFetchApp: makeUrlFetchApp(() => ({ code: 200, text: JSON.stringify({ storageQuota: { usage: '123' } }) }))
  });

  assert.strictEqual(toHost(ctx.env.getDriveQuota()).limit, 0);
});

test('getDriveQuota:查詢失敗要丟出明確錯誤', () => {
  const ctx = envWith([], { UrlFetchApp: makeUrlFetchApp(() => ({ code: 403, text: '' })) });

  assert.throws(() => ctx.env.getDriveQuota(), /讀取 Drive 空間失敗/);
});

// ---------------- 清理清單 ----------------

test('listCleanupCandidates:只列指定類型,依檔案大小由大到小', () => {
  const ctx = envWith([
    row({ id: 'small', type: 'Podcast', size: 100, filename: '小.mp3' }),
    row({ id: 'big', type: 'Podcast', size: 900, filename: '大.mp3' }),
    row({ id: 'photo', type: '照片', size: 500, filename: '照片.jpg' })
  ]);

  const list = toHost(ctx.env.listCleanupCandidates('Podcast', ctx.props));

  assert.deepStrictEqual(list.map((f) => f.filename), ['大.mp3', '小.mp3']);
});

test('listCleanupCandidates:已清理的不會再出現', () => {
  const ctx = envWith([
    row({ id: 'a', size: 100 }),
    row({ id: 'b', size: 900, cleaned: true })
  ]);

  assert.strictEqual(toHost(ctx.env.listCleanupCandidates('Podcast', ctx.props)).length, 1);
});

test('listCleanupCandidates:帶出來源連結,清掉之後還能找回原本那一集', () => {
  const ctx = envWith([row({ id: 'a', sourceUrl: 'https://podcasts.apple.com/tw/podcast/x/id1?i=2' })]);

  assert.strictEqual(
    toHost(ctx.env.listCleanupCandidates('Podcast', ctx.props))[0].sourceUrl,
    'https://podcasts.apple.com/tw/podcast/x/id1?i=2'
  );
});

// ---------------- 執行清理 ----------------

function cleanupEnv(rows, files) {
  const byId = {};
  (files || []).forEach(function (f) { byId[f.getId()] = f; });
  const sheet = makeSheet(rows);
  const props = makeProps({ SHEET_ID: 'sheet-id' });
  const env = loadCodeGs({
    PropertiesService: { getScriptProperties: () => props },
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet }) },
    DriveApp: {
      getFileById: (id) => {
        if (!byId[id]) throw new Error('找不到檔案 ' + id);
        return byId[id];
      }
    }
  });
  return { env, sheet, props };
}

test('cleanupFiles:檔案丟垃圾桶,並回報釋放了多少空間', () => {
  const f = makeFile({ id: 'a', name: 'ep.mp3', size: 1500 });
  const ctx = cleanupEnv([row({ id: 'a', size: 1500 })], [f]);

  const r = toHost(ctx.env.cleanupFiles(['a'], ctx.props));

  assert.strictEqual(f._spec.trashed, true);
  assert.strictEqual(r.deleted, 1);
  assert.strictEqual(r.freedBytes, 1500);
});

test('cleanupFiles:只清空 Drive連結,其他欄位全部保留', () => {
  const f = makeFile({ id: 'a', name: 'ep.mp3', size: 1500 });
  const ctx = cleanupEnv(
    [row({ id: 'a', tag: '兆華與股惑仔', note: 'EP1143 完整標題', sourceUrl: 'https://apple/x', size: 1500 })],
    [f]
  );

  ctx.env.cleanupFiles(['a'], ctx.props);

  const kept = ctx.sheet._rows[0];
  assert.strictEqual(kept[4], '', 'Drive連結要被清空,代表檔案已經不在了');
  assert.strictEqual(kept[2], '兆華與股惑仔', '課程要留著');
  assert.strictEqual(kept[6], 'EP1143 完整標題', '集數標題要留著');
  assert.strictEqual(kept[8], 'https://apple/x', '來源連結要留著,才能重新封存');
});

test('cleanupFiles:檔案早就被手動刪掉也不會整批失敗', () => {
  const ctx = cleanupEnv([row({ id: 'gone' })], []); // Drive 裡找不到

  const r = toHost(ctx.env.cleanupFiles(['gone'], ctx.props));

  assert.strictEqual(r.failed, 1);
  assert.strictEqual(r.deleted, 0);
});

test('cleanupFiles:沒被選到的列不受影響', () => {
  const a = makeFile({ id: 'a', name: 'a.mp3', size: 100 });
  const b = makeFile({ id: 'b', name: 'b.mp3', size: 200 });
  const ctx = cleanupEnv([row({ id: 'a' }), row({ id: 'b' })], [a, b]);

  ctx.env.cleanupFiles(['a'], ctx.props);

  assert.strictEqual(ctx.sheet._rows[0][4], '');
  assert.match(ctx.sheet._rows[1][4], /\/d\/b\//);
  assert.strictEqual(b._spec.trashed, undefined);
});

// ---------------- 與對帳的互動(整個設計的關鍵)----------------

test('已清理的列不會被對帳當成失效紀錄刪掉', () => {
  // 清理後 Drive連結 是空的 → 對帳解析不出檔案 ID → 不會納入追蹤 → 不會被刪。
  // 這個性質一旦被破壞,使用者清理完之後紀錄會整列消失,標題跟來源連結都救不回來。
  const sheet = makeSheet([row({ id: 'x', cleaned: true, note: '要保留的集數標題', sourceUrl: 'https://apple/x' })]);
  const root = makeFolder({ name: '隨時資料庫', folders: [makeFolder({ id: 'inbox', name: '_收件夾' })] });
  const props = makeProps({
    ROOT_FOLDER_ID: 'root-id', INBOX_FOLDER_ID: 'inbox', SHEET_ID: 'sheet-id',
    COURSES: JSON.stringify(['未分類']), PENDING_CLEANUP: '[]'
  });
  const env = loadCodeGs({
    PropertiesService: { getScriptProperties: () => props },
    LockService: { getScriptLock: () => ({ waitLock: () => true, releaseLock: () => {} }) },
    DriveApp: { getFolderById: () => root, getFileById: () => { throw new Error('不該被查詢'); } },
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet }) }
  });

  const result = env.reconcileIndex();

  assert.strictEqual(result.removed, 0);
  assert.strictEqual(sheet._rows.length, 1, '已清理的紀錄要留著');
  assert.strictEqual(sheet._rows[0][6], '要保留的集數標題');
  assert.strictEqual(sheet._rows[0][8], 'https://apple/x');
});

test('對帳會把舊資料缺少的檔案大小回填進去', () => {
  const file = makeFile({ id: 'f1', name: '照片.jpg', size: 4242 });
  const sheet = makeSheet([row({ id: 'f1', type: '照片', size: '' })]); // 舊資料沒有大小
  const typeFolder = makeFolder({ name: '照片', files: [file] });
  const month = makeFolder({ name: '07', folders: [typeFolder] });
  const year = makeFolder({ name: '2026', folders: [month] });
  const root = makeFolder({
    name: '隨時資料庫',
    folders: [makeFolder({ id: 'inbox', name: '_收件夾' }), makeFolder({ name: 'A課', folders: [year] })]
  });
  const props = makeProps({
    ROOT_FOLDER_ID: 'root-id', INBOX_FOLDER_ID: 'inbox', SHEET_ID: 'sheet-id',
    COURSES: JSON.stringify(['未分類']), PENDING_CLEANUP: '[]'
  });
  const env = loadCodeGs({
    PropertiesService: { getScriptProperties: () => props },
    LockService: { getScriptLock: () => ({ waitLock: () => true, releaseLock: () => {} }) },
    DriveApp: { getFolderById: () => root, getFileById: () => file },
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet }) }
  });

  env.reconcileIndex();

  assert.strictEqual(sheet._rows[0][7], 4242, '大小要被回填');
});
