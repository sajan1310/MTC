# Final Executive Summary — Phase 12

**Application** Maharaja Bikes ERP · **Branch** `verification/claude-appscript-pwa-20260727`
**Scope** Full-stack audit — UI, UX, accessibility, responsive, performance, SQL,
Python, frontend code quality, design system, security impact
**Date** 6 August 2026

---

## The one-paragraph version

This is a **competently engineered application carrying the shape of its
origin.** It is a faithful port of a Google Apps Script + Sheets system onto
Flask and PostgreSQL, and the port was done carefully — the security posture is
genuinely strong, the offline mobile PWA is sophisticated, and the inline code
commentary is better than most commercial codebases. The problems are not
carelessness; they are the consequence of a spreadsheet-era API surface, a
render model built for a smaller dataset, and the absence of automated quality
gates. **Three specific issues are urgent:** the application re-downloads entire
database tables on every tab switch and will get slower every month; it has
authentication but **no authorization**, so any logged-in user can invoke every
destructive operation; and it **silently swallows every backend error**, so
production failures are invisible. All three are fixable, and the first
meaningful improvements cost days, not months.

---

## Assessment

| Dimension | Grade | Basis |
|---|---|---|
| **Security posture** | **B+** | CSP, CSRF, HSTS, parameterised SQL, fail-fast config, secrets untracked — all verified. Held back by no authorization and no input validation. |
| **Backend architecture** | **B** | Clean layering, idempotent mutations, allowlisted RPC, real connection pooling. Held back by a 400-line factory and swallowed errors. |
| **Data layer** | **B−** | Disciplined parameterisation, 107 indexes, 22 expression indexes. Held back by **1 `LIMIT` in 390 queries**. |
| **Offline / PWA** | **A−** | Mutation outbox with replay, Background Sync, chaos tests. Genuinely strong work. |
| **Frontend architecture** | **D+** | 1.10 MiB unbundled JS, no module system, 90-field global state, 11 duplicated list machines. |
| **Design system** | **C−** | Three parallel systems, three palettes; no spacing or type scale on desktop. The *mobile* system is good. |
| **Accessibility** | **D** | Six WCAG 2.2 AA failure categories. 75 tables, zero `scope` attributes. |
| **Responsive** | **C** | Excellent at desktop and on the mobile PWA. Tablet portrait is unserved. |
| **Performance** | **D+** | Structurally unbounded: whole-table reads, full re-fetch per tab, no cache, no build step. |
| **Test coverage** | **C−** | Python reasonable (34 files). Frontend: **5 tests for 24,920 lines**. |
| **Tooling & process** | **F** | No JS lint, no bundler, no a11y check, no perf budget, no telemetry. |

**Overall: C+.** A solid foundation with a well-defined, tractable set of gaps.
This is not a rewrite candidate.

---

## What was measured

| | |
|---|---:|
| Backend Python (services) | ~13,000 lines · 22 modules |
| RPC methods | **135** (82 mutations) behind **one** endpoint |
| Frontend JavaScript | **24,920 lines** · 17 files · **1,153,584 bytes** |
| Largest single file | `production.js` — 5,441 lines · 272 KB |
| CSS | 6,829 lines across **3 unrelated design systems** |
| Templates | 5,276 lines · **42 modals** · **75 tables** |
| SQL `execute()` calls | 390 — of which **1** contains `LIMIT` |
| Database migrations | 23 current + ~35 legacy targeting a dead schema |
| Inline `style=` attributes | 1,391 (414 legitimately in print) |
| Inline `onclick` handlers | 246 in templates, more in generated HTML |
| `!important` declarations | 143 |
| `innerHTML` sinks / `escapeHtml` calls | 367 / 776 |
| Keyboard listeners | **4** |
| Loading indicators | **9** |
| Frontend tests | **5** |
| CI quality gates | **0** |

---

## The five findings that matter most

### 1 · The application is structurally guaranteed to get slower
`PERFORMANCE_AUDIT.md` PERF-002/003 · `SQL_OPTIMIZATION.md` SQL-001

Every `getXData` RPC returns its **entire table**; the client paginates 15 rows
in memory. Switching tabs re-fetches unconditionally — no cache, no ETag, no
request de-duplication. **390 queries, one `LIMIT`.**

This is acceptable today and will not be. Payload, latency and memory grow
linearly with business success, and nothing in the code caps it. It is the only
finding whose severity increases on its own.

**Fix:** a ~60-line stale-while-revalidate cache in `api.js` makes repeat tab
switches instant with **zero backend change** (2–3 days). Server-side pagination
behind it (3–4 weeks) removes the ceiling permanently.

### 2 · Authentication without authorization
`PYTHON_BACKEND_REVIEW.md` PY-009 · `TECHNICAL_DEBT_REPORT.md` TD-014

All 135 RPC methods are protected by `@login_required` and **nothing else.** Any
authenticated user — including a shop-floor operator on the mobile PWA — can
invoke `deleteItemsBulk`, `adjustStockManually`, `triggerBackup` and
`runScheduledItemCleanup`.

The registry already carries a `bom_gated` flag and reserves HTTP 403 for
gating, so the concept was anticipated and never generalised.

**Fix:** `roles` on `RpcSpec`, enforced before dispatch (1–2 weeks). **Blocked
on a business decision about who may do what** — that question should be asked
this week, because two workstreams depend on it. Ship in report-only mode first.

### 3 · Backend errors are invisible
`PYTHON_BACKEND_REVIEW.md` PY-001 · `TECHNICAL_DEBT_REPORT.md` TD-013

`rpc.py:51` catches every exception, returns HTTP 200 with `str(exc)`, and
**never logs.** An `AttributeError` in production code produces no 500, no log
line, no alert — the application can be substantially broken while reporting
success on every request. Raw exception text (including database errors) is
shown to users.

**Every prioritisation in this audit was made from static analysis because there
is no telemetry to consult.** That is the real cost.

**Fix:** three lines of `logger.exception()` — **one day, ship immediately.**
Separating `DomainError` from defects follows (2 weeks).

### 4 · Six WCAG 2.2 AA failure categories
`ACCESSIBILITY_REPORT.md`

**75 data tables, zero `scope` attributes** — the primary data surface is
unusable by screen reader. Measured contrast failures include `--text-muted` at
**2.56:1** (below even the large-text threshold) and `--warning-color` with
white text at **1.63:1**. Heading hierarchy is inverted (108 `<h5>`/`<h6>`, zero
`<h3>`). Generated markup contains almost no ARIA.

Beyond the ethical case, the European Accessibility Act has been in force since
June 2025, and this level of non-compliance blocks enterprise and public-sector
procurement.

**Fix:** the token and focus-ring corrections take **under two days** and fix
every screen at once. Adding `scope` and icon labels takes about a week. Those
two changes alone take the product from six failure categories to two.

### 5 · No quality gates — the debt that creates debt
`TECHNICAL_DEBT_REPORT.md` TD-001 · `HTML_CSS_JS_REVIEW.md` FE-006

No ESLint, no bundler, no minifier, no Stylelint, no accessibility check, no
performance budget, no visual regression, no telemetry. Python has `ruff`; the
larger frontend codebase has nothing.

143 `!important` declarations and 1,391 inline styles did not arrive in one
commit. They arrived one at a time, each individually reasonable, with nothing to
say "not this one too."

**Fix:** 2–3 days for lint, formatting and a build step; 1–2 days for axe-core in
the existing test suite. **Baseline the existing violations** so gates block new
debt without blocking work.

---

## What is genuinely good — protect it

An audit that lists only faults is not accurate. These are above the standard
typically found at this stage:

1. **Security fundamentals.** CSP with a documented allowlist, global CSRF with
   three justified exemptions, HSTS gated on the correct signal, parameterised
   SQL across all 390 queries, secrets verified untracked, fail-fast production
   config.
2. **The mutation idempotency design.** `X-Mutation-Id` with replay caching is a
   correct solution to double-submit and offline replay, better than most
   production systems.
3. **The offline PWA.** A mutation outbox with replay/reconciliation, Background
   Sync, and chaos tests is sophisticated engineering.
4. **The inline commentary.** `app/__init__.py:405-413`, `pages.py:29-54`,
   `styles.css:2460` explain *why*, including the production incident that
   motivated the design. This is rare and should survive every refactor.
5. **The mobile design system.** `mobile_styles.css` has the spacing scale, type
   scale and elevation tokens the desktop system lacks. **Promote it; do not
   replace it.**
6. **Data-layer discipline.** One `SELECT *` in 390 queries. 22 expression
   indexes matching the `lower()` predicates actually used. Real connection
   pooling with broken-connection handling.
7. **Details that are easy to miss and were not:** `prefers-reduced-motion`,
   pre-paint theme flash prevention, visibility-aware dashboard polling, the
   iOS input-zoom fix, `100dvh` for landscape phones, arrow-key record paging.

---

## Investment and return

| | Cost | Delivers |
|---|---|---|
| **Wave 0 — Foundation** | 4 wk · 2 eng | Instant tab switching · visible errors · WCAG contrast · usable tablet tables · CI gates · telemetry |
| **Wave 1 — Safety & scale** | 8 wk · 2 eng | Authorization · input validation · design tokens · first components · ES modules |
| **Wave 2 — UX transformation** | 8 wk · 2 eng | DataTable + ListView · command palette · undo · keyboard · URL state |
| **Wave 3 — Scale & polish** | 8 wk · 2 eng | Server pagination · < 300 KB bundle · CSP hardening · zero AA failures |
| **Wave 4 — Differentiation** | 6 wk · 2 eng | Split view · inline editing · role-based UI · Select2 retired |

**Total ≈ 38 engineer-weeks ≈ 22 calendar weeks with two engineers.**

Each wave delivers standalone value. There is no point at which the work must be
completed to be worth having.

---

## Recommendation

**Ship Wave 0 first, exactly as specified.** Six engineer-weeks, almost no risk,
no architectural change — and it delivers the largest immediately perceptible
improvement available:

- Tab switching becomes instant *(SWR cache — 2–3 days)*
- Production failures become visible for the first time *(logging — 1 day)*
- WCAG contrast compliance *(token values — under 2 days)*
- Tables usable on tablets and phones *(one CSS wrapper — 1 day)*
- Search stops stuttering *(debounce — 1 day)*
- CI gates stop the debt growing *(lint + axe — 4 days)*
- Telemetry makes every later decision evidence-based *(1 week)*

Nothing in Wave 0 forecloses any later choice.

**Ask one question this week:** *who should be allowed to delete records, adjust
stock, and trigger backups?* The answer blocks the authorization fix (finding 2)
and role-based navigation, and it is not a question engineering can answer alone.

**Re-baseline the roadmap after Wave 0.** Once telemetry exists, priorities
should be set by measured cost rather than by the structural reasoning this
audit was necessarily limited to.

---

## Method and limitations — stated plainly

**What this audit is:** a static analysis of the complete working tree. Every
number is measured from the artifacts — byte counts, occurrence counts, computed
WCAG contrast ratios, call-graph traces. Nothing is estimated where it could be
counted.

**What it is not:**
- No browser profiling, Lighthouse run, or RUM data — Core Web Vitals figures
  are **projections**, labelled as such.
- No `EXPLAIN ANALYZE`, no production row counts — SQL findings are
  **structural**, not cost-ranked.
- No screen-reader testing with NVDA/JAWS/VoiceOver, and axe-core was not run
  against the live DOM — the accessibility findings are those provable from
  source, and **a live audit will find more**.
- No device-lab testing — responsive findings derive from stylesheet analysis.
- No user interviews, session recordings, or task timings — click counts are
  accurate as *structural* counts of what the UI requires, not as observed
  behaviour.

**The single most valuable thing this audit cannot provide is measurement.**
That is why telemetry appears in Wave 0 rather than later: it converts the rest
of this work from reasoned to evidence-based.

---

## Report index

| Report | Covers |
|---|---|
| `00_APPLICATION_MAP.md` | Phase 1 — architecture, routes, inventory |
| `UI_UX_AUDIT.md` | Phases 2–3 — 14 visual and interaction findings |
| `DESIGN_SYSTEM.md` | Phase 7 — token specification and migration |
| `ACCESSIBILITY_REPORT.md` | Phase 4 — 12 WCAG 2.2 AA findings |
| `RESPONSIVE_REVIEW.md` | Phase 5 — 7 findings, device-class matrix |
| `PERFORMANCE_AUDIT.md` | Phase 6 — 10 frontend/delivery findings |
| `SQL_OPTIMIZATION.md` | Phase 6 — 9 data-layer findings |
| `PYTHON_BACKEND_REVIEW.md` | Phases 6/8/10 — 11 findings + security assessment |
| `HTML_CSS_JS_REVIEW.md` | Phase 8 — 10 frontend code-quality findings |
| `USER_FLOW_OPTIMIZATION.md` | Phases 3/9 — 9 workflow findings, 14 delight features |
| `COMPONENT_LIBRARY_PLAN.md` | Phase 7 — 18 components, phased |
| `TECHNICAL_DEBT_REPORT.md` | Phase 8 — 17-item debt register with metrics |
| `CODE_REFACTORING_PLAN.md` | Phase 8 — 10 sequenced refactors, explicit non-goals |
| `IMPLEMENTATION_ROADMAP.md` | Phase 11 — 5 waves, costed, with risk register |
