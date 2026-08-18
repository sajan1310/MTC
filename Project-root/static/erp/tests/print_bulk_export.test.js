'use strict';
// Covers the bulk-export loop in App.Print.downloadSeparatePDFs -- progress
// reporting, button restore, and how completion is worded.
//
// The naming layer (sanitizeFilename / uniqueFilename) is covered separately in
// print_filenames.test.js. See docs/audit/PDF_GENERATION_REVIEW.md PDF-005/006.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

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
});

// Replaces only the two methods that touch html2pdf, so the loop under test is
// the real one.
function stubExport(Print_, onEach = () => true) {
  const calls = [];
  Print_.renderBulkPages = () => {};
  Print_.downloadElementAsPDF = (id, filename, overrides) => {
    calls.push({ filename, overrides, label: document.getElementById('btnBulk')?.innerHTML });
    return Promise.resolve(onEach(calls.length));
  };
  return calls;
}

describe('progress reporting via the triggering button', () => {
  it('relabels the button with a determinate count for each record', async () => {
    const calls = stubExport(Print);
    await Print.downloadSeparatePDFs(
      ['a', 'b', 'c'],
      () => '',
      r => `${r}.pdf`,
      { progressButtonId: 'btnBulk' }
    );
    const labels = calls.map(c => c.label.replace(/<[^>]*>/g, '').trim());
    expect(labels).toEqual([
      'Exporting 1 of 3…',
      'Exporting 2 of 3…',
      'Exporting 3 of 3…',
    ]);
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
    await Print.downloadSeparatePDFs(['a'], () => '', () => 'a.pdf', {
      progressButtonId: 'btnBulk',
    });
    expect(seenDisabled).toBe(true);
    expect(btn.disabled).toBe(false);
    expect(btn.innerHTML).toBe(original);
  });

  it('shows a spinner in the label, not just text', async () => {
    const calls = stubExport(Print);
    await Print.downloadSeparatePDFs(['a'], () => '', () => 'a.pdf', {
      progressButtonId: 'btnBulk',
    });
    expect(calls[0].label).toContain('spinner-border');
  });

  // The failure that would strand the UI: an export throwing mid-batch must
  // still hand the button back.
  it('restores the button even when an export throws', async () => {
    const btn = document.getElementById('btnBulk');
    const original = btn.innerHTML;
    Print.renderBulkPages = () => {};
    Print.downloadElementAsPDF = () => Promise.reject(new Error('html2canvas blew up'));
    await expect(
      Print.downloadSeparatePDFs(['a', 'b'], () => '', () => 'a.pdf', {
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
    await Print.downloadSeparatePDFs(['a'], () => '', () => 'a.pdf', {
      progressButtonId: 'btnBulk',
    });
    expect(btn.disabled).toBe(true);
  });

  it('works with no progressButtonId and touches no button', async () => {
    const btn = document.getElementById('btnBulk');
    const original = btn.innerHTML;
    const calls = stubExport(Print);
    const n = await Print.downloadSeparatePDFs(['a', 'b'], () => '', r => `${r}.pdf`);
    expect(n).toBe(2);
    expect(calls).toHaveLength(2);
    expect(btn.innerHTML).toBe(original);
  });

  it('is a no-op on an unknown button id rather than throwing', async () => {
    stubExport(Print);
    const n = await Print.downloadSeparatePDFs(['a'], () => '', () => 'a.pdf', {
      progressButtonId: 'nope',
    });
    expect(n).toBe(1);
  });

  it('forwards pdfOverrides through to each export', async () => {
    const calls = stubExport(Print);
    const overrides = { jsPDF: { orientation: 'landscape' }, captureWidthPx: 1122 };
    await Print.downloadSeparatePDFs(['a', 'b'], () => '', r => `${r}.pdf`, {
      pdfOverrides: overrides,
    });
    expect(calls.every(c => c.overrides === overrides)).toBe(true);
  });
});

describe('App.Print.reportBulkResult', () => {
  it('reports plain success when every record generated', () => {
    Print.reportBulkResult(3, 3, 'purchase order PDF');
    expect(toasts).toEqual([['3 purchase order PDFs generated.', false]]);
  });

  it('uses the singular for one record', () => {
    Print.reportBulkResult(1, 1, 'vendor ledger PDF');
    expect(toasts).toEqual([['1 vendor ledger PDF generated.', false]]);
  });

  // The point of the whole helper: never claim total success on partial work.
  it('reports partial failure as an error, naming both numbers', () => {
    Print.reportBulkResult(2, 5, 'item ledger PDF');
    expect(toasts).toEqual([
      ['Generated 2 of 5 item ledger PDFs — 3 failed.', true],
    ]);
  });

  it('reports total failure as an error', () => {
    Print.reportBulkResult(0, 4, 'delivery challan PDF');
    expect(toasts).toEqual([['Could not generate any delivery challan PDFs.', true]]);
  });

  it('says "generated", never "downloaded" — delivery cannot be observed', () => {
    Print.reportBulkResult(3, 3, 'bill PDF');
    const msg = toasts[0][0];
    expect(msg).toContain('generated');
    expect(msg).not.toMatch(/download|export/i);
  });
});
