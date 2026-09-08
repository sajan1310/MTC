/**
 * MApp.Pool -- the Warehouse Pool, read-only (Phase 5).
 *
 * A negative bucket here is a SIGNAL, not a number to correct, and there
 * are two kinds that look identical once both are just a red minus:
 *
 *   Attribution -- nothing was ever produced in this colour, yet real
 *     consumption is recorded against it. The units are almost always in
 *     a sibling bucket under a fuller composite name: the stock exists
 *     and is misfiled. Desktop reports 189 of 241 negative units in this
 *     pool are this shape.
 *   Needs a count -- produced and consumed both moved and it still went
 *     negative. That is the one that may mean a physical recount.
 *
 * Losing that distinction buries the genuine signal among the misfiled
 * ones, so most of what follows tests the classification rather than the
 * rendering. The screen also offers no adjust, zero or delete on purpose;
 * a test asserts that stays true.
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

const MOBILE_JS = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');

// Modelled on the real shape: a composite bucket that produced, a bare
// bucket whose colour is one segment of it (the attribution case), and a
// bucket that genuinely went negative after real movement in both
// directions.
const ROWS = [
  { rowIdx: 1, outputItemName: 'Frame 26', processId: 'P1', productTag: 'KALPI', color: 'Purple-Wine / Black', producedQty: 100, consumedQty: 40, availableQty: 60 },
  { rowIdx: 2, outputItemName: 'Frame 26', processId: 'P1', productTag: '', color: 'Black', producedQty: 0, consumedQty: 25, availableQty: -25 },
  { rowIdx: 3, outputItemName: 'Fork 24', processId: 'P2', productTag: '', color: 'Red', producedQty: 80, consumedQty: 95, availableQty: -15 },
  { rowIdx: 4, outputItemName: 'Rim 20', processId: 'P3', productTag: '', color: '', producedQty: 10, consumedQty: 0, availableQty: 10 },
];

describe('MApp.Pool classification', () => {
  beforeEach(() => {
    jest.resetModules();
    global.fetch = jest.fn();
    document.body.innerHTML = `
      <div id="mapp-sheet-backdrop"></div>
      <div class="mb-sheet" id="sheet-pool">
        <div class="mb-search"><input type="search" id="pool-search"></div>
        <div class="mb-filter-chip-row" id="pool-filter-bar">
          <button class="mb-filter-chip active" data-pool-filter="all"></button>
          <button class="mb-filter-chip" data-pool-filter="negative"></button>
          <button class="mb-filter-chip" data-pool-filter="attribution"></button>
          <button class="mb-filter-chip" data-pool-filter="recount"></button>
        </div>
        <div id="pool-list"></div>
      </div>
      <div class="mb-sheet" id="sheet-pool-ledger">
        <h2 id="pool-ledger-title"></h2><div id="pool-ledger-body"></div>
      </div>`;
    loadAsGlobal('api.js', 'Api');
    loadAsGlobal('mobile.js', 'MApp');
    MApp.Sheet._stack = [];
    MApp.Paging._shown = {};
    MApp.Api.call = jest.fn(async () => ({ success: true, data: ROWS }));
  });

  const list = () => document.getElementById('pool-list').textContent;

  test('splits a composite colour into its axis values', () => {
    // Mirrors warehouse_service.color_segments; the delimiter is " / ".
    expect(MApp.Pool.colorSegments('Purple-Wine / Black')).toEqual(['Purple-Wine', 'Black']);
    expect(MApp.Pool.colorSegments('Black')).toEqual(['Black']);
    expect(MApp.Pool.colorSegments('')).toEqual([]);
  });

  test('a bucket that never produced but consumed is an attribution case', () => {
    expect(MApp.Pool.isAttribution(ROWS[1])).toBe(true);
    expect(MApp.Pool.needsCount(ROWS[1])).toBe(false);
  });

  test('a bucket that moved both ways and still went negative may need a count', () => {
    expect(MApp.Pool.needsCount(ROWS[2])).toBe(true);
    expect(MApp.Pool.isAttribution(ROWS[2])).toBe(false);
  });

  test('a healthy bucket is neither', () => {
    expect(MApp.Pool.isAttribution(ROWS[0])).toBe(false);
    expect(MApp.Pool.needsCount(ROWS[0])).toBe(false);
  });

  test('a colourless negative is not classed as attribution', () => {
    // The attribution shape depends on a colour the credit side never
    // used; without a colour there is no sibling to be misfiled into.
    const row = { outputItemName: 'X', color: '', producedQty: 0, consumedQty: 5, availableQty: -5 };
    expect(MApp.Pool.isAttribution(row)).toBe(false);
    expect(MApp.Pool.needsCount(row)).toBe(true);
  });

  test('names the sibling buckets whose colour contains this one', async () => {
    await MApp.Pool.open();

    expect(MApp.Pool.siblings(ROWS[1])).toEqual(['Purple-Wine / Black']);
    // A genuine negative has no sibling to point at.
    expect(MApp.Pool.siblings(ROWS[2])).toEqual([]);
  });

  test('a sibling must have actually produced', async () => {
    MApp.Api.call = jest.fn(async () => ({
      success: true,
      data: [
        { outputItemName: 'Frame 26', color: 'Purple-Wine / Black', producedQty: 0, consumedQty: 3, availableQty: -3 },
        { outputItemName: 'Frame 26', color: 'Black', producedQty: 0, consumedQty: 25, availableQty: -25 },
      ],
    }));
    await MApp.Pool.open();

    // Both are bare; neither can be where the units went.
    expect(MApp.Pool.siblings(MApp.Pool.rows[1])).toEqual([]);
  });
});

describe('MApp.Pool screen', () => {
  beforeEach(() => {
    jest.resetModules();
    global.fetch = jest.fn();
    document.body.innerHTML = `
      <div id="mapp-sheet-backdrop"></div>
      <div class="mb-sheet" id="sheet-pool">
        <div class="mb-search"><input type="search" id="pool-search"></div>
        <div class="mb-filter-chip-row" id="pool-filter-bar">
          <button class="mb-filter-chip active" data-pool-filter="all"></button>
          <button class="mb-filter-chip" data-pool-filter="negative"></button>
          <button class="mb-filter-chip" data-pool-filter="attribution"></button>
          <button class="mb-filter-chip" data-pool-filter="recount"></button>
        </div>
        <div id="pool-list"></div>
      </div>
      <div class="mb-sheet" id="sheet-pool-ledger">
        <h2 id="pool-ledger-title"></h2><div id="pool-ledger-body"></div>
      </div>`;
    loadAsGlobal('api.js', 'Api');
    loadAsGlobal('mobile.js', 'MApp');
    MApp.Sheet._stack = [];
    MApp.Paging._shown = {};
    MApp.Api.call = jest.fn(async () => ({ success: true, data: ROWS }));
  });

  const list = () => document.getElementById('pool-list').textContent;

  test('summarises the negatives by kind, not just by count', async () => {
    await MApp.Pool.open();

    expect(list()).toContain('2 negative buckets');
    expect(list()).toContain('1 look like attribution');
    expect(list()).toContain('1 may need a physical count');
  });

  test('an attribution bucket says where the units probably are', async () => {
    await MApp.Pool.open();

    expect(list()).toContain('Never produced in this colour');
    expect(list()).toContain('Likely belongs to: Purple-Wine / Black');
    expect(list()).toContain('not a shortage');
  });

  test('a genuine negative says a count may be owed', async () => {
    await MApp.Pool.open();
    expect(list()).toContain('may need a physical count');
  });

  test('an attribution bucket with no sibling says to check the recipe', async () => {
    MApp.Api.call = jest.fn(async () => ({
      success: true,
      data: [{ outputItemName: 'Frame 26', color: 'Teal', producedQty: 0, consumedQty: 4, availableQty: -4 }],
    }));
    await MApp.Pool.open();

    expect(list()).toContain('No sibling bucket carries this colour');
  });

  test('the filters isolate each kind', async () => {
    await MApp.Pool.open();

    MApp.Pool.filterBy('attribution');
    expect(MApp.Pool.filtered.map(r => r.rowIdx)).toEqual([2]);

    MApp.Pool.filterBy('recount');
    expect(MApp.Pool.filtered.map(r => r.rowIdx)).toEqual([3]);

    MApp.Pool.filterBy('negative');
    expect(MApp.Pool.filtered.map(r => r.rowIdx).sort()).toEqual([2, 3]);

    MApp.Pool.filterBy('all');
    expect(MApp.Pool.filtered).toHaveLength(4);
  });

  test('search composes with the filter', async () => {
    await MApp.Pool.open();
    MApp.Pool.filterBy('negative');
    MApp.Pool.onSearch('fork');

    expect(MApp.Pool.filtered.map(r => r.outputItemName)).toEqual(['Fork 24']);
  });

  test('the ledger is fetched with three separate arguments', async () => {
    // Api.call is variadic: passing these as one array yields HTTP 200,
    // success true and a silently EMPTY ledger. The server's own
    // docstring calls that trap out.
    await MApp.Pool.open();
    MApp.Api.call = jest.fn(async () => ({ success: true, data: [] }));

    await MApp.Pool.openLedger(ROWS[1]);

    expect(MApp.Api.call).toHaveBeenCalledWith(
      'getWarehousePoolLedger', 'Frame 26', '', 'Black'
    );
  });

  test('the ledger renders movements with the running balance', async () => {
    await MApp.Pool.open();
    MApp.Api.call = jest.fn(async () => ({
      success: true,
      data: [
        { date: '1 Aug', dateRaw: '2026-08-01', type: 'Production Credit', ref: 'LOT-1', remarks: '', inQty: 100, outQty: 0, balance: 100 },
        { date: '3 Aug', dateRaw: '2026-08-03', type: 'Dispatch', ref: 'DC-2', remarks: '', inQty: 0, outQty: 40, balance: 60 },
      ],
    }));

    await MApp.Pool.openLedger(ROWS[0]);
    const body = document.getElementById('pool-ledger-body').textContent;

    expect(body).toContain('Production Credit');
    expect(body).toContain('+100');
    expect(body).toContain('-40');
    expect(body).toContain('bal 60');
  });

  test('a failed load offers a retry rather than an empty list', async () => {
    MApp.Api.call = jest.fn(async () => { throw new Error('offline'); });
    await MApp.Pool.open();

    expect(document.querySelector('#pool-list .mb-state-retry')).not.toBeNull();
  });
});

describe('a negative bucket cannot be tidied away', () => {
  // This screen was read-only until the pool writes were ported, on the
  // reasoning that a negative bucket is evidence and the floor's job is
  // to SEE it. That reasoning has not changed -- but "no writes at all"
  // was a blunt way to hold it, and it also meant a genuine recount
  // could not be entered where the count happens. What is enforced now
  // is the thing that actually mattered: the correction exists, and it
  // refuses the one move that erases the evidence.
  const poolSource = () => {
    const start = MOBILE_JS.indexOf('MApp.Pool = {');
    const next = MOBILE_JS.slice(start + 1).search(/\nMApp\.[A-Z][A-Za-z]* = \{/);
    const src = MOBILE_JS.slice(start, start + 1 + next);
    if (!src.trim()) throw new Error('MApp.Pool source slice came back empty');
    return src;
  };

  test('the attribution refusal is still in the correction path', () => {
    // Zeroing an attribution negative hides it without moving a part:
    // the units were credited to a sibling colour, and the bare bucket
    // is what the next stage's checklist reads.
    const src = poolSource();

    expect(src).toContain('this.isAttribution(row) && row.availableQty < 0 && newQty >= 0');
    expect(src).toContain('adjustWarehousePoolManually');
  });

  test('the refusal sits BEFORE the request, not after it', () => {
    const src = poolSource();
    const guard = src.indexOf('this.isAttribution(row) && row.availableQty < 0 && newQty >= 0');
    const send = src.indexOf("'adjustWarehousePoolManually'");

    expect(guard).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(guard);
  });

  test('every correction carries a reason and a confirmation', () => {
    const src = poolSource();

    expect(src).toContain('A reason is required');
    expect(src).toContain('window.confirm(');
  });

  test('never derives the ledger client-side', () => {
    // The endpoint's docstring records that the client used to assemble
    // this and had drifted from the backend in five separate ways.
    expect(MOBILE_JS).toContain("MApp.Api.call('getWarehousePoolLedger'");
  });
});
