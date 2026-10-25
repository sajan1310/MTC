/**
 * Inspection in the phone app (MApp.Inspection).
 *
 * The server decides every rule (inspection_service.py, tested in
 * tests/erp/test_inspection.py). What this file holds is the screen's side
 * of the contract: opening a lot sends nothing, each tap sends one
 * decision and then shows the row the server returns, the clear button
 * stays locked until every item has passed, a changed sheet at submit
 * opens the reconciliation dialog with the exact differences, only an
 * admin is offered "Acknowledge & Proceed", and a cleared lot thanks the
 * inspector by name for the process.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const VIEWS_HTML = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', 'mobile_views.html'), 'utf8'
);

function loadAsGlobal(relPath, exportName) {
  const code = fs
    .readFileSync(path.join(__dirname, '..', relPath), 'utf8')
    .replace(new RegExp(`^const ${exportName} = `, 'm'), `global.${exportName} = `);
  // eslint-disable-next-line no-eval
  eval(code);
}

/** The real sheet markup, so a test cannot pass against a fixture the
 *  template does not contain. */
function sheet(id) {
  const at = VIEWS_HTML.indexOf(`id="${id}"`);
  const open = VIEWS_HTML.lastIndexOf('<div', at);
  return VIEWS_HTML.slice(open, VIEWS_HTML.indexOf('<!--', at));
}

function mount() {
  jest.resetModules();
  global.fetch = jest.fn();
  document.body.innerHTML = `
    <div id="mapp-sheet-backdrop"></div>
    ${sheet('sheet-inspections')}
    ${sheet('sheet-inspection')}
    ${sheet('sheet-inspection-reconcile')}
    <div class="mb-toast-stack" id="mapp-toast-stack"></div>`;
  loadAsGlobal('api.js', 'Api');
  loadAsGlobal('mobile.js', 'MApp');
  MApp.Sheet._stack = [];
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

const INSPECTOR = { id: 3, name: 'Alex Doe', role: 'quality_lead', roleLabel: 'Quality Lead' };
const LOT = {
  rowIdx: 7, lotNumber: 'LOT-PNT005-0011', date: '24/10/2026', dateRaw: '2026-10-24',
  processName: 'Powder Coating', outputItemName: '26in Rim Painted', productName: '',
  qty: 60, status: 'Pending', colors: ['Black'], updatedAt: ''
};

function item(key, itemName, qty, extra = {}) {
  return {
    key, itemName, size: '26in', color: '', narration: '', qty, unit: 'Pcs',
    fingerprint: `${qty}|`, state: 'pending', result: null, previous: null, ...extra
  };
}

function checklist(overrides = {}) {
  return {
    success: true,
    data: {
      lot: { ...LOT },
      inspection: { status: 'in_progress', remarks: '' },
      items: [
        item('spoke', 'Spoke 12G', 45, { state: 'revised', previous: { qty: 50, narration: '' } }),
        item('tape', 'Rim Tape', 60, { state: 'checked', result: 'pass' }),
        item('cap', 'Valve Cap', 60, { state: 'new' })
      ],
      removed: [],
      summary: { total: 3, checked: 1, passed: 1, failed: 0, revised: 1, added: 1, removed: 0, complete: false },
      inspector: { ...INSPECTOR },
      canAcknowledge: false,
      canReturn: false,
      ...overrides
    }
  };
}

const body = () => document.getElementById('inspection-body');
const footer = () => document.getElementById('inspection-footer');
const clearBtn = () => document.getElementById('inspection-clear-btn');

async function openChecklist(response = checklist()) {
  MApp.Api.call = jest.fn(async () => response);
  MApp.Api.mutate = jest.fn();
  await MApp.Inspection.openChecklist(7);
}

describe('the checklist', () => {
  beforeEach(mount);

  test('opening a lot draws it and sends nothing', async () => {
    await openChecklist();
    expect(MApp.Api.call).toHaveBeenCalledWith('getInspection', 7);
    expect(MApp.Api.mutate).not.toHaveBeenCalled();
    expect(body().textContent).toContain('Powder Coating');
    expect(body().textContent).toContain('1/3');
  });

  test('changed and added rows come back unticked, badged, with what they were', async () => {
    await openChecklist();
    const rows = [...body().querySelectorAll('[data-insp-row]')];
    const spoke = rows.find(r => r.dataset.inspRow === 'spoke');
    const cap = rows.find(r => r.dataset.inspRow === 'cap');
    const tape = rows.find(r => r.dataset.inspRow === 'tape');

    expect(spoke.textContent).toContain('Revised');
    expect(spoke.textContent).toContain('was 50');
    expect(spoke.querySelector('.mb-insp-pass').getAttribute('aria-pressed')).toBe('false');
    expect(cap.textContent).toContain('New');
    expect(tape.querySelector('.mb-insp-pass').getAttribute('aria-pressed')).toBe('true');
  });

  test('the sign-off names the inspector and stays locked until everything passed', async () => {
    await openChecklist();
    expect(footer().textContent.replace(/\s+/g, ' ')).toContain('Inspector: Alex Doe | Role: Quality Lead');
    expect(clearBtn().disabled).toBe(true);
    expect(footer().textContent).toContain('2 items still to pass.');

    const done = checklist();
    done.data.items = done.data.items.map(i => ({ ...i, state: 'checked', result: 'pass', previous: null }));
    done.data.summary = { total: 3, checked: 3, passed: 3, failed: 0, revised: 0, added: 0, removed: 0, complete: true };
    await openChecklist(done);
    expect(clearBtn().disabled).toBe(false);
  });

  test('a flagged lot cannot be cleared, and says why', async () => {
    const flagged = checklist();
    flagged.data.inspection = { status: 'flagged', remarks: 'Spokes are 13G', flaggedByName: 'Alex Doe' };
    flagged.data.summary.complete = true;
    await openChecklist(flagged);
    expect(clearBtn().disabled).toBe(true);
    expect(footer().textContent).toContain('Waiting for an admin');
  });

  test('a tap sends one decision and shows the row the server returns', async () => {
    await openChecklist();
    MApp.Api.mutate = jest.fn(async () => ({
      success: true,
      message: 'Lot #LOT-PNT005-0011 is now In Progress.',
      data: {
        key: 'cap', result: 'pass', lotStatus: 'In Progress',
        item: item('cap', 'Valve Cap', 60, { state: 'checked', result: 'pass' }),
        summary: { total: 3, checked: 2, passed: 2, failed: 0, revised: 1, added: 0, removed: 0, complete: false }
      }
    }));

    body().querySelector('[data-insp-key="cap"][data-insp-result="pass"]').click();
    await flush();
    await flush();

    expect(MApp.Api.mutate).toHaveBeenCalledWith('setInspectionCheck', 7, 'cap', 'pass', '60|');
    expect(document.getElementById('inspection-lot-status').textContent).toBe('In Progress');
    expect(body().textContent).toContain('2/3');
    const cap = [...body().querySelectorAll('[data-insp-row]')].find(r => r.dataset.inspRow === 'cap');
    expect(cap.querySelector('.mb-insp-pass').getAttribute('aria-pressed')).toBe('true');
  });

  test('tapping the chosen result again clears it', async () => {
    await openChecklist();
    MApp.Api.mutate = jest.fn(async () => ({
      success: true, message: '',
      data: { key: 'tape', result: null, lotStatus: 'Pending', item: item('tape', 'Rim Tape', 60),
        summary: { total: 3, checked: 0, passed: 0, failed: 0, revised: 1, added: 1, removed: 0, complete: false } }
    }));
    await MApp.Inspection.setResult('tape', 'pass');
    expect(MApp.Api.mutate).toHaveBeenCalledWith('setInspectionCheck', 7, 'tape', '', '60|');
  });

  test('flagging needs remarks before it asks the server', async () => {
    await openChecklist();
    await MApp.Inspection.saveRemarks(true);
    expect(MApp.Api.mutate).not.toHaveBeenCalled();
  });
});

describe('submitting', () => {
  beforeEach(mount);

  const changed = canAcknowledge => ({
    success: true,
    message: 'The live Production Sheet differs from what was inspected.',
    data: {
      cleared: false, token: 't1', changedAgain: false, canAcknowledge,
      discrepancies: [{
        kind: 'changed', key: 'spoke', itemName: 'Spoke 12G', size: '26in', color: '', unit: 'Pcs',
        changes: [{ field: 'qty', label: 'Quantity', from: 50, to: 45 }]
      }]
    }
  });

  test('a changed sheet opens the reconciliation dialog with the exact differences', async () => {
    await openChecklist();
    MApp.Api.mutate = jest.fn(async () => changed(false));
    await MApp.Inspection.submit();

    const dialog = document.getElementById('inspection-reconcile-body').textContent;
    expect(dialog).toContain('Spoke 12G · 26in: quantity changed from 50 to 45');
    expect(dialog).toContain('Targeted changes have been detected in the live Production Sheet. Do you confirm these changes apply to this inspected lot?');
    const actions = document.getElementById('inspection-reconcile-footer').textContent;
    expect(actions).toContain('Re-inspect Modified Items');
    expect(actions).not.toContain('Acknowledge');
  });

  test('an admin may acknowledge, sending back the token of the list they saw', async () => {
    await openChecklist(checklist({ canAcknowledge: true }));
    MApp.Api.mutate = jest.fn()
      .mockResolvedValueOnce(changed(true))
      .mockResolvedValueOnce({
        success: true, message: '',
        data: { cleared: true, lotNumber: LOT.lotNumber, processName: 'Powder Coating', inspector: INSPECTOR, acknowledged: [{}] }
      });

    await MApp.Inspection.submit();
    expect(document.getElementById('inspection-reconcile-footer').textContent).toContain('Acknowledge & Proceed');
    await MApp.Inspection.acknowledge();
    await flush();

    expect(MApp.Api.mutate).toHaveBeenLastCalledWith('clearInspection', 7, 't1');
    expect(body().textContent).toContain('changes accepted by an admin');
  });

  test('re-inspecting reloads the checklist as the sheet now stands', async () => {
    await openChecklist();
    MApp.Api.mutate = jest.fn(async () => changed(false));
    await MApp.Inspection.submit();
    MApp.Api.call.mockClear();
    await MApp.Inspection.reinspect();
    expect(MApp.Api.call).toHaveBeenCalledWith('getInspection', 7);
  });

  test('a cleared lot thanks the inspector by name, for the process', async () => {
    await openChecklist();
    MApp.Api.mutate = jest.fn(async () => ({
      success: true, message: '',
      data: { cleared: true, lotNumber: LOT.lotNumber, processName: 'Powder Coating', inspector: INSPECTOR, acknowledged: [] }
    }));
    await MApp.Inspection.submit();

    expect(body().textContent).toContain('Thank you, Alex Doe. Your lot has been cleared for Powder Coating.');
    expect(footer().textContent).toContain('Back to the lot list');
  });
});

describe('the lot list', () => {
  beforeEach(mount);

  const lot = (rowIdx, lotNumber, status, inspection) => ({
    ...LOT, rowIdx, lotNumber, status, itemCount: 3, lastUpdated: '',
    inspection: { summary: { total: 3, checked: 0 }, ...inspection }
  });

  test('flagged lots lead the work list, and cleared ones wait under Inspected', async () => {
    MApp.Api.call = jest.fn(async () => ({
      success: true,
      data: [
        lot(1, 'LOT-A', 'Pending', { status: '' }),
        lot(2, 'LOT-B', 'In Progress', { status: 'flagged' }),
        lot(3, 'LOT-C', 'In Progress', { status: 'cleared' })
      ]
    }));
    await MApp.Inspection.open();

    const titles = () => [...document.querySelectorAll('#inspections-list .mb-card-title')].map(t => t.textContent);
    expect(titles()).toEqual(['LOT-B', 'LOT-A']);
    MApp.Inspection.filterBy('cleared');
    expect(titles()).toEqual(['LOT-C']);
  });
});
