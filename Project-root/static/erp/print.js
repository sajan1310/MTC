'use strict';
// print.js -- App.Print, ported from Apps_Script/Script_Print.html.
//
// Every module's print/printCurrent/bulkPrint function across all 19
// prior rounds already calls into this module (App.Print.trigger /
// App.Print.triggerBulk / App.Print.brandHeaderHtml), guarded behind
// `typeof App.Print === 'undefined'`. Loading this file is what turns
// every one of those guarded call sites live -- no changes needed in
// any other module's JS for this round.

App.Print = {
  // ── Canonical A4 page geometry ───────────────────────────────
  // Single source of truth for every export path. The margin must stay in
  // step with the @page rule in styles.css so window.print() and the
  // downloaded PDF line up. PAGE_WIDTH_PX is the width the element is laid
  // out at before html2canvas captures it, and is what any fit/measure loop
  // must measure against.
  PAGE_MARGIN_MM: 6,
  get PAGE_WIDTH_PX() { return Math.floor((210 - 2 * this.PAGE_MARGIN_MM) * 96 / 25.4); },
  get PAGE_HEIGHT_PX() { return Math.floor((297 - 2 * this.PAGE_MARGIN_MM) * 96 / 25.4); },

  CONTAINER_IDS: [
    'print-po-container',
    'print-item-ledger-container',
    'print-vendor-ledger-container',
    'print-client-ledger-container',
    'print-contractor-ledger-container',
    'print-production-sheet-container',
    'print-low-stock-container',
    'print-bill-container',
    'print-bom-container',
    'print-dispatch-container',
    'print-bulk-container'
  ],

  hideAll() {
    this.CONTAINER_IDS.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.classList.remove('active-print');
        el.style.display = 'none';
      }
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

  trigger(containerId, documentTitle) {
    // Ensure no other print template is left active from a
    // previous job before showing this one.
    this.hideAll();
    this.injectLogo();

    const container = document.getElementById(containerId);
    if (container) {
      container.classList.add('active-print');
      container.style.display = 'block';
    }

    const originalTitle = document.title;
    document.title = documentTitle;

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      document.title = originalTitle;
      this.hideAll();
      window.removeEventListener('afterprint', cleanup);
    };

    window.addEventListener('afterprint', cleanup);
    window.print();
    // Fallback for browsers/sandboxes that never fire 'afterprint'
    setTimeout(cleanup, 1000);
  },

  // Renders one self-contained "page" per record (via buildPageHtml) into
  // the shared bulk container, separated by page breaks. Split out from
  // triggerBulk so a PDF export can reuse the same markup without also
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
  triggerBulk(records, buildPageHtml, documentTitle) {
    this.renderBulkPages(records, buildPageHtml);
    this.trigger('print-bulk-container', documentTitle);
  },

  // Shared filename sanitizer for every module's per-record PDF filenames
  // (bulk "Download PDFs" and single-record downloads alike).
  //
  // The 50-char cap and the 'Document' fallback both matter and must stay.
  // The pattern strips everything outside [a-zA-Z0-9_-], which means a name
  // written wholly in Gurmukhi or Devanagari -- ordinary for vendors and items
  // here -- sanitizes to the empty string, not to a short name. Without the
  // fallback that yields "Item_Ledger_.pdf"; see also the de-duplication in
  // downloadSeparatePDFs, since one fallback name cannot distinguish several
  // such records in the same export.
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

  // Exports one PDF per record instead of merging them into a single file:
  // each record gets its own render pass into print-bulk-container (so
  // buildPageHtml never has to know it is the only page) and its own output.
  // Records are processed sequentially -- concurrent html2pdf runs would fight
  // over that one shared container -- so this awaits each before the next.
  // filenameForRecord(record) must return that record's .pdf filename.
  //
  // Filenames are de-duplicated across the batch. Two records can easily want
  // the same name -- sanitizeFilename maps every non-Latin name onto its
  // 'Document' fallback, and its 50-char cap can collapse two long names that
  // differ only past that point -- and a browser handed the same name twice
  // either silently overwrites or appends its own "(1)", so a 5-record export
  // can quietly deliver fewer than 5 distinct documents.
  //
  // options:
  //   destination      - from chooseBulkDestination: folder / zip / files.
  //                      Defaults to files, the mode every browser can do.
  //   progressButtonId - the button that triggered the export, reused as the
  //                      progress indicator: disabled and relabelled
  //                      "Exporting 3 of 12…", then restored. Reuses the
  //                      element the user is already looking at rather than
  //                      adding markup, and keeps progress out of showToast,
  //                      which also feeds App.Notify and would otherwise leave
  //                      one notification per record behind.
  //   zipName          - archive name, zip mode only.
  //   pdfOverrides     - forwarded to each export (see _pdfOptions).
  //
  // Returns { generated, delivered, mode, zipName }. The two counts differ by
  // mode, and only 'folder' can prove delivery: there each write resolves or
  // throws. In 'files' mode delivered merely counts handoffs, because
  // html2pdf's .save() resolves once the blob is passed to the browser and
  // cannot observe what happened next -- Chrome and Edge prompt once per
  // origin for "automatic downloads" and silently drop the rest if denied.
  // reportBulkResult words the outcome accordingly.
  async deliverSeparatePDFs(records, buildPageHtml, filenameForRecord, options = {}) {
    const {
      pdfOverrides = {},
      progressButtonId = null,
      destination = { mode: 'files' },
      zipName = 'Documents.zip'
    } = options;

    const mode = destination.mode;
    const used = new Set();
    const total = records.length;
    const forZip = [];

    const btn = progressButtonId ? document.getElementById(progressButtonId) : null;
    const btnHtml = btn ? btn.innerHTML : null;
    const btnDisabled = btn ? btn.disabled : false;

    let generated = 0;
    let delivered = 0;
    // Whether any record came out of the client's raster renderer rather than
    // the server's. Drives the one-time "use Print for a searchable PDF" tip.
    let rasterised = false;
    try {
      if (btn) btn.disabled = true;
      for (let i = 0; i < total; i++) {
        if (btn) {
          btn.innerHTML =
            '<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>' +
            `Exporting ${i + 1} of ${total}…`;
          // Yield so that label actually paints. Each record's html2canvas pass
          // occupies the main thread for a noticeable stretch, and without a
          // turn of the event loop between iterations the button would jump
          // straight from its original text to "done". This is NOT a
          // workaround for the multi-download prompt -- a delay does not grant
          // user activation.
          await new Promise(r => setTimeout(r, this.BULK_EXPORT_YIELD_MS));
        }
        const filename = this.uniqueFilename(filenameForRecord(records[i]), used);

        // Vector first. renderViaServer returns null when the server cannot
        // render (offline, or no Chromium there), and every mode below then
        // falls through to the raster path unchanged -- so this is an upgrade
        // where it is available rather than a new dependency.
        const serverBlob = await this.renderViaServer(buildPageHtml(records[i]), pdfOverrides);
        if (serverBlob) {
          generated++;
          if (mode === 'folder') {
            if (await this._writeIntoFolder(destination.handle, filename, serverBlob)) delivered++;
          } else if (mode === 'zip') {
            forZip.push({ name: filename, blob: serverBlob });
          } else {
            this.saveBlob(serverBlob, filename);
            // Handed over, not confirmed -- see the note above the function.
            delivered++;
          }
          continue;
        }

        this.renderBulkPages([records[i]], buildPageHtml);
        rasterised = true;

        if (mode === 'files') {
          if (await this.downloadElementAsPDF('print-bulk-container', filename, pdfOverrides)) {
            generated++;
            delivered++;
          }
          continue;
        }

        const blob = await this.renderElementToPdfBlob('print-bulk-container', filename, pdfOverrides);
        if (!blob) continue;
        generated++;
        if (mode === 'folder') {
          if (await this._writeIntoFolder(destination.handle, filename, blob)) delivered++;
        } else {
          forZip.push({ name: filename, blob });
        }
      }

      if (mode === 'zip' && forZip.length) {
        if (btn) btn.innerHTML = 'Packaging…';
        this.saveBlob(await this.zipStore(forZip), zipName);
        delivered = forZip.length;
      }
    } finally {
      if (btn) {
        btn.innerHTML = btnHtml;
        btn.disabled = btnDisabled;
      }
    }
    return { generated, delivered, mode, zipName, rasterised };
  },

  // One write into the chosen folder. Returns whether it actually landed --
  // this is the only delivery path that can answer that honestly.
  async _writeIntoFolder(dirHandle, filename, blob) {
    try {
      const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (err) {
      console.error('[PDF] Could not write', filename, err);
      return false;
    }
  },

  // Long enough for the relabelled button to paint, short enough to be
  // invisible next to a rasterisation pass that costs far more than this.
  BULK_EXPORT_YIELD_MS: 120,

  // Above this many records, an unconfirmable pile of individual downloads is
  // worse than one ZIP: Chrome and Edge prompt once per origin for "automatic
  // downloads" and silently drop the rest if it is denied.
  ZIP_THRESHOLD: 5,

  // <prefix>_<ddmmyy>.zip, e.g. "Purchase_Orders_170826.zip" -- the same
  // naming the old merged-PDF export used, now that the ZIP is the thing
  // that holds a whole batch.
  bulkZipName(prefix) {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const ddmmyy = `${pad(now.getDate())}${pad(now.getMonth() + 1)}${String(now.getFullYear()).slice(-2)}`;
    return `${prefix}_${ddmmyy}.zip`;
  },

  // ── Choosing where a bulk export goes ────────────────────────────
  //
  // MUST be the first thing a click handler awaits. showDirectoryPicker()
  // requires live user activation, and activation does not survive an earlier
  // `await` -- several callers load data before exporting, so the picker has
  // to be opened before that work, not after it.
  //
  // Modes, best first:
  //   folder - File System Access API. Separate files, real filenames, and
  //            each write either succeeds or throws, so delivery is actually
  //            confirmable. One permission prompt for the whole batch.
  //   zip    - one download containing separate PDFs. No multi-download
  //            prompt, but the user has to unzip.
  //   files  - one download per PDF. What every browser can do, and what
  //            cannot be confirmed.
  async chooseBulkDestination(count) {
    if (count <= 1) return { mode: 'files' };

    if (typeof window.showDirectoryPicker === 'function') {
      try {
        const handle = await window.showDirectoryPicker({
          id: 'erp-bulk-pdf-export',
          mode: 'readwrite',
          startIn: 'downloads'
        });
        return { mode: 'folder', handle };
      } catch (err) {
        // AbortError is the user closing the picker -- that is a cancellation
        // of the whole export, not a reason to fall back to a noisier mode.
        if (err && err.name === 'AbortError') return { mode: 'cancelled' };
        console.warn('[PDF] Folder picker unavailable, falling back:', err);
      }
    }

    return { mode: count > this.ZIP_THRESHOLD ? 'zip' : 'files' };
  },


  // ── The searchable-PDF route that needs nothing installed ────────
  //
  // When PDFs come from the client's raster renderer they are images: a PO
  // cannot be searched for its own number and nothing can be copied out of it.
  // The browser's own print engine does produce a real document, and every
  // module already has a Print button wired to it (App.Print.trigger sets
  // document.title, which Chrome and Edge use as the default Save-as-PDF
  // filename) -- so the capability is already there, it just isn't obvious.
  //
  // Told once per browser, not once per export. A tip repeated after every
  // download is nagging, and people stop reading toasts that always appear.
  SEARCHABLE_HINT_KEY: 'erp.pdfSearchableHintShown',

  hintSearchablePdfOnce() {
    let alreadyShown = false;
    try {
      alreadyShown = window.localStorage.getItem(this.SEARCHABLE_HINT_KEY) === '1';
    } catch (err) {
      // Private mode / storage disabled: skip the hint rather than risk
      // showing it after every single export.
      return;
    }
    if (alreadyShown) return;
    try {
      window.localStorage.setItem(this.SEARCHABLE_HINT_KEY, '1');
    } catch (err) {
      return;
    }
    App.Utils.showToast(
      'Tip: these PDFs are images. For a searchable PDF, use Print and choose ' +
      '"Save as PDF" in the print dialog.',
      false
    );
  },

  // Shared completion message for every bulk export, so all eight callers word
  // partial failure the same way instead of each claiming total success.
  //
  // The verb tracks what the delivery mode can actually prove:
  //   folder - "saved", because each write either succeeded or threw.
  //   zip    - "packaged into <name>", true regardless of what the browser
  //            then does with the single download.
  //   files  - "generated", the ceiling for this path: .save() resolves on
  //            handoff and cannot see whether the file landed.
  // result comes from deliverSeparatePDFs: { generated, delivered, mode, zipName }.
  reportBulkResult(result, total, noun) {
    const { generated, delivered, mode, zipName } = result;
    const plural = n => `${noun}${n === 1 ? '' : 's'}`;

    if (!generated) {
      App.Utils.showToast(`Could not generate any ${plural(total)}.`, true);
      return;
    }
    if (generated < total) {
      App.Utils.showToast(
        `Generated ${generated} of ${total} ${plural(total)} — ${total - generated} failed.`,
        true
      );
      return;
    }
    // Everything rendered, but folder writes can still fail individually.
    if (mode === 'folder' && delivered < generated) {
      App.Utils.showToast(
        `Generated ${generated} ${plural(generated)} but only ${delivered} could be saved.`,
        true
      );
      return;
    }
    if (mode === 'folder') {
      App.Utils.showToast(`${delivered} ${plural(delivered)} saved to the selected folder.`, false);
    } else if (mode === 'zip') {
      App.Utils.showToast(`${delivered} ${plural(delivered)} packaged into ${zipName}.`, false);
    } else {
      App.Utils.showToast(`${generated} ${plural(generated)} generated.`, false);
    }

    // Only where the output actually is an image. If the server rendered these
    // they are already searchable and the tip would be wrong.
    if (result.rasterised) this.hintSearchablePdfOnce();
  },

  // ── ZIP (store-only) ─────────────────────────────────────────────
  // A minimal ZIP writer, ~90 lines, rather than another vendored library.
  // Every entry is STOREd, not deflated, which costs nothing here: a PDF's
  // own streams are already deflate-compressed, so re-compressing them buys
  // almost no bytes for a lot of CPU on the main thread.
  //
  // Deliberately narrow. No directories, no ZIP64, no encryption. ZIP64 would
  // only be needed past 4 GB or 65,535 entries, and a bulk export that large
  // has worse problems than its container format.

  _CRC_TABLE: null,

  _crc32(bytes) {
    if (!this._CRC_TABLE) {
      const t = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        t[i] = c >>> 0;
      }
      this._CRC_TABLE = t;
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      crc = this._CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  },

  // MS-DOS packed date/time, which is what the ZIP format stores.
  _dosDateTime(d) {
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    };
  },

  // files: [{ name, blob }] -> a single application/zip Blob.
  async zipStore(files) {
    const enc = new TextEncoder();
    const { time, date } = this._dosDateTime(new Date());
    const parts = [];
    const central = [];
    let offset = 0;

    for (const file of files) {
      const nameBytes = enc.encode(file.name);
      const data = new Uint8Array(await file.blob.arrayBuffer());
      const crc = this._crc32(data);

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034B50, true);   // local file header signature
      local.setUint16(4, 20, true);           // version needed to extract (2.0)
      local.setUint16(6, 0x0800, true);       // flag bit 11: filename is UTF-8
      local.setUint16(8, 0, true);            // method 0 = stored
      local.setUint16(10, time, true);
      local.setUint16(12, date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true); // compressed size == raw size
      local.setUint32(22, data.length, true);
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);           // no extra field
      parts.push(new Uint8Array(local.buffer), nameBytes, data);

      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014B50, true);      // central directory signature
      cd.setUint16(4, 20, true);              // version made by
      cd.setUint16(6, 20, true);              // version needed
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true);
      cd.setUint16(12, time, true);
      cd.setUint16(14, date, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, data.length, true);
      cd.setUint32(24, data.length, true);
      cd.setUint16(28, nameBytes.length, true);
      cd.setUint16(30, 0, true);              // extra length
      cd.setUint16(32, 0, true);              // comment length
      cd.setUint16(34, 0, true);              // disk number start
      cd.setUint16(36, 0, true);              // internal attributes
      cd.setUint32(38, 0, true);              // external attributes
      cd.setUint32(42, offset, true);         // offset of local header
      central.push(new Uint8Array(cd.buffer), nameBytes);

      offset += 30 + nameBytes.length + data.length;
    }

    const centralSize = central.reduce((n, p) => n + p.length, 0);
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054B50, true);      // end of central directory
    eocd.setUint16(4, 0, true);               // this disk number
    eocd.setUint16(6, 0, true);               // disk with central directory
    eocd.setUint16(8, files.length, true);    // entries on this disk
    eocd.setUint16(10, files.length, true);   // total entries
    eocd.setUint32(12, centralSize, true);
    eocd.setUint32(16, offset, true);         // central directory offset
    eocd.setUint16(20, 0, true);              // comment length

    return new Blob([...parts, ...central, new Uint8Array(eocd.buffer)],
      { type: 'application/zip' });
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
    // Revoke on the next turn: revoking synchronously can cancel the download
    // in some browsers before it has read the blob.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  },

  // Returns `filename` unchanged the first time it is seen, then _2, _3, ...
  // for each repeat, recording every name it hands out in `used`. Matching is
  // case-insensitive because the filesystems these land on (Windows, macOS)
  // treat "PO_1_Acme.pdf" and "po_1_acme.pdf" as the same file.
  uniqueFilename(filename, used) {
    const dot = filename.lastIndexOf('.');
    const stem = dot > 0 ? filename.slice(0, dot) : filename;
    const ext = dot > 0 ? filename.slice(dot) : '';
    let candidate = filename;
    let n = 1;
    while (used.has(candidate.toLowerCase())) {
      n += 1;
      candidate = `${stem}_${n}${ext}`;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  },

  // ── Server-side vector rendering ─────────────────────────────────
  //
  // POSTs the same HTML the build*PrintPageHtml() builders already produce to
  // /erp/render-pdf, where headless Chromium renders it as a real document.
  // The client's own html2pdf path rasterises through html2canvas, so its
  // output is one flat JPEG: measured on a 15-line purchase order, 361 KB with
  // ZERO extractable characters against 48 KB and 1,184 characters here. A PO
  // cannot be searched for its own PO number, part numbers cannot be copied
  // out, and an archive of them is un-indexable. See PDF-002.
  //
  // Strictly an upgrade path: null means "could not", and the caller then uses
  // the raster renderer exactly as before. That is what keeps export working
  // offline, where this endpoint by definition cannot be reached.
  SERVER_PDF_URL: '/erp/render-pdf',

  // null = not yet tried, true/false = settled for this session. Only a 503
  // (server has no renderer) or a failed fetch (offline) flips it to false; a
  // per-document 4xx/5xx does not, since the next document may be fine.
  serverPdfAvailable: null,

  // True when the deployment has switched server rendering off on purpose
  // (PDF_SERVER_RENDER=off, surfaced as a meta tag by templates/erp/index.html).
  // Read once, lazily, and cached: with this set there is nothing to discover,
  // so the client should not spend even one request per session finding out.
  get serverPdfDisabledByConfig() {
    if (this._serverPdfOff === undefined) {
      this._serverPdfOff = typeof document?.querySelector === 'function' &&
        document.querySelector('meta[name="pdf-server-render"]')?.getAttribute('content') === 'off';
    }
    return this._serverPdfOff;
  },

  async renderViaServer(bodyHtml, pdfOverrides = {}) {
    if (this.serverPdfDisabledByConfig) return null;
    if (this.serverPdfAvailable === false) return null;
    if (!bodyHtml) return null;

    const landscape = pdfOverrides
      && pdfOverrides.jsPDF
      && pdfOverrides.jsPDF.orientation === 'landscape';
    const csrf = typeof document?.querySelector === 'function'
      ? (document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '')
      : '';

    let res;
    try {
      res = await fetch(this.SERVER_PDF_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf },
        credentials: 'same-origin',
        body: JSON.stringify({ html: bodyHtml, landscape: !!landscape })
      });
    } catch (err) {
      // The request never completed -- offline, or the server is unreachable.
      // Stop asking for the rest of the session rather than stalling once per
      // record of a 40-record export.
      this.serverPdfAvailable = false;
      return null;
    }

    if (res.status === 503) {
      // Deployed without Chromium. Permanent for this session.
      this.serverPdfAvailable = false;
      return null;
    }
    if (!res.ok) {
      // This one document failed; the next may not.
      console.warn('[PDF] server render failed for one document:', res.status);
      return null;
    }

    this.serverPdfAvailable = true;
    return await res.blob();
  },

  // Lazy-loads html2pdf.js (used by every module's "Download PDF" button)
  // on first use so it isn't fetched until actually needed.
  //
  // Served from our own origin, NOT a CDN. This used to fetch 0.10.1 from
  // cdnjs, which made every PDF export the one part of the app that could not
  // work offline: sw.js precaches print.js but deliberately never caches
  // third-party CDN assets, so the shell would load, tables would render,
  // Print (native window.print) would work, and only Download PDF would fail.
  // Same reason the bundle is fetched by the service worker's post-activate
  // warm step -- see sw.js WARM_URLS. Provenance/checksums/upgrade procedure:
  // static/erp/vendor/README.md.
  HTML2PDF_URL: '/static/erp/vendor/html2pdf.bundle.min.js',

  async ensureHtml2Pdf() {
    if (typeof window.html2pdf === 'function') return true;
    try {
      await loadScript(this.HTML2PDF_URL);
      return true;
    } catch (err) {
      console.error('[PDF] Failed to load html2pdf library:', err);
      App.Utils.showToast('PDF library failed to load. Please reload the page and try again.', true);
      return false;
    }
  },

  // html2pdf's option object for one export. Split out so the download and
  // blob paths cannot drift apart in page geometry or pagination.
  //
  // `captureWidthPx` is OURS, not html2pdf's -- callers pass it in
  // pdfOverrides and it is pulled out here rather than forwarded, so a
  // landscape caller can lay the element out at the rotated page width
  // instead of the portrait default. Everything else goes straight through.
  _pdfOptions(filename, html2pdfOverrides) {
    return Object.assign({
      margin: [this.PAGE_MARGIN_MM, this.PAGE_MARGIN_MM, this.PAGE_MARGIN_MM, this.PAGE_MARGIN_MM],
      filename,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: {
        scale: 2,
        useCORS: true,
        allowTaint: true,
        logging: false,
        scrollX: 0,
        scrollY: 0,
        backgroundColor: '#ffffff'
      },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      // avoid:['tr'] matters on any multi-page export. html2pdf works by
      // guillotining one tall canvas at exact page-height multiples, so
      // without this a row unlucky enough to straddle the cut is sliced
      // through the middle -- half its text at the bottom of one page,
      // half at the top of the next. Naming 'tr' makes html2pdf push the
      // whole row to the next page instead. The CSS
      // page-break-inside:avoid rules cannot do this job: they live in
      // @media print, which html2canvas (a screen-media renderer) never
      // applies.
      // .print-sheet-closing-accent (Production Sheet's own closing bar,
      // print.html) gets the same protection -- without it a container's
      // plain border-bottom has no size of its own to defend against the
      // guillotine, so it could land squeezed flush against whatever row
      // happened to fall near a slice boundary.
      //
      // The three #print-* ids are the PO document's closing blocks, kept
      // from po.js's now-deleted private copy of this function so that
      // deleting it changed no configuration. They appear to be inert in
      // practice: sweeping row counts until #print-signature genuinely
      // straddles a page boundary produces the same pagination with and
      // without them, so html2pdf's avoid does not seem to act on them the
      // way it does on 'tr'. They are preserved rather than dropped because
      // a refactor is the wrong place to also change behaviour, and they
      // cost nothing -- a selector that matches nothing in a given
      // container is simply skipped.
      pagebreak: {
        mode: ['css', 'legacy'],
        avoid: [
          'tr',
          '.print-sheet-closing-accent',
          '#print-grand-total-container',
          '#print-footer-meta',
          '#print-signature'
        ]
      }
    }, html2pdfOverrides);
  },

  // Lends `element` to html2canvas under the conditions it needs, runs
  // `capture(element)`, then puts everything back exactly as it was.
  //
  // html2canvas rasterises from the document origin, so an element sitting
  // below other content -- or on a scrolled page -- gets clipped. The fix is
  // to move it to the top of <body>, neutralise the body's own padding/margin
  // and overflow, lay it out at the exact capture width, and undo all of that
  // afterwards. Every export path shares this one copy so the restore logic
  // has a single home; the finally block is the part that matters, since
  // failing to restore leaves the app visibly broken.
  async _withElementPrepared(element, captureWidth, capture) {
    const prevStyle = element.getAttribute('style');
    const prevBodyPad = document.body.style.padding;
    const prevBodyMar = document.body.style.margin;
    const prevBodyOvf = document.body.style.overflow;
    const prevHtmlOverflow = document.documentElement.style.overflow;
    const originalParent = element.parentNode;
    const originalSibling = element.nextSibling;
    const prevScrollX = window.pageXOffset || document.documentElement.scrollLeft;
    const prevScrollY = window.pageYOffset || document.documentElement.scrollTop;

    window.scrollTo(0, 0);
    document.body.insertBefore(element, document.body.firstChild);
    document.body.style.padding = '0';
    document.body.style.margin = '0';
    document.body.style.overflow = 'visible';
    document.documentElement.style.overflow = 'visible';
    element.style.display = 'block';
    element.style.width = captureWidth + 'px';
    element.style.maxWidth = 'none';

    await new Promise(r => requestAnimationFrame(r));

    try {
      return await capture(element);
    } finally {
      window.scrollTo(prevScrollX, prevScrollY);
      document.body.style.padding = prevBodyPad;
      document.body.style.margin = prevBodyMar;
      document.body.style.overflow = prevBodyOvf;
      document.documentElement.style.overflow = prevHtmlOverflow;
      if (prevStyle !== null) {
        element.setAttribute('style', prevStyle);
      } else {
        element.removeAttribute('style');
      }
      if (originalParent) {
        if (originalSibling) {
          originalParent.insertBefore(element, originalSibling);
        } else {
          originalParent.appendChild(element);
        }
      }
    }
  },

  // Shared preamble for both export paths: resolve the element, load the
  // library, wait for fonts. Returns null when the export cannot proceed.
  async _prepareExport(elementId, pdfOverrides) {
    const element = document.getElementById(elementId);
    if (!element) {
      console.warn('[PDF] Print container not found:', elementId);
      return null;
    }
    if (!(await this.ensureHtml2Pdf())) return null;
    try {
      if (document.fonts?.ready) await document.fonts.ready;
    } catch (err) {
      console.warn('[PDF] Font loading check failed:', err);
    }
    const { captureWidthPx, ...html2pdfOverrides } = pdfOverrides;
    return { element, captureWidth: captureWidthPx || this.PAGE_WIDTH_PX, html2pdfOverrides };
  },

  // Captures elementId's current content and hands it to the browser as a
  // download. Returns true/false instead of throwing -- callers decide their
  // own messaging, but a failure is always toasted here since the cause
  // (library/network) is the same for every caller.
  //
  // Note "download" is as far as this can report: .save() resolves once the
  // blob is handed over and cannot observe whether the file landed. Where
  // delivery must be confirmed, use renderElementToPdfBlob and write the
  // bytes somewhere that reports back -- see deliverSeparatePDFs.
  async downloadElementAsPDF(elementId, filename, pdfOverrides = {}) {
    const prep = await this._prepareExport(elementId, pdfOverrides);
    if (!prep) return false;
    try {
      await this._withElementPrepared(prep.element, prep.captureWidth, el =>
        window.html2pdf()
          .set(this._pdfOptions(filename, prep.html2pdfOverrides))
          .from(el)
          .save()
      );
      return true;
    } catch (err) {
      console.error('[PDF] Generation failed:', err);
      // Not `instanceof Error`: html2canvas can reject with a DOMException,
      // which carries a message without being an Error, and an error
      // crossing a realm boundary fails the instanceof check too.
      App.Utils.showToast(err && err.message ? err.message : 'Failed to export PDF.', true);
      return false;
    }
  },

  // Same capture as downloadElementAsPDF, but returns the PDF as a Blob
  // instead of downloading it -- the input for the folder and ZIP delivery
  // modes, both of which need the bytes in hand. Returns null on failure.
  async renderElementToPdfBlob(elementId, filename, pdfOverrides = {}) {
    const prep = await this._prepareExport(elementId, pdfOverrides);
    if (!prep) return null;
    try {
      return await this._withElementPrepared(prep.element, prep.captureWidth, el =>
        window.html2pdf()
          .set(this._pdfOptions(filename, prep.html2pdfOverrides))
          .from(el)
          .outputPdf('blob')
      );
    } catch (err) {
      console.error('[PDF] Generation failed:', err);
      // Not `instanceof Error`: html2canvas can reject with a DOMException,
      // which carries a message without being an Error, and an error
      // crossing a realm boundary fails the instanceof check too.
      App.Utils.showToast(err && err.message ? err.message : 'Failed to export PDF.', true);
      return null;
    }
  }
};
