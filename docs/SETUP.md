# 隨時資料庫 — 部署設定指南

跟著這份文件做,大概 20~30 分鐘可以全部弄好。分三部分:
**A. Apps Script 後端**(必做) → **B. PWA 拍照 App**(必做) → **C. iOS 捷徑**(另一份文件)。

---

## A. 部署 Apps Script 後端

### A-1. 建立專案

1. 打開 [script.google.com](https://script.google.com/) → 「新專案」
2. 專案名稱改成「隨時資料庫」(左上角,點一下標題就能改)

### A-2. 貼上程式碼

1. 左側檔案列表看到 `Code.gs`,把裡面內容全部刪掉,貼上 [apps-script/Code.gs](../apps-script/Code.gs) 的完整內容
2. 左側點齒輪圖示「專案設定」,勾選「在編輯器中顯示「appsscript.json」資訊清單檔案」
3. 回到編輯器,會多出 `appsscript.json` 檔案,把內容換成 [apps-script/appsscript.json](../apps-script/appsscript.json) 的內容
4. 上方「儲存專案」(Ctrl+S)

### A-3. 執行初次設定

1. 上方函式下拉選單選 `setup`,按「執行」
2. 第一次執行會跳出 Google 授權畫面:「這個應用程式未經 Google 驗證」→「進階」→「前往 隨時資料庫(不安全)」→ 全部允許
   - 這是正常的,因為是你自己的程式,不是第三方 App
3. 執行完成後,下方「執行記錄」會印出重要資訊,**把這幾行存到你的密碼管理工具或筆記(下一步 PWA 設定會用到)**:
   - 根資料夾網址
   - 索引表網址
   - **收件夾 ID**(iOS 捷徑會用到)
   - **PASS_KEY**(PWA 和捷徑都要填這組)

### A-4. 安裝自動掃描排程

1. 函式下拉選單改選 `installTriggers`,按「執行」
2. 執行記錄顯示「已安裝排程」即完成 — 之後收件夾裡的錄音檔會每 5 分鐘自動被歸檔一次

### A-5. 設定課程清單

1. 函式下拉選單改選 `setCourses`,**不要直接執行**,因為要先改參數
2. 改用「編輯器」直接在最下面暫時加一行測試呼叫,或是更簡單:上方選單「檢視 > 執行記錄」旁邊有個「執行」按鈕旁的下拉,選「setCourses」後點執行前,無法直接傳參數 — 最簡單做法是暫時修改 `setup()` 旁邊新增一個一次性函式:

   在 Code.gs 最下面暫時加入:
   ```js
   function _initCourses() {
     setCourses(['未分類', 'RAG課', 'Agent課']); // 改成你自己的課程名稱
   }
   ```
   存檔後執行 `_initCourses`,之後這個暫時函式可以刪掉不影響系統。
3. 之後想增減課程,同樣的方式改清單重跑就好(不用重新部署)

### A-6. 部署成網頁應用程式

1. 右上角「部署」→「新增部署作業」
2. 齒輪圖示選「網頁應用程式」
3. 說明填「v1」
4. **執行身分**:我(你的帳號)
5. **誰可以存取**:任何人 — 這一步務必選「任何人」,不然手機端呼叫不到
6. 「部署」→ 會再跳一次授權畫面,照 A-3 的方式允許
7. 完成後複製「網頁應用程式」網址,格式類似:
   `https://script.google.com/macros/s/AKfycb.../exec`
   **這就是 GAS_URL,PWA 設定要填這個**

   > 之後如果修改 Code.gs 想更新,要「管理部署作業」→ 編輯 → 版本選「新版本」→ 部署,網址會維持不變。

---

## B. 部署 PWA 拍照 App

PWA 就是 `pwa/` 資料夾,用 GitHub Pages 免費架設(跟你的屁孩特攻隊專案同一套做法)。

### B-1. 建 GitHub repo 並上傳

```bash
cd 隨時資料庫
git init
git add pwa docs apps-script
git commit -m "隨時資料庫初版"
git branch -M main
git remote add origin https://github.com/<你的帳號>/suishi-database.git
git push -u origin main
```

（沒有 repo 的話先到 GitHub 網站建一個新的 public repo，名字例如 `suishi-database`。）

### B-2. 開啟 GitHub Pages

1. repo 頁面 → Settings → Pages
2. Source 選「Deploy from a branch」
3. Branch 選 `main`,資料夾選 `/pwa`(注意不是 root,因為 PWA 檔案在子資料夾)
   - 如果 GitHub Pages 設定不給選子資料夾,改用 GitHub Actions 部署,或是把 `pwa/` 內容整個搬到 repo 根目錄再 push
4. 存檔後等 1~2 分鐘,會出現網址,例如:
   `https://<你的帳號>.github.io/suishi-database/`

### B-3. 手機上設定並加到主畫面

1. iPhone 用 Safari 打開上面那個網址
2. 點畫面最下面「連線設定」
3. 填入:
   - **Apps Script 網址**:A-6 拿到的 GAS_URL(結尾是 `/exec`)
   - **通行金鑰**:A-3 拿到的 PASS_KEY
4. 儲存後應該會看到課程按鈕出現(A-5 設定的清單)
5. 分享圖示(方框+箭頭)→「加入主畫面」→ 命名「隨時資料庫」→ 加入

之後就從主畫面圖示打開,跟原生 App 一樣,選課程、拍照即上傳。

### 驗證清單

- [ ] 打開 PWA,課程按鈕有正常出現(不是「載入中」卡住)
- [ ] 拍一張照片,幾秒後「最近上傳」出現「已上傳」
- [ ] 打開 Drive 的索引表,有新的一列資料
- [ ] 打開 Drive 資料夾,照片確實在 `隨時資料庫/年/月/照片/` 底下

如果卡在「排隊中」不會變「已上傳」,最常見原因是 PASS_KEY 或 GAS_URL 打錯,或是部署權限沒選「任何人」— 回頭檢查 A-6。

---

錄音的部分請接著看 [ios-shortcut-guide.md](./ios-shortcut-guide.md)。
