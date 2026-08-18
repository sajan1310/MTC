'use strict';
// Covers App.Print.deliverSeparatePDFs -- progress reporting, button restore,
// the three delivery modes (folder / zip / files), how a destination is
// chosen, and how completion is worded for each.
//
// The naming layer (sanitizeFilename / uniqueFilename) is covered in
// print_filenames.test.js; the ZIP byte format in print_zip.test.js.
// See docs/audit/PDF_GENERATION_REVIEW.md PDF-005/006.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { TextEncoder } = require('node:util');
const { Blob } = require('node:buffer');

// Loads the real print.js against the real jsdom document, so getElementById
// and the button relabelling are exercised rather than mocked.
function loadPrintModule() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'print.js'), 'utf8');
  const toasts = [];
  const sandbox = {
    App: { Utils: { showToast: (m, e) => toasts.push([m, !!e]) } },
    document,
    window,
    console,
    setTimeout,
    Blob,
    TextEncoder,
    URL,
    requestAnimationFrame: cb => setTimeout(cb, 0),
    loadScript: () => Promise.resolve(),
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { Print: sandbox.App.Print, toasts };
}

let Print;
let toasts;

beforeEach(() => {
  document.body.innerHTML = `
    <button id="btnBulk" class="btn"><i class="bi bi-file-earmark-pdf"></i> Download PDFs (3)</button>
    <div id="print-bulk-container"><div id="print-bulk-body"></div></div>
  `;
  ({ Print, toasts } = loadPrintModule());
  Print.BULK_EXPORT_YIELD_MS = 0; // keep the suite fast; behaviour is unchanged
  delete window.showDirectoryPicker;
});

// Replaces only the methods that touch html2pdf, so the loop under test is real.
function stubExport(Print_, { ok = () => true } = {}) {
  const downloads = [];
  const blobs = [];
  Print_.renderBulkPages = () => {};
  Print_.downloadElementAsPDF = (id, filename) => {
    downloads.push({ filename, label: document.getElementById('btnBulk')?.innerHTML });
    return Promise.resolve(ok(downloads.length));
  };
  Print_.renderElementToPdfBlob = (id, filename) => {
    blobs.push(filename);
    return Promise.resolve(ok(blobs.length) ? new Blob([`pdf:${filename}`]) : null);
  };
  return { downloads, blobs };
}

describe('progress reporting via the triggering button', () => {
  it('relabels the button with a determinate count for each record', async () => {
    const { downloads } = stubExport(Print);
    await Print.deliverSeparatePDFs(['a', 'b', 'c'], () => '', r => `${r}.pdf`, {
      progressButtonId: 'btnBulk',
    });
    const labels = downloads.map(d => d.label.replace(/<[^>]*>/g, '').trim());
    expect(labels).toEqual(['Exporting 1 of 3…', 'Exporting 2 of 3…', 'Exporting 3 of 3…']);
  });

  it('disables the button while exporting and restores it afterwards', async () => {
    const btn = document.getElementById('btnBulk');
    const original = btn.innerHTML;
    let seenDisabled = false;
    Print.renderBulkPages = () => {};
    Print.downloadElementAsPDF = () => {
      seenDisabled = btn.disabled;
      return Promise.resolve(true);
    };
    await Print.deliverSeparatePDFs(['a'], () => '', () => 'a.pdf', {
      progressButtonId: 'btnBulk',
    });
    expect(seenDisabled).toBe(true);
    expect(btn.disabled).toBe(false);
    expect(btn.innerHTML).toBe(original);
  });

  it('shows a spinner in the label, not just text', async () => {
    const { downloads } = stubExport(Print);
    await Print.deliverSeparatePDFs(['a'], () => '', () => 'a.pdf', {
      progressButtonId: 'btnBulk',
    });
    expect(downloads[0].label).toContain('spinner-border');
  });

  // The failure that would strand the UI mid-batch.
  it('restores the button even when an export throws', async () => {
    const btn = document.getElementById('btnBulk');
    const original = btn.innerHTML;
    Print.renderBulkPages = () => {};
    Print.downloadElementAsPDF = () => Promise.reject(new Error('html2canvas blew up'));
    await expect(
      Print.deliverSeparatePDFs(['a', 'b'], () => '', () => 'a.pdf', {
        progressButtonId: 'btnBulk',
      })
    ).rejects.toThrow('html2canvas blew up');
    expect(btn.disabled).toBe(false);
    expect(btn.innerHTML).toBe(original);
  });

  it('leaves a button that was already disabled disabled', async () => {
    const btn = document.getElementById('btnBulk');
    btn.disabled = true;
    stubExport(Print);
    await Print.deliverSeparatePDFs(['a'], () => '', () => 'a.pdf', {
      progressButtonId: 'btnBulk',
    });
    expect(btn.disabled).toBe(true);
  });

  it('works with no progressButtonId and touches no button', async () => {
    const btn = document.getElementById('btnBulk');
    const original = btn.innerHTML;
    const { downloads } = stubExport(Print);
    const r = await Print.deliverSeparatePDFs(['a', 'b'], () => '', x => `${x}.pdf`);
    expect(r.generated).toBe(2);
    expect(downloads).toHaveLength(2);
    expect(btn.innerHTML).toBe(original);
  });

  it('is a no-op on an unknown button id rather than throwing', async () => {
    stubExport(Print);
    const r = await Print.deliverSeparatePDFs(['a'], () => '', () => 'a.pdf', {
      progressButtonId: 'nope',
    });
    expect(r.generated).toBe(1);
  });
});

describe('choosing a destination', () => {
  it('uses individual files for a single record, without prompting', async () => {
    window.showDirectoryPicker = () => {
      throw new Error('must not be called for one record');
    };
    expect(await Print.chooseBulkDestination(1)).toEqual({ mode: 'files' });
  });

  it('prefers the folder picker when the browser has one', async () => {
    const handle = { name: 'Exports' };
    window.showDirectoryPicker = () => Promise.resolve(handle);
    const dest = await Print.chooseBulkDestination(3);
    expect(dest.mode).toBe('folder');
    expect(dest.handle).toBe(handle);
  });

  it('asks for readwrite, since it is going to write files', async () => {
    let opts;
    window.showDirectoryPicker = o => {
      opts = o;
      return Promise.resolve({});
    };
    await Print.chooseBulkDestination(3);
    expect(opts.mode).toBe('readwrite');
  });

  // Dismissing the picker means "stop", not "fall back to something noisier".
  it('treats a dismissed picker as cancelling the whole export', async () => {
    const abort = new Error('user dismissed');
    abort.name = 'AbortError';
    window.showDirectoryPicker = () => Promise.reject(abort);
    expect(await Print.chooseBulkDestination(3)).toEqual({ mode: 'cancelled' });
  });

  it('falls back when the picker exists but fails for another reason', async () => {
    window.showDirectoryPicker = () => Promise.reject(new Error('not allowed here'));
    const dest = await Print.chooseBulkDestination(3);
    expect(dest.mode).toBe('files');
  });

  it('falls back to individual files at or below the ZIP threshold', async () => {
    expect((await Print.chooseBulkDestination(Print.ZIP_THRESHOLD)).mode).toBe('files');
  });

  it('falls back to a single ZIP above the threshold', async () => {
    expect((await Print.chooseBulkDestination(Print.ZIP_THRESHOLD + 1)).mode).toBe('zip');
  });
});

describe('folder delivery', () => {
  function fakeFolder({ failOn = [] } = {}) {
    const written = [];
    return {
      written,
      handle: {
        getFileHandle: name => {
          if (failOn.includes(name)) return Promise.reject(new Error('denied'));
          return Promise.resolve({
            createWritable: () =>
              Promise.resolve({
                write: blob => {
                  written.push({ name, size: blob.size });
                  return Promise.resolve();
                },
                close: () => Promise.resolve(),
              }),
          });
        },
      },
    };
  }

  it('writes one file per record into the chosen folder', async () => {
    stubExport(Print);
    const folder = fakeFolder();
    const r = await Print.deliverSeparatePDFs(['a', 'b', 'c'], () => '', x => `${x}.pdf`, {
      destination: { mode: 'folder', handle: folder.handle },
    });
    expect(folder.written.map(w => w.name)).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
    expect(r).toMatchObject({ generated: 3, delivered: 3, mode: 'folder' });
  });

  // The whole point of this mode: delivery is actually observable.
  it('counts only the writes that succeeded', async () => {
    stubExport(Print);
    const folder = fakeFolder({ failOn: ['b.pdf'] });
    const r = await Print.deliverSeparatePDFs(['a', 'b', 'c'], () => '', x => `${x}.pdf`, {
      destination: { mode: 'folder', handle: folder.handle },
    });
    expect(r.generated).toBe(3);
    expect(r.delivered).toBe(2);
  });

  it('never triggers a browser download in folder mode', async () => {
    const { downloads } = stubExport(Print);
    const folder = fakeFolder();
    await Print.deliverSeparatePDFs(['a'], () => '', () => 'a.pdf', {
      destination: { mode: 'folder', handle: folder.handle },
    });
    expect(downloads).toHaveLength(0);
  });
});

describe('zip delivery', () => {
  it('produces exactly one download for the whole batch', async () => {
    stubExport(Print);
    const saved = [];
    Print.saveBlob = (blob, name) => saved.push({ name, size: blob.size });
    const r = await Print.deliverSeparatePDFs(['a', 'b', 'c', 'd'], () => '', x => `${x}.pdf`, {
      destination: { mode: 'zip' },
      zipName: 'Purchase_Orders_170826.zip',
    });
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('Purchase_Orders_170826.zip');
    expect(r).toMatchObject({ generated: 4, delivered: 4, mode: 'zip' });
  });

  it('does not emit a zip when nothing rendered', async () => {
    stubExport(Print, { ok: () => false });
    const saved = [];
    Print.saveBlob = (...a) => saved.push(a);
    const r = await Print.deliverSeparatePDFs(['a', 'b'], () => '', x => `${x}.pdf`, {
      destination: { mode: 'zip' },
    });
    expect(saved).toHaveLength(0);
    expect(r.generated).toBe(0);
  });

  it('skips records that failed to render but still zips the rest', async () => {
    stubExport(Print, { ok: n => n !== 2 });
    let entries = 0;
    Print.zipStore = files => {
      entries = files.length;
      return Promise.resolve(new Blob(['zip']));
    };
    Print.saveBlob = () => {};
    const r = await Print.deliverSeparatePDFs(['a', 'b', 'c'], () => '', x => `${x}.pdf`, {
      destination: { mode: 'zip' },
    });
    expect(entries).toBe(2);
    expect(r.generated).toBe(2);
  });
});

describe('App.Print.reportBulkResult', () => {
  const files = (generated, delivered = generated) => ({
    generated, delivered, mode: 'files',
  });

  it('reports plain success when every record generated', () => {
    Print.reportBulkResult(files(3), 3, 'purchase order PDF');
    expect(toasts).toEqual([['3 purchase order PDFs generated.', false]]);
  });

  it('uses the singular for one record', () => {
    Print.reportBulkResult(files(1), 1, 'vendor ledger PDF');
    expect(toasts).toEqual([['1 vendor ledger PDF generated.', false]]);
  });

  // The point of the helper: never claim total success on partial work.
  it('reports partial failure as an error, naming both numbers', () => {
    Print.reportBulkResult(files(2), 5, 'item ledger PDF');
    expect(toasts).toEqual([['Generated 2 of 5 item ledger PDFs — 3 failed.', true]]);
  });

  it('reports total failure as an error', () => {
    Print.reportBulkResult(files(0), 4, 'delivery challan PDF');
    expect(toasts).toEqual([['Could not generate any delivery challan PDFs.', true]]);
  });

  it('says "generated" for individual downloads — delivery is unobservable', () => {
    Print.reportBulkResult(files(3), 3, 'bill PDF');
    expect(toasts[0][0]).toContain('generated');
    expect(toasts[0][0]).not.toMatch(/download|saved/i);
  });

  // Folder mode is the one path that may claim delivery.
  it('says "saved" for folder mode, because the writes were confirmed', () => {
    Print.reportBulkResult({ generated: 3, delivered: 3, mode: 'folder' }, 3, 'process sheet PDF');
    expect(toasts).toEqual([['3 process sheet PDFs saved to the selected folder.', false]]);
  });

  it('flags folder writes that failed after a successful render', () => {
    Print.reportBulkResult({ generated: 5, delivered: 3, mode: 'folder' }, 5, 'bill PDF');
    expect(toasts).toEqual([
      ['Generated 5 bill PDFs but only 3 could be saved.', true],
    ]);
  });

  it('names the archive for zip mode', () => {
    Print.reportBulkResult(
      { generated: 8, delivered: 8, mode: 'zip', zipName: 'Purchase_Orders_170826.zip' },
      8,
      'purchase order PDF'
    );
    expect(toasts).toEqual([
      ['8 purchase order PDFs packaged into Purchase_Orders_170826.zip.', false],
    ]);
  });
});
