/**
 * Master data and the one-tap lot status (Phase 6).
 *
 * Colours, models, process types and units feed every picker in the app,
 * so a value that was missing had no route in on a phone: the Log Lot
 * cascade simply could not be completed until someone opened a laptop.
 *
 * Changing a lot's status previously meant opening the full edit sheet --
 * process cascade, colour checklist and all -- to change one field.
 */

'use strict';

const fs = require('fs');
const path = require('path');

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
    <div id="mapp-sheet-backdrop"></div>
    <div class="mb-sheet" id="sheet-master">
      <h2 id="master-title"></h2>
      <div class="mb-search"><input type="search" id="master-search"></div>
      <div id="master-list"></div>
    </div>
    <div class="mb-sheet" id="sheet-master-form">
      <h2 id="master-form-title"></h2>
      <div id="master-form-body"></div>
      <button id="master-form-save-btn">Save</button>
    </div>
    <div class="mb-toast-stack" id="mapp-toast-stack"></div>`;
  loadAsGlobal('api.js', 'Api');
  loadAsGlobal('mobile.js', 'MApp');
  MApp.Sheet._stack = [];
  MApp.Paging._shown = {};
  window.confirm = jest.fn(() => true);
  Element.prototype.scrollIntoView = jest.fn();
}

const COLORS = [{ name: 'Purple-Wine', remarks: 'PW' }, { name: 'Black', remarks: '' }];
const UNITS = [{ unitName: 'Dozen', family: 'Count', factorToBase: 12, remarks: '' }];

describe('MApp.Master', () => {
  beforeEach(mount);

  const list = () => document.getElementById('master-list').textContent;

  test('each register reads from its own endpoint', async () => {
    MApp.Api.call = jest.fn(async () => ({ success: true, data: COLORS }));
    await MApp.Master.open('color');
    expect(MApp.Api.call).toHaveBeenCalledWith('getColors');

    MApp.Api.call = jest.fn(async () => ({ success: true, data: [] }));
    await MApp.Master.open('model');
    expect(MApp.Api.call).toHaveBeenCalledWith('getModels');

    MApp.Api.call = jest.fn(async () => ({ success: true, data: [] }));
    await MApp.Master.open('processType');
    expect(MApp.Api.call).toHaveBeenCalledWith('getProcessTypes');

    MApp.Api.call = jest.fn(async () => ({ success: true, data: UNITS }));
    await MApp.Master.open('unit');
    expect(MApp.Api.call).toHaveBeenCalledWith('getUnitsData');
  });

  test('lists rows by their own identity field', async () => {
    // Tags key on `name`; units key on `unitName`.
    MApp.Api.call = jest.fn(async () => ({ success: true, data: COLORS }));
    await MApp.Master.open('color');
    expect(list()).toContain('Purple-Wine');

    MApp.Api.call = jest.fn(async () => ({ success: true, data: UNITS }));
    await MApp.Master.open('unit');
    expect(list()).toContain('Dozen');
    expect(list()).toContain('1 = 12 base');
  });

  test('a unit form asks for the fields a unit actually needs', async () => {
    MApp.Api.call = jest.fn(async () => ({ success: true, data: UNITS }));
    await MApp.Master.open('unit');

    MApp.Master.openForm(null);

    expect(document.getElementById('master-form-family')).not.toBeNull();
    expect(document.getElementById('master-form-factorToBase')).not.toBeNull();
    // …and a colour form does not.
    MApp.Master.type = 'color';
    MApp.Master.openForm(null);
    expect(document.getElementById('master-form-family')).toBeNull();
  });

  test('an edit sends the name the record had BEFORE the form', async () => {
    // Renaming is a normal edit here, so the identity sent must be the
    // old one or the server would create a second row.
    let call = null;
    MApp.Api.call = jest.fn(async () => ({ success: true, data: COLORS }));
    MApp.Util.mutateSimple = jest.fn(async (m, args) => { call = { m, args }; return { success: false }; });
    await MApp.Master.open('color');

    MApp.Master.openForm(COLORS[0]);
    document.getElementById('master-form-name').value = 'Purple Wine';
    await MApp.Master.save();

    expect(call.m).toBe('saveColor');
    expect(call.args[0]).toEqual({ name: 'Purple Wine', remarks: 'PW', originalName: 'Purple-Wine' });
  });

  test('a new record sends no original name', async () => {
    let call = null;
    MApp.Api.call = jest.fn(async () => ({ success: true, data: COLORS }));
    MApp.Util.mutateSimple = jest.fn(async (m, args) => { call = { m, args }; return { success: false }; });
    await MApp.Master.open('color');

    MApp.Master.openForm(null);
    document.getElementById('master-form-name').value = 'Teal';
    await MApp.Master.save();

    expect(call.args[0].originalName).toBeUndefined();
    expect(call.args[0].name).toBe('Teal');
  });

  test('a unit edit keys on originalUnitName, not originalName', async () => {
    let call = null;
    MApp.Api.call = jest.fn(async () => ({ success: true, data: UNITS }));
    MApp.Util.mutateSimple = jest.fn(async (m, args) => { call = { m, args }; return { success: false }; });
    await MApp.Master.open('unit');

    MApp.Master.openForm(UNITS[0]);
    await MApp.Master.save();

    expect(call.m).toBe('saveUnit');
    expect(call.args[0].originalUnitName).toBe('Dozen');
  });

  test('a blank name is refused at the field', async () => {
    MApp.Api.call = jest.fn(async () => ({ success: true, data: COLORS }));
    MApp.Util.mutateSimple = jest.fn();
    await MApp.Master.open('color');

    MApp.Master.openForm(null);
    await MApp.Master.save();

    expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();
    expect(document.getElementById('master-form-name').getAttribute('aria-invalid')).toBe('true');
  });

  test('a unit without a conversion factor is refused', async () => {
    // Getting factorToBase wrong silently rescales every quantity ever
    // entered in that unit, so it is required rather than defaulted.
    MApp.Api.call = jest.fn(async () => ({ success: true, data: UNITS }));
    MApp.Util.mutateSimple = jest.fn();
    await MApp.Master.open('unit');

    MApp.Master.openForm(null);
    document.getElementById('master-form-unitName').value = 'Gross';
    document.getElementById('master-form-family').value = 'Count';
    await MApp.Master.save();

    expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();
  });

  test('delete sends the identity and confirms first', async () => {
    let call = null;
    MApp.Api.call = jest.fn(async () => ({ success: true, data: COLORS }));
    MApp.Util.mutateSimple = jest.fn(async (m, args) => { call = { m, args }; return { success: false }; });
    await MApp.Master.open('color');

    await MApp.Master.remove(COLORS[1]);

    expect(window.confirm).toHaveBeenCalled();
    expect(call.m).toBe('deleteColor');
    expect(call.args).toEqual(['Black']);
  });

  test('search filters the register', async () => {
    MApp.Api.call = jest.fn(async () => ({ success: true, data: COLORS }));
    await MApp.Master.open('color');

    MApp.Master.onSearch('wine');

    expect(MApp.Master.filtered.map(r => r.name)).toEqual(['Purple-Wine']);
  });

  test('a response for a register no longer open is discarded', async () => {
    let release;
    MApp.Api.call = jest.fn(() => {
      if (MApp.Master.type === 'color') return new Promise(r => { release = () => r({ success: true, data: COLORS }); });
      return Promise.resolve({ success: true, data: UNITS });
    });

    const first = MApp.Master.open('color');
    await MApp.Master.open('unit');
    release();
    await first;

    expect(MApp.Master.type).toBe('unit');
    expect(MApp.Master.rows).toEqual(UNITS);
  });
});

describe('MApp.Production.changeStatus', () => {
  beforeEach(() => {
    mount();
    document.body.insertAdjacentHTML('beforeend', `
      <div class="mb-sheet" id="mapp-picker-sheet">
        <h2 id="mapp-picker-title"></h2>
        <div id="mapp-picker-search-wrap"><input id="mapp-picker-search"></div>
        <div id="mapp-picker-list"></div>
      </div>`);
    MApp.Production.load = jest.fn();
  });

  const LOT = { rowIdx: 42, lotNumber: 'LOT-1042', qty: 100, status: 'Pending' };
  const pick = label => {
    const btn = [...document.querySelectorAll('#mapp-picker-list .mb-picker-option')]
      .find(b => b.textContent.trim().startsWith(label));
    btn.click();
  };

  test('sends the row id, the expected qty and the new status', async () => {
    // expected_qty is a concurrency guard: the server refuses if the
    // record shifted since this list was drawn, which on a phone showing
    // a list loaded some time ago is a real possibility.
    Api.mutateWithId = jest.fn(async () => ({ success: true, message: 'Lot #LOT-1042 status updated to "Completed".' }));
    const done = MApp.Production.changeStatus(LOT);
    await Promise.resolve();
    pick('Completed');
    await done;

    const call = Api.mutateWithId.mock.calls[0];
    expect(call[0]).toBe('updateProductionStatus');
    expect(call.slice(2)).toEqual([42, 100, 'Completed']);
  });

  test('shows the SERVER message, so a pool warning is not swallowed', async () => {
    // Completing a lot can drive a Warehouse Pool bucket negative and the
    // server says so in its message. A canned "Status updated." would
    // discard exactly the signal this app treats as important.
    const warning = 'Lot #LOT-1042 status updated to "Completed". Warning: short by 5. Warehouse Pool stock will now show negative for this item.';
    Api.mutateWithId = jest.fn(async () => ({ success: true, message: warning }));
    const spy = jest.spyOn(MApp.Toast, 'success');

    const done = MApp.Production.changeStatus(LOT);
    await Promise.resolve();
    pick('Completed');
    await done;

    expect(spy).toHaveBeenCalledWith(warning);
    spy.mockRestore();
  });

  test('picking the status it already has does nothing', async () => {
    Api.mutateWithId = jest.fn();
    const done = MApp.Production.changeStatus(LOT);
    await Promise.resolve();
    pick('Pending');
    await done;

    expect(Api.mutateWithId).not.toHaveBeenCalled();
  });

  test('dismissing the picker does nothing', async () => {
    Api.mutateWithId = jest.fn();
    const done = MApp.Production.changeStatus(LOT);
    await Promise.resolve();
    MApp.Picker.cancel();
    await done;

    expect(Api.mutateWithId).not.toHaveBeenCalled();
  });

  test('a refusal is reported and the list is not reloaded', async () => {
    Api.mutateWithId = jest.fn(async () => ({ success: false, message: 'Data mismatch: The record has been modified or shifted. Please refresh.' }));
    const spy = jest.spyOn(MApp.Toast, 'error');

    const done = MApp.Production.changeStatus(LOT);
    await Promise.resolve();
    pick('Completed');
    await done;

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('modified or shifted'));
    expect(MApp.Production.load).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
