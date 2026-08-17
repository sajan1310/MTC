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
// Round 13 scope (shipped): the multi-axis Color Checklist system --
// checking off which colors a lot produces, per-color quantities, axis
// grouping (a process with 2+ independent Color Axes, e.g. Frame color
// + Rim color), primary-axis selection, custom one-off colors, and
// "+ Add Colors to this Lot" for a process with no auto-detected groups
// at all. Shipped with a guard: a process whose color-configured
// components also needed the Per-Color Component Matrix or Per-Process
// Warehouse Pool Color Group Matrix showed a blocking notice instead,
// since those two systems (each independently complex -- axis-scoped
// column sync, merged vs. manual rows, composite delimiter-joined pool
// colors) hadn't been wired up to real data yet.
//
// Round 14 scope (shipped): lifts that guard. Turned out most of the
// Matrix/Pool-split machinery was already fully, faithfully ported in
// Round 13 as scaffolding (populateCommonComponentsFromProcess,
// renderPoolColorSplitGroups, populateColorMatrixForColors, and every
// column/row helper) -- it simply never received real data while the
// guard stood. What Round 14 actually added:
//   - addComponentRow's `colorScope` handling (a readonly, locked Color
//     field + data-color-scope attribute) -- Round 12's own simplified
//     version silently dropped this, which only mattered once a
//     single-pool-color item (e.g. "Fitted Rim" always Black) could
//     reach that code path via the now-unguarded
//     populateCommonComponentsFromProcess.
//   - _poolDefForCustomColor -- lets a custom color assigned to a
//     pool-sourced group extend that group's own Per-Process Pool
//     Components table, now that _poolColorGroupDefs is genuinely
//     populated instead of always empty.
//   - populateComponentsConsumedDirect + renderPoolColorGroupsFromAccum
//     -- restores a saved lot's actual Matrix/Pool-split components when
//     editing, including the "legacy lot upgrade" path (a combined qty
//     saved before an item was recognized as multi-color gets split
//     evenly across colors as a starting point, with a toast telling
//     the operator to adjust and re-save).
//   - Removed the now-obsolete guard (_processNeedsColorMatrix /
//     _setMultiColorNotice / productionMultiColorNotice) entirely,
//     rather than leaving dead code behind.
//
// This completes the entire Create/Edit Production Lot modal.
//
// Round 15 scope (this round): the Production Sheet (lot-completion)
// modal -- viewProductionSheet and its full supporting cast
// (groupComponentsForSheet, the Common/Per-Color table renderers,
// add-row/add-color-column, reset-to-recorded, save, print). A fully
// editable, printable customization of a lot's already-recorded
// Components Consumed (e.g. a customer-requested substitution) that
// never touches the lot's real saved consumption record -- persisted
// separately via saveProductionSheet into customComponents/sheetRemarks.
// printProductionSheet is guarded behind App.Print not existing yet,
// same pattern as every other print entry point in this app; its
// builder logic stays ported (not stubbed) since it's pure DOM
// transcription with zero dependency on App.Print itself until the
// final App.Print.trigger(...) call. serializeProductionSheet's own
// module comment documents a confirmed field-name mismatch found and
// fixed this round (colorGroup vs. color).
//
// Adaptations from source (documented, not silent):
// - deleteProduction/deleteProductionBulk/updateProductionStatus/
//   saveProduction/saveProductionSheet all use Api.mutate (not
//   Api.call): every one is mutation=True on the backend.
// - initContractorSelect2's Select2 `data` reads `c.contractorName`, not
//   source's `c.name` -- see contractor.js's module header for the full
//   story of this backend field-name deviation (getContractorsData
//   returns contractorName, not name).
// - App.Issue (Issued Stock -- lives in Script_Return.html alongside
//   Return/Wastage, not this file, despite its UI living in Production's
//   own Issued Stock sub-tab) is now real -- see issue.js. The `typeof
//   App.Issue !== 'undefined'` guards in switchSubTab/buildAllActivityRows
//   activated with zero changes needed here, same "guard now, activate
//   later" shape used throughout this port.
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

App.State.productionColumnFilters = { process: [], outputItem: [], productTag: [], assignedBy: [], assignedTo: [], status: [] };

App.Production = {
  STATUS_OPTIONS: ['Pending', 'In Progress', 'Completed', 'Cancelled'],

  // Print-sheet readability palette. The Item Name cannot use bold (see
  // bodyCell in _buildProductionSheetForExport), so hierarchy is carried by
  // size + ink instead: near-black names against deliberately muted grey
  // Size/Narration, so the eye lands on the item first and the supporting
  // columns recede. ZEBRA is a real, visible band; RULE is a light hairline
  // so the banding, not a heavy grid, does the row tracking; GRID_STRONG
  // outlines the table so columns stay anchored.
  PRINT_PALETTE: Object.freeze({
    HEAD_BG: '#cfe8d5',
    HEAD_INK: '#0b5132',
    ZEBRA: '#eef4ef',
    RULE: '#c8d3ca',
    GRID_STRONG: '#8fae99',
    INK_PRIMARY: '#111',
    INK_MUTED: '#5b6b60'
  }),

  // Shared with .prod-color-table CSS -- every place below that sets a
  // pool-color-group/matrix table's inline min-width uses these. The
  // reserve covers the non-color columns: the reorder grip, Item / Pool
  // Name, Size, Narration, Source and ✕.
  PROD_COLOR_TABLE_FIXED_RESERVE_PX: 412,
  PROD_COLOR_TABLE_COLOR_COL_PX: 88,

  // ── Row reordering (drag & sort) ──────────────────────────────────────
  // Available on all three component tables of the Create/Edit Production
  // Lot form: Common Components, Per-Color Components and Per-Process Pool
  // Components.
  //
  // The order is not cosmetic. serializeComponentsConsumed,
  // serializeColorMatrix and serializePoolColorGroups each read their
  // table top-to-bottom, the submit handler concatenates them in that
  // order, and _consolidate_duplicate_components preserves first-seen
  // order server-side -- so what the operator arranges here becomes the
  // order of the lot's stored components_consumed array, which is in turn
  // the order the Production Sheet, its print/PDF export, the bulk print
  // sheet and a later Edit Lot reopen all list the components in.

  // One row's grip cell. It gets a leading column of its own rather than
  // an icon tucked in beside ✕ because these tables scroll horizontally
  // once a batch has several colors -- a grip in the last column would
  // scroll out of reach exactly when a long row most needs moving.
  _dragCellHtml() {
    return '<td class="prod-drag-cell"><span class="prod-drag-handle" title="Drag to reorder — this order is what the saved lot and its printed sheet use"><i class="bi bi-grip-vertical"></i></span></td>';
  },

  // Bound once per <tbody> ELEMENT, tracked with a marker on the node
  // itself. clearComponentsTable/clearColorMatrix only empty a tbody's
  // innerHTML (the element survives), so one instance keeps working across
  // every reload of the Common and Per-Color tables; the Pool tables are
  // rebuilt as new elements each render and simply get a fresh instance.
  //
  // Degrades to a plain, non-draggable table when window.Sortable is
  // absent: it is loaded by the app's only type="module" script (see
  // index.html), which is deferred and may legitimately fail, and nothing
  // here is allowed to depend on it having arrived.
  _initRowSorting(tbody) {
    if (!tbody || tbody._prodRowSortable || !window.Sortable) return;
    tbody._prodRowSortable = window.Sortable.create(tbody, {
      handle: '.prod-drag-handle',
      draggable: 'tr',
      animation: 150,
      ghostClass: 'prod-row-ghost',
      chosenClass: 'prod-row-chosen',
      // An OPEN Select2 dropdown is rendered into the modal, not into the
      // row it belongs to, so dragging the <tr> out from under it would
      // leave it floating over whichever row landed there instead. The
      // CLOSED widget needs no such care -- it is a sibling of the original
      // <select> inside the same <td> and travels with the row, jQuery data
      // (and therefore the Select2 instance) surviving the DOM move.
      onStart: () => {
        if (!window.jQuery?.fn?.select2) return;
        window.jQuery(tbody).find('.prod-comp-item-select').each(function () {
          const $sel = window.jQuery(this);
          if ($sel.data('select2')) $sel.select2('close');
        });
      }
    });
  },

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
      // Items Master is needed for more than the item pickers: component
      // narration and Base Unit are resolved live against globalItems at
      // render time (_resolveDisplayNarration / _resolveDisplayUnit), so
      // without it every component falls back to its stored narration and
      // a blanket 'Pcs' unit.
      const [, , , response] = await Promise.all([
        App.Process.ensureLoaded(),
        App.Color.ensureLoaded(),
        App.Item.ensureLoaded(),
        Api.call('getProductionData')
      ]);
      if (!response.success) {
        App.Utils.showToast(response.message, true);
        return;
      }
      App.State.globalProduction = response.data;
      App.State.productionCurrentPage = 1;
      App.State.productionSortBy = App.State.productionSortBy || 'dateDesc';
      App.State.selectedProduction = [];
      this.updateColumnFilterIcons();
      this.filterData(App.State.productionSearchTerm || '');
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
  // tagged with its own sub-group badge.
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
    App.State.productionSearchTerm = searchTerm || '';
    const term = String(searchTerm || '').toLowerCase().trim();
    const base = term
      ? App.State.globalProduction.filter(p => {
        const haystack = [p.date, p.lotNumber, p.outputItemName, p.color, p.productId, p.productName, p.status, p.assignedBy, p.assignedTo, p.remarks].join(' ');
        return App.Utils.matchesKeywords(haystack, term);
      })
      : App.State.globalProduction;
    App.State.filteredProduction = this.applyColumnFilters(base);
    this.sortFiltered();
    App.State.productionCurrentPage = 1;
    this.renderTable();
  },

  // Computes the value list for a column's filter dropdown. Status uses
  // the fixed STATUS_OPTIONS list (so a status can appear even if no
  // currently loaded lot has it yet); Process/Output Item/Product
  // Tag/Assigned By/To are derived from whatever's actually loaded.
  // Process is looked up through globalProcesses the same way rowHtml
  // resolves its label, so the filter option and the row's own display
  // text can never drift apart.
  getColumnFilterOptions(key) {
    if (key === 'status') return this.STATUS_OPTIONS.map(s => ({ value: s, label: s }));

    const values = new Set();
    (App.State.globalProduction || []).forEach(p => {
      if (key === 'process') {
        const process = (App.State.globalProcesses || []).find(pr => pr.processId === p.processId);
        values.add(process ? process.processName : (p.processId || 'Uncategorized'));
      } else if (key === 'outputItem') {
        if (p.outputItemName) values.add(p.outputItemName);
      } else if (key === 'productTag') {
        if (p.productId) values.add(p.productId);
      } else if (key === 'assignedBy') {
        if (p.assignedBy) values.add(App.Utils.formatNameCase(p.assignedBy));
      } else if (key === 'assignedTo') {
        if (p.assignedTo) values.add(App.Utils.formatNameCase(p.assignedTo));
      }
    });

    return [...values]
      .sort((a, b) => a.localeCompare(b))
      .map(v => ({ value: v, label: v }));
  },

  // Updates the funnel icon's active state in each header cell to reflect
  // whether that column currently has a filter applied. Scoped to the
  // Production Log sub-tab so it never touches another module's
  // same-named .th-filter-btn buttons (see Item Master's own version,
  // which is unscoped since it's the only user of that class today).
  updateColumnFilterIcons() {
    document.querySelectorAll('#productionLogSubTab .th-filter-btn').forEach(btn => {
      const key = btn.dataset.filterKey;
      const active = (App.State.productionColumnFilters[key] || []).length > 0;
      btn.classList.toggle('active', active);
    });
  },

  // Opens (or closes, if already open for this column) the Excel-style
  // checklist dropdown anchored under the clicked header's funnel icon.
  toggleColumnFilter(evt, key) {
    evt.stopPropagation();
    let panel = document.getElementById('productionColFilterPanel');

    if (panel && panel.dataset.key === key) {
      panel.remove();
      return;
    }
    if (panel) panel.remove();

    const btn = evt.currentTarget;
    panel = document.createElement('div');
    panel.id = 'productionColFilterPanel';
    panel.className = 'col-filter-panel';
    panel.dataset.key = key;
    panel.innerHTML = `
      <div class="po-ms-search-wrap">
        <input type="text" class="form-control form-control-sm" placeholder="Search...">
      </div>
      <div class="col-filter-actions">
        <button type="button" data-action="select-all">Select All</button>
        <button type="button" data-action="clear">Clear</button>
      </div>
      <ul class="po-ms-options"></ul>`;
    document.body.appendChild(panel);

    const rect = btn.getBoundingClientRect();
    panel.style.top = `${rect.bottom + window.scrollY + 4}px`;
    panel.style.left = `${Math.min(rect.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - 250)}px`;

    const searchInput = panel.querySelector('input');
    const optionsList = panel.querySelector('.po-ms-options');

    const renderOptions = (term) => {
      const allOptions = this.getColumnFilterOptions(key);
      const selected = App.State.productionColumnFilters[key] || [];
      const t = (term || '').toLowerCase().trim();
      const visible = allOptions.filter(o => !t || o.label.toLowerCase().includes(t));

      optionsList.innerHTML = visible.map(o => {
        const on = selected.includes(o.value);
        return `<li class="po-ms-option${on ? ' checked' : ''}" data-value="${escapeHtml(o.value)}">
          <span class="po-ms-check">${on ? '✓' : ''}</span>
          <span>${escapeHtml(o.label)}</span>
        </li>`;
      }).join('') || '<li class="po-ms-empty">No values found</li>';
    };

    searchInput.addEventListener('input', () => renderOptions(searchInput.value));
    searchInput.addEventListener('click', e => e.stopPropagation());
    panel.addEventListener('click', e => e.stopPropagation());

    panel.querySelector('[data-action="select-all"]').addEventListener('click', () => {
      const t = searchInput.value;
      const visibleValues = this.getColumnFilterOptions(key)
        .filter(o => !t.trim() || o.label.toLowerCase().includes(t.toLowerCase()))
        .map(o => o.value);
      App.State.productionColumnFilters[key] = [...new Set([...(App.State.productionColumnFilters[key] || []), ...visibleValues])];
      this.onColumnFilterChange(key);
      renderOptions(t);
    });

    panel.querySelector('[data-action="clear"]').addEventListener('click', () => {
      App.State.productionColumnFilters[key] = [];
      this.onColumnFilterChange(key);
      renderOptions(searchInput.value);
    });

    optionsList.addEventListener('click', e => {
      const li = e.target.closest('.po-ms-option');
      if (!li) return;
      const val = li.dataset.value;
      const sel = App.State.productionColumnFilters[key] || (App.State.productionColumnFilters[key] = []);
      const idx = sel.indexOf(val);
      if (idx === -1) sel.push(val);
      else sel.splice(idx, 1);
      this.onColumnFilterChange(key);
      renderOptions(searchInput.value);
    });

    renderOptions('');
    requestAnimationFrame(() => searchInput.focus());

    if (!document.body.dataset.productionColFilterOutsideClickBound) {
      document.body.dataset.productionColFilterOutsideClickBound = '1';
      document.addEventListener('click', e => {
        const openPanel = document.getElementById('productionColFilterPanel');
        if (openPanel && !openPanel.contains(e.target) && !e.target.closest('.th-filter-btn')) {
          openPanel.remove();
        }
      });
    }
  },

  onColumnFilterChange(key) {
    this.updateColumnFilterIcons();
    App.State.productionCurrentPage = 1;
    this.filterData(App.State.productionSearchTerm || '');
  },

  clearColumnFilters() {
    App.State.productionColumnFilters = { process: [], outputItem: [], productTag: [], assignedBy: [], assignedTo: [], status: [] };
    document.getElementById('productionColFilterPanel')?.remove();
    this.updateColumnFilterIcons();
    App.State.productionCurrentPage = 1;
    this.filterData(App.State.productionSearchTerm || '');
  },

  // Narrows a base list down to rows matching every active per-column
  // filter (AND across columns, OR within a column's checked values).
  applyColumnFilters(items) {
    const { process, outputItem, productTag, assignedBy, assignedTo, status } = App.State.productionColumnFilters;
    if (!process.length && !outputItem.length && !productTag.length && !assignedBy.length && !assignedTo.length && !status.length) return items;

    return items.filter(p => {
      if (process.length) {
        const proc = (App.State.globalProcesses || []).find(pr => pr.processId === p.processId);
        const label = proc ? proc.processName : (p.processId || 'Uncategorized');
        if (!process.includes(label)) return false;
      }
      if (outputItem.length && !outputItem.includes(p.outputItemName || '')) return false;
      if (productTag.length && !productTag.includes(p.productId || '')) return false;
      if (assignedBy.length && !assignedBy.includes(App.Utils.formatNameCase(p.assignedBy))) return false;
      if (assignedTo.length && !assignedTo.includes(App.Utils.formatNameCase(p.assignedTo))) return false;
      if (status.length && !status.includes(p.status || '')) return false;
      return true;
    });
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

  // ── Work Order (Date + Contractor) ───────────────────────────────────
  // Step 1 of 2: filter modal. Step 2 (generateWorkOrderPreview) groups
  // that day's lots for that contractor by Output Item Name into the
  // actual preview -- see _buildWorkOrderHtml.
  async openWorkOrderModal() {
    const form = document.getElementById('workOrderForm');
    if (form) form.reset();
    const dateInput = document.getElementById('workOrderDate');
    if (dateInput) dateInput.value = todayIso();

    await App.Contractor.ensureLoaded();
    this._initWorkOrderContractorSelect2();

    safeModalShow('workOrderModal');
  },

  // Same shape as initContractorSelect2 above, but tags:false (deliberately
  // NOT allowClear-to-create) -- this is filtering for an EXISTING
  // contractor's lots, not assigning a possibly-new one to a lot.
  _initWorkOrderContractorSelect2() {
    const selectEl = document.getElementById('workOrderContractor');
    if (!selectEl || !window.jQuery?.fn?.select2) return;

    const $select = window.jQuery(selectEl);
    if ($select.data('select2')) $select.select2('destroy');
    selectEl.innerHTML = '';

    const $parentModal = $select.closest('.modal');
    $select.select2({
      placeholder: 'Select a contractor...',
      width: '100%',
      allowClear: true,
      matcher: App.Utils.select2Matcher,
      dropdownParent: $parentModal.length ? $parentModal : window.jQuery(document.body),
      data: (App.State.globalContractors || []).map(c => ({ id: c.contractorName, text: App.Utils.formatNameCase(c.contractorName) }))
    });
  },

  generateWorkOrderPreview(e) {
    if (e) e.preventDefault();
    const date = document.getElementById('workOrderDate')?.value || '';
    const contractor = (document.getElementById('workOrderContractor')?.value || '').trim();
    if (!date || !contractor) {
      App.Utils.showToast('Pick both a Date and a Contractor.', true);
      return;
    }

    const lots = (App.State.globalProduction || []).filter(p =>
      p.dateRaw === date && App.Utils.sameText(p.assignedTo, contractor));
    if (lots.length === 0) {
      App.Utils.showToast('No production lots found for that date and contractor.', true);
      return;
    }

    const content = document.getElementById('workOrderPreviewContent');
    if (content) content.innerHTML = this._buildWorkOrderHtml(date, contractor, lots);

    safeModalHide('workOrderModal');
    safeModalShow('workOrderPreviewModal');
  },

  backToWorkOrderFilters() {
    safeModalHide('workOrderPreviewModal');
    safeModalShow('workOrderModal');
  },

  // Splits `items` into the FEWEST bands of at most `maxPerBand`, each as
  // close to equal size as possible (e.g. 7 items, max 5 -> 4+3, not
  // 5+2) -- so a band never ends up with just one or two lonely entries
  // stranded in an otherwise-empty row. items.length <= maxPerBand
  // (the common case) always returns exactly one band.
  _evenBands(items, maxPerBand) {
    if (items.length === 0) return [];
    const bandCount = Math.ceil(items.length / maxPerBand);
    const perBand = Math.ceil(items.length / bandCount);
    const bands = [];
    for (let i = 0; i < items.length; i += perBand) {
      bands.push(items.slice(i, i + perBand));
    }
    return bands;
  },

  // One table per distinct Output Item Name among `lots` (already filtered
  // to a single date + contractor). Colors/quantities are the PRIMARY
  // color axis only (countsTowardTotal !== false -- same convention
  // _updateColorCombinationPreview/populateComponentsConsumedDirect
  // already use elsewhere in this file), summed across every lot in that
  // item's group so two lots of the same item on the same day combine
  // into one work order line per color instead of listing twice. A lot
  // with no colorBreakdown at all falls back to its own single
  // color/qty (or a bare qty if it has no color either), mirroring
  // buildProductionSheetPrintPageHtml's own fallback.
  //
  // Every text-bearing element below sets its OWN explicit `color` rather
  // than relying on inheritance -- this preview renders live, inside the
  // page's normal DOM (not a hidden print-only container like every other
  // module's builder), so in dark mode it would otherwise inherit
  // --text-primary/--text-secondary (near-white, meant for a dark
  // background) straight through onto this deliberately-white "paper"
  // background and go nearly illegible, which is exactly what happened
  // before this was added.
  //
  // Standard A4 (downloadWorkOrderPdf uses App.Print's shared A4 defaults,
  // no overrides), but still deliberately compact -- tighter padding/
  // margins/font sizes than the other A4 builders in this file, since a
  // Work Order is a short handoff slip, not a multi-page ledger. Assigned
  // By is hoisted into the shared header (shown once) when every lot in
  // this work order shares the same one, instead of repeating it on every
  // single table.
  _buildWorkOrderHtml(dateIso, contractor, lots) {
    const BRAND = '#198754';
    const INK = '#1a1a1a';
    const displayDate = lots[0]?.date || dateIso;

    const groups = new Map(); // outputItemName -> lots[]
    lots.forEach(p => {
      const key = p.outputItemName || '(No Output Item)';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    });

    const allAssignedBy = [...new Set(lots.map(p => App.Utils.formatNameCase(p.assignedBy)).filter(Boolean))];
    const commonAssignedBy = allAssignedBy.length === 1 ? allAssignedBy[0] : '';

    const tableBlocks = Array.from(groups.entries()).map(([itemName, groupLots]) => {
      // Same processId -> Process -> processType resolution as
      // _requirementSheetTitle/rowHtml's own processLabel elsewhere in
      // this file -- one Output Item Name is expected to come from one
      // Process in practice, so the first lot's processId is enough
      // (mirrors displayDate's own "just take the first lot's" shortcut
      // below). No bracket at all when the process has no Process Type
      // set, or can no longer be found (deleted/renamed since logged).
      const groupProcess = (App.State.globalProcesses || []).find(pr => pr.processId === groupLots[0]?.processId);
      const processType = String(groupProcess?.processType || '').trim();
      const displayItemName = processType ? `(${processType}) ${itemName}` : itemName;

      const lotNumbers = [...new Set(groupLots.map(p => p.lotNumber).filter(Boolean))].join(', ') || '-';
      const assignedByList = [...new Set(groupLots.map(p => App.Utils.formatNameCase(p.assignedBy)).filter(Boolean))].join(', ') || '-';
      // Only repeat Assigned By per-table when it ISN'T already covered by
      // the shared header line below (i.e. it varies somewhere in this
      // work order) -- a single common name is shown exactly once.
      const showAssignedByHere = !commonAssignedBy && assignedByList !== '-';

      const colorTotals = new Map(); // display label -> summed qty
      groupLots.forEach(p => {
        const primaryColors = (p.colorBreakdown || []).filter(c => c.countsTowardTotal !== false);
        if (primaryColors.length > 0) {
          primaryColors.forEach(c => {
            const label = c.color + (c.size ? ` (${c.size})` : '');
            colorTotals.set(label, (colorTotals.get(label) || 0) + (toNumber(c.qty) || 0));
          });
        } else {
          const label = p.color || '-';
          colorTotals.set(label, (colorTotals.get(label) || 0) + (toNumber(p.qty) || 0));
        }
      });

      const totalQty = Array.from(colorTotals.values()).reduce((sum, qty) => sum + qty, 0);
      // Colors as COLUMN HEADERS, one row of quantities underneath -- a
      // vertical color/qty pair per row wasted most of a page on
      // whitespace for what's usually just 3-6 colors. Bands are sized
      // ADAPTIVELY per item (_evenBands), not a fixed chunk size: an item
      // with <=MAX_COLS colors always gets exactly ONE band sized to its
      // own color count, so it fully occupies the table width instead of
      // (with a fixed chunk of 4) spilling its 5th color into its own
      // near-empty trailing row. An item that genuinely needs more than
      // MAX_COLS still wraps, but split as evenly as possible (e.g. 7
      // colors -> 4+3, not 6+1) so no band is left mostly blank either.
      //
      // MAX_COLS=5, not 6: a composite color name like "Silky Blue-Navy
      // Blue / Black" needs real column width to wrap onto 2-3 lines --
      // beyond 5 columns even A4 width leaves too little per column, and
      // the header text overflowed into neighboring cells instead of
      // wrapping (word-wrap/overflow-wrap alone weren't enough once the
      // column itself got too narrow). Each <th>/<td> gets an explicit
      // width so table-layout:fixed has something concrete to enforce.
      const MAX_COLS = 5;
      const colorEntries = Array.from(colorTotals.entries());
      const bands = this._evenBands(colorEntries, MAX_COLS);
      const colWidthPct = (100 / (bands[0]?.length || 1)).toFixed(2) + '%';
      const wrapStyle = 'word-wrap:break-word;overflow-wrap:break-word;word-break:break-word;white-space:normal;';
      const bandsHtml = bands.map(band => `
        <tr style="background:#f1f3f5;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
          ${band.map(([color]) => `<th style="width:${colWidthPct};padding:3px 4px;border:1px solid #ddd;text-align:center;font-size:9px;font-weight:700;color:${INK};${wrapStyle}">${escapeHtml(color)}</th>`).join('')}
        </tr>
        <tr>
          ${band.map(([, qty]) => `<td style="width:${colWidthPct};padding:3px 4px;border:1px solid #ddd;text-align:center;font-weight:700;color:${INK};">${this.formatQty(qty)}</td>`).join('')}
        </tr>`).join('');
      // table-layout:fixed derives each column's width from the FIRST
      // row's cell count -- the Total row (only ever 2 cells) needs an
      // explicit colspan matching that width, or it renders as two
      // slivers at the left instead of spanning the full table.
      const widestBandCols = bands.length > 0 ? bands[0].length : 1;
      const totalLabelSpan = Math.max(widestBandCols - 1, 1);

      return `
    <div style="margin-bottom:8px;page-break-inside:avoid;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;background:${BRAND};color:#fff;padding:3px 8px;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
        <span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.3px;">${escapeHtml(displayItemName)}</span>
        <span style="font-size:9.5px;">Lot #${escapeHtml(lotNumbers)}</span>
      </div>
      ${showAssignedByHere ? `
      <div style="font-size:9px;color:#555;padding:2px 8px;border:1px solid #ddd;border-top:none;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
        Assigned By: <strong style="color:${INK};">${escapeHtml(assignedByList)}</strong>
      </div>` : ''}
      <table style="width:100%;border-collapse:collapse;font-size:10.5px;table-layout:fixed;">
        <tbody>
          ${bandsHtml}
          <tr>
            <td colspan="${totalLabelSpan}" style="padding:3px 6px;border:1px solid #ddd;font-weight:700;text-align:right;color:${INK};">Total</td>
            <td style="padding:3px 6px;border:1px solid #ddd;font-weight:700;text-align:right;color:${INK};">${this.formatQty(totalQty)}</td>
          </tr>
        </tbody>
      </table>
    </div>`;
    }).join('');

    return `
<div style="background:#fff;color:${INK};font-family:'Segoe UI',Arial,sans-serif;font-size:11px;line-height:1.45;padding:10px 16px 10px 16px;margin:0;box-sizing:border-box;width:100%;border-top:4px solid ${BRAND};border-bottom:2px solid ${BRAND};-webkit-print-color-adjust:exact;print-color-adjust:exact;">
  <div style="text-align:center;padding:2px 0 4px 0;">
    ${App.Print.brandHeaderHtml(BRAND)}
    <div style="font-size:8px;color:#555;margin-top:2px;letter-spacing:0.2px;">
      6-B, SHIV SHAKTI ESTATE, VERKA CHOWK, DEHLON ROAD, BHAGWANPURA, 141114 LUDHIANA
    </div>
    <div style="font-size:9.5px;color:${BRAND};font-weight:700;margin-top:2px;letter-spacing:0.8px;text-transform:uppercase;">
      Work Order
    </div>
  </div>
  <div style="height:1.5px;background:${BRAND};margin:0 0 6px 0;-webkit-print-color-adjust:exact;print-color-adjust:exact;"></div>

  <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid #ccc;">
    <div>
      <span style="font-size:8px;color:#666;text-transform:uppercase;letter-spacing:0.4px;">Date</span>
      <div style="font-size:11px;font-weight:700;color:${INK};">${escapeHtml(displayDate)}</div>
    </div>
    <div>
      <span style="font-size:8px;color:#666;text-transform:uppercase;letter-spacing:0.4px;">Assigned To</span>
      <div style="font-size:11px;font-weight:700;color:${INK};">${escapeHtml(App.Utils.formatNameCase(contractor))}</div>
    </div>
    ${commonAssignedBy ? `
    <div>
      <span style="font-size:8px;color:#666;text-transform:uppercase;letter-spacing:0.4px;">Assigned By</span>
      <div style="font-size:11px;font-weight:700;color:${INK};">${escapeHtml(commonAssignedBy)}</div>
    </div>` : ''}
  </div>

  ${tableBlocks}
</div>`;
  },

  // Standard A4, same as every other module's PDF export -- no overrides
  // needed, downloadElementAsPDF's defaults (App.Print.PAGE_WIDTH_PX /
  // PAGE_MARGIN_MM) already are A4. A5 (used in an earlier round) turned
  // out too narrow once a composite color name like "Silky Blue-Navy Blue
  // / Black" needed real column width to wrap instead of overflowing into
  // its neighbor.
  async downloadWorkOrderPdf() {
    const date = document.getElementById('workOrderDate')?.value || todayIso();
    const contractor = (document.getElementById('workOrderContractor')?.value || 'Contractor').trim();
    const filename = `Work_Order_${contractor.replace(/[^a-zA-Z0-9_-]/g, '_')}_${date}.pdf`;

    const btn = document.getElementById('workOrderDownloadBtn');
    if (btn) btn.disabled = true;
    try {
      const ok = await App.Print.downloadElementAsPDF('workOrderPreviewContent', filename);
      if (ok) App.Utils.showToast('Work Order PDF downloaded successfully!');
    } finally {
      if (btn) btn.disabled = false;
    }
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
      html += this.rowHtml(p, idx);
    });

    tbody.innerHTML = html;

    App.Utils.renderPagination('productionPagination', filteredProduction.length, cur, rpp, 'production-page', 'Production Lots');
    this.updateBulkButtons();
  },

  // Renders one <tr> for a Production Log record. Shared by renderTable's
  // full rebuild and patchRowInPlace's single-row swap below -- keeping
  // them on one code path means an in-place patch can never drift from
  // what a full reload would have rendered for that same row.
  rowHtml(p, idx) {
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

    return `<tr data-row-key="${escapeHtml(key)}">
    <td class="text-center"><input type="checkbox" class="form-check-input production-select-chk" data-key="${escapeHtml(key)}" ${checked} onchange="App.Production.onRowSelectChange()"></td>
    <td>${escapeHtml(p.date)}</td>
    <td><strong>${escapeHtml(processLabel)}</strong><br><span class="badge bg-secondary">${escapeHtml(p.lotNumber || '-')}</span></td>
    <td>${escapeHtml(p.outputItemName || '-')}${colorBadges ? `<br>${colorBadges}` : ''}</td>
    <td>${p.productId ? `<span class="badge bg-dark fs-6 shadow-sm">${escapeHtml(p.productId)}</span><br>${escapeHtml(p.productName || '')}` : '<span class="text-muted">—</span>'}</td>
    <td class="text-center fw-bold">${escapeHtml(String(p.qty))} Units</td>
    <td>${escapeHtml(App.Utils.formatNameCase(p.assignedBy) || '-')}</td>
    <td>${escapeHtml(App.Utils.formatNameCase(p.assignedTo) || '-')}${p.contractorPayable ? `<br><span class="badge bg-light text-dark border">${formatCurrency(p.contractorPayable)}</span>` : ''}${p.extraChargeType ? `<br><span class="badge" style="background-color:#ffc107;color:#000;" title="Extra charge included in Total Payable above">${escapeHtml(p.extraChargeType)}</span>` : ''}</td>
    <td class="text-center">
      <select class="form-select form-select-sm fw-bold border-0 shadow-sm" style="font-size:0.75rem;appearance:none;-webkit-appearance:none;-moz-appearance:none;background-image:none;padding-right:0.5rem;${this.statusStyleFor(p.status)}" data-row-idx="${idx}" onchange="App.Production.updateStatus(this)" title="Change status directly without opening Edit Lot">${statusOptions}</select>
    </td>
    <td>
      <button class="btn btn-sm btn-outline-dark btn-action w-100 mb-1" onclick="App.Production.viewProductionSheet('${idx}')">Production Sheet</button>
      <button class="btn btn-sm btn-outline-primary btn-action w-100 mb-1" onclick="App.Production.openEditModal('${idx}')">Edit Lot</button>
      <button class="btn btn-sm btn-danger btn-action w-100" onclick="App.Production.delete('${p.rowIdx}', '${escapeHtml(p.productId)}', '${p.qty}')">Delete</button>
    </td>
  </tr>`;
  },

  // Patches one already-loaded row's data + its rendered <tr> after an
  // Edit Lot save, instead of a full loadData() reload (a full
  // getProductionData round-trip + rebuilding every row's HTML), which
  // flashes "Loading Production Logs..." over the whole table and resets
  // scroll position on every single-row edit.
  //
  // Mutates the SAME row object already sitting in globalProduction (and
  // therefore filteredProduction too -- filterData() derives it via
  // .filter(), which holds the same object references, not copies) so
  // nothing else needs re-pointing; mirrors the in-place mutation
  // updateStatus() already does for the status field alone.
  //
  // Trade-off accepted for this: no re-sort/re-filter happens here, so if
  // the edit changed a value the active Sort/Search depends on (e.g. its
  // Date under "Sort by Date"), the row keeps its old position/visibility
  // until the next natural full reload (tab switch, filter, refresh).
  //
  // Returns false -- so the caller can fall back to loadData() -- when the
  // row isn't currently loaded (stale local state) or isn't on the
  // currently displayed page (nothing in the DOM to patch).
  patchRowInPlace(freshRow) {
    const key = String(freshRow.rowIdx);
    const existing = App.State.globalProduction.find(r => String(r.rowIdx) === key);
    if (!existing) return false;

    Object.assign(existing, freshRow);

    const tr = document.querySelector(`#productionTableBody tr[data-row-key="${key}"]`);
    if (!tr) return false;

    const idx = App.State.globalProduction.indexOf(existing);
    tr.outerHTML = this.rowHtml(existing, idx);
    return true;
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
    App.Selection.updateButton('btnBulkDownloadPdfProduction', count, '<i class="bi bi-file-earmark-pdf"></i> Download PDFs');
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
      ${escapeHtml(this._requirementSheetTitle(p.processId))}
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

  // Rewrites the narration/unit/item-name STORED on every already-logged
  // lot to the current Items Master values
  // (production_service.refresh_production_components_from_items_master).
  //
  // Lots saved from now on write narration fresh anyway
  // (production_service._with_master_narration), so in normal use this is
  // a one-off catch-up for lots logged before an Items Master value was
  // set/corrected, or before an item was renamed/re-cased.
  //
  // Confirmed first because it writes across every historical lot at once,
  // and re-runnable: a lot already in sync is left untouched.
  refreshFromItemsMaster() {
    App.Utils.confirmAction(
      'Refresh every already-logged production lot\'s stored narration, unit, and item name to match Items Master?\n\n' +
      'Quantities, colours, item identities and status are never changed. Item name is only corrected to fix ' +
      'casing/spelling drift for the same item — never repointed to a different one. Unit is synced to each ' +
      'item\'s current Base Unit; if an item\'s Base Unit was itself changed since a lot used it, that lot\'s ' +
      'quantity will now read under the new unit.\n\n' +
      'An open Production Sheet is re-rendered with the new values, discarding any edits in it you have not saved.',
      async () => {
        const btn = document.getElementById('btnRefreshProductionFromItems');
        const original = btn?.innerHTML;
        if (btn) {
          btn.disabled = true;
          btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Refreshing...';
        }
        try {
          const res = await Api.mutate('refreshProductionComponentsFromItemsMaster');
          App.Utils.showToast(res.message, !res.success);
          if (res.success) {
            // Captured BEFORE the reload -- currentProductionSheet.idx is an
            // index into globalProduction, which loadData() replaces
            // wholesale, so the open sheet is re-found by its stable
            // rowIdx afterwards instead.
            const openSheetKey = this._openProductionSheetRowKey();
            if (typeof App.Item !== 'undefined') await App.Item.loadData();
            await this.loadData();
            this._rerenderOpenProductionSheet(openSheetKey);
          }
        } catch (err) {
          App.Utils.showToast(err.message || 'Failed to refresh production lots from Items Master', true);
        } finally {
          if (btn) {
            btn.disabled = false;
            btn.innerHTML = original;
          }
        }
      }
    );
  },

  // The stable rowIdx of the lot whose Production Sheet dialog is
  // currently open, or null if the dialog is closed. Used to re-render
  // that sheet after a refresh: currentProductionSheet.idx is a position
  // in globalProduction, which loadData() replaces wholesale, so the
  // position can point at a different lot (or nothing) afterwards.
  _openProductionSheetRowKey() {
    const modalEl = document.getElementById('productionSheetModal');
    if (!modalEl || !modalEl.classList.contains('show')) return null;
    const sheet = App.State.currentProductionSheet;
    if (!sheet || sheet.idx === undefined || sheet.idx === null) return null;
    const p = App.State.globalProduction[sheet.idx];
    return p ? String(p.rowIdx) : null;
  },

  // Repaints an already-open Production Sheet dialog from the freshly
  // reloaded lot data, so a "Refresh from Items Master" is reflected in
  // the sheet the operator is looking at instead of only on the next
  // reopen. No-op when the dialog is closed (it rebuilds from scratch on
  // every open anyway) or when the lot is no longer present.
  _rerenderOpenProductionSheet(rowKey) {
    if (!rowKey) return;
    const idx = (App.State.globalProduction || []).findIndex(r => String(r.rowIdx) === String(rowKey));
    if (idx === -1) return;
    this._populateProductionSheetData(App.State.globalProduction[idx], idx);
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

  // Keeps an Edit Lot's own saved value selectable even when it is no
  // longer among the options the dropdown builds from. Every select in
  // this cascade is populated from ACTIVE processes only, so reopening a
  // lot whose process was since deactivated (or deleted, or whose
  // size/model/type combination no longer has any active process left)
  // assigned select.value a value with no matching <option> -- which the
  // DOM silently resolves to "". For Size/Model/Type that showed the
  // operator a blank, disabled field; for Process it was an outright save
  // blocker: the submit handler re-enables that field to read it into
  // FormData, read "", and the server rejected the save with 'A Process
  // must be selected for this lot.' on a lot that plainly has one.
  //
  // The lot's real value is preserved rather than silently swapped for a
  // valid-looking one -- an edit must never repoint a lot at a different
  // process as a side effect of merely opening it. The Process caller
  // passes an explicitly "(inactive)" label so the operator can see why
  // that option isn't in the normal list; the Size/Model/Type ones just
  // read back their own saved value.
  _ensureSelectedOption(select, value, label) {
    if (!select || !value) return;
    if (Array.from(select.options).some(o => o.value === value)) return;
    select.add(new Option(label || value, value, true, true));
  },

  populateSizeSelect(isDisabled = false, selectedValue = null) {
    const select = document.getElementById('productionSize');
    if (!select) return;

    select.disabled = Boolean(isDisabled);

    if (window.jQuery?.fn?.select2 && window.jQuery(select).data('select2')) {
      window.jQuery(select).select2('destroy');
    }

    const sizesPresent = new Set(
      (App.State.globalProcesses || []).filter(p => p.active).map(p => App.Utils.getSizeFromOutputItemName(p.outputItemName))
    );
    const ordered = App.Utils.PROCESS_SIZE_LIST.filter(s => sizesPresent.has(s));
    if (sizesPresent.has('General')) ordered.push('General');

    let html = '<option value="">Choose a Size...</option>';
    ordered.forEach(s => { html += `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`; });
    select.innerHTML = html;

    if (selectedValue !== null) {
      this._ensureSelectedOption(select, selectedValue);
      select.value = selectedValue;
    } else {
      select.value = '';
      if (!isDisabled) App.Utils.autoSelectOnlyOption(select);
    }

    if (window.jQuery?.fn?.select2) {
      window.jQuery(select).select2({
        placeholder: 'Choose a Size...',
        width: '100%',
        matcher: App.Utils.select2Matcher,
        dropdownParent: App.Utils.select2DropdownParent(select)
      });
    }
  },

  handleSizeChange(size) {
    if (this._suppressCascade) return;
    this.populateModelSelect(size);
    const modelSelect = document.getElementById('productionModel');
    return this.handleModelChange(modelSelect ? modelSelect.value : '');
  },

  populateModelSelect(sizeFilter, isDisabled = !sizeFilter, selectedValue = null) {
    const select = document.getElementById('productionModel');
    if (!select) return;

    select.disabled = Boolean(isDisabled);

    if (window.jQuery?.fn?.select2 && window.jQuery(select).data('select2')) {
      window.jQuery(select).select2('destroy');
    }

    const matches = (App.State.globalProcesses || []).filter(p => p.active)
      .filter(p => !sizeFilter || App.Utils.getSizeFromOutputItemName(p.outputItemName) === sizeFilter);

    const modelsPresent = new Set(matches.map(p => App.Utils.getModelFromOutputItemName(p.outputItemName)));
    const modelNames = (App.State.globalModels || []).map(m => m.name);
    const ordered = modelNames.filter(m => modelsPresent.has(m));
    if (modelsPresent.has('General')) ordered.push('General');

    let html = sizeFilter ? '<option value="">Choose a Model...</option>' : '<option value="">Choose a Size first...</option>';
    ordered.forEach(m => { html += `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`; });
    select.innerHTML = html;

    if (selectedValue !== null) {
      this._ensureSelectedOption(select, selectedValue);
      select.value = selectedValue;
    } else {
      select.value = '';
      if (!isDisabled && sizeFilter) App.Utils.autoSelectOnlyOption(select);
    }

    if (window.jQuery?.fn?.select2) {
      window.jQuery(select).select2({
        placeholder: sizeFilter ? 'Choose a Model...' : 'Choose a Size first...',
        width: '100%',
        matcher: App.Utils.select2Matcher,
        dropdownParent: App.Utils.select2DropdownParent(select)
      });
    }
  },

  handleModelChange(model) {
    if (this._suppressCascade) return;
    const size = document.getElementById('productionSize')?.value || '';
    this.populateProcessTypeSelect(size, model);
    const typeSelect = document.getElementById('productionProcessType');
    return this.handleProcessTypeChange(typeSelect ? typeSelect.value : '');
  },

  populateProcessTypeSelect(sizeFilter, modelFilter, isDisabled = !(sizeFilter && modelFilter), selectedValue = null) {
    const select = document.getElementById('productionProcessType');
    if (!select) return;

    select.disabled = Boolean(isDisabled);

    if (window.jQuery?.fn?.select2 && window.jQuery(select).data('select2')) {
      window.jQuery(select).select2('destroy');
    }

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

    if (selectedValue !== null) {
      this._ensureSelectedOption(select, selectedValue);
      select.value = selectedValue;
    } else {
      select.value = '';
      if (!isDisabled && modelFilter) App.Utils.autoSelectOnlyOption(select);
    }

    if (window.jQuery?.fn?.select2) {
      window.jQuery(select).select2({
        placeholder: modelFilter ? 'Choose a Process Type...' : 'Choose a Model first...',
        width: '100%',
        matcher: App.Utils.select2Matcher,
        dropdownParent: App.Utils.select2DropdownParent(select)
      });
    }
  },

  handleProcessTypeChange(type) {
    if (this._suppressCascade) return;
    const size = document.getElementById('productionSize')?.value || '';
    const model = document.getElementById('productionModel')?.value || '';
    this.populateProcessSelect(size, type, model);
    const processSelect = document.getElementById('productionProcessId');
    return this.handleProcessChange(processSelect ? processSelect.value : '');
  },

  populateProcessSelect(sizeFilter, typeFilter, modelFilter, isDisabled = !(sizeFilter && modelFilter && typeFilter), selectedValue = null) {
    const select = document.getElementById('productionProcessId');
    if (!select) return;

    select.disabled = Boolean(isDisabled);

    if (window.jQuery?.fn?.select2 && window.jQuery(select).data('select2')) {
      window.jQuery(select).select2('destroy');
    }

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

    if (selectedValue !== null) {
      const savedProcess = (App.State.globalProcesses || []).find(p => p.processId === selectedValue);
      this._ensureSelectedOption(select, selectedValue, `${savedProcess ? savedProcess.processName : selectedValue} (inactive)`);
      select.value = selectedValue;
    } else {
      select.value = '';
      if (!isDisabled && typeFilter) App.Utils.autoSelectOnlyOption(select);
    }

    this.initProcessSelect2();
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

  async populateComponentsFromProcess(processId, colorGroup, seq) {
    this.clearComponentsTable();
    if (!processId) return;

    try {
      const res = await this._fetchProcessComponents(processId);
      if (seq !== undefined && seq !== this._compLoadSeq) return;
      const all = res.success ? (res.data || []) : [];
      const components = all.filter(c => !c.colorGroup || App.Utils.isCommonColorGroup(c.colorGroup) || App.Utils.sameText(c.colorGroup, colorGroup || ''));
      const lotQty = toNumber(document.getElementById('productionQty')?.value) || 0;
      components.forEach(c => this.addComponentRow({
        itemName: c.itemName,
        size: c.size,
        // Live from Items Master, not the recipe row's own possibly stale
        // stored value -- see _resolveDisplayNarration.
        narration: this._resolveDisplayNarration(c.itemName, c.size, c.narration),
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
      this.initCustomColorInputSelect2();
      return [];
    }

    if (qtyWrapper) qtyWrapper.style.display = 'none';
    if (qtyInput) { qtyInput.required = false; qtyInput.value = ''; }
    wrapper.style.display = '';
    if (sectionLabel) sectionLabel.innerText = 'Common Components';
    this.showColorMatrix();

    await this.renderGroupedColorChecklist(processId, colors, seq);
    if (seq === undefined || seq === this._compLoadSeq) {
      this._refreshCustomColorGroupSelect();
      this.initCustomColorInputSelect2();
      // Paint the per-color "avail." hints as soon as the rows exist,
      // rather than waiting for the components tables further down to
      // finish loading -- this reads only already-cached data, and
      // refreshPoolAvailability re-runs it afterward once Stock has
      // landed too.
      await this.refreshColorChecklistAvailability(processId, seq);
    }

    return colors;
  },

  // Searchable Select2 for the "Custom Sub-Group" color input, sourced
  // from Color Master with free-text tags allowed (createTag) -- lets the
  // operator pick an existing Color Master name or type a genuinely new
  // one, instead of a plain text box with no autocomplete/dedup help.
  // Torn down and re-initialized each time the checklist reloads (see
  // populateColorChecklist) so it never leaks a stale instance across a
  // process switch.
  initCustomColorInputSelect2() {
    const selectEl = document.getElementById('productionCustomColorInput');
    if (!selectEl || !window.jQuery?.fn?.select2) return;

    const $select = window.jQuery(selectEl);
    if ($select.data('select2')) $select.select2('destroy');
    selectEl.innerHTML = '';

    const $modal = $select.closest('.modal');
    $select.select2({
      placeholder: 'Custom sub-group name…',
      width: '100%',
      tags: true,
      matcher: App.Utils.select2Matcher,
      dropdownParent: $modal.length ? $modal : window.jQuery(document.body),
      createTag(params) {
        const term = (params.term || '').trim();
        if (!term) return null;
        const existing = (App.State.globalColors || []).find(c => App.Utils.sameText(c.name, term));
        if (existing) return { id: existing.name, text: existing.name };
        return { id: term, text: term, newTag: true };
      }
    });
  },

  destroyCustomColorInputSelect2() {
    const selectEl = document.getElementById('productionCustomColorInput');
    if (selectEl && window.jQuery?.fn?.select2) {
      const $select = window.jQuery(selectEl);
      if ($select.data('select2')) $select.select2('destroy');
    }
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
    // The picker only ever shows when 2+ groups exist -- i.e. when this
    // checklist HAS a primary/secondary structure -- so leaving a custom
    // color unfiled means it is not in the primary group and does not add
    // to the lot total. The label said the opposite, and the code used to
    // match the label (see addCustomColorRow); both now say "recorded
    // separately". To make an extra color count, file it into the Primary
    // group in this same picker.
    sel.innerHTML = '<option value="">Independent extra color (recorded separately — does not add to the lot total)</option>'
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
        <span class="small text-muted production-color-avail"></span>
      </div>`;
  },

  renderColorChecklistRows(colors, groupKey, isCustom, isPrimary) {
    const checklistEl = document.getElementById('productionColorChecklist');
    if (!checklistEl) return;
    colors.forEach(color => {
      checklistEl.insertAdjacentHTML('beforeend', this._colorRowHtml(color, groupKey, isCustom, isPrimary));
    });
  },

  // Live Warehouse Pool availability, keyed the same way the server's own
  // pool-availability map is keyed: untagged (intermediate WIP) rows only
  // -- a tagged bucket is already committed to a packed product and can't
  // be drawn on by a new lot -- summed per item name, then per color
  // bucket within it. Map<itemNameLower, Map<colorLower, qty>>.
  _poolAvailByItemColor(poolRows) {
    const byItem = new Map();
    (poolRows || []).forEach(r => {
      if (r.productTag) return;
      const item = String(r.outputItemName || '').trim().toLowerCase();
      if (!item) return;
      if (!byItem.has(item)) byItem.set(item, new Map());
      const colors = byItem.get(item);
      const color = String(r.color || '').trim().toLowerCase();
      colors.set(color, (colors.get(color) || 0) + (Number(r.availableQty) || 0));
    });
    return byItem;
  },

  // One item's available qty in one color. Exact bucket first; failing
  // that, every COMPOSITE bucket this color is one token of (a process
  // drawing on 2+ independent pool inputs at once keys its buckets by the
  // joined combination, e.g. "BCP / Blue-White"), mirroring the same
  // single-token -> composite-bucket resolution the server does so this
  // hint agrees with what a save would actually find. Unlike the server's
  // "exactly one source" rule, every matching composite is summed here:
  // those buckets are disjoint physical stock, so their total really is
  // how much of this color exists. Returns 0 (not null) for an item that
  // has pool history but no bucket for this color at all -- that's a real
  // "none available", not an unknown.
  _poolAvailForColor(colorMap, color) {
    if (!colorMap) return null;
    const key = String(color || '').trim().toLowerCase();
    if (!key) return null;
    if (colorMap.has(key)) return colorMap.get(key);
    let total = 0;
    colorMap.forEach((qty, bucket) => {
      if (bucket.split(' / ').map(t => t.trim()).includes(key)) total += qty;
    });
    return total;
  },

  // Which real inputs feed one checklist group -- i.e. what actually
  // limits how much of that group's colors this lot can produce. Two
  // shapes, matching the two ways a group is built in
  // renderGroupedColorChecklist: a 'pool'/'merged' axis (and every legacy
  // pool-item group) is labeled with its own pool item name(s), joined by
  // ', ' -- so the label resolves straight back to this recipe's
  // POOL-sourced components; a 'tag' axis is labeled with its COLOR_AXIS
  // name instead, and is fed by whichever recipe rows carry that axis
  // label, each color found per-color rather than per-group. The
  // 'other'/'custom' buckets have no configured source at all and resolve
  // to nothing -- deliberately blank rather than a misleading "0 avail."
  _groupInputSources(groupKey, comps) {
    const opt = (this._customColorGroupOptions || []).find(o => o.key === groupKey);
    if (!opt) return { poolItems: [], tagComps: [] };

    const labelParts = opt.label.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const poolItems = comps.filter(c =>
      c.sourceType === 'POOL' && labelParts.includes(String(c.itemName || '').trim().toLowerCase()));

    const axisLabel = opt.label.trim().toLowerCase();
    const tagComps = comps.filter(c =>
      String(c.colorAxis || '').trim().toLowerCase() === axisLabel && axisLabel);

    return { poolItems, tagComps };
  },

  // The availability hint for ONE checklist row: the smallest available
  // quantity across every input that color needs, since the scarcest one
  // is the real ceiling. Returns null when this row's group has no
  // resolvable input (Other/Custom, or a tag axis whose recipe rows don't
  // name this color) so the caller can leave the row blank instead of
  // asserting a zero it can't back up. `parts` carries the per-input
  // breakdown for the tooltip, which is what makes a multi-input group's
  // single min number interpretable.
  _colorRowAvailability(color, groupKey, ctx) {
    const { poolItems, tagComps } = this._groupInputSources(groupKey, ctx.comps);
    const parts = [];

    const addPool = (itemName) => {
      const colorMap = ctx.poolAvail.get(String(itemName || '').trim().toLowerCase());
      const qty = this._poolAvailForColor(colorMap, color);
      if (qty !== null) parts.push({ label: itemName, qty });
    };

    poolItems.forEach(c => addPool(c.itemName));

    tagComps
      // Token match, not whole-string: a tag row scoped to "Blue-White" is
      // genuinely consumed by a lot producing the composite "Blue-White /
      // BCP", so its stock constrains that row's availability. Same rule
      // the Per-Color Components table and saveProduction use.
      .filter(c => this._matchedColorToken(c.colorGroup, color))
      .forEach(c => {
        if (c.sourceType === 'POOL') {
          addPool(c.itemName);
          return;
        }
        const name = String(c.itemName || '').trim().toLowerCase();
        const size = String(c.size || '').trim().toLowerCase();
        const entry = (ctx.stock || []).find(s =>
          String(s.name || '').trim().toLowerCase() === name
          && (!size || String(s.size || '').trim().toLowerCase() === size));
        if (entry) parts.push({ label: c.itemName, qty: Number(entry.currentStock) || 0 });
      });

    if (parts.length === 0) return null;
    return {
      qty: parts.reduce((min, p) => Math.min(min, p.qty), Infinity),
      parts
    };
  },

  // Shows, next to every color in the Colors to Produce checklist, how
  // much of that color is actually available to build from right now --
  // the Warehouse Pool balance of the upstream item(s) that group is
  // driven by (see _groupInputSources), or plain Stock for an
  // ITEM-sourced tag-axis input. This is the producible ceiling for that
  // color, the same question the per-row "avail." hints in the
  // Components tables answer for their own rows (see
  // refreshPoolAvailability) -- just surfaced at the point the operator
  // actually decides which colors and how many to put in the lot, instead
  // of only after scrolling down to the component tables.
  //
  // Purely client-side over the two per-load cached reads the checklist
  // already made (_fetchProcessComponents/_fetchWarehousePoolData) plus
  // whatever Stock refreshPoolAvailability last loaded, so this costs no
  // extra server round trip and is safe to call after any re-render.
  async refreshColorChecklistAvailability(processId, seq) {
    const rows = $$('#productionColorChecklist .production-color-row');
    if (rows.length === 0) return;

    let comps = [];
    let poolRows = [];
    try {
      const [compRes, poolRes] = await Promise.all([
        this._fetchProcessComponents(processId),
        this._fetchWarehousePoolData()
      ]);
      if (seq !== undefined && seq !== this._compLoadSeq) return;
      comps = compRes.success ? (compRes.data || []) : [];
      poolRows = poolRes.success ? (poolRes.data || []) : [];
    } catch (err) {
      // Ignored -- availability hints are advisory, not blocking (same
      // stance as refreshPoolAvailability).
      return;
    }

    const ctx = {
      comps,
      poolAvail: this._poolAvailByItemColor(poolRows),
      stock: App.State.globalStock || []
    };

    // Re-read the rows: the awaits above can only have resolved from cache
    // or a same-load fetch (seq-guarded), but a custom color row may have
    // been added in between.
    $$('#productionColorChecklist .production-color-row').forEach(row => {
      const availEl = row.querySelector('.production-color-avail');
      if (!availEl) return;
      const result = this._colorRowAvailability(row.dataset.color, row.dataset.group, ctx);
      if (!result) {
        availEl.innerText = '';
        availEl.title = '';
        availEl.classList.remove('text-danger', 'fw-bold');
        availEl.classList.add('text-muted');
        return;
      }
      availEl.innerText = `${this.formatQty(result.qty)} avail.`;
      // Only worth spelling out when several inputs feed this color and
      // the single min number alone doesn't say which one is the binding
      // constraint.
      availEl.title = result.parts.length > 1
        ? result.parts.map(p => `${p.label}: ${this.formatQty(p.qty)}`).join('  •  ')
        : `${result.parts[0].label}: ${this.formatQty(result.parts[0].qty)} available`;
      // Nothing (or less than nothing) available is the whole point of
      // showing this, and is far too easy to miss as plain gray text --
      // flagged the same way refreshPoolAvailability flags a negative
      // component balance. Producing it anyway is still allowed -- this
      // only warns.
      const empty = result.qty <= 0;
      availEl.classList.toggle('text-danger', empty);
      availEl.classList.toggle('fw-bold', empty);
      availEl.classList.toggle('text-muted', !empty);
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

  // Finds which Per-Process Pool Components table def (see
  // renderPoolColorSplitGroups/renderPoolColorGroupsFromAccum), if any, a
  // custom color's chosen checklist group corresponds to -- so
  // addCustomColorRow can extend that table's own recognized colors.
  //   - No group picked (0 or 1 pool group at all): unambiguous, use
  //     that one pool def if it's the only one.
  //   - A pool-sourced group explicitly picked: match by item name --
  //     a pool axis's own label is built server-side as
  //     itemNames.join(', '), so splitting on the same separator
  //     recovers the real item name(s) to match against each def's rows.
  //   - A tag-based axis, or "Independent" picked among 2+ groups where
  //     more than one pool def exists: not pool-related, no def to
  //     extend.
  _poolDefForCustomColor(targetGroup) {
    const defs = this._poolColorGroupDefs || [];
    if (!targetGroup) {
      return defs.length === 1 ? defs[0] : null;
    }
    if (targetGroup.source !== 'pool') return null;
    const itemNames = targetGroup.label.split(',').map(s => s.trim().toLowerCase());
    return defs.find(def => (def.rows || []).some(r => itemNames.includes((r.itemName || '').trim().toLowerCase()))) || null;
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

    // A custom color assigned to (or defaulting to, when there's only
    // one group so the picker never showed at all) a POOL-sourced group
    // is additional output of that SAME real pool item -- extend that
    // item's own Per-Process Pool Components table with this new color
    // so the operator has somewhere to record its actual consumption
    // (see syncPoolColorGroupColumns, which picks up the new entry
    // itself once this color's checkbox is checked below).
    const poolDef = this._poolDefForCustomColor(targetGroup);
    if (poolDef && !poolDef.colors.some(c => c.toLowerCase() === name.toLowerCase())) {
      poolDef.colors.push(name);
      poolDef.colors.sort((a, b) => a.localeCompare(b));
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
      // Not filed into any group -- so not filed into the PRIMARY one, and
      // therefore recorded per color without adding to the lot total. (The
      // picked-group branch above already inherits its group's own
      // isPrimary, so a custom color put INTO the primary axis counts.)
      //
      // The single exception is a checklist with no primary/secondary
      // structure at all, where every checked color counts and there is
      // nothing for this row to be secondary to -- passing undefined there
      // leaves the flag off, exactly like the rows already on screen.
      const isPrimaryFlag = this._checklistHasPrimaryStructure() ? false : undefined;
      this.renderColorChecklistRows([name], 'custom', true, isPrimaryFlag);
    }
    if (input) {
      if (window.jQuery?.fn?.select2 && window.jQuery(input).data('select2')) {
        window.jQuery(input).val(null).trigger('change');
      } else {
        input.value = '';
      }
    }
    if (groupSelect) groupSelect.value = '';

    const row = $$('#productionColorChecklist .production-color-row')
      .find(r => r.dataset.group === groupKey && App.Utils.sameColor(r.dataset.color, name));
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

    this._pruneRedundantMatrixColumns();
    await this.refreshPoolAvailability();
  },

  // A process that resolves to exactly ONE Color Axis, but whose
  // configured color sub-groups include colors that axis does not own --
  // e.g. a "Kit Bag" / "Small Kit Bag 24-26" sub-group that isn't tied to
  // any process's own color history. Those are sub-groups, not a second
  // axis: they are recorded per color but must NOT add to the lot's total.
  //
  // The flat render this replaces emitted them through
  // renderColorChecklistRows(colors) with no groupKey and no isPrimary, so
  // _colorRowHtml wrote no data-primary attribute at all -- and
  // getCheckedColorQtys reads a MISSING attribute as counting
  // (row.dataset.primary !== 'false'). Every such sub-group was therefore
  // silently promoted to primary and added into the lot quantity.
  //
  // The server never agreed with that. save_production's
  // _is_primary_axis_row falls back, for exactly these rows (no axisKey,
  // not custom), to "is this color one of the primary axis's colors?" and
  // excludes everything else from the qty it stores. So the form's running
  // total -- and the component quantities and Payable scaled off it --
  // disagreed with what was actually saved, and checking ONLY sub-group
  // colors failed the save with 'At least one "<axis>" color is required
  // for this lot.' Giving each side of the split a real group key makes the
  // two agree by construction: the axis rows now carry that axis's own key
  // (matched by axis identity server-side), and the sub-group rows carry
  // an explicit countsTowardTotal:false the server honors directly.
  //
  // Returns false -- caller keeps the flat render -- when there is nothing
  // to split: no color belongs to the axis (splitting would leave an empty
  // primary group), or every color does (flat is already correct, and the
  // server already counts them all).
  SUB_GROUP_BUCKET_LABEL: 'Other (recorded per color — does not add to the lot total)',

  // Every color this process KNOWS (getProcessColorGroups) that no axis
  // owns. That list is recipe/pool colors UNION this process's own logged
  // production history UNION the operator's own INCLUDE overrides -- and
  // that last category is exactly the sub-group an operator designates by
  // hand in the Process editor ("Add Combination" exists to pre-seed a
  // color no recipe or pool signal would ever produce). None of those can
  // ever belong to a computed axis, so any render path that draws only
  // axis colors drops them silently.
  _nonAxisSubGroupColors(colors, axes) {
    const axisColorsLower = new Set();
    (axes || []).forEach(a => (a.colors || []).forEach(c => axisColorsLower.add(String(c).trim().toLowerCase())));
    return (colors || []).filter(c => !axisColorsLower.has(String(c).trim().toLowerCase()));
  },

  // Is this checklist running with a primary/secondary structure at all?
  // True as soon as ANY group has been designated -- an axis, a pool
  // cluster, or the non-counting sub-group bucket -- in which case a color
  // not placed in the primary group must not add to the lot total. False
  // only for the flat render (a process with no Color Axis, or "Add Colors
  // to this Lot"), where every checked color counts and "primary" has
  // nothing to mean. Read off the rendered rows rather than
  // _customColorGroupOptions, so it stays right for a shape that renders
  // groups without registering a pickable option for them.
  _checklistHasPrimaryStructure() {
    return $$('#productionColorChecklist .production-color-row[data-primary]').length > 0;
  },

  // Renders non-axis sub-groups as their own non-counting bucket. Shared by
  // all three grouped render paths so they can't drift.
  _renderSubGroupBucket(checklistEl, subGroupColors) {
    if (!subGroupColors || subGroupColors.length === 0) return;
    checklistEl.insertAdjacentHTML('beforeend', this._buildColorGroupHeader('other', this.SUB_GROUP_BUCKET_LABEL));
    this.renderColorChecklistRows(subGroupColors, 'other', false, false);
    // Registered as a pickable destination too, so "+ Add Custom Sub-Group"
    // can file a one-off color HERE explicitly. Without it the picker lists
    // only the counting groups, which on a process with one axis plus
    // sub-groups left the operator no way to add a custom color that
    // doesn't inflate the lot total.
    this._customColorGroupOptions.push({ key: 'other', label: 'Other', isPrimary: false, source: 'other' });
  },

  // Renders a single-axis process's checklist: that axis's own colors as
  // the counting group, everything else as non-counting sub-groups.
  //
  // Once a process HAS an axis, this always handles the whole list -- it
  // never hands back to the flat render. The flat render marks no row
  // primary at all, which getCheckedColorQtys reads as "counts", so falling
  // back to it for an awkward shape (an axis that owns none of the
  // configured colors) would put sub-groups back into the lot total by the
  // very default this exists to remove. Both halves are simply allowed to
  // be empty instead:
  //   - no axis colors: only the sub-group bucket renders, the running
  //     total is 0, and the operator can see there is nothing primary to
  //     produce -- which is the truth, and is what the server independently
  //     concludes too ('At least one "<axis>" color is required for this
  //     lot.').
  //   - no sub-group colors: only the axis group renders. Worth doing even
  //     though a flat render would total the same, because these rows now
  //     carry the axis's real key, so save_production matches them by axis
  //     identity rather than falling back to comparing color names.
  _renderAxisAndSubGroupChecklist(checklistEl, colors, axis) {
    const subGroupColors = this._nonAxisSubGroupColors(colors, [axis]);
    const subGroupLower = new Set(subGroupColors.map(c => String(c).trim().toLowerCase()));
    const axisColors = colors.filter(c => !subGroupLower.has(String(c).trim().toLowerCase()));

    if (axisColors.length > 0) {
      checklistEl.insertAdjacentHTML('beforeend', this._buildColorGroupHeader(axis.key, axis.label));
      this.renderColorChecklistRows(axisColors, axis.key, false, true);
      this._customColorGroupOptions.push({ key: axis.key, label: axis.label, isPrimary: true, source: axis.source });
    }
    this._renderSubGroupBucket(checklistEl, subGroupColors);
  },

  // Splits the Colors to Produce checklist into sub-groups: one per Color
  // Axis when this process has 2+ (see getProcessColorAxes), else one per
  // multi-color pool item set, with any leftover in a final "Other" block.
  async renderGroupedColorChecklist(processId, colors, seq) {
    const checklistEl = document.getElementById('productionColorChecklist');
    if (!checklistEl) return;

    // Hoisted: the single-axis case is resolved further down, in the
    // fallback paths, long after this try block has returned or thrown.
    let axes = [];
    try {
      const axesRes = await Api.call('getProcessColorAxes', processId);
      if (seq !== undefined && seq !== this._compLoadSeq) return;
      axes = (axesRes.success && axesRes.data && Array.isArray(axesRes.data.axes)) ? axesRes.data.axes : [];
      if (axes.length >= 2) {
        checklistEl.innerHTML = '';
        // primaryIsDefault true means nobody has actually chosen this axis
        // -- it's just the first one in recipe order, standing in because
        // this process's Primary Axis cell is still blank. Pre-checking its
        // radio anyway would let every lot save through the "Pick which
        // group is Primary" guard below without the operator ever making a
        // real choice, silently locking in whichever axis happens to sit
        // first in the recipe (which a later reorder could then flip).
        // Leaving nothing checked forces this lot's operator to be the one
        // who decides -- their pick then persists as the process's default
        // going forward (see save_production's write-back).
        const primaryAxisKey = axesRes.data.primaryIsDefault ? '' : (axesRes.data.primaryAxisKey || '');
        axes.forEach(axis => {
          const isPrimary = !!primaryAxisKey && axis.key === primaryAxisKey;
          checklistEl.insertAdjacentHTML('beforeend', this._buildColorAxisGroupHeader(axis, isPrimary));
          this.renderColorChecklistRows(axis.colors, axis.key, false, isPrimary);
          this._customColorGroupOptions.push({ key: axis.key, label: axis.label, isPrimary, source: axis.source });
        });
        // This branch used to render ONLY axis.colors and discard `colors`
        // entirely, so on a 2+-axis process a sub-group the operator had
        // deliberately designated on the process -- and any color this
        // process had genuinely produced before -- simply never appeared in
        // Colors to Produce at all, with nothing to say why. They are
        // sub-groups, not a further axis, so they land in the same
        // non-counting bucket the other render paths give them.
        this._renderSubGroupBucket(checklistEl, this._nonAxisSubGroupColors(colors, axes));
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
      // Only a process with NO axis at all may use the flat render, where
      // every checked color counts -- see the groups.size === 0 branch.
      if (axes.length > 0) this._renderAxisAndSubGroupChecklist(checklistEl, colors, axes[0]);
      else this.renderColorChecklistRows(colors);
      return;
    }

    checklistEl.innerHTML = '';

    const multiColorItems = comps.filter(c => c.sourceType === 'POOL' && (!c.colorGroup || App.Utils.isCommonColorGroup(c.colorGroup))
      && (poolColorMap.get((c.itemName || '').trim().toLowerCase()) || []).length > 1);

    const groups = new Map();
    multiColorItems.forEach(c => {
      const itemColors = poolColorMap.get((c.itemName || '').trim().toLowerCase()) || [];
      const signature = itemColors.slice().sort((a, b) => a.localeCompare(b)).join('|').toLowerCase();
      if (!groups.has(signature)) groups.set(signature, { colorSet: new Set(itemColors.map(x => x.toLowerCase())), itemNames: [] });
      groups.get(signature).itemNames.push(c.itemName);
    });

    if (groups.size === 0) {
      // No multi-color pool cluster to group by -- but an axis may still
      // exist, and the moment one does, a color outside it is a sub-group:
      // recorded per color, never added to the lot total.
      //
      // The flat render below is the ONLY path that lets a checked color
      // count without belonging to a primary group, and it is reserved for
      // the one shape where that is right: a process with no axis at all,
      // where there is no primary/secondary distinction to draw and the
      // server independently totals every counted row the same way (see
      // save_production's no-primary-axis branch).
      if (axes.length > 0) this._renderAxisAndSubGroupChecklist(checklistEl, colors, axes[0]);
      else this.renderColorChecklistRows(colors);
      return;
    }

    const usedColors = new Set();
    let groupIdx = 0;
    // Only the first cluster (this process's earliest recipe row -- `groups`
    // preserves recipe order) drives the lot's total quantity, same "recipe
    // order wins" convention _default_primary_color_axis_label uses
    // server-side. Every other cluster is recorded per-color but excluded
    // from the total -- previously every cluster was hardcoded isPrimary:
    // true here, so an unlinked secondary group (e.g. a Kit Bag pool set)
    // double-counted its own checked quantities into the total alongside
    // the real primary group.
    let primaryAssigned = false;
    groups.forEach(({ colorSet, itemNames }) => {
      const matching = colors.filter(col => colorSet.has(col.toLowerCase()) && !usedColors.has(col.toLowerCase()));
      if (matching.length === 0) return;
      matching.forEach(c => usedColors.add(c.toLowerCase()));
      groupIdx++;
      const groupKey = `group_${groupIdx}`;
      const isPrimary = !primaryAssigned;
      primaryAssigned = true;
      checklistEl.insertAdjacentHTML('beforeend', this._buildColorGroupHeader(groupKey, itemNames.join(', ')));
      this.renderColorChecklistRows(matching, groupKey, false, isPrimary);
      this._customColorGroupOptions.push({ key: groupKey, label: itemNames.join(', '), isPrimary, source: 'pool' });
    });

    // Same non-counting bucket, same label, same pickable destination as
    // the axis-driven paths -- this branch used to build its own inline
    // 'Other' block, which is how the three paths drifted apart in the
    // first place.
    this._renderSubGroupBucket(checklistEl, colors.filter(c => !usedColors.has(c.toLowerCase())));
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

  async setPrimaryColorAxisChoice(radioEl) {
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

    // A column that was exempt from pruning while its own axis was Primary
    // (see _pruneRedundantMatrixColumns) doesn't get re-evaluated on its
    // own -- nothing else re-checks existing columns once the Primary
    // designation moves elsewhere, so a color left over from the old
    // Primary axis would otherwise sit there empty forever, matching the
    // new Primary axis's colors but never getting pruned.
    this._pruneRedundantMatrixColumns();
    await this.refreshPoolAvailability();
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

    // Same top-level-only gate as refreshPoolAvailability: this must see
    // the FULLY settled cascade (every matched non-primary row checked
    // and its column populated), so a nested call from
    // _syncMatchingNonPrimaryRows would judge half-built columns.
    if (refreshAvailability) {
      this._pruneRedundantMatrixColumns();
      await this.refreshPoolAvailability();
    }
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

  // Sums qty across every checked color row matching `color` by literal
  // name, across all axes -- a matrix column is keyed by literal color name
  // only (unlike the Pool tables, which are physically partitioned
  // one-table-per-axis), so two independent Color Axes can legitimately
  // share a color name (see renderColorwiseSummary). Degrades to "this
  // row's own qty" whenever the name is unique to one axis.
  _totalQtyForColorName(color) {
    const colorLower = String(color || '').trim().toLowerCase();
    return this.getCheckedColorQtys()
      .filter(cc => String(cc.color || '').trim().toLowerCase() === colorLower)
      .reduce((sum, cc) => sum + cc.qty, 0);
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
    if (colIndex !== -1) {
      // A matrix column is keyed by literal color name only (unlike the
      // Pool tables, which are physically partitioned one-table-per-axis)
      // -- two independent Color Axes can legitimately share a color name
      // (see renderColorwiseSummary), so this must SUM every checked row
      // matching that name across all axes, not just the one that just
      // changed. Summing degrades to "this row's own qty" whenever the
      // name is unique to one axis (the common case), so it's a strict
      // generalization, not a behavior change there.
      const totalQty = this._totalQtyForColorName(color);
      document.querySelectorAll('#productionColorMatrixBody tr').forEach(matrixRow => {
        const cell = matrixRow.children[colIndex];
        const input = cell?.querySelector('.matrix-qty');
        const qtyPerUnit = input?.dataset.qtyPerUnit;
        if (input && qtyPerUnit !== undefined && qtyPerUnit !== '') {
          input.value = this.formatQty(totalQty * toNumber(qtyPerUnit));
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
  // checked color with a numeric quantity entered. Strict rule: only the
  // Primary group's checked colors ever count toward the lot total (no
  // exception for an unclassified "Other" leftover bucket) -- everything
  // else is recorded per-color but never added in.
  getCheckedColorQtys() {
    return $$('#productionColorChecklist .production-color-row')
      .filter(row => row.querySelector('.production-color-check')?.checked)
      .map(row => ({
        color: row.dataset.color,
        qty: toNumber(row.querySelector('.production-color-qty')?.value) || 0,
        isCustom: row.dataset.custom === 'true',
        countsTowardTotal: row.dataset.primary !== 'false',
        axisKey: row.dataset.group || ''
      }));
  },

  _currentLotTotalQty() {
    return this.getCheckedColorQtys()
      .filter(c => c.countsTowardTotal)
      .reduce((sum, c) => sum + c.qty, 0);
  },

  // The lot-total multiplier currently in effect -- the plain Qty field in
  // single-color mode, or the running total across checked colors once
  // the multi-color checklist is active. Used to give a freshly added
  // manual component row (see addComponentRow) an immediate, correctly-
  // scaled starting qty instead of leaving it blank until the next
  // unrelated qty/color edit happens to trigger a recompute.
  _currentComponentQtyMultiplier() {
    const wrapper = document.getElementById('productionColorWrapper');
    const isMultiColor = !!wrapper && wrapper.style.display !== 'none';
    return isMultiColor ? this._currentLotTotalQty() : (toNumber(document.getElementById('productionQty')?.value) || 0);
  },

  // Map<itemNameLower, string[]> of live Warehouse Pool colors for every
  // COMMON POOL-sourced recipe component of this process.
  async getPoolColorAwareItemNames(processId) {
    try {
      const [compRes, poolRes, axesRes] = await Promise.all([
        this._fetchProcessComponents(processId),
        this._fetchWarehousePoolData(),
        Api.call('getProcessColorAxes', processId).catch(() => null)
      ]);
      const comps = compRes?.success ? (compRes.data || []) : [];
      const poolRows = poolRes?.success ? (poolRes.data || []) : [];
      const axes = (axesRes?.success && axesRes.data && Array.isArray(axesRes.data.axes)) ? axesRes.data.axes : [];

      const commonPoolItems = new Set(
        comps
          .filter(c => c.sourceType === 'POOL' && (!c.colorGroup || App.Utils.isCommonColorGroup(c.colorGroup)))
          .map(c => (c.itemName || '').trim().toLowerCase())
      );

      const colorSets = new Map();
      poolRows.forEach(r => {
        const key = (r.outputItemName || '').trim().toLowerCase();
        if (!r.color || !commonPoolItems.has(key)) return;
        if (!colorSets.has(key)) colorSets.set(key, new Set());
        colorSets.get(key).add(r.color);
      });

      axes.forEach(axis => {
        // A 'merged' axis (Process Color Links pairing a pool axis with
        // another axis) inherits its constituent axes' own labels joined
        // by ', ' -- per process_service.py's _merge_linked_axes, a pool
        // axis's label is already its item names, so this still resolves
        // correctly; a non-pool constituent's label (e.g. a tag axis'
        // "Rim Color") just won't match any commonPoolItems key below and
        // is harmlessly skipped.
        if ((axis.source !== 'pool' && axis.source !== 'merged') || !Array.isArray(axis.colors)) return;
        const itemNames = (axis.label || '').split(',').map(s => s.trim().toLowerCase());
        itemNames.forEach(key => {
          if (!commonPoolItems.has(key)) return;
          if (!colorSets.has(key)) colorSets.set(key, new Set());
          axis.colors.forEach(col => colorSets.get(key).add(col));
        });
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
  // color. A POOL-sourced component that's genuinely multi-color in the
  // Warehouse Pool is routed into its own Per-Process Pool Components
  // table instead (see renderPoolColorSplitGroups); one with just ONE
  // pool color (e.g. "Fitted Rim" is always Black) stays here as a
  // normal row with its colorGroup locked to that one color.
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
      const commonComps = all.filter(c => !c.colorGroup || App.Utils.isCommonColorGroup(c.colorGroup));
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
          // Live from Items Master, not the recipe row's own possibly stale
          // stored value -- see _resolveDisplayNarration.
          narration: this._resolveDisplayNarration(c.itemName, c.size, c.narration),
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
      .filter(c => c.colorGroup && !App.Utils.isCommonColorGroup(c.colorGroup) && c.sourceType !== 'POOL')
      .map(c => this._itemSlotKey(this._stripColorSubstring(c.itemName || '', c.colorGroup), c.size))
    );
    return (components || []).filter(c =>
      (!c.colorGroup || App.Utils.isCommonColorGroup(c.colorGroup)) &&
      c.sourceType !== 'POOL' &&
      overrideKeys.has(this._itemSlotKey(c.itemName, c.size))
    );
  },

  // Which part of `color` a recipe row's Color Sub-Group names, or null if
  // it names none of it. A checked color is often a COMPOSITE of the axes
  // this lot combines ("Blue-White / BCP"), while a recipe's color-specific
  // rows are tagged with ONE axis's own color ("Blue-White", or "BCP").
  // Matching the whole composite string against colorGroup therefore never
  // hit, so checking a composite color added its column to the Per-Color
  // Components table and then populated nothing into it -- the table looked
  // like it emptied itself whenever the colors changed.
  //
  // Both tokens of a composite legitimately apply at once: a lot producing
  // "Blue-White / BCP" consumes the frame-color-specific parts AND the
  // rim-color-specific parts. This mirrors save_production's own server-side
  // rule, which already accepts a component scoped to any single axis token
  // of a breakdown color.
  //
  // Returns the matched token rather than a boolean so the caller can strip
  // THAT token from the item's display name (see _stripColorSubstring)
  // instead of the full composite, which would never be found inside an item
  // name like "Frame---Blue-White".
  _matchedColorToken(colorGroup, color) {
    const cg = String(colorGroup || '').trim();
    if (!cg) return null;
    if (App.Utils.sameText(cg, color)) return String(color || '').trim();
    const segments = String(color || '').split(' / ').map(x => x.trim()).filter(Boolean);
    return segments.find(seg => App.Utils.sameText(seg, cg)) || null;
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

  // Reconstructs which entries belong to the same conceptual Per-Color
  // Components matrix ROW, given only the flat colorGroup-tagged list
  // saved on components_consumed (or a process recipe's own components).
  // Text-matching alone (_stripColorSubstring) cannot always do this: a
  // "Teddy Basket" can legitimately be a literal RED item under the lot's
  // Blue colour group and a literal BLUE item under Red, so stripping
  // finds nothing in common between the two and they never merge --
  // fragmenting one dragged/authored row into several single-colour rows
  // that then sort by WHICH colour they belong to instead of staying in
  // the order they were entered (see LOT-PF2IIS-0002).
  //
  // Two passes, most-confident signal first:
  //
  // PASS 1 -- exact shared name: an item saved under the LITERAL SAME
  // name+size under more than one colour (e.g. one physical two-tone
  // sticker used under both "Blue-White / Black" and "Red-White /
  // Black") is unambiguously one row, position or no position. Pulling
  // these out FIRST also protects the positional pass below from being
  // misled by them -- a shared item is often logged at a different
  // relative spot among its neighbours per colour than its non-shared
  // siblings (e.g. one colour pair's data entry listed the shared
  // sticker before an unrelated Handle Grip, the other pair listed it
  // after -- zipping the whole list by raw index would then merge the
  // sticker with that unrelated Handle Grip; see LOT-PC2IDS-0001).
  //
  // PASS 2 -- position across each colour's own remaining ordered list
  // (everything Pass 1 didn't already claim): partition into one list
  // per colour, then zip the Nth entry of every colour's list together
  // as one row, i.e. treat each colour's own list as a numbered
  // sub-group and align across colours by position -- mirroring how the
  // matrix was actually built (one row, one cell per colour, added left
  // to right). Only trustworthy when every colour's REMAINING list is
  // the same length; a colour that genuinely skips or adds an item
  // throws the alignment off, so that (and the single-colour case, where
  // "position" is meaningless) falls back to the older name-stripping
  // merge instead of risking a wrong pairing.
  //
  // PASS 3 -- pairing up 2-colour shared-row groups (see
  // _pairTwoColorSharedRowGroups): a physical item that's printed once
  // per OUTER colour pair rather than once per lot colour (e.g. a
  // sticker set with a "Red-BLUE" variant for one pair of colours and a
  // "PINK-SeaGreen" variant for another) is, after Pass 1, several
  // separate 2-colour rows -- correct, but not consolidated. Deliberately
  // narrow and opt-in: only 2-colour groups are ever considered, and only
  // merged when doing so is unambiguous (see that method's own comment).
  //
  // All rows are then handed back in original first-appearance order, so
  // which pass caught a given row never affects drag order.
  _reconstructPerColorRows(entries) {
    if (!entries || entries.length === 0) return [];

    const indexOf = new Map(entries.map((e, i) => [e, i]));
    const firstIndexOf = cells => Math.min(...cells.map(c => indexOf.get(c)));
    const rowFrom = cells => ({
      firstIndex: firstIndexOf(cells),
      size: cells[0].size,
      narration: cells[0].narration,
      unit: cells.find(c => c.unit)?.unit || '',
      // The ORIGINAL entry objects, not a re-shaped copy -- callers that
      // stash extra fields on their own entries (e.g. populateComponents-
      // ConsumedDirect's __ref back to the raw saved component, needed to
      // materialize a DOM row) get them back unchanged.
      cells
    });

    const byItemKey = new Map();
    entries.forEach(e => {
      const key = this._itemSlotKey(e.itemName, e.size);
      if (!byItemKey.has(key)) byItemKey.set(key, []);
      byItemKey.get(key).push(e);
    });

    const sharedRowCells = [];
    const remaining = [];
    byItemKey.forEach(group => {
      const colorsInGroup = new Set(group.map(e => e.colorKey));
      if (colorsInGroup.size > 1) {
        sharedRowCells.push(group);
      } else {
        remaining.push(...group);
      }
    });
    const sharedRows = this._pairTwoColorSharedRowGroups(sharedRowCells).map(rowFrom);
    const remainingOrdered = remaining.slice().sort((a, b) => indexOf.get(a) - indexOf.get(b));

    const byColor = new Map();
    remainingOrdered.forEach(e => {
      if (!byColor.has(e.colorKey)) byColor.set(e.colorKey, []);
      byColor.get(e.colorKey).push(e);
    });
    const colorKeys = Array.from(byColor.keys());
    const counts = colorKeys.map(c => byColor.get(c).length);
    const evenCoverage = colorKeys.length > 1 && counts.every(n => n === counts[0]);

    const positionalRows = evenCoverage
      ? Array.from({ length: counts[0] }, (_, i) => rowFrom(colorKeys.map(c => byColor.get(c)[i])))
      : this._reconstructPerColorRowsByName(remainingOrdered).map(row => ({ ...row, firstIndex: firstIndexOf(row.cells) }));

    return [...sharedRows, ...positionalRows].sort((a, b) => a.firstIndex - b.firstIndex);
  },

  // Pairs up 2-colour exact-shared-item rows (each already proven by
  // Pass 1 above to be ONE literal item across exactly 2 colours) into
  // fewer rows spanning more colours, when it's unambiguous to do so --
  // e.g. a sticker set's "Red-BLUE" variant (colours A+B) and its
  // "PINK-SeaGreen" variant (colours C+D) are really the same four
  // physical items, printed once per outer colour pair rather than once
  // per lot colour.
  //
  // Only merges when: every 2-colour group's own colour-set is disjoint
  // from every other's (a colour claimed by more than one group makes it
  // ambiguous which group a shared column belongs to), AND every group
  // carries the exact same number of rows (so "position N of every
  // group" is well-defined). Rows are then zipped by that position --
  // the SAME "trust position when the shape matches" the primary pass
  // (Pass 2) already relies on, just applied one level up to whole rows
  // instead of raw entries. Deliberately narrow: groups covering 3+
  // colours are left untouched (not this pattern), and ANY failed check
  // backs out to leaving every group's rows separate rather than risking
  // a wrong pairing -- this is strictly an opt-in consolidation, never a
  // requirement for correctness (see _reconstructPerColorRows Pass 1).
  //
  // Takes/returns arrays of cell-arrays (not yet wrapped into rows) so
  // the caller can apply its own row-building (with its own firstIndex
  // etc.) uniformly to whatever comes back, merged or not.
  _pairTwoColorSharedRowGroups(sharedRowCellGroups) {
    const byColorPair = new Map();
    const untouched = [];
    (sharedRowCellGroups || []).forEach(cells => {
      const colorsInRow = Array.from(new Set(cells.map(c => c.colorKey)));
      if (colorsInRow.length !== 2) { untouched.push(cells); return; }
      const key = colorsInRow.slice().sort().join(' ');
      if (!byColorPair.has(key)) byColorPair.set(key, { colors: colorsInRow, rows: [] });
      byColorPair.get(key).rows.push(cells);
    });

    const pairGroups = Array.from(byColorPair.values());
    if (pairGroups.length < 2) return [...untouched, ...pairGroups.flatMap(g => g.rows)];

    const seenColors = new Set();
    let disjoint = true;
    pairGroups.forEach(g => g.colors.forEach(c => {
      if (seenColors.has(c)) disjoint = false;
      seenColors.add(c);
    }));
    const counts = pairGroups.map(g => g.rows.length);
    const evenCounts = counts.every(n => n === counts[0]);
    if (!disjoint || !evenCounts) return [...untouched, ...pairGroups.flatMap(g => g.rows)];

    const merged = Array.from({ length: counts[0] }, (_, i) => pairGroups.flatMap(g => g.rows[i]));
    return [...untouched, ...merged];
  },

  // The pre-position-alignment fallback: groups entries whose item name
  // (with THIS entry's own colour word stripped out, unless the raw name
  // is already shared verbatim across more than one colour -- see
  // _sharedItemSlotKeys' reasoning, reimplemented here against `entries`
  // rather than raw components) lands on the same name+size+narration.
  // Used whenever _reconstructPerColorRows can't trust position (uneven
  // per-colour counts, or only one colour in play).
  _reconstructPerColorRowsByName(entries) {
    const groupsByItemKey = new Map();
    entries.forEach(e => {
      const key = this._itemSlotKey(e.itemName, e.size);
      if (!groupsByItemKey.has(key)) groupsByItemKey.set(key, new Set());
      groupsByItemKey.get(key).add(e.colorKey);
    });
    const sharedKeys = new Set();
    groupsByItemKey.forEach((set, key) => { if (set.size > 1) sharedKeys.add(key); });

    const rows = [];
    const rowIndex = new Map();
    entries.forEach(e => {
      const displayName = sharedKeys.has(this._itemSlotKey(e.itemName, e.size))
        ? (e.itemName || '').trim()
        : this._stripColorSubstring(e.itemName || '', e.colorKey);
      const rowKey = [displayName, e.size || '', e.narration || ''].join('|').toLowerCase();
      let row = rowIndex.get(rowKey);
      if (!row) {
        row = { size: e.size, narration: e.narration, unit: e.unit, cells: [] };
        rowIndex.set(rowKey, row);
        rows.push(row);
      }
      if (!row.unit) row.unit = e.unit;
      row.cells.push(e);
    });
    return rows;
  },

  // A reconstructed row's own best-effort generic label (see
  // _reconstructPerColorRows). Three shapes, most specific first:
  //
  // 1. EVERY cell is the literal same item (a genuinely shared item, e.g.
  //    a fixed two-tone sticker printed once and used under several
  //    colour groups, "CURVY-STICKER-Side Flap---Red-BLUE") -- the RAW
  //    name, unstripped. Stripping the FIRST cell's own colour word out
  //    of a shared name is actively harmful here: "Blue" legitimately
  //    appears inside "Red-BLUE" as part of the item's own fixed
  //    two-tone description, not as this row's colour tag, so stripping
  //    it would mislabel the row AND make _cellItemTag think "Blue" is
  //    the one thing left to disambiguate on EVERY cell, including ones
  //    that were never tagged Blue at all.
  //
  // 2. More than one distinct literal name, but fewer distinct names than
  //    cells (a _pairTwoColorSharedRowGroups merge of two or more
  //    exact-shared-name clusters, e.g. a "Red-BLUE" print variant AND a
  //    "PINK-SeaGreen" print variant of the same physical sticker) --
  //    stripping any ONE cluster's own colour word would randomly eat
  //    into another cluster's own tag the same way as case 1, so instead
  //    take the longest run of tokens every distinct name starts with,
  //    which is exactly the part before the print variants start to
  //    differ ("CURVY-STICKER-Side Flap" out of both example names).
  //
  // 3. One distinct literal name per cell (a genuinely different item per
  //    colour, e.g. Teddy Basket) -- best-effort strip the first cell's
  //    own colour word out of its name, same as before.
  _rowDisplayName(row) {
    const primary = row.cells[0];
    const distinctNames = Array.from(new Set(row.cells.map(c => (c.itemName || '').trim().toLowerCase())));
    if (distinctNames.length === 1) return (primary.itemName || '').trim();
    if (distinctNames.length < row.cells.length) {
      return this._longestCommonTokenPrefix(row.cells.map(c => c.itemName)) || (primary.itemName || '').trim();
    }
    return this._stripRowOwnColorSubstring(primary.itemName || '', row.cells.map(c => c.colorKey));
  },

  // Strips whichever colour word actually appears in `itemName`, tried in
  // this row's own cell order (primary's own axis colour first, same as
  // before -- the common case where an item's colour word matches the lot
  // colour it's filed under). Falls through to the row's OTHER cells'
  // colours because a physical item can be deliberately paired with a lot
  // colour other than its own (e.g. a Red-coloured accessory used under
  // the lot's Blue column for contrast, see LOT-PF2IIS-0002 in
  // groupComponentsForSheet) -- stripping only primary.colorKey then finds
  // nothing, and the raw name (still carrying its own colour word) leaks
  // through as the row label instead of being cleaned up like every other
  // colour's _cellItemTag already is.
  _stripRowOwnColorSubstring(itemName, colorKeys) {
    for (const color of colorKeys) {
      const stripped = this._stripColorSubstring(itemName, color);
      if (stripped !== itemName) return stripped;
    }
    return itemName;
  },

  // The longest leading run of tokens (delimiters included, so "CURVY",
  // "-", "STICKER" rejoins as "CURVY-STICKER") every one of `names`
  // starts with, stopping at the first token where they diverge. Used by
  // _rowDisplayName case 2 above to label a row merged from more than one
  // exact-shared-name cluster without guessing at what's shared past the
  // point the names actually start to differ.
  _longestCommonTokenPrefix(names) {
    const tokenLists = (names || []).map(n => String(n || '').split(/([^a-z0-9]+)/i).filter(p => p !== ''));
    if (tokenLists.length === 0) return '';
    const shortest = Math.min(...tokenLists.map(t => t.length));
    let prefix = [];
    for (let i = 0; i < shortest; i++) {
      const token = tokenLists[0][i];
      if (!tokenLists.every(list => list[i].toLowerCase() === token.toLowerCase())) break;
      prefix.push(token);
    }
    return prefix.join('').replace(/[\s\-_]+$/, '').trim();
  },

  // The short "(Pink)"-style label rendered under a per-colour cell's Qty
  // on the Sheet and its print/PDF export -- so a merged row's own
  // generic label (necessarily a best-effort guess; see
  // _reconstructPerColorRows) never has to be trusted blindly. Shows
  // whatever token(s) survive in the cell's own literal item name after
  // removing every word it shares with the row's label, so the operator
  // can always see exactly which physical item a colour's quantity came
  // from. Empty when the cell's name IS the row's label with nothing left
  // to disambiguate (e.g. a shared/pool item using the literal same name
  // in every colour).
  _cellItemTag(rowLabel, cellItemName) {
    const labelTokens = new Set(
      String(rowLabel || '').split(/[^a-z0-9]+/i).map(t => t.trim().toLowerCase()).filter(Boolean)
    );

    // Split into alternating [token, delimiter, token, delimiter, ...],
    // keeping each ORIGINAL delimiter rather than tokenizing straight to
    // a flat word list -- a two-tone colour like "Red-Blue" must stay
    // "Red-Blue" in the tag, not flatten to "Red Blue" and read as two
    // unrelated leftover words. Consecutive surviving tokens rejoin with
    // their own single hyphen/underscore; a wider field separator
    // ("---") or a dropped token in between starts a new, space-joined
    // segment instead.
    const parts = String(cellItemName || '').split(/([^a-z0-9]+)/i).filter(p => p !== '');
    const segments = [];
    let segment = '';
    for (let i = 0; i < parts.length; i += 2) {
      const token = parts[i];
      if (!token || labelTokens.has(token.toLowerCase())) {
        if (segment) { segments.push(segment); segment = ''; }
        continue;
      }
      if (!segment) {
        segment = token;
      } else {
        const sep = parts[i - 1] || '';
        segment += /^[-_]$/.test(sep) ? `-${token}` : ` ${token}`;
      }
    }
    if (segment) segments.push(segment);
    return segments.join(' ');
  },

  // Detects components that are genuinely ONE shared physical item
  // referenced under more than one colorGroup (e.g. a sticker sheet
  // printed with two colors, consumed by both those colors' recipes) --
  // as opposed to the "same generic component, different literal item per
  // color" case _stripColorSubstring/_matchedColorToken exist for (e.g.
  // "Frame---Red" / "Frame---Blue"). Stripping THIS color's token out of
  // an already-shared item's name is actively harmful: if the color word
  // happens to appear inside the item's own name (e.g. "Backrest Sticker
  // Pink/SeaGreen" under colorGroup "SeaGreen"), stripping leaves a
  // mangled leftover ("...Pink") that no longer matches the OTHER
  // colorGroup's row -- which, having found nothing of ITS OWN color to
  // strip, kept the full raw name -- producing two rows for what is
  // really one item. Shared items are instead matched on their raw,
  // unstripped name, which is already identical across every colorGroup
  // that references them.
  _sharedItemSlotKeys(components) {
    const groupsByKey = new Map();
    (components || []).forEach(c => {
      if (!c.colorGroup || App.Utils.isCommonColorGroup(c.colorGroup) || c.sourceType === 'POOL') return;
      const key = this._itemSlotKey(c.itemName, c.size);
      if (!groupsByKey.has(key)) groupsByKey.set(key, new Set());
      groupsByKey.get(key).add(String(c.colorGroup).trim().toLowerCase());
    });
    const shared = new Set();
    groupsByKey.forEach((groups, key) => { if (groups.size > 1) shared.add(key); });
    return shared;
  },

  // Renders one small table per distinct "color signature" among
  // pool-color-aware components -- items that come from the same
  // upstream process/output item and carry the exact same set of pool
  // colors share one table (e.g. Painted Frame's 11 colors); an item
  // with a different color set gets its own table instead of forcing
  // every item onto one shared, mostly-blank column set. Only the
  // colors actually CHECKED right now in the checklist are rendered as
  // columns -- addMatrixColorColumn/syncPoolColorGroupColumns keep
  // these columns live as the operator checks/unchecks colors.
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
      // Fresh <tbody> element on every render (the container is emptied
      // above), so this gets its own Sortable instance rather than reusing
      // one -- see _initRowSorting.
      this._initRowSorting(document.querySelector(`#${tableId} tbody`));
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

  // Do this table's own columns match a checked color EXACTLY? A pool
  // item's colors are whatever its upstream process credited, and since
  // composite crediting those are themselves composites ("Blue-White /
  // BCP"), identical to the checked color. Token matching must not be
  // used then: it would light up a legacy plain "Blue-White" column
  // instead of the real "Blue-White / BCP" one, and the qty would be
  // saved against a color the lot never produced -- a phantom negative
  // bucket on the plain name. Token matching is still right for the
  // ORIGINAL shape, where a pool item carries plain colors and the OUTPUT
  // color is a composite built by pairing two such axes ("Blue-White"
  // from the frame table, "BCP" from the rim table). So: exact wins when
  // it matches anything at all, tokens are the fallback.
  _poolGroupColumnsMatchExactly(colors, axisKey) {
    const exact = new Set(this._axisScopedCheckedColorQtys(axisKey)
      .filter(cc => cc.qty > 0)
      .map(cc => String(cc.color || '').trim().toLowerCase()));
    return colors.some(c => exact.has(String(c).trim().toLowerCase()));
  },

  _checkedPoolGroupColors(colors, axisKey) {
    if (this._poolGroupColumnsMatchExactly(colors, axisKey)) {
      const exact = new Set(this._axisScopedCheckedColorQtys(axisKey)
        .filter(cc => cc.qty > 0)
        .map(cc => String(cc.color || '').trim().toLowerCase()));
      return colors.filter(c => exact.has(String(c).trim().toLowerCase()));
    }
    const tokensLower = this._checkedColorTokensLower(axisKey);
    return colors.filter(c => tokensLower.has(c.toLowerCase()));
  },

  // The qty-per-unit basis to stamp on one Per-Process Pool Components
  // CELL (both the initial render in _buildPoolColorGroupTable and a
  // later-inserted column in syncPoolColorGroupColumns) so
  // refreshPoolColorGroupCells can keep recomputing that one cell as the
  // checklist's Qty changes. Edit mode rows (see
  // populateComponentsConsumedDirect) carry a PER-COLOR ratio in
  // colorsQtyPerUnit -- this item may have been consumed at a genuinely
  // different rate for one color than another (rounding, wastage, partial
  // batches), and using this color's own derived ratio (rather than
  // whichever color's ratio happened to populate the row's shared
  // `qtyPerUnit` first) keeps a later edit to THIS color's qty scaling
  // correctly instead of borrowing a different color's rate. Falls back to
  // the row's own shared `qtyPerUnit` (a create-mode row's recipe ratio, or
  // an edit-mode row's recipe-seeded default for a color this lot never
  // previously recorded any qty for at all -- see the "seed a table for
  // EVERY pool-color-aware recipe item" block) when no color-specific
  // ratio exists yet.
  _poolCellQtyPerUnit(row, color) {
    if (!row) return undefined;
    const perColor = row.colorsQtyPerUnit ? row.colorsQtyPerUnit[String(color || '').toLowerCase()] : undefined;
    return perColor !== undefined ? perColor : row.qtyPerUnit;
  },

  _poolGroupCellValue(mode, row, color, axisKey) {
    if (mode === 'edit') {
      return row.colorsQty ? row.colorsQty[color.toLowerCase()] : undefined;
    }
    const colorLower = color.toLowerCase();
    const checked = this._axisScopedCheckedColorQtys(axisKey);
    // Exact first -- a composite column must draw only from the one
    // checked color it names, never from every checked color that
    // happens to share a token with it (see _poolGroupColumnsMatchExactly).
    const exactTotal = checked.reduce(
      (sum, cc) => (String(cc.color || '').trim().toLowerCase() === colorLower ? sum + cc.qty : sum), 0);
    const total = exactTotal > 0 ? exactTotal : checked.reduce((sum, cc) => {
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
      const cellsHtml = visibleColors.map(col => {
        const qty = this._poolGroupCellValue(mode, r, col, axisKey);
        const display = (qty !== undefined && qty !== null) ? this.formatQty(qty) : '';
        const cellQtyPerUnit = this._poolCellQtyPerUnit(r, col);
        const qtyPerUnitAttr = (cellQtyPerUnit !== undefined) ? ` data-qty-per-unit="${cellQtyPerUnit}"` : '';
        return `<td><input type="number" class="form-control text-end matrix-qty pool-group-qty" data-color="${escapeHtml(col)}"${qtyPerUnitAttr} min="0" step="any" value="${display}"></td>`;
      }).join('');
      return `
        <tr id="${rowId}" data-row-idx="${rowIdx}">
          ${this._dragCellHtml()}
          <td>
            <select class="form-select prod-comp-item-select" required>
              <option value=""></option>
              ${preSelectedOption}
            </select>
          </td>
          <td><input type="text" class="form-control prod-comp-size" value="${escapeHtml(r.size || '')}" placeholder="-" readonly></td>
          <!-- Editable, like the Narration on every other component table in
               this form. It was read-only on the grounds that a Warehouse
               Pool output item has no Items Master entry to derive a
               narration from -- but that is precisely why it needs to be
               typed here: nothing else can supply one, so the field could
               only ever show whatever the Process recipe happened to store
               and the operator had no way to describe a pool component on
               this lot. serializePoolColorGroups already reads this input,
               so what is typed is saved; and _with_master_narration only
               overwrites a component whose name+size Items Master actually
               knows, which by definition is not a pool output item -- so an
               edit here survives the save rather than being stamped over. -->
          <td><input type="text" class="form-control prod-comp-narration" value="${escapeHtml(r.narration || '')}" placeholder="-" title="Describe this pool component for the printed sheet — pre-filled from the Process recipe"></td>
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
                <!-- Reorder grip column -- FIRST, and mirrored by
                     _dragCellHtml() in every body row above, because
                     syncPoolColorGroupColumns addresses this table's color
                     cells by their position among these header children. -->
                <th scope="col" style="width: 3%;"><span class="visually-hidden">Reorder rows</span></th>
                <th style="width: 18%;">Item / Pool Name</th>
                <th style="width: 7%;">Size</th>
                <th style="width: 13%;">Narration</th>
                <th style="width: 11%;">Source</th>
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

      // Must use the SAME exact-wins-then-tokens rule the first render used
      // (_checkedPoolGroupColors), not raw token matching. Token matching
      // alone is wrong whenever this pool item's own colors are already
      // composites ("Blue-White / BCP") -- the checked color IS the column
      // name, but splitting it yields {"blue-white", "bcp"}, neither of
      // which equals the full column string, so every real composite
      // column was dropped here and only a legacy plain column that
      // happened to equal one token survived. Since this resync runs after
      // every checkbox toggle, it overwrote the correct initial render.
      const wantLower = new Set(
        this._checkedPoolGroupColors(def.colors, def.axisKey).map(c => c.toLowerCase()));

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
          // Stamped for BOTH modes (see _poolCellQtyPerUnit) -- an edit-mode
          // row's own per-color ratio (or its recipe-seeded fallback) lets
          // refreshPoolColorGroupCells keep recomputing this newly-added
          // column as the checklist's Qty changes, same as every column
          // already visible when the table first rendered. Previously gated
          // to 'create' only, which left a color newly checked mid-edit
          // permanently stuck blank no matter what qty the operator typed
          // into the checklist.
          const cellQtyPerUnit = rowObj ? this._poolCellQtyPerUnit(rowObj, matchColor) : undefined;
          const qtyPerUnitAttr = (cellQtyPerUnit !== undefined) ? ` data-qty-per-unit="${cellQtyPerUnit}"` : '';
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
    this._updateColorCombinationPreview();
  },

  _applyQtyPerUnit(rowSelector, multiplier) {
    document.querySelectorAll(rowSelector).forEach(row => {
      const qtyPerUnit = row.dataset.qtyPerUnit;
      if (qtyPerUnit === undefined || qtyPerUnit === '') return;
      const qtyInput = row.querySelector('.prod-comp-qty');
      if (qtyInput) qtyInput.value = this.formatQty(multiplier * toNumber(qtyPerUnit));
    });
  },

  // Live preview of this lot's own combined output identity, mirroring the
  // same unambiguous-pairing rule the backend's Warehouse Pool crediting
  // uses to decide the actual saved/credited bucket color -- shown here so
  // the operator sees "Blue-White / Black / BCP" while still filling in
  // the form, not just after saving. A redundant axis (its checked value
  // name-matches the primary, e.g. Mudguard "Red" against Frame
  // "Red-White") is excluded from the combination the same way the
  // backend excludes it. Any number of independent axes combine as long
  // as each contributes exactly one checked color; if some axis has 2+
  // (no way to tell which pairs with which), this shows each axis's own
  // colors instead of guessing at one combined string.
  _updateColorCombinationPreview() {
    const el = document.getElementById('productionColorCombinationPreview');
    if (!el) return;

    const checked = this.getCheckedColorQtys().filter(c => c.qty > 0 && c.color);
    const primaryEntries = checked.filter(c => c.countsTowardTotal !== false);
    const otherEntries = checked.filter(c => c.countsTowardTotal === false);

    if (primaryEntries.length === 0) {
      el.style.display = 'none';
      el.innerText = '';
      return;
    }

    const primaryColors = primaryEntries.map(e => e.color);
    // An entry that exactly equals one segment of a COMPOSITE primary is
    // an inherited-segment collision, not a mirror -- it belongs to a
    // different axis that merely shares the name. Everything else that
    // name-matches a primary color is the same batch described twice.
    const inheritedSegments = new Set();
    primaryColors.forEach(pc => {
      const segs = String(pc || '').split(' / ').map(s => s.trim()).filter(Boolean);
      if (segs.length < 2) return;
      segs.forEach(s => inheritedSegments.add(s.toLowerCase()));
    });
    const independent = otherEntries.filter(e => {
      if (inheritedSegments.has(String(e.color || '').trim().toLowerCase())) return true;
      return !primaryColors.some(pc => this._colorNamesMatch(pc, e.color));
    });

    const axisCounts = new Map();
    independent.forEach(e => {
      const key = String(e.axisKey || '').trim().toLowerCase() || '__no_axis_key__';
      axisCounts.set(key, (axisCounts.get(key) || 0) + 1);
    });
    const ambiguous = Array.from(axisCounts.values()).some(c => c > 1);

    el.style.display = '';
    if (ambiguous) {
      el.innerText = `Now producing: ${primaryColors.join(', ')} — plus ${independent.length} other color(s) tracked separately (can't combine unambiguously)`;
    } else {
      // One combined identity per primary color, each listing its axes in
      // the order this process's recipe declares them -- the checklist
      // renders axes in that same order, so reading the checked rows top
      // to bottom reproduces exactly what the backend will credit.
      const axisPos = new Map();
      $$('#productionColorChecklist .production-color-row').forEach((row, i) => {
        const k = String(row.dataset.group || '').trim().toLowerCase();
        if (k && !axisPos.has(k)) axisPos.set(k, i);
      });
      const posOf = (e) => {
        const k = String(e.axisKey || '').trim().toLowerCase();
        return axisPos.has(k) ? axisPos.get(k) : Number.MAX_SAFE_INTEGER;
      };
      const combos = primaryEntries.map(pe =>
        [pe].concat(independent).sort((a, b) => posOf(a) - posOf(b))
          .map(e => e.color).join(' / '));
      el.innerText = `Now producing: ${combos.join(', ')}`;
    }
  },

  // ── Per-Color Components matrix ───────────────────────────────────────
  // Auto-populated by populateColorMatrixForColors (recipe rows tagged
  // with a real colorGroup, or a Common item merged with an explicit
  // per-color sibling elsewhere in the recipe -- see
  // _getCommonItemsWithColorOverride), and extendable by hand via
  // "+ Add Per-Color Component" for a one-off case the recipe doesn't
  // define.

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
    return Array.from(headerRow.children).findIndex(th => App.Utils.sameColor(th.dataset.color, color));
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
    this._refreshMatrixColumnLabels();
    this._syncMatrixTableMinWidth();
  },

  removeMatrixColorColumn(color) {
    // Another axis's own same-named color may still be checked (two
    // independent axes can legitimately share a literal color name, e.g.
    // a Rim axis and a Frame axis both having "Purple") -- this matrix's
    // column is shared (keyed by color string only, see
    // getMatrixColumnIndex), so removing it here whenever THIS axis's row
    // gets unchecked would wipe cells still in use by that other, still-
    // checked axis. By the time this fires, the row that was just
    // unchecked no longer shows up in getCheckedColorQtys(), so "still
    // checked" here can only mean a different row/axis needs it.
    const colorLower = String(color || '').toLowerCase();
    const stillCheckedElsewhere = this.getCheckedColorQtys().some(cc => (cc.color || '').toLowerCase() === colorLower);
    if (stillCheckedElsewhere) return;

    this._removeMatrixColumnAt(this.getMatrixColumnIndex(color));
  },

  // Raw "drop column N" -- no still-checked-elsewhere guard, so callers
  // that have already decided a column must go (removeMatrixColorColumn
  // above, _pruneRedundantMatrixColumns below) share one implementation.
  _removeMatrixColumnAt(idx) {
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
    this._refreshMatrixColumnLabels();
    this._syncMatrixTableMinWidth();
  },

  // A non-primary Color Axis row that segment-matches a checked primary
  // row (e.g. a "Blue" mudguard auto-checked by a "Blue-White / BCP"
  // frame) describes the SAME physical units as its primary counterpart.
  // It must not also get its own Per-Color Components column: the
  // operator is left staring at one duplicate column per matched color,
  // and anything typed into one debits stock a second time for units the
  // primary column already accounts for. Their real consumption lives in
  // that axis's own Per-Process Pool Components table instead -- so this
  // unconditionally prunes the redundant column, even one the operator
  // already typed into (strict checked-only columns; direct manual
  // unchecking of a color already clears its own column the same way via
  // removeMatrixColorColumn).
  _pruneRedundantMatrixColumns() {
    const checked = $$('#productionColorChecklist .production-color-row')
      .filter(row => row.querySelector('.production-color-check')?.checked);

    checked
      .filter(row => row.dataset.primary === 'false')
      .map(row => row.dataset.color)
      // A primary row -- or a flat/legacy row, which carries no
      // data-primary at all -- owning this same column name means the
      // column is genuinely that row's, so it stays no matter what this
      // non-primary row is doing.
      .filter(color => !checked.some(r =>
        r.dataset.primary !== 'false' && App.Utils.sameColor(r.dataset.color, color)))
      .filter(color => this._matchingPrimaryColorQty(color) !== null)
      .forEach(color => {
        const idx = this.getMatrixColumnIndex(color);
        if (idx !== -1) this._removeMatrixColumnAt(idx);
      });
  },

  // Per-Color Components matrix column headers are shown with whatever
  // segments differ from the OTHER checked columns, not the full
  // composite -- e.g. with Blue-White / BCP, Pink-White / BCP, Purple-
  // White / BCP and Red-White / BCP all checked, "BCP" is shared context,
  // not identity: the columns read Blue-White, Pink-White, Purple-White,
  // Red-White, and the full composite stays available on hover. Nothing
  // is dropped from the data, only from the label. Recomputed on every
  // add/remove because which segments are shared depends on the whole
  // checked set. A single column has nothing to differentiate against, so
  // it keeps its full composite.
  _refreshMatrixColumnLabels() {
    const headerRow = document.getElementById('productionColorMatrixHeaderRow');
    if (!headerRow) return;
    const ths = Array.from(headerRow.querySelectorAll('th[data-color]'));
    const segLists = ths.map(th => String(th.dataset.color || '')
      .split(' / ').map(x => x.trim()).filter(Boolean));
    const commonLower = new Set();
    if (segLists.length > 1) {
      segLists[0].forEach(seg => {
        const segLower = seg.toLowerCase();
        if (segLists.every(list => list.some(x => x.toLowerCase() === segLower))) commonLower.add(segLower);
      });
    }
    ths.forEach((th, i) => {
      const kept = segLists[i].filter(x => !commonLower.has(x.toLowerCase()));
      th.textContent = kept.length > 0 ? kept.join(' / ') : String(th.dataset.color || '');
      th.title = String(th.dataset.color || '');
    });
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
    const narration = (comp && comp.narration) || '';
    const sourceType = (comp && comp.sourceType === 'POOL') ? 'POOL' : 'ITEM';
    const colors = this.getMatrixColors();

    const colorCellsHtml = colors
      .map(() => '<td><select class="form-select form-select-sm prod-comp-item-select mb-1"><option value=""></option></select>'
        + '<input type="number" class="form-control form-control-sm text-end matrix-qty" min="0" step="any" value=""></td>')
      .join('');

    const rowHtml = `
      <tr id="${rowId}" data-merged="true">
        ${this._dragCellHtml()}
        <td><input type="text" class="form-control prod-comp-display-name" value="${escapeHtml(itemName)}" readonly title="Merged across colors — each color cell below has its own item picker"></td>
        <td><input type="text" class="form-control prod-comp-size" value="${escapeHtml(size)}" placeholder="-"></td>
        <td><input type="text" class="form-control prod-comp-narration" value="${escapeHtml(narration)}" placeholder="-" title="Shared across this row's colors, even though each color cell may secretly use a different literal item"></td>
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
    this._initRowSorting(tbody);
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
    const narration = (comp && comp.narration) || '';
    const sourceType = (comp && comp.sourceType === 'POOL') ? 'POOL' : 'ITEM';
    const preSelectedOption = this._buildItemPreselectOption(itemName, size, sourceType);

    const colorCellsHtml = this.getMatrixColors()
      .map(() => `<td><input type="number" class="form-control text-end matrix-qty" min="0" step="any" value=""></td>`)
      .join('');

    const rowHtml = `
      <tr id="${rowId}">
        ${this._dragCellHtml()}
        <td>
          <select class="form-select prod-comp-item-select" required>
            <option value=""></option>
            ${preSelectedOption}
          </select>
        </td>
        <td><input type="text" class="form-control prod-comp-size" value="${escapeHtml(size)}" placeholder="-" onchange="App.Production.handleProdSizeChange(this)"></td>
        <td><input type="text" class="form-control prod-comp-narration" value="${escapeHtml(narration)}" placeholder="-"></td>
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
    this._initRowSorting(tbody);
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
      const sharedItemKeys = this._sharedItemSlotKeys(all);

      colors.forEach(color => {
        const colIndex = this.getMatrixColumnIndex(color);
        // Summed across every axis sharing this literal color name, not just
        // `axisKey` -- see _totalQtyForColorName. Toggling one axis's color
        // must not stomp another axis's already-recorded contribution to
        // the same shared matrix column.
        const thisColorQty = this._totalQtyForColorName(color);

        if (colIndex !== -1) {
          // Token match, not whole-string: a recipe row scoped to
          // "Blue-White" is genuinely consumed by a lot producing the
          // composite "Blue-White / BCP". See _matchedColorToken.
          const colorComps = all
            .map(c => ({ comp: c, token: this._matchedColorToken(c.colorGroup, color) }))
            .filter(x => x.token)
            .map(({ comp, token }) => ({
              ...comp,
              displayName: sharedItemKeys.has(this._itemSlotKey(comp.itemName, comp.size))
                ? (comp.itemName || '').trim()
                : this._stripColorSubstring(comp.itemName || '', token)
            }));

          colorComps.forEach(c => {
            let row = this.findMatrixRowByDisplayName(c.displayName, c.size || '');
            // Live from Items Master, looked up against the LITERAL item
            // name/size (c.itemName), not the color-stripped c.displayName
            // used as the row's own key -- see _resolveDisplayNarration.
            if (!row) row = this.addMergedMatrixRow({ itemName: c.displayName, size: c.size, sourceType: c.sourceType, narration: this._resolveDisplayNarration(c.itemName, c.size, c.narration) });
            const cell = row.children[colIndex];
            const qty = thisColorQty > 0 ? thisColorQty * c.qtyPerUnit : c.qtyPerUnit;
            this._setMergedCellItem(cell, { itemName: c.itemName, size: c.size, sourceType: c.sourceType }, qty, c.qtyPerUnit);
          });

          const overriddenKeys = new Set(colorComps.map(c => this._itemSlotKey(c.displayName, c.size)));
          commonOverrideComps.forEach(c => {
            if (overriddenKeys.has(this._itemSlotKey(c.itemName, c.size))) return;
            let row = this.findMatrixRowByDisplayName(c.itemName, c.size || '');
            // Live from Items Master -- see _resolveDisplayNarration.
            if (!row) row = this.addMergedMatrixRow({ itemName: c.itemName, size: c.size, sourceType: c.sourceType, narration: this._resolveDisplayNarration(c.itemName, c.size, c.narration) });
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
    container.querySelectorAll('table.prod-color-table').forEach(table => {
      const tableAxisKey = table.dataset.axisKey || '';
      if (axisKey && tableAxisKey && axisKey !== tableAxisKey) return;
      const checkedColorQtys = this._axisScopedCheckedColorQtys(tableAxisKey);
      table.querySelectorAll('.pool-group-qty').forEach(input => {
        const inputColorLower = String(input.dataset.color || '').trim().toLowerCase();
        if (!inputColorLower) return;
        const qtyPerUnit = input.dataset.qtyPerUnit;
        if (qtyPerUnit === undefined || qtyPerUnit === '') return;

        const exactTotal = checkedColorQtys.reduce(
          (sum, cc) => (String(cc.color || '').trim().toLowerCase() === inputColorLower ? sum + cc.qty : sum), 0);

        const total = exactTotal > 0 ? exactTotal : checkedColorQtys.reduce((sum, cc) => {
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
      // One shared Narration per row, even for a merged row whose color
      // cells are secretly different literal items -- same simplification
      // as the row's own read-only display name (see addMergedMatrixRow).
      const narration = row.querySelector('.prod-comp-narration')?.value.trim() || '';
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
        components.push({ itemName, size, narration, color: '', sourceType, qty, colorGroup: color });
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
      const narration = row.querySelector('.prod-comp-narration')?.value.trim() || '';

      row.querySelectorAll('.pool-group-qty').forEach(input => {
        const qty = toNumber(input.value);
        if (qty <= 0) return;
        const color = input.dataset.color || '';
        if (!color) return;
        components.push({ itemName, size, narration, color: '', sourceType: 'POOL', qty, colorGroup: color });
      });
    });
    return components;
  },

  // ── Edit-mode restoration for a lot whose saved Components Consumed
  // used the Matrix/Pool Color Group tables ─────────────────────────────
  // Populates the Common table + Per-Color matrix + Per-Process Pool
  // tables directly from a saved lot's actual recorded Components
  // Consumed (not recipe defaults) -- used when editing an existing
  // multi-color batch. Item/qty/color come from that saved snapshot, but
  // Narration is still re-resolved live against Items Master (see
  // _resolveDisplayNarration) rather than the snapshot's own possibly
  // stale value -- otherwise reopening an old lot for edit kept showing
  // whatever Narration Items Master had back when the lot was first
  // logged, even after it was corrected there since. A legacy lot saved
  // before this item was recognized as pool-color-aware (one combined
  // Common-tagged row) is upgraded on the fly: its quantity is split
  // evenly across this lot's colors as a starting point, with a toast
  // telling the operator to adjust and re-save.
  async populateComponentsConsumedDirect(components, breakdown) {
    // `breakdown` is a colorBreakdown array -- {color, qty} objects, NOT
    // color-name strings. filter(Boolean) because an entry can legitimately
    // reach here with no color name (the same guard the caller applies when
    // it builds breakdownColors): such an entry can't be matched by any
    // component's colorGroup and can't be rendered as a column, so it must
    // not become an `undefined` matrix column. lotTotalQty deliberately
    // still counts every entry -- it is the lot's total quantity, and
    // dropping a malformed entry's qty from it would silently change the
    // COMMON ratios of an already-suspect lot rather than surface it.
    const colors = (breakdown || []).map(b => b.color).filter(Boolean);
    const lotTotalQty = (breakdown || []).reduce((sum, b) => sum + (b.countsTowardTotal !== false ? (b.qty || 0) : 0), 0);

    this.clearComponentsTable();
    this.clearColorMatrix();
    colors.forEach(c => this.addMatrixColorColumn(c));

    const processId = document.getElementById('productionProcessId')?.value;
    const poolColorMap = processId ? await this.getPoolColorAwareItemNames(processId) : new Map();
    let upgradedAny = false;
    let upgradedCommonOverride = false;
    const poolGroupAccum = new Map();

    const commonOverrideComps = this._getCommonItemsWithColorOverride(components || []);
    // Per-color, non-pool-aware, non-override components are collected
    // here rather than placed on a matrix row immediately -- which row
    // each one belongs to is decided AFTER every one has been seen, by
    // _reconstructPerColorRows (see below).
    const mergedRowEntries = [];

    (components || []).forEach(c => {
      const colorGroup = c.colorGroup || 'COMMON';

      let derivedQtyPerUnit = 1;
      if (App.Utils.isCommonColorGroup(colorGroup)) {
        derivedQtyPerUnit = lotTotalQty > 0 ? (c.qty / lotTotalQty) : 0;
      } else {
        // sameColor, not raw .toLowerCase() === : that crashed outright on a
        // breakdown entry with no color (see the filter above), and bypassed
        // the one place color equality is allowed to be decided. sameColor
        // is null-safe, so a malformed entry now simply fails to match
        // instead of taking down the whole Edit-Lot reopen.
        const b = (breakdown || []).find(entry => App.Utils.sameColor(entry.color, colorGroup));
        const colorQty = b ? b.qty : 0;
        derivedQtyPerUnit = colorQty > 0 ? (c.qty / colorQty) : 0;
      }

      const isPoolColorAware = c.sourceType === 'POOL'
        && (poolColorMap.get((c.itemName || '').trim().toLowerCase()) || []).length > 1;

      if (isPoolColorAware) {
        const key = `${(c.itemName || '').toLowerCase()}|${(c.size || '').toLowerCase()}`;
        let entry = poolGroupAccum.get(key);
        if (!entry) {
          // colorsQtyPerUnit holds each color's OWN derived ratio (see
          // _poolCellQtyPerUnit) -- the shared `qtyPerUnit` alongside it is
          // only ever a fallback for a color this lot has no history for yet
          // (a brand-new column checked mid-edit), not the value actually
          // used to redisplay/recompute any color that DOES have its own
          // entry below.
          entry = { itemName: c.itemName, size: c.size, narration: this._resolveDisplayNarration(c.itemName, c.size, c.narration), sourceType: c.sourceType, colorsQty: {}, colorsQtyPerUnit: {}, qtyPerUnit: derivedQtyPerUnit };
          poolGroupAccum.set(key, entry);
        } else if (entry.qtyPerUnit === undefined) {
          entry.qtyPerUnit = derivedQtyPerUnit;
        }

        if (App.Utils.isCommonColorGroup(colorGroup)) {
          upgradedAny = true;
          const perColorQty = colors.length > 0 ? c.qty / colors.length : c.qty;
          colors.forEach(color => {
            entry.colorsQty[color.toLowerCase()] = perColorQty;
            entry.colorsQtyPerUnit[color.toLowerCase()] = derivedQtyPerUnit;
          });
          entry.qtyPerUnit = derivedQtyPerUnit;
        } else {
          entry.colorsQty[colorGroup.toLowerCase()] = c.qty;
          // This color's OWN ratio (c.qty / this color's own breakdown qty),
          // not whichever color happened to create `entry` first -- two
          // colors of the same pool item can legitimately have been
          // consumed at different rates (rounding, partial batches), and a
          // shared row-level ratio previously made editing one color's
          // checklist Qty silently recompute using a DIFFERENT color's rate.
          entry.colorsQtyPerUnit[colorGroup.toLowerCase()] = derivedQtyPerUnit;
        }
        return;
      }

      if (commonOverrideComps.includes(c)) {
        upgradedCommonOverride = true;
        const overriddenColors = new Set(
          (components || [])
            .filter(o => o.colorGroup && !App.Utils.isCommonColorGroup(o.colorGroup) &&
              this._itemSlotKey(this._stripColorSubstring(o.itemName || '', o.colorGroup), o.size) === this._itemSlotKey(c.itemName, c.size))
            .map(o => o.colorGroup)
        );
        const fallbackColors = colors.filter(col => !overriddenColors.has(col));
        const perColorQty = fallbackColors.length > 0 ? c.qty / fallbackColors.length : c.qty;
        let row = this.findMatrixRowByDisplayName(c.itemName, c.size || '');
        if (!row) row = this.addMergedMatrixRow({ itemName: c.itemName, size: c.size, narration: this._resolveDisplayNarration(c.itemName, c.size, c.narration), sourceType: c.sourceType });
        fallbackColors.forEach(col => {
          const colIndex = this.getMatrixColumnIndex(col);
          if (colIndex === -1) return;
          const cell = row.children[colIndex];
          this._setMergedCellItem(cell, { itemName: c.itemName, size: c.size, sourceType: c.sourceType }, perColorQty, derivedQtyPerUnit);
        });
        return;
      }

      // Which of this lot's own (possibly composite) breakdown colors this
      // component's colorGroup belongs to -- same token-vs-composite
      // matching populateColorMatrixForColors already uses (see
      // _matchedColorToken): a lot's checked color is often a COMPOSITE of
      // the axes it combines ("Blue-White / BCP"), while a saved component
      // is tagged with just ONE axis's own color ("Blue-White"). Matching
      // the whole composite string verbatim (colors.includes(colorGroup))
      // never hits for a composite-color lot, so every one of its per-color
      // components would silently fall through to the addComponentRow
      // branch below instead -- reopening such a lot for Edit made the
      // Per-Color Components table look like it never loaded at all, even
      // though the same lot's fresh-create path
      // (populateColorMatrixForColors) rendered it correctly.
      const matchedColors = colors.filter(col => this._matchedColorToken(colorGroup, col));

      if (App.Utils.isCommonColorGroup(colorGroup) || matchedColors.length === 0) {
        const isLockedPoolColor = c.sourceType === 'POOL' && !App.Utils.isCommonColorGroup(colorGroup);
        this.addComponentRow({
          itemName: c.itemName,
          size: c.size,
          narration: this._resolveDisplayNarration(c.itemName, c.size, c.narration),
          sourceType: c.sourceType,
          qty: c.qty,
          qtyPerUnit: derivedQtyPerUnit,
          color: isLockedPoolColor ? colorGroup : c.color,
          colorScope: isLockedPoolColor ? colorGroup : undefined,
          unit: c.unit
        });
        return;
      }
      // Explicitly color-tagged, not pool-color-aware: a genuinely
      // different literal item per color (e.g. "Frame---Red" /
      // "Frame---Blue") -- belongs on a merged row, one real item picker
      // per color cell. Which entries share a row is worked out below,
      // once every per-color component has been seen.
      mergedRowEntries.push({ colorGroup, comp: c, matchedColors, derivedQtyPerUnit });
    });

    // Reconstruct rows from every collected per-color component (position
    // across each colour's own list, not just name-stripping -- see
    // _reconstructPerColorRows for why: a "Teddy Basket" can be a literal
    // RED item under colour Blue and a literal BLUE item under colour Red,
    // and name-stripping alone never catches that), then materialize each
    // as one merged matrix <tr>. Every matched composite colour of a cell
    // is filled, not just the first -- both tokens of a composite legitimately
    // apply at once (mirrors populateColorMatrixForColors and
    // save_production's own server-side rule).
    const mergedEntries = mergedRowEntries.map(e => ({
      colorKey: e.colorGroup, itemName: e.comp.itemName || '', size: e.comp.size || '',
      narration: e.comp.narration || '', unit: e.comp.unit || '', qty: e.comp.qty, __src: e
    }));
    this._reconstructPerColorRows(mergedEntries).forEach(rowData => {
      const primary = rowData.cells[0];
      const displayName = this._rowDisplayName(rowData);
      let row = this.findMatrixRowByDisplayName(displayName, rowData.size || '');
      if (!row) row = this.addMergedMatrixRow({ itemName: displayName, size: rowData.size, narration: this._resolveDisplayNarration(primary.itemName, rowData.size, rowData.narration), sourceType: primary.__src.comp.sourceType });
      rowData.cells.forEach(cell => {
        const src = cell.__src;
        src.matchedColors.forEach(col => {
          const colIndex = this.getMatrixColumnIndex(col);
          if (colIndex === -1) return;
          const cellEl = row.children[colIndex];
          this._setMergedCellItem(cellEl, { itemName: src.comp.itemName, size: src.comp.size, sourceType: src.comp.sourceType }, src.comp.qty, src.derivedQtyPerUnit);
        });
      });
    });

    // Seed a table for EVERY pool-color-aware recipe item, not just ones
    // this saved lot happened to use before -- otherwise checking a
    // color belonging to an axis/item this lot never used previously
    // has no table to land in at all.
    if (processId) {
      const recipeRes = await this._fetchProcessComponents(processId);
      const recipeComps = recipeRes.success ? (recipeRes.data || []) : [];
      recipeComps
        .filter(c => c.sourceType === 'POOL' && (!c.colorGroup || App.Utils.isCommonColorGroup(c.colorGroup)))
        .forEach(c => {
          const itemColors = poolColorMap.get((c.itemName || '').trim().toLowerCase()) || [];
          if (itemColors.length <= 1) return;
          const key = `${(c.itemName || '').toLowerCase()}|${(c.size || '').toLowerCase()}`;
          if (!poolGroupAccum.has(key)) {
            // No qty history at all for this item on this lot yet -- fall
            // back to the recipe's own qtyPerUnit (same basis Create mode
            // suggests) so a color checked mid-edit still gets a useful
            // starting estimate via _poolCellQtyPerUnit's row-level
            // fallback, instead of staying permanently blank until the
            // operator types directly into the pool cell.
            poolGroupAccum.set(key, { itemName: c.itemName, size: c.size, narration: this._resolveDisplayNarration(c.itemName, c.size, c.narration), sourceType: c.sourceType, colorsQty: {}, colorsQtyPerUnit: {}, qtyPerUnit: c.qtyPerUnit });
          }
        });
    }

    this.renderPoolColorGroupsFromAccum(Array.from(poolGroupAccum.values()), poolColorMap);

    if (upgradedAny && upgradedCommonOverride) {
      App.Utils.showToast('This lot had a pool item and a Common item now tracked per-color, both split evenly across colors as a starting point — adjust each color\'s quantity to match what was actually used, then save.', false);
    } else if (upgradedAny) {
      App.Utils.showToast('This lot had a pool item now tracked per-color split evenly across colors as a starting point — adjust each color\'s quantity to match what was actually used, then save.', false);
    } else if (upgradedCommonOverride) {
      App.Utils.showToast('This lot had a Common item that\'s really the same part as one of its per-color siblings — merged into one row, split evenly across colors as a starting point; adjust each color\'s quantity to match what was actually used, then save.', false);
    }
  },

  // Same grouping/rendering as renderPoolColorSplitGroups, but for the
  // Edit Lot path: cells show this lot's actual saved qty per
  // (item, color) instead of a recipe-suggested estimate. `entries` is
  // [{ itemName, size, sourceType, colorsQty: { colorLower: qty } }],
  // built by populateComponentsConsumedDirect from the saved
  // Components Consumed array.
  renderPoolColorGroupsFromAccum(entries, poolColorMap) {
    const wrapper = document.getElementById('productionPoolColorGroupsWrapper');
    const container = document.getElementById('productionPoolColorGroupsContainer');
    if (!container) return;

    container.querySelectorAll('tr').forEach(row => this.destroyComponentItemSelect2(row));
    container.innerHTML = '';
    this._poolColorGroupDefs = [];

    if (!entries || entries.length === 0) {
      if (wrapper) wrapper.style.display = 'none';
      return;
    }
    if (wrapper) wrapper.style.display = '';

    const groups = new Map();
    entries.forEach(entry => {
      const itemColors = poolColorMap.get((entry.itemName || '').trim().toLowerCase()) || [];
      const signature = itemColors.slice().sort((a, b) => a.localeCompare(b)).join('|').toLowerCase();
      if (!groups.has(signature)) groups.set(signature, { colors: itemColors, entries: [] });
      groups.get(signature).entries.push(entry);
    });

    let groupIdx = 0;
    groups.forEach(({ colors: groupColors, entries: groupEntries }) => {
      groupIdx++;
      const tableId = `productionPoolColorGroup_${groupIdx}`;
      const axisKey = this._axisKeyForPoolItemNames(groupEntries.map(e => e.itemName));
      this._poolColorGroupDefs.push({ tableId, colors: groupColors, rows: groupEntries, mode: 'edit', axisKey });
      // Strictly checked-only, same helper (and same exact-wins-then-tokens
      // rule) the Create-mode path uses -- a previously-saved-but-now-
      // unchecked color no longer keeps its column visible on reopen.
      const visibleColors = this._checkedPoolGroupColors(groupColors, axisKey);
      container.insertAdjacentHTML('beforeend', this._buildPoolColorGroupTable(tableId, groupColors, visibleColors, groupEntries, 'edit', axisKey));
      document.querySelectorAll(`#${tableId} tbody tr`).forEach(row => this.initComponentItemSelect2(row));
      // Fresh <tbody> element on every render (the container is emptied
      // above), so this gets its own Sortable instance rather than reusing
      // one -- see _initRowSorting.
      this._initRowSorting(document.querySelector(`#${tableId} tbody`));
    });
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

  // `comp.colorScope`, when set, locks this row's Color field to a
  // single real Color Master name (e.g. a Pool-sourced item that only
  // ever exists in one color, like "Fitted Rim" -> "Black") so the row
  // debits that exact Warehouse Pool bucket instead of the blank/COMMON
  // one -- see _readProdComponentRow, which reads it via dataset.colorScope.
  addComponentRow(comp = null) {
    const tbody = document.getElementById('productionComponentsBody');
    if (!tbody) return;

    const rowId = 'prod_comp_row_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    const itemName = (comp && comp.itemName) || '';
    const size = (comp && comp.size) || '';
    const narration = (comp && comp.narration) || '';
    const sourceType = (comp && comp.sourceType === 'POOL') ? 'POOL' : 'ITEM';
    const color = (comp && comp.color) || '';
    const colorScope = (comp && comp.colorScope) || '';
    // comp === null means a brand-new row from "+ Add Component" -- no
    // recipe or saved data behind it. Assume it consumes 1 unit of itself
    // per unit of lot output (same shape as a qtyPerUnit=1 recipe row) so
    // it starts pre-filled at the current lot qty/color total instead of
    // blank, and keeps auto-tracking that total afterward via
    // _applyQtyPerUnit -- same as every recipe-derived row. Any other
    // caller passing a comp object (even with qtyPerUnit undefined, e.g. a
    // saved lot's recorded consumption) keeps its exact prior blank/fixed-
    // qty behavior; that data is real and must not be silently overwritten
    // by a recompute.
    const qtyPerUnit = comp === null ? 1 : (comp && comp.qtyPerUnit);
    const manualMultiplier = comp === null ? this._currentComponentQtyMultiplier() : 0;
    const qty = comp === null
      ? this.formatQty(manualMultiplier > 0 ? manualMultiplier * qtyPerUnit : qtyPerUnit)
      : (comp && comp.qty !== undefined ? this.formatQty(comp.qty) : '');
    const qtyPerUnitAttr = (qtyPerUnit !== undefined) ? `data-qty-per-unit="${qtyPerUnit}"` : '';
    const unitAttr = (comp && comp.unit) ? ` data-unit="${escapeHtml(comp.unit)}"` : '';
    const colorScopeAttr = colorScope ? ` data-color-scope="${escapeHtml(colorScope)}"` : '';
    const preSelectedOption = this._buildItemPreselectOption(itemName, size, sourceType);
    const colorReadonlyAttrs = colorScope ? ' readonly title="This item only exists in this one Warehouse Pool color — fixed automatically"' : '';

    const rowHtml = `
      <tr id="${rowId}" ${qtyPerUnitAttr}${unitAttr}${colorScopeAttr}>
        ${this._dragCellHtml()}
        <td>
          <select class="form-select prod-comp-item-select" required>
            <option value=""></option>
            ${preSelectedOption}
          </select>
        </td>
        <td><input type="text" class="form-control prod-comp-size" value="${escapeHtml(size)}" placeholder="-" onchange="App.Production.handleProdSizeChange(this)"></td>
        <td><input type="text" class="form-control prod-comp-narration" value="${escapeHtml(narration)}" placeholder="-"></td>
        <td><input type="text" class="form-control prod-comp-color" list="colorList" value="${escapeHtml(color)}" placeholder="All colors"${colorReadonlyAttrs}></td>
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
    this._initRowSorting(tbody);
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

  // Searchable Select2 for ONE color cell's item picker inside a merged
  // matrix row (see addMergedMatrixRow) -- every color column gets its own
  // picker since each color secretly uses a different real item.
  initMergedCellItemSelect2(selectEl) {
    this._wireItemSelect2(selectEl);
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
      // Narration is shown/autofilled from Item Master for this exact
      // item+size, matching what a recipe's own component rows already
      // get -- see _refillNarrationForRow. No-ops for a Pool row (no Item
      // Master entry to look up). selectEl (not just the row) is passed
      // explicitly since a merged row's color cells each have their own
      // item-select sharing one row-level Narration field.
      App.Production._refillNarrationForRow(row, selectEl);
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

    // Same advisory hint, one level up: the Colors to Produce checklist's
    // own per-color availability. Kept here (rather than only at render
    // time) so it stays in step with the component rows' hints, and so a
    // checklist row backed by a plain ITEM input picks up the Stock this
    // call just loaded. Never throws -- see its own catch.
    await this.refreshColorChecklistAvailability(processId);
  },

  // Fired when a component row's Size is typed/changed by hand (the Item
  // picker itself only carries a name, so Size is this row's own
  // free-text field, not a per-item dropdown). Re-syncs Narration to Item
  // Master for this exact item+size, same as picking the item fresh
  // would, then refreshes the availability hint as before.
  handleProdSizeChange(input) {
    this._refillNarrationForRow(input?.closest('tr'));
    this.refreshPoolAvailability();
  },

  // Looks up this row's current item+size in Item Master and syncs its
  // Narration field to match. No-ops for a Pool-sourced row (Warehouse
  // Pool output items have no Item Master entry/narration of their own)
  // and for a row with no narration input at all (e.g. a Per-Process Pool
  // Components row). `itemSelect`, if given, is used instead of the row's
  // own (first) item-select -- required for a merged matrix row, where
  // every color cell has its OWN item-select but they all share this one
  // row-level Narration field; without it, picking the 2nd+ color cell's
  // item would always re-derive Narration from the 1st cell instead of
  // the one actually just changed.
  _refillNarrationForRow(row, itemSelect) {
    if (!row) return;
    const narrationInput = row.querySelector('.prod-comp-narration');
    if (!narrationInput) return;
    const sourceSel = row.querySelector('.prod-comp-source');
    if (sourceSel && sourceSel.value === 'POOL') return;

    const selectEl = itemSelect || row.querySelector('.prod-comp-item-select');
    const itemOpt = selectEl ? selectEl.options[selectEl.selectedIndex] : null;
    const itemName = (itemOpt?.dataset.name || itemOpt?.textContent || '').trim();
    if (!itemName) return;

    const size = row.querySelector('.prod-comp-size')?.value.trim() || '';
    const match = (App.State.globalItems || []).find(it =>
      App.Utils.sameText(it.name, itemName) && App.Utils.sameText(it.size || '', size));
    narrationInput.value = (match && match.narration) || '';
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
      narration: row.querySelector('.prod-comp-narration')?.value.trim() || '',
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

    if (currentValue) selectEl.add(new Option(App.Utils.formatNameCase(currentValue), currentValue, true, true));

    const $parentModal = $select.closest('.modal');

    $select.select2({
      placeholder: 'Search or type a contractor/staff name...',
      width: '100%',
      tags: true,
      allowClear: true,
      matcher: App.Utils.select2Matcher,
      dropdownParent: $parentModal.length ? $parentModal : window.jQuery(document.body),
      data: (App.State.globalContractors || []).map(c => ({ id: c.contractorName, text: App.Utils.formatNameCase(c.contractorName) })),
      createTag(params) {
        const term = (params.term || '').trim();
        if (!term) return null;
        const existing = (App.State.globalContractors || []).find(c => App.Utils.sameText(c.contractorName, term));
        if (existing) return { id: existing.contractorName, text: App.Utils.formatNameCase(existing.contractorName) };
        return { id: term, text: term, newTag: true };
      }
    });

    let handlingChange = false;
    $select.off('change.prodAssignedTo').on('change.prodAssignedTo', async () => {
      if (handlingChange) return;
      handlingChange = true;
      Promise.resolve().then(() => { handlingChange = false; });
      // A fresh contractor pick means whatever Extra Charge was showing
      // belonged to the PREVIOUS contractor -- reset to that contractor's
      // own list (no preselect) before refreshing the Payable preview,
      // so it never briefly reads a stale/foreign radio's amount.
      await this.refreshExtraChargeOptions(document.getElementById('productionAssignedTo')?.value);
      this.refreshPayableHint();
    });
  },

  // Populates the per-lot Extra Charge radio group (Layer 2) with
  // whichever service types/charges THIS contractor's own rate card
  // lists -- every contractor can offer a different set, so this refetches
  // on every contractor change rather than showing one shared list.
  // preselectServiceType restores a previously-saved choice on edit.
  async refreshExtraChargeOptions(contractorName, preselectServiceType) {
    const wrapper = document.getElementById('productionExtraChargeWrapper');
    const optionsEl = document.getElementById('productionExtraChargeOptions');
    if (!wrapper || !optionsEl) return;

    if (!contractorName) {
      wrapper.style.display = 'none';
      optionsEl.innerHTML = '';
      return;
    }

    let charges = [];
    try {
      const res = await Api.call('getContractorServiceChargesForContractor', contractorName);
      charges = res.success ? (res.data || []) : [];
    } catch (err) {
      charges = [];
    }

    if (!charges.length) {
      wrapper.style.display = 'none';
      optionsEl.innerHTML = '';
      return;
    }

    const preselect = String(preselectServiceType || '').trim();
    const preselectMatches = preselect && charges.some(c => App.Utils.sameText(c.serviceType, preselect));

    let html = `<div class="form-check form-check-inline">
      <input class="form-check-input" type="radio" name="extraChargeType" id="prodExtraChargeNone" value="" data-charge-amount="0" ${!preselectMatches ? 'checked' : ''} onchange="App.Production.refreshPayableHint()">
      <label class="form-check-label" for="prodExtraChargeNone">None</label>
    </div>`;
    charges.forEach((c, i) => {
      const id = `prodExtraCharge_${i}`;
      const checked = App.Utils.sameText(c.serviceType, preselect) ? 'checked' : '';
      html += `<div class="form-check form-check-inline">
      <input class="form-check-input" type="radio" name="extraChargeType" id="${id}" value="${escapeHtml(c.serviceType)}" data-charge-amount="${c.chargeAmount}" ${checked} onchange="App.Production.refreshPayableHint()">
      <label class="form-check-label" for="${id}">${escapeHtml(c.serviceType)} (+${formatCurrency(c.chargeAmount)}/unit)</label>
    </div>`;
    });
    optionsEl.innerHTML = html;
    wrapper.style.display = '';
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
    // The lot's REAL total, not the plain Qty field. populateColorChecklist
    // both hides and BLANKS that field whenever this process has color
    // sub-groups, so reading it directly meant the Payable hint was
    // permanently empty for every color-driven lot -- even though
    // toggleColorGroup / handleColorCheckToggle / onColorQtyChanged /
    // setPrimaryColorAxisChoice all faithfully call refreshPayableHint() on
    // every checklist edit. _currentComponentQtyMultiplier resolves the
    // same total save_production actually bills the contractor on (the
    // primary axis's summed quantities), and still degrades to the plain
    // Qty field in single-quantity mode.
    const qty = this._currentComponentQtyMultiplier();
    const process = (App.State.globalProcesses || []).find(p => p.processId === processId);

    // Read directly off the checked radio's own data-charge-amount rather
    // than re-fetching -- refreshExtraChargeOptions already populated it
    // for the current contractor, and this runs on a 300ms debounce that
    // can fire many times per keystroke/toggle.
    const extraChargeRadio = document.querySelector('#productionExtraChargeOptions input[name="extraChargeType"]:checked');
    const extraChargeType = extraChargeRadio ? extraChargeRadio.value : '';
    const extraChargeAmount = extraChargeRadio ? toNumber(extraChargeRadio.dataset.chargeAmount) : 0;

    if (!contractorName || !process || !qty) {
      hintEl.innerText = '';
      return;
    }

    const size = App.Utils.getSizeFromOutputItemName(process.outputItemName);

    try {
      const res = await Api.call('getContractorRateForProcessType', contractorName, process.processType, size);
      const rate = res.success ? toNumber(res.data?.ratePerUnit) : 0;
      if (!rate && !extraChargeAmount) {
        hintEl.innerText = `No rate card entry for "${App.Utils.formatNameCase(contractorName)}" / ${process.processType || 'General'} / ${size} — Payable will be 0.`;
        return;
      }
      let text = `Payable: ${formatCurrency(qty * (rate + extraChargeAmount))} (${qty} x ${rate}/unit`;
      if (extraChargeType) text += ` + ${extraChargeType} ${formatCurrency(extraChargeAmount)}/unit`;
      text += ')';
      hintEl.innerText = text;
    } catch (err) {
      hintEl.innerText = '';
    }
  },

  // Opens the generic Issue Stock modal from inside the Production form,
  // pre-filling Reference with the current lot's number (falling back to
  // its Output Item Name for a still-unsaved lot). Purely informational
  // -- never touches this lot's own Components Consumed.
  openIssueStockForLot() {
    const lotNumber = document.getElementById('productionLotNumber')?.value?.trim();
    const outputItem = document.getElementById('productionOutputItemName')?.value?.trim();
    App.Issue.openIssueModal(lotNumber || outputItem || '');
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
    const comboPreview = document.getElementById('productionColorCombinationPreview');
    if (comboPreview) { comboPreview.style.display = 'none'; comboPreview.innerText = ''; }

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
    await this.refreshExtraChargeOptions('');

    this.populateSizeSelect(false);
    const sizeSelect = document.getElementById('productionSize');
    await this.handleSizeChange(sizeSelect ? sizeSelect.value : '');
    document.getElementById('productionLotNumber').value = '';

    document.getElementById('productionFormTitle').innerText = 'Log Production Lot';
    document.getElementById('productionSubmitBtn').innerText = 'Record Production Run';

    App.Utils.setFormButtonsForMode('productionCancelBtn', 'productionExitBtn', 'productionSubmitBtn', false, 'Record Production Run');
    App.Nav.clear('editProductionModal');
  },

  async openCreateModal() {
    await this.resetCreateForm();

    const modalEl = document.getElementById('editProductionModal');
    if (modalEl && typeof bootstrap !== 'undefined') {
      bootstrap.Modal.getOrCreateInstance(modalEl).show();
    }
  },

  async openEditModal(idx) {
    const p = App.State.globalProduction[idx];
    if (!p) return;

    const seq = ++this._compLoadSeq;
    this._resetProcDataCache();

    const form = document.getElementById('productionForm');
    if (form) form.reset();

    await Promise.all([App.Process.ensureLoaded(), App.Contractor.ensureLoaded(), App.ProcessType.ensureLoaded(), App.Model.ensureLoaded()]);

    document.getElementById('productionRowIdx').value = p.rowIdx;

    // Normalize date string to local YYYY-MM-DD input value
    let inputDateStr = todayIso();
    if (p.dateRaw) {
      const d = new Date(p.dateRaw);
      if (!isNaN(d)) {
        const localY = d.getFullYear();
        const localM = String(d.getMonth() + 1).padStart(2, '0');
        const localD = String(d.getDate()).padStart(2, '0');
        inputDateStr = `${localY}-${localM}-${localD}`;
      }
    } else if (p.date && p.date.includes('/')) {
      const [day, month, year] = p.date.split('/');
      inputDateStr = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
    document.getElementById('productionDate').value = inputDateStr;
    document.getElementById('productionDate').disabled = false;

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
      this.populateSizeSelect(true, editSize);
      this.populateModelSelect(editSize, true, editModel);
      this.populateProcessTypeSelect(editSize, editModel, true, editType);
      this.populateProcessSelect(editSize, editType, editModel, true, p.processId);
    } finally {
      this._suppressCascade = false;
    }

    document.getElementById('productionLotNumber').value = p.lotNumber || '';

    this.populateProductSelect();
    document.getElementById('productionProductId').value = p.productId || '';
    document.getElementById('productionProductIdHidden').value = p.productId || '';
    document.getElementById('productionProductNameHidden').value = p.productName || '';

    // This lot's own saved Output Item Name (which may have been
    // customized away from the process default) -- not the process's
    // current default, which would silently discard that customization
    // every time the lot is reopened for edit.
    document.getElementById('productionOutputItemName').value = p.outputItemName || (editProcess ? (editProcess.outputItemName || '') : '');
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
      // This lot is in exactly the state revertToSingleQty exists to undo
      // -- colors added by hand to a process that has none configured --
      // yet the button was blanket-hidden for every edit above, so a lot
      // logged that way could never be put back on a single quantity
      // without deleting and re-logging it. The Create path shows it here
      // (enableManualColors), and revertToSingleQty is edit-safe: it
      // reloads the process's own non-color recipe and the lot then saves
      // with a plain qty and no colorBreakdown.
      if (revertColorsBtn) revertColorsBtn.style.display = '';

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
      const touchedGroups = new Set();
      const findChecklistRow = (color, axisKey) => {
        const rows = $$('#productionColorChecklist .production-color-row').filter(r => !claimedRows.has(r));
        let row = axisKey ? rows.find(r => r.dataset.group === axisKey && App.Utils.sameColor(r.dataset.color, color)) : null;
        if (!row) row = rows.find(r => App.Utils.sameColor(r.dataset.color, color));
        return row || null;
      };

      breakdown.forEach(entry => {
        const color = entry.color;
        const qty = entry.qty;
        let colorRow = findChecklistRow(color, entry.axisKey);

        if (!colorRow) {
          // This saved entry's axis/color has no live checklist row to
          // land on (the process's color/axis config has since drifted)
          // -- but if its axisKey still names a REAL group this process
          // currently has, re-render it under THAT group with that
          // group's own current isPrimary, rather than a disconnected
          // "custom" bucket carrying whatever countsTowardTotal happened
          // to be saved on it. save_production's own qty calc
          // (_is_primary_axis_row) always decides a REAL axis's rows by
          // axis-key identity, never by the submitted flag -- landing a
          // real-axis entry in "custom" here made this form scale the
          // Common Components table (refreshCommonSuggestedQty) against
          // a total that could disagree with what the server would
          // independently recompute, letting a lot's saved qty and its
          // components_consumed silently drift apart on the next save.
          const realGroup = (this._customColorGroupOptions || [])
            .find(g => String(g.key || '').toLowerCase() === String(entry.axisKey || '').toLowerCase());
          const groupKey = realGroup ? realGroup.key : 'custom';
          const isPrimaryFlag = realGroup ? !!realGroup.isPrimary : (entry.countsTowardTotal !== false);

          const checklistEl = document.getElementById('productionColorChecklist');
          if (checklistEl) {
            if (!realGroup && !checklistEl.querySelector('[data-group-master="custom"]')) {
              checklistEl.insertAdjacentHTML('beforeend', this._buildColorGroupHeader('custom', 'Custom'));
            }
            checklistEl.insertAdjacentHTML('beforeend', this._colorRowHtml(color, groupKey, !realGroup, isPrimaryFlag));
            colorRow = $$('#productionColorChecklist .production-color-row')
              .find(r => r.dataset.group === groupKey && App.Utils.sameColor(r.dataset.color, color) && !claimedRows.has(r));
          }
          touchedGroups.add(groupKey);
        }

        if (colorRow) claimedRows.add(colorRow);
        const chk = colorRow?.querySelector('.production-color-check');
        const qtyInput = colorRow?.querySelector('.production-color-qty');
        if (chk) chk.checked = true;
        if (qtyInput) { qtyInput.disabled = false; qtyInput.value = qty; }
      });
      touchedGroups.forEach(groupKey => this._syncColorGroupMasterCheckbox(groupKey));
      // The rows above were checked/quantified by setting checkbox.checked
      // and qtyInput.value directly (not via handleColorCheckToggle/
      // onColorQtyChanged), so refreshCommonSuggestedQty's own preview
      // update never fires on this initial load path -- call it directly
      // so a reopened multi-axis lot shows its combination immediately
      // instead of only after the operator's first checklist edit.
      this._updateColorCombinationPreview();

      if (p.componentsConsumed && p.componentsConsumed.length > 0) {
        await this.populateComponentsConsumedDirect(p.componentsConsumed, breakdown);
      } else {
        // No saved consumption recorded (shouldn't normally happen) --
        // fall back to recipe defaults for the saved colors.
        this.clearComponentsTable();
        this.clearColorMatrix();
        for (const { color, axisKey } of breakdown) {
          this.addMatrixColorColumn(color);
          await this.populateColorMatrixForColor(color, seq, axisKey);
        }
        await this.populateCommonComponentsFromProcess(p.processId, seq);
      }
      await this.refreshPoolAvailability();
    } else {
      // Plain single-quantity lot on a process with no configured color
      // sub-groups -- the same state handleProcessChange offers "+ Add
      // Colors to this Lot" in on the Create path. Hiding it for every
      // edit meant a colour breakdown could only ever be added to a lot at
      // the moment it was first logged.
      if (addColorsBtn) addColorsBtn.style.display = p.processId ? '' : 'none';
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

    // handleProcessChange -- which is what normally ends a Process
    // selection by refreshing this hint -- is deliberately suppressed on
    // this path (_suppressCascade), so nothing else fires it here: a
    // reopened lot showed a blank Payable until the operator happened to
    // touch the contractor or a quantity. Runs last, once the checklist
    // and component tables have settled, so it reads this lot's real total.
    await this.refreshExtraChargeOptions(p.assignedTo, p.extraChargeType);
    this.refreshPayableHint();

    document.getElementById('productionFormTitle').innerText = `Edit Production Lot: Row #${p.rowIdx}`;
    document.getElementById('productionSubmitBtn').innerText = 'Update Production Lot';

    App.Utils.setFormButtonsForMode('productionCancelBtn', 'productionExitBtn', 'productionSubmitBtn', true, 'Update Production Lot');
    App.Nav.register(
      'editProductionModal',
      (App.State.filteredProduction || []).map(x => x.rowIdx),
      p.rowIdx,
      (rowIdx) => {
        const targetIdx = App.State.globalProduction.findIndex(x => String(x.rowIdx) === String(rowIdx));
        if (targetIdx !== -1) this.openEditModal(targetIdx);
      }
    );

    const modalEl = document.getElementById('editProductionModal');
    if (modalEl && typeof bootstrap !== 'undefined') {
      bootstrap.Modal.getOrCreateInstance(modalEl).show();
    }
  },

  // ── Production Sheet (lot-completion) modal ──────────────────────────
  // A fully editable, printable customization of a lot's already-recorded
  // Components Consumed -- lets the operator hand-tailor item names,
  // sizes, narrations, and quantities to match a customer's actual
  // requirement (e.g. a substitution), without touching the lot's real
  // saved consumption record.

  viewProductionSheet(idx) {
    const p = App.State.globalProduction[idx];
    if (!p) return;

    this._populateProductionSheetData(p, idx);

    const modalEl = document.getElementById('productionSheetModal');
    if (modalEl && typeof bootstrap !== 'undefined') {
      bootstrap.Modal.getOrCreateInstance(modalEl).show();
    }
  },

  // Populates the Production Sheet dialog's DOM (title/date/Common
  // table/Per-Color matrix/Remarks) for one lot, WITHOUT opening the
  // modal -- split out of viewProductionSheet so bulkDownloadPDF can
  // reuse the exact same rich rendering (Common table + Per-Color matrix,
  // including Pool-sourced per-color components -- see
  // groupComponentsForSheet) for every selected lot in turn, without
  // flashing the modal open/closed once per lot. `idx` is only used to
  // remember this lot's position for the popup's own Save/Reset/Add
  // actions (see currentProductionSheet); a bulk-export caller that never
  // touches those can pass it undefined.
  _populateProductionSheetData(p, idx) {
    // This lot's own recorded consumption (set when it was logged) is
    // the source of truth -- production lots are tied to a Process
    // recipe, not a Product BOM, so there is no BOM to fall back to.
    const defaultComponents = p.componentsConsumed || [];
    const components = (p.customComponents && p.customComponents.length > 0)
      ? p.customComponents
      : defaultComponents;

    // p.colorBreakdown is this lot's authoritative color list -- a color
    // with no component explicitly tagged to it (entirely covered by a
    // Common fallback, see _getCommonItemsWithColorOverride) still needs
    // to be known here, or that fallback item's qty has nowhere to be
    // split into for that color.
    const knownColors = (p.colorBreakdown || []).map(c => c.color).filter(Boolean);
    const { common, matrixSlots, colors } = this.groupComponentsForSheet(components, knownColors);

    // Size/Model aren't stored on the lot itself -- they're derived from its
    // Process's Output Item Name the same way the Production form's
    // Size/Model dropdowns are. Remembered (with date/processName) so
    // downloadProductionSheetPDF/bulkDownloadPDF can name the file after
    // this lot.
    const process = (App.State.globalProcesses || []).find(pr => pr.processId === p.processId);
    const processName = process ? process.processName : (p.processId || 'Process');
    const requirementSheetTitle = this._requirementSheetTitle(p.processId);
    const size = App.Utils.getSizeFromOutputItemName(p.outputItemName);
    const model = App.Utils.getModelFromOutputItemName(p.outputItemName);

    // `colors` deliberately stays the FULL group list -- every consumer that
    // must not lose data (serializeProductionSheet, addProductionSheetColor,
    // the save path) reads it, and dropping sub-groups from it would drop
    // their quantities on save. The split below is derived alongside it for
    // PRESENTATION only: which of those groups are real colors, and which
    // are packing/variant sub-groups. See _isColorGroupName.
    App.State.currentProductionSheet = {
      idx, lotQty: p.qty, defaultComponents, colors,
      lotColor: p.color || '', date: p.date, size, model, processName, requirementSheetTitle
    };
    this._refreshSheetGroupSplit(App.State.currentProductionSheet);
    this.renderProductionSheetPrintOptions();

    const label = p.productName || p.outputItemName || p.processId;
    const tag = p.productId || p.lotNumber;
    document.getElementById('productionSheetTitle').innerText = `Production Sheet: ${label} (${tag})`;
    document.getElementById('prodSheetDate').innerText = p.date;
    document.getElementById('prodSheetProductId').innerText = tag;
    document.getElementById('prodSheetProductName').innerText = label;
    document.getElementById('prodSheetLotQty').innerText = this.formatQty(p.qty);

    this.renderProductionSheetTable(common, matrixSlots, colors);

    document.getElementById('productionSheetRemarks').value = p.sheetRemarks || '';
  },

  // Which color bucket a Production Sheet component belongs to: its
  // structured colorGroup (set on every lot created by the Create/Edit Lot
  // form -- 'COMMON' or a specific Color Master name) if present, else its
  // legacy free-text Color field (older customized sheets, predating
  // colorGroup). '' means Common.
  _resolveSheetColorKey(comp) {
    const colorGroup = String(comp.colorGroup || '').trim();
    if (colorGroup && !App.Utils.isCommonColorGroup(colorGroup)) return colorGroup;
    return String(comp.color || '').trim();
  },

  // True when `name` is composed entirely of Color Master color names (so it
  // belongs on the Per-Color matrix), false when it's a packing/variant
  // bucket like 'KIT BAG 20"' that travels with the lot's colors but isn't
  // one (so it belongs on the Sub-Group Components table instead). The test
  // is compositional, not a lookup: "Blue-White" and "B/T Green-Orange"
  // classify as colors (every segment resolves against Color Master), while
  // 'SMALL KIT 20"' does not (nothing resolves). Longest match wins, so a
  // short color can't consume the head of a longer one and strand the
  // remainder ("Sea Green" losing to "Sea").
  _isColorGroupName(name) {
    let rest = String(name || '').trim().toLowerCase();
    if (!rest) return false;
    if (App.Utils.isCommonColorGroup(rest)) return false;

    const master = (App.State.globalColors || [])
      .map(c => String(c.name || '').trim().toLowerCase())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    // With no Color Master loaded there is nothing to judge against; treat
    // every group as a color so the sheet keeps its old shape rather than
    // dumping every column into the sub-group table.
    if (master.length === 0) return true;

    let matchedAny = false;
    while (rest) {
      const withoutDelim = rest.replace(/^[-/\s]+/, '');
      if (withoutDelim !== rest) { rest = withoutDelim; continue; }
      const hit = master.find(m => rest.startsWith(m));
      if (!hit) return false;
      rest = rest.slice(hit.length);
      matchedAny = true;
    }
    return matchedAny;
  },

  // Items Master lookup by exact name+size, case/whitespace-insensitive.
  // Returns null for a blank name (caller-distinguishable from undefined --
  // "named, but Items Master doesn't know it") so _resolveDisplayUnit can
  // keep rendering nothing at all for a still-empty row rather than
  // labelling it "Pcs".
  _lookupSheetItem(itemName, size) {
    const name = String(itemName || '').trim();
    if (!name) return null;
    return (App.State.globalItems || []).find(i =>
      App.Utils.sameText(i.name, name) && App.Utils.sameText(i.size || '', size || ''));
  },

  // The physical unit to print alongside a component's Qty (e.g. "Pcs",
  // "Kg", "Dozen") -- looked up fresh from Items Master by name+size at
  // export time rather than carried through from componentsConsumed/
  // customComponents, since a customized-and-resaved sheet's own
  // serializeProductionSheet schema never retains sourceType or the
  // recipe's own Unit field in the first place. 'Pcs' is the fallback for a
  // Warehouse Pool WIP item (no Items Master entry of its own) or any name
  // Items Master doesn't recognize.
  _resolveDisplayUnit(itemName, size) {
    const match = this._lookupSheetItem(itemName, size);
    if (match === null) return '';
    return (match && match.baseUnit) || 'Pcs';
  },

  // The unit to print for one rendered sheet row, read back off the INPUT the
  // dialog already shows so the export can never disagree with what the
  // operator just looked at -- and so an operator's manual override (see
  // renderCommonSheetRow/renderMatrixSheetRow) makes it into the printed
  // sheet. That input is also the only place the unit resolved from a merged
  // row's LITERAL item name survives -- the rendered Item Name is
  // colour-stripped and would re-resolve to the 'Pcs' fallback (see
  // groupComponentsForSheet). A blank input is a deliberate "no unit" and is
  // returned as-is; only a row whose DOM was built WITHOUT the input at all
  // (a caller that skipped the template) falls back to resolving fresh from
  // the rendered name.
  _sheetRowUnitFromDom(row) {
    const unitInput = row?.querySelector('.prod-sheet-unit');
    if (unitInput) return unitInput.value.trim();
    return this._resolveDisplayUnit(
      row?.querySelector('.prod-sheet-item-name')?.value.trim() || '',
      row?.querySelector('.prod-sheet-size')?.value.trim() || ''
    );
  },

  // The Base Unit to render for one Common row / matrix slot. Prefers the
  // unit groupComponentsForSheet already resolved from the component's
  // LITERAL item name, and only falls back to resolving from the rendered
  // name for rows that never went through it (a blank row from
  // addCommonSheetRow/addMatrixSheetRow, filled in on change instead).
  _sheetRowUnit(row) {
    if (row && row.unit) return row.unit;
    return this._resolveDisplayUnit(row?.itemName, row?.size);
  },

  // Re-resolves a sheet row's Narration and Base Unit after its Item Name or
  // Size was edited, so both keep matching whatever item the row now names.
  // Narration is only overwritten when Items Master actually has one for the
  // new item (see _resolveDisplayNarration), so a hand-typed note on a row
  // Items Master doesn't know is left alone.
  handleSheetRowItemChange(input) {
    const row = input?.closest('tr');
    if (!row) return;

    const itemName = row.querySelector('.prod-sheet-item-name')?.value.trim() || '';
    const size = row.querySelector('.prod-sheet-size')?.value.trim() || '';

    const narrationInput = row.querySelector('.prod-sheet-narration');
    if (narrationInput) {
      narrationInput.value = this._resolveDisplayNarration(itemName, size, narrationInput.value);
    }

    const unitInput = row.querySelector('.prod-sheet-unit');
    if (unitInput) unitInput.value = this._resolveDisplayUnit(itemName, size);
  },

  // The Narration to show alongside a component, resolved LIVE from Items
  // Master by name+size rather than read off the value the lot snapshotted
  // into componentsConsumed when it was logged -- an Items Master correction
  // then shows up on every lot's Production Sheet, not just ones logged
  // after the correction. `fallback` (the stored value) is kept when there's
  // no Items Master entry at all (a Warehouse Pool WIP item, or an ad-hoc
  // row typed straight into the sheet), or when the matched entry's own
  // Narration is blank, so nothing is ever silently blanked.
  _resolveDisplayNarration(itemName, size, fallback) {
    const stored = String(fallback || '').trim();
    const match = this._lookupSheetItem(itemName, size);
    if (!match) return stored;
    return String(match.narration || '').trim() || stored;
  },

  // Splits a lot's components into the Common table (no color, shown
  // once) and the Per-Color matrix (one row per reconstructed item, one
  // quantity column per color) -- mirroring the Create/Edit Lot form's
  // layout. Which entries belong to the same matrix row is decided by
  // _reconstructPerColorRows (position across each colour's own ordered
  // sub-list, falling back to _stripColorSubstring-based name matching
  // when position can't be trusted) -- not by name-stripping alone, which
  // silently fragments a row like "Teddy Basket" into one row per colour
  // whenever the literal item's own colour word doesn't match the
  // colorGroup it's tagged under (see LOT-PF2IIS-0002).
  groupComponentsForSheet(components, knownColors) {
    const common = [];
    const colors = new Set(knownColors || []);

    const commonOverrideComps = this._getCommonItemsWithColorOverride(components || []);
    const pendingCommonOverrides = [];
    const perColorEntries = [];

    (components || []).forEach(comp => {
      const colorKey = this._resolveSheetColorKey(comp);
      const qty = comp.requiredQty !== undefined ? toNumber(comp.requiredQty) : toNumber(comp.qty);
      // Resolved against this component's OWN literal item name (not the
      // color-stripped display name used as the matrix row's label) --
      // that literal name is what Items Master is keyed by.
      const narration = this._resolveDisplayNarration(comp.itemName, comp.size, comp.narration);
      // Same reason the unit must be resolved HERE and carried on the row
      // rather than re-derived later from the rendered Item Name: a merged
      // per-colour row displays a colour-STRIPPED name ("Frame Sticker" for
      // the literal "Frame Sticker---Blue"), and that stripped name matches
      // nothing in Items Master -- resolving from it later would silently
      // fall through to the 'Pcs' fallback and mislabel every by-weight/
      // by-set item's quantity on both the dialog and the printed sheet.
      const unit = this._resolveDisplayUnit(comp.itemName, comp.size);

      if (!colorKey) {
        if (commonOverrideComps.includes(comp)) {
          const overriddenColors = new Set(
            (components || [])
              .filter(o => o !== comp && this._resolveSheetColorKey(o) &&
                this._itemSlotKey(this._stripColorSubstring(o.itemName || '', this._resolveSheetColorKey(o)), o.size) === this._itemSlotKey(comp.itemName, comp.size))
              .map(o => this._resolveSheetColorKey(o))
          );
          pendingCommonOverrides.push({ comp, qty, narration, unit, overriddenColors });
          return;
        }
        common.push({ itemName: comp.itemName || '', size: comp.size || '', narration, unit, qty });
        return;
      }

      colors.add(colorKey);
      perColorEntries.push({ colorKey, itemName: comp.itemName || '', size: comp.size || '', narration, unit, qty });
    });

    // The row's own displayed label is still best-effort (first cell's
    // colour word stripped out where possible) -- it no longer decides
    // which entries merged together, only what the row is CALLED, so a
    // less-than-clean label here is cosmetic. _cellItemTag (rendered by
    // the caller under each colour's Qty) is what actually tells the
    // operator which literal item that colour uses, so a rough label is
    // never the only source of truth.
    const matrixSlots = this._reconstructPerColorRows(perColorEntries).map(row => {
      const itemName = this._rowDisplayName(row);
      const slot = { itemName, size: row.size, narration: row.narration, unit: row.unit, colors: {}, cellItems: {} };
      row.cells.forEach(cell => {
        slot.colors[cell.colorKey] = (slot.colors[cell.colorKey] || 0) + cell.qty;
        slot.cellItems[cell.colorKey] = cell.itemName;
      });
      return slot;
    });

    const matrixIndex = new Map();
    matrixSlots.forEach(s => matrixIndex.set([s.itemName, s.size, s.narration].join('|').toLowerCase(), s));

    const allColors = Array.from(colors);
    pendingCommonOverrides.forEach(({ comp, qty, narration, unit, overriddenColors }) => {
      const fallbackColors = allColors.filter(c => !overriddenColors.has(c));
      if (fallbackColors.length === 0) return;
      const perColorQty = qty / fallbackColors.length;
      const displayName = comp.itemName || '';
      const slotKey = [displayName, comp.size || '', narration].join('|').toLowerCase();
      let slot = matrixIndex.get(slotKey);
      if (!slot) {
        slot = { itemName: displayName, size: comp.size || '', narration, unit, colors: {}, cellItems: {} };
        matrixIndex.set(slotKey, slot);
        matrixSlots.push(slot);
      }
      if (!slot.unit) slot.unit = unit;
      fallbackColors.forEach(c => {
        slot.colors[c] = (slot.colors[c] || 0) + perColorQty;
        if (!slot.cellItems[c]) slot.cellItems[c] = displayName;
      });
    });

    return { common, matrixSlots, colors: allColors.sort((a, b) => a.localeCompare(b)) };
  },

  // Renders the Common table + the Per-Color matrix for the given
  // grouped data. The matrix is split into one table per distinct set
  // of colors its rows actually carry a value for (see
  // _groupMatrixSlotsForSheet), instead of one shared table with every
  // color in the lot as a column. A perpetual "manual" table (full color
  // list) is always rendered too, as the target for "+ Add Per-Color
  // Component" / "+ Add Color Column". Hides the matrix card entirely
  // when this lot has no color-specific components at all.
  renderProductionSheetTable(common, matrixSlots, colors) {
    const commonBody = document.getElementById('productionSheetCommonBody');
    if (commonBody) {
      commonBody.innerHTML = (common && common.length > 0)
        ? common.map(row => this.renderCommonSheetRow(row)).join('')
        : `<tr><td colspan="5" class="text-center text-muted p-3">No common components recorded.</td></tr>`;
    }

    const matrixCard = document.getElementById('productionSheetMatrixCard');
    if (matrixCard) matrixCard.style.display = colors.length > 0 ? '' : 'none';

    const tablesContainer = document.getElementById('productionSheetMatrixTables');
    if (!tablesContainer) return;
    tablesContainer.innerHTML = '';

    const { autoGroups, manualSlots } = this._groupMatrixSlotsForSheet(matrixSlots);
    autoGroups.forEach((group, idx) => {
      // A signature group is a sub-group table when none of the columns it
      // was built from is a real color -- the on-screen counterpart of the
      // print sheet's "Sub-Group Components" split, so a kit/packing bucket
      // reads as what it is instead of masquerading as a color.
      const isSub = group.colors.every(c => !this._isColorGroupName(c));
      tablesContainer.insertAdjacentHTML('beforeend',
        this._buildSheetMatrixTable(`group_${idx}`, group.colors, group.slots, isSub));
    });

    // The catch-all for ad-hoc additions is split the same way, so a new row
    // added under a color is not also handed a set of packing columns (and
    // vice versa). Only render each when that kind of column actually exists.
    const colorGroups = App.State.currentProductionSheet?.colorGroups
      || colors.filter(c => this._isColorGroupName(c));
    const subGroups = App.State.currentProductionSheet?.subGroups
      || colors.filter(c => !this._isColorGroupName(c));
    if (colorGroups.length > 0) {
      tablesContainer.insertAdjacentHTML('beforeend', this._buildSheetMatrixTable('manual', colorGroups, manualSlots));
    }
    if (subGroups.length > 0) {
      tablesContainer.insertAdjacentHTML('beforeend', this._buildSheetMatrixTable('manual-subgroup', subGroups, [], true));
    }
  },

  // Splits matrixSlots into signature-based auto groups (rows that
  // already carry real saved/customized values, grouped by exactly
  // which colors those are) plus a `manualSlots` leftover list. The
  // manual/catch-all table rendered alongside these always shows the
  // FULL color list regardless of this grouping, since it's the
  // perpetual target for ad-hoc additions.
  _groupMatrixSlotsForSheet(matrixSlots) {
    const groups = new Map();
    const manualSlots = [];
    (matrixSlots || []).forEach(slot => {
      const slotColors = Object.keys(slot.colors || {});
      if (slotColors.length === 0) { manualSlots.push(slot); return; }
      const sortedColors = slotColors.slice().sort((a, b) => a.localeCompare(b));
      const signature = sortedColors.join('|').toLowerCase();
      if (!groups.has(signature)) groups.set(signature, { colors: sortedColors, slots: [] });
      groups.get(signature).slots.push(slot);
    });
    return { autoGroups: Array.from(groups.values()), manualSlots };
  },

  // Builds one Per-Color table block: a header with this group's own
  // colors, and a tbody tagged with data-matrix-group so
  // addMatrixSheetRow/addProductionSheetColor/serializeProductionSheet
  // can target the right table (or read across all of them). `isSubGroup`
  // only changes the caption -- the table itself is identical, and every
  // tbody keeps the same .prod-sheet-matrix-tbody hook so
  // serializeProductionSheet still reads colour and sub-group rows together
  // and nothing is lost on save.
  _buildSheetMatrixTable(groupKey, colors, slots, isSubGroup = false) {
    const headHtml = colors.map(c => `<th class="text-end" style="min-width:70px;" data-color="${escapeHtml(c)}">${escapeHtml(c)}</th>`).join('');
    const bodyHtml = slots.map(slot => this.renderMatrixSheetRow(slot, colors)).join('');
    const caption = isSubGroup
      ? `<div class="small fw-semibold text-secondary mb-1">Sub-Group Components</div>`
      : '';
    return `
      <div class="table-responsive mb-3" data-matrix-group="${escapeHtml(groupKey)}">
        ${caption}
        <table class="table table-sm table-hover table-striped align-middle mb-0">
          <thead class="table-light">
            <tr>
              <th style="width:18%;">Item Name</th><th style="width:8%;">Size</th><th style="width:14%;">Narration</th>
              <th class="text-center" style="width:52px;">Unit</th>
              ${headHtml}
              <th class="text-center" style="width:30px;">✕</th>
            </tr>
          </thead>
          <tbody class="prod-sheet-matrix-tbody" data-matrix-group="${escapeHtml(groupKey)}">${bodyHtml}</tbody>
        </table>
      </div>`;
  },

  // Shared by both row renderers -- editing either one re-keys the row's
  // Items Master lookup, so both re-resolve Narration + Unit for that row
  // (see handleSheetRowItemChange) -- the sheet is fully editable, and a row
  // retyped onto a different item would otherwise keep the previous item's
  // narration and unit label.
  _SHEET_IDENTITY_HOOK: 'onchange="App.Production.handleSheetRowItemChange(this)"',

  // Builds one editable Common-table <tr>: item/size/narration + a single
  // Required Qty input, suffixed with an editable Unit box pre-filled from
  // the item's Base Unit in Items Master so a quantity is never read as a
  // bare number ("2" for a by-weight item means 2 Kg, not 2 pieces). The
  // override is print-only: serializeProductionSheet never reads
  // .prod-sheet-unit, so it's never saved back to the lot or to Items
  // Master -- re-opening this sheet later re-resolves the Base Unit fresh
  // (see _resolveDisplayUnit), same as before this field became editable.
  renderCommonSheetRow(row) {
    const display = row.qty !== undefined ? this.formatQty(row.qty) : '';
    return `<tr>
      <td><input type="text" class="form-control form-control-sm prod-sheet-item-name" value="${escapeHtml(row.itemName || '')}" placeholder="Item name" ${this._SHEET_IDENTITY_HOOK}></td>
      <td><input type="text" class="form-control form-control-sm prod-sheet-size" value="${escapeHtml(row.size || '')}" placeholder="-" ${this._SHEET_IDENTITY_HOOK}></td>
      <td><input type="text" class="form-control form-control-sm prod-sheet-narration" value="${escapeHtml(row.narration || '')}" placeholder="-"></td>
      <td>
        <div class="input-group input-group-sm flex-nowrap">
          <input type="number" class="form-control form-control-sm text-end prod-sheet-qty" value="${display}" step="any" min="0" placeholder="-">
          <input type="text" class="form-control form-control-sm text-center prod-sheet-unit" style="max-width:56px;" value="${escapeHtml(this._sheetRowUnit(row) || '')}" placeholder="Unit" title="Base Unit -- edit to override for this printed sheet only, Items Master is unaffected">
        </div>
      </td>
      <td class="text-center"><button type="button" class="btn btn-outline-danger btn-sm" onclick="this.closest('tr').remove()">✕</button></td>
    </tr>`;
  },

  // Builds one editable matrix <tr>: item/size/narration text inputs, an
  // editable Base Unit cell, plus one Required Qty number input per color
  // column (blank = not applicable to that color, rather than a misleading
  // 0). The unit sits in its own cell just ahead of the quantity columns,
  // and applies to every one of them -- suffixing each colour cell
  // individually (as the printed sheet does, where width is fixed) would
  // add an addon per colour and push this already-wide table into
  // horizontal scroll. Like renderCommonSheetRow's unit input, an edit here
  // is print-only -- see _sheetRowUnitFromDom.
  renderMatrixSheetRow(slot, colors) {
    const qtyCell = (color) => {
      const val = slot.colors ? slot.colors[color] : undefined;
      const display = (val === undefined) ? '' : this.formatQty(val);
      // Which literal item that colour's quantity actually refers to --
      // the row's own Item Name is necessarily a best-effort generic label
      // (see _reconstructPerColorRows), so this is what tells the operator
      // apart, e.g., a "Teddy Basket" row's Blue column really uses the RED
      // one. Blank when the cell's literal item IS the row's label (a
      // shared/pool item using the same name in every colour -- nothing to
      // disambiguate).
      const cellItemName = slot.cellItems ? slot.cellItems[color] : '';
      const tag = cellItemName ? this._cellItemTag(slot.itemName, cellItemName) : '';
      const tagHtml = tag
        ? `<div class="small fw-semibold text-muted text-end prod-sheet-color-tag" data-color="${escapeHtml(color)}" title="${escapeHtml(cellItemName)}">(${escapeHtml(tag)})</div>`
        : '';
      return `<td><input type="number" class="form-control form-control-sm text-end prod-sheet-color-qty" data-color="${escapeHtml(color)}" value="${display}" step="any" min="0" placeholder="-">${tagHtml}</td>`;
    };

    let html = `<tr>
      <td><input type="text" class="form-control form-control-sm prod-sheet-item-name" value="${escapeHtml(slot.itemName || '')}" placeholder="Item name" ${this._SHEET_IDENTITY_HOOK}></td>
      <td><input type="text" class="form-control form-control-sm prod-sheet-size" value="${escapeHtml(slot.size || '')}" placeholder="-" ${this._SHEET_IDENTITY_HOOK}></td>
      <td><input type="text" class="form-control form-control-sm prod-sheet-narration" value="${escapeHtml(slot.narration || '')}" placeholder="-"></td>
      <td><input type="text" class="form-control form-control-sm text-center prod-sheet-unit" value="${escapeHtml(this._sheetRowUnit(slot) || '')}" placeholder="Unit" title="Base Unit -- edit to override for this printed sheet only, applies to every quantity in this row"></td>`;
    (colors || []).forEach(c => { html += qtyCell(c); });
    html += `<td class="text-center"><button type="button" class="btn btn-outline-danger btn-sm" onclick="this.closest('tr').remove()">✕</button></td>
    </tr>`;
    return html;
  },

  addCommonSheetRow() {
    const tbody = document.getElementById('productionSheetCommonBody');
    if (!tbody) return;
    if (tbody.querySelector('td[colspan]')) tbody.innerHTML = '';
    tbody.insertAdjacentHTML('beforeend', this.renderCommonSheetRow({ itemName: '', size: '', narration: '', qty: undefined }));
  },

  // Appends a blank editable matrix row, with one empty Required Qty
  // cell per color column currently shown -- always lands in the
  // perpetual "manual" table (full color list), never one of the
  // narrower auto-derived groups, since a brand-new row has no colors
  // of its own yet for the grouping to key off.
  addMatrixSheetRow() {
    const tbody = document.querySelector('#productionSheetMatrixTables tbody[data-matrix-group="manual"]');
    if (!tbody) return;
    const colors = App.State.currentProductionSheet?.colors || [];
    tbody.insertAdjacentHTML('beforeend', this.renderMatrixSheetRow({ itemName: '', size: '', narration: '', colors: {} }, colors));
  },

  // Adds a new color column to the perpetual "manual" table only
  // (preserving whatever has already been typed into it) -- the
  // auto-derived tables reflect real saved/customized data signatures,
  // so a brand-new, still-empty column has no natural home there.
  addProductionSheetColor() {
    const name = (prompt('New color name (e.g. Red, Blue):') || '').trim();
    if (!name) return;

    const state = App.State.currentProductionSheet;
    if (!state) return;

    state.colors = state.colors || [];
    if (state.colors.some(c => c.toLowerCase() === name.toLowerCase())) {
      App.Utils.showToast('That color column already exists.', true);
      return;
    }
    state.colors.push(name);
    state.colors.sort((a, b) => a.localeCompare(b));
    this._refreshSheetGroupSplit(state);

    // A typed-in name that is not a real color belongs in the sub-group
    // catch-all, not among the color columns.
    const targetGroup = this._isColorGroupName(name) ? 'manual' : 'manual-subgroup';
    const manualTable = document.querySelector(`#productionSheetMatrixTables [data-matrix-group="${targetGroup}"]`)
      || document.querySelector('#productionSheetMatrixTables [data-matrix-group="manual"]');
    if (manualTable) {
      const headerRow = manualTable.querySelector('thead tr');
      if (headerRow) {
        const th = document.createElement('th');
        th.className = 'text-end';
        th.style.minWidth = '70px';
        th.dataset.color = name;
        th.textContent = name;
        headerRow.insertBefore(th, headerRow.lastElementChild);
      }
      manualTable.querySelectorAll('tbody tr').forEach(row => {
        const td = document.createElement('td');
        td.innerHTML = `<input type="number" class="form-control form-control-sm text-end prod-sheet-color-qty" data-color="${escapeHtml(name)}" step="any" min="0" placeholder="-">`;
        row.insertBefore(td, row.lastElementChild);
      });
    }

    const matrixCard = document.getElementById('productionSheetMatrixCard');
    if (matrixCard) matrixCard.style.display = '';
  },

  // Discards customizations and re-renders both tables from this lot's originally recorded components.
  resetProductionSheetQuantities() {
    const state = App.State.currentProductionSheet;
    if (!state) return;

    const { common, matrixSlots, colors } = this.groupComponentsForSheet(state.defaultComponents || []);
    state.colors = colors;
    this._refreshSheetGroupSplit(state);
    this.renderProductionSheetTable(common, matrixSlots, colors);
  },

  // Recomputes the presentation-only split of state.colors into real color
  // groups vs sub-groups. Must be called after ANY mutation of state.colors
  // (populate / add-column / reset), or the dialog and the print sheet would
  // keep rendering a stale set of columns.
  _refreshSheetGroupSplit(state) {
    if (!state) return;
    const all = state.colors || [];
    state.colorGroups = all.filter(c => this._isColorGroupName(c));
    state.subGroups = all.filter(c => !this._isColorGroupName(c));
  },

  // ── Print options ────────────────────────────────────────────────
  // Reads the "Print options" panel. Absent panel / unopened dialog falls
  // back to "print everything, portrait", so every existing caller
  // (bulkDownloadPDF included) behaves exactly as it did before.
  _printOptions() {
    const boxes = $$('#productionSheetPrintColumns input[type="checkbox"]');
    const excluded = boxes.filter(b => !b.checked).map(b => b.dataset.group);
    const landscape = !!document.getElementById('prodSheetOrientLandscape')?.checked;
    return { excluded, landscape };
  },

  // Rebuilds the column tick-list for the lot now in the dialog. Colours and
  // sub-groups are labelled distinctly so it is obvious which is which.
  renderProductionSheetPrintOptions() {
    const dest = document.getElementById('productionSheetPrintColumns');
    if (!dest) return;
    const state = App.State.currentProductionSheet || {};
    const colorGroups = state.colorGroups || [];
    const subGroups = state.subGroups || [];

    const box = (group, kind) => `
          <div class="form-check">
            <input class="form-check-input prod-sheet-print-col" type="checkbox"
                   id="prodPrintCol_${escapeHtml(group).replace(/[^a-zA-Z0-9]/g, '_')}"
                   data-group="${escapeHtml(group)}" checked>
            <label class="form-check-label" for="prodPrintCol_${escapeHtml(group).replace(/[^a-zA-Z0-9]/g, '_')}">
              ${escapeHtml(group)} <span class="badge bg-${kind === 'color' ? 'success' : 'secondary'}-subtle text-${kind === 'color' ? 'success' : 'secondary'} border">${kind === 'color' ? 'colour' : 'sub-group'}</span>
            </label>
          </div>`;

    const html = [
      ...colorGroups.map(c => box(c, 'color')),
      ...subGroups.map(c => box(c, 'sub'))
    ].join('');
    dest.innerHTML = html || '<div class="text-muted small">This lot has no per-colour columns.</div>';
  },

  // Reads the Common table + Per-Color matrix + remarks into a plain
  // object -- components are tagged with `color` (blank for Common, a
  // real color name for a matrix cell) so a re-opened sheet can group
  // them back into the same two tables via _resolveSheetColorKey.
  //
  // Adaptation from source (a confirmed field-name mismatch, verified
  // empirically against the real saveProductionSheet RPC): source's own
  // serializeProductionSheet tags every component with `colorGroup`, but
  // this backend's save_production_sheet only ever reads `comp.color` --
  // every saved customization's color silently came back blank. Sending
  // `color` here instead (blank for Common, matching _resolveSheetColorKey's
  // own read-side fallback for a customComponents row, which never carries
  // a colorGroup key at all) is the fix.
  serializeProductionSheet() {
    const components = [];

    $$('#productionSheetCommonBody tr').forEach(row => {
      const nameInput = row.querySelector('.prod-sheet-item-name');
      if (!nameInput) return;
      const itemName = nameInput.value.trim();
      if (!itemName) return;

      const qty = toNumber(row.querySelector('.prod-sheet-qty')?.value);
      if (qty <= 0) return;

      components.push({
        itemName,
        size: row.querySelector('.prod-sheet-size')?.value.trim() || '',
        narration: row.querySelector('.prod-sheet-narration')?.value.trim() || '',
        color: '',
        requiredQty: qty
      });
    });

    $$('#productionSheetMatrixTables .prod-sheet-matrix-tbody tr').forEach(row => {
      const nameInput = row.querySelector('.prod-sheet-item-name');
      if (!nameInput) return;
      const itemName = nameInput.value.trim();
      if (!itemName) return;

      const size = row.querySelector('.prod-sheet-size')?.value.trim() || '';
      const narration = row.querySelector('.prod-sheet-narration')?.value.trim() || '';

      row.querySelectorAll('.prod-sheet-color-qty').forEach(input => {
        if (input.value === '') return;
        components.push({
          itemName,
          size,
          narration,
          color: input.dataset.color || '',
          requiredQty: toNumber(input.value)
        });
      });
    });

    const remarks = document.getElementById('productionSheetRemarks')?.value.trim() || '';
    return { components, remarks };
  },

  // Persists the customized component list + remarks with this production lot.
  async saveProductionSheet() {
    const state = App.State.currentProductionSheet;
    const p = state ? App.State.globalProduction[state.idx] : null;
    if (!p) return;

    const { components, remarks } = this.serializeProductionSheet();

    const btn = document.getElementById('prodSheetSaveBtn');
    if (btn) btn.disabled = true;

    try {
      const res = await Api.mutate('saveProductionSheet', p.rowIdx, p.productId, p.qty, JSON.stringify(components), remarks);
      App.Utils.showToast(res.message, !res.success);
      if (res.success) {
        p.customComponents = components;
        p.sheetRemarks = remarks;
      }
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to save production sheet', true);
    } finally {
      if (btn) btn.disabled = false;
    }
  },

  printProductionSheet() {
    if (typeof App.Print === 'undefined') {
      App.Utils.notPortedYet('Printing');
      return;
    }

    this._buildProductionSheetForExport();

    const productId = document.getElementById('prodSheetProductId')?.innerText || 'Production';
    App.Print.trigger('print-production-sheet-container', `Production_Sheet_${productId.replace(/[^a-zA-Z0-9_-]/g, '_')}`);
  },

  // The printed sheet's title: "<Process Type> Requirement Sheet" (e.g.
  // "Packing Requirement Sheet"), falling back to the original generic
  // "Production Material Requirement Sheet" when the lot's process has no
  // Process Type set, or the process itself can no longer be found
  // (deleted/renamed since the lot was logged). Shared by the rich
  // single-lot template (_buildProductionSheetForExport) and the bulk
  // print builder (buildProductionSheetPrintPageHtml) so both agree.
  _requirementSheetTitle(processId) {
    const process = (App.State.globalProcesses || []).find(pr => pr.processId === processId);
    const type = String(process?.processType || '').trim();
    return type ? `${type} Requirement Sheet` : 'Production Material Requirement Sheet';
  },

  // Populates #print-production-sheet-container's DOM from the currently
  // open Production Sheet dialog's state -- split out so both
  // printProductionSheet (browser print) and downloadProductionSheetPDF /
  // bulkDownloadPDF (PDF capture via App.Print.downloadElementAsPDF) render
  // an identical sheet, single source of truth for the single-page
  // auto-fit layout below.
  _buildProductionSheetForExport() {
    const setText = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.innerText = text;
    };

    setText('print-prod-title', App.State.currentProductionSheet?.requirementSheetTitle || 'Production Material Requirement Sheet');
    setText('print-prod-date', document.getElementById('prodSheetDate')?.innerText || '');
    setText('print-prod-id', document.getElementById('prodSheetProductId')?.innerText || '');
    setText('print-prod-name', document.getElementById('prodSheetProductName')?.innerText || '');
    setText('print-prod-qty', document.getElementById('prodSheetLotQty')?.innerText || '');

    const lotColor = App.State.currentProductionSheet?.lotColor || '';
    const colorWrapper = document.getElementById('print-prod-color-wrapper');
    if (colorWrapper) colorWrapper.style.display = lotColor ? '' : 'none';
    setText('print-prod-color', lotColor);

    // Anything unticked in the Print options panel is dropped from the
    // printed sheet only -- the lot's own data is untouched.
    const { excluded } = this._printOptions();
    const kept = g => !excluded.some(e => App.Utils.sameColor(e, g));

    const get = (row, sel) => escapeHtml(row.querySelector(sel)?.value.trim() || '');
    const getRaw = (row, sel) => row.querySelector(sel)?.value.trim() || '';

    const commonRows = $$('#productionSheetCommonBody tr').filter(row => row.querySelector('.prod-sheet-item-name'));
    const matrixRows = $$('#productionSheetMatrixTables .prod-sheet-matrix-tbody tr').filter(row => row.querySelector('.prod-sheet-item-name'));

    const commonSection = document.getElementById('print-prod-common-section');
    if (commonSection) commonSection.style.display = commonRows.length > 0 ? '' : 'none';
    const matrixSection = document.getElementById('print-prod-matrix-section');
    const subGroupSection = document.getElementById('print-prod-subgroup-section');

    // A Size column that's "GENERAL"/blank on every row carries no
    // information -- it's the one column the fit loop below is allowed
    // to drop under space pressure. Narration is never dropped.
    const isGenericSize = s => !s || s.toUpperCase() === 'GENERAL';
    const commonSizeDroppable = commonRows.length > 0 && commonRows.every(row => isGenericSize(getRaw(row, '.prod-sheet-size')));
    const matrixSizeDroppable = matrixRows.length > 0 && matrixRows.every(row => isGenericSize(getRaw(row, '.prod-sheet-size')));

    const commonData = commonRows.map(row => ({
      name: get(row, '.prod-sheet-item-name'),
      size: get(row, '.prod-sheet-size'),
      narration: get(row, '.prod-sheet-narration'),
      qty: row.querySelector('.prod-sheet-qty')?.value || '',
      unit: this._sheetRowUnitFromDom(row)
    }));

    const qtyFor = (row, group) => {
      const input = $$('.prod-sheet-color-qty', row).find(el => App.Utils.sameColor(el.dataset.color, group));
      return input?.value || '';
    };
    // Reads back the small "(Pink)"-style tag renderMatrixSheetRow put
    // under that colour's Qty cell (see _cellItemTag) -- not recomputed
    // here, so the print/PDF export can never disagree with what the
    // operator just looked at in the dialog.
    const tagFor = (row, group) => {
      const tagEl = $$('.prod-sheet-color-tag', row).find(el => App.Utils.sameColor(el.dataset.color, group));
      return tagEl?.textContent.trim() || '';
    };
    const toMatrixRow = columns => row => ({
      name: get(row, '.prod-sheet-item-name'),
      size: get(row, '.prod-sheet-size'),
      narration: get(row, '.prod-sheet-narration'),
      unit: this._sheetRowUnitFromDom(row),
      colorQty: columns.map(c => qtyFor(row, c)),
      colorTag: columns.map(c => tagFor(row, c))
    });
    const sheet = App.State.currentProductionSheet || {};
    const allGroups = sheet.colors || [];
    const colors = (sheet.colorGroups || allGroups.filter(c => this._isColorGroupName(c))).filter(kept);
    const subGroups = (sheet.subGroups || allGroups.filter(c => !this._isColorGroupName(c))).filter(kept);

    // Both the Per-Color matrix and Sub-Group Components split into
    // connected clusters of columns -- two columns land in the same
    // printed table only if some row uses BOTH of them together, directly
    // or transitively through a bridging row (e.g. one item legitimately
    // offered in every color in the lot ties otherwise-unrelated subsets
    // into one family, and stays on one table). Columns that are always
    // used together as one family stay consolidated (the common case: a
    // real 6-colour/11-row worst case that must NOT fragment into one
    // table per row signature, or it spills across pages). But two groups
    // that NEVER co-occur on any row -- e.g. a Painted Mudguard's own
    // plain Blue/Pink/Purple/Red axis next to the Frame's compound
    // Blue-White/Black-style axis, or a "KIT BAG 24\"" bucket next to a
    // "SMALL KIT 24\"" bucket that never shares an item -- get their own
    // table instead of doubling every row's column count with dashes (and,
    // for a long component list, needlessly spilling onto extra printed
    // pages).
    const clusterMatrixTables = (columns, rows) => {
      if (columns.length === 0 || rows.length === 0) return [];
      const parent = new Map(columns.map(c => [c, c]));
      const find = c => { while (parent.get(c) !== c) c = parent.get(c); return c; };
      const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

      const rowColumns = rows.map(row => columns.filter(c => String(qtyFor(row, c)).trim() !== ''));
      rowColumns.forEach(set => { for (let i = 1; i < set.length; i++) union(set[0], set[i]); });

      const clusters = new Map(); // root -> { columns: [], rows: [] }
      columns.forEach(c => {
        if (!rowColumns.some(set => set.includes(c))) return; // no row ever uses it -- drop
        const root = find(c);
        if (!clusters.has(root)) clusters.set(root, { columns: [], rows: [] });
        clusters.get(root).columns.push(c);
      });
      rows.forEach((row, i) => {
        const set = rowColumns[i];
        if (set.length === 0) return;
        clusters.get(find(set[0])).rows.push(row);
      });

      return Array.from(clusters.values())
        .filter(g => g.rows.length > 0)
        .map(g => ({ columns: g.columns, data: g.rows.map(toMatrixRow(g.columns)) }));
    };

    const matrixGroups = clusterMatrixTables(colors, matrixRows);
    const subGroupGroups = clusterMatrixTables(subGroups, matrixRows);

    // Each section appears only if it has at least one cluster left after
    // exclusions/empty filtering, so a lot with no sub-groups looks exactly
    // as it always did, and a kit-bag-only lot shows no empty color matrix.
    if (matrixSection) matrixSection.style.display = matrixGroups.length > 0 ? '' : 'none';
    if (subGroupSection) subGroupSection.style.display = subGroupGroups.length > 0 ? '' : 'none';

    // Density tiers the fit loop steps through, tightest last: shrink
    // padding, then font (Item Name + Qty held a step larger and bold --
    // the data a worker actually reads off the sheet -- never below a
    // legible floor), then -- only where Size is droppable -- drop it.
    // If even the tightest tier still overflows, it's kept anyway (still
    // the smallest/cleanest option) and the sheet spills to a page 2,
    // which already gets repeating headers from styles.css's print CSS.
    //
    // Every font size here MUST stay a whole number, and each tier carries
    // an explicit integer lineHeight. html2canvas (the "Download PDF" path)
    // positions each text fragment from its own rounded line-box
    // arithmetic, so a fractional line box -- e.g. a 14.5px font against
    // the container's unitless line-height:1.5, giving 21.75px -- drifts
    // far enough over a few wrapped lines that two of them get painted at
    // the SAME y, rendering long item names as unreadable overlapping mush
    // in the downloaded PDF while window.print() looked fine.
    const FIT_TIERS = [
      { pad: '7px 9px', font: 12, emphasisFont: 15, lineHeight: 20, tableGap: 12, hideSize: false },
      { pad: '5px 8px', font: 11, emphasisFont: 14, lineHeight: 19, tableGap: 9, hideSize: false },
      { pad: '4px 7px', font: 11, emphasisFont: 13, lineHeight: 17, tableGap: 7, hideSize: false },
      { pad: '3px 6px', font: 10, emphasisFont: 12, lineHeight: 16, tableGap: 5, hideSize: true }
    ];
    // Readability palette. The Item Name cannot use bold (see bodyCell), so
    // the hierarchy is carried by size + ink instead: near-black names
    // against deliberately muted grey Size/Narration, so the eye lands on
    // the item first and the supporting columns recede. ZEBRA is a real,
    // visible band and RULE is a light hairline so the banding, not a heavy
    // grid, does the row tracking. GRID_STRONG outlines the table so
    // columns stay anchored.
    const { HEAD_BG, HEAD_INK, ZEBRA, RULE, GRID_STRONG, INK_PRIMARY, INK_MUTED } = this.PRINT_PALETTE;

    // Headers are stepped one size ABOVE the body's own tier.font -- a
    // column header being smaller than the data it labels reads backwards,
    // especially on the color-matrix table where getting the wrong
    // header/column pairing means misreading which color a number belongs
    // to. Safety valve so an over-long token can never spill outside its
    // cell border. overflow-wrap:break-word ONLY -- deliberately not
    // word-break:break-word alongside it, and not overflow-wrap:anywhere;
    // both of those also shrink the column's min-content width and force a
    // mid-token break, which html2canvas then paints at the wrong position
    // as two overlapping lines. vertical-align:top, not the table-cell
    // default of middle -- with middle, html2canvas has to offset the text
    // block inside a taller row, and got that offset wrong whenever a
    // cell's own content height landed exactly on the row height.
    const CELL_VALIGN = 'vertical-align:top;';
    const CELL_WRAP = 'overflow-wrap:break-word;';

    // Item names here are hyphen-chained compounds ("BB---CUP---SET",
    // "CYCLE-CHAIN--110-LINK") that have to wrap somewhere. Adding an
    // explicit break opportunity after every hyphen run keeps them breaking
    // at their own separators instead of at whatever fill point the
    // renderer picks. A zero-width space rather than <wbr>: html2canvas
    // walks text nodes with its own segmenter and skips the <wbr> ELEMENT
    // entirely, so the break opportunity never reached it; U+200B is an
    // ordinary character in the text node, which both engines honour. Each
    // segment becomes its own block line, so the cell never depends on the
    // renderer's own wrapping at all -- html2canvas can only mis-paint a
    // line it had to wrap itself, and there is now nothing left for it to
    // wrap. Single hyphens stay inside their segment (part of the token,
    // e.g. "BRUT-BLACK") but still get a zero-width space after them as a
    // safety valve so an unusually long segment can wrap rather than spill.
    const withBreakPoints = text => String(text)
      .split(/-{2,}/)
      .filter(seg => seg !== '')
      .map(seg => `<span style="display:block;">${seg.replace(/-/g, '$&​')}</span>`)
      .join('');

    // Deliberately AUTO layout, not table-layout:fixed. Fixed layout makes
    // the column percentages binding, which does stop the tables blowing
    // past their grid track -- but html2canvas then mis-measures the
    // column and lays each header out on a single unwrapped line, clipping
    // it mid-word in the PDF. Auto layout is what html2canvas renders
    // faithfully; the track cap on the Common grid plus CELL_WRAP is what
    // keeps the width in bounds.
    const TABLE_STYLE = 'width:100%;border-collapse:collapse;';

    // Item Name is emphasised by SIZE (tier.emphasisFont) and never by
    // weight. html2canvas lays a line out using NORMAL-weight metrics and
    // then paints bold glyphs, so any bold text that WRAPS overruns its
    // measured line and the fragments get painted on top of each other.
    // Bold is still safe, and still used, on cells that cannot wrap: the
    // Qty column (short values like "24 Pcs") and the column headers.
    //
    // opts.nowrap pins a column whose values are always short single
    // tokens (Size: "GENERAL", "20 inch"). Without it auto layout squeezed
    // Size narrow enough to break "GENERAL" into "GEN/ERAL" mid-token.
    const headCell = (label, tier, opts = {}) => {
      const width = opts.width ? `width:${opts.width};` : '';
      const wrap = CELL_VALIGN + (opts.nowrap ? 'white-space:nowrap;' : CELL_WRAP);
      return `<th style="padding:${tier.pad};border:1px solid ${GRID_STRONG};background:${HEAD_BG};color:${HEAD_INK};
                font-weight:700;text-align:${opts.align || 'center'};font-size:${Math.max(tier.font + 1, 10)}px;
                line-height:${tier.lineHeight}px;${wrap}${width}
                -webkit-print-color-adjust:exact;print-color-adjust:exact;">${label}</th>`;
    };
    const bodyCell = (content, tier, opts = {}) => {
      const bg = opts.zebra ? `background:${ZEBRA};` : '';
      const weight = opts.bold ? 'font-weight:700;' : '';
      const fs = opts.emphasis ? tier.emphasisFont : tier.font;
      const wrap = CELL_VALIGN + (opts.nowrap ? 'white-space:nowrap;' : CELL_WRAP);
      const ink = (opts.emphasis || opts.bold) ? INK_PRIMARY : INK_MUTED;
      return `<td style="padding:${tier.pad};border:1px solid ${RULE};text-align:${opts.align || 'left'};
                color:${ink};font-size:${fs}px;line-height:${tier.lineHeight}px;${wrap}${weight}${bg}">${content}</td>`;
    };

    const buildCommonTable = (rows, tier, hideSize) => {
      if (rows.length === 0) return '';
      // Item Name is deliberately generous: an item name that lands within
      // a few px of the column edge is where html2canvas's own text
      // measuring disagrees with the browser's, wraps a token the browser
      // would have kept whole, and paints the two fragments on top of each
      // other. Slack here keeps the common names clear of that boundary.
      let head = headCell('Item Name', tier, { align: 'left', width: hideSize ? '48%' : '40%' });
      if (!hideSize) head += headCell('Size', tier, { width: '16%', nowrap: true });
      head += headCell('Narration', tier, { width: hideSize ? '30%' : '22%' });
      head += headCell('Required Qty', tier, { align: 'right', width: hideSize ? '22%' : '22%' });

      const body = rows.map((r, i) => {
        const zebra = i % 2 === 1;
        let row = bodyCell(withBreakPoints(r.name), tier, { zebra, emphasis: true });
        if (!hideSize) row += bodyCell(r.size || '&#8211;', tier, { align: 'center', zebra, nowrap: true });
        row += bodyCell(r.narration || '&#8211;', tier, { align: 'center', zebra });
        const qtyText = r.qty ? `${escapeHtml(this.formatQty(r.qty))}${r.unit ? ' ' + escapeHtml(r.unit) : ''}` : '&#8211;';
        row += bodyCell(qtyText, tier, { align: 'right', bold: !!r.qty, zebra, emphasis: true });
        return `<tr>${row}</tr>`;
      }).join('');

      return `<table style="${TABLE_STYLE}margin-bottom:${tier.tableGap}px;">
        <thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    };

    // `columns` is passed in rather than closed over, so the same builder
    // renders both the color matrix and the sub-group table.
    const buildMatrixTable = (rows, tier, hideSize, columns) => {
      if (rows.length === 0 || columns.length === 0) return '';
      let head = headCell('Item Name', tier, { align: 'left', width: hideSize ? '30%' : '26%' });
      if (!hideSize) head += headCell('Size', tier, { width: '12%', nowrap: true });
      head += headCell('Narration', tier, { width: hideSize ? '16%' : '12%' });
      columns.forEach(c => { head += headCell(escapeHtml(c), tier, { align: 'right' }); });

      const body = rows.map((r, i) => {
        const zebra = i % 2 === 1;
        let row = bodyCell(withBreakPoints(r.name), tier, { zebra, emphasis: true });
        if (!hideSize) row += bodyCell(r.size || '&#8211;', tier, { align: 'center', zebra, nowrap: true });
        row += bodyCell(r.narration || '&#8211;', tier, { align: 'center', zebra });
        r.colorQty.forEach((val, ci) => {
          const cellText = val ? `${escapeHtml(this.formatQty(val))}${r.unit ? ' ' + escapeHtml(r.unit) : ''}` : '&#8211;';
          // Which literal item this colour's qty refers to, e.g. a "Teddy
          // Basket" row's Blue column reading "(Red)" -- read back from
          // renderMatrixSheetRow's own tag rather than recomputed, so print
          // can never disagree with the dialog. See _cellItemTag.
          const tag = (r.colorTag && r.colorTag[ci]) || '';
          const tagHtml = tag ? `<div style="font-size:${Math.max(tier.font - 2, 8)}px;font-weight:700;color:${INK_MUTED};line-height:1.2;">${escapeHtml(tag)}</div>` : '';
          row += bodyCell(cellText + tagHtml, tier, { align: 'right', bold: !!val, zebra, emphasis: true });
        });
        return `<tr>${row}</tr>`;
      }).join('');

      return `<table style="${TABLE_STYLE}margin-bottom:${tier.tableGap}px;">
        <thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    };

    // Common Components reads as a tall narrow list; past a handful of
    // rows it's cheaper on vertical space split into two side-by-side
    // tables than left as one column with the page's right half empty.
    const COMMON_TWO_COL_THRESHOLD = 8;

    const commonDest = document.getElementById('print-production-sheet-common-tables');
    const matrixDest = document.getElementById('print-production-sheet-matrix-tables');
    const subGroupDest = document.getElementById('print-production-sheet-subgroup-tables');

    const render = tier => {
      if (commonDest) {
        const hideSize = tier.hideSize && commonSizeDroppable;
        if (commonData.length > COMMON_TWO_COL_THRESHOLD) {
          const mid = Math.ceil(commonData.length / 2);
          const left = buildCommonTable(commonData.slice(0, mid), tier, hideSize);
          const right = buildCommonTable(commonData.slice(mid), tier, hideSize);
          // minmax(0,1fr), not 1fr: a bare 1fr track is minmax(auto,1fr) and
          // GROWS past its share to fit a wide item's min-content, which
          // blows the grid wider than the page and pushes the right-hand
          // table off the edge of the PDF.
          commonDest.innerHTML = `<div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;">${left}${right}</div>`;
        } else {
          commonDest.innerHTML = buildCommonTable(commonData, tier, hideSize);
        }
      }
      if (matrixDest) {
        const hideSize = tier.hideSize && matrixSizeDroppable;
        // Stacked full-width, NOT packed side-by-side like Sub-Group
        // Components below: a colour-axis cluster routinely carries 4+
        // columns (a whole colour family), and forcing two of those into a
        // half-width minmax(0,1fr) track overflows the page. Sub-group
        // buckets are usually only 1-2 columns, where half-width is
        // comfortably enough room.
        matrixDest.innerHTML = matrixGroups.map(g => buildMatrixTable(g.data, tier, hideSize, g.columns)).join('');
      }
      if (subGroupDest) {
        const hideSize = tier.hideSize && matrixSizeDroppable;
        const tables = subGroupGroups.map(g => buildMatrixTable(g.data, tier, hideSize, g.columns));
        // Sub-group cluster tables are usually narrow (packing/variant
        // buckets, often just 1-2 columns) -- stacking them full-width one
        // after another leaves most of each row empty and burns extra
        // printed pages for no reason. Same minmax(0,1fr) grid Common
        // Components uses above packs two per row instead; CSS grid
        // auto-placement wraps any further tables onto more rows with no
        // extra layout logic needed.
        subGroupDest.innerHTML = tables.length > 1
          ? `<div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;">${tables.join('')}</div>`
          : tables.join('');
      }
    };

    // Measure-and-compress: lay the container out offscreen at the real
    // A4 printable width (matches the @page margin geometry in
    // styles.css -- keep PAGE_MARGIN_MM in sync with that file's @page
    // rule and mobile_styles.css's copy of it), try each density tier, and
    // stop at the first one that fits a single page -- so nothing shrinks
    // or drops a column unless the sheet actually needs it to.
    const container = document.getElementById('print-production-sheet-container');
    // Geometry comes from App.Print so the sheet is measured at exactly
    // the width downloadElementAsPDF will capture it at. Landscape swaps
    // the page box, so the fit loop must measure against the rotated
    // dimensions or it would compress a sheet that already fits.
    const landscape = this._printOptions().landscape;
    const PAGE_WIDTH_PX = landscape ? App.Print.PAGE_HEIGHT_PX : App.Print.PAGE_WIDTH_PX;
    const PAGE_HEIGHT_PX = landscape ? App.Print.PAGE_WIDTH_PX : App.Print.PAGE_HEIGHT_PX;

    if (container) {
      const prevDisplay = container.style.display;
      const prevPosition = container.style.position;
      const prevVisibility = container.style.visibility;
      const prevWidth = container.style.width;
      const prevLeft = container.style.left;
      const prevTop = container.style.top;

      container.style.position = 'fixed';
      container.style.left = '-10000px';
      container.style.top = '0';
      container.style.visibility = 'hidden';
      container.style.display = 'block';
      container.style.width = PAGE_WIDTH_PX + 'px';

      // A tier only "fits" if it fits BOTH ways. The height test alone let
      // a sheet that was too WIDE pass as fitting, and it exported with
      // its right-hand column sliced off -- html2canvas captures only the
      // element's own box, so anything past it is simply gone. offsetHeight,
      // not scrollHeight: scrollHeight excludes the container's top/bottom
      // accent borders, so a sheet sitting right on the boundary measured
      // shorter than it really printed. A couple px of slack on the width:
      // a fractional track (two halves of the Common grid) can round up by
      // a px each, which is not real overflow.
      const ROUNDING_SLACK_PX = 2;
      const overflows = () =>
        container.offsetHeight > PAGE_HEIGHT_PX ||
        container.scrollWidth > container.clientWidth + ROUNDING_SLACK_PX;

      for (const tier of FIT_TIERS) {
        render(tier);
        if (!overflows()) break;
      }

      container.style.display = prevDisplay;
      container.style.position = prevPosition;
      container.style.visibility = prevVisibility;
      container.style.width = prevWidth;
      container.style.left = prevLeft;
      container.style.top = prevTop;
    } else {
      render(FIT_TIERS[0]);
    }

    const remarksSection = document.getElementById('print-prod-remarks-section');
    const remarksText = document.getElementById('productionSheetRemarks')?.value.trim() || '';
    if (remarksSection) {
      remarksSection.style.display = remarksText ? '' : 'none';
      setText('print-prod-remarks-text', remarksText);
    }
  },

  // Filename: ddmmyy_Size_Model_ProcessName, e.g. 290726_26inch_Eagle_FramePainting
  _sanitizeFilenamePart(text, fallback) {
    return String(text || '').replace(/[^a-zA-Z0-9]/g, '') || fallback;
  },

  _productionSheetFilenameBase(dateStr, size, model, processName) {
    const [dd = '', mm = '', yyyy = ''] = String(dateStr || '').split('/');
    const ddmmyy = `${dd}${mm}${yyyy.slice(-2)}` || 'date';
    return [
      ddmmyy,
      this._sanitizeFilenamePart(size, 'Size'),
      this._sanitizeFilenamePart(model, 'Model'),
      this._sanitizeFilenamePart(processName, 'Process')
    ].join('_');
  },

  // jsPDF/orientation overrides matching the Print options panel, plus the
  // capture width that goes with them -- downloadElementAsPDF lays the
  // element out at App.Print.PAGE_WIDTH_PX by default, which is the
  // PORTRAIT width and would squeeze a landscape sheet.
  _pdfOverridesForOptions() {
    if (!this._printOptions().landscape) return {};
    return {
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' },
      captureWidthPx: App.Print.PAGE_HEIGHT_PX
    };
  },

  async downloadProductionSheetPDF() {
    const state = App.State.currentProductionSheet;
    if (!state) return;

    this._buildProductionSheetForExport();

    const filenameBase = this._productionSheetFilenameBase(state.date, state.size, state.model, state.processName);
    const ok = await App.Print.downloadElementAsPDF(
      'print-production-sheet-container', `${filenameBase}.pdf`, this._pdfOverridesForOptions());
    if (ok) App.Utils.showToast('PDF exported successfully!', false);
  },

  // Bulk "Download PDFs" -- downloads one SEPARATE PDF per selected lot,
  // each the exact same rich Production Sheet a single "View Sheet" +
  // "Download PDF" would produce. Lots are processed one at a time,
  // awaited in sequence rather than in parallel -- every iteration reuses
  // the SAME #print-production-sheet-container, so overlapping
  // html2canvas captures would race and corrupt each other's output.
  async bulkDownloadPDF() {
    const selected = App.State.selectedProduction;
    if (!selected || selected.length === 0) return;

    const lots = App.State.globalProduction.filter(p => App.Selection.isSelected(selected, String(p.rowIdx)));
    if (lots.length === 0) return;

    let successCount = 0;
    for (const p of lots) {
      this._populateProductionSheetData(p);
      this._buildProductionSheetForExport();

      const size = App.Utils.getSizeFromOutputItemName(p.outputItemName);
      const model = App.Utils.getModelFromOutputItemName(p.outputItemName);
      const process = (App.State.globalProcesses || []).find(pr => pr.processId === p.processId);
      const processName = process ? process.processName : (p.processId || 'Process');
      const filenameBase = this._productionSheetFilenameBase(p.date, size, model, processName);
      const filename = `${this._sanitizeFilenamePart(p.lotNumber, 'Lot')}_${filenameBase}.pdf`;

      if (await App.Print.downloadElementAsPDF('print-production-sheet-container', filename)) successCount++;
    }

    App.Utils.showToast(`${successCount} of ${lots.length} production sheet(s) downloaded as separate PDFs.`, successCount < lots.length);
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

    const isNewLot = !document.getElementById('productionRowIdx')?.value;
    const savedRowIdx = document.getElementById('productionRowIdx')?.value || '';

    try {
      const response = await Api.mutate('saveProduction', formData);
      if (response.success) {
        if (isNewLot) {
          // A brand-new lot's sorted/paginated position can't be
          // determined cheaply on the client, so still do a full reload
          // here (an edit doesn't need to, see App.Production.patchRowInPlace).
          await App.Production.loadData();

          // Stay open and re-arm for the next lot instead of closing --
          // operators log many lots back-to-back.
          // NOTE: resetCreateForm must run AFTER the fieldset is re-enabled,
          // not inside a disabled fieldset — Select2 reads .prop('disabled')
          // at init time and caches the disabled state. If initialized while
          // the parent <fieldset> is disabled, Select2 renders disabled and
          // never recovers when the fieldset is later re-enabled.
          const fieldset = document.getElementById('productionFormFieldset');
          if (fieldset) fieldset.disabled = false;
          await App.Production.resetCreateForm();
          document.getElementById('productionSize')?.focus();
        } else {
          // Edit mode "Save": patch just this one row's data + <tr> in
          // place (see patchRowInPlace) instead of a full loadData()
          // reload -- falls back to a full reload if the row can't be
          // patched.
          const patched = response.data && response.data.row
            ? App.Production.patchRowInPlace(response.data.row)
            : false;
          if (!patched) await App.Production.loadData();

          // Stay open (Exit -- App.Nav.exit -- is the only way to close
          // from here now) and re-run this SAME record through
          // openEditModal instead of just leaving the form as-is, so
          // every derived/computed bit of state (Lot Number, color
          // matrix, Nav's dirty-snapshot and N-of-M position) reflects
          // what was just saved. Re-derived by rowIdx (stable) rather
          // than reusing the old positional idx.
          const freshIdx = App.State.globalProduction.findIndex(r => String(r.rowIdx) === savedRowIdx);
          if (freshIdx !== -1) {
            await App.Production.openEditModal(freshIdx);
          } else {
            const modalEl = document.getElementById('editProductionModal');
            if (modalEl) bootstrap.Modal.getOrCreateInstance(modalEl).hide();
          }
        }
      }
      App.Utils.showToast(response.message, !response.success, response.success
        ? { type: 'production', value: response.data?.row?.rowIdx || savedRowIdx }
        : null);
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to save production log', true);
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  };

  document.getElementById('workOrderForm')?.addEventListener('submit', e => App.Production.generateWorkOrderPreview(e));
});
