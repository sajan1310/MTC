# Accessibility Report — WCAG 2.2 Level AA

Scope: `templates/**`, `static/erp/*.js` (rendered output), `static/erp/styles.css`.
Method: static analysis + computed contrast ratios (WCAG relative-luminance formula).

> **Caveat, stated plainly.** This is a static audit. It cannot substitute for
> testing with NVDA/JAWS/VoiceOver, and axe-core has not been run against the
> live DOM. Findings below are those provable from source; a live audit will
> find more. Getting axe-core into CI is itself recommendation A11Y-010.

---

## Compliance summary

| Guideline | Status | Blocking findings |
|---|---|---|
| 1.1.1 Non-text Content | ⚠️ Partial | A11Y-004 |
| 1.3.1 Info and Relationships | ❌ **Fail** | A11Y-001, A11Y-003 |
| 1.4.3 Contrast (Minimum) | ❌ **Fail** | A11Y-002 |
| 1.4.11 Non-text Contrast | ⚠️ Partial | A11Y-002 |
| 2.1.1 Keyboard | ❌ **Fail** | A11Y-005, A11Y-006 |
| 2.4.3 Focus Order | ⚠️ Partial | A11Y-008 |
| 2.4.7 Focus Visible | ⚠️ Partial | A11Y-009 |
| 2.5.5 Target Size | ✅ Pass (mobile) | — |
| 2.5.8 Target Size (Minimum) — *2.2* | ⚠️ Partial | A11Y-011 |
| 3.3.1 Error Identification | ❌ **Fail** | A11Y-012 |
| 4.1.2 Name, Role, Value | ❌ **Fail** | A11Y-005 |
| 4.1.3 Status Messages | ❌ **Fail** | A11Y-007 |

**Overall: does not meet WCAG 2.2 AA.** Six Level-A/AA failures, all remediable.

---

## A11Y-001 · No `scope` attribute on any table header — 75 tables
**Location** all of `templates/erp/partials/*.html` · **WCAG** 1.3.1 (A)
**Severity** Critical · **Priority** P0

**Description.** Measured: **75 `<table>` elements, 0 `scope=` attributes.**
This application *is* tables — it is the primary way every one of the 11 modules
presents data.

**Current behaviour.** A screen reader cannot reliably associate a data cell with
its column header. In a Purchase Order table with 12 columns, a user hears cell
values with no idea which column each belongs to. For a financial/inventory
system this makes the data unusable, not merely inconvenient.

**Expected behaviour.** `<th scope="col">` on every column header;
`<th scope="row">` on row-identifying cells (PO Number, Item Name, Vendor Name).
Add `<caption>` (visually hidden if needed) naming each table.

**UX impact** Data tables unusable via screen reader. **Business impact** Blocks
public-sector / enterprise procurement with accessibility requirements; legal
exposure under EN 301 549, ADA, and the European Accessibility Act (in force
June 2025). **Effort** S — largely mechanical; permanently fixed if tables are
rendered by one shared component (`COMPONENT_LIBRARY_PLAN.md` §DataTable).

---

## A11Y-002 · Colour contrast failures in the core token palette
**Location** `static/erp/styles.css:27-100` · **WCAG** 1.4.3 (AA) · **Severity** Critical · **Priority** P0

**Description.** Computed contrast ratios for the shipped tokens:

| Token pair | Ratio | AA normal (4.5) | AA large (3.0) |
|---|---:|:---:|:---:|
| `--text-muted #94a3b8` on `--bg-light #ffffff` | **2.56** | ❌ | ❌ |
| `--text-muted #94a3b8` on `--bg-color #f8fafc` | **2.45** | ❌ | ❌ |
| `--warning-color #ffc107` + white text | **1.63** | ❌ | ❌ |
| `--success-color #28a745` + white text | **3.13** | ❌ | ✅ |
| `--info-color #17a2b8` + white text | **3.04** | ❌ | ✅ |
| `--secondary-color #6366f1` + white text | **4.47** | ❌ | ✅ |
| Auth `--primary-color #6366F1` + white text | **4.47** | ❌ | ✅ |
| Dark `--text-muted #6e8299` on `--bg-light #161b27` | **4.36** | ❌ | ✅ |
| `--text-secondary #64748b` on white | 4.76 | ✅ | ✅ |
| `--danger-color #dc3545` + white text | 4.53 | ✅ | ✅ |
| Dark `--text-secondary #94a3b8` on `#161b27` | 6.71 | ✅ | ✅ |

**Worst case:** `--text-muted` at **2.56:1** fails even the large-text threshold.
It is used for timestamps, helper text and secondary metadata — exactly the
content low-vision users most need to read.

**`--warning-color #ffc107` at 1.63:1 with white text is effectively invisible.**
Note that `index.html:115` applies `bg-warning` to the shared confirmation modal
header — the most safety-critical dialog in the product.

**Expected behaviour** — minimum accessible replacements (all ≥ 4.5:1 on white):

| Token | Current | Proposed | New ratio |
|---|---|---|---:|
| `--text-muted` | `#94a3b8` | `#64748b` | 4.76 |
| `--success-color` | `#28a745` | `#15803d` | 4.71 |
| `--info-color` | `#17a2b8` | `#0e7490` | 4.79 |
| `--secondary-color` (on white text) | `#6366f1` | `#4f46e5` | 5.85 |
| `--warning-color` | `#ffc107` | keep as *fill*, pair only with `#1e293b` text (8.97) | — |
| Dark `--text-muted` | `#6e8299` | `#8b9cb3` | 5.6 |

**Accessibility impact** Direct AA failure on the most widely used text tokens.
**UX impact** Affects every user in bright workshop lighting, not only those with
low vision — this is a shop-floor application. **Effort** S (< 1 d for tokens;
verify no component relied on the old value). **Dependency** none — do this first.

---

## A11Y-003 · Broken heading hierarchy
**Location** all templates · **WCAG** 1.3.1 (A) · **Severity** High · **Priority** P1

**Description.** Measured heading usage across `templates/erp/**`:

| Level | Count |
|---|---:|
| `<h1>` | 5 |
| `<h2>` | 12 |
| `<h3>` | **0** |
| `<h4>` | 1 |
| `<h5>` | 62 |
| `<h6>` | 46 |

Three defects: (1) **`<h3>` is entirely skipped** — every `h2 → h4/h5` transition
violates 1.3.1; (2) **five `<h1>` elements** in a single-page app where only one
document title should exist; (3) `<h5>`/`<h6>` are being used as *styling*
choices (small bold text) rather than structure — the tell is 108 combined uses
against 12 `<h2>`.

Screen-reader users navigate by heading. A hierarchy this inverted makes the
heading list useless for orientation.

**Expected behaviour.** One `<h1>` per view (the tab name). `<h2>` for card/panel
titles, `<h3>` for subsections. Decouple size from level — use a `.text-heading-sm`
utility for visual weight, never a deeper heading tag.

**Effort** S–M · **Depends on** the type scale (UI-003)

---

## A11Y-004 · Icon-only controls and decorative icon exposure
**WCAG** 1.1.1 (A) · **Severity** High · **Priority** P1

**Description.** Two distinct problems:

1. **Icon-only buttons without accessible names.** `templates/erp/index.html:19-21`
   ships a refresh button whose entire content is `<i class="bi bi-arrow-clockwise">`
   with only `title=` — `title` is unreliably announced and never surfaced to
   touch users. Same pattern for the logo-clear button (`index.html:218`).
   Measured across all templates: **53 `aria-label` attributes** against a far
   larger population of icon-bearing controls.

2. **Decorative icons are not hidden.** Bootstrap Icons render via `<i>` elements
   with no `aria-hidden="true"`, so decorative glyphs are announced as noise
   alongside their labels.

**Positive note:** the notification bell (`index.html:240`), sidebar toggle
(`index.html:177`) and mobile-banner dismiss (`index.html:70`) *do* carry
`aria-label`. The pattern is understood; it is inconsistently applied.

**Expected behaviour.** Every icon-only control gets `aria-label`. Every
decorative icon gets `aria-hidden="true"`. Enforce via the Button component.
**Effort** S · **Affects** all views

---

## A11Y-005 · JS-rendered UI carries almost no ARIA
**WCAG** 4.1.2 (A), 2.1.1 (A) · **Severity** Critical · **Priority** P0

**Description.** Most of this application's interactive DOM is generated at
runtime by `innerHTML` — **360 assignments** across the JS modules. Measured ARIA
in all of that generated markup:

| Attribute | Occurrences in all `static/erp/*.js` |
|---|---:|
| `aria-expanded` | 6 |
| `aria-label` | 3 |
| `aria-selected` | 1 |
| **everything else** | **0** |

Zero `aria-sort` (so sortable column headers do not announce sort state), zero
`aria-live`, zero `aria-describedby`, zero `aria-invalid`, zero `role="dialog"`
on JS-built dialogs.

Compounding this: `templates/erp/partials/*` contain **246 inline `onclick=`
handlers**, and the JS modules add several hundred more inside template literals.
`onclick` on a non-interactive element (`<div>`, `<td>`, `<span>`) produces a
control that is unreachable by keyboard and has no role. The dashboard KPI cards
do this correctly (`dashboard.html:29` — `role="button" tabindex="0"`), proving
the team knows the pattern; it just is not applied in generated markup.

**Expected behaviour.** Render interactive elements as `<button>`/`<a>`. Replace
`onclick` attributes with delegated listeners on a container (the codebase
already has the right pattern in `core.js:1611-1619`'s `data-action` dispatcher —
extend it rather than inventing something new).

**Effort** L — but largely absorbed if table/row rendering is centralised into
the DataTable component. **Depends on** `COMPONENT_LIBRARY_PLAN.md`

---

## A11Y-006 · Sidebar declares `role="tablist"` without APG keyboard behaviour
**Location** `templates/erp/index.html:270-295` · **WCAG** 2.1.1 (A) · **Severity** High · **Priority** P1

**Description.** The sidebar is marked up as `role="tablist"` with 11
`role="tab"` buttons and correct `aria-controls`/`aria-selected`. But the
WAI-ARIA Authoring Practices contract for `tablist` — which a screen reader will
announce and a user will therefore expect — requires:

- `Arrow Up/Down` (vertical tablist) to move between tabs
- `Home`/`End` to jump to first/last
- **roving `tabindex`**: exactly one tab in the tab sequence

None is implemented. All 11 buttons are separate tab stops, and arrow keys do
nothing. Declaring the role without the behaviour is **worse than using plain
navigation markup**, because it promises an interaction model that does not exist.

**Expected behaviour.** Either implement the APG pattern, or — simpler and
arguably more correct, since these are *views* not tab panels within a page —
change to `<nav aria-label="Main"><ul>` with `aria-current="page"`.
**Recommendation: use `<nav>`.** It is honest markup, less code, and matches how
users conceive of the sidebar.

**Effort** S (1 d)

---

## A11Y-007 · No status-message announcements
**WCAG** 4.1.3 (AA) · **Severity** High · **Priority** P1

**Description.** The toast container is correctly authored
(`index.html:104`: `role="alert" aria-live="assertive" aria-atomic="true"`) —
credit where due. But everything else is silent:

- **Loading**: no `aria-busy`, and only 9 loading indicators exist at all (UX-004).
  A screen-reader user switching tabs gets no signal that a fetch is running.
- **Table updates**: filtering/sorting/paginating swaps table contents with no
  live-region announcement of the new result count.
- **Async mutation outcomes** outside the toast path are unannounced.

**Expected behaviour.** `aria-busy="true"` on containers during fetch. A polite
live region announcing `"Showing 20 of 412 purchase orders"` after every filter,
sort or page change. Keep `assertive` for errors only.

**Effort** S · **Depends on** DataTable component

---

## A11Y-008 · Focus is not managed across modals and dynamic content
**WCAG** 2.4.3 (A) · **Severity** Medium · **Priority** P2

**Description.** Bootstrap handles focus trap and restore for modals it opens, so
the baseline is covered. Gaps: **15 `.focus()` calls** across the frontend, none
of which handle (a) returning focus to the triggering element after a
JS-driven close, (b) moving focus to the first error after a failed validation,
(c) focus placement after a row is deleted from a table (focus is dropped to
`<body>`), (d) announcing/moving focus on tab switch — `showTab()`
(`core.js:1387`) toggles `display` and never touches focus, so a keyboard user
who activates a sidebar tab stays parked on the sidebar with no indication the
main region changed.

**Expected behaviour.** On tab switch, move focus to the new view's `<h1>`
(`tabindex="-1"`). After deleting row *n*, focus row *n* or the table. On
validation failure, focus the first invalid field.
**Effort** S–M · **Depends on** UI-006 (inline errors)

---

## A11Y-009 · Focus indicators rely on `box-shadow` and disable `outline`
**Location** `static/erp/styles.css:1193-1197`, `:879-881`, `:1952-1956`
**WCAG** 2.4.7 (AA), 1.4.11 (AA) · **Severity** Medium · **Priority** P2

**Description.** The pattern used is:
```css
input:focus, textarea:focus, select:focus, .form-control:focus {
  outline: none;
  border-color: var(--secondary-color);
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
}
```
This is **better than the common `outline: none` with no replacement** — a
visible indicator is provided. Two real problems remain:

1. **Windows High Contrast / `forced-colors` mode strips `box-shadow`.** With
   `outline: none` also applied, those users get **no focus indicator at all**.
   This is a hard AA failure in that mode.
2. **`rgba(99,102,241,0.15)` is a 15%-opacity ring** — against white that is
   roughly a 1.1:1 change, far below the 3:1 required by 1.4.11 for non-text
   UI indicators.

Also note `styles.css:879-881` applies the *same* treatment to `:hover` and
`:focus-visible`, making focus and hover visually indistinguishable.

**Expected behaviour.**
```css
:focus-visible {
  outline: 2px solid var(--focus-ring);   /* ≥3:1 against both surfaces */
  outline-offset: 2px;
}
@media (forced-colors: active) {
  :focus-visible { outline: 2px solid Highlight; }
}
```
Use `outline` (which `forced-colors` preserves), not `box-shadow`. Keep the
box-shadow as an additional decorative layer if desired.
**Effort** S (< 1 d)

---

## A11Y-010 · No automated accessibility testing in CI
**Severity** High (process) · **Priority** P1

There is a frontend test setup (`npm test`, 5 files under `static/erp/tests/`)
but no accessibility assertion anywhere. Without a gate, every finding here
regresses.

**Recommendation.** Add `axe-core` + `jest-axe` to the existing suite, asserting
zero violations on each rendered view; add `pa11y-ci` against `/erp` and
`/auth/login`. Fail the build on new violations, with a baseline snapshot so
existing debt does not block work. **Effort** S (1–2 d) · **Highest
value-per-hour item in this report.**

---

## A11Y-011 · Touch targets meet 2.5.5 on mobile but not 2.5.8 everywhere
**Location** `static/erp/styles.css:2778-2780` · **WCAG** 2.5.8 (AA, new in 2.2)
**Severity** Low · **Priority** P3

`.btn-action { min-height: 44px; }` inside `@media (max-width: 768px)` is
**correct and well-commented** — the team explicitly cites WCAG 2.5.5. Two gaps:
(1) it sets `min-height` only, not `min-width`, so a narrow icon-only action
button can still be under 24×24 CSS px horizontally; (2) WCAG 2.2's new
**2.5.8 (Minimum, 24×24)** applies at *all* viewports, including desktop, where
`.btn-sm` action buttons and table row checkboxes are currently smaller.

**Expected behaviour.** `min-block-size: 44px; min-inline-size: 44px` on mobile;
a global floor of 24×24 with adequate spacing on desktop.
**Effort** S

---

## A11Y-012 · No programmatic error identification on forms
**WCAG** 3.3.1 (A), 3.3.3 (AA) · **Severity** High · **Priority** P1

**Description.** Templates contain **184 `<input>` and 37 `<select>`** elements
against **133 `<label>`** — a shortfall of ~88 controls with no `<label>` in the
partials (some are covered by `aria-label`, but 53 `aria-label` attributes across
*all* templates cannot close a gap that size). Beyond labelling: no
`aria-invalid`, no `aria-describedby` linking a field to its error, and no inline
error placement — validation failures surface only as a global toast (UI-006)
that auto-dismisses in 3 seconds.

For a data-entry-heavy ERP this is the accessibility finding with the largest
day-to-day cost.

**Expected behaviour.** Every control has a programmatic label. On validation
failure: set `aria-invalid="true"`, render the message in an element referenced
by `aria-describedby`, place it adjacent to the field, focus the first error, and
announce a summary in a live region.
**Effort** M · **Depends on** UI-006, Form Field component

---

## Remediation order

| Order | Findings | Effort | Rationale |
|---|---|---|---|
| 1 | A11Y-002 (contrast), A11Y-009 (focus ring) | ~1.5 d | Token-only; zero structural risk; fixes every screen at once |
| 2 | A11Y-010 (axe in CI) | 1–2 d | Prevents regression of everything below |
| 3 | A11Y-001 (`scope`), A11Y-004 (icon labels), A11Y-006 (`<nav>`) | ~4 d | Mechanical, high impact |
| 4 | A11Y-003 (headings), A11Y-011 (targets) | ~3 d | Needs the type scale |
| 5 | A11Y-005, A11Y-007, A11Y-008, A11Y-012 | 3–4 wk | Absorbed into the component library work |

Items 1–3 (~1.5 weeks) move the product from *six* Level-A/AA failures to *two*.
