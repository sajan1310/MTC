/**
 * A Labor Job bill asks where its goods go: Add to Warehouse Pool, or Ledger
 * only. Only the person holding the bill can tell a maker's finished goods
 * from a job worker's, whose goods come back through a lot.
 *
 * So a new bill starts with neither picked and can't be saved until one is,
 * and a saved bill reopens on the answer it was given. The ledger and the pool
 * screens then say what was chosen, and leave a bill's pool entries to the
 * bill.
 *
 * Mounted from the real partials, the way bill_edit_remarks.test.js does.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PARTIAL = f => fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', f), 'utf8');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function loadBill() {
  // eslint-disable-next-line no-eval
  eval([
    read('api.js'),
    'global.escapeHtml = escapeHtml;',
    'global.toNumber = toNumber;',
    'global.todayIso = todayIso;',
    'global.formatItemsPreview = formatItemsPreview;',
  ].join('\n'));
  // eslint-disable-next-line no-eval
  eval([
    read('core.js').replace(/^const App = /m, 'global.App = '),
    'global.$ = $;',
    'global.$$ = $$;',
    'global.safeModalShow = safeModalShow;',
    'global.safeModalHide = safeModalHide;',
    'global.setDisabled = setDisabled;',
  ].join('\n'));
  // eslint-disable-next-line no-eval
  eval(read('bill.js'));
}

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

const LABOR_BILL = over => ({
  billNumber: '1339',
  vendor: 'heato cycles',
  contact: '',
  billDate: '30/10/2026',
  billDateRaw: '2026-10-30',
  remarks: '',
  issuingParty: '',
  manufacturingVendor: '',
  billType: 'LABOR',
  addToPool: false,
  items: [
    {
      name: 'Painted Frame', size: '', narration: '', unit: 'Pcs', qty: 22, price: 915,
      gstRatePct: 0, poNumber: 'DIRECT', processName: 'Frame Making', color: 'Red',
    },
  ],
  ...over,
});

const add = () => document.getElementById('billPoolAdd');
const ledger = () => document.getElementById('billPoolLedger');

describe('the Labor bill form', () => {
  beforeEach(() => {
    jest.resetModules();
    document.body.innerHTML = PARTIAL('vendors.html') + PARTIAL('bill_ledger.html');
    loadBill();
    const ready = { ensureLoaded: async () => {} };
    Object.assign(App, { Process: ready, Contractor: ready, Color: ready, PO: ready, Vendor: ready, Item: ready });
    App.State.globalProcesses = [];
    App.State.globalColors = [];
    App.Utils.showToast = jest.fn();
    global.Api = { call: jest.fn(async () => ({ success: true, data: [] })) };
  });

  afterEach(() => { delete global.Api; });

  test('offers both answers and picks neither', () => {
    expect(add().closest('.labor-only-field')).not.toBeNull();
    expect(add().checked).toBe(false);
    expect(ledger().checked).toBe(false);
  });

  test('the answer goes out with the bill', () => {
    add().checked = true;
    expect(App.Bill.serializeForm().formData.addToPool).toBe('1');

    ledger().checked = true;
    expect(App.Bill.serializeForm().formData.addToPool).toBe('0');
  });

  test('a saved Ledger only bill reopens on Ledger only', async () => {
    App.State.globalBills = [LABOR_BILL()];
    App.State.filteredBills = App.State.globalBills;

    await App.Bill.openEditModal(0);

    expect(ledger().checked).toBe(true);
    expect(add().checked).toBe(false);
  });

  test('a saved pool bill reopens on Add to Warehouse Pool', async () => {
    App.State.globalBills = [LABOR_BILL({ addToPool: true })];
    App.State.filteredBills = App.State.globalBills;

    await App.Bill.openEditModal(0);

    expect(add().checked).toBe(true);
    expect(ledger().checked).toBe(false);
  });

  test('a Goods bill leaves the question unanswered', async () => {
    App.State.globalBills = [LABOR_BILL({ billType: 'GOODS' })];
    App.State.filteredBills = App.State.globalBills;

    await App.Bill.openEditModal(0);

    expect(add().checked).toBe(false);
    expect(ledger().checked).toBe(false);
  });

  describe('saving', () => {
    // The submit handler is bound on DOMContentLoaded, and a mounted page
    // never fires it, so it is fired here.
    const submit = async () => {
      document.dispatchEvent(new Event('DOMContentLoaded'));
      const form = document.getElementById('billForm');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await flush();
    };

    const laborLine = () => {
      App.Bill.serializeForm = jest.fn(() => ({
        formData: { billType: 'LABOR', billNumber: '1339', ...App.Bill.answer },
        items: [{ name: 'Painted Frame', qty: 22 }],
      }));
    };

    beforeEach(() => {
      App.Bill.flushPendingAutoMatch = jest.fn(async () => {});
      global.confirm = jest.fn(() => false);
    });

    test('a new Labor bill with no answer is not saved', async () => {
      App.Bill.answer = {};
      laborLine();

      await submit();

      expect(App.Utils.showToast).toHaveBeenCalledWith('Choose Add to Warehouse Pool or Ledger only.', true);
      expect(Api.call).not.toHaveBeenCalledWith('checkStockAdjustmentConflicts', expect.anything(), expect.anything());
    });

    test('either answer goes on to save', async () => {
      App.Bill.answer = { addToPool: '0' };
      laborLine();

      await submit();

      expect(App.Utils.showToast).not.toHaveBeenCalledWith('Choose Add to Warehouse Pool or Ledger only.', true);
      expect(Api.call).toHaveBeenCalledWith('checkStockAdjustmentConflicts', expect.anything(), undefined);
    });

    test('a Goods bill is not asked', async () => {
      App.Bill.serializeForm = jest.fn(() => ({
        formData: { billType: 'GOODS', billNumber: '77' },
        items: [{ name: 'Carton', qty: 1 }],
      }));

      await submit();

      expect(App.Utils.showToast).not.toHaveBeenCalledWith('Choose Add to Warehouse Pool or Ledger only.', true);
    });
  });
});

describe('the Bill Ledger badge', () => {
  beforeAll(() => {
    // eslint-disable-next-line no-eval
    eval(`${read('api.js')}\nglobal.formatItemsPreview = formatItemsPreview;`);
  });

  const line = over => ({ name: 'Painted Frame', size: '', qty: 22, unit: 'Pcs', color: 'Red', ...over });

  test('a line that went to the pool says so', () => {
    const html = formatItemsPreview([line({ affectsStock: false, addsToPool: true })]);

    expect(html).toContain('Added to pool');
    expect(html).not.toContain('Ledger only');
  });

  test('a Ledger only line still says that', () => {
    const html = formatItemsPreview([line({ affectsStock: false, addsToPool: false })]);

    expect(html).toContain('Ledger only');
    expect(html).not.toContain('Added to pool');
  });

  test('a line counted in Stock says neither', () => {
    const html = formatItemsPreview([line({ affectsStock: true, addsToPool: false })]);

    expect(html).not.toContain('Ledger only');
    expect(html).not.toContain('Added to pool');
  });
});

describe('the Warehouse Pool opening list', () => {
  beforeEach(() => {
    jest.resetModules();
    document.body.innerHTML = '<table><tbody id="warehouseOpeningTableBody"></tbody></table>';
    // eslint-disable-next-line no-eval
    eval([
      read('api.js'),
      'global.escapeHtml = escapeHtml;',
      'global.toNumber = toNumber;',
      'global.formatCurrency = formatCurrency;',
      'global.formatQty = formatQty;',
    ].join('\n'));
    global.$ = (sel, root = document) => root.querySelector(sel);
    global.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
    global.App = {
      State: {},
      Utils: {},
      Production: { formatQty: q => String(q) },
    };
    // eslint-disable-next-line no-eval
    eval(read('stock.js'));
  });

  const row = over => ({
    rowIdx: 7, date: '30/10/2026', outputItemName: 'Painted Frame', processName: 'Frame Making',
    productTag: '', color: 'Red', qty: 22, remarks: '', fromBill: false, ...over,
  });

  test('a manual entry can be deleted here', () => {
    App.State.globalWarehousePoolOpening = [row()];

    App.Stock.renderWarehouseOpeningTable();

    expect(document.querySelector('[onclick*="deleteWarehouseOpeningEntry"]')).not.toBeNull();
  });

  test('a bill\'s entry is left to the bill', () => {
    App.State.globalWarehousePoolOpening = [row({ fromBill: true, remarks: 'Bill 1339 (Heato Cycles)' })];

    App.Stock.renderWarehouseOpeningTable();

    expect(document.querySelector('[onclick*="deleteWarehouseOpeningEntry"]')).toBeNull();
    expect(document.getElementById('warehouseOpeningTableBody').textContent).toContain('On the bill');
  });

  test('the pool ledger badges a bill\'s line', () => {
    expect(App.Stock.POOL_LEDGER_BADGES.Bill).toBeDefined();
  });
});
