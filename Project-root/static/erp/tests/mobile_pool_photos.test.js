/**
 * A pool item's photos on the phone/tablet Warehouse Pool (asked 2026-11-02;
 * one per colour since 2026-11-24, migration 060).
 *
 * One photo per pool item and colour (getPoolItemPhotos, a list of
 * {outputItemName, color, photoUrl}): a Red frame and a Blue one each have
 * their own, the one the inspection checklist rows drawing on that bucket
 * show. Each bucket card shows its colour's photo beside the name, and a
 * tap shows it full screen with "Change photo"; a colour with none shows a
 * camera -- never another colour's photo -- that takes or picks one and
 * saves it on that colour (setPoolItemPhoto).
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
  // eslint-disable-next-line no-eval
  eval(code);
}

function sheet(id) {
  const at = VIEWS_HTML.indexOf(`id="${id}"`);
  const open = VIEWS_HTML.lastIndexOf('<div', at);
  return VIEWS_HTML.slice(open, VIEWS_HTML.indexOf('<!--', at));
}

const ROWS = [
  { rowIdx: 1, outputItemName: 'Painted Frame 26', processId: 'P1', productTag: '', color: 'Red', producedQty: 10, consumedQty: 0, availableQty: 10 },
  { rowIdx: 2, outputItemName: 'Painted Frame 26', processId: 'P1', productTag: 'Ladies', color: 'red', producedQty: 4, consumedQty: 0, availableQty: 4 },
  { rowIdx: 3, outputItemName: 'Painted Frame 26', processId: 'P1', productTag: '', color: 'Blue', producedQty: 5, consumedQty: 0, availableQty: 5 },
  { rowIdx: 4, outputItemName: 'Fitted Rim 20', processId: 'P2', productTag: '', color: '', producedQty: 8, consumedQty: 0, availableQty: 8 }
];
const PHOTOS = [
  { outputItemName: 'Painted Frame 26', color: 'Red', photoUrl: '/erp/pool-photo/4?v=70' },
  // The item's no-colour photo: only the bucket with no colour shows it.
  { outputItemName: 'Painted Frame 26', color: '', photoUrl: '/erp/pool-photo/8?v=75' }
];

function mount(photosReply) {
  jest.resetModules();
  global.fetch = jest.fn();
  document.body.innerHTML = `
    <div id="mapp-sheet-backdrop"></div>
    <div class="mb-sheet" id="sheet-pool">
      <div class="mb-search"><input type="search" id="pool-search"></div>
      <div class="mb-filter-chip-row" id="pool-filter-bar"></div>
      <div id="pool-list"></div>
    </div>
    ${sheet('sheet-photo-viewer')}
    <div class="mb-toast-stack" id="mapp-toast-stack"></div>`;
  loadAsGlobal('api.js', 'Api');
  loadAsGlobal('mobile.js', 'MApp');
  MApp.Sheet._stack = [];
  MApp.Paging._shown = {};
  MApp.Api.call = jest.fn(async method => (method === 'getPoolItemPhotos'
    ? photosReply()
    : { success: true, data: ROWS.map(r => ({ ...r })) }));
  MApp.Api.mutate = jest.fn();
}

const cards = () => [...document.querySelectorAll('#pool-list .mb-card')];
const cardOf = (name, sub) => cards().find(c => c.textContent.includes(name)
  && c.querySelectorAll('.mb-card-sub')[0].textContent.trim() === sub);

describe('the photo on each bucket', () => {
  test('each colour shows its own photo, product tags share it, and a colour with none shows a camera', async () => {
    mount(async () => ({ success: true, data: PHOTOS }));
    await MApp.Pool.load();
    ['Red', 'red · Ladies'].forEach(sub => {
      const img = cardOf('Painted Frame 26', sub).querySelector('.mb-item-thumb img');
      expect(img.getAttribute('src')).toBe('/erp/pool-photo/4?v=70&size=thumb');
      expect(img.getAttribute('loading')).toBe('lazy');
    });
    const blue = cardOf('Painted Frame 26', 'Blue');
    expect(blue.querySelector('.mb-item-thumb img')).toBeNull();
    expect(blue.querySelector('.mb-item-thumb-add').getAttribute('aria-label'))
      .toBe('Add a photo of Painted Frame 26 · Blue');
    expect(cardOf('Fitted Rim 20', 'No colour').querySelector('.mb-item-thumb-add').getAttribute('aria-label'))
      .toBe('Add a photo of Fitted Rim 20');
  });

  test('the buckets still come up when the photos cannot be had', async () => {
    mount(async () => { throw new Error('offline'); });
    await MApp.Pool.load();
    expect(cards()).toHaveLength(4);
    expect(document.querySelector('#pool-list .mb-item-thumb img')).toBeNull();
    expect(document.querySelectorAll('#pool-list .mb-item-thumb-add')).toHaveLength(4);
  });

  test('a tap shows the photo full screen, named with its colour, with Change photo', async () => {
    mount(async () => ({ success: true, data: PHOTOS }));
    await MApp.Pool.load();
    cardOf('Painted Frame 26', 'Red').querySelector('.mb-item-thumb').click();
    expect(document.getElementById('sheet-photo-viewer').classList.contains('open')).toBe(true);
    expect(document.getElementById('photo-viewer-img').getAttribute('src')).toBe('/erp/pool-photo/4?v=70');
    expect(document.getElementById('photo-viewer-title').textContent).toBe('Painted Frame 26 · Red');
    expect(document.getElementById('photo-viewer-footer').hidden).toBe(false);
  });
});

describe('adding or changing it', () => {
  test('the camera asks Take photo or gallery, saves the photo on that colour, and shows it there only', async () => {
    mount(async () => ({ success: true, data: PHOTOS }));
    await MApp.Pool.load();
    MApp.Picker.open = jest.fn(async () => ({ value: 'camera' }));
    const file = new File(['x'], 'p.jpg', { type: 'image/jpeg' });
    MApp.Util.pickImageFile = jest.fn(async () => file);
    MApp.Util.resizeImageToBase64 = jest.fn(async () => 'data:image/jpeg;base64,NEW');
    MApp.Api.mutate = jest.fn(async () => ({
      success: true, message: 'Photo saved for Painted Frame 26 · Blue.',
      data: { outputItemName: 'Painted Frame 26', color: 'Blue', photoUrl: '/erp/pool-photo/5?v=71' }
    }));

    cardOf('Painted Frame 26', 'Blue').querySelector('.mb-item-thumb-add').click();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(MApp.Picker.open.mock.calls[0][0].title).toBe('Add photo');
    expect(MApp.Picker.open.mock.calls[0][0].items.map(i => i.label)).toEqual(['Take photo', 'Choose from gallery']);
    expect(MApp.Util.pickImageFile).toHaveBeenCalledWith(true);
    expect(MApp.Util.resizeImageToBase64).toHaveBeenCalledWith(file, 800);
    expect(MApp.Api.mutate).toHaveBeenCalledWith('setPoolItemPhoto', 'Painted Frame 26', 'data:image/jpeg;base64,NEW', 'Blue');
    expect(cardOf('Painted Frame 26', 'Blue').querySelector('.mb-item-thumb img').getAttribute('src'))
      .toBe('/erp/pool-photo/5?v=71&size=thumb');
    expect(cardOf('Painted Frame 26', 'Red').querySelector('.mb-item-thumb img').getAttribute('src'))
      .toBe('/erp/pool-photo/4?v=70&size=thumb');
  });

  test('a bucket with no colour saves the item\'s no-colour photo', async () => {
    mount(async () => ({ success: true, data: PHOTOS }));
    await MApp.Pool.load();
    MApp.Picker.open = jest.fn(async () => ({ value: 'gallery' }));
    MApp.Util.pickImageFile = jest.fn(async () => new File(['x'], 'p.jpg', { type: 'image/jpeg' }));
    MApp.Util.resizeImageToBase64 = jest.fn(async () => 'data:image/jpeg;base64,NEW');
    MApp.Api.mutate = jest.fn(async () => ({
      success: true, message: 'Photo saved for Fitted Rim 20.',
      data: { outputItemName: 'Fitted Rim 20', color: '', photoUrl: '/erp/pool-photo/7?v=73' }
    }));
    await MApp.Pool.choosePhoto(ROWS[3]);
    expect(MApp.Api.mutate).toHaveBeenCalledWith('setPoolItemPhoto', 'Fitted Rim 20', 'data:image/jpeg;base64,NEW', '');
    expect(cardOf('Fitted Rim 20', 'No colour').querySelector('.mb-item-thumb img').getAttribute('src'))
      .toBe('/erp/pool-photo/7?v=73&size=thumb');
  });

  test('Change photo in the viewer starts the same choice', async () => {
    mount(async () => ({ success: true, data: PHOTOS }));
    await MApp.Pool.load();
    MApp.Picker.open = jest.fn(async () => null);
    cardOf('Painted Frame 26', 'Red').querySelector('.mb-item-thumb').click();
    document.getElementById('photo-viewer-change').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.getElementById('sheet-photo-viewer').classList.contains('open')).toBe(false);
    expect(MApp.Picker.open.mock.calls[0][0].title).toBe('Change photo');
    expect(MApp.Api.mutate).not.toHaveBeenCalled();
  });

  test('a refusal is said, and the card keeps its photo', async () => {
    mount(async () => ({ success: true, data: PHOTOS }));
    await MApp.Pool.load();
    MApp.Picker.open = jest.fn(async () => ({ value: 'gallery' }));
    MApp.Util.pickImageFile = jest.fn(async () => new File(['x'], 'p.jpg', { type: 'image/jpeg' }));
    MApp.Util.resizeImageToBase64 = jest.fn(async () => 'data:image/jpeg;base64,BAD');
    MApp.Api.mutate = jest.fn(async () => ({ success: false, message: 'Item photo is not a valid image.' }));
    MApp.Toast.error = jest.fn();

    await MApp.Pool.choosePhoto(ROWS[0]);

    expect(MApp.Util.pickImageFile).toHaveBeenCalledWith(false);
    expect(MApp.Toast.error).toHaveBeenCalledWith('Item photo is not a valid image.');
    expect(cardOf('Painted Frame 26', 'Red').querySelector('.mb-item-thumb img').getAttribute('src'))
      .toBe('/erp/pool-photo/4?v=70&size=thumb');
  });
});
