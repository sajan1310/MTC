/**
 * The last of the Phase 5 read gaps: item-to-process mappings, the full
 * dashboard, process availability, and the contractor rate lookup.
 *
 * Each of these RPCs existed and none was reachable from a phone, so each
 * answered a question that previously required walking to a desk.
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

const PROCESSES = [
  { processId: 'P1', processName: 'Painting', sequence: 1, active: true, processType: 'Paint', inRecipe: true, qtyPerUnit: 2, unit: 'Pcs', remarks: '', colorVariants: [] },
  { processId: 'P2', processName: 'Welding', sequence: 2, active: true, processType: 'Weld', inRecipe: false, qtyPerUnit: null, unit: '', remarks: '', colorVariants: [] },
];

function mount(html) {
  jest.resetModules();
  global.fetch = jest.fn();
  document.body.innerHTML = `<div id="mapp-sheet-backdrop"></div>${html}`;
  loadAsGlobal('api.js', 'Api');
  loadAsGlobal('mobile.js', 'MApp');
  MApp.Sheet._stack = [];
  window.confirm = jest.fn(() => true);
}

describe('MApp.ItemProcesses', () => {
  const ITEM = { name: 'Rim 26', size: '26 inch' };

  beforeEach(() => {
    mount(`
      <div class="mb-sheet" id="sheet-item-processes">
        <h2 id="item-processes-title"></h2>
        <div id="item-processes-body"></div>
        <button id="item-processes-save-btn">Save Changes</button>
      </div>`);
    MApp.Api.call = jest.fn(async () => ({ success: true, data: PROCESSES }));
  });

  const body = () => document.getElementById('item-processes-body');

  test('asks for the processes that use this exact item and size', async () => {
    await MApp.ItemProcesses.open(ITEM);
    expect(MApp.Api.call).toHaveBeenCalledWith('getProcessesForItem', 'Rim 26', '26 inch');
  });

  test('shows membership, and a quantity only where it applies', async () => {
    await MApp.ItemProcesses.open(ITEM);

    expect(body().textContent).toContain('Painting');
    expect(body().textContent).toContain('In recipe');
    expect(body().textContent).toContain('Not used');
    expect(document.getElementById('item-proc-qty-0')).not.toBeNull();
    expect(document.getElementById('item-proc-qty-1')).toBeNull(); // not in recipe
  });

  test('toggling in gives the new mapping a usable default quantity', async () => {
    // The server rejects a mapping with no quantity; sending one it will
    // refuse would make the toggle look broken.
    await MApp.ItemProcesses.open(ITEM);

    body().querySelector('[data-toggle-recipe="1"]').click();

    expect(MApp.ItemProcesses.rows[1]._inRecipe).toBe(true);
    expect(document.getElementById('item-proc-qty-1').value).toBe('1');
  });

  test('sends every process, with membership and quantity', async () => {
    let call = null;
    MApp.Util.mutateSimple = jest.fn(async (m, args) => { call = { m, args }; return { success: true }; });
    await MApp.ItemProcesses.open(ITEM);

    await MApp.ItemProcesses.save();

    expect(call.m).toBe('saveItemProcessMappings');
    expect(call.args[0]).toBe('Rim 26');
    expect(call.args[1]).toBe('26 inch');
    expect(call.args[2]).toEqual([
      { processId: 'P1', inRecipe: true, qtyPerUnit: 2 },
      { processId: 'P2', inRecipe: false, qtyPerUnit: 0 },
    ]);
  });

  test('a zero quantity on a member process is refused before sending', async () => {
    MApp.Util.mutateSimple = jest.fn();
    await MApp.ItemProcesses.open(ITEM);
    document.getElementById('item-proc-qty-0').value = '0';

    await MApp.ItemProcesses.save();

    expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();
  });

  test('removing from a process warns that only future lots change', async () => {
    // Past lots keep their own snapshotted components -- the server's own
    // reasoning -- so this is a warning, not a block.
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: true }));
    await MApp.ItemProcesses.open(ITEM);
    body().querySelector('[data-toggle-recipe="0"]').click(); // remove P1

    await MApp.ItemProcesses.save();

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('only future lots change'));
  });

  test('declining that warning sends nothing', async () => {
    window.confirm = jest.fn(() => false);
    MApp.Util.mutateSimple = jest.fn();
    await MApp.ItemProcesses.open(ITEM);
    body().querySelector('[data-toggle-recipe="0"]').click();

    await MApp.ItemProcesses.save();

    expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();
  });
});

describe('MApp.Dashboard', () => {
  const DATA = {
    kpis: {
      openPoCount: 4, openPoValue: 12000, billsThisMonthCount: 9, billsThisMonthValue: 45000,
      lowStockCount: 2, lowStockTotalDeficit: 30, inProgressProductionCount: 3,
      queuedProductionCount: 5, readyToDispatchUnits: 120, readyToDispatchProductCount: 2,
      contractorPayablesDue: 3000, contractorPayablesCount: 1, oldestPendingProductionDays: 12,
    },
    lowStockItems: [{ name: 'Rim 26', size: '26 inch', currentStock: 5, threshold: 20, deficit: 15 }],
    lowStockTotalCount: 2,
    readyToDispatchItems: [{ productId: 'X', productName: 'Kalpi 26', readyQty: 120 }],
    contractorPayables: [{ contractorName: 'rakesh', balanceDue: 3000 }],
  };

  beforeEach(() => {
    mount('<div class="mb-sheet" id="sheet-dashboard"><div id="dashboard-body"></div></div>');
    MApp.Api.call = jest.fn(async () => ({ success: true, data: DATA }));
  });

  const body = () => document.getElementById('dashboard-body').textContent;

  test('shows the KPIs the reduced mobile endpoint never returned', async () => {
    await MApp.Dashboard.open();

    expect(MApp.Api.call).toHaveBeenCalledWith('getDashboardData');
    expect(body()).toContain('Open POs');
    expect(body()).toContain('₹12000.00');
    expect(body()).toContain('Contractor payables');
    expect(body()).toContain('₹3000.00');
  });

  test('flags a long-waiting pending lot', async () => {
    await MApp.Dashboard.open();
    expect(body()).toContain('12 day(s)');
  });

  test('says how many low-stock rows were held back', async () => {
    await MApp.Dashboard.open();
    expect(body()).toContain('+1 more');
  });

  test('empty sections read as empty rather than broken', async () => {
    MApp.Api.call = jest.fn(async () => ({ success: true, data: { kpis: {} } }));
    await MApp.Dashboard.open();

    expect(body()).toContain('Nothing below its threshold.');
    expect(body()).toContain('Nothing ready.');
    expect(body()).toContain('Nothing outstanding.');
  });

  test('a failure offers a retry', async () => {
    MApp.Api.call = jest.fn(async () => { throw new Error('offline'); });
    await MApp.Dashboard.open();

    expect(document.querySelector('#dashboard-body .mb-state-retry')).not.toBeNull();
  });
});

describe('MApp.Process availability', () => {
  beforeEach(() => {
    mount('<div class="mb-card-sub" id="process-wip-0" hidden></div>');
  });

  const el = () => document.getElementById('process-wip-0');

  test('reports what the pool holds for each input', async () => {
    MApp.Api.call = jest.fn(async () => ({
      success: true,
      data: [{ outputItemName: 'Frame 26', availableQty: 40 }],
    }));

    await MApp.Process.showWip({ processId: 'P1' }, 0);

    expect(MApp.Api.call).toHaveBeenCalledWith('getProcessWipData', 'P1');
    expect(el().textContent).toContain('Frame 26');
    expect(el().textContent).toContain('40 available');
  });

  test('a missing pool bucket is not reported as zero', async () => {
    // "no bucket" and "zero available" are different answers, and only
    // one of them means the input has run out.
    MApp.Api.call = jest.fn(async () => ({
      success: true,
      data: [{ outputItemName: 'Frame 26', availableQty: null }],
    }));

    await MApp.Process.showWip({ processId: 'P1' }, 0);

    expect(el().textContent).toContain('no pool bucket');
    expect(el().textContent).not.toContain('0 available');
  });

  test('toggles closed on a second tap', async () => {
    MApp.Api.call = jest.fn(async () => ({ success: true, data: [] }));
    await MApp.Process.showWip({ processId: 'P1' }, 0);
    expect(el().hidden).toBe(false);

    await MApp.Process.showWip({ processId: 'P1' }, 0);
    expect(el().hidden).toBe(true);
  });
});

describe('Log Lot contractor rate', () => {
  beforeEach(() => {
    mount('<div class="mb-field-hint" id="lot-rate-hint" hidden></div>');
    MApp.Production.selection = { size: '26 inch', type: 'Paint' };
    MApp.Production.selectedAssignedTo = 'Rakesh';
  });

  const hint = () => document.getElementById('lot-rate-hint');

  test('shows the rate on file for this contractor, type and size', async () => {
    MApp.Api.call = jest.fn(async () => ({ success: true, data: { ratePerUnit: 40 } }));

    await MApp.Production._showContractorRate();

    expect(MApp.Api.call).toHaveBeenCalledWith('getContractorRateForProcessType', 'Rakesh', 'Paint', '26 inch');
    expect(hint().textContent).toContain('₹40.00');
    expect(hint().hidden).toBe(false);
  });

  test('says plainly when there is no rate, because the payable will be zero', async () => {
    MApp.Api.call = jest.fn(async () => ({ success: true, data: null }));

    await MApp.Production._showContractorRate();

    expect(hint().textContent).toContain('No rate on file');
    expect(hint().textContent).toContain('payable will be zero');
  });

  test('stays quiet until both contractor and process type are known', async () => {
    MApp.Api.call = jest.fn();
    MApp.Production.selectedAssignedTo = '';

    await MApp.Production._showContractorRate();

    expect(MApp.Api.call).not.toHaveBeenCalled();
    expect(hint().hidden).toBe(true);
  });

  test('a superseded lookup does not overwrite a newer one', async () => {
    // Picking a second contractor while the first request is in flight
    // must not paint the first contractor's rate against the second.
    let releaseFirst;
    MApp.Api.call = jest.fn(() => new Promise(res => {
      releaseFirst = () => res({ success: true, data: { ratePerUnit: 999 } });
    }));
    const stale = MApp.Production._showContractorRate();

    MApp.Api.call = jest.fn(async () => ({ success: true, data: { ratePerUnit: 40 } }));
    await MApp.Production._showContractorRate();
    releaseFirst();
    await stale;

    expect(hint().textContent).toContain('₹40.00');
    expect(hint().textContent).not.toContain('999');
  });
});
