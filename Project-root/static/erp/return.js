'use strict';
// return.js -- App.Return + App.Wastage, ported from Apps_Script/Script_Return.html
// lines 1-862 (App.Issue, lines 866+ of that same file, belongs to the
// Production round instead -- its view lives in View_Production.html, not
// View_ReturnLedger.html, so it's out of scope here).
//
// Adaptations from source (documented, not silent):
// - saveReturn/deleteReturn/deleteReturnsBulk/saveWastage/deleteWastageBulk
//   all use Api.mutate (not Api.call): both services mark every mutating
//   method mutation=True, so rpc.py requires a fresh X-Mutation-Id per
//   call -- google.script.run needed no such header.
// - bulkDelete (Return) / bulkDelete+deleteSingle (Wastage) compare
//   deletedIds case-insensitively: return_service.deleteReturnsBulk and
//   wastage_service.deleteWastageBulk both lowercase every id before
//   returning it (`{str(x).strip().lower() for x in ...}`, matching
//   deletePOsBulk's own pattern from Round 4) -- harmless for PO numbers
//   (always pure digits) but returnNumber is free-text
//   (source: `<input name="returnNumber" maxlength="50">`, e.g. a
//   user-typed "RET-A1") and wastageId's literal "WST-" prefix is itself
//   mixed-case, so a case-sensitive Set().has() would silently fail to
//   clear a just-deleted row from the client-side list until the next
//   loadData(). Both sides are lowercased before comparing.
// - App.Return.print/bulkPrint (if it existed -- source has none, only a
//   per-row print) are guarded against App.Print not existing yet; its
//   builder (buildReturnPrintPageHtml) stays as ported dead code.
//   App.Wastage.printSelected() needs NO such guard -- it opens its own
//   window and writes self-contained HTML directly, no App.Print
//   dependency, so it's ported in full and reachable immediately.
// - App.Wastage.openEditModal/print(wastageId) round out GAS's own
//   updateWastage(wastageId, formData) (module_wastage.js), which source
//   has but this port previously lacked; save/enter-saved-mode UX mirrors
//   App.Issue's identical pattern in issue.js.

App.Return = {
  async loadData() {
    const tbody = document.getElementById('returnTableBody');
    if (tbody)
      tbody.innerHTML =
        '<tr><td colspan="9" class="text-center p-4">Fetching Return Records…</td></tr>';

    try {
      const res = await Api.call('getReturnData');
      if (!res?.success) {
        App.Utils.showToast(res?.message || 'Failed to load returns.', true);
        return;
      }

      App.State.globalReturns = Array.isArray(res.data) ? res.data : [];
      App.State.filteredReturns = [...App.State.globalReturns];
      App.State.returnCurrentPage = 1;
      App.State.returnSearchTerm = '';
      App.State.returnDateFilter = '';
      App.State.selectedReturns = [];
      this.renderTable();
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to load returns.', true);
    }
  },

  filterData(searchTerm) {
    App.State.returnSearchTerm = String(searchTerm || '');
    this.applyFilters();
  },

  filterByDate(dateValue) {
    App.State.returnDateFilter = String(dateValue || '');
    this.applyFilters();
  },

  applyFilters() {
    const term = App.State.returnSearchTerm.toLowerCase().trim();
    const dateFilter = App.State.returnDateFilter;

    App.State.filteredReturns = App.State.globalReturns.filter(ret => {
      if (dateFilter && dateToInputValue(ret.returnDateRaw, ret.returnDate) !== dateFilter) return false;

      if (term) {
        const itemsText = (ret.items || []).map(it => `${it.name || ''} ${it.size || ''} ${it.narration || ''}`).join(' ');
        const haystack = `${ret.returnNumber || ''} ${ret.billNumber || ''} ${ret.vendor || ''} ${itemsText}`;
        if (!App.Utils.matchesKeywords(haystack, term)) return false;
      }
      return true;
    });

    App.State.returnCurrentPage = 1;
    this.renderTable();
  },

  changePage(page) {
    App.State.returnCurrentPage = App.Utils.clampPage(page, App.State.filteredReturns.length, App.State.returnRowsPerPage);
    this.renderTable();
  },

  renderTable() {
    const tbody = document.getElementById('returnTableBody');
    if (!tbody) return;

    const emptyState = document.getElementById('returnEmptyState');
    if (!App.State.filteredReturns.length) {
      tbody.innerHTML = '';
      if (emptyState) emptyState.style.display = 'block';
      App.Utils.renderPagination('returnPagination', 0, 1, App.State.returnRowsPerPage, 'return-page', 'Returns');
      this.updateBulkButtons();
      return;
    }
    if (emptyState) emptyState.style.display = 'none';

    const { filteredReturns, returnCurrentPage: cur, returnRowsPerPage: rpp } = App.State;
    const start = (cur - 1) * rpp;
    const pageItems = filteredReturns.slice(start, start + rpp);

    const selectAllChk = document.getElementById('selectAllReturns');
    if (selectAllChk) {
      selectAllChk.checked = pageItems.length > 0 &&
        pageItems.every(ret => App.Selection.isSelected(App.State.selectedReturns, String(ret.returnNumber)));
    }

    tbody.innerHTML = pageItems.map(ret => this.rowHtml(ret)).join('');

    App.Utils.renderPagination('returnPagination', filteredReturns.length, cur, rpp, 'return-page', 'Returns');
    this.updateBulkButtons();
  },

  // Renders one <tr> for a return. Shared by renderTable's full rebuild
  // and patchRowInPlace's single-row swap below.
  rowHtml(ret) {
    const index = App.State.globalReturns.indexOf(ret);
    const billBadge = ret.billNumber
      ? `<span class="badge bg-primary bg-opacity-10 text-primary border border-primary-subtle shadow-sm">${escapeHtml(ret.billNumber)}</span>`
      : '<span class="badge bg-secondary">—</span>';

    const itemsPreview = formatItemsPreview(ret.items);
    const key = String(ret.returnNumber);
    const checkedAttr = App.Selection.isSelected(App.State.selectedReturns, key) ? 'checked' : '';

    return `
      <tr data-return-key="${escapeHtml(key)}">
        <td class="text-center">
          <input type="checkbox" class="form-check-input return-select-chk" data-key="${escapeHtml(key)}" ${checkedAttr} onchange="App.Return.onRowSelectChange()">
        </td>
        <td><strong class="text-primary">${escapeHtml(ret.returnNumber || '')}</strong></td>
        <td>${billBadge}</td>
        <td>${escapeHtml(ret.returnDate || '')}</td>
        <td>${escapeHtml(ret.vendor || '')}</td>
        <td><small class="text-muted">${itemsPreview}</small></td>
        <td>${escapeHtml(String(ret.totalQty ?? 0))}</td>
        <td class="text-danger fw-bold">${formatCurrency(ret.totalAmount)}</td>
        <td>
          <button class="btn btn-sm btn-outline-dark w-100 mb-1 btn-action"
                  data-action="return-print"
                  data-index="${index}">Print</button>
          <button class="btn btn-sm btn-outline-primary w-100 mb-1 btn-action"
                  data-action="return-edit"
                  data-index="${index}">Edit Details</button>
          <button class="btn btn-sm btn-danger w-100"
                  data-action="return-delete"
                  data-returnnumber="${escapeHtml(ret.returnNumber || '')}">Delete</button>
        </td>
      </tr>`;
  },

  // Patches one already-loaded return's data + its rendered <tr> after an
  // edit save, instead of a full loadData() reload -- keyed by the
  // PRE-edit returnNumber (existingReturnNumber), since that's how the row
  // is currently indexed in globalReturns/the DOM. Returns false -- caller
  // should fall back to loadData() -- if the return isn't currently loaded
  // or isn't on the displayed page.
  patchRowInPlace(freshReturn, oldReturnNumber) {
    const oldKey = String(oldReturnNumber);
    const existing = App.State.globalReturns.find(r => String(r.returnNumber) === oldKey);
    if (!existing) return false;

    Object.assign(existing, freshReturn);

    const tr = document.querySelector(`#returnTableBody tr[data-return-key="${CSS.escape(oldKey)}"]`);
    if (!tr) return false;

    tr.outerHTML = this.rowHtml(existing);
    return true;
  },

  toggleSelectAll(masterChk) {
    App.Selection.toggleAll(App.State.selectedReturns, 'return-select-chk', masterChk);
    this.updateBulkButtons();
  },

  onRowSelectChange() {
    App.Selection.syncFromRows(App.State.selectedReturns, 'return-select-chk', 'selectAllReturns');
    this.updateBulkButtons();
  },

  updateBulkButtons() {
    const count = App.State.selectedReturns.length;
    App.Selection.updateButton('btnBulkDeleteReturns', count, '<i class="bi bi-trash"></i> Delete Selected');
  },

  // Single-record print for the per-row "Print" button. Reuses the shared
  // bulk-print container (App.Print.triggerBulk) with a one-element array
  // instead of a dedicated static template -- same approach as
  // App.Issue's print (there's no per-row Return print template to
  // maintain in sync separately).
  print(index) {
    if (typeof App.Print === 'undefined') {
      App.Utils.notPortedYet('Printing');
      return;
    }

    const ret = App.State.globalReturns[index];
    if (!ret) return;

    const title = `Return_${ret.returnNumber}_${String(ret.vendor || '')
      .replace(/[^a-zA-Z0-9 \-]/g, '')
      .trim()
      .replace(/\s+/g, '_')}`;
    App.Print.triggerBulk([ret], r => this.buildReturnPrintPageHtml(r), title);
  },

  // Builds a fully self-contained "Goods Returned" page for print/bulk print.
  buildReturnPrintPageHtml(ret) {
    const BRAND = '#FD7E14';

    const bodyHtml = (ret.items || []).map((item, idx) => {
      const rowBg = idx % 2 === 0 ? '#ffffff' : '#FFF6EE';
      const rowStyle = `background-color:${rowBg};-webkit-print-color-adjust:exact;print-color-adjust:exact;page-break-inside:avoid;break-inside:avoid;`;
      return `
      <tr style="${rowStyle}">
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:center;color:#999;font-weight:600;">${idx + 1}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:left;font-weight:600;">${escapeHtml(item.name || '')}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:left;color:#555;">${escapeHtml(item.narration || '')}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:center;">${escapeHtml(item.size || '')}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:center;font-weight:600;">${escapeHtml(String(toNumber(item.qty)))} ${escapeHtml(item.unit || 'Pcs')}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:right;">${formatCurrency(item.price)}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:left;color:#555;">${escapeHtml(item.reason || '')}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:right;font-weight:700;color:${BRAND};-webkit-print-color-adjust:exact;print-color-adjust:exact;">${formatCurrency(item.lineTotal)}</td>
      </tr>`;
    }).join('');

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
          <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Return #</span>
          <div style="font-size:15px;font-weight:700;color:${BRAND};-webkit-print-color-adjust:exact;print-color-adjust:exact;">${escapeHtml(ret.returnNumber || '')}</div>
        </div>
        <div style="flex:2;text-align:center;">
          <span style="font-size:18px;font-weight:800;color:${BRAND};letter-spacing:3px;text-transform:uppercase;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
            Goods Returned
          </span>
        </div>
        <div style="flex:1;text-align:right;">
          <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Date</span>
          <div style="font-size:13px;font-weight:700;color:#1a1a1a;">${escapeHtml(ret.returnDate || '')}</div>
        </div>
      </div>

      <div style="height:1px;background:#bbb;margin-bottom:14px;"></div>

      <div style="margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid #ccc;">
        <div style="display:flex;gap:16px;">
          <div style="flex:1;">
            <div style="margin-bottom:6px;">
              <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Vendor</span>
              <div style="font-weight:700;font-size:13px;color:#1a1a1a;margin-top:1px;">${escapeHtml(ret.vendor || '')}</div>
            </div>
            <div>
              <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Remarks</span>
              <div style="font-size:11px;color:#333;margin-top:1px;white-space:pre-wrap;">${escapeHtml(ret.remarks || '')}</div>
            </div>
          </div>
          <div style="flex:1;">
            <div style="margin-bottom:6px;">
              <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Contact</span>
              <div style="font-size:11px;color:#333;margin-top:1px;">${escapeHtml(ret.contact || '')}</div>
            </div>
            <div>
              <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Bill Reference</span>
              <div style="font-size:11px;color:#333;margin-top:1px;font-weight:600;">${escapeHtml(ret.billNumber || 'N/A')}</div>
            </div>
          </div>
        </div>
      </div>

      <table style="width:100%;border-collapse:collapse;margin-bottom:14px;font-size:12px;">
        <thead style="background-color:${BRAND};color:#fff;text-align:center;font-weight:700;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
          <tr>
            <th style="padding:6px;border:1px solid #bbb;text-align:center;width:5%;">#</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:left;width:20%;">Item Name</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:left;width:17%;">Narration</th>
            <th style="padding:6px;border:1px solid #bbb;width:9%;">Size</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:center;width:11%;">Qty</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:right;width:10%;">Rate</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:left;width:16%;">Reason</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:right;width:12%;">Total</th>
          </tr>
        </thead>
        <tbody style="color:#1a1a1a;text-align:center;">${bodyHtml}</tbody>
      </table>

      <div style="text-align:right;margin-bottom:16px;padding:8px 0 0 0;border-top:2px solid ${BRAND};page-break-inside:avoid;break-inside:avoid;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
        <span style="font-size:13px;font-weight:600;color:#1a1a1a;">Grand Total:&nbsp;&nbsp;</span>
        <span style="font-size:15px;font-weight:800;color:${BRAND};-webkit-print-color-adjust:exact;print-color-adjust:exact;">
          &#8377;${toNumber(ret.totalAmount).toFixed(2)}
        </span>
      </div>

      <div style="display:flex;justify-content:flex-end;page-break-inside:avoid;break-inside:avoid;">
        <div style="width:180px;text-align:center;padding-top:5px;border-top:2px solid ${BRAND};-webkit-print-color-adjust:exact;print-color-adjust:exact;">
          <span style="font-size:10px;color:#666;letter-spacing:0.5px;font-style:italic;">Authorized Signature</span>
        </div>
      </div>
    </div>`;
  },

  async bulkDelete() {
    const selected = App.State.selectedReturns;
    if (!selected.length) return;

    App.Utils.confirmAction(
      `Are you sure you want to permanently delete ${selected.length} selected return(s) and all their items?`,
      async () => {
        try {
          const res = await Api.mutate('deleteReturnsBulk', selected);
          App.Utils.showToast(res?.message || 'Delete completed.', !res?.success);
          if (res?.success) {
            const deletedIds = new Set((res.data?.deletedIds || []).map(id => String(id).toLowerCase()));
            App.State.globalReturns = App.State.globalReturns.filter(ret => !deletedIds.has(String(ret.returnNumber).toLowerCase()));
            App.State.filteredReturns = App.State.filteredReturns.filter(ret => !deletedIds.has(String(ret.returnNumber).toLowerCase()));
            App.State.selectedReturns = [];
            this.renderTable();
          }
        } catch (err) {
          App.Utils.showToast(err.message || 'Failed to delete returns.', true);
        }
      }
    );
  },

  // Looks up a vendor's contact, mirroring App.Bill.updateBillContactForVendor
  // but targeting the Return form's #returnContact instead.
  updateReturnContactForVendor(vendorName) {
    const contactInput = document.getElementById('returnContact');
    if (!contactInput) return;
    const vendor = (App.State.globalVendors || []).find(
      v => App.Utils.sameText(v.name, vendorName) && v.contact
    );
    if (vendor) {
      contactInput.value = vendor.contact;
      return;
    }
    const match = App.State.globalBills.find(
      b => App.Utils.sameText(b.vendor, vendorName) && b.contact
    );
    contactInput.value = match?.contact || '';
  },

  openReturnModal() {
    document.getElementById('returnForm')?.reset();

    const existingReturnNumber = document.getElementById('existingReturnNumber');
    if (existingReturnNumber) existingReturnNumber.value = '';

    const modalTitle = document.getElementById('returnModalTitle');
    if (modalTitle) modalTitle.innerText = 'Log Goods Returned to Vendor';

    const submitBtn = document.getElementById('returnSubmitBtn');
    if (submitBtn) submitBtn.innerText = 'Return Goods';

    const returnDateInput = document.getElementById('returnDateInput');
    if (returnDateInput) returnDateInput.value = todayIso();

    const returnVendor = document.getElementById('returnVendor');
    if (returnVendor) {
      if (
        window.jQuery?.fn?.select2 &&
        window.jQuery(returnVendor).data('select2')
      ) {
        window.jQuery(returnVendor).val(null).trigger('change');
      } else {
        returnVendor.value = '';
      }
      returnVendor.disabled = false;
    }

    const contact = document.getElementById('returnContact');
    if (contact) contact.value = '';

    const tbody = document.getElementById('returnItemsBody');
    if (tbody) tbody.innerHTML = this.getRowHtml();

    const printBtn = document.getElementById('returnModalPrintBtn');
    if (printBtn) printBtn.style.display = 'none';

    App.Utils.setFormButtonsForMode('returnCancelBtn', 'returnExitBtn', 'returnSubmitBtn', false, 'Return Goods');
    App.Nav.clear('returnGoodsModal');
    safeModalShow('returnGoodsModal');
  },

  // Print button inside returnGoodsModal itself (edit mode only).
  printCurrent() {
    if (typeof App.Print === 'undefined') {
      App.Utils.notPortedYet('Printing');
      return;
    }
    const returnNumber = document.getElementById('existingReturnNumber')?.value;
    if (!returnNumber) return;
    const index = App.State.globalReturns.findIndex(r => String(r.returnNumber) === String(returnNumber));
    if (index === -1) return;
    this.print(index);
  },

  openEditModal(index) {
    const ret = App.State.globalReturns[index];
    if (!ret) {
      App.Utils.showToast('Return record not found.', true);
      return;
    }

    document.getElementById('returnForm')?.reset();

    const existingReturnNumber = document.getElementById('existingReturnNumber');
    if (existingReturnNumber) existingReturnNumber.value = ret.returnNumber || '';

    const modalTitle = document.getElementById('returnModalTitle');
    if (modalTitle) modalTitle.innerText = `Edit Return #${ret.returnNumber}`;

    const submitBtn = document.getElementById('returnSubmitBtn');
    if (submitBtn) submitBtn.innerText = 'Update Return';

    const vendorSelect = document.getElementById('returnVendor');
    if (vendorSelect) {
      if (
        vendorSelect.tagName === 'SELECT' &&
        ret.vendor &&
        !Array.from(vendorSelect.options).some(o => App.Utils.sameText(o.value, ret.vendor))
      ) {
        vendorSelect.add(new Option(ret.vendor, ret.vendor, true, true));
      }
      if (
        window.jQuery?.fn?.select2 &&
        window.jQuery(vendorSelect).data('select2')
      ) {
        window.jQuery(vendorSelect).val(ret.vendor || '').trigger('change');
      } else {
        vendorSelect.value = ret.vendor || '';
      }
      vendorSelect.disabled = false;
    }

    const contactInput = document.getElementById('returnContact');
    if (contactInput) contactInput.value = ret.contact || '';

    const returnNumberInput = document.querySelector('input[name="returnNumber"]');
    if (returnNumberInput) returnNumberInput.value = ret.returnNumber || '';

    const returnDateInput = document.getElementById('returnDateInput');
    if (returnDateInput) returnDateInput.value = String(ret.returnDateRaw || '').split('T')[0];

    const billNumberInput = document.getElementById('returnBillNumber');
    if (billNumberInput) billNumberInput.value = ret.billNumber || '';

    const remarksInput = document.querySelector('#returnForm input[name="remarks"]');
    if (remarksInput) remarksInput.value = ret.remarks || '';

    const tbody = document.getElementById('returnItemsBody');
    if (tbody) {
      tbody.innerHTML =
        (ret.items || []).map(item => this.getRowHtml(item)).join('') ||
        this.getRowHtml();
    }

    const printBtn = document.getElementById('returnModalPrintBtn');
    if (printBtn) printBtn.style.display = '';

    App.Utils.setFormButtonsForMode('returnCancelBtn', 'returnExitBtn', 'returnSubmitBtn', true, 'Update Return');
    App.Nav.register(
      'returnGoodsModal',
      (App.State.filteredReturns || []).map(r => r.returnNumber),
      ret.returnNumber,
      (returnNumber) => {
        const idx = App.State.globalReturns.findIndex(r => String(r.returnNumber) === String(returnNumber));
        if (idx !== -1) this.openEditModal(idx);
      }
    );
    safeModalShow('returnGoodsModal');
  },

  addRow() {
    const tbody = document.getElementById('returnItemsBody');
    if (!tbody) return;
    tbody.insertAdjacentHTML('beforeend', this.getRowHtml());
  },

  getRowHtml(item = {}) {
    const rowUid = `return-${++App.State.rowSeq}`;
    return `
    <tr data-row-uid="${rowUid}">
      <td><input type="text"   class="form-control r-item-name"  list="itemList" value="${escapeHtml(item.name || '')}" required></td>
      <td><input type="text"   class="form-control r-item-size"  list="sizeList-${rowUid}" value="${escapeHtml(item.size || '')}">
          <datalist class="row-size-list" id="sizeList-${rowUid}"></datalist></td>
      <td><input type="text"   class="form-control r-item-narration" value="${escapeHtml(item.narration || '')}"></td>
      <td><input type="number" class="form-control r-item-qty"  step="0.01" value="${escapeHtml(String(item.qty ?? ''))}" required></td>
      <td><input type="text"   class="form-control item-unit"   list="unitList" value="${escapeHtml(item.unit || 'Pcs')}"></td>
      <td><input type="number" class="form-control r-item-price" step="0.01"   value="${escapeHtml(String(item.price ?? ''))}"></td>
      <td><input type="text"   class="form-control r-item-reason" value="${escapeHtml(item.reason || '')}" placeholder="Defective, excess..."></td>
      <td><button type="button" class="btn btn-outline-danger btn-sm" data-action="remove-row">✕</button></td>
    </tr>`;
  },

  serializeForm() {
    const returnVendor = document.getElementById('returnVendor');
    const wasDisabled = returnVendor?.disabled ?? false;
    if (wasDisabled && returnVendor) returnVendor.disabled = false;

    const form = document.getElementById('returnForm');
    const formData = Object.fromEntries(new FormData(form));

    if (wasDisabled && returnVendor) returnVendor.disabled = true;

    const items = [];
    $$('#returnItemsBody tr').forEach(row => {
      const name = $('.r-item-name', row)?.value?.trim();
      if (!name) return;

      items.push({
        name,
        size: $('.r-item-size', row)?.value?.trim() || '',
        narration: $('.r-item-narration', row)?.value?.trim() || '',
        unit: $('.item-unit', row)?.value?.trim() || 'Pcs',
        qty: toNumber($('.r-item-qty', row)?.value),
        price: toNumber($('.r-item-price', row)?.value),
        reason: $('.r-item-reason', row)?.value?.trim() || ''
      });
    });

    formData.items = JSON.stringify(items);
    return { formData, items };
  },

  async delete(returnNumber) {
    App.Utils.confirmAction(
      `Are you sure you want to permanently delete Return #${returnNumber} and all its items?`,
      async () => {
        try {
          const res = await Api.mutate('deleteReturn', returnNumber);
          App.Utils.showToast(res?.message || 'Return deleted.', !res?.success);
          if (res?.success) await App.Return.loadData();
        } catch (err) {
          App.Utils.showToast(
            err.message || 'Failed to delete Return.',
            true
          );
        }
      }
    );
  }
};

// ── Wastage Log -- nested inside the Return Ledger tab/view ────────────
App.Wastage = {
  _reviewOpen: false,

  async loadData() {
    const tbody = document.getElementById('wastageTableBody');
    if (tbody)
      tbody.innerHTML = '<tr><td colspan="7" class="text-center p-4">Fetching Wastage Records…</td></tr>';

    try {
      const res = await Api.call('getWastageData');
      if (!res?.success) {
        App.Utils.showToast(res?.message || 'Failed to load wastage records.', true);
        return;
      }
      App.State.globalWastage = Array.isArray(res.data) ? res.data : [];
      App.State.filteredWastage = [...App.State.globalWastage];
      App.State.wastageCurrentPage = 1;
      App.State.wastageSearchTerm = '';
      App.State.wastageDateFilter = '';
      App.State.selectedWastage = [];
      this.renderTable();
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to load wastage records.', true);
    }
  },

  toggleReview() {
    this._reviewOpen = !this._reviewOpen;
    const section = document.getElementById('wastageReviewSection');
    const btn = document.getElementById('btnToggleWastageReview');
    if (!section) return;

    if (this._reviewOpen) {
      section.style.display = 'block';
      if (btn) btn.innerHTML = '<i class="bi bi-eye-slash me-2"></i>Hide Wastage';
      if (!App.State.globalWastage.length) this.loadData();
      else this.renderTable();
    } else {
      section.style.display = 'none';
      if (btn) btn.innerHTML = '<i class="bi bi-eye me-2"></i>Review Wastage';
    }
  },

  filterData(searchTerm) {
    App.State.wastageSearchTerm = String(searchTerm || '');
    this.applyFilters();
  },

  filterByDate(dateValue) {
    App.State.wastageDateFilter = String(dateValue || '');
    this.applyFilters();
  },

  applyFilters() {
    const term = App.State.wastageSearchTerm.toLowerCase().trim();
    const dateFilter = App.State.wastageDateFilter;

    App.State.filteredWastage = App.State.globalWastage.filter(w => {
      if (dateFilter && dateToInputValue(w.dateRaw, w.date) !== dateFilter) return false;
      if (term) {
        const itemsText = (w.items || []).map(it =>
          `${it.name || ''} ${it.size || ''} ${it.reason || ''}`
        ).join(' ');
        const haystack = `${w.wastageId || ''} ${w.vendor || ''} ${itemsText} ${w.remarks || ''}`;
        if (!App.Utils.matchesKeywords(haystack, term)) return false;
      }
      return true;
    });

    App.State.wastageCurrentPage = 1;
    this.renderTable();
  },

  changePage(page) {
    App.State.wastageCurrentPage = App.Utils.clampPage(
      page, App.State.filteredWastage.length, App.State.wastageRowsPerPage
    );
    this.renderTable();
  },

  renderTable() {
    const tbody = document.getElementById('wastageTableBody');
    if (!tbody) return;

    const emptyState = document.getElementById('wastageEmptyState');
    if (!App.State.filteredWastage.length) {
      tbody.innerHTML = '';
      if (emptyState) emptyState.style.display = 'block';
      App.Utils.renderPagination('wastagePagination', 0, 1, App.State.wastageRowsPerPage, 'wastage-page', 'Wastage');
      this.updateBulkButtons();
      return;
    }
    if (emptyState) emptyState.style.display = 'none';

    const { filteredWastage, wastageCurrentPage: cur, wastageRowsPerPage: rpp } = App.State;
    const start = (cur - 1) * rpp;
    const pageItems = filteredWastage.slice(start, start + rpp);

    const selectAllChk = document.getElementById('selectAllWastage');
    if (selectAllChk) {
      selectAllChk.checked = pageItems.length > 0 &&
        pageItems.every(w => App.Selection.isSelected(App.State.selectedWastage, String(w.wastageId)));
    }

    tbody.innerHTML = pageItems.map(w => {
      const key = String(w.wastageId);
      const checkedAttr = App.Selection.isSelected(App.State.selectedWastage, key) ? 'checked' : '';

      const itemsPreview = (w.items || []).slice(0, 3).map(it => {
        const namePart = escapeHtml(it.name || '—');
        const sizePart = it.size ? ` (${escapeHtml(it.size)})` : '';
        const reasonPart = it.reason ? ` — <em>${escapeHtml(it.reason)}</em>` : '';
        return `${namePart}${sizePart} ×${it.qty}${reasonPart}`;
      }).join('<br>') + (w.items.length > 3 ? `<br><em>+${w.items.length - 3} more…</em>` : '');

      const vendorBadge = w.vendor
        ? `<span class="badge bg-secondary">${escapeHtml(w.vendor)}</span>`
        : '<span class="text-muted">—</span>';

      return `
      <tr>
        <td class="text-center">
          <input type="checkbox" class="form-check-input wastage-select-chk" data-key="${escapeHtml(key)}" ${checkedAttr} onchange="App.Wastage.onRowSelectChange()">
        </td>
        <td><strong class="text-warning">${escapeHtml(w.wastageId || '')}</strong></td>
        <td>${escapeHtml(w.date || '')}</td>
        <td>${vendorBadge}</td>
        <td><small class="text-muted">${itemsPreview}</small></td>
        <td class="text-center fw-bold">${escapeHtml(String(w.totalQty ?? 0))}</td>
        <td>
          <button class="btn btn-sm btn-outline-primary w-100 mb-1"
                  onclick="App.Wastage.openEditModal('${escapeHtml(key)}')">Edit</button>
          <button class="btn btn-sm btn-danger w-100"
                  onclick="App.Wastage.deleteSingle('${escapeHtml(key)}')">Delete</button>
        </td>
      </tr>`;
    }).join('');

    App.Utils.renderPagination('wastagePagination', filteredWastage.length, cur, rpp, 'wastage-page', 'Wastage');
    this.updateBulkButtons();
  },

  toggleSelectAll(masterChk) {
    App.Selection.toggleAll(App.State.selectedWastage, 'wastage-select-chk', masterChk);
    this.updateBulkButtons();
  },

  onRowSelectChange() {
    App.Selection.syncFromRows(App.State.selectedWastage, 'wastage-select-chk', 'selectAllWastage');
    this.updateBulkButtons();
  },

  updateBulkButtons() {
    const count = App.State.selectedWastage.length;
    const printBtn = document.getElementById('btnPrintSelectedWastage');
    const deleteBtn = document.getElementById('btnBulkDeleteWastage');
    if (printBtn) {
      printBtn.textContent = count > 0 ? `Print Selected (${count})` : 'Print Selected';
      printBtn.classList.toggle('d-none', count === 0);
    }
    App.Selection.updateButton('btnBulkDeleteWastage', count, '<i class="bi bi-trash"></i> Delete Selected');
  },

  openWastageModal() {
    document.getElementById('wastageForm')?.reset();
    this.resetToCreateMode();
    const dateInput = document.getElementById('wastageDateInput');
    if (dateInput) dateInput.value = todayIso();
    const tbody = document.getElementById('wastageItemsBody');
    if (tbody) tbody.innerHTML = this.getRowHtml();
    safeModalShow('logWastageModal');
  },

  // Edits an existing wastage record in place, mirroring GAS's
  // updateWastage(wastageId, formData) (module_wastage.js) -- the item
  // rows are fully replaced, wastageId itself never changes.
  openEditModal(wastageId) {
    const w = App.State.globalWastage.find(rec => String(rec.wastageId) === String(wastageId));
    if (!w) return;

    document.getElementById('wastageForm')?.reset();
    this.resetToCreateMode();

    document.getElementById('wastageExistingId').value = w.wastageId;
    document.getElementById('wastageDateInput').value = dateToInputValue(w.dateRaw, w.date);
    document.getElementById('wastageVendor').value = w.vendor || '';
    document.querySelector('#wastageForm [name="remarks"]').value = w.remarks || '';

    const tbody = document.getElementById('wastageItemsBody');
    if (tbody) {
      tbody.innerHTML = (w.items || []).map(item => this.getRowHtml(item)).join('') || this.getRowHtml();
    }

    const title = document.getElementById('wastageModalTitle');
    if (title) title.innerHTML = `<i class="bi bi-pencil-square me-2"></i>Edit Wastage ${escapeHtml(w.wastageId)}`;
    const submitBtn = document.getElementById('wastageSubmitBtn');
    if (submitBtn) submitBtn.innerHTML = '<i class="bi bi-check2 me-1"></i>Update Wastage';

    safeModalShow('logWastageModal');
  },

  addRow() {
    const tbody = document.getElementById('wastageItemsBody');
    if (!tbody) return;
    tbody.insertAdjacentHTML('beforeend', this.getRowHtml());
  },

  getRowHtml(item = {}) {
    const rowUid = `wastage-${++App.State.rowSeq}`;
    return `
    <tr data-row-uid="${rowUid}">
      <td><input type="text" class="form-control w-item-name" list="itemList" value="${escapeHtml(item.name || '')}" required placeholder="Item name"></td>
      <td><input type="text" class="form-control w-item-size" list="sizeList-${rowUid}" value="${escapeHtml(item.size || '')}" placeholder="Size">
          <datalist class="row-size-list" id="sizeList-${rowUid}"></datalist></td>
      <td><input type="number" class="form-control w-item-qty" step="0.01" value="${escapeHtml(String(item.qty ?? ''))}" required min="0.01" placeholder="Qty"></td>
      <td><input type="text" class="form-control item-unit" list="unitList" value="${escapeHtml(item.unit || 'Pcs')}"></td>
      <td><input type="text" class="form-control w-item-reason" value="${escapeHtml(item.reason || '')}" required placeholder="e.g. Broken during cutting, Expired…"></td>
      <td><button type="button" class="btn btn-outline-danger btn-sm" data-action="remove-row">✕</button></td>
    </tr>`;
  },

  serializeForm() {
    const form = document.getElementById('wastageForm');
    const formData = Object.fromEntries(new FormData(form));
    formData.existingWastageId = document.getElementById('wastageExistingId')?.value || '';
    const items = [];
    $$('#wastageItemsBody tr').forEach(row => {
      const name = $('.w-item-name', row)?.value?.trim();
      if (!name) return;
      items.push({
        name,
        size: $('.w-item-size', row)?.value?.trim() || '',
        qty: toNumber($('.w-item-qty', row)?.value),
        unit: $('.item-unit', row)?.value?.trim() || 'Pcs',
        reason: $('.w-item-reason', row)?.value?.trim() || ''
      });
    });
    formData.items = JSON.stringify(items);
    return { formData, items };
  },

  async submit(e) {
    e.preventDefault();
    const { formData, items } = this.serializeForm();

    if (!items.length) {
      App.Utils.showToast('Add at least one item to log wastage.', true);
      return;
    }

    const missingReason = items.find(it => !it.reason);
    if (missingReason) {
      App.Utils.showToast(`Please enter a reason for "${missingReason.name}".`, true);
      return;
    }

    const isEdit = !!formData.existingWastageId;
    const submitBtn = document.getElementById('wastageSubmitBtn');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Saving…'; }

    try {
      const res = await Api.mutate('saveWastage', formData);
      App.Utils.showToast(res?.message || 'Wastage logged.', !res?.success);
      if (res?.success) {
        await this.loadData();
        this.enterSavedMode(res.data.wastageId);
      }
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to log wastage.', true);
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = isEdit
          ? '<i class="bi bi-check2 me-1"></i>Update Wastage'
          : '<i class="bi bi-exclamation-triangle me-1"></i>Log Wastage';
      }
    }
  },

  // Post-save state: form locks read-only, submit button swaps for
  // Print + Done so the just-saved record can be printed without leaving
  // the modal (mirrors Issue's identical enterSavedMode).
  enterSavedMode(wastageId) {
    document.getElementById('wastageSavedId').value = wastageId;
    this.setFormReadOnly(true);
    document.getElementById('wastageSubmitBtn').style.display = 'none';
    document.getElementById('wastagePrintBtn').style.display = '';
    document.getElementById('wastageDoneBtn').style.display = '';
  },

  setFormReadOnly(disabled) {
    const form = document.getElementById('wastageForm');
    if (!form) return;
    form.querySelectorAll('input, select, textarea').forEach(el => { el.disabled = disabled; });
    const addBtn = form.querySelector('button[onclick="App.Wastage.addRow()"]');
    if (addBtn) addBtn.disabled = disabled;
    form.querySelectorAll('#wastageItemsBody button[data-action="remove-row"]').forEach(el => {
      el.disabled = disabled;
    });
  },

  printCurrent() {
    const wastageId = document.getElementById('wastageSavedId')?.value;
    if (wastageId) this.print(wastageId);
  },

  done() {
    bootstrap.Modal.getInstance(document.getElementById('logWastageModal'))?.hide();
    this.resetToCreateMode();
  },

  resetToCreateMode() {
    const savedId = document.getElementById('wastageSavedId');
    if (savedId) savedId.value = '';
    const existingId = document.getElementById('wastageExistingId');
    if (existingId) existingId.value = '';
    this.setFormReadOnly(false);
    const title = document.getElementById('wastageModalTitle');
    if (title) title.innerHTML = '<i class="bi bi-exclamation-triangle me-2"></i>Log Component Wastage';
    const submitBtn = document.getElementById('wastageSubmitBtn');
    if (submitBtn) {
      submitBtn.style.display = '';
      submitBtn.innerHTML = '<i class="bi bi-exclamation-triangle me-1"></i>Log Wastage';
    }
    const printBtn = document.getElementById('wastagePrintBtn');
    if (printBtn) printBtn.style.display = 'none';
    const doneBtn = document.getElementById('wastageDoneBtn');
    if (doneBtn) doneBtn.style.display = 'none';
  },

  async deleteSingle(wastageId) {
    App.Utils.confirmAction(
      `Delete wastage record ${wastageId} and all its items?`,
      async () => {
        try {
          const res = await Api.mutate('deleteWastageBulk', [wastageId]);
          App.Utils.showToast(res?.message || 'Deleted.', !res?.success);
          if (res?.success) {
            const deleted = new Set((res.data?.deletedIds || [wastageId]).map(id => String(id).toLowerCase()));
            App.State.globalWastage = App.State.globalWastage.filter(w => !deleted.has(String(w.wastageId).toLowerCase()));
            App.State.filteredWastage = App.State.filteredWastage.filter(w => !deleted.has(String(w.wastageId).toLowerCase()));
            App.State.selectedWastage = [];
            this.renderTable();
          }
        } catch (err) {
          App.Utils.showToast(err.message || 'Failed to delete.', true);
        }
      }
    );
  },

  async bulkDelete() {
    const selected = App.State.selectedWastage;
    if (!selected.length) return;

    App.Utils.confirmAction(
      `Permanently delete ${selected.length} wastage record(s)?`,
      async () => {
        try {
          const res = await Api.mutate('deleteWastageBulk', selected);
          App.Utils.showToast(res?.message || 'Delete completed.', !res?.success);
          if (res?.success) {
            const deletedIds = new Set((res.data?.deletedIds || []).map(id => String(id).toLowerCase()));
            App.State.globalWastage = App.State.globalWastage.filter(w => !deletedIds.has(String(w.wastageId).toLowerCase()));
            App.State.filteredWastage = App.State.filteredWastage.filter(w => !deletedIds.has(String(w.wastageId).toLowerCase()));
            App.State.selectedWastage = [];
            this.renderTable();
          }
        } catch (err) {
          App.Utils.showToast(err.message || 'Failed to delete wastage.', true);
        }
      }
    );
  },

  // Per-record HTML block, shared by printSelected() and the single-record
  // print(wastageId) used by the post-save Print button (enterSavedMode).
  buildWastageEntryHtml(w) {
    const itemRows = (w.items || []).map(it => `
        <tr>
          <td style="padding:6px 8px; border:1px solid #dee2e6;">${escapeHtml(it.name || '')}${it.size ? ` <em>(${escapeHtml(it.size)})</em>` : ''}</td>
          <td style="padding:6px 8px; border:1px solid #dee2e6;">${escapeHtml(String(it.qty || ''))} ${escapeHtml(it.unit || '')}</td>
          <td style="padding:6px 8px; border:1px solid #dee2e6;">${escapeHtml(it.reason || '—')}</td>
        </tr>`).join('');

    const vendorLine = w.vendor ? `<br><small><strong>Vendor:</strong> ${escapeHtml(w.vendor)}</small>` : '';
    const remarksLine = w.remarks ? `<br><small><strong>Remarks:</strong> ${escapeHtml(w.remarks)}</small>` : '';

    return `
      <div class="wastage-entry" style="page-break-inside:avoid; margin-bottom:24px; border:1px solid #dee2e6; border-radius:6px; padding:16px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:10px;">
          <div>
            <strong style="font-size:15px;">${escapeHtml(w.wastageId)}</strong>
            ${vendorLine}
            ${remarksLine}
          </div>
          <div class="text-end">
            <span style="background:#fff3cd; padding:4px 10px; border-radius:4px; font-weight:bold;">${escapeHtml(w.date || '')}</span>
          </div>
        </div>
        <table style="width:100%; border-collapse:collapse; font-size:13px;">
          <thead>
            <tr style="background:#f8f9fa;">
              <th style="padding:6px 8px; border:1px solid #dee2e6; text-align:left;">Item</th>
              <th style="padding:6px 8px; border:1px solid #dee2e6; text-align:left; width:15%;">Qty</th>
              <th style="padding:6px 8px; border:1px solid #dee2e6; text-align:left; width:35%;">Reason</th>
            </tr>
          </thead>
          <tbody>
            ${itemRows}
          </tbody>
        </table>
        <div style="margin-top:8px; font-size:12px; color:#666;">
          Total Qty: <strong>${escapeHtml(String(w.totalQty ?? 0))}</strong>
        </div>
      </div>`;
  },

  buildWastagePrintPageHtml(records) {
    const rows = records.map(w => this.buildWastageEntryHtml(w)).join('');
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Wastage Report</title>
  <style>
    body { font-family: Arial, sans-serif; font-size: 14px; margin: 24px; color: #212529; }
    h2 { margin-bottom: 4px; }
    .header-meta { color: #666; font-size: 12px; margin-bottom: 20px; }
    @media print { .no-print { display: none; } }
  </style>
</head>
<body>
  <h2>Wastage Report</h2>
  <div class="header-meta">Printed: ${new Date().toLocaleDateString('en-IN')} &nbsp;|&nbsp; Records: ${records.length}</div>
  ${rows}
  <script>window.onload = function(){ window.print(); }<\/script>
</body>
</html>`;
  },

  openPrintWindow(html) {
    const win = window.open('', '_blank');
    if (win) {
      win.document.write(html);
      win.document.close();
    } else {
      App.Utils.showToast('Pop-up blocked. Please allow pop-ups for this site to print.', true);
    }
  },

  // Opens its own popup window and writes self-contained print HTML
  // directly -- no App.Print dependency, unlike every other module's
  // print/bulkPrint. Ported in full, reachable immediately.
  printSelected() {
    const selected = App.State.selectedWastage;
    const records = App.State.globalWastage.filter(w => App.Selection.isSelected(selected, String(w.wastageId)));

    if (!records.length) {
      App.Utils.showToast('No wastage records selected to print.', true);
      return;
    }

    this.openPrintWindow(this.buildWastagePrintPageHtml(records));
  },

  // Single-record print, used by both each row's own Print action and the
  // post-save modal's Print button (printCurrent) -- a PWA-only addition,
  // no GAS equivalent (source has no per-row print for Wastage).
  print(wastageId) {
    const w = App.State.globalWastage.find(rec => String(rec.wastageId) === String(wastageId));
    if (!w) return;
    this.openPrintWindow(this.buildWastagePrintPageHtml([w]));
  }
};

// Form submit handlers + row-level listeners -- ported from
// Script_Core.html's returnForm/wastageForm submit blocks and the
// return/wastage-scoped delegated input listener. Adapted to Api.mutate
// for saveReturn/saveWastage (see module header comment).
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('returnForm')?.addEventListener('submit', e => {
    e.preventDefault();
    const { formData, items } = App.Return.serializeForm();
    if (!items.length) {
      App.Utils.showToast('Please add at least one item to the return.', true);
      return;
    }

    const isEdit = !!formData.existingReturnNumber;
    const confirmMsg = isEdit
      ? `Are you sure you want to update Return #${formData.returnNumber}?`
      : `Are you sure you want to record Return #${formData.returnNumber}? This will be debited from Stock.`;

    App.Utils.confirmAction(
      confirmMsg,
      async () => {
        setDisabled('returnSubmitBtn', true);
        try {
          const res = await Api.mutate('saveReturn', formData);
          if (res?.success && !isEdit) {
            // A brand-new return's sorted/paginated position can't be
            // determined cheaply on the client -- full reload here (an
            // edit doesn't need to, see App.Return.patchRowInPlace).
            await App.Return.loadData();
            App.Return.openReturnModal();
          } else if (res?.success && isEdit) {
            // Save (edit mode): patch just this one return's data + <tr>
            // in place instead of a full loadData() reload -- keyed by the
            // PRE-edit returnNumber (existingReturnNumber). Falls back to
            // a full reload if the return can't be patched.
            const patched = res.data && res.data.ret
              ? App.Return.patchRowInPlace(res.data.ret, formData.existingReturnNumber)
              : false;
            if (!patched) await App.Return.loadData();

            // Stay open on the SAME return instead of closing -- Exit
            // (App.Nav.exit) is the only way to close from here now.
            // returnNumber is user-editable (and auto-generated when
            // blank), so trust the server's own returned value (res.data)
            // to re-find this record.
            const returnNumber = res.data?.returnNumber;
            const freshIndex = App.State.globalReturns.findIndex(r => String(r.returnNumber) === String(returnNumber));
            if (freshIndex !== -1) {
              App.Return.openEditModal(freshIndex);
            } else {
              safeModalHide('returnGoodsModal');
            }
          } else {
            safeModalHide('returnGoodsModal');
          }
          App.Utils.showToast(res?.message || 'Return saved.', !res?.success, res?.success
            ? { type: 'return', value: res.data?.returnNumber || formData.returnNumber }
            : null);
        } catch (err) {
          App.Utils.showToast(err.message || 'Failed to save return.', true);
        } finally {
          setDisabled('returnSubmitBtn', false);
        }
      }
    );
  });

  document.getElementById('wastageForm')?.addEventListener('submit', e => App.Wastage.submit(e));

  document.getElementById('returnVendor')?.addEventListener('change', function () {
    App.Return.updateReturnContactForVendor(this.value);
  });

  // Filter each return/wastage row's size choices to sizes valid for the
  // entered item name.
  document.addEventListener('input', e => {
    if (e.target.matches('#returnItemsBody .r-item-name')) {
      App.Utils.applyDependentSizeList(e.target, '.r-item-size');
    }
    if (e.target.matches('#wastageItemsBody .w-item-name')) {
      App.Utils.applyDependentSizeList(e.target, '.w-item-size');
    }
  });
});
