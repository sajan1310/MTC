/**
 * MApp.ContractorDetail -- the read side of what MApp could already write
 * (Phase 5, D-04).
 *
 * Rates, extra charges and payments were all quick-addable from the
 * Directory and none of them could be read back. Write-without-read is
 * the worst asymmetry in the app: an operator records a payment, has no
 * way to confirm it landed, no way to see the balance it changed, and no
 * way to correct a mistake -- so the predictable outcome is a duplicate,
 * and the cleanup lands on whoever opens desktop next.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function loadAsGlobal(relPath, exportName) {
  const code = fs
    .readFileSync(path.join(__dirname, '..', relPath), 'utf8')
    .replace(new RegExp(`^const ${exportName} = `, 'm'), `global.${exportName} = `);
  // eslint-disable-next-line no-eval
  eval(code);
}

const LEDGER = {
  entries: [
    { date: '20 Aug', dateRaw: '2026-08-20', type: 'Payment', ref: 'UPI-77', description: 'part settlement', amount: -5000, balance: 3000, rowIdx: 12, rawAmount: 5000 },
    { date: '14 Aug', dateRaw: '2026-08-14', type: 'Payable', ref: 'LOT-1042', description: 'Painting 26 inch', amount: 8000, balance: 8000 },
  ],
  totalPayable: 8000, totalPaid: 5000, balanceDue: 3000,
};
const RATES = [{ rowIdx: 1, contractorName: 'Rakesh', processType: 'Painting', size: '26 inch', ratePerUnit: 40, remarks: '' }];
const CHARGES = [{ rowIdx: 2, contractorName: 'Rakesh', serviceType: 'Transport', chargeAmount: 250, remarks: 'per trip' }];

const flush = () => new Promise(r => setTimeout(r, 0));

describe('MApp.ContractorDetail', () => {
  beforeEach(() => {
    jest.resetModules();
    global.fetch = jest.fn();
    document.body.innerHTML = `
      <div id="mapp-sheet-backdrop"></div>
      <div class="mb-sheet" id="sheet-contractor-detail">
        <h2 id="contractor-detail-title"></h2>
        <div id="contractor-detail-body"></div>
      </div>`;
    loadAsGlobal('api.js', 'Api');
    loadAsGlobal('mobile.js', 'MApp');
    MApp.Sheet._stack = [];
    window.confirm = jest.fn(() => true);
    MApp.Api.call = jest.fn(async method => ({
      success: true,
      data: {
        getContractorAccountLedger: LEDGER,
        getContractorRatesData: RATES,
        getContractorServiceChargesData: CHARGES,
      }[method],
    }));
  });

  const body = () => document.getElementById('contractor-detail-body');
  const text = () => body().textContent;

  test('reads all three, scoped to the contractor', async () => {
    await MApp.ContractorDetail.open('Rakesh');

    ['getContractorAccountLedger', 'getContractorRatesData', 'getContractorServiceChargesData']
      .forEach(m => expect(MApp.Api.call).toHaveBeenCalledWith(m, 'Rakesh'));
  });

  test('leads with the balance, which is what the screen is opened for', async () => {
    await MApp.ContractorDetail.open('Rakesh');

    expect(text()).toContain('Balance due');
    expect(text()).toContain('₹3000.00');
    expect(text()).toContain('Payable ₹8000.00');
    expect(text()).toContain('Paid ₹5000.00');
  });

  test('shows the ledger with running balances', async () => {
    await MApp.ContractorDetail.open('Rakesh');

    expect(text()).toContain('LOT-1042');
    expect(text()).toContain('UPI-77');
    expect(text()).toContain('bal ₹8000.00');
  });

  test('shows the rate card and extra charges', async () => {
    await MApp.ContractorDetail.open('Rakesh');

    expect(text()).toContain('Painting');
    expect(text()).toContain('26 inch');
    expect(text()).toContain('₹40.00');
    expect(text()).toContain('Transport');
    expect(text()).toContain('₹250.00');
  });

  describe('a section that fails to load', () => {
    test('says so rather than rendering as empty', async () => {
      // "No rates on file" and "we could not fetch the rates" are
      // different answers and must not look the same.
      MApp.Api.call = jest.fn(async method => {
        if (method === 'getContractorRatesData') throw new Error('offline');
        return { success: true, data: method === 'getContractorAccountLedger' ? LEDGER : CHARGES };
      });

      await MApp.ContractorDetail.open('Rakesh');

      expect(text()).toContain("Couldn't load the rate card");
      expect(text()).not.toContain('No rates on file');
    });

    test('does not hide the sections that did load', async () => {
      MApp.Api.call = jest.fn(async method => {
        if (method === 'getContractorAccountLedger') throw new Error('offline');
        return { success: true, data: method === 'getContractorRatesData' ? RATES : CHARGES };
      });

      await MApp.ContractorDetail.open('Rakesh');

      expect(text()).toContain("Couldn't load the account ledger");
      expect(text()).toContain('Painting'); // the rate card still rendered
    });
  });

  describe('deleting', () => {
    test('a rate is removed by contractor, process type and size', async () => {
      let call = null;
      MApp.Util.mutateSimple = jest.fn(async (m, args) => { call = { m, args }; return { success: false }; });
      await MApp.ContractorDetail.open('Rakesh');

      body().querySelector('[data-del-rate]').click();
      await flush();

      expect(call.m).toBe('deleteContractorRate');
      expect(call.args).toEqual(['Rakesh', 'Painting', '26 inch']);
    });

    test('a charge is removed by contractor and service type', async () => {
      let call = null;
      MApp.Util.mutateSimple = jest.fn(async (m, args) => { call = { m, args }; return { success: false }; });
      await MApp.ContractorDetail.open('Rakesh');

      body().querySelector('[data-del-charge]').click();
      await flush();

      expect(call.m).toBe('deleteContractorServiceCharge');
      expect(call.args).toEqual(['Rakesh', 'Transport']);
    });

    test('a payment sends the expected contractor and amount alongside its id', async () => {
      // The server uses those to refuse a delete whose row changed
      // underneath -- which matters on a phone that may have had this
      // list open for a while.
      let call = null;
      MApp.Util.mutateSimple = jest.fn(async (m, args) => { call = { m, args }; return { success: false }; });
      await MApp.ContractorDetail.open('Rakesh');

      body().querySelector('[data-del-payment]').click();
      await flush();

      expect(call.m).toBe('deleteContractorPayment');
      expect(call.args).toEqual(['12', 'Rakesh', 5000]);
    });

    test('only payments offer a delete -- a payable is derived, not a record', async () => {
      await MApp.ContractorDetail.open('Rakesh');

      expect(body().querySelectorAll('[data-del-payment]')).toHaveLength(1);
    });

    test('declining the confirm sends nothing', async () => {
      window.confirm = jest.fn(() => false);
      MApp.Util.mutateSimple = jest.fn();
      await MApp.ContractorDetail.open('Rakesh');

      body().querySelector('[data-del-rate]').click();
      await flush();

      expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();
    });
  });

  test('a stale response for a previously-opened contractor is discarded', async () => {
    // Opening B while A is in flight must not paint A's figures under
    // B's name -- on a contractor account that is someone else's money.
    // All three of the first open's requests are held, not just one --
    // Promise.all waits for every one of them, so releasing a single
    // resolver would hang the test rather than exercise the guard.
    const held = [];
    MApp.Api.call = jest.fn(method => {
      const payload = method === 'getContractorAccountLedger' ? LEDGER : [];
      if (MApp.ContractorDetail.name === 'Rakesh') {
        return new Promise(res => held.push(() => res({ success: true, data: payload })));
      }
      const emptyLedger = { entries: [], totalPayable: 0, totalPaid: 0, balanceDue: 0 };
      return Promise.resolve({ success: true, data: method === 'getContractorAccountLedger' ? emptyLedger : [] });
    });

    const first = MApp.ContractorDetail.open('Rakesh');
    await MApp.ContractorDetail.open('Suresh');
    held.forEach(release => release());
    await first;

    expect(document.getElementById('contractor-detail-title').textContent).toBe('Suresh');
    expect(text()).not.toContain('₹3000.00');
  });

  test('reachable from the contractor list', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');
    expect(src).toContain("MApp.ContractorDetail.open(record.name)");
    expect(src).toContain("['account', 'Account']");
  });
});

describe('MApp.ContractorDetail print and multi-select', () => {
  beforeEach(() => {
    jest.resetModules();
    global.fetch = jest.fn();
    document.body.innerHTML = `
      <div id="mapp-sheet-backdrop"></div>
      <div class="mb-sheet" id="sheet-contractor-detail">
        <h2 id="contractor-detail-title"></h2>
        <div id="contractor-detail-body"></div>
      </div>
      <div class="print-container" id="print-contractor-ledger-container">
        <span id="print-contractor-name"></span><span id="print-contractor-gstpan"></span>
        <span id="print-contractor-contact"></span><span id="print-contractor-address"></span>
        <span id="print-contractor-remarks"></span><span id="print-contractor-report-date"></span>
        <span id="print-contractor-total-payable"></span><span id="print-contractor-total-paid"></span>
        <span id="print-contractor-balance-due"></span>
        <table><tbody id="print-contractor-ledger-body"></tbody></table>
      </div>`;
    loadAsGlobal('api.js', 'Api');
    loadAsGlobal('mobile.js', 'MApp');
    MApp.Sheet._stack = [];
    window.print = jest.fn();
    MApp.Api.call = jest.fn(async method => ({
      success: true,
      data: {
        getContractorAccountLedger: LEDGER,
        getContractorRatesData: RATES,
        getContractorServiceChargesData: CHARGES,
      }[method],
    }));
  });

  test('fills the same print template desktop fills', async () => {
    MApp.Directory.items = [{ name: 'Rakesh', contact: '99999', address: 'Ludhiana', gstPan: 'ABC', remarks: '' }];
    await MApp.ContractorDetail.open('Rakesh');

    MApp.ContractorDetail.print();

    expect(document.getElementById('print-contractor-name').textContent).toBe('Rakesh');
    expect(document.getElementById('print-contractor-contact').textContent).toBe('99999');
    expect(document.getElementById('print-contractor-balance-due').textContent).toBe('₹3000.00');
    expect(document.getElementById('print-contractor-ledger-body').innerHTML).toContain('LOT-1042');
    expect(window.print).toHaveBeenCalled();
  });

  test('refuses to print a statement whose ledger did not load', async () => {
    // Printing a blank or partial account statement and handing it to a
    // contractor is worse than not printing one.
    MApp.Api.call = jest.fn(async method => {
      if (method === 'getContractorAccountLedger') throw new Error('offline');
      return { success: true, data: [] };
    });
    await MApp.ContractorDetail.open('Rakesh');

    MApp.ContractorDetail.print();

    expect(window.print).not.toHaveBeenCalled();
  });

  test('rate and charge lists get their own containers, so multi-select can arm', async () => {
    // MApp.Select refuses to arm unless the rendered row count matches
    // the data; three lists sharing one container could never satisfy it.
    await MApp.ContractorDetail.open('Rakesh');

    expect(document.getElementById('contractor-rate-list')).not.toBeNull();
    expect(document.getElementById('contractor-charge-list')).not.toBeNull();
    expect(document.querySelectorAll('#contractor-rate-list .mb-card')).toHaveLength(RATES.length);
    expect(document.querySelectorAll('#contractor-charge-list .mb-card')).toHaveLength(CHARGES.length);
  });

  test('the ledger is NOT multi-selectable', async () => {
    // It mixes derived Payables with real Payment rows; a selection
    // spanning both would offer to delete something that is not a record.
    const src = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');
    const start = src.indexOf('MApp.ContractorDetail = {');
    const next = src.slice(start + 1).search(/\nMApp\.[A-Z][A-Za-z]* = \{/);
    const mod = src.slice(start, start + 1 + next);

    expect(mod).not.toContain('deleteContractorPaymentsBulk');
    expect(mod).toContain("key: 'contractor-rates'");
    expect(mod).toContain("key: 'contractor-charges'");
  });
});
