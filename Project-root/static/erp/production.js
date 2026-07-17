'use strict';
// production.js -- App.Production, ported from Apps_Script/Script_Production.html.
//
// Round 11 scope (shipped): the Production Log list/report side --
// viewing, searching, sorting, inline status changes, delete, bulk
// print, the Colorwise Summary report, and the "All Activity" combined
// feed.
//
// Round 12 scope (shipped): the Create/Edit Lot modal shell -- cascading
// Size->Model->Process Type->Process dropdowns, the Components Consumed
// table, Assignment & Workflow -- plus full create/edit/save/delete for
// any lot whose Process has NO configured color sub-groups.
//
// Round 13 scope (this round): the multi-axis Color Checklist system --
// checking off which colors a lot produces, per-color quantities, axis
// grouping (a process with 2+ independent Color Axes, e.g. Frame color
// + Rim color), primary-axis selection, custom one-off colors, and
// "+ Add Colors to this Lot" for a process with no auto-detected groups
// at all. This unlocks real multi-color lot creation -- but ONLY for a
// process whose color-configured components don't ALSO need the Per-
// Color Component Matrix or Per-Process Warehouse Pool Color Group
// Matrix to represent correctly (see _processNeedsColorMatrix below).
// Reading the full Create/Edit modal source (Script_Production.html
// lines ~1013-3407, ~2400 lines) confirmed those two matrix systems are
// each independently complex (axis-scoped column sync, merged vs.
// manual rows, composite delimiter-joined pool colors) and are correctly
// deferred to their own round rather than guessed at here.
//
// The guard is computed from the SAME data
// (getProcessComponentsData + getPoolColorAwareItemNames) the real
// matrix-population functions below would use, so it's provably
// accurate: a process that passes the guard has ZERO components that
// would ever populate the Matrix or Pool Color Group tables, which is
// exactly why this round can safely include those tables' scaffolding
// (manual "+ Add Per-Color Component" row, serialization) without
// implementing their auto-population -- for a guard-passing process,
// auto-population is provably a no-op, ported faithfully or not.
// A process that fails the guard shows a dismissable notice and blocks
// Save, same pattern as Round 12. Editing an existing lot is guarded
// the same way: a saved colorBreakdown with any non-COMMON
// componentsConsumed row (i.e. it used the Matrix) is blocked; a
// colorBreakdown with only COMMON rows (created by this round, or a
// legacy lot that happens to have none) is fully editable.
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
// - Bug fix (verified empirically against the real saveProduction RPC,
//   not just read from source): source's enableManualColors calls
//   renderColorChecklistRows(colors) with no isCustom flag. Server-side,
//   saveProduction only honors a submitted colorBreakdown when the
//   process has configured color groups (enableManualColors exists
//   precisely for a process that has NONE) or has_custom_breakdown is
//   true -- with neither true, it silently fell back to reading the
//   plain qty field, which the submit handler had already deleted,
//   and always failed with "Production Quantity cannot be zero." Every
//   "Add Colors to this Lot" submission in the original app would have
//   hit this. Fixed here (and in openEditModal's matching restoration
//   path) by passing isCustom=true -- these rows genuinely are
//   process-undefined custom colors, exactly what that flag means.

App.Production = {
  STATUS_OPTIONS: ['Pending', 'In Progress', 'Completed', 'Cancelled'],

  // Shared with .prod-color-table CSS -- every place below that sets a
  // pool-color-group/matrix table's inline min-width uses these.
  PROD_COLOR_TABLE_FIXED_RESERVE_PX: 378,
  PROD_COLOR_TABLE_COLOR_COL_PX: 88,

  // Per-load cache for getProcessComponentsData/getWarehousePoolData,
  // reset every time _compLoadSeq is bumped -- collapses what would
  // otherwise be several redundant round trips per Process selection
  // into one fetch per sheet.
  _procDataCache: null,

  _resetProcDataCache() {
    this._procDataCache = { components: new Map(), pool: null };
  },

  _fetchProcessComponents(processId) {
    if (!this._procDataCache) this._resetProcDataCache();
    const key = processId || '';
    if (!this._procDataCache.components.has(key)) {
      this._procDataCache.components.set(key, Api.call('getProcessComponentsData', processId));
    }
    return this._procDataCache.components.get(key);
  },

  _fetchWarehousePoolData() {
    if (!this._procDataCache) this._resetProcDataCache();
    if (!this._procDataCache.pool) {
      this._procDataCache.pool = Api.call('getWarehousePoolData');
    }
    return this._procDataCache.pool;
  },

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
  // visibility, then branches into the multi-axis Color Checklist (see
  // populateColorChecklist) when this process has configured color
  // sub-groups, or the plain single-Qty Components table otherwise.
  async handleProcessChange(processId) {
    if (this._suppressCascade) return;
    const seq = ++this._compLoadSeq;
    this._resetProcDataCache();

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

    const colors = await this.populateColorChecklist(processId, seq);
    if (seq !== this._compLoadSeq) return;

    const addColorsBtn = document.getElementById('productionAddColorsBtn');
    const revertColorsBtn = document.getElementById('productionRevertColorsBtn');
    if (revertColorsBtn) revertColorsBtn.style.display = 'none';
    if (colors.length === 0) {
      await this.populateComponentsFromProcess(processId, '', seq);
      if (seq !== this._compLoadSeq) return;
      if (addColorsBtn) addColorsBtn.style.display = processId ? '' : 'none';
    } else {
      this.clearComponentsTable();
      this.clearColorMatrix();
      await this.populateCommonComponentsFromProcess(processId, seq);
      if (seq !== this._compLoadSeq) return;
      if (addColorsBtn) addColorsBtn.style.display = 'none';
    }
    this.refreshPayableHint();
  },

  // Detects whether a process's color-configured components need the
  // not-yet-ported Per-Color Component Matrix or Per-Process Warehouse
  // Pool Color Group Matrix to represent correctly -- see this file's
  // module header for why this is provably accurate rather than a guess:
  // it's computed from the exact same components + pool-color data
  // populateCommonComponentsFromProcess itself uses, so "needs nothing"
  // here really does mean nothing would ever populate those tables.
  //   - explicitColorComps: any component row explicitly tagged with a
  //     real colorGroup (not blank/COMMON) -- these are exactly what
  //     populateColorMatrixForColors routes into Matrix rows.
  //   - poolColorSplit: any COMMON, POOL-sourced component whose item
  //     currently has 2+ colors live in the Warehouse Pool -- exactly
  //     what renderPoolColorSplitGroups routes into its own tables.
  async _processNeedsColorMatrix(processId) {
    const [compRes, poolColorMap] = await Promise.all([
      this._fetchProcessComponents(processId),
      this.getPoolColorAwareItemNames(processId)
    ]);
    const all = compRes.success ? (compRes.data || []) : [];
    const explicitColorComps = all.filter(c => c.colorGroup && c.colorGroup !== 'COMMON');
    const commonComps = all.filter(c => !c.colorGroup || c.colorGroup === 'COMMON');
    const poolColorSplit = commonComps.filter(c =>
      c.sourceType === 'POOL' && (poolColorMap.get((c.itemName || '').trim().toLowerCase()) || []).length > 1
    );
    return explicitColorComps.length > 0 || poolColorSplit.length > 0;
  },

  // Shows/hides the "this process's color-specific components need the
  // not-yet-ported Matrix" notice and disables Save while it's up.
  _setMultiColorNotice(show) {
    const notice = document.getElementById('productionMultiColorNotice');
    if (notice) notice.style.display = show ? '' : 'none';
    const submitBtn = document.getElementById('productionSubmitBtn');
    if (submitBtn) submitBtn.disabled = show;
  },

  async populateComponentsFromProcess(processId, colorGroup, seq) {
    this.clearComponentsTable();
    if (!processId) return;

    try {
      const res = await this._fetchProcessComponents(processId);
      if (seq !== undefined && seq !== this._compLoadSeq) return;
      const all = res.success ? (res.data || []) : [];
      const components = all.filter(c => !c.colorGroup || c.colorGroup === 'COMMON' || App.Utils.sameText(c.colorGroup, colorGroup || ''));
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

  // ── Colors to Produce checklist ──────────────────────────────────────
  // Ported from Script_Production.html's own Color Checklist system.
  // Round 13 adaptation: when this process's color-specific components
  // need the Matrix (_processNeedsColorMatrix), the checklist still
  // renders (so the operator can see what's configured) but Save is
  // blocked via _setMultiColorNotice -- source has no such guard since
  // its Matrix system is fully implemented.

  // Populates the interactive Colors-to-Produce checklist with this
  // process's configured color sub-groups. Shows the checklist + Per-
  // Color matrix (hiding the single Qty field) only when at least one
  // color exists. Returns the list of colors.
  async populateColorChecklist(processId, seq) {
    const wrapper = document.getElementById('productionColorWrapper');
    const checklistEl = document.getElementById('productionColorChecklist');
    const qtyWrapper = document.getElementById('productionQtyWrapper');
    const qtyInput = document.getElementById('productionQty');
    const sectionLabel = document.getElementById('productionComponentsSectionLabel');
    if (!wrapper || !checklistEl) return [];

    checklistEl.innerHTML = '';
    this._customColorGroupOptions = [];
    this._setMultiColorNotice(false);

    let colors = [];
    if (processId) {
      try {
        const res = await Api.call('getProcessColorGroups', processId);
        colors = res.success ? (res.data || []) : [];
      } catch (err) {
        colors = [];
      }
    }
    if (seq !== undefined && seq !== this._compLoadSeq) return colors;

    if (colors.length === 0) {
      wrapper.style.display = 'none';
      if (qtyWrapper) qtyWrapper.style.display = '';
      if (qtyInput) qtyInput.required = true;
      if (sectionLabel) sectionLabel.innerText = 'Components Consumed';
      this.hideColorMatrix();
      this._refreshCustomColorGroupSelect();
      return [];
    }

    const needsMatrix = await this._processNeedsColorMatrix(processId);
    if (seq !== undefined && seq !== this._compLoadSeq) return colors;
    this._setMultiColorNotice(needsMatrix);

    if (qtyWrapper) qtyWrapper.style.display = 'none';
    if (qtyInput) { qtyInput.required = false; qtyInput.value = ''; }
    wrapper.style.display = '';
    if (sectionLabel) sectionLabel.innerText = 'Common Components';
    this.showColorMatrix();

    await this.renderGroupedColorChecklist(processId, colors, seq);
    if (seq === undefined || seq === this._compLoadSeq) this._refreshCustomColorGroupSelect();

    return colors;
  },

  _refreshCustomColorGroupSelect() {
    const sel = document.getElementById('productionCustomColorGroupSelect');
    if (!sel) return;
    const options = this._customColorGroupOptions || [];
    if (options.length < 2) {
      sel.style.display = 'none';
      sel.innerHTML = '';
      return;
    }
    sel.style.display = '';
    sel.innerHTML = '<option value="">Independent extra color (adds to lot total)</option>'
      + options.map(o => `<option value="${escapeHtml(o.key)}">${escapeHtml(o.label)}${o.isPrimary ? ' (Primary)' : ''}</option>`).join('');
  },

  _colorRowHtml(color, groupKey, isCustom, isPrimary) {
    const groupAttr = groupKey ? ` data-group="${escapeHtml(groupKey)}"` : '';
    const customAttr = isCustom ? ' data-custom="true"' : '';
    const primaryAttr = isPrimary === undefined ? '' : ` data-primary="${isPrimary ? 'true' : 'false'}"`;
    return `
      <div class="form-check d-flex align-items-center gap-2 production-color-row" data-color="${escapeHtml(color)}"${groupAttr}${customAttr}${primaryAttr}>
        <input class="form-check-input production-color-check" type="checkbox" onchange="App.Production.handleColorCheckToggle(this)">
        <label class="form-check-label fw-bold mb-0">${escapeHtml(color)}</label>
        <input type="number" class="form-control form-control-sm production-color-qty" style="width:100px;" step="any" placeholder="Qty" disabled oninput="App.Production.onColorQtyChanged(this.closest('.production-color-row'))">
      </div>`;
  },

  renderColorChecklistRows(colors, groupKey, isCustom, isPrimary) {
    const checklistEl = document.getElementById('productionColorChecklist');
    if (!checklistEl) return;
    colors.forEach(color => {
      checklistEl.insertAdjacentHTML('beforeend', this._colorRowHtml(color, groupKey, isCustom, isPrimary));
    });
  },

  _primaryColorAxisTotal() {
    return $$('#productionColorChecklist .production-color-row[data-primary="true"]')
      .filter(row => row.querySelector('.production-color-check')?.checked)
      .reduce((sum, row) => sum + (toNumber(row.querySelector('.production-color-qty')?.value) || 0), 0);
  },

  _colorNamesMatch(a, b) {
    const x = String(a || '').trim().toLowerCase();
    const y = String(b || '').trim().toLowerCase();
    if (!x || !y) return false;
    if (x === y) return true;
    const shorter = x.length <= y.length ? x : y;
    const longer = x.length <= y.length ? y : x;
    const escaped = shorter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[-/\\s])${escaped}($|[-/\\s])`).test(longer);
  },

  _matchingPrimaryColorQty(nonPrimaryColor) {
    const target = String(nonPrimaryColor || '').trim();
    if (!target) return null;
    const primaryRows = $$('#productionColorChecklist .production-color-row[data-primary="true"]')
      .filter(row => row.querySelector('.production-color-check')?.checked);
    for (const row of primaryRows) {
      if (this._colorNamesMatch(row.dataset.color, target)) {
        return toNumber(row.querySelector('.production-color-qty')?.value) || 0;
      }
    }
    return null;
  },

  // Lets the operator tack on a one-off custom-named color/sub-group at
  // production-record time. Auto-checked so the operator only has to
  // fill in its quantity. When this process has 2+ real groups, the
  // operator must also say which one it belongs to.
  addCustomColorRow() {
    const input = document.getElementById('productionCustomColorInput');
    const name = (input?.value || '').trim();
    if (!name) return;

    const checklistEl = document.getElementById('productionColorChecklist');
    if (!checklistEl) return;

    const exists = $$('#productionColorChecklist .production-color-row')
      .some(row => (row.dataset.color || '').toLowerCase() === name.toLowerCase());
    if (exists) {
      App.Utils.showToast(`"${name}" is already in this lot's checklist.`, true);
      return;
    }

    const groupSelect = document.getElementById('productionCustomColorGroupSelect');
    const selectedKey = (groupSelect && groupSelect.style.display !== 'none') ? groupSelect.value : '';
    let targetGroup = selectedKey ? (this._customColorGroupOptions || []).find(o => o.key === selectedKey) : null;

    if (!targetGroup && (this._customColorGroupOptions || []).length === 1) {
      targetGroup = this._customColorGroupOptions[0];
    }

    let groupKey;
    if (targetGroup) {
      groupKey = targetGroup.key;
      const groupRows = $$('#productionColorChecklist .production-color-row')
        .filter(r => r.dataset.group === groupKey);
      const anchor = groupRows[groupRows.length - 1];
      const html = this._colorRowHtml(name, groupKey, true, targetGroup.isPrimary);
      if (anchor) anchor.insertAdjacentHTML('afterend', html);
      else checklistEl.insertAdjacentHTML('beforeend', html);
    } else {
      groupKey = 'custom';
      if (!checklistEl.querySelector('[data-group-master="custom"]')) {
        checklistEl.insertAdjacentHTML('beforeend', this._buildColorGroupHeader('custom', 'Custom'));
      }
      this.renderColorChecklistRows([name], 'custom', true);
    }
    if (input) input.value = '';
    if (groupSelect) groupSelect.value = '';

    const row = $$('#productionColorChecklist .production-color-row')
      .find(r => r.dataset.group === groupKey && r.dataset.color === name);
    const checkbox = row?.querySelector('.production-color-check');
    if (checkbox) {
      checkbox.checked = true;
      this.handleColorCheckToggle(checkbox);
    }
    this._syncColorGroupMasterCheckbox(groupKey);
  },

  // Fired by a group's "Select all" checkbox -- checks/unchecks every
  // not-already-matching color row tagged with this groupKey.
  async toggleColorGroup(checkboxEl, groupKey) {
    const seq = this._compLoadSeq;
    const checked = checkboxEl.checked;
    const rows = $$('#productionColorChecklist .production-color-row').filter(row => row.dataset.group === groupKey);
    const toggledColors = [];
    const toggledPrimaryColors = [];

    rows.forEach(row => {
      const chk = row.querySelector('.production-color-check');
      if (!chk || chk.checked === checked) return;
      chk.checked = checked;
      const qtyInput = row.querySelector('.production-color-qty');
      if (qtyInput) {
        qtyInput.disabled = !checked;
        if (!checked) {
          qtyInput.value = '';
          delete row.dataset.autoSynced;
        } else if (row.dataset.primary === 'false') {
          const matched = this._matchingPrimaryColorQty(row.dataset.color);
          const fillQty = matched !== null ? matched : this._primaryColorAxisTotal();
          if (fillQty > 0) qtyInput.value = this.formatQty(fillQty);
          row.dataset.autoSynced = 'true';
        }
      }
      toggledColors.push(row.dataset.color);
      if (row.dataset.primary === 'true') toggledPrimaryColors.push(row.dataset.color);
    });

    if (toggledColors.length === 0) return;

    const processId = document.getElementById('productionProcessId')?.value;
    if (checked) {
      toggledColors.forEach(color => this.addMatrixColorColumn(color));
      this.syncPoolColorGroupColumns();
      if (processId) await this.populateColorMatrixForColors(processId, toggledColors, seq, groupKey);
    } else {
      toggledColors.forEach(color => {
        this.removeMatrixColorColumn(color);
        this.refreshPoolColorGroupCells(color, 0, groupKey);
      });
      this.syncPoolColorGroupColumns();
    }

    this.refreshCommonSuggestedQty();
    this.refreshPayableHint();
    checkboxEl.indeterminate = false;

    for (const primaryColor of toggledPrimaryColors) {
      await this._syncMatchingNonPrimaryRows(primaryColor, checked);
    }
    if (toggledPrimaryColors.length > 0) this._refreshAutoSyncedFallbackRows();

    await this.refreshPoolAvailability();
  },

  // Splits the Colors to Produce checklist into sub-groups: one per Color
  // Axis when this process has 2+ (see getProcessColorAxes), else one per
  // multi-color pool item set, with any leftover in a final "Other" block.
  async renderGroupedColorChecklist(processId, colors, seq) {
    const checklistEl = document.getElementById('productionColorChecklist');
    if (!checklistEl) return;

    try {
      const axesRes = await Api.call('getProcessColorAxes', processId);
      if (seq !== undefined && seq !== this._compLoadSeq) return;
      const axes = (axesRes.success && axesRes.data && Array.isArray(axesRes.data.axes)) ? axesRes.data.axes : [];
      if (axes.length >= 2) {
        checklistEl.innerHTML = '';
        const primaryAxisKey = axesRes.data.primaryAxisKey || '';
        axes.forEach(axis => {
          const isPrimary = !!primaryAxisKey && axis.key === primaryAxisKey;
          checklistEl.insertAdjacentHTML('beforeend', this._buildColorAxisGroupHeader(axis, isPrimary));
          this.renderColorChecklistRows(axis.colors, axis.key, false, isPrimary);
          this._customColorGroupOptions.push({ key: axis.key, label: axis.label, isPrimary, source: axis.source });
        });
        if (!primaryAxisKey) {
          checklistEl.insertAdjacentHTML('afterbegin',
            '<div class="alert alert-warning py-1 px-2 small mb-2" style="flex: 1 0 100%;" id="productionPrimaryAxisWarning">' +
            'Pick which group below is <b>Primary</b> — its checked quantities become this lot\'s total. The others are recorded per-color but won\'t add to it.</div>');
        }
        return;
      }
    } catch (err) {
      if (seq !== undefined && seq !== this._compLoadSeq) return;
    }

    let comps = [];
    let poolColorMap = new Map();
    try {
      const [compRes, pcm] = await Promise.all([
        this._fetchProcessComponents(processId),
        this.getPoolColorAwareItemNames(processId)
      ]);
      if (seq !== undefined && seq !== this._compLoadSeq) return;
      comps = compRes.success ? (compRes.data || []) : [];
      poolColorMap = pcm;
    } catch (err) {
      if (seq !== undefined && seq !== this._compLoadSeq) return;
      checklistEl.innerHTML = '';
      this.renderColorChecklistRows(colors);
      return;
    }

    checklistEl.innerHTML = '';

    const multiColorItems = comps.filter(c => c.sourceType === 'POOL' && (!c.colorGroup || c.colorGroup === 'COMMON')
      && (poolColorMap.get((c.itemName || '').trim().toLowerCase()) || []).length > 1);

    const groups = new Map();
    multiColorItems.forEach(c => {
      const itemColors = poolColorMap.get((c.itemName || '').trim().toLowerCase()) || [];
      const signature = itemColors.slice().sort((a, b) => a.localeCompare(b)).join('|').toLowerCase();
      if (!groups.has(signature)) groups.set(signature, { colorSet: new Set(itemColors.map(x => x.toLowerCase())), itemNames: [] });
      groups.get(signature).itemNames.push(c.itemName);
    });

    if (groups.size === 0) {
      this.renderColorChecklistRows(colors);
      return;
    }

    const usedColors = new Set();
    let groupIdx = 0;
    groups.forEach(({ colorSet, itemNames }) => {
      const matching = colors.filter(col => colorSet.has(col.toLowerCase()) && !usedColors.has(col.toLowerCase()));
      if (matching.length === 0) return;
      matching.forEach(c => usedColors.add(c.toLowerCase()));
      groupIdx++;
      const groupKey = `group_${groupIdx}`;
      checklistEl.insertAdjacentHTML('beforeend', this._buildColorGroupHeader(groupKey, itemNames.join(', ')));
      this.renderColorChecklistRows(matching, groupKey, false, true);
      this._customColorGroupOptions.push({ key: groupKey, label: itemNames.join(', '), isPrimary: true, source: 'pool' });
    });

    const remaining = colors.filter(c => !usedColors.has(c.toLowerCase()));
    if (remaining.length > 0) {
      checklistEl.insertAdjacentHTML('beforeend', this._buildColorGroupHeader('other', 'Other'));
      this.renderColorChecklistRows(remaining, 'other', false, false);
    }
  },

  _buildColorGroupHeader(groupKey, label) {
    return `
      <div class="d-flex align-items-center gap-2 mt-2 mb-1" style="flex: 1 0 100%;">
        <input type="checkbox" class="form-check-input" data-group-master="${escapeHtml(groupKey)}" onchange="App.Production.toggleColorGroup(this, '${escapeHtml(groupKey)}')" title="Select all colors in this group">
        <span class="text-muted small fw-bold">${escapeHtml(label)}</span>
      </div>`;
  },

  _buildColorAxisGroupHeader(axis, isPrimary) {
    return `
      <div class="d-flex align-items-center gap-2 mt-2 mb-1" style="flex: 1 0 100%;">
        <input type="checkbox" class="form-check-input" data-group-master="${escapeHtml(axis.key)}" onchange="App.Production.toggleColorGroup(this, '${escapeHtml(axis.key)}')" title="Select all colors in this group">
        <span class="text-muted small fw-bold axis-group-label" data-axis-label="${escapeHtml(axis.label)}">${escapeHtml(axis.label)}${isPrimary ? ' (Primary)' : ''}</span>
        <label class="form-check form-check-inline mb-0 ms-2 small text-muted" title="This group's checked quantities become the lot's total output quantity">
          <input type="radio" class="form-check-input" name="productionPrimaryAxisPick" value="${escapeHtml(axis.key)}" data-axis-label="${escapeHtml(axis.label)}"
            ${isPrimary ? 'checked' : ''} onchange="App.Production.setPrimaryColorAxisChoice(this)">
          Primary
        </label>
      </div>`;
  },

  setPrimaryColorAxisChoice(radioEl) {
    const axisKey = radioEl.value;
    $$('#productionColorChecklist .production-color-row[data-group]').forEach(row => {
      row.dataset.primary = row.dataset.group === axisKey ? 'true' : 'false';
    });
    document.querySelectorAll('#productionColorChecklist .axis-group-label').forEach(labelEl => {
      const ownRadio = labelEl.closest('div')?.querySelector('input[name="productionPrimaryAxisPick"]');
      const label = labelEl.dataset.axisLabel || labelEl.textContent;
      labelEl.textContent = label + (ownRadio?.checked ? ' (Primary)' : '');
    });
    const warning = document.getElementById('productionPrimaryAxisWarning');
    if (warning) warning.remove();
    this.refreshCommonSuggestedQty();
    this.refreshPayableHint();
  },

  _syncColorGroupMasterCheckbox(groupKey) {
    if (!groupKey) return;
    const master = $$('#productionColorChecklist [data-group-master]').find(el => el.dataset.groupMaster === groupKey);
    if (!master) return;
    const rows = $$('#productionColorChecklist .production-color-row').filter(row => row.dataset.group === groupKey);
    const checkedCount = rows.filter(row => row.querySelector('.production-color-check')?.checked).length;
    master.checked = rows.length > 0 && checkedCount === rows.length;
    master.indeterminate = checkedCount > 0 && checkedCount < rows.length;
  },

  // Lets the operator manually switch a process with no auto-detected
  // color sub-groups over to the multi-color checklist for just this one
  // lot, using the full Color Master list.
  async enableManualColors() {
    const processId = document.getElementById('productionProcessId').value;
    if (!processId) return;
    const seq = ++this._compLoadSeq;
    this._resetProcDataCache();

    await App.Color.ensureLoaded();
    const colors = (App.State.globalColors || []).map(c => c.name).filter(Boolean);
    if (colors.length === 0) {
      App.Utils.showToast('No colors configured yet — add one via Manage Color Master first.', true);
      return;
    }

    const wrapper = document.getElementById('productionColorWrapper');
    const checklistEl = document.getElementById('productionColorChecklist');
    const qtyWrapper = document.getElementById('productionQtyWrapper');
    const qtyInput = document.getElementById('productionQty');
    const sectionLabel = document.getElementById('productionComponentsSectionLabel');
    if (!wrapper || !checklistEl) return;

    checklistEl.innerHTML = '';
    // Adaptation from source (a confirmed bug, verified empirically
    // against the real saveProduction RPC): source's own
    // enableManualColors calls renderColorChecklistRows(colors) with no
    // isCustom flag, so a lot logged this way would submit a
    // colorBreakdown with every entry's isCustom false. Server-side,
    // saveProduction only honors colorBreakdown when this process has
    // configured color groups (it has none here -- that's the whole
    // point of "Add Colors to this Lot") OR has_custom_breakdown is true
    // -- with neither true, it fell back to reading the (by then
    // deleted) plain qty field and always failed with "Production
    // Quantity cannot be zero." Passing isCustom=true here is the fix:
    // every one of these rows genuinely IS a custom, not-process-defined
    // color choice, exactly what the isCustom flag exists to mark.
    this.renderColorChecklistRows(colors, undefined, true);

    if (qtyWrapper) qtyWrapper.style.display = 'none';
    if (qtyInput) { qtyInput.required = false; qtyInput.value = ''; }
    wrapper.style.display = '';
    if (sectionLabel) sectionLabel.innerText = 'Common Components';
    this.showColorMatrix();
    this._setMultiColorNotice(false);

    this.clearComponentsTable();
    this.clearColorMatrix();
    await this.populateCommonComponentsFromProcess(processId, seq);
    if (seq !== this._compLoadSeq) return;

    const addBtn = document.getElementById('productionAddColorsBtn');
    if (addBtn) addBtn.style.display = 'none';
    const revertBtn = document.getElementById('productionRevertColorsBtn');
    if (revertBtn) revertBtn.style.display = '';
  },

  // Undoes enableManualColors() for this lot, restoring the plain Qty
  // field and that process's default (non-color-scoped) recipe.
  async revertToSingleQty() {
    const processId = document.getElementById('productionProcessId').value;
    const seq = ++this._compLoadSeq;
    this._resetProcDataCache();

    const wrapper = document.getElementById('productionColorWrapper');
    const checklistEl = document.getElementById('productionColorChecklist');
    if (checklistEl) checklistEl.innerHTML = '';
    if (wrapper) wrapper.style.display = 'none';
    this.hideColorMatrix();
    this._setMultiColorNotice(false);

    const qtyWrapper = document.getElementById('productionQtyWrapper');
    const qtyInput = document.getElementById('productionQty');
    if (qtyWrapper) qtyWrapper.style.display = '';
    if (qtyInput) qtyInput.required = true;

    const sectionLabel = document.getElementById('productionComponentsSectionLabel');
    if (sectionLabel) sectionLabel.innerText = 'Components Consumed';

    await this.populateComponentsFromProcess(processId, '', seq);
    if (seq !== this._compLoadSeq) return;

    const addBtn = document.getElementById('productionAddColorsBtn');
    if (addBtn) addBtn.style.display = processId ? '' : 'none';
    const revertBtn = document.getElementById('productionRevertColorsBtn');
    if (revertBtn) revertBtn.style.display = 'none';
  },

  async handleColorCheckToggle(checkboxEl, refreshAvailability = true) {
    const seq = this._compLoadSeq;
    const row = checkboxEl.closest('.production-color-row');
    const color = row?.dataset.color;
    const qtyInput = row?.querySelector('.production-color-qty');
    if (qtyInput) {
      qtyInput.disabled = !checkboxEl.checked;
      if (!checkboxEl.checked) {
        qtyInput.value = '';
        if (row) delete row.dataset.autoSynced;
      } else if (row?.dataset.primary === 'false') {
        const matched = this._matchingPrimaryColorQty(row.dataset.color);
        const fillQty = matched !== null ? matched : this._primaryColorAxisTotal();
        if (fillQty > 0) qtyInput.value = this.formatQty(fillQty);
        row.dataset.autoSynced = 'true';
      }
    }
    this._syncColorGroupMasterCheckbox(row?.dataset.group);
    if (!color) return;

    const processId = document.getElementById('productionProcessId')?.value;
    if (checkboxEl.checked) {
      this.addMatrixColorColumn(color);
      if (processId) await this.populateColorMatrixForColors(processId, [color], seq, row?.dataset.group);
    } else {
      this.removeMatrixColorColumn(color);
      this.refreshPoolColorGroupCells(color, 0, row?.dataset.group);
    }
    this.syncPoolColorGroupColumns();
    this.refreshCommonSuggestedQty();
    this.refreshPayableHint();

    if (row?.dataset.primary === 'true') {
      await this._syncMatchingNonPrimaryRows(color, checkboxEl.checked);
      this._refreshAutoSyncedFallbackRows();
    }

    if (refreshAvailability) await this.refreshPoolAvailability();
  },

  _refreshAutoSyncedFallbackRows() {
    const total = this._primaryColorAxisTotal();
    $$('#productionColorChecklist .production-color-row[data-primary="false"]')
      .filter(r => r.dataset.autoSynced === 'true' && r.querySelector('.production-color-check')?.checked)
      .forEach(r => {
        if (this._matchingPrimaryColorQty(r.dataset.color) !== null) return;
        const qi = r.querySelector('.production-color-qty');
        if (qi) qi.value = total > 0 ? this.formatQty(total) : '';
      });
  },

  async _syncMatchingNonPrimaryRows(primaryColor, checked) {
    const target = String(primaryColor || '').trim();
    if (!target) return;
    const matches = $$('#productionColorChecklist .production-color-row[data-primary="false"]')
      .filter(row => this._colorNamesMatch(row.dataset.color, target));

    for (const row of matches) {
      const chk = row.querySelector('.production-color-check');
      if (!chk || chk.checked === checked) continue;
      chk.checked = checked;
      if (checked) row.dataset.autoSynced = 'true'; else delete row.dataset.autoSynced;
      await this.handleColorCheckToggle(chk, false);
    }
  },

  onColorQtyChanged(row, isUserEdit = true) {
    this.refreshCommonSuggestedQty();
    this.refreshPayableHint();
    if (!row) return;
    const color = row.dataset.color;

    if (isUserEdit && row.dataset.primary === 'false') {
      delete row.dataset.autoSynced;
    }

    const qty = toNumber(row.querySelector('.production-color-qty')?.value) || 0;
    this.syncPoolColorGroupColumns();
    this.refreshPoolColorGroupCells(color, qty, row.dataset.group);

    const colIndex = this.getMatrixColumnIndex(color);
    if (colIndex !== -1 && !this._isColorCheckedUnderMultipleAxes(color)) {
      document.querySelectorAll('#productionColorMatrixBody tr').forEach(matrixRow => {
        const cell = matrixRow.children[colIndex];
        const input = cell?.querySelector('.matrix-qty');
        const qtyPerUnit = input?.dataset.qtyPerUnit;
        if (input && qtyPerUnit !== undefined && qtyPerUnit !== '') {
          input.value = this.formatQty(qty * toNumber(qtyPerUnit));
        }
      });
    }

    if (row.dataset.primary === 'true') {
      $$('#productionColorChecklist .production-color-row[data-primary="false"]')
        .filter(r => r.dataset.autoSynced === 'true' && r.querySelector('.production-color-check')?.checked)
        .forEach(r => {
          const matched = this._matchingPrimaryColorQty(r.dataset.color);
          const fillQty = matched !== null ? matched : this._primaryColorAxisTotal();
          const qi = r.querySelector('.production-color-qty');
          if (qi) qi.value = fillQty > 0 ? this.formatQty(fillQty) : '';
          this.onColorQtyChanged(r, false);
        });
    }
  },

  // { color, qty, isCustom, countsTowardTotal, axisKey } for every
  // checked color with a numeric quantity entered.
  getCheckedColorQtys() {
    return $$('#productionColorChecklist .production-color-row')
      .filter(row => row.querySelector('.production-color-check')?.checked)
      .map(row => {
        const isNonPrimary = row.dataset.primary === 'false';
        const isUnmatchedOther = isNonPrimary && row.dataset.group === 'other'
          && this._matchingPrimaryColorQty(row.dataset.color) === null;
        return {
          color: row.dataset.color,
          qty: toNumber(row.querySelector('.production-color-qty')?.value) || 0,
          isCustom: row.dataset.custom === 'true',
          countsTowardTotal: !isNonPrimary || isUnmatchedOther,
          axisKey: row.dataset.group || ''
        };
      });
  },

  _currentLotTotalQty() {
    return this.getCheckedColorQtys()
      .filter(c => c.countsTowardTotal)
      .reduce((sum, c) => sum + c.qty, 0);
  },

  // Map<itemNameLower, string[]> of live Warehouse Pool colors for every
  // COMMON POOL-sourced recipe component of this process.
  async getPoolColorAwareItemNames(processId) {
    try {
      const [compRes, poolRes] = await Promise.all([
        this._fetchProcessComponents(processId),
        this._fetchWarehousePoolData()
      ]);
      const comps = compRes.success ? (compRes.data || []) : [];
      const poolRows = poolRes.success ? (poolRes.data || []) : [];

      const commonPoolItems = new Set(
        comps
          .filter(c => c.sourceType === 'POOL' && (!c.colorGroup || c.colorGroup === 'COMMON'))
          .map(c => (c.itemName || '').trim().toLowerCase())
      );

      const colorSets = new Map();
      poolRows.forEach(r => {
        const key = (r.outputItemName || '').trim().toLowerCase();
        if (!r.color || !commonPoolItems.has(key)) return;
        if (!colorSets.has(key)) colorSets.set(key, new Set());
        colorSets.get(key).add(r.color);
      });

      const result = new Map();
      colorSets.forEach((set, key) => result.set(key, Array.from(set).sort()));
      return result;
    } catch (err) {
      return new Map();
    }
  },

  // Populates the COMMON rows of the recipe into the Common Components
  // table, suggested at qtyPerUnit x total quantity across every checked
  // color. See _processNeedsColorMatrix: a component that would need the
  // Matrix or Pool Color Split table never reaches this path in Round 13
  // (the guard blocks Save before this function's own routing logic --
  // ported faithfully below -- would ever need to actually split
  // anything off into those still-scaffolded-only tables).
  async populateCommonComponentsFromProcess(processId, seq) {
    this.clearComponentsTable();
    if (!processId) return;

    try {
      const [res, poolColorMap] = await Promise.all([
        this._fetchProcessComponents(processId),
        this.getPoolColorAwareItemNames(processId)
      ]);
      if (seq !== undefined && seq !== this._compLoadSeq) return;
      const all = res.success ? (res.data || []) : [];
      const commonComps = all.filter(c => !c.colorGroup || c.colorGroup === 'COMMON');
      const totalQty = this._currentLotTotalQty();

      const poolColorsFor = c => poolColorMap.get((c.itemName || '').trim().toLowerCase()) || [];
      const isMultiColorPoolAware = c => c.sourceType === 'POOL' && poolColorsFor(c).length > 1;
      const colorOverrideComps = this._getCommonItemsWithColorOverride(all);
      const trueCommon = commonComps.filter(c => !isMultiColorPoolAware(c) && !colorOverrideComps.includes(c));
      const poolColorSplit = commonComps.filter(isMultiColorPoolAware);

      trueCommon.forEach(c => {
        const poolColors = poolColorsFor(c);
        const singleColor = c.sourceType === 'POOL' && poolColors.length === 1 ? poolColors[0] : '';
        this.addComponentRow({
          itemName: c.itemName,
          size: c.size,
          sourceType: c.sourceType,
          color: singleColor,
          colorScope: singleColor || undefined,
          qty: totalQty > 0 ? totalQty * c.qtyPerUnit : c.qtyPerUnit,
          qtyPerUnit: c.qtyPerUnit,
          unit: c.unit
        });
      });

      this.renderPoolColorSplitGroups(poolColorSplit, poolColorMap);

      await this.refreshPoolAvailability();
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to load process recipe', true);
    }
  },

  // A Common-tagged (ITEM-sourced) component "collides" with an explicit
  // per-color sibling when its own name matches that sibling's name once
  // the sibling's own color word is stripped -- e.g. "Chain Cover"
  // (Common) and "Chain Cover Green" (colorGroup Green). Pool-sourced
  // items are excluded -- they have their own multi-color handling.
  _getCommonItemsWithColorOverride(components) {
    const overrideKeys = new Set((components || [])
      .filter(c => c.colorGroup && c.colorGroup !== 'COMMON' && c.sourceType !== 'POOL')
      .map(c => this._itemSlotKey(this._stripColorSubstring(c.itemName || '', c.colorGroup), c.size))
    );
    return (components || []).filter(c =>
      (!c.colorGroup || c.colorGroup === 'COMMON') &&
      c.sourceType !== 'POOL' &&
      overrideKeys.has(this._itemSlotKey(c.itemName, c.size))
    );
  },

  _stripColorSubstring(itemName, color) {
    if (!color || !itemName) return itemName;
    const lowerName = itemName.toLowerCase();
    const candidates = [color, ...color.split(/[\s\-_]+/)].filter(Boolean);

    for (const candidate of candidates) {
      const idx = lowerName.indexOf(candidate.toLowerCase());
      if (idx === -1) continue;
      const stripped = (itemName.slice(0, idx) + itemName.slice(idx + candidate.length))
        .replace(/[\s\-_]+/g, ' ')
        .trim();
      return stripped || itemName;
    }
    return itemName;
  },

  _itemSlotKey(name, size) {
    return `${(name || '').trim().toLowerCase()}|${(size || '').trim().toLowerCase()}`;
  },

  // Renders one small table per distinct pool-color signature among
  // pool-color-aware components. See _processNeedsColorMatrix's module
  // header comment: `poolColorSplit` is always empty for any process
  // that passes Round 13's guard, so this always safely no-ops (hides
  // the wrapper) in every reachable Round 13 flow -- ported faithfully
  // (not stubbed) since it costs nothing extra and matches source
  // exactly for the day this guard lifts.
  renderPoolColorSplitGroups(poolColorSplit, poolColorMap) {
    const wrapper = document.getElementById('productionPoolColorGroupsWrapper');
    const container = document.getElementById('productionPoolColorGroupsContainer');
    if (!container) return;

    container.querySelectorAll('tr').forEach(row => this.destroyComponentItemSelect2(row));
    container.innerHTML = '';
    this._poolColorGroupDefs = [];

    if (!poolColorSplit || poolColorSplit.length === 0) {
      if (wrapper) wrapper.style.display = 'none';
      return;
    }
    if (wrapper) wrapper.style.display = '';

    const groups = new Map();
    poolColorSplit.forEach(c => {
      const colors = poolColorMap.get((c.itemName || '').trim().toLowerCase()) || [];
      const signature = colors.slice().sort((a, b) => a.localeCompare(b)).join('|').toLowerCase();
      if (!groups.has(signature)) groups.set(signature, { colors, comps: [] });
      groups.get(signature).comps.push(c);
    });

    let groupIdx = 0;
    groups.forEach(({ colors, comps }) => {
      groupIdx++;
      const tableId = `productionPoolColorGroup_${groupIdx}`;
      const axisKey = this._axisKeyForPoolItemNames(comps.map(c => c.itemName));
      this._poolColorGroupDefs.push({ tableId, colors, rows: comps, mode: 'create', axisKey });
      const visibleColors = this._checkedPoolGroupColors(colors, axisKey);
      container.insertAdjacentHTML('beforeend', this._buildPoolColorGroupTable(tableId, colors, visibleColors, comps, 'create', axisKey));
      document.querySelectorAll(`#${tableId} tbody tr`).forEach(row => this.initComponentItemSelect2(row));
    });
  },

  _axisKeyForPoolItemNames(itemNames) {
    const namesLower = (itemNames || []).map(n => String(n || '').trim().toLowerCase()).filter(Boolean);
    if (namesLower.length === 0) return '';
    const opt = (this._customColorGroupOptions || []).find(o => o.source === 'pool' &&
      o.label.split(',').map(s => s.trim().toLowerCase()).some(l => namesLower.includes(l)));
    return opt ? opt.key : '';
  },

  _axisScopedCheckedColorQtys(axisKey) {
    const all = this.getCheckedColorQtys();
    return axisKey ? all.filter(cc => cc.axisKey === axisKey) : all;
  },

  _checkedColorTokensLower(axisKey) {
    const tokens = new Set();
    this._axisScopedCheckedColorQtys(axisKey).filter(cc => cc.qty > 0).forEach(cc => {
      (cc.color || '').split(' / ').forEach(t => {
        const trimmed = t.trim().toLowerCase();
        if (trimmed) tokens.add(trimmed);
      });
    });
    return tokens;
  },

  _checkedPoolGroupColors(colors, axisKey) {
    const tokensLower = this._checkedColorTokensLower(axisKey);
    return colors.filter(c => tokensLower.has(c.toLowerCase()));
  },

  _poolGroupCellValue(mode, row, color, axisKey) {
    if (mode === 'edit') {
      return row.colorsQty ? row.colorsQty[color.toLowerCase()] : undefined;
    }
    const colorLower = color.toLowerCase();
    const total = this._axisScopedCheckedColorQtys(axisKey).reduce((sum, cc) => {
      const tokens = (cc.color || '').split(' / ').map(t => t.trim().toLowerCase());
      return tokens.includes(colorLower) ? sum + cc.qty : sum;
    }, 0);
    return total > 0 ? total * row.qtyPerUnit : undefined;
  },

  _buildPoolColorGroupTable(tableId, colors, visibleColors, rows, mode, axisKey) {
    const headHtml = visibleColors.map(col => `<th class="text-end" data-color="${escapeHtml(col)}">${escapeHtml(col)}</th>`).join('');
    const rowsHtml = rows.map((r, rowIdx) => {
      const rowId = 'prod_pool_group_row_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
      const preSelectedOption = this._buildItemPreselectOption(r.itemName, r.size || '', r.sourceType);
      const qtyPerUnitAttr = (mode === 'create' && r.qtyPerUnit !== undefined) ? ` data-qty-per-unit="${r.qtyPerUnit}"` : '';
      const cellsHtml = visibleColors.map(col => {
        const qty = this._poolGroupCellValue(mode, r, col, axisKey);
        const display = (qty !== undefined && qty !== null) ? this.formatQty(qty) : '';
        return `<td><input type="number" class="form-control text-end matrix-qty pool-group-qty" data-color="${escapeHtml(col)}"${qtyPerUnitAttr} min="0" step="any" value="${display}"></td>`;
      }).join('');
      return `
        <tr id="${rowId}" data-row-idx="${rowIdx}">
          <td>
            <select class="form-select prod-comp-item-select" required>
              <option value=""></option>
              ${preSelectedOption}
            </select>
          </td>
          <td><input type="text" class="form-control prod-comp-size" value="${escapeHtml(r.size || '')}" placeholder="-" readonly></td>
          <td>
            <select class="form-select prod-comp-source" disabled>
              <option value="POOL" selected>Pool (Warehouse)</option>
            </select>
          </td>
          ${cellsHtml}
          <td class="text-center"><button type="button" class="btn btn-outline-danger btn-sm" onclick="App.Production.removePoolColorGroupRow('${rowId}')">✕</button></td>
        </tr>`;
    }).join('');

    const minWidthPx = this.PROD_COLOR_TABLE_FIXED_RESERVE_PX + visibleColors.length * this.PROD_COLOR_TABLE_COLOR_COL_PX;
    const hidden = visibleColors.length === 0;

    return `
      <div class="mb-3" id="${tableId}_wrapper"${hidden ? ' style="display:none;"' : ''}>
        <div class="table-responsive">
          <table class="table table-bordered bg-white shadow-sm mb-0 prod-color-table" id="${tableId}" data-all-colors="${escapeHtml(colors.join('|'))}" data-axis-key="${escapeHtml(axisKey || '')}" style="min-width: ${minWidthPx}px;">
            <thead class="table-light">
              <tr>
                <th style="width: 22%;">Item / Pool Name</th>
                <th style="width: 8%;">Size</th>
                <th style="width: 13%;">Source</th>
                ${headHtml}
                <th style="width: 3%;" class="text-center">✕</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
      </div>`;
  },

  syncPoolColorGroupColumns() {
    (this._poolColorGroupDefs || []).forEach(def => {
      const table = document.getElementById(def.tableId);
      if (!table) return;
      const headerRow = table.querySelector('thead tr');
      if (!headerRow) return;

      const tokensLower = this._checkedColorTokensLower(def.axisKey);
      const wantLower = new Set(def.colors.filter(c => tokensLower.has(c.toLowerCase())).map(c => c.toLowerCase()));

      Array.from(headerRow.querySelectorAll('th[data-color]')).forEach(th => {
        if (wantLower.has(th.dataset.color.toLowerCase())) return;
        const idx = Array.from(headerRow.children).indexOf(th);
        th.remove();
        table.querySelectorAll('tbody tr').forEach(tr => {
          const td = tr.children[idx];
          if (td) td.remove();
        });
      });

      def.colors.forEach(matchColor => {
        const colorLower = matchColor.toLowerCase();
        if (!wantLower.has(colorLower)) return;
        if (Array.from(headerRow.querySelectorAll('th[data-color]')).some(th => th.dataset.color.toLowerCase() === colorLower)) return;

        const fullIdx = def.colors.indexOf(matchColor);
        const colorThs = Array.from(headerRow.querySelectorAll('th[data-color]'));
        let insertBeforeEl = colorThs.find(th => def.colors.indexOf(th.dataset.color) > fullIdx) || null;
        if (!insertBeforeEl) insertBeforeEl = headerRow.lastElementChild;

        const insertIdx = Array.from(headerRow.children).indexOf(insertBeforeEl);

        const th = document.createElement('th');
        th.className = 'text-end';
        th.dataset.color = matchColor;
        th.textContent = matchColor;
        headerRow.insertBefore(th, insertBeforeEl);

        table.querySelectorAll('tbody tr').forEach(tr => {
          const rowObj = def.rows[Number(tr.dataset.rowIdx)];
          const qty = rowObj ? this._poolGroupCellValue(def.mode, rowObj, matchColor, def.axisKey) : undefined;
          const display = (qty !== undefined && qty !== null) ? this.formatQty(qty) : '';
          const qtyPerUnitAttr = (def.mode === 'create' && rowObj && rowObj.qtyPerUnit !== undefined) ? ` data-qty-per-unit="${rowObj.qtyPerUnit}"` : '';
          const td = document.createElement('td');
          td.innerHTML = `<input type="number" class="form-control text-end matrix-qty pool-group-qty" data-color="${escapeHtml(matchColor)}"${qtyPerUnitAttr} min="0" step="any" value="${display}">`;
          tr.insertBefore(td, tr.children[insertIdx] || null);
        });
      });

      this._syncPoolGroupTableMinWidth(table);
    });
  },

  _syncPoolGroupTableMinWidth(table) {
    const colorCount = table.querySelectorAll('thead th[data-color]').length;
    table.style.minWidth = (this.PROD_COLOR_TABLE_FIXED_RESERVE_PX + colorCount * this.PROD_COLOR_TABLE_COLOR_COL_PX) + 'px';
    const wrapper = document.getElementById(table.id + '_wrapper');
    if (wrapper) wrapper.style.display = colorCount === 0 ? 'none' : '';
  },

  removePoolColorGroupRow(rowId) {
    const row = document.getElementById(rowId);
    if (!row) return;
    const table = row.closest('table');
    this.destroyComponentItemSelect2(row);
    row.remove();
    if (table && !table.querySelector('tbody tr')) {
      table.closest('.mb-3')?.remove();
    }
  },

  refreshCommonSuggestedQty() {
    this._applyQtyPerUnit('#productionComponentsBody tr', this._currentLotTotalQty());
  },

  _applyQtyPerUnit(rowSelector, multiplier) {
    document.querySelectorAll(rowSelector).forEach(row => {
      const qtyPerUnit = row.dataset.qtyPerUnit;
      if (qtyPerUnit === undefined || qtyPerUnit === '') return;
      const qtyInput = row.querySelector('.prod-comp-qty');
      if (qtyInput) qtyInput.value = this.formatQty(multiplier * toNumber(qtyPerUnit));
    });
  },

  // ── Per-Color Components matrix (manual rows only) ───────────────────
  // Auto-population (populateColorMatrixForColors, called from
  // handleColorCheckToggle/toggleColorGroup below) always finds zero
  // matching components for any process that passes Round 13's guard
  // (_processNeedsColorMatrix) -- see that function's comment. What
  // remains real and useful here is the manual "+ Add Per-Color
  // Component" row an operator can add by hand for a one-off case.

  showColorMatrix() {
    const el = document.getElementById('productionColorMatrixWrapper');
    if (el) el.style.display = '';
  },

  hideColorMatrix() {
    const el = document.getElementById('productionColorMatrixWrapper');
    if (el) el.style.display = 'none';
    const groupsEl = document.getElementById('productionPoolColorGroupsWrapper');
    if (groupsEl) groupsEl.style.display = 'none';
    this.clearColorMatrix();
  },

  clearColorMatrix() {
    const tbody = document.getElementById('productionColorMatrixBody');
    if (tbody) {
      tbody.querySelectorAll('tr').forEach(row => this.destroyComponentItemSelect2(row));
      tbody.innerHTML = '';
    }
    const groupsContainer = document.getElementById('productionPoolColorGroupsContainer');
    if (groupsContainer) {
      groupsContainer.querySelectorAll('tr').forEach(row => this.destroyComponentItemSelect2(row));
      groupsContainer.innerHTML = '';
    }
    const headerRow = document.getElementById('productionColorMatrixHeaderRow');
    if (headerRow) {
      Array.from(headerRow.querySelectorAll('th[data-color]')).forEach(th => th.remove());
    }
    this._syncMatrixTableMinWidth();
  },

  _syncMatrixTableMinWidth() {
    const headerRow = document.getElementById('productionColorMatrixHeaderRow');
    const table = headerRow?.closest('table');
    if (!table) return;
    const colorCount = headerRow.querySelectorAll('th[data-color]').length;
    table.style.minWidth = (this.PROD_COLOR_TABLE_FIXED_RESERVE_PX + colorCount * this.PROD_COLOR_TABLE_COLOR_COL_PX) + 'px';
  },

  getMatrixColors() {
    const headerRow = document.getElementById('productionColorMatrixHeaderRow');
    if (!headerRow) return [];
    return Array.from(headerRow.children)
      .map((th, index) => ({ color: th.dataset.color, index }))
      .filter(c => c.color);
  },

  getMatrixColumnIndex(color) {
    const headerRow = document.getElementById('productionColorMatrixHeaderRow');
    if (!headerRow) return -1;
    return Array.from(headerRow.children).findIndex(th => th.dataset.color === color);
  },

  _isColorCheckedUnderMultipleAxes(color) {
    const colorLower = String(color || '').toLowerCase();
    const axisKeys = new Set();
    this.getCheckedColorQtys().forEach(cc => {
      if ((cc.color || '').toLowerCase() === colorLower) axisKeys.add(cc.axisKey || '');
    });
    return axisKeys.size > 1;
  },

  _buildMatrixColorCell(isMerged) {
    const td = document.createElement('td');
    if (isMerged) {
      td.innerHTML = '<select class="form-select form-select-sm prod-comp-item-select mb-1"><option value=""></option></select>'
        + '<input type="number" class="form-control form-control-sm text-end matrix-qty" min="0" step="any" value="">';
    } else {
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'form-control text-end matrix-qty';
      input.min = '0';
      input.step = '0.0001';
      td.appendChild(input);
    }
    return td;
  },

  addMatrixColorColumn(color) {
    if (this.getMatrixColumnIndex(color) !== -1) return;
    const headerRow = document.getElementById('productionColorMatrixHeaderRow');
    if (!headerRow) return;

    const th = document.createElement('th');
    th.dataset.color = color;
    th.style.textAlign = 'right';
    th.textContent = color;
    headerRow.insertBefore(th, headerRow.lastElementChild);

    document.querySelectorAll('#productionColorMatrixBody tr').forEach(row => {
      const isMerged = row.dataset.merged === 'true';
      const td = this._buildMatrixColorCell(isMerged);
      row.insertBefore(td, row.lastElementChild);
      if (isMerged) this.initMergedCellItemSelect2(td.querySelector('.prod-comp-item-select'));
    });
    this._syncMatrixTableMinWidth();
  },

  removeMatrixColorColumn(color) {
    const colorLower = String(color || '').toLowerCase();
    const stillCheckedElsewhere = this.getCheckedColorQtys().some(cc => (cc.color || '').toLowerCase() === colorLower);
    if (stillCheckedElsewhere) return;

    const idx = this.getMatrixColumnIndex(color);
    if (idx === -1) return;
    const headerRow = document.getElementById('productionColorMatrixHeaderRow');
    if (headerRow?.children[idx]) headerRow.children[idx].remove();
    document.querySelectorAll('#productionColorMatrixBody tr').forEach(row => {
      const cell = row.children[idx];
      if (!cell) return;
      const selectEl = cell.querySelector('.prod-comp-item-select');
      if (selectEl && window.jQuery?.fn?.select2 && window.jQuery(selectEl).data('select2')) {
        window.jQuery(selectEl).select2('destroy');
      }
      cell.remove();
    });
    this._syncMatrixTableMinWidth();
  },

  findMatrixRowByDisplayName(displayName, size) {
    const key = `${displayName}|${size || ''}`.toLowerCase();
    return $$('#productionColorMatrixBody tr').find(row => {
      if (row.dataset.merged !== 'true') return false;
      const rowName = row.querySelector('.prod-comp-display-name')?.value.trim() || '';
      const rowSize = row.querySelector('.prod-comp-size')?.value.trim() || '';
      return `${rowName}|${rowSize}`.toLowerCase() === key;
    });
  },

  addMergedMatrixRow(comp = null) {
    const tbody = document.getElementById('productionColorMatrixBody');
    if (!tbody) return null;

    const rowId = 'prod_matrix_row_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    const itemName = (comp && comp.itemName) || '';
    const size = (comp && comp.size) || '';
    const sourceType = (comp && comp.sourceType === 'POOL') ? 'POOL' : 'ITEM';
    const colors = this.getMatrixColors();

    const colorCellsHtml = colors
      .map(() => '<td><select class="form-select form-select-sm prod-comp-item-select mb-1"><option value=""></option></select>'
        + '<input type="number" class="form-control form-control-sm text-end matrix-qty" min="0" step="any" value=""></td>')
      .join('');

    const rowHtml = `
      <tr id="${rowId}" data-merged="true">
        <td><input type="text" class="form-control prod-comp-display-name" value="${escapeHtml(itemName)}" readonly title="Merged across colors — each color cell below has its own item picker"></td>
        <td><input type="text" class="form-control prod-comp-size" value="${escapeHtml(size)}" placeholder="-"></td>
        <td>
          <select class="form-select prod-comp-source" onchange="App.Production.handleMergedSourceChange(this)">
            <option value="ITEM" ${sourceType === 'ITEM' ? 'selected' : ''}>Item (Stock)</option>
            <option value="POOL" ${sourceType === 'POOL' ? 'selected' : ''}>Pool (Warehouse)</option>
          </select>
        </td>
        ${colorCellsHtml}
        <td class="text-center"><button type="button" class="btn btn-outline-danger btn-sm" onclick="App.Production.removeMatrixRow('${rowId}')">✕</button></td>
      </tr>
    `;
    tbody.insertAdjacentHTML('beforeend', rowHtml);
    const rowEl = document.getElementById(rowId);
    colors.forEach(({ index }) => {
      this.initMergedCellItemSelect2(rowEl.children[index]?.querySelector('.prod-comp-item-select'));
    });
    return rowEl;
  },

  _setMergedCellItem(cell, itemComp, qty, qtyPerUnit) {
    if (!cell) return;
    const selectEl = cell.querySelector('.prod-comp-item-select');
    const qtyInput = cell.querySelector('.matrix-qty');

    if (selectEl) {
      const sourceType = (itemComp.sourceType === 'POOL') ? 'POOL' : 'ITEM';
      const option = this._buildItemPreselectOption(itemComp.itemName || '', itemComp.size || '', sourceType);
      selectEl.innerHTML = `<option value=""></option>${option}`;
      if (window.jQuery?.fn?.select2 && window.jQuery(selectEl).data('select2')) {
        window.jQuery(selectEl).trigger('change.select2');
      }
    }
    if (qtyInput) {
      if (qtyPerUnit !== undefined) qtyInput.dataset.qtyPerUnit = qtyPerUnit;
      qtyInput.value = qty !== undefined ? this.formatQty(qty) : '';
    }
  },

  handleMergedSourceChange(selectEl) {
    const row = selectEl.closest('tr');
    row?.querySelectorAll('.prod-comp-item-select').forEach(sel => {
      if (window.jQuery?.fn?.select2) window.jQuery(sel).val(null).trigger('change');
    });
    const sizeInput = row?.querySelector('.prod-comp-size');
    if (sizeInput) sizeInput.value = '';
  },

  addColorMatrixRow() {
    this.addMatrixItemRow();
  },

  addMatrixItemRow(comp = null) {
    const tbody = document.getElementById('productionColorMatrixBody');
    if (!tbody) return null;

    const rowId = 'prod_matrix_row_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    const itemName = (comp && comp.itemName) || '';
    const size = (comp && comp.size) || '';
    const sourceType = (comp && comp.sourceType === 'POOL') ? 'POOL' : 'ITEM';
    const preSelectedOption = this._buildItemPreselectOption(itemName, size, sourceType);

    const colorCellsHtml = this.getMatrixColors()
      .map(() => `<td><input type="number" class="form-control text-end matrix-qty" min="0" step="any" value=""></td>`)
      .join('');

    const rowHtml = `
      <tr id="${rowId}">
        <td>
          <select class="form-select prod-comp-item-select" required>
            <option value=""></option>
            ${preSelectedOption}
          </select>
        </td>
        <td><input type="text" class="form-control prod-comp-size" value="${escapeHtml(size)}" placeholder="-"></td>
        <td>
          <select class="form-select prod-comp-source" onchange="App.Production.handleMatrixSourceChange(this)">
            <option value="ITEM" ${sourceType === 'ITEM' ? 'selected' : ''}>Item (Stock)</option>
            <option value="POOL" ${sourceType === 'POOL' ? 'selected' : ''}>Pool (Warehouse)</option>
          </select>
        </td>
        ${colorCellsHtml}
        <td class="text-center"><button type="button" class="btn btn-outline-danger btn-sm" onclick="App.Production.removeMatrixRow('${rowId}')">✕</button></td>
      </tr>
    `;
    tbody.insertAdjacentHTML('beforeend', rowHtml);
    const rowEl = document.getElementById(rowId);
    this.initComponentItemSelect2(rowEl);
    return rowEl;
  },

  removeMatrixRow(rowId) {
    const row = document.getElementById(rowId);
    if (row) {
      this.destroyComponentItemSelect2(row);
      row.remove();
    }
  },

  handleMatrixSourceChange(selectEl) {
    const row = selectEl.closest('tr');
    const itemSelect = row?.querySelector('.prod-comp-item-select');
    if (itemSelect && window.jQuery?.fn?.select2) {
      window.jQuery(itemSelect).val(null).trigger('change');
    }
    const sizeInput = row?.querySelector('.prod-comp-size');
    if (sizeInput) sizeInput.value = '';
  },

  findMatrixItemRowByName(itemName, size) {
    const key = `${(itemName || '').trim()}|${(size || '').trim()}`.toLowerCase();
    return $$('#productionColorMatrixBody tr').find(row => {
      if (row.dataset.merged === 'true') return false;
      const itemSelect = row.querySelector('.prod-comp-item-select');
      if (!itemSelect || itemSelect.value === '') return false;
      const opt = itemSelect.options[itemSelect.selectedIndex];
      const rowItemName = (opt.dataset.name || opt.textContent || '').trim();
      const rowSize = row.querySelector('.prod-comp-size')?.value.trim() || '';
      return `${rowItemName}|${rowSize}`.toLowerCase() === key;
    });
  },

  _setItemRowColorQty(row, colIndex, qty, qtyPerUnit) {
    const input = row?.children[colIndex]?.querySelector('.matrix-qty');
    if (!input) return;
    if (qtyPerUnit !== undefined) input.dataset.qtyPerUnit = qtyPerUnit;
    input.value = qty !== undefined ? this.formatQty(qty) : '';
  },

  async populateColorMatrixForColor(color, seq, axisKey) {
    const processId = document.getElementById('productionProcessId')?.value;
    if (!processId) return;
    await this.populateColorMatrixForColors(processId, [color], seq, axisKey);
    if (seq !== undefined && seq !== this._compLoadSeq) return;
    await this.refreshPoolAvailability();
  },

  async populateColorMatrixForColors(processId, colors, seq, axisKey) {
    if (!processId || !colors || colors.length === 0) return;

    try {
      const res = await this._fetchProcessComponents(processId);
      if (seq !== undefined && seq !== this._compLoadSeq) return;
      const all = res.success ? (res.data || []) : [];
      const commonOverrideComps = this._getCommonItemsWithColorOverride(all);

      colors.forEach(color => {
        const colIndex = this.getMatrixColumnIndex(color);
        const thisColorQty = (this._axisScopedCheckedColorQtys(axisKey).find(c => c.color === color) || {}).qty || 0;

        if (colIndex !== -1) {
          const colorComps = all.filter(c => App.Utils.sameText(c.colorGroup, color))
            .map(c => ({ ...c, displayName: this._stripColorSubstring(c.itemName || '', color) }));

          colorComps.forEach(c => {
            let row = this.findMatrixRowByDisplayName(c.displayName, c.size || '');
            if (!row) row = this.addMergedMatrixRow({ itemName: c.displayName, size: c.size, sourceType: c.sourceType });
            const cell = row.children[colIndex];
            const qty = thisColorQty > 0 ? thisColorQty * c.qtyPerUnit : c.qtyPerUnit;
            this._setMergedCellItem(cell, { itemName: c.itemName, size: c.size, sourceType: c.sourceType }, qty, c.qtyPerUnit);
          });

          const overriddenKeys = new Set(colorComps.map(c => this._itemSlotKey(c.displayName, c.size)));
          commonOverrideComps.forEach(c => {
            if (overriddenKeys.has(this._itemSlotKey(c.itemName, c.size))) return;
            let row = this.findMatrixRowByDisplayName(c.itemName, c.size || '');
            if (!row) row = this.addMergedMatrixRow({ itemName: c.itemName, size: c.size, sourceType: c.sourceType });
            const cell = row.children[colIndex];
            const qty = thisColorQty > 0 ? thisColorQty * c.qtyPerUnit : c.qtyPerUnit;
            this._setMergedCellItem(cell, { itemName: c.itemName, size: c.size, sourceType: c.sourceType }, qty, c.qtyPerUnit);
          });
        }

        this.refreshPoolColorGroupCells(color, thisColorQty, axisKey);
      });
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to load process recipe', true);
    }
  },

  refreshPoolColorGroupCells(color, colorQty, axisKey) {
    const container = document.getElementById('productionPoolColorGroupsContainer');
    if (!container) return;
    const tokensLower = (color || '').split(' / ').map(t => t.trim().toLowerCase()).filter(Boolean);
    container.querySelectorAll('table.prod-color-table').forEach(table => {
      const tableAxisKey = table.dataset.axisKey || '';
      if (axisKey && tableAxisKey && axisKey !== tableAxisKey) return;
      const checkedColorQtys = this._axisScopedCheckedColorQtys(tableAxisKey);
      table.querySelectorAll('.pool-group-qty').forEach(input => {
        const inputColorLower = (input.dataset.color || '').toLowerCase();
        if (!tokensLower.includes(inputColorLower)) return;
        const qtyPerUnit = input.dataset.qtyPerUnit;
        if (qtyPerUnit === undefined || qtyPerUnit === '') return;
        const total = checkedColorQtys.reduce((sum, cc) => {
          const ccTokens = (cc.color || '').split(' / ').map(t => t.trim().toLowerCase()).filter(Boolean);
          return ccTokens.includes(inputColorLower) ? sum + cc.qty : sum;
        }, 0);
        input.value = total > 0 ? this.formatQty(total * toNumber(qtyPerUnit)) : '';
      });
    });
  },

  serializeColorMatrix() {
    const components = [];
    const headerColors = this.getMatrixColors();
    document.querySelectorAll('#productionColorMatrixBody tr').forEach(row => {
      const isMerged = row.dataset.merged === 'true';
      const size = row.querySelector('.prod-comp-size')?.value.trim() || '';
      const sourceType = row.querySelector('.prod-comp-source')?.value === 'POOL' ? 'POOL' : 'ITEM';

      let rowItemName = '';
      if (!isMerged) {
        const itemSelect = row.querySelector('.prod-comp-item-select');
        if (!itemSelect || itemSelect.value === '') return;
        const itemOpt = itemSelect.options[itemSelect.selectedIndex];
        rowItemName = (itemOpt.dataset.name || itemOpt.textContent || '').trim();
        if (!rowItemName) return;
      }

      headerColors.forEach(({ color, index }) => {
        const cell = row.children[index];
        const qty = toNumber(cell?.querySelector('.matrix-qty')?.value);
        if (qty <= 0) return;

        let itemName = rowItemName;
        if (isMerged) {
          const cellSelect = cell?.querySelector('.prod-comp-item-select');
          if (!cellSelect || cellSelect.value === '') return;
          const cellOpt = cellSelect.options[cellSelect.selectedIndex];
          itemName = (cellOpt.dataset.name || cellOpt.textContent || '').trim();
        }
        if (!itemName) return;
        components.push({ itemName, size, color: '', sourceType, qty, colorGroup: color });
      });
    });
    return components;
  },

  serializePoolColorGroups() {
    const components = [];
    document.querySelectorAll('#productionPoolColorGroupsContainer tbody tr').forEach(row => {
      const itemSelect = row.querySelector('.prod-comp-item-select');
      if (!itemSelect || itemSelect.value === '') return;
      const itemOpt = itemSelect.options[itemSelect.selectedIndex];
      const itemName = (itemOpt.dataset.name || itemOpt.textContent || '').trim();
      if (!itemName) return;
      const size = row.querySelector('.prod-comp-size')?.value.trim() || '';

      row.querySelectorAll('.pool-group-qty').forEach(input => {
        const qty = toNumber(input.value);
        if (qty <= 0) return;
        const color = input.dataset.color || '';
        if (!color) return;
        components.push({ itemName, size, color: '', sourceType: 'POOL', qty, colorGroup: color });
      });
    });
    return components;
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
    this._resetProcDataCache();
    this.clearComponentsTable();
    this.hideColorMatrix();
    const checklistEl = document.getElementById('productionColorChecklist');
    if (checklistEl) checklistEl.innerHTML = '';
    const colorWrapper = document.getElementById('productionColorWrapper');
    if (colorWrapper) colorWrapper.style.display = 'none';
    const revertColorsBtn = document.getElementById('productionRevertColorsBtn');
    if (revertColorsBtn) revertColorsBtn.style.display = 'none';
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

  // Adaptation from source: a lot whose SAVED Components Consumed
  // contains any non-COMMON colorGroup row was recorded via the
  // Per-Color Matrix -- editing it correctly needs that not-yet-ported
  // system (source's own populateComponentsConsumedDirect), so it's
  // guarded here instead of silently dropping that data on re-save. A
  // lot with a colorBreakdown but only COMMON components (created by
  // this round, via the Color Checklist alone) is fully editable.
  async openEditModal(idx) {
    const p = App.State.globalProduction[idx];
    if (!p) return;

    const usesMatrixComponents = (p.componentsConsumed || []).some(c => c.colorGroup && c.colorGroup !== 'COMMON');
    if (usesMatrixComponents) {
      App.Utils.notPortedYet('Editing this multi-color Production Lot (it uses Per-Color Components, not yet supported here)');
      return;
    }

    const seq = ++this._compLoadSeq;
    this._resetProcDataCache();

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

    let colors = await this.populateColorChecklist(p.processId, seq);
    if (seq !== this._compLoadSeq) return;

    const addColorsBtn = document.getElementById('productionAddColorsBtn');
    if (addColorsBtn) addColorsBtn.style.display = 'none';
    const revertColorsBtn = document.getElementById('productionRevertColorsBtn');
    if (revertColorsBtn) revertColorsBtn.style.display = 'none';

    // This process has no auto-detected color sub-groups, but the saved
    // lot still carries a colorBreakdown -- it must have been recorded
    // via "Add Colors to this Lot" (enableManualColors). Rebuild the
    // checklist from the full Color Master list so those saved colors
    // have a row to check/restore against.
    if (colors.length === 0 && p.colorBreakdown && p.colorBreakdown.length > 0) {
      await App.Color.ensureLoaded();
      const breakdownColors = p.colorBreakdown.map(c => c.color).filter(Boolean);
      const allColors = Array.from(new Set([
        ...(App.State.globalColors || []).map(c => c.name),
        ...breakdownColors
      ]));

      const wrapper = document.getElementById('productionColorWrapper');
      const checklistEl = document.getElementById('productionColorChecklist');
      checklistEl.innerHTML = '';
      // isCustom=true here for the same reason as enableManualColors --
      // this process has zero configured color groups, so these rows'
      // colorBreakdown entries need isCustom to survive a re-save.
      this.renderColorChecklistRows(allColors, undefined, true);

      document.getElementById('productionQtyWrapper').style.display = 'none';
      document.getElementById('productionQty').required = false;
      wrapper.style.display = '';
      document.getElementById('productionComponentsSectionLabel').innerText = 'Common Components';
      this.showColorMatrix();
      this._setMultiColorNotice(false);

      colors = allColors;
    }

    if (colors.length > 0) {
      // A saved multi-color batch (colorBreakdown) drives the checklist;
      // a legacy single-color lot (just p.color/p.qty, no breakdown) is
      // treated as a one-color breakdown so it upgrades to the new model
      // as soon as it's saved again.
      const breakdown = (p.colorBreakdown && p.colorBreakdown.length > 0)
        ? p.colorBreakdown
        : (p.color ? [{ color: p.color, qty: p.qty }] : []);

      const claimedRows = new Set();
      const findChecklistRow = (color, axisKey) => {
        const rows = $$('#productionColorChecklist .production-color-row').filter(r => !claimedRows.has(r));
        let row = axisKey ? rows.find(r => r.dataset.group === axisKey && r.dataset.color === color) : null;
        if (!row) row = rows.find(r => r.dataset.color === color);
        return row || null;
      };

      breakdown.forEach(entry => {
        const color = entry.color;
        const qty = entry.qty;
        let colorRow = findChecklistRow(color, entry.axisKey);

        if (!colorRow) {
          const checklistEl = document.getElementById('productionColorChecklist');
          if (checklistEl) {
            if (!checklistEl.querySelector('[data-group-master="custom"]')) {
              checklistEl.insertAdjacentHTML('beforeend', this._buildColorGroupHeader('custom', 'Custom'));
            }
            const isPrimaryFlag = entry.countsTowardTotal !== false;
            checklistEl.insertAdjacentHTML('beforeend', this._colorRowHtml(color, 'custom', true, isPrimaryFlag));
            colorRow = $$('#productionColorChecklist .production-color-row')
              .find(r => r.dataset.group === 'custom' && r.dataset.color === color && !claimedRows.has(r));
          }
        }

        if (colorRow) claimedRows.add(colorRow);
        const chk = colorRow?.querySelector('.production-color-check');
        const qtyInput = colorRow?.querySelector('.production-color-qty');
        if (chk) chk.checked = true;
        if (qtyInput) { qtyInput.disabled = false; qtyInput.value = qty; }
      });
      this._syncColorGroupMasterCheckbox('custom');

      // Round 13 adaptation: source repopulates the Per-Color Matrix here
      // from saved componentsConsumed (populateComponentsConsumedDirect).
      // This lot is guarded (usesMatrixComponents, above) to have none,
      // so only the flat Common Components table needs restoring.
      this.clearComponentsTable();
      (p.componentsConsumed || []).forEach(c => this.addComponentRow(c));
      await this.refreshPoolAvailability();
    } else {
      document.getElementById('productionQty').value = p.qty;
      if (p.componentsConsumed && p.componentsConsumed.length > 0) {
        this.clearComponentsTable();
        p.componentsConsumed.forEach(c => this.addComponentRow(c));
        await this.refreshPoolAvailability();
      } else {
        await this.populateComponentsFromProcess(p.processId, p.color || '', seq);
      }
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
// DOMContentLoaded-bound prodForm.onsubmit. componentsConsumed combines
// the flat Common table with the (Round 13: always-empty for a
// guard-passing process) Per-Color Matrix and Pool Color Group tables,
// same shape source submits.
document.addEventListener('DOMContentLoaded', function () {
  const prodForm = document.getElementById('productionForm');
  if (!prodForm) return;

  prodForm.onsubmit = async function (e) {
    e.preventDefault();

    const colorWrapper = document.getElementById('productionColorWrapper');
    const isMultiColor = !!colorWrapper && colorWrapper.style.display !== 'none';

    if (isMultiColor) {
      const colorQtys = App.Production.getCheckedColorQtys();
      if (colorQtys.length === 0) {
        App.Utils.showToast('Check at least one Color and enter its quantity.', true);
        return;
      }
      if (colorQtys.some(c => c.qty === 0)) {
        App.Utils.showToast('Every checked Color needs a non-zero quantity.', true);
        return;
      }
      if (document.querySelector('#productionColorChecklist input[name="productionPrimaryAxisPick"]') &&
          !document.querySelector('#productionColorChecklist input[name="productionPrimaryAxisPick"]:checked')) {
        App.Utils.showToast('Pick which group is Primary (its quantities become this lot\'s total) before saving.', true);
        return;
      }
    }

    const processSelect = document.getElementById('productionProcessId');
    const processWasDisabled = processSelect?.disabled ?? false;
    if (processWasDisabled && processSelect) processSelect.disabled = false;

    const form = document.getElementById('productionForm');
    const formData = Object.fromEntries(new FormData(form));

    if (processWasDisabled && processSelect) processSelect.disabled = true;

    if (isMultiColor) {
      formData.colorBreakdown = JSON.stringify(App.Production.getCheckedColorQtys());
      delete formData.qty;
      const primaryAxisRadio = document.querySelector('#productionColorChecklist input[name="productionPrimaryAxisPick"]:checked');
      if (primaryAxisRadio) formData.primaryColorAxis = primaryAxisRadio.dataset.axisLabel || '';
      formData.componentsConsumed = JSON.stringify([
        ...App.Production.serializeComponentsConsumed(),
        ...App.Production.serializeColorMatrix(),
        ...App.Production.serializePoolColorGroups()
      ]);
    } else {
      formData.componentsConsumed = JSON.stringify(App.Production.serializeComponentsConsumed());
    }

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
