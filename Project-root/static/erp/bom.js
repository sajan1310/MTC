'use strict';
// bom.js -- App.BOM, ported from Apps_Script/Script_Items.html lines
// 1476-3060 in full (App.Products, the tab-level sub-tab coordinator, and
// the DEFAULT_COST_CATEGORIES constant were already ported in Round 8
// alongside App.Process -- App.Products.switchSubTab's bomTab branch has
// been calling `App.BOM.enterTab()` since that round, guarded behind
// `typeof App.BOM !== 'undefined'`, so this round activates it rather
// than needing to touch that file again).
//
// Adaptations from source (documented, not silent):
// - saveBOM/deleteBOM/deleteBOMsBulk/reorderBOM all use Api.mutate (not
//   Api.call): every one is mutation=True on the backend, so rpc.py
//   requires a fresh X-Mutation-Id per call. verifyBOMAccess/getBOMData/
//   getNextProductId/getBomProcessComponentsDrift/getBOMProductionData/
//   getContractorRateForProcessType are all non-mutating and stay Api.call.
// - No default BOM password exists anywhere in this port (see
//   bom_service.py's module docstring -- the source's own hardcoded
//   ONE_TIME_setBOMPassword plaintext is deliberately not reproduced).
//   verifyBOMAccess cleanly returns {success:false, message:"BOM password
//   has not been configured yet."} until an admin sets one via
//   `flask shell` -- ported as-is, ported UI ($('#bomAccessError')) shows
//   that message inline exactly like any other wrong-password attempt,
//   no special-casing needed. Worth flagging operationally: this tab is
//   genuinely locked out until that one-time setup step happens.
// - App.Contractor.ensureLoaded() (enterTab) is guarded against
//   App.Contractor not existing yet (Contractors is its own later
//   round). App.Contractor.buildProcessTypeOptionsHtml (addCostRow) was
//   already guarded in source itself.
// - bulkPrint is guarded behind App.Print not existing yet; its builder
//   (buildBOMPrintPageHtml) stays as ported dead code.
//
// FIXME (found by wiring up ESLint's no-undef check -- see eslint.config.js
// at the repo root): despite the header comment above claiming
// DEFAULT_COST_CATEGORIES "were already ported in Round 8 alongside
// App.Process", it was defined nowhere in this codebase -- not here, not in
// process.js, not anywhere. populateCostRows() below reads it whenever a
// BOM has no saved additional costs, which includes every "New BOM" click
// (openCreateModal() calls populateCostRows() with no argument at all), so
// this threw an uncaught ReferenceError on that path. Left as an empty
// array rather than guessing at real category names ("Freight",
// "Packaging", or whatever this business's BOM additional costs actually
// are is business content, not something to invent silently) -- this stops
// the crash and makes the Additional Costs table start empty instead,
// exactly as if no suggestions existed. Needs real values from an
// authoritative source before this is more than a placeholder.
const DEFAULT_COST_CATEGORIES = [];

App.BOM = {
  // ── Access control (password-protected BOM data) ────────────────────
  BOM_TOKEN_KEY: 'bomAccessToken',

  getToken() {
    return sessionStorage.getItem(this.BOM_TOKEN_KEY) || '';
  },

  setToken(token) {
    sessionStorage.setItem(this.BOM_TOKEN_KEY, token);
  },

  clearToken() {
    sessionStorage.removeItem(this.BOM_TOKEN_KEY);
  },

  // Called whenever the BOM tab is opened.
  enterTab() {
    App.Process.ensureLoaded();
    if (typeof App.Contractor !== 'undefined') App.Contractor.ensureLoaded();
    App.Color.ensureLoaded();
    App.Model.ensureLoaded();
    App.ProcessType.ensureLoaded();
    // Component-row item picker (addRow/initItemSelect2) and its custom
    // vendor picker (initCustomVendorSelect2) both read Items
    // Master/Vendor Master directly -- ensured here so they're never
    // silently empty just because those tabs weren't visited first.
    if (typeof App.Item !== 'undefined') App.Item.ensureLoaded();
    if (typeof App.Vendor !== 'undefined') App.Vendor.ensureLoaded();
    if (this.getToken()) {
      this.loadData();
    } else {
      this.showLockedState();
      this.promptForAccess();
    }
  },

  showLockedState() {
    const tbody = document.getElementById('bomTableBody');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center p-5">
    <i class="bi bi-lock-fill fs-1 text-muted d-block mb-3"></i>
    <h5 class="fw-bold text-dark">Password Protected</h5>
    <p class="text-muted mb-3">This section contains confidential cost and pricing data.</p>
    <button class="btn btn-primary fw-bold" onclick="App.BOM.promptForAccess()">Enter Password</button>
  </td></tr>`;
    }
    const emptyState = document.getElementById('bomEmptyState');
    if (emptyState) emptyState.style.display = 'none';
    const pagination = document.getElementById('bomPagination');
    if (pagination) pagination.innerHTML = '';
  },

  promptForAccess() {
    const errorEl = document.getElementById('bomAccessError');
    const input = document.getElementById('bomAccessPassword');
    if (errorEl) errorEl.style.display = 'none';
    if (input) input.value = '';

    const modalEl = document.getElementById('bomAccessModal');
    if (modalEl && typeof bootstrap !== 'undefined') {
      bootstrap.Modal.getOrCreateInstance(modalEl).show();
      setTimeout(() => input?.focus(), 300);
    }
  },

  async submitAccessPassword() {
    const input = document.getElementById('bomAccessPassword');
    const errorEl = document.getElementById('bomAccessError');
    const submitBtn = document.getElementById('bomAccessSubmitBtn');
    const password = input ? input.value : '';

    if (submitBtn) submitBtn.disabled = true;

    try {
      const response = await Api.call('verifyBOMAccess', password);
      if (response.success) {
        this.setToken(response.data.token);
        const modalEl = document.getElementById('bomAccessModal');
        if (modalEl && typeof bootstrap !== 'undefined') {
          bootstrap.Modal.getInstance(modalEl)?.hide();
        }
        await this.loadData();
      } else if (errorEl) {
        errorEl.textContent = response.message;
        errorEl.style.display = 'block';
      }
    } catch (err) {
      if (errorEl) {
        errorEl.textContent = err.message || 'Failed to verify password.';
        errorEl.style.display = 'block';
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  },

  // ── Data loading ──────────────────────────────────────────────────
  async loadData() {
    const token = this.getToken();
    if (!token) {
      this.promptForAccess();
      return;
    }

    const tbody = document.getElementById('bomTableBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="text-center p-4">Loading BOM Database...</td></tr>';

    try {
      const response = await Api.call('getBOMData', token);
      if (!response.success) {
        if (response.message && response.message.indexOf('password-protected') !== -1) {
          this.clearToken();
          this.promptForAccess();
          return;
        }
        App.Utils.showToast(response.message, true);
        return;
      }
      App.State.globalBOMs = response.data;
      App.State.filteredBOMs = response.data;
      App.State.bomCurrentPage = 1;
      App.State.selectedBOMs = [];
      this.renderTable();

      if (App.Production && App.Production.populateProductSelect) {
        App.Production.populateProductSelect();
      }
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to load BOM database', true);
    }
  },

  // Loads a cost-free product list (no rates/costs) on app startup so the
  // Production tab's Product dropdown and production sheets work for all
  // users, even before the BOM password has been entered. Not called yet
  // (Production isn't ported) -- ready for that round's Init() to wire in.
  async loadProductionData() {
    try {
      const response = await Api.call('getBOMProductionData');
      if (!response.success) {
        console.error('[BOM] ', response.message);
        return;
      }
      App.State.globalBOMs = response.data;
      App.State.filteredBOMs = response.data;

      if (App.Production && App.Production.populateProductSelect) {
        App.Production.populateProductSelect();
      }
    } catch (err) {
      console.error('[BOM] Failed to load product list:', err.message);
    }
  },

  filterData(searchTerm) {
    const term = searchTerm.toLowerCase().trim();
    if (!term) {
      App.State.filteredBOMs = App.State.globalBOMs;
    } else {
      App.State.filteredBOMs = App.State.globalBOMs.filter(bom => {
        const haystack = [
          bom.productId,
          bom.productName,
          ...bom.components.map(c => `${c.itemName} ${c.vendor}`)
        ].join(' ');
        return App.Utils.matchesKeywords(haystack, term);
      });
    }
    App.State.bomCurrentPage = 1;
    this.renderTable();
  },

  changePage(page) {
    App.State.bomCurrentPage = App.Utils.clampPage(page, App.State.filteredBOMs.length, App.State.bomRowsPerPage);
    this.renderTable();
  },

  renderTable() {
    const tbody = document.getElementById('bomTableBody');
    if (!tbody) return;

    const emptyState = document.getElementById('bomEmptyState');
    if (App.State.filteredBOMs.length === 0) {
      tbody.innerHTML = '';
      if (emptyState) emptyState.style.display = 'block';
      App.Utils.renderPagination('bomPagination', 0, 1, App.State.bomRowsPerPage, 'bom-page', 'Products');
      this.updateBulkButtons();
      return;
    }
    if (emptyState) emptyState.style.display = 'none';

    // Drag-and-drop reordering (and the "show everything on one page so
    // dragging isn't limited to the current page") only makes sense in
    // the default, unfiltered view -- once searching, normal pagination
    // and a static order both resume.
    const searchEl = document.getElementById('searchBOM');
    const isFiltered = !!(searchEl && searchEl.value.trim());
    const dragEnabled = !isFiltered;

    const { filteredBOMs, bomCurrentPage: cur, bomRowsPerPage: pagedRpp } = App.State;
    const rpp = isFiltered ? pagedRpp : Math.max(filteredBOMs.length, 1);
    const start = (cur - 1) * rpp;
    const pageItems = filteredBOMs.slice(start, start + rpp);

    const selectAllChk = document.getElementById('selectAllBOMs');
    if (selectAllChk) {
      selectAllChk.checked = pageItems.length > 0 &&
        pageItems.every(bom => App.Selection.isSelected(App.State.selectedBOMs, bom.productId));
    }

    tbody.innerHTML = pageItems.map(bom => this.rowHtml(bom, dragEnabled)).join('');

    App.Utils.renderPagination('bomPagination', filteredBOMs.length, cur, rpp, 'bom-page', 'Products');
    this.updateBulkButtons();
  },

  // Renders one <tr> for a BOM product. Shared by renderTable's full
  // rebuild and patchRowInPlace's single-row swap below.
  rowHtml(bom, dragEnabled) {
    const idx = App.State.globalBOMs.indexOf(bom);
    const key = String(bom.productId);
    const checked = App.Selection.isSelected(App.State.selectedBOMs, key) ? 'checked' : '';

    const groupOrder = [];
    const groupMap = {};
    bom.components.forEach(c => {
      const groupName = c.processGroup || 'General';
      if (!groupMap[groupName]) { groupMap[groupName] = []; groupOrder.push(groupName); }
      groupMap[groupName].push(c);
    });

    const multiGroup = groupOrder.length > 1;
    const componentLines = bom.components.map(c => {
      const groupBadge = multiGroup
        ? `<span class="badge bg-secondary me-1" style="font-size:0.65em;vertical-align:middle;">${escapeHtml(c.processGroup || 'General')}</span>`
        : '';
      const colorBadge = c.color
        ? `<span class="badge bg-info text-dark me-1" style="font-size:0.65em;vertical-align:middle;">${escapeHtml(c.color)}</span>`
        : '';
      return `${groupBadge}${colorBadge}• ${escapeHtml(c.itemName)} [${escapeHtml(c.size || '-')}] (${escapeHtml(String(c.qtyPerProduct))} qty @ ${formatCurrency(c.rate)} from ${escapeHtml(c.vendor || 'Custom')})`;
    });

    const PREVIEW_LIMIT = 3;
    const needsToggle = componentLines.length > PREVIEW_LIMIT;
    const previewId = `bom_cpreview_${key}`;

    let componentsCell;
    if (!needsToggle) {
      componentsCell = componentLines.join('<br>');
    } else {
      const visibleHtml = componentLines.slice(0, PREVIEW_LIMIT).join('<br>');
      const allHtml = componentLines.join('<br>');
      const remaining = componentLines.length - PREVIEW_LIMIT;
      componentsCell = `
      <div class="bom-preview-collapsed">
        ${visibleHtml}
        <br><a href="#" class="text-primary small fw-bold mt-1 d-inline-block" onclick="event.preventDefault();App.BOM.toggleComponents('${key}',true)">&#9660; Show ${remaining} more</a>
      </div>
      <div class="bom-preview-expanded" style="display:none">
        ${allHtml}
        <br><a href="#" class="text-muted small fw-bold mt-1 d-inline-block" onclick="event.preventDefault();App.BOM.toggleComponents('${key}',false)">&#9650; Show less</a>
      </div>`;
    }

    const rowAttrs = dragEnabled
      ? `draggable="true" ondragstart="App.BOM.onDragStart(event,'${escapeHtml(bom.productId)}')" ondragover="App.BOM.onDragOver(event)" ondrop="App.BOM.onDrop(event,'${escapeHtml(bom.productId)}')" ondragend="App.BOM.onDragEnd(event)"`
      : '';
    const handleCell = dragEnabled
      ? '<td class="text-center text-muted" style="cursor:grab;"><i class="bi bi-grip-vertical"></i></td>'
      : '<td></td>';

    return `<tr ${rowAttrs} data-bom-key="${escapeHtml(key)}">
    ${handleCell}
    <td class="text-center"><input type="checkbox" class="form-check-input bom-select-chk" data-key="${escapeHtml(key)}" ${checked} onchange="App.BOM.onRowSelectChange()"></td>
    <td><span class="badge bg-dark fs-6 shadow-sm">${escapeHtml(bom.productId)}</span></td>
    <td><strong class="text-primary">${escapeHtml(bom.productName)}</strong></td>
    <td id="${previewId}"><small class="text-muted" style="line-height: 1.6;">${componentsCell}</small></td>
    <td class="text-end fw-bold text-success"${
      (bom.colorCosts || []).length > 1
        ? ` title="Cost by color — ${escapeHtml((bom.colorCosts || []).map(c => `${c.color}: ${formatCurrency(c.totalCost)}`).join(', '))} (headline total shown is for ${escapeHtml(bom.colorCosts[0].color)})"`
        : ''
    }>${formatCurrency(bom.grandTotal ?? bom.totalCost)}</td>
    <td class="text-center">
      <button class="btn btn-sm btn-outline-primary btn-action w-100 mb-1" onclick="App.BOM.openEditModal('${idx}')">Edit BOM</button>
      <button class="btn btn-sm btn-outline-dark btn-action w-100 mb-1" onclick="App.BOM.openDuplicateModal('${idx}')">Duplicate BOM</button>
      <button class="btn btn-sm btn-danger btn-action w-100" onclick="App.BOM.delete('${escapeHtml(bom.productId)}')">Delete</button>
    </td>
  </tr>`;
  },

  // Patches one already-loaded product's data + its rendered <tr> after an
  // edit save, instead of a full loadData() reload. productId is
  // server-assigned and never user-editable, so this is a safe stable
  // key. Returns false -- caller should fall back to loadData() -- if the
  // product isn't currently loaded or isn't on the displayed page.
  patchRowInPlace(freshProduct) {
    const key = String(freshProduct.productId);
    const existing = App.State.globalBOMs.find(b => String(b.productId) === key);
    if (!existing) return false;

    Object.assign(existing, freshProduct);

    const tr = document.querySelector(`#bomTableBody tr[data-bom-key="${key}"]`);
    if (!tr) return false;

    const searchEl = document.getElementById('searchBOM');
    const dragEnabled = !(searchEl && searchEl.value.trim());
    tr.outerHTML = this.rowHtml(existing, dragEnabled);
    return true;
  },

  // Drag-and-drop manual reorder (default unfiltered view only).
  _dragSrcId: null,

  onDragStart(e, productId) {
    this._dragSrcId = productId;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', productId); } catch (err) { /* ignored */ }
    }
  },

  onDragOver(e) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  },

  async onDrop(e, targetProductId) {
    e.preventDefault();
    const srcId = this._dragSrcId;
    this._dragSrcId = null;
    if (!srcId || srcId === targetProductId) return;

    const order = [...App.State.globalBOMs].sort((a, b) => a.sequence - b.sequence).map(b => b.productId);
    const fromIdx = order.indexOf(srcId);
    if (fromIdx === -1 || order.indexOf(targetProductId) === -1) return;
    order.splice(fromIdx, 1);
    const toIdx = order.indexOf(targetProductId);
    order.splice(toIdx, 0, srcId);

    try {
      const res = await Api.mutate('reorderBOM', order, this.getToken());
      if (!res.success) {
        App.Utils.showToast(res.message, true);
        return;
      }
      this.loadData();
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to reorder products', true);
    }
  },

  onDragEnd() {
    this._dragSrcId = null;
  },

  toggleSelectAll(masterChk) {
    App.Selection.toggleAll(App.State.selectedBOMs, 'bom-select-chk', masterChk);
    this.updateBulkButtons();
  },

  onRowSelectChange() {
    App.Selection.syncFromRows(App.State.selectedBOMs, 'bom-select-chk', 'selectAllBOMs');
    this.updateBulkButtons();
  },

  updateBulkButtons() {
    const count = App.State.selectedBOMs.length;
    App.Selection.updateButton('btnBulkDeleteBOMs', count, '<i class="bi bi-trash"></i> Delete Selected');
    App.Selection.updateButton('btnBulkPrintBOMs', count, '<i class="bi bi-printer"></i> Print Selected');
    App.Selection.updateButton('btnBulkDownloadPdfBOMs', count, '<i class="bi bi-file-earmark-pdf"></i> Download PDFs');
  },

  async bulkDelete() {
    const selected = App.State.selectedBOMs.slice();
    if (selected.length === 0) return;

    App.Utils.confirmAction(
      `Are you sure you want to permanently delete ${selected.length} BOM definition(s)? This will permanently remove their components. BOMs currently in use by Production lots, Client Orders, or Dispatch will be skipped.`,
      async () => {
        try {
          const res = await Api.mutate('deleteBOMsBulk', selected, App.BOM.getToken());
          App.Utils.showToast(res.message, !res.success);
          if (res.success) {
            App.State.selectedBOMs = [];
            await this.loadData();
          }
        } catch (err) {
          App.Utils.showToast(err.message || 'Failed to delete BOMs', true);
        }
      }
    );
  },

  bulkPrint() {
    if (typeof App.Print === 'undefined') {
      App.Utils.notPortedYet('Printing');
      return;
    }

    const selected = App.State.selectedBOMs;
    if (selected.length === 0) return;

    const boms = App.State.globalBOMs.filter(b => App.Selection.isSelected(selected, b.productId));
    if (boms.length === 0) return;

    App.Print.triggerBulk(boms, bom => this.buildBOMPrintPageHtml(bom), 'BOM_Cost_Sheets_Selected');
  },

  async bulkDownloadPDF() {
    const selected = App.State.selectedBOMs;
    if (selected.length === 0) return;

    const boms = App.State.globalBOMs.filter(b => App.Selection.isSelected(selected, b.productId));
    if (boms.length === 0) return;

    App.Print.renderBulkPages(boms, bom => this.buildBOMPrintPageHtml(bom));
    const filename = App.Print.bulkPdfFilename('BOM_Cost_Sheets', boms.length);
    const ok = await App.Print.downloadElementAsPDF('print-bulk-container', filename);
    if (ok) App.Utils.showToast(`${boms.length} BOM cost sheet(s) exported to PDF!`, false);
  },

  // Builds a fully self-contained "BOM Cost Sheet / Recipe Card" page
  // (mirrors #print-bom-container's markup/styling) for bulk printing.
  buildBOMPrintPageHtml(bom) {
    const BRAND = '#6610f2';
    const reportDate = new Date().toLocaleDateString('en-GB');

    const groupOrder = [];
    const groupMap = {};
    (bom.components || []).forEach(c => {
      const groupName = c.processGroup || 'General';
      if (!groupMap[groupName]) {
        groupMap[groupName] = [];
        groupOrder.push(groupName);
      }
      groupMap[groupName].push(c);
    });

    let groupsHtml = '';
    groupOrder.forEach(groupName => {
      let rowsHtml = '';
      groupMap[groupName].forEach(c => {
        rowsHtml += `<tr>
      <td style="padding:6px;border:1px solid #e5e5e5;font-weight:600;">${escapeHtml(c.itemName)}</td>
      <td style="padding:6px;border:1px solid #e5e5e5;">${escapeHtml(c.size || '-')}</td>
      <td style="padding:6px;border:1px solid #e5e5e5;color:#555;">${escapeHtml(c.narration || '-')}</td>
      <td style="padding:6px;border:1px solid #e5e5e5;">${escapeHtml(c.vendor || 'Custom')}</td>
      <td style="padding:6px;border:1px solid #e5e5e5;text-align:center;">${Number(toNumber(c.qtyPerProduct).toFixed(4))}</td>
      <td style="padding:6px;border:1px solid #e5e5e5;text-align:right;">${formatCurrency(c.rate)}</td>
      <td style="padding:6px;border:1px solid #e5e5e5;text-align:right;font-weight:700;">${formatCurrency(c.lineCost)}</td>
    </tr>`;
      });

      groupsHtml += `
  <div style="margin-bottom:14px;page-break-inside:avoid;break-inside:avoid;">
    ${groupOrder.length > 1 ? `<h6 style="color:${BRAND};font-size:11px;font-weight:700;margin:0 0 8px 0;text-transform:uppercase;letter-spacing:0.5px;-webkit-print-color-adjust:exact;print-color-adjust:exact;">${escapeHtml(groupName)}</h6>` : ''}
    <table style="width:100%;border-collapse:collapse;font-size:11px;">
      <thead>
        <tr style="background-color:${BRAND};color:#fff;font-weight:700;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
          <th style="padding:6px;border:1px solid #bbb;text-align:left;width:22%;">Item Name</th>
          <th style="padding:6px;border:1px solid #bbb;text-align:left;width:10%;">Size</th>
          <th style="padding:6px;border:1px solid #bbb;text-align:left;width:20%;">Narration</th>
          <th style="padding:6px;border:1px solid #bbb;text-align:left;width:16%;">Vendor</th>
          <th style="padding:6px;border:1px solid #bbb;text-align:center;width:10%;">Qty/Unit</th>
          <th style="padding:6px;border:1px solid #bbb;text-align:right;width:11%;">Rate</th>
          <th style="padding:6px;border:1px solid #bbb;text-align:right;width:11%;">Line Cost</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  </div>`;
    });

    let costsRows = '';
    (bom.additionalCosts || []).forEach(cost => {
      costsRows += `<tr>
    <td style="padding:6px;border:1px solid #e5e5e5;">${escapeHtml(cost.description)}</td>
    <td style="padding:6px;border:1px solid #e5e5e5;text-align:right;font-weight:700;">${formatCurrency(cost.rate)}</td>
  </tr>`;
    });
    const costsSectionHtml = (bom.additionalCosts && bom.additionalCosts.length > 0) ? `
  <div style="margin-bottom:14px;page-break-inside:avoid;break-inside:avoid;">
    <h6 style="color:${BRAND};font-size:11px;font-weight:700;margin:0 0 8px 0;text-transform:uppercase;letter-spacing:0.5px;-webkit-print-color-adjust:exact;print-color-adjust:exact;">Additional / Dynamic Costs</h6>
    <table style="width:100%;border-collapse:collapse;font-size:11px;">
      <thead>
        <tr style="background-color:${BRAND};color:#fff;font-weight:700;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
          <th style="padding:6px;border:1px solid #bbb;text-align:left;width:75%;">Description</th>
          <th style="padding:6px;border:1px solid #bbb;text-align:right;width:25%;">Rate</th>
        </tr>
      </thead>
      <tbody>${costsRows}</tbody>
    </table>
  </div>` : '';

    const remarksHtml = bom.remarks ? `
  <div style="margin-top:10px;padding-top:8px;border-top:1px solid #ccc;">
    <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Remarks</span>
    <div style="font-size:12px;color:#1a1a1a;margin-top:2px;white-space:pre-wrap;">${escapeHtml(bom.remarks)}</div>
  </div>` : '';

    return `
<div style="background:#fff;color:#1a1a1a;font-family:'Segoe UI',Arial,sans-serif;font-size:12px;line-height:1.5;padding:14px 20px 12px 20px;margin:0;box-sizing:border-box;width:100%;border-top:5px solid ${BRAND};border-bottom:3px solid ${BRAND};-webkit-print-color-adjust:exact;print-color-adjust:exact;">
  <div style="text-align:center;padding:4px 0 8px 0;">
    ${App.Print.brandHeaderHtml(BRAND)}
    <div style="font-size:10px;color:#555;margin-top:3px;letter-spacing:0.3px;">
      6-B, SHIV SHAKTI ESTATE, VERKA CHOWK, DEHLON ROAD, BHAGWANPURA, 141114 LUDHIANA
    </div>
    <div style="font-size:11px;color:${BRAND};font-weight:700;margin-top:4px;letter-spacing:1px;text-transform:uppercase;">
      Bill of Materials &mdash; Cost Sheet / Recipe Card
    </div>
  </div>
  <div style="height:2px;background:${BRAND};margin:0 0 12px 0;-webkit-print-color-adjust:exact;print-color-adjust:exact;"></div>

  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
    <div style="text-align:left;">
      <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Product ID</span>
      <div style="font-size:15px;font-weight:700;color:${BRAND};-webkit-print-color-adjust:exact;print-color-adjust:exact;">${escapeHtml(bom.productId)}</div>
    </div>
    <div style="flex:1;text-align:center;">
      <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Product Name</span>
      <div style="font-size:16px;font-weight:700;color:#111;">${escapeHtml(bom.productName)}</div>
    </div>
    <div style="text-align:right;">
      <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Report Date</span>
      <div style="font-size:13px;font-weight:700;color:#1a1a1a;">${reportDate}</div>
    </div>
  </div>

  <div style="height:1px;background:#bbb;margin-bottom:14px;"></div>

  ${groupsHtml}
  ${costsSectionHtml}

  <div style="text-align:right;margin-bottom:16px;padding:8px 0 0 0;border-top:2px solid ${BRAND};page-break-inside:avoid;break-inside:avoid;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
    <span style="font-size:11px;font-weight:600;color:#555;">Material Cost:&nbsp;&nbsp;${formatCurrency(bom.totalCost)} &nbsp;&nbsp;|&nbsp;&nbsp; Additional Cost:&nbsp;&nbsp;${formatCurrency(bom.totalAdditionalCost)}</span>
    <br>
    <span style="font-size:13px;font-weight:600;color:#1a1a1a;">Total Estimated Cost (per unit):&nbsp;&nbsp;</span>
    <span style="font-size:15px;font-weight:800;color:${BRAND};-webkit-print-color-adjust:exact;print-color-adjust:exact;">
      ${formatCurrency(bom.grandTotal ?? bom.totalCost)}
    </span>
    ${(bom.colorCosts || []).length > 1 ? `
    <div style="font-size:10px;color:#777;margin-top:2px;">
      Color rows are alternatives, not additive &mdash; cost above is for <strong>${escapeHtml(bom.colorCosts[0].color)}</strong> only.
      By color: ${bom.colorCosts.map(c => `${escapeHtml(c.color)} ${formatCurrency(c.totalCost + bom.totalAdditionalCost)}`).join(' &nbsp;|&nbsp; ')}
    </div>` : ''}
  </div>
  ${remarksHtml}
</div>`;
  },

  // Destroys Select2 instances on all rows and empties the process groups container
  clearGroupsContainer() {
    const container = document.getElementById('bomGroupsContainer');
    if (!container) return;

    container.querySelectorAll('.bom-group-items-body tr').forEach(row => this.destroyItemSelect2(row));
    container.innerHTML = '';
  },

  // Groups a flat components array by Process ID and renders one group
  // card per distinct process, in order of first appearance.
  renderGroupedComponents(components) {
    if (!components || components.length === 0) {
      this.addGroup('');
      return;
    }

    const groupOrder = [];
    const groupMap = {};
    components.forEach(comp => {
      const processId = comp.processId || '';
      if (!groupMap[processId]) {
        groupMap[processId] = [];
        groupOrder.push(processId);
      }
      groupMap[processId].push(comp);
    });

    groupOrder.forEach(processId => this.addGroup(processId, groupMap[processId]));
  },

  // Builds the <option> list for a group's Process select.
  _buildProcessGroupOptionsHtml(selectedProcessId) {
    const processes = (App.State.globalProcesses || []).filter(p => p.active);
    const current = (selectedProcessId || '').trim();

    let html = `<option value="" ${!current ? 'selected' : ''}>— No Process —</option>`;
    let found = false;
    processes.forEach(p => {
      const sel = p.processId === current;
      if (sel) found = true;
      html += `<option value="${escapeHtml(p.processId)}" ${sel ? 'selected' : ''}>${escapeHtml(p.processName)}</option>`;
    });
    if (current && !found) {
      html += `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)} (unrecognized)</option>`;
    }
    return html;
  },

  // Populates the "Import from Process..." picker with active Process
  // Master entries.
  populateImportProcessSelect() {
    const select = document.getElementById('bomImportProcessSelect');
    if (!select) return;

    if (window.jQuery?.fn?.select2 && window.jQuery(select).data('select2'))
      window.jQuery(select).select2('destroy');

    let html = '<option value="">Import from Process...</option>';
    (App.State.globalProcesses || []).filter(p => p.active).forEach(p => {
      html += `<option value="${escapeHtml(p.processId)}">${escapeHtml(p.processName)}</option>`;
    });
    select.innerHTML = html;
    App.Utils.autoSelectOnlyOption(select);

    if (window.jQuery?.fn?.select2) {
      const $s = window.jQuery(select);
      const $modal = $s.closest('.modal');
      $s.select2({
        placeholder: 'Import from Process...',
        width: '100%',
        matcher: App.Utils.select2Matcher,
        dropdownParent: $modal.length ? $modal : window.jQuery(document.body)
      });
    }
  },

  // Imports a Process's predefined recipe (components + qty) as a new
  // component group, plus one Additional Cost row per contractor rate
  // card entry for that process -- a one-time copy, not a live link.
  async importProcess() {
    const select = document.getElementById('bomImportProcessSelect');
    const btn = document.getElementById('btnImportProcess');
    const processId = select?.value;
    if (!processId) return;

    const process = (App.State.globalProcesses || []).find(p => p.processId === processId);
    if (!process) return;

    const alreadyImported = Array.from(document.querySelectorAll('#bomGroupsContainer .group-name-input'))
      .some(sel => sel.value === processId);
    if (alreadyImported) {
      App.Utils.showToast(`"${process.processName}" is already a Process Group on this product — remove it first if you want to re-import.`, true);
      return;
    }

    if (btn) btn.disabled = true;
    if (select) select.disabled = true;

    try {
      const [compRes, rateRes] = await Promise.all([
        Api.call('getProcessComponentsData', processId),
        Api.call('getContractorRatesData')
      ]);

      const components = compRes.success ? (compRes.data || []) : [];
      this.addGroup(process.processId, components.length > 0
        ? components.map(c => ({ itemName: c.itemName, size: c.size, narration: c.narration, qtyPerProduct: c.qtyPerUnit }))
        : null);

      // Rate Card is keyed by (Contractor, Process Type, Size), not this
      // specific Process -- so this imports whichever rate applies to
      // the process's own Type + Size.
      const processTypeLower = (process.processType || '').toLowerCase();
      const processSize = App.Utils.getSizeFromOutputItemName(process.outputItemName);
      const rates = rateRes.success
        ? (rateRes.data || []).filter(r => r.processType.toLowerCase() === processTypeLower && r.size.toLowerCase() === processSize.toLowerCase())
        : [];
      rates.forEach(r => {
        this.addCostRow({
          description: `${process.processName} - Contractor`,
          rate: r.ratePerUnit,
          processName: process.processType,
          contractorName: r.contractorName
        });
      });

      this.calculateCost();
      select.value = '';

      const costNote = rates.length > 0 ? ` and ${rates.length} contractor cost line(s)` : ' (no contractor rate card entry found for this process — add a cost line manually if needed)';
      App.Utils.showToast(`Imported "${process.processName}" recipe${costNote}.`, false);
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to import process', true);
    } finally {
      if (btn) btn.disabled = false;
      if (select) select.disabled = false;
    }
  },

  // Creates a new "Process Group" card. If `components` is provided,
  // populates it with a row per component; otherwise adds a single empty
  // starter row.
  addGroup(groupName = '', components = null) {
    const container = document.getElementById('bomGroupsContainer');
    if (!container) return null;

    const groupId = 'bom_group_' + Date.now() + '_' + Math.floor(Math.random() * 1000);

    const cardHtml = `
  <div class="card mb-3 border bom-group-card" id="${groupId}">
    <div class="card-header bg-white d-flex flex-wrap justify-content-between align-items-center gap-2 py-2">
      <div class="d-flex align-items-center gap-2 flex-grow-1" style="min-width: 240px;">
        <span class="text-muted small fw-bold text-nowrap">Process:</span>
        <select class="form-select form-select-sm fw-bold group-name-input" style="max-width: 260px;">
          ${this._buildProcessGroupOptionsHtml(groupName)}
        </select>
      </div>
      <div class="d-flex align-items-center gap-2">
        <span class="badge bg-light text-dark border">Subtotal: <span class="group-subtotal">₹0.00</span></span>
        <button type="button" class="btn btn-outline-danger btn-sm" onclick="App.BOM.removeGroup('${groupId}')">✕ Remove Group</button>
      </div>
    </div>
    <div class="card-body p-2">
      <div class="table-responsive">
        <table class="table table-bordered align-middle bg-white shadow-sm mb-2">
          <thead class="table-light">
            <tr>
              <th style="width: 30%;">Component Item Selection *</th>
              <th style="width: 10%;">Size</th>
              <th style="width: 10%;">Narration</th>
              <th style="width: 10%;">Color</th>
              <th style="width: 22%;">Vendor & Negotiated Rates *</th>
              <th style="width: 13%;">Qty Needed *</th>
              <th style="width: 5%; text-align: center;">✕</th>
            </tr>
          </thead>
          <tbody class="bom-group-items-body" id="${groupId}_items">
            <!-- Rows appended dynamically -->
          </tbody>
        </table>
      </div>
      <button type="button" class="btn btn-outline-primary btn-sm fw-bold me-2" onclick="App.BOM.addRow('${groupId}')">+ Add Component Item</button>
      <a href="#" class="small" onclick="App.Color.openModal(); return false;">Manage Color Master &#8599;</a>
    </div>
  </div>
`;

    container.insertAdjacentHTML('beforeend', cardHtml);

    if (components && components.length > 0) {
      components.forEach(comp => this.addRow(groupId, comp));
    } else {
      this.addRow(groupId);
    }

    return groupId;
  },

  // Removes a process group card. Requires at least one group to remain,
  // and confirms with the user if the group still has component rows.
  removeGroup(groupId) {
    const container = document.getElementById('bomGroupsContainer');
    const card = document.getElementById(groupId);
    if (!container || !card) return;

    const rows = card.querySelectorAll('.bom-group-items-body tr');
    const isLast = container.querySelectorAll('.bom-group-card').length <= 1;

    const removeNow = () => {
      rows.forEach(row => this.destroyItemSelect2(row));
      card.remove();
      if (isLast) this.addGroup();
      this.calculateCost();
    };

    const filledRows = Array.from(rows).filter(r => {
      const sel = r.querySelector('.comp-item-select');
      return sel && sel.value !== '';
    });

    if (filledRows.length > 0) {
      App.Utils.confirmAction(
        `Remove this process group and its ${filledRows.length} component(s)?`,
        removeNow
      );
    } else {
      removeNow();
    }
  },

  // Populates the Additional/Dynamic Costs table. Falls back to the
  // default suggested cost categories when no costs have been saved yet.
  populateCostRows(costs) {
    const tbody = document.getElementById('bomCostsBody');
    if (!tbody) return;

    tbody.innerHTML = '';
    const list = (costs && costs.length > 0)
      ? costs
      : DEFAULT_COST_CATEGORIES.map(description => ({ description, rate: 0 }));

    list.forEach(cost => this.addCostRow(cost));
  },

  async openCreateModal() {
    const form = document.getElementById('bomForm');
    if (form) form.reset();

    document.getElementById('bomProductId').value = '';
    document.getElementById('bomVisibleProductId').value = 'Generating...';
    document.getElementById('bomFormTitle').innerText = 'Create Product BOM';
    document.getElementById('bomSubmitBtn').innerText = 'Save Product BOM';

    App.Utils.setFormButtonsForMode('bomCancelBtn', 'bomExitBtn', 'bomSubmitBtn', false, 'Save Product BOM');
    App.Nav.clear('editBomModal');

    this.clearGroupsContainer();
    this.addGroup('General');
    this.populateCostRows();
    this.populateImportProcessSelect();
    this.calculateCost();

    const modalEl = document.getElementById('editBomModal');
    if (modalEl && typeof bootstrap !== 'undefined') {
      bootstrap.Modal.getOrCreateInstance(modalEl).show();
    }

    try {
      const nextIdRes = await Api.call('getNextProductId', App.BOM.getToken());
      document.getElementById('bomVisibleProductId').value = nextIdRes;
    } catch (err) {
      console.error('Failed to generate product ID:', err);
      document.getElementById('bomVisibleProductId').value = 'PRD-1001';
    }
  },

  openEditModal(idx) {
    const bom = App.State.globalBOMs[idx];
    if (!bom) return;

    const form = document.getElementById('bomForm');
    if (form) form.reset();

    document.getElementById('bomProductId').value = bom.productId;
    document.getElementById('bomVisibleProductId').value = bom.productId;
    document.getElementById('bomProductName').value = bom.productName;
    document.getElementById('bomRemarks').value = bom.remarks || '';
    document.getElementById('bomFormTitle').innerText = `Edit Product BOM: ${bom.productId}`;
    document.getElementById('bomSubmitBtn').innerText = 'Update Product BOM';

    this.clearGroupsContainer();
    this.renderGroupedComponents(bom.components);

    this.populateCostRows(bom.additionalCosts);
    this.populateImportProcessSelect();
    this.calculateCost();

    App.Utils.setFormButtonsForMode('bomCancelBtn', 'bomExitBtn', 'bomSubmitBtn', true, 'Update Product BOM');
    App.Nav.register(
      'editBomModal',
      (App.State.filteredBOMs || []).map(b => b.productId),
      bom.productId,
      (productId) => {
        const targetIdx = App.State.globalBOMs.findIndex(b => b.productId === productId);
        if (targetIdx !== -1) this.openEditModal(targetIdx);
      }
    );

    const modalEl = document.getElementById('editBomModal');
    if (modalEl && typeof bootstrap !== 'undefined') {
      bootstrap.Modal.getOrCreateInstance(modalEl).show();
    }
  },

  // Opens the Create modal pre-filled with another BOM's contents, but
  // with a freshly generated Product ID, so it can be saved as a new BOM.
  async openDuplicateModal(idx) {
    const bom = App.State.globalBOMs[idx];
    if (!bom) return;

    const form = document.getElementById('bomForm');
    if (form) form.reset();

    document.getElementById('bomProductId').value = '';
    document.getElementById('bomVisibleProductId').value = 'Generating...';
    document.getElementById('bomProductName').value = bom.productName;
    document.getElementById('bomRemarks').value = bom.remarks || '';
    document.getElementById('bomFormTitle').innerText = `Duplicate Product BOM (from ${bom.productId})`;
    document.getElementById('bomSubmitBtn').innerText = 'Save Product BOM';

    App.Utils.setFormButtonsForMode('bomCancelBtn', 'bomExitBtn', 'bomSubmitBtn', false, 'Save Product BOM');
    App.Nav.clear('editBomModal');

    this.clearGroupsContainer();
    this.renderGroupedComponents(bom.components);

    this.populateCostRows(bom.additionalCosts);
    this.populateImportProcessSelect();
    this.calculateCost();

    const modalEl = document.getElementById('editBomModal');
    if (modalEl && typeof bootstrap !== 'undefined') {
      bootstrap.Modal.getOrCreateInstance(modalEl).show();
    }

    try {
      const nextIdRes = await Api.call('getNextProductId', App.BOM.getToken());
      document.getElementById('bomVisibleProductId').value = nextIdRes;
    } catch (err) {
      console.error('Failed to generate product ID:', err);
      document.getElementById('bomVisibleProductId').value = 'PRD-1001';
    }
  },

  delete(productId) {
    App.Utils.confirmAction(
      `Are you sure you want to delete the BOM definition for Product "${productId}"? This will permanently remove its components.`,
      async () => {
        try {
          const res = await Api.mutate('deleteBOM', productId, App.BOM.getToken());
          App.Utils.showToast(res.message, !res.success);
          if (res.success) {
            await this.loadData();
          }
        } catch (err) {
          App.Utils.showToast(err.message || 'Failed to delete BOM', true);
        }
      }
    );
  },

  addRow(groupId, compData = null) {
    const tbody = document.getElementById(`${groupId}_items`);
    if (!tbody) return;

    const rowId = 'bom_row_' + Date.now() + '_' + Math.floor(Math.random() * 1000);

    let preSelectedOption = '';
    if (compData && compData.itemName) {
      const items = App.State.globalItems || [];
      const matchIdx = items.findIndex(item =>
        App.Utils.sameText(item.name, compData.itemName) &&
        (App.Utils.sameText(compData.size || '', item.size || '') || (!compData.size && !item.size))
      );
      if (matchIdx >= 0) {
        const item = items[matchIdx];
        const label = `${item.name}${item.size ? ` [${item.size}]` : ''}${item.narration ? ` - ${item.narration}` : ''}`;
        preSelectedOption = `<option value="${matchIdx}" selected data-name="${escapeHtml(item.name)}" data-size="${escapeHtml(item.size || '')}" data-narration="${escapeHtml(item.narration || '')}">${escapeHtml(label)}</option>`;
      } else {
        const orphanLabel = `${compData.itemName}${compData.size ? ` [${compData.size}]` : ''}${compData.narration ? ` - ${compData.narration}` : ''} (Not in Items Master)`;
        preSelectedOption = `<option value="orphan" selected data-name="${escapeHtml(compData.itemName)}" data-size="${escapeHtml(compData.size || '')}" data-narration="${escapeHtml(compData.narration || '')}">${escapeHtml(orphanLabel)}</option>`;
      }
    }

    const rowHtml = `
  <tr id="${rowId}">
    <td>
      <select class="form-select comp-item-select" required onchange="App.BOM.handleItemChange('${rowId}', this.value)">
        <option value=""></option>
        ${preSelectedOption}
      </select>
    </td>
    <td>
      <input type="text" class="form-control comp-size" placeholder="-" value="${compData && compData.size ? escapeHtml(compData.size) : ''}">
    </td>
    <td>
      <input type="text" class="form-control comp-narration" placeholder="-" value="${compData && compData.narration ? escapeHtml(compData.narration) : ''}">
    </td>
    <td>
      <input type="text" class="form-control comp-color" list="colorList" placeholder="All colors" value="${compData && compData.color ? escapeHtml(compData.color) : ''}">
    </td>
    <td>
      <div class="vendor-rates-container p-1 border rounded bg-white shadow-sm" style="max-height: 130px; overflow-y: auto;">
        <div class="text-muted small p-2">Select an item first...</div>
      </div>
    </td>
    <td>
      <input type="number" class="form-control comp-qty" placeholder="0.00" min="0.0001" step="any" value="${compData ? compData.qtyPerProduct : '1'}" required oninput="App.BOM.calculateCost()">
    </td>
    <td class="text-center">
      <button type="button" class="btn btn-outline-danger btn-sm" onclick="App.BOM.removeRow('${rowId}')">✕</button>
    </td>
  </tr>
`;

    tbody.insertAdjacentHTML('beforeend', rowHtml);
    const rowEl = document.getElementById(rowId);

    this.initItemSelect2(rowEl);

    if (compData) {
      const selectEl = rowEl.querySelector('.comp-item-select');
      if (selectEl && selectEl.value !== "") {
        this.handleItemChange(rowId, selectEl.value, compData.vendor, compData.rate);
      }
    }
  },

  // Initializes a searchable Select2 dropdown for a row's item selector.
  initItemSelect2(rowEl) {
    const selectEl = rowEl?.querySelector('.comp-item-select');
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
          const items = App.State.globalItems || [];
          const start = (page - 1) * PAGE_SIZE;

          if (!q) {
            const pageItems = items.slice(start, start + PAGE_SIZE);
            success({
              results: pageItems.map((item, i) => ({
                id: String(start + i),
                text: `${item.name}${item.size ? ` [${item.size}]` : ''}${item.narration ? ` - ${item.narration}` : ''}`,
                _itemName: item.name, _size: item.size || '', _narration: item.narration || ''
              })),
              pagination: { more: (start + PAGE_SIZE) < items.length }
            });
            return;
          }

          const filtered = [];
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (App.Utils.matchesKeywords(`${item.name} ${item.size || ''} ${item.narration || ''}`, q)) {
              filtered.push({ idx: i, item });
            }
          }
          const page_ = filtered.slice(start, start + PAGE_SIZE);
          success({
            results: page_.map(({ idx, item }) => ({
              id: String(idx),
              text: `${item.name}${item.size ? ` [${item.size}]` : ''}${item.narration ? ` - ${item.narration}` : ''}`,
              _itemName: item.name, _size: item.size || '', _narration: item.narration || ''
            })),
            pagination: { more: (start + PAGE_SIZE) < filtered.length }
          });
        },
        processResults(data) { return data; }
      },
      createTag(params) {
        const term = (params.term || '').trim();
        if (!term) return null;
        const items = App.State.globalItems || [];
        const matchIdx = items.findIndex(it => App.Utils.sameText(it.name, term));
        if (matchIdx >= 0) {
          const item = items[matchIdx];
          return {
            id: String(matchIdx), text: `${item.name}${item.size ? ` [${item.size}]` : ''}${item.narration ? ` - ${item.narration}` : ''}`,
            _itemName: item.name, _size: item.size || '', _narration: item.narration || ''
          };
        }
        return { id: 'custom:' + term, text: term, newTag: true, _itemName: term, _size: '', _narration: '' };
      }
    });

    $select.on('select2:select', function (e) {
      const data = e.params.data;
      const opt = selectEl.options[selectEl.selectedIndex];
      if (opt) {
        opt.dataset.name = data._itemName || data.text;
        opt.dataset.size = data._size || '';
        opt.dataset.narration = data._narration || '';
      }
    });
  },

  destroyItemSelect2(rowEl) {
    const selectEl = rowEl?.querySelector('.comp-item-select');
    if (!selectEl || !window.jQuery?.fn?.select2) return;

    const $select = window.jQuery(selectEl);
    if ($select.data('select2')) {
      $select.select2('destroy');
    }
  },

  // Searchable Select2 on the custom vendor select inside a component row.
  initCustomVendorSelect2(row) {
    const selectEl = row?.querySelector('.custom-vendor-select');
    if (!selectEl || !window.jQuery?.fn?.select2) return;

    const $select = window.jQuery(selectEl);
    if ($select.data('select2')) $select.select2('destroy');

    const $parentModal = $select.closest('.modal');
    const PAGE_SIZE = 30;

    $select.select2({
      placeholder: 'Search or type vendor name...',
      width: '100%',
      tags: true,
      allowClear: true,
      dropdownParent: $parentModal.length ? $parentModal : window.jQuery(document.body),
      ajax: {
        delay: 100,
        data(params) {
          return { q: params.term || '', page: params.page || 1 };
        },
        transport(params, success) {
          const q = (params.data.q || '').trim().toLowerCase();
          const page = params.data.page || 1;
          const names = (App.State.globalVendors || []).map(v => v.name).filter(Boolean);
          const filtered = q ? names.filter(n => n.toLowerCase().includes(q)) : names;
          const start = (page - 1) * PAGE_SIZE;
          success({
            results: filtered.slice(start, start + PAGE_SIZE).map(n => ({ id: n, text: n })),
            pagination: { more: (start + PAGE_SIZE) < filtered.length }
          });
        },
        processResults(data) { return data; }
      },
      createTag(params) {
        const term = (params.term || '').trim();
        if (!term) return null;
        const existing = (App.State.globalVendors || []).find(v => App.Utils.sameText(v.name, term));
        if (existing) return { id: existing.name, text: existing.name };
        return { id: term, text: term, newTag: true };
      }
    });

    $select.on('change', () => App.BOM.calculateCost());
  },

  removeRow(rowId) {
    const row = document.getElementById(rowId);
    if (row) {
      this.destroyItemSelect2(row);
      row.remove();
      this.calculateCost();
    }
  },

  handleItemChange(rowId, itemIdx, selectedVendor = null, selectedRate = null) {
    const row = document.getElementById(rowId);
    if (!row) return;

    const sizeInput = row.querySelector('.comp-size');
    const narrationInput = row.querySelector('.comp-narration');
    const ratesContainer = row.querySelector('.vendor-rates-container');

    if (itemIdx === "") {
      sizeInput.value = '';
      narrationInput.value = '';
      ratesContainer.innerHTML = '<div class="text-muted small p-2">Select an item first...</div>';
      this.calculateCost();
      return;
    }

    let item;
    if (itemIdx === 'orphan') {
      const opt = row.querySelector('.comp-item-select option[value="orphan"]');
      item = {
        name: opt?.dataset.name || '',
        size: opt?.dataset.size || '',
        narration: opt?.dataset.narration || '',
        vendors: []
      };
    } else if (itemIdx.indexOf('custom:') === 0) {
      const customName = itemIdx.slice('custom:'.length);
      const selectEl = row.querySelector('.comp-item-select');
      const opt = selectEl?.options[selectEl.selectedIndex];
      if (opt) {
        opt.dataset.name = customName;
        opt.dataset.size = opt.dataset.size || '';
        opt.dataset.narration = opt.dataset.narration || '';
      }
      item = { name: customName, size: '', narration: '', vendors: [] };
    } else {
      item = App.State.globalItems[parseInt(itemIdx, 10)];
    }
    if (!item) return;

    sizeInput.value = item.size || '';
    narrationInput.value = item.narration || '';

    let radioHtml = '';
    let hasMatchingRadio = false;

    if (item.vendors && item.vendors.length > 0) {
      item.vendors.forEach((v, vIdx) => {
        let checkedAttr = '';
        if (selectedVendor && selectedVendor.toLowerCase() === v.vendor.toLowerCase()) {
          checkedAttr = 'checked';
          hasMatchingRadio = true;
        } else if (!selectedVendor && vIdx === 0) {
          checkedAttr = 'checked';
        }

        // BOM costing multiplies this rate by qtyPerProduct, which is in
        // the item's Base Unit (e.g. Pcs) -- so the radio value must
        // carry ratePerBaseUnit, not the as-quoted v.rate (which may be
        // per Gross/Kg/etc.). The label still shows the as-quoted rate.
        const ratePerBaseUnit = (v.ratePerBaseUnit !== undefined && v.ratePerBaseUnit !== null)
          ? v.ratePerBaseUnit
          : v.rate;
        const rateHint = Math.abs(ratePerBaseUnit - v.rate) > 0.0001
          ? ` <span class="text-muted">(${formatCurrency(ratePerBaseUnit)}/${escapeHtml(item.baseUnit || 'Pcs')})</span>`
          : '';

        radioHtml += `
      <div class="form-check mb-1">
        <input class="form-check-input rate-radio" type="radio" name="rate_vendor_${rowId}" id="${rowId}_v_${vIdx}" value="${escapeHtml(v.vendor)}|${ratePerBaseUnit}" ${checkedAttr} onchange="App.BOM.calculateCost()">
        <label class="form-check-label small text-dark" for="${rowId}_v_${vIdx}">
          <strong>${escapeHtml(v.vendor)}</strong>: ${formatCurrency(v.rate)}${rateHint}
        </label>
      </div>
    `;
      });
    }

    const customId = `${rowId}_custom`;
    let customChecked = (selectedVendor && !hasMatchingRadio) ? 'checked' : '';
    let customVendorVal = customChecked ? selectedVendor : '';
    let customRateVal = customChecked ? selectedRate : '';

    if (!item.vendors || item.vendors.length === 0) {
      customChecked = 'checked';
    }

    const preVendorOption = customVendorVal
      ? `<option value="${escapeHtml(customVendorVal)}" selected>${escapeHtml(customVendorVal)}</option>`
      : '<option value=""></option>';

    radioHtml += `
  <div class="form-check border-top pt-2 mt-1">
    <input class="form-check-input rate-radio custom-radio-toggle" type="radio" name="rate_vendor_${rowId}" id="${customId}" value="CUSTOM" ${customChecked} onchange="App.BOM.toggleCustomFields('${rowId}', true)">
    <label class="form-check-label small fw-bold text-secondary" for="${customId}">Custom Vendor & Rate</label>

    <div class="custom-fields-box mt-1 p-2 bg-light rounded" style="border: 1px dashed #cbd5e1;" ${customChecked ? '' : 'hidden'}>
      <select class="form-select form-select-sm mb-1 custom-vendor-select">${preVendorOption}</select>
      <input type="number" class="form-control form-control-sm custom-rate-input" placeholder="Rate (₹)" min="0" step="0.01" value="${customRateVal}" oninput="App.BOM.calculateCost()">
    </div>
  </div>
`;

    ratesContainer.innerHTML = radioHtml;
    this.initCustomVendorSelect2(row);
    this.calculateCost();
  },

  toggleCustomFields(rowId, fromRadioClick) {
    const row = document.getElementById(rowId);
    if (!row) return;

    const radios = row.querySelectorAll('.rate-radio');
    radios.forEach(radio => {
      const box = row.querySelector('.custom-fields-box');
      if (radio.value === 'CUSTOM') {
        box.style.display = radio.checked ? 'block' : 'none';

        if (radio.checked && fromRadioClick && window.jQuery?.fn?.select2) {
          const $vSelect = window.jQuery(row).find('.custom-vendor-select');
          if ($vSelect.data('select2')) $vSelect.select2('open');
        }
      }
    });

    this.calculateCost();
  },

  // Adds a row to the Additional/Dynamic Costs table.
  addCostRow(costData = null) {
    const tbody = document.getElementById('bomCostsBody');
    if (!tbody) return;

    const rowId = 'bom_cost_row_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    const description = costData ? escapeHtml(costData.description || '') : '';
    const rate = costData && costData.rate ? costData.rate : '';
    const processName = (costData && costData.processName) || '';
    const contractorName = (costData && costData.contractorName) || '';

    const rowHtml = `
  <tr id="${rowId}">
    <td>
      <input type="text" class="form-control cost-description" list="bomCostCategoryList" placeholder="e.g. Labor - Fitting" value="${description}" maxlength="100">
    </td>
    <td>
      <select class="form-select cost-process">
        <option value="">— None —</option>
        ${typeof App.Contractor !== 'undefined' ? App.Contractor.buildProcessTypeOptionsHtml(processName) : ''}
      </select>
    </td>
    <td>
      <select class="form-control cost-contractor-select" style="width:100%;"></select>
    </td>
    <td>
      <div class="input-group">
        <input type="number" class="form-control cost-rate" placeholder="0.00" min="0" step="0.01" value="${rate}" oninput="App.BOM.calculateCost()">
        <button type="button" class="btn btn-outline-secondary btn-sm" title="Fill rate from this contractor's rate card" onclick="App.BOM.useContractorRate('${rowId}')">Use Rate</button>
      </div>
    </td>
    <td class="text-center">
      <button type="button" class="btn btn-outline-danger btn-sm" onclick="App.BOM.removeCostRow('${rowId}')">✕</button>
    </td>
  </tr>
`;

    tbody.insertAdjacentHTML('beforeend', rowHtml);
    this.initCostContractorSelect2(document.getElementById(rowId), contractorName);
  },

  // Searchable Select2 on a cost row's Contractor field.
  initCostContractorSelect2(row, currentValue) {
    const selectEl = row?.querySelector('.cost-contractor-select');
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

  // Fills a cost row's Rate from the selected Contractor + Process Type's
  // rate card entry, leaving it editable. This row has no Size field of
  // its own (it's a flat additional-cost line, not tied to one specific
  // Process), so the lookup uses the 'General' size bucket -- if the
  // contractor's actual rate is size-specific, this simply won't find one
  // and the operator types the rate in manually instead.
  async useContractorRate(rowId) {
    const row = document.getElementById(rowId);
    if (!row) return;

    const processType = row.querySelector('.cost-process').value;
    const contractorName = row.querySelector('.cost-contractor-select').value;

    if (!processType || !contractorName) {
      App.Utils.showToast('Select a Process and Contractor first.', true);
      return;
    }

    try {
      const res = await Api.call('getContractorRateForProcessType', contractorName, processType, 'General');
      const rate = res.success ? toNumber(res.data?.ratePerUnit) : 0;
      if (!rate) {
        App.Utils.showToast(`No rate card entry for "${App.Utils.formatNameCase(contractorName)}" / ${processType} / General.`, true);
        return;
      }
      row.querySelector('.cost-rate').value = rate;
      this.calculateCost();
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to look up contractor rate', true);
    }
  },

  removeCostRow(rowId) {
    const row = document.getElementById(rowId);
    if (row) {
      row.remove();
      this.calculateCost();
    }
  },

  calculateCost() {
    let materialCost = 0;

    document.querySelectorAll('#bomGroupsContainer .bom-group-card').forEach(card => {
      let groupCost = 0;

      card.querySelectorAll('.bom-group-items-body tr').forEach(row => {
        const qty = parseFloat(row.querySelector('.comp-qty')?.value) || 0;
        const checkedRadio = row.querySelector('.rate-radio:checked');

        let rate = 0;
        if (checkedRadio) {
          if (checkedRadio.value === 'CUSTOM') {
            const customRateInput = row.querySelector('.custom-rate-input');
            rate = parseFloat(customRateInput?.value) || 0;

            const box = row.querySelector('.custom-fields-box');
            if (box) box.style.display = 'block';
          } else {
            const parts = checkedRadio.value.split('|');
            rate = parseFloat(parts[1]) || 0;

            const box = row.querySelector('.custom-fields-box');
            if (box) box.style.display = 'none';
          }
        }

        groupCost += qty * rate;
      });

      const subtotalSpan = card.querySelector('.group-subtotal');
      if (subtotalSpan) subtotalSpan.innerText = formatCurrency(groupCost);

      materialCost += groupCost;
    });

    let additionalCost = 0;
    document.querySelectorAll('#bomCostsBody .cost-rate').forEach(input => {
      additionalCost += parseFloat(input.value) || 0;
    });

    const costSpan = document.getElementById('bomEstimatedCost');
    if (costSpan) costSpan.innerText = formatCurrency(materialCost);

    const addlSpan = document.getElementById('bomAdditionalCost');
    if (addlSpan) addlSpan.innerText = formatCurrency(additionalCost);

    const totalSpan = document.getElementById('bomGrandTotal');
    if (totalSpan) totalSpan.innerText = formatCurrency(materialCost + additionalCost);
  },

  serializeForm() {
    const productId = document.getElementById('bomProductId').value;
    const productName = document.getElementById('bomProductName').value.trim();
    const remarks = document.getElementById('bomRemarks').value.trim();

    const components = [];

    document.querySelectorAll('#bomGroupsContainer .bom-group-card').forEach(card => {
      const groupNameInput = card.querySelector('.group-name-input');
      const processId = (groupNameInput?.value || '').trim();

      card.querySelectorAll('.bom-group-items-body tr').forEach(row => {
        const selectEl = row.querySelector('.comp-item-select');
        if (!selectEl || selectEl.value === "") return;

        const opt = selectEl.options[selectEl.selectedIndex];
        const itemName = opt.dataset.name || opt.textContent.trim();
        const size = row.querySelector('.comp-size').value.trim();
        const narration = row.querySelector('.comp-narration').value.trim();
        const color = row.querySelector('.comp-color')?.value.trim() || '';

        const qtyPerProduct = parseFloat(row.querySelector('.comp-qty').value) || 0;
        const checkedRadio = row.querySelector('.rate-radio:checked');

        let vendor = '';
        let rate = 0;

        if (checkedRadio) {
          if (checkedRadio.value === 'CUSTOM') {
            vendor = (row.querySelector('.custom-vendor-select')?.value || '').trim() || 'Custom';
            rate = parseFloat(row.querySelector('.custom-rate-input').value) || 0;
          } else {
            const parts = checkedRadio.value.split('|');
            vendor = parts[0];
            rate = parseFloat(parts[1]) || 0;
          }
        }

        components.push({
          itemName,
          size,
          narration,
          color,
          vendor,
          rate,
          qtyPerProduct,
          processId
        });
      });
    });

    const additionalCosts = [];
    document.querySelectorAll('#bomCostsBody tr').forEach(row => {
      const description = row.querySelector('.cost-description').value.trim();
      if (!description) return;

      const rate = parseFloat(row.querySelector('.cost-rate').value) || 0;
      const processName = (row.querySelector('.cost-process')?.value || '').trim();
      const contractorName = (row.querySelector('.cost-contractor-select')?.value || '').trim();
      additionalCosts.push({ description, rate, processName, contractorName });
    });

    return {
      formData: {
        productId,
        productName,
        remarks,
        components: JSON.stringify(components),
        additionalCosts: JSON.stringify(additionalCosts)
      },
      componentCount: components.length
    };
  },

  // Read-only diagnostic -- never blocks or changes anything, just
  // surfaces where a product's BOM costing qty and its process's actual
  // recipe qty for the same item have drifted apart.
  async checkRecipeDrift() {
    try {
      const res = await Api.call('getBomProcessComponentsDrift');
      if (!res?.success) {
        App.Utils.showToast(res?.message || 'Failed to check recipe drift.', true);
        return;
      }
      const drift = res.data || [];
      if (drift.length === 0) {
        App.Utils.showToast(res.message || 'No drift found — BOM and process recipe quantities match everywhere they overlap.');
        return;
      }

      const rowsHtml = drift.map(d => `
        <tr>
          <td>${escapeHtml(d.productName)} <small class="text-muted">(${escapeHtml(d.productId)})</small></td>
          <td>${escapeHtml(d.itemName)}${d.size ? ' <small class="text-muted">(' + escapeHtml(d.size) + ')</small>' : ''}</td>
          <td class="text-end">${escapeHtml(String(d.bomQtyPerProduct))}</td>
          <td class="text-end">${escapeHtml(String(d.recipeQtyPerUnit))}</td>
        </tr>`).join('');

      const body = document.getElementById('bomDriftModalBody');
      if (body) {
        body.innerHTML = `
          <p class="text-muted small">These ${drift.length} item(s) have a different Qty/Product on the BOM (costing) than Qty/Unit on the process recipe (actual shop-floor consumption) — both are separately editable, so this is informational only. Nothing here is auto-fixed or blocked.</p>
          <div class="table-responsive">
            <table class="table table-sm table-bordered">
              <thead class="table-light">
                <tr><th>Product</th><th>Item</th><th class="text-end">BOM Qty/Product</th><th class="text-end">Recipe Qty/Unit</th></tr>
              </thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </div>`;
      }
      safeModalShow('bomDriftModal');
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to check recipe drift.', true);
    }
  },

  toggleComponents(productId, expand) {
    const cell = document.getElementById(`bom_cpreview_${productId}`);
    if (!cell) return;
    const collapsed = cell.querySelector('.bom-preview-collapsed');
    const expanded = cell.querySelector('.bom-preview-expanded');
    if (collapsed) collapsed.style.display = expand ? 'none' : '';
    if (expanded) expanded.style.display = expand ? '' : 'none';
  }
};

// Wire up BOM form submission
document.addEventListener('DOMContentLoaded', function () {
  const bomForm = document.getElementById('bomForm');
  if (bomForm) {
    bomForm.onsubmit = async function (e) {
      e.preventDefault();

      const { formData, componentCount } = App.BOM.serializeForm();
      if (componentCount === 0) {
        App.Utils.showToast('Please add at least one valid component item to the BOM.', true);
        return;
      }
      const isEdit = !!formData.productId;

      const submitBtn = document.getElementById('bomSubmitBtn');
      if (submitBtn) submitBtn.disabled = true;

      try {
        const response = await Api.mutate('saveBOM', formData, App.BOM.getToken());
        if (response.success) {
          if (isEdit) {
            // Save (edit mode): patch just this one product's data + <tr>
            // in place instead of a full loadData() reload -- falls back
            // to a full reload if the product can't be patched.
            const patched = response.data && response.data.product
              ? App.BOM.patchRowInPlace(response.data.product)
              : false;
            if (!patched) await App.BOM.loadData();
            if (App.Production && App.Production.populateProductSelect) {
              App.Production.populateProductSelect();
            }

            // Stay open on the SAME BOM instead of closing -- Exit
            // (App.Nav.exit) is the only way to close from here now.
            // productId is server-assigned and never user-editable, so
            // it's a safe stable key to re-find this record by.
            const freshIdx = App.State.globalBOMs.findIndex(b => b.productId === formData.productId);
            if (freshIdx !== -1) {
              App.BOM.openEditModal(freshIdx);
            } else {
              const modalEl = document.getElementById('editBomModal');
              if (modalEl) bootstrap.Modal.getOrCreateInstance(modalEl).hide();
            }
          } else {
            // A brand-new product's manual drag-and-drop display order
            // position can't be determined cheaply on the client -- full
            // reload here (an edit doesn't need to, see
            // App.BOM.patchRowInPlace).
            await App.BOM.loadData();
            await App.BOM.openCreateModal();
          }
        }
        App.Utils.showToast(response.message, !response.success, response.success
          ? { type: 'bom', value: response.data?.product?.productId || formData.productId }
          : null);
      } catch (err) {
        App.Utils.showToast(err.message || 'Failed to save BOM', true);
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    };
  }
});
