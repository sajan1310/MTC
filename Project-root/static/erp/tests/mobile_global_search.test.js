/**
 * Global search -- one box over every dataset and every destination.
 *
 * Reaching the Wastage log used to be More -> scroll -> tap -> search, and
 * any cross-module lookup ("which PO covered this item?") needed the
 * operator to already know which module owned the answer. Indexing the
 * DESTINATIONS alongside the records is also what finally gives the More
 * tab's fourteen entries the filter they never had.
 *
 * Records deep-link by navigating to the owning module with its own search
 * prefilled, rather than opening one specific record's sheet -- a narrower
 * promise than a per-record router, and one that reuses machinery already
 * proven on every screen.
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

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

const STOCK = [
  { name: 'Rim 26 inch', size: '26 inch', currentStock: 140 },
  { name: 'Spoke', size: '', currentStock: 4000 },
];
const LOTS = [
  { lotNumber: 'LOT-1042', assignedTo: 'Rakesh', status: 'Pending' },
];
const DISPATCHES = [
  { dispatchNumber: 'DC-88', clientName: 'Acme Cycles', productName: 'Kalpi 26' },
];

describe('MApp.GlobalSearch', () => {
  beforeEach(() => {
    jest.resetModules();
    global.fetch = jest.fn();
    document.body.innerHTML = `
      <div id="mapp-sheet-backdrop"></div>
      <div id="mapp-content"></div>
      <div class="mb-sheet" id="sheet-global-search">
        <div class="mb-search">
          <input type="search" id="global-search-input">
        </div>
        <div id="global-search-results"></div>
      </div>`;
    loadAsGlobal('api.js', 'Api');
    loadAsGlobal('mobile.js', 'MApp');

    MApp.Sheet._stack = [];
    MApp.GlobalSearch._indexes = {};
    MApp.GlobalSearch._lastGroups = {};
    MApp.GlobalSearch._loaded = false;

    MApp.Api.callCached = jest.fn(async method => ({
      success: true,
      data: { getStockData: STOCK, getProductionData: LOTS, getDispatchData: DISPATCHES }[method] || [],
    }));
  });

  const results = () => document.getElementById('global-search-results');
  const titles = () => [...results().querySelectorAll('.mb-card-title')].map(e => e.textContent);

  test('opens as a sheet, so Back and Escape close it like every other overlay', () => {
    MApp.GlobalSearch.open();
    expect(MApp.Sheet._stack.map(e => e.id)).toContain('sheet-global-search');
  });

  test('destinations are searchable with no network at all', () => {
    // The index for screens is built synchronously; only datasets are
    // fetched. A search box that needs a round trip before it can find
    // "Wastage" is not one anybody will trust on a bad LAN.
    MApp.GlobalSearch.open();
    MApp.GlobalSearch.onSearch('wastage');

    expect(titles()).toContain('Wastage');
  });

  test('a screen is findable by what an operator would call it, not only its label', () => {
    MApp.GlobalSearch.open();

    MApp.GlobalSearch.onSearch('scrap');
    expect(titles()).toContain('Wastage');

    MApp.GlobalSearch.onSearch('bom');
    expect(titles()).toContain('Product Recipes');

    MApp.GlobalSearch.onSearch('outbox');
    expect(titles()).toContain('Sync Issues');
  });

  test('records from every loaded dataset appear, grouped', async () => {
    MApp.GlobalSearch.open();
    await flush();
    await flush();

    MApp.GlobalSearch.onSearch('26');

    const html = results().innerHTML;
    expect(html).toContain('Stock');
    expect(titles()).toContain('Rim 26 inch');
  });

  test('groups are labelled so a result says which module owns it', async () => {
    MApp.GlobalSearch.open();
    await flush();
    await flush();

    MApp.GlobalSearch.onSearch('rakesh');

    const labels = [...results().querySelectorAll('.mapp-section-label')].map(e => e.textContent);
    expect(labels).toContain('Production');
    expect(titles()).toContain('LOT-1042');
  });

  test('the same query can match a screen AND records at once', async () => {
    MApp.GlobalSearch.open();
    await flush();
    await flush();

    MApp.GlobalSearch.onSearch('dispatch');

    const labels = [...results().querySelectorAll('.mapp-section-label')].map(e => e.textContent);
    expect(labels).toContain('Screens');
    expect(titles()).toContain('Dispatch'); // the destination
  });

  test('an empty query offers somewhere to go rather than a blank screen', () => {
    MApp.GlobalSearch.open();

    expect(results().innerHTML).toContain('Go to');
    expect(titles().length).toBeGreaterThan(0);
  });

  test('a query matching nothing says so, with the term', async () => {
    MApp.GlobalSearch.open();
    await flush();
    await flush();

    MApp.GlobalSearch.onSearch('zzzzzzzz');

    expect(results().textContent).toContain('Nothing found');
    expect(results().textContent).toContain('zzzzzzzz');
  });

  test('a dataset that cannot be fetched is simply absent, not fatal', async () => {
    MApp.Api.callCached = jest.fn(async method => {
      if (method === 'getStockData') throw new Error('offline');
      return { success: true, data: [] };
    });

    MApp.GlobalSearch.open();
    await flush();
    await flush();

    // Screens still work, which is the point of the fallback.
    MApp.GlobalSearch.onSearch('wastage');
    expect(titles()).toContain('Wastage');
  });

  test('tapping a screen result runs that destination and closes the sheet', () => {
    const spy = jest.spyOn(MApp.Wastage, 'open').mockImplementation(() => {});
    MApp.GlobalSearch.open();
    MApp.GlobalSearch.onSearch('wastage');

    results().querySelector('[data-group="destinations"]').click();

    expect(spy).toHaveBeenCalled();
    expect(MApp.Sheet._stack.map(e => e.id)).not.toContain('sheet-global-search');
    spy.mockRestore();
  });

  test('tapping a record navigates to its tab and prefills that tab\'s search', async () => {
    jest.useFakeTimers();
    const showTab = jest.spyOn(MApp.Shell, 'showTab').mockImplementation(() => {});
    MApp.GlobalSearch.open();

    // Index directly rather than waiting on the async load under fake timers.
    MApp.GlobalSearch._indexes.production =
      MApp.Search.index(LOTS, MApp.GlobalSearch.SOURCES[1].spec);
    MApp.GlobalSearch.onSearch('LOT-1042');

    results().querySelector('[data-group="production"]').click();
    expect(showTab).toHaveBeenCalledWith('production');

    // The tab's own search input only exists after its template is cloned
    // in, so the prefill retries rather than assuming it is already there.
    const input = document.createElement('input');
    input.id = 'production-search';
    document.body.appendChild(input);
    const onInput = jest.fn();
    input.addEventListener('input', onInput);

    jest.advanceTimersByTime(500);

    expect(input.value).toBe('LOT-1042');
    expect(onInput).toHaveBeenCalled();

    showTab.mockRestore();
    jest.useRealTimers();
  });

  test('a record whose name contains quotes cannot break the result markup', async () => {
    MApp.GlobalSearch.open();
    MApp.GlobalSearch._indexes.stock = MApp.Search.index(
      [{ name: 'Rim 26" <script>', size: `O'Brien`, currentStock: 1 }],
      MApp.GlobalSearch.SOURCES[0].spec
    );

    MApp.GlobalSearch.onSearch('rim');

    // Escaped in the markup, intact as text, and still clickable -- which
    // is why results resolve by index rather than by interpolating values
    // into an inline onclick.
    expect(results().innerHTML).not.toContain('<script>');
    expect(titles()[0]).toBe('Rim 26" <script>');
    expect(results().querySelector('[data-group="stock"]')).not.toBeNull();
  });

  test('each group is capped, and says how many it held back', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `Rim ${i}`, size: '', currentStock: 1 }));
    MApp.GlobalSearch.open();
    MApp.GlobalSearch._indexes.stock = MApp.Search.index(many, MApp.GlobalSearch.SOURCES[0].spec);

    MApp.GlobalSearch.onSearch('rim');

    expect(results().querySelectorAll('[data-group="stock"]')).toHaveLength(MApp.GlobalSearch.PER_GROUP);
    expect(results().textContent).toContain('+7 more');
  });
});

describe('global search is reachable from the app bar', () => {
  const SHELL = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'mobile.html'), 'utf8'
  );
  const VIEWS = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', 'mobile_views.html'), 'utf8'
  );

  test('the top bar carries a labelled search button on every tab', () => {
    // The bar is outside the per-tab templates, so one button covers all
    // five tabs -- but it has to have an accessible name.
    expect(SHELL).toContain('MApp.GlobalSearch.open()');
    expect(SHELL).toMatch(/id="mapp-search-btn"[\s\S]*?aria-label="Search everything"/);
  });

  test('the sheet exists and its input is a real search box', () => {
    expect(VIEWS).toContain('id="sheet-global-search"');
    const tag = VIEWS.match(/<input[^>]*id="global-search-input"[^>]*>/);
    expect(tag).not.toBeNull();
    expect(tag[0]).toContain('type="search"');
    expect(tag[0]).not.toContain('oninput');
  });
});
