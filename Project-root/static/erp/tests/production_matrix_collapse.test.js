/**
 * Regression tests for collapsing EMPTY colour columns in the Create/Edit
 * Production Lot form's Per-Color Components matrix (../production.js).
 *
 * Why the feature exists: a column is rendered for every colour checked in
 * "Colors to Produce", not for every colour the process recipe actually has
 * per-colour parts for -- populateColorMatrixForColors only fills a cell
 * whose component colorGroup token-matches the column. A lot whose parts are
 * mostly Common-tagged therefore gets a wide grid of blank cells the
 * operator has to scroll sideways past to reach the columns that matter.
 *
 * Why it needs a test: the safe way to shrink such a column and the obvious
 * way are different. Every per-colour cell in this table is addressed by its
 * POSITION among the header row's children (getMatrixColumnIndex ->
 * row.children[idx] -> serializeColorMatrix), so removing a cell, or
 * display:none-ing a whole <td>, silently shifts every column after it and
 * lands quantities on the WRONG COLOUR -- with nothing thrown and nothing
 * visibly wrong until the lot is saved. So what is pinned here is not the
 * cosmetics but the invariant underneath them: collapsing changes classes
 * and width only, never the shape of a row.
 *
 * Run against the REAL partial read off disk, same technique as
 * production_row_reorder.test.js, so the header these assert against can
 * never drift from the one the app ships.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const PARTIAL = path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', 'production.html');

function loadProductionAsGlobal() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'production.js'), 'utf8');
  // eslint-disable-next-line no-eval
  eval(code);
}

const headerRow = () => document.getElementById('productionColorMatrixHeaderRow');
const bodyRows = () => Array.from(document.querySelectorAll('#productionColorMatrixBody tr'));

function headerFor(color) {
  return headerRow().children[App.Production.getMatrixColumnIndex(color)];
}

function isCollapsed(color) {
  return headerFor(color).classList.contains('prod-col-collapsed');
}

// A quantity typed by the operator, not written programmatically: the sticky
// "column was touched" rule keys off the input/change the browser fires.
function typeQty(row, color, value) {
  const input = row.children[App.Production.getMatrixColumnIndex(color)].querySelector('.matrix-qty');
  input.value = value;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

// Shared by every describe below: the real partial, the handful of globals
// production.js reaches for, then production.js itself.
function mountProductionForm() {
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
    State: { globalItems: [{ name: 'Sticker', size: 'L', narration: '' }], globalColors: [], globalProcesses: [], globalProduction: [] },
    Utils: {
      sameText: (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase(),
      sameColor(a, b) { return this.sameText(a, b); },
      isCommonColorGroup: g => String(g ?? '').trim().toUpperCase() === 'COMMON',
      showToast: () => {},
    },
  };

  loadProductionAsGlobal();
}

describe('Per-Color Components: collapsing empty colour columns', () => {
  beforeEach(mountProductionForm);

  test('a colour column with no quantities collapses; one with a quantity does not', () => {
    App.Production.addMatrixColorColumn('Blue-White');
    App.Production.addMatrixColorColumn('Kit Bag 24"');
    const row = App.Production.addMatrixItemRow({ itemName: 'Sticker', size: 'L', sourceType: 'ITEM' });

    // Nothing entered anywhere yet -- both columns are dead weight.
    expect(isCollapsed('Blue-White')).toBe(true);
    expect(isCollapsed('Kit Bag 24"')).toBe(true);

    typeQty(row, 'Kit Bag 24"', '2');
    App.Production._refreshMatrixColumns();

    expect(isCollapsed('Kit Bag 24"')).toBe(false);
    expect(isCollapsed('Blue-White')).toBe(true);
  });

  test('collapsing hides contents but never removes a cell, so indices still line up', () => {
    App.Production.addMatrixColorColumn('Blue-White');
    App.Production.addMatrixColorColumn('Red-Grey');
    App.Production.addMatrixColorColumn('Kit Bag 24"');
    const row = App.Production.addMatrixItemRow({ itemName: 'Sticker', size: 'L', sourceType: 'ITEM' });

    typeQty(row, 'Kit Bag 24"', '7');
    App.Production._refreshMatrixColumns();

    // Two collapsed columns sit BEFORE the populated one -- exactly the
    // arrangement that would misalign everything if a <td> were dropped.
    expect(isCollapsed('Blue-White')).toBe(true);
    expect(isCollapsed('Red-Grey')).toBe(true);
    expect(row.children.length).toBe(headerRow().children.length);

    const serialized = App.Production.serializeColorMatrix();
    expect(serialized).toHaveLength(1);
    expect(serialized[0].colorGroup).toBe('Kit Bag 24"');
    expect(serialized[0].qty).toBe(7);
  });

  test('a collapsed column marks its own body cells, and only its own', () => {
    App.Production.addMatrixColorColumn('Blue-White');
    App.Production.addMatrixColorColumn('Kit Bag 24"');
    const row = App.Production.addMatrixItemRow({ itemName: 'Sticker', size: 'L', sourceType: 'ITEM' });
    typeQty(row, 'Kit Bag 24"', '3');
    App.Production._refreshMatrixColumns();

    const blueCell = row.children[App.Production.getMatrixColumnIndex('Blue-White')];
    const kitCell = row.children[App.Production.getMatrixColumnIndex('Kit Bag 24"')];

    expect(blueCell.classList.contains('prod-col-collapsed')).toBe(true);
    expect(kitCell.classList.contains('prod-col-collapsed')).toBe(false);
    // The input itself survives -- serializeColorMatrix still reads it.
    expect(blueCell.querySelector('.matrix-qty')).not.toBeNull();
  });

  test('clicking a collapsed header expands that column, and clicking again re-collapses it', () => {
    App.Production.addMatrixColorColumn('Blue-White');
    App.Production.addMatrixItemRow({ itemName: 'Sticker', size: 'L', sourceType: 'ITEM' });

    expect(isCollapsed('Blue-White')).toBe(true);

    // The expand affordance is a real <button> so it is keyboard-reachable
    // and announced as a control; the <th> keeps its columnheader role.
    headerFor('Blue-White').querySelector('.prod-col-expand').click();
    expect(isCollapsed('Blue-White')).toBe(false);

    headerFor('Blue-White').querySelector('.prod-col-expand').click();
    expect(isCollapsed('Blue-White')).toBe(true);
  });

  test('a column the operator typed into stays open after the value is cleared again', () => {
    App.Production.addMatrixColorColumn('Blue-White');
    const row = App.Production.addMatrixItemRow({ itemName: 'Sticker', size: 'L', sourceType: 'ITEM' });

    typeQty(row, 'Blue-White', '5');
    App.Production._refreshMatrixColumns();
    expect(isCollapsed('Blue-White')).toBe(false);

    // Clearing a value to retype it must not collapse the column out from
    // under the cursor on the next reflow.
    typeQty(row, 'Blue-White', '');
    App.Production._refreshMatrixColumns();
    expect(isCollapsed('Blue-White')).toBe(false);
  });

  test('a merged cell with an item picked but no qty yet counts as in use', () => {
    App.Production.addMatrixColorColumn('Blue-White');
    const row = App.Production.addMergedMatrixRow({ itemName: 'Frame', size: 'L', sourceType: 'ITEM' });

    expect(isCollapsed('Blue-White')).toBe(true);

    const cell = row.children[App.Production.getMatrixColumnIndex('Blue-White')];
    const select = cell.querySelector('.prod-comp-item-select');
    select.innerHTML = '<option value=""></option><option value="Frame|L" selected>Frame</option>';
    App.Production._refreshMatrixColumns();

    expect(isCollapsed('Blue-White')).toBe(false);
  });

  test('the table reserves only a narrow strip for a collapsed column', () => {
    const table = headerRow().closest('table');
    const reserve = App.Production.PROD_COLOR_TABLE_FIXED_RESERVE_PX;
    const full = App.Production.PROD_COLOR_TABLE_COLOR_COL_PX;
    const strip = App.Production.PROD_COLOR_TABLE_COLLAPSED_COL_PX;

    App.Production.addMatrixColorColumn('Blue-White');
    App.Production.addMatrixColorColumn('Kit Bag 24"');
    const row = App.Production.addMatrixItemRow({ itemName: 'Sticker', size: 'L', sourceType: 'ITEM' });
    typeQty(row, 'Kit Bag 24"', '2');
    App.Production._refreshMatrixColumns();

    // One populated column at full width, one collapsed at strip width --
    // if a collapsed column were still counted at full width the table (and
    // its horizontal scrollbar) would never actually shrink.
    expect(table.style.minWidth).toBe(`${reserve + full + strip}px`);
  });

  test('removing a colour that was expanded does not leave the next column collapsed by mistake', () => {
    App.Production.addMatrixColorColumn('Blue-White');
    App.Production.addMatrixColorColumn('Kit Bag 24"');
    const row = App.Production.addMatrixItemRow({ itemName: 'Sticker', size: 'L', sourceType: 'ITEM' });
    typeQty(row, 'Kit Bag 24"', '4');
    App.Production._refreshMatrixColumns();

    App.Production._removeMatrixColumnAt(App.Production.getMatrixColumnIndex('Blue-White'));

    expect(App.Production.getMatrixColumnIndex('Blue-White')).toBe(-1);
    expect(isCollapsed('Kit Bag 24"')).toBe(false);
    expect(bodyRows()[0].children.length).toBe(headerRow().children.length);
    expect(App.Production.serializeColorMatrix()).toEqual([
      expect.objectContaining({ colorGroup: 'Kit Bag 24"', qty: 4 }),
    ]);
  });

  test('clearing the matrix forgets which columns were expanded by hand', () => {
    App.Production.addMatrixColorColumn('Blue-White');
    App.Production.addMatrixItemRow({ itemName: 'Sticker', size: 'L', sourceType: 'ITEM' });
    headerFor('Blue-White').querySelector('.prod-col-expand').click();
    expect(isCollapsed('Blue-White')).toBe(false);

    App.Production.clearColorMatrix();
    App.Production.addMatrixColorColumn('Blue-White');
    App.Production.addMatrixItemRow({ itemName: 'Sticker', size: 'L', sourceType: 'ITEM' });

    // A different lot opened in the same session starts from the default.
    expect(isCollapsed('Blue-White')).toBe(true);
  });
});

describe('Per-Color Components: the matrix with no rows in it', () => {
  beforeEach(mountProductionForm);

  const tableWrap = () => document.getElementById('productionColorMatrixTableWrap');
  const emptyNote = () => document.getElementById('productionColorMatrixEmpty');
  const addButton = () => document.querySelector('[onclick="App.Production.addColorMatrixRow()"]');

  test('the header is hidden until a row exists, and the hint takes its place', () => {
    // The state an operator lands in whenever the recipe has no per-color
    // part: colors are checked, so columns exist, but nothing populates a
    // row. Every column is empty and therefore collapsed, which left a
    // header of rotated strips over an empty body.
    App.Production.showColorMatrix();
    App.Production.addMatrixColorColumn('Blue-White');
    App.Production.addMatrixColorColumn('Kit Bag 24"');

    expect(tableWrap().style.display).toBe('none');
    expect(emptyNote().style.display).not.toBe('none');
    // The way OUT of the empty state has to stay reachable.
    expect(addButton()).not.toBeNull();

    App.Production.addMatrixItemRow({ itemName: 'Sticker', size: 'L', sourceType: 'ITEM' });

    expect(tableWrap().style.display).not.toBe('none');
    expect(emptyNote().style.display).toBe('none');
  });

  test('removing the last row hides the header again', () => {
    App.Production.addMatrixColorColumn('Blue-White');
    const first = App.Production.addMatrixItemRow({ itemName: 'Sticker', size: 'L', sourceType: 'ITEM' });
    const second = App.Production.addMatrixItemRow({ itemName: 'Sticker', size: 'L', sourceType: 'ITEM' });

    App.Production.removeMatrixRow(second.id);
    expect(tableWrap().style.display).not.toBe('none');

    App.Production.removeMatrixRow(first.id);
    expect(tableWrap().style.display).toBe('none');
    expect(emptyNote().style.display).not.toBe('none');
  });

  test('hiding the table keeps the columns, so a later row still lands on the right color', () => {
    App.Production.addMatrixColorColumn('Blue-White');
    App.Production.addMatrixColorColumn('Kit Bag 24"');
    expect(tableWrap().style.display).toBe('none');

    // Columns are maintained while out of view -- they are addressed by
    // position, so a header that stopped tracking them would land the
    // quantity below on the wrong color.
    const row = App.Production.addMatrixItemRow({ itemName: 'Sticker', size: 'L', sourceType: 'ITEM' });
    expect(row.children.length).toBe(headerRow().children.length);

    typeQty(row, 'Kit Bag 24"', '6');
    App.Production._refreshMatrixColumns();

    expect(App.Production.serializeColorMatrix()).toEqual([
      expect.objectContaining({ colorGroup: 'Kit Bag 24"', qty: 6 }),
    ]);
  });

  test('clearing the matrix for the next lot returns it to the empty state', () => {
    App.Production.addMatrixColorColumn('Blue-White');
    App.Production.addMatrixItemRow({ itemName: 'Sticker', size: 'L', sourceType: 'ITEM' });
    expect(tableWrap().style.display).not.toBe('none');

    App.Production.clearColorMatrix();

    expect(tableWrap().style.display).toBe('none');
    expect(emptyNote().style.display).not.toBe('none');
  });
});
