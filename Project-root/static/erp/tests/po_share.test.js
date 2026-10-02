/**
 * Purchase orders on desktop -- Share, beside Download PDF.
 *
 * A PO could be printed or saved as a PDF, from its row or as a selection,
 * but not shared. Share hands the same PDF to the operating system's share
 * sheet, under the name Download gives it; Share Selected does it for a
 * selection, one file per PO, honouring the same Rates / Total switches.
 *
 * Loaded once for the file: the row's Share button is routed by core.js's
 * delegated click handler (bindGlobalEvents), and binding that twice would
 * answer every click twice.
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
const PARTIAL = f => fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', f), 'utf8');

// jsdom has no innerText, and the PO template fills its header fields
// (the PO number among them) with it.
Object.defineProperty(HTMLElement.prototype, 'innerText', {
  configurable: true,
  get() { return this.textContent; },
  set(v) { this.textContent = v; }
});

const POS = [
  { poNumber: '1204', poDate: '12/09/2026', vendor: 'Mahadev industries', contact: '', poRemarks: '', status: 'Issued',
    items: [{ name: 'Spoke', size: '', narration: 'Zinc', qty: 500, unit: 'Pcs', price: 1.8 }], grandTotal: 900, totalQty: 500 },
  { poNumber: '1205', poDate: '20/09/2026', vendor: 'Shri Balaji Cycle and Rickshaw Parts', contact: '', poRemarks: '', status: 'Issued',
    items: [{ name: 'Rim', size: '26 inch', narration: '', qty: 20, unit: 'Pcs', price: 105 }], grandTotal: 2100, totalQty: 20 }
];
const NAMES = ['PO_1204_Mahadev.pdf', 'PO_1205_ShriBalaji.pdf'];

// A real store-only ZIP, the shape the server writes (ZIP_STORED).
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
let saved;
let toasts;

// Both endpoints, as the server answers them.
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

// The row buttons' handlers are not awaited by the click; let them finish.
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

beforeAll(() => {
  document.body.innerHTML = PARTIAL('po_ledger.html') + PARTIAL('print.html');
  // eslint-disable-next-line no-eval
  eval([
    read('api.js').replace(/^const Api = /m, 'global.Api = '),
    'global.escapeHtml = escapeHtml;',
    'global.toNumber = toNumber;',
    'global.formatCurrency = formatCurrency;',
    'global.formatQty = formatQty;',
    'global.formatItemsPreview = formatItemsPreview;',
    'global.PO_STATUS = PO_STATUS;',
    'global.parseRecordDate = parseRecordDate;',
    'global.normalizeDateForInput = normalizeDateForInput;',
    'global.todayIso = todayIso;'
  ].join('\n'));
  // eslint-disable-next-line no-eval
  eval(read('print-templates.js').replace(/^const PrintTemplates = /m, 'global.PrintTemplates = '));
  // eslint-disable-next-line no-eval
  eval([
    read('core.js').replace(/^const App = /m, 'global.App = '),
    'global.$ = $;',
    'global.$$ = $$;',
    'global.safeModalShow = safeModalShow;',
    'global.safeModalHide = safeModalHide;',
    'global.setDisabled = setDisabled;',
    'global.bindGlobalEvents = bindGlobalEvents;'
  ].join('\n'));
  // eslint-disable-next-line no-eval
  eval(read('print.js'));
  // eslint-disable-next-line no-eval
  eval(read('po.js'));
  bindGlobalEvents();
});

beforeEach(() => {
  App.State.globalPOs = POS.map(po => JSON.parse(JSON.stringify(po)));
  App.State.filteredPOs = [...App.State.globalPOs];
  App.State.selectedPOs = [];
  App.State.poCurrentPage = 1;
  App.State.poRowsPerPage = 15;
  document.getElementById('printWithRates').checked = true;
  document.getElementById('printWithTotal').checked = true;

  App.Print.serverPdfAvailable = null;
  serve();
  saved = [];
  App.Print.saveBlob = (blob, name) => saved.push(name);
  toasts = [];
  App.Utils.showToast = (msg, isError) => toasts.push({ msg, isError: !!isError });
  navigator.canShare = jest.fn(() => true);
  navigator.share = jest.fn(async () => {});
});

afterEach(() => {
  delete navigator.canShare;
  delete navigator.share;
});

const rowOf = poNumber => {
  App.PO.renderTable();
  return document.querySelector(`#poTableBody tr[data-po-key="${poNumber}"]`);
};
const buttonIn = (row, label) => [...row.querySelectorAll('button')].find(b => b.textContent.trim() === label);

// The documents keep their coloured rule along the top and have none along
// the bottom -- asked for 2026-10-02, for the PO and the Production Sheet.
describe('the document frames', () => {
  const styleOf = id => document.getElementById(id).getAttribute('style');

  test('the PO keeps its red top rule and has no bottom one', () => {
    expect(styleOf('print-po-container')).toMatch(/border-top:\s*5px solid #C0392B/);
    expect(styleOf('print-po-container')).not.toMatch(/border-bottom/);
  });

  test('the Production Sheet keeps its green top rule and has no closing one', () => {
    const sheet = document.getElementById('print-production-sheet-container');
    expect(styleOf('print-production-sheet-container')).toMatch(/border-top:\s*4px solid #198754/);
    expect(styleOf('print-production-sheet-container')).not.toMatch(/border-bottom/);
    expect(sheet.querySelector('.print-sheet-closing-accent')).toBeNull();
    // and no other full-width green band closes it
    const last = [...sheet.children].filter(el => el.tagName === 'DIV').pop();
    expect(last.getAttribute('style') || '').not.toMatch(/background:\s*#198754/);
  });
});

describe('a PO row', () => {
  test('offers Share beside Download PDF', () => {
    expect([...rowOf('1204').querySelectorAll('button')].map(b => b.textContent.trim()))
      .toEqual(['Print Document', 'Edit Order', 'Download PDF', 'Share', 'Delete']);
  });

  test('Share hands that PO to the share sheet, as the PDF Download PDF saves', async () => {
    buttonIn(rowOf('1205'), 'Download PDF').click();
    await settle();
    buttonIn(rowOf('1205'), 'Share').click();
    await settle();

    expect(requests).toHaveLength(2);
    const [download, share] = requests;
    expect(share.url).toBe('/erp/render-pdf');
    expect(share.body.filename).toBe(NAMES[1]);
    expect(share.body.html).toBe(download.body.html);
    expect(share.body.html).toContain('1205');
    expect(share.body.html).toContain('Rim');

    expect(navigator.share).toHaveBeenCalledTimes(1);
    const { files } = navigator.share.mock.calls[0][0];
    expect(files.map(f => [f.name, f.type])).toEqual([[NAMES[1], 'application/pdf']]);
    expect(saved).toEqual([NAMES[1]]);   // the download's, not the share's
  });

  test('its Share button says it is working while the PDF renders', async () => {
    const button = buttonIn(rowOf('1204'), 'Share');
    const pending = App.PO.share(0, button);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('Preparing');
    await pending;
    expect(button.disabled).toBe(false);
    expect(button.textContent.trim()).toBe('Share');
  });

  // It used to show nothing for the length of the render, and a second
  // press saved the PO twice.
  test('its Download PDF button does too, and a second press saves nothing more', async () => {
    const button = buttonIn(rowOf('1204'), 'Download PDF');

    button.click();
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('Preparing');
    button.click();
    await settle();
    await settle();

    expect(requests).toHaveLength(1);
    expect(saved).toEqual([NAMES[0]]);
    expect(button.disabled).toBe(false);
    expect(button.textContent.trim()).toBe('Download PDF');
  });
});

describe('Share Selected', () => {
  test('appears with the selection', () => {
    App.State.selectedPOs = ['1204', '1205'];
    App.PO.updateBulkButtons();
    const btn = document.getElementById('btnBulkSharePOs');
    expect(btn.classList.contains('d-none')).toBe(false);
    expect(btn.textContent).toContain('Share Selected (2)');
  });

  test('shares one PDF per PO -- the files Download PDFs saves', async () => {
    App.State.selectedPOs = ['1204', '1205'];
    await App.PO.bulkDownloadPDF();
    await App.PO.bulkShare();

    expect(requests.map(r => r.url)).toEqual(['/erp/render-pdf-batch', '/erp/render-pdf-batch']);
    expect(requests[1].body.documents).toEqual(requests[0].body.documents);
    expect(requests[1].body.zipName).toBe(App.Print.bulkZipName('PO'));

    const { files } = navigator.share.mock.calls[0][0];
    expect(files.map(f => f.name)).toEqual(NAMES);
    expect(saved).toEqual(NAMES);   // from the download
  });

  // One PO layout, not two: the bulk paths used to draw their own copy of the
  // PO (buildPOPrintPageHtml), which every PO change had to repeat.
  test("each PO's file is the document its own Download PDF sends", async () => {
    buttonIn(rowOf('1205'), 'Download PDF').click();
    await settle();
    const single = requests[0].body.html;

    App.State.selectedPOs = ['1204', '1205'];
    await App.PO.bulkDownloadPDF();

    const bulk = requests[1].body.documents;
    expect(bulk[1].html).toBe(single);
    expect(bulk[0].html).toContain('1204');
    expect(bulk[0].html).not.toContain('1205');
    expect(typeof App.PO.buildPOPrintPageHtml).toBe('undefined');
  });

  test('and Print Selected prints the same PO, a page each, keeping its own cells', () => {
    App.State.selectedPOs = ['1204', '1205'];
    window.print = jest.fn();
    App.PO.bulkPrint();

    const pages = document.querySelectorAll('#print-bulk-body .bulk-print-page');
    expect(pages).toHaveLength(2);
    expect(pages[0].textContent).toContain('1204');
    expect(pages[1].textContent).toContain('1205');
    expect(pages[0].querySelector('[id]')).toBeNull();
    expect(document.getElementById('print-bulk-container').classList.contains('print-cells-own')).toBe(true);
    window.dispatchEvent(new Event('afterprint'));
    expect(document.getElementById('print-bulk-container').classList.contains('print-cells-own')).toBe(false);
  });

  test('honours the Rates switch, as Download PDFs does', async () => {
    App.State.selectedPOs = ['1204', '1205'];
    document.getElementById('printWithRates').checked = false;
    await App.PO.bulkShare();

    const docs = requests[0].body.documents;
    expect(docs[0].html).not.toContain('1.80');
    expect(docs[1].html).not.toContain('105.00');
  });

  test('with nothing selected, says so and renders nothing', async () => {
    await App.PO.bulkShare();
    expect(requests).toHaveLength(0);
    expect(toasts[0].msg).toMatch(/No purchase orders selected/);
  });
});

test('sharing a container that is not on the page renders nothing', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  expect(await App.Print.shareContainer('print-nope-container', 'x')).toBe(false);
  expect(requests).toHaveLength(0);
  warn.mockRestore();
});
