/**
 * Regression tests for the quantity a NON-PRIMARY colour axis row is filled
 * with when the operator checks it (../production.js, _nonPrimaryFillQty).
 *
 * The bug: a lot of 42 frames across six primary colours, all built on Black
 * rims, filled the rim axis's "Black" with 7 instead of 42. Nothing looked
 * broken -- 7 is a plausible number -- but the lot then recorded a seventh of
 * the rims it actually consumed.
 *
 * The cause was _colorNamesMatch doing what it was designed to do: it matches
 * a colour against either half of a composite ("White" pairs with the
 * "Blue-White" frames), and that same rule made "Black" pair with the
 * "Red-Black" frame colour and inherit its 7. The pairing itself is correct
 * for an axis genuinely produced one variant per primary colour; it is wrong
 * for an axis carrying a single colour, which is on every unit in the lot.
 * So the count of checked colours on the row's own axis is what decides, and
 * that count changes as the operator works -- which is why these also pin the
 * re-evaluation in both directions.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const PARTIAL = path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', 'production.html');

const FRAME_AXIS = 'pool:painted frame crysta 14 inch d/gaddi';
const RIM_AXIS = 'pool:fitted rim 14 inch';

function loadProductionAsGlobal() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'production.js'), 'utf8');
  // eslint-disable-next-line no-eval
  eval(code);
}

const rowFor = color => Array.from(document.querySelectorAll('#productionColorChecklist .production-color-row'))
  .find(r => r.dataset.color === color);

const qtyOf = color => rowFor(color).querySelector('.production-color-qty').value;

// Checks a colour the way the operator does -- through the real change
// handler, since that is what decides the fill.
async function check(color) {
  const chk = rowFor(color).querySelector('.production-color-check');
  chk.checked = true;
  await App.Production.handleColorCheckToggle(chk);
}

async function uncheck(color) {
  const chk = rowFor(color).querySelector('.production-color-check');
  chk.checked = false;
  await App.Production.handleColorCheckToggle(chk);
}

// Types a quantity into an already-checked row, through the real input path.
function typeQty(color, value) {
  const input = rowFor(color).querySelector('.production-color-qty');
  input.value = String(value);
  App.Production.onColorQtyChanged(rowFor(color));
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

  // No process selected, so the matrix population that would need the recipe
  // endpoint is skipped; pool availability is a network round trip this
  // behaviour does not depend on.
  App.Production.refreshPoolAvailability = async () => {};

  // The lot from the report: six frame colours at 7 each = 42, on one rim.
  App.Production.renderColorChecklistRows(
    ['Blue-Sky Blue', 'Metallic Purple-Purple', 'Orange-White', 'Pink-White', 'Red-Black', 'SeaGreen-White'],
    FRAME_AXIS, false, true);
  App.Production.renderColorChecklistRows(['BCP', 'Black'], RIM_AXIS, false, false);
}

async function checkAllFramesAt7() {
  for (const c of ['Blue-Sky Blue', 'Metallic Purple-Purple', 'Orange-White', 'Pink-White', 'Red-Black', 'SeaGreen-White']) {
    await check(c);
    typeQty(c, 7);
  }
}

describe('A non-primary axis carrying ONE colour takes the whole lot total', () => {
  beforeEach(mount);

  test('Black gets the primary total, not the Red-Black frame it shares a word with', async () => {
    await checkAllFramesAt7();
    expect(App.Production._primaryColorAxisTotal()).toBe(42);

    await check('Black');

    // Was 7: _matchingPrimaryColorQty('Black') hit the "Red-Black" row via
    // _colorNamesMatch and returned before the total was ever considered.
    expect(qtyOf('Black')).toBe('42');
  });

  test('the pairing still applies once the axis really is split per colour', async () => {
    await checkAllFramesAt7();
    await check('Black');
    expect(qtyOf('Black')).toBe('42');

    // A second colour on the rim axis means it is no longer one rim for the
    // whole lot, so Black falls back to tracking the frame it matches.
    await check('BCP');

    expect(qtyOf('Black')).toBe('7');
  });

  test('and reverts to the total when the axis drops back to one colour', async () => {
    await checkAllFramesAt7();
    await check('Black');
    await check('BCP');
    expect(qtyOf('Black')).toBe('7');

    await uncheck('BCP');

    expect(qtyOf('Black')).toBe('42');
  });

  test('a later change to a primary quantity re-flows into the sole rim colour', async () => {
    await checkAllFramesAt7();
    await check('Black');
    expect(qtyOf('Black')).toBe('42');

    typeQty('Red-Black', 10);

    // 5 x 7 + 10. Pinned because onColorQtyChanged has its own copy of the
    // re-sync loop, and it has to agree with the one in the toggle path.
    expect(qtyOf('Black')).toBe('45');
  });

  test('a quantity the operator typed by hand is never overwritten', async () => {
    await checkAllFramesAt7();
    await check('Black');

    typeQty('Black', 100);
    // Any later toggle re-runs the fill over every auto-synced row; this one
    // is no longer auto-synced, so it must be left alone.
    await check('BCP');

    expect(qtyOf('Black')).toBe('100');
  });
});

// The second half of the same double-counting family: above, a non-primary
// row inherited the wrong figure; here it INFLATED a per-color component,
// because the same output item can be rendered as both the counting Color
// Group and a non-counting Sub-Group, putting the identical color name on
// two rows.
describe('A colour on both a counting and a non-counting axis', () => {
  const DUP_AXIS = 'pool:painted frame crysta 16 inch d/gaddi sub';

  const rowIn = (group, color) => Array.from(
    document.querySelectorAll('#productionColorChecklist .production-color-row'))
    .find(r => r.dataset.group === group && r.dataset.color === color);

  async function checkIn(group, color, qty) {
    const row = rowIn(group, color);
    const chk = row.querySelector('.production-color-check');
    chk.checked = true;
    await App.Production.handleColorCheckToggle(chk);
    const input = row.querySelector('.production-color-qty');
    input.value = String(qty);
    App.Production.onColorQtyChanged(row);
  }

  beforeEach(() => {
    mount();
    // The same colours again under a non-counting Sub-Group, exactly as the
    // reported lot rendered them.
    App.Production.renderColorChecklistRows(['Orange-White', 'Pink-White'], DUP_AXIS, false, false);
  });

  test('the colour counts the units produced, not the sum of both rows', async () => {
    await checkIn(FRAME_AXIS, 'Orange-White', 3);
    await checkIn(DUP_AXIS, 'Orange-White', 3);

    // Was 6 -- the Sub-Group row was summed in as though it were three more
    // units, so a per-color component at qtyPerUnit 1 asked for 6.
    expect(App.Production._totalQtyForColorName('Orange-White')).toBe(3);
    expect(App.Production._currentLotTotalQty()).toBe(3);
  });

  test('a per-color matrix cell scales by the counting quantity only', async () => {
    App.Production.addMatrixColorColumn('Orange-White');
    const matrixRow = App.Production.addMergedMatrixRow({ itemName: 'MEGWHEEL 2.80', size: '16 inch', sourceType: 'ITEM' });
    const cell = matrixRow.children[App.Production.getMatrixColumnIndex('Orange-White')];
    // qtyPerUnit 1, the figure the process recipe carries in the report.
    cell.querySelector('.matrix-qty').dataset.qtyPerUnit = '1';

    await checkIn(FRAME_AXIS, 'Orange-White', 3);
    await checkIn(DUP_AXIS, 'Orange-White', 3);

    expect(cell.querySelector('.matrix-qty').value).toBe('3');
  });

  test('two counting rows sharing a colour name are still summed', async () => {
    // The case the sum exists for: independent counting axes may legitimately
    // share a colour name, and those units really do add up.
    App.Production.renderColorChecklistRows(['Orange-White'], 'pool:second counting axis', false, true);

    await checkIn(FRAME_AXIS, 'Orange-White', 3);
    await checkIn('pool:second counting axis', 'Orange-White', 4);

    expect(App.Production._totalQtyForColorName('Orange-White')).toBe(7);
  });
});
