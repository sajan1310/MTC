/**
 * A stock count is where an item's stock starts from (migration 049), and
 * the Item Ledger has to read that way on both shells.
 *
 * getItemLedgerData replays each size so a count RESETS the running balance
 * to what was counted, entering as the variance from the book. A row a
 * later count already holds comes back `superseded`: it happened, and it
 * moved the balance up to that count, but it can never move the stock
 * again. Before this, a count was a muted "Manual Adjustment" with no
 * balance, and a lot completed after the count -- the BB-AXLE 2-C case --
 * came off the counted figure a second time with nothing on screen to say
 * why the number moved.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function loadAsGlobal(relPath, exportName) {
  const code = fs
    .readFileSync(path.join(__dirname, '..', relPath), 'utf8')
    .replace(new RegExp(`^const ${exportName} = `, 'm'), `global.${exportName} = `);
  // eslint-disable-next-line no-eval
  eval(code);
}

beforeEach(() => {
  jest.resetModules();
  global.fetch = jest.fn();
  document.body.innerHTML = '';
  // Each eval() gets its own scope, so api.js's plain function declarations
  // have to be republished for print-templates.js to see them.
  // eslint-disable-next-line no-eval
  eval([
    fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8')
      .replace(/^const Api = /m, 'global.Api = '),
    'global.escapeHtml = escapeHtml;',
    'global.toNumber = toNumber;',
    'global.formatCurrency = formatCurrency;',
    'global.formatQty = formatQty;',
    'global.parseRecordDate = parseRecordDate;',
    'global.dateToInputValue = dateToInputValue;',
    'global.inDateRange = inDateRange;',
    'global.todayIso = todayIso;'
  ].join('\n'));
  loadAsGlobal('print-templates.js', 'PrintTemplates');
  loadAsGlobal('mobile.js', 'MApp');
});

const DEPS = {
  escapeHtml: s => String(s == null ? '' : s),
  toNumber: v => Number(v) || 0,
  formatCurrency: v => `₹${(Number(v) || 0).toFixed(2)}`,
  formatNameCase: s => String(s == null ? '' : s),
  // Both real callers pass this; the stock table reads it per size.
  getPendingByItem: () => new Map()
};

// The shape the server returns for BB-AXLE 2-C on the 2026-10-07 snapshot,
// cut down to the rows that matter: newest first.
const ENTRIES = [
  {
    date: '05/10/2026', dateRaw: '2026-10-05', type: 'Production Consumption', kind: 'PRODUCTION',
    ref: 'LOT-FTD003-0037', party: 'Fitted Frame', size: 'GENERAL', narration: 'PRC-1089',
    orderQty: 0, incomingQty: 0, outgoingQty: 40, price: null, unit: 'Pcs', enteredQty: 40,
    balance: 4453, countsTowardStock: true, superseded: false, arrivedAfterCount: '',
  },
  {
    date: '04/08/2026', dateRaw: '2026-08-04', type: 'Stock Count', kind: 'ADJUSTMENT',
    ref: '-', party: 'er.karanbeer@gmail.com', size: 'GENERAL', narration: 'Inline edit via Stock table',
    orderQty: 0, incomingQty: 1646, outgoingQty: 0, price: null, unit: '', enteredQty: null,
    balance: 12200, countsTowardStock: true, superseded: false, arrivedAfterCount: '',
    countedQty: 12200, computedBalance: 10554, bookAtCount: 10852, variance: 1646,
  },
  {
    date: '08/07/2026', dateRaw: '2026-07-08', type: 'Production Consumption', kind: 'PRODUCTION',
    ref: 'LOT-FTD043-0002', party: 'Fitted Frame', size: 'GENERAL', narration: 'PRC-1130',
    orderQty: 0, incomingQty: 0, outgoingQty: 298, price: null, unit: 'Pcs', enteredQty: 298,
    balance: 8072, countsTowardStock: false, superseded: true, arrivedAfterCount: '',
  },
  {
    date: '03/07/2026', dateRaw: '2026-07-03', type: 'Bill Received', kind: 'BILL',
    ref: '240', party: 'Dua Forging', size: 'GENERAL', narration: 'black',
    orderQty: 0, incomingQty: 3750, outgoingQty: 0, price: 9, unit: 'Pcs', enteredQty: 3750,
    balance: 3370, countsTowardStock: false, superseded: true, arrivedAfterCount: '',
  },
];

const RECONCILIATION = [{
  size: 'GENERAL', initialStock: 968, countedStock: 12200,
  countedAt: '2026-08-04T12:50:56.367700+05:30', incomingQty: 0, outgoingQty: 7747,
  computedStock: 4453, currentStock: 4453, threshold: 3000, isLowStock: false, balanced: true,
}];

function sections(entries = ENTRIES, reconciliation = RECONCILIATION) {
  return PrintTemplates.itemLedgerSections('BB-AXLE    2-C', {
    items: [], stock: [], vendors: [], pos: [], bills: [],
    itemLedgers: { 'bb-axle    2-c': { entries, reconciliation } },
  }, DEPS);
}

function rowFor(html, ref) {
  const container = document.createElement('table');
  container.innerHTML = html;
  return [...container.querySelectorAll('tr')].find(tr => tr.textContent.includes(ref));
}

describe('the Item Ledger reads from the count', () => {
  test('a count shows what was counted against the book it replaced', () => {
    const { histHtml } = sections();
    const row = rowFor(histHtml, 'Stock Count');

    expect(row.textContent).toContain('counted 12200 against a book of 10554');
    // The Stock page said 10,852 when the count was entered: a lot dated
    // before the count reached the books after it. The ledger says so.
    expect(row.textContent).toContain('the book showed 10852 when counted');
    expect(row.textContent).toContain('1646'); // the variance, in the In column
    expect(row.className).toBe(''); // the count Current Stock starts from
  });

  test('a row a later count holds is muted and says which count holds it', () => {
    const { histHtml } = sections();
    const lot = rowFor(histHtml, 'LOT-FTD043-0002');

    expect(lot.className).toBe('text-muted');
    expect(lot.textContent).toContain('inside the 04/08/2026 count');
    expect(lot.textContent).toContain('298'); // it happened -- still shown
  });

  test('a row after the count reads as a live movement', () => {
    const { histHtml } = sections();
    const lot = rowFor(histHtml, 'LOT-FTD003-0037');

    expect(lot.className).toBe('');
    expect(lot.textContent).not.toContain('inside the');
  });

  test('a row delivered after a count it predates says why it sits there', () => {
    const late = [{
      ...ENTRIES[3], ref: 'INV-77', dateRaw: '2026-07-30', date: '30/07/2026',
      countsTowardStock: true, superseded: false, arrivedAfterCount: '2026-08-04', balance: 12300,
    }, ...ENTRIES.slice(1)];
    const { histHtml } = sections(late);

    expect(rowFor(histHtml, 'INV-77').textContent)
      .toContain('entered after the 04/08/2026 count');
  });

  test('the stock table starts from the last count, not Initial Stock', () => {
    const { stockHtml } = sections();

    expect(stockHtml).toContain('12200');
    expect(stockHtml).toContain('counted 04/08/2026');
    expect(stockHtml).not.toContain('>968<'); // initial_stock is not where it starts
  });

  test('a size nobody has counted shows its opening stock', () => {
    const { stockHtml } = sections([], [{
      ...RECONCILIATION[0], countedStock: null, countedAt: null, initialStock: 40,
    }]);

    expect(stockHtml).toContain('Not counted');
    expect(stockHtml).toContain('opening 40');
  });
});

describe('the phone stock card reads from the count', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="stock-expand-0"></div>';
    MApp.Stock._ledgerCache = null;
    MApp.Api.call = jest.fn(async () => ({
      success: true, data: { itemName: 'BB-AXLE    2-C', entries: ENTRIES },
    }));
  });

  const panel = () => document.getElementById('stock-expand-0').textContent;

  test('a count shows the figure counted, not a signed movement', async () => {
    await MApp.Stock._renderMovements(0, { name: 'BB-AXLE    2-C', size: 'GENERAL' });

    expect(panel()).toContain('counted 12200');
    expect(panel()).not.toContain('+1646');
  });

  test('a row inside the count keeps its quantity, labelled', async () => {
    await MApp.Stock._renderMovements(0, { name: 'BB-AXLE    2-C', size: 'GENERAL' });

    expect(panel()).toContain('-298 · inside count');
    expect(panel()).not.toContain('not counted');
  });
});
