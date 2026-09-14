/**
 * The phone prints desktop's documents, not documents that resemble them.
 *
 * Three it did not:
 *
 *   - The vendor ledger went out as the BULK-print page, whose five column
 *     titles sat over eight columns of figures and which has no Balance.
 *     Desktop's Print Ledger fills a nine-column template of its own.
 *   - The client ledger went out as a blue page built for the phone, under
 *     other headings, where desktop's is orange and titled differently.
 *   - Wastage printed a page per entry with no heading. Desktop prints one
 *     "Wastage Report" page with every entry on it.
 *
 * The first two are checked the strongest way available: desktop's own
 * vendors.js and client.js are run, read-only, against the same data, and
 * the template the phone fills must come out identical to the one they
 * fill. Desktop is the reference; nothing here changes it.
 *
 * The rest pins the print path's own behaviour: orientation, what a PDF is
 * rendered from, and the bulk container's cell switch.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const PARTIAL = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', 'print.html'), 'utf8');

// Markup compared as markup: the two sides indent their template literals
// differently and that is not a difference anyone can see on paper.
const norm = html => html.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();

// jsdom has no innerText. Both shells fill header fields with it, so
// without this every one of them would compare as empty on both sides.
Object.defineProperty(HTMLElement.prototype, 'innerText', {
  configurable: true,
  get() { return this.textContent; },
  set(v) { this.textContent = v; }
});

function loadShells() {
  jest.resetModules();
  global.fetch = jest.fn();
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

// Desktop's App, as far as the ledger modules reach into it. sameText and
// formatNameCase are core.js's own definitions; templateDeps is print.js's.
function desktopApp(state) {
  const sameText = (a, b) =>
    String(a == null ? '' : a).trim().toLowerCase() === String(b == null ? '' : b).trim().toLowerCase();
  const formatNameCase = text => {
    const s = String(text == null ? '' : text).trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;
  };
  global.App = {
    State: { ...state },
    Utils: { sameText, formatNameCase, notPortedYet: jest.fn() },
    Print: {
      templateDeps: () => ({
        escapeHtml, toNumber, formatCurrency, formatNameCase, sameText, brandColor: '#C0392B'
      }),
      trigger: jest.fn()
    },
    Production: { formatQty: v => Number(toNumber(v).toFixed(4)).toString() }
  };
}

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  loadShells();
});

afterEach(() => {
  delete global.App;
});

describe('the vendor ledger', () => {
  const VENDOR = {
    name: 'Webest Bikes', gstin: '03AAACW1234K1Z2', contact: '98140 11223',
    address: 'Focal Point, Ludhiana', remarks: ''
  };
  const SRC = {
    pos: [
      { poNumber: '1214', vendor: 'Webest Bikes', poDate: '26/08/2026', poDateRaw: '2026-08-26', grandTotal: 172400,
        items: [
          { name: 'Spoke 85-110', size: '14 inch', narration: '110 mm', qty: 250, baseQty: 36000, unit: 'Gross', price: 100 },
          { name: 'Rim Black', size: '20 inch', narration: '', qty: 1200, baseQty: 1200, unit: 'Pcs', price: 86.5 }] },
      { poNumber: '1199', vendor: 'Webest Bikes', poDate: '02/08/2026', poDateRaw: '2026-08-02', grandTotal: 43600,
        items: [{ name: 'Spoke 85-194', size: '20 inch', narration: 'Bicycle Spoke', qty: 400, baseQty: 57600, unit: 'Gross', price: 109 }] },
      { poNumber: '1180', vendor: 'Someone Else', poDate: '01/08/2026', poDateRaw: '2026-08-01', grandTotal: 10,
        items: [{ name: 'Rim Black', size: '20 inch', qty: 5, baseQty: 5, price: 2 }] }
    ],
    bills: [
      { billNumber: 'WB/2231', vendor: 'Webest Bikes', billDate: '30/08/2026', billDateRaw: '2026-08-30', totalAmount: 60180,
        items: [{ name: 'Rim Black', size: '20 inch', narration: '', qty: 600, baseQty: 600, poNumber: '1214' }] },
      // Over-billed: more arrived than PO 1199 ordered.
      { billNumber: 'WB/2190', vendor: 'Webest Bikes', billDate: '12/08/2026', billDateRaw: '2026-08-12', totalAmount: 51444,
        items: [{ name: 'Spoke 85-194', size: '20 inch', narration: 'Bicycle Spoke', qty: 420, baseQty: 60480, poNumber: '1199' }] }
    ],
    returns: [
      { returnNumber: 'RET-31', vendor: 'Webest Bikes', returnDate: '01/09/2026', returnDateRaw: '2026-09-01', totalAmount: 1730,
        items: [{ name: 'Rim Black', size: '20 inch', qty: 20 }] }
    ],
    issues: [
      { issueId: 'ISS-7', vendor: 'Webest Bikes', date: '03/09/2026', dateRaw: '2026-09-03', totalQty: 700, totalValue: 0,
        items: [{ name: 'Rim Black', size: '20 inch', qty: 700 }] }
    ]
  };

  // What desktop's Print Ledger button leaves in its template.
  function desktopDocument() {
    document.body.innerHTML = `${PARTIAL}
      <input id="originalVendorName"><input id="vFormGstin"><input id="vFormContact">
      <input id="vFormAddress"><input id="vFormRemarks">
      <table><tbody id="vendorLedgerBody"></tbody><tbody id="vendorPendingBody"></tbody></table>`;
    desktopApp({
      globalPOs: SRC.pos, globalBills: SRC.bills, globalReturns: SRC.returns,
      globalIssues: SRC.issues, globalItems: [], globalVendors: [VENDOR]
    });
    // eslint-disable-next-line no-eval
    eval(read('vendors.js'));
    document.getElementById('originalVendorName').value = VENDOR.name;
    document.getElementById('vFormGstin').value = VENDOR.gstin;
    document.getElementById('vFormContact').value = VENDOR.contact;
    document.getElementById('vFormAddress').value = VENDOR.address;
    document.getElementById('vFormRemarks').value = VENDOR.remarks;
    App.Vendor.populateLedgerAndPending(VENDOR.name);
    App.Vendor.printLedger();
    expect(App.Print.trigger).toHaveBeenCalledWith('print-vendor-ledger-container', 'Vendor_Ledger_Webest_Bikes');
    return document.getElementById('print-vendor-ledger-container').innerHTML;
  }

  function phoneDocument() {
    document.body.innerHTML = PARTIAL;
    MApp.Directory._populateVendorLedger(VENDOR, SRC);
    return document.getElementById('print-vendor-ledger-container').innerHTML;
  }

  test('the phone fills desktop\'s template exactly as desktop does', () => {
    const desktop = desktopDocument();
    const phone = phoneDocument();
    expect(norm(phone)).toBe(norm(desktop));
    // And the comparison compared something.
    expect(phone).toContain('WB/2231');
    expect(phone).toContain('RET-31');
    expect(phone).toContain('+2880 over');
  });

  test('every ledger row has a cell under every heading', () => {
    // The bulk page this replaced had five headings over eight cells.
    phoneDocument();
    const container = document.getElementById('print-vendor-ledger-container');
    const headings = container.querySelector('table thead').querySelectorAll('th').length;
    const rows = container.querySelectorAll('#print-vendor-ledger-body tr');
    expect(headings).toBe(9);
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach(tr => expect(tr.cells.length).toBe(headings));
  });

  test('blank fields print the way desktop prints them', () => {
    document.body.innerHTML = PARTIAL;
    MApp.Directory._populateVendorLedger({ name: 'Nobody' }, { pos: [], bills: [], returns: [], issues: [] });
    expect(document.getElementById('print-vendor-gstin').textContent).toBe('-');
    expect(document.getElementById('print-vendor-remarks').textContent).toBe('No remarks');
    expect(document.getElementById('print-vendor-ledger-body').textContent).toContain('No transaction history found.');
    expect(document.getElementById('print-vendor-pending-body').textContent).toContain('All caught up');
  });

  test('printing fetches only what the document needs, into desktop\'s template', async () => {
    MApp.Directory.type = 'vendor';
    MApp.Api.call = jest.fn(async () => ({ success: true, data: [] }));
    const choose = jest.spyOn(MApp.Print, 'chooseAction').mockResolvedValue(undefined);

    await MApp.Directory.printLedger(VENDOR);

    expect(MApp.Api.call.mock.calls.map(c => c[0]).sort())
      .toEqual(['getBillData', 'getIssueData', 'getPOData', 'getReturnData']);
    const opts = choose.mock.calls[0][0];
    expect(opts.containerId).toBe('print-vendor-ledger-container');
    expect(opts.filename).toBe('Vendor_Ledger_Webest_Bikes');
    expect(typeof opts.populate).toBe('function');
  });
});

describe('the client ledger', () => {
  const CLIENT = {
    name: 'nova MOTORS', gstin: '03ABCDE1234F1Z5', contact: '98765 00000',
    address: '12 Mill Road, Ludhiana', remarks: 'Pays in 30 days'
  };
  const ORDERS = [
    { orderNumber: 'SO-1', clientName: 'Nova Motors', orderDate: '01/09/2026', status: 'Order Confirmed',
      lines: [{ productId: 'PRD-1', productName: 'Kalpi 26', qty: 40 }, { productId: 'PRD-7', productName: 'Jungle King 14', qty: 200 }] },
    { orderNumber: 'SO-2', clientName: 'Nova Motors', orderDate: '03/09/2026', status: 'Order Confirmed',
      lines: [{ productId: 'PRD-1', productName: 'Kalpi 26', qty: 10, productionPushed: true }] },
    { orderNumber: 'SO-3', clientName: 'nova motors', orderDate: '05/09/2026', status: 'Estimate',
      lines: [{ productId: 'PRD-1', productName: 'Kalpi 26', qty: 5 }] },
    { orderNumber: 'SO-4', clientName: 'Nova Motors', orderDate: '06/09/2026', status: 'Cancelled', lines: [] },
    { orderNumber: 'SO-9', clientName: 'Other Client', orderDate: '06/09/2026', status: 'Order Confirmed',
      lines: [{ productId: 'PRD-1', productName: 'Kalpi 26', qty: 1 }] }
  ];
  const DISPATCHES = [
    { dispatchNumber: 'DC-1041', clientName: 'Nova Motors', dispatchDate: '08/09/2026', orderNumber: 'SO-1',
      productId: 'PRD-1', productName: 'Kalpi 26', qty: 25, transport: 'Blue Dart', invoiceNumber: 'INV-1', grNumber: 'GR-2' },
    { dispatchNumber: 'DC-1050', clientName: 'Other Client', dispatchDate: '09/09/2026', orderNumber: 'SO-9',
      productId: 'PRD-1', productName: 'Kalpi 26', qty: 1, transport: '' }
  ];

  function desktopDocument() {
    document.body.innerHTML = `${PARTIAL}
      <input id="clientLedgerName">
      <div id="clientLedgerTitle"></div><div id="clientLedgerContact"></div>
      <div id="clientLedgerGstin"></div><div id="clientLedgerAddress"></div>
      <table><tbody id="clientLedgerOrdersBody"></tbody><tbody id="clientLedgerPendingBody"></tbody>
      <tbody id="clientLedgerDispatchBody"></tbody></table>`;
    desktopApp({ globalClients: [CLIENT], globalOrders: ORDERS, globalDispatch: DISPATCHES });
    // eslint-disable-next-line no-eval
    eval(read('client.js'));
    document.getElementById('clientLedgerName').value = CLIENT.name;
    App.Client.populateClientLedger(CLIENT.name);
    App.Client.printLedger();
    expect(App.Print.trigger).toHaveBeenCalledWith('print-client-ledger-container', 'Client_Ledger_nova_MOTORS');
    return document.getElementById('print-client-ledger-container').innerHTML;
  }

  function phoneDocument() {
    document.body.innerHTML = PARTIAL;
    MApp.Directory._populateClientLedger(CLIENT, { orders: ORDERS, dispatches: DISPATCHES });
    return document.getElementById('print-client-ledger-container').innerHTML;
  }

  test('the phone fills desktop\'s template exactly as desktop does', () => {
    const desktop = desktopDocument();
    const phone = phoneDocument();
    expect(norm(phone)).toBe(norm(desktop));
    expect(phone).toContain('Nova motors');
    expect(phone).toContain('DC-1041');
    expect(phone).not.toContain('DC-1050');
  });

  test('each order carries the status desktop gives it, not its raw status', () => {
    phoneDocument();
    const orders = document.getElementById('print-client-orders-body').textContent;
    expect(orders).toContain('Partially Dispatched');
    expect(orders).toContain('In Production');
    expect(orders).toContain('Estimate');
    expect(orders).toContain('Cancelled');
  });

  test('printing fetches only what the document needs, into desktop\'s template', async () => {
    MApp.Directory.type = 'client';
    MApp.Api.call = jest.fn(async () => ({ success: true, data: [] }));
    const choose = jest.spyOn(MApp.Print, 'chooseAction').mockResolvedValue(undefined);

    await MApp.Directory.printLedger(CLIENT);

    expect(MApp.Api.call.mock.calls.map(c => c[0]).sort()).toEqual(['getClientOrdersData', 'getDispatchData']);
    expect(choose.mock.calls[0][0].containerId).toBe('print-client-ledger-container');
  });
});

describe('the wastage report', () => {
  const RECORDS = [
    { wastageId: 'WST-9', date: '07/09/2026', vendor: 'webest BIKES', remarks: 'paint run',
      items: [{ name: 'Frame 14', size: '14 inch', unit: 'Pcs', qty: 2, reason: 'Rejected' }], totalQty: 2 },
    { wastageId: 'WST-10', date: '09/09/2026', vendor: '', remarks: '',
      items: [{ name: 'Primer', size: '', unit: 'Ltr', qty: 1.5, reason: 'Spilled' }], totalQty: 1.5 }
  ];

  test('is desktop\'s page: one heading, the count, and every entry on it', () => {
    desktopApp({});
    // eslint-disable-next-line no-eval
    eval(read('return.js'));
    const desktop = new DOMParser()
      .parseFromString(App.Wastage.buildWastagePrintPageHtml(RECORDS), 'text/html').body;

    document.body.innerHTML = MApp.Wastage.reportHtml(RECORDS);
    const phone = document.querySelector('.mb-standalone-doc');

    expect(phone.querySelector('h2').textContent).toBe(desktop.querySelector('h2').textContent);
    expect(phone.querySelector('.header-meta').textContent)
      .toBe(desktop.querySelector('.header-meta').textContent);
    const entries = root => [...root.querySelectorAll('.wastage-entry')].map(e => norm(e.outerHTML));
    expect(entries(phone)).toHaveLength(2);
    expect(entries(phone)).toEqual(entries(desktop));
  });

  test('prints as ONE page, drawing its own cells', () => {
    const bulk = jest.spyOn(MApp.Print, 'bulk').mockReturnValue(undefined);
    MApp.Wastage.filtered = RECORDS;

    MApp.Wastage.printAllNotes();

    const [items, build, opts] = bulk.mock.calls[0];
    expect(items).toHaveLength(1);
    expect(build(items[0])).toContain('Records: 2');
    expect(opts.cellsOwn).toBe(true);
    expect(opts.title).toBe('Wastage Report');
  });

  test('a single entry prints the same page with one record on it', () => {
    const bulk = jest.spyOn(MApp.Print, 'bulk').mockReturnValue(undefined);
    MApp.Wastage.filtered = RECORDS;

    MApp.Wastage.printNote(1);

    const [items, build, opts] = bulk.mock.calls[0];
    expect(build(items[0])).toContain('Records: 1');
    expect(build(items[0])).toContain('WST-10');
    expect(opts.filename).toBe('Wastage_WST-10');
  });
});

describe('page orientation', () => {
  function wideStockPivot(columns) {
    const cells = n => Array.from({ length: n }, (_, i) => `<td>${i}</td>`).join('');
    document.getElementById('print-low-stock-body').innerHTML = `<tr>${cells(columns)}</tr>`;
  }

  beforeEach(() => {
    document.body.innerHTML = PARTIAL;
    window.print = jest.fn();
  });

  test('a landscape job turns the page for that job only', () => {
    MApp.Print.trigger('print-po-container', 'PO_1214', { landscape: true });

    expect(document.getElementById('mapp-print-orientation').textContent)
      .toBe('@page { size: a4 landscape; margin: 6mm; }');
    window.dispatchEvent(new Event('afterprint'));
    expect(document.getElementById('mapp-print-orientation')).toBeNull();
  });

  test('a portrait job adds no page rule at all', () => {
    MApp.Print.trigger('print-po-container', 'PO_1214');
    expect(document.getElementById('mapp-print-orientation')).toBeNull();
  });

  test('\'auto\' turns the page only past twelve columns, as desktop does', () => {
    wideStockPivot(12);
    MApp.Print.trigger('print-low-stock-container', 'STK', { landscape: 'auto' });
    expect(document.getElementById('mapp-print-orientation')).toBeNull();
    window.dispatchEvent(new Event('afterprint'));

    wideStockPivot(15);
    MApp.Print.trigger('print-low-stock-container', 'STK', { landscape: 'auto' });
    expect(document.getElementById('mapp-print-orientation')).not.toBeNull();
  });

  test('the Print action passes the orientation through', async () => {
    const trigger = jest.spyOn(MApp.Print, 'trigger').mockReturnValue(undefined);
    await MApp.Print._runAction({ value: 'print' },
      { containerId: 'print-low-stock-container', filename: 'STK', landscape: 'auto' });
    expect(trigger).toHaveBeenCalledWith('print-low-stock-container', 'STK', { landscape: 'auto' });
  });

  test('the stock pivot asks for \'auto\', as desktop\'s printStockPivot does', () => {
    const choose = jest.spyOn(MApp.Print, 'chooseAction').mockResolvedValue(undefined);
    MApp.Print.pivot([], [], { reportType: 'Stock Report', filename: 'STK' });
    expect(choose.mock.calls[0][0].landscape).toBe('auto');
  });

  test('a PDF turns only when asked outright: \'auto\' downloads portrait, as on desktop', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(['%PDF']) }));
    await MApp.Print._pdfFor('print-low-stock-container', 'STK.pdf', 'auto');
    await MApp.Print._pdfFor('print-low-stock-container', 'STK.pdf', true);
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).landscape).toBe(false);
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).landscape).toBe(true);
  });

  test('the job title is made safe for a filename the way desktop makes it', () => {
    MApp.Print.trigger('print-po-container', 'PO: 12/14 "Webest"');
    expect(document.title).toBe('PO- 12-14 -Webest-');
  });
});

describe('what a PDF is rendered from', () => {
  beforeEach(() => {
    document.body.innerHTML = PARTIAL;
    MApp.Print._printCss = '';
  });

  test('the container itself, revealed, with the rules it prints under', () => {
    const el = document.getElementById('print-po-container');
    const html = MApp.Print.pdfDocumentHtml(el);

    expect(html.startsWith('<style>')).toBe(true);
    // partials/print.html's utilities, which the renderer never had.
    expect(html).toContain('.print-container .text-muted');

    const sent = new DOMParser().parseFromString(html, 'text/html').getElementById('print-po-container');
    expect(sent.classList.contains('active-print')).toBe(true);
    expect(sent.style.display).toBe('block');
    // The frame travels with it -- the reason for sending the container.
    expect(sent.getAttribute('style')).toContain('border-top');

    // The live container is left exactly as it was.
    expect(el.classList.contains('active-print')).toBe(false);
    expect(el.style.display).toBe('none');
  });

  test('a wide document goes with its density tier', () => {
    const cells = Array.from({ length: 15 }, (_, i) => `<td>${i}</td>`).join('');
    document.getElementById('print-low-stock-body').innerHTML = `<tr>${cells}</tr>`;
    const html = MApp.Print.pdfDocumentHtml(document.getElementById('print-low-stock-container'));
    const sent = new DOMParser().parseFromString(html, 'text/html').getElementById('print-low-stock-container');
    expect(sent.classList.contains('print-fit-dense')).toBe(true);
  });

  test('the stylesheet\'s print block is read from the live sheet, and nothing else of it', () => {
    const real = Object.getOwnPropertyDescriptor(Document.prototype, 'styleSheets');
    const app = {
      href: 'http://erp/static/erp/mobile_styles.css?v=erp-mobile-shell-v99',
      ownerNode: { tagName: 'LINK', parentElement: document.head },
      cssRules: [
        { cssText: '.mb-card { color: red; }' },
        { media: { mediaText: 'print' }, cssText: '@media print { th { text-transform: uppercase; } }' },
        { media: { mediaText: '(min-width: 640px)' }, cssText: '@media (min-width: 640px) { body { display: flex; } }' }
      ]
    };
    const other = { href: 'http://erp/static/erp/vendor/google-fonts.css', ownerNode: { tagName: 'LINK' }, cssRules: [{ cssText: '@font-face{}' }] };
    Object.defineProperty(document, 'styleSheets', { configurable: true, get: () => [other, app] });
    try {
      const css = MApp.Print.printCss();
      expect(css).toContain('text-transform: uppercase');
      expect(css).not.toContain('.mb-card');
      expect(css).not.toContain('display: flex');
      expect(css).not.toContain('@font-face');
    } finally {
      delete document.styleSheets;
      if (real) Object.defineProperty(Document.prototype, 'styleSheets', real);
    }
  });

  test('Download and Share send that document', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(['%PDF']) }));
    await MApp.Print._pdfFor('print-po-container', 'PO.pdf', false);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.html.startsWith('<style>')).toBe(true);
    expect(body.html).toContain('id="print-po-container"');
  });
});

describe('the bulk container\'s cell switch', () => {
  test('is set for the job that asks for it and cleared for the next', async () => {
    document.body.innerHTML = PARTIAL;
    jest.spyOn(MApp.Print, 'chooseAction').mockImplementation(async ({ populate }) => populate());
    const container = document.getElementById('print-bulk-container');

    await MApp.Print.bulk([1], () => '<table><tr><td>x</td></tr></table>', { cellsOwn: true });
    expect(container.classList.contains('print-cells-own')).toBe(true);

    await MApp.Print.bulk([1], () => '<p>next</p>');
    expect(container.classList.contains('print-cells-own')).toBe(false);
  });
});
