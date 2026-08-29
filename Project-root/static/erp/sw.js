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
//
// v32: core.js gained App.OfflinePassword -- the standing banner shown to an
// account created by Google sign-in that has never set a password. Without
// the bump an installed client keeps the old core.js and the banner never
// appears, which is the one warning those users get before an internet
// outage, or the move to the factory LAN, locks them out entirely.
// v33: the offline-password banner gained a dismiss button, and the profile
// modal now hides the Current Password field for an account that has none
// (App.Profile.applyPasswordMode). Both live in core.js, which is precached
// cache-first, so an installed client would otherwise keep a banner it
// cannot close and a field it cannot fill in.
// v34: that banner is now pinned to the top rather than sitting in the
// document above a sticky header, where the app scrolling itself down to the
// restored tab carried it off the screen on every single load -- it was only
// ever visible if you happened to scroll back to the very top. styles.css is
// precached too, and the fix needs both files.
// v36: core.js gained the Activity Log tab's load branch and its four
// delegated actions (AUDIT-001). core.js is precached and served
// cache-first, so without the bump an installed admin client keeps the old
// copy: the sidebar entry renders from the server-side template and is
// therefore present, but showTab has no branch for it and the four
// data-action handlers do not exist -- the tab opens empty and its buttons
// do nothing. activity.js itself is deliberately NOT precached, for the same
// reason users.js is not: it is admin-only, and the fetch handler caches it
// on demand on the first admin visit.
// v37: production.js fixes the Create/Edit Production Lot form's Color
// Sub-Group columns (every cell scaled to 0, the column pruned away when its
// name repeated a checked color's, and the bucket's own words deleted out of
// its items' names), and core.js stops the record-nav shortcut throwing on a
// synthetic keydown that carries no `key`. Both are precached and served
// cache-first, so without the bump an installed client keeps running the old
// copy no matter how many times the server restarts or the page is reloaded
// -- which is exactly how the sub-group fixes first appeared to have had no
// effect at all.
// v38: production.js's POOL item pickers now list live Warehouse Pool
// BUCKETS (item + color + available qty) instead of bare item names, and
// carry the picked bucket through to the saved component as poolColor.
// Precached and cache-first, so without the bump an installed client keeps
// picking bare item names and silently attributes every off-color pool
// draw to the lot's own color.
// v39: the Production Sheet's per-colour cells now print the Warehouse
// Pool bucket a POOL component was drawn from, which is the one row on the
// sheet whose colour was never evident from its own name.
// v40: the WIP pipeline splits Pending from In Progress and gains a
// per-stage stacked column chart. dashboard.js and styles.css are both
// precached, and v39 has already shipped, so they need their own bump.
// v41: narration is a derived, read-only projection of Items Master --
// production.js and process.js stop treating it as identity or as an input
// on an ITEM row, and resolve it live instead of falling back to a stale
// stored copy. Both are precached.
// v42: the WIP pipeline's ranked lists became card grids. dashboard.js and
// styles.css are both precached, and v41 has already been committed.
// v43: the Users tab gained Super Admin-only bulk deactivation. This is the
// v36 failure mode exactly, and it was reported as "there's no deactivate
// bulk button when multiple selections are done": navigations are
// network-first, so the SERVER-rendered half of the feature arrives fresh --
// the header select-all checkbox and the Deactivate Selected button are both
// in the DOM -- while /static/erp/* is cache-first and never revalidated, so
// users.js is still the old copy with no per-row checkbox cell and no
// toggleSelectAll/onRowSelectChange/bulkDeactivate at all. The two halves of
// this feature come from two different renderers, and only the cached half
// went stale. core.js also changed (App.State.selectedUsers) and IS
// precached.
// v44: five Warehouse Pool fixes, all in stock.js. The ledger now resolves
// each lot's bucket through its Process (a per-lot output item name no
// longer hides the lot), matches COMPOSITE bucket colours by segment on
// both the credit and the debit leg, credits a lot to its composite bucket
// OR its bare-colour one but never both, and stops counting every manual
// correction twice (it was read from warehouse_pool_opening AND from the
// warehouse_pool_adjustments audit row that records the same event). The
// pool table also surfaces buckets stranded on a deleted process, which it
// previously rendered nowhere at all, and flags debit-only buckets apart
// from genuine shortfalls.
//
// The ledger itself then moved SERVER-side (getWarehousePoolLedger), which
// is what makes those five fixes the last of their kind: the browser no
// longer reimplements the pool's arithmetic, it renders the events the
// rebuild emits, so the closing balance equals Available Qty by
// construction rather than by two implementations agreeing. Verified
// against live data -- 1327 of 1327 buckets reconcile, where the best the
// client-side version reached was 700 of 758. stock.js is precached and
// cache-first, so without the bump an installed client keeps its own copy
// of the old ledger and calls none of this -- which would read as the
// fixes having had no effect.
// v45: the ledger modal rendered a REFUSED request as "No transaction
// history found for this bucket" -- {success:false} was folded into an
// empty list -- so a bucket with 19 real movements looked empty and the
// actual cause (a server predating getWarehousePoolLedger) stayed hidden.
// A refused call now surfaces its message with a retry.
// v46: /static/erp/ is stale-while-revalidate rather than cache-first with
// no revalidation, so a cached asset is refreshed by the next load instead
// of persisting until a CACHE_NAME bump wipes it. Four entries in this log
// (v32, v36, v37, v43) are the same incident -- a fix that shipped and had
// no effect because installed clients never refetched the file -- and the
// v44/v45 round hit it a fifth time. Bumps still matter for same-load
// delivery; this bounds a missed one to a single stale load.
const CACHE_NAME = 'erp-shell-v46';

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

// The offline shell is useless without these two: the page the fetch handler
// falls back to, and the stylesheet that makes it legible. Everything else in
// PRECACHE_URLS is an optimisation -- absent from the cache, the fetch handler
// simply fetches it on demand and caches it then.
const CRITICAL_URLS = ['/erp/offline.html', '/static/erp/styles.css'];

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
      console.warn('[sw] precache failed:', url, error && error.message);
      throw error;
    }))
  ).then(results => {
    const failed = PRECACHE_URLS.filter((_url, i) => results[i].status === 'rejected');
    if (failed.length) {
      console.warn(`[sw] ${failed.length}/${PRECACHE_URLS.length} assets not precached`);
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
      fetch(req).catch(() => caches.match('/erp/offline.html'))
    );
    return;
  }

  // Same-origin static shell assets: STALE-WHILE-REVALIDATE. Serve the
  // cached copy immediately (so the shell still opens instantly and still
  // works offline), and refetch in the background every time so the cache
  // holds the current file by the next load.
  //
  // This was cache-first with NO revalidation, which meant an installed
  // client kept its copy of every /static/erp/ file indefinitely -- the only
  // thing that could dislodge it was a CACHE_NAME bump wiping the old cache.
  // A bump that was forgotten, or that landed in the same commit as the code
  // it was meant to ship, therefore stranded users on old JavaScript with no
  // way back short of unregistering the worker by hand. That is not a
  // hypothetical: v32, v36, v37 and v43 in the log below are all the same
  // incident, and the v44/v45 round hit it again -- a Warehouse Pool ledger
  // that had been fixed and verified server-side still rendered empty in the
  // browser, because the browser was running neither the old file nor the
  // new one but a cached copy from in between.
  //
  // Revalidating does NOT make the bump optional: the current load is still
  // served from cache, so a bump is what makes a fix land in the same load
  // rather than the one after. What it does is bound the damage -- a missed
  // bump now costs one stale load instead of stranding an installed client
  // indefinitely.
  const url = new URL(req.url);
  if (url.origin === self.location.origin && url.pathname.startsWith('/static/erp/')) {
    event.respondWith(
      caches.match(req).then(cached => {
        const revalidated = fetch(req).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
          }
          return res;
        });

        if (!cached) return revalidated;

        // Hold the worker alive until the refetch settles. Without this the
        // browser may terminate the SW as soon as the cached response is
        // returned, and the update it was the whole point of never lands.
        // The catch keeps a failed revalidation (offline, server down) from
        // rejecting waitUntil -- serving the cached copy is the correct
        // outcome there, not an error.
        event.waitUntil(revalidated.catch(() => {}));
        return cached;
      })
    );
    return;
  }

  // Everything else (RPC endpoints, third-party CDN assets, other app
  // routes) -- let the browser handle it normally, untouched.
});
