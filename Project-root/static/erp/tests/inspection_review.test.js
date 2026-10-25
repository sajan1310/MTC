/**
 * Production > Inspections on desktop (App.Inspection, inspection.js).
 *
 * Review only: inspectors work in the phone app. This holds the desk's
 * side -- flagged lots lead the list, an inspector's remarks render as
 * text, the read-only checklist shows what changed, and only an admin is
 * offered "Send back for re-inspection", which posts the admin's note.
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
    <div id="inspectionsEmptyState" style="display:none;"></div>
    <div id="inspectionDetailModal">
      <h5 id="inspectionDetailTitle"></h5>
      <div id="inspectionDetailBody"></div>
      <div id="inspectionDetailFooterActions"></div>
    </div>
    <div id="sr-announcer"></div>`;
}

function stubApi({ lots = [], detail = null, mutate = null } = {}) {
  calls = [];
  mutations = [];
  global.Api = {
    callFresh: (...args) => {
      calls.push(args);
      return Promise.resolve({ success: true, data: args[0] === 'getInspectionLots' ? lots : detail });
    },
    mutate: (...args) => {
      mutations.push(args);
      return Promise.resolve(mutate || { success: true, message: 'Sent back.', data: { status: 'in_progress' } });
    },
  };
}

function lot(rowIdx, lotNumber, status, inspection = {}) {
  return {
    rowIdx, lotNumber, date: '24/10/2026', processName: 'Powder Coating', outputItemName: '26in Rim',
    status: 'In Progress', itemCount: 3, lastUpdated: '',
    inspection: { status, remarks: '', summary: { total: 3, checked: 1, failed: 0, revised: 0, added: 0 }, ...inspection },
  };
}

function detail({ status = 'flagged', canReturn = true } = {}) {
  return {
    lot: { rowIdx: 7, lotNumber: 'LOT-PNT005-0011', processName: 'Powder Coating', outputItemName: '26in Rim',
      productName: '', status: 'In Progress', date: '24/10/2026', qty: 60, colors: [] },
    inspection: { status, remarks: 'Spokes are 13G, not 12G', flaggedByName: 'Alex Doe', flaggedAt: '' },
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

beforeEach(() => {
  delete window.__xss;
  mount();
  load();
});

describe('the review list', () => {
  test('flagged lots lead, and "Needs attention" leaves out untouched and cleared ones', async () => {
    stubApi({ lots: [lot(1, 'LOT-A', 'in_progress'), lot(2, 'LOT-B', 'flagged'), lot(3, 'LOT-C', 'cleared'), lot(4, 'LOT-D', '')] });
    await App.Inspection.load();

    const lots = () => [...document.querySelectorAll('#inspectionsTableBody strong')].map(s => s.textContent);
    expect(calls[0]).toEqual(['getInspectionLots']);
    expect(lots()).toEqual(['LOT-B', 'LOT-A']);

    App.Inspection.setFilter('all');
    expect(lots()).toEqual(['LOT-B', 'LOT-A', 'LOT-D', 'LOT-C']);
  });

  test('an inspector\'s remarks render as text', async () => {
    stubApi({ lots: [lot(1, 'LOT-A', 'flagged', { remarks: PAYLOAD })] });
    await App.Inspection.load();

    const body = document.getElementById('inspectionsTableBody');
    expect(body.querySelector('img')).toBeNull();
    expect(window.__xss).toBeUndefined();
    expect(body.textContent).toContain('onerror');
  });
});

describe('one lot', () => {
  test('the checklist shows what changed, read-only', async () => {
    stubApi({ detail: detail() });
    await App.Inspection.openDetail(7);

    const body = document.getElementById('inspectionDetailBody').textContent;
    expect(calls[0]).toEqual(['getInspection', 7]);
    expect(body).toContain('Revised');
    expect(body).toContain('was 50');
    expect(body).toContain('Spokes are 13G, not 12G');
    expect(document.querySelector('#inspectionDetailBody button')).toBeNull();
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
