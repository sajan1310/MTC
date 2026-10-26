/**
 * Production > Inspections on desktop (App.Inspection, inspection.js).
 *
 * The list -- every lot by default, those needing review first, one filter
 * per stage -- and one lot's checklist, where items are ticked, a review is
 * asked for and the lot cleared exactly as in the phone app (same RPCs).
 * An inspector clears an All checked lot; an admin clears any open lot after
 * seeing what is not ticked, and is the only one offered "Send back for
 * re-inspection" and "Acknowledge & Proceed".
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PAYLOAD = '<img src=x onerror="window.__xss=1">';

let calls;
let mutations;

function load() {
  const api = [
    fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8'),
    'global.escapeHtml = escapeHtml;',
    'global.toNumber = toNumber;',
    'global.formatQty = formatQty;',
  ].join('\n');
  // eslint-disable-next-line no-eval
  eval(api);
  const core = fs
    .readFileSync(path.join(__dirname, '..', 'core.js'), 'utf8')
    .replace(/^const App = /m, 'global.App = ');
  // eslint-disable-next-line no-eval
  eval(core);
  // eslint-disable-next-line no-eval
  eval(fs.readFileSync(path.join(__dirname, '..', 'inspection.js'), 'utf8'));
}

function mount() {
  document.body.innerHTML = `
    <table><tbody id="inspectionsTableBody"></tbody></table>
    <div id="inspectionsEmptyState" style="display:none;"><p id="inspectionsEmptyText"></p></div>
    <div id="inspectionDetailModal">
      <h5 id="inspectionDetailTitle"></h5>
      <div id="inspectionDetailBody"></div>
      <div id="inspectionDetailFooterActions"></div>
    </div>
    <div id="sr-announcer"></div>`;
}

// `detail` and `mutate` may be functions: a fresh lot per load (the page
// edits the one it holds), and a reply per call.
function stubApi({ lots = [], detail = null, mutate = null } = {}) {
  calls = [];
  mutations = [];
  global.Api = {
    callFresh: (...args) => {
      calls.push(args);
      const data = args[0] === 'getInspectionLots' ? lots : typeof detail === 'function' ? detail() : detail;
      return Promise.resolve({ success: true, data });
    },
    mutate: (...args) => {
      mutations.push(args);
      const reply = typeof mutate === 'function' ? mutate(...args) : mutate;
      return Promise.resolve(reply || { success: true, message: 'Sent back.', data: { status: 'in_progress' } });
    },
  };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

const ALL_TICKED = { total: 2, checked: 2, passed: 2, failed: 0, revised: 0, added: 0, removed: 0, complete: true };
const NONE_TICKED = { total: 2, checked: 0, passed: 0, failed: 0, revised: 0, added: 0, removed: 0, complete: false };

function lot(rowIdx, lotNumber, stage, inspection = {}) {
  return {
    rowIdx, lotNumber, date: '24/10/2026', processName: 'Powder Coating', outputItemName: '26in Rim',
    status: 'In Progress', itemCount: 3, lastUpdated: '',
    inspection: { stage, status: '', remarks: '', summary: { total: 3, checked: 1, revised: 0, added: 0 }, ...inspection },
  };
}

// A lot an admin was asked to review, with one revised row.
function detail({ status = 'flagged', canReturn = true } = {}) {
  return {
    lot: { rowIdx: 7, lotNumber: 'LOT-PNT005-0011', processName: 'Powder Coating', outputItemName: '26in Rim',
      productName: '', status: 'In Progress', date: '24/10/2026', qty: 60, colors: [] },
    inspection: { status, stage: status === 'cleared' ? 'cleared' : 'needs_review', remarks: 'Spokes are 13G, not 12G',
      flaggedByName: 'Alex Doe', flaggedAt: '' },
    items: [
      { key: 'spoke', itemName: 'Spoke 12G', size: '26in', color: '', narration: 'Zinc', qty: 45, unit: 'Pcs',
        state: 'revised', result: null, previous: { qty: 50, narration: 'Zinc' } },
      { key: 'tape', itemName: 'Rim Tape', size: '26in', color: '', narration: '', qty: 60, unit: 'Pcs',
        state: 'checked', result: 'pass', previous: null },
    ],
    removed: [],
    summary: { total: 2, checked: 1, passed: 1, failed: 0, revised: 1, added: 0, removed: 0, complete: false },
    inspector: { name: 'Admin User', roleLabel: 'Admin' },
    canAcknowledge: canReturn,
    canReturn,
  };
}

function sheetRow(key, itemName, extra = {}) {
  return { key, fingerprint: `fp-${key}`, itemName, size: '26in', color: '', narration: '', qty: 40, unit: 'Pcs',
    state: 'pending', result: null, previous: null, ...extra };
}

// A lot nobody has started, as getInspection returns it.
function openLot({ items, summary, status = '', stage = 'not_started', admin = false } = {}) {
  return {
    lot: { rowIdx: 9, lotNumber: 'LOT-PNT005-0012', processName: 'Powder Coating', outputItemName: '26in Rim',
      productName: '', status: 'Pending', date: '25/10/2026', qty: 40, colors: ['Red'] },
    inspection: { status, stage, remarks: '' },
    items: items || [sheetRow('k1', 'Spoke 12G'), sheetRow('k2', 'Rim Tape')],
    removed: [],
    summary: summary || NONE_TICKED,
    inspector: { name: 'Admin User', roleLabel: admin ? 'Super Admin' : 'Storekeeper' },
    canAcknowledge: admin,
    canReturn: admin,
  };
}

function tickedLot(admin = false) {
  return openLot({
    status: 'in_progress',
    stage: 'complete',
    admin,
    items: [sheetRow('k1', 'Spoke 12G', { state: 'checked', result: 'pass' }), sheetRow('k2', 'Rim Tape', { state: 'checked', result: 'pass' })],
    summary: ALL_TICKED,
  });
}

function clearedReply(acknowledged = []) {
  return { success: true, message: 'Thank you.', data: { cleared: true, lotNumber: 'LOT-PNT005-0012',
    processName: 'Powder Coating', inspector: { name: 'Admin User' }, acknowledged } };
}

const body = () => document.getElementById('inspectionDetailBody');
const box = key => body().querySelector(`[data-insp-key="${key}"]`);

beforeEach(() => {
  delete window.__xss;
  mount();
  load();
});

describe('the review list', () => {
  test('every lot shows by default, needs review first; each filter is one stage', async () => {
    stubApi({ lots: [lot(1, 'LOT-A', 'partial'), lot(2, 'LOT-B', 'needs_review'), lot(3, 'LOT-C', 'cleared'),
      lot(4, 'LOT-D', 'not_started'), lot(5, 'LOT-E', 'complete')] });
    await App.Inspection.load();

    const lots = () => [...document.querySelectorAll('#inspectionsTableBody strong')].map(s => s.textContent);
    expect(calls[0]).toEqual(['getInspectionLots']);
    expect(lots()).toEqual(['LOT-B', 'LOT-E', 'LOT-A', 'LOT-D', 'LOT-C']);
    expect(document.getElementById('inspectionsTableBody').textContent).toContain('Partially checked');

    App.Inspection.setFilter('partial');
    expect(lots()).toEqual(['LOT-A']);
    App.Inspection.setFilter('needs_review');
    expect(lots()).toEqual(['LOT-B']);
  });

  test('an empty list says why, for the filter chosen', async () => {
    stubApi({ lots: [lot(1, 'LOT-A', 'not_started')] });
    await App.Inspection.load();
    expect(document.querySelectorAll('#inspectionsTableBody tr')).toHaveLength(1);

    App.Inspection.setFilter('needs_review');
    expect(document.getElementById('inspectionsEmptyState').style.display).toBe('block');
    expect(document.getElementById('inspectionsEmptyText').textContent).toBe('No lot is waiting for an admin\'s review.');
  });

  test('an inspector\'s remarks render as text', async () => {
    stubApi({ lots: [lot(1, 'LOT-A', 'needs_review', { remarks: PAYLOAD })] });
    await App.Inspection.load();

    const tbody = document.getElementById('inspectionsTableBody');
    expect(tbody.querySelector('img')).toBeNull();
    expect(window.__xss).toBeUndefined();
    expect(tbody.textContent).toContain('onerror');
  });

  test('the list offers Inspect on open lots and View on cleared ones', async () => {
    stubApi({ lots: [lot(1, 'LOT-A', 'not_started'), lot(2, 'LOT-B', 'cleared')] });
    await App.Inspection.load();
    const labels = [...document.querySelectorAll('#inspectionsTableBody button')].map(b => b.textContent);
    expect(labels).toEqual(['Inspect', 'View']);
  });
});

describe('one lot', () => {
  test('an open lot has a box per item and shows what changed; a cleared one is read-only', async () => {
    stubApi({ detail: detail() });
    await App.Inspection.openDetail(7);

    expect(calls[0]).toEqual(['getInspection', 7]);
    expect(body().textContent).toContain('Revised');
    expect(body().textContent).toContain('was 50');
    expect(document.getElementById('inspectionRemarks').value).toBe('Spokes are 13G, not 12G');
    expect(document.getElementById('inspectionNeedsReview').checked).toBe(true);
    expect(box('spoke').checked).toBe(false);
    expect(box('tape').checked).toBe(true);
    expect(body().querySelector('[data-insp-result]')).toBeNull(); // no Pass / Fail

    stubApi({ detail: detail({ status: 'cleared' }) });
    await App.Inspection.openDetail(7);
    expect(body().querySelector('[data-insp-key]')).toBeNull();
    expect(body().querySelector('textarea')).toBeNull();
    expect(body().textContent).toContain('Spokes are 13G, not 12G');
  });

  test('"Needs admin review" is a panel of its own, apart from the material table', async () => {
    stubApi({ detail: openLot() });
    await App.Inspection.openDetail(9);
    const box = document.getElementById('inspectionNeedsReview');
    expect(box.closest('table')).toBeNull();
    const panel = box.closest('section.insp-review');
    expect(panel.querySelector('h6').textContent).toBe('Admin review');
    expect(panel.contains(document.getElementById('inspectionRemarks'))).toBe(true);
    expect(body().querySelector('.insp-layout > .insp-list table')).not.toBeNull();
  });

  test('item names render as text in the checklist', async () => {
    stubApi({ detail: openLot({ items: [sheetRow('k1', PAYLOAD)] }) });
    await App.Inspection.openDetail(9);
    expect(document.querySelector('#inspectionDetailBody img')).toBeNull();
    expect(window.__xss).toBeUndefined();
  });

  test('only an admin is offered "Send back", and it posts the note', async () => {
    stubApi({ detail: detail({ canReturn: false }) });
    await App.Inspection.openDetail(7);
    expect(document.getElementById('inspectionReturnBtn')).toBeNull();

    stubApi({ detail: detail({ canReturn: true }) });
    await App.Inspection.openDetail(7);
    document.getElementById('inspectionReturnNote').value = 'Recipe corrected to 13G';
    await App.Inspection.sendBack();

    expect(mutations[0]).toEqual(['returnInspection', 7, 'Recipe corrected to 13G']);
  });
});

// The phone app's inspection, on the desktop: same RPCs, same rules.
describe('inspecting on the desktop', () => {
  test('ticking saves the row, starts the lot, and counts it; ticking again unticks it', async () => {
    stubApi({
      detail: openLot(),
      mutate: (name, rowIdx, key, result) => ({
        success: true,
        message: result ? 'Lot #LOT-PNT005-0012 is now In Progress.' : '',
        data: {
          key,
          result: result ? 'pass' : null,
          item: { key, state: result ? 'checked' : 'pending', result: result ? 'pass' : null },
          lotStatus: 'In Progress',
          stage: result ? 'partial' : 'not_started',
          summary: { ...NONE_TICKED, checked: result ? 1 : 0, passed: result ? 1 : 0 },
        },
      }),
    });
    await App.Inspection.openDetail(9);

    box('k1').click();
    await flush();
    expect(mutations[0]).toEqual(['setInspectionCheck', 9, 'k1', 'checked', 'fp-k1']);
    expect(box('k1').checked).toBe(true);
    expect(document.getElementById('inspectionLotStatus').textContent).toBe('In Progress');
    expect(document.getElementById('inspectionStage').textContent).toBe('Partially checked');
    expect(document.getElementById('inspectionProgress').textContent).toContain('1/2');
    expect(document.getElementById('inspectionClearBtn').disabled).toBe(true);
    expect(document.getElementById('inspectionWhy').textContent).toBe('1 item still to tick.');

    box('k1').click();
    await flush();
    expect(mutations[1]).toEqual(['setInspectionCheck', 9, 'k1', '', 'fp-k1']);
    expect(box('k1').checked).toBe(false);
  });

  test('a refused tick reloads the checklist, because the sheet moved', async () => {
    const toast = jest.spyOn(App.Utils, 'showToast').mockImplementation(() => {});
    stubApi({
      detail: () => openLot(),
      mutate: () => ({ success: false, message: 'That item changed on the Production Sheet after the checklist loaded. Reload it.' }),
    });
    await App.Inspection.openDetail(9);
    await App.Inspection.toggle('k1');

    expect(toast).toHaveBeenCalledWith(expect.stringContaining('changed on the Production Sheet'), true);
    expect(calls.filter(c => c[0] === 'getInspection')).toHaveLength(2);
  });

  test('once every item is ticked, Clear signs the lot off by name', async () => {
    stubApi({ detail: tickedLot(), mutate: () => clearedReply() });
    await App.Inspection.openDetail(9);
    expect(document.getElementById('inspectionDetailFooterActions').textContent).toContain('Inspector: Admin User');
    expect(document.getElementById('inspectionClearBtn').disabled).toBe(false);

    await App.Inspection.submit();
    expect(mutations).toEqual([['clearInspection', 9]]);
    expect(body().textContent).toContain('Thank you, Admin User. Your lot has been cleared for Powder Coating.');
    expect(document.getElementById('inspectionClearBtn')).toBeNull();
  });

  test('Needs admin review needs remarks, saves with them, and holds the lot for an admin', async () => {
    const toast = jest.spyOn(App.Utils, 'showToast').mockImplementation(() => {});
    stubApi({
      detail: tickedLot(),
      mutate: (name, rowIdx, needsReview, remarks) => ({
        success: true, message: 'Saved.',
        data: { status: needsReview ? 'flagged' : 'in_progress', stage: needsReview ? 'needs_review' : 'complete',
          remarks, flaggedByName: 'Admin User', summary: ALL_TICKED },
      }),
    });
    await App.Inspection.openDetail(9);

    document.getElementById('inspectionNeedsReview').click();
    await flush();
    expect(mutations).toHaveLength(0);
    expect(document.getElementById('inspectionNeedsReview').checked).toBe(false);
    expect(toast).toHaveBeenCalledWith('Write what the admin should look at, then tick Needs admin review.', true);

    document.getElementById('inspectionRemarks').value = 'Spokes are 13G';
    document.getElementById('inspectionNeedsReview').click();
    await flush();
    expect(mutations[0]).toEqual(['setInspectionReview', 9, true, 'Spokes are 13G']);
    expect(body().textContent).toContain('Needs admin review by Admin User');
    expect(document.getElementById('inspectionStage').textContent).toBe('Needs review');
    expect(document.getElementById('inspectionClearBtn').disabled).toBe(true);
    expect(document.getElementById('inspectionWhy').textContent).toBe('Waiting for an admin to review this lot.');
  });

  test('an admin clears a partly ticked lot after seeing exactly what is not ticked', async () => {
    const unticked = [
      { kind: 'unchecked', itemName: 'Spoke 12G', size: '26in', color: '', unit: 'Pcs', qty: 40 },
      { kind: 'unchecked', itemName: 'Rim Tape', size: '26in', color: '', unit: 'Pcs', qty: 40 },
    ];
    let n = 0;
    stubApi({
      detail: openLot({ status: 'in_progress', admin: true }),
      mutate: () => (++n === 1
        ? { success: true, message: '2 item(s) not ticked.', data: { cleared: false, discrepancies: unticked, token: 'tok-2', changedAgain: false, canAcknowledge: true } }
        : clearedReply(unticked)),
    });
    await App.Inspection.openDetail(9);
    expect(document.getElementById('inspectionClearBtn').disabled).toBe(false);
    expect(document.getElementById('inspectionWhy').textContent).toBe('2 items not ticked. You can still clear the lot; you will see them first.');

    await App.Inspection.submit();
    expect(body().textContent).toContain('2 items are not ticked. Clear the lot without them?');
    expect(body().textContent).toContain('Spoke 12G · 26in: not ticked (40 Pcs)');
    expect(document.getElementById('inspectionReinspectBtn').textContent).toBe('Back to the checklist');

    await App.Inspection.acknowledge();
    expect(mutations).toEqual([['clearInspection', 9], ['clearInspection', 9, 'tok-2']]);
    expect(body().textContent).toContain('2 items cleared by an admin without a tick');
  });

  test('when the sheet moved, only an admin may accept the differences', async () => {
    const diff = [{ kind: 'changed', itemName: 'Spoke 12G', size: '26in', color: '',
      changes: [{ field: 'qty', label: 'Quantity', from: 50, to: 45 }] }];
    const moved = canAcknowledge => ({ success: true, data: { cleared: false, discrepancies: diff, token: 'tok-1', changedAgain: false, canAcknowledge } });

    stubApi({ detail: tickedLot(), mutate: () => moved(false) });
    await App.Inspection.openDetail(9);
    await App.Inspection.submit();
    expect(body().textContent).toContain('quantity 50 → 45');
    expect(document.getElementById('inspectionReinspectBtn').textContent).toBe('Re-inspect Modified Items');
    expect(document.getElementById('inspectionAcknowledgeBtn')).toBeNull();

    let n = 0;
    stubApi({ detail: tickedLot(true), mutate: () => (++n === 1 ? moved(true) : clearedReply(diff)) });
    await App.Inspection.openDetail(9);
    await App.Inspection.submit();
    await App.Inspection.acknowledge();
    expect(mutations).toEqual([['clearInspection', 9], ['clearInspection', 9, 'tok-1']]);
    expect(body().textContent).toContain('Production Sheet changes accepted by an admin');
  });
});
