/**
 * Which group of the Colors to Produce checklist is Primary -- the group
 * whose checked quantities ARE the lot's total (../production.js).
 *
 * Three defects, one theme: the Primary the form showed was not the Primary
 * that was saved.
 *   - The save identified the pick by its LABEL alone. Two groups can share
 *     a label, and the own-output group of a sequence-1 process has no
 *     server-side axis at all, so the server resolved a different group and
 *     saved a different total from the one on screen.
 *   - Reopening a lot drew the process's CURRENT default as Primary, not the
 *     group the lot was saved with. Every save writes its pick back onto the
 *     process, so one later lot picking differently was enough to reopen an
 *     earlier one totalled on the other group.
 *   - Changing the Primary left each group's recorded role behind, so a
 *     custom colour filed into the group just made Primary never counted.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const PARTIAL = path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', 'production.html');

const FRAME = { key: 'pool:painted frame 26', label: 'Painted Frame 26', colors: ['Blue-White', 'Pink-White'], source: 'pool' };
const RIM = { key: 'tag:rim color', label: 'Rim Color', colors: ['BCP', 'Black'], source: 'tag' };

function loadProductionAsGlobal() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'production.js'), 'utf8');
  // eslint-disable-next-line no-eval
  eval(code);
}

function mount({ primaryAxisKey = FRAME.key, primaryIsDefault = false } = {}) {
  document.body.innerHTML = fs.readFileSync(PARTIAL, 'utf8');
  global.escapeHtml = value => String(value).replace(/[&<>"']/g, ch => HTML_ESCAPE_MAP[ch]);
  global.toNumber = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  global.$ = (sel, root = document) => root.querySelector(sel);
  global.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  global.formatCurrency = v => String(v);
  global.todayIso = () => '2026-01-01';
  global.parseRecordDate = () => 0;
  const data = {
    getProcessColorGroups: [...FRAME.colors, ...RIM.colors],
    getProcessColorAxes: { axes: [FRAME, RIM], primaryAxisKey, primaryIsDefault },
    getProcessComponentsData: [],
    getWarehousePoolData: [],
  };
  global.Api = {
    call: jest.fn(async method => ({ success: true, data: data[method] === undefined ? [] : data[method] })),
    mutate: jest.fn(async () => ({ success: false, message: 'captured' })),
  };
  const asyncNoop = async () => {};
  global.App = {
    State: {
      globalItems: [], globalColors: [], globalStock: [], globalProduction: [], filteredProduction: [],
      globalProcesses: [{ processId: 'P1', processName: 'Rim Fitting', outputItemName: 'Fitted Frame 26 inch', active: true }],
    },
    Utils: {
      sameText: (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase(),
      sameColor(a, b) { return this.sameText(a, b); },
      isCommonColorGroup: g => String(g ?? '').trim().toUpperCase() === 'COMMON',
      getSizeFromOutputItemName: () => 'General',
      getModelFromOutputItemName: () => 'General',
      setFormButtonsForMode: () => {},
      showToast: jest.fn(),
    },
    Process: { ensureLoaded: asyncNoop },
    Contractor: { ensureLoaded: asyncNoop },
    ProcessType: { ensureLoaded: asyncNoop },
    Model: { ensureLoaded: asyncNoop },
    Color: { ensureLoaded: asyncNoop },
    Nav: { register: () => {} },
  };
  loadProductionAsGlobal();
  const P = App.Production;
  P.refreshPoolAvailability = async () => {};
  Object.assign(P, {
    populateSizeSelect() {}, populateModelSelect() {}, populateProcessTypeSelect() {},
    populateProcessSelect() {}, populateProductSelect() {}, initContractorSelect2() {},
    refreshExtraChargeOptions: async () => {}, refreshPayableHint() {},
  });
  const sel = document.getElementById('productionProcessId');
  sel.innerHTML = '<option value="P1">Rim Fitting</option>';
  sel.value = 'P1';
}

const rowIn = (group, color) => $$('#productionColorChecklist .production-color-row')
  .find(r => r.dataset.group === group && r.dataset.color === color);
const radio = key => $$('input[name="productionPrimaryAxisPick"]').find(r => r.value === key);

async function check(group, color, qty) {
  const row = rowIn(group, color);
  const chk = row.querySelector('.production-color-check');
  chk.checked = true;
  await App.Production.handleColorCheckToggle(chk);
  if (qty !== undefined) {
    row.querySelector('.production-color-qty').value = String(qty);
    App.Production.onColorQtyChanged(row);
  }
}

// A lot of 40 frames logged with the FRAMES as Primary; its rim rows were
// left at the lot total (the co-consumption shape, so no grid is needed).
function savedLot(breakdown) {
  return {
    rowIdx: 7, processId: 'P1', lotNumber: 'LOT-RF-0001', qty: 40, status: 'Pending',
    assignedBy: '', assignedTo: 'Worker A', remarks: '', dateRaw: '2026-09-01',
    outputItemName: 'Fitted Frame 26 inch',
    colorBreakdown: breakdown,
    componentsConsumed: [{ itemName: 'Spoke Set', qty: 40, colorGroup: 'COMMON', sourceType: 'ITEM' }],
  };
}

const FRAMES_PRIMARY = [
  { color: 'Blue-White', qty: 24, countsTowardTotal: true, axisKey: FRAME.key },
  { color: 'Pink-White', qty: 16, countsTowardTotal: true, axisKey: FRAME.key },
  { color: 'BCP', qty: 40, countsTowardTotal: false, axisKey: RIM.key },
  { color: 'Black', qty: 40, countsTowardTotal: false, axisKey: RIM.key },
];

describe('Reopening a lot', () => {
  test('restores the Primary it was saved with, not the process default', async () => {
    // A later lot picked the rims, and that pick was written back onto the
    // process as its default.
    mount({ primaryAxisKey: RIM.key });
    App.State.globalProduction = [savedLot(FRAMES_PRIMARY)];

    await App.Production.openEditModal(0);

    expect(radio(FRAME.key).checked).toBe(true);
    expect(rowIn(FRAME.key, 'Blue-White').dataset.primary).toBe('true');
    expect(rowIn(RIM.key, 'BCP').dataset.primary).toBe('false');
    // Was 80: the two rim rows, each at the lot total, counted as the lot.
    expect(App.Production._currentLotTotalQty()).toBe(40);
    const sent = App.Production.getCheckedColorQtys()
      .map(({ color, qty, countsTowardTotal, axisKey }) => ({ color, qty, countsTowardTotal, axisKey }));
    expect(sent).toEqual(FRAMES_PRIMARY);
  });

  test('keeps the process default when the lot counted rows of two groups', async () => {
    // History from before one group had to be chosen: every checked row
    // counted. There is no single group to put back, so the lot opens as it
    // always did.
    mount({ primaryAxisKey: RIM.key });
    App.State.globalProduction = [savedLot(FRAMES_PRIMARY.map(e => ({ ...e, countsTowardTotal: true })))];

    await App.Production.openEditModal(0);

    expect(radio(RIM.key).checked).toBe(true);
  });

  test('a lot saved before any Primary was set opens on the group it counted', async () => {
    mount({ primaryAxisKey: FRAME.key, primaryIsDefault: true });
    App.State.globalProduction = [savedLot(FRAMES_PRIMARY)];

    await App.Production.openEditModal(0);

    expect(radio(FRAME.key).checked).toBe(true);
    // The "pick which group is Primary" warning is answered by the lot itself.
    expect(document.getElementById('productionPrimaryAxisWarning')).toBeNull();
  });
});

describe('Saving', () => {
  test('sends the Primary group\'s key as well as its label', async () => {
    mount();
    await App.Production.populateColorChecklist('P1');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await check(FRAME.key, 'Blue-White', 10);

    await document.getElementById('productionForm').onsubmit({ preventDefault() {} });

    expect(Api.mutate).toHaveBeenCalledTimes(1);
    const [method, formData] = Api.mutate.mock.calls[0];
    expect(method).toBe('saveProduction');
    expect(formData.primaryColorAxis).toBe(FRAME.label);
    expect(formData.primaryColorAxisKey).toBe(FRAME.key);
  });
});

describe('Changing the Primary', () => {
  test('a custom colour filed into the new Primary group counts toward the lot', async () => {
    mount({ primaryIsDefault: true });
    await App.Production.populateColorChecklist('P1');
    const rimRadio = radio(RIM.key);
    rimRadio.checked = true;
    await App.Production.setPrimaryColorAxisChoice(rimRadio);

    const input = document.getElementById('productionCustomColorInput');
    input.innerHTML = '<option value="Grey" selected>Grey</option>';
    document.getElementById('productionCustomColorGroupSelect').value = RIM.key;
    App.Production.addCustomColorRow();

    // Was 'false': the group's role as drawn, before the Primary was picked.
    expect(rowIn(RIM.key, 'Grey').dataset.primary).toBe('true');
    expect(App.Production.getCheckedColorQtys().find(e => e.color === 'Grey').countsTowardTotal).toBe(true);
  });

  test('the group picker keeps its selection and moves its "(Primary)" mark', async () => {
    mount();
    await App.Production.populateColorChecklist('P1');
    const picker = document.getElementById('productionCustomColorGroupSelect');
    picker.value = FRAME.key;

    const rimRadio = radio(RIM.key);
    rimRadio.checked = true;
    await App.Production.setPrimaryColorAxisChoice(rimRadio);

    expect(picker.value).toBe(FRAME.key);
    const labelOf = key => Array.from(picker.options).find(o => o.value === key).textContent;
    expect(labelOf(RIM.key)).toContain('(Primary)');
    expect(labelOf(FRAME.key)).not.toContain('(Primary)');
  });

  test('a row that was following the lot holds its figure once its group is Primary', async () => {
    mount();
    await App.Production.populateColorChecklist('P1');
    await check(FRAME.key, 'Blue-White', 10);
    await check(RIM.key, 'Black');
    expect(rowIn(RIM.key, 'Black').querySelector('.production-color-qty').value).toBe('10');

    const rimRadio = radio(RIM.key);
    rimRadio.checked = true;
    await App.Production.setPrimaryColorAxisChoice(rimRadio);
    expect(rowIn(RIM.key, 'Black').dataset.autoSynced).toBeUndefined();

    // Back to the frames: Black is secondary again but, having been a
    // counting row, keeps the number it held rather than following again.
    const frameRadio = radio(FRAME.key);
    frameRadio.checked = true;
    await App.Production.setPrimaryColorAxisChoice(frameRadio);
    rowIn(FRAME.key, 'Blue-White').querySelector('.production-color-qty').value = '12';
    App.Production.onColorQtyChanged(rowIn(FRAME.key, 'Blue-White'));
    expect(rowIn(RIM.key, 'Black').querySelector('.production-color-qty').value).toBe('10');
  });
});
