# Phase 1 — Application Discovery Map

> Basis for every other report in `docs/audit/`. All figures measured from the
> working tree on branch `verification/claude-appscript-pwa-20260727`, not estimated.

---

## 1. What this application actually is

**Maharaja Bikes ERP** — a manufacturing tracking & costing ERP for a bicycle
manufacturer. It is a **1:1 port of a Google Apps Script + Google Sheets
application** onto Flask + PostgreSQL. This single fact explains the majority of
the architectural findings in this audit, and every recommendation below is
framed against it.

Evidence of the port's origin, from the code itself:

| Artifact | Location | What it reveals |
|---|---|---|
| `RPC_METHODS` allowlist | `app/erp/registry.py:24` | "Ports the ~117-method surface of Apps Script's `google.script.run` bridge" |
| `Api.call()` | `static/erp/api.js:2` | "the client-side seam ported from `Apps_Script/Script_ApiCore.html`'s `_apiCall`" |
| `SHEETS` dict | `app/erp/config_maps.py:26` | Postgres table names are *derived from spreadsheet tab names* via `to_snake_case()` |
| CSS header | `static/erp/styles.css:2` | Still titled `styles.html` — an Apps Script HTML-service file |
| Logo chunking | `static/erp/core.js:1450` | 8000-char chunking retained purely as "the wire shape saveLogo's args expect", not a Postgres limit |

The port is **faithful and well-commented** — the inline commentary throughout is
unusually high quality and documents *why* decisions were made. The debt is not
carelessness; it is the accumulated shape of a spreadsheet-era API surface that
has not yet been re-architected for the web platform it now runs on.

---

## 2. Runtime architecture

```
Browser
  │
  ├── GET  /erp            → templates/erp/index.html   (desktop SPA shell)
  ├── GET  /erp/mobile     → templates/erp/mobile.html  (offline-first PWA)
  │
  └── POST /api/erp/rpc/<method>          ← the ONLY data endpoint
          │  headers: X-CSRFToken, X-Mutation-Id (mutations only)
          │  body:    {"args": [...]}     positional args, Apps Script style
          ▼
     app/erp/rpc.py :: call()
          │  @login_required
          │  1. RPC_METHODS.get(method)  → 404 if unknown
          │  2. if spec.mutation: require + UUID-validate X-Mutation-Id
          │  3. replay check → get_cached_result() returns stored envelope
          │  4. spec.func(*args)         ← bare positional splat, no schema
          │  5. except Exception → build_response(False, None, str(exc))
          │  6. store_result() if mutation
          ▼
     app/erp/services/*.py  (22 modules, 135 @rpc_method registrations)
          ▼
     database.get_conn() / @database.transactional  → PostgreSQL schema `erp`
          ▼
     envelope.py :: build_response  → {success, data, message}  ALWAYS HTTP 200
```

### Request lifecycle middleware chain
1. `ProxyFix` — opt-in only, via `PROXY_FIX` env var (`app/__init__.py:246`)
2. `Talisman` — CSP, HSTS, frame-options; skipped under `TESTING` (`app/__init__.py:448`)
3. `CORS` — origin-locked to `BASE_URL` in prod (`app/__init__.py:395`)
4. `CSRFProtect` — global; 3 explicit view exemptions (`app/__init__.py:563`)
5. `Limiter` — Redis-backed, **`erp_rpc_bp` is fully exempt** (`app/__init__.py:530`)
6. `setup_request_id_middleware` (`app/middleware/request_id.py`)
7. `_underscore_api_deprecation_check` before-request hook (`app/__init__.py:581`)

---

## 3. Route inventory

Total distinct URL rules is small — the RPC design collapses ~135 operations
behind one route.

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/` , `/dashboard` | GET | — | Redirect → `erp.index` (4 alias endpoints registered, `app/__init__.py:538-545`) |
| `/erp` | GET | `@login_required` | Desktop shell |
| `/erp/mobile` | GET | `@login_required` | Mobile PWA shell |
| `/erp/sw.js` | GET | public | Desktop service worker (scope-raised via `Service-Worker-Allowed`) |
| `/erp/mobile/sw.js` | GET | public | Mobile service worker |
| `/erp/offline.html` | GET | public | Desktop offline fallback |
| `/erp/mobile/offline.html` | GET | public | Mobile offline fallback |
| `/api/erp/rpc/<method>` | POST | `@login_required` | **All 135 data operations** |
| `/auth/*` | GET/POST | mixed | Login, signup, Google OAuth, forgot/reset password (`app/auth/routes.py`, 508 lines) |

### The 135 RPC methods by service

| Service | Methods | Mutations | Domain |
|---|---:|---:|---|
| `process_service.py` (2273 ln) | 15 | 8 | Process master, components, colour links/axes |
| `contractors_service.py` (785 ln) | 13 | 6 | Contractors, rate cards, payments, ledgers |
| `items_service.py` (1260 ln) | 12 | 9 | Items master, identity drift, merge/dedupe |
| `tags_service.py` (452 ln) | 11 | 7 | Colour / Model / Process-Type masters |
| `clients_service.py` (690 ln) | 9 | 6 | Clients, client orders |
| `bom_service.py` (808 ln) | 9 | 5 | Bill of materials, drift reporting |
| `production_service.py` (1019 ln) | 8 | 6 | Production lots, WIP, production sheet |
| `warehouse_service.py` (969 ln) | 7 | 4 | Warehouse pool + openings + adjustments |
| `stock_service.py` (433 ln) | 7 | 4 | Stock, thresholds, dead stock, adjustments |
| `dispatch_service.py` (806 ln) | 6 | 3 | Dispatch headers/lines, ready-to-dispatch |
| `po_service.py` (630 ln) | 5 | 3 | Purchase orders, allocation suggestions |
| `vendors_service.py` (262 ln) | 5 | 4 | Vendors |
| `bill_service.py` (595 ln) | 4 | 3 | Bill ledger (goods + labour job) |
| `return_service.py` (316 ln) | 4 | 3 | Return ledger |
| `units_service.py`, `issue_service.py`, `wastage_service.py`, `company_settings_service.py` | 3 ea | mixed | Units, issued stock, wastage, logo/settings |
| `system_service.py`, `dashboard_service.py`, `backup_service.py` | 2 ea | mixed | Health, dashboard aggregate, Sheets backup |
| `ledger_audit_service.py` | 1 | 0 | Hourly unattended reconciliation |

**82 of 135 methods are mutations** (`mutation=True`), each requiring a
client-supplied UUID for idempotency.

---

## 4. Frontend inventory

### Desktop shell — `templates/erp/index.html` (354 lines)

A single Jinja template that **inlines all 12 feature partials into one DOM**
(`index.html:300-311`) and eagerly loads **17 script tags** (`index.html:332-351`).

**11 navigation tabs**, generated from a Jinja loop (`index.html:276-294`):
Dashboard · Purchase Orders · Bill Ledger · Returns · Items Master · Vendors ·
Stock · Products & Processes · Contractors · Production · Dispatch · Clients

Plus 4 header-level master-data modals: Units · Colors · Models · Process Types.

### JavaScript payload (uncompressed, as shipped — no bundler, no minifier)

| File | Bytes | Lines |
|---|---:|---:|
| `production.js` | 272,750 | 5,441 |
| `stock.js` | 110,878 | 2,525 |
| `items.js` | 107,826 | 2,336 |
| `process.js` | 107,723 | 2,284 |
| `bill.js` | 74,129 | 1,584 |
| `core.js` | 74,067 | 1,803 |
| `bom.js` | 69,864 | 1,637 |
| `po.js` | 58,764 | 1,398 |
| `dispatch.js` | 54,084 | 977 |
| `return.js` | 50,888 | 1,130 |
| `client.js` | 50,605 | 1,094 |
| `vendors.js` | 31,451 | 701 |
| `issue.js` | 25,905 | 551 |
| `contractor.js` | 24,455 | 528 |
| `dashboard.js` | 20,295 | 460 |
| `print.js` | 10,847 | 255 |
| `api.js` | 9,053 | 216 |
| **TOTAL** | **1,153,584 (1.10 MiB)** | **24,920** |

Plus third-party from CDN: jQuery 3.6, Bootstrap 5.3 bundle, Select2 4.1,
Bootstrap Icons font, 2 Google Font families (Inter, Outfit).

Mobile shell loads a separate `mobile.js` (3,396 lines) + `mobile_styles.css` (857 lines).

### CSS inventory — **three parallel stylesheets, three different palettes**

| Stylesheet | Lines | Bytes | Consumed by | Primary colour | Spacing scale? | Type scale? |
|---|---:|---:|---|---|---|---|
| `static/erp/styles.css` | 2,912 | 86,525 | `/erp` desktop | `#0f172a` slate | ❌ | ❌ |
| `static/styles.css` | 2,646 | — | login/signup/forgot/reset | `#6366F1` indigo | ❌ | ❌ |
| `static/css/login.css` | 414 | — | same 4 auth pages | — | ❌ | ❌ |
| `static/erp/mobile_styles.css` | 857 | — | `/erp/mobile` | `#ff6a13` safety orange | ✅ `--mb-sp-1..8` | ✅ `--mb-font-*` |

### Client-side state — `App.State` (`static/erp/core.js:124-298`)

One flat mutable global object with **~90 fields**. Pagination, search, filter,
sort, and selection state is **hand-duplicated per module**:

```
poCurrentPage      billCurrentPage      returnCurrentPage    wastageCurrentPage
stockCurrentPage   dispatchCurrentPage  clientCurrentPage    orderCurrentPage
bomCurrentPage     productionCurrentPage  issueCurrentPage
```
…and the matching `*RowsPerPage`, `*SearchTerm`, `*SortBy`, `selected*`,
`filtered*`, `global*` for each — **11 near-identical copies of the same
list-view state machine.**

---

## 5. Data layer

- **PostgreSQL**, schema `erp`. 46 `CREATE TABLE` statements across
  `migrations/erp/001..023`. 107 index definitions.
- **390 `.execute()` calls** across the service layer.
- **1 `SELECT *`** — the service layer is otherwise disciplined about explicit
  column lists. Good.
- **1 `LIMIT`** in the entire service layer (`ledger_audit_service.py:309`).
  Everything else fetches whole tables. See `PERFORMANCE_AUDIT.md` / `SQL_OPTIMIZATION.md`.
- Table and column names are resolved at runtime through
  `config_maps.TABLE_NAMES` / `to_snake_case()`, producing **18 sites of
  f-string-interpolated SQL identifiers**. Values are internal constants, not
  user input — see `SQL_OPTIMIZATION.md` SQL-003 for the guardrail
  recommendation.

---

## 6. Security posture (baseline — see `PYTHON_BACKEND_REVIEW.md` §5)

Genuinely strong for an app of this vintage:

- ✅ CSRF enforced globally, only 3 targeted view exemptions
- ✅ Talisman CSP with a documented, justified allowlist (`app/__init__.py:416-447`)
- ✅ HSTS / secure-cookie / force-HTTPS gated on `BASE_URL` scheme, with an
  excellent inline rationale for *why not* `app.debug` (`app/__init__.py:405-413`)
- ✅ Redis rate limiter **fails fast in production** if unreachable (`app/__init__.py:331`)
- ✅ Parameterised SQL everywhere for *values*
- ✅ `.env` and `gcp-key.json` untracked and gitignored (verified)
- ✅ Test-DB guard preventing tests writing to production, with the incident
  documented in-comment (`app/__init__.py:124-130`)

Open items are covered in the security section of the backend review — chiefly
the rate-limiter exemption on the RPC blueprint and the 360 `innerHTML` sinks.

---

## 7. Testing & tooling baseline

- **34 pytest files** under `tests/` (`tests/erp/` covers each service).
- **5 frontend test files** under `static/erp/tests/` (nav, notify, outbox chaos,
  pool ledger, production sheet print) run via `npm test`.
- `ruff` configured (`pyproject.toml`), `.ruff_cache` present.
- **No** bundler, minifier, CSS pipeline, Lighthouse/CI perf budget, or
  automated accessibility check.
- **19 loose debug/one-off scripts committed at repo root** (`check_*.py`,
  `inspect_*.py`, `create_table_*.py`, `migration_*.py`, `test_endpoints.py`…).

---

## 8. Report index

| # | Report | Covers |
|---|---|---|
| 1 | `UI_UX_AUDIT.md` | Phases 2–3 — visual + interaction findings |
| 2 | `DESIGN_SYSTEM.md` | Phase 7 — token architecture and component contract |
| 3 | `ACCESSIBILITY_REPORT.md` | Phase 4 — WCAG 2.2 AA violations |
| 4 | `RESPONSIVE_REVIEW.md` | Phase 5 — breakpoint and device audit |
| 5 | `PERFORMANCE_AUDIT.md` | Phase 6 — frontend + Core Web Vitals |
| 6 | `SQL_OPTIMIZATION.md` | Phase 6 — query, index, transaction findings |
| 7 | `PYTHON_BACKEND_REVIEW.md` | Phase 6/8/10 — services, RPC layer, security |
| 8 | `HTML_CSS_JS_REVIEW.md` | Phase 8 — frontend code quality |
| 9 | `USER_FLOW_OPTIMIZATION.md` | Phase 3/9 — workflow click-cost analysis |
| 10 | `IMPLEMENTATION_ROADMAP.md` | Phase 11 — sequenced, costed plan |
| 11 | `TECHNICAL_DEBT_REPORT.md` | Phase 8 — debt register |
| 12 | `CODE_REFACTORING_PLAN.md` | Phase 8 — concrete refactor steps |
| 13 | `COMPONENT_LIBRARY_PLAN.md` | Phase 7 — component build order |
| 14 | `FINAL_EXECUTIVE_SUMMARY.md` | Phase 12 — decision-maker summary |
