// Service worker: cache the app shell and CDN libraries; weather/geocoding APIs always go to the network.
// Bump VERSION together with the ?v= tags in index.html and the js imports.
const VERSION = 'rain-archive-v45';
const V = '?v=45';
const SHELL = [
  './',
  'index.html',
  `css/app.css${V}`,
  `js/app.js${V}`,
  `js/vars.js${V}`,
  `js/data.js${V}`,
  `js/charts.js${V}`,
  `js/rangebar.js${V}`,
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];
const CDN_HOSTS = ['cdn.jsdelivr.net'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Pinned CDN libraries never change: cache first.
  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return res;
      }))
    );
    return;
  }

  // App shell: network first, revalidating the browser's HTTP cache (GitHub Pages caches 10 min),
  // so a new page never runs with an old script. Cache is the offline fallback.
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req, { cache: 'no-cache' }).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req).then((hit) => hit || caches.match('index.html')))
    );
  }
  // Everything else (Open-Meteo, Nominatim, map tiles): default network behaviour.
});
