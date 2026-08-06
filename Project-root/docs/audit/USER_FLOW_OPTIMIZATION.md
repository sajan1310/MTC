# User Flow Optimization — Phases 3 & 9

Workflow-level analysis for users who spend their entire working day in this
application. Component-level findings are in `UI_UX_AUDIT.md`.

> **Caveat.** Click counts are derived from the markup and handler wiring, not
> from observed sessions. They are accurate as *structural* counts (how many
> interactions the UI requires) but no session recording, task-timing or user
> interview data was available. FLOW-009 addresses that gap, and it should be
> closed before the larger workflow investments are committed.

---

## The user this product serves

Evidence from the domain model: a bicycle manufacturer running vendors →
purchase orders → goods receipt/bills → items and stock → BOM and processes →
contractors → production lots → warehouse pool → dispatch → clients, with
returns and wastage throughout.

That implies at least three distinct roles using one undifferentiated UI:

| Role | Primary surface | Session shape |
|---|---|---|
| **Purchase / accounts** | POs, Bills, Vendors, Returns | Long desk sessions, high data entry, repeated lookups |
| **Production / stores** | Production, Stock, Warehouse Pool, Issue | Mixed desk + floor, frequent status updates |
| **Dispatch / sales** | Dispatch, Clients, Ready to Dispatch | Bursty, deadline-driven |

The product currently gives all three the same 11-tab sidebar, the same 42
modals, and no personalisation. **Nothing in the UI knows what a given user
does.** That is the root cause behind several findings below.

---

## Structural friction inventory

| Measure | Value | Consequence |
|---|---:|---|
| Modals in the app | **42** | Modal is the default interaction, not the exception |
| Navigation tabs | 11 | Flat; no grouping by function |
| Inline `onclick` handlers | 246 (+ hundreds generated) | Behaviour scattered; no shortcut layer |
| Keyboard listeners | 4 | Effectively no keyboard workflow |
| Search boxes | 11 siloed | No cross-entity lookup |
| Bulk actions available | 13 deletes, **0 edits** | Selection effort is wasted |
| Loading indicators | 9 | No feedback during the frequent full-table fetches |
| Debounced inputs | 7 | Most searches re-render per keystroke |
| Undo affordances | **0** | Every mistake is a support call |
| Saved views / favourites | **0** | Filters rebuilt every session |
| URL-addressable state | **0** | No bookmarking, no sharing, Back does nothing |

---

## Findings

| ID | Flow | Severity | Priority |
|---|---|---|---|
| FLOW-001 | Modal-first interaction model — 42 modals | High | P1 |
| FLOW-002 | Cross-module lookups require manual tab-hopping | Critical | P0 |
| FLOW-003 | Every tab switch is a full-table fetch with no feedback | Critical | P0 |
| FLOW-004 | No keyboard path through any workflow | High | P1 |
| FLOW-005 | Filter state is disposable | High | P1 |
| FLOW-006 | Selection leads only to deletion | Medium | P2 |
| FLOW-007 | No role-based surface — everyone sees everything | Medium | P2 |
| FLOW-008 | No onboarding, no contextual help, no shortcut discovery | Medium | P2 |
| FLOW-009 | No usage telemetry — flows cannot be prioritised by evidence | High (process) | P1 |

---

## FLOW-001 · Modal-first interaction model
**Severity** High · **Priority** P1

**42 modals** across the application, including nested cases: the PO Ledger's
`editPoModal` contains a link opening `vendorCatalogModal`
(`po_ledger.html:203`); Stock has `adjustStockModal`, `deadStockModal`,
`importStockModal`, `poolLedgerModal`, `warehouseOpeningModal`,
`warehousePoolProcessModal`.

**Why this costs time.** A modal is a context switch with a cost: it hides the
data the user was reading, cannot be compared side-by-side with anything, cannot
be left open while doing something else, loses all work if dismissed (no
autosave — `UI_UX_AUDIT.md` UX-003), and cannot be deep-linked.

**Worked example — "record a bill against PO 1042":**

| # | Action |
|---|---|
| 1 | Click Bill Ledger tab *(full table fetch, no skeleton)* |
| 2 | Click search box |
| 3 | Type "1042" *(re-renders per keystroke — only 7 debounce sites exist)* |
| 4 | Locate the row |
| 5 | Click the receive/bill action |
| 6 | `receiveBillModal` opens — PO context now **hidden behind the modal** |
| 7–n | Enter quantities; to verify against the original PO the user must cancel, switch to PO Ledger, search again, read, return, and re-enter |
| n+1 | Save |
| n+2 | Full table re-fetch |

Steps 7–n are the expensive part, and they exist purely because the modal
occludes the reference data.

**Expected behaviour, in order of value:**
1. **Split view on wide screens** — list left, record right
   (`RESPONSIVE_REVIEW.md` RES-002). Removes the modal from the most common
   inspect action and uses the ultra-wide space the app currently wastes.
2. **Inline row editing** for single-field changes (threshold, status, notes).
   `updateThreshold`, `updateDeadStock`, `updateProductionStatus` are already
   discrete RPCs — the backend is ready; only the UI forces a modal.
3. **Deep-linkable records** — `?tab=poLedger&po=1042` opens the record
   directly, making a PO shareable in a chat message.
4. **Autosave drafts** in the modals that remain, so dismissal is not destructive.

**UX impact** Removes the dominant context-switch cost from every workflow.
**Effort** L (split view M; inline edit M; deep links S) · **Depends on**
DataTable, ListView

---

## FLOW-002 · Cross-module lookups require manual tab-hopping
**Severity** Critical · **Priority** P0

Every module has its own search over its own in-memory array. There is no
cross-entity search. Real questions users have, and what they cost today:

| Question | Tabs visited | Searches typed |
|---|---:|---:|
| "Everything about vendor Acme" | Vendors, POs, Bills, Returns | 4 |
| "Where is item MB-FRAME-26 used?" | Items, Stock, BOM, Production, PO | 5 |
| "Status of order ORD-2291" | Clients, Production, Dispatch | 3 |
| "Why is this stock number wrong?" | Stock, Issue, Production, Return, Wastage | 5 |

Each of those tab visits is also a **full-table fetch** (FLOW-003), so the cost
is not just clicks — it is a wait per hop.

**Expected behaviour.**
1. **Command palette** (`Ctrl/⌘ K`) with cross-entity search backed by a
   `globalSearch` RPC (`UNION ALL` over indexed name columns with `LIMIT`).
2. **Entity detail views with backlinks** — a vendor page listing its POs,
   bills and returns inline. `vendorProfileModal` and `contractorProfileModal`
   already exist and prove the concept; generalise and un-modal them.
3. **Cross-links in tables** — a vendor name in a PO row navigates to that
   vendor.

**UX impact** Collapses the most common multi-tab investigation from 4–5 hops to
one keystroke. **Business impact** This is the interaction that defines modern
enterprise tools; its absence is the clearest gap versus Linear/Stripe/GitHub.
**Effort** M (palette 1–2 wk; `globalSearch` RPC ~3 d; backlinks L)

---

## FLOW-003 · Every tab switch is a full-table fetch with no feedback
**Severity** Critical · **Priority** P0

`core.js:1387-1414` re-fetches unconditionally on every tab activation; no
`getXData` paginates (1 `LIMIT` in 390 queries); only 9 loading indicators exist
in the whole frontend.

**The user-visible result:** click a tab → the interface freezes with stale or
empty content → data appears. No spinner, no skeleton, no progress. And because
FLOW-002 forces tab-hopping, this cost is paid many times per investigation.

**Expected behaviour** (detailed in `PERFORMANCE_AUDIT.md` PERF-003):
SWR cache serving cached rows instantly while revalidating; skeletons after
150 ms; `aria-busy` for assistive tech; server-side pagination behind it.

**The SWR cache alone is ~60 lines in one file and requires no backend change.**
It is the highest value-per-hour item in this entire audit.
**Effort** S (2–3 d) · **Priority: do this first.**

---

## FLOW-004 · No keyboard path through any workflow
**Severity** High · **Priority** P1

Four `keydown` listeners exist. One is genuinely good — arrow-key record paging
inside modals (`core.js:95-106`) — which demonstrates the team understands the
value; it is simply not generalised.

A purchase clerk entering 40 POs a day currently uses the mouse for: opening the
tab, clicking New, clicking each field, clicking Add Row, clicking Save,
dismissing the toast. **There is no path that keeps hands on the keyboard.**

**Expected behaviour** — minimum set, with `?` to discover them:

| Key | Action |
|---|---|
| `⌘/Ctrl K` | Command palette |
| `/` | Focus current search |
| `g` `p`/`b`/`s`/`i`/`d` | Go to POs / Bills / Stock / Items / Dispatch |
| `n` | New record in current view |
| `j` / `k` | Move row focus |
| `x` | Toggle row selection |
| `Enter` | Open focused row |
| `⌘/Ctrl S` | Save open form |
| `Esc` | Close modal / clear search |
| `?` | Shortcut overlay |

Plus, inside data-entry modals: `Tab` order following visual order, `⌘Enter` to
save-and-new (critical for repeated entry), and `Alt+↓` on the "Add Row" pattern.

**UX impact** For a 6-hour-per-day user this is the difference between a tool and
a chore. **Effort** M (1 wk) · **Depends on** command palette

---

## FLOW-005 · Filter state is disposable
**Severity** High · **Priority** P1

All view state lives in `App.State` and dies on reload. The PO Ledger has four
status filter buttons (`po_ledger.html:8-18`), a search box, a date filter and a
sort — a user reconstructs their working view **every single session**, and
often several times a day after a refresh.

There is also no History API integration, so the browser Back button does nothing
inside the SPA — a persistent low-grade surprise.

**Expected behaviour, in three increments:**
1. **URL state** — `?tab=poLedger&status=partial&q=acme&page=2&sort=dateDesc`
   via `pushState`. Restores Back/Forward, bookmarking and sharing. Build it
   into ListView once rather than 11 times.
2. **Persist last view per tab** in `localStorage` so a refresh is not a reset.
3. **Saved views** — "My overdue POs", "Dispatch this week" — pinned to the
   sidebar. This is the feature that most makes an ERP feel personal, and it is
   cheap once (1) exists.

**Effort** S for (1)+(2) inside ListView; M for (3) · **Depends on** ListView

---

## FLOW-006 · Selection leads only to deletion
**Severity** Medium · **Priority** P2

Every list has checkboxes and `App.Selection` provides sound plumbing
(`core.js:304-330`). Thirteen bulk RPCs are registered — **all destructive.**
The PO Ledger does slightly better, exposing bulk print and bulk PDF
(`po_ledger.html:84-90`), which proves the pattern works; no other module has it.

A user who selects 40 rows has invested real effort and can only destroy them.

**Expected behaviour.** A selection action bar on first selection:
`40 selected · Change status · Export CSV · Print · Delete`, with the
destructive action visually separated and last. Bulk status change is the
highest-value addition — `updateProductionStatus` already exists as an RPC.

**Effort** M (bar S; each bulk RPC ~2 d) · **Depends on** SelectionBar component

---

## FLOW-007 · No role-based surface
**Severity** Medium · **Priority** P2

Every user sees all 11 tabs, all 42 modals and all four master-data buttons in
the header, regardless of their job. A dispatch clerk navigates past Purchase
Orders, Bill Ledger, Returns, Items, Vendors, Stock and Contractors to reach
Dispatch, every session.

This overlaps with a real security gap: there is **no authorization layer at
all** (`PYTHON_BACKEND_REVIEW.md` PY-009) — any authenticated user can invoke
`deleteItemsBulk` or `triggerBackup`. **Solve both with one role model.**

**Expected behaviour.** Define `operator` / `manager` / `admin`; enforce
server-side on `RpcSpec`; use the same roles client-side to order and filter
navigation. Add per-user sidebar pinning and reordering for personalisation
within a role.

**Effort** M (1–2 wk) · **Blocked on a business decision about the role model** —
that question should be asked now, since two workstreams depend on the answer.

---

## FLOW-008 · No onboarding, contextual help, or shortcut discovery
**Severity** Medium · **Priority** P2

No first-run tour, no empty-state guidance (25 ad-hoc "no data" strings with no
next action), no field-level help, no `?` overlay, no changelog. `title`
attributes are used for tooltips — invisible on touch and unreliably announced.

For a system with 42 modals and domain concepts as specialised as "Warehouse
Pool", "Process Colour Axes" and "Item Identity Drift", discoverability is
entirely dependent on someone showing you.

**Expected behaviour.** Empty states that teach (`COMPONENT_LIBRARY_PLAN.md` #5)
· inline help on non-obvious fields · a `?` shortcut overlay · a short first-run
tour of the sidebar and command palette · a "What's new" entry in the
notification panel that already exists.

**Effort** M · **Highest-value first step: rewrite the 25 empty states.** Cheap,
and they appear exactly when a user is most receptive to guidance.

---

## FLOW-009 · No usage telemetry
**Severity** High (process) · **Priority** P1

There is no analytics, no session recording, no task-timing, no error-rate
tracking, no feature-usage data. Combined with the absence of RPC error logging
(`PYTHON_BACKEND_REVIEW.md` PY-001), **the team currently has no way to know
which of these workflows actually hurts most.**

Every priority in this document is reasoned from structure. That is a legitimate
starting point and it is not a substitute for evidence.

**Expected behaviour.** Privacy-respecting, self-hosted, first-party:
per-tab visit counts and dwell time · per-RPC-method call counts and p95 latency
(already recommended as `PERFORMANCE_AUDIT.md` PERF-009) · modal open/abandon
rates — an abandoned `editPoModal` is a direct signal of FLOW-001 pain ·
search-term logs, which will show exactly what a `globalSearch` must cover ·
error rates per method.

**Do this in Wave 0.** It is inexpensive and it converts the rest of this
document from reasoned to measured.
**Effort** M (1 wk) · **Dependencies** none

---

## Flow-by-flow projections

Structural interaction counts. Post-change figures assume the roadmap through
Wave 2.

| Workflow | Today | After | Change |
|---|---:|---:|---|
| Create a PO | ~12 interactions + 1 full fetch | ~8, keyboard-only path available | −33%, no mouse required |
| Find a vendor's full history | 4 tabs, 4 searches, 4 fetches | 1 palette query → detail view | −75% |
| Record a bill against a PO | ~14 + a cancel/return loop for reference | ~9, PO visible in split view | −35%, reference loop removed |
| Update 20 production statuses | 20 modal open/save cycles | select 20 → one bulk action | −90% |
| Return to yesterday's filtered view | rebuild filters manually | bookmark or saved view | −100% |
| Recover from an accidental delete | support request | Undo toast, 8 s | eliminated |
| Switch tabs | full fetch, no feedback | instant from cache, revalidate behind | perceived-instant |

---

## Delight features (Phase 9), ranked by value ÷ effort

| Rank | Feature | Effort | Why it earns its place here |
|---|---|---|---|
| 1 | **Command palette** | M | Fixes navigation, search, keyboard and discoverability at once |
| 2 | **Undo on destructive actions** | M | Soft deletes already exist — the data is there, only the affordance is missing |
| 3 | **Skeleton loading** | S | Cheapest perceived-performance win available |
| 4 | **Saved views / pinned filters** | M | Makes the product feel personal; ERP-specific |
| 5 | **Density toggle** (comfortable/compact/dense) | S | One `<html>` attribute; power users will use it daily |
| 6 | **Inline row editing** | M | Removes the modal from the most frequent single-field edits |
| 7 | **Keyboard shortcuts + `?` overlay** | M | Compounds with #1 |
| 8 | **Split view on wide screens** | M | Turns wasted ultra-wide space into fewer clicks |
| 9 | **Better empty states** | S | Teaching moments currently wasted 25 times |
| 10 | **Recent items / activity timeline** | S | The notification panel is already built — extend it |
| 11 | **Bulk status change** | M | Selection currently only destroys |
| 12 | **Autosave drafts in modals** | M | Removes the fear of dismissing a form |
| 13 | **System-preference dark mode default** | S | `prefers-color-scheme` is currently ignored |
| 14 | **Optimistic UI on mutations** | L | Needs the ListView layer first |

**Already present, and good:** dark mode with flash prevention · notification
history · `prefers-reduced-motion` · offline PWA with mutation outbox ·
visibility-aware dashboard refresh · arrow-key record paging in modals.

---

## Sequenced recommendation

| Wave | Items | Duration | Outcome |
|---|---|---|---|
| **0** | FLOW-009 telemetry · FLOW-003 SWR cache · skeletons · debounce searches | 2 wk | Measurable, and tab switching stops hurting |
| **1** | Command palette + `globalSearch` · keyboard shortcuts · undo · empty states | 6 wk | Navigation and safety transformed |
| **2** | URL state · saved views · density toggle · bulk status change · SelectionBar | 6 wk | The product becomes personal and efficient |
| **3** | Split view · inline editing · deep links · autosave | 8 wk | Modal dependence broken |
| **4** | Role-based surface · onboarding · activity timeline | 6 wk | Fits each user's actual job |

**Wave 0 is two weeks and should start immediately** — it makes everything after
it measurable, and the SWR cache alone changes how the product feels.
