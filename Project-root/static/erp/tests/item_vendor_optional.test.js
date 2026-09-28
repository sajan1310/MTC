/**
 * Item Master -- a vendor is optional, like its rate, and a vendor saved
 * without a rate is kept.
 *
 * Two faults, one complaint. The desktop dialog's vendor name was
 * `required`, so an item with no vendor could not be saved at all until one
 * was typed in. And a vendor typed without a rate was stored but never read
 * back -- getItemsData dropped every vendor under MIN_VENDOR_RATE -- so the
 * dialog reopened with no vendor, and the next save, which replaces the
 * item's whole vendor list, deleted it. getItemsData now lists those under
 * `unpricedVendors` (tests/erp/test_items.py); this pins both shells' forms.
 *
 * `vendors` itself still holds only priced vendors: bill and PO rate fill and
 * BOM costing read every entry there as a price.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const PARTIAL = f => fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', f), 'utf8');

const ITEM = {
  name: 'Spoke Nipple', size: '14G', remarks: '', narration: '', specification: '',
  baseUnit: 'Pcs', purchaseUnit: 'Pcs', weightPerBaseUnit: 0, image: '',
  vendors: [{ vendor: 'Hero Parts', rate: 12, ratePerBaseUnit: 12 }],
  unpricedVendors: ['Avon Cycles']
};
const BARE = {
  name: 'Hub Axle', size: '', remarks: '', narration: '', specification: '',
  baseUnit: 'Pcs', purchaseUnit: 'Pcs', weightPerBaseUnit: 0, image: '',
  vendors: [], unpricedVendors: []
};
const copy = item => JSON.parse(JSON.stringify(item));

describe('the desktop item dialog', () => {
  function loadItems() {
    // eslint-disable-next-line no-eval
    eval([
      read('api.js').replace(/^const Api = /m, 'global.Api = '),
      'global.escapeHtml = escapeHtml;',
      'global.toNumber = toNumber;',
      'global.formatCurrency = formatCurrency;'
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

    // items.js wires its form up on DOMContentLoaded, which this document
    // fired long ago -- so its handler is caught on the way in and run here.
    const ready = [];
    const spy = jest.spyOn(document, 'addEventListener').mockImplementation((type, fn, opts) => {
      if (type === 'DOMContentLoaded') ready.push(fn);
      else EventTarget.prototype.addEventListener.call(document, type, fn, opts);
    });
    try {
      // eslint-disable-next-line no-eval
      eval(read('items.js'));
    } finally {
      spy.mockRestore();
    }
    ready.forEach(fn => fn());
  }

  const rows = () => [...document.querySelectorAll('#itemVendorsBody tr')].map(tr => ({
    vendor: tr.querySelector('.item-vendor-name').value,
    rate: tr.querySelector('.item-vendor-rate').value,
    required: tr.querySelector('.item-vendor-name').required
  }));
  const form = () => document.getElementById('itemForm');

  beforeEach(() => {
    jest.resetModules();
    document.body.innerHTML = PARTIAL('items.html');
    loadItems();
    App.State.globalItems = [copy(ITEM), copy(BARE)];
    App.State.filteredItems = [...App.State.globalItems];
    App.Item.loadProcessesForItem = jest.fn();
  });

  afterEach(() => {
    delete global.App;
  });

  test('a vendor saved without a rate opens in the dialog, its rate blank', () => {
    App.Item.openEditModal('Spoke Nipple', '14G');
    expect(rows()).toEqual([
      { vendor: 'Hero Parts', rate: '12', required: true },
      { vendor: 'Avon Cycles', rate: '', required: false }
    ]);
  });

  test('saving untouched sends it back, so the save does not delete it', () => {
    App.Item.openEditModal('Spoke Nipple', '14G');
    expect(JSON.parse(App.Item.serializeForm().formData.vendors)).toEqual([
      { vendor: 'Hero Parts', rate: 12 },
      { vendor: 'Avon Cycles', rate: 0 }
    ]);
  });

  test('an item with no vendor saves without one being typed', () => {
    App.Item.openEditModal('Hub Axle', '');
    expect(rows()).toEqual([{ vendor: '', rate: '', required: false }]);
    expect(form().checkValidity()).toBe(true);
    expect(JSON.parse(App.Item.serializeForm().formData.vendors)).toEqual([]);
  });

  test('a rate asks for the vendor it belongs to, and clearing it stops asking', () => {
    // Without a vendor the rate would be dropped on save without a word.
    App.Item.openEditModal('Hub Axle', '');
    const rate = document.querySelector('#itemVendorsBody .item-vendor-rate');

    rate.value = '5';
    rate.dispatchEvent(new Event('input', { bubbles: true }));
    expect(form().checkValidity()).toBe(false);
    expect(document.querySelector('#itemVendorsBody .item-vendor-name').validity.valueMissing).toBe(true);

    rate.value = '';
    rate.dispatchEvent(new Event('input', { bubbles: true }));
    expect(form().checkValidity()).toBe(true);
  });

  test('a new item\'s blank vendor row does not block saving either', () => {
    App.Item.openCreateModal();
    document.getElementById('formItemName').value = 'Brake Shoe';
    expect(rows()).toEqual([{ vendor: '', rate: '', required: false }]);
    expect(form().checkValidity()).toBe(true);
  });

  test('neither column heading marks its field required', () => {
    const headings = [...document.querySelectorAll('#itemModal thead th')].map(th => th.textContent);
    expect(headings.some(h => h.includes('*'))).toBe(false);
    expect(headings.filter(h => h.includes('(optional)'))).toHaveLength(2);
  });

  test('the list shows the vendor with no rate, and finds the item by it', () => {
    const html = App.Item.rowHtml(App.State.globalItems[0]);
    expect(html).toContain('Hero Parts');
    expect(html).toContain('Avon Cycles');
    expect(html).toContain('no rate');

    expect(App.Item.getColumnFilterOptions('vendor').map(o => o.value))
      .toEqual(['Avon Cycles', 'Hero Parts']);

    App.Item.filterData('avon');
    expect(App.State.filteredItems.map(i => i.name)).toEqual(['Spoke Nipple']);

    App.State.itemColumnFilters.vendor = ['Avon Cycles'];
    expect(App.Item.applyColumnFilters(App.State.globalItems).map(i => i.name)).toEqual(['Spoke Nipple']);
  });
});

describe('the phone item form', () => {
  beforeEach(() => {
    jest.resetModules();
    global.fetch = jest.fn();
    document.body.innerHTML = `
      <div id="mapp-sheet-backdrop"></div>
      <div class="mb-sheet" id="sheet-item-form">
        <h2 id="item-form-title">Add Item</h2>
        <div id="item-form-body"></div>
        <button id="item-form-delete-btn">Delete</button>
        <button id="item-form-save-btn">Save</button>
      </div>`;
    // eslint-disable-next-line no-eval
    eval(read('api.js').replace(/^const Api = /m, 'global.Api = '));
    // eslint-disable-next-line no-eval
    eval(read('mobile.js').replace(/^const MApp = /m, 'global.MApp = '));
    MApp.Sheet._stack = [];
  });

  const rateInputs = () =>
    [...document.querySelectorAll('#item-form-vendor-rows input[type="number"]')].map(i => i.value);

  test('a vendor saved without a rate is on the form, its rate blank', () => {
    MApp.Items.openForm(copy(ITEM));
    expect(MApp.Items.vendorRows).toEqual([
      { vendor: 'Hero Parts', rate: 12 },
      { vendor: 'Avon Cycles', rate: '' }
    ]);
    expect(rateInputs()).toEqual(['12', '']);
  });

  test('saving sends it back, so the save does not delete it', async () => {
    let sent = null;
    MApp.Util.mutateSimple = jest.fn(async (method, args) => { sent = args[0]; return { success: false }; });
    MApp.Items.openForm(copy(ITEM));

    await MApp.Items.saveItem();

    expect(JSON.parse(sent.vendors)).toEqual([
      { vendor: 'Hero Parts', rate: 12 },
      { vendor: 'Avon Cycles', rate: '' }
    ]);
  });

  test('a new vendor row starts with its rate blank, and a cleared rate stays blank', () => {
    MApp.Items.openForm(null);
    MApp.Items.addVendorRow();
    expect(rateInputs()).toEqual(['']);

    MApp.Items.updateVendorRow(0, 'rate', '7');
    expect(MApp.Items.vendorRows[0].rate).toBe(7);
    MApp.Items.updateVendorRow(0, 'rate', '');
    MApp.Items.addVendorRow();
    expect(rateInputs()).toEqual(['', '']);
  });
});
