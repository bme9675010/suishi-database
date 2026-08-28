/**
 * 測試用的 Apps Script 假環境。
 *
 * 重點:這裡是把「真正的 apps-script/Code.gs」整份載進 Node 的 vm 沙箱執行,
 * 只把 Apps Script 專屬的服務(DriveApp / SpreadsheetApp / UrlFetchApp …)換成假的。
 * 測到的是實際會部署上去的那份程式碼,不是另外抄一份邏輯來測 —— 抄一份的話,
 * 測試過了也不代表真的程式碼是對的(改壞了測試還會繼續綠燈)。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CODE_GS = path.join(__dirname, '..', '..', 'apps-script', 'Code.gs');

/** Apps Script 的走訪器介面:hasNext() / next() */
function iterator(items) {
  let i = 0;
  return {
    hasNext: function () { return i < items.length; },
    next: function () { return items[i++]; }
  };
}

/**
 * 假的 Drive 資料夾。folders/files 是巢狀陣列,用來組出整棵測試用的資料夾樹。
 */
function makeFolder(spec) {
  const folders = spec.folders || [];
  const files = spec.files || [];
  return {
    getId: function () { return spec.id || spec.name; },
    getName: function () { return spec.name; },
    isTrashed: function () { return !!spec.trashed; },
    getFolders: function () { return iterator(folders); },
    getFiles: function () { return iterator(files); },
    getFoldersByName: function (name) {
      return iterator(folders.filter(function (f) { return f.getName() === name; }));
    },
    createFolder: function (name) {
      const child = makeFolder({ name: name });
      folders.push(child);
      return child;
    }
  };
}

/** 假的指令碼屬性儲存區(PropertiesService) */
function makeProps(initial) {
  const store = Object.assign({}, initial);
  const api = {
    getProperty: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setProperty: function (k, v) { store[k] = String(v); return api; },
    setProperties: function (o) { Object.assign(store, o); return api; },
    deleteProperty: function (k) { delete store[k]; return api; },
    _store: store
  };
  return api;
}

/**
 * 假的索引表。rows 是「不含標題列」的資料列陣列,每列 7 欄:
 * [時間, 類型, 課程標籤, 檔名, Drive連結, 來源, 備註]
 */
function makeSheet(rows) {
  return {
    _rows: rows,
    getLastRow: function () { return rows.length + 1; }, // +1 是標題列
    getRange: function (row, col, numRows, numCols) {
      return {
        getValues: function () {
          return rows.slice(row - 2, row - 2 + numRows).map(function (r) {
            return r.slice(col - 1, col - 1 + numCols);
          });
        },
        setValue: function () { /* 測試用不到 */ }
      };
    },
    appendRow: function (r) { rows.push(r); },
    deleteRow: function (row) { rows.splice(row - 2, 1); }
  };
}

/**
 * 假的 UrlFetchApp。傳入一個 handler(url, options) → 回傳
 * { code, headers, content } 這種簡化描述,這裡再包成 Apps Script 的回應介面。
 *
 * content 可以直接給 { length: N } 這種只有長度的假物件 —— 受測的下載/上傳邏輯
 * 只會讀 bytes.length、再原封不動交給 Utilities.newBlob(),不會逐 byte 取值,
 * 所以測大檔案(數十 MB)時不用真的配置記憶體,測試跑起來很快。
 */
function makeUrlFetchApp(handler) {
  const calls = [];
  return {
    calls: calls,
    fetch: function (url, options) {
      options = options || {};
      calls.push({ url: url, options: options });
      const res = handler(url, options, calls.length - 1);
      return {
        getResponseCode: function () { return res.code; },
        getHeaders: function () { return res.headers || {}; },
        getContent: function () { return res.content; },
        getContentText: function () { return res.text || ''; },
        getBlob: function () { return { _content: res.content }; }
      };
    }
  };
}

/** 會拋錯的替身:測試沒預期會用到的服務,一旦被呼叫就讓測試失敗,而不是默默通過 */
function notStubbed(name) {
  return new Proxy({}, {
    get: function (_t, prop) {
      throw new Error('這個測試沒有替 ' + name + '.' + String(prop) + ' 準備替身,請確認受測程式是否有非預期的呼叫');
    }
  });
}

/**
 * 載入 Code.gs。overrides 用來塞這次測試需要的假服務。
 * 回傳的物件上可以直接取到 Code.gs 裡的「函式」(function 宣告會掛上全域);
 * 若要取 const 常數(例如 CATEGORY_LIST),用回傳的 evaluate('CATEGORY_LIST')。
 */
function loadCodeGs(overrides) {
  const source = fs.readFileSync(CODE_GS, 'utf8');

  const sandbox = {
    console: console,
    JSON: JSON,
    Math: Math,
    Date: Date,
    // Code.gs 在載入當下就會讀 DocumentApp.ParagraphHeading 來組 CHAPTER_HEADING_MAP,
    // 所以這個一定要先給,否則整份載入就會失敗
    DocumentApp: {
      ParagraphHeading: { HEADING1: 'H1', HEADING2: 'H2', HEADING3: 'H3' },
      create: function () { throw new Error('DocumentApp.create 未在此測試中準備替身'); },
      openById: function () { throw new Error('DocumentApp.openById 未在此測試中準備替身'); }
    },
    Logger: { log: function () {} },
    Utilities: {
      newBlob: function (content, type, name) {
        return { _content: content, _type: type, _name: name, setName: function (n) { this._name = n; } };
      },
      getUuid: function () { return 'test-uuid'; },
      formatDate: function () { return '20260101_0000'; },
      base64Decode: function () { return []; }
    },
    DriveApp: notStubbed('DriveApp'),
    SpreadsheetApp: notStubbed('SpreadsheetApp'),
    UrlFetchApp: notStubbed('UrlFetchApp'),
    PropertiesService: notStubbed('PropertiesService'),
    LockService: notStubbed('LockService'),
    ScriptApp: { getOAuthToken: function () { return 'fake-token'; } },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: function (t) {
        return { _text: t, setMimeType: function () { return this; } };
      }
    },
    XmlService: notStubbed('XmlService')
  };

  Object.assign(sandbox, overrides || {});
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'Code.gs' });

  sandbox.evaluate = function (expr) { return vm.runInContext(expr, sandbox); };
  return sandbox;
}

/**
 * 把 vm 沙箱裡產生的「純資料」轉成 Node 主環境的物件/陣列。
 *
 * 為什麼需要:沙箱是獨立的 realm,裡面 `[]`、`{}` 建出來的東西,原型跟主環境的
 * Array/Object 不是同一個,assert.deepStrictEqual 會因為原型不同直接判定不相等,
 * 明明內容一樣卻紅燈。回傳純資料的函式(例如 searchFilesAcrossCourses)測之前
 * 先用這個轉一次。
 *
 * 注意:只適用於純資料。如果陣列裡放的是帶方法的假物件(例如資料夾替身),
 * 用這個會把方法弄丟 —— 那種情況請改成在主環境端先取出要比對的值,
 * 例如 Array.from(result, f => f.getName())。
 */
function toHost(value) {
  if (Array.isArray(value)) return Array.from(value, toHost);
  if (value instanceof Date) return value;
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).forEach(function (k) { out[k] = toHost(value[k]); });
    return out;
  }
  return value;
}

module.exports = {
  loadCodeGs: loadCodeGs,
  toHost: toHost,
  makeFolder: makeFolder,
  makeProps: makeProps,
  makeSheet: makeSheet,
  makeUrlFetchApp: makeUrlFetchApp,
  iterator: iterator
};
