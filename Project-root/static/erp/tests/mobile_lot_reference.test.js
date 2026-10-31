/**
 * The optional Lot Reference on the phone and tablet's Log Lot sheet
 * (MApp.LotRef). The owner asked for only related lots, searchable by lot
 * number, and a side window (2026-10-30).
 *
 * The phone logs lots offline, so what matters most is what it sends: lotRefs
 * goes only when the references loaded, or a queued edit would wipe a lot's
 * saved connections. Which lots are related is the server's rule, tested in
 * tests/erp/test_lot_reference.py. The server is stubbed at MApp.Api.call.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PARTIAL = f => fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', f), 'utf8');

function loadAsGlobal(relPath, exportName, extra = '') {
  const code = fs
    .readFileSync(path.join(__dirname, '..', relPath), 'utf8')
    .replace(new RegExp(`^const ${exportName} = `, 'm'), `global.${exportName} = `) + extra;
  eval(code);
}

const lot = o => ({
  rowIdx: 1, lotNumber: 'LOT-FTD003-0043', outputItemName: 'Fitted Frame 14 inch Crysta S/Rim',
  processName: 'Fitting Frame 14 inch Crysta', processType: 'Fitting Frame', sequence: 3,
  status: 'Completed', qty: 25, colors: ['Blue / Black'], assignedTo: 'amarjeet',
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

const section = () => document.getElementById('lot-refs-section');
const flush = () => new Promise(res => setTimeout(res));

function mount() {
  jest.resetModules();
  global.fetch = jest.fn();
  document.body.innerHTML = `
    <div id="mapp-sheet-backdrop"></div>
    <div class="mb-toast-stack" id="mapp-toast-stack"></div>
    ${PARTIAL('mobile_views.html')}`;
  loadAsGlobal('api.js', 'Api', '\nglobal.PO_STATUS = PO_STATUS;');
  loadAsGlobal('mobile.js', 'MApp');
  MApp.Sheet._stack = [];
  document.getElementById('log-lot-body').innerHTML = '<div id="lot-refs-section"></div>';
  MApp.Api.call = jest.fn(async () => ({ success: true, data: related() }));
}

describe('MApp.LotRef', () => {
  beforeEach(mount);

  test('offers the related lots, and sends an empty list until one is connected', async () => {
    await MApp.LotRef.load('PRC-1');

    expect(MApp.Api.call).toHaveBeenCalledWith('getRelatedLots', 'PRC-1', null);
    expect(section().textContent).toContain('Search by lot number');
    expect(MApp.LotRef.payload()).toBe('[]');
  });

  test('the picker searches by lot number and shows the date without searching it', async () => {
    await MApp.LotRef.load('PRC-1');
    MApp.Picker.open = jest.fn(async ({ items }) => items[1]);

    await MApp.LotRef.add();

    const { items, title } = MApp.Picker.open.mock.calls[0][0];
    expect(title).toBe('Stage 3 lots for CRYSTA 14 inch');
    expect(items[1]).toMatchObject({
      value: 2,
      label: 'LOT-FTD003-0042',
      detail: 'Lot date 21/10/2026'
    });
    expect(items[1].sublabel).toContain('In Progress');
    expect(MApp.LotRef.payload()).toBe('[2]');
    expect(section().querySelector('.mapp-lot-ref-link').textContent).toBe('LOT-FTD003-0042');
  });

  test('a picked lot is only a link: the sheet opens when it is tapped', async () => {
    await MApp.LotRef.load('PRC-1');
    MApp.Picker.open = jest.fn(async ({ items }) => items[0]);
    await MApp.LotRef.add();

    expect(section().textContent).not.toContain('Fitted Frame');
    expect(section().textContent).not.toContain('27/10/2026');
    expect(MApp.Sheet.isOpen('sheet-lot-detail')).toBe(false);

    MApp.Api.call = jest.fn(async () => ({ success: true, data: detail() }));
    section().querySelector('[data-view]').click();
    await flush();
    expect(MApp.Sheet.isOpen('sheet-lot-detail')).toBe(true);
    MApp.LotRef.closeDetail();
  });

  test('a connected lot is not offered twice, and more can be added', async () => {
    await MApp.LotRef.load('PRC-1');
    MApp.Picker.open = jest.fn(async ({ items }) => items[0]);

    await MApp.LotRef.add();
    await MApp.LotRef.add();

    expect(MApp.Picker.open.mock.calls[1][0].items.map(i => i.value)).toEqual([2]);
    expect(JSON.parse(MApp.LotRef.payload())).toEqual([1, 2]);
  });

  test('dismissing the picker changes nothing', async () => {
    await MApp.LotRef.load('PRC-1');
    MApp.Picker.open = jest.fn(async () => null);

    await MApp.LotRef.add();

    expect(MApp.LotRef.payload()).toBe('[]');
  });

  test('Remove takes a lot off', async () => {
    MApp.Api.call.mockResolvedValue({ success: true, data: related({ references: [lot()] }) });
    await MApp.LotRef.load('PRC-1', 77);
    expect(MApp.LotRef.payload()).toBe('[1]');

    section().querySelector('[data-remove]').click();

    expect(MApp.LotRef.payload()).toBe('[]');
  });

  test('an edit starts from what the lot is connected to', async () => {
    const gone = lot({ rowIdx: 9, lotNumber: 'LOT-OLD-0001', deleted: true });
    MApp.Api.call.mockResolvedValue({ success: true, data: related({ references: [gone] }) });

    await MApp.LotRef.load('PRC-1', 77);

    expect(MApp.Api.call).toHaveBeenCalledWith('getRelatedLots', 'PRC-1', 77);
    expect(MApp.LotRef.payload()).toBe('[9]');
    expect(section().querySelector('.mapp-lot-ref-deleted').textContent).toBe('LOT-OLD-0001');
    expect(section().querySelector('[data-view]')).toBeNull();
  });

  test('offline it says so and sends nothing, so a queued edit keeps saved connections', async () => {
    MApp.Api.call.mockRejectedValue(new Error('offline'));

    await MApp.LotRef.load('PRC-1', 77);

    expect(section().textContent).toContain('need a connection');
    expect(section().textContent).toContain('can still be saved');
    expect(MApp.LotRef.payload()).toBeNull();
  });

  test('sequence 1 shows nothing and sends nothing', async () => {
    MApp.Api.call.mockResolvedValue({ success: true, data: related({ applicable: false, lots: [] }) });

    await MApp.LotRef.load('PRC-1');

    expect(section().innerHTML).toBe('');
    expect(MApp.LotRef.payload()).toBeNull();
  });

  test('no related lots says so, and the lot can still be logged', async () => {
    MApp.Api.call.mockResolvedValue({ success: true, data: related({ lots: [] }) });

    await MApp.LotRef.load('PRC-1');

    expect(section().textContent).toContain('No Stage 3 lots for CRYSTA 14 inch');
    expect(document.getElementById('lot-ref-add').disabled).toBe(true);
    expect(MApp.LotRef.payload()).toBe('[]');
  });

  test('a blank form forgets everything', async () => {
    await MApp.LotRef.load('PRC-1');
    MApp.Picker.open = jest.fn(async ({ items }) => items[0]);
    await MApp.LotRef.add();

    MApp.LotRef.reset();

    expect(MApp.LotRef.payload()).toBeNull();
    expect(section().innerHTML).toBe('');
  });

  test('a slow answer for the old process cannot land on the new one', async () => {
    let finishOld;
    MApp.Api.call.mockImplementationOnce(() => new Promise(res => { finishOld = res; }));
    const first = MApp.LotRef.load('PRC-OLD');
    await MApp.LotRef.load('PRC-NEW');

    finishOld({ success: true, data: related({ lots: [lot({ rowIdx: 5, lotNumber: 'LOT-STALE' })] }) });
    await first;

    expect(MApp.LotRef._data.lots.map(l => l.lotNumber)).not.toContain('LOT-STALE');
  });
});

// The owner, 2026-10-31: a wrong quantity, a bad count or a bug must never
// stop someone connecting the right lot, so these wait for a search and are
// never taken away. Run against the real picker.
describe('a lot that looks used up', () => {
  const options = () => [...document.querySelectorAll('#mapp-picker-list .mb-picker-option')]
    .map(o => o.textContent);
  const pickerText = () => document.getElementById('mapp-picker-list').textContent;

  beforeEach(async () => {
    mount();
    MApp.Api.call.mockResolvedValue({
      success: true,
      data: related({ lots: [lot(), lot({ rowIdx: 2, lotNumber: 'LOT-FTD003-0042', usedUp: true })] })
    });
    await MApp.LotRef.load('PRC-1');
  });

  afterEach(() => MApp.Picker.cancel());

  test('stays out of the first list, and the picker says how to find it', () => {
    MApp.LotRef.add();

    expect(options().join()).toContain('LOT-FTD003-0043');
    expect(options().join()).not.toContain('LOT-FTD003-0042');
    expect(pickerText()).toContain('Type a lot number to find them');
  });

  test('search finds it, marked', () => {
    MApp.LotRef.add();

    MApp.Picker.onSearch('0042');

    expect(options()).toHaveLength(1);
    expect(options()[0]).toContain('LOT-FTD003-0042');
    expect(options()[0]).toContain('Looks used up');
    expect(pickerText()).not.toContain('Type a lot number');
  });

  test('clearing the search hides it again', () => {
    MApp.LotRef.add();
    MApp.Picker.onSearch('0042');

    MApp.Picker.onSearch('');

    expect(options().join()).not.toContain('LOT-FTD003-0042');
  });

  test('connects like any other lot', async () => {
    const adding = MApp.LotRef.add();
    MApp.Picker.onSearch('0042');

    document.querySelector('#mapp-picker-list .mb-picker-option').click();
    await adding;

    expect(MApp.LotRef.payload()).toBe('[2]');
  });

  test('the field says search finds them', () => {
    expect(section().textContent).toContain('used-up lots too');
  });

  test('when every lot looks used up the field can still be searched', async () => {
    MApp.Api.call.mockResolvedValue({
      success: true, data: related({ lots: [lot({ usedUp: true })] })
    });
    await MApp.LotRef.load('PRC-1');

    expect(document.getElementById('lot-ref-add').disabled).toBe(false);

    MApp.LotRef.add();
    expect(options()).toHaveLength(0);
    expect(pickerText()).toContain('Type a lot number to find them');

    MApp.Picker.onSearch('0043');
    expect(options()).toHaveLength(1);
  });

  test('a picker with no hidden items is as it was', () => {
    MApp.Picker.open({ title: 'Choose', items: [{ value: 1, label: 'One' }] });

    expect(options()).toHaveLength(1);
    expect(pickerText()).toBe('One');
  });
});

describe('tags on a lot card', () => {
  const REF = { rowIdx: 4, lotNumber: 'LOT-FTD003-0043', deleted: false };
  const card = refs => {
    document.getElementById('production-list').innerHTML = '';
    const lots = [{
      rowIdx: 1, lotNumber: 'LOT-PK-0010', processId: 'PRC-1', dateRaw: '2026-10-30',
      qty: 10, assignedTo: 'sanjay', status: 'Pending', lotRefs: refs
    }];
    MApp.Production.entries = MApp.Search.index(lots, MApp.Production.SEARCH);
    MApp.Production.searchTerm = '';
    MApp.Production.processById = { 'PRC-1': { processName: 'Packing' } };
    MApp.Production.render();
    return document.querySelector('#production-list .mb-card');
  };

  beforeEach(() => {
    mount();
    const list = document.createElement('div');
    list.id = 'production-list';
    document.body.appendChild(list);
  });

  test('a lot connected to nothing has no tags', () => {
    expect(card([]).querySelector('.mapp-lot-ref-tags')).toBeNull();
    expect(card(undefined).querySelector('.mapp-lot-ref-tags')).toBeNull();
  });

  test('a tap opens the lot it names', async () => {
    MApp.Api.call = jest.fn(async () => ({ success: true, data: detail() }));
    const tag = card([REF]).querySelector('button.mapp-lot-ref-tag');
    expect(tag.textContent).toBe('LOT-FTD003-0043');

    tag.click();
    await flush();

    expect(MApp.Api.call).toHaveBeenCalledWith('getLotDetail', 4);
    expect(MApp.Sheet.isOpen('sheet-lot-detail')).toBe(true);
    MApp.LotRef.closeDetail();
  });

  test('while selecting, a tap does not open it', () => {
    MApp.Select.isActive = jest.fn(() => true);
    MApp.LotRef.view = jest.fn();

    card([REF]).querySelector('button.mapp-lot-ref-tag').click();

    expect(MApp.LotRef.view).not.toHaveBeenCalled();
  });

  test('a lot deleted since is named but cannot be opened', () => {
    const tags = card([{ ...REF, deleted: true }]).querySelector('.mapp-lot-ref-tags');

    expect(tags.textContent).toBe('LOT-FTD003-0043');
    expect(tags.querySelector('.mapp-lot-ref-deleted')).not.toBeNull();
    expect(tags.querySelector('button')).toBeNull();
  });

  test('a lot number is shown as text, not markup', () => {
    expect(card([{ ...REF, lotNumber: '<img src=x>' }]).querySelector('img')).toBeNull();
  });
});

describe('the lot detail sheet', () => {
  const body = () => document.getElementById('lot-detail-body');
  const title = () => document.getElementById('lot-detail-title').textContent;
  const back = () => document.getElementById('lot-detail-back');

  beforeEach(() => {
    mount();
    MApp.Api.call = jest.fn(async () => ({ success: true, data: detail() }));
  });

  test('comes after Log Lot in the page, so it paints over it', () => {
    const all = Array.from(document.querySelectorAll('.mb-sheet')).map(s => s.id);
    expect(all.indexOf('sheet-lot-detail')).toBeGreaterThan(all.indexOf('sheet-log-lot'));
  });

  test('shows the lot with its dates, and opens over the form', async () => {
    MApp.Sheet.open('sheet-log-lot');
    MApp.LotRef.view(1);
    await flush();

    expect(MApp.Sheet.isOpen('sheet-lot-detail')).toBe(true);
    expect(MApp.Sheet.isOpen('sheet-log-lot')).toBe(true);
    expect(title()).toBe('LOT-FTD003-0043');
    expect(body().textContent).toContain('20/10/2026');
    expect(body().textContent).toContain('27/10/2026');
    expect(body().querySelector('.mb-chip-completed')).not.toBeNull();
  });

  test('follows a lot connected to it, and returns the same way', async () => {
    MApp.Api.call.mockImplementation(async (_method, rowIdx) => ({
      success: true,
      data: rowIdx === 1
        ? detail({ references: [lot({ rowIdx: 2, lotNumber: 'LOT-PNT-0001' })] })
        : detail({ lot: { ...detail().lot, lotNumber: 'LOT-PNT-0001' } })
    }));
    MApp.LotRef.view(1);
    await flush();
    expect(body().textContent).toContain('Connected lots');
    expect(back().style.display).toBe('none');

    body().querySelector('[data-walk]').click();
    await flush();
    expect(title()).toBe('LOT-PNT-0001');
    expect(back().style.display).toBe('');

    back().click();
    await flush();
    expect(title()).toBe('LOT-FTD003-0043');
  });

  test('closing Log Lot closes the detail on top of it first', async () => {
    MApp.Sheet.open('sheet-log-lot');
    MApp.LotRef.view(1);
    await flush();

    MApp.Production.closeLogLotSheet();

    expect(MApp.Sheet.isOpen('sheet-lot-detail')).toBe(false);
    expect(MApp.Sheet.isOpen('sheet-log-lot')).toBe(false);
  });

  test('offline it says so', async () => {
    MApp.Api.call.mockRejectedValue(new Error('offline'));
    MApp.LotRef.view(1);
    await flush();

    expect(body().textContent).toContain('needs a connection');
  });
});
