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
function loadWorker(file, failing = new Set(), cached = new Map()) {
  const listeners = {};
  const added = [];
  const put = [];
  const fetched = [];
  const cache = {
    put(req, res) {
      put.push(req.url || req);
      return Promise.resolve(res);
    },
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
    location: { origin: 'https://erp.test' },
  };

  const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const sandbox = {
    self: scope,
    caches: {
      open: () => Promise.resolve(cache),
      keys: () => Promise.resolve([]),
      delete: () => Promise.resolve(true),
      match: req => Promise.resolve(cached.get(req.url || req)),
    },
    console: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
    // mobile-sw.js pulls in offline-cache.js and api.js at the top. Neither
    // participates in install, and evaluating them here would drag the whole
    // outbox into a test about precaching -- so it is a no-op.
    importScripts: () => {},
    fetch: req => {
      const url = (req && req.url) || req;
      fetched.push(url);
      return failing.has(url)
        ? Promise.reject(new Error('offline'))
        : Promise.resolve({ ok: true, url, clone: () => ({ body: url }) });
    },
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

  return { listeners, added, cache, put, fetched, warn: sandbox.console.warn };
}

/** Drive an install event and report whether waitUntil's promise settled. */
function install(worker) {
  let captured;
  worker.listeners.install({ waitUntil: p => { captured = p; } });
  return captured;
}

/**
 * The URL a worker actually precaches a shell asset under.
 *
 * mobile-sw.js appends ?v=<n> (from its own CACHE_NAME) to the scripts and
 * stylesheet, matching what pages.py renders into mobile.html -- that is
 * what stops a deploy pairing new HTML with an old cached script. The
 * critical-asset check is an exact-string membership test, so a test naming
 * the bare path would stop matching and quietly assert nothing.
 *
 * Derived from the worker's own source rather than restated here, so this
 * keeps testing the real URL whether or not a given worker versions.
 */
function precachedUrl(file, pathname) {
  const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const version = (src.match(/CACHE_NAME\s*=\s*['"][a-z-]+-v(\d+)['"]/) || ['', null])[1];
  return src.includes('ASSET_V') && version ? `${pathname}?v=${version}` : pathname;
}

describe.each([
  ['sw.js', '/erp/offline.html', '/static/erp/styles.css'],
  ['mobile-sw.js', '/erp/mobile/offline.html', '/static/erp/mobile_styles.css'],
])('%s install', (file, offlinePage, stylesPath) => {
  const offlineStyles = precachedUrl(file, stylesPath);
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


/** Drive a fetch event and hand back what the worker did with it. */
function fireFetch(worker, url, { method = 'GET', mode = 'no-cors' } = {}) {
  let responded;
  const waited = [];
  worker.listeners.fetch({
    request: { url, method, mode },
    respondWith: p => { responded = p; },
    waitUntil: p => { waited.push(p); },
  });
  return { responded, waited };
}

/**
 * /static/erp/ is stale-while-revalidate, not cache-first-forever.
 *
 * It used to be the latter: an installed client kept its copy of every shell
 * asset until a CACHE_NAME bump wiped the cache, so a forgotten or mistimed
 * bump stranded users on old JavaScript indefinitely. v32, v36, v37 and v43
 * in the bump log are all that same incident, and the v44/v45 round hit it
 * again -- a Warehouse Pool ledger fixed and verified server-side still came
 * up empty in the browser, which was running neither the old file nor the new
 * one but a cached copy from in between.
 */
describe('sw.js static assets are revalidated', () => {
  const ASSET = 'https://erp.test/static/erp/stock.js';

  test('a cached asset is still served from cache', async () => {
    const worker = loadWorker('sw.js', new Set(), new Map([[ASSET, { body: 'cached' }]]));
    const { responded } = fireFetch(worker, ASSET);
    await expect(responded).resolves.toEqual({ body: 'cached' });
  });

  test('...and is refetched in the background so the next load is current', async () => {
    const worker = loadWorker('sw.js', new Set(), new Map([[ASSET, { body: 'cached' }]]));
    const { responded, waited } = fireFetch(worker, ASSET);
    await responded;
    // The revalidation must be held open by waitUntil, or the browser is
    // free to kill the worker the moment the cached copy is returned and
    // the update never lands.
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
    expect(worker.fetched).toContain(ASSET);
    expect(worker.put).toContain(ASSET);
  });

  test('a cache miss is served from the network and cached', async () => {
    const worker = loadWorker('sw.js');
    const { responded } = fireFetch(worker, ASSET);
    await responded;
    expect(worker.fetched).toContain(ASSET);
    expect(worker.put).toContain(ASSET);
  });

  test('a failed revalidation still serves the cached copy', async () => {
    // Offline, or the server down: serving what we have is the right
    // outcome, so waitUntil must not reject either.
    const worker = loadWorker('sw.js', new Set([ASSET]), new Map([[ASSET, { body: 'cached' }]]));
    const { responded, waited } = fireFetch(worker, ASSET);
    await expect(responded).resolves.toEqual({ body: 'cached' });
    await expect(Promise.all(waited)).resolves.toBeDefined();
  });

  test('RPC posts are never intercepted', () => {
    const worker = loadWorker('sw.js');
    const { responded } = fireFetch(worker, 'https://erp.test/api/erp/rpc/getWarehousePoolLedger',
      { method: 'POST' });
    expect(responded).toBeUndefined();
  });
});
// ── The shell and its worker must agree on the asset URLs ──────────────
//
// A deploy used to leave every installed phone running NEW HTML against OLD
// JavaScript. The two halves of the shell are cached differently and always
// have been: navigations are network-first, so the markup updates the
// instant it ships, while /static/erp/* is cache-first with no
// revalidation, so the script does not. The phone then ran new markup
// through a script that had never heard of it -- one good deploy presenting
// as four separate bugs (a dead add-bill form, missing charts, a missing
// threshold editor) until the operator happened to accept a reload prompt.
//
// ?v=<n> fixes that only while three things stay in step: the worker's
// CACHE_NAME, the URLs the worker precaches, and the URLs mobile.html asks
// for. Any two of them agreeing is not enough, so all three are asserted.
describe('the mobile shell is cache-busted in step with its worker', () => {
  const SHELL_ASSETS = ['mobile.js', 'api.js', 'offline-cache.js', 'mobile_styles.css'];
  const readRepo = (...parts) =>
    fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

  const SW = readRepo('mobile-sw.js');
  const HTML = readRepo('..', '..', 'templates', 'erp', 'mobile.html');
  const PAGES = readRepo('..', '..', 'app', 'erp', 'pages.py');
  const VERSION = (SW.match(/CACHE_NAME\s*=\s*['"][a-z-]+-v(\d+)['"]/) || ['', null])[1];

  test('the version is readable at all', () => {
    // Everything below is vacuous without it.
    expect(VERSION).toMatch(/^\d+$/);
  });

  test('the worker precaches its scripts and stylesheet under ?v=', async () => {
    const worker = loadWorker('mobile-sw.js');
    await install(worker);
    SHELL_ASSETS.forEach(asset => {
      expect(worker.added).toContain(`/static/erp/${asset}?v=${VERSION}`);
    });
  });

  test('and never under the bare path, which nothing would request', async () => {
    // A bare entry is not harmless: it fills the cache with a file the page
    // never asks for, while the versioned URL it DOES ask for is absent --
    // so the shell stops working offline.
    const worker = loadWorker('mobile-sw.js');
    await install(worker);
    SHELL_ASSETS.forEach(asset => {
      expect(worker.added).not.toContain(`/static/erp/${asset}`);
    });
  });

  test('mobile.html asks for every one of them with the same query', () => {
    // One un-busted script is enough to reintroduce the bug.
    SHELL_ASSETS.forEach(asset => {
      expect(HTML).toContain(`erp/${asset}') }}?v={{ asset_v }}`);
    });
  });

  test('pages.py reads that version from the worker, not a second copy', () => {
    // One number to bump. A hand-maintained constant here would drift from
    // CACHE_NAME silently, and the symptom would be the original bug back
    // again -- with the cache-bump CI job still green.
    expect(PAGES).toContain('mobile-sw.js');
    expect(PAGES).toMatch(/CACHE_NAME/);
    expect(PAGES).toMatch(/asset_v/);
  });

  test('the icons stay unversioned -- they are not part of the shell', async () => {
    // They are referenced from the web manifest, which this version has no
    // say over, so busting them here would only guarantee a cache miss.
    const worker = loadWorker('mobile-sw.js');
    await install(worker);
    expect(worker.added).toContain('/static/erp/icons/icon-192.png');
  });
});
