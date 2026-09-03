// Service Worker: ネットワーク優先、失敗時のみキャッシュ (オフライン起動用)
// オンライン時は常に最新版を取得してキャッシュを更新するため、更新遅延やキャッシュ腐敗が起きない

const CACHE_NAME = "guitar-practice-v9";
const ASSETS = [
  "./",
  "./index.html",
  "./pitch-shifter-worklet.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        // 取得成功: キャッシュを最新に更新してから返す
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() =>
        // オフライン: キャッシュから返す (ナビゲーションはindex.htmlへフォールバック)
        caches.match(e.request).then((hit) => hit || caches.match("./index.html"))
      )
  );
});
