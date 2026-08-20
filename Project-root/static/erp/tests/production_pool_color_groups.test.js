/**
 * Regression tests for the two colour tables of the Create/Edit Production
 * Lot form that are driven by an AXIS rather than by a plain colour list:
 * Per-Process Pool Components (one table per upstream pool item) and the
 * Per-Color Components matrix (../production.js).
 *
 * Both bugs pinned here are silent-wrong-number bugs, not crashes: the form
 * renders, the operator sees a plausible grid, and the wrong quantity is
 * what gets saved into the lot's components_consumed.
 *
 * Run against the REAL partial read off disk, same technique as
 * production_matrix_collapse.test.js, so the table shells these assert
 * against can never drift from the ones the app ships.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const PARTIAL = path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', 'production.html');

const MERGED_AXIS = 'merged:painted frame, rim color';
const TAG_AXIS = 'tag:mudguard color';

function loadProductionAsGlobal() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'production.js'), 'utf8');
  // eslint-disable-next-line no-eval
  eval(code);
}

// Checks a colour in the "Colors to Produce" checklist and gives it a
// quantity, the way the operator would -- straight through the DOM, since
// every reader under test resolves the checked set by querying it.
function checkColor(color, qty) {
  const row = Array.from(document.querySelectorAll('#productionColorChecklist .production-color-row'))
    .find(r => r.dataset.color === color);
  row.querySelector('.production-color-check').checked = true;
  const qtyInput = row.querySelector('.production-color-qty');
  qtyInput.disabled = false;
  qtyInput.value = String(qty);
  return row;
}

function poolTable() {
  return document.querySelector('#productionPoolColorGroupsContainer table.prod-color-table');
}

function poolTableColumns() {
  return Array.from(poolTable().querySelectorAll('thead th[data-color]')).map(th => th.dataset.color);
}

function poolCellValue(color) {
  return poolTable().querySelector(`.pool-group-qty[data-color="${color}"]`).value;
}

function setUpDom() {
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
      globalItems: [{ name: 'Sticker', size: 'L', narration: '' }],
      globalColors: [],
      globalProcesses: [],
      globalProduction: [],
    },
    Utils: {
      sameText: (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase(),
      sameColor(a, b) { return this.sameText(a, b); },
      isCommonColorGroup: g => String(g ?? '').trim().toUpperCase() === 'COMMON',
      showToast: () => {},
    },
  };

  loadProductionAsGlobal();
}

describe('Per-Process Pool Components: a MERGED axis is still a pool axis', () => {
  // A process whose pool axis has been paired with another axis through
  // Process Color Links arrives from getProcessColorAxes as ONE axis with
  // source 'merged' (process_service._merge_linked_axes), its label the
  // constituents' labels joined by ', ' -- so the pool item names are still
  // in there. Only 'pool' used to be recognised, so such an axis resolved to
  // NO axis key, and an unscoped axis key means "every checked colour in the
  // lot" -- including a second axis's.
  beforeEach(() => {
    setUpDom();

    App.Production._customColorGroupOptions = [
      { key: MERGED_AXIS, label: 'Painted Frame, Rim Color', isPrimary: true, source: 'merged' },
      { key: TAG_AXIS, label: 'Mudguard Color', isPrimary: false, source: 'tag' },
    ];

    App.Production.renderColorChecklistRows(['Blue-White', 'Red-White'], MERGED_AXIS, false, true);
    App.Production.renderColorChecklistRows(['Green'], TAG_AXIS, false, false);
  });

  test('resolves the merged axis by the pool item names inside its label', () => {
    expect(App.Production._axisKeyForPoolItemNames(['Painted Frame'])).toBe(MERGED_AXIS);
  });

  test('a plain tag axis is still not treated as pool-backed', () => {
    expect(App.Production._axisKeyForPoolItemNames(['Mudguard Color'])).toBe('');
  });

  test('its table shows only its own axis\'s colours, not the other axis\'s', () => {
    checkColor('Blue-White', 10);
    // Same literal name as one of the pool item's own colours, but checked
    // on a DIFFERENT axis -- it must not open a column here.
    checkColor('Green', 5);

    App.Production.renderPoolColorSplitGroups(
      [{ itemName: 'Painted Frame', size: '', sourceType: 'POOL', qtyPerUnit: 2 }],
      new Map([['painted frame', ['Blue-White', 'Green', 'Red-White']]])
    );

    expect(poolTable().dataset.axisKey).toBe(MERGED_AXIS);
    expect(poolTableColumns()).toEqual(['Blue-White']);
    // 10 produced x 2 per unit -- the tag axis's 5 is nowhere in it.
    expect(poolCellValue('Blue-White')).toBe('20');
  });

  test('a custom colour filed into the merged axis extends that axis\'s own table', () => {
    checkColor('Blue-White', 10);
    App.Production.renderPoolColorSplitGroups(
      [{ itemName: 'Painted Frame', size: '', sourceType: 'POOL', qtyPerUnit: 1 }],
      new Map([['painted frame', ['Blue-White', 'Red-White']]])
    );

    const def = App.Production._poolDefForCustomColor(App.Production._customColorGroupOptions[0]);
    expect(def).not.toBeNull();
    expect(def.colors).toContain('Blue-White');
  });
});

describe('Per-Process Pool Components: another axis\'s hand-typed quantity', () => {
  // refreshPoolColorGroupCells recomputes cells from the checklist, so it
  // deliberately skips tables belonging to an axis other than the one that
  // just changed -- otherwise toggling axis A silently rewrites a quantity
  // the operator typed by hand into axis B's table.
  test('survives a checklist change on a different axis', () => {
    setUpDom();
    App.Production._customColorGroupOptions = [
      { key: MERGED_AXIS, label: 'Painted Frame, Rim Color', isPrimary: true, source: 'merged' },
      { key: TAG_AXIS, label: 'Mudguard Color', isPrimary: false, source: 'tag' },
    ];
    App.Production.renderColorChecklistRows(['Blue-White'], MERGED_AXIS, false, true);
    App.Production.renderColorChecklistRows(['Green'], TAG_AXIS, false, false);
    checkColor('Blue-White', 10);

    App.Production.renderPoolColorSplitGroups(
      [{ itemName: 'Painted Frame', size: '', sourceType: 'POOL', qtyPerUnit: 1 }],
      new Map([['painted frame', ['Blue-White']]])
    );

    const cell = poolTable().querySelector('.pool-group-qty[data-color="Blue-White"]');
    cell.value = '77';

    // A colour on the OTHER axis moved -- this table is not its business.
    App.Production.refreshPoolColorGroupCells(TAG_AXIS);
    expect(cell.value).toBe('77');

    // Its own axis moved -- now the recipe-scaled value takes over again.
    App.Production.refreshPoolColorGroupCells(MERGED_AXIS);
    expect(cell.value).toBe('10');
  });
});

describe('Per-Color Components: a colour column added later matches one built with the row', () => {
  // Every per-colour cell is addressed by POSITION among the header's
  // children, so the two build paths produce cells that must be
  // interchangeable. They had drifted on `step` -- a later-added plain cell
  // was step="0.0001" against the row-built one's step="any" -- which makes
  // the same column accept or reject a quantity based on nothing but when
  // it happened to be created.
  beforeEach(setUpDom);

  test('for a plain item row', () => {
    App.Production.addMatrixColorColumn('Blue');
    const row = App.Production.addMatrixItemRow({ itemName: 'Sticker', size: 'L', sourceType: 'ITEM' });
    App.Production.addMatrixColorColumn('Red');

    const builtWithRow = row.children[App.Production.getMatrixColumnIndex('Blue')];
    const addedLater = row.children[App.Production.getMatrixColumnIndex('Red')];

    expect(addedLater.innerHTML).toBe(builtWithRow.innerHTML);
    expect(addedLater.querySelector('.matrix-qty').getAttribute('step')).toBe('any');
  });

  test('for a merged row', () => {
    App.Production.addMatrixColorColumn('Blue');
    const row = App.Production.addMergedMatrixRow({ itemName: 'Sticker', size: 'L', sourceType: 'ITEM' });
    App.Production.addMatrixColorColumn('Red');

    const builtWithRow = row.children[App.Production.getMatrixColumnIndex('Blue')];
    const addedLater = row.children[App.Production.getMatrixColumnIndex('Red')];

    expect(addedLater.innerHTML).toBe(builtWithRow.innerHTML);
    expect(addedLater.querySelector('.prod-comp-item-select')).not.toBeNull();
  });

  test('and a quantity typed into either serialises against the right colour', () => {
    App.Production.addMatrixColorColumn('Blue');
    const row = App.Production.addMatrixItemRow({ itemName: 'Sticker', size: 'L', sourceType: 'ITEM' });
    App.Production.addMatrixColorColumn('Red');

    row.children[App.Production.getMatrixColumnIndex('Blue')].querySelector('.matrix-qty').value = '3';
    row.children[App.Production.getMatrixColumnIndex('Red')].querySelector('.matrix-qty').value = '4.5';

    expect(App.Production.serializeColorMatrix()).toEqual([
      expect.objectContaining({ itemName: 'Sticker', size: 'L', colorGroup: 'Blue', qty: 3 }),
      expect.objectContaining({ itemName: 'Sticker', size: 'L', colorGroup: 'Red', qty: 4.5 }),
    ]);
  });
});

describe('Colour headers built at runtime carry a column scope', () => {
  beforeEach(setUpDom);

  test('Per-Color Components', () => {
    App.Production.addMatrixColorColumn('Blue');
    const th = document.getElementById('productionColorMatrixHeaderRow')
      .querySelector('th[data-color="Blue"]');
    expect(th.getAttribute('scope')).toBe('col');
  });

  test('Per-Process Pool Components', () => {
    App.Production._customColorGroupOptions = [
      { key: MERGED_AXIS, label: 'Painted Frame', isPrimary: true, source: 'pool' },
    ];
    App.Production.renderColorChecklistRows(['Blue-White'], MERGED_AXIS, false, true);
    checkColor('Blue-White', 1);

    App.Production.renderPoolColorSplitGroups(
      [{ itemName: 'Painted Frame', size: '', sourceType: 'POOL', qtyPerUnit: 1 }],
      new Map([['painted frame', ['Blue-White']]])
    );

    expect(poolTable().querySelector('th[data-color="Blue-White"]').getAttribute('scope')).toBe('col');
  });
});
