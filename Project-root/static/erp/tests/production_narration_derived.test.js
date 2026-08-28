/**
 * Narration is a DERIVED projection of Items Master, not something an
 * operator types into a recipe or a lot (../production.js).
 *
 * The old model let it be typed AND stored AND used as row identity, and all
 * three worked against each other:
 *
 *  - Items Master's narration was deliberately emptied (the descriptions
 *    moved to Remarks so they would stop leaking into Process/Production),
 *    but _resolveDisplayNarration fell back to the stored copy whenever the
 *    master's was blank -- so 973 components kept displaying text nobody
 *    could reach or change.
 *  - serializeColorMatrix writes ONE narration per row, shared by every
 *    colour cell in it. A cell that had been misfiled inherited its host
 *    row's narration, and because narration was part of the row key it could
 *    then never be grouped back with its own siblings.
 *
 * A derived field cannot be identity, and cannot be typed. These pin both.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const PARTIAL = path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', 'production.html');

const ITEMS = [
  { name: 'Bolt', size: 'M8', narration: 'Hex head, zinc' },
  // Deliberately blank: the description now lives in the item's Remarks.
  { name: 'Washer', size: '', narration: '' },
];

function mount() {
  document.body.innerHTML = fs.readFileSync(PARTIAL, 'utf8');
  global.escapeHtml = v => String(v).replace(/[&<>"']/g, c => HTML_ESCAPE_MAP[c]);
  global.toNumber = (v, f = 0) => { const n = Number(v); return Number.isFinite(n) ? n : f; };
  global.$ = (s, r = document) => r.querySelector(s);
  global.$$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  global.formatCurrency = v => String(v); global.todayIso = () => ''; global.parseRecordDate = () => 0;
  global.App = {
    State: { globalItems: ITEMS, globalColors: [{ name: 'Blue' }, { name: 'Red' }], globalProcesses: [], globalProduction: [] },
    Utils: {
      sameText: (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase(),
      sameColor(a, b) { return this.sameText(a, b); },
      isCommonColorGroup: g => String(g ?? '').trim().toUpperCase() === 'COMMON',
      showToast() {},
    },
  };
  const code = fs.readFileSync(path.join(__dirname, '..', 'production.js'), 'utf8');
  // eslint-disable-next-line no-eval
  eval(code);
}

describe('Narration resolves live from Items Master', () => {
  beforeEach(() => mount());

  test('the live value wins over whatever was stored', () => {
    expect(App.Production._resolveDisplayNarration('Bolt', 'M8', 'stale text')).toBe('Hex head, zinc');
  });

  test('a deliberately blank master narration blanks the stored copy', () => {
    // Was: the blank was treated as "no information, keep what you have",
    // which is exactly what kept the old text alive after it had been
    // deliberately cleared from Items Master.
    expect(App.Production._resolveDisplayNarration('Washer', '', 'text from years ago')).toBe('');
  });

  test('an item Items Master has never heard of keeps its own text', () => {
    // A Warehouse Pool WIP item or an ad-hoc row -- nothing to derive from,
    // so the hand-written value is the only one there will ever be.
    expect(App.Production._resolveDisplayNarration('Painted Frame 26', '', 'Frame + Fork')).toBe('Frame + Fork');
  });
});

describe('Narration is not row identity', () => {
  beforeEach(() => mount());

  test('two cells of one item group together despite different narrations', () => {
    // The misfiled-cell shape: same item and size, but one cell inherited a
    // different row's narration. These are the same component.
    const rows = App.Production._reconstructPerColorRowsByName([
      { colorKey: 'Blue', itemName: 'Bolt', size: 'M8', narration: 'Hex head, zinc', unit: '', qty: 5 },
      { colorKey: 'Red', itemName: 'Bolt', size: 'M8', narration: 'PVC Seat 6" Piller', unit: '', qty: 5 },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].cells.map(c => c.colorKey)).toEqual(['Blue', 'Red']);
  });

  test('a genuinely different size still separates them', () => {
    const rows = App.Production._reconstructPerColorRowsByName([
      { colorKey: 'Blue', itemName: 'Bolt', size: 'M8', narration: '', unit: '', qty: 5 },
      { colorKey: 'Red', itemName: 'Bolt', size: 'M10', narration: '', unit: '', qty: 5 },
    ]);

    expect(rows).toHaveLength(2);
  });
});

describe('Narration is not an input on an ITEM row', () => {
  beforeEach(() => mount());

  test('an ITEM row renders it read-only', () => {
    expect(App.Production._narrationInputAttrs('ITEM')).toContain('readonly');
  });

  test('a POOL row keeps it editable', () => {
    // Its "item" is an upstream process's output, with no Items Master
    // entry to inherit from -- the typed description is the only one.
    expect(App.Production._narrationInputAttrs('POOL')).not.toContain('readonly');
  });

  test('flipping Source to Pool makes it editable, and back clears it', () => {
    App.Production.addComponentRow();
    const row = document.querySelector('#productionComponentsBody tr');
    const source = row.querySelector('.prod-comp-source');
    const narration = row.querySelector('.prod-comp-narration');

    expect(narration.readOnly).toBe(true);

    source.value = 'POOL';
    App.Production._syncNarrationEditability(row);
    expect(narration.readOnly).toBe(false);

    narration.value = 'typed by hand';
    source.value = 'ITEM';
    App.Production._syncNarrationEditability(row);
    expect(narration.readOnly).toBe(true);
    // An ITEM row's narration comes from Items Master, so a value typed
    // while it was a POOL row must not survive the switch.
    expect(narration.value).toBe('');
  });
});
