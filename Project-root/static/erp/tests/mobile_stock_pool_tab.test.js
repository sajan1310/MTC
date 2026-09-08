/**
 * Stock and Warehouse Pool on one tab.
 *
 * They answer the same floor question -- how much of this do we have --
 * out of two different records: what the item master holds, and what is
 * in progress between process stages. The pool used to be a sheet off
 * the More tab, two taps and a different mental model away from the
 * number beside it.
 *
 * A segmented switch rather than a filter chip, because swapping which
 * record you are reading is not the same act as narrowing one list, and
 * the two must not look alike.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const VIEWS_HTML = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', 'mobile_views.html'), 'utf8'
);
const CSS = fs.readFileSync(path.join(__dirname, '..', 'mobile_styles.css'), 'utf8');

function loadAsGlobal(relPath, exportName) {
  const code = fs
    .readFileSync(path.join(__dirname, '..', relPath), 'utf8')
    .replace(new RegExp(`^const ${exportName} = `, 'm'), `global.${exportName} = `);
  // eslint-disable-next-line no-eval
  eval(code);
}

/** The tpl-stock template, lifted out of the partial and mounted live. */
function stockTemplate() {
  const at = VIEWS_HTML.indexOf('<template id="tpl-stock">');
  if (at === -1) throw new Error('tpl-stock not found');
  const end = VIEWS_HTML.indexOf('</template>', at);
  return VIEWS_HTML.slice(VIEWS_HTML.indexOf('>', at) + 1, end);
}

const STOCK = [{ name: 'Rim 26', size: '26 inch', currentStock: 40, isLowStock: false, deadStock: false, unit: 'Pcs' }];
const POOL = [{
  rowIdx: 1, outputItemName: 'Frame 26', processId: 'P1', productTag: '',
  color: 'Black', producedQty: 100, consumedQty: 40, availableQty: 60,
}];

function mount() {
  jest.resetModules();
  global.fetch = jest.fn();
  document.body.innerHTML = `
    <div id="mapp-sheet-backdrop"></div>
    <div class="mapp-topbar"><h1 id="mapp-topbar-title">Home</h1></div>
    <main id="mapp-content">${stockTemplate()}</main>
    <div class="mb-toast-stack" id="mapp-toast-stack"></div>`;
  // Stock's own load() asks the outbox how many adjustments are still
  // queued. Not what this file is about, so it gets the smallest stub
  // that answers the one question.
  global.OfflineCache = { outbox: { countPendingForMethod: jest.fn(async () => 0) } };
  loadAsGlobal('api.js', 'Api');
  loadAsGlobal('mobile.js', 'MApp');
  MApp.Sheet._stack = [];
  MApp.Paging._shown = {};
  MApp.State.stockView = '';
  MApp.State.stockFilter = '';
  MApp.Shell.current = 'stock';
  Element.prototype.scrollIntoView = jest.fn();

  MApp.Api.callCached = jest.fn(async () => ({ success: true, data: STOCK }));
  MApp.Api.call = jest.fn(async m => {
    if (m === 'getWarehousePoolData') return { success: true, data: POOL };
    return { success: true, data: [] };
  });
}

const pane = v => document.getElementById('stock-pane-' + v);
const tab = v => document.getElementById('stock-view-tab-' + v);
const title = () => document.getElementById('stock-screen-title').textContent;
const topbar = () => document.getElementById('mapp-topbar-title').textContent;

const flush = () => new Promise(r => setTimeout(r, 0));

describe('the switch', () => {
  beforeEach(mount);

  test('both panes and both tabs exist in the template', () => {
    expect(pane('stock')).not.toBeNull();
    expect(pane('pool')).not.toBeNull();
    expect(tab('stock')).not.toBeNull();
    expect(tab('pool')).not.toBeNull();
  });

  test('it is a segmented switch, not a filter chip row', () => {
    // A filter narrows one list; this swaps which record you are reading.
    // Looking alike would invite reading a pool number as stock.
    const el = document.querySelector('#mapp-content .mb-segmented');
    expect(el).not.toBeNull();
    expect(document.querySelector('#mapp-content .mb-segmented .mb-filter-chip')).toBeNull();
    expect(CSS).toContain('.mb-segmented {');
  });

  test('opens on Stock, with the pool pane hidden', async () => {
    MApp.Stock.mount();
    await flush();

    expect(pane('stock').hidden).toBe(false);
    expect(pane('pool').hidden).toBe(true);
    expect(tab('stock').getAttribute('aria-selected')).toBe('true');
    expect(tab('pool').getAttribute('aria-selected')).toBe('false');
  });

  test('switching shows the pool and hides stock', async () => {
    MApp.Stock.mount();
    await flush();

    MApp.Stock.showView('pool');
    await flush();

    expect(pane('pool').hidden).toBe(false);
    expect(pane('stock').hidden).toBe(true);
    expect(tab('pool').getAttribute('aria-selected')).toBe('true');
  });

  test('both headings follow the view, so neither answer is mislabelled', async () => {
    MApp.Stock.mount();
    await flush();
    expect(title()).toBe('Stock');
    expect(topbar()).toBe('Stock');

    MApp.Stock.showView('pool');
    await flush();
    expect(title()).toBe('Warehouse Pool');
    expect(topbar()).toBe('Warehouse Pool');
  });
});

describe('what each side loads', () => {
  beforeEach(mount);

  test('stock loads on mount; the pool does not until it is shown', async () => {
    MApp.Stock.mount();
    await flush();

    expect(MApp.Api.callCached).toHaveBeenCalledWith('getStockData');
    expect(MApp.Api.call).not.toHaveBeenCalledWith('getWarehousePoolData');
  });

  test('the pool loads the first time it is shown', async () => {
    MApp.Stock.mount();
    await flush();

    MApp.Stock.showView('pool');
    await flush();

    expect(MApp.Api.call).toHaveBeenCalledWith('getWarehousePoolData');
    expect(document.getElementById('pool-list').textContent).toContain('Frame 26');
  });

  test('flipping back and forth costs no further round trips', async () => {
    // Toggling is a normal fidget; it should not refetch either side.
    MApp.Stock.mount();
    await flush();
    MApp.Stock.showView('pool');
    await flush();

    const poolCalls = MApp.Api.call.mock.calls.filter(c => c[0] === 'getWarehousePoolData').length;
    const stockCalls = MApp.Api.callCached.mock.calls.length;

    MApp.Stock.showView('stock');
    MApp.Stock.showView('pool');
    MApp.Stock.showView('stock');
    await flush();

    expect(MApp.Api.call.mock.calls.filter(c => c[0] === 'getWarehousePoolData').length).toBe(poolCalls);
    expect(MApp.Api.callCached.mock.calls.length).toBe(stockCalls);
  });

  test('re-entering the tab reloads, because the panes were rebuilt', async () => {
    // MApp.Shell re-clones the tab template on every entry, so a pane
    // loaded during the last visit is an empty div now.
    MApp.Stock.mount();
    await flush();
    const before = MApp.Api.callCached.mock.calls.length;

    MApp.Stock.mount();
    await flush();

    expect(MApp.Api.callCached.mock.calls.length).toBe(before + 1);
  });
});

describe('getting to the pool from elsewhere', () => {
  beforeEach(mount);

  test('MApp.Pool.open lands on the pool pane, not a sheet', async () => {
    // It is no longer a sheet, but every entry point -- the More tab's
    // card, global search -- still asks for it by this name.
    MApp.Stock.mount();
    await flush();

    MApp.Pool.open();
    await flush();

    expect(MApp.Stock.view).toBe('pool');
    expect(pane('pool').hidden).toBe(false);
    expect(MApp.Sheet._stack.length).toBe(0);
  });

  test('from another tab it routes through the shell', async () => {
    MApp.Shell.current = 'more';
    MApp.Shell.showTab = jest.fn();

    MApp.Pool.open();

    expect(MApp.State.stockView).toBe('pool');
    expect(MApp.Shell.showTab).toHaveBeenCalledWith('stock');
  });

  test('the handoff is consumed, so the next visit opens on Stock', async () => {
    MApp.State.stockView = 'pool';
    MApp.Stock.mount();
    await flush();
    expect(MApp.Stock.view).toBe('pool');

    MApp.Stock.mount();
    await flush();

    expect(MApp.Stock.view).toBe('stock');
  });

  test('Home\'s low-stock tile still lands on Stock, not the pool', async () => {
    MApp.State.stockFilter = 'lowstock';
    MApp.Stock.mount();
    await flush();

    expect(MApp.Stock.view).toBe('stock');
    expect(pane('stock').hidden).toBe(false);
  });
});

describe('the pool sheet is gone but its own sheets are not', () => {
  test('no sheet-pool wrapper survives in the markup', () => {
    expect(VIEWS_HTML).not.toContain('id="sheet-pool"');
  });

  test('the ledger, correction, history and openings sheets remain', () => {
    ['sheet-pool-ledger', 'sheet-pool-adjust', 'sheet-pool-history',
      'sheet-pool-openings', 'sheet-pool-opening-form'].forEach(id => {
      expect(VIEWS_HTML).toContain(`id="${id}"`);
    });
  });

  test('a pool reload is a no-op when the pane is not on screen', async () => {
    // An opening balance or a colour exclusion recalculates the pool from
    // screens where the pane does not exist, and both ask for a refresh
    // unconditionally.
    mount();
    document.getElementById('mapp-content').innerHTML = '';

    await expect(MApp.Pool.load()).resolves.toBeUndefined();
    expect(MApp.Api.call).not.toHaveBeenCalledWith('getWarehousePoolData');
  });
});
