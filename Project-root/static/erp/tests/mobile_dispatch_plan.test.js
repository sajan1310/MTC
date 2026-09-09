/**
 * The dispatch plan, as a checklist (Phase 7).
 *
 * Desktop plans this on a drag-and-drop board -- pool items on the left,
 * client cards on the right, lines dragged between them. That board is
 * the wrong object on a phone and always would be. What survives the
 * translation is what the loading bay actually needs from it: today's
 * list, grouped by client, and whether each line has gone yet.
 *
 * saveDispatchPlanLine upserts ONE line rather than resubmitting a whole
 * plan, which is what makes a checklist a faithful client for it: every
 * edit here is exactly one line, the same unit the board's drags are.
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

const TODAY = '2026-09-09';

const LINES = [
  { lineId: 1, planDate: TODAY, clientName: 'sharma cycles', productId: 'PRD-1', productName: 'Kalpi 26', qty: 40, sortOrder: 1, rate: 0, remarks: '', transport: '', fulfilled: false, fulfilledDispatchNumber: '' },
  { lineId: 2, planDate: TODAY, clientName: 'sharma cycles', productId: 'PRD-2', productName: 'Ranger 24', qty: 10, sortOrder: 2, rate: 0, remarks: 'blue only', transport: 'Tempo', fulfilled: true, fulfilledDispatchNumber: 'DC-91' },
  { lineId: 3, planDate: TODAY, clientName: 'verma stores', productId: 'PRD-1', productName: 'Kalpi 26', qty: 5, sortOrder: 3, rate: 0, remarks: '', transport: '', fulfilled: false, fulfilledDispatchNumber: '' },
  { lineId: 4, planDate: '2026-09-10', clientName: 'verma stores', productId: 'PRD-1', productName: 'Kalpi 26', qty: 7, sortOrder: 1, rate: 0, remarks: '', transport: '', fulfilled: false, fulfilledDispatchNumber: '' },
];

const CLIENTS = [{ name: 'sharma cycles', contact: '9' }, { name: 'verma stores', contact: '' }];
const PRODUCTS = [{ productId: 'PRD-1', productName: 'Kalpi 26' }, { productId: 'PRD-2', productName: 'Ranger 24' }];

function mount() {
  jest.resetModules();
  global.fetch = jest.fn();
  document.body.innerHTML = `
    <div id="mapp-sheet-backdrop"></div>
    <div class="mb-sheet" id="sheet-dispatch-plan">
      <input type="date" id="dispatch-plan-date">
      <div id="dispatch-plan-summary"></div>
      <div id="dispatch-plan-list"></div>
    </div>
    <div class="mb-sheet" id="sheet-dispatch-plan-form">
      <h2 id="dispatch-plan-form-title"></h2>
      <input type="date" id="plan-line-date">
      <button id="plan-line-client-field" class="mb-picker-field mb-placeholder">Choose a client…</button>
      <button id="plan-line-product-field" class="mb-picker-field mb-placeholder">Choose a product…</button>
      <input type="number" id="plan-line-qty">
      <input type="number" id="plan-line-rate">
      <input type="text" id="plan-line-transport">
      <textarea id="plan-line-remarks"></textarea>
      <button id="dispatch-plan-save-btn">Save</button>
    </div>
    <div class="mb-sheet" id="mapp-picker-sheet">
      <h2 id="mapp-picker-title"></h2>
      <div id="mapp-picker-search-wrap"><input id="mapp-picker-search"></div>
      <div id="mapp-picker-list"></div>
    </div>
    <div class="mb-toast-stack" id="mapp-toast-stack"></div>`;
  loadAsGlobal('api.js', 'Api');
  loadAsGlobal('mobile.js', 'MApp');
  MApp.Sheet._stack = [];
  window.confirm = jest.fn(() => true);
  Element.prototype.scrollIntoView = jest.fn();
  MApp.Api.call = jest.fn(async m => {
    if (m === 'getDispatchPlans') return { success: true, data: LINES };
    if (m === 'getClientsData') return { success: true, data: CLIENTS };
    if (m === 'getBOMProductionData') return { success: true, data: PRODUCTS };
    return { success: false };
  });
}

const list = () => document.getElementById('dispatch-plan-list');
const cards = () => [...list().querySelectorAll('.mb-card')];
const open = () => MApp.DispatchPlan.open(TODAY);
const pick = label => [...document.querySelectorAll('#mapp-picker-list .mb-picker-option')]
  .find(b => b.textContent.trim().startsWith(label)).click();

describe('the day’s plan', () => {
  beforeEach(mount);

  test('shows only the day being looked at', async () => {
    await open();

    expect(MApp.Api.call).toHaveBeenCalledWith('getDispatchPlans');
    expect(cards()).toHaveLength(3); // the 10th's line is not today's
    expect(list().textContent).not.toContain('7');
  });

  test('groups by client, because that is how a vehicle is loaded', async () => {
    await open();

    const headings = [...list().querySelectorAll('.mapp-section-label')].map(h => h.textContent);
    expect(headings).toEqual(['Sharma cycles', 'Verma stores']);
  });

  test('orders within a client by the plan’s own sort order', async () => {
    await open();

    const names = [...list().querySelectorAll('.mb-card-title')].map(n => n.textContent);
    expect(names.slice(0, 2)).toEqual(['Kalpi 26', 'Ranger 24']);
  });

  test('says how much of the day is done', async () => {
    await open();
    expect(document.getElementById('dispatch-plan-summary').textContent).toBe('1 of 3 dispatched');
  });

  test('changing the date shows that day instead', async () => {
    await open();
    await MApp.DispatchPlan.onDateChange('2026-09-10');

    expect(cards()).toHaveLength(1);
    expect(list().textContent).toContain('Verma stores');
  });

  test('a day with nothing planned says so', async () => {
    await open();
    await MApp.DispatchPlan.onDateChange('2026-12-25');

    expect(list().textContent).toContain('Nothing planned');
    expect(document.getElementById('dispatch-plan-summary').textContent).toContain('Nothing planned');
  });

  test('a failure offers a retry', async () => {
    MApp.Api.call = jest.fn(async () => { throw new Error('offline'); });
    await open();

    expect(list().querySelector('.mb-state-retry')).not.toBeNull();
  });
});

describe('a line that has already gone', () => {
  beforeEach(mount);

  test('is marked dispatched, and names the challan', async () => {
    await open();

    const done = cards().find(c => c.textContent.includes('Ranger 24'));
    expect(done.textContent).toContain('Dispatched');
    expect(done.textContent).toContain('DC-91');
  });

  test('offers neither Edit nor Remove', async () => {
    // The server refuses both outright, so offering either would be
    // offering a save that bounces.
    await open();

    const done = cards().find(c => c.textContent.includes('Ranger 24'));
    expect(done.querySelector('[data-plan-action]')).toBeNull();
  });

  test('a line still to go offers both', async () => {
    await open();

    const todo = cards().find(c => c.textContent.includes('Kalpi 26'));
    expect(todo.querySelector('[data-plan-action="edit"]')).not.toBeNull();
    expect(todo.querySelector('[data-plan-action="remove"]')).not.toBeNull();
  });
});

describe('adding and editing a line', () => {
  beforeEach(mount);

  async function form(line) {
    await open();
    await MApp.DispatchPlan.openForm(line || null);
  }

  test('a new line defaults to the day being looked at', async () => {
    await form();
    expect(document.getElementById('plan-line-date').value).toBe(TODAY);
  });

  test('an edit opens on the line as it stands', async () => {
    await form(LINES[2]);

    expect(document.getElementById('plan-line-qty').value).toBe('5');
    expect(MApp.DispatchPlan.selection.clientName).toBe('verma stores');
    expect(MApp.DispatchPlan.selection.productId).toBe('PRD-1');
  });

  test('a new line goes to the END of its day', async () => {
    // The order is somebody's loading sequence. Inserting into the middle
    // of it from here would rearrange a plan nobody asked to rearrange.
    let call = null;
    MApp.Util.mutateSimple = jest.fn(async (m, args) => { call = { m, args }; return { success: false }; });
    await form();
    MApp.DispatchPlan.selection = { clientName: 'verma stores', productId: 'PRD-1', productName: 'Kalpi 26' };
    document.getElementById('plan-line-qty').value = '3';

    await MApp.DispatchPlan.save();

    expect(call.m).toBe('saveDispatchPlanLine');
    expect(call.args[0].sortOrder).toBe(4); // max of today's 1,2,3
    expect(call.args[0].lineId).toBe('');
  });

  test('an edit keeps the line’s own place in the order', async () => {
    let call = null;
    MApp.Util.mutateSimple = jest.fn(async (m, args) => { call = { m, args }; return { success: false }; });
    await form(LINES[2]);

    await MApp.DispatchPlan.save();

    expect(call.args[0].lineId).toBe(3);
    expect(call.args[0].sortOrder).toBe(3);
  });

  test('no client, no product or no quantity is refused before sending', async () => {
    MApp.Util.mutateSimple = jest.fn();
    await form();

    await MApp.DispatchPlan.save();
    expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();

    MApp.DispatchPlan.selection = { clientName: 'verma stores', productId: '', productName: '' };
    await MApp.DispatchPlan.save();
    expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();

    MApp.DispatchPlan.selection = { clientName: 'verma stores', productId: 'PRD-1', productName: 'Kalpi 26' };
    document.getElementById('plan-line-qty').value = '0';
    await MApp.DispatchPlan.save();
    expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();
  });

  test('the product picker offers what BOM defines', async () => {
    await form();

    const done = MApp.DispatchPlan.pickProduct();
    await Promise.resolve();
    pick('Kalpi 26');
    await done;

    expect(MApp.DispatchPlan.selection.productId).toBe('PRD-1');
  });

  test('saving to another day follows the line there', async () => {
    // Otherwise the operator is left looking at a list the line they just
    // saved is no longer in.
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: true }));
    await form();
    MApp.DispatchPlan.selection = { clientName: 'verma stores', productId: 'PRD-1', productName: 'Kalpi 26' };
    document.getElementById('plan-line-qty').value = '3';
    document.getElementById('plan-line-date').value = '2026-09-10';

    await MApp.DispatchPlan.save();

    expect(MApp.DispatchPlan.planDate).toBe('2026-09-10');
    expect(document.getElementById('dispatch-plan-date').value).toBe('2026-09-10');
  });

  test('a refusal leaves the form open and the button usable', async () => {
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: false }));
    await form();
    MApp.DispatchPlan.selection = { clientName: 'verma stores', productId: 'PRD-1', productName: 'Kalpi 26' };
    document.getElementById('plan-line-qty').value = '3';

    await MApp.DispatchPlan.save();

    const btn = document.getElementById('dispatch-plan-save-btn');
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('Save');
  });
});

describe('removing a line', () => {
  beforeEach(mount);

  test('confirms, saying the dispatch itself is untouched', async () => {
    let call = null;
    MApp.Util.mutateSimple = jest.fn(async (m, args) => { call = { m, args }; return { success: false }; });
    await open();

    await MApp.DispatchPlan.remove(LINES[0]);

    expect(window.confirm.mock.calls[0][0]).toContain('dispatch itself is not affected');
    expect(call).toEqual({ m: 'deleteDispatchPlanLine', args: [1] });
  });

  test('declining sends nothing', async () => {
    window.confirm = jest.fn(() => false);
    MApp.Util.mutateSimple = jest.fn();
    await open();

    await MApp.DispatchPlan.remove(LINES[0]);

    expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();
  });
});
