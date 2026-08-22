/**
 * Regression test for the Work Order PDF's colour table geometry
 * (App.Production._buildWorkOrderHtml, ../production.js).
 *
 * The bug: with five colour columns the table ran off the right edge of the
 * A4 page, cutting the last colour and the Total figure out of the PDF. The
 * widths were already correct arithmetic -- five columns at 20% -- but they
 * were CONTENT widths, so each column quietly added its own 8px of padding
 * and its border on top of its 20% share and the table came out ~46px wider
 * than the page.
 *
 * Why it is pinned structurally rather than by measuring: jsdom does no
 * layout, so nothing here can observe the overflow directly. What it can do
 * is hold the two properties the arithmetic depends on -- every width-bearing
 * cell measures border-box, and the widths across a band sum to 100% -- which
 * is exactly the pair that silently broke.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function loadProductionAsGlobal() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'production.js'), 'utf8');
  // eslint-disable-next-line no-eval
  eval(code);
}

function mount() {
  document.body.innerHTML = '';
  global.escapeHtml = value => String(value).replace(/[&<>"']/g, ch => HTML_ESCAPE_MAP[ch]);
  global.toNumber = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  global.$ = (sel, root = document) => root.querySelector(sel);
  global.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  global.formatCurrency = v => String(v);
  global.todayIso = () => '2026-08-24';
  global.parseRecordDate = () => 0;

  global.App = {
    State: { globalItems: [], globalColors: [], globalProcesses: [], globalProduction: [] },
    Utils: {
      sameText: (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase(),
      sameColor(a, b) { return this.sameText(a, b); },
      isCommonColorGroup: g => String(g ?? '').trim().toUpperCase() === 'COMMON',
      formatNameCase: v => String(v ?? ''),
      showToast: () => {},
    },
    Print: { brandHeaderHtml: () => '<div class="brand"></div>' },
  };

  loadProductionAsGlobal();
}

// The lot from the report: five composite colours on one output item.
const FIVE_COLOR_LOT = [{
  date: '24/08/2026',
  lotNumber: 'LOT-PKG010-0009',
  outputItemName: '(PACKING) 14 INCH CRYSTA D/GADDI BCP RIM (NEW RAJU BASKET)',
  assignedBy: 'Sunil',
  colorBreakdown: [
    { color: 'Blue-White / BCP', qty: 6 },
    { color: 'Orange-White / BCP', qty: 10 },
    { color: 'Pink-White / BCP', qty: 20 },
    { color: 'Red-White / BCP', qty: 9 },
    { color: 'SeaGreen-White / BCP', qty: 15 },
  ],
}];

function render(lots) {
  document.body.innerHTML = App.Production._buildWorkOrderHtml('2026-08-24', 'Anil', lots);
  return document.body;
}

// Every cell carrying an explicit width, across every table in the document.
const widthCells = () => Array.from(document.querySelectorAll('th[style*="width"], td[style*="width"]'));

const pctOf = el => parseFloat(/width:\s*([\d.]+)%/.exec(el.getAttribute('style'))[1]);

describe('Work Order colour table geometry', () => {
  beforeEach(mount);

  test('every width-bearing cell measures border-box', () => {
    render(FIVE_COLOR_LOT);
    const cells = widthCells();

    expect(cells.length).toBeGreaterThan(0);
    cells.forEach(cell => {
      // Without this the 8px of padding and the border sit OUTSIDE the 20%,
      // and five columns push the table past the page edge.
      expect(cell.getAttribute('style')).toContain('box-sizing:border-box');
    });
  });

  test('a band of five columns still sums to exactly 100%', () => {
    render(FIVE_COLOR_LOT);
    const headerCells = Array.from(document.querySelectorAll('th[style*="width"]'));

    expect(headerCells).toHaveLength(5);
    const sum = headerCells.reduce((total, th) => total + pctOf(th), 0);
    expect(Math.round(sum)).toBe(100);
  });

  test('the Total row spans the full table rather than overhanging it', () => {
    render(FIVE_COLOR_LOT);
    const totalRow = Array.from(document.querySelectorAll('tr'))
      .find(tr => tr.textContent.includes('Total'));
    const cells = Array.from(totalRow.children);

    // colspan on the label + one cell for the figure has to add up to the
    // band width, or the figure lands outside the last column.
    const spanned = cells.reduce((n, td) => n + (parseInt(td.getAttribute('colspan'), 10) || 1), 0);
    expect(spanned).toBe(5);

    // The figure's own column must match the colour columns above it.
    const figureCell = cells[cells.length - 1];
    expect(pctOf(figureCell)).toBe(20);
    expect(figureCell.textContent.trim()).toBe('60');
  });

  test('a wrapped item keeps both bands within the page', () => {
    // Seven colours split 4+3 (_evenBands). The widest band sets the column
    // width, so 4 columns at 25% -- still 100%, still border-box.
    const lots = [{
      ...FIVE_COLOR_LOT[0],
      colorBreakdown: ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map(c => ({ color: c, qty: 1 })),
    }];
    render(lots);

    const headerCells = Array.from(document.querySelectorAll('th[style*="width"]'));
    expect(headerCells).toHaveLength(7);
    headerCells.forEach(th => {
      expect(pctOf(th)).toBe(25);
      expect(th.getAttribute('style')).toContain('box-sizing:border-box');
    });
  });
});
