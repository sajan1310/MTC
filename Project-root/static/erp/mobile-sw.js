// Service worker for the mobile ERP shell. Served at /erp/mobile/sw.js
// (see app/erp/pages.py's mobile_service_worker route) so its default
// scope covers /erp/mobile/*.
//
// A separate script from sw.js (the desktop shell's own worker) --
// precaches only the mobile-specific static assets (mobile.js/
// mobile_styles.css/icons + api.js, shared with desktop), never
// desktop's module bundle (po.js/bill.js/stock.js/...), which the
// mobile shell never loads. Same narrow Phase-5-installability scope as
// the desktop worker: not the offline-with-sync system (Phase 6).

const CACHE_NAME = 'erp-mobile-shell-v2';

const PRECACHE_URLS = [
  '/erp/mobile/offline.html',
  '/static/erp/api.js',
  '/static/erp/offline-cache.js',
  '/static/erp/mobile.js',
  '/static/erp/mobile_styles.css',
  '/static/erp/icons/icon-192.png',
  '/static/erp/icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;

  // Never intercept mutations or RPC calls -- ERP data is always live.
  if (req.method !== 'GET') return;

  // Full-page navigations: network-first, fall back to the cached
  // offline page only when the network is genuinely unreachable.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/erp/mobile/offline.html'))
    );
    return;
  }

  // Same-origin static shell assets: cache-first, filling in anything
  // not already precached.
  const url = new URL(req.url);
  if (url.origin === self.location.origin && url.pathname.startsWith('/static/erp/')) {
    event.respondWith(
      caches.match(req).then(cached => {
        if (cached) return cached;
        return fetch(req).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
          }
          return res;
        });
      })
    );
    return;
  }

  // Everything else (RPC endpoints, third-party CDN assets, other app
  // routes) -- let the browser handle it normally, untouched.
});
