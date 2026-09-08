/**
 * PI / Estimates on the phone (Phase 6).
 *
 * A PI is where a client's order enters the system, and marking one
 * "Order Confirmed" is what queues the Production lots against it. The
 * whole entry point was desktop-only, so an order taken on the phone
 * waited for somebody to reach a laptop before any of it could be made.
 *
 * Most of what is asserted here is about not losing the server's own
 * account of what happened: how many lines it queued, how many it could
 * not map and left for a human, and which PIs a bulk delete refused to
 * touch.
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

const ORDERS = [
  {
    orderNumber: 'ORD-12', orderDate: '01/09/2026', dateRaw: '2026-09-01',
    clientName: 'sharma cycles', status: 'Order Confirmed', orderRemarks: 'rush',
    lines: [
      { productId: 'PRD-1', productName: 'Kalpi 26', qty: 50, lineRemarks: '', productionPushed: true, needsManualProduction: false },
      { productId: 'PRD-2', productName: 'Ranger 24', qty: 10, lineRemarks: 'blue', productionPushed: false, needsManualProduction: true },
    ],
  },
  {
    orderNumber: 'ORD-11', orderDate: '20/08/2026', dateRaw: '2026-08-20',
    clientName: 'verma stores', status: 'Estimate', orderRemarks: '',
    lines: [{ productId: 'PRD-1', productName: 'Kalpi 26', qty: 5, lineRemarks: '', productionPushed: false, needsManualProduction: false }],
  },
];

const CLIENTS = [{ name: 'sharma cycles', contact: '99999' }, { name: 'verma stores', contact: '' }];
const PRODUCTS = [{ productId: 'PRD-1', productName: 'Kalpi 26' }, { productId: 'PRD-2', productName: 'Ranger 24' }];

function mount() {
  jest.resetModules();
  global.fetch = jest.fn();
  document.body.innerHTML = `
    <div id="mapp-sheet-backdrop"></div>
    <div class="mb-sheet" id="sheet-client-orders">
      <div class="mb-search"><input type="search" id="client-orders-search"></div>
      <div class="mb-filter-chip-row" id="client-orders-filters">
        <button class="mb-filter-chip active" data-order-filter="all" aria-pressed="true">All</button>
        <button class="mb-filter-chip" data-order-filter="Estimate" aria-pressed="false">Estimate</button>
        <button class="mb-filter-chip" data-order-filter="Order Confirmed" aria-pressed="false">Confirmed</button>
        <button class="mb-filter-chip" data-order-filter="Cancelled" aria-pressed="false">Cancelled</button>
      </div>
      <div id="client-orders-list"></div>
    </div>
    <div class="mb-sheet" id="sheet-client-order-form">
      <h2 id="client-order-form-title"></h2>
      <button id="client-order-client-field" class="mb-picker-field mb-placeholder">Choose a client…</button>
      <input type="date" id="client-order-date">
      <button id="client-order-status-field" class="mb-picker-field">Estimate</button>
      <div id="client-order-status-hint"></div>
      <textarea id="client-order-remarks"></textarea>
      <div id="client-order-lines"></div>
      <button id="client-order-save-btn">Save</button>
    </div>
    <div class="mb-sheet" id="mapp-picker-sheet">
      <h2 id="mapp-picker-title"></h2>
      <div id="mapp-picker-search-wrap"><input id="mapp-picker-search"></div>
      <div id="mapp-picker-list"></div>
    </div>
    <div class="mb-select-bar" id="mapp-select-bar"><span id="mapp-select-count"></span></div>
    <div class="mb-toast-stack" id="mapp-toast-stack"></div>`;
  loadAsGlobal('api.js', 'Api');
  loadAsGlobal('mobile.js', 'MApp');
  MApp.Sheet._stack = [];
  MApp.Paging._shown = {};
  MApp.Select._state = null;
  window.confirm = jest.fn(() => true);
  Element.prototype.scrollIntoView = jest.fn();
}

const listText = () => document.getElementById('client-orders-list').textContent;

async function openList() {
  MApp.Api.call = jest.fn(async () => ({ success: true, data: ORDERS }));
  await MApp.ClientOrders.open();
}

async function openForm(order) {
  MApp.Api.call = jest.fn(async m => ({
    success: true,
    data: m === 'getClientsData' ? CLIENTS : PRODUCTS,
  }));
  await MApp.ClientOrders.openForm(order);
}

const pick = label => {
  const btn = [...document.querySelectorAll('#mapp-picker-list .mb-picker-option')]
    .find(b => b.textContent.trim().startsWith(label));
  btn.click();
};

describe('the PI list', () => {
  beforeEach(mount);

  test('reads the orders endpoint and shows what each one is', async () => {
    await openList();

    expect(MApp.Api.call).toHaveBeenCalledWith('getClientOrdersData');
    expect(listText()).toContain('ORD-12');
    expect(listText()).toContain('Sharma cycles');
    expect(listText()).toContain('Order Confirmed');
    expect(listText()).toContain('2 line(s)');
  });

  test('flags the lines that were confirmed but never queued', async () => {
    // "Manual" means the PI is confirmed and nothing was created for that
    // line -- somebody has to log the lot by hand, and nothing else on
    // this screen would tell them.
    await openList();
    expect(listText()).toContain('need a Production lot logged by hand');
  });

  test('search reaches the products, not just the number and client', async () => {
    await openList();

    MApp.ClientOrders.onSearch('ranger');

    expect(MApp.ClientOrders.filtered.map(o => o.orderNumber)).toEqual(['ORD-12']);
  });

  test('the status filter narrows the list', async () => {
    await openList();

    MApp.ClientOrders.filterBy('Estimate');
    expect(MApp.ClientOrders.filtered.map(o => o.orderNumber)).toEqual(['ORD-11']);

    MApp.ClientOrders.filterBy('all');
    expect(MApp.ClientOrders.filtered.length).toBe(2);
  });

  test('search and status filter compose', async () => {
    await openList();

    MApp.ClientOrders.filterBy('Order Confirmed');
    MApp.ClientOrders.onSearch('kalpi'); // on both PIs; only one is confirmed

    expect(MApp.ClientOrders.filtered.map(o => o.orderNumber)).toEqual(['ORD-12']);
  });

  test('a failure offers a retry', async () => {
    MApp.Api.call = jest.fn(async () => { throw new Error('offline'); });
    await MApp.ClientOrders.open();

    expect(document.querySelector('#client-orders-list .mb-state-retry')).not.toBeNull();
  });
});

describe('the PI form', () => {
  beforeEach(mount);

  test('a new PI starts on Estimate, dated today, with one blank line', async () => {
    await openForm(null);

    expect(MApp.ClientOrders.selection.status).toBe('Estimate');
    expect(document.getElementById('client-order-date').value).toBe(MApp.Util.todayInputValue());
    expect(MApp.ClientOrders.lines).toEqual([{ productId: '', productName: '', qty: '', lineRemarks: '' }]);
  });

  test('an edit opens on the PI as it stands', async () => {
    await openForm(ORDERS[0]);

    expect(document.getElementById('client-order-form-title').textContent).toBe('ORD-12');
    expect(MApp.ClientOrders.selection.clientName).toBe('sharma cycles');
    expect(document.getElementById('client-order-date').value).toBe('2026-09-01');
    expect(MApp.ClientOrders.lines.map(l => l.productId)).toEqual(['PRD-1', 'PRD-2']);
  });

  test('the status hint says what confirming actually does', async () => {
    // The word "Confirmed" does not say "this creates Production lots",
    // and that is the consequence worth knowing before saving.
    await openForm(null);
    expect(document.getElementById('client-order-status-hint').textContent)
      .toContain('until this is Order Confirmed');

    MApp.ClientOrders.selection.status = 'Order Confirmed';
    MApp.ClientOrders._paintStatus();
    expect(document.getElementById('client-order-status-hint').textContent)
      .toContain('queues a Pending Production lot');
  });

  test('the product picker offers only what BOM defines', async () => {
    // The server rejects any line whose product is not in BOM, so
    // offering anything else would be offering a save that will bounce.
    await openForm(null);

    const done = MApp.ClientOrders.pickLineProduct(0);
    await Promise.resolve();
    const labels = [...document.querySelectorAll('#mapp-picker-list .mb-picker-option')]
      .map(b => b.textContent.trim());
    pick('Kalpi 26');
    await done;

    // Each option carries the product ID as its sublabel, because two
    // products can share a name and only the ID is sent.
    expect(labels).toEqual(['Kalpi 26PRD-1', 'Ranger 24PRD-2']);
    expect(MApp.ClientOrders.lines[0]).toMatchObject({ productId: 'PRD-1', productName: 'Kalpi 26' });
  });

  test('adding and removing lines never leaves none', async () => {
    await openForm(null);

    MApp.ClientOrders.addLine();
    expect(MApp.ClientOrders.lines.length).toBe(2);

    MApp.ClientOrders.removeLine(0);
    MApp.ClientOrders.removeLine(0);
    expect(MApp.ClientOrders.lines.length).toBe(1);
  });

  test('saving without a client is refused before sending', async () => {
    MApp.Util.mutateSimple = jest.fn();
    await openForm(null);

    await MApp.ClientOrders.save();

    expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();
  });

  test('saving with no usable line is refused before sending', async () => {
    // A line with a product but no quantity is not a line yet.
    MApp.Util.mutateSimple = jest.fn();
    await openForm(null);
    MApp.ClientOrders.selection.clientName = 'verma stores';
    MApp.ClientOrders.lines = [{ productId: 'PRD-1', productName: 'Kalpi 26', qty: 0, lineRemarks: '' }];

    await MApp.ClientOrders.save();

    expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();
  });

  test('a new PI sends an empty order number, which is how the server knows', async () => {
    let call = null;
    MApp.Util.mutateSimple = jest.fn(async (m, args) => { call = { m, args }; return { success: false }; });
    await openForm(null);
    MApp.ClientOrders.selection.clientName = 'verma stores';
    MApp.ClientOrders.lines = [{ productId: 'PRD-1', productName: 'Kalpi 26', qty: 3, lineRemarks: 'x' }];

    await MApp.ClientOrders.save();

    expect(call.m).toBe('saveClientOrder');
    expect(call.args[0].orderNumber).toBe('');
    expect(call.args[0].lines).toEqual([{ productId: 'PRD-1', productName: 'Kalpi 26', qty: 3, lineRemarks: 'x' }]);
  });

  test('an edit sends the PI number back', async () => {
    let call = null;
    MApp.Util.mutateSimple = jest.fn(async (m, args) => { call = { m, args }; return { success: false }; });
    await openForm(ORDERS[0]);

    await MApp.ClientOrders.save();

    expect(call.args[0].orderNumber).toBe('ORD-12');
  });

  test('productionPushed is not sent, because the server recomputes it', async () => {
    // save_client_order counts the pushed rows already in the table per
    // product and decrements, so a second line for a product pushed once
    // is not wrongly marked pushed. A flag from here is ignored; sending
    // one would read as if it mattered.
    let call = null;
    MApp.Util.mutateSimple = jest.fn(async (m, args) => { call = { m, args }; return { success: false }; });
    await openForm(ORDERS[0]);

    await MApp.ClientOrders.save();

    call.args[0].lines.forEach(l => {
      expect(l).not.toHaveProperty('productionPushed');
      expect(l).not.toHaveProperty('needsManualProduction');
    });
  });

  test('lines with no product are dropped rather than sent empty', async () => {
    let call = null;
    MApp.Util.mutateSimple = jest.fn(async (m, args) => { call = { m, args }; return { success: false }; });
    await openForm(null);
    MApp.ClientOrders.selection.clientName = 'verma stores';
    MApp.ClientOrders.lines = [
      { productId: 'PRD-1', productName: 'Kalpi 26', qty: 3, lineRemarks: '' },
      { productId: '', productName: '', qty: '', lineRemarks: '' },
    ];

    await MApp.ClientOrders.save();

    expect(call.args[0].lines.length).toBe(1);
  });

  test('the SERVER message is shown, so the production outcome survives', async () => {
    // It is the only place that says how many lines were queued and how
    // many need logging by hand. "Saved." would drop the half of the
    // outcome the operator has to act on.
    const msg = 'PI / Estimate "ORD-13" saved. 1 product line(s) queued into Production. '
      + '1 line(s) need manual Production setup -- log them yourself in the Production tab.';
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: true, message: msg }));
    const spy = jest.spyOn(MApp.Toast, 'success');
    await openForm(null);
    MApp.ClientOrders.open = jest.fn();
    MApp.ClientOrders.selection.clientName = 'verma stores';
    MApp.ClientOrders.lines = [{ productId: 'PRD-1', productName: 'Kalpi 26', qty: 3, lineRemarks: '' }];

    await MApp.ClientOrders.save();

    expect(spy).toHaveBeenCalledWith(msg);
    spy.mockRestore();
  });

  test('a refusal leaves the form open with the save button usable', async () => {
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: false }));
    await openForm(null);
    MApp.ClientOrders.open = jest.fn();
    MApp.ClientOrders.selection.clientName = 'verma stores';
    MApp.ClientOrders.lines = [{ productId: 'PRD-1', productName: 'Kalpi 26', qty: 3, lineRemarks: '' }];

    await MApp.ClientOrders.save();

    expect(MApp.ClientOrders.open).not.toHaveBeenCalled();
    const btn = document.getElementById('client-order-save-btn');
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('Save');
  });

  test('a picker that has not loaded says so instead of opening empty', async () => {
    MApp.Api.call = jest.fn(async () => ({ success: false }));
    await MApp.ClientOrders.openForm(null);
    const spy = jest.spyOn(MApp.Toast, 'error');

    await MApp.ClientOrders.pickLineProduct(0);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('still loading'));
    spy.mockRestore();
  });
});

describe('deleting a PI', () => {
  beforeEach(mount);

  test('confirms, then sends the PI number', async () => {
    let call = null;
    MApp.Util.mutateSimple = jest.fn(async (m, args) => { call = { m, args }; return { success: false }; });
    await openList();

    await MApp.ClientOrders.remove(ORDERS[0]);

    expect(window.confirm).toHaveBeenCalled();
    expect(call).toEqual({ m: 'deleteClientOrder', args: ['ORD-12'] });
  });

  test('the server refusal is reported as it comes back, not rewritten', async () => {
    // It names the reason -- a dispatch record, or a queued lot -- and a
    // canned "could not delete" would throw that away.
    const refusal = 'Cannot delete PI / Estimate "ORD-12": it already has a Production lot queued from it.';
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: false, message: refusal }));
    await openList();
    MApp.ClientOrders.open = jest.fn();

    await MApp.ClientOrders.remove(ORDERS[0]);

    // mutateSimple surfaces res.message itself; the list is not reloaded.
    expect(MApp.ClientOrders.open).not.toHaveBeenCalled();
  });

  test('declining the confirmation sends nothing', async () => {
    window.confirm = jest.fn(() => false);
    MApp.Util.mutateSimple = jest.fn();
    await openList();

    await MApp.ClientOrders.remove(ORDERS[0]);

    expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();
  });

  test('bulk delete sends the selected PI numbers', async () => {
    let call = null;
    MApp.Util.mutateSimple = jest.fn(async (m, args) => { call = { m, args }; return { success: true }; });
    await openList();
    MApp.ClientOrders.open = jest.fn();

    MApp.Select._state = {
      key: 'clientOrder', config: MApp.ClientOrders.SELECT,
      rows: ORDERS, nodes: [], listEl: null, selected: new Set([0, 1]),
    };
    await MApp.Select.deleteSelected();

    expect(call).toEqual({ m: 'deleteClientOrdersBulk', args: [['ORD-12', 'ORD-11']] });
  });
});

describe('MApp.Select reports what the server actually did', () => {
  beforeEach(mount);

  test('a partial bulk delete says what it skipped', async () => {
    // deleteClientOrdersBulk deletes what it can and names the PIs it
    // would not touch. "2 PI / Estimates deleted" over the top of that is
    // not merely uninformative, it is wrong.
    const msg = 'Deleted 1 PI / Estimate(s) (2 line(s) removed). Skipped 1 PI / Estimate(s) '
      + 'with dispatch records or a queued Production lot against them: ORD-12.';
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: true, message: msg }));
    const spy = jest.spyOn(MApp.Toast, 'success');
    await openList();
    MApp.ClientOrders.open = jest.fn();

    MApp.Select._state = {
      key: 'clientOrder', config: MApp.ClientOrders.SELECT,
      rows: ORDERS, nodes: [], listEl: null, selected: new Set([0, 1]),
    };
    await MApp.Select.deleteSelected();

    expect(spy).toHaveBeenCalledWith(msg);
    spy.mockRestore();
  });

  test('a silent endpoint still gets a count', async () => {
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: true }));
    const spy = jest.spyOn(MApp.Toast, 'success');
    await openList();
    MApp.ClientOrders.open = jest.fn();

    MApp.Select._state = {
      key: 'clientOrder', config: MApp.ClientOrders.SELECT,
      rows: ORDERS, nodes: [], listEl: null, selected: new Set([0]),
    };
    await MApp.Select.deleteSelected();

    expect(spy).toHaveBeenCalledWith('1 PI / Estimate deleted.');
    spy.mockRestore();
  });

  test('a refusal announces nothing and does not reload', async () => {
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: false, message: 'nope' }));
    const spy = jest.spyOn(MApp.Toast, 'success');
    await openList();
    MApp.ClientOrders.open = jest.fn();

    MApp.Select._state = {
      key: 'clientOrder', config: MApp.ClientOrders.SELECT,
      rows: ORDERS, nodes: [], listEl: null, selected: new Set([0]),
    };
    await MApp.Select.deleteSelected();

    expect(spy).not.toHaveBeenCalled();
    expect(MApp.ClientOrders.open).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
