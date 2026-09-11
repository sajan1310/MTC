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

const LOT = {
  lotNumber: 'LOT-1',
  date: '01/09/2026',
  productId: 'PRD-1',
  productName: 'Kalpi 26',
  qty: 40,
  processId: 'PRC-1',
  sheetRemarks: 'handle with care',
  componentsConsumed: [
    { itemName: 'Rim', size: '20 inch', narration: 'Chrome', sourceType: 'POOL', qty: 40 },
    { itemName: 'Spoke', size: '', narration: '', sourceType: 'ITEM', qty: 320 },
  ],
};

const DEPS = {
  formatQty: v => String(v),
  brandHeaderHtml: colour => `<div data-brand="${colour}">Maharaja Bikes</div>`,
  requirementSheetTitle: () => 'Rim Fitting Material Requirement Sheet',
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
  test('carries the lot, its components and its remarks', () => {
    const html = PrintTemplates.productionSheetPage(LOT, DEPS);

    expect(html).toContain('Kalpi 26');
    expect(html).toContain('PRD-1');
    expect(html).toContain('Rim');
    expect(html).toContain('Spoke');
    expect(html).toContain('handle with care');
  });

  test('identifies the lot by product and date, as desktop does', () => {
    // Not by lot number: the desktop document has no such field, and this
    // is that document. Pinned because it is surprising, and because a
    // well-meaning addition here would change what the floor receives.
    const html = PrintTemplates.productionSheetPage(LOT, DEPS);
    expect(html).toContain('01/09/2026');
    expect(html).toContain('Product Name');
    expect(html).not.toContain('LOT-1');
  });

  test('shows narration in brackets after the item name', () => {
    // The printed sheet and the lot form name the same part the same way.
    const html = PrintTemplates.productionSheetPage(LOT, DEPS);
    expect(html).toContain('Rim(Chrome)');
  });

  test('names the source of every row', () => {
    // A POOL draw and an ITEM draw come off different shelves.
    const html = PrintTemplates.productionSheetPage(LOT, DEPS);
    expect(html).toContain('Pool');
    expect(html).toContain('Item');
  });

  test('a lot with no components says so rather than printing a bare table', () => {
    const html = PrintTemplates.productionSheetPage({ ...LOT, componentsConsumed: [] }, DEPS);
    expect(html).toContain('No components recorded');
  });

  test('it escapes what it prints', () => {
    const html = PrintTemplates.productionSheetPage({
      ...LOT,
      componentsConsumed: [{ itemName: '<img src=x onerror=alert(1)>', qty: 1 }],
    }, DEPS);

    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });

  test('the masthead comes from the shell, so each uses its own logo', () => {
    const html = PrintTemplates.productionSheetPage(LOT, DEPS);
    expect(html).toContain('data-brand="#198754"');
  });

  test('missing deps degrade rather than throw', () => {
    // A shell that forgets to pass one should print a slightly barer
    // document, not fail at the moment somebody needs the paper.
    expect(() => PrintTemplates.productionSheetPage(LOT, {})).not.toThrow();
    expect(() => PrintTemplates.productionSheetPage(LOT)).not.toThrow();
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
    expect(DESKTOP_PRODUCTION).toContain('PrintTemplates.productionSheetPage');
  });

  test('mobile calls the same three', () => {
    expect(MOBILE).toContain('PrintTemplates.stockPivotMarkup');
    expect(MOBILE).toContain('PrintTemplates.productionSheetPage');
  });

  test('mobile fills desktop\'s containers, not one of its own', () => {
    // The container IS the layout. Filling a different one would put the
    // same numbers in a different document again.
    expect(MOBILE).toContain("'print-low-stock-container'");
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
