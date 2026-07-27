/**
 * Regression test for App.Stock.buildPoolLedgerRows (../stock.js), run
 * against the real source (not a reimplementation) via a require() of the
 * actual file. A zero/negative colorBreakdown or componentsConsumed qty on
 * a Production lot is a legitimate correction/reversal (see
 * warehouse_service._recalculate_warehouse_pool, which already folds it
 * into the real Total Available) -- it must show up as an In/Out entry
 * split by sign, not be silently dropped the way a positive-only qty
 * filter used to drop it.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function loadAsGlobal(relPath) {
  const code = fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
  eval(code);
}

describe('App.Stock.buildPoolLedgerRows', () => {
  beforeEach(() => {
    global.App = {
      State: {
        globalProduction: [],
        globalDispatch: [],
        globalWarehousePoolOpening: [],
        globalWarehousePoolAdjustments: [],
        globalProcesses: [],
      },
    };
    loadAsGlobal('stock.js');
  });

  test('a negative colorBreakdown qty (correction lot) shows as an Out, not dropped', () => {
    App.State.globalProduction = [
      {
        status: 'Completed',
        outputItemName: 'Widget',
        productId: '',
        dateRaw: '2026-01-01',
        date: '01/01/2026',
        lotNumber: 'LOT-1',
        remarks: '',
        colorBreakdown: [{ color: 'Red', qty: -3 }],
        componentsConsumed: [],
      },
    ];

    const rows = App.Stock.buildPoolLedgerRows('Widget', '', 'Red');
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('Production Credit');
    expect(rows[0].inQty).toBe(0);
    expect(rows[0].outQty).toBe(3);
  });

  test('a positive colorBreakdown qty still shows as an In', () => {
    App.State.globalProduction = [
      {
        status: 'Completed',
        outputItemName: 'Widget',
        productId: '',
        dateRaw: '2026-01-01',
        date: '01/01/2026',
        lotNumber: 'LOT-2',
        remarks: '',
        colorBreakdown: [{ color: 'Red', qty: 5 }],
        componentsConsumed: [],
      },
    ];

    const rows = App.Stock.buildPoolLedgerRows('Widget', '', 'Red');
    expect(rows).toHaveLength(1);
    expect(rows[0].inQty).toBe(5);
    expect(rows[0].outQty).toBe(0);
  });

  test('a zero colorBreakdown qty is dropped (nothing to show)', () => {
    App.State.globalProduction = [
      {
        status: 'Completed',
        outputItemName: 'Widget',
        productId: '',
        dateRaw: '2026-01-01',
        date: '01/01/2026',
        lotNumber: 'LOT-3',
        remarks: '',
        colorBreakdown: [{ color: 'Red', qty: 0 }],
        componentsConsumed: [],
      },
    ];

    const rows = App.Stock.buildPoolLedgerRows('Widget', '', 'Red');
    expect(rows).toHaveLength(0);
  });

  test('a negative POOL componentsConsumed qty (reversal) shows as an In, not dropped', () => {
    // A different lot (Downstream) consumes Widget from the pool -- kept
    // distinct from Widget's own output so this fixture only exercises the
    // consumption branch, not also the unrelated production-credit branch.
    App.State.globalProduction = [
      {
        status: 'Completed',
        outputItemName: 'Downstream',
        productId: '',
        dateRaw: '2026-01-01',
        date: '01/01/2026',
        lotNumber: 'LOT-4',
        remarks: '',
        colorBreakdown: [],
        componentsConsumed: [
          { sourceType: 'POOL', itemName: 'Widget', colorGroup: 'COMMON', qty: -2 },
        ],
      },
    ];

    const rows = App.Stock.buildPoolLedgerRows('Widget', '', '');
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('Production Consumption');
    expect(rows[0].inQty).toBe(2);
    expect(rows[0].outQty).toBe(0);
  });

  test('a positive POOL componentsConsumed qty still shows as an Out', () => {
    App.State.globalProduction = [
      {
        status: 'Completed',
        outputItemName: 'Downstream',
        productId: '',
        dateRaw: '2026-01-01',
        date: '01/01/2026',
        lotNumber: 'LOT-5',
        remarks: '',
        colorBreakdown: [],
        componentsConsumed: [
          { sourceType: 'POOL', itemName: 'Widget', colorGroup: 'COMMON', qty: 4 },
        ],
      },
    ];

    const rows = App.Stock.buildPoolLedgerRows('Widget', '', '');
    expect(rows).toHaveLength(1);
    expect(rows[0].inQty).toBe(0);
    expect(rows[0].outQty).toBe(4);
  });
});
