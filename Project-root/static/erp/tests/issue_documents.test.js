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

  // serve() above is a server from before the joined PDF; this one is
  // render_batch as it is now -- with combineAs, every document joined into
  // one PDF, as one entry more, last.
  describe('past ten, from a server that joins them', () => {
    beforeEach(() => {
      requests = [];
      global.fetch = jest.fn(async (url, init) => {
        const body = JSON.parse(init.body);
        requests.push({ url, body });
        const entries = body.documents.map(d => [d.filename, `%PDF-${d.filename}`]);
        if (body.combineAs) entries.push([body.combineAs, '%PDF-joined']);
        return { ok: true, status: 200, blob: async () => storeZip(entries) };
      });
    });

    test('asks for the joined PDF in the same render, and offers it beside ten at a time', async () => {
      const choose = jest.spyOn(App.Print, '_askShare').mockResolvedValue('one');
      await App.Print.shareMany(many(23), 'ISS_260928.zip');

      expect(requests).toHaveLength(1);
      expect(requests[0].body.combineAs).toBe('ISS_260928_All_23.pdf');
      const asked = choose.mock.calls[0][0];
      expect(asked.title).toBe('23 PDFs ready');
      expect(asked.note).toMatch(/at most\. Send all 23 as one PDF, or as separate files in 3 shares/);
      expect(asked.choices.map(c => [c.value, c.label]))
        .toEqual([['one', 'Share as one PDF'], ['tens', 'Share 10 at a time']]);
      expect(asked.names).toHaveLength(23);
    });

    test('one PDF is shared on the choice\'s own click, with no "Ready to share" after it', async () => {
      jest.spyOn(App.Print, '_askShare').mockResolvedValue('one');
      const ready = jest.spyOn(App.Print, '_askToShare');
      const ok = await App.Print.shareMany(many(23), 'ISS_260928.zip');

      expect(ok).toBe(true);
      expect(navigator.share).toHaveBeenCalledTimes(1);
      const { files } = navigator.share.mock.calls[0][0];
      expect(files.map(f => [f.name, f.type])).toEqual([['ISS_260928_All_23.pdf', 'application/pdf']]);
      expect(ready).not.toHaveBeenCalled();
    });

    test('ten at a time: the first ten on the choice\'s click, a click for each ten after', async () => {
      jest.spyOn(App.Print, '_askShare').mockResolvedValue('tens');
      const ready = jest.spyOn(App.Print, '_askToShare').mockResolvedValue(true);
      await App.Print.shareMany(many(23), 'ISS_260928.zip');

      expect(navigator.share.mock.calls.map(c => c[0].files.length)).toEqual([10, 10, 3]);
      expect(ready).toHaveBeenCalledTimes(2);
      const shared = navigator.share.mock.calls.flatMap(c => c[0].files.map(f => f.name));
      expect(shared).toHaveLength(23);
      expect(shared).not.toContain('ISS_260928_All_23.pdf');
    });

    test('closing the choice shares nothing', async () => {
      jest.spyOn(App.Print, '_askShare').mockResolvedValue(null);
      const ok = await App.Print.shareMany(many(12), 'ISS_260928.zip');
      expect(ok).toBe(false);
      expect(navigator.share).not.toHaveBeenCalled();
    });

    test('ten or fewer ask for no joined file and offer no choice', async () => {
      const choose = jest.spyOn(App.Print, '_askShare');
      await App.Print.shareMany(many(10), 'ISS_260928.zip');
      expect(requests[0].body).not.toHaveProperty('combineAs');
      expect(choose).not.toHaveBeenCalled();
      expect(navigator.share.mock.calls.map(c => c[0].files.length)).toEqual([10]);
    });
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

// A share sheet opens only within ~5 s of a click; a stack takes the server
// longer, so the first Share asks for a second click. The second Share of
// the same stack must not have to.
describe('a file this tab was already sent', () => {
  test('Share Selected again renders nothing new', async () => {
    selectBoth();
    await App.Issue.bulkShare();
    await App.Issue.bulkShare();
    expect(requests).toHaveLength(1);
    expect(navigator.share).toHaveBeenCalledTimes(2);
    expect(navigator.share.mock.calls[1][0].files.map(f => f.name)).toEqual(NAMES);
  });

  test('a receipt changed since is rendered fresh', async () => {
    selectBoth();
    await App.Issue.bulkShare();
    App.State.globalIssues[0].remarks = 'returned two';
    await App.Issue.bulkShare();
    expect(requests).toHaveLength(2);
  });

  test('a failed render is not kept: the next press asks the server again', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 500 }));
    selectBoth();
    await App.Issue.bulkShare();
    serve();
    await App.Issue.bulkShare();
    expect(requests).toHaveLength(1);
    expect(navigator.share).toHaveBeenCalledTimes(1);
  });

  test('only the last few are kept', async () => {
    for (let i = 0; i < App.Print.RENDER_CACHE_MAX_ENTRIES + 3; i++) {
      await App.Print._postForBlob('/erp/render-pdf', { html: `<p>${i}</p>`, filename: `D${i}.pdf` });
    }
    expect(App.Print._renderCache.size).toBe(App.Print.RENDER_CACHE_MAX_ENTRIES);
    // The newest is still here; the oldest made room.
    await App.Print._postForBlob('/erp/render-pdf', { html: '<p>0</p>', filename: 'D0.pdf' });
    expect(requests).toHaveLength(App.Print.RENDER_CACHE_MAX_ENTRIES + 4);
    const newest = App.Print.RENDER_CACHE_MAX_ENTRIES + 2;
    await App.Print._postForBlob('/erp/render-pdf', { html: `<p>${newest}</p>`, filename: `D${newest}.pdf` });
    expect(requests).toHaveLength(App.Print.RENDER_CACHE_MAX_ENTRIES + 4);
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

  describe('with a choice to make', () => {
    const ask = () => App.Print._askShare({
      title: '23 PDFs ready',
      note: 'A share can carry 10 files at most.',
      names: ['a.pdf', 'b.pdf'],
      choices: [
        { value: 'one', label: 'Share as one PDF', icon: 'bi-file-earmark-pdf' },
        { value: 'tens', label: 'Share 10 at a time', icon: 'bi-files' }
      ]
    });
    const alt = () => document.getElementById('shareReadyAltBtn');

    test('shows both, the one PDF on the dark button, and says why', async () => {
      const answer = ask();
      await Promise.resolve();

      expect(document.getElementById('shareReadyTitle').textContent).toBe('23 PDFs ready');
      const note = document.getElementById('shareReadyNote');
      expect(note.textContent).toBe('A share can carry 10 files at most.');
      expect(note.classList.contains('d-none')).toBe(false);
      expect(document.getElementById('shareReadyBtn').textContent.trim()).toBe('Share as one PDF');
      expect(document.getElementById('shareReadyBtn').classList.contains('btn-dark')).toBe(true);
      expect(alt().classList.contains('d-none')).toBe(false);
      expect(alt().textContent.trim()).toBe('Share 10 at a time');

      alt().click();
      await expect(answer).resolves.toBe('tens');
    });

    test('the dark button answers one PDF; closing answers nothing', async () => {
      let answer = ask();
      await Promise.resolve();
      document.getElementById('shareReadyBtn').click();
      await expect(answer).resolves.toBe('one');

      answer = ask();
      await Promise.resolve();
      bootstrap.Modal.getInstance(modal()).hide();
      await expect(answer).resolves.toBeNull();
    });

    test('the plain Ready to share after it is back to one button, its title and no note', async () => {
      const first = ask();
      await Promise.resolve();
      alt().click();
      await first;

      const answer = App.Print._askToShare('Share 10 PDFs (11–20 of 23)', ['c.pdf']);
      await Promise.resolve();
      expect(document.getElementById('shareReadyTitle').textContent).toBe('Ready to share');
      expect(document.getElementById('shareReadyNote').classList.contains('d-none')).toBe(true);
      expect(alt().classList.contains('d-none')).toBe(true);
      // The hidden button's old press must not answer for this dialog.
      alt().click();
      document.getElementById('shareReadyBtn').click();
      await expect(answer).resolves.toBe(true);
    });
  });
});
