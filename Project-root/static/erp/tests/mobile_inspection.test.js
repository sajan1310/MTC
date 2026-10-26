/**
 * Inspection in the phone app (MApp.Inspection).
 *
 * The server decides every rule (inspection_service.py, tested in
 * tests/erp/test_inspection.py). What this file holds is the screen's side
 * of the contract: opening a lot sends nothing, each tick sends one
 * decision and then shows the row the server returns, "Needs admin review"
 * saves with its remarks, an inspector's clear button stays locked until
 * every item is ticked while an admin's does not, the dialog before
 * clearing lists exactly what would be accepted, only an admin is offered
 * "Acknowledge & Proceed", and a cleared lot thanks the inspector by name
 * for the process. On a tablet the inspection sheets fill the screen.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const VIEWS_HTML = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', 'mobile_views.html'), 'utf8'
);
const STYLES = fs.readFileSync(path.join(__dirname, '..', 'mobile_styles.css'), 'utf8');

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
      inspection: { status: 'in_progress', remarks: '', stage: 'partial' },
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
const rowBox = key => [...body().querySelectorAll('[data-insp-row]')]
  .find(r => r.dataset.inspRow === key).querySelector('.mb-insp-check');

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
    expect(document.getElementById('inspection-progress').textContent).toContain('Partially checked');
  });

  test('every item is a box to tick; changed and added ones come back unticked, badged, with what they were', async () => {
    await openChecklist();
    const rows = [...body().querySelectorAll('[data-insp-row]')];
    const spoke = rows.find(r => r.dataset.inspRow === 'spoke');
    const cap = rows.find(r => r.dataset.inspRow === 'cap');

    expect(body().querySelector('[data-insp-result]')).toBeNull(); // no Pass / Fail
    expect(spoke.textContent).toContain('Revised');
    expect(spoke.textContent).toContain('was 50');
    expect(rowBox('spoke').checked).toBe(false);
    expect(cap.textContent).toContain('New');
    expect(rowBox('tape').checked).toBe(true);
  });

  test("an inspector's sign-off names them and stays locked until every item is ticked", async () => {
    await openChecklist();
    expect(footer().textContent.replace(/\s+/g, ' ')).toContain('Inspector: Alex Doe | Role: Quality Lead');
    expect(clearBtn().disabled).toBe(true);
    expect(footer().textContent).toContain('2 items still to tick.');

    const done = checklist();
    done.data.items = done.data.items.map(i => ({ ...i, state: 'checked', result: 'pass', previous: null }));
    done.data.summary = { total: 3, checked: 3, passed: 3, failed: 0, revised: 0, added: 0, removed: 0, complete: true };
    await openChecklist(done);
    expect(clearBtn().disabled).toBe(false);
  });

  test('a lot that needs review waits for an admin, and says so', async () => {
    const review = checklist();
    review.data.inspection = { status: 'flagged', stage: 'needs_review', remarks: 'Spokes are 13G', flaggedByName: 'Alex Doe' };
    review.data.summary.complete = true;
    await openChecklist(review);
    expect(clearBtn().disabled).toBe(true);
    expect(footer().textContent).toContain('Waiting for an admin to review this lot.');
    expect(document.getElementById('inspection-needs-review').checked).toBe(true);
  });

  test('a tick sends one decision and shows the row the server returns', async () => {
    await openChecklist();
    MApp.Api.mutate = jest.fn(async () => ({
      success: true,
      message: 'Lot #LOT-PNT005-0011 is now In Progress.',
      data: {
        key: 'cap', result: 'pass', lotStatus: 'In Progress', stage: 'partial',
        item: item('cap', 'Valve Cap', 60, { state: 'checked', result: 'pass' }),
        summary: { total: 3, checked: 2, passed: 2, failed: 0, revised: 1, added: 0, removed: 0, complete: false }
      }
    }));

    rowBox('cap').click();
    await flush();
    await flush();

    expect(MApp.Api.mutate).toHaveBeenCalledWith('setInspectionCheck', 7, 'cap', 'checked', '60|');
    expect(document.getElementById('inspection-lot-status').textContent).toBe('In Progress');
    expect(body().textContent).toContain('2/3');
    expect(rowBox('cap').checked).toBe(true);
    expect(rowBox('cap').disabled).toBe(false);
  });

  test('ticking a ticked item unticks it', async () => {
    await openChecklist();
    MApp.Api.mutate = jest.fn(async () => ({
      success: true, message: '',
      data: { key: 'tape', result: null, lotStatus: 'Pending', stage: 'not_started', item: item('tape', 'Rim Tape', 60),
        summary: { total: 3, checked: 0, passed: 0, failed: 0, revised: 1, added: 1, removed: 0, complete: false } }
    }));
    await MApp.Inspection.toggle('tape');
    expect(MApp.Api.mutate).toHaveBeenCalledWith('setInspectionCheck', 7, 'tape', '', '60|');
    expect(rowBox('tape').checked).toBe(false);
  });

  test('asking for a review needs remarks first, and the box does not stay ticked without them', async () => {
    await openChecklist();
    const box = document.getElementById('inspection-needs-review');
    box.click();
    await flush();
    expect(MApp.Api.mutate).not.toHaveBeenCalled();
    expect(box.checked).toBe(false);
  });

  test('ticking Needs admin review saves it with the remarks, and the lot then waits for an admin', async () => {
    await openChecklist();
    MApp.Api.mutate = jest.fn(async () => ({
      success: true, message: 'Saved. Lot #LOT-PNT005-0011 is waiting for an admin\'s review.',
      data: { status: 'flagged', remarks: 'Spokes are 13G', stage: 'needs_review', flaggedByName: 'Alex Doe',
        summary: checklist().data.summary }
    }));
    document.getElementById('inspection-remarks').value = 'Spokes are 13G';
    document.getElementById('inspection-needs-review').click();
    await flush();
    await flush();

    expect(MApp.Api.mutate).toHaveBeenCalledWith('setInspectionReview', 7, true, 'Spokes are 13G');
    expect(body().textContent).toContain('Needs admin review by Alex Doe');
    expect(document.getElementById('inspection-needs-review').checked).toBe(true);
    expect(footer().textContent).toContain('Waiting for an admin to review this lot.');
  });

  test('an admin may clear a partly ticked lot: the button is open, and says what is left', async () => {
    await openChecklist(checklist({ canAcknowledge: true, canReturn: true }));
    expect(clearBtn().disabled).toBe(false);
    expect(footer().textContent).toContain('2 items not ticked. You can still clear the lot; you will see them first.');
  });
});

describe('submitting', () => {
  beforeEach(mount);

  const changed = canAcknowledge => ({
    success: true,
    message: 'The live Production Sheet differs from what was checked.',
    data: {
      cleared: false, token: 't1', changedAgain: false, canAcknowledge,
      discrepancies: [{
        kind: 'changed', key: 'spoke', itemName: 'Spoke 12G', size: '26in', color: '', unit: 'Pcs',
        changes: [{ field: 'qty', label: 'Quantity', from: 50, to: 45 }]
      }]
    }
  });

  test('a changed sheet opens the dialog with the exact differences', async () => {
    await openChecklist();
    MApp.Api.mutate = jest.fn(async () => changed(false));
    await MApp.Inspection.submit();

    const dialog = document.getElementById('inspection-reconcile-body').textContent;
    expect(dialog).toContain('Spoke 12G · 26in: quantity changed from 50 to 45');
    expect(dialog).toContain('Targeted changes have been detected in the live Production Sheet. Do you confirm these changes apply to this inspected lot?');
    expect(document.getElementById('inspection-reconcile-title').textContent).toBe('Production Sheet changed');
    const actions = document.getElementById('inspection-reconcile-footer').textContent;
    expect(actions).toContain('Re-inspect Modified Items');
    expect(actions).not.toContain('Acknowledge');
  });

  test('an admin clearing a partly ticked lot first sees exactly what is not ticked', async () => {
    await openChecklist(checklist({ canAcknowledge: true }));
    MApp.Api.mutate = jest.fn()
      .mockResolvedValueOnce({
        success: true, message: '2 item(s) not ticked.',
        data: {
          cleared: false, token: 't2', changedAgain: false, canAcknowledge: true,
          discrepancies: [
            { kind: 'unchecked', key: 'spoke', itemName: 'Spoke 12G', size: '26in', color: '', unit: 'Pcs', qty: 45 },
            { kind: 'unchecked', key: 'cap', itemName: 'Valve Cap', size: '26in', color: '', unit: 'Pcs', qty: 60 }
          ]
        }
      })
      .mockResolvedValueOnce({
        success: true, message: '',
        data: { cleared: true, lotNumber: LOT.lotNumber, processName: 'Powder Coating', inspector: INSPECTOR,
          acknowledged: [{ kind: 'unchecked' }, { kind: 'unchecked' }] }
      });

    await MApp.Inspection.submit();
    const dialog = document.getElementById('inspection-reconcile-body').textContent;
    expect(document.getElementById('inspection-reconcile-title').textContent).toBe('Items not ticked');
    expect(dialog).toContain('2 items are not ticked. Clear the lot without them?');
    expect(dialog).toContain('Spoke 12G · 26in: 45 Pcs');
    const actions = document.getElementById('inspection-reconcile-footer').textContent;
    expect(actions).toContain('Back to the checklist');
    expect(actions).toContain('Acknowledge & Proceed');

    await MApp.Inspection.acknowledge();
    expect(MApp.Api.mutate).toHaveBeenLastCalledWith('clearInspection', 7, 't2');
    expect(body().textContent).toContain('2 items cleared by an admin without a tick');
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

  const lot = (rowIdx, lotNumber, status, stage, summary = { total: 3, checked: 0 }) => ({
    ...LOT, rowIdx, lotNumber, status, itemCount: 3, lastUpdated: '',
    inspection: { stage, summary }
  });

  test('lots needing review lead the work list; each stage has its own chip', async () => {
    MApp.Api.call = jest.fn(async () => ({
      success: true,
      data: [
        lot(1, 'LOT-A', 'Pending', 'not_started'),
        lot(2, 'LOT-B', 'In Progress', 'needs_review', { total: 3, checked: 1 }),
        lot(3, 'LOT-C', 'In Progress', 'cleared', { total: 3, checked: 3 }),
        lot(4, 'LOT-D', 'In Progress', 'partial', { total: 3, checked: 2 }),
        lot(5, 'LOT-E', 'In Progress', 'complete', { total: 3, checked: 3 })
      ]
    }));
    await MApp.Inspection.open();

    const titles = () => [...document.querySelectorAll('#inspections-list .mb-card-title')].map(t => t.textContent);
    expect(titles()).toEqual(['LOT-B', 'LOT-E', 'LOT-D', 'LOT-A']);
    const list = document.getElementById('inspections-list').textContent;
    expect(list).toContain('Needs review 1/3');
    expect(list).toContain('Partially checked 2/3');
    expect(list).toContain('All checked');

    MApp.Inspection.filterBy('partial');
    expect(titles()).toEqual(['LOT-D']);
    MApp.Inspection.filterBy('cleared');
    expect(titles()).toEqual(['LOT-C']);
    expect(document.querySelectorAll('#inspections-filter-bar [data-insp-filter]')).toHaveLength(6);
  });
});

describe('on a tablet', () => {
  test('the three inspection sheets fill the screen instead of the 480px phone frame', () => {
    for (const id of ['sheet-inspections', 'sheet-inspection', 'sheet-inspection-reconcile']) {
      expect(sheet(id)).toMatch(/class="mb-sheet mb-sheet-full"/);
    }
    // Inside the 640px block, after the rule that frames every sheet at 480px.
    const frame = STYLES.indexOf('--mb-sheet-x: -50%;');
    const full = STYLES.search(/@media \(min-width: 640px\) \{\s*\.mb-sheet\.mb-sheet-full \{[^}]*left: 0;[^}]*width: auto;[^}]*--mb-sheet-x: 0px;/);
    expect(frame).toBeGreaterThan(-1);
    expect(full).toBeGreaterThan(frame);
  });
});
