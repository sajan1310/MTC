/**
 * Return, Wastage and Issue Stock -- the item list is there when the form
 * opens.
 *
 * Every row's Item box suggests from the page-wide #itemList datalist, which
 * only App.Item.populateDatalists fills, and that runs only when Items Master
 * loads. Since tabs load lazily, nothing on the Return tab loaded it (its
 * loadData ensured Vendor Master and Bill history, not Items), and the
 * Dashboard's Quick Actions open these forms without loading anything. So on
 * a session that had not first visited Items Master, PO, Bill or Production,
 * Return Goods and Log Wastage opened with an empty item list -- and Return
 * Goods from the Dashboard with an empty vendor dropdown as well. Issue Stock
 * was fine from Production, which loads Items, but not from its Dashboard tile.
 *
 * Mounted from the real partials in index.html's order, with the real
 * modules loaded the way bill_edit_remarks.test.js loads its own. Only
 * Api.call is replaced, answering each read the way the server would.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const PARTIAL = f => fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', f), 'utf8');

// index.html's own global datalists, which no partial carries.
const DATALISTS = ['itemList', 'vendorList', 'sizeList', 'narrationList', 'unitList']
  .map(id => `<datalist id="${id}"></datalist>`).join('');

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

  // return.js wires each row's size filter up on DOMContentLoaded, which this
  // document fired long ago -- so its handlers are caught on the way in and
  // run here. The other modules' handlers wire forms these tests never touch.
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
    // eslint-disable-next-line no-eval
    eval(read('issue.js'));
  } finally {
    spy.mockRestore();
  }
  ready.forEach(fn => fn());
}

const ITEMS = [
  { name: 'Spoke Nipple', size: '14G', narration: '', baseUnit: 'Pcs', purchaseUnit: 'Pcs',
    vendors: [{ vendor: 'Hero Parts', rate: 12, ratePerBaseUnit: 12 }], unpricedVendors: [] },
  { name: 'Spoke Nipple', size: '12G', narration: '', baseUnit: 'Pcs', purchaseUnit: 'Pcs',
    vendors: [{ vendor: 'Hero Parts', rate: 14, ratePerBaseUnit: 14 }], unpricedVendors: [] },
  { name: 'Hub Axle', size: '', narration: '', baseUnit: 'Pcs', purchaseUnit: 'Pcs',
    vendors: [{ vendor: 'Avon Cycles', rate: 30, ratePerBaseUnit: 30 }], unpricedVendors: [] }
];

const SERVER = {
  getItemsData: ITEMS,
  getVendorsData: [
    { name: 'Hero Parts', contact: '98140 00001' },
    { name: 'Avon Cycles', contact: '' }
  ],
  // At least one PO and one return: ensureLoaded counts an empty list as
  // not loaded, and Vendor.loadData ensures both while PO.loadData and
  // Return.loadData each ensure Vendor Master back -- so with none, they
  // reload each other forever. A separate, older fault; real data has both.
  getPOData: [{
    poNumber: '1204', poDate: '10/09/2026', poDateRaw: '2026-09-10', vendor: 'Hero Parts', contact: '',
    poRemarks: '', status: 'Issued', grandTotal: 1200, totalQty: 100,
    items: [{ name: 'Spoke Nipple', size: '14G', narration: '', qty: 100, unit: 'Pcs', price: 12 }]
  }],
  getReturnData: [{
    returnNumber: 'RET-101', billNumber: '', vendor: 'Hero Parts', contact: '98140 00001',
    returnDate: '12/09/2026', returnDateRaw: '2026-09-12', remarks: '', totalQty: 5, totalAmount: 60,
    items: [{ name: 'Spoke Nipple', size: '14G', narration: '', unit: 'Pcs', qty: 5, price: 12, reason: 'Defective' }]
  }],
  getWastageData: [{
    wastageId: 'WST-20260912-101500', date: '12/09/2026', dateRaw: '2026-09-12', vendor: '',
    remarks: '', totalQty: 2,
    items: [{ name: 'Hub Axle', size: '', qty: 2, unit: 'Pcs', reason: 'Bent in cutting' }]
  }],
  getBillData: [],
  getStockData: [],
  getIssueData: []
};

let calls;
let errors;

const options = id => [...document.querySelectorAll(`#${id} option`)].map(o => o.value).filter(Boolean);
const ITEM_NAMES = ['Spoke Nipple', 'Hub Axle'];

beforeEach(() => {
  jest.resetModules();
  document.body.innerHTML = [
    'dashboard.html', 'vendors.html', 'items.html', 'po_ledger.html',
    'bill_ledger.html', 'return_ledger.html', 'production.html'
  ].map(PARTIAL).join('') + DATALISTS;
  loadDesktop();

  calls = [];
  // Answered on a later task, as the network would: a runaway reload loop
  // then fails on Jest's timeout instead of starving it of a turn.
  Api.call = jest.fn(method => {
    calls.push(method);
    const data = JSON.parse(JSON.stringify(SERVER[method] || []));
    return new Promise(resolve => setTimeout(() => resolve({ success: true, data }), 0));
  });
  errors = [];
  App.Utils.showToast = (msg, isError) => { if (isError) errors.push(msg); };
});

afterEach(() => {
  delete global.App;
});

describe('from the Dashboard, on a session that never opened Items Master', () => {
  test('Return Goods lists every item, and every vendor', async () => {
    await App.Return.openReturnModal();

    expect(options('itemList')).toEqual(ITEM_NAMES);
    expect(document.querySelector('#returnItemsBody .r-item-name').getAttribute('list')).toBe('itemList');
    expect(options('returnVendor')).toEqual(['Avon Cycles', 'Hero Parts']);
    expect(errors).toEqual([]);
  });

  test('Log Wastage lists every item, and suggests vendors', async () => {
    await App.Wastage.openWastageModal();

    expect(options('itemList')).toEqual(ITEM_NAMES);
    expect(document.querySelector('#wastageItemsBody .w-item-name').getAttribute('list')).toBe('itemList');
    expect(options('vendorList')).toEqual(['Hero Parts', 'Avon Cycles']);
    expect(errors).toEqual([]);
  });

  test('Issue Stock lists every item', async () => {
    await App.Issue.openIssueModal();

    expect(options('itemList')).toEqual(ITEM_NAMES);
    expect(document.querySelector('#issueItemsBody .i-item-name').getAttribute('list')).toBe('itemList');
    expect(errors).toEqual([]);
  });
});

describe('on the Return tab', () => {
  beforeEach(async () => {
    await App.Return.loadData();
    await App.Wastage.loadData();
  });

  test('Log Return lists every item', async () => {
    await App.Return.openReturnModal();
    expect(options('itemList')).toEqual(ITEM_NAMES);
  });

  test('Log Wastage lists every item', async () => {
    await App.Wastage.openWastageModal();
    expect(options('itemList')).toEqual(ITEM_NAMES);
  });

  test('editing a return lists every item for a line added to it', async () => {
    await App.Return.openEditModal(0);

    expect(options('itemList')).toEqual(ITEM_NAMES);
    expect(document.querySelector('#returnItemsBody .r-item-name').value).toBe('Spoke Nipple');
    expect(document.getElementById('returnContact').value).toBe('98140 00001');
  });

  test('editing a wastage record lists every item for a line added to it', async () => {
    await App.Wastage.openEditModal('WST-20260912-101500');

    expect(options('itemList')).toEqual(ITEM_NAMES);
    expect(document.querySelector('#wastageItemsBody .w-item-name').value).toBe('Hub Axle');
  });

  test('choosing an item offers only its own sizes', async () => {
    await App.Return.openReturnModal();
    const name = document.querySelector('#returnItemsBody .r-item-name');
    name.value = 'Spoke Nipple';
    name.dispatchEvent(new Event('input', { bubbles: true }));

    const row = name.closest('tr');
    expect([...row.querySelectorAll('datalist.row-size-list option')].map(o => o.value)).toEqual(['14G', '12G']);
  });
});

test('Items Master is fetched once, not on every form opened', async () => {
  await App.Return.openReturnModal();
  await App.Return.openReturnModal();
  await App.Wastage.openWastageModal();
  await App.Issue.openIssueModal();

  expect(calls.filter(m => m === 'getItemsData')).toHaveLength(1);
});
