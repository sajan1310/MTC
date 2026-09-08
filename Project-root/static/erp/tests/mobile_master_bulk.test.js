/**
 * Bulk delete on the master-data registers, and the stacking bug that
 * made multi-select unusable everywhere it lived inside a sheet (Phase 6).
 *
 * The action bar was z-index 90 against .mb-sheet's 101, so on the PO
 * ledger, the Bill ledger, Issue records and now the registers, a
 * long-press highlighted rows and then offered nothing: the bar --
 * including its Cancel -- rendered behind the sheet it was acting on.
 * Those lists have shipped in that state, so the assertions below are
 * about the stacking order, not only about the new screen.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'mobile_styles.css'), 'utf8');

function loadAsGlobal(relPath, exportName) {
  const code = fs
    .readFileSync(path.join(__dirname, '..', relPath), 'utf8')
    .replace(new RegExp(`^const ${exportName} = `, 'm'), `global.${exportName} = `);
  // eslint-disable-next-line no-eval
  eval(code);
}

/**
 * The z-index a selector declares. Several of these selectors are reopened
 * in the landscape and tablet media blocks to adjust other properties, so
 * this collects every rule for the selector and takes the one that sets a
 * z-index -- and refuses if two of them do, because then the answer
 * depends on the cascade and this helper would be guessing.
 */
function zIndexOf(selector) {
  const found = [];
  for (let at = CSS.indexOf(selector + ' {'); at !== -1; at = CSS.indexOf(selector + ' {', at + 1)) {
    const m = CSS.slice(at, CSS.indexOf('\n}', at)).match(/z-index:\s*(\d+)/);
    if (m) found.push(Number(m[1]));
  }
  if (found.length === 0) throw new Error(`${selector} declares no z-index`);
  if (found.length > 1) throw new Error(`${selector} declares z-index in ${found.length} rules`);
  return found[0];
}

const COLORS = [
  { name: 'Purple-Wine', remarks: 'PW' },
  { name: 'Black', remarks: '' },
  { name: 'Teal', remarks: '' },
];
const UNITS = [{ unitName: 'Dozen', family: 'Count', factorToBase: 12, remarks: '' }];

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
    <div class="mb-select-bar" id="mapp-select-bar">
      <span id="mapp-select-count"></span>
      <button type="button" id="mapp-select-delete">Delete</button>
    </div>
    <div class="mb-toast-stack" id="mapp-toast-stack"></div>`;
  loadAsGlobal('api.js', 'Api');
  loadAsGlobal('mobile.js', 'MApp');
  MApp.Sheet._stack = [];
  MApp.Paging._shown = {};
  MApp.Select._state = null;
  window.confirm = jest.fn(() => true);
  Element.prototype.scrollIntoView = jest.fn();
}

describe('the selection bar stacks above the sheets it acts inside', () => {
  test('above .mb-sheet', () => {
    expect(zIndexOf('.mb-select-bar')).toBeGreaterThan(zIndexOf('.mb-sheet'));
  });

  test('below the picker screen, which opens on top of everything', () => {
    // A picker is a full-screen takeover; the selection bar showing
    // through one would be a control belonging to a hidden list.
    expect(zIndexOf('.mb-select-bar')).toBeLessThan(zIndexOf('.mb-picker-screen'));
  });

  test('an open sheet drops the bar to the bottom edge', () => {
    // Its default offset clears the tab bar, which a sheet covers -- so
    // without this it floats with a strip of sheet showing beneath it.
    expect(CSS).toMatch(/body\.mb-sheet-open \.mb-select-bar \{[^}]*bottom:/);
  });
});

describe('MApp.Sheet marks the body while a sheet is up', () => {
  beforeEach(mount);

  test('added on open, removed once the last sheet closes', () => {
    MApp.Sheet.open('sheet-master');
    expect(document.body.classList.contains('mb-sheet-open')).toBe(true);

    MApp.Sheet.close('sheet-master');
    expect(document.body.classList.contains('mb-sheet-open')).toBe(false);
  });

  test('a stacked sheet closing does not clear it early', () => {
    document.body.insertAdjacentHTML('beforeend', '<div class="mb-sheet" id="sheet-second"></div>');
    MApp.Sheet.open('sheet-master');
    MApp.Sheet.open('sheet-second');
    MApp.Sheet.close('sheet-second');

    expect(document.body.classList.contains('mb-sheet-open')).toBe(true);
  });
});

describe('MApp.Master bulk delete', () => {
  beforeEach(mount);

  const rows = () => [...document.querySelectorAll('#master-list .mb-card')];

  async function openColours() {
    MApp.Api.call = jest.fn(async () => ({ success: true, data: COLORS }));
    await MApp.Master.open('color');
  }

  test('each register bulk-deletes through its own endpoint', async () => {
    await openColours();
    expect(MApp.Master.selectSpec().method).toBe('deleteColorsBulk');

    MApp.Master.type = 'model';
    expect(MApp.Master.selectSpec().method).toBe('deleteModelsBulk');
    MApp.Master.type = 'processType';
    expect(MApp.Master.selectSpec().method).toBe('deleteProcessTypesBulk');
    MApp.Master.type = 'unit';
    expect(MApp.Master.selectSpec().method).toBe('deleteUnitsBulk');
  });

  test('the payload is the identity field, which units spell differently', async () => {
    await openColours();
    expect(MApp.Master.selectSpec().payload(COLORS)).toEqual([['Purple-Wine', 'Black', 'Teal']]);

    MApp.Api.call = jest.fn(async () => ({ success: true, data: UNITS }));
    await MApp.Master.open('unit');
    expect(MApp.Master.selectSpec().payload(UNITS)).toEqual([['Dozen']]);
  });

  test('all four registers share one selection key', async () => {
    // Switching register re-renders, and MApp.Select exits a selection
    // whose key matches -- so a colour selection cannot survive behind a
    // list of units and be deleted from there.
    await openColours();
    const colourKey = MApp.Master.selectSpec().key;
    MApp.Master.type = 'unit';
    expect(MApp.Master.selectSpec().key).toBe(colourKey);
  });

  test('long-pressing a row and confirming sends the selected names', async () => {
    await openColours();
    let call = null;
    MApp.Util.mutateSimple = jest.fn(async (m, args) => { call = { m, args }; return { success: true }; });
    MApp.Master.open = jest.fn();

    jest.useFakeTimers();
    rows()[0].dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
    jest.advanceTimersByTime(MApp.Select.LONG_PRESS_MS);
    jest.useRealTimers();

    rows()[2].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await MApp.Select.deleteSelected();

    expect(call.m).toBe('deleteColorsBulk');
    expect(call.args).toEqual([['Purple-Wine', 'Teal']]);
  });

  test('the confirm says what a master-data delete actually does', async () => {
    // Not "this can't be undone": the server soft-deletes the row and
    // never looks at who references it, so existing records keep the
    // text and only the pickers stop offering it. Saying otherwise would
    // stop someone doing a tidy-up that is in fact safe.
    await openColours();
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: true }));
    MApp.Master.open = jest.fn();

    MApp.Select._state = {
      key: 'master', config: MApp.Master.selectSpec(),
      rows: COLORS, nodes: rows(), listEl: document.getElementById('master-list'),
      selected: new Set([0]),
    };
    await MApp.Select.deleteSelected();

    const asked = window.confirm.mock.calls[0][0];
    expect(asked).toContain('Delete 1 colour?');
    expect(asked).toContain('no longer appear in suggestions');
    expect(asked).not.toContain("can't be undone");
  });

  test('other lists keep the plain warning', async () => {
    // The note is opt-in; deleting a lot or a bill really is not
    // recoverable from the app.
    expect(MApp.Production.SELECT.note).toBeUndefined();

    MApp.Util.mutateSimple = jest.fn(async () => ({ success: true }));
    MApp.Select._state = {
      key: 'production', config: { ...MApp.Production.SELECT, onDone: null },
      rows: [{ rowIdx: 1 }], nodes: [], listEl: null, selected: new Set([0]),
    };
    await MApp.Select.deleteSelected();

    expect(window.confirm.mock.calls[0][0]).toContain("can't be undone");
  });

  test('declining the confirm sends nothing', async () => {
    window.confirm = jest.fn(() => false);
    await openColours();
    MApp.Util.mutateSimple = jest.fn();

    MApp.Select._state = {
      key: 'master', config: MApp.Master.selectSpec(),
      rows: COLORS, nodes: rows(), listEl: document.getElementById('master-list'),
      selected: new Set([0, 1]),
    };
    await MApp.Select.deleteSelected();

    expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();
  });

  test('a successful delete reloads the register that is open', async () => {
    await openColours();
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: true }));
    const spec = MApp.Master.selectSpec();
    MApp.Master.open = jest.fn();

    MApp.Select._state = {
      key: 'master', config: spec,
      rows: COLORS, nodes: rows(), listEl: document.getElementById('master-list'),
      selected: new Set([1]),
    };
    await MApp.Select.deleteSelected();

    expect(MApp.Master.open).toHaveBeenCalledWith('color');
  });

  test('a single-row delete asks the same honest question', async () => {
    await openColours();
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: true }));
    MApp.Master.open = jest.fn();

    await MApp.Master.remove(COLORS[0]);

    const asked = window.confirm.mock.calls[0][0];
    expect(asked).toContain('no longer appear in suggestions');
    expect(MApp.Util.mutateSimple).toHaveBeenCalledWith('deleteColor', ['Purple-Wine'], expect.any(String));
  });
});
