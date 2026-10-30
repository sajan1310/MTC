/**
 * The cost hints on an edit.
 *
 * An edited lot or dispatch keeps the rate it was saved with unless its
 * contractor changes (save_production, save_dispatch). The hints read the
 * rate card, so left alone they would promise Rs 150 while the save kept
 * Rs 100. They show what the save will do, and say so when the card differs.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function loadGlobals() {
  // eslint-disable-next-line no-eval
  eval([
    read('api.js'),
    'global.escapeHtml = escapeHtml;',
    'global.toNumber = toNumber;',
    'global.formatCurrency = formatCurrency;',
    'global.formatQty = formatQty;',
  ].join('\n'));
  global.$ = (sel, root = document) => root.querySelector(sel);
  global.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  global.todayIso = () => '2026-01-01';
  global.parseRecordDate = () => 0;
}

function utils() {
  const source = read('core.js');
  const grab = name => {
    const at = source.indexOf(`    ${name}(`);
    const end = source.indexOf('\n    },', at);
    return source.slice(at, end + 7);
  };
  // eslint-disable-next-line no-eval
  return eval(`({\n${grab('sameText')}\n${grab('keptRate')}\n})`);
}

const card = rate => jest.fn(async () => ({ success: true, data: { ratePerUnit: rate } }));

describe('App.Utils.keptRate', () => {
  beforeAll(loadGlobals);

  test('the same contractor keeps the saved rate, whatever the case', () => {
    expect(utils().keptRate('Rakesh', 100, ' RAKESH ')).toBe(100);
  });

  test('a different contractor keeps nothing, so the card decides', () => {
    expect(utils().keptRate('Rakesh', 100, 'Sanjay')).toBe(0);
  });

  test('a rate of nothing is nothing to keep', () => {
    expect(utils().keptRate('Rakesh', 0, 'Rakesh')).toBe(0);
  });
});

describe('Production lot Payable hint', () => {
  const PROCESS = { processId: 'P1', processType: 'Paint', outputItemName: 'Frame' };
  const SAVED = {
    rowIdx: 7, assignedTo: 'Rakesh', contractorRate: 100,
    extraChargeType: 'Polish', extraChargeAmount: 50,
  };

  beforeAll(() => {
    loadGlobals();
    global.App = { State: {}, Utils: {} };
    // eslint-disable-next-line no-eval
    eval(read('production.js').replace(/^const App\b.*$/m, ''));
  });

  function open({ rowIdx = '7', contractor = 'Rakesh', charge = 'Polish', amount = 80 } = {}) {
    document.body.innerHTML = `
      <div id="productionPayableHint"></div>
      <input id="productionRowIdx" value="${rowIdx}">
      <input id="productionAssignedTo" value="${contractor}">
      <input id="productionProcessId" value="P1">
      <div id="productionExtraChargeOptions">
        <input type="radio" name="extraChargeType" value="${charge}"
               data-charge-amount="${amount}" checked>
      </div>`;
    Object.assign(global.App.State, { globalProcesses: [PROCESS], globalProduction: [SAVED] });
    Object.assign(global.App.Utils, utils(), {
      getSizeFromOutputItemName: () => 'General',
      formatNameCase: s => s,
    });
    global.App.Production._currentComponentQtyMultiplier = () => 4;
    global.App.Production.formatQty = q => String(q);
  }

  const hint = () => document.getElementById('productionPayableHint').innerText;

  test('an edit shows the saved rate and charge, and that the card differs', async () => {
    open();
    global.Api = { call: card(150) };

    await global.App.Production._refreshPayableHintNow();

    expect(hint()).toContain('₹600.00'); // (100 + 50) x 4
    expect(hint()).toContain('Saved rate kept; the rate card says 150');
  });

  test('the same rate on the card needs no remark', async () => {
    open();
    global.Api = { call: card(100) };

    await global.App.Production._refreshPayableHintNow();

    expect(hint()).not.toContain('Saved rate kept');
  });

  test('a different contractor is priced from their card', async () => {
    open({ contractor: 'Sanjay' });
    global.Api = { call: card(30) };

    await global.App.Production._refreshPayableHintNow();

    expect(hint()).toContain('₹440.00'); // (30 + 80) x 4
    expect(hint()).not.toContain('Saved rate kept');
  });

  test('another extra charge is priced from the card, the rate still kept', async () => {
    open({ charge: 'Buffing', amount: 20 });
    global.Api = { call: card(150) };

    await global.App.Production._refreshPayableHintNow();

    expect(hint()).toContain('₹480.00'); // (100 + 20) x 4
  });

  test('a new lot has nothing to keep', async () => {
    open({ rowIdx: '' });
    global.Api = { call: card(150) };

    await global.App.Production._refreshPayableHintNow();

    expect(hint()).toContain('₹920.00'); // (150 + 80) x 4
  });

  test('a saved lot holding no rate takes the card, like the save', async () => {
    open();
    global.App.State.globalProduction = [{ ...SAVED, contractorRate: 0, extraChargeAmount: 0 }];
    global.Api = { call: card(150) };

    await global.App.Production._refreshPayableHintNow();

    expect(hint()).toContain('₹920.00'); // (150 + 80) x 4
    expect(hint()).not.toContain('Saved rate kept');
  });
});

describe('Dispatch Logistics Cost hint', () => {
  beforeAll(() => {
    loadGlobals();
    global.App = { State: {}, Utils: {} };
    // eslint-disable-next-line no-eval
    eval(read('dispatch.js'));
  });

  function open({ number = 'DSP-1', contractor = 'Ravi' } = {}) {
    document.body.innerHTML = `
      <div id="dispatchLogisticsCostHint"></div>
      <input id="dispatchNumberHidden" value="${number}">
      <input id="dispatchLogisticsContractor" value="${contractor}">
      <table><tbody id="dispatchLinesBody">
        <tr><td><input class="dispatch-line-qty" value="3"></td></tr>
        <tr><td><input class="dispatch-line-qty" value="1"></td></tr>
      </tbody></table>`;
    Object.assign(global.App.Utils, utils(), { formatNameCase: s => s });
    global.App.State.globalDispatchBills = [
      { dispatchNumber: 'DSP-1', logisticsContractor: 'Ravi', logisticsRate: 7 },
    ];
  }

  const hint = () => document.getElementById('dispatchLogisticsCostHint').innerText;

  test('an edit shows the saved rate, and that the card differs', async () => {
    open();
    global.Api = { call: card(9) };

    await global.App.Dispatch.refreshLogisticsCostHint();

    expect(hint()).toContain('₹28.00'); // 7 x 4
    expect(hint()).toContain('Saved rate kept; the rate card says 9');
  });

  test('a different contractor is priced from their card', async () => {
    open({ contractor: 'Mohan' });
    global.Api = { call: card(4) };

    await global.App.Dispatch.refreshLogisticsCostHint();

    expect(hint()).toContain('₹16.00'); // 4 x 4
    expect(hint()).not.toContain('Saved rate kept');
  });

  test('a new dispatch has nothing to keep', async () => {
    open({ number: '' });
    global.Api = { call: card(9) };

    await global.App.Dispatch.refreshLogisticsCostHint();

    expect(hint()).toContain('₹36.00'); // 9 x 4
  });
});
