/**
 * openPoolLedgerModal talks to the server correctly (and says so when it
 * cannot).
 *
 * The ledger moved server-side (getWarehousePoolLedger) precisely so the
 * browser would stop reimplementing the pool's arithmetic. That removed five
 * bugs and introduced a sixth at the new seam: Api.call is VARIADIC --
 * call(method, ...args) -- and the call passed its three arguments as one
 * array. The server therefore received a single argument that happened to be
 * a list, stringified it into an output item name no bucket has, and
 * answered honestly: HTTP 200, success true, zero rows. Over a bucket with 19
 * real movements, that renders as "No transaction history found for this
 * bucket" -- a wrong answer wearing the costume of a right one.
 *
 * Nothing caught it. The backend tests POST {"args": [...]} straight at the
 * route, so they never cross Api.call; the old client-side tests called
 * buildPoolLedgerRows directly, and it no longer exists. This file covers
 * that seam.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function loadAsGlobal(relPath) {
  const code = fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8')
    .replace(/^const App = /m, 'global.App = ');
  // eslint-disable-next-line no-eval
  eval(code);
}

global.escapeHtml = str => String(str ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const NAME = 'Fitted Frame 20 inch Jungle King IBC Steel Rim';
const COLOR = 'Purple-Wine / Black';

let body;

beforeEach(() => {
  document.body.innerHTML =
    '<div id="poolLedgerTitle"></div><table><tbody id="poolLedgerBody"></tbody></table>';
  body = document.getElementById('poolLedgerBody');

  loadAsGlobal('core.js');
  App.Production = { formatQty: q => String(q) };
  global.safeModalShow = jest.fn();
  global.Api = { call: jest.fn() };
  loadAsGlobal('stock.js');
});

function open(name = NAME, tag = '', color = COLOR) {
  return App.Stock.openPoolLedgerModal(
    encodeURIComponent(name), encodeURIComponent(tag), encodeURIComponent(color));
}

describe('openPoolLedgerModal', () => {
  test('passes the bucket as three separate arguments, not one array', async () => {
    Api.call.mockResolvedValue({ success: true, data: [] });
    await open();

    expect(Api.call).toHaveBeenCalledTimes(1);
    // The whole finding, as one assertion.
    expect(Api.call).toHaveBeenCalledWith('getWarehousePoolLedger', NAME, '', COLOR);

    const [, ...args] = Api.call.mock.calls[0];
    expect(args).toHaveLength(3);
    args.forEach(a => expect(typeof a).toBe('string'));
  });

  test('renders the rows the server returns', async () => {
    Api.call.mockResolvedValue({
      success: true,
      data: [
        { date: '28/08/2026', type: 'Production Credit', ref: 'LOT-FTD028-0009',
          remarks: '', inQty: 6, outQty: 0, balance: 0 },
      ],
    });
    await open();

    expect(body.textContent).toContain('LOT-FTD028-0009');
    expect(body.textContent).toContain('Production Credit');
    expect(body.textContent).not.toContain('No transaction history');
  });

  test('a refused call shows the server message, not an empty ledger', async () => {
    // The masking bug this replaced: {success:false} folded into [] and
    // rendered as "No transaction history", which reads as data loss.
    Api.call.mockResolvedValue({ success: false, message: 'Colour must be text, got list.' });
    await open();

    expect(body.textContent).toContain('Colour must be text');
    expect(body.textContent).not.toContain('No transaction history');
  });

  test('a thrown error shows too', async () => {
    Api.call.mockRejectedValue(new Error('Backend method failed (HTTP 500).'));
    await open();

    expect(body.textContent).toContain('HTTP 500');
    expect(body.textContent).not.toContain('No transaction history');
  });

  test('a genuinely empty bucket still says so', async () => {
    Api.call.mockResolvedValue({ success: true, data: [] });
    await open();

    expect(body.textContent).toContain('No transaction history');
  });
});

describe('deleting a manual line', () => {
  // A recount (manual, deletable) over a lot it absorbed (not deletable
  // from here -- a lot is deleted where it was entered).
  const LEDGER = [
    { date: '05/10/2026', type: 'Recount', ref: '', remarks: 'Inline edit', inQty: 0, outQty: 51,
      balance: 0, superseded: false, countedQty: 0, computedBalance: 51, variance: -51, entryId: 42 },
    { date: '02/10/2026', type: 'Production Consumption', ref: 'LOT-FTD003-0036', remarks: '',
      inQty: 0, outQty: 10, balance: 40, superseded: true, entryId: null },
  ];
  // What previewDeleteWarehousePoolOpening answers for entry 42.
  const PREVIEW = {
    rowIdx: 42, outputItemName: NAME, qty: -1, type: 'Recount', date: '05/10/2026',
    remarks: 'Inline edit', countedQty: 0, bucketName: NAME, bucketProductTag: '',
    bucketColor: COLOR, currentQty: 0, qtyAfter: 1,
  };
  let confirm;

  function answer(preview = { success: true, data: PREVIEW }) {
    Api.call.mockImplementation(async method => (method === 'previewDeleteWarehousePoolOpening'
      ? preview
      : { success: true, data: LEDGER }));
  }
  const ledgerCalls = () => Api.call.mock.calls.filter(([m]) => m === 'getWarehousePoolLedger');

  beforeEach(() => {
    answer();
    Api.mutate = jest.fn(async () => ({ success: true, message: 'Entry deleted.' }));
    confirm = null;
    App.Utils.confirmAction = jest.fn((message, onYes) => { confirm = { message, onYes }; });
    App.Utils.showToast = jest.fn();
    App.Stock.loadWarehousePoolData = jest.fn(async () => {});
  });

  test('only a manual line has a delete button', async () => {
    await open();

    const [recount, lot] = [...body.querySelectorAll('tr')];
    expect(recount.querySelector('button[onclick="App.Stock.deletePoolLedgerEntry(42)"]')).not.toBeNull();
    expect(lot.querySelector('button')).toBeNull();
  });

  test('asks the server what the bucket will read, and says that', async () => {
    await open();
    await App.Stock.deletePoolLedgerEntry(42);

    expect(Api.call).toHaveBeenCalledWith('previewDeleteWarehousePoolOpening', 42);
    expect(confirm.message).toContain('the Recount that counted 0');
    expect(confirm.message).toContain(`${NAME} [${COLOR}] will go from 0 to 1.`);
    expect(confirm.message).toContain('cannot be put back with its original date');
    // Nothing is deleted before the answer is yes.
    expect(Api.mutate).not.toHaveBeenCalled();
  });

  test('a deletion that moves nothing says the bucket stays', async () => {
    answer({ success: true, data: { ...PREVIEW, qty: 10, currentQty: 0, qtyAfter: 0 } });
    await open();
    await App.Stock.deletePoolLedgerEntry(42);

    expect(confirm.message).toContain('stays at 0.');
    expect(confirm.message).not.toContain('will go from');
  });

  test('a yes deletes with both expected values and redraws the ledger in place', async () => {
    await open();
    await App.Stock.deletePoolLedgerEntry(42);
    await confirm.onYes();

    expect(Api.mutate).toHaveBeenCalledWith('deleteWarehousePoolOpening', 42, NAME, -1);
    expect(App.Utils.showToast).toHaveBeenCalledWith('Entry deleted.', false);
    expect(App.Stock.loadWarehousePoolData).toHaveBeenCalled();
    expect(ledgerCalls()).toHaveLength(2);
    expect(ledgerCalls()[1]).toEqual(['getWarehousePoolLedger', NAME, '', COLOR]);
    // Redrawn, not reopened: showing it again under the closing confirm
    // dialog would read as a nested modal.
    expect(safeModalShow).toHaveBeenCalledTimes(1);
  });

  test('a refused preview deletes nothing and says why', async () => {
    answer({ success: false, message: 'That entry no longer exists. Refresh and try again.' });
    await open();
    await App.Stock.deletePoolLedgerEntry(42);

    expect(App.Utils.confirmAction).not.toHaveBeenCalled();
    expect(Api.mutate).not.toHaveBeenCalled();
    expect(App.Utils.showToast).toHaveBeenCalledWith('That entry no longer exists. Refresh and try again.', true);
  });

  test('a refused delete leaves everything as it was', async () => {
    Api.mutate = jest.fn(async () => ({
      success: false, message: 'Data mismatch: The entry has been modified or shifted. Please refresh.',
    }));
    await open();
    await App.Stock.deletePoolLedgerEntry(42);
    await confirm.onYes();

    expect(App.Utils.showToast).toHaveBeenCalledWith(expect.stringContaining('Data mismatch'), true);
    expect(App.Stock.loadWarehousePoolData).not.toHaveBeenCalled();
    expect(ledgerCalls()).toHaveLength(1);
  });

  test('the Add Opening Stock window deletes through the same flow', async () => {
    App.Stock.loadWarehouseOpeningData = jest.fn(async () => {});
    await App.Stock.deleteWarehouseOpeningEntry(42);

    expect(Api.call).toHaveBeenCalledWith('previewDeleteWarehousePoolOpening', 42);
    // The old wording, which a recount does not honour.
    expect(confirm.message).not.toContain('reduce the Warehouse Pool bucket by that quantity');
    await confirm.onYes();
    expect(Api.mutate).toHaveBeenCalledWith('deleteWarehousePoolOpening', 42, NAME, -1);
    expect(App.Stock.loadWarehouseOpeningData).toHaveBeenCalled();
  });
});
