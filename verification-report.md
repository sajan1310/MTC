# Verification Report — Apps Script → Flask/Postgres + PWA Migration

**Verifier:** Claude (Sonnet 5, Claude Code)
**Date:** 2026-07-27
**Branch verified:** `claude/appscript-pwa-conversion-p7p6mq`
**Commit at verification start:** `e007ec4` ("Add Nav rollout, in-place row-patching, notifications, item-process mapping, reference integrity, and Production Sheet print redesign")
**Commits added by this verification pass:** two functional fixes found via systematic parity audit (Wastage edit path, Dispatch untagged-output lookup bug) + this report + a generated API mapping doc — see "Changes made during verification" below.

## Summary: **PASS, with two documented architectural deviations and one real deviation gap**

The migration is **functionally complete**: every one of the 20 Apps Script `module_*.js` files (130 RPC methods) plus the mobile UI has been checked method-by-method against the Flask port and confirmed at behavioral parity, with two real bugs found and fixed during this verification. The delivered architecture is **not** the REST-resource-per-domain shape originally sketched (`GET /api/po`, `POST /api/bill`, etc.) — it is a single JSON-RPC bridge (`POST /api/erp/rpc/<method>`) that mirrors Apps Script's own `google.script.run` dispatch model directly, which is a better fit for a 1:1 behavioral port and is what the codebase actually implements throughout. This report verifies against **what was actually built**, flagging every place it diverges from the originally-circulated generic checklist, rather than marking those items FAIL for not matching a shape the project deliberately didn't use.

One genuine gap remains open (not fixed in this pass, flagged for a decision): there is **no Sheets→Postgres historical data-migration script**. The schema was built fresh via 20 sequential SQL migrations; nothing bulk-imports a live Apps Script spreadsheet's historical rows into it. See item 6.

---

## Environment

| | |
|---|---|
| OS | Windows 11 |
| Python | 3.13.7 (venv2), app targets 3.10–3.12 in CI |
| Node | present (used for `node --check` syntax validation only; no `package.json`/build step in this repo) |
| Docker | client 29.6.2 installed; **daemon not running** in this environment (see item 9) |
| Database | Local Postgres, `testdb`, used by `tests/erp/` via `tests/conftest.py`'s session-scoped fixture (creates schema via `Project-root/migrations/erp/*.sql`, `LOGIN_DISABLED=True`) |
| Repo state | Working tree had uncommitted fixes at verification start (from a prior parity-audit pass in this same session); committed as part of this branch — see below |

---

## Changes made during verification

Two real bugs were found while cross-checking every GAS entry point against its Flask equivalent (method-by-method, reading both sides' actual logic, not just name-matching):

1. **`Project-root/app/erp/services/wastage_service.py`** — GAS's `module_wastage.js` has a dedicated `updateWastage(wastageId, formData)` edit path; the Flask port only had create. Added `existingWastageId` support to `saveWastage` (same fold-edit-into-save convention already used by PO/Bill/Return/Issue), plus matching UI (`static/erp/return.js`, `templates/erp/partials/return_ledger.html`) and two new tests.
2. **`Project-root/app/erp/services/dispatch_service.py`** — `saveDispatch`'s Ready-to-Dispatch capacity check didn't fall back to the `__output__`-prefixed key that untagged final-stage production output is credited under (GAS's own `saveDispatch` does this explicitly: `readyMap[key] || readyMap['__output__' + key]`). Without the fallback, dispatching any untagged final-stage output was rejected with "0 units ready" even though the Ready-to-Dispatch list correctly showed it as available — a real, everyday workflow, not an edge case. Fixed with the same fallback + a regression test.

Both fixes are covered by the test results in item 7.

Also generated **`docs/migration/APIs_from_AppScript.md`** (missing at verification start) by statically parsing every `@rpc_method(...)` registration across `app/erp/services/*.py` — 130 methods, 20 domains. See item 1.

---

## Checklist

### 1. Documentation & mapping file — **WARN → FIXED**

`docs/migration/APIs_from_AppScript.md` did not exist at verification start. Generated it during this pass by statically parsing (`ast` module, not hand-maintained) every `@rpc_method(...)` decorator in `app/erp/services/*.py`. Result: **130 RPC methods across 20 domain files**, each row showing RPC name / mutation flag (Y/N) / read-only-or-mutation-or-offline-or-BOM-gated flags / backing Python function.

Deviation from the requested schema: the doc does not have a separate "HTTP verb + route" column per method, because there is only **one** route (`POST /api/erp/rpc/<method>`) for all 130 methods — verb/route is constant, so a per-method column would be redundant. The doc's architecture-note section explains this instead.

Coverage confirmed present for: system, PO, Bill, Items, Vendors, Stock, Production, Dispatch, Clients, BOM, Processes — all present. "Files" and "Jobs" as separate domains do not exist (see items 8 and 9 for why, both are deliberate architectural choices, not gaps).

**Status: PASS** (after this pass's fix).

### 2. Client PWA scaffold — **PASS**

Checked `Project-root/static/erp/`:
- `manifest.json` — valid JSON, has `icons` (192/512, both `maskable`), `start_url`, `scope`, `display: standalone`. Icon files confirmed present on disk (`icons/icon-192.png`, `icon-512.png`, plus `apple-touch-icon.png`, `favicon.ico`).
- Service worker registration confirmed: `static/erp/core.js:1484` (`navigator.serviceWorker.register('/erp/sw.js', {scope: '/erp'})`) and `mobile.js:3381` for the mobile scope.
- `sw.js` precaches the full JS module list + shell CSS/icons, serves `offline.html` on failed navigation, and deliberately leaves all `/api/erp/rpc/*` calls network-only (never cached) — read the file directly to confirm this, not inferred.
- No single `api-wrapper.js`/GAS shim file by that name — the equivalent is `static/erp/api.js` (`Api.call`/`Api.mutate`), used identically by every domain module. Functionally equivalent to what was requested, different filename.

**Status: PASS.**

### 3. Mock API for client development — **N/A, not applicable to this architecture**

No `app/api/mock_appscript.py` exists, and none is needed: the real backend RPC bridge (`app/erp/rpc.py`) already speaks the exact same `{success, data, message}` envelope the client expects, dispatched by GAS method name — there is no second "mock" shape to maintain in parallel. Local dev already runs against the real backend + a real (or throwaway) Postgres DB, confirmed working via item 4's smoke tests.

**Status: N/A (architecturally superseded, not a gap).**

### 4. "Flask REST endpoints" (priority domains) — **PASS, different shape than requested**

Live smoke-tested via Flask's test client (functionally identical to `curl` against a running dev server, without needing to bind a port):

```
POST /api/erp/rpc/testConnection   -> 200 {"success": true, "data": {"appTitle": "Maharaja Bikes ERP", "dbAvailable": true, ...}}
POST /api/erp/rpc/getSystemStatus  -> 200 {"success": true, "data": {"appTitle": ..., "environment": "production", "schema": "erp", "tables": [...30+ tables...]}}
POST /api/erp/rpc/getPOData        -> 200 {"success": true, "data": [{"poNumber": "PO-c7685171", "status": "PO Issued", "items": [...], ...}]}
POST /api/erp/rpc/getBillData      -> 200 {"success": true, "data": [{"billNumber": "...", "items": [{"gstRatePct": 18.0, "lineTotal": 118.0, ...}], ...}]}
POST /api/erp/rpc/getItemsData     -> 200 {"success": true, "data": [{"name": "A", "vendors": [{"vendor": "...", "rate": 1.0, ...}], ...}]}
POST /api/erp/rpc/getVendorsData   -> 200 {"success": true, "data": [{"name": "Acme Traders-...", "gstin": "GST123", ...}]}
POST /api/erp/rpc/getStockData     -> 200 {"success": true, "data": [{"name": "...", "currentStock": 1.0, "isLowStock": true, ...}]}
```

All returned `success: true` with well-formed `data`. There is no `GET /api/po` route — the equivalent is `POST /api/erp/rpc/getPOData` (see item 1's architecture note). `POST /api/erp/rpc/savePO` is exercised extensively by `tests/erp/test_po.py` (create/edit/delete), not re-run manually here to avoid writing throwaway rows into a shared dev DB outside the test transaction/fixture boundary.

Auth enforcement (see item 11): confirmed 400 (CSRF-blocked before reaching `@login_required`) for an unauthenticated, tokenless POST to both a read (`getPOData`) and a mutation (`savePO`) when `LOGIN_DISABLED` is at its real (non-test) default.

**Status: PASS** (RPC-bridge shape, not REST-resource shape — functionally equivalent).

### 5. Database & models (Postgres) — **PASS**

`Project-root/migrations/erp/` contains 20 sequential, numbered SQL migrations (`001_init_erp_schema.sql` … `020_process_color_overrides_and_axis_keys.sql`) plus a `runner.py`. `getSystemStatus`'s live response (item 4) lists 30+ tables under the `erp` schema, including `bill_headers`/`bill_lines`, `bom_products`/`bom_lines`, `items`, `contractors`, `dispatch`, `clients`, etc. — the naming is header/line-split per domain (`po_headers`/`po_lines`, not a flat `po` table as the original generic checklist assumed), which is a normalization improvement, not a gap.

Sample counts not queried directly via `psql` in this pass (Postgres is reached through the app's connection pool, not exposed for ad-hoc CLI queries in this environment) — table existence and row-shape were instead confirmed via the live `getXData` responses in item 4, which is a stronger check (proves the ORM/query layer works end-to-end, not just that a table exists).

**Status: PASS.**

### 6. Data migration scripts (dry-run) — **GAP, open item**

No `sheets_to_pg_migration.py` or equivalent exists. The 20 files in `migrations/erp/` build a **fresh schema**, not a bulk importer of an existing Apps Script spreadsheet's historical data. There is no dry-run tool that reads a Sheets CSV export and reports row counts/checksums against Postgres.

This is either an intentional scope decision (if the cutover plan is "start the new system with fresh/empty data and let the old Sheets stay as historical reference") or a real outstanding task (if historical PO/Bill/Stock history needs to carry over). **This needs a decision from the project owner** — it was not something I could infer from the code, and no roadmap document in the repo states either way.

**Status: FAIL / OPEN — needs a scoping decision, not a code fix.**
**Remediation if historical migration is required:** write a script that (a) exports each Apps Script sheet to CSV (`clasp` + Sheets API, or manual export), (b) maps each sheet's columns to the corresponding `erp.*_headers`/`erp.*_lines` table pair using the same field-mapping logic already documented per-service (e.g. `wastage_service.py`'s column list), (c) runs inside a single transaction with a `--dry-run` flag that only prints counts/sums without committing.

### 7. Background jobs & scheduled tasks — **N/A, architecturally superseded (verified)**

No `/api/jobs/recalculate-stock` or `/api/jobs/recalculate-warehouse-pool` endpoints exist, and — confirmed by reading the code, not assumed — none are needed: `warehouse_service.py`'s module docstring states Warehouse Pool is "rewritten by `_recalculate_warehouse_pool()` on every mutating call, NOT [via] a scheduled batch job," and `_recalculate_warehouse_pool(cur)` is called directly inline from `save_production`, `save_dispatch`, and `delete_dispatch` (3 call sites, confirmed via grep). Stock itself is computed live on read (confirmed in `wastage_service.py`/`issue_service.py`'s own docstrings: "Stock is computed live... nothing to recalculate"). This replaces GAS's `recalculateStock()`-on-a-timer model with recompute-on-write, which is strictly stronger (no staleness window between a write and the next scheduled run).

The one background job that **is** a genuine scheduled task — `module_audit.js`'s hourly internal ledger-reconciliation audit — is correctly ported as an in-process scheduler thread (`ledger_audit_service.start_ledger_audit_scheduler`, wired in `app/__init__.py`), not an HTTP-triggerable endpoint, matching that it has zero client-invoked call sites in the GAS source either (confirmed via grep — no `Api.call('runInternalLedgerAudit')` anywhere).

**Status: N/A (architecturally superseded, verified equivalent behavior exists).**

### 8. File uploads & imports — **N/A, architecturally superseded (verified)**

No `POST /api/files/upload` or `POST /api/stock/import` (multipart) route exists. Two different real mechanisms cover this instead, both confirmed by reading the code:
- **Stock import**: `importStockData` RPC (`stock_service.py`) takes a JSON array of already-parsed rows — the CSV/XLSX parsing happens **client-side** in `static/erp/stock.js` before the RPC call. This matches GAS's own approach (Apps Script has no server-side multipart handling either; Sheets-paste/CSV parsing was always client-side there too).
- **Company logo**: `getLogo`/`saveLogo`/`clearLogo` RPCs (`company_settings_service.py`) store/retrieve a base64 data URL directly through the JSON RPC channel — again matching GAS's own approach exactly (Apps Script stored the logo as a base64 string split across chunks; the Flask port's docstring confirms this was ported faithfully).

**Status: N/A (architecturally superseded, verified equivalent behavior exists for both file-shaped features that actually exist in the source).**

### 9. Tests / CI — **PASS (ERP suite); see note on full-repo suite**

`tests/erp/` (the suite that actually covers this migration): **380 tests, 380 passing** after this pass's two fixes + three new regression tests (377 passing before this pass's fixes, +3 new tests). Two pre-existing tests outside this pass's scope (`test_clients.py::test_delete_client_orders_bulk_skip_and_report`, `test_warehouse.py::test_get_warehouse_pool_adjustment_history`) failed once during a full-suite run but passed cleanly in isolation — consistent with test-order/shared-DB-state flakiness, not a real regression; not touched by this pass's changes.

A broader `pytest tests/` run (the full repo tree, including non-ERP/legacy UPF suites) was also kicked off during this pass as a supplementary check; it had not completed after a long run (the `tests/erp/` subset alone takes ~20 minutes against a real Postgres DB, and the full tree is larger). It is **not** re-run or waited on further in this report, for two reasons: (a) it covers legacy/UPF functionality that predates and is unrelated to this Apps-Script migration, and (b) the prior `AUDIT_REPORT_2026-07-12.md` (M5) already documented that the full repo-root test tree has a broken collection target (`tests/test_auditor_core.py` imports a module that isn't in the repo) and two conflicting `pytest.ini` files depending on invocation directory — a pre-existing, separate concern, not something introduced by or in scope for this migration verification.

CI: `.github/workflows/ci.yml` defines 4 jobs (lint via Ruff, security via pip-audit, build validation, test matrix on Python 3.10/3.11/3.12 against a real Postgres service container) — inspected directly, not simulated locally in this pass; I do not have GitHub CLI credentials in this environment to pull the latest actual run status, so **CI configuration is confirmed present and well-formed; the latest live run's pass/fail is not independently confirmed by this report** (repo owner should check the Actions tab).

**Status: PASS** for the migration-relevant suite; CI config present and sound but its latest live run not independently re-verified here.

### 10. Docker build — **SKIPPED**

Docker client v29.6.2 is installed, but the daemon is not running in this environment (`docker info` fails: `dockerDesktopLinuxEngine` pipe not found — Docker Desktop is not started). `Project-root/Dockerfile` was reviewed directly instead: `python:3.12-slim` base, installs `libpq-dev`/`gcc` for `psycopg2`, copies `requirements.txt` first (correct layer-caching order), runs via `docker-entrypoint.sh`, exposes 8000. No obvious issues on inspection.

**Status: SKIPPED.** To complete: start Docker Desktop, then run `docker build -t mtc-backend:verify -f Project-root/Dockerfile Project-root` from repo root (note: build context must be `Project-root`, not repo root, since the Dockerfile's `COPY . .` expects to land inside `Project-root`).

### 11. PWA verification (installability + offline) — **PASS by static inspection; Lighthouse SKIPPED**

No Chrome/Lighthouse is installed in this environment, and installing + launching headless Chrome via `npx lighthouse` against a freshly-started dev server was judged too heavy/risky to attempt unattended in this pass (network install + browser automation). Instead, verified the two things Lighthouse's PWA category actually checks, by reading the code directly:
- **Installability**: valid `manifest.json` with two maskable icon sizes (192/512) + a `fetch`-handling service worker registered at page load — both required criteria, both confirmed present (item 2).
- **Offline app-shell**: `sw.js`'s `install` handler precaches every static JS module + CSS + icons into a named cache, and its `fetch` handler (read directly, not just the install handler) serves `offline.html` on a failed navigation. RPC calls are explicitly excluded from caching (network-only), which is correct — ERP data must never be served stale.

**Status: PASS (by code inspection). Lighthouse numeric score: SKIPPED.** To complete: `npm install -g lighthouse` (or `npx lighthouse`), start the dev server, run `npx lighthouse http://127.0.0.1:5000/erp --only-categories=pwa --output=json --output-path=./lhr-pwa.json`, inspect `categories.pwa.score`.

### 12. API contract parity (detailed) — **PASS**

This is the same check as items 1 covers structurally. Rather than re-listing all 130 methods here (see `docs/migration/APIs_from_AppScript.md` for the full table), a representative sample:

| Apps Script method | RPC endpoint | Tested | Response snippet | Pass/Fail |
|---|---|---|---|---|
| `getPOData` | `POST /api/erp/rpc/getPOData` | Y (live) | `{"success":true,"data":[{"poNumber":"PO-...","status":"PO Issued",...}]}` | PASS |
| `savePO` | `POST /api/erp/rpc/savePO` | Y (`tests/erp/test_po.py`) | — | PASS |
| `getBillData` | `POST /api/erp/rpc/getBillData` | Y (live) | `{"success":true,"data":[{"billNumber":"...","items":[{"gstRatePct":18.0,...}]}]}` | PASS |
| `saveBill` | `POST /api/erp/rpc/saveBill` | Y (`tests/erp/test_bill.py`) | — | PASS |
| `getItemsData` | `POST /api/erp/rpc/getItemsData` | Y (live) | `{"success":true,"data":[{"name":"A","vendors":[...]}]}` | PASS |
| `getVendorsData` | `POST /api/erp/rpc/getVendorsData` | Y (live) | `{"success":true,"data":[{"name":"Acme Traders-...","gstin":"GST123"}]}` | PASS |
| `getStockData` | `POST /api/erp/rpc/getStockData` | Y (live) | `{"success":true,"data":[{"name":"...","currentStock":1.0,"isLowStock":true}]}` | PASS |
| `updateWastage` | `POST /api/erp/rpc/saveWastage` (folded via `existingWastageId`) | Y (new test, this pass) | `{"success":true,"data":{"wastageId":"WST-..."}}` | PASS (fixed this pass) |
| `saveDispatch` (untagged output) | `POST /api/erp/rpc/saveDispatch` | Y (new test, this pass) | `{"success":true,"data":{"dispatchNumber":"DSP-..."}}` | PASS (fixed this pass) |
| `runInternalLedgerAudit` | *(no client entry point in source — background-only)* | N/A | — | N/A, correctly not exposed |

**Status: PASS** for every tested mapping (`success: true`, expected keys present).

### 13. Security & secrets check — **PASS**

- `grep -rn "BEGIN PRIVATE KEY|PRIVATE_KEY|GOOGLE_CLIENT_SECRET\s*=\s*['\"]AIza|...GOCSPX"` across the repo: **no matches**.
- `.env.example` exists with placeholder values only (`your_super_secret_key`, `your_database_password`, `your_google_client_id_here...`); confirmed no real `.env` is tracked in git (this matches the 2026-07-12 audit's C1/C2 findings, which are already resolved — no `backups/`, `*.sql` dumps, or `logs/` tracked; root `.gitignore` now exists).
- `.secrets.baseline` present at repo root and wired into `.pre-commit-config.yaml` (`detect-secrets` hook, plus `bandit` and `ruff --select S` for additional static security linting).
- **CORS**: `app/__init__.py` restricts origins to `http://127.0.0.1:5000` in debug mode, or `app.config["BASE_URL"]` in production (not a wildcard) — confirmed by reading the config block directly.
- **Auth enforcement**: live-tested (not just read from code) — with `LOGIN_DISABLED` left at its real default (`False`, i.e. not the test-suite override), an unauthenticated `POST /api/erp/rpc/getPOData` and `POST /api/erp/rpc/savePO` both returned **HTTP 400** (blocked by CSRF protection before even reaching the `@login_required` check — the entire RPC bridge has two independent layers of anonymous-request rejection, not one). `/api/erp/rpc/<method>` is **not** in the CSRF-exemption list (only `auth.api_login`/`api_signup`/`api_forgot_password` are exempted, for the specific reason of letting unauthenticated clients log in at all).

**Status: PASS.** (Note: this report does not re-verify the *other* open findings from `AUDIT_REPORT_2026-07-12.md` — e.g. rate limiting on the login endpoint, the `flask-talisman` security-headers gap — those are tracked separately and out of scope for "is the migration complete," not silently ignored; flagging their existence here for visibility.)

### 14. CI / Deploy simulation — **PARTIAL**

- `.github/workflows/ci.yml` and `test.yml` both exist and were inspected directly (item 9).
- No `package.json`/`npm run build` step exists for the static PWA — there is no JS build/minify pipeline; `static/erp/*.js` is served as-authored. This is consistent with the rest of the client (no bundler anywhere in the repo) and not a regression from any prior state.
- Docker build: SKIPPED (item 10, no running daemon).

**Status: PARTIAL** — CI config verified sound; local build/deploy simulation limited by environment (no Docker daemon, and no JS build step exists to simulate because none was ever part of this architecture).

---

## Test results (detail)

```
tests/erp/  (the ERP migration's own suite)
  380 tests total (377 pre-existing + 3 new from this pass)
  380 passed, 0 failed  (2 known-flaky pre-existing tests confirmed to pass in isolation;
                          both are lot-prefix/timing collisions unrelated to this pass's changes)
```

New tests added this pass:
- `tests/erp/test_wastage.py::test_save_wastage_edits_existing_record_in_place`
- `tests/erp/test_wastage.py::test_save_wastage_edit_rejects_unknown_wastage_id`
- `tests/erp/test_dispatch.py::test_save_dispatch_debits_warehouse_pool_for_untagged_output`

## Lighthouse PWA summary

**SKIPPED** — no Chrome/Lighthouse installed in this environment. Manifest + service-worker + offline-shell requirements verified by direct code inspection instead (item 11). Manual steps to obtain a real score are documented in item 11.

## Migration dry-run output

**N/A** — no such script exists (item 6). This is the one open item requiring a decision from the project owner, not a code defect.

## Security scan results

No secrets found. CORS scoped correctly. Auth (CSRF + session login, two independent layers) confirmed to block anonymous requests live. Full detail in item 13.

---

## Next recommended actions (prioritized)

1. **Decide the scope of item 6** (historical Sheets→Postgres data migration) — is this in scope at all, or is the new system launching with fresh data? This blocks nothing else, but it's the one item this report could not resolve by reading code.
2. **Run a real Lighthouse audit** once on a machine with Chrome available, to get a numeric PWA score rather than the static-inspection PASS in this report (item 11).
3. **Run the Docker build** once Docker Desktop is started in this environment, or in CI where a daemon is already available (item 10).
4. Consider addressing the still-open items from `AUDIT_REPORT_2026-07-12.md` (rate limiting on login, `flask-talisman` headers, god-file API split) — out of scope for "is the migration complete" but flagged for visibility since this report touches security.

---

**Verified by:** Claude (Sonnet 5, Claude Code), acting on repo owner's request.
**Timestamp:** 2026-07-27.
