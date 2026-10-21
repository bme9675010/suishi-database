/**
 * 課程分類設定的回歸測試。
 *
 * 這是整個專案唯一會「實際搬動 Drive 資料夾」的操作,出錯的代價最高:
 * 搬錯地方、或在目的地製造出兩個同名資料夾,檔案就會被拆到兩邊,而且很難察覺。
 */
const test = require('node:test');
const assert = require('node:assert');
const { loadCodeGs, makeFolder, makeProps } = require('./helpers/apps-script-env');

function body(result) {
  return JSON.parse(result._text);
}

function setup(rootFolders, courses, categories) {
  const root = makeFolder({ name: '隨時資料庫', folders: rootFolders || [] });
  const props = makeProps({
    ROOT_FOLDER_ID: 'root-id',
    COURSES: JSON.stringify(courses || ['未分類', 'Python課']),
    COURSE_CATEGORIES: JSON.stringify(categories || {})
  });
  const env = loadCodeGs({
    PropertiesService: { getScriptProperties: () => props },
    DriveApp: { getFolderById: () => root }
  });
  return { env, root, props, categories: () => JSON.parse(props.getProperty('COURSE_CATEGORIES')) };
}

test('指定分類:資料夾搬到分類底下,設定也跟著更新', () => {
  const course = makeFolder({ id: 'course-1', name: 'Python課' });
  const ctx = setup([course]);

  const res = body(ctx.env.handleSetCourseCategory({ courseName: 'Python課', category: '學習' }, ctx.props));

  assert.strictEqual(res.ok, true);
  assert.strictEqual(ctx.categories()['Python課'], '學習');
  assert.strictEqual(course._spec.movedTo.getName(), '學習');
});

test('取消分類:搬回根目錄,設定也移除', () => {
  const learn = makeFolder({ id: 'cat-1', name: '學習', folders: [makeFolder({ id: 'course-1', name: 'Python課' })] });
  const ctx = setup([learn], ['未分類', 'Python課'], { 'Python課': '學習' });

  const res = body(ctx.env.handleSetCourseCategory({ courseName: 'Python課', category: '' }, ctx.props));

  assert.strictEqual(res.ok, true);
  assert.strictEqual(ctx.categories()['Python課'], undefined, '設定要被移除,不是留著空字串');
  assert.strictEqual(learn._folders[0]._spec.movedTo.getName(), '隨時資料庫');
});

test('還沒建立過 Drive 資料夾的課程:只更新設定,不會報錯', () => {
  const ctx = setup([]);

  const res = body(ctx.env.handleSetCourseCategory({ courseName: 'Python課', category: '工作' }, ctx.props));

  assert.strictEqual(res.ok, true);
  assert.strictEqual(ctx.categories()['Python課'], '工作');
});

test('不支援的分類會被擋下來', () => {
  const ctx = setup([makeFolder({ id: 'c1', name: 'Python課' })]);

  const res = body(ctx.env.handleSetCourseCategory({ courseName: 'Python課', category: '亂打的分類' }, ctx.props));

  assert.strictEqual(res.ok, false);
  assert.match(res.error, /不支援的分類/);
  assert.deepStrictEqual(ctx.categories(), {}, '被擋下來時不該留下任何設定');
});

test('課程清單裡沒有的課程會被擋下來', () => {
  const ctx = setup([]);

  const res = body(ctx.env.handleSetCourseCategory({ courseName: '不存在的課', category: '學習' }, ctx.props));

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'course not found');
});

test('目的地已有同名資料夾時要擋下來,不能搬過去製造出兩個同名資料夾', () => {
  // 搬過去的話,之後 getFoldersByName 取到哪一個並不確定,檔案會被默默拆到兩邊,
  // 而且幾乎不可能自己發現。寧可直接失敗,讓使用者先去 Drive 處理。
  const course = makeFolder({ id: 'course-1', name: 'Python課' });
  const clash = makeFolder({ id: 'course-dup', name: 'Python課' }); // 目的地已經有一個同名的
  const learn = makeFolder({ id: 'cat-1', name: '學習', folders: [clash] });
  const ctx = setup([course, learn]);

  const res = body(ctx.env.handleSetCourseCategory({ courseName: 'Python課', category: '學習' }, ctx.props));

  assert.strictEqual(res.ok, false);
  assert.match(res.error, /已經有一個叫/);
  assert.strictEqual(course._spec.movedTo, undefined, '被擋下來時不該真的搬動');
  assert.deepStrictEqual(ctx.categories(), {}, '被擋下來時不該更新設定');
});

test('分類沒有變動時不會多做任何搬移', () => {
  const learn = makeFolder({ id: 'cat-1', name: '學習', folders: [makeFolder({ id: 'course-1', name: 'Python課' })] });
  const ctx = setup([learn], ['未分類', 'Python課'], { 'Python課': '學習' });

  const res = body(ctx.env.handleSetCourseCategory({ courseName: 'Python課', category: '學習' }, ctx.props));

  assert.strictEqual(res.ok, true);
  assert.strictEqual(learn._folders[0]._spec.movedTo, undefined);
});

test('課程名稱大小寫不同也認得出來,並沿用清單登記的版本', () => {
  const course = makeFolder({ id: 'course-1', name: 'Python課' });
  const ctx = setup([course]);

  const res = body(ctx.env.handleSetCourseCategory({ courseName: 'python課', category: '投資' }, ctx.props));

  assert.strictEqual(res.ok, true);
  assert.strictEqual(ctx.categories()['Python課'], '投資', '要用清單裡的大小寫版本當 key');
});
