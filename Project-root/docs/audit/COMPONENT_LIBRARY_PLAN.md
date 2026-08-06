# Component Library Plan — Phase 7

Companion to `DESIGN_SYSTEM.md`. Specifies *what to build*, in what order, and
why each earns its place.

---

## Constraints that shape every decision

1. **No framework, and none is being introduced.** The codebase is vanilla JS
   with jQuery present only as a Select2 dependency. Introducing React/Vue would
   mean rewriting 24,920 lines. **Rejected.**
2. **Bootstrap 5.3 is already loaded and used throughout.** Components should
   *extend* it where it is adequate, *replace* it where it is not, and never
   duplicate it.
3. **Two shells** (desktop + mobile PWA) must share the layer, or the split
   doubles the cost of every component (`RESPONSIVE_REVIEW.md` RES-004).
4. **Incremental adoption is mandatory.** A production ERP cannot be rewritten
   behind a flag. Every component must be adoptable one view at a time.

**Chosen approach: CSS-first components + a small vanilla-JS behaviour layer.**
Each component is a documented class contract in CSS; those needing behaviour get
a factory function returning `{el, update, destroy}`. No build step required to
adopt, though the build step from `PERFORMANCE_AUDIT.md` PERF-001 will bundle them.

```
static/design/components/
├── button.css          data-table.js
├── field.css           command-palette.js
├── table.css           toast.js
├── ...                 ...
```

---

## Build order

Ordered by **(daily-use frequency × current defect count) ÷ effort**.

| # | Component | Why now | Effort | Fixes |
|---|---|---|---|---|
| 1 | **DataTable** | 75 tables, every a11y + perf finding routes through it | L | A11Y-001, A11Y-005, A11Y-007, PERF-005, RES-001, UX-007 |
| 2 | **Skeleton** | 9 loading indicators in 24,920 lines | S | UX-004, A11Y-007 |
| 3 | **Field** (label+input+error) | 221 controls, 88 unlabelled, no inline errors | M | A11Y-012, UI-006 |
| 4 | **Button** | Anchors the token layer; unblocks inline-style removal | S | UI-002, A11Y-004, A11Y-011 |
| 5 | **EmptyState** | 25 ad-hoc strings | S | UX-004 |
| 6 | **Toast / Alert** | Errors auto-dismiss in 3s and are lost | S | UI-006, A11Y-007 |
| 7 | **CommandPalette** | Highest-leverage single UX addition | M | UX-002, UX-005, UI-004 |
| 8 | **Pagination** | Re-implemented 11× | S | UX-001, UX-006 |
| 9 | **SelectionBar** | 13 bulk deletes, 0 bulk edits | S | UX-007 |
| 10 | **Dialog** | Generic confirm with no context | S | UX-008 |
| 11 | **Combobox** | Retires Select2 → jQuery (~115 KB) | M | PERF-006 |
| 12 | **Badge / StatusPill** | Status semantics scattered inline | S | UI-002 |
| 13 | **Card / KPI** | Dashboard + every panel | S | UI-002 |
| 14 | **Tabs / SubNav** | `role="tablist"` without APG behaviour | S | A11Y-006 |
| 15 | **DateRange** | Every ledger filters by date, all bespoke | M | UX-006 |
| 16 | **Drawer / SplitView** | Turns ultra-wide space into fewer clicks | M | RES-002 |
| 17 | **Chart** | No charting exists; Chart.js already CSP-allowed | M | — |
| 18 | **Toolbar** | Codifies the `.table-container > .d-flex` contract | S | UI-004, RES-005 |

---

## 1 · DataTable — the keystone

**Build this first.** It is the single largest lever in the entire audit: 75
tables, and it is the delivery vehicle for six separate findings.

### Contract
```js
const table = DataTable(container, {
  columns: [
    {key: 'poNumber', label: 'PO Number', sortable: true, rowHeader: true, width: '120px'},
    {key: 'vendorName', label: 'Vendor', sortable: true},
    {key: 'poDate', label: 'Date', sortable: true, type: 'date'},
    {key: 'totalValue', label: 'Value', type: 'currency', align: 'end'},
    {key: 'status', label: 'Status', render: r => StatusPill(r.status)},
    {key: '_actions', label: 'Actions', render: r => rowActions(r), sticky: 'end'},
  ],
  caption: 'Purchase orders',
  getRowId: r => r.poNumber,
  selectable: true,
  density: 'comfortable',          // reads --density-* tokens
  virtualize: 'auto',              // engages above 200 rows
  emptyState: {title: 'No purchase orders', action: {...}},
  onSort, onPage, onSelectionChange, onRowActivate,
});
table.setState({rows, total, loading, page, sort});
```

### What it must guarantee

**Accessibility** — `<th scope="col">` on every header and `scope="row"` on the
`rowHeader` column (fixes A11Y-001 across 75 tables in one change) ·
`<caption>` · `aria-sort` on sortable headers, updated on change ·
`aria-busy` during load · a polite live region announcing
`"Showing 20 of 412 purchase orders"` after every sort/filter/page (A11Y-007) ·
full keyboard grid: `↑↓` rows, `Space` select, `Enter` activate, `Home`/`End`.

**Performance** — replace `<tbody>` only, never the whole table (PERF-005) ·
key rows by id and patch in place where possible · one delegated click listener
at table level, never per row (PERF-010) · virtualise above ~200 rows ·
`content-visibility: auto` on off-screen row groups.

**Responsive** — `.table-scroll { overflow-x: auto }` wrapper (fixes RES-001
everywhere at once) · `position: sticky` on the `rowHeader` column and `thead` ·
`@container (max-width: 700px)` card layout for narrow containers (RES-003).

**Selection** — reuses the existing `App.Selection` helpers
(`core.js:304-330`), which are already sound; wires them to SelectionBar (#9).

### Migration path
Adopt one view per PR. Recommended order (ascending complexity):
Vendors → Contractors → Returns → Bills → POs → Items → Stock → Clients →
Dispatch → Production. Each PR deletes that module's bespoke render function and
its slice of `App.State`.

**Effort** L (3–4 weeks for the component + first two adoptions). Each subsequent
adoption ~2–3 days. **Everything else in this plan is cheaper because this
exists.**

---

## 2 · Skeleton

Only 9 loading indicators exist in the entire frontend, and no `.skeleton` rule
in the stylesheet.

```js
Skeleton.table(container, {rows: 10, columns: 6});   // matches DataTable geometry
Skeleton.card(container, {count: 4});                // dashboard KPI row
Skeleton.text(container, {lines: 3});
```

Rules: show only after **150 ms** (avoids flash on cache hits — matters once
`PERFORMANCE_AUDIT.md` PERF-003's SWR cache lands) · match the real content's
geometry so nothing shifts (protects CLS) · set `aria-busy="true"` and hide
skeleton nodes from AT with `aria-hidden` · respect `prefers-reduced-motion` by
dropping the shimmer (the codebase already handles this globally at
`styles.css:2906`).

**Effort** S (2–3 d) · **Depends on** DataTable geometry

---

## 3 · Field

221 form controls, ~88 without a `<label>`, no `aria-invalid`, no inline errors.

```js
Field(container, {
  id: 'po-vendor', label: 'Vendor', required: true,
  type: 'combobox', options: vendors,
  hint: 'Start typing to search',
  error: null,           // set → aria-invalid, aria-describedby, inline message
});
```

Guarantees: always a real `<label for>` · `aria-describedby` chains hint + error ·
`aria-invalid="true"` on error · error rendered adjacent, **never** as a
3-second toast · `aria-required` · consistent `--sp-*` spacing · 16px font on
mobile (preserves the existing correct iOS zoom fix at `styles.css:2678-2683`).

**Effort** M (1 wk) · **Fixes** A11Y-012, UI-006

---

## 4 · Button

```html
<button class="btn btn--primary btn--md">Save purchase order</button>
<button class="btn btn--ghost btn--icon" aria-label="Refresh">
  <i class="bi bi-arrow-clockwise" aria-hidden="true"></i>
</button>
```

Variants `primary | secondary | ghost | danger | link`; sizes `sm | md | lg`;
states `default | hover | active | focus-visible | disabled | loading`.

Guarantees: `.btn--icon` **requires** `aria-label` (enforce with a lint rule) ·
decorative icons always `aria-hidden` · minimum 24×24 target on desktop, 44×44
on touch (A11Y-011) · `:focus-visible` uses `outline`, not `box-shadow`, so
forced-colors mode works (A11Y-009) · loading state sets `aria-busy` and
disables without removing from the tab order.

**Effort** S (2–3 d) · **Build early** — it anchors the token layer and is the
prerequisite for deleting inline styles in Stage 2 of the design-system migration.

---

## 5 · EmptyState

25 ad-hoc "no data" strings today. An empty state is the highest-value teaching
moment in any application, and this product currently wastes all 25.

```js
EmptyState(container, {
  icon: 'bi-inbox',
  title: 'No purchase orders yet',
  body: 'Create your first PO to start tracking vendor orders.',
  action: {label: 'New purchase order', onClick: () => App.PO.openModal()},
});
```

Distinguish three cases — **empty** (nothing exists → offer creation), **no
results** (filters too narrow → offer clearing them), **error** (→ offer retry).
Conflating them is the most common empty-state mistake and the current code makes it.

**Effort** S (1–2 d)

---

## 6 · Toast / Alert / Banner

Today: one toast, 3-second auto-dismiss, used for success *and* errors.

Three tiers with distinct lifetimes:
- **Toast** — success/ephemeral, auto-dismiss 4 s, `role="status"` (polite).
- **Banner** — operation failed / degraded state, **persists until dismissed**,
  `role="alert"`, rendered in-view not in a corner.
- **Inline** — field-level, owned by Field (#3).

Errors must **never** auto-dismiss. Keep the existing notification-panel history
(`index.html:239-256`) — it is a good mitigation and should receive all three tiers.

Add an **undo affordance** slot: `Toast.action({label: 'Undo', onClick})` — the
delivery mechanism for `UI_UX_AUDIT.md` UX-003.

**Effort** S (2–3 d)

---

## 7 · CommandPalette

The single highest-leverage addition in this audit. Simultaneously addresses
UX-002 (no global search), UX-005 (no keyboard support), UI-004 (header clutter)
and the discoverability of the four buried master-data modals.

```js
CommandPalette.register({
  id: 'po.new', title: 'New purchase order', section: 'Actions',
  keywords: ['po', 'purchase', 'order', 'create'], shortcut: 'n',
  run: () => App.PO.openModal(),
});
CommandPalette.registerSource({
  id: 'records',
  search: async q => (await Api.call('globalSearch', q)).data,
});
```

Sections: **Records** (cross-entity, needs a `globalSearch` RPC) · **Navigate**
(11 tabs) · **Actions** (new record, export, print) · **Settings** (theme,
density, the four master-data modals). Opens on `Ctrl/⌘ K`. Recent items first.
Fully keyboard-driven with correct `role="combobox"` + `aria-activedescendant`.

**Effort** M (1–2 wk) for the shell; the `globalSearch` RPC is separate backend
work (a `UNION ALL` across indexed name columns, with `LIMIT` — see
`SQL_OPTIMIZATION.md` SQL-001).

---

## 8–10 · Pagination · SelectionBar · Dialog

**Pagination** — currently reimplemented in 11 modules. One component; emits
`{page, pageSize}`; page-size selector; `aria-label="Pagination"` on a `<nav>`;
reads/writes URL state (UX-006). Must be built to accept a server-provided
`total` from day one so the PERF-002 migration needs no second pass. **S (1–2 d)**

**SelectionBar** — appears on first selection:
`40 selected · Change status · Export · Print · Delete`. Turns 13 bulk-delete-only
flows into genuine bulk operations (UX-007). Announces selection count to a live
region. **S (2 d)**

**Dialog** — replaces the generic `#confirmModal` (`index.html:112-126`).
Requires an explicit verb label (`Delete 40 purchase orders`, never
`Yes, Proceed`), a consequence preview, and `danger` styling on destructive
variants. **Prefer undo (#6) over confirm wherever the delete is soft** — which,
given `deleted_at` is used throughout, is nearly everywhere. **S (1–2 d)**

---

## 11 · Combobox — retires Select2 and jQuery

Select2 is the sole reason jQuery is loaded (`index.html:19` states this).
Together with the two Select2 themes that is roughly **115 KB and three CDN
origins** on the critical path (`PERFORMANCE_AUDIT.md` PERF-006), plus three
entries in the CSP allowlist.

A native replacement using `<input role="combobox">` + `<ul role="listbox">`
with `aria-activedescendant` covers the required behaviour (search, async
options, multi-select, keyboard) in well under Select2's footprint.

**Effort** M (1–2 wk, plus careful migration of every Select2 call site).
**Sequence after DataTable** — some comboboxes live inside table cells and the
migration is cleaner once row rendering is centralised.

---

## 12–18 · Remaining components

| Component | Note |
|---|---|
| **Badge / StatusPill** | Map domain status → semantic token once. `PO_STATUS` (`api.js:167`) already defines the three canonical strings — bind to it. Must not rely on colour alone (WCAG 1.4.1): pair with icon or text. |
| **Card / KPI** | Extract `.dash-kpi-card` (`dashboard.html:29`), which is already close to correct (`role="button"`, `tabindex="0"`). Generalise. |
| **Tabs / SubNav** | Resolve A11Y-006: convert the sidebar to `<nav>` + `aria-current="page"`; reserve true `role="tablist"` (with full APG keyboard behaviour) for genuine in-page sub-tabs like Dispatch's `.nav-pills`. |
| **DateRange** | Every ledger has a date filter, all bespoke. One component with presets (Today, This week, This month, This FY, Custom) — an ERP-specific, high-frequency need. |
| **Drawer / SplitView** | The best answer to RES-002's wasted ultra-wide space: list left, selected record right. Removes a modal round trip from the most common inspect action. |
| **Chart** | Chart.js is already in the CSP allowlist but unused. Build a thin wrapper enforcing the token palette, accessible colour pairs, and a `<table>` fallback for screen readers. Dashboard-only initially. |
| **Toolbar** | Codifies the existing markup contract that `styles.css:2797-2801` documents (`.table-container > .d-flex.justify-content-between.flex-wrap`) — search left, actions right, stacking below 576px. |

---

## Documentation and governance

**Build a `/design` route** rendering every component in every variant, state and
theme. For a no-framework codebase this is cheaper than Storybook, it stays in
sync because it imports the real CSS, and it doubles as the axe-core and
Playwright screenshot target.

Definition of done for every component:

- [ ] Keyboard operable, `:focus-visible` via `outline`
- [ ] Correct roles/labels; verified with axe-core
- [ ] Contrast AA in light, dark and workshop themes
- [ ] Works at 390px, 820px, 1440px, 3440px
- [ ] `prefers-reduced-motion` respected
- [ ] `forced-colors` verified
- [ ] Uses only semantic tokens — zero raw hex, zero `!important`
- [ ] Rendered on `/design` with all states
- [ ] Screenshot baseline committed

---

## Phasing

| Phase | Components | Duration | Outcome |
|---|---|---|---|
| **A** | Button, Skeleton, EmptyState, Toast/Alert, Badge | 2 wk | Token layer proven; loading and error UX fixed |
| **B** | **DataTable** + first 2 view adoptions | 4 wk | A11Y-001 fixed across 75 tables; PERF-005 and RES-001 resolved |
| **C** | Field, Dialog, Pagination, SelectionBar, Toolbar | 3 wk | Forms accessible; bulk operations real |
| **D** | CommandPalette, Tabs/SubNav, Card/KPI | 3 wk | Keyboard-first navigation |
| **E** | Combobox, DateRange, Drawer/SplitView, Chart | 4 wk | Select2/jQuery retired; ultra-wide layout |
| **F** | Remaining 8 view adoptions onto DataTable | 4 wk | Bespoke render code deleted |

**Total ≈ 20 weeks** for one engineer, overlapping with the backend track in
`IMPLEMENTATION_ROADMAP.md`. Phases A and B deliver the majority of the
accessibility and performance benefit and can be shipped independently.
