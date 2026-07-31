/**
 * Regression test for App.Production.printProductionSheet (../production.js)
 * -- the consolidated-matrix print redesign (one shared table with every
 * lot color as a column, instead of one table per color-signature group)
 * and the Common Components two-column split. Run against the real source
 * via a require() of the actual file, same const-rewrite/global-App
 * technique pool_ledger.test.js established.
 *
 * The Per-Color matrix deliberately stays ONE consolidated table (a real
 * 6-colour/11-row worst case must not fragment into one table per row
 * signature/axis, or it spills across pages) -- an earlier "split disjoint
 * color axes" attempt was reverted upstream in favor of scoping that
 * clustering to Sub-Group Components only, which this port doesn't have
 * (no colorGroups/subGroups split -- Flask's Production Sheet only ever
 * had the flat `colors` axis this file exercises).
 *
 * jsdom does not do real layout, so container.scrollHeight is always 0 --
 * the auto-fit compression loop's tier-selection (shrinking padding/font,
 * dropping Size) can therefore never be reached here; every call in this
 * file exercises FIT_TIERS[0] only. That part is intentionally left to
 * manual/visual verification. What IS meaningfully covered without real
 * layout: the consolidated matrix structure, dash-for-missing-color cells,
 * and the two-column Common Components split threshold.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function loadProductionAsGlobal() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'production.js'), 'utf8');
  // eslint-disable-next-line no-eval
  eval(code);
}

function buildPrintContainerDom() {
  document.body.innerHTML = `
    <div id="prodSheetDate"></div>
    <div id="prodSheetProductId"></div>
    <div id="prodSheetProductName"></div>
    <div id="prodSheetLotQty"></div>
    <textarea id="productionSheetRemarks"></textarea>

    <div id="productionSheetCommonBody"></div>
    <div id="productionSheetMatrixTables"><div class="prod-sheet-matrix-tbody"></div></div>

    <div id="print-production-sheet-container">
      <div id="print-prod-date"></div>
      <div id="print-prod-id"></div>
      <div id="print-prod-name"></div>
      <div id="print-prod-qty"></div>
      <div id="print-prod-color-wrapper"></div>
      <div id="print-prod-color"></div>
      <div id="print-prod-common-section"></div>
      <div id="print-production-sheet-common-tables"></div>
      <div id="print-prod-matrix-section"></div>
      <div id="print-production-sheet-matrix-tables"></div>
      <div id="print-prod-remarks-section"></div>
      <div id="print-prod-remarks-text"></div>
    </div>`;
}

function addCommonRow(name, size, narration, qty) {
  const tbody = document.getElementById('productionSheetCommonBody');
  const row = document.createElement('div');
  row.innerHTML = `
    <input class="prod-sheet-item-name" value="${name}">
    <input class="prod-sheet-size" value="${size}">
    <input class="prod-sheet-narration" value="${narration}">
    <input class="prod-sheet-qty" value="${qty}">`;
  // Flatten so `row.querySelector('.prod-sheet-item-name')` on the <tr>
  // itself (as production.js expects) finds these -- append the inputs
  // directly onto a <tr>-shaped container instead of nesting.
  const tr = document.createElement('tr');
  tr.innerHTML = row.innerHTML;
  tbody.appendChild(tr);
  return tr;
}

function addMatrixRow(name, size, narration, colorValues) {
  const tbody = document.querySelector('#productionSheetMatrixTables .prod-sheet-matrix-tbody');
  const tr = document.createElement('tr');
  let html = `
    <input class="prod-sheet-item-name" value="${name}">
    <input class="prod-sheet-size" value="${size}">
    <input class="prod-sheet-narration" value="${narration}">`;
  Object.entries(colorValues).forEach(([color, val]) => {
    html += `<input class="prod-sheet-color-qty" data-color="${color}" value="${val}">`;
  });
  tr.innerHTML = html;
  tbody.appendChild(tr);
  return tr;
}

describe('App.Production.printProductionSheet', () => {
  let triggerSpy;

  beforeEach(() => {
    buildPrintContainerDom();
    // jsdom's innerText getter only reflects content that was itself
    // assigned via innerText (not raw innerHTML) -- match production.js's
    // own setText(), which reads .innerText, by writing the fixture the
    // same way.
    document.getElementById('prodSheetDate').innerText = '01/01/2026';
    document.getElementById('prodSheetProductId').innerText = 'PRC-1';
    document.getElementById('prodSheetProductName').innerText = 'Widget';
    document.getElementById('prodSheetLotQty').innerText = '10';

    global.escapeHtml = value => String(value).replace(/[&<>"']/g, ch => HTML_ESCAPE_MAP[ch]);
    global.toNumber = (value, fallback = 0) => {
      const n = Number(value);
      return Number.isFinite(n) ? n : fallback;
    };
    global.$ = (sel, root = document) => root.querySelector(sel);
    global.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

    global.App = {
      State: { currentProductionSheet: { colors: [], lotColor: '' } },
      Utils: { notPortedYet: jest.fn() },
    };
    loadProductionAsGlobal();

    triggerSpy = jest.fn();
    App.Print = { trigger: triggerSpy };
  });

  test('consolidated matrix: one shared table with every color as a column, dashes for missing values', () => {
    App.State.currentProductionSheet = { colors: ['Red', 'Blue'], lotColor: '' };
    addMatrixRow('Frame', 'L', 'Main', { Red: '5', Blue: '' });
    addMatrixRow('Mudguard', 'L', 'Rear', { Red: '', Blue: '3' });

    App.Production.printProductionSheet();

    const dest = document.getElementById('print-production-sheet-matrix-tables');
    const tables = dest.querySelectorAll('table');
    expect(tables.length).toBe(1); // one consolidated table, not one per color-signature

    const headerText = dest.querySelector('thead').textContent;
    expect(headerText).toContain('Red');
    expect(headerText).toContain('Blue');

    const rows = dest.querySelectorAll('tbody tr');
    expect(rows.length).toBe(2);
    // Frame: Red=5, Blue dash. Mudguard: Red dash, Blue=3.
    expect(rows[0].textContent).toContain('Frame');
    expect(rows[0].textContent).toContain('5');
    expect(rows[0].textContent).toContain('–'); // &#8211; dash for Blue
    expect(rows[1].textContent).toContain('Mudguard');
    expect(rows[1].textContent).toContain('3');
  });

  test('matrix section is hidden when there are no colors or no matrix rows', () => {
    App.State.currentProductionSheet = { colors: [], lotColor: '' };
    App.Production.printProductionSheet();

    expect(document.getElementById('print-prod-matrix-section').style.display).toBe('none');
  });

  test('Common Components: 8 or fewer rows render as a single full-width table', () => {
    for (let i = 0; i < 8; i++) addCommonRow(`Item${i}`, 'M', 'N', '1');
    App.Production.printProductionSheet();

    const dest = document.getElementById('print-production-sheet-common-tables');
    expect(dest.querySelectorAll('table').length).toBe(1);
    expect(dest.querySelector('[style*="grid-template-columns"]')).toBeNull();
  });

  test('Common Components: more than 8 rows split into a two-column grid of two tables', () => {
    for (let i = 0; i < 9; i++) addCommonRow(`Item${i}`, 'M', 'N', '1');
    App.Production.printProductionSheet();

    const dest = document.getElementById('print-production-sheet-common-tables');
    const grid = dest.querySelector('[style*="grid-template-columns"]');
    expect(grid).not.toBeNull();
    const tables = dest.querySelectorAll('table');
    expect(tables.length).toBe(2);
    // ceil(9/2) = 5 rows left, 4 right.
    expect(tables[0].querySelectorAll('tbody tr').length).toBe(5);
    expect(tables[1].querySelectorAll('tbody tr').length).toBe(4);
  });

  test('lot header fields and color wrapper are populated', () => {
    App.State.currentProductionSheet = { colors: [], lotColor: 'Red / Blue' };
    App.Production.printProductionSheet();

    expect(document.getElementById('print-prod-date').innerText).toBe('01/01/2026');
    expect(document.getElementById('print-prod-id').innerText).toBe('PRC-1');
    expect(document.getElementById('print-prod-name').innerText).toBe('Widget');
    expect(document.getElementById('print-prod-qty').innerText).toBe('10');
    expect(document.getElementById('print-prod-color-wrapper').style.display).toBe('');
    expect(document.getElementById('print-prod-color').innerText).toBe('Red / Blue');
  });

  test('triggers App.Print.trigger with a sanitized filename derived from the product id', () => {
    App.Production.printProductionSheet();
    expect(triggerSpy).toHaveBeenCalledWith('print-production-sheet-container', 'Production_Sheet_PRC-1');
  });
});
