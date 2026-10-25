/* Service worker Meteo Plotiště: aplikácia sa otvorí aj bez signálu.
 * Vlastné súbory a dáta: najprv sieť, pri výpadku posledná uložená verzia.
 * Knižnice a písma z CDN: z cache (nemenia sa). Radarové dlaždice sa neukladajú. */
const VERSION = 'mp-v2';
const SHELL = ['./', 'index.html', 'assets/style.css', 'assets/app.js', 'assets/europe-geo.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname.includes('tilecache.rainviewer.com') || url.hostname.includes('eumetsat.int')) return; // radar a blesky – len naživo
  const cdn = /cdnjs\.cloudflare\.com|fonts\.(googleapis|gstatic)\.com/.test(url.hostname);
  if (cdn) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); return res;
    })));
    return;
  }
  // vlastné súbory, data/*.json a API počasia: sieť, pri výpadku cache
  e.respondWith(fetch(req).then((res) => {
    if (res.ok && (url.origin === location.origin || url.hostname.endsWith('open-meteo.com'))) {
      const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy));
    }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: url.origin === location.origin }).then((hit) => hit || Response.error())));
});
