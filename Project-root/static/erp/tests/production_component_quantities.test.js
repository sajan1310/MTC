/**
 * The quantities in the Production Lot form's three component tables --
 * Common, Per-Color and Per-Process Pool -- and what happens to them as the
 * checklist above them changes (../production.js).
 *
 *   - A quantity the operator TYPES is what was actually used. Every
 *     checklist edit used to re-derive it from the recipe, silently putting
 *     the recipe figure back over it.
 *   - A per-colour or pool line left without the recipe row's unit, which the
 *     server reads as the item's base unit: a Dozen part was debited twelve
 *     times short. (The phone has always sent it.)
 *   - Reopening a lot rebuilt each saved line's rescale rate by exact colour
 *     name. A miss made the rate 0, so the next quantity edit zeroed the line
 *     and the save dropped it. And a line saved under one part of a composite
 *     colour was written in full into every column carrying that part, so
 *     saving the lot again untouched counted it once per column.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const PARTIAL = path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', 'production.html');
const FRAME_AXIS = 'pool:painted frame';

function loadProductionAsGlobal() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'production.js'), 'utf8');
  // eslint-disable-next-line no-eval
  eval(code);
}

function mount({ recipe = [], poolColors = new Map() } = {}) {
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
  global.Api = { call: async () => ({ success: true, data: [] }) };
  global.App = {
    State: { globalItems: [], globalColors: [], globalProcesses: [], globalProduction: [], globalStock: [] },
    Utils: {
      sameText: (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase(),
      sameColor(a, b) { return this.sameText(a, b); },
      isCommonColorGroup: g => String(g ?? '').trim().toUpperCase() === 'COMMON',
      showToast: () => {},
    },
  };
  loadProductionAsGlobal();
  const P = App.Production;
  P.refreshPoolAvailability = async () => {};
  P._fetchProcessComponents = async () => ({ success: true, data: recipe });
  P.getPoolColorAwareItemNames = async () => poolColors;
  P._customColorGroupOptions = [{ key: FRAME_AXIS, label: 'Painted Frame', isPrimary: true, source: 'pool' }];
  const sel = document.getElementById('productionProcessId');
  sel.innerHTML = '<option value="P1">P1</option>';
  sel.value = 'P1';
  // The checklist is showing, as populateColorChecklist leaves it for any
  // process with colours -- which is what switches the form off the plain
  // single-quantity field.
  document.getElementById('productionColorWrapper').style.display = '';
}

const rowFor = color => $$('#productionColorChecklist .production-color-row').find(r => r.dataset.color === color);

async function check(color, qty) {
  const row = rowFor(color);
  const chk = row.querySelector('.production-color-check');
  chk.checked = true;
  await App.Production.handleColorCheckToggle(chk);
  if (qty !== undefined) typeQty(color, qty);
}

function typeQty(color, qty) {
  const row = rowFor(color);
  row.querySelector('.production-color-qty').value = String(qty);
  App.Production.onColorQtyChanged(row);
}

// Types into a component quantity box the way a keyboard does: the value
// changes and an `input` event bubbles up from the box.
function typeInto(input, value) {
  input.value = String(value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

// A saved lot's checklist, as openEditModal restores it: rows checked and
// quantities set directly, without the toggle cascade.
function restoreChecklist(entries) {
  entries.forEach(({ color, qty }) => {
    const row = rowFor(color);
    row.querySelector('.production-color-check').checked = true;
    const input = row.querySelector('.production-color-qty');
    input.disabled = false;
    input.value = String(qty);
  });
}

const commonQty = () => document.querySelector('#productionComponentsBody tr .prod-comp-qty');
const matrixQty = color =>
  document.querySelector('#productionColorMatrixBody tr')
    ?.children[App.Production.getMatrixColumnIndex(color)]?.querySelector('.matrix-qty');
const poolQty = color => $$('#productionPoolColorGroupsContainer .pool-group-qty').find(i => i.dataset.color === color);

describe('A quantity typed by hand stays as typed', () => {
  test('in the Common Components table', async () => {
    mount();
    App.Production.renderColorChecklistRows(['Blue', 'Red'], FRAME_AXIS, false, true);
    App.Production.addComponentRow({ itemName: 'Screw', size: '', sourceType: 'ITEM', qty: 0, qtyPerUnit: 2 });
    await check('Blue', 10);
    expect(commonQty().value).toBe('20');

    typeInto(commonQty(), 23); // three screws lost to the floor
    await check('Red', 5);

    expect(commonQty().value).toBe('23');
    expect(commonQty().classList.contains('prod-qty-manual')).toBe(true);
  });

  test('and goes back to the recipe once emptied', async () => {
    mount();
    App.Production.renderColorChecklistRows(['Blue', 'Red'], FRAME_AXIS, false, true);
    App.Production.addComponentRow({ itemName: 'Screw', size: '', sourceType: 'ITEM', qty: 0, qtyPerUnit: 2 });
    await check('Blue', 10);
    typeInto(commonQty(), 23);
    await check('Red', 5);

    typeInto(commonQty(), '');
    commonQty().dispatchEvent(new Event('change', { bubbles: true }));

    expect(commonQty().value).toBe('30');
    expect(commonQty().classList.contains('prod-qty-manual')).toBe(false);
    // ...and follows the lot again from here.
    typeQty('Red', 10);
    expect(commonQty().value).toBe('40');
  });

  test('the same on a single-quantity lot', () => {
    mount();
    document.getElementById('productionColorWrapper').style.display = 'none';
    App.Production.addComponentRow({ itemName: 'Screw', size: '', sourceType: 'ITEM', qty: 0, qtyPerUnit: 2 });
    const lotQty = document.getElementById('productionQty');
    lotQty.value = '10';
    App.Production.refreshSuggestedComponentQty();
    expect(commonQty().value).toBe('20');

    typeInto(commonQty(), 23);
    lotQty.value = '12';
    App.Production.refreshSuggestedComponentQty();
    expect(commonQty().value).toBe('23');

    typeInto(commonQty(), '');
    commonQty().dispatchEvent(new Event('change', { bubbles: true }));
    expect(commonQty().value).toBe('24');
  });

  test('in the Per-Color Components table', async () => {
    mount({ recipe: [{ itemName: 'Paint Blue', size: '', sourceType: 'ITEM', colorGroup: 'Blue', qtyPerUnit: 0.1, unit: 'Kg' }] });
    App.Production.renderColorChecklistRows(['Blue'], FRAME_AXIS, false, true);
    await check('Blue', 10);
    expect(matrixQty('Blue').value).toBe('1');

    typeInto(matrixQty('Blue'), 1.3);
    typeQty('Blue', 12);

    expect(matrixQty('Blue').value).toBe('1.3');
  });

  test('in a Per-Process Pool Components table', async () => {
    mount();
    App.Production.renderColorChecklistRows(['Blue', 'Red'], FRAME_AXIS, false, true);
    App.Production._renderPoolColorGroups(
      [{ itemName: 'Painted Frame', size: '', sourceType: 'POOL', qtyPerUnit: 1 }],
      new Map([['painted frame', ['Blue', 'Red']]]), 'create');
    await check('Blue', 10);
    expect(poolQty('Blue').value).toBe('10');

    typeInto(poolQty('Blue'), 9);
    typeQty('Blue', 12);

    expect(poolQty('Blue').value).toBe('9');
  });

  test('a figure nobody typed still follows the lot', async () => {
    mount();
    App.Production.renderColorChecklistRows(['Blue'], FRAME_AXIS, false, true);
    App.Production.addComponentRow({ itemName: 'Screw', size: '', sourceType: 'ITEM', qty: 0, qtyPerUnit: 2 });
    await check('Blue', 10);
    typeQty('Blue', 15);
    expect(commonQty().value).toBe('30');
  });
});

describe('Per-colour and pool lines carry the recipe row\'s unit', () => {
  test('a per-colour line', async () => {
    mount({ recipe: [{ itemName: 'Spoke Blue', size: '', sourceType: 'ITEM', colorGroup: 'Blue', qtyPerUnit: 2, unit: 'Dozen' }] });
    App.Production.renderColorChecklistRows(['Blue'], FRAME_AXIS, false, true);
    await check('Blue', 10);

    const [line] = App.Production.serializeColorMatrix();
    expect(line.qty).toBe(20); // 20 DOZEN
    expect(line.unit).toBe('Dozen');
  });

  test('a pool line', async () => {
    mount();
    App.Production.renderColorChecklistRows(['Blue'], FRAME_AXIS, false, true);
    App.Production._renderPoolColorGroups(
      [{ itemName: 'Painted Frame', size: '', sourceType: 'POOL', qtyPerUnit: 1, unit: 'Nos' }],
      new Map([['painted frame', ['Blue', 'Red']]]), 'create');
    await check('Blue', 10);

    const [line] = App.Production.serializePoolColorGroups();
    expect(line.unit).toBe('Nos');
  });

  test('a line with no unit still goes out with none', async () => {
    mount({ recipe: [{ itemName: 'Frame Blue', size: '', sourceType: 'ITEM', colorGroup: 'Blue', qtyPerUnit: 1, unit: '' }] });
    App.Production.renderColorChecklistRows(['Blue'], FRAME_AXIS, false, true);
    await check('Blue', 10);

    expect(App.Production.serializeColorMatrix()[0].unit).toBe('');
  });
});

describe('Reopening a lot keeps its recorded lines', () => {
  test('a line whose rate cannot be worked out keeps its figure through a quantity edit', async () => {
    // A zero-output colour: nothing to divide the saved paint by. The rate
    // used to become 0, so the next edit zeroed the line and the save
    // dropped it.
    mount();
    App.Production.renderColorChecklistRows(['Blue', 'Red'], FRAME_AXIS, false, true);
    const breakdown = [
      { color: 'Blue', qty: 0, countsTowardTotal: true, axisKey: FRAME_AXIS },
      { color: 'Red', qty: 10, countsTowardTotal: true, axisKey: FRAME_AXIS },
    ];
    restoreChecklist(breakdown);
    await App.Production.populateComponentsConsumedDirect([
      { itemName: 'Paint Blue', size: '', sourceType: 'ITEM', colorGroup: 'Blue', qty: 0.5 },
      { itemName: 'Paint Red', size: '', sourceType: 'ITEM', colorGroup: 'Red', qty: 1 },
    ], breakdown);

    typeQty('Blue', 4);

    const lines = App.Production.serializeColorMatrix();
    expect(lines.find(l => l.itemName === 'Paint Blue')?.qty).toBe(0.5);
    expect(lines.find(l => l.itemName === 'Paint Red')?.qty).toBe(1);
  });

  test('a pool line saved under one part of a composite colour rescales instead of zeroing', async () => {
    mount();
    App.Production.renderColorChecklistRows(['Blue-White / BCP'], FRAME_AXIS, false, true);
    const breakdown = [{ color: 'Blue-White / BCP', qty: 10, countsTowardTotal: true, axisKey: FRAME_AXIS }];
    restoreChecklist(breakdown);
    App.Production.getPoolColorAwareItemNames = async () => new Map([['painted frame', ['Blue-White', 'Red-White']]]);
    await App.Production.populateComponentsConsumedDirect([
      { itemName: 'Painted Frame', size: '', sourceType: 'POOL', colorGroup: 'Blue-White', qty: 10 },
    ], breakdown);
    expect(poolQty('Blue-White').value).toBe('10');

    typeQty('Blue-White / BCP', 12);

    const [line] = App.Production.serializePoolColorGroups();
    expect(line.qty).toBe(12); // was 0, then dropped
  });

  test('a line saved under one part of two composite colours is shared, not duplicated', async () => {
    mount();
    App.Production.renderColorChecklistRows(['Blue-White / BCP', 'Pink-White / BCP'], FRAME_AXIS, false, true);
    const breakdown = [
      { color: 'Blue-White / BCP', qty: 10, countsTowardTotal: true, axisKey: FRAME_AXIS },
      { color: 'Pink-White / BCP', qty: 4, countsTowardTotal: true, axisKey: FRAME_AXIS },
    ];
    restoreChecklist(breakdown);
    await App.Production.populateComponentsConsumedDirect([
      { itemName: 'Rim BCP', size: '26 inch', sourceType: 'ITEM', colorGroup: 'BCP', qty: 28 },
    ], breakdown);

    const lines = App.Production.serializeColorMatrix().filter(l => l.itemName === 'Rim BCP');
    // Was 28 + 28: the whole line written into each BCP column.
    expect(lines.map(l => [l.colorGroup, l.qty])).toEqual([['Blue-White / BCP', 20], ['Pink-White / BCP', 8]]);
  });

  describe('a colour name on two axes (a Purple frame and a Purple rim)', () => {
    const RIM_AXIS = 'tag:rim color';
    const rowIn = (group, color) => $$('#productionColorChecklist .production-color-row')
      .find(r => r.dataset.group === group && r.dataset.color === color);

    async function reopenPurple(savedLines) {
      mount();
      App.Production.renderColorChecklistRows(['Purple'], FRAME_AXIS, false, true);
      App.Production.renderColorChecklistRows(['Purple'], RIM_AXIS, false, false);
      // The rim entry first, as a recipe listing the rim above the frame
      // would order it.
      const breakdown = [
        { color: 'Purple', qty: 20, countsTowardTotal: false, axisKey: RIM_AXIS },
        { color: 'Purple', qty: 10, countsTowardTotal: true, axisKey: FRAME_AXIS },
      ];
      breakdown.forEach(({ axisKey, qty }) => {
        const row = rowIn(axisKey, 'Purple');
        row.querySelector('.production-color-check').checked = true;
        row.querySelector('.production-color-qty').disabled = false;
        row.querySelector('.production-color-qty').value = String(qty);
      });
      await App.Production.populateComponentsConsumedDirect(savedLines, breakdown);
    }

    test('its one shared column gets the whole saved line, not half of it', async () => {
      await reopenPurple([{ itemName: 'Paint Purple', size: '', sourceType: 'ITEM', colorGroup: 'Purple', qty: 1 }]);
      expect(App.Production.serializeColorMatrix().map(l => [l.colorGroup, l.qty])).toEqual([['Purple', 1]]);
    });

    test('its parts rescale by the counting (frame) quantity, not the rim\'s', async () => {
      await reopenPurple([{ itemName: 'Paint Purple', size: '', sourceType: 'ITEM', colorGroup: 'Purple', qty: 1 }]);
      const frameRow = rowIn(FRAME_AXIS, 'Purple');
      frameRow.querySelector('.production-color-qty').value = '12';
      App.Production.onColorQtyChanged(frameRow);

      // 1 per 10 frames, now 12 frames. Divided by the rim's 20 it was 0.6.
      expect(App.Production.serializeColorMatrix()[0].qty).toBe(1.2);
    });
  });

  test('each line goes back out with the unit it was saved with -- or with none', async () => {
    mount({ recipe: [{ itemName: 'Paint Blue', size: '', sourceType: 'ITEM', colorGroup: 'Blue', qtyPerUnit: 0.1, unit: 'Kg' }] });
    App.Production.renderColorChecklistRows(['Blue', 'Red'], FRAME_AXIS, false, true);
    const breakdown = [
      { color: 'Blue', qty: 10, countsTowardTotal: true, axisKey: FRAME_AXIS },
      { color: 'Red', qty: 10, countsTowardTotal: true, axisKey: FRAME_AXIS },
    ];
    restoreChecklist(breakdown);
    await App.Production.populateComponentsConsumedDirect([
      // Logged on the phone, which has always kept the unit.
      { itemName: 'Paint Red', size: '', sourceType: 'ITEM', colorGroup: 'Red', qty: 1, unit: 'Kg' },
      // Logged at a desk before desktop kept it: re-saving must not reinterpret it.
      { itemName: 'Paint Blue', size: '', sourceType: 'ITEM', colorGroup: 'Blue', qty: 1 },
    ], breakdown);

    const unitOf = name => App.Production.serializeColorMatrix().find(l => l.itemName === name).unit;
    expect(unitOf('Paint Red')).toBe('Kg');
    expect(unitOf('Paint Blue')).toBe('');
  });
});
