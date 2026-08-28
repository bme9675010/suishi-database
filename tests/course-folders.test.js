/**
 * 課程資料夾走訪 / 分類路徑的回歸測試。
 *
 * 為什麼特別測這一塊:加入「課程可以歸到分類資料夾底下」之後,原本假設
 * 「課程資料夾一定在根目錄正下方」的邏輯會壞掉,而且壞法是不會報錯、只會默默算錯
 * (分類資料夾被當成課程、分類過的課程被誤判成已刪除)。這種錯最需要測試守住。
 */
const test = require('node:test');
const assert = require('node:assert');
const { loadCodeGs, makeFolder, makeProps, toHost } = require('./helpers/apps-script-env');

const env = loadCodeGs();
// 用 Array.from 而不是 folders.map:回傳值來自 vm 沙箱,map 出來還是沙箱的陣列,
// 直接拿去 deepStrictEqual 會因為原型不同而失敗(見 helpers 裡 toHost 的說明)。
const names = (folders) => Array.from(folders, (f) => f.getName()).sort();

test('getCourseFoldersUnderRoot:把分類資料夾底下的課程攤平出來', () => {
  const root = makeFolder({
    name: '隨時資料庫',
    folders: [
      makeFolder({ id: 'inbox', name: '_收件夾' }),
      makeFolder({ name: 'Python機器學習課' }), // 未分類,直接掛在根目錄下
      makeFolder({ name: '學習', folders: [makeFolder({ name: 'Docker課' })] }),
      makeFolder({ name: '家庭', folders: [makeFolder({ name: '日本親子遊2026' })] })
    ]
  });

  const result = env.getCourseFoldersUnderRoot(root, 'inbox');

  assert.deepStrictEqual(names(result), ['Docker課', 'Python機器學習課', '日本親子遊2026'].sort());
});

test('getCourseFoldersUnderRoot:分類資料夾本身不會被誤判成課程', () => {
  const root = makeFolder({
    name: '隨時資料庫',
    folders: [makeFolder({ name: '投資', folders: [makeFolder({ name: '兆華與股惑仔' })] })]
  });

  const result = env.getCourseFoldersUnderRoot(root, 'inbox');

  assert.deepStrictEqual(names(result), ['兆華與股惑仔']);
});

test('getCourseFoldersUnderRoot:排除收件夾與垃圾桶裡的資料夾(含分類底下的)', () => {
  const root = makeFolder({
    name: '隨時資料庫',
    folders: [
      makeFolder({ id: 'inbox', name: '_收件夾' }),
      makeFolder({ name: '正常課程' }),
      makeFolder({ name: '已刪課程', trashed: true }),
      makeFolder({
        name: '工作',
        folders: [makeFolder({ name: '分類內正常' }), makeFolder({ name: '分類內已刪', trashed: true })]
      })
    ]
  });

  const result = env.getCourseFoldersUnderRoot(root, 'inbox');

  assert.deepStrictEqual(names(result), ['分類內正常', '正常課程'].sort());
});

test('getCourseFoldersUnderRoot:整個分類資料夾被丟垃圾桶時,底下課程一併不列入', () => {
  const root = makeFolder({
    name: '隨時資料庫',
    folders: [makeFolder({ name: '工作', trashed: true, folders: [makeFolder({ name: '應該被跳過' })] })]
  });

  assert.deepStrictEqual(names(env.getCourseFoldersUnderRoot(root, 'inbox')), []);
});

test('getCourseFoldersUnderRoot:課程名稱剛好等於分類保留字時會被誤判(已知限制,行為需與文件一致)', () => {
  // 這不是「正確」行為,而是文件(docs/SETUP.md)裡明講的已知限制:
  // 名稱撞到保留字的課程會被當成分類資料夾往下找。用測試把這個行為釘住,
  // 之後若有人改動掃描邏輯,至少會意識到自己動到了這個邊界。
  const root = makeFolder({
    name: '隨時資料庫',
    folders: [makeFolder({ name: '學習' })] // 這其實是一門叫「學習」的課程
  });

  assert.deepStrictEqual(names(env.getCourseFoldersUnderRoot(root, 'inbox')), []);
});

test('courseFolderExists:分類過的課程要到分類資料夾底下才找得到', () => {
  const props = makeProps({ COURSE_CATEGORIES: JSON.stringify({ 兆華與股惑仔: '投資' }) });
  const root = makeFolder({
    name: '隨時資料庫',
    folders: [makeFolder({ name: '投資', folders: [makeFolder({ name: '兆華與股惑仔' })] })]
  });

  assert.strictEqual(env.courseFolderExists(root, '兆華與股惑仔', props), true);
});

test('courseFolderExists:未分類的課程在根目錄下找得到', () => {
  const props = makeProps({ COURSE_CATEGORIES: '{}' });
  const root = makeFolder({ name: '隨時資料庫', folders: [makeFolder({ name: 'Python機器學習課' })] });

  assert.strictEqual(env.courseFolderExists(root, 'Python機器學習課', props), true);
});

test('courseFolderExists:資料夾在垃圾桶裡要算成不存在', () => {
  const props = makeProps({ COURSE_CATEGORIES: '{}' });
  const root = makeFolder({ name: '隨時資料庫', folders: [makeFolder({ name: '已刪課程', trashed: true })] });

  assert.strictEqual(env.courseFolderExists(root, '已刪課程', props), false);
});

test('courseFolderExists:分類資料夾根本還沒建立時不會爆掉,回傳 false', () => {
  const props = makeProps({ COURSE_CATEGORIES: JSON.stringify({ 某課程: '家庭' }) });
  const root = makeFolder({ name: '隨時資料庫', folders: [] });

  assert.strictEqual(env.courseFolderExists(root, '某課程', props), false);
});

test('CATEGORY_LIST 就是目前支援的四個分類', () => {
  assert.deepStrictEqual(toHost(env.evaluate('CATEGORY_LIST')), ['學習', '工作', '投資', '家庭']);
});
