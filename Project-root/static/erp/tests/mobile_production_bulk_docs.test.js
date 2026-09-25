/**
 * Production's bulk download / share.
 *
 * The tab could produce exactly one document: a single lot's production
 * sheet, and only with that lot's sheet open. Nothing printed, downloaded
 * or shared more than one lot, on the screen whose whole point is that it
 * is the one in the operator's hand.
 *
 * Two routes in, both landing on MApp.Print's own Print / Download PDF /
 * Share chooser: the title row's "Download / print", over whatever the
 * search and the pending filter have left on screen, and the Sheets button
 * on the long-press selection bar, over the lots actually picked out.
 *
 * What a bulk PAGE has to be is the interesting part: the SAME document a
 * single-lot print produces, because it is rendered through the same
 * builder into the same container and lifted out -- not a second layout
 * that would drift from it. The single-lot sheet's own fidelity to
 * desktop's is mobile_production_sheet_print.test.js's business.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const partial = name => fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', name), 'utf8');
const PRINT_PARTIAL = partial('print.html');
const MOBILE_HTML = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'mobile.html'), 'utf8');
const MOBILE_VIEWS = partial('mobile_views.html');
const CSS = read('mobile_styles.css');

// jsdom has no innerText, and the sheet's header fields are filled with it.
Object.defineProperty(HTMLElement.prototype, 'innerText', {
  configurable: true,
  get() { return this.textContent; },
  set(v) { this.textContent = v; }
});

const COLORS = ['Red', 'Blue', 'Black'].map(name => ({ name }));
const ITEMS = [
  { name: 'Primer', size: '5 L', narration: 'Grey base', baseUnit: 'Ltr' },
  { name: 'Frame---Red', size: '20 inch', narration: '', baseUnit: 'Pcs' },
  { name: 'Frame---Blue', size: '20 inch', narration: '', baseUnit: 'Pcs' },
  { name: 'Poly Bag', size: 'GENERAL', narration: '', baseUnit: 'Pcs' }
];
const PROCESSES = [
  { processId: 'PRC-PNT', processName: 'Frame Painting 20', processType: 'Painting',
    outputItemName: 'Painted Frame Kalpi 20 inch', sequence: 2, active: true },
  { processId: 'PRC-PKG', processName: 'Packing Line 2', processType: 'Packing',
    outputItemName: 'Packed Kalpi 20 inch', sequence: 5, active: true }
];

const LOTS = [
  { rowIdx: 11, lotNumber: 'LOT-PNT-0041', processId: 'PRC-PNT', date: '12/09/2026', dateRaw: '2026-09-12',
    qty: 40, status: 'Pending', assignedTo: 'rakesh', contractorPayable: 800,
    outputItemName: 'Painted Frame Kalpi 20 inch', productId: '', productName: '',
    sheetRemarks: 'Rush -- Nova Motors',
    colorBreakdown: [{ color: 'Red', qty: 20, countsTowardTotal: true }, { color: 'Blue', qty: 20, countsTowardTotal: true }],
    componentsConsumed: [
      { itemName: 'Primer', size: '5 L', narration: '', colorGroup: 'COMMON', qty: 5, sourceType: 'ITEM' },
      { itemName: 'Frame---Red', size: '20 inch', narration: '', colorGroup: 'Red', qty: 20, sourceType: 'ITEM' },
      { itemName: 'Frame---Blue', size: '20 inch', narration: '', colorGroup: 'Blue', qty: 20, sourceType: 'ITEM' }
    ] },
  { rowIdx: 12, lotNumber: 'LOT-PKG-0018', processId: 'PRC-PKG', date: '13/09/2026', dateRaw: '2026-09-13',
    qty: 30, status: 'Completed', assignedTo: 'sanjay', contractorPayable: 0,
    outputItemName: 'Packed Kalpi 20 inch', productId: 'PRD-7', productName: 'Kalpi 20',
    sheetRemarks: '', colorBreakdown: [],
    componentsConsumed: [
      { itemName: 'Poly Bag', size: 'GENERAL', narration: '', colorGroup: 'KIT BAG 20"', qty: 30, sourceType: 'ITEM' }
    ] }
];

function loadShared() {
  // Each eval() gets its own scope, so api.js's plain declarations have to
  // be republished -- in a browser every file shares one global.
  // eslint-disable-next-line no-eval
  eval([
    read('api.js').replace(/^const Api = /m, 'global.Api = '),
    'global.escapeHtml = escapeHtml;',
    'global.toNumber = toNumber;',
    'global.formatCurrency = formatCurrency;',
    'global.formatQty = formatQty;',
    'global.parseRecordDate = parseRecordDate;',
    'global.dateToInputValue = dateToInputValue;',
    'global.inDateRange = inDateRange;',
    'global.todayIso = todayIso;'
  ].join('\n'));
  // eslint-disable-next-line no-eval
  eval(read('print-templates.js').replace(/^const PrintTemplates = /m, 'global.PrintTemplates = '));
  // eslint-disable-next-line no-eval
  eval(read('mobile.js').replace(/^const MApp = /m, 'global.MApp = '));
}

// The lookups the sheet reads, and nothing that needs a network.
function stubLookups() {
  MApp.Api.callCached = jest.fn(async method => ({
    success: true,
    data: { getItemsData: ITEMS, getColors: COLORS, getProcessData: PROCESSES }[method]
  }));
  MApp.Api.call = MApp.Api.callCached;
}

beforeEach(() => {
  jest.resetModules();
  global.fetch = jest.fn();
  try { localStorage.clear(); } catch (e) { /* not available */ }
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  loadShared();
  document.body.innerHTML = `${PRINT_PARTIAL}<div id="mapp-toast-stack"></div>`;
  stubLookups();
});

// chooseAction is where all three actions -- print, download, share --
// diverge, so intercepting it is intercepting every one of them.
function interceptChooser() {
  return jest.spyOn(MApp.Print, 'chooseAction').mockResolvedValue(undefined);
}

const pagesOf = () => [...document.querySelectorAll('#print-bulk-body .bulk-print-page')];

describe('a stack of production sheets', () => {
  test('one page per lot, each the document a single-lot print produces', async () => {
    const choose = interceptChooser();
    await MApp.ProductionSheet.printSheets(LOTS);
    await choose.mock.calls[0][0].populate();

    const pages = pagesOf();
    expect(pages).toHaveLength(2);
    expect(pages[0].textContent).toContain('Painting Requirement Sheet');
    expect(pages[0].textContent).toContain('LOT-PNT-0041');
    expect(pages[1].textContent).toContain('Packing Requirement Sheet');
    expect(pages[1].textContent).toContain('Kalpi 20');

    // Each lot's own sheet, not the first one repeated: the colour matrix
    // belongs to the painted lot and the packing bucket to the other.
    expect(pages[0].textContent).toContain('Per-Color Components');
    expect(pages[0].textContent).toContain('Primer(Grey base)');
    expect(pages[0].textContent).not.toContain('Poly Bag');
    expect(pages[1].textContent).toContain('Poly Bag');
    expect(pages[1].textContent).not.toContain('Primer');
  });

  test('each lot carries its OWN saved remarks, and a lot with none shows none', async () => {
    const choose = interceptChooser();
    await MApp.ProductionSheet.printSheets(LOTS);
    await choose.mock.calls[0][0].populate();

    const pages = pagesOf();
    expect(pages[0].textContent).toContain('Rush -- Nova Motors');
    // Not merely absent from the text -- the section is hidden, as it is on
    // a single-lot sheet with no remarks.
    expect(pages[1].textContent).not.toContain('Rush -- Nova Motors');
    const remarks = pages[1].querySelector('[style*="display: none"]');
    expect(remarks).toBeTruthy();
  });

  test('a page sheds what would stop it printing, or collide with the next one', async () => {
    const choose = interceptChooser();
    await MApp.ProductionSheet.printSheets(LOTS);
    await choose.mock.calls[0][0].populate();

    pagesOf().forEach(page => {
      const sheet = page.firstElementChild;
      // @media print hides every print container that is not the one being
      // printed, and this one is inside #print-bulk-container rather than
      // being printed itself.
      expect(sheet.classList.contains('print-container')).toBe(false);
      expect(sheet.style.display).toBe('block');
      // No id survives: two pages in one document would duplicate every
      // one of them, and shadow the real container on the next render.
      expect(sheet.id).toBe('');
      expect(sheet.querySelectorAll('[id]')).toHaveLength(0);
    });
    // The rule that actually breaks the pages apart on paper.
    expect(CSS).toMatch(/\.print-container \.bulk-print-page \{ break-after: page; \}/);
  });

  test('the Page choice is the same remembered one the single-lot sheet uses', async () => {
    const choose = interceptChooser();
    await MApp.ProductionSheet.printSheets(LOTS);
    const opts = choose.mock.calls[0][0];

    expect(opts.toggles).toHaveLength(1);
    expect(opts.toggles[0].on()).toBe(false);
    expect(opts.toggles[0].offLabel).toBe('Page: portrait');
    opts.toggles[0].flip();
    expect(MApp.Prefs.get(MApp.ProductionSheet.PREF_LANDSCAPE, false)).toBe(true);
    expect(opts.landscape()).toBe(true);
  });

  test('nothing selected prints nothing, and says so', async () => {
    const choose = interceptChooser();
    await MApp.ProductionSheet.printSheets([]);
    expect(choose).not.toHaveBeenCalled();
    expect(document.getElementById('mapp-toast-stack').textContent).toContain('No lots to print');
  });

  test('the open sheet screen\'s own edit state is left out of it', async () => {
    // A bulk job prints the lots' SAVED sheets. Whatever single lot happens
    // to be open on screen, with whatever uncommitted corrections, must not
    // leak onto another lot's page.
    MApp.ProductionSheet.lot = LOTS[0];
    MApp.ProductionSheet.rows = [{ itemName: 'TYPED BY HAND', size: '', narration: '', color: '', requiredQty: 99 }];

    const choose = interceptChooser();
    await MApp.ProductionSheet.printSheets(LOTS);
    await choose.mock.calls[0][0].populate();

    expect(document.getElementById('print-bulk-body').textContent).not.toContain('TYPED BY HAND');
    expect(pagesOf()[0].textContent).toContain('Primer');
  });
});

describe('the Production tab\'s Download / print', () => {
  beforeEach(() => {
    MApp.Production.processById = { 'PRC-PNT': PROCESSES[0], 'PRC-PKG': PROCESSES[1] };
    MApp.Production.filtered = LOTS;
    MApp.Production.searchTerm = '';
    MApp.Production._pendingOnly = false;
  });

  test('the title row offers it, on the screen the lots are listed on', () => {
    expect(MOBILE_VIEWS).toContain('MApp.Production.printMenu()');
    const production = MOBILE_VIEWS.slice(MOBILE_VIEWS.indexOf('<template id="tpl-production">'));
    expect(production.slice(0, production.indexOf('</template>'))).toContain('mapp-title-row');
  });

  test('two documents: the lots as a log, and the lots\' sheets', async () => {
    MApp.Picker.open = jest.fn(async () => null);
    await MApp.Production.printMenu();
    const items = MApp.Picker.open.mock.calls[0][0].items;
    expect(items.map(i => i.label)).toEqual(['Production log', 'Production sheets']);
    expect(items[0].sublabel).toBe('2 lots, one row each');
    expect(items[1].sublabel).toBe('2 sheets, one page each');
  });

  test('the log is every lot the list is showing, not the page of them on screen', async () => {
    const choose = interceptChooser();
    MApp.Production.searchTerm = 'kalpi';
    MApp.Production.printReport();

    const opts = choose.mock.calls[0][0];
    expect(opts.filename).toBe('Production_Log');
    expect(opts.title).toBe('Production Log');
    await opts.populate();

    const body = document.getElementById('print-report-body').textContent;
    expect(body).toContain('LOT-PNT-0041');
    expect(body).toContain('LOT-PKG-0018');
    expect(body).toContain('Frame Painting 20');
    expect(body).toContain('Red 20 · Blue 20');
    // A lot with no rate on file prints a blank, not a "₹0.00" that reads
    // as a lot which genuinely cost nothing.
    expect(body).toContain('₹800.00');
    expect(body).not.toContain('₹0.00');
    expect(document.getElementById('print-report-subtitle').textContent)
      .toBe('2 lots · matching "kalpi"');
  });

  test('an empty list prints nothing, and says so', async () => {
    MApp.Production.filtered = [];
    MApp.Picker.open = jest.fn();
    await MApp.Production.printMenu();
    expect(MApp.Picker.open).not.toHaveBeenCalled();
    expect(document.getElementById('mapp-toast-stack').textContent).toContain('No lots to print');
  });
});

describe('the selection bar\'s document action', () => {
  function armSelection(config, rows) {
    document.body.insertAdjacentHTML('beforeend', `
      <div class="mb-select-bar" id="mapp-select-bar">
        <span id="mapp-select-count"></span>
        <button type="button" class="mb-hidden" id="mapp-select-docs">Sheets</button>
      </div>`);
    MApp.Select._state = {
      key: config.key, config, rows, nodes: rows.map(() => document.createElement('div')),
      listEl: document.createElement('div'), selected: new Set([0])
    };
    MApp.Select._paint();
  }

  const docsBtn = () => document.getElementById('mapp-select-docs');

  test('the bar ships with the button, hidden', () => {
    expect(MOBILE_HTML).toContain('MApp.Select.documentsForSelected()');
    expect(MOBILE_HTML).toMatch(/id="mapp-select-docs"/);
    const bar = MOBILE_HTML.slice(MOBILE_HTML.indexOf('id="mapp-select-bar"'));
    expect(bar.slice(0, bar.indexOf('</div>'))).toContain('mb-hidden');
  });

  test('shown, and labelled, only where the screen declares documents', () => {
    armSelection({ key: 'production', noun: 'lot', plural: 'lots', documents: { label: 'Sheets', run: jest.fn() } }, LOTS);
    expect(docsBtn().classList.contains('mb-hidden')).toBe(false);
    expect(docsBtn().textContent).toBe('Sheets');
    expect(document.getElementById('mapp-select-count').textContent).toBe('1 lot selected');

    MApp.Select.exit();
    armSelection({ key: 'items', noun: 'item', plural: 'items' }, LOTS);
    expect(docsBtn().classList.contains('mb-hidden')).toBe(true);
  });

  test('runs on the lots picked out, and leaves selection mode', async () => {
    const run = jest.fn().mockResolvedValue(undefined);
    armSelection({ key: 'production', noun: 'lot', plural: 'lots', documents: { label: 'Sheets', run } }, LOTS);
    MApp.Select.toggle(1);

    await MApp.Select.documentsForSelected();

    expect(run).toHaveBeenCalledWith(LOTS);
    expect(MApp.Select.isActive('production')).toBe(false);
  });

  test('Production wires it to the sheets for those lots', async () => {
    const sheets = jest.spyOn(MApp.ProductionSheet, 'printSheets').mockResolvedValue(undefined);
    await MApp.Production.SELECT.documents.run([LOTS[1]]);
    expect(sheets).toHaveBeenCalledWith([LOTS[1]]);
    sheets.mockRestore();
  });

  test('the count gives way to the buttons rather than pushing them off the bar', () => {
    expect(CSS).toMatch(/\.mb-select-count \{[^}]*min-width: 0;/);
  });
});
