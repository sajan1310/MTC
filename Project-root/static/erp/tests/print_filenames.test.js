'use strict';
// Covers App.Print's filename handling for the bulk "Download PDFs" path.
//
// print.js had no tests despite being the most widely shared frontend module
// (see docs/audit/PDF_GENERATION_REVIEW.md PDF-006). These two behaviours are
// the ones that actually lose files when they regress:
//   - sanitizeFilename's 'Document' fallback: the character class strips
//     everything outside [a-zA-Z0-9_-], so a vendor or item named wholly in
//     Gurmukhi/Devanagari sanitizes to '' and yields "Item_Ledger_.pdf".
//   - de-duplication in deliverSeparatePDFs: once several records share a
//     name (which the fallback guarantees), the browser overwrites or appends
//     its own "(1)", so the export silently delivers fewer files than records.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadPrintModule() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'print.js'),
    'utf8'
  );
  const sandbox = {
    App: { Utils: { showToast: () => {} } },
    document: { getElementById: () => null, querySelectorAll: () => [] },
    window: {},
    console,
    loadScript: () => Promise.resolve(),
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.App.Print;
}

const Print = loadPrintModule();

describe('App.Print.sanitizeFilename', () => {
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
    const long =
      'Shri Balaji Cycle and Rickshaw Parts Manufacturing Company Private Limited';
    const out = Print.sanitizeFilename(long, false);
    expect(out).toHaveLength(50);
  });

  // The regression this file exists for.
  it('falls back to Document when every character is stripped', () => {
    expect(Print.sanitizeFilename('ਗੁਪਤਾ ਸਾਈਕਲ ਇੰਡਸਟਰੀਜ਼', false)).toBe('Document');
    expect(Print.sanitizeFilename('गुप्ता साइकिल', false)).toBe('Document');
    expect(Print.sanitizeFilename('')).toBe('Document');
    expect(Print.sanitizeFilename('!!!')).toBe('Document');
  });

  it('never returns an empty string, so a name component is never blank', () => {
    for (const input of ['', '   ', '@@@', '你好', '—', null, undefined]) {
      expect(Print.sanitizeFilename(input)).not.toBe('');
    }
  });
});

describe('App.Print.uniqueFilename', () => {
  it('leaves the first occurrence untouched', () => {
    const used = new Set();
    expect(Print.uniqueFilename('PO_1_Acme.pdf', used)).toBe('PO_1_Acme.pdf');
  });

  it('suffixes repeats before the extension, not after', () => {
    const used = new Set();
    Print.uniqueFilename('Item_Ledger_Document.pdf', used);
    expect(Print.uniqueFilename('Item_Ledger_Document.pdf', used))
      .toBe('Item_Ledger_Document_2.pdf');
    expect(Print.uniqueFilename('Item_Ledger_Document.pdf', used))
      .toBe('Item_Ledger_Document_3.pdf');
  });

  it('treats names differing only in case as colliding', () => {
    const used = new Set();
    Print.uniqueFilename('PO_1_Acme.pdf', used);
    expect(Print.uniqueFilename('po_1_acme.pdf', used)).toBe('po_1_acme_2.pdf');
  });

  it('handles a name with no extension', () => {
    const used = new Set();
    Print.uniqueFilename('Ledger', used);
    expect(Print.uniqueFilename('Ledger', used)).toBe('Ledger_2');
  });

  it('does not mistake a leading dot for an extension', () => {
    const used = new Set();
    expect(Print.uniqueFilename('.pdf', used)).toBe('.pdf');
    expect(Print.uniqueFilename('.pdf', used)).toBe('.pdf_2');
  });
});

describe('deliverSeparatePDFs filename de-duplication', () => {
  // Drives the real method with downloadElementAsPDF and renderBulkPages
  // stubbed, so it exercises the loop's naming rather than html2pdf.
  function run(records, filenameFor) {
    const seen = [];
    const stub = Object.create(Print);
    stub.renderBulkPages = () => {};
    stub.downloadElementAsPDF = (_id, filename) => {
      seen.push(filename);
      return Promise.resolve(true);
    };
    return stub
      .deliverSeparatePDFs(records, () => '', filenameFor)
      .then(r => ({ count: r.generated, seen }));
  }

  it('gives three non-Latin-named items three distinct files', async () => {
    const items = ['ਸਾਈਕਲ', 'ਹੈਂਡਲ', 'ਪਹੀਆ'];
    const { count, seen } = await run(
      items,
      name => `Item_Ledger_${Print.sanitizeFilename(name, false)}.pdf`
    );
    expect(count).toBe(3);
    expect(new Set(seen).size).toBe(3);
    expect(seen).toEqual([
      'Item_Ledger_Document.pdf',
      'Item_Ledger_Document_2.pdf',
      'Item_Ledger_Document_3.pdf',
    ]);
  });

  it('leaves already-distinct names alone', async () => {
    const { seen } = await run(
      [{ n: '1', v: 'Acme' }, { n: '2', v: 'Bharat' }],
      r => `PO_${r.n}_${r.v}.pdf`
    );
    expect(seen).toEqual(['PO_1_Acme.pdf', 'PO_2_Bharat.pdf']);
  });

  it('counts only records that actually exported', async () => {
    const stub = Object.create(Print);
    stub.renderBulkPages = () => {};
    let n = 0;
    stub.downloadElementAsPDF = () => Promise.resolve(++n !== 2);
    const r = await stub.deliverSeparatePDFs([1, 2, 3], () => '', () => 'a.pdf');
    expect(r.generated).toBe(2);
  });
});
