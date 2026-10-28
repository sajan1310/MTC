/**
 * A change made from a list no longer starts the operator over.
 *
 * Every list on the phone and the tablet reloaded after a change the way it
 * loads when first opened: cards swapped for skeletons (the page collapses,
 * so the scroll lands at the top), the search emptied -- on the tabs only in
 * memory, so the box kept the words over an unfiltered list -- a filter
 * brought from Home dropped, "Show more" folded back, and a sheet opened a
 * second time over itself. A status changed on one lot meant scrolling back
 * down to the next. On top of that the outbox flush, which runs at every
 * start and on every reconnect, redrew the screen even with nothing to sync,
 * and so did the service worker's background sync.
 *
 * Refreshes after a change are now in place (MApp.Util.keepScroll): the list
 * stays up while the data comes and is redrawn under the same search, filter
 * and pages. A screen opened afresh still starts over.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const VIEWS = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', 'mobile_views.html'), 'utf8');

// One sheet's markup as mobile.html ships it (CRLF in a Windows checkout).
const sheet = id => {
  const m = VIEWS.match(new RegExp(`<div class="mb-sheet[^"]*" id="${id}"[\\s\\S]*?\\r?\\n</div>\\r?\\n`));
  if (!m) throw new Error(`no sheet #${id} in mobile_views.html`);
  return m[0];
};

function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function loadApp(html) {
  jest.resetModules();
  global.fetch = jest.fn();
  document.body.innerHTML = '<div id="mapp-sheet-backdrop"></div>' + html +
    '<div class="mb-select-bar" id="mapp-select-bar"><span id="mapp-select-count"></span></div>' +
    '<div class="mb-toast-stack" id="mapp-toast-stack"></div>';
  global.OfflineCache = { outbox: { countPendingForMethod: jest.fn(async () => 0) } };
  // eslint-disable-next-line no-eval
  eval(read('api.js').replace(/^const Api = /m, 'global.Api = '));
  // eslint-disable-next-line no-eval
  eval(read('mobile.js').replace(/^const MApp = /m, 'global.MApp = '));
  MApp.Sheet._stack = [];
  MApp.Paging._shown = {};
  MApp.Select._state = null;
}

const toasts = () => [...document.querySelectorAll('#mapp-toast-stack .mb-toast')].map(t => t.textContent);

// ── Production, the tab a storekeeper works down lot by lot ─────────────
const PROCESSES = [{ processId: 'P1', processName: 'Painting', active: true, outputItemName: 'Frame' }];
const lot = (i, status) => ({
  rowIdx: i + 2,
  lotNumber: `LOT-${i % 2 ? 'WLD' : 'PNT'}-${String(i).padStart(3, '0')}`,
  processId: 'P1', qty: 10, assignedTo: 'ravi', status: status || 'Pending',
  dateRaw: '2026-10-28', productId: '', productName: '', colorBreakdown: [], outputItemName: ''
});
// 130 lots, every other one PNT: a search for PNT leaves 65, more than a page.
const LOTS = Array.from({ length: 130 }, (_, i) => lot(i));

describe('the Production list after a change', () => {
  let lotsQueue;
  const listEl = () => document.getElementById('production-list');
  const cards = () => listEl().querySelectorAll('.mb-card');
  const box = () => document.getElementById('production-search');

  beforeEach(() => {
    loadApp(`
      <div id="mapp-content">
        <div class="mb-search"><input type="search" id="production-search"></div>
        <div class="mb-list" id="production-list"></div>
      </div>`);
    lotsQueue = [];
    MApp.Api.callCached = jest.fn(() => {
      const d = deferred();
      lotsQueue.push(d);
      return d.promise;
    });
    MApp.Api.call = jest.fn(async method => (method === 'getProcessData'
      ? { success: true, data: PROCESSES }
      : { success: true, data: [] }));
  });

  // Opened from Home's "pending lots", searched for PNT, one page more shown.
  async function workingThrough() {
    MApp.State.productionFilter = 'pending';
    const first = MApp.Production.load();
    lotsQueue[0].resolve({ success: true, data: LOTS });
    await first;
    box().value = 'PNT';
    MApp.Production.onSearch('PNT');
    MApp.Paging._shown.production += MApp.Paging.DEFAULT_SIZE;
    MApp.Production.render();
    expect(cards()).toHaveLength(65);
  }

  test('a status change keeps the search, the filter from Home and the pages shown', async () => {
    await workingThrough();
    Api.mutateWithId = jest.fn(async () => ({ success: true, message: 'Status updated.' }));

    await MApp.Production.changeStatus(LOTS[0], 'Completed');

    // The refresh is under way: the list is still the list, not skeletons.
    expect(listEl().querySelector('.mb-skel')).toBeNull();
    expect(cards()).toHaveLength(65);

    const after = LOTS.map((l, i) => (i === 0 ? { ...l, status: 'Completed' } : l));
    lotsQueue[1].resolve({ success: true, data: after });
    await settle();

    // Same search -- in the box AND in the list -- same Home filter (the
    // completed lot leaves it), every PNT lot still on screen.
    expect(box().value).toBe('PNT');
    expect(MApp.Production.searchTerm).toBe('PNT');
    expect(listEl().textContent).toContain('Showing pending & in-progress lots only');
    expect(cards()).toHaveLength(64);
    expect(listEl().textContent).not.toContain('LOT-PNT-000');
    expect(listEl().textContent).not.toContain('LOT-WLD');
  });

  test('a refresh overtaken by a newer one does not draw over it', async () => {
    await workingThrough();
    const older = MApp.Production.load({ keep: true });
    const newer = MApp.Production.load({ keep: true });

    lotsQueue[2].resolve({ success: true, data: LOTS.slice(0, 10) });
    await newer;
    lotsQueue[1].resolve({ success: true, data: LOTS });
    await older;

    expect(cards()).toHaveLength(5); // the newer data: five PNT lots in ten
  });

  test('a failed refresh leaves the list where it is, and says so', async () => {
    await workingThrough();
    const refresh = MApp.Production.load({ keep: true });
    lotsQueue[1].resolve({ success: false, message: 'Server busy' });
    await refresh;

    expect(cards()).toHaveLength(65);
    expect(listEl().querySelector('.mb-state-error')).toBeNull();
    expect(toasts()).toContain("Couldn't refresh the list. It may be out of date.");
  });

  test('a screen opened afresh still starts over, and a failed first load shows its Retry', async () => {
    await workingThrough();
    box().value = ''; // a fresh tab clones a fresh, empty box

    const fresh = MApp.Production.load();
    expect(listEl().querySelector('.mb-skel')).not.toBeNull();
    lotsQueue[1].resolve({ success: false, message: 'Server busy' });
    await fresh;

    expect(listEl().querySelector('.mb-state-error')).not.toBeNull();
    expect(MApp.Production.searchTerm).toBe('');
    expect(MApp.Production._pendingOnly).toBe(false);
  });
});

// ── Stock: a correction ─────────────────────────────────────────────────
describe('a stock correction', () => {
  test('refreshes in place and forgets the movements cached for that item only', async () => {
    loadApp(`
      <div id="mapp-content"><div class="mb-list" id="stock-list"></div></div>
      ${sheet('sheet-stock-adjust')}`);
    const item = { name: 'Hub Axle', size: '6"', currentStock: 10 };
    MApp.Stock._adjustItem = item;
    MApp.Stock._ledgerCache = { 'hub axle': [{ kind: 'BILL' }], 'spoke': [{ kind: 'BILL' }] };
    document.getElementById('stock-adjust-new-value').value = '12';
    document.getElementById('stock-adjust-reason').value = 'Recount';
    Api.mutateWithId = jest.fn(async () => ({ success: true, message: 'Stock adjusted.' }));
    MApp.Stock.load = jest.fn();

    await MApp.Stock.submitAdjust();

    expect(MApp.Stock.load).toHaveBeenCalledWith({ keep: true });
    expect(MApp.Stock._ledgerCache['hub axle']).toBeUndefined();
    expect(MApp.Stock._ledgerCache.spoke).toBeDefined();
  });
});

// ── A list sheet: the Items lookup ──────────────────────────────────────
const ITEMS = Array.from({ length: 60 }, (_, i) => ({
  name: i % 2 ? `Spoke ${i}` : `Hub Axle ${i}`, size: '', narration: '', baseUnit: 'Pcs',
  image: '', vendors: [], unpricedVendors: []
}));

describe('the Items lookup after a save', () => {
  beforeEach(() => {
    loadApp(sheet('sheet-items-lookup') + sheet('sheet-item-form'));
    MApp.Api.call = jest.fn(async method => (method === 'getItemsData'
      ? { success: true, data: JSON.parse(JSON.stringify(ITEMS)) }
      : { success: true, data: [] }));
  });

  const box = () => document.getElementById('items-lookup-search');
  const titles = () => [...document.querySelectorAll('#items-lookup-list .mb-card-title')].map(t => t.textContent);

  test('keeps the search being worked through, and the sheet is not opened a second time', async () => {
    await MApp.Items.openLookupSheet();
    box().value = 'axle';
    MApp.Items.onSearch('axle');
    expect(titles()).toHaveLength(30);

    MApp.Items.openForm(MApp.Items.filtered[3]);
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: true }));
    const pushState = jest.spyOn(history, 'pushState');

    await MApp.Items.saveItem();
    await settle();

    expect(pushState).not.toHaveBeenCalled();
    pushState.mockRestore();
    expect(MApp.Sheet._stack.map(s => s.id)).toEqual(['sheet-items-lookup']);
    expect(box().value).toBe('axle');
    expect(titles()).toHaveLength(30);
    expect(titles().every(t => t.startsWith('Hub Axle'))).toBe(true);
  });

  test('opened afresh, it still starts with an empty search', async () => {
    await MApp.Items.openLookupSheet();
    box().value = 'axle';
    MApp.Items.onSearch('axle');
    MApp.Items.closeLookupSheet();

    await MApp.Items.openLookupSheet();

    expect(box().value).toBe('');
    expect(titles()).toHaveLength(50); // the first page of all 60
  });
});

describe('MApp.Sheet.open', () => {
  test('on a sheet already open adds no second stack or history entry', () => {
    loadApp(sheet('sheet-items-lookup'));
    const pushState = jest.spyOn(history, 'pushState');

    MApp.Sheet.open('sheet-items-lookup');
    MApp.Sheet.open('sheet-items-lookup');

    expect(MApp.Sheet._stack).toHaveLength(1);
    expect(pushState).toHaveBeenCalledTimes(1);
    pushState.mockRestore();
  });
});

// ── What refreshes the screen on its own ────────────────────────────────
describe('the outbox flush', () => {
  beforeEach(() => {
    loadApp('');
    MApp.SyncIssues.updateSummary = jest.fn();
    MApp.Shell.refreshCurrentTab = jest.fn();
  });

  const outbox = pending => {
    global.OfflineCache = {
      outbox: {
        listPending: jest.fn(async () => pending),
        markDone: jest.fn(async () => {}),
        markFailed: jest.fn(async () => {}),
        countPendingAndFailed: jest.fn(async () => 0)
      }
    };
  };

  test('with nothing queued -- every start, every reconnect -- leaves the screen alone', async () => {
    outbox([]);
    await MApp.Outbox.flush();
    expect(MApp.Shell.refreshCurrentTab).not.toHaveBeenCalled();
  });

  test('still offline, nothing sent, leaves it alone too', async () => {
    outbox([{ id: 1, method: 'saveProduction', mutationId: 'm1', args: [] }]);
    Api.mutateWithId = jest.fn(async () => { throw Object.assign(new Error('offline'), { isNetworkError: true }); });
    await MApp.Outbox.flush();
    expect(MApp.Shell.refreshCurrentTab).not.toHaveBeenCalled();
  });

  test('refreshes once something queued was sent', async () => {
    outbox([{ id: 1, method: 'saveProduction', mutationId: 'm1', args: [] }]);
    Api.mutateWithId = jest.fn(async () => ({ success: true }));
    await MApp.Outbox.flush();
    expect(MApp.Shell.refreshCurrentTab).toHaveBeenCalledTimes(1);
  });
});

describe('a refresh of the tab on screen', () => {
  beforeEach(() => loadApp(''));

  test('is in place', () => {
    MApp.Shell.current = 'production';
    MApp.Production.load = jest.fn();
    MApp.Shell.refreshCurrentTab();
    expect(MApp.Production.load).toHaveBeenCalledWith({ keep: true });
  });

  test('on the Warehouse Pool refreshes the pool, not the stock list behind it', () => {
    MApp.Shell.current = 'stock';
    MApp.Stock.view = 'pool';
    MApp.Stock.load = jest.fn();
    MApp.Pool.load = jest.fn();
    MApp.Shell.refreshCurrentTab();
    expect(MApp.Pool.load).toHaveBeenCalledWith({ keep: true });
    expect(MApp.Stock.load).not.toHaveBeenCalled();
  });
});

// ── The service worker's background sync ────────────────────────────────
describe("the service worker's background sync", () => {
  function runSync(pending, answers) {
    const listeners = {};
    const posted = [];
    const scope = {
      addEventListener: (name, fn) => { listeners[name] = fn; },
      skipWaiting: () => Promise.resolve(),
      clients: {
        claim: () => Promise.resolve(),
        matchAll: async () => [{ postMessage: m => posted.push(m) }]
      },
      registration: {},
      location: { origin: 'https://erp.test' }
    };
    global.OfflineCache = {
      outbox: {
        listPending: async () => pending,
        markDone: jest.fn(async () => {}),
        markFailed: jest.fn(async () => {})
      }
    };
    global.Api = {
      mutateWithId: jest.fn(async () => {
        const next = answers.shift();
        if (next instanceof Error) throw next;
        return next;
      })
    };
    // eslint-disable-next-line no-new-func
    new Function('self', 'caches', 'importScripts', read('mobile-sw.js'))(
      scope, { open: async () => ({}), keys: async () => [] }, () => {});

    let done;
    listeners.sync({ tag: 'outbox-flush', waitUntil: p => { done = p; } });
    return done.then(() => posted);
  }

  const entry = id => ({ id, method: 'saveDispatch', mutationId: `m${id}`, args: [] });
  const offline = () => Object.assign(new Error('offline'), { isNetworkError: true });

  test('with nothing queued tells no page to redraw', async () => {
    expect(await runSync([], [])).toEqual([]);
  });

  test('tells the page once something was sent', async () => {
    expect(await runSync([entry(1)], [{ success: true }])).toEqual([{ type: 'outbox-flushed' }]);
  });

  test('still tells it when the connection drops after the first of two', async () => {
    expect(await runSync([entry(1), entry(2)], [{ success: true }, offline()]))
      .toEqual([{ type: 'outbox-flushed' }]);
  });
});
