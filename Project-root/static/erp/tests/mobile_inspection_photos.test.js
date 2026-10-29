/**
 * Item photos on the phone/tablet inspection checklist (asked 2026-10-29).
 *
 * Each row shows its Items Master photo beside the box; a tap shows it full
 * screen with "Change photo", and a row whose item has no photo shows a
 * camera to add one. The row is the box's label, so a tap on the photo must
 * never tick the item. A sheet with nothing to photograph looks as before.
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
    ${sheet('sheet-photo-viewer')}
    <div class="mb-toast-stack" id="mapp-toast-stack"></div>`;
  loadAsGlobal('api.js', 'Api');
  loadAsGlobal('mobile.js', 'MApp');
  MApp.Sheet._stack = [];
}

const item = (key, itemName, extra = {}) => ({
  key, itemName, size: '20 inch', color: '', narration: '', qty: 10, unit: 'Pcs',
  fingerprint: '10|', state: 'pending', result: null, previous: null,
  photoUrl: '', canSetPhoto: false, ...extra
});

function checklist(items) {
  return {
    success: true,
    data: {
      lot: { rowIdx: 7, lotNumber: 'LOT-PKG010-0047', date: '29/10/2026', processName: 'Packing Crysta',
        outputItemName: '14 inch Crysta', productName: '', qty: 60, status: 'In Progress', colors: [] },
      inspection: { status: 'in_progress', remarks: '', stage: 'partial' },
      items: items.map(i => ({ ...i })),
      removed: [],
      summary: { total: items.length, checked: 0, complete: false },
      inspector: { name: 'Store Keeper', roleLabel: 'Storekeeper' },
      canAcknowledge: false,
      canReturn: false
    }
  };
}

const SEAT = item('seat', 'Maharaja-SEAT', { photoUrl: '/erp/item-photo/12?v=40', canSetPhoto: true });
const BAG = item('bag', 'BAG-KIT---WHITE', { canSetPhoto: true });
const FRAME = item('frame', 'Fitted Frame 14 inch Crysta', { size: '' });

const body = () => document.getElementById('inspection-body');
const rowOf = key => [...body().querySelectorAll('[data-insp-row]')].find(r => r.dataset.inspRow === key);

async function open(items) {
  MApp.Api.call = jest.fn(async () => checklist(items));
  MApp.Api.mutate = jest.fn();
  await MApp.Inspection.openChecklist(7);
}

describe('photos on the checklist', () => {
  beforeEach(mount);

  test('a photo beside its item, a camera where the item has none, an empty slot for a pool row', async () => {
    await open([SEAT, BAG, FRAME]);
    expect(body().querySelector('.mb-insp-list').classList.contains('mb-insp-with-photos')).toBe(true);
    const img = rowOf('seat').querySelector('.mb-insp-photo img');
    expect(img.getAttribute('src')).toBe('/erp/item-photo/12?v=40');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(rowOf('bag').querySelector('.mb-insp-photo-add').getAttribute('aria-label'))
      .toBe('Add a photo of BAG-KIT---WHITE · 20 inch');
    expect(rowOf('frame').querySelector('.mb-insp-photo-none')).not.toBeNull();
    expect(body().querySelector('.mb-insp-thead').textContent).toContain('Photo');
  });

  test('a sheet with nothing to photograph looks as it did', async () => {
    await open([FRAME]);
    expect(body().querySelector('.mb-insp-photo')).toBeNull();
    expect(body().querySelector('.mb-insp-list').classList.contains('mb-insp-with-photos')).toBe(false);
    expect(body().querySelector('.mb-insp-thead').textContent).not.toContain('Photo');
  });

  test('a tap on the photo shows it full screen, with Change photo, and does not tick the item', async () => {
    await open([SEAT, BAG]);
    rowOf('seat').querySelector('.mb-insp-photo').click();
    expect(document.getElementById('sheet-photo-viewer').classList.contains('open')).toBe(true);
    expect(document.getElementById('photo-viewer-img').getAttribute('src')).toBe('/erp/item-photo/12?v=40');
    expect(document.getElementById('photo-viewer-title').textContent).toBe('Maharaja-SEAT · 20 inch');
    expect(document.getElementById('photo-viewer-footer').hidden).toBe(false);
    expect(rowOf('seat').querySelector('.mb-insp-check').checked).toBe(false);
    expect(MApp.Api.mutate).not.toHaveBeenCalled();
  });

  test('the Items list\'s viewer keeps no Change photo button', async () => {
    MApp.PhotoViewer.open('data:image/png;base64,AAA', 'Item');
    expect(document.getElementById('photo-viewer-footer').hidden).toBe(true);
  });
});

describe('adding or changing a photo', () => {
  beforeEach(mount);

  test('the camera asks Take photo or gallery, and the photo is saved on the item', async () => {
    await open([SEAT, BAG]);
    MApp.Picker.open = jest.fn(async () => ({ value: 'camera' }));
    const file = new File(['x'], 'p.jpg', { type: 'image/jpeg' });
    MApp.Inspection._pickFile = jest.fn(async () => file);
    MApp.Util.resizeImageToBase64 = jest.fn(async () => 'data:image/jpeg;base64,NEW');
    MApp.Api.mutate = jest.fn(async () => ({
      success: true, message: 'Photo saved for BAG-KIT---WHITE 20 inch.',
      data: { key: 'bag', itemName: 'BAG-KIT---WHITE', size: '20 inch', photoUrl: '/erp/item-photo/13?v=2' }
    }));

    rowOf('bag').querySelector('.mb-insp-photo-add').click();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(MApp.Picker.open.mock.calls[0][0].items.map(i => i.label)).toEqual(['Take photo', 'Choose from gallery']);
    expect(MApp.Inspection._pickFile).toHaveBeenCalledWith(true);
    expect(MApp.Util.resizeImageToBase64).toHaveBeenCalledWith(file, 800);
    expect(MApp.Api.mutate).toHaveBeenCalledWith('setInspectionItemPhoto', 7, 'bag', 'data:image/jpeg;base64,NEW');
    expect(rowOf('bag').querySelector('.mb-insp-photo img').getAttribute('src')).toBe('/erp/item-photo/13?v=2');
    expect(rowOf('bag').querySelector('.mb-insp-check').checked).toBe(false);
  });

  test('a new photo shows on every row of the same item and size', async () => {
    const seatRed = item('seat#2', 'Maharaja-SEAT', { color: 'Red', photoUrl: '/erp/item-photo/12?v=40', canSetPhoto: true });
    await open([SEAT, seatRed]);
    MApp.Api.mutate = jest.fn(async () => ({
      success: true, message: 'Photo saved.',
      data: { key: 'seat', itemName: 'Maharaja-SEAT', size: '20 inch', photoUrl: '/erp/item-photo/12?v=41' }
    }));
    await MApp.Inspection.savePhoto('seat', 'data:image/jpeg;base64,NEW');
    ['seat', 'seat#2'].forEach(key => {
      expect(rowOf(key).querySelector('.mb-insp-photo img').getAttribute('src')).toBe('/erp/item-photo/12?v=41');
    });
  });

  test('Change photo in the viewer starts the same choice', async () => {
    await open([SEAT]);
    MApp.Picker.open = jest.fn(async () => null);
    rowOf('seat').querySelector('.mb-insp-photo').click();
    document.getElementById('photo-viewer-change').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.getElementById('sheet-photo-viewer').classList.contains('open')).toBe(false);
    expect(MApp.Picker.open.mock.calls[0][0].title).toBe('Change photo');
  });

  test('a refusal is said, and the row keeps its photo', async () => {
    await open([SEAT]);
    MApp.Api.mutate = jest.fn(async () => ({ success: false, message: 'Item photo is not a valid image.' }));
    MApp.Toast.error = jest.fn();
    await MApp.Inspection.savePhoto('seat', 'data:image/jpeg;base64,BAD');
    expect(MApp.Toast.error).toHaveBeenCalledWith('Item photo is not a valid image.');
    expect(rowOf('seat').querySelector('.mb-insp-photo img').getAttribute('src')).toBe('/erp/item-photo/12?v=40');
  });
});
