/**
 * Regression test for App.Navigation's tab routing (../core.js).
 *
 * The bug: which module you were on was remembered *only* in
 * localStorage, which is shared by every browser tab on the origin. Two
 * tabs open on two modules overwrote each other's entry, so whichever
 * module was clicked most recently anywhere is where *both* tabs landed
 * on their next reload -- a tab parked on Purchase would come back on
 * Production because the other tab had been there since.
 *
 * The fix puts the tab id in the URL hash, which is genuinely per-browser
 * tab, and demotes localStorage to the fallback for a tab opened without
 * one. Loaded against the real source via the const-rewrite require()
 * technique nav.test.js established.
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

// The nav buttons are what isValidTab checks against -- usersTab is
// deliberately left out to stand in for a role-gated tab that isn't
// rendered for this user.
function buildShell() {
  document.body.innerHTML = `
    <div id="mainTabs">
      <button id="btn-dashboardTab" class="nav-link active" data-tab="dashboardTab"></button>
      <button id="btn-poLedger" class="nav-link" data-tab="poLedger"></button>
      <button id="btn-productionTab" class="nav-link" data-tab="productionTab"></button>
    </div>
    <div class="tab-content" id="dashboardTab"></div>
    <div class="tab-content" id="poLedger"></div>
    <div class="tab-content" id="productionTab"></div>`;
}

function setHash(hash) {
  history.replaceState(null, '', hash || '/erp');
}

describe('App.Navigation tab routing', () => {
  beforeEach(() => {
    setHash('/erp');
    localStorage.clear();
    document.body.innerHTML = '';
    loadCoreAsGlobal();
    buildShell();
  });

  describe('resolveInitialTab', () => {
    test('a valid hash wins over a conflicting localStorage entry', () => {
      // The other browser tab was on Production and wrote the shared key
      // last; this tab's own URL still says Purchase.
      localStorage.setItem(App.Navigation.LAST_TAB_KEY, 'productionTab');
      setHash('#poLedger');

      expect(App.Navigation.resolveInitialTab()).toBe('poLedger');
    });

    test('falls back to localStorage when there is no hash', () => {
      localStorage.setItem(App.Navigation.LAST_TAB_KEY, 'poLedger');
      expect(App.Navigation.resolveInitialTab()).toBe('poLedger');
    });

    test('falls back to localStorage when the hash names an unknown tab', () => {
      localStorage.setItem(App.Navigation.LAST_TAB_KEY, 'poLedger');
      setHash('#notARealTab');
      expect(App.Navigation.resolveInitialTab()).toBe('poLedger');
    });

    test('falls back to Dashboard for a role-gated tab whose button is absent', () => {
      localStorage.setItem(App.Navigation.LAST_TAB_KEY, 'usersTab');
      expect(App.Navigation.resolveInitialTab()).toBe('dashboardTab');
    });

    test('falls back to Dashboard with neither hash nor stored tab', () => {
      expect(App.Navigation.resolveInitialTab()).toBe('dashboardTab');
    });
  });

  describe('the two-tab reload scenario', () => {
    test('each tab reloads onto its own module despite one shared localStorage', () => {
      // Tab A visits Purchase, then tab B visits Production. Both writes
      // land in the one shared key -- last writer wins, as before.
      App.Navigation.showTab('poLedger');
      const tabAHash = location.hash;
      App.Navigation.showTab('productionTab');
      const tabBHash = location.hash;

      expect(localStorage.getItem(App.Navigation.LAST_TAB_KEY)).toBe('productionTab');

      // Tab A reloads: its *own* URL, not the shared key, decides.
      setHash(tabAHash);
      expect(App.Navigation.resolveInitialTab()).toBe('poLedger');

      // Tab B reloads and is unaffected.
      setHash(tabBHash);
      expect(App.Navigation.resolveInitialTab()).toBe('productionTab');
    });
  });

  describe('showTab', () => {
    test('publishes the tab id to the URL hash', () => {
      App.Navigation.showTab('poLedger');
      expect(location.hash).toBe('#poLedger');
      expect(App.Navigation.current).toBe('poLedger');
    });

    test('still writes localStorage, so a hashless new tab has a fallback', () => {
      App.Navigation.showTab('productionTab');
      expect(localStorage.getItem(App.Navigation.LAST_TAB_KEY)).toBe('productionTab');
    });

    test('a normal switch pushes a history entry so Back returns to the previous tab', () => {
      const push = jest.spyOn(history, 'pushState');
      App.Navigation.showTab('poLedger');
      expect(push).toHaveBeenCalledWith(null, '', '#poLedger');
      push.mockRestore();
    });

    test('the boot-time restore replaces instead, leaving no synthetic entry', () => {
      const push = jest.spyOn(history, 'pushState');
      const replace = jest.spyOn(history, 'replaceState');

      App.Navigation.showTab('poLedger', { replace: true });

      expect(replace).toHaveBeenCalledWith(null, '', '#poLedger');
      expect(push).not.toHaveBeenCalled();
      push.mockRestore();
      replace.mockRestore();
    });

    test('re-showing the tab already in the URL writes no history entry at all', () => {
      App.Navigation.showTab('poLedger');
      const push = jest.spyOn(history, 'pushState');

      App.Navigation.showTab('poLedger');

      expect(push).not.toHaveBeenCalled();
      push.mockRestore();
    });

    test('shows only the target tab and marks only its nav button active', () => {
      App.Navigation.showTab('poLedger');

      expect(document.getElementById('poLedger').style.display).toBe('block');
      expect(document.getElementById('productionTab').style.display).toBe('none');
      expect(document.getElementById('btn-poLedger').classList.contains('active')).toBe(true);
      expect(document.getElementById('btn-dashboardTab').classList.contains('active')).toBe(false);
    });
  });

  describe('handleHashChange', () => {
    test('back/forward to another tab switches to it', () => {
      App.Navigation.showTab('poLedger');
      setHash('#productionTab');

      App.Navigation.handleHashChange();

      expect(App.Navigation.current).toBe('productionTab');
      expect(document.getElementById('productionTab').style.display).toBe('block');
    });

    test('a hash already matching the visible tab is ignored', () => {
      App.Navigation.showTab('poLedger');
      const spy = jest.spyOn(App.Navigation, 'showTab');

      App.Navigation.handleHashChange();

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    test('an unknown hash leaves the current tab alone', () => {
      App.Navigation.showTab('poLedger');
      setHash('#garbage');

      App.Navigation.handleHashChange();

      expect(App.Navigation.current).toBe('poLedger');
    });

    test('a bare "#" from an href="#" anchor does not disturb the tab', () => {
      App.Navigation.showTab('poLedger');
      setHash('#');

      App.Navigation.handleHashChange();

      expect(App.Navigation.current).toBe('poLedger');
    });
  });
});
