/**
 * The dashboard's WIP cards, grouped by the date each lot was logged.
 *
 * A stage's card used to merge every lot at that stage, whatever its date,
 * and the cards ran in process sequence -- so a lot waiting since last week
 * sat in the same card as one logged this morning, and the stage's age
 * badge was the only clue that anything there was old. Now each status's
 * cards sit under one heading per date, oldest first (the user's call,
 * 2026-10-01: in a queue, what has waited longest is what to start or chase
 * first).
 *
 * Mounted from the real partial with the real core.js and dashboard.js;
 * the payload is shaped as dashboard_service.get_dashboard_data sends it.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function load() {
  document.body.innerHTML = fs
    .readFileSync(path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', 'dashboard.html'), 'utf8')
    .replace(/\{%[^%]*%\}/g, '');
  // eslint-disable-next-line no-eval
  eval([
    read('api.js').replace(/^const Api = /m, 'global.Api = '),
    'global.escapeHtml = escapeHtml;',
    'global.toNumber = toNumber;',
    'global.formatQty = formatQty;',
    'global.formatCurrency = formatCurrency;',
    'global.todayIso = todayIso;'
  ].join('\n'));
  // eslint-disable-next-line no-eval
  eval([
    read('core.js').replace(/^const App = /m, 'global.App = '),
    'global.$ = $;',
    'global.$$ = $$;'
  ].join('\n'));
  // eslint-disable-next-line no-eval
  eval(read('dashboard.js'));
}

const stage = over => Object.assign({
  processId: 'P1', processName: 'Rim Fitting 14 inch', processType: 'Fitting', sequence: 1,
  totalQty: 70, totalLotCount: 1, oldestDays: 0,
  groups: [{ title: 'Black', qty: 70, lotCount: 1 }]
}, over);

// Pending: three lots four days old, two from today, and one stage
// (Packing Crysta 20) with a lot on each date.
const UPCOMING = [
  stage({ processId: 'P1', processName: 'Rim Fitting 14 inch', sequence: 1, totalQty: 70 }),
  stage({ processId: 'P5', processName: 'Packing Runway IBC 24 inch', sequence: 13, totalQty: 30, oldestDays: 4 }),
  stage({ processId: 'P6', processName: 'Packing Crysta 20 inch', sequence: 11, totalQty: 80, totalLotCount: 2, oldestDays: 4 })
];
const UPCOMING_BY_DATE = [
  { date: '2026-09-27', ageDays: 4, totalQty: 60, totalLotCount: 2, stages: [
    stage({ processId: 'P6', processName: 'Packing Crysta 20 inch', sequence: 11, totalQty: 30, oldestDays: 4 }),
    stage({ processId: 'P5', processName: 'Packing Runway IBC 24 inch', sequence: 13, totalQty: 30, oldestDays: 4 })
  ] },
  { date: '2026-09-30', ageDays: 1, totalQty: 50, totalLotCount: 1, stages: [
    stage({ processId: 'P6', processName: 'Packing Crysta 20 inch', sequence: 11, totalQty: 50, oldestDays: 1 })
  ] },
  { date: '2026-10-01', ageDays: 0, totalQty: 70, totalLotCount: 1, stages: [
    stage({ processId: 'P1', processName: 'Rim Fitting 14 inch', sequence: 1, totalQty: 70, oldestDays: 0 })
  ] }
];

const upcoming = () => document.getElementById('dashboardUpcoming');
const headings = el => [...el.querySelectorAll('.dash-wip-day-head')]
  .map(h => h.textContent.replace(/\s+/g, ' ').trim());

beforeEach(() => {
  jest.resetModules();
  load();
});

afterEach(() => {
  delete global.App;
});

describe('WIP cards by date', () => {
  test('each date gets its own heading, in the order the server sends them -- oldest first', () => {
    App.Dashboard.renderUpcoming(UPCOMING, UPCOMING_BY_DATE);

    expect(headings(upcoming())).toEqual([
      '27 Sep 2026 4d waiting 4 days 60 units · 2 lots',
      'Yesterday 30 Sep 2026 50 units · 1 lot',
      'Today 1 Oct 2026 70 units · 1 lot'
    ]);
  });

  test('a card sits under the date its lots were logged, and a stage on two dates has a card on each', () => {
    App.Dashboard.renderUpcoming(UPCOMING, UPCOMING_BY_DATE);

    const days = [...upcoming().querySelectorAll('.dash-wip-day')].map(day =>
      [...day.querySelectorAll('.dash-wip-card .dash-wip-name')].map(n => n.textContent));
    expect(days).toEqual([
      ['Packing Crysta 20 inch', 'Packing Runway IBC 24 inch'],
      ['Packing Crysta 20 inch'],
      ['Rim Fitting 14 inch']
    ]);
    const crysta = [...upcoming().querySelectorAll('.dash-wip-card[data-processid="P6"] .dash-wip-qty')]
      .map(q => q.textContent);
    expect(crysta).toEqual(['30 units', '50 units']);
  });

  test('the summary line still counts the whole status, once', () => {
    App.Dashboard.renderUpcoming(UPCOMING, UPCOMING_BY_DATE);

    const summary = upcoming().querySelector('.dash-wip-summary').textContent.replace(/\s+/g, ' ');
    expect(summary).toContain('180 units queued');
    expect(summary).toContain('4 lots');
    expect(summary).toContain('across 3 stages');
  });

  test('the age moves onto the date heading, coloured as before, and off the cards', () => {
    const old = [{ ...UPCOMING_BY_DATE[0], ageDays: 16 }];
    App.Dashboard.renderUpcoming(UPCOMING, old);

    const badge = upcoming().querySelector('.dash-wip-day-head .dash-wip-age');
    expect(badge.getAttribute('data-status')).toBe('critical');
    expect(badge.textContent).toContain('16d');
    expect(upcoming().querySelectorAll('.dash-wip-card .dash-wip-age')).toHaveLength(0);
  });

  test('the longest queue is still the stage with the most units overall, on each of its cards', () => {
    App.Dashboard.renderUpcoming(UPCOMING, UPCOMING_BY_DATE);

    const flagged = [...upcoming().querySelectorAll('.dash-wip-card')]
      .filter(card => card.querySelector('.dash-wip-peak'))
      .map(card => card.dataset.processid);
    // Packing Crysta 20 holds 80 across two dates, more than any other stage,
    // though neither of its days is the biggest single card.
    expect(flagged).toEqual(['P6', 'P6']);
  });

  test('each date\'s grid is labelled by its heading, and keeps the list\'s variant', () => {
    App.Dashboard.renderUpcoming(UPCOMING, UPCOMING_BY_DATE);

    upcoming().querySelectorAll('.dash-wip-grid').forEach(grid => {
      expect(grid.getAttribute('data-variant')).toBe('upcoming');
      expect(document.getElementById(grid.getAttribute('aria-labelledby'))).not.toBeNull();
    });
  });

  test('focus comes back to the same date\'s card for a stage that has two', () => {
    App.Dashboard.renderUpcoming(UPCOMING, UPCOMING_BY_DATE);
    const second = upcoming().querySelectorAll('.dash-wip-card[data-processid="P6"]')[1];
    second.focus();
    const token = App.Dashboard._captureFocus();

    App.Dashboard.renderUpcoming(UPCOMING, UPCOMING_BY_DATE);
    App.Dashboard._restoreFocus(token);

    expect(document.activeElement.dataset.day).toBe('2026-09-30');
  });

  test('In Progress is grouped the same way, in its own container', () => {
    App.Dashboard.renderPipeline([stage({ processId: 'P9', processName: 'Fitting Frame 16 inch' })], [
      { date: '2026-09-29', ageDays: 2, totalQty: 70, totalLotCount: 1,
        stages: [stage({ processId: 'P9', processName: 'Fitting Frame 16 inch', oldestDays: 2 })] }
    ]);

    const pipeline = document.getElementById('dashboardPipeline');
    expect(headings(pipeline)).toEqual(['29 Sep 2026 2d logged 2 days ago 70 units · 1 lot']);
    expect(pipeline.querySelector('.dash-wip-grid').getAttribute('data-variant')).toBe('wip');
    expect(upcoming().querySelector('.dash-wip-day')).toBeNull();
  });

  test('a payload without dates still draws the single grid it always did', () => {
    App.Dashboard.renderUpcoming(UPCOMING);

    expect(upcoming().querySelector('.dash-wip-day')).toBeNull();
    expect(upcoming().querySelectorAll('.dash-wip-grid')).toHaveLength(1);
    expect(upcoming().querySelectorAll('.dash-wip-card .dash-wip-age')).toHaveLength(3);
  });

  test('loadData hands each list its dates', async () => {
    Api.call = jest.fn(async () => ({
      success: true,
      data: {
        kpis: {}, pipeline: [], pipelineByDate: [], upcoming: UPCOMING, upcomingByDate: UPCOMING_BY_DATE,
        productionStatusBreakdown: [], dispatchTrend: [], lowStockItems: [], contractorPayables: [],
        readyToDispatchItems: []
      }
    }));
    App.Dashboard.ensureChartLib = () => Promise.resolve();

    await App.Dashboard.loadData();

    expect(upcoming().querySelectorAll('.dash-wip-day')).toHaveLength(3);
  });
});
