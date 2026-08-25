# Application Architecture & Product Readiness Audit

**Application** Maharaja Bikes ERP (MTC) — Flask + PostgreSQL, ported from Google Apps Script + Sheets
**Branch audited** `verification/claude-appscript-pwa-20260727` @ `e2b2bca`
**Date** 24 August 2026
**Auditor role** Principal Architect sign-off review
**Method** Static analysis of the full repository, plus live execution of both test suites, all three linters, and a reproduction script for the backup-serialisation defect.

---

## 1. Executive Summary

This is a **carefully engineered application with three specific, severe defects that make it unsafe to trust in production today** — and none of them are visible from the UI.

The codebase is not the usual "rushed internal tool". It has 713 passing backend tests at 85% coverage, 383 passing frontend tests, zero ruff errors, zero ESLint errors, zero stylelint errors, a hardened systemd unit, a real CSP, parameterised SQL throughout, 69 indexes, 68 foreign keys, an offline-capable mobile PWA with a mutation outbox, and inline commentary that is genuinely better than most commercial code. The engineering *discipline* here is above average.

The problems are structural and concentrated in the places nobody looks:

**Three P0s.**

1. **The production secret-key fail-fast does not work.** `SECRET_KEY` falls back to the literal string `"dev-insecure-key"` in `config.py`, and the startup validation only tests truthiness — so a deployment with no `SECRET_KEY` environment variable boots normally on a key that is published in this repository. Anyone with the source can forge a session cookie for any user, including an admin, and forge password-reset tokens for any address. This is a complete authentication bypass that produces no error, no warning, and no log line.

2. **The backup system does not produce restorable backups.** It is a hand-rolled `INSERT` dump, not `pg_dump`. It emits no `CREATE TABLE`, no sequences, no constraints; it omits `public.users` and `public.custom_roles` entirely (so a restore loses every account and every permission map); it serialises JSONB columns as Python `repr()` — I reproduced this, and `erp.production.components_consumed` comes out as `'[{''itemName'': ...}]'`, which Postgres will reject on restore; and a per-table export failure is written into the file as an SQL comment while the run is still reported **successful**. The business believes it has nightly backups. It does not.

3. **Anyone on the network can create a fully privileged account.** `POST /auth/api/signup` is unauthenticated, creates the user with `role="user"`, and logs them straight in. The `pending_approval` gate that `rpc.py` enforces — the one that makes Google sign-up safe — only ever applies to Google-created accounts. A password signup skips it entirely and lands with full access to stock, bills, purchase orders, production, clients, dispatch and vendor ledgers.

**Beyond those**, the two things that will hurt most over the next twelve months are *architectural*, not buggy: Current Stock is recomputed by full-scanning every transactional table in the database on every read, and **not one of the 166 RPC read methods paginates**; and the frontend ships 3.36 MB of unbundled, unminified, render-blocking JavaScript governed by three separate hand-maintained cache-busting schemes. Both get worse every month on their own.

**The good news is that the shape of the fix is small.** The three P0s are a config change, a `pg_dump` call, and a one-line role default. Nothing here suggests a rewrite. The architecture is sound; it is the seams that need work.

**Verdict: NO-GO** for unattended production use until the three P0s are closed. **CONDITIONAL GO** immediately after — they are days of work, not months.

---

## 2. Application Architecture Map

### 2.1 What this system is

A manufacturing ERP for a bicycle factory, replacing a Google Apps Script + Google Sheets system. It runs on a factory LAN (often without internet), is used on desktop workstations and Android tablets, and covers procurement → inventory → production → dispatch → receivables.

### 2.2 Runtime topology

```
Browser (desktop shell)           Android tablet (mobile PWA)
  index.html + 20 JS files          mobile.html + mobile.js
  Service Worker /erp/sw.js         Service Worker /erp/mobile/sw.js
  cache-first shell, network-only   + IndexedDB read model
  data                              + mutation outbox w/ Background Sync
        │                                     │
        └──────────── HTTPS/HTTP ─────────────┘
                        │
                   nginx (gzip, TLS)
                        │
             gunicorn — 4 sync workers, 120 s timeout
                        │
                   Flask app factory
      ┌─────────────────┼──────────────────┐
   auth_bp          erp_bp            erp_rpc_bp
  /auth/*        /erp, /erp/mobile   /api/erp/rpc/<method>
  Google OAuth   HTML shells         166 allowlisted methods
  password login PDF render (WeasyPrint)
                        │
     ThreadedConnectionPool (min 2/4, max 20 per worker)
                        │
                  PostgreSQL 17
        public schema: users, custom_roles
        erp schema:    50 tables, 69 indexes, 68 FKs
                        │
        Background daemon threads inside each worker:
          • hourly ledger reconciliation audit (pg advisory lock)
          • nightly backup + Google Sheets mirror (pg advisory lock)
```

### 2.3 The central architectural decision

The whole system is organised around **one RPC bridge**, `POST /api/erp/rpc/<method>`, which is a deliberate stand-in for Apps Script's `google.script.run`. Methods register themselves by their original Apps Script name via `@rpc_method(...)` into an allowlist (`app/erp/registry.py`), and the frontend calls them by name with positional args — unchanged from the Sheets original.

This is the single most consequential decision in the codebase, and it cuts both ways:

- **It made the port tractable and safe.** An allowlist is a genuinely good API-surface control; there is no route enumeration, no accidental exposure, and the authorization gate has exactly one place to live.
- **It inherited the spreadsheet data model.** `google.script.run` returned whole sheets, so `getStockData`, `getBillData`, `getPOData` and 30 siblings return whole tables. There is no pagination, filtering or sorting parameter anywhere in the API contract, because there was nowhere for one to come from. Everything downstream — the client-side filtering, the 15-second read cache, the full-table re-render on every keystroke — is a consequence of this one inherited shape.

### 2.4 Layers

| Layer | Location | Assessment |
|---|---|---|
| App factory | `app/__init__.py` (837 lines) | Does far too much: config, logging, limiter, Talisman, CORS, blueprints, health, teardown, schedulers, middleware. Needs splitting. |
| Auth | `app/auth/routes.py` (525 lines) | Google OAuth + password + reset. **49% tested — the least-covered module in the app.** |
| RPC dispatch | `app/erp/rpc.py` (133 lines) | Clean, well-reasoned. Auth → pending gate → role gate → tab gate → idempotency → dispatch → typed error handling. |
| Services | `app/erp/services/*.py` (28 files, ~18 k lines) | Where the business lives. Generally well-factored; `process_service.py` (2 443 lines) and `items_service.py` (1 604) are too large. |
| Data access | `database.py` (300 lines) | Pool + `get_conn` context manager + `@transactional`. Correct, but see PERF-003. |
| Frontend | `static/erp/*.js` (20 files, 1.44 MB) | No module system, no bundler, one global `App` namespace. |
| Templates | `templates/erp/` | Jinja shells + 13 partials, injected as hidden divs. |

### 2.5 Verified positives worth protecting

These were checked and are genuinely well done. Do not regress them.

- **SQL injection: clean.** All 16 f-string SQL sites interpolate only constants from `config_maps.TABLE_NAMES` or literals. Every user value is parameterised. `psycopg2.sql.Identifier` is used where identifiers are dynamic.
- **PDF rendering security: excellent.** `pdf_render_service.py` blocks every non-`data:` URL fetch, passes no `base_url`, uses an engine with no JS runtime, validates the density class against a fixed set, and caps payload and batch size. This is the correct way to render client-supplied HTML server-side.
- **Test-database isolation.** After an incident that wrote ~180 fixture rows into production, `TestingConfig.DATABASE_URL = None` plus an `override_keys` exclusion plus a constructor assertion now make it structurally impossible. The comments documenting it are exemplary.
- **The `_SafeRotatingFileHandler`** — a copy-then-truncate fallback for Windows/OneDrive rename locks, after a log grew to 1.06 GB against a 10 MB cap. Real problem, correct fix.
- **Systemd hardening**: `ProtectSystem=strict`, `NoNewPrivileges`, `PrivateTmp`, explicit `ReadWritePaths`, `StartLimitBurst`.
- **Automated ledger reconciliation** (`ledger_audit_service.py`) — an hourly cross-ledger consistency audit, coordinated across workers with `pg_try_advisory_xact_lock`, surfacing findings in the notification bell. This is shipped Level-3 intelligence.
- **`prefers-reduced-motion` and `forced-colors` media queries** are both handled.

---

## 3. Technology Stack Assessment

| Component | Version / choice | Verdict |
|---|---|---|
| Python / Flask | 3.12 / Flask + blueprints | Appropriate. |
| PostgreSQL | 17 | Correct choice; underused (see §9). |
| psycopg2 `ThreadedConnectionPool` | max 20/worker | **Raises on exhaustion rather than queueing** — see PERF-003. |
| gunicorn | 4 sync workers, 120 s | 4 concurrent requests total. Too few given unpaginated reads. |
| Flask-Login / Flask-WTF / Talisman / Limiter | — | Right tools, correctly wired, with two exceptions (SEC-005, PERF-001). |
| WeasyPrint | in-process, ~40 MB | Excellent call over headless Chromium (~400 MB). |
| Frontend | Vanilla JS, jQuery, Bootstrap 5, Select2, Chart.js, SheetJS | **No build step at all.** The dominant technical constraint on the frontend. |
| htm/preact | used only in `planning-board.js` | A fourth rendering paradigm in a codebase that already has three. |
| Redis | rate-limit storage | Pool destroyed every request (PERF-001). |

**Stack verdict:** the choices are sound and deliberately conservative, which suits a factory-LAN deployment. The gap is not the stack — it is the **absence of a frontend build pipeline**, which is the root cause of five separate findings.

---

## 4. Functional Audit

### 4.1 Coverage of the domain

Genuinely broad and largely complete: Units, Colors, Models, Process Types, Vendors, Contractors (with rate layers and service charges), Clients, Items Master (with per-vendor rates and unit conversion), Stock, Stock Groups, Purchase Orders, Bill Ledger (goods + labour job), Returns, Wastage, Issued Stock, BOM, Process Master with colour axes, Warehouse Pool, Production Lots, Dispatch + Dispatch Plan, Company Settings, Users, Custom Roles, Backup, Ledger Audit.

### 4.2 Confirmed functional gaps

| ID | Gap | Evidence | Severity |
|---|---|---|---|
| FN-01 | **BOM "Additional Costs" suggestions are permanently empty.** `DEFAULT_COST_CATEGORIES` was referenced but defined nowhere, throwing `ReferenceError` on every "New BOM" click; it is now stubbed to `[]`. | `static/erp/bom.js:32` — the FIXME documents it honestly | P2 |
| FN-02 | **No pagination, server-side filtering or sorting on any of the 166 RPC methods.** | 1 `LIMIT` in the entire service layer that is not a `SELECT 1 ... LIMIT 1` existence probe | P1 |
| FN-03 | **Bill totals are never stored.** `erp.bill_headers` has no `total_amount` column; every total is recomputed from lines on read. | `migrations/erp/008_bill_ledger.sql` | P1 |
| FN-04 | **No field-level change history on 47 of 50 tables.** Only `stock_adjustments`, `rate_history` and `ledger_audit_log` record before/after values. | 50 tables vs 3 history tables | P1 |
| FN-05 | **A failed table load leaves a permanent false "Loading…" row.** 23 `loadData()` functions set a loading placeholder and never clear it in their `catch`; the only error signal is a transient toast. | Script-verified across 12 files | P2 |
| FN-06 | **Desktop has no debounce utility.** `debounce` exists only in `mobile.js`. 57 `input` handlers fire a full re-filter and full `innerHTML` table rebuild per keystroke. | grep across `static/erp/` | P2 |
| FN-07 | **Search is substring-only, client-side, over already-downloaded data.** 33 `toLowerCase().includes()` filters. No fuzzy matching, no cross-module search, no server-side search. | — | P2 |
| FN-08 | **Deactivated users can still complete a Google sign-in.** `get_or_create_user` does not filter `deleted_at IS NULL`; `load_user` does — so the user logs in, then is silently logged out on the next request. | `app/utils.py:73` vs `app/__init__.py` `load_user` | P2 |

### 4.3 Code-hygiene sweep

Clean, and notably so:

- `TODO`/`FIXME`/`HACK`/`XXX` in shipped code: **1** (FN-01, an honest one)
- `console.*` in shipped JS: **21 across 7 files** — all `console.warn`/`console.error` in catch blocks, none stray debug output
- `alert(` in shipped JS: **0**
- ruff: **All checks passed**
- ESLint: **0 errors**, 115 warnings (mostly unused `eslint-disable` directives in tests)
- stylelint: **clean**

This is a well-kept codebase. The defects below are design and configuration failures, not sloppiness.

---

## 5. Bug Register

Findings are ordered by severity. Each is **Confirmed** (traced in code or reproduced), **Probable** (strong evidence, one inference), or **Architectural concern**.

---

### SEC-001 — Production `SECRET_KEY` fail-fast never fires

- **Severity** P0 · **Category** Security · **Status** Confirmed
- **Location** `Project-root/config.py:24`, `Project-root/app/__init__.py` (`_load_config`)

**Problem.** `Config.SECRET_KEY = os.getenv("SECRET_KEY") or "dev-insecure-key"`. The startup validation is:

```python
required = ["SECRET_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]
for key in required:
    if not app.config.get(key):
        missing.append(key)
```

**Evidence.** `"dev-insecure-key"` is a non-empty string, therefore truthy, therefore `SECRET_KEY` can never appear in `missing`. The `RuntimeError` that is supposed to stop a misconfigured production boot is unreachable for the one key that matters most. The fallback string is in a file tracked in git.

**User impact.** None visible — that is precisely the danger. The application starts, logs nothing unusual, and behaves normally.

**Business impact.** Flask signs session cookies with `SECRET_KEY`, and `itsdangerous` signs password-reset tokens with it. Anyone who can read this repository can mint a valid session cookie for any `user_id` — `load_user` then loads that user's real role from the database, so a forged cookie for the admin's id yields full administrative access. They can also mint a password-reset token for any email address. Complete authentication bypass, no credentials needed.

**Root cause.** A development-convenience default placed on the same attribute the production guard validates. The guard tests presence; the default guarantees presence.

**Recommended solution.**
```python
# config.py
SECRET_KEY = os.getenv("SECRET_KEY")          # no fallback

class DevelopmentConfig(Config):
    SECRET_KEY = os.getenv("SECRET_KEY") or "dev-insecure-key"   # dev only
```
Additionally, harden the guard so it cannot be defeated again:
```python
WEAK = {"dev-insecure-key", "changeme", "secret", ""}
if not app.config.get("TESTING"):
    sk = app.config.get("SECRET_KEY") or ""
    if sk in WEAK or len(sk) < 32:
        missing.append("SECRET_KEY (unset, too short, or a known default)")
```

**Priority.** Before any further production use. Everything else in this report assumes authentication works.
**Dependencies.** Confirm `/etc/mtc/mtc.env` sets a real `SECRET_KEY`; rotating it logs everyone out (acceptable, do it in a maintenance window).
**Risk of change.** Low. The only risk is a deployment that was silently relying on the fallback — which is exactly the deployment you need to find.
**Verification.** `SECRET_KEY= FLASK_ENV=production python -c "from app import create_app; create_app()"` must raise `RuntimeError`. Add this as a test.

---

### DATA-001 — The backup system produces unrestorable backups and reports failures as success

- **Severity** P0 · **Category** Data Integrity / Reliability · **Status** Confirmed (reproduced)
- **Location** `Project-root/app/erp/services/backup_service.py:82-131`, `scripts/migration/backup_db_to_sheets.py:62-78`

**Problem.** `export_local_sql_snapshot` hand-writes `INSERT` statements instead of invoking `pg_dump`. Five independent defects, any one of which alone breaks restore:

**Evidence.**

1. **No schema, no sequences.** The file contains only `INSERT INTO ...`. There is no `CREATE TABLE`, no index, no constraint, no `setval` for any sequence. A restore onto a fresh database is impossible; a restore onto an existing one leaves every `SERIAL` sequence at its pre-restore value, so the next insert collides on the primary key. `erp.dispatch_number_seq` drives customer-facing dispatch document numbers — it would begin re-issuing numbers already in use.

2. **`public.users` and `public.custom_roles` are not backed up.** The table list is `backup_db_to_sheets.TABLES`, and every entry is `erp.`-prefixed. Restoring loses every account, every password hash, and every custom role's permission map — while `updated_by` / `created_by` foreign keys throughout `erp.*` still point at user ids that no longer exist.

3. **JSONB columns are corrupted.** psycopg2 returns JSONB as a Python `list`/`dict`; the serialiser falls through to `str(val)`. I ran the exact code path:

   ```
   input : [{"itemName": 'Rim 26"', "qty": 4, "sourceType": "ITEM"}]
   output: '[{''itemName'': ''Rim 26"'', ''qty'': 4, ''sourceType'': ''ITEM''}]'
   ```

   That is Python `repr`, not JSON. Postgres rejects it with `invalid input syntax for type json`. The affected column is `erp.production.components_consumed` — the record of what each production lot actually consumed, which is one of the five terms in the Current Stock formula. **Every production row fails to restore.**

4. **Per-table failures are swallowed and the run still reports success.**
   ```python
   except Exception as e:
       f.write(f"-- Error exporting {full_table}: {e}\n")
       continue
   ...
   local_success = True
   ```
   A backup that exported three of fifty tables is written to disk, logged as `Local database snapshot saved to: ...`, and surfaced in the dashboard as successful. This is the single worst failure mode a backup system can have.

5. **A dead branch confirms the type handling was never exercised.** `isinstance(val, (int, float))` precedes the `isinstance(val, bool)` branch, and `bool` subclasses `int` in Python — so the boolean branch is unreachable. It survives only because `str(True)` happens to be a literal Postgres accepts.

**Additionally:** no retention policy (nothing prunes `backups/`), no encryption (the file is the entire business database in plaintext), no checksum, and no test-restore. The export also runs on a pooled connection carrying `statement_timeout=60000`, so a large-table `SELECT *` will be killed at 60 s — landing in defect (4) above.

**Business impact.** The company believes it has nightly backups. One disk failure, one bad migration, or one accidental `DELETE` and the answer is that the backups do not restore. For a system holding GST invoices, vendor payables and contractor payments, this is existential.

**Root cause.** A backup written as application code rather than delegated to the database's own, purpose-built tool.

**Recommended solution.** Replace the hand-rolled dump with `pg_dump` — the container and the provisioned host already install `postgresql-client`.

```python
def export_local_snapshot(path: str) -> None:
    """Custom-format dump: schema + data + sequences + constraints, compressed."""
    cmd = ["pg_dump", "--format=custom", "--compress=9",
           "--no-owner", "--no-privileges",
           "--schema=public", "--schema=erp",
           "--file", path, _dsn()]
    subprocess.run(cmd, check=True, timeout=1800,
                   env={**os.environ, "PGPASSWORD": _password()})
    # Prove it is readable before calling the backup a success.
    subprocess.run(["pg_restore", "--list", path], check=True, capture_output=True)
```

Then, in order of importance:
- **Make partial failure fatal.** Any table-level error must set `local_success = False` and surface as an alert, never a comment in the file.
- **Verify every backup**: `pg_restore --list` at minimum; ideally a weekly restore into a scratch database with a row-count comparison against production.
- **Retention**: keep 7 daily / 4 weekly / 12 monthly; prune the rest.
- **Encrypt at rest** (`age` or `gpg`) and get one copy off the machine.
- **Alert on absence**, not just on error — a backup that never ran produces no error at all.

**Intelligent opportunity.** Surface backup health on the dashboard as a first-class card: last successful backup, its verified row counts per table, and its size trend. A backup whose size drops 40% overnight is a silent partial failure that a size sparkline catches instantly.

**Priority.** Immediately, and before the next schema change.
**Risk of change.** Low — `pg_dump` is strictly more capable. Keep the Sheets mirror as-is; it serves a different (human-readable) purpose.
**Verification.** Take a backup, restore it into an empty database, and diff row counts for all 50 tables plus `public.users` and `public.custom_roles`. Make this a CI job against the ephemeral Postgres service container.

---

### SEC-002 — Self-service signup bypasses the admin-approval gate

- **Severity** P0 · **Category** Security / Broken Access Control · **Status** Confirmed
- **Location** `Project-root/app/auth/routes.py:180-235` (`api_signup`) vs `app/utils.py:73-90` (`get_or_create_user`)

**Problem.** Two account-creation paths assign two different roles.

**Evidence.**

```python
# app/utils.py — Google OAuth path
cur.execute("INSERT INTO users (name, email, role, profile_picture) VALUES (%s,%s,%s,%s) ...",
            (name, email, "pending_approval", picture))
```
```python
# app/auth/routes.py — password path
cur.execute("INSERT INTO users (name, email, role, password_hash) VALUES (%s,%s,%s,%s) RETURNING *",
            (name, email, "user", password_hash))
new_user = cur.fetchone()
login_user(User(new_user))          # immediately authenticated
```

`app/erp/rpc.py` blocks only one role:

```python
if getattr(current_user, "role", None) == "pending_approval":
    return ... 403
```

`"user"` is not blocked, and `RpcSpec.roles` is `None` for the overwhelming majority of the 166 methods. So a password signup obtains immediate, unrestricted access to stock, bills, purchase orders, returns, production, dispatch, clients, contractors and vendor ledgers.

`POST /auth/api/signup` is unauthenticated, is explicitly CSRF-exempt (`csrf.exempt(auth.api_signup)`), and is rate-limited only to `5 per hour` per IP.

**User impact.** None — a legitimate new user gets a smooth signup. That is why it has not been noticed.

**Business impact.** Anyone who can reach the login page — every device on the factory LAN, plus the whole internet if the app is exposed — can self-issue a full ERP account. They can read every vendor rate and client price, and can create, edit and soft-delete financial records.

**Root cause.** The `pending_approval` gate was added to the OAuth path (where accounts arrive from outside) and the password path was not revisited.

**Recommended solution.** One line, plus honesty in the UI:

```python
cur.execute(
    "INSERT INTO users (name, email, role, password_hash) VALUES (%s,%s,%s,%s) RETURNING *",
    (name, email, "pending_approval", password_hash),
)
new_user = cur.fetchone()
login_user(User(new_user))          # lands on /erp/pending-approval, which already exists
```

The holding page (`erp.pending_approval`) and the admin approval flow (`users_service.updateUserRole`) are already built — this path simply never routed into them.

Consider going further, given the deployment: for a single-factory ERP, **remove open signup entirely** and have admins invite users. Self-service registration on a business ERP is a liability with no offsetting benefit here.

**Priority.** Immediately. Audit `users` for accounts created via this path before fixing:
```sql
SELECT user_id, name, email, role, created_at
FROM users WHERE password_hash IS NOT NULL AND role <> 'pending_approval'
ORDER BY created_at DESC;
```
**Risk of change.** Low — an existing legitimate user is unaffected; only new signups change.
**Verification.** Test that `POST /auth/api/signup` yields `role='pending_approval'`, and that the new session receives 403 from an RPC method.

---

### SEC-003 — OAuth `state` validation is skipped when no session state exists

- **Severity** P0 · **Category** Security / CSRF · **Status** Confirmed
- **Location** `Project-root/app/auth/routes.py:395-402`

**Problem.**

```python
returned_state = request.args.get("state")
expected_state = session.pop("oauth_state", None)
if not current_app.config.get("TESTING"):
    if expected_state and returned_state != expected_state:
        return "Invalid OAuth state", 400
```

**Evidence.** The comparison is guarded by `if expected_state`. When the victim's session has no `oauth_state` — because they never started an OAuth flow — `expected_state` is `None`, the condition short-circuits, and **the callback proceeds with no CSRF protection at all**. The absence of state is the attack; the check treats it as the safe case.

**Attack.** An attacker begins a Google sign-in with their own account, captures the `code` from the callback URL, and induces the victim to visit `https://erp.example/auth/google/callback?code=<attacker_code>&state=anything`. The victim has no `oauth_state`, the guard is skipped, the code is exchanged, and the victim is silently logged in **as the attacker**. Work the victim then performs — a bill entry, a dispatch, a stock correction — is recorded under the attacker's account, and anything they upload lands in the attacker's control.

**Root cause.** Defensive coding around a missing value, where a missing value is the failure condition.

**Recommended solution.** Fail closed, and compare in constant time.

```python
import secrets
returned_state = request.args.get("state") or ""
expected_state = session.pop("oauth_state", None)
if not current_app.config.get("TESTING"):
    if not expected_state or not secrets.compare_digest(returned_state, expected_state):
        current_app.logger.warning("[OAuth] state missing or mismatched — rejecting callback")
        return "Invalid OAuth state", 400
```

**Note on the `TESTING` bypass.** The entire check is skipped under `TESTING`, which is why 49% coverage on this file matters: the one branch that protects this flow is never exercised by any test. Replace the bypass with a test that seeds `session["oauth_state"]` properly.

**Priority.** Immediately — same change window as SEC-001/002.
**Risk of change.** A user whose session cookie was lost mid-flow now sees "Invalid OAuth state" and must click sign-in again. Correct behaviour.
**Verification.** Callback with no session state → 400. Callback with mismatched state → 400. Callback with matching state → success. All three as tests.

---

### DATA-002 — Dispatch over-allocation race: no row locking anywhere in the service layer

- **Severity** P1 · **Category** Data Integrity / Concurrency · **Status** Confirmed
- **Location** `Project-root/app/erp/services/dispatch_service.py:769-781` and `:583-590`

**Problem.** `save_dispatch` runs under `@database.transactional` at PostgreSQL's default READ COMMITTED and performs a classic check-then-act:

```python
ready_map = _compute_ready_to_dispatch_map(cur)          # read availability
...
if reserved_so_far + line["qty"] > available_qty + 0.0001:
    raise ValueError(f'Only {available_qty} unit(s) ... are Ready to Dispatch')
...
# insert dispatch lines
```

**Evidence.** `SELECT ... FOR UPDATE` appears **zero times** across all 28 service modules. The only locks in the codebase are the two `pg_advisory_lock` calls in `backup_service.py`. Under READ COMMITTED, neither of two concurrent transactions sees the other's uncommitted inserts, so both compute the same `ready_map`, both pass validation, and both commit.

**Failure scenario.** 40 units of `PROD-114` are ready. Two dispatch clerks each raise a 30-unit dispatch bill at the same moment. Both reads return `available = 40`; both validations pass; both commit. **60 units are dispatched against 40 produced.** Ready-to-Dispatch goes negative, the client order shows over-fulfilment, and the discrepancy is only found when someone counts the shelf.

The same shape exists in `save_dispatch_plan_line` (`availableToPlan`), in `adjust_stock_manually`, and in the warehouse-pool recalculation.

**Root cause.** Faithful port of a single-user Apps Script system into a multi-user one, without adding the concurrency control the original never needed. The `X-Mutation-Id` idempotency layer protects against *replaying one request* — it does nothing about *two different requests*.

**Recommended solution.** Serialise per product, not globally, so unrelated dispatches stay parallel:

```python
# Immediately after opening the transaction, before computing availability:
for pid in sorted({l["productId"].strip().lower() for l in lines}):
    cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"dispatch:{pid}",))
```

`pg_advisory_xact_lock` releases automatically at commit or rollback, which is essential with a pooled connection (a session-level lock could survive the connection's return to the pool). Sorting the ids prevents deadlock between transactions touching overlapping product sets.

Then add the invariant to the database so it holds regardless of application code:
```sql
ALTER TABLE erp.dispatch_lines ADD CONSTRAINT ck_dispatch_lines_qty_positive CHECK (qty > 0);
```
and consider a materialised `product_availability` table with a `CHECK (available >= 0)`, maintained inside the same transaction — a constraint violation is infinitely better than silent negative stock.

**Intelligent opportunity.** When the lock is contended, tell the user something useful rather than a generic error: *"Another dispatch for PROD-114 was saved seconds ago — 10 units now remain. Adjust the quantity?"* with the corrected figure pre-filled.

**Priority.** P1. Frequency scales with the number of simultaneous users; two dispatch clerks is enough.
**Risk of change.** Low; advisory locks are cheap and scoped to the transaction. Measure lock wait time.
**Verification.** An integration test firing two concurrent `saveDispatch` calls for the same product from two threads and asserting exactly one succeeds. This test does not exist today.

---

### DATA-003 — Mutation idempotency is check-then-act, and desktop saves never reuse an id

- **Severity** P1 · **Category** Data Integrity · **Status** Confirmed
- **Location** `Project-root/app/erp/mutations.py`, `app/erp/rpc.py:96-105`, `static/erp/api.js` (`mutate`)

**Problem — two distinct defects in one mechanism.**

**(a) The store is TOCTOU.** `rpc.py` does `get_cached_result(id)` → execute → `store_result(id, ...)`. Two requests carrying the same id that arrive concurrently both find no cached row, both execute the method, and then one `INSERT ... ON CONFLICT DO NOTHING` silently discards the second result. The mutation ran twice. The window is the entire method execution.

**(b) Desktop saves never reuse an id anyway.** `Api.mutate()` calls `_newMutationId()` on every invocation, generating a fresh UUID. So for all ordinary desktop use, the idempotency table can never match — it is pure write amplification. Only the mobile offline outbox (`mutateWithId`) actually benefits.

Double-submit protection on desktop therefore rests **entirely on client-side button disabling** (`btn.disabled = true`, 183 occurrences). That is defeated by a second browser tab, an Enter-key repeat, or a user retrying after a network stall.

**(c) The table grows without bound.** `erp.rpc_mutations` stores a full JSONB result envelope for every mutation ever performed, with `created_at` but no pruning anywhere in the codebase. Some envelopes contain whole result sets.

**Recommended solution — claim the id atomically, then fill it in.**

```sql
ALTER TABLE erp.rpc_mutations
    ALTER COLUMN result DROP NOT NULL,
    ADD COLUMN status TEXT NOT NULL DEFAULT 'in_progress';
```
```python
def claim(mutation_id, method) -> dict | None:
    """None => we own this id, proceed. Otherwise => the stored envelope, or
    a 'still running' envelope for a concurrent duplicate."""
    with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (_c, cur):
        cur.execute("""
            INSERT INTO erp.rpc_mutations (mutation_id, method, status)
            VALUES (%s, %s, 'in_progress')
            ON CONFLICT (mutation_id) DO NOTHING
            RETURNING mutation_id
        """, (mutation_id, method))
        if cur.fetchone():
            return None                      # we claimed it
        cur.execute("SELECT status, result FROM erp.rpc_mutations WHERE mutation_id=%s",
                    (mutation_id,))
        row = cur.fetchone()
        if row["status"] == "in_progress":
            return build_response(False, None,
                "This action is already being processed. Please wait a moment.")
        return row["result"]
```

Then have the client send **one id per user action**, not per network call: generate the UUID when the form is submitted and reuse it across retries. That makes a double-click genuinely idempotent instead of relying on a disabled button.

Finally, prune:
```sql
DELETE FROM erp.rpc_mutations WHERE created_at < NOW() - INTERVAL '7 days';
```
as a daily job alongside the existing schedulers.

**Priority.** P1 — (b) means the protection that is documented as existing does not, in practice, exist for desktop users.
**Verification.** Two concurrent requests with the same `X-Mutation-Id` must produce exactly one execution.

---

### SEC-004 — Stored XSS in the Vendor ledger, under a CSP that permits inline script

- **Severity** P1 · **Category** Security · **Status** Confirmed
- **Location** `Project-root/static/erp/vendors.js:116, 407, 424, 425`

**Problem.** Most of this codebase escapes correctly — `escapeHtml` is used 700+ times and the server pre-escapes composite fields. But `vendors.js` interpolates four user-controlled fields raw, in some cases *directly beside* correctly escaped ones:

```js
// vendors.js:111-116 — note the inconsistency within one table row
<td><strong>${escapeHtml(App.Utils.formatNameCase(v.name))}</strong></td>
<td><div>Ph: ${escapeHtml(v.contact) || '-'}</div></td>
<td><span class="badge ...">${v.gstin || 'No GSTIN'}</span></td>   // ← unescaped
```
```js
// vendors.js:407, 424-425
<td><strong>${entry.ref}</strong></td>          // bill / return / issue number
<td><strong>${item.name}</strong></td>          // item master name
<td>${item.size || '-'}</td>
```

**Evidence.** All four are free-text fields a user types. `entry.ref` resolves to `b.billNumber` (typed into the Bill form), `r.returnNumber`, or `iss.issueId`. There is **no server-side HTML sanitisation anywhere** — I searched for `bleach`, `markupsafe`, `escape(`, `sanitiz` across `app/` and found only comments noting that Apps Script's `sanitizeString()` was deliberately not ported.

**Why this is P1 and not P3.** The CSP is:
```python
"script-src": ["'self'", "'unsafe-inline'"],
```
`'unsafe-inline'` means an injected `<img src=x onerror=...>` or `<script>` **executes**. The CSP provides no XSS mitigation whatsoever. An attacker who can create a bill (any `role="user"` account, and per SEC-002 anyone can obtain one) plants a payload in a bill number; it fires whenever an admin opens that vendor's profile. From there: read the CSRF token from the meta tag, call any of the 166 RPC methods as the admin, exfiltrate the entire vendor and client price list.

**Recommended solution.**

*Immediate* — escape the four sites:
```js
<td><span class="badge ...">${escapeHtml(v.gstin) || 'No GSTIN'}</span></td>
<td><strong>${escapeHtml(entry.ref)}</strong></td>
<td><strong>${escapeHtml(item.name)}</strong></td>
<td>${escapeHtml(item.size) || '-'}</td>
```

*Structural* — the real fix is to stop hand-escaping. Introduce a tagged template that escapes by default:
```js
function h(strings, ...values) {
  return strings.reduce((out, s, i) =>
    out + s + (i < values.length ? escapeHtml(values[i] ?? '') : ''), '');
}
```
Then a missed `escapeHtml` becomes impossible rather than a code-review responsibility — which is the only thing that scales across 147 interpolation sites.

*Also* — remove `'unsafe-inline'` from `script-src`. The blockers are the inline `<script>` blocks in `index.html` and the auth pages, plus ~40 inline `onclick=` handlers. Move them to external files and event delegation (the codebase already uses `data-action` delegation extensively, so the pattern is established), then switch to a nonce-based CSP. This turns every remaining XSS from an account takeover into a blocked console message.

**Priority.** P1 — escape the four sites this week; plan the tagged-template migration.
**Verification.** Create a vendor with GSTIN `<img src=x onerror=alert(1)>`, a bill numbered `"><script>alert(1)</script>`, and an item named the same. Open the vendor profile. Nothing should execute.

---

### SEC-005 — The entire business API is exempt from rate limiting

- **Severity** P1 · **Category** Security / Availability · **Status** Confirmed
- **Location** `Project-root/app/__init__.py` — `limiter.exempt(erp_rpc_bp)`

**Problem.** One line removes rate limiting from all 166 RPC methods. Only `/auth/api/login` (10/min), `/auth/api/signup` (5/hr), `/auth/api/forgot-password` (5/hr) and `/auth/api/reset-password` (10/hr) are limited.

**Evidence.** `getStockData` full-scans `bill_lines`, `return_lines`, `wastage_lines`, `issue_lines` and every completed production lot on every call. With 4 gunicorn sync workers, a single authenticated client looping that endpoint saturates all four workers and takes the ERP down for the whole factory. No quota applies to mutations either — a runaway script can create unlimited bills.

**Recommended solution.** Replace the blanket exemption with a tiered, per-user limit:

```python
# Keyed on user id, not IP — the whole factory shares one NAT address.
limiter.limit(
    "600 per minute",
    key_func=lambda: str(getattr(current_user, "id", get_remote_address())),
)(erp_rpc_bp)
```
and apply a tighter limit to the genuinely expensive endpoints:
```python
@rpc_method("getStockData")
@limiter.limit("20 per minute")
def get_stock_data(): ...
```
Also rate-limit `/erp/render-pdf-batch` — 200 WeasyPrint renders in one request will exceed gunicorn's 120 s timeout and kill the worker.

**Priority.** P1 for the tiered limit; the per-user key matters more than the exact numbers, because per-IP limiting is meaningless behind factory NAT.
**Risk.** Set limits generously at first and log rejections for a week before tightening.

---

### PERF-001 — The Redis connection pool is destroyed on every request

- **Severity** P1 · **Category** Performance · **Status** Confirmed
- **Location** `Project-root/app/__init__.py` — `_close_db_and_pools` (`@app.teardown_appcontext`)

**Problem.**

```python
@app.teardown_appcontext
def _close_db_and_pools(exception=None):
    ...
    pool = app.extensions.get("ratelimit_redis_pool")
    if pool is not None:
        if hasattr(pool, "disconnect"):
            pool.disconnect()
            app.logger.info("[RATE LIMIT] Redis connection pool disconnected.")
```

**Evidence.** `teardown_appcontext` fires at the end of **every request**. `ConnectionPool.disconnect()` closes every connection the pool holds. So the rate limiter's Redis pool is torn down and rebuilt continuously: a fresh TCP connect (plus AUTH, if configured) on every limited request, and a log line at INFO on every single request in production.

**Impact.** Added latency on every auth request, connection churn against Redis, and log volume inflated by one line per request — which fills `logs/app.log` (10 MB × 10) with noise and pushes real diagnostics out of the retention window.

**Recommended solution.** Pools are process-scoped, not request-scoped. Move the teardown to `atexit` / a gunicorn `worker_exit` hook, and drop it from `teardown_appcontext` entirely.

**Also, in the same function:** the database half is entirely dead code. It probes `database` for `close_connection`, `close_pool`, `close`, `shutdown`, `dispose`, `teardown` — I verified that `database.py` defines only `init_app`, `get_conn`, `close_db_pool`, `transactional`, so **none of the six exist**. It then falls back to `getattr(database, "pool")`, which resolves to the imported `psycopg2.pool` *module* (not a pool object), and checks it for `.close`/`.disconnect` — neither of which exist on a module. Roughly ten `getattr` calls per request that can never do anything, while giving a reader the false impression that connections are cleaned up here. (They are, correctly, in `get_conn`'s `finally`.) Delete it and call `database.close_db_pool()` at process exit.

**Priority.** P1 — trivial fix, immediate benefit.
**Verification.** `redis-cli info stats | grep total_connections_received` before and after a 100-request run; the delta should be ~0, not ~100.

---

### PERF-002 — Current Stock full-scans every transactional table on every read; no read paginates

- **Severity** P1 · **Category** Performance / Scalability · **Status** Confirmed (architectural)
- **Location** `Project-root/app/erp/services/stock_service.py:120-200` (`_get_billed_and_consumed_qty_maps`), `:210-250` (`get_stock_data`)

**Problem.** Current Stock is deliberately never stored. Every read recomputes it as `initial_stock + billed − consumed`, where those two terms are built by pulling **every row of five tables into Python dictionaries**:

```python
SELECT l.item_name, l.size, l.base_qty FROM erp.bill_lines   l JOIN erp.bill_headers   h ...  -- all rows
SELECT ...                             FROM erp.return_lines  l JOIN erp.return_headers  h ...  -- all rows
SELECT ...                             FROM erp.wastage_lines l JOIN erp.wastage_headers h ...  -- all rows
SELECT ...                             FROM erp.issue_lines   l JOIN erp.issue_headers   h ...  -- all rows
SELECT ... FROM erp.production WHERE lower(status)='completed'                                   -- all rows,
                                                        -- then iterate each JSONB components array
```

**Evidence.** No date window, no `LIMIT`, no aggregation pushed into SQL, no cache. Across the whole service layer there is exactly **one non-trivial `LIMIT`** (in `ledger_audit_service.py`); the six others are `SELECT 1 ... LIMIT 1` existence probes. All 166 RPC read methods return complete tables.

**Amplification.** This runs on:
- every Stock tab visit
- every Item Ledger view
- **every bill save** — `check_stock_adjustment_conflicts` calls `get_stock_adjustment_history()`, which is itself an unbounded `SELECT ... ORDER BY created_at DESC` over the entire adjustments table
- every dashboard load, which additionally calls three *other* full-table RPC methods (`get_production_data`, `get_ready_to_dispatch_data`, `get_contractor_ledger_data`) plus a fifth connection for its SQL aggregates

**Projection.** At 200 bills/month with 8 lines each, `bill_lines` reaches ~19 200 rows in a year and ~96 000 in five. Add returns, wastage, issue and production and every Stock read touches six figures of rows and builds six-figure Python dicts — inside a 60 s `statement_timeout`, on one of only four workers. The application does not fail; it just gets slower every single month, which is the hardest performance problem to get funded because there is never a day it breaks.

**Recommended solution — three steps, in order.**

1. **Push the aggregation into SQL.** Replace the five Python loops with one query returning per-item net movement. The expression indexes already exist (`ix_erp_bill_lines_item_name_size`).
   ```sql
   CREATE VIEW erp.v_item_movement AS
   SELECT lower(item_name) AS name_k, lower(size) AS size_k, SUM(delta) AS net
   FROM (
     SELECT l.item_name, l.size,  l.base_qty AS delta FROM erp.bill_lines    l JOIN erp.bill_headers    h ON h.id=l.header_id WHERE h.deleted_at IS NULL AND l.affects_stock
     UNION ALL
     SELECT l.item_name, l.size, -l.base_qty         FROM erp.return_lines  l JOIN erp.return_headers  h ON h.id=l.header_id WHERE h.deleted_at IS NULL
     UNION ALL
     SELECT l.item_name, l.size, -l.base_qty         FROM erp.wastage_lines l JOIN erp.wastage_headers h ON h.id=l.header_id WHERE h.deleted_at IS NULL
     UNION ALL
     SELECT l.item_name, l.size, -l.base_qty         FROM erp.issue_lines   l JOIN erp.issue_headers   h ON h.id=l.header_id WHERE h.deleted_at IS NULL
   ) m GROUP BY 1, 2;
   ```
   Expected: 10–50× reduction, because the row transfer disappears.

2. **Add pagination to the read contract.** `getStockData(page, pageSize, filter, sort)` — additive, so old clients keep working. Do this for the five heaviest reads first: Stock, Bills, POs, Production, Items.

3. **Materialise the balance** once (1) and (2) are in place: an `erp.item_balance` table maintained inside the same transaction as each movement, with `CHECK (qty >= 0)` where the business allows. This converts an O(history) read into an O(1) read *and* gives you the database-level guard that DATA-002 needs.

**Measurement.** Before changing anything, capture the baseline:
```sql
SELECT calls, mean_exec_time, total_exec_time, query
FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 20;
```
`pg_stat_statements` is not currently enabled. Enable it — you cannot prioritise this work without it.

---

### PERF-003 — Nested connection acquisition can exhaust the pool and hard-fails

- **Severity** P1 · **Category** Reliability / Performance · **Status** Confirmed
- **Location** 8+ sites; representative: `bill_service.py:391`, `stock_service.py:73`, `po_service.py:72`, `items_service.py:603,625,1009`, `return_service.py:204`, `wastage_service.py:164`, `issue_service.py:188`, `warehouse_service.py:489`, `stock_rows.py:101`

**Problem.** Functions already holding a pooled connection call helpers that open a **second** connection from the same pool:

```python
# bill_service.save_bill — inside @database.transactional, holding a connection
item_unit_map = items_service.get_item_unit_info_map(cur)   # correct: reuses cur
units_map     = units_service.get_units_map()               # opens a SECOND connection
```
```python
def get_units_map() -> dict:
    with database.get_conn(...) as (_conn, cur):    # ← from the same pool
```

**Evidence.** `psycopg2.pool.ThreadedConnectionPool.getconn()` **raises `PoolError: connection pool exhausted`** when full — it does not block and wait. So the failure mode is a hard 500, not a queue.

**Failure scenario.** `DB_POOL_MAX=20`. Under load, 20 requests each hold one connection and each then asks for a second. Every one of them raises. The pool does not recover until the in-flight requests finish, and each of them fails. Effective concurrency is halved in the best case and collapses in the worst.

Additionally, the second connection is a **separate transaction**, so it cannot see uncommitted work from the first — a correctness trap already noted (correctly) elsewhere in the codebase for `_import_items_from_stock`.

**Recommended solution.** Make every helper accept a cursor, with the self-opening variant reserved for top-level entry points:

```python
def get_units_map(cur=None) -> dict:
    if cur is not None:
        return _units_map_from(cur)
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_c, c):
        return _units_map_from(c)
```
Then pass `cur` at all 8+ call sites. Better still, cache `units_map` per-request in `flask.g` — units change perhaps monthly and are read on nearly every write path.

**Add a guard so this cannot regress**: raise in debug/test if `get_conn` is entered while a connection is already checked out on this thread.

Also raise `DB_POOL_MAX` deliberately: 4 workers × 20 = 80 connections against Postgres's default `max_connections = 100` leaves almost no headroom for `psql`, backups, or a second app instance. Either lower the per-worker max or raise the server's limit — and consider PgBouncer if worker count grows.

**Priority.** P1 — this is a cliff, not a slope. It is invisible until concurrency crosses a threshold, then it is a total outage.

---

### PERF-004 — 3.36 MB unbundled frontend with three competing cache-busting schemes

- **Severity** P1 · **Category** Performance / Deployment · **Status** Confirmed
- **Location** `templates/erp/index.html:511-566`, `static/erp/sw.js`, `config.py:93`

**Problem — measured.**

| | Size | Files |
|---|---|---|
| Application JS | **1 439 KB** | 20 files, unminified |
| Vendor JS + CSS | 1 794 KB (≈900 KB excluding lazily-loaded SheetJS) | 12 files |
| `styles.css` | 127 KB | 1 file |
| **Total shell** | **3 359 KB uncompressed** | 33 files |

All 20 application files are `<script src>` tags in document order with **no `defer` and no `async`** — render-blocking. There is no bundler, no minifier, no tree-shaking, no code splitting, no source maps.

nginx gzip brings this to roughly 700–900 KB over the wire, which is survivable. **Parse and compile cost is not compressed**, and it is paid on every load, including from cache. On the low-end Android tablets this app is built for, parsing 1.4 MB of JavaScript is seconds of blocked main thread before the first tab renders.

**Three overlapping cache-invalidation mechanisms, all hand-maintained:**

1. `sw.js`'s `CACHE_NAME = 'erp-shell-v34'` — 34 manual bumps, each with a changelog comment. Precached assets are served **cache-first with no revalidation**, so a forgotten bump ships an edit to nobody, permanently. The comment history records this happening at v22, v27, v29, v31, v32 and v34.
2. Per-file query strings in `index.html`: `dashboard.js?v=6`, `dispatch.js?v=3`, `planning-board.js?v=5`, `dispatch-plan.js?v=6` — while `core.js`, `production.js`, `stock.js`, `items.js` and 12 others have **no version at all**.
3. `config.VERSION = str(int(time.time()))`, computed at *import* time and used on the auth pages. Each gunicorn worker imports separately, so **four workers emit four different `?v=` values for the same file**, and every restart invalidates everything.

There is a CI job (`sw-cache`) that fails the build when a precached asset changes without a `CACHE_NAME` bump — a good mitigation, and it should stay. But it is a guard rail on a mechanism that should not need one.

**Recommended solution.** Introduce a build step. This is the single highest-leverage change available to the frontend, and it collapses five findings at once.

- Add **esbuild** (a single dependency, sub-second builds, no framework commitment, no rewrite): bundle the 20 files into 2–3 chunks, minify, emit source maps, and produce **content-hashed filenames** (`core.a1b2c3d4.js`).
- Content hashing makes all three cache-busting schemes obsolete: the URL changes if and only if the bytes change. Serve hashed assets with `Cache-Control: immutable, max-age=31536000`. The service worker precaches the manifest, and the `CACHE_NAME` problem disappears structurally.
- Split by route: Dashboard + core in the initial chunk; Production (392 KB), Stock (149 KB), Items (113 KB) and Process (118 KB) loaded on first visit to their tab. `showTab` is already the single navigation choke point, so this is a small change.
- Expected: initial payload from ~1 440 KB to ~250–350 KB; time-to-interactive on a mid-range tablet roughly halved.

**Migration risk.** Moderate but contained — the files are plain scripts on a shared `App` global, which esbuild handles with an IIFE bundle and no source changes. Keep unbundled output available behind a flag for one release.

---

### REL-001 — No timeouts on any outbound HTTP call or any client fetch

- **Severity** P1 · **Category** Reliability · **Status** Confirmed
- **Location** `app/auth/routes.py:97, 435, 447` and `static/erp/api.js:_request`

**Server side.** Three `requests` calls in the OAuth flow have no `timeout=`:
```python
def _google_cfg():
    return requests.get(current_app.config["GOOGLE_DISCOVERY_URL"]).json()   # no timeout
token_response = requests.post(token_url, headers=headers, data=body, auth=(...))  # no timeout
userinfo_response = requests.get(uri, headers=headers, data=body)                   # no timeout
```
`requests` defaults to **no timeout** — it will wait forever. Each sign-in makes two `_google_cfg()` calls plus two more requests. With 4 sync workers, four users signing in while Google's endpoint is slow or a captive portal is swallowing packets means **every worker is blocked and the whole ERP is unreachable**. On a factory LAN with flaky internet this is not hypothetical.

Fix: `requests.get(url, timeout=(3.05, 10))` on all three, and cache the discovery document (it changes rarely) rather than fetching it twice per login.

**Client side.** `api.js`'s `fetch` has no `AbortController` and no timeout. A request that stalls never settles, so the spinner spins forever and the user has no recovery except reloading the page.

```js
const ctrl = new AbortController();
const t = setTimeout(() => ctrl.abort(), 30_000);
try {
  res = await fetch(url, { ...opts, signal: ctrl.signal });
} finally { clearTimeout(t); }
```
Treat an abort as `isNetworkError = true` so the existing offline-outbox retry logic picks it up unchanged.

**Priority.** P1. Two-line fixes; the server-side one is a total-outage risk.

---

### TEST-001 — Authentication and authorization are the least-tested code in the application

- **Severity** P1 · **Category** Testing · **Status** Confirmed (measured)
- **Location** measured from a full `pytest --cov` run: **713 passed, 85% overall**

The overall number is good. The distribution is the problem:

| Module | Coverage | What is untested |
|---|---|---|
| `app/erp/services/roles_service.py` | **36%** | The entire custom-role permission system |
| `app/utils.py` | **39%** | `role_required`, `get_or_create_user` |
| `app/erp/services/remarks_service.py` | 39% | |
| `app/auth/routes.py` | **49%** | `api_signup` (186–235), OAuth initiation (327–366), the whole callback token exchange (444–518) |
| `app/erp/services/profile_service.py` | 62% | Password change |
| `app/middleware/error_handling.py` | 62% | |
| `app/erp/services/users_service.py` | 67% | Role assignment |
| `app/erp/rpc.py` | 87% | **Lines 76–84: the per-tab authorization gate itself** |
| — business services — | **86–96%** | well covered |

**This is exactly inverted.** The code that decides *who may do what* is the code with the least verification, and the three P0 security findings in this report all live in those uncovered lines. SEC-002's `api_signup` role assignment sits in the untested 186–235 range; SEC-003's state check is explicitly bypassed under `TESTING` and so is never exercised at all.

**Recommended tests, in priority order.**
1. `api_signup` assigns `pending_approval`; the resulting session is 403 on RPC.
2. OAuth callback: missing state → 400; mismatched state → 400; matching state → success.
3. Each of the four roles × each of the three access levels × a read and a mutation method — a table-driven matrix over `get_effective_tab_level`.
4. A deactivated user cannot log in by password, by Google, or via an existing session.
5. A password reset invalidates existing sessions and the token cannot be replayed.
6. Two concurrent `saveDispatch` calls for the same product: exactly one succeeds (DATA-002).
7. Two concurrent requests with the same `X-Mutation-Id`: exactly one execution (DATA-003).
8. Backup → restore into an empty database → row counts match for all 52 tables (DATA-001).

Raise the CI coverage gate to a real, blocking threshold — but gate on `app/auth`, `app/utils.py` and `app/erp/services/roles_service.py` specifically at ≥85%, not on the global number, which is already comfortably above any threshold you would set.

---

### CI-001 — The frontend is never built, linted or tested in CI; the security and coverage gates cannot fail

- **Severity** P1 · **Category** Reliability / Process · **Status** Confirmed
- **Location** `.github/workflows/ci.yml`, `test.yml`

**Evidence.** `grep -n "npm\|node\|jest\|eslint"` across both workflow files returns **zero matches**. Meanwhile:
- 1.44 MB of application JavaScript ships to every user
- 22 Jest suites / **383 tests** exist and all pass locally (verified: 11.1 s)
- `eslint.config.js` and `.stylelintrc.json` are configured and clean (verified: 0 errors)
- `package.json` defines `npm run verify` = lint + lint:css + test

None of it runs on a pull request. The tests can silently rot, and a `ReferenceError` in `production.js` reaches the factory floor.

**Three more gates that exist but cannot fail:**
```yaml
- run: pip-audit -r requirements.txt --format json > security-report.json || true
  continue-on-error: true          # a known CVE can never block a merge
- run: ruff format --check Project-root/
  continue-on-error: true
- name: Coverage threshold check
  env: { MIN_COVERAGE: 25 }
  run: |
    if coverage_rate < threshold:
        print("::warning::...")
        sys.exit(0)                # soft — passes regardless
```
The coverage gate is set to 25% (actual is 85%) *and* exits 0 when below it. It is decorative.

Schema initialisation is `continue-on-error: true`, so tests can run against a half-built schema and the failure surfaces as confusing test errors rather than a clear setup failure.

**Recommended solution.**
```yaml
frontend:
  name: Frontend (lint + tests)
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with: { node-version: '22', cache: 'npm', cache-dependency-path: Project-root/package-lock.json }
    - run: npm ci
      working-directory: Project-root
    - run: npm run verify        # eslint + stylelint + jest — all blocking
      working-directory: Project-root
```
Then make `pip-audit` fail on findings at HIGH or above, make `ruff format --check` blocking, set the coverage gate to `sys.exit(1)` at a threshold just below current (80%), and remove `continue-on-error` from schema initialisation.

Add the two missing safety nets while you are there: a **backup restore test** (§DATA-001) and a **migration replay test** (apply all migrations to an empty database, twice, and assert idempotency).

---

### MIG-001 — Migration runner has no lock, and three trackers disagree about schema version

- **Severity** P1 · **Category** Data Integrity / Operations · **Status** Confirmed
- **Location** `migrations/erp/runner.py`, `deploy/mtc.service` (`ExecStartPre`)

**Problem (a) — no lock.** `run_pending_migrations` reads the pending list and applies each file in its own transaction, with no advisory lock. `deploy/mtc.service` runs it on **every start**, with `Restart=always`. Two instances starting together — a restart loop, a rolling deploy, `docker-compose scale` — both compute the same pending set and both execute it. `CREATE TABLE IF NOT EXISTS` is harmless; `ALTER TABLE ... ADD COLUMN` and data-migration statements are not. Migration `032_recalc_contractor_payable_per_unit_extra_charge.sql` is exactly the dangerous kind: **a recalculation applied twice produces wrong money.** The `UNIQUE` on `migration_name` causes one side to roll back — which happens to save you today, but only because every statement is transactional. Any future `CREATE INDEX CONCURRENTLY` breaks the accident.

Fix — one line at the top of the run:
```python
with conn.cursor() as cur:
    cur.execute("SELECT pg_advisory_lock(%s)", (MIGRATION_LOCK_KEY,))   # blocks, does not skip
```

**Problem (b) — three trackers.** The runner's own docstring admits it:
- `erp.migrations_applied` — the runner (35 `.sql` files)
- `public.migrations_applied` — `migrations/migration_tracker.py`
- `public.schema_migrations` — `tests/conftest.py`

Plus ~35 loose `migration_*.py` scripts in `migrations/` that the runner never touches, and 12 ad-hoc `check_*.py` / `create_table_*.py` scripts sitting in the project root. **There is no single answer to "what schema version is this database at",** which makes a restore, a rollback or a clean-room rebuild an act of archaeology.

Fix: pick one — the `erp` runner, extended to cover `public` — and formally retire the rest into `archive/` with a README explaining what they were. Add `--status` output to the deployment checklist.

**Problem (c) — no down-migrations.** No rollback path exists for any migration. For a system with a broken backup (DATA-001), forward-only migrations mean a bad migration has no recovery. Fixing DATA-001 first substantially mitigates this.

---

### AUDIT-001 — No before/after history on 47 of 50 tables

- **Severity** P1 · **Category** Data Integrity / Compliance · **Status** Confirmed
- **Location** schema-wide

**Evidence.** Of 50 `erp.*` tables, only three record history: `stock_adjustments` (manual corrections), `rate_history` (vendor rates), `ledger_audit_log` (automated reconciliation findings). Everything else carries `updated_by` / `updated_at` only — last writer, current value.

Soft-delete coverage is good: 53 `deleted_at` columns, and 32 of 35 delete paths set `updated_by` alongside — so *who deleted* is answerable.

*What changed* is not. You cannot answer **"who changed this bill's total from ₹50,000 to ₹5,000, when, and what was it before?"** The previous value is simply gone.

**Business impact.** For a system holding GST invoices, vendor payables and contractor payments, this is a genuine compliance and dispute-resolution gap. When a vendor disputes an invoice, or an internal fraud question arises, the data needed to answer it was never captured.

**Recommended solution.** Generic trigger-based audit — one table, one function, attached to the tables that hold money and quantities. No application changes.

```sql
CREATE TABLE erp.audit_log (
    id           BIGSERIAL PRIMARY KEY,
    table_name   TEXT        NOT NULL,
    row_id       BIGINT      NOT NULL,
    operation    TEXT        NOT NULL,        -- INSERT | UPDATE | DELETE
    changed_by   INTEGER     REFERENCES public.users(user_id),
    changed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    old_values   JSONB,
    new_values   JSONB
);
CREATE INDEX ix_audit_log_table_row ON erp.audit_log (table_name, row_id, changed_at DESC);
```
Attach to `bill_headers`, `bill_lines`, `po_headers`, `po_lines`, `production`, `dispatch_headers`, `dispatch_lines`, `contractor_payments`, `stock` first. Store only changed keys, not whole rows, to control growth; partition by month once it grows.

**Intelligent opportunity.** Once this exists, a "Recent changes" panel on each record answers *"what happened to this while I was away?"* — the single most common question in shared-record workflows, and one the application cannot answer at all today.

---

### DEPLOY-001 — Container runs as root

- **Severity** P1 · **Category** Security · **Status** Confirmed
- **Location** `Project-root/Dockerfile`

No `USER` directive; no non-root user is created. Every process runs as uid 0. `gcc` and `libpq-dev` (build toolchain) are installed and never removed, and there is no multi-stage build — so the runtime image carries a compiler.

The systemd path is properly hardened (`User=mtc`, `ProtectSystem=strict`), so the two deployment paths have materially different security postures — a trap for whoever deploys the container assuming parity.

```dockerfile
FROM python:3.12-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends libpq-dev gcc \
 && pip install --no-cache-dir --prefix=/install -r requirements.txt

FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
        libpq5 postgresql-client libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --create-home mtc
COPY --from=build /install /usr/local
WORKDIR /app
COPY --chown=mtc:mtc . .
USER mtc
EXPOSE 8000
ENTRYPOINT ["./docker-entrypoint.sh"]
```

---

### MONEY-001 — All monetary arithmetic is IEEE-754 float; totals are never persisted

- **Severity** P1 · **Category** Data Integrity · **Status** Confirmed
- **Location** service layer throughout; `bill_service.py:43-51`; `migrations/erp/008_bill_ledger.sql`

**Evidence.** The schema does the right thing — 55 `NUMERIC` columns, zero `DOUBLE PRECISION`/`REAL`. The application immediately undoes it: **zero uses of `Decimal` anywhere in `app/erp/`**, and 150+ `float(...)` conversions across the services. Every amount is read from `NUMERIC`, converted to binary floating point, computed, and written back.

```python
def _compute_line_totals(qty: float, price: float, gst_rate_pct: float) -> dict:
    subtotal   = qty * price
    gst_amount = subtotal * (gst_rate_pct / 100)
    line_total = subtotal + gst_amount
    return {"subtotal": round(subtotal, 2), "gstAmount": round(gst_amount, 2),
            "lineTotal": round(line_total, 2)}
```

Three compounding problems:

1. **Float drift.** Binary floating point cannot represent 0.1 exactly. Across thousands of lines, ledger totals drift from what an accountant computes.
2. **Banker's rounding.** Python's `round()` is round-half-to-even. Indian invoicing convention is round-half-up. `round(2.675, 2)` → `2.67`. Systematic single-paisa disagreements with vendor invoices, in a direction that looks like carelessness in an audit.
3. **Totals are derived, never stored.** `erp.bill_headers` has no `total_amount` column — I checked migration 008. Every bill's total is recomputed on read. So a bill's total is not a *record of what the vendor invoiced*; it is *whatever the current code computes*. Change the GST logic and every historical bill silently changes. There is nothing to reconcile against.

**Recommended solution.**
- Register the adapter so psycopg2 returns `Decimal` and use it end to end:
  ```python
  from decimal import Decimal, ROUND_HALF_UP
  def money(x) -> Decimal:
      return Decimal(str(x)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
  ```
- Constrain the columns: `NUMERIC(14,2)` for money, `NUMERIC(14,4)` for quantities. Bare `NUMERIC` accepts whatever scale it is given, including float artefacts.
- **Persist the header totals** at save time (`subtotal`, `gst_amount`, `total_amount`) and treat them as the record. Keep the derived computation as a *reconciliation check* — if stored and derived disagree, that is a finding for `ledger_audit_service` to report, which is exactly the kind of thing it already exists to do.

**Risk.** Touches every money path; needs a careful migration that backfills stored totals from current logic and a reconciliation report before and after. Schedule it as its own release.

---

### P2 findings (condensed)

| ID | Category | Finding | Location |
|---|---|---|---|
| SEC-006 | Security | **Password reset tokens are replayable and do not invalidate sessions.** `itsdangerous` tokens stay valid for the full hour even after use, and existing sessions survive a reset — so an attacker whose access prompted the reset keeps their session. Bind the token to the current `password_hash` (so using it invalidates it) and rotate the session on reset. | `auth/routes.py:44-52, 355-390` |
| SEC-007 | Security | **`api_reset_password` does not filter `deleted_at IS NULL`**, so a deactivated account's password can be reset (they still cannot log in). Inconsistent with every other query. | `auth/routes.py:378` |
| SEC-008 | Security | **`/auth/logout` is a GET route with no CSRF protection** — `<img src="/auth/logout">` on any page logs the user out. | `auth/routes.py:518` |
| SEC-009 | Security | **No account lockout or per-account throttle.** Login is limited to 10/min *per IP*; the whole factory shares one NAT address, so the limit punishes legitimate users and barely inconveniences an attacker. Add per-account backoff. | `auth/routes.py:124` |
| SEC-010 | Security | **`DB_PASS` defaults to `"abcd"`** in `config.py`. Same class of problem as SEC-001. | `config.py:69` |
| SEC-011 | Security | **`X-Request-ID` is accepted from the client unvalidated** and written into logs and response headers — log injection via embedded newlines. Validate as a UUID or discard. | `middleware/request_id.py:28` |
| DATA-004 | Data Integrity | **Only 5 `CHECK` constraints across 50 tables.** Business invariants (`qty >= 0`, `price >= 0`, `0 <= gst_rate_pct <= 100`, valid status values) live only in Python, so any direct SQL, migration or future code path can violate them. | `migrations/erp/*.sql` |
| DATA-005 | Data Integrity | **`erp.rpc_mutations` grows without bound** — a full JSONB result envelope per mutation, forever, with no pruning anywhere. | `migrations/erp/002` |
| PERF-005 | Performance | **`getStockAdjustmentHistory` has no `LIMIT`** and is called on every bill save via `checkStockAdjustmentConflicts`. | `stock_service.py:421` |
| PERF-006 | Performance | **`getDashboardData` opens 5+ sequential connections** and calls four other full-table RPC methods. Mitigated by a 5-minute visibility-aware refresh, but it is the landing tab. | `dashboard_service.py:339` |
| PERF-007 | Performance | **`config.VERSION` is per-process import time** — 4 workers emit 4 different `?v=` values for the same asset. | `config.py:93` |
| REL-002 | Reliability | **`cache.addAll()` is atomic** — one 404 among 35 precache URLs and the service worker never installs, silently, with no diagnostics. Use per-URL `cache.add()` with logged failures. | `sw.js:install` |
| REL-003 | Reliability | **Background jobs are daemon threads inside gunicorn workers**, and `--max-requests 1000` recycles workers — a recycle kills a running audit or backup mid-flight, with no retry and no alert. `stop_event` is created and never used. Move to a systemd timer. | `ledger_audit_service.py:377`, `backup_service.py:352` |
| REL-004 | Reliability | **`send_reset_email` blocks the request thread on SMTP.** A slow mail server holds one of four workers. | `auth/routes.py:54` |
| REL-005 | Reliability | **`render_pdf_batch` accepts 200 documents in one synchronous request**; gunicorn's 120 s timeout will kill the worker mid-batch and the user gets nothing. Make it a background job with a download link. | `pages.py:render_pdf_batch` |
| API-001 | Correctness | **The 15 s read cache caches `{success:false}` envelopes.** Domain failures return HTTP 200, so a transient failure is replayed from cache for 15 s and a user retry does not reach the server. Cache only `success === true`. | `api.js:_cachedRequest` |
| OBS-001 | Observability | **Two competing request-ID middlewares are both active**, the second overwriting the first's `g.request_id`, with two separate `get_request_id()` accessors. They agree only by coincidence. | `app/__init__.py`, `middleware/request_id.py`, `middleware/error_handling.py` |
| OBS-002 | Observability | **No metrics, no error tracking, no APM.** No `pg_stat_statements`, no request-duration histogram, no Sentry. Logs go to `logs/app.log` and the journal; nothing aggregates or alerts. You cannot answer "how long did that take" or "is it getting worse". | — |
| A11Y-001 | Accessibility | **`aria-selected` is never updated on the desktop tablist.** The markup is correct (`role="tablist"`/`tab`/`tabpanel`, `aria-controls`), but `showTab` only toggles the `active` class — so a screen reader reports Dashboard as selected forever. **`mobile.js:563` does this correctly.** | `core.js:1754` |
| A11Y-002 | Accessibility | **No `<main>` landmark and no skip link** in the desktop shell (only `<aside>`). Keyboard and screen-reader users must traverse the entire sidebar on every navigation. | `templates/erp/index.html` |
| A11Y-003 | Accessibility | **No arrow-key navigation in the tablist** — WAI-ARIA's tab pattern requires it once `role="tablist"` is declared. | `core.js` |
| UX-001 | UX | **A failed load leaves a permanent "Loading…" row** in 23 `loadData()` functions; the only error signal is a 3-second toast. Add an error state with a Retry button. | 12 files |
| UX-002 | UX | **No debounce on desktop.** 57 `input` handlers re-filter and re-render the full table per keystroke. `mobile.js` has a `debounce` utility; the desktop shell does not. | `static/erp/*.js` |
| UX-003 | UX | **Double-escaping in the vendor print view** — `escapeHtml(entry.items)` where `entry.items` is already escaped, so the printed document shows literal `&amp;lt;` entities. | `vendors.js:551` |
| CI-002 | Process | **`pip-audit` cannot fail the build** (`\|\| true` + `continue-on-error`), and the coverage gate is 25% and soft. | `ci.yml` |
| TD-001 | Tech Debt | **12 ad-hoc scripts in the project root** (`check_*.py`, `create_table_*.py`, `test_supplier_fix.py`, `scratch_login_render.html`) plus `venv/`, `venv2/`, `venv.obsolete/`, `.venv/` — four virtualenvs. Move to `archive/` or delete. | repo root |
| TD-002 | Tech Debt | **`app/__init__.py` is 837 lines** doing config, logging, limiter, CSP, CORS, blueprints, health, teardown, schedulers and middleware. Split into `extensions.py`, `logging.py`, `security.py`, `health.py`. | `app/__init__.py` |
| TD-003 | Tech Debt | **`process_service.py` is 2 443 lines**, `items_service.py` 1 604, `production.js` 392 KB. Split by responsibility. | — |
| TD-004 | Tech Debt | **Four rendering paradigms coexist**: string templates + `innerHTML` (dominant), jQuery/Select2, Bootstrap components, and htm/preact (in `planning-board.js` only). | `static/erp/` |
| TD-005 | Tech Debt | **`login()` returns 401 with the message "Use /auth/api/login for JSON login"** — production behaviour shaped by a test's needs. | `auth/routes.py:107` |
| TD-006 | Tech Debt | **Jest coverage reports 0% for every file** despite 383 real tests, because they load source via `fs.readFileSync` + `eval` (which Istanbul cannot instrument). The tests are genuine — this is an instrumentation artefact — but it means **frontend coverage is unmeasurable**, so gaps cannot be found. The loader also regex-rewrites `const App = ` and will break on a reformat. | `static/erp/tests/*.test.js` |

---

## 6. Missing Features Matrix

| Feature | Why needed | User impact | Business impact | Priority | Dependencies |
|---|---|---|---|---|---|
| **Verified, restorable backups** | The current ones do not restore | None until disaster, then total | Existential | **Absolutely required** | DATA-001 |
| **Server-side pagination / filter / sort** | Every read returns a whole table | Slower every month | Unusable in 2–3 years | **Absolutely required** | PERF-002 |
| **Field-level audit trail** | No before/after values retained | Cannot resolve disputes | GST compliance, fraud detection | **Absolutely required** | AUDIT-001 |
| **Stored document totals** | Bill totals are recomputed, not recorded | Totals can change retroactively | No reconcilable financial record | **Absolutely required** | MONEY-001 |
| **Bulk operations** | No multi-select actions beyond print/delete | Repetitive one-at-a-time work | Hours/week lost | Strongly recommended | Selection state exists |
| **Saved views / remembered filters** | Filters reset on every tab switch | Re-filtering dozens of times daily | Direct productivity | Strongly recommended | Pagination |
| **Global search across modules** | Search is per-table substring only | "Where did I see that PO?" is manual | Direct productivity | Strongly recommended | Server-side search |
| **Approval workflow for high-value documents** | Any `user` can create/edit any bill | No spend control | Fraud exposure | Strongly recommended | Roles exist |
| **Email/SMS notifications** | Alerts only appear in-app | Overdue items missed when not logged in | Missed deadlines | Strongly recommended | Mail configured |
| **Export to Excel/CSV from every grid** | SheetJS is bundled but used narrowly | Manual copy-paste into Excel | Reporting friction | Strongly recommended | SheetJS present |
| **Report builder / scheduled reports** | No reporting beyond the dashboard | Ad-hoc requests go to whoever knows SQL | Management blind spots | Optional | Pagination, exports |
| **Attachments on documents** | Cannot attach a vendor invoice scan to a bill | Paper filing stays parallel | Slower dispute resolution | Optional | File storage |
| **Multi-currency / multi-location** | Single currency, single warehouse assumed | Blocks expansion | Growth constraint | Future | Schema change |
| **Mobile parity for desktop-only modules** | Mobile covers a subset | Tablet users switch to desktop | Workflow friction | Optional | — |

---

## 7. Security Findings — summary

| ID | Severity | Finding | Status |
|---|---|---|---|
| SEC-001 | **P0** | `SECRET_KEY` fail-fast never fires; hardcoded fallback in tracked source | Confirmed |
| SEC-002 | **P0** | Self-service signup grants immediate full ERP access | Confirmed |
| SEC-003 | **P0** | OAuth `state` check skipped when session state is absent (login CSRF) | Confirmed |
| SEC-004 | P1 | Stored XSS in Vendor ledger; CSP allows `'unsafe-inline'` | Confirmed |
| SEC-005 | P1 | All 166 API methods exempt from rate limiting | Confirmed |
| SEC-006 | P2 | Reset tokens replayable; sessions survive password reset | Confirmed |
| SEC-007 | P2 | Reset path ignores `deleted_at` | Confirmed |
| SEC-008 | P2 | GET logout, no CSRF | Confirmed |
| SEC-009 | P2 | No per-account lockout; per-IP limiting defeated by NAT | Confirmed |
| SEC-010 | P2 | `DB_PASS` defaults to `"abcd"` | Confirmed |
| SEC-011 | P2 | Client-controlled `X-Request-ID` reaches logs unvalidated | Confirmed |
| DEPLOY-001 | P1 | Container runs as root; build toolchain in runtime image | Confirmed |

**Verified clean — do not regress:**
- **SQL injection**: all 16 dynamic-SQL sites interpolate only module constants; every user value is parameterised.
- **SSRF / local file read via PDF rendering**: comprehensively defended (no external fetch, no `base_url`, no JS engine, validated density, size caps).
- **Secrets in git**: `gcp-key.json` and `.env` are untracked and correctly ignored in both `.gitignore` and `.dockerignore`, with an explanatory comment about the difference.
- **Security headers**: CSP, HSTS, `X-Frame-Options`, secure-cookie flags — all present and correctly gated on whether TLS is actually in use.

---

## 8. Data Integrity Findings — summary

| ID | Severity | Finding |
|---|---|---|
| DATA-001 | **P0** | Backups are unrestorable and partial failures report success |
| DATA-002 | P1 | Dispatch over-allocation race; zero `FOR UPDATE` in the service layer |
| DATA-003 | P1 | Idempotency is TOCTOU; desktop saves never reuse an id |
| MONEY-001 | P1 | Float money; totals derived, never stored; banker's rounding |
| AUDIT-001 | P1 | No before/after history on 47 of 50 tables |
| MIG-001 | P1 | No migration lock; three competing schema trackers |
| DATA-004 | P2 | 5 `CHECK` constraints across 50 tables |
| DATA-005 | P2 | `erp.rpc_mutations` unbounded |
| FN-08 | P2 | `get_or_create_user` ignores `deleted_at` |

**Verified good:** 68 foreign keys, 69 indexes including 22 expression indexes matching the `lower()` predicates actually used, consistent `deleted_at` soft-delete (53 columns) with `updated_by` recorded on 32 of 35 delete paths, and a trigger-maintained `row_version` sequence for offline sync.

---

## 9. Performance Findings

### Performance Optimization Matrix

| # | Issue | Root cause | Expected impact | Difficulty | Priority | Measurement |
|---|---|---|---|---|---|---|
| 1 | Current Stock full-scans 5 tables per read | Formula computed in Python, never stored | **10–50×** on Stock/Dashboard/Item Ledger | M | P1 | `pg_stat_statements` total_exec_time |
| 2 | No pagination on 166 reads | Inherited Sheets API contract | Payload from MB to KB; scales flat | M–L | P1 | Response size + p95 latency per method |
| 3 | Redis pool disconnected per request | `teardown_appcontext` misuse | Removes a TCP connect from every limited request | **XS** | P1 | `redis-cli info stats` connections |
| 4 | Nested pool acquisition (8+ sites) | Helpers open their own connections | Doubles effective concurrency; removes an outage cliff | S | P1 | Pool checkout gauge; `PoolError` count |
| 5 | 3.36 MB unbundled frontend | No build step | Initial payload ~1 440 KB → ~300 KB | M | P1 | Lighthouse TTI on a mid-range tablet |
| 6 | Full re-render per keystroke | No debounce on desktop | Eliminates input lag on large tables | **XS** | P2 | Input-to-paint latency |
| 7 | `getStockAdjustmentHistory` unbounded, called per bill save | No `LIMIT` | Removes an O(n) scan from the save path | XS | P2 | Query time on save |
| 8 | Dashboard opens 5+ connections | Composes four full-table RPCs | ~5× fewer round trips | M | P2 | Connection checkouts per request |
| 9 | 4 sync workers | Default config | Throughput ↑ with async workers or more workers | S | P2 | Requests/sec under load |
| 10 | `?v=` cache-busting inconsistent | Three manual schemes | Correct caching; eliminates a deploy hazard | M (with #5) | P2 | Cache hit ratio |

**You cannot prioritise this list without measurement. Enable `pg_stat_statements` first** — it is one line in `postgresql.conf` and a restart, and it will tell you within a day whether item 1 or item 2 is the real cost at your current data volume.

---

## 10. UX Findings

**Strengths.** The information architecture matches how the factory actually works — the sidebar reads as the production process, not as a database schema. Loading placeholders exist. Errors persist in a notification centre rather than vanishing with the toast. Modal record navigation (N/P and arrow keys, with an unsaved-changes guard) is a thoughtful touch most business apps lack. The mobile PWA's offline outbox is genuinely sophisticated work.

**Gaps.**

| ID | Finding | Impact |
|---|---|---|
| UX-001 | 23 tables show "Loading…" forever after a failed load; the only error signal is a 3-second toast | User assumes the app is hung |
| UX-002 | No debounce — every keystroke re-renders the full table | Visible input lag on tablets |
| UX-004 | Filters and sort reset on every tab switch | Re-filtering dozens of times a day |
| UX-005 | No bulk operations beyond print and delete | One-at-a-time repetitive work |
| UX-006 | No keyboard shortcuts beyond modal record navigation | No Ctrl+S, Ctrl+K search, Ctrl+N new |
| UX-007 | No "recently viewed" or favourites | Re-navigating to the same records daily |
| UX-008 | Every edit is a modal — no inline editing on tables | Modal-open/close cycle for a one-field change |
| UX-009 | No unsaved-changes protection on browser navigation (only modal-internal) | Data loss on an accidental back button |
| UX-010 | Confirmation dialogs on low-risk actions; no undo anywhere | Dialog fatigue, then a real deletion confirmed reflexively |

---

## 11. Responsive Design Findings

**Breakpoints found:** 900px, 768px, 600px, 576px, plus `print`, `prefers-reduced-motion` and `forced-colors`.

| ID | Finding | Severity |
|---|---|---|
| RES-001 | **Tablet portrait (769–900px) is under-served.** An iPad-class device in portrait gets the desktop table layout compressed, not a designed layout. Wide ledger tables (14+ columns) overflow. This is the form factor a factory floor most likely uses. | P2 |
| RES-002 | **Two separate applications, not one responsive one.** `mobile.js` (289 KB) and `mobile_styles.css` are a parallel implementation with a different design system, reached by a redirect. Feature parity is partial and drifts. | P2 (architectural) |
| RES-003 | Desktop data tables have no responsive strategy — no horizontal scroll container, no column priority, no card fallback. | P2 |
| RES-004 | Touch targets in desktop table action buttons (`btn-sm`) are below the 44×44 px guidance, and the desktop shell is what a tablet in landscape receives. | P2 |

**Notable inversion:** the mobile design system is the *better* one. It has a coherent palette built for workshop-floor lighting, proper touch targets, a debounce utility, and correct `aria-selected` handling. The desktop shell — the older, larger codebase — is the one that needs to catch up.

---

## 12. Accessibility Findings

**Genuinely good:** every `<th>` carries a `scope` (verified by a passing test — this was a prior audit finding and it was properly fixed), 106 `aria-label`s, 28 `aria-modal`s, correct `role="tablist"`/`tab`/`tabpanel` markup, a `role="alert" aria-live="assertive"` toast, and both `prefers-reduced-motion` and `forced-colors` media queries. There is an automated axe gate in the Jest suite.

| ID | Finding | WCAG | Severity |
|---|---|---|---|
| A11Y-001 | `aria-selected` never updated on the desktop tablist (mobile does it correctly) | 4.1.2 | P2 |
| A11Y-002 | No `<main>` landmark, no skip link | 1.3.1, 2.4.1 | P2 |
| A11Y-003 | No arrow-key navigation in the tablist | 2.1.1 | P2 |
| A11Y-004 | Colour contrast unverified — the axe gate disables `color-contrast` because jsdom has no layout engine | 1.4.3 | P2 |
| A11Y-005 | Focus is not moved to the table after an async load, nor restored on modal close | 2.4.3 | P2 |
| A11Y-006 | Table sort state not announced (`aria-sort` absent) | 4.1.2 | P3 |
| A11Y-007 | Form validation errors not programmatically associated (`aria-describedby`, `aria-invalid`) | 3.3.1 | P2 |

**Recommendation:** add a Playwright + axe run against the live app in CI to cover contrast and focus order — the two categories jsdom structurally cannot check. `puppeteer-core` is already a dev dependency.

---

## 13. Reliability Findings

| ID | Finding | Severity |
|---|---|---|
| REL-001 | No timeouts on outbound HTTP (OAuth) or client `fetch` — a hung dependency blocks all four workers | P1 |
| REL-002 | `cache.addAll()` is atomic; one bad URL silently prevents service-worker installation | P2 |
| REL-003 | Background jobs are daemon threads inside recyclable workers | P2 |
| REL-004 | Synchronous SMTP blocks a worker | P2 |
| REL-005 | 200-document PDF batch will exceed the 120 s gunicorn timeout | P2 |
| REL-006 | Service-worker cache correctness depends on a hand-edited version string (CI-guarded, but structurally fragile) | P2 |

**Positive:** `/health` genuinely probes the database rather than returning a static 200, is exempted from `force_https` so Kubernetes probes are not satisfied by a redirect, is exempt from the rate limiter (a 10-second probe would otherwise exhaust "200 per day" within the hour and take down the whole deployment), and never leaks the DSN into the error response. Every one of those is a real production failure someone learned about the hard way, and each is documented in the code.

---

## 14. Testing Gaps

**Measured, not estimated:**

| Suite | Result | Coverage |
|---|---|---|
| Python (`pytest`) | **713 passed** in 279 s | **85%** overall |
| JavaScript (`jest`) | **383 passed** in 11 s | **unmeasurable** (see TD-006) |
| `ruff` | All checks passed | — |
| `eslint` | 0 errors, 115 warnings | — |
| `stylelint` | clean | — |

**Critical gaps:**

1. **Authorization is the least-tested code.** `roles_service.py` 36%, `app/utils.py` 39%, `auth/routes.py` 49%, and `rpc.py`'s tab-permission gate (lines 76–84) uncovered. All three P0 security findings live in untested lines.
2. **No concurrency tests.** Not one test exercises two simultaneous requests. DATA-002 and DATA-003 are both invisible to a sequential suite.
3. **No backup-restore test.** The single most important thing to verify, and it is unverified.
4. **No migration idempotency test.** Apply-all-twice against an empty database would have surfaced MIG-001.
5. **Frontend coverage is unmeasurable** — the `readFileSync` + `eval` loader defeats Istanbul. The tests are real; the visibility is not.
6. **Frontend tests never run in CI** (CI-001).
7. **No load or soak testing.** PERF-002's growth curve has never been measured.

---

## 15. Observability Gaps

The system cannot currently answer the questions it needs to answer.

| Question | Answerable today? |
|---|---|
| What happened? | Partly — `logs/app.log` + journal, unstructured |
| Why did it happen? | Partly — RPC failures log a request id and stack trace (good) |
| Which user was affected? | Yes for RPC errors; no elsewhere |
| Which request caused it? | Yes — request id, though **two competing implementations** (OBS-001) |
| Which component failed? | Partly |
| How long did it take? | **No** — no duration metrics anywhere |
| Is it getting worse? | **No** — no time series, no trend, no alerting |

**Missing entirely:** metrics (`prometheus-flask-exporter`), error tracking (Sentry), `pg_stat_statements`, slow-query logging, log aggregation, alerting on backup failure or health-check failure, and a business-event log distinct from the application log.

**Highest-value first step:** enable `pg_stat_statements` and add `prometheus-flask-exporter`. Together those are under an hour of work and turn PERF-002 from a theory into a number.

---

## 16. Technical Debt Register

| ID | Debt | Interest rate |
|---|---|---|
| TD-001 | 12 ad-hoc scripts in the project root; four virtualenvs (`venv`, `venv2`, `venv.obsolete`, `.venv`) | Low, but it makes the repo hard to trust |
| TD-002 | `app/__init__.py` — 837 lines, ten responsibilities | Medium — every change risks an unrelated one |
| TD-003 | `process_service.py` 2 443 lines; `production.js` 392 KB | Medium |
| TD-004 | Four rendering paradigms coexist | Medium |
| TD-005 | Production behaviour shaped by test needs (`login()` 401) | Low |
| TD-006 | Frontend coverage unmeasurable; test loader regex-rewrites source | Medium |
| MIG-002 | Three schema trackers, ~35 orphaned migration scripts | **High** — blocks confident restore/rollback |
| PERF-004 | No frontend build step | **High** — the root cause of five findings |
| RES-002 | Desktop and mobile are two applications | **High** — every feature is built twice or only once |

---

## 17. Intelligent Application Opportunities

The application already ships one genuinely intelligent feature: **`ledger_audit_service`**, an hourly automated cross-ledger reconciliation, coordinated across workers with advisory locks, surfacing findings in the notification bell. That is Level-3 decision assistance, already working. Build on it.

### Level 1 — Smart UX (weeks, deterministic, no AI)

| Opportunity | Why it pays |
|---|---|
| **Remember filters, sort and column widths per user per tab** | Users re-apply the same filters dozens of times a day. Pure `localStorage` + a `user_preferences` table. |
| **Recently viewed / pinned records** | The same 10 vendors and 20 items account for most traffic. |
| **Smart defaults from the last entry** | A new bill for a known vendor should pre-fill contact, GST rate, terms and the items last supplied. |
| **Rate suggestion on PO/Bill lines** | `erp.rate_history` and `erp.item_vendors` already hold the data — surface "last rate ₹142.50 on 12 Aug, ₹138.00 from Sharma Cycles" inline. |
| **Global command palette (Ctrl+K)** | One search across POs, bills, items, vendors, clients, lots and dispatches. Collapses the biggest navigation cost. |
| **Inline editing for single-field changes** | Threshold, dead-stock flag, remarks — no modal. |
| **Bulk operations across every grid** | Selection state already exists; the actions do not. |

### Level 2 — Workflow Automation (weeks, deterministic)

| Opportunity | Mechanism |
|---|---|
| **Automatic PO status transitions** | PO status is already derived from bills; make it explicit, timestamped and notified. |
| **Reorder suggestions** | `erp.stock.threshold` exists and low-stock is computed. Generate a draft PO grouped by preferred vendor, using historical rates and lead times. |
| **Overdue detection and escalation** | Nothing currently flags a PO issued 45 days ago with no bill, or a production lot open for three weeks. The data is there. |
| **Approval routing** | Bills over a threshold route to an approver. Roles infrastructure exists. |
| **Scheduled reports by email** | Weekly stock position, monthly vendor spend, contractor payables ageing. |
| **Automatic document generation** | The PDF renderer already exists — attach a generated challan to a dispatch automatically. |

### Level 3 — Decision Assistance (months, deterministic + statistics)

| Opportunity | Mechanism |
|---|---|
| **Extend the ledger audit into a health score** | It already finds mismatches; add trend, severity and an owner. |
| **Anomaly detection on rates and quantities** | "This bill's rate is 34% above the 90-day average for this item." Simple z-score over `rate_history` — no ML needed. |
| **Vendor scorecards** | On-time delivery, price stability, return rate, over/under-delivery — all derivable from existing tables. |
| **Production bottleneck detection** | Which process stage accumulates the most WIP-days. |
| **Demand forecast for reorder points** | Moving average + seasonality over consumption history. |
| **Margin analysis per product** | BOM cost vs dispatch price, with drift alerts. |

### Level 4 — AI Assistance (only where it earns its place)

Two candidates justify the cost. The rest do not.

**1. Natural-language query over the ERP.** *"Show me overdue POs from Ludhiana vendors over ₹50,000."*
- **Value:** high — it removes the reporting bottleneck entirely.
- **Approach:** LLM generates a *parameterised* query against a **restricted read-only view layer**, never raw SQL against base tables. Show the generated filter to the user before running it.
- **Failure mode:** a wrong-but-plausible answer. Mitigate by rendering the interpreted filters as visible chips the user can correct, and by never letting it write.
- **Cost/latency:** ~1–3 s per query, cents per query. Acceptable.
- **Prerequisite:** the pagination/filter API from PERF-002. Do not build this first.

**2. Vendor invoice extraction.** Photograph or PDF → draft bill lines.
- **Value:** high — bill entry is the most repetitive, highest-volume manual task in the system.
- **Approach:** vision model → structured extraction → **pre-filled draft that a human confirms**, never a direct write.
- **Failure mode:** a misread digit becomes a wrong payable. Mitigate with confidence scores per field, mandatory human confirmation, and a hard block on auto-approval.
- **Prerequisite:** document attachment storage, which does not exist yet.

**Explicitly not recommended:** a chatbot wrapper over the UI (adds a layer between the user and a task they can already do in two clicks), AI-generated dashboard summaries (the numbers are the summary), and LLM-based anomaly detection (a z-score is cheaper, faster, deterministic and explainable — and an accountant can audit it).

**Principle to hold:** every Level 1–3 item above is deterministic, explainable, testable and free to run. Exhaust them before spending a rupee on inference.

---

## 18. Automation Opportunities

| Area | Current | Automatable |
|---|---|---|
| Backup verification | None | Nightly restore-and-count into a scratch database |
| Migration application | Manual on start, unlocked | Locked, verified, with a status report |
| Reorder | Manual | Draft POs from threshold + lead time + rate history |
| PO ageing | Manual | Automatic overdue flag + escalation |
| Contractor payments | Manual | Payable ageing + payment-due reminders |
| Stock reconciliation | Manual | Extend the existing hourly ledger audit |
| Report distribution | Manual | Scheduled email |
| Deployment | Scripted (`deploy.sh`) | CI-gated deploy with health-check rollback |
| Dependency updates | Manual | Dependabot + a blocking `pip-audit` |

---

## 19. Recommended Target Architecture

**Deliberately evolutionary. Nothing here is a rewrite** — the current architecture is sound, and the evidence does not support replacing it.

```
┌──────────────────────────────────────────────────────────────┐
│ FRONTEND                                                     │
│  esbuild: 20 files → 3 content-hashed chunks (core / tabs /  │
│    vendor), minified, source-mapped, route-split             │
│  One design system shared by desktop and mobile (mobile's    │
│    tokens win — they are the better set)                     │
│  Escape-by-default tagged template replaces manual escapeHtml│
│  Service worker precaches the build manifest — CACHE_NAME    │
│    and every hand-edited ?v= disappear                       │
├──────────────────────────────────────────────────────────────┤
│ API — keep the RPC bridge, extend the contract               │
│  POST /api/erp/rpc/<method>          (unchanged, allowlisted)│
│  + {page, pageSize, filter, sort} on every read (additive)   │
│  + per-user rate limits, tiered by method cost               │
│  + one id per user action, atomically claimed                │
├──────────────────────────────────────────────────────────────┤
│ APPLICATION                                                  │
│  app/__init__.py split → extensions / logging / security /   │
│    health / blueprints                                       │
│  Services take `cur`; only entry points open connections     │
│  Decimal end to end for money                                │
│  Per-request cache in flask.g for units/settings/permissions │
├──────────────────────────────────────────────────────────────┤
│ BACKGROUND — out of the web workers                          │
│  systemd timers (or one worker process):                     │
│    ledger audit · backup+verify · mutation prune ·           │
│    reorder suggestions · overdue detection · reports         │
├──────────────────────────────────────────────────────────────┤
│ DATA                                                         │
│  Aggregation in SQL (views), not Python dicts                │
│  Materialised item_balance + warehouse_pool_balance,         │
│    maintained transactionally, CHECK (qty >= 0)              │
│  Advisory locks on availability-consuming operations         │
│  Stored document totals (subtotal / gst / total)             │
│  Generic trigger-based erp.audit_log                         │
│  CHECK constraints for every business invariant              │
│  One migration tracker, advisory-locked                      │
├──────────────────────────────────────────────────────────────┤
│ OPERATIONS                                                   │
│  pg_stat_statements · prometheus-flask-exporter · Sentry     │
│  pg_dump backups, verified, encrypted, off-box               │
│  CI: python + frontend + a11y + backup-restore + migration   │
│      replay — all blocking                                   │
└──────────────────────────────────────────────────────────────┘
```

**What is deliberately *not* recommended:** microservices, a frontend framework rewrite, an ORM migration, event sourcing, or Kubernetes. This is a single-factory ERP with a handful of concurrent users. Every one of those would add more complexity than it removes.

---

## 20. Recommended UX Target State

The application should feel like **a colleague who already knows what you are working on.**

- **Fast** — a tab opens in under 300 ms because it fetches one page, not one table.
- **Predictable** — every action has a visible loading, success, empty and error state; errors offer a Retry, not a vanished toast.
- **Context-aware** — it remembers your filters, your recent records, and where you left off.
- **Assistive** — it suggests the vendor's last rate, flags that this bill is 34% above average, and drafts the reorder PO before you ask.
- **Consistent** — one design system across desktop and tablet, one table component, one modal pattern, one terminology set.
- **Low friction** — Ctrl+K finds anything; bulk actions work everywhere; single-field edits happen inline.
- **Professional** — an accountant trusts the totals because they were recorded at save time, not recomputed, and can see who changed what.
- **Accessible** — a full keyboard path through every workflow, correct ARIA state, verified contrast.
- **Intelligent without being intrusive** — suggestions are visible and dismissible; nothing is auto-applied to a financial record.

**The five changes that move the needle most:** persistent filters · global command palette · bulk operations · inline editing · a proper error state with Retry.

---

## 21. Implementation Roadmap

### Phase 0 — Critical Stabilisation *(days — do not deploy without these)*
1. **SEC-001** — remove the `SECRET_KEY` fallback; harden the guard against weak values
2. **SEC-002** — password signup assigns `pending_approval`; audit existing accounts
3. **SEC-003** — fail closed on a missing OAuth state; constant-time compare
4. **DATA-001** — replace the backup with `pg_dump`; verify with `pg_restore --list`; make partial failure fatal
5. **SEC-010** — remove the `DB_PASS` default
6. **REL-001** — add timeouts to the three OAuth calls

### Phase 1 — Reliability *(2–4 weeks)*
7. **DATA-002** — advisory locks on dispatch and stock availability paths
8. **DATA-003** — atomic mutation claim; one id per user action; prune the table
9. **SEC-004** — escape the four XSS sinks; plan the tagged-template migration
10. **SEC-005** — per-user tiered rate limits
11. **PERF-001** — move pool teardown out of the request lifecycle; delete the dead database branch
12. **PERF-003** — thread `cur` through the 8+ nested-connection sites; add a regression guard
13. **MIG-001** — advisory lock on migrations; retire the two orphan trackers
14. **CI-001** — frontend job in CI; make security, format and coverage gates blocking
15. **TEST-001** — the eight priority tests listed in §14
16. **OBS** — `pg_stat_statements`, `prometheus-flask-exporter`, Sentry
17. **DEPLOY-001** — non-root, multi-stage Dockerfile

### Phase 2 — UX & Responsiveness *(4–8 weeks)*
18. Error state with Retry across all 23 `loadData` functions
19. Debounce on desktop (a 10-line utility, 57 call sites)
20. `aria-selected` sync, `<main>`, skip link, arrow-key tablist
21. Tablet-portrait breakpoint and a table responsive strategy
22. Persistent filters, sort and recent records
23. Bulk operations across every grid
24. Playwright + axe in CI for contrast and focus order

### Phase 3 — Performance *(6–10 weeks)*
25. **PERF-002 step 1** — push stock aggregation into SQL views
26. **PERF-002 step 2** — pagination on the five heaviest reads
27. **PERF-004** — esbuild: bundle, minify, content-hash, route-split
28. Retire the three cache-busting schemes in favour of content hashes
29. **PERF-002 step 3** — materialised balances with `CHECK` constraints
30. **MONEY-001** — Decimal end to end; store document totals; constrain `NUMERIC` scale
31. **AUDIT-001** — trigger-based audit log

### Phase 4 — Intelligent Experience *(8–12 weeks)*
32. Global command palette (Ctrl+K)
33. Smart defaults and rate suggestions from `rate_history`
34. Reorder suggestions from threshold + lead time
35. Overdue detection and escalation
36. Vendor scorecards and rate-anomaly alerts
37. Scheduled email reports
38. Approval routing for high-value documents

### Phase 5 — Advanced Intelligence *(only after Phase 3)*
39. Natural-language query over a restricted read-only view layer
40. Vendor invoice extraction into a human-confirmed draft

---

## 22. Dependency Map

```
SEC-001 (SECRET_KEY) ──── independent, do first
SEC-002 (signup role) ─── independent, do first
SEC-003 (OAuth state) ─── independent, do first
DATA-001 (backups) ────── independent, do first
                              │
                              ▼ (a working restore de-risks everything below)
MIG-001 (lock) ──────────────┴──▶ MONEY-001 (totals migration)
                                  AUDIT-001 (trigger migration)

PERF-003 (nested conns) ──▶ PERF-002 step 1 (SQL views)
                                  │
                                  ▼
                            PERF-002 step 2 (pagination)
                                  │
                    ┌─────────────┴──────────────┐
                    ▼                            ▼
              UX-004 (saved filters)      L4-1 (NL query)
              FN-07 (server search)

PERF-004 (build step) ──▶ retires REL-006, PERF-007, CI cache-bump job
                      └──▶ enables route splitting and RES-002 convergence

SEC-004 (escape) ────▶ tagged template ────▶ remove 'unsafe-inline' from CSP

CI-001 (frontend CI) ──▶ prerequisite for every frontend change below
TEST-001 (auth tests) ─▶ prerequisite for confidently changing auth
OBS (metrics) ─────────▶ prerequisite for prioritising PERF work by evidence
```

**Critical path:** Phase 0 → `PERF-003` → `PERF-002 step 1` → `PERF-002 step 2` → everything productivity-related.

---

## 23. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Undetected auth bypass via SEC-001 | **Medium** (depends on whether `SECRET_KEY` is set today — **verify immediately**) | **Catastrophic** | Fix, then rotate the key |
| Data loss with unrestorable backups | Low per year, **certain over time** | **Catastrophic** | DATA-001 first |
| Unauthorised account via SEC-002 | **High** if reachable beyond the LAN | Severe | One-line fix + account audit |
| Performance degradation to unusable | **Certain** on current trajectory | Severe | PERF-002; measure with `pg_stat_statements` |
| Inventory corruption via DATA-002 | Medium, scales with users | Severe | Advisory locks + `CHECK` constraints |
| Stale asset shipped via missed SW bump | Medium (CI-guarded) | Moderate | Content hashing (PERF-004) |
| Frontend regression reaching users | **High** — 383 tests never run in CI | Moderate | CI-001 |
| Pool exhaustion outage under load | Medium | Severe | PERF-003 |
| Migration applied twice | Low | Severe | MIG-001 advisory lock |
| Bus factor / knowledge concentration | High | Moderate | The inline commentary is unusually good — already well mitigated |

---

## 24. Quick Wins

Ordered by value ÷ effort. The first six are hours, not days.

| # | Change | Effort | Value |
|---|---|---|---|
| 1 | Remove the `SECRET_KEY` and `DB_PASS` fallbacks | 15 min | **Closes a P0** |
| 2 | `role="pending_approval"` in `api_signup` | 5 min | **Closes a P0** |
| 3 | Fail closed on missing OAuth state | 10 min | **Closes a P0** |
| 4 | Move the Redis pool teardown out of `teardown_appcontext`; delete the dead database branch | 20 min | Removes a per-request TCP connect and a per-request log line |
| 5 | `timeout=(3.05, 10)` on the three OAuth `requests` calls | 10 min | Removes a total-outage risk |
| 6 | `escapeHtml` on the four `vendors.js` sinks | 15 min | Closes a stored XSS |
| 7 | Add a frontend job to CI (`npm run verify`) | 30 min | 383 tests + 3 linters start protecting the frontend |
| 8 | Make `pip-audit`, `ruff format` and the coverage gate blocking | 20 min | Three gates start working |
| 9 | `LIMIT 500` on `getStockAdjustmentHistory` | 10 min | Removes an O(n) scan from every bill save |
| 10 | Advisory lock in the migration runner | 15 min | Removes a data-corruption path |
| 11 | Cache only `success === true` envelopes in `api.js` | 10 min | Fixes cached-failure retries |
| 12 | Sync `aria-selected` in `showTab` (copy `mobile.js:563`) | 10 min | Fixes screen-reader tab state |
| 13 | `<main>` landmark + skip link | 20 min | Two WCAG criteria |
| 14 | Add a `debounce` utility and wire the ten hottest search inputs | 2 h | Removes visible input lag |
| 15 | Enable `pg_stat_statements` | 10 min + restart | Makes all performance work evidence-based |

**Roughly one focused day closes three P0s, one P1 XSS, two outage risks, and turns on every quality gate the repository already has but does not enforce.**

---

## 25. Long-Term Improvements

1. **Frontend build pipeline** (esbuild) — retires five findings at once and unblocks route splitting.
2. **Paginated API contract** — the single change that makes the application scale.
3. **Materialised balances with database-level constraints** — makes inventory correctness structural rather than procedural.
4. **Converge desktop and mobile onto one design system and one component set** — halves the cost of every future feature.
5. **Decimal money with stored document totals** — makes the financial record trustworthy.
6. **Trigger-based audit log** — makes the system auditable.
7. **Background jobs out of web workers** — makes scheduled work reliable and observable.
8. **Escape-by-default rendering** — makes XSS structurally impossible rather than a review responsibility.

---

## 26. Final Production Readiness Assessment

**Not ready for unattended production use today** — for three specific, individually small reasons.

The gap between how good this codebase is and how safe it currently is comes down to configuration and one misjudged utility function. `SECRET_KEY` has a fallback that defeats its own guard. The backup writes a file that will not restore. Signup hands out the wrong role. None of those is an architectural failure; all three are close to one-line fixes; and all three are invisible from the UI, which is exactly why they survived until an audit.

Everything else in this report is the ordinary work of taking a well-built system from "works for the people who built it" to "safe for a business to depend on": bound the reads, add locks where money and inventory are consumed, put the frontend behind a build step, and make the quality gates that already exist actually block.

**This is not a rewrite candidate. It is a system three days from safe and one quarter from good.**

---

## 27. Final Scorecard

| Dimension | Score | Basis |
|---|---:|---|
| Architecture | **7/10** | Clean layering, allowlisted RPC, sound service boundaries. Held back by an 837-line factory and an inherited whole-table API contract. |
| Code Quality | **8/10** | 0 ruff errors, 0 ESLint errors, clean stylelint, exceptional inline commentary. Held back by three files over 1 500 lines. |
| Functional Completeness | **8/10** | Broad, coherent domain coverage. One stubbed feature, one significant category (pagination) absent by design. |
| Reliability | **5/10** | Excellent health check, hardened systemd, offline outbox. Undermined by no HTTP timeouts and jobs in recyclable workers. |
| Security | **3/10** | Genuinely strong headers, CSRF, parameterised SQL, secret hygiene — and **three P0s that defeat authentication entirely**. |
| Data Integrity | **4/10** | 68 FKs, disciplined soft deletes, idempotency infrastructure. Undermined by unrestorable backups, no row locks, float money, and 5 CHECK constraints across 50 tables. |
| Performance | **4/10** | Sensible indexes and a client read cache. Structurally unbounded: whole-table reads, no pagination, 3.36 MB unbundled frontend. |
| UX | **6/10** | Domain-shaped IA, persistent notification centre, modal record navigation. Held back by stuck loading states, no debounce, no persistence, no bulk actions. |
| Responsive Design | **6/10** | Excellent on desktop and on the mobile PWA. Tablet portrait unserved; two parallel applications. |
| Accessibility | **6/10** | `scope` on every `th`, 106 aria-labels, reduced-motion and forced-colors, an automated axe gate. Held back by stale `aria-selected`, no `<main>`, unverified contrast. |
| Testing | **7/10** | 713 backend tests at 85%, 383 frontend tests, all passing. Held back by inverted coverage (auth lowest), no concurrency tests, no backup test, and none of it in CI for the frontend. |
| Observability | **4/10** | Request ids, structured RPC error logging with a user-quotable reference. No metrics, no APM, no alerting, no query stats, two competing request-id systems. |
| Maintainability | **7/10** | The commentary alone puts this above most commercial code. Held back by god-files and four rendering paradigms. |
| Scalability | **4/10** | Vertical only. Whole-table reads and pool-exhaustion cliffs cap it well before the hardware does. |
| Automation | **6/10** | Ledger audit, backup scheduler, idempotency, service worker, scripted deploy — genuinely more than most. Held back by non-blocking CI gates. |
| Intelligence | **3/10** | The ledger audit is real Level-3 work. Nothing else anticipates, suggests, or acts. |

### Composite scores

| | Score | |
|---|---:|---|
| **Overall Application Maturity** | **5.5 / 10** | A well-built system with three configuration failures and two structural constraints |
| **Production Readiness** | **3 / 10** | Gated entirely on the three P0s — rises to ~7/10 the day they are fixed |
| **UX Quality** | **6 / 10** | Good bones, missing the persistence and shortcuts that make daily work fast |
| **Intelligence / Automation Maturity** | **3.5 / 10** | One genuine automated-reconciliation feature; the rest is unexploited data |

---

## PRINCIPAL ARCHITECT VERDICT

# NO-GO

**— pending three specific fixes, after which: CONDITIONAL GO.**

I would not sign this off for unattended production use today, and the reason is narrow. `SECRET_KEY` falls back to a value published in this repository while the guard meant to prevent that only checks truthiness; the backup system writes files that cannot be restored and reports partial failures as success; and anyone who can reach the login page can issue themselves a fully privileged account. Each is close to a one-line fix. Together they mean the application currently has neither reliable authentication nor a recovery path.

That is a much better position than it sounds. There is no architectural rot here. The service layer is clean, the SQL is parameterised throughout, the PDF renderer is more carefully secured than most commercial code, the test suite is real and passing, and the inline documentation is the best I have read in a business application of this size. The problems are at the seams — configuration, concurrency, and the absence of a frontend build step — not in the design.

**Fix the ten items below and this becomes a CONDITIONAL GO immediately.** Complete Phase 1 and it is a straightforward GO.

### Top 10 issues that must be fixed first

1. **SEC-001** — `SECRET_KEY` falls back to a published constant; the production guard cannot fire *(complete auth bypass)*
2. **DATA-001** — backups do not restore, and partial failures report success *(no recovery path)*
3. **SEC-002** — self-service signup grants immediate full ERP access *(privilege escalation by design)*
4. **SEC-003** — OAuth `state` check skipped when session state is absent *(login CSRF)*
5. **DATA-002** — no row locking anywhere; concurrent dispatches over-allocate inventory
6. **REL-001** — no timeouts on OAuth HTTP calls; a slow Google blocks all four workers
7. **SEC-005** — all 166 API methods exempt from rate limiting *(trivial self-inflicted DoS)*
8. **PERF-003** — nested pool acquisition hard-fails on exhaustion rather than queueing
9. **SEC-004** — stored XSS in the Vendor ledger under a CSP that permits inline script
10. **CI-001 / TEST-001** — 383 frontend tests never run in CI; authorization is the least-covered code in the application

### Top 10 opportunities that would most improve user productivity and application intelligence

1. **Server-side pagination, filtering and sorting** — the one change that makes everything else possible
2. **Global command palette (Ctrl+K)** across POs, bills, items, vendors, clients, lots and dispatches
3. **Persistent filters, sort and recently-viewed records** per user per tab
4. **Rate and vendor suggestions on PO/Bill lines** — `rate_history` and `item_vendors` already hold the data
5. **Reorder suggestions** — draft POs from threshold, lead time and historical rates
6. **Overdue and stalled-work detection** — a PO with no bill after 45 days, a lot open three weeks
7. **Bulk operations and inline editing** across every grid
8. **Extend the ledger audit into a real operational health surface** — trend, severity, owner
9. **Rate-anomaly alerts and vendor scorecards** — z-scores over existing data, no ML required
10. **Natural-language query over a restricted read-only view layer** — *after* pagination lands, not before

---

*Audit performed against `verification/claude-appscript-pwa-20260727` @ `e2b2bca`, 24 August 2026. Every finding marked Confirmed was traced to a specific file and line, or reproduced by execution. The 713 Python tests, 383 JavaScript tests, ruff, ESLint and stylelint were all run as part of this audit; their results are quoted as measured, not estimated.*
