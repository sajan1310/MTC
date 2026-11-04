/**
 * The Item Ledger's "Master Rates & Comparison" table sets Items Master's
 * rate for each vendor beside that vendor's latest PO rate, and both have
 * to be per base unit for the comparison to mean anything.
 *
 * The PO side has been the line's baseRate since 2026-09-12. Items Master
 * keeps a vendor's rate per its Purchase Unit, and since 2026-10-09 a rim
 * spoke bought by the Gross is filed at Rs 94 a Gross -- so the table set
 * Rs 94 beside Rs 0.65 and read as a 144x drop that never happened.
 * getItemsData sends each vendor's ratePerBaseUnit for exactly this.
 */

'use strict';

const fs = require('fs');
const path = require('path');

beforeEach(() => {
  jest.resetModules();
  document.body.innerHTML = '';
  // eslint-disable-next-line no-eval
  eval([
    fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8')
      .replace(/^const Api = /m, 'global.Api = '),
    'global.escapeHtml = escapeHtml;',
    'global.parseRecordDate = parseRecordDate;'
  ].join('\n'));
  // eslint-disable-next-line no-eval
  eval(
    fs.readFileSync(path.join(__dirname, '..', 'print-templates.js'), 'utf8')
      .replace(/^const PrintTemplates = /m, 'global.PrintTemplates = ')
  );
});

const DEPS = {
  escapeHtml: s => String(s == null ? '' : s),
  toNumber: v => Number(v) || 0,
  formatCurrency: v => `Rs ${(Number(v) || 0).toFixed(2)}`,
  getPendingByItem: () => new Map()
};

function comparisonCells(src) {
  const { compHtml } = PrintTemplates.itemLedgerSections('R-SPOKE 16', {
    items: [], stock: [], vendors: [], pos: [], bills: [], itemLedgers: {}, ...src
  }, DEPS);
  const table = document.createElement('table');
  table.innerHTML = compHtml;
  const row = table.querySelector('tr');
  const cells = [...row.querySelectorAll('td')].map(td => td.textContent.trim());
  return { master: cells[4], po: cells[5] };
}

const SPOKE_BY_THE_GROSS = {
  name: 'R-SPOKE 16',
  size: '',
  baseUnit: 'Pcs',
  purchaseUnit: 'Gross',
  vendors: [{ vendor: 'Tushar', rate: 94, ratePerBaseUnit: 94 / 144 }]
};

const PO_IN_GROSS = {
  vendor: 'Tushar',
  poDateRaw: '2026-10-20',
  items: [{ name: 'R-SPOKE 16', size: '', narration: '', unit: 'Gross', price: 94, baseRate: 94 / 144 }]
};

describe('the Item Ledger compares rates per base unit', () => {
  test('a vendor rate filed per Gross sits beside the PO rate per piece', () => {
    const { master, po } = comparisonCells({ items: [SPOKE_BY_THE_GROSS], pos: [PO_IN_GROSS] });

    expect(po).toBe('Rs 0.65');
    expect(master).toBe('Rs 0.65');
  });

  test('a vendor with no PO still shows its rate per base unit', () => {
    const { master, po } = comparisonCells({ items: [SPOKE_BY_THE_GROSS] });

    expect(master).toBe('Rs 0.65');
    expect(po).toBe('-');
  });

  test('a rate with no per-base-unit figure is shown as it was filed', () => {
    const item = { ...SPOKE_BY_THE_GROSS, vendors: [{ vendor: 'Tushar', rate: 12 }] };

    expect(comparisonCells({ items: [item] }).master).toBe('Rs 12.00');
  });
});
