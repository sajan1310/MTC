/**
 * The optional Lot Reference on desktop's Log Production Lot form
 * (lot-reference.js): the owner asked for only related lots, a dropdown
 * searchable by lot number, and a side window (2026-10-30).
 *
 * What matters here is what the form sends: lotRefs goes only when the
 * references loaded, so a failed load can't wipe saved connections, and the
 * field must never hold up a save. Which lots are related is the server's
 * rule, tested in tests/erp/test_lot_reference.py.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const lot = o => ({
  rowIdx: 1, lotNumber: 'LOT-FTD003-0043', outputItemName: 'Fitted Frame 14 inch Crysta S/Rim',
  processName: 'Fitting Frame 14 inch Crysta', processType: 'Fitting Frame', sequence: 3,
  status: 'Completed', qty: 25, colors: ['Blue / Black'], assignedTo: 'Amarjeet',
  dateLabel: 'Completed', date: '27/10/2026', dateRaw: '2026-10-27', deleted: false, ...o
});

const related = o => ({
  applicable: true, sequence: 3, size: '14 inch', model: 'CRYSTA',
  lots: [lot(), lot({ rowIdx: 2, lotNumber: 'LOT-FTD003-0042', status: 'In Progress', dateLabel: 'Lot date', date: '21/10/2026' })],
  references: [], ...o
});

const detail = o => ({
  lot: {
    ...lot(), lotDate: '20/10/2026', completedOn: '27/10/2026', receivedQty: 0, balanceQty: 0,
    remarks: '', materials: []
  },
  receipts: [], references: [], ...o
});

function load() {
  global.App = { Utils: {} };
  eval([
    fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8'),
    'global.escapeHtml = escapeHtml;',
    'global.formatQty = formatQty;',
  ].join('\n'));
  eval(fs.readFileSync(path.join(__dirname, '..', 'lot-reference.js'), 'utf8'));
}

const input = () => document.getElementById('productionLotRefs');
const select = () => document.querySelector('.lot-ref-select');
const scope = () => document.querySelector('.lot-ref-scope').textContent;
const prompt = () => select().options[0].textContent;
const list = () => document.querySelector('.lot-ref-list').textContent;
const section = () => document.getElementById('productionLotRefSection');

describe('App.LotRef', () => {
  beforeEach(() => {
    jest.resetModules();
    load();
    document.body.innerHTML = `
      <div class="modal" id="editProductionModal">
        <div id="productionLotRefSection" style="display:none;">
          <input type="hidden" name="lotRefs" id="productionLotRefs" value="[]" disabled>
          <small class="lot-ref-scope"></small>
          <select class="lot-ref-select"></select>
          <div class="lot-ref-list"></div>
        </div>
      </div>`;
    global.Api = { call: jest.fn(async () => ({ success: true, data: related() })) };
  });

  test('lists the related lots with their dates, and sends an empty list until one is connected', async () => {
    await App.LotRef.load('PRC-1');

    expect(Api.call).toHaveBeenCalledWith('getRelatedLots', 'PRC-1', null);
    expect(section().style.display).toBe('');
    expect(scope()).toBe('Stage 3, CRYSTA 14 inch');
    expect(prompt()).toBe('Search by lot number...');
    const options = Array.from(select().options).map(o => o.textContent);
    expect(options[1]).toBe('LOT-FTD003-0043 · Fitted Frame 14 inch Crysta S/Rim · Completed 27/10/2026');
    expect(options[2]).toContain('In Progress · Lot date 21/10/2026');
    expect(input().disabled).toBe(false);
    expect(input().value).toBe('[]');
  });

  test('connecting and removing a lot changes what is sent', async () => {
    await App.LotRef.load('PRC-1');

    App.LotRef.connect(2);
    App.LotRef.connect(1);
    App.LotRef.connect(1);
    expect(JSON.parse(input().value)).toEqual([2, 1]);
    expect(list()).toContain('LOT-FTD003-0042');

    App.LotRef.disconnect(2);
    expect(JSON.parse(input().value)).toEqual([1]);
  });

  test('a picked lot is only a link: the form shows its number and nothing else', async () => {
    App.LotPanel.open = jest.fn();
    await App.LotRef.load('PRC-1');

    App.LotRef.connect(1);

    expect(list()).toBe('LOT-FTD003-0043');
    expect(App.LotPanel.open).not.toHaveBeenCalled();

    document.querySelector('.lot-ref-link').click();
    expect(App.LotPanel.open).toHaveBeenCalledWith(1);
  });

  test('a connected lot leaves the dropdown, and comes back when removed', async () => {
    App.Utils.select2Matcher = (_params, option) => option;
    await App.LotRef.load('PRC-1');
    const option = { id: '2', text: 'LOT-FTD003-0042' };
    expect(App.LotRef._matches({}, option)).toBe(option);

    App.LotRef.connect(2);
    expect(App.LotRef._matches({}, option)).toBeNull();

    App.LotRef.disconnect(2);
    expect(App.LotRef._matches({}, option)).toBe(option);
  });

  test('an edit starts from what the lot is connected to, even a lot no longer listed', async () => {
    const gone = lot({ rowIdx: 9, lotNumber: 'LOT-OLD-0001', deleted: true });
    Api.call.mockResolvedValue({ success: true, data: related({ references: [gone] }) });

    await App.LotRef.load('PRC-1', 77);

    expect(Api.call).toHaveBeenCalledWith('getRelatedLots', 'PRC-1', 77);
    expect(JSON.parse(input().value)).toEqual([9]);
    expect(list()).toContain('LOT-OLD-0001');
    // Named, but there is nothing left to open.
    expect(document.querySelector('.lot-ref-deleted')).not.toBeNull();
    expect(document.querySelector('button.lot-ref-link')).toBeNull();
  });

  test('a failed load sends nothing, so saved connections stay', async () => {
    Api.call.mockRejectedValue(new Error('offline'));
    await App.LotRef.load('PRC-1', 77);

    expect(input().disabled).toBe(true);
    expect(select().disabled).toBe(true);
    expect(prompt()).toBe('Could not load lots. The lot can still be saved.');
  });

  test('sequence 1 has nothing before it, so the field stays hidden', async () => {
    Api.call.mockResolvedValue({ success: true, data: related({ applicable: false, lots: [] }) });
    await App.LotRef.load('PRC-1');

    expect(section().style.display).toBe('none');
    expect(input().disabled).toBe(true);
  });

  test('no related lots says so, and the field stays optional', async () => {
    Api.call.mockResolvedValue({ success: true, data: related({ lots: [] }) });
    await App.LotRef.load('PRC-1');

    expect(scope()).toBe('Stage 3, CRYSTA 14 inch');
    expect(prompt()).toBe('No related lots');
    expect(select().disabled).toBe(true);
    expect(input().value).toBe('[]');
  });

  test('changing the process clears what was connected', async () => {
    await App.LotRef.load('PRC-1');
    App.LotRef.connect(1);

    await App.LotRef.load('PRC-2');

    expect(input().value).toBe('[]');
    expect(list()).toBe('');
  });

  test('a slow answer for the old process cannot land on the new one', async () => {
    let finishOld;
    Api.call.mockImplementationOnce(() => new Promise(res => { finishOld = res; }));
    const first = App.LotRef.load('PRC-OLD');
    await App.LotRef.load('PRC-NEW');
    App.LotRef.connect(1);

    finishOld({ success: true, data: related({ lots: [lot({ rowIdx: 5, lotNumber: 'LOT-STALE' })] }) });
    await first;

    expect(Array.from(select().options).map(o => o.textContent).join()).not.toContain('LOT-STALE');
    expect(JSON.parse(input().value)).toEqual([1]);
  });

  test('a lot number is shown as text, not markup', async () => {
    Api.call.mockResolvedValue({
      success: true, data: related({ references: [lot({ lotNumber: '<img src=x>' })] })
    });
    await App.LotRef.load('PRC-1', 77);

    expect(document.querySelector('.lot-ref-list img')).toBeNull();
  });

  // The owner, 2026-10-31: a wrong quantity, a bad count or a bug must never
  // stop someone connecting the right lot, so these wait for a search and
  // are never taken away.
  describe('a lot that looks used up', () => {
    const gone = lot({ rowIdx: 2, lotNumber: 'LOT-FTD003-0042', usedUp: true });
    const option = { id: '2', text: 'LOT-FTD003-0042' };

    beforeEach(() => {
      App.Utils.select2Matcher = (_params, opt) => opt;
      Api.call.mockResolvedValue({ success: true, data: related({ lots: [lot(), gone] }) });
    });

    test('stays out of the first list, and search finds it', async () => {
      await App.LotRef.load('PRC-1');

      expect(App.LotRef._matches({}, option)).toBeNull();
      expect(App.LotRef._matches({ term: '   ' }, option)).toBeNull();
      expect(App.LotRef._matches({ term: '0042' }, option)).toBe(option);
    });

    test('the rest of the list is not affected', async () => {
      await App.LotRef.load('PRC-1');
      const live = { id: '1', text: 'LOT-FTD003-0043' };

      expect(App.LotRef._matches({}, live)).toBe(live);
    });

    test('says so in the list and in the prompt', async () => {
      await App.LotRef.load('PRC-1');

      expect(select().options[2].textContent).toContain('Looks used up');
      expect(select().options[1].textContent).not.toContain('Looks used up');
      expect(prompt()).toBe('Search by lot number, used-up lots too...');
    });

    test('connects like any other lot', async () => {
      await App.LotRef.load('PRC-1');

      App.LotRef.connect(2);

      expect(JSON.parse(input().value)).toEqual([2]);
      expect(list()).toBe('LOT-FTD003-0042');
    });

    test('when every lot looks used up the field can still be searched', async () => {
      Api.call.mockResolvedValue({ success: true, data: related({ lots: [gone] }) });

      await App.LotRef.load('PRC-1');

      expect(select().disabled).toBe(false);
      expect(prompt()).toBe('Search by lot number, used-up lots too...');
    });
  });
});

describe('App.LotRef.tagsHtml', () => {
  const tags = refs => {
    document.body.innerHTML = `<div id="cell">${App.LotRef.tagsHtml(refs)}</div>`;
    return document.getElementById('cell');
  };

  beforeEach(() => {
    jest.resetModules();
    load();
  });

  test('a lot connected to nothing has no tags', () => {
    expect(App.LotRef.tagsHtml([])).toBe('');
    expect(App.LotRef.tagsHtml(undefined)).toBe('');
  });

  test('a tag is the lot number, and a click opens that lot', () => {
    App.LotPanel.open = jest.fn();
    const cell = tags([
      { rowIdx: 4, lotNumber: 'LOT-FTD003-0043', deleted: false },
      { rowIdx: 5, lotNumber: 'LOT-FTD003-0042', deleted: false }
    ]);

    const buttons = cell.querySelectorAll('button.lot-ref-tag');
    expect([...buttons].map(b => b.textContent)).toEqual(['LOT-FTD003-0043', 'LOT-FTD003-0042']);

    buttons[1].click();
    expect(App.LotPanel.open).toHaveBeenCalledWith(5);
  });

  test('a lot deleted since is named but cannot be opened', () => {
    const cell = tags([{ rowIdx: 4, lotNumber: 'LOT-OLD-0001', deleted: true }]);

    expect(cell.querySelector('.lot-ref-deleted').textContent).toBe('LOT-OLD-0001');
    expect(cell.querySelector('button')).toBeNull();
  });

  test('a lot number is shown as text, not markup', () => {
    const cell = tags([{ rowIdx: 4, lotNumber: '<img src=x>', deleted: false }]);

    expect(cell.querySelector('img')).toBeNull();
  });
});

describe('App.LotPanel from a tag on the Production Log', () => {
  const panel = () => document.querySelector('.lot-panel');
  const dialog = () => document.getElementById('editProductionModal');
  const flush = () => new Promise(res => setTimeout(res));

  beforeEach(() => {
    jest.resetModules();
    load();
    // The form is on the page but closed, so Bootstrap gives it no .show.
    document.body.innerHTML = `
      <div class="modal" id="editProductionModal"></div>
      <button class="lot-ref-tag" id="tag"></button>
      <button class="lot-ref-tag" id="tag2"></button>
      <button id="elsewhere"></button>`;
    global.Api = { call: jest.fn(async () => ({ success: true, data: detail() })) };
  });

  test('opens on the page, because the form it would sit in is closed', async () => {
    App.LotPanel.open(1);
    await flush();

    expect(panel().parentElement).toBe(document.body);
    expect(panel().classList.contains('lot-panel-page')).toBe(true);
    expect(dialog().classList.contains('lot-panel-open')).toBe(false);
    expect(panel().querySelector('.lot-panel-title').textContent).toBe('LOT-FTD003-0043');
  });

  test('moves into the form when it opens there next', async () => {
    App.LotPanel.open(1);
    await flush();
    App.LotPanel.close();

    dialog().classList.add('show');
    App.LotPanel.open(1);
    await flush();

    expect(panel().parentElement).toBe(dialog());
    expect(panel().classList.contains('lot-panel-page')).toBe(false);
    expect(dialog().classList.contains('lot-panel-open')).toBe(true);
  });

  test('Escape closes it from anywhere on the page, and gives focus back', async () => {
    const tag = document.getElementById('tag');
    tag.focus();
    App.LotPanel.open(1);
    await flush();
    document.getElementById('elsewhere').focus();

    document.getElementById('elsewhere').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(tag);
  });

  test('a click anywhere else closes it, and leaves focus where that click put it', async () => {
    document.getElementById('tag').focus();
    App.LotPanel.open(1);
    await flush();
    const elsewhere = document.getElementById('elsewhere');

    elsewhere.focus();
    elsewhere.click();

    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(elsewhere);
  });

  test('a click inside it does not close it', async () => {
    App.LotPanel.open(1);
    await flush();

    panel().querySelector('.lot-panel-body').click();

    expect(panel().hidden).toBe(false);
  });

  test('another tag shows that lot instead of closing', async () => {
    App.LotPanel.open(1);
    await flush();

    App.LotPanel.open(2);
    document.getElementById('tag2').click();
    await flush();

    expect(panel().hidden).toBe(false);
    expect(Api.call).toHaveBeenLastCalledWith('getLotDetail', 2);
  });
});

describe('App.LotPanel', () => {
  const panel = () => document.querySelector('.lot-panel');
  const dialog = () => document.getElementById('editProductionModal');
  const flush = () => new Promise(res => setTimeout(res));

  beforeEach(() => {
    jest.resetModules();
    load();
    document.body.innerHTML = '<div class="modal show" id="editProductionModal"><button id="view">View</button></div>';
    global.Api = { call: jest.fn(async () => ({ success: true, data: detail() })) };
  });

  test('opens inside the form dialog and shows the lot, with its dates', async () => {
    App.LotPanel.open(1);
    await flush();

    expect(panel().parentElement).toBe(dialog());
    expect(dialog().classList.contains('lot-panel-open')).toBe(true);
    expect(panel().querySelector('.lot-panel-title').textContent).toBe('LOT-FTD003-0043');
    const text = panel().textContent;
    expect(text).toContain('20/10/2026');
    expect(text).toContain('27/10/2026');
    expect(text).toContain('Amarjeet');
  });

  test('follows a lot connected to it, and returns the same way', async () => {
    Api.call.mockImplementation(async (_method, rowIdx) => ({
      success: true,
      data: rowIdx === 1
        ? detail({ references: [lot({ rowIdx: 2, lotNumber: 'LOT-PNT-0001', processType: 'Frame Painting' })] })
        : detail({ lot: { ...detail().lot, lotNumber: 'LOT-PNT-0001' } })
    }));
    App.LotPanel.open(1);
    await flush();
    expect(panel().textContent).toContain('Connected lots');
    expect(panel().querySelector('.lot-panel-back').hidden).toBe(true);

    panel().querySelector('.lot-panel-lot').click();
    await flush();
    expect(panel().querySelector('.lot-panel-title').textContent).toBe('LOT-PNT-0001');
    expect(panel().querySelector('.lot-panel-back').hidden).toBe(false);

    panel().querySelector('.lot-panel-back').click();
    await flush();
    expect(panel().querySelector('.lot-panel-title').textContent).toBe('LOT-FTD003-0043');
  });

  test('a deleted connection is named but cannot be opened', async () => {
    Api.call.mockResolvedValue({
      success: true, data: detail({ references: [lot({ rowIdx: 9, lotNumber: 'LOT-OLD-0001', deleted: true })] })
    });
    App.LotPanel.open(1);
    await flush();

    expect(panel().textContent).toContain('LOT-OLD-0001');
    expect(panel().querySelector('button.lot-panel-lot')).toBeNull();
  });

  test('Escape closes only the panel and gives focus back', async () => {
    const view = document.getElementById('view');
    view.focus();
    const bubbled = jest.fn();
    document.addEventListener('keydown', bubbled);

    App.LotPanel.open(1);
    await flush();
    panel().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(panel().hidden).toBe(true);
    expect(bubbled).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(view);
    expect(dialog().classList.contains('lot-panel-open')).toBe(false);
    document.removeEventListener('keydown', bubbled);
  });

  test("keys pressed in the panel don't reach the form's record stepping", async () => {
    const bubbled = jest.fn();
    document.addEventListener('keydown', bubbled);
    App.LotPanel.open(1);
    await flush();

    panel().dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));

    expect(bubbled).not.toHaveBeenCalled();
    document.removeEventListener('keydown', bubbled);
  });

  test('Escape with focus in the form closes the panel, not the form', async () => {
    const button = document.getElementById('view');
    const reachedForm = jest.fn();
    button.addEventListener('keydown', reachedForm);
    App.LotPanel.open(1);
    await flush();

    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(panel().hidden).toBe(true);
    expect(reachedForm).not.toHaveBeenCalled();
  });

  test('closes with the form', async () => {
    App.LotPanel.open(1);
    await flush();

    dialog().dispatchEvent(new Event('hidden.bs.modal'));

    expect(panel().hidden).toBe(true);
  });

  test('says so when the lot cannot be loaded', async () => {
    Api.call.mockResolvedValue({ success: false, message: 'That production lot no longer exists.' });
    App.LotPanel.open(1);
    await flush();

    expect(panel().textContent).toContain('no longer exists');
  });
});
