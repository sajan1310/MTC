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
//
// v23: both changed again -- the per-color tables now compute their column
// widths and carry resize handles.
//
// v24: the fit now re-runs when the form becomes visible, which is the
// only moment an edited lot's table has a width to be fitted to.
//
// v25: the fit fills the form exactly instead of stopping at each
// column's max and leaving a band of dead space.
//
// v26: jQuery, Bootstrap, Bootstrap Icons, Select2, htm/preact, SortableJS,
// Chart.js and the webfonts moved out of the CDNs into static/erp/vendor/
// and joined the precache. Installed workers must re-fetch so the old shell,
// which points at cdn.jsdelivr.net and code.jquery.com, is evicted.
//
// v27: production.js changed twice -- the printed production sheet drops its
// Size and Narration columns, and item names now render on one line. Both
// are print-only changes with no visible effect in the app, which is exactly
// the kind of edit it is easy to ship without bumping this name and then
// wonder why the tablets still print the old layout.
//
// v28: production.js gained Pass 4 of the Per-Color Components row
// reconstruction -- rows for one physical part named once per colour variant
// now consolidate against the Color Master. This changes what the Lot form
// and the printed sheet look like, so an installed worker serving the old
// production.js would keep showing the fragmented tables. production.js and
// styles.css changed again in the same round: a matrix whose colour columns
// are ALL empty no longer collapses them, and a collapsed strip's label is
// angled rather than stacked vertically. Then two quantity fixes on the
// colour checklist (a sole non-primary colour takes the lot total; a colour
// on both a counting and a non-counting axis is no longer double-counted)
// and the Color Group / Sub-Group suffix on each axis heading.
// v29: the Work Order PDF's colour columns declared percentage widths that
// were CONTENT widths, so each column added its own padding and border on top
// of its share and five columns ran off the right edge of the page. A
// print-only fix with no visible effect in the app -- precisely the kind this
// name exists to get onto the tablets.
// v30: a sequence-1 process (one that consumes a pool item and produces
// colours of its own) now renders BOTH groups as pickable Primary axes
// instead of defaulting the consumed item's axis to primary and dumping the
// output's own colours into the non-counting bucket.
// v31: Production Sheet print header rebuilt (output item under the title at
// title size, Date/Lot #/Lot Qty stacked top-right, colours full width under
// the brand) and the table typography changed -- Required Qty up ~10%, item
// names bold. Print-only, so nothing looks different in the app: exactly the
// case this name exists for.
const CACHE_NAME = 'erp-shell-v31';

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
  '/static/erp/icons/icon-512.png',

  // Third-party libraries, self-hosted under /static/erp/vendor/ so they are
  // precacheable at all. While these were loaded from cdn.jsdelivr.net and
  // code.jquery.com the fetch handler below skipped them (it only caches
  // same-origin /static/erp/ URLs), so they were never in the offline shell:
  // an offline or LAN-without-internet device fetched no jQuery, and with no
  // jQuery none of the app's JavaScript ran at all. The page was blank, and
  // only on the devices whose HTTP cache had gone cold.
  '/static/erp/vendor/bootstrap-5.3.0.min.css',
  '/static/erp/vendor/bootstrap-5.3.0.bundle.min.js',
  '/static/erp/vendor/bootstrap-icons-1.11.3.min.css',
  '/static/erp/vendor/select2-4.1.0.min.css',
  '/static/erp/vendor/select2-4.1.0.min.js',
  '/static/erp/vendor/select2-bootstrap-5-theme-1.3.0.min.css',
  '/static/erp/vendor/jquery-3.6.0.min.js',
  '/static/erp/vendor/htm-preact-3.1.1.standalone.umd.js',
  '/static/erp/vendor/sortable-1.15.7.complete.esm.js',
  '/static/erp/vendor/google-fonts.css',
  // Chart.js is lazy-loaded by dashboard.js, but the dashboard is the landing
  // tab, so it is wanted on essentially every session. xlsx (880 KB) is
  // deliberately absent -- see the note at its loadScript() call in stock.js.
  '/static/erp/vendor/chart-4.4.0.umd.min.js',

  // Font files the two CSS files above reference. woff2 only: every browser
  // that can run a service worker supports it, so precaching the .woff
  // fallback as well would add 176 KB to every install for nothing. The
  // .woff is still on disk and the fetch handler would cache it on demand.
  '/static/erp/vendor/fonts/bootstrap-icons.woff2',
  '/static/erp/vendor/fonts/inter-latin-1.woff2',
  '/static/erp/vendor/fonts/inter-latin-ext-0.woff2',
  '/static/erp/vendor/fonts/oswald-latin-3.woff2',
  '/static/erp/vendor/fonts/oswald-latin-ext-2.woff2',
  '/static/erp/vendor/fonts/outfit-latin-5.woff2',
  '/static/erp/vendor/fonts/outfit-latin-ext-4.woff2'
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
