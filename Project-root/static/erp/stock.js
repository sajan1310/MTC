'use strict';
// stock.js -- App.Unit, App.Color, App.Model, App.ProcessType, App.Stock,
// ported from Apps_Script/Script_Stock.html.
//
// Scope this round: the 4 small header-shortcut masters (Unit/Color/Model/
// Process Type -- deferred since Round 1's "Master-data-shortcut buttons"
// note) plus App.Stock's Items Stock sub-tab (the raw-material stock
// ledger). App.Stock's Warehouse Pool sub-tab is OUT of scope: it's
// fundamentally tied to App.Process/BOM data (Process picker, product-tag/
// color grouping, opening-stock entry against a Process) that doesn't
// exist yet -- that's the Products & Processes round's job. The sub-tab
// pill navigation itself is ported (switchSubTab) so the UI shape is
// visible, but switching to it shows a "not ported yet" placeholder
// instead of throwing on the missing App.Process dependency.
//
// Adaptations from source (documented, not silent):
// - All mutating RPCs (saveUnit/deleteUnit/saveColor/deleteColor/
//   saveModel/deleteModel/saveProcessType/deleteProcessType/
//   updateThreshold/updateDeadStock/adjustStockManually/importStockData)
//   use Api.mutate (not Api.call): every one is mutation=True on the
//   backend, so rpc.py requires a fresh X-Mutation-Id per call.
// - extractColorsFromItemMaster (App.Color.autoExtract) and
//   importProcessTypesFromProcessNames (App.ProcessType.importFromProcessNames)
//   are left wired to their real (backend-missing) RPC calls -- confirmed
//   absent from tags_service.py, whose own module docstring says they're
//   "deferred to the phases that add them" (Process Master, in this case)
//   -- each already has its own try/catch showing an error toast, so a
//   404 degrades the same honest way as any other missing endpoint.
// - printLowStockReport/printFullStockList/bulkPrint are guarded behind
//   App.Print not existing yet; printStockPivot (their shared builder,
//   which writes into a static #print-low-stock-container this round's
//   partial doesn't include) stays as ported dead code, unreachable
//   until both App.Print and that container exist.
// - App.Stock.loadData()'s "refresh Warehouse Pool if its sub-tab is
//   showing" branch and switchSubTab's "entering Warehouse Pool" branch
//   are both guarded against App.Process / this.loadWarehousePoolData
//   not existing yet, showing App.Utils.notPortedYet('Warehouse Pool')
//   instead of throwing.

// ==========================================
// UNIT MASTER NAMESPACE
// ==========================================
App.Unit = {
  _loaded: false,

  // Fetches the Unit Master once and caches it -- called on every tab
  // switch (cheap no-op once loaded) so the unitList datalist and the
  // Item modal's Base/Purchase Unit fields always have data.
  async ensureLoaded() {
    if (this._loaded) return;
    await this.loadData();
  },

  async loadData() {
    const tbody = document.getElementById('unitTableBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="text-center p-3">Loading units...</td></tr>';

    try {
      const response = await Api.call('getUnitsData');
      if (!response.success) {
        App.Utils.showToast(response.message, true);
        return;
      }
      App.State.globalUnits = response.data || [];
      this._loaded = true;
      this.populateDatalists();
      this.renderTable();
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to load units', true);
    }
  },

  populateDatalists() {
    const unitNames = new Set();
    const families = new Set();
    App.State.globalUnits.forEach(u => {
      if (u.unitName) unitNames.add(u.unitName);
      if (u.family) families.add(u.family);
    });

    const fill = (id, values) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = [...values].map(v => `<option value="${escapeHtml(v)}">`).join('');
    };

    fill('unitList', unitNames);
    fill('unitFamilyList', families);
  },

  renderTable() {
    const tbody = document.getElementById('unitTableBody');
    if (!tbody) return;

    const searchEl = document.getElementById('unitMasterSearch');
    const term = (searchEl?.value || '').toLowerCase().trim();
    const units = [...App.State.globalUnits].sort((a, b) => a.unitName.localeCompare(b.unitName));
    const rows = term
      ? units.filter(u => App.Utils.matchesKeywords(`${u.unitName} ${u.family} ${u.remarks || ''}`, term))
      : units;

    let html = '';
    rows.forEach(u => {
      html += `<tr>
        <td><strong>${escapeHtml(u.unitName)}</strong></td>
        <td>${escapeHtml(u.family)}</td>
        <td>${escapeHtml(String(u.factorToBase))}</td>
        <td>${escapeHtml(u.remarks || '')}</td>
        <td>
          <button type="button" class="btn btn-sm btn-outline-dark" onclick="App.Unit.edit('${escapeHtml(u.unitName)}')"><i class="bi bi-pencil"></i></button>
          <button type="button" class="btn btn-sm btn-outline-danger" onclick="App.Unit.delete('${escapeHtml(u.unitName)}')"><i class="bi bi-trash"></i></button>
        </td>
      </tr>`;
    });
    tbody.innerHTML = html || `<tr><td colspan="5" class="text-center text-muted p-3">${term ? 'No units match your search.' : 'No units defined yet.'}</td></tr>`;
  },

  openModal() {
    this.resetForm();
    const searchEl = document.getElementById('unitMasterSearch');
    if (searchEl) searchEl.value = '';
    this.ensureLoaded().then(() => this.renderTable());
    safeModalShow('unitModal');
  },

  resetForm() {
    const form = document.getElementById('unitForm');
    if (form) form.reset();
    document.getElementById('originalUnitName').value = '';
    document.getElementById('unitFormTitle').textContent = 'Add Unit';
  },

  edit(unitName) {
    const u = App.State.globalUnits.find(x => x.unitName === unitName);
    if (!u) return;
    document.getElementById('originalUnitName').value = u.unitName;
    document.getElementById('formUnitName').value = u.unitName;
    document.getElementById('formUnitFamily').value = u.family;
    document.getElementById('formUnitFactor').value = u.factorToBase;
    document.getElementById('formUnitRemarks').value = u.remarks || '';
    document.getElementById('unitFormTitle').textContent = `Edit Unit: ${u.unitName}`;
  },

  async delete(unitName) {
    App.Utils.confirmAction(`Delete unit "${unitName}"? Items already using it as a Base/Purchase Unit will keep the text, but it will no longer appear in suggestions.`, async () => {
      try {
        const res = await Api.mutate('deleteUnit', unitName);
        App.Utils.showToast(res.message, !res.success);
        if (res.success) this.loadData();
      } catch (err) {
        App.Utils.showToast(err.message || 'Failed to delete unit', true);
      }
    });
  }
};

document.addEventListener('DOMContentLoaded', function () {
  const unitForm = document.getElementById('unitForm');
  if (unitForm) {
    unitForm.onsubmit = async function (e) {
      e.preventDefault();
      const formData = Object.fromEntries(new FormData(this));
      const submitBtn = document.getElementById('unitSubmitBtn');
      if (submitBtn) submitBtn.disabled = true;
      try {
        const res = await Api.mutate('saveUnit', formData);
        App.Utils.showToast(res.message, !res.success);
        if (res.success) {
          App.Unit.resetForm();
          App.Unit.loadData();
        }
      } catch (err) {
        App.Utils.showToast(err.message || 'Failed to save unit', true);
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    };
  }
});

// ==========================================
// COLOR MASTER NAMESPACE
// ==========================================
App.Color = {
  _loaded: false,

  async ensureLoaded() {
    if (this._loaded) return;
    await this.loadData();
  },

  async loadData() {
    const tbody = document.getElementById('colorMasterTableBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="4" class="text-center p-3">Loading colors...</td></tr>';

    try {
      const response = await Api.call('getColors');
      if (!response.success) {
        App.Utils.showToast(response.message, true);
        return;
      }
      App.State.globalColors = response.data || [];
      this._loaded = true;
      this.populateDatalist();
      this.renderTable();
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to load colors', true);
    }
  },

  populateDatalist() {
    const el = document.getElementById('colorList');
    if (el) el.innerHTML = App.State.globalColors.map(c => `<option value="${escapeHtml(c.name)}">`).join('');
  },

  renderTable() {
    const tbody = document.getElementById('colorMasterTableBody');
    if (!tbody) return;

    const searchEl = document.getElementById('colorMasterSearch');
    const term = (searchEl?.value || '').toLowerCase().trim();
    const rows = term
      ? App.State.globalColors.filter(c => App.Utils.matchesKeywords(`${c.name} ${c.remarks || ''}`, term))
      : App.State.globalColors;

    let html = '';
    rows.forEach((c, i) => {
      html += `<tr>
        <td class="text-muted">${i + 1}</td>
        <td><strong>${escapeHtml(c.name)}</strong></td>
        <td>${escapeHtml(c.remarks || '')}</td>
        <td>
          <button type="button" class="btn btn-sm btn-outline-dark" onclick="App.Color.edit('${escapeHtml(c.name)}')"><i class="bi bi-pencil"></i></button>
          <button type="button" class="btn btn-sm btn-outline-danger" onclick="App.Color.delete('${escapeHtml(c.name)}')"><i class="bi bi-trash"></i></button>
        </td>
      </tr>`;
    });
    tbody.innerHTML = html || `<tr><td colspan="4" class="text-center text-muted p-3">${term ? 'No colors match your search.' : 'No colors defined yet.'}</td></tr>`;
  },

  openModal() {
    this.resetForm();
    const searchEl = document.getElementById('colorMasterSearch');
    if (searchEl) searchEl.value = '';
    this.ensureLoaded().then(() => this.renderTable());
    safeModalShow('colorMasterModal');
  },

  resetForm() {
    const form = document.getElementById('colorMasterForm');
    if (form) form.reset();
    document.getElementById('originalColorName').value = '';
    document.getElementById('colorMasterFormTitle').textContent = 'Add Color';
  },

  edit(name) {
    const c = App.State.globalColors.find(x => App.Utils.sameText(x.name, name));
    if (!c) return;
    document.getElementById('originalColorName').value = c.name;
    document.getElementById('formColorName').value = c.name;
    document.getElementById('formColorRemarks').value = c.remarks || '';
    document.getElementById('colorMasterFormTitle').textContent = `Edit Color: ${c.name}`;
  },

  async delete(name) {
    App.Utils.confirmAction(`Delete color "${name}"? Components already tagged with it keep the text, but it will no longer appear in suggestions.`, async () => {
      try {
        const res = await Api.mutate('deleteColor', name);
        App.Utils.showToast(res.message, !res.success);
        if (res.success) this.loadData();
      } catch (err) {
        App.Utils.showToast(err.message || 'Failed to delete color', true);
      }
    });
  },

  // Scans Item Name/Narration/Specification on Items Master for
  // hyphen-joined combinations of existing Color Master colors (e.g.
  // "Red-White") not yet in Color Master, then asks before adding them.
  async autoExtract() {
    try {
      const res = await Api.call('extractColorsFromItemMaster');
      if (!res.success) {
        App.Utils.showToast(res.message, true);
        return;
      }

      const { newColors, scannedCount } = res.data;
      if (!newColors.length) {
        App.Utils.showToast(res.message || `Scanned ${scannedCount} item(s) — no new color combinations found.`);
        return;
      }

      App.Utils.confirmAction(
        `Found ${newColors.length} new color combination(s) in Item Master not yet in Color Master: ${newColors.join(', ')}. Add them now?`,
        async () => {
          try {
            for (const name of newColors) {
              await Api.mutate('saveColor', { name });
            }
            App.Utils.showToast(`Added ${newColors.length} new color(s).`);
            this.loadData();
          } catch (err) {
            App.Utils.showToast(err.message || 'Failed to add extracted colors', true);
          }
        }
      );
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to scan Item Master for colors', true);
    }
  }
};

document.addEventListener('DOMContentLoaded', function () {
  const colorForm = document.getElementById('colorMasterForm');
  if (colorForm) {
    colorForm.onsubmit = async function (e) {
      e.preventDefault();
      const formData = Object.fromEntries(new FormData(this));
      const submitBtn = document.getElementById('colorMasterSubmitBtn');
      if (submitBtn) submitBtn.disabled = true;
      try {
        const res = await Api.mutate('saveColor', formData);
        App.Utils.showToast(res.message, !res.success);
        if (res.success) {
          App.Color.resetForm();
          App.Color.loadData();
        }
      } catch (err) {
        App.Utils.showToast(err.message || 'Failed to save color', true);
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    };
  }
});

// ==========================================
// MODEL MASTER NAMESPACE
// ==========================================
App.Model = {
  _loaded: false,

  async ensureLoaded() {
    if (this._loaded) return;
    await this.loadData();
  },

  async loadData() {
    const tbody = document.getElementById('modelMasterTableBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="3" class="text-center p-3">Loading models...</td></tr>';

    try {
      const response = await Api.call('getModels');
      if (!response.success) {
        App.Utils.showToast(response.message, true);
        return;
      }
      App.State.globalModels = response.data || [];
      this._loaded = true;
      this.populateDatalist();
      this.renderTable();
      // Process table grouping keys off the live model list -- if Process
      // finished loading first (a later round), its rows were grouped
      // under 'General' for models; re-render now that real model names
      // are available. App.Process doesn't exist yet, so this is a no-op
      // until that round lands.
      if (App.Process && App.Process.renderTable) App.Process.renderTable();
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to load models', true);
    }
  },

  populateDatalist() {
    const el = document.getElementById('modelList');
    if (el) el.innerHTML = App.State.globalModels.map(m => `<option value="${escapeHtml(m.name)}">`).join('');
  },

  renderTable() {
    const tbody = document.getElementById('modelMasterTableBody');
    if (!tbody) return;

    const searchEl = document.getElementById('modelMasterSearch');
    const term = (searchEl?.value || '').toLowerCase().trim();
    const rows = term
      ? App.State.globalModels.filter(m => App.Utils.matchesKeywords(`${m.name} ${m.remarks || ''}`, term))
      : App.State.globalModels;

    let html = '';
    rows.forEach(m => {
      html += `<tr>
        <td><strong>${escapeHtml(m.name)}</strong></td>
        <td>${escapeHtml(m.remarks || '')}</td>
        <td>
          <button type="button" class="btn btn-sm btn-outline-dark" onclick="App.Model.edit('${escapeHtml(m.name)}')"><i class="bi bi-pencil"></i></button>
          <button type="button" class="btn btn-sm btn-outline-danger" onclick="App.Model.delete('${escapeHtml(m.name)}')"><i class="bi bi-trash"></i></button>
        </td>
      </tr>`;
    });
    tbody.innerHTML = html || `<tr><td colspan="3" class="text-center text-muted p-3">${term ? 'No models match your search.' : 'No models defined yet.'}</td></tr>`;
  },

  openModal() {
    this.resetForm();
    const searchEl = document.getElementById('modelMasterSearch');
    if (searchEl) searchEl.value = '';
    this.ensureLoaded().then(() => this.renderTable());
    safeModalShow('modelMasterModal');
  },

  resetForm() {
    const form = document.getElementById('modelMasterForm');
    if (form) form.reset();
    document.getElementById('originalModelName').value = '';
    document.getElementById('modelMasterFormTitle').textContent = 'Add Model';
  },

  edit(name) {
    const m = App.State.globalModels.find(x => App.Utils.sameText(x.name, name));
    if (!m) return;
    document.getElementById('originalModelName').value = m.name;
    document.getElementById('formModelName').value = m.name;
    document.getElementById('formModelRemarks').value = m.remarks || '';
    document.getElementById('modelMasterFormTitle').textContent = `Edit Model: ${m.name}`;
  },

  async delete(name) {
    App.Utils.confirmAction(`Delete model "${name}"? Products already using it keep the text, but it will no longer appear in suggestions.`, async () => {
      try {
        const res = await Api.mutate('deleteModel', name);
        App.Utils.showToast(res.message, !res.success);
        if (res.success) this.loadData();
      } catch (err) {
        App.Utils.showToast(err.message || 'Failed to delete model', true);
      }
    });
  }
};

document.addEventListener('DOMContentLoaded', function () {
  const modelForm = document.getElementById('modelMasterForm');
  if (modelForm) {
    modelForm.onsubmit = async function (e) {
      e.preventDefault();
      const formData = Object.fromEntries(new FormData(this));
      const submitBtn = document.getElementById('modelMasterSubmitBtn');
      if (submitBtn) submitBtn.disabled = true;
      try {
        const res = await Api.mutate('saveModel', formData);
        App.Utils.showToast(res.message, !res.success);
        if (res.success) {
          App.Model.resetForm();
          App.Model.loadData();
        }
      } catch (err) {
        App.Utils.showToast(err.message || 'Failed to save model', true);
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    };
  }
});

// ==========================================
// PROCESS TYPE MASTER NAMESPACE
// ==========================================
App.ProcessType = {
  _loaded: false,

  async ensureLoaded() {
    if (this._loaded) return;
    await this.loadData();
  },

  async loadData() {
    const tbody = document.getElementById('processTypeMasterTableBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="3" class="text-center p-3">Loading process types...</td></tr>';

    try {
      const response = await Api.call('getProcessTypes');
      if (!response.success) {
        App.Utils.showToast(response.message, true);
        return;
      }
      App.State.globalProcessTypes = response.data || [];
      this._loaded = true;
      this.populateSelect();
      this.renderTable();
      if (App.Process && App.Process.renderTable) App.Process.renderTable();
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to load process types', true);
    }
  },

  // Populates the Process form's Process Type <select> -- that form
  // doesn't exist yet (Products & Processes round), so this is a
  // guarded no-op until then.
  populateSelect() {
    const el = document.getElementById('processFormProcessType');
    if (!el) return;
    const current = el.value;
    el.innerHTML = '<option value="">General (none)</option>' +
      App.State.globalProcessTypes.map(t => `<option value="${escapeHtml(t.name)}">${escapeHtml(t.name)}</option>`).join('');
    el.value = current;
    if (window.jQuery?.fn?.select2) {
      const $el = window.jQuery(el);
      if ($el.data('select2')) $el.select2('destroy');
      const $modal = $el.closest('.modal');
      $el.select2({
        placeholder: 'General (none)',
        width: '100%',
        allowClear: true,
        matcher: App.Utils.select2Matcher,
        dropdownParent: $modal.length ? $modal : window.jQuery(document.body)
      });
    }
  },

  renderTable() {
    const tbody = document.getElementById('processTypeMasterTableBody');
    if (!tbody) return;

    const searchEl = document.getElementById('processTypeMasterSearch');
    const term = (searchEl?.value || '').toLowerCase().trim();
    const rows = term
      ? App.State.globalProcessTypes.filter(t => App.Utils.matchesKeywords(`${t.name} ${t.remarks || ''}`, term))
      : App.State.globalProcessTypes;

    let html = '';
    rows.forEach(t => {
      html += `<tr>
        <td><strong>${escapeHtml(t.name)}</strong></td>
        <td>${escapeHtml(t.remarks || '')}</td>
        <td>
          <button type="button" class="btn btn-sm btn-outline-dark" onclick="App.ProcessType.edit('${escapeHtml(t.name)}')"><i class="bi bi-pencil"></i></button>
          <button type="button" class="btn btn-sm btn-outline-danger" onclick="App.ProcessType.delete('${escapeHtml(t.name)}')"><i class="bi bi-trash"></i></button>
        </td>
      </tr>`;
    });
    tbody.innerHTML = html || `<tr><td colspan="3" class="text-center text-muted p-3">${term ? 'No process types match your search.' : 'No process types defined yet.'}</td></tr>`;
  },

  openModal() {
    this.resetForm();
    const searchEl = document.getElementById('processTypeMasterSearch');
    if (searchEl) searchEl.value = '';
    this.ensureLoaded().then(() => this.renderTable());
    safeModalShow('processTypeMasterModal');
  },

  resetForm() {
    const form = document.getElementById('processTypeMasterForm');
    if (form) form.reset();
    document.getElementById('originalProcessTypeName').value = '';
    document.getElementById('processTypeMasterFormTitle').textContent = 'Add Process Type';
  },

  edit(name) {
    const t = App.State.globalProcessTypes.find(x => App.Utils.sameText(x.name, name));
    if (!t) return;
    document.getElementById('originalProcessTypeName').value = t.name;
    document.getElementById('formProcessTypeName').value = t.name;
    document.getElementById('formProcessTypeRemarks').value = t.remarks || '';
    document.getElementById('processTypeMasterFormTitle').textContent = `Edit Process Type: ${t.name}`;
  },

  async delete(name) {
    App.Utils.confirmAction(`Delete process type "${name}"? Processes already using it keep the text, but it will no longer appear in suggestions.`, async () => {
      try {
        const res = await Api.mutate('deleteProcessType', name);
        App.Utils.showToast(res.message, !res.success);
        if (res.success) this.loadData();
      } catch (err) {
        App.Utils.showToast(err.message || 'Failed to delete process type', true);
      }
    });
  },

  // Re-matches every Process Master row's Process Type against this
  // master's names. Backend RPC doesn't exist yet (Process Master isn't
  // ported) -- left wired to the real (currently 404ing) call, same as
  // App.Color.autoExtract.
  importFromProcessNames() {
    App.Utils.confirmAction(
      'This re-matches every Process\'s Process Type against the names defined here (whichever is a substring of its Process Name), overwriting the current value — including clearing it to "General" if nothing matches. No new types are created. Continue?',
      async () => {
        try {
          const res = await Api.mutate('importProcessTypesFromProcessNames');
          App.Utils.showToast(res.message, !res.success);
          if (res.success) {
            this.loadData();
            if (App.Process && App.Process.loadData) App.Process.loadData();
          }
        } catch (err) {
          App.Utils.showToast(err.message || 'Failed to import process types', true);
        }
      }
    );
  }
};

document.addEventListener('DOMContentLoaded', function () {
  const processTypeForm = document.getElementById('processTypeMasterForm');
  if (processTypeForm) {
    processTypeForm.onsubmit = async function (e) {
      e.preventDefault();
      const formData = Object.fromEntries(new FormData(this));
      const submitBtn = document.getElementById('processTypeMasterSubmitBtn');
      if (submitBtn) submitBtn.disabled = true;
      try {
        const res = await Api.mutate('saveProcessType', formData);
        App.Utils.showToast(res.message, !res.success);
        if (res.success) {
          App.ProcessType.resetForm();
          App.ProcessType.loadData();
        }
      } catch (err) {
        App.Utils.showToast(err.message || 'Failed to save process type', true);
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    };
  }
});

// ==========================================
// STOCK MASTER NAMESPACE (Items Stock sub-tab only -- see module header)
// ==========================================
App.Stock = {
  async loadData() {
    const tbody = document.getElementById('stockTableBody');
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="9" class="text-center p-4">Loading Stock Database…</td></tr>';
    }

    try {
      const savedSort = localStorage.getItem('stockDeadSortMode');
      if (savedSort === 'default' || savedSort === 'last' || savedSort === 'first') {
        App.State.stockDeadSortMode = savedSort;
      }
      const sortSelect = document.getElementById('stockDeadSort');
      if (sortSelect) sortSelect.value = App.State.stockDeadSortMode;

      const res = await Api.call('getStockData');
      if (!res?.success) {
        App.Utils.showToast(res?.message || 'Failed to load stock data.', true);
        return;
      }

      App.State.globalStock = Array.isArray(res.data) ? res.data : [];
      App.State.filteredStock = [...App.State.globalStock];
      App.State.stockCurrentPage = 1;
      App.State.selectedStock = [];

      this.renderAlerts();
      this.renderTable();

      // If the Warehouse Pool sub-tab is the one currently showing,
      // refresh it too -- guarded since loadWarehousePoolData isn't
      // ported yet (Warehouse Pool is deferred to the Products &
      // Processes round; see module header comment).
      const poolTab = document.getElementById('warehousePoolSubTab');
      if (poolTab && poolTab.style.display !== 'none' && typeof this.loadWarehousePoolData === 'function') {
        this.loadWarehousePoolData();
      }
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to load stock data.', true);
    }
  },

  switchSubTab(id) {
    $$('.stock-sub-tab').forEach(t => t.style.display = 'none');
    const target = document.getElementById(id);
    if (target) target.style.display = 'block';

    $$('#stockSubTabs .nav-link').forEach(btn => btn.classList.remove('active'));
    document.getElementById('btn-' + id)?.classList.add('active');

    if (id === 'warehousePoolSubTab') {
      if (typeof App.Process === 'undefined' || typeof this.loadWarehousePoolData !== 'function') {
        App.Utils.notPortedYet('Warehouse Pool');
        return;
      }
      App.Process.ensureLoaded().then(() => this.loadWarehousePoolData());
    }
  },

  setDeadSortMode(mode) {
    if (mode !== 'default' && mode !== 'last' && mode !== 'first') return;
    App.State.stockDeadSortMode = mode;
    localStorage.setItem('stockDeadSortMode', mode);
    App.State.stockCurrentPage = 1;
    this.renderTable();
  },

  // Stable sort (ties keep their relative order) so dead-stock
  // repositioning never disturbs the underlying latest-first ordering
  // within the dead / non-dead groups themselves.
  applyDeadSort(list) {
    const mode = App.State.stockDeadSortMode;
    if (mode === 'last') return [...list].sort((a, b) => (a.deadStock ? 1 : 0) - (b.deadStock ? 1 : 0));
    if (mode === 'first') return [...list].sort((a, b) => (b.deadStock ? 1 : 0) - (a.deadStock ? 1 : 0));
    return list;
  },

  renderTable() {
    const tbody = document.getElementById('stockTableBody');
    if (!tbody) return;

    const emptyState = document.getElementById('stockEmptyState');
    if (!App.State.filteredStock.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="text-center text-muted p-4">No stock records found.</td></tr>';
      if (emptyState) emptyState.style.display = 'block';
      App.Utils.renderPagination('stockPagination', 0, 1, App.State.stockRowsPerPage, 'stock-page', 'Items');
      this.updateBulkButtons();
      return;
    }
    if (emptyState) emptyState.style.display = 'none';

    const { filteredStock, stockCurrentPage: cur, stockRowsPerPage: rpp } = App.State;
    const displayStock = this.applyDeadSort(filteredStock);
    const start = (cur - 1) * rpp;
    const pageItems = displayStock.slice(start, start + rpp);

    const selectAllChk = document.getElementById('selectAllStock');
    if (selectAllChk) {
      selectAllChk.checked = pageItems.length > 0 &&
        pageItems.every(item => App.Selection.isSelected(App.State.selectedStock, this.stockKey(item)));
    }

    tbody.innerHTML = pageItems.map(item => {
      const statusBadge = item.isLowStock
        ? '<span class="badge bg-danger px-2 py-1 shadow-sm">Low Stock</span>'
        : '<span class="badge bg-success px-2 py-1 shadow-sm">Well Stocked</span>';

      const rowClass = item.isLowStock ? 'low-stock-row' : '';
      const key = this.stockKey(item);
      const checked = App.Selection.isSelected(App.State.selectedStock, key) ? 'checked' : '';
      const encName = encodeURIComponent(item.name);
      const encSize = encodeURIComponent(item.size || '');
      const deadChecked = item.deadStock ? 'checked' : '';
      const deadRowStyle = item.deadStock ? 'opacity: 0.6;' : '';

      return `
  <tr class="${rowClass}" style="${deadRowStyle}">
    <td class="text-center"><input type="checkbox" class="form-check-input stock-select-chk" data-key="${escapeHtml(key)}" ${checked} onchange="App.Stock.onRowSelectChange()"></td>
    <td><strong class="text-dark">${escapeHtml(item.name)}</strong></td>
    <td><span class="badge bg-secondary">${escapeHtml(item.size || 'GENERAL')}</span></td>
    <td class="text-center fw-bold">${item.initialStock}</td>
    <td class="text-center fw-bold ${item.isLowStock ? 'text-danger' : 'text-success'}">
      <span class="stock-current-display" data-qty="${item.currentStock}" style="cursor:text;border-bottom:1px dashed #999;" title="Click to edit"
            onclick="App.Stock.editStockCell(this, '${encName}', '${encSize}')">${item.currentStock}</span>
    </td>
    <td class="text-center">
      <input type="number"
             class="form-control form-control-sm mx-auto text-center threshold-input"
             data-name="${escapeHtml(item.name)}"
             data-size="${escapeHtml(item.size)}"
             value="${item.threshold}"
             min="0"
             onchange="App.Stock.saveThreshold(this)"
             style="width: 80px; font-weight: bold; border-color: #ced4da;">
    </td>
    <td class="text-center">${statusBadge}</td>
    <td class="text-center">
      <div class="form-check d-flex justify-content-center mb-0">
        <input type="checkbox" class="form-check-input dead-stock-chk" ${deadChecked}
               data-enc-name="${encName}" data-enc-size="${encSize}"
               onchange="App.Stock.toggleDeadStock(this)"
               title="${item.deadStock ? 'Unmark as dead stock' : 'Mark as dead stock'}">
      </div>
    </td>
    <td class="text-center">
      <button type="button" class="btn btn-outline-warning btn-sm" title="Correct stock manually"
              onclick="App.Stock.openAdjustModal('${escapeHtml(item.name).replace(/'/g, "\\'")}', '${escapeHtml(item.size || '').replace(/'/g, "\\'")}', ${item.currentStock})">
        <i class="bi bi-pencil-square"></i>
      </button>
    </td>
  </tr>`;
    }).join('');

    App.Utils.renderPagination('stockPagination', filteredStock.length, cur, rpp, 'stock-page', 'Items');
    this.updateBulkButtons();
  },

  // Click-to-edit Current Stock cell. Saves by SETTING Current Stock to
  // the typed value (adjustStockManually -- same overwrite semantics as
  // the "Correct stock manually" modal), using a fixed reason since
  // there's no separate field for one in this inline flow.
  editStockCell(spanEl, encName, encSize) {
    const td = spanEl.closest('td');
    if (!td) return;
    const oldQty = parseFloat(spanEl.dataset.qty) || 0;
    const originalHtml = td.innerHTML;
    const revert = () => { td.innerHTML = originalHtml; };

    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'form-control form-control-sm text-center d-inline-block';
    input.style.width = '100px';
    input.step = 'any';
    input.value = oldQty;
    td.innerHTML = '';
    td.appendChild(input);
    input.focus();
    input.select();

    const name = decodeURIComponent(encName || '');
    const size = decodeURIComponent(encSize || '');

    // Patches both state arrays and re-renders -- Current Stock drives
    // isLowStock, which in turn drives this row's color/badge and the
    // whole Alerts panel, so a full renderTable()/renderAlerts() is
    // simpler and safer than hand-patching every derived bit of UI.
    const applyLocally = (qty) => {
      const item = App.State.globalStock.find(i => App.Utils.sameText(i.name, name) && App.Utils.sameText(i.size || '', size));
      if (item) { item.currentStock = qty; item.isLowStock = qty < item.threshold; }
      const filteredItem = App.State.filteredStock.find(i => App.Utils.sameText(i.name, name) && App.Utils.sameText(i.size || '', size));
      if (filteredItem) { filteredItem.currentStock = qty; filteredItem.isLowStock = qty < filteredItem.threshold; }
      this.renderAlerts();
      this.renderTable();
    };

    let settled = false;
    const finish = async () => {
      if (settled) return;
      settled = true;

      const newQty = parseFloat(input.value);
      if (isNaN(newQty)) {
        App.Utils.showToast('Current Stock must be a valid number.', true);
        revert();
        return;
      }
      if (newQty === oldQty) {
        revert();
        return;
      }

      try {
        const res = await Api.mutate('adjustStockManually', name, size, newQty, 'Inline edit via Stock table');
        if (!res?.success) {
          App.Utils.showToast(res?.message || 'Failed to update stock.', true);
          // The server's "nothing to adjust" rejection means its fresh
          // read of Current Stock already equals newQty -- i.e. our
          // on-screen oldQty was stale. Reconcile the display to that
          // authoritative value instead of reverting to the stale one.
          const serverQty = res?.data?.oldCurrentStock;
          if (typeof serverQty === 'number' && !isNaN(serverQty) && serverQty !== oldQty) {
            applyLocally(serverQty);
          } else {
            revert();
          }
          return;
        }

        applyLocally(newQty);
        App.Utils.showToast('Stock updated.');
      } catch (err) {
        App.Utils.showToast(err.message || 'Failed to update stock.', true);
        revert();
      }
    };

    input.addEventListener('blur', finish);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Escape') {
        settled = true;
        revert();
      }
    });
  },

  // Builds a stable string key for a stock row (Item Name + Size).
  stockKey(item) {
    return `${item.name}|${item.size || ''}`;
  },

  toggleSelectAll(masterChk) {
    App.Selection.toggleAll(App.State.selectedStock, 'stock-select-chk', masterChk);
    this.updateBulkButtons();
  },

  // Selects (or, if every currently-filtered/searched item is already
  // selected, deselects) every item matching the active search -- not
  // just the ones visible on the current page.
  selectAllFiltered() {
    const keys = App.State.filteredStock.map(item => this.stockKey(item));
    const allSelected = keys.length > 0 &&
      keys.every(key => App.Selection.isSelected(App.State.selectedStock, key));
    App.State.selectedStock = allSelected ? [] : keys;
    this.renderTable();
  },

  onRowSelectChange() {
    App.Selection.syncFromRows(App.State.selectedStock, 'stock-select-chk', 'selectAllStock');
    this.updateBulkButtons();
  },

  updateBulkButtons() {
    const count = App.State.selectedStock.length;
    App.Selection.updateButton('btnBulkPrintStock', count, '<i class="bi bi-printer"></i> Print Selected');
  },

  bulkPrint() {
    if (typeof App.Print === 'undefined') {
      App.Utils.notPortedYet('Printing');
      return;
    }

    const selected = App.State.selectedStock;
    if (selected.length === 0) return;

    const items = App.State.globalStock.filter(item => App.Selection.isSelected(selected, this.stockKey(item)));
    if (items.length === 0) return;

    const term = App.State.stockSearchTerm;
    this.printStockPivot(items, [], {
      subtitle: 'Selected Item & Stock Register',
      reportType: term
        ? `Selected Stock Items — Search: "${term}"`
        : 'Selected Stock Items (Current Stock by Size)',
      fileNamePrefix: term
        ? `Stock_Report_Selected_${term.replace(/[^a-zA-Z0-9_-]+/g, '_')}`
        : 'Stock_Report_Selected',
      emptyMessage: 'No stock items selected.'
    });
  },

  changePage(page) {
    App.State.stockCurrentPage = App.Utils.clampPage(page, App.State.filteredStock.length, App.State.stockRowsPerPage);
    this.renderTable();
  },

  renderAlerts() {
    const alertSection = document.getElementById('lowStockAlertSection');
    if (!alertSection) return;

    const lowStockItems = App.State.globalStock.filter(item => item.isLowStock);

    if (lowStockItems.length > 0) {
      alertSection.innerHTML = `
  <div class="card border-danger shadow-sm mb-3">
    <div class="card-header bg-danger text-white py-2 fw-bold d-flex justify-content-between align-items-center">
      <span><i class="bi bi-exclamation-triangle-fill me-2"></i>Low Stock Warnings (${lowStockItems.length} Items)</span>
      <span class="badge bg-white text-danger font-monospace">${lowStockItems.length}</span>
    </div>
    <div class="card-body py-2 px-3 bg-white">
      <div class="row g-2" style="max-height: 180px; overflow-y: auto;">
        ${lowStockItems.map(item => `
          <div class="col-md-4 col-sm-6">
            <div class="p-2 border rounded bg-light d-flex justify-content-between align-items-center shadow-xs">
              <div style="min-width: 0;">
                <strong class="text-dark text-truncate d-block" style="font-size: 13px;" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong>
                <div class="text-muted" style="font-size: 11px;">Size: ${escapeHtml(item.size || 'GENERAL')}</div>
              </div>
              <div class="text-end ps-2 flex-shrink-0">
                <span class="badge bg-danger fs-6">${item.currentStock}</span>
                <div class="text-muted" style="font-size: 10px;">Min: ${item.threshold}</div>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  </div>`;
    } else {
      alertSection.innerHTML = `
  <div class="alert alert-success border-0 shadow-sm d-flex align-items-center mb-0 py-3" role="alert">
    <i class="bi bi-check-circle-fill fs-4 text-success me-3"></i>
    <div>
      <h6 class="alert-heading mb-0 fw-bold">All items are well stocked!</h6>
      <p class="mb-0" style="font-size: 12px; opacity: 0.9;">No inventory items have fallen below their minimum threshold levels.</p>
    </div>
  </div>`;
    }
  },

  filterData(term) {
    App.State.stockSearchTerm = String(term || '').trim();
    const cleanTerm = App.State.stockSearchTerm.toLowerCase();
    if (!cleanTerm) {
      App.State.filteredStock = [...App.State.globalStock];
    } else {
      App.State.filteredStock = App.State.globalStock.filter(item =>
        App.Utils.matchesKeywords(`${item.name} ${item.size}`, cleanTerm)
      );
    }
    App.State.stockCurrentPage = 1;
    this.renderTable();
  },

  async toggleDeadStock(chk) {
    const encName = chk.getAttribute('data-enc-name');
    const encSize = chk.getAttribute('data-enc-size');
    const name = decodeURIComponent(encName || '');
    const size = decodeURIComponent(encSize || '');
    const isDeadStock = chk.checked;

    chk.disabled = true;
    try {
      const res = await Api.mutate('updateDeadStock', name, size, isDeadStock);
      if (!res?.success) {
        App.Utils.showToast(res?.message || 'Failed to update dead stock status.', true);
        chk.checked = !isDeadStock;
        chk.disabled = false;
        return;
      }

      const item = App.State.globalStock.find(i => App.Utils.sameText(i.name, name) && App.Utils.sameText(i.size || '', size));
      if (item) item.deadStock = isDeadStock;
      const filteredItem = App.State.filteredStock.find(i => App.Utils.sameText(i.name, name) && App.Utils.sameText(i.size || '', size));
      if (filteredItem) filteredItem.deadStock = isDeadStock;

      const tr = chk.closest('tr');
      if (tr) tr.style.opacity = isDeadStock ? '0.6' : '';
      chk.title = isDeadStock ? 'Unmark as dead stock' : 'Mark as dead stock';
      App.Utils.showToast(isDeadStock ? `${name} marked as dead stock.` : `${name} removed from dead stock.`);
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to update dead stock status.', true);
      chk.checked = !isDeadStock;
    } finally {
      chk.disabled = false;
    }
  },

  openDeadStockDialog() {
    const deadItems = (App.State.globalStock || []).filter(i => i.deadStock);
    const tbody = document.getElementById('deadStockModalBody');
    if (tbody) {
      if (deadItems.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted p-4">No items are currently marked as dead stock.</td></tr>';
      } else {
        tbody.innerHTML = deadItems.map(item => {
          const encName = encodeURIComponent(item.name);
          const encSize = encodeURIComponent(item.size || '');
          return `<tr>
            <td><strong>${escapeHtml(item.name)}</strong></td>
            <td><span class="badge bg-secondary">${escapeHtml(item.size || 'GENERAL')}</span></td>
            <td class="text-center fw-bold">${item.currentStock}</td>
            <td class="text-center">
              <button type="button" class="btn btn-sm btn-outline-danger"
                      onclick="App.Stock.unmarkDeadStockFromDialog('${encName}', '${encSize}', this)"
                      title="Remove from dead stock">
                <i class="bi bi-x-circle me-1"></i>Remove
              </button>
            </td>
          </tr>`;
        }).join('');
      }
    }
    safeModalShow('deadStockModal');
  },

  async unmarkDeadStockFromDialog(encName, encSize, btn) {
    const name = decodeURIComponent(encName || '');
    const size = decodeURIComponent(encSize || '');
    if (btn) btn.disabled = true;
    try {
      const res = await Api.mutate('updateDeadStock', name, size, false);
      if (!res?.success) {
        App.Utils.showToast(res?.message || 'Failed to update dead stock status.', true);
        if (btn) btn.disabled = false;
        return;
      }
      const item = App.State.globalStock.find(i => App.Utils.sameText(i.name, name) && App.Utils.sameText(i.size || '', size));
      if (item) item.deadStock = false;
      const filteredItem = App.State.filteredStock.find(i => App.Utils.sameText(i.name, name) && App.Utils.sameText(i.size || '', size));
      if (filteredItem) filteredItem.deadStock = false;

      document.querySelectorAll('.dead-stock-chk').forEach(chk => {
        if (chk.getAttribute('data-enc-name') === encName && chk.getAttribute('data-enc-size') === encSize) {
          chk.checked = false;
          const tr = chk.closest('tr');
          if (tr) tr.style.opacity = '';
        }
      });

      App.Utils.showToast(`${name} removed from dead stock.`);
      this.openDeadStockDialog();
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to update dead stock status.', true);
      if (btn) btn.disabled = false;
    }
  },

  async saveThreshold(inputEl) {
    if (!inputEl) return;
    const name = inputEl.getAttribute('data-name');
    const size = inputEl.getAttribute('data-size');
    const thresholdVal = parseInt(inputEl.value, 10);

    if (isNaN(thresholdVal) || 0 > thresholdVal) {
      App.Utils.showToast('Threshold must be a non-negative number.', true);
      return;
    }

    try {
      inputEl.disabled = true;
      const res = await Api.mutate('updateThreshold', name, size, thresholdVal);
      if (res?.success) {
        App.Utils.showToast('Threshold updated successfully.');
        await this.loadData();
      } else {
        App.Utils.showToast(res?.message || 'Failed to update threshold.', true);
        inputEl.disabled = false;
      }
    } catch (err) {
      App.Utils.showToast(err.message || 'Error updating threshold.', true);
      inputEl.disabled = false;
    }
  },

  openImportModal() {
    const form = document.getElementById('stockImportForm');
    if (form) form.reset();
    safeModalShow('importStockModal');
  },

  openAdjustModal(name, size, currentStock) {
    const form = document.getElementById('adjustStockForm');
    if (form) form.reset();

    document.getElementById('adjustStockName').value = name;
    document.getElementById('adjustStockSize').value = size;
    document.getElementById('adjustStockItemLabel').value = `${name} (${size || 'GENERAL'})`;
    document.getElementById('adjustStockOldValue').value = currentStock;
    document.getElementById('adjustStockNewValue').value = currentStock;

    safeModalShow('adjustStockModal');
  },

  async handleAdjustSubmit(e) {
    e.preventDefault();

    const name = document.getElementById('adjustStockName').value;
    const size = document.getElementById('adjustStockSize').value;
    const newValue = parseFloat(document.getElementById('adjustStockNewValue').value);
    const reason = document.getElementById('adjustStockReason').value.trim();

    if (isNaN(newValue)) {
      App.Utils.showToast('Corrected stock must be a valid number.', true);
      return;
    }
    if (!reason) {
      App.Utils.showToast('Please provide a reason for this adjustment.', true);
      return;
    }

    const submitBtn = document.getElementById('adjustStockSubmitBtn');
    try {
      if (submitBtn) { submitBtn.disabled = true; submitBtn.innerText = 'Saving...'; }
      const res = await Api.mutate('adjustStockManually', name, size, newValue, reason);
      App.Utils.showToast(res?.message || 'Stock adjusted.', !res?.success);
      if (res?.success) {
        safeModalHide('adjustStockModal');
        await this.loadData();
      }
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to adjust stock.', true);
    } finally {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = 'Save Correction'; }
    }
  },

  handleImport(e) {
    e.preventDefault();

    const fileInput = document.getElementById('stockFileInput');
    if (!fileInput || !fileInput.files.length) {
      App.Utils.showToast('Please select a CSV or Excel file to upload.', true);
      return;
    }

    const file = fileInput.files[0];
    const submitBtn = document.getElementById('stockImportSubmitBtn');

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerText = 'Parsing File...';
    }

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        if (typeof XLSX === 'undefined') {
          await loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
        }

        const data = new Uint8Array(event.target.result);
        const workbook = XLSX.read(data, { type: 'array' });

        if (!workbook.SheetNames.length) {
          throw new Error('Workbook contains no sheets.');
        }

        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];

        const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
        if (2 > rows.length) {
          throw new Error('File does not contain enough data (missing header or content rows).');
        }

        const headers = (rows[0] || []).map(h => String(h || '').trim().toLowerCase());

        const nameIdx = headers.findIndex(h => h.includes('item name') || h === 'item' || h === 'name' || h === 'item_name');
        const sizeIdx = headers.findIndex(h => h === 'size' || h.includes('size'));
        const qtyIdx = headers.findIndex(h => h.includes('quantity') || h.includes('qty') || h.includes('initial') || h.includes('stock'));

        if (nameIdx === -1) {
          throw new Error('Could not find column for "Item Name" in headers.');
        }
        if (qtyIdx === -1) {
          throw new Error('Could not find column for "Quantity" or "Qty" or "Initial Stock" in headers.');
        }

        const items = [];
        for (let i = 1; rows.length > i; i++) {
          const row = rows[i];
          if (!row || row.length === 0) continue;

          const name = String(row[nameIdx] || '').trim();
          const size = sizeIdx !== -1 ? String(row[sizeIdx] || '').trim() : 'GENERAL';
          const qty = Number(row[qtyIdx]);

          if (name && !isNaN(qty) && qty >= 0) {
            items.push({
              name: name,
              size: size,
              initialStock: qty
            });
          }
        }

        if (items.length === 0) {
          throw new Error('No valid item records found in the file. Check item names and quantity numbers.');
        }

        if (submitBtn) {
          submitBtn.innerText = 'Uploading to Server...';
        }

        const res = await Api.mutate('importStockData', items);

        safeModalHide('importStockModal');
        App.Utils.showToast(res?.message || 'Stock imported successfully.', !res?.success);

        if (res?.success) {
          await this.loadData();
        }
      } catch (err) {
        App.Utils.showToast('Failed to parse and import file: ' + err.message, true);
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.innerText = 'Start Import';
        }
      }
    };

    reader.onerror = () => {
      App.Utils.showToast('Failed to read file.', true);
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerText = 'Start Import';
      }
    };

    reader.readAsArrayBuffer(file);
  },

  // ── Print (dead code until App.Print exists) ────────────────────────

  printLowStockReport() {
    if (typeof App.Print === 'undefined') {
      App.Utils.notPortedYet('Printing');
      return;
    }
    const lowStockItems = App.State.globalStock.filter(item => item.isLowStock);
    this.printStockPivot(lowStockItems, [], {
      subtitle: 'Low Stock Alerts & Inventory Status Report',
      reportType: 'Inventory Alert (Low Stock)',
      fileNamePrefix: 'Low_Stock_Report',
      emptyMessage: 'All items are well stocked. No low stock alerts.'
    });
  },

  // Prints every item currently on the Stock sheet (regardless of any
  // active search/filter on the table) as a pivot: one row per item
  // name, one column per size, cell = current stock for that size. Also
  // pulls in every Warehouse Pool bucket (WIP inventory not yet on the
  // Stock sheet) as its own "(Warehouse Pool)" row -- getWarehousePoolData
  // is a real, already-shipped RPC (warehouse_service.py), so this stays
  // fully correct even before the Warehouse Pool sub-tab itself is built.
  async printFullStockList() {
    if (typeof App.Print === 'undefined') {
      App.Utils.notPortedYet('Printing');
      return;
    }

    let poolItems = App.State.globalWarehousePool || [];
    try {
      const poolRes = await Api.call('getWarehousePoolData');
      if (poolRes?.success) {
        poolItems = Array.isArray(poolRes.data) ? poolRes.data : [];
        App.State.globalWarehousePool = poolItems;
      }
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to load Warehouse Pool data; printing stock items only.', true);
    }

    this.printStockPivot(App.State.globalStock, poolItems, {
      subtitle: 'Complete Item & Stock Register',
      reportType: 'Full Inventory List (Current Stock by Size)',
      fileNamePrefix: 'Complete_Item_Stock_List',
      emptyMessage: 'No stock records found.'
    });
  },

  // Populates and prints #print-low-stock-container as a pivot. Shared
  // by printFullStockList, printLowStockReport, and bulkPrint -- all
  // three guard on App.Print before reaching here, so this (and its
  // App.Utils.getSizeFromOutputItemName call, not ported yet -- that's
  // a Process-grouping helper that belongs to the Products & Processes
  // round) is unreachable dead code until then.
  printStockPivot(items, poolItems, {
    subtitle = 'Inventory Status Report',
    reportType = 'Stock Report',
    fileNamePrefix = 'Stock_Report',
    emptyMessage = 'No stock records found.'
  } = {}) {
    const sizeSet = new Set();
    const byName = new Map();
    items.forEach(item => {
      const sizeLabel = item.size || 'GENERAL';
      sizeSet.add(sizeLabel);
      if (!byName.has(item.name)) byName.set(item.name, new Map());
      byName.get(item.name).set(sizeLabel, {
        currentStock: item.currentStock,
        isLowStock: item.isLowStock
      });
    });

    (poolItems || []).forEach(r => {
      if (!r.outputItemName) return;
      const sizeLabel = App.Utils.getSizeFromOutputItemName(r.outputItemName) || 'GENERAL';
      let name = `${r.outputItemName} (Warehouse Pool)`;
      if (r.productTag) name += ` (Tag: ${r.productTag})`;
      if (r.color) name += ` [${r.color}]`;
      sizeSet.add(sizeLabel);
      if (!byName.has(name)) byName.set(name, new Map());
      const sizeMap = byName.get(name);
      const existing = sizeMap.get(sizeLabel);
      sizeMap.set(sizeLabel, {
        currentStock: (existing ? existing.currentStock : 0) + (r.availableQty || 0),
        isLowStock: false
      });
    });

    const sizes = [...sizeSet].sort((a, b) => a.localeCompare(b));
    const names = [...byName.keys()].sort((a, b) => a.localeCompare(b));

    const headerRow = document.getElementById('print-low-stock-header-row');
    if (headerRow) {
      headerRow.innerHTML = `
        <th style="padding:6px;border:1px solid #000;text-align:left;">Item Name</th>
        ${sizes.map(s => `<th style="padding:6px;border:1px solid #000;text-align:center;">${escapeHtml(s)}</th>`).join('')}
      `;
    }

    const subtitleEl = document.getElementById('print-low-stock-subtitle');
    if (subtitleEl) subtitleEl.innerText = subtitle;

    const titleEl = document.getElementById('print-low-stock-report-type');
    if (titleEl) titleEl.innerText = reportType;

    const dateEl = document.getElementById('print-low-stock-date');
    if (dateEl) dateEl.innerText = new Date().toLocaleDateString('en-GB');

    const bodyEl = document.getElementById('print-low-stock-body');
    if (bodyEl) {
      if (!names.length) {
        bodyEl.innerHTML = `<tr><td colspan="${sizes.length + 1}" style="text-align:center;color:#777;padding:24px;">${escapeHtml(emptyMessage)}</td></tr>`;
      } else {
        bodyEl.innerHTML = names.map(name => {
          const sizeMap = byName.get(name);
          const cells = sizes.map(size => {
            const entry = sizeMap.get(size);
            if (!entry) return `<td style="padding:6px;border:1px solid #999;text-align:center;color:#1a1a1a;">-</td>`;
            return `<td style="padding:6px;border:1px solid #999;text-align:center;color:#1a1a1a;${entry.isLowStock ? 'background:#e0e0e0;font-weight:800;' : ''}">${entry.currentStock}</td>`;
          }).join('');
          return `
        <tr>
          <td style="padding:6px;border:1px solid #999;text-align:left;"><strong style="color:#1a1a1a;">${escapeHtml(name)}</strong></td>
          ${cells}
        </tr>
      `;
        }).join('');
      }
    }

    App.Print.trigger('print-low-stock-container', `${fileNamePrefix}_${new Date().toISOString().slice(0, 10)}`);
  }
};
