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
// - Wastage is a sub-tab of this tab (switchSubTab), not the collapsible
//   section the source nested under the returns table, which took a scroll
//   past every return to reach.
// - A wastage line can be written off the Warehouse Pool as well as Items
//   Stock (migration 048): the form has a second table for processed items,
//   filled from getWarehousePoolData.

App.Return = {
  // Mirrors App.Item.ensureLoaded -- lets a caller outside the Return
  // Ledger tab (e.g. the Vendor Profile modal's Ledger tab) guarantee
  // globalReturns is populated without re-fetching if Return Ledger
  // already loaded it.
  async ensureLoaded() {
    if (App.State.globalReturns && App.State.globalReturns.length) return;
    await this.loadData();
  },

  // The tab's own entry point (core.js showTab). Returns always load --
  // other screens read them through ensureLoaded -- and the Wastage list
  // too when it is the sub-tab on show, so coming back to it after logging
  // wastage from the Dashboard lists that record.
  enterTab() {
    const loads = [this.loadData()];
    if (document.getElementById('wastageSubTab')?.style.display === 'block') {
      loads.push(App.Wastage.loadData());
    }
    return Promise.all(loads);
  },

  switchSubTab(id) {
    $$('.return-sub-tab').forEach(t => { t.style.display = t.id === id ? 'block' : 'none'; });
    $$('#returnSubTabs .nav-link').forEach(btn => btn.classList.toggle('active', btn.id === `btn-${id}`));

    // Fetched on every visit, as the Warehouse Pool sub-tab is: the list
    // can change while it is hidden (the Dashboard's Log Wastage tile).
    if (id === 'wastageSubTab') return App.Wastage.loadData();
    return Promise.resolve();
  },

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
      App.State.selectedReturns = [];
      // Re-applies the search, date window and order the toolbar is
      // showing, so a reload after a save never lists more than it says.
      this.applyFilters();

      // #returnVendor shares PO.populateVendorSelects' shared
      // `select.select2-vendor` target, but nothing ever called it from
      // the Return tab's own load path -- it only ever got populated as a
      // side effect of the PO or Vendor tab happening to load first (which
      // Init used to always do, unconditionally, every page load). Ensure
      // Vendor Master here so the dropdown is never just silently empty on
      // a session that lands directly on Return.
      // updateReturnContactForVendor falls back to Bill history for a
      // vendor with no Vendor Master contact of its own -- ensure it here
      // too rather than leaving that fallback silently empty.
      await Promise.all([
        App.Vendor ? App.Vendor.ensureLoaded() : Promise.resolve(),
        App.Bill ? App.Bill.ensureLoaded() : Promise.resolve()
      ]);
      if (App.PO && App.PO.populateVendorSelects) App.PO.populateVendorSelects();
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to load returns.', true);
    }
  },

  filterData(searchTerm) {
    App.State.returnSearchTerm = String(searchTerm || '');
    this.applyFilters();
  },

  // The date window, set from the toolbar's date button (App.ListControls).
  filterByDateRange() {
    App.Utils.readDateRange('return', 'returnDateFrom', 'returnDateTo');
    this.applyFilters();
  },

  clearDateRange() {
    App.Utils.clearDateRange('return', 'returnDateFrom', 'returnDateTo');
    this.applyFilters();
  },

  applyFilters() {
    const term = App.State.returnSearchTerm.toLowerCase().trim();
    const range = App.Utils.dateRange('return');

    App.State.filteredReturns = App.State.globalReturns.filter(ret => {
      if (!App.Utils.inDateRange(ret.returnDateRaw, ret.returnDate, range.from, range.to)) return false;

      if (term) {
        const itemsText = (ret.items || []).map(it => `${it.name || ''} ${it.size || ''} ${it.narration || ''}`).join(' ');
        const haystack = `${ret.returnNumber || ''} ${ret.billNumber || ''} ${ret.vendor || ''} ${itemsText}`;
        if (!App.Utils.matchesKeywords(haystack, term)) return false;
      }
      return true;
    });

    this.sortFiltered();
    App.State.returnCurrentPage = 1;
    this.renderTable();
  },

  // Orders picked from the toolbar's ⇅ menu or a sortable column header
  // (return_ledger.html). dateDesc is the order getReturnData already
  // sends, and the sort is stable, so the default view is unchanged: same
  // day, most recently logged first.
  SORT_COMPARATORS: {
    dateDesc: (a, b) => parseRecordDate(b.returnDateRaw, b.returnDate) - parseRecordDate(a.returnDateRaw, a.returnDate),
    dateAsc: (a, b) => parseRecordDate(a.returnDateRaw, a.returnDate) - parseRecordDate(b.returnDateRaw, b.returnDate),
    returnNumberDesc: (a, b) => (parseInt(String(b.returnNumber).replace(/\D/g, ''), 10) || 0) - (parseInt(String(a.returnNumber).replace(/\D/g, ''), 10) || 0),
    returnNumberAsc: (a, b) => (parseInt(String(a.returnNumber).replace(/\D/g, ''), 10) || 0) - (parseInt(String(b.returnNumber).replace(/\D/g, ''), 10) || 0),
    vendorAsc: (a, b) => String(a.vendor || '').localeCompare(String(b.vendor || '')),
    vendorDesc: (a, b) => String(b.vendor || '').localeCompare(String(a.vendor || '')),
    creditDesc: (a, b) => (b.totalAmount || 0) - (a.totalAmount || 0),
    creditAsc: (a, b) => (a.totalAmount || 0) - (b.totalAmount || 0)
  },

  sortFiltered() {
    const cmp = this.SORT_COMPARATORS[App.State.returnSortBy];
    if (cmp) App.State.filteredReturns.sort(cmp);
  },

  sortBy(value) {
    App.State.returnSortBy = value;
    this.sortFiltered();
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
        <td>${escapeHtml(App.Utils.formatNameCase(ret.vendor))}</td>
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
  // Shared with MApp -- see issue.js.
  buildReturnPrintPageHtml(ret) {
    return PrintTemplates.returnNote(ret, App.Print.templateDeps());
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

  // What this form reads from other modules: every row's Item and Size
  // suggestions come from Items Master (the shared #itemList datalist,
  // filled by App.Item.populateDatalists), the vendor dropdown from Vendor
  // Master, the contact fallback from Bill history. loadData ensured only
  // the last two, and the Dashboard's "Return Goods" tile opens this form
  // without loadData at all -- so on a session that had not first visited
  // Items Master, PO, Bill or Production, every row's item list was empty
  // (and, from the Dashboard, the vendor dropdown too). Ensured before the
  // form is shown, as App.PO.openCreateModal does.
  async ensureFormData() {
    await Promise.all([
      App.Item ? App.Item.ensureLoaded() : Promise.resolve(),
      App.Vendor ? App.Vendor.ensureLoaded() : Promise.resolve(),
      App.Bill ? App.Bill.ensureLoaded() : Promise.resolve()
    ]);
  },

  async openReturnModal() {
    await this.ensureFormData();

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

  async openEditModal(index) {
    const ret = App.State.globalReturns[index];
    if (!ret) {
      App.Utils.showToast('Return record not found.', true);
      return;
    }
    await this.ensureFormData();

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
        vendorSelect.add(new Option(App.Utils.formatNameCase(ret.vendor), ret.vendor, true, true));
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

// ── Wastage Log -- the Return Ledger tab's Wastage sub-tab ─────────────
App.Wastage = {
  // Warehouse Pool buckets a line can be written off, asked for each time
  // the form opens (loadPoolBuckets) -- so colours and Available are no
  // older than Api.call's 15-second read cache, which any save clears.
  _poolBuckets: [],

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
      App.State.selectedWastage = [];
      // Re-applies the search, date window and order the toolbar is
      // showing, so a reload after a save never lists more than it says.
      this.applyFilters();
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to load wastage records.', true);
    }
  },

  filterData(searchTerm) {
    App.State.wastageSearchTerm = String(searchTerm || '');
    this.applyFilters();
  },

  // The date window, set from the section's date button (App.ListControls).
  filterByDateRange() {
    App.Utils.readDateRange('wastage', 'wastageDateFrom', 'wastageDateTo');
    this.applyFilters();
  },

  clearDateRange() {
    App.Utils.clearDateRange('wastage', 'wastageDateFrom', 'wastageDateTo');
    this.applyFilters();
  },

  applyFilters() {
    const term = App.State.wastageSearchTerm.toLowerCase().trim();
    const range = App.Utils.dateRange('wastage');

    App.State.filteredWastage = App.State.globalWastage.filter(w => {
      if (!App.Utils.inDateRange(w.dateRaw, w.date, range.from, range.to)) return false;
      if (term) {
        // "pool" finds every record written off the Warehouse Pool.
        const itemsText = (w.items || []).map(it =>
          `${it.name || ''} ${it.size || ''} ${it.color || ''} ${it.productTag || ''} ${it.reason || ''}`
          + (it.sourceType === 'POOL' ? ' warehouse pool' : '')
        ).join(' ');
        const haystack = `${w.wastageId || ''} ${w.vendor || ''} ${itemsText} ${w.remarks || ''}`;
        if (!App.Utils.matchesKeywords(haystack, term)) return false;
      }
      return true;
    });

    this.sortFiltered();
    App.State.wastageCurrentPage = 1;
    this.renderTable();
  },

  // Orders picked from the section's ⇅ menu or a sortable column header
  // (return_ledger.html). dateDesc is getWastageData's own order, and the
  // sort is stable, so the default view is unchanged.
  SORT_COMPARATORS: {
    dateDesc: (a, b) => parseRecordDate(b.dateRaw, b.date) - parseRecordDate(a.dateRaw, a.date),
    dateAsc: (a, b) => parseRecordDate(a.dateRaw, a.date) - parseRecordDate(b.dateRaw, b.date),
    vendorAsc: (a, b) => String(a.vendor || '').localeCompare(String(b.vendor || '')),
    vendorDesc: (a, b) => String(b.vendor || '').localeCompare(String(a.vendor || '')),
    qtyDesc: (a, b) => (b.totalQty || 0) - (a.totalQty || 0),
    qtyAsc: (a, b) => (a.totalQty || 0) - (b.totalQty || 0)
  },

  sortFiltered() {
    const cmp = this.SORT_COMPARATORS[App.State.wastageSortBy];
    if (cmp) App.State.filteredWastage.sort(cmp);
  },

  sortBy(value) {
    App.State.wastageSortBy = value;
    this.sortFiltered();
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
        const isPool = it.sourceType === 'POOL';
        const namePart = escapeHtml(it.name || '—');
        // A pool line has no size; its colour (and product, if tagged) is
        // what tells its bucket apart.
        const detail = isPool ? [it.color, it.productTag].filter(Boolean).join(' · ') : it.size;
        const detailPart = detail ? ` (${escapeHtml(detail)})` : '';
        const poolBadge = isPool ? ' <span class="badge bg-secondary" title="Written off the Warehouse Pool">Pool</span>' : '';
        const reasonPart = it.reason ? ` — <em>${escapeHtml(it.reason)}</em>` : '';
        return `${namePart}${detailPart} ×${it.qty}${poolBadge}${reasonPart}`;
      }).join('<br>') + (w.items.length > 3 ? `<br><em>+${w.items.length - 3} more…</em>` : '');

      const vendorBadge = w.vendor
        ? `<span class="badge bg-secondary">${escapeHtml(App.Utils.formatNameCase(w.vendor))}</span>`
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

  // Every row's Item/Size suggestions and the vendor box read Items Master
  // (#itemList and #vendorList, App.Item.populateDatalists), which neither
  // this tab nor the Dashboard's "Log Wastage" tile ever loaded -- see
  // App.Return.ensureFormData. The Warehouse Pool rows read the pool's
  // buckets, and Process Master for the process names beside them.
  async ensureFormData() {
    await Promise.all([
      App.Item ? App.Item.ensureLoaded() : Promise.resolve(),
      App.Process ? App.Process.ensureLoaded() : Promise.resolve(),
      this.loadPoolBuckets()
    ]);
  },

  // Every bucket a line can be written off: the pool's own rows, less the
  // sub-group ones (countsTowardTotal false) -- a packing set recorded per
  // colour on units already counted under their main colour holds no stock
  // of its own, and saveWastage refuses them.
  async loadPoolBuckets() {
    try {
      const res = await Api.call('getWarehousePoolData');
      if (!res?.success) throw new Error(res?.message || 'The server refused the request.');
      this._poolBuckets = (Array.isArray(res.data) ? res.data : [])
        .filter(b => String(b.outputItemName || '').trim() && b.countsTowardTotal !== false);
    } catch (err) {
      this._poolBuckets = [];
      App.Utils.showToast(`Warehouse Pool items could not be loaded: ${err.message || err}`, true);
    }
    this.populatePoolItemList();
  },

  populatePoolItemList() {
    const list = document.getElementById('wastagePoolItemList');
    if (!list) return;
    const processNames = new Map((App.State.globalProcesses || []).map(p => [p.processId, p.processName]));
    const byName = new Map();
    this._poolBuckets.forEach(b => {
      const name = String(b.outputItemName).trim();
      const entry = byName.get(name.toLowerCase()) || { name, processes: new Set() };
      if (processNames.get(b.processId)) entry.processes.add(processNames.get(b.processId));
      byName.set(name.toLowerCase(), entry);
    });
    list.innerHTML = [...byName.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(e => `<option value="${escapeHtml(e.name)}"${e.processes.size
        ? ` label="${escapeHtml([...e.processes].join(', '))}"` : ''}></option>`)
      .join('');
  },

  async openWastageModal() {
    await this.ensureFormData();

    document.getElementById('wastageForm')?.reset();
    this.resetToCreateMode();
    const dateInput = document.getElementById('wastageDateInput');
    if (dateInput) dateInput.value = todayIso();
    const tbody = document.getElementById('wastageItemsBody');
    if (tbody) tbody.innerHTML = this.getRowHtml();
    const poolBody = document.getElementById('wastagePoolItemsBody');
    if (poolBody) poolBody.innerHTML = '';
    this.updatePoolEmptyHint();
    safeModalShow('logWastageModal');
  },

  // Edits an existing wastage record in place, mirroring GAS's
  // updateWastage(wastageId, formData) (module_wastage.js) -- the item
  // rows are fully replaced, wastageId itself never changes.
  async openEditModal(wastageId) {
    const w = App.State.globalWastage.find(rec => String(rec.wastageId) === String(wastageId));
    if (!w) return;
    await this.ensureFormData();

    document.getElementById('wastageForm')?.reset();
    this.resetToCreateMode();

    document.getElementById('wastageExistingId').value = w.wastageId;
    document.getElementById('wastageDateInput').value = dateToInputValue(w.dateRaw, w.date);
    document.getElementById('wastageVendor').value = w.vendor || '';
    document.querySelector('#wastageForm [name="remarks"]').value = w.remarks || '';

    const lines = w.items || [];
    const tbody = document.getElementById('wastageItemsBody');
    if (tbody) {
      tbody.innerHTML = lines.filter(item => item.sourceType !== 'POOL')
        .map(item => this.getRowHtml(item)).join('') || this.getRowHtml();
    }
    const poolBody = document.getElementById('wastagePoolItemsBody');
    if (poolBody) {
      poolBody.innerHTML = lines.filter(item => item.sourceType === 'POOL')
        .map(item => this.getPoolRowHtml(item)).join('');
    }
    this.updatePoolEmptyHint();

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

  // No `required` on a row's fields: a record can be all pool lines, and a
  // browser-required blank row here would refuse to submit it. A row with
  // no item name is skipped instead, and submit() checks the rest.
  getRowHtml(item = {}) {
    const rowUid = `wastage-${++App.State.rowSeq}`;
    return `
    <tr data-row-uid="${rowUid}">
      <td><input type="text" class="form-control w-item-name" list="itemList" value="${escapeHtml(item.name || '')}" placeholder="Item name"></td>
      <td><input type="text" class="form-control w-item-size" list="sizeList-${rowUid}" value="${escapeHtml(item.size || '')}" placeholder="Size">
          <datalist class="row-size-list" id="sizeList-${rowUid}"></datalist></td>
      <td><input type="number" class="form-control w-item-qty" step="0.01" value="${escapeHtml(String(item.qty ?? ''))}" min="0.01" placeholder="Qty"></td>
      <td><input type="text" class="form-control item-unit" list="unitList" value="${escapeHtml(item.unit || 'Pcs')}"></td>
      <td><input type="text" class="form-control w-item-reason" value="${escapeHtml(item.reason || '')}" placeholder="e.g. Broken during cutting, Expired…"></td>
      <td><button type="button" class="btn btn-outline-danger btn-sm" data-action="remove-row">✕</button></td>
    </tr>`;
  },

  // ── Warehouse Pool rows ──────────────────────────────────────────────
  // One bucket per (Output Item Name, Product Tag, Colour), the key
  // warehouse_service gives it. The <select> carries tag and colour joined
  // by U+241F, the separator the Notify links already use for two-part keys.
  BUCKET_SEP: '␟',

  poolBucketValue(productTag, color) {
    return `${productTag || ''}${this.BUCKET_SEP}${color || ''}`;
  },

  bucketsFor(name) {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return [];
    return this._poolBuckets
      .filter(b => String(b.outputItemName).trim().toLowerCase() === key)
      .sort((a, b) => String(a.color || '').localeCompare(String(b.color || ''))
        || String(a.productTag || '').localeCompare(String(b.productTag || '')));
  },

  _bucketLabel(productTag, color) {
    return [color || 'No colour', productTag ? `Product ${productTag}` : ''].filter(Boolean).join(' · ');
  },

  // `selected` is the line's saved {productTag, color} when editing, else
  // null. An item with just one bucket picks it; with several, nothing is
  // picked until the operator chooses -- a colour guessed for them would
  // take the units off the wrong shelf.
  _bucketOptionsHtml(name, selected) {
    const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
    const buckets = this.bucketsFor(name);
    const chosen = selected
      ? buckets.find(b => same(b.productTag, selected.productTag) && same(b.color, selected.color))
      : (buckets.length === 1 ? buckets[0] : null);

    const options = buckets.map(b => `<option value="${escapeHtml(this.poolBucketValue(b.productTag, b.color))}"${
      b === chosen ? ' selected' : ''}>${escapeHtml(`${this._bucketLabel(b.productTag, b.color)} — ${formatQty(b.availableQty)} available`)}</option>`);

    // A record saved against a bucket the pool no longer lists keeps it, so
    // opening the record to correct its date does not quietly move or drop
    // the write-off. saveWastage accepts a bucket the record already had.
    if (selected && !chosen && String(name || '').trim()) {
      options.unshift(`<option value="${escapeHtml(this.poolBucketValue(selected.productTag, selected.color))}" selected>${
        escapeHtml(`${this._bucketLabel(selected.productTag, selected.color)} — no longer in the pool`)}</option>`);
    }
    if (!options.length) {
      return `<option value="">${String(name || '').trim() ? 'Not in the Warehouse Pool' : 'Choose the item first'}</option>`;
    }
    if (!selected && !chosen) options.unshift('<option value="" selected>Choose a colour…</option>');
    return options.join('');
  },

  getPoolRowHtml(item = {}) {
    const rowUid = `wastage-pool-${++App.State.rowSeq}`;
    const selected = item.name ? { productTag: item.productTag || '', color: item.color || '' } : null;
    return `
    <tr data-row-uid="${rowUid}">
      <td><input type="text" class="form-control wp-item-name" list="wastagePoolItemList" value="${escapeHtml(item.name || '')}" placeholder="Painted frame, fitted rim…" aria-label="Processed item"></td>
      <td><select class="form-select wp-bucket" aria-label="Colour / Product">${this._bucketOptionsHtml(item.name || '', selected)}</select></td>
      <td><input type="number" class="form-control wp-qty" step="1" min="1" value="${escapeHtml(String(item.qty ?? ''))}" placeholder="Qty" aria-label="Qty in pieces"></td>
      <td><input type="text" class="form-control wp-reason" value="${escapeHtml(item.reason || '')}" placeholder="e.g. Paint run, dent, weld crack…" aria-label="Reason for wastage"></td>
      <td><button type="button" class="btn btn-outline-danger btn-sm wp-remove" onclick="App.Wastage.removePoolRow(this)" aria-label="Remove">✕</button></td>
    </tr>`;
  },

  addPoolRow() {
    const tbody = document.getElementById('wastagePoolItemsBody');
    if (!tbody) return;
    tbody.insertAdjacentHTML('beforeend', this.getPoolRowHtml());
    this.updatePoolEmptyHint();
    tbody.lastElementChild?.querySelector('.wp-item-name')?.focus();
  },

  // Unlike an Items Stock row (App.Utils.removeRow keeps the last one), the
  // last pool row can go too: most records take nothing from the pool.
  removePoolRow(btn) {
    btn?.closest('tr')?.remove();
    this.updatePoolEmptyHint();
  },

  updatePoolEmptyHint() {
    const hasRows = !!document.querySelector('#wastagePoolItemsBody tr');
    const wrap = document.getElementById('wastagePoolItemsBody')?.closest('.table-responsive');
    if (wrap) wrap.style.display = hasRows ? '' : 'none';
    const hint = document.getElementById('wastagePoolEmptyHint');
    if (hint) hint.style.display = hasRows ? 'none' : '';
  },

  // A new item name means a new set of buckets; a colour picked for the old
  // one would be the wrong shelf.
  onPoolItemInput(input) {
    const select = input.closest('tr')?.querySelector('.wp-bucket');
    if (select) select.innerHTML = this._bucketOptionsHtml(input.value, null);
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
        sourceType: 'ITEM',
        name,
        size: $('.w-item-size', row)?.value?.trim() || '',
        qty: toNumber($('.w-item-qty', row)?.value),
        unit: $('.item-unit', row)?.value?.trim() || 'Pcs',
        reason: $('.w-item-reason', row)?.value?.trim() || ''
      });
    });
    // Pool rows named but with no colour chosen are reported back rather
    // than sent: the server would refuse them anyway, and this says which.
    const unpicked = [];
    $$('#wastagePoolItemsBody tr').forEach(row => {
      const name = $('.wp-item-name', row)?.value?.trim();
      if (!name) return;
      const bucket = $('.wp-bucket', row)?.value || '';
      if (!bucket) {
        unpicked.push(name);
        return;
      }
      const [productTag, color] = bucket.split(this.BUCKET_SEP);
      items.push({
        sourceType: 'POOL',
        name,
        productTag: productTag || '',
        color: color || '',
        qty: toNumber($('.wp-qty', row)?.value),
        unit: 'Pcs',
        reason: $('.wp-reason', row)?.value?.trim() || ''
      });
    });
    formData.items = JSON.stringify(items);
    return { formData, items, unpicked };
  },

  async submit(e) {
    e.preventDefault();
    const { formData, items, unpicked } = this.serializeForm();

    if (unpicked.length) {
      const name = unpicked[0];
      App.Utils.showToast(this.bucketsFor(name).length
        ? `Choose which colour of "${name}" was wasted.`
        : `"${name}" is not in the Warehouse Pool. Pick it from the list.`, true);
      return;
    }

    if (!items.length) {
      App.Utils.showToast('Add at least one item to log wastage.', true);
      return;
    }

    const label = it => (it.sourceType === 'POOL' && it.color ? `${it.name} (${it.color})` : it.name);
    const missingQty = items.find(it => !(it.qty > 0));
    if (missingQty) {
      App.Utils.showToast(`Enter a quantity for "${label(missingQty)}".`, true);
      return;
    }

    const missingReason = items.find(it => !it.reason);
    if (missingReason) {
      App.Utils.showToast(`Please enter a reason for "${label(missingReason)}".`, true);
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
    form.querySelectorAll(
      '.wastage-add-btn, #wastageItemsBody button[data-action="remove-row"], #wastagePoolItemsBody .wp-remove'
    ).forEach(el => { el.disabled = disabled; });
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
    if (title) title.innerHTML = '<i class="bi bi-exclamation-triangle me-2"></i>Log Wastage';
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
  // Shared with MApp. This shell wraps these entries in a standalone
  // document and opens a print window; the phone renders the same entries
  // into the bulk container, because a popup on a phone is a coin toss.
  buildWastageEntryHtml(w) {
    return PrintTemplates.wastageNote(w, App.Print.templateDeps());
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
    // ...and each pool row's colours to the buckets of the item chosen.
    if (e.target.matches('#wastagePoolItemsBody .wp-item-name')) {
      App.Wastage.onPoolItemInput(e.target);
    }
  });
});
