# Implementation Roadmap — Phase 11

Sequenced, costed plan consolidating all 13 preceding reports.

---

## Estimation basis

- **1 engineer-week = 1 person, 5 days.** Sizes: **S** ≤ 3 d · **M** 1–2 wk ·
  **L** 3–6 wk · **XL** > 6 wk.
- Estimates assume familiarity with this codebase. Add ~30% for a new joiner.
- **Risk** = probability × blast radius of a production defect.
- Where a report gave a range, the roadmap uses the upper bound.

**Total: ≈ 38 engineer-weeks.** With two engineers on the parallel tracks
described below, ≈ 22 calendar weeks.

---

## Prioritisation model

Each item scored on five axes. Priority is not severity alone — a Critical
finding that cannot be safely fixed yet ranks below the prerequisite that makes
it safe.

| Axis | Meaning |
|---|---|
| **UX gain** | Reduction in daily friction for an all-day user |
| **Perf gain** | Measured or projected latency / payload improvement |
| **Maint. gain** | Reduction in the cost of future change |
| **Business impact** | Revenue, compliance, risk, or product positioning |
| **Risk** | Chance of breaking production |

---

## Wave 0 — Foundation *(4 weeks · 2 engineers · ≈ 6 engineer-weeks)*

> **Nothing else should start before this wave completes.** Every item below
> either makes later work *safe* (tests, gates) or *measurable* (telemetry). It
> also contains the two highest value-per-hour changes in the entire audit.

| # | Item | Ref | Effort | Risk | UX | Perf | Maint. | Business |
|---|---|---|---|---|---|---|---|---|
| 0.1 | `defer` on 17 script tags | PERF-001 | 1 h | None | — | ●●○ | — | — |
| 0.2 | **SWR cache in `api.js`** | PERF-003, FLOW-003 | S | Low | ●●● | ●●● | ● | ●● |
| 0.3 | **RPC error logging** (`logger.exception`) | PY-001, TD-013 | 1 d | None | — | — | ●●● | ●●● |
| 0.4 | **Contrast + focus-ring token fixes** | A11Y-002, A11Y-009 | S | Low | ●● | — | — | ●●● |
| 0.5 | ESLint + Prettier + Stylelint + esbuild | FE-006, TD-001 | S | None | — | ●● | ●●● | — |
| 0.6 | axe-core + jest-axe in CI | A11Y-010 | S | None | — | — | ●●● | ●●● |
| 0.7 | Characterisation tests, 5 largest render paths | FE-009, R0.2 | M | None | — | — | ●●● | — |
| 0.8 | Telemetry: web-vitals + per-RPC timing/query-count | PERF-009, FLOW-009 | M | Low | — | ●● | ●●● | ●● |
| 0.9 | `MAX_CONTENT_LENGTH` + fix `teardown_appcontext` | PY-002, PY-006 | 1 d | Low | — | ● | ●● | ●● |
| 0.10 | Repo hygiene + delete stale `TECHNICAL_DEBT.md` | TD-002, TD-003 | S | None | — | — | ●● | ● |
| 0.11 | Debounce all search inputs (250 ms) | PERF-005 | 1 d | Low | ●●● | ●●● | — | — |
| 0.12 | Wrap all tables in `overflow-x: auto` | RES-001 | 1 d | Low | ●●● | — | — | ●● |

**Exit criteria.** CI gates lint + tests + axe. Snapshots exist for PO, Bill,
Stock, Items, Production. RPC failures appear in logs. Core Web Vitals reporting
live. Tab switching feels instant on repeat visits. No WCAG contrast failures.

**Why 0.2, 0.3, 0.11 and 0.12 are here despite being "fixes" rather than
"foundations":** together they cost about four days, require no architectural
change, and deliver the largest immediately perceptible improvement available.
Shipping them in week 1 buys credibility for the longer work.

---

## Wave 1 — Safety, security and scale *(8 weeks · 2 engineers · ≈ 12 engineer-weeks)*

Two tracks run in parallel from here.

### Track A — Backend

| # | Item | Ref | Effort | Risk | Notes |
|---|---|---|---|---|---|
| 1A.1 | `psycopg2.sql` identifier composition + lint rule | SQL-003 | S | Low | **Must precede 1A.5** |
| 1A.2 | RPC validation framework (`RpcSpec.schema`) | PY-002 | S | Low | `None` preserves behaviour |
| 1A.3 | Schemas for the 82 mutations | PY-002 | L | Med | Incremental; `saveLogo` first |
| 1A.4 | `DomainError` separation | PY-001 | M | Med | Per service; tests assert messages |
| 1A.5 | **Authorization: `RpcSpec.roles`** | PY-009 | M | Med | ⚠️ **Blocked on a role-model decision** |
| 1A.6 | `= ANY()` predicate pushdown | SQL-002 | M | Low | Hits every save/delete path |
| 1A.7 | Rate limiting on `erp_rpc_bp`, keyed on user | PY-003 | S | Low | Needs a week of 0.8 traffic data |
| 1A.8 | Scheduler advisory locks / separate process | PY-008 | S | Med | Verify existing guards first |
| 1A.9 | Archive legacy migrations; one entry point | SQL-007, PY-010 | S | Low | |

### Track B — Frontend

| # | Item | Ref | Effort | Risk | Notes |
|---|---|---|---|---|---|
| 1B.1 | Escape-by-default `` html`` `` tag | FE-004 | S | Low | |
| 1B.2 | Design tokens + aliasing (no visual change) | DS §5 | M | Low | Screenshot baseline first |
| 1B.3 | **Skeleton component** | UX-004 | S | Low | Pairs with 0.2 |
| 1B.4 | Button, Badge, EmptyState, Toast/Alert | CL Phase A | M | Low | |
| 1B.5 | Landmarks, skip link, `<nav>` sidebar | FE-007, A11Y-006 | S | Low | |
| 1B.6 | `scope` + `caption` on all 75 tables | A11Y-001 | S | Low | Interim fix before DataTable |
| 1B.7 | Icon-button `aria-label` sweep | A11Y-004 | S | Low | |
| 1B.8 | ES module conversion | FE-003 | L | Med | Keep `window.App` alive |

**Exit criteria.** No unvalidated mutation. Authorization enforced. WCAG AA
failures down from six categories to two. Bundle built and minified. Six
components shipped with a `/design` page.

**⚠️ Decision required before week 5:** the role model for 1A.5. This is a
business question (who may delete, adjust stock, trigger backups), it blocks
both the security fix and FLOW-007, and it should be raised in Wave 0.

---

## Wave 2 — Core UX transformation *(8 weeks · 2 engineers · ≈ 12 engineer-weeks)*

| # | Item | Ref | Effort | Risk | UX | Perf | Maint. | Business |
|---|---|---|---|---|---|---|---|---|
| 2.1 | **DataTable component** | CL #1 | L | Med | ●●● | ●●● | ●●● | ●●● |
| 2.2 | **ListViewController** | FE-001 | L | Med | ●●● | ●● | ●●● | ●● |
| 2.3 | Migrate 10 views onto DataTable + ListView | R3 | L | Med | ●●● | ●●● | ●●● | ●● |
| 2.4 | **Command palette + `globalSearch` RPC** | UX-002, FLOW-002 | M | Low | ●●● | — | ● | ●●● |
| 2.5 | **Undo on destructive actions** | UX-003 | M | Low | ●●● | — | — | ●●● |
| 2.6 | Keyboard shortcuts + `?` overlay | UX-005, FLOW-004 | M | Low | ●●● | — | — | ●● |
| 2.7 | URL state + saved views | UX-006, FLOW-005 | M | Low | ●●● | — | ● | ●● |
| 2.8 | Field component + inline validation | A11Y-012, UI-006 | M | Low | ●●● | — | ●● | ●●● |
| 2.9 | Pagination, SelectionBar, Dialog, Toolbar | CL #8–10, 18 | M | Low | ●● | — | ●● | ● |
| 2.10 | Density toggle | Delight #5 | S | Low | ●● | — | — | ● |

**Exit criteria.** All 11 list views on the shared stack. `App.State` reduced
from ~90 fields to under 20. Command palette live. Undo on every soft delete.
URL state working. Bulk operations beyond delete.

**This wave delivers the majority of the user-visible transformation.** Items
2.1 and 2.2 are the keystone — everything from 2.3 onward is cheaper because
they exist.

---

## Wave 3 — Scale and polish *(8 weeks · 2 engineers · ≈ 8 engineer-weeks)*

| # | Item | Ref | Effort | Risk |
|---|---|---|---|---|
| 3.1 | **Server-side pagination**, 6 read methods | SQL-001, PERF-002 | L | Med |
| 3.2 | Partial indexes matching the new query shapes | SQL-005 | S | Low |
| 3.3 | Lazy tab loading + partial fetch | PERF-001, PERF-004 | M | Med |
| 3.4 | Split `production.js`, `mobile.js`, `stock.js`, `items.js`, `process.js` | FE-005 | L | Med |
| 3.5 | Delete inline styles, per view | UI-002, TD-008 | L | Low |
| 3.6 | Event delegation → remove `'unsafe-inline'` from CSP | FE-002 | L | Low |
| 3.7 | Self-host + subset fonts, Bootstrap, icons | PERF-006 | M | Low |
| 3.8 | Compression + content-hashed caching | PERF-007 | S | Low |
| 3.9 | Set-based renames | SQL-004 | M | **High** |
| 3.10 | Playwright viewport matrix + screenshots | RES-007 | M | None |
| 3.11 | Heading hierarchy correction | A11Y-003 | S | Low |

**Note on 3.9.** The rename paths encode production bug fixes documented
in-comment (`process_service.py:258-280` describes shipped goods reappearing as
available). **Do not start without a per-path test asserting identical
before/after database state on a seeded fixture.** If that test cannot be
written confidently, defer the item — the current code is correct and merely slow.

**Exit criteria.** Initial JS payload under 300 KB gzipped. No unbounded query.
CSP without `'unsafe-inline'`. Inline styles under 100. Zero WCAG AA failures.

---

## Wave 4 — Differentiation *(6 weeks · ≈ 6 engineer-weeks, optional)*

| # | Item | Ref | Effort |
|---|---|---|---|
| 4.1 | Split view / master–detail on wide screens | RES-002, FLOW-001 | M |
| 4.2 | Inline row editing | FLOW-001 | M |
| 4.3 | Native Combobox → retire Select2 + jQuery | CL #11, PERF-006 | M |
| 4.4 | Role-based navigation surface | FLOW-007 | M |
| 4.5 | Onboarding, contextual help, activity timeline | FLOW-008 | M |
| 4.6 | Unify auth + mobile onto shared tokens | DS §5 stage 3 | M |
| 4.7 | Container queries for component responsiveness | RES-003 | M |
| 4.8 | Chart component | CL #17 | M |
| 4.9 | Service-module decomposition | PY-011, TD-015 | L |
| 4.10 | Warehouse-pool incremental recompute | SQL-009 | L (**high risk**) |

**4.10 should only be attempted if Wave 0 telemetry proves it is actually
costly.** It is the highest-risk item in the audit and there is currently no
evidence it is a bottleneck.

---

## Dependency graph

```
Wave 0 ─────────────────────────────────────────────────────────┐
  ├─ 0.5 lint/build ──> 1B.8 ES modules ──> 3.3 lazy ──> 3.4 split
  ├─ 0.7 characterisation tests ──> 2.2 ListView ──> 3.9 renames
  ├─ 0.8 telemetry ──> 1A.7 rate limits · 3.1 pagination priority · 4.10 decision
  └─ 0.6 axe ──> every accessibility item

1B.2 tokens ──> 1B.4 components ──> 2.1 DataTable ──> 2.2 ListView ──> 3.1 pagination
                                          │
                                          └──> 2.3 view migration ──> 3.5 inline styles
                                                                  └──> 3.6 delegation ──> CSP

1A.1 psycopg2.sql ──> 3.1 pagination (dynamic sort)
1A.2 validation ──> 1A.3 schemas
ROLE MODEL DECISION ──> 1A.5 authz ──> 4.4 role-based nav
```

**Critical path:** Wave 0 → 1B.2 → 1B.4 → 2.1 → 2.2 → 2.3 → 3.1.
**≈ 22 calendar weeks with two engineers.**

---

## Resourcing

| Track | Skills | Waves | Load |
|---|---|---|---|
| **A — Backend** | Python, Flask, PostgreSQL, security | 0–4 | ~16 engineer-weeks |
| **B — Frontend/Design** | Vanilla JS, CSS architecture, WCAG | 0–4 | ~22 engineer-weeks |

Single engineer: ≈ 38 weeks sequential. Two: ≈ 22 calendar weeks. Three does
**not** compress further — the critical path through DataTable → ListView →
view migration is inherently serial, and adding a third engineer to it increases
merge conflict cost on the same files.

**Non-engineering input required:**
- **Role model definition** (business) — blocks 1A.5 and 4.4. Ask in Wave 0.
- **Tablet strategy decision** (product) — see `RESPONSIVE_REVIEW.md` RES-004.
- **Brand direction for token unification** (design) — affects 1B.2 and 4.6.

---

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Refactor breaks a business-critical calculation | Med | **High** | Wave 0 characterisation tests are non-negotiable; one module per PR |
| Rename refactor (3.9) corrupts ledger data | Low | **Critical** | Per-path before/after DB assertions; defer if not writable |
| Pagination changes alter result sets subtly | Med | High | Unique tiebreaker in every `ORDER BY`; compare full result sets in tests |
| Token migration causes visual regression | Med | Med | Alias-first (no visual change), screenshot baselines, contrast fixes shipped separately |
| Scope creep into a framework rewrite | Med | High | Explicit non-goals in `CODE_REFACTORING_PLAN.md` |
| Authorization locks out existing users | Med | High | Ship in report-only mode first: log what *would* be denied for two weeks |
| Roadmap stalls after Wave 0 | Med | Med | Each wave delivers standalone value; Wave 0 alone is worth shipping |
| Estimates prove low | **High** | Med | Re-baseline after Wave 0, when the codebase is instrumented and understood |

---

## Success metrics

| Metric | Baseline | Wave 0 | Wave 2 | Wave 4 |
|---|---:|---:|---:|---:|
| Initial JS (gz) | ~1.10 MiB raw | ~280 KB | 280 KB | < 150 KB |
| Tab-switch (warm) | full fetch | instant | instant | instant |
| WCAG AA failure categories | 6 | 4 | 2 | 0 |
| Inline `style=` (excl. print) | 977 | 977 | 600 | < 100 |
| `!important` | 143 | 143 | 80 | < 20 |
| Inline `onclick` | 246 | 246 | 120 | 0 |
| `App.State` fields | ~90 | ~90 | < 20 | < 15 |
| Frontend tests | 5 | 40 | 100 | 150 |
| RPC methods validated | 0/135 | 0/135 | 82/135 | 135/135 |
| Reads with `LIMIT` | 1/390 | 1/390 | 1/390 | all list reads |
| CI gates | 0 | 4 | 5 | 6 |
| Cross-entity lookup | 4–5 tab hops | 4–5 | 1 keystroke | 1 keystroke |
| Undo available | no | no | yes | yes |

---

## If only four weeks are available

Ship **Wave 0 exactly as written.** It costs 6 engineer-weeks, carries almost no
risk, and delivers:

- Tab switching that feels instant (0.2)
- Production failures that are finally visible (0.3)
- WCAG contrast compliance (0.4)
- Tables usable on tablets and phones (0.12)
- Search that does not stutter (0.11)
- CI gates that stop the debt growing (0.5, 0.6)
- Telemetry that makes every later decision evidence-based (0.8)

That is the highest-return four weeks available in this codebase, and it leaves
the architecture untouched — so nothing is foreclosed if priorities change.
