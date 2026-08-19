/**
 * Regression tests for defects found auditing the Production module and its
 * Create/Edit Production Lot form (../production.js).
 *
 * Each block below pins one bug that was silent in the UI -- nothing threw,
 * nothing was reported, the wrong thing simply happened -- which is exactly
 * the class a test has to hold down, because a human reviewing the rendered
 * page cannot see any of them.
 *
 * Runs against the REAL partial read off disk (same technique as
 * production_row_reorder.test.js) so the markup these assert against can
 * never drift from what the app ships.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const PARTIAL = path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', 'production.html');

function loadProductionAsGlobal() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'production.js'), 'utf8');
  // eslint-disable-next-line no-eval
  eval(code);
}

function installGlobals() {
  global.escapeHtml = value => String(value).replace(/[&<>"']/g, ch => HTML_ESCAPE_MAP[ch]);
  global.toNumber = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  global.$ = (sel, root = document) => root.querySelector(sel);
  global.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  global.formatCurrency = v => `Rs.${Number(v).toFixed(2)}`;
  global.todayIso = () => '2026-01-01';
  global.parseRecordDate = () => 0;

  global.App = {
    State: {
      globalItems: [], globalColors: [], globalProcesses: [], globalProduction: [],
      globalStock: [], filteredStock: [], stockSearchTerm: '',
      filteredProduction: [], selectedProduction: [], productionCurrentPage: 1, productionRowsPerPage: 25,
    },
    Utils: {
      sameText: (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase(),
      sameColor(a, b) { return this.sameText(a, b); },
      isCommonColorGroup: g => String(g ?? '').trim().toUpperCase() === 'COMMON',
      formatNameCase: v => String(v ?? ''),
      matchesKeywords: (haystack, term) => String(haystack).toLowerCase().includes(String(term).toLowerCase()),
      getSizeFromOutputItemName: () => 'General',
      getModelFromOutputItemName: () => 'General',
      PROCESS_SIZE_LIST: ['General'],
      autoSelectOnlyOption: () => {},
      select2DropdownParent: () => null,
      select2Matcher: () => null,
      setFormButtonsForMode: () => {},
      renderPagination: () => {},
      showToast: () => {},
      confirmAction: (_msg, onConfirm) => onConfirm(),
    },
    Selection: {
      isSelected: () => false,
      updateButton: () => {},
    },
    Nav: { register: () => {}, clear: () => {} },
  };
}

function productionRecord(overrides = {}) {
  return Object.assign({
    rowIdx: 7, date: '01/01/2026', dateRaw: '2026-01-01', processId: 'P1', lotNumber: 'LOT-AB-0001',
    outputItemName: 'Frame', productId: '', productName: '', qty: 5, assignedBy: '', assignedTo: 'W',
    status: 'Pending', contractorPayable: 0, extraChargeType: '', colorBreakdown: [], color: '',
  }, overrides);
}

describe('Create/Edit Production Lot form: generated row ids', () => {
  beforeEach(() => {
    document.body.innerHTML = fs.readFileSync(PARTIAL, 'utf8');
    installGlobals();
    loadProductionAsGlobal();
  });

  // The old id was Date.now() + Math.floor(Math.random() * 1000). Rows are
  // built in tight SYNCHRONOUS loops (one per recipe component), so every
  // row of one load shares a millisecond and the id collapses to a single
  // draw from 1000 values -- roughly 4% collision odds across ten rows.
  // Pinning Math.random reproduces the collision deterministically; it is a
  // value Math.random is genuinely allowed to return twice in a row.
  test('stay unique even when Math.random and the clock never move', () => {
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1770000000000);
    try {
      for (let i = 0; i < 10; i++) {
        App.Production.addComponentRow({ itemName: `Item ${i}`, qty: 1, sourceType: 'ITEM' });
      }
      const ids = $$('#productionComponentsBody tr').map(r => r.id);
      expect(ids).toHaveLength(10);
      expect(new Set(ids).size).toBe(10);
    } finally {
      randomSpy.mockRestore();
      nowSpy.mockRestore();
    }
  });

  // A duplicate id made removeComponentRow delete the FIRST row carrying
  // that id -- silently dropping a component the operator never touched out
  // of the lot's saved consumption, while leaving the one they clicked on.
  test('let the remove button drop exactly the row it belongs to', () => {
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1770000000000);
    try {
      ['Bolt', 'Nut', 'Washer'].forEach(name =>
        App.Production.addComponentRow({ itemName: name, qty: 1, sourceType: 'ITEM' }));

      const rows = $$('#productionComponentsBody tr');
      App.Production.removeComponentRow(rows[1].id);

      const remaining = $$('#productionComponentsBody tr')
        .map(r => r.querySelector('.prod-comp-item-select option[selected]')?.dataset.name);
      expect(remaining).toEqual(['Bolt', 'Washer']);
    } finally {
      randomSpy.mockRestore();
      nowSpy.mockRestore();
    }
  });
});

describe('Production Log row: inline status control', () => {
  beforeEach(() => {
    document.body.innerHTML = fs.readFileSync(PARTIAL, 'utf8');
    installGlobals();
    loadProductionAsGlobal();
  });

  // rowHtml renders this <select> as a coloured pill: compact font, native
  // arrow suppressed. updateStatus rewrote the whole style attribute with
  // the COLOURS alone, so changing a status inline made that one row snap
  // back to a full-size native dropdown until the next full render.
  test('keeps its pill presentation after an inline status change', async () => {
    const record = productionRecord();
    App.State.globalProduction = [record];
    App.State.filteredProduction = [record];
    global.Api = { mutate: jest.fn().mockResolvedValue({ success: true, message: 'ok' }) };

    App.Production.renderTable();
    const select = document.querySelector('#productionTableBody select');
    expect(select.getAttribute('style')).toContain('appearance:none');

    select.value = 'Completed';
    await App.Production.updateStatus(select);

    const after = select.getAttribute('style');
    expect(after).toContain('appearance:none');
    expect(after).toContain('background-image:none');
    expect(after).toContain('#198754');
  });
});

describe('Production Log row: Delete action', () => {
  beforeEach(() => {
    document.body.innerHTML = fs.readFileSync(PARTIAL, 'utf8');
    installGlobals();
    loadProductionAsGlobal();
  });

  // The onclick used to be built as App.Production.delete('<rowIdx>',
  // '<escapeHtml(productId)>', '<qty>'). escapeHtml is an HTML escaper, and
  // a browser HTML-DECODES an onclick attribute before parsing it as
  // JavaScript -- so its &#39; turned back into a bare quote inside the
  // string literal. A Product ID carrying an apostrophe broke the handler
  // outright, and anything an operator can type was an injection point into
  // this page's own script context.
  test('never interpolates a record\'s own text into executable markup', () => {
    const record = productionRecord({ productId: "O'Brien'); window.__pwned = true; ('", productName: 'X' });
    App.State.globalProduction = [record];
    App.State.filteredProduction = [record];

    App.Production.renderTable();
    const deleteBtn = Array.from(document.querySelectorAll('#productionTableBody button'))
      .find(b => b.textContent.trim() === 'Delete');

    expect(deleteBtn.getAttribute('onclick')).toBe("App.Production.delete('0')");
  });

  // ...and the concurrency-guard arguments the RPC needs must still be the
  // record's real ones, read out of state rather than off the markup.
  test('still sends the record\'s own productId and qty to deleteProduction', async () => {
    const record = productionRecord({ productId: "O'Brien", productName: 'X' });
    App.State.globalProduction = [record];
    App.State.filteredProduction = [record];
    global.Api = { mutate: jest.fn().mockResolvedValue({ success: true, message: 'deleted' }) };
    App.Production.loadData = jest.fn().mockResolvedValue(undefined);

    await App.Production.delete('0');

    expect(Api.mutate).toHaveBeenCalledWith('deleteProduction', 7, "O'Brien", 5);
  });
});

describe('Create/Edit Production Lot form: availability refresh', () => {
  beforeEach(() => {
    document.body.innerHTML = fs.readFileSync(PARTIAL, 'utf8');
    installGlobals();
    loadProductionAsGlobal();
  });

  // refreshPoolAvailability reloads Stock to paint the form's "avail."
  // hints, and used to assign filteredStock = [...stock] outright --
  // silently discarding whatever search the operator had left on the Stock
  // tab, a tab they are not even looking at while this fires.
  test('refreshes globalStock without discarding the Stock tab\'s active search', async () => {
    const stock = [
      { name: 'Bolt', size: 'M8', currentStock: 4 },
      { name: 'Washer', size: '', currentStock: 9 },
    ];
    global.Api = {
      call: jest.fn().mockImplementation(method =>
        Promise.resolve(method === 'getStockData'
          ? { success: true, data: stock }
          : { success: true, data: [] })),
    };
    App.Stock = {
      recomputeFiltered() {
        const term = String(App.State.stockSearchTerm || '').toLowerCase();
        App.State.filteredStock = term
          ? App.State.globalStock.filter(i => App.Utils.matchesKeywords(`${i.name} ${i.size}`, term))
          : [...App.State.globalStock];
      },
    };
    App.State.stockSearchTerm = 'bolt';
    App.Production.refreshColorChecklistAvailability = jest.fn().mockResolvedValue(undefined);

    await App.Production.refreshPoolAvailability();

    expect(App.State.globalStock).toEqual(stock);
    expect(App.State.filteredStock.map(i => i.name)).toEqual(['Bolt']);
  });
});

describe('Create/Edit Production Lot form: Product tag dropdown', () => {
  beforeEach(() => {
    document.body.innerHTML = fs.readFileSync(PARTIAL, 'utf8');
    installGlobals();
    loadProductionAsGlobal();
  });

  // The Product dropdown reads App.State.globalBOMs, and nothing in the
  // Production tab's own path ever filled it -- only Clients, Stock's
  // Warehouse Opening modal, and an unlocked BOM tab did, each with its own
  // inline copy of the same fetch. On a session that visited none of them
  // first, a final-stage lot could not be tagged with a Product at all, and
  // Dispatch could therefore never find it.
  test('loads the product list as part of entering the tab', async () => {
    const products = [
      { productId: 'P-001', productName: 'Cycle 26 inch' },
      { productId: 'P-002', productName: 'Cycle 24 inch' },
    ];
    global.Api = {
      call: jest.fn().mockImplementation(method =>
        Promise.resolve(method === 'getProductionData'
          ? { success: true, data: [] }
          : { success: true, data: products })),
    };
    App.Process = { ensureLoaded: jest.fn().mockResolvedValue(undefined) };
    App.Color = { ensureLoaded: jest.fn().mockResolvedValue(undefined) };
    App.Item = { ensureLoaded: jest.fn().mockResolvedValue(undefined) };
    App.BOM = {
      async ensureProductListLoaded() {
        if (App.State.globalBOMs && App.State.globalBOMs.length) return;
        const res = await Api.call('getBOMProductionData');
        if (res.success) App.State.globalBOMs = res.data;
      },
    };
    App.Production.renderAllActivity = jest.fn();
    App.Production.updateColumnFilterIcons = jest.fn();

    await App.Production.loadData();
    App.Production.populateProductSelect();

    const options = Array.from(document.querySelectorAll('#productionProductId option')).map(o => o.value);
    expect(options).toEqual(['', 'P-001', 'P-002']);
  });
});

describe('Create/Edit Production Lot form: overlapping opens', () => {
  beforeEach(() => {
    document.body.innerHTML = fs.readFileSync(PARTIAL, 'utf8');
    installGlobals();
    loadProductionAsGlobal();
  });

  // openEditModal checked _compLoadSeq after every await EXCEPT the first
  // one -- and the whole block of field writes sits after that first await.
  // Two overlapping opens (Nav's next arrow held down, or a click landing
  // while the submit handler re-opens the record it just saved) let the
  // loser resume and paint ITS lot's date/contractor/status/remarks over a
  // form whose hidden rowIdx the winner had already repointed. Saving from
  // there writes one lot's data onto another lot's row.
  test('a superseded open never paints its lot over the fields of the one that won', async () => {
    const lotA = productionRecord({
      rowIdx: 1, dateRaw: '2026-01-05', lotNumber: 'LOT-AB-0001',
      assignedBy: 'Supervisor A', assignedTo: 'Contractor A', status: 'Pending', remarks: 'lot A remarks',
    });
    const lotB = productionRecord({
      rowIdx: 2, dateRaw: '2026-02-09', lotNumber: 'LOT-AB-0002',
      assignedBy: 'Supervisor B', assignedTo: 'Contractor B', status: 'Completed', remarks: 'lot B remarks',
    });
    App.State.globalProduction = [lotA, lotB];
    App.State.filteredProduction = [lotA, lotB];

    // Hold the first open at its very first await, release it only after
    // the second open has run to completion -- the interleaving a slow
    // masters fetch produces on a real click-through.
    let releaseFirst;
    const gate = new Promise(resolve => { releaseFirst = resolve; });
    let firstCall = true;
    const ensure = () => {
      if (firstCall) { firstCall = false; return gate; }
      return Promise.resolve();
    };
    App.Process = { ensureLoaded: ensure };
    App.Contractor = { ensureLoaded: ensure };
    App.ProcessType = { ensureLoaded: ensure };
    App.Model = { ensureLoaded: ensure };
    // Everything past the field writes is out of scope here.
    App.Production.populateColorChecklist = jest.fn().mockResolvedValue([]);

    const openA = App.Production.openEditModal(0);
    await App.Production.openEditModal(1);
    releaseFirst();
    await openA;

    expect(document.getElementById('productionRowIdx').value).toBe('2');
    expect(document.getElementById('productionAssignedBy').value).toBe('Supervisor B');
    expect(document.getElementById('productionStatus').value).toBe('Completed');
    expect(document.getElementById('productionRemarks').value).toBe('lot B remarks');
    expect(document.getElementById('productionDate').value).toBe('2026-02-09');
  });
});
