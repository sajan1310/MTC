/**
 * Stored-XSS regression tests for the Vendor module (SEC-004).
 *
 * vendors.js interpolated four user-controlled fields into innerHTML without
 * escaping, in some cases directly beside correctly-escaped ones in the same
 * table row:
 *
 *     <td>${escapeHtml(v.contact) || '-'}</td>          <-- escaped
 *     <td><span class="badge">${v.gstin || 'No GSTIN'}</span></td>   <-- NOT
 *
 * The unescaped fields were: vendor GSTIN, the ledger reference (a bill /
 * return / issue number typed into a form), and the pending-items item name
 * and size. There is no server-side HTML sanitisation anywhere in this app --
 * bill_number and the rest are stored exactly as entered.
 *
 * The CSP is `script-src 'self' 'unsafe-inline'`, so an injected
 * `<img onerror>` or `<script>` actually executes; the CSP provides no
 * mitigation. An attacker who can create a bill plants a payload in a bill
 * number and it fires whenever an admin opens that vendor's profile, from
 * where the CSRF token in the page's meta tag is readable and any of the ~166
 * RPC methods can be called as the admin.
 *
 * Run against the real source, using the same fs.readFileSync + eval loader
 * the rest of this suite uses.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PAYLOAD = '<img src=x onerror="window.__xss=1">';
const SCRIPT_PAYLOAD = '"><script>window.__xss=1</script>';

function loadVendors() {
  // api.js owns escapeHtml/formatCurrency/toNumber/parseRecordDate, which
  // vendors.js calls as bare globals. Every one of these files opens with
  // 'use strict', so each eval() gets its own scope and function declarations
  // do NOT leak between them -- hence the explicit export epilogue appended
  // inside api's scope, the same technique dashboard_status.test.js uses.
  const api = [
    fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8'),
    'global.escapeHtml = escapeHtml;',
    'global.toNumber = toNumber;',
    'global.formatCurrency = formatCurrency;',
    'global.formatQty = formatQty;',
    'global.parseRecordDate = parseRecordDate;',
  ].join('\n');
  // eslint-disable-next-line no-eval
  eval(api);

  // core.js supplies App.Utils / App.State / App.Selection.
  const core = fs
    .readFileSync(path.join(__dirname, '..', 'core.js'), 'utf8')
    .replace(/^const App = /m, 'global.App = ');
  // eslint-disable-next-line no-eval
  eval(core);

  const vendors = fs.readFileSync(path.join(__dirname, '..', 'vendors.js'), 'utf8');
  // eslint-disable-next-line no-eval
  eval(vendors);
}

beforeEach(() => {
  delete window.__xss;
  document.body.innerHTML = '';
  loadVendors();
});

describe('SEC-004: vendor row rendering escapes user input', () => {
  function renderVendorRow(vendor) {
    document.body.innerHTML = '<table><tbody id="vendorTableBody"></tbody></table>';
    App.State.globalVendors = [vendor];
    // renderTable() paginates filteredVendors, not globalVendors -- go through
    // filterData('') so the same code path the app uses populates it.
    App.State.selectedVendors = [];
    App.Vendor.filterData('');
    return document.getElementById('vendorTableBody');
  }

  test('a GSTIN containing an <img onerror> payload does not execute', () => {
    const body = renderVendorRow({
      name: 'Sharma Cycles', contact: '9876543210', address: 'Ludhiana',
      gstin: PAYLOAD
    });
    expect(body.querySelector('img')).toBeNull();
    expect(window.__xss).toBeUndefined();
    // Rendered as text, so the operator can still see what was entered.
    expect(body.textContent).toContain('onerror');
  });

  test('a GSTIN containing a <script> payload does not execute', () => {
    const body = renderVendorRow({
      name: 'Sharma Cycles', contact: '', address: '', gstin: SCRIPT_PAYLOAD
    });
    expect(body.querySelector('script')).toBeNull();
    expect(window.__xss).toBeUndefined();
  });

  test('an empty GSTIN still renders the placeholder', () => {
    const body = renderVendorRow({ name: 'V', contact: '', address: '', gstin: '' });
    expect(body.textContent).toContain('No GSTIN');
  });
});

describe('SEC-004: vendor ledger and pending tables escape user input', () => {
  function renderLedgerFor(vendorName) {
    document.body.innerHTML = `
      <table><tbody id="vendorLedgerBody"></tbody></table>
      <table><tbody id="vendorPendingBody"></tbody></table>
      <table><tbody id="vendorRatesBody"></tbody></table>`;
    App.Vendor.populateLedgerAndPending(vendorName);
  }

  test('a bill number containing a payload does not execute', () => {
    App.State.globalPOs = [];
    App.State.globalReturns = [];
    App.State.globalIssues = [];
    App.State.globalBills = [{
      vendor: 'Sharma Cycles',
      billNumber: PAYLOAD,
      billDate: '01/08/2026',
      items: [{ name: 'Rim', qty: 2 }],
      totalAmount: 100
    }];

    renderLedgerFor('Sharma Cycles');
    const body = document.getElementById('vendorLedgerBody');
    expect(body.querySelector('img')).toBeNull();
    expect(window.__xss).toBeUndefined();
    expect(body.textContent).toContain('onerror');
  });

  test('an item name containing a payload does not execute in the ledger', () => {
    App.State.globalBills = [];
    App.State.globalReturns = [];
    App.State.globalIssues = [];
    App.State.globalPOs = [{
      vendor: 'Sharma Cycles',
      poNumber: '1',
      poDate: '01/08/2026',
      items: [{ name: PAYLOAD, qty: 5 }],
      grandTotal: 500
    }];

    renderLedgerFor('Sharma Cycles');
    expect(document.getElementById('vendorLedgerBody').querySelector('img')).toBeNull();
    expect(window.__xss).toBeUndefined();
  });

  test('an item name containing a payload does not execute in pending items', () => {
    App.State.globalBills = [];
    App.State.globalReturns = [];
    App.State.globalIssues = [];
    App.State.globalPOs = [{
      vendor: 'Sharma Cycles',
      poNumber: '1',
      poDate: '01/08/2026',
      items: [{ name: PAYLOAD, size: SCRIPT_PAYLOAD, qty: 5 }],
      grandTotal: 500
    }];

    renderLedgerFor('Sharma Cycles');
    const pending = document.getElementById('vendorPendingBody');
    expect(pending.querySelector('img')).toBeNull();
    expect(pending.querySelector('script')).toBeNull();
    expect(window.__xss).toBeUndefined();
  });
});

describe('UX-003: item lists are escaped exactly once', () => {
  test('an ampersand renders as an ampersand, not as &amp;amp;', () => {
    // `items` used to be pre-escaped in calculateLedgerAndPending and then
    // escaped AGAIN by the print builder, so the printed document showed
    // literal entity text. Two render sites disagreeing about whether a field
    // was already escaped is how the raw sinks above got missed in the first
    // place; both now escape once.
    App.State.globalPOs = [];
    App.State.globalReturns = [];
    App.State.globalIssues = [];
    App.State.globalBills = [{
      vendor: 'Sharma Cycles',
      billNumber: 'B-1',
      billDate: '01/08/2026',
      items: [{ name: 'Nuts & Bolts', qty: 3 }],
      totalAmount: 10
    }];

    document.body.innerHTML = `
      <table><tbody id="vendorLedgerBody"></tbody></table>
      <table><tbody id="vendorPendingBody"></tbody></table>
      <table><tbody id="vendorRatesBody"></tbody></table>`;
    App.Vendor.populateLedgerAndPending('Sharma Cycles');

    const text = document.getElementById('vendorLedgerBody').textContent;
    expect(text).toContain('Nuts & Bolts');
    expect(text).not.toContain('&amp;');
  });
});
