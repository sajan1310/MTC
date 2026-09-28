/**
 * Issued Stock on desktop -- Download PDF and Share, for one receipt and for
 * a selection.
 *
 * A receipt could be printed from its row, and a selection printed or saved
 * as PDFs, but a single receipt could not be saved from its row, and nothing
 * on desktop could be shared: App.Print had no share path at all. Share hands
 * the files Download saves to the operating system's share sheet -- one per
 * receipt, under the name Download gives it.
 *
 * Mounted from the real production.html partial, with api.js, core.js,
 * print.js and issue.js loaded the way bill_edit_remarks.test.js loads its
 * modules.
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

function loadDesktop() {
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
  eval([
    read('core.js').replace(/^const App = /m, 'global.App = '),
    'global.$ = $;',
    'global.$$ = $$;',
    'global.safeModalShow = safeModalShow;',
    'global.safeModalHide = safeModalHide;'
  ].join('\n'));
  // eslint-disable-next-line no-eval
  eval(read('print.js'));
  // eslint-disable-next-line no-eval
  eval(read('issue.js'));
}

const ISSUES = [
  { issueId: 'ISS-20260928-101530', date: '28/09/2026', dateRaw: '2026-09-28', issuedTo: 'Ramesh Kumar',
    reference: 'LOT-PNT-0041', remarks: '', totalQty: 12, totalValue: 0,
    items: [{ name: 'Primer', size: '5 L', qty: 12, unit: 'Ltr', rate: 0 }] },
  { issueId: 'ISS-20260928-111204', date: '28/09/2026', dateRaw: '2026-09-28', issuedTo: 'Painting Dept',
    reference: '', remarks: 'rework', totalQty: 30, totalValue: 0,
    items: [{ name: 'Poly Bag', size: 'GENERAL', qty: 30, unit: 'Pcs', rate: 0 }] }
];
const NAMES = ['ISS_20260928-101530_RameshKumar.pdf', 'ISS_20260928-111204_PaintingDept.pdf'];

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
let toasts;

// Both endpoints, as the server answers them: one PDF for /erp/render-pdf,
// and for the batch a ZIP holding one PDF per document, under the filename
// each was sent with.
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

function canShare(yes) {
  navigator.canShare = jest.fn(() => yes);
  navigator.share = jest.fn(async () => {});
}

beforeEach(() => {
  jest.resetModules();
  document.body.innerHTML = PARTIAL('production.html');
  loadDesktop();
  App.State.globalIssues = ISSUES.map(i => ({ ...i }));
  App.State.filteredIssues = [...App.State.globalIssues];
  App.State.issueCurrentPage = 1;
  App.State.issueRowsPerPage = 15;
  App.State.selectedIssues = [];
  serve();
  saved = [];
  App.Print.saveBlob = (blob, name) => saved.push(name);
  toasts = [];
  App.Utils.showToast = (msg, isError) => toasts.push({ msg, isError: !!isError });
  canShare(true);
});

afterEach(() => {
  delete navigator.canShare;
  delete navigator.share;
  delete window.isSecureContext;
});

const selectBoth = () => {
  App.State.selectedIssues = ISSUES.map(i => i.issueId);
};

describe('names', () => {
  test('a receipt is named for its number and who it was issued to', () => {
    expect(App.Issue.docName(ISSUES[0])).toBe('ISS_20260928-101530_RameshKumar');
    expect(App.Issue.docName(ISSUES[1])).toBe('ISS_20260928-111204_PaintingDept');
  });

  test('Download PDFs saves each receipt under that name', async () => {
    selectBoth();
    await App.Issue.bulkDownloadPDF();
    expect(requests[0].body.documents.map(d => d.filename)).toEqual(NAMES);
    expect(saved).toEqual(NAMES);
  });
});

describe('a row', () => {
  const rowButtons = key => {
    App.Issue.renderTable();
    const row = [...document.querySelectorAll('#issueTableBody tr')]
      .find(tr => tr.textContent.includes(key));
    return [...row.querySelectorAll('button')];
  };

  test('offers Download PDF and Share beside Print', () => {
    expect(rowButtons('ISS-20260928-101530').map(b => b.textContent.trim()))
      .toEqual(['Edit', 'Print', 'Download PDF', 'Share', 'Delete']);
  });

  test('Download PDF saves that receipt, and its button says so while it renders', async () => {
    const button = rowButtons('ISS-20260928-111204').find(b => b.textContent.trim() === 'Download PDF');
    const pending = App.Issue.downloadPDF('ISS-20260928-111204', button);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('Preparing');
    await pending;

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('/erp/render-pdf');
    expect(requests[0].body.html).toContain('ISS-20260928-111204');
    expect(requests[0].body.html).toContain('Stock Issue Receipt');
    expect(saved).toEqual([NAMES[1]]);
    expect(button.disabled).toBe(false);
    expect(button.textContent.trim()).toBe('Download PDF');
  });

  test('Share hands that receipt to the share sheet as one named PDF', async () => {
    await App.Issue.share('ISS-20260928-101530');

    expect(navigator.share).toHaveBeenCalledTimes(1);
    const { files } = navigator.share.mock.calls[0][0];
    expect(files.map(f => [f.name, f.type])).toEqual([[NAMES[0], 'application/pdf']]);
    expect(requests[0].body.html).toContain('ISS-20260928-101530');
    expect(saved).toEqual([]);
  });

  test('Share over http says why it cannot, and renders nothing', async () => {
    delete navigator.canShare;
    delete navigator.share;
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });

    await App.Issue.share('ISS-20260928-101530');

    expect(requests).toHaveLength(0);
    expect(toasts).toHaveLength(1);
    expect(toasts[0].isError).toBe(true);
    expect(toasts[0].msg).toMatch(/https/);
  });

  test('Share in a browser that cannot share files says so', async () => {
    canShare(false);
    await App.Issue.share('ISS-20260928-101530');
    expect(requests).toHaveLength(0);
    expect(toasts[0].msg).toMatch(/cannot share files/);
  });
});

describe('Share Selected', () => {
  test('appears with the selection, beside Download PDFs', () => {
    selectBoth();
    App.Issue.updateBulkButtons();
    const btn = document.getElementById('btnBulkShareIssue');
    expect(btn.classList.contains('d-none')).toBe(false);
    expect(btn.textContent).toContain('Share Selected (2)');

    App.State.selectedIssues = [];
    App.Issue.updateBulkButtons();
    expect(btn.classList.contains('d-none')).toBe(true);
  });

  test('renders once and shares one PDF per receipt, the files Download PDFs saves', async () => {
    selectBoth();
    await App.Issue.bulkShare();

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('/erp/render-pdf-batch');
    expect(requests[0].body.zipName).toBe(App.Print.bulkZipName('ISS'));
    const docs = requests[0].body.documents;
    expect(docs[0].html).toContain('ISS-20260928-101530');
    expect(docs[0].html).not.toContain('ISS-20260928-111204');

    expect(navigator.share).toHaveBeenCalledTimes(1);
    const { files, title } = navigator.share.mock.calls[0][0];
    expect(files.map(f => f.name)).toEqual(NAMES);
    expect(files.every(f => f.type === 'application/pdf')).toBe(true);
    expect(title).toMatch(/^ISS_\d{6}$/);
    expect(saved).toEqual([]);
  });

  test('with nothing selected, says so and renders nothing', async () => {
    await App.Issue.bulkShare();
    expect(requests).toHaveLength(0);
    expect(toasts[0].msg).toMatch(/No issues selected/);
  });
});

describe('the share sheet', () => {
  const many = n => Array.from({ length: n }, (_, i) => ({
    filename: `ISS_${1000 + i}.pdf`, html: `<p>${1000 + i}</p>`
  }));

  test('goes ten files at a time, each ten after the first on a click of its own', async () => {
    const ask = jest.spyOn(App.Print, '_askToShare').mockResolvedValue(true);
    await App.Print.shareMany(many(23), 'ISS_260928.zip');

    expect(navigator.share.mock.calls.map(c => c[0].files.length)).toEqual([10, 10, 3]);
    expect(ask.mock.calls.map(c => c[0])).toEqual([
      'Share 10 PDFs (11–20 of 23)',
      'Share 3 PDFs (21–23 of 23)'
    ]);
  });

  test('stops when the next batch is declined', async () => {
    jest.spyOn(App.Print, '_askToShare').mockResolvedValue(false);
    const ok = await App.Print.shareMany(many(12), 'ISS_260928.zip');
    expect(ok).toBe(false);
    expect(navigator.share).toHaveBeenCalledTimes(1);
  });

  test('a render that outlived its click asks for another, then shares', async () => {
    const lapsed = Object.assign(new Error('no activation'), { name: 'NotAllowedError' });
    navigator.share = jest.fn()
      .mockRejectedValueOnce(lapsed)
      .mockResolvedValueOnce(undefined);
    const ask = jest.spyOn(App.Print, '_askToShare').mockResolvedValue(true);

    await App.Issue.share('ISS-20260928-101530');

    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]).toEqual(['Share PDF', [NAMES[0]]]);
    expect(navigator.share).toHaveBeenCalledTimes(2);
    expect(toasts).toEqual([]);
  });

  test('closing the share sheet is not reported as a failure', async () => {
    navigator.share = jest.fn(async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); });
    await App.Issue.share('ISS-20260928-101530');
    expect(toasts).toEqual([]);
  });

  test('a server that cannot render says so, and shares nothing', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 503 }));
    selectBoth();
    await App.Issue.bulkShare();
    expect(navigator.share).not.toHaveBeenCalled();
    expect(toasts[0].msg).toMatch(/no PDF renderer/);
  });
});

describe('the Ready to share dialog', () => {
  // index.html's own markup for it; the Jinja around it parses as text.
  const MODAL = new DOMParser()
    .parseFromString(fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'index.html'), 'utf8'), 'text/html')
    .getElementById('shareReadyModal').outerHTML;

  // Bootstrap's Modal, as far as the dialog uses it.
  function fakeBootstrap() {
    const instances = new Map();
    const make = el => ({
      show() { el.style.display = 'block'; el.classList.add('show'); },
      hide() {
        el.classList.remove('show');
        el.style.display = 'none';
        el.dispatchEvent(new Event('hidden.bs.modal'));
      }
    });
    global.bootstrap = {
      Modal: {
        getInstance: el => instances.get(el) || null,
        getOrCreateInstance: el => {
          if (!instances.has(el)) instances.set(el, make(el));
          return instances.get(el);
        }
      }
    };
  }

  const modal = () => document.getElementById('shareReadyModal');

  beforeEach(() => {
    document.body.insertAdjacentHTML('beforeend', MODAL);
    fakeBootstrap();
  });

  afterEach(() => {
    delete global.bootstrap;
  });

  test('names the files, and its Share button answers yes', async () => {
    const answer = App.Print._askToShare('Share 2 PDFs', NAMES);
    await Promise.resolve();

    expect(modal().style.display).toBe('block');
    expect([...modal().querySelectorAll('#shareReadyFiles li')].map(li => li.textContent)).toEqual(NAMES);
    const btn = document.getElementById('shareReadyBtn');
    expect(btn.textContent.trim()).toBe('Share 2 PDFs');

    btn.click();
    await expect(answer).resolves.toBe(true);
    expect(modal().style.display).toBe('none');
  });

  test('closing it answers no', async () => {
    const answer = App.Print._askToShare('Share PDF', [NAMES[0]]);
    await Promise.resolve();
    bootstrap.Modal.getInstance(modal()).hide();
    await expect(answer).resolves.toBe(false);
  });

  test('waits for the previous one to finish closing before opening', async () => {
    // Bootstrap ignores show() mid-fade; opening then would lose the dialog.
    modal().style.display = 'block';
    const answer = App.Print._askToShare('Share 3 PDFs (21–23 of 23)', ['a.pdf']);
    await Promise.resolve();
    expect(bootstrap.Modal.getInstance(modal())).toBeNull();

    modal().style.display = 'none';
    modal().dispatchEvent(new Event('hidden.bs.modal'));
    await Promise.resolve();
    await Promise.resolve();
    expect(modal().style.display).toBe('block');

    document.getElementById('shareReadyBtn').click();
    await expect(answer).resolves.toBe(true);
  });
});
