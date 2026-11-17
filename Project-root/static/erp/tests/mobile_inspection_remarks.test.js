/**
 * A remark on each item of the phone/tablet inspection checklist (asked
 * 2026-11-17: "add remarks column for inspector for each item to review
 * modifications").
 *
 * Each row ends in a speech-bubble button (the Remark column from 46rem). A
 * tap opens sheet-inspection-remark -- it never ticks the item, though the
 * row is the box's label -- where the remark is written, changed or removed
 * (setInspectionItemRemark). The remark shows on its row; the dialog before
 * clearing shows it too, and item remarks are enough to tick Needs admin
 * review. A cleared lot shows its remarks with no button.
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
    ${sheet('sheet-inspection')}
    ${sheet('sheet-inspection-reconcile')}
    ${sheet('sheet-inspection-remark')}
    <div class="mb-toast-stack" id="mapp-toast-stack"></div>`;
  loadAsGlobal('api.js', 'Api');
  global.PO_STATUS = Object.freeze({ ISSUED: 'PO Issued', PARTIAL: 'Partially Received', COMPLETED: 'Completed', CANCELLED: 'Cancelled' });
  loadAsGlobal('mobile.js', 'MApp');
  MApp.Sheet._stack = [];
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

const PAYLOAD = '<img src=x onerror="window.__xss=1">';
const REMARK = { text: 'Spokes here are 13G', byName: 'Alex Doe', at: '2026-11-17T10:05:00+05:30' };

const item = (key, itemName, extra = {}) => ({
  key, itemName, size: '26in', color: '', narration: '', qty: 50, unit: 'Pcs',
  fingerprint: `50|${key}`, state: 'pending', result: null, previous: null, remark: null, ...extra
});

function checklist(items, inspection = {}) {
  return {
    success: true,
    data: {
      lot: { rowIdx: 7, lotNumber: 'LOT-WHL001-0042', date: '17/11/2026', processName: 'Wheel Building',
        outputItemName: '26in Wheel', productName: '', qty: 60, status: 'In Progress', colors: [] },
      inspection: { status: 'in_progress', remarks: '', stage: 'not_started', ...inspection },
      items: items.map(i => ({ ...i })),
      removed: [],
      summary: { total: items.length, checked: 0, remarked: items.filter(i => i.remark).length, complete: false },
      inspector: { id: 3, name: 'Store Keeper', role: 'user', roleLabel: 'User' },
      canAcknowledge: false,
      canReturn: false
    }
  };
}

async function openChecklist(response) {
  MApp.Api.call = jest.fn(async () => response);
  MApp.Api.mutate = jest.fn();
  await MApp.Inspection.openChecklist(7);
}

const body = () => document.getElementById('inspection-body');
const rowOf = key => [...body().querySelectorAll('[data-insp-row]')].find(r => r.dataset.inspRow === key);
const remarkBtn = key => rowOf(key).querySelector('[data-insp-remark]');
const field = () => document.getElementById('inspection-remark-text');
const isOpen = id => MApp.Sheet._stack.some(s => s.id === id);

const saved = (remark, remarked = 1) => ({
  success: true,
  message: remark ? 'Remark saved.' : 'Remark removed.',
  data: { key: 'spoke', remark, summary: { total: 2, checked: 0, remarked, complete: false }, stage: 'not_started' }
});

describe('a remark on each item', () => {
  beforeEach(mount);

  test('every row ends in a remark button; a saved remark shows on its row', async () => {
    await openChecklist(checklist([item('spoke', 'Spoke 12G', { remark: REMARK }), item('tape', 'Rim Tape')]));
    expect(remarkBtn('spoke').getAttribute('aria-label')).toBe('Change the remark on Spoke 12G');
    expect(remarkBtn('spoke').classList.contains('is-set')).toBe(true);
    expect(remarkBtn('tape').getAttribute('aria-label')).toBe('Write a remark on Rim Tape');
    expect(rowOf('spoke').querySelector('.mb-insp-remark').textContent).toContain('Spokes here are 13G');
    expect(rowOf('spoke').querySelector('.mb-insp-remark-by').textContent).toContain('Alex Doe');
    expect(rowOf('tape').querySelector('.mb-insp-remark')).toBeNull();
    expect(document.getElementById('inspection-progress').textContent).toContain('1 with a remark');
  });

  test('a tap on the button opens the remark and never ticks the item', async () => {
    await openChecklist(checklist([item('spoke', 'Spoke 12G', { remark: REMARK })]));
    remarkBtn('spoke').click();
    expect(isOpen('sheet-inspection-remark')).toBe(true);
    expect(rowOf('spoke').querySelector('.mb-insp-check').checked).toBe(false);
    expect(MApp.Api.mutate).not.toHaveBeenCalled();
    expect(field().value).toBe('Spokes here are 13G');
    expect(document.getElementById('inspection-remark-item').textContent).toContain('Spoke 12G');
    expect(document.getElementById('inspection-remark-by').textContent).toContain('Alex Doe');
    expect(document.getElementById('inspection-remark-remove-btn').style.display).toBe('');
  });

  test('saving sends the remark, closes the sheet and shows it on the row', async () => {
    await openChecklist(checklist([item('spoke', 'Spoke 12G'), item('tape', 'Rim Tape')]));
    remarkBtn('spoke').click();
    expect(document.getElementById('inspection-remark-remove-btn').style.display).toBe('none');
    MApp.Api.mutate.mockResolvedValue(saved({ ...REMARK, text: 'Should be 45' }));
    field().value = 'Should be 45';
    await MApp.Inspection.saveRemark();
    expect(MApp.Api.mutate).toHaveBeenCalledWith('setInspectionItemRemark', 7, 'spoke', 'Should be 45');
    expect(isOpen('sheet-inspection-remark')).toBe(false);
    expect(rowOf('spoke').querySelector('.mb-insp-remark').textContent).toContain('Should be 45');
    expect(remarkBtn('spoke').classList.contains('is-set')).toBe(true);
    expect(document.getElementById('inspection-progress').textContent).toContain('1 with a remark');
  });

  test('Remove remark takes it off', async () => {
    await openChecklist(checklist([item('spoke', 'Spoke 12G', { remark: REMARK })]));
    remarkBtn('spoke').click();
    MApp.Api.mutate.mockResolvedValue(saved(null, 0));
    await MApp.Inspection.saveRemark(true);
    expect(MApp.Api.mutate).toHaveBeenCalledWith('setInspectionItemRemark', 7, 'spoke', '');
    expect(rowOf('spoke').querySelector('.mb-insp-remark')).toBeNull();
  });

  test('nothing changed sends nothing; a refusal keeps the sheet open with the text', async () => {
    await openChecklist(checklist([item('spoke', 'Spoke 12G', { remark: REMARK })]));
    remarkBtn('spoke').click();
    await MApp.Inspection.saveRemark();
    expect(MApp.Api.mutate).not.toHaveBeenCalled();
    expect(isOpen('sheet-inspection-remark')).toBe(false);

    remarkBtn('spoke').click();
    field().value = 'Bent';
    MApp.Api.mutate.mockResolvedValue({ success: false, message: 'Lot #LOT-WHL001-0042 has already been cleared.' });
    await MApp.Inspection.saveRemark();
    expect(isOpen('sheet-inspection-remark')).toBe(true);
    expect(field().value).toBe('Bent');
    expect(document.getElementById('mapp-toast-stack').textContent).toContain('already been cleared');
  });

  test('a remark is text, never markup', async () => {
    await openChecklist(checklist([item('spoke', 'Spoke 12G', { remark: { ...REMARK, text: PAYLOAD, byName: PAYLOAD } })]));
    expect(rowOf('spoke').querySelector('.mb-insp-remark').textContent).toContain(PAYLOAD);
    expect(body().querySelector('.mb-insp-remark img')).toBeNull();
  });

  test('a cleared lot shows its remarks with no button', async () => {
    await openChecklist(checklist([item('spoke', 'Spoke 12G', { remark: REMARK })],
      { status: 'cleared', stage: 'cleared', clearedByName: 'Admin User', clearedByRole: 'Admin', clearedAt: '' }));
    expect(remarkBtn('spoke')).toBeNull();
    expect(rowOf('spoke').querySelector('.mb-insp-remark').textContent).toContain('Spokes here are 13G');
  });
});

describe('review and clearing', () => {
  beforeEach(mount);

  test('item remarks are enough to tick Needs admin review', async () => {
    await openChecklist(checklist([item('spoke', 'Spoke 12G', { remark: REMARK })]));
    MApp.Api.mutate.mockResolvedValue({ success: true, message: 'Saved.', data: { status: 'flagged', remarks: '', stage: 'needs_review', flaggedByName: 'Store Keeper' } });
    document.getElementById('inspection-needs-review').click();
    await flush();
    expect(MApp.Api.mutate).toHaveBeenCalledWith('setInspectionReview', 7, true, '');
  });

  test('the dialog before clearing shows each item\'s remark', async () => {
    await openChecklist(checklist([item('spoke', 'Spoke 12G', { remark: REMARK })]));
    MApp.Api.mutate.mockResolvedValue({
      success: true,
      data: {
        cleared: false, token: 't1', changedAgain: false, canAcknowledge: false,
        discrepancies: [{ kind: 'changed', itemName: 'Spoke 12G', size: '26in', color: '', unit: 'Pcs', remark: 'Should be 45',
          changes: [{ field: 'qty', label: 'Quantity', from: 50, to: 45 }] }]
      }
    });
    await MApp.Inspection.submit();
    const row = document.querySelector('#inspection-reconcile-body .mb-insp-diff-row');
    expect(row.querySelector('.mb-insp-remark').textContent).toBe('Should be 45');
  });
});
