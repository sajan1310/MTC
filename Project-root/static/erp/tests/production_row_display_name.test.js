/**
 * Regression test for App.Production._rowDisplayName (../production.js) --
 * the Per-Color Components matrix row label a reconstructed row is CALLED
 * (see groupComponentsForSheet), as distinct from _cellItemTag which labels
 * each individual colour cell.
 *
 * Covers the LOT-PF2IIS-0002 case referenced in groupComponentsForSheet: a
 * physical item can be deliberately paired with a lot colour other than its
 * own (e.g. a Red-coloured accessory used under the lot's Blue column for
 * contrast). Stripping only the primary cell's OWN axis colour then finds
 * nothing in its name, and the raw name (still carrying its own colour word)
 * leaked through as the row label while every other colour's cell still got
 * a clean "(Grey)"/"(Purple)" style tag -- this asserts that no longer
 * happens.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function loadProductionAsGlobal() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'production.js'), 'utf8');
  // eslint-disable-next-line no-eval
  eval(code);
}

describe('App.Production._rowDisplayName', () => {
  beforeEach(() => {
    global.App = { State: {}, Utils: { isCommonColorGroup: g => String(g ?? '').trim().toUpperCase() === 'COMMON' } };
    loadProductionAsGlobal();
  });

  test('strips the colour word even when it belongs to a different cell than the primary one', () => {
    // The item filed under the "Blue" column is literally named "...Red" --
    // a deliberate contrast pairing, not a naming mistake.
    const row = {
      cells: [
        { itemName: 'Teddy Basket Red', colorKey: 'Blue' },
        { itemName: 'Teddy Basket Pink', colorKey: 'Grey' },
        { itemName: 'Teddy Basket Purple', colorKey: 'Metallic Purple' },
        { itemName: 'Teddy Basket Blue', colorKey: 'Red' },
      ],
    };

    expect(App.Production._rowDisplayName(row)).toBe('Teddy Basket');
  });

  test('still strips using the primary cell\'s own colour when it matches directly', () => {
    const row = {
      cells: [
        { itemName: 'Frame Sticker Blue', colorKey: 'Blue' },
        { itemName: 'Frame Sticker Red', colorKey: 'Red' },
      ],
    };

    expect(App.Production._rowDisplayName(row)).toBe('Frame Sticker');
  });

  test('leaves the name untouched when none of the row\'s own colours appear in it', () => {
    const row = {
      cells: [
        { itemName: 'Mystery Widget', colorKey: 'Blue' },
        { itemName: 'Other Widget', colorKey: 'Red' },
      ],
    };

    expect(App.Production._rowDisplayName(row)).toBe('Mystery Widget');
  });
});
