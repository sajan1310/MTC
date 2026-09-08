/**
 * The Production Sheet on the phone (Phase 6).
 *
 * A lot's sheet is a customized component list -- a substitution asked
 * for by the customer, a size swapped at the machine -- recorded
 * separately from what the lot actually consumed, which it never
 * touches. Making one was desktop-only, so the change happened at the
 * machine and was written down at a desk later, if at all.
 *
 * Desktop renders it as a Common table plus a per-colour matrix. The
 * data underneath is a flat list of components each tagged with its own
 * colour, which is what save_production_sheet stores and reads back, so
 * grouping that list by colour down the page loses nothing. Several of
 * the assertions below are about the two different shapes a component
 * row arrives in, since a recorded row and a saved sheet row do not
 * agree on either the quantity key or the colour key.
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

// A recorded-consumption row: qty + colorGroup, 'COMMON' for the shared
// ones. This is what MApp.Production.buildComponentsConsumed writes.
const CONSUMED = [
  { itemName: 'Rim 26', size: '26 inch', color: '', colorGroup: 'COMMON', qty: 100, unit: 'Pcs' },
  { itemName: 'Frame Sticker', size: '', color: 'Purple-Wine', colorGroup: 'Purple-Wine', qty: 40, unit: '' },
  { itemName: 'Frame Sticker', size: '', color: 'Black', colorGroup: 'Black', qty: 60, unit: '' },
];

// A saved sheet row: requiredQty + color, and no colorGroup at all.
const CUSTOM = [
  { itemName: 'Rim 26', size: '26 inch', narration: 'alloy', color: '', requiredQty: 90 },
  { itemName: 'Grip Set', size: '', narration: '', color: 'Black', requiredQty: 60 },
];

const LOT = {
  rowIdx: 42, lotNumber: 'LOT-1042', productId: 'PRD-1', productName: 'Kalpi 26',
  qty: 100, processId: 'P1', outputItemName: 'Frame 26',
  componentsConsumed: CONSUMED, customComponents: [], sheetRemarks: '',
};

function mount() {
  jest.resetModules();
  global.fetch = jest.fn();
  document.body.innerHTML = `
    <div id="mapp-sheet-backdrop"></div>
    <div class="mb-sheet" id="sheet-production-sheet">
      <h2 id="production-sheet-title"></h2>
      <div id="production-sheet-sub"></div>
      <div id="production-sheet-body"></div>
      <textarea id="production-sheet-remarks"></textarea>
      <button id="production-sheet-save-btn">Save sheet</button>
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
  MApp.ProductionSheet._itemCache = null;
  window.confirm = jest.fn(() => true);
  Element.prototype.scrollIntoView = jest.fn();
}

const body = () => document.getElementById('production-sheet-body');
const lot = extra => ({ ...LOT, ...extra });

describe('opening a sheet', () => {
  beforeEach(mount);

  test('an untouched lot starts from what it actually consumed', () => {
    // Production lots are tied to a Process recipe, not a Product recipe,
    // so the recorded consumption is the only thing to fall back to.
    MApp.ProductionSheet.open(lot());

    expect(MApp.ProductionSheet.rows.map(r => r.itemName))
      .toEqual(['Rim 26', 'Frame Sticker', 'Frame Sticker']);
    expect(body().textContent).toContain('Nothing is customized until you save');
  });

  test('a customized lot starts from its saved sheet', () => {
    MApp.ProductionSheet.open(lot({ customComponents: CUSTOM }));

    expect(MApp.ProductionSheet.rows.map(r => r.itemName)).toEqual(['Rim 26', 'Grip Set']);
    expect(body().textContent).not.toContain('Nothing is customized until you save');
  });

  test('a recorded row reads qty; a saved row reads requiredQty', () => {
    MApp.ProductionSheet.open(lot());
    expect(MApp.ProductionSheet.rows[0].requiredQty).toBe(100);

    MApp.ProductionSheet.open(lot({ customComponents: CUSTOM }));
    expect(MApp.ProductionSheet.rows[0].requiredQty).toBe(90);
  });

  test('colorGroup COMMON resolves to no colour, a real group to itself', () => {
    // A recorded row carries colorGroup and a saved row carries color;
    // reading both is what lets a sheet re-open into the grouping it was
    // saved from.
    MApp.ProductionSheet.open(lot());

    expect(MApp.ProductionSheet.rows.map(r => r.color)).toEqual(['', 'Purple-Wine', 'Black']);
  });

  test('components are grouped by colour, common first', () => {
    MApp.ProductionSheet.open(lot());

    const headings = [...body().querySelectorAll('.mapp-section-label')].map(h => h.textContent.trim());
    expect(headings).toEqual(['Common — all colours', 'Black', 'Purple-Wine']);
  });

  test('the header names the lot and what it is for', () => {
    MApp.ProductionSheet.open(lot());

    expect(document.getElementById('production-sheet-title').textContent).toBe('Sheet — LOT-1042');
    expect(document.getElementById('production-sheet-sub').textContent).toContain('Kalpi 26');
  });

  test('existing sheet remarks come back into the field', () => {
    MApp.ProductionSheet.open(lot({ sheetRemarks: 'customer asked for black grips' }));

    expect(document.getElementById('production-sheet-remarks').value)
      .toBe('customer asked for black grips');
  });

  test('a lot that consumed nothing reads as empty, not broken', () => {
    MApp.ProductionSheet.open(lot({ componentsConsumed: [] }));

    expect(body().textContent).toContain('No components');
  });
});

describe('editing a sheet', () => {
  beforeEach(mount);

  test('typing a quantity updates the row it belongs to', () => {
    MApp.ProductionSheet.open(lot());
    const input = document.getElementById('prod-sheet-qty-0');
    input.value = '95';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));

    expect(MApp.ProductionSheet.rows[0].requiredQty).toBe(95);
  });

  test('removing a row keeps quantities typed into the others', () => {
    // Removing re-renders, and a quantity typed but not yet committed
    // would otherwise be thrown away by the redraw.
    MApp.ProductionSheet.open(lot());
    document.getElementById('prod-sheet-qty-0').value = '95';

    MApp.ProductionSheet.removeRow(1);

    expect(MApp.ProductionSheet.rows.length).toBe(2);
    expect(MApp.ProductionSheet.rows[0].requiredQty).toBe(95);
  });

  test('a new row lands in Common rather than guessing a colour', async () => {
    // Which colour a new item belongs to is the one thing this screen
    // cannot infer, and a guess would put a quantity against a colour
    // nobody chose.
    MApp.Api.call = jest.fn(async () => ({ success: true, data: [{ name: 'Grip Set', size: '' }] }));
    MApp.ProductionSheet.open(lot());

    const done = MApp.ProductionSheet.addRow();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    document.querySelector('#mapp-picker-list .mb-picker-option').click();
    await done;

    const added = MApp.ProductionSheet.rows[MApp.ProductionSheet.rows.length - 1];
    expect(added).toEqual({ itemName: 'Grip Set', size: '', narration: '', color: '', requiredQty: '' });
  });

  test('reset goes back to the recorded consumption, without writing', async () => {
    MApp.ProductionSheet.open(lot({ customComponents: CUSTOM }));
    expect(MApp.ProductionSheet.rows.map(r => r.itemName)).toEqual(['Rim 26', 'Grip Set']);

    MApp.ProductionSheet.reset();

    expect(MApp.ProductionSheet.rows.map(r => r.itemName))
      .toEqual(['Rim 26', 'Frame Sticker', 'Frame Sticker']);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('declining the reset changes nothing', () => {
    window.confirm = jest.fn(() => false);
    MApp.ProductionSheet.open(lot({ customComponents: CUSTOM }));

    MApp.ProductionSheet.reset();

    expect(MApp.ProductionSheet.rows.map(r => r.itemName)).toEqual(['Rim 26', 'Grip Set']);
  });
});

describe('saving a sheet', () => {
  beforeEach(mount);

  test('sends the concurrency guard the server checks against', async () => {
    // expected_product_id / expected_qty make the server refuse if the lot
    // shifted since this list was drawn -- on a phone showing a list
    // loaded some time ago, a real possibility.
    Api.mutateWithId = jest.fn(async () => ({ success: true, data: {} }));
    MApp.ProductionSheet.open(lot());
    document.getElementById('production-sheet-remarks').value = 'swapped grips';

    await MApp.ProductionSheet.save();

    const call = Api.mutateWithId.mock.calls[0];
    expect(call[0]).toBe('saveProductionSheet');
    expect(call[2]).toBe(42);
    expect(call[3]).toBe('PRD-1');
    expect(call[4]).toBe(100);
    expect(call[6]).toBe('swapped grips');
  });

  test('components go as JSON in the shape the server reads', async () => {
    Api.mutateWithId = jest.fn(async () => ({ success: true, data: {} }));
    MApp.ProductionSheet.open(lot());

    await MApp.ProductionSheet.save();

    const sent = JSON.parse(Api.mutateWithId.mock.calls[0][5]);
    expect(sent[0]).toEqual({ itemName: 'Rim 26', size: '26 inch', narration: '', color: '', requiredQty: 100 });
    expect(sent[1]).toEqual({ itemName: 'Frame Sticker', size: '', narration: '', color: 'Purple-Wine', requiredQty: 40 });
  });

  test('rows with no quantity are dropped here, not silently by the server', async () => {
    // save_production_sheet drops them itself; filtering first means the
    // saved sheet matches what was on screen.
    Api.mutateWithId = jest.fn(async () => ({ success: true, data: {} }));
    MApp.ProductionSheet.open(lot());
    document.getElementById('prod-sheet-qty-1').value = '0';

    await MApp.ProductionSheet.save();

    const sent = JSON.parse(Api.mutateWithId.mock.calls[0][5]);
    expect(sent.map(c => c.color)).toEqual(['', 'Black']);
  });

  test('a quantity typed but never blurred is still saved', async () => {
    // The inputs are the source of truth at save time, so nothing depends
    // on the field having lost focus first -- on a phone it usually has
    // not when the operator reaches straight for Save.
    Api.mutateWithId = jest.fn(async () => ({ success: true, data: {} }));
    MApp.ProductionSheet.open(lot());
    document.getElementById('prod-sheet-qty-0').value = '95';

    await MApp.ProductionSheet.save();

    const sent = JSON.parse(Api.mutateWithId.mock.calls[0][5]);
    expect(sent[0].requiredQty).toBe(95);
  });

  test('an empty sheet is confirmed, because it clears the customization', async () => {
    Api.mutateWithId = jest.fn(async () => ({ success: true, data: {} }));
    MApp.ProductionSheet.open(lot({ componentsConsumed: [] }));

    await MApp.ProductionSheet.save();

    expect(window.confirm.mock.calls[0][0]).toContain('clears the customization');
    expect(Api.mutateWithId).toHaveBeenCalled();
  });

  test('declining that confirmation sends nothing', async () => {
    window.confirm = jest.fn(() => false);
    Api.mutateWithId = jest.fn();
    MApp.ProductionSheet.open(lot({ componentsConsumed: [] }));

    await MApp.ProductionSheet.save();

    expect(Api.mutateWithId).not.toHaveBeenCalled();
  });

  test('the lot is patched from what the server echoed, not what was typed', async () => {
    // save_production_sheet normalises narration against Items Master, so
    // re-opening should show what was stored.
    const echoed = [{ itemName: 'Rim 26', size: '26 inch', narration: 'ALLOY 36H', color: '', requiredQty: 100 }];
    Api.mutateWithId = jest.fn(async () => ({
      success: true,
      data: { customComponents: echoed, sheetRemarks: 'swapped' },
      message: 'Production sheet for Lot #LOT-1042 saved.',
    }));
    const target = lot();
    MApp.ProductionSheet.open(target);

    await MApp.ProductionSheet.save();

    expect(target.customComponents).toEqual(echoed);
    expect(target.sheetRemarks).toBe('swapped');
  });

  test('the server message is shown rather than a canned one', async () => {
    Api.mutateWithId = jest.fn(async () => ({
      success: true, data: {}, message: 'Production sheet for Lot #LOT-1042 saved.',
    }));
    const spy = jest.spyOn(MApp.Toast, 'success');
    MApp.ProductionSheet.open(lot());

    await MApp.ProductionSheet.save();

    expect(spy).toHaveBeenCalledWith('Production sheet for Lot #LOT-1042 saved.');
    spy.mockRestore();
  });

  test('a stale-record refusal is reported and the sheet stays open', async () => {
    Api.mutateWithId = jest.fn(async () => ({
      success: false,
      message: 'Data mismatch: The record has been modified or shifted. Please refresh.',
    }));
    const spy = jest.spyOn(MApp.Toast, 'error');
    const target = lot();
    MApp.ProductionSheet.open(target);

    await MApp.ProductionSheet.save();

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('modified or shifted'));
    expect(target.customComponents).toEqual([]);
    expect(document.getElementById('production-sheet-save-btn').disabled).toBe(false);
    spy.mockRestore();
  });

  test('a network failure re-enables the button instead of stranding it', async () => {
    Api.mutateWithId = jest.fn(async () => { throw new Error('offline'); });
    MApp.ProductionSheet.open(lot());

    await MApp.ProductionSheet.save();

    const btn = document.getElementById('production-sheet-save-btn');
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('Save sheet');
  });
});
