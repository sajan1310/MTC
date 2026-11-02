/**
 * A pool item's photo on the desktop Warehouse Pool (asked 2026-11-02).
 *
 * One photo per pool item (getPoolItemPhotos, by Output Item Name), every
 * colour of it: the same one its inspection checklist rows show. Each
 * Process row shows its Output Item's photo, and so does the breakdown
 * dialog's title; a click shows it large (App.PhotoViewer) with "Change
 * photo", and an item with none offers a camera. The photo sits inside the
 * row that opens the breakdown, so a click on it must not open that too.
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

const PAINTING = { processId: 'PRC-PAINT', processName: 'Painting 26', outputItemName: "Painted Frame 26 'Gloss'", sequence: 1, active: true };
const FITTING = { processId: 'PRC-FIT', processName: 'Rim Fitting 20', outputItemName: 'Fitted Rim 20', sequence: 2, active: true };

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
      if (method === 'getWarehousePoolData') return { success: true, data: [] };
      if (method === 'getAllProcessColorGroups') return { success: true, data: {} };
      if (method === 'getPoolItemPhotos') return { success: true, data: { "painted frame 26 'gloss'": '/erp/pool-photo/4?v=70' } };
      return { success: false };
    }),
    mutate: jest.fn(async (...args) => {
      mutations.push(args);
      return {
        success: true, message: 'Photo saved for Fitted Rim 20.',
        data: { outputItemName: 'Fitted Rim 20', photoUrl: '/erp/pool-photo/5?v=71' }
      };
    })
  };
  loadAsGlobal('stock.js');
  App.State.globalProcesses = [PAINTING, FITTING];
});

const rowOf = name => [...document.querySelectorAll('#warehousePoolTableBody tr.pool-process-row')]
  .find(tr => tr.textContent.includes(name));
const viewer = () => document.querySelector('.photo-viewer-overlay');

describe('the photo beside each Process', () => {
  test('loaded with the pool: a thumbnail where the Output Item has a photo, a camera where it has none', async () => {
    await App.Stock.loadWarehousePoolData();
    expect(Api.call).toHaveBeenCalledWith('getPoolItemPhotos');
    const img = rowOf('Painting 26').querySelector('.pool-photo-btn img');
    expect(img.getAttribute('src')).toBe('/erp/pool-photo/4?v=70');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(rowOf('Rim Fitting 20').querySelector('.pool-photo-add').getAttribute('aria-label'))
      .toBe('Add a photo of Fitted Rim 20');
  });

  test('the pool still comes up when the photos cannot be had', async () => {
    const call = Api.call;
    Api.call = jest.fn(async method => {
      if (method === 'getPoolItemPhotos') throw new Error('offline');
      return call(method);
    });
    await App.Stock.loadWarehousePoolData();
    expect(document.querySelectorAll('#warehousePoolTableBody tr.pool-process-row')).toHaveLength(2);
    expect(document.querySelectorAll('#warehousePoolTableBody .pool-photo-add')).toHaveLength(2);
  });

  test('a click shows it large with Change photo, and does not open the breakdown', async () => {
    await App.Stock.loadWarehousePoolData();
    rowOf('Painting 26').querySelector('.pool-photo-btn').click();
    expect(safeModalShow).not.toHaveBeenCalled();
    expect(viewer().hidden).toBe(false);
    expect(viewer().querySelector('img').getAttribute('src')).toBe('/erp/pool-photo/4?v=70');
    expect(viewer().querySelector('.photo-viewer-title').textContent).toBe("Painted Frame 26 'Gloss'");
    expect(viewer().querySelector('.photo-viewer-change').hidden).toBe(false);
  });

  test('the breakdown dialog shows it in its title', async () => {
    await App.Stock.loadWarehousePoolData();
    App.Stock.openWarehousePoolProcessModal('PRC-PAINT');
    const title = document.getElementById('warehousePoolProcessModalTitle');
    expect(title.querySelector('.pool-photo-btn img').getAttribute('src')).toBe('/erp/pool-photo/4?v=70');
    expect(title.textContent).toContain('Warehouse Pool: Painting 26');
  });
});

describe('adding or changing it', () => {
  test('the camera picks an image, shrinks it, saves it on the pool item and shows it', async () => {
    await App.Stock.loadWarehousePoolData();
    App.Utils.resizeImageFile = jest.fn(async () => 'data:image/jpeg;base64,NEW');
    rowOf('Rim Fitting 20').querySelector('.pool-photo-add').click();
    expect(safeModalShow).not.toHaveBeenCalled();

    const input = document.querySelector('input[type="file"]');
    expect(input.accept).toBe('image/*');
    const file = new File(['x'], 'p.jpg', { type: 'image/jpeg' });
    Object.defineProperty(input, 'files', { value: [file] });
    input.dispatchEvent(new Event('change'));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(App.Utils.resizeImageFile).toHaveBeenCalledWith(file, 800);
    expect(mutations).toEqual([['setPoolItemPhoto', 'Fitted Rim 20', 'data:image/jpeg;base64,NEW']]);
    expect(rowOf('Rim Fitting 20').querySelector('.pool-photo-btn img').getAttribute('src')).toBe('/erp/pool-photo/5?v=71');
    expect(App.Utils.showToast).toHaveBeenCalledWith('Photo saved for Fitted Rim 20.');
  });

  test('a name with an apostrophe survives the round trip', async () => {
    await App.Stock.loadWarehousePoolData();
    App.Stock.choosePoolPhoto = jest.fn();
    rowOf('Painting 26').querySelector('.pool-photo-btn').click();
    viewer().querySelector('.photo-viewer-change').click();
    expect(decodeURIComponent(App.Stock.choosePoolPhoto.mock.calls[0][0])).toBe("Painted Frame 26 'Gloss'");
  });

  test('a refusal is said and nothing changes', async () => {
    await App.Stock.loadWarehousePoolData();
    Api.mutate = jest.fn(async () => ({ success: false, message: 'Item photo is not a valid image.' }));
    await App.Stock.savePoolPhoto("Painted Frame 26 'Gloss'", 'data:image/jpeg;base64,BAD');
    expect(App.Utils.showToast).toHaveBeenCalledWith('Item photo is not a valid image.', true);
    expect(rowOf('Painting 26').querySelector('.pool-photo-btn img').getAttribute('src')).toBe('/erp/pool-photo/4?v=70');
  });
});
