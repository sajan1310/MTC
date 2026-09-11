/**
 * The WIP pipeline chart, and PDF/print in the modules that had none.
 *
 * Desktop draws the pipeline with Chart.js from a CDN. This app ships no
 * charting library on purpose -- it runs on factory LANs with no reliable
 * internet and the service worker only caches same-origin URLs -- so the
 * chart is redrawn as inline SVG rather than ported. Same question, same
 * numbers.
 *
 * And desktop prints nine document types where the phone printed four.
 * Stock, the low-stock report, the Warehouse Pool, issued stock, wastage
 * and the production sheet are all one document -- a title, its source,
 * and a table -- so they share one template rather than six that drift.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const VIEWS_HTML = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', 'mobile_views.html'), 'utf8'
);
const PRINT_HTML = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', 'print.html'), 'utf8'
);

function loadAsGlobal(relPath, exportName) {
  const code = fs
    .readFileSync(path.join(__dirname, '..', relPath), 'utf8')
    .replace(new RegExp(`^const ${exportName} = `, 'm'), `global.${exportName} = `);
  // eslint-disable-next-line no-eval
  eval(code);
}

function mount() {
  jest.resetModules();
  global.fetch = jest.fn();
  document.body.innerHTML = `
    <div id="print-report-container">
      <div id="print-report-title"></div>
      <div id="print-report-subtitle"></div>
      <table><thead id="print-report-head"></thead>
      <tbody id="print-report-body"></tbody></table>
      <div id="print-report-footer"></div>
    </div>
    <div id="mapp-sheet-backdrop"></div>
    <div class="mb-toast-stack" id="mapp-toast-stack"></div>`;
  loadAsGlobal('api.js', 'Api');
  loadAsGlobal('mobile.js', 'MApp');
  MApp.Sheet._stack = [];
}

const PIPELINE = [
  { processId: 'P1', processName: 'Rim Fitting', processType: 'Assembly', sequence: 1, totalQty: 30 },
  { processId: 'P2', processName: 'Painting', processType: 'Finishing', sequence: 2, totalQty: 10 },
];
const UPCOMING = [
  { processId: 'P1', processName: 'Rim Fitting', processType: 'Assembly', sequence: 1, totalQty: 20 },
  { processId: 'P3', processName: 'Packing', processType: '', sequence: 3, totalQty: 5 },
];

describe('the WIP pipeline', () => {
  beforeEach(mount);

  test('folds processes into one band per process type', () => {
    const bands = MApp.Home._stageBands(PIPELINE, UPCOMING);
    const byName = Object.fromEntries(bands.map(b => [b.name, b]));

    expect(byName.Assembly.total).toBe(50); // 30 in progress + 20 pending
    expect(byName.Finishing.total).toBe(10);
  });

  test('a process with no type is kept, under Other', () => {
    // Dropping it would silently lose stock from the chart's totals.
    const bands = MApp.Home._stageBands(PIPELINE, UPCOMING);
    const other = bands.find(b => b.name === 'Other');

    expect(other).toBeDefined();
    expect(other.total).toBe(5);
  });

  test('the busiest band comes first', () => {
    // The question is which part of the shop is loaded, so the answer
    // belongs where the eye starts.
    const bands = MApp.Home._stageBands(PIPELINE, UPCOMING);
    expect(bands[0].name).toBe('Assembly');
  });

  test('processes with nothing open are left out', () => {
    const bands = MApp.Home._stageBands(
      [{ processId: 'P9', processName: 'Idle', processType: 'Assembly', sequence: 1, totalQty: 0 }],
      []
    );
    expect(bands).toEqual([]);
  });

  test('it draws one ring per band, as inline SVG', () => {
    // No charting library: the worker caches only same-origin URLs and the
    // factory LAN has no internet.
    const html = MApp.Home._donuts(MApp.Home._stageBands(PIPELINE, UPCOMING));
    document.body.innerHTML = html;

    expect(document.querySelectorAll('.mapp-donut')).toHaveLength(3);
    expect(html).not.toContain('<canvas');
  });

  test('a band with one process draws a ring, not an invisible arc', () => {
    // Start and end coincide at a full turn, and an arc between identical
    // points draws nothing at all.
    const html = MApp.Home._donuts([
      { name: 'Assembly', total: 10, slices: [{ label: 'Only', value: 10 }] }
    ]);
    document.body.innerHTML = html;

    expect(document.querySelectorAll('.mapp-donut path').length).toBeGreaterThan(0);
  });

  test('nothing open says so rather than drawing an empty ring', () => {
    expect(MApp.Home._donuts([])).toContain('No open production lots');
  });

  test('it is registered as a dashboard chart', () => {
    const block = MApp.HomeLayout.BLOCKS.find(b => b.key === 'wipPipeline');
    expect(block).toBeDefined();
    expect(block.kind).toBe('chart');
    expect(block.chart).toBe('donuts');
  });
});

describe('the report document', () => {
  beforeEach(mount);

  const COLUMNS = [
    { label: 'Item', get: r => r.name },
    { label: 'Qty', align: 'right', get: r => r.qty },
  ];

  test('fills the shared template rather than inventing one per module', () => {
    expect(PRINT_HTML).toContain('id="print-report-container"');
    expect(PRINT_HTML).toContain('id="print-report-body"');
  });

  test('renders a header and a row per record', () => {
    MApp.Print.chooseAction = jest.fn(({ populate }) => { populate(); });

    MApp.Print.report({
      title: 'Stock List', subtitle: '2 items', filename: 'Stock_List',
      columns: COLUMNS, rows: [{ name: 'Bolt', qty: 5 }, { name: 'Nut', qty: 7 }],
    });

    expect(document.getElementById('print-report-title').textContent).toBe('Stock List');
    expect(document.querySelectorAll('#print-report-body tr')).toHaveLength(2);
    expect(document.getElementById('print-report-body').textContent).toContain('Bolt');
  });

  test('an empty report says so instead of printing a bare header', () => {
    MApp.Print.chooseAction = jest.fn(({ populate }) => { populate(); });

    MApp.Print.report({ title: 'Empty', columns: COLUMNS, rows: [] });

    expect(document.getElementById('print-report-body').textContent).toContain('Nothing to report');
  });

  test('it escapes the data it prints', () => {
    MApp.Print.chooseAction = jest.fn(({ populate }) => { populate(); });

    MApp.Print.report({
      title: 'X', columns: COLUMNS,
      rows: [{ name: '<img src=x onerror=alert(1)>', qty: 1 }],
    });

    expect(document.querySelector('#print-report-body img')).toBeNull();
  });

  test('defaults to landscape -- these tables are wider than they are tall', () => {
    let opts = null;
    MApp.Print.chooseAction = jest.fn(o => { opts = o; });

    MApp.Print.report({ title: 'X', columns: COLUMNS, rows: [] });

    expect(opts.landscape).toBe(true);
  });
});

describe('which modules can print', () => {
  beforeEach(mount);

  test('stock prints what is on screen, filter and all', () => {
    // A report that silently ignored the low-stock filter would be a
    // different document from the one being looked at.
    let opts = null;
    MApp.Print.report = jest.fn(o => { opts = o; });
    MApp.Stock.filtered = [{ name: 'Bolt', size: '6mm', unit: 'Pcs', currentStock: 2, threshold: 10 }];
    MApp.Stock._lowStockOnly = true;
    MApp.Stock.searchTerm = '';

    MApp.Stock.printReport();

    expect(opts.title).toBe('Low Stock Report');
    expect(opts.rows).toHaveLength(1);
  });

  test('the stock tab\'s one button follows the pane in front of you', () => {
    MApp.Pool.printReport = jest.fn();
    MApp.Stock.printReport = jest.fn();

    MApp.Stock.view = 'pool';
    MApp.Stock.printCurrentView();
    expect(MApp.Pool.printReport).toHaveBeenCalled();

    MApp.Stock.view = 'stock';
    MApp.Stock.printCurrentView();
    expect(MApp.Stock.printReport).toHaveBeenCalled();
  });

  test('the pool report keeps sub-group buckets, and totals only units', () => {
    // They are still stock movement somebody may need to see; they are
    // simply not units, and a report that dropped them would not
    // reconcile against the screen that lists them.
    let opts = null;
    MApp.Print.report = jest.fn(o => { opts = o; });
    MApp.Pool.filtered = [
      { outputItemName: 'Rim', color: 'Black', producedQty: 10, consumedQty: 0, availableQty: 10, countsTowardTotal: true },
      { outputItemName: 'Rim', color: 'Kit Bag', producedQty: 4, consumedQty: 0, availableQty: 4, countsTowardTotal: false },
    ];
    MApp.Pool.searchTerm = '';

    MApp.Pool.printReport();

    expect(opts.rows).toHaveLength(2);
    expect(opts.footer).toContain('10');
  });

  test('issued stock prints one row per line, not per record', () => {
    // A record can carry several items, and a count cannot be reconciled
    // against the shelf.
    let opts = null;
    MApp.Print.report = jest.fn(o => { opts = o; });
    MApp.Issue.filtered = [{
      dateRaw: '2026-09-01', issuedTo: 'ravi', remarks: '',
      items: [{ name: 'Bolt', size: '6mm', qty: 2 }, { name: 'Nut', size: '6mm', qty: 3 }],
    }];
    MApp.Issue.searchTerm = '';

    MApp.Issue.printReport();

    expect(opts.rows).toHaveLength(2);
  });

  test('wastage prints too', () => {
    let opts = null;
    MApp.Print.report = jest.fn(o => { opts = o; });
    MApp.Wastage.filtered = [{ dateRaw: '2026-09-01', vendor: 'acme', remarks: '', items: [{ name: 'Bolt', qty: 1 }] }];
    MApp.Wastage.searchTerm = '';

    MApp.Wastage.printReport();

    expect(opts.title).toBe('Wastage Log');
    expect(opts.rows).toHaveLength(1);
  });

  test('the production sheet prints portrait, grouped by colour', () => {
    let opts = null;
    MApp.Print.report = jest.fn(o => { opts = o; });
    MApp.ProductionSheet.lot = { lotNumber: 'LOT-1', processName: 'Painting', dateRaw: '2026-09-01' };
    MApp.ProductionSheet.rows = [
      { itemName: 'Paint', size: '', narration: '', color: 'Red', requiredQty: 2 },
      { itemName: 'Primer', size: '', narration: '', color: '', requiredQty: 1 },
    ];

    MApp.ProductionSheet.printSheet();

    expect(opts.landscape).toBe(false);
    expect(opts.title).toContain('LOT-1');
    expect(opts.rows[0].colorLabel).toBe('Common'); // sorts before Red
  });

  test('every new print control is wired in the markup', () => {
    ['MApp.Issue.printReport()', 'MApp.Wastage.printReport()',
      'MApp.ProductionSheet.printSheet()', 'MApp.Stock.printCurrentView()']
      .forEach(call => expect(VIEWS_HTML).toContain(call));
  });
});

describe('the dashboard quick actions', () => {
  beforeEach(mount);

  test('all five are wired to a real opener', () => {
    ['po', 'bill', 'production', 'stock', 'issue'].forEach(key => {
      expect(typeof MApp.Dashboard.ACTIONS[key]).toBe('function');
      const call = MApp.Dashboard.ACTIONS[key].toString().match(/MApp\.(\w+)\.(\w+)/);
      expect(call).not.toBeNull();
      expect(typeof MApp[call[1]][call[2]]).toBe('function');
    });
  });

  test('the markup offers exactly those five', () => {
    ['po', 'bill', 'production', 'stock', 'issue'].forEach(key => {
      expect(VIEWS_HTML).toContain(`MApp.Dashboard.act('${key}')`);
    });
  });

  test('acting closes the dashboard first', () => {
    MApp.Dashboard.close = jest.fn();
    MApp.Dashboard.ACTIONS.po = jest.fn();

    MApp.Dashboard.act('po');

    expect(MApp.Dashboard.close).toHaveBeenCalled();
    expect(MApp.Dashboard.ACTIONS.po).toHaveBeenCalled();
  });
});
