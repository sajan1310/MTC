/**
 * Regression test for the Create/Edit Production Lot form's row
 * drag-and-sort column (App.Production._dragCellHtml/_initRowSorting in
 * ../production.js) and the editable Per-Process Pool Components Narration.
 *
 * Why this needs a test at all: the Per-Color Components matrix and the
 * Per-Process Pool Components tables address every per-color cell by its
 * POSITION among the header row's children (getMatrixColors /
 * getMatrixColumnIndex / syncPoolColorGroupColumns' indexOf). Adding a
 * leading grip column is only safe while the shift is uniform -- present in
 * the <thead> AND in every row-building template. Miss one and nothing
 * throws: quantities simply land in, and are read back from, the wrong
 * colour's cell. So these tests assert the invariant structurally (header
 * width == row width) and then end-to-end (a qty typed into the cell
 * getMatrixColumnIndex points at is the qty serializeColorMatrix reports
 * for that colour).
 *
 * Run against the REAL partial read off disk rather than a hand-written
 * fixture, same technique accessibility.test.js uses, so the header this
 * checks against can never drift from the one the app ships.
 *
 * window.Sortable is deliberately absent here (it is loaded by index.html's
 * only type="module" script). That is itself covered: _initRowSorting must
 * no-op rather than throw, and reordering is simulated with the same plain
 * DOM move Sortable performs.
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

// Widest row in a table -- a body row that has already had its colour cells
// added. Compared against the header to prove the uniform-shift invariant.
function cellCount(row) {
  return row.children.length;
}

describe('Production Lot form: row reorder column', () => {
  beforeEach(() => {
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
      State: { globalItems: [], globalColors: [], globalProcesses: [], globalProduction: [] },
      Utils: {
        sameText: (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase(),
        sameColor(a, b) { return this.sameText(a, b); },
        isCommonColorGroup: g => String(g ?? '').trim().toUpperCase() === 'COMMON',
      },
    };

    loadProductionAsGlobal();
  });

  test('Common Components rows match their header width and carry a grip', () => {
    App.Production.addComponentRow({ itemName: 'Bolt', size: 'M8', qty: 4, sourceType: 'ITEM' });

    const table = document.getElementById('productionComponentsBody').closest('table');
    const headerCells = table.querySelectorAll('thead tr th').length;
    const row = table.querySelector('tbody tr');

    expect(cellCount(row)).toBe(headerCells);
    expect(row.querySelector('.prod-drag-handle')).not.toBeNull();
    // The grip must be the FIRST cell -- every index-based reader assumes it.
    expect(row.children[0].classList.contains('prod-drag-cell')).toBe(true);
  });

  test('Per-Color matrix rows stay aligned with the header as colours are added', () => {
    App.Production.addMatrixItemRow({ itemName: 'Sticker', size: 'L', sourceType: 'ITEM' });
    App.Production.addMergedMatrixRow({ itemName: 'Frame', size: 'L', sourceType: 'ITEM' });
    App.Production.addMatrixColorColumn('Red');
    App.Production.addMatrixColorColumn('Blue');
    // A row added AFTER the columns exist must come out the same width as
    // one that was widened by addMatrixColorColumn.
    App.Production.addMatrixItemRow({ itemName: 'Seat', size: 'L', sourceType: 'ITEM' });

    const headerCells = document.getElementById('productionColorMatrixHeaderRow').children.length;
    const rows = Array.from(document.querySelectorAll('#productionColorMatrixBody tr'));

    expect(rows).toHaveLength(3);
    rows.forEach(row => {
      expect(cellCount(row)).toBe(headerCells);
      expect(row.children[0].classList.contains('prod-drag-cell')).toBe(true);
    });
  });

  test('a qty written at getMatrixColumnIndex is serialized against that colour', () => {
    App.State.globalItems = [{ name: 'Sticker', size: 'L', narration: '' }];
    App.Production.addMatrixColorColumn('Red');
    App.Production.addMatrixColorColumn('Blue');
    const row = App.Production.addMatrixItemRow({ itemName: 'Sticker', size: 'L', sourceType: 'ITEM' });

    // Exactly what onColorQtyChanged/_setItemRowColorQty do: locate the
    // column by name, then write into that positional cell.
    const blueIdx = App.Production.getMatrixColumnIndex('Blue');
    row.children[blueIdx].querySelector('.matrix-qty').value = '7';

    const serialized = App.Production.serializeColorMatrix();

    expect(serialized).toHaveLength(1);
    expect(serialized[0].colorGroup).toBe('Blue');
    expect(serialized[0].qty).toBe(7);
    expect(serialized[0].itemName).toBe('Sticker');
  });

  test('reordering rows reorders the serialized componentsConsumed', () => {
    App.Production.addComponentRow({ itemName: 'First', qty: 1, sourceType: 'ITEM' });
    App.Production.addComponentRow({ itemName: 'Second', qty: 2, sourceType: 'ITEM' });
    App.Production.addComponentRow({ itemName: 'Third', qty: 3, sourceType: 'ITEM' });

    expect(App.Production.serializeComponentsConsumed().map(c => c.itemName))
      .toEqual(['First', 'Second', 'Third']);

    // The plain DOM move SortableJS performs when a row is dragged to the top.
    const tbody = document.getElementById('productionComponentsBody');
    tbody.insertBefore(tbody.children[2], tbody.children[0]);

    expect(App.Production.serializeComponentsConsumed().map(c => c.itemName))
      .toEqual(['Third', 'First', 'Second']);
  });

  test('_initRowSorting is a no-op (not a throw) when SortableJS never loaded', () => {
    expect(window.Sortable).toBeUndefined();
    const tbody = document.getElementById('productionComponentsBody');
    expect(() => App.Production._initRowSorting(tbody)).not.toThrow();
    expect(tbody._prodRowSortable).toBeUndefined();
  });
});

/**
 * A sub-group that is NOT one of the process's Color Axes (a Kit Bag /
 * Small Kit Bag bucket, say) must be recorded per colour but must never add
 * to the lot's total quantity. It used to: the flat checklist render passed
 * no isPrimary, _colorRowHtml then wrote no data-primary attribute, and
 * getCheckedColorQtys reads a MISSING attribute as counting. The server
 * disagreed (save_production._is_primary_axis_row excludes any colour the
 * primary axis does not own), so the form's total and the saved qty drifted
 * apart.
 */
describe('Colors to Produce: non-axis sub-groups do not count toward the lot total', () => {
  beforeEach(() => {
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
      State: { globalItems: [], globalColors: [], globalProcesses: [], globalProduction: [] },
      Utils: {
        sameText: (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase(),
        sameColor(a, b) { return this.sameText(a, b); },
        isCommonColorGroup: g => String(g ?? '').trim().toUpperCase() === 'COMMON',
      },
    };
    loadProductionAsGlobal();
    App.Production._customColorGroupOptions = [];
  });

  function checkRow(color, qty) {
    const row = $$('#productionColorChecklist .production-color-row')
      .find(r => r.dataset.color === color);
    row.querySelector('.production-color-check').checked = true;
    const qtyInput = row.querySelector('.production-color-qty');
    qtyInput.disabled = false;
    qtyInput.value = String(qty);
    return row;
  }

  test('axis colours count, Kit Bag sub-group colours do not', () => {
    const checklistEl = document.getElementById('productionColorChecklist');
    const axis = { key: 'pool:painted frame', label: 'Painted Frame', source: 'pool', colors: ['Red', 'Blue'] };

    App.Production._renderAxisAndSubGroupChecklist(
      checklistEl, ['Red', 'Blue', 'Kit Bag', 'Small Kit Bag 24-26'], axis);

    checkRow('Red', 10);
    checkRow('Kit Bag', 10);
    checkRow('Small Kit Bag 24-26', 10);

    const checked = App.Production.getCheckedColorQtys();
    const byColor = Object.fromEntries(checked.map(c => [c.color, c]));

    expect(byColor['Red'].countsTowardTotal).toBe(true);
    expect(byColor['Kit Bag'].countsTowardTotal).toBe(false);
    expect(byColor['Small Kit Bag 24-26'].countsTowardTotal).toBe(false);

    // The whole point: 30 units are recorded, but the lot produced 10.
    expect(App.Production._currentLotTotalQty()).toBe(10);
  });

  test('axis rows carry the axis key so the server matches them by identity', () => {
    const checklistEl = document.getElementById('productionColorChecklist');
    const axis = { key: 'pool:painted frame', label: 'Painted Frame', source: 'pool', colors: ['Red'] };
    App.Production._renderAxisAndSubGroupChecklist(checklistEl, ['Red', 'Kit Bag'], axis);

    checkRow('Red', 5);
    checkRow('Kit Bag', 5);
    const byColor = Object.fromEntries(App.Production.getCheckedColorQtys().map(c => [c.color, c]));

    expect(byColor['Red'].axisKey).toBe('pool:painted frame');
    expect(byColor['Kit Bag'].axisKey).toBe('other');
  });

  test('operator-designated sub-groups survive a multi-axis process', () => {
    // The 2+-axis branch renders axis.colors; these are the leftovers it
    // used to discard -- an INCLUDE override the operator added on the
    // process, and a colour this process has actually produced before.
    // Neither can belong to a computed axis, so both must still be offered.
    const axes = [
      { key: 'pool:frame', label: 'Frame', source: 'pool', colors: ['Red', 'Blue'] },
      { key: 'tag:mudguard', label: 'Mudguard Color', source: 'tag', colors: ['Black'] },
    ];
    const known = ['Red', 'Blue', 'Black', 'Kit Bag', 'Small Kit Bag 24-26'];

    expect(App.Production._nonAxisSubGroupColors(known, axes))
      .toEqual(['Kit Bag', 'Small Kit Bag 24-26']);

    const checklistEl = document.getElementById('productionColorChecklist');
    App.Production._renderSubGroupBucket(checklistEl, App.Production._nonAxisSubGroupColors(known, axes));

    checkRow('Kit Bag', 8);
    const entry = App.Production.getCheckedColorQtys().find(c => c.color === 'Kit Bag');
    expect(entry.countsTowardTotal).toBe(false);
    expect(App.Production._currentLotTotalQty()).toBe(0);
  });

  test('axis colours are matched case-insensitively when finding leftovers', () => {
    const axes = [{ key: 'pool:frame', label: 'Frame', source: 'pool', colors: ['Blue-White / BCP'] }];
    expect(App.Production._nonAxisSubGroupColors(['blue-white / bcp', 'Kit Bag'], axes))
      .toEqual(['Kit Bag']);
  });

  test('every colour belonging to the axis: all count, and all carry the axis key', () => {
    const checklistEl = document.getElementById('productionColorChecklist');
    const axis = { key: 'pool:frame', label: 'Frame', source: 'pool', colors: ['Red', 'Blue'] };
    App.Production._renderAxisAndSubGroupChecklist(checklistEl, ['Red', 'Blue'], axis);

    checkRow('Red', 4);
    checkRow('Blue', 6);
    const checked = App.Production.getCheckedColorQtys();

    expect(checked.every(c => c.countsTowardTotal)).toBe(true);
    expect(checked.every(c => c.axisKey === 'pool:frame')).toBe(true);
    expect(App.Production._currentLotTotalQty()).toBe(10);
  });

  test('an axis owning none of the configured colours still counts nothing', () => {
    // The awkward shape: an axis exists, but no configured colour belongs
    // to it. Falling back to the flat render here would mark no row primary
    // at all -- which getCheckedColorQtys reads as counting -- putting every
    // sub-group straight back into the total. An axis existing is decisive.
    const checklistEl = document.getElementById('productionColorChecklist');
    const axis = { key: 'pool:frame', label: 'Frame', source: 'pool', colors: ['Teal'] };
    App.Production._renderAxisAndSubGroupChecklist(checklistEl, ['Kit Bag', 'Small Kit Bag 24-26'], axis);

    checkRow('Kit Bag', 5);
    checkRow('Small Kit Bag 24-26', 5);

    expect(App.Production.getCheckedColorQtys().every(c => c.countsTowardTotal === false)).toBe(true);
    expect(App.Production._currentLotTotalQty()).toBe(0);
  });

  test('custom colour filed into the Primary group counts; unfiled does not', () => {
    const checklistEl = document.getElementById('productionColorChecklist');
    const axis = { key: 'pool:frame', label: 'Frame', source: 'pool', colors: ['Red'] };
    App.Production._renderAxisAndSubGroupChecklist(checklistEl, ['Red', 'Kit Bag'], axis);

    // Rendering the sub-group bucket also registers it as a pickable
    // destination, so the operator has somewhere non-counting to file into.
    expect(App.Production._customColorGroupOptions.map(o => o.key)).toEqual(['pool:frame', 'other']);

    const input = document.getElementById('productionCustomColorInput');
    const picker = document.getElementById('productionCustomColorGroupSelect');
    App.Production._refreshCustomColorGroupSelect();
    expect(picker.style.display).not.toBe('none');

    // Filed into the Primary axis -> counts.
    input.innerHTML = '<option value="Special Red" selected>Special Red</option>';
    picker.value = 'pool:frame';
    App.Production.addCustomColorRow();

    // Left unfiled ("Independent extra color") -> does not count.
    input.innerHTML = '<option value="One-off Bag" selected>One-off Bag</option>';
    picker.value = '';
    App.Production.addCustomColorRow();

    const byColor = Object.fromEntries(App.Production.getCheckedColorQtys().map(c => [c.color, c]));
    expect(byColor['Special Red'].countsTowardTotal).toBe(true);
    expect(byColor['One-off Bag'].countsTowardTotal).toBe(false);
  });

  test('custom colour still counts on a process with no primary structure', () => {
    // "Add Colors to this Lot" on an axis-less process: every colour counts,
    // so a custom one must not be singled out as non-counting.
    App.Production.renderColorChecklistRows(['Red'], undefined, true);
    expect(App.Production._checklistHasPrimaryStructure()).toBe(false);

    document.getElementById('productionCustomColorInput').innerHTML =
      '<option value="Ad-hoc" selected>Ad-hoc</option>';
    App.Production.addCustomColorRow();

    const entry = App.Production.getCheckedColorQtys().find(c => c.color === 'Ad-hoc');
    expect(entry.countsTowardTotal).toBe(true);
  });

  test('the flat (everything counts) render is reserved for a process with no axis', () => {
    // The single exception to the rule: with no axis there is no
    // primary/secondary distinction to draw, and save_production's own
    // no-primary-axis branch totals every counted row the same way.
    const checklistEl = document.getElementById('productionColorChecklist');
    App.Production.renderColorChecklistRows(['Red', 'Kit Bag']);

    checkRow('Red', 3);
    checkRow('Kit Bag', 7);

    expect(App.Production.getCheckedColorQtys().every(c => c.countsTowardTotal)).toBe(true);
    expect(App.Production._currentLotTotalQty()).toBe(10);
    expect(checklistEl.querySelectorAll('.production-color-row')).toHaveLength(2);
  });
});

describe('Per-Process Pool Components table', () => {
  beforeEach(() => {
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
      State: { globalItems: [], globalColors: [], globalProcesses: [], globalProduction: [] },
      Utils: {
        sameText: (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase(),
        sameColor(a, b) { return this.sameText(a, b); },
        isCommonColorGroup: g => String(g ?? '').trim().toUpperCase() === 'COMMON',
      },
    };
    loadProductionAsGlobal();
  });

  function renderPoolTable() {
    const rows = [{
      itemName: 'Painted Frame', size: '', narration: 'From upstream paint line',
      sourceType: 'POOL', colorsQty: { red: 5, blue: 3 }, colorsQtyPerUnit: {}, qtyPerUnit: 1,
    }];
    document.getElementById('productionPoolColorGroupsContainer').innerHTML =
      App.Production._buildPoolColorGroupTable('poolT1', ['Red', 'Blue'], ['Red', 'Blue'], rows, 'edit', '');
    return document.getElementById('poolT1');
  }

  test('header and body rows agree on width, grip first', () => {
    const table = renderPoolTable();
    const headerCells = table.querySelectorAll('thead tr th').length;
    const row = table.querySelector('tbody tr');

    expect(cellCount(row)).toBe(headerCells);
    expect(row.children[0].classList.contains('prod-drag-cell')).toBe(true);
    expect(row.querySelector('.prod-drag-handle')).not.toBeNull();
  });

  test('Narration is editable and what is typed is what gets serialized', () => {
    const table = renderPoolTable();
    const narration = table.querySelector('.prod-comp-narration');

    expect(narration.hasAttribute('readonly')).toBe(false);
    // Size stays read-only -- it identifies the pool bucket, unlike Narration
    // which is only descriptive text for the printed sheet.
    expect(table.querySelector('.prod-comp-size').hasAttribute('readonly')).toBe(true);

    narration.value = 'Second coat, matte';
    const serialized = App.Production.serializePoolColorGroups();

    expect(serialized.length).toBeGreaterThan(0);
    serialized.forEach(c => expect(c.narration).toBe('Second coat, matte'));
  });
});
