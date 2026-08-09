/**
 * Regression test for App.DispatchPlan (../dispatch-plan.js) -- the
 * Dispatch-specific glue between App.PlanningBoard (see
 * planning-board.test.js, tested separately/independently) and the
 * Dispatch Plan RPCs. Run against the real source, same fs.readFileSync +
 * eval technique nav.test.js/outbox_chaos.test.js already established --
 * no `const App =` rewrite needed here since this file just extends the
 * (test-provided) global App object, unlike core.js.
 *
 * jsdom has no real drag events, so drag/multi-select itself is NOT
 * exercised here -- these tests cover App.DispatchPlan's own state
 * mapping and mutation-handling logic (pool/card building, save/delete
 * wiring, plan -> bill handoff), independent of the board UI.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function loadDispatchPlan() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'dispatch-plan.js'), 'utf8');
  eval(code);
}

describe('App.DispatchPlan', () => {
  beforeEach(() => {
    document.body.innerHTML = '<input type="date" id="dispatchPlanDate"><div id="dispatchPlanRoot">'
      + '</div><div id="print-bulk-container"><div id="print-bulk-body"></div></div>';

    global.tomorrowIso = () => '2026-08-09';
    // Real (not stubbed) escaping semantics matter here -- _buildPrintHtml's
    // own correctness (no unescaped client/product names in the printed
    // HTML) is exactly what a couple of tests below check.
    global.escapeHtml = value => String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    global.Api = { call: jest.fn(), mutate: jest.fn() };
    global.App = {
      State: {
        globalReadyToDispatch: [],
        globalDispatchPlans: [],
        dispatchPlanDate: '',
      },
      // Default: confirms immediately (calls the callback synchronously) --
      // matches how most tests want to assert the END result of cancelling.
      // Tests specifically about the prompt itself inspect the mock's own
      // calls instead.
      Utils: { showToast: jest.fn(), confirmAction: jest.fn((_message, cb) => cb()), notPortedYet: jest.fn() },
      Dispatch: {
        loadReadyData: jest.fn().mockResolvedValue(undefined),
        openPrefilledDispatchModal: jest.fn(),
      },
      PlanningBoard: { mount: jest.fn() },
      Print: {
        trigger: jest.fn(),
        brandHeaderHtml: jest.fn(() => '<div>BRAND</div>'),
      },
    };

    loadDispatchPlan();
    App.DispatchPlan._pendingEmptyCards = new Set();
    Api.call.mockResolvedValue({ success: true, data: [] });
  });

  test('init() defaults the plan date to tomorrow, wires the date input, and renders once', () => {
    App.DispatchPlan.init();

    expect(App.State.dispatchPlanDate).toBe('2026-08-09');
    expect(document.getElementById('dispatchPlanDate').value).toBe('2026-08-09');
    expect(App.PlanningBoard.mount).toHaveBeenCalledTimes(1);
  });

  test('changing the date input updates state, clears pending-empty cards, and re-renders', () => {
    App.DispatchPlan.init();
    App.DispatchPlan._pendingEmptyCards.add('DraftClient');
    App.PlanningBoard.mount.mockClear();

    const input = document.getElementById('dispatchPlanDate');
    input.value = '2026-08-11';
    input.dispatchEvent(new Event('change'));

    expect(App.State.dispatchPlanDate).toBe('2026-08-11');
    expect(App.DispatchPlan._pendingEmptyCards.size).toBe(0);
    expect(App.PlanningBoard.mount).toHaveBeenCalledTimes(1);
  });

  test('_buildPool dedupes differentiated Ready-to-Dispatch rows sharing one productId, and drops exhausted ones', () => {
    App.State.globalReadyToDispatch = [
      { productId: 'P1', productName: 'Widget / Black', availableToPlan: 5, readyQty: 8 },
      { productId: 'P1', productName: 'Widget / Blue', availableToPlan: 5, readyQty: 8 },
      { productId: 'P2', productName: 'Gadget', availableToPlan: 0, readyQty: 0 },
    ];

    const pool = App.DispatchPlan._buildPool();

    expect(pool).toHaveLength(1);
    expect(pool[0]).toMatchObject({ id: 'P1', label: 'Widget / Black', availableQty: 5 });
  });

  test('_buildCards groups lines by client for the SELECTED date only, and folds in pending empty cards', () => {
    App.State.dispatchPlanDate = '2026-08-09';
    App.State.globalDispatchPlans = [
      { lineId: 1, planDate: '2026-08-09', clientName: 'Acme', productId: 'P1', productName: 'Widget', qty: 3, fulfilled: false },
      { lineId: 2, planDate: '2026-08-09', clientName: 'Acme', productId: 'P2', productName: 'Gadget', qty: 1, fulfilled: true },
      { lineId: 3, planDate: '2026-08-10', clientName: 'OtherDayClient', productId: 'P1', productName: 'Widget', qty: 2, fulfilled: false },
    ];
    App.DispatchPlan._pendingEmptyCards.add('NewClient');

    const cards = App.DispatchPlan._buildCards();

    expect(cards.map(c => c.id).sort()).toEqual(['Acme', 'NewClient']);
    const acme = cards.find(c => c.id === 'Acme');
    expect(acme.lines).toHaveLength(2);
    expect(acme.lines.find(l => l.lineId === 2).fulfilled).toBe(true);
    expect(cards.find(c => c.id === 'NewClient').lines).toHaveLength(0);
  });

  test('_buildCards line label omits the "(productId)" suffix when it duplicates productName (untagged final-stage output)', () => {
    App.State.dispatchPlanDate = '2026-08-09';
    App.State.globalDispatchPlans = [
      { lineId: 1, planDate: '2026-08-09', clientName: 'Acme', productId: 'Same Name', productName: 'Same Name', qty: 3, fulfilled: false },
      { lineId: 2, planDate: '2026-08-09', clientName: 'Acme', productId: 'P2', productName: 'Widget', qty: 1, fulfilled: false },
    ];

    const acme = App.DispatchPlan._buildCards().find(c => c.id === 'Acme');

    expect(acme.lines.find(l => l.lineId === 1).label).toBe('Same Name');
    expect(acme.lines.find(l => l.lineId === 2).label).toBe('Widget (P2)');
  });

  test('_buildCards exposes rate/remarks per line, and the card\'s transport (denormalized across its lines) once at the card level', () => {
    App.State.dispatchPlanDate = '2026-08-09';
    App.State.globalDispatchPlans = [
      { lineId: 1, planDate: '2026-08-09', clientName: 'Acme', productId: 'P1', productName: 'Widget', qty: 3, rate: 12.5, remarks: 'Fragile', transport: 'Truck #7', fulfilled: false },
    ];

    const acme = App.DispatchPlan._buildCards().find(c => c.id === 'Acme');

    expect(acme.transport).toBe('Truck #7');
    expect(acme.lines[0]).toMatchObject({ rate: 12.5, remarks: 'Fragile' });
  });

  test('_buildCards defaults a pending (empty, unsaved) card\'s transport to an empty string', () => {
    App.State.dispatchPlanDate = '2026-08-09';
    App.State.globalDispatchPlans = [];
    App.DispatchPlan._pendingEmptyCards.add('DraftClient');

    const draft = App.DispatchPlan._buildCards().find(c => c.id === 'DraftClient');

    expect(draft.transport).toBe('');
  });

  test('_handleAddCard only tracks a pending empty card locally -- no save, immediate re-render', () => {
    App.DispatchPlan._handleAddCard('Fresh Client');

    expect(App.DispatchPlan._pendingEmptyCards.has('Fresh Client')).toBe(true);
    expect(Api.mutate).not.toHaveBeenCalled();
    expect(App.PlanningBoard.mount).toHaveBeenCalledTimes(1);
  });

  test('_handleDrop saves each dropped item, resolves the productName from Ready to Dispatch, and clears the pending-empty flag', async () => {
    App.State.dispatchPlanDate = '2026-08-09';
    App.State.globalReadyToDispatch = [{ productId: 'P1', productName: 'Widget', availableToPlan: 10, readyQty: 10 }];
    App.DispatchPlan._pendingEmptyCards.add('Acme');
    Api.mutate.mockResolvedValue({ success: true, data: { lineId: 99 } });

    await App.DispatchPlan._handleDrop([{ poolItemId: 'P1', qty: 4 }], 'Acme');

    expect(Api.mutate).toHaveBeenCalledWith('saveDispatchPlanLine', expect.objectContaining({
      planDate: '2026-08-09',
      clientName: 'Acme',
      productId: 'P1',
      productName: 'Widget',
      qty: 4,
    }));
    expect(App.DispatchPlan._pendingEmptyCards.has('Acme')).toBe(false);
    expect(App.Dispatch.loadReadyData).toHaveBeenCalled();
  });

  test('_handleDrop saves multiple dropped items SEQUENTIALLY (each awaited before the next)', async () => {
    App.State.dispatchPlanDate = '2026-08-09';
    App.State.globalReadyToDispatch = [
      { productId: 'P1', productName: 'Widget', availableToPlan: 10, readyQty: 10 },
      { productId: 'P2', productName: 'Gadget', availableToPlan: 10, readyQty: 10 },
    ];
    const callOrder = [];
    Api.mutate.mockImplementation((method, payload) => {
      callOrder.push(payload.productId);
      return Promise.resolve({ success: true, data: { lineId: 1 } });
    });

    await App.DispatchPlan._handleDrop([{ poolItemId: 'P1', qty: 2 }, { poolItemId: 'P2', qty: 3 }], 'Acme');

    expect(callOrder).toEqual(['P1', 'P2']);
  });

  test('_handleDrop surfaces a rejected save via App.Utils.showToast without throwing', async () => {
    App.State.dispatchPlanDate = '2026-08-09';
    App.State.globalReadyToDispatch = [{ productId: 'P1', productName: 'Widget', availableToPlan: 1, readyQty: 1 }];
    Api.mutate.mockResolvedValue({ success: false, message: 'Only 1 unit(s) of "P1" are available to plan.' });

    await App.DispatchPlan._handleDrop([{ poolItemId: 'P1', qty: 5 }], 'Acme');

    expect(App.Utils.showToast).toHaveBeenCalledWith(expect.stringContaining('available to plan'), true);
  });

  test('_handleDrop inherits the card\'s existing Transport value onto a newly-dropped line', async () => {
    App.State.dispatchPlanDate = '2026-08-09';
    App.State.globalReadyToDispatch = [{ productId: 'P2', productName: 'Gadget', availableToPlan: 10, readyQty: 10 }];
    App.State.globalDispatchPlans = [
      { lineId: 1, planDate: '2026-08-09', clientName: 'Acme', productId: 'P1', productName: 'Widget', qty: 3, transport: 'Truck #7', fulfilled: false },
    ];
    Api.mutate.mockResolvedValue({ success: true, data: { lineId: 2 } });

    await App.DispatchPlan._handleDrop([{ poolItemId: 'P2', qty: 5 }], 'Acme');

    expect(Api.mutate).toHaveBeenCalledWith('saveDispatchPlanLine', expect.objectContaining({
      productId: 'P2', transport: 'Truck #7',
    }));
  });

  test('_handleDrop leaves transport blank for a brand-new card with no existing lines', async () => {
    App.State.dispatchPlanDate = '2026-08-09';
    App.State.globalReadyToDispatch = [{ productId: 'P1', productName: 'Widget', availableToPlan: 10, readyQty: 10 }];
    App.State.globalDispatchPlans = [];
    Api.mutate.mockResolvedValue({ success: true, data: { lineId: 1 } });

    await App.DispatchPlan._handleDrop([{ poolItemId: 'P1', qty: 5 }], 'BrandNewClient');

    expect(Api.mutate).toHaveBeenCalledWith('saveDispatchPlanLine', expect.objectContaining({ transport: '' }));
  });

  test('_handleRateChange resends every other field of the line unchanged, overriding only rate', async () => {
    App.State.globalDispatchPlans = [
      { lineId: 5, planDate: '2026-08-09', clientName: 'Acme', productId: 'P1', productName: 'Widget', qty: 3, sortOrder: 0, rate: 0, remarks: 'Old remark', transport: 'Old truck' },
    ];
    Api.mutate.mockResolvedValue({ success: true, data: {} });

    await App.DispatchPlan._handleRateChange(5, 9.5);

    expect(Api.mutate).toHaveBeenCalledWith('saveDispatchPlanLine', expect.objectContaining({
      lineId: 5, qty: 3, rate: 9.5, remarks: 'Old remark', transport: 'Old truck',
    }));
  });

  test('_handleRemarksChange resends every other field of the line unchanged, overriding only remarks', async () => {
    App.State.globalDispatchPlans = [
      { lineId: 5, planDate: '2026-08-09', clientName: 'Acme', productId: 'P1', productName: 'Widget', qty: 3, sortOrder: 0, rate: 9.5, remarks: '', transport: 'Old truck' },
    ];
    Api.mutate.mockResolvedValue({ success: true, data: {} });

    await App.DispatchPlan._handleRemarksChange(5, 'Fragile');

    expect(Api.mutate).toHaveBeenCalledWith('saveDispatchPlanLine', expect.objectContaining({
      lineId: 5, qty: 3, rate: 9.5, remarks: 'Fragile', transport: 'Old truck',
    }));
  });

  test('_handleTransportChange updates every OPEN line of the card (not fulfilled ones), preserving each line\'s own qty/rate/remarks', async () => {
    App.State.dispatchPlanDate = '2026-08-09';
    App.State.globalDispatchPlans = [
      { lineId: 1, planDate: '2026-08-09', clientName: 'Acme', productId: 'P1', productName: 'Widget', qty: 3, rate: 5, remarks: 'a', transport: '', fulfilled: false },
      { lineId: 2, planDate: '2026-08-09', clientName: 'Acme', productId: 'P2', productName: 'Gadget', qty: 1, rate: 0, remarks: '', transport: '', fulfilled: true },
      { lineId: 3, planDate: '2026-08-09', clientName: 'OtherClient', productId: 'P1', productName: 'Widget', qty: 9, rate: 0, remarks: '', transport: '', fulfilled: false },
    ];
    Api.mutate.mockResolvedValue({ success: true, data: {} });

    await App.DispatchPlan._handleTransportChange('Acme', 'Van #2');

    expect(Api.mutate).toHaveBeenCalledTimes(1);
    expect(Api.mutate).toHaveBeenCalledWith('saveDispatchPlanLine', expect.objectContaining({
      lineId: 1, qty: 3, rate: 5, remarks: 'a', transport: 'Van #2',
    }));
  });

  test('_handleTransportChange is a no-op for a card with no open lines (e.g. a pending empty card)', async () => {
    App.State.dispatchPlanDate = '2026-08-09';
    App.State.globalDispatchPlans = [];

    await App.DispatchPlan._handleTransportChange('DraftClient', 'Van #2');

    expect(Api.mutate).not.toHaveBeenCalled();
  });

  test('_handleQtyChange resaves the existing line with its own identity; unknown lineId is a no-op', async () => {
    App.State.globalDispatchPlans = [
      { lineId: 5, planDate: '2026-08-09', clientName: 'Acme', productId: 'P1', productName: 'Widget', qty: 3, sortOrder: 0 },
    ];
    Api.mutate.mockResolvedValue({ success: true, data: {} });

    await App.DispatchPlan._handleQtyChange(5, 7);
    expect(Api.mutate).toHaveBeenCalledWith('saveDispatchPlanLine', expect.objectContaining({
      lineId: 5, clientName: 'Acme', productId: 'P1', qty: 7,
    }));

    Api.mutate.mockClear();
    await App.DispatchPlan._handleQtyChange(999, 7);
    expect(Api.mutate).not.toHaveBeenCalled();
  });

  test('_handleRemoveLine deletes by id then reloads plan + ready data', async () => {
    Api.mutate.mockResolvedValue({ success: true, data: null });

    await App.DispatchPlan._handleRemoveLine(5);

    expect(Api.mutate).toHaveBeenCalledWith('deleteDispatchPlanLine', 5);
    expect(App.Dispatch.loadReadyData).toHaveBeenCalled();
  });

  test('_handleConvertCard forwards only this card\'s non-fulfilled lines for the selected date, with an untouched (0) rate left undefined', () => {
    App.State.dispatchPlanDate = '2026-08-09';
    App.State.globalDispatchPlans = [
      { lineId: 1, planDate: '2026-08-09', clientName: 'Acme', productId: 'P1', productName: 'Widget', qty: 3, rate: 0, remarks: '', transport: '', fulfilled: false },
      { lineId: 2, planDate: '2026-08-09', clientName: 'Acme', productId: 'P2', productName: 'Gadget', qty: 1, rate: 0, remarks: '', transport: '', fulfilled: true },
      { lineId: 3, planDate: '2026-08-09', clientName: 'OtherClient', productId: 'P1', productName: 'Widget', qty: 9, rate: 0, remarks: '', transport: '', fulfilled: false },
    ];

    App.DispatchPlan._handleConvertCard('Acme');

    expect(App.Dispatch.openPrefilledDispatchModal).toHaveBeenCalledWith(
      'Acme',
      [{ productId: 'P1', qty: 3, rate: undefined }],
      [1],
      '',
      '',
    );
  });

  test('_handleConvertCard carries the card\'s rate and transport through, and passes a single line\'s remarks as-is', () => {
    App.State.dispatchPlanDate = '2026-08-09';
    App.State.globalDispatchPlans = [
      { lineId: 1, planDate: '2026-08-09', clientName: 'Acme', productId: 'P1', productName: 'Widget', qty: 3, rate: 12.5, remarks: 'Handle with care', transport: 'Truck #7', fulfilled: false },
    ];

    App.DispatchPlan._handleConvertCard('Acme');

    expect(App.Dispatch.openPrefilledDispatchModal).toHaveBeenCalledWith(
      'Acme',
      [{ productId: 'P1', qty: 3, rate: 12.5 }],
      [1],
      'Truck #7',
      'Handle with care',
    );
  });

  test('_handleConvertCard joins MULTIPLE distinct per-line remarks, prefixed by product name, and skips blank ones', () => {
    App.State.dispatchPlanDate = '2026-08-09';
    App.State.globalDispatchPlans = [
      { lineId: 1, planDate: '2026-08-09', clientName: 'Acme', productId: 'P1', productName: 'Widget', qty: 3, rate: 0, remarks: 'Fragile', transport: '', fulfilled: false },
      { lineId: 2, planDate: '2026-08-09', clientName: 'Acme', productId: 'P2', productName: 'Gadget', qty: 1, rate: 0, remarks: '', transport: '', fulfilled: false },
      { lineId: 3, planDate: '2026-08-09', clientName: 'Acme', productId: 'P3', productName: 'Gizmo', qty: 2, rate: 0, remarks: 'Keep dry', transport: '', fulfilled: false },
    ];

    App.DispatchPlan._handleConvertCard('Acme');

    const [, , , , remarks] = App.Dispatch.openPrefilledDispatchModal.mock.calls[0];
    expect(remarks).toBe('Widget: Fragile; Gizmo: Keep dry');
  });

  test('_handleConvertCard is a no-op when the card has no open lines', () => {
    App.State.dispatchPlanDate = '2026-08-09';
    App.State.globalDispatchPlans = [];

    App.DispatchPlan._handleConvertCard('Nobody');

    expect(App.Dispatch.openPrefilledDispatchModal).not.toHaveBeenCalled();
  });

  test('_handleCancelCard on a pending (unsaved) empty card just drops it locally -- no confirm, no API call', () => {
    App.DispatchPlan._pendingEmptyCards.add('DraftClient');

    App.DispatchPlan._handleCancelCard('DraftClient');

    expect(App.DispatchPlan._pendingEmptyCards.has('DraftClient')).toBe(false);
    expect(App.Utils.confirmAction).not.toHaveBeenCalled();
    expect(Api.mutate).not.toHaveBeenCalled();
  });

  test('_handleCancelCard on a card whose only lines are already fulfilled also just drops it locally', () => {
    App.State.dispatchPlanDate = '2026-08-09';
    App.State.globalDispatchPlans = [
      { lineId: 1, planDate: '2026-08-09', clientName: 'Acme', productId: 'P1', productName: 'Widget', qty: 3, fulfilled: true },
    ];

    App.DispatchPlan._handleCancelCard('Acme');

    expect(App.Utils.confirmAction).not.toHaveBeenCalled();
    expect(Api.mutate).not.toHaveBeenCalled();
  });

  test('_handleCancelCard on a card with open lines confirms, then deletes only the non-fulfilled lines and reloads', async () => {
    App.State.dispatchPlanDate = '2026-08-09';
    App.State.globalDispatchPlans = [
      { lineId: 1, planDate: '2026-08-09', clientName: 'Acme', productId: 'P1', productName: 'Widget', qty: 3, fulfilled: false },
      { lineId: 2, planDate: '2026-08-09', clientName: 'Acme', productId: 'P2', productName: 'Gadget', qty: 1, fulfilled: true },
      { lineId: 3, planDate: '2026-08-09', clientName: 'OtherClient', productId: 'P1', productName: 'Widget', qty: 9, fulfilled: false },
    ];
    Api.mutate.mockResolvedValue({ success: true, data: null });

    App.DispatchPlan._handleCancelCard('Acme');
    // confirmAction's mock invokes its callback synchronously, but the
    // callback itself is async -- _handleCancelCard doesn't return that
    // promise (real confirmAction couldn't either, it resolves on a later
    // button click), so await it via what the mock itself returned instead
    // of guessing how many microtask hops to flush.
    await App.Utils.confirmAction.mock.results[0].value;

    expect(App.Utils.confirmAction).toHaveBeenCalledWith(expect.stringContaining('Acme'), expect.any(Function));
    expect(App.Utils.confirmAction).toHaveBeenCalledWith(expect.stringContaining('1 item'), expect.any(Function));
    expect(Api.mutate).toHaveBeenCalledTimes(1);
    expect(Api.mutate).toHaveBeenCalledWith('deleteDispatchPlanLine', 1);
    expect(Api.mutate).not.toHaveBeenCalledWith('deleteDispatchPlanLine', 2); // fulfilled -- untouched
    expect(Api.mutate).not.toHaveBeenCalledWith('deleteDispatchPlanLine', 3); // a different client -- untouched
    expect(App.Dispatch.loadReadyData).toHaveBeenCalled();
  });

  test('_handleCancelCard surfaces a failed delete via showToast without throwing', async () => {
    App.State.dispatchPlanDate = '2026-08-09';
    App.State.globalDispatchPlans = [
      { lineId: 1, planDate: '2026-08-09', clientName: 'Acme', productId: 'P1', productName: 'Widget', qty: 3, fulfilled: false },
    ];
    Api.mutate.mockResolvedValue({ success: false, message: 'This line has already been dispatched.' });

    App.DispatchPlan._handleCancelCard('Acme');
    await App.Utils.confirmAction.mock.results[0].value;

    expect(App.Utils.showToast).toHaveBeenCalledWith('This line has already been dispatched.', true);
  });

  test('printPlan() renders into #print-bulk-body and triggers window.print() via App.Print.trigger', () => {
    App.State.dispatchPlanDate = '2026-08-09';
    App.State.globalDispatchPlans = [
      { lineId: 1, planDate: '2026-08-09', clientName: 'Acme', productId: 'P1', productName: 'Widget', qty: 3, fulfilled: false },
    ];

    App.DispatchPlan.printPlan();

    const body = document.getElementById('print-bulk-body');
    expect(body.innerHTML).toContain('Acme');
    expect(body.innerHTML).toContain('Widget');
    expect(App.Print.trigger).toHaveBeenCalledWith('print-bulk-container', expect.stringContaining('2026-08-09'));
  });

  test('printPlan() omits cards with no lines (a pending/empty card) from the printed document', () => {
    App.State.dispatchPlanDate = '2026-08-09';
    App.State.globalDispatchPlans = [];
    App.DispatchPlan._pendingEmptyCards.add('EmptyDraftClient');

    App.DispatchPlan.printPlan();

    const body = document.getElementById('print-bulk-body');
    expect(body.innerHTML).not.toContain('EmptyDraftClient');
    expect(body.innerHTML).toContain('No products planned for this date.');
  });

  test('printPlan() shows a real checkbox-shaped cell for open lines and a "Dispatched" marker for fulfilled ones', () => {
    App.State.dispatchPlanDate = '2026-08-09';
    App.State.globalDispatchPlans = [
      { lineId: 1, planDate: '2026-08-09', clientName: 'Acme', productId: 'P1', productName: 'Open Item', qty: 3, fulfilled: false },
      { lineId: 2, planDate: '2026-08-09', clientName: 'Acme', productId: 'P2', productName: 'Done Item', qty: 1, fulfilled: true },
    ];

    App.DispatchPlan.printPlan();

    const html = document.getElementById('print-bulk-body').innerHTML;
    expect(html).toContain('Dispatched');
    // The blank "Loaded" checkbox cell for the open line: a bordered box
    // with no text content -- crude but effective proxy since jsdom's
    // innerHTML round-trips the inline style attribute verbatim.
    expect(html).toMatch(/border:1px solid #666/);
  });

  test('printPlan() HTML-escapes client and product names', () => {
    App.State.dispatchPlanDate = '2026-08-09';
    App.State.globalDispatchPlans = [
      { lineId: 1, planDate: '2026-08-09', clientName: '<script>alert(1)</script>', productId: 'P1', productName: 'A & B "Widget"', qty: 3, fulfilled: false },
    ];

    App.DispatchPlan.printPlan();

    const html = document.getElementById('print-bulk-body').innerHTML;
    // The actual XSS-relevant characters (<, >) stay escaped; jsdom's own
    // innerHTML serializer normalizes &quot;/&#39; back to literal
    // "/' on readback since neither needs escaping inside text-node
    // content (only inside attribute values) -- not a bug in escapeHtml.
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('A &amp; B "Widget"');
  });

  test('printPlan() is a safe no-op (via notPortedYet) if App.Print never loaded', () => {
    const realPrint = App.Print;
    App.Print = undefined;

    App.DispatchPlan.printPlan();

    expect(App.Utils.notPortedYet).toHaveBeenCalledWith('Printing');
    App.Print = realPrint;
  });
});
