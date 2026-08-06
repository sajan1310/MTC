/**
 * Structural accessibility gate (ACCESSIBILITY_REPORT.md / TECHNICAL_DEBT_REPORT.md
 * TD-001, A11Y-010: "no automated accessibility testing in CI"). Runs axe-core
 * against the ACTUAL server-rendered partials (read straight off disk, not a
 * hand-written fixture that could drift from the real markup) inside jsdom.
 *
 * Scope, deliberately: jsdom has no layout engine, so axe's colour-contrast
 * checks cannot run here (they need real computed styles from a real
 * renderer) -- that's what the live browser audit covers. What DOES work
 * reliably in jsdom is everything DOM/attribute-based: table headers, form
 * labels, heading order, landmark/role correctness, image alt text. That is
 * exactly the class of bug this test catches, including the one it was
 * written to prove fixed: A11Y-001 (75 tables, 0 scope attributes).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { configureAxe, toHaveNoViolations } = require('jest-axe');

expect.extend(toHaveNoViolations);

// color-contrast requires real layout (see file header) -- everything else
// stays on, including table-header-structure targeted below.
const axe = configureAxe({
  rules: { 'color-contrast': { enabled: false } },
});

const PARTIALS_DIR = path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials');

function loadPartial(name) {
  return fs.readFileSync(path.join(PARTIALS_DIR, name), 'utf8');
}

describe('accessibility: table headers (A11Y-001)', () => {
  test('vendors.html tables have no axe table-header violations', async () => {
    document.body.innerHTML = `<div id="root">${loadPartial('vendors.html')}</div>`;
    const results = await axe(document.body, {
      runOnly: ['th-has-data-cells', 'scope-attr-valid'],
    });
    expect(results).toHaveNoViolations();
  });

  test('every <th> in vendors.html declares a scope', () => {
    document.body.innerHTML = loadPartial('vendors.html');
    const headers = Array.from(document.querySelectorAll('th'));
    expect(headers.length).toBeGreaterThan(0); // guards against the fixture silently going empty
    const missingScope = headers.filter(th => !th.getAttribute('scope'));
    expect(missingScope).toEqual([]);
  });
});

describe('accessibility: every <th> in every partial declares a scope and a name', () => {
  const partials = fs.readdirSync(PARTIALS_DIR).filter(f => f.endsWith('.html') && f !== 'print.html');
  // print.html excluded: its layout is owned entirely by inline styles for a
  // documented html2canvas reason (see static/erp/styles.css) and is out of
  // scope here, same as it was for the mechanical scope="col" pass.

  test.each(partials)('%s', name => {
    document.body.innerHTML = loadPartial(name);
    const headers = Array.from(document.querySelectorAll('th'));
    const missingScope = headers.filter(th => !th.getAttribute('scope'));
    expect(missingScope).toEqual([]);

    const empty = headers.filter(th => th.textContent.trim() === '' && !th.querySelector('input, span.visually-hidden'));
    expect(empty).toEqual([]);
  });
});

describe('accessibility: dashboard KPI cards', () => {
  test('dashboard.html has no structural axe violations (contrast + landmarks excluded)', async () => {
    document.body.innerHTML = loadPartial('dashboard.html');
    const results = await axe(document.body, {
      rules: {
        // 'region' (every element must be in a landmark) is excluded HERE
        // specifically because this test renders one <template> partial in
        // isolation -- in the real page it's included into #content, which
        // itself is not a landmark either (confirmed: index.html has no
        // <main>). That IS a real, separate finding -- see
        // HTML_CSS_JS_REVIEW.md FE-007 / ACCESSIBILITY_REPORT.md A11Y-006 --
        // just not one a single partial's isolated test can fairly assert
        // on (it would fail identically no matter how clean the partial's
        // OWN markup is), so it's tracked there instead of asserted here.
        region: { enabled: false },
      },
    });
    expect(results).toHaveNoViolations();
  });
});
