/**
 * Regression tests for Color SUB-GROUP components on the Create/Edit
 * Production Lot form (../production.js).
 *
 * A process's Color Sub-Groups section holds two different kinds of group,
 * and the form has to tell them apart:
 *   - a real COLOR ("Blue", "Blue-White"), whose per-color rows merge into
 *     one matrix row with one cell per color;
 *   - a packing/variant BUCKET ('KIT BAG 24"', 'BLUE KIT BAG'), which is a
 *     line of consumption of its own.
 *
 * Two paths treated a bucket as though it were a color, and both ended with
 * the operator unable to record what the bucket actually consumes:
 *   1. _stripColorSubstring split the bucket name into words and deleted
 *      whichever one it found in the item name -- "Poly Bag" filed under
 *      'KIT BAG 24"' arrived as "Poly", and "Small Poly" under 'SMALL KIT
 *      BAG' arrived as "Poly" too, so two different bags came through as one
 *      indistinguishable pair of rows.
 *   2. _pruneRedundantMatrixColumns deleted the bucket's whole matrix column
 *      whenever its name repeated a checked primary color's ('BLUE KIT BAG'
 *      beside a checked "Blue"). That rule is for a non-primary color AXIS,
 *      whose real consumption lives in its own Per-Process Pool Components
 *      table; a bucket has no such table, so its column was the only place
 *      its components could be recorded and they were left with nowhere.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const PARTIAL = path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', 'production.html');

const FRAME_AXIS = { key: 'tag:frame color', label: 'Frame Color', colors: ['Blue', 'Red'], source: 'tag' };

// A Color Master rich enough for _isColorGroupName to separate a real color
// from a packing bucket -- with none loaded it treats every group as a
// color, which is the pre-existing fallback and not what these pin.
const COLOR_MASTER = ['Blue', 'Red', 'White', 'Black'].map(name => ({ name }));

function component(itemName, colorGroup, overrides = {}) {
  return Object.assign({
    itemName, size: '', narration: '', sourceType: 'ITEM', colorGroup, colorAxis: '', unit: '', qtyPerUnit: 1,
  }, overrides);
}

const COMMON_COMPONENT = component('Frame Tube', 'COMMON');
const BLUE_COMPONENT = component('Blue Paint', 'Blue', { qtyPerUnit: 0.5 });

function mount({ colors, components, axes = [FRAME_AXIS] }) {
  document.body.innerHTML = fs.readFileSync(PARTIAL, 'utf8');

  global.escapeHtml = value => String(value).replace(/[&<>"']/g, ch => HTML_ESCAPE_MAP[ch]);
  global.toNumber = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  global.$ = (sel, root = document) => root.querySelector(sel);
  global.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  global.formatCurrency = v => String(v);
  global.todayIso = () => '2026-01-01';
  global.parseRecordDate = () => 0;

  global.App = {
    State: {
      globalItems: [], globalColors: COLOR_MASTER, globalProduction: [], globalStock: [], filteredStock: [],
      globalProcesses: [{ processId: 'P1', outputItemName: 'Painted Frame', isFinalStage: false }],
    },
    Utils: {
      sameText: (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase(),
      sameColor(a, b) { return this.sameText(a, b); },
      isCommonColorGroup: g => String(g ?? '').trim().toUpperCase() === 'COMMON',
      showToast: () => {},
    },
  };

  global.Api = {
    call: jest.fn().mockImplementation(method => {
      switch (method) {
        case 'getProcessComponentsData': return Promise.resolve({ success: true, data: components });
        case 'getProcessColorGroups': return Promise.resolve({ success: true, data: colors });
        case 'getProcessColorAxes': return Promise.resolve({
          success: true,
          data: {
            axes, primaryColorAxis: axes[0].label,
            primaryAxisKey: axes[0].key, primaryIsDefault: false,
          },
        });
        default: return Promise.resolve({ success: true, data: [] });
      }
    }),
  };

  const code = fs.readFileSync(path.join(__dirname, '..', 'production.js'), 'utf8');
  // eslint-disable-next-line no-eval
  eval(code);
  App.Stock = { recomputeFiltered() {} };

  document.getElementById('productionProcessId').innerHTML = '<option value="P1">P1</option>';
  document.getElementById('productionProcessId').value = 'P1';
}

const checklistRows = () => Array.from(document.querySelectorAll('#productionColorChecklist .production-color-row'));
const matrixColumns = () => Array.from(document.querySelectorAll('#productionColorMatrixHeaderRow th[data-color]'))
  .map(th => th.dataset.color);
const matrixRowNames = () => Array.from(document.querySelectorAll('#productionColorMatrixBody tr'))
  .map(row => row.querySelector('.prod-comp-display-name')?.value ?? '');

async function checkColor(color, group) {
  const row = checklistRows().find(r => r.dataset.color === color && (!group || r.dataset.group === group));
  const checkbox = row.querySelector('.production-color-check');
  checkbox.checked = true;
  await App.Production.handleColorCheckToggle(checkbox);
  return row;
}

function cellQty(rowName, color) {
  const rowIdx = matrixRowNames().indexOf(rowName);
  const row = document.querySelectorAll('#productionColorMatrixBody tr')[rowIdx];
  return row.children[App.Production.getMatrixColumnIndex(color)].querySelector('.matrix-qty').value;
}

describe('Sub-group components keep the item name they were filed under', () => {
  test('a bucket own words are not deleted out of its items names', async () => {
    mount({
      colors: ['Blue', 'Red', 'KIT BAG 24"', 'SMALL KIT BAG'],
      components: [
        COMMON_COMPONENT,
        BLUE_COMPONENT,
        component('Poly Bag', 'KIT BAG 24"', { size: '24' }),
        component('Small Poly', 'SMALL KIT BAG'),
      ],
    });
    await App.Production.handleProcessChange('P1');

    const master = document.querySelector('[data-group-master="other"]');
    master.checked = true;
    await App.Production.toggleColorGroup(master, 'other');

    // Was ['Poly', 'Poly'] -- "Bag" stripped out of one, "Small" out of the
    // other, leaving two different bags named identically.
    expect(matrixRowNames()).toEqual(['Poly Bag', 'Small Poly']);
  });

  test('a real color is still stripped, so its rows merge across colors', async () => {
    mount({
      colors: ['Blue', 'Red'],
      components: [COMMON_COMPONENT, BLUE_COMPONENT, component('Red Paint', 'Red', { qtyPerUnit: 0.5 })],
    });
    await App.Production.handleProcessChange('P1');

    await checkColor('Blue');
    await checkColor('Red');

    expect(matrixRowNames()).toEqual(['Paint']);
    expect(matrixColumns()).toEqual(['Blue', 'Red']);
  });
});

describe('A sub-group column is scaled by its own quantity', () => {
  // _totalQtyForColorName counted only rows that add to the LOT TOTAL, and a
  // sub-group never does -- so every sub-group column was multiplied by
  // zero. The operator saw the bucket's components arrive with their item
  // pickers correctly filled in and a quantity of 0 in every cell, next to a
  // checklist row carrying the quantity those cells should have used.
  beforeEach(async () => {
    mount({
      colors: ['Blue', 'Red', 'SMALL KIT 26"'],
      components: [
        COMMON_COMPONENT,
        BLUE_COMPONENT,
        component('RIM-TAPE---COTTON', 'SMALL KIT 26"', { size: '26 inch', qtyPerUnit: 2 }),
      ],
    });
    await App.Production.handleProcessChange('P1');

    const blue = await checkColor('Blue');
    blue.querySelector('.production-color-qty').value = '23';
    await App.Production.onColorQtyChanged(blue);
  });

  test('checking the sub-group fills its cells, not zeros', async () => {
    await checkColor('SMALL KIT 26"');

    expect(matrixColumns()).toContain('SMALL KIT 26"');
    expect(cellQty('RIM-TAPE---COTTON', 'SMALL KIT 26"')).toBe('46');
  });

  test('editing the sub-group quantity rescales its cells', async () => {
    const bucket = await checkColor('SMALL KIT 26"');
    bucket.querySelector('.production-color-qty').value = '5';
    await App.Production.onColorQtyChanged(bucket);

    expect(cellQty('RIM-TAPE---COTTON', 'SMALL KIT 26"')).toBe('10');
  });

  test('the sub-group still stays out of the lot total', async () => {
    await checkColor('SMALL KIT 26"');

    // 23 from the primary color alone -- the bucket's own 23 is recorded per
    // color and must never be added on top.
    expect(App.Production._currentLotTotalQty()).toBe(23);
  });
});

describe('A sub-group bucket keeps its own matrix column', () => {
  beforeEach(async () => {
    mount({
      colors: ['Blue', 'Red', 'BLUE KIT BAG'],
      components: [COMMON_COMPONENT, BLUE_COMPONENT, component('Kit Poly', 'BLUE KIT BAG')],
    });
    await App.Production.handleProcessChange('P1');

    const blue = await checkColor('Blue');
    blue.querySelector('.production-color-qty').value = '10';
    await App.Production.onColorQtyChanged(blue);
    await checkColor('BLUE KIT BAG');
  });

  // Was: _colorNamesMatch('Blue', 'BLUE KIT BAG') is true, so the prune took
  // the bucket's column away and its component row was left with nowhere to
  // carry a quantity.
  test('the column survives a checked primary color whose name it repeats', () => {
    expect(matrixColumns()).toEqual(['Blue', 'BLUE KIT BAG']);
  });

  test('its component is scaled into that column', () => {
    expect(matrixRowNames()).toEqual(['Paint', 'Kit Poly']);
    expect(cellQty('Kit Poly', 'BLUE KIT BAG')).toBe('10');
  });

});

describe('A non-primary color AXIS is still pruned', () => {
  // Unchanged by the above: a "Blue" rim auto-checked by a "Blue-White"
  // frame describes the same physical units, and its real consumption lives
  // in that axis's own Per-Process Pool Components table, so its duplicate
  // matrix column has to go.
  test('a color-named axis row matching a checked primary loses its column', async () => {
    mount({
      axes: [
        { key: 'tag:frame color', label: 'Frame Color', colors: ['Blue-White'], source: 'tag' },
        { key: 'pool:mudguard rib', label: 'Mudguard Rib', colors: ['Blue'], source: 'pool' },
      ],
      colors: ['Blue-White', 'Blue'],
      components: [COMMON_COMPONENT, component('Frame Paint', 'Blue-White'), component('Rib Blue', 'Blue')],
    });
    await App.Production.handleProcessChange('P1');

    const frame = await checkColor('Blue-White', 'tag:frame color');
    frame.querySelector('.production-color-qty').value = '10';
    await App.Production.onColorQtyChanged(frame);
    await checkColor('Blue', 'pool:mudguard rib');

    expect(matrixColumns()).toEqual(['Blue-White']);
  });
});
