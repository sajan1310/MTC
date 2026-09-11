/**
 * The "specific dates" window, across the modules.
 *
 * Five ledgers had an exact-date filter -- "show me the 4th" -- which is
 * not the question anyone asks of a ledger; Production and Dispatch had no
 * date filter at all. This adds a from/to window to each, as a SEPARATE
 * control: both apply, so an exact date inside a window still narrows.
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
    App.State.billDateFilter = '';
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

  test('the exact-date filter still applies alongside it', () => {
    // They are separate controls and both narrow -- an exact date outside
    // the window correctly yields nothing.
    setRange('bill', '2026-02-01', '');
    App.State.billDateFilter = '2026-01-01';
    App.Bill.filterByDateRange();

    expect(App.State.filteredBills).toHaveLength(0);
  });

  test('the control is wired in the markup', () => {
    const html = HTML('bill_ledger.html');
    expect(html).toContain('id="billDateFrom"');
    expect(html).toContain('App.Bill.filterByDateRange()');
    expect(html).toContain('App.Bill.clearDateRange()');
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

  test('the control is wired in the markup', () => {
    const html = HTML('production.html');
    expect(html).toContain('id="productionDateFrom"');
    expect(html).toContain('App.Production.filterByDateRange()');
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

  test('the control is wired in the markup', () => {
    const html = HTML('dispatch.html');
    expect(html).toContain('id="dispatchDateFrom"');
    expect(html).toContain('App.Dispatch.filterByDateRange()');
  });
});

describe('every module that got one is wired end to end', () => {
  beforeEach(() => {
    jest.resetModules();
    loadModules('bill.js', 'po.js', 'issue.js', 'return.js', 'dispatch.js', 'production.js');
  });

  test('each exposes both handlers', () => {
    [['Bill'], ['PO'], ['Issue'], ['Return'], ['Wastage'], ['Dispatch'], ['Production']]
      .forEach(([mod]) => {
        expect(typeof App[mod].filterByDateRange).toBe('function');
        expect(typeof App[mod].clearDateRange).toBe('function');
      });
  });

  test('each has its inputs in the markup', () => {
    [
      ['bill_ledger.html', 'billDateFrom'],
      ['po_ledger.html', 'poDateFrom'],
      ['return_ledger.html', 'returnDateFrom'],
      ['return_ledger.html', 'wastageDateFrom'],
      ['production.html', 'issueDateFrom'],
      ['production.html', 'productionDateFrom'],
      ['dispatch.html', 'dispatchDateFrom'],
      ['contractors.html', 'ledgerDateFrom'],
    ].forEach(([file, id]) => {
      expect(HTML(file)).toContain(`id="${id}"`);
    });
  });

  test('every From has a matching To', () => {
    // A half-wired control silently filters on one end only.
    ['bill_ledger.html', 'po_ledger.html', 'return_ledger.html',
      'production.html', 'dispatch.html', 'contractors.html'].forEach(file => {
      const html = HTML(file);
      const froms = [...html.matchAll(/id="(\w+)DateFrom"/g)].map(m => m[1]);
      froms.forEach(prefix => expect(html).toContain(`id="${prefix}DateTo"`));
      expect(froms.length).toBeGreaterThan(0);
    });
  });
});

describe('the filter toolbars stay one row', () => {
  // The date inputs were dropped into flex toolbars as bare
  // .form-control elements. Bootstrap gives that class width:100%, so in
  // a flex row each one claims a full line: the Issued Stock toolbar went
  // from a row to a four-high stack with the action button stranded
  // beside it. Every test passed throughout, because none of them look at
  // layout.
  const FILES = ['production.html', 'dispatch.html', 'return_ledger.html'];

  // The invariant that actually matters: a date input INSIDE an
  // input-group must be fixed-width. Bootstrap's .form-control is
  // width:100%, and a 100%-wide member of a flex group claims the whole
  // line -- which is how the Issued Stock toolbar became a four-high
  // stack. A filter that sits in its own column (Returns, Bills, POs) is
  // meant to fill that column and is left alone.
  const groupedDateInputs = html =>
    [...html.matchAll(/<div\b[^>]*?class="[^"]*input-group[^"]*"[^>]*?>[\s\S]*?<\/div>/g)]
      .flatMap(g => [...g[0].matchAll(/<input\b[^>]*?type="date"[^>]*?>/g)].map(m => m[0]));

  test('every date input inside an input-group is fixed-width', () => {
    let checked = 0;
    FILES.forEach(file => {
      groupedDateInputs(HTML(file)).forEach(tag => {
        expect(tag).toMatch(/width:\s*\d+px/);
        checked += 1;
      });
    });
    // Guards the assertion against a regex that quietly matches nothing.
    expect(checked).toBeGreaterThan(5);
  });

  test('each range is wrapped in an input-group so it reads as one control', () => {
    // Three unlabelled date boxes in a row say nothing about which is
    // which. The group carries the From/To words.
    FILES.forEach(file => {
      const html = HTML(file);
      if (!html.includes('DateFrom')) return;
      expect(html).toContain('input-group');
      expect(html).toMatch(/>From</);
      expect(html).toMatch(/>To</);
    });
  });

  test('the clear button sits inside its group, beside the To input', () => {
    // Loose in the row it wraps onto a line of its own, which is what the
    // stacked toolbar looked like.
    FILES.forEach(file => {
      const html = HTML(file);
      if (!html.includes('clearDateRange')) return;
      const to = html.indexOf('DateTo');
      const clear = html.indexOf('clearDateRange', to);
      expect(clear).toBeGreaterThan(to);
      // No element closes between them: same input-group.
      expect(html.slice(to, clear)).not.toContain('</div>');
    });
  });

  test('every clear button is reachable by name', () => {
    FILES.forEach(file => {
      const html = HTML(file);
      [...html.matchAll(/<button\b[^>]*?clearDateRange[^>]*?>/gs)].forEach(m => {
        expect(m[0]).toMatch(/aria-label=/);
      });
    });
  });
});

