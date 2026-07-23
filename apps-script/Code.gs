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
 * 安裝「每天凌晨 3 點自動對帳一次」的排程。只需執行一次(重跑會先清掉舊的再裝新的,不會重複)。
 * 對帳 = 補登直接放進 Drive 的檔案、清掉已刪除的列、同步課程清單、核銷待清理提醒(見 reconcileIndex)。
 * (舊版本這個排程只跑 cleanupDeadIndexRows,重跑本函式會自動把舊排程換成新的全套對帳。)
 */
function installCleanupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const fn = t.getHandlerFunction();
    if (fn === 'cleanupDeadIndexRows' || fn === 'reconcileIndex') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('reconcileIndex').timeBased().everyDays(1).atHour(3).create();
  Logger.log('已安裝排程:每天凌晨 3 點自動對帳一次(補登新檔、清掉已刪除的、同步課程清單)。');
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
  getCourseFoldersUnderRoot(root, inboxId).forEach(function (folder) {
    const name = folder.getName();
    if (!lowerSet[name.toLowerCase()]) {
      courses.push(name);
      lowerSet[name.toLowerCase()] = true;
      added.push(name);
    }
  });

  if (added.length > 0) {
    props.setProperty('COURSES', JSON.stringify(courses));
  }
  Logger.log('同步完成,新增了 ' + added.length + ' 個課程: ' + (added.join('、') || '(無)'));
}

/**
 * 清理工具:掃描索引表,把 Drive 連結已經失效(檔案被刪除或移到垃圾桶)的列自動刪除,
 * 順便檢查「待清理提醒」清單,資料夾如果已經真的被刪除就自動核銷提醒(不用手動按已清理)。
 * 只會刪除索引表裡的「列」,不會動到 Drive 裡任何實際檔案。可以重複執行,執行完看執行紀錄。
 * 執行 installCleanupTrigger() 一次可以裝上每天自動跑一次的排程,之後也能隨時手動再跑。
 */
function cleanupDeadIndexRows() {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (err) {
    Logger.log('cleanupDeadIndexRows 取得鎖定逾時,可能跟其他排程/請求撞期,略過這次,下次排程會再試。');
    return;
  }

  try {
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

    autoResolvePendingCleanup(props);
  } finally {
    lock.releaseLock();
  }
}

/**
 * 檢查「待清理提醒」清單裡的課程,如果 Drive 資料夾已經真的被刪除(不在了),
 * 自動把提醒拿掉,不用使用者手動按「已清理」。跟 cleanupDeadIndexRows 共用同一個每日排程。
 */
function autoResolvePendingCleanup(props) {
  const pending = JSON.parse(props.getProperty('PENDING_CLEANUP') || '[]');
  if (pending.length === 0) return;

  const root = DriveApp.getFolderById(props.getProperty('ROOT_FOLDER_ID'));
  const stillPending = pending.filter(function (p) {
    return courseFolderExists(root, p.name, props);
  });

  if (stillPending.length !== pending.length) {
    props.setProperty('PENDING_CLEANUP', JSON.stringify(stillPending));
    Logger.log('待清理提醒自動核銷 ' + (pending.length - stillPending.length) + ' 筆(資料夾已確認刪除)。');
  }
}

/**
 * 判斷 root 底下是否有名稱為 name、且「還沒被刪除」的資料夾。
 * 重要:Apps Script 的 getFoldersByName() 連丟進垃圾桶(還沒永久刪除)的資料夾也會回傳,
 * 所以一定要額外用 isTrashed() 過濾,否則「移到垃圾桶」會被誤判成資料夾還在。
 */
function activeFolderExists(root, name) {
  return findActiveFolder(root, name) !== null;
}

/**
 * 跟 activeFolderExists() 不同,這個會考慮課程目前有沒有被指定分類——分類過的課程資料夾
 * 不是直接在根目錄下,要先找到分類資料夾才找得到。待清理提醒(autoResolvePendingCleanup/
 * handleRemoveCourse)都要用這個,不能只查根目錄,不然分類過的課程會被誤判成資料夾已經刪除。
 */
function courseFolderExists(root, courseName, props) {
  const category = getCourseCategory(courseName, props);
  const parent = category ? findActiveFolder(root, category) : root;
  return parent ? findActiveFolder(parent, courseName) !== null : false;
}

/**
 * 跟 getOrCreateFolder() 不同,這個只找、不建立;找不到(或只找到垃圾桶裡的同名資料夾)回傳 null。
 */
function findActiveFolder(parent, name) {
  const it = parent.getFoldersByName(name);
  while (it.hasNext()) {
    const folder = it.next();
    if (!folder.isTrashed()) return folder;
  }
  return null;
}

function extractFileId(url) {
  if (!url) return null;
  const m = String(url).match(/\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// ============ Web API ============

/**
 * GET 端點:
 *   ?action=courses&passKey=xxx              → 回傳課程標籤清單 + 各課程的分類(PWA 開啟時抓取,需帶金鑰)
 *   ?action=pendingCleanup&passKey=xxx       → 回傳「已從清單刪除但 Drive 資料夾還在」的待清理提醒
 *   ?action=listFiles&course=X&passKey=xxx   → 回傳某課程底下所有照片/錄音/筆記清單
 *   ?action=searchFiles&q=關鍵字&passKey=xxx  → 跨課程搜尋檔名/備註/課程標籤,回傳結果帶課程標籤
 *   ?action=podcastJobStatus&passKey=xxx     → 回傳目前 Podcast 背景下載工作的進度(見 startPodcastJob())
 *   (無參數)                                 → 健康檢查,瀏覽器打開網址確認服務正常
 */
function doGet(e) {
  const action = e.parameter.action;
  const props = PropertiesService.getScriptProperties();

  if (action === 'courses') {
    if (e.parameter.passKey !== props.getProperty('PASS_KEY')) {
      return jsonResponse({ ok: false, error: 'unauthorized' });
    }
    const courses = JSON.parse(props.getProperty('COURSES') || '["未分類"]');
    const courseCategories = JSON.parse(props.getProperty('COURSE_CATEGORIES') || '{}');
    return jsonResponse({ ok: true, courses: courses, courseCategories: courseCategories });
  }

  if (action === 'pendingCleanup') {
    if (e.parameter.passKey !== props.getProperty('PASS_KEY')) {
      return jsonResponse({ ok: false, error: 'unauthorized' });
    }
    // 自我修復:App 每次抓提醒清單時,順手檢查一下資料夾是不是其實已經刪掉了(含丟進垃圾桶),
    // 是的話當場核銷,不用等每天凌晨 3 點的排程,體驗上等於「刪掉後重開 App 提醒就消失」。
    const lock = LockService.getScriptLock();
    if (lock.tryLock(5000)) {
      try {
        autoResolvePendingCleanup(props);
      } finally {
        lock.releaseLock();
      }
    }
    const pending = JSON.parse(props.getProperty('PENDING_CLEANUP') || '[]');
    return jsonResponse({ ok: true, pending: pending });
  }

  if (action === 'listFiles') {
    if (e.parameter.passKey !== props.getProperty('PASS_KEY')) {
      return jsonResponse({ ok: false, error: 'unauthorized' });
    }
    const files = getFilesForCourse(String(e.parameter.course || ''), props);
    return jsonResponse({ ok: true, files: files });
  }

  if (action === 'searchFiles') {
    if (e.parameter.passKey !== props.getProperty('PASS_KEY')) {
      return jsonResponse({ ok: false, error: 'unauthorized' });
    }
    const files = searchFilesAcrossCourses(String(e.parameter.q || ''), props);
    return jsonResponse({ ok: true, files: files });
  }

  if (action === 'podcastJobStatus') {
    if (e.parameter.passKey !== props.getProperty('PASS_KEY')) {
      return jsonResponse({ ok: false, error: 'unauthorized' });
    }
    const job = getPodcastJob(props);
    if (!job) return jsonResponse({ ok: true, job: null });
    return jsonResponse({
      ok: true,
      job: {
        status: job.status,
        tag: job.tag,
        episodeTitle: job.episodeTitle,
        offset: job.offset,
        totalSize: job.totalSize,
        error: job.error,
        resultUrl: job.resultUrl,
        resultName: job.resultName
      }
    });
  }

  return jsonResponse({ ok: true, message: '隨時資料庫 API 運作中' });
}

/**
 * 從索引表撈出某個課程標籤(忽略大小寫)底下的所有紀錄,依時間新到舊排序,最多回傳 200 筆。
 */
function getFilesForCourse(courseName, props) {
  const sheet = SpreadsheetApp.openById(props.getProperty('SHEET_ID')).getSheetByName('索引');
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const data = sheet.getRange(2, 1, lastRow - 1, 7).getValues(); // 時間,類型,課程標籤,檔名,Drive連結,來源,備註
  const lower = courseName.toLowerCase();
  const results = [];

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (String(row[2]).toLowerCase() !== lower) continue;
    const time = row[0] instanceof Date ? row[0].toISOString() : String(row[0]);
    results.push({ time: time, type: row[1], filename: row[3], url: row[4], note: row[6] || '' });
  }

  results.sort(function (a, b) { return new Date(b.time) - new Date(a.time); });
  return results.slice(0, 200);
}

/**
 * 跨課程全表搜尋:對索引表每一列的「檔名/備註/課程標籤」三個欄位做不分大小寫的子字串比對,
 * 回傳格式比 getFilesForCourse() 多一個 tag 欄位——結果橫跨多門課,前端要知道每筆結果
 * 屬於哪一門課。沒有查詢字串直接回傳空陣列,不做「回傳全部」這種容易誤觸的行為。
 * 個人使用規模下單次全表掃描是毫秒等級,reconcileIndex() 做的全樹掃描規模更大都沒問題,
 * 這裡讀取量遠比它小。
 */
function searchFilesAcrossCourses(query, props) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];

  const sheet = SpreadsheetApp.openById(props.getProperty('SHEET_ID')).getSheetByName('索引');
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const data = sheet.getRange(2, 1, lastRow - 1, 7).getValues(); // 時間,類型,課程標籤,檔名,Drive連結,來源,備註
  const results = [];

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const tag = String(row[2] || '');
    const filename = String(row[3] || '');
    const note = String(row[6] || '');
    if (
      tag.toLowerCase().indexOf(q) === -1 &&
      filename.toLowerCase().indexOf(q) === -1 &&
      note.toLowerCase().indexOf(q) === -1
    ) continue;
    const time = row[0] instanceof Date ? row[0].toISOString() : String(row[0]);
    results.push({ time: time, type: row[1], tag: tag, filename: filename, url: row[4], note: note });
  }

  results.sort(function (a, b) { return new Date(b.time) - new Date(a.time); });
  return results.slice(0, 100);
}

/**
 * POST 端點:
 *   action: 'addCourse'     → PWA 新增課程用。Body: { passKey, action, courseName }
 *   action: 'removeCourse'  → PWA 刪除課程用。Body: { passKey, action, courseName }
 *   action: 'setCourseCategory' → PWA 管理課程指定分類用。Body: { passKey, action, courseName, category }
 *                              category 是「學習」「工作」「投資」其中之一,或空字串代表未分類。
 *                              如果這個課程已經有建立過 Drive 資料夾,會實際搬到新分類底下(見
 *                              handleSetCourseCategory())。
 *   action: 'dismissCleanup'→ PWA 確認已手動清理 Drive 用。Body: { passKey, action, courseName }
 *   action: 'saveNote'      → PWA 課堂筆記存檔用。Body: { passKey, action, courseName, blocks }
 *                              同一天、同一課程共用同一份 Google 文件,重複呼叫是覆蓋更新,不會
 *                              累積出一堆零碎檔案(見 saveNote())。blocks 是結構化的段落陣列
 *                              (見 handleSaveNote() 開頭註解),不是 HTML 字串——直接存成原生
 *                              Google 文件,才能在 Drive 裡點開就正常顯示螢光筆/標題格式,不用
 *                              自己另外做檢視器(Drive 內建預覽不會執行 .html 檔案裡的格式)。
 *   action: 'archivePodcast'→ PWA 貼 Apple Podcasts 網址歸檔用。Body: { passKey, action, courseName, appleUrl }
 *                              後端自己解析 collection ID、查 RSS Feed、比對集數標題,馬上回應「已啟動」,
 *                              實際下載音檔、上傳 Drive 交給背景工作分好幾次接力完成(見 startPodcastJob()/
 *                              processPodcastJob()),不受單次執行 6 分鐘上限限制。PWA 用 doGet 的
 *                              podcastJobStatus 這個 action 輪詢進度。只支援 Apple Podcasts 格式的網址。
 *   (無 action)             → PWA 拍照/錄音檔上傳用。Body: { passKey, filename, mimeType, base64Data, tag, type }
 *                              type 是 'photo'(預設,拍照)或 'audio'(其他裝置錄的音檔;也相容
 *                              舊版課堂筆記用過的 'note',只是新版筆記都改走 saveNote 這個 action 了)。
 *                              注意:base64 編碼後的請求本體有大小上限(~50MB),適合短音檔;
 *                              整堂課等級的大檔案(60~150MB)還是要走「分享到 Drive → 存進 _收件夾」
 *                              那條路,見 ios-shortcut-guide.md。
 */
function doPost(e) {
  const props = PropertiesService.getScriptProperties();

  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse({ ok: false, error: 'bad request' });
  }

  if (body.passKey !== props.getProperty('PASS_KEY')) {
    return jsonResponse({ ok: false, error: 'unauthorized' });
  }

  // reconcile 自己會上鎖、而且全樹掃描可能跑比較久,獨立處理,不佔用下面上傳/課程操作用的共用鎖
  if (body.action === 'reconcile') {
    try {
      const r = reconcileIndex();
      if (!r) return jsonResponse({ ok: false, error: 'server busy, please retry' });
      return jsonResponse({ ok: true, added: r.added, removed: r.removed });
    } catch (err) {
      return jsonResponse({ ok: false, error: String(err) });
    }
  }

  // archivePodcast 也獨立處理,不佔共用鎖:過程要打好幾次外部網路請求(iTunes API、
  // Apple 網頁、RSS Feed、音檔本體),可能要幾秒到十幾秒,不該卡住同時間的其他操作。
  // 真正動到 Drive/索引表的最後一步,archivePodcastEpisode() 內部自己短暫上鎖。
  if (body.action === 'archivePodcast') {
    return handleArchivePodcast(body, props);
  }

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (err) {
    return jsonResponse({ ok: false, error: 'server busy, please retry' });
  }

  try {
    if (body.action === 'addCourse') {
      return handleAddCourse(body, props);
    }
    if (body.action === 'removeCourse') {
      return handleRemoveCourse(body, props);
    }
    if (body.action === 'setCourseCategory') {
      return handleSetCourseCategory(body, props);
    }
    if (body.action === 'dismissCleanup') {
      return handleDismissCleanup(body, props);
    }
    if (body.action === 'saveNote') {
      return handleSaveNote(body, props);
    }

    if (!body.base64Data || !body.filename) {
      return jsonResponse({ ok: false, error: 'missing base64Data or filename' });
    }

    const bytes = Utilities.base64Decode(body.base64Data);
    const blob = Utilities.newBlob(bytes, body.mimeType || 'application/octet-stream', body.filename);
    // type 只接受這三種已知值,其他一律當拍照處理(避免呼叫端傳奇怪字串建出非預期的資料夾)
    const uploadType = (body.type === 'note' || body.type === 'audio') ? body.type : 'photo';

    const result = fileIntoLibrary(blob, uploadType, body.tag || '未分類', 'PWA');
    return jsonResponse({ ok: true, url: result.url, name: result.name });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
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

  // 重新新增回來,代表這個課程還要繼續用,順便清掉待清理提醒(如果有的話)
  const pending = clearPendingCleanup(name, props);

  return jsonResponse({ ok: true, courses: courses, pending: pending });
}

function handleRemoveCourse(body, props) {
  const name = String(body.courseName || '').trim();
  const courses = JSON.parse(props.getProperty('COURSES') || '["未分類"]');
  const idx = courses.findIndex(function (c) { return c.toLowerCase() === name.toLowerCase(); });
  if (idx === -1) {
    return jsonResponse({ ok: false, error: 'course not found' });
  }
  const actualName = courses[idx]; // 用清單裡登記的大小寫版本,跟 Drive 資料夾名稱、待清理提醒保持一致

  courses.splice(idx, 1);
  props.setProperty('COURSES', JSON.stringify(courses));

  // 如果 Drive 裡這個課程還有實際資料夾(代表真的有存過檔案),記一筆待清理提醒
  const root = DriveApp.getFolderById(props.getProperty('ROOT_FOLDER_ID'));
  let pending = JSON.parse(props.getProperty('PENDING_CLEANUP') || '[]');
  if (courseFolderExists(root, actualName, props) && !pending.some(function (p) { return p.name.toLowerCase() === actualName.toLowerCase(); })) {
    pending.push({ name: actualName, removedAt: new Date().toISOString() });
    props.setProperty('PENDING_CLEANUP', JSON.stringify(pending));
  }

  return jsonResponse({ ok: true, courses: courses, pending: pending });
}

/**
 * 幫課程指定/取消分類。如果這個課程已經有建立過 Drive 資料夾,實際用 Folder.moveTo() 搬到
 * 新分類底下(還沒建立過的話只更新分類設定,之後第一次歸檔就會直接建在新位置,不用搬)。
 */
function handleSetCourseCategory(body, props) {
  const name = String(body.courseName || '').trim();
  const category = String(body.category || '').trim();
  if (!name) {
    return jsonResponse({ ok: false, error: '缺少課程名稱' });
  }
  if (category && CATEGORY_LIST.indexOf(category) === -1) {
    return jsonResponse({ ok: false, error: '不支援的分類' });
  }

  const courses = JSON.parse(props.getProperty('COURSES') || '["未分類"]');
  const idx = courses.findIndex(function (c) { return c.toLowerCase() === name.toLowerCase(); });
  if (idx === -1) {
    return jsonResponse({ ok: false, error: 'course not found' });
  }
  const actualName = courses[idx];

  const root = DriveApp.getFolderById(props.getProperty('ROOT_FOLDER_ID'));
  const oldCategory = getCourseCategory(actualName, props);

  if (oldCategory !== category) {
    const oldParent = oldCategory ? findActiveFolder(root, oldCategory) : root;
    const existingCourseFolder = oldParent ? findActiveFolder(oldParent, actualName) : null;
    if (existingCourseFolder) {
      const newParent = category ? getOrCreateFolder(root, category) : root;
      existingCourseFolder.moveTo(newParent);
    }

    const map = JSON.parse(props.getProperty('COURSE_CATEGORIES') || '{}');
    if (category) {
      map[actualName] = category;
    } else {
      delete map[actualName];
    }
    props.setProperty('COURSE_CATEGORIES', JSON.stringify(map));
  }

  return jsonResponse({ ok: true, category: category });
}

function handleDismissCleanup(body, props) {
  const name = String(body.courseName || '').trim();
  const pending = clearPendingCleanup(name, props);
  return jsonResponse({ ok: true, pending: pending });
}

/**
 * blocks 格式(PWA 端的 extractNoteBlocks() 產生):
 *   [ { type:'heading', level: 1|2|3, text:'第一章' },   // level 1=大章、2=節、3=小節
 *     { type:'paragraph', runs:[
 *         { text:'一般文字', bold:false, italic:false, highlightColor:null,    textColor:null },
 *         { text:'重點',    bold:true,  italic:false, highlightColor:'#fde047', textColor:null },
 *         { text:'警告',    bold:false, italic:false, highlightColor:null,    textColor:'#dc2626' }
 *     ] },
 *     ... ]
 *   highlightColor 是螢光筆底色,textColor 是字體本身的顏色,兩者互不影響、可以同時存在。
 */
function handleSaveNote(body, props) {
  const blocks = Array.isArray(body.blocks) ? body.blocks : [];
  const hasContent = blocks.some(function (b) {
    if (b.type === 'heading') return String(b.text || '').trim().length > 0;
    return (b.runs || []).some(function (r) { return String(r.text || '').trim().length > 0; });
  });
  if (!hasContent) {
    return jsonResponse({ ok: false, error: 'empty note' });
  }
  const tag = String(body.courseName || '').trim();
  if (!tag) {
    return jsonResponse({ ok: false, error: 'missing courseName' });
  }
  const result = saveNote(tag, blocks, props);
  return jsonResponse({ ok: true, url: result.url, name: result.name });
}

/**
 * 把某個課程名稱從「待清理提醒」清單裡移除(不分大小寫比對),回傳更新後的清單。
 */
function clearPendingCleanup(name, props) {
  const pending = JSON.parse(props.getProperty('PENDING_CLEANUP') || '[]');
  const filtered = pending.filter(function (p) { return p.name.toLowerCase() !== name.toLowerCase(); });
  if (filtered.length !== pending.length) {
    props.setProperty('PENDING_CLEANUP', JSON.stringify(filtered));
  }
  return filtered;
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
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (err) {
    Logger.log('scanInbox 取得鎖定逾時,可能跟其他排程/請求撞期,略過這次,下次排程會再試。');
    return;
  }

  try {
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
  } finally {
    lock.releaseLock();
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

const TYPE_FOLDER_NAME = { photo: '照片', audio: '錄音', note: '筆記', podcast: 'Podcast', doc: '文件' };

// 課程分類保留字。分類本身只是根目錄底下的普通資料夾,課程可以選擇性歸到裡面分組管理;
// 沒被指定分類的課程維持現況(資料夾直接在根目錄下,不建分類這層)。
// 已知邊界情況:如果剛好有課程名稱跟這三個字完全相同,對帳/掃描(見 getCourseFoldersUnderRoot）
// 會把它誤判成分類資料夾而不是課程,機率很低,真的遇到請先把那個課程改名。
const CATEGORY_LIST = ['學習', '工作', '投資'];

/**
 * 查課程目前的分類(COURSE_CATEGORIES 屬性,{課程名: 分類} 的 JSON 物件),
 * 沒登記回傳空字串,代表「未分類」——維持現況,不會多一層分類資料夾。
 */
function getCourseCategory(courseName, props) {
  const map = JSON.parse(props.getProperty('COURSE_CATEGORIES') || '{}');
  return map[courseName] || '';
}

/**
 * 找/建一個課程的資料夾,依照它目前有沒有被指定分類,決定要不要先經過分類資料夾這層。
 * fileIntoLibrary()/saveNote()/startPodcastJob() 都改呼叫這個,不再各自內聯 getOrCreateFolder(root, safeTag)。
 */
function getCourseFolder(root, safeTag, props) {
  const category = getCourseCategory(safeTag, props);
  const parent = category ? getOrCreateFolder(root, category) : root;
  return getOrCreateFolder(parent, safeTag);
}

/**
 * 走訪根目錄底下所有「課程資料夾」,把分類這層攤平——分類資料夾(名稱剛好是 CATEGORY_LIST
 * 其中之一)底下的課程資料夾會被撈出來,其他直接子資料夾當成未分類課程(現況行為)。
 * reconcileIndex()/syncCoursesFromFolders() 都改呼叫這個取代原本直接走訪 root.getFolders()。
 */
function getCourseFoldersUnderRoot(root, inboxId) {
  const result = [];
  const it = root.getFolders();
  while (it.hasNext()) {
    const folder = it.next();
    if (folder.getId() === inboxId || folder.isTrashed()) continue;
    if (CATEGORY_LIST.indexOf(folder.getName()) !== -1) {
      const sub = folder.getFolders();
      while (sub.hasNext()) {
        const courseFolder = sub.next();
        if (!courseFolder.isTrashed()) result.push(courseFolder);
      }
    } else {
      result.push(folder);
    }
  }
  return result;
}

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
  // 又有新檔案歸檔到這個標籤,代表課程還在使用中,清掉可能殘留的待清理提醒
  clearPendingCleanup(tag, props);
}

/**
 * 把一個 blob 歸檔到 隨時資料庫/課程/年/月/類型/,改成統一命名規則,並寫入索引表一列。
 * note 是可選的補充說明(目前只有 Podcast 歸檔會用到,存這一集的完整標題),寫進索引表
 * 本來就有、但一直沒用到的「備註」欄,不影響檔名規則(檔名還是統一格式,不會因為標題
 * 很長或含特殊字元跑掉)。
 */
function fileIntoLibrary(blob, type, tag, source, note) {
  const props = PropertiesService.getScriptProperties();
  const root = DriveApp.getFolderById(props.getProperty('ROOT_FOLDER_ID'));
  const now = new Date();

  const yyyy = Utilities.formatDate(now, 'Asia/Taipei', 'yyyy');
  const mm = Utilities.formatDate(now, 'Asia/Taipei', 'MM');
  const typeFolderName = TYPE_FOLDER_NAME[type] || '其他';
  const safeTag = String(tag || '未分類').replace(/[\\\/:*?"<>|]/g, '') || '未分類';
  registerCourseIfNew(safeTag, props);

  const courseFolder = getCourseFolder(root, safeTag, props);
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
  sheet.appendRow([now, typeFolderName, safeTag, newName, file.getUrl(), source, note || '']);

  return { url: file.getUrl(), name: newName };
}

function getOrCreateFolder(parent, name) {
  const it = parent.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return parent.createFolder(name);
}

/**
 * 課堂筆記專用的儲存邏輯,跟 fileIntoLibrary 不同:fileIntoLibrary 每次呼叫都建一個新檔案
 * (適合拍照/錄音這種一次性紀錄),saveNote 則是「同一天、同一課程共用同一份文件」——
 * 檔名用日期(不含時分秒)決定,同一天內重複呼叫會覆蓋更新同一份文件內容,不會累積出
 * 一堂課存好幾次、變成好幾個零碎檔案的狀況。
 *
 * 存成原生 Google 文件(不是 .html 檔案):Drive 內建預覽不會把 .html 檔案當網頁執行,只會
 * 顯示原始標籤文字,踩過這個雷。改用 DocumentApp 直接建立/更新真正的 Google 文件,在 Drive
 * 裡點開就會正常顯示螢光筆底色跟章節標題格式,不用另外做檢視器。
 */
function saveNote(courseTag, blocks, props) {
  const root = DriveApp.getFolderById(props.getProperty('ROOT_FOLDER_ID'));
  const now = new Date();

  const yyyy = Utilities.formatDate(now, 'Asia/Taipei', 'yyyy');
  const mm = Utilities.formatDate(now, 'Asia/Taipei', 'MM');
  const dd = Utilities.formatDate(now, 'Asia/Taipei', 'dd');
  const safeTag = String(courseTag || '未分類').replace(/[\\\/:*?"<>|]/g, '') || '未分類';
  registerCourseIfNew(safeTag, props);

  const courseFolder = getCourseFolder(root, safeTag, props);
  const yearFolder = getOrCreateFolder(courseFolder, yyyy);
  const monthFolder = getOrCreateFolder(yearFolder, mm);
  const noteFolder = getOrCreateFolder(monthFolder, TYPE_FOLDER_NAME.note);

  const fileName = TYPE_FOLDER_NAME.note + '_' + yyyy + mm + dd + '_' + safeTag;
  const existing = noteFolder.getFilesByName(fileName);
  const sheet = SpreadsheetApp.openById(props.getProperty('SHEET_ID')).getSheetByName('索引');

  let doc;
  let isNew = false;
  if (existing.hasNext()) {
    doc = DocumentApp.openById(existing.next().getId());
  } else {
    doc = DocumentApp.create(fileName);
    isNew = true;
  }

  writeNoteBlocks(doc, blocks);
  doc.saveAndClose();

  const file = DriveApp.getFileById(doc.getId());
  if (isNew) {
    noteFolder.addFile(file);
    DriveApp.getRootFolder().removeFile(file); // DocumentApp.create() 一律先建在 Drive 根目錄,建好要手動搬過去
    sheet.appendRow([now, TYPE_FOLDER_NAME.note, safeTag, fileName, file.getUrl(), 'PWA', '']);
  } else {
    updateIndexRowTime(sheet, file.getUrl(), now); // 讓瀏覽清單排序反映「最後編輯時間」而不是第一次建立時間
  }

  return { url: file.getUrl(), name: fileName };
}

// 章節層級對應 Google 文件內建的標題樣式:1=大章(最大)、2=節、3=小節(最小)。
const CHAPTER_HEADING_MAP = {
  1: DocumentApp.ParagraphHeading.HEADING1,
  2: DocumentApp.ParagraphHeading.HEADING2,
  3: DocumentApp.ParagraphHeading.HEADING3
};

/**
 * 把結構化的 blocks(見 handleSaveNote 開頭註解)寫進 Google 文件,取代原本的全部內容。
 */
function writeNoteBlocks(doc, blocks) {
  const body = doc.getBody();
  body.clear();

  blocks.forEach(function (block) {
    const para = body.appendParagraph('');
    if (block.type === 'heading') {
      para.setHeading(CHAPTER_HEADING_MAP[block.level] || DocumentApp.ParagraphHeading.HEADING2);
      para.editAsText().setText(String(block.text || ''));
    } else {
      const text = para.editAsText();
      let offset = 0;
      (block.runs || []).forEach(function (run) {
        const runText = String(run.text || '');
        if (!runText) return;
        text.insertText(offset, runText);
        const end = offset + runText.length - 1;
        if (run.highlightColor) text.setBackgroundColor(offset, end, run.highlightColor);
        if (run.textColor) text.setForegroundColor(offset, end, run.textColor);
        if (run.bold) text.setBold(offset, end, true);
        if (run.italic) text.setItalic(offset, end, true);
        offset += runText.length;
      });
    }
  });

  // body.clear() 會留下一個空段落,我們的內容都是後來 append 上去的,所以最前面那個
  // 空段落要清掉,不然筆記開頭會多一行空白。用數量差判斷,不假設 clear() 的確切行為。
  if (blocks.length > 0 && body.getNumChildren() > blocks.length) {
    body.removeChild(body.getChild(0));
  }
}

/**
 * 在索引表裡找出 Drive連結 欄等於 url 的那一列,把時間欄(A欄)更新成 now。找不到就不動作。
 */
function updateIndexRowTime(sheet, url, now) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const urls = sheet.getRange(2, 5, lastRow - 1, 1).getValues();
  for (let i = 0; i < urls.length; i++) {
    if (urls[i][0] === url) {
      sheet.getRange(i + 2, 1).setValue(now);
      return;
    }
  }
}

// ============ Podcast 歸檔(貼 Apple Podcasts 網址,背景分段下載+上傳,不受單次執行 6 分鐘上限限制)============
//
// 整體流程:
//   1. handleArchivePodcast()/startPodcastJob() 在使用者按下「封存」的這次請求裡,同步做完
//      「查 collection ID → iTunes Lookup 拿 RSS Feed → 抓集數標題 → 比對 RSS 找音檔網址」
//      這幾個很快的小型 API 呼叫,並啟動一個 Google Drive 分段上傳(resumable upload)工作階段,
//      把工作進度存進 PropertiesService 的 PODCAST_JOB,馬上回應「已啟動背景下載」,不等下載完成。
//   2. 排一個一次性觸發器呼叫 processPodcastJob(),用 downloadAndUploadNextChunk() 一段一段跟
//      來源要 HTTP Range 分段內容、直接 PUT 上傳到 Drive 的分段上傳工作階段(不在記憶體裡拼接整個
//      音檔),每次執行只做時間預算內能做的量,做不完就在結尾排下一個一次性觸發器接力繼續。
//   3. 全部上傳完後 finalizePodcastJob() 短暫上鎖寫入索引表一列,工作結束。
//
// 這樣設計是因為 Apps Script 對「單次執行」(不管是網頁請求還是排程觸發)都有 6 分鐘上限,
// 之前整段下載+歸檔塞在同一次請求裡處理,長集數很容易頂到這個上限而失敗、且失敗時完全沒有
// 進度可言;拆成背景接力後,單次執行只需處理一小段,同時邊下載邊上傳也不再需要把整個音檔
// 放進記憶體,兩個既有的殘留限制(執行時間、記憶體)一起解決。
//
// 已知限制:只認 Apple Podcasts 網址;極少數情況標題比對不到會回傳錯誤,不會抓錯集數;
// 同時間只支援一個背景工作(符合這個專案單一自足腳本、不做過度設計的風格),工作卡住超過
// 10 分鐘沒更新視為異常中止,允許重新開始;整個下載超過 3 小時視為異常,強制中止不會無限重試。

const PODCAST_CHUNK_SIZE = 8 * 1024 * 1024; // 8MB,是 256KiB 的整數倍,符合 Drive 分段上傳對非最後一段長度的規則
const PODCAST_JOB_PROP = 'PODCAST_JOB';
const PODCAST_TICK_BUDGET_MS = 4.5 * 60 * 1000; // 每次背景執行的工作預算,留餘裕不去頂到 Apps Script 6 分鐘上限
const PODCAST_JOB_STALE_MS = 10 * 60 * 1000; // 工作進度超過這麼久沒更新,視為卡住/異常中止,允許重新開始新的一集
const PODCAST_JOB_MAX_AGE_MS = 3 * 60 * 60 * 1000; // 從頭到尾超過這個時間強制中止,避免異常狀況下無限接力下去

function handleArchivePodcast(body, props) {
  const tag = String(body.courseName || '').trim();
  if (!tag) {
    return jsonResponse({ ok: false, error: '缺少課程名稱' });
  }
  const appleUrl = String(body.appleUrl || '').trim();
  if (!appleUrl) {
    return jsonResponse({ ok: false, error: '缺少 Podcast 網址' });
  }

  const existing = getPodcastJob(props);
  if (existing && (existing.status === 'downloading' || existing.status === 'finalizing')) {
    const age = Date.now() - new Date(existing.updatedAt).getTime();
    if (age < PODCAST_JOB_STALE_MS) {
      return jsonResponse({ ok: false, error: '已經有一集(「' + existing.episodeTitle + '」)正在背景下載,請等它完成或失敗後再試' });
    }
    // 卡住太久了,視為已經異常中止,允許蓋掉重新開始一個新的工作
  }

  try {
    const job = startPodcastJob(appleUrl, tag, props);
    return jsonResponse({ ok: true, started: true, title: job.episodeTitle });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err.message || err) });
  }
}

/**
 * 解析集數、決定歸檔位置、啟動 Drive 分段上傳工作階段,把工作進度存下來,並排一個馬上執行的
 * 一次性觸發器開始背景下載。這幾步都很快(幾個小型 API 呼叫),所以留在請求本身同步做;
 * 真正耗時的音檔下載/上傳交給 processPodcastJob() 分好幾次背景執行完成。
 */
function startPodcastJob(appleUrl, tag, props) {
  const collectionId = extractApplePodcastCollectionId(appleUrl);
  if (!collectionId) {
    throw new Error('看不出這是 Apple Podcasts 的集數網址,請確認貼的是完整的分享連結');
  }

  // 1. 查節目的 RSS Feed 網址
  const lookupResp = UrlFetchApp.fetch('https://itunes.apple.com/lookup?id=' + collectionId, { muteHttpExceptions: true });
  const lookupData = JSON.parse(lookupResp.getContentText());
  const feedUrl = lookupData.results && lookupData.results[0] && lookupData.results[0].feedUrl;
  if (!feedUrl) {
    throw new Error('在 Apple Podcasts 資料庫裡找不到這個節目的 RSS Feed');
  }

  // 2. 抓這一集在 Apple Podcasts 頁面上的完整標題,用來比對 RSS 裡是哪一集
  const pageResp = UrlFetchApp.fetch(appleUrl, { muteHttpExceptions: true });
  const titleMatch = pageResp.getContentText().match(/<meta property="og:title" content="([^"]+)"/);
  if (!titleMatch) {
    throw new Error('讀不到這一集的標題,請確認網址是有效的集數分享連結(不是節目首頁)');
  }
  const episodeTitle = decodeHtmlEntities(titleMatch[1]);

  // 3. 抓 RSS Feed,找標題完全吻合的那一集,取出音檔網址
  const feedResp = UrlFetchApp.fetch(feedUrl, { muteHttpExceptions: true });
  const items = XmlService.parse(feedResp.getContentText()).getRootElement().getChild('channel').getChildren('item');
  let audioUrl = null;
  for (let i = 0; i < items.length; i++) {
    if (items[i].getChildText('title') === episodeTitle) {
      const enclosure = items[i].getChild('enclosure');
      if (enclosure) audioUrl = enclosure.getAttribute('url').getValue();
      break;
    }
  }
  if (!audioUrl) {
    throw new Error('在節目的 RSS 清單裡找不到「' + episodeTitle + '」這一集,可能標題有出入或集數已下架');
  }

  // 4. 決定歸檔位置跟檔名(跟 fileIntoLibrary() 的規則一致),啟動 Drive 分段上傳工作階段
  const safeTag = String(tag || '未分類').replace(/[\\\/:*?"<>|]/g, '') || '未分類';
  registerCourseIfNew(safeTag, props);
  const root = DriveApp.getFolderById(props.getProperty('ROOT_FOLDER_ID'));
  const now = new Date();
  const yyyy = Utilities.formatDate(now, 'Asia/Taipei', 'yyyy');
  const mm = Utilities.formatDate(now, 'Asia/Taipei', 'MM');
  const courseFolder = getCourseFolder(root, safeTag, props);
  const yearFolder = getOrCreateFolder(courseFolder, yyyy);
  const monthFolder = getOrCreateFolder(yearFolder, mm);
  const typeFolder = getOrCreateFolder(monthFolder, TYPE_FOLDER_NAME.podcast);

  const extMatch = audioUrl.match(/\.(mp3|m4a|wav|aac)(\?|$)/i);
  const ext = extMatch ? extMatch[1].toLowerCase() : 'mp3';
  const mimeType = { mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', aac: 'audio/aac' }[ext] || 'audio/mpeg';
  // 檔名直接用集數標題(使用者才好在 Drive 裡憑原始標題找到這一集),不是統一的時間戳記格式;
  // 清掉路徑不合法字元、截長度避免超出檔名長度限制,萬一清完是空字串(標題整段都是特殊符號這種
  // 極端情況)才退回原本的時間戳記命名當保底。
  const stamp = Utilities.formatDate(now, 'Asia/Taipei', 'yyyyMMdd_HHmm');
  const safeTitle = String(episodeTitle).replace(/[\\\/:*?"<>|]/g, '').trim().slice(0, 150);
  const fileName = (safeTitle || (TYPE_FOLDER_NAME.podcast + '_' + stamp + '_' + safeTag)) + '.' + ext;

  const uploadUrl = initDriveResumableUpload(fileName, mimeType, typeFolder.getId());

  const job = {
    status: 'downloading',
    tag: safeTag,
    episodeTitle: episodeTitle,
    audioUrl: audioUrl,
    contentType: mimeType,
    fileName: fileName,
    uploadUrl: uploadUrl,
    offset: 0,
    totalSize: null,
    driveFileId: null,
    error: null,
    resultUrl: null,
    resultName: null,
    startedAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
  savePodcastJob(job, props);

  ScriptApp.newTrigger('processPodcastJob').timeBased().after(1000).create();

  return job;
}

function getPodcastJob(props) {
  const raw = props.getProperty(PODCAST_JOB_PROP);
  return raw ? JSON.parse(raw) : null;
}

function savePodcastJob(job, props) {
  job.updatedAt = new Date().toISOString();
  props.setProperty(PODCAST_JOB_PROP, JSON.stringify(job));
}

/**
 * 啟動一個 Google Drive 分段上傳工作階段(Drive API v3 resumable upload),順便直接指定
 * 檔名/mimeType/所在資料夾,回傳這個工作階段的網址。之後每下載到一段音檔,就直接 PUT 去
 * 這個網址,不用等全部下載完才一次寫進 Drive——這樣才能讓下載/上傳工作跨好幾次 Apps Script
 * 執行接力完成,同時每次執行都只需要在記憶體裡撐住一小段內容,不用拼出整個音檔。
 * 因為啟動時就指定了 parents,完成後檔案已經在正確的課程/年/月/Podcast 資料夾裡,
 * 不用歸檔後再搬動。
 */
function initDriveResumableUpload(fileName, mimeType, parentFolderId) {
  const resp = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify({ name: fileName, mimeType: mimeType, parents: [parentFolderId] }),
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) {
    throw new Error('無法啟動 Drive 分段上傳工作階段(HTTP ' + resp.getResponseCode() + ')');
  }
  const headers = resp.getHeaders();
  const uploadUrl = headers['Location'] || headers['location'];
  if (!uploadUrl) {
    throw new Error('Drive 沒有回傳分段上傳工作階段網址');
  }
  return uploadUrl;
}

/**
 * 由一次性觸發器呼叫(見 startPodcastJob() 結尾/本函式結尾)。每次執行處理一段時間預算內能做的
 * 分段下載+上傳,做不完就在結尾排下一個一次性觸發器接力繼續,直到整個檔案處理完或失敗為止。
 * 用「一次性觸發器接力」而不是固定週期排程,是為了避免同一個工作被兩個重疊的執行同時處理
 * (固定週期排程如果上一次還沒跑完、下一次時間就到了,Apps Script 會兩個一起跑,狀態會撞在一起);
 * 一次性觸發器觸發完會自動被 Apps Script 移除,不用手動清。
 */
function processPodcastJob() {
  const props = PropertiesService.getScriptProperties();
  const job = getPodcastJob(props);
  if (!job) return; // 沒有工作在進行

  if (job.status === 'finalizing') {
    // 上一次接力卡在寫索引表那一步(通常是搶鎖失敗),直接重試
    finalizePodcastJob(job, props);
    return;
  }
  if (job.status !== 'downloading') return; // 已經 done/error,沒有事要做

  const startedAgo = Date.now() - new Date(job.startedAt).getTime();
  if (startedAgo > PODCAST_JOB_MAX_AGE_MS) {
    job.status = 'error';
    job.error = '下載耗時超過安全上限(3 小時),已中止,請重新試一次';
    savePodcastJob(job, props);
    return;
  }

  const tickStart = Date.now();
  try {
    while (Date.now() - tickStart < PODCAST_TICK_BUDGET_MS) {
      const done = downloadAndUploadNextChunk(job);
      savePodcastJob(job, props);
      if (done) {
        finalizePodcastJob(job, props);
        return;
      }
    }
  } catch (err) {
    job.status = 'error';
    job.error = String(err.message || err);
    savePodcastJob(job, props);
    return;
  }

  // 這次執行的時間預算用完了,還沒下載完,排下一次接力繼續
  ScriptApp.newTrigger('processPodcastJob').timeBased().after(3000).create();
}

/**
 * 處理一段(用 job.offset 記錄的位置繼續):跟來源要一段 HTTP Range,成功就直接 PUT 給
 * uploadChunkToDrive() 上傳到 Drive,更新 job.offset/job.totalSize。回傳 true 代表整個
 * 檔案已經處理完。
 *
 * 沿用先前單次下載版本的核心邏輯:用回應的 Content-Range 標頭取得真正總長度(不依賴來源
 * 自己宣告的、不一定可靠的長度欄位);伺服器不支援分段下載時直接把拿到的完整內容當一段處理。
 * 跟先前版本不同的地方:截斷檢查從「容許 2% 誤差」收緊成「非最後一段必須剛好等於預期長度」,
 * 因為 Drive 分段上傳要求非最後一段的長度得是 256KiB 的整數倍,不能有零頭。
 */
function downloadAndUploadNextChunk(job) {
  const chunkEnd = job.offset + PODCAST_CHUNK_SIZE - 1;
  const rangeEnd = job.totalSize === null ? chunkEnd : Math.min(chunkEnd, job.totalSize - 1);

  const resp = UrlFetchApp.fetch(job.audioUrl, {
    headers: { Range: 'bytes=' + job.offset + '-' + rangeEnd },
    muteHttpExceptions: true
  });
  const code = resp.getResponseCode();

  if (code === 200 && job.offset === 0) {
    // 來源不支援分段下載,直接給了完整內容,一次上傳完成
    const bytes = resp.getContent();
    job.totalSize = bytes.length;
    uploadChunkToDrive(job, bytes, 0, bytes.length - 1, true);
    job.offset = bytes.length;
    return true;
  }
  if (code !== 206) {
    throw new Error('下載失敗(HTTP ' + code + '),來源網址可能已經失效');
  }

  const headers = resp.getHeaders();
  const contentRange = headers['Content-Range'] || headers['content-range'];
  const totalMatch = contentRange && String(contentRange).match(/\/(\d+)\s*$/);
  if (!totalMatch) {
    throw new Error('讀不到檔案總長度,無法確認下載進度');
  }
  if (job.totalSize === null) job.totalSize = parseInt(totalMatch[1], 10);

  const bytes = resp.getContent();
  const expectedLen = rangeEnd - job.offset + 1;
  const isFinal = job.offset + bytes.length >= job.totalSize;
  if (!isFinal && bytes.length !== expectedLen) {
    throw new Error(
      '分段下載時有一段沒抓完整(從第 ' + job.offset + ' bytes 開始那段,預期 ' + expectedLen +
      ' bytes,實際拿到 ' + bytes.length + ' bytes),可能是網路不穩,請重新試一次'
    );
  }

  uploadChunkToDrive(job, bytes, job.offset, job.offset + bytes.length - 1, isFinal);
  job.offset += bytes.length;
  return job.offset >= job.totalSize;
}

/**
 * 把一段內容 PUT 進 Drive 分段上傳工作階段。中間段落 Drive 會回 308(繼續),最後一段
 * (byteEnd+1 等於檔案總長度)Drive 會回 200/201,並在回應內容裡給這個新檔案的 id——
 * 這個 id 就是最後歸檔要用的檔案,存進 job.driveFileId。
 */
function uploadChunkToDrive(job, bytes, byteStart, byteEnd, isFinal) {
  const resp = UrlFetchApp.fetch(job.uploadUrl, {
    method: 'put',
    contentType: job.contentType,
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      'Content-Range': 'bytes ' + byteStart + '-' + byteEnd + '/' + job.totalSize
    },
    payload: Utilities.newBlob(bytes),
    muteHttpExceptions: true
  });
  const code = resp.getResponseCode();
  if (isFinal) {
    if (code !== 200 && code !== 201) {
      throw new Error('上傳到 Drive 失敗(HTTP ' + code + ')');
    }
    const fileData = JSON.parse(resp.getContentText());
    job.driveFileId = fileData.id;
  } else if (code !== 308) {
    throw new Error('上傳到 Drive 這一段失敗(HTTP ' + code + ')');
  }
}

/**
 * 整個音檔上傳完成後,寫進索引表一列(短暫上鎖,只保護這個寫入動作,比照 fileIntoLibrary()/
 * reconcileIndex() 的既有慣例),完成後把工作狀態設成 done。拿不到鎖不會放棄這個工作,
 * 排一個一次性觸發器稍後重試(processPodcastJob() 開頭看到 status 是 finalizing 會直接
 * 重跑這個函式)。
 */
function finalizePodcastJob(job, props) {
  job.status = 'finalizing';
  savePodcastJob(job, props);

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (err) {
    ScriptApp.newTrigger('processPodcastJob').timeBased().after(5000).create();
    return;
  }
  try {
    const file = DriveApp.getFileById(job.driveFileId);
    const sheet = SpreadsheetApp.openById(props.getProperty('SHEET_ID')).getSheetByName('索引');
    sheet.appendRow([new Date(), TYPE_FOLDER_NAME.podcast, job.tag, job.fileName, file.getUrl(), 'Podcast', job.episodeTitle]);
    job.status = 'done';
    job.resultUrl = file.getUrl();
    job.resultName = job.fileName;
  } catch (err) {
    job.status = 'error';
    job.error = '下載完成但寫入索引表失敗:' + String(err.message || err);
  } finally {
    lock.releaseLock();
    savePodcastJob(job, props);
  }
}

function extractApplePodcastCollectionId(url) {
  const m = String(url).match(/\/id(\d+)/);
  return m ? m[1] : null;
}

function decodeHtmlEntities(text) {
  return String(text)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
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

// ============ 對帳工具(讓索引表跟 Drive 實際內容完全同步) ============

/**
 * 對帳工具:掃描每個課程資料夾裡的實際檔案,跟索引表雙向對齊。做三件事:
 *   1. 補登 — 課程資料夾裡有、但索引表沒登記的檔案(例如你直接把檔案拖進 Drive),補一列進索引表
 *   2. 清除 — 索引表有、但 Drive 檔案已刪除(含丟進垃圾桶)的列,移除
 *   3. 補課程 — 順手把有檔案的課程資料夾補進課程清單(等同 syncCoursesFromFolders)
 *
 *   4. 核銷 — 順手核銷「資料夾已刪」的待清理提醒(見 autoResolvePendingCleanup)
 *
 * 只會動索引表的「列」跟課程清單,不會刪除或搬動 Drive 裡任何實際檔案。可以重複執行,回傳 { added, removed }。
 * 三種觸發方式,不用再開編輯器手動跑:
 *   - App 打開或從其他 App 切回來時,背景自動呼叫 doPost action:'reconcile'(靜默,有變更才提示)
 *   - 每天凌晨 3 點自動排程(installCleanupTrigger 安裝)
 *   - 需要時仍可在編輯器函式下拉選 reconcileIndex → 按「執行」
 * 適用情境:你習慣直接在 Drive 整理檔案(新增或刪除),同步後 App 瀏覽跟索引表就對得上。
 *
 * 註:採全樹掃描,檔案數以個人使用規模(數百~數千)為前提;若之後檔案量非常大,單次執行可能逼近
 *     Apps Script 6 分鐘上限,屆時再改成分批處理。
 */
function reconcileIndex() {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (err) {
    Logger.log('reconcileIndex 取得鎖定逾時,可能有其他排程/請求正在跑,請稍後再試一次。');
    return null;
  }

  try {
    const props = PropertiesService.getScriptProperties();
    const root = DriveApp.getFolderById(props.getProperty('ROOT_FOLDER_ID'));
    const inboxId = props.getProperty('INBOX_FOLDER_ID');
    const sheet = SpreadsheetApp.openById(props.getProperty('SHEET_ID')).getSheetByName('索引');

    // 1. 讀出索引表現有的檔案 ID → 列號
    const lastRow = sheet.getLastRow();
    const indexById = {}; // fileId -> rowNumber
    if (lastRow >= 2) {
      const urls = sheet.getRange(2, 5, lastRow - 1, 1).getValues(); // E欄 = Drive連結
      for (let i = 0; i < urls.length; i++) {
        const id = extractFileId(urls[i][0]);
        if (id) indexById[id] = i + 2;
      }
    }

    // 2. 走訪每個課程資料夾(排除收件夾、垃圾桶、分類這層本身),收集實際存在的檔案;
    //    沒登記到索引表的就準備補登
    const actualIds = {};
    const newRows = [];
    getCourseFoldersUnderRoot(root, inboxId).forEach(function (courseFolder) {
      // 用課程清單裡登記的大小寫版本(如果有的話),避免資料夾被手動改過大小寫時,
      // 補登進索引表的標籤跟課程清單顯示的名稱不一致。
      const courseName = normalizeTag(courseFolder.getName(), props);
      let courseHasFiles = false;

      const entries = collectFilesWithType(courseFolder, null);
      for (let j = 0; j < entries.length; j++) {
        const file = entries[j].file;
        courseHasFiles = true;
        const id = file.getId();
        actualIds[id] = true;
        if (!indexById[id]) {
          newRows.push([
            file.getDateCreated(),
            entries[j].type || inferTypeFolderName(file.getMimeType()),
            courseName,
            file.getName(),
            file.getUrl(),
            '對帳補登',
            ''
          ]);
        }
      }

      if (courseHasFiles) registerCourseIfNew(courseName, props);
    });

    // 3. 索引表有、但走訪時沒看到的檔案:逐一用 getFileById 確認是否真的沒了(避免誤刪被移出課程結構的檔案)
    const rowsToDelete = [];
    for (const id in indexById) {
      if (actualIds[id]) continue;
      let dead = false;
      try {
        dead = DriveApp.getFileById(id).isTrashed();
      } catch (err) {
        dead = true; // 找不到檔案,視為已刪除
      }
      if (dead) rowsToDelete.push(indexById[id]);
    }

    // 先刪(由下往上,避免列號跑掉),再補登(附加到最下面)
    rowsToDelete.sort(function (a, b) { return b - a; });
    rowsToDelete.forEach(function (row) { sheet.deleteRow(row); });

    if (newRows.length > 0) {
      const startRow = sheet.getLastRow() + 1;
      sheet.getRange(startRow, 1, newRows.length, newRows[0].length).setValues(newRows);
    }

    autoResolvePendingCleanup(props); // 順手核銷「資料夾已刪」的待清理提醒,讓每日排程做的是全套同步
    Logger.log('對帳完成:補登 ' + newRows.length + ' 筆、清除 ' + rowsToDelete.length + ' 筆失效紀錄。');
    return { added: newRows.length, removed: rowsToDelete.length };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 遞迴收集 folder 底下(含各層子資料夾)所有「未被丟進垃圾桶」的檔案,回傳 { file, type } 陣列。
 * type 判斷方式:走訪路徑上只要經過一個名稱剛好是「照片/錄音/筆記/文件」(TYPE_FOLDER_NAME 的值)
 * 的資料夾,就記住這個名稱當作類型,比對純猜 MIME 更準(例如筆記是純文字檔,MIME 猜不出來是筆記
 * 還是一般文件,但只要它躺在「筆記」資料夾底下,就照資料夾說的算)。找不到已知類型資料夾時,
 * type 是 null,由呼叫端退回用 inferTypeFolderName() 猜 MIME。
 */
function collectFilesWithType(folder, inheritedType) {
  const knownTypeNames = Object.keys(TYPE_FOLDER_NAME).map(function (k) { return TYPE_FOLDER_NAME[k]; });
  const type = knownTypeNames.indexOf(folder.getName()) !== -1 ? folder.getName() : inheritedType;

  const out = [];
  const files = folder.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    if (!f.isTrashed()) out.push({ file: f, type: type });
  }
  const subs = folder.getFolders();
  while (subs.hasNext()) {
    const sub = subs.next();
    if (sub.isTrashed()) continue;
    const nested = collectFilesWithType(sub, type);
    for (let i = 0; i < nested.length; i++) out.push(nested[i]);
  }
  return out;
}

/**
 * 用 MIME 類型推斷索引表「類型」欄要填的中文名稱(照片/錄音/文件),跟收件夾歸檔用的規則一致。
 */
function inferTypeFolderName(mime) {
  if (mime && mime.indexOf('image/') === 0) return '照片';
  if (mime && (mime.indexOf('audio/') === 0 || mime.indexOf('video/') === 0)) return '錄音';
  return '文件';
}
