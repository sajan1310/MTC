/**
 * Custom roles, and deactivating users in bulk (Phase 7) -- the last of
 * the parity backlog.
 *
 * The plan filed the permissions editor as "read-only + handoff", on the
 * assumption that a matrix needs a desktop. Reading the contract said
 * otherwise: a role is a name plus eleven tabs each at one of three
 * levels, which is eleven rows with a three-way choice.
 *
 * The tab list and the levels are the SERVER's. _validate_permissions
 * rejects an unknown tab or an unknown level outright, so anything this
 * screen offers beyond them would be offering a save that bounces --
 * which is what the first two tests are for.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROLES_PY = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'app', 'erp', 'services', 'roles_service.py'), 'utf8'
);

function loadAsGlobal(relPath, exportName) {
  const code = fs
    .readFileSync(path.join(__dirname, '..', relPath), 'utf8')
    .replace(new RegExp(`^const ${exportName} = `, 'm'), `global.${exportName} = `);
  // eslint-disable-next-line no-eval
  eval(code);
}

const ROLES = [
  { roleKey: 'store_keeper', roleName: 'Store Keeper', permissions: { stockTab: 'editor', itemMaster: 'viewer' }, userCount: 2 },
  { roleKey: 'viewer_only', roleName: 'Viewer Only', permissions: {}, userCount: 0 },
];

const USERS = [
  { id: 1, name: 'rakesh', email: 'r@x.com', role: 'store_keeper', isActive: true },
  { id: 2, name: 'sunita', email: 's@x.com', role: 'admin', isActive: true },
];

function mount() {
  jest.resetModules();
  global.fetch = jest.fn();
  document.body.innerHTML = `
    <div id="mapp-sheet-backdrop"></div>
    <div class="mb-sheet" id="sheet-roles"><div id="roles-list"></div></div>
    <div class="mb-sheet" id="sheet-role-form">
      <h2 id="role-form-title"></h2>
      <input type="text" id="role-form-name">
      <div id="role-form-permissions"></div>
      <button id="role-form-save-btn">Save</button>
    </div>
    <div class="mb-search"><input type="search" id="admin-users-search"></div>
    <div id="admin-users-list"></div>
    <div class="mb-select-bar" id="mapp-select-bar"><span id="mapp-select-count"></span></div>
    <div class="mb-toast-stack" id="mapp-toast-stack"></div>`;
  loadAsGlobal('api.js', 'Api');
  loadAsGlobal('mobile.js', 'MApp');
  MApp.Sheet._stack = [];
  MApp.Paging._shown = {};
  MApp.Select._state = null;
  window.confirm = jest.fn(() => true);
  Element.prototype.scrollIntoView = jest.fn();
}

const list = () => document.getElementById('roles-list');
const open = async () => {
  MApp.Api.call = jest.fn(async () => ({ success: true, data: ROLES }));
  await MApp.Roles.open();
};
const levelsFor = key => [...document.querySelectorAll(`[data-role-tab="${key}"]`)];
const selected = key => levelsFor(key).find(b => b.getAttribute('aria-selected') === 'true');

describe('the tabs and levels mirror the server', () => {
  beforeEach(mount);

  test('every assignable tab is offered, and only those', () => {
    // ASSIGNABLE_TABS is the server's list; _validate_permissions raises
    // on anything else.
    const at = ROLES_PY.indexOf('ASSIGNABLE_TABS = [');
    const block = ROLES_PY.slice(at, ROLES_PY.indexOf(']', at));
    const server = [...block.matchAll(/\("(\w+)",/g)].map(m => m[1]);

    expect(MApp.Roles.TABS.map(t => t[0]).sort()).toEqual(server.sort());
  });

  test('the levels are the server\'s three, plus this screen\'s own "none"', () => {
    // 'none' is how this screen says "not granted". The server has no
    // such level -- an absent key is how no-access is expressed -- so it
    // is stripped on save, which the save test pins.
    const at = ROLES_PY.indexOf('_LEVELS = (');
    const server = [...ROLES_PY.slice(at, ROLES_PY.indexOf(')', at)).matchAll(/"(\w+)"/g)].map(m => m[1]);

    const offered = MApp.Roles.LEVELS.map(l => l[0]);
    expect(offered).toContain('none');
    expect(offered.filter(l => l !== 'none').sort()).toEqual(server.sort());
  });
});

describe('the role list', () => {
  beforeEach(mount);

  test('shows each role, how much it grants and who holds it', async () => {
    await open();

    expect(MApp.Api.call).toHaveBeenCalledWith('getCustomRoles');
    expect(list().textContent).toContain('Store Keeper');
    expect(list().textContent).toContain('2 of 11 tabs');
    expect(list().textContent).toContain('2');
  });

  test('a role granting nothing says zero rather than looking broken', async () => {
    await open();
    expect(list().textContent).toContain('0 of 11 tabs');
  });

  test('no roles yet explains the two built-in ones', async () => {
    MApp.Api.call = jest.fn(async () => ({ success: true, data: [] }));
    await MApp.Roles.open();

    expect(list().textContent).toContain('Admin and Super Admin are built in');
  });

  test('a failure offers a retry', async () => {
    MApp.Api.call = jest.fn(async () => { throw new Error('offline'); });
    await MApp.Roles.open();

    expect(list().querySelector('.mb-state-retry')).not.toBeNull();
  });
});

describe('editing a role', () => {
  beforeEach(mount);

  test('every tab gets a row, with its current level selected', async () => {
    await open();
    MApp.Roles.openForm(ROLES[0]);

    expect(document.querySelectorAll('#role-form-permissions .mb-field')).toHaveLength(11);
    expect(selected('stockTab').dataset.roleLevel).toBe('editor');
    expect(selected('itemMaster').dataset.roleLevel).toBe('viewer');
  });

  test('a tab the role does not mention reads as no access', async () => {
    // Absent means not granted; showing nothing selected would leave the
    // row looking unset rather than answered.
    await open();
    MApp.Roles.openForm(ROLES[0]);

    expect(selected('dispatchTab').dataset.roleLevel).toBe('none');
  });

  test('the name cannot be changed on an existing role', async () => {
    // The key users are stored against is derived from the name server
    // side, so a rename would not move anyone onto it.
    await open();
    MApp.Roles.openForm(ROLES[0]);
    expect(document.getElementById('role-form-name').disabled).toBe(true);

    MApp.Roles.openForm(null);
    expect(document.getElementById('role-form-name').disabled).toBe(false);
  });

  test('tapping a level changes it', async () => {
    await open();
    MApp.Roles.openForm(ROLES[0]);

    levelsFor('dispatchTab').find(b => b.dataset.roleLevel === 'editor').click();

    expect(selected('dispatchTab').dataset.roleLevel).toBe('editor');
  });

  test('"none" is stripped on save, because the server has no such level', async () => {
    let call = null;
    MApp.Util.mutateSimple = jest.fn(async (m, args) => { call = { m, args }; return { success: false }; });
    await open();
    MApp.Roles.openForm(ROLES[0]);

    await MApp.Roles.save();

    expect(call.m).toBe('updateCustomRole');
    expect(call.args[0]).toBe('store_keeper');
    expect(call.args[2]).toEqual({ stockTab: 'editor', itemMaster: 'viewer' });
    expect(Object.values(call.args[2])).not.toContain('none');
  });

  test('a new role sends its name and its grants', async () => {
    let call = null;
    MApp.Util.mutateSimple = jest.fn(async (m, args) => { call = { m, args }; return { success: false }; });
    await open();
    MApp.Roles.openForm(null);
    document.getElementById('role-form-name').value = 'Loader';
    levelsFor('dispatchTab').find(b => b.dataset.roleLevel === 'viewer').click();

    await MApp.Roles.save();

    expect(call.m).toBe('createCustomRole');
    expect(call.args[0]).toBe('Loader');
    expect(call.args[1]).toEqual({ dispatchTab: 'viewer' });
  });

  test('a new role with no name is refused before sending', async () => {
    MApp.Util.mutateSimple = jest.fn();
    await open();
    MApp.Roles.openForm(null);

    await MApp.Roles.save();

    expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();
  });

  test('a role granting nothing at all is allowed', async () => {
    // It is a real thing to define -- somebody who signs in and sees the
    // shared screens only.
    let call = null;
    MApp.Util.mutateSimple = jest.fn(async (m, args) => { call = { m, args }; return { success: false }; });
    await open();
    MApp.Roles.openForm(null);
    document.getElementById('role-form-name').value = 'Nothing';

    await MApp.Roles.save();

    expect(call.args[1]).toEqual({});
  });

  test('a refusal leaves the form open and the button usable', async () => {
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: false }));
    await open();
    MApp.Roles.openForm(ROLES[0]);

    await MApp.Roles.save();

    const btn = document.getElementById('role-form-save-btn');
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('Save');
  });
});

describe('deleting a role', () => {
  beforeEach(mount);

  test('warns when users still hold it, before spending the round trip', async () => {
    // The server refuses and says how many; saying so first is cheaper
    // and less surprising.
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: false }));
    await open();

    await MApp.Roles.remove(ROLES[0]);

    expect(window.confirm.mock.calls[0][0]).toContain('2 user(s) still hold it');
  });

  test('an unheld role is not warned about', async () => {
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: false }));
    await open();

    await MApp.Roles.remove(ROLES[1]);

    expect(window.confirm.mock.calls[0][0]).not.toContain('still hold it');
  });

  test('sends the role key, which is what the server deletes by', async () => {
    let call = null;
    MApp.Util.mutateSimple = jest.fn(async (m, args) => { call = { m, args }; return { success: false }; });
    await open();

    await MApp.Roles.remove(ROLES[1]);

    expect(call).toEqual({ m: 'deleteCustomRole', args: ['viewer_only'] });
  });
});

describe('deactivating users in bulk', () => {
  beforeEach(mount);

  test('sends the user ids', async () => {
    let call = null;
    MApp.Util.mutateSimple = jest.fn(async (m, args) => { call = { m, args }; return { success: true }; });
    MApp.Admin.open = jest.fn();

    MApp.Select._state = {
      key: 'adminUsers', config: MApp.Admin.SELECT,
      rows: USERS, nodes: [], listEl: null, selected: new Set([0, 1]),
    };
    await MApp.Select.deleteSelected();

    expect(call).toEqual({ m: 'bulkDeactivateUsers', args: [[1, 2]] });
  });

  test('asks to Deactivate, not to Delete', async () => {
    // Deactivating is reversible and keeps everything the user recorded.
    // "Delete 2 users?" would describe something worse than what happens.
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: true }));
    MApp.Admin.open = jest.fn();

    MApp.Select._state = {
      key: 'adminUsers', config: MApp.Admin.SELECT,
      rows: USERS, nodes: [], listEl: null, selected: new Set([0, 1]),
    };
    await MApp.Select.deleteSelected();

    const asked = window.confirm.mock.calls[0][0];
    expect(asked).toContain('Deactivate 2 users?');
    expect(asked).toContain('can be reactivated');
    expect(asked).not.toContain('Delete');
  });

  test('the server message is shown, because it names what it skipped', async () => {
    // bulkDeactivateUsers skips the caller's own account and any other
    // super_admin rather than failing the whole call, and says which.
    const msg = 'Deactivated 1 user(s). Skipped 1: your own account.';
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: true, message: msg }));
    const spy = jest.spyOn(MApp.Toast, 'success');
    MApp.Admin.open = jest.fn();

    MApp.Select._state = {
      key: 'adminUsers', config: MApp.Admin.SELECT,
      rows: USERS, nodes: [], listEl: null, selected: new Set([0]),
    };
    await MApp.Select.deleteSelected();

    expect(spy).toHaveBeenCalledWith(msg);
    spy.mockRestore();
  });

  test('a silent endpoint falls back to the right past tense', async () => {
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: true }));
    const spy = jest.spyOn(MApp.Toast, 'success');
    MApp.Admin.open = jest.fn();

    MApp.Select._state = {
      key: 'adminUsers', config: MApp.Admin.SELECT,
      rows: USERS, nodes: [], listEl: null, selected: new Set([0]),
    };
    await MApp.Select.deleteSelected();

    expect(spy).toHaveBeenCalledWith('1 user deactivated.');
    spy.mockRestore();
  });

  test('every other list still says Delete', async () => {
    // The verb is opt-in; deactivation is the one action here that is not
    // a delete.
    expect(MApp.Production.SELECT.verb).toBeUndefined();
    expect(MApp.Admin.SELECT.verb).toBe('Deactivate');
  });
});
