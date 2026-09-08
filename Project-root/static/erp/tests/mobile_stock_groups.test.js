/**
 * Stock Groups on the phone (Phase 6).
 *
 * A group is a named set of item/size rows that the Low Stock Report
 * filters and prints by, so somebody does not re-pick the same forty rows
 * every week. Building one was desktop-only -- which put it out of reach
 * of the person who actually knows which parts belong together, standing
 * at the rack.
 *
 * The membership save is a wholesale replace (setStockGroupItems deletes
 * the group's rows and re-inserts what it is sent), so most of what is
 * asserted here is about the selection never quietly including or
 * dropping a row the operator did not act on.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function loadAsGlobal(relPath, exportName) {
  const code = fs
    .readFileSync(path.join(__dirname, '..', relPath), 'utf8')
    .replace(new RegExp(`^const ${exportName} = `, 'm'), `global.${exportName} = `);
  // eslint-disable-next-line no-eval
  eval(code);
}

const GROUPS = [
  { id: 7, name: 'Stickers', remarks: 'front + rear', items: [{ name: 'Sticker A', size: '26 inch' }] },
  { id: 9, name: 'Mudguard Bolts', remarks: '', items: [] },
];

const STOCK = [
  { name: 'Sticker A', size: '26 inch', currentStock: 40, isLowStock: false },
  { name: 'Sticker A', size: '24 inch', currentStock: 3, isLowStock: true },
  { name: 'Bolt M6', size: '', currentStock: 900, isLowStock: false },
];

function mount() {
  jest.resetModules();
  global.fetch = jest.fn();
  document.body.innerHTML = `
    <div id="mapp-sheet-backdrop"></div>
    <div class="mb-sheet" id="sheet-stock-groups">
      <div class="mb-search"><input type="search" id="stock-groups-search"></div>
      <div id="stock-groups-list"></div>
    </div>
    <div class="mb-sheet" id="sheet-stock-group-form">
      <h2 id="stock-group-form-title"></h2>
      <div id="stock-group-form-body"></div>
      <button id="stock-group-form-save-btn">Save</button>
    </div>
    <div class="mb-sheet" id="sheet-stock-group-items">
      <h2 id="stock-group-items-title"></h2>
      <div class="mb-search"><input type="search" id="stock-group-items-search"></div>
      <div class="mb-filter-chip-row" id="stock-group-items-filters">
        <button class="mb-filter-chip active" data-items-filter="all" aria-pressed="true">All</button>
        <button class="mb-filter-chip" data-items-filter="selected" aria-pressed="false">In group</button>
        <button class="mb-filter-chip" data-items-filter="unselected" aria-pressed="false">Not in group</button>
      </div>
      <span id="stock-group-items-count"></span>
      <div id="stock-group-items-body"></div>
      <button id="stock-group-items-save-btn">Save items</button>
    </div>
    <div class="mb-toast-stack" id="mapp-toast-stack"></div>`;
  loadAsGlobal('api.js', 'Api');
  loadAsGlobal('mobile.js', 'MApp');
  MApp.Sheet._stack = [];
  MApp.Paging._shown = {};
  window.confirm = jest.fn(() => true);
  Element.prototype.scrollIntoView = jest.fn();
}

const listText = () => document.getElementById('stock-groups-list').textContent;
const itemsBody = () => document.getElementById('stock-group-items-body');

async function openRegister() {
  MApp.Api.call = jest.fn(async () => ({ success: true, data: GROUPS }));
  await MApp.StockGroups.open();
}

async function openChecklist(group) {
  MApp.Api.callCached = jest.fn(async () => ({ success: true, data: STOCK }));
  await MApp.StockGroups.openItems(group);
}

describe('the register', () => {
  beforeEach(mount);

  test('lists each group with how many rows are in it', async () => {
    await openRegister();

    expect(MApp.Api.call).toHaveBeenCalledWith('getStockGroupsData');
    expect(listText()).toContain('Stickers');
    expect(listText()).toContain('front + rear');
    expect(listText()).toContain('Mudguard Bolts');
  });

  test('search filters the register', async () => {
    await openRegister();
    MApp.StockGroups.onSearch('bolts');

    expect(MApp.StockGroups.filtered.map(g => g.name)).toEqual(['Mudguard Bolts']);
  });

  test('a failure offers a retry rather than an empty list', async () => {
    MApp.Api.call = jest.fn(async () => { throw new Error('offline'); });
    await MApp.StockGroups.open();

    expect(document.querySelector('#stock-groups-list .mb-state-retry')).not.toBeNull();
  });

  test('an edit sends the row id, not the typed name', async () => {
    // The server keys the edit off a numeric id and skips its duplicate-
    // name check only when the name is unchanged; sending a name as the
    // identity would create a second group instead of renaming this one.
    let call = null;
    MApp.Util.mutateSimple = jest.fn(async (m, args) => { call = { m, args }; return { success: false }; });
    await openRegister();

    MApp.StockGroups.openForm(GROUPS[0]);
    document.getElementById('stock-group-form-name').value = 'Decals';
    await MApp.StockGroups.save();

    expect(call.m).toBe('saveStockGroup');
    expect(call.args[0]).toEqual({ id: 7, name: 'Decals', remarks: 'front + rear' });
  });

  test('a new group sends a null id', async () => {
    let call = null;
    MApp.Util.mutateSimple = jest.fn(async (m, args) => { call = { m, args }; return { success: false }; });
    await openRegister();

    MApp.StockGroups.openForm(null);
    document.getElementById('stock-group-form-name').value = 'Brake parts';
    await MApp.StockGroups.save();

    expect(call.args[0].id).toBeNull();
  });

  test('a blank name is refused at the field', async () => {
    MApp.Util.mutateSimple = jest.fn();
    await openRegister();

    MApp.StockGroups.openForm(null);
    await MApp.StockGroups.save();

    expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();
    expect(document.getElementById('stock-group-form-name').getAttribute('aria-invalid')).toBe('true');
  });

  test('a newly created group opens its own checklist', async () => {
    // An empty group does nothing at all, so the one step that makes it
    // useful should not have to be found.
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: true, data: { id: 9 } }));
    await openRegister();
    MApp.Api.callCached = jest.fn(async () => ({ success: true, data: STOCK }));

    MApp.StockGroups.openForm(null);
    document.getElementById('stock-group-form-name').value = 'Mudguard Bolts';
    await MApp.StockGroups.save();

    expect(MApp.StockGroups.itemsGroup).toEqual(GROUPS[1]);
  });

  test('an edit does NOT reopen the checklist', async () => {
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: true, data: { id: 7 } }));
    await openRegister();
    MApp.StockGroups.openItems = jest.fn();

    MApp.StockGroups.openForm(GROUPS[0]);
    await MApp.StockGroups.save();

    expect(MApp.StockGroups.openItems).not.toHaveBeenCalled();
  });

  test('delete confirms with what is actually lost, then sends the id', async () => {
    let call = null;
    MApp.Util.mutateSimple = jest.fn(async (m, args) => { call = { m, args }; return { success: false }; });
    await openRegister();

    await MApp.StockGroups.remove(GROUPS[0]);

    expect(window.confirm.mock.calls[0][0]).toContain('the items themselves are untouched');
    expect(call).toEqual({ m: 'deleteStockGroup', args: [7] });
  });

  test('declining the delete sends nothing', async () => {
    window.confirm = jest.fn(() => false);
    MApp.Util.mutateSimple = jest.fn();
    await openRegister();

    await MApp.StockGroups.remove(GROUPS[0]);

    expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();
  });
});

describe('the membership checklist', () => {
  beforeEach(mount);

  test('opens with the group\'s existing rows already selected', async () => {
    await openChecklist(GROUPS[0]);

    expect(MApp.Api.callCached).toHaveBeenCalledWith('getStockData');
    expect([...MApp.StockGroups.selectedKeys]).toEqual([MApp.Stock._key('Sticker A', '26 inch')]);
  });

  test('groups the sizes of one item onto one card', async () => {
    await openChecklist(GROUPS[1]);

    const cards = itemsBody().querySelectorAll('.mb-card');
    expect(cards.length).toBe(2); // Sticker A (2 sizes) + Bolt M6
    expect(itemsBody().textContent).toContain('26 inch');
    expect(itemsBody().textContent).toContain('24 inch');
  });

  test('a row with no size reads as GENERAL rather than blank', async () => {
    await openChecklist(GROUPS[1]);
    expect(itemsBody().textContent).toContain('GENERAL');
  });

  test('tapping a size toggles just that row', async () => {
    await openChecklist(GROUPS[1]);

    MApp.StockGroups.toggleRow('Sticker A', '24 inch');
    expect(MApp.StockGroups.selectedKeys.has(MApp.Stock._key('Sticker A', '24 inch'))).toBe(true);
    expect(MApp.StockGroups.selectedKeys.has(MApp.Stock._key('Sticker A', '26 inch'))).toBe(false);

    MApp.StockGroups.toggleRow('Sticker A', '24 inch');
    expect(MApp.StockGroups.selectedKeys.size).toBe(0);
  });

  test('the item header toggles every size of that item', async () => {
    await openChecklist(GROUPS[1]);

    MApp.StockGroups.toggleItem('Sticker A', true);
    expect(MApp.StockGroups.selectedKeys.size).toBe(2);

    MApp.StockGroups.toggleItem('Sticker A', false);
    expect(MApp.StockGroups.selectedKeys.size).toBe(0);
  });

  test('the In group / Not in group filters split the list', async () => {
    await openChecklist(GROUPS[0]);

    MApp.StockGroups.setItemsFilter('selected');
    expect(MApp.StockGroups.visibleRows().map(r => r.size)).toEqual(['26 inch']);

    MApp.StockGroups.setItemsFilter('unselected');
    expect(MApp.StockGroups.visibleRows().map(r => r.size)).toEqual(['24 inch', '']);
  });

  test('the active filter chip is the one that is on', async () => {
    await openChecklist(GROUPS[0]);
    MApp.StockGroups.setItemsFilter('selected');

    const on = [...document.querySelectorAll('#stock-group-items-filters .mb-filter-chip')]
      .filter(b => b.getAttribute('aria-pressed') === 'true')
      .map(b => b.dataset.itemsFilter);
    expect(on).toEqual(['selected']);
  });

  test('Select shown acts only on what search and filter leave visible', async () => {
    // The save replaces the whole membership, so a select-all that
    // reached past the filter would silently add rows nobody looked at.
    await openChecklist(GROUPS[1]);
    MApp.StockGroups.itemsSearch = 'bolt';

    MApp.StockGroups.selectAllVisible(true);

    expect([...MApp.StockGroups.selectedKeys]).toEqual([MApp.Stock._key('Bolt M6', '')]);
  });

  test('Clear shown leaves rows the filter is hiding alone', async () => {
    await openChecklist(GROUPS[0]); // Sticker A 26 inch is in the group
    MApp.StockGroups.itemsSearch = 'bolt';

    MApp.StockGroups.selectAllVisible(false);

    expect(MApp.StockGroups.selectedKeys.has(MApp.Stock._key('Sticker A', '26 inch'))).toBe(true);
  });

  test('the count reflects the whole selection, not the visible part', async () => {
    await openChecklist(GROUPS[1]);
    MApp.StockGroups.toggleItem('Sticker A', true);
    MApp.StockGroups.itemsSearch = 'bolt';
    MApp.StockGroups.renderItems();

    expect(document.getElementById('stock-group-items-count').textContent).toBe('2 rows selected');
  });

  test('saving sends the whole desired set with the stock row\'s own casing', async () => {
    // The key is lower-cased to compare rows; the server stores what it
    // is given, so sending the key back would rewrite every name in the
    // group to lower case.
    let call = null;
    MApp.Util.mutateSimple = jest.fn(async (m, args) => { call = { m, args }; return { success: true }; });
    await openChecklist(GROUPS[1]);
    MApp.StockGroups.open = jest.fn();
    MApp.StockGroups.toggleRow('Sticker A', '26 inch');

    await MApp.StockGroups.saveItems();

    expect(call.m).toBe('setStockGroupItems');
    expect(call.args[0]).toEqual({ groupId: 9, items: [{ name: 'Sticker A', size: '26 inch' }] });
  });

  test('a member whose stock row has gone is carried through, not dropped', async () => {
    // Saving is a wholesale replace. Silently dropping a row this screen
    // could not find would delete membership the operator never touched.
    let call = null;
    MApp.Util.mutateSimple = jest.fn(async (m, args) => { call = { m, args }; return { success: true }; });
    await openChecklist({ id: 9, name: 'Odd', items: [{ name: 'Retired Part', size: 'XL' }] });
    MApp.StockGroups.open = jest.fn();

    await MApp.StockGroups.saveItems();

    expect(call.args[0].items).toEqual([{ name: 'retired part', size: 'xl' }]);
  });

  test('emptying a group is confirmed, not blocked', async () => {
    // An empty selection is a real instruction here.
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: true }));
    await openChecklist(GROUPS[1]);
    MApp.StockGroups.open = jest.fn();

    await MApp.StockGroups.saveItems();

    expect(window.confirm.mock.calls[0][0]).toContain('with no items');
    expect(MApp.Util.mutateSimple).toHaveBeenCalled();
  });

  test('declining that confirmation sends nothing', async () => {
    window.confirm = jest.fn(() => false);
    MApp.Util.mutateSimple = jest.fn();
    await openChecklist(GROUPS[1]);

    await MApp.StockGroups.saveItems();

    expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();
  });

  test('the server message is shown rather than a canned one', async () => {
    // It carries the count that was actually written.
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: true, message: 'Saved 1 item(s) to "Mudguard Bolts".' }));
    const spy = jest.spyOn(MApp.Toast, 'success');
    await openChecklist(GROUPS[1]);
    MApp.StockGroups.open = jest.fn();
    MApp.StockGroups.toggleRow('Bolt M6', '');

    await MApp.StockGroups.saveItems();

    expect(spy).toHaveBeenCalledWith('Saved 1 item(s) to "Mudguard Bolts".');
    spy.mockRestore();
  });

  test('a refused save keeps the sheet open with the selection intact', async () => {
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: false }));
    await openChecklist(GROUPS[1]);
    MApp.StockGroups.open = jest.fn();
    MApp.StockGroups.toggleRow('Bolt M6', '');

    await MApp.StockGroups.saveItems();

    expect(MApp.StockGroups.selectedKeys.size).toBe(1);
    expect(MApp.StockGroups.open).not.toHaveBeenCalled();
    expect(document.getElementById('stock-group-items-save-btn').disabled).toBe(false);
  });
});
