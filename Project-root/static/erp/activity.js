'use strict';
// activity.js -- App.Activity, the admin-only Activity Log tab (AUDIT-001).
//
// The reader for erp.activity_log. Everything it shows is written by
// app/erp/services/activity_service.py from two places: rpc.py's dispatcher
// (every mutating method, and every authorization refusal) and the auth
// routes (sign-in, sign-out, signup, password reset).
//
// Like users.js this is the second UI consumer of RpcSpec.roles:
// getActivityLog is roles=frozenset({"admin"}) server-side, so this file is
// only loaded and its sidebar entry only rendered when current_user.is_admin
// -- see templates/erp/index.html's guards. A non-admin reaching the method
// directly gets a 403 from the server, which is the layer that matters, and
// the refusal is itself recorded here.
//
// PAGINATION IS SERVER-SIDE, unlike every other table in this app. The others
// fetch the whole set and slice it in the browser; that is fine for a few
// thousand vendors and wrong for a table that gains a row per mutation. So
// `page`/`pageSize` go to the server and `total` comes back -- which also
// means the filter inputs re-query rather than filtering an array in memory.

// State lives on the module, not in App.State. App.State exists to hold what
// the Apps Script port brought with it (core.js's own header calls it a
// scaffold for modules that predate this arrangement); a module written from
// scratch has no reason to add to it.
const ACTIVITY_PAGE_SIZE = 50;

// Bootstrap badge class per outcome. 'failure' is deliberately warning, not
// danger: the user was told no by a business rule, which is the system
// working. 'error' is danger -- that one is a bug.
const ACTIVITY_STATUS_STYLES = {
  success: ['bg-success-subtle text-success-emphasis', 'Succeeded'],
  failure: ['bg-warning-subtle text-warning-emphasis', 'Rejected'],
  denied: ['bg-danger-subtle text-danger-emphasis', 'Not authorized'],
  error: ['bg-danger text-white', 'Server error']
};

// Auth actions get a sentence; RPC actions show the method name as-is, since
// that is what an admin correlates against the code and the request log.
const ACTIVITY_AUTH_LABELS = {
  login: 'Signed in',
  logout: 'Signed out',
  signup: 'Account created',
  password_reset_requested: 'Password reset requested',
  password_reset: 'Password reset completed'
};

function _activityStatusBadge(status) {
  const [cls, label] = ACTIVITY_STATUS_STYLES[status] || ['bg-secondary-subtle text-secondary-emphasis', status || '—'];
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
}

function _activityActionLabel(entry) {
  if (entry.category === 'auth') {
    return ACTIVITY_AUTH_LABELS[entry.action] || entry.action || '—';
  }
  return entry.action || '—';
}

// Local time, short. The server stores TIMESTAMPTZ and sends ISO-8601, so the
// browser resolves the offset -- an admin reading this is reasoning about
// "when was I on the factory floor", not about UTC.
function _activityTimestamp(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

App.Activity = {
  _entries: [],
  _page: 1,
  _total: 0,

  _filters() {
    const val = id => (document.getElementById(id)?.value || '').trim();
    return {
      search: val('activitySearch'),
      category: val('activityCategory'),
      status: val('activityStatus'),
      fromDate: val('activityFrom'),
      toDate: val('activityTo')
    };
  },

  async loadData() {
    const tbody = document.getElementById('activityTableBody');
    if (tbody) App.Utils.tableLoading(tbody, 6, 'Loading activity…');

    try {
      // callFresh, not call: the read cache holds a successful envelope for
      // 15s, and an admin who presses Refresh on an audit log and sees the
      // identical page back has been told something false.
      const res = await Api.callFresh('getActivityLog', this._filters(), this._page, ACTIVITY_PAGE_SIZE);

      if (!res?.success) {
        App.Utils.showToast(res?.message || 'Failed to load activity.', true);
        if (tbody) {
          tbody.innerHTML =
            '<tr><td colspan="6" class="text-center p-4 text-danger">Failed to load activity.</td></tr>';
        }
        return;
      }

      const data = res.data || {};
      this._entries = data.entries || [];
      this._total = toNumber(data.total, 0);
      // The server clamps the page it actually served; trust that over what
      // we asked for, or the pager highlights a page nobody is looking at.
      this._page = toNumber(data.page, this._page);
      this.render();
    } catch (err) {
      App.Utils.tableError(tbody, err && err.message, () => App.Activity.loadData());
      App.Utils.showToast(err?.message || 'Failed to load activity.', true);
    }
  },

  render() {
    const tbody = document.getElementById('activityTableBody');
    const empty = document.getElementById('activityEmptyState');
    if (!tbody) return;

    if (!this._entries.length) {
      tbody.innerHTML = '';
      if (empty) empty.style.display = 'block';
      App.Utils.renderPagination('activityPagination', 0, 1, ACTIVITY_PAGE_SIZE, 'activity-page', 'entries');
      return;
    }
    if (empty) empty.style.display = 'none';

    // Every interpolated field below is escaped (SEC-004). This table is the
    // worst possible place to forget: it renders text an attacker chose --
    // the email they signed up with, a vendor name they typed, the rejection
    // message quoting it back -- to an admin, by definition.
    tbody.innerHTML = this._entries.map(entry => {
      const who = entry.userEmail
        ? `${escapeHtml(entry.userEmail)}<br><span class="text-muted small">${escapeHtml(entry.userRole || '')}</span>`
        : '<span class="text-muted">—</span>';
      const module = entry.entityType
        ? `<br><span class="text-muted small">${escapeHtml(entry.entityType)}</span>`
        : '';
      return `<tr>
        <td class="small text-nowrap">${escapeHtml(_activityTimestamp(entry.timestamp))}</td>
        <td class="small">${who}</td>
        <td class="small"><span class="fw-bold">${escapeHtml(_activityActionLabel(entry))}</span>${module}</td>
        <td class="text-center">${_activityStatusBadge(entry.status)}</td>
        <td class="small">${escapeHtml(entry.detail || '')}</td>
        <td class="small text-nowrap">
          ${escapeHtml(entry.ipAddress || '—')}
          <button type="button" class="btn btn-sm btn-link p-0 ms-1 align-baseline"
                  data-action="activity-detail" data-id="${escapeHtml(String(entry.id))}"
                  title="Full record">
            <i class="bi bi-info-circle"></i><span class="visually-hidden">View full record</span>
          </button>
        </td>
      </tr>`;
    }).join('');

    App.Utils.renderPagination(
      'activityPagination', this._total, this._page, ACTIVITY_PAGE_SIZE, 'activity-page', 'entries'
    );
  },

  // Any filter change resets to page 1 -- staying on page 7 of a narrower
  // result set shows an empty table and reads as "nothing was recorded".
  applyFilters() {
    this._page = 1;
    return this.loadData();
  },

  clearFilters() {
    ['activitySearch', 'activityCategory', 'activityStatus', 'activityFrom', 'activityTo']
      .forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
    return this.applyFilters();
  },

  changePage(page) {
    const next = toNumber(page, 1);
    if (next < 1 || next === this._page) return;
    this._page = next;
    return this.loadData();
  },

  openDetail(id) {
    const entry = this._entries.find(e => String(e.id) === String(id));
    const body = document.getElementById('activityDetailBody');
    if (!entry || !body) return;

    const row = (label, value) => {
      if (value === null || value === undefined || value === '') return '';
      return `<div class="row mb-2">
        <div class="col-4 col-md-3 fw-bold text-muted small">${escapeHtml(label)}</div>
        <div class="col-8 col-md-9 small">${escapeHtml(String(value))}</div>
      </div>`;
    };

    // JSON.stringify then escapeHtml, in that order: the values inside came
    // from the client originally, so the rendered payload is untrusted text,
    // not markup. Arguments are already redacted and size-capped server-side
    // (activity_service.describe_args) -- no password reaches this modal
    // because none reached the table.
    const args = entry.args
      ? `<div class="mt-3">
           <div class="fw-bold text-muted small mb-1">Arguments</div>
           <pre class="bg-white border rounded p-2 small mb-0" style="white-space: pre-wrap; overflow-wrap: anywhere;">${escapeHtml(JSON.stringify(entry.args, null, 2))}</pre>
         </div>`
      : '';

    body.innerHTML = [
      row('When', _activityTimestamp(entry.timestamp)),
      row('User', entry.userEmail),
      row('Role at the time', entry.userRole),
      row('User ID', entry.userId),
      row('Category', entry.category),
      row('Action', entry.action),
      row('Module', entry.entityType),
      row('Outcome', (ACTIVITY_STATUS_STYLES[entry.status] || [null, entry.status])[1]),
      row('Message', entry.detail),
      row('IP address', entry.ipAddress),
      // The join to the application log and to the reference id rpc.py
      // quotes to a user when something breaks -- the whole reason this
      // column exists.
      row('Request ID', entry.requestId),
      row('Duration', entry.durationMs === null || entry.durationMs === undefined
        ? '' : `${entry.durationMs} ms`),
      args
    ].join('');

    safeModalShow('activityDetailModal');
  }
};
