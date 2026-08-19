'use strict';
// Covers App.Print.renderViaServer and the vector-first path in
// deliverSeparatePDFs (PDF-002).
//
// The contract that matters is the fallback: server rendering is an upgrade,
// never a dependency. If the endpoint is missing, offline, or erroring, every
// export must still complete through the existing raster renderer -- that is
// what keeps "Download PDF" working with no network.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { TextEncoder } = require('node:util');
const { Blob } = require('node:buffer');

function loadPrintModule() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'print.js'), 'utf8');
  const toasts = [];
  const sandbox = {
    App: { Utils: { showToast: (m, e) => toasts.push([m, !!e]) } },
    document, window, console, setTimeout, Blob, TextEncoder, URL, Date,
    fetch: undefined,
    requestAnimationFrame: cb => setTimeout(cb, 0),
    loadScript: () => Promise.resolve(),
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { Print: sandbox.App.Print, toasts, sandbox };
}

let Print;
let sandbox;
let toasts;

beforeEach(() => {
  document.body.innerHTML = `
    <meta name="csrf-token" content="tok-123">
    <div id="print-bulk-container"><div id="print-bulk-body"></div></div>
  `;
  ({ Print, sandbox, toasts } = loadPrintModule());
  Print.BULK_EXPORT_YIELD_MS = 0;
});

// Minimal fetch double recording what the client sent.
function fakeFetch(responder) {
  const calls = [];
  sandbox.fetch = (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return Promise.resolve(responder(calls.length));
  };
  return calls;
}

const pdfResponse = (bytes = '%PDF-1.4 vector') => ({
  ok: true,
  status: 200,
  blob: () => Promise.resolve(new Blob([bytes])),
});

describe('renderViaServer', () => {
  it('posts the document HTML to the render endpoint', async () => {
    const calls = fakeFetch(() => pdfResponse());
    await Print.renderViaServer('<p>PO-2026-0417</p>');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/erp/render-pdf');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].body.html).toBe('<p>PO-2026-0417</p>');
  });

  // CSRFProtect is global on the server; without this header every render 400s.
  it('sends the CSRF token from the page', async () => {
    const calls = fakeFetch(() => pdfResponse());
    await Print.renderViaServer('<p>x</p>');
    expect(calls[0].init.headers['X-CSRFToken']).toBe('tok-123');
    expect(calls[0].init.credentials).toBe('same-origin');
  });

  it('returns the rendered PDF as a blob', async () => {
    fakeFetch(() => pdfResponse());
    const blob = await Print.renderViaServer('<p>x</p>');
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBeGreaterThan(0);
  });

  it('forwards landscape when the caller asked for it', async () => {
    const calls = fakeFetch(() => pdfResponse());
    await Print.renderViaServer('<p>x</p>', { jsPDF: { orientation: 'landscape' } });
    expect(calls[0].body.landscape).toBe(true);
  });

  it('defaults to portrait', async () => {
    const calls = fakeFetch(() => pdfResponse());
    await Print.renderViaServer('<p>x</p>');
    expect(calls[0].body.landscape).toBe(false);
  });

  it('returns null for empty HTML without calling the server', async () => {
    const calls = fakeFetch(() => pdfResponse());
    expect(await Print.renderViaServer('')).toBe(null);
    expect(calls).toHaveLength(0);
  });
});

describe('when the server cannot render', () => {
  // 503 means "this deployment has no Chromium" -- asking again per document
  // would stall a 40-record export 40 times.
  it('stops asking for the session after a 503', async () => {
    const calls = fakeFetch(() => ({ ok: false, status: 503 }));
    expect(await Print.renderViaServer('<p>a</p>')).toBe(null);
    expect(Print.serverPdfAvailable).toBe(false);
    expect(await Print.renderViaServer('<p>b</p>')).toBe(null);
    expect(calls).toHaveLength(1); // second never went out
  });

  it('stops asking for the session when the fetch itself fails (offline)', async () => {
    const calls = [];
    sandbox.fetch = () => { calls.push(1); return Promise.reject(new TypeError('Failed to fetch')); };
    expect(await Print.renderViaServer('<p>a</p>')).toBe(null);
    expect(Print.serverPdfAvailable).toBe(false);
    await Print.renderViaServer('<p>b</p>');
    expect(calls).toHaveLength(1);
  });

  it('works with no fetch at all', async () => {
    sandbox.fetch = undefined;
    expect(await Print.renderViaServer('<p>a</p>')).toBe(null);
    expect(Print.serverPdfAvailable).toBe(false);
  });

  // A single oversized or malformed document must not disable the whole run.
  it('keeps trying after a per-document error', async () => {
    const calls = fakeFetch(n => (n === 1 ? { ok: false, status: 400 } : pdfResponse()));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await Print.renderViaServer('<p>bad</p>')).toBe(null);
    expect(Print.serverPdfAvailable).not.toBe(false);
    expect(await Print.renderViaServer('<p>good</p>')).toBeInstanceOf(Blob);
    expect(calls).toHaveLength(2);
    warn.mockRestore();
  });
});

describe('deliverSeparatePDFs prefers the server', () => {
  function stubClientRaster(Print_) {
    const raster = [];
    Print_.renderBulkPages = () => {};
    Print_.downloadElementAsPDF = (_id, f) => { raster.push(f); return Promise.resolve(true); };
    Print_.renderElementToPdfBlob = (_id, f) => { raster.push(f); return Promise.resolve(new Blob(['raster'])); };
    return raster;
  }

  it('uses server blobs and never touches the raster renderer', async () => {
    const raster = stubClientRaster(Print);
    const saved = [];
    Print.saveBlob = (b, n) => saved.push(n);
    fakeFetch(() => pdfResponse());

    const r = await Print.deliverSeparatePDFs(
      ['a', 'b'], x => `<p>${x}</p>`, x => `${x}.pdf`
    );
    expect(r.generated).toBe(2);
    expect(saved).toEqual(['a.pdf', 'b.pdf']);
    expect(raster).toEqual([]); // html2pdf was never invoked
  });

  it('passes the built HTML for each record, not the shared container', async () => {
    stubClientRaster(Print);
    Print.saveBlob = () => {};
    const calls = fakeFetch(() => pdfResponse());
    await Print.deliverSeparatePDFs(['a', 'b'], x => `<p>doc-${x}</p>`, x => `${x}.pdf`);
    expect(calls.map(c => c.body.html)).toEqual(['<p>doc-a</p>', '<p>doc-b</p>']);
  });

  // The fallback that keeps offline export working.
  it('falls back to the raster renderer when the server is unavailable', async () => {
    const raster = stubClientRaster(Print);
    fakeFetch(() => ({ ok: false, status: 503 }));
    const r = await Print.deliverSeparatePDFs(
      ['a', 'b'], x => `<p>${x}</p>`, x => `${x}.pdf`
    );
    expect(r.generated).toBe(2);
    expect(raster).toEqual(['a.pdf', 'b.pdf']);
  });

  it('writes server blobs into the chosen folder', async () => {
    stubClientRaster(Print);
    fakeFetch(() => pdfResponse());
    const written = [];
    const handle = {
      getFileHandle: name => Promise.resolve({
        createWritable: () => Promise.resolve({
          write: () => Promise.resolve(),
          close: () => { written.push(name); return Promise.resolve(); },
        }),
      }),
    };
    const r = await Print.deliverSeparatePDFs(
      ['a', 'b'], x => `<p>${x}</p>`, x => `${x}.pdf`,
      { destination: { mode: 'folder', handle } }
    );
    expect(written).toEqual(['a.pdf', 'b.pdf']);
    expect(r.delivered).toBe(2);
  });

  it('packs server blobs into the zip', async () => {
    stubClientRaster(Print);
    fakeFetch(() => pdfResponse());
    let entries = [];
    Print.zipStore = files => { entries = files.map(f => f.name); return Promise.resolve(new Blob(['z'])); };
    Print.saveBlob = () => {};
    const r = await Print.deliverSeparatePDFs(
      ['a', 'b', 'c'], x => `<p>${x}</p>`, x => `${x}.pdf`,
      { destination: { mode: 'zip' }, zipName: 'Docs.zip' }
    );
    expect(entries).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
    expect(r.delivered).toBe(3);
  });

  it('still de-duplicates filenames on the server path', async () => {
    stubClientRaster(Print);
    const saved = [];
    Print.saveBlob = (b, n) => saved.push(n);
    fakeFetch(() => pdfResponse());
    await Print.deliverSeparatePDFs(
      ['x', 'y', 'z'], () => '<p>d</p>', () => 'Item_Ledger_Document.pdf'
    );
    expect(saved).toEqual([
      'Item_Ledger_Document.pdf',
      'Item_Ledger_Document_2.pdf',
      'Item_Ledger_Document_3.pdf',
    ]);
  });
});

describe('PDF_SERVER_RENDER=off', () => {
  // A deployment that deliberately skips Chromium should not pay one wasted
  // request per session rediscovering that.
  it('never contacts the server when the shell says off', async () => {
    document.body.innerHTML =
      '<meta name="pdf-server-render" content="off">' + document.body.innerHTML;
    ({ Print, sandbox, toasts } = loadPrintModule());
    const calls = fakeFetch(() => pdfResponse());
    expect(Print.serverPdfDisabledByConfig).toBe(true);
    expect(await Print.renderViaServer('<p>x</p>')).toBe(null);
    expect(calls).toHaveLength(0);
  });

  it('treats a missing meta tag as auto, not off', async () => {
    const calls = fakeFetch(() => pdfResponse());
    expect(Print.serverPdfDisabledByConfig).toBe(false);
    await Print.renderViaServer('<p>x</p>');
    expect(calls).toHaveLength(1);
  });

  it('treats an explicit auto as auto', async () => {
    document.body.innerHTML =
      '<meta name="pdf-server-render" content="auto">' + document.body.innerHTML;
    ({ Print, sandbox, toasts } = loadPrintModule());
    const calls = fakeFetch(() => pdfResponse());
    await Print.renderViaServer('<p>x</p>');
    expect(calls).toHaveLength(1);
  });

  it('still exports, via the raster renderer', async () => {
    document.body.innerHTML =
      '<meta name="pdf-server-render" content="off">' + document.body.innerHTML;
    ({ Print, sandbox, toasts } = loadPrintModule());
    Print.BULK_EXPORT_YIELD_MS = 0;
    const raster = [];
    Print.renderBulkPages = () => {};
    Print.downloadElementAsPDF = (_i, f) => { raster.push(f); return Promise.resolve(true); };
    const r = await Print.deliverSeparatePDFs(['a', 'b'], x => `<p>${x}</p>`, x => `${x}.pdf`);
    expect(r.generated).toBe(2);
    expect(raster).toEqual(['a.pdf', 'b.pdf']);
    expect(r.rasterised).toBe(true);
  });

  it('survives a document with no querySelector at all', () => {
    // print.js also runs where the DOM is partial (see api.js on service
    // workers); reading the meta tag must not throw there.
    const src = fs.readFileSync(path.join(__dirname, '..', 'print.js'), 'utf8');
    const sb = {
      App: { Utils: { showToast: () => {} } },
      document: {}, window: {}, console, setTimeout, Blob, TextEncoder, URL, Date,
      loadScript: () => Promise.resolve(),
    };
    vm.createContext(sb);
    vm.runInContext(src, sb);
    expect(sb.App.Print.serverPdfDisabledByConfig).toBe(false);
  });
});

describe('the searchable-PDF tip', () => {
  beforeEach(() => {
    try { window.localStorage.clear(); } catch (e) { /* ignored */ }
  });

  it('is shown after a rasterised export', () => {
    Print.reportBulkResult(
      { generated: 2, delivered: 2, mode: 'files', rasterised: true }, 2, 'PO PDF');
    expect(toasts.some(t => /Save as PDF/.test(t[0]))).toBe(true);
  });

  // Repeating a tip after every export trains people to ignore toasts.
  it('is shown only once per browser', () => {
    Print.reportBulkResult(
      { generated: 1, delivered: 1, mode: 'files', rasterised: true }, 1, 'PO PDF');
    const first = toasts.filter(t => /Save as PDF/.test(t[0])).length;
    Print.reportBulkResult(
      { generated: 1, delivered: 1, mode: 'files', rasterised: true }, 1, 'PO PDF');
    const total = toasts.filter(t => /Save as PDF/.test(t[0])).length;
    expect(first).toBe(1);
    expect(total).toBe(1);
  });

  // The server output already is searchable, so the tip would be wrong.
  it('is not shown when the server rendered the PDFs', () => {
    Print.reportBulkResult(
      { generated: 2, delivered: 2, mode: 'files', rasterised: false }, 2, 'PO PDF');
    expect(toasts.some(t => /Save as PDF/.test(t[0]))).toBe(false);
  });

  it('is not shown when the export failed', () => {
    Print.reportBulkResult(
      { generated: 0, delivered: 0, mode: 'files', rasterised: true }, 3, 'PO PDF');
    expect(toasts.some(t => /Save as PDF/.test(t[0]))).toBe(false);
  });

  it('does not throw when localStorage is unavailable', () => {
    const real = window.localStorage.getItem;
    window.localStorage.getItem = () => { throw new Error('denied'); };
    expect(() => Print.reportBulkResult(
      { generated: 1, delivered: 1, mode: 'files', rasterised: true }, 1, 'PO PDF')).not.toThrow();
    window.localStorage.getItem = real;
  });
});
