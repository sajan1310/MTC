/**
 * A pool item's photos on the desktop Warehouse Pool (asked 2026-11-02;
 * one per colour since 2026-11-24, migration 060).
 *
 * One photo per pool item and colour (getPoolItemPhotos, a list of
 * {outputItemName, color, photoUrl}): a Red frame and a Blue one each have
 * their own, the one the inspection checklist rows drawing on that bucket
 * show. Each combination in the breakdown dialog shows its colour's photo,
 * or a camera -- never another colour's. The Process row shows one of them
 * to know the item by (the no-colour photo first), or an empty slot. A
 * click shows it large (App.PhotoViewer) with "Change photo". The photo
 * sits inside a row with its own click, so a click on it must not reach
 * that too.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function loadAsGlobal(relPath) {
  const code = fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8')
    .replace(/^const App = /m, 'global.App = ');
  // eslint-disable-next-line no-eval
  eval(code);
}

global.escapeHtml = str => String(str ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const FRAME = "Painted Frame 26 'Gloss'";
const PAINTING = { processId: 'PRC-PAINT', processName: 'Painting 26', outputItemName: FRAME, sequence: 1, active: true };
const FITTING = { processId: 'PRC-FIT', processName: 'Rim Fitting 20', outputItemName: 'Fitted Rim 20', sequence: 2, active: true };
const PACKING = { processId: 'PRC-PACK', processName: 'Packing 20', outputItemName: 'Packed Cycle 20', sequence: 3, active: true };

const bucket = (process, color, extra = {}) => ({
  outputItemName: process.outputItemName, processId: process.processId, productTag: '', color,
  producedQty: 5, consumedQty: 0, availableQty: 5, removable: true, ...extra
});
const POOL = [
  bucket(PAINTING, 'Red'),
  bucket(PAINTING, 'Blue "Kit" 24'),
  bucket(FITTING, 'Orange-White / Black'),
  bucket(PACKING, '')
];
const PHOTOS = [
  { outputItemName: FRAME, color: 'Red', photoUrl: '/erp/pool-photo/4?v=70' },
  { outputItemName: 'Fitted Rim 20', color: 'orange-white / black', photoUrl: '/erp/pool-photo/6?v=72' }
];

let mutations;

beforeEach(() => {
  document.body.innerHTML =
    '<table><thead><tr id="warehousePoolTableHeaderRow"></tr></thead>'
    + '<tbody id="warehousePoolTableBody"></tbody></table>'
    + '<div id="warehousePoolEmptyState"></div>'
    + '<div id="warehousePoolProcessModal" class="modal"><h5 id="warehousePoolProcessModalTitle"></h5>'
    + '<table><thead><tr></tr></thead><tbody id="warehousePoolProcessModalBody"></tbody></table>'
    + '<button id="btnBulkDeleteWarehousePoolCombos"></button></div>';
  loadAsGlobal('core.js');
  App.Production = { formatQty: q => String(q) };
  App.Process = { GROUP_DIMENSIONS: {}, buildRankMaps: () => [] };
  App.Utils.showToast = jest.fn();
  global.safeModalShow = jest.fn(id => document.getElementById(id).classList.add('show'));
  mutations = [];
  global.Api = {
    call: jest.fn(async method => {
      if (method === 'getWarehousePoolData') return { success: true, data: POOL.map(b => ({ ...b })) };
      if (method === 'getAllProcessColorGroups') return { success: true, data: {} };
      if (method === 'getPoolItemPhotos') return { success: true, data: PHOTOS.map(p => ({ ...p })) };
      return { success: false };
    }),
    mutate: jest.fn(async (...args) => {
      mutations.push(args);
      return {
        success: true, message: `Photo saved for ${FRAME} · Blue "Kit" 24.`,
        data: { outputItemName: FRAME, color: 'Blue "Kit" 24', photoUrl: '/erp/pool-photo/5?v=71' }
      };
    })
  };
  loadAsGlobal('stock.js');
  App.State.globalProcesses = [PAINTING, FITTING, PACKING];
  // The leaf rows are the pool's buckets for the Process; how they are
  // worked out is not what these tests are about.
  App.Stock.computeLeafRowsForProcess = process => (App.State.globalWarehousePool || [])
    .filter(b => b.processId === process.processId);
});

const rowOf = name => [...document.querySelectorAll('#warehousePoolTableBody tr.pool-process-row')]
  .find(tr => tr.textContent.includes(name));
const comboOf = color => [...document.querySelectorAll('#warehousePoolProcessModalBody tr')]
  .find(tr => tr.textContent.includes(color));
const viewer = () => document.querySelector('.photo-viewer-overlay');

async function openBreakdown(processId) {
  await App.Stock.loadWarehousePoolData();
  App.Stock.openWarehousePoolProcessModal(processId);
}

describe('each colour in the breakdown has its own photo', () => {
  test('a colour with a photo shows it; a colour with none shows a camera, not another colour\'s', async () => {
    await openBreakdown('PRC-PAINT');
    expect(Api.call).toHaveBeenCalledWith('getPoolItemPhotos');
    const img = comboOf('Red').querySelector('.pool-photo-btn img');
    expect(img.getAttribute('src')).toBe('/erp/pool-photo/4?v=70');
    expect(img.getAttribute('loading')).toBe('lazy');
    const blue = comboOf('Blue');
    expect(blue.querySelector('.pool-photo-btn img')).toBeNull();
    expect(blue.querySelector('.pool-photo-add').getAttribute('aria-label'))
      .toBe(`Add a photo of ${FRAME} · Blue "Kit" 24`);
  });

  test('a combination is matched whatever its case', async () => {
    await openBreakdown('PRC-FIT');
    expect(comboOf('Orange-White / Black').querySelector('.pool-photo-btn img').getAttribute('src'))
      .toBe('/erp/pool-photo/6?v=72');
  });

  test('a click shows it large, named with its colour, with Change photo', async () => {
    await openBreakdown('PRC-PAINT');
    comboOf('Red').querySelector('.pool-photo-btn').click();
    expect(viewer().hidden).toBe(false);
    expect(viewer().querySelector('img').getAttribute('src')).toBe('/erp/pool-photo/4?v=70');
    expect(viewer().querySelector('.photo-viewer-title').textContent).toBe(`${FRAME} · Red`);
    expect(viewer().querySelector('.photo-viewer-change').hidden).toBe(false);
  });

  test('the dialog title no longer carries a photo for every colour', async () => {
    await openBreakdown('PRC-PAINT');
    const title = document.getElementById('warehousePoolProcessModalTitle');
    expect(title.querySelector('.pool-photo-btn')).toBeNull();
    expect(title.textContent).toContain('Warehouse Pool: Painting 26');
  });
});

describe('the photo beside each Process', () => {
  test('one of its colours\' photos, or an empty slot -- no camera, and no click into the breakdown', async () => {
    await App.Stock.loadWarehousePoolData();
    const img = rowOf('Painting 26').querySelector('.pool-photo-btn img');
    expect(img.getAttribute('src')).toBe('/erp/pool-photo/4?v=70');
    const empty = rowOf('Packing 20').querySelector('.pool-photo-none');
    expect(empty.getAttribute('aria-hidden')).toBe('true');
    expect(document.querySelector('#warehousePoolTableBody .pool-photo-add')).toBeNull();

    rowOf('Painting 26').querySelector('.pool-photo-btn').click();
    expect(safeModalShow).not.toHaveBeenCalled();
    expect(viewer().querySelector('.photo-viewer-title').textContent).toBe(`${FRAME} · Red`);
  });

  test('the item\'s no-colour photo comes first', async () => {
    PHOTOS.push({ outputItemName: FRAME, color: '', photoUrl: '/erp/pool-photo/9?v=80' });
    try {
      await App.Stock.loadWarehousePoolData();
      expect(rowOf('Painting 26').querySelector('.pool-photo-btn img').getAttribute('src')).toBe('/erp/pool-photo/9?v=80');
    } finally {
      PHOTOS.pop();
    }
  });

  test('the pool still comes up when the photos cannot be had', async () => {
    const call = Api.call;
    Api.call = jest.fn(async method => {
      if (method === 'getPoolItemPhotos') throw new Error('offline');
      return call(method);
    });
    await App.Stock.loadWarehousePoolData();
    expect(document.querySelectorAll('#warehousePoolTableBody tr.pool-process-row')).toHaveLength(3);
    expect(document.querySelectorAll('#warehousePoolTableBody .pool-photo-btn img')).toHaveLength(0);
  });

  test('the old one-photo-per-item answer is read as no photos, not as addresses', async () => {
    const call = Api.call;
    Api.call = jest.fn(async method => (method === 'getPoolItemPhotos'
      ? { success: true, data: { [FRAME.toLowerCase()]: '/erp/pool-photo/4?v=70' } }
      : call(method)));
    await App.Stock.loadWarehousePoolData();
    expect(document.querySelectorAll('#warehousePoolTableBody .pool-photo-btn img')).toHaveLength(0);
  });
});

describe('adding or changing a colour\'s photo', () => {
  test('the camera picks an image, shrinks it, saves it on that colour and shows it', async () => {
    await openBreakdown('PRC-PAINT');
    App.Utils.resizeImageFile = jest.fn(async () => 'data:image/jpeg;base64,NEW');
    comboOf('Blue').querySelector('.pool-photo-add').click();

    const input = document.querySelector('input[type="file"]');
    expect(input.accept).toBe('image/*');
    const file = new File(['x'], 'p.jpg', { type: 'image/jpeg' });
    Object.defineProperty(input, 'files', { value: [file] });
    input.dispatchEvent(new Event('change'));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(App.Utils.resizeImageFile).toHaveBeenCalledWith(file, 800);
    expect(mutations).toEqual([['setPoolItemPhoto', FRAME, 'data:image/jpeg;base64,NEW', 'Blue "Kit" 24']]);
    expect(comboOf('Blue').querySelector('.pool-photo-btn img').getAttribute('src')).toBe('/erp/pool-photo/5?v=71');
    // Red keeps its own.
    expect(comboOf('Red').querySelector('.pool-photo-btn img').getAttribute('src')).toBe('/erp/pool-photo/4?v=70');
    expect(App.Utils.showToast).toHaveBeenCalledWith(`Photo saved for ${FRAME} · Blue "Kit" 24.`);
  });

  test('a name with an apostrophe and a colour with quotes survive the round trip', async () => {
    await openBreakdown('PRC-PAINT');
    App.Stock.choosePoolPhoto = jest.fn();
    comboOf('Blue').querySelector('.pool-photo-add').click();
    const [encName, encColor] = App.Stock.choosePoolPhoto.mock.calls[0];
    expect(decodeURIComponent(encName)).toBe(FRAME);
    expect(decodeURIComponent(encColor)).toBe('Blue "Kit" 24');
  });

  test('Change photo in the viewer changes that colour\'s', async () => {
    await openBreakdown('PRC-PAINT');
    App.Stock.choosePoolPhoto = jest.fn();
    comboOf('Red').querySelector('.pool-photo-btn').click();
    viewer().querySelector('.photo-viewer-change').click();
    const [encName, encColor] = App.Stock.choosePoolPhoto.mock.calls[0];
    expect([decodeURIComponent(encName), decodeURIComponent(encColor)]).toEqual([FRAME, 'Red']);
  });

  test('a refusal is said and nothing changes', async () => {
    await openBreakdown('PRC-PAINT');
    Api.mutate = jest.fn(async () => ({ success: false, message: 'Item photo is not a valid image.' }));
    await App.Stock.savePoolPhoto(FRAME, 'Red', 'data:image/jpeg;base64,BAD');
    expect(App.Utils.showToast).toHaveBeenCalledWith('Item photo is not a valid image.', true);
    expect(comboOf('Red').querySelector('.pool-photo-btn img').getAttribute('src')).toBe('/erp/pool-photo/4?v=70');
  });
});
