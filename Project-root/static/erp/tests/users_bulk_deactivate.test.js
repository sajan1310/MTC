/**
 * Tests for the Users tab's bulk deactivation UI (App.Users, ../users.js).
 *
 * The feature is Super Admin-only, and that is gated at three layers: the
 * partial's {% if current_user.role == 'super_admin' %} around the checkbox
 * column and the action button, users.js's _canBulkDeactivate() around the
 * per-row checkboxes it renders, and bulk_deactivate_users' own role
 * comparison server-side. Only the middle layer is observable here; the
 * server's is covered by tests/erp/test_users.py, which is the layer that
 * actually matters.
 *
 * What is pinned:
 *
 *   1. An ordinary admin gets no checkbox column at all, and every
 *      full-width row spans the right number of columns for whichever
 *      header the partial rendered. A fixed colspan overhangs the table for
 *      one viewer and leaves a gap for the other.
 *
 *   2. A row the server would refuse -- the viewer's own account, an
 *      already-inactive account, another super_admin -- gets an EMPTY cell
 *      rather than a checkbox, so the UI never offers a selection that
 *      would come back skipped. The cell still has to be there, or every
 *      column after it shifts left by one.
 *
 *   3. The selection never outlives what is on screen. Searching clears it,
 *      because "Deactivate Selected" acting on a row the filter has hidden
 *      is the failure mode a destructive bulk action cannot have.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PARTIAL = path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', 'users.html');

const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Renders the real partial for one viewer role, resolving just the two Jinja
// constructs this tab uses: the {% if current_user.role == 'super_admin' %}
// guards and the colspan {{ ... if ... else ... }}.
function mountPartial(viewerRole) {
  let html = fs.readFileSync(PARTIAL, 'utf8');
  html = html.replace(
    /\{%\s*if current_user\.role == 'super_admin'\s*%\}([\s\S]*?)\{%\s*endif\s*%\}/g,
    (_m, body) => (viewerRole === 'super_admin' ? body : '')
  );
  html = html.replace(
    /\{\{\s*7 if current_user\.role == 'super_admin' else 6\s*\}\}/g,
    viewerRole === 'super_admin' ? '7' : '6'
  );
  document.body.innerHTML =
    `<meta name="current-user-id" content="1">` +
    `<meta name="current-user-role" content="${viewerRole}">` + html;
}

function loadUsersAsGlobal() {
  global.escapeHtml = v => String(v).replace(/[&<>"']/g, ch => HTML_ESCAPE_MAP[ch]);
  global.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  global.safeModalShow = () => {};
  global.safeModalHide = () => {};
  global.Api = { call: jest.fn(), mutate: jest.fn() };

  global.App = {
    State: { globalUsers: [], filteredUsers: [], usersSearchTerm: '', selectedUsers: [], globalCustomRoles: [] },
    Utils: {
      formatNameCase: v => String(v ?? ''),
      showToast: jest.fn(),
      confirmAction: jest.fn(),
      tableLoading: () => {},
      tableError: () => {},
      debouncedFilter: () => {},
    },
    // The real shared helpers from core.js -- copied rather than stubbed so
    // the selection semantics under test are the ones that actually ship.
    Selection: {
      toggle(arr, key, isSelected) {
        const idx = arr.indexOf(key);
        if (isSelected) { if (idx === -1) arr.push(key); } else if (idx !== -1) arr.splice(idx, 1);
      },
      isSelected(arr, key) { return arr.indexOf(key) !== -1; },
      toggleAll(arr, chkClass, masterChk) {
        $$('.' + chkClass).forEach(chk => {
          chk.checked = masterChk.checked;
          this.toggle(arr, chk.dataset.key, masterChk.checked);
        });
      },
      syncFromRows(arr, chkClass, selectAllId) {
        const boxes = $$('.' + chkClass);
        boxes.forEach(chk => this.toggle(arr, chk.dataset.key, chk.checked));
        const master = document.getElementById(selectAllId);
        if (master) master.checked = boxes.length > 0 && boxes.every(c => c.checked);
      },
      updateButton(btnId, count, label) {
        const btn = document.getElementById(btnId);
        if (!btn) return;
        if (count > 0) { btn.classList.remove('d-none'); btn.innerHTML = `${label} (${count})`; }
        else btn.classList.add('d-none');
      },
    },
  };

  // eslint-disable-next-line no-eval
  eval(fs.readFileSync(path.join(__dirname, '..', 'users.js'), 'utf8'));
}

// id 1 is the viewer (see the meta tag above).
const USERS = [
  { id: 1, name: 'Me Myself', email: 'me@x.test', role: 'super_admin', active: true, createdAt: null },
  { id: 2, name: 'Ann Active', email: 'ann@x.test', role: 'user', active: true, createdAt: null },
  { id: 3, name: 'Bob Active', email: 'bob@x.test', role: 'user', active: true, createdAt: null },
  { id: 4, name: 'Cara Off', email: 'cara@x.test', role: 'user', active: false, createdAt: null },
  { id: 5, name: 'Dan Peer Super', email: 'dan@x.test', role: 'super_admin', active: true, createdAt: null },
  { id: 6, name: 'Eve Admin', email: 'eve@x.test', role: 'admin', active: true, createdAt: null },
];

function renderAs(viewerRole, users = USERS) {
  mountPartial(viewerRole);
  loadUsersAsGlobal();
  App.State.globalUsers = users;
  App.Users.filterData('');
  return document.getElementById('usersTableBody');
}

const checkboxKeys = () => $$('.user-select-chk').map(c => c.dataset.key);

describe('bulk deactivation is Super Admin only', () => {
  test('an ordinary admin gets no checkbox column and no action button', () => {
    renderAs('admin');
    expect(document.getElementById('selectAllUsers')).toBeNull();
    expect(document.getElementById('btnBulkDeactivateUsers')).toBeNull();
    expect($$('.user-select-chk')).toHaveLength(0);
  });

  test('a super admin gets the column, the master checkbox and the button', () => {
    renderAs('super_admin');
    expect(document.getElementById('selectAllUsers')).not.toBeNull();
    expect(document.getElementById('btnBulkDeactivateUsers')).not.toBeNull();
    expect(checkboxKeys().length).toBeGreaterThan(0);
  });

  test('every row spans the header it was rendered against', () => {
    // Six columns for an admin, seven with the select column. Pinned for
    // both viewers because a single hardcoded number is right for only one.
    renderAs('admin', []);
    expect(document.querySelector('#usersTableBody td').getAttribute('colspan')).toBe('6');
    expect(document.querySelectorAll('#usersTab thead th')).toHaveLength(6);

    renderAs('super_admin', []);
    expect(document.querySelector('#usersTableBody td').getAttribute('colspan')).toBe('7');
    expect(document.querySelectorAll('#usersTab thead th')).toHaveLength(7);
  });
});

describe('only rows the server would accept are selectable', () => {
  beforeEach(() => renderAs('super_admin'));

  test('the viewer, inactive accounts and other super admins get no checkbox', () => {
    // 2, 3 and 6 are selectable; 1 is the viewer, 4 is already off, 5 is a
    // peer super_admin -- all three are skipped by bulk_deactivate_users.
    expect(checkboxKeys().sort()).toEqual(['2', '3', '6']);
  });

  test('an unselectable row still occupies the select column', () => {
    // Without the empty cell every column after it shifts left by one and
    // the row stops lining up with the header.
    const cellCounts = $$('#usersTableBody tr').map(tr => tr.children.length);
    expect(new Set(cellCounts)).toEqual(new Set([7]));
  });

  test('select-all takes every selectable row and no others', () => {
    const master = document.getElementById('selectAllUsers');
    master.checked = true;
    App.Users.toggleSelectAll(master);

    expect(App.State.selectedUsers.sort()).toEqual(['2', '3', '6']);
    expect(document.getElementById('btnBulkDeactivateUsers').classList.contains('d-none')).toBe(false);
    expect(document.getElementById('btnBulkDeactivateUsers').textContent).toContain('(3)');
  });

  test('the action button is hidden again when the selection empties', () => {
    const master = document.getElementById('selectAllUsers');
    master.checked = true;
    App.Users.toggleSelectAll(master);
    master.checked = false;
    App.Users.toggleSelectAll(master);

    expect(App.State.selectedUsers).toEqual([]);
    expect(document.getElementById('btnBulkDeactivateUsers').classList.contains('d-none')).toBe(true);
  });
});

describe('the selection never outlives what is on screen', () => {
  beforeEach(() => renderAs('super_admin'));

  test('searching clears it rather than carrying hidden rows along', () => {
    const master = document.getElementById('selectAllUsers');
    master.checked = true;
    App.Users.toggleSelectAll(master);
    expect(App.State.selectedUsers).toHaveLength(3);

    // Ann is still listed, but the rest are filtered out. Acting on a row
    // the search has hidden is the one thing a destructive bulk action
    // must not do, so the whole selection goes.
    App.Users.filterData('ann');
    expect(App.State.selectedUsers).toEqual([]);
    expect(document.getElementById('btnBulkDeactivateUsers').classList.contains('d-none')).toBe(true);
  });

  test('bulkDeactivate with nothing selected warns instead of calling the server', () => {
    App.Users.bulkDeactivate();
    expect(App.Utils.showToast).toHaveBeenCalledWith('Select at least one user to deactivate.', true);
    expect(App.Utils.confirmAction).not.toHaveBeenCalled();
    expect(Api.mutate).not.toHaveBeenCalled();
  });

  test('the confirmation names the users, not just a count', () => {
    // A bare "Deactivate 3 users?" gives the reader nothing to check the
    // selection against, which is the whole risk of a bulk action.
    const master = document.getElementById('selectAllUsers');
    master.checked = true;
    App.Users.toggleSelectAll(master);
    App.Users.bulkDeactivate();

    const [message] = App.Utils.confirmAction.mock.calls[0];
    expect(message).toContain('Deactivate 3 users');
    expect(message).toContain('Ann Active');
    expect(message).toContain('Bob Active');
    expect(message).toContain('Eve Admin');
  });

  test('it sends numeric ids to the server, not the string keys it holds', () => {
    Api.mutate.mockResolvedValue({ success: true, message: 'ok' });
    App.Utils.confirmAction.mockImplementation((_msg, cb) => cb());

    document.querySelector('.user-select-chk[data-key="2"]').checked = true;
    App.Users.onRowSelectChange();
    App.Users.bulkDeactivate();

    expect(Api.mutate).toHaveBeenCalledWith('bulkDeactivateUsers', [2]);
  });
});
