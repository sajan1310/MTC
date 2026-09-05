/**
 * A bill saved from the phone must not silently double-count Stock (D-01).
 *
 * Desktop's bill.js calls checkStockAdjustmentConflicts before every save
 * and, when the bill's date falls on or before a manual Stock correction
 * for one of its items, offers a three-way choice. Choosing "ledger only"
 * sends excludeFromStockKeys so bill_service.py leaves those items out of
 * Stock's Billed Qty sum.
 *
 * MApp called saveBill directly and sent no excludeFromStockKeys at all --
 * which bill_service.py reads as an empty set, so every item hit Stock.
 * A bill entered on the floor for goods a physical recount had already
 * counted was added on top of that recount, silently. These tests pin the
 * ported flow, including the three outcomes and the advisory-failure path.
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

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

const CONFLICTS = [
  { itemName: 'Rim 26', size: '26 inch', adjustmentDate: '2026-08-14T00:00:00', reason: 'Physical recount' },
  { itemName: 'Spoke', size: '', adjustmentDate: '2026-08-20T00:00:00', reason: '' },
];

describe('MApp.Bill stock-correction conflict guard', () => {
  let saved;

  beforeEach(() => {
    jest.resetModules();
    global.fetch = jest.fn();

    document.body.innerHTML = `
      <div id="mapp-sheet-backdrop"></div>
      <div class="mb-sheet" id="sheet-bill-form"></div>
      <div class="mb-sheet" id="sheet-bill-stock-conflict">
        <div id="bill-stock-conflict-list"></div>
      </div>
      <input id="bill-form-number" value="B-1042">
      <input id="bill-form-date" value="2026-08-01">
      <input id="bill-form-contact" value="">
      <input id="bill-form-remarks" value="">
      <button id="bill-form-save-btn"></button>`;

    loadAsGlobal('api.js', 'Api');
    loadAsGlobal('mobile.js', 'MApp');

    MApp.Sheet._stack = [];
    MApp.Bill.selection = { vendor: 'Acme Cycles' };
    MApp.Bill.editingBillNumber = null;
    MApp.Bill.lines = [
      { name: 'Rim 26', size: '26 inch', qty: 10, price: 100, unit: 'Pcs', gst: 18 },
      { name: 'Spoke', size: '', qty: 500, price: 2, unit: 'Pcs', gst: 18 },
    ];

    // Capture what would be sent, and stop the flow before any reload.
    saved = null;
    MApp.Util.mutateSimple = jest.fn(async (method, args) => {
      saved = { method, formData: args[0] };
      return { success: false }; // false => saveBill returns without re-rendering
    });
    MApp.Bill.closeForm = jest.fn();
    MApp.Bill.openLedgerSheet = jest.fn();
  });

  test('no conflicts: saves with an empty exclusion list', async () => {
    MApp.Api.call = jest.fn(async () => ({ success: true, data: [] }));

    await MApp.Bill.saveBill();

    expect(MApp.Api.call).toHaveBeenCalledWith(
      'checkStockAdjustmentConflicts',
      [{ name: 'Rim 26', size: '26 inch' }, { name: 'Spoke', size: '' }],
      '2026-08-01'
    );
    expect(saved.method).toBe('saveBill');
    expect(saved.formData.excludeFromStockKeys).toBe('[]');
  });

  test('"ledger only" excludes exactly the conflicting items, keyed as name|size lowercased', async () => {
    MApp.Api.call = jest.fn(async () => ({ success: true, data: CONFLICTS }));

    const saving = MApp.Bill.saveBill();
    await tick();

    // The sheet is up and the save has not happened yet.
    expect(MApp.Sheet._stack.map(e => e.id)).toContain('sheet-bill-stock-conflict');
    expect(saved).toBeNull();

    MApp.Bill.resolveStockConflict('ledger');
    await saving;

    // bill_service.py lowercases and trims the same way when building its
    // exclude_set, so these keys have to match that shape exactly.
    expect(JSON.parse(saved.formData.excludeFromStockKeys)).toEqual(['rim 26|26 inch', 'spoke|']);
  });

  test('"update Stock anyway" saves normally despite the conflict', async () => {
    MApp.Api.call = jest.fn(async () => ({ success: true, data: CONFLICTS }));

    const saving = MApp.Bill.saveBill();
    await tick();
    MApp.Bill.resolveStockConflict('update');
    await saving;

    expect(saved.formData.excludeFromStockKeys).toBe('[]');
  });

  test('cancelling abandons the save entirely', async () => {
    MApp.Api.call = jest.fn(async () => ({ success: true, data: CONFLICTS }));

    const saving = MApp.Bill.saveBill();
    await tick();
    MApp.Bill.resolveStockConflict('cancel');
    await saving;

    expect(saved).toBeNull();
    expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();
  });

  test('dismissing the sheet counts as cancel, not as consent', async () => {
    // Back/Escape/X all route through Sheet.dismissTop -> onDismiss. The
    // safe reading of "the operator did not choose" is to abort, never to
    // fall through to updating Stock.
    MApp.Api.call = jest.fn(async () => ({ success: true, data: CONFLICTS }));

    const saving = MApp.Bill.saveBill();
    await tick();
    MApp.Sheet.dismissTop(false);
    await saving;

    expect(saved).toBeNull();
  });

  test('the conflict sheet names each item and when it was recounted', async () => {
    MApp.Api.call = jest.fn(async () => ({ success: true, data: CONFLICTS }));

    const saving = MApp.Bill.saveBill();
    await tick();

    const html = document.getElementById('bill-stock-conflict-list').innerHTML;
    expect(html).toContain('Rim 26');
    expect(html).toContain('26 inch');
    expect(html).toContain('Physical recount');
    expect(html).toContain('14 Aug');

    MApp.Bill.resolveStockConflict('cancel');
    await saving;
  });

  test('the check is advisory: if it throws, the bill still saves', async () => {
    MApp.Api.call = jest.fn(async () => { throw new Error('offline'); });

    await MApp.Bill.saveBill();

    expect(saved.method).toBe('saveBill');
    expect(saved.formData.excludeFromStockKeys).toBe('[]');
  });

  test('validation still runs before the check -- no network call for an empty bill', async () => {
    MApp.Api.call = jest.fn();
    MApp.Bill.lines = [];

    await MApp.Bill.saveBill();

    expect(MApp.Api.call).not.toHaveBeenCalled();
    expect(saved).toBeNull();
  });
});
