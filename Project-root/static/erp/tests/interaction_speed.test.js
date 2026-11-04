/**
 * The interaction-speed fixes of 2026-11-04 (INP measured poor in the lab:
 * desktop ~600 ms, phone ~980 ms). Each test pins what a fix must keep
 * doing -- the same answers -- while doing less work.
 *
 * - Phone Stock list: fifty cards at a time, and one search index per list.
 * - Phone search: the fuzzy fallback works each (token, word) out once per
 *   search; kept compiled patterns give the same matches.
 * - Desktop Items: the orphan check matches as App.Utils.sameText does.
 * - Desktop Production: All Activity is drawn only while its sub-tab shows.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const PARTIAL = f => fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', f), 'utf8');

function loadPhone(html) {
  jest.resetModules();
  global.fetch = jest.fn();
  document.body.innerHTML = html + '<div class="mb-toast-stack" id="mapp-toast-stack"></div>';
  global.OfflineCache = { outbox: { countPendingForMethod: jest.fn(async () => 0) } };
  // eslint-disable-next-line no-eval
  eval(read('api.js').replace(/^const Api = /m, 'global.Api = '));
  // eslint-disable-next-line no-eval
  eval(read('mobile.js').replace(/^const MApp = /m, 'global.MApp = '));
  MApp.Paging._shown = {};
}

function loadDesktop(...files) {
  jest.resetModules();
  // eslint-disable-next-line no-eval
  eval([
    read('api.js'),
    'global.escapeHtml = escapeHtml;',
    'global.toNumber = toNumber;',
    'global.formatCurrency = formatCurrency;',
    'global.formatQty = formatQty;',
    'global.parseRecordDate = parseRecordDate;',
    'global.dateToInputValue = dateToInputValue;',
    'global.inDateRange = inDateRange;',
    'global.todayIso = todayIso;',
    'global.normalizeDateForInput = normalizeDateForInput;',
    'global.PO_STATUS = PO_STATUS;'
  ].join('\n'));
  // eslint-disable-next-line no-eval
  eval([
    read('core.js').replace(/^const App = /m, 'global.App = '),
    'global.$ = $;',
    'global.$$ = $$;'
  ].join('\n'));
  files.forEach(f => {
    // eslint-disable-next-line no-eval
    eval(read(f));
  });
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('the phone Stock list', () => {
  const stock = n => Array.from({ length: n }, (_, i) => ({
    name: `Spoke ${i}`, size: '14G', narration: '', unit: 'Pcs', currentStock: i, isLowStock: i % 10 === 0
  }));
  const cards = () => document.querySelectorAll('#stock-list [data-stock-toggle]').length;

  beforeEach(() => {
    loadPhone('<div class="mb-search"><input id="stock-search"></div><div id="stock-list"></div>');
  });
  // What the Show more button's (shared, delegated) click handler does --
  // its wiring is mobile_paging.test.js's. Clicked here, every earlier
  // test's copy of mobile.js would answer too: each load adds a listener.
  const showMore = () => {
    MApp.Paging._shown.stock += MApp.Paging.DEFAULT_SIZE;
    MApp.Paging._rerender.stock();
  };

  test('shows fifty cards at a time, and the rest on Show more', () => {
    MApp.Stock.all = stock(120);
    MApp.Stock.onSearch('');
    expect(cards()).toBe(50);
    const more = document.querySelector('#stock-list .mb-load-more');
    expect(more.textContent).toContain('70 not shown');

    showMore();
    expect(cards()).toBe(100);
  });

  test('a new search starts from the first fifty again', () => {
    MApp.Stock.all = stock(120);
    MApp.Stock.onSearch('');
    showMore();
    expect(cards()).toBe(100);

    MApp.Stock.onSearch('spoke');
    expect(cards()).toBe(50);
  });

  test('builds its search index once per list and filter, not per keystroke', () => {
    const index = jest.spyOn(MApp.Search, 'index');
    MApp.Stock.all = stock(120);
    ['s', 'sp', 'spo', 'spok'].forEach(term => MApp.Stock.onSearch(term));
    expect(index).toHaveBeenCalledTimes(1);

    MApp.Stock._lowStockOnly = true; // Home's low-stock filter
    MApp.Stock.onSearch('spoke');
    expect(index).toHaveBeenCalledTimes(2);
    expect(MApp.Stock.filtered.every(s => s.isLowStock)).toBe(true);

    MApp.Stock.all = stock(30); // a load or a refresh
    MApp.Stock.onSearch('spoke');
    expect(index).toHaveBeenCalledTimes(3);
    expect(MApp.Stock.filtered).toHaveLength(3);
  });
});

describe('the phone search', () => {
  beforeEach(() => loadPhone(''));

  const rows = [
    { name: 'Spoke 20 inch Kalpi' }, { name: 'Rim 20 inch Kalpi' }, { name: 'Tube 20 inch Kalpi' },
    { name: 'Seat Rider' }
  ];
  const SEARCH = { fields: [{ key: 'name', weight: 1 }] };

  test('a misspelt word still finds its records, working each word out once', () => {
    const distance = jest.spyOn(MApp.Search, '_editDistance');
    const found = MApp.Search.run(MApp.Search.index(rows, SEARCH), 'kalpo').map(r => r.name);

    expect(found).toEqual(['Spoke 20 inch Kalpi', 'Rim 20 inch Kalpi', 'Tube 20 inch Kalpi']);
    // Distinct words across all four records -- not once per record.
    const words = new Set(rows.flatMap(r => r.name.toLowerCase().split(' ')));
    expect(distance.mock.calls.length).toBeLessThanOrEqual(words.size);
  });

  test('short and whole-word matches are unchanged', () => {
    const entries = MApp.Search.index(rows, SEARCH);
    expect(MApp.Search.run(entries, 'rim').map(r => r.name)).toEqual(['Rim 20 inch Kalpi']);
    expect(MApp.Search.run(entries, '20').map(r => r.name)).toHaveLength(3);
    // Searched twice: a kept pattern answers as a new one did.
    expect(MApp.Search.run(entries, 'rim').map(r => r.name)).toEqual(['Rim 20 inch Kalpi']);
    expect(MApp.Search.run(entries, 'ride').map(r => r.name)).toEqual(['Seat Rider']);
  });
});

describe('the desktop Items orphan check', () => {
  test('matches name and size as sameText does: case and outer spaces ignored', () => {
    loadDesktop('items.js');
    App.State.globalItems = [
      { name: ' Rim ', size: '20 inch' },
      { name: 'Spoke', size: '' },
      { name: 'Hub', size: 'Front' },
      { name: 'Hub', size: 'Rear' }
    ];
    App.State.globalStock = [
      { name: 'rim', size: ' 20 INCH ' },
      { name: 'SPOKE' },
      { name: 'hub', size: 'front' }
    ];
    expect(App.Item.getOrphanItems()).toEqual([{ name: 'Hub', size: 'Rear' }]);
  });
});

describe('desktop Production All Activity', () => {
  beforeEach(() => {
    loadDesktop('production.js');
    document.body.innerHTML = PARTIAL('production.html');
    App.State.globalProduction = Array.from({ length: 30 }, (_, i) => ({
      dateRaw: '2026-11-0' + ((i % 9) + 1), date: '0' + ((i % 9) + 1) + '/11/2026',
      lotNumber: `LOT-${i}`, outputItemName: 'Rim', qty: 10, status: 'Pending'
    }));
    App.State.globalIssues = [{ issueId: 'ISS-1', dateRaw: '2026-11-01', date: '01/11/2026', items: [], totalQty: 1 }];
  });
  const rows = () => document.querySelectorAll('#productionAllTableBody tr').length;

  test('is not drawn while its sub-tab is hidden', () => {
    App.Production.renderAllActivity();
    expect(rows()).toBe(0);
  });

  test('is drawn when its sub-tab opens, and emptied when another opens', async () => {
    App.Production.switchSubTab('productionAllSubTab');
    await flush();
    expect(rows()).toBe(31);

    App.Production.switchSubTab('productionLogSubTab');
    expect(rows()).toBe(0);
  });
});
