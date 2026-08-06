# Code Refactoring Plan — Phase 8

Concrete, sequenced refactors with entry conditions, exit criteria and rollback.
Debt rationale is in `TECHNICAL_DEBT_REPORT.md`; this document is the *how*.

---

## Ground rules

1. **No behaviour change without a test that proves it.** Every refactor here is
   behaviour-preserving unless explicitly marked *(intentional change)*.
2. **One module per pull request.** No flag-day rewrites of an ERP in production.
3. **Old and new coexist.** Every refactor introduces the new mechanism
   alongside the old, migrates callers incrementally, and deletes the old path
   only when the last caller is gone.
4. **Characterisation tests before structural change.** Capture what the code
   does *today*, refactor, assert identical output. This is mandatory for the
   render layer and the rename paths.
5. **Every PR reports its metrics** (see the table at the end).

---

## R0 · Safety net — *prerequisite for everything else*
**Duration** 3 weeks · **Risk** None · **Entry** none

Nothing below R0 should start before R0 finishes. 24,920 lines of frontend with
5 tests cannot be safely restructured.

### R0.1 — Tooling (3 days)
```
npm i -D eslint prettier esbuild stylelint jest-axe @axe-core/playwright
```
- ESLint: `eslint:recommended` + `plugin:no-unsanitized/DOM` (catches the
  `innerHTML` class directly) + a custom `no-inline-onclick` rule for templates.
- Prettier: one formatting commit, isolated, so it never pollutes a review diff.
- Stylelint: `declaration-no-important`, `color-no-hex` (warn initially).
- **Baseline every existing violation.** Gates block *new* debt only.

**Exit:** `npm run lint` passes on a baselined repo; CI fails on new violations.

### R0.2 — Characterisation tests (1.5 weeks)
For each module slated for refactor, capture current rendered output:

```js
// static/erp/tests/characterise/po.render.test.js
import fixture from './fixtures/po.json';
test('PO ledger renders identically', () => {
  App.State.globalPOs = fixture;
  App.PO.render();
  expect(document.getElementById('poTableBody').innerHTML).toMatchSnapshot();
});
```

Cover, at minimum: PO, Bill, Stock, Items, Production ledger renders; filter,
sort and paginate for each; the production sheet matrix.

**These snapshots are the contract.** A refactor that changes nothing must
produce byte-identical output.

### R0.3 — Accessibility + unit baseline (3 days)
- `jest-axe` assertion per rendered view, baselined against current violations.
- Unit tests for the pure helpers in `api.js`: `escapeHtml`, `toNumber`,
  `formatCurrency`, `formatQty`, `parseRecordDate`, `dateToInputValue`,
  `normalizeDateForInput`, `formatItemsPreview`. Cheap, fast, immediately useful.

### R0.4 — Backend observability (2 days)
```python
# app/erp/rpc.py
except Exception:
    current_app.logger.exception(
        "RPC %s failed", method,
        extra={"method": method, "request_id": g.get("request_id"),
               "user_id": getattr(current_user, "id", None)},
    )
```
Plus per-method duration + query-count logging. **A query-count metric makes N+1
regressions self-reporting** — do not skip it.

**Exit criteria for R0:** CI runs lint + tests + axe on every PR; snapshots exist
for the five largest render paths; RPC failures appear in logs.

---

## R1 · Escape-by-default rendering
**Duration** 2 days · **Risk** Low · **Entry** R0.1

767 `escapeHtml()` calls against ~997 interpolations shows genuine discipline —
but safety is opt-in and unverifiable. Make it structural.

**Add to `api.js`:**
```js
const RAW = Symbol('raw');
export function raw(s) { return {[RAW]: String(s)}; }

export function html(strings, ...values) {
  return strings.reduce((out, str, i) => {
    if (i === 0) return str;
    const v = values[i - 1];
    const safe = (v && v[RAW] !== undefined) ? v[RAW] : escapeHtml(v ?? '');
    return out + safe + str;
  }, '');
}
```

**Migration:** new code uses `` html`…` `` exclusively. Existing
`escapeHtml()` calls keep working — they are already correct. Convert
opportunistically when touching a file. Add the ESLint rule banning bare
`innerHTML =` outside an allowlist once conversion is underway.

**Exit:** `html` exported and used in all new render code; lint rule active.
**Rollback:** trivial — the helper is additive.

---

## R2 · ES modules
**Duration** 2–3 weeks · **Risk** Medium · **Entry** R0 complete

17 classic scripts sharing a global. Convert leaf-first so nothing breaks.

**Order:** `api.js` (no dependencies) → `core.js` helpers (`$`, `$$`,
`safeModalShow`, `App.Utils`, `App.Selection`) → `print.js` → feature modules.

**Critical compatibility step.** Inline `onclick="App.PO.openModal()"` handlers
(246 of them) read `App` off `window`. Until R5 removes them, the entry module
must keep publishing:
```js
// entry.js
import * as PO from './po.js';
window.App = window.App || {};
window.App.PO = PO;      // keep global surface alive during migration
```

**Build:** esbuild bundles to `static/erp/dist/app.[hash].js`. Serve the bundle
from `index.html`; keep individual files during transition behind a config flag
so a bad bundle can be reverted in one line.

**Exit:** one `<script type="module">` tag replaces 17; sourcemaps emitted;
snapshots unchanged.
**Rollback:** revert `index.html` to the 17 tags — modules still work as classic
scripts if the entry file assigns globals.

---

## R3 · ListViewController — the largest single win
**Duration** 5–6 weeks · **Risk** Medium · **Entry** R0, R2, DataTable component
**Removes an estimated 3,000–4,000 lines**

Replaces 11 hand-duplicated state machines
(`HTML_CSS_JS_REVIEW.md` FE-001).

### Design
```js
// static/erp/lib/list-view.js
export function ListView({
  id, fetch, columns, defaultSort, pageSize = 15,
  getRowId, searchFields, filters = {},
}) {
  const state = {rows: [], total: 0, page: 1, pageSize, sort: defaultSort,
                 query: '', filters: {...filters}, selected: new Set(),
                 loading: false, error: null};
  const subs = new Set();
  const emit = () => subs.forEach(f => f(state));

  return {
    state,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    async load() { /* fetch → state → emit; SWR-cached */ },
    setQuery(q) { /* debounced 250ms → page=1 → load */ },
    setSort(key) { /* toggle asc/desc → load */ },
    setPage(n) { /* → load */ },
    toggleSelect(rowId) { /* → emit */ },
    toUrl() / fromUrl() { /* UX-006 */ },
  };
}
```

Built **server-pagination-ready from day one** — `fetch` receives
`{limit, offset, sort, query, filters}` and returns `{rows, total}`. Until the
backend supports it (R7), a `clientSide: true` adapter slices in memory. **This
means R7 requires no second pass over the frontend.**

### Migration order — ascending complexity
| # | Module | State fields removed | Notes |
|---|---|---|---|
| 1 | Vendors | 4 | Simplest; proves the pattern |
| 2 | Contractors | 5 | |
| 3 | Returns + Wastage | 12 | Two lists in one tab |
| 4 | Bills | 8 | Has auto-match timer state — preserve |
| 5 | POs | 10 | Has `allPendingPOs` secondary list |
| 6 | Items | 6 | |
| 7 | Stock + Warehouse Pool | 14 | Two lists, grouped rendering |
| 8 | Clients + Orders | 12 | |
| 9 | Dispatch | 8 | Flat/grouped dual shape — read `core.js:199-219` first |
| 10 | Production + Issue | 12 | Largest; do last |

**Compatibility shim** — keep `App.State` working throughout:
```js
Object.defineProperty(App.State, 'poCurrentPage', {
  get: () => poList.state.page,
  set: v => poList.setPage(v),
});
```
Delete the shim only when no reader remains.

**Exit per PR:** snapshots unchanged; that module's `App.State` fields removed;
URL state working; axe clean.
**Rollback:** per-module — each PR is independently revertible.

---

## R4 · Design token migration
**Duration** 6 weeks · **Risk** Low–Medium · **Entry** R0.1, screenshot baseline

Detailed in `DESIGN_SYSTEM.md` §5. Summary:

- **R4.1 (1 wk, zero visual change)** — create `tokens.css`; alias every
  existing token name to a new one; load before `styles.css`.
- **R4.2 (2 d, *intentional change*)** — apply AA-compliant colour values and
  the `:focus-visible` outline rule. **Ship separately** so it can be reverted in
  isolation if a component depended on a failing colour.
- **R4.3 (4 wk)** — delete inline styles one view per PR, ascending:
  Vendors (33) → Contractors (22) → Dashboard (10) → Bills (38) → Dispatch (34)
  → PO (45) → Items (47) → Stock (54) → Returns (57) → Clients (59) →
  Products (63) → Production (83).
  **Skip `print.html`'s 414 — those are correct.**
- **R4.4 (1 wk)** — re-express auth and mobile stylesheets as token consumers.

**Exit:** inline styles < 100; `!important` < 20; screenshots match except where
R4.2 intentionally changed a colour.

---

## R5 · Event delegation, and removing `'unsafe-inline'`
**Duration** 3–4 weeks · **Risk** Low · **Entry** R2, R3 (per module)

Extend the existing pattern at `core.js:1611-1619` rather than inventing one.

```js
// static/erp/lib/actions.js
const registry = new Map();
export const action = (name, fn) => registry.set(name, fn);

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const fn = registry.get(el.dataset.action);
  if (fn) { e.preventDefault(); fn(el.dataset, el, e); }
});
```

Convert per module, alongside R3/R4 on the same view:
`onclick="App.PO.openModal()"` → `data-action="po:new"` on a real `<button>`.

**Final step, once the count reaches zero:** remove `'unsafe-inline'` from
`script-src` in `app/__init__.py:427-433`. That single line is the largest CSP
hardening available and it is gated entirely on this refactor.

**Exit:** 0 inline `onclick` in templates; CSP tightened; axe reports no
`div`-as-button violations.

---

## R6 · Split oversized JS modules
**Duration** 3 weeks · **Risk** Medium · **Entry** R2, R3, characterisation tests

| Module | Lines | Split into |
|---|---:|---|
| `production.js` | 5,441 | `index · list · lot-form · sheet · wip · colors · print` |
| `mobile.js` | 3,396 | `index · outbox · views · sync` |
| `stock.js` | 2,525 | `index · items-stock · warehouse-pool · adjustments` |
| `items.js` | 2,336 | `index · list · form · merge-dedupe · drift` |
| `process.js` | 2,284 | `index · master · components · colors · mappings` |

Pure file moves plus explicit imports — no logic changes. Snapshots must be
byte-identical.

**Then wire lazy loading:** `core.js:19` already has a `loadScript()` helper.
With ES modules, use dynamic `import()` in `showTab()` so a module loads on
first visit. Expected effect: initial payload from 1.10 MiB to roughly the
`api + core + dashboard` subset.

---

## R7 · Server-side pagination
**Duration** 4 weeks · **Risk** Medium · **Entry** R3, SQL-003, PERF-009 data

Backwards-compatible because RPC args are positional (`rpc.py:50`) — an optional
trailing parameter leaves existing zero-arg calls working.

```python
# app/erp/services/_shared/paging.py
_SORTS = {"dateDesc": "po_date DESC, id DESC",
          "dateAsc":  "po_date ASC, id ASC",
          "numberDesc": "po_number DESC, id DESC"}

def page_params(raw, *, allowed_sorts, default_sort, max_limit=200):
    p = raw or {}
    limit = min(int(p.get("limit", 50)), max_limit)
    sort = allowed_sorts.get(p.get("sort"), allowed_sorts[default_sort])
    return {"limit": limit, "offset": max(0, int(p.get("offset", 0))),
            "sort_sql": sort, "query": (p.get("query") or "").strip() or None}
```

**Sort keys must be allowlisted, never interpolated.** Use
`psycopg2.sql.Identifier` for any dynamic identifier (SQL-003 lands first).

**Order by data growth rate:** `getProductionData` → `getStockData` →
`getBillData` → `getPOData` → `getItemsData` → `getDispatchData`.

Each method ships with: a partial index matching its new `ORDER BY … WHERE
deleted_at IS NULL` shape; `EXPLAIN` output in the PR description; the
corresponding ListView switched from `clientSide: true` to server mode.

**Rollback:** per method — omit the params argument and the old path resumes.

---

## R8 · Backend structural work
**Duration** 5 weeks · **Risk** Medium–High · **Entry** R0.4

### R8.1 — `DomainError` separation (2 wk)
Introduce `DomainError`; convert services one at a time. Until a service is
converted, `ValueError` remains treated as domain-level for that module. The
existing `tests/erp/test_*.py` assert on messages and will catch regressions.
*(intentional change: unexpected exceptions now return a generic message +
request id instead of raw exception text)*

### R8.2 — RPC input validation (2 wk framework, ongoing migration)
`schema` field on `RpcSpec`, validated pre-dispatch; `None` preserves current
behaviour. `MAX_CONTENT_LENGTH` in config as a same-day mitigation. Start with
`saveLogo`, `saveProductionSheet`, `savePO`, `saveBill`, `importStockData`.

### R8.3 — Authorization (1–2 wk, **after a business decision on roles**)
`roles: frozenset[str] | None` on `RpcSpec`, enforced pre-dispatch, 403 on
failure. Annotate the 82 mutations first; reads later.

### R8.4 — `create_app()` decomposition (1 wk)
Six ordered helpers, each with a docstring stating its ordering constraint and a
test. Pure refactor, covered by `tests/test_app.py`.

### R8.5 — Set-based renames (1 wk)
Replace row-by-row `UPDATE` loops (`process_service.py:254`, `:323`;
`tags_service.py:176`, `:192`) with single statements.
**Mandatory precondition:** a test per rename path asserting identical
before/after DB state on a seeded fixture. These paths encode production bug
fixes documented in-comment — correctness outranks speed.

### R8.6 — Fix teardown (1 d)
`app/__init__.py:613-663` guesses at cleanup function names and misses the real
one (`database.close_db_pool`). Replace with `atexit.register(database.close_db_pool)`;
per-request teardown already returns connections correctly via the context
manager. **Investigate early — cheap to check, severe failure mode.**

---

## R9 · Repo hygiene
**Duration** 2 days · **Risk** None · **Entry** none — *slot into any gap*

- Move useful root scripts to `scripts/`; delete the rest (19 files).
- Move legacy migrations to `migrations/_archive/` + README; make
  `migrations/erp/runner.py` the documented entry point.
- Delete `docs/TECHNICAL_DEBT.md` (describes a non-existent architecture);
  point to `TECHNICAL_DEBT_REPORT.md`.
- Remove `auth/routes.py` shim after verifying no importers.
- Consolidate to one entry point; update `DEPLOYMENT.md`.
- Remove `audit_report.json`; verify `.gitignore` covers generated artifacts.

---

## Dependency graph

```
R0 (safety net) ─┬─> R1 (html``)
                 ├─> R2 (ES modules) ─┬─> R6 (split modules) ─> lazy loading
                 │                    └─> R3 (ListView) ─┬─> R5 (delegation) ─> CSP hardening
                 │                                       └─> R7 (server pagination)
                 ├─> R4 (tokens) ──────────────────────────> R5
                 └─> R8 (backend) ────────────────────────> R7

R9 (hygiene) — no dependencies, any time
DataTable component (COMPONENT_LIBRARY_PLAN.md #1) — required by R3
SQL-003 (psycopg2.sql) — required by R7
```

**Critical path:** R0 → R2 → R3 → R7. Roughly 15 weeks.
**Parallelisable:** R4 (design) and R8 (backend) run alongside the frontend
track with different skill sets.

---

## Per-PR metric reporting

Every refactoring PR states, before and after:

| Metric | Command |
|---|---|
| Inline `style=` | `grep -o 'style="' <files> \| wc -l` |
| `!important` | `grep -c '!important' <css>` |
| Inline `onclick` | `grep -o 'onclick=' <templates> \| wc -l` |
| `App.State` fields | manual count in `core.js` |
| Bundle size | esbuild `--analyze` |
| Lines removed | `git diff --stat` |
| axe violations | CI output |
| Snapshot diffs | must be **0** unless *(intentional change)* |

---

## Explicit non-goals

Recorded so they are not attempted:

1. **No framework migration.** React/Vue/Svelte would mean rewriting 24,920
   lines with no user-visible benefit. Rejected.
2. **No RPC → REST rewrite.** The RPC layer with its idempotency mechanism is
   sound. Adding validation and authorization to it is strictly cheaper and
   safer than replacing it.
3. **No merging of the desktop and mobile shells.** Adaptive delivery is correct
   for these two contexts (`RESPONSIVE_REVIEW.md` RES-004). Share tokens and
   components; keep the shells separate.
4. **No Postgres schema rename away from spreadsheet-derived names.**
   Well-documented, verifiable against the source, high cost and near-zero
   benefit to change (`TECHNICAL_DEBT_REPORT.md` TD-012).
5. **No removal of `print.html`'s inline styles.** They are correct and the
   reason is documented in the code.
