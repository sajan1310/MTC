'use strict';
// print.js -- App.Print.
//
// Every print and PDF export in this app goes through one route: the
// browser's own print engine, via window.print(). There is no second
// renderer. That is what makes output consistent -- a document looks the
// same whether it is sent to a printer, saved as a PDF, or previewed --
// and it is what makes every PDF a real document: selectable text,
// searchable, copyable, readable by a screen reader.
//
// How a document gets printed
// ───────────────────────────────────────────────────────────────────────
// There are exactly two shapes, and every module uses one of them:
//
//   trigger(containerId, title)          one already-populated container
//   triggerBulk(records, build, title)   N records, one page each
//
// Both reveal exactly one container (`.active-print`), set document.title,
// call window.print(), and put everything back afterwards. Chrome and Edge
// use document.title as the default "Save as PDF" filename, which is why
// the title argument is the filename argument -- there is no separate
// download path that could name a file differently.
//
// What used to be here
// ───────────────────────────────────────────────────────────────────────
// A client-side raster exporter (html2pdf.js -> html2canvas + jsPDF) and a
// server-side vector renderer (POST /erp/render-pdf -> headless Chromium),
// with the raster path as the offline fallback. The raster path produced a
// flat JPEG: measured on a 15-line purchase order, 361 KB with ZERO
// extractable characters against 48 KB and 1,184 characters through a real
// print engine. Both are gone -- see docs/audit/PDF_GENERATION_REVIEW.md.
//
// The one capability that went with them is bulk export as separate named
// files (and its ZIP/folder delivery modes). window.print() produces one
// document per dialog, so a bulk export is one multi-page document with a
// page break between records. Every Print and Download PDF button in the app
// still exists and still sits where it did; what changed is what happens
// underneath, not what the user reaches for.

App.Print = {
  // ── Canonical A4 page geometry ───────────────────────────────
  // Must stay in step with the @page rule in styles.css AND its copy in
  // mobile_styles.css. PAGE_WIDTH_PX / PAGE_HEIGHT_PX are the printable box
  // in CSS pixels at 96dpi -- production.js measures its auto-fit Production
  // Sheet against them to decide whether the sheet fits one page.
  PAGE_MARGIN_MM: 6,
  get PAGE_WIDTH_PX() { return Math.floor((210 - 2 * this.PAGE_MARGIN_MM) * 96 / 25.4); },
  get PAGE_HEIGHT_PX() { return Math.floor((297 - 2 * this.PAGE_MARGIN_MM) * 96 / 25.4); },

  // Every print template carries class="print-container" (see
  // templates/erp/partials/print.html). Selecting on the class rather than
  // enumerating ids is deliberate: the id list used to be written out ten
  // times across print.js, styles.css and mobile_styles.css, and they had
  // drifted -- five containers were missing from the @media print block, so
  // its page-break and repeating-header rules silently never applied to them.
  // A twelfth print template now needs one class in the markup and no
  // changes here.
  CONTAINER_SELECTOR: '.print-container',

  containers() {
    return Array.from(document.querySelectorAll(this.CONTAINER_SELECTOR));
  },

  // Sweeps '.active-print' as well as '.print-container'. The former is a
  // class this module sets, so anything still carrying it is ours to clear
  // even when it lives in markup that predates '.print-container' -- a page
  // served from a stale template cache against a newer print.js would
  // otherwise match nothing here and leave the document stranded on screen,
  // covering the app, with no way back except a reload.
  hideAll() {
    const armed = new Set(this.containers());
    document.querySelectorAll('.active-print').forEach(el => armed.add(el));
    armed.forEach(el => {
      el.classList.remove('active-print');
      el.style.display = 'none';
    });
  },

  // Returns an inline logo <img> or the fallback brand-name div for use
  // in both static print templates (via injectLogo) and JS-built HTML strings.
  brandHeaderHtml(BRAND) {
    if (App.companyLogo) {
      return `<img src="${App.companyLogo}" style="max-height:60px;max-width:220px;object-fit:contain;display:block;margin:0 auto;-webkit-print-color-adjust:exact;print-color-adjust:exact;">`;
    }
    return `<div style="font-size:32px;font-weight:800;color:${BRAND};letter-spacing:2px;text-transform:uppercase;font-family:'Segoe UI',Arial,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact;">Maharaja Bikes</div>`;
  },

  // Swaps .print-brand-text content with logo or fallback text in the
  // static print.html templates (single-record print path).
  injectLogo() {
    document.querySelectorAll('.print-brand-text').forEach(el => {
      if (App.companyLogo) {
        el.innerHTML = `<img src="${App.companyLogo}" style="max-height:60px;max-width:220px;object-fit:contain;-webkit-print-color-adjust:exact;print-color-adjust:exact;">`;
      } else {
        el.textContent = 'Maharaja Bikes';
      }
    });
  },

  // ── Page orientation ─────────────────────────────────────────
  //
  // styles.css declares `@page { size: a4 portrait }` for everything. The
  // Production Sheet is the one document with a user-facing Landscape
  // option, and orientation has to be a property of one print job rather
  // than global state -- otherwise printing a landscape sheet would leave
  // every subsequent purchase order sideways.
  //
  // A later @page rule wins, so this appends one and removes it in cleanup.
  // Deliberately not the CSS `page:` property with a named @page: named
  // pages are Chromium-only, and this has to behave the same everywhere,
  // which is the whole point of having one renderer.
  ORIENTATION_STYLE_ID: 'erp-print-orientation',

  setPageOrientation(landscape) {
    this.clearPageOrientation();
    if (!landscape) return;
    const style = document.createElement('style');
    style.id = this.ORIENTATION_STYLE_ID;
    style.textContent = `@page { size: a4 landscape; margin: ${this.PAGE_MARGIN_MM}mm; }`;
    document.head.appendChild(style);
  },

  clearPageOrientation() {
    const existing = document.getElementById(this.ORIENTATION_STYLE_ID);
    if (existing) existing.remove();
  },

  // ── Filenames ────────────────────────────────────────────────
  //
  // Shared sanitizer for every module's document titles. Because the title
  // IS the suggested PDF filename, this is the only place filenames are
  // shaped.
  //
  // The 50-char cap and the 'Document' fallback both matter and must stay.
  // The pattern strips everything outside [a-zA-Z0-9_-], which means a name
  // written wholly in Gurmukhi or Devanagari -- ordinary for vendors and items
  // here -- sanitizes to the empty string, not to a short name. Without the
  // fallback that yields "Item_Ledger_".
  sanitizeFilename(text = '', allowSpaces = true) {
    const pattern = allowSpaces ? /[^a-zA-Z0-9\s_-]/g : /[^a-zA-Z0-9_-]/g;
    return (
      String(text)
        .replace(pattern, '')
        .trim()
        .replace(/\s+/g, '_')
        .slice(0, 50) || 'Document'
    );
  },

  // Last-resort guard applied to every title on its way to document.title.
  // Callers already sanitize the variable parts (vendor names, item names);
  // this only removes the characters Windows and macOS refuse in a filename,
  // so a title that reached here unsanitized cannot produce a save dialog
  // the user has to correct by hand. Spaces and dashes are kept -- they are
  // legal, and "Dispatch Plan - 2026-08-19" is a better filename than its
  // underscored form.
  titleToFilename(title) {
    return String(title == null ? '' : title)
      .replace(/[/\\:*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'Document';
  },

  // ── Fitting a document to the page ───────────────────────────
  //
  // styles.css lets any cell wrap anywhere, so a table can no longer
  // overflow the page and get cut. What that alone cannot fix is
  // READABILITY: a 16-column stock pivot that fits only because every cell
  // wrapped to one character per line is technically on the page and
  // useless.
  //
  // So the widest row in the document picks a density tier, and the tier
  // trades type size for column room. Documents under the first threshold
  // get no class at all, so ordinary purchase orders and challans are
  // untouched.
  //
  // Column count, not measured width, is the input on purpose: this runs
  // before window.print(), when the container is laid out at SCREEN width,
  // and the page box is a different width entirely. Anything measured here
  // would be measuring the wrong box. Column count is the same in both.
  FIT_TIERS: [
    { maxColumns: 8, className: '' },
    { maxColumns: 12, className: 'print-fit-compact' },
    { maxColumns: 16, className: 'print-fit-dense' },
    { maxColumns: Infinity, className: 'print-fit-xdense' }
  ],

  // Beyond this many columns even the densest tier is cramped on A4
  // portrait, and rotating the page buys 40% more width than any font
  // change can. Callers opt in with `landscape: 'auto'`.
  AUTO_LANDSCAPE_COLUMNS: 12,

  fitClassNames() {
    return this.FIT_TIERS.map(t => t.className).filter(Boolean);
  },

  // The widest row anywhere in `root`, counting colSpan -- a header cell
  // spanning three columns commits the table to three columns of width.
  columnCount(root) {
    let widest = 0;
    root.querySelectorAll('tr').forEach(row => {
      let n = 0;
      for (const cell of row.cells || []) n += cell.colSpan || 1;
      if (n > widest) widest = n;
    });
    return widest;
  },

  // Applies the tier for `container`'s widest table and returns the column
  // count, so a caller can also decide on orientation.
  fitToPage(container) {
    if (!container) return 0;
    container.classList.remove(...this.fitClassNames());

    const columns = this.columnCount(container);
    const tier = this.FIT_TIERS.find(t => columns <= t.maxColumns);
    if (tier && tier.className) container.classList.add(tier.className);
    return columns;
  },

  // The tier a fragment of document HTML would print at.
  //
  // The download paths send HTML strings to the server, which has no DOM to
  // count columns with, so the counting happens here and the class name goes
  // in the payload. Parsed into a detached element: it is never inserted, so
  // nothing lays out and no styles apply -- only the table structure is read.
  fitDensityFor(html) {
    if (!html) return '';
    const holder = document.createElement('div');
    holder.innerHTML = html;
    const columns = this.columnCount(holder);
    const tier = this.FIT_TIERS.find(t => columns <= t.maxColumns);
    return tier ? tier.className : '';
  },

  // ── Document names ───────────────────────────────────────────
  //
  // One convention, used by every Print title and every Download filename,
  // so the two always agree and a folder of exports sorts and searches
  // sensibly.
  //
  //     CODE_KEY_PARTY[_YYMMDD]
  //
  //     PO_1204_Mahadev          purchase order 1204, Mahadev Industries
  //     GRN_3391_Gupta           goods receipt
  //     DC_1041_Sharma           delivery challan
  //     ILG_RimBlack_260819      item ledger as at 19 Aug 2026
  //     STK_260819               stock report
  //
  // Three rules, and each earns its place:
  //
  //  1. **A short code first**, never a spelled-out phrase. Typing "DC_"
  //     finds every challan; "Delivery_Challan_" is 17 characters of prefix
  //     repeated on every file, which pushes the part that actually
  //     distinguishes them past the width of a file-manager column.
  //  2. **The document's own number next**, because that is what someone
  //     searches for when they are holding a paper copy.
  //  3. **A date ONLY where the date is the identity.** A purchase order is
  //     identified by its number, so stamping today's date on it is both
  //     noise and a small lie -- it is the day it was downloaded, not the
  //     day it was raised. Reports and ledgers have no number of their own,
  //     so for those the date is the whole identity.
  //
  // Every segment is capped, so a vendor named "Shri Balaji Cycle and
  // Rickshaw Parts Manufacturing Company Private Limited" cannot produce a
  // filename nobody can read.
  DOC_TYPES: {
    PO: 'Purchase Order',
    GRN: 'Goods Receipt',
    DC: 'Delivery Challan',
    ISS: 'Stock Issue Receipt',
    RET: 'Return Note',
    ILG: 'Item Ledger',
    VLG: 'Vendor Ledger',
    CLG: 'Client Ledger',
    KLG: 'Contractor Ledger',
    BOM: 'BOM Cost Sheet',
    PRC: 'Process Sheet',
    PRD: 'Production Sheet',
    WO: 'Work Order',
    STK: 'Stock Report',
    WHP: 'Warehouse Pool Report',
    LOW: 'Low Stock Report'
  },

  DOC_KEY_MAX: 18,
  DOC_PARTY_MAX: 16,

  // A party name reduced to something recognisable: the first word, plus the
  // second only when both fit whole. "Mahadev industries" -> "Mahadev",
  // "Shri Balaji Cycle and Rickshaw Parts" -> "ShriBalaji".
  //
  // Never truncates mid-word to reach the cap. "Mahadevindustrie" reads like
  // a typo and is no more distinct than "Mahadev"; a name that is recognisably
  // one word beats a name that is 16 characters long.
  _docParty(text) {
    const raw = String(text || '').trim();
    const words = raw
      .replace(/[^a-zA-Z0-9\s]/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    if (!words.length) {
      // Names written wholly in Gurmukhi or Devanagari -- ordinary for
      // vendors and items here -- have no Latin characters at all. Dropping
      // the segment would make every such vendor's ledger share one filename,
      // so a short stable tag of the original keeps them distinct. Not
      // pretty, but a name nobody can tell apart is worse.
      return raw ? `x${this._docTag(raw)}` : '';
    }

    const first = words[0].slice(0, this.DOC_PARTY_MAX);
    if (words[1] && first.length + words[1].length <= this.DOC_PARTY_MAX) {
      return first + words[1];
    }
    return first;
  },

  // Four hex characters, stable for a given string. Only used to keep
  // otherwise-identical names apart.
  _docTag(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(16).slice(-4).padStart(4, '0');
  },

  // YYMMDD. Accepts a Date, an ISO string, or the dd/mm/yyyy the ledgers
  // display; anything unparseable falls back to today rather than emitting
  // a wrong date.
  _docDate(value) {
    let d;
    if (value instanceof Date) {
      d = value;
    } else if (typeof value === 'string' && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(value)) {
      const [dd, mm, yyyy] = value.split('/');
      d = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
    } else if (value) {
      d = new Date(value);
    } else {
      d = new Date();
    }
    if (isNaN(d.getTime())) d = new Date();

    const pad = n => String(n).padStart(2, '0');
    return `${String(d.getFullYear()).slice(-2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  },

  // Builds a name from { type, key, party, date }. `date` is opt-in: pass
  // true for "today", a Date/string for a specific day, or omit it for
  // documents that carry their own number.
  //
  // Returns the stem WITHOUT ".pdf" -- it doubles as the print title, where
  // an extension would be wrong.
  docName({ type, key = '', party = '', date = null } = {}) {
    if (!this.DOC_TYPES[type]) {
      console.warn('[Print] Unknown document type code:', type);
    }

    const segments = [type || 'DOC'];

    // Drop a prefix the key already repeats: dispatch numbers arrive as
    // "DC-1041", which would otherwise name the file "DC_DC-1041".
    let cleanKey = this.sanitizeFilename(String(key), false);
    const repeated = new RegExp(`^${type}[-_]?`, 'i');
    if (type && repeated.test(cleanKey)) cleanKey = cleanKey.replace(repeated, '');
    cleanKey = cleanKey.slice(0, this.DOC_KEY_MAX);

    if (key && cleanKey && cleanKey !== 'Document') segments.push(cleanKey);

    const cleanParty = this._docParty(party);
    if (cleanParty) segments.push(cleanParty);

    if (date) segments.push(this._docDate(date === true ? null : date));

    return segments.join('_');
  },

  // The same name with the extension, for download filenames.
  docFilename(spec) {
    return `${this.docName(spec)}.pdf`;
  },

  // ── The one print path ───────────────────────────────────────
  //
  // Reveals `containerId`, names the job, prints, and restores. Everything
  // else in the app funnels through here.
  //
  // options.landscape - print this one job in landscape (Production Sheet).
  trigger(containerId, documentTitle, options = {}) {
    // Ensure no other print template is left active from a
    // previous job before showing this one.
    this.hideAll();
    this.injectLogo();

    const container = document.getElementById(containerId);
    if (container) {
      container.classList.add('active-print');
      container.style.display = 'block';
    } else {
      console.warn('[Print] Print container not found:', containerId);
    }

    // Size the document to the page before the dialog opens. Returns the
    // column count so `landscape: 'auto'` can act on it -- the widest
    // documents (the stock pivot grows one column per size) are better
    // rotated than shrunk.
    const columns = this.fitToPage(container);
    const landscape = options.landscape === 'auto'
      ? columns > this.AUTO_LANDSCAPE_COLUMNS
      : !!options.landscape;

    const originalTitle = document.title;
    document.title = this.titleToFilename(documentTitle);
    this.setPageOrientation(landscape);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      document.title = originalTitle;
      this.clearPageOrientation();
      // Put back exactly what this call revealed, by reference, before the
      // general sweep. Reveal and restore must be symmetric: hideAll() works
      // off selectors, so if the markup does not carry the expected class it
      // matches nothing and the container stays visible over the whole app.
      // Hiding the element we were handed cannot fail that way.
      if (container) {
        container.classList.remove('active-print');
        container.classList.remove(...this.fitClassNames());
        container.style.display = 'none';
      }
      this.hideAll();
      window.removeEventListener('afterprint', cleanup);
    };

    window.addEventListener('afterprint', cleanup);
    window.print();
    // Fallback for browsers/sandboxes that never fire 'afterprint'
    setTimeout(cleanup, 1000);
  },

  // ── Downloading a file, rather than opening a dialog ─────────
  //
  // window.print() cannot hand back a file: one dialog produces one document,
  // which is why "export these 40 challans as 40 named PDFs" has no
  // expression in it. These two functions POST the SAME HTML the builders
  // already produce to a renderer that returns bytes, so there is still only
  // one definition of every document.
  //
  // Strictly an upgrade path. When the server cannot render -- offline, or
  // deployed without WeasyPrint's system libraries -- they fall back to the
  // print dialog, which still produces a searchable PDF with no network. The
  // output is never worse, only less convenient.
  SERVER_PDF_URL: '/erp/render-pdf',
  SERVER_PDF_BATCH_URL: '/erp/render-pdf-batch',

  // null = not tried yet; false = settled for this session. Only a 503 (this
  // deployment cannot render) or a failed fetch (offline) latches it false. A
  // per-document 4xx/5xx does not -- the next document may be fine.
  serverPdfAvailable: null,

  _csrfToken() {
    return typeof document?.querySelector === 'function'
      ? (document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '')
      : '';
  },

  // POSTs `body` and returns a Blob, or null when this server cannot render.
  async _postForBlob(url, body) {
    if (this.serverPdfAvailable === false) return null;

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRFToken': this._csrfToken() },
        credentials: 'same-origin',
        body: JSON.stringify(body)
      });
    } catch (err) {
      // Never completed: offline, or the server is unreachable.
      this.serverPdfAvailable = false;
      return null;
    }

    if (res.status === 503) {
      this.serverPdfAvailable = false;
      return null;
    }
    if (!res.ok) {
      console.warn('[PDF] server render failed:', res.status);
      return null;
    }
    this.serverPdfAvailable = true;
    return await res.blob();
  },

  // Hands a Blob to the browser as a download under `filename`.
  saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke on a later turn: revoking synchronously can cancel the download
    // in some browsers before they have read the blob.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  },

  // The archive is named like the documents inside it: CODE_YYMMDD.zip,
  // e.g. "PO_260819.zip". It used to be <Long_Prefix>_<DDMMYY>.zip, which
  // disagreed with the files it contained on both counts -- and DDMMYY does
  // not sort, so a folder of exports came out in day-of-month order.
  bulkZipName(type) {
    return `${type}_${this._docDate()}.zip`;
  },

  // A Download button downloads. It does NOT quietly become a print dialog.
  //
  // Falling back to window.print() was the earlier behaviour and it was
  // wrong: the user asked for a file, and a print dialog is not a file -- it
  // is a different task with a different outcome, appearing without warning.
  // When the renderer is unreachable the honest answer is to say so and name
  // the alternative, leaving the choice with the person who pressed the
  // button.
  reportDownloadUnavailable() {
    App.Utils.showToast(
      'Could not reach the PDF renderer, so nothing was downloaded. ' +
      'Use Print to save this document through the print dialog instead.',
      true
    );
  },

  // Relabels the button that started an export while it runs, then puts it
  // back. Reuses the element the user is already looking at rather than
  // adding markup, and keeps progress out of showToast -- which also feeds
  // App.Notify and would leave a notification behind for every export.
  async _whileBusy(buttonId, label, work) {
    const btn = buttonId ? document.getElementById(buttonId) : null;
    const html = btn ? btn.innerHTML : null;
    const disabled = btn ? btn.disabled : false;
    if (btn) {
      btn.disabled = true;
      btn.innerHTML =
        '<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>' + label;
    }
    try {
      return await work();
    } finally {
      if (btn) {
        btn.innerHTML = html;
        btn.disabled = disabled;
      }
    }
  },

  // One document, downloaded as a file. `onFallback` runs when the server
  // cannot render -- pass the module's own print call.
  async downloadOne(bodyHtml, filename, options = {}) {
    const { landscape = false, buttonId = null } = options;
    const name = filename.toLowerCase().endsWith('.pdf') ? filename : `${filename}.pdf`;

    const density = this.fitDensityFor(bodyHtml);
    const blob = await this._whileBusy(buttonId, 'Preparing…', () =>
      this._postForBlob(this.SERVER_PDF_URL, {
        html: bodyHtml, landscape, density, filename: name
      })
    );

    if (blob) {
      this.saveBlob(blob, name);
      return true;
    }
    this.reportDownloadUnavailable();
    return false;
  },

  // Downloads whatever is currently inside a print container.
  //
  // The single-record documents (Purchase Order, Low Stock, Production Sheet)
  // are populated into print.html's static templates rather than built as an
  // HTML string, so this reads back the markup the print engine would have
  // printed. Same document, same source -- populate the container, then call
  // this instead of trigger().
  async downloadContainer(containerId, filename, options = {}) {
    const el = document.getElementById(containerId);
    if (!el) {
      console.warn('[PDF] Print container not found:', containerId);
      return false;
    }
    return this.downloadOne(el.innerHTML, filename, options);
  },

  // N documents, saved as N separately-named PDFs -- one file per record,
  // straight to the download folder. This is the whole reason a server
  // renderer exists here: a print dialog produces one document, and "these 40
  // challans as 40 files" has no expression in it.
  //
  // Rendered in ONE request (the server returns an archive) and then unpacked
  // client-side, rather than one request per record: the earlier design made
  // N round trips with a deliberate pause between them.
  //
  // Note for the caller: Chrome and Edge prompt once per origin for
  // "automatic downloads" the first time a batch saves more than one file. If
  // that prompt is dismissed the browser drops the rest silently, so the
  // count in the toast is what was handed over, not what landed.
  async downloadMany(documents, zipName, options = {}) {
    const { buttonId = null } = options;
    if (!documents || !documents.length) return false;

    // Per document, not per batch: a 40-challan export is uniform, but an
    // export mixing a 6-column challan with a 16-column pivot is not, and
    // shrinking the challan to match the pivot would be wrong.
    const sized = documents.map(doc => Object.assign({}, doc, {
      density: doc.density || this.fitDensityFor(doc.html)
    }));

    const blob = await this._whileBusy(
      buttonId, `Preparing ${documents.length}…`, () =>
        this._postForBlob(this.SERVER_PDF_BATCH_URL, { documents: sized, zipName })
    );

    if (!blob) {
      this.reportDownloadUnavailable();
      return false;
    }

    const files = await this.unzip(blob);
    if (!files.length) {
      App.Utils.showToast('The renderer returned nothing to download.', true);
      return false;
    }

    files.forEach(file => this.saveBlob(file.blob, file.name));
    App.Utils.showToast(
      `${files.length} PDF${files.length === 1 ? '' : 's'} downloaded.`, false);
    return true;
  },

  // Reads a store-only ZIP into [{ name, blob }].
  //
  // Only STOREd entries appear here -- the server writes the archive with
  // ZIP_STORED because a PDF's own streams are already compressed -- so this
  // needs no inflate, which is what keeps it to a few lines instead of a
  // vendored library. A DEFLATEd entry is skipped rather than silently
  // handed over as corrupt bytes.
  async unzip(blob) {
    const view = new DataView(await blob.arrayBuffer());
    const bytes = new Uint8Array(view.buffer);
    const decoder = new TextDecoder();
    const files = [];

    let i = 0;
    while (i + 30 <= bytes.length && view.getUint32(i, true) === 0x04034B50) {
      const method = view.getUint16(i + 8, true);
      const size = view.getUint32(i + 18, true);
      const nameLen = view.getUint16(i + 26, true);
      const extraLen = view.getUint16(i + 28, true);
      const nameAt = i + 30;
      const dataAt = nameAt + nameLen + extraLen;

      if (method === 0) {
        files.push({
          name: decoder.decode(bytes.subarray(nameAt, nameAt + nameLen)),
          blob: new Blob([bytes.subarray(dataAt, dataAt + size)], { type: 'application/pdf' })
        });
      } else {
        console.warn('[PDF] skipping compressed archive entry; expected STORE');
      }
      i = dataAt + size;
    }
    return files;
  },

  // Renders one self-contained "page" per record (via buildPageHtml) into
  // the shared bulk container, separated by page breaks. Split out from
  // triggerBulk so a preview can reuse the same markup without also
  // firing window.print().
  renderBulkPages(records, buildPageHtml) {
    const body = document.getElementById('print-bulk-body');
    if (!body) return;

    body.innerHTML = records.map((record, idx) => {
      const pageStyle = idx < records.length - 1
        ? 'page-break-after:always;break-after:page;'
        : '';
      return `<div class="bulk-print-page" style="${pageStyle}">${buildPageHtml(record)}</div>`;
    }).join('');
  },

  // Renders one self-contained "page" per record (via buildPageHtml)
  // into the shared bulk container, separated by page breaks, then
  // prints them all as a single multi-page job.
  //
  // This is what both "Print Selected" and "Download PDFs" reach. The latter
  // used to produce one separately-named PDF per record, which window.print()
  // cannot do -- one dialog produces one document. The records still each get
  // their own page; they arrive in one file.
  triggerBulk(records, buildPageHtml, documentTitle, options = {}) {
    this.renderBulkPages(records, buildPageHtml);
    this.trigger('print-bulk-container', documentTitle, options);
  }
};
