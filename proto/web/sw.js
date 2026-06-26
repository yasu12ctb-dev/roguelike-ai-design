// Service Worker：アプリシェルをキャッシュして完全オフラインで遊べるようにする
// アプリ版数（src/web/main.ts の APP_VERSION と必ず同値に揃える）。版数を上げると旧キャッシュを破棄。
const CACHE = "sekitsui-0.53.0";
const ASSETS = ["./", "./index.html", "./app.js", "./manifest.webmanifest", "./icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// ネット優先・失敗時キャッシュ（更新が届きやすく、オフラインでも動く）
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        // 成功応答だけキャッシュ（404 等のエラーを掴んで残さない）
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((m) => m ?? caches.match("./index.html"))),
  );
});
