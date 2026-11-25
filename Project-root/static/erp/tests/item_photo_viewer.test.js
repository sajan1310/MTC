/**
 * An item's photo opens filling the window on the desktop too (asked
 * 2026-11-25: "enable user to view the image in full window in desktop
 * version as well.. currently user cannot view the clicked image on desktop
 * UI").
 *
 * The phone's Items list and item form open a photo in MApp.PhotoViewer.
 * On the desktop the Items list's thumbnail sat inside the name cell, whose
 * click opens the Edit dialog, and the dialog's preview did nothing. Now
 * both open App.PhotoViewer with the whole photo -- the list shows the small
 * copy (photoThumbUrl) -- and the name still opens Edit.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const PARTIAL = f => fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', f), 'utf8');

const PHOTO = '/erp/item-photo/12?v=3';
const WITH_PHOTO = {
  name: 'Hub Front Shocker', size: '20 inch', remarks: '', narration: '', specification: '',
  baseUnit: 'Pcs', purchaseUnit: 'Pcs', weightPerBaseUnit: 0, image: PHOTO,
  vendors: [], unpricedVendors: []
};
const NO_PHOTO = { ...WITH_PHOTO, name: 'Axle', size: '', image: '' };
const copy = item => JSON.parse(JSON.stringify(item));

function loadItems() {
  eval([
    read('api.js').replace(/^const Api = /m, 'global.Api = '),
    'global.escapeHtml = escapeHtml;',
    'global.toNumber = toNumber;',
    'global.formatCurrency = formatCurrency;'
  ].join('\n'));
  eval(read('print-templates.js').replace(/^const PrintTemplates = /m, 'global.PrintTemplates = '));
  eval([
    read('core.js').replace(/^const App = /m, 'global.App = '),
    'global.$ = $;',
    'global.$$ = $$;',
    'global.safeModalShow = safeModalShow;',
    'global.safeModalHide = safeModalHide;',
    'global.setDisabled = setDisabled;'
  ].join('\n'));

  // items.js wires the table and form up on DOMContentLoaded, which this
  // document fired long ago -- so its handler is caught and run here.
  const ready = [];
  const spy = jest.spyOn(document, 'addEventListener').mockImplementation((type, fn, opts) => {
    if (type === 'DOMContentLoaded') ready.push(fn);
    else EventTarget.prototype.addEventListener.call(document, type, fn, opts);
  });
  try {
    eval(read('items.js'));
  } finally {
    spy.mockRestore();
  }
  ready.forEach(fn => fn());
}

const viewer = () => document.querySelector('.photo-viewer-overlay');
const shown = () => viewer() && !viewer().hidden;
const click = el => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const rowOf = name => [...document.querySelectorAll('#itemTableBody tr')]
  .find(tr => decodeURIComponent(tr.dataset.rowName) === name);

beforeEach(() => {
  jest.resetModules();
  document.body.innerHTML = PARTIAL('items.html');
  loadItems();
  App.State.globalItems = [copy(WITH_PHOTO), copy(NO_PHOTO)];
  App.State.filteredItems = [...App.State.globalItems];
  App.Item.loadProcessesForItem = jest.fn();
  document.getElementById('itemTableBody').innerHTML =
    App.State.globalItems.map(item => App.Item.rowHtml(item)).join('');
});

afterEach(() => {
  delete global.App;
});

describe('the Items list', () => {
  test('a photo is a button, and the list shows its small copy', () => {
    const btn = rowOf('Hub Front Shocker').querySelector('.item-photo-btn');
    expect(btn).not.toBeNull();
    expect(btn.getAttribute('aria-label')).toBe('View photo of Hub Front Shocker · 20 inch');
    expect(btn.querySelector('img').getAttribute('src')).toBe(`${PHOTO}&size=thumb`);
  });

  test('clicking it opens the whole photo filling the window, not the Edit dialog', () => {
    const edit = jest.spyOn(App.Item, 'openEditModal');
    click(rowOf('Hub Front Shocker').querySelector('.item-photo-btn img'));

    expect(shown()).toBe(true);
    expect(viewer().querySelector('img').getAttribute('src')).toBe(PHOTO);
    expect(viewer().querySelector('.photo-viewer-title').textContent).toBe('Hub Front Shocker · 20 inch');
    expect(viewer().querySelector('.photo-viewer-change').hidden).toBe(true);
    expect(edit).not.toHaveBeenCalled();
  });

  test('the name beside it still opens the Edit dialog', () => {
    const edit = jest.spyOn(App.Item, 'openEditModal').mockImplementation(() => {});
    click(rowOf('Hub Front Shocker').querySelector('.item-cell-name strong'));

    expect(edit).toHaveBeenCalledWith('Hub Front Shocker', '20 inch');
    expect(shown()).toBeFalsy();
  });

  test('an item without a photo keeps its placeholder, which opens nothing', () => {
    const row = rowOf('Axle');
    expect(row.querySelector('.item-photo-btn')).toBeNull();
    expect(row.querySelector('.item-thumb-placeholder')).not.toBeNull();
  });
});

describe('the item dialog', () => {
  const viewBtn = () => document.getElementById('itemPhotoViewBtn');

  test('the saved photo opens filling the window', () => {
    App.Item.openEditModal('Hub Front Shocker', '20 inch');
    expect(viewBtn().style.display).toBe('');

    click(viewBtn());
    expect(shown()).toBe(true);
    expect(viewer().querySelector('img').getAttribute('src')).toBe(PHOTO);
    expect(viewer().querySelector('.photo-viewer-title').textContent).toBe('Hub Front Shocker · 20 inch');
  });

  test('a photo just chosen opens too, named from the form', () => {
    App.Item.openCreateModal();
    document.getElementById('formItemName').value = 'Brake Shoe';
    const chosen = 'data:image/jpeg;base64,AAAA';
    App.Item.setPhotoPreview(chosen);

    click(viewBtn());
    expect(viewer().querySelector('img').getAttribute('src')).toBe(chosen);
    expect(viewer().querySelector('.photo-viewer-title').textContent).toBe('Brake Shoe');
  });

  test('with no photo there is nothing to open', () => {
    App.Item.openEditModal('Axle', '');
    expect(viewBtn().style.display).toBe('none');
    expect(document.getElementById('itemPhotoPreviewPlaceholder').style.display).toBe('');

    App.Item.setPhotoPreview(PHOTO);
    App.Item.setPhotoPreview('');
    expect(viewBtn().style.display).toBe('none');
  });
});
