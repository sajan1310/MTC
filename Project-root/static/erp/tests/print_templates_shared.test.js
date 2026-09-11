/**
 * One document, whichever shell printed it.
 *
 * Desktop and MApp are two independent implementations of one product and
 * share almost nothing on purpose. Printed documents are the exception and
 * always have been: mobile.html includes the same partials/print.html
 * desktop does, so a challan, a PO, a bill and every ledger come out
 * identical either way. A document goes to a vendor or onto the floor, and
 * which device produced it is not something the paper should record.
 *
 * Three escaped that. Desktop built the Production Sheet and the stock/pool
 * pivot inside production.js and stock.js -- bundles the mobile shell never
 * loads -- so MApp printed a plain generic table instead: the same numbers,
 * a different document. The builders are shared now, and these tests are
 * what stop them splitting again.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

/** api.js and print-templates.js in one scope, as separate <script> tags
 *  share the global lexical scope in a browser. */
function loadTemplates() {
  // eslint-disable-next-line no-eval
  eval([
    read('api.js').replace(/^const Api = /m, 'global.Api = '),
    read('print-templates.js').replace(/^const PrintTemplates = /m, 'global.PrintTemplates = '),
  ].join('\n'));
}

/** The print container both shells fill -- it lives in the shared
 *  partials/print.html, so this mirrors the ids the renderer writes. */
function printContainerDom() {
  document.body.innerHTML = `
    <div id="print-production-sheet-container">
      <div id="print-prod-title"></div><div id="print-prod-date"></div>
      <div id="print-prod-id"></div><div id="print-prod-name"></div>
      <div id="print-prod-qty"></div>
      <div id="print-prod-color-wrapper"><span id="print-prod-color"></span></div>
      <div id="print-prod-common-section"><div id="print-production-sheet-common-tables"></div></div>
      <div id="print-prod-matrix-section"><div id="print-production-sheet-matrix-tables"></div></div>
      <div id="print-prod-subgroup-section"><div id="print-production-sheet-subgroup-tables"></div></div>
      <div id="print-prod-remarks-section"><div id="print-prod-remarks"></div></div>
    </div>`;
}

const DEPS = {
  formatQty: v => String(v),
  sameColor: (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase(),
  palette: {
    HEAD_BG: '#cfe8d5', HEAD_INK: '#0b5132', ZEBRA: '#eef4ef', RULE: '#c8d3ca',
    GRID_STRONG: '#8fae99', INK_PRIMARY: '#111', INK_MUTED: '#5b6b60',
  },
  pageHeightPx: 1077,
  pageWidthPx: 748,
};

const SHEET = {
  title: 'Packing Requirement Sheet',
  date: '01/09/2026',
  productId: 'PRD-1',
  productName: 'Kalpi 26',
  qty: '40',
  remarks: 'handle with care',
  colors: ['Red', 'Blue'],
  subGroups: [],
  excluded: [],
  common: [{ name: 'Primer', qty: 5, unit: 'L' }],
  matrix: [
    { name: 'Paint(Gloss)', unit: 'L', qtyByGroup: { Red: 2 }, tagByGroup: {} },
    { name: 'Lacquer', unit: 'L', qtyByGroup: { Blue: 3 }, tagByGroup: {} },
  ],
};

const STOCK = [
  { name: 'Bolt', size: '6mm', currentStock: 4, isLowStock: true },
  { name: 'Bolt', size: '8mm', currentStock: 40, isLowStock: false },
  { name: 'Nut', size: '6mm', currentStock: 12, isLowStock: false },
];

const POOL = [
  { outputItemName: 'Rim 20 inch', productTag: '', color: 'Black', availableQty: 10 },
  { outputItemName: 'Rim 20 inch', productTag: '', color: 'Red', availableQty: 5 },
];

beforeEach(loadTemplates);

describe('the production sheet', () => {
  beforeEach(printContainerDom);

  const common = () => document.getElementById('print-production-sheet-common-tables').innerHTML;
  const matrix = () => document.getElementById('print-production-sheet-matrix-tables').innerHTML;

  test('fills the header the shared container carries', () => {
    PrintTemplates.productionSheet(SHEET, DEPS);

    expect(document.getElementById('print-prod-title').innerText).toBe('Packing Requirement Sheet');
    expect(document.getElementById('print-prod-name').innerText).toBe('Kalpi 26');
    expect(document.getElementById('print-prod-qty').innerText).toBe('40');
  });

  test('puts uncoloured rows in Common and coloured ones in the matrix', () => {
    PrintTemplates.productionSheet(SHEET, DEPS);

    expect(common()).toContain('Primer');
    expect(matrix()).toContain('Paint(Gloss)');
    expect(common()).not.toContain('Paint(Gloss)');
  });

  test('columns that never share a row split into separate tables', () => {
    // The clustering rule desktop relies on: Red and Blue are used by
    // different rows, so doubling every row with dashes would be wrong.
    PrintTemplates.productionSheet(SHEET, DEPS);
    expect((matrix().match(/<table/g) || []).length).toBeGreaterThan(1);
  });

  test('a group unticked in Print options is dropped from the sheet', () => {
    PrintTemplates.productionSheet({ ...SHEET, excluded: ['Blue'] }, DEPS);

    expect(matrix()).toContain('Paint(Gloss)');
    expect(matrix()).not.toContain('Lacquer');
  });

  test('the colour line only appears for a lot that has one', () => {
    PrintTemplates.productionSheet(SHEET, DEPS);
    expect(document.getElementById('print-prod-color-wrapper').style.display).toBe('none');

    PrintTemplates.productionSheet({ ...SHEET, lotColor: 'Red' }, DEPS);
    expect(document.getElementById('print-prod-color-wrapper').style.display).toBe('');
  });

  test('a sheet with no matrix rows hides that section', () => {
    PrintTemplates.productionSheet({ ...SHEET, matrix: [], colors: [] }, DEPS);
    expect(document.getElementById('print-prod-matrix-section').style.display).toBe('none');
  });

  test('quantities carry their unit', () => {
    PrintTemplates.productionSheet(SHEET, DEPS);
    expect(common()).toContain('5 L');
  });

  test('it escapes what it prints', () => {
    PrintTemplates.productionSheet({
      ...SHEET,
      common: [{ name: '<img src=x onerror=alert(1)>', qty: 1, unit: '' }],
    }, DEPS);

    expect(common()).not.toContain('<img src=x');
  });

  test('missing deps degrade rather than throw', () => {
    // A shell that forgets one should print a barer document, not fail at
    // the moment somebody needs the paper.
    expect(() => PrintTemplates.productionSheet(SHEET, {})).not.toThrow();
    expect(() => PrintTemplates.productionSheet({}, DEPS)).not.toThrow();
  });

  test('the abandoned second renderer is gone', () => {
    // production.js: "one lot printed with a different table layout
    // depending on whether it was reached through Print Sheet or Print
    // Selected. There is one layout now." It must not come back.
    expect(PrintTemplates.productionSheetPage).toBeUndefined();
    expect(read('production.js')).not.toContain('buildProductionSheetPrintPageHtml(p) {');
  });
});

describe('the stock / pool pivot', () => {
  test('puts items down the page and sizes across it', () => {
    // Not a flat list: a warehouse carries one item in a dozen sizes, and
    // a row per combination is a report nobody reads.
    const { headerHtml, bodyHtml } = PrintTemplates.stockPivotMarkup(STOCK, [], 'empty', {});

    expect(headerHtml).toContain('6mm');
    expect(headerHtml).toContain('8mm');
    expect(bodyHtml).toContain('Bolt');
    expect(bodyHtml).toContain('Nut');
  });

  test('an item missing a size gets a dash, not a blank cell', () => {
    const { bodyHtml } = PrintTemplates.stockPivotMarkup(STOCK, [], 'empty', {});
    expect(bodyHtml).toContain('>-<');
  });

  test('low stock is marked without relying on colour', () => {
    // These print on whatever is in the office printer.
    const { bodyHtml } = PrintTemplates.stockPivotMarkup(STOCK, [], 'empty', {});
    expect(bodyHtml).toContain('font-weight:800');
  });

  test('pool buckets are named in full so the row is identifiable', () => {
    const { bodyHtml } = PrintTemplates.stockPivotMarkup([], POOL, 'empty', {
      sizeFromOutputItemName: () => '20 inch',
    });

    expect(bodyHtml).toContain('Warehouse Pool');
    expect(bodyHtml).toContain('[Black]');
    expect(bodyHtml).toContain('[Red]');
  });

  test('two buckets on one item and size are summed, not overwritten', () => {
    // Overwriting would report the last bucket as though it were the total.
    const { bodyHtml } = PrintTemplates.stockPivotMarkup([], [
      { outputItemName: 'Rim', productTag: '', color: '', availableQty: 10 },
      { outputItemName: 'Rim', productTag: '', color: '', availableQty: 5 },
    ], 'empty', { sizeFromOutputItemName: () => 'GENERAL' });

    expect(bodyHtml).toContain('>15<');
  });

  test('nothing to show says so, across the full width', () => {
    const { bodyHtml } = PrintTemplates.stockPivotMarkup([], [], 'No stock records found.', {});
    expect(bodyHtml).toContain('No stock records found.');
    expect(bodyHtml).toContain('colspan');
  });

  test('it escapes item names', () => {
    const { bodyHtml } = PrintTemplates.stockPivotMarkup(
      [{ name: '<b>x</b>', size: 'S', currentStock: 1 }], [], 'empty', {});
    expect(bodyHtml).not.toContain('<b>x</b>');
  });
});

describe('both shells reach the same builder', () => {
  const DESKTOP_STOCK = read('stock.js');
  const DESKTOP_PRODUCTION = read('production.js');
  const MOBILE = read('mobile.js');

  test('desktop delegates rather than keeping its own copy', () => {
    expect(DESKTOP_STOCK).toContain('PrintTemplates.computeStockPivot');
    expect(DESKTOP_STOCK).toContain('PrintTemplates.stockPivotMarkup');
    expect(DESKTOP_PRODUCTION).toContain('PrintTemplates.productionSheet(');
  });

  test('mobile calls the same three', () => {
    expect(MOBILE).toContain('PrintTemplates.stockPivotMarkup');
    expect(MOBILE).toContain('PrintTemplates.productionSheet(');
  });

  test('mobile fills desktop\'s containers, not one of its own', () => {
    // The container IS the layout. Filling a different one would put the
    // same numbers in a different document again.
    expect(MOBILE).toContain("'print-low-stock-container'");
    expect(MOBILE).toContain("'print-production-sheet-container'");
  });

  test('both shells load the shared file', () => {
    const desktopHtml = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'index.html'), 'utf8');
    const mobileHtml = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'mobile.html'), 'utf8');

    expect(desktopHtml).toContain('erp/print-templates.js');
    expect(mobileHtml).toContain('erp/print-templates.js');
  });

  test('and both workers precache it', () => {
    // Otherwise printing is the one thing that stops working offline.
    expect(read('sw.js')).toContain('/static/erp/print-templates.js');
    expect(read('mobile-sw.js')).toContain('/static/erp/print-templates.js');
  });
});
