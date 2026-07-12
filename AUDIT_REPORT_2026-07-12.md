# MTC Repository Audit — 2026-07-12

**Scope:** Full repository — security, architecture, database layer, tests, CI/CD, and repo hygiene.
**Method:** Every finding below was verified directly against the code at the cited file/line on branch `claude/mtc-repository-audit-h175dn` (identical to `main` at commit `9feb247` at audit time). Findings from older reports in this repo were re-checked rather than trusted.

> ⚠️ **This report supersedes the earlier audit documents in `Project-root/`** — see [Stale documentation](#stale-documentation-superseded) at the end. Spot-checks show their "critical" findings are already fixed, and they reference files that do not exist (e.g. `app/api/upf.py`).

---

## Executive summary

| Area | Grade | One-line assessment |
|---|---|---|
| Data exposure | 🔴 **Critical** | A production DB dump with real user emails + password hashes is committed to git |
| Security hardening | 🟠 High risk | CSRF and SQL parameterization are good; auth endpoints unprotected, security headers absent |
| Architecture | 🟠 High debt | Working app, but a 2,693-line god file, 5 entrypoints, duplicated double-root layout |
| Database layer | 🟡 Medium | Raw psycopg2 is consistent and parameterized, but migrations have no single source of truth |
| Tests | 🟡 Medium | 200+ real tests exist and run in CI, but config conflicts and one broken suite |
| Repo hygiene | 🔴 Poor | ~40 MB of the 56 MB repo is committed logs, backups, and generated artifacts |

**The single most urgent action:** purge `backups/` and `logs/` from git history and rotate all credentials / reset user passwords (finding C1). Everything else can be scheduled; this cannot.

---

## Critical findings

### C1. Production database dump with user credentials committed to git

- **Files:** `backups/db_backup_20251108_132303.sql` (213 KB, custom-format pg_dump), plus `backups/db_backup_20251108_132106.sql` and `backups/code_snapshot_20251108_132304.zip` (3.1 MB full source snapshot).
- **Verified contents:** the dump's data sections decompress to real `users` rows — **6 distinct email addresses (including at least one personal Gmail account) with scrypt password hashes**, alongside full schema and business data (`COPY public.users (user_id, name, email, …, password_hash, company, mobile)`).
- **Impact:** anyone with repo access (now or in the future — history persists through clones and forks) holds user PII and crackable password hashes plus the complete DB schema.
- **Fix (P0):**
  1. Remove `backups/` and all `*.sql` dumps from the working tree **and from git history** (`git filter-repo --path backups --invert-paths`, then coordinate a force-push; all collaborators must re-clone).
  2. Rotate the database password and any other credential that existed on 2025-11-08; force password resets for the exposed accounts.
  3. Add `backups/` and `*.sql` dumps to a root `.gitignore` (see H6).

### C2. Application logs committed to git (~40 MB, includes user activity and internal paths)

- **Files (git-tracked):** `logs/app.log` (5.9 MB), `logs/app.log.10` (9.9 MB), `Project-root/logs/app.log{,.1,.10}` (~23 MB), `Project-root/logs/client_actions.log`, `Project-root/app/logs/app.log*`, `Project-root/app/logs/error.log*`, `tmp_logs_test/logs/*`.
- **Verified contents:** `client_actions.log` records per-user activity (`user_id`, `remote_addr`, URLs); `app.log` leaks the developer's local absolute paths (`C:\Users\erkar\OneDrive\Desktop\MTC\...`).
- **Impact:** privacy leak, 40 MB of a 56 MB repo is noise, and every future commit risks appending more.
- **Fix (P0):** untrack all `logs/` dirs and `tmp_logs_test/`, purge from history together with C1, gitignore them (H6).

---

## High-severity findings

### H1. Hardcoded fallback secrets in `Project-root/config.py`

- `config.py:23` — `SECRET_KEY = os.getenv("SECRET_KEY") or "dev-insecure-key"`: any non-production path (CLI, `FLASK_ENV=development`, misconfigured deploy) silently runs with a publicly known session/CSRF signing key. Production does fail fast (`app/__init__.py:120-138`), which is good, but the insecure default should not exist at all.
- `config.py:59` — `DB_PASS = os.getenv("DB_PASS", "abcd")`: a weak DB password baked in as the default.
- **Fix (P1):** remove both fallbacks; fail fast in every environment, or generate a random ephemeral key for dev with a loud warning.

### H2. `flask-talisman` installed but never initialized — no HTTP security headers

- `Project-root/requirements.txt:25` pins `flask-talisman==1.1.0`, but there is **zero** reference to `Talisman` anywhere in the code. The CSP settings in `production.env.example:75-77` are never read.
- **Impact:** no Content-Security-Policy, no HSTS, no X-Frame-Options → clickjacking and XSS amplification exposure in production.
- **Fix (P1):** initialize Talisman in `create_app()` (or explicitly drop the dependency and document why).

### H3. Auth endpoints have no rate limiting and are CSRF-exempt

- `Project-root/app/auth/routes.py` contains **no** `@limiter.limit` decorators; `api_login`, `api_signup`, and `api_forgot_password` are covered only by the lax global default (`200 per day, 50 per hour`, `app/__init__.py:269`). They are also explicitly CSRF-exempted (`app/__init__.py:452-460`).
- `production.env.example:89` advertises `RATELIMIT_LOGIN=10 per minute`, but no code reads it.
- **Impact:** credential stuffing / brute force at 50 attempts per hour per IP with no per-endpoint throttle.
- **Fix (P1):** add `@limiter.limit("10 per minute")` to login/signup/forgot-password; wire up the env var.

### H4. Hardcoded demo admin login path

- `app/auth/routes.py:101-118`: when `current_app.debug or TESTING`, credentials `demo@example.com` / `Demo@1234` (config-overridable defaults) authenticate as a synthetic **admin** user.
- **Impact:** contained today by the production guard at `app/__init__.py` (debug forced off in prod), but it is a known hardcoded admin credential one misconfiguration away from exposure — and the demo password is published in this repo.
- **Fix (P1):** delete the demo fallback; use seeded test fixtures instead.

### H5. God-file API module and abandoned refactor

- `Project-root/app/api/routes.py`: **2,693 lines, 58 routes** mixing items, suppliers, purchase orders, and variants. `app/api/production_lot.py` is another 1,998 lines / 29 routes. Total ~230 route decorators across the app.
- The intended split exists as empty husks: `app/api/items.py` (86 bytes), `suppliers.py` (90 B), `purchase_orders.py` (96 B), `imports.py` (183 B) — each just a comment saying endpoints live in `routes.py`.
- Duplicate model layer: `app/models.py` (legacy `User` file) still shadows the `app/models/` package despite commit `fa777f6` claiming its removal; `app/models/inventory.py`, `app/utils/helpers.py`, `app/utils/validators.py`, `app/services/export_service.py` are near-empty placeholders.
- **Fix (P2):** finish the split along the existing stub layout; delete `app/models.py` and the placeholder files.

### H6. No root `.gitignore`; the only one is incomplete

- There is **no `.gitignore` at the repo root** at all. `Project-root/.gitignore` covers `.env`, `__pycache__`, `.vscode` — but not `logs/`, `backups/`, `.coverage`, or generated audit JSONs. This is the direct cause of C1/C2 and of 9 tracked `.pyc` files, `Project-root/.coverage`, `enhanced_audit_report.json` (140 KB), `project_audit_report.json` (81 KB), a committed `.vscode/settings.json`, and a 1.6 MB uploaded screenshot in `Project-root/static/uploads/`.
- **Fix (P0):** add a root `.gitignore` covering `logs/`, `backups/`, `__pycache__/`, `*.pyc`, `.coverage`, `*.log`, `*_audit_report.json`, `tmp_logs_test/`, `.vscode/`; `git rm -r --cached` the tracked offenders.

---

## Medium-severity findings

### M1. `run_production.py` falls back to a debug dev server on `0.0.0.0`

- `Project-root/run_production.py:137` — `app.run(host="0.0.0.0", port=port, debug=True)` whenever the environment isn't detected as production. The Werkzeug debugger allows RCE via its console if this ever faces a network.
- **Fix:** never `debug=True` in a file named `run_production.py`; bind dev fallback to `127.0.0.1`.

### M2. OAuth `state` validation is skippable

- `app/auth/routes.py:224-229`: the state check runs only `if expected_state and returned_state != expected_state` — if the session cookie is missing/dropped, the check silently passes instead of rejecting.
- **Fix:** reject the callback whenever `expected_state` is absent (outside TESTING).

### M3. Entry-point sprawl and contradictory run instructions

- Five ways to start one app: root `app.py` ("unified runner" importing `Project-root/app` via sys.path), `Project-root/run.py` (deprecated importlib shim that loads root `app.py`), `run_production.py`, `wsgi.py`, `Procfile`. Root `README.md`/`PROJECT_GUIDE.md` say `python app.py` from repo root; `Project-root/README.md` says `cd Project-root` first; `PROJECT_GUIDE.md` also shows pm2. `import app` is ambiguous between the root module and the `Project-root/app` package.
- **Fix:** keep `wsgi.py` (prod) + one dev runner; delete the shims; align the docs.

### M4. Migrations have no single source of truth

- Three locations: `Project-root/migrations/` (~45 files), repo-root `migrations/` (2 files, one a **divergent duplicate** of `migration_add_inventory_alert_system.py`), and loose `Project-root/migration_{final,safe,new_endpoints}.py`.
- Three competing runner/tracker frameworks in one directory: `migration.py`, `migrations.py`, `migration_tracker.py`. The new tracking table (commit `e233592`) only covers numbered files (`001_…`), so the ~45 legacy `migration_add_*.py` scripts remain untracked. Duplicate `_temp` copies exist.
- **Fix (P2):** consolidate into `Project-root/migrations/` with sequential numbering registered in the tracker; delete duplicates.

### M5. Test infrastructure conflicts

- **Broken suite:** `tests/test_auditor_core.py:14` imports `enhanced_project_auditor` — the `.py` source is not in the repo (`git ls-files` confirms), only a stale compiled `__pycache__/enhanced_project_auditor.cpython-313.pyc`. Collection fails with `ModuleNotFoundError`.
- **Two conflicting `pytest.ini`:** repo-root (`testpaths = Project-root`, sweeps up stray `test_*.py` scripts) vs `Project-root/pytest.ini` (`testpaths = tests`, `--cov=app`). Results depend on invocation directory; repo-root `tests/` is orphaned from CI (workflows run only from `Project-root`).
- **Hard Postgres dependency with hardcoded creds:** `Project-root/tests/conftest.py:26-28` defaults to `postgres`/`abcd`/`testuser` in an autouse session fixture that creates a database and runs all migrations — nothing runs locally without a matching Postgres.
- **Fix (P3):** delete or restore the auditor test; keep a single pytest config; document/require env-provided test DB creds.

### M6. Dependency risks

- `Werkzeug==3.0.1` predates the 3.0.3 security fixes (debugger and multipart-parsing advisories); `Flask==3.0.0`, `Authlib==1.3.0`, `gunicorn==21.2.0`, `redis==5.0.1`, `bcrypt==4.1.3` all lag.
- Two Postgres drivers pinned simultaneously (`psycopg[binary]==3.2.2` **and** `psycopg2-binary==2.9.9`).
- CI's pip-audit job exists but is `continue-on-error: true` (`.github/workflows/ci.yml:102`) — vulnerabilities never fail the build. Coverage gate is also soft (`MIN_COVERAGE: 25`, exits 0 on failure).
- **Fix (P1):** bump Werkzeug/Flask at minimum; drop `psycopg2-binary` once legacy imports are migrated; make pip-audit blocking.

### M7. DOM-XSS surface in frontend JS

- Templates are clean (zero `|safe`, autoescaping intact), but static JS uses `innerHTML`/`.html()` in **208 places across 23 files** (e.g. `static/inventory.js`, `static/js/production_lot_detail.js:24`, `static/js/process_framework_unified.js:34`). Any of these that interpolate server-returned user data is an XSS vector; absent a CSP (H2) there is no backstop.
- **Fix (P2):** audit the interpolation sites, prefer `textContent`/DOM building; add CSP.

---

## Low-severity / hygiene findings

1. **~40 one-off scripts committed** at three levels: 9 `check_*.py`, `create_table_*.py`, `deduplicate_items.py`, `audit_quick_fix.py`, `list_tables.py`, debug/smoke scripts in two `scripts/` dirs, stray test scripts (`test_endpoints.py`, `test_variants.py`, `test_select2_endpoint.py`, `test_oauth.ps1`, root `test_supplier_fix.py` — which hardcodes `C:\Users\erkar\OneDrive\Desktop\MTC\...` — and `test_supplier_fix_v2.py`).
2. **Documentation sprawl:** 64 tracked `.md` files; 18 status/audit/completion reports in `Project-root/`; three competing indexes (`INDEX.md`, `DOCUMENTATION_INDEX.md`, `CONSOLIDATED_GUIDE_INDEX.md`) and three quick-start guides.
3. **Partial Google OAuth client-ID fragment** in deprecated `Project-root/test_oauth.ps1:36` (low sensitivity, still shouldn't be tracked).
4. **`archive/` and `utilities/`** at repo root are empty except READMEs.
5. **Duplicate GitHub workflows:** `.github/workflows/test.yml` overlaps `ci.yml`, and a third nested copy exists at `Project-root/.github/workflows/test.yml`.
6. **Known-broken UI flows** (from commit messages `9feb247`, `f99ecde` — the in-repo issue docs are stale): production-lot detail page and subprocess display, centered on `templates/upf_production_lot_detail.html`, `static/production-lot-detail-enhanced.js`, and the overlapping `subprocess_service.py` / `production_lot_subprocess_manager.py`.
7. **Bandit config skips B602** (`shell=True` detection) in `pyproject.toml`.

---

## What is in good shape

- **CSRF:** properly re-enabled globally (`CSRFProtect`, `app/__init__.py`); blanket blueprint exemptions removed, only specific JSON auth endpoints exempted.
- **SQL injection:** request-reachable queries are consistently parameterized (`%s` bindings, `psycopg2.sql.Identifier`); the f-string SQL in `app/api/routes.py` interpolates only internally built fragments, with values passed as params. No injectable path found.
- **Passwords:** Werkzeug scrypt hashing, strength policy enforced; no plaintext handling found.
- **Session cookies:** `Secure` / `HttpOnly` / `SameSite=Strict` in production.
- **Rate limiter infrastructure:** fails fast in production if Redis is unreachable; several sensitive write endpoints do have per-route limits.
- **Test-DB safety:** `TestingConfig` refuses to run if the test DB equals the production DB (`config.py:116-133`).
- **CI:** Ruff lint (blocking), pytest matrix on Python 3.10–3.12 with a real Postgres service, coverage upload; pre-commit runs detect-secrets, bandit, and ruff.
- **Real test coverage:** 201 test functions across 30 files in `Project-root/tests/`, spanning API, auth, services, and integration flows.

---

## Remediation roadmap

| Priority | Action | Findings |
|---|---|---|
| **P0 — immediately** | Purge `backups/` + all `logs/` from git history (`git filter-repo`), force-push, have collaborators re-clone; rotate DB credentials; reset exposed user passwords; add root `.gitignore` and untrack all artifacts | C1, C2, H6 |
| **P1 — this sprint** | Initialize Talisman (CSP/HSTS/frame-options); rate-limit auth endpoints; remove `dev-insecure-key`/`abcd` fallbacks and demo admin login; fix `run_production.py` debug fallback; bump Werkzeug/Flask; make pip-audit blocking | H1–H4, M1, M6 |
| **P2 — next month** | Single entrypoint + aligned docs; consolidate migrations under the tracker; split `routes.py` along the existing stub layout; delete stale reports, one-off scripts, and empty modules; audit `innerHTML` sites | H5, M3, M4, M7, hygiene |
| **P3 — ongoing** | Fix/remove broken auditor test; unify pytest config; env-driven test DB creds; fix the two known-broken UI flows | M5, hygiene #6 |

> **Note on P0:** history rewriting requires a force-push and coordination with everyone who has a clone — it is deliberately **not** performed as part of this audit and needs an explicit decision by the repository owner. Until it happens, treat the repo as containing live user PII.

---

## Stale documentation (superseded)

The following in-repo reports no longer match the code and should not be used as a defect list (verified examples: the "missing" `/api/upf/monitoring/alerts-health` endpoint now exists at `app/api/inventory_alerts.py:611`; the triple-registered `/processes/<id>` route is gone; the recommended fix location `app/api/upf.py` never existed):

`Project-root/COMPREHENSIVE_AUDIT_REPORT.md`, `STACK_SYNC_AUDIT_REPORT.md`, `SYNC_ANALYSIS_REPORT.md`, `DUPLICATE_ROUTES_REPORT.md`, `ISSUES_TO_FIX.md`, `UPF_CODE_REVIEW_REPORT.md`, `APP_PY_CLEANUP_REPORT.md`, plus the 11 `*_COMPLETE.md` / `*_SUMMARY.md` status files. Recommend deleting them (git history preserves them) as part of P2.
