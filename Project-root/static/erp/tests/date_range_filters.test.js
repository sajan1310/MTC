/**
 * The date window, across the modules.
 *
 * Five ledgers had an exact-date filter -- "show me the 4th" -- next to a
 * from/to window, and both applied, so a day left in one box and a range
 * in the other could empty a list with nothing on screen saying why.
 * There is now one date filter per list: the toolbar's date button
 * (App.ListControls), where a single day is a window with both ends on
 * that day. Production, Dispatch and PI / Estimates had no date filter.
 *
 * The window lives in one store keyed by module (App.Utils.dateRange)
 * rather than as two State keys per module, because eight lists times two
 * keys is sixteen chances for one to be reset where the others are not.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HTML = f => fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', f), 'utf8');

function loadModules(...files) {
  const api = [
    fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8'),
    'global.escapeHtml = escapeHtml;',
    'global.toNumber = toNumber;',
    'global.formatCurrency = formatCurrency;',
    'global.formatQty = formatQty;',
    'global.parseRecordDate = parseRecordDate;',
    'global.dateToInputValue = dateToInputValue;',
    'global.inDateRange = inDateRange;',
    'global.todayIso = todayIso;',
    'global.normalizeDateForInput = normalizeDateForInput;',
    // po.js reads it at module scope; api.js is where the one
    // client-side copy of the server's PO_STATUS lives.
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

function inputs(prefix) {
  document.body.innerHTML = `
    <input type="date" id="${prefix}DateFrom">
    <input type="date" id="${prefix}DateTo">`;
}

const setRange = (prefix, from, to) => {
  document.getElementById(`${prefix}DateFrom`).value = from;
  document.getElementById(`${prefix}DateTo`).value = to;
};

describe('the shared window store', () => {
  beforeEach(() => {
    jest.resetModules();
    document.body.innerHTML = '';
    loadModules();
  });

  test('an unset module reads as an empty window, meaning "everything"', () => {
    // A module that has not opted in must behave exactly as it did.
    expect(App.Utils.dateRange('never-touched')).toEqual({ from: '', to: '' });
  });

  test('reading pulls both inputs in', () => {
    inputs('x');
    setRange('x', '2026-01-01', '2026-01-31');

    expect(App.Utils.readDateRange('x', 'xDateFrom', 'xDateTo'))
      .toEqual({ from: '2026-01-01', to: '2026-01-31' });
  });

  test('clearing empties the inputs as well as the store', () => {
    inputs('x');
    setRange('x', '2026-01-01', '2026-01-31');
    App.Utils.readDateRange('x', 'xDateFrom', 'xDateTo');

    App.Utils.clearDateRange('x', 'xDateFrom', 'xDateTo');

    expect(App.Utils.dateRange('x')).toEqual({ from: '', to: '' });
    expect(document.getElementById('xDateFrom').value).toBe('');
  });

  test('modules do not share a window', () => {
    // The whole reason the store is keyed. A window on Bills must not
    // quietly filter Purchase Orders.
    inputs('x');
    setRange('x', '2026-01-01', '');
    App.Utils.readDateRange('x', 'xDateFrom', 'xDateTo');

    expect(App.Utils.dateRange('other')).toEqual({ from: '', to: '' });
  });
});

describe('Bills', () => {
  const BILLS = [
    { billNumber: 'B1', vendor: 'acme', billDate: '01/01/2026', billDateRaw: '2026-01-01', items: [] },
    { billNumber: 'B2', vendor: 'acme', billDate: '15/02/2026', billDateRaw: '2026-02-15', items: [] },
  ];

  beforeEach(() => {
    jest.resetModules();
    loadModules('bill.js');
    inputs('bill');
    App.State.globalBills = BILLS;
    App.State.billSearchTerm = '';
    App.Bill.renderTable = jest.fn();
  });

  test('the window narrows the list', () => {
    setRange('bill', '2026-02-01', '');
    App.Bill.filterByDateRange();

    expect(App.State.filteredBills.map(b => b.billNumber)).toEqual(['B2']);
  });

  test('clearing it restores everything', () => {
    setRange('bill', '2026-02-01', '');
    App.Bill.filterByDateRange();
    App.Bill.clearDateRange();

    expect(App.State.filteredBills).toHaveLength(2);
  });

  test('a single day is a window with both ends on that day', () => {
    // Not a second filter beside the window: there is only the one.
    setRange('bill', '2026-02-15', '2026-02-15');
    App.Bill.filterByDateRange();

    expect(App.State.filteredBills.map(b => b.billNumber)).toEqual(['B2']);
    expect(App.Bill.filterByDate).toBeUndefined();
    expect(App.State).not.toHaveProperty('billDateFilter');
  });

  test('the control is declared in the markup', () => {
    // The date button and its inputs are built by App.ListControls; the
    // partial says where it goes and which list it filters.
    expect(HTML('bill_ledger.html')).toContain('class="list-date" data-list="bill" data-module="Bill"');
  });
});

describe('Production', () => {
  const LOTS = [
    { lotNumber: 'L1', date: '01/01/2026', dateRaw: '2026-01-01', status: 'Completed', colorQty: [] },
    { lotNumber: 'L2', date: '10/03/2026', dateRaw: '2026-03-10', status: 'Pending', colorQty: [] },
  ];

  beforeEach(() => {
    jest.resetModules();
    loadModules('production.js');
    inputs('production');
    App.State.globalProduction = LOTS;
    App.State.globalProcesses = [];
    App.State.productionSearchTerm = '';
    App.Production.renderTable = jest.fn();
    App.Production.sortFiltered = jest.fn();
  });

  test('had no date filter before; the window narrows it now', () => {
    setRange('production', '2026-03-01', '');
    App.Production.filterByDateRange();

    expect(App.State.filteredProduction.map(p => p.lotNumber)).toEqual(['L2']);
  });

  test('the window holds even with no column filters set', () => {
    // applyColumnFilters returns early when nothing is selected, so a
    // window applied inside it would silently do nothing.
    setRange('production', '2026-01-01', '2026-01-31');
    App.Production.filterByDateRange();

    expect(App.State.filteredProduction).toHaveLength(1);
  });

  test('it survives a search', () => {
    setRange('production', '2026-03-01', '');
    App.Production.filterByDateRange();
    App.Production.filterData('L2');

    expect(App.State.filteredProduction.map(p => p.lotNumber)).toEqual(['L2']);
  });

  test('the control is declared in the markup', () => {
    expect(HTML('production.html'))
      .toContain('class="list-date" data-list="production" data-module="Production"');
  });
});

describe('Dispatch', () => {
  const BILLS = [
    { dispatchNumber: 'D1', orderNumber: 'O1', clientName: 'sharma', dispatchDate: '01/01/2026', dateRaw: '2026-01-01', items: [] },
    { dispatchNumber: 'D2', orderNumber: 'O2', clientName: 'verma', dispatchDate: '05/04/2026', dateRaw: '2026-04-05', items: [] },
  ];

  beforeEach(() => {
    jest.resetModules();
    loadModules('dispatch.js');
    inputs('dispatch');
    App.State.globalDispatchBills = BILLS;
    App.State.dispatchSearchTerm = '';
    App.Dispatch.renderDispatchTable = jest.fn();
    App.Dispatch.sortFilteredDispatch = jest.fn();
  });

  test('had no date filter before; the window narrows it now', () => {
    setRange('dispatch', '2026-04-01', '');
    App.Dispatch.filterByDateRange();

    expect(App.State.filteredDispatchBills.map(b => b.dispatchNumber)).toEqual(['D2']);
  });

  test('picking a date does not silently drop the search', () => {
    // filterDispatch is the only path that rebuilds the list, so the
    // window has to re-run the search rather than replace it.
    App.Dispatch.filterDispatch('verma');
    setRange('dispatch', '2026-01-01', '');
    App.Dispatch.filterByDateRange();

    expect(App.State.filteredDispatchBills.map(b => b.dispatchNumber)).toEqual(['D2']);
  });

  test('the control is declared in the markup', () => {
    expect(HTML('dispatch.html'))
      .toContain('class="list-date" data-list="dispatch" data-module="Dispatch"');
  });
});

describe('PI / Estimates', () => {
  // Had no date filter, and no sort: "which estimates went out last month"
  // meant reading every row.
  const ORDERS = [
    { orderNumber: 'PI-9', orderDate: '12/08/2026', dateRaw: '2026-08-12', clientName: 'sharma', lines: [] },
    { orderNumber: 'PI-10', orderDate: '03/09/2026', dateRaw: '2026-09-03', clientName: 'verma', lines: [] },
  ];

  beforeEach(() => {
    jest.resetModules();
    loadModules('client.js');
    inputs('order');
    App.State.globalOrders = ORDERS;
    App.Client.renderOrdersTable = jest.fn();
  });

  test('the window narrows the list', () => {
    setRange('order', '2026-09-01', '');
    App.Client.filterByDateRange();

    expect(App.State.filteredOrders.map(o => o.orderNumber)).toEqual(['PI-10']);
  });

  test('it survives a search, and a search survives it', () => {
    setRange('order', '2026-08-01', '2026-09-30');
    App.Client.filterByDateRange();
    App.Client.filterOrders('verma');
    expect(App.State.filteredOrders.map(o => o.orderNumber)).toEqual(['PI-10']);

    App.Client.clearDateRange();
    expect(App.State.filteredOrders.map(o => o.orderNumber)).toEqual(['PI-10']);
  });

  test('the control is declared in the markup', () => {
    expect(HTML('clients.html')).toContain('class="list-date" data-list="order" data-module="Client"');
  });
});

// Every list with a date button, the module its controls call, and the
// module's own comparators, which the ⇅ menu and the headers must stay
// inside.
const LISTS = [
  ['bill_ledger.html', 'bill', 'Bill', () => App.Bill.SORT_COMPARATORS],
  ['po_ledger.html', 'po', 'PO', () => App.PO.SORT_COMPARATORS],
  ['return_ledger.html', 'return', 'Return', () => App.Return.SORT_COMPARATORS],
  ['return_ledger.html', 'wastage', 'Wastage', () => App.Wastage.SORT_COMPARATORS],
  ['production.html', 'production', 'Production', () => App.Production.SORT_COMPARATORS],
  ['production.html', 'issue', 'Issue', () => App.Issue.SORT_COMPARATORS],
  ['dispatch.html', 'dispatch', 'Dispatch', () => App.Dispatch.DISPATCH_SORT_COMPARATORS],
  ['clients.html', 'order', 'Client', () => App.Client.ORDER_SORT_COMPARATORS],
];

const ALL_MODULES = ['bill.js', 'po.js', 'issue.js', 'return.js', 'dispatch.js', 'production.js', 'client.js'];

describe('every module that got one is wired end to end', () => {
  beforeEach(() => {
    jest.resetModules();
    loadModules(...ALL_MODULES);
  });

  test('each exposes both handlers', () => {
    LISTS.forEach(([, , mod]) => {
      expect(typeof App[mod].filterByDateRange).toBe('function');
      expect(typeof App[mod].clearDateRange).toBe('function');
    });
  });

  test('each declares its date control', () => {
    LISTS.forEach(([file, list, mod]) => {
      expect(HTML(file)).toContain(`class="list-date" data-list="${list}" data-module="${mod}"`);
    });
    // The contractor ledger keeps its own From/To inside its dialog.
    expect(HTML('contractors.html')).toContain('id="ledgerDateFrom"');
    expect(HTML('contractors.html')).toContain('id="ledgerDateTo"');
  });

  test('mounted, every list has a From and a To with the ids its module reads', () => {
    // A half-wired control silently filters on one end only.
    [...new Set(LISTS.map(([file]) => file))].forEach(file => {
      document.body.innerHTML = HTML(file);
      App.ListControls.mountAll();
      LISTS.filter(([f]) => f === file).forEach(([, list]) => {
        expect(document.getElementById(`${list}DateFrom`)).not.toBeNull();
        expect(document.getElementById(`${list}DateTo`)).not.toBeNull();
      });
    });
  });
});

describe('the list toolbars', () => {
  // One row each: search, the date button, the ⇅ menu. With a grey hint
  // line under every control, the "on this date" box, the range and the
  // Sort by dropdown needed more than the 900px they were given, and Sort
  // wrapped onto a second row.
  beforeEach(() => {
    jest.resetModules();
    loadModules(...ALL_MODULES);
  });

  test('no toolbar keeps an "on this date" box or a Sort by dropdown', () => {
    [...new Set(LISTS.map(([file]) => file))].forEach(file => {
      const html = HTML(file);
      expect(html).not.toMatch(/filterByDate\(/);
      expect(html).not.toMatch(/id="\w+DateFilter"/);
      expect(html).not.toMatch(/<select\b[^>]*id="\w+SortBy"/);
    });
  });

  test.each(LISTS)('%s: %s has one date button and one sort menu, for the same module', (file, list, mod) => {
    document.body.innerHTML = HTML(file);
    const dates = document.querySelectorAll(`.list-date[data-list="${list}"]`);
    const sorts = document.querySelectorAll(`.list-sort[data-list="${list}"]`);
    expect(dates).toHaveLength(1);
    expect(sorts).toHaveLength(1);
    expect(dates[0].dataset.module).toBe(mod);
    expect(sorts[0].dataset.module).toBe(mod);
    expect(sorts[0].querySelector('.list-sort-btn').getAttribute('aria-label')).toBeTruthy();
    expect(typeof App[mod].sortBy).toBe('function');
  });

  test.each(LISTS)('%s: %s sorts only by orders its module knows', (file, list, mod, comparators) => {
    document.body.innerHTML = HTML(file);
    const known = Object.keys(comparators());
    const sort = document.querySelector(`.list-sort[data-list="${list}"]`);
    const menuKeys = [...sort.querySelectorAll('[data-sort]')].map(b => b.dataset.sort);
    const headerKeys = [...document.querySelectorAll(`table[data-list="${list}"] th[data-sort-keys]`)]
      .flatMap(th => th.dataset.sortKeys.split(','));

    expect(menuKeys.length).toBeGreaterThan(0);
    expect(headerKeys.length).toBeGreaterThan(0);
    [...menuKeys, ...headerKeys].forEach(key => expect(known).toContain(key));
    // Every header order is in the menu too, so the menu can always tick it.
    headerKeys.forEach(key => expect(menuKeys).toContain(key));
    // The default the ⇅ button measures against is where the list starts.
    expect(known).toContain(sort.dataset.default);
    expect(App.State[sort.dataset.state]).toBe(sort.dataset.default);
  });
});

