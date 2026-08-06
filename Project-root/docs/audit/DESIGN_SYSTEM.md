# Design System — Phase 7

Assessment of the current token layer, and the specification for a unified one.

---

## 1. Current state

### Does a design system exist?

**Partially — three of them, unaware of each other.**

| Surface | Stylesheet | Lines | Primary | Tokens | Spacing scale | Type scale | Elevation |
|---|---|---:|---|---|:---:|:---:|:---:|
| Auth pages | `static/styles.css` + `static/css/login.css` | 3,060 | `#6366F1` | ~20 colour vars | ❌ | ❌ | ❌ |
| Desktop ERP | `static/erp/styles.css` | 2,912 | `#0f172a` | 37 vars | ❌ | ❌ | ✅ 3 |
| Mobile PWA | `static/erp/mobile_styles.css` | 857 | `#ff6a13` | ~30 vars | ✅ 8 steps | ✅ 2 families | ✅ |

**The mobile stylesheet is the best-designed of the three** and should be the
basis for the unified system, not the one that gets replaced.

### Token audit — desktop (`styles.css:27-100`)

| Category | Present | Count | Gap |
|---|---|---:|---|
| Colour — brand | `--primary-*`, `--secondary-*` (3 each) | 6 | No semantic surface/content separation |
| Colour — status | `--success/warning/danger/info-color` | 4 | Single value each; no `-bg`/`-border`/`-text` variants |
| Colour — text | `--text-primary/secondary/muted` | 3 | **`--text-muted` fails AA at 2.56:1** |
| Colour — surface | `--bg-color/light/muted` | 3 | No elevated-surface distinction |
| Colour — border | `--border-color/light` | 2 | No focus-ring token |
| Elevation | `--shadow-sm/md/lg` | 3 | No `xl`; no dark-mode-aware inset |
| Radius | `--border-radius`, `-sm`, `-lg` | 3 | No `full` for pills/avatars |
| Motion | `--transition-fast/base/slow` | 3 | Durations only, no easing tokens |
| **Spacing** | — | **0** | **Missing entirely** |
| **Typography** | — | **0** | **Missing entirely** |
| **Z-index** | — | **0** | Hard-coded: 1000, 1070, 1080, 1090, 1100, 2000 |
| Breakpoints | — | 0 | Hard-coded 768px / 576px |

**37 tokens total; two whole categories absent.** The consequence is visible in
the measurements: **1,391 inline `style=` declarations** and **143 `!important`
rules** exist largely because there was no token to reach for.

### Dark mode

Implemented via `[data-theme="dark"]` (`styles.css:72-100`) with a pre-paint
flash guard (`index.html:30-38`) — **good**. Weakness: 20+ subsequent rules
patch individual components with `!important` (`:107-180`) rather than the
override falling out of the token layer. That is a direct consequence of the
inline styles at `index.html:175` which no selector can beat.

### Component inventory

| Component | Status | Source |
|---|---|---|
| Button | ⚠️ Bootstrap + ad-hoc overrides | `.btn-action`, inline styles |
| Input / Select | ⚠️ Bootstrap + Select2 (needs jQuery) | — |
| Table | ❌ **No component** — 75 hand-built tables | templates + `innerHTML` |
| Modal | ⚠️ Bootstrap; 3 bespoke instances in shell | `index.html:112-168` |
| Toast | ✅ Single shared instance, correct ARIA | `index.html:103-110` |
| Notification panel | ✅ Purpose-built, good | `index.html:239-256`, `styles.css:875+` |
| Badge | ⚠️ Bootstrap utilities inline | — |
| Card | ⚠️ Bootstrap + `.dash-kpi-card` | `dashboard.html:29` |
| Multiselect | ✅ Bespoke `.po-multiselect-*` | `styles.css:1952+` |
| Pagination | ❌ Re-implemented per module × 11 | `core.js` state |
| Empty state | ❌ 25 ad-hoc strings, no component | `static/erp/*.js` |
| Skeleton / loading | ❌ **9 total across 24,920 lines** | — |
| Chart | ❌ None (Chart.js in CSP allowlist, unused) | — |
| Tabs / Nav | ⚠️ `role="tablist"` without APG behaviour | `index.html:270` |

**Verdict: a token layer exists; a component layer does not.** Bootstrap 5.3 is
serving as the de facto component library, extended by inline styles.

---

## 2. Target architecture

```
static/design/
├── tokens.css          ← primitives + semantic aliases (single source of truth)
├── themes.css          ← [data-theme="light"|"dark"|"workshop"]
├── base.css            ← reset, element defaults, focus, forced-colors
├── primitives.css      ← .stack .cluster .grid .scroll-x layout utilities
└── components/         ← one file per component (see COMPONENT_LIBRARY_PLAN.md)
```

Load order: `tokens → themes → base → primitives → components → surface overrides`.
All three shells (`index.html`, `mobile.html`, auth) consume the same first five.

**Principle: primitives are numeric and meaningless; semantic tokens carry
intent. Components reference only semantic tokens.** This is what makes theming
possible without `!important`.

---

## 3. Token specification

### 3.1 Colour primitives

```css
:root {
  /* Neutral — slate ramp, retains the current desktop identity */
  --c-neutral-0:   #ffffff;  --c-neutral-50:  #f8fafc;
  --c-neutral-100: #f1f5f9;  --c-neutral-200: #e2e8f0;
  --c-neutral-300: #cbd5e1;  --c-neutral-400: #94a3b8;
  --c-neutral-500: #64748b;  --c-neutral-600: #475569;
  --c-neutral-700: #334155;  --c-neutral-800: #1e293b;
  --c-neutral-900: #0f172a;  --c-neutral-950: #020617;

  /* Brand — indigo, darkened so white text reaches AA (was #6366f1 @ 4.47:1) */
  --c-brand-400: #818cf8;  --c-brand-500: #6366f1;
  --c-brand-600: #4f46e5;  /* 5.85:1 on white — the on-white default */
  --c-brand-700: #4338ca;

  /* Status — every value below verified ≥4.5:1 with white text */
  --c-success-600: #15803d;  --c-success-100: #dcfce7;
  --c-danger-600:  #dc2626;  --c-danger-100:  #fee2e2;
  --c-warning-600: #b45309;  --c-warning-100: #fef3c7;
  --c-warning-400: #f59e0b;  /* FILL ONLY — never a text background */
  --c-info-600:    #0e7490;  --c-info-100:    #cffafe;

  /* Workshop accent — the mobile PWA's safety orange, preserved */
  --c-safety-500: #ff6a13;  --c-safety-600: #d6540a;  --c-safety-100: #ffe7d6;
}
```

### 3.2 Semantic aliases — the layer components use

```css
:root {
  /* Surfaces */
  --surface-base:      var(--c-neutral-50);
  --surface-raised:    var(--c-neutral-0);
  --surface-sunken:    var(--c-neutral-100);
  --surface-overlay:   var(--c-neutral-0);
  --surface-inverse:   var(--c-neutral-900);

  /* Content — all AA-verified against --surface-raised */
  --content-primary:   var(--c-neutral-800);  /* 13.6:1 */
  --content-secondary: var(--c-neutral-500);  /*  4.76:1 */
  --content-muted:     var(--c-neutral-500);  /*  4.76:1 — was #94a3b8 @ 2.56:1 */
  --content-inverse:   var(--c-neutral-0);
  --content-brand:     var(--c-brand-600);
  --content-danger:    var(--c-danger-600);

  /* Borders */
  --border-subtle:     var(--c-neutral-200);
  --border-default:    var(--c-neutral-300);
  --border-strong:     var(--c-neutral-400);

  /* Interactive */
  --action-primary-bg:       var(--c-brand-600);
  --action-primary-fg:       var(--c-neutral-0);
  --action-primary-bg-hover: var(--c-brand-700);
  --action-danger-bg:        var(--c-danger-600);
  --action-danger-fg:        var(--c-neutral-0);

  /* Focus — ≥3:1 against both surface-base and surface-raised (WCAG 1.4.11) */
  --focus-ring:        var(--c-brand-600);
  --focus-ring-width:  2px;
  --focus-ring-offset: 2px;
}
```

**Every value above was contrast-verified.** See `ACCESSIBILITY_REPORT.md`
A11Y-002 for the failing values these replace.

### 3.3 Spacing scale — *currently missing*

Adopt the mobile stylesheet's scale, extended. 4px base, matching Bootstrap's
spacers so the two coexist during migration.

```css
:root {
  --sp-0: 0;      --sp-1: 4px;    --sp-2: 8px;    --sp-3: 12px;
  --sp-4: 16px;   --sp-5: 20px;   --sp-6: 24px;   --sp-7: 32px;
  --sp-8: 40px;   --sp-9: 48px;   --sp-10: 64px;  --sp-11: 80px;

  /* Density — the single most valuable ERP-specific token.
     Lets users switch table row height without touching component CSS. */
  --density-row-y:  var(--sp-3);   /* comfortable (default) */
  --density-cell-x: var(--sp-4);
}
[data-density="compact"] { --density-row-y: var(--sp-2); --density-cell-x: var(--sp-3); }
[data-density="dense"]   { --density-row-y: var(--sp-1); --density-cell-x: var(--sp-2); }
```

A **density switch** is the highest-value delight feature specific to this
product class — power users scanning ledgers all day want more rows per screen;
occasional users want breathing room. It costs one attribute on `<html>`.

### 3.4 Typography scale — *currently missing*

Retains the existing Inter (body) / Outfit (display) pairing.

```css
:root {
  --font-body:    'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-display: 'Outfit', 'Inter', sans-serif;
  --font-mono:    ui-monospace, 'SF Mono', 'Cascadia Mono', monospace;

  --fs-xs:   0.75rem;   --lh-xs:   1rem;      /* 12/16 — table dense, captions */
  --fs-sm:   0.8125rem; --lh-sm:   1.125rem;  /* 13/18 — table default */
  --fs-base: 0.875rem;  --lh-base: 1.25rem;   /* 14/20 — body, form controls  */
  --fs-md:   1rem;      --lh-md:   1.5rem;    /* 16/24 — mobile inputs (iOS)  */
  --fs-lg:   1.125rem;  --lh-lg:   1.625rem;  /* 18/26 — card titles          */
  --fs-xl:   1.25rem;   --lh-xl:   1.75rem;   /* 20/28 — section headings     */
  --fs-2xl:  1.5rem;    --lh-2xl:  2rem;      /* 24/32 — page title           */

  --fw-normal: 400; --fw-medium: 500; --fw-semibold: 600; --fw-bold: 700;

  --tracking-tight:  -0.02em;   /* display */
  --tracking-normal:  0;
  --tracking-numeric: 0.01em;   /* tabular figures */
}

/* Numeric columns must use tabular figures — digits align across rows,
   which matters in every quantity and currency column in this product. */
.numeric, td.numeric, .kpi-value {
  font-variant-numeric: tabular-nums;
  letter-spacing: var(--tracking-numeric);
  text-align: right;
}
```

**Critical rule:** heading *level* and heading *size* are decoupled. Use
`.text-lg` for visual weight; never reach for `<h5>` to get small bold text.
This is what caused `ACCESSIBILITY_REPORT.md` A11Y-003 (108 `<h5>`/`<h6>` vs 12
`<h2>`, zero `<h3>`).

### 3.5 Elevation, radius, motion, z-index

```css
:root {
  --elev-0: none;
  --elev-1: 0 1px 2px rgba(15,23,42,.06), 0 1px 3px rgba(15,23,42,.10);
  --elev-2: 0 2px 4px rgba(15,23,42,.06), 0 4px 12px rgba(15,23,42,.08);
  --elev-3: 0 4px 8px rgba(15,23,42,.06), 0 8px 24px rgba(15,23,42,.12);
  --elev-4: 0 8px 16px rgba(15,23,42,.08), 0 16px 48px rgba(15,23,42,.16);

  --radius-sm: 4px;  --radius-md: 8px;  --radius-lg: 12px;
  --radius-xl: 16px; --radius-full: 9999px;

  --dur-instant: 100ms; --dur-fast: 150ms;
  --dur-base:    250ms; --dur-slow: 350ms;
  --ease-out:      cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in-out:   cubic-bezier(0.65, 0, 0.35, 1);
  --ease-spring:   cubic-bezier(0.34, 1.56, 0.64, 1);

  /* Replaces the hard-coded 1000/1070/1080/1090/1100/2000 found in the source */
  --z-base: 0;        --z-sticky: 100;   --z-dropdown: 200;
  --z-sidebar: 300;   --z-backdrop: 400; --z-modal: 500;
  --z-popover: 600;   --z-toast: 700;    --z-tooltip: 800;
}
```

### 3.6 Breakpoints

```css
/* Custom properties cannot be used in media queries — declare as constants
   in one place and reference them by comment. Use container queries for
   component-level response (see RESPONSIVE_REVIEW.md RES-003). */
/* --bp-sm: 576px  --bp-md: 768px  --bp-lg: 1024px
   --bp-xl: 1280px --bp-2xl: 1600px --bp-3xl: 1920px */
```

`--bp-2xl` and `--bp-3xl` are new — the current stylesheet has no `min-width`
query at all (`RESPONSIVE_REVIEW.md` RES-002).

---

## 4. Themes

Three themes, one token contract. Only the semantic aliases are overridden;
components never change.

```css
[data-theme="dark"] {
  --surface-base:      #0d1117;
  --surface-raised:    #161b27;
  --surface-sunken:    #0a0e14;
  --content-primary:   #e2e8f0;   /* 13.1:1 on raised */
  --content-secondary: #94a3b8;   /*  6.71:1 */
  --content-muted:     #8b9cb3;   /*  5.6:1 — was #6e8299 @ 4.36:1 */
  --border-subtle:     #253044;
  --action-primary-bg: var(--c-brand-500);   /* lighter for dark surfaces */
  --focus-ring:        #a5b4fc;   /* ≥3:1 on dark */
}

/* Workshop — the mobile PWA identity, preserved as a theme rather than a fork */
[data-theme="workshop"] {
  --surface-base:      #f3f5f6;
  --content-primary:   #14181c;
  --action-primary-bg: var(--c-safety-600);
  --font-display:      'Oswald', 'Arial Narrow', sans-serif;
  --density-row-y:     var(--sp-4);   /* larger touch targets on the floor */
}
```

Add `@media (prefers-color-scheme: dark)` as the default when no explicit
preference is stored — currently only an explicit `localStorage` value activates
dark mode (`index.html:33`), so users with a system dark preference get light.

### Forced-colors support

```css
@media (forced-colors: active) {
  :focus-visible { outline: 2px solid Highlight; outline-offset: 2px; }
  .btn, .card, .table-container { border: 1px solid CanvasText; }
}
```
Required because the current focus treatment uses `box-shadow` with
`outline: none`, which forced-colors mode strips entirely
(`ACCESSIBILITY_REPORT.md` A11Y-009).

---

## 5. Migration strategy

**Non-negotiable constraint: no visual regression during migration.** This is a
production ERP; users must not arrive to a changed interface mid-refactor.

### Stage 0 — Establish the layer (1 week, zero visual change)
1. Create `tokens.css` with the full set above.
2. **Alias the existing token names to the new ones** so nothing breaks:
   ```css
   :root {
     --primary-color:   var(--c-neutral-900);
     --secondary-color: var(--c-brand-600);   /* ← contrast fix lands here */
     --text-muted:      var(--content-muted); /* ← contrast fix lands here */
     --bg-light:        var(--surface-raised);
   }
   ```
   Existing rules keep working; the accessibility fixes ship inside this step.
3. Load `tokens.css` before `styles.css` in all three shells.
4. Add a Playwright screenshot baseline of the 11 tabs **before** this stage.

### Stage 1 — Accessibility corrections (2 days)
Apply the AA-compliant values (§3.1/3.2) and the `:focus-visible` rule (§4).
This is the only stage with *intentional* visual change, and it is small,
justified, and independently valuable. Ship it separately so it can be reverted
in isolation if a component depended on a failing colour.

### Stage 2 — Delete inline styles, per view (4–6 weeks)
One tab per PR, in ascending complexity: Vendors (33 inline) → Contractors (22)
→ Dashboard (10) → Items (47) → Stock (54) → Returns (57) → Clients (59) →
Products (63) → Production (83). **Skip `print.html`'s 414** — those are
correct and documented (`styles.css:2460`).

Each PR: replace inline styles with component classes, delete the now-dead
`!important` overrides, verify against the screenshot baseline.

**Track two metrics per PR:** inline-style count (target 977 → <100) and
`!important` count (target 143 → <20).

### Stage 3 — Unify auth and mobile (2 weeks)
Re-express `static/styles.css` and `mobile_styles.css` as token consumers.
Expect `static/styles.css` to shrink from 2,646 lines to a few hundred.

### Stage 4 — Component library (see `COMPONENT_LIBRARY_PLAN.md`)

---

## 6. Governance

Without enforcement this regresses. Minimum viable governance:

| Control | Tool | Gate |
|---|---|---|
| No raw hex outside `tokens.css` | Stylelint `color-no-hex` | CI fail |
| No `!important` in new CSS | Stylelint `declaration-no-important` | CI warn → fail at <20 |
| No inline `style=` in new templates/JS | Custom lint | CI fail |
| Contrast verification | `axe-core` in the existing `npm test` | CI fail |
| Visual regression | Playwright screenshots, 11 tabs × 3 themes | CI review |
| Bundle budget | CSS ≤ 60 KB gz | CI fail |

**Living documentation.** A single `/design` route rendering every component in
every state and theme, generated from the component CSS. Cheaper than Storybook
for a no-framework codebase, and it doubles as the accessibility test target.

---

## 7. Summary

| Dimension | Now | Target |
|---|---|---|
| Design systems | 3 divergent | 1 + 3 themes |
| Tokens | 37 (desktop) | ~120, semantically layered |
| Spacing scale | ❌ | ✅ 12 steps + density modes |
| Type scale | ❌ | ✅ 7 sizes, level/size decoupled |
| Z-index scale | ❌ (6 hard-coded) | ✅ 9 named layers |
| Contrast AA | ❌ 8 token pairs fail | ✅ all verified |
| Inline styles | 1,391 (977 avoidable) | < 100 |
| `!important` | 143 | < 20 |
| Components | 0 formal | 18 (see component plan) |
| Governance | none | 6 automated gates |
