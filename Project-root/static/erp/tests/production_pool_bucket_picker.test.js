/**
 * A POOL component row names the Warehouse Pool BUCKET it draws from
 * (../production.js), not just the item.
 *
 * The same physical Mudguard exists in the pool once per colour, and which
 * of those a lot draws on is what the debit lands on. The picker listed bare
 * item names, so the operator could not say -- and could not see that a
 * colour they wanted had nothing in it. The bucket now travels with the
 * picked option as `poolColor` and is serialized alongside `colorGroup`,
 * which keeps its own separate meaning: which of the LOT's output colours
 * consumed this.
 *
 * The blank case is pinned as hard as the new one. Every component ever
 * written lacks the field, and must serialize and attribute exactly as it
 * did before.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const PARTIAL = path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', 'production.html');

const POOL_ROWS = [
  { outputItemName: 'Mudguard 26', color: 'Blue', availableQty: 22, productTag: '' },
  { outputItemName: 'Mudguard 26', color: 'Red', availableQty: 0, productTag: '' },
  // Two rows for one bucket -- the cache sums them.
  { outputItemName: 'Mudguard 26', color: 'Blue', availableQty: 8, productTag: '' },
  // Tagged = finished output reserved to a product, not drawable WIP.
  { outputItemName: 'Packed Cycle', color: 'Blue', availableQty: 99, productTag: 'PRD-1' },
  // No colour = nothing to pick.
  { outputItemName: 'Loose Frame', color: '', availableQty: 5, productTag: '' },
];

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
    State: { globalItems: [], globalColors: [], globalProcesses: [], globalProduction: [], globalStock: [] },
    Utils: {
      sameText: (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase(),
      sameColor(a, b) { return this.sameText(a, b); },
      isCommonColorGroup: g => String(g ?? '').trim().toUpperCase() === 'COMMON',
      showToast: () => {},
    },
  };

  const code = fs.readFileSync(path.join(__dirname, '..', 'production.js'), 'utf8');
  // eslint-disable-next-line no-eval
  eval(code);
}

const buckets = () => App.Production._poolBuckets || [];

/** One matrix row with a single colour column, wired the way the form does. */
function matrixRowWithColumn(color, { sourceType = 'POOL', itemName = 'Mudguard 26', poolColor = '' } = {}) {
  App.Production.addMatrixColorColumn(color);
  App.Production.addMatrixItemRow({ itemName, size: '', narration: '', sourceType, poolColor });
  const row = document.querySelector('#productionColorMatrixBody tr');
  const select = row.querySelector('.prod-comp-item-select');
  select.value = select.options[select.options.length - 1].value;
  const idx = App.Production.getMatrixColumnIndex(color);
  row.children[idx].querySelector('.matrix-qty').value = '50';
  return row;
}

describe('The pool bucket cache', () => {
  beforeEach(() => {
    mount();
    App.Production._cachePoolBuckets({ success: true, data: POOL_ROWS });
  });

  test('one entry per live untagged bucket, quantities summed', () => {
    expect(buckets()).toEqual([
      { name: 'Mudguard 26', color: 'Blue', availableQty: 30 },
      { name: 'Mudguard 26', color: 'Red', availableQty: 0 },
    ]);
  });

  test('a bucket with nothing in it is still offered', () => {
    // Being able to SEE that Red is empty before picking it is the point;
    // hiding it just moves the surprise to the save.
    expect(buckets().find(b => b.color === 'Red').availableQty).toBe(0);
  });

  test('the label carries the colour and what is left in it', () => {
    expect(App.Production._poolBucketLabel({ name: 'Mudguard 26', color: 'Blue', availableQty: 30 }))
      .toBe('Mudguard 26 · Blue — 30 avail.');
  });

  test('the label does not use a second bracket, which already means size', () => {
    const label = App.Production._poolBucketLabel({ name: 'Mudguard 26', size: '26 inch', color: 'Blue', availableQty: 30 });
    expect(label).toBe('Mudguard 26 [26 inch] · Blue — 30 avail.');
    expect(label.match(/\[/g)).toHaveLength(1);
  });

  test('a failed fetch leaves the cache empty rather than throwing', () => {
    App.Production._cachePoolBuckets({ success: false });
    expect(buckets()).toEqual([]);
  });
});

describe('Serializing a per-colour POOL row', () => {
  beforeEach(() => mount());

  test('the bucket rides alongside the column colour, not instead of it', () => {
    matrixRowWithColumn('Purple-Wine', { poolColor: 'Blue' });

    const [component] = App.Production.serializeColorMatrix();
    // The whole point: consumed BY Purple-Wine, drawn FROM Blue.
    expect(component.colorGroup).toBe('Purple-Wine');
    expect(component.poolColor).toBe('Blue');
    expect(component.itemName).toBe('Mudguard 26');
  });

  test('a row with no bucket picked serializes blank, as it always has', () => {
    matrixRowWithColumn('Purple-Wine');

    const [component] = App.Production.serializeColorMatrix();
    expect(component.colorGroup).toBe('Purple-Wine');
    expect(component.poolColor).toBe('');
  });

  test('an ITEM row never carries a bucket', () => {
    matrixRowWithColumn('Purple-Wine', { sourceType: 'ITEM', itemName: 'Bolt', poolColor: 'Blue' });

    const [component] = App.Production.serializeColorMatrix();
    expect(component.sourceType).toBe('ITEM');
    expect(component.poolColor).toBe('');
  });
});

describe('Reopening a saved lot', () => {
  beforeEach(() => mount());

  // Without this the operator reopens a lot, changes nothing, presses Save,
  // and the consumption silently moves to a different pool bucket.
  test('the bucket survives a round trip with no edits', () => {
    matrixRowWithColumn('Purple-Wine', { poolColor: 'Blue' });
    const [saved] = App.Production.serializeColorMatrix();

    App.Production.clearColorMatrix();
    document.getElementById('productionColorMatrixHeaderRow')
      .querySelectorAll('th[data-color]').forEach(th => th.remove());
    matrixRowWithColumn(saved.colorGroup, { itemName: saved.itemName, poolColor: saved.poolColor });

    expect(App.Production.serializeColorMatrix()[0]).toMatchObject({
      itemName: 'Mudguard 26', colorGroup: 'Purple-Wine', poolColor: 'Blue',
    });
  });

  test('the restored option shows which bucket it is', () => {
    const html = App.Production._buildItemPreselectOption('Mudguard 26', '', 'POOL', 'Blue');
    expect(html).toContain('data-pool-color="Blue"');
    expect(html).toContain('Mudguard 26 · Blue');
  });

  test('a pool row saved before this field renders exactly as before', () => {
    const html = App.Production._buildItemPreselectOption('Mudguard 26', '', 'POOL');
    expect(html).not.toContain('data-pool-color');
    expect(html).toContain('>Mudguard 26</option>');
  });
});

describe('The Production Sheet names the bucket a pool cell came from', () => {
  beforeEach(() => mount());

  const renderSlot = (slot, colors) => {
    document.body.insertAdjacentHTML('beforeend', `<table><tbody id="t">${App.Production.renderMatrixSheetRow(slot, colors)}</tbody></table>`);
    return Array.from(document.querySelectorAll('#t .prod-sheet-color-tag'))
      .map(el => [el.dataset.color, el.textContent.trim()]);
  };

  test('a pool cell shows the bucket it was drawn from', () => {
    // Was blank: _cellItemTag subtracts the row label's words from the
    // cell's item name, and a pool item is named identically in every
    // column, so nothing survived -- the one row whose colour is not
    // evident from its name printed no tag at all.
    const tags = renderSlot({
      itemName: '14 inch Round Mudguard Painted Half',
      colors: { 'Purple-Wine': 10 },
      cellItems: { 'Purple-Wine': '14 inch Round Mudguard Painted Half' },
      cellPoolColors: { 'Purple-Wine': 'Blue' },
    }, ['Purple-Wine']);

    expect(tags).toEqual([['Purple-Wine', '(Blue)']]);
  });

  test('without a bucket it falls back to the derived tag, unchanged', () => {
    const tags = renderSlot({
      itemName: 'Teddy Basket',
      colors: { Blue: 10 },
      cellItems: { Blue: 'Teddy Basket Red' },
      cellPoolColors: {},
    }, ['Blue']);

    expect(tags).toEqual([['Blue', '(Red)']]);
  });

  test('a cell with neither still prints no tag', () => {
    const tags = renderSlot({
      itemName: 'Chain Cover',
      colors: { Blue: 10 },
      cellItems: { Blue: 'Chain Cover' },
      cellPoolColors: {},
    }, ['Blue']);

    expect(tags).toEqual([]);
  });

  test('the hover text says where the bucket came from', () => {
    renderSlot({
      itemName: 'Mudguard',
      colors: { 'Purple-Wine': 10 },
      cellItems: { 'Purple-Wine': 'Mudguard' },
      cellPoolColors: { 'Purple-Wine': 'Blue' },
    }, ['Purple-Wine']);

    expect(document.querySelector('#t .prod-sheet-color-tag').title)
      .toBe('Mudguard — Warehouse Pool colour: Blue');
  });
});
