/**
 * Receiving processed items against a production lot, on the phone and the
 * storekeeper's tablet.
 *
 * A lot card says what an open lot has received and what is still to come;
 * its Receive button opens a sheet that records a delivery colour by colour
 * (asked for 2026-10-29). Completed or Cancelled on a partly received lot
 * asks first, as desktop does. The server is stubbed at MApp.Api.call and
 * Api.mutateWithId.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PARTIAL = f => fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', f), 'utf8');

function loadAsGlobal(relPath, exportName, extra = '') {
  const code = fs
    .readFileSync(path.join(__dirname, '..', relPath), 'utf8')
    .replace(new RegExp(`^const ${exportName} = `, 'm'), `global.${exportName} = `) + extra;
  eval(code);
}

const lot = o => ({
  processId: 'PRC-1', date: '23/10/2026', dateRaw: '2026-10-23', assignedTo: 'amarjeet',
  colorBreakdown: [], receivedQty: 0, balanceQty: 0, receiptCount: 0, ...o
});

const LOTS = [
  lot({ rowIdx: 1, lotNumber: 'LOT-PNT028-0002', qty: 200, status: 'In Progress', receivedQty: 90, balanceQty: 110, receiptCount: 1 }),
  lot({ rowIdx: 2, lotNumber: 'LOT-PNT024-0002', qty: 50, status: 'Pending', balanceQty: 50 }),
  lot({ rowIdx: 3, lotNumber: 'LOT-RF20-0061', qty: 100, status: 'Completed' }),
  lot({ rowIdx: 4, lotNumber: 'LOT-PC20SK-0002', qty: 600, status: 'Cancelled', receivedQty: 450, receiptCount: 2 })
];

const DETAIL = {
  lot: LOTS[0],
  canReceive: true,
  lines: [
    { color: 'Blue-White', size: '', qty: 70, received: 40, balance: 30 },
    { color: 'Pink-White', size: '', qty: 50, received: 50, balance: 0 },
    { color: 'Red-White', size: '', qty: 80, received: 0, balance: 80 }
  ],
  receipts: [
    { id: 11, date: '25/10/2026', dateRaw: '2026-10-25', qty: 90, remarks: 'challan 412', byName: 'Store',
      lines: [{ color: 'Blue-White', size: '', qty: 40 }, { color: 'Pink-White', size: '', qty: 50 }] }
  ]
};

let mutations;
let answer;
let toasts;

function mount(detail = DETAIL) {
  jest.resetModules();
  global.fetch = jest.fn();
  document.body.innerHTML = `
    <div id="mapp-sheet-backdrop"></div>
    <div id="production-list"></div>
    <div class="mb-toast-stack" id="mapp-toast-stack"></div>
    ${PARTIAL('mobile_views.html')}`;
  loadAsGlobal('api.js', 'Api', '\nglobal.PO_STATUS = PO_STATUS;');
  loadAsGlobal('mobile.js', 'MApp');
  MApp.Sheet._stack = [];
  MApp.Production.entries = MApp.Search.index(LOTS.map(l => ({ ...l })), MApp.Production.SEARCH);
  MApp.Production.searchTerm = '';
  MApp.Production.processById = { 'PRC-1': { processName: 'Frame Painting Curvy' } };
  MApp.Production.load = jest.fn();
  MApp.Production.render();

  mutations = [];
  answer = () => ({ success: true, message: 'ok', data: {} });
  Api.mutateWithId = jest.fn(async (method, _id, ...args) => {
    mutations.push([method, ...args]);
    return answer(method, args);
  });
  MApp.Api.call = jest.fn(async () => ({ success: true, data: JSON.parse(JSON.stringify(detail)) }));
  toasts = [];
  MApp.Toast.success = msg => toasts.push({ msg, isError: false });
  MApp.Toast.error = msg => toasts.push({ msg, isError: true });
}

const cards = () => [...document.querySelectorAll('#production-list .mb-card')];
const cardOf = n => cards().find(c => c.textContent.includes(n));
const receivedLine = n => {
  const el = cardOf(n).querySelector('.mapp-lot-received');
  return el ? el.textContent.trim() : '';
};
const receiveBtn = n => cardOf(n).querySelector('button[data-lot-action="receive"]');
const inputs = () => [...document.querySelectorAll('#receive-lot-body .mapp-receive-qty')];

describe('a lot card says what has come back', () => {
  beforeEach(() => mount());

  test('open lots: what was received, and the balance', () => {
    expect(receivedLine('LOT-PNT028-0002')).toBe('Received 90 · Balance 110');
    expect(receivedLine('LOT-PNT024-0002')).toBe('Balance 50');
  });

  test('a Completed lot adds nothing; a Cancelled one says what it received', () => {
    expect(receivedLine('LOT-RF20-0061')).toBe('');
    expect(receivedLine('LOT-PC20SK-0002')).toBe('Received 450');
  });

  test('Receive on open lots and on closed lots that have receipts', () => {
    expect(receiveBtn('LOT-PNT028-0002').getAttribute('aria-label')).toBe('Receive');
    expect(receiveBtn('LOT-PNT024-0002').getAttribute('aria-label')).toBe('Receive');
    expect(receiveBtn('LOT-RF20-0061')).toBeNull();
    expect(receiveBtn('LOT-PC20SK-0002').getAttribute('aria-label')).toBe('Receipts');
  });
});

describe('the Receive sheet', () => {
  beforeEach(() => mount());

  async function open() {
    receiveBtn('LOT-PNT028-0002').click();
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  test('one field per colour, closed where nothing is left', async () => {
    await open();
    expect(MApp.Api.call).toHaveBeenCalledWith('getProductionReceipts', 1);
    expect(document.getElementById('sheet-receive-lot').classList.contains('open')).toBe(true);
    const labels = [...document.querySelectorAll('#receive-lot-body .mb-field label')].map(l => l.textContent);
    expect(labels.slice(0, 3)).toEqual(['Blue-White', 'Pink-White', 'Red-White']);
    expect(inputs().map(i => i.disabled)).toEqual([false, true, false]);
    expect(document.getElementById('receive-lot-body').textContent).toContain('challan 412');
    expect(document.getElementById('receive-lot-footer').hidden).toBe(false);
  });

  test('All fills in the balance; Save sends the colours entered and reloads the list', async () => {
    await open();
    document.querySelector('#receive-lot-body .mapp-receive-all[data-line="0"]').click();
    expect(inputs()[0].value).toBe('30');
    inputs()[2].value = '5';
    answer = () => ({ success: true, message: 'Received 35 against Lot #LOT-PNT028-0002. 75 still to come.', data: {} });

    await MApp.Production.saveReceipt();

    expect(mutations).toHaveLength(1);
    const [method, form] = mutations[0];
    expect(method).toBe('saveProductionReceipt');
    expect(form.rowIdx).toBe(1);
    expect(form.lines).toEqual([{ color: 'Blue-White', size: '', qty: 30 }, { color: 'Red-White', size: '', qty: 5 }]);
    expect(form.date).toBe(MApp.Util.todayInputValue());
    expect(toasts).toEqual([{ msg: 'Received 35 against Lot #LOT-PNT028-0002. 75 still to come.', isError: false }]);
    expect(document.getElementById('sheet-receive-lot').classList.contains('open')).toBe(false);
    expect(MApp.Production.load).toHaveBeenCalledWith({ keep: true });
  });

  test('more than the balance never reaches the server', async () => {
    await open();
    inputs()[2].value = '81';
    await MApp.Production.saveReceipt();
    expect(mutations).toEqual([]);
    expect(toasts).toEqual([{ msg: 'Only 80 of Red-White are still to come.', isError: true }]);
  });

  test('a closed lot lists its receipts with no form and nothing to delete', async () => {
    mount({ ...DETAIL, lot: LOTS[3], canReceive: false, lines: DETAIL.lines.map(l => ({ ...l, balance: 0 })) });
    receiveBtn('LOT-PC20SK-0002').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const body = document.getElementById('receive-lot-body');
    expect(inputs()).toEqual([]);
    expect(body.textContent).toContain('This lot is Cancelled.');
    expect(body.querySelector('.mapp-receipt-delete')).toBeNull();
    expect(document.getElementById('receive-lot-footer').hidden).toBe(true);
  });
});

describe('a partly received lot\'s status asks first', () => {
  beforeEach(() => mount());

  test('declining leaves the lot as it was', async () => {
    window.confirm = jest.fn(() => false);
    const lotRow = LOTS[0];
    expect(await MApp.Production.changeStatus(lotRow, 'Completed')).toBe(false);
    expect(window.confirm.mock.calls[0][0]).toContain('counts the 110 not received yet as received now');
    expect(mutations).toEqual([]);
  });

  test('a lot nobody received against is not asked', async () => {
    window.confirm = jest.fn(() => false);
    answer = () => ({ success: true, message: 'done', data: {} });
    expect(await MApp.Production.changeStatus(LOTS[1], 'Completed')).toBe(true);
    expect(window.confirm).not.toHaveBeenCalled();
    expect(mutations).toEqual([['updateProductionStatus', 2, 50, 'Completed']]);
  });
});
