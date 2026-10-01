/**
 * Wastage written off the Warehouse Pool, on the phone (migration 048).
 *
 * A processed item -- a painted frame that came out of the booth with a run
 * in it -- lives in a Warehouse Pool bucket, not in Items Stock. The phone's
 * wastage form gains "+ Add from Warehouse Pool" lines: the item from the
 * pool, then the colour it was made in, sent as desktop's form sends them.
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

const ITEMS = [{ name: 'Hub Axle', size: '', baseUnit: 'Pcs' }];
const PROCESSES = [
  { processId: 'P1', processName: 'Painting 20 inch' },
  { processId: 'P2', processName: 'Rim Fitting' }
];
const POOL = [
  { outputItemName: 'Painted Frame 20', processId: 'P1', productTag: '', color: 'Red-White', availableQty: 7, countsTowardTotal: true },
  { outputItemName: 'Painted Frame 20', processId: 'P1', productTag: '', color: 'Blue-White', availableQty: 42, countsTowardTotal: true },
  { outputItemName: 'Painted Frame 20', processId: 'P1', productTag: '', color: 'Kit Bag', availableQty: 10, countsTowardTotal: false },
  { outputItemName: 'Fitted Rim 20', processId: 'P2', productTag: '', color: '', availableQty: 30, countsTowardTotal: true },
  { outputItemName: 'Packing Set', processId: 'P2', productTag: '', color: 'Kit Bag', availableQty: 4, countsTowardTotal: false }
];

function mount() {
  jest.resetModules();
  global.fetch = jest.fn();
  document.body.innerHTML = `
    <div id="mapp-sheet-backdrop"></div>
    <div class="mb-sheet" id="sheet-wastage-log">
      <div class="mb-search"><input type="search" id="wastage-log-search"></div>
      <div id="wastage-log-list"></div>
    </div>
    <div class="mb-sheet" id="sheet-wastage-form">
      <h2>Log Wastage</h2>
      <div id="wastage-form-body"></div>
      <button id="wastage-form-save-btn">Log Wastage</button>
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
  MApp.Paging._shown = {};
  window.confirm = jest.fn(() => true);
  Element.prototype.scrollIntoView = jest.fn();

  MApp.Api.call = jest.fn(async method => {
    if (method === 'getItemsData') return { success: true, data: ITEMS };
    if (method === 'getWarehousePoolData') return { success: true, data: POOL };
    if (method === 'getWastageData') return { success: true, data: [] };
    return { success: false };
  });
  MApp.Api.callCached = jest.fn(async method => (
    method === 'getProcessData' ? { success: true, data: PROCESSES } : { success: false }
  ));
  Api.mutateWithId = jest.fn(async () => ({
    success: true, data: { wastageId: 'WST-1' }, message: 'Wastage WST-1 logged successfully.'
  }));
}

const pickerLabels = () => [...document.querySelectorAll('#mapp-picker-list .mb-picker-option')]
  .map(b => b.textContent.trim());

const pick = label => {
  const btn = [...document.querySelectorAll('#mapp-picker-list .mb-picker-option')]
    .find(b => b.textContent.trim().startsWith(label));
  btn.click();
};

async function choose(open, label) {
  const done = open();
  await Promise.resolve();
  pick(label);
  await done;
}

const toasts = () => document.getElementById('mapp-toast-stack').textContent;

// A pool line on its own: the blank Items Stock line the form opens with
// is removed, as an operator logging only frames would.
async function poolLineFor(name, colour) {
  await MApp.Wastage.openForm();
  MApp.Wastage.addLine('POOL');
  MApp.Wastage.removeLine(0);
  await choose(() => MApp.Wastage.pickPoolItem(0), name);
  if (colour) await choose(() => MApp.Wastage.pickPoolBucket(0), colour);
  return MApp.Wastage.lines[0];
}

describe('a Warehouse Pool line', () => {
  beforeEach(mount);

  test('offers the pool\'s processed items -- with their process and stock -- and none that is only a sub-group', async () => {
    await MApp.Wastage.openForm();
    MApp.Wastage.addLine('POOL');

    const done = MApp.Wastage.pickPoolItem(1);
    await Promise.resolve();
    const labels = pickerLabels();
    pick('Fitted Rim 20');
    await done;

    expect(labels).toHaveLength(2);
    expect(labels[0]).toContain('Fitted Rim 20');
    expect(labels[0]).toContain('Rim Fitting');
    expect(labels[1]).toContain('Painted Frame 20');
    expect(labels[1]).toContain('49 available'); // 7 + 42; the sub-group's 10 is not stock
  });

  test('an item made in one colour takes it', async () => {
    const line = await poolLineFor('Fitted Rim 20');
    expect(line).toMatchObject({ name: 'Fitted Rim 20', color: '', productTag: '', picked: true });
  });

  test('an item made in several asks which, showing what each holds', async () => {
    const line = await poolLineFor('Painted Frame 20');
    expect(line.picked).toBe(false);

    const done = MApp.Wastage.pickPoolBucket(0);
    await Promise.resolve();
    const labels = pickerLabels();
    pick('Red-White');
    await done;

    expect(labels).toHaveLength(2);
    expect(labels[0]).toContain('Blue-White');
    expect(labels[0]).toContain('42 available');
    expect(line).toMatchObject({ color: 'Red-White', picked: true });
    expect(document.getElementById('wastage-form-lines').textContent).toContain('Red-White');
  });

  test('saves as desktop does: the bucket\'s item, colour and tag, in pieces', async () => {
    const line = await poolLineFor('Painted Frame 20', 'Blue-White');
    MApp.Wastage.updateLine(0, 'qty', '3');
    MApp.Wastage.updateLineText(0, 'reason', 'Paint run');
    expect(line.qty).toBe(3);

    await MApp.Wastage.save();

    expect(Api.mutateWithId).toHaveBeenCalledTimes(1);
    const [method, , form] = Api.mutateWithId.mock.calls[0];
    expect(method).toBe('saveWastage');
    expect(JSON.parse(form.items)).toEqual([{
      sourceType: 'POOL', name: 'Painted Frame 20', color: 'Blue-White', productTag: '',
      unit: 'Pcs', qty: 3, reason: 'Paint run'
    }]);
  });

  test('a line with no colour chosen is refused, by name', async () => {
    await poolLineFor('Painted Frame 20');
    MApp.Wastage.updateLine(0, 'qty', '3');

    await MApp.Wastage.save();

    expect(Api.mutateWithId).not.toHaveBeenCalled();
    expect(toasts()).toContain('Choose which colour of "Painted Frame 20" was wasted.');
  });

  test('a write-off taking more than the pool holds says so, rather than a plain "logged"', async () => {
    Api.mutateWithId = jest.fn(async () => ({
      success: true,
      data: { wastageId: 'WST-2' },
      message: 'Wastage WST-2 logged successfully. Warning: Only 7 unit(s) of "Painted Frame 20" in "Red-White" are available in the Warehouse Pool.'
    }));
    await poolLineFor('Painted Frame 20', 'Red-White');
    MApp.Wastage.updateLine(0, 'qty', '9');

    await MApp.Wastage.save();

    expect(toasts()).toContain('Warning: Only 7 unit(s)');
  });

  test('editing restores a pool line as chosen, and keeps an Items Stock line beside it', async () => {
    await MApp.Wastage.openForm({
      wastageId: 'WST-3', dateRaw: '2026-09-15', vendor: '', remarks: '',
      items: [
        { sourceType: 'ITEM', name: 'Hub Axle', size: '', unit: 'Pcs', qty: 1, reason: 'Bent' },
        { sourceType: 'POOL', name: 'Painted Frame 20', color: 'Blue-White', productTag: '', unit: 'Pcs', qty: 3, reason: 'Paint run' }
      ]
    });

    expect(MApp.Wastage.lines.map(l => [l.sourceType, l.name, l.color, l.picked])).toEqual([
      ['ITEM', 'Hub Axle', undefined, undefined],
      ['POOL', 'Painted Frame 20', 'Blue-White', true]
    ]);
    const body = document.getElementById('wastage-form-body').textContent;
    expect(body).toContain('From Warehouse Pool');
    expect(body).toContain('Blue-White');

    await MApp.Wastage.save();
    const [, , form] = Api.mutateWithId.mock.calls[0];
    expect(form.existingWastageId).toBe('WST-3');
    expect(JSON.parse(form.items).map(i => i.sourceType)).toEqual(['ITEM', 'POOL']);
  });
});

describe('the wastage log', () => {
  beforeEach(mount);

  test('names a pool line\'s colour, and a colour finds its record', async () => {
    MApp.Api.call = jest.fn(async () => ({
      success: true,
      data: [{
        wastageId: 'WST-4', date: '15/09/2026', dateRaw: '2026-09-15', vendor: '', remarks: '', totalQty: 3,
        items: [{ sourceType: 'POOL', name: 'Painted Frame 20', color: 'Blue-White', productTag: '', unit: 'Pcs', qty: 3, reason: 'Paint run' }]
      }]
    }));
    await MApp.Wastage.open();

    expect(document.getElementById('wastage-log-list').textContent).toContain('Painted Frame 20 · Blue-White (3 Pcs)');

    MApp.Wastage.onSearch('blue-white');
    expect(MApp.Wastage.filtered.map(r => r.wastageId)).toEqual(['WST-4']);
  });
});
