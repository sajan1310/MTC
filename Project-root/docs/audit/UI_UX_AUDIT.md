# UI / UX Audit — Phases 2 & 3

Scope: `templates/erp/**`, `static/erp/*.js`, `static/erp/styles.css`, auth pages.
Every finding is anchored to measured evidence. See `00_APPLICATION_MAP.md` for the inventory.

**Severity key** — `Critical` blocks daily work or corrupts trust in data ·
`High` measurably slows the primary workflow · `Medium` friction or inconsistency ·
`Low` polish.

---

## Summary of findings

| ID | Title | Severity | Priority |
|---|---|---|---|
| UX-001 | Every list view re-fetches its entire table on tab switch | Critical | P0 |
| UX-002 | No global search — 11 siloed search boxes, no cross-entity lookup | High | P1 |
| UI-001 | Three parallel design systems with three different brand palettes | High | P1 |
| UX-003 | No optimistic UI, no autosave, no undo on any destructive action | High | P1 |
| UI-002 | 1,391 inline `style=` declarations bypass the token layer | High | P1 |
| UX-004 | Near-zero loading states — 9 indicators across 24,920 lines of JS | High | P1 |
| UX-005 | Keyboard support is effectively absent for power users | High | P1 |
| UI-003 | No spacing or typography scale in the desktop token set | Medium | P2 |
| UX-006 | Filter/sort state is not URL-addressable or persisted | Medium | P2 |
| UI-004 | Header is an unstructured 8-control flex row | Medium | P2 |
| UX-007 | Bulk operations are delete-only | Medium | P2 |
| UI-005 | 143 `!important` declarations indicate specificity conflicts | Medium | P3 |
| UX-008 | Confirmation modal is generic — no context, no consequence preview | Medium | P2 |
| UI-006 | Toast is the only feedback channel; 3s auto-dismiss loses errors | Medium | P2 |

---

## Phase 2 — UI Review

### UI-001 · Three parallel design systems with three different brand palettes
**Location** `static/erp/styles.css` · `static/styles.css` · `static/css/login.css` · `static/erp/mobile_styles.css`
**Severity** High · **Priority** P1

**Description.** The application ships three unrelated visual languages. A user
signing in sees indigo `#6366F1`; landing in the ERP they see slate `#0f172a`;
opening the mobile PWA they see safety orange `#ff6a13`. Nothing except the
wordmark ties them together.

| Surface | Stylesheet | Lines | Primary | Font stack |
|---|---|---:|---|---|
| Auth (login/signup/forgot/reset) | `static/styles.css` + `static/css/login.css` | 3,060 | `#6366F1` | — |
| Desktop ERP | `static/erp/styles.css` | 2,912 | `#0f172a` | Inter + Outfit |
| Mobile PWA | `static/erp/mobile_styles.css` | 857 | `#ff6a13` | Inter + Oswald |

**Current behaviour.** Same product, three identities. A colour or radius change
must be made in three places and will drift.

**Expected behaviour.** One token layer (`--mb-*` naming is already the best of
the three) consumed by all surfaces, with a documented *deliberate* divergence
where the shop-floor context justifies it — high-visibility safety orange on the
mobile PWA is a legitimate design decision and should be kept as a **theme**, not
a fork.

**UX impact** Erodes perceived quality and product coherence; users learn three
sets of visual affordances. **Business impact** Undermines the "premium
enterprise" positioning; triples the cost of any rebrand. **Maintainability**
Three files to change for every visual decision. **Performance** Auth pages ship
3,060 lines of CSS for four forms.

**Recommended solution.** Extract `static/design/tokens.css` as the single
source; re-express all three stylesheets as consumers. Keep the mobile palette as
`[data-theme="workshop"]`. See `DESIGN_SYSTEM.md`.

**Effort** M (3–5 d) · **Dependencies** none · **Affects** every screen

---

### UI-002 · 1,391 inline `style=` declarations bypass the token layer
**Severity** High · **Priority** P1

**Description.** Measured inline style attributes:

| Source | Count |
|---|---:|
| JS template literals (`static/erp/*.js`) | 795 |
| `templates/erp/partials/print.html` | 414 |
| Other `templates/erp/**` | 182 |
| **Total** | **1,391** |

`print.html`'s 414 are **legitimate and correctly reasoned** — `styles.css:2460`
documents that html2canvas is a screen-media renderer that never applies
`@media print`, so print layout must be inline. Exclude those. The remaining
**977** are not defensible: they hard-code colours, spacing and shadows that
already exist as tokens.

Worked example — `templates/erp/index.html:175`, the app header:
```html
style="margin: -20px -20px 24px -20px; padding: 20px 24px 16px 24px;
       background: rgba(255,255,255,0.7); backdrop-filter: blur(12px);
       border-bottom: 1px solid rgba(0,0,0,0.05); position: sticky; top: 0;
       z-index: 1000; box-shadow: 0 4px 20px rgba(0,0,0,0.02);"
```
This is a component. It is also why `styles.css:107-111` needs three
`!important` overrides to make dark mode work — inline styles beat any selector.

**Expected behaviour.** `<div class="app-header">`, styled once in CSS, themeable
without `!important`.

**UX impact** Dark mode is patched rather than designed, so contrast is
inconsistent. **Maintainability** Visual changes require editing JS string
literals. **Performance** ~35 KB of repeated style text across the JS bundle.

**Effort** L (1–2 wk, mechanical) · **Depends on** UI-001 tokens · **Affects** all views

---

### UI-003 · No spacing or typography scale in the desktop token set
**Location** `static/erp/styles.css:27-67` · **Severity** Medium · **Priority** P2

**Description.** The `:root` block defines colour, shadow, radius and transition
tokens — but **no spacing scale and no type scale**. Consequence: spacing is
chosen ad hoc per component. Observed paddings in one stylesheet: `8px`, `10px`,
`12px`, `14px`, `16px`, `20px`, `24px`, plus `padding: 20px 24px 16px 24px`
inline. Font sizes appear as `12px`, `13px`, `14px`, `16px`, `18px`, `24px` with
`!important` used to win conflicts.

The **mobile stylesheet already solves this** (`mobile_styles.css`,
`--mb-sp-1`…`--mb-sp-8`, `--mb-font-display`/`--mb-font-body`). The desktop
system should adopt it rather than invent a third approach.

**UX impact** Optical misalignment across views; the interface reads as
assembled rather than designed. **Effort** S for tokens, M to adopt · **Affects** all views

---

### UI-004 · Header is an unstructured 8-control flex row
**Location** `templates/erp/index.html:174-263` · **Severity** Medium · **Priority** P2

**Description.** The sticky header carries, in one undifferentiated flex row:
sidebar toggle · brand icon · "Maharaja Bikes" `<h2>` · "ERP System" `<h4>` ·
4 master-data buttons (Units/Colors/Models/Process Types) · logo upload label ·
logo clear button · dark-mode toggle · notification bell · a company-name badge.

Three problems:
1. **No visual hierarchy** — the four master-data buttons are styled identically
   to each other *and* carry equal weight to the notification bell, despite being
   rarely-used administrative settings.
2. **Wrong information architecture** — Units/Colors/Models/Process Types are
   *reference data configuration*. They belong in a Settings surface, not
   permanently occupying primary header real estate on every screen.
3. **Logo upload lives in the header** — a once-per-installation action given
   permanent chrome.

At `<768px` the header wraps to multiple rows (`styles.css:2788`), consuming a
large share of a phone viewport before any content.

**Expected behaviour.** Header = brand · global search · notifications · theme ·
user menu. Everything else moves into a **Settings** entry or a command palette.

**UX impact** Constant low-grade visual noise for hours-long daily users.
**Effort** S (1–2 d) · **Affects** every screen

---

### UI-005 · 143 `!important` declarations
**Location** `static/erp/styles.css` · **Severity** Medium · **Priority** P3

Symptom, not root cause. Driven by (a) overriding Bootstrap utility classes,
(b) overriding the inline styles of UI-002. Fixing UI-002 removes most of them.
Track the count as a regression metric: **target < 20**, print-isolation blocks excepted.

---

### UI-006 · Toast is the only feedback channel; 3s auto-dismiss loses errors
**Location** `templates/erp/index.html:104` (`data-bs-delay="3000"`) · **Severity** Medium

Every outcome — a successful save, a validation failure, a server error — arrives
as the same 3-second toast in the same corner. There *is* a notification bell that
retains history (`index.html:239-256`), which is a genuinely good mitigation. But:

- Success and error use one channel with no differentiated urgency.
- A save error that appears while the user is scrolled elsewhere is gone in 3s.
- No inline, field-level error placement on forms — errors are announced globally
  rather than attached to the offending input.

**Expected behaviour.** Three tiers: **inline field errors** (validation),
**persistent banner** (operation failed, stays until dismissed), **toast**
(success/ephemeral). Errors must never auto-dismiss.

**Effort** M · **Affects** all forms · See `COMPONENT_LIBRARY_PLAN.md` §Alert/Toast

---

## Phase 3 — UX Review

### UX-001 · Every list view re-fetches its entire table on tab switch
**Location** `static/erp/core.js:1387-1414` (`App.Navigation.showTab`) · **Severity** Critical · **Priority** P0

**Description.** `showTab()` unconditionally calls the module's `loadData()`:

```js
if (id === 'poLedger'   && typeof App.PO      !== 'undefined') App.PO.loadData();
if (id === 'billLedger' && typeof App.Bill    !== 'undefined') App.Bill.loadData();
if (id === 'stockTab'   && typeof App.Stock   !== 'undefined') App.Stock.loadData();
…
```

Each `loadData()` issues `Api.call('getXData')`, and **no `getXData` method
paginates** — the service layer contains exactly **one `LIMIT`** across 390
`execute()` calls (`ledger_audit_service.py:309`). Pagination happens entirely
client-side in `App.State.poCurrentPage` etc.

**Current behaviour.** Switching PO → Bill → PO re-downloads the full PO table
twice. There is no cache, no `stale-while-revalidate`, no ETag, no request
de-duplication. Time-to-interactive on every tab switch scales linearly with
total table size, forever.

**Expected behaviour.** Server-side pagination + filtering + sorting; a client
cache keyed by `(method, params)` that renders cached rows immediately and
revalidates in the background.

**UX impact** The single largest daily-friction item. Enterprise users switch
tabs dozens of times an hour; each switch is a full-table round trip with no
skeleton (see UX-004), so the table simply freezes.
**Business impact** The app gets *slower every month* as data accumulates —
today's acceptable latency is a future outage. **Performance impact** Dominates
INP and every tab-switch interaction.

**Recommended solution.** Three stages, in order:
1. Add a `SWR` cache in `api.js` keyed on `method + JSON.stringify(args)` with a
   short TTL and background revalidation — **no server changes, immediate win**.
2. Add `{limit, offset, sort, filter}` to the highest-volume read methods
   (`getPOData`, `getBillData`, `getStockData`, `getProductionData`,
   `getItemsData`) returning `{rows, total}`.
3. Migrate the shared list-view controller (see UX-002/`CODE_REFACTORING_PLAN.md`)
   onto server pagination once all modules use it.

**Effort** Stage 1: S (2–3 d). Stages 2–3: L (3–4 wk).
**Dependencies** Stage 3 depends on the list-view controller.
**Affects** all 11 tabs

---

### UX-002 · No global search — 11 siloed search boxes
**Severity** High · **Priority** P1

**Description.** Each module owns a private search term
(`poSearchTerm`, `billSearchTerm`, `returnSearchTerm`, `wastageSearchTerm`,
`stockSearchTerm`, `warehousePoolSearchTerm`, `issueSearchTerm`,
`productionAllSearchTerm`, … — `core.js:124-298`). There is **no way to search
across entities.** To answer "where does vendor X appear?" a user must visit
Vendors, POs, Bills and Returns and search four times.

Each search also filters only the client-side array already in memory — so it
searches *the data that happens to be loaded*, which is currently everything, but
will silently become "the first page" the moment UX-001 stage 2 lands. **This
coupling must be resolved as part of that work, not after.**

**Expected behaviour.** A `⌘K` / `Ctrl+K` command palette offering
(a) cross-entity record search, (b) navigation, (c) actions ("New PO",
"Toggle dark mode"). This is the single highest-leverage UX addition available —
it simultaneously fixes UX-005 (keyboard), UI-004 (header clutter) and
discoverability of the 4 buried master-data modals.

**UX impact** Eliminates the dominant navigation cost. **Business impact** The
defining interaction of Linear / Notion / GitHub / Stripe, and the clearest
single signal of "modern enterprise software".
**Effort** M (1–2 wk) · **Depends on** a server-side search RPC for stage (a)

---

### UX-003 · No optimistic UI, no autosave, no undo on destructive actions
**Severity** High · **Priority** P1

**Description.** Verified across the frontend:
- **Undo**: no implementation anywhere.
- **Autosave**: none — all form work is lost if a modal is closed.
- **Optimistic updates**: none — every mutation blocks on the round trip, then
  triggers a **full table re-fetch**.

Deletes are guarded only by the generic `#confirmModal`
(`index.html:112-126`) — see UX-008. Deletion is soft (`deleted_at IS NULL`
throughout the service layer), so **the data needed for undo already exists**;
only the UI affordance is missing.

**Expected behaviour.** Destructive actions apply immediately with a 5–8 second
"Deleted 3 purchase orders · **Undo**" toast, backed by an
`undoDelete(entity, ids)` RPC that clears `deleted_at`. This is both better UX
*and* safer than a confirm dialog, which users click through reflexively.

**UX impact** Removes fear from bulk operations; removes a modal from every
delete path. **Business impact** Directly reduces data-loss support incidents.
**Security impact** Neutral — undo restores only rows the same user just
soft-deleted and must re-check authorisation.
**Effort** M (1 wk) · **Depends on** soft-delete (already present)

---

### UX-004 · Near-zero loading states
**Severity** High · **Priority** P1

**Description.** Across **24,920 lines** of frontend JavaScript, all templates and
the full stylesheet, there are **9** occurrences of `skeleton`, `spinner-border`
or `aria-busy` combined. There is **no `.skeleton` rule in `styles.css`.**

Combined with UX-001 (every tab switch = full-table fetch), the user experience of
switching tabs is: click → **nothing happens** → table appears. There is no
signal that work is in progress, no perceived-performance mitigation, and no
`aria-busy` for assistive technology.

**Expected behaviour.** Skeleton rows matched to the target table's column
geometry, shown after a 150 ms delay (avoids flash on cache hits), with
`aria-busy="true"` on the container.

**UX impact** Perceived performance is the cheapest performance win available;
skeletons typically reduce *perceived* wait substantially at zero backend cost.
**Accessibility impact** Screen-reader users get no announcement that content is
loading — a WCAG 4.1.3 (Status Messages) gap. See `ACCESSIBILITY_REPORT.md` A11Y-007.
**Effort** S (2–3 d) once the table component exists

---

### UX-005 · Keyboard support is effectively absent
**Severity** High · **Priority** P1

**Description.** Measured: **4** `keydown` listeners in the entire frontend. One
of them (`core.js:95-106`) is a genuinely nice touch — arrow-key record paging
inside modals via `App.Nav`. But there is no:

- global shortcut map · command palette · `/` to focus search
- `Esc` conventions beyond Bootstrap's modal default
- `j`/`k` row navigation, `Enter` to open, `Space` to select
- shortcut discovery (no `?` overlay)
- roving tabindex in the 11-item sidebar (all 11 are separate tab stops)

For a product whose users are in it **all day**, this is the difference between
a tool and a chore. `role="tablist"` is declared on the sidebar
(`index.html:270`) but the APG-required arrow-key behaviour is not implemented —
see `ACCESSIBILITY_REPORT.md` A11Y-006.

**Expected behaviour.** Minimum viable set:

| Key | Action |
|---|---|
| `Ctrl/⌘ K` | Command palette (UX-002) |
| `/` | Focus current view's search |
| `g` then `p`/`b`/`s`/`i` | Go to POs / Bills / Stock / Items |
| `n` | New record in current view |
| `j` / `k` | Move row selection |
| `x` | Toggle row checkbox |
| `Esc` | Close modal / clear search |
| `?` | Shortcut cheatsheet |

**Effort** M (1 wk) · **Depends on** command palette · **Affects** all views

---

### UX-006 · Filter, sort and pagination state is not URL-addressable
**Severity** Medium · **Priority** P2

**Description.** All list state lives in `App.State` (`core.js:124-298`) and is
lost on reload. Consequences: a user cannot bookmark "overdue POs for vendor X",
cannot share that view with a colleague, cannot open two filtered views in two
tabs, and loses their filters on every refresh. The browser Back button does
nothing within the SPA — there is no History API integration at all.

**Expected behaviour.** Serialise view state to the query string
(`/erp?tab=poLedger&q=acme&status=partial&page=2&sort=dateDesc`) via
`history.pushState`, restored on load. Add saved views ("My overdue POs") as a
follow-on.

**UX impact** Restores Back/Forward, bookmarking and sharing — three
expectations users bring from every other web app. **Effort** M · **Depends on**
the list-view controller (do it once there, not 11 times)

---

### UX-007 · Bulk operations are delete-only
**Severity** Medium · **Priority** P2

**Description.** `App.Selection` (`core.js:304-330`) provides solid generic
multi-select plumbing, and every list has checkboxes. But the only bulk RPCs
registered are destructive: `deleteBillsBulk`, `deletePOsBulk`,
`deleteItemsBulk`, `deleteClientsBulk`, `deleteVendorsBulk`,
`deleteProcessesBulk`, `deleteProductionBulk`, `deleteReturnsBulk`,
`deleteDispatchBulk`, `deleteIssueBulk`, `deleteWastageBulk`,
`deleteClientOrdersBulk`, `deleteBOMsBulk` — **13 bulk deletes, 0 bulk edits.**

The user has invested the effort of selecting 40 rows and the only thing the
product lets them do is destroy them. Bulk *status change*, bulk *tag*, bulk
*export* and bulk *print* are the operations an ERP user actually needs daily.

**Expected behaviour.** A contextual selection action bar appearing on first
selection: `40 selected · Change status · Export CSV · Print · Delete`.

**Effort** M · **Depends on** list-view controller

---

### UX-008 · Confirmation modal is generic and context-free
**Location** `templates/erp/index.html:112-126` · **Severity** Medium · **Priority** P2

**Description.** One shared `#confirmModal` with a static title
(`"Action Required"`), a caller-supplied message, and a fixed
`"Yes, Proceed"` button. It does not name the entity, show what is affected, or
state the consequence.

Three specific weaknesses:
1. **No consequence preview.** Deleting a PO with linked bills should say so.
2. **Fixed generic button label.** Usability research is consistent that
   action-specific labels (`Delete 40 purchase orders`) produce far fewer
   mis-confirmations than `Yes, Proceed`.
3. **`bg-warning` header on destructive actions.** The header is amber
   regardless of severity, and amber `#ffc107` with the theme's text is also a
   contrast problem (see `ACCESSIBILITY_REPORT.md` A11Y-002).

**Expected behaviour.** Prefer **undo over confirm** (UX-003) for reversible
soft-deletes. Reserve confirmation for genuinely irreversible actions, and when
used: name the action, count the records, list downstream effects, and label the
button with the verb.

**Effort** S (1–2 d) · **Affects** every destructive path

---

## What is already good — preserve these

An audit that only lists faults is not accurate. These are above the standard
typically found at this stage and should be protected during refactoring:

1. **The inline code commentary.** `app/__init__.py:405-413`, `pages.py:29-54`,
   `styles.css:2460`, `api.js:49-57` explain *why*, including the failure that
   motivated the current design. This is rare and genuinely valuable.
2. **Mutation idempotency.** `X-Mutation-Id` with replay caching
   (`rpc.py:33-45`) is a correct, well-reasoned solution to double-submit and
   offline replay — better than most production systems.
3. **The offline PWA.** A mutation outbox with replay/reconciliation, Background
   Sync, and chaos tests (`static/erp/tests/outbox_chaos.test.js`) is
   sophisticated engineering.
4. **`prefers-reduced-motion` support** (`styles.css:2906`) — implemented
   correctly and comprehensively.
5. **The mobile design system.** `mobile_styles.css` has the spacing scale, type
   scale and elevation tokens the desktop system lacks. Promote it, don't replace it.
6. **Visibility-aware dashboard polling** (`dashboard.js:24-36`) — pauses on
   `visibilitychange`. Correct, and frequently missed.
7. **Theme flash prevention** (`index.html:30-38`) — pre-paint theme application.
8. **Soft deletes throughout** — makes undo cheap to add.
