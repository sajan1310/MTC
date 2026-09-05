// Service worker for the mobile ERP shell. Served at /erp/mobile/sw.js
// (see app/erp/pages.py's mobile_service_worker route) so its default
// scope covers /erp/mobile/*.
//
// A separate script from sw.js (the desktop shell's own worker) --
// precaches only the mobile-specific static assets (mobile.js/
// mobile_styles.css/icons + api.js, shared with desktop), never
// desktop's module bundle (po.js/bill.js/stock.js/...), which the
// mobile shell never loads.
//
// Phase 6 Item 4 (Background Sync): also imports offline-cache.js and
// api.js (both already precached above, and both plain classic scripts
// with no `document` dependency at load time -- api.js only touches
// `document` lazily, inside _csrfToken(), guarded for exactly this
// context) so a 'sync' event can replay the outbox without any page
// open. This does NOT import mobile.js itself -- that file is full of
// DOM/UI code that assumes a live page and would throw immediately in
// a worker.
importScripts('/static/erp/offline-cache.js', '/static/erp/api.js');

const CACHE_NAME = 'erp-mobile-shell-v9';


const PRECACHE_URLS = [
  '/erp/mobile/offline.html',
  '/static/erp/api.js',
  '/static/erp/offline-cache.js',
  '/static/erp/mobile.js',
  '/static/erp/mobile_styles.css',
  '/static/erp/icons/icon-192.png',
  '/static/erp/icons/icon-512.png'
];

// The offline shell is useless without these two: the page the fetch handler
// falls back to, and the stylesheet that makes it legible. Everything else in
// PRECACHE_URLS is an optimisation -- absent from the cache, the fetch handler
// simply fetches it on demand and caches it then.
const CRITICAL_URLS = ['/erp/mobile/offline.html', '/static/erp/mobile_styles.css'];

// One request per URL instead of cache.addAll (REL-002).
//
// addAll is atomic: a single 404, a single dropped connection, and the whole
// promise rejects, install fails, and the service worker never activates --
// so the app has NO offline support at all. Silently, because nothing
// surfaces a failed install to the user, and intermittently, because it
// depends on the network at the moment of install. With ~45 URLs in the list
// the chance of one failing is not small, and the failure mode is total.
//
// allSettled instead, so one missing font costs that font rather than the
// entire offline shell. The critical few are then checked explicitly: if
// THOSE failed there is nothing worth activating, and rejecting lets the
// browser retry the install later rather than leaving a worker in place that
// cannot do its job.
function precache(cache) {
  return Promise.allSettled(
    PRECACHE_URLS.map(url => cache.add(url).catch(error => {
      console.warn('[mobile-sw] precache failed:', url, error && error.message);
      throw error;
    }))
  ).then(results => {
    const failed = PRECACHE_URLS.filter((_url, i) => results[i].status === 'rejected');
    if (failed.length) {
      console.warn(`[mobile-sw] ${failed.length}/${PRECACHE_URLS.length} assets not precached`);
    }
    const missingCritical = failed.filter(url => CRITICAL_URLS.includes(url));
    if (missingCritical.length) {
      throw new Error('critical assets missing from precache: ' + missingCritical.join(', '));
    }
    return failed;
  });
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(precache)
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

// ── Background Sync (Phase 6 Item 4) ──────────────────────────────────
// The page hands over its CSRF token (it has a `document` to read the
// meta tag from; this worker doesn't) right after registering/activating
// this worker -- see mobile.js's MApp.Outbox._sendCsrfToken(). Stored via
// Api.setCsrfToken so _request() in the imported api.js picks it up on
// every call this worker makes.
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'csrf-token') {
    Api.setCsrfToken(event.data.token);
  }
});

// Fires once connectivity is back, possibly long after the page that
// queued the outbox entry has closed (mobile.js's
// MApp.Outbox.requestSync() arms this tag every time something is
// enqueued). Mirrors MApp.Outbox.flush()'s own loop -- same
// network-vs-HTTP error classification, same "one bad entry doesn't
// block the rest" behavior -- but reimplemented here rather than shared,
// since flush() also does DOM/toast work (MApp.Toast, MApp.Shell.current)
// that has no meaning in a worker with no page open.
self.addEventListener('sync', event => {
  if (event.tag === 'outbox-flush') {
    event.waitUntil(flushOutboxInBackground());
  }
});

async function flushOutboxInBackground() {
  const pending = await OfflineCache.outbox.listPending();
  for (const entry of pending) {
    let res;
    try {
      res = await Api.mutateWithId(entry.method, entry.mutationId, ...entry.args);
    } catch (err) {
      if (err && err.isNetworkError) {
        // Still offline -- stop here, leave the rest pending for the
        // next sync event (the browser will retry with backoff).
        return;
      }
      // A real HTTP-level failure (e.g. a CSRF token that went stale
      // while this page was closed) -- not safe to retry blindly.
      await OfflineCache.outbox.markFailed(entry.id, err.message);
      continue;
    }

    if (res && res.success) {
      await OfflineCache.outbox.markDone(entry.id);
    } else {
      await OfflineCache.outbox.markFailed(entry.id, res && res.message);
    }
  }

  // Let any open page(s) know, so an on-screen badge/list reflects this
  // background replay immediately instead of only on next visit/reload.
  const clientsList = await self.clients.matchAll({ type: 'window' });
  for (const client of clientsList) {
    client.postMessage({ type: 'outbox-flushed' });
  }
}
