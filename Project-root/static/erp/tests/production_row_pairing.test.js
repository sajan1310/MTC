/**
 * The Per-Color Components matrix must not pair a row with an item that
 * colour never consumed (../production.js, _reconstructPerColorRows).
 *
 * Pass 2 zips the i-th entry of every colour into one row -- a guess from
 * SAVE ORDER, which is exact for anything this form saved, because
 * serializeColorMatrix writes row-major. It was applied unconditionally.
 * Once one colour's entries end up stored in a different order from the
 * others, that zip pairs every single row with the wrong item, the names
 * that would expose it are never consulted, and re-saving writes the wrong
 * pairing straight back.
 *
 * The fixture below is the real shape of LOT-PKG012-0018: nine items across
 * four colours, where the Red-White column's entries are a permutation of
 * the others. Twenty other lots carry the same shape. Displayed, it showed
 * "Pocket-Side Flap" as the Red item on the "Maharaja Double Gaddi" row.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const PARTIAL = path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', 'production.html');

const PINK = 'Pink-White / Black';
const RED = 'Red-White / Black';
const COLOR_MASTER = ['Pink', 'Purple', 'Red', 'SeaGreen', 'White', 'Black'].map(name => ({ name }));

function mount() {
  document.body.innerHTML = fs.readFileSync(PARTIAL, 'utf8');
  global.escapeHtml = v => String(v).replace(/[&<>"']/g, c => HTML_ESCAPE_MAP[c]);
  global.toNumber = (v, f = 0) => { const n = Number(v); return Number.isFinite(n) ? n : f; };
  global.$ = (s, r = document) => r.querySelector(s);
  global.$$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  global.formatCurrency = v => String(v); global.todayIso = () => ''; global.parseRecordDate = () => 0;
  global.App = {
    State: { globalItems: [], globalColors: COLOR_MASTER, globalProcesses: [], globalProduction: [] },
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

const entry = (colorKey, itemName, narration = '') =>
  ({ colorKey, itemName, size: 'GENERAL', narration, unit: '', qty: 10 });

/** Item names paired with each colour, keyed by the row's own item. */
function pairing(rows) {
  const out = {};
  rows.forEach(r => {
    out[App.Production._rowDisplayName(r)] = Object.fromEntries(
      r.cells.map(c => [c.colorKey, c.itemName]));
  });
  return out;
}

describe('A healthy lot still uses the positional zip', () => {
  beforeEach(() => mount());

  test('rows pair as saved when order and names agree', () => {
    const rows = App.Production._reconstructPerColorRows([
      entry(PINK, 'Maharaja-SEAT---PINK-WHITE'),
      entry(RED, 'Maharaja-SEAT---RED-WHITE'),
      entry(PINK, 'PANDA-BASKET---PINK-WHITE'),
      entry(RED, 'PANDA-BASKET---RED-WHITE'),
    ]);

    const paired = pairing(rows);
    expect(Object.keys(paired)).toHaveLength(2);
    Object.values(paired).forEach(byColour => {
      // Both cells of a row must be the same physical part.
      const residues = new Set(Object.values(byColour)
        .map(n => App.Production._stripAllColorTokens(n).toLowerCase()));
      expect(residues.size).toBe(1);
    });
  });

  test('an item deliberately paired with another colour is left alone', () => {
    // Documented in groupComponentsForSheet: a Red accessory used under the
    // lot's Blue column for contrast. Stripping only the row's own colour
    // would read this as a scramble, so the check strips every colour.
    const rows = App.Production._reconstructPerColorRows([
      entry(PINK, 'TEDDY BASKET---RED'),
      entry(RED, 'TEDDY BASKET---PINK'),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].cells.map(c => c.colorKey)).toEqual([PINK, RED]);
  });
});

describe('A lot whose saved order diverged is no longer mis-paired', () => {
  beforeEach(() => mount());

  // The real shape: same items under both colours, but the Red column's
  // saved order is rotated by one.
  const scrambled = () => App.Production._reconstructPerColorRows([
    entry(PINK, 'Maharaja-Double-Gaddi---PINK-WHITE'),
    entry(RED, 'Pocket-Side Flap---RED-WHITE'),
    entry(PINK, 'Pocket-Side Flap---PINK-WHITE', 'Pocket type'),
    entry(RED, 'Maharaja-Double-Gaddi---RED-WHITE', 'Pocket type'),
  ]);

  test('no row claims a colour consumed an item it did not', () => {
    Object.entries(pairing(scrambled())).forEach(([, byColour]) => {
      const residues = new Set(Object.values(byColour)
        .map(n => App.Production._stripAllColorTokens(n).toLowerCase()));
      expect(residues.size).toBe(1);
    });
  });

  test('each item is reunited with its own colours', () => {
    const paired = pairing(scrambled());
    const gaddi = Object.values(paired).find(v => Object.values(v).every(n => /Double-Gaddi/.test(n)));
    expect(gaddi).toEqual({
      [PINK]: 'Maharaja-Double-Gaddi---PINK-WHITE',
      [RED]: 'Maharaja-Double-Gaddi---RED-WHITE',
    });
  });

  test('a displaced entry does not drag its host row\'s narration along', () => {
    // Narration is written once per row and shared by every colour cell, so
    // a misfiled cell inherited the wrong one. It is no longer identity, so
    // it cannot keep the cell away from its own siblings either.
    const rows = scrambled();
    expect(rows.every(r => new Set(r.cells.map(c => c.colorKey)).size === r.cells.length)).toBe(true);
  });
});

describe('The agreement check itself', () => {
  beforeEach(() => mount());

  test('one physical part under several colours agrees', () => {
    expect(App.Production._positionalRowsAgreeWithNames([
      { cells: [{ itemName: 'PANDA-BASKET---PINK-WHITE' }, { itemName: 'PANDA-BASKET---RED-WHITE' }] },
    ])).toBe(true);
  });

  test('two unrelated parts in one row disagree', () => {
    expect(App.Production._positionalRowsAgreeWithNames([
      { cells: [{ itemName: 'Maharaja-Double-Gaddi---PINK-WHITE' }, { itemName: 'Pocket-Side Flap---RED-WHITE' }] },
    ])).toBe(false);
  });

  test('a name made entirely of colour words compares by its full name', () => {
    // _stripAllColorTokens declines to strip when nothing would be left, so
    // there is no such thing as an empty residue to treat as "no evidence".
    expect(App.Production._stripAllColorTokens('White-Black')).toBe('White-Black');
    // Which means two such cells agree only when spelled the same -- the
    // conservative direction for a row nothing else corroborates.
    expect(App.Production._positionalRowsAgreeWithNames([
      { cells: [{ itemName: 'White-Black' }, { itemName: 'White-Black' }] },
    ])).toBe(true);
    expect(App.Production._positionalRowsAgreeWithNames([
      { cells: [{ itemName: 'PANDA-BASKET---PINK' }, { itemName: 'White-Black' }] },
    ])).toBe(false);
  });
});
