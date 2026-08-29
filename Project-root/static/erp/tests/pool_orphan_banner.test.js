/**
 * Warehouse Pool buckets stranded on a process that no longer exists.
 *
 * renderWarehousePoolTable builds its rows by walking the LIVE process list,
 * so a bucket whose process was deleted was rendered nowhere at all -- while
 * getWarehousePoolData still returned it and every total derived from it
 * still counted it. "14 inch Ford D/Gaddi Steel Rim" [Blue] sat at -19 on
 * hard-deleted process PRC-1017 exactly that way: a balance no operator could
 * see, let alone correct.
 *
 * The banner exists to be acted on, so it only carries buckets that still
 * hold a balance. One that nets to zero has no stock to account for and
 * nothing to correct; listing it would train people to ignore the banner.
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

function bucket(overrides) {
  return {
    outputItemName: 'Some Item',
    processId: 'PRC-DEAD',
    productTag: '',
    color: 'Blue',
    producedQty: 0,
    consumedQty: 0,
    availableQty: 0,
    ...overrides,
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  loadAsGlobal('core.js');
  App.Production = { formatQty: q => String(q) };
  global.safeModalShow = jest.fn();
  global.Api = { call: jest.fn() };
  loadAsGlobal('stock.js');
  App.State.globalProcesses = [{ processId: 'PRC-LIVE', processName: 'Live', outputItemName: 'X' }];
});

describe('orphanedPoolBuckets', () => {
  test('flags a bucket whose process no longer exists and still holds stock', () => {
    App.State.globalWarehousePool = [
      bucket({ outputItemName: '14 inch Ford D/Gaddi Steel Rim', producedQty: -19, availableQty: -19 }),
    ];
    const orphans = App.Stock.orphanedPoolBuckets();
    expect(orphans).toHaveLength(1);
    expect(orphans[0].outputItemName).toBe('14 inch Ford D/Gaddi Steel Rim');
  });

  test('a positive stranded balance counts too, not just a negative one', () => {
    App.State.globalWarehousePool = [bucket({ producedQty: 40, availableQty: 40 })];
    expect(App.Stock.orphanedPoolBuckets()).toHaveLength(1);
  });

  test('a stranded bucket that nets to zero is NOT flagged', () => {
    // Nothing to correct and no stock to account for -- carrying it would
    // make the banner noise rather than a worklist.
    App.State.globalWarehousePool = [bucket({ producedQty: 20, consumedQty: 20, availableQty: 0 })];
    expect(App.Stock.orphanedPoolBuckets()).toEqual([]);
  });

  test('a bucket on a LIVE process is never flagged, balance or not', () => {
    App.State.globalWarehousePool = [bucket({ processId: 'PRC-LIVE', availableQty: -19 })];
    expect(App.Stock.orphanedPoolBuckets()).toEqual([]);
  });

  test('the banner names the item, the balance and the missing process', () => {
    App.State.globalWarehousePool = [
      bucket({ outputItemName: '14 inch Ford D/Gaddi Steel Rim', availableQty: -19 }),
    ];
    const html = App.Stock.renderOrphanedPoolBanner(9);
    expect(html).toContain('14 inch Ford D/Gaddi Steel Rim');
    expect(html).toContain('-19');
    expect(html).toContain('PRC-DEAD');
    expect(html).toContain('colspan="9"');
  });

  test('no orphans means no banner at all', () => {
    App.State.globalWarehousePool = [bucket({ processId: 'PRC-LIVE', availableQty: 5 })];
    expect(App.Stock.renderOrphanedPoolBanner(9)).toBe('');
  });
});
