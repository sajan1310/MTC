# HTML / CSS / JavaScript Review — Phase 8

Frontend code quality. Visual findings are in `UI_UX_AUDIT.md`; delivery
performance in `PERFORMANCE_AUDIT.md`; token architecture in `DESIGN_SYSTEM.md`.

---

## Measured baseline

| Metric | Value |
|---|---:|
| JS modules (desktop) | 17 files · 24,920 lines · 1,153,584 bytes |
| JS (mobile shell) | 1 file · 3,396 lines |
| Largest module | `production.js` — 5,441 lines · 272,750 bytes |
| CSS | `styles.css` 2,912 ln · `static/styles.css` 2,646 ln · `mobile_styles.css` 857 ln · `login.css` 414 ln |
| Templates | `index.html` 354 ln + 12 partials (3,741 ln) + `print.html` 1,181 ln |
| `innerHTML` assignments | 367 |
| Template-literal interpolations | ~997 |
| `escapeHtml()` calls | 776 |
| Inline `style=` attributes | 1,391 (977 outside `print.html`) |
| Inline `onclick=` in templates | 246 |
| `!important` | 143 |
| `keydown` listeners | 4 |
| Debounce sites | 7 |
| Loading indicators | 9 |
| Global state fields (`App.State`) | ~90 |

---

## Findings

| ID | Title | Severity | Priority |
|---|---|---|---|
| FE-001 | One flat mutable global holds all app state; 11 duplicated list machines | Critical | P0 |
| FE-002 | 246 inline `onclick` handlers + hundreds more in generated HTML | High | P1 |
| FE-003 | No module system — 17 scripts communicate via a global `App` object | High | P1 |
| FE-004 | 367 `innerHTML` sinks with opt-in escaping | High | P1 |
| FE-005 | `production.js` is 5,441 lines / 272 KB | High | P1 |
| FE-006 | No build pipeline, linting, or type checking for JS | High | P1 |
| FE-007 | Semantic HTML gaps: no landmarks, `<div>` used for controls | Medium | P2 |
| FE-008 | CSS has no methodology; selectors range from element to `#id .a .b` | Medium | P2 |
| FE-009 | Only 5 frontend tests, none covering rendering | Medium | P2 |
| FE-010 | Dead and orphaned code | Low | P3 |

---

## FE-001 · One flat mutable global holds all app state
**Location** `static/erp/core.js:124-298` · **Severity** Critical · **Priority** P0

`App.State` is a single object literal with **~90 fields** covering every module.
The core defect is that the same list-view state machine is **hand-copied 11
times**:

| Module | page | rowsPerPage | search | sort | selected | filtered | global |
|---|---|---|---|---|---|---|---|
| PO | `poCurrentPage` | `poRowsPerPage` | `poSearchTerm` | `poSortBy` | `selectedPOs` | `filteredPOs` | `globalPOs` |
| Bill | `billCurrentPage` | `billRowsPerPage` | `billSearchTerm` | `billSortBy` | `selectedBills` | `filteredBills` | `globalBills` |
| Return | `returnCurrentPage` | … | … | — | `selectedReturns` | `filteredReturns` | `globalReturns` |
| Wastage | `wastageCurrentPage` | … | … | — | `selectedWastage` | `filteredWastage` | `globalWastage` |
| Stock | `stockCurrentPage` | … | … | `stockDeadSortMode` | `selectedStock` | `filteredStock` | `globalStock` |
| Dispatch | `dispatchCurrentPage` | … | — | `dispatchSortBy` | `selectedDispatch` | `filteredDispatchBills` | `globalDispatch` |
| Client | `clientCurrentPage` | … | — | — | `selectedClients` | `filteredClients` | `globalClients` |
| Order | `orderCurrentPage` | … | — | — | `selectedOrders` | `filteredOrders` | `globalOrders` |
| BOM | `bomCurrentPage` | … | — | — | `selectedBOMs` | `filteredBOMs` | `globalBOMs` |
| Production | `productionCurrentPage` | … | `productionAllSearchTerm` | `productionSortBy` | `selectedProduction` | `filteredProduction` | `globalProduction` |
| Issue | `issueCurrentPage` | … | `issueSearchTerm` | — | `selectedIssues` | `filteredIssues` | `globalIssues` |

**Consequences.** Any fix to pagination, filtering or selection must be applied
11 times, and the table above shows it already has not been — Return, Client,
Order and BOM have no sort field; Dispatch has no search term. **The
inconsistency is not a design decision, it is drift.**

Additionally: no encapsulation (any module can mutate any other's state), no
change notification (render must be called manually — miss one call and the UI
silently desynchronises), no persistence, no serialisation to URL (UX-006), and
`globalX` arrays keep every row of every visited tab resident for the session.

**Expected behaviour.** One `ListViewController` factory owning the state machine:

```js
const poList = ListView({
  id: 'po',
  fetch: params => Api.call('getPOData', params),
  columns: [...],
  defaultSort: 'poNumberDesc',
  pageSize: 15,
});
```
Encapsulated state · `subscribe(fn)` for change notification · URL
serialisation built in · server-pagination-ready from day one so
`PERFORMANCE_AUDIT.md` PERF-002 needs no second pass.

**Migration.** Keep `App.State` as a deprecated read-through facade during the
transition (getters delegating to the controllers) so modules can migrate one at
a time without a flag day.

**Effort** L (4–6 wk, one module per PR) · **Depends on** DataTable
(`COMPONENT_LIBRARY_PLAN.md` #1) · **Removes an estimated 3,000–4,000 lines.**

---

## FE-002 · 246 inline `onclick` handlers in templates, plus hundreds in generated HTML
**Severity** High · **Priority** P1

| Template | `onclick` |
|---|---:|
| `production.html` | 40 |
| `mobile_views.html` | 31 |
| `products_processes.html` | 30 |
| `items.html` | 23 |
| `stock.html` | 19 |
| `return_ledger.html` | 16 |
| `po_ledger.html` | 15 |
| `clients.html` | 14 |
| others | 58 |

Plus a larger population inside JS template literals rendered via `innerHTML`.

**Four distinct problems.** (1) **Requires `'unsafe-inline'` in the CSP** — the
allowlist at `app/__init__.py:427-433` explicitly grants it, and it cannot be
removed until these are gone; that is the single biggest available CSP
hardening. (2) **Behaviour lives in markup**, unsearchable and unrefactorable.
(3) **Keyboard inaccessibility** when applied to `<div>`/`<td>`/`<span>`
(A11Y-005). (4) **Re-parsed on every `innerHTML` rebuild** (367 sites).

**The codebase already has the correct pattern.** `core.js:1611-1619` implements
`data-action` delegation:
```js
switch (btn.dataset.action) {
  case 'show-tab': App.Navigation.showTab(btn.dataset.tab); break;
}
```
And `dashboard.html:29` uses `data-action="show-tab"` correctly. **The fix is to
extend an existing, working pattern**, not invent one.

**Expected behaviour.** One delegated listener per view root; `data-action` +
`data-*` payload on real `<button>`/`<a>` elements. Then remove
`'unsafe-inline'` from `script-src`.

**Security impact** Enables a materially stronger CSP. **Effort** L (mechanical
but broad) — largely absorbed into DataTable and the per-view migrations.

---

## FE-003 · No module system — 17 scripts sharing a global
**Location** `templates/erp/index.html:332-351` · **Severity** High · **Priority** P1

All 17 scripts are classic `<script>` tags. Each attaches to the global `App`
object. Load order is load-bearing and documented only by a comment
(`index.html:331`: *"order matters, api.js/core.js define shared globals every
later file extends"*).

Consequences: no dependency graph, so nothing can be tree-shaken or lazily
loaded · no encapsulation — every function is global · circular dependencies are
invisible · the guarded-access idiom
(`if (typeof App.Dashboard !== 'undefined')`, `core.js:1395-1410`) exists solely
to tolerate load-order uncertainty · testing requires loading the whole global
graph.

**Expected behaviour.** ES modules with explicit imports, bundled by esbuild
(`PERFORMANCE_AUDIT.md` PERF-001). Convert leaf-first: `api.js` → `core.js`
helpers → feature modules. Keep `window.App` populated during migration so
inline `onclick` handlers (FE-002) keep working until they are removed.

**Effort** M (2–3 wk) · **Unblocks** lazy loading, tree-shaking, and real unit tests

---

## FE-004 · 367 `innerHTML` sinks with opt-in escaping
**Severity** High · **Priority** P1

**Measured:** 367 `innerHTML` assignments · ~997 template-literal interpolations
· **776 `escapeHtml()` calls.**

**Assessment, stated fairly:** escaping discipline here is **substantially
better than typical**. `escapeHtml()` (`api.js:127`) is correct, and a 776:997
ratio shows it is applied as a matter of routine, not an afterthought. This is
not a codebase that ignores XSS.

**The problem is that it is opt-in and unverifiable.** Not every interpolation
needs escaping (numbers, internally generated class names, already-escaped
fragments), so the gap between 776 and 997 is not 221 vulnerabilities. But
**there is no way to tell which of the remainder are safe**, no lint rule, and
no test. A single missed interpolation of a vendor name or item description —
both user-controlled and both rendered into tables — is a stored XSS.

The risk is amplified by two things: data flows in from `str(exc)` server
messages (`PYTHON_BACKEND_REVIEW.md` PY-001) which can echo user input, and the
CSP currently permits `'unsafe-inline'` (FE-002), so a successful injection is
not mitigated at the browser layer.

**Expected behaviour, in increasing order of assurance:**
1. **Escape-by-default tagged template**, so safety is the default rather than a
   remembered call:
   ```js
   const el = html`<td>${row.vendorName}</td>`;   // auto-escaped
   const el = html`<td>${raw(trustedFragment)}</td>`;  // explicit opt-out
   ```
2. **Build DOM nodes, not strings** in DataTable — `textContent` cannot inject.
   This eliminates the class of bug for the 75 tables, which is where nearly all
   user data is rendered.
3. **Lint rule** banning `innerHTML` outside an allowlist of reviewed helpers.
4. Remove `'unsafe-inline'` from CSP once FE-002 is done — defence in depth.

**Effort** S for the tagged template · absorbed into DataTable for (2)
**Security impact** Converts a discipline-based guarantee into a structural one.

---

## FE-005 · `production.js` is 5,441 lines / 272 KB
**Severity** High · **Priority** P1

24% of the entire JS payload in one file, shipped to every user on every page
load regardless of whether they open the Production tab. `stock.js` (2,525),
`items.js` (2,336), `process.js` (2,284) and `mobile.js` (3,396) are also past
any reasonable module size.

Production is genuinely the most complex domain here (lots, sub-processes,
colour matrices, the production sheet, WIP), so *some* size is inherent. But a
single file this large means every change risks the whole module, review is
impractical, and lazy loading is all-or-nothing.

**Expected behaviour.** Split by responsibility:
```
production/
├── index.js        # public API + tab lifecycle
├── list.js         # ledger view (→ ListView, FE-001)
├── lot-form.js     # create/edit modal
├── sheet.js        # production sheet matrix editor
├── wip.js          # WIP / process view
├── colors.js       # colour matrix logic
└── print.js        # print builders
```
Do this **after** ES modules (FE-003) so imports are explicit.

**Effort** L (2–3 wk for `production.js` alone) · **Risk** Medium — this is
business-critical logic. Requires characterisation tests first; `static/erp/tests/production_sheet_print.test.js` is a starting point.

---

## FE-006 · No build pipeline, linting, or type checking for JS
**Severity** High · **Priority** P1

`package.json` exists for tests only. There is **no ESLint, no Prettier, no
bundler, no minifier, no type checking**. Python has `ruff` configured
(`pyproject.toml`) — the frontend has no equivalent, despite being the larger
codebase (24,920 lines vs. the service layer's ~13,000).

**Consequences.** No automated detection of unused variables, unreachable code,
missing `await`, accidental globals, or `==`/`===` slips. Formatting drift across
17 files. 1.10 MiB shipped unminified (PERF-001). No IDE type assistance across
a 90-field global state object.

**Expected behaviour.**
1. **ESLint** with `eslint:recommended` + `no-unsanitized` (catches FE-004
   directly) + a custom rule banning inline `onclick`. Baseline existing
   violations so it does not block work.
2. **Prettier**, one formatting pass, added to CI.
3. **esbuild** for bundle + minify + sourcemaps.
4. **`// @ts-check` + JSDoc types** incrementally. Full TypeScript is not
   warranted, but `checkJs` on `api.js` and `core.js` would catch a real class of
   bug at near-zero cost.

**Effort** S (2–3 d for 1–3) · **Highest value-per-hour item in this report
alongside axe-core.**

---

## FE-007 · Semantic HTML gaps
**Severity** Medium · **Priority** P2

- **No landmarks.** `index.html` has no `<main>`, no `<header>` element (the
  header is `<div class="app-header">`), and `<nav>` only via `role="tablist"`.
  Screen-reader landmark navigation does not work. `<aside class="app-sidebar">`
  is used correctly — the concept is understood, just not applied.
- **`<div>`/`<td>` as controls** with `onclick` (FE-002) — no role, no
  keyboard, no focus.
- **Heading levels as styling** — 108 `<h5>`/`<h6>` vs 12 `<h2>` and zero
  `<h3>` (`ACCESSIBILITY_REPORT.md` A11Y-003).
- **Tables without `scope`** — 75 tables, 0 `scope` attributes (A11Y-001).
- **Datalists positioned with inline `display:none`** (`index.html:57-63`) —
  harmless but should be a class.

**Positive:** `role="tabpanel"` + `aria-labelledby` on tab content
(`dashboard.html:5`) is correct, as are the toast's ARIA attributes
(`index.html:104`) and the KPI cards' `role="button" tabindex="0"`.

**Expected behaviour.** `<header>` / `<nav>` / `<main>` / `<aside>` landmarks; a
skip-to-content link; real `<button>` elements for all actions.
**Effort** S (1–2 d for landmarks) · **Fixes** part of A11Y-005/006

---

## FE-008 · CSS has no methodology
**Severity** Medium · **Priority** P2

`styles.css` mixes element selectors (`table th`), Bootstrap overrides
(`.nav-link.active`), bespoke BEM-ish names (`.po-ms-option.checked`),
utility-ish names (`.fw-500`), ID-scoped rules (`#productionSheetModal
.prod-sheet-qty`), and attribute-scoped theming (`[data-theme="dark"] .card`).
143 `!important` declarations are the arbitration mechanism.

The file is also **not organised by component** — it is roughly chronological,
with dark-mode overrides at the top (lines 72–180) far from the components they
override at lines 800–2,400.

**Expected behaviour.** One file per component
(`DESIGN_SYSTEM.md` §2), a single naming convention (recommend BEM:
`.data-table__cell--numeric`), Stylelint enforcing no raw hex and no
`!important`, and theming that falls out of tokens rather than override rules.
**Effort** Absorbed into the design-system migration.

---

## FE-009 · Only 5 frontend tests, none covering rendering
**Severity** Medium · **Priority** P2

`static/erp/tests/`: `nav.test.js`, `notify.test.js`, `outbox_chaos.test.js`,
`pool_ledger.test.js`, `production_sheet_print.test.js`.

`outbox_chaos.test.js` is a genuinely sophisticated test of the offline
mutation outbox — real credit for that. But **5 tests against 24,920 lines**
means: no coverage of any table render path, no coverage of filter/sort/paginate,
no coverage of form validation, no accessibility assertions, no visual
regression.

The refactoring proposed in this audit is **not safe at this coverage level.**

**Expected behaviour, in order:**
1. **axe-core + jest-axe** on each rendered view (also `ACCESSIBILITY_REPORT.md` A11Y-010).
2. **Characterisation tests** on the modules slated for refactor — assert current
   rendered output for a fixture, so a refactor that changes nothing proves it.
3. **Unit tests** for pure helpers in `api.js` (`escapeHtml`, `formatCurrency`,
   `dateToInputValue`, `parseRecordDate`) — cheap and immediately useful.
4. **Playwright** for the viewport matrix (`RESPONSIVE_REVIEW.md` RES-007) and
   screenshot baselines.

**Effort** M (2 wk) · **Must precede FE-001 and FE-005.** This is a prerequisite,
not a parallel task.

---

## FE-010 · Dead and orphaned code
**Severity** Low · **Priority** P3

- **`App.BRAND_COLOR`** (`core.js:114`) — the comment states it is used by print
  builders that are *"currently unreachable dead code until App.Print exists"*.
  `print.js` now exists; verify and remove the stale comment or the dead path.
- **Forward-declared state** (`core.js:116-123`) — arrays declared for
  "not-yet-ported modules". All modules now exist; the guard comments are stale.
- **`?v=6` on `dashboard.js` only** (`index.html:335`) — one of 17 scripts has a
  cache-buster. Inconsistent and misleading (`PERFORMANCE_AUDIT.md` PERF-007).
- **`offline-cache.js`** (291 ln) — verify it is still referenced by either shell.
- **`static/erp/manifest.json` vs `manifest-mobile.json`** — confirm both are
  wired; `index.html:10` references the former, mobile presumably the latter.

**Effort** S (1 d) · Do this **after** FE-006's ESLint lands, which will find
more automatically.

---

## Recommended order

| Order | Item | Effort | Rationale |
|---|---|---|---|
| 1 | **FE-006** ESLint + Prettier + esbuild | 2–3 d | Cheapest, finds problems automatically, unblocks everything |
| 2 | **FE-009** steps 1 & 3 — axe-core + helper unit tests | 3–4 d | Safety net before any refactor |
| 3 | **FE-004** escape-by-default `html` tag | 2 d | Closes the XSS class structurally |
| 4 | **FE-007** landmarks + skip link | 1–2 d | Small, high accessibility value |
| 5 | **FE-003** ES modules | 2–3 wk | Prerequisite for splitting and lazy loading |
| 6 | **FE-009** step 2 — characterisation tests | 1–2 wk | Prerequisite for FE-001/FE-005 |
| 7 | **FE-001** ListViewController | 4–6 wk | Removes ~3,000–4,000 lines of duplication |
| 8 | **FE-002** delegation + drop `'unsafe-inline'` | 3–4 wk | Absorbed into per-view migration |
| 9 | **FE-005** split large modules | 2–3 wk | After ES modules + tests |
| 10 | **FE-008**, **FE-010** | ongoing | With the design-system migration |
