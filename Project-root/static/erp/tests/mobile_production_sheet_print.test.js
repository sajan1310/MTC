/**
 * A Production Sheet printed from a phone is desktop's Production Sheet.
 *
 * Both shells hand the same builder, PrintTemplates.productionSheet, an
 * object describing the sheet. Desktop builds that object from its
 * Production Sheet dialog, after grouping the lot's components; the phone
 * built one of its own -- a row for every colour line, sub-groups treated
 * as colours, no units or narration, the process's name where desktop uses
 * its type, blank product fields, and no remarks. Same builder, a
 * different sheet on the floor.
 *
 * So this runs desktop's own production.js -- read-only; desktop is the
 * reference -- on the same lots, and requires the phone's object, the
 * sheet it prints and the file it names to be desktop's. The sheet
 * screen itself (opening, editing, saving) is mobile_production_sheet
 * .test.js.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const partial = name => fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', name), 'utf8');
const PRINT_PARTIAL = partial('print.html');
const PRODUCTION_PARTIAL = partial('production.html');

// jsdom has no innerText, and both shells fill (and desktop reads back)
// the sheet's header fields with it.
Object.defineProperty(HTMLElement.prototype, 'innerText', {
  configurable: true,
  get() { return this.textContent; },
  set(v) { this.textContent = v; }
});

// ── What desktop's Production tab has loaded before it shows a lot ─────

const COLORS = ['Red', 'Blue', 'Green', 'Black', 'White', 'Wine', 'Sea Green', 'Baby Pink',
  'Silky Blue', 'Navy Blue'].map(name => ({ name }));

const ITEMS = [
  { name: 'Primer', size: '5 L', narration: 'Grey base', baseUnit: 'Ltr' },
  { name: 'Frame---Red', size: '20 inch', narration: 'MS tube', baseUnit: 'Pcs' },
  { name: 'Frame---Blue', size: '20 inch', narration: 'MS tube', baseUnit: 'Pcs' },
  { name: 'Paint(Gloss) Red', size: 'GENERAL', narration: '', baseUnit: 'Kg' },
  { name: 'Paint(Gloss) Blue', size: 'GENERAL', narration: '', baseUnit: 'Kg' },
  { name: 'Chain Cover', size: 'GENERAL', narration: 'Plastic', baseUnit: 'Pcs' },
  { name: 'Poly Bag', size: 'GENERAL', narration: '', baseUnit: 'Pcs' },
  { name: 'Carton 14 inch', size: 'GENERAL', narration: '5 ply', baseUnit: 'Pcs' },
  { name: 'Kalpi Frame', size: '26 inch', narration: 'Hi-ten', baseUnit: 'Pcs' }
];

const PROCESSES = [
  { processId: 'PRC-PNT', processName: 'Frame Painting', processType: 'Painting' },
  { processId: 'PRC-PKG', processName: 'Packing Line 2', processType: 'Packing' }
];

// Lots chosen for what the grouping has to get right.
const LOTS = {
  'a painted lot, as it was recorded': {
    rowIdx: 11, date: '12/09/2026', qty: 40, color: '', processId: 'PRC-PNT', lotNumber: 'LOT-PNT041-0003',
    outputItemName: 'Painted Frame Jungle King 14 inch IBC', productId: '', productName: '',
    sheetRemarks: 'Rush -- Nova Motors', colorBreakdown: [{ color: 'Red', qty: 20 }, { color: 'Blue', qty: 20 }],
    componentsConsumed: [
      { itemName: 'Primer', size: '5 L', narration: '', colorGroup: 'COMMON', qty: 5, sourceType: 'ITEM' },
      // Common, but overridden for Red by the item below: its quantity
      // falls to the other columns.
      { itemName: 'Chain Cover', size: 'GENERAL', narration: '', colorGroup: 'COMMON', qty: 40, sourceType: 'ITEM' },
      { itemName: 'Chain Cover Red', size: 'GENERAL', narration: '', colorGroup: 'Red', qty: 20, sourceType: 'ITEM' },
      { itemName: 'Frame---Red', size: '20 inch', narration: '', colorGroup: 'Red', qty: 20, sourceType: 'ITEM' },
      { itemName: 'Paint(Gloss) Red', size: 'GENERAL', narration: '', colorGroup: 'Red', qty: 2, sourceType: 'ITEM' },
      { itemName: 'Frame---Blue', size: '20 inch', narration: '', colorGroup: 'Blue', qty: 20, sourceType: 'ITEM' },
      { itemName: 'Paint(Gloss) Blue', size: 'GENERAL', narration: '', colorGroup: 'Blue', qty: 1.5, sourceType: 'ITEM' },
      // One physical item under both colours.
      { itemName: 'Sticker Set Red-Blue', size: 'GENERAL', narration: '', colorGroup: 'Red', qty: 20, sourceType: 'ITEM' },
      { itemName: 'Sticker Set Red-Blue', size: 'GENERAL', narration: '', colorGroup: 'Blue', qty: 20, sourceType: 'ITEM' },
      // Drawn from the Warehouse Pool, one of them from a bucket of another
      // colour.
      { itemName: 'Painted Mudguard', size: '20 inch', narration: '', colorGroup: 'Red', qty: 20, sourceType: 'POOL', poolColor: 'Wine' },
      { itemName: 'Painted Mudguard', size: '20 inch', narration: '', colorGroup: 'Blue', qty: 20, sourceType: 'POOL', poolColor: 'Blue' },
      // A packing bucket, not a colour.
      { itemName: 'Poly Bag', size: 'GENERAL', narration: '', colorGroup: 'KIT BAG 20"', qty: 40, sourceType: 'ITEM' }
    ]
  },

  'a saved sheet with composite colours, uneven per colour': {
    rowIdx: 12, date: '13/09/2026', qty: 30, color: '', processId: 'PRC-PKG', lotNumber: 'LOT-PKG012-0018',
    outputItemName: '', productId: 'PRD-7', productName: 'Jungle King 14 IBC',
    sheetRemarks: '', colorBreakdown: [{ color: 'Silky Blue-Navy Blue / Black', qty: 10 }, { color: 'Sea Green', qty: 20 }],
    componentsConsumed: [{ itemName: 'Ignored', size: '', colorGroup: 'COMMON', qty: 1 }],
    customComponents: [
      { itemName: 'Carton 14 inch', size: 'GENERAL', narration: '', color: '', requiredQty: 30 },
      { itemName: 'Seat Silky Blue-Navy Blue', size: 'GENERAL', narration: '', color: 'Silky Blue-Navy Blue / Black', requiredQty: 10 },
      { itemName: 'Seat Sea Green', size: 'GENERAL', narration: '', color: 'Sea Green', requiredQty: 20 },
      { itemName: 'Grip Black', size: 'GENERAL', narration: '', color: 'Silky Blue-Navy Blue / Black', requiredQty: 20 },
      { itemName: 'Basket Baby Pink', size: 'GENERAL', narration: 'Wicker', color: 'Sea Green', requiredQty: 20 },
      { itemName: 'Bell', size: 'GENERAL', narration: '', color: 'Sea Green', requiredQty: 20 }
    ]
  },

  'a finished single-colour lot whose process has since gone': {
    rowIdx: 13, date: '14/09/2026', qty: 12, color: 'Red', processId: 'PRC-GONE', lotNumber: 'LOT-FIN001-0001',
    outputItemName: 'Kalpi 26 Red', productId: 'PRD-1', productName: 'Kalpi 26',
    sheetRemarks: 'Deliver with invoice', colorBreakdown: [],
    componentsConsumed: [
      { itemName: 'Kalpi Frame', size: '26 inch', narration: '', colorGroup: 'COMMON', qty: 12 },
      { itemName: 'Tyre 26 x 1.95', size: '26 inch', narration: 'Nylon', colorGroup: 'COMMON', qty: 24 }
    ]
  },

  'a lot that recorded nothing': {
    rowIdx: 14, date: '14/09/2026', qty: 5, color: '', processId: 'PRC-PNT', lotNumber: 'LOT-PNT050-0001',
    outputItemName: 'Painted Frame 12', productId: '', productName: '', sheetRemarks: '',
    colorBreakdown: [], componentsConsumed: []
  }
};

function loadShared() {
  // Each eval() gets its own scope, so api.js's plain declarations have to
  // be republished -- in a browser every file shares one global.
  // eslint-disable-next-line no-eval
  eval([
    read('api.js').replace(/^const Api = /m, 'global.Api = '),
    'global.escapeHtml = escapeHtml;',
    'global.toNumber = toNumber;',
    'global.formatCurrency = formatCurrency;',
    'global.formatQty = formatQty;',
    'global.parseRecordDate = parseRecordDate;',
    'global.dateToInputValue = dateToInputValue;',
    'global.inDateRange = inDateRange;',
    'global.todayIso = todayIso;'
  ].join('\n'));
  // eslint-disable-next-line no-eval
  eval(read('print-templates.js').replace(/^const PrintTemplates = /m, 'global.PrintTemplates = '));
  // eslint-disable-next-line no-eval
  eval(read('mobile.js').replace(/^const MApp = /m, 'global.MApp = '));
}

// Desktop, with its Production tab loaded: core.js's helpers as far as
// production.js reaches them, and print.js's own App.Print.
function loadDesktop(state) {
  global.$ = (sel, root = document) => root.querySelector(sel);
  global.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const sameText = (a, b) =>
    String(a == null ? '' : a).trim().toLowerCase() === String(b == null ? '' : b).trim().toLowerCase();
  global.App = {
    State: { globalModels: [], ...state },
    Utils: {
      sameText,
      sameColor: sameText,
      isCommonColorGroup: g => String(g == null ? '' : g).trim().toUpperCase() === 'COMMON',
      formatNameCase: t => {
        const s = String(t == null ? '' : t).trim();
        return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;
      },
      getSizeFromOutputItemName: () => 'General',
      getModelFromOutputItemName: text => {
        const lower = String(text || '').toLowerCase();
        const match = (global.App.State.globalModels || [])
          .find(m => m.name && lower.includes(String(m.name).toLowerCase()));
        return match ? match.name : 'General';
      },
      showToast: jest.fn(),
      notPortedYet: jest.fn()
    }
  };
  // eslint-disable-next-line no-eval
  eval(read('print.js'));
  // eslint-disable-next-line no-eval
  eval(read('production.js'));
}

// What desktop's Print Sheet hands the builder, prints, and names the file.
function desktopSheet(lot) {
  document.body.innerHTML = PRINT_PARTIAL + PRODUCTION_PARTIAL;
  loadDesktop({ globalProduction: [lot], globalProcesses: PROCESSES, globalColors: COLORS, globalItems: ITEMS });
  const spy = jest.spyOn(PrintTemplates, 'productionSheet');
  App.Production._populateProductionSheetData(lot, 0);
  App.Production._buildProductionSheetForExport();
  const data = spy.mock.calls[spy.mock.calls.length - 1][0];
  spy.mockRestore();
  return {
    data,
    html: document.getElementById('print-production-sheet-container').innerHTML,
    docName: App.Production._productionSheetDocName()
  };
}

// The phone's, through its own path: the sheet screen's rows, then Print.
async function phoneSheet(lot) {
  document.body.innerHTML = `${PRINT_PARTIAL}<div id="mapp-toast-stack"></div>
    <textarea id="production-sheet-remarks"></textarea>`;
  MApp.Api.callCached = jest.fn(async method => ({
    success: true,
    data: { getItemsData: ITEMS, getColors: COLORS, getProcessData: PROCESSES }[method]
  }));
  MApp.ProductionSheet.lot = lot;
  MApp.ProductionSheet.rows = MApp.ProductionSheet._rowsFor(lot);
  MApp.ProductionSheet._excluded = new Set();
  document.getElementById('production-sheet-remarks').value = lot.sheetRemarks || '';

  const choose = jest.spyOn(MApp.Print, 'chooseAction').mockResolvedValue(undefined);
  const build = jest.spyOn(PrintTemplates, 'productionSheet');
  await MApp.ProductionSheet.printSheet();
  const opts = choose.mock.calls[0][0];
  await opts.populate();
  const data = build.mock.calls[build.mock.calls.length - 1][0];
  choose.mockRestore();
  build.mockRestore();
  return {
    data,
    opts,
    html: document.getElementById('print-production-sheet-container').innerHTML,
    docName: opts.filename
  };
}

beforeEach(() => {
  jest.resetModules();
  global.fetch = jest.fn();
  try { localStorage.clear(); } catch (e) { /* not available */ }
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  loadShared();
});

afterEach(() => {
  delete global.App;
});

describe.each(Object.entries(LOTS))('%s', (_label, lot) => {
  test('the phone hands the builder the object desktop hands it', async () => {
    const desktop = desktopSheet(lot);
    const phone = await phoneSheet(lot);
    expect(phone.data).toEqual(desktop.data);
  });

  test('and so prints the sheet desktop prints, remarks included', async () => {
    const desktop = desktopSheet(lot);
    const phone = await phoneSheet(lot);
    expect(phone.html).toBe(desktop.html);
  });

  test('and names the file as desktop does', async () => {
    const desktop = desktopSheet(lot);
    const phone = await phoneSheet(lot);
    expect(phone.docName).toBe(desktop.docName);
  });
});

describe('what the grouping has to get right', () => {
  const lot = LOTS['a painted lot, as it was recorded'];

  test('one row per item, a quantity under each colour', async () => {
    const { data } = await phoneSheet(lot);
    const frames = data.matrix.filter(r => r.name.startsWith('Frame'));
    // Not a row per colour line, which is what the phone used to print.
    expect(frames).toHaveLength(1);
    expect(frames[0].qtyByGroup).toEqual({ Blue: '20', Red: '20' });
  });

  test('a packing bucket is a sub-group, not a colour', async () => {
    const { data } = await phoneSheet(lot);
    expect(data.colors).toEqual(['Blue', 'Red']);
    expect(data.subGroups).toEqual(['KIT BAG 20"']);
  });

  test('a pool draw is tagged with the bucket it came from', async () => {
    const { data } = await phoneSheet(lot);
    const mudguard = data.matrix.find(r => r.name.startsWith('Painted Mudguard'));
    expect(mudguard.tagByGroup).toEqual({ Red: '(Wine)', Blue: '(Blue)' });
  });

  test('units and narration come from Items Master', async () => {
    const { data } = await phoneSheet(lot);
    expect(data.common.find(r => r.name.startsWith('Primer')))
      .toEqual({ name: 'Primer(Grey base)', qty: '5', unit: 'Ltr' });
  });

  test('the title is the process TYPE, and the header is never blank', async () => {
    const { data } = await phoneSheet(lot);
    expect(data.title).toBe('Painting Requirement Sheet');
    expect(data.productId).toBe('LOT-PNT041-0003');
    expect(data.productName).toBe('Painted Frame Jungle King 14 inch IBC');
  });

  test('the remarks reach the paper', async () => {
    await phoneSheet(lot);
    expect(document.getElementById('print-prod-remarks-section').style.display).toBe('');
    expect(document.getElementById('print-prod-remarks-text').textContent).toBe('Rush -- Nova Motors');
  });
});

describe('what the operator changed on the phone is what prints', () => {
  const lot = LOTS['a painted lot, as it was recorded'];

  test('an edited quantity, a removed row, an added one', async () => {
    document.body.innerHTML = `${PRINT_PARTIAL}<div id="mapp-toast-stack"></div>`;
    MApp.Api.callCached = jest.fn(async method => ({
      success: true, data: { getItemsData: ITEMS, getColors: COLORS, getProcessData: PROCESSES }[method]
    }));
    const sheet = MApp.ProductionSheet;
    sheet.lot = lot;
    sheet.rows = sheet._rowsFor(lot);
    sheet.rows.find(r => r.itemName === 'Primer').requiredQty = 7;
    sheet.rows = sheet.rows.filter(r => r.itemName !== 'Poly Bag');
    sheet.rows.push({ itemName: 'Brake Cable', size: 'GENERAL', narration: '', color: '', requiredQty: 40 });

    const data = sheet.sheetData(lot, sheet._components(), await sheet._lookups());
    expect(data.common.find(r => r.name.startsWith('Primer')).qty).toBe('7');
    expect(data.common.find(r => r.name === 'Brake Cable').qty).toBe('40');
    expect(data.subGroups).toEqual([]);
  });

  test('a recorded component keeps what desktop reads off it', () => {
    const sheet = MApp.ProductionSheet;
    sheet.lot = lot;
    sheet.rows = sheet._rowsFor(lot);
    const pool = sheet._components().find(c => c.itemName === 'Painted Mudguard');
    expect(pool).toMatchObject({ sourceType: 'POOL', poolColor: 'Wine', colorGroup: 'Red', requiredQty: 20 });
  });
});

describe('desktop\'s Print options', () => {
  const lot = LOTS['a painted lot, as it was recorded'];

  test('the page and every column, as desktop lists them', async () => {
    const { opts } = await phoneSheet(lot);
    const labels = opts.toggles.map(t => (t.on() ? t.onLabel : t.offLabel));
    expect(labels).toEqual(['Page: portrait', 'Blue: printed', 'Red: printed', 'KIT BAG 20": printed']);
  });

  test('a column left off is left off the sheet, not the lot', async () => {
    const { opts } = await phoneSheet(lot);
    opts.toggles.find(t => t.onLabel === 'Red: printed').flip();
    const build = jest.spyOn(PrintTemplates, 'productionSheet');
    await opts.populate();
    expect(build.mock.calls[0][0].excluded).toEqual(['Red']);
    const heads = [...document.querySelectorAll('#print-production-sheet-matrix-tables th')].map(th => th.textContent.trim());
    expect(heads).not.toContain('Red');
    expect(heads).toContain('Blue');
  });

  test('landscape is remembered, and reaches the builder and the page', async () => {
    const { opts } = await phoneSheet(lot);
    opts.toggles[0].flip();
    expect(opts.landscape()).toBe(true);
    const build = jest.spyOn(PrintTemplates, 'productionSheet');
    await opts.populate();
    expect(build.mock.calls[0][0].landscape).toBe(true);
    expect(MApp.Prefs.get(MApp.ProductionSheet.PREF_LANDSCAPE, false)).toBe(true);
  });
});
