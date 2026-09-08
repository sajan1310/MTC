/**
 * The Stock movement panel, on the real item ledger endpoint (Phase 5,
 * D-03).
 *
 * It used to merge six datasets in the browser -- Bill, Return, Wastage,
 * Issue, Production and Stock-adjustment history -- on the recorded
 * grounds that no server endpoint existed. getItemLedgerData does exist,
 * desktop moved onto it, and its docstring says why deriving this client
 * side is wrong. Two of those ways were live in MApp:
 *
 *   - Quantities were as-entered, not base units, so a line entered in
 *     Dozen read 1 while moving 12 units of stock.
 *   - Every bill line was counted, including ones the operator had
 *     explicitly excluded from Stock through the stock-adjustment
 *     conflict flow. The server marks those countsTowardStock:false.
 *
 * It also cost six round trips per card expand, on a factory LAN, to
 * compute an answer the server already had.
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

const MOBILE_JS = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');

const ENTRIES = [
  {
    date: '14 Aug 2026', dateRaw: '2026-08-14', type: 'Bill Received', kind: 'BILL',
    ref: 'B-1042', party: 'acme cycles', size: '26 inch', narration: '',
    orderQty: 0, incomingQty: 120, outgoingQty: 0, price: 40,
    unit: 'Dozen', enteredQty: 10, balance: 320, countsTowardStock: true,
  },
  {
    date: '15 Aug 2026', dateRaw: '2026-08-15', type: 'Bill (Ledger only)', kind: 'BILL',
    ref: 'B-1043', party: 'acme cycles', size: '26 inch', narration: '',
    orderQty: 0, incomingQty: 50, outgoingQty: 0, price: 40,
    unit: 'Pcs', enteredQty: 50, balance: null, countsTowardStock: false,
  },
  {
    date: '16 Aug 2026', dateRaw: '2026-08-16', type: 'Wastage', kind: 'WASTAGE',
    ref: 'WST-3', party: '', size: '26 inch', narration: '',
    orderQty: 0, incomingQty: 0, outgoingQty: 8, price: null,
    unit: 'Pcs', enteredQty: 8, balance: 312, countsTowardStock: true,
  },
  {
    date: '16 Aug 2026', dateRaw: '2026-08-16', type: 'Bill Received', kind: 'BILL',
    ref: 'B-9', party: 'other', size: '24 inch', narration: '',
    orderQty: 0, incomingQty: 5, outgoingQty: 0, price: 10,
    unit: 'Pcs', enteredQty: 5, balance: 5, countsTowardStock: true,
  },
];

describe('MApp.Stock movement panel', () => {
  beforeEach(() => {
    jest.resetModules();
    global.fetch = jest.fn();
    document.body.innerHTML = '<div id="stock-expand-0"></div>';
    loadAsGlobal('api.js', 'Api');
    loadAsGlobal('mobile.js', 'MApp');
    MApp.Stock._ledgerCache = null;
    MApp.Api.call = jest.fn(async () => ({ success: true, data: { itemName: 'Rim 26', entries: ENTRIES } }));
  });

  const panel = () => document.getElementById('stock-expand-0').textContent;

  test('asks the server for the ledger, by item name', async () => {
    await MApp.Stock._renderMovements(0, { name: 'Rim 26', size: '26 inch' });

    expect(MApp.Api.call).toHaveBeenCalledWith('getItemLedgerData', 'Rim 26');
  });

  test('one request, not the six the client-side merge needed', async () => {
    await MApp.Stock._renderMovements(0, { name: 'Rim 26', size: '26 inch' });

    expect(MApp.Api.call).toHaveBeenCalledTimes(1);
  });

  test('filters to the size that was expanded', async () => {
    // The endpoint returns every size variant of the name; this panel is
    // per (name, size).
    await MApp.Stock._renderMovements(0, { name: 'Rim 26', size: '26 inch' });

    expect(panel()).toContain('B-1042');
    expect(panel()).not.toContain('B-9'); // the 24 inch row
  });

  test('shows base quantities, with the as-entered figure alongside', async () => {
    // The defect: a line entered in Dozen used to read 1 while moving 12.
    await MApp.Stock._renderMovements(0, { name: 'Rim 26', size: '26 inch' });

    expect(panel()).toContain('+120');      // base units, what actually moved
    expect(panel()).toContain('10 Dozen');  // and what was typed
  });

  test('a Ledger-only bill is shown but not counted', async () => {
    // The operator excluded it from Stock through the conflict flow, so
    // presenting it as a movement would contradict that choice.
    await MApp.Stock._renderMovements(0, { name: 'Rim 26', size: '26 inch' });

    expect(panel()).toContain('Bill (Ledger only)');
    expect(panel()).toContain('not counted');
    expect(panel()).not.toContain('+50');
  });

  test('outgoing movements read as negative', async () => {
    await MApp.Stock._renderMovements(0, { name: 'Rim 26', size: '26 inch' });
    expect(panel()).toContain('-8');
  });

  test('shows the running balance the server computed', async () => {
    await MApp.Stock._renderMovements(0, { name: 'Rim 26', size: '26 inch' });
    expect(panel()).toContain('bal 320');
  });

  test('caches per item name, so collapsing and re-expanding does not refetch', async () => {
    await MApp.Stock._renderMovements(0, { name: 'Rim 26', size: '26 inch' });
    await MApp.Stock._renderMovements(0, { name: 'Rim 26', size: '24 inch' });

    expect(MApp.Api.call).toHaveBeenCalledTimes(1);
  });

  test('an item with no movements says so', async () => {
    MApp.Api.call = jest.fn(async () => ({ success: true, data: { itemName: 'X', entries: [] } }));
    await MApp.Stock._renderMovements(0, { name: 'X', size: '' });

    expect(panel()).toContain('No recorded movements');
  });

  test('a failure is reported in the panel, not thrown', async () => {
    MApp.Api.call = jest.fn(async () => { throw new Error('offline'); });
    await MApp.Stock._renderMovements(0, { name: 'Rim 26', size: '26 inch' });

    expect(panel()).toContain("Couldn't load movement history");
    // Adjust stock stays reachable even when the history will not load.
    expect(document.querySelector('#stock-expand-0 .mb-btn-text')).not.toBeNull();
  });

  test('a business failure is reported too', async () => {
    MApp.Api.call = jest.fn(async () => ({ success: false, message: 'No such item.' }));
    await MApp.Stock._renderMovements(0, { name: 'Rim 26', size: '26 inch' });

    expect(panel()).toContain('No such item.');
  });

  test('a party name with markup cannot break the panel', async () => {
    MApp.Api.call = jest.fn(async () => ({
      success: true,
      data: { entries: [{ ...ENTRIES[0], party: '<script>x</script>', ref: 'B"1' }] },
    }));
    await MApp.Stock._renderMovements(0, { name: 'Rim 26', size: '26 inch' });

    expect(document.querySelector('#stock-expand-0 script')).toBeNull();
  });
});

describe('the client-side merge is gone', () => {
  test('no six-dataset merge survives', () => {
    // Leaving it in place would mean two implementations of the same
    // ledger disagreeing about the same item.
    expect(MOBILE_JS).not.toContain('_ensureLedgerSources');
    expect(MOBILE_JS).not.toContain('_computeMovements');
  });

  test('the panel goes through getItemLedgerData', () => {
    expect(MOBILE_JS).toContain("MApp.Api.call('getItemLedgerData'");
  });
});
