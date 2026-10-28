/**
 * Item photos on the phone and the tablet.
 *
 * The item form had one plain <input type="file" accept="image/*">, and Chrome
 * on Android 14 and later answers that with the gallery picker alone: there
 * was no way to the camera. The form now has a Take photo input with
 * capture="environment" beside a Gallery one, and Remove photo. The Items
 * list never showed a photo at all. It shows one beside each item that has
 * one, and a tap on it, or on the form's own, opens it full screen.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const VIEWS = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', 'mobile_views.html'), 'utf8');

// One sheet's markup as mobile.html ships it: from its opening <div> to the
// </div> that closes it at the start of a line (CRLF in a Windows checkout).
const sheet = id => {
  const m = VIEWS.match(new RegExp(`<div class="mb-sheet[^"]*" id="${id}"[\\s\\S]*?\\r?\\n</div>\\r?\\n`));
  if (!m) throw new Error(`no sheet #${id} in mobile_views.html`);
  return m[0];
};

const PHOTO = 'data:image/jpeg;base64,' + 'A'.repeat(200);
const OTHER = 'data:image/jpeg;base64,' + 'B'.repeat(200);
const ITEMS = [
  { name: 'Hub Axle', size: '6"', narration: '', baseUnit: 'Pcs', image: PHOTO, vendors: [], unpricedVendors: [] },
  { name: 'Spoke Nipple', size: '', narration: '', baseUnit: 'Pcs', image: '', vendors: [], unpricedVendors: [] }
];
const copy = v => JSON.parse(JSON.stringify(v));
const isOpen = id => document.getElementById(id).classList.contains('open');
const camera = () => new File(['x'], 'camera.jpg', { type: 'image/jpeg' });

// The shrink of a photo just picked, settled by the test.
function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

beforeEach(() => {
  jest.resetModules();
  global.fetch = jest.fn();
  document.body.innerHTML = '<div id="mapp-sheet-backdrop"></div>' +
    sheet('sheet-items-lookup') + sheet('sheet-item-form') + sheet('sheet-photo-viewer') +
    '<div class="mb-select-bar" id="mapp-select-bar"><span id="mapp-select-count"></span></div>';
  // eslint-disable-next-line no-eval
  eval(read('api.js').replace(/^const Api = /m, 'global.Api = '));
  // eslint-disable-next-line no-eval
  eval(read('mobile.js').replace(/^const MApp = /m, 'global.MApp = '));
  MApp.Sheet._stack = [];
  MApp.Select._state = null;
});

describe('the item form', () => {
  const field = () => document.getElementById('item-form-photo');
  const button = label => [...field().querySelectorAll('button')].find(b => b.textContent.trim() === label);

  test('offers the camera and the gallery, each through its own input', () => {
    MApp.Items.openForm(null);
    const cameraInput = document.getElementById('item-form-photo-camera');
    const galleryInput = document.getElementById('item-form-photo-gallery');
    expect(cameraInput.getAttribute('accept')).toBe('image/*');
    expect(cameraInput.getAttribute('capture')).toBe('environment');
    expect(galleryInput.getAttribute('accept')).toBe('image/*');
    expect(galleryInput.hasAttribute('capture')).toBe(false);

    const opened = [];
    cameraInput.addEventListener('click', () => opened.push('camera'));
    galleryInput.addEventListener('click', () => opened.push('gallery'));
    button('Take photo').click();
    button('Gallery').click();
    expect(opened).toEqual(['camera', 'gallery']);

    // No photo yet: nothing to view or remove.
    expect(document.getElementById('item-form-photo-preview')).toBeNull();
    expect(button('Remove photo')).toBeUndefined();
  });

  test('shows the photo an item has, and Remove photo saves it without one', async () => {
    let sent = null;
    MApp.Util.mutateSimple = jest.fn(async (method, args) => { sent = args[0]; return { success: false }; });
    MApp.Items.openForm(copy(ITEMS[0]));
    expect(document.getElementById('item-form-photo-preview').src).toBe(PHOTO);

    button('Remove photo').click();

    expect(document.getElementById('item-form-photo-preview')).toBeNull();
    await MApp.Items.saveItem();
    // saveItem stores a blank photo for a missing itemImage.
    expect(sent.itemImage).toBeUndefined();
  });

  test('a picked photo is shrunk, then shown', async () => {
    MApp.Util.resizeImageToBase64 = jest.fn(async () => OTHER);
    MApp.Items.openForm(copy(ITEMS[1]));

    await MApp.Items.onPhotoChange(camera());

    expect(MApp.Util.resizeImageToBase64).toHaveBeenCalledWith(expect.any(File), 800);
    expect(document.getElementById('item-form-photo-preview').src).toBe(OTHER);
    expect(button('Remove photo')).toBeDefined();
  });

  test('a photo still shrinking when Save is tapped is saved with the item', async () => {
    const shrink = deferred();
    MApp.Util.resizeImageToBase64 = jest.fn(() => shrink.promise);
    let sent = null;
    MApp.Util.mutateSimple = jest.fn(async (method, args) => { sent = args[0]; return { success: false }; });
    MApp.Items.openForm(copy(ITEMS[1]));
    MApp.Items.onPhotoChange(camera());

    const saving = MApp.Items.saveItem();
    await Promise.resolve();
    expect(document.getElementById('item-form-save-btn').disabled).toBe(true);
    expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();

    shrink.resolve(OTHER);
    await saving;
    expect(sent.itemImage).toBe(OTHER);
  });

  test('a photo that finishes shrinking after the form moved to another item is dropped', async () => {
    const shrink = deferred();
    MApp.Util.resizeImageToBase64 = jest.fn(() => shrink.promise);
    MApp.Items.openForm(copy(ITEMS[1]));
    const done = MApp.Items.onPhotoChange(camera());

    MApp.Items.openForm(copy(ITEMS[0]));
    shrink.resolve(OTHER);
    await done;

    expect(MApp.Items.photoBase64).toBe(PHOTO);
    expect(document.getElementById('item-form-photo-preview').src).toBe(PHOTO);
  });

  test('Remove photo while one is still shrinking keeps it removed', async () => {
    const shrink = deferred();
    MApp.Util.resizeImageToBase64 = jest.fn(() => shrink.promise);
    MApp.Items.openForm(copy(ITEMS[0]));
    const done = MApp.Items.onPhotoChange(camera());

    button('Remove photo').click();
    shrink.resolve(OTHER);
    await done;

    expect(MApp.Items.photoBase64).toBeNull();
    expect(document.getElementById('item-form-photo-preview')).toBeNull();
  });

  test('a tap on the photo opens it full screen, over the form', () => {
    MApp.Items.openForm(copy(ITEMS[0]));
    document.querySelector('#item-form-photo .mb-item-photo-preview').click();

    expect(isOpen('sheet-photo-viewer')).toBe(true);
    expect(document.getElementById('photo-viewer-img').src).toBe(PHOTO);
    expect(document.getElementById('photo-viewer-title').textContent).toBe('Hub Axle · 6"');
    expect(MApp.Sheet._stack.map(s => s.id)).toEqual(['sheet-item-form', 'sheet-photo-viewer']);
  });
});

describe('the Items list', () => {
  async function openList() {
    MApp.Api.call = jest.fn(async method => (method === 'getItemsData'
      ? { success: true, data: copy(ITEMS) }
      : { success: true, data: [] }));
    await MApp.Items.openLookupSheet();
  }
  const cards = () => [...document.querySelectorAll('#items-lookup-list .mb-card')];

  test('shows the photo beside an item that has one, and nothing beside one that has not', async () => {
    await openList();
    const [withPhoto, without] = cards();

    const thumb = withPhoto.querySelector('.mb-item-thumb');
    expect(thumb.querySelector('img').src).toBe(PHOTO);
    expect(thumb.getAttribute('aria-label')).toBe('View photo of Hub Axle');
    expect(without.querySelector('.mb-item-thumb')).toBeNull();
  });

  test('a tap on a photo opens it full screen, and a tap on it there closes it', async () => {
    await openList();
    cards()[0].querySelector('.mb-item-thumb').click();

    expect(isOpen('sheet-photo-viewer')).toBe(true);
    expect(document.getElementById('photo-viewer-img').src).toBe(PHOTO);
    expect(document.getElementById('photo-viewer-img').alt).toBe('Photo of Hub Axle · 6"');
    expect(document.getElementById('photo-viewer-title').textContent).toBe('Hub Axle · 6"');
    // The photo, not the item's form.
    expect(isOpen('sheet-item-form')).toBe(false);

    document.querySelector('#sheet-photo-viewer .mb-sheet-body').click();
    expect(isOpen('sheet-photo-viewer')).toBe(false);
    expect(MApp.Sheet._stack.map(s => s.id)).toEqual(['sheet-items-lookup']);
  });

  test('while selecting, a tap on a photo selects its item instead', async () => {
    await openList();
    jest.useFakeTimers();
    try {
      cards()[1].dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
      jest.advanceTimersByTime(MApp.Select.LONG_PRESS_MS);
      expect(MApp.Select.isActive('items')).toBe(true);

      cards()[0].querySelector('.mb-item-thumb').click();

      expect(isOpen('sheet-photo-viewer')).toBe(false);
      expect([...MApp.Select._state.selected].sort()).toEqual([0, 1]);
    } finally {
      jest.useRealTimers();
    }
  });
});

test('the viewer sits above every other sheet, the picker included', () => {
  const css = read('mobile_styles.css');
  const z = selector => Number(css.match(new RegExp(`\\${selector} \\{ z-index: (\\d+); \\}`))[1]);
  expect(z('.mb-photo-viewer')).toBeGreaterThan(z('.mb-picker-screen'));
});
