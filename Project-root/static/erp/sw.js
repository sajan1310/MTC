// Service worker for the desktop ERP shell. Served at /erp/sw.js (see
// app/erp/pages.py's service_worker route) so its default scope covers
// /erp/*.
//
// Deliberately narrow scope for this round (Phase 5: PWA installability),
// per the project roadmap -- this is NOT the offline-with-sync system
// (that's Phase 6: IndexedDB read model, outbox/replay, conflict
// resolution). All this does is:
//   1. Make the app installable (a fetch handler + a manifest are both
//      required for Chrome/Lighthouse's installability criteria).
//   2. Precache the static shell assets (JS/CSS/icons) so they load
//      instantly on repeat visits.
//   3. Show a friendly offline.html instead of the browser's default
//      offline error page when a navigation fails with no network.
// RPC calls and any other dynamic/authenticated request are always
// network-only and never touched by this worker -- ERP data must never
// be served stale from a cache.

// v21: the 946 KB html2pdf bundle is gone, along with the post-activate
// warm step that existed solely to have it available offline. PDF export is
// now the browser's own print engine, which needs nothing cached. Installed
// workers must re-fetch so the stale bundle is evicted with the old cache.
//
// v22: styles.css and production.js changed (Per-Color Components table).
// Both are precached and served cache-first, so an already-installed worker
// would go on serving the old copies indefinitely -- a shell asset edit is
// only actually deployed once this name changes.
const CACHE_NAME = 'erp-shell-v22';

const PRECACHE_URLS = [
  '/erp/offline.html',
  '/static/erp/styles.css',
  '/static/erp/api.js',
  '/static/erp/core.js',
  '/static/erp/print.js',
  '/static/erp/dashboard.js',
  '/static/erp/vendors.js',
  '/static/erp/items.js',
  '/static/erp/po.js',
  '/static/erp/bill.js',
  '/static/erp/return.js',
  '/static/erp/stock.js',
  '/static/erp/process.js',
  '/static/erp/bom.js',
  '/static/erp/contractor.js',
  '/static/erp/production.js',
  '/static/erp/issue.js',
  '/static/erp/client.js',
  '/static/erp/dispatch.js',
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
      fetch(req).catch(() => caches.match('/erp/offline.html'))
    );
    return;
  }

  // Same-origin static shell assets: cache-first, filling in anything
  // not already precached (e.g. a JS file added after this SW installed).
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
