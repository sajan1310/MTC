'use strict';
// Covers App.Print -- now the app's only export path.
//
// print.js is the most widely shared frontend module (every ledger, every
// document, both shells), and docs/audit/PDF_GENERATION_REVIEW.md PDF-006
// singles it out for having had no tests. It used to carry a raster
// exporter, a server-render client, a ZIP writer and a DOM borrow/restore
// dance, each with its own test file. Those are gone: there is one renderer
// now, the browser's, and what has to keep working is smaller but far more
// load-bearing.
//
// The four behaviours below are the ones that break silently:
//   - hideAll selecting on .print-container, not an id prefix. The prefix
//     match also caught #print-grand-total-container, a block NESTED inside
//     the PO template, so it hid the PO's own grand total.
//   - cleanup restoring document.title and clearing .active-print. A missed
//     restore leaves the wrong template armed for the NEXT print job.
//   - the landscape @page override being removed afterwards, or every
//     subsequent document prints sideways.
//   - triggerBulk putting a page break between records but not after the
//     last one, which would emit a trailing blank page on every bulk print.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
// jsdom does not expose these globally in this jest version, and both the
// ZIP builder below and print.js's unzip() need them.
const { TextEncoder, TextDecoder } = require('node:util');
// jsdom's Blob has no arrayBuffer()/text(); node's does, and unzip() reads
// the bytes through arrayBuffer().
const { Blob } = require('node:buffer');

// Runs the real print.js against the real jsdom document, so getElementById,
// classList and the <style> injection are exercised rather than mocked.
function loadPrintModule() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'print.js'), 'utf8');
  const toasts = [];
  const printCalls = [];
  const sandbox = {
    App: {
      Utils: { showToast: (msg, isError) => toasts.push({ msg, isError }) },
      companyLogo: null,
    },
    document,
    window: Object.assign(global.window, {
      print: () => printCalls.push(document.title),
    }),
    console,
    // trigger() arms a setTimeout as the fallback for browsers that never
    // fire 'afterprint'. The real timer is fine here: 1000ms cannot elapse
    // inside a synchronous assertion, so the tests observe the pre-cleanup
    // state and drive cleanup themselves by dispatching 'afterprint'.
    setTimeout,
    clearTimeout,
    // Delegated rather than captured, so a test can swap global.fetch after
    // the module is loaded. Without fetch in the sandbox at all, the call
    // inside _postForBlob throws ReferenceError -- which its try/catch
    // swallows as "offline", and every download test silently exercises the
    // fallback instead of the path it names.
    fetch: (...args) => global.fetch(...args),
    URL: global.URL,
    Blob,
    TextDecoder,
    TextEncoder,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { Print: sandbox.App.Print, App: sandbox.App, toasts, printCalls };
}

// The 11 real containers plus the nested block that the old id-prefix
// selector wrongly swept up with them.
function buildPrintDom() {
  document.head.innerHTML = '';
  document.body.innerHTML = `
    <div id="print-po-container" class="print-container print-cells-own">
      <div id="print-grand-total-container">Grand total</div>
    </div>
    <div id="print-bill-container" class="print-container"></div>
    <div id="print-bulk-container" class="print-container">
      <div id="print-bulk-body"></div>
    </div>
    <div id="not-a-print-container"></div>`;
}

let Print;
let printCalls;

beforeEach(() => {
  buildPrintDom();
  document.title = 'MTC ERP';
  ({ Print, printCalls } = loadPrintModule());
});

describe('container selection', () => {
  it('finds every .print-container and nothing else', () => {
    const ids = Print.containers().map(el => el.id).sort();
    expect(ids).toEqual([
      'print-bill-container',
      'print-bulk-container',
      'print-po-container',
    ]);
  });

  // The regression this selector change exists for.
  it('leaves #print-grand-total-container alone -- it is nested inside the PO', () => {
    Print.hideAll();
    const nested = document.getElementById('print-grand-total-container');
    expect(nested.style.display).toBe('');
    expect(Print.containers().map(el => el.id)).not.toContain('print-grand-total-container');
  });

  it('hideAll clears .active-print and hides all containers', () => {
    const bill = document.getElementById('print-bill-container');
    bill.classList.add('active-print');
    bill.style.display = 'block';

    Print.hideAll();

    expect(bill.classList.contains('active-print')).toBe(false);
    expect(bill.style.display).toBe('none');
  });
});

// The failure this guards against was seen in the browser: the print
// container rendered on screen, above the app, and never went away. Flask
// caches Jinja templates while /static is read from disk per request, so a
// server that has not been restarted serves markup WITHOUT
// class="print-container" to a print.js that selects on it -- hideAll()
// matches nothing and the reveal is never undone.
describe('stale markup that does not carry .print-container', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = `
      <div id="print-po-container">
        <div id="print-grand-total-container">Grand total</div>
      </div>
      <div id="print-bulk-container"><div id="print-bulk-body"></div></div>`;
    // Clearing <head> above removes the <title> element, so re-set it here
    // rather than relying on the outer beforeEach having run first.
    document.title = 'MTC ERP';
    ({ Print, printCalls } = loadPrintModule());
  });

  it('still hides the container it revealed', () => {
    const po = document.getElementById('print-po-container');

    Print.trigger('print-po-container', 'PO_1204_Mahadev');
    expect(po.style.display).toBe('block');

    window.dispatchEvent(new window.Event('afterprint'));

    expect(po.style.display).toBe('none');
    expect(po.classList.contains('active-print')).toBe(false);
  });

  it('still restores the document title', () => {
    Print.trigger('print-po-container', 'PO_1204_Mahadev');
    window.dispatchEvent(new window.Event('afterprint'));
    expect(document.title).toBe('MTC ERP');
  });

  // The 'afterprint' event does not fire in every browser and sandbox, which
  // is why trigger() also arms a timer. Both routes must undo the reveal.
  it('still hides it when afterprint never fires', () => {
    jest.useFakeTimers();
    ({ Print } = loadPrintModule());
    const po = document.getElementById('print-po-container');

    Print.trigger('print-po-container', 'PO_1204_Mahadev');
    jest.advanceTimersByTime(1000);

    expect(po.style.display).toBe('none');
    jest.useRealTimers();
  });

  // A container left armed by an earlier job is cleared even though it does
  // not carry the class, because .active-print is set by this module itself.
  it('sweeps anything still marked .active-print', () => {
    const stale = document.getElementById('print-po-container');
    stale.classList.add('active-print');
    stale.style.display = 'block';

    Print.hideAll();

    expect(stale.classList.contains('active-print')).toBe(false);
    expect(stale.style.display).toBe('none');
  });
});

describe('trigger', () => {
  it('arms exactly one container and prints', () => {
    Print.trigger('print-bill-container', 'Goods_Receipt_GR-1041');

    expect(printCalls).toHaveLength(1);
    // document.title is the suggested "Save as PDF" filename, so it must be
    // set at the moment print() is called, not merely at some point.
    expect(printCalls[0]).toBe('Goods_Receipt_GR-1041');
  });

  it('restores the title and disarms the container afterwards', () => {
    const bill = document.getElementById('print-bill-container');
    Print.trigger('print-bill-container', 'Goods_Receipt_GR-1041');
    window.dispatchEvent(new window.Event('afterprint'));

    expect(document.title).toBe('MTC ERP');
    expect(bill.classList.contains('active-print')).toBe(false);
  });

  it('disarms a previously armed container before arming the next', () => {
    const po = document.getElementById('print-po-container');
    po.classList.add('active-print');

    Print.trigger('print-bill-container', 'Bill');

    expect(po.classList.contains('active-print')).toBe(false);
    expect(document.getElementById('print-bill-container').classList.contains('active-print')).toBe(true);
  });

  it('still prints, and warns, when the container id does not exist', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    Print.trigger('print-nonexistent-container', 'Whatever');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('page orientation', () => {
  const rule = () => document.getElementById(Print.ORIENTATION_STYLE_ID);

  it('adds no @page override for a portrait job', () => {
    Print.trigger('print-bill-container', 'Bill');
    expect(rule()).toBeNull();
  });

  it('appends a landscape @page rule for a landscape job', () => {
    Print.trigger('print-bill-container', 'Sheet', { landscape: true });
    expect(rule()).not.toBeNull();
    expect(rule().textContent).toContain('a4 landscape');
    // Must carry the same margin as the base rule, or the landscape page
    // gets the browser default and the layout shifts.
    expect(rule().textContent).toContain(`${Print.PAGE_MARGIN_MM}mm`);
  });

  // The one that silently ruins every later document.
  it('removes the landscape rule once the job is done', () => {
    Print.trigger('print-bill-container', 'Sheet', { landscape: true });
    window.dispatchEvent(new window.Event('afterprint'));
    expect(rule()).toBeNull();
  });

  it('does not leave two rules behind across successive landscape jobs', () => {
    Print.trigger('print-bill-container', 'A', { landscape: true });
    Print.trigger('print-bill-container', 'B', { landscape: true });
    expect(document.querySelectorAll(`#${Print.ORIENTATION_STYLE_ID}`)).toHaveLength(1);
  });
});

describe('titleToFilename', () => {
  it('replaces characters Windows and macOS refuse in a filename', () => {
    expect(Print.titleToFilename('PO/2026:0417')).toBe('PO-2026-0417');
    expect(Print.titleToFilename('Ledger <Q1> "final"')).toBe('Ledger -Q1- -final-');
  });

  it('keeps spaces and dashes, which are legal and more readable', () => {
    expect(Print.titleToFilename('Dispatch Plan - 2026-08-19')).toBe('Dispatch Plan - 2026-08-19');
  });

  it('never yields an empty title, which would leave the save dialog blank', () => {
    for (const input of ['', '   ', null, undefined]) {
      expect(Print.titleToFilename(input)).toBe('Document');
    }
  });
});

describe('sanitizeFilename', () => {
  it('strips characters that are illegal or non-portable in filenames', () => {
    expect(Print.sanitizeFilename('Gupta Cycle & Co.')).toBe('Gupta_Cycle_Co');
    expect(Print.sanitizeFilename('PO/2026\\0417')).toBe('PO20260417');
  });

  it('collapses whitespace to underscores', () => {
    expect(Print.sanitizeFilename('Shri   Balaji   Cycle')).toBe('Shri_Balaji_Cycle');
  });

  it('drops spaces entirely when allowSpaces is false', () => {
    expect(Print.sanitizeFilename('Gupta Cycle Industries', false)).toBe('GuptaCycleIndustries');
  });

  it('caps the result at 50 characters', () => {
    const long = 'Shri Balaji Cycle and Rickshaw Parts Manufacturing Company Private Limited';
    expect(Print.sanitizeFilename(long, false)).toHaveLength(50);
  });

  // The character class strips everything outside [a-zA-Z0-9_-], so a vendor
  // or item named wholly in Gurmukhi/Devanagari -- ordinary here -- would
  // otherwise yield "Item_Ledger_".
  it('falls back to Document when every character is stripped', () => {
    expect(Print.sanitizeFilename('ਗੁਪਤਾ ਸਾਈਕਲ ਇੰਡਸਟਰੀਜ਼', false)).toBe('Document');
    expect(Print.sanitizeFilename('गुप्ता साइकिल', false)).toBe('Document');
    expect(Print.sanitizeFilename('!!!')).toBe('Document');
  });
});

describe('triggerBulk', () => {
  const records = [{ n: 1 }, { n: 2 }, { n: 3 }];
  const build = r => `<p>Record ${r.n}</p>`;

  it('renders one page per record into the shared bulk container', () => {
    Print.triggerBulk(records, build, 'Purchase_Orders_Selected');

    const pages = document.querySelectorAll('#print-bulk-body .bulk-print-page');
    expect(pages).toHaveLength(3);
    expect(pages[0].innerHTML).toContain('Record 1');
    expect(pages[2].innerHTML).toContain('Record 3');
  });

  // A break after the last record emits a trailing blank page, on every
  // bulk print, in every module.
  it('breaks between records but not after the last one', () => {
    Print.renderBulkPages(records, build);
    const pages = [...document.querySelectorAll('#print-bulk-body .bulk-print-page')];

    expect(pages[0].getAttribute('style')).toContain('break-after:page');
    expect(pages[1].getAttribute('style')).toContain('break-after:page');
    expect(pages[2].getAttribute('style')).toBe('');
  });

  it('arms the bulk container and prints once for the whole batch', () => {
    Print.triggerBulk(records, build, 'Purchase_Orders_Selected');

    expect(document.getElementById('print-bulk-container').classList.contains('active-print')).toBe(true);
    expect(printCalls).toEqual(['Purchase_Orders_Selected']);
  });

  it('forwards orientation to the underlying print job', () => {
    Print.triggerBulk(records, build, 'Sheets', { landscape: true });
    expect(document.getElementById(Print.ORIENTATION_STYLE_ID).textContent).toContain('a4 landscape');
  });

  it('replaces the previous batch rather than appending to it', () => {
    Print.renderBulkPages(records, build);
    Print.renderBulkPages([{ n: 9 }], build);

    const pages = document.querySelectorAll('#print-bulk-body .bulk-print-page');
    expect(pages).toHaveLength(1);
    expect(pages[0].innerHTML).toContain('Record 9');
  });
});

// ── Downloading a file, rather than opening a dialog ─────────────────
//
// window.print() cannot hand back a file, so these paths POST the same
// builder HTML to a renderer that returns bytes. What has to hold:
//   - a 503 (this deployment cannot render) latches OFF for the session, so a
//     40-record export does not make 40 pointless round trips;
//   - a per-document 5xx does NOT latch, because the next one may be fine;
//   - every failure still produces the document, via the print dialog.

// Builds a real store-only ZIP, the same shape the server writes
// (zipfile.ZIP_STORED). Hand-built rather than stubbed because unzip() parses
// these bytes, and a stub would only prove the stub works.
function storeZip(entries) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const [name, body] of entries) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(body);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034B50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, 0, true);            // method 0 = stored
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014B50, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054B50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(16, offset, true);

  return new Blob([...parts, ...central, new Uint8Array(eocd.buffer)]);
}

describe('server-rendered downloads', () => {
  let saved;
  let fetchCalls;
  let App;

  function setupFetch(responder) {
    fetchCalls = [];
    global.fetch = jest.fn((url, init) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      return responder(url);
    });
  }

  const okBlob = () => Promise.resolve({
    ok: true, status: 200, blob: () => Promise.resolve(new Blob(['%PDF-'])),
  });

  // The batch endpoint returns an archive; downloadMany unpacks it and saves
  // each entry as its own file.
  const okZip = (entries = [['PO_1.pdf', '%PDF-one'], ['PO_2.pdf', '%PDF-two']]) =>
    () => Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve(storeZip(entries)) });

  beforeEach(() => {
    buildPrintDom();
    document.title = 'MTC ERP';
    ({ Print, printCalls, App } = loadPrintModule());

    saved = [];
    // jsdom implements neither of these.
    global.URL.createObjectURL = jest.fn(() => 'blob:fake');
    global.URL.revokeObjectURL = jest.fn();
    Print.saveBlob = (blob, filename) => saved.push(filename);
    window.localStorage.clear();
  });

  describe('downloadMany', () => {
    const docs = [
      { filename: 'PO_1.pdf', html: '<p>1</p>' },
      { filename: 'PO_2.pdf', html: '<p>2</p>' },
    ];

    // One request for the batch, N files out of it. "Download PDFs" means
    // separate files per record, not one archive the user has to unpack.
    it('renders in ONE request and saves a separate file per record', async () => {
      setupFetch(okZip());

      const ok = await Print.downloadMany(docs, 'PO_260820.zip');

      expect(ok).toBe(true);
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].url).toBe(Print.SERVER_PDF_BATCH_URL);
      expect(fetchCalls[0].body.documents).toHaveLength(2);
      expect(saved).toEqual(['PO_1.pdf', 'PO_2.pdf']);
    });

    it('saves every entry even for a large batch', async () => {
      const entries = Array.from({ length: 40 },
        (_, i) => [`PO_${i}.pdf`, `%PDF-${i}`]);
      setupFetch(okZip(entries));

      await Print.downloadMany(docs, 'PO_260820.zip');

      expect(saved).toHaveLength(40);
      expect(new Set(saved).size).toBe(40);
    });

    it('sends a CSRF token', async () => {
      document.head.innerHTML = '<meta name="csrf-token" content="tok123">';
      setupFetch(okZip());
      await Print.downloadMany(docs, 'x.zip');
      expect(global.fetch.mock.calls[0][1].headers['X-CSRFToken']).toBe('tok123');
    });

    // A Download button downloads or says why it could not. It must never
    // quietly turn into a print dialog -- that is a different task with a
    // different outcome, appearing without warning.
    it('reports an error rather than opening the print dialog', async () => {
      setupFetch(() => Promise.resolve({ ok: false, status: 503 }));
      const toasts = [];
      App.Utils = { showToast: (msg, isError) => toasts.push({ msg, isError }) };

      const ok = await Print.downloadMany(docs, 'x.zip');

      expect(ok).toBe(false);
      expect(saved).toEqual([]);
      expect(printCalls).toEqual([]);          // no print dialog
      expect(toasts[0].isError).toBe(true);
      expect(toasts[0].msg).toMatch(/no PDF renderer installed/i);
    });

    // "Could not reach the PDF renderer" covered four different situations and
    // sent a real diagnosis off hunting through virtualenvs. Each cause now
    // names itself and says what to do about it.
    it.each([
      [503, /no PDF renderer installed/i, 'renderer missing on the server'],
      [404, /older build|needs restarting/i, 'server not restarted'],
      [403, /session expired/i, 'stale session or CSRF token'],
      [500, /could not render/i, 'render failed'],
    ])('explains HTTP %i as %s', async (status, pattern) => {
      setupFetch(() => Promise.resolve({ ok: false, status }));
      const toasts = [];
      App.Utils = { showToast: msg => toasts.push(msg) };

      await Print.downloadMany(docs, 'x.zip');

      expect(toasts[0]).toMatch(pattern);
      expect(printCalls).toEqual([]);
    });

    it('distinguishes offline from a server that cannot render', async () => {
      setupFetch(() => Promise.reject(new TypeError('Failed to fetch')));
      const toasts = [];
      App.Utils = { showToast: msg => toasts.push(msg) };

      await Print.downloadMany(docs, 'x.zip');

      expect(toasts[0]).toMatch(/no connection/i);
    });

    it('does not print when offline either', async () => {
      setupFetch(() => Promise.reject(new TypeError('Failed to fetch')));
      App.Utils = { showToast: () => {} };

      await Print.downloadMany(docs, 'x.zip');

      expect(printCalls).toEqual([]);
      expect(saved).toEqual([]);
    });

    it('stops asking for the rest of the session after a 503', async () => {
      setupFetch(() => Promise.resolve({ ok: false, status: 503 }));
      await Print.downloadMany(docs, 'x.zip');
      await Print.downloadMany(docs, 'x.zip');

      expect(fetchCalls).toHaveLength(1);   // not 2
      expect(Print.serverPdfAvailable).toBe(false);
    });

    // A 500 is this request, not this deployment.
    it('does NOT latch off after a per-request 5xx', async () => {
      setupFetch(() => Promise.resolve({ ok: false, status: 500 }));
      await Print.downloadMany(docs, 'x.zip');
      await Print.downloadMany(docs, 'x.zip');

      expect(fetchCalls).toHaveLength(2);
      expect(Print.serverPdfAvailable).not.toBe(false);
    });

    it('does nothing at all for an empty selection', async () => {
      setupFetch(okZip());
      expect(await Print.downloadMany([], 'x.zip')).toBe(false);
      expect(fetchCalls).toHaveLength(0);
    });
  });

  describe('downloadOne', () => {
    it('adds a .pdf extension when the caller omits one', async () => {
      setupFetch(okBlob);
      await Print.downloadOne('<p>x</p>', 'PO_1204_Mahadev');
      expect(saved).toEqual(['PO_1204_Mahadev.pdf']);
      expect(fetchCalls[0].url).toBe(Print.SERVER_PDF_URL);
    });

    it('does not double the extension', async () => {
      setupFetch(okBlob);
      await Print.downloadOne('<p>x</p>', 'PO_1204.pdf');
      expect(saved).toEqual(['PO_1204.pdf']);
    });

    it('forwards the landscape flag', async () => {
      setupFetch(okBlob);
      await Print.downloadOne('<p>x</p>', 'Sheet', { landscape: true });
      expect(fetchCalls[0].body.landscape).toBe(true);
    });
  });

  describe('downloadContainer', () => {
    it('sends the markup currently inside the container', async () => {
      setupFetch(okBlob);
      document.getElementById('print-bill-container').innerHTML = '<p>GR-1041</p>';

      await Print.downloadContainer('print-bill-container', 'GR_1041');

      expect(fetchCalls[0].body.html).toContain('GR-1041');
    });

    it('returns false and warns for a missing container', async () => {
      setupFetch(okBlob);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      expect(await Print.downloadContainer('nope', 'x')).toBe(false);

      expect(warn).toHaveBeenCalled();
      expect(fetchCalls).toHaveLength(0);
      warn.mockRestore();
    });
  });

  describe('unzip', () => {
    it('reads every stored entry back out', async () => {
      const files = await Print.unzip(storeZip([['a.pdf', 'AAA'], ['b.pdf', 'BB']]));
      expect(files.map(f => f.name)).toEqual(['a.pdf', 'b.pdf']);
      expect(await files[0].blob.text()).toBe('AAA');
      expect(await files[1].blob.text()).toBe('BB');
    });

    it('returns nothing for bytes that are not a ZIP', async () => {
      expect(await Print.unzip(new Blob(['not a zip at all']))).toEqual([]);
    });
  });
});

// ── Naming ──────────────────────────────────────────────────────────
//
// One convention for every Print title and Download filename:
//     CODE_KEY_PARTY[_YYMMDD]
// Brief enough to read in a file-manager column, distinct enough that two
// documents never collide, and prefixed so "DC_" finds every challan.
describe('docName', () => {
  it('builds CODE_KEY_PARTY for a numbered document', () => {
    expect(Print.docName({ type: 'PO', key: 1204, party: 'Mahadev industries' }))
      .toBe('PO_1204_Mahadev');
  });

  it('adds .pdf only for the filename form', () => {
    const spec = { type: 'PO', key: 1204, party: 'Mahadev industries' };
    expect(Print.docName(spec)).toBe('PO_1204_Mahadev');
    expect(Print.docFilename(spec)).toBe('PO_1204_Mahadev.pdf');
  });

  // A document with its own number is already unique; stamping today's date
  // on it is noise, and it is the download date rather than the document's.
  it('omits the date unless asked', () => {
    expect(Print.docName({ type: 'PO', key: 1204 })).toBe('PO_1204');
  });

  it('appends YYMMDD for documents whose identity IS the date', () => {
    expect(Print.docName({ type: 'STK', date: true })).toMatch(/^STK_\d{6}$/);
  });

  it('accepts the dd/mm/yyyy the ledgers display', () => {
    expect(Print.docName({ type: 'WO', party: 'Ramesh', date: '19/08/2026' }))
      .toBe('WO_Ramesh_260819');
  });

  it('falls back to today rather than emitting a wrong date', () => {
    expect(Print.docName({ type: 'STK', date: 'not a date' })).toMatch(/^STK_\d{6}$/);
  });

  // "DC-1041" would otherwise become "DC_DC-1041".
  it('does not repeat a code the key already carries', () => {
    expect(Print.docName({ type: 'DC', key: 'DC-1041', party: 'Sharma' }))
      .toBe('DC_1041_Sharma');
  });

  it('keeps a long party name readable instead of truncating mid-word', () => {
    const out = Print.docName({
      type: 'PO', key: 1204,
      party: 'Shri Balaji Cycle and Rickshaw Parts Manufacturing Company Private Limited',
    });
    expect(out).toBe('PO_1204_ShriBalaji');
    expect(out.length).toBeLessThan(30);
  });

  it('joins a short first word with the second, but only if both fit whole', () => {
    expect(Print.docName({ type: 'GRN', key: 'B-1', party: 'Gupta Cycle & Co.' }))
      .toBe('GRN_B-1_GuptaCycle');
  });

  // The regression that matters for ledgers: vendors and items named wholly
  // in Gurmukhi or Devanagari are ordinary here, and they have no Latin
  // characters at all. Dropping the segment would give every one of them the
  // same filename.
  it('keeps non-Latin party names distinct from one another', () => {
    const a = Print.docName({ type: 'VLG', party: 'ਗੁਪਤਾ ਸਾਈਕਲ', date: true });
    const b = Print.docName({ type: 'VLG', party: 'ਮਹਾਦੇਵ ਇੰਡਸਟਰੀਜ਼', date: true });

    expect(a).not.toBe(b);
    expect(a).toMatch(/^VLG_x[0-9a-f]{4}_\d{6}$/);
  });

  it('is stable: the same name always yields the same file', () => {
    const spec = { type: 'VLG', party: 'ਗੁਪਤਾ ਸਾਈਕਲ' };
    expect(Print.docName(spec)).toBe(Print.docName(spec));
  });

  it('still produces a usable name when everything is missing', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(Print.docName({})).toBe('DOC');
    warn.mockRestore();
  });

  // Production sheets are named after what they make, in the operator's own
  // words, rather than by the CODE_KEY_PARTY scheme. A sheet is recognised by
  // its Output Item Name; abbreviating that into a code and a model fragment
  // would hide the one thing anybody searches for.
  describe('docNameFromLabel', () => {
    it('keeps the label whole and readable, as the operator typed it', () => {
      expect(Print.docNameFromLabel('20 inch Rider D/Gaddi Steel Rim S/Kid Type', '21/08/2026'))
        .toBe('20 inch Rider D-Gaddi Steel Rim S-Kid Type_210826');
    });

    it('stamps the date as DDMMYY, matching the on-screen order', () => {
      expect(Print.docNameFromLabel('Rim', '21/08/2026')).toBe('Rim_210826');
      expect(Print.docNameFromLabel('Rim', '01/09/2026')).toBe('Rim_010926');
    });

    it('replaces every character Windows refuses', () => {
      const out = Print.docNameFromLabel('A/B\C:D*E?F"G<H>I|J', '21/08/2026');
      expect(out).not.toMatch(/[/\:*?"<>|]/);
    });

    it('falls back rather than producing a bare date', () => {
      expect(Print.docNameFromLabel('', '21/08/2026', 'Production Sheet'))
        .toBe('Production Sheet_210826');
    });

    // Two lots of the same item on the same day genuinely collide here. The
    // server de-duplicates inside a batch, so N records still yield N files.
    it('collides for same item + same date, which the server then resolves', () => {
      const a = Print.docNameFromLabel('Rim', '21/08/2026');
      const b = Print.docNameFromLabel('Rim', '21/08/2026');
      expect(a).toBe(b);
    });
  });

  it('names the archive like the documents inside it', () => {
    expect(Print.bulkZipName('PO')).toMatch(/^PO_\d{6}\.zip$/);
  });
});

// ── Fitting the document to the page ─────────────────────────────────
describe('fitToPage', () => {
  function tableWith(columns) {
    const cells = Array.from({ length: columns }, (_, i) => `<td>${i}</td>`).join('');
    document.getElementById('print-bill-container').innerHTML =
      `<table><tr>${cells}</tr></table>`;
    return document.getElementById('print-bill-container');
  }

  it('leaves an ordinary document alone', () => {
    const el = tableWith(6);
    expect(Print.fitToPage(el)).toBe(6);
    expect(el.className).not.toMatch(/print-fit-/);
  });

  it('steps down a tier as the table widens', () => {
    expect(Print.fitToPage(tableWith(10))).toBe(10);
    expect(document.getElementById('print-bill-container').classList
      .contains('print-fit-compact')).toBe(true);

    Print.fitToPage(tableWith(14));
    expect(document.getElementById('print-bill-container').classList
      .contains('print-fit-dense')).toBe(true);

    Print.fitToPage(tableWith(20));
    expect(document.getElementById('print-bill-container').classList
      .contains('print-fit-xdense')).toBe(true);
  });

  it('never leaves two tiers applied at once', () => {
    const el = tableWith(20);
    Print.fitToPage(el);
    Print.fitToPage(tableWith(6));
    expect(el.className).not.toMatch(/print-fit-/);
  });

  // A header cell spanning three columns commits the table to three columns
  // of width, so it must count as three.
  it('counts colSpan', () => {
    document.getElementById('print-bill-container').innerHTML =
      '<table><tr><th colspan="9">Wide</th></tr><tr><td>1</td></tr></table>';
    expect(Print.fitToPage(document.getElementById('print-bill-container'))).toBe(9);
  });

  it('clears the tier after printing', () => {
    const el = tableWith(20);
    Print.trigger('print-bill-container', 'Wide');
    expect(el.className).toMatch(/print-fit-/);

    window.dispatchEvent(new window.Event('afterprint'));
    expect(el.className).not.toMatch(/print-fit-/);
  });

  describe('landscape: auto', () => {
    const rule = () => document.getElementById(Print.ORIENTATION_STYLE_ID);

    it('stays portrait for a document that fits', () => {
      tableWith(6);
      Print.trigger('print-bill-container', 'Narrow', { landscape: 'auto' });
      expect(rule()).toBeNull();
    });

    // The stock pivot grows one column per size; past a point the long edge
    // of the page buys more than any font change can.
    it('rotates a very wide document', () => {
      tableWith(18);
      Print.trigger('print-bill-container', 'Wide', { landscape: 'auto' });
      expect(rule().textContent).toContain('a4 landscape');
    });
  });

  it('gives the server the same tier it would have printed at', () => {
    const cells = Array.from({ length: 14 }, (_, i) => `<td>${i}</td>`).join('');
    expect(Print.fitDensityFor(`<table><tr>${cells}</tr></table>`)).toBe('print-fit-dense');
    expect(Print.fitDensityFor('<table><tr><td>a</td></tr></table>')).toBe('');
  });
});
