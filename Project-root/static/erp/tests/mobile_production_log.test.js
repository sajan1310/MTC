/**
 * Logging and updating a production lot on the phone.
 *
 * What the lot records is mobile_lot_model_parity.test.js's business --
 * that suite holds the phone's model to desktop's form. This one is the
 * screen: that a process can be found without climbing four pickers, that
 * a colour's quantity is typed rather than stepped one tap at a time, that
 * what the lot consumes is on screen and correctable (and a correction
 * stays put), that saving sends the model's payload and keeps the sheet
 * ready for the next lot of the same process, that an edit sends back what
 * the lot saved when nothing that feeds it changed, and that deleting
 * carries desktop's concurrency guard.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'mobile_styles.css'), 'utf8');

// Each eval() gets its own scope; in a browser api.js's functions are
// globals every later script can call, so the ones the form calls are
// republished here.
function loadAsGlobal(relPath, exportName, extra = '') {
  const code = fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8')
    .replace(new RegExp(`^const ${exportName} = `, 'm'), `global.${exportName} = `);
  eval(code + extra);
}

const PROCESSES = [
  { processId: 'PRC-PNT', processName: 'Frame Painting 20', processType: 'Painting', outputItemName: 'Painted Frame Kalpi 20 inch', sequence: 2, active: true, isFinalStage: false },
  { processId: 'PRC-ASM', processName: 'Assembly Kalpi 20', processType: 'Assembly', outputItemName: 'Assembled Kalpi 20 inch', sequence: 4, active: true, isFinalStage: false },
  { processId: 'PRC-CUT', processName: 'Tube Cutting', processType: 'Cutting', outputItemName: 'Cut Tube Set 26 inch', sequence: 1, active: true, isFinalStage: false },
  { processId: 'PRC-OLD', processName: 'Old Line', processType: 'Painting', outputItemName: 'Old 20 inch', sequence: 1, active: false, isFinalStage: false }
];

const DATA = {
  'PRC-PNT': {
    colors: ['Red', 'Blue'],
    axes: { axes: [], primaryAxisKey: '', primaryIsDefault: false },
    recipe: [
      { itemName: 'Primer', size: '5 L', narration: '', qtyPerUnit: 0.125, sourceType: 'ITEM', colorGroup: 'COMMON', unit: 'Ltr' },
      { itemName: 'Frame---Red', size: '20 inch', narration: '', qtyPerUnit: 1, sourceType: 'ITEM', colorGroup: 'Red', unit: '' },
      { itemName: 'Frame---Blue', size: '20 inch', narration: '', qtyPerUnit: 1, sourceType: 'ITEM', colorGroup: 'Blue', unit: '' }
    ]
  },
  'PRC-ASM': {
    colors: ['Red-White', 'Blue-White', 'Black', 'Grey'],
    axes: {
      axes: [
        { key: 'pool:painted frame', label: 'Painted Frame', colors: ['Red-White', 'Blue-White'], source: 'pool' },
        { key: 'tag:seat', label: 'Seat', colors: ['Black', 'Grey'], source: 'tag' }
      ],
      primaryAxisKey: 'pool:painted frame', primaryIsDefault: true
    },
    recipe: [
      { itemName: 'Painted Frame', size: '20 inch', narration: '', qtyPerUnit: 1, sourceType: 'POOL', colorGroup: 'COMMON', unit: '' },
      { itemName: 'Bell', size: 'GENERAL', narration: '', qtyPerUnit: 1, sourceType: 'ITEM', colorGroup: 'COMMON', unit: '' }
    ]
  },
  'PRC-CUT': {
    colors: [],
    axes: { axes: [] },
    recipe: [{ itemName: 'MS Tube', size: '1 inch', narration: '', qtyPerUnit: 1.5, sourceType: 'ITEM', colorGroup: 'COMMON', unit: 'Mtr' }]
  }
};

const POOL = [
  { outputItemName: 'Painted Frame', color: 'Red-White', availableQty: 30, productTag: '' },
  { outputItemName: 'Painted Frame', color: 'Blue-White', availableQty: 2, productTag: '' }
];
const STOCK = [{ name: 'Primer', size: '5 L', currentStock: 3 }, { name: 'Bell', size: 'GENERAL', currentStock: 500 }];

const LOTS = [
  { rowIdx: 31, lotNumber: 'LOT-PNT-0031', processId: 'PRC-PNT', date: '15/09/2026', dateRaw: '2026-09-15', qty: 30,
    assignedTo: 'rakesh', assignedBy: 'Gurmeet', status: 'Pending', remarks: 'rush', productId: '', productName: '',
    outputItemName: 'Painted Frame Kalpi 20 inch REWORK', contractorPayable: 600, extraChargeType: '', extraChargeAmount: 0,
    colorBreakdown: [{ color: 'Red', qty: 20, isCustom: false, countsTowardTotal: true, axisKey: '' }, { color: 'Blue', qty: 10, isCustom: false, countsTowardTotal: true, axisKey: '' }],
    componentsConsumed: [
      { itemName: 'Primer', size: '5 L', narration: '', color: '', sourceType: 'ITEM', qty: 4, colorGroup: 'COMMON', poolColor: '', unit: 'Ltr' },
      { itemName: 'Frame---Red', size: '20 inch', narration: '', color: '', sourceType: 'ITEM', qty: 20, colorGroup: 'Red', poolColor: '' },
      { itemName: 'Frame---Blue', size: '20 inch', narration: '', color: '', sourceType: 'ITEM', qty: 10, colorGroup: 'Blue', poolColor: '' }
    ] },
  { rowIdx: 30, lotNumber: 'LOT-CUT-0009', processId: 'PRC-CUT', date: '14/09/2026', dateRaw: '2026-09-14', qty: 12,
    assignedTo: 'sanjay', status: 'Completed', productId: 'PRD-4', colorBreakdown: [], componentsConsumed: [] }
];

let mutate;
let picks;

function mount() {
  jest.resetModules();
  global.fetch = jest.fn();
  document.body.innerHTML = `
    <div id="mapp-sheet-backdrop"></div>
    <div id="production-list"></div>
    <input id="production-search">
    <div class="mb-toast-stack" id="mapp-toast-stack"></div>
    <div class="mb-sheet" id="sheet-log-lot"><div class="mb-sheet-header"><h2>Log Lot</h2></div>
      <div class="mb-sheet-body" id="log-lot-body"></div>
      <div class="mb-sheet-footer"><button type="button" id="log-lot-save-btn">Log Lot</button></div>
    </div>`;
  global.OfflineCache = {
    put() {}, get: async () => null,
    outbox: { countPendingForMethod: async () => 0, enqueue: jest.fn(async () => {}) }
  };
  loadAsGlobal('api.js', 'Api', ';global.dateToInputValue = dateToInputValue;');
  loadAsGlobal('mobile.js', 'MApp');
  MApp.Sheet._stack = [];
  const api = jest.fn(async (method, ...args) => {
    const def = DATA[args[0]] || {};
    const data = {
      getProductionData: LOTS,
      getProcessData: PROCESSES,
      getModels: [{ name: 'Kalpi' }],
      getProcessTypes: [{ name: 'Painting' }, { name: 'Assembly' }, { name: 'Cutting' }],
      getContractorsData: [{ contractorName: 'rakesh' }, { contractorName: 'sanjay' }],
      getColors: ['Red', 'Blue', 'White', 'Black', 'Grey'].map(name => ({ name })),
      getItemsData: [{ name: 'Primer', size: '5 L', baseUnit: 'Ltr', narration: '' }, { name: 'Bell', size: 'GENERAL', baseUnit: 'Pcs', narration: '' }],
      getProcessColorGroups: def.colors,
      getProcessColorAxes: def.axes,
      getProcessComponentsData: def.recipe,
      getWarehousePoolData: POOL,
      getStockData: STOCK,
      getContractorRateForProcessType: { ratePerUnit: 20 },
      getContractorServiceChargesForContractor: [{ serviceType: 'Rush', chargeAmount: 2 }]
    }[method];
    return { success: true, data: data === undefined ? [] : data };
  });
  MApp.Api.call = api;
  MApp.Api.callCached = api;
  mutate = jest.fn(async () => ({ success: true, message: 'Lot #LOT-PNT-0032 saved.', data: { lotNumber: 'LOT-PNT-0032' } }));
  Api.mutateWithId = mutate;
  // The picker answers with whatever the test queued, by label.
  picks = [];
  MApp.Picker.open = jest.fn(async ({ items }) => {
    const want = picks.shift();
    if (want === undefined) return null;
    const item = items.find(i => i.label === want || i.value === want);
    if (!item) throw new Error(`picker has no "${want}" among ${items.map(i => i.label).join(', ')}`);
    return item;
  });
}

const flush = () => new Promise(r => setTimeout(r, 0));
const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];
const rowFor = color => $$('.mapp-lot-color').find(el => el.querySelector('.mapp-lot-color-name').textContent === color);
async function tap(el) { el.click(); await flush(); await flush(); }
function type(input, value) {
  input.value = String(value);
  input.dispatchEvent(new Event('input'));
}
async function openWithProcess(name) {
  await MApp.Production.load();
  await MApp.Production.openLogLotSheet();
  picks.push(name);
  await tap($('#lot-process-field'));
}

beforeEach(mount);

describe('finding the process', () => {
  test('one search across every active process, without the cascade', async () => {
    await MApp.Production.load();
    await MApp.Production.openLogLotSheet();
    expect($('#lot-process-field').disabled).toBe(false);
    picks.push('Assembly Kalpi 20');
    await tap($('#lot-process-field'));

    const offered = MApp.Picker.open.mock.calls[0][0].items.map(i => i.label);
    expect(offered).toEqual(expect.arrayContaining(['Frame Painting 20', 'Assembly Kalpi 20', 'Tube Cutting']));
    expect(offered).not.toContain('Old Line');
    // The process that was picked, and its size/model/type under the field
    // -- but the cascade itself is untouched, because it is the operator's
    // filter and picking a process is not the operator narrowing anything.
    expect(MApp.Production.selection.process.processId).toBe('PRC-ASM');
    expect($('#lot-process-hint').textContent).toBe('20 inch · Kalpi · Assembly · Stage 4');
    expect(MApp.Production.selection).toMatchObject({ size: '', model: '', type: '' });
  });

  // The regression this cascade-as-readout caused: the form stays open on
  // the same process after a lot is logged, so the process picker came back
  // narrowed to that process's own size AND model AND type -- in practice
  // the one process just used, with every other process gone from a list
  // whose field still said "Search all processes…".
  test('the process picker still offers every process after a lot is logged', async () => {
    await openWithProcess('Frame Painting 20');
    await tap(rowFor('Red').querySelector('[data-row-toggle]'));
    type(rowFor('Red').querySelector('.mapp-lot-color-qty'), 20);
    picks.push('Rakesh');
    await tap($('#lot-assignedto-field'));
    await MApp.Production.saveLot();
    await flush(); await flush();

    expect($('#lot-process-field').textContent).toBe('Frame Painting 20');
    MApp.Picker.open.mockClear();
    await tap($('#lot-process-field'));
    const offered = MApp.Picker.open.mock.calls[0][0].items.map(i => i.label);
    expect(offered).toEqual(expect.arrayContaining(['Frame Painting 20', 'Assembly Kalpi 20', 'Tube Cutting']));
  });

  test('the processes logged most recently come first', async () => {
    await MApp.Production.load();
    await MApp.Production.openLogLotSheet();
    await tap($('#lot-process-field'));
    const items = MApp.Picker.open.mock.calls[0][0].items;
    expect(items.slice(0, 2).map(i => i.label)).toEqual(['Frame Painting 20', 'Tube Cutting']);
    expect(items[0].sublabel).toMatch(/^Recent · 20 inch · Kalpi · Painting · Stage 2$/);
  });

  test('narrowing by size leaves only that size, and drops a process that no longer fits', async () => {
    await openWithProcess('Frame Painting 20');
    picks.push('26 inch');
    await tap($('#lot-size-field'));
    expect(MApp.Production.selection.process).toBeNull();
    await tap($('#lot-process-field'));
    expect(MApp.Picker.open.mock.calls.pop()[0].items.map(i => i.label)).toEqual(['Tube Cutting']);
  });
});

describe('quantities', () => {
  test('a colour is ticked, then its quantity typed -- not stepped one tap at a time', async () => {
    await openWithProcess('Frame Painting 20');
    await tap(rowFor('Red').querySelector('[data-row-toggle]'));
    const input = rowFor('Red').querySelector('.mapp-lot-color-qty');
    expect(input.getAttribute('inputmode')).toBe('decimal');
    expect(document.activeElement).toBe(input);
    type(input, 240);
    expect($('#lot-total-qty').textContent).toBe('240');
    expect(document.activeElement === input || input.value === '240').toBe(true);
    expect(CSS).toMatch(/\.mapp-lot-color-qty\s*\{/);
  });

  test('a process with two groups and no Primary asks which one counts before anything else', async () => {
    await openWithProcess('Assembly Kalpi 20');
    const opts = $$('[data-primary-key]');
    expect(opts.map(o => o.textContent.trim())).toEqual(['Painted Frame', 'Seat']);
    expect(opts.every(o => o.getAttribute('aria-checked') === 'false')).toBe(true);
    MApp.Production.selectedAssignedTo = 'rakesh';
    await tap(rowFor('Red-White').querySelector('[data-row-toggle]'));
    type(rowFor('Red-White').querySelector('.mapp-lot-color-qty'), 5);
    await MApp.Production.saveLot();
    expect(mutate).not.toHaveBeenCalled();

    await tap($('[data-primary-key="pool:painted frame"]'));
    expect($('.mapp-lot-group-title').textContent).toContain('Color Group (Primary)');
  });

  test('a secondary colour follows the lot until someone types into it', async () => {
    await openWithProcess('Assembly Kalpi 20');
    await tap($('[data-primary-key="pool:painted frame"]'));
    await tap(rowFor('Red-White').querySelector('[data-row-toggle]'));
    type(rowFor('Red-White').querySelector('.mapp-lot-color-qty'), 12);
    await tap(rowFor('Grey').querySelector('[data-row-toggle]'));
    expect(rowFor('Grey').querySelector('.mapp-lot-color-qty').value).toBe('12');
    expect(rowFor('Grey').textContent).toContain('Follows the lot');
    type(rowFor('Red-White').querySelector('.mapp-lot-color-qty'), 15);
    expect(rowFor('Grey').querySelector('.mapp-lot-color-qty').value).toBe('15');
  });

  test('each colour says how much of it the pool holds, and flags what is short', async () => {
    await openWithProcess('Assembly Kalpi 20');
    expect(rowFor('Red-White').querySelector('.mapp-lot-color-avail').textContent).toBe('30 avail.');
  });
});

describe('what the lot consumes', () => {
  test('is on screen, scaled to the lot, and a corrected line keeps its number', async () => {
    await openWithProcess('Frame Painting 20');
    await tap(rowFor('Red').querySelector('[data-row-toggle]'));
    type(rowFor('Red').querySelector('.mapp-lot-color-qty'), 20);
    const primer = () => $$('.mapp-mat').find(el => el.textContent.includes('Primer'));
    expect(primer().querySelector('input').value).toBe('2.5');
    // More than the 3 in stock would be flagged; 2.5 is not.
    expect(primer().classList.contains('is-short')).toBe(false);

    const input = primer().querySelector('input');
    input.value = '3.5';
    input.dispatchEvent(new Event('change'));
    expect(primer().classList.contains('is-edited')).toBe(true);
    expect(primer().classList.contains('is-short')).toBe(true);
    expect($('.mapp-lot-mats').open).toBe(true);

    type(rowFor('Red').querySelector('.mapp-lot-color-qty'), 40);
    expect(primer().querySelector('input').value).toBe('3.5');

    await tap(primer().querySelector('[data-mat-reset]'));
    expect(primer().querySelector('input').value).toBe('5');
  });

  test('a line can be added by hand, for the whole lot or one colour', async () => {
    await openWithProcess('Frame Painting 20');
    await tap(rowFor('Red').querySelector('[data-row-toggle]'));
    type(rowFor('Red').querySelector('.mapp-lot-color-qty'), 8);
    picks.push('Bell [GENERAL]', 'Red');
    await tap($('[data-mat-add]'));
    const bell = $$('.mapp-mat').find(el => el.textContent.includes('Bell'));
    expect(bell.textContent).toContain('Added by hand');
    expect(bell.querySelector('input').value).toBe('8');
    expect(MApp.Production.model.payloadLines().find(l => l.itemName === 'Bell')).toMatchObject({ colorGroup: 'Red', qty: 8, sourceType: 'ITEM' });
  });
});

describe('saving', () => {
  async function logRed(qty) {
    await openWithProcess('Frame Painting 20');
    await tap(rowFor('Red').querySelector('[data-row-toggle]'));
    type(rowFor('Red').querySelector('.mapp-lot-color-qty'), qty);
    picks.push('Rakesh');
    await tap($('#lot-assignedto-field'));
    $('#lot-assignedby').value = 'Gurmeet';
  }

  test('sends the model\'s breakdown and components, and the output item', async () => {
    await logRed(20);
    await MApp.Production.saveLot();
    await flush();
    const [method, , form] = mutate.mock.calls[0];
    expect(method).toBe('saveProduction');
    expect(JSON.parse(form.colorBreakdown)).toEqual([{ color: 'Red', qty: 20, isCustom: false, countsTowardTotal: true, axisKey: '' }]);
    expect(JSON.parse(form.componentsConsumed).map(l => [l.itemName, l.qty])).toEqual([['Primer', 2.5], ['Frame---Red', 20]]);
    expect(form).toMatchObject({ processId: 'PRC-PNT', assignedTo: 'rakesh', assignedBy: 'Gurmeet', outputItemName: 'Painted Frame Kalpi 20 inch', status: 'Pending' });
    expect(form.qty).toBeUndefined();
  });

  test('keeps the sheet on the same process for the next lot', async () => {
    await logRed(20);
    await MApp.Production.saveLot();
    await flush(); await flush();
    expect($('#lot-process-field').textContent).toBe('Frame Painting 20');
    expect($('#lot-assignedby').value).toBe('Gurmeet');
    expect(rowFor('Red').classList.contains('is-checked')).toBe(false);
    expect(MApp.Production.selectedAssignedTo).toBe('');
    expect($('#mapp-toast-stack').textContent).toContain('LOT-PNT-0032');
  });

  test('shows what this lot will pay once contractor and quantity are known', async () => {
    await logRed(20);
    await flush();
    expect($('#lot-rate-hint').textContent).toContain('Payable ₹400.00');
  });

  test('a single-quantity process sends a plain quantity', async () => {
    await openWithProcess('Tube Cutting');
    type($('#lot-qty'), 40);
    MApp.Production.selectedAssignedTo = 'sanjay';
    await MApp.Production.saveLot();
    const form = mutate.mock.calls[0][2];
    expect(form.qty).toBe(40);
    expect(JSON.parse(form.componentsConsumed)).toEqual([expect.objectContaining({ itemName: 'MS Tube', qty: 60, unit: 'Mtr' })]);
  });
});

// The sheet is meant to survive being used over and over -- a supervisor
// logs a run of lots through it, and reopens it all day. Each of these is
// a way it used to come back filled with the last lot's state, dead to the
// touch, or both.
describe('reusing the sheet', () => {
  // Holds one method's answer open so a load can be left in flight.
  function deferMethod(method) {
    const original = MApp.Api.call;
    let release;
    const gate = new Promise(r => { release = r; });
    MApp.Api.call = jest.fn(async (m, ...args) => {
      if (m === method) await gate;
      return original(m, ...args);
    });
    return () => { MApp.Api.call = original; release(); };
  }

  async function enterRedLot(qty) {
    await openWithProcess('Frame Painting 20');
    await tap(rowFor('Red').querySelector('[data-row-toggle]'));
    type(rowFor('Red').querySelector('.mapp-lot-color-qty'), qty);
    picks.push('Rakesh');
    await tap($('#lot-assignedto-field'));
  }

  function goOffline() {
    const fail = jest.fn(async () => {
      const err = new Error('Network request failed.');
      err.isNetworkError = true;
      throw err;
    });
    Api.mutateWithId = fail;
    MApp.Api.call = fail;
    MApp.Api.callCached = fail;
  }

  test('a process load left in flight cannot paint the form that replaced it', async () => {
    await MApp.Production.load();
    await MApp.Production.openLogLotSheet();

    const release = deferMethod('getProcessColorGroups');
    picks.push('Frame Painting 20');
    $('#lot-process-field').click();   // deliberately not awaited
    await flush();
    expect(MApp.Production.selection.processId).toBe('PRC-PNT');

    // Close and reopen before that process's colour groups land.
    MApp.Production.closeLogLotSheet();
    await MApp.Production.openLogLotSheet();
    expect(MApp.Production.selection.process).toBeNull();

    release();
    await flush(); await flush(); await flush();

    // The abandoned load wrote nothing back into the new form...
    expect(MApp.Production.selection.process).toBeNull();
    expect(MApp.Production.model).toBeNull();
    expect($('#lot-qty-section').innerHTML).toBe('');
    expect($('#lot-process-field').textContent).toBe('Search all processes…');
    // ...and it is still a form you can use.
    expect($('#lot-process-field').disabled).toBe(false);
    expect($('#log-lot-save-btn').disabled).toBe(false);
  });

  test('a lot queued to the outbox still leaves a form the next lot can be typed into', async () => {
    await enterRedLot(20);
    goOffline();

    await MApp.Production.saveLot();
    await flush(); await flush();

    expect(OfflineCache.outbox.enqueue).toHaveBeenCalled();
    expect($('#mapp-toast-stack').textContent).toContain('will sync when back online');
    // The reset cannot reach the five reads onProcessSelected makes, so it
    // rebuilds from the reference data this process already had: the
    // process, its colours and its recipe are all still on screen.
    expect($('#lot-process-field').textContent).toBe('Frame Painting 20');
    expect(MApp.Production.selection.process).not.toBeNull();
    expect(MApp.Production.model).not.toBeNull();
    expect(rowFor('Red')).toBeTruthy();
    expect($('#lot-materials-section').textContent).toContain('Primer');
    // Cleared for the next lot, not carried over from the one just queued.
    expect(rowFor('Red').classList.contains('is-checked')).toBe(false);
    expect(MApp.Production.selectedAssignedTo).toBe('');
    expect($('#log-lot-save-btn').disabled).toBe(false);
    expect($('#lot-process-field').disabled).toBe(false);
  });

  test('the next lot queued offline sends its own numbers, not the previous lot\'s', async () => {
    await enterRedLot(20);
    goOffline();
    await MApp.Production.saveLot();
    await flush(); await flush();

    await tap(rowFor('Blue').querySelector('[data-row-toggle]'));
    type(rowFor('Blue').querySelector('.mapp-lot-color-qty'), 7);
    MApp.Production.selectedAssignedTo = 'sanjay';
    await MApp.Production.saveLot();
    await flush(); await flush();

    expect(OfflineCache.outbox.enqueue).toHaveBeenCalledTimes(2);
    const second = OfflineCache.outbox.enqueue.mock.calls[1][2][0];
    expect(JSON.parse(second.colorBreakdown)).toEqual([
      { color: 'Blue', qty: 7, isCustom: false, countsTowardTotal: true, axisKey: '' }
    ]);
    expect(second.assignedTo).toBe('sanjay');
  });

  test('a form that fails to rebuild is not reported as a failed save', async () => {
    await enterRedLot(20);
    jest.spyOn(MApp.Production, 'resetLogLotForm')
      .mockRejectedValue(new Error('rebuild exploded'));

    await MApp.Production.saveLot();
    await flush(); await flush();

    const toasts = $('#mapp-toast-stack').textContent;
    expect(mutate).toHaveBeenCalled();
    // The lot IS saved, and is reported that way. What failed is named for
    // what it was -- a reset -- rather than surfacing as a bare save error
    // that invites the supervisor to log the same lot a second time.
    expect(toasts).toContain('LOT-PNT-0032');
    expect(toasts).toContain('Lot saved, but the form could not be reset');
    expect(toasts).not.toContain('Could not save this lot');
    expect($('#sheet-log-lot').classList.contains('open')).toBe(false);
    expect($('#log-lot-save-btn').disabled).toBe(false);
  });
});

describe('editing', () => {
  test('opens as it was saved and, unchanged, sends back exactly that', async () => {
    await MApp.Production.load();
    await MApp.Production.openEditSheet(LOTS[0]);
    expect($('#log-lot-body').textContent).toContain('LOT-PNT-0031');
    expect(rowFor('Red').querySelector('.mapp-lot-color-qty').value).toBe('20');
    expect($('#lot-output').value).toBe('Painted Frame Kalpi 20 inch REWORK');
    await MApp.Production.saveLot();
    const form = mutate.mock.calls[0][2];
    expect(form.rowIdx).toBe(31);
    expect(form.outputItemName).toBe('Painted Frame Kalpi 20 inch REWORK');
    // Primer was recorded at 4 where the recipe says 3.75: kept.
    expect(JSON.parse(form.componentsConsumed).map(l => [l.itemName, l.qty])).toEqual([['Primer', 4], ['Frame---Red', 20], ['Frame---Blue', 10]]);
  });

  test('a changed quantity moves the recipe lines, not the hand-entered one', async () => {
    await MApp.Production.load();
    await MApp.Production.openEditSheet(LOTS[0]);
    type(rowFor('Red').querySelector('.mapp-lot-color-qty'), 25);
    await MApp.Production.saveLot();
    expect(JSON.parse(mutate.mock.calls[0][2].componentsConsumed).map(l => [l.itemName, l.qty]))
      .toEqual([['Primer', 4], ['Frame---Red', 25], ['Frame---Blue', 10]]);
  });
});

describe('the list', () => {
  test('a card shows the colours that make up the lot and what it pays', async () => {
    await MApp.Production.load();
    const card = $$('#production-list .mb-card')[0];
    expect(card.querySelector('.mapp-lot-colors-text').textContent).toBe('Red 20 · Blue 10');
    expect(card.textContent).toContain('Output: Painted Frame Kalpi 20 inch REWORK');
    expect(card.textContent).toContain('Payable ₹600.00');
  });

  test('every class a card renders is one the stylesheet defines', async () => {
    await MApp.Production.load();
    const used = new Set();
    document.querySelectorAll('#production-list *').forEach(el => el.classList.forEach(c => used.add(c)));
    expect([...used].filter(c => !CSS.includes(`.${c}`))).toEqual([]);
  });

  test('a lot can be found by its colour', async () => {
    await MApp.Production.load();
    MApp.Production.onSearch('blue');
    expect($$('#production-list .mb-card').map(c => c.querySelector('.mb-card-title').textContent)).toEqual(['LOT-PNT-0031']);
  });

  test('deleting sends desktop\'s guard and shows the server\'s own message', async () => {
    await MApp.Production.load();
    window.confirm = () => true;
    mutate.mockResolvedValueOnce({ success: true, message: 'Lot #LOT-CUT-0009 deleted. Its pool credit was already drawn on.' });
    await MApp.Production.deleteLot(LOTS[1]);
    expect(mutate.mock.calls[0][0]).toBe('deleteProduction');
    expect(mutate.mock.calls[0].slice(2)).toEqual([30, 'PRD-4', 12]);
    expect($('#mapp-toast-stack').textContent).toContain('pool credit was already drawn on');
  });

  test('a bulk delete sends what each selected lot looked like', () => {
    const [ids, expected] = MApp.Production.SELECT.payload(LOTS);
    expect(ids).toEqual([31, 30]);
    expect(expected).toEqual([
      { rowIdx: 31, expectedProductId: '', expectedQty: 30 },
      { rowIdx: 30, expectedProductId: 'PRD-4', expectedQty: 12 }
    ]);
  });
});

describe('the form\'s own styles', () => {
  test('every class the form renders is one the stylesheet defines', async () => {
    await openWithProcess('Assembly Kalpi 20');
    await tap($('[data-primary-key="pool:painted frame"]'));
    await tap(rowFor('Red-White').querySelector('[data-row-toggle]'));
    type(rowFor('Red-White').querySelector('.mapp-lot-color-qty'), 12);
    await tap(rowFor('Black').querySelector('[data-row-toggle]'));
    await tap(rowFor('Grey').querySelector('[data-row-toggle]'));
    type(rowFor('Black').querySelector('.mapp-lot-color-qty'), 7);
    const used = new Set();
    document.querySelectorAll('#log-lot-body *').forEach(el => el.classList.forEach(c => used.add(c)));
    expect($('.mapp-lot-alloc-table')).not.toBeNull();
    expect([...used].filter(c => !CSS.includes(`.${c}`))).toEqual([]);
  });
});
