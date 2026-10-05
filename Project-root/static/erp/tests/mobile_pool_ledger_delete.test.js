/**
 * Deleting a manual line from the phone's pool ledger.
 *
 * A manual Warehouse Pool entry -- opening stock, a correction, a recount --
 * could only be deleted from Opening balances, which nobody reading a
 * bucket's ledger would think to open. The ledger now offers Delete on
 * exactly those lines, through the same flow as Opening balances: ask the
 * server what the bucket will read afterwards, say so, and only then
 * delete. The entry's own quantity is the wrong number to quote, because
 * removing a recount hands the bucket back to the count before it.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function loadAsGlobal(relPath, exportName) {
  const code = fs
    .readFileSync(path.join(__dirname, '..', relPath), 'utf8')
    .replace(new RegExp(`^const ${exportName} = `, 'm'), `global.${exportName} = `);
  eval(code);
}

const ROW = {
  rowIdx: 4, outputItemName: 'Rim 20', processId: 'P3', productTag: '', color: '',
  producedQty: 7, consumedQty: 0, availableQty: 7,
};

// Newest first, as the server sends it: a recount (manual) over the lot it
// absorbed (not deletable here -- a lot is deleted where it was entered).
const LEDGER = [
  { date: '05/10/2026', dateRaw: '2026-10-05', type: 'Recount', ref: '', remarks: 'Physical recount',
    inQty: 0, outQty: 3, balance: 7, superseded: false, countedQty: 7, computedBalance: 10,
    variance: -3, entryId: 42 },
  { date: '01/10/2026', dateRaw: '2026-10-01', type: 'Production Credit', ref: 'LOT-PNT005-0006',
    remarks: '', inQty: 10, outQty: 0, balance: 10, superseded: true, entryId: null },
];

// What previewDeleteWarehousePoolOpening answers for entry 42.
const PREVIEW = {
  rowIdx: 42, outputItemName: 'Rim 20', qty: -3, type: 'Recount', date: '05/10/2026',
  remarks: 'Physical recount', countedQty: 7, bucketName: 'Rim 20', bucketProductTag: '',
  bucketColor: '', currentQty: 7, qtyAfter: 10,
};

function mount() {
  jest.resetModules();
  global.fetch = jest.fn();
  document.body.innerHTML = `
    <div id="mapp-sheet-backdrop"></div>
    <div class="mb-sheet" id="sheet-pool">
      <div class="mb-search"><input type="search" id="pool-search"></div>
      <div class="mb-filter-chip-row" id="pool-filter-bar">
        <button class="mb-filter-chip active" data-pool-filter="all"></button>
      </div>
      <div id="pool-list"></div>
    </div>
    <div class="mb-sheet" id="sheet-pool-ledger">
      <h2 id="pool-ledger-title"></h2><div id="pool-ledger-body"></div>
    </div>
    <div class="mb-toast-stack" id="mapp-toast-stack"></div>`;
  loadAsGlobal('api.js', 'Api');
  loadAsGlobal('mobile.js', 'MApp');
  MApp.Sheet._stack = [];
  MApp.Paging._shown = {};
  window.confirm = jest.fn(() => true);
}

function answer(preview = { success: true, data: PREVIEW }) {
  MApp.Api.call = jest.fn(async method => {
    if (method === 'previewDeleteWarehousePoolOpening') return preview;
    if (method === 'getWarehousePoolLedger') return { success: true, data: LEDGER };
    if (method === 'getWarehousePoolData') return { success: true, data: [ROW] };
    return { success: false };
  });
}

const calls = method => MApp.Api.call.mock.calls.filter(([m]) => m === method);

beforeEach(() => {
  mount();
  answer();
  MApp.Util.mutateSimple = jest.fn(async () => ({ success: true, message: 'Entry deleted.' }));
});

test('only a manual line offers Delete', async () => {
  await MApp.Pool.openLedger(ROW);

  const [recount, lot] = document.querySelectorAll('#pool-ledger-body .mb-card');
  expect(recount.querySelector('[data-ledger-delete]')).not.toBeNull();
  expect(lot.querySelector('[data-ledger-delete]')).toBeNull();
});

test('Delete asks the server first, and quotes what the bucket will read', async () => {
  await MApp.Pool.openLedger(ROW);
  document.querySelector('#pool-ledger-body [data-ledger-delete]').click();
  await new Promise(resolve => setTimeout(resolve, 0));

  expect(MApp.Api.call).toHaveBeenCalledWith('previewDeleteWarehousePoolOpening', 42);
  const text = window.confirm.mock.calls[0][0];
  expect(text).toContain('the recount that counted 7');
  expect(text).toContain('Rim 20 will go from 7 to 10.');
  expect(text).toContain('cannot be put back with its original date');
});

test('a yes deletes with both expected values', async () => {
  await MApp.Pool.openLedger(ROW);
  await MApp.Pool.deleteLedgerEntry(LEDGER[0], ROW);

  expect(MApp.Util.mutateSimple).toHaveBeenCalledWith(
    'deleteWarehousePoolOpening', [42, 'Rim 20', -3], null);
});

test('a delete redraws the ledger and the pool without opening the sheet again', async () => {
  await MApp.Pool.openLedger(ROW);
  const depth = MApp.Sheet._stack.length;

  await MApp.Pool.deleteLedgerEntry(LEDGER[0], ROW);

  expect(MApp.Sheet._stack.length).toBe(depth);
  expect(calls('getWarehousePoolLedger')).toHaveLength(2);
  expect(calls('getWarehousePoolData').length).toBeGreaterThan(0);
});

test('declining sends nothing and redraws nothing', async () => {
  window.confirm = jest.fn(() => false);
  await MApp.Pool.openLedger(ROW);

  await MApp.Pool.deleteLedgerEntry(LEDGER[0], ROW);

  expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();
  expect(calls('getWarehousePoolLedger')).toHaveLength(1);
});

test('a preview the server refuses sends nothing, and says why', async () => {
  answer({ success: false, message: 'That entry no longer exists. Refresh and try again.' });
  await MApp.Pool.openLedger(ROW);

  await MApp.Pool.deleteLedgerEntry(LEDGER[0], ROW);

  expect(window.confirm).not.toHaveBeenCalled();
  expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();
  expect(document.getElementById('mapp-toast-stack').textContent).toContain('no longer exists');
});
