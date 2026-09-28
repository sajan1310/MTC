/**
 * Production on desktop -- Share, beside every Download PDF.
 *
 * The Production Sheet dialog, the Work Order preview and the lots toolbar
 * could each print and save their documents but not share them. Share hands
 * the SAME PDF to the operating system's share sheet: the same markup, name
 * and page orientation Download sends, so the two cannot drift.
 *
 * Loaded the way production_sheet_print.test.js loads production.js -- a
 * minimal App, the real print-templates.js -- with the real print.js on top.
 */

'use strict';

const fs = require('fs');
const path = require('path');
// jsdom's Blob has no arrayBuffer(), which unzip() reads the archive with;
// node's does. TextDecoder is not global in this jsdom either.
const { Blob: NodeBlob } = require('node:buffer');
const { TextEncoder, TextDecoder } = require('node:util');

global.TextDecoder = TextDecoder;

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function storeZip(entries) {
  const enc = new TextEncoder();
  const parts = [];
  for (const [name, body] of entries) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(body);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034B50, true);
    local.setUint16(8, 0, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, data);
  }
  return new NodeBlob(parts);
}

let requests;
let toasts;

function serve() {
  requests = [];
  global.fetch = jest.fn(async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, body });
    if (url === '/erp/render-pdf-batch') {
      const entries = body.documents.map(d => [d.filename, `%PDF-${d.filename}`]);
      return { ok: true, status: 200, blob: async () => storeZip(entries) };
    }
    return { ok: true, status: 200, blob: async () => new Blob([`%PDF-${body.filename}`]) };
  });
}

function buildDom() {
  document.body.innerHTML = `
    <div id="prodSheetDate"></div>
    <div id="prodSheetProductId"></div>
    <div id="prodSheetProductName"></div>
    <div id="prodSheetLotQty"></div>
    <textarea id="productionSheetRemarks"></textarea>
    <input type="checkbox" id="prodSheetOrientLandscape">
    <div id="productionSheetPrintColumns"></div>
    <div id="productionSheetCommonBody"></div>
    <div id="productionSheetMatrixTables"><div class="prod-sheet-matrix-tbody"></div></div>
    <button id="prodSheetShareBtn">Share</button>
    <button id="workOrderShareBtn">Share</button>
    <button id="btnBulkShareProduction" class="d-none"></button>

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

  // production.js reads these with innerText, which jsdom only returns when
  // it was also written with innerText.
  document.getElementById('prodSheetDate').innerText = '12/09/2026';
  document.getElementById('prodSheetProductId').innerText = 'PRC-PNT';
  document.getElementById('prodSheetProductName').innerText = 'Painted Frame Kalpi 20 inch';
  document.getElementById('prodSheetLotQty').innerText = '40';

  // A <tr>-shaped row holding its inputs directly, as
  // production_sheet_print.test.js builds them.
  const holder = document.createElement('div');
  holder.innerHTML = `
    <input class="prod-sheet-item-name" value="Primer">
    <input class="prod-sheet-size" value="5 L">
    <input class="prod-sheet-narration" value="">
    <input class="prod-sheet-qty" value="5">`;
  const row = document.createElement('tr');
  row.innerHTML = holder.innerHTML;
  document.getElementById('productionSheetCommonBody').appendChild(row);
}

beforeEach(() => {
  buildDom();
  global.escapeHtml = value => String(value).replace(/[&<>"']/g, ch => HTML_ESCAPE_MAP[ch]);
  global.toNumber = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  global.$ = (sel, root = document) => root.querySelector(sel);
  global.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  toasts = [];
  global.App = {
    State: {
      currentProductionSheet: { colors: [], lotColor: '', outputItemName: 'Painted Frame Kalpi 20 inch', date: '12/09/2026' },
      globalColors: [], globalItems: [], globalProduction: [], selectedProduction: []
    },
    Utils: {
      notPortedYet: jest.fn(),
      showToast: (msg, isError) => toasts.push({ msg, isError: !!isError }),
      sameText: (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase(),
      sameColor(a, b) { return this.sameText(a, b); },
      isCommonColorGroup: g => String(g ?? '').trim().toUpperCase() === 'COMMON'
    },
    Selection: {
      isSelected: (arr, key) => arr.indexOf(key) !== -1,
      updateButton: (id, count, label) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.classList.toggle('d-none', count === 0);
        btn.innerHTML = `${label} (${count})`;
      }
    }
  };
  // eslint-disable-next-line no-eval
  eval(read('print-templates.js').replace(/^const PrintTemplates = /m, 'global.PrintTemplates = '));
  // eslint-disable-next-line no-eval
  eval(read('production.js'));
  // eslint-disable-next-line no-eval
  eval(read('print.js'));

  serve();
  App.Print.saveBlob = jest.fn();
  navigator.canShare = jest.fn(() => true);
  navigator.share = jest.fn(async () => {});
});

afterEach(() => {
  delete navigator.canShare;
  delete navigator.share;
  delete global.App;
});

const sharedNames = () => navigator.share.mock.calls.map(c => c[0].files.map(f => f.name));

describe('the Production Sheet dialog', () => {
  const NAME = 'Painted Frame Kalpi 20 inch_120926.pdf';

  test('Share sends the sheet Download PDF saves, under the same name', async () => {
    await App.Production.downloadProductionSheetPDF();
    await App.Production.shareProductionSheetPDF();

    const [download, share] = requests;
    expect(share.url).toBe('/erp/render-pdf');
    expect(share.body.html).toBe(download.body.html);
    expect(share.body.html).toContain('Primer');
    expect(share.body.filename).toBe(NAME);
    expect(download.body.filename).toBe(NAME);
    expect(sharedNames()).toEqual([[NAME]]);
  });

  test('and its page orientation', async () => {
    document.getElementById('prodSheetOrientLandscape').checked = true;
    await App.Production.shareProductionSheetPDF();
    expect(requests[0].body.landscape).toBe(true);
  });

  test('with no sheet open, does nothing', async () => {
    App.State.currentProductionSheet = null;
    await App.Production.shareProductionSheetPDF();
    expect(requests).toHaveLength(0);
    expect(navigator.share).not.toHaveBeenCalled();
  });
});

describe('the Work Order preview', () => {
  beforeEach(() => {
    App.Production._workOrderPreview = { date: '2026-09-12', contractor: 'Ramesh Kumar', lots: [] };
    App.Production._buildWorkOrderHtml = (date, contractor) => `<div>Work order for ${contractor} on ${date}</div>`;
  });

  test('Share sends the work order Download PDF saves, named for the contractor', async () => {
    await App.Production.downloadWorkOrderPdf();
    await App.Production.shareWorkOrderPdf();

    const [download, share] = requests;
    expect(share.body.html).toBe(download.body.html);
    expect(share.body.html).toContain('Ramesh Kumar');
    expect(share.body.filename).toBe(download.body.filename);
    expect(sharedNames()).toEqual([['WO_RameshKumar_260912.pdf']]);
  });

  test('without a preview, says so and renders nothing', async () => {
    App.Production._workOrderPreview = null;
    await App.Production.shareWorkOrderPdf();
    expect(requests).toHaveLength(0);
    expect(toasts[0].msg).toMatch(/Generate the work order preview first/);
  });
});

describe('Share Selected', () => {
  const LOTS = [
    { rowIdx: 11, outputItemName: 'Painted Frame Kalpi 20 inch', date: '12/09/2026' },
    { rowIdx: 12, outputItemName: 'Packed Kalpi 20 inch', date: '13/09/2026' }
  ];

  beforeEach(() => {
    App.State.globalProduction = LOTS;
    App.State.selectedProduction = ['11', '12'];
    // Each lot's sheet, as the real population would leave the container.
    const container = document.getElementById('print-production-sheet-container');
    App.Production._populateProductionSheetData = lot => {
      App.State.currentProductionSheet = { outputItemName: lot.outputItemName, date: lot.date };
    };
    App.Production._buildProductionSheetForExport = () => {
      const sheet = App.State.currentProductionSheet;
      container.innerHTML = `<p>${sheet ? sheet.outputItemName : 'nothing open'}</p>`;
    };
  });

  test('appears with the selection', () => {
    App.Production.updateBulkButtons();
    const btn = document.getElementById('btnBulkShareProduction');
    expect(btn.classList.contains('d-none')).toBe(false);
    expect(btn.textContent).toContain('Share Selected (2)');
  });

  test('shares one sheet per lot -- the files Download PDFs saves', async () => {
    await App.Production.bulkDownloadPDF();
    await App.Production.bulkShare();

    expect(requests.map(r => r.url)).toEqual(['/erp/render-pdf-batch', '/erp/render-pdf-batch']);
    expect(requests[1].body.documents).toEqual(requests[0].body.documents);
    expect(requests[1].body.zipName).toBe(App.Print.bulkZipName('PRD'));

    const docs = requests[1].body.documents;
    expect(docs.map(d => d.filename)).toEqual([
      'Painted Frame Kalpi 20 inch_120926.pdf',
      'Packed Kalpi 20 inch_130926.pdf'
    ]);
    expect(docs[0].html).toContain('Painted Frame');
    expect(docs[1].html).toContain('Packed Kalpi');
    expect(sharedNames()).toEqual([docs.map(d => d.filename)]);
  });

  test('leaves the sheet that was open behind it as it was', async () => {
    const open = App.State.currentProductionSheet;
    await App.Production.bulkShare();
    expect(App.State.currentProductionSheet).toBe(open);
  });

  test('with nothing selected, renders nothing', async () => {
    App.State.selectedProduction = [];
    await App.Production.bulkShare();
    expect(requests).toHaveLength(0);
  });
});
