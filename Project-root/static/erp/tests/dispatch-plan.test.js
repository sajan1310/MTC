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
    document.body.innerHTML = '<input type="date" id="dispatchPlanDate"><div id="dispatchPlanRoot"></div>';

    global.tomorrowIso = () => '2026-08-09';
    global.Api = { call: jest.fn(), mutate: jest.fn() };
    global.App = {
      State: {
        globalReadyToDispatch: [],
        globalDispatchPlans: [],
        dispatchPlanDate: '',
      },
      Utils: { showToast: jest.fn() },
      Dispatch: {
        loadReadyData: jest.fn().mockResolvedValue(undefined),
        openPrefilledDispatchModal: jest.fn(),
      },
      PlanningBoard: { mount: jest.fn() },
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

  test('_handleConvertCard forwards only this card\'s non-fulfilled lines for the selected date', () => {
    App.State.dispatchPlanDate = '2026-08-09';
    App.State.globalDispatchPlans = [
      { lineId: 1, planDate: '2026-08-09', clientName: 'Acme', productId: 'P1', productName: 'Widget', qty: 3, fulfilled: false },
      { lineId: 2, planDate: '2026-08-09', clientName: 'Acme', productId: 'P2', productName: 'Gadget', qty: 1, fulfilled: true },
      { lineId: 3, planDate: '2026-08-09', clientName: 'OtherClient', productId: 'P1', productName: 'Widget', qty: 9, fulfilled: false },
    ];

    App.DispatchPlan._handleConvertCard('Acme');

    expect(App.Dispatch.openPrefilledDispatchModal).toHaveBeenCalledWith(
      'Acme',
      [{ productId: 'P1', qty: 3 }],
      [1],
    );
  });

  test('_handleConvertCard is a no-op when the card has no open lines', () => {
    App.State.dispatchPlanDate = '2026-08-09';
    App.State.globalDispatchPlans = [];

    App.DispatchPlan._handleConvertCard('Nobody');

    expect(App.Dispatch.openPrefilledDispatchModal).not.toHaveBeenCalled();
  });
});
