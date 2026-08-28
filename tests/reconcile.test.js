/**
 * 對帳(reconcileIndex)的回歸測試 —— 這是同步的骨幹:
 * 直接在 Drive 增刪檔案後,靠它把索引表對回實際內容。
 *
 * 它同時是全樹掃描、耗時最長的一段,未來檔案量大到逼近 Apps Script 6 分鐘上限時,
 * 勢必要改成分批處理。先把「對帳該有的行為」用測試釘住,之後真的要改架構時,
 * 才有辦法確認改完行為沒跑掉。
 */
const test = require('node:test');
const assert = require('node:assert');
const { loadCodeGs, makeFolder, makeFile, makeProps, makeSheet } = require('./helpers/apps-script-env');

const INBOX_ID = 'inbox-id';

/** 組出「課程/年/月/類型/檔案」這種實際的歸檔結構 */
function courseFolder(name, typeName, files) {
  return makeFolder({
    name: name,
    folders: [
      makeFolder({
        name: '2026',
        folders: [makeFolder({ name: '07', folders: [makeFolder({ name: typeName, files: files })] })]
      })
    ]
  });
}

function indexRow(fileId, tag, filename) {
  return [
    new Date('2026-07-20T10:00:00Z'), '照片', tag, filename,
    'https://drive.google.com/file/d/' + fileId + '/view', 'PWA', ''
  ];
}

/**
 * rootFolders:根目錄底下的資料夾(收件夾會自動補上)
 * rows:索引表現有的資料列
 * driveFiles:讓 DriveApp.getFileById 查得到的檔案(用來判斷索引表某列是否已失效)
 */
function setup(rootFolders, rows, driveFiles) {
  const root = makeFolder({
    name: '隨時資料庫',
    folders: [makeFolder({ id: INBOX_ID, name: '_收件夾' })].concat(rootFolders)
  });
  const sheet = makeSheet(rows);
  const byId = {};
  (driveFiles || []).forEach(function (f) { byId[f.getId()] = f; });

  const props = makeProps({
    ROOT_FOLDER_ID: 'root-id',
    INBOX_FOLDER_ID: INBOX_ID,
    SHEET_ID: 'sheet-id',
    COURSES: JSON.stringify(['未分類']),
    PENDING_CLEANUP: '[]'
  });

  const env = loadCodeGs({
    PropertiesService: { getScriptProperties: () => props },
    LockService: { getScriptLock: () => ({ waitLock: () => true, releaseLock: () => {} }) },
    DriveApp: {
      getFolderById: () => root,
      getFileById: (id) => {
        if (!byId[id]) throw new Error('檔案不存在:' + id);
        return byId[id];
      }
    },
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet }) }
  });

  return { env: env, sheet: sheet, props: props };
}

test('Drive 有、索引表沒登記的檔案會被補登', () => {
  const file = makeFile({ id: 'file-new', name: '照片_20260720_1000_A課.jpg' });
  const ctx = setup([courseFolder('A課', '照片', [file])], [], [file]);

  const result = ctx.env.reconcileIndex();

  assert.strictEqual(result.added, 1);
  assert.strictEqual(result.removed, 0);
  assert.strictEqual(ctx.sheet._rows.length, 1);
  assert.strictEqual(ctx.sheet._rows[0][2], 'A課', '課程標籤要對');
  assert.strictEqual(ctx.sheet._rows[0][5], '對帳補登', '來源要標成對帳補登');
});

test('索引表有、但 Drive 檔案已刪除的列會被清掉', () => {
  // 檔案不在 driveFiles 裡 → getFileById 會丟例外 → 視為已刪除
  const ctx = setup([courseFolder('A課', '照片', [])], [indexRow('file-gone', 'A課', '舊照片.jpg')], []);

  const result = ctx.env.reconcileIndex();

  assert.strictEqual(result.removed, 1);
  assert.strictEqual(ctx.sheet._rows.length, 0);
});

test('檔案被丟進垃圾桶(還沒永久刪除)也算失效,要清掉', () => {
  const trashed = makeFile({ id: 'file-trashed', name: '照片.jpg', trashed: true });
  const ctx = setup([courseFolder('A課', '照片', [])], [indexRow('file-trashed', 'A課', '照片.jpg')], [trashed]);

  assert.strictEqual(ctx.env.reconcileIndex().removed, 1);
});

test('已經對齊時不會亂動索引表', () => {
  const file = makeFile({ id: 'file-1', name: '照片.jpg' });
  const ctx = setup([courseFolder('A課', '照片', [file])], [indexRow('file-1', 'A課', '照片.jpg')], [file]);

  const result = ctx.env.reconcileIndex();

  assert.strictEqual(result.added, 0);
  assert.strictEqual(result.removed, 0);
  assert.strictEqual(ctx.sheet._rows.length, 1);
});

test('分類資料夾底下的課程檔案一樣會被掃到(不會因為多一層就漏掉)', () => {
  // 這正是加入課程分類時踩到的那類 bug:掃描邏輯只認根目錄正下方的課程
  const file = makeFile({ id: 'file-in-category', name: '照片.jpg' });
  const ctx = setup(
    [makeFolder({ name: '家庭', folders: [courseFolder('日本親子遊2026', '照片', [file])] })],
    [],
    [file]
  );

  const result = ctx.env.reconcileIndex();

  assert.strictEqual(result.added, 1);
  assert.strictEqual(ctx.sheet._rows[0][2], '日本親子遊2026');
});

test('分類資料夾本身不會被當成一門課程登記進去', () => {
  const file = makeFile({ id: 'f1', name: '照片.jpg' });
  const ctx = setup(
    [makeFolder({ name: '投資', folders: [courseFolder('兆華與股惑仔', '照片', [file])] })],
    [],
    [file]
  );

  ctx.env.reconcileIndex();

  const courses = JSON.parse(ctx.props.getProperty('COURSES'));
  assert.ok(courses.indexOf('兆華與股惑仔') !== -1, '真正的課程要被登記');
  assert.strictEqual(courses.indexOf('投資'), -1, '分類名稱不該混進課程清單');
});

test('補登時會依檔案所在的類型資料夾判斷類型,不是硬猜 MIME', () => {
  // 筆記是 Google 文件,單看 MIME 猜不出是筆記;但它躺在「筆記」資料夾底下就該算筆記
  const note = makeFile({ id: 'note-1', name: '筆記_20260720_A課', mimeType: 'application/vnd.google-apps.document' });
  const ctx = setup([courseFolder('A課', '筆記', [note])], [], [note]);

  ctx.env.reconcileIndex();

  assert.strictEqual(ctx.sheet._rows[0][1], '筆記');
});

test('回傳耗時(ms),讓前端可以顯示、及早看出愈跑愈久的趨勢', () => {
  const ctx = setup([courseFolder('A課', '照片', [])], [], []);

  const result = ctx.env.reconcileIndex();

  assert.strictEqual(typeof result.ms, 'number');
  assert.ok(result.ms >= 0);
});

test('搶不到鎖時回傳 null,不會硬跑(避免兩個對帳同時改索引表)', () => {
  const ctx = setup([courseFolder('A課', '照片', [])], [], []);
  const env = loadCodeGs({
    PropertiesService: { getScriptProperties: () => ctx.props },
    LockService: {
      getScriptLock: () => ({
        waitLock: () => { throw new Error('timeout'); },
        releaseLock: () => {}
      })
    }
  });

  assert.strictEqual(env.reconcileIndex(), null);
});
