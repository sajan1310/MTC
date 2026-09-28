/**
 * Several production sheets, or several POs, out of the phone as one file
 * each -- under the names desktop gives them.
 *
 * The phone's bulk path built ONE document: four lots selected and shared
 * went out as "Production_Sheets_4.pdf", one page per lot, and could not
 * be sent to four contractors as four attachments. POs had no bulk path
 * at all, and a single PO was named "PO_1204_Mahadev_Industries" where
 * desktop names the same PO "PO_1204_Mahadev".
 *
 * Desktop's Download PDFs posts every document to /erp/render-pdf-batch in
 * one request and saves each PDF in the ZIP it gets back as its own file.
 * The phone does the same now, for Download and for Share. Print stays one
 * job -- a print dialog produces one document, whatever it is fed -- and
 * the pages in it are unchanged (mobile_production_bulk_docs.test.js).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
// jsdom's Blob has no arrayBuffer(), which unzip() reads the archive with;
// node's does. TextDecoder is not global in this jsdom either.
const { Blob: NodeBlob } = require('node:buffer');
const { TextEncoder, TextDecoder } = require('node:util');

global.TextDecoder = TextDecoder;

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const PRINT_PARTIAL = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', 'print.html'), 'utf8');

Object.defineProperty(HTMLElement.prototype, 'innerText', {
  configurable: true,
  get() { return this.textContent; },
  set(v) { this.textContent = v; }
});

const ITEMS = [{ name: 'Primer', size: '5 L', narration: '', baseUnit: 'Ltr' },
  { name: 'Poly Bag', size: 'GENERAL', narration: '', baseUnit: 'Pcs' }];
const PROCESSES = [
  { processId: 'PRC-PNT', processName: 'Frame Painting 20', processType: 'Painting', outputItemName: 'Painted Frame Kalpi 20 inch', active: true },
  { processId: 'PRC-PKG', processName: 'Packing Line 2', processType: 'Packing', outputItemName: 'Packed Kalpi 20 inch', active: true }
];
const LOTS = [
  { rowIdx: 11, lotNumber: 'LOT-PNT-0041', processId: 'PRC-PNT', date: '12/09/2026', qty: 40,
    outputItemName: 'Painted Frame Kalpi 20 inch', colorBreakdown: [], sheetRemarks: '',
    componentsConsumed: [{ itemName: 'Primer', size: '5 L', narration: '', colorGroup: 'COMMON', qty: 5, sourceType: 'ITEM' }] },
  { rowIdx: 12, lotNumber: 'LOT-PKG-0018', processId: 'PRC-PKG', date: '13/09/2026', qty: 30,
    outputItemName: 'Packed Kalpi 20 inch', colorBreakdown: [], sheetRemarks: '',
    componentsConsumed: [{ itemName: 'Poly Bag', size: 'GENERAL', narration: '', colorGroup: 'COMMON', qty: 30, sourceType: 'ITEM' }] }
];
const POS = [
  { poNumber: '1204', poDate: '12/09/2026', vendor: 'Mahadev industries', contact: '', poRemarks: '',
    items: [{ name: 'Spoke', size: '', narration: 'Zinc', qty: 500, unit: 'Pcs', price: 1.8 }], grandTotal: 900, totalQty: 500 },
  { poNumber: '1205', poDate: '20/09/2026', vendor: 'Shri Balaji Cycle and Rickshaw Parts', contact: '', poRemarks: '',
    items: [{ name: 'Rim', size: '26 inch', narration: '', qty: 20, unit: 'Pcs', price: 105 }], grandTotal: 2100, totalQty: 20 }
];

function loadMobile() {
  // eslint-disable-next-line no-eval
  eval([
    read('api.js').replace(/^const Api = /m, 'global.Api = '),
    'global.escapeHtml = escapeHtml;',
    'global.toNumber = toNumber;',
    'global.formatCurrency = formatCurrency;',
    'global.formatQty = formatQty;',
    'global.dateToInputValue = dateToInputValue;',
    'global.todayIso = todayIso;'
  ].join('\n'));
  // eslint-disable-next-line no-eval
  eval(read('print-templates.js').replace(/^const PrintTemplates = /m, 'global.PrintTemplates = '));
  // eslint-disable-next-line no-eval
  eval(read('mobile.js').replace(/^const MApp = /m, 'global.MApp = '));
}

// Desktop's App.Print, in a sandbox of its own, for the name parity check.
function desktopPrint() {
  const sandbox = { App: { Utils: {} }, document, window, console, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  vm.runInContext(read('print.js'), sandbox);
  return sandbox.App.Print;
}

// A real store-only ZIP, the shape the server writes (ZIP_STORED), so
// unzip() is exercised on bytes rather than on a stub.
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

// The batch endpoint answers with one PDF per document it was sent, under
// the filename it was sent -- which is what the server does.
function serveBatch() {
  requests = [];
  global.fetch = jest.fn(async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, body });
    const entries = (body.documents || []).map(d => [d.filename, `%PDF-${d.filename}`]);
    return { ok: true, status: 200, blob: async () => storeZip(entries) };
  });
}

beforeEach(() => {
  jest.resetModules();
  try { localStorage.clear(); } catch (e) { /* not available */ }
  document.head.innerHTML = '';
  document.body.innerHTML = `${PRINT_PARTIAL}<div id="mapp-toast-stack"></div>`;
  loadMobile();
  MApp.Api.callCached = jest.fn(async method => ({
    success: true,
    data: { getItemsData: ITEMS, getColors: [], getProcessData: PROCESSES }[method]
  }));
  serveBatch();
  saved = [];
  MApp.Print.saveBlob = (blob, name) => saved.push(name);
  MApp.Print.canShareFiles = () => true;
});

// The chooser, answered: returns what MApp.Print.chooseAction was handed,
// and runs the named action on it.
async function choose(run, action) {
  const spy = jest.spyOn(MApp.Print, 'chooseAction').mockResolvedValue(undefined);
  await run();
  const opts = spy.mock.calls[0][0];
  spy.mockRestore();
  if (action) await MApp.Print._runAction({ value: action }, opts);
  return opts;
}

describe('names', () => {
  const SPECS = [
    { type: 'PO', key: '1204', party: 'Mahadev industries' },
    { type: 'PO', key: 'PO-1205', party: 'Shri Balaji Cycle and Rickshaw Parts' },
    { type: 'PO', key: '1206', party: 'ਗੁਰੂ ਨਾਨਕ ਟ੍ਰੇਡਰਜ਼' },
    { type: 'PO', key: '1207', party: '' },
    { type: 'PRD', date: '2026-09-28' },
    { type: 'DC', key: 'DC-1041', party: 'Sharma & Sons (Ludhiana)' },
    { type: 'ISS', key: 'ISS-20260928-101530', party: 'Ramesh Kumar' }
  ];

  test.each(SPECS)('the phone names %o as desktop does', spec => {
    expect(MApp.Print.docName(spec)).toBe(desktopPrint().docName(spec));
  });

  test('a single PO is named as desktop names it', () => {
    expect(MApp.PO._printTitle(POS[0])).toBe('PO_1204_Mahadev');
    expect(MApp.PO._printTitle(POS[1])).toBe('PO_1205_ShriBalaji');
  });

  test('the archive is CODE_YYMMDD.zip, as desktop\'s is', () => {
    expect(MApp.Print.bulkZipName('PO')).toBe(desktopPrint().bulkZipName('PO'));
  });
});

describe('production sheets', () => {
  test('Download: one PDF per lot, each named for what the lot makes', async () => {
    await choose(() => MApp.ProductionSheet.printSheets(LOTS), 'download');

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('/erp/render-pdf-batch');
    expect(requests[0].body.zipName).toBe(MApp.Print.bulkZipName('PRD'));
    const docs = requests[0].body.documents;
    expect(docs.map(d => d.filename)).toEqual([
      'Painted Frame Kalpi 20 inch_120926.pdf',
      'Packed Kalpi 20 inch_130926.pdf'
    ]);
    // Each file is its own lot's sheet, not the stack.
    expect(docs[0].html).toContain('LOT-PNT-0041');
    expect(docs[0].html).not.toContain('LOT-PKG-0018');
    expect(docs[1].html).toContain('Packing Requirement Sheet');
    expect(docs[1].html).not.toContain('Primer');
    // The same self-contained form a single download sends.
    expect(docs[0].html).toMatch(/^<style>/);
    expect(docs[0].html).toContain('id="print-production-sheet-container"');

    expect(saved).toEqual(docs.map(d => d.filename));
  });

  test('each file is the document a single lot\'s own Download produces', async () => {
    MApp.ProductionSheet._renderLot(LOTS[0], {
      items: ITEMS, colors: [], processes: PROCESSES
    }, false);
    const single = MApp.Print.capturePdfDocument(
      'print-production-sheet-container', MApp.ProductionSheet.docName(LOTS[0]), false);

    await choose(() => MApp.ProductionSheet.printSheets(LOTS), 'download');
    expect(requests[0].body.documents[0]).toEqual(single);
  });

  test('the Page choice reaches every file', async () => {
    MApp.Prefs.toggle(MApp.ProductionSheet.PREF_LANDSCAPE, false);
    await choose(() => MApp.ProductionSheet.printSheets(LOTS), 'download');
    expect(requests[0].body.documents.map(d => d.landscape)).toEqual([true, true]);
  });

  test('Print is still one job, titled as desktop titles Print Selected', async () => {
    const opts = await choose(() => MApp.ProductionSheet.printSheets(LOTS));
    expect(opts.filename).toBe(MApp.Print.docName({ type: 'PRD', date: true }));
    expect(opts.filename).toMatch(/^PRD_\d{6}$/);
  });

  test('the chooser says what each action produces', async () => {
    MApp.Picker.open = jest.fn(async () => null);
    await MApp.ProductionSheet.printSheets(LOTS);
    const items = MApp.Picker.open.mock.calls[0][0].items;
    expect(items.slice(0, 3).map(i => [i.label, i.sublabel])).toEqual([
      ['Print', 'All 2 in one print job'],
      ['Download PDFs', '2 files, one per lot'],
      ['Share', '2 files, one per lot']
    ]);
  });

  test('Share hands the phone one file per lot, named as the downloads are', async () => {
    navigator.canShare = jest.fn(() => true);
    navigator.share = jest.fn(async () => {});
    await choose(() => MApp.ProductionSheet.printSheets(LOTS), 'share');

    expect(navigator.share).toHaveBeenCalledTimes(1);
    const { files, title } = navigator.share.mock.calls[0][0];
    expect(files.map(f => f.name)).toEqual([
      'Painted Frame Kalpi 20 inch_120926.pdf',
      'Packed Kalpi 20 inch_130926.pdf'
    ]);
    expect(files.every(f => f.type === 'application/pdf')).toBe(true);
    expect(title).toMatch(/^PRD_\d{6}$/);
  });
});

describe('purchase orders', () => {
  test('the selection bar offers them', async () => {
    expect(MApp.PO.SELECT.documents.label).toBe('Print / Share');
    const many = jest.spyOn(MApp.PO, 'printMany').mockResolvedValue(undefined);
    await MApp.PO.SELECT.documents.run(POS);
    expect(many).toHaveBeenCalledWith(POS);
  });

  test('Download: one PDF per PO, under the PO\'s own name', async () => {
    await choose(() => MApp.PO.printMany(POS), 'download');

    const docs = requests[0].body.documents;
    expect(requests[0].body.zipName).toBe(MApp.Print.bulkZipName('PO'));
    expect(docs.map(d => d.filename)).toEqual(['PO_1204_Mahadev.pdf', 'PO_1205_ShriBalaji.pdf']);
    expect(docs[0].html).toContain('1204');
    expect(docs[0].html).not.toContain('1205');
    expect(docs[1].html).toContain('Rim');
    expect(saved).toEqual(['PO_1204_Mahadev.pdf', 'PO_1205_ShriBalaji.pdf']);
  });

  test('the Rates switch holds for every PO in the stack', async () => {
    await choose(() => MApp.PO.printMany(POS), 'download');
    expect(requests[0].body.documents[0].html).toContain('1.80');
    expect(requests[0].body.documents[1].html).toContain('105.00');

    MApp.Prefs.toggle(MApp.PO.PREF_RATES, true);
    await choose(() => MApp.PO.printMany(POS), 'download');
    expect(requests[1].body.documents[0].html).not.toContain('1.80');
    expect(requests[1].body.documents[1].html).not.toContain('105.00');
  });

  test('Print: one job, a page per PO, drawn with the PO\'s own cells', async () => {
    const opts = await choose(() => MApp.PO.printMany(POS));
    expect(opts.filename).toBe('Purchase_Orders_Selected');
    await opts.populate();

    const pages = document.querySelectorAll('#print-bulk-body .bulk-print-page');
    expect(pages).toHaveLength(2);
    expect(pages[0].textContent).toContain('1204');
    expect(pages[1].textContent).toContain('1205');
    expect(pages[0].querySelectorAll('[id]')).toHaveLength(0);
    expect(document.getElementById('print-bulk-container').classList.contains('print-cells-own')).toBe(true);
  });

  test('one PO printed from a selection is named as that PO', async () => {
    const opts = await choose(() => MApp.PO.printMany([POS[1]]));
    expect(opts.filename).toBe('PO_1205_ShriBalaji');
  });
});

describe('stock issue receipts', () => {
  const ISSUES = [
    { issueId: 'ISS-20260928-101530', date: '28/09/2026', dateRaw: '2026-09-28', issuedTo: 'Ramesh Kumar',
      reference: 'LOT-PNT-0041', remarks: '', totalQty: 12, totalValue: 0,
      items: [{ name: 'Primer', size: '5 L', qty: 12, unit: 'Ltr', rate: 0 }] },
    { issueId: 'ISS-20260928-111204', date: '28/09/2026', dateRaw: '2026-09-28', issuedTo: 'Painting Dept',
      reference: '', remarks: 'rework', totalQty: 30, totalValue: 0,
      items: [{ name: 'Poly Bag', size: 'GENERAL', qty: 30, unit: 'Pcs', rate: 0 }] }
  ];
  const NAMES = ['ISS_20260928-101530_RameshKumar.pdf', 'ISS_20260928-111204_PaintingDept.pdf'];

  test('are named as desktop names them', () => {
    const desktop = desktopPrint();
    ISSUES.forEach(rec => {
      expect(MApp.Issue.docName(rec)).toBe(
        desktop.docName({ type: 'ISS', key: rec.issueId, party: rec.issuedTo }));
    });
    expect(MApp.Issue.docName(ISSUES[0])).toBe('ISS_20260928-101530_RameshKumar');
  });

  test('the selection bar offers them', async () => {
    expect(MApp.Issue.SELECT.documents.label).toBe('Print / Share');
    const many = jest.spyOn(MApp.Issue, 'printMany').mockResolvedValue(undefined);
    await MApp.Issue.SELECT.documents.run(ISSUES);
    expect(many).toHaveBeenCalledWith(ISSUES);
  });

  test('Download: one PDF per receipt, each its own receipt', async () => {
    await choose(() => MApp.Issue.printMany(ISSUES), 'download');

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('/erp/render-pdf-batch');
    expect(requests[0].body.zipName).toBe(MApp.Print.bulkZipName('ISS'));
    const docs = requests[0].body.documents;
    expect(docs.map(d => d.filename)).toEqual(NAMES);
    expect(docs[0].html).toContain('Stock Issue Receipt');
    expect(docs[0].html).toContain('ISS-20260928-101530');
    expect(docs[0].html).not.toContain('ISS-20260928-111204');
    expect(docs[1].html).toContain('Poly Bag');
    expect(docs[1].html).not.toContain('Primer');
    expect(saved).toEqual(NAMES);
  });

  test('each file is the document that receipt\'s own Download sends', async () => {
    await choose(() => MApp.Issue.printNote(ISSUES[1]), 'download');
    const single = requests[0];
    expect(single.url).toBe('/erp/render-pdf');
    expect(single.body.filename).toBe(NAMES[1]);

    await choose(() => MApp.Issue.printMany(ISSUES), 'download');
    const fromBatch = requests[1].body.documents[1];
    expect(fromBatch.html).toBe(single.body.html);
    expect(fromBatch.filename).toBe(single.body.filename);
  });

  test('Share hands the phone one file per receipt, named as the downloads are', async () => {
    navigator.canShare = jest.fn(() => true);
    navigator.share = jest.fn(async () => {});
    await choose(() => MApp.Issue.printMany(ISSUES), 'share');

    expect(navigator.share).toHaveBeenCalledTimes(1);
    const { files } = navigator.share.mock.calls[0][0];
    expect(files.map(f => f.name)).toEqual(NAMES);
    expect(files.every(f => f.type === 'application/pdf')).toBe(true);
  });

  test('Print is one job, a page per receipt', async () => {
    const opts = await choose(() => MApp.Issue.printMany(ISSUES));
    expect(opts.filename).toBe('Stock_Issue_Receipts_Selected');
    await opts.populate();

    const pages = document.querySelectorAll('#print-bulk-body .bulk-print-page');
    expect(pages).toHaveLength(2);
    expect(pages[0].textContent).toContain('ISS-20260928-101530');
    expect(pages[1].textContent).toContain('ISS-20260928-111204');
  });

  test('a card\'s Print / Share opens the chooser on that receipt', async () => {
    document.body.insertAdjacentHTML('beforeend', '<div id="issue-log-list"></div>');
    MApp.Issue.records = ISSUES;
    MApp.Issue.filtered = ISSUES;
    MApp.Issue.render();
    const spy = jest.spyOn(MApp.Print, 'chooseAction').mockResolvedValue(undefined);

    const buttons = document.querySelectorAll('#issue-log-list [data-issue-action="document"]');
    expect([...buttons].map(b => b.textContent)).toEqual(['Print / Share', 'Print / Share']);
    buttons[1].click();

    const opts = spy.mock.calls[0][0];
    expect(opts.filename).toBe('ISS_20260928-111204_PaintingDept');
    await opts.populate();
    expect(document.getElementById('print-bulk-body').textContent).toContain('ISS-20260928-111204');
    expect(document.getElementById('print-bulk-body').textContent).not.toContain('ISS-20260928-101530');
  });
});

describe('sharing a long stack', () => {
  const many = n => Array.from({ length: n }, (_, i) => ({
    ...POS[0], poNumber: String(1300 + i)
  }));

  beforeEach(() => {
    navigator.canShare = jest.fn(() => true);
    navigator.share = jest.fn(async () => {});
  });

  test('goes ten files at a time, each ten after the first on a tap of its own', async () => {
    MApp.Picker.open = jest.fn(async ({ items }) => items[0]);
    await choose(() => MApp.PO.printMany(many(23)), 'share');

    expect(navigator.share.mock.calls.map(c => c[0].files.length)).toEqual([10, 10, 3]);
    expect(MApp.Picker.open).toHaveBeenCalledTimes(2);
    expect(MApp.Picker.open.mock.calls[0][0].items[0].label).toBe('Share 10 PDFs (11–20 of 23)');
    expect(MApp.Picker.open.mock.calls[1][0].items[0].label).toBe('Share 3 PDFs (21–23 of 23)');
  });

  test('stops when the operator declines the next batch', async () => {
    MApp.Picker.open = jest.fn(async () => null);
    await choose(() => MApp.PO.printMany(many(12)), 'share');
    expect(navigator.share).toHaveBeenCalledTimes(1);
  });

  test('a share sheet that outlived its tap asks for another, then opens', async () => {
    const lapsed = Object.assign(new Error('no activation'), { name: 'NotAllowedError' });
    navigator.share = jest.fn()
      .mockRejectedValueOnce(lapsed)
      .mockResolvedValueOnce(undefined);
    MApp.Picker.open = jest.fn(async ({ items }) => items[0]);

    await choose(() => MApp.PO.printMany(POS), 'share');
    expect(MApp.Picker.open).toHaveBeenCalledTimes(1);
    expect(MApp.Picker.open.mock.calls[0][0].items[0].label).toBe('Share 2 PDFs');
    expect(navigator.share).toHaveBeenCalledTimes(2);
  });

  test('dismissing the share sheet is not reported as a failure', async () => {
    navigator.share = jest.fn(async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); });
    await choose(() => MApp.PO.printMany(POS), 'share');
    expect(document.getElementById('mapp-toast-stack').textContent).not.toContain('Could not share');
  });
});

test('a server that cannot render says so, and saves nothing', async () => {
  global.fetch = jest.fn(async () => ({ ok: false, status: 503 }));
  await choose(() => MApp.PO.printMany(POS), 'download');
  expect(saved).toEqual([]);
  expect(document.getElementById('mapp-toast-stack').textContent).toContain('no PDF renderer');
});
