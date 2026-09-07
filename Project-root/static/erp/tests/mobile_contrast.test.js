/**
 * Every text/background pair MApp actually renders must clear WCAG AA
 * (Phase 0).
 *
 * The app's own stylesheet header says it is "designed for factory-floor
 * conditions: sunlight glare, dusty/gloved hands" -- and glare makes
 * contrast requirements stricter, not looser. Before this pass, the pair on
 * the control an operator taps most (white on safety orange, on both FABs
 * and every primary button) measured 2.87:1 against a 4.5:1 requirement.
 *
 * These ratios are computed from the tokens as declared in
 * mobile_styles.css, so the test fails if someone edits a token back to a
 * value that no longer passes -- which a screenshot review would not catch.
 *
 * Note on the 4.5 threshold: WCAG's 3.0:1 large-text allowance starts at
 * 18.66px bold / 24px regular. The FAB label is 15px bold and the primary
 * button 16px bold, so both are NORMAL text and need 4.5:1. The status
 * chips are 12px bold. None of these qualify for the relaxed threshold.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'mobile_styles.css'), 'utf8');

/** Reads a custom property's value straight out of the :root block. */
// The dark theme redefines a subset of the same tokens, so each theme is
// read from its own block: the light `:root` (everything before the
// prefers-color-scheme block) and the dark block itself. Reading the file
// as one string would silently pick whichever definition came first.
const DARK_BLOCK = (() => {
  const at = CSS.indexOf('@media (prefers-color-scheme: dark)');
  if (at === -1) throw new Error('no dark theme block in mobile_styles.css');
  return CSS.slice(at, CSS.indexOf('\n}', CSS.indexOf('--mb-shadow-fab', at)));
})();
const LIGHT_BLOCK = CSS.slice(0, CSS.indexOf('@media (prefers-color-scheme: dark)'));

// Resolves `--a: var(--b)` chains, which is how the -ink text roles are
// declared in light (they equal their fill until dark splits them).
function readToken(block, name, depth = 0) {
  if (depth > 5) throw new Error(`token --${name} loops`);
  const m = block.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!m) return null;
  const value = m[1].trim();
  const ref = value.match(/^var\(\s*--([\w-]+)\s*\)$/);
  if (ref) return readToken(block, ref[1], depth + 1) || readToken(LIGHT_BLOCK, ref[1], depth + 1);
  return /^#[0-9a-fA-F]{3,8}$/.test(value) ? value : null;
}

function token(name) {
  const v = readToken(LIGHT_BLOCK, name);
  if (!v) throw new Error(`token --${name} not found in the light palette`);
  return v;
}

// Dark falls back to the light value for anything the dark block does not
// override -- exactly how the cascade resolves it in a browser.
function darkToken(name) {
  const v = readToken(DARK_BLOCK, name) || readToken(LIGHT_BLOCK, name);
  if (!v) throw new Error(`token --${name} not found in either palette`);
  return v;
}

function channel(c) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG 2.1 relative luminance. */
function luminance(hex) {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.substr(i, 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function ratio(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const WHITE = '#ffffff';
const AA_NORMAL = 4.5;

describe('MApp colour contrast (WCAG 2.1 AA, normal text)', () => {
  // [description, foreground, background]
  const pairs = () => [
    ['primary button / FAB label on safety orange', token('mb-on-safety'), token('mb-safety')],
    ['primary button label on the pressed fill', token('mb-on-safety'), token('mb-safety-dark')],
    ['active filter chip label', token('mb-on-safety'), token('mb-safety')],
    ['safety used as text on a white card', token('mb-safety-ink'), WHITE],
    ['safety used as text on the page ground', token('mb-safety-ink'), token('mb-workshop')],
    ['"Pending" chip label', WHITE, token('mb-enamel-amber')],
    ['"In Progress" chip label', WHITE, token('mb-enamel-blue')],
    ['"Completed" chip label', WHITE, token('mb-enamel-green')],
    ['"Cancelled" / low-stock chip label', WHITE, token('mb-enamel-red')],
    ['default chip label', WHITE, token('mb-enamel-slate')],
    ['success toast', WHITE, token('mb-enamel-green')],
    ['error toast', WHITE, token('mb-enamel-red')],
    ['offline banner', token('mb-enamel-red'), token('mb-enamel-red-bg')],
    ['card subtitles / secondary text', token('mb-steel'), token('mb-workshop')],
    ['text buttons and links', token('mb-enamel-blue'), WHITE],
    ['body text', token('mb-ink'), token('mb-workshop')],
  ];

  test.each(pairs())('%s clears AA', (_label, fg, bg) => {
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  test('safety orange is never itself used as small text on a light ground', () => {
    // The brand colour stays exactly #ff6a13 as a FILL; --mb-safety-ink is
    // the darkened variant for the handful of places it has to be text.
    // This guards the split: raw --mb-safety in a `color:` declaration is
    // the regression that reintroduces a 2.87:1 label.
    const offenders = CSS.split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => /(^|[^-])color:\s*var\(--mb-safety\)/.test(line));

    expect(offenders.map(o => `${o.n}: ${o.line}`)).toEqual([]);
  });

  test('every enamel used AS TEXT goes through its -ink role', () => {
    // The enamels do two jobs: a FILL carrying white text, and text on a
    // card. On a light ground the two values coincide, so ~20 usages --
    // most of them the red "Delete" on a list row -- were written as the
    // fill. On a dark ground that is 2.87:1 and effectively invisible.
    // A bare `color: var(--mb-enamel-X)` is that regression returning.
    const sources = {
      'mobile_styles.css': CSS,
      'mobile.js': fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8'),
    };
    const offenders = [];
    Object.entries(sources).forEach(([file, src]) => {
      src.split(/\r?\n/).forEach((line, i) => {
        if (/(^|[^-])color:\s*var\(--mb-enamel-(red|green|amber|blue|slate)\)/.test(line)) {
          offenders.push(`${file}:${i + 1}: ${line.trim().slice(0, 70)}`);
        }
      });
    });
    expect(offenders).toEqual([]);
  });

  test('the brand orange itself is unchanged', () => {
    // The fix was to flip the LABEL to ink, not to darken the brand --
    // black-on-orange is also how real safety signage works. If someone
    // "fixes" contrast by muddying the orange instead, say so here.
    expect(token('mb-safety')).toBe('#ff6a13');
  });
});

describe('MApp colour contrast — dark theme', () => {
  // Same pairs, resolved through the dark palette. --mb-workshop is
  // #f3f5f6: a near-white full-screen emitter held at arm's length on a
  // shift that starts before dawn. The theme is only worth having if it
  // is at least as legible as the light one, so it is held to the same
  // 4.5:1 rather than treated as a cosmetic extra.
  const DARK_SURFACE = () => darkToken('mb-surface');

  const pairs = () => [
    ['body text', darkToken('mb-ink'), darkToken('mb-workshop')],
    ['card text', darkToken('mb-ink'), DARK_SURFACE()],
    ['card subtitles / secondary text', darkToken('mb-steel'), DARK_SURFACE()],
    ['links and text buttons', darkToken('mb-enamel-blue-ink'), DARK_SURFACE()],
    ['the red Delete on a list row', darkToken('mb-enamel-red-ink'), DARK_SURFACE()],
    ['the amber pending note', darkToken('mb-enamel-amber-ink'), DARK_SURFACE()],
    ['safety used as text', darkToken('mb-safety-ink'), DARK_SURFACE()],
    ['offline banner', darkToken('mb-enamel-red-ink'), darkToken('mb-enamel-red-bg')],
    ['danger button', darkToken('mb-enamel-red-ink'), darkToken('mb-enamel-red-bg')],
    ['approximate-results note', darkToken('mb-enamel-amber-ink'), darkToken('mb-enamel-amber-bg')],
    ['secondary button', darkToken('mb-ink'), darkToken('mb-steel-faint')],
    // Chips and toasts keep their light-theme fills, so white-on-enamel
    // has to still pass against those unchanged values.
    ['"Pending" chip', WHITE, darkToken('mb-enamel-amber')],
    ['"In Progress" chip', WHITE, darkToken('mb-enamel-blue')],
    ['"Completed" chip', WHITE, darkToken('mb-enamel-green')],
    ['"Cancelled" chip', WHITE, darkToken('mb-enamel-red')],
    ['default chip', WHITE, darkToken('mb-enamel-slate')],
    // The whole point of the ink-on-orange fix: it holds in both themes.
    ['primary button / FAB label', darkToken('mb-on-safety'), darkToken('mb-safety')],
  ];

  test.each(pairs())('%s clears AA in dark', (_label, fg, bg) => {
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  test('the dark theme actually overrides the light ground', () => {
    // Guards against the block existing but being empty or misparsed,
    // which would make every assertion above silently re-test light.
    expect(darkToken('mb-workshop')).not.toBe(token('mb-workshop'));
    expect(darkToken('mb-surface')).not.toBe(token('mb-surface'));
    expect(darkToken('mb-ink')).not.toBe(token('mb-ink'));
  });

  test('a label on a safety fill never uses a theme-flipping token', () => {
    // --mb-ink is near-black in light and near-WHITE in dark. The orange
    // fill deliberately does NOT flip, so a label written as var(--mb-ink)
    // renders white-on-orange at 2.87:1 in dark -- reintroducing exactly
    // the defect Phase 0 fixed. This is not hypothetical: the first cut of
    // the dark theme did it. --mb-on-safety is fixed in both themes.
    const offenders = CSS.split('}')
      .filter(rule => /background:\s*var\(--mb-safety\)/.test(rule))
      .filter(rule => /(^|[^-])color:\s*var\(--mb-ink\)/.test(rule))
      .map(rule => rule.trim().split('\n').pop());

    expect(offenders).toEqual([]);
  });

  test('the enamel fills are the same paint codes in both themes', () => {
    // They are the app's identity, and they already read on a dark ground.
    ['red', 'blue', 'green', 'amber', 'slate'].forEach(c => {
      expect(darkToken(`mb-enamel-${c}`)).toBe(token(`mb-enamel-${c}`));
    });
    expect(darkToken('mb-safety')).toBe(token('mb-safety'));
  });
});

describe('the type scale follows the OS text-size setting', () => {
  // html was pinned to `font-size: 16px`, which makes Android's font-scale
  // and iOS Dynamic Type do nothing at all -- in a product whose own
  // stylesheet header cites viewing distance and glare as constraints, and
  // whose users are not all twenty-five.
  const rules = CSS.split('}');

  test('the root does not pin a font size', () => {
    const rootRule = rules.find(r => /(^|\n)html,\s*body\s*\{/.test(r));
    expect(rootRule).toBeDefined();
    expect(rootRule).not.toMatch(/font-size:/);
  });

  test('every font-size is relative, except the deliberate input floor', () => {
    const absolute = CSS.split(/\r?\n/)
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => /font-size:\s*[0-9.]+px/.test(line));

    expect(absolute.map(a => `${a.n}: ${a.line}`)).toEqual([]);
  });

  test('inputs keep a 16px floor so iOS does not zoom on focus', () => {
    // Plain 1rem would reintroduce the zoom for anyone who scales text
    // DOWN; max() keeps the floor while still scaling up.
    expect(CSS).toMatch(/input,\s*select,\s*textarea,\s*button\s*\{[^}]*font-size:\s*max\(1rem,\s*16px\)/);
  });

  test('spacing and tap targets stay absolute', () => {
    // --mb-tap-min must not shrink when text is scaled down, and
    // --mb-topbar-h is used in calc() with env(safe-area-inset-*), where a
    // scaling unit would make layout maths depend on a font preference.
    const flat = CSS.replace(/\s+/g, ' ');
    ['--mb-tap-min: 48px', '--mb-tap-primary: 56px',
      '--mb-topbar-h: 56px', '--mb-tabbar-h: 64px',
      '--mb-sp-4: 16px'].forEach(decl => {
      expect(flat).toContain(decl);
    });
  });
});
