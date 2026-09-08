/**
 * Low-stock threshold and dead stock (Phase 6).
 *
 * Home leads with a "Low-stock alerts" tile and Stock has a low-stock
 * filter, and nothing on the phone could change the threshold that raises
 * either -- an alarm with no way to tune it. Dead stock had the same
 * shape: desktop-only, and invisible on a phone even once set.
 *
 * These are saved apart from the stock correction in the same sheet.
 * That correction is an audited event about what is physically on the
 * shelf; these two are settings about how the item is watched.
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

const ROW = {
  name: 'Rim 26', size: '26 inch', unit: 'Pcs',
  currentStock: 5, threshold: 20, isLowStock: true, deadStock: false,
};

function mount() {
  jest.resetModules();
  global.fetch = jest.fn();
  document.body.innerHTML = `
    <div id="mapp-sheet-backdrop"></div>
    <div id="stock-list"></div>
    <div class="mb-sheet" id="sheet-stock-adjust">
      <input type="text" id="stock-adjust-item-label">
      <input type="text" id="stock-adjust-old-value">
      <input type="number" id="stock-adjust-new-value">
      <textarea id="stock-adjust-reason"></textarea>
      <input type="number" id="stock-threshold-value">
      <button type="button" id="stock-dead-toggle" aria-pressed="false">No</button>
      <button type="button" id="stock-settings-save-btn">Save low-stock settings</button>
    </div>
    <div class="mb-toast-stack" id="mapp-toast-stack"></div>`;
  loadAsGlobal('api.js', 'Api');
  loadAsGlobal('mobile.js', 'MApp');
  MApp.Sheet._stack = [];
  MApp.Stock.load = jest.fn();
  Element.prototype.scrollIntoView = jest.fn();
}

const threshold = () => document.getElementById('stock-threshold-value');
const deadBtn = () => document.getElementById('stock-dead-toggle');

function openOn(overrides) {
  MApp.Stock.filtered = [{ ...ROW, ...overrides }];
  MApp.Stock.openAdjustSheet(0);
}

describe('MApp.Stock low-stock settings', () => {
  beforeEach(mount);

  test('the sheet opens showing what the item currently has', () => {
    openOn({ threshold: 20, deadStock: true });

    expect(threshold().value).toBe('20');
    expect(deadBtn().textContent).toBe('Yes');
    expect(deadBtn().getAttribute('aria-pressed')).toBe('true');
  });

  test('an item with no threshold opens blank, not zero', () => {
    // Zero is a threshold the server stores happily -- it just switches
    // the item's low-stock alert off for good. Showing it for "unset"
    // would invite saving it by accident.
    openOn({ threshold: null });

    expect(threshold().value).toBe('');
  });

  test('the dead-stock state does not leak between items', () => {
    openOn({ deadStock: true });
    expect(deadBtn().textContent).toBe('Yes');

    openOn({ deadStock: false });
    expect(deadBtn().textContent).toBe('No');
    expect(MApp.Stock._deadStock).toBe(false);
  });

  test('the toggle flips both label and aria-pressed', () => {
    openOn({});
    MApp.Stock.toggleDeadStock();

    expect(MApp.Stock._deadStock).toBe(true);
    expect(deadBtn().textContent).toBe('Yes');
    expect(deadBtn().getAttribute('aria-pressed')).toBe('true');
  });

  test('a changed threshold is sent with the item identity', async () => {
    const calls = [];
    MApp.Util.mutateSimple = jest.fn(async (m, args) => { calls.push({ m, args }); return { success: true }; });
    openOn({});
    threshold().value = '30';

    await MApp.Stock.saveSettings();

    expect(calls).toEqual([{ m: 'updateThreshold', args: ['Rim 26', '26 inch', 30] }]);
  });

  test('an unchanged threshold is not written back', async () => {
    // Re-saving to flip only the dead-stock flag should not stamp an
    // identical threshold (and a fresh updated_by) onto the row.
    const calls = [];
    MApp.Util.mutateSimple = jest.fn(async (m, args) => { calls.push({ m, args }); return { success: true }; });
    openOn({});
    MApp.Stock.toggleDeadStock();

    await MApp.Stock.saveSettings();

    expect(calls.map(c => c.m)).toEqual(['updateDeadStock']);
    expect(calls[0].args).toEqual(['Rim 26', '26 inch', true]);
  });

  test('setting a previously unset threshold to zero still sends', async () => {
    // null and 0 are different answers, and a naive numeric compare
    // treats them as the same one.
    const calls = [];
    MApp.Util.mutateSimple = jest.fn(async (m, args) => { calls.push({ m, args }); return { success: true }; });
    openOn({ threshold: null });
    threshold().value = '0';

    await MApp.Stock.saveSettings();

    expect(calls).toEqual([{ m: 'updateThreshold', args: ['Rim 26', '26 inch', 0] }]);
  });

  test('both changes go as two independent mutations', async () => {
    const calls = [];
    MApp.Util.mutateSimple = jest.fn(async (m, args) => { calls.push({ m, args }); return { success: true }; });
    openOn({});
    threshold().value = '30';
    MApp.Stock.toggleDeadStock();

    await MApp.Stock.saveSettings();

    expect(calls.map(c => c.m)).toEqual(['updateThreshold', 'updateDeadStock']);
  });

  test('a refused threshold stops the dead-stock write', async () => {
    // The second call is not a retry of the first; sending it anyway
    // would leave the row half-changed with nothing saying so.
    const calls = [];
    MApp.Util.mutateSimple = jest.fn(async (m, args) => { calls.push({ m, args }); return { success: false }; });
    openOn({});
    threshold().value = '30';
    MApp.Stock.toggleDeadStock();

    await MApp.Stock.saveSettings();

    expect(calls.map(c => c.m)).toEqual(['updateThreshold']);
    expect(MApp.Stock.load).not.toHaveBeenCalled();
  });

  test('a blank threshold is refused before sending', async () => {
    MApp.Util.mutateSimple = jest.fn();
    openOn({});
    threshold().value = '';

    await MApp.Stock.saveSettings();

    expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();
  });

  test('a negative threshold is refused before sending', async () => {
    // The server raises on this; refusing here spends no round trip.
    MApp.Util.mutateSimple = jest.fn();
    openOn({});
    threshold().value = '-5';

    await MApp.Stock.saveSettings();

    expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();
  });

  test('a non-numeric threshold is refused rather than read as zero', async () => {
    MApp.Util.mutateSimple = jest.fn();
    openOn({});
    threshold().setAttribute('type', 'text');
    threshold().value = 'soon';

    await MApp.Stock.saveSettings();

    expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();
  });

  test('the save button is re-enabled after a refusal', async () => {
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: false }));
    openOn({});
    threshold().value = '30';

    await MApp.Stock.saveSettings();

    const btn = document.getElementById('stock-settings-save-btn');
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('Save low-stock settings');
  });

  test('a success reloads the list so the chips redraw', async () => {
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: true }));
    openOn({});
    threshold().value = '30';

    await MApp.Stock.saveSettings();

    expect(MApp.Stock.load).toHaveBeenCalled();
  });

  test('saving with no item open does nothing', async () => {
    MApp.Util.mutateSimple = jest.fn();
    MApp.Stock._adjustItem = null;

    await MApp.Stock.saveSettings();

    expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();
  });
});

describe('Stock card badges', () => {
  beforeEach(mount);

  const render = rows => {
    MApp.Stock.filtered = rows;
    MApp.Stock.render();
    return document.getElementById('stock-list').textContent;
  };

  test('a dead-stock item says so on the card', () => {
    // Otherwise the flag is settable but invisible, and nobody can tell
    // whether the tap landed.
    expect(render([{ ...ROW, isLowStock: false, deadStock: true }])).toContain('Dead stock');
  });

  test('an item can be both low and dead', () => {
    const text = render([{ ...ROW, isLowStock: true, deadStock: true }]);
    expect(text).toContain('Low stock');
    expect(text).toContain('Dead stock');
  });

  test('an ordinary item carries neither badge', () => {
    const text = render([{ ...ROW, isLowStock: false, deadStock: false }]);
    expect(text).not.toContain('Low stock');
    expect(text).not.toContain('Dead stock');
  });
});
