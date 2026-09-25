/**
 * Receive Bill -- editing a bill keeps its Ledger Remarks.
 *
 * App.Bill.openEditModal filled the form with page-wide
 * document.querySelector('input[name="..."]') lookups. index.html includes
 * vendors.html ahead of bill_ledger.html, and the Vendor form has its own
 * <input name="remarks"> (Global Remarks), so a bill's remarks went into
 * that hidden input instead. Every bill opened with a blank Ledger Remarks,
 * and saving the edit -- which serialises #billForm alone -- sent
 * remarks: '' and wiped them on the server.
 *
 * Mounted from the two real partials, in index.html's order: the order IS
 * the bug, and markup reduced to hand-picked ids would not reproduce it.
 * Same fs.readFileSync + eval loader the rest of this suite uses.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PARTIAL = f => fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', f), 'utf8');

function loadBill() {
  const api = [
    fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8'),
    'global.escapeHtml = escapeHtml;',
    'global.toNumber = toNumber;',
    'global.todayIso = todayIso;',
  ].join('\n');
  // eslint-disable-next-line no-eval
  eval(api);

  // bill.js calls core.js's helpers as bare globals (one shared scope in the
  // browser); each eval() here gets its own, so they are re-exported -- the
  // epilogue technique activity_log.test.js describes.
  const core = [
    fs
      .readFileSync(path.join(__dirname, '..', 'core.js'), 'utf8')
      .replace(/^const App = /m, 'global.App = '),
    'global.$ = $;',
    'global.$$ = $$;',
    'global.safeModalShow = safeModalShow;',
    'global.safeModalHide = safeModalHide;',
    'global.setDisabled = setDisabled;',
  ].join('\n');
  // eslint-disable-next-line no-eval
  eval(core);

  // eslint-disable-next-line no-eval
  eval(fs.readFileSync(path.join(__dirname, '..', 'bill.js'), 'utf8'));
}

const BILL = {
  billNumber: 'INV-4471',
  vendor: 'acme',
  contact: '',
  billDate: '12/09/2026',
  billDateRaw: '2026-09-12',
  remarks: 'Paid by cheque 118822',
  issuingParty: '',
  manufacturingVendor: '',
  billType: 'GOODS',
  items: [
    { name: 'Carton', size: 'L', narration: '', unit: 'Pcs', qty: 100, price: 12, gstRatePct: 18, poNumber: 'DIRECT' },
  ],
};

const billRemarks = () => document.querySelector('#billForm input[name="remarks"]');
const vendorRemarks = () => document.getElementById('vFormRemarks');

describe('editing a bill', () => {
  beforeEach(() => {
    jest.resetModules();
    document.body.innerHTML = PARTIAL('vendors.html') + PARTIAL('bill_ledger.html');
    loadBill();
    App.State.globalBills = [BILL];
    App.State.filteredBills = [BILL];
  });

  test('the page has a name="remarks" input ahead of the bill form\'s', () => {
    // Guards the fixture: if this stops holding, the tests below pass
    // without exercising the collision they exist for.
    expect(document.querySelector('input[name="remarks"]')).toBe(vendorRemarks());
  });

  test('opens with the bill\'s own remarks in Ledger Remarks', async () => {
    await App.Bill.openEditModal(0);

    expect(billRemarks().value).toBe('Paid by cheque 118822');
  });

  test('leaves the Vendor form\'s Global Remarks alone', async () => {
    await App.Bill.openEditModal(0);

    expect(vendorRemarks().value).toBe('');
  });

  test('saving it untouched sends its remarks back, not a blank', async () => {
    // The wipe itself: the save serialises #billForm alone, so whatever
    // that form holds is what save_bill writes over the stored remarks.
    await App.Bill.openEditModal(0);

    expect(App.Bill.serializeForm().formData.remarks).toBe('Paid by cheque 118822');
  });
});
