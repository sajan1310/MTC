/**
 * Choosing what Home shows.
 *
 * Home shipped with three fixed tiles -- the right three for most people
 * and the wrong three for anyone whose job is contractor payables, or
 * purchase orders, or watching a queue drain. The numbers all existed;
 * the choice did not.
 *
 * The load path is what most of this file is about. getMobileDashboard
 * is three numbers and is offline-cached; getDashboardData is the full
 * set and is not cheap. Home has always used the small one deliberately,
 * so the cost has to follow the choice: leave the defaults alone and
 * Home makes exactly the request it always did.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const VIEWS_HTML = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', 'mobile_views.html'), 'utf8'
);

function loadAsGlobal(relPath, exportName) {
  const code = fs
    .readFileSync(path.join(__dirname, '..', relPath), 'utf8')
    .replace(new RegExp(`^const ${exportName} = `, 'm'), `global.${exportName} = `);
  // eslint-disable-next-line no-eval
  eval(code);
}

const SMALL = {
  pendingProductionCount: 4, todaysDispatchCount: 2, lowStockCount: 3,
  recentActivity: [],
};

const FULL = {
  kpis: {
    inProgressProductionCount: 7, queuedProductionCount: 5,
    oldestPendingProductionDays: 12, readyToDispatchUnits: 120,
    lowStockTotalDeficit: 30, openPoCount: 4, openPoValue: 12000,
    billsThisMonthCount: 9, billsThisMonthValue: 45000,
    contractorPayablesDue: 3000, contractorPayablesCount: 1,
  },
  dispatchTrend: Array.from({ length: 30 }, (_, i) => ({ date: `2026-08-${i + 1}`, qty: i })),
  productionStatusBreakdown: [{ status: 'Pending', count: 5 }, { status: 'Completed', count: 9 }],
  lowStockItems: [{ name: 'Rim 26', size: '26 inch', deficit: 15 }],
  contractorPayables: [{ contractorName: 'rakesh', balanceDue: 3000 }],
};

function mount() {
  jest.resetModules();
  global.fetch = jest.fn();
  document.body.innerHTML = `
    <div id="mapp-sheet-backdrop"></div>
    <h1 id="home-greeting"></h1><div id="home-date"></div>
    <div id="home-stats"></div>
    <div id="home-activity"></div>
    <div class="mb-sheet" id="sheet-home-layout">
      <div id="home-layout-note"></div>
      <div id="home-layout-body"></div>
    </div>
    <div class="mb-toast-stack" id="mapp-toast-stack"></div>`;
  try { localStorage.clear(); } catch (e) { /* ignore */ }
  loadAsGlobal('api.js', 'Api');
  loadAsGlobal('mobile.js', 'MApp');
  MApp.Sheet._stack = [];
  MApp.Home._full = null;
  MApp.Api.callCached = jest.fn(async () => ({ success: true, data: SMALL }));
  MApp.Api.call = jest.fn(async () => ({ success: true, data: FULL }));
}

const blocks = () => document.getElementById('home-blocks');
const tiles = () => [...document.querySelectorAll('#home-blocks .mb-stat-tile')];

describe('the catalogue', () => {
  beforeEach(mount);

  test('the default is the three tiles Home has always shown', () => {
    expect(MApp.HomeLayout.read()).toEqual(['pendingProduction', 'todaysDispatches', 'lowStock']);
  });

  test('every block declares which payload feeds it', () => {
    MApp.HomeLayout.BLOCKS.forEach(b => {
      expect(['mobile', 'full']).toContain(b.source);
      expect(typeof b.label).toBe('string');
      expect(b.label.length).toBeGreaterThan(0);
    });
  });

  test('every default block comes from the cached payload', () => {
    // Otherwise the out-of-the-box Home would be slower than it was.
    MApp.HomeLayout.DEFAULTS.forEach(key => {
      expect(MApp.HomeLayout.block(key).source).toBe('mobile');
    });
  });

  test('block keys are unique', () => {
    const keys = MApp.HomeLayout.BLOCKS.map(b => b.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('a stored key from an older build is dropped, not rendered as a hole', () => {
    localStorage.setItem(MApp.HomeLayout.KEY, JSON.stringify(['lowStock', 'somethingRemoved']));
    expect(MApp.HomeLayout.read()).toEqual(['lowStock']);
  });

  test('junk in the key falls back to the defaults', () => {
    localStorage.setItem(MApp.HomeLayout.KEY, 'not json');
    expect(MApp.HomeLayout.read()).toEqual(MApp.HomeLayout.DEFAULTS);
  });

  test('blocks render in catalogue order, not pick order', () => {
    // Keeps the grid a stable shape and related figures together.
    MApp.HomeLayout.write(['lowStock', 'pendingProduction']);
    expect(MApp.HomeLayout.selected().map(b => b.key))
      .toEqual(['pendingProduction', 'lowStock']);
  });
});

describe('what Home actually requests', () => {
  beforeEach(mount);

  test('the default Home makes exactly the one cached call it always did', async () => {
    await MApp.Home.mount();

    expect(MApp.Api.callCached).toHaveBeenCalledWith('getMobileDashboard');
    expect(MApp.Api.call).not.toHaveBeenCalledWith('getDashboardData');
  });

  test('choosing a figure from the full set asks for it, once', async () => {
    MApp.HomeLayout.write(['lowStock', 'openPos']);

    await MApp.Home.mount();

    expect(MApp.Api.call).toHaveBeenCalledWith('getDashboardData');
    expect(MApp.Api.call.mock.calls.filter(c => c[0] === 'getDashboardData').length).toBe(1);
  });

  test('needsFullData answers for the current selection', () => {
    MApp.HomeLayout.write(['lowStock']);
    expect(MApp.HomeLayout.needsFullData()).toBe(false);

    MApp.HomeLayout.write(['lowStock', 'dispatchTrend']);
    expect(MApp.HomeLayout.needsFullData()).toBe(true);
  });

  test('the cheap tiles are on screen before the slow request resolves', async () => {
    // The point of rendering twice: a customised Home must not go blank
    // while it waits.
    let release;
    MApp.Api.call = jest.fn(() => new Promise(r => { release = () => r({ success: true, data: FULL }); }));
    MApp.HomeLayout.write(['lowStock', 'openPos']);

    const done = MApp.Home.mount();
    await Promise.resolve();
    await Promise.resolve();
    expect(blocks().textContent).toContain('Low-stock alerts');

    release();
    await done;
    expect(blocks().textContent).toContain('Open POs');
  });
});

describe('what a block shows before its data arrives', () => {
  beforeEach(mount);

  test('a pending figure reads as a dash, not a zero', async () => {
    // "We do not know yet" and "there are none" are different answers,
    // and on a dashboard the difference is the whole point.
    let release;
    MApp.Api.call = jest.fn(() => new Promise(r => { release = () => r({ success: true, data: FULL }); }));
    MApp.HomeLayout.write(['openPos']);

    const done = MApp.Home.mount();
    await Promise.resolve();
    await Promise.resolve();

    expect(blocks().textContent).toContain('—');
    expect(blocks().textContent).not.toContain('0');

    release();
    await done;
  });

  test('a failed full request leaves a dash rather than a wrong number', async () => {
    MApp.Api.call = jest.fn(async () => { throw new Error('offline'); });
    MApp.HomeLayout.write(['lowStock', 'openPos']);

    await MApp.Home.mount();

    expect(blocks().textContent).toContain('Low-stock alerts'); // the cheap one survived
    expect(blocks().textContent).toContain('—');
  });

  test('a failed full request says charts are not available offline', async () => {
    MApp.Api.call = jest.fn(async () => ({ success: false }));
    MApp.HomeLayout.write(['dispatchTrend']);

    await MApp.Home.mount();

    expect(blocks().textContent).toContain('Not available offline');
  });
});

describe('rendering the figures', () => {
  beforeEach(mount);

  test('each chosen tile shows its number', async () => {
    MApp.HomeLayout.write(['pendingProduction', 'todaysDispatches', 'lowStock']);
    await MApp.Home.mount();

    expect(tiles().length).toBe(3);
    expect(blocks().textContent).toContain('Pending production');
    expect(blocks().textContent).toContain('4');
  });

  test('a money tile carries its value underneath the count', async () => {
    MApp.HomeLayout.write(['openPos']);
    await MApp.Home.mount();

    expect(blocks().textContent).toContain('Open POs');
    expect(blocks().textContent).toContain('4');
    expect(blocks().textContent).toContain('12000');
  });

  test('low stock turns red only when there is some', async () => {
    MApp.HomeLayout.write(['lowStock']);
    await MApp.Home.mount();
    expect(document.querySelector('#home-blocks .mb-accent-red')).not.toBeNull();

    MApp.Api.callCached = jest.fn(async () => ({ success: true, data: { ...SMALL, lowStockCount: 0 } }));
    await MApp.Home.mount();
    expect(document.querySelector('#home-blocks .mb-accent-red')).toBeNull();
  });

  test('an empty selection says so instead of rendering nothing', async () => {
    // Choosing none is a real choice -- somebody who only wants the
    // activity list -- so it is allowed and explained.
    MApp.HomeLayout.write([]);
    await MApp.Home.mount();

    expect(blocks().textContent).toContain('No figures chosen');
  });
});

describe('rendering the charts', () => {
  beforeEach(mount);

  test('the sparkline is inline SVG, with no library loaded', async () => {
    // Everything here is self-hosted: this app runs on factory LANs with
    // no reliable internet and the service worker caches only
    // same-origin /static/erp/ URLs.
    MApp.HomeLayout.write(['dispatchTrend']);
    await MApp.Home.mount();

    const svg = document.querySelector('#home-blocks .mapp-spark');
    expect(svg).not.toBeNull();
    expect(svg.querySelector('path').getAttribute('d')).toMatch(/^M0/);
    expect(document.querySelector('script[src]')).toBeNull();
  });

  test('the sparkline carries a text summary for anyone who cannot see it', async () => {
    // A chart that announces 30 unlabelled numbers is worse than one that
    // says the total and the peak.
    MApp.HomeLayout.write(['dispatchTrend']);
    await MApp.Home.mount();

    expect(document.querySelector('#home-blocks .mapp-spark').getAttribute('aria-hidden')).toBe('true');
    expect(blocks().textContent).toContain('over 30 days');
    expect(blocks().textContent).toContain('peak');
  });

  test('a series too short to plot says so', async () => {
    MApp.Api.call = jest.fn(async () => ({ success: true, data: { ...FULL, dispatchTrend: [{ date: 'x', qty: 1 }] } }));
    MApp.HomeLayout.write(['dispatchTrend']);
    await MApp.Home.mount();

    expect(blocks().textContent).toContain('Not enough days yet');
  });

  test('a pie draws one wedge per slice', async () => {
    MApp.HomeLayout.write(['productionMix']);
    await MApp.Home.mount();

    // Pending 5 + Completed 9, and the breakdown is a GROUP BY over every
    // lot, so there is no remainder and no Other slice.
    expect(document.querySelectorAll('#home-blocks .mapp-pie path').length).toBe(2);
    expect(document.querySelectorAll('#home-blocks .mapp-pie-row').length).toBe(2);
  });

  test('each slice is labelled with its value and its share', async () => {
    MApp.HomeLayout.write(['productionMix']);
    await MApp.Home.mount();

    const text = blocks().textContent;
    expect(text).toContain('Completed');
    expect(text).toContain('64%'); // 9 of 14
    expect(text).toContain('Total 14');
  });

  test('a truncated list gets an explicit Other slice', async () => {
    // lowStockItems is a top-N; lowStockTotalDeficit is the real total.
    // Drawing the top five as if they were everything would inflate
    // every percentage on the chart.
    MApp.HomeLayout.write(['lowStockWorst']);
    await MApp.Home.mount();

    const text = blocks().textContent;
    expect(text).toContain('Rim 26');
    expect(text).toContain('Other');
    expect(text).toContain('Total 30'); // 15 shown, 30 declared
    expect(text).toContain('50%');
  });

  test('a complete list gets no Other slice', async () => {
    // contractorPayablesDue equals the one row, so there is no remainder
    // to name and inventing one would be noise.
    MApp.HomeLayout.write(['payablesByContractor']);
    await MApp.Home.mount();

    expect(blocks().textContent).not.toContain('Other');
  });

  test('a single slice draws a circle, not a degenerate arc', async () => {
    // An arc between two identical points draws nothing at all, so 100%
    // of one thing would render an empty pie.
    MApp.Api.call = jest.fn(async () => ({
      success: true,
      data: { ...FULL, productionStatusBreakdown: [{ status: 'Pending', count: 7 }] },
    }));
    MApp.HomeLayout.write(['productionMix']);
    await MApp.Home.mount();

    expect(document.querySelector('#home-blocks .mapp-pie circle')).not.toBeNull();
    expect(document.querySelector('#home-blocks .mapp-pie path')).toBeNull();
    expect(blocks().textContent).toContain('100%');
  });

  test('slices past the sixth are folded into Other', async () => {
    // Thinner than a fingertip and unreadable in a legend.
    MApp.Api.call = jest.fn(async () => ({
      success: true,
      data: {
        ...FULL,
        productionStatusBreakdown: Array.from({ length: 9 },
          (_, i) => ({ status: 'S' + i, count: 10 - i })),
      },
    }));
    MApp.HomeLayout.write(['productionMix']);
    await MApp.Home.mount();

    expect(document.querySelectorAll('#home-blocks .mapp-pie-row').length).toBe(7); // 6 + Other
    expect(blocks().textContent).toContain('Other');
  });

  test('slices are ordered largest first', async () => {
    MApp.HomeLayout.write(['productionMix']);
    await MApp.Home.mount();

    const labels = [...document.querySelectorAll('#home-blocks .mapp-pie-label')]
      .map(el => el.textContent);
    expect(labels).toEqual(['Completed', 'Pending']);
  });

  test('zero and negative rows are left out', async () => {
    MApp.Api.call = jest.fn(async () => ({
      success: true,
      data: { ...FULL, productionStatusBreakdown: [{ status: 'Pending', count: 0 }, { status: 'Done', count: 3 }] },
    }));
    MApp.HomeLayout.write(['productionMix']);
    await MApp.Home.mount();

    expect(document.querySelectorAll('#home-blocks .mapp-pie-row').length).toBe(1);
  });

  test('an empty series reads as empty rather than a broken chart', async () => {
    MApp.Api.call = jest.fn(async () => ({
      success: true,
      data: { ...FULL, contractorPayables: [], kpis: { ...FULL.kpis, contractorPayablesDue: 0 } },
    }));
    MApp.HomeLayout.write(['payablesByContractor']);
    await MApp.Home.mount();

    expect(blocks().textContent).toContain('Nothing to show');
  });

  test('the wedges are hidden from a screen reader; the legend is not', async () => {
    // A pie read aloud as a list of unlabelled wedges tells nobody
    // anything. Every number is in the rows beside it.
    MApp.HomeLayout.write(['productionMix']);
    await MApp.Home.mount();

    expect(document.querySelector('#home-blocks .mapp-pie').getAttribute('aria-hidden')).toBe('true');
    expect(document.querySelectorAll('#home-blocks .mapp-pie-value').length).toBe(2);
  });

  test('the 30-day trend stays a line, because a pie of dates says nothing', async () => {
    // Parts of a whole is what a pie claims. Thirty consecutive days are
    // a sequence, and slicing them would throw away the only thing the
    // series is for.
    MApp.HomeLayout.write(['dispatchTrend']);
    await MApp.Home.mount();

    expect(document.querySelector('#home-blocks .mapp-spark')).not.toBeNull();
    expect(document.querySelector('#home-blocks .mapp-pie')).toBeNull();
  });
});

describe('the picker', () => {
  beforeEach(mount);

  test('lists every block, grouped, marked shown or hidden', () => {
    MApp.HomeLayout.open();

    const rows = document.querySelectorAll('#home-layout-body [data-block-toggle]');
    expect(rows.length).toBe(MApp.HomeLayout.BLOCKS.length);
    expect(document.getElementById('home-layout-body').textContent).toContain('Production');
    expect(document.getElementById('home-layout-body').textContent).toContain('Charts');
  });

  test('each row says what choosing it costs', () => {
    MApp.HomeLayout.open();
    const body = document.getElementById('home-layout-body').textContent;

    expect(body).toContain('Always loaded, works offline');
    expect(body).toContain('Needs the full dashboard');
  });

  test('the note changes once a slow block is picked', () => {
    MApp.HomeLayout.open();
    expect(document.getElementById('home-layout-note').textContent).toContain('stays instant');

    MApp.HomeLayout.toggle('openPos');
    expect(document.getElementById('home-layout-note').textContent).toContain('take a moment longer');
  });

  test('nothing is written until Save', () => {
    MApp.HomeLayout.open();
    MApp.HomeLayout.toggle('openPos');

    expect(MApp.HomeLayout.read()).toEqual(MApp.HomeLayout.DEFAULTS);
  });

  test('Save stores the draft and rebuilds Home', () => {
    MApp.Home.mount = jest.fn();
    MApp.HomeLayout.open();
    MApp.HomeLayout.toggle('openPos');
    MApp.HomeLayout.save();

    expect(MApp.HomeLayout.read()).toContain('openPos');
    expect(MApp.Home.mount).toHaveBeenCalled();
  });

  test('reset goes back to the default three', () => {
    MApp.HomeLayout.write(['openPos', 'dispatchTrend']);
    MApp.HomeLayout.open();

    MApp.HomeLayout.reset();
    MApp.HomeLayout.save();

    expect(MApp.HomeLayout.read()).toEqual(MApp.HomeLayout.DEFAULTS);
  });

  test('an unknown key cannot be toggled in', () => {
    MApp.HomeLayout.open();
    MApp.HomeLayout.toggle('notARealBlock');
    MApp.HomeLayout.save();

    expect(MApp.HomeLayout.read()).not.toContain('notARealBlock');
  });

  test('the entry point is on Home', () => {
    expect(VIEWS_HTML).toContain('MApp.HomeLayout.open()');
  });
});
