/**
 * Activity Log tab (AUDIT-001) -- App.Activity.
 *
 * Two things are worth holding this module to, and they are the two that
 * would be quiet if they broke.
 *
 * 1. ESCAPING. This table is the worst place in the application to forget it.
 *    Every column renders text an attacker chose -- the email they signed up
 *    with, the vendor name they typed, the rejection message quoting it back
 *    -- to an admin, by definition, because only admins can open it. The CSP
 *    is `script-src 'self' 'unsafe-inline'`, so an injected `<img onerror>`
 *    executes (see xss_escaping.test.js for the SEC-004 precedent this is
 *    guarding against repeating).
 *
 * 2. SERVER-SIDE PAGING. Unlike every other table here, this one does not
 *    hold the whole set in memory; the filters and the pager have to reach
 *    the server, and a filter change has to reset to page 1 or a narrowed
 *    result silently reads as "nothing was recorded".
 *
 * Same fs.readFileSync + eval loader the rest of this suite uses.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PAYLOAD = '<img src=x onerror="window.__xss=1">';

let calls;

function loadActivity() {
  const api = [
    fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8'),
    'global.escapeHtml = escapeHtml;',
    'global.toNumber = toNumber;',
    'global.formatCurrency = formatCurrency;',
    'global.formatQty = formatQty;',
    'global.parseRecordDate = parseRecordDate;',
  ].join('\n');
  // eslint-disable-next-line no-eval
  eval(api);

  // Classic scripts share ONE top-level scope in the browser, so activity.js
  // calls core.js's safeModalShow as a bare global exactly the way users.js
  // does. Each eval() here gets its own scope instead, so it has to be
  // re-exported -- the same epilogue technique dashboard_status.test.js and
  // xss_escaping.test.js use for api.js's helpers.
  const core = [
    fs
      .readFileSync(path.join(__dirname, '..', 'core.js'), 'utf8')
      .replace(/^const App = /m, 'global.App = '),
    'global.safeModalShow = safeModalShow;',
  ].join('\n');
  // eslint-disable-next-line no-eval
  eval(core);

  const activity = fs.readFileSync(path.join(__dirname, '..', 'activity.js'), 'utf8');
  // eslint-disable-next-line no-eval
  eval(activity);
}

// The tab's markup, reduced to the ids activity.js actually addresses.
function mountTab() {
  document.body.innerHTML = `
    <input id="activitySearch" value="">
    <select id="activityCategory"><option value="" selected></option><option value="auth"></option></select>
    <select id="activityStatus"><option value="" selected></option><option value="denied"></option></select>
    <input id="activityFrom" value="">
    <input id="activityTo" value="">
    <table><tbody id="activityTableBody"></tbody></table>
    <div id="activityPagination"></div>
    <div id="activityEmptyState" style="display:none;"></div>
    <div id="activityDetailModal"><div id="activityDetailBody"></div></div>
    <div id="sr-announcer"></div>
  `;
}

function stubApi(entries, total = entries.length, page = 1) {
  calls = [];
  global.Api = {
    callFresh: (...args) => {
      calls.push(args);
      return Promise.resolve({
        success: true,
        data: { entries, total, page, pageSize: 50, totalPages: Math.ceil(total / 50) },
      });
    },
  };
}

function entry(overrides = {}) {
  return {
    id: 1,
    timestamp: '2026-08-26T10:00:00+00:00',
    userId: 7,
    userEmail: 'someone@example.com',
    userRole: 'user',
    category: 'rpc',
    action: 'saveVendor',
    entityType: 'vendors_service',
    status: 'success',
    detail: 'Vendor "Acme" registered.',
    args: { form_data: { vendorName: 'Acme' } },
    ipAddress: '127.0.0.1',
    requestId: 'abc-123',
    durationMs: 12.5,
    ...overrides,
  };
}

beforeEach(() => {
  delete window.__xss;
  mountTab();
  loadActivity();
});

describe('escaping: every column renders attacker-chosen text as text', () => {
  test('a payload in the detail message does not execute', async () => {
    stubApi([entry({ detail: PAYLOAD })]);
    await App.Activity.loadData();

    const body = document.getElementById('activityTableBody');
    expect(body.querySelector('img')).toBeNull();
    expect(window.__xss).toBeUndefined();
    // Still legible: an admin investigating needs to see what was submitted.
    expect(body.textContent).toContain('onerror');
  });

  test('a payload in the user email does not execute', async () => {
    stubApi([entry({ userEmail: PAYLOAD })]);
    await App.Activity.loadData();
    expect(document.getElementById('activityTableBody').querySelector('img')).toBeNull();
    expect(window.__xss).toBeUndefined();
  });

  test('a payload in the action name does not execute', async () => {
    stubApi([entry({ action: PAYLOAD, category: 'rpc' })]);
    await App.Activity.loadData();
    expect(document.getElementById('activityTableBody').querySelector('img')).toBeNull();
    expect(window.__xss).toBeUndefined();
  });

  test('a payload inside the args JSON does not execute in the detail modal', async () => {
    stubApi([entry({ args: { form_data: { vendorName: PAYLOAD } } })]);
    await App.Activity.loadData();
    App.Activity.openDetail(1);

    const modal = document.getElementById('activityDetailBody');
    expect(modal.querySelector('img')).toBeNull();
    expect(window.__xss).toBeUndefined();
    expect(modal.textContent).toContain('vendorName');
  });
});

describe('the row a reader actually gets', () => {
  test('an rpc row shows the method, the module and the outcome', async () => {
    stubApi([entry()]);
    await App.Activity.loadData();

    const text = document.getElementById('activityTableBody').textContent;
    expect(text).toContain('saveVendor');
    expect(text).toContain('vendors_service');
    expect(text).toContain('Succeeded');
    expect(text).toContain('someone@example.com');
  });

  test('an auth row is written as a sentence, not a method name', async () => {
    stubApi([entry({ category: 'auth', action: 'login', entityType: null, detail: 'Password sign-in' })]);
    await App.Activity.loadData();
    expect(document.getElementById('activityTableBody').textContent).toContain('Signed in');
  });

  test('a rejection reads as Rejected, a refusal as Not authorized', async () => {
    stubApi([
      entry({ id: 1, status: 'failure' }),
      entry({ id: 2, status: 'denied' }),
      entry({ id: 3, status: 'error' }),
    ]);
    await App.Activity.loadData();

    const text = document.getElementById('activityTableBody').textContent;
    expect(text).toContain('Rejected');
    expect(text).toContain('Not authorized');
    expect(text).toContain('Server error');
  });

  test('an empty result shows the empty state, not a blank table', async () => {
    stubApi([], 0);
    await App.Activity.loadData();
    expect(document.getElementById('activityEmptyState').style.display).toBe('block');
    expect(document.getElementById('activityTableBody').innerHTML).toBe('');
  });
});

describe('server-side paging and filtering', () => {
  test('filters and the page number are sent to the server, not applied locally', async () => {
    stubApi([entry()]);
    document.getElementById('activitySearch').value = 'someone@example.com';
    document.getElementById('activityStatus').value = 'denied';

    await App.Activity.applyFilters();

    expect(calls).toHaveLength(1);
    const [method, filters, page, pageSize] = calls[0];
    expect(method).toBe('getActivityLog');
    expect(filters.search).toBe('someone@example.com');
    expect(filters.status).toBe('denied');
    expect(page).toBe(1);
    expect(pageSize).toBe(50);
  });

  test('changing a filter returns to page 1', async () => {
    stubApi([entry()], 500, 4);
    await App.Activity.changePage(4);
    expect(calls[calls.length - 1][2]).toBe(4);

    // The stub echoes page 1 back for this one, as the server would.
    stubApi([entry()], 500, 1);
    await App.Activity.applyFilters();
    expect(calls[calls.length - 1][2]).toBe(1);
  });

  test('the page the server actually served wins over the one requested', async () => {
    stubApi([entry()], 60, 2);
    await App.Activity.changePage(99);
    // Server clamped to 2; the pager must follow it, not highlight page 99.
    expect(App.Activity._page).toBe(2);
  });

  test('re-requesting the page already shown does not re-query', async () => {
    stubApi([entry()], 500, 1);
    await App.Activity.loadData();
    const before = calls.length;
    await App.Activity.changePage(1);
    expect(calls).toHaveLength(before);
  });

  test('clearing the filters empties every input and re-queries unfiltered', async () => {
    stubApi([entry()]);
    document.getElementById('activitySearch').value = 'noise';
    document.getElementById('activityFrom').value = '2026-01-01';

    await App.Activity.clearFilters();

    expect(document.getElementById('activitySearch').value).toBe('');
    expect(document.getElementById('activityFrom').value).toBe('');
    const [, filters] = calls[calls.length - 1];
    expect(filters.search).toBe('');
    expect(filters.fromDate).toBe('');
  });

  test('the log is read uncached -- Refresh on an audit trail must hit the server', async () => {
    stubApi([entry()]);
    global.Api.call = jest.fn();
    await App.Activity.loadData();
    // callFresh, never the 15s-cached call().
    expect(global.Api.call).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });
});

describe('failures are visible, not silent', () => {
  test('a failed envelope leaves an error in the table rather than an empty one', async () => {
    global.Api = { callFresh: () => Promise.resolve({ success: false, message: 'Not authorized.' }) };
    await App.Activity.loadData();
    expect(document.getElementById('activityTableBody').textContent).toContain('Failed to load activity');
  });

  test('a thrown request renders the retry affordance', async () => {
    global.Api = { callFresh: () => Promise.reject(new Error('network down')) };
    await App.Activity.loadData();
    const body = document.getElementById('activityTableBody');
    expect(body.textContent).toContain('network down');
    expect(body.querySelector('[data-action="retry-table-load"]')).not.toBeNull();
  });
});
