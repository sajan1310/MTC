/**
 * A click on the sidebar shows the tab first and fills it straight after
 * (App.Navigation.showTab in ../core.js).
 *
 * Filling a tab is the slow part: a ledger redrawn, its vendor boxes rebuilt,
 * the Dashboard's charts. Done inside the click, it held the screen still for
 * 300-600 ms before the tab even changed (lab, 2026-11-14, an office PC's
 * speed). Two more things in the same click made the browser lay the incoming
 * panel out on the spot, each before its own module had redrawn it:
 * history.pushState, and the tabindex of the button that has the focus. Both
 * now happen while the page is still as the last frame drew it.
 *
 * Code that opens a tab and carries straight on (a Dashboard tile opening a
 * form, a link into another ledger) still gets the load started before
 * showTab returns.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CORE_JS = fs.readFileSync(path.join(__dirname, '..', 'core.js'), 'utf8');

function loadCoreAsGlobal() {
  eval(CORE_JS.replace(/^const App = /m, 'global.App = '));
}

const TABS = ['dashboardTab', 'poLedger', 'stockTab'];

function buildShell() {
  document.body.innerHTML = `
    <div id="mainTabs">
      ${TABS.map(id => `<button id="btn-${id}" class="nav-link" data-action="show-tab" data-tab="${id}"></button>`).join('')}
    </div>
    ${TABS.map(id => `<div class="tab-content" id="${id}" style="display:none"></div>`).join('')}`;
}

const shown = () => TABS.filter(id => document.getElementById(id).style.display === 'block');
const active = () => TABS.filter(id => document.getElementById(`btn-${id}`).classList.contains('active'));

// Stands in for the browser having drawn a frame: afterPaint() resolves.
let drawFrame;

beforeEach(() => {
  history.replaceState(null, '', '/erp');
  localStorage.clear();
  loadCoreAsGlobal();
  buildShell();

  App.PO = { loadData: jest.fn(() => Promise.resolve('po loaded')) };
  App.Stock = { loadData: jest.fn(() => Promise.resolve('stock loaded')) };
  App.Dashboard = {
    loadData: jest.fn(() => Promise.resolve('dashboard loaded')),
    startAutoRefresh: jest.fn(),
    stopAutoRefresh: jest.fn(),
  };

  const frames = [];
  drawFrame = async () => {
    frames.splice(0).forEach(resolve => resolve());
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  };
  App.Navigation.afterPaint = jest.fn(() => new Promise(resolve => frames.push(resolve)));
});

describe('a click on the sidebar', () => {
  test('shows the tab at once and leaves filling it until that has been drawn', async () => {
    const done = App.Navigation.showTab('poLedger', { paintFirst: true });

    expect(shown()).toEqual(['poLedger']);
    expect(active()).toEqual(['poLedger']);
    expect(location.hash).toBe('#poLedger');
    expect(App.PO.loadData).not.toHaveBeenCalled();

    await drawFrame();

    expect(App.PO.loadData).toHaveBeenCalledTimes(1);
    await expect(done).resolves.toBe('po loaded');
  });

  test('does not fill a tab the user has already left', async () => {
    App.Navigation.showTab('poLedger', { paintFirst: true });
    App.Navigation.showTab('stockTab', { paintFirst: true });

    await drawFrame();

    expect(App.PO.loadData).not.toHaveBeenCalled();
    expect(App.Stock.loadData).toHaveBeenCalledTimes(1);
    expect(shown()).toEqual(['stockTab']);
  });

  test("does not start the Dashboard's refresh timer behind another tab", async () => {
    App.Navigation.showTab('dashboardTab', { paintFirst: true });
    App.Navigation.showTab('poLedger', { paintFirst: true });

    await drawFrame();

    expect(App.Dashboard.loadData).not.toHaveBeenCalled();
    expect(App.Dashboard.startAutoRefresh).not.toHaveBeenCalled();
  });

  test('the Dashboard is filled and its timer started once it is the tab on screen', async () => {
    App.Navigation.showTab('dashboardTab', { paintFirst: true });

    await drawFrame();

    expect(App.Dashboard.loadData).toHaveBeenCalledTimes(1);
    expect(App.Dashboard.startAutoRefresh).toHaveBeenCalledTimes(1);
  });

  test('is what the sidebar buttons ask for', () => {
    // The delegate is bound inside the page's own start-up, which these
    // tests do not run; this keeps the option from being dropped from it.
    expect(CORE_JS).toMatch(
      /case 'show-tab':\s*App\.Navigation\.showTab\(btn\.dataset\.tab, \{ paintFirst: true \}\);/
    );
  });
});

describe('a tab opened by other code', () => {
  test('has its load started before showTab returns, as it always has', async () => {
    const done = App.Navigation.showTab('poLedger');

    expect(App.PO.loadData).toHaveBeenCalledTimes(1);
    expect(App.Navigation.afterPaint).not.toHaveBeenCalled();
    await expect(done).resolves.toBe('po loaded');
  });

  test('the first load of the page is one of those', async () => {
    await App.Navigation.showTab('dashboardTab', { replace: true });

    expect(App.Dashboard.loadData).toHaveBeenCalledTimes(1);
    expect(App.Dashboard.startAutoRefresh).toHaveBeenCalledTimes(1);
  });
});

describe('nothing in the click makes the browser lay the new panel out early', () => {
  test('the address is written before the panels change places', () => {
    App.Navigation.showTab('poLedger');
    const seen = [];
    const pushState = jest.spyOn(history, 'pushState').mockImplementation(() => { seen.push(shown()); });

    App.Navigation.showTab('stockTab');

    pushState.mockRestore();
    // Still the outgoing tab's panel when pushState ran.
    expect(seen).toEqual([['poLedger']]);
    expect(shown()).toEqual(['stockTab']);
  });

  test('so is the tabindex of the button that was clicked', () => {
    App.Navigation.showTab('poLedger');
    const button = document.getElementById('btn-stockTab');
    const seen = [];
    const original = button.setAttribute.bind(button);
    button.setAttribute = (name, value) => {
      if (name === 'tabindex') seen.push(shown());
      original(name, value);
    };

    App.Navigation.showTab('stockTab');

    expect(seen).toEqual([['poLedger']]);
    expect(button.getAttribute('tabindex')).toBe('0');
    expect(button.getAttribute('aria-selected')).toBe('true');
  });

  test('the tab on screen is known before any of it', () => {
    // handleHashChange compares against it; a hashchange arriving mid-switch
    // must not start the same switch a second time.
    const pushState = jest.spyOn(history, 'pushState').mockImplementation(() => {
      expect(App.Navigation.current).toBe('stockTab');
    });

    App.Navigation.showTab('stockTab');

    expect(pushState).toHaveBeenCalledTimes(1);
    pushState.mockRestore();
  });
});

describe('afterPaint', () => {
  let frame;
  let callbacks;

  beforeEach(() => {
    loadCoreAsGlobal(); // the real afterPaint back
    jest.useFakeTimers();
    frame = global.requestAnimationFrame;
    callbacks = [];
    global.requestAnimationFrame = jest.fn(cb => { callbacks.push(cb); return callbacks.length; });
  });

  afterEach(() => {
    global.requestAnimationFrame = frame;
    jest.useRealTimers();
  });

  const settled = async promise => {
    let done = false;
    promise.then(() => { done = true; });
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    return done;
  };

  test('waits for the frame, however long the click itself took', async () => {
    // The click's own work ran past the old 100 ms limit at an office PC's
    // speed, so the limit fired first and the tab was filled before it was
    // drawn: a Purchase Orders click took twice as long as before.
    const drawn = App.Navigation.afterPaint();

    jest.advanceTimersByTime(400);
    expect(await settled(drawn)).toBe(false);

    callbacks.splice(0).forEach(cb => cb()); // the frame
    expect(await settled(drawn)).toBe(false); // not inside it: after it
    jest.advanceTimersByTime(0);
    expect(await settled(drawn)).toBe(true);
  });

  test('does not wait at all on a page in the background, which gets no frames', async () => {
    const state = jest.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');

    const drawn = App.Navigation.afterPaint();
    jest.advanceTimersByTime(0);

    expect(await settled(drawn)).toBe(true);
    expect(global.requestAnimationFrame).not.toHaveBeenCalled();
    state.mockRestore();
  });

  test('does not wait for ever for a frame that never comes', async () => {
    const drawn = App.Navigation.afterPaint();

    jest.advanceTimersByTime(999);
    expect(await settled(drawn)).toBe(false);
    jest.advanceTimersByTime(1);
    expect(await settled(drawn)).toBe(true);
  });
});

describe('the page opens on the tab it was left on, from its first frame', () => {
  test('showPanel changes the highlight and the panel, and nothing else', () => {
    App.Navigation.showPanel('stockTab');

    expect(shown()).toEqual(['stockTab']);
    expect(active()).toEqual(['stockTab']);
    expect(document.getElementById('btn-stockTab').getAttribute('aria-selected')).toBe('true');
    expect(document.getElementById('btn-poLedger').getAttribute('tabindex')).toBe('-1');
    // No address, nothing remembered, nothing loaded: that is showTab's.
    expect(location.hash).toBe('');
    expect(localStorage.getItem(App.Navigation.LAST_TAB_KEY)).toBeNull();
    expect(App.Stock.loadData).not.toHaveBeenCalled();
    expect(App.Navigation.current).toBeNull();
  });

  test('start-up puts that panel up before it shows the page', () => {
    // Without the fade the page used to open through, the Dashboard's panel
    // (the one the markup ships showing) would be on screen for a frame.
    const start = CORE_JS.slice(CORE_JS.indexOf("document.addEventListener('DOMContentLoaded', async () => {"));
    const panel = start.indexOf('App.Navigation.showPanel(opening)');
    const reveal = start.indexOf("container.classList.add('loaded')");

    expect(start).toContain('const opening = App.Navigation.resolveInitialTab();');
    expect(panel).toBeGreaterThan(-1);
    expect(panel).toBeLessThan(reveal);
  });
});
