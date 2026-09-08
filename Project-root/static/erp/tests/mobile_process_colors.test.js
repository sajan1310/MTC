/**
 * Which colours a process's pool tracks (Phase 6).
 *
 * The pool derives the list from the process's recipe, its linked
 * processes, and colours already seen in Production and Warehouse Pool.
 * That derivation is usually right, sometimes picks up a combination
 * nobody wanted, and sometimes misses one about to be run for the first
 * time. Both fixes were desktop-only.
 *
 * Whether a row may be removed is the server's call, not this screen's:
 * getAllProcessColorGroups returns `removable`, the subset
 * excludeWarehousePoolColors will actually accept. That flag is also
 * what keeps this screen away from the pool's negatives -- an
 * attribution bucket has real consumption history by definition, so its
 * colour is never removable and this screen cannot make one disappear.
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

const PROCESS = { processId: 'P1', processName: 'Painting', sequence: 1, active: true };
const OTHER = { processId: 'P2', processName: 'Welding', sequence: 2, active: true };

// Black is on the recipe; Purple-Wine was consumed by a real lot without
// ever being produced (the attribution case); Teal exists only because
// somebody recorded an opening balance against it.
const ALL_GROUPS = {
  P1: { colors: ['Black', 'Purple-Wine', 'Teal'], removable: ['Teal'] },
  P2: { colors: [], removable: [] },
};

const MASTER = [{ name: 'Teal', remarks: '' }, { name: 'Sea Green', remarks: 'new' }];

function mount() {
  jest.resetModules();
  global.fetch = jest.fn();
  document.body.innerHTML = `
    <div id="mapp-sheet-backdrop"></div>
    <div class="mb-sheet" id="sheet-process-colors">
      <h2 id="process-colors-title"></h2>
      <div id="process-colors-body"></div>
    </div>
    <div class="mb-sheet" id="mapp-picker-sheet">
      <h2 id="mapp-picker-title"></h2>
      <div id="mapp-picker-search-wrap"><input id="mapp-picker-search"></div>
      <div id="mapp-picker-list"></div>
    </div>
    <div class="mb-toast-stack" id="mapp-toast-stack"></div>`;
  loadAsGlobal('api.js', 'Api');
  loadAsGlobal('mobile.js', 'MApp');
  MApp.Sheet._stack = [];
  MApp.ProcessColors.masterColors = [];
  window.confirm = jest.fn(() => true);
  Element.prototype.scrollIntoView = jest.fn();
}

const body = () => document.getElementById('process-colors-body');
const card = i => body().querySelectorAll('.mb-card')[i];

async function open(process) {
  MApp.Api.call = jest.fn(async m => {
    if (m === 'getAllProcessColorGroups') return { success: true, data: ALL_GROUPS };
    if (m === 'getColors') return { success: true, data: MASTER };
    return { success: false };
  });
  await MApp.ProcessColors.open(process || PROCESS);
}

describe('the list', () => {
  beforeEach(mount);

  test('reads this process\'s entry out of the all-processes call', async () => {
    await open();

    expect(MApp.Api.call).toHaveBeenCalledWith('getAllProcessColorGroups');
    expect(MApp.ProcessColors.colors).toEqual(['Black', 'Purple-Wine', 'Teal']);
    expect(document.getElementById('process-colors-title').textContent).toBe('Colours — Painting');
  });

  test('only the removable row offers Remove', async () => {
    await open();

    expect(card(0).querySelector('[data-color-remove]')).toBeNull(); // Black, on the recipe
    expect(card(1).querySelector('[data-color-remove]')).toBeNull(); // Purple-Wine, real history
    expect(card(2).querySelector('[data-color-remove]')).not.toBeNull(); // Teal
  });

  test('a protected row says why, rather than just being unavailable', async () => {
    // A control that is missing without explanation is indistinguishable
    // from a broken one.
    await open();

    expect(card(0).textContent).toContain('Protected');
    expect(card(0).textContent).toContain('real production or consumption history');
    expect(card(0).textContent).toContain('the pool rebuilds it');
  });

  test('an attribution colour is never offered for removal', async () => {
    // It has real consumption history by definition, so the server marks
    // it unremovable and this screen must not offer the tap at all.
    await open();

    expect(MApp.ProcessColors.isRemovable('Purple-Wine')).toBe(false);
  });

  test('the removable check is case-insensitive', async () => {
    await open();
    expect(MApp.ProcessColors.isRemovable('teal')).toBe(true);
  });

  test('a process with no colours reads as not tracking per colour', async () => {
    await open(OTHER);

    expect(body().textContent).toContain('does not track stock per colour');
  });

  test('a failure offers a retry', async () => {
    MApp.Api.call = jest.fn(async () => { throw new Error('offline'); });
    await MApp.ProcessColors.open(PROCESS);

    expect(document.querySelector('#process-colors-body .mb-state-retry')).not.toBeNull();
  });

  test('a response for a process no longer open is discarded', async () => {
    let release;
    MApp.Api.call = jest.fn(m => {
      if (m !== 'getAllProcessColorGroups') return Promise.resolve({ success: true, data: MASTER });
      if (MApp.ProcessColors.process === PROCESS) {
        return new Promise(r => { release = () => r({ success: true, data: ALL_GROUPS }); });
      }
      return Promise.resolve({ success: true, data: ALL_GROUPS });
    });

    const first = MApp.ProcessColors.open(PROCESS);
    await MApp.ProcessColors.open(OTHER);
    release();
    await first;

    expect(MApp.ProcessColors.process).toBe(OTHER);
    expect(MApp.ProcessColors.colors).toEqual([]);
  });
});

describe('removing a combination', () => {
  beforeEach(mount);

  test('sends the process and the colour as a list', async () => {
    let call = null;
    MApp.Util.mutateSimple = jest.fn(async (m, args) => { call = { m, args }; return { success: false }; });
    await open();

    await MApp.ProcessColors.remove('Teal');

    expect(call).toEqual({ m: 'excludeWarehousePoolColors', args: ['P1', ['Teal']] });
  });

  test('the confirmation says the opening balance goes too', async () => {
    // Excluding deletes the colour's opening-stock and correction rows so
    // the pool does not rebuild the bucket. That is entered data going
    // away, and nobody would guess it from the word "Remove".
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: false }));
    await open();

    await MApp.ProcessColors.remove('Teal');

    const asked = window.confirm.mock.calls[0][0];
    expect(asked).toContain('opening balance or correction');
    expect(asked).toContain('deleted');
  });

  test('declining sends nothing', async () => {
    window.confirm = jest.fn(() => false);
    MApp.Util.mutateSimple = jest.fn();
    await open();

    await MApp.ProcessColors.remove('Teal');

    expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();
  });

  test('the server message is shown, because it names what it refused', async () => {
    // excludeWarehousePoolColors reports removed and blocked separately,
    // giving a reason per blocked colour. A canned message would drop
    // exactly the half that explains why nothing happened.
    const msg = 'Removed 0 combination(s). 1 skipped (can\'t be removed): Teal (has real production/consumption history).';
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: true, message: msg }));
    const spy = jest.spyOn(MApp.Toast, 'success');
    await open();
    MApp.ProcessColors.load = jest.fn();

    await MApp.ProcessColors.remove('Teal');

    expect(spy).toHaveBeenCalledWith(msg);
    spy.mockRestore();
  });

  test('a success reloads the list from the server', async () => {
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: true }));
    await open();
    MApp.ProcessColors.load = jest.fn();

    await MApp.ProcessColors.remove('Teal');

    expect(MApp.ProcessColors.load).toHaveBeenCalled();
  });
});

describe('adding a combination', () => {
  beforeEach(mount);

  const pick = label => {
    const btn = [...document.querySelectorAll('#mapp-picker-list .mb-picker-option')]
      .find(b => b.textContent.trim().startsWith(label));
    btn.click();
  };

  test('offers Colour Master, marking the ones already tracked', async () => {
    // Already-known colours stay in the list on purpose: re-adding one is
    // how a previous exclusion is undone.
    await open();
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: false }));

    const done = MApp.ProcessColors.add();
    await Promise.resolve();
    const rows = [...document.querySelectorAll('#mapp-picker-list .mb-picker-option')]
      .map(b => b.textContent.trim());
    pick('Sea Green');
    await done;

    expect(rows[0]).toContain('Already tracked'); // Teal
    expect(rows[1]).not.toContain('Already tracked');
  });

  test('sends the process and the single colour', async () => {
    let call = null;
    MApp.Util.mutateSimple = jest.fn(async (m, args) => { call = { m, args }; return { success: false }; });
    await open();

    const done = MApp.ProcessColors.add();
    await Promise.resolve();
    pick('Sea Green');
    await done;

    expect(call).toEqual({ m: 'includeWarehousePoolColor', args: ['P1', 'Sea Green'] });
  });

  test('dismissing the picker sends nothing', async () => {
    MApp.Util.mutateSimple = jest.fn();
    await open();

    const done = MApp.ProcessColors.add();
    await Promise.resolve();
    MApp.Picker.cancel();
    await done;

    expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();
  });

  test('a colour list that never loaded says so rather than opening empty', async () => {
    MApp.Api.call = jest.fn(async m => {
      if (m === 'getAllProcessColorGroups') return { success: true, data: ALL_GROUPS };
      return { success: false };
    });
    await MApp.ProcessColors.open(PROCESS);
    const spy = jest.spyOn(MApp.Toast, 'error');

    await MApp.ProcessColors.add();

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('still loading'));
    spy.mockRestore();
  });

  test('a success reloads the list', async () => {
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: true }));
    await open();
    MApp.ProcessColors.load = jest.fn();

    const done = MApp.ProcessColors.add();
    await Promise.resolve();
    pick('Sea Green');
    await done;

    expect(MApp.ProcessColors.load).toHaveBeenCalled();
  });
});
