/**
 * A Warehouse Pool process row totals UNITS, not the sub-groups recorded
 * against them.
 *
 * A lot's colorBreakdown can carry non-counting sub-group entries -- a
 * packing set like 'Kit Bag 24"' / 'Small Kit 24"' that every unit got --
 * which are recorded PER COLOUR on units the primary axis has already
 * counted. Where those land in their own bucket, summing every leaf row
 * counts the same goods twice: the live "Packing Zara IBC" process listed
 * six combinations and reported 80 produced / 40 available where 30 and 20
 * were real.
 *
 * The server decides which buckets are units at bucket-build time (it is
 * the only place the lot's colorBreakdown is still in view) and ships the
 * verdict as countsTowardTotal -- see migration 043. This is the client
 * half: honour the flag in the totals, and say on the row why a listed
 * combination is not in them.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function loadAsGlobal(relPath) {
  const code = fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8')
    .replace(/^const App = /m, 'global.App = ');
  // eslint-disable-next-line no-eval
  eval(code);
}

global.escapeHtml = str => String(str ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const PROCESS = {
  processId: 'PRC-PACK',
  processName: 'Packing Zara IBC 24 inch 1.95 Unbranded',
  outputItemName: '24 inch Zara IBC T/Tube 1.95 Unbranded',
  sequence: 1,
  active: true,
};

function bucket(color, produced, consumed, countsTowardTotal = true) {
  return {
    outputItemName: PROCESS.outputItemName,
    processId: PROCESS.processId,
    productTag: '',
    color,
    producedQty: produced,
    consumedQty: consumed,
    availableQty: produced - consumed,
    countsTowardTotal,
  };
}

// The six combinations exactly as the live process listed them.
const LIVE_BUCKETS = [
  bucket('Green', 0, 0),
  bucket('Kit Bag 24"', 20, 10, false),
  bucket('Pink', 10, 4),
  bucket('Purple', 10, 6),
  bucket('SeaGreen', 10, 0),
  bucket('Small Kit 24"', 30, 20, false),
];

beforeEach(() => {
  // A real table: a <tr> assigned into a <div> is dropped by the parser,
  // so the rendered row would never be findable.
  document.body.innerHTML =
    '<table><thead><tr id="warehousePoolHeaderRow"></tr></thead>'
    + '<tbody id="warehousePoolTableBody"></tbody></table>'
    + '<div id="warehousePoolEmptyState"></div>';
  loadAsGlobal('core.js');
  App.Production = { formatQty: q => String(q) };
  // No grouping tiers: this is about the totals on the process row, not
  // about how rows are grouped above it.
  App.Process = { GROUP_DIMENSIONS: {}, buildRankMaps: () => [] };
  global.safeModalShow = jest.fn();
  global.Api = { call: jest.fn() };
  loadAsGlobal('stock.js');
  App.State.globalProcesses = [PROCESS];
  App.State.globalWarehousePool = LIVE_BUCKETS;
});

function renderProcessRow() {
  App.Stock.renderWarehousePoolTable();
  return document.getElementById('warehousePoolTableBody').innerHTML;
}

// Produced / Consumed / Available as the process row actually renders
// them -- read off the DOM rather than matched out of the markup, so this
// keeps testing the numbers and not the class attributes around them.
function processRowTotals() {
  App.Stock.renderWarehousePoolTable();
  const row = document.querySelector('#warehousePoolTableBody tr.pool-process-row');
  const cells = [...row.querySelectorAll('td')].map(td => td.textContent.trim());
  return cells.slice(-4, -1); // last four are produced, consumed, available, actions
}

describe('the process row leaves sub-group buckets out of its totals', () => {
  test('it reports the real 30 / 10 / 20, not 80 / 40 / 40', () => {
    expect(processRowTotals()).toEqual(['30', '10', '20']);
  });

  test('every combination is still listed -- they are excluded, not hidden', () => {
    expect(renderProcessRow()).toContain('6 combinations');
  });

  test('a bucket with the flag absent counts, matching the column default', () => {
    App.State.globalWarehousePool = [
      { ...bucket('Pink', 10, 4), countsTowardTotal: undefined },
    ];
    expect(processRowTotals()).toEqual(['10', '4', '6']);
  });
});

describe('the breakdown dialog says why a listed row is not in the total', () => {
  function leafHtml(color) {
    const row = LIVE_BUCKETS.find(b => b.color === color);
    return App.Stock.renderWarehousePoolLeafCells(PROCESS, { ...row, removable: false }, false);
  }

  test('a sub-group row is marked', () => {
    const html = leafHtml('Kit Bag 24"');
    expect(html).toContain('bi-dash-circle');
    expect(html).toContain('not added to this process');
  });

  test('a real colour row is not', () => {
    expect(leafHtml('Pink')).not.toContain('bi-dash-circle');
  });
});

/**
 * Where no production lot ever credited a bucket -- Opening Stock, an
 * inline Available Qty correction -- there is no colorBreakdown to read a
 * verdict from, and no safe way to guess one (the colour-name heuristic
 * misfiles "Green", which holds 4,985 real units). So the operator says,
 * and their answer is what these cover.
 */
describe('declaring a bucket stock or sub-group', () => {
  function leafHtml(row) {
    return App.Stock.renderWarehousePoolLeafCells(PROCESS, { ...row, removable: false }, false);
  }

  test('a counted bucket offers "mark it a sub-group"', () => {
    const html = leafHtml(bucket('Pink', 10, 4));
    expect(html).toContain('toggleWarehousePoolBucketCounts');
    expect(html).toContain('bi-check-circle');
    expect(html).toContain('mark it a sub-group');
  });

  test('an excluded bucket offers the way back', () => {
    const html = leafHtml(bucket('Kit Bag 24"', 20, 10, false));
    expect(html).toContain('Click to count it again');
  });

  test('the colour-less bucket gets no toggle -- it is the whole output', () => {
    expect(leafHtml(bucket('', 10, 0))).not.toContain('toggleWarehousePoolBucketCounts');
  });

  test('it sends the OPPOSITE of the current state, and repaints', async () => {
    const mutate = jest.fn().mockResolvedValue({ success: true, message: 'ok' });
    global.Api = { mutate };
    App.Utils.showToast = jest.fn();
    App.Stock.loadWarehousePoolData = jest.fn().mockResolvedValue();
    App.State.warehousePoolModalProcessId = PROCESS.processId;

    // A counted bucket -> ask for false.
    await App.Stock.toggleWarehousePoolBucketCounts(
      encodeURIComponent(PROCESS.outputItemName), 'PRC-PACK', '',
      encodeURIComponent('Kit Bag 24"'), false,
    );
    expect(mutate).toHaveBeenCalledWith(
      'setWarehousePoolBucketCountsTowardTotal',
      PROCESS.outputItemName, 'PRC-PACK', '', 'Kit Bag 24"', false,
    );
    expect(App.Stock.loadWarehousePoolData).toHaveBeenCalled();

    // An excluded bucket -> ask for true.
    await App.Stock.toggleWarehousePoolBucketCounts(
      encodeURIComponent(PROCESS.outputItemName), 'PRC-PACK', '',
      encodeURIComponent('Kit Bag 24"'), true,
    );
    expect(mutate).toHaveBeenLastCalledWith(
      'setWarehousePoolBucketCountsTowardTotal',
      PROCESS.outputItemName, 'PRC-PACK', '', 'Kit Bag 24"', true,
    );
  });

  test('a failure is surfaced, not swallowed', async () => {
    global.Api = { mutate: jest.fn().mockRejectedValue(new Error('nope')) };
    App.Utils.showToast = jest.fn();
    App.Stock.loadWarehousePoolData = jest.fn();

    await App.Stock.toggleWarehousePoolBucketCounts('X', 'P', '', 'C', false);
    expect(App.Utils.showToast).toHaveBeenCalledWith('nope', true);
    expect(App.Stock.loadWarehousePoolData).not.toHaveBeenCalled();
  });
});
