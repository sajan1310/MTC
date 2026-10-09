/**
 * PO and bill lines: which unit a line is in, and the rate it is offered.
 *
 * The rim-assembly spokes are counted in pieces and bought by the Gross.
 * A line used to start in the item's Purchase Unit -- which every save
 * rewrites to whatever unit that line used -- so the same spoke started in
 * Gross on one bill and in Pcs on the next, and a rate came across in
 * whichever unit it had been quoted in: Rs 100 a Gross landed in a line of
 * pieces as Rs 100 a piece, and "Use PO rate" switched a line of 28,800
 * pieces to 28,800 Gross.
 *
 * Pinned here: a line starts in its item's Base Unit and changes unit only
 * when the operator picks one; a line in another unit says what it comes to;
 * a suggested rate is quoted in the line's own unit; and adopting a PO's rate
 * never changes the line's unit.
 *
 * Same fs.readFileSync + eval loader as bill_edit_remarks.test.js. po.js and
 * bill.js wire their row listeners on DOMContentLoaded; those two handlers
 * are run, core.js's (the whole app's start-up) is not.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const UNITS = [
  { unitName: 'Pcs', family: 'Count', factorToBase: 1 },
  { unitName: 'Gross', family: 'Count', factorToBase: 144 },
  { unitName: 'Grs', family: 'Count', factorToBase: 1 },
  { unitName: 'Gram', family: 'Weight', factorToBase: 1 }
];

// Counted in pieces, bought by the Gross: a vendor's rate is held per Gross.
const RIM_SPOKE = {
  name: 'R-SPOKE 110', size: '14 inch', narration: '', baseUnit: 'Pcs', purchaseUnit: 'Gross',
  weightPerBaseUnit: 0, vendors: [{ vendor: 'WeBest Bikes', rate: 100, ratePerBaseUnit: 100 / 144 }]
};
// Packed in the carton as it comes: counted, bought and used in Grs.
const CARTON_SPOKE = {
  name: 'R-SPOKE 260', size: '26 inch', narration: '', baseUnit: 'Grs', purchaseUnit: 'Grs',
  weightPerBaseUnit: 0, vendors: [{ vendor: 'WeBest Bikes', rate: 116, ratePerBaseUnit: 116 }]
};
const POS = [
  { poNumber: '1233', poDate: '09/09/2026', vendor: 'WeBest Bikes',
    items: [{ name: 'R-SPOKE 110', size: '14 inch', narration: '', qty: 200, unit: 'Gross', price: 100, ratePerBaseUnit: 100 / 144 }] }
];

function loadDesktop() {
  // eslint-disable-next-line no-eval
  eval([
    read('api.js').replace(/^const Api = /m, 'global.Api = '),
    'global.escapeHtml = escapeHtml;',
    'global.toNumber = toNumber;',
    'global.todayIso = todayIso;',
    'global.formatCurrency = formatCurrency;',
    'global.formatQty = formatQty;',
    'global.PO_STATUS = PO_STATUS;'
  ].join('\n'));

  const ready = [];
  const addEventListener = document.addEventListener.bind(document);
  document.addEventListener = (type, fn, opts) =>
    (type === 'DOMContentLoaded' ? ready.push(fn) : addEventListener(type, fn, opts));
  try {
    // eslint-disable-next-line no-eval
    eval([
      read('core.js').replace(/^const App = /m, 'global.App = '),
      'global.$ = $;',
      'global.$$ = $$;',
      'global.safeModalShow = safeModalShow;',
      'global.safeModalHide = safeModalHide;',
      'global.setDisabled = setDisabled;'
    ].join('\n'));
    const appStartUp = ready.length;
    // eslint-disable-next-line no-eval
    eval(read('po.js'));
    // eslint-disable-next-line no-eval
    eval(read('bill.js'));
    document.addEventListener = addEventListener;
    ready.slice(appStartUp).forEach(fn => fn());
  } finally {
    document.addEventListener = addEventListener;
  }
}

beforeAll(() => {
  loadDesktop();
  Api.call = jest.fn(async () => ({ success: true, data: [] }));
});

beforeEach(() => {
  App.State.globalUnits = UNITS;
  App.State.globalItems = [RIM_SPOKE, CARTON_SPOKE];
  App.State.globalPOs = POS;
  App.State.globalBills = [];
  document.body.innerHTML = `
    <input id="formVendor" value="WeBest Bikes">
    <table><tbody id="itemsBody"></tbody></table>
    <input id="billVendor" value="WeBest Bikes"><input id="billDateInput" value="">
    <table><tbody id="billItemsBody"></tbody></table>`;
});

const type = (el, value) => {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

function poRow(item) {
  const tbody = document.getElementById('itemsBody');
  tbody.insertAdjacentHTML('beforeend', App.PO.getRowHtml(item));
  const row = tbody.lastElementChild;
  return {
    row,
    name: row.querySelector('.item-name'),
    size: row.querySelector('.item-size'),
    narration: row.querySelector('.item-narration'),
    qty: row.querySelector('.item-qty'),
    unit: row.querySelector('.item-unit'),
    price: row.querySelector('.item-price'),
    hint: () => row.querySelector('[data-role="unit-conv-hint"]')?.textContent || ''
  };
}

function choose(r, item) {
  type(r.name, item.name);
  type(r.size, item.size);
}

describe('a line starts in its item\'s Base Unit', () => {
  test('a spoke bought by the Gross starts in pieces', () => {
    const r = poRow();
    choose(r, RIM_SPOKE);
    expect(r.unit.value).toBe('Pcs');
  });

  test('a spoke packed in the carton starts in Grs', () => {
    const r = poRow();
    choose(r, CARTON_SPOKE);
    expect(r.unit.value).toBe('Grs');
  });

  test('a unit the operator picked stays until another item is chosen', () => {
    const r = poRow();
    choose(r, RIM_SPOKE);
    type(r.unit, 'Gross');
    type(r.narration, '110 mm');
    type(r.name, RIM_SPOKE.name);
    expect(r.unit.value).toBe('Gross');

    choose(r, CARTON_SPOKE);
    expect(r.unit.value).toBe('Grs');
  });

  test('a saved line keeps the unit it was raised in', () => {
    const r = poRow({ ...RIM_SPOKE, qty: 200, unit: 'Gross', price: 100 });
    type(r.name, RIM_SPOKE.name);
    expect(r.unit.value).toBe('Gross');
    expect(r.hint()).toBe('= 28800 Pcs');
  });

  test('the bill form does the same', () => {
    const tbody = document.getElementById('billItemsBody');
    tbody.insertAdjacentHTML('beforeend', App.Bill.getRowHtml({ poNumber: 'DIRECT' }));
    const row = tbody.lastElementChild;
    type(row.querySelector('.b-item-name'), RIM_SPOKE.name);
    type(row.querySelector('.b-item-size'), RIM_SPOKE.size);
    expect(row.querySelector('.item-unit').value).toBe('Pcs');
  });
});

describe('a line in another unit says what it comes to', () => {
  test('in Gross: the pieces it makes, or the factor before a quantity', () => {
    const r = poRow();
    choose(r, RIM_SPOKE);
    expect(r.hint()).toBe('');

    type(r.unit, 'Gross');
    expect(r.hint()).toBe('1 Gross = 144 Pcs');

    type(r.qty, '200');
    expect(r.hint()).toBe('= 28800 Pcs');
  });

  test('Gross on a spoke counted in Grs shows the x144 before it is saved', () => {
    const r = poRow();
    choose(r, CARTON_SPOKE);
    type(r.qty, '300');
    type(r.unit, 'Gross');
    expect(r.hint()).toBe('= 43200 Grs');
  });

  test('a unit that converts one-for-one says nothing', () => {
    expect(App.Utils.unitHintText(RIM_SPOKE, 10, 'Grs')).toBe('');
    expect(App.Utils.unitHintText(CARTON_SPOKE, 10, 'Pcs')).toBe('');
  });
});

describe('a suggested rate comes in the line\'s unit', () => {
  test('the vendor\'s Rs 100 a Gross fills a line of pieces at Rs 0.6944, and Rs 100 once it is in Gross', () => {
    const r = poRow();
    choose(r, RIM_SPOKE);
    expect(r.price.value).toBe('0.6944');

    type(r.unit, 'Gross');
    expect(r.price.value).toBe('100');
  });

  test('a rate the operator typed is never replaced', () => {
    const r = poRow();
    choose(r, RIM_SPOKE);
    type(r.price, '98');
    type(r.unit, 'Gross');
    expect(r.price.value).toBe('98');
  });

  test('a bill line billed against a PO in Gross', () => {
    const quote = unit => App.Bill.getLatestRate(RIM_SPOKE.name, RIM_SPOKE.size, '', 'WeBest Bikes', '1233', unit);
    expect(quote('Pcs')).toBe(0.6944);
    expect(quote('Gross')).toBe(100);
  });

  test('units that cannot be converted offer no rate', () => {
    expect(App.Bill.getLatestRate(RIM_SPOKE.name, RIM_SPOKE.size, '', 'WeBest Bikes', '', 'Gram')).toBeNull();
  });
});

describe('a PO rate that disagrees with the bill', () => {
  function billRow() {
    const tbody = document.getElementById('billItemsBody');
    tbody.insertAdjacentHTML('beforeend', App.Bill.getRowHtml({
      ...RIM_SPOKE, qty: 28800, unit: 'Pcs', price: 0.75, poNumber: '1233'
    }));
    return tbody.lastElementChild;
  }

  test('is offered in the line\'s unit, and adopting it keeps the unit', () => {
    const row = billRow();
    App.Bill.renderRateConflict(row, {
      poRate: 100, poUnit: 'Gross', poRateInBillUnit: 0.6944, billRate: 0.75, billUnit: 'Pcs'
    });
    const info = row.querySelector('[data-role="rate-conflict-info"]').textContent.replace(/\s+/g, ' ');
    expect(info).toContain('PO rate: ₹100/Gross (₹0.6944/Pcs) vs Bill: ₹0.75/Pcs');

    App.Bill.resolveRateConflict(row, 'use-po-rate');
    expect(row.querySelector('.b-item-price').value).toBe('0.6944');
    expect(row.querySelector('.item-unit').value).toBe('Pcs');
    expect(row.querySelector('.b-item-qty').value).toBe('28800');
  });

  test('with no rate in the line\'s unit there is nothing to adopt', () => {
    const row = billRow();
    App.Bill.renderRateConflict(row, {
      poRate: 100, poUnit: 'Gross', poRateInBillUnit: null, billRate: 0.75, billUnit: 'Pcs'
    });
    expect(row.querySelector('[data-action="use-po-rate"]')).toBeNull();
    expect(row.querySelector('[data-action="keep-bill-rate"]')).not.toBeNull();
  });

  test('linking a line by hand compares in its unit', () => {
    const row = billRow();
    row.querySelector('.b-item-price').value = '0.6944';
    App.Bill.openPoOverride(row);
    const select = row.querySelector('.po-override-select');
    select.value = '1233';
    select.dispatchEvent(new Event('change'));
    expect(row.querySelector('[data-role="rate-conflict-info"]').textContent.trim()).toBe('');
  });
});
