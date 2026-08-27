/**
 * Desktop search is debounced (UX-002).
 *
 * The 28 desktop search boxes were wired `onkeyup="App.X.filterY(this.value)"`,
 * so every keystroke re-filtered the dataset and re-rendered the whole table.
 * On Stock -- 1,633 rows in production -- typing a six-character item name did
 * that six times, and the typing itself stutters, because each render blocks
 * the main thread between keystrokes. The mobile shell has had a debounce
 * since it was written; the desktop never got one.
 *
 * `onkeyup` was wrong for a second reason: it does not fire for
 * paste-by-mouse or for IME composition, so a pasted search term did nothing
 * until the next key press. All 28 are now `oninput`.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function loadCoreAsGlobal() {
  const code = fs
    .readFileSync(path.join(__dirname, '..', 'core.js'), 'utf8')
    .replace(/^const App = /m, 'global.App = ');
  // eslint-disable-next-line no-eval
  eval(code);
}

global.escapeHtml = str => String(str ?? '');

const PARTIALS = path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials');

beforeEach(() => {
  jest.useFakeTimers();
  document.body.innerHTML = '<input id="a"><input id="b">';
  loadCoreAsGlobal();
});

afterEach(() => {
  jest.useRealTimers();
});

// ── The helper ─────────────────────────────────────────────────────────

describe('App.Utils.debouncedFilter', () => {
  test('does not run on the first keystroke', () => {
    const fn = jest.fn();
    App.Utils.debouncedFilter(document.getElementById('a'), fn);
    expect(fn).not.toHaveBeenCalled();
  });

  test('runs once after typing stops', () => {
    const fn = jest.fn();
    const el = document.getElementById('a');
    'abcdef'.split('').forEach(() => App.Utils.debouncedFilter(el, fn));

    jest.advanceTimersByTime(500);
    // THE point of the finding: six keystrokes, one render -- not six.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('a pause between words filters twice, not once', () => {
    const fn = jest.fn();
    const el = document.getElementById('a');

    App.Utils.debouncedFilter(el, fn);
    jest.advanceTimersByTime(500);
    App.Utils.debouncedFilter(el, fn);
    jest.advanceTimersByTime(500);

    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('two inputs debounce independently', () => {
    // A shared timer would mean two open dialogs cancelling each other's
    // searches -- a bug that only appears when someone has both open.
    const first = jest.fn();
    const second = jest.fn();
    App.Utils.debouncedFilter(document.getElementById('a'), first);
    App.Utils.debouncedFilter(document.getElementById('b'), second);

    jest.advanceTimersByTime(500);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  test('the wait is overridable', () => {
    const fn = jest.fn();
    App.Utils.debouncedFilter(document.getElementById('a'), fn, 1000);
    jest.advanceTimersByTime(500);
    expect(fn).not.toHaveBeenCalled();
    jest.advanceTimersByTime(600);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('a missing element still runs the filter', () => {
    // Degrade to the old behaviour rather than silently never filtering.
    const fn = jest.fn();
    App.Utils.debouncedFilter(null, fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('a non-function is ignored rather than thrown', () => {
    expect(() => App.Utils.debouncedFilter(document.getElementById('a'), undefined))
      .not.toThrow();
  });
});

// ── The call sites ─────────────────────────────────────────────────────

describe('the search boxes are wired to it', () => {
  const files = fs.readdirSync(PARTIALS).filter(f => f.endsWith('.html'));

  test('no partial still filters on every keystroke', () => {
    const offenders = [];
    for (const file of files) {
      const src = fs.readFileSync(path.join(PARTIALS, file), 'utf8');
      const hits = src.match(/onkeyup="App\./g);
      if (hits) offenders.push(`${file}: ${hits.length}`);
    }
    expect(offenders).toEqual([]);
  });

  test('every search input uses oninput, not onkeyup', () => {
    // onkeyup misses paste-by-mouse and IME composition entirely.
    const offenders = [];
    for (const file of files) {
      const src = fs.readFileSync(path.join(PARTIALS, file), 'utf8');
      for (const line of src.split('\n')) {
        if (/id="[^"]*[Ss]earch[^"]*"/.test(line) && /onkeyup=/.test(line)) {
          offenders.push(`${file}: ${line.trim().slice(0, 80)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the debounced handlers are syntactically valid JavaScript', () => {
    // These live inside HTML attributes, where a stray quote yields a handler
    // that silently never runs.
    const handlers = [];
    for (const file of files) {
      const src = fs.readFileSync(path.join(PARTIALS, file), 'utf8');
      for (const m of src.matchAll(/oninput="(App\.Utils\.debouncedFilter\([^"]*)"/g)) {
        handlers.push([file, m[1]]);
      }
    }
    expect(handlers.length).toBeGreaterThanOrEqual(28);
    for (const [file, code] of handlers) {
      // eslint-disable-next-line no-new-func
      expect(() => new Function('this', code)).not.toThrow(`${file}: ${code}`);
    }
  });
});
