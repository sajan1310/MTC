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

describe('the documents both shells print', () => {
  // partials/print.html is included by index.html AND mobile.html, so these
  // are the real ids each builder writes into.
  function documentDom() {
    document.body.innerHTML = `
      <div id="print-po-container">
        <span id="print-vendor"></span><span id="print-contact"></span>
        <span id="print-supp-rem"></span><span id="print-ponum"></span>
        <span id="print-date"></span><span id="print-desc"></span>
        <span id="print-remarks"></span>
        <table><thead id="print-table-head"></thead><tbody id="print-items-body"></tbody></table>
        <div id="print-grand-total-container"><span id="print-grand-total"></span></div>
      </div>
      <div id="print-bill-container">
        <span id="print-bill-number"></span><span id="print-bill-date"></span>
        <span id="print-bill-vendor"></span><span id="print-bill-remarks"></span>
        <span id="print-bill-contact"></span><span id="print-bill-po-ref"></span>
        <table><tbody id="print-bill-items-body"></tbody></table>
        <span id="print-bill-grand-total"></span>
      </div>
      <div id="print-dispatch-container">
        <span id="print-dispatch-number"></span><span id="print-dispatch-date"></span>
        <span id="print-dispatch-client"></span>
        <span id="print-dispatch-client-address"></span>
        <span id="print-dispatch-client-gstin"></span>
        <span id="print-dispatch-transport"></span>
        <span id="print-dispatch-order-ref"></span>
        <span id="print-dispatch-gr-ref"></span>
        <span id="print-dispatch-remarks"></span>
        <table><tbody id="print-dispatch-items-body"></tbody></table>
      </div>`;
  }

  // Desktop's App.Utils spellings, which is what App.Print.templateDeps()
  // hands over. MApp passes the same shape from MApp.Util.
  const DOC_DEPS = {
    escapeHtml: s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    toNumber: v => Number(v) || 0,
    formatCurrency: v => `₹${(Number(v) || 0).toFixed(2)}`,
    formatNameCase: s => String(s == null ? '' : s)
      .toLowerCase().replace(/\b\w/g, c => c.toUpperCase()),
    brandColor: '#C0392B'
  };

  const PO = {
    poNumber: 'PO-42', poDate: '01/09/2026', vendor: 'acme CYCLES',
    contact: 'Ramesh', poDescription: 'Rims', poRemarks: 'urgent',
    supplierRemarks: 'pack well',
    items: [{ name: 'Rim 26', size: '26 inch', unit: 'Pcs', qty: 10, price: 150, narration: 'chrome' }]
  };

  const BILL = {
    billNumber: 'B-7', billDate: '02/09/2026', vendor: 'acme CYCLES',
    contact: 'Ramesh', remarks: 'part load', poNumbers: ['42'], totalAmount: 1770,
    items: [{ name: 'Rim 26', size: '26 inch', unit: 'Pcs', qty: 10, price: 150, gstRatePct: 18, lineTotal: 1770 }]
  };

  const DISPATCH = {
    dispatchNumber: 'DC-9', dispatchDate: '08/09/2026', clientName: 'nova MOTORS',
    transport: 'Blue Dart', orderNumber: 'SO-3', invoiceNumber: 'INV-1', grNumber: 'GR-2',
    items: [{ productName: 'Kalpi 26', productId: 'PRD-1', qty: 40 }]
  };

  const CHALLAN_DEPS = {
    ...DOC_DEPS,
    clients: [{ name: 'Nova Motors', address: '12 Mill Road, Ludhiana', gstin: '03ABCDE1234F1Z5' }],
    items: [{ name: 'Kalpi 26', hsn: '87141090' }]
  };

  beforeEach(documentDom);

  test('the PO names its vendor in title case, as desktop does', () => {
    // The phone printed `po.vendor` raw. Same PO, two spellings of the
    // vendor, depending on which device was nearest.
    PrintTemplates.poDocument(PO, DOC_DEPS);
    expect(document.getElementById('print-vendor').innerText).toBe('Acme Cycles');
  });

  test('the PO totals its lines and shows the grand total', () => {
    PrintTemplates.poDocument(PO, DOC_DEPS);
    expect(document.getElementById('print-items-body').innerHTML).toContain('Rim 26');
    expect(document.getElementById('print-grand-total').innerText).toBe('1500.00');
    expect(document.getElementById('print-grand-total-container').style.display).toBe('block');
  });

  test('a PO printed without rates drops both money columns', () => {
    // Desktop's two Print Options checkboxes. They are desktop UI, so the
    // builder takes their answer rather than reading the DOM itself --
    // which is what lets the phone call the same function.
    PrintTemplates.poDocument(PO, DOC_DEPS, { includeRates: false });
    const head = document.getElementById('print-table-head').innerHTML;
    expect(head).not.toContain('Rate');
    expect(head).not.toContain('Total');
    expect(document.getElementById('print-grand-total-container').style.display).toBe('none');
  });

  test('the bill names its vendor in title case too', () => {
    PrintTemplates.billDocument(BILL, DOC_DEPS);
    expect(document.getElementById('print-bill-vendor').innerText).toBe('Acme Cycles');
  });

  test('a bill against no PO says so rather than printing a blank', () => {
    PrintTemplates.billDocument({ ...BILL, poNumbers: [] }, DOC_DEPS);
    expect(document.getElementById('print-bill-po-ref').innerHTML).toBe('N/A');

    PrintTemplates.billDocument({ ...BILL, poNumbers: ['DIRECT'] }, DOC_DEPS);
    expect(document.getElementById('print-bill-po-ref').innerHTML)
      .toBe('Direct Purchase (No PO)');
  });

  test('the challan carries the consignee address, GSTIN and HSN', () => {
    // The difference that mattered most: the phone printed a GST delivery
    // challan with none of these three. Goods leave the factory on this
    // piece of paper.
    PrintTemplates.dispatchDocument(DISPATCH, CHALLAN_DEPS);

    expect(document.getElementById('print-dispatch-client').innerText).toBe('Nova Motors');
    expect(document.getElementById('print-dispatch-client-address').innerText)
      .toBe('12 Mill Road, Ludhiana');
    expect(document.getElementById('print-dispatch-client-gstin').innerText)
      .toBe('03ABCDE1234F1Z5');
    expect(document.getElementById('print-dispatch-items-body').innerHTML)
      .toContain('87141090');
  });

  test('the challan joins invoice and GR into one reference line', () => {
    PrintTemplates.dispatchDocument(DISPATCH, CHALLAN_DEPS);
    expect(document.getElementById('print-dispatch-gr-ref').innerText)
      .toBe('Inv: INV-1 | GR: GR-2');
  });

  test('a client not in Client Master still prints a challan', () => {
    expect(() => PrintTemplates.dispatchDocument(DISPATCH, DOC_DEPS)).not.toThrow();
    expect(document.getElementById('print-dispatch-number').innerText).toBe('DC-9');
    expect(document.getElementById('print-dispatch-client-gstin').innerText).toBe('');
  });

  test('all three escape what they print', () => {
    const nasty = '<img src=x onerror=alert(1)>';
    PrintTemplates.poDocument({ ...PO, items: [{ name: nasty, qty: 1, price: 1 }] }, DOC_DEPS);
    expect(document.getElementById('print-items-body').innerHTML).not.toContain('<img src=x');

    PrintTemplates.billDocument({ ...BILL, items: [{ name: nasty, qty: 1 }] }, DOC_DEPS);
    expect(document.getElementById('print-bill-items-body').innerHTML).not.toContain('<img src=x');

    PrintTemplates.dispatchDocument({ ...DISPATCH, items: [{ productName: nasty, qty: 1 }] }, CHALLAN_DEPS);
    expect(document.getElementById('print-dispatch-items-body').innerHTML).not.toContain('<img src=x');
  });

  test('missing deps degrade rather than throw', () => {
    expect(() => PrintTemplates.poDocument(PO, {})).not.toThrow();
    expect(() => PrintTemplates.billDocument(BILL, {})).not.toThrow();
    expect(() => PrintTemplates.dispatchDocument(DISPATCH, {})).not.toThrow();
    expect(() => PrintTemplates.poDocument(null, DOC_DEPS)).not.toThrow();
  });

  describe('neither shell keeps a second copy', () => {
    const read2 = f => require('fs').readFileSync(
      require('path').join(__dirname, '..', f), 'utf8');

    test('desktop delegates for PO, bill and challan', () => {
      expect(read2('po.js')).toContain('PrintTemplates.poDocument(');
      expect(read2('bill.js')).toContain('PrintTemplates.billDocument(');
      expect(read2('dispatch.js')).toContain('PrintTemplates.dispatchDocument(');
    });

    test('mobile calls the same three', () => {
      const m = read2('mobile.js');
      expect(m).toContain('PrintTemplates.poDocument(');
      expect(m).toContain('PrintTemplates.billDocument(');
      expect(m).toContain('PrintTemplates.dispatchDocument(');
    });

    test('and neither still builds its own rows inline', () => {
      // The marker each old copy was built around. If one comes back, the
      // documents have started drifting again.
      expect(read2('mobile.js')).not.toContain("setText('print-bill-grand-total'");
      expect(read2('mobile.js')).not.toContain("setText('print-ponum'");
      expect(read2('bill.js')).not.toContain("setText('print-bill-grand-total'");
      expect(read2('po.js')).not.toContain("setText('print-ponum'");
    });

    test('each shell states its own spelling of the deps once', () => {
      expect(read2('print.js')).toContain('templateDeps()');
      expect(read2('mobile.js')).toContain('templateDeps()');
    });
  });
});

describe('the per-record notes', () => {
  // These three build a self-contained page and return it, rather than
  // filling a container: desktop drops them into #print-bulk-body one per
  // record, and MApp.Print.bulk does the same. So the assertions read the
  // returned string.
  const NOTE_DEPS = {
    escapeHtml: s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    toNumber: v => Number(v) || 0,
    formatCurrency: v => `₹${(Number(v) || 0).toFixed(2)}`,
    formatNameCase: s => String(s == null ? '' : s)
      .toLowerCase().replace(/\b\w/g, c => c.toUpperCase()),
    brandHeaderHtml: () => '<div>Maharaja Bikes</div>'
  };

  const ISSUE = {
    issueId: 'ISS-12', date: '05/09/2026', issuedTo: 'anil KUMAR',
    reference: 'LOT-PNT041', remarks: 'for the paint line',
    totalQty: 12, totalValue: 0,
    items: [{ name: 'Primer', size: '5 L', unit: 'Ltr', qty: 12, rate: 0, value: 0 }]
  };

  const RETURN = {
    returnNumber: 'RET-3', returnDate: '06/09/2026', vendor: 'acme CYCLES',
    remarks: 'bent on arrival', totalQty: 4,
    items: [{ name: 'Rim 26', size: '26 inch', unit: 'Pcs', qty: 4, reason: 'Damaged' }]
  };

  const WASTAGE = {
    wastageId: 'WST-9', date: '07/09/2026', vendor: 'acme CYCLES',
    remarks: 'paint run',
    items: [{ name: 'Frame 20', size: '20 inch', unit: 'Pcs', qty: 2, reason: 'Rejected' }]
  };

  test('the issue receipt names the record, who took it and what for', () => {
    const html = PrintTemplates.issueNote(ISSUE, NOTE_DEPS);
    expect(html).toContain('ISS-12');
    expect(html).toContain('Anil Kumar');
    expect(html).toContain('LOT-PNT041');
    expect(html).toContain('Primer');
  });

  test('the issue receipt has somewhere to sign', () => {
    // It is a receipt. Somebody is taking goods off a shelf on it.
    expect(PrintTemplates.issueNote(ISSUE, NOTE_DEPS)).toContain('Received By');
  });

  test('the issue receipt drops the money column when nothing is valued', () => {
    expect(PrintTemplates.issueNote(ISSUE, NOTE_DEPS)).not.toContain('Total Value');

    const valued = { ...ISSUE, totalValue: 480,
      items: [{ ...ISSUE.items[0], rate: 40, value: 480 }] };
    expect(PrintTemplates.issueNote(valued, NOTE_DEPS)).toContain('Total Value');
  });

  test('an issue with no items says so rather than printing an empty table', () => {
    expect(PrintTemplates.issueNote({ ...ISSUE, items: [] }, NOTE_DEPS))
      .toContain('No items recorded');
  });

  test('the return note names the vendor and the reason', () => {
    const html = PrintTemplates.returnNote(RETURN, NOTE_DEPS);
    expect(html).toContain('RET-3');
    expect(html).toContain('Acme Cycles');
    expect(html).toContain('Damaged');
  });

  test('the wastage entry carries its id, date and reason', () => {
    const html = PrintTemplates.wastageNote(WASTAGE, NOTE_DEPS);
    expect(html).toContain('WST-9');
    expect(html).toContain('07/09/2026');
    expect(html).toContain('Rejected');
    expect(html).toContain('Acme Cycles');
  });

  test('all three escape what they print', () => {
    const nasty = '<img src=x onerror=alert(1)>';
    expect(PrintTemplates.issueNote({ ...ISSUE, items: [{ name: nasty, qty: 1 }] }, NOTE_DEPS))
      .not.toContain('<img src=x');
    expect(PrintTemplates.returnNote({ ...RETURN, items: [{ name: nasty, qty: 1 }] }, NOTE_DEPS))
      .not.toContain('<img src=x');
    expect(PrintTemplates.wastageNote({ ...WASTAGE, items: [{ name: nasty, qty: 1 }] }, NOTE_DEPS))
      .not.toContain('<img src=x');
  });

  test('missing deps degrade rather than throw', () => {
    expect(() => PrintTemplates.issueNote(ISSUE, {})).not.toThrow();
    expect(() => PrintTemplates.returnNote(RETURN, {})).not.toThrow();
    expect(() => PrintTemplates.wastageNote(WASTAGE, {})).not.toThrow();
  });

  describe('neither shell keeps a second copy', () => {
    const read3 = f => require('fs').readFileSync(
      require('path').join(__dirname, '..', f), 'utf8');

    test('desktop delegates all three', () => {
      expect(read3('issue.js')).toContain('PrintTemplates.issueNote(');
      expect(read3('return.js')).toContain('PrintTemplates.returnNote(');
      expect(read3('return.js')).toContain('PrintTemplates.wastageNote(');
    });

    test('mobile prints the notes, not only the log', () => {
      // The gap this closes: the phone printed a LIST of the issue log
      // where desktop printed the receipt a person signs.
      const m = read3('mobile.js');
      expect(m).toContain('PrintTemplates.issueNote(');
      expect(m).toContain('PrintTemplates.returnNote(');
      expect(m).toContain('PrintTemplates.wastageNote(');
    });

    test('mobile renders them through the shared bulk container', () => {
      // Same container desktop uses, so one note is one page either way.
      expect(read3('mobile.js')).toContain("'print-bulk-container'");
      expect(read3('mobile.js')).toContain('print-bulk-body');
    });

    test('and the log report is still reachable beside them', () => {
      // Both are real documents. The notes were added, the listing kept.
      const m = read3('mobile.js');
      expect(m).toContain('printAllNotes()');
      expect(m).toContain('printReport()');
    });
  });
});

describe('the contractor statement', () => {
  // Both shells build this one. The phone used to print the whole account
  // with no opening row and no period line, so a contractor at the gate
  // and the office were reading two different statements of one account.
  const LEDGER_DEPS = {
    escapeHtml: s => String(s == null ? '' : s).replace(/</g, '&lt;'),
    formatCurrency: v => `₹${(Number(v) || 0).toFixed(2)}`
  };

  const ENTRIES = [
    { date: '01/08/2026', dateRaw: '2026-08-01', type: 'Payable', ref: 'LOT-1',
      description: 'Painting', amount: 1000, rawAmount: 1000, balance: 1000 },
    { date: '05/08/2026', dateRaw: '2026-08-05', type: 'Payment', ref: 'PAY-1',
      description: 'On account', amount: -400, rawAmount: 400, balance: 600 },
    { date: '02/09/2026', dateRaw: '2026-09-02', type: 'Payable', ref: 'LOT-2',
      description: 'Fitting', amount: 250, rawAmount: 250, balance: 850 }
  ];

  test('a payable shows in the payable column and a payment in the paid one', () => {
    const html = PrintTemplates.contractorLedgerBody(ENTRIES, null, '', '', LEDGER_DEPS);
    expect(html).toContain('₹1000.00');
    expect(html).toContain('₹400.00');
    expect(html).toContain('₹850.00');
  });

  test('the opening row carries the balance into the window', () => {
    const html = PrintTemplates.contractorLedgerBody(
      ENTRIES.slice(2), 600, '2026-09-01', '', LEDGER_DEPS);
    expect(html).toContain('Opening');
    expect(html).toContain('Balance carried into the selected dates');
    expect(html).toContain('₹600.00');
  });

  test('no window means no opening row -- nothing is being excluded', () => {
    const html = PrintTemplates.contractorLedgerBody(ENTRIES, null, '', '', LEDGER_DEPS);
    expect(html).not.toContain('Opening');
  });

  test('an empty window says so, not "no transactions yet"', () => {
    // The difference matters: one means the account is new, the other
    // means you are looking at the wrong month.
    expect(PrintTemplates.contractorLedgerBody([], null, '2026-10-01', '', LEDGER_DEPS))
      .toContain('No transactions in the selected dates');
    expect(PrintTemplates.contractorLedgerBody([], null, '', '', LEDGER_DEPS))
      .toContain('No transactions yet for this contractor');
  });

  test('the period line names both ends, open or closed', () => {
    expect(PrintTemplates.ledgerPeriodLine('01/08/2026', '31/08/2026'))
      .toBe('Period: 01/08/2026 to 31/08/2026');
    expect(PrintTemplates.ledgerPeriodLine('01/08/2026', ''))
      .toBe('Period: 01/08/2026 to today');
    expect(PrintTemplates.ledgerPeriodLine('', '31/08/2026'))
      .toBe('Period: start to 31/08/2026');
    expect(PrintTemplates.ledgerPeriodLine('', '')).toBe('');
  });

  test('the carried-in balance is the last one before the window', () => {
    const asValue = e => e.dateRaw;
    expect(PrintTemplates.ledgerOpeningBalance(ENTRIES, '2026-09-01', asValue)).toBe(600);
    // Nothing before the window: the account starts at zero, not at null.
    expect(PrintTemplates.ledgerOpeningBalance(ENTRIES, '2026-01-01', asValue)).toBe(0);
    // No window at all: no opening row belongs on the page.
    expect(PrintTemplates.ledgerOpeningBalance(ENTRIES, '', asValue)).toBeNull();
  });

  test('it escapes what it prints', () => {
    const html = PrintTemplates.contractorLedgerBody(
      [{ ...ENTRIES[0], description: '<img src=x onerror=alert(1)>' }],
      null, '', '', LEDGER_DEPS);
    expect(html).not.toContain('<img src=x');
  });

  describe('both shells reach it', () => {
    const read4 = f => require('fs').readFileSync(
      require('path').join(__dirname, '..', f), 'utf8');

    test('desktop delegates the body, the period line and the opening balance', () => {
      const d = read4('contractor.js');
      expect(d).toContain('PrintTemplates.contractorLedgerBody(');
      expect(d).toContain('PrintTemplates.ledgerPeriodLine(');
      expect(d).toContain('PrintTemplates.ledgerOpeningBalance(');
    });

    test('mobile does too, and has a window to print', () => {
      const m = read4('mobile.js');
      expect(m).toContain('PrintTemplates.contractorLedgerBody(');
      expect(m).toContain('PrintTemplates.ledgerPeriodLine(');
      expect(m).toContain('PrintTemplates.ledgerOpeningBalance(');
      expect(m).toContain('contractor-ledger-from');
      expect(m).toContain('contractor-ledger-to');
    });

    test('one answer to "is this row in the period"', () => {
      // inDateRange moved into api.js, which both shells load, so a
      // statement cannot disagree with itself about which rows count.
      expect(read4('api.js')).toContain('function inDateRange(');
      expect(read4('mobile.js')).toContain('inDateRange(');
    });
  });
});

describe('the ledger documents', () => {
  const DOC = {
    escapeHtml: s => String(s == null ? '' : s).replace(/</g, '&lt;'),
    toNumber: v => Number(v) || 0,
    formatCurrency: v => `₹${(Number(v) || 0).toFixed(2)}`,
    formatNameCase: s => String(s == null ? '' : s)
      .toLowerCase().replace(/\b\w/g, c => c.toUpperCase()),
    formatQty: v => String(Number(v) || 0),
    brandHeaderHtml: () => '<div>Maharaja Bikes</div>'
  };

  describe('the vendor ledger', () => {
    const SRC = {
      pos: [{ poNumber: 'PO-1', vendor: 'Acme', poDate: '01/08/2026',
        items: [{ name: 'Rim 26', size: '26 inch', qty: 10, baseQty: 10 }] }],
      bills: [{ billNumber: 'B-1', vendor: 'Acme', billDate: '05/08/2026',
        items: [{ name: 'Rim 26', size: '26 inch', qty: 6, baseQty: 6, poNumber: 'PO-1' }] }],
      returns: [], issues: []
    };

    test('a PO orders and a bill receives, and what is left is pending', () => {
      const { pendingList } = PrintTemplates.vendorLedger('Acme', SRC, DOC);
      const rim = pendingList.find(p => p.name === 'Rim 26');
      expect(rim.ordered).toBe(10);
      expect(rim.received).toBe(6);
      expect(rim.pending).toBe(4);
    });

    test('a vendor with nothing against them has an empty ledger, not a crash', () => {
      const { ledger, pendingList } = PrintTemplates.vendorLedger('Nobody', SRC, DOC);
      expect(ledger).toEqual([]);
      expect(pendingList).toEqual([]);
    });

    test('the sheet is a whole page, so a shell with no detail screen can print it', () => {
      const html = PrintTemplates.vendorLedgerSheet({ name: 'acme' }, SRC, DOC);
      expect(html).toContain('Maharaja Bikes');
      expect(html).toContain('Acme');       // title-cased
      expect(html).toContain('PO-1');
    });
  });

  describe('the client ledger', () => {
    const SRC = {
      orders: [{
        orderNumber: 'SO-1', clientName: 'Nova', orderDate: '01/09/2026',
        status: 'Order Confirmed',
        lines: [{ productId: 'PRD-1', productName: 'Kalpi 26', qty: 40 }]
      }],
      dispatches: [{
        dispatchNumber: 'DC-1', clientName: 'Nova', dispatchDate: '08/09/2026',
        orderNumber: 'SO-1', productId: 'PRD-1', productName: 'Kalpi 26',
        qty: 25, transport: 'Blue Dart'
      }]
    };

    test('pending is ordered minus dispatched, per line', () => {
      const rows = PrintTemplates.pendingOrderLines('Nova', SRC, DOC);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ orderedQty: 40, dispatchedQty: 25, pendingQty: 15 });
    });

    test('a fully dispatched line drops off the pending list', () => {
      const done = { ...SRC, dispatches: [{ ...SRC.dispatches[0], qty: 40 }] };
      expect(PrintTemplates.pendingOrderLines('Nova', done, DOC)).toEqual([]);
    });

    test('only confirmed orders count as pending', () => {
      const draft = { ...SRC, orders: [{ ...SRC.orders[0], status: 'Draft' }] };
      expect(PrintTemplates.pendingOrderLines('Nova', draft, DOC)).toEqual([]);
    });

    test('all three sections appear, each with its own empty state', () => {
      const empty = PrintTemplates.clientLedgerSections('Ghost', SRC, DOC);
      expect(empty.ordersHtml).toContain('No PI / Estimates found');
      expect(empty.pendingHtml).toContain('All caught up');
      expect(empty.dispatchHtml).toContain('No dispatch records found');
    });

    test('the sheet carries the client, the orders and the challans', () => {
      const html = PrintTemplates.clientLedgerSheet(
        { name: 'nova', gstin: '03ABCDE1234F1Z5' }, SRC, DOC);
      expect(html).toContain('Nova');
      expect(html).toContain('03ABCDE1234F1Z5');
      expect(html).toContain('SO-1');
      expect(html).toContain('DC-1');
      expect(html).toContain('Pending Dispatch');
    });
  });

  describe('the BOM cost sheet', () => {
    const BOM = {
      productId: 'PRD-9', productName: 'Kalpi 26',
      components: [{ itemName: 'Rim 26', size: '26 inch', qtyPerProduct: 2, rate: 150, groupName: 'Wheels' }],
      additionalCosts: [{ description: 'Painting', rate: 40 }],
      totalCost: 300, totalAdditionalCost: 40
    };

    test('it names the product and its components', () => {
      const html = PrintTemplates.bomCostSheet(BOM, DOC);
      expect(html).toContain('Kalpi 26');
      expect(html).toContain('Rim 26');
    });

    test('a recipe with no components still prints', () => {
      expect(() => PrintTemplates.bomCostSheet(
        { productName: 'Empty', components: [] }, DOC)).not.toThrow();
    });
  });

  test('all four escape what they print', () => {
    const nasty = '<img src=x onerror=alert(1)>';
    expect(PrintTemplates.vendorLedgerSheet({ name: nasty },
      { pos: [], bills: [], returns: [], issues: [] }, DOC)).not.toContain('<img src=x');
    expect(PrintTemplates.clientLedgerSheet({ name: nasty },
      { orders: [], dispatches: [] }, DOC)).not.toContain('<img src=x');
    expect(PrintTemplates.bomCostSheet({ productName: nasty, components: [] }, DOC))
      .not.toContain('<img src=x');
  });

  describe('both shells reach them', () => {
    const read5 = f => require('fs').readFileSync(
      require('path').join(__dirname, '..', f), 'utf8');

    test('desktop delegates all four assemblers', () => {
      expect(read5('vendors.js')).toContain('PrintTemplates.vendorLedger(');
      expect(read5('vendors.js')).toContain('PrintTemplates.vendorLedgerSheet(');
      expect(read5('client.js')).toContain('PrintTemplates.pendingOrderLines(');
      expect(read5('bom.js')).toContain('PrintTemplates.bomCostSheet(');
      expect(read5('items.js')).toContain('PrintTemplates.itemLedgerSections(');
    });

    test('mobile prints all four', () => {
      const m = read5('mobile.js');
      expect(m).toContain('PrintTemplates.vendorLedgerSheet(');
      expect(m).toContain('PrintTemplates.clientLedgerSheet(');
      expect(m).toContain('PrintTemplates.bomCostSheet(');
      expect(m).toContain('PrintTemplates.itemLedgerSections(');
    });

    test('the print partial defines the utilities these rows are built from', () => {
      // index.html loads Bootstrap and mobile.html deliberately does not,
      // so without this block these rows print unstyled on a phone.
      const partial = require('fs').readFileSync(
        require('path').join(__dirname, '..', '..', '..',
          'templates', 'erp', 'partials', 'print.html'), 'utf8');
      ['.text-muted', '.text-end', '.fw-bold', '.badge', '.collapse.show']
        .forEach(sel => expect(partial).toContain(`.print-container ${sel}`));
    });
  });
});
