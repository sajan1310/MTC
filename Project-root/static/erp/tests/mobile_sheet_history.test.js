/**
 * Sheets must participate in browser history (Phase 0).
 *
 * Sheets are MApp's entire secondary navigation -- Log Lot, New Dispatch,
 * Log Return, ~20 of them -- and none of them used to push a history entry.
 * There was no `popstate` handler anywhere in mobile.js, so Android's
 * hardware Back and iOS's back-swipe fell through to MApp.Shell's hash
 * router: Back on an open Log Lot form switched the tab BEHIND the sheet,
 * or exited the PWA on the first entry. Either way the half-entered lot was
 * gone, with no warning and no recovery. That is the data-loss defect these
 * tests exist to keep fixed.
 *
 * Loaded the same way as outbox_chaos.test.js: mobile.js is a plain classic
 * browser script whose public surface is a top-level `const MApp`, so the
 * declaration keyword is rewritten to a global assignment and the file is
 * eval'd. The logic under test is the real, unmodified implementation.
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

// jsdom queues popstate as a task rather than firing it inline, so a bare
// setTimeout(0) can land before it. Wait for the event itself, then yield
// one more tick so MApp's own listener -- registered at load time, and
// therefore ahead of this one -- has already run. Races a timeout so a
// popstate that never arrives fails loudly instead of hanging the suite.
function goBack() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('popstate never fired')), 1000);
    window.addEventListener('popstate', () => {
      clearTimeout(timer);
      setTimeout(resolve, 0);
    }, { once: true });
    window.history.back();
  });
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

// The sheets themselves live in mobile_views.html and are cloned into the
// page by Flask, not by mobile.js -- so the fixture only needs the ids and
// the .open class contract that MApp.Sheet actually touches.
function buildFixture() {
  document.body.innerHTML = `
    <div id="mapp-sheet-backdrop"></div>
    <div class="mb-sheet" id="sheet-log-lot"></div>
    <div class="mb-sheet" id="sheet-entity-form"></div>
    <div class="mb-sheet mb-picker-screen" id="mapp-picker-sheet">
      <h2 id="mapp-picker-title"></h2>
      <div id="mapp-picker-search-wrap"><input id="mapp-picker-search"></div>
      <div id="mapp-picker-list"></div>
    </div>`;
}

const isOpen = id => document.getElementById(id).classList.contains('open');

describe('MApp.Sheet history integration', () => {
  beforeEach(() => {
    jest.resetModules();
    global.fetch = jest.fn();
    buildFixture();
    // api.js first: mobile.js's top level reads Api.call/Api.mutate.
    loadAsGlobal('api.js', 'Api');
    loadAsGlobal('mobile.js', 'MApp');
    // Each eval re-registers popstate/keydown listeners on the same jsdom
    // window, so reset the stack rather than leaking sheets between tests.
    MApp.Sheet._stack = [];
  });

  test('opening a sheet pushes exactly one history entry', () => {
    const before = window.history.length;
    MApp.Sheet.open('sheet-log-lot');

    expect(isOpen('sheet-log-lot')).toBe(true);
    expect(window.history.length).toBe(before + 1);
  });

  test('Back closes the open sheet instead of falling through to the tab router', async () => {
    MApp.Sheet.open('sheet-log-lot');
    expect(isOpen('sheet-log-lot')).toBe(true);

    await goBack();

    expect(isOpen('sheet-log-lot')).toBe(false);
    expect(MApp.Sheet._stack).toHaveLength(0);
    // The backdrop must come down with the last sheet, or the app is left
    // with an invisible click-blocker over the whole screen.
    expect(document.getElementById('mapp-sheet-backdrop').classList.contains('open')).toBe(false);
  });

  test('nested sheets unwind one Back press at a time, newest first', async () => {
    MApp.Sheet.open('sheet-entity-form');
    MApp.Sheet.open('sheet-log-lot');

    await goBack();

    // Only the top one closed -- the sheet underneath is still open.
    expect(isOpen('sheet-log-lot')).toBe(false);
    expect(isOpen('sheet-entity-form')).toBe(true);
    expect(MApp.Sheet._stack).toHaveLength(1);

    await goBack();

    expect(isOpen('sheet-entity-form')).toBe(false);
    expect(MApp.Sheet._stack).toHaveLength(0);
  });

  test('closing via the X button steps off its history entry, so the next Back is not a dead press', async () => {
    // jsdom keeps ONE session history for the whole file, so earlier tests
    // have already left {mappSheet:'sheet-log-lot'} entries behind us.
    // Anchor on a sentinel entry pushed here, so "did we step back off our
    // own entry" is answerable without matching a previous test's state.
    window.history.pushState({ sentinel: 'before-sheet' }, '');

    MApp.Sheet.open('sheet-log-lot');
    expect(window.history.state).toEqual({ mappSheet: 'sheet-log-lot' });

    // close() pops the entry via history.back(), which jsdom queues -- so
    // wait for the resulting popstate rather than guessing a tick count.
    // MApp's own handler sees an already-empty stack and correctly no-ops.
    const popped = new Promise(resolve => window.addEventListener('popstate', resolve, { once: true }));
    MApp.Sheet.close('sheet-log-lot');
    await popped;
    await settle();

    expect(isOpen('sheet-log-lot')).toBe(false);
    // history.length does NOT shrink on back() -- in any browser -- because
    // the entry still exists ahead of the pointer. What matters is that the
    // sheet's entry is no longer the CURRENT one: if it were, the user's
    // next Back press would be spent stepping off an entry whose sheet is
    // already closed, and would look like a Back that did nothing.
    expect(window.history.state).toEqual({ sentinel: 'before-sheet' });
  });

  test('a popstate with no open sheet is left alone for Shell hashchange to handle', async () => {
    // Shell's own tab entries must still work: MApp.Sheet has to ignore
    // any popstate that is not one of its own.
    window.history.pushState(null, '', '#stock');
    const spy = jest.spyOn(MApp.Sheet, 'dismissTop');

    window.history.back();
    await settle();

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('Escape closes the top sheet', () => {
    MApp.Sheet.open('sheet-log-lot');

    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(isOpen('sheet-log-lot')).toBe(false);
    expect(MApp.Sheet._stack).toHaveLength(0);
  });

  test('Escape with no sheet open does nothing', () => {
    expect(() => {
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }).not.toThrow();
    expect(MApp.Sheet._stack).toHaveLength(0);
  });

  test('dismissing a Picker with Back settles its pending promise instead of hanging the caller', async () => {
    // MApp.Picker.open() returns a promise that every caller awaits. If a
    // Back press closed the DOM without settling it, the awaiting flow
    // (a Log Lot cascade step, say) would wait forever.
    const pending = MApp.Picker.open({ title: 'Choose a size', items: [{ value: '26', label: '26 inch' }] });

    await goBack();

    await expect(pending).resolves.toBeNull();
    expect(isOpen('mapp-picker-sheet')).toBe(false);
  });
});
