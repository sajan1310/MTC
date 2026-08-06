# Performance Audit — Phase 6 (Frontend & Delivery)

Backend query performance is covered separately in `SQL_OPTIMIZATION.md`;
Python-layer performance in `PYTHON_BACKEND_REVIEW.md`.

> **Caveat.** No Lighthouse run, RUM data, or production profiling was available.
> Every number below is *measured from the artifacts* (byte counts, request
> counts, call-graph analysis) — not from a browser trace. Projected Core Web
> Vitals impacts are reasoned from those measurements and marked as projections.
> PERF-009 recommends the instrumentation needed to replace projection with fact.

---

## Findings

| ID | Title | Severity | Priority | Projected gain |
|---|---|---|---|---|
| PERF-001 | 1.10 MiB of unbundled, unminified JS in 17 blocking requests | Critical | P0 | LCP/TTI −60–75% |
| PERF-002 | Zero server-side pagination — every read returns whole tables | Critical | P0 | TTFB, payload, scaling |
| PERF-003 | Tab switch triggers full re-fetch; no client cache | Critical | P0 | INP, perceived speed |
| PERF-004 | All 12 module DOMs mounted simultaneously | High | P1 | DOM size, memory, CLS |
| PERF-005 | 360 `innerHTML` full-table rebuilds; no diffing or virtualisation | High | P1 | INP on filter/sort |
| PERF-006 | 6 render-blocking CDN requests before first paint | High | P1 | FCP −300–600 ms |
| PERF-007 | No compression/caching/versioning policy for static assets | High | P1 | Repeat-visit load |
| PERF-008 | Rate limiter fully exempt on the only data endpoint | Medium | P2 | Resilience |
| PERF-009 | No performance instrumentation or budget | High (process) | P1 | Prevents regression |
| PERF-010 | Event-listener accumulation risk on re-render | Medium | P2 | Long-session memory |

---

## PERF-001 · 1.10 MiB of unbundled, unminified JavaScript in 17 blocking requests
**Location** `templates/erp/index.html:332-351` · **Severity** Critical · **Priority** P0

**Measured payload** (uncompressed, exactly as served — no build step exists):

| File | Bytes | | File | Bytes |
|---|---:|---|---|---:|
| `production.js` | 272,750 | | `dispatch.js` | 54,084 |
| `stock.js` | 110,878 | | `return.js` | 50,888 |
| `items.js` | 107,826 | | `client.js` | 50,605 |
| `process.js` | 107,723 | | `vendors.js` | 31,451 |
| `bill.js` | 74,129 | | `issue.js` | 25,905 |
| `core.js` | 74,067 | | `contractor.js` | 24,455 |
| `bom.js` | 69,864 | | `dashboard.js` | 20,295 |
| `po.js` | 58,764 | | `print.js` | 10,847 |
| | | | `api.js` | 9,053 |
| | | | **TOTAL** | **1,153,584 (1.10 MiB)** |

Plus `styles.css` at 86,525 bytes and six CDN requests (PERF-006).

**Current behaviour.** All 17 scripts are classic `<script>` tags with no
`defer`, no `async`, no `type="module"`. The HTML parser blocks on each in
sequence. Every one executes at load and registers its module on the global
`App` object — including `production.js` (272 KB, 5,441 lines) which is needed
only when the user opens the Production tab.

There is **no bundler, no minifier, no tree-shaking, no code-splitting, no
source maps.** `package.json` exists for tests only.

**Projected impact.** Minification + gzip typically yields 70–80% reduction on
verbose commented source like this (the codebase is unusually comment-dense).
1.10 MiB → roughly 220–280 KB gzipped. Route-based splitting would put ~80 KB on
the initial path with the rest lazy-loaded.

**Expected behaviour.**
1. **Immediate, zero-risk:** add `defer` to all 17 tags. Order is preserved,
   parsing unblocks. **One-line change, meaningful FCP win.**
2. **Enable compression** (PERF-007) — brotli/gzip on `.js`/`.css`.
3. **Add a build step** (esbuild or Vite; esbuild is the lower-friction choice
   given there is no framework to accommodate). Minify + emit source maps.
4. **Lazy-load per tab.** `core.js:19` already defines a `loadScript(src)`
   helper — the mechanism exists and is unused for this. Wire it into
   `App.Navigation.showTab()` so a module loads on first visit to its tab.

**UX impact** First load is the user's first impression of "is this software
fast". **Business impact** Directly shapes the "premium" perception the project
is targeting. **Effort** Step 1: minutes. Steps 2–3: S (2–3 d). Step 4: M (1 wk).
**Dependencies** none for steps 1–3. **Risk** Low — `defer` preserves execution
order; lazy-loading needs care where modules read each other's globals at load.

---

## PERF-002 · Zero server-side pagination
**Location** all `app/erp/services/*.py` · **Severity** Critical · **Priority** P0

**Measured.** **390 `.execute()` calls** in the service layer contain **one
`LIMIT`** (`ledger_audit_service.py:309`). No `getXData` method accepts
`limit`, `offset`, `page`, `sort` or `filter` parameters. `get_po_data()`
(`po_service.py:299-303`) is representative:

```python
@rpc_method("getPOData")
def get_po_data():
    with database.get_conn(...) as (_conn, cur):
        billed_map = bill_service._aggregate_billed_base_qty_by_po(cur)
        pos = _load_po_list(cur, billed_map)
    return build_response(True, pos)          # every PO, ever
```

Meanwhile the client holds `poRowsPerPage: 15` (`core.js:139`) — it downloads
the entire table to display 15 rows.

**Current behaviour.** Payload, DB work, JSON serialisation cost and client
memory all grow linearly and without bound. The application is **performant
today and structurally guaranteed to degrade.** At 500 POs this is invisible; at
50,000 it is an outage. Nothing in the code caps it.

**Expected behaviour.** Extend the read methods to accept a params object and
return `{rows, total, page}`:

```python
@rpc_method("getPOData")
def get_po_data(params=None):
    p = _page_params(params)      # limit/offset/sort/filter, allowlisted
    ...
    return build_response(True, {"rows": rows, "total": total})
```

Because RPC args are positional (`rpc.py:50`, `spec.func(*args)`), an **optional
trailing parameter is backwards-compatible** — existing zero-arg calls keep
working while modules migrate one at a time. That makes this a low-risk
incremental change despite its breadth.

Priority order by table growth rate: `getProductionData`, `getStockData`,
`getBillData`, `getPOData`, `getItemsData`, `getDispatchData`.

**Effort** L (3–4 wk for all six + client migration), but shippable per module.
**Dependencies** sort/filter must be allowlisted server-side (never interpolate
a client-supplied column name — see `SQL_OPTIMIZATION.md` SQL-003).
**Business impact** Removes the scaling ceiling. This is the item that decides
whether the product survives data growth.

---

## PERF-003 · Tab switch triggers a full re-fetch; no client cache
**Location** `static/erp/core.js:1387-1414` · **Severity** Critical · **Priority** P0

`App.Navigation.showTab()` unconditionally calls each module's `loadData()`.
There is no cache, no TTL, no ETag/`If-None-Match`, no in-flight request
de-duplication. PO → Bill → PO downloads the PO table twice.

Combined with PERF-002 (whole tables) and UX-004 (no loading indicator), each
tab switch is: click → frozen UI → data appears.

**Expected behaviour.** A stale-while-revalidate cache inside `api.js`:

```js
const _cache = new Map();  // key: method + JSON.stringify(args)
async function cachedCall(method, args, {ttl = 30_000} = {}) {
  const key = method + JSON.stringify(args);
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;      // fresh
  if (hit?.inflight) return hit.inflight;                       // dedupe
  const p = _request(method, args, null).then(v => {
    _cache.set(key, {value: v, at: Date.now()});
    return v;
  });
  _cache.set(key, {...hit, inflight: p});
  return hit ? hit.value : p;      // serve stale immediately, revalidate behind
}
```
Mutations invalidate by prefix (`saveBill` → drop `getBillData`, `getPOData`).

**This is the single highest value-per-hour performance change available.** It is
~60 lines in one file, requires no backend change, and makes repeat tab switches
instant. **Effort** S (2–3 d including invalidation mapping). **Do it first.**

---

## PERF-004 · All 12 module DOMs are mounted simultaneously
**Location** `templates/erp/index.html:300-311` · **Severity** High · **Priority** P1

Every feature partial is server-rendered into one document:

```jinja
{% include "erp/partials/dashboard.html" %}   {# 361 ln #}
{% include "erp/partials/production.html" %}  {# 604 ln #}
{% include "erp/partials/stock.html" %}       {# 641 ln #}
… 12 partials, 3,741 lines total
{% include "erp/partials/print.html" %}       {# 1,181 ln, 414 inline styles #}
```

Visibility is toggled with `display: none` (`core.js:1389`) — **the nodes remain
in the DOM, are styled, and are matched by every CSS selector and
`querySelectorAll`.** Total server-rendered markup is ~4,900 lines before any
data rows are added, and each of the 11 hidden tabs also holds its modals,
toolbars and empty tables.

**Consequences:** oversized initial DOM (a documented Lighthouse penalty);
style recalculation cost scales with hidden nodes; `$$('.tab-content')`
(`core.js:1388`) and similar global queries traverse everything; hidden tables
still hold their rendered rows in memory after their first load.

**Expected behaviour.** Render only the Dashboard shell server-side; fetch other
partials on first tab visit (a `GET /erp/partial/<tab>` route) and cache the
node. Pairs naturally with PERF-001 step 4 — load the partial and its script
together on first visit.
**Effort** M (1–2 wk) · **Depends on** PERF-001 lazy-loading

---

## PERF-005 · Full-table `innerHTML` rebuilds; no diffing, no virtualisation
**Severity** High · **Priority** P1

**Measured: 360 `innerHTML` assignments** across the JS modules
(`mobile.js` 50, `production.js` 47, `stock.js` 46, `items.js` 37, `process.js` 25, …).

The rendering model throughout is: filter the array in `App.State` → build one
large HTML string → assign to `container.innerHTML`. Every keystroke in a search
box, every sort click, every page change destroys and recreates the entire table
subtree.

Costs: full parse + layout + paint per interaction; all row event listeners
destroyed and recreated (PERF-010); scroll position, focus and text selection
lost mid-interaction; **only 7 debounce sites** across the frontend, so most
search inputs re-render on every keypress.

There is no virtualisation, so once PERF-002 is *not* in place a 5,000-row
result set renders 5,000 live DOM rows.

**Expected behaviour.**
1. **Debounce all search inputs** at 200–250 ms — smallest change, largest
   immediate INP win.
2. **Render rows, not tables.** Keep `<thead>`/`<tbody>` stable; replace only
   `<tbody>`, or better, key rows by id and patch.
3. **Virtualise** any list that can exceed ~200 rows (render the visible window
   plus overscan).
4. **Delegate events** at the table level rather than per row — `core.js:1611`
   already demonstrates the `data-action` delegation pattern; extend it.

**Effort** Step 1: S (1 d). Steps 2–4: M–L, naturally absorbed by the DataTable
component. **Depends on** `COMPONENT_LIBRARY_PLAN.md` §DataTable

---

## PERF-006 · Six render-blocking third-party requests before first paint
**Location** `templates/erp/index.html:16-25` · **Severity** High · **Priority** P1

| Resource | Host | Blocking |
|---|---|---|
| Bootstrap 5.3.0 CSS | cdn.jsdelivr.net | yes |
| Bootstrap Icons 1.11.3 CSS (+ webfont) | cdn.jsdelivr.net | yes + font fetch |
| Select2 CSS | cdn.jsdelivr.net | yes |
| Select2 Bootstrap-5 theme CSS | cdn.jsdelivr.net | yes |
| Google Fonts CSS (Inter + Outfit, 7 weights) | fonts.googleapis.com | yes |
| jQuery 3.6 / Bootstrap JS / Select2 JS | code.jquery.com, jsdelivr | yes (body) |

Four separate CSS files from jsdelivr, each a round trip. `preconnect` is
correctly present for Google Fonts (`index.html:23-24`) — good — but **not** for
`cdn.jsdelivr.net` or `code.jquery.com`, which serve more bytes.

`display=swap` is correctly set on the font request. Seven font weights are
requested (`Inter:400,500,600,700` + `Outfit:500,600,700,800`); a typical UI
needs three or four.

**Also relevant:** jQuery is loaded solely as a Select2 dependency
(`index.html:19` states this). Select2 is the only jQuery consumer. Replacing
Select2 with a native combobox would remove ~115 KB (jQuery + Select2 + two
themes) and a third-party dependency from the critical path.

**Expected behaviour.**
1. Add `<link rel="preconnect">` for `cdn.jsdelivr.net` and `code.jquery.com`.
2. Self-host and subset fonts; cut to 3–4 weights.
3. Self-host Bootstrap/Icons/Select2 CSS and concatenate into one file — also
   removes three third-party hosts from the CSP allowlist (`app/__init__.py:427-446`),
   a security improvement.
4. Subset Bootstrap Icons to the glyphs actually used (currently the full
   ~1,900-icon webfont ships for ~40 icons).
5. Medium-term: retire Select2 → jQuery.

**Effort** Steps 1–2: S. Steps 3–4: M. Step 5: M.
**Security impact** Positive — fewer third-party origins, tighter CSP.

---

## PERF-007 · No compression, caching or versioning policy for static assets
**Severity** High · **Priority** P1

Flask serves `static/` with defaults. There is no evidence of gzip/brotli
configuration, no `Cache-Control` policy for app assets, and no content hashing.
Cache-busting is ad hoc and inconsistent — `index.html:335` has
`dashboard.js?v=6` while the other 16 scripts have no version parameter at all,
and the auth templates use `?v={{ config.VERSION }}`.

**Consequence:** repeat visitors may re-download 1.10 MiB, or worse, be served a
stale `production.js` after a deploy because it carries no version marker.

**Correctly handled already:** service workers are served `Cache-Control: no-cache`
with a documented rationale (`pages.py:44-46`, `:78`). That is exactly right.

**Expected behaviour.** Brotli + gzip on JS/CSS/JSON. Content-hashed filenames
(`core.a1b2c3.js`) with `Cache-Control: public, max-age=31536000, immutable`;
`no-cache` on HTML. Emitted by the build step from PERF-001.
**Effort** S once a build step exists. **Depends on** PERF-001

---

## PERF-008 · Rate limiter fully exempt on the only data endpoint
**Location** `app/__init__.py:530` — `limiter.exempt(erp_rpc_bp)` · **Severity** Medium · **Priority** P2

Global limits are `"200 per day, 50 per hour"` (`app/__init__.py:302`) — far too
low for a legitimate SPA session, which is presumably why the RPC blueprint was
exempted wholesale. The result is that **the endpoint carrying 100% of the
application's data traffic has no rate limiting at all**, while the login page
does.

**Both parts are wrong:** the default is unusable for an app, and the fix was to
disable rather than tune.

**Expected behaviour.** Remove the blanket exemption; apply a realistic
per-user limit sized to actual usage — e.g. `600/minute` for reads and a lower
ceiling for mutations, keyed on user id rather than IP (multiple factory users
share an egress IP, so `get_remote_address` would throttle them collectively).
Exempt genuinely high-frequency polling methods explicitly.

**Security impact** Positive — restores protection against runaway clients and
scripted abuse. **Performance impact** Protects the database from a client bug
looping on `getProductionData`. **Effort** S (1 d) + a week of observed usage
data to size the limits.

---

## PERF-009 · No performance instrumentation or budget
**Severity** High (process) · **Priority** P1

No RUM, no Core Web Vitals collection, no Lighthouse CI, no server-side timing
histograms, no slow-query log, no bundle-size gate. Every number in this report
is derived from static artifacts because **there is no measurement to consult.**

`scripts/db_explain.py` exists — a good foundation — but nothing runs it
routinely.

**Expected behaviour.**
1. `web-vitals` in the page, POSTing LCP/INP/CLS/TTFB to a `logPerf` RPC.
2. Per-RPC-method server timing (p50/p95/p99) into the existing logging setup
   (`logging_config.py`).
3. Lighthouse CI on `/erp` with an enforced budget.
4. Bundle-size gate failing the build above threshold.
5. Postgres `log_min_duration_statement = 200ms`.

**Suggested initial budget** (to be validated, not assumed):
JS ≤ 300 KB gz on the initial route · CSS ≤ 60 KB gz · LCP ≤ 2.5 s ·
INP ≤ 200 ms · CLS ≤ 0.1 · RPC p95 ≤ 400 ms.

**Effort** M (1 wk) · **This should be done alongside PERF-003, not after** —
otherwise there is no way to prove any of the other work helped.

---

## PERF-010 · Event-listener accumulation on re-render
**Severity** Medium · **Priority** P2

With 360 `innerHTML` rebuilds (PERF-005), listeners attached directly to
row-level elements are orphaned on each rebuild. Modern browsers GC listeners
whose nodes are unreachable, so this is not automatically a leak — **but** any
listener registered on a *persisting* node (`document`, `window`, a stable
container) inside a render function accumulates on every render.

Also relevant: `dashboard.js:24-36` sets a `setInterval` refresh. It is
correctly cleared in `stopAutoRefresh()` and correctly paused on
`visibilitychange` — **a good implementation.** The risk is that the same
discipline is not guaranteed in the other 16 modules.

**Expected behaviour.** Audit for `addEventListener` calls on stable nodes inside
render paths. Standardise on delegation at container level. Verify with a
long-session heap-snapshot comparison (open app, cycle all 11 tabs 20×, compare
listener counts).
**Effort** S to audit, M to remediate.

---

## Projected Core Web Vitals

Directional projections from the measurements above — **not browser-measured.**

| Metric | Likely today | After P0 (PERF-001/003 + defer/compress) | After full roadmap |
|---|---|---|---|
| **FCP** | Poor — 6 blocking CDN CSS + 17 blocking JS | Moderate improvement | Good |
| **LCP** | Poor — 1.10 MiB JS before content, no skeleton | Good | Good |
| **TTI** | Poor — 24,920 lines parsed and executed at load | Good | Good |
| **INP** | Poor — full `innerHTML` rebuild per keystroke, 7 debounces | Moderate (debounce) | Good (virtualised) |
| **CLS** | Likely acceptable — `#app-container` hidden until loaded (`index.html:47`) | — | — |
| **TTFB** | Acceptable now; degrades with row count (PERF-002) | — | Stable |

Note `index.html:47-48` hides `#app-container` until `.loaded` — this suppresses
layout shift (good for CLS) but *delays* LCP, since nothing paints until the app
initialises. With skeletons (UX-004) this trade could be reversed to improve both.

---

## Recommended order

| Order | Item | Effort | Why first |
|---|---|---|---|
| 1 | `defer` on 17 script tags | ~1 h | Free FCP win, zero risk |
| 2 | **PERF-003** SWR cache in `api.js` | 2–3 d | Best value-per-hour; frontend-only |
| 3 | **PERF-009** instrumentation | 1 wk | Must exist before further tuning |
| 4 | **PERF-007** compression + **PERF-001** build step | 2–3 d | ~75% payload cut |
| 5 | **PERF-005** step 1 — debounce searches | 1 d | Immediate INP win |
| 6 | **PERF-006** preconnect, self-host, subset | 1 wk | FCP |
| 7 | **PERF-002** server pagination, per module | 3–4 wk | Removes the scaling ceiling |
| 8 | **PERF-001** step 4 + **PERF-004** lazy tabs | 2 wk | Initial payload |
| 9 | **PERF-005** virtualisation, **PERF-008**, **PERF-010** | 2 wk | Depends on components |
