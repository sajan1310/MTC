'use strict';
// production.js -- App.Production, ported from Apps_Script/Script_Production.html.
//
// Round 11 scope (shipped): the Production Log list/report side --
// viewing, searching, sorting, inline status changes, delete, bulk
// print, the Colorwise Summary report, and the "All Activity" combined
// feed.
//
// Round 12 scope (this round): the Create/Edit Lot modal -- but ONLY
// for the single-Qty (no color sub-groups) path. Source's own Create/
// Edit modal orchestration (Script_Production.html lines ~627-3921,
// ~3300 lines on its own -- more than the entire rest of this app's
// largest single prior round) turned out to itself need splitting
// further once actually read in full: the multi-axis Color Checklist
// system alone is ~1050 lines, the Per-Color Component Matrix +
// Per-Process Warehouse Pool Color Group Matrix systems together are
// another ~1350 lines, each with its own subtle, incident-documented
// edge cases (see source's own comments re: axis collisions, Select2
// re-entrant change events, etc). Porting all of that faithfully in one
// pass would be too large to verify with confidence, so this round
// covers: the full modal shell (cascading Size->Model->Process
// Type->Process dropdowns, Lot Number/Output Item readouts, optional
// Product tag), the Components Consumed table (recipe-prefilled,
// editable, Item/Pool source toggle, availability hints), Assignment &
// Workflow (contractor Select2 + live payable hint, Status, Remarks),
// and full create/edit/save/delete for any lot whose Process has NO
// configured color sub-groups (the common case for many processes).
//
// A Process that DOES have color sub-groups (detected via the same real
// getProcessColorGroups call source makes) is guarded, not silently
// mishandled: the form shows a dismissable notice and blocks Save,
// exactly the "guard now, activate later" pattern used everywhere else
// in this port. Editing an existing lot that already carries a saved
// colorBreakdown is guarded the same way before the modal even opens.
// Both guards lift automatically the moment the still-to-come Color
// Checklist / Per-Color Matrix round lands -- no changes needed here.
//
// Adaptations from source (documented, not silent):
// - deleteProduction/deleteProductionBulk/updateProductionStatus/
//   saveProduction all use Api.mutate (not Api.call): every one is
//   mutation=True on the backend.
// - initContractorSelect2's Select2 `data` reads `c.contractorName`, not
//   source's `c.name` -- see contractor.js's module header for the full
//   story of this backend field-name deviation (getContractorsData
//   returns contractorName, not name).
// - "Issue Stock" buttons (App.Issue.openIssueModal) and the Issued
//   Stock sub-tab's own content are guarded/placeholder'd at the
//   template level -- App.Issue is a whole separate module (lives in
//   Script_Return.html alongside Return/Wastage, not this file) that
//   hasn't been ported at all yet. openIssueStockForLot() (the modal's
//   own "Issue Stock (not part of BOM)" button) is guarded the same way.
// - bulkPrint is guarded behind App.Print not existing yet; its builder
//   (buildProductionSheetPrintPageHtml) stays as ported dead code.
// - openColorwiseSummaryModal is exactly what Dashboard's
//   openPipelineStage (Round 1) has been waiting on since it was first
//   guarded behind `typeof App.Production !== 'undefined' &&
//   App.Production.openColorwiseSummaryModal` -- the pipeline
//   drill-down activates with zero changes to dashboard.js.
// - viewProductionSheet (the lot-completion Production Sheet modal)
//   stays a stub -- its own later round, unaffected by this one.

App.Production = {
  STATUS_OPTIONS: ['Pending', 'In Progress', 'Completed', 'Cancelled'],

  // Maps a status value to the inline background/text color of its row
  // select, mirroring the badge colors the status used to render as.
  statusStyleFor(status) {
    switch (status) {
      case 'Pending': return 'background-color:#ffc107;color:#000;';
      case 'In Progress': return 'background-color:#0dcaf0;color:#fff;';
      case 'Completed': return 'background-color:#198754;color:#fff;';
      case 'Cancelled': return 'background-color:#dc3545;color:#fff;';
      default: return 'background-color:#6c757d;color:#fff;';
    }
  },

  // Changes a lot's status directly from its table row, without opening
  // the Edit Lot modal.
  async updateStatus(selectEl) {
    const idx = Number(selectEl.dataset.rowIdx);
    const p = App.State.globalProduction[idx];
    if (!p) return;

    const newStatus = selectEl.value;
    const previousStatus = p.status;
    if (newStatus === previousStatus) return;

    selectEl.disabled = true;
    try {
      const res = await Api.mutate('updateProductionStatus', p.rowIdx, p.qty, newStatus);
      App.Utils.showToast(res.message, !res.success);
      if (res.success) {
        p.status = newStatus;
        selectEl.setAttribute('style', this.statusStyleFor(newStatus));
      } else {
        selectEl.value = previousStatus;
      }
    } catch (err) {
      selectEl.value = previousStatus;
      App.Utils.showToast(err.message || 'Failed to update status', true);
    } finally {
      selectEl.disabled = false;
    }
  },

  async loadData() {
    const tbody = document.getElementById('productionTableBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="10" class="text-center p-4">Loading Production Logs...</td></tr>';

    try {
      const [, , response] = await Promise.all([
        App.Process.ensureLoaded(),
        App.Color.ensureLoaded(),
        Api.call('getProductionData')
      ]);
      if (!response.success) {
        App.Utils.showToast(response.message, true);
        return;
      }
      App.State.globalProduction = response.data;
      App.State.filteredProduction = response.data;
      App.State.productionCurrentPage = 1;
      App.State.productionSortBy = App.State.productionSortBy || 'dateDesc';
      App.State.selectedProduction = [];
      this.sortFiltered();
      this.renderTable();
      this.renderAllActivity();
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to load production logs', true);
    }
  },

  switchSubTab(id) {
    $$('.production-sub-tab').forEach(t => t.style.display = 'none');
    const target = document.getElementById(id);
    if (target) target.style.display = 'block';

    $$('#productionSubTabs .nav-link').forEach(btn => btn.classList.remove('active'));
    document.getElementById('btn-' + id)?.classList.add('active');

    if (id === 'issuedStockSubTab' && typeof App.Issue !== 'undefined' && !App.State.globalIssues.length) {
      App.Issue.loadData();
    }
    if (id === 'productionAllSubTab') {
      const needsIssues = typeof App.Issue !== 'undefined' && !App.State.globalIssues.length;
      Promise.resolve(needsIssues ? App.Issue.loadData() : null).then(() => this.renderAllActivity());
    }
  },

  // Normalizes Production Log lots + Issued Stock entries into one shape
  // so the "All Activity" sub-tab can list both chronologically, each
  // tagged with its own sub-group badge. App.State.globalIssues stays
  // empty (forward-declared since Round 1) until App.Issue's own round,
  // so this already degrades correctly -- Production rows only, for now.
  buildAllActivityRows() {
    const prodRows = (App.State.globalProduction || []).map(p => ({
      dateRaw: p.dateRaw,
      date: p.date,
      typeBadge: '<span class="badge bg-success">Production</span>',
      id: p.lotNumber || '—',
      details: p.outputItemName || '',
      qty: p.qty,
      extra: p.status || '',
      searchText: `${p.lotNumber || ''} ${p.outputItemName || ''} ${p.assignedBy || ''} ${p.assignedTo || ''} ${p.status || ''}`
    }));

    const issueRows = (App.State.globalIssues || []).map(iss => ({
      dateRaw: iss.dateRaw,
      date: iss.date,
      typeBadge: '<span class="badge bg-dark">Stock Issue</span>',
      id: iss.issueId,
      details: (iss.items || []).map(it => `${it.name}${it.size ? ` (${it.size})` : ''} ×${it.qty}`).join(', '),
      qty: iss.totalQty,
      extra: iss.issuedTo || '',
      searchText: `${iss.issueId || ''} ${iss.issuedTo || ''} ${iss.reference || ''} ${(iss.items || []).map(it => it.name).join(' ')}`
    }));

    return [...prodRows, ...issueRows].sort(
      (a, b) => parseRecordDate(b.dateRaw, b.date) - parseRecordDate(a.dateRaw, a.date)
    );
  },

  filterAllActivity(term) {
    App.State.productionAllSearchTerm = String(term || '');
    this.renderAllActivity();
  },

  renderAllActivity() {
    const tbody = document.getElementById('productionAllTableBody');
    if (!tbody) return;

    const term = (App.State.productionAllSearchTerm || '').toLowerCase().trim();
    let rows = this.buildAllActivityRows();
    if (term) rows = rows.filter(r => App.Utils.matchesKeywords(r.searchText, term));

    const emptyState = document.getElementById('productionAllEmptyState');
    if (!rows.length) {
      tbody.innerHTML = '';
      if (emptyState) emptyState.style.display = 'block';
      return;
    }
    if (emptyState) emptyState.style.display = 'none';

    tbody.innerHTML = rows.map(r => `
      <tr>
        <td>${escapeHtml(r.date || '')}</td>
        <td>${r.typeBadge}</td>
        <td><strong>${escapeHtml(String(r.id || ''))}</strong></td>
        <td>${escapeHtml(r.details || '')}</td>
        <td class="text-center fw-bold">${escapeHtml(String(r.qty ?? ''))}</td>
        <td>${escapeHtml(r.extra || '')}</td>
      </tr>`).join('');
  },

  filterData(searchTerm) {
    const term = searchTerm.toLowerCase().trim();
    if (!term) {
      App.State.filteredProduction = App.State.globalProduction;
    } else {
      App.State.filteredProduction = App.State.globalProduction.filter(p => {
        const haystack = [p.date, p.lotNumber, p.outputItemName, p.color, p.productId, p.productName, p.status, p.assignedBy, p.assignedTo, p.remarks].join(' ');
        return App.Utils.matchesKeywords(haystack, term);
      });
    }
    this.sortFiltered();
    App.State.productionCurrentPage = 1;
    this.renderTable();
  },

  // Field/direction combos selectable via the "Sort by" dropdown
  // (View_Production.html#productionSortBy).
  SORT_COMPARATORS: {
    dateDesc: (a, b) => parseRecordDate(b.dateRaw, b.date) - parseRecordDate(a.dateRaw, a.date),
    dateAsc: (a, b) => parseRecordDate(a.dateRaw, a.date) - parseRecordDate(b.dateRaw, b.date),
    outputItemAsc: (a, b) => String(a.outputItemName || '').localeCompare(String(b.outputItemName || '')),
    outputItemDesc: (a, b) => String(b.outputItemName || '').localeCompare(String(a.outputItemName || '')),
    qtyDesc: (a, b) => (b.qty || 0) - (a.qty || 0),
    qtyAsc: (a, b) => (a.qty || 0) - (b.qty || 0),
    statusAsc: (a, b) => String(a.status || '').localeCompare(String(b.status || ''))
  },

  sortFiltered() {
    const cmp = this.SORT_COMPARATORS[App.State.productionSortBy];
    if (cmp) App.State.filteredProduction.sort(cmp);
  },

  sortBy(value) {
    App.State.productionSortBy = value;
    this.sortFiltered();
    App.State.productionCurrentPage = 1;
    this.renderTable();
  },

  changePage(page) {
    App.State.productionCurrentPage = App.Utils.clampPage(page, App.State.filteredProduction.length, App.State.productionRowsPerPage);
    this.renderTable();
  },

  // Opens the Colorwise Production Summary modal, populating the Process
  // filter from already-loaded process master data (no extra server
  // call). presetProcessId (optional) overrides the filter's last-used
  // value -- used by the Dashboard's pipeline drill-down.
  openColorwiseSummaryModal(presetProcessId) {
    const select = document.getElementById('colorwiseSummaryProcessFilter');
    if (select) {
      if (window.jQuery?.fn?.select2 && window.jQuery(select).data('select2'))
        window.jQuery(select).select2('destroy');
      const current = presetProcessId !== undefined ? presetProcessId : select.value;
      const options = (App.State.globalProcesses || [])
        .slice()
        .sort((a, b) => (a.sequence || 0) - (b.sequence || 0))
        .map(p => `<option value="${escapeHtml(p.processId)}">${escapeHtml(p.processName)} (Seq ${p.sequence})</option>`)
        .join('');
      select.innerHTML = '<option value="">All Processes</option>' + options;
      select.value = current;
      if (window.jQuery?.fn?.select2) {
        const $s = window.jQuery(select);
        const $modal = $s.closest('.modal');
        $s.select2({
          placeholder: 'All Processes',
          width: '100%',
          allowClear: true,
          matcher: App.Utils.select2Matcher,
          dropdownParent: $modal.length ? $modal : window.jQuery(document.body)
        });
      }
    }
    const statusSelect = document.getElementById('colorwiseSummaryStatusFilter');
    if (statusSelect && window.jQuery?.fn?.select2 && !window.jQuery(statusSelect).data('select2')) {
      const $ss = window.jQuery(statusSelect);
      const $modal = $ss.closest('.modal');
      $ss.select2({
        placeholder: 'All Statuses',
        width: '100%',
        allowClear: true,
        matcher: App.Utils.select2Matcher,
        dropdownParent: $modal.length ? $modal : window.jQuery(document.body)
      });
    }
    this.renderColorwiseSummary();
    const modalEl = document.getElementById('colorwiseSummaryModal');
    if (modalEl && typeof bootstrap !== 'undefined') new bootstrap.Modal(modalEl).show();
  },

  // Aggregates qty per color across all production lots (using each
  // lot's colorBreakdown when present, else its single Color field with
  // full lot qty), split by status, honoring the Process/Status filters.
  // Reads purely from already-loaded App.State.globalProduction -- no
  // server call.
  renderColorwiseSummary() {
    const tbody = document.getElementById('colorwiseSummaryBody');
    const emptyState = document.getElementById('colorwiseSummaryEmptyState');
    if (!tbody) return;

    const processFilter = (document.getElementById('colorwiseSummaryProcessFilter') || {}).value || '';
    const statusFilter = (document.getElementById('colorwiseSummaryStatusFilter') || {}).value || '';

    // Bucketed by color+axisKey, not color alone -- two independent Color
    // Axes can legitimately share a literal color name.
    const totals = {}; // "color||axisKey" -> { color, axisKey, Pending, 'In Progress', Completed, Cancelled, lots }
    const ensure = (color, axisKey) => {
      const key = color + '||' + (axisKey || '');
      if (!totals[key]) totals[key] = { color, axisKey: axisKey || '', Pending: 0, 'In Progress': 0, Completed: 0, Cancelled: 0, lots: 0 };
      return totals[key];
    };

    (App.State.globalProduction || []).forEach(p => {
      if (processFilter && p.processId !== processFilter) return;
      if (statusFilter && p.status !== statusFilter) return;

      const entries = (p.colorBreakdown && p.colorBreakdown.length > 0)
        ? p.colorBreakdown
        : (p.color ? [{ color: p.color, qty: p.qty }] : [{ color: 'Uncolored', qty: p.qty }]);

      entries.forEach(e => {
        const bucket = ensure(e.color || 'Uncolored', e.axisKey);
        bucket.lots += 1;
        if (bucket[p.status] !== undefined) bucket[p.status] += (Number(e.qty) || 0);
      });
    });

    const rows = Object.values(totals).sort((a, b) =>
      a.color.localeCompare(b.color) || a.axisKey.localeCompare(b.axisKey));
    if (rows.length === 0) {
      tbody.innerHTML = '';
      if (emptyState) emptyState.style.display = 'block';
      return;
    }
    if (emptyState) emptyState.style.display = 'none';

    // A color name split across 2+ rows only because different axes
    // share it needs its axis shown alongside, or those rows look like
    // an unexplained duplicate; a color used by just one axis (the
    // overwhelming common case) renders exactly as before.
    const colorRowCounts = {};
    rows.forEach(t => { colorRowCounts[t.color] = (colorRowCounts[t.color] || 0) + 1; });

    tbody.innerHTML = rows.map(t => {
      const total = t.Pending + t['In Progress'] + t.Completed + t.Cancelled;
      const qualifier = colorRowCounts[t.color] > 1 ? this._axisQualifierLabel(t.axisKey) : '';
      const label = qualifier
        ? `${escapeHtml(t.color)} <small class="text-muted">(${escapeHtml(qualifier)})</small>`
        : escapeHtml(t.color);
      return `<tr>
    <td class="fw-bold">${label}</td>
    <td class="text-center">${t.lots}</td>
    <td class="text-center">${this.formatQty(t.Pending)}</td>
    <td class="text-center">${this.formatQty(t['In Progress'])}</td>
    <td class="text-center fw-bold text-success">${this.formatQty(t.Completed)}</td>
    <td class="text-center text-muted">${this.formatQty(t.Cancelled)}</td>
    <td class="text-center fw-bold">${this.formatQty(total)}</td>
  </tr>`;
    }).join('');
  },

  // Human-readable qualifier for an axisKey, used only to disambiguate
  // two different axes that happen to produce the exact same color name.
  _axisQualifierLabel(axisKey) {
    const key = String(axisKey || '').trim();
    if (!key) return '';
    const m = key.match(/^(pool|tag):(.+)$/i);
    return m ? m[2] : key;
  },

  renderTable() {
    const tbody = document.getElementById('productionTableBody');
    if (!tbody) return;

    const emptyState = document.getElementById('productionEmptyState');
    if (App.State.filteredProduction.length === 0) {
      tbody.innerHTML = '';
      if (emptyState) emptyState.style.display = 'block';
      App.Utils.renderPagination('productionPagination', 0, 1, App.State.productionRowsPerPage, 'production-page', 'Production Lots');
      this.updateBulkButtons();
      return;
    }
    if (emptyState) emptyState.style.display = 'none';

    const { filteredProduction, productionCurrentPage: cur, productionRowsPerPage: rpp } = App.State;
    const start = (cur - 1) * rpp;
    const pageItems = filteredProduction.slice(start, start + rpp);

    const selectAllChk = document.getElementById('selectAllProduction');
    if (selectAllChk) {
      selectAllChk.checked = pageItems.length > 0 &&
        pageItems.every(p => App.Selection.isSelected(App.State.selectedProduction, String(p.rowIdx)));
    }

    let html = '';
    pageItems.forEach(p => {
      const idx = App.State.globalProduction.indexOf(p);
      const key = String(p.rowIdx);
      const checked = App.Selection.isSelected(App.State.selectedProduction, key) ? 'checked' : '';

      const process = (App.State.globalProcesses || []).find(pr => pr.processId === p.processId);
      const processLabel = process ? process.processName : (p.processId || 'Uncategorized');

      const statusOptions = this.STATUS_OPTIONS
        .map(s => `<option value="${s}" ${s === p.status ? 'selected' : ''}>${s}</option>`)
        .join('');

      const colorBadges = (p.colorBreakdown && p.colorBreakdown.length > 0)
        ? p.colorBreakdown.map(c => `<span class="badge bg-info text-dark me-1">${escapeHtml(c.color)}${c.size ? ` (${escapeHtml(c.size)})` : ''}: ${this.formatQty(c.qty)}</span>`).join('')
        : (p.color ? `<span class="badge bg-info text-dark">${escapeHtml(p.color)}</span>` : '');

      html += `<tr>
    <td class="text-center"><input type="checkbox" class="form-check-input production-select-chk" data-key="${escapeHtml(key)}" ${checked} onchange="App.Production.onRowSelectChange()"></td>
    <td>${escapeHtml(p.date)}</td>
    <td><strong>${escapeHtml(processLabel)}</strong><br><span class="badge bg-secondary">${escapeHtml(p.lotNumber || '-')}</span></td>
    <td>${escapeHtml(p.outputItemName || '-')}${colorBadges ? `<br>${colorBadges}` : ''}</td>
    <td>${p.productId ? `<span class="badge bg-dark fs-6 shadow-sm">${escapeHtml(p.productId)}</span><br>${escapeHtml(p.productName || '')}` : '<span class="text-muted">—</span>'}</td>
    <td class="text-center fw-bold">${escapeHtml(String(p.qty))} Units</td>
    <td>${escapeHtml(p.assignedBy || '-')}</td>
    <td>${escapeHtml(p.assignedTo || '-')}${p.contractorPayable ? `<br><span class="badge bg-light text-dark border">${formatCurrency(p.contractorPayable)}</span>` : ''}</td>
    <td class="text-center">
      <select class="form-select form-select-sm fw-bold border-0 shadow-sm" style="font-size:0.75rem;appearance:none;-webkit-appearance:none;-moz-appearance:none;background-image:none;padding-right:0.5rem;${this.statusStyleFor(p.status)}" data-row-idx="${idx}" onchange="App.Production.updateStatus(this)" title="Change status directly without opening Edit Lot">${statusOptions}</select>
    </td>
    <td>
      <button class="btn btn-sm btn-outline-dark btn-action w-100 mb-1" onclick="App.Production.viewProductionSheet('${idx}')">Production Sheet</button>
      <button class="btn btn-sm btn-outline-primary btn-action w-100 mb-1" onclick="App.Production.openEditModal('${idx}')">Edit Lot</button>
      <button class="btn btn-sm btn-danger btn-action w-100" onclick="App.Production.delete('${p.rowIdx}', '${escapeHtml(p.productId)}', '${p.qty}')">Delete</button>
    </td>
  </tr>`;
    });

    tbody.innerHTML = html;

    App.Utils.renderPagination('productionPagination', filteredProduction.length, cur, rpp, 'production-page', 'Production Lots');
    this.updateBulkButtons();
  },

  toggleSelectAll(masterChk) {
    App.Selection.toggleAll(App.State.selectedProduction, 'production-select-chk', masterChk);
    this.updateBulkButtons();
  },

  onRowSelectChange() {
    App.Selection.syncFromRows(App.State.selectedProduction, 'production-select-chk', 'selectAllProduction');
    this.updateBulkButtons();
  },

  updateBulkButtons() {
    const count = App.State.selectedProduction.length;
    App.Selection.updateButton('btnBulkDeleteProduction', count, '<i class="bi bi-trash"></i> Delete Selected');
    App.Selection.updateButton('btnBulkPrintProduction', count, '<i class="bi bi-printer"></i> Print Selected');
  },

  async bulkDelete() {
    const selected = App.State.selectedProduction.slice();
    if (selected.length === 0) return;

    // Lets the server skip (not blindly delete) any row that no longer
    // matches what was on screen when it was selected.
    const expectedRows = (App.State.globalProduction || [])
      .filter(p => App.Selection.isSelected(selected, String(p.rowIdx)))
      .map(p => ({ rowIdx: p.rowIdx, expectedProductId: p.productId, expectedQty: p.qty }));

    App.Utils.confirmAction(
      `Are you sure you want to permanently delete ${selected.length} selected production record(s)?`,
      async () => {
        try {
          const res = await Api.mutate('deleteProductionBulk', selected, expectedRows);
          App.Utils.showToast(res.message, !res.success);
          if (res.success) {
            App.State.selectedProduction = [];
            await this.loadData();
          }
        } catch (err) {
          App.Utils.showToast(err.message || 'Failed to delete production records', true);
        }
      }
    );
  },

  bulkPrint() {
    if (typeof App.Print === 'undefined') {
      App.Utils.notPortedYet('Printing');
      return;
    }

    const selected = App.State.selectedProduction;
    if (selected.length === 0) return;

    const lots = App.State.globalProduction.filter(p => App.Selection.isSelected(selected, String(p.rowIdx)));
    if (lots.length === 0) return;

    App.Print.triggerBulk(lots, p => this.buildProductionSheetPrintPageHtml(p), 'Production_Sheets_Selected');
  },

  // Builds a fully self-contained "Production Material Requirement Sheet"
  // page (mirrors #print-production-sheet-container's markup/styling)
  // for bulk printing.
  buildProductionSheetPrintPageHtml(p) {
    const BRAND = '#198754';
    const components = p.componentsConsumed || [];

    let rowsHtml = '';
    components.forEach(comp => {
      rowsHtml += `<tr>
    <td style="padding:6px;border:1px solid #ddd;text-align:left;">${escapeHtml(comp.itemName || '')}</td>
    <td style="padding:6px;border:1px solid #ddd;">${escapeHtml(comp.size || '-')}</td>
    <td style="padding:6px;border:1px solid #ddd;">${escapeHtml(comp.sourceType === 'POOL' ? 'Pool' : 'Item')}</td>
    <td style="padding:6px;border:1px solid #ddd;text-align:right;font-weight:700;">${escapeHtml(this.formatQty(comp.qty))}</td>
  </tr>`;
    });
    const rows = rowsHtml || '<tr><td colspan="4" style="padding:10px;text-align:center;color:#999;">No components recorded for this lot.</td></tr>';

    const remarksHtml = p.sheetRemarks ? `
  <div style="margin-top:10px;padding-top:8px;border-top:1px solid #ccc;">
    <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Remarks</span>
    <div style="font-size:12px;color:#1a1a1a;margin-top:2px;white-space:pre-wrap;">${escapeHtml(p.sheetRemarks)}</div>
  </div>` : '';

    return `
<div style="background:#fff;color:#1a1a1a;font-family:'Segoe UI',Arial,sans-serif;font-size:12px;line-height:1.5;padding:14px 20px 12px 20px;margin:0;box-sizing:border-box;width:100%;border-top:5px solid ${BRAND};border-bottom:3px solid ${BRAND};-webkit-print-color-adjust:exact;print-color-adjust:exact;">
  <div style="text-align:center;padding:4px 0 8px 0;">
    ${App.Print.brandHeaderHtml(BRAND)}
    <div style="font-size:10px;color:#555;margin-top:3px;letter-spacing:0.3px;">
      6-B, SHIV SHAKTI ESTATE, VERKA CHOWK, DEHLON ROAD, BHAGWANPURA, 141114 LUDHIANA
    </div>
    <div style="font-size:11px;color:${BRAND};font-weight:700;margin-top:4px;letter-spacing:1px;text-transform:uppercase;">
      Production Material Requirement Sheet
    </div>
  </div>
  <div style="height:2px;background:${BRAND};margin:0 0 12px 0;-webkit-print-color-adjust:exact;print-color-adjust:exact;"></div>

  <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid #ccc;">
    <div>
      <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Date</span>
      <div style="font-size:13px;font-weight:700;color:#1a1a1a;">${escapeHtml(p.date || '')}</div>
    </div>
    <div>
      <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Product ID</span>
      <div style="font-size:13px;font-weight:700;color:#1a1a1a;">${escapeHtml(p.productId || '')}</div>
    </div>
    <div>
      <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Product Name</span>
      <div style="font-size:13px;font-weight:700;color:#1a1a1a;">${escapeHtml(p.productName || '')}</div>
    </div>
    ${(p.colorBreakdown && p.colorBreakdown.length > 0) ? `
    <div>
      <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Colors</span>
      <div style="font-size:13px;font-weight:700;color:#1a1a1a;">${escapeHtml(p.colorBreakdown.map(c => `${c.color}${c.size ? ` (${c.size})` : ''}: ${this.formatQty(c.qty)}`).join(', '))}</div>
    </div>` : (p.color ? `
    <div>
      <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Color</span>
      <div style="font-size:13px;font-weight:700;color:#1a1a1a;">${escapeHtml(p.color)}</div>
    </div>` : '')}
    <div>
      <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Lot Qty</span>
      <div style="font-size:13px;font-weight:700;color:#1a1a1a;">${this.formatQty(p.qty)}</div>
    </div>
  </div>

  <table style="width:100%;border-collapse:collapse;margin-bottom:14px;font-size:12px;">
    <thead style="background-color:${BRAND};color:#fff;text-align:center;font-weight:700;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
      <tr>
        <th style="padding:6px;border:1px solid #bbb;text-align:left;width:45%;">Item / Pool Name</th>
        <th style="padding:6px;border:1px solid #bbb;width:20%;">Size</th>
        <th style="padding:6px;border:1px solid #bbb;width:20%;">Source</th>
        <th style="padding:6px;border:1px solid #bbb;text-align:right;width:15%;">Qty</th>
      </tr>
    </thead>
    <tbody style="color:#1a1a1a;text-align:center;">${rows}</tbody>
  </table>
  ${remarksHtml}
</div>`;
  },

  delete(rowIdx, productId, qty) {
    App.Utils.confirmAction(
      `Are you sure you want to permanently delete this Production Lot (Qty: ${qty})?`,
      async () => {
        try {
          const res = await Api.mutate('deleteProduction', rowIdx, productId, qty);
          App.Utils.showToast(res.message, !res.success);
          if (res.success) {
            await this.loadData();
          }
        } catch (err) {
          App.Utils.showToast(err.message || 'Failed to delete Production Log', true);
        }
      }
    );
  },

  // Trims floating-point noise (e.g. 0.1 * 3 = 0.30000000000000004) for
  // display. Duplicates api.js's shared formatQty verbatim, matching
  // source's own choice to keep its own copy here.
  formatQty(value) {
    const n = toNumber(value);
    return Number(n.toFixed(4)).toString();
  },

  // ── Create/Edit Lot modal: cascading Size->Model->Process Type->Process ──
  // Mirrors Process/BOM's own cascading-dropdown pattern (see process.js).

  _suppressCascade: false,
  _compLoadSeq: 0,

  populateProductSelect() {
    const select = document.getElementById('productionProductId');
    if (!select) return;

    const currentValue = select.value;
    let html = '<option value="">— Untagged (stays in Warehouse Pool only) —</option>';
    (App.State.globalBOMs || []).forEach(bom => {
      html += `<option value="${escapeHtml(bom.productId)}">${escapeHtml(bom.productId)} (${escapeHtml(bom.productName)})</option>`;
    });
    select.innerHTML = html;
    select.value = currentValue;
  },

  handleProductChange(productId) {
    const nameHiddenInput = document.getElementById('productionProductNameHidden');
    const idHiddenInput = document.getElementById('productionProductIdHidden');
    if (!productId) {
      if (nameHiddenInput) nameHiddenInput.value = '';
      if (idHiddenInput) idHiddenInput.value = '';
      return;
    }
    const matchedBOM = (App.State.globalBOMs || []).find(b => b.productId === productId);
    if (idHiddenInput) idHiddenInput.value = productId;
    if (nameHiddenInput) nameHiddenInput.value = matchedBOM ? matchedBOM.productName : '';
  },

  populateSizeSelect() {
    const select = document.getElementById('productionSize');
    if (!select) return;
    if (window.jQuery?.fn?.select2 && window.jQuery(select).data('select2')) window.jQuery(select).select2('destroy');

    const currentValue = select.value;
    const sizesPresent = new Set(
      (App.State.globalProcesses || []).filter(p => p.active).map(p => App.Utils.getSizeFromOutputItemName(p.outputItemName))
    );
    const ordered = App.Utils.PROCESS_SIZE_LIST.filter(s => sizesPresent.has(s));
    if (sizesPresent.has('General')) ordered.push('General');

    let html = '<option value="">Choose a Size...</option>';
    ordered.forEach(s => { html += `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`; });
    select.innerHTML = html;
    select.value = currentValue;
    App.Utils.autoSelectOnlyOption(select);

    if (window.jQuery?.fn?.select2) {
      const $s = window.jQuery(select);
      const $modal = $s.closest('.modal');
      $s.select2({ placeholder: 'Choose a Size...', width: '100%', matcher: App.Utils.select2Matcher, dropdownParent: $modal.length ? $modal : window.jQuery(document.body) });
    }
  },

  handleSizeChange(size) {
    if (this._suppressCascade) return;
    this.populateModelSelect(size);

    const modelSelect = document.getElementById('productionModel');
    if (modelSelect) {
      this._suppressCascade = true;
      try {
        modelSelect.disabled = !size;
        modelSelect.value = '';
        if (window.jQuery?.fn?.select2 && window.jQuery(modelSelect).data('select2')) window.jQuery(modelSelect).trigger('change.select2');
        if (size) App.Utils.autoSelectOnlyOption(modelSelect);
      } finally {
        this._suppressCascade = false;
      }
    }
    return this.handleModelChange(modelSelect ? modelSelect.value : '');
  },

  populateModelSelect(sizeFilter) {
    const select = document.getElementById('productionModel');
    if (!select) return;
    if (window.jQuery?.fn?.select2 && window.jQuery(select).data('select2')) window.jQuery(select).select2('destroy');

    const currentValue = select.value;
    const matches = (App.State.globalProcesses || []).filter(p => p.active)
      .filter(p => !sizeFilter || App.Utils.getSizeFromOutputItemName(p.outputItemName) === sizeFilter);

    const modelsPresent = new Set(matches.map(p => App.Utils.getModelFromOutputItemName(p.outputItemName)));
    const modelNames = (App.State.globalModels || []).map(m => m.name);
    const ordered = modelNames.filter(m => modelsPresent.has(m));
    if (modelsPresent.has('General')) ordered.push('General');

    let html = sizeFilter ? '<option value="">Choose a Model...</option>' : '<option value="">Choose a Size first...</option>';
    ordered.forEach(m => { html += `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`; });
    select.innerHTML = html;
    select.value = currentValue;
    App.Utils.autoSelectOnlyOption(select);

    if (window.jQuery?.fn?.select2) {
      const $s = window.jQuery(select);
      const $modal = $s.closest('.modal');
      $s.select2({ placeholder: sizeFilter ? 'Choose a Model...' : 'Choose a Size first...', width: '100%', matcher: App.Utils.select2Matcher, dropdownParent: $modal.length ? $modal : window.jQuery(document.body) });
    }
  },

  handleModelChange(model) {
    if (this._suppressCascade) return;
    const size = document.getElementById('productionSize')?.value || '';
    this.populateProcessTypeSelect(size, model);

    const typeSelect = document.getElementById('productionProcessType');
    if (typeSelect) {
      this._suppressCascade = true;
      try {
        typeSelect.disabled = !model;
        typeSelect.value = '';
        if (window.jQuery?.fn?.select2 && window.jQuery(typeSelect).data('select2')) window.jQuery(typeSelect).trigger('change.select2');
        if (model) App.Utils.autoSelectOnlyOption(typeSelect);
      } finally {
        this._suppressCascade = false;
      }
    }
    return this.handleProcessTypeChange(typeSelect ? typeSelect.value : '');
  },

  populateProcessTypeSelect(sizeFilter, modelFilter) {
    const select = document.getElementById('productionProcessType');
    if (!select) return;
    if (window.jQuery?.fn?.select2 && window.jQuery(select).data('select2')) window.jQuery(select).select2('destroy');

    const currentValue = select.value;
    const matches = (App.State.globalProcesses || []).filter(p => p.active)
      .filter(p => !sizeFilter || App.Utils.getSizeFromOutputItemName(p.outputItemName) === sizeFilter)
      .filter(p => !modelFilter || App.Utils.getModelFromOutputItemName(p.outputItemName) === modelFilter);

    const typesPresent = new Set(matches.map(p => String(p.processType || 'General').trim().toLowerCase()));
    const typeNames = (App.State.globalProcessTypes || []).map(t => t.name);
    const ordered = typeNames.filter(t => typesPresent.has(t.trim().toLowerCase()));
    if (typesPresent.has('general')) ordered.push('General');

    let html = modelFilter ? '<option value="">Choose a Process Type...</option>' : '<option value="">Choose a Model first...</option>';
    ordered.forEach(t => { html += `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`; });
    select.innerHTML = html;
    select.value = currentValue;
    App.Utils.autoSelectOnlyOption(select);

    if (window.jQuery?.fn?.select2) {
      const $s = window.jQuery(select);
      const $modal = $s.closest('.modal');
      $s.select2({ placeholder: modelFilter ? 'Choose a Process Type...' : 'Choose a Model first...', width: '100%', matcher: App.Utils.select2Matcher, dropdownParent: $modal.length ? $modal : window.jQuery(document.body) });
    }
  },

  handleProcessTypeChange(type) {
    if (this._suppressCascade) return;
    const size = document.getElementById('productionSize')?.value || '';
    const model = document.getElementById('productionModel')?.value || '';

    const processSelect = document.getElementById('productionProcessId');
    this._suppressCascade = true;
    try {
      this.populateProcessSelect(size, type, model);
      if (processSelect) {
        processSelect.disabled = !type;
        processSelect.value = '';
        if (type) App.Utils.autoSelectOnlyOption(processSelect);
      }
      this.initProcessSelect2();
    } finally {
      this._suppressCascade = false;
    }

    return this.handleProcessChange(processSelect ? processSelect.value : '');
  },

  populateProcessSelect(sizeFilter, typeFilter, modelFilter) {
    const select = document.getElementById('productionProcessId');
    if (!select) return;

    const currentValue = select.value;
    const matches = (App.State.globalProcesses || []).filter(p => p.active)
      .filter(p => !sizeFilter || App.Utils.getSizeFromOutputItemName(p.outputItemName) === sizeFilter)
      .filter(p => !modelFilter || App.Utils.getModelFromOutputItemName(p.outputItemName) === modelFilter)
      .filter(p => !typeFilter || App.Utils.sameText(p.processType || 'General', typeFilter));

    let html = typeFilter ? '<option value="">Choose a Process...</option>' : '<option value="">Choose a Process Type first...</option>';

    if (typeFilter) {
      const byStage = new Map();
      matches.forEach(p => {
        if (!byStage.has(p.sequence)) byStage.set(p.sequence, []);
        byStage.get(p.sequence).push(p);
      });
      [...byStage.keys()].sort((a, b) => a - b).forEach(seq => {
        html += `<optgroup label="Stage ${escapeHtml(String(seq))}">`;
        byStage.get(seq).forEach(p => { html += `<option value="${escapeHtml(p.processId)}">${escapeHtml(p.processName)}</option>`; });
        html += '</optgroup>';
      });
    } else {
      matches.forEach(p => { html += `<option value="${escapeHtml(p.processId)}">${escapeHtml(p.processName)} (Seq ${escapeHtml(String(p.sequence))})</option>`; });
    }

    select.innerHTML = html;
    select.value = currentValue;
    App.Utils.autoSelectOnlyOption(select);
  },

  initProcessSelect2() {
    const selectEl = document.getElementById('productionProcessId');
    if (!selectEl || !window.jQuery?.fn?.select2) return;
    const $select = window.jQuery(selectEl);
    if ($select.data('select2')) $select.select2('destroy');
    const $parentModal = $select.closest('.modal');
    $select.select2({ placeholder: 'Choose a Process...', width: '100%', matcher: App.Utils.select2Matcher, dropdownParent: $parentModal.length ? $parentModal : window.jQuery(document.body) });
  },

  // Fired when Process changes: populates Output Item Name / Product tag
  // visibility, then loads the recipe into the Components Consumed table.
  //
  // Adaptation from source: source branches here into the multi-axis
  // Color Checklist when getProcessColorGroups returns any colors (see
  // this file's module header). That system isn't ported yet, so this
  // round instead shows a blocking notice and leaves the simple
  // single-Qty table empty -- once the Color Checklist round lands, this
  // function's `else` branch is exactly where it plugs back in.
  async handleProcessChange(processId) {
    if (this._suppressCascade) return;
    const seq = ++this._compLoadSeq;

    const tagWrapper = document.getElementById('productionProductTagWrapper');
    const outputEl = document.getElementById('productionOutputItemName');
    const process = (App.State.globalProcesses || []).find(p => p.processId === processId);

    if (outputEl) outputEl.value = process ? (process.outputItemName || '') : '';

    if (tagWrapper) tagWrapper.style.display = (process && process.isFinalStage) ? '' : 'none';
    if (!process || !process.isFinalStage) {
      const select = document.getElementById('productionProductId');
      if (select) select.value = '';
      this.handleProductChange('');
    }

    this._setMultiColorNotice(false);
    this.clearComponentsTable();

    if (!processId) return;

    let colors = [];
    try {
      const res = await Api.call('getProcessColorGroups', processId);
      colors = res.success ? (res.data || []) : [];
    } catch (err) {
      colors = [];
    }
    if (seq !== this._compLoadSeq) return;

    if (colors.length > 0) {
      this._setMultiColorNotice(true);
      return;
    }

    await this.populateComponentsFromProcess(processId, seq);
    if (seq !== this._compLoadSeq) return;
    this.refreshPayableHint();
  },

  // Shows/hides the "this process needs the not-yet-ported Color
  // Checklist" notice and disables Save while it's up, instead of
  // letting the operator submit a form the simple single-Qty path can't
  // correctly represent.
  _setMultiColorNotice(show) {
    const notice = document.getElementById('productionMultiColorNotice');
    if (notice) notice.style.display = show ? '' : 'none';
    const qtyWrapper = document.getElementById('productionQtyWrapper');
    if (qtyWrapper) qtyWrapper.style.display = show ? 'none' : '';
    const qtyInput = document.getElementById('productionQty');
    if (qtyInput) qtyInput.required = !show;
    const submitBtn = document.getElementById('productionSubmitBtn');
    if (submitBtn) submitBtn.disabled = show;
  },

  async populateComponentsFromProcess(processId, seq) {
    this.clearComponentsTable();
    if (!processId) return;

    try {
      const res = await Api.call('getProcessComponentsData', processId);
      if (seq !== undefined && seq !== this._compLoadSeq) return;
      const all = res.success ? (res.data || []) : [];
      const components = all.filter(c => !c.colorGroup || c.colorGroup === 'COMMON');
      const lotQty = toNumber(document.getElementById('productionQty')?.value) || 0;
      components.forEach(c => this.addComponentRow({
        itemName: c.itemName,
        size: c.size,
        sourceType: c.sourceType,
        qty: lotQty > 0 ? lotQty * c.qtyPerUnit : c.qtyPerUnit,
        qtyPerUnit: c.qtyPerUnit,
        unit: c.unit
      }));
      await this.refreshPoolAvailability();
    } catch (err) {
      if (seq === undefined || seq === this._compLoadSeq) App.Utils.showToast(err.message || 'Failed to load process recipe', true);
    }
  },

  refreshSuggestedComponentQty() {
    const lotQty = toNumber(document.getElementById('productionQty')?.value) || 0;
    document.querySelectorAll('#productionComponentsBody tr').forEach(row => {
      const qtyPerUnit = row.dataset.qtyPerUnit;
      if (qtyPerUnit === undefined || qtyPerUnit === '') return;
      const qtyInput = row.querySelector('.prod-comp-qty');
      if (qtyInput) qtyInput.value = this.formatQty(lotQty * toNumber(qtyPerUnit));
    });
  },

  clearComponentsTable() {
    const tbody = document.getElementById('productionComponentsBody');
    if (!tbody) return;
    tbody.querySelectorAll('tr').forEach(row => this.destroyComponentItemSelect2(row));
    tbody.innerHTML = '';
  },

  _buildItemPreselectOption(itemName, size, sourceType) {
    if (!itemName) return '';
    if (sourceType === 'POOL') {
      return `<option value="pool:${escapeHtml(itemName)}" selected data-name="${escapeHtml(itemName)}">${escapeHtml(itemName)}</option>`;
    }
    const items = App.State.globalItems || [];
    const matchIdx = items.findIndex(item =>
      App.Utils.sameText(item.name, itemName) && (App.Utils.sameText(size || '', item.size || '') || (!size && !item.size))
    );
    if (matchIdx >= 0) {
      const item = items[matchIdx];
      const label = `${item.name}${item.size ? ` [${item.size}]` : ''}`;
      return `<option value="${matchIdx}" selected data-name="${escapeHtml(item.name)}">${escapeHtml(label)}</option>`;
    }
    const label = `${itemName}${size ? ` [${size}]` : ''}`;
    return `<option value="custom:${escapeHtml(itemName)}" selected data-name="${escapeHtml(itemName)}">${escapeHtml(label)}</option>`;
  },

  addComponentRow(comp = null) {
    const tbody = document.getElementById('productionComponentsBody');
    if (!tbody) return;

    const rowId = 'prod_comp_row_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    const itemName = (comp && comp.itemName) || '';
    const size = (comp && comp.size) || '';
    const sourceType = (comp && comp.sourceType === 'POOL') ? 'POOL' : 'ITEM';
    const color = (comp && comp.color) || '';
    const qty = comp && comp.qty !== undefined ? this.formatQty(comp.qty) : '';
    const qtyPerUnitAttr = (comp && comp.qtyPerUnit !== undefined) ? `data-qty-per-unit="${comp.qtyPerUnit}"` : '';
    const unitAttr = (comp && comp.unit) ? ` data-unit="${escapeHtml(comp.unit)}"` : '';
    const preSelectedOption = this._buildItemPreselectOption(itemName, size, sourceType);

    const rowHtml = `
      <tr id="${rowId}" ${qtyPerUnitAttr}${unitAttr}>
        <td>
          <select class="form-select prod-comp-item-select" required>
            <option value=""></option>
            ${preSelectedOption}
          </select>
        </td>
        <td><input type="text" class="form-control prod-comp-size" value="${escapeHtml(size)}" placeholder="-" onchange="App.Production.refreshPoolAvailability()"></td>
        <td><input type="text" class="form-control prod-comp-color" list="colorList" value="${escapeHtml(color)}" placeholder="All colors"></td>
        <td>
          <select class="form-select prod-comp-source" onchange="App.Production.handleSourceChange(this)">
            <option value="ITEM" ${sourceType === 'ITEM' ? 'selected' : ''}>Item (Stock)</option>
            <option value="POOL" ${sourceType === 'POOL' ? 'selected' : ''}>Pool (Warehouse)</option>
          </select>
        </td>
        <td><input type="number" class="form-control text-end prod-comp-qty" min="0" step="any" value="${qty}" required></td>
        <td class="prod-comp-available text-muted small">-</td>
        <td class="text-center"><button type="button" class="btn btn-outline-danger btn-sm" onclick="App.Production.removeComponentRow('${rowId}')">✕</button></td>
      </tr>
    `;
    tbody.insertAdjacentHTML('beforeend', rowHtml);
    this.initComponentItemSelect2(document.getElementById(rowId));
  },

  removeComponentRow(rowId) {
    const row = document.getElementById(rowId);
    if (row) {
      this.destroyComponentItemSelect2(row);
      row.remove();
    }
  },

  handleSourceChange(selectEl) {
    const row = selectEl.closest('tr');
    const itemSelect = row?.querySelector('.prod-comp-item-select');
    if (itemSelect && window.jQuery?.fn?.select2) window.jQuery(itemSelect).val(null).trigger('change');
    const sizeInput = row?.querySelector('.prod-comp-size');
    if (sizeInput) sizeInput.value = '';
    this.refreshPoolAvailability();
  },

  initComponentItemSelect2(rowEl) {
    this._wireItemSelect2(rowEl?.querySelector('.prod-comp-item-select'));
  },

  _wireItemSelect2(selectEl) {
    if (!selectEl || !window.jQuery?.fn?.select2) return;

    const $select = window.jQuery(selectEl);
    const PAGE_SIZE = 40;
    const $parentModal = $select.closest('.modal');

    $select.select2({
      placeholder: 'Search or type an item/pool name...',
      width: '100%',
      tags: true,
      dropdownParent: $parentModal.length ? $parentModal : window.jQuery(document.body),
      ajax: {
        delay: 150,
        data(params) { return { q: params.term || '', page: params.page || 1 }; },
        transport(params, success) {
          const q = (params.data.q || '').trim();
          const page = params.data.page || 1;
          const isPool = selectEl.closest('tr')?.querySelector('.prod-comp-source')?.value === 'POOL';
          const items = isPool
            ? App.Process.getDistinctOutputItemNames().map(name => ({ name, size: '' }))
            : (App.State.globalItems || []);
          const start = (page - 1) * PAGE_SIZE;

          const pool = q
            ? items.map((item, idx) => ({ idx, item })).filter(({ item }) => App.Utils.matchesKeywords(`${item.name} ${item.size || ''}`, q))
            : items.map((item, idx) => ({ idx, item }));

          const pageItems = pool.slice(start, start + PAGE_SIZE);
          success({
            results: pageItems.map(({ idx, item }) => ({
              id: (isPool ? 'pool:' : 'item:') + idx,
              text: `${item.name}${item.size ? ` [${item.size}]` : ''}`,
              _itemName: item.name, _size: item.size || ''
            })),
            pagination: { more: (start + PAGE_SIZE) < pool.length }
          });
        },
        processResults(data) { return data; }
      },
      createTag(params) {
        const term = (params.term || '').trim();
        if (!term) return null;
        const isPool = selectEl.closest('tr')?.querySelector('.prod-comp-source')?.value === 'POOL';
        const items = isPool
          ? App.Process.getDistinctOutputItemNames().map(name => ({ name, size: '' }))
          : (App.State.globalItems || []);
        const existing = items.find(it => App.Utils.sameText(it.name, term));
        if (existing) {
          return { id: (isPool ? 'pool:' : 'item:') + existing.name, text: `${existing.name}${existing.size ? ` [${existing.size}]` : ''}`, _itemName: existing.name, _size: existing.size || '' };
        }
        return { id: 'custom:' + term, text: term, newTag: true, _itemName: term, _size: '' };
      }
    });

    $select.on('select2:select', function (e) {
      const data = e.params.data;
      const opt = selectEl.options[selectEl.selectedIndex];
      if (opt) opt.dataset.name = data._itemName || data.text;

      const row = selectEl.closest('tr');
      const sizeInput = row?.querySelector('.prod-comp-size');
      if (sizeInput && !sizeInput.value) sizeInput.value = data._size || '';
      App.Production.refreshPoolAvailability();
    });
  },

  destroyComponentItemSelect2(rowEl) {
    if (!rowEl || !window.jQuery?.fn?.select2) return;
    rowEl.querySelectorAll('.prod-comp-item-select').forEach(selectEl => {
      const $select = window.jQuery(selectEl);
      if ($select.data('select2')) $select.select2('destroy');
    });
  },

  async refreshPoolAvailability() {
    const processId = document.getElementById('productionProcessId')?.value;

    try {
      const [wipRes, stockRes] = await Promise.all([
        processId ? Api.call('getProcessWipData', processId) : Promise.resolve({ success: true, data: [] }),
        Api.call('getStockData')
      ]);
      const wip = wipRes.success ? (wipRes.data || []) : [];
      const stock = stockRes.success ? (stockRes.data || []) : [];
      if (stockRes.success) {
        App.State.globalStock = stock;
        App.State.filteredStock = [...stock];
      }

      document.querySelectorAll('#productionComponentsBody tr').forEach(row => {
        const sourceSel = row.querySelector('.prod-comp-source');
        const availEl = row.querySelector('.prod-comp-available');
        if (!sourceSel || !availEl) return;

        const itemSelect = row.querySelector('.prod-comp-item-select');
        const itemOpt = itemSelect ? itemSelect.options[itemSelect.selectedIndex] : null;
        const itemName = (itemOpt?.dataset.name || itemOpt?.textContent || '').trim().toLowerCase();
        const size = row.querySelector('.prod-comp-size')?.value.trim().toLowerCase();

        if (sourceSel.value === 'POOL') {
          const entry = wip.find(w => w.outputItemName.toLowerCase() === itemName);
          availEl.innerText = entry ? `${this.formatQty(entry.availableQty)} avail. (Pool)` : '0 avail. (Pool)';
        } else {
          const entry = stock.find(s => s.name.toLowerCase() === itemName && (!size || (s.size || '').toLowerCase() === size));
          availEl.innerText = entry ? `${this.formatQty(entry.currentStock)} avail.` : '0 avail.';
        }
      });
    } catch (err) {
      // Ignored -- availability hints are advisory, not blocking.
    }
  },

  _readProdComponentRow(row) {
    const itemSelect = row.querySelector('.prod-comp-item-select');
    if (!itemSelect || itemSelect.value === '') return null;
    const itemOpt = itemSelect.options[itemSelect.selectedIndex];
    const itemName = (itemOpt.dataset.name || itemOpt.textContent || '').trim();
    if (!itemName) return null;

    return {
      itemName,
      size: row.querySelector('.prod-comp-size')?.value.trim() || '',
      color: row.querySelector('.prod-comp-color')?.value.trim() || '',
      sourceType: row.querySelector('.prod-comp-source')?.value === 'POOL' ? 'POOL' : 'ITEM',
      qty: toNumber(row.querySelector('.prod-comp-qty')?.value),
      colorGroup: row.dataset.colorScope || 'COMMON',
      unit: row.dataset.unit || ''
    };
  },

  serializeComponentsConsumed() {
    const components = [];
    document.querySelectorAll('#productionComponentsBody tr').forEach(row => {
      const comp = this._readProdComponentRow(row);
      if (comp) components.push(comp);
    });
    return components;
  },

  // Adaptation: reads c.contractorName, not source's c.name -- see this
  // file's module header / contractor.js's own header for the full story.
  initContractorSelect2(currentValue) {
    const selectEl = document.getElementById('productionAssignedTo');
    if (!selectEl || !window.jQuery?.fn?.select2) return;

    const $select = window.jQuery(selectEl);
    if ($select.data('select2')) $select.select2('destroy');
    selectEl.innerHTML = '';

    if (currentValue) selectEl.add(new Option(currentValue, currentValue, true, true));

    const $parentModal = $select.closest('.modal');

    $select.select2({
      placeholder: 'Search or type a contractor/staff name...',
      width: '100%',
      tags: true,
      allowClear: true,
      matcher: App.Utils.select2Matcher,
      dropdownParent: $parentModal.length ? $parentModal : window.jQuery(document.body),
      data: (App.State.globalContractors || []).map(c => ({ id: c.contractorName, text: c.contractorName })),
      createTag(params) {
        const term = (params.term || '').trim();
        if (!term) return null;
        const existing = (App.State.globalContractors || []).find(c => App.Utils.sameText(c.contractorName, term));
        if (existing) return { id: existing.contractorName, text: existing.contractorName };
        return { id: term, text: term, newTag: true };
      }
    });

    let handlingChange = false;
    $select.off('change.prodAssignedTo').on('change.prodAssignedTo', () => {
      if (handlingChange) return;
      handlingChange = true;
      Promise.resolve().then(() => { handlingChange = false; });
      this.refreshPayableHint();
    });
  },

  refreshPayableHint() {
    clearTimeout(this._payableHintDebounceTimer);
    this._payableHintDebounceTimer = setTimeout(() => this._refreshPayableHintNow(), 300);
  },

  async _refreshPayableHintNow() {
    const hintEl = document.getElementById('productionPayableHint');
    if (!hintEl) return;

    const contractorName = document.getElementById('productionAssignedTo')?.value;
    const processId = document.getElementById('productionProcessId')?.value;
    const qty = toNumber(document.getElementById('productionQty')?.value);
    const process = (App.State.globalProcesses || []).find(p => p.processId === processId);

    if (!contractorName || !process || !qty) {
      hintEl.innerText = '';
      return;
    }

    try {
      const res = await Api.call('getContractorRateForProcess', contractorName, process.processName);
      const rate = res.success ? toNumber(res.data?.ratePerUnit) : 0;
      if (!rate) {
        hintEl.innerText = `No rate card entry for "${contractorName}" / ${process.processName} — Payable will be 0.`;
        return;
      }
      hintEl.innerText = `Payable: ${formatCurrency(qty * rate)} (${qty} x ${rate}/unit)`;
    } catch (err) {
      hintEl.innerText = '';
    }
  },

  openIssueStockForLot() {
    App.Utils.notPortedYet('Issue Stock');
  },

  async resetCreateForm() {
    ++this._compLoadSeq;
    this.clearComponentsTable();
    this._setMultiColorNotice(false);

    const form = document.getElementById('productionForm');
    if (form) form.reset();

    await Promise.all([App.Process.ensureLoaded(), App.Contractor.ensureLoaded(), App.ProcessType.ensureLoaded(), App.Model.ensureLoaded()]);

    document.getElementById('productionRowIdx').value = '';
    document.getElementById('productionDate').value = todayIso();

    this.populateProductSelect();
    document.getElementById('productionProductTagWrapper').style.display = 'none';
    document.getElementById('productionProductIdHidden').value = '';
    document.getElementById('productionProductNameHidden').value = '';

    this.initContractorSelect2('');
    document.getElementById('productionPayableHint').innerText = '';

    this.populateSizeSelect();
    const sizeSelect = document.getElementById('productionSize');
    if (sizeSelect) {
      sizeSelect.value = '';
      if (window.jQuery?.fn?.select2 && window.jQuery(sizeSelect).data('select2')) window.jQuery(sizeSelect).trigger('change.select2');
      App.Utils.autoSelectOnlyOption(sizeSelect);
    }
    await this.handleSizeChange(sizeSelect ? sizeSelect.value : '');
    document.getElementById('productionLotNumber').value = '';

    document.getElementById('productionFormTitle').innerText = 'Log Production Lot';
    document.getElementById('productionSubmitBtn').innerText = 'Record Production Run';
  },

  async openCreateModal() {
    await this.resetCreateForm();

    const modalEl = document.getElementById('editProductionModal');
    if (modalEl && typeof bootstrap !== 'undefined') {
      const processSelect = document.getElementById('productionProcessId');
      if (processSelect) processSelect.disabled = false;
      bootstrap.Modal.getOrCreateInstance(modalEl).show();
    }
  },

  // Adaptation from source: a lot whose saved colorBreakdown is non-empty
  // needs the not-yet-ported Color Checklist/Matrix system to edit
  // correctly (source's own openEditModal reconstructs that whole UI
  // from the saved breakdown) -- guarded here with a toast instead of
  // opening a form that would silently drop that data on re-save.
  async openEditModal(idx) {
    const p = App.State.globalProduction[idx];
    if (!p) return;

    if (p.colorBreakdown && p.colorBreakdown.length > 0) {
      App.Utils.notPortedYet('Editing a multi-color Production Lot');
      return;
    }

    const seq = ++this._compLoadSeq;

    const form = document.getElementById('productionForm');
    if (form) form.reset();

    await Promise.all([App.Process.ensureLoaded(), App.Contractor.ensureLoaded(), App.ProcessType.ensureLoaded(), App.Model.ensureLoaded()]);

    document.getElementById('productionRowIdx').value = p.rowIdx;

    let inputDateStr = todayIso();
    if (p.date && p.date.includes('/')) {
      const [day, month, year] = p.date.split('/');
      inputDateStr = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    } else if (p.dateRaw) {
      inputDateStr = p.dateRaw.split('T')[0];
    }
    document.getElementById('productionDate').value = inputDateStr;

    document.getElementById('productionAssignedBy').value = p.assignedBy;
    this.initContractorSelect2(p.assignedTo);
    document.getElementById('productionStatus').value = p.status;
    document.getElementById('productionRemarks').value = p.remarks;

    const editProcess = (App.State.globalProcesses || []).find(pr => pr.processId === p.processId);
    const editSize = App.Utils.getSizeFromOutputItemName(editProcess ? editProcess.outputItemName : '');
    const editModel = App.Utils.getModelFromOutputItemName(editProcess ? editProcess.outputItemName : '');
    const editType = editProcess ? (editProcess.processType || 'General') : '';

    this._suppressCascade = true;
    try {
      this.populateSizeSelect();
      const sizeSelect = document.getElementById('productionSize');
      if (sizeSelect) {
        sizeSelect.value = editSize;
        sizeSelect.disabled = true;
        if (window.jQuery?.fn?.select2 && window.jQuery(sizeSelect).data('select2')) window.jQuery(sizeSelect).trigger('change.select2');
      }

      this.populateModelSelect(editSize);
      const modelSelect = document.getElementById('productionModel');
      if (modelSelect) {
        modelSelect.value = editModel;
        modelSelect.disabled = true;
        if (window.jQuery?.fn?.select2 && window.jQuery(modelSelect).data('select2')) window.jQuery(modelSelect).trigger('change.select2');
      }

      this.populateProcessTypeSelect(editSize, editModel);
      const typeSelect = document.getElementById('productionProcessType');
      if (typeSelect) {
        typeSelect.value = editType;
        typeSelect.disabled = true;
        if (window.jQuery?.fn?.select2 && window.jQuery(typeSelect).data('select2')) window.jQuery(typeSelect).trigger('change.select2');
      }

      this.populateProcessSelect(editSize, editType, editModel);
      const processSelect = document.getElementById('productionProcessId');
      if (processSelect) {
        processSelect.value = p.processId;
        processSelect.disabled = true;
      }
      this.initProcessSelect2();
    } finally {
      this._suppressCascade = false;
    }

    document.getElementById('productionLotNumber').value = p.lotNumber || '';

    this.populateProductSelect();
    document.getElementById('productionProductId').value = p.productId || '';
    document.getElementById('productionProductIdHidden').value = p.productId || '';
    document.getElementById('productionProductNameHidden').value = p.productName || '';

    document.getElementById('productionOutputItemName').value = editProcess ? (editProcess.outputItemName || '') : '';
    const tagWrapper = document.getElementById('productionProductTagWrapper');
    if (tagWrapper) tagWrapper.style.display = (p.productId || (editProcess && editProcess.isFinalStage)) ? '' : 'none';

    this._setMultiColorNotice(false);
    document.getElementById('productionQty').value = p.qty;
    if (p.componentsConsumed && p.componentsConsumed.length > 0) {
      this.clearComponentsTable();
      p.componentsConsumed.forEach(c => this.addComponentRow(c));
      await this.refreshPoolAvailability();
    } else {
      await this.populateComponentsFromProcess(p.processId, seq);
    }
    if (seq !== this._compLoadSeq) return;

    document.getElementById('productionFormTitle').innerText = `Edit Production Lot: Row #${p.rowIdx}`;
    document.getElementById('productionSubmitBtn').innerText = 'Update Production Lot';

    const modalEl = document.getElementById('editProductionModal');
    if (modalEl && typeof bootstrap !== 'undefined') {
      bootstrap.Modal.getOrCreateInstance(modalEl).show();
    }
  },

  viewProductionSheet() {
    App.Utils.notPortedYet('Production Sheet');
  }
};

// Wire up Production form submission -- mirrors source's own
// DOMContentLoaded-bound prodForm.onsubmit, adapted to this round's
// single-Qty-only scope (no colorBreakdown/color-matrix serialization;
// that lands with the Color Checklist round).
document.addEventListener('DOMContentLoaded', function () {
  const prodForm = document.getElementById('productionForm');
  if (!prodForm) return;

  prodForm.onsubmit = async function (e) {
    e.preventDefault();

    const processSelect = document.getElementById('productionProcessId');
    const processWasDisabled = processSelect?.disabled ?? false;
    if (processWasDisabled && processSelect) processSelect.disabled = false;

    const form = document.getElementById('productionForm');
    const formData = Object.fromEntries(new FormData(form));

    if (processWasDisabled && processSelect) processSelect.disabled = true;

    formData.componentsConsumed = JSON.stringify(App.Production.serializeComponentsConsumed());

    const submitBtn = document.getElementById('productionSubmitBtn');
    if (submitBtn) submitBtn.disabled = true;

    try {
      const response = await Api.mutate('saveProduction', formData);
      if (response.success) {
        const isNewLot = !document.getElementById('productionRowIdx')?.value;
        if (isNewLot) {
          const fieldset = document.getElementById('productionFormFieldset');
          if (fieldset) fieldset.disabled = true;
          try {
            await App.Production.resetCreateForm();
          } finally {
            if (fieldset) fieldset.disabled = false;
          }
          document.getElementById('productionSize')?.focus();
        } else {
          const modalEl = document.getElementById('editProductionModal');
          if (modalEl) bootstrap.Modal.getOrCreateInstance(modalEl).hide();
        }
        await App.Production.loadData();
      }
      App.Utils.showToast(response.message, !response.success);
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to save production log', true);
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  };
});
