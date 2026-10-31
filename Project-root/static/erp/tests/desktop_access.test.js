/**
 * Which pages the desktop shell opens, and who the Dashboard's figures go to.
 *
 * index.html leaves a custom role's other sidebar buttons out, but every
 * content panel stays in the DOM, so anything that called showTab directly
 * opened an empty page the server then refused. And the shell always started
 * on the Dashboard, which a custom role no longer has.
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

function loadDashboard() {
  // eslint-disable-next-line no-eval
  eval(fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8'));
}

function shell({ access, figures, tabs }) {
  document.head.innerHTML = `
    <meta name="current-user-access" content="${access}">
    <meta name="current-user-figures" content="${figures}">`;
  document.body.innerHTML = `
    <ul id="mainTabs">${tabs.map(id => `
      <li><button id="btn-${id}" class="nav-link" data-tab="${id}"></button></li>`).join('')}
    </ul>
    <div class="tab-content active" id="dashboardTab"></div>
    <div class="tab-content" id="poLedger"></div>
    <div class="tab-content" id="stockTab"></div>
    <div class="tab-content" id="productionTab"></div>`;
}

beforeEach(() => {
  history.replaceState(null, '', '/erp');
  localStorage.clear();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  loadCoreAsGlobal();
  loadDashboard();
  global.Api = { call: jest.fn(async () => ({ success: true, data: [] })) };
  App.State = App.State || {};
  App.State.globalStock = [];
  App.State.globalPOs = [];
});

describe('where a custom role lands', () => {
  test('its first page, as it has no Dashboard', () => {
    shell({ access: 'limited', figures: 'no', tabs: ['stockTab', 'productionTab'] });

    expect(App.Navigation.resolveInitialTab()).toBe('stockTab');
  });

  test('a stored Dashboard from the last person is not restored', () => {
    shell({ access: 'limited', figures: 'no', tabs: ['poLedger'] });
    localStorage.setItem(App.Navigation.LAST_TAB_KEY, 'dashboardTab');

    expect(App.Navigation.resolveInitialTab()).toBe('poLedger');
  });

  test('no page at all stays on the panel that explains', () => {
    shell({ access: 'limited', figures: 'no', tabs: [] });

    expect(App.Navigation.resolveInitialTab()).toBeNull();
    App.Navigation.showTab(App.Navigation.resolveInitialTab());
    expect(document.getElementById('dashboardTab').classList.contains('active')).toBe(true);
    expect(document.getElementById('dashboardTab').style.display).toBe('');
  });

  test('a full account still lands on the Dashboard', () => {
    shell({ access: 'full', figures: 'no', tabs: ['dashboardTab', 'poLedger'] });

    expect(App.Navigation.resolveInitialTab()).toBe('dashboardTab');
  });
});

describe('a page the account does not have', () => {
  test('showTab leaves the current page alone', () => {
    shell({ access: 'limited', figures: 'no', tabs: ['stockTab'] });
    App.Navigation.showTab('stockTab');

    App.Navigation.showTab('poLedger');

    expect(App.Navigation.current).toBe('stockTab');
    expect(document.getElementById('poLedger').style.display).toBe('none');
    expect(location.hash).toBe('#stockTab');
  });
});

describe('alerts', () => {
  test('a custom role is not asked about pages it cannot open', async () => {
    shell({ access: 'limited', figures: 'no', tabs: ['productionTab'] });
    App.PO = { ensureLoaded: jest.fn() };

    await App.Notify.checkSmartAlerts();
    await App.Notify.checkBackendAlerts();

    expect(Api.call).not.toHaveBeenCalled();
    expect(App.PO.ensureLoaded).not.toHaveBeenCalled();
  });

  test('a custom role with Stock still gets the stock alert', async () => {
    shell({ access: 'limited', figures: 'no', tabs: ['stockTab'] });
    App.PO = { ensureLoaded: jest.fn() };

    await App.Notify.checkSmartAlerts();

    expect(Api.call).toHaveBeenCalledWith('getStockData');
    expect(App.PO.ensureLoaded).not.toHaveBeenCalled();
  });

  test('a full account is asked as before', async () => {
    shell({ access: 'full', figures: 'no', tabs: ['dashboardTab'] });
    App.PO = { ensureLoaded: jest.fn() };

    await App.Notify.checkSmartAlerts();
    await App.Notify.checkBackendAlerts();

    expect(Api.call).toHaveBeenCalledWith('getStockData');
    expect(Api.call).toHaveBeenCalledWith('getRecentNotificationLogs');
    expect(App.PO.ensureLoaded).toHaveBeenCalled();
  });
});

describe('money', () => {
  function loadApi() {
    const code = fs
      .readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8')
      .replace(/^const Api = /m, 'global.Api = ');
    // eslint-disable-next-line no-eval
    eval(`${code}; global.formatCurrency = formatCurrency;`);
  }

  test('an admin sees the amount', () => {
    shell({ access: 'full', figures: 'yes', tabs: ['dashboardTab'] });
    loadApi();

    expect(global.formatCurrency(1500)).toBe('₹1500.00');
  });

  test('anyone else sees a dash', () => {
    shell({ access: 'full', figures: 'no', tabs: ['dashboardTab'] });
    loadApi();

    expect(global.formatCurrency(0)).toBe('—');
  });

  test('the phone shell, which shares this file, follows its own user', () => {
    shell({ access: 'full', figures: 'yes', tabs: ['dashboardTab'] });
    window.MOBILE_CURRENT_USER = { seesFigures: false };
    loadApi();

    expect(global.formatCurrency(0)).toBe('—');
    delete window.MOBILE_CURRENT_USER;
  });
});

describe('the item list as a lookup', () => {
  test('a role without Items Master does not pull POs behind it', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'items.js'), 'utf8');

    expect(source).toContain("nav.isValidTab('itemMaster')");
    expect(source).toContain('App.PO && hasItemTable ? App.PO.ensureLoaded()');
  });
});

describe('the Dashboard figures', () => {
  test('are not fetched without the role for them', async () => {
    shell({ access: 'full', figures: 'no', tabs: ['dashboardTab'] });
    jest.spyOn(App.Dashboard, 'ensureChartLib');

    await App.Dashboard.loadData();

    expect(Api.call).not.toHaveBeenCalled();
    expect(App.Dashboard.ensureChartLib).not.toHaveBeenCalled();
  });

  test('no refresh timer runs without them', () => {
    shell({ access: 'full', figures: 'no', tabs: ['dashboardTab'] });

    App.Dashboard.startAutoRefresh();

    expect(App.Dashboard._autoRefreshActive).toBe(false);
    expect(App.Dashboard.refreshTimer).toBeNull();
  });

  test('are fetched for an admin', async () => {
    shell({ access: 'full', figures: 'yes', tabs: ['dashboardTab'] });
    jest.spyOn(App.Dashboard, 'ensureChartLib').mockResolvedValue();
    // This shell has none of the page's containers; only the request matters.
    App.Dashboard.renderError = jest.fn();

    await App.Dashboard.loadData();

    expect(Api.call).toHaveBeenCalledWith('getDashboardData');
  });
});
