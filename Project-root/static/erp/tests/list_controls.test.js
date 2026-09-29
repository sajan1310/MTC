/**
 * The one-row list toolbar: the date button and the ⇅ sort menu
 * (App.ListControls in core.js).
 *
 * The date button is the only date filter a list has. It names the window
 * it applies ("This month", "17 Sep 2026"), so a narrowed list always says
 * why on screen, and it writes the same From/To inputs the modules already
 * read, so no module learned a second way to filter. The ⇅ menu and the
 * sortable headers both go through the module's sortBy() and are redrawn
 * after every change, so the menu's tick and the header's arrow agree.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PARTIAL = f => fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', f), 'utf8');

function loadModules(...files) {
  const api = [
    fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8'),
    'global.Api = Api;',
    'global.escapeHtml = escapeHtml;',
    'global.toNumber = toNumber;',
    'global.formatCurrency = formatCurrency;',
    'global.formatQty = formatQty;',
    'global.parseRecordDate = parseRecordDate;',
    'global.dateToInputValue = dateToInputValue;',
    'global.inDateRange = inDateRange;',
    'global.todayIso = todayIso;',
    'global.normalizeDateForInput = normalizeDateForInput;',
    'global.PO_STATUS = PO_STATUS;',
  ].join('\n');
  // eslint-disable-next-line no-eval
  eval(api);

  const core = fs
    .readFileSync(path.join(__dirname, '..', 'core.js'), 'utf8')
    .replace(/^const App = /m, 'global.App = ');
  // eslint-disable-next-line no-eval
  eval(core);

  files.forEach(f => {
    // eslint-disable-next-line no-eval
    eval(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
  });
}

const change = (id, value) => {
  const input = document.getElementById(id);
  input.value = value;
  input.dispatchEvent(new Event('change', { bubbles: true }));
};

describe('quick picks', () => {
  beforeAll(() => loadModules());

  const TODAY = '2026-09-29'; // a Tuesday

  test.each([
    ['today', '2026-09-29', '2026-09-29'],
    ['yesterday', '2026-09-28', '2026-09-28'],
    ['week', '2026-09-28', '2026-10-04'],
    ['month', '2026-09-01', '2026-09-30'],
    ['lastMonth', '2026-08-01', '2026-08-31'],
  ])('%s', (key, from, to) => {
    expect(App.ListControls.presetRange(key, TODAY)).toEqual({ from, to });
  });

  test('yesterday and last month cross a year end', () => {
    expect(App.ListControls.presetRange('yesterday', '2027-01-01'))
      .toEqual({ from: '2026-12-31', to: '2026-12-31' });
    expect(App.ListControls.presetRange('lastMonth', '2027-01-15'))
      .toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });

  test('a week runs Monday to Sunday, across a month end', () => {
    // 1 Oct 2026 is a Thursday, 4 Oct the Sunday of the same week.
    expect(App.ListControls.presetRange('week', '2026-10-01'))
      .toEqual({ from: '2026-09-28', to: '2026-10-04' });
    expect(App.ListControls.presetRange('week', '2026-10-04'))
      .toEqual({ from: '2026-09-28', to: '2026-10-04' });
  });

  test('months end where the calendar says', () => {
    expect(App.ListControls.presetRange('lastMonth', '2028-03-10'))
      .toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(App.ListControls.presetRange('month', '2027-02-10'))
      .toEqual({ from: '2027-02-01', to: '2027-02-28' });
  });
});

describe('what the date button says', () => {
  beforeAll(() => loadModules());

  test.each([
    ['', '', 'All dates'],
    ['2026-09-01', '2026-09-30', 'This month'],
    ['2026-09-29', '2026-09-29', 'Today'],
    ['2026-09-17', '2026-09-17', '17 Sep 2026'],
    ['2026-09-01', '2026-09-15', '1–15 Sep 2026'],
    ['2026-08-26', '2026-09-09', '26 Aug – 9 Sep 2026'],
    ['2025-12-28', '2026-01-03', '28 Dec 2025 – 3 Jan 2026'],
    ['2026-09-01', '', 'From 1 Sep 2026'],
    ['', '2026-09-30', 'Up to 30 Sep 2026'],
  ])('%s..%s reads "%s"', (from, to, text) => {
    expect(App.ListControls.label(from, to, '2026-09-29')).toBe(text);
  });
});

describe('the date button', () => {
  let calls;

  beforeEach(() => {
    jest.resetModules();
    loadModules();
    jest.useFakeTimers().setSystemTime(new Date(2026, 8, 29, 10, 0, 0));
    calls = [];
    // A stand-in with the two methods every list's module has.
    App.Fake = {
      filterByDateRange() {
        calls.push('filter');
        App.Utils.readDateRange('fake', 'fakeDateFrom', 'fakeDateTo');
      },
      clearDateRange() {
        calls.push('clear');
        App.Utils.clearDateRange('fake', 'fakeDateFrom', 'fakeDateTo');
      }
    };
    document.body.innerHTML = '<div class="list-date" data-list="fake" data-module="Fake" data-noun="widgets"></div>';
    App.ListControls.mountAll();
  });

  afterEach(() => jest.useRealTimers());

  const el = () => document.querySelector('.list-date');
  const label = () => el().querySelector('.list-date-label').textContent;
  const click = selector => el().querySelector(selector).click();

  test('starts on All dates, with nothing to clear', () => {
    expect(label()).toBe('All dates');
    expect(el().querySelector('.list-date-clear').hidden).toBe(true);
    expect(el().querySelector('[data-preset="all"]').getAttribute('aria-pressed')).toBe('true');
  });

  test('builds the inputs its module reads', () => {
    ['fakeDateFrom', 'fakeDateTo', 'fakeDateDay'].forEach(id => {
      expect(document.getElementById(id)).not.toBeNull();
    });
  });

  test('a quick pick filters, and the button names the window', () => {
    click('[data-preset="month"]');

    expect(calls).toEqual(['filter']);
    expect(App.Utils.dateRange('fake')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(label()).toBe('This month');
    expect(el().classList.contains('is-set')).toBe(true);
    expect(el().querySelector('.list-date-clear').hidden).toBe(false);
    expect(el().querySelector('[data-preset="month"]').getAttribute('aria-pressed')).toBe('true');
    expect(el().querySelector('.list-date-btn').getAttribute('aria-label'))
      .toBe('Filter widgets by date: This month');
  });

  test('a single day is a window with both ends on it', () => {
    change('fakeDateDay', '2026-09-17');

    expect(App.Utils.dateRange('fake')).toEqual({ from: '2026-09-17', to: '2026-09-17' });
    expect(label()).toBe('17 Sep 2026');
    expect(document.getElementById('fakeDateFrom').value).toBe('2026-09-17');
    expect(document.getElementById('fakeDateTo').value).toBe('2026-09-17');
  });

  test('a range typed into Between applies one end at a time', () => {
    change('fakeDateFrom', '2026-09-01');
    expect(label()).toBe('From 1 Sep 2026');

    change('fakeDateTo', '2026-09-15');
    expect(App.Utils.dateRange('fake')).toEqual({ from: '2026-09-01', to: '2026-09-15' });
    expect(label()).toBe('1–15 Sep 2026');
    // Not one day, so the single-day box stays empty.
    expect(document.getElementById('fakeDateDay').value).toBe('');
  });

  test('the × beside the button clears the window and hands focus back', () => {
    click('[data-preset="week"]');
    click('.list-date-clear');

    expect(calls).toEqual(['filter', 'clear']);
    expect(App.Utils.dateRange('fake')).toEqual({ from: '', to: '' });
    expect(label()).toBe('All dates');
    expect(el().querySelector('.list-date-clear').hidden).toBe(true);
    expect(document.activeElement).toBe(el().querySelector('.list-date-btn'));
  });

  test('All dates and Clear in the pop-up clear it too', () => {
    click('[data-preset="today"]');
    click('[data-preset="all"]');
    expect(App.Utils.dateRange('fake')).toEqual({ from: '', to: '' });

    click('[data-preset="yesterday"]');
    click('.list-date-reset');
    expect(App.Utils.dateRange('fake')).toEqual({ from: '', to: '' });
    expect(label()).toBe('All dates');
  });

  test('mounting twice does not build a second button', () => {
    App.ListControls.mountAll();
    expect(document.querySelectorAll('.list-date-btn')).toHaveLength(1);
  });

  test('a window set before mounting shows on the button', () => {
    // The store is the one place a list's dates live.
    document.body.innerHTML = '<div class="list-date" data-list="other" data-module="Fake"></div>';
    Object.assign(App.Utils.dateRange('other'), { from: '2026-08-01', to: '2026-08-31' });
    App.ListControls.mountAll();

    expect(document.querySelector('.list-date-label').textContent).toBe('Last month');
  });
});

describe('the sort menu and the headers', () => {
  let calls;

  beforeEach(() => {
    jest.resetModules();
    loadModules();
    calls = [];
    App.State.fakeSortBy = 'dateDesc';
    App.Fake = {
      sortBy(value) {
        calls.push(value);
        App.State.fakeSortBy = value;
      }
    };
    document.body.innerHTML = `
      <div class="dropdown list-sort" data-list="fake" data-module="Fake" data-state="fakeSortBy"
           data-default="dateDesc" data-noun="widgets">
        <button type="button" class="btn list-ctl list-sort-btn">⇅</button>
        <ul class="dropdown-menu">
          <li><button type="button" class="dropdown-item" data-sort="dateDesc">Date (Newest first)</button></li>
          <li><button type="button" class="dropdown-item" data-sort="dateAsc">Date (Oldest first)</button></li>
          <li><button type="button" class="dropdown-item" data-sort="vendorAsc">Vendor (A–Z)</button></li>
          <li><button type="button" class="dropdown-item" data-sort="vendorDesc">Vendor (Z–A)</button></li>
        </ul>
      </div>
      <table data-list="fake"><thead><tr>
        <th scope="col" data-sort-keys="dateDesc,dateAsc"><i class="bi bi-calendar me-2"></i>Date</th>
        <th scope="col" data-sort-keys="vendorAsc,vendorDesc">Vendor <button type="button"
            class="th-filter-btn" aria-label="Filter by Vendor"><i class="bi bi-funnel"></i></button></th>
        <th scope="col">Items</th>
      </tr></thead></table>`;
    App.ListControls.mountAll();
  });

  const th = i => document.querySelectorAll('th')[i];
  const item = key => document.querySelector(`[data-sort="${key}"]`);
  const sortBtn = () => document.querySelector('.list-sort-btn');

  test('the default order is ticked, its column marked, the button plain', () => {
    expect(item('dateDesc').getAttribute('aria-current')).toBe('true');
    expect(sortBtn().classList.contains('is-set')).toBe(false);
    expect(sortBtn().getAttribute('aria-label')).toBe('Sort widgets: Date (Newest first)');
    expect(th(0).getAttribute('aria-sort')).toBe('descending');
    expect(th(1).getAttribute('aria-sort')).toBe('none');
  });

  test('picking from the menu sorts, and the arrow moves to that column', () => {
    item('vendorAsc').click();

    expect(calls).toEqual(['vendorAsc']);
    expect(item('vendorAsc').classList.contains('is-current')).toBe(true);
    expect(item('dateDesc').hasAttribute('aria-current')).toBe(false);
    expect(sortBtn().classList.contains('is-set')).toBe(true);
    expect(th(1).getAttribute('aria-sort')).toBe('ascending');
    expect(th(1).querySelector('.th-sort-ind').classList.contains('bi-caret-up-fill')).toBe(true);
    expect(th(0).getAttribute('aria-sort')).toBe('none');
    expect(th(0).querySelector('.th-sort-ind').classList.contains('bi-arrow-down-up')).toBe(true);
  });

  test('a header picks its first order, then flips on each click', () => {
    const btn = th(1).querySelector('.th-sort-btn');
    btn.click();
    btn.click();
    btn.click();
    expect(calls).toEqual(['vendorAsc', 'vendorDesc', 'vendorAsc']);
  });

  test('clicking the sorted column flips it, and the menu follows', () => {
    th(0).querySelector('.th-sort-btn').click();

    expect(calls).toEqual(['dateAsc']);
    expect(item('dateAsc').getAttribute('aria-current')).toBe('true');
    expect(th(0).getAttribute('aria-sort')).toBe('ascending');
    expect(sortBtn().classList.contains('is-set')).toBe(true);
  });

  test('a column filter keeps its own button beside the sort button', () => {
    const sort = th(1).querySelector('.th-sort-btn');
    expect(sort.textContent.trim()).toBe('Vendor');
    expect(sort.title).toBe('Sort by Vendor');
    expect(sort.querySelector('.th-filter-btn')).toBeNull();
    expect(th(1).querySelector(':scope > .th-filter-btn')).not.toBeNull();
  });

  test('a header without sort keys is left alone', () => {
    expect(th(2).querySelector('.th-sort-btn')).toBeNull();
    expect(th(2).hasAttribute('aria-sort')).toBe(false);
  });

  test('mounting twice wraps each header once', () => {
    App.ListControls.mountAll();
    expect(document.querySelectorAll('.th-sort-btn')).toHaveLength(2);
  });
});

describe('on the real lists', () => {
  // Mounted from the partials and driven through the controls, then checked
  // on what the module lists.
  beforeEach(() => {
    jest.resetModules();
    loadModules('bill.js', 'po.js', 'issue.js', 'return.js', 'dispatch.js', 'production.js', 'client.js');
    jest.useFakeTimers().setSystemTime(new Date(2026, 8, 29, 10, 0, 0));
  });

  afterEach(() => jest.useRealTimers());

  const numbers = (list, key) => App.State[list].map(r => r[key]);

  test('Bills: This month narrows the list, and Amount orders it both ways', () => {
    document.body.innerHTML = PARTIAL('bill_ledger.html');
    App.Bill.renderTable = jest.fn();
    App.State.globalBills = [
      { billNumber: 'B1', vendor: 'acme', billDate: '20/08/2026', billDateRaw: '2026-08-20', totalAmount: 500, items: [] },
      { billNumber: 'B2', vendor: 'acme', billDate: '05/09/2026', billDateRaw: '2026-09-05', totalAmount: 100, items: [] },
      { billNumber: 'B3', vendor: 'zeta', billDate: '20/09/2026', billDateRaw: '2026-09-20', totalAmount: 900, items: [] },
    ];
    App.ListControls.mountAll();

    document.querySelector('.list-date[data-list="bill"] [data-preset="month"]').click();
    expect(numbers('filteredBills', 'billNumber')).toEqual(['B3', 'B2']);

    const amount = document.querySelector('table[data-list="bill"] th[data-sort-keys^="amount"] .th-sort-btn');
    amount.click();
    expect(App.State.billSortBy).toBe('amountDesc');
    expect(numbers('filteredBills', 'billNumber')).toEqual(['B3', 'B2']);
    amount.click();
    expect(numbers('filteredBills', 'billNumber')).toEqual(['B2', 'B3']);
    expect(document.querySelector('.list-sort[data-list="bill"] [data-sort="amountAsc"]')
      .getAttribute('aria-current')).toBe('true');
  });

  test('Returns can be ordered now: Credit, high to low, from the menu', () => {
    document.body.innerHTML = PARTIAL('return_ledger.html');
    App.Return.renderTable = jest.fn();
    App.State.globalReturns = [
      { returnNumber: 'R1', vendor: 'acme', returnDate: '10/09/2026', returnDateRaw: '2026-09-10', totalAmount: 50, items: [] },
      { returnNumber: 'R2', vendor: 'acme', returnDate: '01/09/2026', returnDateRaw: '2026-09-01', totalAmount: 700, items: [] },
    ];
    App.ListControls.mountAll();
    App.Return.applyFilters();
    expect(numbers('filteredReturns', 'returnNumber')).toEqual(['R1', 'R2']);

    document.querySelector('.list-sort[data-list="return"] [data-sort="creditDesc"]').click();
    expect(numbers('filteredReturns', 'returnNumber')).toEqual(['R2', 'R1']);
  });

  test('Production: a sortable header keeps its column-filter funnel', () => {
    document.body.innerHTML = PARTIAL('production.html');
    App.ListControls.mountAll();

    const status = document.querySelector('table[data-list="production"] th[data-sort-keys^="status"]');
    expect(status.querySelector('.th-sort-btn')).not.toBeNull();
    expect(status.querySelector(':scope > .th-filter-btn[data-filter-key="status"]')).not.toBeNull();
  });

  test('PI / Estimates: a single day from the pop-up narrows the list', () => {
    document.body.innerHTML = PARTIAL('clients.html');
    App.Client.renderOrdersTable = jest.fn();
    App.State.globalOrders = [
      { orderNumber: 'PI-9', orderDate: '17/09/2026', dateRaw: '2026-09-17', clientName: 'sharma', lines: [] },
      { orderNumber: 'PI-10', orderDate: '18/09/2026', dateRaw: '2026-09-18', clientName: 'verma', lines: [] },
    ];
    App.ListControls.mountAll();

    change('orderDateDay', '2026-09-17');
    expect(numbers('filteredOrders', 'orderNumber')).toEqual(['PI-9']);
    expect(document.querySelector('.list-date[data-list="order"] .list-date-label').textContent).toBe('17 Sep 2026');
  });

  test('Issued Stock: a reload after a save keeps the window the button shows', async () => {
    document.body.innerHTML = PARTIAL('production.html');
    App.Issue.renderTable = jest.fn();
    App.ListControls.mountAll();
    document.querySelector('.list-date[data-list="issue"] [data-preset="lastMonth"]').click();

    Api.call = jest.fn().mockResolvedValue({
      success: true,
      data: [
        { issueId: 'ISS-2', date: '02/09/2026', dateRaw: '2026-09-02', items: [] },
        { issueId: 'ISS-1', date: '14/08/2026', dateRaw: '2026-08-14', items: [] },
      ]
    });
    await App.Issue.loadData();

    expect(numbers('filteredIssues', 'issueId')).toEqual(['ISS-1']);
    expect(document.querySelector('.list-date[data-list="issue"] .list-date-label').textContent).toBe('Last month');
  });
});
