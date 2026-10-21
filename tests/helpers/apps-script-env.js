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
    },
    getFilesByName: function (name) {
      return iterator(files.filter(function (f) { return f.getName() === name; }));
    },
    createFile: function (blob) {
      const created = makeFile({ id: 'created-' + files.length, name: blob.getName ? blob.getName() : 'created' });
      created._fromBlob = blob;
      files.push(created);
      return created;
    },
    addFile: function (f) { files.push(f); },
    // 資料夾也會被搬動(課程指定分類時),同樣把動作記錄下來供斷言
    moveTo: function (folder) { spec.movedTo = folder; return this; },
    setName: function (n) { spec.name = n; return this; },
    _spec: spec,
    removeFile: function (f) {
      const i = files.indexOf(f);
      if (i >= 0) files.splice(i, 1);
    },
    _files: files,
    _folders: folders
  };
}

/**
 * 假的 Drive 檔案。改名 / 搬移 / 丟垃圾桶都會記錄下來(movedTo、trashed、name),
 * 測試才能驗證「收件夾歸檔是搬移,不是複製後丟垃圾桶」。
 */
function makeFile(spec) {
  const api = {
    getId: function () { return spec.id; },
    getName: function () { return spec.name; },
    getUrl: function () { return 'https://drive.google.com/file/d/' + spec.id + '/view'; },
    getMimeType: function () { return spec.mimeType || 'image/jpeg'; },
    getSize: function () { return spec.size === undefined ? 1024 : spec.size; },
    getDateCreated: function () { return spec.createdAt || new Date('2026-07-20T10:00:00Z'); },
    isTrashed: function () { return !!spec.trashed; },
    setName: function (n) { spec.name = n; return api; },
    setTrashed: function (v) { spec.trashed = !!v; return api; },
    moveTo: function (folder) { spec.movedTo = folder; return api; },
    getBlob: function () {
      spec.blobRead = true; // 讀成 blob 代表「整個檔案進記憶體」,大檔案要避免
      return { getName: function () { return spec.name; }, setName: function (n) { spec.name = n; } };
    },
    _spec: spec
  };
  return api;
}

/** 假的 Google 文件,記錄 writeNoteBlocks 實際寫了什麼,供斷言用 */
function makeDocument(id) {
  const paragraphs = [];

  function makeParagraph() {
    const state = { heading: null, text: '', ops: [] };
    const textApi = {
      setText: function (t) { state.text = t; return textApi; },
      insertText: function (offset, t) {
        state.text = state.text.slice(0, offset) + t + state.text.slice(offset);
        return textApi;
      },
      setBold: function (a, b, v) { state.ops.push(['bold', a, b, v]); return textApi; },
      setItalic: function (a, b, v) { state.ops.push(['italic', a, b, v]); return textApi; },
      setBackgroundColor: function (a, b, v) { state.ops.push(['bg', a, b, v]); return textApi; },
      setForegroundColor: function (a, b, v) { state.ops.push(['fg', a, b, v]); return textApi; }
    };
    return {
      _state: state,
      setHeading: function (h) { state.heading = h; return this; },
      editAsText: function () { return textApi; }
    };
  }

  const body = {
    clear: function () { paragraphs.length = 0; paragraphs.push(makeParagraph()); return body; },
    appendParagraph: function () {
      const para = makeParagraph();
      paragraphs.push(para);
      return para;
    },
    getNumChildren: function () { return paragraphs.length; },
    getChild: function (i) { return paragraphs[i]; },
    removeChild: function (child) {
      const i = paragraphs.indexOf(child);
      if (i >= 0) paragraphs.splice(i, 1);
      return body;
    }
  };

  return {
    _paragraphs: paragraphs,
    getId: function () { return id; },
    getBody: function () { return body; },
    saveAndClose: function () {},
    dump: function () {
      return paragraphs.map(function (p) { return p._state; });
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
        setValue: function (v) {
          const target = rows[row - 2] || (rows[row - 2] = []);
          target[col - 1] = v;
        },
        setValues: function (values) {
          values.forEach(function (r, i) {
            const target = rows[row - 2 + i] || (rows[row - 2 + i] = []);
            r.forEach(function (v, j) { target[col - 1 + j] = v; });
          });
        }
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
      // 要真的照格式字串輸出,否則像「筆記_年月日_課程」這種用多次 formatDate 組出來的
      // 檔名會變成一坨相同字串,測試就測不到真正的命名規則了
      formatDate: function (date, tz, pattern) {
        const d = date instanceof Date ? date : new Date(date);
        const pad = function (n) { return String(n).padStart(2, '0'); };
        return String(pattern)
          .replace(/yyyy/g, String(d.getFullYear()))
          .replace(/MM/g, pad(d.getMonth() + 1))
          .replace(/dd/g, pad(d.getDate()))
          .replace(/HH/g, pad(d.getHours()))
          .replace(/mm/g, pad(d.getMinutes()));
      },
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
  makeFile: makeFile,
  makeDocument: makeDocument,
  makeProps: makeProps,
  makeSheet: makeSheet,
  makeUrlFetchApp: makeUrlFetchApp,
  iterator: iterator
};
