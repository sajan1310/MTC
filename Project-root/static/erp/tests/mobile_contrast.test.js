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
function token(name) {
  const match = CSS.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`));
  if (!match) throw new Error(`token --${name} not found in mobile_styles.css`);
  return match[1];
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
    ['primary button / FAB label on safety orange', token('mb-ink'), token('mb-safety')],
    ['primary button label on the pressed fill', token('mb-ink'), token('mb-safety-dark')],
    ['active filter chip label', token('mb-ink'), token('mb-safety')],
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

  test('the brand orange itself is unchanged', () => {
    // The fix was to flip the LABEL to ink, not to darken the brand --
    // black-on-orange is also how real safety signage works. If someone
    // "fixes" contrast by muddying the orange instead, say so here.
    expect(token('mb-safety')).toBe('#ff6a13');
  });
});
