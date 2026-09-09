/**
 * Moving a process or a recipe up and down the sequence, and bulk-deleting
 * returns -- the last of the parity backlog that was not a whole screen.
 *
 * reorderProcesses and reorderBOM both take the WHOLE ordered list and
 * renumber sequence = position in it. That is the trap this file mostly
 * exists to guard: sending the visible page, or a search's matches,
 * renumbers those rows and silently leaves every other row's sequence
 * pointing at the old arrangement. Process sequence is what the Log Lot
 * cascade reads to decide what comes next, so a wrong one is not
 * cosmetic.
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

const PROCESSES = [
  { processId: 'P1', processName: 'Welding', sequence: 1, active: true, outputItemName: 'Frame', lotPrefix: 'WLD' },
  { processId: 'P2', processName: 'Painting', sequence: 2, active: true, outputItemName: 'Frame', lotPrefix: 'PNT' },
  { processId: 'P3', processName: 'Packing', sequence: 3, active: true, outputItemName: 'Box', lotPrefix: 'PKG' },
];

const PRODUCTS = [
  { productId: 'PRD-1', productName: 'Kalpi 26', sequence: 1, components: [], totalCost: 100 },
  { productId: 'PRD-2', productName: 'Ranger 24', sequence: 2, components: [], totalCost: 200 },
];

const RETURNS = [
  { returnNumber: 'RET-1', vendor: 'acme', date: '01/09/2026', items: [], totalQty: 5 },
  { returnNumber: 'RET-2', vendor: 'beta', date: '02/09/2026', items: [], totalQty: 3 },
];

function mount() {
  jest.resetModules();
  global.fetch = jest.fn();
  document.body.innerHTML = `
    <div id="mapp-sheet-backdrop"></div>
    <div class="mb-search"><input type="search" id="process-list-search"></div>
    <div id="process-list-list"></div>
    <div class="mb-search"><input type="search" id="bom-list-search"></div>
    <div id="bom-list-list"></div>
    <div class="mb-list" id="more-returns-list"></div>
    <div class="mb-select-bar" id="mapp-select-bar"><span id="mapp-select-count"></span></div>
    <div class="mb-toast-stack" id="mapp-toast-stack"></div>`;
  // MApp.Returns.load() asks the outbox how many returns are still
  // queued. Not what this file is about, so it gets the smallest stub.
  global.OfflineCache = { outbox: { countPendingForMethod: jest.fn(async () => 0) } };
  loadAsGlobal('api.js', 'Api');
  loadAsGlobal('mobile.js', 'MApp');
  MApp.Sheet._stack = [];
  MApp.Paging._shown = {};
  MApp.Select._state = null;
  window.confirm = jest.fn(() => true);
  Element.prototype.scrollIntoView = jest.fn();
}

describe('MApp.Reorder', () => {
  beforeEach(mount);

  const list = () => ['a', 'b', 'c'];

  test('moves a row and returns the whole order', () => {
    expect(MApp.Reorder.moved(list(), 1, -1)).toEqual(['b', 'a', 'c']);
    expect(MApp.Reorder.moved(list(), 1, 1)).toEqual(['a', 'c', 'b']);
  });

  test('refuses to move past either end', () => {
    expect(MApp.Reorder.moved(list(), 0, -1)).toBeNull();
    expect(MApp.Reorder.moved(list(), 2, 1)).toBeNull();
  });

  test('leaves the original array alone', () => {
    // The caller keeps the old order until the server agrees.
    const original = list();
    MApp.Reorder.moved(original, 0, 1);
    expect(original).toEqual(['a', 'b', 'c']);
  });

  test('an index outside the list is refused rather than guessed', () => {
    expect(MApp.Reorder.moved(list(), 9, -1)).toBeNull();
    expect(MApp.Reorder.moved(null, 0, 1)).toBeNull();
  });
});

describe('reordering processes', () => {
  beforeEach(mount);

  async function open(search) {
    MApp.Api.call = jest.fn(async () => ({ success: true, data: PROCESSES }));
    await MApp.Process.open();
    if (search) MApp.Process.onSearch(search);
  }

  const arrows = () => [...document.querySelectorAll('#process-list-list [data-process-move]')];

  test('every card offers up and down', async () => {
    await open();
    expect(arrows()).toHaveLength(6); // three cards, two arrows each
  });

  test('the ends cannot move further out', async () => {
    await open();
    const first = arrows().filter(b => b.dataset.processMove === '0');
    const last = arrows().filter(b => b.dataset.processMove === '2');

    expect(first.find(b => b.dataset.reorderDelta === '-1').disabled).toBe(true);
    expect(first.find(b => b.dataset.reorderDelta === '1').disabled).toBe(false);
    expect(last.find(b => b.dataset.reorderDelta === '1').disabled).toBe(true);
  });

  test('sends the WHOLE order, not the page or the match', async () => {
    // The server renumbers sequence by position in what it is sent.
    let call = null;
    MApp.Util.mutateSimple = jest.fn(async (m, args) => { call = { m, args }; return { success: false }; });
    await open();

    await MApp.Process.move(0, 1);

    expect(call.m).toBe('reorderProcesses');
    expect(call.args[0]).toEqual(['P2', 'P1', 'P3']);
  });

  test('no arrows at all while a search is narrowing the list', async () => {
    // Three of forty rows on screen, and "up" has no answer the operator
    // would predict -- nor one that matches what the sequence becomes.
    await open('paint');

    expect(document.querySelectorAll('#process-list-list .mb-card').length).toBe(1);
    expect(arrows()).toHaveLength(0);
  });

  test('a refused reorder does not rearrange the screen', async () => {
    // Otherwise the list shows an order the lot numbers do not follow.
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: false }));
    await open();
    MApp.Process.load = jest.fn();

    await MApp.Process.move(0, 1);

    expect(MApp.Process.processes.map(p => p.processId)).toEqual(['P1', 'P2', 'P3']);
    expect(MApp.Process.load).not.toHaveBeenCalled();
  });

  test('a success reloads from the server rather than trusting the swap', async () => {
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: true }));
    await open();
    MApp.Process.load = jest.fn();

    await MApp.Process.move(0, 1);

    expect(MApp.Process.load).toHaveBeenCalled();
  });

  test('a move off the end sends nothing', async () => {
    MApp.Util.mutateSimple = jest.fn();
    await open();

    await MApp.Process.move(0, -1);

    expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();
  });
});

describe('reordering recipes', () => {
  beforeEach(mount);

  async function open() {
    MApp.BOM.token = 'tok';
    MApp.Api.call = jest.fn(async () => ({ success: true, data: PRODUCTS }));
    await MApp.BOM.open();
  }

  test('carries the unlock token, like every other BOM write', async () => {
    let call = null;
    MApp.Util.mutateSimple = jest.fn(async (m, args) => { call = { m, args }; return { success: false }; });
    await open();

    await MApp.BOM.move(0, 1);

    expect(call.m).toBe('reorderBOM');
    expect(call.args[0]).toEqual(['PRD-2', 'PRD-1']);
    expect(call.args[1]).toBe('tok');
  });

  test('an expired BOM session drops the token rather than retrying', async () => {
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: false, message: 'This section is password-protected.' }));
    await open();
    MApp.BOM._resetToken = jest.fn();

    await MApp.BOM.move(0, 1);

    expect(MApp.BOM._resetToken).toHaveBeenCalled();
  });
});

describe('bulk-deleting returns', () => {
  beforeEach(mount);

  async function open() {
    MApp.Api.callCached = jest.fn(async () => ({ success: true, data: RETURNS }));
    MApp.Api.call = jest.fn(async () => ({ success: true, data: RETURNS }));
    await MApp.Returns.load();
  }

  test('the last list without multi-select has it', async () => {
    await open();
    expect(MApp.Returns.SELECT.method).toBe('deleteReturnsBulk');
  });

  test('sends the return numbers, which is what the server keys on', async () => {
    let call = null;
    MApp.Util.mutateSimple = jest.fn(async (m, args) => { call = { m, args }; return { success: true }; });
    await open();
    MApp.Returns.load = jest.fn();

    MApp.Select._state = {
      key: 'returns', config: MApp.Returns.SELECT,
      rows: RETURNS, nodes: [], listEl: null, selected: new Set([0, 1]),
    };
    await MApp.Select.deleteSelected();

    expect(call).toEqual({ m: 'deleteReturnsBulk', args: [['RET-1', 'RET-2']] });
  });

  test('the sync banner does not break the selection interlock', async () => {
    // MApp.Select refuses to arm when the DOM and the data disagree. The
    // banner is not a .mb-card, so the counts still match.
    MApp.Api.callCached = jest.fn(async () => ({ success: true, data: RETURNS }));
    MApp.Api.call = jest.fn(async () => ({ success: true, data: RETURNS }));
    OfflineCache.outbox.countPendingForMethod = jest.fn(async () => 2);
    await MApp.Returns.load();

    const cards = document.querySelectorAll('#more-returns-list .mb-card');
    expect(cards).toHaveLength(RETURNS.length);
    expect(document.querySelector('#more-returns-list .mb-offline-banner')).not.toBeNull();
  });
});
