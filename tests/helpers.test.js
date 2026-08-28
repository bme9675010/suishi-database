/**
 * Code.gs 裡幾個小工具函式的測試。這些函式本身單純,但都卡在關鍵路徑上
 * (解析 Podcast 網址、判斷檔案類型、統一課程大小寫),壞了會很難察覺。
 */
const test = require('node:test');
const assert = require('node:assert');
const { loadCodeGs, makeProps } = require('./helpers/apps-script-env');

const env = loadCodeGs();

test('extractApplePodcastCollectionId:從 Apple Podcasts 集數網址取出節目 id', () => {
  assert.strictEqual(
    env.extractApplePodcastCollectionId('https://podcasts.apple.com/tw/podcast/xxx/id1590806478?i=1000777686701'),
    '1590806478'
  );
});

test('extractApplePodcastCollectionId:不是 Apple Podcasts 網址時回傳 null', () => {
  assert.strictEqual(env.extractApplePodcastCollectionId('https://open.spotify.com/episode/abc'), null);
  assert.strictEqual(env.extractApplePodcastCollectionId(''), null);
});

test('decodeHtmlEntities:還原標題裡的 HTML 實體', () => {
  assert.strictEqual(
    env.decodeHtmlEntities('EP1 &quot;重點&quot; &amp; 補充 &lt;上&gt; &#39;完結&#39;'),
    'EP1 "重點" & 補充 <上> \'完結\''
  );
});

test('extractFileId:從 Drive 連結取出檔案 id', () => {
  assert.strictEqual(
    env.extractFileId('https://drive.google.com/file/d/1AbC-dEf_23/view?usp=drivesdk'),
    '1AbC-dEf_23'
  );
  assert.strictEqual(env.extractFileId('https://example.com/no-id-here'), null);
  assert.strictEqual(env.extractFileId(''), null);
});

test('inferTypeFolderName:用 MIME 判斷索引表的類型欄', () => {
  assert.strictEqual(env.inferTypeFolderName('image/jpeg'), '照片');
  assert.strictEqual(env.inferTypeFolderName('audio/mp4'), '錄音');
  assert.strictEqual(env.inferTypeFolderName('video/quicktime'), '錄音'); // 影片也歸在錄音
  assert.strictEqual(env.inferTypeFolderName('application/pdf'), '文件');
  assert.strictEqual(env.inferTypeFolderName(''), '文件');
});

test('normalizeTag:大小寫不同時,改用課程清單裡登記的那個版本', () => {
  // 避免同一門課因為打字大小寫不一致,被拆成兩個不同資料夾
  const props = makeProps({ COURSES: JSON.stringify(['未分類', 'Python爬蟲課']) });

  assert.strictEqual(env.normalizeTag('python爬蟲課', props), 'Python爬蟲課');
  assert.strictEqual(env.normalizeTag('PYTHON爬蟲課', props), 'Python爬蟲課');
});

test('normalizeTag:清單裡沒有的標籤原樣保留(新課程要能自動建立)', () => {
  const props = makeProps({ COURSES: JSON.stringify(['未分類']) });

  assert.strictEqual(env.normalizeTag('全新的課', props), '全新的課');
});

test('getCourseCategory:沒登記分類的課程回傳空字串(代表未分類)', () => {
  const props = makeProps({ COURSE_CATEGORIES: JSON.stringify({ 兆華與股惑仔: '投資' }) });

  assert.strictEqual(env.getCourseCategory('兆華與股惑仔', props), '投資');
  assert.strictEqual(env.getCourseCategory('沒分類的課', props), '');
});

test('getCourseCategory:COURSE_CATEGORIES 屬性還不存在時不會爆掉', () => {
  assert.strictEqual(env.getCourseCategory('任何課', makeProps({})), '');
});
