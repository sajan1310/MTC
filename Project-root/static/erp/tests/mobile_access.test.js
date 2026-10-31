/**
 * Which pages the phone and tablet shell shows.
 *
 * The shell used to show every module to everyone: a custom role granted one
 * page still got all of them in the tab bar, the drawer, More, Home and
 * search, and each one answered "Not authorized" when tapped. The figures on
 * Home went to every role too.
 *
 * The real markup is used here, because what matters is what is left on the
 * screen once MApp.Access has been through it.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const VIEWS_HTML = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', 'mobile_views.html'), 'utf8'
);
const ROLES_PY = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'app', 'erp', 'services', 'roles_service.py'), 'utf8'
);

function template(id) {
  const open = VIEWS_HTML.indexOf(`<template id="${id}">`);
  const close = VIEWS_HTML.indexOf('</template>', open);
  return VIEWS_HTML.slice(VIEWS_HTML.indexOf('>', open) + 1, close)
    .replace(/\{%[\s\S]*?%\}/g, '')
    .replace(/\{\{[\s\S]*?\}\}/g, '');
}

function loadAsGlobal(relPath, exportName) {
  const code = fs
    .readFileSync(path.join(__dirname, '..', relPath), 'utf8')
    .replace(new RegExp(`^const ${exportName} = `, 'm'), `global.${exportName} = `);
  // eslint-disable-next-line no-eval
  eval(code);
}

const ADMIN = { role: 'admin', tabLevels: null, seesFigures: true, email: 'a@x.com', appVersion: '1.0.0' };
const USER = { role: 'user', tabLevels: null, seesFigures: false, email: 'u@x.com', appVersion: '1.0.0' };
const limited = levels => ({
  role: 'store_room', tabLevels: levels, seesFigures: false, email: 's@x.com', appVersion: '1.0.0'
});

function mount(user) {
  jest.resetModules();
  global.fetch = jest.fn();
  document.body.innerHTML = `
    <header class="mapp-topbar"><button id="mapp-menu-btn"></button><div id="mapp-topbar-title"></div></header>
    <main id="mapp-content"></main>
    <div class="mapp-drawer-backdrop" id="mapp-drawer-backdrop" hidden></div>
    <nav class="mapp-drawer" id="mapp-drawer" hidden><div id="mapp-drawer-body"></div></nav>
    <nav class="mapp-tabbar"><div class="mapp-tab-indicator" id="mapp-tab-indicator"></div></nav>
    <div id="mapp-sheet-backdrop"></div>
    <div class="mb-sheet" id="sheet-global-search">
      <input id="global-search-input"><div id="global-search-results"></div>
    </div>
    <div class="mb-sheet" id="sheet-tabbar"><div id="tabbar-note"></div><div id="tabbar-choices"></div></div>
    <div class="mb-toast-stack" id="mapp-toast-stack"></div>
    <template id="tpl-home">${template('tpl-home')}</template>
    <template id="tpl-more">${template('tpl-more')}</template>`;
  try { localStorage.clear(); } catch (e) { /* ignore */ }
  history.replaceState(null, '', '/erp/mobile');
  global.requestAnimationFrame = cb => cb();
  window.MOBILE_CURRENT_USER = user;
  loadAsGlobal('api.js', 'Api');
  loadAsGlobal('mobile.js', 'MApp');
  MApp.Sheet._stack = [];
  MApp.Api.call = jest.fn(async () => ({ success: true, data: [] }));
  MApp.Api.callCached = jest.fn(async () => ({ success: true, data: {} }));
  MApp.Returns.mount = jest.fn();
  MApp.Theme.render = jest.fn();
  MApp.SyncIssues.updateSummary = jest.fn();
}

afterEach(() => { delete window.MOBILE_CURRENT_USER; });

const content = () => document.getElementById('mapp-content');
const titles = () => [...content().querySelectorAll('.mb-card-title')].map(el => el.textContent.trim());
const sections = () => [...content().querySelectorAll('.mapp-group')].map(el => el.dataset.group);
const tabKeys = () => [...document.querySelectorAll('.mapp-tabbar .mapp-tab')]
  .map(b => b.id.replace('mapp-tab-', ''));
const drawerItems = () => {
  MApp.Drawer.render();
  return [...document.querySelectorAll('.mapp-drawer-item')].map(b => b.textContent.trim());
};

describe('the needs mirror the server', () => {
  const grantable = [...ROLES_PY.slice(
    ROLES_PY.indexOf('ASSIGNABLE_TABS = ['),
    ROLES_PY.indexOf('_ASSIGNABLE_TAB_KEYS')
  ).matchAll(/\("(\w+)",/g)].map(m => m[1]);

  beforeEach(() => mount(ADMIN));

  test('every need names a tab an admin can actually grant', () => {
    // A misspelt need would hide a page from everyone holding it, and nothing
    // on the server would ever say so.
    const words = ['full', 'admin', 'figures'];
    const needs = [
      ...MApp.Shortcuts.DESTINATIONS.map(d => d.needs),
      ...MApp.GlobalSearch.DESTINATIONS.map(d => d.needs),
      ...MApp.GlobalSearch.SOURCES.map(s => s.needs),
      ...Object.values(MApp.Shell.NEEDS)
    ].filter(Boolean).flatMap(n => n.split('|'));

    expect(needs.length).toBeGreaterThan(0);
    needs.forEach(need => expect(grantable.concat(words)).toContain(need));
  });

  test('every tab an admin can grant opens something on this shell', () => {
    const offered = new Set(MApp.Shortcuts.DESTINATIONS.map(d => d.needs)
      .concat(Object.values(MApp.Shell.NEEDS))
      .filter(Boolean)
      .flatMap(n => n.split('|')));

    grantable.forEach(tab => expect(offered.has(tab)).toBe(true));
  });

  test('every More row is a destination the catalogue knows', () => {
    MApp.Shell.showTab('more');
    const rows = [...content().querySelectorAll('[data-dest]')];

    expect(rows.length).toBeGreaterThan(15);
    rows.forEach(el => expect(MApp.Shortcuts.destination(el.dataset.dest)).not.toBeNull());
  });
});

describe('built-in roles', () => {
  test('an admin keeps everything', () => {
    mount(ADMIN);

    expect(MApp.Shortcuts.available()).toHaveLength(MApp.Shortcuts.DESTINATIONS.length);
    expect(MApp.TabBar.defaults()).toEqual(MApp.TabBar.DEFAULTS);
    MApp.Drawer.render();
    expect(document.querySelectorAll('#mapp-drawer-body .mapp-group')).toHaveLength(MApp.Drawer.GROUPS.length);
  });

  test('a User keeps every page, with no figures', () => {
    mount(USER);

    expect(MApp.Access.isLimited()).toBe(false);
    expect(MApp.Access.seesFigures()).toBe(false);
    expect(MApp.Shortcuts.available()).toHaveLength(MApp.Shortcuts.DESTINATIONS.length);
    expect(MApp.TabBar.defaults()).toEqual(MApp.TabBar.DEFAULTS);
  });

  test('admin screens are offered to admins only', () => {
    mount(USER);
    expect(MApp.GlobalSearch.destinations().map(d => d.label)).not.toContain('Custom Roles');

    mount(ADMIN);
    expect(MApp.GlobalSearch.destinations().map(d => d.label)).toContain('Custom Roles');
  });

  test('with no user on the page nothing is hidden', () => {
    // Every other test in this suite runs that way, and the server still
    // holds the gate.
    mount(undefined);

    expect(MApp.Access.seesFigures()).toBe(true);
    expect(MApp.Access.allows('admin')).toBe(true);
    expect(MApp.Access.allows('stockTab')).toBe(true);
  });
});

describe('a custom role sees only its own pages', () => {
  const STORE = limited({ stockTab: 'editor', billLedger: 'viewer' });

  test('the tab bar holds its screens and modules, and More', () => {
    mount(STORE);
    MApp.TabBar.render();

    expect(tabKeys()).toEqual(['home', 'stock', 'billLedger', 'pool', 'more']);
  });

  test('an inspector gets Home, Inspection and More', () => {
    mount(limited({ inspectionTab: 'editor' }));
    MApp.TabBar.render();

    expect(tabKeys()).toEqual(['home', 'inspection', 'more']);
  });

  test('tabs another person left on a shared phone are dropped', () => {
    mount(STORE);
    localStorage.setItem(MApp.TabBar.KEY, JSON.stringify(['home', 'production', 'dispatch', 'stock', 'poLedger']));

    expect(MApp.TabBar.read()).toEqual(['home', 'stock']);
  });

  test('nothing of theirs left in the stored tabs starts them from their own', () => {
    mount(STORE);
    localStorage.setItem(MApp.TabBar.KEY, JSON.stringify(['home', 'production', 'dispatch']));

    expect(MApp.TabBar.read()).toEqual(MApp.TabBar.defaults());
  });

  test('Choose your tabs offers only what the role can open', () => {
    mount(STORE);
    const keys = MApp.TabBar.choices().map(c => c.key);

    expect(keys).toEqual(expect.arrayContaining(['home', 'stock', 'more', 'billLedger', 'pool']));
    expect(keys).not.toContain('production');
    expect(keys).not.toContain('vendors');
  });

  test('the drawer lists its pages, and a group with none goes', () => {
    mount(STORE);
    const items = drawerItems();

    expect(items).toEqual(expect.arrayContaining(['Stock', 'Pool', 'Bills']));
    expect(items).not.toContain('Dispatch');
    expect(items).not.toContain('Vendors');
    expect(items).not.toContain('System Status');
    const groups = [...document.querySelectorAll('#mapp-drawer-body .mapp-group')].map(g => g.dataset.drawerGroup);
    expect(groups).not.toContain('production');
    expect(groups).not.toContain('directory');
    expect(groups).toContain('system');
  });

  test('a page it cannot open is not reachable by address', () => {
    mount(STORE);
    history.replaceState(null, '', '#production');

    expect(MApp.Shell.tabFromHash()).toBeNull();
    MApp.Shell.showTab('production');
    expect(MApp.Shell.current).not.toBe('production');
  });

  test('it does not reopen on the last person\'s tab', () => {
    mount(STORE);
    localStorage.setItem(MApp.Shell.LAST_TAB_KEY, 'dispatch');

    expect(MApp.Shell.resolveInitialTab()).toBe('home');
  });

  test('a shortcut to a page it cannot open does nothing', () => {
    mount(STORE);
    const open = jest.spyOn(MApp.Shortcuts.destination('vendors'), 'open');

    MApp.Shortcuts.go('vendors');

    expect(open).not.toHaveBeenCalled();
  });

  test('search holds only its screens, and asks only for its data', async () => {
    mount(STORE);

    await MApp.GlobalSearch._loadSources();

    const labels = MApp.GlobalSearch.destinations().map(d => d.label);
    expect(labels).toEqual(expect.arrayContaining(['Stock', 'Bill Ledger', 'Account']));
    expect(labels).not.toContain('Production');
    expect(labels).not.toContain('Dashboard');
    expect(MApp.Api.callCached.mock.calls.map(c => c[0])).toEqual(['getStockData']);
  });
});

describe('money', () => {
  test('an admin sees the amount', () => {
    mount(ADMIN);
    expect(MApp.Util.formatCurrency(1500)).toBe('₹1500.00');
  });

  test('anyone else sees a dash, never a zero that reads as a real figure', () => {
    mount(USER);
    expect(MApp.Util.formatCurrency(0)).toBe('—');

    mount(limited({ billLedger: 'viewer' }));
    expect(MApp.Util.formatCurrency(0)).toBe('—');
  });

  test('search offers no way into a form that carries prices', () => {
    mount(USER);
    const labels = MApp.GlobalSearch.destinations().map(d => d.label);

    expect(labels).not.toContain('New Dispatch');
    expect(labels).not.toContain('Log Return');
  });

  test('the priced new-entry buttons go, and Log Lot stays', () => {
    mount(USER);
    MApp.Shell.showTab('more');
    expect(content().textContent).not.toContain('Log Return');

    document.body.insertAdjacentHTML('beforeend', `
      <div id="fabs">
        <button class="mb-fab" data-needs="admin" id="fab-bill"></button>
        <button class="mb-fab" id="fab-wastage"></button>
      </div>`);
    MApp.Access.apply(document.getElementById('fabs'));

    expect(document.getElementById('fab-bill')).toBeNull();
    expect(document.getElementById('fab-wastage')).not.toBeNull();
  });
});

describe('the masters', () => {
  test('follow Items Master or Products & Processes', () => {
    mount(limited({ itemMaster: 'viewer' }));
    expect(MApp.Shortcuts.available().map(d => d.key)).toContain('units');

    mount(limited({ productsTab: 'editor' }));
    expect(MApp.Shortcuts.available().map(d => d.key)).toContain('colors');

    mount(limited({ dispatchTab: 'editor' }));
    expect(MApp.Shortcuts.available().map(d => d.key)).not.toContain('units');
  });
});

describe('the More tab', () => {
  test('an admin\'s is untouched', () => {
    mount(ADMIN);
    MApp.Shell.showTab('more');

    expect(sections()).toEqual(expect.arrayContaining(['master', 'returns', 'system', 'directory', 'products']));
    expect(MApp.Returns.mount).toHaveBeenCalled();
  });

  test('a custom role keeps its rows and loses empty sections', () => {
    mount(limited({ stockTab: 'viewer' }));
    MApp.Shell.showTab('more');

    expect(titles()).toEqual(expect.arrayContaining(['Warehouse Pool', 'Stock Groups', 'Sign Out']));
    expect(titles()).not.toContain('Vendors');
    expect(titles()).not.toContain('Only on desktop');
    expect(sections()).toEqual(expect.arrayContaining(['master', 'warehouse', 'sync', 'account']));
    ['directory', 'products', 'ledgers', 'lookup', 'system', 'logs', 'returns'].forEach(group => {
      expect(sections()).not.toContain(group);
    });
  });

  test('Returns is only fetched for a role that has it', () => {
    mount(limited({ stockTab: 'viewer' }));
    MApp.Shell.showTab('more');
    expect(MApp.Returns.mount).not.toHaveBeenCalled();

    mount(limited({ returnLedger: 'viewer' }));
    MApp.Shell.showTab('more');
    expect(MApp.Returns.mount).toHaveBeenCalled();
    expect(sections()).toContain('returns');
  });

  test('the About row needs no dashboard call', async () => {
    mount(USER);
    MApp.Shell.showTab('more');
    await Promise.resolve();

    expect(document.getElementById('more-about-line').textContent).toContain('Signed in as u@x.com');
    expect(MApp.Api.call).not.toHaveBeenCalledWith('getMobileDashboard');
  });
});

describe('Home', () => {
  const mountHome = async () => {
    MApp.Shell.showTab('home');
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  const figures = () => ['home-stats', 'home-dashboard', 'home-activity']
    .filter(id => document.getElementById(id));
  const quick = () => [...document.querySelectorAll('#home-quick .mb-quick-action span')]
    .map(el => el.textContent.trim());

  test('an admin gets the figures', async () => {
    mount(ADMIN);
    await mountHome();

    expect(figures()).toEqual(['home-stats', 'home-dashboard', 'home-activity']);
    expect(MApp.Api.callCached).toHaveBeenCalledWith('getMobileDashboard');
  });

  test('an admin gets every job', async () => {
    mount(ADMIN);
    await mountHome();

    expect(quick()).toEqual(['New PO', 'Receive Bill', 'New Lot', 'Dispatch', 'Issue Stock']);
  });

  test('a User keeps the jobs with no price in them, and nothing is fetched', async () => {
    mount(USER);
    await mountHome();

    expect(figures()).toEqual([]);
    expect(content().textContent).not.toContain('Choose figures');
    expect(content().textContent).not.toContain('Recent activity');
    expect(quick()).toEqual(['New Lot']);
    expect(MApp.Api.callCached).not.toHaveBeenCalled();
    expect(MApp.Api.call).not.toHaveBeenCalled();
  });

  test('a custom role needs Editor to start a job', async () => {
    mount(limited({ productionTab: 'editor' }));
    await mountHome();
    expect(quick()).toEqual(['New Lot']);
    expect(figures()).toEqual([]);

    mount(limited({ productionTab: 'viewer' }));
    await mountHome();
    expect(document.getElementById('home-quick')).toBeNull();
  });

  test('Editor on Bills is still not a way to start a bill', async () => {
    mount(limited({ billLedger: 'editor', poLedger: 'editor', dispatchTab: 'editor' }));
    await mountHome();

    expect(document.getElementById('home-quick')).toBeNull();
  });

  test('no jobs at all takes the heading with them', async () => {
    mount(limited({ stockTab: 'viewer' }));
    await mountHome();

    expect(document.getElementById('home-quick')).toBeNull();
    expect(document.getElementById('home-shortcuts').textContent).toContain('Pool');
  });

  test('a role granting nothing is told why the screen is empty', async () => {
    mount(limited({}));
    await mountHome();

    expect(document.getElementById('home-no-pages').hidden).toBe(false);
    expect(document.getElementById('home-goto').hidden).toBe(true);
    expect(tabKeys()).not.toContain('stock');
  });

  test('the note stays out of the way of a role with pages', async () => {
    mount(limited({ stockTab: 'viewer' }));
    await mountHome();

    expect(document.getElementById('home-no-pages')).toBeNull();
  });
});
