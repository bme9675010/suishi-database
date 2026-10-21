/**
 * 歸檔主幹的回歸測試:每一張照片、每一個錄音都會走到這裡。
 *
 * 其中最關鍵的是「收件夾歸檔必須是搬移、不是複製」:以前是把整個檔案讀成 blob 再建一份新的、
 * 原檔丟垃圾桶,等於同一份內容在 Drive 佔兩倍空間(垃圾桶預設還要 30 天才清),
 * 整堂課的錄音動輒 60~150MB,也很接近 Apps Script 對 blob 的大小上限。
 */
const test = require('node:test');
const assert = require('node:assert');
const { loadCodeGs, makeFolder, makeFile, makeProps, makeSheet } = require('./helpers/apps-script-env');

const INBOX_ID = 'inbox-id';

function setup() {
  const inbox = makeFolder({ id: INBOX_ID, name: '_收件夾' });
  const root = makeFolder({ name: '隨時資料庫', folders: [inbox] });
  const sheet = makeSheet([]);
  const props = makeProps({
    ROOT_FOLDER_ID: 'root-id',
    INBOX_FOLDER_ID: INBOX_ID,
    SHEET_ID: 'sheet-id',
    COURSES: JSON.stringify(['未分類']),
    PENDING_CLEANUP: '[]'
  });
  const env = loadCodeGs({
    PropertiesService: { getScriptProperties: () => props },
    DriveApp: { getFolderById: () => root },
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet }) }
  });
  return { env: env, root: root, inbox: inbox, sheet: sheet, props: props };
}

/** 沿著 課程/年/月/類型 找出歸檔後的資料夾 */
function archiveFolder(root, course, typeName) {
  const course_ = root._folders.find((f) => f.getName() === course);
  if (!course_) return null;
  const year = course_._folders[0];
  const month = year && year._folders[0];
  return month ? month._folders.find((f) => f.getName() === typeName) : null;
}

test('fileIntoLibrary:PWA 直傳的內容會建成新檔案,放進 課程/年/月/類型 底下', () => {
  const ctx = setup();
  const blob = { _name: 'photo_1.jpg', getName: function () { return this._name; }, setName: function (n) { this._name = n; } };

  const result = ctx.env.fileIntoLibrary(blob, 'photo', 'Python課', 'PWA');

  const folder = archiveFolder(ctx.root, 'Python課', '照片');
  assert.ok(folder, '應該建出 Python課/年/月/照片 的資料夾結構');
  assert.strictEqual(folder._files.length, 1);
  assert.match(result.name, /^照片_\d{8}_\d{4}_Python課\.jpg$/, '檔名要套用統一命名規則並保留副檔名');
});

test('fileIntoLibrary:同時寫入索引表一列', () => {
  const ctx = setup();
  const blob = { _name: 'a.jpg', getName: function () { return this._name; }, setName: function (n) { this._name = n; } };

  ctx.env.fileIntoLibrary(blob, 'photo', 'Python課', 'PWA', '備註內容');

  assert.strictEqual(ctx.sheet._rows.length, 1);
  const row = ctx.sheet._rows[0];
  assert.strictEqual(row[1], '照片');
  assert.strictEqual(row[2], 'Python課');
  assert.strictEqual(row[5], 'PWA');
  assert.strictEqual(row[6], '備註內容');
});

test('moveFileIntoLibrary:是搬移,不是「讀成 blob 複製一份再丟垃圾桶」', () => {
  const ctx = setup();
  const file = makeFile({ id: 'rec-1', name: 'Python課.m4a' });

  const result = ctx.env.moveFileIntoLibrary(file, 'audio', 'Python課', '手機同步');

  const folder = archiveFolder(ctx.root, 'Python課', '錄音');
  assert.strictEqual(file._spec.movedTo, folder, '檔案要被搬進錄音資料夾');
  assert.strictEqual(file._spec.blobRead, undefined, '不該把整個檔案讀成 blob(大檔案會爆記憶體)');
  assert.strictEqual(file._spec.trashed, undefined, '原檔不該被丟垃圾桶(那是複製做法的殘留)');
  assert.strictEqual(folder._files.length, 0, '不該在目的地另外建一份複本');
  assert.match(result.name, /^錄音_\d{8}_\d{4}_Python課\.m4a$/);
});

test('moveFileIntoLibrary:檔名改成統一格式,並寫進索引表', () => {
  const ctx = setup();
  const file = makeFile({ id: 'rec-2', name: '原始名稱.m4a' });

  ctx.env.moveFileIntoLibrary(file, 'audio', 'A課', '手機同步');

  assert.match(file.getName(), /^錄音_\d{8}_\d{4}_A課\.m4a$/);
  assert.strictEqual(ctx.sheet._rows.length, 1);
  assert.strictEqual(ctx.sheet._rows[0][5], '手機同步');
});

test('processInboxFile:檔名就是課程名稱的情況', () => {
  const ctx = setup();
  const file = makeFile({ id: 'f1', name: 'python網路爬蟲.m4a', mimeType: 'audio/mp4' });

  ctx.env.processInboxFile(file, ctx.props);

  assert.ok(archiveFolder(ctx.root, 'python網路爬蟲', '錄音'), '課程標籤要取自檔名');
  assert.strictEqual(ctx.sheet._rows[0][1], '錄音', '音檔要歸到錄音類型');
  // 關鍵:收件夾這條路必須走搬移。只驗「有歸檔」的話,改回舊的複製做法也會通過,
  // 等於測試沒有保護到真正重要的那件事。
  assert.ok(file._spec.movedTo, '應該直接搬移檔案');
  assert.strictEqual(file._spec.blobRead, undefined, '不該把整個檔案讀成 blob');
  assert.strictEqual(file._spec.trashed, undefined, '不該複製後把原檔丟垃圾桶');
  assert.strictEqual(archiveFolder(ctx.root, 'python網路爬蟲', '錄音')._files.length, 0, '不該建立複本');
});

test('processInboxFile:REC__課程__任意文字 格式只取中間那段當課程', () => {
  const ctx = setup();
  const file = makeFile({ id: 'f2', name: 'REC__python網路爬蟲__上半場.m4a', mimeType: 'audio/mp4' });

  ctx.env.processInboxFile(file, ctx.props);

  assert.ok(archiveFolder(ctx.root, 'python網路爬蟲', '錄音'));
  assert.strictEqual(ctx.sheet._rows[0][2], 'python網路爬蟲');
});

test('processInboxFile:依 MIME 判斷類型,圖片歸照片、PDF 歸文件', () => {
  const ctx = setup();

  ctx.env.processInboxFile(makeFile({ id: 'f3', name: 'A課.jpg', mimeType: 'image/jpeg' }), ctx.props);
  ctx.env.processInboxFile(makeFile({ id: 'f4', name: 'B課.pdf', mimeType: 'application/pdf' }), ctx.props);

  assert.ok(archiveFolder(ctx.root, 'A課', '照片'));
  assert.ok(archiveFolder(ctx.root, 'B課', '文件'));
});

test('processInboxFile:課程名稱大小寫會對齊課程清單,不會拆成兩個資料夾', () => {
  const ctx = setup();
  ctx.props.setProperty('COURSES', JSON.stringify(['未分類', 'Python爬蟲課']));

  ctx.env.processInboxFile(makeFile({ id: 'f5', name: 'python爬蟲課.m4a', mimeType: 'audio/mp4' }), ctx.props);

  assert.ok(archiveFolder(ctx.root, 'Python爬蟲課', '錄音'), '要用清單裡登記的大小寫版本');
  assert.strictEqual(archiveFolder(ctx.root, 'python爬蟲課', '錄音'), null);
});

test('歸檔會把新課程自動補進課程清單', () => {
  const ctx = setup();

  ctx.env.processInboxFile(makeFile({ id: 'f6', name: '全新的課.m4a', mimeType: 'audio/mp4' }), ctx.props);

  assert.ok(JSON.parse(ctx.props.getProperty('COURSES')).indexOf('全新的課') !== -1);
});

// ---------------- scanInbox:走訪收件夾 ----------------

test('scanInbox:收件夾裡每個檔案都要被處理到,不會因為邊走訪邊搬而漏掉', () => {
  // 真實的 Drive 行為:檔案一旦被搬出收件夾,就不在該資料夾的清單裡了。
  // 「邊走訪邊搬」碰到這種情況會跳號 —— 處理完第 1 個,第 2 個就被跳過。
  // 所以必須先把清單整個收集起來再處理。
  const live = [];
  const inbox = {
    getId: function () { return INBOX_ID; },
    getName: function () { return '_收件夾'; },
    isTrashed: function () { return false; },
    getFiles: function () {
      let i = 0;
      return {
        hasNext: function () { return i < live.length; },
        next: function () { return live[i++]; }
      };
    }
  };

  function inboxFile(id, name) {
    const spec = { id: id, name: name, mimeType: 'audio/mp4' };
    const file = {
      getId: function () { return spec.id; },
      getName: function () { return spec.name; },
      getUrl: function () { return 'https://drive.google.com/file/d/' + spec.id + '/view'; },
      getMimeType: function () { return spec.mimeType; },
      getSize: function () { return 2048; },
      getDateCreated: function () { return new Date('2026-07-20T10:00:00Z'); },
      isTrashed: function () { return false; },
      setName: function (n) { spec.name = n; return file; },
      setTrashed: function () { return file; },
      moveTo: function () {
        const idx = live.indexOf(file); // 搬走之後就不在收件夾清單裡了
        if (idx >= 0) live.splice(idx, 1);
        return file;
      },
      _spec: spec
    };
    return file;
  }

  live.push(inboxFile('f1', 'A課.m4a'), inboxFile('f2', 'B課.m4a'), inboxFile('f3', 'C課.m4a'));

  const root = makeFolder({ name: '隨時資料庫', folders: [inbox] });
  const sheet = makeSheet([]);
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
    DriveApp: { getFolderById: (id) => (id === INBOX_ID ? inbox : root) },
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet }) }
  });

  env.scanInbox();

  assert.strictEqual(sheet._rows.length, 3, '三個檔案都該被歸檔,一個都不能漏');
  assert.deepStrictEqual(sheet._rows.map((r) => r[2]).sort(), ['A課', 'B課', 'C課']);
  assert.strictEqual(live.length, 0, '處理完收件夾應該是空的');
});

// ---------------- 重送偵測(避免同一份檔案被歸檔兩次)----------------

test('重送偵測:記錄過的識別碼會被認出來', () => {
  const ctx = setup();

  assert.strictEqual(ctx.env.wasUploadProcessed('cid-1', ctx.props), false);
  ctx.env.rememberUploadProcessed('cid-1', ctx.props);
  assert.strictEqual(ctx.env.wasUploadProcessed('cid-1', ctx.props), true);
  assert.strictEqual(ctx.env.wasUploadProcessed('cid-2', ctx.props), false);
});

test('重送偵測:沒有帶識別碼時一律視為沒處理過(相容舊版手機端)', () => {
  const ctx = setup();

  ctx.env.rememberUploadProcessed(undefined, ctx.props);
  assert.strictEqual(ctx.env.wasUploadProcessed(undefined, ctx.props), false);
});

test('重送偵測:只保留最近 100 筆,不會無限長大撐爆屬性大小上限', () => {
  const ctx = setup();

  for (let i = 0; i < 150; i++) ctx.env.rememberUploadProcessed('cid-' + i, ctx.props);

  const ids = JSON.parse(ctx.props.getProperty('PROCESSED_UPLOADS'));
  assert.strictEqual(ids.length, 100);
  assert.strictEqual(ctx.env.wasUploadProcessed('cid-149', ctx.props), true, '最近的要留著');
  assert.strictEqual(ctx.env.wasUploadProcessed('cid-0', ctx.props), false, '最舊的會被擠掉');
});
