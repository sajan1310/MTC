/**
 * The first screen's figures are asked for before the page has been read.
 *
 * The Dashboard (desktop) and Home (phone, tablet) show figures the server
 * takes 0.4-1 s to work out, and the request for them used to go out only
 * after the whole page and every script had been read and run -- about a
 * second in on an office PC or a budget phone (lab, 2026-11-14) -- and on the
 * phone shell the second request waited for the first.
 *
 * Each page now sends that request inline, as a plain fetch, the same POST
 * api.js sends, and leaves it in window.__erpEarlyCalls. api.js stays where
 * it always was; its Api.call takes the early answer when the screen asks
 * (_takeEarly / _fromEarly), on the read cache's own terms, and asks again
 * itself whenever the early answer is anything but plain.
 *
 * Where the inline script sits was measured, not chosen: api.js in the
 * <head> held the phone's first paint back by 50-150 ms, the fetch before
 * the stylesheets took the connections they need on a first visit (+140 ms),
 * and in the <head> at all it let the browser draw an empty frame first. On
 * the phone page it goes straight after the top bar; on the desktop page,
 * which shows nothing until all its scripts have run, at the end of <head>.
 *
 * The inline scripts sit in the templates, ahead of the code that owns the
 * rules they follow, so they repeat a storage key, method names and the
 * shape of the request on purpose. Duplication that is checked is a
 * tradeoff; these are the checks.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const TEMPLATE = name => fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'templates', 'erp', name), 'utf8');
const SOURCE = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

const DESKTOP = TEMPLATE('index.html');
const PHONE = TEMPLATE('mobile.html');

function loadAsGlobal(relPath, exportName) {
  const code = SOURCE(relPath).replace(new RegExp(`^const ${exportName} = `, 'm'), `global.${exportName} = `);
  eval(code);
}

/** The inline <script> in `template` containing `needle`, with its {% if %} guard and position. */
function inlineScript(template, needle) {
  // A comment between the guard and the script may not run past its own end.
  const re = /(\{% if ([^%]+) %\}\s*(?:<!--(?:(?!-->)[\s\S])*-->\s*)?)?<script>([\s\S]*?)<\/script>/g;
  const hit = [...template.matchAll(re)].find(m => m[3].includes(needle));
  if (!hit) throw new Error(`no inline script containing ${needle}`);
  return { code: hit[3], condition: (hit[2] || '').trim(), at: template.indexOf(hit[3]) };
}

const EARLY_DESKTOP = inlineScript(DESKTOP, '__erpEarlyCalls');
const EARLY_PHONE = inlineScript(PHONE, '__erpEarlyCalls');

function response(body, { status = 200, type = 'application/json' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    url: '',
    headers: { get: name => (String(name).toLowerCase() === 'content-type' ? type : null) },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Runs an early-request script as the page would, with a fake fetch. */
function sendEarly(code, { hash = '', stored = null, key, fetchImpl } = {}) {
  history.replaceState(null, '', hash || '/erp');
  localStorage.clear();
  if (stored !== null) localStorage.setItem(key, stored);
  global.fetch = jest.fn(fetchImpl || (() => new Promise(() => {})));
  delete window.__erpEarlyCalls;
  eval(code);
  return global.fetch.mock.calls.map(([url]) => String(url).split('/').pop());
}

const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };

beforeEach(() => {
  document.head.innerHTML = '<meta name="csrf-token" content="token-1">';
  document.body.innerHTML = '';
});

afterEach(() => {
  delete global.Api;
  delete global.fetch;
  delete window.__erpEarlyCalls;
  jest.useRealTimers();
});

// ── When each page asks ──────────────────────────────────────────────────

describe('desktop: the Dashboard', () => {
  const KEY = 'maharaja-erp-last-tab';
  const send = opts => sendEarly(EARLY_DESKTOP.code, { key: KEY, ...opts });

  test('is asked for when the page will open on it', () => {
    expect(send()).toEqual(['getDashboardData']);
    expect(send({ hash: '#dashboardTab' })).toEqual(['getDashboardData']);
    expect(send({ stored: 'dashboardTab' })).toEqual(['getDashboardData']);
    // The address wins over the tab last open, as in resolveInitialTab.
    expect(send({ hash: '#dashboardTab', stored: 'stockTab' })).toEqual(['getDashboardData']);
  });

  test('is not asked for when the page will open somewhere else', () => {
    expect(send({ hash: '#poLedger' })).toEqual([]);
    expect(send({ stored: 'stockTab' })).toEqual([]);
    expect(send({ hash: '#poLedger', stored: 'dashboardTab' })).toEqual([]);
    expect(window.__erpEarlyCalls).toBeUndefined();
  });

  test('storage that cannot be read is the same as nothing remembered', () => {
    const getItem = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    expect(send()).toEqual(['getDashboardData']);
    getItem.mockRestore();
  });

  test('only on a page that has the figures and the Dashboard', () => {
    expect(EARLY_DESKTOP.condition).toBe('sees_figures and permitted_tabs is none');
  });

  test('uses the key and the request the app itself uses', () => {
    eval(SOURCE('core.js').replace(/^const App = /m, 'global.App = '));
    expect(App.Navigation.LAST_TAB_KEY).toBe(KEY);
    expect(EARLY_DESKTOP.code).toContain(`'${KEY}'`);
    expect(SOURCE('dashboard.js')).toContain("await Api.call('getDashboardData')");
    delete global.App;
  });

  test('never asks where the app would not open the Dashboard', () => {
    // The page's rule is the narrower of the two: every case it says yes to,
    // resolveInitialTab must answer dashboardTab.
    eval(SOURCE('core.js').replace(/^const App = /m, 'global.App = '));
    const cases = [
      {}, { hash: '#dashboardTab' }, { stored: 'dashboardTab' }, { hash: '#poLedger' },
      { stored: 'stockTab' }, { hash: '#gone', stored: 'dashboardTab' }, { hash: '#dashboardTab', stored: 'poLedger' },
    ];
    for (const c of cases) {
      const asked = send(c);
      document.body.innerHTML = ['dashboardTab', 'poLedger', 'stockTab']
        .map(id => `<button id="btn-${id}" class="nav-link" data-tab="${id}"></button>`).join('');
      if (asked.length) expect(App.Navigation.resolveInitialTab()).toBe('dashboardTab');
    }
    delete global.App;
  });
});

describe('phone and tablet: Home', () => {
  const KEY = 'maharaja-erp-mobile-last-tab';
  const BOTH = ['getMobileDashboard', 'getDashboardData'];
  const send = opts => sendEarly(EARLY_PHONE.code, { key: KEY, ...opts });

  test('both sets of figures are asked for when the app will open on Home', () => {
    expect(send()).toEqual(BOTH);
    expect(send({ hash: '#home' })).toEqual(BOTH);
    expect(send({ stored: 'home' })).toEqual(BOTH);
    expect(send({ hash: '#home', stored: 'stock' })).toEqual(BOTH);
  });

  test('neither is asked for when it will open on another tab', () => {
    expect(send({ hash: '#production' })).toEqual([]);
    expect(send({ stored: 'stock' })).toEqual([]);
  });

  test('only on a page that has the figures', () => {
    expect(EARLY_PHONE.condition).toBe('sees_figures');
  });

  test('uses the key and the requests Home itself uses', () => {
    global.fetch = jest.fn();
    loadAsGlobal('api.js', 'Api');
    loadAsGlobal('mobile.js', 'MApp');
    expect(MApp.Shell.LAST_TAB_KEY).toBe(KEY);
    expect(EARLY_PHONE.code).toContain(`'${KEY}'`);

    document.body.innerHTML = '<h1 id="home-greeting"></h1><div id="home-date"></div><div id="home-stats"></div><div id="home-activity"></div>';
    global.OfflineCache = { get: jest.fn(() => Promise.resolve(null)), put: jest.fn() };
    MApp.Api.callCached = jest.fn(() => new Promise(() => {}));
    MApp.Api.call = jest.fn(() => new Promise(() => {}));
    MApp.Home.mount();

    expect(MApp.Api.callCached).toHaveBeenCalledWith('getMobileDashboard');
    expect(MApp.Api.call).toHaveBeenCalledWith('getDashboardData');
    delete global.OfflineCache;
    delete global.MApp;
  });
});

// ── The request, and how api.js takes it ──────────────────────────────────

describe('the early request is the one api.js sends', () => {
  test.each([['desktop', EARLY_DESKTOP, 'getDashboardData'], ['phone', EARLY_PHONE, 'getMobileDashboard']])(
    '%s', (_name, early, method) => {
      jest.useFakeTimers();
      sendEarly(early.code, {});
      const sent = global.fetch.mock.calls.find(([url]) => url.endsWith(`/${method}`));

      loadAsGlobal('api.js', 'Api');
      global.fetch.mockClear();
      Api.callFresh(method);
      const [url, init] = global.fetch.mock.calls[0];
      const { signal, ...asApiSendsIt } = init;

      expect(sent[0]).toBe(url);
      expect(sent[1]).toEqual(asApiSendsIt);
      expect(sent[1].headers['X-CSRFToken']).toBe('token-1');
      jest.clearAllTimers();
    });
});

describe('Api.call takes the early answer', () => {
  const answer = { success: true, data: { pendingProductionCount: 4 } };

  function page(fetchImpl) {
    sendEarly(EARLY_PHONE.code, { fetchImpl });
    loadAsGlobal('api.js', 'Api');
  }

  test('one request, one answer: it is not sent twice', async () => {
    page(() => Promise.resolve(response(answer)));

    await expect(Api.call('getMobileDashboard')).resolves.toEqual(answer);
    await expect(Api.call('getDashboardData')).resolves.toEqual(answer);
    expect(global.fetch).toHaveBeenCalledTimes(2); // the page's two, nothing more
    expect(Object.keys(window.__erpEarlyCalls)).toEqual([]);
  });

  test('still in flight when asked: it waits for it', async () => {
    const flight = deferred();
    page(() => flight.promise);

    const asked = Api.call('getMobileDashboard');
    flight.resolve(response(answer));

    await expect(asked).resolves.toEqual(answer);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('then it is the read cache that answers, as for any call', async () => {
    page(() => Promise.resolve(response(answer)));
    await Api.call('getMobileDashboard');
    await expect(Api.call('getMobileDashboard')).resolves.toEqual(answer);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('an answer older than the read cache would keep is not used', async () => {
    page(() => Promise.resolve(response(answer)));
    await flush();
    window.__erpEarlyCalls.getMobileDashboard.doneAt = Date.now() - 16000;
    global.fetch.mockImplementation(() => Promise.resolve(response({ success: true, data: 'fresh' })));

    await expect(Api.call('getMobileDashboard')).resolves.toEqual({ success: true, data: 'fresh' });
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  test('a call with arguments is a different call', async () => {
    page(() => Promise.resolve(response(answer)));
    global.fetch.mockImplementation(() => Promise.resolve(response({ success: true, data: 'with args' })));

    await expect(Api.call('getMobileDashboard', 'x')).resolves.toEqual({ success: true, data: 'with args' });
    expect(global.fetch).toHaveBeenCalledTimes(3);
    // ...and the early one is still there for the call without.
    expect(window.__erpEarlyCalls.getMobileDashboard).toBeDefined();
  });

  test.each([
    ['an expired session', () => Promise.resolve(response({ success: false, message: 'expired' }, { status: 401 }))],
    ['a server error', () => Promise.resolve(response({ success: false, message: 'boom' }, { status: 500 }))],
    ['a login page instead of data', () => Promise.resolve(response('<!DOCTYPE html><title>Sign in</title>', { type: 'text/html' }))],
    ['no connection', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('%s: asked again the ordinary way, which knows what to do with it', async (_name, first) => {
    page(() => first());
    await flush();
    global.fetch.mockImplementation(() => Promise.resolve(response({ success: true, data: 'second try' })));

    await expect(Api.call('getMobileDashboard')).resolves.toEqual({ success: true, data: 'second try' });
    expect(global.fetch).toHaveBeenCalledTimes(3);
    const [url, init] = global.fetch.mock.calls[2];
    expect(url).toBe('/api/erp/rpc/getMobileDashboard');
    expect(init.signal).toBeDefined(); // _request's, with its timeout
  });

  test('a business answer is used as it stands, like any 200', async () => {
    const refusal = { success: false, message: 'Not allowed.' };
    page(() => Promise.resolve(response(refusal)));
    await expect(Api.call('getMobileDashboard')).resolves.toEqual(refusal);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('a save in between drops it: the next read is asked afresh', async () => {
    page(() => Promise.resolve(response(answer)));
    await flush();
    global.fetch.mockImplementation(() => Promise.resolve(response({ success: true, data: 'after the save' })));

    await Api.mutate('saveProduction', { lot: 1 });
    await expect(Api.call('getMobileDashboard')).resolves.toEqual({ success: true, data: 'after the save' });
    expect(window.__erpEarlyCalls).toEqual({});
  });

  test('never waited for past the time a request is allowed', async () => {
    jest.useFakeTimers();
    page(() => new Promise(() => {})); // the server never answers

    const asked = Api.call('getMobileDashboard');
    const outcome = asked.then(() => 'answered', err => err);
    jest.advanceTimersByTime(44_999);
    await flush();
    let settled = false;
    asked.then(() => { settled = true; }, () => { settled = true; });
    await flush();
    expect(settled).toBe(false);

    jest.advanceTimersByTime(1);
    const err = await outcome;
    expect(err.isTimeout).toBe(true);
    expect(err.isNetworkError).toBe(true);
    expect(err.message).toMatch(/did not respond within 45s/);
    expect(global.fetch).toHaveBeenCalledTimes(2); // not sent again on top
  });

  test('the time it is allowed counts from when the page sent it', async () => {
    jest.useFakeTimers();
    page(() => new Promise(() => {}));
    jest.advanceTimersByTime(40_000); // the screen asks 40 s after the page sent it

    const outcome = Api.call('getMobileDashboard').then(() => 'answered', err => err);
    jest.advanceTimersByTime(5_000);
    expect((await outcome).isTimeout).toBe(true);
  });

  test('a broken fetch on the page costs the screen nothing', async () => {
    sendEarly(EARLY_PHONE.code, { fetchImpl: () => { throw new TypeError('fetch is broken'); } });
    global.fetch = jest.fn(() => Promise.resolve(response(answer)));
    loadAsGlobal('api.js', 'Api');

    await expect(Api.call('getMobileDashboard')).resolves.toEqual(answer);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('a page that sent nothing behaves as it always did', async () => {
    delete window.__erpEarlyCalls;
    global.fetch = jest.fn(() => Promise.resolve(response(answer)));
    loadAsGlobal('api.js', 'Api');

    await expect(Api.call('getMobileDashboard')).resolves.toEqual(answer);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

// ── Where the scripts sit ─────────────────────────────────────────────────

describe('the pages themselves', () => {
  const API_TAG = /<script src="\{\{ url_for\('static', filename='erp\/api\.js'\) \}\}[^"]*"><\/script>/g;

  test.each([
    ['index.html', DESKTOP, "filename='erp/print-templates.js'"],
    ['mobile.html', PHONE, "filename='erp/offline-cache.js'"],
  ])('%s loads api.js once, where it always was, after the token it sends', (_name, template, next) => {
    const tags = template.match(API_TAG) || [];
    expect(tags).toHaveLength(1);
    const at = template.indexOf(tags[0]);
    expect(template.split('</head>')[0]).not.toContain(tags[0]);
    expect(at).toBeLessThan(template.indexOf(next));
    expect(template.indexOf('name="csrf-token"')).toBeLessThan(at);
  });

  test('desktop: the early request is in the <head>, after the stylesheets', () => {
    const head = DESKTOP.split('</head>')[0];
    expect(head).toContain(EARLY_DESKTOP.code);
    expect(head.lastIndexOf('rel="stylesheet"')).toBeLessThan(EARLY_DESKTOP.at);
  });

  test('phone: the early request comes straight after the top bar, before anything else', () => {
    const topBarEnd = PHONE.indexOf('</header>');
    const content = PHONE.indexOf('<main id="mapp-content"');
    expect(EARLY_PHONE.at).toBeGreaterThan(topBarEnd);
    expect(EARLY_PHONE.at).toBeLessThan(content);
  });

  test('phone: nothing in the <head> holds up the first paint', () => {
    const head = PHONE.split('</head>')[0];
    // Every script in the head was measured to cost the top bar a frame or more.
    expect((head.match(/<script/g) || []).length).toBe(1); // the theme, stamped before paint
    expect(head).toContain("localStorage.getItem('maharaja-erp-mobile-theme')");
    expect(head).not.toMatch(/rel="preload"/);
  });

  test('desktop: the text fonts are fetched alongside the stylesheets', () => {
    const css = SOURCE(path.join('vendor', 'google-fonts.css'));
    for (const font of ['inter-latin-1.woff2', 'outfit-latin-5.woff2']) {
      expect(css).toContain(`fonts/${font}`);
      expect(DESKTOP).toContain(`<link rel="preload" as="font" type="font/woff2" crossorigin href="{{ url_for('static', filename='erp/vendor/fonts/${font}') }}">`);
    }
  });

  test('the desktop page appears whole, not through a fade from transparent', () => {
    // A fade's first frame is drawn at opacity 0, which the browser does not
    // count as the page appearing: the heading on screen at 1.4 s was counted
    // at 3.3 s, when something else repainted it.
    const rule = DESKTOP.match(/#app-container \{([^}]*)\}/)[1];
    expect(rule).toContain('visibility: hidden');
    expect(rule).not.toMatch(/opacity|transition/);
  });
});

// ── The faces that draw "₹" ────────────────────────────────────────────────

// The faces that draw "₹" are in the latin-ext subset, fetched only when
// the first amount is laid out, and a face that arrives makes Chrome lay out
// again everything in its family. The desktop page fetches them while it is
// still hidden, which took 50-200 ms of blocking off its start-up (lab,
// 2026-11-17). On the phone and tablet that relayout landed in the start-up
// instead and made it longer, with no gain once the app was usable, so that
// page fetches them as it always did.
describe('the faces that draw "₹": the desktop fetches them before the first amount', () => {
  const css = SOURCE(path.join('vendor', 'google-fonts.css'));
  const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(m => m[1]);
  const RUPEE = 0x20b9;
  const covers = range => range.split(',').some(part => {
    const m = part.trim().match(/^U\+([0-9A-F]+)(?:-([0-9A-F]+))?$/i);
    if (!m) return false;
    const lo = parseInt(m[1], 16);
    const hi = m[2] ? parseInt(m[2], 16) : lo;
    return RUPEE >= lo && RUPEE <= hi;
  });
  // Every weight of these families whose face draws the rupee sign.
  const rupeeFaces = families => faces
    .filter(f => covers((f.match(/unicode-range:([^;]+);/) || [])[1] || ''))
    .map(f => [f.match(/font-family:\s*'([^']+)'/)[1], f.match(/font-weight:\s*(\d+)/)[1]])
    .filter(([family]) => families.includes(family))
    .map(([family, weight]) => `${weight} 1em ${family}`)
    .sort();

  const LOADER_DESKTOP = inlineScript(DESKTOP, 'document.fonts.load');
  const listed = code => [...code.matchAll(/'(\d00 1em [A-Za-z]+)'/g)].map(m => m[1]).sort();

  test.each([
    ['desktop', LOADER_DESKTOP, ['Inter', 'Outfit']],
  ])('%s: every weight of its own families, and only for an account shown amounts', (_name, loader, families) => {
    expect(rupeeFaces(families).length).toBeGreaterThan(0);
    expect(listed(loader.code)).toEqual(rupeeFaces(families));
    expect(loader.condition).toBe('sees_money');
    // The sign itself or its escape: the pages are UTF-8, either reaches
    // document.fonts.load as the same one character.
    expect(loader.code).toMatch(/document\.fonts\.load\(font, '(?:₹|\\u20B9)'\)/);
  });

  test('the phone page leaves them to load when first needed', () => {
    expect(PHONE).not.toContain('document.fonts.load');
  });

  test('neither page preloads them: that held the first paint back', () => {
    for (const template of [DESKTOP, PHONE]) {
      expect(template).not.toMatch(/rel="preload"[^>]*latin-ext/);
    }
  });

  // A stand-in for the page's document, so nothing else listening on the
  // real one (start-up code other tests here have loaded) is woken.
  function fakeDocument() {
    const listeners = {};
    return {
      fonts: { load: jest.fn(() => Promise.resolve([])) },
      addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
      fire: type => (listeners[type] || []).forEach(fn => fn()),
    };
  }
  // The loader as the page runs it, against that document.
  const runLoader = (code, document) => { eval(code); };

  test('desktop: once the first frame has been drawn', () => {
    jest.useFakeTimers();
    const frames = [];
    global.requestAnimationFrame = cb => frames.push(cb);
    const doc = fakeDocument();

    runLoader(LOADER_DESKTOP.code, doc);
    expect(doc.fonts.load).not.toHaveBeenCalled();
    frames.splice(0).forEach(cb => cb());
    expect(doc.fonts.load).not.toHaveBeenCalled();
    jest.advanceTimersByTime(0);

    expect(doc.fonts.load.mock.calls.map(c => c[0]).sort()).toEqual(rupeeFaces(['Inter', 'Outfit']));
    expect(new Set(doc.fonts.load.mock.calls.map(c => c[1]))).toEqual(new Set(['\u20B9']));
    delete global.requestAnimationFrame;
  });

  test('a browser without the font loading API is left alone', () => {
    const doc = { addEventListener: jest.fn() };
    expect(() => runLoader(LOADER_DESKTOP.code, doc)).not.toThrow();
    expect(doc.addEventListener).not.toHaveBeenCalled();
  });
});
