/**
 * The Production Lot form's component item picker, against the REAL
 * jQuery + Select2 the app ships (static/erp/vendor/).
 *
 * Every other suite here stubs the DOM but leaves `window.jQuery`
 * undefined, so `_wireItemSelect2` hits its own
 * `if (!selectEl || !window.jQuery?.fn?.select2) return;` guard and does
 * nothing. That guard is correct -- a missing library must not throw -- but
 * it means the entire picker (its ajax transport, its ITEM/POOL branch, its
 * select2:select handler, and the dataset the save path reads back out of
 * the chosen <option>) had NO coverage at all: the dropdown could be
 * completely dead in a browser with all 854 other tests passing.
 *
 * These load the two vendored libraries the same way index.html does --
 * jQuery first, then Select2 -- by taking each UMD wrapper's browser-global
 * branch (module/exports passed as undefined), so a version bump that
 * breaks the pairing fails here rather than on the factory floor.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Every test here parses and runs the real jQuery and Select2 bundles, then
// drives Select2's own search/render cycle. That is integration-weight work
// on jest's 5s default: idle it is comfortable, but on a loaded box (a full
// run oversubscribed past the core count) it crosses the budget and fails as
// a timeout, which reads as a broken picker rather than a slow one. Nothing
// here is racing -- the waits below are for Select2's own rendering, and
// they are bounded.
jest.setTimeout(30000);

const VENDOR = path.join(__dirname, '..', 'vendor');
const PARTIAL = path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', 'production.html');
const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function loadVendorLibs() {
  const jq = fs.readFileSync(path.join(VENDOR, 'jquery-3.6.0.min.js'), 'utf8');
  new Function('window', 'document', 'module', 'exports', jq)(window, document, undefined, undefined);
  const s2 = fs.readFileSync(path.join(VENDOR, 'select2-4.1.0.min.js'), 'utf8');
  new Function('window', 'document', 'jQuery', 'module', 'exports', 'define', s2)(
    window, document, window.jQuery, undefined, undefined, undefined);
}

function installGlobals() {
  global.escapeHtml = v => String(v).replace(/[&<>"']/g, c => HTML_ESCAPE_MAP[c]);
  global.toNumber = (v, f = 0) => (Number.isFinite(Number(v)) ? Number(v) : f);
  global.$ = (s, r = document) => r.querySelector(s);
  global.$$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  global.formatCurrency = v => `Rs.${Number(v).toFixed(2)}`;
  global.todayIso = () => '2026-01-01';
  global.parseRecordDate = () => 0;
  global.App = {
    State: {
      globalItems: [
        { name: 'Bolt M6', size: '6mm', unit: 'Pcs' },
        { name: 'Nut M6', size: '6mm', unit: 'Pcs' },
        { name: 'Washer', size: '', unit: 'Pcs' },
      ],
      globalColors: [], globalProcesses: [], globalProduction: [], globalStock: [],
      filteredProduction: [], selectedProduction: [], productionCurrentPage: 1, productionRowsPerPage: 25,
    },
    Utils: {
      sameText: (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase(),
      isCommonColorGroup: g => String(g ?? '').trim().toUpperCase() === 'COMMON',
      matchesKeywords: (h, t) => String(h).toLowerCase().includes(String(t).toLowerCase()),
      formatNameCase: v => String(v ?? ''), getSizeFromOutputItemName: () => 'General',
      getModelFromOutputItemName: () => 'General', PROCESS_SIZE_LIST: ['General'],
      autoSelectOnlyOption: () => {}, select2DropdownParent: () => null, select2Matcher: () => null,
      setFormButtonsForMode: () => {}, renderPagination: () => {}, showToast: () => {},
      tableLoading: () => {}, tableError: () => {}, confirmAction: (_m, f) => f(),
    },
    Selection: { isSelected: () => false, updateButton: () => {} },
    Nav: { register: () => {}, clear: () => {} },
    Process: { getDistinctOutputItemNames: () => ['Fitted Rim', 'Painted Frame'] },
    Item: { ensureLoaded: async () => {} },
  };
}

function openPicker(row) {
  const $sel = window.jQuery(row.querySelector('.prod-comp-item-select'));
  $sel.select2('open');
  return Array.from(document.querySelectorAll('.select2-results__option')).map(o => o.textContent);
}

describe('component item picker (real Select2)', () => {
  beforeEach(() => {
    document.body.innerHTML = fs.readFileSync(PARTIAL, 'utf8');
    loadVendorLibs();
    installGlobals();
    // eslint-disable-next-line no-eval
    eval(fs.readFileSync(path.join(__dirname, '..', 'production.js'), 'utf8'));
  });

  test('the vendored libraries pair up the way index.html loads them', () => {
    expect(typeof window.jQuery).toBe('function');
    expect(typeof window.jQuery.fn.select2).toBe('function');
  });

  test('a new row gets a live Select2, not a bare <select>', () => {
    App.Production.addComponentRow(null);
    const sel = document.querySelector('#productionComponentsBody .prod-comp-item-select');
    expect(window.jQuery(sel).data('select2')).toBeTruthy();
  });

  test('an ITEM row lists Items Master', () => {
    App.Production.addComponentRow(null);
    const row = document.querySelector('#productionComponentsBody tr');
    expect(openPicker(row)).toEqual(['Bolt M6 [6mm]', 'Nut M6 [6mm]', 'Washer']);
  });

  test('a POOL row lists pool BUCKETS, colour and all, once they are cached', () => {
    App.Production._poolBuckets = [
      { name: 'Fitted Rim', size: '14', color: 'Black' },
      { name: 'Fitted Rim', size: '14', color: 'Red' },
    ];
    App.Production.addComponentRow(null);
    const row = document.querySelector('#productionComponentsBody tr');
    row.querySelector('.prod-comp-source').value = 'POOL';
    const listed = openPicker(row);
    expect(listed).toHaveLength(2);
    expect(listed[0]).toContain('Black');
    expect(listed[1]).toContain('Red');
  });

  // The picker must never come up empty just because the pool cache has not
  // been filled yet -- see the fallback in _wireItemSelect2's transport.
  test('a POOL row falls back to process output names before the cache fills', () => {
    App.Production.addComponentRow(null);
    const row = document.querySelector('#productionComponentsBody tr');
    row.querySelector('.prod-comp-source').value = 'POOL';
    expect(openPicker(row)).toEqual(['Fitted Rim', 'Painted Frame']);
  });

  // What the save path actually reads: serializeColorMatrix and
  // _readProdComponentRow take the item name off the chosen <option>'s
  // dataset, not off its visible label.
  test('choosing an item records its name on the option and autofills size', () => {
    App.Production.addComponentRow(null);
    const row = document.querySelector('#productionComponentsBody tr');
    const sel = row.querySelector('.prod-comp-item-select');
    window.jQuery(sel).select2('open');
    window.jQuery('.select2-results__option').eq(1).trigger('mouseup');

    expect(sel.options[sel.selectedIndex].dataset.name).toBe('Nut M6');
    expect(row.querySelector('.prod-comp-size').value).toBe('6mm');
  });

  // Typing an item EXACTLY as the list displays it used to select a
  // freshly-invented tag instead of that item.
  //
  // matchesKeywords splits on whitespace and requires every token, so the
  // label's own brackets ("[14" / "inch]") -- absent from the searched
  // fields -- matched nothing. Select2's `tags: true` then offered the typed
  // text as a NEW item, and because its label is character-identical to the
  // real one, the row looked correct: same text, same everything on screen.
  // What it actually carried was `custom:` with the brackets baked into the
  // item NAME, so the lot saved a component naming an item that does not
  // exist, and its stock/pool debit had nowhere real to land.
  //
  // Asserting on the rendered text cannot catch this -- both options render
  // the same string, and Select2 de-dupes the tag against the match, so even
  // the result COUNT is 1 either way. Only the chosen option's value and
  // dataset.name (what _readProdComponentRow saves) tell them apart.
  async function typeAndPick(row, term) {
    const sel = row.querySelector('.prod-comp-item-select');
    window.jQuery(sel).select2('open');
    const search = document.querySelector('.select2-search__field');
    search.value = term;
    window.jQuery(search).trigger('input').trigger('keyup');
    await new Promise(r => setTimeout(r, 300));
    window.jQuery('.select2-results__option').eq(0).trigger('mouseup');
    return { value: sel.value, name: sel.options[sel.selectedIndex]?.dataset?.name };
  }

  test('picks the REAL item when typed exactly as displayed, not a new tag', async () => {
    App.State.globalItems = [
      { name: 'Chain Cover---WING---BLACK', size: '14 inch', unit: 'Pcs' },
      { name: 'CARTOON---S-D', size: '14 inch', unit: 'Pcs' },
    ];
    App.Production.addComponentRow(null);
    const row = document.querySelector('#productionComponentsBody tr');

    const picked = await typeAndPick(row, 'Chain Cover---WING---BLACK [14 inch]');

    expect(picked.value).toBe('item:0');
    expect(picked.value.startsWith('custom:')).toBe(false);
    expect(picked.name).toBe('Chain Cover---WING---BLACK');
  });

  test('a POOL bucket typed with its colour suffix resolves to the bucket', async () => {
    App.Production._poolBuckets = [{ name: 'Fitted Rim', size: '14 inch', color: 'Black' }];
    App.Production.addComponentRow(null);
    const row = document.querySelector('#productionComponentsBody tr');
    row.querySelector('.prod-comp-source').value = 'POOL';

    const picked = await typeAndPick(row, 'Fitted Rim [14 inch] · Black');

    expect(picked.value).toBe('pool:0');
    expect(picked.name).toBe('Fitted Rim');
  });
});
