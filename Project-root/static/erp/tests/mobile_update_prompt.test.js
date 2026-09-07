/**
 * MApp.Update -- offering a reload instead of swapping the app out from
 * under whoever is using it (Phase 3, MB-A08).
 *
 * mobile-sw.js called skipWaiting() the moment a new worker finished
 * installing. A deploy while an operator had a half-filled Log Lot form
 * open therefore replaced the cached assets underneath the running page --
 * the page kept the old mobile.js in memory while the worker served new
 * ones to every subsequent request, with nothing on screen to say so.
 *
 * The two behaviours worth pinning are that it does not ask while a sheet
 * is open (a sheet is a half-entered record), and that it does not ask at
 * all on a first install (there is nothing to reload into).
 */

'use strict';

const fs = require('fs');
const path = require('path');

function loadAsGlobal(relPath, exportName) {
  const code = fs
    .readFileSync(path.join(__dirname, '..', relPath), 'utf8')
    .replace(new RegExp(`^const ${exportName} = `, 'm'), `global.${exportName} = `);
  // eslint-disable-next-line no-eval
  eval(code);
}

const SW_SRC = fs.readFileSync(path.join(__dirname, '..', 'mobile-sw.js'), 'utf8');

// A minimal stand-in for a ServiceWorker that can change state.
function fakeWorker() {
  const listeners = {};
  return {
    state: 'installing',
    postMessage: jest.fn(),
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    _fire: type => (listeners[type] || []).forEach(fn => fn()),
    _become(state) { this.state = state; this._fire('statechange'); },
  };
}

function fakeRegistration() {
  const listeners = {};
  return {
    installing: null,
    waiting: null,
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    _fire: type => (listeners[type] || []).forEach(fn => fn()),
  };
}

describe('MApp.Update', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    global.fetch = jest.fn();
    document.body.innerHTML = '<div class="mb-toast-stack" id="mapp-toast-stack"></div>';
    loadAsGlobal('api.js', 'Api');
    loadAsGlobal('mobile.js', 'MApp');
    MApp.Sheet._stack = [];
    MApp.Update._waiting = null;
    MApp.Update._dismiss = null;
    MApp.Update._reloading = false;
    // jsdom has no serviceWorker; only `controller` is read here.
    Object.defineProperty(global.navigator, 'serviceWorker', {
      value: { controller: {}, addEventListener: jest.fn() },
      configurable: true,
    });
  });

  afterEach(() => jest.useRealTimers());

  const toast = () => document.querySelector('.mb-toast-action');
  const actionBtn = () => document.querySelector('.mb-toast-action-btn');

  test('offers a reload when a new worker finishes installing', () => {
    const reg = fakeRegistration();
    MApp.Update.watch(reg);

    const worker = fakeWorker();
    reg.installing = worker;
    reg._fire('updatefound');
    worker._become('installed');

    expect(toast()).not.toBeNull();
    expect(toast().textContent).toContain('A new version is ready');
    expect(actionBtn().textContent).toBe('Reload');
  });

  test('says nothing on a first install -- there is nothing to reload into', () => {
    navigator.serviceWorker.controller = null;
    const reg = fakeRegistration();
    MApp.Update.watch(reg);

    const worker = fakeWorker();
    reg.installing = worker;
    reg._fire('updatefound');
    worker._become('installed');

    expect(toast()).toBeNull();
  });

  test('offers immediately when an update was already waiting from a previous visit', () => {
    const reg = fakeRegistration();
    reg.waiting = fakeWorker();

    MApp.Update.watch(reg);

    expect(toast()).not.toBeNull();
  });

  test('does not interrupt a half-entered record', () => {
    // A sheet open means a form mid-entry, and reloading would discard it.
    MApp.Sheet._stack = [{ id: 'sheet-log-lot' }];
    const reg = fakeRegistration();
    reg.waiting = fakeWorker();

    MApp.Update.watch(reg);

    expect(toast()).toBeNull();
  });

  test('asks again once the sheet is closed -- the update is not dropped', () => {
    MApp.Sheet._stack = [{ id: 'sheet-log-lot' }];
    const reg = fakeRegistration();
    reg.waiting = fakeWorker();
    MApp.Update.watch(reg);
    expect(toast()).toBeNull();

    MApp.Sheet._stack = [];
    jest.advanceTimersByTime(MApp.Update.RETRY_MS);

    expect(toast()).not.toBeNull();
  });

  test('accepting tells the waiting worker to take over', () => {
    const reg = fakeRegistration();
    const worker = fakeWorker();
    reg.waiting = worker;
    MApp.Update.watch(reg);

    actionBtn().click();

    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'skip-waiting' });
    // The prompt goes away rather than sitting there after being accepted.
    expect(toast()).toBeNull();
  });

  test('does not stack prompts if the offer fires more than once', () => {
    const reg = fakeRegistration();
    reg.waiting = fakeWorker();
    MApp.Update.watch(reg);
    MApp.Update._offer(fakeWorker());
    MApp.Update._offer(fakeWorker());

    expect(document.querySelectorAll('.mb-toast-action')).toHaveLength(1);
  });

  test('the prompt does not expire on its own', () => {
    // An update the operator missed because it faded after 2.6 seconds is
    // an update that never happens.
    const reg = fakeRegistration();
    reg.waiting = fakeWorker();
    MApp.Update.watch(reg);

    jest.advanceTimersByTime(60000);

    expect(toast()).not.toBeNull();
  });

  test('a missing registration is survivable', () => {
    expect(() => MApp.Update.watch(null)).not.toThrow();
  });
});

describe('the service worker no longer activates itself', () => {
  test('install() does not call skipWaiting', () => {
    // This is the defect: activating on install swaps cached assets out
    // from under a running page. The ONLY skipWaiting left must be the one
    // behind the operator accepting the prompt.
    const install = SW_SRC.slice(
      SW_SRC.indexOf("addEventListener('install'"),
      SW_SRC.indexOf("addEventListener('activate'")
    );
    // Matched on the CALL, not the word: the block carries a comment
    // explaining why it no longer calls it, and a guard that cannot tell
    // a comment from code is a guard that fires on its own documentation.
    expect(install).not.toMatch(/self\.skipWaiting\(\)/);
  });

  test('skipWaiting happens only on the skip-waiting message', () => {
    expect(SW_SRC).toContain("event.data.type === 'skip-waiting'");
    // Exactly one CALL site in the whole worker. Matched on `self.` so the
    // comment explaining why install() no longer calls it is not counted.
    expect(SW_SRC.match(/self\.skipWaiting\(\)/g)).toHaveLength(1);
  });
});
