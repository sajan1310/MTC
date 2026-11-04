/**
 * A stock count saved on the phone with no signal waits in the outbox and
 * reaches the server later -- sometimes hours later. It has to take effect
 * when the shelf was counted, not when it arrived, or everything entered in
 * between is swallowed by it. So a queued count carries the moment it was
 * made (adjustStockManually's fifth argument, stock_service.
 * _queued_count_moment), and a live save leaves the moment to the server's
 * clock, sending the four arguments it always has.
 *
 * Run against the real api.js, offline-cache.js and mobile.js, as
 * outbox_chaos.test.js is.
 */

'use strict';

if (typeof structuredClone === 'undefined') {
  global.structuredClone = obj => JSON.parse(JSON.stringify(obj));
}

require('fake-indexeddb/auto');
const fs = require('fs');
const path = require('path');

function loadAsGlobal(relPath, exportName) {
  const code = fs
    .readFileSync(path.join(__dirname, '..', relPath), 'utf8')
    .replace(new RegExp(`^const ${exportName} = `, 'm'), `global.${exportName} = `);
  // eslint-disable-next-line no-eval
  eval(code);
}

let calls;
let network;

beforeEach(() => {
  jest.resetModules();
  global.indexedDB = require('fake-indexeddb').indexedDB;
  calls = [];
  network = 'up';
  global.fetch = jest.fn(async (url, opts) => {
    calls.push({ method: url.split('/').pop(), args: JSON.parse(opts.body).args });
    if (network === 'down') throw new TypeError('Failed to fetch');
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { oldCurrentStock: 50, newCurrentStock: 40 } })
    };
  });

  loadAsGlobal('api.js', 'Api');
  loadAsGlobal('offline-cache.js', 'OfflineCache');
  loadAsGlobal('mobile.js', 'MApp');

  document.body.innerHTML = `
    <input id="stock-adjust-new-value" value="40">
    <input id="stock-adjust-reason" value="Recount">`;
  MApp.Stock._adjustItem = { name: 'BB-AXLE 2-C', size: '' };
  MApp.Stock.closeAdjustSheet = jest.fn();
  MApp.Stock.load = jest.fn();
});

describe("a phone count's moment", () => {
  test('a count queued offline carries when it was made', async () => {
    network = 'down';
    const before = Date.now();

    await MApp.Stock.submitAdjust();

    const [entry] = await OfflineCache.outbox.listAll();
    expect(entry.method).toBe('adjustStockManually');
    expect(entry.args.slice(0, 4)).toEqual(['BB-AXLE 2-C', '', 40, 'Recount']);
    const countedAt = Date.parse(entry.args[4]);
    expect(entry.args[4]).toMatch(/Z$/);
    expect(countedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(countedAt).toBeLessThanOrEqual(Date.now());
  });

  test('replaying the queue sends that moment, unchanged', async () => {
    network = 'down';
    await MApp.Stock.submitAdjust();
    const [entry] = await OfflineCache.outbox.listAll();

    network = 'up';
    await MApp.Outbox.flush();

    const replay = calls[calls.length - 1];
    expect(replay.args).toEqual(entry.args);
    expect(await OfflineCache.outbox.listAll()).toEqual([]);
  });

  test('a live save sends the four arguments it always has', async () => {
    await MApp.Stock.submitAdjust();

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['BB-AXLE 2-C', '', 40, 'Recount']);
    expect(await OfflineCache.outbox.listAll()).toEqual([]);
  });
});
