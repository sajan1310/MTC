/**
 * Phase 6 chaos tests for the mobile offline outbox (MApp.Outbox.flush()
 * in ../mobile.js), run against the REAL api.js/offline-cache.js/mobile.js
 * source -- not a hand-rolled reimplementation -- via fake-indexeddb for a
 * real IndexedDB and a scripted global.fetch for a real (if simulated)
 * network.
 *
 * Why eval() + a `const X = ` -> `global.X = ` string rewrite instead of
 * require(): these three files are plain classic browser scripts (no
 * module.exports), loaded via <script> tags / importScripts in production,
 * each declaring their public surface with a top-level `const`. A Node
 * `require()` executes a file in its own module scope where a top-level
 * `const` never leaks out -- same as eval() would, by spec -- so either
 * way the file's own top-level bindings need an explicit global assignment
 * to become visible to the test. Rewriting just the declaration keyword
 * (not the file's logic) keeps this a test of the real, unmodified
 * implementation.
 *
 * No Playwright/browser-automation tooling is available in this
 * environment (confirmed absent from package.json and node_modules, and
 * the repo's own Jest setup already only unit-tests plain JS, never a real
 * browser) -- so true multi-tab/airplane-mode/Background-Sync-event tests
 * aren't possible here. This is the closest faithful substitute: the real
 * client-side replay/error-classification logic exercised under a
 * scripted flaky network, without a browser.
 */

'use strict';

// jsdom's test environment (unlike every real browser) doesn't expose a
// global structuredClone, which fake-indexeddb needs to clone values on
// put()/add(). A JSON round-trip is an adequate substitute here -- every
// value this app ever stores in the outbox (mutation ids, method names,
// plain-object/array args) is already JSON-safe.
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
  eval(code);
}

describe('Phase 6 outbox chaos scenarios (real api.js + offline-cache.js + mobile.js)', () => {
  let scenarios;
  let callLog;

  beforeEach(() => {
    // Fresh IndexedDB per test -- fake-indexeddb/auto installs one global
    // instance; force offline-cache.js to open a brand new connection
    // instead of reusing a previous test's cached `dbPromise` closure.
    // (fake-indexeddb's main entry exports the factory as a named
    // `indexedDB` export, not as the module itself -- easy to get wrong.)
    jest.resetModules();
    global.indexedDB = require('fake-indexeddb').indexedDB;

    scenarios = [];
    callLog = [];
    global.fetch = jest.fn(async (url, opts) => {
      const body = JSON.parse(opts.body);
      callLog.push({ method: url.split('/').pop(), args: body.args, mutationId: opts.headers['X-Mutation-Id'] });
      const next = scenarios.shift();
      if (!next) throw new Error('test wired more calls than scripted scenarios');
      if (next.type === 'network-error') {
        throw new TypeError('Failed to fetch');
      }
      if (next.type === 'http-error') {
        return { ok: false, status: next.status || 400, json: async () => ({ success: false, message: next.message }) };
      }
      return { ok: true, status: 200, json: async () => next.body };
    });

    loadAsGlobal('api.js', 'Api');
    loadAsGlobal('offline-cache.js', 'OfflineCache');

    // mobile.js's top level does `MApp.Api = { call: Api.call, mutate:
    // Api.mutate }`, so Api must already be global by this point (it is,
    // via loadAsGlobal above). jsdom's `document` (Jest's default
    // testEnvironment) satisfies every DOM query mobile.js's module-level
    // code and MApp.Outbox itself touch -- all of them null-guarded.
    loadAsGlobal('mobile.js', 'MApp');
  });

  test('a mixed queue: business rejection, then success, then network failure -- one bad entry does not block the rest, network failure halts the remainder', async () => {
    const idRejected = Api.newMutationId();
    const idSucceeds = Api.newMutationId();
    const idNeverReached = Api.newMutationId();

    await OfflineCache.outbox.enqueue(idRejected, 'adjustStockManually', ['Widget', '', 15, '']);
    await OfflineCache.outbox.enqueue(idSucceeds, 'adjustStockManually', ['Gadget', '', 20, 'Recount']);
    await OfflineCache.outbox.enqueue(idNeverReached, 'adjustStockManually', ['Thing', '', 5, 'Recount']);

    scenarios = [
      { type: 'success', body: { success: false, message: 'A reason is required.' } }, // reached server, rejected
      { type: 'success', body: { success: true, data: { oldCurrentStock: 20, newCurrentStock: 20 } } },
      { type: 'network-error' }, // stops the loop -- third entry never gets this far
    ];

    await MApp.Outbox.flush();

    expect(callLog.length).toBe(3);
    expect(callLog[0].mutationId).toBe(idRejected);
    expect(callLog[1].mutationId).toBe(idSucceeds);
    expect(callLog[2].mutationId).toBe(idNeverReached);

    const remaining = await OfflineCache.outbox.listAll();
    const byId = Object.fromEntries(remaining.map(e => [e.mutationId, e]));

    expect(byId[idRejected].status).toBe('failed'); // business rejection -> failed, not retried automatically
    expect(byId[idRejected].lastError).toMatch(/reason/i);
    expect(byId[idSucceeds]).toBeUndefined(); // markDone deletes it
    expect(byId[idNeverReached].status).toBe('pending'); // never attempted -- stays queued for next trigger
  });

  test('an HTTP-level failure (e.g. expired CSRF token) is marked failed, not retried forever, and does not block the rest of the queue', async () => {
    const idStaleCsrf = Api.newMutationId();
    const idAfterIt = Api.newMutationId();

    await OfflineCache.outbox.enqueue(idStaleCsrf, 'saveDispatch', [{ some: 'formdata' }]);
    await OfflineCache.outbox.enqueue(idAfterIt, 'adjustStockManually', ['Widget', '', 10, 'Recount']);

    scenarios = [
      { type: 'http-error', status: 400, message: 'The CSRF token has expired.' },
      { type: 'success', body: { success: true, data: {} } },
    ];

    await MApp.Outbox.flush();

    const all = await OfflineCache.outbox.listAll();
    const byId = Object.fromEntries(all.map(e => [e.mutationId, e]));

    expect(byId[idStaleCsrf].status).toBe('failed');
    expect(byId[idStaleCsrf].lastError).toBe('The CSRF token has expired.');
    expect(byId[idAfterIt]).toBeUndefined(); // second entry still processed -- the HTTP failure didn't halt the loop like a network failure would
  });

  test('MApp.SyncIssues.retry() mints a fresh mutation_id -- a stale one would replay the same cached server-side rejection forever', async () => {
    const originalId = Api.newMutationId();
    await OfflineCache.outbox.enqueue(originalId, 'adjustStockManually', ['Widget', '', 15, '']);
    await OfflineCache.outbox.markFailed((await OfflineCache.outbox.listAll())[0].id, 'A reason is required.');

    const entryId = (await OfflineCache.outbox.listAll())[0].id;
    // retry() also fires MApp.Outbox.flush() immediately (fire-and-forget,
    // not awaited by retry() itself) -- script one harmless network-error
    // scenario for that attempt and give its promise chain a tick to
    // settle before asserting, so this test's own assertions don't race it.
    scenarios = [{ type: 'network-error' }];
    await MApp.SyncIssues.retry(entryId);
    await new Promise(resolve => setTimeout(resolve, 50));

    const after = await OfflineCache.outbox.listAll();
    expect(after[0].status).toBe('pending');
    expect(after[0].mutationId).not.toBe(originalId); // the whole point of this test
  });
});
