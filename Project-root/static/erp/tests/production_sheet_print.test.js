/**
 * Regression test for App.Production.printProductionSheet (../production.js)
 * -- the disjoint-cluster Per-Color matrix (columns that never co-occur on
 * any row get their own printed table instead of one shared matrix with
 * every lot color as a column and dashes for every non-applicable cell) and
 * the Common Components two-column split. Run against the real source via a
 * require() of the actual file, same const-rewrite/global-App technique
 * pool_ledger.test.js established.
 *
 * Two colors that never appear together on the same row (e.g. one item only
 * ever tagged Red, another only ever tagged Blue) land in SEPARATE tables --
 * see clusterMatrixTables in _buildProductionSheetForExport. Two colors that
 * DO co-occur (directly, or transitively through a bridging row) stay
 * consolidated in one table, which is what keeps a real 6-colour/11-row
 * worst case from fragmenting into one table per row and spilling across
 * pages.
 *
 * jsdom does not do real layout, so container.offsetHeight/scrollWidth are
 * always 0 -- the auto-fit compression loop's tier-selection (shrinking
 * padding and font) can therefore never be reached here; every call in this
 * file exercises FIT_TIERS[0] only. That part is intentionally
 * left to manual/visual verification. What IS meaningfully covered without
 * real layout: the cluster-split structure, dash-for-missing-color cells,
 * unit suffixes, and the two-column Common Components split threshold.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function loadProductionAsGlobal() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'production.js'), 'utf8');
  // eslint-disable-next-line no-eval
  eval(code);
}

function buildPrintContainerDom() {
  document.body.innerHTML = `
    <div id="prodSheetDate"></div>
    <div id="prodSheetProductId"></div>
    <div id="prodSheetProductName"></div>
    <div id="prodSheetLotQty"></div>
    <textarea id="productionSheetRemarks"></textarea>

    <!-- Print options panel. _printOptions() reads the orientation checkbox
         and the per-group column checkboxes from here. -->
    <input type="checkbox" id="prodSheetOrientLandscape">
    <div id="productionSheetPrintColumns"></div>

    <div id="productionSheetCommonBody"></div>
    <div id="productionSheetMatrixTables"><div class="prod-sheet-matrix-tbody"></div></div>

    <div id="print-production-sheet-container">
      <div id="print-prod-date"></div>
      <div id="print-prod-id"></div>
      <div id="print-prod-name"></div>
      <div id="print-prod-qty"></div>
      <div id="print-prod-color-wrapper"></div>
      <div id="print-prod-color"></div>
      <div id="print-prod-common-section"></div>
      <div id="print-production-sheet-common-tables"></div>
      <div id="print-prod-matrix-section"></div>
      <div id="print-production-sheet-matrix-tables"></div>
      <div id="print-prod-subgroup-section"></div>
      <div id="print-production-sheet-subgroup-tables"></div>
      <div id="print-prod-remarks-section"></div>
      <div id="print-prod-remarks-text"></div>
    </div>`;
}

function addCommonRow(name, size, narration, qty) {
  const tbody = document.getElementById('productionSheetCommonBody');
  const row = document.createElement('div');
  row.innerHTML = `
    <input class="prod-sheet-item-name" value="${name}">
    <input class="prod-sheet-size" value="${size}">
    <input class="prod-sheet-narration" value="${narration}">
    <input class="prod-sheet-qty" value="${qty}">`;
  // Flatten so `row.querySelector('.prod-sheet-item-name')` on the <tr>
  // itself (as production.js expects) finds these -- append the inputs
  // directly onto a <tr>-shaped container instead of nesting.
  const tr = document.createElement('tr');
  tr.innerHTML = row.innerHTML;
  tbody.appendChild(tr);
  return tr;
}

function addMatrixRow(name, size, narration, colorValues) {
  const tbody = document.querySelector('#productionSheetMatrixTables .prod-sheet-matrix-tbody');
  const tr = document.createElement('tr');
  let html = `
    <input class="prod-sheet-item-name" value="${name}">
    <input class="prod-sheet-size" value="${size}">
    <input class="prod-sheet-narration" value="${narration}">`;
  Object.entries(colorValues).forEach(([color, val]) => {
    html += `<input class="prod-sheet-color-qty" data-color="${color}" value="${val}">`;
  });
  tr.innerHTML = html;
  tbody.appendChild(tr);
  return tr;
}

describe('App.Production.printProductionSheet', () => {
  let triggerSpy;

  beforeEach(() => {
    buildPrintContainerDom();
    // jsdom's innerText getter only reflects content that was itself
    // assigned via innerText (not raw innerHTML) -- match production.js's
    // own setText(), which reads .innerText, by writing the fixture the
    // same way.
    document.getElementById('prodSheetDate').innerText = '01/01/2026';
    document.getElementById('prodSheetProductId').innerText = 'PRC-1';
    document.getElementById('prodSheetProductName').innerText = 'Widget';
    document.getElementById('prodSheetLotQty').innerText = '10';

    global.escapeHtml = value => String(value).replace(/[&<>"']/g, ch => HTML_ESCAPE_MAP[ch]);
    global.toNumber = (value, fallback = 0) => {
      const n = Number(value);
      return Number.isFinite(n) ? n : fallback;
    };
    global.$ = (sel, root = document) => root.querySelector(sel);
    global.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

    global.App = {
      State: { currentProductionSheet: { colors: [], lotColor: '' }, globalColors: [], globalItems: [] },
      Utils: {
        notPortedYet: jest.fn(),
        sameText: (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase(),
        sameColor(a, b) { return this.sameText(a, b); },
        isCommonColorGroup: g => String(g ?? '').trim().toUpperCase() === 'COMMON',
      },
    };
    loadProductionAsGlobal();

    triggerSpy = jest.fn();
    // The real App.Print, with only trigger() spied. docName is the shared
    // naming convention; stubbing it would let the test agree with a
    // convention the app no longer uses.
    const printSrc = fs.readFileSync(path.join(__dirname, '..', 'print.js'), 'utf8');
    const printSandbox = { App: {}, document, window, console };
    vm.createContext(printSandbox);
    vm.runInContext(printSrc, printSandbox);
    App.Print = Object.assign(printSandbox.App.Print, { trigger: triggerSpy });
  });

  test('disjoint colors (never used together on any row) split into separate tables', () => {
    App.State.currentProductionSheet = { colors: ['Red', 'Blue'], lotColor: '' };
    addMatrixRow('Frame', 'L', 'Main', { Red: '5', Blue: '' });
    addMatrixRow('Mudguard', 'L', 'Rear', { Red: '', Blue: '3' });

    App.Production.printProductionSheet();

    const dest = document.getElementById('print-production-sheet-matrix-tables');
    const tables = dest.querySelectorAll('table');
    expect(tables.length).toBe(2); // Red and Blue never co-occur -- one table each

    expect(tables[0].querySelector('thead').textContent).toContain('Red');
    expect(tables[0].querySelector('thead').textContent).not.toContain('Blue');
    expect(tables[0].querySelector('tbody tr').textContent).toContain('Frame');
    expect(tables[0].querySelector('tbody tr').textContent).toContain('5');

    expect(tables[1].querySelector('thead').textContent).toContain('Blue');
    expect(tables[1].querySelector('thead').textContent).not.toContain('Red');
    expect(tables[1].querySelector('tbody tr').textContent).toContain('Mudguard');
    expect(tables[1].querySelector('tbody tr').textContent).toContain('3');
  });

  test('colors that co-occur on a bridging row stay consolidated in one table', () => {
    App.State.currentProductionSheet = { colors: ['Red', 'Blue'], lotColor: '' };
    // Frame is offered in both colors, so it bridges Red and Blue into one
    // cluster even though Mudguard only ever carries Red.
    addMatrixRow('Frame', 'L', 'Main', { Red: '5', Blue: '4' });
    addMatrixRow('Mudguard', 'L', 'Rear', { Red: '2', Blue: '' });

    App.Production.printProductionSheet();

    const dest = document.getElementById('print-production-sheet-matrix-tables');
    const tables = dest.querySelectorAll('table');
    expect(tables.length).toBe(1);
    const headerText = tables[0].querySelector('thead').textContent;
    expect(headerText).toContain('Red');
    expect(headerText).toContain('Blue');

    const rows = tables[0].querySelectorAll('tbody tr');
    expect(rows.length).toBe(2);
    expect(rows[1].textContent).toContain('Mudguard');
    expect(rows[1].textContent).toContain('–'); // &#8211; dash for Blue
  });

  test('Required Qty is suffixed with the resolved Base Unit', () => {
    App.State.globalItems = [{ name: 'Frame', size: 'L', baseUnit: 'Set' }];
    App.State.currentProductionSheet = { colors: [], lotColor: '' };
    addCommonRow('Frame', 'L', 'Main', '5');

    App.Production.printProductionSheet();

    const dest = document.getElementById('print-production-sheet-common-tables');
    expect(dest.querySelector('tbody tr').textContent).toContain('5 Set');
  });

  test('matrix section is hidden when there are no colors or no matrix rows', () => {
    App.State.currentProductionSheet = { colors: [], lotColor: '' };
    App.Production.printProductionSheet();

    expect(document.getElementById('print-prod-matrix-section').style.display).toBe('none');
  });

  test('Common Components: 8 or fewer rows render as a single full-width table', () => {
    for (let i = 0; i < 8; i++) addCommonRow(`Item${i}`, 'M', 'N', '1');
    App.Production.printProductionSheet();

    const dest = document.getElementById('print-production-sheet-common-tables');
    expect(dest.querySelectorAll('table').length).toBe(1);
    expect(dest.querySelector('[style*="grid-template-columns"]')).toBeNull();
  });

  test('Common Components: more than 8 rows split into a two-column grid of two tables', () => {
    for (let i = 0; i < 9; i++) addCommonRow(`Item${i}`, 'M', 'N', '1');
    App.Production.printProductionSheet();

    const dest = document.getElementById('print-production-sheet-common-tables');
    const grid = dest.querySelector('[style*="grid-template-columns"]');
    expect(grid).not.toBeNull();
    const tables = dest.querySelectorAll('table');
    expect(tables.length).toBe(2);
    // ceil(9/2) = 5 rows left, 4 right.
    expect(tables[0].querySelectorAll('tbody tr').length).toBe(5);
    expect(tables[1].querySelectorAll('tbody tr').length).toBe(4);
  });

  test('lot header fields and color wrapper are populated', () => {
    App.State.currentProductionSheet = { colors: [], lotColor: 'Red / Blue' };
    App.Production.printProductionSheet();

    expect(document.getElementById('print-prod-date').innerText).toBe('01/01/2026');
    expect(document.getElementById('print-prod-id').innerText).toBe('PRC-1');
    expect(document.getElementById('print-prod-name').innerText).toBe('Widget');
    expect(document.getElementById('print-prod-qty').innerText).toBe('10');
    expect(document.getElementById('print-prod-color-wrapper').style.display).toBe('');
    expect(document.getElementById('print-prod-color').innerText).toBe('Red / Blue');
  });

  // The filename is the operator's own Output Item Name plus the lot's date --
  // what they typed and what they see in the Output Item column, not an
  // abbreviation of it. Shared by Print Sheet, Download PDF and Download PDFs
  // so one lot cannot come out under two different names.
  test('names the job after the Output Item Name and the lot date', () => {
    App.State.currentProductionSheet = {
      colors: [], lotColor: '', lotNumber: 'LOT-12',
      outputItemName: '20 inch Rider D/Gaddi Steel Rim S/Kid Type',
      date: '21/08/2026', size: '26 inch', model: 'Ranger', processName: 'Wheel Building'
    };
    App.Production.printProductionSheet();

    expect(triggerSpy).toHaveBeenCalledWith(
      'print-production-sheet-container',
      '20 inch Rider D-Gaddi Steel Rim S-Kid Type_210826',
      { landscape: false }
    );
  });

  // Windows refuses / \ : * ? " < > | in a filename, and these item names
  // routinely carry slashes ("D/Gaddi", "S/Kid").
  test('replaces characters Windows refuses, keeping the name readable', () => {
    App.State.currentProductionSheet = {
      colors: [], lotColor: '', outputItemName: 'Frame: Ranger <Deluxe> | 26"',
      date: '01/09/2026'
    };
    App.Production.printProductionSheet();

    const [, title] = triggerSpy.mock.calls[0];
    expect(title).not.toMatch(/[/\:*?"<>|]/);
    expect(title).toContain('Ranger');
    expect(title).toMatch(/_010926$/);
  });

  // Without an output item there is still a sheet to name; falling through to
  // the model and then the product id beats emitting a bare date that several
  // lots would share.
  test('falls back through model and product id when no output item is set', () => {
    App.State.currentProductionSheet = {
      colors: [], lotColor: '', model: 'Ranger', date: '21/08/2026'
    };
    App.Production.printProductionSheet();

    expect(triggerSpy).toHaveBeenCalledWith(
      'print-production-sheet-container', 'Ranger_210826', { landscape: false });
  });

  test('forwards the Landscape option to the print job', () => {
    document.getElementById('prodSheetOrientLandscape').checked = true;
    App.Production.printProductionSheet();

    expect(triggerSpy).toHaveBeenCalledWith(
      'print-production-sheet-container',
      expect.any(String),
      { landscape: true }
    );
  });
  // ── Printed column set ────────────────────────────────────────────────
  // Size and Narration are shown and edited in the on-screen sheet but are
  // deliberately NOT printed. Both are still read from the DOM by
  // _buildProductionSheetForExport's row mappers, so nothing stops a future
  // change re-adding the cells; these assertions are what makes that loud.
  describe('Size and Narration are omitted from the printed sheet', () => {
    test('Common Components prints Item Name and Required Qty only', () => {
      App.State.globalItems = [{ name: 'Frame', size: 'L', baseUnit: 'Set' }];
      App.State.currentProductionSheet = { colors: [], lotColor: '' };
      addCommonRow('Frame', 'GENERAL', 'Handle with care', '5');

      App.Production.printProductionSheet();

      const table = document.getElementById('print-production-sheet-common-tables')
        .querySelector('table');
      const heads = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
      expect(heads).toEqual(['Item Name', 'Required Qty']);

      const cells = table.querySelectorAll('tbody tr td');
      expect(cells.length).toBe(2);
      expect(table.textContent).toContain('Frame');
      expect(table.textContent).not.toContain('GENERAL');
      expect(table.textContent).not.toContain('Handle with care');
    });

    test('Per-Color matrix prints Item Name plus one column per colour', () => {
      App.State.currentProductionSheet = { colors: ['Red', 'Blue'], lotColor: '' };
      addMatrixRow('Frame', 'GENERAL', 'Handle with care', { Red: '5', Blue: '4' });

      App.Production.printProductionSheet();

      const table = document.getElementById('print-production-sheet-matrix-tables')
        .querySelector('table');
      const heads = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
      expect(heads).toEqual(['Item Name', 'Red', 'Blue']);

      // One name cell + one cell per colour, and no leftover Size/Narration.
      expect(table.querySelectorAll('tbody tr td').length).toBe(3);
      expect(table.textContent).not.toContain('GENERAL');
      expect(table.textContent).not.toContain('Handle with care');
    });

    test('a non-generic Size is dropped too, not just "GENERAL"', () => {
      // The old fit loop only ever dropped Size when every row was
      // generic. Hiding is now unconditional, so a real size like "20 inch"
      // must not survive either.
      App.State.currentProductionSheet = { colors: [], lotColor: '' };
      addCommonRow('Rim', '20 inch', 'Front only', '2');

      App.Production.printProductionSheet();

      const text = document.getElementById('print-production-sheet-common-tables').textContent;
      expect(text).toContain('Rim');
      expect(text).not.toContain('20 inch');
      expect(text).not.toContain('Front only');
    });
  });
});
