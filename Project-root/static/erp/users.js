'use strict';
// users.js -- App.Users, the admin-only User Management tab.
//
// This is the first UI consumer of RpcSpec.roles (registry.py / rpc.py):
// getUsersData/updateUserRole/deactivateUser/reactivateUser are all
// admin-gated server-side (User.has_role treats super_admin as a superset
// of admin -- see app/models/user.py), so this file is only loaded (and
// its sidebar entry only rendered) when current_user.is_admin -- see
// templates/erp/index.html's {% if current_user.is_admin %} guards around
// this <script> tag, the sidebar button, and the tab partial itself.
// A non-admin who somehow reached these RPC methods directly would still
// get a 403 from the server, which is the layer that actually matters.

const ROLE_LABELS = {
  pending_approval: 'Pending Approval',
  user: 'User',
  admin: 'Admin'
};

// The 11 sidebar tabs a custom role can be granted, and at which access
// level -- mirrors app/erp/services/roles_service.py's ASSIGNABLE_TABS
// exactly (dashboardTab/usersTab excluded there for the same reasons: every
// role sees Dashboard, no custom role is ever usersTab-capable).
const ASSIGNABLE_TABS = [
  ['vendorMaster', 'Vendors'],
  ['itemMaster', 'Items Master'],
  ['poLedger', 'Purchase Orders'],
  ['billLedger', 'Bill Ledger'],
  ['returnLedger', 'Returns'],
  ['stockTab', 'Stock'],
  ['productsTab', 'Products & Processes'],
  ['contractorsTab', 'Contractors'],
  ['productionTab', 'Production'],
  ['clientsTab', 'Clients'],
  ['dispatchTab', 'Dispatch']
];

function _currentUserId() {
  const raw = document.querySelector('meta[name="current-user-id"]')?.getAttribute('content');
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function _currentUserRole() {
  return document.querySelector('meta[name="current-user-role"]')?.getAttribute('content') || '';
}

// Bulk deactivation is Super Admin-only. This hides the checkbox column and
// the action button for everyone else; users_service.bulk_deactivate_users
// is what actually enforces it (an ordinary admin calling the method
// directly is refused there, not here).
function _canBulkDeactivate() {
  return _currentUserRole() === 'super_admin';
}

// Six columns, or seven with the Super Admin-only select column -- every
// full-width row this file renders has to agree with the <thead> the
// partial built, or it overhangs the table or leaves a gap.
function _colCount() {
  return _canBulkDeactivate() ? 7 : 6;
}

// Which rows a bulk deactivation may target. Mirrors the server's own
// filters (bulk_deactivate_users) so the UI never offers a checkbox for a
// row the server would skip: an already-inactive account has nothing to
// deactivate, and the caller's own account and any other Super Admin are
// both refused there.
function _isBulkSelectable(u, selfId) {
  return u.active
    && !(selfId != null && selfId === Number(u.id))
    && u.role !== 'super_admin';
}

// ROLE_LABELS plus whatever custom roles are currently loaded (see
// App.Users.loadData, which fetches getCustomRoles alongside getUsersData)
// -- used by the per-row role <select> so a user already on a custom role
// shows and stays selectable, not silently defaulting to the first option
// the way an unlisted value (e.g. super_admin, handled separately) would.
function _mergedRoleLabels() {
  const merged = { ...ROLE_LABELS };
  (App.State.globalCustomRoles || []).forEach(r => { merged[r.roleKey] = r.roleName; });
  return merged;
}

App.Users = {
  async loadData() {
    const tbody = document.getElementById('usersTableBody');
    if (tbody) App.Utils.tableLoading(tbody, _colCount(), 'Loading users…');
    // Every reload re-renders the rows, and anything selected before it may
    // no longer exist or no longer be selectable (it may be exactly what was
    // just deactivated). Carrying keys across would leave the count showing
    // a selection the user can no longer see.
    this.clearSelection();

    try {
      // Custom roles fetched alongside users (not only when Manage Roles
      // opens) so the per-row role <select> and Create User modal both
      // have the full role list from the moment this tab loads.
      const [res, rolesRes] = await Promise.all([
        Api.call('getUsersData'),
        Api.call('getCustomRoles')
      ]);
      if (rolesRes?.success) App.State.globalCustomRoles = rolesRes.data || [];

      if (!res?.success) {
        App.Utils.showToast(res?.message || 'Failed to load users.', true);
        if (tbody) tbody.innerHTML = `<tr><td colspan="${_colCount()}" class="text-center p-4 text-danger">Failed to load users.</td></tr>`;
        return;
      }
      App.State.globalUsers = res.data || [];
      this.filterData(App.State.usersSearchTerm || '');
    } catch (err) {
      App.Utils.tableError(tbody, err && err.message);
      App.Utils.showToast(err.message || 'Failed to load users.', true);
    }
  },

  openCreateModal() {
    const form = document.getElementById('createUserForm');
    if (form) form.reset();
    this._populateCreateUserRoleOptions();
    safeModalShow('createUserModal');
  },

  // The Create User modal's Role <select> is Jinja-rendered with just
  // "User" (+ "Admin" for a super_admin viewer, see users.html) -- custom
  // roles aren't known at page-render time, so they're appended here from
  // whatever loadData's getCustomRoles fetch last returned. Removes any
  // previously-appended ones first so reopening the modal doesn't
  // duplicate options if roles changed in between.
  _populateCreateUserRoleOptions() {
    const select = document.querySelector('#createUserForm select[name="role"]');
    if (!select) return;
    select.querySelectorAll('option[data-custom-role]').forEach(opt => opt.remove());
    (App.State.globalCustomRoles || []).forEach(r => {
      const opt = document.createElement('option');
      opt.value = r.roleKey;
      opt.textContent = r.roleName;
      opt.dataset.customRole = 'true';
      select.appendChild(opt);
    });
  },

  async submitCreate(e) {
    e.preventDefault();
    const form = e.target;
    const name = form.name.value.trim();
    const email = form.email.value.trim();
    const password = form.password.value;
    const confirmPassword = form.confirmPassword.value;
    const role = form.role.value;

    if (password !== confirmPassword) {
      App.Utils.showToast('Passwords do not match.', true);
      return;
    }

    const submitBtn = document.getElementById('createUserSubmitBtn');
    if (submitBtn) submitBtn.disabled = true;
    try {
      const res = await Api.mutate('createUser', name, email, password, confirmPassword, role);
      App.Utils.showToast(res?.message || (res?.success ? 'User created.' : 'Failed to create user.'), !res?.success);
      if (res?.success) {
        safeModalHide('createUserModal');
        await this.loadData();
      }
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to create user.', true);
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  },

  filterData(term) {
    // Deliberately NOT the persist-across-filters behaviour the paginated
    // tabs use (see bill.js). Deactivation is destructive and irreversible
    // from this screen, so the selection is only ever what is visible --
    // "Deactivate Selected" must never act on a row the search has hidden.
    this.clearSelection();
    App.State.usersSearchTerm = String(term || '');
    const q = App.State.usersSearchTerm.toLowerCase().trim();
    App.State.filteredUsers = !q
      ? [...App.State.globalUsers]
      : App.State.globalUsers.filter(u =>
          (u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q)
        );
    this.renderTable();
  },

  renderTable() {
    const tbody = document.getElementById('usersTableBody');
    const emptyState = document.getElementById('usersEmptyState');
    if (!tbody) return;

    const rows = App.State.filteredUsers || [];
    if (rows.length === 0) {
      tbody.innerHTML = '';
      if (emptyState) emptyState.style.display = App.State.globalUsers.length ? '' : 'none';
      if (!App.State.globalUsers.length) {
        tbody.innerHTML = `<tr><td colspan="${_colCount()}" class="text-center p-4 text-muted">No users found.</td></tr>`;
      }
      this.refreshSelectionUi();
      return;
    }
    if (emptyState) emptyState.style.display = 'none';
    tbody.innerHTML = rows.map(u => this.rowHtml(u)).join('');
    this.refreshSelectionUi();
  },

  rowHtml(u) {
    const selfId = _currentUserId();
    const isSelf = selfId != null && selfId === Number(u.id);
    // super_admin is assigned directly in the database, not one of the
    // three roles this list can hand out (see users_service.py's ROLES) --
    // it isn't in ROLE_LABELS, so building a <select> for it would silently
    // default to the first option (Pending Approval) with nothing actually
    // selected, misrepresenting the role and risking an accidental demotion
    // if anyone interacted with it. Show it as a plain badge instead.
    const isSuperAdmin = u.role === 'super_admin';
    // An admin row is also shown read-only to anyone but a super_admin --
    // mirrors update_user_role's server-side rule that only a super_admin
    // can touch another admin's role at all, so a plain admin never sees an
    // interactive control that would just come back as a 403-style error.
    const roleLocked = isSuperAdmin || (u.role === 'admin' && _currentUserRole() !== 'super_admin');
    const roleLabels = _mergedRoleLabels();
    // "Admin" is only offered as a target when the viewer is a super_admin
    // -- mirrors update_user_role's server-side rule (only a super_admin
    // can promote to Admin); previously this was always offered to any
    // admin, who'd just get a 403 back after picking it.
    const canGrantAdmin = _currentUserRole() === 'super_admin';
    const knownRoleKeys = Object.keys(roleLabels).filter(r => r !== 'admin' || canGrantAdmin);
    // A role that's neither a known key here nor super_admin/admin (e.g. a
    // custom role deleted out from under an already-assigned user, or a
    // stale roles list) would otherwise silently default the <select> to
    // its first option with nothing actually selected -- same failure mode
    // super_admin needed its own badge treatment for above.
    const roleUnrecognized = !isSuperAdmin && !roleLocked && !knownRoleKeys.includes(u.role);
    const roleOptions = knownRoleKeys
      .map(r => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${escapeHtml(roleLabels[r] || r)}</option>`)
      .join('');

    const statusBadge = u.active
      ? '<span class="badge bg-success-subtle text-success-emphasis border border-success-subtle">Active</span>'
      : '<span class="badge bg-secondary-subtle text-secondary-emphasis border border-secondary-subtle">Deactivated</span>';

    const joined = u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '-';

    const actionBtn = isSelf
      ? '<span class="text-muted small fst-italic">This is you</span>'
      : u.active
        ? `<button class="btn btn-sm btn-outline-danger btn-action" data-action="user-deactivate" data-id="${u.id}">Deactivate</button>`
        : `<button class="btn btn-sm btn-outline-success btn-action" data-action="user-reactivate" data-id="${u.id}">Reactivate</button>`;

    // An empty cell, not a missing one: a row that cannot be bulk-selected
    // still has to occupy the column, or every cell after it shifts left by
    // one and the row stops lining up with the header.
    const selectCell = !_canBulkDeactivate()
      ? ''
      : _isBulkSelectable(u, selfId)
        ? `<td class="text-center">
            <input type="checkbox" class="form-check-input user-select-chk" data-key="${u.id}"
                   aria-label="Select ${escapeHtml(u.name || u.email || 'user')} for deactivation"
                   ${App.Selection.isSelected(App.State.selectedUsers, String(u.id)) ? 'checked' : ''}
                   onchange="App.Users.onRowSelectChange()">
          </td>`
        : '<td></td>';

    return `
      <tr>
        ${selectCell}
        <td>${escapeHtml(App.Utils.formatNameCase(u.name) || '-')}</td>
        <td>${escapeHtml(u.email || '-')}</td>
        <td>
          ${isSuperAdmin
            ? '<span class="badge bg-primary-subtle text-primary-emphasis border border-primary-subtle" title="Super Admin is assigned directly in the database, not through this list">Super Admin</span>'
            : roleLocked
              ? '<span class="badge bg-primary-subtle text-primary-emphasis border border-primary-subtle" title="Only a Super Admin can change another Admin\'s role">Admin</span>'
              : roleUnrecognized
                ? `<span class="badge bg-secondary-subtle text-secondary-emphasis border border-secondary-subtle" title="This role no longer exists -- reassign to fix">${escapeHtml(u.role)} (unknown)</span>`
                : `<select class="form-select form-select-sm" data-action="user-role-select" data-id="${u.id}" ${isSelf ? 'disabled title="You cannot change your own role"' : ''}>
            ${roleOptions}
          </select>`}
        </td>
        <td class="text-center">${statusBadge}</td>
        <td><small class="text-muted">${escapeHtml(joined)}</small></td>
        <td class="text-center">${actionBtn}</td>
      </tr>`;
  },

  async changeRole(userId, role) {
    try {
      const res = await Api.mutate('updateUserRole', Number(userId), role);
      App.Utils.showToast(res?.message || (res?.success ? 'Role updated.' : 'Failed to update role.'), !res?.success);
      if (res?.success) await this.loadData();
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to update role.', true);
      await this.loadData(); // revert the <select> to the server's actual value
    }
  },

  deactivate(userId) {
    App.Utils.confirmAction(
      'Deactivate this user? They will be signed out and unable to sign in again until reactivated.',
      async () => {
        try {
          const res = await Api.mutate('deactivateUser', Number(userId));
          App.Utils.showToast(res?.message || 'User deactivated.', !res?.success);
          if (res?.success) await this.loadData();
        } catch (err) {
          App.Utils.showToast(err.message || 'Failed to deactivate user.', true);
        }
      }
    );
  },

  // ── Bulk deactivation (Super Admin only) ──────────────────────────────
  // Selection state is an array of user-id STRINGS, matching the shared
  // App.Selection helpers every other tab's checkbox column uses.

  toggleSelectAll(masterChk) {
    App.Selection.toggleAll(App.State.selectedUsers, 'user-select-chk', masterChk);
    this.refreshSelectionUi();
  },

  onRowSelectChange() {
    App.Selection.syncFromRows(App.State.selectedUsers, 'user-select-chk', 'selectAllUsers');
    this.refreshSelectionUi();
  },

  clearSelection() {
    App.State.selectedUsers = [];
    const master = document.getElementById('selectAllUsers');
    if (master) master.checked = false;
  },

  // Drops any key whose checkbox is no longer on screen, then repaints the
  // button and the master checkbox. Called after every render so the count
  // can never claim more than the rows actually offer.
  refreshSelectionUi() {
    const onScreen = $$('.user-select-chk').map(chk => chk.dataset.key);
    App.State.selectedUsers = (App.State.selectedUsers || []).filter(key => onScreen.includes(key));

    const master = document.getElementById('selectAllUsers');
    if (master) {
      master.checked = onScreen.length > 0 && onScreen.length === App.State.selectedUsers.length;
    }
    App.Selection.updateButton(
      'btnBulkDeactivateUsers',
      App.State.selectedUsers.length,
      '<i class="bi bi-person-slash"></i> Deactivate Selected'
    );
  },

  bulkDeactivate() {
    const ids = (App.State.selectedUsers || []).map(Number).filter(Number.isFinite);
    if (!ids.length) {
      App.Utils.showToast('Select at least one user to deactivate.', true);
      return;
    }
    // Names, not just a count: the whole risk of a bulk action is acting on
    // more than you meant to, and a bare "Deactivate 9 users?" gives the
    // reader nothing to check that against.
    const names = ids
      .map(id => (App.State.globalUsers.find(u => Number(u.id) === id) || {}).name)
      .filter(Boolean);
    const listed = names.slice(0, 5).join(', ');
    const andMore = names.length > 5 ? `, and ${names.length - 5} more` : '';

    App.Utils.confirmAction(
      `Deactivate ${ids.length} user${ids.length === 1 ? '' : 's'} (${listed}${andMore})? ` +
      'They will be signed out and unable to sign in again until reactivated.',
      async () => {
        const btn = document.getElementById('btnBulkDeactivateUsers');
        if (btn) btn.disabled = true;
        try {
          const res = await Api.mutate('bulkDeactivateUsers', ids);
          App.Utils.showToast(res?.message || 'Users deactivated.', !res?.success);
          if (res?.success) await this.loadData();
        } catch (err) {
          App.Utils.showToast(err.message || 'Failed to deactivate users.', true);
        } finally {
          if (btn) btn.disabled = false;
        }
      }
    );
  },

  async reactivate(userId) {
    try {
      const res = await Api.mutate('reactivateUser', Number(userId));
      App.Utils.showToast(res?.message || 'User reactivated.', !res?.success);
      if (res?.success) await this.loadData();
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to reactivate user.', true);
    }
  },

  // ── Manage Roles ──────────────────────────────────────────────────────
  // Custom roles: each grants one of viewer/commenter/editor per tab (or
  // no row at all = no access). See app/erp/services/roles_service.py for
  // what each level actually allows -- this UI only builds the {tab:
  // level} map roleForm submits; the server is what enforces it.
  openManageRolesModal() {
    this.resetRoleForm();
    safeModalShow('manageRolesModal');
    this.loadRoles();
  },

  async loadRoles() {
    const tbody = document.getElementById('customRolesTableBody');
    if (tbody) App.Utils.tableLoading(tbody, 3, 'Loading roles…');
    try {
      const res = await Api.call('getCustomRoles');
      if (!res?.success) {
        App.Utils.showToast(res?.message || 'Failed to load roles.', true);
        return;
      }
      App.State.globalCustomRoles = res.data || [];
      this.renderRolesTable();
    } catch (err) {
      App.Utils.tableError(tbody, err && err.message);
      App.Utils.showToast(err.message || 'Failed to load roles.', true);
    }
  },

  renderRolesTable() {
    const tbody = document.getElementById('customRolesTableBody');
    if (!tbody) return;
    const roles = App.State.globalCustomRoles || [];
    if (!roles.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="text-center text-muted p-3">No custom roles yet.</td></tr>';
      return;
    }
    tbody.innerHTML = roles.map(r => `
      <tr>
        <td>${escapeHtml(r.roleName)}</td>
        <td class="text-center">${r.userCount}</td>
        <td class="text-center">
          <button type="button" class="btn btn-sm btn-outline-primary btn-action" onclick="App.Users.editRole('${escapeHtml(r.roleKey)}')">Edit</button>
          <button type="button" class="btn btn-sm btn-outline-danger btn-action" onclick="App.Users.deleteRole('${escapeHtml(r.roleKey)}')">Delete</button>
        </td>
      </tr>`).join('');
  },

  // One <tr> per assignable tab: a 4-way radio group (No Access/Viewer/
  // Commenter/Editor). `permissions` is the {tab: level} map to preselect
  // (blank object for a brand-new role -- every tab starts at No Access).
  _roleFormTabsHtml(permissions) {
    const perms = permissions || {};
    const radio = (tab, value, checked) =>
      `<input type="radio" class="form-check-input" name="tabLevel_${tab}" value="${value}" ${checked ? 'checked' : ''}>`;
    return ASSIGNABLE_TABS.map(([tab, label]) => {
      const current = perms[tab] || 'none';
      return `
        <tr>
          <td>${escapeHtml(label)}</td>
          <td class="text-center">${radio(tab, 'none', current === 'none')}</td>
          <td class="text-center">${radio(tab, 'viewer', current === 'viewer')}</td>
          <td class="text-center">${radio(tab, 'commenter', current === 'commenter')}</td>
          <td class="text-center">${radio(tab, 'editor', current === 'editor')}</td>
        </tr>`;
    }).join('');
  },

  _readRoleFormPermissions(form) {
    const permissions = {};
    ASSIGNABLE_TABS.forEach(([tab]) => {
      const checked = form.querySelector(`input[name="tabLevel_${tab}"]:checked`);
      const level = checked ? checked.value : 'none';
      if (level !== 'none') permissions[tab] = level;
    });
    return permissions;
  },

  resetRoleForm() {
    const form = document.getElementById('roleForm');
    if (form) form.reset();
    const keyEl = document.getElementById('roleFormKey');
    if (keyEl) keyEl.value = '';
    document.getElementById('roleFormTitle').textContent = 'Create Role';
    document.getElementById('roleFormSubmitBtn').textContent = 'Create Role';
    const cancelBtn = document.getElementById('roleFormCancelEditBtn');
    if (cancelBtn) cancelBtn.style.display = 'none';
    const tbody = document.getElementById('roleFormTabsBody');
    if (tbody) tbody.innerHTML = this._roleFormTabsHtml({});
  },

  editRole(roleKey) {
    const role = (App.State.globalCustomRoles || []).find(r => r.roleKey === roleKey);
    if (!role) return;
    document.getElementById('roleFormKey').value = role.roleKey;
    document.getElementById('roleFormName').value = role.roleName;
    document.getElementById('roleFormTitle').textContent = `Edit Role: ${role.roleName}`;
    document.getElementById('roleFormSubmitBtn').textContent = 'Update Role';
    const cancelBtn = document.getElementById('roleFormCancelEditBtn');
    if (cancelBtn) cancelBtn.style.display = '';
    const tbody = document.getElementById('roleFormTabsBody');
    if (tbody) tbody.innerHTML = this._roleFormTabsHtml(role.permissions);
  },

  async submitRoleForm(e) {
    e.preventDefault();
    const form = e.target;
    const roleKey = document.getElementById('roleFormKey').value;
    const roleName = form.roleName.value.trim();
    const permissions = this._readRoleFormPermissions(form);

    const btn = document.getElementById('roleFormSubmitBtn');
    if (btn) btn.disabled = true;
    try {
      const res = roleKey
        ? await Api.mutate('updateCustomRole', roleKey, roleName, permissions)
        : await Api.mutate('createCustomRole', roleName, permissions);
      App.Utils.showToast(res?.message || (res?.success ? 'Role saved.' : 'Failed to save role.'), !res?.success);
      if (res?.success) {
        this.resetRoleForm();
        await this.loadRoles();
      }
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to save role.', true);
    } finally {
      if (btn) btn.disabled = false;
    }
  },

  deleteRole(roleKey) {
    const role = (App.State.globalCustomRoles || []).find(r => r.roleKey === roleKey);
    if (!role) return;
    const inUseNote = role.userCount > 0
      ? ` It's still assigned to ${role.userCount} user(s) -- reassign them to a different role first.`
      : '';
    App.Utils.confirmAction(
      `Delete the "${role.roleName}" role? This cannot be undone.${inUseNote}`,
      async () => {
        try {
          const res = await Api.mutate('deleteCustomRole', roleKey);
          App.Utils.showToast(res?.message || (res?.success ? 'Role deleted.' : 'Failed to delete role.'), !res?.success);
          if (res?.success) await this.loadRoles();
        } catch (err) {
          App.Utils.showToast(err.message || 'Failed to delete role.', true);
        }
      }
    );
  }
};

document.addEventListener('DOMContentLoaded', () => {
  const tbody = document.getElementById('usersTableBody');
  if (!tbody) return; // tab not rendered for this user (not an admin)

  tbody.addEventListener('change', e => {
    const select = e.target.closest('[data-action="user-role-select"]');
    if (select) App.Users.changeRole(select.dataset.id, select.value);
  });

  tbody.addEventListener('click', e => {
    const deactivateBtn = e.target.closest('[data-action="user-deactivate"]');
    if (deactivateBtn) return App.Users.deactivate(deactivateBtn.dataset.id);
    const reactivateBtn = e.target.closest('[data-action="user-reactivate"]');
    if (reactivateBtn) return App.Users.reactivate(reactivateBtn.dataset.id);
  });

  document.getElementById('createUserForm')?.addEventListener('submit', e => App.Users.submitCreate(e));
  document.getElementById('roleForm')?.addEventListener('submit', e => App.Users.submitRoleForm(e));
});
