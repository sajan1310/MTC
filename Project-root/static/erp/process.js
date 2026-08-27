'use strict';
// process.js -- App.Products (tab-level coordinator) + App.Process, ported
// from Apps_Script/Script_Items.html lines 1450-1474 (App.Products) and
// Apps_Script/Script_Process.html (App.Process) in full.
//
// Scope this round: Process Master only. App.BOM (Script_Items.html lines
// 1476+, the "Products" sub-tab) is its own later round -- App.Products'
// own switchSubTab already guards its bomTab branch behind
// `typeof App.BOM !== 'undefined'`, so it's ported as-is unmodified and
// the Products sub-tab shows a placeholder in this round's partial
// instead of throwing. Warehouse Pool (Stock's other sub-tab, deferred in
// Round 7) still isn't wired up either -- it needs its own round now that
// Process exists to actually use it.
//
// Adaptations from source (documented, not silent):
// - saveProcess/deleteProcess/deleteProcessesBulk/reorderProcesses/
//   saveContractorRate/deleteContractorRate all use Api.mutate (not
//   Api.call): every one is mutation=True on the backend, so rpc.py
//   requires a fresh X-Mutation-Id per call.
// - App.Contractor.ensureLoaded() calls (openEditModal, saveContractorRateRow)
//   are guarded against App.Contractor not existing yet (Contractors is
//   its own later round) -- the contractor-rate mini-table's select2
//   picker still works via tags:true (type a name, it saves as free
//   text), it just starts with an empty suggestion list until then.
// - bulkPrint is guarded behind App.Print not existing yet; its builder
//   (buildProcessPrintPageHtml) stays as ported dead code.

App.Products = {
  async enterTab() {
    this.switchSubTab('processTab');
  },

  switchSubTab(id) {
    $$('.products-sub-tab').forEach(t => t.style.display = 'none');
    const target = document.getElementById(id);
    if (target) target.style.display = 'block';

    $$('#productsSubTabs .nav-link').forEach(btn => btn.classList.remove('active'));
    document.getElementById('btn-' + id)?.classList.add('active');

    if (id === 'processTab' && typeof App.Process !== 'undefined') {
      App.Process.loadData();
      // Process table groups by Model and Process Type (see
      // App.Process.renderTable) -- both masters need to be loaded even
      // when landing on this sub-tab directly, not just via the BOM
      // sub-tab's own enterTab().
      App.Model.ensureLoaded();
      App.ProcessType.ensureLoaded();
    }
    if (id === 'bomTab' && typeof App.BOM !== 'undefined') App.BOM.enterTab();
  }
};

// ==========================================
// PROCESS MASTER NAMESPACE
// ==========================================
App.State.processColumnFilters = { processType: [], outputItem: [], finalStage: [], active: [] };

App.Process = {
  GROUP_ORDER_STORAGE_KEY: 'processGroupOrder',

  // Bumped at the start of every openCreateModal/openEditModal/openDuplicateModal
  // call. Each of those awaits an API call before rendering into the shared
  // #processComponentsBody / color-group DOM, so a second click (same row or a
  // different one) before the first's await resolves must not let the stale
  // call's render run afterwards -- that double-appends rows since renders only
  // clear at the *start* of the function, not right before they paint. Every
  // render is guarded by re-checking this counter right after its await.
  _modalLoadSeq: 0,

  // Union of known color combinations detected across every POOL-sourced
  // component row currently on the form (Common + every Color Sub-Group
  // card), refreshed by refreshUpstreamColorCombos. Once non-empty, the
  // Color/Sub-Group picker (see _buildColorGroupOptionsHtml) restricts
  // itself to ONLY these names instead of the full Color Master list, so a
  // sub-group can't end up named something that isn't actually one of the
  // referenced process's colors.
  _upstreamColorCombos: [],
  _upstreamColorSeq: 0,

  // The 3 dimensions selectable in the "Group by" dropdowns. getValue
  // returns the dimension's value for a process row; rank orders those
  // values the same way the row-level dropdown already orders them
  // elsewhere (Process Type Master order, Model Master order, or
  // PROCESS_SIZE_LIST), with unrecognized/blank values sorted last as
  // 'General'.
  GROUP_DIMENSIONS: {
    size: {
      label: 'Size',
      getValue: p => App.Utils.getSizeFromOutputItemName(p.outputItemName),
      rank: value => {
        const i = App.Utils.PROCESS_SIZE_LIST.indexOf(value);
        return i === -1 ? App.Utils.PROCESS_SIZE_LIST.length : i;
      }
    },
    type: {
      label: 'Process Type',
      getValue: p => {
        const raw = p.processType || 'General';
        const match = (App.State.globalProcessTypes || []).find(t => App.Utils.sameText(t.name, raw));
        return match ? match.name : raw;
      },
      rank: value => {
        const names = (App.State.globalProcessTypes || []).map(t => t.name);
        const i = names.indexOf(value);
        return i === -1 ? names.length : i;
      }
    },
    model: {
      label: 'Model',
      getValue: p => App.Utils.getModelFromOutputItemName(p.outputItemName),
      rank: value => {
        const names = (App.State.globalModels || []).map(m => m.name);
        const i = names.indexOf(value);
        return i === -1 ? names.length : i;
      }
    }
  },

  // One Map<value, rankIndex> per active tier, built ONCE per render.
  buildRankMaps(tiers) {
    return tiers.map(dim => {
      const names = dim === 'size' ? App.Utils.PROCESS_SIZE_LIST
        : dim === 'type' ? (App.State.globalProcessTypes || []).map(t => t.name)
        : (App.State.globalModels || []).map(m => m.name);
      const map = new Map();
      names.forEach((n, i) => { if (!map.has(n)) map.set(n, i); });
      return { map, fallback: names.length };
    });
  },

  // Restores the saved tier order (if any) and (re)populates the 3
  // "Group by" dropdowns. Each dropdown's options exclude whichever
  // dimensions are already chosen in the other two dropdowns, so the
  // same dimension can never be picked twice -- leaving a dropdown on
  // "None" simply drops that tier.
  initGroupDropdowns() {
    let saved = null;
    try {
      const raw = localStorage.getItem(this.GROUP_ORDER_STORAGE_KEY);
      if (raw) saved = JSON.parse(raw);
    } catch (e) {
      // Ignored -- falls back to the default order below.
    }
    if (Array.isArray(saved) && saved.length === 3) App.State.processGroupOrder = saved;

    const order = App.State.processGroupOrder;
    for (let i = 0; i < 3; i++) {
      const select = document.getElementById(`processGroupTier${i + 1}`);
      if (!select) continue;
      const usedElsewhere = order.filter((dim, idx) => idx !== i && dim);
      let optionsHtml = '<option value="">None</option>';
      Object.keys(this.GROUP_DIMENSIONS).forEach(dim => {
        if (usedElsewhere.includes(dim)) return;
        optionsHtml += `<option value="${dim}">${escapeHtml(this.GROUP_DIMENSIONS[dim].label)}</option>`;
      });
      select.innerHTML = optionsHtml;
      select.value = order[i] || '';
    }
  },

  onGroupOrderChange() {
    const order = [1, 2, 3].map(i => document.getElementById(`processGroupTier${i}`).value);
    App.State.processGroupOrder = order;
    try {
      localStorage.setItem(this.GROUP_ORDER_STORAGE_KEY, JSON.stringify(order));
    } catch (e) {
      // Ignored -- the order just won't persist across reloads.
    }
    App.State.collapsedProcessGroups = new Set();
    this.initGroupDropdowns();
    this.renderTable();
  },

  async loadData() {
    this.initGroupDropdowns();
    const tbody = document.getElementById('processTableBody');
    if (tbody) App.Utils.tableLoading(tbody, 11, 'Loading Processes...');

    try {
      const response = await Api.call('getProcessData');
      if (!response.success) {
        App.Utils.showToast(response.message, true);
        App.Utils.tableError(tbody, response.message);
        return;
      }
      App.State.globalProcesses = response.data;
      App.State.selectedProcesses = [];
      this.updateColumnFilterIcons();
      this.filterData(App.State.processSearchTerm || '');
    } catch (err) {
      App.Utils.tableError(tbody, err && err.message);
      App.Utils.showToast(err.message || 'Failed to load processes', true);
    }
  },

  // Ensures App.State.globalProcesses is populated (used by the Production
  // tab's Process dropdown without requiring the Process Master tab to
  // have been visited first).
  async ensureLoaded() {
    if (App.State.globalProcesses && App.State.globalProcesses.length) return;
    try {
      const response = await Api.call('getProcessData');
      if (response.success) App.State.globalProcesses = response.data;
    } catch (err) {
      // Ignored -- Process dropdown will simply be empty until it loads elsewhere.
    }
  },

  // Rewrites the narration STORED on every active process's ITEM-sourced
  // components to the current Items Master value
  // (process_service.refresh_process_components_from_items_master).
  //
  // Every OTHER narration display (the Create/Edit Process form,
  // Production's recipe-driven auto-populate, this file's own print/PDF
  // export) already resolves narration LIVE against Items Master (see
  // _resolveDisplayNarration) and needs no such refresh -- this is for the
  // STORED value itself: catching up components saved before an Items
  // Master value was set/corrected, and anything that ever reads
  // narration straight off the database instead of through this file.
  refreshNarrationsFromItemsMaster() {
    App.Utils.confirmAction(
      'Refresh the narration stored on every process\'s components to match Items Master?\n\n' +
      'Only narration is touched -- quantities, item identities, color groups, and every other field are never ' +
      'changed. Warehouse Pool components (whose "item" is another process\'s own output, not an Items Master ' +
      'entry) are skipped.',
      async () => {
        const btn = document.getElementById('btnRefreshProcessNarrations');
        const original = btn?.innerHTML;
        if (btn) {
          btn.disabled = true;
          btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Refreshing...';
        }
        try {
          const res = await Api.mutate('refreshProcessComponentsFromItemsMaster');
          App.Utils.showToast(res.message, !res.success);
          if (res.success) await this.loadData();
        } catch (err) {
          App.Utils.showToast(err.message || 'Failed to refresh process components from Items Master', true);
        } finally {
          if (btn) {
            btn.disabled = false;
            btn.innerHTML = original;
          }
        }
      }
    );
  },

  filterData(searchTerm) {
    App.State.processSearchTerm = searchTerm || '';
    const term = String(searchTerm || '').toLowerCase().trim();
    const base = term
      ? App.State.globalProcesses.filter(p => {
        const haystack = [p.processId, p.processName, p.lotPrefix, p.remarks].join(' ');
        return App.Utils.matchesKeywords(haystack, term);
      })
      : App.State.globalProcesses;
    App.State.filteredProcesses = this.applyColumnFilters(base);
    this.renderTable();
  },

  // Computes the value list for a column's filter dropdown. Final
  // Stage/Active use fixed Yes/No / Active/Inactive option pairs (so both
  // always appear regardless of what's currently loaded); Process Type
  // and Output Item Name are derived from whatever's actually loaded,
  // matching rowHtml's own raw display text so an option can never drift
  // from what the row shows.
  getColumnFilterOptions(key) {
    if (key === 'finalStage') return [{ value: 'Yes', label: 'Yes' }, { value: 'No', label: 'No' }];
    if (key === 'active') return [{ value: 'Active', label: 'Active' }, { value: 'Inactive', label: 'Inactive' }];

    const values = new Set();
    (App.State.globalProcesses || []).forEach(p => {
      if (key === 'processType') {
        if (p.processType) values.add(p.processType);
      } else if (key === 'outputItem') {
        if (p.outputItemName) values.add(p.outputItemName);
      }
    });

    return [...values]
      .sort((a, b) => a.localeCompare(b))
      .map(v => ({ value: v, label: v }));
  },

  // Updates the funnel icon's active state in each header cell to reflect
  // whether that column currently has a filter applied. Scoped to the
  // Processes sub-tab so it never touches Item Master's/Production Log's
  // own same-named .th-filter-btn buttons.
  updateColumnFilterIcons() {
    document.querySelectorAll('#processTab .th-filter-btn').forEach(btn => {
      const key = btn.dataset.filterKey;
      const active = (App.State.processColumnFilters[key] || []).length > 0;
      btn.classList.toggle('active', active);
    });
  },

  // Opens (or closes, if already open for this column) the Excel-style
  // checklist dropdown anchored under the clicked header's funnel icon.
  toggleColumnFilter(evt, key) {
    evt.stopPropagation();
    let panel = document.getElementById('processColFilterPanel');

    if (panel && panel.dataset.key === key) {
      panel.remove();
      return;
    }
    if (panel) panel.remove();

    const btn = evt.currentTarget;
    panel = document.createElement('div');
    panel.id = 'processColFilterPanel';
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
      const selected = App.State.processColumnFilters[key] || [];
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
      App.State.processColumnFilters[key] = [...new Set([...(App.State.processColumnFilters[key] || []), ...visibleValues])];
      this.onColumnFilterChange(key);
      renderOptions(t);
    });

    panel.querySelector('[data-action="clear"]').addEventListener('click', () => {
      App.State.processColumnFilters[key] = [];
      this.onColumnFilterChange(key);
      renderOptions(searchInput.value);
    });

    optionsList.addEventListener('click', e => {
      const li = e.target.closest('.po-ms-option');
      if (!li) return;
      const val = li.dataset.value;
      const sel = App.State.processColumnFilters[key] || (App.State.processColumnFilters[key] = []);
      const idx = sel.indexOf(val);
      if (idx === -1) sel.push(val);
      else sel.splice(idx, 1);
      this.onColumnFilterChange(key);
      renderOptions(searchInput.value);
    });

    renderOptions('');
    requestAnimationFrame(() => searchInput.focus());

    if (!document.body.dataset.processColFilterOutsideClickBound) {
      document.body.dataset.processColFilterOutsideClickBound = '1';
      document.addEventListener('click', e => {
        const openPanel = document.getElementById('processColFilterPanel');
        if (openPanel && !openPanel.contains(e.target) && !e.target.closest('.th-filter-btn')) {
          openPanel.remove();
        }
      });
    }
  },

  onColumnFilterChange(key) {
    this.updateColumnFilterIcons();
    this.filterData(App.State.processSearchTerm || '');
  },

  clearColumnFilters() {
    App.State.processColumnFilters = { processType: [], outputItem: [], finalStage: [], active: [] };
    document.getElementById('processColFilterPanel')?.remove();
    this.updateColumnFilterIcons();
    this.filterData(App.State.processSearchTerm || '');
  },

  // Narrows a base list down to rows matching every active per-column
  // filter (AND across columns, OR within a column's checked values).
  applyColumnFilters(items) {
    const { processType, outputItem, finalStage, active } = App.State.processColumnFilters;
    if (!processType.length && !outputItem.length && !finalStage.length && !active.length) return items;

    return items.filter(p => {
      if (processType.length && !processType.includes(p.processType || '')) return false;
      if (outputItem.length && !outputItem.includes(p.outputItemName || '')) return false;
      if (finalStage.length && !finalStage.includes(p.isFinalStage ? 'Yes' : 'No')) return false;
      if (active.length && !active.includes(p.active ? 'Active' : 'Inactive')) return false;
      return true;
    });
  },

  renderTable() {
    const tbody = document.getElementById('processTableBody');
    if (!tbody) return;

    const emptyState = document.getElementById('processEmptyState');
    if (App.State.filteredProcesses.length === 0) {
      tbody.innerHTML = '';
      if (emptyState) emptyState.style.display = 'block';
      this.updateBulkButtons();
      return;
    }
    if (emptyState) emptyState.style.display = 'none';

    const selectAllChk = document.getElementById('selectAllProcesses');
    if (selectAllChk) {
      selectAllChk.checked = App.State.filteredProcesses.length > 0 &&
        App.State.filteredProcesses.every(p => App.Selection.isSelected(App.State.selectedProcesses, p.processId));
    }

    const tiers = App.State.processGroupOrder
      .filter(dim => dim && App.Process.GROUP_DIMENSIONS[dim]);

    const searchEl = document.getElementById('searchProcess');
    const isSearchFiltered = !!(searchEl && searchEl.value.trim());
    const dragEnabled = tiers.length === 0 && !isSearchFiltered;

    const rankMaps = this.buildRankMaps(tiers);
    const keyedProcesses = App.State.filteredProcesses.map(p => ({
      row: p,
      keys: tiers.map((dim, idx) => {
        const value = App.Process.GROUP_DIMENSIONS[dim].getValue(p);
        const rm = rankMaps[idx];
        return { value, rank: rm.map.has(value) ? rm.map.get(value) : rm.fallback };
      })
    }));
    keyedProcesses.sort((a, b) => {
      for (let i = 0; i < tiers.length; i++) {
        const ka = a.keys[i], kb = b.keys[i];
        if (ka.value !== kb.value) {
          const rankDiff = ka.rank - kb.rank;
          if (rankDiff !== 0) return rankDiff;
          return ka.value < kb.value ? -1 : 1;
        }
      }
      return a.row.sequence - b.row.sequence;
    });
    const sorted = keyedProcesses.map(k => k.row);

    const collapsed = App.State.collapsedProcessGroups;
    let html = '';
    const lastValues = new Array(tiers.length).fill(undefined);
    sorted.forEach(p => {
      let keyPrefix = '';
      let hiddenByCollapse = false;
      for (let level = 0; level < tiers.length; level++) {
        const dim = tiers[level];
        const def = App.Process.GROUP_DIMENSIONS[dim];
        const value = def.getValue(p);
        keyPrefix += `${dim}:${value}`;
        if (value !== lastValues[level]) {
          lastValues[level] = value;
          for (let deeper = level + 1; deeper < tiers.length; deeper++) lastValues[deeper] = undefined;
          if (!hiddenByCollapse) {
            const groupKey = keyPrefix;
            const isCollapsed = collapsed.has(groupKey);
            const chevron = isCollapsed ? 'bi-chevron-right' : 'bi-chevron-down';
            const leadCells = '<td></td>'.repeat(level + 1);
            const colspan = 10 - level;
            const indentClass = level === 0 ? 'fw-bold py-2' : `fw-semibold py-1 ps-${Math.min(level + 3, 5)} small`;
            html += `<tr class="table-light process-group-header" style="cursor:pointer;" onclick="App.Process.toggleGroup('${escapeHtml(groupKey)}')">
      ${leadCells}<td colspan="${colspan}" class="text-secondary ${indentClass}"><i class="bi ${chevron} me-2"></i>${escapeHtml(value)}</td>
    </tr>`;
          }
        }
        keyPrefix += '|';
        if (collapsed.has(keyPrefix.slice(0, -1))) hiddenByCollapse = true;
      }
      if (hiddenByCollapse) return;
      html += this.rowHtml(p, dragEnabled);
    });

    tbody.innerHTML = html;
    this.updateBulkButtons();
  },

  // Renders one <tr> for a process (no group headers -- those are built
  // inline in renderTable, which is the only caller that needs them).
  // Shared by renderTable's full rebuild and patchRowInPlace's single-row
  // swap below.
  rowHtml(p, dragEnabled) {
    const idx = App.State.globalProcesses.indexOf(p);
    const checked = App.Selection.isSelected(App.State.selectedProcesses, p.processId) ? 'checked' : '';
    const rowAttrs = dragEnabled
      ? `draggable="true" ondragstart="App.Process.onDragStart(event,'${escapeHtml(p.processId)}')" ondragover="App.Process.onDragOver(event)" ondrop="App.Process.onDrop(event,'${escapeHtml(p.processId)}')" ondragend="App.Process.onDragEnd(event)"`
      : '';
    const handleCell = dragEnabled
      ? '<td class="text-center text-muted" style="cursor:grab;"><i class="bi bi-grip-vertical"></i></td>'
      : '<td></td>';
    return `<tr ${rowAttrs} data-process-key="${escapeHtml(p.processId)}">
    ${handleCell}
    <td class="text-center"><input type="checkbox" class="form-check-input process-select-chk" data-key="${escapeHtml(p.processId)}" ${checked} onchange="App.Process.onRowSelectChange()"></td>
    <td><span class="badge bg-dark fs-6 shadow-sm">${escapeHtml(p.processId)}</span></td>
    <td><strong>${escapeHtml(p.processName)}</strong></td>
    <td class="text-center">${escapeHtml(String(p.sequence))}</td>
    <td class="text-center"><span class="badge bg-secondary">${escapeHtml(p.lotPrefix)}</span></td>
    <td>${escapeHtml(p.processType || '')}</td>
    <td>${escapeHtml(p.outputItemName || '')}</td>
    <td class="text-center">${p.isFinalStage ? '<span class="badge bg-success">Yes</span>' : '<span class="badge bg-light text-dark">No</span>'}</td>
    <td class="text-center">${p.active ? '<span class="badge bg-success">Active</span>' : '<span class="badge bg-danger">Inactive</span>'}</td>
    <td class="text-center">
      <button class="btn btn-sm btn-outline-primary btn-action mb-1" onclick="App.Process.openEditModal('${idx}')">Edit</button>
      <button class="btn btn-sm btn-outline-dark btn-action mb-1" onclick="App.Process.openDuplicateModal('${idx}')">Duplicate</button>
      <button class="btn btn-sm btn-danger btn-action" onclick="App.Process.delete('${escapeHtml(p.processId)}')">Delete</button>
    </td>
  </tr>`;
  },

  // Patches one already-loaded process's data + its rendered <tr> after an
  // edit save, instead of a full loadData() reload. processId is
  // server-assigned and never user-editable, so this is a safe stable
  // key.
  //
  // Only swaps the single <tr> in place when the table is in its flat,
  // ungrouped, unfiltered view -- group headers (see renderTable's tiers/
  // lastValues walk) are inline with data rows and depend on each row's
  // position relative to its neighbors, so a change to whatever field the
  // active "Group by" dimensions key off of could move this row to a
  // different group entirely. In that case (or search-filtered), this
  // still mutates the in-memory record and does a full renderTable() -- a
  // client-side re-render from already-correct data, NOT a server reload
  // -- so the group/search UI stays consistent.
  //
  // Returns false only when the process isn't currently loaded at all
  // (caller falls back to loadData()); a grouped/filtered re-render is
  // reported as a successful patch since it never hit the network.
  patchRowInPlace(freshProcess) {
    const key = String(freshProcess.processId);
    const existing = App.State.globalProcesses.find(p => String(p.processId) === key);
    if (!existing) return false;

    Object.assign(existing, freshProcess);

    const tiers = App.State.processGroupOrder.filter(dim => dim && App.Process.GROUP_DIMENSIONS[dim]);
    const searchEl = document.getElementById('searchProcess');
    const isSearchFiltered = !!(searchEl && searchEl.value.trim());

    if (tiers.length > 0 || isSearchFiltered) {
      this.renderTable();
      return true;
    }

    const tr = document.querySelector(`#processTableBody tr[data-process-key="${key}"]`);
    if (!tr) return false;

    tr.outerHTML = this.rowHtml(existing, true);
    return true;
  },

  // Drag-and-drop manual reorder (flat/ungrouped view only -- see
  // renderTable's dragEnabled check).
  _dragSrcId: null,

  onDragStart(e, processId) {
    this._dragSrcId = processId;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', processId); } catch (err) { /* ignored */ }
    }
  },

  onDragOver(e) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  },

  async onDrop(e, targetProcessId) {
    e.preventDefault();
    const srcId = this._dragSrcId;
    this._dragSrcId = null;
    if (!srcId || srcId === targetProcessId) return;

    const order = [...App.State.globalProcesses].sort((a, b) => a.sequence - b.sequence).map(p => p.processId);
    const fromIdx = order.indexOf(srcId);
    if (fromIdx === -1 || order.indexOf(targetProcessId) === -1) return;
    order.splice(fromIdx, 1);
    const toIdx = order.indexOf(targetProcessId);
    order.splice(toIdx, 0, srcId);

    try {
      const res = await Api.mutate('reorderProcesses', order);
      if (!res.success) {
        App.Utils.showToast(res.message, true);
        return;
      }
      this.loadData();
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to reorder processes', true);
    }
  },

  onDragEnd() {
    this._dragSrcId = null;
  },

  toggleGroup(groupKey) {
    const collapsed = App.State.collapsedProcessGroups;
    if (collapsed.has(groupKey)) collapsed.delete(groupKey);
    else collapsed.add(groupKey);
    this.renderTable();
  },

  toggleSelectAll(masterChk) {
    App.Selection.toggleAll(App.State.selectedProcesses, 'process-select-chk', masterChk);
    this.updateBulkButtons();
  },

  onRowSelectChange() {
    App.Selection.syncFromRows(App.State.selectedProcesses, 'process-select-chk', 'selectAllProcesses');
    this.updateBulkButtons();
  },

  updateBulkButtons() {
    const count = App.State.selectedProcesses.length;
    App.Selection.updateButton('btnBulkDeleteProcesses', count, '<i class="bi bi-trash"></i> Delete Selected');
    App.Selection.updateButton('btnBulkPrintProcesses', count, '<i class="bi bi-printer"></i> Print Selected');
    App.Selection.updateButton('btnBulkDownloadPdfProcesses', count, '<i class="bi bi-file-earmark-pdf"></i> Download PDFs');
  },

  async bulkDelete() {
    const selected = App.State.selectedProcesses.slice();
    if (selected.length === 0) return;

    App.Utils.confirmAction(
      `Are you sure you want to permanently delete ${selected.length} process(es)? Processes already referenced by Production lots or a Product's BOM will be skipped.`,
      async () => {
        try {
          const res = await Api.mutate('deleteProcessesBulk', selected);
          App.Utils.showToast(res.message, !res.success);
          if (res.success) {
            App.State.selectedProcesses = [];
            await this.loadData();
          }
        } catch (err) {
          App.Utils.showToast(err.message || 'Failed to delete processes', true);
        }
      }
    );
  },

  async bulkPrint() {
    if (typeof App.Print === 'undefined') {
      App.Utils.notPortedYet('Printing');
      return;
    }

    const selected = App.State.selectedProcesses;
    if (selected.length === 0) return;

    const processes = App.State.globalProcesses.filter(p => App.Selection.isSelected(selected, p.processId));
    if (processes.length === 0) return;

    try {
      const withComponents = await Promise.all(processes.map(async p => {
        const res = await Api.call('getProcessComponentsData', p.processId);
        return Object.assign({}, p, { components: res.success ? res.data : [] });
      }));
      App.Print.triggerBulk(withComponents, p => this.buildProcessPrintPageHtml(p), 'Process_Sheets_Selected');
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to prepare processes for printing', true);
    }
  },

  // "Download PDFs" -- one separately-named sheet per selected process. Each
  // sheet needs its component list fetched first, same as bulkPrint.
  async bulkDownloadPDF() {
    const selected = App.State.selectedProcesses;
    if (selected.length === 0) return;

    const processes = App.State.globalProcesses.filter(p => App.Selection.isSelected(selected, p.processId));
    if (processes.length === 0) return;

    try {
      const withComponents = await Promise.all(processes.map(async p => {
        const res = await Api.call('getProcessComponentsData', p.processId);
        return Object.assign({}, p, { components: res.success ? res.data : [] });
      }));

      await App.Print.downloadMany(
        withComponents.map(p => ({
          filename: App.Print.docFilename({ type: 'PRC', key: p.processId, party: p.processName }),
          html: this.buildProcessPrintPageHtml(p)
        })),
        App.Print.bulkZipName('PRC'),
        { buttonId: 'btnBulkDownloadPdfProcesses' }
      );
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to prepare processes for export', true);
    }
  },
  // Builds a self-contained "Process Master / Recipe Card" print page,
  // styled to match buildBOMPrintPageHtml's card layout.
  buildProcessPrintPageHtml(p) {
    const BRAND = '#6610f2';
    const reportDate = new Date().toLocaleDateString('en-GB');

    let rowsHtml = '';
    (p.components || []).forEach(c => {
      const colorGroup = c.colorGroup && c.colorGroup !== 'COMMON' ? c.colorGroup : 'Common';
      // Live from Items Master, not the recipe row's own possibly-stale
      // stored value -- same reason addComponentRow resolves it live for
      // the edit form (see _resolveDisplayNarration); this print/PDF path
      // was the one place still reading the raw stored value.
      const narration = this._resolveDisplayNarration(c.itemName, c.size, c.narration, c.sourceType === 'POOL');
      rowsHtml += `<tr>
      <td style="padding:6px;border:1px solid #e5e5e5;font-weight:600;">${escapeHtml(c.itemName)}</td>
      <td style="padding:6px;border:1px solid #e5e5e5;">${escapeHtml(c.size || '-')}</td>
      <td style="padding:6px;border:1px solid #e5e5e5;color:#555;">${escapeHtml(narration || '-')}</td>
      <td style="padding:6px;border:1px solid #e5e5e5;text-align:center;">${escapeHtml(colorGroup)}</td>
      <td style="padding:6px;border:1px solid #e5e5e5;text-align:center;">${Number(toNumber(c.qtyPerUnit).toFixed(4))}</td>
      <td style="padding:6px;border:1px solid #e5e5e5;">${escapeHtml(c.remarks || '-')}</td>
    </tr>`;
    });

    const componentsHtml = rowsHtml ? `
  <div style="margin-bottom:14px;page-break-inside:avoid;break-inside:avoid;">
    <h6 style="color:${BRAND};font-size:11px;font-weight:700;margin:0 0 8px 0;text-transform:uppercase;letter-spacing:0.5px;-webkit-print-color-adjust:exact;print-color-adjust:exact;">Components Involved</h6>
    <table style="width:100%;border-collapse:collapse;font-size:11px;">
      <thead>
        <tr style="background-color:${BRAND};color:#fff;font-weight:700;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
          <th style="padding:6px;border:1px solid #bbb;text-align:left;width:22%;">Item Name</th>
          <th style="padding:6px;border:1px solid #bbb;text-align:left;width:10%;">Size</th>
          <th style="padding:6px;border:1px solid #bbb;text-align:left;width:24%;">Narration</th>
          <th style="padding:6px;border:1px solid #bbb;text-align:center;width:12%;">Color Group</th>
          <th style="padding:6px;border:1px solid #bbb;text-align:center;width:12%;">Qty/Unit</th>
          <th style="padding:6px;border:1px solid #bbb;text-align:left;width:20%;">Remarks</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  </div>` : '';

    const remarksHtml = p.remarks ? `
  <div style="margin-top:10px;padding-top:8px;border-top:1px solid #ccc;">
    <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Remarks</span>
    <div style="font-size:12px;color:#1a1a1a;margin-top:2px;white-space:pre-wrap;">${escapeHtml(p.remarks)}</div>
  </div>` : '';

    return `
<div style="background:#fff;color:#1a1a1a;font-family:'Segoe UI',Arial,sans-serif;font-size:12px;line-height:1.5;padding:14px 20px 12px 20px;margin:0;box-sizing:border-box;width:100%;border-top:5px solid ${BRAND};border-bottom:3px solid ${BRAND};-webkit-print-color-adjust:exact;print-color-adjust:exact;">
  <div style="text-align:center;padding:4px 0 8px 0;">
    ${App.Print.brandHeaderHtml(BRAND)}
    <div style="font-size:11px;color:${BRAND};font-weight:700;margin-top:4px;letter-spacing:1px;text-transform:uppercase;">
      Process Master &mdash; Recipe Card
    </div>
  </div>
  <div style="height:2px;background:${BRAND};margin:0 0 12px 0;-webkit-print-color-adjust:exact;print-color-adjust:exact;"></div>

  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
    <div style="text-align:left;">
      <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Process ID</span>
      <div style="font-size:15px;font-weight:700;color:${BRAND};-webkit-print-color-adjust:exact;print-color-adjust:exact;">${escapeHtml(p.processId)}</div>
    </div>
    <div style="flex:1;text-align:center;">
      <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Process Name</span>
      <div style="font-size:16px;font-weight:700;color:#111;">${escapeHtml(p.processName)}</div>
    </div>
    <div style="text-align:right;">
      <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Report Date</span>
      <div style="font-size:13px;font-weight:700;color:#1a1a1a;">${reportDate}</div>
    </div>
  </div>

  <div style="height:1px;background:#bbb;margin-bottom:14px;"></div>

  <div style="display:flex;gap:18px;margin-bottom:14px;font-size:11px;">
    <div><span style="color:#666;text-transform:uppercase;letter-spacing:0.5px;">Sequence:</span> <strong>${escapeHtml(String(p.sequence))}</strong></div>
    <div><span style="color:#666;text-transform:uppercase;letter-spacing:0.5px;">Lot Prefix:</span> <strong>${escapeHtml(p.lotPrefix)}</strong></div>
    <div><span style="color:#666;text-transform:uppercase;letter-spacing:0.5px;">Output Item:</span> <strong>${escapeHtml(p.outputItemName || '-')}</strong></div>
    <div><span style="color:#666;text-transform:uppercase;letter-spacing:0.5px;">Final Stage:</span> <strong>${p.isFinalStage ? 'Yes' : 'No'}</strong></div>
    <div><span style="color:#666;text-transform:uppercase;letter-spacing:0.5px;">Active:</span> <strong>${p.active ? 'Yes' : 'No'}</strong></div>
  </div>

  ${componentsHtml}
  ${remarksHtml}
</div>`;
  },

  // Suggests a Lot Prefix from a Process Name's word-initials (e.g. "Frame
  // Painting" -> "FP"), de-duplicated against every other process's prefix.
  suggestLotPrefix(name) {
    const words = String(name || '').trim().split(/\s+/)
      .map(w => w.replace(/[^A-Za-z0-9]/g, ''))
      .filter(Boolean);
    if (!words.length) return '';
    let base = words.map(w => w[0]).join('').toUpperCase().slice(0, 6);
    if (base.length < 2) base = words[0].slice(0, 2).toUpperCase();

    const taken = new Set((App.State.globalProcesses || []).map(p => (p.lotPrefix || '').toUpperCase()));
    if (!taken.has(base)) return base;
    for (let n = 2; n < 100; n++) {
      const suffix = String(n);
      const candidate = (base.slice(0, 6 - suffix.length) + suffix).toUpperCase();
      if (!taken.has(candidate)) return candidate;
    }
    return base;
  },

  // Process Name input handler -- keeps the Lot Prefix suggestion in sync
  // while the operator is still typing the name, but only until they've
  // touched Lot Prefix themselves (markLotPrefixEdited) or the field is
  // locked (editing an existing process).
  handleNameInput(inputEl) {
    const prefixEl = document.getElementById('processFormLotPrefix');
    if (!prefixEl || prefixEl.readOnly || prefixEl.dataset.userEdited === '1') return;
    prefixEl.value = this.suggestLotPrefix(inputEl.value);
  },

  markLotPrefixEdited() {
    const prefixEl = document.getElementById('processFormLotPrefix');
    if (prefixEl) prefixEl.dataset.userEdited = '1';
  },

  async openCreateModal() {
    const seq = ++this._modalLoadSeq;

    const form = document.getElementById('processForm');
    if (form) form.reset();

    document.getElementById('processFormProcessId').value = '';
    document.getElementById('processFormActive').checked = true;
    document.getElementById('processFormIsFinalStage').checked = false;
    document.getElementById('processFormOutputItemName').value = '';

    const prefixEl = document.getElementById('processFormLotPrefix');
    prefixEl.readOnly = false;
    prefixEl.dataset.userEdited = '';
    const prefixHelp = document.getElementById('processFormLotPrefixHelp');
    if (prefixHelp) prefixHelp.textContent = 'Auto-suggested from Process Name as you type — edit if you\'d prefer a different short code.';

    this.clearComponentsTable();
    this.clearColorGroups();
    this._presetDispatchDifferentiator = '';
    this.loadPoolColorAxisLabels('');
    this.clearColorLinks();
    this.toggleColorLinksAvailability(false);
    this.clearContractorRatesTable();
    await App.Color.ensureLoaded();
    await App.ProcessType.ensureLoaded();
    if (typeof App.Item !== 'undefined') App.Item.ensureLoaded();
    if (seq !== this._modalLoadSeq) return;
    App.ProcessType.populateSelect();
    const newProcTypeEl = document.getElementById('processFormProcessType');
    if (newProcTypeEl) {
      newProcTypeEl.value = '';
      if (window.jQuery?.fn?.select2 && window.jQuery(newProcTypeEl).data('select2'))
        window.jQuery(newProcTypeEl).trigger('change.select2');
    }

    document.getElementById('processFormTitle').innerText = 'Add Process';
    document.getElementById('processSubmitBtn').innerText = 'Save Process';
    this.toggleImportBar(true);

    App.Utils.setFormButtonsForMode('processCancelBtn', 'processExitBtn', 'processSubmitBtn', false, 'Save Process');
    App.Nav.clear('editProcessModal');

    const modalEl = document.getElementById('editProcessModal');
    if (modalEl && typeof bootstrap !== 'undefined') {
      bootstrap.Modal.getOrCreateInstance(modalEl).show();
    }
  },

  // Shows/hides the "Import Existing Process" bar -- only meaningful while
  // adding a new process (or duplicating one), hidden while editing an
  // existing one.
  toggleImportBar(show) {
    const bar = document.getElementById('processImportBar');
    if (bar) bar.style.display = show ? '' : 'none';
  },

  async openEditModal(idx) {
    const p = App.State.globalProcesses[idx];
    if (!p) return;
    const seq = ++this._modalLoadSeq;

    const form = document.getElementById('processForm');
    if (form) form.reset();

    document.getElementById('processFormProcessId').value = p.processId;
    document.getElementById('processFormName').value = p.processName;
    document.getElementById('processFormSequence').value = p.sequence;
    const editPrefixEl = document.getElementById('processFormLotPrefix');
    editPrefixEl.value = p.lotPrefix;
    editPrefixEl.readOnly = true;
    const editPrefixHelp = document.getElementById('processFormLotPrefixHelp');
    if (editPrefixHelp) editPrefixHelp.textContent = 'Locked after creation — changing it would desync Lot Number continuity for existing lots. Use "Duplicate" to start a new process with its own prefix.';
    document.getElementById('processFormIsFinalStage').checked = !!p.isFinalStage;
    document.getElementById('processFormActive').checked = !!p.active;
    document.getElementById('processFormRemarks').value = p.remarks || '';
    document.getElementById('processFormOutputItemName').value = p.outputItemName || '';

    this.toggleColorLinksAvailability(true);
    try {
      const [compRes, linksRes] = await Promise.all([
        Api.call('getProcessComponentsData', p.processId),
        Api.call('getProcessColorLinksData', p.processId),
        typeof App.Contractor !== 'undefined' ? App.Contractor.ensureLoaded() : Promise.resolve(),
        App.Color.ensureLoaded(),
        App.ProcessType.ensureLoaded(),
        // renderComponentsGrouped below builds each saved row via
        // addComponentRow, which resolves Narration live AND matches the
        // row's own item picker against globalItems (see the preSelectedOption
        // lookup there) -- without this, an unloaded Items Master would mark
        // every real item "(Not in Items Master)" instead of just resolving
        // it once this arrives too late to matter.
        typeof App.Item !== 'undefined' ? App.Item.ensureLoaded() : Promise.resolve(),
        this.loadContractorRatesForProcess(p.processType, App.Utils.getSizeFromOutputItemName(p.outputItemName), seq)
      ]);
      if (seq !== this._modalLoadSeq) return;
      this.renderComponentsGrouped(compRes.success ? compRes.data : []);
      this.renderColorLinksData(linksRes.success ? linksRes.data : []);
      this._presetDispatchDifferentiator = p.dispatchDifferentiator || '';
      await this.loadPoolColorAxisLabels(p.processId, p.primaryColorAxis || '');
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to load process components', true);
    }
    if (seq !== this._modalLoadSeq) return;
    App.ProcessType.populateSelect();
    const editProcTypeEl = document.getElementById('processFormProcessType');
    if (editProcTypeEl) {
      editProcTypeEl.value = p.processType || '';
      if (window.jQuery?.fn?.select2 && window.jQuery(editProcTypeEl).data('select2'))
        window.jQuery(editProcTypeEl).trigger('change.select2');
    }

    document.getElementById('processFormTitle').innerText = `Edit Process: ${p.processName}`;
    document.getElementById('processSubmitBtn').innerText = 'Update Process';
    this.toggleImportBar(false);

    App.Utils.setFormButtonsForMode('processCancelBtn', 'processExitBtn', 'processSubmitBtn', true, 'Update Process');
    App.Nav.register(
      'editProcessModal',
      (App.State.filteredProcesses || []).map(x => x.processId),
      p.processId,
      (processId) => {
        const targetIdx = App.State.globalProcesses.findIndex(x => x.processId === processId);
        if (targetIdx !== -1) this.openEditModal(targetIdx);
      }
    );

    const modalEl = document.getElementById('editProcessModal');
    if (modalEl && typeof bootstrap !== 'undefined') {
      bootstrap.Modal.getOrCreateInstance(modalEl).show();
    }
  },

  // Opens the Add Process modal pre-filled from an existing process, with
  // the Process ID cleared (so saving creates a new record) and the Lot
  // Prefix cleared (it must be unique, so it can't be copied as-is).
  async openDuplicateModal(idx) {
    const p = App.State.globalProcesses[idx];
    if (!p) return;

    const form = document.getElementById('processForm');
    if (form) form.reset();

    App.Utils.setFormButtonsForMode('processCancelBtn', 'processExitBtn', 'processSubmitBtn', false, 'Save Process');
    App.Nav.clear('editProcessModal');
    this.toggleImportBar(false);

    const modalEl = document.getElementById('editProcessModal');
    if (modalEl && typeof bootstrap !== 'undefined') {
      bootstrap.Modal.getOrCreateInstance(modalEl).show();
    }

    await this.applyProcessAsTemplate(p);
    setTimeout(() => document.getElementById('processFormLotPrefix')?.focus(), 300);
  },

  // Shared by openDuplicateModal and chooseImportCandidate -- both pre-fill
  // the currently-open Add Process form from process `p` as a
  // copy-to-modify starting point: Process ID and Lot Prefix are cleared/
  // regenerated (both must be unique to a new record), contractor rates
  // are NOT copied (negotiated per actual process, not per recipe),
  // everything else is.
  async applyProcessAsTemplate(p) {
    const seq = ++this._modalLoadSeq;

    document.getElementById('processFormProcessId').value = '';
    document.getElementById('processFormName').value = `${p.processName} (Copy)`;
    document.getElementById('processFormSequence').value = p.sequence;
    const prefixEl = document.getElementById('processFormLotPrefix');
    prefixEl.readOnly = false;
    prefixEl.dataset.userEdited = '';
    prefixEl.value = this.suggestLotPrefix(p.processName);
    const prefixHelp = document.getElementById('processFormLotPrefixHelp');
    if (prefixHelp) prefixHelp.textContent = 'Auto-suggested — it must be unique, so review it before saving.';
    document.getElementById('processFormIsFinalStage').checked = !!p.isFinalStage;
    document.getElementById('processFormActive').checked = !!p.active;
    document.getElementById('processFormRemarks').value = p.remarks || '';
    document.getElementById('processFormOutputItemName').value = p.outputItemName || '';

    try {
      await App.Color.ensureLoaded();
      await App.ProcessType.ensureLoaded();
      const res = await Api.call('getProcessComponentsData', p.processId);
      if (seq !== this._modalLoadSeq) return;
      this.renderComponentsGrouped(res.success ? res.data : []);
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to load process components', true);
    }
    if (seq !== this._modalLoadSeq) return;
    App.ProcessType.populateSelect();
    const procTypeEl = document.getElementById('processFormProcessType');
    if (procTypeEl) {
      procTypeEl.value = p.processType || '';
      if (window.jQuery?.fn?.select2 && window.jQuery(procTypeEl).data('select2'))
        window.jQuery(procTypeEl).trigger('change.select2');
    }

    this.clearColorLinks();
    this.toggleColorLinksAvailability(false);
    this.clearContractorRatesTable();

    this._poolAxisLabels = [];
    this._presetDispatchDifferentiator = '';
    this.refreshColorAxisOptions();
    const primaryPicker = document.getElementById('processPrimaryColorAxis');
    if (primaryPicker) primaryPicker.value = p.primaryColorAxis && this.collectColorAxisLabels().includes(p.primaryColorAxis) ? p.primaryColorAxis : '';
    // A duplicate keeps the source's differentiator only if that axis label
    // survives on the copied recipe -- the pool-detected labels belong to the
    // original's saved history, which the copy doesn't have yet.
    const dupDiffPicker = document.getElementById('processDispatchDifferentiator');
    if (dupDiffPicker) dupDiffPicker.value = p.dispatchDifferentiator && this.collectColorAxisLabels().includes(p.dispatchDifferentiator) ? p.dispatchDifferentiator : '';

    document.getElementById('processFormTitle').innerText = `Duplicate Process (from ${p.processId})`;
    document.getElementById('processSubmitBtn').innerText = 'Save Process';
    this.toggleImportBar(true);
  },

  // ── Import Existing Process picker ──────────────────────────────────

  async openImportPicker() {
    await App.Process.ensureLoaded();

    const list = (App.State.globalProcesses || []).slice()
      .sort((a, b) => a.processName.localeCompare(b.processName));
    this._importPickerList = list;
    this.renderImportPickerList(list);
    const searchEl = document.getElementById('importProcessSearch');
    if (searchEl) searchEl.value = '';
    const modalEl = document.getElementById('importProcessModal');
    if (modalEl && typeof bootstrap !== 'undefined') {
      bootstrap.Modal.getOrCreateInstance(modalEl).show();
    }
  },

  renderImportPickerList(list) {
    const container = document.getElementById('importProcessList');
    const empty = document.getElementById('importProcessEmpty');
    if (!container) return;
    if (!list.length) {
      container.innerHTML = '';
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';
    container.innerHTML = list.map(p => `
      <button type="button" class="list-group-item list-group-item-action" onclick="App.Process.chooseImportCandidate('${escapeHtml(p.processId)}')">
        <div class="d-flex justify-content-between align-items-center gap-2">
          <span class="fw-bold">${escapeHtml(p.processName)}</span>
          <span class="badge bg-secondary">${escapeHtml(p.processType || 'General')}</span>
        </div>
        <div class="small text-muted">${escapeHtml(p.processId)} &middot; Seq ${p.sequence} &middot; Output: ${escapeHtml(p.outputItemName || '—')}</div>
      </button>
    `).join('');
  },

  filterImportPicker(term) {
    const source = this._importPickerList || [];
    const t = String(term || '').trim();
    const filtered = !t ? source : source.filter(p =>
      App.Utils.matchesKeywords([p.processId, p.processName, p.processType, p.outputItemName].join(' '), t));
    this.renderImportPickerList(filtered);
  },

  async chooseImportCandidate(processId) {
    const p = (App.State.globalProcesses || []).find(x => x.processId === processId);
    if (!p) return;

    const pickerEl = document.getElementById('importProcessModal');
    if (pickerEl && typeof bootstrap !== 'undefined') {
      const inst = bootstrap.Modal.getInstance(pickerEl);
      if (inst) inst.hide();
    }

    await this.applyProcessAsTemplate(p);
    setTimeout(() => document.getElementById('processFormLotPrefix')?.focus(), 300);
  },

  // Destroys Select2 instances on all component rows and empties the table.
  clearComponentsTable() {
    const tbody = document.getElementById('processComponentsBody');
    // Reset regardless of tbody presence -- this runs at the start of every
    // form load (new/edit/import), and a stale list from whichever process
    // was open before would otherwise restrict the Color/Sub-Group picker
    // to the WRONG process's colors until refreshUpstreamColorCombos's
    // async re-scan catches up.
    this._upstreamColorCombos = [];
    if (!tbody) return;
    tbody.querySelectorAll('tr').forEach(row => this.destroyComponentItemSelect2(row));
    tbody.innerHTML = '';
  },

  // ── Contractor Rates mini-table ──────────────────────────────────────

  clearContractorRatesTable() {
    const tbody = document.getElementById('processContractorRatesBody');
    if (!tbody) return;
    tbody.querySelectorAll('tr').forEach(row => this.destroyContractorRateSelect2(row));
    tbody.innerHTML = '';
    App.State.currentProcessContractorRates = { processType: '', size: '', rates: [] };
  },

  // Rate Card is keyed by (Contractor, Process Type, Size), not by this
  // specific Process -- so this mini-table shows/edits whatever rate
  // applies to this process's own Type + Size, and a save here is shared
  // with every other process under that same Type + Size combination.
  async loadContractorRatesForProcess(processType, size, seq) {
    const tbody = document.getElementById('processContractorRatesBody');
    if (tbody) App.Utils.tableLoading(tbody, 4, 'Loading rates...');

    try {
      const res = await Api.call('getContractorRatesData');
      if (seq !== undefined && seq !== this._modalLoadSeq) return;
      const typeLower = String(processType || '').trim().toLowerCase();
      const sizeLower = String(size || '').trim().toLowerCase();
      const rates = res.success
        ? (res.data || []).filter(r => r.processType.toLowerCase() === typeLower && r.size.toLowerCase() === sizeLower)
        : [];
      App.State.currentProcessContractorRates = { processType, size, rates };

      if (tbody) tbody.innerHTML = '';
      rates.forEach(r => this.addContractorRateRow(r));
    } catch (err) {
      App.Utils.tableError(tbody, err && err.message);
      App.Utils.showToast(err.message || 'Failed to load contractor rates', true);
    }
  },

  addContractorRateRow(rate) {
    const tbody = document.getElementById('processContractorRatesBody');
    if (!tbody) return;

    const rowId = 'proc_rate_row_' + Math.floor(Math.random() * 1000000);
    const contractorName = (rate && rate.contractorName) || '';

    const rowHtml = `<tr id="${rowId}">
  <td><select class="form-control proc-rate-contractor-select" style="width:100%;"></select></td>
  <td><input type="number" class="form-control text-end proc-rate-amount" value="${rate && rate.ratePerUnit ? rate.ratePerUnit : 0}" min="0" step="0.01"></td>
  <td><input type="text" class="form-control proc-rate-remarks" value="${escapeHtml((rate && rate.remarks) || '')}"></td>
  <td class="text-center">
    <button type="button" class="btn btn-sm btn-outline-success" onclick="App.Process.saveContractorRateRow('${rowId}')">Save</button>
    <button type="button" class="btn btn-sm btn-outline-danger" onclick="App.Process.deleteContractorRateRow('${rowId}')">✕</button>
  </td>
</tr>`;

    tbody.insertAdjacentHTML('beforeend', rowHtml);
    this.initContractorRateSelect2(document.getElementById(rowId), contractorName);
  },

  // Searchable, creatable Select2 for a rate row's contractor field.
  initContractorRateSelect2(row, currentValue) {
    const selectEl = row?.querySelector('.proc-rate-contractor-select');
    if (!selectEl || !window.jQuery?.fn?.select2) return;

    const $select = window.jQuery(selectEl);
    if ($select.data('select2')) $select.select2('destroy');
    selectEl.innerHTML = '';
    if (currentValue) selectEl.add(new Option(App.Utils.formatNameCase(currentValue), currentValue, true, true));

    const $parentModal = $select.closest('.modal');

    $select.select2({
      placeholder: 'Search or type contractor...',
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
  },

  destroyContractorRateSelect2(row) {
    const selectEl = row?.querySelector('.proc-rate-contractor-select');
    if (!selectEl || !window.jQuery?.fn?.select2) return;
    const $select = window.jQuery(selectEl);
    if ($select.data('select2')) $select.select2('destroy');
  },

  // Process Type + Size are read live from the form (not the originally
  // opened process) -- same reasoning the old processName read had: if
  // the operator changes Process Type or Output Item Name before saving
  // a rate row, the row should follow the form's current values.
  _currentFormProcessType() {
    return document.getElementById('processFormProcessType')?.value.trim() || '';
  },

  _currentFormSize() {
    return App.Utils.getSizeFromOutputItemName(document.getElementById('processFormOutputItemName')?.value || '');
  },

  async saveContractorRateRow(rowId) {
    const row = document.getElementById(rowId);
    if (!row) return;

    const processType = this._currentFormProcessType();
    if (!processType) {
      App.Utils.showToast('Choose a Process Type first.', true);
      return;
    }
    const size = this._currentFormSize();

    const contractorName = row.querySelector('.proc-rate-contractor-select').value;
    const ratePerUnit = row.querySelector('.proc-rate-amount').value;
    const remarks = row.querySelector('.proc-rate-remarks').value;

    if (!contractorName) {
      App.Utils.showToast('Select or type a contractor name.', true);
      return;
    }

    try {
      const seq = this._modalLoadSeq;
      const res = await Api.mutate('saveContractorRate', { contractorName, processType, size, ratePerUnit, remarks });
      App.Utils.showToast(res.message, !res.success);
      if (res.success) {
        if (typeof App.Contractor !== 'undefined') await App.Contractor.ensureLoaded();
        await this.loadContractorRatesForProcess(processType, size, seq);
      }
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to save contractor rate', true);
    }
  },

  async deleteContractorRateRow(rowId) {
    const row = document.getElementById(rowId);
    if (!row) return;

    const processType = this._currentFormProcessType();
    const size = this._currentFormSize();
    const contractorName = row.querySelector('.proc-rate-contractor-select').value;

    const existing = (App.State.currentProcessContractorRates?.rates || [])
      .find(r => r.contractorName.toLowerCase() === contractorName.toLowerCase());

    if (!existing || !processType) {
      this.destroyContractorRateSelect2(row);
      row.remove();
      return;
    }

    App.Utils.confirmAction(
      `Delete the rate card entry for "${App.Utils.formatNameCase(contractorName)}" on "${processType} / ${size}"? This cannot be undone.`,
      async () => {
        try {
          const seq = this._modalLoadSeq;
          const res = await Api.mutate('deleteContractorRate', contractorName, processType, size);
          App.Utils.showToast(res.message, !res.success);
          if (res.success) await this.loadContractorRatesForProcess(processType, size, seq);
        } catch (err) {
          App.Utils.showToast(err.message || 'Failed to delete contractor rate', true);
        }
      }
    );
  },

  // Builds <option> markup for the Size dropdown of a component row.
  buildSizeOptionsHtml(itemName, selectedSize) {
    const items = App.State.globalItems || [];
    const sizes = [...new Set(items.filter(it => App.Utils.sameText(it.name, itemName) && it.size).map(it => it.size))];
    if (!selectedSize && sizes.length === 1) selectedSize = sizes[0];
    if (selectedSize && !sizes.some(s => App.Utils.sameText(s, selectedSize))) sizes.unshift(selectedSize);
    let html = `<option value="">${sizes.length ? '-- Select Size --' : '-'}</option>`;
    sizes.forEach(s => {
      html += `<option value="${escapeHtml(s)}" ${App.Utils.sameText(s, selectedSize) ? 'selected' : ''}>${escapeHtml(s)}</option>`;
    });
    return html;
  },

  // The Narration to show for a component row, resolved LIVE from Items
  // Master by name+size rather than the recipe's own possibly-stale stored
  // value -- so reopening an existing Process for edit (or a Production
  // Lot built from it) shows an Items Master correction immediately,
  // instead of only after someone remembers to click "Refresh Narrations".
  // `fallback` (the stored value) is kept for a POOL row (Warehouse Pool
  // output items have no Items Master entry of their own) or when there's
  // no match, so nothing is ever silently blanked.
  _resolveDisplayNarration(itemName, size, fallback, isPool) {
    const stored = String(fallback || '').trim();
    if (isPool || !itemName) return stored;
    const match = (App.State.globalItems || []).find(it =>
      App.Utils.sameText(it.name, itemName) && App.Utils.sameText(it.size || '', size || ''));
    if (!match) return stored;
    return String(match.narration || '').trim() || stored;
  },

  // Adds a row to a Components table. targetTbody defaults to the Common
  // Components table; pass a color sub-group's tbody to add there instead.
  addComponentRow(compData = null, targetTbody = null) {
    const tbody = targetTbody || document.getElementById('processComponentsBody');
    if (!tbody) return;

    const rowId = 'proc_comp_row_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    const displayNarration = compData
      ? this._resolveDisplayNarration(compData.itemName, compData.size, compData.narration, compData.sourceType === 'POOL')
      : '';

    let preSelectedOption = '';
    if (compData && compData.itemName && compData.sourceType === 'POOL') {
      preSelectedOption = `<option value="pool:${escapeHtml(compData.itemName)}" selected data-name="${escapeHtml(compData.itemName)}">${escapeHtml(compData.itemName)}</option>`;
    } else if (compData && compData.itemName) {
      const items = App.State.globalItems || [];
      const matchIdx = items.findIndex(item => App.Utils.sameText(item.name, compData.itemName));
      if (matchIdx >= 0) {
        preSelectedOption = `<option value="${matchIdx}" selected data-name="${escapeHtml(compData.itemName)}">${escapeHtml(compData.itemName)}</option>`;
      } else {
        preSelectedOption = `<option value="orphan" selected data-name="${escapeHtml(compData.itemName)}">${escapeHtml(compData.itemName)} (Not in Items Master)</option>`;
      }
    }

    const rowHtml = `
  <tr id="${rowId}" draggable="true"
      ondragstart="App.Process.onComponentDragStart(event,'${rowId}')"
      ondragover="App.Process.onComponentDragOver(event)"
      ondrop="App.Process.onComponentDrop(event,'${rowId}')"
      ondragend="App.Process.onComponentDragEnd()">
    <td class="text-center text-muted" style="cursor:grab;" title="Drag to reorder"><i class="bi bi-grip-vertical"></i></td>
    <td>
      <select class="form-select proc-comp-item-select" required>
        <option value=""></option>
        ${preSelectedOption}
      </select>
    </td>
    <td>
      <select class="form-select proc-comp-size" onchange="App.Process.handleComponentSizeChange(this)">
        ${this.buildSizeOptionsHtml(compData && compData.itemName ? compData.itemName : '', compData && compData.size ? compData.size : '')}
      </select>
    </td>
    <td><input type="text" class="form-control proc-comp-narration" placeholder="-" value="${escapeHtml(displayNarration)}"></td>
    <td>
      <select class="form-select proc-comp-source" title="ITEM = raw material from Stock. POOL = an upstream process's Output Item Name from the Warehouse Pool." onchange="App.Process.handleSourceChange(this)">
        <option value="ITEM" ${(!compData || compData.sourceType !== 'POOL') ? 'selected' : ''}>Item (Stock)</option>
        <option value="POOL" ${(compData && compData.sourceType === 'POOL') ? 'selected' : ''}>Pool (Warehouse)</option>
      </select>
    </td>
    <td><input type="number" class="form-control text-end proc-comp-qty" min="0.0001" step="any" value="${compData && compData.qtyPerUnit ? compData.qtyPerUnit : '1'}"></td>
    <td><input type="text" class="form-control proc-comp-unit" list="unitList" placeholder="(item's own)" value="${compData && compData.unit ? escapeHtml(compData.unit) : ''}"></td>
    <td><input type="text" class="form-control proc-comp-remarks" placeholder="-" value="${compData && compData.remarks ? escapeHtml(compData.remarks) : ''}"></td>
    <td class="text-center"><button type="button" class="btn btn-outline-danger btn-sm" onclick="App.Process.removeComponentRow('${rowId}')">✕</button></td>
  </tr>
`;

    tbody.insertAdjacentHTML('beforeend', rowHtml);
    const newRow = document.getElementById(rowId);
    this.initComponentItemSelect2(newRow);

    const autoSizeSelect = newRow?.querySelector('.proc-comp-size');
    if (autoSizeSelect && autoSizeSelect.value && !(compData && compData.narration)) {
      this.handleComponentSizeChange(autoSizeSelect);
    }

    return rowId;
  },

  removeComponentRow(rowId) {
    const row = document.getElementById(rowId);
    if (row) {
      this.destroyComponentItemSelect2(row);
      row.remove();
      this.refreshUpstreamColorCombos();
    }
  },

  // Click-drag reordering of component rows within the Process form.
  _dragCompRowId: null,

  onComponentDragStart(e, rowId) {
    this._dragCompRowId = rowId;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', rowId); } catch (err) { /* ignored */ }
    }
  },

  onComponentDragOver(e) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  },

  onComponentDrop(e, targetRowId) {
    e.preventDefault();
    const srcId = this._dragCompRowId;
    this._dragCompRowId = null;
    if (!srcId || srcId === targetRowId) return;

    const srcRow = document.getElementById(srcId);
    const targetRow = document.getElementById(targetRowId);
    if (!srcRow || !targetRow) return;

    const srcTbody = srcRow.closest('tbody');
    const targetTbody = targetRow.closest('tbody');
    if (!srcTbody || srcTbody !== targetTbody) return;

    const rows = Array.from(srcTbody.children);
    if (rows.indexOf(srcRow) < rows.indexOf(targetRow)) {
      targetRow.after(srcRow);
    } else {
      targetRow.before(srcRow);
    }
  },

  onComponentDragEnd() {
    this._dragCompRowId = null;
  },

  // Distinct Output Item Names across all processes -- the valid set of
  // "things" a POOL-sourced component can refer to.
  getDistinctOutputItemNames() {
    const names = (App.State.globalProcesses || [])
      .map(p => p.outputItemName)
      .filter(Boolean);
    return Array.from(new Set(names));
  },

  // Resolves the known color combinations of whichever process(es) produce
  // the Warehouse Pool item named itemName (matched by Output Item Name --
  // the same match a POOL-sourced component resolves against at
  // production time). Shared by showPoolColorHint (the per-row hover tip)
  // and refreshUpstreamColorCombos (the Color/Sub-Group picker restriction),
  // so there is one fetch/merge path for "what colors does this upstream
  // process make", not two that could drift.
  async getUpstreamColorsForItem(itemName) {
    if (!itemName) return [];
    const upstreamProcesses = (App.State.globalProcesses || []).filter(
      p => (p.outputItemName || '').toLowerCase() === itemName.toLowerCase()
    );
    if (!upstreamProcesses.length) return [];

    try {
      const results = await Promise.all(
        upstreamProcesses.map(p => Api.call('getProcessColorGroups', p.processId))
      );
      const merged = new Map();
      results.forEach(res => {
        if (res?.success) (res.data || []).forEach(c => merged.set(c.toLowerCase(), c));
      });
      return Array.from(merged.values()).filter(c => !c.includes(' / '));
    } catch (e) {
      return [];
    }
  },

  // Fired after picking a POOL-sourced item on a component row -- sets a
  // native hover tooltip showing what colors the source process produces,
  // and re-scans the whole form's upstream color combinations since this
  // row's contribution to that set may have just changed.
  async showPoolColorHint(row, itemName) {
    const cell = row?.querySelector('.proc-comp-item-select')?.closest('td');
    if (cell) cell.removeAttribute('title');

    const colors = await this.getUpstreamColorsForItem(itemName);
    if (cell && colors.length) {
      cell.title = `"${itemName}" is produced in these colors by its source process: ${colors.join(', ')}`;
    }
    this.refreshUpstreamColorCombos();
  },

  // Scans every POOL-sourced component row across Common + all Color
  // Sub-Group cards, resolves each referenced item's upstream color
  // combinations, and unions them into _upstreamColorCombos -- the set the
  // Color/Sub-Group picker (see _buildColorGroupOptionsHtml) restricts
  // itself to once it's non-empty. Re-run after any component add/remove/
  // change so already-rendered pickers can be widened/narrowed via
  // refreshColorGroupPickerOptions once the fetch resolves.
  // _upstreamColorSeq guards against an earlier, slower scan overwriting a
  // later one's result.
  async refreshUpstreamColorCombos() {
    const seq = ++this._upstreamColorSeq;
    const itemNames = new Set();
    document.querySelectorAll('#processComponentsBody tr, #processColorGroupsContainer .proc-colorgroup-body tr').forEach(row => {
      if (row.querySelector('.proc-comp-source')?.value !== 'POOL') return;
      const sel = row.querySelector('.proc-comp-item-select');
      const opt = sel?.options[sel.selectedIndex];
      const name = opt?.dataset.name || '';
      if (name) itemNames.add(name);
    });

    const merged = new Map();
    await Promise.all(Array.from(itemNames).map(async name => {
      (await this.getUpstreamColorsForItem(name)).forEach(c => merged.set(c.toLowerCase(), c));
    }));
    if (seq !== this._upstreamColorSeq) return;

    this._upstreamColorCombos = Array.from(merged.values()).sort((a, b) => a.localeCompare(b));
    this.refreshColorGroupPickerOptions();
  },

  // Builds the <option> list for a Color Sub-Group card's Color/Sub-Group
  // picker. Once this process has at least one POOL component sourced from
  // a colored upstream process (_upstreamColorCombos non-empty), the list
  // is restricted to ONLY that process's actual color combinations --
  // picking from it can no longer produce a sub-group name that doesn't
  // match what upstream really makes. With no upstream signal, this is
  // unchanged from before: every Color Master name, free text still
  // allowed via select2 tags.
  _buildColorGroupOptionsHtml(initialColorName) {
    const combos = this._upstreamColorCombos || [];
    const sourceNames = combos.length ? combos : (App.State.globalColors || []).map(c => c.name);
    const knownNames = new Set(sourceNames.map(n => n.toLowerCase()));
    let html = sourceNames
      .map(name => `<option value="${escapeHtml(name)}" ${App.Utils.sameText(name, initialColorName) ? 'selected' : ''}>${escapeHtml(name)}</option>`)
      .join('');
    if (initialColorName && !knownNames.has(initialColorName.trim().toLowerCase())) {
      html += `<option value="${escapeHtml(initialColorName)}" selected>${escapeHtml(initialColorName)}</option>`;
    }
    return html;
  },

  // Rebuilds every already-rendered Color Sub-Group card's picker options
  // against the current _upstreamColorCombos, preserving whichever value is
  // already chosen. Needed because a card can exist BEFORE the Pool
  // component that reveals its process's color combinations gets added (or
  // removed), so the restriction has to be re-applied after the fact too,
  // not just at card-creation time in addColorGroup.
  refreshColorGroupPickerOptions() {
    document.querySelectorAll('#processColorGroupsContainer .proc-colorgroup-card').forEach(card => {
      const selectEl = card.querySelector('.proc-colorgroup-select');
      if (!selectEl) return;
      const currentVal = selectEl.value;
      selectEl.innerHTML = this._buildColorGroupOptionsHtml(currentVal);
      if (window.jQuery?.fn?.select2) {
        const $select = window.jQuery(selectEl);
        if ($select.data('select2')) $select.val(currentVal).trigger('change.select2');
      }
    });
  },

  // Fired when a row's Source select changes between ITEM/POOL.
  handleSourceChange(selectEl) {
    const row = selectEl.closest('tr');
    const itemSelect = row?.querySelector('.proc-comp-item-select');
    if (itemSelect && window.jQuery?.fn?.select2) {
      window.jQuery(itemSelect).val(null).trigger('change');
    }
    const sizeSelect = row?.querySelector('.proc-comp-size');
    if (sizeSelect) sizeSelect.innerHTML = this.buildSizeOptionsHtml('', '');
    const narrationInput = row?.querySelector('.proc-comp-narration');
    if (narrationInput) narrationInput.value = '';
    App.Process.showPoolColorHint(row, '');
  },

  // Searchable Select2 for a component row's item picker. Source list
  // switches with the row's Source select: ITEM -> App.State.globalItems,
  // POOL -> distinct Output Item Names from Process Master.
  initComponentItemSelect2(rowEl) {
    const selectEl = rowEl?.querySelector('.proc-comp-item-select');
    if (!selectEl || !window.jQuery?.fn?.select2) return;

    const $select = window.jQuery(selectEl);
    const PAGE_SIZE = 40;
    const $parentModal = $select.closest('.modal');

    $select.select2({
      placeholder: 'Search or type a new item...',
      width: '100%',
      tags: true,
      dropdownParent: $parentModal.length ? $parentModal : window.jQuery(document.body),
      ajax: {
        delay: 150,
        data(params) {
          return { q: params.term || '', page: params.page || 1 };
        },
        transport(params, success) {
          const q = (params.data.q || '').trim();
          const page = params.data.page || 1;
          const isPool = selectEl.closest('tr')?.querySelector('.proc-comp-source')?.value === 'POOL';
          const names = isPool
            ? App.Process.getDistinctOutputItemNames()
            : Array.from(new Set((App.State.globalItems || []).map(it => it.name).filter(Boolean)));
          const items = names.map(name => ({ name }));
          const start = (page - 1) * PAGE_SIZE;

          const pool = q
            ? items.map((item, idx) => ({ idx, item })).filter(({ item }) =>
              App.Utils.matchesKeywords(item.name, q))
            : items.map((item, idx) => ({ idx, item }));

          const pageItems = pool.slice(start, start + PAGE_SIZE);
          success({
            results: pageItems.map(({ idx, item }) => ({
              id: (isPool ? 'pool:' : 'item:') + idx,
              text: item.name,
              _itemName: item.name
            })),
            pagination: { more: (start + PAGE_SIZE) < pool.length }
          });
        },
        processResults(data) { return data; }
      },
      createTag(params) {
        const term = (params.term || '').trim();
        if (!term) return null;
        const isPool = selectEl.closest('tr')?.querySelector('.proc-comp-source')?.value === 'POOL';
        const names = isPool
          ? App.Process.getDistinctOutputItemNames()
          : Array.from(new Set((App.State.globalItems || []).map(it => it.name).filter(Boolean)));
        const existing = names.find(n => App.Utils.sameText(n, term));
        if (existing) return { id: (isPool ? 'pool:' : 'item:') + existing, text: existing, _itemName: existing };
        return { id: 'custom:' + term, text: term, newTag: true, _itemName: term };
      }
    });

    $select.on('select2:select', function (e) {
      const data = e.params.data;
      const opt = selectEl.options[selectEl.selectedIndex];
      if (opt) opt.dataset.name = data._itemName || data.text;

      const row = selectEl.closest('tr');
      const sizeSelect = row?.querySelector('.proc-comp-size');
      const narrationInput = row?.querySelector('.proc-comp-narration');
      if (sizeSelect) sizeSelect.innerHTML = App.Process.buildSizeOptionsHtml(data._itemName || data.text, '');
      if (narrationInput) narrationInput.value = '';
      if (sizeSelect && sizeSelect.value) App.Process.handleComponentSizeChange(sizeSelect);

      const isPoolRow = row?.querySelector('.proc-comp-source')?.value === 'POOL';
      App.Process.showPoolColorHint(row, isPoolRow ? (data._itemName || data.text) : '');
    });
  },

  // Size changed on a component row -- looks up that exact item+size row
  // in Item Master and syncs Narration to it.
  handleComponentSizeChange(selectEl) {
    const row = selectEl.closest('tr');
    const itemSelect = row?.querySelector('.proc-comp-item-select');
    const itemName = itemSelect?.options[itemSelect.selectedIndex]?.dataset.name;
    const narrationInput = row?.querySelector('.proc-comp-narration');
    if (!itemName || !narrationInput) return;

    const match = (App.State.globalItems || []).find(it => App.Utils.sameText(it.name, itemName) && App.Utils.sameText(it.size || '', selectEl.value || ''));
    narrationInput.value = (match && match.narration) || '';
  },

  destroyComponentItemSelect2(rowEl) {
    const selectEl = rowEl?.querySelector('.proc-comp-item-select');
    if (!selectEl || !window.jQuery?.fn?.select2) return;
    const $select = window.jQuery(selectEl);
    if ($select.data('select2')) $select.select2('destroy');
  },

  // Reads one component row into a plain object, tagged with the given
  // colorGroup ('COMMON' or a Color Master name) and, optionally, a
  // colorAxis label.
  _readComponentRow(row, colorGroup, colorAxis = '') {
    const selectEl = row.querySelector('.proc-comp-item-select');
    if (!selectEl || selectEl.value === '') return null;

    const opt = selectEl.options[selectEl.selectedIndex];
    const itemName = opt.dataset.name || opt.textContent.trim();
    if (!itemName) return null;

    return {
      itemName,
      size: row.querySelector('.proc-comp-size').value.trim(),
      narration: row.querySelector('.proc-comp-narration').value.trim(),
      qtyPerUnit: toNumber(row.querySelector('.proc-comp-qty').value) || 1,
      unit: (row.querySelector('.proc-comp-unit')?.value || '').trim(),
      remarks: row.querySelector('.proc-comp-remarks').value.trim(),
      sourceType: row.querySelector('.proc-comp-source')?.value === 'POOL' ? 'POOL' : 'ITEM',
      colorGroup,
      colorAxis
    };
  },

  // Reads the Common Components table plus every color sub-group's table
  // into a flat array for submission.
  serializeComponents() {
    const components = [];

    document.querySelectorAll('#processComponentsBody tr').forEach(row => {
      const comp = this._readComponentRow(row, 'COMMON');
      if (comp) components.push(comp);
    });

    document.querySelectorAll('#processColorGroupsContainer .proc-colorgroup-card').forEach(card => {
      const colorName = (card.querySelector('.proc-colorgroup-select')?.value || '').trim();
      if (!colorName) return;
      const colorAxis = (card.querySelector('.proc-colorgroup-axis')?.value || '').trim();
      card.querySelectorAll('.proc-colorgroup-body tr').forEach(row => {
        const comp = this._readComponentRow(row, colorName, colorAxis);
        if (comp) components.push(comp);
      });
    });

    return components;
  },

  // Distinct, non-blank Group (Color Axis) labels currently typed across
  // every color sub-group card on the form.
  collectColorAxisLabels() {
    const labels = new Set();
    document.querySelectorAll('#processColorGroupsContainer .proc-colorgroup-axis').forEach(input => {
      const val = (input.value || '').trim();
      if (val) labels.add(val);
    });
    return Array.from(labels).sort((a, b) => a.localeCompare(b));
  },

  // Keeps the "Group" field's autocomplete datalist and the Primary Axis
  // dropdown's options in sync with whatever's currently typed, plus any
  // auto-detected Warehouse Pool axes.
  refreshColorAxisOptions() {
    const labels = Array.from(new Set([...(this._poolAxisLabels || []), ...this.collectColorAxisLabels()]))
      .sort((a, b) => a.localeCompare(b));

    const datalist = document.getElementById('processColorAxisDatalist');
    if (datalist) {
      datalist.innerHTML = labels.map(l => `<option value="${escapeHtml(l)}"></option>`).join('');
    }

    const picker = document.getElementById('processPrimaryColorAxis');
    const wrapper = document.getElementById('processPrimaryColorAxisWrapper');
    // 2+ axes means there's a real choice to make -- which one's checked
    // quantities become the lot's total -- so "None" stops being an option
    // at that point instead of quietly falling back to whichever axis sits
    // first in recipe order (see save_process's matching server-side
    // check). Below 2 axes there's nothing to choose between, so the
    // legacy "None" escape hatch stays.
    const choiceRequired = labels.length >= 2;
    if (picker) {
      const current = picker.value;
      picker.innerHTML = (choiceRequired
        ? '<option value="">— Choose which is Primary —</option>'
        : '<option value="">— None (legacy: sum every checked color) —</option>')
        + labels.map(l => `<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join('');
      picker.value = labels.includes(current) ? current : '';
      picker.required = choiceRequired;
    }
    if (wrapper) wrapper.style.display = choiceRequired ? '' : 'none';

    this.refreshDispatchDifferentiatorOptions(labels);
  },

  // Companion to the Primary Axis picker: which single axis identifies this
  // process's output on Ready to Dispatch (see migration 021). Offered from
  // the same label list, but shown only for a FINAL-STAGE process -- that is
  // the only stage whose output reaches Dispatch at all -- and only once
  // there is at least one axis to pick. Unlike Primary Axis, a single axis is
  // still worth differentiating by, so the threshold is 1, not 2.
  refreshDispatchDifferentiatorOptions(labels) {
    const picker = document.getElementById('processDispatchDifferentiator');
    const wrapper = document.getElementById('processDispatchDifferentiatorWrapper');
    if (!picker || !wrapper) return;

    const all = labels || Array.from(new Set([...(this._poolAxisLabels || []), ...this.collectColorAxisLabels()]))
      .sort((a, b) => a.localeCompare(b));
    const current = picker.value;
    picker.innerHTML = '<option value="">— None (one row per output item) —</option>'
      + all.map(l => `<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join('');
    picker.value = all.includes(current) ? current : '';

    const isFinal = !!document.getElementById('processFormIsFinalStage')?.checked;
    wrapper.style.display = (isFinal && all.length >= 1) ? '' : 'none';
  },

  // Fetches this (already-saved) process's auto-detected Warehouse Pool
  // color axes so their labels appear as Primary Axis options too.
  async loadPoolColorAxisLabels(processId, presetPrimary) {
    this._poolAxisLabels = [];
    if (processId) {
      try {
        const res = await Api.call('getProcessColorAxes', processId);
        if (res.success && res.data && Array.isArray(res.data.axes)) {
          this._poolAxisLabels = res.data.axes.filter(a => a.source === 'pool').map(a => a.label);
        }
      } catch (err) {
        // Non-fatal -- the picker just falls back to whatever's typed on-form.
      }
    }
    this.refreshColorAxisOptions();
    const picker = document.getElementById('processPrimaryColorAxis');
    if (picker && presetPrimary) picker.value = presetPrimary;
    // Set after refreshColorAxisOptions, which rebuilds (and would otherwise
    // clear) the differentiator's own <option> list.
    const diffPicker = document.getElementById('processDispatchDifferentiator');
    if (diffPicker && this._presetDispatchDifferentiator) {
      diffPicker.value = this._presetDispatchDifferentiator;
    }
  },

  // Uniqueness = Item Name + Size + Color Group (Common counts as its own
  // group, same as each named color sub-group).
  findDuplicateComponent(components) {
    const seen = new Set();
    for (const comp of components) {
      const itemName = (comp.itemName || '').trim();
      if (!itemName) continue;
      const size = (comp.size || '').trim();
      const colorGroup = (comp.colorGroup || '').trim() || 'COMMON';
      const key = `${itemName.toLowerCase()}|${size.toLowerCase()}|${colorGroup.toLowerCase()}`;
      if (seen.has(key)) return { itemName, size, colorGroup };
      seen.add(key);
    }
    return null;
  },

  // ── Color Sub-Groups ─────────────────────────────────────────────────

  // prevColorHint seeds the "what color did this card used to represent"
  // baseline (data-prev-color) that _retargetRowColor matches against --
  // normally that's just initialColorName, but duplicateColorGroup passes
  // the SOURCE card's color instead, since the copied rows still literally
  // carry the source's name until the operator picks this card's own color.
  addColorGroup(initialColorName = '', components = [], initialAxis = '', prevColorHint = '') {
    const container = document.getElementById('processColorGroupsContainer');
    if (!container) return;

    const groupId = 'proc_colorgroup_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    const colorOptionsHtml = this._buildColorGroupOptionsHtml(initialColorName);

    const axisValue = initialAxis || (components.find(c => c.colorAxis)?.colorAxis || '');

    const html = `
  <div class="card border-secondary-subtle shadow-sm mb-3 proc-colorgroup-card" id="${groupId}">
    <div class="card-header bg-white d-flex align-items-center gap-2 flex-wrap">
      <label class="fw-bold mb-0 text-secondary">Color / Sub-Group:</label>
      <select class="form-select form-select-sm proc-colorgroup-select" style="max-width:220px;" data-prev-color="${escapeHtml(prevColorHint || initialColorName)}">
        <option value="">Choose or type a name...</option>
        ${colorOptionsHtml}
      </select>
      <label class="fw-bold mb-0 text-secondary ms-2">Group:</label>
      <input type="text" class="form-control form-control-sm proc-colorgroup-axis" style="max-width:180px;"
        list="processColorAxisDatalist" placeholder="e.g. Mudguard Color" value="${escapeHtml(axisValue)}"
        title="Optional — groups this sub-group with any other card sharing the same Group label into one independent checkbox group on the Production Lot form. Leave blank if this process only has one color choice to make."
        oninput="App.Process.refreshColorAxisOptions()">
      <button type="button" class="btn btn-outline-secondary btn-sm ms-auto" onclick="App.Process.duplicateColorGroup('${groupId}')">Duplicate</button>
      <button type="button" class="btn btn-outline-danger btn-sm" onclick="App.Process.removeColorGroup('${groupId}')">Remove Group</button>
    </div>
    <div class="card-body">
      <div class="table-responsive mb-2">
        <table class="table table-bordered bg-white shadow-sm mb-0 proc-comp-table">
          <thead class="table-light">
            <tr>
              <th style="width: 32px;"></th>
              <th style="min-width: 240px;">Item</th>
              <th style="min-width: 130px;">Size</th>
              <th style="min-width: 150px;">Narration</th>
              <th style="min-width: 150px;">Source</th>
              <th style="min-width: 110px; text-align: right;">Qty / Unit</th>
              <th style="min-width: 100px;" title="Leave blank if Qty/Unit is already in this item's own Base Unit">Unit</th>
              <th style="min-width: 180px;">Remarks</th>
              <th style="width: 48px; text-align: center;">✕</th>
            </tr>
          </thead>
          <tbody class="proc-colorgroup-body"></tbody>
        </table>
      </div>
      <button type="button" class="btn btn-outline-primary btn-sm fw-bold" onclick="App.Process.addComponentRowToGroup('${groupId}')">+ Add Component</button>
    </div>
  </div>`;

    container.insertAdjacentHTML('beforeend', html);
    const card = document.getElementById(groupId);
    this.initColorGroupSelect2(card);

    const tbody = card.querySelector('.proc-colorgroup-body');
    components.forEach(comp => this.addComponentRow(comp, tbody));
    this.refreshColorAxisOptions();
  },

  addComponentRowToGroup(groupId) {
    const tbody = document.getElementById(groupId)?.querySelector('.proc-colorgroup-body');
    if (tbody) this.addComponentRow(null, tbody);
  },

  duplicateColorGroup(groupId) {
    const sourceCard = document.getElementById(groupId);
    if (!sourceCard) return;

    const components = [];
    sourceCard.querySelectorAll('.proc-colorgroup-body tr').forEach(row => {
      const comp = this._readComponentRow(row, '');
      if (comp) components.push(comp);
    });

    // The duplicate is another value on the SAME axis (e.g. Red vs Blue
    // mudguard) -- carry the Group label over so it lands in the same
    // checkbox group instead of the operator having to retype it.
    const axisValue = (sourceCard.querySelector('.proc-colorgroup-axis')?.value || '').trim();
    // The copied rows still literally carry the SOURCE color's name (e.g.
    // "SEAT---RED-WHITE") until the operator picks this new card's own
    // color -- seed the retarget baseline with it so that first pick
    // correctly swaps the copied rows instead of finding nothing to match.
    const sourceColor = (sourceCard.querySelector('.proc-colorgroup-select')?.value || '').trim();

    this.addColorGroup('', components, axisValue, sourceColor);
  },

  removeColorGroup(groupId) {
    const card = document.getElementById(groupId);
    if (!card) return;
    card.querySelectorAll('.proc-colorgroup-body tr').forEach(row => this.destroyComponentItemSelect2(row));
    const selectEl = card.querySelector('.proc-colorgroup-select');
    if (selectEl && window.jQuery?.fn?.select2) {
      const $select = window.jQuery(selectEl);
      if ($select.data('select2')) $select.select2('destroy');
    }
    card.remove();
    this.refreshColorAxisOptions();
  },

  initColorGroupSelect2(card) {
    const selectEl = card?.querySelector('.proc-colorgroup-select');
    if (!selectEl || !window.jQuery?.fn?.select2) return;

    const self = this;
    const $select = window.jQuery(selectEl);
    const $parentModal = $select.closest('.modal');
    $select.select2({
      placeholder: 'Choose or type a name...',
      width: '100%',
      tags: true,
      matcher: App.Utils.select2Matcher,
      dropdownParent: $parentModal.length ? $parentModal : window.jQuery(document.body),
      createTag(params) {
        const term = (params.term || '').trim();
        if (!term) return null;
        // When this process has Pool-sourced components from a colored
        // upstream process, prefer the canonical upstream color name when
        // the typed term matches one. Otherwise allow the typed name
        // through as a free-text custom sub-group (e.g. "Kit Bag",
        // "Packing") -- the old behavior rejected it outright, which
        // blocked legitimate non-color sub-group names.
        const combos = self._upstreamColorCombos || [];
        if (combos.length) {
          const match = combos.find(c => App.Utils.sameText(c, term));
          if (match) return { id: match, text: match };
        }
        const existing = (App.State.globalColors || []).find(c => App.Utils.sameText(c.name, term));
        if (existing) return { id: existing.name, text: existing.name };
        return { id: term, text: term, newTag: true };
      }
    });
    $select.on('change', () => this.handleColorGroupChange(card));
  },

  // Fired when a color sub-group's Color picker changes. Each row's item
  // is checked for THIS CARD'S OWN previous color embedded in it (e.g.
  // "Frame Decal - Red") and, if a same-named item exists under the new
  // color (same size), re-pointed at it. Rows with no recognizable color
  // token, or no matching variant, are left exactly as they are.
  handleColorGroupChange(card) {
    const tbody = card?.querySelector('.proc-colorgroup-body');
    const colorSelect = card?.querySelector('.proc-colorgroup-select');
    if (!tbody || !colorSelect || !colorSelect.value) return;

    const newColor = colorSelect.value;
    const oldColor = (colorSelect.dataset.prevColor || '').trim();
    colorSelect.dataset.prevColor = newColor;
    if (!oldColor || App.Utils.sameText(oldColor, newColor)) return;

    Array.from(tbody.querySelectorAll('tr')).forEach(row => this._retargetRowColor(row, oldColor, newColor, tbody));
  },

  // Swaps a single row's item for the same-named item under newColor,
  // when one exists in Item Master at the same size. No-ops (leaves the
  // row untouched) for Pool-sourced rows, rows with no item picked, or
  // rows whose item name doesn't literally contain oldColor, or when no
  // matching variant exists.
  _retargetRowColor(row, oldColor, newColor, tbody) {
    if (row.querySelector('.proc-comp-source')?.value === 'POOL') return;

    const itemSelect = row.querySelector('.proc-comp-item-select');
    const currentName = itemSelect?.options[itemSelect.selectedIndex]?.dataset.name;
    if (!currentName) return;

    // Match the card's OWN previous color specifically, not "whichever
    // registered Color Master name happens to appear anywhere in the
    // name" -- a compound item name like "SEAT---RED-WHITE" also
    // whole-word-matches the unrelated "White" entry (a fixed secondary
    // color, not part of this axis), and a longest-match tie-break used
    // to pick that instead, replacing the wrong half and mangling the
    // candidate into something that never exists in Item Master (so the
    // swap silently no-op'd). Knowing exactly which token this card WAS
    // makes the match unambiguous.
    const re = new RegExp(`\\b${this._escapeRegExp(oldColor)}\\b`, 'i');
    if (!re.test(currentName)) return;

    const candidateName = currentName.replace(re, newColor);
    if (candidateName === currentName) return;

    const size = row.querySelector('.proc-comp-size')?.value || '';
    const items = App.State.globalItems || [];
    const hasMatch = items.some(it => App.Utils.sameText(it.name, candidateName) && App.Utils.sameText(it.size || '', size));
    if (!hasMatch) return;

    const comp = this._readComponentRow(row, '');
    if (!comp) return;
    comp.itemName = candidateName;
    comp.narration = '';

    const newRowId = this.addComponentRow(comp, tbody);
    const newRow = document.getElementById(newRowId);
    tbody.insertBefore(newRow, row);
    this.destroyComponentItemSelect2(row);
    row.remove();
  },

  _escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  },

  // Groups a process's fetched recipe (flat array with a colorGroup per
  // row) back into the Common table + one card per color, and renders both.
  renderComponentsGrouped(components) {
    this.clearComponentsTable();
    this.clearColorGroups();

    const all = components || [];
    const common = all.filter(c => !c.colorGroup || c.colorGroup === 'COMMON');
    common.forEach(comp => this.addComponentRow(comp, null));

    const byColor = {};
    all.forEach(c => {
      if (c.colorGroup && c.colorGroup !== 'COMMON') {
        (byColor[c.colorGroup] = byColor[c.colorGroup] || []).push(c);
      }
    });
    Object.keys(byColor).sort((a, b) => a.localeCompare(b))
      .forEach(colorName => this.addColorGroup(colorName, byColor[colorName]));

    // Cards above were just built with an empty/stale _upstreamColorCombos
    // (cleared in clearComponentsTable) since it's only known after this
    // async scan resolves -- this narrows each card's picker down to the
    // right process's colors once it does, without touching whatever's
    // already selected.
    this.refreshUpstreamColorCombos();
  },

  clearColorGroups() {
    const container = document.getElementById('processColorGroupsContainer');
    if (!container) return;
    container.querySelectorAll('.proc-colorgroup-card').forEach(card => {
      card.querySelectorAll('.proc-colorgroup-body tr').forEach(row => this.destroyComponentItemSelect2(row));
      const selectEl = card.querySelector('.proc-colorgroup-select');
      if (selectEl && window.jQuery?.fn?.select2) {
        const $select = window.jQuery(selectEl);
        if ($select.data('select2')) $select.select2('destroy');
      }
    });
    container.innerHTML = '';
  },

  // ── Linked Processes ─────────────────────────────────────────────────

  // Sentinel process-picker value meaning "pair two of THIS process's own
  // axes" instead of linking to a different process -- see
  // myAxisKey/theirAxisKey handling in process_service.py's color-link
  // save/read (getProcessColorLinksData) and the same-process self-guard
  // relaxation there.
  COLOR_LINK_SELF_VALUE: '__self__',

  toggleColorLinksAvailability(hasProcessId) {
    const btn = document.getElementById('processAddColorLinkBtn');
    const hint = document.getElementById('processColorLinksHint');
    if (btn) btn.disabled = !hasProcessId;
    if (hint) hint.style.display = hasProcessId ? 'none' : '';
  },

  // Adds a new "Linked Process" card. otherProcessId/pairs pre-fill it when
  // loading an existing process's links; called with no args to add a
  // blank card for the operator to configure. myAxisKey/theirAxisKey
  // pre-fill the same-process axis pickers when otherProcessId ===
  // myProcessId (a saved same-process link being restored).
  addColorLinkCard(otherProcessId = '', pairs = [], myAxisKey = '', theirAxisKey = '') {
    const container = document.getElementById('processColorLinksContainer');
    const myProcessId = document.getElementById('processFormProcessId')?.value || '';
    if (!container || !myProcessId) return;

    const isSelf = !!otherProcessId && otherProcessId === myProcessId;
    const cardId = 'proc_colorlink_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    const processOptionsHtml = `<option value="${this.COLOR_LINK_SELF_VALUE}" ${isSelf ? 'selected' : ''}>— This process (pair two of its own axes) —</option>` +
      (App.State.globalProcesses || [])
        .filter(p => p.processId !== myProcessId)
        .map(p => `<option value="${escapeHtml(p.processId)}" ${!isSelf && p.processId === otherProcessId ? 'selected' : ''}>${escapeHtml(p.processName)}</option>`)
        .join('');

    const html = `
  <div class="card border-secondary-subtle shadow-sm mb-3 proc-colorlink-card" id="${cardId}">
    <div class="card-header bg-white d-flex align-items-center gap-2 flex-wrap">
      <label class="fw-bold mb-0 text-secondary">Linked Process:</label>
      <select class="form-select form-select-sm proc-colorlink-process-select" style="max-width:260px;">
        <option value="">Choose a process...</option>
        ${processOptionsHtml}
      </select>
      <button type="button" class="btn btn-outline-danger btn-sm ms-auto" onclick="App.Process.removeColorLinkCard('${cardId}')">Remove Link</button>
    </div>
    <div class="card-body">
      <div class="row g-2 mb-2 proc-colorlink-self-axes-wrapper" style="display:none;">
        <div class="col-md-6">
          <label class="small fw-bold text-secondary mb-1">My Axis</label>
          <select class="form-select form-select-sm proc-colorlink-my-axis"><option value="">Choose an axis...</option></select>
        </div>
        <div class="col-md-6">
          <label class="small fw-bold text-secondary mb-1">Pairs With This Other Axis</label>
          <select class="form-select form-select-sm proc-colorlink-their-axis"><option value="">Choose an axis...</option></select>
        </div>
      </div>
      <p class="text-muted small mb-2 proc-colorlink-hint">Select a process above to map colors.</p>
      <div class="table-responsive proc-colorlink-mapping-wrapper" style="display:none;">
        <table class="table table-bordered bg-white shadow-sm mb-0">
          <thead class="table-light">
            <tr>
              <th>This Process's Color</th>
              <th>Maps To</th>
            </tr>
          </thead>
          <tbody class="proc-colorlink-mapping-body"></tbody>
        </table>
      </div>
    </div>
  </div>`;

    container.insertAdjacentHTML('beforeend', html);
    const card = document.getElementById(cardId);
    this.initColorLinkSelect2(card, myProcessId);

    if (isSelf) {
      card.querySelector('.proc-colorlink-self-axes-wrapper').style.display = '';
      this.populateSelfAxisPickers(card, myProcessId, myAxisKey, theirAxisKey, pairs);
    } else if (otherProcessId) {
      this.populateColorLinkMapping(card, myProcessId, otherProcessId, pairs);
    }
  },

  initColorLinkSelect2(card, myProcessId) {
    const selectEl = card?.querySelector('.proc-colorlink-process-select');
    if (!selectEl) return;

    if (window.jQuery?.fn?.select2) {
      const $select = window.jQuery(selectEl);
      const $parentModal = $select.closest('.modal');
      $select.select2({
        placeholder: 'Choose a process...',
        width: '100%',
        matcher: App.Utils.select2Matcher,
        dropdownParent: $parentModal.length ? $parentModal : window.jQuery(document.body)
      });
    }
    selectEl.addEventListener('change', () => {
      const value = selectEl.value;
      const selfWrapper = card.querySelector('.proc-colorlink-self-axes-wrapper');
      if (value === this.COLOR_LINK_SELF_VALUE) {
        if (selfWrapper) selfWrapper.style.display = '';
        this.populateSelfAxisPickers(card, myProcessId, '', '', []);
      } else {
        if (selfWrapper) selfWrapper.style.display = 'none';
        if (value) this.populateColorLinkMapping(card, myProcessId, value, []);
      }
    });
  },

  // Renders the shared "This Process's Color -> Maps To" mapping table body
  // from two already-resolved color lists -- used by both the cross-process
  // flow (flat getProcessColorGroups lists) and the same-process axis-
  // pairing flow (one real axis's own colors on each side, see
  // populateSelfAxisMapping) so the two only differ in WHERE
  // myColors/theirColors come from, not in how the table is built.
  _renderColorLinkMappingRows(tbody, myColors, theirColors, existingPairs) {
    const existingByMyColor = {};
    (existingPairs || []).forEach(p => { existingByMyColor[String(p.myColor || '').toLowerCase()] = p.theirColor; });

    const theirOptionsHtml = (selected) => '<option value="">— Unmapped —</option>' +
      theirColors.map(c => `<option value="${escapeHtml(c)}" ${App.Utils.sameText(c, selected || '') ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('');

    tbody.innerHTML = myColors.map(myColor => `
        <tr>
          <td class="proc-colorlink-my-color" data-color="${escapeHtml(myColor)}">${escapeHtml(myColor)}</td>
          <td><select class="form-select form-select-sm proc-colorlink-their-color">${theirOptionsHtml(existingByMyColor[myColor.toLowerCase()])}</select></td>
        </tr>`).join('');
  },

  // Fetches both processes' color lists (via getProcessColorGroups, same
  // API the Production form's checklist uses) and renders one mapping row
  // per this-process color, each with a dropdown of the other process's
  // colors ("— Unmapped —" leaves that color out of the link). existingPairs
  // pre-selects each row's "Maps To" when loading a saved link.
  async populateColorLinkMapping(card, myProcessId, otherProcessId, existingPairs) {
    const hint = card.querySelector('.proc-colorlink-hint');
    const wrapper = card.querySelector('.proc-colorlink-mapping-wrapper');
    const tbody = card.querySelector('.proc-colorlink-mapping-body');
    if (!tbody) return;

    tbody.innerHTML = '';
    if (hint) { hint.style.display = ''; hint.textContent = 'Loading colors…'; }
    if (wrapper) wrapper.style.display = 'none';

    try {
      const [myRes, theirRes] = await Promise.all([
        Api.call('getProcessColorGroups', myProcessId),
        Api.call('getProcessColorGroups', otherProcessId)
      ]);
      const myColors = myRes?.success ? (myRes.data || []) : [];
      const theirColors = theirRes?.success ? (theirRes.data || []) : [];

      if (myColors.length === 0 || theirColors.length === 0) {
        if (hint) {
          hint.style.display = '';
          hint.textContent = myColors.length === 0
            ? 'This process has no known colors yet — produce at least 2 colors (or configure Color Sub-Groups) before linking.'
            : 'The selected process has no known colors yet.';
        }
        return;
      }

      this._renderColorLinkMappingRows(tbody, myColors, theirColors, existingPairs);
      if (hint) hint.style.display = 'none';
      if (wrapper) wrapper.style.display = '';
    } catch (err) {
      if (hint) { hint.style.display = ''; hint.textContent = 'Failed to load colors: ' + (err.message || err); }
    }
  },

  // Same-process counterpart of initColorLinkSelect2's cross-process flow:
  // fetches THIS process's own axis breakdown (getProcessColorAxes -- the
  // same axis-scoped data the Production checklist and Primary Axis picker
  // use) ONCE, populates both "My Axis"/"Pairs With" pickers from it, and
  // wires their change handlers to render the color mapping table the
  // moment two DIFFERENT axes are chosen on each side. Using axis-scoped
  // color lists here (not the flat getProcessColorGroups union) is what
  // lets two axes sharing a literal color name (e.g. two independent
  // "Purple"s) be paired unambiguously.
  async populateSelfAxisPickers(card, myProcessId, presetMyAxisKey, presetTheirAxisKey, existingPairs) {
    const myAxisSelect = card.querySelector('.proc-colorlink-my-axis');
    const theirAxisSelect = card.querySelector('.proc-colorlink-their-axis');
    const hint = card.querySelector('.proc-colorlink-hint');
    const wrapper = card.querySelector('.proc-colorlink-mapping-wrapper');
    if (!myAxisSelect || !theirAxisSelect) return;

    if (hint) { hint.style.display = ''; hint.textContent = 'Loading this process\'s axes…'; }
    if (wrapper) wrapper.style.display = 'none';

    let axes = [];
    try {
      const res = await Api.call('getProcessColorAxes', myProcessId);
      axes = (res?.success && Array.isArray(res.data?.axes)) ? res.data.axes : [];
    } catch (err) {
      if (hint) { hint.style.display = ''; hint.textContent = 'Failed to load this process\'s axes: ' + (err.message || err); }
      return;
    }

    if (axes.length < 2) {
      if (hint) {
        hint.style.display = '';
        hint.textContent = 'This process needs at least 2 independent color axes (Color Sub-Groups with different Group labels, or 2+ multi-color pool inputs) before its own axes can be paired.';
      }
      return;
    }

    const optionsHtml = (selected) => '<option value="">Choose an axis...</option>' +
      axes.map(a => `<option value="${escapeHtml(a.key)}" ${a.key === selected ? 'selected' : ''}>${escapeHtml(a.label)}</option>`).join('');
    myAxisSelect.innerHTML = optionsHtml(presetMyAxisKey);
    theirAxisSelect.innerHTML = optionsHtml(presetTheirAxisKey);

    if (hint) { hint.style.display = ''; hint.textContent = 'Choose which two of this process\'s own axes to pair.'; }

    const tryRenderMapping = () => this.populateSelfAxisMapping(card, axes, myAxisSelect.value, theirAxisSelect.value, existingPairs);
    myAxisSelect.onchange = tryRenderMapping;
    theirAxisSelect.onchange = tryRenderMapping;

    if (presetMyAxisKey && presetTheirAxisKey) tryRenderMapping();
  },

  // Renders the mapping table for a same-process axis pair once both sides
  // are chosen -- reuses _renderColorLinkMappingRows with each axis's own
  // `colors` (from the same getProcessColorAxes fetch populateSelfAxisPickers
  // already made, not re-fetched).
  populateSelfAxisMapping(card, axes, myAxisKey, theirAxisKey, existingPairs) {
    const hint = card.querySelector('.proc-colorlink-hint');
    const wrapper = card.querySelector('.proc-colorlink-mapping-wrapper');
    const tbody = card.querySelector('.proc-colorlink-mapping-body');
    if (!tbody) return;

    tbody.innerHTML = '';
    if (wrapper) wrapper.style.display = 'none';

    if (!myAxisKey || !theirAxisKey) {
      if (hint) { hint.style.display = ''; hint.textContent = 'Choose which two of this process\'s own axes to pair.'; }
      return;
    }
    if (myAxisKey === theirAxisKey) {
      if (hint) { hint.style.display = ''; hint.textContent = 'Pick two DIFFERENT axes — an axis can\'t be paired with itself.'; }
      return;
    }

    const myAxis = axes.find(a => a.key === myAxisKey);
    const theirAxis = axes.find(a => a.key === theirAxisKey);
    if (!myAxis || !theirAxis || myAxis.colors.length === 0 || theirAxis.colors.length === 0) {
      if (hint) { hint.style.display = ''; hint.textContent = 'One of the chosen axes has no known colors yet.'; }
      return;
    }

    this._renderColorLinkMappingRows(tbody, myAxis.colors, theirAxis.colors, existingPairs);
    if (hint) hint.style.display = 'none';
    if (wrapper) wrapper.style.display = '';
  },

  removeColorLinkCard(cardId) {
    const card = document.getElementById(cardId);
    if (!card) return;
    const selectEl = card.querySelector('.proc-colorlink-process-select');
    if (selectEl && window.jQuery?.fn?.select2) {
      const $select = window.jQuery(selectEl);
      if ($select.data('select2')) $select.select2('destroy');
    }
    card.remove();
  },

  // Groups a process's fetched links (flat array from getProcessColorLinksData)
  // into one card per distinct (otherProcessId, myAxisKey, theirAxisKey)
  // combination -- a cross-process link (both axis keys blank) still groups
  // by otherProcessId alone exactly as before axis keys existed, but a
  // process can now have MULTIPLE same-process links (pairing different
  // pairs of its own axes), each of which needs its own card since they map
  // different axis pairs' colors.
  renderColorLinksData(links) {
    this.clearColorLinks();
    const groups = new Map();
    (links || []).forEach(l => {
      const groupKey = l.otherProcessId + '|' + (l.myAxisKey || '') + '|' + (l.theirAxisKey || '');
      if (!groups.has(groupKey)) groups.set(groupKey, { otherProcessId: l.otherProcessId, myAxisKey: l.myAxisKey || '', theirAxisKey: l.theirAxisKey || '', pairs: [] });
      groups.get(groupKey).pairs.push(l);
    });
    groups.forEach(g => this.addColorLinkCard(g.otherProcessId, g.pairs, g.myAxisKey, g.theirAxisKey));
  },

  clearColorLinks() {
    const container = document.getElementById('processColorLinksContainer');
    if (!container) return;
    container.querySelectorAll('.proc-colorlink-card').forEach(card => {
      const selectEl = card.querySelector('.proc-colorlink-process-select');
      if (selectEl && window.jQuery?.fn?.select2) {
        const $select = window.jQuery(selectEl);
        if ($select.data('select2')) $select.select2('destroy');
      }
    });
    container.innerHTML = '';
  },

  // Walks every Linked Process card's mapping table into the flat
  // {otherProcessId, myColor, theirColor, myAxisKey, theirAxisKey} shape
  // saveProcess expects. Rows left "— Unmapped —" are skipped. A card in
  // "This process" mode resolves otherProcessId to THIS process's own ID
  // and carries its two chosen axis keys on every row -- process_service.py's
  // same-process self-guard requires both to be present and different.
  serializeColorLinks() {
    const myProcessId = document.getElementById('processFormProcessId')?.value || '';
    const links = [];
    document.querySelectorAll('#processColorLinksContainer .proc-colorlink-card').forEach(card => {
      const rawValue = card.querySelector('.proc-colorlink-process-select')?.value || '';
      if (!rawValue) return;
      const isSelf = rawValue === this.COLOR_LINK_SELF_VALUE;
      const otherProcessId = isSelf ? myProcessId : rawValue;
      if (!otherProcessId) return;
      const myAxisKey = isSelf ? (card.querySelector('.proc-colorlink-my-axis')?.value || '') : '';
      const theirAxisKey = isSelf ? (card.querySelector('.proc-colorlink-their-axis')?.value || '') : '';
      if (isSelf && (!myAxisKey || !theirAxisKey || myAxisKey === theirAxisKey)) return;
      card.querySelectorAll('.proc-colorlink-mapping-body tr').forEach(row => {
        const myColor = row.querySelector('.proc-colorlink-my-color')?.dataset.color || '';
        const theirColor = row.querySelector('.proc-colorlink-their-color')?.value || '';
        if (myColor && theirColor) links.push({ otherProcessId, myColor, theirColor, myAxisKey, theirAxisKey });
      });
    });
    return links;
  },

  delete(processId) {
    App.Utils.confirmAction(
      `Are you sure you want to delete process "${processId}"? This cannot be undone.`,
      async () => {
        try {
          const res = await Api.mutate('deleteProcess', processId);
          App.Utils.showToast(res.message, !res.success);
          if (res.success) await this.loadData();
        } catch (err) {
          App.Utils.showToast(err.message || 'Failed to delete process', true);
        }
      }
    );
  }
};

// Wire up Process form submission
document.addEventListener('DOMContentLoaded', function () {
  const processForm = document.getElementById('processForm');
  if (processForm) {
    processForm.onsubmit = async function (e) {
      e.preventDefault();

      const groupsMissingColor = Array.from(document.querySelectorAll('#processColorGroupsContainer .proc-colorgroup-card'))
        .some(card => !(card.querySelector('.proc-colorgroup-select')?.value || '').trim());
      if (groupsMissingColor) {
        App.Utils.showToast('Every Color Sub-Group needs a Color selected (or remove the group).', true);
        return;
      }

      const primaryAxisWrapper = document.getElementById('processPrimaryColorAxisWrapper');
      const primaryAxisPicker = document.getElementById('processPrimaryColorAxis');
      if (primaryAxisWrapper && primaryAxisWrapper.style.display !== 'none' && !(primaryAxisPicker?.value || '').trim()) {
        App.Utils.showToast('This process has more than one independent color choice — pick which one is Primary Axis before saving.', true);
        return;
      }

      const components = App.Process.serializeComponents();
      const dupComponent = App.Process.findDuplicateComponent(components);
      if (dupComponent) {
        const groupLabel = dupComponent.colorGroup === 'COMMON' ? 'Common Components' : `the "${dupComponent.colorGroup}" color sub-group`;
        App.Utils.showToast(`Duplicate component: "${dupComponent.itemName}"${dupComponent.size ? ' (' + dupComponent.size + ')' : ''} already exists in ${groupLabel}. Each item+size may only appear once per group — adjust its Qty / Unit instead of adding it twice.`, true);
        return;
      }

      const formData = Object.fromEntries(new FormData(processForm));
      formData.isFinalStage = !!document.getElementById('processFormIsFinalStage')?.checked;
      formData.active = !!document.getElementById('processFormActive')?.checked;
      formData.components = JSON.stringify(components);
      formData.colorLinks = JSON.stringify(App.Process.serializeColorLinks());
      const isEdit = !!formData.processId;

      const submitBtn = document.getElementById('processSubmitBtn');
      if (submitBtn) submitBtn.disabled = true;

      try {
        const response = await Api.mutate('saveProcess', formData);
        if (response.success) {
          if (isEdit) {
            // Save (edit mode): patch just this one process's data + <tr>
            // in place instead of a full loadData() reload -- see
            // App.Process.patchRowInPlace's doc comment for how it
            // handles the grouped/filtered table views. Falls back to a
            // full reload if the process can't be patched.
            const patched = response.data && response.data.process
              ? App.Process.patchRowInPlace(response.data.process)
              : false;
            if (!patched) await App.Process.loadData();

            // Stay open on the SAME process instead of closing -- Exit
            // (App.Nav.exit) is the only way to close from here now.
            // processId is server-assigned and never user-editable, so
            // it's a safe stable key to re-find this record by.
            const freshIdx = App.State.globalProcesses.findIndex(p => p.processId === formData.processId);
            if (freshIdx !== -1) {
              App.Process.openEditModal(freshIdx);
            } else {
              const modalEl = document.getElementById('editProcessModal');
              if (modalEl) bootstrap.Modal.getOrCreateInstance(modalEl).hide();
            }
          } else {
            // A brand-new process's manual drag-and-drop display order
            // position can't be determined cheaply on the client -- full
            // reload here (an edit doesn't need to, see
            // App.Process.patchRowInPlace).
            await App.Process.loadData();
            await App.Process.openCreateModal();
          }
        }
        App.Utils.showToast(response.message, !response.success, response.success
          ? { type: 'process', value: response.data?.process?.processId || formData.processId }
          : null);
      } catch (err) {
        App.Utils.showToast(err.message || 'Failed to save process', true);
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    };
  }
});
