/**
 * The side drawer, and a tab bar the operator chooses.
 *
 * The tab bar holds five screens and cannot hold more -- five is the limit
 * at which targets stay thumb-sized at 360px. Everything else lived behind
 * More, then a disclosure, then a row. The drawer is the other half of the
 * answer: one tap from any screen, every module in it, grouped by the job
 * rather than by which module owns the record.
 *
 * And the five slots themselves are now a choice. They are the most
 * valuable space in the app, and a storeman who lives in Bills and Items
 * and never opens Production was spending three of them on nothing.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SHELL_HTML = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'mobile.html'), 'utf8'
);
const VIEWS_HTML = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', 'mobile_views.html'), 'utf8'
);

function loadAsGlobal(relPath, exportName) {
  const code = fs
    .readFileSync(path.join(__dirname, '..', relPath), 'utf8')
    .replace(new RegExp(`^const ${exportName} = `, 'm'), `global.${exportName} = `);
  // eslint-disable-next-line no-eval
  eval(code);
}

function mount() {
  jest.resetModules();
  global.fetch = jest.fn();
  document.body.innerHTML = `
    <header class="mapp-topbar">
      <button id="mapp-menu-btn" aria-expanded="false"></button>
      <div id="mapp-topbar-title">Home</div>
    </header>
    <main id="mapp-content"></main>
    <div class="mapp-drawer-backdrop" id="mapp-drawer-backdrop" hidden></div>
    <nav class="mapp-drawer" id="mapp-drawer" hidden>
      <div class="mapp-drawer-body" id="mapp-drawer-body"></div>
    </nav>
    <nav class="mapp-tabbar"><div class="mapp-tab-indicator" id="mapp-tab-indicator"></div></nav>
    <div id="mapp-sheet-backdrop"></div>
    <div class="mb-sheet" id="sheet-tabbar">
      <div id="tabbar-note"></div>
      <div id="tabbar-choices"></div>
    </div>
    <div class="mb-toast-stack" id="mapp-toast-stack"></div>`;
  try { localStorage.clear(); } catch (e) { /* ignore */ }
  global.requestAnimationFrame = cb => cb();
  loadAsGlobal('api.js', 'Api');
  loadAsGlobal('mobile.js', 'MApp');
  MApp.Sheet._stack = [];
}

const groups = () => [...document.querySelectorAll('#mapp-drawer-body .mapp-group')];
const items = () => [...document.querySelectorAll('.mapp-drawer-item')].map(b => b.textContent.trim());
const tabs = () => [...document.querySelectorAll('.mapp-tabbar .mapp-tab')].map(b => b.id);

describe('the drawer', () => {
  beforeEach(mount);

  test('the shell has a menu button wired to it', () => {
    expect(SHELL_HTML).toContain('MApp.Drawer.toggle()');
    expect(SHELL_HTML).toContain('id="mapp-drawer"');
    expect(SHELL_HTML).toContain('id="mapp-drawer-body"');
  });

  test('opening it renders every group', () => {
    MApp.Drawer.open();
    expect(groups()).toHaveLength(MApp.Drawer.GROUPS.length);
  });

  test('groups are <details>, so the disclosure is the platform\'s', () => {
    // Not a hand-rolled toggle: the keyboard handling and aria-expanded
    // semantics come free, and the sections still open if JS never runs.
    MApp.Drawer.open();
    groups().forEach(g => expect(g.tagName).toBe('DETAILS'));
  });

  test('every module in the Shortcuts catalogue appears somewhere in it', () => {
    // "every module in the sidebar" -- a destination reachable from the
    // learned Go-to row but absent here would be a module with no home.
    MApp.Drawer.open();
    const shown = items();
    MApp.Shortcuts.DESTINATIONS.forEach(d => {
      expect(shown).toContain(d.label);
    });
  });

  test('Return Goods is in it', () => {
    MApp.Drawer.open();
    expect(items()).toContain('Return Goods');
  });

  test('the four tab screens are in it too', () => {
    // Which destinations are screens and which are sheets is an internal
    // detail; somebody looking for Dispatch should not have to know.
    MApp.Drawer.open();
    const shown = items().join('|');
    ['Production lots', 'Stock', 'Dispatch'].forEach(l => expect(shown).toContain(l));
  });

  test('closing hides the drawer and its backdrop', () => {
    MApp.Drawer.open();
    MApp.Drawer.close();

    expect(document.getElementById('mapp-drawer').hidden).toBe(true);
    expect(document.getElementById('mapp-drawer-backdrop').hidden).toBe(true);
    expect(document.getElementById('mapp-menu-btn').getAttribute('aria-expanded')).toBe('false');
  });

  test('Escape closes it', () => {
    MApp.Drawer.open();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.getElementById('mapp-drawer').hidden).toBe(true);
  });

  test('which groups are open is remembered', () => {
    MApp.Drawer.open();
    const g = groups()[0];
    const key = g.dataset.drawerGroup;
    g.open = false;
    g.dispatchEvent(new Event('toggle'));

    MApp.Drawer.close();
    MApp.Drawer.open();

    expect(document.querySelector(`[data-drawer-group="${key}"]`).open).toBe(false);
  });

  test('opening a module from it counts towards the Go-to ranking', () => {
    // Otherwise the two navigation surfaces would disagree about what this
    // operator actually uses.
    const dest = MApp.Shortcuts.destination('wastage');
    dest.open = jest.fn();
    MApp.Drawer.open();

    MApp.Drawer.goModule('wastage');

    expect(MApp.Shortcuts.counts().wastage).toBe(1);
    expect(dest.open).toHaveBeenCalled();
    expect(document.getElementById('mapp-drawer').hidden).toBe(true);
  });

  test('a screen entry navigates instead of opening a sheet', () => {
    MApp.Shell.showTab = jest.fn();
    MApp.Drawer.open();

    MApp.Drawer.goTab('dispatch');

    expect(MApp.Shell.showTab).toHaveBeenCalledWith('dispatch');
  });
});

describe('choosing your tabs', () => {
  beforeEach(mount);

  test('the default five are unchanged', () => {
    MApp.TabBar.render();
    expect(tabs()).toEqual([
      'mapp-tab-home', 'mapp-tab-stock', 'mapp-tab-production',
      'mapp-tab-dispatch', 'mapp-tab-more',
    ]);
  });

  test('a saved choice is what renders', () => {
    MApp.TabBar.write(['home', 'billLedger', 'itemsLookup']);
    MApp.TabBar.render();

    expect(tabs()).toEqual(['mapp-tab-home', 'mapp-tab-billLedger', 'mapp-tab-itemsLookup']);
  });

  test('the indicator narrows to match the count', () => {
    // It spans one slot. Left at 20% with three tabs it would sit under a
    // third of a tab and look broken.
    MApp.TabBar.write(['home', 'stock', 'production']);
    MApp.TabBar.render();

    expect(document.getElementById('mapp-tab-indicator').style.width)
      .toBe(`${100 / 3}%`);
  });

  test('Home cannot be removed, even by editing storage', () => {
    MApp.TabBar.write(['stock', 'production']);
    expect(MApp.TabBar.visible()[0]).toBe('home');
  });

  test('a key from an older build leaves no dead slot', () => {
    MApp.TabBar.write(['home', 'stock', 'someRetiredModule']);
    expect(MApp.TabBar.visible()).toEqual(['home', 'stock']);
  });

  test('a module tab is not given a false selected state', () => {
    // role=tab + aria-selected would claim it is one of the screens the
    // tablist switches between. It opens a sheet over whatever is showing.
    MApp.TabBar.write(['home', 'billLedger']);
    MApp.TabBar.render();

    const modTab = document.getElementById('mapp-tab-billLedger');
    expect(modTab.hasAttribute('role')).toBe(false);
    expect(modTab.hasAttribute('aria-selected')).toBe(false);
  });

  test('a screen whose tab is hidden still opens, with no indicator', () => {
    // Reachable by hash or from the drawer. An indicator pointing at a slot
    // that is not there would be worse than none.
    MApp.TabBar.write(['home', 'more']);
    MApp.TabBar.render();

    MApp.Shell.paintTabs('stock');

    expect(document.getElementById('mapp-tab-indicator').style.visibility).toBe('hidden');
  });

  test('the customiser refuses a sixth tab, and says why', () => {
    const spy = jest.spyOn(MApp.Toast, 'error');
    MApp.TabBar.open();

    MApp.TabBar.toggle('billLedger');

    expect(spy).toHaveBeenCalled();
    expect(MApp.TabBar.draft).toHaveLength(5);
  });

  test('and refuses to go below the minimum', () => {
    MApp.TabBar.write(['home', 'stock']);
    MApp.TabBar.open();
    const spy = jest.spyOn(MApp.Toast, 'error');

    MApp.TabBar.toggle('stock');

    expect(spy).toHaveBeenCalled();
    expect(MApp.TabBar.draft).toEqual(['home', 'stock']);
  });

  test('saving takes effect without a reload', () => {
    MApp.TabBar.open();
    MApp.TabBar.toggle('more');
    MApp.TabBar.save();

    expect(tabs()).not.toContain('mapp-tab-more');
    expect(MApp.TabBar.visible()).not.toContain('more');
  });

  test('reset restores the default five', () => {
    MApp.TabBar.write(['home', 'billLedger']);
    MApp.TabBar.open();
    MApp.TabBar.reset();

    expect(MApp.TabBar.draft).toEqual(MApp.TabBar.DEFAULTS);
  });

  test('it is reachable from the More tab', () => {
    expect(VIEWS_HTML).toContain('MApp.TabBar.open()');
    expect(VIEWS_HTML).toContain('id="sheet-tabbar"');
  });
});
