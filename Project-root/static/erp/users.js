'use strict';
// users.js -- App.Users, the admin-only User Management tab.
//
// This is the first UI consumer of RpcSpec.roles (registry.py / rpc.py):
// getUsersData/updateUserRole/deactivateUser/reactivateUser are all
// admin-gated server-side, so this file is only loaded (and its sidebar
// entry only rendered) when current_user.role == 'admin' -- see
// templates/erp/index.html's {% if current_user.role == 'admin' %} guards
// around this <script> tag, the sidebar button, and the tab partial itself.
// A non-admin who somehow reached these RPC methods directly would still
// get a 403 from the server, which is the layer that actually matters.

const ROLE_LABELS = {
  pending_approval: 'Pending Approval',
  user: 'User',
  admin: 'Admin'
};

function _currentUserId() {
  const raw = document.querySelector('meta[name="current-user-id"]')?.getAttribute('content');
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

App.Users = {
  loadData() {
    const tbody = document.getElementById('usersTableBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="text-center p-4">Loading users…</td></tr>';

    return Api.call('getUsersData')
      .then(res => {
        if (!res?.success) {
          App.Utils.showToast(res?.message || 'Failed to load users.', true);
          if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="text-center p-4 text-danger">Failed to load users.</td></tr>';
          return;
        }
        App.State.globalUsers = res.data || [];
        this.filterData(App.State.usersSearchTerm || '');
      })
      .catch(err => {
        App.Utils.showToast(err.message || 'Failed to load users.', true);
      });
  },

  filterData(term) {
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
        tbody.innerHTML = '<tr><td colspan="6" class="text-center p-4 text-muted">No users found.</td></tr>';
      }
      return;
    }
    if (emptyState) emptyState.style.display = 'none';
    tbody.innerHTML = rows.map(u => this.rowHtml(u)).join('');
  },

  rowHtml(u) {
    const selfId = _currentUserId();
    const isSelf = selfId != null && selfId === Number(u.id);
    const roleOptions = Object.keys(ROLE_LABELS)
      .map(r => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${escapeHtml(ROLE_LABELS[r] || r)}</option>`)
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

    return `
      <tr>
        <td>${escapeHtml(u.name || '-')}</td>
        <td>${escapeHtml(u.email || '-')}</td>
        <td>
          <select class="form-select form-select-sm" data-action="user-role-select" data-id="${u.id}" ${isSelf ? 'disabled title="You cannot change your own role"' : ''}>
            ${roleOptions}
          </select>
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

  async reactivate(userId) {
    try {
      const res = await Api.mutate('reactivateUser', Number(userId));
      App.Utils.showToast(res?.message || 'User reactivated.', !res?.success);
      if (res?.success) await this.loadData();
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to reactivate user.', true);
    }
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
});
