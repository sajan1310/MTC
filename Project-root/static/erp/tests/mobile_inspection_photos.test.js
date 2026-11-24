/**
 * Item photos on the phone/tablet inspection checklist (asked 2026-10-29).
 *
 * Each row shows its item's photo beside the box -- its Items Master item's,
 * or for a Warehouse Pool row its pool item's in its bucket's colour
 * (2026-11-02, 2026-11-24); a tap shows it
 * full screen with "Change photo", and a row whose item has no photo shows a
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
const FRAME = item('frame', 'Fitted Frame 14 inch Crysta', { size: '', photoSource: 'pool', canSetPhoto: true });
// A row neither Items Master nor the Warehouse Pool knows.
const LOOSE = item('loose', 'Loose Part', { size: '', photoSource: '' });

const body = () => document.getElementById('inspection-body');
const rowOf = key => [...body().querySelectorAll('[data-insp-row]')].find(r => r.dataset.inspRow === key);

async function open(items) {
  MApp.Api.call = jest.fn(async () => checklist(items));
  MApp.Api.mutate = jest.fn();
  await MApp.Inspection.openChecklist(7);
}

describe('photos on the checklist', () => {
  beforeEach(mount);

  test('a photo beside its item, a camera where an item or a pool row has none, an empty slot for a row neither knows', async () => {
    await open([SEAT, BAG, FRAME, LOOSE]);
    expect(body().querySelector('.mb-insp-list').classList.contains('mb-insp-with-photos')).toBe(true);
    const img = rowOf('seat').querySelector('.mb-insp-photo img');
    expect(img.getAttribute('src')).toBe('/erp/item-photo/12?v=40&size=thumb');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(rowOf('bag').querySelector('.mb-insp-photo-add').getAttribute('aria-label'))
      .toBe('Add a photo of BAG-KIT---WHITE · 20 inch');
    expect(rowOf('frame').querySelector('.mb-insp-photo-add').getAttribute('aria-label'))
      .toBe('Add a photo of Fitted Frame 14 inch Crysta');
    expect(rowOf('loose').querySelector('.mb-insp-photo-none')).not.toBeNull();
    expect(body().querySelector('.mb-insp-thead').textContent).toContain('Photo');
  });

  test('a sheet with nothing to photograph looks as it did', async () => {
    await open([LOOSE]);
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
    expect(rowOf('bag').querySelector('.mb-insp-photo img').getAttribute('src')).toBe('/erp/item-photo/13?v=2&size=thumb');
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
      expect(rowOf(key).querySelector('.mb-insp-photo img').getAttribute('src')).toBe('/erp/item-photo/12?v=41&size=thumb');
    });
  });

  test('a pool photo shows on every pool row of the item in that colour, any size, and on no other colour or Items Master row', async () => {
    const frameRed = item('frame#red', 'Fitted Frame 14 inch Crysta', { size: '', color: 'Red', photoSource: 'pool', photoColor: 'Red', canSetPhoto: true });
    const frameRed14 = item('frame#red14', 'Fitted Frame 14 inch Crysta', { size: '14 inch', color: 'red', photoSource: 'pool', photoColor: 'red', canSetPhoto: true });
    const frameBlue = item('frame#blue', 'Fitted Frame 14 inch Crysta', { size: '', color: 'Blue', photoSource: 'pool', photoColor: 'Blue', canSetPhoto: true });
    const sameNameItem = item('frame-item', 'Fitted Frame 14 inch Crysta', { size: '', photoSource: 'stock', canSetPhoto: true });
    await open([frameRed, frameRed14, frameBlue, FRAME, sameNameItem]);
    MApp.Api.mutate = jest.fn(async () => ({
      success: true, message: 'Photo saved for Fitted Frame 14 inch Crysta · Red.',
      data: { key: 'frame#red', itemName: 'Fitted Frame 14 inch Crysta', size: '', photoSource: 'pool', photoColor: 'Red', photoUrl: '/erp/pool-photo/3?v=9' }
    }));
    await MApp.Inspection.savePhoto('frame#red', 'data:image/jpeg;base64,NEW');
    ['frame#red', 'frame#red14'].forEach(key => {
      expect(rowOf(key).querySelector('.mb-insp-photo img').getAttribute('src')).toBe('/erp/pool-photo/3?v=9&size=thumb');
    });
    // Blue, the no-colour row and the Items Master item keep what they had.
    ['frame#blue', 'frame', 'frame-item'].forEach(key => {
      expect(rowOf(key).querySelector('.mb-insp-photo img')).toBeNull();
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
    expect(rowOf('seat').querySelector('.mb-insp-photo img').getAttribute('src')).toBe('/erp/item-photo/12?v=40&size=thumb');
  });
});

// The tablet's camera (2026-11-24: "overloads or is slow and sometimes it
// crashes"): one photo at a time, and a way back when Android closes the
// app to give the camera its memory.
describe('the camera on a busy tablet', () => {
  beforeEach(() => {
    mount();
    sessionStorage.clear();
  });

  const tick = () => new Promise(resolve => setTimeout(resolve, 0));

  test('a second photo is not started while one is still being shrunk and saved', async () => {
    await open([SEAT, BAG]);
    MApp.Picker.open = jest.fn(async () => ({ value: 'camera' }));
    MApp.Inspection._pickFile = jest.fn(async () => new File(['x'], 'p.jpg', { type: 'image/jpeg' }));
    let finish;
    MApp.Util.resizeImageToBase64 = jest.fn(() => new Promise(resolve => { finish = resolve; }));
    MApp.Api.mutate = jest.fn(async () => ({
      success: true, message: 'Photo saved.',
      data: { key: 'bag', itemName: 'BAG-KIT---WHITE', size: '20 inch', photoUrl: '/erp/item-photo/13?v=2' }
    }));

    const first = MApp.Inspection.choosePhoto('bag');
    await tick();
    const button = rowOf('bag').querySelector('[data-insp-photo]');
    expect(button.classList.contains('is-busy')).toBe(true);
    expect(button.disabled).toBe(true);

    await MApp.Inspection.choosePhoto('seat');
    expect(MApp.Picker.open).toHaveBeenCalledTimes(1);

    finish('data:image/jpeg;base64,NEW');
    await first;
    expect(MApp.Api.mutate).toHaveBeenCalledTimes(1);
    expect(MApp.Inspection._photoBusy).toBe(false);
    expect(rowOf('bag').querySelector('.mb-insp-photo img').getAttribute('src')).toBe('/erp/item-photo/13?v=2&size=thumb');
  });

  test('a photo that cannot be read frees the camera for the next one', async () => {
    await open([SEAT, BAG]);
    MApp.Picker.open = jest.fn(async () => ({ value: 'gallery' }));
    MApp.Inspection._pickFile = jest.fn(async () => new File(['x'], 'p.jpg', { type: 'image/jpeg' }));
    MApp.Util.resizeImageToBase64 = jest.fn(async () => { throw new Error('That file is not a readable image.'); });
    MApp.Toast.error = jest.fn();

    await MApp.Inspection.choosePhoto('bag');

    expect(MApp.Toast.error).toHaveBeenCalledWith('That file is not a readable image.');
    expect(MApp.Inspection._photoBusy).toBe(false);
    expect(rowOf('bag').querySelector('[data-insp-photo]').disabled).toBe(false);
  });

  test('while the camera is open, the lot and item are noted; coming back clears the note', async () => {
    await open([SEAT, BAG]);
    MApp.Picker.open = jest.fn(async () => ({ value: 'camera' }));
    let returnFromCamera;
    MApp.Inspection._pickFile = jest.fn(() => new Promise(resolve => { returnFromCamera = resolve; }));

    const choosing = MApp.Inspection.choosePhoto('bag');
    await tick();
    expect(JSON.parse(sessionStorage.getItem('mapp.inspectionCamera'))).toEqual(
      expect.objectContaining({ rowIdx: 7, item: 'BAG-KIT---WHITE' })
    );

    returnFromCamera(null); // backed out of the camera
    await choosing;
    expect(sessionStorage.getItem('mapp.inspectionCamera')).toBeNull();
  });

  test('when Android closed the app for the camera, it reopens on that lot and says to take the photo again', async () => {
    sessionStorage.setItem('mapp.inspectionCamera', JSON.stringify({ rowIdx: 7, item: 'BAG-KIT---WHITE', at: Date.now() - 60000 }));
    MApp.Inspection.open = jest.fn(async () => {});
    MApp.Inspection.openChecklist = jest.fn(async () => {});
    MApp.Toast.error = jest.fn();

    await MApp.Inspection.resumeAfterCamera();

    expect(MApp.Inspection.openChecklist).toHaveBeenCalledWith(7);
    expect(MApp.Toast.error).toHaveBeenCalledWith(
      'The app was closed while the camera was open, so the photo of BAG-KIT---WHITE was not saved. Take it again.'
    );
    expect(sessionStorage.getItem('mapp.inspectionCamera')).toBeNull();
  });

  test('a note left from long ago, or none at all, opens nothing', async () => {
    MApp.Inspection.openChecklist = jest.fn(async () => {});
    sessionStorage.setItem('mapp.inspectionCamera', JSON.stringify({ rowIdx: 7, item: 'X', at: Date.now() - 60 * 60 * 1000 }));
    await MApp.Inspection.resumeAfterCamera();
    await MApp.Inspection.resumeAfterCamera();
    expect(MApp.Inspection.openChecklist).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('mapp.inspectionCamera')).toBeNull();
  });

  test('backing out of the camera ends the pick, and leaves no input behind', async () => {
    const picking = MApp.Util.pickImageFile(true);
    const input = document.querySelector('input[type="file"][capture="environment"]');
    expect(input).not.toBeNull();
    input.dispatchEvent(new Event('cancel'));
    await expect(picking).resolves.toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });
});
