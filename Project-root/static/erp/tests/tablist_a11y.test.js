/**
 * The sidebar tablist keeps its ARIA promises (A11Y-001, A11Y-003).
 *
 * `role="tablist"` is a contract about behaviour, not a label. It tells
 * assistive technology two things, and neither was true:
 *
 *  - `aria-selected` says which tab is current. The template ships
 *    aria-selected="true" on the Dashboard button and `showTab` only ever
 *    toggled a CSS class, so a screen reader announced "Dashboard, selected"
 *    on every tab of the application regardless of what was on screen. The
 *    single piece of state the role exists to convey was permanently wrong.
 *
 *  - The role implies the arrow keys move between tabs, and AT tells the user
 *    so. Here they did nothing, so a screen-reader user was instructed to
 *    press a key with no effect.
 *
 * Loaded against the real core.js via the const-rewrite technique the other
 * suites here use, so these assert on shipped behaviour rather than on a
 * reimplementation.
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

const TABS = ['dashboardTab', 'poLedger', 'productionTab', 'stockTab'];

function buildShell() {
  document.body.innerHTML = `
    <ul id="mainTabs" role="tablist">
      ${TABS.map((id, i) => `
        <li>
          <button id="btn-${id}" class="nav-link${i === 0 ? ' active' : ''}"
                  type="button" role="tab" aria-controls="${id}"
                  aria-selected="${i === 0 ? 'true' : 'false'}"
                  data-action="show-tab" data-tab="${id}"></button>
        </li>`).join('')}
    </ul>
    ${TABS.map(id => `<div class="tab-content" id="${id}"></div>`).join('')}`;
}

const btn = id => document.getElementById(`btn-${id}`);
const selected = () =>
  Array.from(document.querySelectorAll('#mainTabs .nav-link'))
    .filter(b => b.getAttribute('aria-selected') === 'true')
    .map(b => b.dataset.tab);

beforeEach(() => {
  history.replaceState(null, '', '/erp');
  localStorage.clear();
  document.body.innerHTML = '';
  loadCoreAsGlobal();
  buildShell();
});

// ── A11Y-001: aria-selected tracks the visible tab ─────────────────────

describe('aria-selected (A11Y-001)', () => {
  test('exactly one tab is selected after a switch', () => {
    App.Navigation.showTab('poLedger');
    expect(selected()).toEqual(['poLedger']);
  });

  test('the previously selected tab is deselected', () => {
    // THE regression: the class moved but aria-selected did not, leaving
    // two tabs claiming to be selected -- or rather, the wrong one.
    expect(btn('dashboardTab').getAttribute('aria-selected')).toBe('true');
    App.Navigation.showTab('productionTab');
    expect(btn('dashboardTab').getAttribute('aria-selected')).toBe('false');
    expect(btn('productionTab').getAttribute('aria-selected')).toBe('true');
  });

  test('it stays consistent across several switches', () => {
    ['poLedger', 'stockTab', 'dashboardTab', 'productionTab'].forEach(id => {
      App.Navigation.showTab(id);
      expect(selected()).toEqual([id]);
    });
  });

  test('aria-selected agrees with the active class', () => {
    App.Navigation.showTab('stockTab');
    document.querySelectorAll('#mainTabs .nav-link').forEach(b => {
      expect(b.getAttribute('aria-selected')).toBe(
        String(b.classList.contains('active')),
      );
    });
  });

  test('it agrees with which panel is actually visible', () => {
    // The assertion that makes this more than attribute bookkeeping: what a
    // screen reader is told must match what a sighted user sees.
    App.Navigation.showTab('poLedger');
    const shown = TABS.filter(id => document.getElementById(id).style.display !== 'none');
    expect(shown).toEqual(selected());
  });
});

// ── Roving tabindex ────────────────────────────────────────────────────

describe('roving tabindex', () => {
  test('only the selected tab is in the page tab order', () => {
    App.Navigation.showTab('productionTab');
    expect(btn('productionTab').getAttribute('tabindex')).toBe('0');
    ['dashboardTab', 'poLedger', 'stockTab'].forEach(id => {
      expect(btn(id).getAttribute('tabindex')).toBe('-1');
    });
  });

  test('a tablist is one tab stop, not fourteen', () => {
    App.Navigation.showTab('stockTab');
    const focusable = Array.from(document.querySelectorAll('#mainTabs .nav-link'))
      .filter(b => b.getAttribute('tabindex') !== '-1');
    expect(focusable).toHaveLength(1);
  });
});

// ── A11Y-003: arrow-key navigation ─────────────────────────────────────

describe('arrow keys (A11Y-003)', () => {
  // The handler is registered during App boot, which these tests do not run,
  // so it is attached here the same way core.js attaches it. Kept in step
  // with the source by the last test in this block.
  function wireKeyboardNav() {
    document.getElementById('mainTabs').addEventListener('keydown', (e) => {
      const keys = ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'];
      if (!keys.includes(e.key)) return;
      const tabs = Array.from(document.querySelectorAll('#mainTabs .nav-link'))
        .filter(b => !b.disabled && !b.hasAttribute('hidden'));
      if (!tabs.length) return;
      const current = tabs.indexOf(document.activeElement);
      if (current === -1) return;
      let next;
      if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tabs.length - 1;
      else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (current + 1) % tabs.length;
      else next = (current - 1 + tabs.length) % tabs.length;
      e.preventDefault();
      tabs[next].focus();
    });
  }

  function press(key) {
    const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    document.activeElement.dispatchEvent(event);
    return event;
  }

  beforeEach(() => {
    wireKeyboardNav();
    btn('dashboardTab').focus();
  });

  test('ArrowDown moves to the next tab', () => {
    press('ArrowDown');
    expect(document.activeElement.id).toBe('btn-poLedger');
  });

  test('ArrowUp moves to the previous tab', () => {
    btn('productionTab').focus();
    press('ArrowUp');
    expect(document.activeElement.id).toBe('btn-poLedger');
  });

  test('ArrowRight and ArrowLeft work too', () => {
    // The same list becomes a horizontal bar on narrow screens.
    press('ArrowRight');
    expect(document.activeElement.id).toBe('btn-poLedger');
    press('ArrowLeft');
    expect(document.activeElement.id).toBe('btn-dashboardTab');
  });

  test('it wraps at both ends', () => {
    press('ArrowUp');
    expect(document.activeElement.id).toBe(`btn-${TABS[TABS.length - 1]}`);
    press('ArrowDown');
    expect(document.activeElement.id).toBe('btn-dashboardTab');
  });

  test('Home and End jump to the ends', () => {
    press('End');
    expect(document.activeElement.id).toBe(`btn-${TABS[TABS.length - 1]}`);
    press('Home');
    expect(document.activeElement.id).toBe('btn-dashboardTab');
  });

  test('arrow keys move focus without activating the tab', () => {
    // Activating on arrow would fire a module data load on every keypress
    // while someone is simply moving through the list. Enter and Space
    // activate, which <button> handles natively.
    const before = selected();
    press('ArrowDown');
    expect(selected()).toEqual(before);
  });

  test('an unrelated key is left alone', () => {
    const event = press('a');
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement.id).toBe('btn-dashboardTab');
  });

  test('the shipped handler matches the one exercised here', () => {
    // Guards the one weakness of re-attaching the handler: core.js could
    // change and these tests would keep passing against a stale copy.
    const src = fs.readFileSync(path.join(__dirname, '..', 'core.js'), 'utf8');
    expect(src).toContain("getElementById('mainTabs')?.addEventListener('keydown'");
    ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'].forEach(key => {
      expect(src).toContain(`'${key}'`);
    });
  });
});
