/**
 * Vendor Ledger running balance.
 *
 * The column answers "net units taken from this vendor to date": bills add,
 * returns and issues subtract. Two properties decide whether it is truthful,
 * and both are easy to break by editing calculateLedgerAndPending without
 * noticing the balance depends on it:
 *
 *   1. A PO does not move the balance. A purchase order is an intent to buy;
 *      the goods arrive later as a Bill with its own row. Counting both would
 *      report every order twice. This is the same rule as countsTowardStock
 *      in get_item_ledger_data, which excludes PO rows for the same reason.
 *
 *   2. It accumulates in DATE order while the table displays newest-first.
 *      Accumulating in display order would run the arithmetic backwards and
 *      produce a column that descends from the total to the first movement --
 *      wrong in a way that still looks plausible, since the top row would
 *      hold the right number.
 *
 * Run against the real vendors.js with the same loader the rest of the
 * frontend suite uses.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function loadVendors() {
  const api = [
    fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8'),
    'global.escapeHtml = escapeHtml;',
    'global.toNumber = toNumber;',
    'global.formatCurrency = formatCurrency;',
    'global.formatQty = formatQty;',
    'global.parseRecordDate = parseRecordDate;',
  ].join('\n');
  eval(api);

  // The ledger assembler lives in print-templates.js, which both shells
  // load -- one vendor ledger, not one per shell.
  // eslint-disable-next-line no-eval
  eval(fs.readFileSync(path.join(__dirname, '..', 'print-templates.js'), 'utf8')
    .replace(/^const PrintTemplates = /m, 'global.PrintTemplates = '));

  const core = fs
    .readFileSync(path.join(__dirname, '..', 'core.js'), 'utf8')
    .replace(/^const App = /m, 'global.App = ');
  eval(core);

  eval(fs.readFileSync(path.join(__dirname, '..', 'vendors.js'), 'utf8'));
}

const VENDOR = 'Sharma Cycles';

// Entries come back newest-first (display order); read them reversed to walk
// the balance forwards in time.
function ledgerFor(vendorName) {
  return App.Vendor.calculateLedgerAndPending(vendorName).ledger;
}

function balancesInDateOrder(vendorName) {
  return [...ledgerFor(vendorName)].reverse().map(e => ({ ref: e.ref, balance: e.balance }));
}

beforeEach(() => {
  document.body.innerHTML = '';
  loadVendors();
  App.State.globalPOs = [];
  App.State.globalBills = [];
  App.State.globalReturns = [];
  App.State.globalIssues = [];
});

describe('Vendor Ledger running balance', () => {
  test('bills add and returns subtract, in date order', () => {
    App.State.globalBills = [{
      vendor: VENDOR, billNumber: 'B-1', billDate: '05/01/2026',
      items: [{ name: 'Rim', qty: 30 }], totalAmount: 1200
    }];
    App.State.globalReturns = [{
      vendor: VENDOR, returnNumber: 'R-1', returnDate: '09/01/2026',
      items: [{ name: 'Rim', qty: 4 }], totalAmount: 160
    }];

    expect(balancesInDateOrder(VENDOR)).toEqual([
      { ref: 'B-1', balance: 30 },
      { ref: 'R-1', balance: 26 },
    ]);
  });

  test('a stock issue subtracts too', () => {
    App.State.globalBills = [{
      vendor: VENDOR, billNumber: 'B-1', billDate: '01/01/2026',
      items: [{ name: 'Rim', qty: 50 }], totalAmount: 500
    }];
    App.State.globalIssues = [{
      vendor: VENDOR, issueId: 'I-1', date: '02/01/2026',
      items: [{ name: 'Rim', qty: 12 }], totalQty: 12, totalValue: 120
    }];

    expect(balancesInDateOrder(VENDOR)).toEqual([
      { ref: 'B-1', balance: 50 },
      { ref: 'I-1', balance: 38 },
    ]);
  });

  test('a PO carries no balance and does not move the running total', () => {
    // The PO sits BETWEEN the two bills in time, so if it were counted the
    // bill after it would be off by the ordered quantity.
    App.State.globalPOs = [{
      vendor: VENDOR, poNumber: '7', poDate: '02/01/2026',
      items: [{ name: 'Rim', qty: 999 }], grandTotal: 9990
    }];
    App.State.globalBills = [
      { vendor: VENDOR, billNumber: 'B-1', billDate: '01/01/2026', items: [{ name: 'Rim', qty: 10 }], totalAmount: 100 },
      { vendor: VENDOR, billNumber: 'B-2', billDate: '03/01/2026', items: [{ name: 'Rim', qty: 5 }], totalAmount: 50 },
    ];

    expect(balancesInDateOrder(VENDOR)).toEqual([
      { ref: 'B-1', balance: 10 },
      { ref: 'PO-7', balance: null },
      { ref: 'B-2', balance: 15 },
    ]);
  });

  test('the newest row closes on the net of every movement', () => {
    App.State.globalPOs = [{
      vendor: VENDOR, poNumber: '1', poDate: '01/01/2026',
      items: [{ name: 'Rim', qty: 100 }], grandTotal: 1000
    }];
    App.State.globalBills = [{
      vendor: VENDOR, billNumber: 'B-1', billDate: '02/01/2026',
      items: [{ name: 'Rim', qty: 40 }, { name: 'Tube', qty: 20 }], totalAmount: 600
    }];
    App.State.globalReturns = [{
      vendor: VENDOR, returnNumber: 'R-1', returnDate: '03/01/2026',
      items: [{ name: 'Rim', qty: 6 }], totalAmount: 60
    }];

    // Display order is newest-first, so the FIRST row holds the closing
    // balance -- that is the number a reader takes away from the table.
    const displayed = ledgerFor(VENDOR);
    expect(displayed[0].ref).toBe('R-1');
    expect(displayed[0].balance).toBe(54); // (40 + 20) - 6, PO excluded
  });

  test('returning more than was received shows a negative, not a floor of zero', () => {
    // Worth surfacing: it means the ledger is missing a receipt, or goods
    // were returned against a bill recorded under another vendor.
    App.State.globalBills = [{
      vendor: VENDOR, billNumber: 'B-1', billDate: '01/01/2026',
      items: [{ name: 'Rim', qty: 5 }], totalAmount: 50
    }];
    App.State.globalReturns = [{
      vendor: VENDOR, returnNumber: 'R-1', returnDate: '02/01/2026',
      items: [{ name: 'Rim', qty: 8 }], totalAmount: 80
    }];

    expect(balancesInDateOrder(VENDOR)).toEqual([
      { ref: 'B-1', balance: 5 },
      { ref: 'R-1', balance: -3 },
    ]);
  });

  test('the rendered table shows the balance, and a dash for the PO row', () => {
    App.State.globalPOs = [{
      vendor: VENDOR, poNumber: '7', poDate: '01/01/2026',
      items: [{ name: 'Rim', qty: 20 }], grandTotal: 200
    }];
    App.State.globalBills = [{
      vendor: VENDOR, billNumber: 'B-1', billDate: '02/01/2026',
      items: [{ name: 'Rim', qty: 20 }], totalAmount: 200
    }];

    document.body.innerHTML = `
      <table><tbody id="vendorLedgerBody"></tbody></table>
      <table><tbody id="vendorPendingBody"></tbody></table>
      <table><tbody id="vendorRatesBody"></tbody></table>`;
    App.Vendor.populateLedgerAndPending(VENDOR);

    const rows = document.querySelectorAll('#vendorLedgerBody tr');
    expect(rows).toHaveLength(2);
    // Every row must have the same cell count as the header, or the print
    // layout (which is handed this tbody's innerHTML) misaligns.
    rows.forEach(tr => expect(tr.querySelectorAll('td')).toHaveLength(9));

    // Newest first: the bill, then the PO.
    expect(rows[0].querySelectorAll('td')[7].textContent.trim()).toBe('20');
    expect(rows[1].querySelectorAll('td')[7].textContent.trim()).toBe('-');
  });
});


// The Pending Orders tab and the vendor list's badge (audit 2026-10-29).
// Figures are in each PO's own unit, labelled and rounded: in base units
// with no unit, spokes ordered as 450 Gross read "64800", and a fractional
// Gross surfaced as 50100.004799999995. The badge counts items, because
// pieces, pairs and Gross of spokes added together meant nothing.
describe('the vendor\'s pending orders', () => {
  const SPOKES = { name: 'Spoke', size: '16 inch', narration: '', qty: 450, unit: 'Gross', baseQty: 64800 };
  const RIMS = { name: 'Rim', size: '20 inch', narration: '', qty: 1000, unit: 'Pcs', baseQty: 1000 };

  beforeEach(() => {
    App.State.globalPOs = [{
      vendor: VENDOR, poNumber: '1214', poDate: '26/08/2026',
      items: [SPOKES, RIMS], grandTotal: 1
    }];
    App.State.globalBills = [{
      vendor: VENDOR, billNumber: 'B-9', billDate: '30/08/2026', totalAmount: 1,
      items: [
        // 2.08 Gross, entered in pieces: a fraction of a Gross.
        { name: 'Spoke', size: '16 inch', narration: '', qty: 299.52, unit: 'Pcs', baseQty: 299.52, poNumber: '1214' },
        { name: 'Rim', size: '20 inch', narration: '', qty: 400, unit: 'Pcs', baseQty: 400, poNumber: '1214' }
      ]
    }];
  });

  test('are in each PO\'s own unit, labelled, with no float noise', () => {
    document.body.innerHTML = '<table><tbody id="vendorPendingBody"></tbody></table>';
    App.Vendor.populateLedgerAndPending(VENDOR);
    const rows = [...document.querySelectorAll('#vendorPendingBody tr')]
      .map(tr => [...tr.cells].map(td => td.textContent.replace(/\s+/g, ' ').trim()));
    expect(rows).toEqual([
      ['Spoke', '16 inch', '450 Gross', '2.08 Gross', '447.92 Gross'],
      ['Rim', '20 inch', '1000 Pcs', '400 Pcs', '600 Pcs']
    ]);
  });

  test('the vendor list counts items pending, not units', () => {
    document.body.innerHTML = '<table><tbody id="vendorTableBody"></tbody></table>';
    App.State.filteredVendors = [{ name: VENDOR }];
    App.State.vendorCurrentPage = 1;
    App.State.vendorRowsPerPage = 15;
    App.State.selectedVendors = [];
    App.Utils.renderPagination = () => {};
    App.Vendor.renderTable();
    expect(document.querySelector('#vendorTableBody .badge.bg-warning').textContent).toBe('2 Items Pending');
  });
});
