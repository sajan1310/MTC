/**
 * Stock on hand on the desktop inspection checklist (asked 2026-11-02).
 *
 * An "In stock" column shows what the records say is on hand for each row's
 * item (`stock`, inspection_service.attach_stock): Current Stock, or the
 * Warehouse Pool bucket it draws from, red when the lot needs more than that
 * or the figure is below zero. A tick keeps the figure the checklist loaded.
 */

'use strict';

const fs = require('fs');
const path = require('path');

let mutations;

function load() {
  eval([
    fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8'),
    'global.escapeHtml = escapeHtml;',
    'global.toNumber = toNumber;',
    'global.formatQty = formatQty;'
  ].join('\n'));
  eval(fs.readFileSync(path.join(__dirname, '..', 'core.js'), 'utf8').replace(/^const App = /m, 'global.App = '));
  eval(fs.readFileSync(path.join(__dirname, '..', 'inspection.js'), 'utf8'));
}

const item = (key, itemName, extra = {}) => ({
  key, itemName, size: '20 inch', color: '', narration: '', qty: 10, unit: 'Pcs', fingerprint: '10|',
  state: 'pending', result: null, previous: null, photoUrl: '', canSetPhoto: false, stock: null, ...extra
});
const stock = (qty, extra = {}) => ({ qty, unit: 'Pcs', source: 'stock', color: '', short: false, ...extra });
const SEAT = item('seat', 'Maharaja-SEAT', { stock: stock(240) });
const BELL = item('bell', 'Bell', { stock: stock(4, { short: true }) });
const FRAME = item('frame|red', 'Painted Frame', { size: '', color: 'Red', stock: stock(30, { source: 'pool', color: 'Red' }) });
const STICKER = item('sticker', 'Sticker');

function detail(items) {
  return {
    lot: { rowIdx: 7, lotNumber: 'LOT-PKG010-0047', processName: 'Packing Crysta', outputItemName: '14 inch Crysta',
      productName: '', status: 'In Progress', date: '02/11/2026', qty: 60, colors: [] },
    inspection: { status: 'in_progress', stage: 'not_started', remarks: '' },
    items: items.map(i => ({ ...i })),
    removed: [],
    summary: { total: items.length, checked: 0, complete: false },
    inspector: { name: 'Store Keeper', roleLabel: 'Storekeeper' },
    canAcknowledge: false,
    canReturn: false
  };
}

async function open(items, reply) {
  document.body.innerHTML = `
    <div id="inspectionDetailModal" class="modal show">
      <h5 id="inspectionDetailTitle"></h5>
      <div id="inspectionDetailBody"></div>
      <div id="inspectionDetailFooterActions"></div>
    </div>
    <div id="sr-announcer"></div>`;
  mutations = [];
  global.Api = {
    callFresh: () => Promise.resolve({ success: true, data: detail(items) }),
    mutate: (...args) => {
      mutations.push(args);
      return Promise.resolve(reply ? reply(...args) : { success: true, data: {} });
    }
  };
  App.Utils.showToast = jest.fn();
  await App.Inspection.openDetail(7);
}

beforeAll(load);

const rowOf = key => [...document.querySelectorAll('#inspectionDetailBody [data-insp-row]')]
  .find(r => r.dataset.inspRow === key);
const headers = () => [...document.querySelectorAll('#inspectionDetailBody thead th')].map(th => th.textContent);
const stockCell = key => [...rowOf(key).querySelectorAll('td')].pop();
const text = el => el.textContent.replace(/\s+/g, ' ').trim();

describe('the In stock column', () => {
  test('what is on hand and where, or a dash when neither ledger knows the item', async () => {
    await open([SEAT, FRAME, STICKER]);
    expect(headers()).toEqual(['Ticked', 'Item', 'Size', 'Colour', 'Specification', 'Qty', 'In stock']);
    expect(text(stockCell('seat'))).toBe('240 PcsStock');
    expect(text(stockCell('frame|red'))).toBe('30 PcsPool · Red');
    expect(text(stockCell('sticker'))).toBe('—');
  });

  test('a row short of stock is red and says so; the progress line counts it', async () => {
    await open([SEAT, BELL]);
    expect(stockCell('bell').querySelector('.text-danger')).not.toBeNull();
    expect(text(stockCell('bell'))).toContain('Stock: less than this lot needs');
    expect(stockCell('seat').querySelector('.text-danger')).toBeNull();
    expect(document.getElementById('inspectionProgress').textContent).toContain('1 short of stock');
  });

  test('a figure below zero is red even when nothing is judged', async () => {
    await open([item('rim', 'Rim', { stock: stock(-7, { short: null }) })]);
    expect(stockCell('rim').querySelector('.text-danger')).not.toBeNull();
    expect(text(stockCell('rim'))).not.toContain('less than');
  });

  test('no column on a sheet the records know nothing of', async () => {
    await open([STICKER]);
    expect(headers()).toEqual(['Ticked', 'Item', 'Size', 'Colour', 'Specification', 'Qty']);
  });

  test('a tick keeps the figure the checklist loaded', async () => {
    const { stock: _left, ...ticked } = { ...SEAT, state: 'checked', result: 'pass' };
    await open([SEAT], () => ({
      success: true,
      data: { key: 'seat', result: 'pass', item: ticked, lotStatus: 'In Progress',
        summary: { total: 1, checked: 1, complete: true }, stage: 'complete' }
    }));
    await App.Inspection.toggle('seat');
    expect(mutations[0][0]).toBe('setInspectionCheck');
    expect(text(stockCell('seat'))).toContain('240 Pcs');
  });
});
