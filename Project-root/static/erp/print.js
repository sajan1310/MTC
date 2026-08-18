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

  // Renders and downloads one PDF per record instead of merging every
  // record into a single file: each record gets its own render pass into
  // print-bulk-container (so buildPageHtml never has to know it's the
  // only page) followed by its own downloadElementAsPDF call. Downloads
  // are sequential -- concurrent html2pdf runs would fight over the same
  // shared container -- so this awaits each one before starting the next.
  // filenameForRecord(record) must return that record's .pdf filename.
  //
  // Filenames are de-duplicated across the batch. Two records can easily want
  // the same name -- sanitizeFilename maps every non-Latin name onto its
  // 'Document' fallback, and its 50-char cap can collapse two long names that
  // differ only past that point -- and a browser handed the same name twice
  // either silently overwrites or appends its own "(1)", so a 5-record export
  // can quietly deliver fewer than 5 distinct documents.
  //
  // options: { pdfOverrides, progressButtonId }. Pass the id of the button that
  // triggered the export and it doubles as the progress indicator -- disabled
  // and relabelled "Exporting 3 of 12…", restored afterwards. That reuses the
  // element the user is already looking at rather than adding markup, and it
  // keeps progress out of showToast, which also feeds the notification centre
  // (App.Notify) and would leave one entry per record behind.
  //
  // Returns the number of PDFs GENERATED, which is not necessarily the number
  // delivered: html2pdf's .save() resolves once it hands the blob to the
  // browser and cannot observe what happened next. Chrome and Edge prompt once
  // per origin for "automatic downloads" after the first file, and if that is
  // denied the rest are dropped with no signal available here. See
  // reportBulkResult for how that is worded, and PDF-005 for the delivery-
  // confirming alternatives (folder picker / single ZIP) still on the table.
  async downloadSeparatePDFs(records, buildPageHtml, filenameForRecord, options = {}) {
    const { pdfOverrides = {}, progressButtonId = null } = options;
    const used = new Set();
    const total = records.length;

    const btn = progressButtonId ? document.getElementById(progressButtonId) : null;
    const btnHtml = btn ? btn.innerHTML : null;
    const btnDisabled = btn ? btn.disabled : false;

    let generated = 0;
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
          // straight from its original text to "done" with nothing in between.
          // This is NOT a workaround for the download prompt above -- a delay
          // does not grant user activation.
          await new Promise(r => setTimeout(r, this.BULK_EXPORT_YIELD_MS));
        }
        this.renderBulkPages([records[i]], buildPageHtml);
        const filename = this.uniqueFilename(filenameForRecord(records[i]), used);
        const ok = await this.downloadElementAsPDF('print-bulk-container', filename, pdfOverrides);
        if (ok) generated++;
      }
    } finally {
      if (btn) {
        btn.innerHTML = btnHtml;
        btn.disabled = btnDisabled;
      }
    }
    return generated;
  },

  // Long enough for the relabelled button to paint, short enough to be
  // invisible next to a rasterisation pass that costs far more than this.
  BULK_EXPORT_YIELD_MS: 120,

  // Shared completion message for every bulk export, so all eight callers word
  // partial failure the same way instead of each claiming total success.
  // "generated" rather than "exported" or "downloaded" is deliberate: it is the
  // strongest claim this code can actually support (see downloadSeparatePDFs).
  reportBulkResult(generated, total, noun) {
    const plural = n => `${noun}${n === 1 ? '' : 's'}`;
    if (!generated) {
      App.Utils.showToast(`Could not generate any ${plural(total)}.`, true);
    } else if (generated < total) {
      App.Utils.showToast(
        `Generated ${generated} of ${total} ${plural(total)} — ${total - generated} failed.`,
        true
      );
    } else {
      App.Utils.showToast(`${generated} ${plural(generated)} generated.`, false);
    }
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

  // Captures elementId's current content as a downloaded PDF. Shared by
  // every "Download PDF" button so the html2canvas offset/clipping fixes
  // (move the element to the document origin so preceding siblings and
  // scroll position can't clip it, capture, then put it back exactly where
  // it was) only need to be maintained in one place. Returns true/false
  // instead of throwing -- callers decide their own success messaging, but
  // a failure is always toasted here since the cause (library/network) is
  // the same for every caller. `captureWidthPx` is OURS, not html2pdf's --
  // it is pulled out of the overrides below rather than forwarded, so a
  // landscape caller can lay the element out at the rotated page width
  // instead of the portrait default. Everything else in pdfOverrides goes
  // straight to html2pdf.
  async downloadElementAsPDF(elementId, filename, pdfOverrides = {}) {
    const element = document.getElementById(elementId);
    if (!element) {
      console.warn('[PDF] Print container not found:', elementId);
      return false;
    }

    const { captureWidthPx, ...html2pdfOverrides } = pdfOverrides;
    const captureWidth = captureWidthPx || this.PAGE_WIDTH_PX;

    if (!(await this.ensureHtml2Pdf())) return false;

    try {
      if (document.fonts?.ready) await document.fonts.ready;
    } catch (err) {
      console.warn('[PDF] Font loading check failed:', err);
    }

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
      await window.html2pdf()
        .set(Object.assign({
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
          // print.html) gets the same protection -- without it a
          // container's plain border-bottom has no size of its own to
          // defend against the guillotine, so it could land squeezed flush
          // against whatever row happened to fall near a slice boundary.
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
        }, html2pdfOverrides))
        .from(element)
        .save();
      return true;
    } catch (err) {
      console.error('[PDF] Generation failed:', err);
      App.Utils.showToast(err instanceof Error ? err.message : 'Failed to export PDF.', true);
      return false;
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
  }
};
