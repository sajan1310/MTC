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

  // Renders one self-contained "page" per record (via buildPageHtml)
  // into the shared bulk container, separated by page breaks, then
  // prints them all as a single multi-page job.
  triggerBulk(records, buildPageHtml, documentTitle) {
    const body = document.getElementById('print-bulk-body');
    if (!body) return;

    body.innerHTML = records.map((record, idx) => {
      const pageStyle = idx < records.length - 1
        ? 'page-break-after:always;break-after:page;'
        : '';
      return `<div class="bulk-print-page" style="${pageStyle}">${buildPageHtml(record)}</div>`;
    }).join('');

    this.trigger('print-bulk-container', documentTitle);
  }
};
