# Responsive Design Review — Phase 5

Scope: `static/erp/styles.css` (2,912 ln), `static/erp/mobile_styles.css` (857 ln),
`templates/erp/**`. Method: static analysis of breakpoints, layout primitives and
per-component behaviour.

> **Caveat.** No device-lab or emulator run was performed. Findings are those
> provable from the stylesheets and markup. Recommendation RES-007 addresses the
> missing verification loop.

---

## Breakpoint inventory

The desktop stylesheet defines **exactly two** responsive breakpoints:

| Breakpoint | Location | Purpose |
|---|---|---|
| `@media (max-width: 768px)` | `styles.css:2670` | Tablet/phone: off-canvas sidebar, 16px inputs, 44px targets |
| `@media (max-width: 576px)` | `styles.css:2803` | Phone: toolbar stacking, header compaction |
| `@media (prefers-reduced-motion: reduce)` | `styles.css:2906` | Motion (not layout) |
| `@media print` | `styles.css:2505` | Print visibility switches |

Bootstrap 5.3's grid supplies `sm/md/lg/xl/xxl` where utility classes are used
(e.g. `row-cols-2 row-cols-lg-4` on the dashboard KPI grid,
`dashboard.html:27`), so the effective coverage is better than two breakpoints
suggests. But **all custom component styling** collapses to two.

**Notably absent:** any `min-width` breakpoint above 768px. There is no
large-desktop or ultra-wide treatment at all.

---

## Findings

| ID | Title | Severity | Priority |
|---|---|---|---|
| RES-001 | Data tables have no small-screen strategy on desktop shell | Critical | P0 |
| RES-002 | No ultra-wide / large-desktop layout — content stretches unbounded | High | P1 |
| RES-003 | Two hard breakpoints; no container queries for embedded components | Medium | P2 |
| RES-004 | Desktop and mobile are separate applications, not one responsive app | High | P1 (strategic) |
| RES-005 | Header wraps to 3+ rows on phones, consuming the viewport | Medium | P2 |
| RES-006 | Print stylesheet assumes A4 portrait only | Low | P3 |
| RES-007 | No responsive regression testing | Medium | P2 |

---

## RES-001 · Data tables have no small-screen strategy in the desktop shell
**Location** `styles.css:2755-2759`; all 75 tables in `templates/erp/partials/*`
**Severity** Critical · **Priority** P0

**Description.** The only responsive treatment applied to tables is:
```css
@media (max-width: 768px) {
  table th, table td { padding: 8px; font-size: 12px; }
}
```
That is a *density* change, not a *layout* change. A 12-column Purchase Order
table at 12px font still requires roughly 900–1100 CSS px. On a 390px phone
viewport the table either overflows the page horizontally or is squeezed to
illegibility, depending on whether an ancestor provides `overflow-x`.

**Current behaviour.** Horizontal page scroll on phones and small tablets, which
breaks the sticky header (`index.html:175`) and makes the sidebar backdrop
misalign.

**Expected behaviour.** Three complementary techniques, in priority order:
1. **Wrap every table** in `.table-scroll { overflow-x: auto; }` with
   `-webkit-overflow-scrolling: touch` — the immediate, safe fix. The codebase
   already uses this exact pattern successfully for `.nav-pills`
   (`styles.css:2843-2848`).
2. **Sticky first column** (`position: sticky; left: 0`) so the row identifier
   (PO Number / Item Name) stays visible while scrolling columns.
3. **Card layout below 576px** — collapse each row to a stacked card with
   label/value pairs. This is what the mobile PWA already does well; the pattern
   can be shared.

The mitigating factor is RES-004: phone users are steered to `/erp/mobile` by the
banner at `index.html:66-100`. But that banner is dismissible, only fires below
768px, and never fires for the 768–1024px tablet band where these tables are
*also* unusable.

**UX impact** The primary data surface is unusable on the device class most
likely to be used away from a desk. **Business impact** Tablet users on the
factory floor cannot consult ledgers. **Effort** S for (1) — a single wrapper
class, done once in the DataTable component. M for (2)+(3).
**Depends on** `COMPONENT_LIBRARY_PLAN.md` §DataTable

---

## RES-002 · No ultra-wide or large-desktop layout
**Severity** High · **Priority** P1

**Description.** There is no `min-width` media query anywhere in
`styles.css`. The shell uses Bootstrap's `.container-fluid`
(`index.html:171`), which is 100% width with no maximum. On a 2560px or 3440px
ultra-wide monitor:

- Table rows stretch the full width, so the eye must travel the entire display
  between the row identifier and the action buttons — a well-documented
  scanning-accuracy problem at long line lengths.
- Form fields inside modals inherit the same unbounded width, producing
  single-line inputs hundreds of pixels wide for two-character quantity values.
- The dashboard KPI grid caps at `row-cols-lg-4` (`dashboard.html:27`), so on a
  3440px display four cards are stretched enormously wide instead of showing
  six or eight at a sensible size.

This matters specifically for this product: ERP users are desk-bound
professionals, and large/ultra-wide monitors are the norm in that population.
The application currently *punishes* better hardware.

**Expected behaviour.**
- `max-width` on reading-oriented containers (~1600px) with the surplus used for
  a persistent detail panel rather than stretched rows.
- `@media (min-width: 1600px)` raising KPI grid density and enabling a
  **master–detail split view** (list left, selected record right) — this
  eliminates the modal round trip for the most common inspect action and is the
  single best use of a wide viewport in an ERP.
- Cap form control widths by input type (`.field-qty { max-width: 8ch }`).

**UX impact** Turns wasted pixels into reduced clicks. **Effort** M (1 wk for
containment + KPI density; split view is a larger, separate initiative).

---

## RES-003 · Two hard breakpoints, no container queries
**Severity** Medium · **Priority** P2

**Description.** Everything responds to *viewport* width. But this app's layout
has a collapsible sidebar (`.app-sidebar.collapsed`, `styles.css:2700`), so the
content column's actual width varies independently of the viewport: at 1200px
viewport the content area is ~940px with the sidebar open and ~1150px collapsed.
Components inside it cannot know which.

The same problem affects components rendered inside modals — a table in a
`.modal-xl` has a very different available width than the same table in the main
content column, yet both are styled by the same viewport-keyed rules.

**Expected behaviour.** Container queries for component-level responsiveness:
```css
.table-container { container-type: inline-size; }
@container (max-width: 700px) { .data-table { /* card layout */ } }
```
Baseline-available in all current browsers. Keep viewport media queries for
page-level layout (sidebar drawer), use container queries for components.

**Effort** M · **Depends on** component library · **Affects** tables, forms, KPI cards

---

## RES-004 · Desktop and mobile are separate applications
**Severity** High (strategic) · **Priority** P1 — *decide, don't necessarily change*

**Description.** The product maintains two parallel front ends:

| | Desktop | Mobile |
|---|---|---|
| Shell | `templates/erp/index.html` (354 ln) | `templates/erp/mobile.html` (100 ln) + `partials/mobile_views.html` (422 ln) |
| Script | 17 files, 24,920 ln, 1.10 MiB | `mobile.js`, 3,396 ln |
| Styles | `styles.css`, 2,912 ln | `mobile_styles.css`, 857 ln |
| Service worker | `sw.js`, 102 ln | `mobile-sw.js`, 147 ln |
| Manifest | `manifest.json` | `manifest-mobile.json` |
| Routing | `/erp` | `/erp/mobile`, opt-in via `?ui=mobile` banner |

**This is a legitimate architecture**, and the code shows it was chosen
deliberately — `pages.py:67-75` explains the separate service worker, and the
mobile PWA's offline outbox is genuinely specialised for shop-floor use. Adaptive
delivery beats responsive design when the two contexts have genuinely different
tasks, which here they do (data entry at a bench vs. analysis at a desk).

**The problem is not the split; it is that the split is unmanaged:**
1. **No shared component or token layer.** Both re-implement tables, cards,
   badges, buttons, empty states from scratch in different visual languages.
2. **Feature parity is undefined.** Nothing documents which of the 11 desktop
   modules exist on mobile, so drift is invisible.
3. **The 768–1024px tablet band belongs to neither.** The mobile banner fires
   below 768px only; above it users get the desktop shell whose tables need
   ~1000px (RES-001). Tablets are the worst-served device class.
4. **Switching is one-way friction.** `?ui=mobile` is offered by a dismissible
   banner; there is no persistent, discoverable switch in either direction.

**Expected behaviour.** Keep two shells. Add: a shared token + primitive layer
(`DESIGN_SYSTEM.md`); a documented parity matrix; an explicit tablet decision
(recommendation: serve the desktop shell with RES-001's table fixes applied);
and a persistent shell switcher in both headers.

**Effort** M for the shared layer · **Business impact** Halves the marginal cost
of every future feature that must exist on both surfaces.

---

## RES-005 · Header wraps to multiple rows on phones
**Location** `styles.css:2788-2791`, `index.html:174-263` · **Severity** Medium · **Priority** P2

**Description.** The header holds ~11 controls in one flex row (see
`UI_UX_AUDIT.md` UI-004). The phone treatment is:
```css
@media (max-width: 768px) { .app-header { flex-wrap: wrap; row-gap: 10px; } }
```
Wrapping, not prioritising. On a 390px viewport the brand block, four
master-data buttons, logo controls, theme toggle, bell and company badge cannot
fit in fewer than three rows — an estimated 140–160px of a ~660px usable
viewport, **before the mobile-switch banner** (`index.html:66`, `position: sticky`)
adds ~44px more. Roughly 30% of the phone viewport is chrome.

Mitigations already present and working: labels hide via `d-none d-md-inline`
(`index.html:195`), and `h4 "ERP System"` hides via `d-none d-md-block`.

**Expected behaviour.** Below 768px the header keeps only: menu toggle, brand
mark, search, bell, overflow `⋮`. Everything else moves into the overflow menu.
Resolved permanently by UI-004 (move master-data to Settings).
**Effort** S · **Depends on** UI-004

---

## RES-006 · Print stylesheet assumes A4 portrait
**Location** `styles.css:2434-2560`, `templates/erp/partials/print.html` (1,181 ln, 414 inline styles)
**Severity** Low · **Priority** P3

The print architecture is **deliberately and correctly designed** — `styles.css:2460`
documents that html2canvas never applies `@media print`, so print layout is
owned by inline styles in `print.html` and `@media print` handles visibility
switches only. `index.html:317-321` explains why print containers sit outside
`#app-container`. This is sound and should not be disturbed.

Gap: no `@page { size: … }` declaration and no landscape variant. Wide documents
(a 12-column Production Sheet, a dispatch manifest) will clip or shrink on A4
portrait, and there is no US-Letter consideration.

**Expected behaviour.** `@page { size: A4 portrait; margin: 12mm }` as default,
with a `.print-landscape` variant applying `@page { size: A4 landscape }` for
wide documents. **Effort** S

---

## RES-007 · No responsive regression testing
**Severity** Medium · **Priority** P2

Five frontend tests exist (`static/erp/tests/`), none exercising layout. No
visual-regression tooling, no viewport-matrix test, no CI check.

**Expected behaviour.** Playwright with a device matrix
(390×844 phone · 820×1180 tablet portrait · 1366×768 laptop · 1920×1080 desktop ·
3440×1440 ultra-wide), asserting per viewport: no horizontal document scroll,
sidebar in the correct mode, header row count within budget, no element
overflowing its container. Add screenshot diffing for the 11 tab views.
**Effort** M (3–5 d) · **Prevents regression of every finding above.**

---

## Device-class assessment

| Device class | Viewport | Current state | Blocking findings |
|---|---|---|---|
| Ultra-wide | ≥2560px | ⚠️ Functional, wasteful | RES-002 |
| Desktop | 1440–1920px | ✅ **Good** — the design target | — |
| Laptop | 1280–1440px | ✅ Good | — |
| Small laptop | 1024–1280px | ⚠️ Tables tight with sidebar open | RES-001, RES-003 |
| Tablet landscape | 1024×768 | ⚠️ Tables overflow | RES-001 |
| **Tablet portrait** | **820×1180** | ❌ **Worst-served** — desktop tables, no mobile shell | RES-001, RES-004 |
| Phone (desktop shell) | 390×844 | ❌ Unusable for tables | RES-001, RES-005 |
| Phone (mobile PWA) | 390×844 | ✅ **Good** — purpose-built | — |
| Phone landscape | 844×390 | ✅ Handled — `100dvh` fix at `styles.css:2752` | — |

**Headline:** the product is strong at its design target (desktop) and at its
purpose-built mobile PWA, and weak in the band between them. **Tablet portrait
is the single largest gap** — it receives the desktop shell without qualifying
for the mobile banner.

## Recommended order

1. **RES-001 step 1** — wrap all tables in `overflow-x: auto`. Hours of work,
   removes the worst failure on three device classes.
2. **RES-004 tablet decision** — extend the mobile banner to ≤1024px, *or*
   commit to fixing desktop tables for tablet. Do not leave it undecided.
3. **RES-007** — Playwright viewport matrix, before further layout change.
4. **RES-005 / UI-004** — header simplification.
5. **RES-002** — ultra-wide containment and KPI density.
6. **RES-003** — container queries, alongside the component library.
