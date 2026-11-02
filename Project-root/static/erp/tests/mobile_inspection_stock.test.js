/**
 * Stock on hand on the phone/tablet inspection checklist (asked 2026-11-02).
 *
 * Each row shows what the records say is on hand for its item (`stock`,
 * inspection_service.attach_stock): Current Stock, or the Warehouse Pool
 * bucket it draws from. Red when the lot needs more than that, or the
 * figure is below zero. A phone shows it under the quantity, a wider screen
 * in an "In stock" column. A tick keeps the figure the checklist loaded.
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
    <div class="mb-toast-stack" id="mapp-toast-stack"></div>`;
  loadAsGlobal('api.js', 'Api');
  loadAsGlobal('mobile.js', 'MApp');
  MApp.Sheet._stack = [];
}

const item = (key, itemName, extra = {}) => ({
  key, itemName, size: '20 inch', color: '', narration: '', qty: 10, unit: 'Pcs',
  fingerprint: '10|', state: 'pending', result: null, previous: null,
  photoUrl: '', canSetPhoto: false, stock: null, ...extra
});

function checklist(items) {
  return {
    success: true,
    data: {
      lot: { rowIdx: 7, lotNumber: 'LOT-PKG010-0047', date: '02/11/2026', processName: 'Packing Crysta',
        outputItemName: '14 inch Crysta', productName: '', qty: 60, status: 'In Progress', colors: [] },
      inspection: { status: 'in_progress', remarks: '', stage: 'not_started' },
      items: items.map(i => ({ ...i })),
      removed: [],
      summary: { total: items.length, checked: 0, complete: false },
      inspector: { name: 'Store Keeper', roleLabel: 'Storekeeper' },
      canAcknowledge: false,
      canReturn: false
    }
  };
}

const stock = (qty, extra = {}) => ({ qty, unit: 'Pcs', source: 'stock', color: '', short: false, ...extra });
const SEAT = item('seat', 'Maharaja-SEAT', { stock: stock(240) });
const BELL = item('bell', 'Bell', { stock: stock(4, { short: true }) });
const FRAME = item('frame|red', 'Painted Frame', { size: '', color: 'Red', stock: stock(30, { source: 'pool', color: 'Red' }) });
const STICKER = item('sticker', 'Sticker');

const body = () => document.getElementById('inspection-body');
const rowOf = key => [...body().querySelectorAll('[data-insp-row]')].find(r => r.dataset.inspRow === key);
const stockOf = key => rowOf(key).querySelector('.mb-insp-stock');

async function open(items) {
  MApp.Api.call = jest.fn(async () => checklist(items));
  MApp.Api.mutate = jest.fn();
  await MApp.Inspection.openChecklist(7);
}

describe('stock on the checklist', () => {
  beforeEach(mount);

  test('each row says what is on hand, and where', async () => {
    await open([SEAT, FRAME, STICKER]);
    expect(body().querySelector('.mb-insp-list').classList.contains('mb-insp-with-stock')).toBe(true);
    expect(body().querySelector('.mb-insp-thead').textContent).toContain('In stock');
    expect(stockOf('seat').textContent.replace(/\s+/g, ' ').trim()).toBe('Stock 240 Pcs');
    expect(stockOf('frame|red').textContent.replace(/\s+/g, ' ').trim()).toBe('Pool · Red 30 Pcs');
    // Neither ledger knows it: a dash that only the column shows.
    expect(stockOf('sticker').classList.contains('mb-insp-stock-none')).toBe(true);
  });

  test('a row short of stock is marked, and the progress line counts it', async () => {
    await open([SEAT, BELL]);
    expect(stockOf('bell').classList.contains('is-short')).toBe(true);
    expect(stockOf('bell').textContent).toContain('less than this lot needs');
    expect(stockOf('seat').classList.contains('is-short')).toBe(false);
    expect(document.getElementById('inspection-progress').textContent).toContain('1 short of stock');
  });

  test('a figure below zero is red even when nothing is judged', async () => {
    await open([item('rim', 'Rim', { stock: stock(-7, { short: null }) })]);
    expect(stockOf('rim').classList.contains('is-short')).toBe(true);
    expect(stockOf('rim').textContent).not.toContain('less than this lot needs');
  });

  test('a sheet the records know nothing of looks as it did', async () => {
    await open([STICKER]);
    expect(body().querySelector('.mb-insp-stock')).toBeNull();
    expect(body().querySelector('.mb-insp-list').classList.contains('mb-insp-with-stock')).toBe(false);
    expect(body().querySelector('.mb-insp-thead').textContent).not.toContain('In stock');
  });

  test('a tick keeps the figure the checklist loaded', async () => {
    await open([SEAT]);
    // setInspectionCheck's row carries no stock.
    const { stock: _left, ...ticked } = { ...SEAT, state: 'checked', result: 'pass' };
    MApp.Api.mutate = jest.fn(async () => ({
      success: true,
      data: { key: 'seat', result: 'pass', item: ticked, lotStatus: 'In Progress',
        summary: { total: 1, checked: 1, complete: true }, stage: 'complete' }
    }));
    await MApp.Inspection.toggle('seat');
    expect(rowOf('seat').querySelector('.mb-insp-check').checked).toBe(true);
    expect(stockOf('seat').textContent).toContain('240 Pcs');
  });
});
