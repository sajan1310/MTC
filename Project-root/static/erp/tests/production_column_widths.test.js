/**
 * Tests for the column widths of the two per-color tables in the
 * Create/Edit Production Lot form (../production.js).
 *
 * Why this exists: both tables are `table-layout: fixed`, which means a
 * column is exactly as wide as its header <th> says and nothing in the
 * cells can push it wider. Leftover space used to land on whichever
 * columns the CSS left `auto`, so a lot with ONE color rendered two ~565px
 * free-text columns beside a Size column reading "G..." and an item picker
 * clipped to "Mah...". The fit is now computed (PROD_COL_SPECS ->
 * _fitColorTableColumns) and the operator can overrule it by dragging.
 *
 * The invariant underneath all of it: every per-color cell is addressed by
 * its POSITION among the header row's children (getMatrixColumnIndex ->
 * row.children[idx] -> serializeColorMatrix). Widths and handles may change
 * how a column LOOKS; nothing here may change how many children a row has
 * or what order they are in, or quantities land on the wrong color with
 * nothing visibly wrong until the lot is saved.
 *
 * Run against the REAL partial read off disk, same technique as
 * production_matrix_collapse.test.js.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const PARTIAL = path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', 'production.html');

const MODAL_WIDTH = 1780;

function loadProductionAsGlobal() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'production.js'), 'utf8');
  // eslint-disable-next-line no-eval
  eval(code);
}

const matrixTable = () => document.getElementById('productionColorMatrixHeaderRow').closest('table');
const headerRow = () => document.getElementById('productionColorMatrixHeaderRow');

// jsdom lays nothing out, so the width the fit is fitted to has to be said
// out loud. Everything downstream reads back from style.width, which the
// layout itself writes, so no other geometry needs faking.
function giveTableRoom(table, px = MODAL_WIDTH) {
  Object.defineProperty(table.parentElement, 'clientWidth', { value: px, configurable: true });
}

function widths() {
  const out = {};
  Array.from(headerRow().children).forEach((th, i, all) => {
    out[App.Production._colKeyAt(th, i, all.length - 1)] = parseFloat(th.style.width);
  });
  return out;
}

// What the columns are fitted to: the wrapper less the one pixel held back
// for the collapsed outer border.
function fitTarget(px = MODAL_WIDTH) {
  return px - App.Production.PROD_COL_TABLE_EDGE_PX;
}

function sumOfColumns() {
  return Array.from(headerRow().children)
    .reduce((sum, th) => sum + parseFloat(th.style.width), 0);
}

function handleFor(key) {
  return Array.from(headerRow().querySelectorAll('.prod-col-resizer'))
    .find(h => h.dataset.colKey === key);
}

// A drag: press on the handle, move, release. Delegated off the table, so
// the press has to bubble; move and release are on window, as during a real
// drag the pointer is long gone from the 6px handle.
function dragHandle(key, byPx) {
  const handle = handleFor(key);
  handle.dispatchEvent(new window.MouseEvent('pointerdown', { clientX: 500, bubbles: true }));
  window.dispatchEvent(new window.MouseEvent('pointermove', { clientX: 500 + byPx }));
  window.dispatchEvent(new window.MouseEvent('pointerup', { clientX: 500 + byPx }));
}

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

describe('Per-color tables: the automatic column fit', () => {
  beforeEach(() => {
    localStorage.clear();
    mountProductionForm();
  });

  test('a one-colour lot does not dump the slack on Item and Narration', () => {
    // The shape from the bug report: one colour, so ~1200px of slack with
    // only two `auto` columns to absorb it.
    App.Production.addMatrixColorColumn('Pink-White / Black');
    const row = App.Production.addMatrixItemRow({ itemName: 'Sticker', size: 'L', sourceType: 'ITEM' });
    App.Production._matrixQtyInput?.(row);
    giveTableRoom(matrixTable());
    App.Production._layoutMatrixTable();

    const w = widths();
    const specs = App.Production.PROD_COL_SPECS;

    // Nothing is starved: Size can show a size and Source its longest
    // option, "Pool (Warehouse)".
    expect(w.size).toBeGreaterThanOrEqual(specs.size.pref);
    expect(w.source).toBeGreaterThanOrEqual(specs.source.pref);
    // The slack goes to the columns that can use it, not to the two
    // holding a short string and a fixed set of options.
    expect(w.size).toBeLessThanOrEqual(specs.size.max);
    expect(w.source).toBeLessThanOrEqual(specs.source.max);
    expect(w.item).toBeGreaterThan(specs.item.pref);
    // And it is all spent: no dead band to the right of the last column.
    expect(sumOfColumns()).toBe(fitTarget());
  });

  test('every column stays within its own min/max, and the table matches their sum', () => {
    ['Blue-White', 'Red-Grey', 'Kit Bag 24"'].forEach(c => App.Production.addMatrixColorColumn(c));
    const row = App.Production.addMatrixItemRow({ itemName: 'Sticker', size: 'L', sourceType: 'ITEM' });
    row.children[App.Production.getMatrixColumnIndex('Blue-White')].querySelector('.matrix-qty').value = '3';
    App.Production._refreshMatrixColumns();
    giveTableRoom(matrixTable());
    App.Production._layoutMatrixTable();

    Array.from(headerRow().children).forEach((th, i, all) => {
      const key = App.Production._colKeyAt(th, i, all.length - 1);
      const spec = App.Production._colSpecFor(th, key);
      const px = parseFloat(th.style.width);
      expect(px).toBeGreaterThanOrEqual(spec.min);
      // A column that takes no share of the leftover never exceeds its max;
      // one that does may, because the table has to fill the form.
      if (spec.grow === 0) expect(px).toBeLessThanOrEqual(spec.max);
    });
    expect(parseFloat(matrixTable().style.width)).toBe(sumOfColumns());
    expect(sumOfColumns()).toBe(fitTarget());
  });

  test('a table with no room to fit to is left alone rather than crushed', () => {
    // clientWidth is 0 for as long as the modal is hidden. Fitting to that
    // would drive every column to its minimum before anyone saw the form.
    App.Production.addMatrixColorColumn('Blue-White');
    App.Production.addMatrixItemRow({ itemName: 'Sticker', size: 'L', sourceType: 'ITEM' });
    App.Production._layoutMatrixTable();

    expect(matrixTable().style.width).toBe('');
    expect(widths().item).toBe(App.Production.PROD_COL_SPECS.item.pref);
  });

  test('a collapsed colour strip is not resizable and is never widened by the fit', () => {
    App.Production.addMatrixColorColumn('Blue-White');
    App.Production.addMatrixItemRow({ itemName: 'Sticker', size: 'L', sourceType: 'ITEM' });
    App.Production._refreshMatrixColumns();
    giveTableRoom(matrixTable());
    App.Production._layoutMatrixTable();

    expect(widths()['c:Blue-White']).toBe(App.Production.PROD_COL_SPECS.colorCollapsed.pref);
    expect(handleFor('c:Blue-White')).toBeUndefined();
  });

  test('the grip and ✕ columns carry no handle either', () => {
    App.Production.addMatrixItemRow({ itemName: 'Sticker', size: 'L', sourceType: 'ITEM' });
    giveTableRoom(matrixTable());
    App.Production._layoutMatrixTable();

    expect(handleFor('grip')).toBeUndefined();
    expect(handleFor('close')).toBeUndefined();
    expect(handleFor('item')).toBeDefined();
  });
});

describe('Per-color tables: widths the operator drags', () => {
  beforeEach(() => {
    localStorage.clear();
    mountProductionForm();
    App.Production.addMatrixColorColumn('Blue-White');
    App.Production.addMatrixItemRow({ itemName: 'Sticker', size: 'L', sourceType: 'ITEM' });
    giveTableRoom(matrixTable());
    App.Production._layoutMatrixTable();
  });

  test('during the drag only that edge moves', () => {
    const before = widths();
    const tableBefore = parseFloat(matrixTable().style.width);
    const handle = handleFor('item');

    handle.dispatchEvent(new window.MouseEvent('pointerdown', { clientX: 500, bubbles: true }));
    window.dispatchEvent(new window.MouseEvent('pointermove', { clientX: 620 }));

    const during = widths();
    expect(during.item).toBe(before.item + 120);
    // The rest hold still -- the table must not re-flow under the pointer.
    expect(during.size).toBe(before.size);
    expect(during.narration).toBe(before.narration);
    expect(during.source).toBe(before.source);
    expect(parseFloat(matrixTable().style.width)).toBe(tableBefore + 120);
  });

  test('releasing keeps the dragged width and puts the table back on the form width', () => {
    const before = widths();

    dragHandle('item', 120);

    // What was dragged is kept; everything else gives up the difference, so
    // the table neither overflows nor leaves a band of dead space.
    expect(widths().item).toBe(before.item + 120);
    expect(sumOfColumns()).toBe(fitTarget());
    expect(parseFloat(matrixTable().style.width)).toBe(fitTarget());
  });

  test('narrowing a column is absorbed too, rather than leaving a gap', () => {
    dragHandle('item', -100);

    expect(sumOfColumns()).toBe(fitTarget());
  });

  test('a second drag does not discard the width set by the first', () => {
    dragHandle('item', 100);
    const item = widths().item;

    dragHandle('narration', 60);

    expect(widths().item).toBe(item);
    expect(sumOfColumns()).toBe(fitTarget());
  });

  test('a dragged width beats the automatic fit on the next relayout', () => {
    dragHandle('narration', 150);
    const dragged = widths().narration;

    App.Production._refreshMatrixColumns();

    expect(widths().narration).toBe(dragged);
  });

  test('a drag can go past the width the automatic fit would ever choose', () => {
    // The point of the handles: a long item name is allowed more room than
    // the fit thinks is sensible.
    dragHandle('item', 600);

    expect(widths().item).toBeGreaterThan(App.Production.PROD_COL_SPECS.item.max);
    expect(widths().item).toBeLessThanOrEqual(App.Production.PROD_COL_DRAG_MAX_PX);
  });

  test('a drag cannot squeeze a column below its minimum', () => {
    dragHandle('size', -400);

    expect(widths().size).toBe(App.Production.PROD_COL_SPECS.size.min);
  });

  test('arrow keys on a focused handle adjust the width, press after press', () => {
    const before = widths().item;
    const handle = handleFor('item');
    const step = App.Production.PROD_COL_KEYBOARD_STEP_PX;

    handle.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(widths().item).toBe(before + step);

    // The SAME element, not a re-query: a relayout runs after every nudge,
    // and rebuilding the handle it is running on would drop the focus and
    // leave the second press doing nothing.
    expect(handleFor('item')).toBe(handle);
    handle.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(widths().item).toBe(before);
  });

  test('double-clicking a handle restores that column to the automatic fit', () => {
    const fitted = widths().item;
    dragHandle('item', 200);
    expect(widths().item).not.toBe(fitted);

    handleFor('item').dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));

    expect(widths().item).toBe(fitted);
  });

  test('resizing never changes the shape of a row, so quantities keep their colour', () => {
    App.Production.addMatrixColorColumn('Kit Bag 24"');
    const row = document.querySelector('#productionColorMatrixBody tr');
    const qty = row.children[App.Production.getMatrixColumnIndex('Kit Bag 24"')].querySelector('.matrix-qty');
    qty.value = '9';
    qty.dispatchEvent(new window.Event('input', { bubbles: true }));
    App.Production._refreshMatrixColumns();

    dragHandle('item', 90);
    dragHandle('c:Kit Bag 24"', 40);

    expect(row.children.length).toBe(headerRow().children.length);
    expect(App.Production.serializeColorMatrix()).toEqual([
      expect.objectContaining({ colorGroup: 'Kit Bag 24"', qty: 9 }),
    ]);
  });
});

describe('Per-color tables: remembering widths', () => {
  beforeEach(() => {
    localStorage.clear();
    mountProductionForm();
  });

  function buildMatrix() {
    App.Production.addMatrixColorColumn('Blue-White');
    App.Production.addMatrixItemRow({ itemName: 'Sticker', size: 'L', sourceType: 'ITEM' });
    giveTableRoom(matrixTable());
    App.Production._layoutMatrixTable();
  }

  test('a dragged width survives the form being rebuilt for the next lot', () => {
    buildMatrix();
    dragHandle('item', 175);
    const dragged = widths().item;

    // Same browser, next lot: fresh DOM, fresh App.Production, same
    // localStorage.
    mountProductionForm();
    buildMatrix();

    expect(widths().item).toBe(dragged);
  });

  test('an unreadable stored value is ignored rather than thrown', () => {
    localStorage.setItem(App.Production.PROD_COL_WIDTH_STORE_KEY, '{not json');
    mountProductionForm();

    expect(() => buildMatrix()).not.toThrow();
    expect(widths().item).toBeGreaterThan(0);
  });

  test('"Reset column widths" drops them and fits again', () => {
    buildMatrix();
    const fitted = widths().item;
    dragHandle('item', 200);
    expect(widths().item).not.toBe(fitted);

    App.Production.resetMatrixColumnWidths();

    expect(widths().item).toBe(fitted);
    expect(App.Production._colWidthStore().matrix).toBeUndefined();
  });

  test('a pool table keeps its own widths, separate from the matrix', () => {
    buildMatrix();
    dragHandle('item', 150);

    // One pool table, built the way _buildPoolColorGroupTable builds it:
    // same class and column order, its own data-width-scope.
    const container = document.getElementById('productionPoolColorGroupsContainer');
    container.innerHTML = `
      <div class="table-responsive">
        <table class="table prod-color-table" id="productionPoolColorGroup_1" data-width-scope="pool:frame">
          <thead><tr>
            <th></th><th>Item / Pool Name</th><th>Size</th><th>Narration</th><th>Source</th>
            <th data-color="Blue-White">Blue-White</th><th class="text-center">✕</th>
          </tr></thead>
          <tbody><tr><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr></tbody>
        </table>
      </div>`;
    const poolTable = document.getElementById('productionPoolColorGroup_1');
    giveTableRoom(poolTable);
    App.Production._layoutPoolTables();

    const poolItemWidth = parseFloat(poolTable.querySelectorAll('thead th')[1].style.width);
    expect(poolItemWidth).not.toBe(widths().item);

    // And resetting one section leaves the other alone.
    App.Production.resetPoolColumnWidths();
    expect(App.Production._colWidthStore().matrix).toBeDefined();
  });
});

describe('Per-Color Components: redundant colour columns on a reopened lot', () => {
  beforeEach(() => {
    localStorage.clear();
    mountProductionForm();
  });

  // The checklist the pruning reads: a primary composite row, plus the
  // non-primary single-colour row it auto-checked. That pair is what makes
  // "Blue" redundant beside "BLUE-WHITE / BLACK".
  function checkColour(color, { primary, qty = '10' }) {
    const checklist = document.getElementById('productionColorChecklist');
    checklist.insertAdjacentHTML('beforeend', App.Production._colorRowHtml(color, 'g1', false, primary));
    const row = Array.from(checklist.querySelectorAll('.production-color-row')).pop();
    row.querySelector('.production-color-check').checked = true;
    const qtyInput = row.querySelector('.production-color-qty');
    qtyInput.disabled = false;
    qtyInput.value = qty;
    App.Production.addMatrixColorColumn(color);
    return row;
  }

  test('an empty duplicate column is pruned; the composite it duplicates stays', () => {
    checkColour('BLUE-WHITE / BLACK', { primary: true });
    checkColour('Blue', { primary: false });
    const row = App.Production.addMatrixItemRow({ itemName: 'Sticker', size: 'L', sourceType: 'ITEM' });
    row.children[App.Production.getMatrixColumnIndex('BLUE-WHITE / BLACK')]
      .querySelector('.matrix-qty').value = '10';
    App.Production._refreshMatrixColumns();

    expect(App.Production.getMatrixColumnIndex('Blue')).not.toBe(-1);

    App.Production._pruneRedundantMatrixColumns({ emptyOnly: true });

    expect(App.Production.getMatrixColumnIndex('Blue')).toBe(-1);
    expect(App.Production.getMatrixColumnIndex('BLUE-WHITE / BLACK')).not.toBe(-1);
    // The row shrank with the header -- cells are addressed by position.
    expect(row.children.length).toBe(headerRow().children.length);
  });

  test('a duplicate column holding a SAVED quantity is left alone on load', () => {
    checkColour('BLUE-WHITE / BLACK', { primary: true });
    checkColour('Blue', { primary: false });
    const row = App.Production.addMatrixItemRow({ itemName: 'Sticker', size: 'L', sourceType: 'ITEM' });
    row.children[App.Production.getMatrixColumnIndex('Blue')].querySelector('.matrix-qty').value = '4';
    App.Production._refreshMatrixColumns();

    App.Production._pruneRedundantMatrixColumns({ emptyOnly: true });

    // Silently dropping it would silently change what the lot saves.
    expect(App.Production.getMatrixColumnIndex('Blue')).not.toBe(-1);
    expect(App.Production.serializeColorMatrix()).toEqual(
      expect.arrayContaining([expect.objectContaining({ colorGroup: 'Blue', qty: 4 })]));
  });

  test('the operator toggling colours still prunes a populated duplicate', () => {
    // Unchanged behaviour: mid-edit, a redundant column double-debits, so
    // it goes whatever is in it.
    checkColour('BLUE-WHITE / BLACK', { primary: true });
    checkColour('Blue', { primary: false });
    const row = App.Production.addMatrixItemRow({ itemName: 'Sticker', size: 'L', sourceType: 'ITEM' });
    row.children[App.Production.getMatrixColumnIndex('Blue')].querySelector('.matrix-qty').value = '4';
    App.Production._refreshMatrixColumns();

    App.Production._pruneRedundantMatrixColumns();

    expect(App.Production.getMatrixColumnIndex('Blue')).toBe(-1);
  });
});

describe('Per-color tables: fitting a wide lot', () => {
  beforeEach(() => {
    localStorage.clear();
    mountProductionForm();
  });

  test('twelve columns fit the form instead of overflowing it', () => {
    // The reported shape: six empty strips beside six composite columns.
    ['Blue', 'Orange', 'Pink', 'Purple', 'Red', 'SeaGreen'].forEach(c => App.Production.addMatrixColorColumn(c));
    const composites = ['BLUE-WHITE / BLACK', 'ORANGE-WHITE / BLACK', 'PINK-WHITE / BLACK',
      'PURPLE-WHITE / BLACK', 'RED-WHITE / BLACK', 'SEAGREEN-WHITE / BLACK'];
    composites.forEach(c => App.Production.addMatrixColorColumn(c));
    const row = App.Production.addMergedMatrixRow({ itemName: 'Maharaja SEAT WHITE', size: 'GENERAL', sourceType: 'ITEM' });
    composites.forEach(c => {
      row.children[App.Production.getMatrixColumnIndex(c)].querySelector('.matrix-qty').value = '10';
    });
    App.Production._refreshMatrixColumns();

    giveTableRoom(matrixTable(), 1708);
    App.Production._layoutMatrixTable();

    // Every column is laid out, and together they fit the width on offer --
    // rounding included, which is what used to raise a scrollbar on a table
    // meant to fit exactly.
    const total = Array.from(headerRow().children)
      .reduce((sum, th) => sum + parseFloat(th.style.width), 0);
    expect(total).toBeLessThanOrEqual(fitTarget(1708));
    expect(parseFloat(matrixTable().style.width)).toBe(total);
    expect(widths()['c:Blue']).toBe(App.Production.PROD_COL_SPECS.colorCollapsed.pref);
  });

  test('a lot too wide to fit is left scrollable rather than crushed below its minimums', () => {
    for (let i = 0; i < 20; i++) {
      App.Production.addMatrixColorColumn(`Colour ${i}`);
    }
    const row = App.Production.addMatrixItemRow({ itemName: 'Sticker', size: 'L', sourceType: 'ITEM' });
    Array.from({ length: 20 }, (_, i) => `Colour ${i}`).forEach(c => {
      row.children[App.Production.getMatrixColumnIndex(c)].querySelector('.matrix-qty').value = '1';
    });
    App.Production._refreshMatrixColumns();

    giveTableRoom(matrixTable(), 900);
    App.Production._layoutMatrixTable();

    Array.from(headerRow().children).forEach((th, i, all) => {
      const key = App.Production._colKeyAt(th, i, all.length - 1);
      expect(parseFloat(th.style.width)).toBeGreaterThanOrEqual(App.Production._colSpecFor(th, key).min);
    });
    expect(parseFloat(matrixTable().style.width)).toBeGreaterThan(900);
  });
});
