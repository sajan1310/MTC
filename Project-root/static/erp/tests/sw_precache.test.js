/**
 * Service worker install is resilient to one missing asset (REL-002).
 *
 * Both workers installed with `cache.addAll(PRECACHE_URLS)`. addAll is
 * atomic: a single 404, or a single dropped connection, rejects the whole
 * promise, the install fails, and the service worker never activates -- so
 * the application has NO offline support at all.
 *
 * That failure is silent (nothing surfaces a failed install to the user) and
 * intermittent (it depends on the network at the instant of install). The
 * desktop list holds ~45 URLs, so the chance of one failing is not small and
 * the blast radius is everything.
 *
 * Now each URL is fetched independently and the results settled, so one
 * missing font costs that font. The handful of assets the offline shell
 * genuinely cannot work without are still required, because activating a
 * worker that cannot serve the offline page helps nobody -- and rejecting
 * lets the browser retry the install later.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Evaluate a service worker with a fake global scope and return the handlers
 * it registered, plus the cache it talked to.
 *
 * `failing` is the set of URLs whose cache.add should reject.
 */
function loadWorker(file, failing = new Set()) {
  const listeners = {};
  const added = [];
  const cache = {
    add(url) {
      added.push(url);
      return failing.has(url)
        ? Promise.reject(new Error('404'))
        : Promise.resolve();
    },
    addAll(urls) {
      // Present so that a regression back to addAll is visible as a call
      // here rather than as an undefined-function crash.
      urls.forEach(u => added.push(u));
      const bad = urls.filter(u => failing.has(u));
      return bad.length
        ? Promise.reject(new Error('addAll failed: ' + bad[0]))
        : Promise.resolve();
    },
  };

  const scope = {
    addEventListener: (name, fn) => { listeners[name] = fn; },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
    registration: {},
  };

  const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const sandbox = {
    self: scope,
    caches: {
      open: () => Promise.resolve(cache),
      keys: () => Promise.resolve([]),
      delete: () => Promise.resolve(true),
      match: () => Promise.resolve(undefined),
    },
    console: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
    // mobile-sw.js pulls in offline-cache.js and api.js at the top. Neither
    // participates in install, and evaluating them here would drag the whole
    // outbox into a test about precaching -- so it is a no-op.
    importScripts: () => {},
    fetch: () => Promise.resolve({ ok: true }),
    Response: function Response() {},
    URL: global.URL,
    Promise,
    Error,
  };
  // eslint-disable-next-line no-new-func
  new Function(
    'self', 'caches', 'console', 'fetch', 'Response', 'URL', 'importScripts', src,
  )(
    sandbox.self, sandbox.caches, sandbox.console, sandbox.fetch,
    sandbox.Response, sandbox.URL, sandbox.importScripts,
  );

  return { listeners, added, cache, warn: sandbox.console.warn };
}

/** Drive an install event and report whether waitUntil's promise settled. */
function install(worker) {
  let captured;
  worker.listeners.install({ waitUntil: p => { captured = p; } });
  return captured;
}

describe.each([
  ['sw.js', '/erp/offline.html', '/static/erp/styles.css'],
  ['mobile-sw.js', '/erp/mobile/offline.html', '/static/erp/mobile_styles.css'],
])('%s install', (file, offlinePage, offlineStyles) => {
  test('installs cleanly when every asset is available', async () => {
    const worker = loadWorker(file);
    await expect(install(worker)).resolves.toBeUndefined();  // i.e. it resolves
    expect(worker.added.length).toBeGreaterThan(0);
  });

  test('a single missing asset does not fail the install', async () => {
    // THE regression test. Under addAll this rejects and the worker never
    // activates, leaving the app with no offline support whatsoever.
    const worker = loadWorker(file, new Set(['/static/erp/icons/icon-512.png']));
    await expect(install(worker)).resolves.toBeUndefined();  // i.e. it resolves
  });

  test('the assets that did work are still cached', async () => {
    const worker = loadWorker(file, new Set(['/static/erp/icons/icon-512.png']));
    await install(worker);
    expect(worker.added).toContain(offlinePage);
    expect(worker.added.length).toBeGreaterThan(1);
  });

  test('a failure is reported rather than swallowed', async () => {
    const worker = loadWorker(file, new Set(['/static/erp/icons/icon-512.png']));
    await install(worker);
    expect(worker.warn).toHaveBeenCalled();
  });

  test('the offline page missing DOES fail the install', async () => {
    // Nothing worth activating: the fetch handler's whole fallback is this
    // page. Rejecting lets the browser retry later instead of leaving a
    // worker in place that cannot do its job.
    const worker = loadWorker(file, new Set([offlinePage]));
    await expect(install(worker)).rejects.toThrow(/critical/i);
  });

  test('the offline stylesheet missing DOES fail the install', async () => {
    const worker = loadWorker(file, new Set([offlineStyles]));
    await expect(install(worker)).rejects.toThrow(/critical/i);
  });

  test('install does not use cache.addAll', async () => {
    // addAll is the atomic call this finding is about. Catching a regression
    // by behaviour rather than by reading the source.
    const worker = loadWorker(file);
    const spy = jest.spyOn(worker.cache, 'addAll');
    await install(worker);
    expect(spy).not.toHaveBeenCalled();
  });

  test('several missing assets still leave the shell installable', async () => {
    const worker = loadWorker(file, new Set([
      '/static/erp/icons/icon-192.png',
      '/static/erp/icons/icon-512.png',
      '/static/erp/api.js',
    ]));
    await expect(install(worker)).resolves.toBeUndefined();  // i.e. it resolves
  });
});

// ── Cache version discipline ──────────────────────────────────────────────
// /static/erp/* is served CACHE-FIRST with no revalidation, so an installed
// client keeps whatever copy of a JS or CSS file it already has until
// CACHE_NAME changes. Shipping a static-asset change without bumping it is
// therefore invisible in every test and every local reload, and shows up
// only as "the feature does nothing" for users who already had the app open.
// That has now happened repeatedly -- see the v32/v36/v37/v43 entries in
// sw.js, each of which documents the same incident.
//
// Nothing here can know whether the CURRENT commit touched a cached asset;
// that is a review question. What these do pin is that the constant and the
// bump log stay in step, so a bump can never be silently half-done.
describe('service worker cache version', () => {
  const SW = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');

  const CONSTANT = /const CACHE_NAME = 'erp-shell-v(\d+)'/;
  const LOG_ENTRY = /^\/\/ v(\d+): *(.*)$/gm;

  const logEntries = () => [...SW.matchAll(LOG_ENTRY)];

  test('CACHE_NAME matches the highest version in the bump log', () => {
    const versions = logEntries().map(m => Number(m[1]));
    expect(versions.length).toBeGreaterThan(0);
    expect(Number(CONSTANT.exec(SW)[1])).toBe(Math.max(...versions));
  });

  test('every bump is logged once, with a reason', () => {
    // A bare version bump tells the next person nothing about what went
    // stale or why, which is precisely what these entries are for.
    const entries = logEntries();
    const versions = entries.map(m => Number(m[1]));

    expect(new Set(versions).size).toBe(versions.length);
    entries.forEach(m => expect(m[2].trim().length).toBeGreaterThan(20));
  });

  test('core.js is precached, so a change to it always needs a bump', () => {
    // The file most likely to be edited without anyone thinking about the
    // service worker, and the one whose staleness breaks the most.
    expect(SW).toContain("'/static/erp/core.js'");
  });
});
