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
