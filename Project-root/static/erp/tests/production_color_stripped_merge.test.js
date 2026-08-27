/**
 * Regression tests for PASS 4 of App.Production._reconstructPerColorRows
 * (../production.js) -- consolidating Per-Color Components matrix rows that
 * are one physical component named once per colour variant.
 *
 * Why the pass exists: Passes 1-3 all compare LITERAL item names. A model
 * that encodes the colour into the component name therefore never
 * consolidates -- Pass 1 only matches names that are identical, and Pass 3
 * refuses any group that does not span exactly 2 colours. A real lot with a
 * "Maharaja-SEAT BLUE-WHITE" used under 2 colours sitting next to a
 * "Maharaja SEAT WHITE" used under 3 printed as two half-empty rows full of
 * dashes instead of one row across all five columns.
 *
 * Why the vocabulary is the Color Master and not the lot's own colours: the
 * Chain Cover pair below hinges on BLACK and WHITE, and neither is a colour
 * of the lot those parts are filed under -- they describe the physical part.
 * Stripping only the lot's checked colours leaves the two names different
 * and they never merge.
 *
 * Why the guards are pinned as hard as the merges: stripping a whole colour
 * master out of item names is the kind of change that quietly corrupts names
 * ("Petrol Tank" -> "Petrol k") or silently drops a quantity (two parts
 * merged into one cell). Those cases are asserted here alongside the happy
 * path, because neither would throw -- they would just produce a wrong sheet.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function loadProductionAsGlobal() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'production.js'), 'utf8');
  // eslint-disable-next-line no-eval
  eval(code);
}

// The Color Master (Stock > Color Master) as the two real lots below see it.
// 'Baby Pink' is deliberately present as a multi-word entry WITHOUT a 'Baby'
// entry beside it -- that is what the phrase/word split in
// _colorMasterVocabulary exists to handle.
const COLOR_MASTER = [
  'Blue', 'White', 'Orange', 'Grey', 'Red', 'SeaGreen', 'Yellow', 'Pink',
  'Black', 'Purple', 'Baby Pink',
].map(name => ({ name }));

function mount(colors = COLOR_MASTER) {
  global.App = { State: { globalColors: colors }, Utils: { isCommonColorGroup: g => String(g ?? '').trim().toUpperCase() === 'COMMON' } };
  loadProductionAsGlobal();
}

// One flat colorGroup-tagged entry, the shape _reconstructPerColorRows is fed
// from a lot's saved components_consumed.
function entry(itemName, colorKey, qty = 20) {
  return { itemName, colorKey, size: '', narration: '', unit: 'Pcs', qty };
}

const colorsOf = row => row.cells.map(c => c.colorKey);

describe('Pass 4: colour-stripped row consolidation', () => {
  beforeEach(() => mount());

  test('merges a 2-colour name variant with a 3-colour one into a single row', () => {
    // The exact shape Passes 1-3 cannot consolidate: Pass 1 keys on the
    // literal name so it produces two groups, and Pass 3 drops the 3-colour
    // group on sight.
    const rows = App.Production._reconstructPerColorRows([
      entry('Maharaja-SEAT BLUE-WHITE', 'Baby Pink'),
      entry('Maharaja-SEAT BLUE-WHITE', 'Blue-White'),
      entry('Maharaja SEAT WHITE', 'Orange-Grey'),
      entry('Maharaja SEAT WHITE', 'Red-SeaGreen'),
      entry('Maharaja SEAT WHITE', 'Red-Yellow'),
    ]);

    expect(rows).toHaveLength(1);
    expect(colorsOf(rows[0]).sort()).toEqual(
      ['Baby Pink', 'Blue-White', 'Orange-Grey', 'Red-SeaGreen', 'Red-Yellow']);
    expect(App.Production._rowDisplayName(rows[0])).toBe('Maharaja SEAT');
  });

  test('merges on a colour that is NOT one of the lot\'s own colours', () => {
    // BLACK and WHITE here name the physical part, not the lot's colour axis
    // (the lot's colours are the five below). Only a Color Master vocabulary
    // sees through this.
    const rows = App.Production._reconstructPerColorRows([
      entry('Chain Cover-ORBIT BLACK-SILENCER', 'Baby Pink'),
      entry('Chain Cover-ORBIT BLACK-SILENCER', 'Orange-Grey'),
      entry('Chain Cover-ORBIT BLACK-SILENCER', 'Red-SeaGreen'),
      entry('Chain Cover-ORBIT BLACK-SILENCER', 'Red-Yellow'),
      entry('Chain Cover-ORBIT WHITE-SILENCER', 'Blue-White'),
    ]);

    expect(rows).toHaveLength(1);
    expect(colorsOf(rows[0])).toHaveLength(5);
    // Hyphenation survives: the residue is the row's label, so it has to stay
    // readable rather than flatten to "Chain Cover ORBIT SILENCER".
    expect(App.Production._rowDisplayName(rows[0])).toBe('Chain Cover-ORBIT SILENCER');
  });

  test('merges three separate colour variants of one sticker', () => {
    const rows = App.Production._reconstructPerColorRows([
      entry('ORBIT-STICKER-Backrest BLUE', 'Baby Pink'),
      entry('ORBIT-STICKER-Backrest BLUE', 'Blue-White'),
      entry('ORBIT-STICKER-Backrest ORANGE', 'Orange-Grey'),
      entry('ORBIT-STICKER-Backrest RED', 'Red-SeaGreen'),
      entry('ORBIT-STICKER-Backrest RED', 'Red-Yellow'),
    ]);

    expect(rows).toHaveLength(1);
    expect(colorsOf(rows[0])).toHaveLength(5);
    expect(App.Production._rowDisplayName(rows[0])).toBe('ORBIT-STICKER-Backrest');
  });

  test('keeps every cell\'s own literal item name, so nothing is lost on save', () => {
    // serializeColorMatrix reads the item off each merged cell's own picker.
    // If the merge flattened cells onto the row label, a lot would save the
    // wrong item for four of its five colours.
    const rows = App.Production._reconstructPerColorRows([
      entry('Maharaja-SEAT BLUE-WHITE', 'Baby Pink'),
      entry('Maharaja-SEAT BLUE-WHITE', 'Blue-White'),
      entry('Maharaja SEAT WHITE', 'Orange-Grey'),
      entry('Maharaja SEAT WHITE', 'Red-SeaGreen'),
      entry('Maharaja SEAT WHITE', 'Red-Yellow'),
    ]);

    expect(rows[0].cells.map(c => c.itemName)).toEqual([
      'Maharaja SEAT WHITE', 'Maharaja SEAT WHITE', 'Maharaja SEAT WHITE',
      'Maharaja-SEAT BLUE-WHITE', 'Maharaja-SEAT BLUE-WHITE',
    ]);
  });

  test('preserves first-appearance order rather than sorting by colour', () => {
    const rows = App.Production._reconstructPerColorRows([
      entry('HORN-TEDDY BLUE', 'Blue-White'),
      entry('TEDDY BASKET BLUE', 'Blue-White'),
      entry('HORN TEDDY', 'Red-Yellow'),
      entry('TEDDY BASKET', 'Red-Yellow'),
    ]);

    expect(rows.map(r => App.Production._rowDisplayName(r)))
      .toEqual(['HORN TEDDY', 'TEDDY BASKET']);
  });
});

describe('Pass 4 guards', () => {
  beforeEach(() => mount());

  test('refuses to merge rows whose colour columns overlap', () => {
    // Both reduce to "Frame Sticker" but both claim Blue-White -- two
    // different physical parts competing for one cell. Merging would drop
    // one of the two quantities silently.
    const rows = App.Production._reconstructPerColorRows([
      entry('Frame Sticker BLUE', 'Blue-White'),
      entry('Frame Sticker BLUE', 'Red-Yellow'),
      entry('Frame Sticker RED', 'Blue-White'),
      entry('Frame Sticker RED', 'Orange-Grey'),
    ]);

    expect(rows).toHaveLength(2);
  });

  test('does not merge across different sizes', () => {
    // Asserted against the pass directly. Feeding these through
    // _reconstructPerColorRows would prove nothing about Pass 4: two entries
    // under two colours are even coverage, so Pass 2's positional zip already
    // merges them (and has always ignored size, which is out of scope here).
    const row = (itemName, colorKey, size) => ({
      firstIndex: 0, size, narration: '', unit: 'Pcs', cells: [{ itemName, colorKey, size }],
    });
    const merged = App.Production._mergeRowsByColorStrippedName([
      row('Handle Grip BLUE', 'Blue-White', '12'),
      row('Handle Grip RED', 'Red-Yellow', '14'),
    ]);

    expect(merged).toHaveLength(2);
  });

  test('never strips a colour that is only a SUBSTRING of a real word', () => {
    // The raw indexOf search _stripColorSubstring uses would turn these into
    // "Petrol k" and "Coveed Seat" once the whole master is in play.
    mount([{ name: 'Tan' }, { name: 'Red' }, { name: 'Blue' }]);

    expect(App.Production._stripAllColorTokens('Petrol Tank Blue')).toBe('Petrol Tank');
    expect(App.Production._stripAllColorTokens('Covered Seat Blue')).toBe('Covered Seat');
  });

  test('a colour is only recognised as a whole delimited word', () => {
    // The rule: " Red " and "-Red-" are the colour; the "red" buried inside
    // "Covered" is not, and neither is a name that runs the word together
    // with something else.
    mount([{ name: 'Red' }]);

    expect(App.Production._stripAllColorTokens('Chain Cover-Red-Silencer')).toBe('Chain Cover-Silencer');
    expect(App.Production._stripAllColorTokens('Chain Cover Red Silencer')).toBe('Chain Cover Silencer');
    expect(App.Production._stripAllColorTokens('Covered Seat')).toBe('Covered Seat');
    expect(App.Production._stripAllColorTokens('Redwood Frame')).toBe('Redwood Frame');
  });

  test('a multi-word colour only strips when its words are consecutive', () => {
    // 'Baby Pink' is a colour; 'Baby' on its own is not.
    expect(App.Production._stripAllColorTokens('Baby Pink Cushion')).toBe('Cushion');
    expect(App.Production._stripAllColorTokens('Baby Seat Blue')).toBe('Baby Seat');
  });

  test('without a "Baby Pink" master entry, only "Pink" counts as the colour', () => {
    // The fallback half of the rule: a multi-word colour is a colour only if
    // the Color Master actually carries it. Otherwise the single-word master
    // entry inside it is all that gets stripped, and "Baby" survives as part
    // of the component's identity.
    mount([{ name: 'Pink' }, { name: 'Blue' }]);

    expect(App.Production._stripAllColorTokens('Baby Pink Cushion')).toBe('Baby Cushion');
  });

  test('an item whose whole name is a colour keeps its raw name', () => {
    // An empty residue would otherwise collide with every other fully
    // stripped name and merge unrelated parts into one row.
    expect(App.Production._stripAllColorTokens('Blue-White')).toBe('Blue-White');
  });

  test('is a no-op when the Color Master is empty', () => {
    // The same five entries the first test consolidates into one row. With no
    // vocabulary to strip with there is nothing to match on, so the lot falls
    // back to exactly the two rows it produced before this pass existed.
    mount([]);
    const rows = App.Production._reconstructPerColorRows([
      entry('Maharaja-SEAT BLUE-WHITE', 'Baby Pink'),
      entry('Maharaja-SEAT BLUE-WHITE', 'Blue-White'),
      entry('Maharaja SEAT WHITE', 'Orange-Grey'),
      entry('Maharaja SEAT WHITE', 'Red-SeaGreen'),
      entry('Maharaja SEAT WHITE', 'Red-Yellow'),
    ]);

    expect(rows).toHaveLength(2);
  });
});

describe('Pass 4 leaves the earlier passes alone', () => {
  beforeEach(() => mount());

  test('an identically-named item across five colours still labels with its raw name', () => {
    // The Pass 1 path, which already worked. Pass 4 must not relabel it to a
    // colour-stripped "Maharaja SEAT".
    const rows = App.Production._reconstructPerColorRows(
      ['Blue', 'Orange', 'Pink', 'Red', 'SeaGreen'].map(c => entry('Maharaja SEAT WHITE', c)));

    expect(rows).toHaveLength(1);
    expect(App.Production._rowDisplayName(rows[0])).toBe('Maharaja SEAT WHITE');
  });

  test('the LOT-PF2IIS-0002 contrast pairing still reconstructs as one row', () => {
    // A physical item deliberately paired with a lot colour other than its
    // own. Pass 2's positional zip catches this; Pass 4 must not disturb it.
    const rows = App.Production._reconstructPerColorRows([
      entry('Teddy Basket Red', 'Blue'),
      entry('Teddy Basket Pink', 'Grey'),
      entry('Teddy Basket Purple', 'Red'),
    ]);

    expect(rows).toHaveLength(1);
    expect(App.Production._rowDisplayName(rows[0])).toBe('Teddy Basket');
  });
});
