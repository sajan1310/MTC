/**
 * Item photos on the desktop inspection checklist (asked 2026-10-29).
 *
 * A Photo column shows each item's Items Master photo; a click shows it
 * large (App.PhotoViewer, core.js) with "Change photo", and an item without
 * one offers "Add photo". The viewer lives inside the open dialog, so
 * Bootstrap's focus trap does not pull focus out of it, and Escape closes
 * the photo without closing the dialog.
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
  state: 'pending', result: null, previous: null, photoUrl: '', canSetPhoto: false, ...extra
});
const SEAT = item('seat', 'Maharaja-SEAT', { photoUrl: '/erp/item-photo/12?v=40', canSetPhoto: true });
const BAG = item('bag', 'BAG-KIT---WHITE', { canSetPhoto: true });
const FRAME = item('frame', 'Fitted Frame 14 inch Crysta', { size: '' });

function detail(items) {
  return {
    lot: { rowIdx: 7, lotNumber: 'LOT-PKG010-0047', processName: 'Packing Crysta', outputItemName: '14 inch Crysta',
      productName: '', status: 'In Progress', date: '29/10/2026', qty: 60, colors: [] },
    inspection: { status: 'in_progress', stage: 'partial', remarks: '' },
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
const viewer = () => document.querySelector('.photo-viewer-overlay');

describe('the Photo column', () => {
  test('a thumbnail, Add photo, or nothing for a pool row', async () => {
    await open([SEAT, BAG, FRAME]);
    expect(headers()).toEqual(['Ticked', 'Photo', 'Item', 'Size', 'Colour', 'Specification', 'Qty']);
    const img = rowOf('seat').querySelector('img.insp-photo-thumb');
    expect(img.getAttribute('src')).toBe('/erp/item-photo/12?v=40');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(rowOf('bag').querySelectorAll('td')[1].textContent.trim()).toBe('Add photo');
    expect(rowOf('frame').querySelectorAll('td')[1].textContent.trim()).toBe('');
  });

  test('no column on a sheet with nothing to photograph', async () => {
    await open([FRAME]);
    expect(headers()).toEqual(['Ticked', 'Item', 'Size', 'Colour', 'Specification', 'Qty']);
  });
});

describe('the photo, large', () => {
  test('opens inside the dialog with the item\'s name and Change photo; Escape closes only the photo', async () => {
    await open([SEAT, FRAME]);
    rowOf('seat').querySelector('.insp-photo-btn').click();
    const el = viewer();
    expect(el.parentNode.id).toBe('inspectionDetailModal');
    expect(el.hidden).toBe(false);
    expect(el.querySelector('img').getAttribute('src')).toBe('/erp/item-photo/12?v=40');
    expect(el.querySelector('.photo-viewer-title').textContent).toBe('Maharaja-SEAT · 20 inch');
    expect(el.querySelector('.photo-viewer-change').hidden).toBe(false);
    expect(document.activeElement).toBe(el.querySelector('.photo-viewer-close'));

    const dialogSawEscape = jest.fn();
    document.getElementById('inspectionDetailModal').addEventListener('keydown', dialogSawEscape);
    el.querySelector('.photo-viewer-close').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(el.hidden).toBe(true);
    expect(dialogSawEscape).not.toHaveBeenCalled();
  });
});

describe('adding or changing a photo', () => {
  const saved = (method, rowIdx, key) => ({
    success: true, message: 'Photo saved for BAG-KIT---WHITE 20 inch.',
    data: { key, itemName: 'BAG-KIT---WHITE', size: '20 inch', photoUrl: '/erp/item-photo/13?v=2' }
  });

  test('Add photo picks an image, shrinks it, saves it on the item and shows it', async () => {
    await open([SEAT, BAG], saved);
    App.Utils.resizeImageFile = jest.fn(async () => 'data:image/jpeg;base64,NEW');
    rowOf('bag').querySelector('button').click();

    const input = document.querySelector('#inspectionDetailModal input[type="file"]');
    expect(input.accept).toBe('image/*');
    const file = new File(['x'], 'p.jpg', { type: 'image/jpeg' });
    Object.defineProperty(input, 'files', { value: [file] });
    input.dispatchEvent(new Event('change'));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(App.Utils.resizeImageFile).toHaveBeenCalledWith(file, 800);
    expect(mutations).toEqual([['setInspectionItemPhoto', 7, 'bag', 'data:image/jpeg;base64,NEW']]);
    expect(rowOf('bag').querySelector('img.insp-photo-thumb').getAttribute('src')).toBe('/erp/item-photo/13?v=2');
    expect(App.Utils.showToast).toHaveBeenCalledWith('Photo saved for BAG-KIT---WHITE 20 inch.');
  });

  test('a refusal is said and nothing changes', async () => {
    await open([SEAT], () => ({ success: false, message: 'Item photo is not a valid image.' }));
    await App.Inspection.savePhoto('seat', 'data:image/jpeg;base64,BAD');
    expect(App.Utils.showToast).toHaveBeenCalledWith('Item photo is not a valid image.', true);
    expect(rowOf('seat').querySelector('img.insp-photo-thumb').getAttribute('src')).toBe('/erp/item-photo/12?v=40');
  });
});
