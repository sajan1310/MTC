/**
 * Warehouse Pool opening balances on the phone (Phase 6).
 *
 * An opening entry is the only way to credit a bucket without completing
 * a lot: what was already on the rack, and the dated deltas a manual
 * correction writes. Both land in erp.warehouse_pool_opening, which is
 * why this list has to say which is which -- one is a count, the other
 * is somebody's later judgement.
 *
 * The colour rule is the substantive one. A process with known colours
 * tracks stock per colour, and a balance logged without one lands in an
 * untagged bucket that a colour-aware lot never draws from: the stock is
 * entered and still invisible. The server refuses that, and this asks
 * from the same source (getProcessColorGroups) so the picker and the
 * refusal can never disagree.
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

const OPENINGS = [
  {
    rowIdx: 5, outputItemName: 'Frame 26', processId: 'P1', processName: 'Welding',
    productTag: '', color: 'Black', qty: 40, date: '01/09/2026', dateRaw: '2026-09-01',
    remarks: 'counted on the rack',
  },
  {
    rowIdx: 6, outputItemName: 'Rim 26', processId: 'P2', processName: 'Truing',
    productTag: 'KALPI', color: '', qty: -5, date: '05/09/2026', dateRaw: '2026-09-05',
    remarks: 'Correction: physical recount',
  },
];

const PROCESSES = [
  { processId: 'P1', processName: 'Welding', sequence: 1, active: true, isFinalStage: false, outputItemName: 'Frame 26' },
  { processId: 'P2', processName: 'Assembly', sequence: 9, active: true, isFinalStage: true, outputItemName: 'Kalpi 26' },
  { processId: 'P3', processName: 'Retired', sequence: 4, active: false, isFinalStage: false, outputItemName: 'Old' },
];
const PRODUCTS = [{ productId: 'PRD-1', productName: 'Kalpi 26' }];

function mount() {
  jest.resetModules();
  global.fetch = jest.fn();
  document.body.innerHTML = `
    <div id="mapp-sheet-backdrop"></div>
    <div class="mb-sheet" id="sheet-pool-openings">
      <div class="mb-search"><input type="search" id="pool-openings-search"></div>
      <div id="pool-openings-list"></div>
    </div>
    <div class="mb-sheet" id="sheet-pool-opening-form">
      <button id="pool-opening-process-field" class="mb-picker-field mb-placeholder">Choose a process…</button>
      <div class="mb-field"><input type="text" id="pool-opening-output" readonly>
        <div id="pool-opening-output-hint"></div></div>
      <div class="mb-field" hidden><button id="pool-opening-color-field" class="mb-picker-field mb-placeholder">No colour</button>
        <div id="pool-opening-color-hint"></div></div>
      <div class="mb-field" hidden><button id="pool-opening-tag-field" class="mb-picker-field mb-placeholder">Untagged — stays in the pool</button></div>
      <input type="number" id="pool-opening-qty">
      <input type="date" id="pool-opening-date">
      <textarea id="pool-opening-remarks"></textarea>
      <button id="pool-opening-save-btn">Record opening stock</button>
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
  MApp.Paging._shown = {};
  window.confirm = jest.fn(() => true);
  Element.prototype.scrollIntoView = jest.fn();
}

const listText = () => document.getElementById('pool-openings-list').textContent;

async function openList() {
  MApp.Api.call = jest.fn(async () => ({ success: true, data: OPENINGS }));
  await MApp.PoolOpenings.open();
}

// Opens the form with the reference data loaded, and (optionally) the
// colours getProcessColorGroups would return for the chosen process.
async function openForm(colors) {
  MApp.Api.call = jest.fn(async m => {
    if (m === 'getProcessData') return { success: true, data: PROCESSES };
    if (m === 'getBOMProductionData') return { success: true, data: PRODUCTS };
    if (m === 'getProcessColorGroups') return { success: true, data: colors || [] };
    return { success: false };
  });
  await MApp.PoolOpenings.openForm();
}

const pick = label => {
  const btn = [...document.querySelectorAll('#mapp-picker-list .mb-picker-option')]
    .find(b => b.textContent.trim().startsWith(label));
  btn.click();
};

async function choose(processName, colors) {
  await openForm(colors);
  const done = MApp.PoolOpenings.pickProcess();
  await Promise.resolve();
  pick(processName);
  await done;
}

describe('the list', () => {
  beforeEach(mount);

  test('shows each entry with its signed quantity', async () => {
    await openList();

    expect(MApp.Api.call).toHaveBeenCalledWith('getWarehousePoolOpeningData');
    expect(listText()).toContain('Frame 26');
    expect(listText()).toContain('+40');
    expect(listText()).toContain('-5');
  });

  test('a correction is labelled, so it does not read as an original count', async () => {
    // adjustWarehousePoolManually writes into this same table with a
    // "Correction: " remark. One is what was on the rack; the other is a
    // judgement someone made later.
    await openList();

    const cards = document.querySelectorAll('#pool-openings-list .mb-card');
    expect(cards[0].textContent).not.toContain('Correction');
    expect(cards[1].textContent).toContain('Correction');
  });

  test('search reaches item, colour and process', async () => {
    await openList();

    MApp.PoolOpenings.onSearch('truing');
    expect(MApp.PoolOpenings.filtered.map(r => r.rowIdx)).toEqual([6]);
  });

  test('a failure offers a retry', async () => {
    MApp.Api.call = jest.fn(async () => { throw new Error('offline'); });
    await MApp.PoolOpenings.open();

    expect(document.querySelector('#pool-openings-list .mb-state-retry')).not.toBeNull();
  });
});

describe('the form', () => {
  beforeEach(mount);

  test('offers only active processes', async () => {
    await openForm();

    const done = MApp.PoolOpenings.pickProcess();
    await Promise.resolve();
    const labels = [...document.querySelectorAll('#mapp-picker-list .mb-picker-option')]
      .map(b => b.textContent.trim());
    pick('Welding');
    await done;

    expect(labels.some(l => l.startsWith('Retired'))).toBe(false);
  });

  test('choosing a process fills the output item name from it', async () => {
    await choose('Welding');

    expect(document.getElementById('pool-opening-output').value).toBe('Frame 26');
  });

  test('the output name is editable only for a final-stage process', async () => {
    // The server keeps a per-entry override only for final-stage output;
    // for a WIP process it merges back at the next recalculation, so an
    // editable field there would be an edit that quietly does nothing.
    await choose('Welding');
    expect(document.getElementById('pool-opening-output').readOnly).toBe(true);

    await choose('Assembly');
    expect(document.getElementById('pool-opening-output').readOnly).toBe(false);
  });

  test('the product tag appears only for a final-stage process', async () => {
    await choose('Welding');
    expect(document.getElementById('pool-opening-tag-field').closest('.mb-field').hidden).toBe(true);

    await choose('Assembly');
    expect(document.getElementById('pool-opening-tag-field').closest('.mb-field').hidden).toBe(false);
  });

  test('the colour field appears only when the process has colours', async () => {
    await choose('Welding');
    expect(document.getElementById('pool-opening-color-field').closest('.mb-field').hidden).toBe(true);

    await choose('Welding', ['Black', 'Purple-Wine']);
    expect(document.getElementById('pool-opening-color-field').closest('.mb-field').hidden).toBe(false);
  });

  test('the colour hint says why it is required', async () => {
    await choose('Welding', ['Black']);

    expect(document.getElementById('pool-opening-color-hint').textContent)
      .toContain('no lot will ever draw from');
  });

  test('switching process drops the previous colour and tag', async () => {
    await choose('Welding', ['Black']);
    const done = MApp.PoolOpenings.pickColor();
    await Promise.resolve();
    pick('Black');
    await done;
    expect(MApp.PoolOpenings.selection.color).toBe('Black');

    await choose('Assembly', ['Red']);
    expect(MApp.PoolOpenings.selection.color).toBe('');
    expect(MApp.PoolOpenings.selection.productTag).toBe('');
  });

  test('a superseded colour lookup does not paint over the current process', async () => {
    // Picking a second process while the first colour request is in
    // flight must not offer the first process's colours here.
    await openForm();
    let releaseFirst;
    MApp.Api.call = jest.fn(m => {
      if (m !== 'getProcessColorGroups') return Promise.resolve({ success: true, data: [] });
      if (MApp.PoolOpenings.selection.processId === 'P1') {
        return new Promise(r => { releaseFirst = () => r({ success: true, data: ['Stale'] }); });
      }
      return Promise.resolve({ success: true, data: ['Red'] });
    });

    const first = MApp.PoolOpenings.pickProcess();
    await Promise.resolve();
    pick('Welding');
    const stale = first;

    const second = MApp.PoolOpenings.pickProcess();
    await Promise.resolve();
    pick('Assembly');
    await second;
    releaseFirst();
    await stale;

    expect(MApp.PoolOpenings.colors).toEqual(['Red']);
  });
});

describe('saving an opening balance', () => {
  beforeEach(mount);

  const fill = (qty, remarks) => {
    document.getElementById('pool-opening-qty').value = String(qty);
    document.getElementById('pool-opening-remarks').value = remarks || '';
    document.getElementById('pool-opening-date').value = '2026-09-08';
  };

  test('sends the process, quantity and date', async () => {
    let call = null;
    MApp.Util.mutateSimple = jest.fn(async (m, args) => { call = { m, args }; return { success: false }; });
    await choose('Welding');
    fill(40, 'counted on the rack');

    await MApp.PoolOpenings.save();

    expect(call.m).toBe('saveWarehousePoolOpening');
    expect(call.args[0]).toEqual({
      processId: 'P1', outputItemName: 'Frame 26', productTag: '', color: '',
      qty: 40, date: '2026-09-08', remarks: 'counted on the rack',
    });
  });

  test('a colour-tracking process without a colour is refused here', async () => {
    // The server refuses it too; refusing first costs no round trip and
    // keeps the typed quantity on screen.
    MApp.Util.mutateSimple = jest.fn();
    await choose('Welding', ['Black']);
    fill(40);

    await MApp.PoolOpenings.save();

    expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();
  });

  test('with the colour chosen it goes through', async () => {
    let call = null;
    MApp.Util.mutateSimple = jest.fn(async (m, args) => { call = { m, args }; return { success: false }; });
    await choose('Welding', ['Black']);
    const done = MApp.PoolOpenings.pickColor();
    await Promise.resolve();
    pick('Black');
    await done;
    fill(40);

    await MApp.PoolOpenings.save();

    expect(call.args[0].color).toBe('Black');
  });

  test('no process chosen is refused', async () => {
    MApp.Util.mutateSimple = jest.fn();
    await openForm();
    fill(40);

    await MApp.PoolOpenings.save();

    expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();
  });

  test('a zero quantity is refused, because it records nothing', async () => {
    MApp.Util.mutateSimple = jest.fn();
    await choose('Welding');
    fill(0);

    await MApp.PoolOpenings.save();

    expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();
  });

  test('a blank quantity is refused', async () => {
    MApp.Util.mutateSimple = jest.fn();
    await choose('Welding');
    fill('');

    await MApp.PoolOpenings.save();

    expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();
  });

  test('a negative quantity is allowed, but confirmed first', async () => {
    // It is how a downward correction is written, and it is not what
    // someone recording what is on the rack meant to type.
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: false }));
    await choose('Welding');
    fill(-5, 'over-counted last week');

    await MApp.PoolOpenings.save();

    expect(window.confirm.mock.calls[0][0]).toContain('takes stock OUT');
    expect(MApp.Util.mutateSimple).toHaveBeenCalled();
  });

  test('declining that confirmation sends nothing', async () => {
    window.confirm = jest.fn(() => false);
    MApp.Util.mutateSimple = jest.fn();
    await choose('Welding');
    fill(-5);

    await MApp.PoolOpenings.save();

    expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();
  });

  test('a produced-would-go-negative refusal leaves the form open', async () => {
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: false }));
    await choose('Welding');
    MApp.PoolOpenings.open = jest.fn();
    fill(-500);

    await MApp.PoolOpenings.save();

    expect(MApp.PoolOpenings.open).not.toHaveBeenCalled();
    expect(document.getElementById('pool-opening-save-btn').disabled).toBe(false);
  });
});

describe('deleting an opening balance', () => {
  beforeEach(mount);

  test('sends both expected values, so the server can check for drift', async () => {
    // deleteWarehousePoolOpening applies its concurrency check only when
    // BOTH arrive. Sending neither would let a stale list delete an entry
    // that is no longer the one on screen.
    let call = null;
    MApp.Util.mutateSimple = jest.fn(async (m, args) => { call = { m, args }; return { success: false }; });
    await openList();

    await MApp.PoolOpenings.remove(OPENINGS[0]);

    expect(call.m).toBe('deleteWarehousePoolOpening');
    expect(call.args).toEqual([5, 'Frame 26', 40]);
  });

  test('the confirmation says the bucket is recalculated', async () => {
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: false }));
    await openList();

    await MApp.PoolOpenings.remove(OPENINGS[0]);

    expect(window.confirm.mock.calls[0][0]).toContain('recalculated without it');
  });

  test('declining sends nothing', async () => {
    window.confirm = jest.fn(() => false);
    MApp.Util.mutateSimple = jest.fn();
    await openList();

    await MApp.PoolOpenings.remove(OPENINGS[0]);

    expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();
  });

  test('a drift refusal is reported and the list is not reloaded', async () => {
    MApp.Util.mutateSimple = jest.fn(async () => ({
      success: false, message: 'Data mismatch: The entry has been modified or shifted. Please refresh.',
    }));
    await openList();
    MApp.PoolOpenings.open = jest.fn();

    await MApp.PoolOpenings.remove(OPENINGS[0]);

    expect(MApp.PoolOpenings.open).not.toHaveBeenCalled();
  });
});
