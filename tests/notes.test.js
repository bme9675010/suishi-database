/**
 * 課堂筆記存檔的回歸測試。
 *
 * 這條路的特別之處:同一天、同一課程要更新「同一份」Google 文件,而不是每次存檔都生出
 * 一個新檔案;而且格式(章節層級、粗斜體、螢光筆、字色)是在後端重建的,寫錯了使用者
 * 要打開 Google 文件才會發現。
 */
const test = require('node:test');
const assert = require('node:assert');
const { loadCodeGs, makeFolder, makeFile, makeProps, makeSheet, makeDocument } = require('./helpers/apps-script-env');

function setup() {
  const root = makeFolder({ name: '隨時資料庫' });
  const sheet = makeSheet([]);
  const props = makeProps({
    ROOT_FOLDER_ID: 'root-id',
    SHEET_ID: 'sheet-id',
    COURSES: JSON.stringify(['未分類']),
    PENDING_CLEANUP: '[]'
  });

  const docs = {};
  const docNames = {};   // 真實世界裡 DocumentApp.create(name) 建出來的檔案,檔名就是 name
  const created = [];
  const opened = [];
  const driveRoot = makeFolder({ name: 'My Drive' });

  const env = loadCodeGs({
    PropertiesService: { getScriptProperties: () => props },
    DriveApp: {
      getFolderById: () => root,
      getRootFolder: () => driveRoot,
      getFileById: (id) => makeFile({ id: id, name: docNames[id] || id })
    },
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet }) },
    DocumentApp: {
      ParagraphHeading: { HEADING1: 'H1', HEADING2: 'H2', HEADING3: 'H3' },
      create: function (name) {
        created.push(name);
        const doc = makeDocument('doc-' + name);
        docs[doc.getId()] = doc;
        docNames[doc.getId()] = name;
        return doc;
      },
      openById: function (id) {
        opened.push(id);
        return docs[id] || makeDocument(id);
      }
    }
  });

  return { env, root, sheet, props, created, opened, docs };
}

const para = (text) => ({ type: 'paragraph', runs: [{ text: text }] });

/** 找出 課程/年/月/筆記 資料夾 */
function noteFolder(root, course) {
  const c = root._folders.find((f) => f.getName() === course);
  const y = c && c._folders[0];
  const m = y && y._folders[0];
  return m ? m._folders.find((f) => f.getName() === '筆記') : null;
}

test('saveNote:第一次存檔會建立 Google 文件,放進 課程/年/月/筆記,並寫索引表', () => {
  const ctx = setup();

  const result = ctx.env.saveNote('Python課', [para('今天的重點')], ctx.props);

  assert.strictEqual(ctx.created.length, 1, '應該建立一份新文件');
  assert.match(result.name, /^筆記_\d{8}_Python課$/);
  assert.ok(noteFolder(ctx.root, 'Python課'), '應該建出筆記資料夾');
  assert.strictEqual(ctx.sheet._rows.length, 1);
  assert.strictEqual(ctx.sheet._rows[0][1], '筆記');
});

test('saveNote:同一天同一課程再存一次,是更新同一份文件,不會變成兩個檔案', () => {
  const ctx = setup();

  ctx.env.saveNote('Python課', [para('第一次')], ctx.props);
  ctx.env.saveNote('Python課', [para('第二次,補充了內容')], ctx.props);

  assert.strictEqual(ctx.created.length, 1, '第二次不該再建新文件');
  assert.strictEqual(ctx.opened.length, 1, '第二次應該是打開既有文件');
  assert.strictEqual(ctx.sheet._rows.length, 1, '索引表不該多一列');
  assert.strictEqual(noteFolder(ctx.root, 'Python課')._files.length, 1);
});

test('saveNote:不同課程各自獨立,不會互相覆蓋', () => {
  const ctx = setup();

  ctx.env.saveNote('A課', [para('A 的筆記')], ctx.props);
  ctx.env.saveNote('B課', [para('B 的筆記')], ctx.props);

  assert.strictEqual(ctx.created.length, 2);
  assert.strictEqual(ctx.sheet._rows.length, 2);
});

test('saveNote:內容會真的寫進文件', () => {
  const ctx = setup();

  ctx.env.saveNote('Python課', [para('今天的重點')], ctx.props);

  const doc = ctx.docs[Object.keys(ctx.docs)[0]];
  assert.strictEqual(doc.dump()[0].text, '今天的重點');
});

// ---------------- writeNoteBlocks 的格式重建 ----------------

test('writeNoteBlocks:三種章節層級對應 Google 文件的標題 1/2/3', () => {
  const ctx = setup();
  const doc = makeDocument('d');

  ctx.env.writeNoteBlocks(doc, [
    { type: 'heading', level: 1, text: '大章' },
    { type: 'heading', level: 2, text: '節' },
    { type: 'heading', level: 3, text: '小節' }
  ]);

  assert.deepStrictEqual(doc.dump().map((p) => [p.heading, p.text]), [
    ['H1', '大章'], ['H2', '節'], ['H3', '小節']
  ]);
});

test('writeNoteBlocks:同一段裡多個 run 會依序接起來', () => {
  const ctx = setup();
  const doc = makeDocument('d');

  ctx.env.writeNoteBlocks(doc, [{
    type: 'paragraph',
    runs: [{ text: '一般文字' }, { text: '重點', bold: true }, { text: '結尾' }]
  }]);

  assert.strictEqual(doc.dump()[0].text, '一般文字重點結尾');
});

test('writeNoteBlocks:粗體/斜體/螢光筆/字色都套在正確的位置', () => {
  const ctx = setup();
  const doc = makeDocument('d');

  ctx.env.writeNoteBlocks(doc, [{
    type: 'paragraph',
    runs: [
      { text: '前面四字' },                                        // offset 0-3
      { text: '重點', bold: true, highlightColor: '#fde047' },     // offset 4-5
      { text: '警告', textColor: '#dc2626', italic: true }         // offset 6-7
    ]
  }]);

  const ops = doc.dump()[0].ops;
  assert.deepStrictEqual(ops, [
    ['bg', 4, 5, '#fde047'],
    ['bold', 4, 5, true],
    ['fg', 6, 7, '#dc2626'],
    ['italic', 6, 7, true]
  ]);
});

test('writeNoteBlocks:開頭不會多一行空白段落', () => {
  // body.clear() 會留下一個空段落,內容都是後來 append 上去的,那個空段落要被清掉
  const ctx = setup();
  const doc = makeDocument('d');

  ctx.env.writeNoteBlocks(doc, [para('唯一一段')]);

  assert.strictEqual(doc.dump().length, 1);
  assert.strictEqual(doc.dump()[0].text, '唯一一段');
});

test('writeNoteBlocks:重寫時會先清空,不會把舊內容留著疊加', () => {
  const ctx = setup();
  const doc = makeDocument('d');

  ctx.env.writeNoteBlocks(doc, [para('舊內容'), para('舊內容2')]);
  ctx.env.writeNoteBlocks(doc, [para('新內容')]);

  assert.deepStrictEqual(doc.dump().map((p) => p.text), ['新內容']);
});
