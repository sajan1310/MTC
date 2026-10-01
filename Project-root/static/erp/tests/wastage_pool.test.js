/**
 * The Return tab's Wastage sub-tab, and wastage written off the Warehouse
 * Pool (migration 048).
 *
 * Wastage review used to be a collapsible section under the returns table:
 * "Review Wastage", then a scroll past every return to reach it. It is a
 * sub-tab of its own now, the way Stock splits Items Stock from the
 * Warehouse Pool.
 *
 * And a processed item -- a painted frame with a run in it -- can be written
 * off the pool it sits in. The form gains a second table for those: the
 * item from the pool's own list, then the colour (bucket) it was made in.
 *
 * Mounted from the real partial with the real modules, as
 * form_item_lists.test.js mounts them. Only Api.call/Api.mutate are
 * replaced, answering the way the server would.
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
    // eslint-disable-next-line no-eval
    eval(read('dispatch.js'));
  } finally {
    spy.mockRestore();
  }
  ready.forEach(fn => fn());
}

const PROCESSES = [
  { processId: 'P1', processName: 'Painting 20 inch', outputItemName: 'Painted Frame 20' },
  { processId: 'P2', processName: 'Rim Fitting', outputItemName: 'Fitted Rim 20' }
];

const POOL = [
  { rowIdx: 1, outputItemName: 'Painted Frame 20', processId: 'P1', productTag: '', color: 'Red-White',
    producedQty: 10, consumedQty: 3, availableQty: 7, countsTowardTotal: true },
  { rowIdx: 2, outputItemName: 'Painted Frame 20', processId: 'P1', productTag: '', color: 'Blue-White',
    producedQty: 50, consumedQty: 8, availableQty: 42, countsTowardTotal: true },
  // A sub-group recorded on units already counted under their main colour:
  // it holds no stock of its own, so it is never offered.
  { rowIdx: 3, outputItemName: 'Painted Frame 20', processId: 'P1', productTag: '', color: 'Kit Bag',
    producedQty: 10, consumedQty: 0, availableQty: 10, countsTowardTotal: false },
  { rowIdx: 4, outputItemName: 'Fitted Rim 20', processId: 'P2', productTag: '', color: '',
    producedQty: 30, consumedQty: 0, availableQty: 30, countsTowardTotal: true },
  // Only a sub-group bucket: the item itself never appears either.
  { rowIdx: 5, outputItemName: 'Packing Set', processId: 'P2', productTag: '', color: 'Kit Bag',
    producedQty: 4, consumedQty: 0, availableQty: 4, countsTowardTotal: false }
];

const ITEM_RECORD = {
  wastageId: 'WST-20260912-101500', date: '12/09/2026', dateRaw: '2026-09-12', vendor: '',
  remarks: '', totalQty: 2,
  items: [{ name: 'Hub Axle', size: '', qty: 2, unit: 'Pcs', reason: 'Bent in cutting', sourceType: 'ITEM', color: '', productTag: '' }]
};
const POOL_RECORD = {
  wastageId: 'WST-20260915-090000', date: '15/09/2026', dateRaw: '2026-09-15', vendor: '',
  remarks: '', totalQty: 5,
  items: [
    { name: 'Hub Axle', size: '', qty: 1, unit: 'Pcs', reason: 'Bent', sourceType: 'ITEM', color: '', productTag: '' },
    { name: 'Painted Frame 20', size: '', qty: 3, unit: 'Pcs', reason: 'Paint run', sourceType: 'POOL', color: 'Blue-White', productTag: '' },
    // Saved against a colour the pool has since lost.
    { name: 'Painted Frame 20', size: '', qty: 1, unit: 'Pcs', reason: 'Dent', sourceType: 'POOL', color: 'Green', productTag: '' }
  ]
};

const SERVER = {
  getItemsData: [
    { name: 'Hub Axle', size: '', narration: '', baseUnit: 'Pcs', purchaseUnit: 'Pcs',
      vendors: [{ vendor: 'Avon Cycles', rate: 30, ratePerBaseUnit: 30 }], unpricedVendors: [] }
  ],
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
  getWastageData: [POOL_RECORD, ITEM_RECORD],
  getWarehousePoolData: POOL,
  getBillData: [],
  getStockData: [],
  getIssueData: []
};

let calls;
let errors;

const options = id => [...document.querySelectorAll(`#${id} option`)].map(o => o.value).filter(Boolean);
const shown = id => document.getElementById(id).style.display !== 'none';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  jest.resetModules();
  document.body.innerHTML = PARTIAL('return_ledger.html') + DATALISTS;
  loadDesktop();

  // Process Master supplies only the names beside each pool item.
  App.Process = {
    ensureLoaded: jest.fn(async () => { App.State.globalProcesses = PROCESSES; })
  };
  App.Production = { formatQty: n => String(n) };

  calls = [];
  Api.call = jest.fn(method => {
    calls.push(method);
    const data = JSON.parse(JSON.stringify(SERVER[method] || []));
    return new Promise(resolve => setTimeout(() => resolve({ success: true, data }), 0));
  });
  Api.mutate = jest.fn(async () => ({ success: true, data: { wastageId: 'WST-NEW' }, message: 'Wastage WST-NEW logged successfully.' }));
  errors = [];
  App.Utils.showToast = (msg, isError) => { if (isError) errors.push(msg); };
});

afterEach(() => {
  delete global.App;
});

describe('the Return tab', () => {
  test('opens on Returns; Wastage is a sub-tab, not a section below the table', () => {
    expect(shown('returnsSubTab')).toBe(true);
    expect(shown('wastageSubTab')).toBe(false);
    expect(document.getElementById('btn-returnsSubTab').classList.contains('active')).toBe(true);
    // The old way in is gone: no toggle, no collapsible section.
    expect(document.getElementById('btnToggleWastageReview')).toBeNull();
    expect(document.getElementById('wastageReviewSection')).toBeNull();
  });

  test('the Wastage pill shows the wastage list, and loads it', async () => {
    await App.Return.switchSubTab('wastageSubTab');

    expect(shown('wastageSubTab')).toBe(true);
    expect(shown('returnsSubTab')).toBe(false);
    expect(document.getElementById('btn-wastageSubTab').classList.contains('active')).toBe(true);
    expect(document.getElementById('btn-returnsSubTab').classList.contains('active')).toBe(false);
    expect(calls).toContain('getWastageData');
    const listed = document.getElementById('wastageTableBody').textContent;
    expect(listed).toContain('WST-20260912-101500');
    expect(listed).toContain('WST-20260915-090000');
  });

  test('each sub-tab carries its own actions', () => {
    const returns = document.getElementById('returnsSubTab').textContent;
    const wastage = document.getElementById('wastageSubTab').textContent;
    expect(returns).toContain('Return Goods');
    expect(returns).not.toContain('Log Wastage');
    expect(wastage).toContain('Log Wastage');
    expect(wastage).not.toContain('Return Goods');
  });

  test('coming back to the tab refreshes whichever sub-tab is showing', async () => {
    await App.Return.enterTab();
    expect(calls.filter(m => m === 'getWastageData')).toHaveLength(0);

    await App.Return.switchSubTab('wastageSubTab');
    calls.length = 0;
    await App.Return.enterTab();
    expect(calls).toEqual(expect.arrayContaining(['getReturnData', 'getWastageData']));
  });

  test('a notification about a return lands on the Returns sub-tab', async () => {
    await App.Return.switchSubTab('wastageSubTab');
    App.Return.openEditModal = jest.fn();

    await App.Notify.NAV.return.goto('RET-101');

    expect(shown('returnsSubTab')).toBe(true);
    expect(shown('wastageSubTab')).toBe(false);
    expect(App.Return.openEditModal).toHaveBeenCalledWith(0);
  });
});

describe('the wastage list', () => {
  beforeEach(async () => {
    await App.Return.switchSubTab('wastageSubTab');
  });

  test('marks a line written off the pool, with its colour', () => {
    const row = [...document.querySelectorAll('#wastageTableBody tr')]
      .find(tr => tr.textContent.includes('WST-20260915-090000'));
    expect(row.textContent).toContain('Painted Frame 20 (Blue-White) ×3');
    expect(row.querySelector('.badge').textContent).toBe('Pool');
  });

  test('"pool" finds the records written off the Warehouse Pool, and a colour finds its record', () => {
    App.Wastage.filterData('pool');
    expect(App.State.filteredWastage.map(w => w.wastageId)).toEqual(['WST-20260915-090000']);

    App.Wastage.filterData('blue-white');
    expect(App.State.filteredWastage.map(w => w.wastageId)).toEqual(['WST-20260915-090000']);
  });
});

describe('Log Wastage, from the Warehouse Pool', () => {
  const poolRow = () => document.querySelector('#wastagePoolItemsBody tr:last-child');
  const typeItem = (row, name) => {
    const input = row.querySelector('.wp-item-name');
    input.value = name;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const submit = () => App.Wastage.submit({ preventDefault() {} });

  beforeEach(async () => {
    await App.Wastage.openWastageModal();
  });

  test('offers the pool\'s processed items, by process, and none that is only a sub-group', () => {
    expect(options('wastagePoolItemList')).toEqual(['Fitted Rim 20', 'Painted Frame 20']);
    const frame = document.querySelector('#wastagePoolItemList option[value="Painted Frame 20"]');
    expect(frame.getAttribute('label')).toBe('Painting 20 inch');
  });

  test('starts with nothing from the pool, and says so', () => {
    expect(document.querySelectorAll('#wastagePoolItemsBody tr')).toHaveLength(0);
    expect(shown('wastagePoolEmptyHint')).toBe(true);

    App.Wastage.addPoolRow();
    expect(document.querySelectorAll('#wastagePoolItemsBody tr')).toHaveLength(1);
    expect(shown('wastagePoolEmptyHint')).toBe(false);

    // The last pool row can go, unlike the last Items Stock row.
    App.Wastage.removePoolRow(poolRow().querySelector('.wp-remove'));
    expect(document.querySelectorAll('#wastagePoolItemsBody tr')).toHaveLength(0);
    expect(shown('wastagePoolEmptyHint')).toBe(true);
  });

  test('an item made in one colour takes it; one made in several waits to be told', () => {
    App.Wastage.addPoolRow();
    typeItem(poolRow(), 'Fitted Rim 20');
    expect(poolRow().querySelector('.wp-bucket').value).toBe(SEP);

    typeItem(poolRow(), 'Painted Frame 20');
    const select = poolRow().querySelector('.wp-bucket');
    expect(select.value).toBe('');
    const labels = [...select.options].map(o => o.textContent);
    expect(labels).toEqual([
      'Choose a colour…',
      'Blue-White — 42 available',
      'Red-White — 7 available'
    ]);
  });

  test('a record of nothing but pool lines saves past the blank Items Stock row', async () => {
    App.Wastage.addPoolRow();
    const row = poolRow();
    typeItem(row, 'Painted Frame 20');
    row.querySelector('.wp-bucket').value = `${SEP}Blue-White`;
    row.querySelector('.wp-qty').value = '3';
    row.querySelector('.wp-reason').value = 'Paint run';

    // The browser's own validation would stop a submit at the first
    // required field -- the Items Stock row left blank must not be one.
    expect(document.getElementById('wastageForm').checkValidity()).toBe(true);

    await submit();

    expect(errors).toEqual([]);
    expect(Api.mutate).toHaveBeenCalledTimes(1);
    const [method, form] = Api.mutate.mock.calls[0];
    expect(method).toBe('saveWastage');
    expect(JSON.parse(form.items)).toEqual([{
      sourceType: 'POOL', name: 'Painted Frame 20', productTag: '', color: 'Blue-White',
      qty: 3, unit: 'Pcs', reason: 'Paint run'
    }]);
  });

  test('one record can hold both kinds of line', async () => {
    const itemRow = document.querySelector('#wastageItemsBody tr');
    itemRow.querySelector('.w-item-name').value = 'Hub Axle';
    itemRow.querySelector('.w-item-qty').value = '2';
    itemRow.querySelector('.w-item-reason').value = 'Bent';

    App.Wastage.addPoolRow();
    typeItem(poolRow(), 'Fitted Rim 20');
    poolRow().querySelector('.wp-qty').value = '1';
    poolRow().querySelector('.wp-reason').value = 'Out of true';

    await submit();

    const items = JSON.parse(Api.mutate.mock.calls[0][1].items);
    expect(items.map(i => [i.sourceType, i.name, i.color])).toEqual([
      ['ITEM', 'Hub Axle', undefined],
      ['POOL', 'Fitted Rim 20', '']
    ]);
  });

  test('a processed item with no colour chosen is refused, by name', async () => {
    App.Wastage.addPoolRow();
    typeItem(poolRow(), 'Painted Frame 20');
    poolRow().querySelector('.wp-qty').value = '3';
    poolRow().querySelector('.wp-reason').value = 'Paint run';

    await submit();

    expect(errors).toEqual(['Choose which colour of "Painted Frame 20" was wasted.']);
    expect(Api.mutate).not.toHaveBeenCalled();
  });

  test('an item the pool does not hold is named as such', async () => {
    App.Wastage.addPoolRow();
    typeItem(poolRow(), 'Mystery Frame');

    await submit();

    expect(errors).toEqual(['"Mystery Frame" is not in the Warehouse Pool. Pick it from the list.']);
    expect(Api.mutate).not.toHaveBeenCalled();
  });

  test('a pool line still needs a quantity and a reason', async () => {
    App.Wastage.addPoolRow();
    typeItem(poolRow(), 'Fitted Rim 20');

    await submit();
    expect(errors).toEqual(['Enter a quantity for "Fitted Rim 20".']);

    errors.length = 0;
    poolRow().querySelector('.wp-qty').value = '1';
    await submit();
    expect(errors).toEqual(['Please enter a reason for "Fitted Rim 20".']);
    expect(Api.mutate).not.toHaveBeenCalled();
  });

  test('once saved, the pool rows lock with the rest of the form', async () => {
    App.Wastage.addPoolRow();
    typeItem(poolRow(), 'Fitted Rim 20');
    poolRow().querySelector('.wp-qty').value = '1';
    poolRow().querySelector('.wp-reason').value = 'Out of true';

    await submit();
    await tick();

    const row = poolRow();
    expect(row.querySelector('.wp-item-name').disabled).toBe(true);
    expect(row.querySelector('.wp-bucket').disabled).toBe(true);
    expect(row.querySelector('.wp-remove').disabled).toBe(true);
    expect([...document.querySelectorAll('.wastage-add-btn')].every(b => b.disabled)).toBe(true);
  });
});

describe('editing a record with pool lines', () => {
  beforeEach(async () => {
    await App.Wastage.loadData();
    await App.Wastage.openEditModal('WST-20260915-090000');
  });

  test('puts each line in its own table', () => {
    const itemNames = [...document.querySelectorAll('#wastageItemsBody .w-item-name')].map(i => i.value);
    const poolNames = [...document.querySelectorAll('#wastagePoolItemsBody .wp-item-name')].map(i => i.value);
    expect(itemNames).toEqual(['Hub Axle']);
    expect(poolNames).toEqual(['Painted Frame 20', 'Painted Frame 20']);

    const first = document.querySelector('#wastagePoolItemsBody tr .wp-bucket');
    expect(first.value).toBe(`${SEP}Blue-White`);
  });

  test('keeps a colour the pool no longer lists, rather than dropping the write-off', () => {
    const second = document.querySelectorAll('#wastagePoolItemsBody .wp-bucket')[1];
    expect(second.value).toBe(`${SEP}Green`);
    expect(second.selectedOptions[0].textContent).toBe('Green — no longer in the pool');
  });

  test('saves both pool lines back as they were', async () => {
    await App.Wastage.submit({ preventDefault() {} });

    const items = JSON.parse(Api.mutate.mock.calls[0][1].items);
    expect(items.filter(i => i.sourceType === 'POOL').map(i => i.color)).toEqual(['Blue-White', 'Green']);
    expect(Api.mutate.mock.calls[0][1].existingWastageId).toBe('WST-20260915-090000');
  });
});

describe('the wastage note', () => {
  const deps = () => ({ esc: escapeHtml, nameCase: s => s });

  test('names a pool line by its colour and says it came off the Warehouse Pool', () => {
    const html = PrintTemplates.wastageNote(POOL_RECORD, deps());
    expect(html).toContain('Painted Frame 20 <em>(Blue-White)</em>');
    expect(html).toContain('Warehouse Pool');
  });

  test('an Items Stock line prints exactly as before', () => {
    const html = PrintTemplates.wastageNote(ITEM_RECORD, deps());
    expect(html).toContain('Hub Axle</td>');
    expect(html).not.toContain('Warehouse Pool');
  });
});

describe('Ready to Dispatch', () => {
  test('finished goods written off are named under Ready, so the row adds up', () => {
    expect(App.Dispatch.wastedNote(2)).toContain('2 wasted');
    expect(App.Dispatch.wastedNote(0)).toBe('');
    expect(App.Dispatch.wastedNote(undefined)).toBe('');
  });
});
