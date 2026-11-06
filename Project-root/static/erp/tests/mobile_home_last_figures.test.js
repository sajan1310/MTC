/**
 * Home shows the last figures it was given while the live ones load.
 *
 * Home used to stay skeletons until getMobileDashboard answered. On the cold
 * morning of 2026-11-06 the server took 66 and 117 s and then failed, so the
 * first screen of the day was blank, then an error. The copy callCached
 * keeps for offline use is now painted at once -- dimmed, its age after the
 * date -- and replaced in place by the live figures.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function loadAsGlobal(relPath, exportName) {
  const code = fs
    .readFileSync(path.join(__dirname, '..', relPath), 'utf8')
    .replace(new RegExp(`^const ${exportName} = `, 'm'), `global.${exportName} = `);
  eval(code);
}

const HOUR = 60 * 60 * 1000;

const STORED = {
  pendingProductionCount: 9, todaysDispatchCount: 6, lowStockCount: 1,
  recentActivity: [
    { type: 'production', title: 'LOT-1', subtitle: '5.0 unit(s) · Pending', dateRaw: '2026-11-05' },
  ],
};
const LIVE = {
  pendingProductionCount: 4, todaysDispatchCount: 2, lowStockCount: 3,
  recentActivity: [
    { type: 'production', title: 'LOT-2', subtitle: '3.0 unit(s) · Pending', dateRaw: '2026-11-06' },
  ],
};

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

let stored;
let live;

function setup({ storedAt = Date.now() - 2 * HOUR, storedResponse = { success: true, data: STORED } } = {}) {
  jest.resetModules();
  global.fetch = jest.fn();
  document.body.innerHTML = `
    <div id="mapp-sheet-backdrop"></div>
    <h1 id="home-greeting"></h1><div id="home-date"></div>
    <div id="home-stats"></div>
    <div id="home-activity"></div>
    <div class="mb-toast-stack" id="mapp-toast-stack"></div>`;
  try { localStorage.clear(); } catch (e) { /* ignore */ }
  loadAsGlobal('api.js', 'Api');
  loadAsGlobal('mobile.js', 'MApp');
  MApp.Sheet._stack = [];
  MApp.Home._full = null;

  stored = deferred();
  global.OfflineCache = {
    get: jest.fn(() => stored.promise),
    put: jest.fn(),
  };
  stored.storedAt = storedAt;
  stored.storedResponse = storedResponse;

  live = deferred();
  MApp.Api.callCached = jest.fn(() => live.promise);
  // The full dashboard: never answers in these tests, it is not their subject.
  MApp.Api.call = jest.fn(() => new Promise(() => {}));
}

const flush = () => new Promise(r => setTimeout(r, 0));
const tileValue = label => {
  const tile = [...document.querySelectorAll('#home-blocks .mb-stat-tile')]
    .find(t => t.querySelector('.mb-stat-tile-label').textContent === label);
  return tile ? tile.querySelector('.mb-stat-tile-value').textContent : null;
};
const note = () => (document.querySelector('#home-date .mapp-home-freshness') || {}).textContent || '';
const stale = () => document.getElementById('home-stats').classList.contains('mapp-home-stale');
const giveStored = () => stored.resolve(stored.storedResponse
  ? { response: stored.storedResponse, cachedAt: stored.storedAt }
  : null);

afterEach(() => {
  delete global.OfflineCache;
  delete global.fetch;
});

test('the last figures are on screen before the server answers', async () => {
  setup();
  MApp.Home.mount();
  giveStored();
  await flush();

  expect(tileValue('Pending production')).toBe('9');
  expect(tileValue('Low-stock alerts')).toBe('1');
  expect(stale()).toBe(true);
  expect(note()).toBe(' · figures from 2h ago, updating…');
  expect(document.getElementById('home-activity').textContent).toContain('LOT-1');
});

test('the live figures replace them in place, undimmed, without the note', async () => {
  setup();
  const done = MApp.Home.mount();
  giveStored();
  await flush();
  live.resolve({ success: true, data: LIVE });
  await flush();
  void done;

  expect(tileValue('Pending production')).toBe('4');
  expect(tileValue('Today’s dispatches')).toBe('2');
  expect(stale()).toBe(false);
  expect(note()).toBe('');
  const rows = [...document.querySelectorAll('#home-activity .mb-card')];
  expect(rows.map(r => r.textContent)).toEqual([expect.stringContaining('LOT-2')]);
  // Already in place, so no second entrance animation.
  expect(rows[0].classList.contains('mb-stagger-in')).toBe(false);
});

test('a copy from an earlier day does not pass yesterday off as today', async () => {
  setup({ storedAt: Date.now() - 30 * HOUR });
  MApp.Home.mount();
  giveStored();
  await flush();

  expect(tileValue('Today’s dispatches')).toBe('—');
  expect(tileValue('Pending production')).toBe('9');
});

test('a copy from earlier today does show its dispatch count', async () => {
  // Within the same calendar day whatever the hour the test runs at.
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 1, 0);
  setup({ storedAt: startOfToday.getTime() });
  MApp.Home.mount();
  giveStored();
  await flush();

  expect(tileValue('Today’s dispatches')).toBe('6');
});

test('when the live figures fail, the last ones stay up, labelled, with a retry', async () => {
  setup();
  const done = MApp.Home.mount();
  giveStored();
  await flush();
  live.resolve({ success: false, message: 'The server is busy.' });
  await done;

  expect(tileValue('Pending production')).toBe('9');
  expect(note()).toBe(' · figures could not be updated');
  expect(document.getElementById('home-stats').querySelector('.mb-error, [data-retry], button.mb-btn')).toBeNull();
  const toast = document.getElementById('mapp-toast-stack').textContent;
  expect(toast).toContain('The server is busy.');
  expect(toast).toContain('Retry');
});

test('with nothing stored, a failure is the error it always was', async () => {
  setup({ storedResponse: null });
  const done = MApp.Home.mount();
  giveStored();
  await flush();
  expect(stale()).toBe(false);
  live.resolve({ success: false, message: 'The server is busy.' });
  await done;

  expect(document.getElementById('home-stats').textContent).toContain('The server is busy.');
  expect(note()).toBe('');
});

test('a stored copy that arrives after the live figures is not painted over them', async () => {
  setup();
  MApp.Home.mount();
  live.resolve({ success: true, data: LIVE });
  await flush();
  giveStored();
  await flush();

  expect(tileValue('Pending production')).toBe('4');
  expect(stale()).toBe(false);
  expect(note()).toBe('');
});

test('a stored failure is never painted', async () => {
  setup({ storedResponse: { success: false, message: 'old error' } });
  MApp.Home.mount();
  giveStored();
  await flush();

  expect(stale()).toBe(false);
  expect(document.querySelector('#home-blocks')).toBeNull();
});
