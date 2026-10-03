// Caches the app shell so it opens offline. Data always comes from api.github.com
// (never cached here); unsynced writes wait in the IndexedDB outbox.
const VERSION = "fitlog-v14"; // keep in step with APP_VERSION in js/app.js
const SHELL = [
  "./", "index.html", "styles.css", "manifest.webmanifest", "icon.svg", "icon-192.png",
  "js/app.js", "js/github.js", "js/outbox.js", "js/totals.js",
  "vendor/js-yaml.min.js", "vendor/chart.umd.min.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first (so updates show up right away), cache as the offline fallback.
// cache: "no-cache" revalidates with the server instead of trusting the browser's HTTP
// cache (GitHub Pages allows 10 minutes), so a new deploy is picked up on the next open.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request.url, { cache: "no-cache", credentials: "same-origin" })
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("index.html"))),
  );
});
