/**
 * 隨時資料庫 — 後端 (Google Apps Script)
 *
 * 部署與初次設定步驟請見 docs/SETUP.md。
 * 這個檔案不需要你懂 Apps Script,只要照 SETUP.md 的步驟複製貼上、執行 setup() 一次即可。
 */

// ============ 初次設定 ============

/**
 * 只需執行一次。會自動建立:
 *   - Drive 根資料夾「隨時資料庫」
 *   - 收件夾「_收件夾」(手機錄音要存進這裡)
 *   - 索引 Google Sheet
 *   - 隨機通行金鑰 (PASS_KEY)
 * 執行完後看「執行紀錄」(Ctrl+Enter 或選單「檢視 > 記錄」) 複製結果。
 */
function setup() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('ROOT_FOLDER_ID')) {
    Logger.log('已經設定過了,略過。若要重設,先到「專案設定 > 指令碼屬性」把既有屬性刪掉再重跑。');
    return;
  }

  const root = DriveApp.createFolder('隨時資料庫');
  const inbox = root.createFolder('_收件夾');
  const ss = SpreadsheetApp.create('隨時資料庫_索引');
  const sheet = ss.getActiveSheet();
  sheet.setName('索引');
  sheet.appendRow(['時間', '類型', '課程標籤', '檔名', 'Drive連結', '來源', '備註']);
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, 7);
  DriveApp.getFileById(ss.getId()).moveTo(root);

  const passKey = Utilities.getUuid();

  props.setProperties({
    ROOT_FOLDER_ID: root.getId(),
    INBOX_FOLDER_ID: inbox.getId(),
    SHEET_ID: ss.getId(),
    PASS_KEY: passKey,
    COURSES: JSON.stringify(['未分類'])
  });

  Logger.log('====== 設定完成 ======');
  Logger.log('根資料夾: ' + root.getUrl());
  Logger.log('索引表: ' + ss.getUrl());
  Logger.log('收件夾 ID (捷徑會用到): ' + inbox.getId());
  Logger.log('PASS_KEY (PWA 和捷徑都要用這組,請妥善保存): ' + passKey);
  Logger.log('=======================');
  Logger.log('接下來:');
  Logger.log('1. 執行 installTriggers() 安裝自動掃描收件夾的排程');
  Logger.log('2. 用 setCourses([...]) 設定你的課程清單');
  Logger.log('3. 部署 > 新增部署作業 > 網頁應用程式,依 SETUP.md 設定權限');
}

/**
 * 安裝「每 5 分鐘掃描一次收件夾」的排程。只需執行一次(重跑會先清掉舊的再裝新的,不會重複)。
 */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'scanInbox') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('scanInbox').timeBased().everyMinutes(5).create();
  Logger.log('已安裝排程:每 5 分鐘自動掃描收件夾一次。');
}

/**
 * 安裝「每天自動清理一次索引表失效紀錄」的排程。只需執行一次(重跑會先清掉舊的再裝新的,不會重複)。
 */
function installCleanupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'cleanupDeadIndexRows') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('cleanupDeadIndexRows').timeBased().everyDays(1).atHour(3).create();
  Logger.log('已安裝排程:每天凌晨 3 點自動清理一次索引表失效紀錄。');
}

/**
 * 設定/更新課程標籤清單。之後想增減課程,改這裡重跑就好,
 * PWA 跟 iOS 捷徑(若用動態版本)都會抓到最新清單。
 * 範例: setCourses(['未分類', 'RAG課', 'Agent課', 'LLM微調課'])
 */
function setCourses(list) {
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('請傳入非空陣列,例如 setCourses(["未分類","RAG課"])');
  }
  PropertiesService.getScriptProperties().setProperty('COURSES', JSON.stringify(list));
  Logger.log('課程清單已更新: ' + list.join('、'));
}

/**
 * 一次性補登記工具:把 Drive「隨時資料庫」底下現有的課程資料夾(排除 _收件夾),
 * 補進課程清單。用在:改用「錄音自動同步課程標籤」這個功能之前就已經手動建立、
 * 但清單裡沒登記的舊課程資料夾。重複執行是安全的,已經登記過的不會重複加入。
 */
function syncCoursesFromFolders() {
  const props = PropertiesService.getScriptProperties();
  const root = DriveApp.getFolderById(props.getProperty('ROOT_FOLDER_ID'));
  const inboxId = props.getProperty('INBOX_FOLDER_ID');

  const courses = JSON.parse(props.getProperty('COURSES') || '["未分類"]');
  const lowerSet = {};
  courses.forEach(function (c) { lowerSet[c.toLowerCase()] = true; });

  const added = [];
  const it = root.getFolders();
  while (it.hasNext()) {
    const folder = it.next();
    if (folder.getId() === inboxId) continue;
    const name = folder.getName();
    if (!lowerSet[name.toLowerCase()]) {
      courses.push(name);
      lowerSet[name.toLowerCase()] = true;
      added.push(name);
    }
  }

  if (added.length > 0) {
    props.setProperty('COURSES', JSON.stringify(courses));
  }
  Logger.log('同步完成,新增了 ' + added.length + ' 個課程: ' + (added.join('、') || '(無)'));
}

/**
 * 清理工具:掃描索引表,把 Drive 連結已經失效(檔案被刪除或移到垃圾桶)的列自動刪除。
 * 只會刪除索引表裡的「列」,不會動到 Drive 裡任何實際檔案。可以重複執行,執行完看執行紀錄。
 * 執行 installCleanupTrigger() 一次可以裝上每天自動跑一次的排程,之後也能隨時手動再跑。
 */
function cleanupDeadIndexRows() {
  const props = PropertiesService.getScriptProperties();
  const sheet = SpreadsheetApp.openById(props.getProperty('SHEET_ID')).getSheetByName('索引');
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    Logger.log('索引表沒有資料列,不用清理。');
    return;
  }

  const urls = sheet.getRange(2, 5, lastRow - 1, 1).getValues(); // E欄 = Drive連結
  const rowsToDelete = [];

  for (let i = 0; i < urls.length; i++) {
    const id = extractFileId(urls[i][0]);
    if (!id) continue; // 抓不到 ID 的列不動它,保守處理

    let dead = false;
    try {
      dead = DriveApp.getFileById(id).isTrashed();
    } catch (err) {
      dead = true; // 找不到檔案,視為已刪除
    }

    if (dead) rowsToDelete.push(i + 2); // +2: 資料從第 2 列開始、陣列從 0 起算
  }

  rowsToDelete.sort(function (a, b) { return b - a; }); // 由下往上刪,避免刪除後列號跑掉
  rowsToDelete.forEach(function (row) { sheet.deleteRow(row); });

  Logger.log('清理完成:刪除了 ' + rowsToDelete.length + ' 列失效紀錄。');
}

function extractFileId(url) {
  if (!url) return null;
  const m = String(url).match(/\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// ============ Web API ============

/**
 * GET 端點:
 *   ?action=courses&passKey=xxx  → 回傳課程標籤清單 (PWA 開啟時抓取,需帶金鑰)
 *   (無參數)                     → 健康檢查,瀏覽器打開網址確認服務正常
 */
function doGet(e) {
  const action = e.parameter.action;
  const props = PropertiesService.getScriptProperties();

  if (action === 'courses') {
    if (e.parameter.passKey !== props.getProperty('PASS_KEY')) {
      return jsonResponse({ ok: false, error: 'unauthorized' });
    }
    const courses = JSON.parse(props.getProperty('COURSES') || '["未分類"]');
    return jsonResponse({ ok: true, courses: courses });
  }

  return jsonResponse({ ok: true, message: '隨時資料庫 API 運作中' });
}

/**
 * POST 端點:
 *   action: 'addCourse'    → PWA 新增課程用。Body: { passKey, action, courseName }
 *   action: 'removeCourse' → PWA 刪除課程用。Body: { passKey, action, courseName }
 *   (無 action)            → PWA 拍照上傳用。Body: { passKey, filename, mimeType, base64Data, tag }
 */
function doPost(e) {
  const props = PropertiesService.getScriptProperties();

  try {
    const body = JSON.parse(e.postData.contents);

    if (body.passKey !== props.getProperty('PASS_KEY')) {
      return jsonResponse({ ok: false, error: 'unauthorized' });
    }

    if (body.action === 'addCourse') {
      return handleAddCourse(body, props);
    }
    if (body.action === 'removeCourse') {
      return handleRemoveCourse(body, props);
    }

    if (!body.base64Data || !body.filename) {
      return jsonResponse({ ok: false, error: 'missing base64Data or filename' });
    }

    const bytes = Utilities.base64Decode(body.base64Data);
    const blob = Utilities.newBlob(bytes, body.mimeType || 'application/octet-stream', body.filename);

    const result = fileIntoLibrary(blob, 'photo', body.tag || '未分類', 'PWA');
    return jsonResponse({ ok: true, url: result.url, name: result.name });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) });
  }
}

function handleAddCourse(body, props) {
  const name = String(body.courseName || '').trim().replace(/[\\\/:*?"<>|]/g, '');
  if (!name) {
    return jsonResponse({ ok: false, error: 'empty course name' });
  }

  const courses = JSON.parse(props.getProperty('COURSES') || '["未分類"]');
  const exists = courses.some(function (c) { return c.toLowerCase() === name.toLowerCase(); });
  if (!exists) {
    courses.push(name);
    props.setProperty('COURSES', JSON.stringify(courses));
  }
  return jsonResponse({ ok: true, courses: courses });
}

function handleRemoveCourse(body, props) {
  const name = String(body.courseName || '').trim();
  const courses = JSON.parse(props.getProperty('COURSES') || '["未分類"]');
  const idx = courses.indexOf(name);
  if (idx === -1) {
    return jsonResponse({ ok: false, error: 'course not found' });
  }

  courses.splice(idx, 1);
  props.setProperty('COURSES', JSON.stringify(courses));
  return jsonResponse({ ok: true, courses: courses });
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ============ 收件夾自動掃描 (錄音走這條路) ============

/**
 * 由排程每 5 分鐘呼叫一次。掃描收件夾,把每個檔案歸檔到
 * 隨時資料庫/課程/年/月/類型/ 底下,並寫入索引表,最後把收件夾裡的原檔丟到垃圾桶。
 *
 * 檔名慣例(手動存進 Drive 時用):
 *   直接把檔名打成課程名稱就好,例如「python網路爬蟲.m4a」→ 課程標籤就是「python網路爬蟲」
 *   (舊的 REC__<課程標籤>__<任意文字> 格式也還支援,優先判斷)
 * 完全沒改檔名(保留原始語音備忘錄檔名)的話,標籤會直接用那個原始檔名,不會出錯,
 * 只是之後不好分類,建議還是花兩秒改一下檔名。
 */
function scanInbox() {
  const props = PropertiesService.getScriptProperties();
  const inbox = DriveApp.getFolderById(props.getProperty('INBOX_FOLDER_ID'));
  const files = inbox.getFiles();

  while (files.hasNext()) {
    const file = files.next();
    try {
      processInboxFile(file, props);
    } catch (err) {
      Logger.log('處理失敗: ' + file.getName() + ' - ' + err);
    }
  }
}

function processInboxFile(file, props) {
  const name = file.getName();

  let tag = '未分類';
  const m = name.match(/^REC__(.+?)__/);
  if (m) {
    tag = m[1];
  } else {
    const base = name.indexOf('.') >= 0 ? name.substring(0, name.lastIndexOf('.')) : name;
    if (base.trim()) tag = base.trim();
  }
  tag = normalizeTag(tag, props);

  const mime = file.getMimeType();
  let type = 'doc';
  if (mime.indexOf('image/') === 0) type = 'photo';
  else if (mime.indexOf('audio/') === 0 || mime.indexOf('video/') === 0) type = 'audio';

  const blob = file.getBlob();
  fileIntoLibrary(blob, type, tag, '手機同步');

  file.setTrashed(true);
}

/**
 * 如果 tag 忽略大小寫後跟課程清單裡某個名稱相同,改用清單裡登記的那個大小寫版本,
 * 避免同一門課因為打字時大小寫不一致,被拆成兩個不同資料夾(例如 Python爬蟲課 vs python爬蟲課)。
 */
function normalizeTag(tag, props) {
  const courses = JSON.parse(props.getProperty('COURSES') || '["未分類"]');
  const lower = tag.toLowerCase();
  for (let i = 0; i < courses.length; i++) {
    if (courses[i].toLowerCase() === lower) return courses[i];
  }
  return tag;
}

// ============ 共用歸檔邏輯 ============

const TYPE_FOLDER_NAME = { photo: '照片', audio: '錄音', doc: '文件' };

/**
 * 如果這個標籤(忽略大小寫)還沒登記在課程清單裡,自動加進去。
 * 讓「錄音手動打新課程名稱 → 自動建資料夾」跟「App 課程清單」保持同步,
 * 不會出現 Drive 已經有資料夾、但 App 選單看不到的情況。
 */
function registerCourseIfNew(tag, props) {
  const courses = JSON.parse(props.getProperty('COURSES') || '["未分類"]');
  const exists = courses.some(function (c) { return c.toLowerCase() === tag.toLowerCase(); });
  if (!exists) {
    courses.push(tag);
    props.setProperty('COURSES', JSON.stringify(courses));
  }
}

/**
 * 把一個 blob 歸檔到 隨時資料庫/課程/年/月/類型/,改成統一命名規則,並寫入索引表一列。
 */
function fileIntoLibrary(blob, type, tag, source) {
  const props = PropertiesService.getScriptProperties();
  const root = DriveApp.getFolderById(props.getProperty('ROOT_FOLDER_ID'));
  const now = new Date();

  const yyyy = Utilities.formatDate(now, 'Asia/Taipei', 'yyyy');
  const mm = Utilities.formatDate(now, 'Asia/Taipei', 'MM');
  const typeFolderName = TYPE_FOLDER_NAME[type] || '其他';
  const safeTag = String(tag || '未分類').replace(/[\\\/:*?"<>|]/g, '');
  registerCourseIfNew(safeTag, props);

  const courseFolder = getOrCreateFolder(root, safeTag);
  const yearFolder = getOrCreateFolder(courseFolder, yyyy);
  const monthFolder = getOrCreateFolder(yearFolder, mm);
  const typeFolder = getOrCreateFolder(monthFolder, typeFolderName);

  const stamp = Utilities.formatDate(now, 'Asia/Taipei', 'yyyyMMdd_HHmm');
  const originalName = blob.getName() || '';
  const ext = originalName.indexOf('.') >= 0 ? originalName.split('.').pop() : '';
  const newName = typeFolderName + '_' + stamp + '_' + safeTag + (ext ? '.' + ext : '');
  blob.setName(newName);

  const file = typeFolder.createFile(blob);

  const sheet = SpreadsheetApp.openById(props.getProperty('SHEET_ID')).getSheetByName('索引');
  sheet.appendRow([now, typeFolderName, safeTag, newName, file.getUrl(), source, '']);

  return { url: file.getUrl(), name: newName };
}

function getOrCreateFolder(parent, name) {
  const it = parent.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return parent.createFolder(name);
}

// ============ 一次性搬移工具(舊結構 年/月/類型 → 新結構 課程/年/月/類型) ============

/**
 * 只需執行一次。掃描舊的「隨時資料庫/年/月/類型/檔案」結構,
 * 從檔名解析出課程標籤,搬到新的「隨時資料庫/課程/年/月/類型/檔案」結構,
 * 最後把搬空的舊資料夾清掉。執行完看「執行紀錄」確認搬移數量。
 * 重複執行是安全的(已經搬過的檔案不會再被找到,不會重複處理)。
 */
function migrateToCourseFolders() {
  const props = PropertiesService.getScriptProperties();
  const root = DriveApp.getFolderById(props.getProperty('ROOT_FOLDER_ID'));
  const inboxId = props.getProperty('INBOX_FOLDER_ID');
  const nameRe = /^.+?_\d{8}_\d{4}_(.+)\.[A-Za-z0-9]+$/;

  let moved = 0;

  const yearFolders = root.getFolders();
  while (yearFolders.hasNext()) {
    const yearFolder = yearFolders.next();
    if (!/^\d{4}$/.test(yearFolder.getName())) continue; // 只處理年份資料夾(4位數字),避免誤動到課程資料夾

    const monthFolders = yearFolder.getFolders();
    while (monthFolders.hasNext()) {
      const monthFolder = monthFolders.next();
      const typeFolders = monthFolder.getFolders();
      while (typeFolders.hasNext()) {
        const typeFolder = typeFolders.next();
        const files = typeFolder.getFiles();
        while (files.hasNext()) {
          const file = files.next();
          const m = file.getName().match(nameRe);
          const tag = m ? m[1] : '未分類';

          const courseFolder = getOrCreateFolder(root, tag);
          const newYearFolder = getOrCreateFolder(courseFolder, yearFolder.getName());
          const newMonthFolder = getOrCreateFolder(newYearFolder, monthFolder.getName());
          const newTypeFolder = getOrCreateFolder(newMonthFolder, typeFolder.getName());

          file.moveTo(newTypeFolder);
          moved++;
        }
      }
    }
  }

  cleanupEmptyFolders(root, inboxId);
  Logger.log('搬移完成:共搬移 ' + moved + ' 個檔案,舊的空資料夾已清除。');
}

function cleanupEmptyFolders(folder, protectedId) {
  const subfolders = [];
  const it = folder.getFolders();
  while (it.hasNext()) subfolders.push(it.next());

  subfolders.forEach(function (sub) {
    if (sub.getId() === protectedId) return;
    cleanupEmptyFolders(sub, protectedId);
    if (!sub.getFiles().hasNext() && !sub.getFolders().hasNext()) {
      sub.setTrashed(true);
    }
  });
}
