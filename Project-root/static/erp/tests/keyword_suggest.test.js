/**
 * The Item boxes on Return Goods and Log Wastage search by keyword
 * (App.KeywordSuggest, core.js).
 *
 * They used the browser's datalist, which matched what was typed as one
 * piece: "26 rim" found nothing, because no item is called that -- the item
 * is Rim, in size 26. Now every word typed must appear somewhere in the item,
 * in any order, across its name and size (and, for the Warehouse Pool, the
 * processes that make it). The phone's pickers already searched this way.
 *
 * Mounted from the real partial with the real modules, as
 * wastage_pool.test.js mounts them. Only Api.call/Api.mutate are replaced.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const PARTIAL = f => fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', f), 'utf8');

const DATALISTS = ['itemList', 'vendorList', 'sizeList', 'narrationList', 'unitList']
  .map(id => `<datalist id="${id}"></datalist>`).join('');

const SEP = '␟';

function loadDesktop() {
  // eslint-disable-next-line no-eval
  eval([
    read('api.js').replace(/^const Api = /m, 'global.Api = '),
    'global.escapeHtml = escapeHtml;',
    'global.toNumber = toNumber;',
    'global.formatCurrency = formatCurrency;',
    'global.formatQty = formatQty;',
    'global.formatItemsPreview = formatItemsPreview;',
    'global.parseRecordDate = parseRecordDate;',
    'global.dateToInputValue = dateToInputValue;',
    'global.normalizeDateForInput = normalizeDateForInput;',
    'global.inDateRange = inDateRange;',
    'global.todayIso = todayIso;',
    'global.tomorrowIso = tomorrowIso;',
    'global.PO_STATUS = PO_STATUS;'
  ].join('\n'));
  // eslint-disable-next-line no-eval
  eval(read('print-templates.js').replace(/^const PrintTemplates = /m, 'global.PrintTemplates = '));
  // eslint-disable-next-line no-eval
  eval([
    read('core.js').replace(/^const App = /m, 'global.App = '),
    'global.$ = $;',
    'global.$$ = $$;',
    'global.safeModalShow = safeModalShow;',
    'global.safeModalHide = safeModalHide;',
    'global.setDisabled = setDisabled;'
  ].join('\n'));

  // return.js wires its row listeners on DOMContentLoaded, which this
  // document fired long ago -- so they are caught on the way in and run here.
  const ready = [];
  const spy = jest.spyOn(document, 'addEventListener').mockImplementation((type, fn, opts) => {
    if (type === 'DOMContentLoaded') ready.push(fn);
    else EventTarget.prototype.addEventListener.call(document, type, fn, opts);
  });
  try {
    ['vendors.js', 'items.js', 'po.js', 'bill.js'].forEach(f => {
      // eslint-disable-next-line no-eval
      eval(read(f));
    });
    ready.length = 0;
    // eslint-disable-next-line no-eval
    eval(read('return.js'));
  } finally {
    spy.mockRestore();
  }
  ready.forEach(fn => fn());
}

const item = (name, size, baseUnit = 'Pcs') => ({
  name, size, narration: '', baseUnit, purchaseUnit: baseUnit,
  vendors: [{ vendor: 'Avon Cycles', rate: 30, ratePerBaseUnit: 30 }], unpricedVendors: []
});

const ITEMS = [
  item('Rim', '20'),
  item('Rim', '26', 'Pair'),
  item('Rim Tape', ''),
  item('Trim Ring', ''),
  item('Hub Axle', '')
];

const PROCESSES = [
  { processId: 'P1', processName: 'Painting 20 inch', outputItemName: 'Painted Frame 20' },
  { processId: 'P2', processName: 'Rim Fitting', outputItemName: 'Fitted Rim 20' }
];

const POOL = [
  { rowIdx: 1, outputItemName: 'Painted Frame 20', processId: 'P1', productTag: '', color: 'Red-White',
    producedQty: 10, consumedQty: 3, availableQty: 7, countsTowardTotal: true },
  { rowIdx: 2, outputItemName: 'Painted Frame 20', processId: 'P1', productTag: '', color: 'Blue-White',
    producedQty: 50, consumedQty: 8, availableQty: 42, countsTowardTotal: true },
  { rowIdx: 3, outputItemName: 'Fitted Rim 20', processId: 'P2', productTag: '', color: '',
    producedQty: 30, consumedQty: 0, availableQty: 30, countsTowardTotal: true }
];

const SERVER = {
  getItemsData: ITEMS,
  getVendorsData: [{ name: 'Avon Cycles', contact: '' }],
  // At least one PO and one return -- see form_item_lists.test.js: with
  // none, Vendor/PO/Return reload each other forever.
  getPOData: [{
    poNumber: '1204', poDate: '10/09/2026', poDateRaw: '2026-09-10', vendor: 'Avon Cycles', contact: '',
    poRemarks: '', status: 'Issued', grandTotal: 300, totalQty: 10,
    items: [{ name: 'Hub Axle', size: '', narration: '', qty: 10, unit: 'Pcs', price: 30 }]
  }],
  getReturnData: [{
    returnNumber: 'RET-101', billNumber: '', vendor: 'Avon Cycles', contact: '',
    returnDate: '12/09/2026', returnDateRaw: '2026-09-12', remarks: '', totalQty: 1, totalAmount: 30,
    items: [{ name: 'Hub Axle', size: '', narration: '', unit: 'Pcs', qty: 1, price: 30, reason: 'Defective' }]
  }],
  getWastageData: [],
  getWarehousePoolData: POOL,
  getBillData: [],
  getStockData: [],
  getIssueData: []
};

const offered = () => [...document.querySelectorAll('#kwSuggestMenu .kw-suggest-option')]
  .map(o => o.textContent.replace(/\s+/g, ' ').trim());
const menu = () => document.getElementById('kwSuggestMenu');
const menuOpen = () => !!menu() && !menu().hidden;
const type = (input, text) => {
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const press = (input, key) => {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  input.dispatchEvent(e);
  return e;
};

beforeEach(() => {
  jest.resetModules();
  document.body.innerHTML = PARTIAL('return_ledger.html') + DATALISTS;
  loadDesktop();

  App.Process = {
    ensureLoaded: jest.fn(async () => { App.State.globalProcesses = PROCESSES; })
  };
  App.Production = { formatQty: n => String(n) };

  Api.call = jest.fn(method => {
    const data = JSON.parse(JSON.stringify(SERVER[method] || []));
    return new Promise(resolve => setTimeout(() => resolve({ success: true, data }), 0));
  });
  Api.mutate = jest.fn(async () => ({ success: true, data: {} }));
  App.Utils.showToast = () => {};
});

afterEach(() => {
  delete global.App;
});

describe('the matching rule', () => {
  const options = [
    { value: 'Rim Tape', label: 'Rim Tape' },
    { value: 'Trim Ring', label: 'Trim Ring' },
    { value: 'Front Rim', label: 'Front Rim' },
    { value: 'Rim', label: 'Rim', size: '26' },
    { value: 'Painted Frame 20', label: 'Painted Frame 20', sub: 'Painting 20 inch', detail: '49 available' }
  ];
  const labels = term => App.KeywordSuggest.search(options, term).map(o => [o.label, o.size].filter(Boolean).join(' '));

  test('every word must appear, in any order, across the name and the size', () => {
    expect(labels('26 rim')).toEqual(['Rim 26']);
    expect(labels('20 frame')).toEqual(['Painted Frame 20']);
    expect(labels('rim ring')).toEqual(['Trim Ring']);
    expect(labels('rim blue')).toEqual([]);
  });

  test('a name starting with what was typed comes first, a word found inside another word last', () => {
    expect(labels('rim')).toEqual(['Rim 26', 'Rim Tape', 'Front Rim', 'Trim Ring']);
  });

  test('the processes behind a pool item are searched; its figure is not', () => {
    expect(labels('painting')).toEqual(['Painted Frame 20']);
    expect(labels('49')).toEqual([]);
  });

  test('nothing typed offers everything, in the source\'s order', () => {
    expect(labels('  ')).toHaveLength(options.length);
  });
});

describe('Return Goods: the Item box', () => {
  const box = () => document.querySelector('#returnItemsBody .r-item-name');
  const row = () => box().closest('tr');

  beforeEach(async () => {
    await App.Return.openReturnModal();
  });

  test('"26 rim" offers Rim in size 26 and nothing else', () => {
    type(box(), '26 rim');
    expect(menuOpen()).toBe(true);
    expect(offered()).toEqual(['Rim Size 26']);
    // The words typed are marked in what is offered.
    expect([...menu().querySelectorAll('mark')].map(m => m.textContent)).toEqual(['Rim', '26']);
  });

  test('Enter takes the best match: its name, its size and its unit -- and does not submit the form', () => {
    type(box(), '26 rim');
    const e = press(box(), 'Enter');

    expect(e.defaultPrevented).toBe(true);
    expect(menuOpen()).toBe(false);
    expect(box().value).toBe('Rim');
    expect(row().querySelector('.r-item-size').value).toBe('26');
    expect(row().querySelector('.item-unit').value).toBe('Pair');
    expect(Api.mutate).not.toHaveBeenCalled();
  });

  test('the arrows move through the list, and a click picks too', () => {
    type(box(), 'rim');
    expect(offered()).toEqual(['Rim Size 20', 'Rim Size 26', 'Rim Tape', 'Trim Ring']);
    press(box(), 'ArrowDown');
    press(box(), 'ArrowDown');
    expect(menu().querySelector('.active').textContent).toContain('Rim Tape');
    expect(box().getAttribute('aria-activedescendant')).toBe('kwSuggestOpt2');

    menu().querySelectorAll('.kw-suggest-option')[3].click();
    expect(box().value).toBe('Trim Ring');
    expect(row().querySelector('.r-item-size').value).toBe('');
  });

  test('a pick replaces the size of the item it replaces', () => {
    type(box(), 'rim 20');
    press(box(), 'Enter');
    expect(row().querySelector('.r-item-size').value).toBe('20');

    type(box(), 'hub');
    press(box(), 'Enter');
    expect(box().value).toBe('Hub Axle');
    expect(row().querySelector('.r-item-size').value).toBe('');
  });

  test('Escape closes the list and leaves the dialog open', () => {
    const dialogSaw = [];
    document.getElementById('returnGoodsModal').addEventListener('keydown', e => dialogSaw.push(e.key));
    type(box(), 'rim');

    press(box(), 'Escape');
    expect(menuOpen()).toBe(false);
    expect(dialogSaw).toEqual([]);

    // With no list open, Escape reaches the dialog as it always has.
    press(box(), 'Escape');
    expect(dialogSaw).toEqual(['Escape']);
  });

  test('a name typed that is not on the list stays as typed', () => {
    type(box(), 'Brake Shoe');
    expect(offered()).toEqual([]);
    expect(menu().textContent).toContain('Nothing matches every word typed.');

    box().dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(menuOpen()).toBe(false);
    expect(App.Return.serializeForm().items.map(i => i.name)).toEqual(['Brake Shoe']);
  });

  test('the list sits inside the dialog, which keeps focus to itself', () => {
    box().click();
    expect(menu().parentElement.id).toBe('returnGoodsModal');
    expect(box().getAttribute('aria-expanded')).toBe('true');
    expect(offered()).toHaveLength(ITEMS.length);
  });
});

describe('Log Wastage: both Item boxes', () => {
  const poolRow = () => document.querySelector('#wastagePoolItemsBody tr:last-child');

  beforeEach(async () => {
    await App.Wastage.openWastageModal();
  });

  test('an Items Stock row searches Items Master the same way', () => {
    const box = document.querySelector('#wastageItemsBody .w-item-name');
    type(box, 'tape');
    expect(offered()).toEqual(['Rim Tape']);
    press(box, 'Enter');
    expect(box.value).toBe('Rim Tape');
  });

  test('a Warehouse Pool row finds an item by the process that makes it, and its colours follow', () => {
    App.Wastage.addPoolRow();
    const box = poolRow().querySelector('.wp-item-name');
    type(box, 'painting');
    expect(offered()).toEqual(['Painted Frame 20 Painting 20 inch · 49 available']);

    press(box, 'Enter');
    expect(box.value).toBe('Painted Frame 20');
    const colours = [...poolRow().querySelectorAll('.wp-bucket option')].map(o => o.textContent);
    expect(colours).toEqual(['Choose a colour…', 'Blue-White — 42 available', 'Red-White — 7 available']);
  });

  test('words out of order find a pool item, and one colour is taken for it', () => {
    App.Wastage.addPoolRow();
    const box = poolRow().querySelector('.wp-item-name');
    type(box, '20 fitted');
    expect(offered()).toEqual(['Fitted Rim 20 Rim Fitting · 30 available']);
    press(box, 'Enter');
    expect(poolRow().querySelector('.wp-bucket').value).toBe(SEP);
  });

  test('a locked box offers nothing', () => {
    const box = document.querySelector('#wastageItemsBody .w-item-name');
    box.disabled = true;
    box.click();
    press(box, 'ArrowDown');
    expect(menuOpen()).toBe(false);
  });
});
