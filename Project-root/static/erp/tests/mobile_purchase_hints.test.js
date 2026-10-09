/**
 * The phone's New PO and Bill forms: a line's narration, and its rate.
 *
 * Desktop suggests a line's narration from what the item has been bought
 * under before, fills it outright when there is only one, and fills the
 * line's rate from the vendor's Items Master rate or the latest PO/bill --
 * and on a bill, from the PO the line is billed against, first of all
 * (po.js#refreshNarrationList / #autoFillRate, bill.js#getLatestRate).
 *
 * The phone had none of it. Its PO form had no narration field at all, so
 * a PO raised on the phone went out without one -- and EDITING a PO on the
 * phone sent every line's narration as blank, wiping the ones desktop had
 * saved. Its bill form carried a narration it never showed, and never
 * filled a rate.
 *
 * Pinned here: the suggestions are desktop's own (desktop's functions run
 * on the same records and must agree), a suggestion never overwrites what
 * the operator typed, and a bill line billed against a PO is filled at the
 * PO's rate -- or, where the operator typed a different one, offered it.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const MOBILE_VIEWS = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', 'mobile_views.html'), 'utf8');

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

const ITEMS = [
  { name: 'Rim', size: '26 inch', narration: 'Alloy', baseUnit: 'Pcs', vendors: [{ vendor: 'Acme Cycles', rate: 110 }] },
  { name: 'Spoke', size: '', narration: '', baseUnit: 'Pcs', vendors: [] },
  { name: 'Tube', size: '20', narration: 'Butyl', baseUnit: 'Pcs', vendors: [] },
  { name: 'Grip', size: '', narration: '', baseUnit: 'Pcs', vendors: [] }
];

// Newest first, as getPOData and getBillData return them.
const POS = [
  { poNumber: '1205', poDate: '20/09/2026', vendor: 'Bharat Steel',
    items: [{ name: 'Spoke', size: '', narration: 'SS 2mm', qty: 100, unit: 'Pcs', price: 2.5 }] },
  { poNumber: '1204', poDate: '12/09/2026', vendor: 'Acme Cycles',
    items: [
      { name: 'Spoke', size: '', narration: 'Zinc', qty: 500, unit: 'Pcs', price: 1.8 },
      { name: 'Rim', size: '26 inch', narration: 'Black', qty: 20, unit: 'Pcs', price: 105 }
    ] },
  { poNumber: '1190', poDate: '02/09/2026', vendor: 'Acme Cycles',
    items: [{ name: 'Spoke', size: '', narration: 'Chrome', qty: 300, unit: 'Pcs', price: 2.1 }] }
];
const BILLS = [
  { billNumber: 'INV-88', billDate: '15/09/2026', vendor: 'Acme Cycles',
    items: [{ name: 'Spoke', size: '', narration: 'Zinc', qty: 200, unit: 'Pcs', price: 1.9, poNumber: '1204' }] },
  { billNumber: 'INV-71', billDate: '01/09/2026', vendor: 'Gupta Traders',
    items: [{ name: 'Grip', size: '', narration: 'Rubber', qty: 50, unit: 'Pcs', price: 12 }] }
];
const VENDORS = ['Acme Cycles', 'Bharat Steel', 'Gupta Traders'].map(name => ({ name, contact: '' }));

function loadMobile() {
  // eslint-disable-next-line no-eval
  eval([
    read('api.js').replace(/^const Api = /m, 'global.Api = '),
    'global.escapeHtml = escapeHtml;',
    'global.toNumber = toNumber;',
    'global.dateToInputValue = dateToInputValue;',
    'global.todayIso = todayIso;',
    // Desktop's po.js / bill.js read these as bare globals.
    'global.PO_STATUS = PO_STATUS;',
    'global.formatCurrency = formatCurrency;',
    'global.formatQty = formatQty;',
    'global.normalizeDateForInput = normalizeDateForInput;'
  ].join('\n'));
  // eslint-disable-next-line no-eval
  eval(read('mobile.js').replace(/^const MApp = /m, 'global.MApp = '));
}

// Desktop's App.PO / App.Bill, for the parity checks -- the same loader
// bill_edit_remarks.test.js uses.
function loadDesktop() {
  // eslint-disable-next-line no-eval
  eval([
    read('core.js').replace(/^const App = /m, 'global.App = '),
    'global.$ = $;',
    'global.$$ = $$;'
  ].join('\n'));
  // eslint-disable-next-line no-eval
  eval(read('po.js'));
  // eslint-disable-next-line no-eval
  eval(read('bill.js'));
  App.State.globalItems = ITEMS;
  App.State.globalPOs = POS;
  App.State.globalBills = BILLS;
}

// Every read the forms make, answered locally. Anything else is a bug in
// the test, so it says so.
function stubReads(overrides = {}) {
  const answers = {
    getVendorsData: VENDORS,
    getItemsData: ITEMS,
    getPOData: POS,
    getBillData: BILLS,
    ...overrides
  };
  MApp.Api.call = jest.fn(async (method, ...args) => {
    if (typeof answers[method] === 'function') return answers[method](...args);
    if (!(method in answers)) throw new Error(`unexpected call ${method}`);
    return { success: true, data: answers[method] };
  });
}

// MApp.Picker answers with the entry whose value is next in line.
function pickNext(...values) {
  const queue = [...values];
  MApp.Picker.open = jest.fn(async ({ items }) => {
    const want = queue.shift();
    return items.find(it => it.value === want) || null;
  });
}

beforeEach(() => {
  jest.resetModules();
  global.fetch = jest.fn();
  try { localStorage.clear(); } catch (e) { /* not available */ }
  document.body.innerHTML = `<div id="mapp-sheet-backdrop"></div><div id="mapp-toast-stack"></div>${MOBILE_VIEWS}`;
  loadMobile();
  MApp.Sheet._stack = [];
  stubReads();
});

const H = () => MApp.PurchaseHints;
const DATA = { pos: POS, bills: BILLS, items: ITEMS };

describe('the suggestions are desktop\'s', () => {
  beforeEach(() => loadDesktop());

  const CASES = [
    { name: 'Spoke', size: '', narration: '', vendor: 'Acme Cycles' },
    { name: 'Spoke', size: '', narration: 'Chrome', vendor: 'Acme Cycles' },
    { name: 'Spoke', size: '', narration: 'Zinc', vendor: 'Acme Cycles' },
    { name: 'Spoke', size: '', narration: '', vendor: 'Bharat Steel' },
    { name: 'Spoke', size: '', narration: 'Nothing like it', vendor: '' },
    { name: 'Rim', size: '26 inch', narration: '', vendor: 'Acme Cycles' },
    { name: 'Rim', size: '26 inch', narration: 'Black', vendor: 'Bharat Steel' },
    { name: 'Tube', size: '20', narration: '', vendor: 'Acme Cycles' },
    { name: 'Grip', size: '', narration: '', vendor: '' },
    { name: 'grip ', size: '', narration: 'RUBBER', vendor: 'gupta traders' },
    { name: 'Unknown', size: '', narration: '', vendor: 'Acme Cycles' }
  ];

  test.each(CASES)('rate for %o', c => {
    const desktop = App.Bill.getLatestRate(c.name, c.size, c.narration, c.vendor, '');
    const mobile = H().latestRate(DATA, c);
    expect(mobile ? mobile.rate : null).toEqual(desktop);
  });

  // Desktop's narration list lives in a row's <datalist>, so it is asked
  // through the row it reads.
  function desktopNarrations({ name, size, vendor }) {
    document.body.insertAdjacentHTML('beforeend', `
      <input id="formVendor" value="">
      <table><tbody id="itemsBody"><tr id="parity-row">
        <td><input class="item-name"><input class="item-size"><input class="item-narration">
        <datalist class="row-narration-list"></datalist></td>
      </tr></tbody></table>`);
    const row = document.getElementById('parity-row');
    document.getElementById('formVendor').value = vendor;
    row.querySelector('.item-name').value = name;
    row.querySelector('.item-size').value = size;
    App.PO.refreshNarrationList(row);
    const out = [...row.querySelectorAll('option')].map(o => o.value);
    document.getElementById('formVendor').remove();
    row.closest('table').remove();
    return out;
  }

  test.each(CASES)('narrations for %o', c => {
    expect(H().narrations(DATA, c)).toEqual(desktopNarrations(c));
  });
});

describe('the suggestions themselves', () => {
  test('this vendor\'s narrations first; any vendor\'s when it has none; then Items Master', () => {
    expect(H().narrations(DATA, { name: 'Spoke', size: '', vendor: 'Acme Cycles' })).toEqual(['Zinc', 'Chrome']);
    expect(H().narrations(DATA, { name: 'Spoke', size: '', vendor: 'Nobody Ltd' })).toEqual(['SS 2mm', 'Zinc', 'Chrome']);
    expect(H().narrations(DATA, { name: 'Tube', size: '20', vendor: 'Acme Cycles' })).toEqual(['Butyl']);
  });

  test('a rate says where it came from', () => {
    expect(H().latestRate(DATA, { name: 'Rim', size: '26 inch', narration: '', vendor: 'Acme Cycles' }))
      .toEqual({ rate: 110, source: 'this vendor\'s rate in Items Master' });
    expect(H().latestRate(DATA, { name: 'Spoke', size: '', narration: 'Chrome', vendor: 'Acme Cycles' }))
      .toEqual({ rate: 2.1, source: 'PO 1190 (02/09/2026)' });
    expect(H().latestRate(DATA, { name: 'Grip', size: '', narration: 'Rubber', vendor: 'Gupta Traders' }))
      .toEqual({ rate: 12, source: 'bill INV-71 (01/09/2026)' });
  });

  // Every line here is in its item's Base Unit, so a rate quoted per Gross
  // -- a vendor's Items Master rate, or a PO line's -- comes per piece.
  test('a rate quoted per Gross fills a line of pieces per piece', () => {
    const gross = {
      pos: [{ poNumber: '1233', poDate: '09/09/2026', vendor: 'WeBest Bikes',
        items: [{ name: 'Rim Spoke', size: '14 inch', narration: '', qty: 200, unit: 'Gross', price: 100, ratePerBaseUnit: 100 / 144 }] }],
      bills: [],
      items: [{ name: 'Rim Spoke', size: '14 inch', narration: '', baseUnit: 'Pcs', purchaseUnit: 'Gross',
        vendors: [{ vendor: 'Mahadev Industries', rate: 102, ratePerBaseUnit: 102 / 144 }] }]
    };
    expect(H().latestRate(gross, { name: 'Rim Spoke', size: '14 inch', narration: '', vendor: 'Mahadev Industries' }))
      .toEqual({ rate: 0.7083, source: 'this vendor\'s rate in Items Master' });
    expect(H().latestRate(gross, { name: 'Rim Spoke', size: '14 inch', narration: '', vendor: 'WeBest Bikes' }))
      .toEqual({ rate: 0.6944, source: 'PO 1233 (09/09/2026)' });
  });
});

describe('the history the suggestions come from', () => {
  const reads = method => MApp.Api.call.mock.calls.filter(c => c[0] === method).length;

  test('is fetched once for a run of forms, and again after a save', async () => {
    await MApp.PO.openNewSheet();
    await MApp.PO.openNewSheet();
    await MApp.Bill.openForm(null);
    expect(reads('getBillData')).toBe(1);

    Api.mutateWithId = jest.fn(async () => ({ success: true, data: { poNumber: '1206' } }));
    MApp.PO.selection.vendor = 'Acme Cycles';
    MApp.PO.lines = [{ ...MApp.PO._blankLine(), name: 'Spoke', qty: 5 }];
    await MApp.PO.save();
    await MApp.PO.openNewSheet();
    expect(reads('getBillData')).toBe(2);
  });

  test('a failed read is not held', async () => {
    stubReads({ getBillData: () => { throw new Error('offline'); } });
    await MApp.PO.openNewSheet();
    stubReads();
    await MApp.PO.openNewSheet();
    expect(MApp.PO.history.bills).toEqual(BILLS);
  });
});

describe('New PO', () => {
  const PO = () => MApp.PO;
  const line = i => PO().lines[i];
  const priceInput = i => document.getElementById(`new-po-line-price-${i}`);
  const narrationInput = i => document.getElementById(`new-po-line-narration-${i}`);
  const chips = i => [...document.querySelectorAll(`#new-po-line-narration-chips-${i} button`)].map(b => b.textContent);

  async function openWith(vendor) {
    await PO().openNewSheet();
    pickNext(vendor);
    await PO().pickVendor();
  }

  test('the form has a Narration field on every line', async () => {
    await PO().openNewSheet();
    expect(narrationInput(0)).not.toBeNull();
    PO().addLine();
    expect(narrationInput(1)).not.toBeNull();
  });

  test('several known narrations: offered as choices, none chosen for the operator; the rate fills', async () => {
    await openWith('Acme Cycles');
    pickNext('Spoke||');
    await PO().pickLineItem(0);

    expect(line(0).narration).toBe('');
    expect(chips(0)).toEqual(['Zinc', 'Chrome']);
    // No Items Master rate for this vendor, no line under a blank
    // narration -- so the latest PO for the item, whatever its narration.
    expect(line(0).price).toBe(1.8);
    expect(priceInput(0).value).toBe('1.8');
    expect(document.getElementById('new-po-line-rate-note-0').textContent)
      .toBe('Filled from PO 1204 (12/09/2026). Type a rate to change it.');
  });

  test('one known narration is filled in, and the vendor\'s Items Master rate wins', async () => {
    await openWith('Acme Cycles');
    pickNext('Rim||26 inch');
    await PO().pickLineItem(0);

    expect(line(0).narration).toBe('Black');
    expect(narrationInput(0).value).toBe('Black');
    expect(line(0).price).toBe(110);
  });

  test('choosing a narration re-fills the rate for that narration', async () => {
    await openWith('Acme Cycles');
    pickNext('Spoke||');
    await PO().pickLineItem(0);
    PO().pickNarration(0, line(0).narrationOptions.indexOf('Chrome'));

    expect(line(0).narration).toBe('Chrome');
    expect(line(0).price).toBe(2.1);
    expect(chips(0)).toEqual(['Zinc']);
  });

  test('a typed narration is kept, and still steers the rate', async () => {
    await openWith('Acme Cycles');
    pickNext('Spoke||');
    await PO().pickLineItem(0);
    PO().updateNarration(0, 'Chrome');
    expect(line(0).price).toBe(2.1);

    // A different vendor is a different history -- but the narration was
    // typed, so it stays.
    pickNext('Bharat Steel');
    await PO().pickVendor();
    expect(line(0).narration).toBe('Chrome');
  });

  test('a typed rate is never replaced by a suggestion', async () => {
    await openWith('Acme Cycles');
    pickNext('Spoke||');
    await PO().pickLineItem(0);
    PO().updatePrice(0, '1.75');

    pickNext('Bharat Steel');
    await PO().pickVendor();
    PO().updateNarration(0, 'Chrome');

    expect(line(0).price).toBe(1.75);
    expect(line(0).priceAuto).toBe(false);
    expect(document.getElementById('new-po-line-rate-note-0').textContent).toBe('Last rate ₹2.50, from PO 1205 (20/09/2026).');
  });

  test('a filled rate follows the vendor, and goes when the new vendor has none', async () => {
    await openWith('Acme Cycles');
    pickNext('Spoke||');
    await PO().pickLineItem(0);
    expect(line(0).price).toBe(1.8);

    pickNext('Bharat Steel');
    await PO().pickVendor();
    expect(line(0).price).toBe(2.5);

    pickNext('Gupta Traders');
    await PO().pickVendor();
    expect(line(0).price).toBe('');
    expect(priceInput(0).value).toBe('');
  });

  test('typing a narration does not rebuild the list under the keyboard', async () => {
    await openWith('Acme Cycles');
    pickNext('Spoke||');
    await PO().pickLineItem(0);
    const input = narrationInput(0);
    input.focus();
    PO().updateNarration(0, 'Chrome');
    expect(narrationInput(0)).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(priceInput(0).value).toBe('2.1');
  });

  test('the narration is saved', async () => {
    Api.mutateWithId = jest.fn(async () => ({ success: true, data: { poNumber: '1206' } }));
    await openWith('Acme Cycles');
    pickNext('Spoke||');
    await PO().pickLineItem(0);
    PO().updateNarration(0, '  Chrome  ');
    PO().updateLine(0, 'qty', '400');
    await PO().save();

    const [method, , formData] = Api.mutateWithId.mock.calls[0];
    expect(method).toBe('savePO');
    expect(JSON.parse(formData.items)).toEqual([
      { name: 'Spoke', size: '', narration: 'Chrome', unit: 'Pcs', qty: 400, price: 2.1 }
    ]);
  });

  test('editing a PO keeps every line\'s narration and rate exactly as saved', async () => {
    Api.mutateWithId = jest.fn(async () => ({ success: true, data: {} }));
    const saved = { ...POS[1], contact: '', poRemarks: '', poDateRaw: '2026-09-12' };
    await PO().openEditSheet(saved);

    expect(narrationInput(0).value).toBe('Zinc');
    expect(narrationInput(1).value).toBe('Black');
    await PO().save();

    const items = JSON.parse(Api.mutateWithId.mock.calls[0][2].items);
    expect(items.map(i => [i.name, i.narration, i.price])).toEqual([
      ['Spoke', 'Zinc', 1.8],
      ['Rim', 'Black', 105]
    ]);
  });
});

describe('Bill', () => {
  const Bill = () => MApp.Bill;
  const line = i => Bill().lines[i];
  const priceInput = i => document.getElementById(`bill-form-line-price-${i}`);
  const rateBlock = i => document.getElementById(`bill-form-line-rate-${i}`);

  let suggestions;
  let saved;

  beforeEach(() => {
    suggestions = [];
    stubReads({
      suggestPoAllocations: (vendor, items) => {
        suggestions.push(items);
        return { success: true, data: items.map(it => ({ rowIndex: it.rowIndex, ...nextAnswer(it) })) };
      },
      checkStockAdjustmentConflicts: () => ({ success: true, data: [] })
    });
    saved = null;
    MApp.Util.mutateSimple = jest.fn(async (method, args) => {
      saved = args[0];
      return { success: false };
    });
    // Matching is driven by hand here, not by the debounce.
    jest.spyOn(MApp.Bill, 'scheduleMatch').mockImplementation(() => {});
  });

  // What the server answers for a line: by default, the whole quantity
  // against PO 1204's Zinc spokes at 1.80.
  let nextAnswer = it => ({
    allocations: [{ poNumber: '1204', qty: it.qty, poRate: 1.8, poUnit: 'Pcs', poRateInBillUnit: 1.8 }],
    unmatchedQty: 0
  });
  afterEach(() => {
    nextAnswer = it => ({
      allocations: [{ poNumber: '1204', qty: it.qty, poRate: 1.8, poUnit: 'Pcs', poRateInBillUnit: 1.8 }],
      unmatchedQty: 0
    });
  });

  async function newBillWith(itemValue, qty) {
    await Bill().openForm(null);
    pickNext('Acme Cycles');
    await Bill().pickVendor();
    pickNext(itemValue);
    await Bill().pickLineItem(0);
    Bill().updateLine(0, 'qty', String(qty));
  }

  test('the form has a Narration field, filled when the item has one known narration', async () => {
    await newBillWith('Rim||26 inch', 10);
    expect(document.getElementById('bill-form-line-narration-0').value).toBe('Black');
  });

  test('a line billed against a PO is filled at the PO\'s rate, ahead of any history', async () => {
    nextAnswer = it => ({
      allocations: [{ poNumber: '1190', qty: it.qty, poRate: 2.1, poUnit: 'Pcs', poRateInBillUnit: 2.1 }],
      unmatchedQty: 0
    });
    await newBillWith('Spoke||', 300);
    // Before the match: the latest rate on record.
    expect(line(0).price).toBe(1.8);

    await Bill().matchPos();
    expect(line(0).price).toBe(2.1);
    expect(priceInput(0).value).toBe('2.1');
    expect(rateBlock(0).textContent).toContain('Filled from PO 1190.');
    expect(document.getElementById('bill-form-line-po-0').textContent).toContain('PO-1190');
  });

  test('a PO raised in another unit fills the rate per the bill\'s unit', async () => {
    nextAnswer = it => ({
      allocations: [{ poNumber: '1204', qty: it.qty, poRate: 21.6, poUnit: 'Dozen', poRateInBillUnit: 1.8 }],
      unmatchedQty: 0
    });
    await newBillWith('Grip||', 24);
    await Bill().matchPos();
    expect(line(0).price).toBe(1.8);
  });

  test('a filled rate is not offered to the server as the bill\'s; narration is', async () => {
    await newBillWith('Spoke||', 300);
    Bill().updateNarration(0, 'Zinc');
    await Bill().matchPos();
    expect(suggestions[0]).toEqual([
      { rowIndex: 0, name: 'Spoke', size: '', narration: 'Zinc', unit: 'Pcs', qty: 300, price: 0 }
    ]);

    Bill().updatePrice(0, '1.95');
    await Bill().matchPos();
    expect(suggestions[1][0].price).toBe(1.95);
  });

  test('a typed rate that disagrees with the PO: kept, and the PO\'s offered', async () => {
    await newBillWith('Spoke||', 300);
    Bill().updatePrice(0, '2');
    await Bill().matchPos();

    expect(line(0).price).toBe(2);
    expect(rateBlock(0).textContent).toContain('PO 1204 rate is ₹1.80/Pcs; this bill says ₹2.00/Pcs.');

    Bill().usePoRate(0);
    expect(line(0).price).toBe(1.8);
    expect(priceInput(0).value).toBe('1.8');
    expect(rateBlock(0).textContent).not.toContain('this bill says');
  });

  test('Keep bill rate puts the question away until the rate or the PO changes', async () => {
    await newBillWith('Spoke||', 300);
    Bill().updatePrice(0, '2');
    await Bill().matchPos();
    Bill().keepBillRate(0);
    expect(rateBlock(0).textContent).not.toContain('this bill says');

    Bill().updatePrice(0, '2.2');
    expect(rateBlock(0).textContent).toContain('this bill says ₹2.20/Pcs');
  });

  test('another PO\'s unit shows both the PO\'s figure and what it is per the bill\'s unit', async () => {
    nextAnswer = it => ({
      allocations: [{ poNumber: '1204', qty: it.qty, poRate: 21.6, poUnit: 'Dozen', poRateInBillUnit: 1.8 }],
      unmatchedQty: 0
    });
    await newBillWith('Grip||', 24);
    Bill().updatePrice(0, '2');
    await Bill().matchPos();
    expect(rateBlock(0).textContent).toContain('PO 1204 rate is ₹21.60/Dozen (₹1.80/Pcs)');
  });

  test('Unlink takes a PO-filled rate with it', async () => {
    await newBillWith('Spoke||', 300);
    await Bill().matchPos();
    expect(line(0).rateHint.source).toBe('PO 1204');
    Bill().unlinkPo(0);
    expect(line(0).rateHint.source).toBe('PO 1204 (12/09/2026)');
    expect(line(0).allocs).toEqual([]);
  });

  test('a match that arrives after a newer one is thrown away', async () => {
    await newBillWith('Spoke||', 300);
    let release;
    const slow = new Promise(r => { release = r; });
    const call = MApp.Api.call;
    let asked = 0;
    MApp.Api.call = jest.fn(async (method, ...args) => {
      if (method === 'suggestPoAllocations' && asked++ === 0) {
        await slow;
        return { success: true, data: [{ rowIndex: 0, allocations: [{ poNumber: '1190', qty: 300, poRateInBillUnit: 2.1 }], unmatchedQty: 0 }] };
      }
      return call(method, ...args);
    });
    const first = Bill().matchPos();
    await Bill().matchPos();
    release();
    await first;
    expect(line(0).allocs[0].poNumber).toBe('1204');
  });

  test('saving settles the PO link but not the rate the operator was shown', async () => {
    await newBillWith('Spoke||', 300);
    // Filled from history; the match that would change it only happens at save.
    expect(line(0).price).toBe(1.8);
    nextAnswer = it => ({
      allocations: [{ poNumber: '1190', qty: it.qty, poRate: 2.1, poUnit: 'Pcs', poRateInBillUnit: 2.1 }],
      unmatchedQty: 0
    });
    document.getElementById('bill-form-number').value = 'INV-90';
    await Bill().saveBill();

    const items = JSON.parse(saved.items);
    expect(items).toEqual([expect.objectContaining({ price: 1.8, po: '1190', qty: 300 })]);
  });

  test('editing a bill keeps each saved line on the PO it was saved against', async () => {
    const bill = {
      billNumber: 'INV-88', vendor: 'Acme Cycles', contact: '', remarks: '', billDate: '15/09/2026', billDateRaw: '2026-09-15',
      items: [
        { name: 'Spoke', size: '', narration: 'Zinc', unit: 'Pcs', qty: 200, price: 1.9, gstRatePct: 18, poNumber: '1204' },
        { name: 'Grip', size: '', narration: '', unit: 'Pcs', qty: 10, price: 12, gstRatePct: 18, poNumber: 'DIRECT' }
      ]
    };
    await Bill().openForm(bill);
    expect(document.getElementById('bill-form-line-narration-0').value).toBe('Zinc');
    expect(line(0).price).toBe(1.9);

    await Bill().saveBill();

    // Nothing was re-asked: re-matching a saved line asks for this bill's
    // own quantity against a PO that already counts it as billed.
    expect(suggestions).toEqual([]);
    expect(JSON.parse(saved.items).map(i => [i.name, i.narration, i.price, i.po])).toEqual([
      ['Spoke', 'Zinc', 1.9, '1204'],
      ['Grip', '', 12, 'DIRECT']
    ]);
  });

  test('an edited line of a saved bill is matched afresh', async () => {
    const bill = {
      billNumber: 'INV-88', vendor: 'Acme Cycles', contact: '', remarks: '', billDate: '15/09/2026', billDateRaw: '2026-09-15',
      items: [{ name: 'Spoke', size: '', narration: 'Zinc', unit: 'Pcs', qty: 200, price: 1.9, gstRatePct: 18, poNumber: '1204' }]
    };
    await Bill().openForm(bill);
    Bill().updateLine(0, 'qty', '250');
    await Bill().saveBill();
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0][0]).toEqual(expect.objectContaining({ qty: 250, price: 1.9 }));
  });

  test('a real debounce: typing a quantity asks once, after the typing stops', async () => {
    MApp.Bill.scheduleMatch.mockRestore();
    jest.useFakeTimers();
    try {
      await newBillWith('Spoke||', 1);
      Bill().updateLine(0, 'qty', '30');
      Bill().updateLine(0, 'qty', '300');
      await jest.advanceTimersByTimeAsync(600);
      expect(suggestions.map(s => s[0].qty)).toEqual([300]);
    } finally {
      jest.useRealTimers();
    }
  });
});

// The field's chips carry the narration by position, never inside the
// onclick attribute, so a narration with a quote in it cannot break out.
test('a narration with quotes renders as text and picks correctly', async () => {
  const odd = 'He said "no" & \'yes\'';
  stubReads({ getBillData: [], getPOData: [{ poNumber: '1', vendor: 'Acme Cycles', items: [
    { name: 'Spoke', size: '', narration: odd, price: 1 },
    { name: 'Spoke', size: '', narration: 'Plain', price: 1 }
  ] }] });
  await MApp.PO.openNewSheet();
  pickNext('Acme Cycles');
  await MApp.PO.pickVendor();
  pickNext('Spoke||');
  await MApp.PO.pickLineItem(0);

  const buttons = [...document.querySelectorAll('#new-po-line-narration-chips-0 button')];
  expect(buttons.map(b => b.textContent)).toEqual([odd, 'Plain']);
  buttons[0].click();
  await tick();
  expect(MApp.PO.lines[0].narration).toBe(odd);
});
