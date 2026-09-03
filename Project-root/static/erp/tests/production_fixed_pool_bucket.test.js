/**
 * A POOL component whose upstream process has no colour of its own
 * (../production.js).
 *
 * "Fitted Rim" exists in the Warehouse Pool in exactly ONE colour, Black.
 * That is not a per-output-colour choice the operator makes -- it is a
 * fixed input, and process_service._pool_item_is_color_axis already says so
 * ("an item that exists in exactly one color ... is a fixed input, not a
 * per-output-color choice"). Whatever colours the lot produces, it consumes
 * this.
 *
 * The Common Components row used to answer that by locking its colorGroup
 * to "Black" -- which asserts the opposite, that the consumption belongs to
 * an OUTPUT colour called Black. save_production drops any component scoped
 * to a colour the lot does not produce (it would otherwise debit a bucket
 * the lot has no claim on), so on a lot producing Baby Pink / Blue-White /
 * ... the component was dropped and the material never recorded. The bucket
 * belongs in `poolColor`, which is the field that exists for exactly this
 * (see _pool_bucket_color); colorGroup stays COMMON.
 *
 * A pool item with 2+ live colours IS a real axis and must keep its
 * existing per-colour behaviour -- pinned here too, because the whole risk
 * of this fix is over-applying it.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const PARTIAL = path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', 'production.html');

// The lot in the bug report: five painted-frame colours, none of them Black.
const LOT_COLORS = ['Baby Pink', 'Blue-White', 'Orange-GREY', 'Red-SeaGreen', 'Red-Yellow'];

const RECIPE = [
  { itemName: 'Fitted Rim 12 inch Black Rim Zinc Spoke', size: '', narration: 'Rim + Hub + Spoke', sourceType: 'POOL', colorGroup: 'COMMON', qtyPerUnit: 1, unit: '' },
  { itemName: 'BB-AXLE 2-C', size: 'GENERAL', narration: '', sourceType: 'ITEM', colorGroup: 'COMMON', qtyPerUnit: 1, unit: '' },
];

function setUpDom() {
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

  const code = fs.readFileSync(path.join(__dirname, '..', 'production.js'), 'utf8');
  // eslint-disable-next-line no-eval
  eval(code);

  // Both are network reads in the app; the behaviour under test is what
  // populateCommonComponentsFromProcess does with their answers.
  App.Production._fetchProcessComponents = async () => ({ success: true, data: RECIPE });
  App.Production.refreshPoolAvailability = async () => {};
}

/** The Fitted Rim row as it would be submitted, straight off the DOM. */
function serializedRim() {
  return App.Production.serializeComponentsConsumed()
    .find(c => c.itemName === 'Fitted Rim 12 inch Black Rim Zinc Spoke');
}

/**
 * save_production's own keep/drop rule, ported: a component survives only
 * if it is COMMON or names one of the lot's produced colours.
 * (production_service.save_production; warehouse_service._color_names_match
 * is the segment match, not needed here -- "Black" shares no segment with
 * any of LOT_COLORS.)
 */
function survivesServerColorFilter(comp, lotColors) {
  if (App.Utils.isCommonColorGroup(comp.colorGroup)) return true;
  return lotColors.some(col => col.toLowerCase() === String(comp.colorGroup).toLowerCase());
}

describe('a pool item that exists in exactly one colour is a fixed input', () => {
  beforeEach(async () => {
    setUpDom();
    App.Production.getPoolColorAwareItemNames = async () => new Map([
      ['fitted rim 12 inch black rim zinc spoke', ['Black']],
    ]);
    await App.Production.populateCommonComponentsFromProcess('PRC-1');
  });

  test('it stays on the Common Components table', () => {
    expect(serializedRim()).toBeDefined();
    expect(document.querySelectorAll('#productionComponentsBody tr')).toHaveLength(RECIPE.length);
  });

  test('its colorGroup stays COMMON -- it is not an output colour', () => {
    expect(serializedRim().colorGroup).toBe('COMMON');
  });

  test('the one pool colour travels as the BUCKET it draws from', () => {
    expect(serializedRim().poolColor).toBe('Black');
  });

  test('so the server no longer drops it from a lot producing other colours', () => {
    expect(survivesServerColorFilter(serializedRim(), LOT_COLORS)).toBe(true);
  });

  test('the old shape is exactly what the server dropped', () => {
    // Guards the assertion above from passing vacuously.
    expect(survivesServerColorFilter({ colorGroup: 'Black' }, LOT_COLORS)).toBe(false);
  });

  test('the Colour cell still shows the fixed bucket, read-only', () => {
    const colorInput = document.querySelector('#productionComponentsBody tr .prod-comp-color');
    expect(colorInput.value).toBe('Black');
    expect(colorInput.hasAttribute('readonly')).toBe(true);
  });

  test('an ITEM row alongside it is untouched', () => {
    const axle = App.Production.serializeComponentsConsumed().find(c => c.itemName === 'BB-AXLE 2-C');
    expect(axle.colorGroup).toBe('COMMON');
    expect(axle.poolColor).toBe('');
  });
});

describe('a pool item with 2+ live colours is a real axis, and keeps the existing path', () => {
  beforeEach(async () => {
    setUpDom();
    App.Production.getPoolColorAwareItemNames = async () => new Map([
      ['fitted rim 12 inch black rim zinc spoke', ['Black', 'Silver']],
    ]);
    await App.Production.populateCommonComponentsFromProcess('PRC-1');
  });

  test('it is routed off the Common Components table entirely', () => {
    expect(serializedRim()).toBeUndefined();
    expect(document.querySelectorAll('#productionComponentsBody tr')).toHaveLength(1);
  });
});
