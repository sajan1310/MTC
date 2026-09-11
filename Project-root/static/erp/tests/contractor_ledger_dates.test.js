/**
 * The contractor ledger: a date window, and pages.
 *
 * It was the one table in the app with no pagination -- a contractor with
 * two years of lots rendered every row at once -- and the only date filter
 * anywhere was an exact-match one, which answers a question nobody asks of
 * a ledger. The real question is "this week", "since the audit".
 *
 * The trap, and most of what these tests are for: the balance column is a
 * running total the server computes across the WHOLE account. Drop rows
 * from the front of it and the first visible balance still contains
 * everything before it, so a filtered ledger reads as though the account
 * began mid-window -- wrong in a way that still looks plausible, because
 * every individual number on screen is one the server really sent.
 *
 * An opening-balance row is what makes the column reconcile again.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function loadContractor() {
  const api = [
    fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8'),
    'global.escapeHtml = escapeHtml;',
    'global.toNumber = toNumber;',
    'global.formatCurrency = formatCurrency;',
    'global.formatQty = formatQty;',
    'global.parseRecordDate = parseRecordDate;',
    'global.dateToInputValue = dateToInputValue;',
    'global.todayIso = todayIso;',
  ].join('\n');
  // eslint-disable-next-line no-eval
  eval(api);

  const core = fs
    .readFileSync(path.join(__dirname, '..', 'core.js'), 'utf8')
    .replace(/^const App = /m, 'global.App = ');
  // eslint-disable-next-line no-eval
  eval(core);

  // eslint-disable-next-line no-eval
  eval(fs.readFileSync(path.join(__dirname, '..', 'contractor.js'), 'utf8'));
}

// A running balance across the whole account: 1000 payable, 400 paid,
// 500 payable, 300 paid. The window tests below all cut into the middle
// of it, which is where the balance column can lie.
const ENTRIES = [
  { rowIdx: 1, date: '01/01/2026', dateRaw: '2026-01-01', type: 'Payable', ref: 'LOT-1', description: 'Lot 1', amount: 1000, rawAmount: 0, balance: 1000 },
  { rowIdx: 2, date: '15/01/2026', dateRaw: '2026-01-15', type: 'Payment', ref: 'PAY-1', description: 'Cash', amount: 0, rawAmount: 400, balance: 600 },
  { rowIdx: 3, date: '01/02/2026', dateRaw: '2026-02-01', type: 'Payable', ref: 'LOT-2', description: 'Lot 2', amount: 500, rawAmount: 0, balance: 1100 },
  { rowIdx: 4, date: '20/02/2026', dateRaw: '2026-02-20', type: 'Payment', ref: 'PAY-2', description: 'UPI', amount: 0, rawAmount: 300, balance: 800 },
];

function mount(entries = ENTRIES) {
  jest.resetModules();
  document.body.innerHTML = `
    <input type="date" id="ledgerDateFrom">
    <input type="date" id="ledgerDateTo">
    <div id="ledgerRangeNote"></div>
    <table><tbody id="contractorLedgerBody"></tbody></table>
    <div id="contractorLedgerPagination"></div>
    <div id="btnBulkDeleteContractorPayments"></div>`;
  loadContractor();
  App.State.currentAccountLedgerContractor = 'ravi';
  App.State.currentAccountLedgerData = { contractorName: 'ravi', entries };
  App.State.ledgerDateFrom = '';
  App.State.ledgerDateTo = '';
  App.State.ledgerCurrentPage = 1;
  App.Contractor.updatePaymentsBulkButton = jest.fn();
}

const rows = () => [...document.querySelectorAll('#contractorLedgerBody tr')];
const rowText = () => rows().map(r => r.textContent.replace(/\s+/g, ' ').trim());
const setRange = (from, to) => {
  document.getElementById('ledgerDateFrom').value = from;
  document.getElementById('ledgerDateTo').value = to;
  App.Contractor.filterLedgerByDate();
};

describe('the date window', () => {
  beforeEach(() => mount());

  test('no window shows every entry', () => {
    App.Contractor.renderLedgerTable();
    expect(rows()).toHaveLength(4);
  });

  test('both ends are inclusive', () => {
    setRange('2026-01-15', '2026-02-01');
    // The 15th and the 1st themselves are in, so this is 2 entries plus the
    // opening row.
    expect(rowText().filter(t => t.includes('PAY-1') || t.includes('LOT-2'))).toHaveLength(2);
    expect(rowText().some(t => t.includes('LOT-1'))).toBe(false);
    expect(rowText().some(t => t.includes('PAY-2'))).toBe(false);
  });

  test('a From with no To means "everything since"', () => {
    setRange('2026-02-01', '');
    expect(rowText().some(t => t.includes('LOT-2'))).toBe(true);
    expect(rowText().some(t => t.includes('PAY-2'))).toBe(true);
    expect(rowText().some(t => t.includes('LOT-1'))).toBe(false);
  });

  test('a To with no From means "everything up to"', () => {
    setRange('', '2026-01-15');
    expect(rowText().some(t => t.includes('LOT-1'))).toBe(true);
    expect(rowText().some(t => t.includes('PAY-1'))).toBe(true);
    expect(rowText().some(t => t.includes('LOT-2'))).toBe(false);
  });

  test('a window matching nothing says so, rather than looking broken', () => {
    setRange('2027-01-01', '2027-12-31');
    expect(rowText().join(' ')).toContain('No transactions in the selected dates');
  });

  test('clearing the dates brings everything back', () => {
    setRange('2026-02-01', '');
    App.Contractor.clearLedgerDateFilter();

    expect(rows()).toHaveLength(4);
    expect(document.getElementById('ledgerDateFrom').value).toBe('');
  });

  test('the note says how much of the account is in view', () => {
    setRange('2026-02-01', '');
    expect(document.getElementById('ledgerRangeNote').textContent).toBe('2 of 4 entries in range');
  });

  test('and says nothing when no window is set', () => {
    App.Contractor.renderLedgerTable();
    expect(document.getElementById('ledgerRangeNote').textContent).toBe('');
  });
});

describe('the opening balance', () => {
  beforeEach(() => mount());

  test('carries in the balance from before the window', () => {
    // THE test. Without this row the first visible balance is 1100, which
    // reads as though the account started at 1100 in February -- when in
    // fact 600 was already owed on the 31st of January.
    setRange('2026-02-01', '');

    const opening = rows()[0].textContent.replace(/\s+/g, ' ');
    expect(opening).toContain('Opening');
    expect(opening).toContain('600');
  });

  test('is absent when the window has no start', () => {
    // Nothing is being excluded from the front, so there is nothing to
    // carry in and a zero row would be noise.
    setRange('', '2026-02-01');
    expect(rows()[0].textContent).not.toContain('Opening');
  });

  test('is zero when the window starts before any entry', () => {
    setRange('2025-01-01', '');
    const opening = rows()[0].textContent.replace(/\s+/g, ' ');
    expect(opening).toContain('Opening');
    expect(opening).toMatch(/0\.00/);
  });

  test('the running balances themselves are the server\'s, untouched', () => {
    // They are cumulative from the start of the account, which is exactly
    // why the opening row is needed rather than a recomputation. Recomputing
    // within the window would misstate the account.
    setRange('2026-02-01', '');
    const text = rowText().join(' ');
    expect(text).toContain('1100.00');
    expect(text).toContain('800.00');
  });
});

describe('pagination', () => {
  const MANY = Array.from({ length: 60 }, (_, i) => ({
    rowIdx: i + 1,
    date: `01/01/2026`,
    dateRaw: '2026-01-01',
    type: 'Payment', ref: `PAY-${i + 1}`, description: 'x',
    amount: 0, rawAmount: 10, balance: 10 * (i + 1),
  }));

  beforeEach(() => mount(MANY));

  test('renders one page, not sixty rows', () => {
    App.Contractor.renderLedgerTable();
    expect(rows()).toHaveLength(App.State.ledgerRowsPerPage);
  });

  test('the control reports the whole count', () => {
    App.Contractor.renderLedgerTable();
    expect(document.getElementById('contractorLedgerPagination').textContent).toContain('60');
  });

  test('changing page shows the next slice', () => {
    App.Contractor.renderLedgerTable();
    const first = rowText()[0];

    App.Contractor.changeLedgerPage(2);

    expect(rowText()[0]).not.toBe(first);
    expect(App.State.ledgerCurrentPage).toBe(2);
  });

  test('a page beyond the end is clamped rather than showing nothing', () => {
    App.Contractor.changeLedgerPage(999);
    expect(rows().length).toBeGreaterThan(0);
  });

  test('the opening row appears on the first page only', () => {
    // It is an opening balance for the window, not a header repeated on
    // every page -- and repeating it would double-count by eye.
    App.State.currentAccountLedgerData = { contractorName: 'ravi', entries: ENTRIES };
    setRange('2026-01-15', '');
    expect(rows()[0].textContent).toContain('Opening');

    App.State.ledgerRowsPerPage = 1;
    App.Contractor.changeLedgerPage(2);
    expect(rows()[0].textContent).not.toContain('Opening');
  });

  test('filtering resets to the first page', () => {
    App.Contractor.changeLedgerPage(3);
    setRange('2026-01-01', '');
    expect(App.State.ledgerCurrentPage).toBe(1);
  });
});

describe('the shared range predicate', () => {
  beforeEach(() => mount());

  test('no window passes everything, including undated records', () => {
    expect(App.Utils.inDateRange('', '', '', '')).toBe(true);
  });

  test('an undated record is out once a window is set', () => {
    // It cannot be shown to fall inside one, and including it would
    // inflate every filtered total.
    expect(App.Utils.inDateRange('', '', '2026-01-01', '')).toBe(false);
  });

  test('boundaries are inclusive at both ends', () => {
    expect(App.Utils.inDateRange('2026-01-01', '', '2026-01-01', '2026-01-31')).toBe(true);
    expect(App.Utils.inDateRange('2026-01-31', '', '2026-01-01', '2026-01-31')).toBe(true);
  });

  test('outside is outside', () => {
    expect(App.Utils.inDateRange('2025-12-31', '', '2026-01-01', '2026-01-31')).toBe(false);
    expect(App.Utils.inDateRange('2026-02-01', '', '2026-01-01', '2026-01-31')).toBe(false);
  });
});

describe('where things sit on the ledger tab', () => {
  const HTML = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', 'contractors.html'),
    'utf8'
  );

  // Order asserted by position in the markup, because the complaint was
  // about order: recording a payment sat after the table, so the operator
  // scrolled past every lot on the account to reach it -- past MORE of
  // them the longer the contractor had been working. The one action on
  // this screen got harder to reach the more it was used.
  const at = needle => {
    const i = HTML.indexOf(needle);
    expect(i).toBeGreaterThan(-1);
    return i;
  };

  test('the date window comes before the totals', () => {
    expect(at('id="ledgerDateFrom"')).toBeLessThan(at('id="ledgerTotalPayable"'));
  });

  test('recording a payment sits under the totals it changes', () => {
    expect(at('id="ledgerBalanceDue"')).toBeLessThan(at('Record a Payment'));
  });

  test('...and above the table, not below it', () => {
    expect(at('id="paymentFormAmount"')).toBeLessThan(at('id="contractorLedgerBody"'));
    expect(at('App.Contractor.recordPayment()')).toBeLessThan(at('id="contractorLedgerBody"'));
  });

  test('pagination is last, and outside the scrolling table', () => {
    // Inside .table-responsive it would scroll horizontally with the table
    // and sit below its own scrollbar.
    expect(at('id="contractorLedgerBody"')).toBeLessThan(at('id="contractorLedgerPagination"'));
    const afterTable = HTML.slice(at('id="contractorLedgerBody"'));
    const closeWrapper = afterTable.indexOf('</table>');
    const pagination = afterTable.indexOf('id="contractorLedgerPagination"');
    expect(closeWrapper).toBeLessThan(pagination);
  });

  test('the note still describes where payments are recorded', () => {
    // It said "recorded below" when the form was below. It is not any more.
    const note = HTML.slice(at('Payable rows are computed live'), at('Payable rows are computed live') + 260);
    expect(note).toContain('above');
    expect(note).not.toContain('recorded below');
  });
});

