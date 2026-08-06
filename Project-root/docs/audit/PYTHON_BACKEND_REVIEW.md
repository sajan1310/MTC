# Python Backend Review — Phases 6, 8 & 10

Scope: `app/**`, `config.py`, `database.py`, `logging_config.py`, entry points,
`migrations/`. Query-level findings are in `SQL_OPTIMIZATION.md`.

---

## What is already correct

| Practice | Evidence |
|---|---|
| **Clean layering** | `pages` (HTML) / `rpc` (transport) / `services` (domain) / `database` (access). No SQL in routes, no Flask objects in services. |
| **Idempotent mutations** | `X-Mutation-Id` UUID + replay cache (`rpc.py:33-45`) — correct handling of double-submit and offline replay. Better than most production systems. |
| **Explicit method allowlist** | `RPC_METHODS` (`registry.py:24`) with duplicate-registration raising (`:42`). No dynamic dispatch to arbitrary attributes. |
| **Transaction decorator** | `@database.transactional` injects `(conn, cur)` and owns commit/rollback consistently. |
| **Fail-fast configuration** | Required keys validated at boot (`app/__init__.py:151-170`); production refuses to start with `debug=True` (`:666`). |
| **Fail-fast Redis in production** | `RuntimeError` if the rate-limit backend is unreachable in prod, graceful in-memory fallback in dev (`:322-337`). |
| **Test-DB isolation guard** | `DATABASE_URL` deliberately excluded from env override under `testing`, with the production-data incident documented in-comment (`:124-141`). |
| **Comment quality** | Consistently explains *why*, including the bug that motivated the design (`:405-413`, `pages.py:29-54`). Genuinely rare. |

---

## Findings

| ID | Title | Severity | Priority |
|---|---|---|---|
| PY-001 | Blanket `except Exception` converts all bugs into HTTP 200 | Critical | P0 |
| PY-002 | No input validation on any of 135 RPC methods | Critical | P0 |
| PY-003 | Rate limiter fully exempt on the only data endpoint | High | P1 |
| PY-004 | `create_app()` is a 400-line function doing 15 jobs | High | P1 |
| PY-005 | Private flask-limiter internals mutated at boot | Medium | P2 |
| PY-006 | Teardown probes `database` by attribute-name guessing | Medium | P2 |
| PY-007 | 19 loose scripts at repo root; dead compat shims | Medium | P2 |
| PY-008 | Two schedulers started in the app factory | Medium | P2 |
| PY-009 | No authorization layer — authentication only | High | P1 |
| PY-010 | Four entry points with divergent configuration | Medium | P2 |
| PY-011 | Service modules exceed 1,000 lines with private cross-imports | Medium | P2 |

---

## PY-001 · Blanket `except Exception` converts every bug into HTTP 200
**Location** `app/erp/rpc.py:49-52` · **Severity** Critical · **Priority** P0

```python
try:
    result = spec.func(*args)
except Exception as exc:  # noqa: BLE001 -- domain errors become {success:false}, not 500s
    result = build_response(False, None, str(exc))
```

**Description.** The intent — documented in the module docstring — is sound:
domain errors ("PO number must not be empty") should be `{success: false}`, not
500s. The problem is that this catches **everything**:

| Actual failure | What the user sees | What monitoring sees |
|---|---|---|
| `ValueError("PO number must not be empty")` | correct message | nothing (correct) |
| `AttributeError: 'NoneType' has no attribute 'strip'` | `"'NoneType' object has no attribute 'strip'"` | **nothing** |
| `KeyError: 'vendor_name'` | `"'vendor_name'"` | **nothing** |
| `psycopg2.OperationalError: connection lost` | raw DB error text | **nothing** |
| `TypeError: save_po() takes 1 positional argument but 4 were given` | raw traceback text | **nothing** |

Three distinct problems:

1. **No error is ever logged.** There is no `logger.exception()` in the handler.
   A `NameError` in `production_service` is invisible to operators — no 500, no
   log line, no alert. The application can be substantially broken while
   reporting HTTP 200 on every request.
2. **Internal details leak to the client.** `str(exc)` on a `psycopg2` error
   exposes schema names, column names and connection details. **This is an
   information-disclosure issue**, made more consequential by the fact that the
   frontend renders these messages into toasts.
3. **Bugs are indistinguishable from validation.** The user is told
   `"'NoneType' object has no attribute 'strip'"` and has no idea whether they
   did something wrong.

**Expected behaviour.** Distinguish domain errors from defects:

```python
class DomainError(Exception):
    """Expected, user-correctable. Safe to show verbatim."""

try:
    result = spec.func(*args)
except DomainError as exc:
    result = build_response(False, None, str(exc))
except Exception:
    current_app.logger.exception(
        "RPC method %s failed", method,
        extra={"method": method, "request_id": g.get("request_id")},
    )
    result = build_response(
        False, None,
        "Something went wrong on our end. Reference: %s" % g.get("request_id"),
    )
    # optionally: return status 500 so monitoring and the SW can distinguish
```

**Migration path (this is the work, and it is real):** the service layer raises
plain `ValueError`/`RuntimeError` for domain conditions today. Introduce
`DomainError`, then convert service-by-service — `raise ValueError(...)` →
`raise DomainError(...)`. Until a service is converted, treat `ValueError` as
domain-level for that module. The existing `tests/erp/test_*.py` suite asserts
on error messages and will catch regressions.

**Security impact** Stops internal error disclosure. **Business impact** Makes
production failures visible for the first time. **UX impact** Users get
actionable messages instead of Python exception text.
**Effort** S for the handler + logging (1 d) · M for the full service migration
(1–2 wk). **The logging half should ship immediately** — it is three lines and
independently valuable.

---

## PY-002 · No input validation on any of 135 RPC methods
**Location** `app/erp/rpc.py:46-50` · **Severity** Critical · **Priority** P0

```python
payload = request.get_json(silent=True) or {}
args = payload.get("args") or []
result = spec.func(*args)
```

**Description.** The client-supplied `args` array is splatted directly into the
service function. There is **no schema, no type check, no arity check, no bounds
check** anywhere between the network and the domain logic.

Consequences:
- **Arity mismatch → `TypeError`**, swallowed by PY-001, surfaced to the user as
  a Python signature error.
- **Type confusion.** `save_po` expects `form_data` to be a dict; a client
  sending `["not a dict"]` reaches `form_data.get(...)` and raises.
- **No size limits.** `saveLogo` accepts an array of chunks
  (`core.js:1455-1457`) with no cap on count or total length — an authenticated
  client can post an arbitrarily large payload straight into a settings row.
- **Nested payloads are unvalidated.** `save_po`'s `items` array,
  `saveProductionSheet`'s matrix — arbitrary depth and size, all reaching SQL
  parameter binding untyped.

Mitigating context: **all callers are authenticated** (`@login_required` on
`rpc.py:27`), so this is not anonymous attack surface. But authenticated does not
mean trusted — a compromised session, a browser extension, or simply a
front-end bug all reach this path.

**Expected behaviour.** Declare a schema per method and validate before dispatch.
Since the project already depends on Flask/Werkzeug and the services are plain
functions, **pydantic** is the lowest-friction option:

```python
@dataclass(frozen=True)
class RpcSpec:
    name: str
    func: Callable[..., Any]
    mutation: bool = False
    offline: bool = False
    bom_gated: bool = False
    schema: type[BaseModel] | None = None      # ← add

# in rpc.py, before dispatch:
if spec.schema is not None:
    try:
        validated = spec.schema.model_validate({"args": args})
    except ValidationError as e:
        return jsonify(build_response(False, None, _friendly(e))), 400
    args = validated.args
```

`schema=None` preserves today's behaviour, so methods migrate incrementally.
Start with the 82 mutations, highest-risk first: `saveLogo` (size cap),
`saveProductionSheet`, `savePO`, `saveBill`, `importStockData`,
`importItemsFromStock`.

Add a global body-size limit via `MAX_CONTENT_LENGTH` in config as an immediate
one-line mitigation.

**Security impact** Closes the largest remaining input-trust gap.
**UX impact** Field-level validation messages instead of exception text — pairs
directly with `ACCESSIBILITY_REPORT.md` A11Y-012.
**Effort** `MAX_CONTENT_LENGTH`: minutes. Framework: S (2–3 d). Full migration:
L (3–4 wk), incremental.

---

## PY-003 · Rate limiter fully exempt on the only data endpoint
**Location** `app/__init__.py:530` — `limiter.exempt(erp_rpc_bp)` · **Severity** High · **Priority** P1

The global default is `"200 per day, 50 per hour"` (`:302`) — unusable for a SPA,
which is presumably why the blueprint was exempted. Net effect: **the endpoint
carrying 100% of application traffic has no rate limiting**, while `/auth/login`
does.

Additional issue: the limiter is keyed on `get_remote_address` (`:57`). Factory
users behind one NAT egress IP would be throttled *collectively* — so even after
tuning, the key function must change to user id for authenticated routes.

**Expected behaviour.** Remove the blanket exemption. Key on
`current_user.get_id()` falling back to IP. Set separate read/mutation ceilings
sized from a week of observed traffic (PERF-009 instrumentation provides this).
Exempt named high-frequency methods explicitly rather than the whole blueprint.

**Security impact** Restores protection against credential-stuffing follow-on,
scripted scraping, and runaway client loops. **Effort** S (1 d) + observation
window. **Depends on** `PERFORMANCE_AUDIT.md` PERF-009.

---

## PY-004 · `create_app()` is a 400-line function doing 15 jobs
**Location** `app/__init__.py:270-669` · **Severity** High · **Priority** P1

One function performs: ProxyFix parsing · config load · 4 extension inits ·
Redis probe · **mutation of flask-limiter private state** · database init ·
cookie hardening · CORS · Talisman/CSP · logging (twice — `logging_config` then
`_init_logging`) · request-id middleware · error handlers · user loader ·
blueprint registration · 4 URL aliases · 2 background schedulers · CSRF
exemptions · a before-request hook · an after-request hook · teardown.

Beyond length, the ordering carries **undocumented dependencies**: CSRF
exemptions must follow blueprint registration (`:563`); the Redis probe must
precede `limiter.init_app` (`:340`); the user loader imports from
`auth.routes` (`:498`) which imports back into `app`. None of this is asserted,
so a reordering breaks things silently.

**Expected behaviour.** Decompose into ordered, independently testable steps:

```python
def create_app(config_name=None):
    app = Flask(__name__, static_folder="../static", template_folder="../templates")
    _configure(app, config_name)
    _init_security(app)        # csrf, talisman, cors, cookies
    _init_extensions(app)      # login_manager, mail, limiter, database
    _init_observability(app)   # logging, request-id, error handlers
    _register_blueprints(app)  # blueprints + aliases + csrf exemptions
    _start_schedulers(app)     # see PY-008
    return app
```
Each step gets a docstring stating its ordering constraint and a unit test.
Pure refactor, no behaviour change, covered by the existing `tests/test_app.py`.

**Maintainability impact** High — this is the file every new contributor must
understand first. **Effort** M (3–5 d) · **Risk** Low with tests in place.

---

## PY-005 · Private flask-limiter internals mutated at boot
**Location** `app/__init__.py:349-372` · **Severity** Medium · **Priority** P2

```python
limiter._default_limits = tuple((str(item),) for item in parsed)
```
plus `ast.literal_eval` on a config value that "may arrive as lists, tuples,
comma-separated strings, or even stringified Python lists", all inside
`try/except Exception`.

This is defensive code written around an upstream API the author did not fully
control. It works, but: `_default_limits` is private and can change in any
flask-limiter release; `ast.literal_eval` on config input is unnecessary; and
the `except Exception` means a genuine misconfiguration is logged at `debug` and
silently ignored.

**Expected behaviour.** Normalise the value in `config.py` where its type is
known, and pass a well-formed `default_limits` list to the public
`Limiter(...)` constructor. Delete the block. If a config value is malformed,
fail at boot rather than degrade silently.
**Effort** S (half a day) · **Risk** Low, covered by a boot test.

---

## PY-006 · Teardown probes the `database` module by attribute-name guessing
**Location** `app/__init__.py:613-663` · **Severity** Medium · **Priority** P2

```python
db_cleanup_candidates = ("close_connection", "close_pool", "close",
                         "shutdown", "dispose", "teardown")
for name in db_cleanup_candidates:
    fn = getattr(database, name, None)
    if callable(fn): ...
```

`database.py` is code in this repository. Its cleanup function is
`close_db_pool()` (`database.py:199`) — **which is not in the candidate list**,
so this loop falls through to the `else` branch and probes `database.pool`.
Whether cleanup actually happens is unclear, and any failure is logged at
`debug`.

Worse: it runs on **`teardown_appcontext`**, i.e. after *every request*. If it
ever did find and call `close_db_pool()`, it would destroy the connection pool
on the first request. The current non-match may be the only reason the app works.

**Expected behaviour.** Call the real function explicitly, and only at process
shutdown (`atexit`), not per request:

```python
import atexit
atexit.register(database.close_db_pool)
```
Per-request teardown should return the connection to the pool — which
`get_conn`'s context manager already does correctly (`database.py:196`).

**Reliability impact** Removes ~50 lines of speculative code and a latent
pool-destruction hazard. **Effort** S · **Verify** with a load test confirming
pool reuse across requests. **Recommend investigating this early** — it is
cheap to check and the failure mode is severe.

---

## PY-007 · 19 loose scripts at repo root; dead compatibility shims
**Severity** Medium · **Priority** P2

Committed at `Project-root/`: `check_all_cols.py`, `check_columns.py`,
`check_oauth_config.py`, `check_pl_cols.py`, `check_pl_subproc.py`,
`check_schema_mismatches.py`, `check_table.py`, `check_table_structure.py`,
`check_users.py`, `create_table_nofk.py`, `create_table_simple.py`,
`deduplicate_items.py`, `inspect_process_schema.py`, `inspect_test_db.py`,
`list_tables.py`, `migration_final.py`, `migration_new_endpoints.py`,
`migration_safe.py`, `test_endpoints.py`, `test_variants.py`.

Several reference the pre-port UPF schema (`check_pl_subproc.py`,
`test_variants.py`). `audit_report.json` is also committed.

Separately, `auth/routes.py` (15 lines) is a compat shim re-exporting
`app.auth.routes` via `from … import *`. `docs/TECHNICAL_DEBT.md` describes an
`app/api/` + `app/main/` blueprint structure that **does not exist** in the
current tree — it documents a previous architecture and will actively mislead.

**Expected behaviour.** Move genuinely useful tools to `scripts/` with
docstrings; delete the rest. Verify the `auth.routes` shim has no remaining
importers (`grep -rn "from auth.routes\|import auth.routes"`) and remove it.
Rewrite or delete `docs/TECHNICAL_DEBT.md` — `TECHNICAL_DEBT_REPORT.md` in this
audit supersedes it.
**Effort** S (1 d) · **Cross-reference** `TECHNICAL_DEBT_REPORT.md` TD-002/TD-003

---

## PY-008 · Two background schedulers started inside the app factory
**Location** `app/__init__.py:552-555` · **Severity** Medium · **Priority** P2

```python
ledger_audit_service.start_ledger_audit_scheduler(app)
backup_service.start_backup_scheduler(app)
```

The comment states these no-op under `TESTING` and in the reloader parent, which
is the right instinct. But under a multi-worker WSGI server (gunicorn with 4
workers, per `Dockerfile`/`Procfile`), `create_app()` runs **once per worker** —
so the hourly ledger audit and the nightly backup each run **N times
concurrently**, on independent timers.

For a **backup** and a **ledger reconciliation**, concurrent duplicate execution
is not benign: duplicate Sheets writes, and reconciliation logic racing itself.

**Expected behaviour.** Move both out of the request-serving process. In order of
preference: (a) a separate scheduler process/container with the same image
(`docker-compose.yml` already exists as a home); (b) an external cron invoking a
CLI entry point; (c) if they must stay in-process, guard with a Postgres advisory
lock (`pg_try_advisory_lock`) so exactly one worker wins.

**Verify first** whether the existing guards already cover the multi-worker case
— read `start_ledger_audit_scheduler()` before acting. **Business impact**
Backup integrity. **Effort** S with advisory locks, M for a separate process.

---

## PY-009 · No authorization layer — authentication only
**Severity** High · **Priority** P1

Every RPC method is protected by `@login_required` (`rpc.py:27`) and nothing
else. There is no role model, no per-method permission, no ownership check.
`app/models/user.py` and the `users` table would need inspection to confirm
whether a role column exists, but **no role is consulted anywhere in the RPC
path**.

Consequence: any authenticated user can invoke all 135 methods — including
`deleteItemsBulk`, `adjustStockManually`, `triggerBackup`,
`runScheduledItemCleanup`, `mergeSelectedItems` and every other bulk-destructive
or financial operation. A shop-floor operator with a mobile PWA login has the
same authority as an administrator.

The registry already has the right hook: `RpcSpec` carries a `bom_gated` flag
(`registry.py:21`) and the rpc docstring notes "403 … reserved for
auth/BOM-gate", so **a gating concept was anticipated but never generalised**.

**Expected behaviour.** Add `roles: frozenset[str] | None` to `RpcSpec`, enforce
in `rpc.py` before dispatch, return 403 on failure. Define a minimal role set
first — `operator` (production/dispatch/stock entry), `manager` (+ masters,
pricing, bulk delete), `admin` (+ backup, cleanup, settings) — then annotate the
82 mutations. Reads can stay open initially and be tightened later.

**Security impact** This is the most significant *design-level* security gap in
the application. **Business impact** Required for any multi-user deployment with
segregation of duties, and for audit compliance.
**Effort** M (1–2 wk) · **Dependencies** a decision on the role model — that is a
business question, not a technical one, and should be asked before building.

---

## PY-010 · Four entry points with divergent configuration
**Location** `run.py`, `run_production.py`, `wsgi.py`, `Dockerfile`/`Procfile`
**Severity** Medium · **Priority** P2

Four ways to start the app, each potentially resolving `config_name`
differently. The codebase itself flags the resulting confusion at
`app/__init__.py:405-411`:

> "this app has several ways to start it (flask run, run_production.py,
> wsgi.py, python app.py) that don't all reliably land on DevelopmentConfig's
> DEBUG=True"

That comment documents a real bug caused by exactly this. Note it also mentions
`python app.py` — **`app.py` no longer exists** in the tree, further evidence of
documentation/code drift (see PY-007).

**Expected behaviour.** One entry point: `wsgi.py` exposing `application`, used
by gunicorn in all environments; `flask run` for development via `FLASK_APP`.
Delete `run.py`/`run_production.py` or reduce them to thin wrappers. Document the
single supported command per environment in `DEPLOYMENT.md`.
**Effort** S (1–2 d) · **Business impact** Removes a class of
"works-locally-fails-in-prod" defects.

---

## PY-011 · Service modules exceed 1,000 lines with private cross-imports
**Severity** Medium · **Priority** P2

| Module | Lines | RPC methods |
|---|---:|---:|
| `process_service.py` | 2,273 | 15 |
| `items_service.py` | 1,260 | 12 |
| `production_service.py` | 1,019 | 8 |
| `warehouse_service.py` | 969 | 7 |
| `bom_service.py` | 808 | 9 |
| `dispatch_service.py` | 806 | 6 |

Modules reach into each other's privates — `po_service.py:301` calls
`bill_service._aggregate_billed_base_qty_by_po(cur)`; `process_service`
deferred-imports `warehouse_service` to break a cycle
(`process_service.py:338-340`, documented in-comment).

The leading `_` says "internal", and cross-module use of it means the intended
boundary is being violated. The deferred import is a **circular dependency**
worked around rather than resolved.

**Expected behaviour.** Split the largest modules by bounded context
(`process/master.py`, `process/components.py`, `process/colors.py`,
`process/renames.py`). Promote genuinely shared helpers to an explicit internal
API (`app/erp/services/_shared/`) with public names. Resolve the
`process ↔ warehouse` cycle by extracting the shared recompute into a third
module both can import.

**Effort** L (2–3 wk) · **Risk** Medium — mitigated by the existing per-service
test files. **Priority P2**: this is real debt but it is not currently causing
incidents, and PY-001/002/009 are.

---

## Security assessment (Phase 10)

**Confirmed strong:**

| Control | Evidence |
|---|---|
| CSRF | Global `CSRFProtect`; only 3 explicit view exemptions (`:563`), all pre-auth endpoints |
| CSP | Talisman with an allowlist that documents each entry's justification (`:416-447`) |
| HSTS / secure cookies / force-HTTPS | Gated on `BASE_URL` scheme with documented rationale for not using `app.debug` (`:405-413`) |
| Session cookies | `HttpOnly` always; `Secure` + `SameSite=Strict` when not debug (`:380-387`) |
| CORS | Origin-locked to `BASE_URL` in production (`:395`) |
| SQL injection | All values parameterised across 390 `execute()` calls |
| Secrets | `.env` and `gcp-key.json` verified untracked and gitignored |
| Password policy | 8+ chars, upper/lower/digit/special (`:83-100`) |
| Prod safety | Refuses to boot with `debug=True` (`:666`); Redis required in prod (`:322`) |

**Open items, in priority order:**

| # | Issue | Ref |
|---|---|---|
| 1 | **No authorization** — 135 methods, authentication only | PY-009 |
| 2 | **No input validation** on 135 methods | PY-002 |
| 3 | **Internal error text disclosed** to clients via `str(exc)` | PY-001 |
| 4 | **No rate limiting** on the data endpoint | PY-003 |
| 5 | **XSS surface**: 360 `innerHTML` sinks; `escapeHtml` exists (`api.js:127`) but is opt-in per interpolation | `HTML_CSS_JS_REVIEW.md` FE-004 |
| 6 | `'unsafe-inline'` in `script-src` — required by current inline scripts; removable once inline handlers are eliminated | `HTML_CSS_JS_REVIEW.md` FE-002 |
| 7 | No audit trail of *who* invoked which mutation (mutation cache stores results, not actors) | — |

Items 1–4 are all in `app/erp/rpc.py` or its immediate surroundings — **a single
~150-line file is the leverage point for four of the five most significant
security gaps.**

---

## Recommended order

| Order | Item | Effort | Rationale |
|---|---|---|---|
| 1 | **PY-001** logging half only — add `logger.exception()` + generic client message | 1 d | Three lines; makes production failures visible for the first time |
| 2 | `MAX_CONTENT_LENGTH` + **PY-006** teardown fix | 1 d | Two cheap, high-consequence corrections |
| 3 | **PY-002** validation framework (schemas optional per method) | 2–3 d | Unblocks incremental migration |
| 4 | **PY-009** role model decision + `RpcSpec.roles` enforcement | 1–2 wk | Largest design-level security gap |
| 5 | **PY-003** rate limiting, **PY-008** scheduler locking | 2–3 d | Needs PERF-009 traffic data |
| 6 | **PY-004** factory decomposition, **PY-005**, **PY-010** | 1 wk | Maintainability; low risk with tests |
| 7 | **PY-007** repo hygiene, doc correction | 1 d | Cheap; removes misleading documentation |
| 8 | **PY-001** full `DomainError` migration | 1–2 wk | Incremental, per service |
| 9 | **PY-011** module decomposition | 2–3 wk | Real debt, no active incidents |
