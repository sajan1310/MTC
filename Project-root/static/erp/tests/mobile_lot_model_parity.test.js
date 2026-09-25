/**
 * A lot logged on the phone records what the same lot logged at a desk
 * records.
 *
 * Desktop's Production Lot form decides, from the process's colour groups,
 * axes, recipe and Warehouse Pool, which colours count toward the lot,
 * which follow it, and exactly which components it consumes. The phone
 * used to decide all of that with a much smaller model of its own, so the
 * same lot saved different consumption depending on which screen logged
 * it -- a pool item drained from arbitrary buckets, a packing sub-group
 * added into the lot total, a common part consumed twice beside its
 * per-colour sibling.
 *
 * So this runs desktop's own production.js -- read-only; desktop is the
 * reference -- and drives its form the way an operator does (pick the
 * process, tick colours, type quantities), drives MApp.LotModel through
 * the same steps, and requires the two to send saveProduction the same
 * colour breakdown and the same components.
 *
 * Units included: desktop's per-colour and pool lines used to leave without
 * the recipe row's unit (read by the server as "already in the base unit",
 * so a Dozen part was debited twelve times short) while the phone kept it.
 * Desktop carries it now, and every line's unit is compared.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const PRODUCTION_PARTIAL = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', 'production.html'), 'utf8');

Object.defineProperty(HTMLElement.prototype, 'innerText', {
  configurable: true,
  get() { return this.textContent; },
  set(v) { this.textContent = v; }
});

const COLORS = ['Red', 'Blue', 'Black', 'White', 'Green', 'Pink', 'Sea Green', 'BCP'].map(name => ({ name }));

const ITEMS = [
  { name: 'Primer', size: '5 L', narration: 'Grey base', baseUnit: 'Ltr' },
  { name: 'Chain Cover', size: 'GENERAL', narration: 'Plastic', baseUnit: 'Pcs' },
  { name: 'Chain Cover Red', size: 'GENERAL', narration: '', baseUnit: 'Pcs' },
  { name: 'Frame---Red', size: '20 inch', narration: 'MS tube', baseUnit: 'Pcs' },
  { name: 'Frame---Blue', size: '20 inch', narration: 'MS tube', baseUnit: 'Pcs' },
  { name: 'Paint(Gloss) Red', size: 'GENERAL', narration: '', baseUnit: 'Kg' },
  { name: 'Paint(Gloss) Blue', size: 'GENERAL', narration: '', baseUnit: 'Kg' },
  { name: 'Sticker Set Red-Blue', size: 'GENERAL', narration: '', baseUnit: 'Pcs' },
  { name: 'Poly Bag', size: 'GENERAL', narration: '', baseUnit: 'Pcs' },
  { name: 'Small Poly', size: 'GENERAL', narration: '', baseUnit: 'Pcs' },
  { name: 'Carton', size: 'GENERAL', narration: '5 ply', baseUnit: 'Pcs' },
  { name: 'Mudguard Red', size: '20 inch', narration: '', baseUnit: 'Pcs' },
  { name: 'Mudguard Blue', size: '20 inch', narration: '', baseUnit: 'Pcs' },
  { name: 'Mudguard Black', size: '20 inch', narration: '', baseUnit: 'Pcs' },
  { name: 'Bell', size: 'GENERAL', narration: 'Chrome', baseUnit: 'Pcs' },
  { name: 'Rim BCP', size: '26 inch', narration: '', baseUnit: 'Pcs' },
  { name: 'Rim Black', size: '26 inch', narration: '', baseUnit: 'Pcs' },
  { name: 'Spoke Set', size: '26 inch', narration: '', baseUnit: 'Set' },
  { name: 'Paint Red', size: 'GENERAL', narration: '', baseUnit: 'Kg' },
  { name: 'Paint Blue', size: 'GENERAL', narration: '', baseUnit: 'Kg' },
  { name: 'Thinner', size: 'GENERAL', narration: '', baseUnit: 'Ltr' },
  { name: 'MS Tube', size: '1 inch', narration: '', baseUnit: 'Mtr' },
  { name: 'Weld Rod', size: 'GENERAL', narration: '', baseUnit: 'Kg' }
];

const comp = (itemName, colorGroup, qtyPerUnit, extra = {}) => ({
  itemName, colorGroup, qtyPerUnit, size: 'GENERAL', narration: '', sourceType: 'ITEM', unit: '', colorAxis: '', ...extra
});
const pool = (outputItemName, color, availableQty = 50, extra = {}) => ({ outputItemName, color, availableQty, productTag: '', ...extra });

// Each process is one shape the grouping has to get right.
const PROCESSES = {
  // Flat colours: no axis, no pool cluster. Every checked colour counts.
  'PRC-PNT': {
    process: { processId: 'PRC-PNT', processName: 'Frame Painting', processType: 'Painting', outputItemName: 'Painted Frame 20 inch', sequence: 2, active: true, isFinalStage: false },
    colors: ['Red', 'Blue'],
    axes: { axes: [], primaryAxisKey: '', primaryIsDefault: false },
    recipe: [
      // Spelled differently from Items Master -- desktop names it as the master does.
      comp('primer', 'COMMON', 0.125, { size: '5 L', unit: 'Ltr' }),
      comp('Chain Cover', 'COMMON', 1),
      comp('Chain Cover Red', 'Red', 1),
      comp('Frame---Red', 'Red', 1, { size: '20 inch' }),
      comp('Frame---Blue', 'Blue', 1, { size: '20 inch' }),
      comp('Paint(Gloss) Red', 'Red', 0.1, { unit: 'Kg' }),
      comp('Paint(Gloss) Blue', 'Blue', 0.075, { unit: 'Kg' }),
      comp('Sticker Set Red-Blue', 'Red', 1),
      comp('Sticker Set Red-Blue', 'Blue', 1),
      comp('Poly Bag', 'COMMON', 1),
      // A pool item that only ever exists in one colour: a fixed input.
      comp('Painted Mudguard', 'COMMON', 2, { sourceType: 'POOL', size: '20 inch', narration: 'Rib pair' })
    ],
    pool: [pool('Painted Mudguard', 'Black', 80)]
  },

  // A multi-colour pool item drives the checklist; packing sub-groups ride
  // along without adding to the total.
  'PRC-PKG': {
    process: { processId: 'PRC-PKG', processName: 'Packing 20', processType: 'Packing', outputItemName: 'Packed Cycle 20 inch', sequence: 5, active: true, isFinalStage: false },
    colors: ['Red-White', 'Blue-White', 'KIT BAG 20"', 'SMALL KIT 20"'],
    axes: { axes: [{ key: 'pool:painted frame 20', label: 'Painted Frame 20', colors: ['Blue-White', 'Red-White'], source: 'pool' }], primaryAxisKey: 'pool:painted frame 20', primaryIsDefault: false },
    recipe: [
      comp('Painted Frame 20', 'COMMON', 1, { sourceType: 'POOL', size: '20 inch' }),
      comp('Carton', 'COMMON', 1),
      comp('Poly Bag', 'KIT BAG 20"', 1),
      comp('Small Poly', 'SMALL KIT 20"', 2),
      comp('Fitted Rim', 'COMMON', 2, { sourceType: 'POOL', size: '20 inch' })
    ],
    pool: [pool('Painted Frame 20', 'Red-White', 30), pool('Painted Frame 20', 'Blue-White', 4), pool('Fitted Rim', 'Black', 100),
      pool('Painted Frame 20', 'Red-White', 9, { productTag: 'PRD-1' })]
  },

  // Two axes with a stored Primary; mudguard colours follow the frame.
  'PRC-ASM': {
    process: { processId: 'PRC-ASM', processName: 'Assembly 20', processType: 'Assembly', outputItemName: 'Assembled Cycle 20 inch', sequence: 4, active: true, isFinalStage: false },
    colors: ['Red-White', 'Blue-White', 'Red', 'Blue', 'Black'],
    axes: {
      axes: [
        { key: 'pool:painted frame', label: 'Painted Frame', colors: ['Red-White', 'Blue-White'], source: 'pool' },
        { key: 'tag:mudguard color', label: 'Mudguard Color', colors: ['Red', 'Blue', 'Black'], source: 'tag' }
      ],
      primaryAxisKey: 'pool:painted frame', primaryIsDefault: false
    },
    recipe: [
      comp('Painted Frame', 'COMMON', 1, { sourceType: 'POOL', size: '20 inch' }),
      comp('Mudguard Red', 'Red', 2, { size: '20 inch', colorAxis: 'Mudguard Color' }),
      comp('Mudguard Blue', 'Blue', 2, { size: '20 inch', colorAxis: 'Mudguard Color' }),
      comp('Mudguard Black', 'Black', 2, { size: '20 inch', colorAxis: 'Mudguard Color' }),
      comp('Bell', 'COMMON', 1)
    ],
    pool: [pool('Painted Frame', 'Red-White', 20), pool('Painted Frame', 'Blue-White', 20)]
  },

  // Two axes and nobody has picked a Primary yet; the rims split unevenly.
  'PRC-RIM': {
    process: { processId: 'PRC-RIM', processName: 'Rim Fitting 26', processType: 'Fitting', outputItemName: 'Fitted Frame 26 inch', sequence: 3, active: true, isFinalStage: false },
    colors: ['Blue-White', 'Pink-White', 'BCP', 'Black'],
    axes: {
      axes: [
        { key: 'pool:painted frame 26', label: 'Painted Frame 26', colors: ['Blue-White', 'Pink-White'], source: 'pool' },
        { key: 'tag:rim color', label: 'Rim Color', colors: ['BCP', 'Black'], source: 'tag' }
      ],
      primaryAxisKey: 'pool:painted frame 26', primaryIsDefault: true
    },
    recipe: [
      comp('Painted Frame 26', 'COMMON', 1, { sourceType: 'POOL', size: '26 inch' }),
      comp('Rim BCP', 'BCP', 2, { size: '26 inch', colorAxis: 'Rim Color' }),
      comp('Rim Black', 'Black', 2, { size: '26 inch', colorAxis: 'Rim Color' }),
      comp('Spoke Set', 'COMMON', 1, { size: '26 inch', unit: 'Set' })
    ],
    pool: [pool('Painted Frame 26', 'Blue-White', 30), pool('Painted Frame 26', 'Pink-White', 12)]
  },

  // One axis (the rib it consumes) plus the colours it paints -- neither
  // can be assumed primary, so the operator picks.
  'PRC-PF': {
    process: { processId: 'PRC-PF', processName: 'Frame Paint', processType: 'Painting', outputItemName: 'Painted Frame Kalpi 20 inch', sequence: 1, active: true, isFinalStage: false },
    colors: ['Black', 'Red', 'Blue', 'KIT BAG 20"'],
    axes: { axes: [{ key: 'pool:mudguard rib', label: 'Mudguard Rib', colors: ['Black'], source: 'pool' }], primaryAxisKey: 'pool:mudguard rib', primaryIsDefault: false },
    recipe: [
      comp('Mudguard Rib', 'COMMON', 1, { sourceType: 'POOL', size: '20 inch' }),
      comp('Paint Red', 'Red', 0.1, { unit: 'Kg' }),
      comp('Paint Blue', 'Blue', 0.1, { unit: 'Kg' }),
      comp('Thinner', 'COMMON', 0.05, { unit: 'Ltr' }),
      comp('Poly Bag', 'KIT BAG 20"', 1)
    ],
    pool: [pool('Mudguard Rib', 'Black', 25)]
  },

  // The frame colour is a composite that already names the rim, so what
  // the recipe tags to the rim is recorded under the frame, once.
  'PRC-CMP': {
    process: { processId: 'PRC-CMP', processName: 'Rim Fitting BCP', processType: 'Fitting', outputItemName: 'Fitted Frame 26 inch', sequence: 3, active: true, isFinalStage: false },
    colors: ['Blue-White / BCP', 'Pink-White / BCP', 'BCP', 'Black'],
    axes: {
      axes: [
        { key: 'pool:painted frame 26', label: 'Painted Frame 26', colors: ['Blue-White / BCP', 'Pink-White / BCP'], source: 'pool' },
        { key: 'tag:rim color', label: 'Rim Color', colors: ['BCP', 'Black'], source: 'tag' }
      ],
      primaryAxisKey: 'pool:painted frame 26', primaryIsDefault: false
    },
    recipe: [
      comp('Painted Frame 26', 'COMMON', 1, { sourceType: 'POOL', size: '26 inch' }),
      comp('Rim BCP', 'BCP', 2, { size: '26 inch', colorAxis: 'Rim Color' }),
      comp('Rim Black', 'Black', 2, { size: '26 inch', colorAxis: 'Rim Color' })
    ],
    pool: [pool('Painted Frame 26', 'Blue-White / BCP', 30), pool('Painted Frame 26', 'Pink-White / BCP', 12)]
  },

  // One frame axis and a packing sub-group, with a common part that has a
  // per-colour sibling.
  'PRC-KIT': {
    process: { processId: 'PRC-KIT', processName: 'Packing Kit 20', processType: 'Packing', outputItemName: 'Packed Kit 20 inch', sequence: 6, active: true, isFinalStage: false },
    colors: ['Red', 'Blue', 'KIT BAG 20"'],
    axes: { axes: [{ key: 'tag:frame color', label: 'Frame Color', colors: ['Red', 'Blue'], source: 'tag' }], primaryAxisKey: 'tag:frame color', primaryIsDefault: false },
    recipe: [
      comp('Chain Cover', 'COMMON', 1),
      comp('Chain Cover Red', 'Red', 1),
      comp('Poly Bag', 'KIT BAG 20"', 1)
    ],
    pool: []
  },

  // No colours at all: one quantity.
  'PRC-CUT': {
    process: { processId: 'PRC-CUT', processName: 'Tube Cutting', processType: 'Cutting', outputItemName: 'Cut Tube Set 20 inch', sequence: 1, active: true, isFinalStage: false },
    colors: [],
    axes: { axes: [], primaryAxisKey: '', primaryIsDefault: false },
    recipe: [
      comp('MS Tube', 'COMMON', 1.5, { size: '1 inch', unit: 'Mtr' }),
      comp('Weld Rod', 'COMMON', 0.2, { unit: 'Kg' }),
      comp('Paint Red', 'Red', 0.1)
    ],
    pool: []
  },

  // A rim colour more than one frame colour names: White goes on the
  // Blue-White frames AND the Red-White ones.
  'PRC-WHT': {
    process: { processId: 'PRC-WHT', processName: 'Rim Fitting 20', processType: 'Fitting', outputItemName: 'Fitted Frame 20 inch', sequence: 3, active: true, isFinalStage: false },
    colors: ['Blue-White', 'Red-White', 'Red-Black', 'White', 'Black'],
    axes: {
      axes: [
        { key: 'pool:painted frame 20w', label: 'Painted Frame 20W', colors: ['Blue-White', 'Red-Black', 'Red-White'], source: 'pool' },
        { key: 'tag:rim color', label: 'Rim Color', colors: ['Black', 'White'], source: 'tag' }
      ],
      primaryAxisKey: 'pool:painted frame 20w', primaryIsDefault: false
    },
    recipe: [
      comp('Painted Frame 20W', 'COMMON', 1, { sourceType: 'POOL', size: '20 inch' }),
      comp('Rim White', 'White', 2, { size: '20 inch', colorAxis: 'Rim Color' }),
      comp('Rim Black', 'Black', 2, { size: '20 inch', colorAxis: 'Rim Color' })
    ],
    pool: [
      pool('Painted Frame 20W', 'Blue-White', 30),
      pool('Painted Frame 20W', 'Red-White', 30),
      pool('Painted Frame 20W', 'Red-Black', 30)
    ]
  }
};

const ALL_POOL = Object.values(PROCESSES).flatMap(p => p.pool);

function loadShared() {
  eval([
    read('api.js').replace(/^const Api = /m, 'global.Api = '),
    'global.escapeHtml = escapeHtml;',
    'global.toNumber = toNumber;',
    'global.formatCurrency = formatCurrency;',
    'global.formatQty = formatQty;',
    'global.parseRecordDate = parseRecordDate;',
    'global.dateToInputValue = dateToInputValue;',
    'global.inDateRange = inDateRange;',
    'global.todayIso = todayIso;'
  ].join('\n'));
  eval(read('print-templates.js').replace(/^const PrintTemplates = /m, 'global.PrintTemplates = '));
  eval(read('mobile.js').replace(/^const MApp = /m, 'global.MApp = '));
}

function apiFor(def) {
  return jest.fn(async (method) => {
    const data = {
      getProcessColorGroups: def.colors,
      getProcessColorAxes: def.axes,
      getProcessComponentsData: def.recipe,
      getWarehousePoolData: ALL_POOL,
      getProcessWipData: [],
      getStockData: [],
      getContractorServiceChargesForContractor: []
    }[method];
    return { success: true, data: data === undefined ? [] : data };
  });
}

// ── desktop, driven like an operator ─────────────────────────────────
function loadDesktop() {
  global.$ = (sel, root = document) => root.querySelector(sel);
  global.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const sameText = (a, b) =>
    String(a == null ? '' : a).trim().toLowerCase() === String(b == null ? '' : b).trim().toLowerCase();
  global.App = {
    State: {
      globalModels: [], globalProcesses: Object.values(PROCESSES).map(p => p.process),
      globalColors: COLORS, globalItems: ITEMS, globalStock: [], globalProduction: []
    },
    Utils: {
      sameText,
      sameColor: sameText,
      isCommonColorGroup: g => String(g == null ? '' : g).trim().toUpperCase() === 'COMMON',
      formatNameCase: t => String(t == null ? '' : t),
      getSizeFromOutputItemName: () => 'General',
      getModelFromOutputItemName: () => 'General',
      showToast: jest.fn(),
      notPortedYet: jest.fn()
    },
    Color: { ensureLoaded: async () => {} }
  };
  eval(read('production.js'));
}

async function desktopOpen(processId, lot) {
  const def = PROCESSES[processId];
  document.body.innerHTML = PRODUCTION_PARTIAL;
  loadDesktop();
  Api.call = apiFor(def);
  const sel = document.getElementById('productionProcessId');
  sel.innerHTML = `<option value="${processId}">${def.process.processName}</option>`;
  sel.value = processId;
  if (lot) {
    App.State.globalProduction = [lot];
    App.Process = { ensureLoaded: async () => {} };
    App.Contractor = { ensureLoaded: async () => {} };
    App.ProcessType = { ensureLoaded: async () => {} };
    App.Model = { ensureLoaded: async () => {} };
    App.Nav = { register: jest.fn(), clear: jest.fn() };
    App.Utils.setFormButtonsForMode = jest.fn();
    App.Production.populateSizeSelect = () => {};
    App.Production.populateModelSelect = () => {};
    App.Production.populateProcessTypeSelect = () => {};
    App.Production.populateProcessSelect = () => {};
    App.Production.initContractorSelect2 = () => {};
    await App.Production.openEditModal(0);
    sel.innerHTML = `<option value="${processId}">${def.process.processName}</option>`;
    sel.value = processId;
  } else {
    await App.Production.handleProcessChange(processId);
  }
  const P = App.Production;
  const row = (color, group) => $$('#productionColorChecklist .production-color-row')
    .find(r => r.dataset.color === color && (group === undefined || r.dataset.group === group));
  return {
    async check(color, group) {
      const r = row(color, group);
      const chk = r.querySelector('.production-color-check');
      chk.checked = !chk.checked;
      await P.handleColorCheckToggle(chk);
    },
    type(color, qty, group) {
      const r = row(color, group);
      r.querySelector('.production-color-qty').value = String(qty);
      P.onColorQtyChanged(r);
    },
    async primary(key) {
      const radio = $$('#productionColorChecklist input[name="productionPrimaryAxisPick"]').find(x => x.value === key);
      radio.checked = true;
      await P.setPrimaryColorAxisChoice(radio);
    },
    async all(groupKey, on = true) {
      const master = $$('#productionColorChecklist [data-group-master]').find(x => x.dataset.groupMaster === groupKey);
      master.checked = on;
      await P.toggleColorGroup(master, groupKey);
    },
    allocate(primaryColor, columnColor, qty) {
      const input = $$('.production-allocation-cell').find(x => x.dataset.cellKey === `${primaryColor}||${columnColor}`);
      input.value = String(qty);
      P.onAllocationCellInput(input);
    },
    qty(value) {
      const q = document.getElementById('productionQty');
      q.value = String(value);
      P.refreshSuggestedComponentQty();
    },
    async manualColors() { await P.enableManualColors(); },
    groups() {
      return $$('#productionColorChecklist .production-color-row').map(r => ({
        color: r.dataset.color, group: r.dataset.group || '', primary: r.dataset.primary
      }));
    },
    result() {
      const isMulti = document.getElementById('productionColorWrapper').style.display !== 'none';
      return {
        colorBreakdown: isMulti ? P.getCheckedColorQtys() : null,
        componentsConsumed: isMulti
          ? [...P.serializeComponentsConsumed(), ...P.serializeColorMatrix(), ...P.serializePoolColorGroups()]
          : P.serializeComponentsConsumed()
      };
    }
  };
}

// ── the phone ─────────────────────────────────────────────────────────
function phoneOpen(processId, lot) {
  const def = PROCESSES[processId];
  const m = MApp.LotModel.using({
    process: def.process,
    outputItemName: (lot && lot.outputItemName) || def.process.outputItemName,
    colors: def.colors,
    axesData: def.axes,
    recipe: def.recipe,
    poolRows: ALL_POOL,
    items: ITEMS,
    colorMaster: COLORS,
    stock: []
  });
  if (lot) m.restore(lot);
  const row = (color, group) => m.rows.find(r => r.color === color && (group === undefined || r.group === group));
  return {
    model: m,
    async check(color, group) { const r = row(color, group); m.toggle(r, !r.checked); },
    type(color, qty, group) { m.setQty(row(color, group), String(qty)); },
    async primary(key) { m.setPrimary(key); },
    async all(groupKey, on = true) { m.toggleGroup(groupKey, on); },
    allocate(p, c, qty) { m.setAllocation(p, c, String(qty)); },
    qty(value) { m.plainQty = String(value); },
    async manualColors() {
      const next = MApp.LotModel.using({ ...m.ctx, manualColors: true });
      Object.assign(this, phoneWrap(next));
    },
    groups() {
      return m.rows.map(r => ({ color: r.color, group: r.group, primary: r.isPrimary === undefined ? undefined : String(r.isPrimary) }));
    },
    result() {
      return {
        colorBreakdown: m.mode === 'colors' ? m.checkedColorQtys() : null,
        componentsConsumed: m.payloadLines()
      };
    }
  };
}

function phoneWrap(m) {
  const row = (color, group) => m.rows.find(r => r.color === color && (group === undefined || r.group === group));
  return {
    model: m,
    async check(color, group) { const r = row(color, group); m.toggle(r, !r.checked); },
    type(color, qty, group) { m.setQty(row(color, group), String(qty)); },
    result() { return { colorBreakdown: m.checkedColorQtys(), componentsConsumed: m.payloadLines() }; }
  };
}

// Desktop's pool table leaves poolColor off where the phone sends it blank,
// and a line with no unit may carry it blank or not at all -- the server
// reads each pair the same (production_service._pool_bucket_color; a blank
// unit is the base unit).
const comparable = lines => lines.map(l => ({ ...l, poolColor: l.poolColor || '', unit: l.unit || '' }));

async function both(processId, steps, lot) {
  const d = await desktopOpen(processId, lot);
  const p = phoneOpen(processId, lot);
  for (const step of steps) {
    await step(d);
    await step(p);
  }
  return { desktop: d.result(), phone: p.result(), d, p };
}

beforeEach(() => {
  jest.resetModules();
  global.fetch = jest.fn();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  loadShared();
});

afterEach(() => {
  delete global.App;
});

// ── the flows ────────────────────────────────────────────────────────
const FLOWS = {
  'flat colours: per-colour parts, a common part overridden for one colour, a shared item, a one-colour pool part': ['PRC-PNT', [
    s => s.check('Red'), s => s.type('Red', 20),
    s => s.check('Blue'), s => s.type('Blue', 15)
  ]],
  'flat colours, a colour ticked, typed, then ticked off again': ['PRC-PNT', [
    s => s.check('Red'), s => s.type('Red', 12),
    s => s.check('Blue'), s => s.type('Blue', 7),
    s => s.check('Red')
  ]],
  'a pool-driven group with packing sub-groups riding along': ['PRC-PKG', [
    s => s.check('Red-White'), s => s.type('Red-White', 10),
    s => s.check('Blue-White'), s => s.type('Blue-White', 6),
    s => s.check('KIT BAG 20"'),
    s => s.check('SMALL KIT 20"')
  ]],
  'a sub-group given its own number': ['PRC-PKG', [
    s => s.check('Red-White'), s => s.type('Red-White', 10),
    s => s.check('KIT BAG 20"'), s => s.type('KIT BAG 20"', 4)
  ]],
  'two axes: mudguard colours follow the frame colours they name': ['PRC-ASM', [
    s => s.check('Red-White'), s => s.type('Red-White', 12),
    s => s.check('Blue-White'), s => s.type('Blue-White', 8)
  ]],
  'two axes: a secondary colour no frame names, on the whole lot': ['PRC-ASM', [
    s => s.check('Red-White'), s => s.type('Red-White', 12),
    s => s.check('Black')
  ]],
  'two axes with no Primary yet, then a split the grid has to record': ['PRC-RIM', [
    s => s.primary('pool:painted frame 26'),
    s => s.check('Blue-White'), s => s.type('Blue-White', 24),
    s => s.check('Pink-White'), s => s.type('Pink-White', 16),
    s => s.check('BCP'), s => s.type('BCP', 30),
    s => s.check('Black'), s => s.type('Black', 10),
    s => s.allocate('Blue-White', 'BCP', 24), s => s.allocate('Blue-White', 'Black', 0),
    s => s.allocate('Pink-White', 'BCP', 6), s => s.allocate('Pink-White', 'Black', 10)
  ]],
  'two axes, both rim colours on every frame': ['PRC-RIM', [
    s => s.primary('pool:painted frame 26'),
    s => s.check('Blue-White'), s => s.type('Blue-White', 24),
    s => s.all('tag:rim color')
  ]],
  'the colours a process paints, picked as Primary over the rib it consumes': ['PRC-PF', [
    s => s.primary('own:painted frame kalpi 20 inch'),
    s => s.check('Red'), s => s.type('Red', 10),
    s => s.check('Blue'), s => s.type('Blue', 5),
    s => s.check('Black'),
    s => s.check('KIT BAG 20"')
  ]],
  'a single quantity': ['PRC-CUT', [
    s => s.qty(40)
  ]],
  'a composite frame colour that already names the rim': ['PRC-CMP', [
    s => s.check('Blue-White / BCP'), s => s.type('Blue-White / BCP', 10),
    s => s.check('Pink-White / BCP'), s => s.type('Pink-White / BCP', 4)
  ]],
  'a packing sub-group beside a common part with a per-colour sibling': ['PRC-KIT', [
    s => s.check('Red'), s => s.type('Red', 10),
    s => s.check('Blue'), s => s.type('Blue', 5),
    s => s.check('KIT BAG 20"')
  ]],
  'colours added by hand to a process that has none': ['PRC-CUT', [
    s => s.manualColors(),
    s => s.check('Red'), s => s.type('Red', 5),
    s => s.check('Sea Green'), s => s.type('Sea Green', 3)
  ]],
  'a rim colour two frame colours name': ['PRC-WHT', [
    s => s.check('Blue-White'), s => s.type('Blue-White', 10),
    s => s.check('Red-White'), s => s.type('Red-White', 5),
    s => s.check('Red-Black'), s => s.type('Red-Black', 7)
  ]],
  'a frame colour unticked while another still names its rim': ['PRC-WHT', [
    s => s.check('Blue-White'), s => s.type('Blue-White', 10),
    s => s.check('Red-White'), s => s.type('Red-White', 5),
    s => s.check('Blue-White')
  ]]
};

describe.each(Object.entries(FLOWS))('%s', (_label, [processId, steps]) => {
  test('the checklist is desktop\'s: same colours, same groups, same roles', async () => {
    const d = await desktopOpen(processId);
    const p = phoneOpen(processId);
    expect(p.groups()).toEqual(d.groups());
  });

  test('the colour breakdown is desktop\'s', async () => {
    const { desktop, phone } = await both(processId, steps);
    expect(phone.colorBreakdown).toEqual(desktop.colorBreakdown);
  });

  test('the components consumed are desktop\'s, line for line', async () => {
    const { desktop, phone } = await both(processId, steps);
    expect(desktop.componentsConsumed.length).toBeGreaterThan(0);
    expect(comparable(phone.componentsConsumed)).toEqual(comparable(desktop.componentsConsumed));
  });
});

describe('a rim colour more than one frame colour names', () => {
  const qtyOf = (r, color) => r.colorBreakdown.find(c => c.color === color)?.qty;

  test('takes every frame it pairs with, on both', async () => {
    const [processId, steps] = FLOWS['a rim colour two frame colours name'];
    const { desktop, phone } = await both(processId, steps);
    // Taking the first match gave White 10, leaving 17 rims on 22 frames.
    for (const r of [desktop, phone]) {
      expect(qtyOf(r, 'White')).toBe(15);
      expect(qtyOf(r, 'Black')).toBe(7);
    }
  });

  test('stays on the lot while a frame that names it is still ticked, on both', async () => {
    const [processId, steps] = FLOWS['a frame colour unticked while another still names its rim'];
    const { desktop, phone } = await both(processId, steps);
    // Unticking the Blue-White frames used to untick White too, though the
    // Red-White frames still carry it.
    for (const r of [desktop, phone]) expect(qtyOf(r, 'White')).toBe(5);
  });
});

describe('an allocation cell below zero', () => {
  test('is refused on both, though its row adds up', async () => {
    const [processId, steps] = FLOWS['two axes with no Primary yet, then a split the grid has to record'];
    const negative = [
      ...steps.slice(0, -4),
      s => s.allocate('Blue-White', 'BCP', 29), s => s.allocate('Blue-White', 'Black', -5),
      s => s.allocate('Pink-White', 'BCP', 6), s => s.allocate('Pink-White', 'Black', 10)
    ];
    const { p } = await both(processId, negative);
    expect(App.Production.allocationBlockingError()).toContain('negative');
    expect(p.model.allocationError()).toContain('negative');
  });
});

describe('a secondary colour\'s own parts', () => {
  // A "Red" mudguard beside a "Red-White" frame is its own part, which no
  // frame column records. Desktop used to drop its column on the names
  // alone and save the lot with no mudguard consumed; both now record it.
  test('a mudguard that follows its frame is consumed, on both', async () => {
    const [processId, steps] = FLOWS['two axes: mudguard colours follow the frame colours they name'];
    const { desktop, phone } = await both(processId, steps);
    const mudguards = r => r.componentsConsumed.filter(l => /^Mudguard/.test(l.itemName)).map(l => [l.itemName, l.colorGroup, l.qty]);
    expect(mudguards(desktop)).toEqual([['Mudguard Red', 'Red', 24], ['Mudguard Blue', 'Blue', 16]]);
    expect(mudguards(phone)).toEqual(mudguards(desktop));
  });

  test('a part a counting colour already records is recorded once', async () => {
    const [processId, steps] = FLOWS['a composite frame colour that already names the rim'];
    const { desktop, phone } = await both(processId, steps);
    for (const r of [desktop, phone]) {
      expect(r.componentsConsumed.filter(l => l.itemName === 'Rim BCP').map(l => [l.colorGroup, l.qty]))
        .toEqual([['Blue-White / BCP', 20], ['Pink-White / BCP', 8]]);
    }
  });

  test('a common part is consumed under counting colours only, never again under a sub-group', async () => {
    const [processId, steps] = FLOWS['a packing sub-group beside a common part with a per-colour sibling'];
    const { desktop, phone } = await both(processId, steps);
    for (const r of [desktop, phone]) {
      expect(r.componentsConsumed.filter(l => /^Chain Cover/.test(l.itemName)).map(l => [l.itemName, l.colorGroup, l.qty]))
        .toEqual([['Chain Cover Red', 'Red', 10], ['Chain Cover', 'Blue', 5]]);
      expect(r.componentsConsumed.find(l => l.itemName === 'Poly Bag')).toMatchObject({ colorGroup: 'KIT BAG 20"', qty: 15 });
    }
  });
});

describe('what the port had to get right', () => {
  test('a pool item in several colours is drawn per colour, not from arbitrary buckets', async () => {
    const [processId, steps] = FLOWS['a pool-driven group with packing sub-groups riding along'];
    const { phone } = await both(processId, steps);
    const frames = phone.componentsConsumed.filter(l => l.itemName === 'Painted Frame 20');
    expect(frames.map(l => [l.colorGroup, l.qty])).toEqual([['Blue-White', 6], ['Red-White', 10]]);
  });

  test('a pool item that exists in one colour names that bucket and stays common', async () => {
    const [processId, steps] = FLOWS['flat colours: per-colour parts, a common part overridden for one colour, a shared item, a one-colour pool part'];
    const { phone } = await both(processId, steps);
    const mudguard = phone.componentsConsumed.find(l => l.itemName === 'Painted Mudguard');
    expect(mudguard).toMatchObject({ colorGroup: 'COMMON', poolColor: 'Black', qty: 70 });
  });

  test('sub-groups ride along without adding to the lot total', async () => {
    const [processId, steps] = FLOWS['a pool-driven group with packing sub-groups riding along'];
    const { phone, p } = await both(processId, steps);
    expect(p.model.lotTotal()).toBe(16);
    expect(phone.colorBreakdown.filter(c => !c.countsTowardTotal).map(c => c.color)).toEqual(['KIT BAG 20"', 'SMALL KIT 20"']);
  });

  test('a common part with a per-colour sibling is not consumed twice', async () => {
    const [processId, steps] = FLOWS['flat colours: per-colour parts, a common part overridden for one colour, a shared item, a one-colour pool part'];
    const { phone } = await both(processId, steps);
    const covers = phone.componentsConsumed.filter(l => /^Chain Cover/.test(l.itemName));
    expect(covers.map(l => [l.itemName, l.colorGroup, l.qty])).toEqual([['Chain Cover Red', 'Red', 20], ['Chain Cover', 'Blue', 15]]);
  });

  test('a recipe name is sent as Items Master spells it', async () => {
    const [processId, steps] = FLOWS['flat colours: per-colour parts, a common part overridden for one colour, a shared item, a one-colour pool part'];
    const { phone } = await both(processId, steps);
    expect(phone.componentsConsumed.some(l => l.itemName === 'Primer' && l.qty === 4.375)).toBe(true);
  });

  test('a per-colour line keeps its recipe unit, on both', async () => {
    // Desktop used to drop it, and the server read the Kg quantity as the
    // item's base unit.
    const [processId, steps] = FLOWS['flat colours: per-colour parts, a common part overridden for one colour, a shared item, a one-colour pool part'];
    const { phone, desktop } = await both(processId, steps);
    const pick = r => r.componentsConsumed.find(l => l.itemName === 'Paint(Gloss) Red');
    expect(pick(phone).unit).toBe('Kg');
    expect(pick(desktop).unit).toBe('Kg');
  });
});

// ── an existing lot ──────────────────────────────────────────────────
describe('editing a lot', () => {
  // Saved the way desktop saves it.
  async function savedLot(processId, steps) {
    const d = await desktopOpen(processId);
    for (const step of steps) await step(d);
    const r = d.result();
    return {
      rowIdx: 7, processId, lotNumber: 'LOT-T-0001', qty: 0, date: '14/09/2026', dateRaw: '2026-09-14',
      status: 'Pending', assignedTo: 'rakesh', outputItemName: PROCESSES[processId].process.outputItemName,
      colorBreakdown: r.colorBreakdown || [], color: '',
      componentsConsumed: r.componentsConsumed
    };
  }

  test('opened and saved with no change, it sends back exactly what it saved', async () => {
    const [processId, steps] = FLOWS['a pool-driven group with packing sub-groups riding along'];
    const lot = await savedLot(processId, steps);
    lot.componentsConsumed[1].qty = 13; // corrected by hand at a desk
    const p = phoneOpen(processId, lot);
    expect(p.result().colorBreakdown).toEqual(lot.colorBreakdown.map(c => ({ ...c })));
    expect(p.model.payloadLines()).toEqual(lot.componentsConsumed.map(c => ({
      itemName: c.itemName, size: c.size, narration: c.narration, color: c.color, sourceType: c.sourceType,
      qty: c.qty, colorGroup: c.colorGroup, poolColor: c.poolColor || '', unit: c.unit || ''
    })));
  });

  test('a restored checklist is the one desktop restores, allocation included', async () => {
    const [processId, steps] = FLOWS['two axes with no Primary yet, then a split the grid has to record'];
    const lot = await savedLot(processId, steps);
    // Saving that lot wrote its Primary back onto the process
    // (save_production's write-back), so the process has one now.
    const axes = PROCESSES[processId].axes;
    axes.primaryIsDefault = false;
    try {
      const d = await desktopOpen(processId, lot);
      const p = phoneOpen(processId, lot);
      expect(p.result().colorBreakdown).toEqual(d.result().colorBreakdown);
      expect(p.result().colorBreakdown).toEqual(lot.colorBreakdown);
    } finally {
      axes.primaryIsDefault = true;
    }
  });

  test('a lot whose process still has no Primary opens with the one it was saved with', async () => {
    // The lot's own answer sits in its breakdown, and both read it from
    // there rather than asking again on every edit.
    const [processId, steps] = FLOWS['two axes with no Primary yet, then a split the grid has to record'];
    const lot = await savedLot(processId, steps);
    const d = await desktopOpen(processId, lot);
    const picked = $$('#productionColorChecklist input[name="productionPrimaryAxisPick"]').find(r => r.checked);
    expect(picked && picked.value).toBe('pool:painted frame 26');
    expect(d.result().colorBreakdown).toEqual(lot.colorBreakdown);
    const p = phoneOpen(processId, lot);
    expect(p.model.primaryKey).toBe('pool:painted frame 26');
    expect(p.result().colorBreakdown).toEqual(lot.colorBreakdown);
    expect(p.model.validate()).toBe('');
  });

  test('a lot opens on the group it was saved with, after the process default moved', async () => {
    // Every save writes its Primary back onto the process, so a later lot
    // that picked the rims moves the default under this one. Opened on the
    // rims, this lot of 40 frames totalled its rim rows instead -- and a
    // save to fix a remark recounted it that way.
    const [processId, steps] = FLOWS['two axes with no Primary yet, then a split the grid has to record'];
    const lot = await savedLot(processId, steps);
    const axes = PROCESSES[processId].axes;
    const before = { key: axes.primaryAxisKey, isDefault: axes.primaryIsDefault };
    axes.primaryAxisKey = 'tag:rim color';
    axes.primaryIsDefault = false;
    try {
      const d = await desktopOpen(processId, lot);
      const picked = $$('#productionColorChecklist input[name="productionPrimaryAxisPick"]').find(r => r.checked);
      expect(picked && picked.value).toBe('pool:painted frame 26');
      expect(d.result().colorBreakdown).toEqual(lot.colorBreakdown);
      const p = phoneOpen(processId, lot);
      expect(p.model.primaryKey).toBe('pool:painted frame 26');
      expect(p.result().colorBreakdown).toEqual(lot.colorBreakdown);
    } finally {
      axes.primaryAxisKey = before.key;
      axes.primaryIsDefault = before.isDefault;
    }
  });

  test('a changed quantity moves the recipe\'s lines with it, as desktop\'s does', async () => {
    const [processId, steps] = FLOWS['flat colours: per-colour parts, a common part overridden for one colour, a shared item, a one-colour pool part'];
    const lot = await savedLot(processId, steps);
    const { desktop, phone } = await both(processId, [s => s.type('Red', 30)], lot);
    const byKey = lines => new Map(comparable(lines).map(l => [`${l.itemName}|${l.colorGroup}`, l.qty]));
    expect(byKey(phone.componentsConsumed)).toEqual(byKey(desktop.componentsConsumed));
  });

  test('but a line entered by hand keeps its number', async () => {
    const [processId, steps] = FLOWS['flat colours: per-colour parts, a common part overridden for one colour, a shared item, a one-colour pool part'];
    const lot = await savedLot(processId, steps);
    const primer = lot.componentsConsumed.find(l => l.itemName === 'Primer');
    primer.qty = 5; // the recipe says 4.375; someone recorded what was really used
    const p = phoneOpen(processId, lot);
    await p.type('Red', 30);
    const lines = p.model.payloadLines();
    expect(lines.find(l => l.itemName === 'Primer').qty).toBe(5);
    expect(lines.find(l => l.itemName === 'Frame---Red').qty).toBe(30);
    expect(lines.find(l => l.itemName === 'Poly Bag').qty).toBe(45);
  });

  test('a colour ticked off takes its lines with it; one ticked on brings its recipe', async () => {
    const [processId, steps] = FLOWS['flat colours: per-colour parts, a common part overridden for one colour, a shared item, a one-colour pool part'];
    const lot = await savedLot(processId, [steps[0], steps[1]]);
    const p = phoneOpen(processId, lot);
    await p.check('Red');
    await p.check('Blue');
    await p.type('Blue', 9);
    const groups = new Set(p.model.payloadLines().map(l => l.colorGroup));
    expect(groups.has('Red')).toBe(false);
    expect(p.model.payloadLines().find(l => l.itemName === 'Frame---Blue').qty).toBe(9);
  });
});

describe('the operator\'s own numbers', () => {
  test('a typed component quantity outlasts later changes to the colours', () => {
    const p = phoneOpen('PRC-PNT');
    p.check('Red'); p.type('Red', 20);
    const line = p.model.lines().find(l => l.itemName === 'Frame---Red');
    p.model.pinQty(line.id, 19);
    p.type('Red', 25);
    expect(p.model.payloadLines().find(l => l.itemName === 'Frame---Red').qty).toBe(19);
    expect(p.model.payloadLines().find(l => l.itemName === 'Poly Bag').qty).toBe(25);
    p.model.unpin(line.id);
    expect(p.model.payloadLines().find(l => l.itemName === 'Frame---Red').qty).toBe(25);
  });

  test('a removed line stays removed; an added one is sent', () => {
    const p = phoneOpen('PRC-CUT');
    p.qty(10);
    const rod = p.model.lines().find(l => l.itemName === 'Weld Rod');
    p.model.removeLine(rod.id);
    p.model.addLine({ itemName: 'Thinner', size: 'GENERAL', narration: '', color: '', sourceType: 'ITEM', qty: 1.5, colorGroup: 'COMMON', poolColor: '', unit: '' });
    p.qty(12);
    expect(p.model.payloadLines().map(l => [l.itemName, l.qty])).toEqual([['MS Tube', 18], ['Thinner', 1.5]]);
  });

  test('a secondary colour typed by hand stops following the lot', () => {
    const p = phoneOpen('PRC-ASM');
    p.check('Red-White'); p.type('Red-White', 12);
    p.check('Black');
    expect(p.model.rowQty(p.model.rows.find(r => r.color === 'Black'))).toBe(12);
    p.type('Black', 5);
    p.type('Red-White', 20);
    expect(p.model.rowQty(p.model.rows.find(r => r.color === 'Black'))).toBe(5);
  });
});
