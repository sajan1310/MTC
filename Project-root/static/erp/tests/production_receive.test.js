/**
 * Receiving processed items against a production lot, in parts.
 *
 * A lot was either Completed or not, and a job-work lot often comes back in
 * pieces (asked for 2026-10-29). The Production Log now shows what an open
 * lot has received and what is still to come, Receive records a delivery
 * colour by colour, and Completed / Cancelled on a partly received lot asks
 * first: Completed counts the balance as received, Cancelled drops it.
 *
 * Run against the real production.js, core.js, api.js and production.html;
 * the server is stubbed at Api.call / Api.mutate.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const PARTIAL = f => fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', f), 'utf8');

const lot = o => ({
  date: '23/10/2026', dateRaw: '2026-10-23', processId: 'PRC-1', productId: '', productName: '',
  outputItemName: 'Painted Frame Curvy 20 inch', assignedBy: '', assignedTo: 'amarjeet',
  remarks: '', colorBreakdown: [], color: '', contractorPayable: 0, extraChargeType: '',
  receivedQty: 0, balanceQty: 0, receiptCount: 0, ...o
});

const LOTS = [
  lot({ rowIdx: 1, lotNumber: 'LOT-PNT028-0002', qty: 200, status: 'In Progress',
    receivedQty: 90, balanceQty: 110, receiptCount: 1 }),
  lot({ rowIdx: 2, lotNumber: 'LOT-PNT024-0002', qty: 50, status: 'Pending', balanceQty: 50 }),
  lot({ rowIdx: 3, lotNumber: 'LOT-RF20-0061', qty: 100, status: 'Completed' }),
  lot({ rowIdx: 4, lotNumber: 'LOT-MP20HF-0004', qty: 600, status: 'Completed', receivedQty: 600, receiptCount: 3 }),
  lot({ rowIdx: 5, lotNumber: 'LOT-PC20SK-0002', qty: 600, status: 'Cancelled', receivedQty: 450, receiptCount: 2 })
];

// As getProductionReceipts returns LOT-PNT028-0002.
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
let confirmCb;

beforeAll(() => {
  document.body.innerHTML = PARTIAL('production.html');
  eval([
    read('api.js').replace(/^const Api = /m, 'global.Api = '),
    'global.escapeHtml = escapeHtml;',
    'global.toNumber = toNumber;',
    'global.formatCurrency = formatCurrency;',
    'global.PO_STATUS = PO_STATUS;'
  ].join('\n'));
  eval(read('core.js').replace(/^const App = /m, 'global.App = '));
  eval(read('production.js'));
});

beforeEach(() => {
  App.State.globalProcesses = [{ processId: 'PRC-1', processName: 'Frame Painting Curvy' }];
  App.State.globalProduction = LOTS.map(l => JSON.parse(JSON.stringify(l)));
  App.State.filteredProduction = [...App.State.globalProduction];
  App.State.selectedProduction = [];
  App.State.productionCurrentPage = 1;
  App.State.productionRowsPerPage = 50;
  App.Production.renderTable();

  mutations = [];
  answer = () => ({ success: true, message: 'ok', data: {} });
  Api.mutate = jest.fn(async (method, ...args) => {
    mutations.push([method, ...args]);
    return answer(method, args);
  });
  Api.call = jest.fn(async () => ({ success: true, data: JSON.parse(JSON.stringify(DETAIL)) }));
  toasts = [];
  App.Utils.showToast = (msg, isError) => toasts.push({ msg, isError: !!isError });
  confirmCb = null;
  App.Utils.confirmAction = (msg, cb) => { confirmCb = { msg, cb }; };
});

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const rowOf = id => document.querySelector(`#productionTableBody tr[data-row-key="${id}"]`);
const text = el => el.textContent.replace(/\s+/g, ' ').trim();
const qtyCell = id => rowOf(id).querySelectorAll('td')[5];
// The cell's parts -- the lot, then each line under it -- one space apart.
const qtyText = id => [...qtyCell(id).childNodes].map(n => n.textContent.trim()).filter(Boolean).join(' ');
const buttons = id => [...rowOf(id).querySelectorAll('td:last-child button')].map(b => b.textContent.trim());

describe('the Production Log shows what has come back', () => {
  test('an open lot received in part: lot, received and balance', () => {
    expect(qtyText(1)).toBe('200 Units Received 90 Balance 110');
  });

  test('an open lot with nothing back yet: its whole quantity is the balance', () => {
    expect(qtyText(2)).toBe('50 Units Balance 50');
  });

  test('a Completed lot shows its quantity alone', () => {
    expect(qtyText(3)).toBe('100 Units');
    expect(qtyText(4)).toBe('600 Units');
  });

  test('a Cancelled lot says what it received before the rest was dropped', () => {
    expect(qtyText(5)).toBe('600 Units Received 450');
  });

  test('open lots can be received; closed ones with receipts show them', () => {
    expect(buttons(1)[0]).toBe('Receive');
    expect(buttons(2)[0]).toBe('Receive');
    expect(buttons(3)).not.toContain('Receive');
    expect(buttons(3)).not.toContain('Receipts');
    expect(buttons(4)[0]).toBe('Receipts');
    expect(buttons(5)[0]).toBe('Receipts');
  });

  test('a lot\'s connections show under its number', () => {
    App.LotRef = { tagsHtml: refs => `<div class="tags">${refs.length}</div>` };
    const html = App.Production.rowHtml(lot({ rowIdx: 9, lotNumber: 'LOT-PK-0001', qty: 5, lotRefs: [{ rowIdx: 1 }] }), 0);
    delete App.LotRef;

    expect(html).toMatch(/LOT-PK-0001<\/span><div class="tags">1<\/div><\/td>/);
  });
});

describe('receiving', () => {
  const inputs = () => [...document.querySelectorAll('#receiveLotLines .receive-line-qty')];

  async function open() {
    await App.Production.openReceiveModal(String(App.State.globalProduction.findIndex(p => p.rowIdx === 1)));
  }

  test('each colour with what it still has to come; a colour already in is closed', async () => {
    await open();
    expect(Api.call).toHaveBeenCalledWith('getProductionReceipts', 1);
    const rows = [...document.querySelectorAll('#receiveLotLines tr')].map(tr =>
      [...tr.querySelectorAll('td')].slice(0, 4).map(td => text(td)));
    expect(rows).toEqual([
      ['Blue-White', '70', '40', '30'],
      ['Pink-White', '50', '50', '0'],
      ['Red-White', '80', '0', '80']
    ]);
    expect(inputs().map(i => i.disabled)).toEqual([false, true, false]);
    expect(document.getElementById('receiveLotTitle').textContent).toBe('Receive — Lot #LOT-PNT028-0002');
    expect(document.getElementById('receiveLotDate').min).toBe('2026-10-23');
    expect(text(document.getElementById('receiveLotHistory'))).toContain('challan 412');
  });

  test('All fills in a colour\'s balance, and the total follows', async () => {
    await open();
    App.Production.receiveAll(0);
    expect(inputs()[0].value).toBe('30');
    expect(document.getElementById('receiveLotTotal').textContent).toBe('Receiving 30 now');
  });

  test('Save sends only the colours with a quantity, and patches the row', async () => {
    await open();
    inputs()[0].value = '30';
    inputs()[2].value = '25';
    document.getElementById('receiveLotRemarks').value = ' van 2 ';
    answer = () => ({
      success: true,
      message: 'Received 55 against Lot #LOT-PNT028-0002. 55 still to come.',
      data: { receiptId: 12, row: { ...LOTS[0], receivedQty: 145, balanceQty: 55, receiptCount: 2 } }
    });

    await App.Production.submitReceipt();

    expect(mutations).toEqual([['saveProductionReceipt', {
      rowIdx: 1,
      date: document.getElementById('receiveLotDate').value,
      remarks: 'van 2',
      lines: [{ color: 'Blue-White', size: '', qty: 30 }, { color: 'Red-White', size: '', qty: 25 }]
    }]]);
    expect(toasts).toEqual([{ msg: 'Received 55 against Lot #LOT-PNT028-0002. 55 still to come.', isError: false }]);
    expect(qtyText(1)).toBe('200 Units Received 145 Balance 55');
  });

  test('more than a colour\'s balance never reaches the server', async () => {
    await open();
    inputs()[0].value = '31';
    await App.Production.submitReceipt();
    expect(mutations).toEqual([]);
    expect(toasts).toEqual([{ msg: 'Only 30 of Blue-White are still to come.', isError: true }]);
  });

  test('nothing entered never reaches the server', async () => {
    await open();
    await App.Production.submitReceipt();
    expect(mutations).toEqual([]);
    expect(toasts[0].msg).toBe('Enter how many came back.');
  });

  test('a closed lot shows its receipts but takes no new one, and none can be deleted', async () => {
    Api.call = jest.fn(async () => ({
      success: true,
      data: {
        ...JSON.parse(JSON.stringify(DETAIL)),
        lot: LOTS[3],
        canReceive: false,
        lines: DETAIL.lines.map(l => ({ ...l, received: l.qty, balance: 0 }))
      }
    }));
    await App.Production.openReceiveModal(String(App.State.globalProduction.findIndex(p => p.rowIdx === 4)));
    expect(document.getElementById('receiveLotForm').style.display).toBe('none');
    expect(document.getElementById('receiveLotClosedNote').textContent)
      .toBe('This lot is Completed, so all of it counts as received.');
    expect(document.querySelector('#receiveLotHistory button')).toBeNull();
  });

  test('deleting a receipt asks, then reloads the receipts', async () => {
    await open();
    answer = () => ({ success: true, message: 'Receipt deleted.', data: { row: { ...LOTS[0], receivedQty: 0, balanceQty: 200, receiptCount: 0 } } });
    App.Production.deleteReceipt(11);
    expect(confirmCb.msg).toContain('Delete the receipt of 90 dated 25/10/2026?');
    await confirmCb.cb();
    expect(mutations).toEqual([['deleteProductionReceipt', 11]]);
    expect(Api.call).toHaveBeenCalledTimes(2);
    expect(qtyText(1)).toBe('200 Units Balance 200');
  });
});

describe('a partly received lot\'s status asks first', () => {
  const selectOf = id => rowOf(id).querySelector('select');
  function choose(sel, value) {
    sel.value = value;
    sel.dispatchEvent(new Event('change'));
  }

  test('Completed: the balance counts as received -- nothing changes until agreed', async () => {
    choose(selectOf(1), 'Completed');
    await settle();
    expect(confirmCb.msg).toContain('Lot #LOT-PNT028-0002 has received 90 of 200.');
    expect(confirmCb.msg).toContain('counts the 110 not received yet as received now');
    expect(selectOf(1).value).toBe('In Progress');
    expect(mutations).toEqual([]);

    answer = () => ({ success: true, message: 'done', data: { status: 'Completed', row: { ...LOTS[0], status: 'Completed', balanceQty: 0 } } });
    await confirmCb.cb();
    await settle();
    expect(mutations).toEqual([['updateProductionStatus', 1, 200, 'Completed']]);
    expect(qtyText(1)).toBe('200 Units');
  });

  test('Cancelled: what came back stays, the rest is dropped', async () => {
    choose(selectOf(1), 'Cancelled');
    await settle();
    expect(confirmCb.msg).toContain('Cancelling keeps the 90 received and drops the 110 not received.');
  });

  test('a lot nobody received against changes straight away, as before', async () => {
    answer = () => ({ success: true, message: 'done', data: { status: 'Completed' } });
    choose(selectOf(2), 'Completed');
    await settle();
    expect(confirmCb).toBeNull();
    expect(mutations).toEqual([['updateProductionStatus', 2, 50, 'Completed']]);
  });
});
