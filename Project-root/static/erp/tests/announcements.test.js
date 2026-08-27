/**
 * Async changes are announced to assistive technology (A11Y-005, A11Y-006).
 *
 * Everything on these tabs happens without a page load: data arrives, tables
 * re-render, a filter narrows 1,633 rows to 3, a sort reverses the order. A
 * sighted user sees all of it in the summary line. A screen-reader user was
 * told none of it -- the DOM changed silently beneath a cursor that had not
 * moved, so the only way to find out what had happened was to navigate the
 * whole table again and infer it.
 *
 * A polite live region rather than a focus jump, deliberately. Moving focus
 * to the table when a load finishes sounds helpful and is hostile in
 * practice: loads complete while the user is still typing in the search box,
 * and yanking the caret out mid-word is worse than saying nothing.
 *
 * The announcement is produced inside `renderPagination`, from the same
 * numbers that render the visible summary line -- so it cannot drift from
 * what is on screen, because it is what is on screen.
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

const announced = () => document.getElementById('a11y-announcer').textContent;

beforeEach(() => {
  jest.useFakeTimers();
  document.body.innerHTML =
    '<div id="a11y-announcer" role="status" aria-live="polite" aria-atomic="true"></div>' +
    '<div id="pager"></div>';
  loadCoreAsGlobal();
});

afterEach(() => jest.useRealTimers());

function flush() {
  jest.advanceTimersByTime(100);
}

// ── The region ─────────────────────────────────────────────────────────

describe('App.Utils.announce', () => {
  test('writes into the live region', () => {
    App.Utils.announce('42 items');
    flush();
    expect(announced()).toBe('42 items');
  });

  test('clears before writing so the same text counts as a change', () => {
    // Most screen readers ignore an identical consecutive value, so the
    // region has to be emptied first for a repeat to be spoken at all.
    App.Utils.announce('first');
    flush();
    App.Utils.announce('second');
    expect(announced()).toBe('');   // cleared, not yet rewritten
    flush();
    expect(announced()).toBe('second');
  });

  test('a repeated message is not re-announced', () => {
    // Tables re-render for reasons the user did not cause. Repeating the
    // same sentence each time is noise that trains people to ignore it.
    App.Utils.announce('40 items');
    flush();
    document.getElementById('a11y-announcer').textContent = 'TOUCHED';
    App.Utils.announce('40 items');
    flush();
    expect(announced()).toBe('TOUCHED');
  });

  test('an empty message says nothing', () => {
    App.Utils.announce('   ');
    flush();
    expect(announced()).toBe('');
  });

  test('a missing region is a no-op, not a crash', () => {
    document.getElementById('a11y-announcer').remove();
    expect(() => { App.Utils.announce('x'); flush(); }).not.toThrow();
  });
});

// ── Wired into every table ─────────────────────────────────────────────

describe('renderPagination announces the result', () => {
  test('says what is on screen', () => {
    App.Utils.renderPagination('pager', 1633, 1, 25, 'goToPage', 'Items');
    flush();
    expect(announced()).toBe('Showing 1 to 25 of 1633 Items');
  });

  test('the announcement matches the visible summary line', () => {
    // The property that keeps this honest: one set of numbers, two renderings.
    App.Utils.renderPagination('pager', 1633, 3, 25, 'goToPage', 'Items');
    flush();
    const visible = document.getElementById('pager').textContent;
    expect(visible).toContain('51');
    expect(visible).toContain('75');
    expect(visible).toContain('1633');
    expect(announced()).toBe('Showing 51 to 75 of 1633 Items');
  });

  test('an empty result is announced, not left silent', () => {
    // The case a user most needs to be told about: a filter that matched
    // nothing leaves an empty table and, before this, complete silence.
    App.Utils.renderPagination('pager', 0, 1, 25, 'goToPage', 'Items');
    flush();
    expect(announced()).toBe('No items found');
  });

  test('changing page announces the new range', () => {
    App.Utils.renderPagination('pager', 100, 1, 25, 'goToPage', 'Bills');
    flush();
    App.Utils.renderPagination('pager', 100, 2, 25, 'goToPage', 'Bills');
    flush();
    expect(announced()).toBe('Showing 26 to 50 of 100 Bills');
  });

  test('narrowing a filter announces the smaller count', () => {
    App.Utils.renderPagination('pager', 1633, 1, 25, 'goToPage', 'Items');
    flush();
    App.Utils.renderPagination('pager', 3, 1, 25, 'goToPage', 'Items');
    flush();
    expect(announced()).toBe('Showing 1 to 3 of 3 Items');
  });
});

// ── announceRowCount ───────────────────────────────────────────────────

describe('announceRowCount', () => {
  test('reports a subset as a subset', () => {
    App.Utils.announceRowCount(12, 1633, 'items');
    flush();
    expect(announced()).toBe('Showing 12 of 1633 items');
  });

  test('reports an unfiltered set plainly', () => {
    App.Utils.announceRowCount(40, 40, 'items');
    flush();
    expect(announced()).toBe('40 items');
  });

  test('copes with no total', () => {
    App.Utils.announceRowCount(7, undefined, 'vendors');
    flush();
    expect(announced()).toBe('7 vendors');
  });
});

// ── The page carries the region ────────────────────────────────────────

test('the shell renders a polite, atomic live region', () => {
  const shell = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'index.html'),
    'utf8',
  );
  expect(shell).toMatch(/id="a11y-announcer"/);
  expect(shell).toMatch(/aria-live="polite"/);
  // atomic: the whole sentence is read, not just the words that changed.
  expect(shell).toMatch(/aria-atomic="true"/);
  // visually-hidden, not display:none -- a hidden region is not announced.
  expect(shell).toMatch(/id="a11y-announcer"[^>]*class="visually-hidden"/);
});
