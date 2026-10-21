// 快取名稱改版時,舊的會在 activate 階段被整個刪掉。
// v2:之前的版本會連 Apps Script 的 API 回應一起快取(見下方 fetch 處理的說明),
// 換名字可以順便把那些不該留下的舊快取清乾淨。
const CACHE_NAME = 'suishi-db-v2';
const SHELL = ['./index.html', './manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// App shell 走「網路優先,失敗才用快取」,確保部署新版後能盡快吃到更新,
// 但離線時仍能把 App 本體打開(佇列上傳邏輯本身另外處理)。
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  // 只處理自己網站的靜態檔案。跟 Apps Script 後端溝通的 courses / listFiles /
  // searchFiles / podcastJobStatus 也都是 GET,但絕對不能快取:
  //   1. 離線時會回傳上次的舊資料、而且是 200,App 的離線處理完全不會觸發,
  //      畫面會顯示過期內容卻看起來像即時的
  //   2. 通行金鑰是放在查詢字串裡的,整個網址會連同金鑰一起被存進 Cache Storage
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
