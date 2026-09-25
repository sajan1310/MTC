/**
 * The cross-axis allocation grid (../production.js, refreshAllocationGrid).
 *
 * Modelled on the lot that motivated it: 4 frame colours at 10 each on a rim
 * axis split 24 BCP / 16 Black. Those numbers reconcile (40 = 40) but say
 * nothing about which frame got which rim -- a 4x2 grid with those margins has
 * 745 valid readings. The Warehouse Pool therefore refused to compose a
 * bucket name and credited ten bare single-colour buckets instead, inflating
 * 40 real frames into 120 pool units and putting colours like "BCP" into the
 * NEXT stage's Colours-to-Produce list, where picking one drives a real bucket
 * negative.
 *
 * The grid is where the operator records the pairing, since it exists nowhere
 * else. These pin when it appears, when it must NOT (a mirror axis is folded
 * away by the server, so allocating across it would collect numbers that go
 * nowhere), and that what it collects reaches the server on the lot.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const PARTIAL = path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', 'production.html');

const FRAME_AXIS = 'pool:painted frame starlight 16 inch d/gaddi';
const RIM_AXIS = 'pool:fitted rim 16 inch';
const MUDGUARD_AXIS = 'pool:16 inch round mudguard painted half';

const FRAMES = ['Blue-White', 'Orange-White', 'Pink-White', 'Red-White'];

function loadProductionAsGlobal() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'production.js'), 'utf8');
  // eslint-disable-next-line no-eval
  eval(code);
}

const rowFor = color => Array.from(document.querySelectorAll('#productionColorChecklist .production-color-row'))
  .find(r => r.dataset.color === color);

async function check(color, qty) {
  const chk = rowFor(color).querySelector('.production-color-check');
  chk.checked = true;
  await App.Production.handleColorCheckToggle(chk);
  if (qty !== undefined) {
    const input = rowFor(color).querySelector('.production-color-qty');
    input.value = String(qty);
    App.Production.onColorQtyChanged(rowFor(color));
  }
}

async function uncheck(color) {
  const chk = rowFor(color).querySelector('.production-color-check');
  chk.checked = false;
  await App.Production.handleColorCheckToggle(chk);
}

const gridVisible = () =>
  document.getElementById('productionAllocationWrapper').style.display !== 'none';

const columnHeaders = () =>
  Array.from(document.querySelectorAll('#productionAllocationTable thead th'))
    .slice(2, -1).map(th => th.textContent.trim());

const rowLabels = () =>
  Array.from(document.querySelectorAll('#productionAllocationTable tbody tr'))
    .map(tr => tr.dataset.primaryColor);

function cellInput(primary, column) {
  return Array.from(document.querySelectorAll('.production-allocation-cell'))
    .find(i => i.dataset.cellKey === `${primary}||${column}`);
}

function typeCell(primary, column, value) {
  const input = cellInput(primary, column);
  input.value = String(value);
  App.Production.onAllocationCellInput(input);
}

function mount() {
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
      showToast: () => {},
    },
  };

  loadProductionAsGlobal();
  App.Production.refreshPoolAvailability = async () => {};

  App.Production.renderColorChecklistRows(FRAMES, FRAME_AXIS, false, true);
  App.Production.renderColorChecklistRows(['BCP', 'Black'], RIM_AXIS, false, false);
  App.Production.renderColorChecklistRows(['Blue', 'Orange', 'Pink', 'Red'], MUDGUARD_AXIS, false, false);
}

async function checkAllFramesAt10() {
  for (const frame of FRAMES) await check(frame, 10);
}

describe('The allocation grid appears exactly when the pairing is unknowable', () => {
  beforeEach(mount);

  test('one rim colour for the whole lot needs no grid', async () => {
    await checkAllFramesAt10();
    await check('Black', 40);

    // Unambiguous: the one rim value pairs with every frame colour, and the
    // server composes "Blue-White / Black" on its own.
    expect(gridVisible()).toBe(false);
  });

  test('a second rim colour makes it appear, with a row per frame', async () => {
    await checkAllFramesAt10();
    await check('BCP', 24);
    await check('Black', 16);

    expect(gridVisible()).toBe(true);
    expect(rowLabels()).toEqual(FRAMES);
    expect(columnHeaders()).toEqual(['BCP', 'Black']);
  });

  test('a MIRROR axis does not trigger it', async () => {
    await checkAllFramesAt10();
    // The mudguard axis carries a partner for every frame colour, so it is
    // the frame axis restated -- the server folds it away rather than
    // crediting it, and there is nothing to allocate across.
    await check('Blue', 10);
    await check('Orange', 10);
    await check('Pink', 10);
    await check('Red', 10);

    expect(gridVisible()).toBe(false);
  });

  test('co-consumption is not a split and needs no grid', async () => {
    await checkAllFramesAt10();
    // Both rim values carry the WHOLE lot of 40 -- every frame took a BCP
    // AND a Black, which is co-consumption, not a division of the lot. The
    // 34 "Kit Bag / Small Kit" lots in the live data are all this shape, and
    // a grid here would demand a division that does not exist.
    await check('BCP', 40);
    await check('Black', 40);

    expect(gridVisible()).toBe(false);
  });

  test('it disappears again when the rim axis drops back to one colour', async () => {
    await checkAllFramesAt10();
    await check('BCP', 24);
    await check('Black', 16);
    expect(gridVisible()).toBe(true);

    await uncheck('BCP');
    expect(gridVisible()).toBe(false);
  });
});

describe('What the grid collects reaches the server on the lot', () => {
  beforeEach(mount);

  async function openGrid() {
    await checkAllFramesAt10();
    await check('BCP', 24);
    await check('Black', 16);
  }

  test('typed cells become splits on the primary entries', async () => {
    await openGrid();
    typeCell('Blue-White', 'BCP', 10);
    typeCell('Blue-White', 'Black', 0);
    typeCell('Orange-White', 'BCP', 10);
    typeCell('Orange-White', 'Black', 0);
    typeCell('Pink-White', 'BCP', 4);
    typeCell('Pink-White', 'Black', 6);
    typeCell('Red-White', 'BCP', 0);
    typeCell('Red-White', 'Black', 10);

    const breakdown = App.Production.getCheckedColorQtys();
    const pinkWhite = breakdown.find(c => c.color === 'Pink-White');
    expect(pinkWhite.splits).toEqual([
      { qty: 4, axes: { [RIM_AXIS]: 'BCP' } },
      { qty: 6, axes: { [RIM_AXIS]: 'Black' } },
    ]);

    // A non-primary entry never carries an allocation: a cell describes how
    // much of a PRIMARY colour used a given rim, so the same field on the rim
    // row would be describing a quantity that never counted toward the lot.
    expect(breakdown.find(c => c.color === 'BCP').splits).toBeUndefined();
  });

  test('an incomplete grid blocks the save, a complete one does not', async () => {
    await openGrid();
    expect(App.Production.allocationBlockingError()).toContain('Blue-White');

    for (const frame of FRAMES) {
      typeCell(frame, 'BCP', 10);
      typeCell(frame, 'Black', 0);
    }
    expect(App.Production.allocationBlockingError()).toBe('');

    // A row that adds up to the wrong total is caught the same way -- this is
    // the case that would otherwise credit the pool a different quantity than
    // the lot claims to have made.
    typeCell('Red-White', 'BCP', 3);
    expect(App.Production.allocationBlockingError()).toContain('Red-White');
  });

  test('typed cells survive a checklist edit that re-renders the grid', async () => {
    await openGrid();
    typeCell('Blue-White', 'BCP', 7);

    // Any checklist change rebuilds the grid; a rebuild that dropped what was
    // already typed would silently discard the operator's work.
    await check('Pink-White', 12);

    expect(cellInput('Blue-White', 'BCP').value).toBe('7');
  });

  test('a saved lot reopens with its allocation intact', async () => {
    await openGrid();
    App.Production.loadAllocationValues([
      {
        color: 'Pink-White',
        splits: [
          { qty: 4, axes: { [RIM_AXIS]: 'BCP' } },
          { qty: 6, axes: { [RIM_AXIS]: 'Black' } },
        ],
      },
    ]);
    App.Production.refreshAllocationGrid();

    expect(cellInput('Pink-White', 'BCP').value).toBe('4');
    expect(cellInput('Pink-White', 'Black').value).toBe('6');
  });
});

describe('Two split axes at once cannot be drawn as a grid', () => {
  beforeEach(mount);

  test('the operator is told to split the lot instead of shown a wrong grid', async () => {
    await checkAllFramesAt10();
    await check('BCP', 24);
    await check('Black', 16);
    // Checking the frames auto-checks every mudguard colour that matches one
    // (_syncMatchingNonPrimaryRows), which makes that axis a complete mirror.
    // Dropping two of them leaves an axis covering only SOME frames -- no
    // longer a restatement of the frame axis, so genuinely independent.
    await uncheck('Pink');
    await uncheck('Red');
    // Two independent axes each carrying 2+ values needs a cube, not a grid.
    await check('Blue', 20);
    await check('Orange', 20);

    expect(gridVisible()).toBe(true);
    expect(document.getElementById('productionAllocationTable').style.display).toBe('none');
    expect(document.getElementById('productionAllocationHelp').textContent)
      .toContain('split it into separate lots');
  });
});

// The save checks, and sends, an allocation for the checklist AS IT IS, not
// for whatever the grid was last drawn from. "Select all" and a Primary
// change did not redraw it, and the submit trusted the stale drawing: a lot
// that needed an allocation could save without one, and the Warehouse Pool
// then credited bare single-colour buckets.
describe('The grid follows every way the checklist changes', () => {
  const MIXED_FRAMES = ['Blue-White', 'Red-Black', 'Green'];

  function mountMixed() {
    mount();
    const list = document.getElementById('productionColorChecklist');
    list.innerHTML = '';
    App.Production.renderColorChecklistRows(MIXED_FRAMES, FRAME_AXIS, false, true);
    list.insertAdjacentHTML('beforeend', App.Production._buildColorGroupHeader(RIM_AXIS, 'Fitted Rim'));
    App.Production.renderColorChecklistRows(['White', 'Black'], RIM_AXIS, false, false);
  }

  test('"Select all" on a secondary group draws the grid, and the save waits for it', async () => {
    mountMixed();
    await check('Blue-White', 10);
    await check('Red-Black', 5);
    await check('Green', 7);
    // The frames ticked the rims they name; take them off again so "Select
    // all" is what puts two rim colours on the lot.
    await uncheck('White');
    await uncheck('Black');
    expect(gridVisible()).toBe(false);

    const master = document.querySelector(`[data-group-master="${RIM_AXIS}"]`);
    master.checked = true;
    await App.Production.toggleColorGroup(master, RIM_AXIS);

    expect(gridVisible()).toBe(true);
    expect(rowLabels()).toEqual(MIXED_FRAMES);
    expect(App.Production.allocationBlockingError()).toContain('Blue-White');
  });

  test('a Primary change redraws it for the new Primary, and the old grid no longer passes', async () => {
    mount();
    const list = document.getElementById('productionColorChecklist');
    list.innerHTML = '';
    const frames = { key: FRAME_AXIS, label: 'Painted Frame', colors: ['Blue-White', 'Pink-White'] };
    const rims = { key: RIM_AXIS, label: 'Fitted Rim', colors: ['BCP', 'Black'] };
    [frames, rims].forEach(axis => {
      list.insertAdjacentHTML('beforeend', App.Production._buildColorAxisGroupHeader(axis, axis === frames));
      App.Production.renderColorChecklistRows(axis.colors, axis.key, false, axis === frames);
    });
    await check('Blue-White', 20);
    await check('Pink-White', 20);
    await check('BCP', 24);
    await check('Black', 16);
    typeCell('Blue-White', 'BCP', 20);
    typeCell('Blue-White', 'Black', 0);
    typeCell('Pink-White', 'BCP', 4);
    typeCell('Pink-White', 'Black', 16);
    expect(App.Production.allocationBlockingError()).toBe('');

    const rimRadio = Array.from(document.querySelectorAll('input[name="productionPrimaryAxisPick"]'))
      .find(r => r.value === RIM_AXIS);
    rimRadio.checked = true;
    await App.Production.setPrimaryColorAxisChoice(rimRadio);

    // The rims now count, so they are the grid's rows and the frames its
    // columns -- and nothing has been allocated that way round yet.
    expect(rowLabels()).toEqual(['BCP', 'Black']);
    expect(columnHeaders()).toEqual(['Blue-White', 'Pink-White']);
    expect(App.Production.allocationBlockingError()).toContain('BCP');
    const bcp = App.Production.getCheckedColorQtys().find(c => c.color === 'BCP');
    expect(bcp.countsTowardTotal).toBe(true);
    expect(bcp.splits.map(s => s.axes[FRAME_AXIS])).toEqual(['Blue-White', 'Pink-White']);
  });

  test('a negative cell blocks the save even though its row adds up', async () => {
    mount();
    await checkAllFramesAt10();
    await check('BCP', 24);
    await check('Black', 16);
    for (const frame of FRAMES) {
      typeCell(frame, 'BCP', 10);
      typeCell(frame, 'Black', 0);
    }
    typeCell('Blue-White', 'BCP', -5);
    typeCell('Blue-White', 'Black', 15);

    expect(App.Production.allocationBlockingError()).toContain('negative');
    expect(document.getElementById('productionAllocationStatus').textContent).toContain('below zero');
  });

  test('a split axis that does not add up to the lot says so', async () => {
    mount();
    await checkAllFramesAt10();
    await check('BCP', 24);
    await check('Black', 12); // 36 against a lot of 40

    // innerText, as the help line is written: jsdom has no layout, so it does
    // not mirror innerText into textContent the way a browser does.
    const help = document.getElementById('productionAllocationHelp').innerText;
    expect(help).toContain('add up to 36');
    expect(help).toContain('the lot is 40');
  });
});
