/**
 * A search box waits for a longer pause where redrawing its list is slow.
 *
 * A list is redrawn once typing has paused for 120 ms. On a budget phone or
 * tablet, redrawing fifty lot cards takes 400-550 ms (lab, 4x CPU,
 * 2026-11-14): it started in the gap after every letter and the next letter
 * waited for it to finish, so letters appeared in the box up to 0.7 s after
 * they were typed. The pause a box waits for is now the time its own last
 * redraw took on this device, when that is longer -- capped, so the list is
 * never more than a third of a second behind the last key.
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

let onQuery;

beforeEach(() => {
  jest.resetModules();
  jest.useFakeTimers();
  global.fetch = jest.fn();
  document.body.innerHTML = `
    <div class="mb-search"><svg></svg><input type="search" id="lots-search"></div>
    <div class="mb-search"><svg></svg><input type="search" id="stock-search"></div>`;
  loadAsGlobal('api.js', 'Api');
  loadAsGlobal('mobile.js', 'MApp');
  MApp.SearchBox._handlers = {};
  MApp.SearchBox._cost = {};
  onQuery = jest.fn();
});

afterEach(() => {
  jest.useRealTimers();
  delete global.fetch;
});

const type = (id, value) => {
  const input = document.getElementById(id);
  input.value = value;
  input.dispatchEvent(new window.Event('input'));
};

describe('how long a box waits', () => {
  test('120 ms on a device that redraws faster than that, as before', () => {
    expect(MApp.SearchBox.waitFor('lots-search')).toBe(120);
    MApp.SearchBox._cost['lots-search'] = 45;
    expect(MApp.SearchBox.waitFor('lots-search')).toBe(120);
  });

  test('as long as its last redraw took, when that is longer', () => {
    MApp.SearchBox._cost['lots-search'] = 262.4;
    expect(MApp.SearchBox.waitFor('lots-search')).toBe(262);
  });

  test('never more than the cap', () => {
    MApp.SearchBox._cost['lots-search'] = 900;
    expect(MApp.SearchBox.waitFor('lots-search')).toBe(MApp.SearchBox.MAX_DEBOUNCE_MS);
    expect(MApp.SearchBox.MAX_DEBOUNCE_MS).toBeLessThanOrEqual(350);
  });

  test('each box by its own list: a slow one does not slow a fast one', () => {
    MApp.SearchBox._cost['lots-search'] = 300;
    expect(MApp.SearchBox.waitFor('stock-search')).toBe(120);
  });
});

describe('typing into a box whose list is slow to redraw', () => {
  beforeEach(() => {
    MApp.SearchBox.attach('lots-search', onQuery);
    MApp.SearchBox._cost['lots-search'] = 300;
  });

  test('letters typed 150 ms apart no longer start a redraw between them', () => {
    type('lots-search', 'k');
    jest.advanceTimersByTime(150);
    type('lots-search', 'ka');
    jest.advanceTimersByTime(150);
    type('lots-search', 'kal');
    jest.advanceTimersByTime(150);

    expect(onQuery).not.toHaveBeenCalled();

    jest.advanceTimersByTime(150);

    expect(onQuery).toHaveBeenCalledTimes(1);
    expect(onQuery).toHaveBeenCalledWith('kal');
  });

  test('Enter and the clear button still act at once', () => {
    type('lots-search', 'kal');
    document.getElementById('lots-search')
      .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onQuery).toHaveBeenCalledWith('kal');

    document.querySelector('.mb-search-clear').click();
    expect(onQuery).toHaveBeenLastCalledWith('');
  });

  test('what is searched is what was in the box at the last key', () => {
    type('lots-search', 'kalpi');
    // Emptied by the screen itself, not by typing: no input event.
    document.getElementById('lots-search').value = '';
    jest.advanceTimersByTime(300);

    expect(onQuery).toHaveBeenCalledWith('kalpi');
  });
});

describe('how long a redraw took', () => {
  test('is taken to the end of the frame it appears in', () => {
    MApp.SearchBox.attach('lots-search', onQuery);
    let now = 1000;
    MApp.SearchBox._now = () => now;
    const frames = [];
    global.requestAnimationFrame = cb => { frames.push(cb); return 1; };

    type('lots-search', 'kal');
    jest.advanceTimersByTime(120);       // the handler runs...
    now = 1110;                          // ...and takes 110 ms of script
    expect(MApp.SearchBox._cost['lots-search']).toBeUndefined();

    frames.splice(0).forEach(cb => cb());
    now = 1430;                          // layout and paint of fifty cards
    jest.advanceTimersByTime(0);

    expect(MApp.SearchBox._cost['lots-search']).toBe(430);
    expect(MApp.SearchBox.waitFor('lots-search')).toBe(350);
    delete global.requestAnimationFrame;
  });

  test('a box with no handler measures nothing', () => {
    MApp.SearchBox._fire('nobody-home', 'x');
    expect(MApp.SearchBox._cost['nobody-home']).toBeUndefined();
  });
});

describe('a list tells its box what a redraw costs before anything is typed', () => {
  test('timed() runs the redraw and notes its time to the end of the frame', () => {
    let now = 500;
    MApp.SearchBox._now = () => now;
    const frames = [];
    global.requestAnimationFrame = cb => { frames.push(cb); return 1; };
    const redraw = jest.fn(() => { now = 620; });

    MApp.SearchBox.timed('lots-search', redraw);

    expect(redraw).toHaveBeenCalledTimes(1);
    frames.splice(0).forEach(cb => cb());
    now = 910;
    jest.advanceTimersByTime(0);
    expect(MApp.SearchBox._cost['lots-search']).toBe(410);
    delete global.requestAnimationFrame;
  });

  test('so the very first letters typed already wait for a long enough pause', () => {
    MApp.SearchBox.attach('lots-search', onQuery);
    MApp.SearchBox._cost['lots-search'] = 410; // from the list's first draw

    type('lots-search', 'k');
    jest.advanceTimersByTime(150);
    type('lots-search', 'ka');
    jest.advanceTimersByTime(150);

    expect(onQuery).not.toHaveBeenCalled();
    jest.advanceTimersByTime(200);
    expect(onQuery).toHaveBeenCalledTimes(1);
    expect(onQuery).toHaveBeenCalledWith('ka');
  });

  test('the two long lists draw themselves through it when they load', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');
    expect(source).toContain("MApp.SearchBox.timed('production-search', () => this.render());");
    expect(source).toContain("MApp.SearchBox.timed('stock-search', () => this.render());");
  });
});
