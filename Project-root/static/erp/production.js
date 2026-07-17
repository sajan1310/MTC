'use strict';
// production.js -- App.Production, ported from Apps_Script/Script_Production.html.
//
// Scope this round: the Production Log list/report side only -- viewing,
// searching, sorting, inline status changes, delete, bulk print, the
// Colorwise Summary report, and the "All Activity" combined feed. This is
// deliberately split from the Create/Edit Lot modal (the multi-axis
// color checklist, per-color component matrix, and per-process
// Warehouse Pool color group tables) and the Production Sheet (lot
// completion) modal, both of which are large, separately interconnected
// features and their own later rounds -- Script_Production.html is
// 4,608 lines and 130+ methods, more than double Process Master (the
// previous largest single round). openCreateModal/openEditModal/
// viewProductionSheet are stubbed to a "not ported yet" toast so their
// buttons don't throw; everything else on this page is fully real.
//
// Adaptations from source (documented, not silent):
// - deleteProduction/deleteProductionBulk/updateProductionStatus all use
//   Api.mutate (not Api.call): every one is mutation=True on the backend.
// - "Issue Stock" buttons (App.Issue.openIssueModal) and the Issued Stock
//   sub-tab's own content are guarded/placeholder'd at the template level
//   -- App.Issue is a whole separate module (lives in Script_Return.html
//   alongside Return/Wastage, not this file) that hasn't been ported at
//   all yet, unlike Production which exists but is missing specific
//   methods. openIssueStockForLot() (only meaningful from inside the
//   not-yet-ported Create/Edit modal) isn't ported this round either --
//   it'll land with that modal.
// - bulkPrint is guarded behind App.Print not existing yet; its builder
//   (buildProductionSheetPrintPageHtml) stays as ported dead code.
// - openColorwiseSummaryModal is exactly what Dashboard's
//   openPipelineStage (Round 1) has been waiting on since it was first
//   guarded behind `typeof App.Production !== 'undefined' &&
//   App.Production.openColorwiseSummaryModal` -- the pipeline
//   drill-down activates with zero changes to dashboard.js.

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

  // ── Stubs for the Create/Edit Lot modal and Production Sheet modal --
  // both are their own later rounds (see module header comment). Kept
  // as real methods (not a missing-function error) so the row/toolbar
  // buttons that call them degrade to a toast instead of throwing.
  openCreateModal() {
    App.Utils.notPortedYet('Logging a new Production Lot');
  },

  openEditModal() {
    App.Utils.notPortedYet('Editing a Production Lot');
  },

  viewProductionSheet() {
    App.Utils.notPortedYet('Production Sheet');
  }
};
