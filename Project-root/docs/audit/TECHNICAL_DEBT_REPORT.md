# Technical Debt Report — Phase 8

> **This report supersedes `docs/TECHNICAL_DEBT.md`**, which describes an
> `app/api/` + `app/main/` blueprint architecture that no longer exists in this
> tree (see TD-003). That file should be deleted or replaced with a pointer here.

---

## Debt classification

Debt is categorised by *origin*, because origin determines how it should be paid
down:

| Class | Meaning | Strategy |
|---|---|---|
| **Migration debt** | Inherited from the Apps Script → Flask port. Deliberate, documented, correct at the time. | Retire deliberately, module by module, as the port matures. |
| **Structural debt** | Architecture that no longer fits the load. | Requires design work, not cleanup. |
| **Hygiene debt** | Files, docs and scripts that should not be in the repo. | Delete. Cheap, immediate. |
| **Process debt** | Missing gates that let all the above accumulate. | **Pay first** — otherwise everything regresses. |

---

## Register

| ID | Debt | Class | Interest rate | Principal | Priority |
|---|---|---|---|---|---|
| TD-001 | No tooling gates (lint, types, a11y, perf, visual) | Process | **Compounding** | 1–2 wk | P0 |
| TD-002 | 19 loose scripts + legacy migration set at repo root | Hygiene | Low but hazardous | 1–2 d | P1 |
| TD-003 | Documentation describes a non-existent architecture | Hygiene | **High** (misleads) | 1 d | P1 |
| TD-004 | Whole-table reads with client-side pagination | Structural | **Compounding with data** | 3–4 wk | P0 |
| TD-005 | 11 hand-duplicated list-view state machines | Structural | High | 4–6 wk | P1 |
| TD-006 | Positional-args RPC with no validation | Migration | High | 3–4 wk | P0 |
| TD-007 | Three divergent design systems | Structural | Medium | 6–8 wk | P1 |
| TD-008 | 977 avoidable inline styles + 143 `!important` | Structural | Medium | 4–6 wk | P2 |
| TD-009 | No module system; global `App` namespace | Migration | Medium | 2–3 wk | P1 |
| TD-010 | Test coverage: 5 frontend tests for 24,920 lines | Process | **High** (blocks refactor) | 2 wk | P0 |
| TD-011 | Four entry points with divergent config | Hygiene | Medium | 1–2 d | P2 |
| TD-012 | Schema names derived from spreadsheet tab names | Migration | Low | — | P4 |
| TD-013 | Errors swallowed; no observability | Structural | **High** (invisible failures) | 1 d + 2 wk | P0 |
| TD-014 | Authentication without authorization | Structural | High | 1–2 wk | P1 |
| TD-015 | Service modules >1,000 lines with private cross-imports | Structural | Medium | 2–3 wk | P2 |
| TD-016 | Schedulers started per WSGI worker | Structural | Medium | 2–3 d | P2 |
| TD-017 | jQuery loaded solely for Select2 | Migration | Low | 1–2 wk | P3 |

---

## TD-001 · No tooling gates — the debt that creates debt
**Class** Process · **Priority P0** · **Principal** 1–2 weeks

Currently absent: ESLint · Prettier · JS type checking · Stylelint · axe-core ·
Lighthouse CI · bundle budget · visual regression · slow-query log ·
`EXPLAIN` in CI.

Present: `ruff` for Python (`pyproject.toml`), pytest (34 files), 5 JS tests.

**Why this is first.** Every other item in this register accumulated *because
nothing prevented it*. 143 `!important` declarations, 1,391 inline styles, 977
unescaped-or-not interpolations and 246 inline `onclick` handlers did not arrive
in one commit — they arrived one at a time, each individually reasonable, with
no gate to say "not this one too."

**Paying it down first means every subsequent fix is permanent.** Paying it down
last means re-doing the work.

**Interest.** Compounding. Every sprint without gates adds to every other item.

**Payment.** ESLint + Prettier + esbuild (2–3 d) → axe-core in the existing
`npm test` (1–2 d) → Stylelint (1 d) → Lighthouse CI + bundle budget (2 d) →
Playwright screenshots (3 d). **Baseline all existing violations** so the gates
block *new* debt without blocking current work.

---

## TD-002 · 19 loose scripts and a legacy migration set at repo root
**Class** Hygiene · **Priority P1** · **Principal** 1–2 days

Committed at `Project-root/`:
`check_all_cols.py` · `check_columns.py` · `check_oauth_config.py` ·
`check_pl_cols.py` · `check_pl_subproc.py` · `check_schema_mismatches.py` ·
`check_table.py` · `check_table_structure.py` · `check_users.py` ·
`create_table_nofk.py` · `create_table_simple.py` · `deduplicate_items.py` ·
`inspect_process_schema.py` · `inspect_test_db.py` · `list_tables.py` ·
`migration_final.py` · `migration_new_endpoints.py` · `migration_safe.py` ·
`test_endpoints.py` · `test_variants.py` — plus `audit_report.json`.

Separately, `migrations/` holds **two generations**: `migrations/erp/001–023`
(current, ordered, with a runner) and ~35 top-level files targeting the
pre-port UPF schema (`upf_production_lots`,
`production_lot_inventory_alerts`, `subprocess_variants`) — tables the current
application never queries.

**Hazard, not just untidiness.** `run_migration.py` sits at root alongside these.
It is not obvious to a new operator which migration set is authoritative, and
`migrations/006_add_performance_indexes.sql` creates indexes on tables that no
longer exist. A wrong invocation during deployment is a genuine risk.

**Payment.** Move useful tools into `scripts/` with docstrings; delete the rest;
move the legacy migrations to `migrations/_archive/` with a README stating they
must not be run; make `migrations/erp/runner.py` the single documented entry
point and verify `DEPLOYMENT.md` says so.

**Cross-ref** `SQL_OPTIMIZATION.md` SQL-007, `PYTHON_BACKEND_REVIEW.md` PY-007

---

## TD-003 · Documentation describes an architecture that does not exist
**Class** Hygiene · **Priority P1** · **Principal** 1 day · **Interest: high**

`docs/TECHNICAL_DEBT.md` (dated November 2025) describes ~1,000 lines of dead
code in an `app.py` file, and states that active routes live in
`app/api/routes.py`, `app/api/process_management.py`, `app/main/routes.py` and
six other files. **None of those files exists.** `app.py` itself does not exist.
The current structure is `app/erp/` with a 135-method RPC registry.

The document also references `enhanced_audit_report.json`,
`FINAL_AUDIT_SUMMARY.md` and `PHASE_1_ROUTE_STANDARDIZATION_COMPLETE.md`, none
of which are present.

Corroborating drift: `app/__init__.py:409` mentions starting the app via
`python app.py` — a file that no longer exists.

**Why this rates higher than its size.** Wrong documentation is worse than none.
A new contributor reading it will look for `app/api/` and conclude the codebase
is in a state it is not. It also *understates* the real debt by describing a
problem that has already been solved.

**Payment.** Delete `docs/TECHNICAL_DEBT.md` and replace with a pointer to this
report. Audit `README.md`, `DEPLOYMENT.md`, `docs/PRODUCTION_READINESS.md` and
`docs/PERFORMANCE.md` for the same drift.

---

## TD-004 · Whole-table reads with client-side pagination
**Class** Structural · **Priority P0** · **Principal** 3–4 weeks
**Interest: compounding with data volume**

390 `execute()` calls, **one `LIMIT`**. Every `getXData` returns its full table;
the client paginates in `App.State`. Combined with a full re-fetch on every tab
switch (`core.js:1387`), payload and latency grow linearly and without bound.

**This is the only item in the register with an interest rate tied to business
success.** More production, more dispatch, more history → slower application.
It is acceptable today and will not be. Nothing in the code caps it.

**Payment.** Optional trailing `params` on read methods (backwards-compatible
because RPC args are positional), returning `{rows, total}`; keyset pagination
for the large ledgers; partial indexes matching the new `ORDER BY … WHERE
deleted_at IS NULL` shape.
**Cross-ref** `SQL_OPTIMIZATION.md` SQL-001/SQL-005, `PERFORMANCE_AUDIT.md` PERF-002

---

## TD-005 · 11 hand-duplicated list-view state machines
**Class** Structural · **Priority P1** · **Principal** 4–6 weeks

`App.State` (`core.js:124-298`) holds ~90 fields, of which the majority are 11
copies of `{currentPage, rowsPerPage, searchTerm, sortBy, selected[],
filtered[], global[]}`.

**The duplication has already drifted:** Return, Client, Order and BOM have no
sort field; Dispatch has no search term. These are not deliberate — they are
copies that were not kept in sync. Every future list feature costs 11×.

**Payment.** One `ListViewController` factory; migrate one module per PR with
`App.State` kept as a deprecated read-through facade.
**Estimated removal: 3,000–4,000 lines.**
**Cross-ref** `HTML_CSS_JS_REVIEW.md` FE-001

---

## TD-006 · Positional-args RPC with no validation
**Class** Migration · **Priority P0** · **Principal** 3–4 weeks

`rpc.py:50` — `result = spec.func(*args)`. The client's JSON array is splatted
into the service function with no schema, arity check, type check or size limit,
across all 135 methods.

**This is textbook migration debt** — it faithfully reproduces
`google.script.run`'s positional-call semantics, which was the correct choice
for a 1:1 port. It is now the largest input-trust gap in the application.

**Payment.** Optional `schema` on `RpcSpec`; validate before dispatch; `None`
preserves current behaviour so migration is incremental. `MAX_CONTENT_LENGTH` in
config as an immediate one-line mitigation. Start with the 82 mutations.
**Cross-ref** `PYTHON_BACKEND_REVIEW.md` PY-002

---

## TD-007 · Three divergent design systems
**Class** Structural · **Priority P1** · **Principal** 6–8 weeks

Auth (`#6366F1`, 3,060 ln) · Desktop (`#0f172a`, 2,912 ln) · Mobile
(`#ff6a13`, 857 ln). Three palettes, three type treatments, no shared tokens.
Only the mobile system has a spacing or type scale.

**Payment.** Extract `tokens.css`; alias existing names so nothing breaks; ship
the accessibility corrections inside the alias step; re-express all three as
consumers; keep the workshop palette as a *theme*, not a fork.
**Cross-ref** `DESIGN_SYSTEM.md` §5

---

## TD-008 · 977 avoidable inline styles and 143 `!important`
**Class** Structural · **Priority P2** · **Principal** 4–6 weeks

1,391 inline `style=` total. **414 of those (in `print.html`) are correct and
must stay** — `styles.css:2460` documents that html2canvas never applies
`@media print`, so print layout must be inline. The remaining 977 are debt, and
they are the direct cause of the 143 `!important` declarations: an inline style
cannot be beaten by any selector, so dark mode must shout.

**Payment.** One view per PR, tracked with two metrics: inline-style count
(977 → <100) and `!important` count (143 → <20).
**Cross-ref** `UI_UX_AUDIT.md` UI-002/UI-005

---

## TD-009 · No module system
**Class** Migration · **Priority P1** · **Principal** 2–3 weeks

17 classic `<script>` tags sharing a global `App`; load order is load-bearing
and documented only in a comment. The
`if (typeof App.Dashboard !== 'undefined')` idiom throughout `core.js` exists
solely to tolerate that uncertainty.

Blocks: tree-shaking, lazy loading, real unit tests, dependency analysis.
**Payment.** ES modules, leaf-first, keeping `window.App` populated during
migration. **Cross-ref** `HTML_CSS_JS_REVIEW.md` FE-003

---

## TD-010 · Test coverage — 5 frontend tests for 24,920 lines
**Class** Process · **Priority P0** · **Principal** 2 weeks

Python is reasonably covered (34 pytest files, one per service). The frontend
has 5 tests, none covering rendering, filtering, sorting, pagination or forms.
`outbox_chaos.test.js` is genuinely good work — it is also 1 of 5.

**This is a blocker, not a nice-to-have.** TD-005 (11 state machines) and
TD-008 (977 inline styles) both require touching thousands of lines of
rendering code. **Doing that at current coverage is not responsible.**

**Payment, in order:** axe-core + jest-axe (also fixes A11Y-010) → unit tests
for pure helpers in `api.js` → **characterisation tests** capturing current
rendered output for each module slated for refactor → Playwright viewport matrix
and screenshot baselines.

---

## TD-011 · Four entry points with divergent configuration
**Class** Hygiene · **Priority P2** · **Principal** 1–2 days

`run.py`, `run_production.py`, `wsgi.py`, plus `Dockerfile`/`Procfile`. The
codebase documents the resulting bug at `app/__init__.py:405-411`: the several
ways to start the app "don't all reliably land on DevelopmentConfig's
DEBUG=True", which force-redirected local HTTP to a non-existent HTTPS port.

**Payment.** One entry point (`wsgi.py`) for all environments; `flask run` for
dev; delete or thin the others; document one command per environment.
**Cross-ref** `PYTHON_BACKEND_REVIEW.md` PY-010

---

## TD-012 · Schema names derived from spreadsheet tab names
**Class** Migration · **Priority P4** — *accept, do not pay*

`config_maps.py:26` maps sheet display names ("PO Tracker", "Bill Ledger") to
Postgres tables via `to_snake_case()`. Table and column identifiers are resolved
at runtime, producing 18 f-string-interpolated SQL sites.

**Recommendation: accept this debt.** The indirection is well-documented, keeps
the port verifiable against the Apps Script source, and the migration cost of
hard-coding 46 table names is high with near-zero benefit. **Do fix the
mechanism** — use `psycopg2.sql.Identifier` instead of f-strings
(`SQL_OPTIMIZATION.md` SQL-003) — but keep the mapping. Revisit only if the Apps
Script reference is formally retired.

---

## TD-013 · Errors swallowed; no observability
**Class** Structural · **Priority P0** · **Principal** 1 day + 2 weeks

`rpc.py:51` catches every exception and returns HTTP 200 `{success: false}`
with `str(exc)` — **and never logs.** An `AttributeError` in
`production_service` produces no 500, no log line, no alert. The application can
be substantially broken while reporting success on every request.

No RUM, no Core Web Vitals, no per-method timing, no slow-query log, no
`pg_stat_statements`.

**Every priority judgement in this entire audit was made from static analysis
because there is no telemetry to consult.** That is the real cost of this item.

**Payment.** Three lines of `logger.exception()` **today** (1 day, independently
valuable). Then `DomainError` separation, `web-vitals` reporting, per-method
timing, and `log_min_duration_statement = 200ms`.
**Cross-ref** `PYTHON_BACKEND_REVIEW.md` PY-001, `PERFORMANCE_AUDIT.md` PERF-009

---

## TD-014 · Authentication without authorization
**Class** Structural · **Priority P1** · **Principal** 1–2 weeks

All 135 methods are gated by `@login_required` alone. Any authenticated
user — including a shop-floor operator on the mobile PWA — can invoke
`deleteItemsBulk`, `adjustStockManually`, `triggerBackup` and
`runScheduledItemCleanup`.

`RpcSpec` already carries a `bom_gated` flag and the rpc docstring reserves 403
for gating, so **the concept was anticipated and never generalised.**

**Payment.** `roles` on `RpcSpec`, enforced pre-dispatch. Requires a business
decision on the role model first. **Cross-ref** `PYTHON_BACKEND_REVIEW.md` PY-009

---

## TD-015 · Service modules >1,000 lines with private cross-imports
**Class** Structural · **Priority P2** · **Principal** 2–3 weeks

`process_service.py` 2,273 · `items_service.py` 1,260 · `production_service.py`
1,019 · `warehouse_service.py` 969. Modules reach into each other's privates
(`po_service.py:301` → `bill_service._aggregate_billed_base_qty_by_po`), and
`process ↔ warehouse` is a circular dependency worked around with a deferred
import (`process_service.py:338`).

**Payment.** Split by bounded context; promote shared helpers to an explicit
internal API; break the cycle by extracting the shared recompute.
**Cross-ref** `PYTHON_BACKEND_REVIEW.md` PY-011

---

## TD-016 · Schedulers started per WSGI worker
**Class** Structural · **Priority P2** · **Principal** 2–3 days

`app/__init__.py:552-555` starts the ledger audit and the nightly backup inside
`create_app()`. Under gunicorn with N workers, `create_app()` runs N times — so
both schedulers run N times concurrently on independent timers. For a *backup*
and a *reconciliation*, duplicate concurrent execution is not benign.

**Verify first** whether existing guards cover the multi-worker case, then move
to a separate process or guard with a Postgres advisory lock.
**Cross-ref** `PYTHON_BACKEND_REVIEW.md` PY-008

---

## TD-017 · jQuery loaded solely for Select2
**Class** Migration · **Priority P3** · **Principal** 1–2 weeks

`index.html:325` loads jQuery 3.6 with the comment "(Select2 dependency)".
Select2 is its only consumer. jQuery + Select2 + two Select2 themes ≈ 115 KB and
three CDN origins on the critical path, plus three CSP allowlist entries.

**Payment.** Native combobox (`COMPONENT_LIBRARY_PLAN.md` #11), then remove
jQuery, Select2 and their CSP entries. **Sequence after DataTable.**

---

## Repayment sequencing

**Principle: pay process debt first, then structural debt that compounds, then
migration debt, then hygiene.** Hygiene is cheap and can be slotted into any gap.

| Wave | Items | Duration | Why this order |
|---|---|---|---|
| **0 — Stop the bleeding** | TD-001, TD-010, TD-013 (logging half), TD-003, TD-002 | 3–4 wk | Gates + tests + visibility. Nothing below is safe or measurable without these. |
| **1 — Compounding structural** | TD-004, TD-006, TD-013 (full), TD-014 | 8–10 wk | Interest tied to data growth and security exposure |
| **2 — Design & duplication** | TD-007, TD-005, TD-009 | 10–12 wk | Largest line-count reduction; unblocks all UI work |
| **3 — Cleanup** | TD-008, TD-015, TD-011, TD-016 | 6–8 wk | Absorbed into wave-2 per-view PRs where possible |
| **4 — Optional** | TD-017, TD-012 (accept) | 2 wk | Only after everything above |

**Total ≈ 30–36 weeks** of one engineer's time, delivered incrementally with
usable increments throughout. See `IMPLEMENTATION_ROADMAP.md` for the
week-by-week plan with the UX work interleaved.

---

## Debt metrics — track these

| Metric | Now | 6 mo | 12 mo |
|---|---:|---:|---:|
| Inline `style=` (excl. `print.html`) | 977 | 400 | < 100 |
| `!important` | 143 | 60 | < 20 |
| Inline `onclick` (templates) | 246 | 100 | 0 |
| `App.State` fields | ~90 | 40 | < 15 |
| JS payload, initial route (gz) | ~1.10 MiB raw | 300 KB | 150 KB |
| RPC methods with a schema | 0 / 135 | 82 / 135 | 135 / 135 |
| Read methods with `LIMIT` | 1 / 390 | 6 major | all list reads |
| Frontend tests | 5 | 60 | 150 |
| CI gates | 0 | 4 | 6 |
| WCAG AA failures (axe) | 6 categories | 2 | 0 |
| Loose root-level scripts | 19 | 0 | 0 |
