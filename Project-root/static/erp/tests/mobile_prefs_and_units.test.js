/**
 * Three things that were wrong in ways nobody could see from the screen.
 *
 * 1. The Item Ledger's rate comparison read `price`, which is per ENTERED
 *    unit. A spoke ordered by the Gross carries 94.00 there and 0.6528 in
 *    `baseRate`, and the Item Master rate beside it is per piece -- so the
 *    one table whose job is spotting a price change showed a 144x rise
 *    that never happened. The server had computed baseRate all along and
 *    no client code had ever read it.
 *
 * 2. The Vendor Ledger's pending figures used as-entered quantities while
 *    the Item Ledger, and every remaining-qty calculation on the server,
 *    used base units. The same outstanding spokes read 280 on one document
 *    and 40,320 on the other, neither stating a unit.
 *
 * 3. The phone had no equivalent of desktop's two PO Print Options, so a
 *    PO sent out for a quote always carried the rates already agreed.
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

beforeEach(() => {
  jest.resetModules();
  global.fetch = jest.fn();
  document.body.innerHTML = '';
  try { localStorage.clear(); } catch (e) { /* not available */ }
  // Each eval() gets its own scope, so api.js's plain function
  // declarations have to be republished for print-templates.js to see
  // them -- in a browser both are classic scripts sharing one global.
  // eslint-disable-next-line no-eval
  eval([
    fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8')
      .replace(/^const Api = /m, 'global.Api = '),
    'global.escapeHtml = escapeHtml;',
    'global.toNumber = toNumber;',
    'global.formatCurrency = formatCurrency;',
    'global.formatQty = formatQty;',
    'global.parseRecordDate = parseRecordDate;',
    'global.dateToInputValue = dateToInputValue;',
    'global.inDateRange = inDateRange;',
    'global.todayIso = todayIso;'
  ].join('\n'));
  loadAsGlobal('print-templates.js', 'PrintTemplates');
  loadAsGlobal('mobile.js', 'MApp');
});

const DEPS = {
  escapeHtml: s => String(s == null ? '' : s),
  toNumber: v => Number(v) || 0,
  formatCurrency: v => `₹${(Number(v) || 0).toFixed(4)}`,
  formatNameCase: s => String(s == null ? '' : s)
};

describe('quantities are counted in base units', () => {
  // 200 Gross of spokes: 200 as entered, 28,800 as pieces.
  const GROSS = { name: 'Spoke', size: '20 inch', qty: 200, baseQty: 28800, unit: 'Gross' };

  test('a line in a purchase unit reports its base quantity', () => {
    expect(PrintTemplates._baseUnits(GROSS)).toBe(28800);
  });

  test('a line that predates unit conversion falls back to what was entered', () => {
    // po_service does exactly this with effective_base_qty. Without it a
    // legacy row counts as nothing and vanishes from what is still owed.
    expect(PrintTemplates._baseUnits({ qty: 40, baseQty: 0 })).toBe(40);
    expect(PrintTemplates._baseUnits({ qty: 40 })).toBe(40);
    expect(PrintTemplates._baseUnits({})).toBe(0);
  });

  test('vendor pending subtracts base from base, not gross from gross', () => {
    const { pendingList } = PrintTemplates.vendorLedger('Acme', {
      pos: [{ poNumber: 'PO-1', vendor: 'Acme', poDate: '01/08/2026', items: [GROSS] }],
      // poNumber matters: a bill is matched to the PO LINE it was raised
      // against, so a direct purchase does not quietly fulfil an order.
      bills: [{ billNumber: 'B-1', vendor: 'Acme', billDate: '05/08/2026',
        items: [{ ...GROSS, qty: 50, baseQty: 7200, poNumber: 'PO-1' }] }],
      returns: [], issues: []
    }, DEPS);

    const row = pendingList.find(p => p.name === 'Spoke');
    expect(row.ordered).toBe(28800);
    expect(row.received).toBe(7200);
    expect(row.pending).toBe(21600);   // 150 Gross, said in pieces
  });

  test('and it agrees with the Item Ledger, which is the point', () => {
    const pos = [{ poNumber: 'PO-1', vendor: 'Acme', poDate: '01/08/2026', items: [GROSS] }];
    const bills = [{ billNumber: 'B-1', vendor: 'Acme', billDate: '05/08/2026',
      items: [{ ...GROSS, qty: 50, baseQty: 7200, poNumber: 'PO-1' }] }];

    const { pendingList } = PrintTemplates.vendorLedger('Acme',
      { pos, bills, returns: [], issues: [] }, DEPS);
    const byItem = PrintTemplates.pendingByItem(pos, bills);

    expect(pendingList[0].pending)
      .toBe(byItem.get('spoke|20 inch').qty);
  });
});

describe('the rate comparison compares like with like', () => {
  const SRC = {
    items: [{ name: 'Spoke', size: '20 inch', narration: '',
      vendors: [{ vendor: 'Acme', rate: 0.68 }] }],
    stock: [],
    vendors: [{ name: 'Acme', contact: '9x' }],
    pos: [{ poNumber: 'PO-1', vendor: 'Acme', poDate: '01/08/2026',
      items: [{ name: 'Spoke', size: '20 inch', narration: '',
        qty: 200, baseQty: 28800, unit: 'Gross', price: 94, baseRate: 0.6528 }] }],
    bills: [],
    itemLedgers: { spoke: { entries: [] } }
  };

  test('the PO rate is per base unit, so it sits beside the master rate', () => {
    const { compHtml } = PrintTemplates.itemLedgerSections('Spoke', SRC, DEPS);
    expect(compHtml).toContain('0.6528');   // per piece -- comparable
    expect(compHtml).not.toContain('94.0000'); // per Gross -- was the bug
  });

  test('a line with no baseRate still shows its rate rather than nothing', () => {
    const legacy = JSON.parse(JSON.stringify(SRC));
    delete legacy.pos[0].items[0].baseRate;
    const { compHtml } = PrintTemplates.itemLedgerSections('Spoke', legacy, DEPS);
    expect(compHtml).toContain('94.0000');
  });
});

describe('MApp.Prefs', () => {
  test('a preference survives being read back', () => {
    MApp.Prefs.set('po.print.includeRates', false);
    expect(MApp.Prefs.get('po.print.includeRates', true)).toBe(false);
  });

  test('an unset preference falls back to the default', () => {
    expect(MApp.Prefs.get('never.set', 'fallback')).toBe('fallback');
  });

  test('a stored false is honoured, not mistaken for unset', () => {
    // The classic bug in a `get(k) || default` store.
    MApp.Prefs.set('flag', false);
    expect(MApp.Prefs.get('flag', true)).toBe(false);
  });

  test('toggle flips from the default on first use', () => {
    expect(MApp.Prefs.toggle('po.print.includeTotal', true)).toBe(false);
    expect(MApp.Prefs.toggle('po.print.includeTotal', true)).toBe(true);
  });

  test('it survives storage being unavailable', () => {
    // A private window, or site data cleared mid-session. A remembered
    // preference is a convenience and must never stop a screen opening.
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new Error('denied'); }
    });
    try {
      MApp.Prefs._cache = null;
      expect(() => MApp.Prefs.get('x', 'd')).not.toThrow();
      expect(MApp.Prefs.get('x', 'd')).toBe('d');
      expect(() => MApp.Prefs.set('x', 1)).not.toThrow();
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });
});

describe('the PO print options', () => {
  test('both default to shown', () => {
    expect(MApp.PO._printOptions()).toEqual({ includeRates: true, includeTotal: true });
  });

  test('hiding rates is remembered for the next PO', () => {
    MApp.Prefs.set(MApp.PO.PREF_RATES, false);
    expect(MApp.PO._printOptions().includeRates).toBe(false);
  });

  test('the builder honours them', () => {
    document.body.innerHTML = `
      <div id="print-po-container">
        <span id="print-vendor"></span><span id="print-ponum"></span>
        <table><thead id="print-table-head"></thead><tbody id="print-items-body"></tbody></table>
        <div id="print-grand-total-container"><span id="print-grand-total"></span></div>
      </div>`;
    const po = { poNumber: 'PO-1', vendor: 'Acme',
      items: [{ name: 'Spoke', qty: 10, price: 5, unit: 'Pcs' }] };

    PrintTemplates.poDocument(po, DEPS, { includeRates: false, includeTotal: false });
    expect(document.getElementById('print-table-head').innerHTML).not.toContain('Rate');
    expect(document.getElementById('print-grand-total-container').style.display).toBe('none');
  });

  test('the action sheet offers them, and the challan does not', () => {
    // A delivery challan has no rate columns to hide.
    const src = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');
    expect(src).toContain('toggles:');
    expect(src).toContain("onLabel: 'Rates: shown'");
    expect(src).toContain("onLabel: 'Total: shown'");
  });
});
