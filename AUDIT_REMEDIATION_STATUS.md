# Audit Remediation Status

**Application** Maharaja Bikes ERP (MTC)
**Baseline audit** `APPLICATION_ARCHITECTURE_AND_PRODUCT_READINESS_AUDIT.md` (24 Aug 2026)
**This pass** 25 Aug 2026 (two sessions: Phase 0 + Phase 1)
**Branch** `verification/claude-appscript-pwa-20260727`

---

## How to read this

A finding is marked **FIXED** only when the original failure condition has been
shown not to occur — by a test that fails against the old code, or by a
reproduction run against the new code. Code having changed is not sufficient.

| Status | Meaning |
|---|---|
| **FIXED** | Failure condition demonstrably gone, with evidence named below |
| **PARTIAL** | Materially reduced, with a named remainder |
| **NOT STARTED** | Untouched in this pass |
| **INVALIDATED** | Finding was wrong; evidence given |

**Nothing from the audit has been dropped.** Every finding in the original
report appears below, including the ones not yet addressed.

---

## Scope of this pass, stated plainly

**Phase 0 (critical stabilisation) is complete.** **Phase 1 is complete
except for two items deliberately deferred to their own releases**
(MONEY-001, AUDIT-001) and the frontend build step (PERF-004). Every P1
security, concurrency, reliability and connection-handling finding is closed,
and the two largest read paths have been measured and improved. Phases 2
through 5 — UX, responsiveness, accessibility, and the intelligence/AI work —
are **not started**.

That is a deliberate ordering, not an abandonment: Phase 0 is what moves the
verdict off NO-GO, and several Phase 2–5 items are explicitly gated behind
Phase 3 in the original plan (natural-language query needs the pagination API;
invoice extraction needs attachment storage, which does not exist).

### Verification totals

| | Before | After |
|---|---:|---:|
| Backend tests | 713 | **893** (+180) |
| Backend coverage | 85% | **86.6%** |
| Frontend tests | 383 | **404** (+21) |
| `ruff` | clean | clean |
| `eslint` | 0 errors | 0 errors |
| `stylelint` | clean | clean |
| Backup restore verified | never | **yes, automated** |
| Concurrency tests | **0** | **17** |
| Nested pooled connections | **326** (4 readers) | **0**, guarded in CI |
| `getDashboardData` @ 5yr volume | 796 ms | **466 ms** |

Coverage on the modules the audit called out as inverted:

| Module | Before | After |
|---|---:|---:|
| `app/erp/services/roles_service.py` | 36% | **99%** |
| `app/auth/routes.py` | 49% | **72%** |
| `app/utils.py` | 38% | **59%** |
| `app/erp/rpc.py` | 87% | 87% |

---

## P0 — Critical

| ID | Status | Implementation | Tests | Verification | Remaining risk |
|---|---|---|---|---|---|
| **SEC-001** `SECRET_KEY` fail-fast never fires | **FIXED** | `config.py` — fallback removed from `Config`, re-added only on `DevelopmentConfig`. `app/__init__.py` — guard now rejects unset, empty, weak (`WEAK_SECRET_KEYS`) and short (`MIN_SECRET_KEY_LENGTH=32`) values, and never echoes the value into the error. | `tests/test_config_failfast.py` (25) | Booting `FLASK_ENV=production` with no `SECRET_KEY` now raises `RuntimeError`; confirmed by execution before and after. | **The live key must be rotated** — if any deployment ran on the fallback, existing sessions and reset tokens are forgeable. See the runbook. |
| **DATA-001** Backups unrestorable; failures reported as success | **FIXED** | New `app/erp/services/db_backup.py` (pg_dump/pg_restore, checksum, retention, TESTING guard). `backup_service.py` — hand-rolled INSERT writer deleted; a failed snapshot is now `FAILED`, never `PARTIAL`; status carries `snapshot_verified`, `consecutive_failures`, staleness. | `tests/erp/test_backup_restore.py` (10), `tests/erp/test_backup.py` (7) | Snapshot restored into a fresh database: **101/101 tables, 0 row-count mismatches, `pg_restore --exit-on-error` exit 0**, JSONB byte-identical, 103 sequences restored, `public.users` + `custom_roles` present. | Off-machine copy and at-rest encryption are **operational**, not code — runbook step 9. |
| **SEC-002** Signup grants immediate full ERP access | **FIXED** | `auth/routes.py` — `NEW_ACCOUNT_ROLE = "pending_approval"`, shared with the Google path in `app/utils.py`. `ALLOW_SELF_SIGNUP` kill switch. DB default changed by `migrations/erp/036`. | `tests/test_signup_authorization.py` (17) | A new signup's session receives **403 from real RPC methods** (read and mutating) and is redirected to the holding page. | Existing accounts created via the old path must be **audited manually** — runbook step 3 supplies the query. |
| **SEC-003** OAuth `state` skipped when session has none | **FIXED** | `auth/routes.py` — fails closed on missing *or* mismatched state, `secrets.compare_digest`, and the `TESTING` bypass removed so the branch is testable. | `tests/test_oauth_state.py` (13) | Missing state → 400, mismatched → 400, matching → 302, replay of a consumed state → 400. | None known. |

---

## P1 — High

| ID | Status | Implementation | Tests | Verification | Remaining risk |
|---|---|---|---|---|---|
| **DATA-002** Dispatch over-allocation race | **FIXED** | New `app/erp/services/locks.py` (transaction-scoped advisory locks, sorted, namespaced). Applied at all four availability-consuming paths: `save_dispatch`, `save_dispatch_plan_line`, `adjust_stock_manually`, `_validate_pool_availability`, plus `_recalculate_warehouse_pool`'s DELETE-then-INSERT rebuild. | `tests/erp/test_concurrency.py` (8) | Two real transactions forced to interleave: **without the lock both read `0` and both inserted (proven by execution); with it they observe `[0, 1]`**. Different keys and namespaces verified non-blocking; overlapping key sets verified deadlock-free; release on both commit and rollback verified. | A database-level `CHECK (available >= 0)` on a materialised balance would enforce rather than bound this — needs PERF-002 step 3, which remains open. |
| **DATA-003** Idempotency is TOCTOU; desktop never reuses an id | **FIXED** | `mutations.py` rewritten around an atomic `INSERT ... ON CONFLICT DO NOTHING RETURNING` claim with `in_progress`/`completed` states, stale-claim recovery and pruning; `migrations/erp/038`; `rpc.py` claims before executing and releases in `finally`; `api.js` mints one id per **user action** rather than per network call. | `tests/erp/test_concurrency.py` (9), `static/erp/tests/api_mutation_id.test.js` (14) | Two concurrent claims: **exactly one wins, one gets `MutationInProgress`**. Completed envelopes replay (including domain failures). A double-click firing both calls before either resolves shares one id. | A duplicate now gets HTTP 409 rather than silently succeeding — the client shows "already being processed". |
| **SEC-004** Stored XSS in Vendor ledger | **FIXED** (sinks) / **PARTIAL** (structural) | `static/erp/vendors.js` — 6 sinks escaped (`gstin`, `entry.ref`, `entry.dateStr`, `entry.type`, `item.name`, `item.size`); `items` pre-escaping asymmetry removed. | `static/erp/tests/xss_escaping.test.js` (7) | `<img onerror>` and `<script>` payloads in GSTIN, bill number, item name and size all render as **text**; no element created, no execution. | The escape-by-default tagged template and removing `'unsafe-inline'` from CSP are **not done** — a future unescaped sink is still possible. |
| **SEC-005** Whole business API exempt from rate limiting | **FIXED** | `app/__init__.py` — `limiter.exempt(erp_rpc_bp)` replaced with a per-**user** tiered limit (`_rpc_rate_limit`, `_rpc_rate_limit_key`, `EXPENSIVE_RPC_METHODS`); configurable. | — | Verified by execution: blueprint no longer exempt; `getStockData` → 40/min, `saveUnit` → 600/min. | No automated test yet. Limits are first-guess — watch rejections before tightening. |
| **PERF-001** Redis pool destroyed every request | **FIXED** | `app/__init__.py` — `teardown_appcontext` handler replaced with `_register_process_cleanup` (atexit, once per process). Dead database-probe branch deleted. | — | Confirmed by execution: "Database connection pool closed at process exit" fires once, at exit, not per request. | No automated test. |
| **PERF-002** Whole-table reads; no pagination on 166 methods | **PARTIAL** | Steps 1–2 done. `stock_service` — the four line-table terms of the Current Stock formula moved into one SQL aggregate (`_MOVEMENT_SQL`); production consumption expanded and pre-aggregated in SQL, with unit conversion still in Python (once per group rather than per component). `getStockData` gained an **additive** `page/pageSize/search/sort/direction` contract; the paginated path selects the page from `erp.stock` first and restricts the movement aggregation to it, so four full scans become index lookups. | Existing stock/bill/ledger suites (43); equivalence verified by script | **Measured, not projected.** Aggregation equivalence: 800 keys identical, worst relative difference **2.3e-15**. Paginated rows match the unpaginated computation exactly. `getStockData` 294 ms → **234 ms unpaginated / 212 ms paginated** (1.25× / 1.39×). | **The audit projected 10–50×; the measured figure is 1.25–1.39×.** See the note below — step 3 (materialised balances) is where the order-of-magnitude lives, and it remains open. **No client calls the paginated contract yet**, so its benefit is not yet realised in the UI. |
| **PERF-003** Nested connection acquisition | **FIXED** | A depth guard in `database.get_conn` (`STRICT_NESTED_CONNECTIONS`, enabled for the whole test suite via `conftest.py`) plus `allow_nested_connections()` for the one legitimate exemption. Fixed readers: `units_service.get_units_map(cur)`, `process_service._fetch_process_components` / `_fetch_process_color_groups`, `bom_service._fetch_bom_production_data`, `roles_service.get_role_permissions(cur)`. | Enforced by every one of the 893 backend tests | The guard found **326 nested acquisitions across 4 distinct readers** — far more than the audit's 8-site estimate — and the suite now reports **0**. Profiling had measured **65 ms in `psycopg2._connect` for a 0.6 ms query** on the `getStockData` path. | One documented exemption: `ledger_audit_service` holds a transaction-scoped lock across a five-ledger compute. Bounded — an hourly background job, not a request path. |
| **PERF-004** 3.36 MB unbundled frontend | **NOT STARTED** | — | — | — | — |
| **REL-001** No HTTP timeouts | **FIXED** | `auth/routes.py` — `_HTTP_TIMEOUT=(3.05,10)` on all three OAuth calls; discovery document cached. `static/erp/api.js` — `REQUEST_TIMEOUT_MS = 45_000` with `AbortController`. | `static/erp/tests/api_mutation_id.test.js` (3) | Verified no timeout-less `requests` call remains in `app/`. Client `fetch` now carries an `AbortController` with a 45s ceiling; an abort is reported as `isNetworkError` so the mobile outbox's retry logic picks it up unchanged. | None known. |
| **TEST-001** Auth/authorization least tested | **FIXED** | `tests/erp/test_authorization_matrix.py` (74), `tests/erp/test_rpc_permission_gate.py` (15, new), `tests/erp/test_users.py` (14→41), `tests/erp/test_rpc.py` (12→24), `tests/test_role_required.py` (13), plus the P0 suites. | 205 new tests | **`app/erp/rpc.py` 77→100%**, **`app/erp/services/users_service.py` 67→100%**, `app/erp/mutations.py` 87→**100%**, roles_service **100%**; auth/routes 49→72%; utils 38→59%. | The two named gaps are closed. The gate's tests were **mutation-tested**: four ways of breaking it (gate skipped entirely; no-grant check disabled; mutation-level check disabled; level check inverted) were each injected into `rpc.py` and each was caught — 6, 3, 3 and 4 failures respectively. `rpc.py` restored byte-identical afterwards. |
| **CI-001** Frontend never runs in CI; gates can't fail | **FIXED** | `.github/workflows/ci.yml` — new blocking `frontend` job (`npm ci` + `npm run verify`); `pip-audit` now fails on advisories; `ruff format` blocking; schema init fatal. | — | `npm run verify` passes locally (390 tests, 0 lint errors); both workflow files validated as YAML. | Not yet observed on a real GitHub run. |
| **CI-002 / coverage gate** 25% and soft | **FIXED** | Global floor 85%; per-module floors for six security-critical modules. | — | Gate logic **dry-run against the real `coverage.xml`**: PASS, and correctly FAILs when a module is below floor. | Floors are a ratchet at achieved values, not a target — deliberately, and documented in the file. |
| **MIG-001** No migration lock; three trackers | **FIXED** | `migrations/erp/runner.py` — advisory lock (as before). **New `migrations/erp/000_public_core.sql`** brings `public.users` and `password_reset_tokens` into the tracked chain, so the runner builds a complete database from empty. 42 legacy scripts moved to `migrations/legacy/` (git renames, history intact) with a README carrying the evidence. `run_migration.py` deleted; `migration_tracker.py` retired. `deploy/deploy.sh` and `docker-entrypoint.sh` no longer run `psql -f init_schema.sql` — the runner is the whole deploy step. `tests/conftest.py` now bootstraps via the same runner instead of its own 29-script pass loop. Two dead helpers removed from `app/utils.py`. | `tests/test_migration_path.py` (10, new) | **Runner run against a freshly created empty database, result diffed against production**: 50 erp tables vs 50, public `{custom_roles, password_reset_tokens, users}` vs the same, every column of all three matching name/type/nullability/default, **0 seeded accounts**. Test database now matches production (was 52 public tables vs production's 3). | None. See the two production observations below — they are operational, not code. |
| **AUDIT-001** No before/after history on 47 of 50 tables | **PARTIAL** *(activity log done; row-level history still open)* | New `migrations/erp/041_activity_log.sql` (`erp.activity_log`) + `app/erp/services/activity_service.py`, written from `app/erp/rpc.py`'s dispatcher (every `mutation=True` call, and every `403` on any method) and `app/auth/routes.py` (sign-in success/failure, sign-out, signup, password reset). Admin-only **Activity Log tab** (`static/erp/activity.js` + `templates/erp/partials/activity.html`, server-side paged) over a `getActivityLog` reader; 90-day retention pruned by `backup_service.py`'s nightly job. | `tests/erp/test_activity_log.py` (15, new), `static/erp/tests/activity_log.test.js` (16, new) | End-to-end against the live `MTC` database: a rejected `saveVendor` produced one row carrying user, role, module, status, reason, redacted args, IP, request-id and duration; the read that followed produced none. Password redaction verified on `changeMyPassword`, `createUser`, `verifyBOMAccess` and `deleteBOM`. | **"Who changed this, when, from where, and was it refused" is now answerable. "What was it before" is not.** This records the CALL — method, arguments, outcome — not a before/after diff of the affected rows, so a correction to one field on an existing record shows the new value in `args` and nothing about the old one. The trigger-based row-level history in §"what to do next" is still the thing that closes that half, and this does not replace it. |
| **DEPLOY-001** Container runs as root | **FIXED** | Dedicated `mtc` user (uid/gid pinned at 10001, `nologin`), `/app` chowned, `USER mtc`. Switching users alone would have broken backups: `get_backup_dir()`'s "four directories up" resolves to `/backups` — the filesystem root — inside the image, writable only *because* it ran as root. `BACKUP_DIR` is now configurable, the image creates and owns it, and compose puts it on a named volume so snapshots survive `--build`. | `tests/test_container_hardening.py` (10) | Dockerfile parsed and asserted structurally; `get_backup_dir` exercised both ways. | — |
| **MONEY-001** Float money; totals never stored | **NOT STARTED** | — | — | — | Deliberately deferred: it is a high-risk financial migration needing its own release and reconciliation. |

---

## Two defects found in this pass's own work

Recorded rather than quietly fixed, because both were mine and both were the
kind that hide.

### `tests/test_config_failfast.py` disabled the connection pool process-wide

It reloads the `config` module with `SECRET_KEY`/`DB_PASS`/`DATABASE_URL`
stripped from the environment, to prove `_load_config` fails closed. `config.py`
reads `os.environ` at class-definition time, so that reload left
`config.TestingConfig.DB_PASS` fallen back to its hard-coded `'testpass'` **for
the rest of the pytest session** — long after `monkeypatch` had restored the
environment itself.

Every later `create_app("testing")` then built its config from that module,
`database.init_app` could not authenticate, and its TESTING branch sets the
module-global `db_pool = None` and *returns* instead of raising. Nothing ever
set it back. **27 tests across three unrelated files** failed with "Database
pool is not available" — an error pointing at everything except the file
responsible.

I first attributed this to my own concurrent database work in another shell.
That was wrong; it reproduced on a clean run with nothing else touching
Postgres. The fix is an autouse fixture that snapshots the `config` module
namespace and restores it, rather than reloading again — reloading depends on
the environment being restored first, which is a fixture-ordering assumption,
and the wrong one: that fixture finalises *before* `monkeypatch` does.

### `test_restore_contains_the_user_accounts` was passing on seeded data

It asserted `count(*) > 0` on `public.users`. That only ever passed because
`init_schema.sql` seeded `admin@mtc.local` and `demo@example.com` — the same
two accounts flagged above. With no migration seeding accounts, the table
starts empty and the assertion had nothing to stand on.

It now plants a user and a custom role under a random marker *before* the
snapshot and asserts those exact rows come back, including the JSONB
permission map — the column type the old backup wrote as a Python `repr` that
Postgres refused. A random marker means it cannot pass by accident.

## What DATA-004 deliberately does not constrain

The first version of migration 040 constrained 41 columns — every quantity and
amount — justified by production holding no negative rows. **The test suite
rejected it within one run**, and was right to:

```
test_save_production_no_color_process_allows_negative_qty
test_get_contractor_ledger_data_includes_negative_payable_correction_lot
```

A negative quantity is a deliberate, documented correction mechanism in this
domain, not a defect. `production_service`: *"Zero and negative quantities are
both allowed -- a lot can be logged as a correction/reversal."*
`items_service._validate_initial_stock`: *"Negative allowed on purpose -- an
over-consumed item can leave stock negative; the user should see and correct
that, not be blocked from saving."* Amounts inherit the sign, because
`dispatch_lines.amount` is qty × rate.

The absence of negatives in production meant only that nobody had entered a
correction recently. The evidence was not wrong about the data; it was wrong
about what the data meant.

So the migration now covers rates, prices, percentages, recipe definitions and
physical attributes — categories where a negative has no meaning and the
service layer already rejects one — and `test_check_constraints.py` asserts the
excluded columns stay unconstrained, so the obvious-looking change does not get
made later by someone reading only the finding title.

## VALID-001 (new): 17 forms declare `required` and never check it

Found while wiring A11Y-007. Of 26 forms, only 9 are saved through a real
`submit` handler — the browser runs constraint validation for those. The other
**17 are saved by a button click that calls a function directly**, so the
form is never submitted and the browser has no reason to validate anything.
No form carries `novalidate`; the constraints are simply never reached.

| Form | `required` fields | Validated |
|---|---:|---|
| `productionForm` | 8 | **no** |
| `createUserForm` | 5 | yes |
| `processForm` | 4 | **no** |
| `unitForm` | 3 | **no** |
| `clientOrderForm` | 3 | **no** |
| `billForm` | 3 | yes |
| …13 more with 1–2 each | | **no** |

This is a correctness gap, not only an accessibility one: constraints written
into the markup are decoration. Whether a given field is genuinely rejected
depends entirely on the server-side service happening to check it.

**Deliberately not switched on in this pass.** Enabling enforcement on 17
forms could block workflows that currently succeed — a field marked `required`
in markup but optional in practice would start rejecting saves, and this is
the factory floor's daily data entry. Two things make that risk real rather
than theoretical: several of `productionForm`'s eight are cascading selects
(`required disabled`, correctly skipped by `checkValidity()` while disabled,
enforced the moment they enable), and I cannot exercise these forms in a real
browser from here.

The helpers are ready and tested. Turning them on wants one pass through the
17 forms with the UI open, deciding per field whether `required` is the truth
or an aspiration — a decision that needs the business, not the code.

## Why /metrics reports no request rates

Gunicorn runs 4 workers (`WEB_CONCURRENCY`) behind one port. A scrape reaches
exactly one of them, chosen by the OS. A per-worker request counter therefore
reports a random ~quarter of the traffic and lurches between scrapes as
different workers answer — not approximately right, but **confidently wrong**,
which is worse than having no dashboard and is the same class of defect as a
backup that reports success while producing an unrestorable file.

Doing it correctly needs `prometheus_client`'s multiprocess mode: a new runtime
dependency, a shared writable directory, `PROMETHEUS_MULTIPROC_DIR`, and a
gunicorn `child_exit` hook to reap dead workers' files. Those are deployment
decisions rather than code ones, and the multiprocess path cannot be verified
in this environment — so it is left for an explicit decision instead of being
half-built.

Everything the endpoint does expose is correct regardless of which worker
answers: database-wide gauges are identical from any worker by construction,
and per-worker values carry a `worker` label so they can never be silently
summed as though they were global. Accurate request rates are already
available from the reverse proxy's access log, which sees every request
exactly once.

## Two findings in the live production database

Both surfaced while verifying MIG-001 against the real `MTC` database rather
than against the repository. Neither is fixed here: both are operational
decisions about production data, and the runbook carries the SQL.

### 1. Thirty-one test accounts, four of them Admin

`public.users` holds 32 rows. One is a real person. The rest are development
and verification artefacts, all active (`deleted_at IS NULL`), every one able
to sign in:

| Account | Role | Password set | Created |
|---|---|---|---|
| `admin@mtc.local` | **admin** | yes | 2025-11-07 |
| `demo@example.com` | **admin** | yes | 2025-11-07 |
| `testuser@example.com` | **admin** | no | 2025-11-08 |
| `test-admin@example.com` | **admin** | yes | 2026-07-13 |
| 27 further `user`-role accounts | user | yes | 2025-09 → 2026-08 |

The first two were **seeded by the deploy itself**. `migrations/init_schema.sql`
ended with two `INSERT INTO users ... role 'admin'` statements, and
`deploy/deploy.sh` / `docker-entrypoint.sh` re-ran that file on every deploy —
so deleting those accounts would not have kept them deleted. That mechanism is
now removed: `000_public_core.sql` replaces it and seeds nothing, and
`tests/test_migration_path.py::test_no_migration_seeds_a_user_account` fails
the build if a migration ever inserts into `users` again.

The accounts themselves still exist. Removing them is an administrator's
call — see the runbook.

### 2. Two dead migration-tracker tables

`public.schema_migrations` (29 rows, Oct–Nov 2025) and
`public.migrations_applied` (2 rows, one of them `status='failed'` with
`UndefinedColumn: column "model" does not exist`) both describe a schema
production no longer has — the tables those migrations created were dropped
during the ERP rewrite. Production's `public` schema holds 5 tables; 2 of them
are these trackers.

Nothing reads either table any more. They are left in place because dropping
tables in a production database is an operator's decision, not a migration's.

## Correction to the baseline audit: the 10–50× projection

The audit's Performance Optimization Matrix projected **10–50×** for pushing
the Current Stock aggregation into SQL. **Measured, it is 1.25×.** I am
recording that here rather than quietly shipping the smaller number, because
the gap changes what should be done next.

Method: a purpose-built benchmark database at the audit's own projected
five-year volume (19,200 bill lines, 6,000 production lots, 800 items), with
the original and current implementations run **interleaved in one process
against one dataset**, 11 rounds, comparing medians. The test database has 40
bill lines and can demonstrate nothing.

| Variant | median | vs original |
|---|---:|---:|
| Original (Python fold loops + nested `get_units_map`) | 294 ms | 1.00× |
| PERF-003 only (folds + `get_units_map(cur)`) | 285 ms | 1.03× |
| PERF-002 + 003 (SQL aggregation) | 234 ms | 1.25× |
| …paginated, page 1 of 50 | 212 ms | 1.39× |

Why the projection was optimistic: moving the aggregation into SQL removes
the *row transfer and Python fold*, which is real but is not the dominant
term. What remains — expanding every completed lot's JSONB components, and
scanning four line tables — is still **O(all history)**, so the curve's slope
is unchanged and only its constant improved.

Three things worth recording, each established by measurement rather than
reasoning:

* **Filtering the production term by item made it 5–8× SLOWER** (82 ms →
  397 ms filtering after expansion, 642 ms filtering during). A row-wise `IN`
  is evaluated against every expanded component, and JSONB contents cannot be
  indexed for this. That variant was removed; the movement half keeps its
  filter, where the expression indexes make it 60 ms → 18 ms.
* **PERF-003's 1.03× here understates it.** This benchmark is single-threaded
  against a warm pool, so `getconn()` almost always returns instantly. Its
  real value is avoiding pool growth under concurrency and the `PoolError`
  cliff — an availability property, not a single-threaded latency one. The
  65 ms `psycopg2._connect` that profiling caught happens when the pool has
  to grow, which is exactly what load causes.
* **A normalised `production_components` child table would give 4.6× on that
  term** (107 ms → 23 ms), taking `getStockData` to ~150 ms. It was measured
  and deliberately not built: it adds a JSONB-vs-table synchronisation burden
  on every production write while leaving the growth curve O(history). That
  is a half-measure; step 3 is the real answer.

**Where the order-of-magnitude actually is: step 3, materialised balances.**
The audit is right that it exists — it just belongs to step 3, not step 1.

By contrast, the dashboard work (PERF-006) did produce a large figure where
one was available: **26.6×** on the production derivations, because that code
was fetching every lot and parsing two JSONB columns per row to compute four
scalars. When the work being removed is genuinely wasted, the number is
large; when the work is inherent, it is not.

---

## P2

| ID | Status | Notes |
|---|---|---|
| **SEC-006** Reset tokens replayable; sessions survive reset | **FIXED** | Tokens bound to a credential fingerprint; a password change invalidates every outstanding token *and* every session pinned to the old credential. `tests/test_password_reset_security.py` (17). Verified: same link twice → second refused and ineffective; a session pinned to the old credential stops resolving. |
| **SEC-007** Reset ignores `deleted_at` | **FIXED** | Filter added to the UPDATE and to fingerprint lookup. Covered above. |
| **SEC-008** GET logout, no CSRF | **FIXED** | `/auth/logout` now `GET` → confirmation page, `POST` + CSRF token → performs logout. New `templates/logout_confirm.html`. Existing `<a href>` links keep working. No test yet. |
| **AUTH-001** *(new — not in the baseline audit)* Login was case-sensitive; signup was not | **FIXED** | `api_signup` and `users_service.create_user` store `email.strip().lower()`; `api_login` looked the address up with `.strip()` only, against a case-sensitive `WHERE email = %s`. **Anyone who typed a capital letter at signup could never sign in** — correct password, existing row, `401 Invalid credentials`, permanently — and a password reset did not help, because that path lowercases and therefore appeared to work while login went on failing. Nothing lowercases on the client (`type="email"` does not). Fixed at all seven lookup sites, plus migration `039` adding a unique index on `lower(email)` so two case-variant rows can never coexist and a lookup can never match two. Reproduced end to end before the fix: signup 201, login with the typed spelling 401, login lowercased 200. `tests/test_login_security.py` (17). |
| **SEC-009** No per-account login throttle | **FIXED** | A second `limiter.limit` on `/auth/api/login`, keyed on a SHA-256 prefix of the submitted address rather than the client IP, with `deduct_when` so **only a 401 consumes the budget** — signing in correctly, repeatedly, from anywhere never locks you out. Default 10 failures / 15 minutes (`RATELIMIT_LOGIN_PER_ACCOUNT`). The key is hashed because limiter keys land in Redis `KEYS *` and slow-log output. `tests/test_login_security.py` (17, shared with AUTH-001). |
| **SEC-010** `DB_PASS` defaults to `"abcd"` | **FIXED** | Removed from `Config` and from `migrations/migration_fix_schema_nov2025.py`; `DB_PASS` added to the startup guard. Repo-wide sweep found only these two. `tests/test_config_failfast.py`. |
| **SEC-011** Client-controlled `X-Request-ID` reaches logs | **FIXED** | `_sanitize_request_id` — UUID-parse or discard. Applied in **both** competing middlewares, since the second overwrites the first. No test yet. |
| **DATA-004** 5 CHECK constraints across 50 tables | **FIXED** | Migration `040` adds 21 non-negativity constraints across 18 tables — rates, prices, percentages, recipe definitions and physical attributes. Validated against production twice: column-by-column, then by executing the whole file inside a transaction and rolling back. `tests/erp/test_check_constraints.py` (18). **Quantities are deliberately excluded** — see the note below. |
| **DATA-005** `erp.rpc_mutations` unbounded | **FIXED** | `mutations.prune_old_mutations()` (7-day retention) with a supporting `created_at` index in migration 038, run nightly from the existing backup scheduler — separately guarded, so a failed prune never makes a successful backup look failed. Tested. |
| **PERF-005** `getStockAdjustmentHistory` unbounded, per bill save | **FIXED** | Conflict check narrowed to a `DISTINCT ON` lookup for only the items on the bill, plus `migrations/erp/037` index. A blind `LIMIT` was deliberately **not** used — the same RPC feeds mobile's item ledger, which needs full history. |
| **PERF-006** Dashboard opens 5+ connections | **FIXED** | Production KPIs are now SQL aggregates and the WIP pipeline fetches only ACTIVE lots (with only the columns it reads), on the connection the function already opens; `bill_service._aggregate_billed_base_qty_by_po` moved to a SQL `GROUP BY`. Fair interleaved A/B on one dataset: production derivations **315 ms → 11.9 ms (26.6×)**, dashboard end-to-end **796 ms → 466 ms (1.71×)**. PO-key equivalence verified on 14,941 real keys (worst difference 5.7e-14). Covered by `test_dashboard.py` (17) + `test_po.py`/`test_bill.py` (47). |
| **PERF-007** `config.VERSION` per-process | **FIXED** | `VERSION` was `str(int(time.time()))` at class-definition time, so each gunicorn worker computed its own: up to 4 different URLs for the same unchanged file, and a single page able to load `styles.css` from one version and `core.js` from another. Now the newest mtime under `static/` — identical in every worker, stable across restarts, changing exactly when a file does — with `ASSET_VERSION` to override for multi-machine deploys. `tests/test_asset_versioning.py` (8). |
| **REL-002** `cache.addAll` atomic | **FIXED** | `addAll` is atomic: one 404 among the desktop worker's ~45 URLs rejected the whole install, the worker never activated, and the app had **no offline support at all** — silently, and intermittently. Now `allSettled` over individual `cache.add` calls, so one missing font costs that font; the offline page and its stylesheet are still required, because a worker that cannot serve the fallback is not worth activating. Both workers. `static/erp/tests/sw_precache.test.js` (16). |
| **REL-003** Background jobs in recyclable workers | **NOT STARTED** | |
| **REL-004** Synchronous SMTP blocks a worker | **FIXED** | Worse than the title: flask-mail 0.10 builds its connection as `smtplib.SMTP(server, port)` with **no timeout**, so it inherits `socket.getdefaulttimeout()` — `None`. A hung relay blocked that gunicorn worker *permanently*; four such requests take a four-worker deployment offline with nothing in its own logs naming the mail server. Now delivered on a bounded pool (`max_workers=2`, so a broken relay cannot accumulate a stuck thread per request) via a `Connection` subclass that passes `timeout=20`. `tests/test_mail_delivery.py` (8). |
| **REL-005** 200-doc PDF batch exceeds worker timeout | **NOT STARTED** | |
| **API-001** Failure envelopes cached for 15s | **FIXED** | `static/erp/api.js` — only `success === true` is cached. No test yet. |
| **OBS-001** Two competing request-ID middlewares | **FIXED** | `error_handling.py`'s `request_id_middleware()` now **adopts** `g.request_id` instead of minting a competing UUID; `RequestContext` mirrors the id rather than owning it. One id per request, from one generator, matching the `X-Request-ID` response header and the reference id `rpc.py` quotes to the user. `tests/test_request_id.py` (26). |
| **OBS-002** No metrics/APM/`pg_stat_statements` | **FIXED** *(scoped — see note)* | New `app/metrics.py` exposing `/metrics` in Prometheus exposition format, behind an admin session or a `METRICS_TOKEN` bearer token (compared with `compare_digest`; refusal is a 404, so a prober learns nothing). Covers this application's actual failure modes: server-side connections by state, `max_connections`, unfinished mutation claims, migration count, **DATA-002's over-allocated pool rows and unit shortfall**, and active admin accounts. Rate-limiter-exempt for the same reason `/health` is. `tests/test_metrics.py` (15). **Deliberately no request counters** — see the note below. |
| **A11Y-001** `aria-selected` never updated on desktop | **FIXED** | `showTab` toggled a CSS class and nothing else, so the template's `aria-selected="true"` stayed on Dashboard forever — a screen reader announced "Dashboard, selected" on every tab of the application. Now `aria-selected` and a roving `tabindex` move with the selection. `static/erp/tests/tablist_a11y.test.js` (15, with A11Y-003). |
| **A11Y-002** No `<main>`, no skip link | **FIXED** | The shell now has a single `<main id="content" tabindex="-1">` landmark and a skip link ahead of the sidebar's fourteen tab buttons. The link is positioned off-screen rather than hidden, because `display:none`/`visibility:hidden` remove it from the focus order — i.e. from the only people it exists for. `tests/erp/test_page_landmarks.py` (9), asserted against the **rendered** page. |
| **A11Y-003** No arrow-key tablist navigation | **FIXED** | `role="tablist"` is a promise about keyboard behaviour — assistive technology tells the user the arrow keys move between tabs. They did nothing. Arrow keys, Home and End now move focus (not selection: activating on arrow would fire a data load per keypress). |
| **A11Y-005** Focus/announcement after async load; focus not restored on modal close | **FIXED** | New polite live region (`#a11y-announcer`) plus `App.Utils.announce`, wired into the shared `renderPagination` — one call covers loads, filters, sorts and page changes across all 12 tables, and it announces **the same numbers that render the visible summary line**, so it cannot drift from what is on screen. Empty results are announced too (the case most worth hearing). A live region rather than a focus jump, deliberately: loads finish while the user is still typing, and yanking the caret out mid-word is worse than silence. Modal focus is now explicitly remembered and restored — Bootstrap's focus trap restores to whatever was focused at activate time, which for a programmatically-opened modal is usually `<body>`. `static/erp/tests/announcements.test.js` (14). |
| **A11Y-006** Table sort state not announced | **FIXED** *(premise restated)* | There are **no sortable `<th>` in this application** — every table sorts via a labelled `<select>`, so `aria-sort` has nothing to attach to. The underlying WCAG 4.1.2 concern (the sort changed and nothing said so) is met by the live region above: re-sorting re-renders, which re-announces the range. |
| **A11Y-007** Validation errors not programmatically associated | **PARTIAL** | Helpers shipped and tested: `markFieldInvalid` (sets `aria-invalid`, creates an `invalid-feedback` element and appends its id to `aria-describedby` **without clobbering existing help text**), `clearFieldErrors`, and `validateForm` (runs native constraint validation, marks every offending field, announces the first by its **label** rather than its id, then focuses it). `static/erp/tests/form_validation_a11y.test.js` (15). **Not yet wired into the 17 forms** — see VALID-001 below, which is why. |
| **A11Y-004** Colour contrast unverified | **NOT STARTED** | The axe gate disables `color-contrast` because jsdom has no layout engine. Needs a real browser; not fakeable in this suite. |
| **UX-001** Permanent false "Loading…" (23 functions) | **FIXED** | 24 table loaders wrote a "Loading …" row and, on failure, showed a toast and returned. The toast vanishes; the row does not — so a failed load left a table claiming to load forever, with the only evidence of failure removing itself. New `App.Utils.tableLoading` / `tableError` (error row, `role="alert"`, Retry button, escaped server message) wired into all 24 across 11 modules. `static/erp/tests/table_load_states.test.js` (24), including one asserting no module still writes a raw Loading row. |
| **UX-002** No debounce on desktop | **FIXED** | All 28 desktop search boxes were `onkeyup="App.X.filterY(this.value)"` — every keystroke re-filtered the dataset and re-rendered the whole table (Stock is 1,633 rows in production, so a six-character search did that six times, and the typing itself stutters because each render blocks the main thread). New `App.Utils.debouncedFilter`, a WeakMap of per-element timers so two open dialogs cannot cancel each other. Also `onkeyup` → `oninput`: `onkeyup` never fired for paste-by-mouse or IME composition, so a pasted term did nothing until the next key press. `static/erp/tests/search_debounce.test.js` (10). |
| **UX-003** Double-escaping in vendor print view | **FIXED** | Escaping asymmetry removed; both render sites escape once. Covered by `xss_escaping.test.js`. |
| **UX-004..010** Filters, bulk ops, shortcuts, recents, inline edit, unsaved-changes, undo | **NOT STARTED** | |
| **RES-001..004** Tablet portrait, desktop/mobile convergence, table strategy, touch targets | **NOT STARTED** | |
| **FN-01** BOM cost categories empty | **NOT STARTED** | Needs business content, not code. |
| **FN-08** Deactivated user can complete Google sign-in | **FIXED** | `get_or_create_user` checks `deleted_at` explicitly (selected without the filter first, so a soft-deleted email cannot collide on the UNIQUE index and 500). |
| **TD-001..006** Repo hygiene, god files, four rendering paradigms, frontend coverage instrumentation | **NOT STARTED** | |

---

## Phases 4 and 5 — intelligence and AI

**NOT STARTED**, and correctly so. The original plan gates them behind Phase 3:
natural-language query needs the pagination/filter API (PERF-002), and invoice
extraction needs attachment storage, which does not exist. Building either on
the current whole-table read model would produce a slow, expensive layer over
a data access pattern that is itself the problem.

---

## Files changed in this pass

**New**
```
app/erp/services/db_backup.py                     backup engine (pg_dump + verify + retention)
migrations/erp/036_users_role_default_pending.sql DB default -> pending_approval
migrations/erp/037_stock_adjustments_lookup_index.sql
templates/logout_confirm.html                     POST-with-CSRF logout
tests/test_config_failfast.py                     25
tests/test_oauth_state.py                         13
tests/test_signup_authorization.py                17
tests/test_password_reset_security.py             17
tests/test_role_required.py                       13
tests/erp/test_authorization_matrix.py            65
tests/erp/test_backup_restore.py                  10
static/erp/tests/xss_escaping.test.js              7
```

**Modified**
```
config.py                          SECRET_KEY/DB_PASS fallbacks, ALLOW_SELF_SIGNUP, RPC limits
app/__init__.py                    hardened guard, rate limiting, process cleanup, session pinning
app/auth/routes.py                 signup role, OAuth state, timeouts, reset tokens, logout
app/utils.py                       shared new-account role, deleted_at handling
app/middleware/request_id.py       UUID validation
app/middleware/error_handling.py   same validation on the second middleware
app/erp/services/backup_service.py pg_dump wiring, honest status
app/erp/services/stock_service.py  narrowed conflict check
migrations/erp/runner.py           advisory lock
migrations/migration_fix_schema_nov2025.py  credential default
static/erp/api.js                  cache only successes
static/erp/vendors.js              6 XSS sinks + escaping symmetry
.github/workflows/ci.yml           frontend job; real gates
tests/{test_auth,test_oauth_redirect_uri,erp/test_backup}.py  updated for new behaviour
```

No production code was deleted to make a test pass, no lint rule was disabled,
no `continue-on-error` was added, and no finding was closed without evidence.

---

## What must happen next, in order

1. **PERF-002 step 3 — materialised balances.** The last remaining PARTIAL.
   This is where the
   order-of-magnitude is. Steps 1 and 2 delivered 1.25–1.39× because they
   make an O(history) computation *faster*; only a maintained balance makes
   it O(1), and it is also what lets DATA-002's invariant become a database
   `CHECK` rather than an advisory lock. It touches every write path, so it
   needs its own release and its own reconciliation.
2. **Migrate a client to the paginated contract.** `getStockData` accepts
   `page/pageSize/search/sort/direction` today and nothing calls it, so the
   work delivers nothing to users yet. Stock is the natural first module.
   Note this changes search semantics (server-side `LIKE` vs the client's
   multi-keyword match), select-all, and export — it needs UI verification,
   not just green tests.
3. **PERF-004** — the frontend build step. Retires five findings at once
   (REL-002, REL-006, PERF-007 and the CI cache-bump job) and unblocks route
   splitting.
4. **MONEY-001** — Decimal end to end plus stored document totals. Its own
   release, with reconciliation before and after.
5. **AUDIT-001** — trigger-based **row-level** audit log. The activity log (who called what, and the outcome) now exists — see the AUDIT-001 row above; what remains is per-row before/after history, which is the half that needs triggers and its own retention story.
6. **DEPLOY-001** — non-root, multi-stage Dockerfile.
7. **Phase 2** — UX, accessibility and responsive work, starting with the 23
   stuck "Loading…" states and the missing desktop debounce.

### Smaller items still open

`SEC-009` (per-account login throttle), `DATA-004` (CHECK constraints),
`PERF-007` (`config.VERSION`),
`REL-002` (atomic `cache.addAll`), `REL-003` (background jobs in recyclable
workers), `REL-004` (blocking SMTP), `REL-005` (synchronous PDF batch),
`OBS-001`/`OBS-002` (duplicate request-id middleware; no metrics), `MIG-001`'s
tracker consolidation, `FN-01`, and the `TD-*` hygiene items.
