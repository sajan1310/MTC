/**
 * Home stays still while it fills in, and asks for everything at once.
 *
 * The dashboard is drawn into the middle of Home a moment after the screen
 * itself, and it is long. On a tablet "Recent activity" sat in plain view
 * under two placeholder cards and was thrown off the screen when the
 * dashboard arrived: a layout shift of 0.33, where over 0.25 is rated poor
 * (lab, 800x1280, 2026-11-14). The figures and the dashboard are now held
 * open at the height they had last time on a screen this wide -- one
 * screenful for the dashboard the first time, when there is nothing to go by.
 *
 * And the dashboard used to be asked for only once the small figures had
 * answered, so its numbers arrived a whole request later than they had to.
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

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const SMALL = { pendingProductionCount: 4, todaysDispatchCount: 2, lowStockCount: 3, recentActivity: [] };
const FULL = { kpis: { openPoCount: 7 }, lowStockItems: [], readyToDispatchItems: [], contractorPayables: [] };

let small, full, frames;

function setup() {
  jest.resetModules();
  global.fetch = jest.fn();
  document.body.innerHTML = `
    <div id="mapp-sheet-backdrop"></div>
    <h1 id="home-greeting"></h1><div id="home-date"></div>
    <div id="home-stats"><div class="mb-skel mb-skel-tile"></div></div>
    <div id="home-dashboard"><div class="mb-skel mb-skel-card"></div></div>
    <div id="home-activity"></div>
    <div class="mb-toast-stack" id="mapp-toast-stack"></div>`;
  localStorage.clear();
  loadAsGlobal('api.js', 'Api');
  loadAsGlobal('mobile.js', 'MApp');
  MApp.Sheet._stack = [];
  MApp.Home._full = null;
  global.OfflineCache = { get: jest.fn(() => Promise.resolve(null)), put: jest.fn() };

  small = deferred();
  full = deferred();
  MApp.Api.callCached = jest.fn(() => small.promise);
  MApp.Api.call = jest.fn(() => full.promise);

  // The browser's next frame, run on demand.
  frames = [];
  global.requestAnimationFrame = jest.fn(cb => { frames.push(cb); return frames.length; });
}

const flush = () => new Promise(r => setTimeout(r, 0));
const nextFrame = () => frames.splice(0).forEach(cb => cb());
// The frame the figures above are drawn in, after which the dashboard is.
const drawn = async () => { await flush(); nextFrame(); await flush(); };
const held = id => document.getElementById(id).style.minHeight;
const drawnAt = (id, height) => {
  document.getElementById(id).getBoundingClientRect = () => ({ height });
};
const remembered = () => JSON.parse(localStorage.getItem(MApp.Home.HEIGHTS_KEY) || '{}');
const keyFor = id => MApp.Home._heightKey(id);

afterEach(() => {
  delete global.OfflineCache;
  delete global.fetch;
  delete global.requestAnimationFrame;
});

describe('the room is held', () => {
  test('the first time, the dashboard is held to one screenful', () => {
    setup();
    MApp.Home.mount();

    expect(held('home-dashboard')).toBe('100vh');
    // Nothing to go by for the figures: they are left as they come.
    expect(held('home-stats')).toBe('');
  });

  test('after that, each is held at the height it had on a screen this wide', () => {
    setup();
    localStorage.setItem(MApp.Home.HEIGHTS_KEY, JSON.stringify({
      [keyFor('home-stats')]: 212,
      [keyFor('home-dashboard')]: 2460,
      'home-dashboard@9999x9999': 1111, // another screen's, or this one turned round
    }));

    MApp.Home.mount();

    expect(held('home-stats')).toBe('212px');
    expect(held('home-dashboard')).toBe('2460px');
  });

  test('it is still held when only the small figures have been drawn', async () => {
    setup();
    MApp.Home.mount();
    small.resolve({ success: true, data: SMALL });
    await flush();

    expect(document.querySelector('#home-blocks')).not.toBeNull();
    expect(held('home-dashboard')).toBe('100vh');
  });

  test('an account without the figures has nothing held', () => {
    setup();
    MApp.Access.seesFigures = () => false;
    MApp.Home.mount();

    expect(held('home-dashboard')).toBe('');
    expect(MApp.Api.call).not.toHaveBeenCalled();
  });
});

describe('and let go once the block has what it is going to have', () => {
  test('the dashboard, drawn: released, and its height remembered', async () => {
    setup();
    MApp.Home.mount();
    small.resolve({ success: true, data: SMALL });
    full.resolve({ success: true, data: FULL });
    await drawn();

    expect(held('home-dashboard')).toBe('');
    expect(held('home-stats')).toBe('');
    expect(document.getElementById('home-dashboard').textContent).toContain('Open POs');

    // Not while the page is being written, nor inside the next frame
    // (where reading a height makes the browser lay the page out on the
    // spot), but in the task after that frame.
    expect(remembered()).toEqual({});
    drawnAt('home-dashboard', 2459.6);
    drawnAt('home-stats', 212);
    nextFrame();
    expect(remembered()).toEqual({});
    await flush();

    expect(remembered()).toEqual({ [keyFor('home-dashboard')]: 2460, [keyFor('home-stats')]: 212 });
  });

  test('nothing reads a height inside the animation frame itself', async () => {
    setup();
    MApp.Home.mount();
    small.resolve({ success: true, data: SMALL });
    full.resolve({ success: true, data: FULL });
    await drawn();
    const read = jest.fn(() => ({ height: 300 }));
    document.getElementById('home-dashboard').getBoundingClientRect = read;
    document.getElementById('home-stats').getBoundingClientRect = read;

    nextFrame();
    expect(read).not.toHaveBeenCalled();

    await flush();
    expect(read).toHaveBeenCalledTimes(2);
  });

  test('a height of nothing is not remembered', async () => {
    setup();
    MApp.Home.mount();
    small.resolve({ success: true, data: SMALL });
    full.resolve({ success: true, data: FULL });
    await drawn();
    nextFrame(); // jsdom lays nothing out: every height is 0
    await flush();

    expect(remembered()).toEqual({});
  });

  test('the dashboard failing: released, and nothing remembered', async () => {
    setup();
    localStorage.setItem(MApp.Home.HEIGHTS_KEY, JSON.stringify({ [keyFor('home-dashboard')]: 2460 }));
    MApp.Home.mount();
    small.resolve({ success: true, data: SMALL });
    full.reject(new Error('offline'));
    await drawn();

    expect(held('home-dashboard')).toBe('');
    expect(document.getElementById('home-dashboard').textContent).toContain('needs a connection');
    drawnAt('home-dashboard', 140);
    nextFrame();
    await flush();
    // The error box's height says nothing about the dashboard's.
    expect(remembered()).toEqual({ [keyFor('home-dashboard')]: 2460 });
  });

  test('the small figures failing with nothing stored: both released', async () => {
    setup();
    MApp.Home.mount();
    small.resolve({ success: false, message: 'Server error' });
    await flush();

    expect(held('home-dashboard')).toBe('');
    expect(held('home-stats')).toBe('');
  });

  test('leaving Home before the frame remembers nothing', async () => {
    setup();
    MApp.Home.mount();
    small.resolve({ success: true, data: SMALL });
    full.resolve({ success: true, data: FULL });
    await drawn();
    drawnAt('home-dashboard', 2460);
    nextFrame();
    document.getElementById('home-dashboard').remove();
    await flush();

    expect(remembered()[keyFor('home-dashboard')]).toBeUndefined();
  });
});

describe('both requests go out together', () => {
  test('the dashboard is asked for before the small figures have answered', () => {
    setup();
    MApp.Home.mount();

    expect(MApp.Api.callCached).toHaveBeenCalledWith('getMobileDashboard');
    expect(MApp.Api.call).toHaveBeenCalledWith('getDashboardData');
    expect(MApp.Api.call).toHaveBeenCalledTimes(1);
  });

  test('it is still drawn after them, even when it answers first', async () => {
    setup();
    MApp.Home.mount();
    full.resolve({ success: true, data: FULL });
    await flush();

    expect(document.getElementById('home-dashboard').textContent).not.toContain('Open POs');

    small.resolve({ success: true, data: SMALL });
    await drawn();

    expect(document.querySelector('#home-blocks')).not.toBeNull();
    expect(document.getElementById('home-dashboard').textContent).toContain('Open POs');
    // One request for it, not a second once the small figures were in.
    expect(MApp.Api.call).toHaveBeenCalledTimes(1);
  });

  test('a dashboard that fails while the small figures are still loading is reported once they are in', async () => {
    setup();
    MApp.Home.mount();
    full.reject(new Error('offline'));
    await flush();

    expect(document.getElementById('home-dashboard').textContent).not.toContain('needs a connection');

    small.resolve({ success: true, data: SMALL });
    await drawn();

    expect(document.getElementById('home-dashboard').textContent).toContain('needs a connection');
  });

  test('Retry on a failed dashboard sends a request of its own', async () => {
    setup();
    MApp.Home.mount();
    small.resolve({ success: true, data: SMALL });
    full.reject(new Error('offline'));
    await drawn();
    expect(document.getElementById('home-dashboard').textContent).toContain('needs a connection');

    MApp.Api.call = jest.fn(() => Promise.resolve({ success: true, data: FULL }));
    await MApp.Home._loadFullData();

    expect(MApp.Api.call).toHaveBeenCalledWith('getDashboardData');
    expect(document.getElementById('home-dashboard').textContent).toContain('Open POs');
  });
});

describe('the dashboard is drawn in a frame of its own', () => {
  test('with both answers in hand, the figures above it are drawn first', async () => {
    // A quick return to Home (the read cache) or the early requests at
    // start-up: both answers are there before Home asks for them. The
    // dashboard used to be laid out in the same frame as the tap.
    setup();
    MApp.Api.callCached = jest.fn(() => Promise.resolve({ success: true, data: SMALL }));
    MApp.Api.call = jest.fn(() => Promise.resolve({ success: true, data: FULL }));
    MApp.Home.mount();
    await flush();

    expect(document.querySelector('#home-blocks')).not.toBeNull();
    expect(document.getElementById('home-dashboard').textContent).not.toContain('Open POs');
    expect(held('home-dashboard')).toBe('100vh'); // the room is still kept for it

    nextFrame();
    await flush();
    expect(document.getElementById('home-dashboard').textContent).toContain('Open POs');
  });

  test('a page in the background does not wait for a frame it will not get', async () => {
    setup();
    const state = jest.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    MApp.Api.callCached = jest.fn(() => Promise.resolve({ success: true, data: SMALL }));
    MApp.Api.call = jest.fn(() => Promise.resolve({ success: true, data: FULL }));
    MApp.Home.mount();
    await flush();
    await flush();

    expect(document.getElementById('home-dashboard').textContent).toContain('Open POs');
    expect(frames).toHaveLength(2); // only the two height measurements
    state.mockRestore();
  });

  test('a frame that never comes is waited for a second at most', async () => {
    jest.useFakeTimers();
    setup();
    MApp.Api.callCached = jest.fn(() => Promise.resolve({ success: true, data: SMALL }));
    MApp.Api.call = jest.fn(() => Promise.resolve({ success: true, data: FULL }));
    MApp.Home.mount();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    jest.advanceTimersByTime(999);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(document.getElementById('home-dashboard').textContent).not.toContain('Open POs');

    jest.advanceTimersByTime(1);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(document.getElementById('home-dashboard').textContent).toContain('Open POs');
    jest.useRealTimers();
  });
});

describe('holding the room costs the tap nothing', () => {
  test("the window is never asked for its size (on a phone that lays the page out on the spot)", () => {
    setup();
    const was = { innerWidth: window.innerWidth, innerHeight: window.innerHeight };
    const asked = jest.fn(() => 800);
    for (const name of Object.keys(was)) {
      Object.defineProperty(window, name, { configurable: true, get: asked });
    }

    MApp.Home.mount();

    for (const name of Object.keys(was)) {
      Object.defineProperty(window, name, { configurable: true, writable: true, value: was[name] });
    }
    expect(asked).not.toHaveBeenCalled();
  });

  test('a height is remembered per screen and per way up', () => {
    setup();
    const was = MApp.Home._heightKey('home-dashboard');
    const w = jest.spyOn(window.screen, 'width', 'get').mockReturnValue(1280);
    const h = jest.spyOn(window.screen, 'height', 'get').mockReturnValue(800);

    expect(MApp.Home._heightKey('home-dashboard')).toBe('home-dashboard@1280x800');
    expect(MApp.Home._heightKey('home-dashboard')).not.toBe(was);
    w.mockRestore();
    h.mockRestore();
  });
});
