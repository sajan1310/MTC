'use strict';
// bill.js -- App.Bill, ported from Apps_Script/Script_Bill.html.
//
// Adaptations from source (documented, not silent):
// - saveBill/deleteBill/deleteBillsBulk use Api.mutate (not Api.call):
//   bill_service.py marks all three mutation=True, so rpc.py requires a
//   fresh X-Mutation-Id per call -- google.script.run needed no such
//   header, so source used a plain Api.call for these.
// - bulkDelete's deletedKeys handling is adapted to this backend's actual
//   response shape: bill_service.deleteBillsBulk returns
//   {deletedKeys: [{vendor, billNumber}, ...]} (objects), not the
//   "vendor|billNumber" strings source's Google-Sheets-backed version
//   returned -- billKey() is applied to each object to build the same
//   Set of string keys source expected.
// - print/printCurrent/bulkPrint are guarded against App.Print not
//   existing yet (print pages are their own later round); their builder
//   functions (populatePrintData, buildBillPrintPageHtml) are still
//   ported in full as currently-unreachable dead code.
// - suggestPoAllocations and checkStockAdjustmentConflicts are both
//   already-shipped backend RPCs (po_service.py / stock_service.py), so
//   runAutoMatch/the stock-conflict pre-save check are ported in full,
//   not guarded -- this is the module that finally makes
//   App.Utils.getPendingByItem's App.Bill._getBilledQty call (guarded
//   since Round 1) execute for real.

App.Bill = {
  // Mirrors App.Item.ensureLoaded -- lets a caller outside the Bill Ledger
  // tab (e.g. the Vendor Profile modal's Ledger tab, PO's narration
  // suggestions) guarantee globalBills is populated without re-fetching if
  // Bill Ledger already loaded it.
  async ensureLoaded() {
    if (App.State.globalBills && App.State.globalBills.length) return;
    await this.loadData();
  },

  // Shows the "this bill may double-count Stock" choice modal and
  // resolves to the user's decision: 'update' (bill affects Stock
  // normally), 'ledger' (bill is saved but excluded from Stock's Billed
  // Qty sum), or 'cancel' (dismissed without choosing -- abort the whole
  // save). Only shown when checkStockAdjustmentConflicts actually finds
  // a conflict; see the billForm submit handler below.
  showStockConflictChoice(conflicts) {
    return new Promise(resolve => {
      const listEl = document.getElementById('billStockConflictList');
      if (listEl) {
        listEl.innerHTML = conflicts.map(c => {
          const d = new Date(c.adjustmentDate).toLocaleDateString('en-GB');
          return `<li>${escapeHtml(c.itemName)}${c.size ? ' (' + escapeHtml(c.size) + ')' : ''} — corrected on ${d} (reason: ${escapeHtml(c.reason || '')})</li>`;
        }).join('');
      }

      const el = document.getElementById('billStockConflictModal');
      if (!el || typeof bootstrap === 'undefined') { resolve('update'); return; }

      const updateBtn = document.getElementById('billStockConflictUpdateBtn');
      const ledgerBtn = document.getElementById('billStockConflictLedgerBtn');

      let settled = false;
      const finish = choice => {
        if (settled) return;
        settled = true;
        updateBtn?.removeEventListener('click', onUpdate);
        ledgerBtn?.removeEventListener('click', onLedger);
        el.removeEventListener('hidden.bs.modal', onHidden);
        resolve(choice);
      };
      const onUpdate = () => { safeModalHide('billStockConflictModal'); finish('update'); };
      const onLedger = () => { safeModalHide('billStockConflictModal'); finish('ledger'); };
      const onHidden = () => finish('cancel');

      updateBtn?.addEventListener('click', onUpdate);
      ledgerBtn?.addEventListener('click', onLedger);
      el.addEventListener('hidden.bs.modal', onHidden);

      safeModalShow('billStockConflictModal');
    });
  },

  async loadData() {
    const tbody = document.getElementById('billTableBody');
    if (tbody)
      tbody.innerHTML =
        '<tr><td colspan="9" class="text-center p-4">Fetching Bill Records…</td></tr>';

    try {
      const res = await Api.call('getBillData');
      if (!res?.success) {
        App.Utils.showToast(res?.message || 'Failed to load bills.', true);
        return;
      }

      App.State.globalBills = Array.isArray(res.data) ? res.data : [];
      App.State.filteredBills = [...App.State.globalBills];
      App.State.billCurrentPage = 1;
      App.State.billSearchTerm = '';
      App.State.billDateFilter = '';
      App.State.billSortBy = App.State.billSortBy || 'dateDesc';
      App.State.selectedBills = [];
      this.sortFiltered();
      this.renderTable();
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to load bills.', true);
    }
  },

  filterData(searchTerm) {
    App.State.billSearchTerm = String(searchTerm || '');
    this.applyFilters();
  },

  filterByDate(dateValue) {
    App.State.billDateFilter = String(dateValue || '');
    this.applyFilters();
  },

  applyFilters() {
    const term = App.State.billSearchTerm.toLowerCase().trim();
    const dateFilter = App.State.billDateFilter;

    App.State.filteredBills = App.State.globalBills.filter(bill => {
      if (dateFilter && dateToInputValue(bill.billDateRaw, bill.billDate) !== dateFilter) return false;

      if (term) {
        const poSearch = (bill.poNumbers?.length ? bill.poNumbers : [bill.poNumber || '']).join(' ');
        const itemsText = (bill.items || []).map(it => `${it.name || ''} ${it.size || ''} ${it.narration || ''} ${it.processName || ''} ${it.color || ''}`).join(' ');
        const haystack = `${bill.billNumber || ''} ${poSearch} ${bill.vendor || ''} ${bill.billDate || ''} ${bill.billType || ''} ${itemsText}`;
        if (!App.Utils.matchesKeywords(haystack, term)) return false;
      }
      return true;
    });

    this.sortFiltered();
    App.State.billCurrentPage = 1;
    this.renderTable();
  },

  // Field/direction combos selectable via the "Sort by" dropdown
  // (View_BillLedger.html#billSortBy). Applied to filteredBills after
  // every filter/search pass, before the pagination slice in renderTable.
  SORT_COMPARATORS: {
    dateDesc: (a, b) => parseRecordDate(b.billDateRaw, b.billDate) - parseRecordDate(a.billDateRaw, a.billDate),
    dateAsc: (a, b) => parseRecordDate(a.billDateRaw, a.billDate) - parseRecordDate(b.billDateRaw, b.billDate),
    billNumberDesc: (a, b) => (parseInt(String(b.billNumber).replace(/\D/g, ''), 10) || 0) - (parseInt(String(a.billNumber).replace(/\D/g, ''), 10) || 0),
    billNumberAsc: (a, b) => (parseInt(String(a.billNumber).replace(/\D/g, ''), 10) || 0) - (parseInt(String(b.billNumber).replace(/\D/g, ''), 10) || 0),
    vendorAsc: (a, b) => String(a.vendor || '').localeCompare(String(b.vendor || '')),
    vendorDesc: (a, b) => String(b.vendor || '').localeCompare(String(a.vendor || '')),
    amountDesc: (a, b) => (b.totalAmount || 0) - (a.totalAmount || 0),
    amountAsc: (a, b) => (a.totalAmount || 0) - (b.totalAmount || 0)
  },

  sortFiltered() {
    const cmp = this.SORT_COMPARATORS[App.State.billSortBy];
    if (cmp) App.State.filteredBills.sort(cmp);
  },

  sortBy(value) {
    App.State.billSortBy = value;
    this.sortFiltered();
    App.State.billCurrentPage = 1;
    this.renderTable();
  },

  changePage(page) {
    App.State.billCurrentPage = App.Utils.clampPage(page, App.State.filteredBills.length, App.State.billRowsPerPage);
    this.renderTable();
  },

  renderTable() {
    const tbody = document.getElementById('billTableBody');
    if (!tbody) return;

    const emptyState = document.getElementById('billEmptyState');
    if (!App.State.filteredBills.length) {
      tbody.innerHTML = '';
      if (emptyState) emptyState.style.display = 'block';
      App.Utils.renderPagination('billPagination', 0, 1, App.State.billRowsPerPage, 'bill-page', 'Bills');
      this.updateBulkButtons();
      return;
    }
    if (emptyState) emptyState.style.display = 'none';

    const { filteredBills, billCurrentPage: cur, billRowsPerPage: rpp } = App.State;
    const start = (cur - 1) * rpp;
    const pageItems = filteredBills.slice(start, start + rpp);

    const selectAllChk = document.getElementById('selectAllBills');
    if (selectAllChk) {
      selectAllChk.checked = pageItems.length > 0 &&
        pageItems.every(bill => App.Selection.isSelected(App.State.selectedBills, this.billKey(bill)));
    }

    tbody.innerHTML = pageItems.map(bill => this.rowHtml(bill)).join('');

    App.Utils.renderPagination('billPagination', filteredBills.length, cur, rpp, 'bill-page', 'Bills');
    this.updateBulkButtons();
  },

  // Renders one <tr> for a bill. Shared by renderTable's full rebuild and
  // patchRowInPlace's single-row swap below.
  rowHtml(bill) {
    const index = App.State.globalBills.indexOf(bill);
    const poNums = bill.poNumbers?.length ? bill.poNumbers : (bill.poNumber ? [bill.poNumber] : []);
    const poBadge = poNums.map(p =>
      p === 'DIRECT'
        ? '<span class="badge bg-secondary shadow-sm">Direct</span>'
        : `<span class="badge bg-primary bg-opacity-10 text-primary border border-primary-subtle shadow-sm">PO-${escapeHtml(String(p))}</span>`
    ).join(' ') || '<span class="badge bg-secondary">—</span>';

    const itemsPreview = formatItemsPreview(bill.items);
    const key = this.billKey(bill);
    const checkedAttr = App.Selection.isSelected(App.State.selectedBills, key) ? 'checked' : '';
    const billTypeBadge = bill.billType === 'LABOR'
      ? ' <span class="badge bg-info text-dark shadow-sm">Labor</span>'
      : '';

    return `
      <tr data-bill-key="${escapeHtml(key)}">
        <td class="text-center">
          <input type="checkbox" class="form-check-input bill-select-chk" data-key="${escapeHtml(key)}" ${checkedAttr} onchange="App.Bill.onRowSelectChange()">
        </td>
        <td>${poBadge}</td>
        <td><strong class="text-primary">${escapeHtml(bill.billNumber || '')}</strong>${billTypeBadge}</td>
        <td>${escapeHtml(bill.billDate || '')}</td>
        <td>${escapeHtml(bill.vendor || '')}</td>
        <td><small class="text-muted">${itemsPreview}</small></td>
        <td>${escapeHtml(String(bill.totalQty ?? 0))}</td>
        <td class="text-success fw-bold">${formatCurrency(bill.totalAmount)}</td>
        <td>
          <button class="btn btn-sm btn-outline-dark w-100 mb-1 btn-action"
                  data-action="bill-print"
                  data-index="${index}">Print</button>
          <button class="btn btn-sm btn-outline-primary w-100 mb-1 btn-action"
                  data-action="bill-edit"
                  data-index="${index}">Edit Details</button>
          <button class="btn btn-sm btn-danger w-100"
                  data-action="bill-delete"
                  data-vendor="${escapeHtml(bill.vendor || '')}"
                  data-billnumber="${escapeHtml(bill.billNumber || '')}">Delete</button>
        </td>
      </tr>`;
  },

  // Patches one already-loaded bill's data + its rendered <tr> after an
  // edit save, instead of a full loadData() reload -- keyed by the
  // PRE-edit (vendor, billNumber), since that's how the row is currently
  // indexed in globalBills/the DOM; this then updates the object (and its
  // rendered key) to the post-save values. Returns false -- caller should
  // fall back to loadData() -- if the bill isn't currently loaded or isn't
  // on the displayed page.
  patchRowInPlace(freshBill, oldKey) {
    const existing = App.State.globalBills.find(b => this.billKey(b) === oldKey);
    if (!existing) return false;

    Object.assign(existing, freshBill);

    const tr = document.querySelector(`#billTableBody tr[data-bill-key="${CSS.escape(oldKey)}"]`);
    if (!tr) return false;

    tr.outerHTML = this.rowHtml(existing);
    return true;
  },

  // Builds a stable string key for a bill row (Vendor + Bill Number) --
  // bill numbers are only unique per-vendor, so selection/delete/print
  // must key on the pair, not the bill number alone.
  billKey(bill) {
    return `${bill.vendor || ''}|${bill.billNumber || ''}`;
  },

  toggleSelectAll(masterChk) {
    App.Selection.toggleAll(App.State.selectedBills, 'bill-select-chk', masterChk);
    this.updateBulkButtons();
  },

  onRowSelectChange() {
    App.Selection.syncFromRows(App.State.selectedBills, 'bill-select-chk', 'selectAllBills');
    this.updateBulkButtons();
  },

  updateBulkButtons() {
    const count = App.State.selectedBills.length;
    App.Selection.updateButton('btnBulkDeleteBills', count, '<i class="bi bi-trash"></i> Delete Selected');
    App.Selection.updateButton('btnBulkPrintBills', count, '<i class="bi bi-printer"></i> Print Selected');
    App.Selection.updateButton('btnBulkDownloadPdfBills', count, '<i class="bi bi-file-earmark-pdf"></i> Download PDFs');
  },

  async bulkDelete() {
    const selected = App.State.selectedBills;
    if (!selected.length) return;

    App.Utils.confirmAction(
      `Are you sure you want to permanently delete ${selected.length} selected bill(s) and all their items?`,
      async () => {
        try {
          // Selection keys are "vendor|billNumber" (see billKey) -- split
          // back into pairs since bill numbers alone aren't unique.
          const pairs = selected.map(key => {
            const idx = key.indexOf('|');
            return { vendor: key.slice(0, idx), billNumber: key.slice(idx + 1) };
          });
          const res = await Api.mutate('deleteBillsBulk', pairs);
          App.Utils.showToast(res?.message || 'Delete completed.', !res?.success);
          if (res?.success) {
            const deletedKeys = new Set((res.data?.deletedKeys || []).map(k => this.billKey(k)));
            App.State.globalBills = App.State.globalBills.filter(bill => !deletedKeys.has(this.billKey(bill)));
            App.State.filteredBills = App.State.filteredBills.filter(bill => !deletedKeys.has(this.billKey(bill)));
            App.State.selectedBills = [];
            this.renderTable();
          }
        } catch (err) {
          App.Utils.showToast(err.message || 'Failed to delete bills.', true);
        }
      }
    );
  },

  bulkPrint() {
    if (typeof App.Print === 'undefined') {
      App.Utils.notPortedYet('Printing');
      return;
    }

    const selected = App.State.selectedBills;
    if (!selected.length) {
      App.Utils.showToast('No bills selected.', true);
      return;
    }

    const bills = App.State.globalBills.filter(bill => App.Selection.isSelected(selected, this.billKey(bill)));
    if (!bills.length) return;

    App.Print.triggerBulk(
      bills,
      bill => this.buildBillPrintPageHtml(bill),
      'Goods_Receipts_Selected'
    );
  },

  async bulkDownloadPDF() {
    const selected = App.State.selectedBills;
    if (!selected.length) {
      App.Utils.showToast('No bills selected.', true);
      return;
    }

    const bills = App.State.globalBills.filter(bill => App.Selection.isSelected(selected, this.billKey(bill)));
    if (!bills.length) return;

    App.Print.renderBulkPages(bills, bill => this.buildBillPrintPageHtml(bill));
    const filename = App.Print.bulkPdfFilename('Goods_Receipts', bills.length);
    const ok = await App.Print.downloadElementAsPDF('print-bulk-container', filename);
    if (ok) App.Utils.showToast(`${bills.length} bill(s) exported to PDF!`, false);
  },

  // ── Print (dead code until App.Print exists) ────────────────────────

  // Populates #print-bill-container's fields from one Bill for the
  // per-row "Print" button. Mirrors App.PO.populatePrintData.
  populatePrintData(index) {
    const bill = App.State.globalBills[index];
    if (!bill) return null;

    const setText = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.innerText = val ?? '';
    };

    setText('print-bill-number', bill.billNumber || '');
    setText('print-bill-date', bill.billDate || '');
    setText('print-bill-vendor', bill.vendor || '');
    setText('print-bill-remarks', bill.remarks || '');
    setText('print-bill-contact', bill.contact || '');

    const poNums = bill.poNumbers?.length ? bill.poNumbers : (bill.poNumber ? [bill.poNumber] : []);
    const poRefEl = document.getElementById('print-bill-po-ref');
    if (poRefEl) {
      poRefEl.innerHTML = poNums.length
        ? poNums.map(p => p === 'DIRECT' ? 'Direct Purchase (No PO)' : `PO-${escapeHtml(String(p))}`).join(' | ')
        : 'N/A';
    }

    const bodyHtml = (bill.items || []).map((item, idx) => {
      const rowBg = idx % 2 === 0 ? '#ffffff' : '#F5F0FB';
      const rowStyle = `background-color:${rowBg};-webkit-print-color-adjust:exact;print-color-adjust:exact;page-break-inside:avoid;break-inside:avoid;`;
      return `
      <tr style="${rowStyle}">
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:center;color:#999;font-weight:600;">${idx + 1}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:left;font-weight:600;">${escapeHtml(item.name || '')}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:left;color:#555;">${escapeHtml(item.narration || '')}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:center;">${escapeHtml(item.size || '')}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:center;font-weight:600;">${escapeHtml(String(toNumber(item.qty)))} ${escapeHtml(item.unit || 'Pcs')}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:right;">${formatCurrency(item.price)}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:right;">${escapeHtml(String(item.gstRatePct ?? 0))}%</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:right;font-weight:700;color:#6F42C1;-webkit-print-color-adjust:exact;print-color-adjust:exact;">${formatCurrency(item.lineTotal)}</td>
      </tr>`;
    }).join('');
    const tblBody = document.getElementById('print-bill-items-body');
    if (tblBody) tblBody.innerHTML = bodyHtml;

    setText('print-bill-grand-total', toNumber(bill.totalAmount).toFixed(2));

    return bill;
  },

  print(index) {
    if (typeof App.Print === 'undefined') {
      App.Utils.notPortedYet('Printing');
      return;
    }

    const bill = this.populatePrintData(index);
    if (!bill) return;

    const title = `Bill_${bill.billNumber}_${String(bill.vendor || '')
      .replace(/[^a-zA-Z0-9 \-]/g, '')
      .trim()
      .replace(/\s+/g, '_')}`;
    App.Print.trigger('print-bill-container', title);
  },

  // Builds a fully self-contained "Goods Receipt" page (mirrors
  // #print-bill-container's markup/styling) for use in bulk printing.
  buildBillPrintPageHtml(bill) {
    const BRAND = '#6F42C1';

    const bodyHtml = (bill.items || [])
      .map((item, idx) => {
        const rowBg = idx % 2 === 0 ? '#ffffff' : '#F5F0FB';
        const rowStyle = `background-color:${rowBg};-webkit-print-color-adjust:exact;print-color-adjust:exact;page-break-inside:avoid;break-inside:avoid;`;
        return `
        <tr style="${rowStyle}">
          <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:center;color:#999;font-weight:600;">${idx + 1}</td>
          <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:left;font-weight:600;">${escapeHtml(item.name || '')}</td>
          <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:left;color:#555;">${escapeHtml(item.narration || '')}</td>
          <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:center;">${escapeHtml(item.size || '')}</td>
          <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:center;font-weight:600;">${escapeHtml(String(toNumber(item.qty)))} ${escapeHtml(item.unit || 'Pcs')}</td>
          <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:right;">${formatCurrency(item.price)}</td>
          <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:right;">${escapeHtml(String(item.gstRatePct ?? 0))}%</td>
          <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:right;font-weight:700;color:${BRAND};-webkit-print-color-adjust:exact;print-color-adjust:exact;">${formatCurrency(item.lineTotal)}</td>
        </tr>`;
      })
      .join('');

    const poNums = bill.poNumbers?.length ? bill.poNumbers : (bill.poNumber ? [bill.poNumber] : []);
    const poRef = poNums.length
      ? poNums.map(p => p === 'DIRECT' ? 'Direct Purchase (No PO)' : `PO-${escapeHtml(String(p))}`).join(' | ')
      : 'N/A';

    return `
    <div style="background:#fff;color:#1a1a1a;font-family:'Segoe UI',Arial,sans-serif;font-size:12px;line-height:1.5;padding:14px 20px 12px 20px;margin:0;box-sizing:border-box;width:100%;border-top:5px solid ${BRAND};border-bottom:3px solid ${BRAND};-webkit-print-color-adjust:exact;print-color-adjust:exact;">
      <div style="text-align:center;padding:4px 0 8px 0;">
        ${App.Print.brandHeaderHtml(BRAND)}
        <div style="font-size:10px;color:#555;margin-top:3px;letter-spacing:0.3px;">
          6-B, SHIV SHAKTI ESTATE, VERKA CHOWK, DEHLON ROAD, BHAGWANPURA, 141114 LUDHIANA
        </div>
        <div style="font-size:10px;color:#555;margin-top:2px;letter-spacing:0.3px;">
          Ph : 86996-42398, 91546-94000, 94170-42398 &nbsp;|&nbsp; E-mail : maharaja.bikes@gmail.com
          &nbsp;&nbsp; GSTIN : 03AFIPS4089J1Z1
        </div>
      </div>
      <div style="height:2px;background:${BRAND};margin:0 0 12px 0;-webkit-print-color-adjust:exact;print-color-adjust:exact;"></div>

      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <div style="flex:1;text-align:left;">
          <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Bill / Invoice #</span>
          <div style="font-size:15px;font-weight:700;color:${BRAND};-webkit-print-color-adjust:exact;print-color-adjust:exact;">${escapeHtml(bill.billNumber || '')}</div>
        </div>
        <div style="flex:2;text-align:center;">
          <span style="font-size:18px;font-weight:800;color:${BRAND};letter-spacing:3px;text-transform:uppercase;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
            GOODS RECEIPT
          </span>
        </div>
        <div style="flex:1;text-align:right;">
          <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Date</span>
          <div style="font-size:13px;font-weight:700;color:#1a1a1a;">${escapeHtml(bill.billDate || '')}</div>
        </div>
      </div>

      <div style="height:1px;background:#bbb;margin-bottom:14px;"></div>

      <div style="margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid #ccc;">
        <div style="display:flex;gap:16px;">
          <div style="flex:1;">
            <div style="margin-bottom:6px;">
              <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Vendor</span>
              <div style="font-weight:700;font-size:13px;color:#1a1a1a;margin-top:1px;">${escapeHtml(bill.vendor || '')}</div>
            </div>
            <div>
              <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Remarks</span>
              <div style="font-size:11px;color:#333;margin-top:1px;white-space:pre-wrap;">${escapeHtml(bill.remarks || '')}</div>
            </div>
          </div>
          <div style="flex:1;">
            <div style="margin-bottom:6px;">
              <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Contact</span>
              <div style="font-size:11px;color:#333;margin-top:1px;">${escapeHtml(bill.contact || '')}</div>
            </div>
            <div>
              <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">PO Reference</span>
              <div style="font-size:11px;color:#333;margin-top:1px;font-weight:600;">${poRef}</div>
            </div>
          </div>
        </div>
      </div>

      <table style="width:100%;border-collapse:collapse;margin-bottom:14px;font-size:12px;">
        <thead style="background-color:${BRAND};color:#fff;text-align:center;font-weight:700;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
          <tr>
            <th style="padding:6px;border:1px solid #bbb;text-align:center;width:5%;">#</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:left;width:25%;">Item Name</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:left;width:20%;">Narration</th>
            <th style="padding:6px;border:1px solid #bbb;width:10%;">Size</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:center;width:10%;">Qty</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:right;width:10%;">Rate</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:right;width:8%;">GST %</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:right;width:12%;">Total</th>
          </tr>
        </thead>
        <tbody style="color:#1a1a1a;text-align:center;">${bodyHtml}</tbody>
      </table>

      <div style="text-align:right;margin-bottom:16px;padding:8px 0 0 0;border-top:2px solid ${BRAND};page-break-inside:avoid;break-inside:avoid;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
        <span style="font-size:13px;font-weight:600;color:#1a1a1a;">Grand Total (incl. GST):&nbsp;&nbsp;</span>
        <span style="font-size:15px;font-weight:800;color:${BRAND};-webkit-print-color-adjust:exact;print-color-adjust:exact;">
          &#8377;${toNumber(bill.totalAmount).toFixed(2)}
        </span>
      </div>

      <div style="display:flex;justify-content:flex-end;page-break-inside:avoid;break-inside:avoid;">
        <div style="width:180px;text-align:center;padding-top:5px;border-top:2px solid ${BRAND};-webkit-print-color-adjust:exact;print-color-adjust:exact;">
          <span style="font-size:10px;color:#666;letter-spacing:0.5px;font-style:italic;">Received By / Signature</span>
        </div>
      </div>
    </div>`;
  },

  // Looks up a vendor's contact from the Vendor Master, falling back to
  // the most recent PO seen for that vendor -- same source priority
  // App.Utils.updateVendorContact uses for the PO form, just targeting
  // the Bill form's #billContact instead of #formContact.
  updateBillContactForVendor(vendorName) {
    const contactInput = document.getElementById('billContact');
    if (!contactInput) return;
    const vendor = (App.State.globalVendors || []).find(
      v => App.Utils.sameText(v.name, vendorName) && v.contact
    );
    if (vendor) {
      contactInput.value = vendor.contact;
      return;
    }
    const match = App.State.globalPOs.find(
      po => App.Utils.sameText(po.vendor, vendorName) && po.contact
    );
    contactInput.value = match?.contact || '';
  },

  async openReceiveModal() {
    document.getElementById('billForm')?.reset();
    await this.setBillType('GOODS');

    const existingBillNumber = document.getElementById('existingBillNumber');
    if (existingBillNumber) existingBillNumber.value = '';

    const existingVendor = document.getElementById('existingVendor');
    if (existingVendor) existingVendor.value = '';

    const modalTitle = document.getElementById('billModalTitle');
    if (modalTitle) modalTitle.innerText = 'Log Incoming Invoice / Bill';

    const submitBtn = document.getElementById('billSubmitBtn');
    if (submitBtn) submitBtn.innerText = 'Record Itemized Bill';

    const billDateInput = document.getElementById('billDateInput');
    if (billDateInput) billDateInput.value = todayIso();

    const billVendor = document.getElementById('billVendor');
    if (billVendor) {
      if (
        window.jQuery?.fn?.select2 &&
        window.jQuery(billVendor).data('select2')
      ) {
        window.jQuery(billVendor).val(null).trigger('change');
      } else {
        billVendor.value = '';
      }
      billVendor.disabled = false;
    }

    const contact = document.getElementById('billContact');
    if (contact) contact.value = '';

    // Vendor + every item is now entered directly and auto-matched to an
    // open PO (see App.Bill.runAutoMatch) -- no PO selection needed
    // before items can be typed, so start with one blank row.
    const tbody = document.getElementById('billItemsBody');
    if (tbody) {
      tbody.innerHTML = this.getRowHtml({ poNumber: 'DIRECT' });
      App.Bill.refreshPoMatchBadge(tbody.firstElementChild);
    }

    const printBtn = document.getElementById('billModalPrintBtn');
    if (printBtn) printBtn.style.display = 'none';

    App.Utils.setFormButtonsForMode('billCancelBtn', 'billExitBtn', 'billSubmitBtn', false, 'Record Itemized Bill');
    App.Nav.clear('receiveBillModal');
    safeModalShow('receiveBillModal');
  },

  // Print button inside receiveBillModal itself (edit mode only). Bill
  // numbers are only unique per-vendor (see billKey), so both hidden
  // fields are needed to resolve the array index.
  printCurrent() {
    if (typeof App.Print === 'undefined') {
      App.Utils.notPortedYet('Printing');
      return;
    }
    const billNumber = document.getElementById('existingBillNumber')?.value;
    const vendor = document.getElementById('existingVendor')?.value;
    if (!billNumber) return;
    const key = this.billKey({ vendor, billNumber });
    const index = App.State.globalBills.findIndex(b => this.billKey(b) === key);
    if (index === -1) return;
    this.print(index);
  },

  async openEditModal(index) {
    const bill = App.State.globalBills[index];
    if (!bill) {
      App.Utils.showToast('Bill record not found.', true);
      return;
    }

    document.getElementById('billForm')?.reset();
    const billType = bill.billType === 'LABOR' ? 'LABOR' : 'GOODS';
    await this.setBillType(billType);

    const existingBillNumber = document.getElementById('existingBillNumber');
    if (existingBillNumber) existingBillNumber.value = bill.billNumber || '';

    const existingVendor = document.getElementById('existingVendor');
    if (existingVendor) existingVendor.value = bill.vendor || '';

    const modalTitle = document.getElementById('billModalTitle');
    if (modalTitle) modalTitle.innerText = `Edit Invoice / Bill #${bill.billNumber}`;

    const submitBtn = document.getElementById('billSubmitBtn');
    if (submitBtn) submitBtn.innerText = 'Update Bill';

    const vendorSelect = document.getElementById('billVendor');
    if (vendorSelect) {
      if (
        vendorSelect.tagName === 'SELECT' &&
        bill.vendor &&
        !Array.from(vendorSelect.options).some(o => App.Utils.sameText(o.value, bill.vendor))
      ) {
        vendorSelect.add(new Option(bill.vendor, bill.vendor, true, true));
      }
      if (
        window.jQuery?.fn?.select2 &&
        window.jQuery(vendorSelect).data('select2')
      ) {
        window.jQuery(vendorSelect).val(bill.vendor || '').trigger('change');
      } else {
        vendorSelect.value = bill.vendor || '';
      }
      vendorSelect.disabled = false;
    }

    const contactInput = document.getElementById('billContact');
    if (contactInput) contactInput.value = bill.contact || '';

    const billNumberInput = document.querySelector('input[name="billNumber"]');
    if (billNumberInput) billNumberInput.value = bill.billNumber || '';

    const billDateInput = document.getElementById('billDateInput');
    if (billDateInput) billDateInput.value = String(bill.billDateRaw || '').split('T')[0];

    const remarksInput = document.querySelector('input[name="remarks"]');
    if (remarksInput) remarksInput.value = bill.remarks || '';

    const issuingPartyInput = document.querySelector('input[name="issuingParty"]');
    if (issuingPartyInput) issuingPartyInput.value = bill.issuingParty || '';

    const manufacturingVendorInput = document.querySelector('input[name="manufacturingVendor"]');
    if (manufacturingVendorInput) manufacturingVendorInput.value = bill.manufacturingVendor || '';

    const tbody = document.getElementById('billItemsBody');
    if (tbody) {
      tbody.innerHTML =
        (bill.items || []).map(item => this.getRowHtml(item)).join('') ||
        this.getRowHtml({ poNumber: 'DIRECT' });
      Array.from(tbody.querySelectorAll('tr')).forEach(row => {
        this.refreshPoMatchBadge(row);
        if (billType === 'LABOR') this.initRowProcessSelect2(row);
      });
    }

    const printBtn = document.getElementById('billModalPrintBtn');
    if (printBtn) printBtn.style.display = '';

    this.refreshRowSizeLists();
    this.refreshRowNarrationLists();
    App.Utils.setFormButtonsForMode('billCancelBtn', 'billExitBtn', 'billSubmitBtn', true, 'Update Bill');
    App.Nav.register(
      'receiveBillModal',
      (App.State.filteredBills || []).map(b => this.billKey(b)),
      this.billKey(bill),
      (key) => {
        const idx = App.State.globalBills.findIndex(b => this.billKey(b) === key);
        if (idx !== -1) this.openEditModal(idx);
      }
    );
    safeModalShow('receiveBillModal');
  },

  // Re-filters every row's size <datalist> to match its currently entered
  // item name. Needed after bulk-rendering rows since getRowHtml() only
  // wires up the empty datalist shell, not its filtered contents.
  refreshRowSizeLists() {
    $$('#billItemsBody .b-item-name').forEach(nameInput => {
      if (nameInput.value.trim()) App.Utils.applyDependentSizeList(nameInput, '.b-item-size');
    });
  },

  // Populates a row's Narration <datalist> from PO/Bill history. Mirrors
  // App.PO.refreshNarrationList.
  refreshNarrationList(row) {
    if (!row) return;
    const datalist = $('datalist.row-narration-list', row);
    const narrationInput = $('.b-item-narration', row);
    if (!datalist || !narrationInput) return;

    const name = $('.b-item-name', row)?.value?.trim();
    const size = $('.b-item-size', row)?.value?.trim() || '';
    const vendor = (document.getElementById('billVendor')?.value || '').trim();
    if (!name) { datalist.innerHTML = ''; return; }

    const nameLower = name.toLowerCase();
    const sizeLower = size.toLowerCase();
    const vendorLower = vendor.toLowerCase();

    const collect = requireVendorMatch => {
      const narrations = new Set();
      const scan = records => (records || []).forEach(rec => {
        if (requireVendorMatch && String(rec.vendor || '').trim().toLowerCase() !== vendorLower) return;
        (rec.items || []).forEach(it => {
          if (String(it.name || '').trim().toLowerCase() === nameLower &&
              String(it.size || '').trim().toLowerCase() === sizeLower &&
              it.narration) narrations.add(it.narration);
        });
      });
      scan(App.State.globalPOs);
      scan(App.State.globalBills);
      return narrations;
    };

    let narrations = vendorLower ? collect(true) : new Set();
    if (narrations.size === 0) narrations = collect(false);

    if (narrations.size === 0) {
      const masterItem = (App.State.globalItems || []).find(i =>
        String(i.name || '').trim().toLowerCase() === nameLower &&
        String(i.size || '').trim().toLowerCase() === sizeLower
      );
      if (masterItem?.narration) narrations.add(masterItem.narration);
    }

    datalist.innerHTML = [...narrations].map(n => `<option value="${escapeHtml(n)}">`).join('');
    if (narrations.size === 1 && !narrationInput.value.trim()) narrationInput.value = [...narrations][0];
  },

  refreshRowNarrationLists() {
    $$('#billItemsBody tr').forEach(row => this.refreshNarrationList(row));
  },

  addRow() {
    const tbody = document.getElementById('billItemsBody');
    if (!tbody) return;
    tbody.insertAdjacentHTML('beforeend', this.getRowHtml({ poNumber: 'DIRECT' }));
    App.Bill.refreshPoMatchBadge(tbody.lastElementChild);
    if (this.isLaborMode()) this.initRowProcessSelect2(tbody.lastElementChild);
  },

  getRowHtml(item = {}) {
    const rowUid = `bill-${++App.State.rowSeq}`;
    return `
    <tr data-po="${escapeHtml(String(item.poNumber || ''))}" data-row-uid="${rowUid}" data-auto-matched="${item.autoMatched ? 'auto' : ''}" data-process-name="${escapeHtml(item.processName || '')}" data-color="${escapeHtml(item.color || '')}">
      <td class="goods-col"><input type="text"   class="form-control b-item-name"  list="itemList" value="${escapeHtml(item.name || '')}" ${App.Bill.isLaborMode() ? '' : 'required'}>
          <div class="po-match-info small mt-1" data-role="po-match-info"></div></td>
      <td class="goods-col"><input type="text"   class="form-control b-item-size"  list="sizeList-${rowUid}" value="${escapeHtml(item.size || '')}">
          <datalist class="row-size-list" id="sizeList-${rowUid}"></datalist></td>
      <td class="labor-col"><select class="form-select b-process-select"></select></td>
      <td class="labor-col"><select class="form-select b-color-select"></select></td>
      <td><input type="text"   class="form-control b-item-narration" list="narrationList-${rowUid}" value="${escapeHtml(item.narration || '')}">
          <datalist class="row-narration-list" id="narrationList-${rowUid}"></datalist></td>
      <td><input type="number" class="form-control b-item-qty"                   value="${escapeHtml(String(item.qty ?? ''))}" required></td>
      <td><input type="text"   class="form-control item-unit"    list="unitList" value="${escapeHtml(item.unit || 'Pcs')}"></td>
      <td><input type="number" class="form-control b-item-price" step="0.01"     value="${escapeHtml(String(item.price ?? ''))}" required>
          <div class="rate-conflict-info small mt-1" data-role="rate-conflict-info"></div></td>
      <td><input type="number" class="form-control b-item-gst"   step="0.01"     value="${escapeHtml(String(item.gstRatePct ?? 0))}"></td>
      <td><button type="button" class="btn btn-outline-danger btn-sm" data-action="remove-row">✕</button></td>
    </tr>`;
  },

  isLaborMode() {
    return document.getElementById('billTypeLabor')?.checked === true;
  },

  // Toggles the whole Bill form between a Goods bill (free-text Item
  // Name/Size, Vendor sourced from Vendor Master) and a Labor Job bill
  // (searchable Process + Color pickers, Vendor field re-sourced from
  // Contractors). Process/Color rows need Process Master + the process's own
  // color sub-groups loaded, so this lazily loads them the same way
  // Production's Process dropdown does (ensureLoaded) instead of requiring
  // the Process/Contractor tabs to have been visited first.
  async setBillType(billType) {
    const isLabor = billType === 'LABOR';

    const goodsRadio = document.getElementById('billTypeGoods');
    const laborRadio = document.getElementById('billTypeLabor');
    if (goodsRadio) goodsRadio.checked = !isLabor;
    if (laborRadio) laborRadio.checked = isLabor;

    const table = document.getElementById('billItemsTable');
    if (table) table.classList.toggle('labor-mode', isLabor);

    const form = document.getElementById('billForm');
    if (form) form.classList.toggle('labor-mode', isLabor);

    const title = document.getElementById('billItemsSectionTitle');
    if (title) title.textContent = isLabor ? 'Labor Job Lines' : 'Items Received';

    $$('#billItemsBody .b-item-name').forEach(el => { el.required = !isLabor; });

    // Whichever this bill type's vendor dropdown needs -- PO/Vendor Master
    // for Goods, Contractors for Labor -- may not have loaded yet this
    // session, so ensure it BEFORE building the dropdown (not after, which
    // left it silently incomplete on the very bill it was just built for).
    await Promise.all(isLabor
      ? [
          App.Process.ensureLoaded ? App.Process.ensureLoaded() : Promise.resolve(),
          App.Contractor.ensureLoaded ? App.Contractor.ensureLoaded() : Promise.resolve(),
          App.Color.ensureLoaded ? App.Color.ensureLoaded() : Promise.resolve()
        ]
      : [
          App.PO ? App.PO.ensureLoaded() : Promise.resolve(),
          App.Vendor ? App.Vendor.ensureLoaded() : Promise.resolve(),
          // Row item-name typeahead falls back to Items Master for
          // narration/rate (see refreshNarrationList/getLatestRate) --
          // ensured here so it's ready by the time the operator types,
          // not just whenever Item Master happens to be visited.
          App.Item ? App.Item.ensureLoaded() : Promise.resolve()
        ]);

    this.updateVendorFieldForBillType(billType);

    if (isLabor) {
      $$('#billItemsBody tr').forEach(row => this.initRowProcessSelect2(row));
    }
  },

  // Swaps the Vendor field between the Vendor Master list (Goods bills) and
  // the Contractors list (Labor Job bills) -- both share the same underlying
  // `vendor` form field/column (Vendor reused as Contractor for Labor Job
  // bills, per product decision), so only the dropdown's label and option
  // source change.
  updateVendorFieldForBillType(billType) {
    const select = document.getElementById('billVendor');
    const label = document.getElementById('billVendorLabel');
    if (!select) return;
    const isLabor = billType === 'LABOR';

    if (label) label.textContent = isLabor ? 'Contractor Name *' : 'Vendor Name *';

    const currentValue = select.value;
    const names = isLabor
      ? [...new Set((App.State.globalContractors || []).map(c => c.contractorName).filter(Boolean))].sort((a, b) => a.localeCompare(b))
      : [...new Set([
          ...(App.State.globalPOs || []).map(po => po.vendor).filter(Boolean),
          ...(App.State.globalVendors || []).map(v => v.name).filter(Boolean)
        ])].sort((a, b) => a.localeCompare(b));

    const placeholder = isLabor ? 'Select or type new contractor…' : 'Select or type new vendor…';
    select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>` +
      names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
    select.value = currentValue;

    if (window.jQuery?.fn?.select2) {
      const $el = window.jQuery(select);
      if ($el.data('select2')) $el.select2('destroy');
      $el.select2({
        tags: true,
        placeholder,
        width: '100%',
        matcher: App.Utils.select2Matcher,
        dropdownParent: App.Utils.select2DropdownParent($el)
      });
      $el.val(currentValue).trigger('change.select2');
    }
  },

  // Searchable Select2 for a Labor Job row's Process picker, scoped to
  // active processes (no free-typing -- a Labor line must reference a real
  // Process Master row, same rule Production's own Process dropdown
  // enforces). Options are LABELED by each process's Output Item Name (what
  // the operator actually thinks of as "the processed item") rather than the
  // internal Process Name, but the underlying value is still the processId
  // -- each <option> carries both the Output Item Name and canonical Process
  // Name in its dataset so serializeForm() never has to re-look it up.
  // Output Item Names are unique across active processes (saveProcess
  // enforces this), so they're safe to use as the visible label.
  initRowProcessSelect2(row) {
    const selectEl = row?.querySelector('.b-process-select');
    if (!selectEl) return;

    const currentProcessName = (row.dataset.processName || '').trim().toLowerCase();
    const processes = (App.State.globalProcesses || []).filter(p => p.active);
    let selectedId = '';
    const optionsHtml = processes.map(p => {
      const isSelected = currentProcessName && p.processName.trim().toLowerCase() === currentProcessName;
      if (isSelected) selectedId = p.processId;
      return `<option value="${escapeHtml(p.processId)}" data-output-item="${escapeHtml(p.outputItemName || '')}" data-process-name="${escapeHtml(p.processName)}">${escapeHtml(p.outputItemName || p.processName)}</option>`;
    }).join('');

    selectEl.innerHTML = '<option value="">Choose a Processed Item...</option>' + optionsHtml;
    selectEl.value = selectedId;

    if (window.jQuery?.fn?.select2) {
      const $select = window.jQuery(selectEl);
      if ($select.data('select2')) $select.select2('destroy');
      $select.select2({
        placeholder: 'Choose a Processed Item...',
        width: '100%',
        matcher: App.Utils.select2Matcher,
        dropdownParent: App.Utils.select2DropdownParent($select)
      });
      $select.off('change.rowProcess').on('change.rowProcess', () => this.handleRowProcessChange(row));
    } else {
      selectEl.onchange = () => this.handleRowProcessChange(row);
    }

    // Load this row's color options against whatever process ended up
    // selected (pre-selected on Edit, or blank on a fresh row).
    this.populateRowColorSelect(row, selectedId, row.dataset.color || '');
  },

  handleRowProcessChange(row) {
    const selectEl = row?.querySelector('.b-process-select');
    if (!selectEl) return;
    this.populateRowColorSelect(row, selectEl.value, '');
  },

  // Searchable, taggable Select2 for a Labor Job row's Color picker --
  // sourced from that specific Process's color sub-groups
  // (getProcessColorGroups), the same list Production's own color checklist
  // uses. tags:true + createTag mirrors App.Process's own color-group
  // Select2 so a typed color resolves to an existing Color Master entry
  // instead of minting a case-variant duplicate.
  async populateRowColorSelect(row, processId, preselectColor) {
    const selectEl = row?.querySelector('.b-color-select');
    if (!selectEl) return;

    let colors = [];
    if (processId) {
      try {
        const res = await Api.call('getProcessColorGroups', processId);
        if (res?.success) colors = res.data || [];
      } catch (err) {
        colors = [];
      }
    }
    if (preselectColor && !colors.some(c => App.Utils.sameText(c, preselectColor))) {
      colors = [...colors, preselectColor];
    }

    const currentValue = selectEl.value || preselectColor || '';
    selectEl.innerHTML = '<option value="">No color</option>' +
      colors.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    selectEl.value = currentValue;

    if (window.jQuery?.fn?.select2) {
      const $select = window.jQuery(selectEl);
      if ($select.data('select2')) $select.select2('destroy');
      $select.select2({
        placeholder: 'No color',
        width: '100%',
        tags: true,
        matcher: App.Utils.select2Matcher,
        dropdownParent: App.Utils.select2DropdownParent($select),
        createTag(params) {
          const term = (params.term || '').trim();
          if (!term) return null;
          const existing = (App.State.globalColors || []).find(c => App.Utils.sameText(c.name, term));
          if (existing) return { id: existing.name, text: existing.name };
          return { id: term, text: term, newTag: true };
        }
      });
      $select.val(currentValue).trigger('change.select2');
    }
  },

  async delete(vendor, billNumber) {
    App.Utils.confirmAction(
      `Are you sure you want to permanently delete Bill #${billNumber} (${vendor}) and all its items?`,
      async () => {
        try {
          const res = await Api.mutate('deleteBill', vendor, billNumber);
          App.Utils.showToast(
            res?.message || 'Delete completed.',
            !res?.success
          );
          if (res?.success) await this.loadData();
        } catch (err) {
          App.Utils.showToast(
            err.message || 'Failed to delete Bill.',
            true
          );
        }
      }
    );
  },

  getLatestRate(itemName, itemSize, itemNarration, vendorName, poNumber) {
    const nameLower = String(itemName || '').trim().toLowerCase();
    const sizeLower = String(itemSize || '').trim().toLowerCase();
    const narrationLower = String(itemNarration || '').trim().toLowerCase();
    const vendorLower = String(vendorName || '').trim().toLowerCase();

    if (!nameLower) return null;

    // 1. If a PO is selected, check PO items first
    if (poNumber && poNumber !== 'DIRECT') {
      const po = App.State.globalPOs.find(p => String(p.poNumber) === poNumber);
      if (po) {
        const poItem = (po.items || []).find(i =>
          String(i.name).trim().toLowerCase() === nameLower &&
          String(i.size || '').trim().toLowerCase() === sizeLower &&
          String(i.narration || '').trim().toLowerCase() === narrationLower
        );
        if (poItem) return poItem.price;
      }
    }

    // 2. Search Items Master (identity is name + size only)
    const masterItem = (App.State.globalItems || []).find(i =>
      String(i.name).trim().toLowerCase() === nameLower &&
      String(i.size || '').trim().toLowerCase() === sizeLower
    );
    if (masterItem && vendorLower) {
      const vRate = (masterItem.vendors || []).find(v => String(v.vendor).trim().toLowerCase() === vendorLower);
      if (vRate) return vRate.rate;
    }

    // 3/4. Fallback: search PO history, then Bill history. Item identity
    // is name + size (narration is just descriptive text, which can
    // legitimately vary between vendors/entries for the same physical
    // item) -- so an exact narration match is tried first, per ledger, as
    // the most precise hit, but a rate logged under a different narration
    // for the same name + size + vendor still beats returning no
    // suggestion at all.
    const findInLedger = (records, requireNarrationMatch) => {
      for (const rec of records) {
        if (vendorLower && String(rec.vendor).trim().toLowerCase() !== vendorLower) continue;
        const line = (rec.items || []).find(i =>
          String(i.name).trim().toLowerCase() === nameLower &&
          String(i.size || '').trim().toLowerCase() === sizeLower &&
          (!requireNarrationMatch || String(i.narration || '').trim().toLowerCase() === narrationLower)
        );
        if (line) return line.price;
      }
      return null;
    };

    const exactMatch = findInLedger(App.State.globalPOs, true) ?? findInLedger(App.State.globalBills, true);
    if (exactMatch !== null) return exactMatch;

    return findInLedger(App.State.globalPOs, false) ?? findInLedger(App.State.globalBills, false);
  },

  // Index of every Bill line's billed base qty, keyed by (poNumber, name,
  // size, narration) with a per-bill breakdown (so a specific bill can
  // still be excluded, e.g. when editing it). Built once and reused until
  // App.State.globalBills is reassigned (every load/save/delete replaces
  // the array, so an identity check is a safe cache key). Without this,
  // _getBilledQty rescanned every Bill x every Bill line on EVERY call,
  // and App.Utils.getPendingByItem calls it once per PO line across
  // every open PO.
  _billedQtyIndex: null,
  _billedQtyIndexSrc: null,
  _getBilledQtyIndex() {
    if (this._billedQtyIndexSrc === App.State.globalBills && this._billedQtyIndex) {
      return this._billedQtyIndex;
    }
    const index = new Map();
    (App.State.globalBills || []).forEach(bill => {
      const billNumber = String(bill.billNumber || '').trim();
      (bill.items || []).forEach(bItem => {
        const key = [
          String(bItem.poNumber || '').trim(),
          String(bItem.name || '').trim().toLowerCase(),
          String(bItem.size || '').trim().toLowerCase(),
          String(bItem.narration || '').trim().toLowerCase()
        ].join('|');
        let entry = index.get(key);
        if (!entry) { entry = { total: 0, byBill: new Map() }; index.set(key, entry); }
        const qty = Number(bItem.baseQty) || 0;
        entry.total += qty;
        entry.byBill.set(billNumber, (entry.byBill.get(billNumber) || 0) + qty);
      });
    });
    this._billedQtyIndex = index;
    this._billedQtyIndexSrc = App.State.globalBills;
    return index;
  },

  _getBilledQty(poNumber, itemName, itemSize, itemNarration, excludeBillNumber) {
    const key = [
      String(poNumber || '').trim(),
      String(itemName || '').trim().toLowerCase(),
      String(itemSize || '').trim().toLowerCase(),
      String(itemNarration || '').trim().toLowerCase()
    ].join('|');
    const entry = this._getBilledQtyIndex().get(key);
    if (!entry) return 0;
    if (excludeBillNumber) {
      return entry.total - (entry.byBill.get(String(excludeBillNumber).trim()) || 0);
    }
    return entry.total;
  },

  autoFillRate(row) {
    const name = $('.b-item-name', row)?.value?.trim();
    const size = $('.b-item-size', row)?.value?.trim() || '';
    const narration = $('.b-item-narration', row)?.value?.trim() || '';
    const vendor = document.getElementById('billVendor')?.value || '';
    const poNumber = row?.dataset?.po || '';
    const priceInput = $('.b-item-price', row);

    if (!name || !priceInput) return;

    const rate = this.getLatestRate(name, size, narration, vendor, poNumber);
    if (rate !== null && rate > 0) {
      priceInput.value = rate;
    }
  },

  serializeForm() {
    const billVendor = document.getElementById('billVendor');
    const wasDisabled = billVendor?.disabled ?? false;
    if (wasDisabled && billVendor) billVendor.disabled = false;

    const form = document.getElementById('billForm');
    const formData = Object.fromEntries(new FormData(form));

    if (wasDisabled && billVendor) billVendor.disabled = true;

    const isLabor = formData.billType === 'LABOR';
    const items = [];
    $$('#billItemsBody tr').forEach(row => {
      let name, size = '', processName = '', color = '';
      if (isLabor) {
        const processSelect = $('.b-process-select', row);
        const opt = processSelect?.selectedOptions?.[0];
        if (!processSelect?.value || !opt) return;
        name = opt.dataset.outputItem || '';
        processName = opt.dataset.processName || '';
        color = $('.b-color-select', row)?.value?.trim() || '';
        if (!name) return;
      } else {
        name = $('.b-item-name', row)?.value?.trim();
        size = $('.b-item-size', row)?.value?.trim() || '';
        if (!name) return;
      }

      const base = {
        name,
        size,
        narration: $('.b-item-narration', row)?.value?.trim() || '',
        unit: $('.item-unit', row)?.value?.trim() || 'Pcs',
        price: toNumber($('.b-item-price', row)?.value),
        gst: toNumber($('.b-item-gst', row)?.value),
        processName,
        color
      };

      // A row auto-matched across multiple POs stays one line on screen
      // but the Bill sheet links one PO per row, so it's expanded into
      // one line item per PO allocation only here, at save time.
      let allocs = [];
      try { allocs = row.dataset.allocs ? JSON.parse(row.dataset.allocs) : []; } catch (e) { allocs = []; }

      if (allocs.length > 1) {
        allocs.forEach(a => items.push({ ...base, qty: a.qty, po: a.poNumber }));
      } else {
        items.push({
          ...base,
          qty: toNumber($('.b-item-qty', row)?.value),
          po: row.dataset?.po || 'DIRECT'
        });
      }
    });

    formData.items = JSON.stringify(items);
    return { formData, items };
  },

  // Renders the "Matched PO" indicator for one bill row, based on its
  // current data-po / data-auto-matched / data-unmatched-qty. Called
  // after any auto-match suggestion, manual override, or DIRECT row
  // insertion.
  refreshPoMatchBadge(row) {
    const info = row && $('[data-role="po-match-info"]', row);
    if (!info) return;

    const name = $('.b-item-name', row)?.value?.trim();
    if (!name) { info.innerHTML = ''; return; }

    const po = row.dataset.po || 'DIRECT';
    const autoMatched = row.dataset.autoMatched || '';
    const unmatchedQty = Number(row.dataset.unmatchedQty || 0);

    let allocs = [];
    try { allocs = row.dataset.allocs ? JSON.parse(row.dataset.allocs) : []; } catch (e) { allocs = []; }

    if (allocs.length > 1) {
      const breakdown = allocs
        .map(a => (a.poNumber === 'DIRECT' ? `DIRECT: ${a.qty}` : `PO #${a.poNumber}: ${a.qty}`))
        .join(' + ');
      info.innerHTML = `<span class="badge bg-info-subtle text-info-emphasis po-badge" role="button" title="Click to change · saved as ${allocs.length} separate PO-linked lines">Auto-matched (split) → ${escapeHtml(breakdown)}</span>`;
    } else if (po === 'DIRECT') {
      const cls = unmatchedQty > 0 ? 'bg-warning-subtle text-warning-emphasis' : 'bg-secondary-subtle text-secondary-emphasis';
      const label = unmatchedQty > 0 ? 'No matching open PO — DIRECT' : 'DIRECT';
      info.innerHTML = `<span class="badge ${cls} po-badge" role="button" title="Click to link to a PO">${label}</span>`;
    } else {
      const label = autoMatched === 'manual' ? 'Linked' : 'Auto-matched';
      info.innerHTML = `<span class="badge bg-info-subtle text-info-emphasis po-badge" role="button" title="Click to change">${label} → PO #${escapeHtml(po)}</span>`;
    }
  },

  // Swaps a row's badge into an inline <select> so the user can confirm
  // or override the suggested (or DIRECT) PO match before saving.
  openPoOverride(row) {
    const info = row && $('[data-role="po-match-info"]', row);
    if (!info) return;

    const vendor = (document.getElementById('billVendor')?.value || '').trim().toLowerCase();
    const vendorPOs = (App.State.globalPOs || []).filter(
      p => String(p.vendor || '').trim().toLowerCase() === vendor
    );
    const current = row.dataset.po || 'DIRECT';

    const optionsHtml = ['DIRECT', ...vendorPOs.map(p => p.poNumber)]
      .map(v => `<option value="${escapeHtml(v)}" ${v === current ? 'selected' : ''}>${v === 'DIRECT' ? 'DIRECT (no PO)' : 'PO #' + escapeHtml(v)}</option>`)
      .join('');

    info.innerHTML = `<select class="form-select form-select-sm po-override-select">${optionsHtml}</select>`;
    const select = $('.po-override-select', info);
    if (!select) return;
    select.focus();

    const commit = () => {
      row.dataset.po = select.value;
      row.dataset.autoMatched = 'manual';
      row.dataset.unmatchedQty = '0';
      row.dataset.allocs = ''; // manual override picks one PO for the full qty, no split
      App.Bill.refreshPoMatchBadge(row);

      // Manually linking to a PO can still disagree on rate -- check and
      // surface it the same way an auto-match conflict would be.
      if (select.value !== 'DIRECT') {
        const name = $('.b-item-name', row)?.value?.trim().toLowerCase() || '';
        const size = $('.b-item-size', row)?.value?.trim().toLowerCase() || '';
        const billRate = toNumber($('.b-item-price', row)?.value);
        const po = vendorPOs.find(p => String(p.poNumber) === select.value);
        const poItem = po?.items?.find(i =>
          String(i.name || '').trim().toLowerCase() === name &&
          String(i.size || '').trim().toLowerCase() === size
        );
        if (poItem && billRate > 0 && Math.abs(poItem.price - billRate) > 0.01) {
          App.Bill.renderRateConflict(row, {
            poRate: poItem.price, poUnit: poItem.unit,
            billRate, billUnit: $('.item-unit', row)?.value?.trim() || 'Pcs'
          });
        } else {
          App.Bill.renderRateConflict(row, null);
        }
      } else {
        App.Bill.renderRateConflict(row, null);
      }
    };
    select.addEventListener('change', commit);
    select.addEventListener('blur', () => App.Bill.refreshPoMatchBadge(row));
  },

  // Debounced entry point: re-suggests PO matches for every
  // not-manually-overridden row in the bill form, using the current
  // vendor + each row's name/size/narration/qty/unit/price. Runs for an
  // already-auto-matched row too (not just still-DIRECT ones) so a later
  // qty/name edit refreshes a stale suggestion instead of that row being
  // permanently excluded the moment it first matches.
  //
  // Tracks its own promise on App.State.billAutoMatchPromise so
  // flushPendingAutoMatch() (called right before a bill submits) can
  // await an already-in-flight call instead of racing it.
  runAutoMatch() {
    const promise = App.Bill._runAutoMatchNow();
    App.State.billAutoMatchPromise = promise;
    promise.finally(() => {
      if (App.State.billAutoMatchPromise === promise) App.State.billAutoMatchPromise = null;
    });
    return promise;
  },

  async _runAutoMatchNow() {
    const vendor = document.getElementById('billVendor')?.value || '';
    if (!vendor) return;

    const candidateRows = Array.from(document.querySelectorAll('#billItemsBody tr[data-row-uid]'))
      .filter(row => row.dataset.autoMatched !== 'manual');
    if (candidateRows.length === 0) return;

    // Price is a preference for disambiguation, not a requirement -- a
    // row with no price yet (or 0) can still be matched on name+size.
    const items = candidateRows
      .map(row => ({
        rowIndex: row.dataset.rowUid,
        name: $('.b-item-name', row)?.value?.trim() || '',
        size: $('.b-item-size', row)?.value?.trim() || '',
        narration: $('.b-item-narration', row)?.value?.trim() || '',
        qty: toNumber($('.b-item-qty', row)?.value),
        unit: $('.item-unit', row)?.value?.trim() || 'Pcs',
        price: toNumber($('.b-item-price', row)?.value)
      }))
      .filter(it => it.name && it.qty > 0);
    if (items.length === 0) return;

    // A bill can't fulfil a PO that didn't exist yet -- the server uses
    // this to exclude PO lines dated after the bill itself.
    const billDate = document.getElementById('billDateInput')?.value || '';

    try {
      const res = await Api.call('suggestPoAllocations', vendor, items, billDate);
      if (res?.success) App.Bill.applyAutoMatch(candidateRows, res.data || []);
    } catch (err) {
      // Auto-match is a convenience layer only -- never block bill entry on failure.
      console.warn('[App.Bill.runAutoMatch] suggestion failed:', err?.message);
    }
  },

  // Called right before the bill form actually submits (see the DOMContentLoaded
  // submit handler below) so serializeForm() never reads a row's dataset.po/allocs
  // while a suggestion for it is still mid-flight or about to fire from the
  // trailing edge of the debounce.
  async flushPendingAutoMatch() {
    if (App.State.billAutoMatchTimer) {
      clearTimeout(App.State.billAutoMatchTimer);
      App.State.billAutoMatchTimer = null;
      await App.Bill.runAutoMatch();
      return;
    }
    if (App.State.billAutoMatchPromise) {
      await App.State.billAutoMatchPromise;
    }
  },

  // Applies suggested allocations to their source rows. The row stays a
  // single line in the form (qty unchanged) even when the match spans
  // multiple POs -- the breakdown is kept in row.dataset.allocs and only
  // surfaced as a badge (see refreshPoMatchBadge); it's expanded into
  // separate PO-linked line items at save time (serializeForm), not
  // visibly split on screen.
  applyAutoMatch(rows, results) {
    const byRowUid = {};
    results.forEach(r => { byRowUid[r.rowIndex] = r; });

    rows.forEach(row => {
      // Re-check CURRENT state, not the state when this request's
      // candidateRows snapshot was captured -- the user may have
      // committed a manual PO override for this exact row while this
      // suggestion request was still in flight. Applying a stale
      // response here would silently revert that deliberate choice.
      if (row.dataset.autoMatched === 'manual') return;

      const result = byRowUid[row.dataset.rowUid];
      if (!result || !(result.allocations || []).length) {
        row.dataset.allocs = '';
        row.dataset.unmatchedQty = String(result?.unmatchedQty || 0);
        App.Bill.refreshPoMatchBadge(row);
        return;
      }

      const allocs = result.allocations.map(a => ({ poNumber: a.poNumber, qty: a.qty, rateConflict: a.rateConflict }));
      if (result.unmatchedQty > 0) allocs.push({ poNumber: 'DIRECT', qty: result.unmatchedQty });

      row.dataset.po = allocs[0].poNumber;
      row.dataset.autoMatched = 'auto';
      row.dataset.unmatchedQty = '0';
      row.dataset.allocs = allocs.length > 1 ? JSON.stringify(allocs) : '';
      App.Bill.refreshPoMatchBadge(row);
      App.Bill.renderRateConflict(row, allocs[0].rateConflict);
    });
  },

  // Shows (or clears) a "rate differs from PO" notice under a row's price
  // field. The bill's rate is always what gets saved by default (it's
  // the actual paid price; the PO figure is often just a quote), but the
  // user gets a clear choice to keep the PO's rate instead.
  renderRateConflict(row, conflict) {
    const info = row && $('[data-role="rate-conflict-info"]', row);
    if (!info) return;
    if (!conflict) { info.innerHTML = ''; return; }

    row.dataset.poRate = conflict.poRate;
    row.dataset.poRateUnit = conflict.poUnit || '';
    info.innerHTML = `
      <span class="badge bg-warning-subtle text-warning-emphasis">
        PO rate: ₹${escapeHtml(String(conflict.poRate))}/${escapeHtml(conflict.poUnit || 'unit')}
        vs Bill: ₹${escapeHtml(String(conflict.billRate))}/${escapeHtml(conflict.billUnit || 'unit')}
      </span>
      <a href="#" class="ms-1" data-action="use-po-rate">Use PO rate</a> ·
      <a href="#" data-action="keep-bill-rate">Keep bill rate</a>`;
  },

  // Resolves a rate conflict notice: 'use-po-rate' overwrites the row's
  // price (and unit) with the PO's quoted figure; 'keep-bill-rate' just
  // dismisses the notice and leaves the as-entered bill rate in place.
  resolveRateConflict(row, action) {
    if (action === 'use-po-rate') {
      const priceInput = $('.b-item-price', row);
      const unitInput = $('.item-unit', row);
      if (priceInput && row.dataset.poRate) priceInput.value = row.dataset.poRate;
      if (unitInput && row.dataset.poRateUnit) unitInput.value = row.dataset.poRateUnit;
    }
    App.Bill.renderRateConflict(row, null);
  }
};

// Form submit handler + row-level listeners -- ported from
// Script_Core.html's billForm submit block and its bill-item delegated
// input/change/click listeners. Adapted to Api.mutate for saveBill (see
// module header comment).
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('billForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    // Flush any pending/in-flight PO auto-match first -- otherwise a fast
    // submit right after editing an item field can read dataset.po/allocs
    // from BEFORE the debounced suggestion (or one already in flight) has
    // applied, saving a stale split.
    setDisabled('billSubmitBtn', true);
    try {
      await App.Bill.flushPendingAutoMatch();
    } finally {
      setDisabled('billSubmitBtn', false);
    }
    const { formData, items } = App.Bill.serializeForm();
    if (!items.length) {
      App.Utils.showToast('Please add at least one item to the bill.', true);
      return;
    }

    const isEdit = !!formData.existingBillNumber;
    const confirmMsg = isEdit
      ? `Are you sure you want to update Bill #${formData.billNumber} and automatically update the Items and Vendors master lists?`
      : `Are you sure you want to record Bill #${formData.billNumber} and automatically update the Items and Vendors master lists?`;

    // Only fires when this bill's date is on/before a manual Stock
    // correction already logged for one of its items -- recalculateStock()
    // sums Bill Ledger qty with no regard for Bill Date, so such a bill
    // may double-count goods that correction's physical recount already
    // included. Let the user decide per-save whether it should still hit
    // Stock, or be recorded for the ledger only.
    formData.excludeFromStockKeys = '[]';
    try {
      const conflictRes = await Api.call('checkStockAdjustmentConflicts', items, formData.billDate);
      if (conflictRes?.success && conflictRes.data?.length) {
        const choice = await App.Bill.showStockConflictChoice(conflictRes.data);
        if (choice === 'cancel') return;
        if (choice === 'ledger') {
          const keys = conflictRes.data.map(c => `${c.itemName}|${c.size || ''}`.trim().toLowerCase());
          formData.excludeFromStockKeys = JSON.stringify(keys);
        }
      }
    } catch (err) {
      // Advisory check failing must never block the actual save.
    }

    App.Utils.confirmAction(
      confirmMsg,
      async () => {
        setDisabled('billSubmitBtn', true);
        try {
          const res = await Api.mutate('saveBill', formData);
          if (res?.success && !isEdit) {
            // A brand-new bill's sorted/paginated position can't be
            // determined cheaply on the client -- full reload here (an
            // edit doesn't need to, see App.Bill.patchRowInPlace).
            await App.Bill.loadData();
            App.Bill.openReceiveModal();
          } else if (res?.success && isEdit) {
            // Save (edit mode): patch just this one bill's data + <tr> in
            // place instead of a full loadData() reload -- keyed by the
            // PRE-edit (vendor, billNumber). Falls back to a full reload
            // if the bill can't be patched.
            const oldKey = App.Bill.billKey({ vendor: String(formData.existingVendor || '').trim(), billNumber: formData.existingBillNumber });
            const patched = res.data && res.data.bill
              ? App.Bill.patchRowInPlace(res.data.bill, oldKey)
              : false;
            if (!patched) await App.Bill.loadData();

            // Stay open on the SAME bill instead of closing -- Exit
            // (App.Nav.exit) is the only way to close from here now.
            // Re-derive the fresh index by (vendor, billNumber) -- the NEW
            // values just saved -- since either half of billKey may have
            // just changed; billNumber comes back from the server
            // (res.data), trusting that over the raw formData value.
            const key = App.Bill.billKey({ vendor: String(formData.vendor || '').trim(), billNumber: res.data?.billNumber || formData.billNumber });
            const freshIndex = App.State.globalBills.findIndex(b => App.Bill.billKey(b) === key);
            if (freshIndex !== -1) {
              App.Bill.openEditModal(freshIndex);
            } else {
              safeModalHide('receiveBillModal');
            }
          } else {
            safeModalHide('receiveBillModal');
          }
          App.Utils.showToast(res?.message || 'Bill saved.', !res?.success, res?.success
            ? { type: 'bill', value: `${String(formData.vendor || '').trim()}␟${res.data?.billNumber || formData.billNumber}` }
            : null);
        } catch (err) {
          App.Utils.showToast(err.message || 'Failed to save bill.', true);
        } finally {
          setDisabled('billSubmitBtn', false);
        }
      }
    );
  });

  // Delegated events for dynamic item input changes in the receive bill
  // form. The pending-timer handle lives on App.State (not a local
  // closure var) so App.Bill.flushPendingAutoMatch() can clear/await it
  // from the submit handler.
  const handleBillItemFieldChange = e => {
    if (e.target.matches('.b-item-name')) {
      App.Utils.applyDependentSizeList(e.target, '.b-item-size');
    }

    if (e.target.matches('.b-item-name, .b-item-size')) {
      App.Utils.applyDefaultPurchaseUnit(e.target, '.b-item-name', '.b-item-size', '.item-unit');
      const row = e.target.closest('tr');
      if (row) App.Bill.refreshNarrationList(row);
    }

    if (e.target.matches('.b-item-name, .b-item-size, .b-item-narration')) {
      const row = e.target.closest('tr');
      if (row) {
        App.Bill.autoFillRate(row);
      }
    }

    // Re-suggest PO matches when a row's identifying fields settle. Only
    // for rows the user hasn't explicitly linked (manually or via a
    // manual override) -- an already-auto-matched row (dataset.po = a
    // real PO number, autoMatched = 'auto') must keep re-arming here too,
    // or once ANY suggestion lands it can never be re-evaluated again as
    // the user keeps editing qty/name/etc.
    if (e.target.matches('.b-item-name, .b-item-size, .b-item-narration, .b-item-qty, .b-item-price')) {
      const row = e.target.closest('tr');
      if (row && row.dataset.autoMatched !== 'manual') {
        clearTimeout(App.State.billAutoMatchTimer);
        App.State.billAutoMatchTimer = setTimeout(() => App.Bill.runAutoMatch(), 400);
      }
    }
  };
  document.addEventListener('input', handleBillItemFieldChange);
  document.addEventListener('change', handleBillItemFieldChange);

  // Click-to-override the suggested/DIRECT PO badge on any bill row.
  document.addEventListener('click', e => {
    const badge = e.target.closest('.po-badge');
    if (!badge) return;
    const row = badge.closest('tr');
    if (row) App.Bill.openPoOverride(row);
  });

  // Resolve a "rate differs from PO" notice: keep the bill rate (default,
  // just dismisses the notice) or adopt the PO's quoted rate instead.
  document.addEventListener('click', e => {
    const link = e.target.closest('[data-action="use-po-rate"], [data-action="keep-bill-rate"]');
    if (!link) return;
    e.preventDefault();
    const row = link.closest('tr');
    if (row) App.Bill.resolveRateConflict(row, link.dataset.action);
  });

  document.getElementById('billDateInput')?.addEventListener('change', () => App.Bill.runAutoMatch());

  document.getElementById('billVendor')?.addEventListener('change', function () {
    App.Bill.updateBillContactForVendor(this.value);
    App.Bill.refreshRowNarrationLists();
    $$('#billItemsBody tr').forEach(row => {
      const priceInput = $('.b-item-price', row);
      if (priceInput && (!Number(priceInput.value) || Number(priceInput.value) === 0)) {
        App.Bill.autoFillRate(row);
      }
    });
    App.Bill.runAutoMatch();
  });
});
