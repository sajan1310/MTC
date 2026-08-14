'use strict';
// issue.js -- App.Issue, ported from Apps_Script/Script_Return.html (App.Issue
// lives there alongside App.Return/App.Wastage, despite its own UI living in
// Production's "Issued Stock" sub-tab -- see View_Production.html).
//
// Records ad-hoc issuance of Stock items -- components a contractor needs
// beyond what a Process's own recipe (BOM) calls for. Separate from
// Production's Components Consumed list: issuing an item here never touches
// a lot's BOM/costing, it only debits Stock directly. Create-only in the
// source (module_issue.js has no edit path); openEditModal/saveIssueStock's
// existingIssueId are a deliberate PWA-only addition -- issueId itself
// never changes on edit, matching how it has no override field on create
// either. No singular delete -- only bulk delete (which a single row's own
// Delete button also calls, with a one-element array).
//
// Adaptations from source (documented, not silent):
// - saveIssueStock/deleteIssueBulk use Api.mutate (not Api.call): both are
//   mutation=True on the backend.
// - deleteSingle/bulkDelete build the deletedIds comparison Set
//   case-insensitively (`.map(id => String(id).toLowerCase())` on both
//   sides) to match deleteIssueBulk's own lowercasing of every ID before
//   returning it -- the exact same bug class already found and fixed for
//   Return/Wastage in Round 6 (deletePOsBulk/deleteReturnsBulk/
//   deleteWastageBulk all do this too), and issueId's own shape
//   (`ISS-YYYYMMDD-HHMMSS`) means lowercasing DOES change it (the "ISS"
//   prefix), so this isn't a no-op here either.
// - bulkPrint/print are guarded behind App.Print not existing yet; their
//   builder (buildIssuePrintPageHtml) stays as ported dead code.
// - "Issue Stock" buttons in Production's own partial (main toolbar +
//   Issued Stock sub-tab), previously data-action="not-ported-yet"
//   placeholders, now call the real App.Issue.openIssueModal() directly.

App.Issue = {
  async loadData() {
    const tbody = document.getElementById('issueTableBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="text-center p-4">Loading Issued Stock…</td></tr>';

    try {
      const res = await Api.call('getIssueData');
      if (!res?.success) {
        App.Utils.showToast(res?.message || 'Failed to load issued stock records.', true);
        return;
      }
      App.State.globalIssues = Array.isArray(res.data) ? res.data : [];
      App.State.filteredIssues = [...App.State.globalIssues];
      App.State.issueCurrentPage = 1;
      App.State.issueSearchTerm = '';
      App.State.issueDateFilter = '';
      App.State.selectedIssues = [];
      this.renderTable();
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to load issued stock records.', true);
    }
  },

  filterData(searchTerm) {
    App.State.issueSearchTerm = String(searchTerm || '');
    this.applyFilters();
  },

  filterByDate(dateValue) {
    App.State.issueDateFilter = String(dateValue || '');
    this.applyFilters();
  },

  applyFilters() {
    const term = App.State.issueSearchTerm.toLowerCase().trim();
    const dateFilter = App.State.issueDateFilter;

    App.State.filteredIssues = App.State.globalIssues.filter(iss => {
      if (dateFilter && dateToInputValue(iss.dateRaw, iss.date) !== dateFilter) return false;
      if (term) {
        const itemsText = (iss.items || []).map(it => `${it.name || ''} ${it.size || ''}`).join(' ');
        const haystack = `${iss.issueId || ''} ${iss.issuedTo || ''} ${iss.reference || ''} ${itemsText} ${iss.remarks || ''}`;
        if (!App.Utils.matchesKeywords(haystack, term)) return false;
      }
      return true;
    });

    App.State.issueCurrentPage = 1;
    this.renderTable();
  },

  changePage(page) {
    App.State.issueCurrentPage = App.Utils.clampPage(
      page, App.State.filteredIssues.length, App.State.issueRowsPerPage
    );
    this.renderTable();
  },

  renderTable() {
    const tbody = document.getElementById('issueTableBody');
    if (!tbody) return;

    const emptyState = document.getElementById('issueEmptyState');
    if (!App.State.filteredIssues.length) {
      tbody.innerHTML = '';
      if (emptyState) emptyState.style.display = 'block';
      App.Utils.renderPagination('issuePagination', 0, 1, App.State.issueRowsPerPage, 'issue-page', 'Issue');
      this.updateBulkButtons();
      return;
    }
    if (emptyState) emptyState.style.display = 'none';

    const { filteredIssues, issueCurrentPage: cur, issueRowsPerPage: rpp } = App.State;
    const start = (cur - 1) * rpp;
    const pageItems = filteredIssues.slice(start, start + rpp);

    const selectAllChk = document.getElementById('selectAllIssue');
    if (selectAllChk) {
      selectAllChk.checked = pageItems.length > 0 &&
        pageItems.every(iss => App.Selection.isSelected(App.State.selectedIssues, String(iss.issueId)));
    }

    tbody.innerHTML = pageItems.map(iss => {
      const key = String(iss.issueId);
      const checkedAttr = App.Selection.isSelected(App.State.selectedIssues, key) ? 'checked' : '';

      const itemsPreview = (iss.items || []).slice(0, 3).map(it => {
        const namePart = escapeHtml(it.name || '—');
        const sizePart = it.size ? ` (${escapeHtml(it.size)})` : '';
        return `${namePart}${sizePart} ×${it.qty}`;
      }).join('<br>') + (iss.items.length > 3 ? `<br><em>+${iss.items.length - 3} more…</em>` : '');

      const refBadge = iss.reference
        ? `<span class="badge bg-secondary">${escapeHtml(iss.reference)}</span>`
        : '<span class="text-muted">—</span>';

      return `
      <tr>
        <td class="text-center">
          <input type="checkbox" class="form-check-input issue-select-chk" data-key="${escapeHtml(key)}" ${checkedAttr} onchange="App.Issue.onRowSelectChange()">
        </td>
        <td><strong class="text-dark">${escapeHtml(iss.issueId || '')}</strong></td>
        <td>${escapeHtml(iss.date || '')}</td>
        <td>${escapeHtml(App.Utils.formatNameCase(iss.issuedTo))}</td>
        <td>${refBadge}</td>
        <td><small class="text-muted">${itemsPreview}</small></td>
        <td class="text-center fw-bold">${escapeHtml(String(iss.totalQty ?? 0))}</td>
        <td class="text-center">
          <button class="btn btn-sm btn-outline-primary w-100 mb-1"
                  onclick="App.Issue.openEditModal('${escapeHtml(key)}')">Edit</button>
          <button class="btn btn-sm btn-outline-dark w-100 mb-1"
                  onclick="App.Issue.print('${escapeHtml(key)}')">Print</button>
          <button class="btn btn-sm btn-danger w-100"
                  onclick="App.Issue.deleteSingle('${escapeHtml(key)}')">Delete</button>
        </td>
      </tr>`;
    }).join('');

    App.Utils.renderPagination('issuePagination', filteredIssues.length, cur, rpp, 'issue-page', 'Issue');
    this.updateBulkButtons();
  },

  toggleSelectAll(masterChk) {
    App.Selection.toggleAll(App.State.selectedIssues, 'issue-select-chk', masterChk);
    this.updateBulkButtons();
  },

  onRowSelectChange() {
    App.Selection.syncFromRows(App.State.selectedIssues, 'issue-select-chk', 'selectAllIssue');
    this.updateBulkButtons();
  },

  updateBulkButtons() {
    const count = App.State.selectedIssues.length;
    App.Selection.updateButton('btnBulkDeleteIssue', count, '<i class="bi bi-trash"></i> Delete Selected');
    App.Selection.updateButton('btnBulkPrintIssue', count, '<i class="bi bi-printer"></i> Print Selected');
    App.Selection.updateButton('btnBulkDownloadPdfIssue', count, '<i class="bi bi-file-earmark-pdf"></i> Download PDFs');
  },

  bulkPrint() {
    if (typeof App.Print === 'undefined') {
      App.Utils.notPortedYet('Printing');
      return;
    }

    const selected = App.State.selectedIssues;
    if (!selected.length) {
      App.Utils.showToast('No issue records selected to print.', true);
      return;
    }

    const issues = App.State.globalIssues.filter(iss => App.Selection.isSelected(selected, String(iss.issueId)));
    if (!issues.length) return;

    App.Print.triggerBulk(issues, iss => this.buildIssuePrintPageHtml(iss), 'Stock_Issue_Receipts_Selected');
  },

  async bulkDownloadPDF() {
    const selected = App.State.selectedIssues;
    if (!selected.length) {
      App.Utils.showToast('No issue records selected.', true);
      return;
    }

    const issues = App.State.globalIssues.filter(iss => App.Selection.isSelected(selected, String(iss.issueId)));
    if (!issues.length) return;

    App.Print.renderBulkPages(issues, iss => this.buildIssuePrintPageHtml(iss));
    const filename = App.Print.bulkPdfFilename('Stock_Issue_Receipts', issues.length);
    const ok = await App.Print.downloadElementAsPDF('print-bulk-container', filename);
    if (ok) App.Utils.showToast(`${issues.length} issue receipt(s) exported to PDF!`, false);
  },

  // Single-record print for the per-row "Print" button -- reuses the
  // shared bulk-print container with a one-element array, same approach
  // as App.Return.print (Issue has no dedicated static single-print
  // template, only this shared build*PrintPageHtml).
  print(issueId) {
    if (typeof App.Print === 'undefined') {
      App.Utils.notPortedYet('Printing');
      return;
    }

    const iss = App.State.globalIssues.find(i => String(i.issueId) === String(issueId));
    if (!iss) return;

    App.Print.triggerBulk([iss], i => this.buildIssuePrintPageHtml(i), `Stock_Issue_Receipt_${iss.issueId}`);
  },

  // Builds a fully self-contained "Stock Issue Receipt" page for bulk printing.
  buildIssuePrintPageHtml(iss) {
    const BRAND = '#212529';
    const hasValue = toNumber(iss.totalValue) > 0;
    const colCount = hasValue ? 5 : 4;

    const rowsHtml = (iss.items || []).map((item, idx) => {
      const rowBg = idx % 2 === 0 ? '#ffffff' : '#f5f5f5';
      const amountCell = hasValue
        ? `<td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:right;font-weight:600;">${toNumber(item.rate) ? '&#8377;' + toNumber(item.value).toFixed(2) : '-'}</td>`
        : '';
      return `
      <tr style="background-color:${rowBg};-webkit-print-color-adjust:exact;print-color-adjust:exact;page-break-inside:avoid;break-inside:avoid;">
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:center;color:#999;font-weight:600;">${idx + 1}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:left;font-weight:600;">${escapeHtml(item.name || '')}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:center;">${escapeHtml(item.size || '-')}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:center;font-weight:600;">${escapeHtml(String(toNumber(item.qty)))} ${escapeHtml(item.unit || 'Pcs')}</td>
        ${amountCell}
      </tr>`;
    }).join('');
    const rows = rowsHtml || `<tr><td colspan="${colCount}" style="padding:10px;text-align:center;color:#999;">No items recorded for this issue.</td></tr>`;
    const amountHeader = hasValue ? '<th style="padding:6px;border:1px solid #bbb;text-align:right;width:20%;">Amount</th>' : '';
    const totalValueHtml = hasValue ? `
      <div style="text-align:right;margin-top:4px;">
        <span style="font-size:11px;font-weight:600;color:#1a1a1a;">Total Value:&nbsp;&nbsp;</span>
        <span style="font-size:13px;font-weight:800;color:${BRAND};">&#8377;${toNumber(iss.totalValue).toFixed(2)}</span>
      </div>` : '';

    const remarksHtml = iss.remarks ? `
    <div style="margin-top:10px;padding-top:8px;border-top:1px solid #ccc;">
      <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Remarks</span>
      <div style="font-size:12px;color:#1a1a1a;margin-top:2px;white-space:pre-wrap;">${escapeHtml(iss.remarks)}</div>
    </div>` : '';

    return `
    <div style="background:#fff;color:#1a1a1a;font-family:'Segoe UI',Arial,sans-serif;font-size:12px;line-height:1.5;padding:14px 20px 12px 20px;margin:0;box-sizing:border-box;width:100%;border-top:5px solid ${BRAND};border-bottom:3px solid ${BRAND};-webkit-print-color-adjust:exact;print-color-adjust:exact;">
      <div style="text-align:center;padding:4px 0 8px 0;">
        ${App.Print.brandHeaderHtml(BRAND)}
        <div style="font-size:10px;color:#555;margin-top:3px;letter-spacing:0.3px;">
          6-B, SHIV SHAKTI ESTATE, VERKA CHOWK, DEHLON ROAD, BHAGWANPURA, 141114 LUDHIANA
        </div>
        <div style="font-size:11px;color:${BRAND};font-weight:700;margin-top:4px;letter-spacing:1px;text-transform:uppercase;">
          Stock Issue Receipt
        </div>
      </div>
      <div style="height:2px;background:${BRAND};margin:0 0 12px 0;-webkit-print-color-adjust:exact;print-color-adjust:exact;"></div>

      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <div style="flex:1;text-align:left;">
          <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Issue #</span>
          <div style="font-size:15px;font-weight:700;color:${BRAND};">${escapeHtml(iss.issueId || '')}</div>
        </div>
        <div style="flex:1;text-align:right;">
          <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Date</span>
          <div style="font-size:13px;font-weight:700;color:#1a1a1a;">${escapeHtml(iss.date || '')}</div>
        </div>
      </div>

      <div style="height:1px;background:#bbb;margin-bottom:14px;"></div>

      <div style="margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid #ccc;">
        <div style="display:flex;gap:16px;">
          <div style="flex:1;">
            <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Issued To / Purpose</span>
            <div style="font-weight:700;font-size:13px;color:#1a1a1a;margin-top:1px;">${escapeHtml(App.Utils.formatNameCase(iss.issuedTo))}</div>
          </div>
          <div style="flex:1;">
            <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Reference</span>
            <div style="font-size:13px;font-weight:600;color:#1a1a1a;margin-top:1px;">${escapeHtml(iss.reference || '-')}</div>
          </div>
        </div>
      </div>

      <table style="width:100%;border-collapse:collapse;margin-bottom:14px;font-size:12px;">
        <thead style="background-color:${BRAND};color:#fff;text-align:center;font-weight:700;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
          <tr>
            <th style="padding:6px;border:1px solid #bbb;text-align:center;width:8%;">#</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:left;width:${hasValue ? '37' : '47'}%;">Item Name</th>
            <th style="padding:6px;border:1px solid #bbb;width:20%;">Size</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:center;width:${hasValue ? '15' : '25'}%;">Qty</th>
            ${amountHeader}
          </tr>
        </thead>
        <tbody style="color:#1a1a1a;text-align:center;">${rows}</tbody>
      </table>

      <div style="text-align:right;margin-bottom:16px;padding:8px 0 0 0;border-top:2px solid ${BRAND};page-break-inside:avoid;break-inside:avoid;">
        <span style="font-size:13px;font-weight:600;color:#1a1a1a;">Total Qty:&nbsp;&nbsp;</span>
        <span style="font-size:15px;font-weight:800;color:${BRAND};">${escapeHtml(String(iss.totalQty ?? 0))}</span>
      </div>
      ${totalValueHtml}
      ${remarksHtml}

      <div style="display:flex;justify-content:flex-end;page-break-inside:avoid;break-inside:avoid;margin-top:16px;">
        <div style="width:180px;text-align:center;padding-top:5px;border-top:2px solid ${BRAND};">
          <span style="font-size:10px;color:#666;letter-spacing:0.5px;font-style:italic;">Received By / Signature</span>
        </div>
      </div>
    </div>`;
  },

  openIssueModal(prefillReference) {
    document.getElementById('issueStockForm')?.reset();
    this.resetToCreateMode();
    const dateInput = document.getElementById('issueDateInput');
    if (dateInput) dateInput.value = todayIso();
    const refInput = document.getElementById('issueReferenceInput');
    if (refInput) refInput.value = prefillReference || '';
    const tbody = document.getElementById('issueItemsBody');
    if (tbody) tbody.innerHTML = this.getRowHtml();
    safeModalShow('issueStockModal');
  },

  // Editing is a PWA-only addition -- module_issue.js has no edit path
  // (create-only, same as Wastage). issueId itself never changes; only
  // the header fields and item lines can be updated.
  openEditModal(issueId) {
    const iss = App.State.globalIssues.find(i => String(i.issueId) === String(issueId));
    if (!iss) return;

    document.getElementById('issueStockForm')?.reset();
    this.resetToCreateMode();

    document.getElementById('issueExistingId').value = iss.issueId;
    document.getElementById('issueDateInput').value = dateToInputValue(iss.dateRaw, iss.date);
    document.getElementById('issueIssuedTo').value = iss.issuedTo || '';
    document.getElementById('issueReferenceInput').value = iss.reference || '';
    document.getElementById('issueRemarksInput').value = iss.remarks || '';

    const tbody = document.getElementById('issueItemsBody');
    if (tbody) {
      tbody.innerHTML = (iss.items || []).map(item => this.getRowHtml(item)).join('') || this.getRowHtml();
    }

    const title = document.getElementById('issueModalTitle');
    if (title) title.innerHTML = `<i class="bi bi-pencil-square me-2"></i>Edit Issue ${escapeHtml(iss.issueId)}`;
    const submitBtn = document.getElementById('issueStockSubmitBtn');
    if (submitBtn) submitBtn.innerHTML = '<i class="bi bi-check2 me-1"></i>Update Issue';

    safeModalShow('issueStockModal');
  },

  addRow() {
    const tbody = document.getElementById('issueItemsBody');
    if (!tbody) return;
    tbody.insertAdjacentHTML('beforeend', this.getRowHtml());
  },

  getRowHtml(item = {}) {
    const rowUid = `issue-${++App.State.rowSeq}`;
    return `
    <tr data-row-uid="${rowUid}">
      <td><input type="text" class="form-control i-item-name" list="itemList" value="${escapeHtml(item.name || '')}" required placeholder="Item name"></td>
      <td><input type="text" class="form-control i-item-size" list="sizeList-${rowUid}" value="${escapeHtml(item.size || '')}" placeholder="Size">
          <datalist class="row-size-list" id="sizeList-${rowUid}"></datalist></td>
      <td><input type="number" class="form-control i-item-qty" step="0.01" value="${escapeHtml(String(item.qty ?? ''))}" required min="0.01" placeholder="Qty"></td>
      <td><input type="text" class="form-control item-unit" list="unitList" value="${escapeHtml(item.unit || 'Pcs')}"></td>
      <td><input type="number" class="form-control i-item-rate" min="0" step="0.01" value="${escapeHtml(String(item.rate ?? ''))}" placeholder="Optional"></td>
      <td><button type="button" class="btn btn-outline-danger btn-sm" data-action="remove-row">✕</button></td>
    </tr>`;
  },

  serializeForm() {
    const form = document.getElementById('issueStockForm');
    const formData = Object.fromEntries(new FormData(form));
    formData.existingIssueId = document.getElementById('issueExistingId')?.value || '';
    const items = [];
    $$('#issueItemsBody tr').forEach(row => {
      const name = $('.i-item-name', row)?.value?.trim();
      if (!name) return;
      const rateVal = $('.i-item-rate', row)?.value;
      items.push({
        name,
        size: $('.i-item-size', row)?.value?.trim() || '',
        qty: toNumber($('.i-item-qty', row)?.value),
        unit: $('.item-unit', row)?.value?.trim() || 'Pcs',
        rate: rateVal ? toNumber(rateVal) : 0
      });
    });
    formData.items = JSON.stringify(items);
    return { formData, items };
  },

  async submit(e) {
    e.preventDefault();
    const { formData, items } = this.serializeForm();

    if (!items.length) {
      App.Utils.showToast('Add at least one item to issue.', true);
      return;
    }

    const isEdit = !!formData.existingIssueId;
    const submitBtn = document.getElementById('issueStockSubmitBtn');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Saving…'; }

    try {
      const res = await Api.mutate('saveIssueStock', formData);
      App.Utils.showToast(res?.message || 'Stock issued.', !res?.success);
      if (res?.success) {
        await this.loadData();
        if (typeof App.Production !== 'undefined') App.Production.renderAllActivity();
        this.enterSavedMode(res.data.issueId);
      }
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to issue stock.', true);
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = isEdit
          ? '<i class="bi bi-check2 me-1"></i>Update Issue'
          : '<i class="bi bi-box-arrow-up me-1"></i>Issue Stock';
      }
    }
  },

  // Post-save state: form locks read-only, submit button swaps for
  // Print + Done so the just-created record can be printed without
  // leaving the modal (mirrors Bill's edit-mode print button).
  enterSavedMode(issueId) {
    document.getElementById('issueSavedId').value = issueId;
    this.setFormReadOnly(true);
    document.getElementById('issueStockSubmitBtn').style.display = 'none';
    document.getElementById('issueStockPrintBtn').style.display = '';
    document.getElementById('issueStockDoneBtn').style.display = '';
  },

  setFormReadOnly(disabled) {
    const form = document.getElementById('issueStockForm');
    if (!form) return;
    // Only disable the input fields, "+ Add Item", and per-row remove
    // buttons -- NOT the footer Cancel/Print/Done/Submit buttons, which
    // live inside this same <form> and must stay clickable.
    form.querySelectorAll('input, select, textarea').forEach(el => { el.disabled = disabled; });
    const addBtn = form.querySelector('button[onclick="App.Issue.addRow()"]');
    if (addBtn) addBtn.disabled = disabled;
    form.querySelectorAll('#issueItemsBody button[data-action="remove-row"]').forEach(el => {
      el.disabled = disabled;
    });
  },

  printCurrent() {
    const issueId = document.getElementById('issueSavedId')?.value;
    if (issueId) this.print(issueId);
  },

  done() {
    bootstrap.Modal.getInstance(document.getElementById('issueStockModal'))?.hide();
    this.resetToCreateMode();
  },

  resetToCreateMode() {
    const savedId = document.getElementById('issueSavedId');
    if (savedId) savedId.value = '';
    const existingId = document.getElementById('issueExistingId');
    if (existingId) existingId.value = '';
    this.setFormReadOnly(false);
    const title = document.getElementById('issueModalTitle');
    if (title) title.innerHTML = '<i class="bi bi-box-arrow-up me-2"></i>Issue Stock';
    const submitBtn = document.getElementById('issueStockSubmitBtn');
    if (submitBtn) {
      submitBtn.style.display = '';
      submitBtn.innerHTML = '<i class="bi bi-box-arrow-up me-1"></i>Issue Stock';
    }
    const printBtn = document.getElementById('issueStockPrintBtn');
    if (printBtn) printBtn.style.display = 'none';
    const doneBtn = document.getElementById('issueStockDoneBtn');
    if (doneBtn) doneBtn.style.display = 'none';
  },

  async deleteSingle(issueId) {
    App.Utils.confirmAction(
      `Delete issue record ${issueId} and all its items?`,
      async () => {
        try {
          const res = await Api.mutate('deleteIssueBulk', [issueId]);
          App.Utils.showToast(res?.message || 'Deleted.', !res?.success);
          if (res?.success) {
            const deleted = new Set((res.data?.deletedIds || [issueId]).map(id => String(id).toLowerCase()));
            App.State.globalIssues = App.State.globalIssues.filter(iss => !deleted.has(String(iss.issueId).toLowerCase()));
            App.State.filteredIssues = App.State.filteredIssues.filter(iss => !deleted.has(String(iss.issueId).toLowerCase()));
            App.State.selectedIssues = [];
            this.renderTable();
            if (typeof App.Production !== 'undefined') App.Production.renderAllActivity();
          }
        } catch (err) {
          App.Utils.showToast(err.message || 'Failed to delete.', true);
        }
      }
    );
  },

  async bulkDelete() {
    const selected = App.State.selectedIssues;
    if (!selected.length) return;

    App.Utils.confirmAction(
      `Permanently delete ${selected.length} issued stock record(s)?`,
      async () => {
        try {
          const res = await Api.mutate('deleteIssueBulk', selected);
          App.Utils.showToast(res?.message || 'Delete completed.', !res?.success);
          if (res?.success) {
            const deletedIds = new Set((res.data?.deletedIds || []).map(id => String(id).toLowerCase()));
            App.State.globalIssues = App.State.globalIssues.filter(iss => !deletedIds.has(String(iss.issueId).toLowerCase()));
            App.State.filteredIssues = App.State.filteredIssues.filter(iss => !deletedIds.has(String(iss.issueId).toLowerCase()));
            App.State.selectedIssues = [];
            this.renderTable();
            if (typeof App.Production !== 'undefined') App.Production.renderAllActivity();
          }
        } catch (err) {
          App.Utils.showToast(err.message || 'Failed to delete issued stock.', true);
        }
      }
    );
  }
};

document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('issueStockForm')?.addEventListener('submit', e => App.Issue.submit(e));

  // Populates each row's own per-row size datalist from Item Master as
  // the operator types an item name, same pattern already established
  // for Return/Wastage's item rows.
  document.addEventListener('input', e => {
    if (e.target.matches('#issueItemsBody .i-item-name')) {
      App.Utils.applyDependentSizeList(e.target, '.i-item-size');
    }
  });
});
