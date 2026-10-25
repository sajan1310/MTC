/**
 * The desktop header never pushes its controls past the right edge.
 *
 * It wrapped only at 768px and below, while its button labels switched on
 * at 768px. From 800 to about 1240px -- every iPad and Android tablet in
 * portrait, most of them in landscape, and a narrow laptop window -- the row
 * ran wider than the screen: the bell and the account menu (My Profile,
 * Sign out) sat off the right edge, and the whole page scrolled sideways
 * (267px at 820px wide). Measured in headless Chrome on the rendered
 * template.
 *
 * Two changes, both checked here: the header wraps at every width, and the
 * labels wait for a desktop-sized window (Bootstrap's xl, 1200px).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
const HTML = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'index.html'), 'utf8'
);

/** Bodies of the rules for `selector` that sit outside every @media block. */
function topLevelRules(css, selector) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const bodies = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') {
      if (depth === 0 && src.slice(start, i).trim() === selector) {
        bodies.push(src.slice(i + 1, src.indexOf('}', i)));
      }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) start = i + 1;
    } else if (ch === ';' && depth === 0) {
      start = i + 1;
    }
  }
  return bodies;
}

const LABELS = ['Units', 'Colors', 'Models', 'Process Types', 'Logo'];

describe('the desktop header', () => {
  test('wraps at every width, not only on narrow screens', () => {
    const bodies = topLevelRules(CSS, '.app-header');
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.some(body => /flex-wrap:\s*wrap/.test(body))).toBe(true);
  });

  test('shows its button labels only from 1200px', () => {
    LABELS.forEach(label => {
      expect(HTML).toContain(`<span class="d-none d-xl-inline">${label}</span>`);
      expect(HTML).not.toContain(`<span class="d-none d-md-inline">${label}</span>`);
    });
    expect(HTML).toMatch(/d-none d-xl-block"[^>]*>ERP System</);
  });
});
