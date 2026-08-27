/**
 * Regression tests for the dashboard redesign's two new rendering rules,
 * run against the REAL partial (read off disk) and the REAL dashboard.js,
 * using the same const-rewrite/eval technique nav.test.js established for
 * loading a classic script into a Jest module scope.
 *
 * What is pinned here is specifically what the redesign added and what a
 * future edit is most likely to quietly undo:
 *
 *   1. A KPI's colour reports whether its number is BAD, via
 *      [data-status], rather than being a fixed property of the metric.
 *      The old tiles hardcoded a red icon on "Stock Alerts" whether the
 *      count was 0 or 200, which is the whole reason the row could not be
 *      read at a glance.
 *
 *   2. Every status is ALSO stated in words in the tile's note, so the
 *      tile survives greyscale, colour-blindness and a screen reader
 *      (WCAG 1.4.1 -- colour is never the only carrier).
 *
 *   3. The WIP pipeline is a ranked list whose rows survive any process
 *      name length, and whose per-stage breakdown renders only when it
 *      says something the stage total does not. The card wall this
 *      replaced overflowed on long names and spent most of its height
 *      restating each total as a lone "Unspecified" row.
 *
 *   4. Refresh is scheduled off how stale the data actually is, so a tab
 *      returning from hours hidden reloads at once instead of showing
 *      stale numbers for another full interval; and the focused control
 *      survives the re-render that a refresh performs.
 *
 * Plus the month-over-month delta being a percentage rather than the raw
 * difference, which is uninterpretable without knowing the base.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PARTIAL = path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', 'dashboard.html');

function loadDashboardAsGlobal() {
  global.App = { Utils: { showToast: jest.fn(), formatNameCase: s => s } };
  // api.js owns escapeHtml/formatCurrency/formatQty/toNumber, which
  // dashboard.js calls as bare globals. Both files open with 'use strict',
  // so each eval() gets its own scope and function declarations do NOT leak
  // between them the way outbox_chaos.test.js's `const X =` rewrite relies
  // on -- hence the explicit export epilogue appended inside api's scope.
  const api = [
    fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8'),
    'global.toNumber = toNumber;',
    'global.escapeHtml = escapeHtml;',
    'global.formatCurrency = formatCurrency;',
    'global.formatQty = formatQty;',
  ].join('\n');
  // eslint-disable-next-line no-eval
  eval(api);
  const code = fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8');
  // eslint-disable-next-line no-eval
  eval(code);
}

function mountPartial() {
  // Strip the Jinja admin guard: jsdom renders markup, not templates.
  const html = fs
    .readFileSync(PARTIAL, 'utf8')
    .replace(/\{%[^%]*%\}/g, '');
  document.body.innerHTML = html;
}

// Minimal KPI payload; each test overrides only the fields it cares about.
function kpis(overrides) {
  return Object.assign({
    openPoCount: 0, openPoValue: 0,
    billsThisMonthCount: 0, billsThisMonthValue: 0,
    billsLastMonthCount: 0, billsLastMonthValue: 0,
    returnsThisMonthCount: 0, returnsThisMonthValue: 0,
    returnsLastMonthCount: 0, returnsLastMonthValue: 0,
    wastageThisMonthCount: 0, wastageThisMonthQty: 0,
    wastageLastMonthCount: 0, wastageLastMonthQty: 0,
    lowStockCount: 0, lowStockTotalDeficit: 0,
    pendingProductionCount: 0, inProgressProductionCount: 0, queuedProductionCount: 0,
    oldestPendingProductionDays: null,
    readyToDispatchUnits: 0, readyToDispatchProductCount: 0,
    contractorPayablesDue: 0, contractorPayablesCount: 0,
  }, overrides);
}

const statusOf = id => document.getElementById(id).getAttribute('data-status');
const noteOf = id => document.getElementById(id).textContent;

describe('dashboard KPI status', () => {
  beforeEach(() => {
    mountPartial();
    loadDashboardAsGlobal();
  });

  test('every hero tile starts neutral before any data arrives', () => {
    ['heroLowStock', 'heroPendingProduction', 'heroReadyDispatch', 'heroContractorPayables']
      .forEach(id => expect(statusOf(id)).toBe('neutral'));
  });

  test('zero low stock is ok, not a red alert', () => {
    App.Dashboard.renderKpis(kpis({ lowStockCount: 0 }));
    expect(statusOf('heroLowStock')).toBe('ok');
    expect(noteOf('kpiLowStockSub')).toMatch(/above threshold/i);
  });

  test('low stock escalates ok -> warn -> critical across the threshold', () => {
    App.Dashboard.renderKpis(kpis({ lowStockCount: 3, lowStockTotalDeficit: 12 }));
    expect(statusOf('heroLowStock')).toBe('warn');

    App.Dashboard.renderKpis(kpis({ lowStockCount: 9, lowStockTotalDeficit: 40 }));
    expect(statusOf('heroLowStock')).toBe('critical');
    expect(document.getElementById('kpiLowStockCount').textContent).toBe('9');
  });

  test('production status keys off the OLDEST lot age, not the open count', () => {
    // Many lots, all young: busy, not distressed.
    App.Dashboard.renderKpis(kpis({
      pendingProductionCount: 40, inProgressProductionCount: 40, oldestPendingProductionDays: 1,
    }));
    expect(statusOf('heroPendingProduction')).toBe('ok');

    // One lot, three weeks old: a real problem.
    App.Dashboard.renderKpis(kpis({
      pendingProductionCount: 1, inProgressProductionCount: 1, oldestPendingProductionDays: 21,
    }));
    expect(statusOf('heroPendingProduction')).toBe('critical');
    expect(noteOf('kpiPendingProductionSub')).toMatch(/oldest 21 days/i);
  });

  test('the tile counts only what is running, and names the queue separately', () => {
    // The tile is labelled "Production In Progress" and sits directly above
    // a WIP pipeline that now draws In Progress lots only. Showing the
    // combined open count here contradicted the list below it.
    App.Dashboard.renderKpis(kpis({
      pendingProductionCount: 11, inProgressProductionCount: 8, queuedProductionCount: 3,
      oldestPendingProductionDays: 2,
    }));
    expect(document.getElementById('kpiPendingProduction').textContent).toBe('8');
    expect(noteOf('kpiPendingProductionSub')).toMatch(/8 lots running/i);
    expect(noteOf('kpiPendingProductionSub')).toMatch(/3 queued/i);
  });

  test('an oldest PENDING lot still escalates the tile it is queued under', () => {
    // Nothing running, one lot queued for a month. Moving Pending out of the
    // pipeline must not also move it out of the alerting.
    App.Dashboard.renderKpis(kpis({
      pendingProductionCount: 1, inProgressProductionCount: 0, queuedProductionCount: 1,
      oldestPendingProductionDays: 30,
    }));
    expect(statusOf('heroPendingProduction')).toBe('critical');
    expect(noteOf('kpiPendingProductionSub')).toMatch(/1 queued/i);
  });

  test('no open lots is ok even though oldest age is null', () => {
    App.Dashboard.renderKpis(kpis({ pendingProductionCount: 0, oldestPendingProductionDays: null }));
    expect(statusOf('heroPendingProduction')).toBe('ok');
    expect(noteOf('kpiPendingProductionSub')).toMatch(/no lots open/i);
  });

  test('contractor payables warn only when something is actually owed', () => {
    App.Dashboard.renderKpis(kpis({ contractorPayablesDue: 0, contractorPayablesCount: 0 }));
    expect(statusOf('heroContractorPayables')).toBe('ok');

    App.Dashboard.renderKpis(kpis({ contractorPayablesDue: 4500, contractorPayablesCount: 2 }));
    expect(statusOf('heroContractorPayables')).toBe('warn');
    expect(noteOf('kpiContractorPayablesSub')).toMatch(/2 contractors/i);
  });

  test('nothing ready to ship is neutral, not a success state', () => {
    App.Dashboard.renderKpis(kpis({ readyToDispatchUnits: 0 }));
    expect(statusOf('heroReadyDispatch')).toBe('neutral');

    App.Dashboard.renderKpis(kpis({ readyToDispatchUnits: 12, readyToDispatchProductCount: 1 }));
    expect(statusOf('heroReadyDispatch')).toBe('ok');
    expect(noteOf('kpiReadyDispatchSub')).toMatch(/1 product ready/i);
  });

  test('every status is also stated in words, never colour alone (WCAG 1.4.1)', () => {
    App.Dashboard.renderKpis(kpis({
      lowStockCount: 9, lowStockTotalDeficit: 40,
      pendingProductionCount: 2, inProgressProductionCount: 1, queuedProductionCount: 1,
      oldestPendingProductionDays: 30,
      readyToDispatchUnits: 5, readyToDispatchProductCount: 1,
      contractorPayablesDue: 100, contractorPayablesCount: 1,
    }));
    ['kpiLowStockSub', 'kpiPendingProductionSub', 'kpiReadyDispatchSub', 'kpiContractorPayablesSub']
      .forEach(id => expect(noteOf(id).trim().length).toBeGreaterThan(0));
  });
});

describe('dashboard month-over-month delta', () => {
  beforeEach(() => {
    mountPartial();
    loadDashboardAsGlobal();
  });

  test('is a percentage, not the raw difference', () => {
    // +3 on a base of 4 and +3 on a base of 400 rendered identically before.
    expect(App.Dashboard.deltaLabel(7, 4)).toContain('75%');
    expect(App.Dashboard.deltaLabel(403, 400)).toContain('1%');
  });

  test('marks direction with a glyph as well as an attribute', () => {
    expect(App.Dashboard.deltaLabel(10, 5)).toContain('data-dir="up"');
    expect(App.Dashboard.deltaLabel(5, 10)).toContain('data-dir="down"');
    expect(App.Dashboard.deltaLabel(5, 5)).toContain('data-dir="flat"');
  });

  test('does not divide by zero when last month had none', () => {
    expect(App.Dashboard.deltaLabel(5, 0)).toContain('new vs last mo.');
    expect(App.Dashboard.deltaLabel(0, 0)).toContain('no change');
  });
});

describe('dashboard tile structure', () => {
  beforeEach(() => mountPartial());

  test('every clickable tile is a real button, not a div with role=button', () => {
    const fakeButtons = document.querySelectorAll('div[role="button"]');
    expect(Array.from(fakeButtons).map(el => el.id)).toEqual([]);

    ['heroLowStock', 'heroPendingProduction', 'heroReadyDispatch', 'heroContractorPayables']
      .forEach(id => expect(document.getElementById(id).tagName).toBe('BUTTON'));
  });

  test('the four navigation-only tiles with no metric behind them are gone', () => {
    // Items Master / Vendors / Products & Processes / Clients duplicated the
    // sidebar and diluted the row carrying the real numbers.
    const labels = Array.from(document.querySelectorAll('.dash-hero-label'))
      .map(el => el.textContent.trim());
    expect(labels).toHaveLength(4);
    expect(labels).not.toContain('Items Master');
    expect(labels).not.toContain('Clients');
  });
});

describe('dashboard WIP pipeline', () => {
  beforeEach(() => {
    mountPartial();
    loadDashboardAsGlobal();
  });

  const stage = (over) => Object.assign({
    processId: 'P1', processName: 'Rim Fitting 14 inch', sequence: 1,
    totalQty: 100, totalLotCount: 1,
    groups: [{ title: 'Unspecified', qty: 100, lotCount: 1 }],
  }, over);

  const render = stages => {
    App.Dashboard.renderPipeline(stages);
    return document.getElementById('dashboardPipeline');
  };

  test('renders one row per stage, in the order given', () => {
    const el = render([
      stage({ processId: 'A', processName: 'Rim Fitting' }),
      stage({ processId: 'B', processName: 'Mudguard Paint' }),
      stage({ processId: 'C', processName: 'Packing' }),
    ]);
    const names = Array.from(el.querySelectorAll('.dash-wip-name')).map(n => n.textContent);
    expect(names).toEqual(['Rim Fitting', 'Mudguard Paint', 'Packing']);
  });

  test('a stage whose only group is Unspecified renders no breakdown chips', () => {
    // This was the bulk of the old pipeline's height: a full-width row
    // reading "Unspecified 100" directly beneath a header reading "100 units".
    const el = render([stage({ totalQty: 100, groups: [{ title: 'Unspecified', qty: 100, lotCount: 1 }] })]);
    expect(el.querySelectorAll('.dash-wip-chip')).toHaveLength(0);
    expect(el.querySelector('.dash-wip-qty').textContent).toContain('100');
  });

  test('a stage with real colour groups does render them', () => {
    const el = render([stage({
      totalQty: 200,
      groups: [{ title: 'Red', qty: 120, lotCount: 2 }, { title: 'Blue', qty: 80, lotCount: 2 }],
    })]);
    const chips = Array.from(el.querySelectorAll('.dash-wip-chip-title')).map(c => c.textContent);
    expect(chips).toEqual(['Red', 'Blue']);
  });

  test('breakdown chips cap at three and count the remainder', () => {
    const el = render([stage({
      groups: ['Red', 'Blue', 'Green', 'Black', 'White'].map(t => ({ title: t, qty: 10, lotCount: 1 })),
    })]);
    expect(el.querySelectorAll('.dash-wip-chip-title')).toHaveLength(3);
    expect(el.querySelector('.dash-wip-chip-more').textContent).toBe('+2 more');
  });

  test('the busiest stage is marked, and only that one', () => {
    const el = render([
      stage({ processId: 'A', processName: 'Small', totalQty: 50 }),
      stage({ processId: 'B', processName: 'Biggest', totalQty: 340 }),
      stage({ processId: 'C', processName: 'Middle', totalQty: 200 }),
    ]);
    const marks = el.querySelectorAll('.dash-wip-peak');
    expect(marks).toHaveLength(1);
    const peakRow = marks[0].closest('.dash-wip-row');
    expect(peakRow.querySelector('.dash-wip-name').textContent).toBe('Biggest');
  });

  test('rows carry no inline bar -- that comparison belongs to the column chart', () => {
    // A per-row bar could only scale against its OWN list's maximum, so a
    // stage's running and queued totals were drawn against two different
    // maxima and could not be read against each other at all.
    const el = render([
      stage({ processId: 'A', totalQty: 340 }),
      stage({ processId: 'B', totalQty: 170 }),
    ]);
    expect(el.querySelectorAll('.dash-wip-bar-fill')).toHaveLength(0);
    expect(Array.from(el.querySelectorAll('.dash-wip-qty')).map(q => q.textContent))
      .toEqual(['340 units', '170 units']);
  });

  test('a single stage does not get a "most WIP" badge', () => {
    const el = render([stage({})]);
    expect(el.querySelectorAll('.dash-wip-peak')).toHaveLength(0);
  });

  test('summarises total units, lots and stage count', () => {
    const el = render([
      stage({ processId: 'A', totalQty: 100, totalLotCount: 1 }),
      stage({ processId: 'B', totalQty: 200, totalLotCount: 4 }),
    ]);
    const text = el.querySelector('.dash-wip-summary').textContent.replace(/\s+/g, ' ');
    expect(text).toContain('300 units in progress');
    expect(text).toContain('5 lots');
    expect(text).toContain('2 stages');
  });

  test('a long process name stays in its own cell rather than overflowing', () => {
    // The old card wall sized each card to its content, so a name this long
    // spilled over the neighbouring card. The name now owns a grid column
    // that truncates.
    const long = 'Fitting Frame 20 inch Valcano Shocker Tyre Packing Extra Long Name';
    const el = render([stage({ processName: long }), stage({ processId: 'B' })]);
    const nameEl = el.querySelector('.dash-wip-name');
    expect(nameEl.textContent).toBe(long);
    expect(nameEl.parentElement.classList.contains('dash-wip-row')).toBe(true);
  });

  test('escapes process names rather than trusting them as markup', () => {
    const el = render([stage({ processName: '<img src=x onerror=alert(1)>' })]);
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('.dash-wip-name').textContent).toBe('<img src=x onerror=alert(1)>');
  });

  test('empty pipeline says so instead of rendering an empty frame', () => {
    const el = render([]);
    expect(el.textContent).toMatch(/nothing is in progress/i);
    expect(el.querySelectorAll('.dash-wip-row')).toHaveLength(0);
  });

  test('a stage carries the age of its oldest lot, coloured by the same thresholds', () => {
    // Units say how much is at a stage; age says whether it is moving.
    const el = render([
      stage({ processId: 'A', processName: 'Fresh', oldestDays: 1 }),
      stage({ processId: 'B', processName: 'Slipping', oldestDays: 9 }),
      stage({ processId: 'C', processName: 'Stuck', oldestDays: 40 }),
    ]);
    const ages = Array.from(el.querySelectorAll('.dash-wip-age'));
    expect(ages.map(a => a.getAttribute('data-status'))).toEqual(['ok', 'warn', 'critical']);
    // "12d" alone means nothing read aloud -- the badge spells it out too.
    expect(ages[2].textContent).toMatch(/40d/);
    expect(ages[2].querySelector('.visually-hidden').textContent).toMatch(/40 days/i);
  });

  test('a stage with no known age renders no age badge rather than an empty one', () => {
    const el = render([stage({ oldestDays: null })]);
    expect(el.querySelectorAll('.dash-wip-age')).toHaveLength(0);
  });
});

// The second list built from the same row component. Its whole reason to
// exist is that Pending lots used to be counted into the pipeline above,
// inflating every stage total with work nobody had started.
describe('dashboard Upcoming Lots', () => {
  beforeEach(() => {
    mountPartial();
    loadDashboardAsGlobal();
  });

  const stage = (over) => Object.assign({
    processId: 'P1', processName: 'Rim Fitting 14 inch', sequence: 1,
    totalQty: 100, totalLotCount: 1, oldestDays: 0,
    groups: [{ title: 'Unspecified', qty: 100, lotCount: 1 }],
  }, over);

  const render = stages => {
    App.Dashboard.renderUpcoming(stages);
    return document.getElementById('dashboardUpcoming');
  };

  test('renders into its own container, not the pipeline', () => {
    App.Dashboard.renderPipeline([stage({ processName: 'Running' })]);
    render([stage({ processName: 'Queued' })]);
    expect(document.getElementById('dashboardPipeline').textContent).toContain('Running');
    expect(document.getElementById('dashboardPipeline').textContent).not.toContain('Queued');
    expect(document.getElementById('dashboardUpcoming').textContent).toContain('Queued');
  });

  test('summarises units as queued, not as in progress', () => {
    const el = render([stage({ totalQty: 250, totalLotCount: 3 })]);
    const text = el.querySelector('.dash-wip-summary').textContent.replace(/\s+/g, ' ');
    expect(text).toContain('250 units queued');
    expect(text).not.toContain('in progress');
  });

  test('is marked as the upcoming variant so its bars read as not-yet-started', () => {
    const el = render([stage({})]);
    expect(el.querySelector('.dash-wip-list').getAttribute('data-variant')).toBe('upcoming');
    expect(document.querySelector('#dashboardPipeline .dash-wip-list')).toBeNull();
  });

  test('the busiest queue is labelled as a queue, not as WIP', () => {
    const el = render([
      stage({ processId: 'A', totalQty: 50 }),
      stage({ processId: 'B', totalQty: 400 }),
    ]);
    expect(el.querySelector('.dash-wip-peak').textContent).toBe('longest queue');
  });

  test('empty upcoming list says nothing is queued', () => {
    const el = render([]);
    expect(el.textContent).toMatch(/no pending lots/i);
    expect(el.querySelectorAll('.dash-wip-row')).toHaveLength(0);
  });

  test('focus on an upcoming row is not restored onto the pipeline row for the same stage', () => {
    // Both lists key their rows on data-action + processid, so without the
    // region in the focus token these are indistinguishable.
    App.Dashboard.renderPipeline([stage({ processId: 'P1' })]);
    render([stage({ processId: 'P1' })]);

    const upcomingRow = document.querySelector('#dashboardUpcoming .dash-wip-row');
    upcomingRow.focus();
    const token = App.Dashboard._captureFocus();

    App.Dashboard.renderPipeline([stage({ processId: 'P1' })]);
    render([stage({ processId: 'P1' })]);
    App.Dashboard._restoreFocus(token);

    expect(document.activeElement.closest('#dashboardUpcoming')).not.toBeNull();
  });
});

describe('dashboard stage load chart', () => {
  beforeEach(() => {
    mountPartial();
    loadDashboardAsGlobal();
  });

  const stage = (over) => Object.assign({
    processId: 'P1', processName: 'Rim Fitting', sequence: 1,
    totalQty: 100, totalLotCount: 1, oldestDays: 0, groups: [],
  }, over);

  const render = (pipeline, upcoming) => {
    App.Dashboard.renderStageChart(pipeline, upcoming);
    return document.getElementById('dashboardStageChart');
  };

  test('one column per stage, in process sequence, not in payload order', () => {
    const el = render(
      [stage({ processId: 'C', processName: 'Packing', sequence: 3 }),
        stage({ processId: 'A', processName: 'Cutting', sequence: 1 })],
      [stage({ processId: 'B', processName: 'Painting', sequence: 2 })],
    );
    const labels = Array.from(el.querySelectorAll('.dash-stage-col-label')).map(l => l.textContent);
    expect(labels).toEqual(['Cutting', 'Painting', 'Packing']);
  });

  test('a stage appearing in both lists is one column carrying both series', () => {
    const el = render(
      [stage({ processId: 'A', totalQty: 100, totalLotCount: 2 })],
      [stage({ processId: 'A', totalQty: 300, totalLotCount: 3 })],
    );
    expect(el.querySelectorAll('.dash-stage-col')).toHaveLength(1);
    const series = Array.from(el.querySelectorAll('.dash-stage-seg'))
      .map(seg => seg.getAttribute('data-series'));
    expect(series).toEqual(['wip', 'queued']);
    // Lot counts from both lists add up on the one column.
    expect(el.querySelector('.dash-stage-col').getAttribute('title')).toContain('5 lots');
  });

  test('both series share one axis, so segment heights are directly comparable', () => {
    // 100 running + 300 queued = 400 total, and _niceMax rounds that to 500.
    const el = render(
      [stage({ processId: 'A', totalQty: 100 })],
      [stage({ processId: 'A', totalQty: 300 })],
    );
    const heights = Array.from(el.querySelectorAll('.dash-stage-seg')).map(seg => seg.style.height);
    expect(heights).toEqual(['20.00%', '60.00%']);
  });

  test('the axis maximum is a round number, not the raw peak', () => {
    const el = render([stage({ processId: 'A', totalQty: 437 })], []);
    const ticks = Array.from(el.querySelectorAll('.dash-stage-tick')).map(t => t.textContent);
    expect(ticks).toEqual(['500', '250', '0']);
  });

  test('a stage with nothing in a series renders no segment for it', () => {
    // An empty segment would still take the 2px surface gap and draw a
    // hairline of colour along the baseline.
    const el = render([stage({ processId: 'A', totalQty: 100 })], []);
    const series = Array.from(el.querySelectorAll('.dash-stage-seg'))
      .map(seg => seg.getAttribute('data-series'));
    expect(series).toEqual(['wip']);
  });

  test('only the tallest column is value-labelled', () => {
    const el = render([
      stage({ processId: 'A', processName: 'Small', sequence: 1, totalQty: 50 }),
      stage({ processId: 'B', processName: 'Biggest', sequence: 2, totalQty: 400 }),
      stage({ processId: 'C', processName: 'Middle', sequence: 3, totalQty: 200 }),
    ], []);
    const labelled = el.querySelectorAll('.dash-stage-col-value');
    expect(labelled).toHaveLength(1);
    expect(labelled[0].textContent).toBe('400');
    expect(labelled[0].closest('.dash-stage-col').querySelector('.dash-stage-col-label').textContent)
      .toBe('Biggest');
    // The label rides the top of its own bar, so its offset is the column's
    // own share of the axis -- not a fixed row at the top of the plot.
    expect(labelled[0].style.bottom).toBe('80.00%');
  });

  test('two series always carry a legend -- identity is never colour alone', () => {
    const el = render([stage({ processId: 'A' })], [stage({ processId: 'A' })]);
    const legend = Array.from(el.querySelectorAll('.dash-stage-legend-item')).map(i => i.textContent.trim());
    expect(legend).toEqual(['In Progress', 'Pending']);
  });

  test('every column states its full breakdown in text, not only in bar height', () => {
    const el = render(
      [stage({ processId: 'A', processName: 'Painting', totalQty: 120, totalLotCount: 2 })],
      [stage({ processId: 'A', processName: 'Painting', totalQty: 80, totalLotCount: 1 })],
    );
    const col = el.querySelector('.dash-stage-col');
    expect(col.querySelector('.visually-hidden').textContent)
      .toBe('Painting: 120 in progress, 80 pending, 3 lots');
    expect(col.getAttribute('title')).toContain('120 in progress');
  });

  test('columns are real buttons carrying the stage drill-down', () => {
    const el = render([stage({ processId: 'P/1' })], []);
    const col = el.querySelector('.dash-stage-col');
    expect(col.tagName).toBe('BUTTON');
    expect(col.dataset.action).toBe('dash-pipeline-stage');
    expect(decodeURIComponent(col.dataset.processid)).toBe('P/1');
  });

  test('escapes process names rather than trusting them as markup', () => {
    const el = render([stage({ processName: '<img src=x onerror=alert(1)>' })], []);
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('.dash-stage-col-label').textContent).toBe('<img src=x onerror=alert(1)>');
  });

  test('no open work anywhere says so instead of drawing an empty axis', () => {
    const el = render([], []);
    expect(el.textContent).toMatch(/no open production lots/i);
    expect(el.querySelectorAll('.dash-stage-col')).toHaveLength(0);
  });

  test('stages that are all zero do not divide by a zero axis', () => {
    const el = render([stage({ processId: 'A', totalQty: 0 })], []);
    expect(el.querySelectorAll('.dash-stage-col')).toHaveLength(0);
    expect(el.textContent).toMatch(/no open production lots/i);
  });
});

describe('dashboard refresh scheduling', () => {
  beforeEach(() => {
    mountPartial();
    loadDashboardAsGlobal();
  });

  test('a dashboard that has never loaded is due immediately', () => {
    expect(App.Dashboard._msUntilDue()).toBe(0);
  });

  test('a just-loaded dashboard is due a full interval later', () => {
    App.Dashboard._lastLoadAt = Date.now();
    const due = App.Dashboard._msUntilDue();
    expect(due).toBeGreaterThan(App.Dashboard.REFRESH_INTERVAL_MS - 1000);
    expect(due).toBeLessThanOrEqual(App.Dashboard.REFRESH_INTERVAL_MS);
  });

  test('time spent hidden counts toward the interval', () => {
    // Away for two minutes of a five-minute interval: three left, not five.
    App.Dashboard._lastLoadAt = Date.now() - (2 * 60 * 1000);
    const due = App.Dashboard._msUntilDue();
    expect(due).toBeGreaterThan(2.9 * 60 * 1000);
    expect(due).toBeLessThan(3.1 * 60 * 1000);
  });

  test('a tab left hidden past the interval is due at once, not an interval later', () => {
    // The bug this fixes: returning after three hours used to arm a fresh
    // five-minute interval and keep showing three-hour-old numbers.
    App.Dashboard._lastLoadAt = Date.now() - (3 * 60 * 60 * 1000);
    expect(App.Dashboard._msUntilDue()).toBe(0);
  });
});

describe('dashboard focus preservation across refresh', () => {
  beforeEach(() => {
    mountPartial();
    loadDashboardAsGlobal();
  });

  const stages = names => names.map((n, i) => ({
    processId: `P${i}`, processName: n, sequence: i + 1,
    totalQty: 100, totalLotCount: 1,
    groups: [{ title: 'Unspecified', qty: 100, lotCount: 1 }],
  }));

  test('a re-render does destroy focus -- this is what is being repaired', () => {
    App.Dashboard.renderPipeline(stages(['Rim Fitting', 'Packing']));
    document.querySelector('.dash-wip-row').focus();
    expect(document.activeElement.classList.contains('dash-wip-row')).toBe(true);

    App.Dashboard.renderPipeline(stages(['Rim Fitting', 'Packing']));
    expect(document.activeElement).toBe(document.body);
  });

  test('focus returns to the same pipeline stage after a refresh', () => {
    App.Dashboard.renderPipeline(stages(['Rim Fitting', 'Mudguard Paint', 'Packing']));
    const rows = document.querySelectorAll('.dash-wip-row');
    rows[1].focus();

    const token = App.Dashboard._captureFocus();
    App.Dashboard.renderPipeline(stages(['Rim Fitting', 'Mudguard Paint', 'Packing']));
    App.Dashboard._restoreFocus(token);

    expect(document.activeElement.querySelector('.dash-wip-name').textContent).toBe('Mudguard Paint');
  });

  test('focus follows the stage even when the list reorders around it', () => {
    App.Dashboard.renderPipeline(stages(['Rim Fitting', 'Mudguard Paint', 'Packing']));
    document.querySelectorAll('.dash-wip-row')[2].focus();
    const token = App.Dashboard._captureFocus();

    // Same three stages, different order: P2 is now first.
    const reordered = [
      { processId: 'P2', processName: 'Packing', sequence: 1, totalQty: 100, totalLotCount: 1, groups: [] },
      { processId: 'P0', processName: 'Rim Fitting', sequence: 2, totalQty: 100, totalLotCount: 1, groups: [] },
    ];
    App.Dashboard.renderPipeline(reordered);
    App.Dashboard._restoreFocus(token);

    expect(document.activeElement.querySelector('.dash-wip-name').textContent).toBe('Packing');
  });

  test('a stage that disappears leaves focus on body rather than moving it somewhere arbitrary', () => {
    App.Dashboard.renderPipeline(stages(['Rim Fitting', 'Packing']));
    document.querySelectorAll('.dash-wip-row')[1].focus();
    const token = App.Dashboard._captureFocus();

    App.Dashboard.renderPipeline(stages(['Rim Fitting']));
    App.Dashboard._restoreFocus(token);

    expect(document.activeElement).toBe(document.body);
  });

  test('an id containing quotes and brackets does not throw', () => {
    // _restoreFocus matches by iterating precisely so a process id like
    // this cannot become a malformed querySelector.
    const nasty = 'P"1[weird]';
    App.Dashboard.renderPipeline([
      { processId: nasty, processName: 'Odd Id', sequence: 1, totalQty: 5, totalLotCount: 1, groups: [] },
    ]);
    document.querySelector('.dash-wip-row').focus();
    const token = App.Dashboard._captureFocus();

    App.Dashboard.renderPipeline([
      { processId: nasty, processName: 'Odd Id', sequence: 1, totalQty: 5, totalLotCount: 1, groups: [] },
    ]);
    expect(() => App.Dashboard._restoreFocus(token)).not.toThrow();
    expect(document.activeElement.querySelector('.dash-wip-name').textContent).toBe('Odd Id');
  });

  test('focus outside the redrawn regions is left alone', () => {
    // A hero tile is not rebuilt by a refresh, so it needs no restoring.
    document.getElementById('heroLowStock').focus();
    expect(App.Dashboard._captureFocus()).toBeNull();
  });

  test('capturing with nothing focused is a no-op, and restoring null is safe', () => {
    expect(App.Dashboard._captureFocus()).toBeNull();
    expect(() => App.Dashboard._restoreFocus(null)).not.toThrow();
  });

  test('focus returns to a Dispatch button in the ready-to-dispatch table', () => {
    const items = [{ productId: 'PRD-1', productName: 'Rider 14', readyQty: 12 }];
    App.Dashboard.renderReadyToDispatch(items, 1);
    document.querySelector('[data-action="dash-dispatch-product"]').focus();
    const token = App.Dashboard._captureFocus();

    App.Dashboard.renderReadyToDispatch(items, 1);
    App.Dashboard._restoreFocus(token);

    expect(document.activeElement.dataset.action).toBe('dash-dispatch-product');
    expect(decodeURIComponent(document.activeElement.dataset.productid)).toBe('PRD-1');
  });
});

describe('dashboard auto-refresh teardown', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mountPartial();
    loadDashboardAsGlobal();
    App.Dashboard.loadData = jest.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    App.Dashboard.stopAutoRefresh();
    jest.useRealTimers();
  });

  test('a visible dashboard arms exactly one pending timer', () => {
    App.Dashboard.startAutoRefresh();
    expect(App.Dashboard.refreshTimer).not.toBeNull();
    expect(jest.getTimerCount()).toBe(1);
  });

  test('the timer fires a load and re-arms itself', async () => {
    App.Dashboard._lastLoadAt = Date.now();
    App.Dashboard.startAutoRefresh();

    jest.advanceTimersByTime(App.Dashboard.REFRESH_INTERVAL_MS);
    await Promise.resolve();
    await Promise.resolve();

    expect(App.Dashboard.loadData).toHaveBeenCalledTimes(1);
    expect(App.Dashboard.refreshTimer).not.toBeNull();
  });

  test('stopAutoRefresh cancels the pending timer', () => {
    App.Dashboard.startAutoRefresh();
    App.Dashboard.stopAutoRefresh();
    expect(App.Dashboard.refreshTimer).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('navigating away mid-load does not re-arm a timer for the tab just left', async () => {
    // showTab calls stopAutoRefresh synchronously, but it cannot cancel a
    // loadData() promise already in flight -- without the _autoRefreshActive
    // guard that promise's .then() would schedule a fresh timer and the
    // dashboard would keep polling from a tab nobody is looking at.
    let finishLoad;
    App.Dashboard.loadData = jest.fn(() => new Promise(resolve => { finishLoad = resolve; }));

    App.Dashboard._lastLoadAt = Date.now();
    App.Dashboard.startAutoRefresh();
    jest.advanceTimersByTime(App.Dashboard.REFRESH_INTERVAL_MS);
    expect(App.Dashboard.loadData).toHaveBeenCalledTimes(1);

    App.Dashboard.stopAutoRefresh();   // user switches to another tab
    finishLoad();                      // the in-flight load lands afterwards
    await Promise.resolve();
    await Promise.resolve();

    expect(App.Dashboard._autoRefreshActive).toBe(false);
    expect(App.Dashboard.refreshTimer).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('re-entering the tab arms a single timer, not one per visit', () => {
    App.Dashboard.startAutoRefresh();
    App.Dashboard.stopAutoRefresh();
    App.Dashboard.startAutoRefresh();
    App.Dashboard.stopAutoRefresh();
    App.Dashboard.startAutoRefresh();
    expect(jest.getTimerCount()).toBe(1);
  });
});
