/**
 * The phone's PO card: the same Status dropdown as the desktop PO Ledger.
 *
 * Completed, Cancelled and Reopen come from poStatusChoices (api.js), which
 * both shells build their dropdown from. On the phone they are native
 * dialogs: one prompt names what stops being pending and takes the reason,
 * Reopen is a confirm. The server's message is the toast.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const line = o => ({ narration: '', unit: 'Pcs', price: 50, shortQty: 0, ...o });
const POS = [
  { poNumber: '1306', poDate: '24/10/2026', vendor: 'Mahadev industries', status: 'Partially Received',
    statusFromBills: 'Partially Received', closedAs: '', closedAt: '', closedBy: '', closeNote: '',
    totalQty: 2000, grandTotal: 85000,
    items: [line({ name: 'RIM---BLACK', size: '14 inch', qty: 1000, receivedQty: 600, pendingQty: 400 }),
      line({ name: 'RIM---BLACK', size: '16 inch', qty: 1000, receivedQty: 1000, pendingQty: 0 })] },
  { poNumber: '1307', poDate: '24/10/2026', vendor: 'Gurpreet industries', status: 'Completed',
    statusFromBills: 'Completed', closedAs: '', closedAt: '', closedBy: '', closeNote: '',
    totalQty: 500, grandTotal: 20000,
    items: [line({ name: 'RIM---BLACK', size: '14 inch', qty: 500, receivedQty: 500, pendingQty: 0 })] },
  { poNumber: '1280', poDate: '01/10/2026', vendor: 'Brahma paints', status: 'Cancelled',
    statusFromBills: 'PO Issued', closedAs: 'Cancelled', closedAt: '20/10/2026',
    closedBy: 'Karanbeer Singh', closeNote: 'Order off',
    totalQty: 100, grandTotal: 1000,
    items: [line({ name: 'PRIMER', size: '5 L', qty: 100, receivedQty: 0, pendingQty: 0, shortQty: 100 })] }
];

let calls;

beforeAll(() => {
  eval([
    read('api.js').replace(/^const Api = /m, 'global.Api = '),
    'global.escapeHtml = escapeHtml;',
    'global.toNumber = toNumber;',
    'global.formatCurrency = formatCurrency;',
    'global.formatQty = formatQty;',
    'global.PO_STATUS = PO_STATUS;',
    'global.poStatusChoices = poStatusChoices;',
    'global.dateToInputValue = dateToInputValue;',
    'global.todayIso = todayIso;'
  ].join('\n'));
  eval(read('print-templates.js').replace(/^const PrintTemplates = /m, 'global.PrintTemplates = '));
  eval(read('mobile.js').replace(/^const MApp = /m, 'global.MApp = '));
});

beforeEach(() => {
  document.body.innerHTML = '<input id="po-ledger-search"><div id="po-ledger-list"></div>';
  MApp.PO.pos = POS.map(po => JSON.parse(JSON.stringify(po)));
  MApp.PO.filtered = [...MApp.PO.pos];
  MApp.PO._pendingSyncCount = 0;
  MApp.Paging.reset('po');
  MApp.PO.render();

  calls = [];
  Api.mutateWithId = jest.fn(async (method, _id, ...args) => {
    calls.push([method, ...args]);
    return { success: true, message: `server: ${method}` };
  });
  MApp.Toast.success = jest.fn();
  MApp.Toast.error = jest.fn();
  MApp.PO._refreshLedger = jest.fn();
});

afterEach(() => {
  delete window.prompt;
  delete window.confirm;
});

const card = i => document.querySelectorAll('#po-ledger-list .mb-card')[i];
const selectIn = el => el.querySelector('select[data-po-action="status"]');
const optionsOf = sel => [...sel.options].map(o => o.textContent);
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function choose(sel, value) {
  sel.value = value;
  sel.dispatchEvent(new Event('change'));
}

test('each card offers what desktop offers', () => {
  expect(optionsOf(selectIn(card(0)))).toEqual(['Partially Received', 'Completed', 'Cancelled']);
  expect(selectIn(card(1))).toBeNull();
  expect(card(1).querySelector('.mb-chip').textContent).toBe('Completed');
  expect(optionsOf(selectIn(card(2)))).toEqual(['Cancelled', 'Reopen (PO Issued)']);
});

test('a cancelled card names what never came, and who cancelled it', () => {
  const text = card(2).textContent.replace(/\s+/g, ' ');
  expect(text).toContain('PRIMER [5 L]: 100 Pcs cancelled');
  expect(text).toContain('Cancelled by Karanbeer Singh, 20/10/2026 — “Order off”');
  expect(text).not.toContain('pending');
});

test('Completed asks once, with what stops being pending, and sends the reason', async () => {
  window.prompt = jest.fn(() => ' Short supplied ');
  choose(selectIn(card(0)), 'Completed');
  await settle();

  expect(window.prompt.mock.calls[0][0])
    .toBe('Mark PO 1306 complete?\n\nNo longer pending:\nRIM---BLACK [14 inch]: 400 Pcs\n\nReason (optional):');
  expect(calls).toEqual([['closePO', '1306', 'Completed', 'Short supplied']]);
  expect(MApp.Toast.success).toHaveBeenCalledWith('server: closePO');
  expect(MApp.PO._refreshLedger).toHaveBeenCalled();
  // The dropdown went back to what the PO is; the refresh redraws it.
  expect(selectIn(card(0)).value).toBe('Partially Received');
});

test('dismissing the prompt changes nothing', async () => {
  window.prompt = jest.fn(() => null);
  choose(selectIn(card(0)), 'Cancelled');
  await settle();
  expect(window.prompt.mock.calls[0][0]).toMatch(/^Cancel PO 1306\?/);
  expect(calls).toEqual([]);
});

test('Reopen asks to confirm', async () => {
  window.confirm = jest.fn(() => true);
  choose(selectIn(card(2)), 'reopen');
  await settle();
  expect(window.confirm.mock.calls[0][0]).toMatch(/^Reopen PO 1280\? It goes back to PO Issued/);
  expect(calls).toEqual([['reopenPO', '1280']]);
});

test('Edit and Delete still answer only their own buttons', () => {
  const edit = jest.spyOn(MApp.PO, 'openEditSheet').mockImplementation(() => {});
  const del = jest.spyOn(MApp.PO, 'deletePo').mockImplementation(() => {});
  selectIn(card(0)).dispatchEvent(new Event('click', { bubbles: true }));
  expect(edit).not.toHaveBeenCalled();
  expect(del).not.toHaveBeenCalled();
  card(0).querySelector('button[data-po-action="edit"]').click();
  expect(edit).toHaveBeenCalledTimes(1);
  edit.mockRestore();
  del.mockRestore();
});


test('a pending line names the size, and a two-unit PO totals each unit', () => {
  // PO 1099 orders RIM---BLACK in two sizes; the card read "RIM---BLACK:
  // 200 Pcs pending / RIM---BLACK: 1000 Pcs pending" with no way to tell.
  const text = card(0).textContent.replace(/\s+/g, ' ');
  expect(text).toContain('RIM---BLACK [14 inch]: 400 Pcs pending');
  expect(text).toContain('Qty: 2000 ·');

  MApp.PO.pos[0].items[1].unit = 'Pair';
  MApp.PO.render();
  expect(card(0).textContent.replace(/\s+/g, ' ')).toContain('Qty: 1000 Pcs + 1000 Pair ·');
});
