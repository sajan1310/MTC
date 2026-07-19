'use strict';
// items.js -- App.Item, ported from Apps_Script/Script_Items.html (lines
// 6-1432 -- that file also holds App.Products/App.BOM, which belong to
// the merged "Products & Processes" tab's own future round, not this one).
//
// Talks to items_service.py's RPCs: getItemsData/saveItem/deleteItem/
// deleteItemsBulk/importItemsFromStock plus the data-hygiene tooling
// (keepOrphanItem/keepOrphanItemsBulk/mergeItemEdit/mergeSelectedItems/
// runScheduledItemCleanup), all real now. Form field names already match
// saveItem's expected keys. updateThreshold (called separately after a
// successful save, matching source exactly) is also real -- stock_service.py,
// ported in Phase 1c.
//
// The Item Ledger's ensureLedgerSourceDataLoaded fetches getPOData/
// getBillData/getReturnData/getProductionData/getStockAdjustmentHistory
// directly (all 5 already shipped) rather than through App.PO.loadData()
// etc. (which don't exist yet) -- this is a real, working feature this
// round even though PO/Bill/Return/Production don't have their own tabs
// yet, exactly matching source's own lazy-fetch design.
//
// printLedger/bulkPrint are guarded against App.Print not existing yet
// (print pages are their own later round). The item form's "Manage Unit
// Master ↗" shortcut link uses data-action="not-ported-yet" instead of
// source's literal onclick="App.Unit.openModal()" for the same reason.

App.State.globalItems = [];
App.State.filteredItems = [];
App.State.itemCurrentPage = 1;
App.State.itemRowsPerPage = 15;
App.State.itemSearchTerm = '';
App.State.itemColumnFilters = { name: [], size: [], narration: [], vendor: [], metadata: [] };
App.State.selectedItems = [];
App.State.selectedSyncReview = [];

App.Item = {
  METADATA_FILTER_OPTIONS: [
    { value: 'pendingOrder', label: 'Pending Order' },
    { value: 'lowStock', label: 'Low Stock' },
    { value: 'zeroStock', label: 'Zero Stock' },
    { value: 'hasRemarks', label: 'Has Remarks' },
    { value: 'hasSpecification', label: 'Has Specification' },
    { value: 'noMetadata', label: 'No Metadata' }
  ],

  async loadData() {
    const tbody = document.getElementById('itemTableBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="text-center p-4">Fetching Items Master…</td></tr>';

    try {
      const stockNeeded = App.State.globalStock.length === 0;
      const [res, stockRes] = await Promise.all([
        Api.call('getItemsData'),
        stockNeeded ? Api.call('getStockData') : Promise.resolve(null)
      ]);

      if (stockRes?.success) {
        App.State.globalStock = Array.isArray(stockRes.data) ? stockRes.data : [];
        App.State.filteredStock = [...App.State.globalStock];
      }

      if (!res?.success) {
        App.Utils.showToast(res?.message || 'Failed to load items.', true);
        return;
      }

      App.State.globalItems = Array.isArray(res.data) ? res.data : [];
      App.State.selectedItems = [];
      this.updateBulkDeleteButton();

      this.populateDatalists();
      this.updateColumnFilterIcons();
      this.filterData(App.State.itemSearchTerm);
      this.renderSyncBanner();
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to load items.', true);
    }
  },

  // Items present in Item Master with no matching Stock row (by Name +
  // Size). Surfaced via the orphan banner/badge.
  getOrphanItems() {
    return App.State.globalItems.filter(item =>
      !App.State.globalStock.some(
        s => App.Utils.sameText(s.name, item.name) && App.Utils.sameText(s.size || '', item.size || '')
      )
    );
  },

  renderSyncBanner() {
    const orphans = this.getOrphanItems();
    const banner = document.getElementById('itemOrphanBanner');
    const bannerText = document.getElementById('itemOrphanBannerText');
    const badge = document.getElementById('itemOrphanBadge');

    if (banner && bannerText) {
      banner.classList.toggle('d-none', orphans.length === 0);
      bannerText.textContent = `${orphans.length} item(s) in Item Master have no matching Stock row.`;
    }
    if (badge) {
      badge.classList.toggle('d-none', orphans.length === 0);
      badge.textContent = orphans.length;
    }
  },

  orphanKey(item) {
    return `${item.name}|${item.size || ''}`;
  },

  openSyncReview() {
    const orphans = this.getOrphanItems();
    const tbody = document.getElementById('syncReviewBody');
    if (!tbody) return;

    App.State.selectedSyncReview = [];

    tbody.innerHTML = orphans.length === 0
      ? '<tr><td colspan="5" class="text-center text-success fw-bold p-4">No orphaned items. Stock and Item Master are in sync.</td></tr>'
      : orphans.map((item, idx) => `
        <tr>
          <td class="text-center"><input type="checkbox" class="form-check-input sync-review-chk" data-key="${escapeHtml(this.orphanKey(item))}" onchange="App.Item.onSyncReviewSelectChange()"></td>
          <td>${escapeHtml(item.name || '')}</td>
          <td>${escapeHtml(item.size || '')}</td>
          <td><input type="number" class="form-control form-control-sm" id="syncReviewQty${idx}" value="0" min="0" step="1"></td>
          <td class="text-center">
            <button class="btn btn-success btn-sm fw-bold me-1" onclick="App.Item.keepOrphan('${escapeHtml(item.name || '')}', '${escapeHtml(item.size || '')}', ${idx})"><i class="bi bi-check-lg"></i> Keep</button>
            <button class="btn btn-danger btn-sm fw-bold" onclick="App.Item.discardOrphan('${escapeHtml(item.name || '')}', '${escapeHtml(item.size || '')}')"><i class="bi bi-trash"></i> Discard</button>
          </td>
        </tr>
      `).join('');

    this.updateSyncReviewBulkButtons();

    const modalEl = document.getElementById('syncReviewModal');
    if (modalEl && typeof bootstrap !== 'undefined') {
      bootstrap.Modal.getOrCreateInstance(modalEl).show();
    }
  },

  toggleSelectAllOrphans(masterChk) {
    App.Selection.toggleAll(App.State.selectedSyncReview, 'sync-review-chk', masterChk);
    this.updateSyncReviewBulkButtons();
  },

  onSyncReviewSelectChange() {
    App.Selection.syncFromRows(App.State.selectedSyncReview, 'sync-review-chk', 'selectAllSyncReview');
    this.updateSyncReviewBulkButtons();
  },

  updateSyncReviewBulkButtons() {
    const count = App.State.selectedSyncReview.length;
    App.Selection.updateButton('btnSyncReviewKeepSelected', count, '<i class="bi bi-check-lg"></i> Keep Selected');
    App.Selection.updateButton('btnSyncReviewDiscardSelected', count, '<i class="bi bi-trash"></i> Discard Selected');
  },

  getSelectedOrphanRows() {
    const orphans = this.getOrphanItems();
    return orphans
      .map((item, idx) => ({ item, idx }))
      .filter(({ item }) => App.Selection.isSelected(App.State.selectedSyncReview, this.orphanKey(item)))
      .map(({ item, idx }) => ({
        name: item.name || '',
        size: item.size || '',
        initialStock: Number(document.getElementById(`syncReviewQty${idx}`)?.value) || 0
      }));
  },

  async keepOrphan(name, size, idx) {
    const qtyInput = document.getElementById(`syncReviewQty${idx}`);
    const initialStock = Number(qtyInput?.value) || 0;

    try {
      const res = await Api.mutate('keepOrphanItem', name, size, initialStock);
      App.Utils.showToast(res?.message || 'Stock row created.', !res?.success);
      if (res?.success) {
        App.State.globalStock = [];
        await this.loadData();
        this.openSyncReview();
      }
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to create Stock row.', true);
    }
  },

  async discardOrphan(name, size) {
    App.Utils.confirmAction(
      `Discard "${name}" (size: "${size}") from Item Master? This cannot be undone.`,
      async () => {
        try {
          const res = await Api.mutate('deleteItem', name, size);
          App.Utils.showToast(res?.message || 'Item discarded.', !res?.success);
          if (res?.success) {
            await this.loadData();
            this.openSyncReview();
          }
        } catch (err) {
          App.Utils.showToast(err.message || 'Failed to discard item.', true);
        }
      }
    );
  },

  async keepSelectedOrphans() {
    const rows = this.getSelectedOrphanRows();
    if (!rows.length) return;

    try {
      setDisabled('btnSyncReviewKeepSelected', true);
      const res = await Api.mutate('keepOrphanItemsBulk', rows);
      App.Utils.showToast(res?.message || 'Stock rows created.', !res?.success);
      if (res?.success) {
        App.State.globalStock = [];
        await this.loadData();
        this.openSyncReview();
      }
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to create Stock rows.', true);
    } finally {
      setDisabled('btnSyncReviewKeepSelected', false);
    }
  },

  async discardSelectedOrphans() {
    const rows = this.getSelectedOrphanRows();
    if (!rows.length) return;

    App.Utils.confirmAction(
      `Discard ${rows.length} selected item(s) from Item Master? This cannot be undone.`,
      async () => {
        try {
          setDisabled('btnSyncReviewDiscardSelected', true);
          const res = await Api.mutate('deleteItemsBulk', rows);
          App.Utils.showToast(res?.message || 'Items discarded.', !res?.success);
          if (res?.success) {
            await this.loadData();
            this.openSyncReview();
          }
        } catch (err) {
          App.Utils.showToast(err.message || 'Failed to discard items.', true);
        } finally {
          setDisabled('btnSyncReviewDiscardSelected', false);
        }
      }
    );
  },

  getColumnFilterOptions(key) {
    if (key === 'metadata') return this.METADATA_FILTER_OPTIONS;

    const values = new Set();
    App.State.globalItems.forEach(item => {
      if (key === 'vendor') {
        (item.vendors || []).forEach(v => {
          if (v.vendor) values.add(v.vendor);
        });
      } else if (item[key]) {
        values.add(item[key]);
      }
    });

    return [...values].sort((a, b) => a.localeCompare(b)).map(v => ({ value: v, label: v }));
  },

  updateColumnFilterIcons() {
    document.querySelectorAll('.th-filter-btn').forEach(btn => {
      const key = btn.dataset.filterKey;
      const active = (App.State.itemColumnFilters[key] || []).length > 0;
      btn.classList.toggle('active', active);
    });
  },

  toggleColumnFilter(evt, key) {
    evt.stopPropagation();
    let panel = document.getElementById('itemColFilterPanel');

    if (panel && panel.dataset.key === key) {
      panel.remove();
      return;
    }
    if (panel) panel.remove();

    const btn = evt.currentTarget;
    panel = document.createElement('div');
    panel.id = 'itemColFilterPanel';
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
      const selected = App.State.itemColumnFilters[key] || [];
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
      App.State.itemColumnFilters[key] = [...new Set([...(App.State.itemColumnFilters[key] || []), ...visibleValues])];
      this.onColumnFilterChange(key);
      renderOptions(t);
    });

    panel.querySelector('[data-action="clear"]').addEventListener('click', () => {
      App.State.itemColumnFilters[key] = [];
      this.onColumnFilterChange(key);
      renderOptions(searchInput.value);
    });

    optionsList.addEventListener('click', e => {
      const li = e.target.closest('.po-ms-option');
      if (!li) return;
      const val = li.dataset.value;
      const sel = App.State.itemColumnFilters[key] || (App.State.itemColumnFilters[key] = []);
      const idx = sel.indexOf(val);
      if (idx === -1) sel.push(val);
      else sel.splice(idx, 1);
      this.onColumnFilterChange(key);
      renderOptions(searchInput.value);
    });

    renderOptions('');
    requestAnimationFrame(() => searchInput.focus());

    if (!document.body.dataset.itemColFilterOutsideClickBound) {
      document.body.dataset.itemColFilterOutsideClickBound = '1';
      document.addEventListener('click', e => {
        const openPanel = document.getElementById('itemColFilterPanel');
        if (openPanel && !openPanel.contains(e.target) && !e.target.closest('.th-filter-btn')) {
          openPanel.remove();
        }
      });
    }
  },

  onColumnFilterChange() {
    this.updateColumnFilterIcons();
    App.State.itemCurrentPage = 1;
    this.filterData(App.State.itemSearchTerm);
  },

  clearColumnFilters() {
    App.State.itemColumnFilters = { name: [], size: [], narration: [], vendor: [], metadata: [] };
    document.getElementById('itemColFilterPanel')?.remove();
    this.updateColumnFilterIcons();
    App.State.itemCurrentPage = 1;
    this.filterData(App.State.itemSearchTerm);
  },

  populateDatalists() {
    const itemNames = new Set();
    const vendorNames = new Set();
    const sizes = new Set();
    const narrations = new Set();

    App.State.globalItems.forEach(item => {
      if (item.name) itemNames.add(item.name);
      if (item.size) sizes.add(item.size);
      if (item.narration) narrations.add(item.narration);
      (item.vendors || []).forEach(v => {
        if (v.vendor) vendorNames.add(v.vendor);
      });
    });

    const fill = (id, values) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = [...values].map(v => `<option value="${escapeHtml(v)}">`).join('');
    };

    fill('itemList', itemNames);
    fill('vendorList', vendorNames);
    fill('sizeList', sizes);
    fill('narrationList', narrations);
  },

  filterData(searchTerm) {
    App.State.itemSearchTerm = searchTerm || '';
    const term = String(searchTerm || '').toLowerCase().trim();

    let base;
    if (term.includes('pending order')) {
      const pendingMap = App.Utils.getPendingByItem();
      base = App.State.globalItems.filter(item =>
        pendingMap.has(`${(item.name || '').toLowerCase()}|${(item.size || '').toLowerCase()}`)
      );
    } else if (term.includes('low stock')) {
      const stockMap = this._getStockMap();
      base = App.State.globalItems.filter(item => {
        const s = stockMap.get(this._stockKeyFor(item));
        return !!s && s.isLowStock;
      });
    } else if (term.includes('no metadata')) {
      const pendingMap = App.Utils.getPendingByItem();
      const stockMap = this._getStockMap();
      base = App.State.globalItems.filter(item => this.getMetaInfo(item, pendingMap, stockMap).parts.length === 0);
    } else if (term.includes('zero stock')) {
      const pendingMap = App.Utils.getPendingByItem();
      const stockMap = this._getStockMap();
      base = App.State.globalItems.filter(item => {
        const { stockEntry } = this.getMetaInfo(item, pendingMap, stockMap);
        return stockEntry != null && Number(stockEntry.currentStock) === 0;
      });
    } else {
      base = term
        ? App.State.globalItems.filter(item => {
          const vendorNames = (item.vendors || []).map(v => v.vendor || '').join(' ');
          return App.Utils.matchesKeywords(`${item.name || ''} ${item.size || ''} ${vendorNames}`, term);
        })
        : [...App.State.globalItems];
    }

    App.State.filteredItems = this.applyColumnFilters(base);
    App.State.itemCurrentPage = 1;
    this.renderTable();
  },

  getMetadataFlags(item, pendingMap, stockMap) {
    const { parts, stockEntry } = this.getMetaInfo(item, pendingMap, stockMap);
    const flags = new Set();

    const isPending = pendingMap.has(`${(item.name || '').toLowerCase()}|${(item.size || '').toLowerCase()}`);
    if (isPending) flags.add('pendingOrder');
    if (stockEntry?.isLowStock) flags.add('lowStock');
    if (stockEntry != null && Number(stockEntry.currentStock) === 0) flags.add('zeroStock');
    if (item.remarks) flags.add('hasRemarks');
    if (item.specification) flags.add('hasSpecification');
    if (parts.length === 0) flags.add('noMetadata');

    return flags;
  },

  applyColumnFilters(items) {
    const { name, size, narration, vendor, metadata } = App.State.itemColumnFilters;
    if (!name.length && !size.length && !narration.length && !vendor.length && !metadata.length) return items;

    const pendingMap = metadata.length ? App.Utils.getPendingByItem() : null;
    const stockMap = metadata.length ? this._getStockMap() : null;

    return items.filter(item => {
      if (name.length && !name.includes(item.name || '')) return false;
      if (size.length && !size.includes(item.size || '')) return false;
      if (narration.length && !narration.includes(item.narration || '')) return false;
      if (vendor.length) {
        const itemVendors = (item.vendors || []).map(v => v.vendor || '');
        if (!vendor.some(v => itemVendors.includes(v))) return false;
      }
      if (metadata.length) {
        const flags = this.getMetadataFlags(item, pendingMap, stockMap);
        if (!metadata.some(m => flags.has(m))) return false;
      }
      return true;
    });
  },

  _stockKeyFor(item) {
    return `${String(item.name || '').trim().toLowerCase()}|${String(item.size || '').trim().toLowerCase()}`;
  },

  _getStockMap() {
    const map = new Map();
    (App.State.globalStock || []).forEach(s => {
      map.set(this._stockKeyFor(s), s);
    });
    return map;
  },

  itemKey(item) {
    return `${item.name}|${item.size || ''}`;
  },

  getMetaInfo(item, pendingMap, stockMap) {
    const stockEntry = (stockMap || this._getStockMap()).get(this._stockKeyFor(item));
    const stockPart = stockEntry != null
      ? `<strong>Stock:</strong> <span class="${stockEntry.isLowStock ? 'text-danger fw-bold' : 'text-success fw-bold'}">${stockEntry.currentStock}</span>${stockEntry.isLowStock ? ' <span class="badge bg-danger ms-1 py-0 px-1" style="font-size:0.65rem;">Low</span>' : ''}`
      : null;

    const pendingEntry = (pendingMap || App.Utils.getPendingByItem()).get(
      `${(item.name || '').toLowerCase()}|${(item.size || '').toLowerCase()}`
    );
    const pendingPart = pendingEntry
      ? `<strong>Pending Order:</strong> <span class="text-warning fw-bold">${Math.round(pendingEntry.qty * 100) / 100}</span> ` +
      `<small class="text-muted">(PO# ${[...pendingEntry.poNumbers].map(escapeHtml).join(', ')})</small>`
      : null;

    const parts = [
      stockPart,
      pendingPart,
      item.remarks && `<strong>Remarks:</strong> ${escapeHtml(item.remarks)}`,
      item.specification && `<strong>Specification:</strong> ${escapeHtml(item.specification)}`
    ].filter(Boolean);

    return { parts, stockEntry };
  },

  renderTable() {
    const tbody = document.getElementById('itemTableBody');
    if (!tbody) return;

    const { filteredItems, itemCurrentPage: cur, itemRowsPerPage: rpp } = App.State;
    const start = (cur - 1) * rpp;
    const pageItems = filteredItems.slice(start, start + rpp);

    const selectAllChk = document.getElementById('selectAllItems');
    if (selectAllChk) {
      selectAllChk.checked = pageItems.length > 0 && pageItems.every(item =>
        App.Selection.isSelected(App.State.selectedItems, this.itemKey(item))
      );
    }

    if (!pageItems.length) {
      tbody.innerHTML = (App.State.globalItems || []).length === 0
        ? '<tr><td colspan="7" class="text-center text-muted p-4">No items yet — register one with <strong>+ Register New Item</strong>.</td></tr>'
        : '<tr><td colspan="7" class="text-center text-muted p-4">No items match your search.</td></tr>';
      App.Utils.renderPagination('itemPagination', filteredItems.length, cur, rpp, 'item-page', 'Items');
      return;
    }

    const pendingMap = App.Utils.getPendingByItem();
    const stockMap = this._getStockMap();

    tbody.innerHTML = pageItems
      .map(item => {
        const vendorsHtml = (item.vendors || [])
          .map(v => `
        <span class="badge border border-secondary text-dark me-1 mb-1 fs-6 fw-normal">
          <i class="text-secondary">${escapeHtml(v.vendor)}:</i>
          <strong>${formatCurrency(v.rate)}</strong>
        </span>`)
          .join('');

        const { parts: metaParts } = this.getMetaInfo(item, pendingMap, stockMap);

        const encodedName = encodeURIComponent(item.name || '');
        const encodedSize = encodeURIComponent(item.size || '');
        const key = this.itemKey(item);

        const isSelected = App.Selection.isSelected(App.State.selectedItems, key);
        const checkedAttr = isSelected ? 'checked' : '';

        return `
        <tr class="item-row-clickable" style="cursor:pointer;" data-row-name="${encodedName}" data-row-size="${encodedSize}" title="Click to view Item Ledger">
          <td class="text-center">
            <input type="checkbox" class="form-check-input item-select-chk"
                   data-key="${escapeHtml(key)}"
                   ${checkedAttr} onchange="App.Item.onRowSelectChange()">
          </td>
          <td><strong class="text-primary">${escapeHtml(item.name || '')}</strong></td>
          <td>${escapeHtml(item.size || '-')}</td>
          <td>${escapeHtml(item.narration || '-')}</td>
          <td><small class="text-muted">${metaParts.join('<br>') || 'No metadata'}</small></td>
          <td>${vendorsHtml || '<span class="text-muted fst-italic">No vendors mapped</span>'}</td>
          <td>
            <button class="btn btn-sm btn-outline-info text-dark btn-action w-100 mb-1 fw-bold"
                    data-action="item-ledger"
                    data-name="${encodedName}" data-size="${encodedSize}">Item Ledger</button>
            <button class="btn btn-sm btn-outline-primary btn-action w-100 mb-1"
                    data-action="item-edit"
                    data-name="${encodedName}" data-size="${encodedSize}">Edit</button>
            <button class="btn btn-sm btn-outline-danger btn-action w-100"
                    data-action="item-delete"
                    data-name="${encodedName}" data-size="${encodedSize}">Delete</button>
          </td>
        </tr>`;
      })
      .join('');

    App.Utils.renderPagination('itemPagination', filteredItems.length, cur, rpp, 'item-page', 'Items');
  },

  changePage(pageNumber) {
    App.State.itemCurrentPage = App.Utils.clampPage(pageNumber, App.State.filteredItems.length, App.State.itemRowsPerPage);
    this.renderTable();
  },

  // Computes the variant comparison & transaction history tables for an
  // item (by name), shared by the on-screen modal and bulk print pages.
  getLedgerData(name) {
    const nameLower = name.toLowerCase();
    const compMap = {};

    const getCKey = (size, vendor) => `${String(size || '').trim().toLowerCase()}|${String(vendor || '').trim().toLowerCase()}`;

    const sortedPOs = [...(App.State.globalPOs || [])].sort((a, b) => {
      const ad = parseRecordDate(a.poDateRaw, a.poDate);
      const bd = parseRecordDate(b.poDateRaw, b.poDate);
      return ad - bd;
    });

    sortedPOs.forEach(po => {
      (po.items || []).forEach(line => {
        if ((line.name || '').toLowerCase() === nameLower) {
          const key = getCKey(line.size, po.vendor);
          compMap[key] = {
            size: line.size || '-',
            narration: line.narration || '-',
            vendor: po.vendor,
            masterRate: null,
            latestPoRate: line.price
          };
        }
      });
    });

    const itemMasterVariants = (App.State.globalItems || []).filter(i => (i.name || '').toLowerCase() === nameLower);
    itemMasterVariants.forEach(item => {
      (item.vendors || []).forEach(v => {
        const key = getCKey(item.size, v.vendor);
        if (compMap[key]) {
          compMap[key].masterRate = v.rate;
        } else {
          compMap[key] = { size: item.size || '-', narration: item.narration || '-', vendor: v.vendor, masterRate: v.rate, latestPoRate: null };
        }
      });
    });

    let compHtml = '';
    const compList = Object.values(compMap);
    compList.sort((a, b) => {
      const sc = a.size.localeCompare(b.size);
      if (sc !== 0) return sc;
      return a.vendor.localeCompare(b.vendor);
    });

    compList.forEach(entry => {
      const vendorInfo = (App.State.globalVendors || []).find(vendor => vendor.name.toLowerCase() === entry.vendor.toLowerCase());
      const contact = vendorInfo ? (vendorInfo.contact || vendorInfo.address || '-') : '-';
      const mRateText = entry.masterRate !== null ? formatCurrency(entry.masterRate) : '-';
      const pRateText = entry.latestPoRate !== null ? formatCurrency(entry.latestPoRate) : '-';

      compHtml += `<tr>
        <td><strong>${escapeHtml(entry.size)}</strong></td>
        <td><small class="text-muted">${escapeHtml(entry.narration)}</small></td>
        <td><strong class="text-primary">${escapeHtml(entry.vendor)}</strong></td>
        <td><small>${escapeHtml(contact)}</small></td>
        <td class="text-end fw-bold">${mRateText}</td>
        <td class="text-end fw-bold text-success">${pRateText}</td>
      </tr>`;
    });

    let historyList = [];

    (App.State.globalPOs || []).forEach(po => {
      (po.items || []).forEach(line => {
        if ((line.name || '').toLowerCase() === nameLower) {
          historyList.push({
            dateObj: parseRecordDate(po.poDateRaw, po.poDate), dateStr: po.poDate, type: 'PO Issued', badgeClass: 'bg-primary',
            ref: `PO-${po.poNumber}`, vendor: po.vendor, size: line.size || '-', narration: line.narration || '-',
            orderQty: toNumber(line.qty), incomingQty: 0, outgoingQty: 0, price: line.price
          });
        }
      });
    });

    (App.State.globalBills || []).forEach(bill => {
      (bill.items || []).forEach(line => {
        const lineName = typeof line === 'object' ? line.name : String(line).split(' [')[0];
        const lineSize = typeof line === 'object' ? (line.size || '-') : '-';
        const lineQty = typeof line === 'object' ? toNumber(line.qty) : 0;
        const linePrice = typeof line === 'object' ? toNumber(line.price) : 0;

        if (lineName.toLowerCase() === nameLower) {
          historyList.push({
            dateObj: parseRecordDate(bill.billDateRaw, bill.billDate), dateStr: bill.billDate, type: 'Bill Received', badgeClass: 'bg-success',
            ref: bill.billNumber, vendor: bill.vendor, size: lineSize, narration: '-',
            orderQty: 0, incomingQty: lineQty, outgoingQty: 0, price: linePrice
          });
        }
      });
    });

    (App.State.globalReturns || []).forEach(ret => {
      (ret.items || []).forEach(line => {
        if ((line.name || '').toLowerCase() === nameLower) {
          historyList.push({
            dateObj: parseRecordDate(ret.returnDateRaw, ret.returnDate), dateStr: ret.returnDate, type: 'Goods Returned', badgeClass: 'bg-danger',
            ref: ret.returnNumber, vendor: ret.vendor, size: line.size || '-', narration: '-',
            orderQty: 0, incomingQty: 0, outgoingQty: toNumber(line.qty), price: toNumber(line.price)
          });
        }
      });
    });

    (App.State.globalProduction || []).forEach(lot => {
      if (String(lot.status || '').trim().toLowerCase() !== 'completed') return;
      const bom = (App.State.globalBOMs || []).find(b => b.productId === lot.productId);
      if (!bom) return;
      (bom.components || []).forEach(comp => {
        if ((comp.itemName || '').toLowerCase() === nameLower) {
          historyList.push({
            dateObj: parseRecordDate(lot.dateRaw, lot.date), dateStr: lot.date, type: 'Production Consumption', badgeClass: 'bg-danger',
            ref: lot.productId, vendor: lot.productName || 'Production', size: comp.size || '-', narration: '-',
            orderQty: 0, incomingQty: 0, outgoingQty: toNumber(lot.qty) * toNumber(comp.qtyPerProduct), price: null
          });
        }
      });
    });

    (App.State.globalStockAdjustments || []).forEach(adj => {
      if ((adj.itemName || '').toLowerCase() === nameLower) {
        const isReset = adj.action === 'RESET';
        const delta = adj.newValue - adj.oldValue;
        historyList.push({
          dateObj: new Date(adj.date), dateStr: new Date(adj.date).toLocaleDateString('en-GB'),
          type: isReset ? 'Stock Reset' : 'Manual Adjustment', badgeClass: isReset ? 'bg-info' : 'bg-warning text-dark',
          ref: '-', vendor: adj.user || 'System', size: adj.size || '-', narration: adj.reason || '-',
          orderQty: 0, incomingQty: delta > 0 ? delta : 0, outgoingQty: delta < 0 ? -delta : 0, price: null
        });
      }
    });

    historyList.sort((a, b) => b.dateObj - a.dateObj);

    let histHtml = '';
    historyList.forEach(entry => {
      histHtml += `<tr>
        <td>${entry.dateStr}</td>
        <td><span class="badge ${entry.badgeClass}">${entry.type}</span></td>
        <td><strong class="text-dark">${entry.ref}</strong></td>
        <td><strong class="text-primary">${escapeHtml(entry.vendor)}</strong></td>
        <td>${escapeHtml(entry.size)}</td>
        <td><small class="text-muted">${escapeHtml(entry.narration)}</small></td>
        <td class="text-center text-primary fw-bold">${entry.orderQty || '-'}</td>
        <td class="text-center text-success fw-bold">${entry.incomingQty || '-'}</td>
        <td class="text-center text-danger fw-bold">${entry.outgoingQty || '-'}</td>
        <td class="text-end">${entry.price !== null ? formatCurrency(entry.price) : '-'}</td>
      </tr>`;
    });

    const stockVariants = (App.State.globalStock || [])
      .filter(s => (s.name || '').toLowerCase() === nameLower)
      .sort((a, b) => (a.size || '').localeCompare(b.size || ''));

    const pendingMap = App.Utils.getPendingByItem();

    let stockHtml = '';
    stockVariants.forEach(s => {
      const pendingEntry = pendingMap.get(`${nameLower}|${(s.size || '').toLowerCase()}`);
      const pendingText = pendingEntry
        ? `${Math.round(pendingEntry.qty * 100) / 100} <small class="text-muted">(PO# ${[...pendingEntry.poNumbers].map(escapeHtml).join(', ')})</small>`
        : '-';

      stockHtml += `<tr>
        <td>${escapeHtml(s.size || '-')}</td>
        <td class="text-center fw-bold">${s.initialStock}</td>
        <td class="text-center fw-bold ${s.isLowStock ? 'text-danger' : 'text-success'}">${s.currentStock}</td>
        <td class="text-center fw-bold text-warning">${pendingText}</td>
      </tr>`;
    });

    return { compHtml, histHtml, stockHtml };
  },

  // Lazily fetches Bills/POs/Returns/Production/Stock-adjustment history
  // the first time a ledger is requested in this session -- direct RPC
  // calls, not through App.PO/App.Bill/etc. (which don't have their own
  // tabs yet), so the ledger is genuinely complete even this round.
  async ensureLedgerSourceDataLoaded() {
    const fetches = [];
    if (App.State.globalPOs.length === 0) {
      fetches.push(Api.call('getPOData').then(res => { if (res?.success) App.State.globalPOs = Array.isArray(res.data) ? res.data : []; }));
    }
    if (App.State.globalBills.length === 0) {
      fetches.push(Api.call('getBillData').then(res => { if (res?.success) App.State.globalBills = Array.isArray(res.data) ? res.data : []; }));
    }
    if (App.State.globalReturns.length === 0) {
      fetches.push(Api.call('getReturnData').then(res => { if (res?.success) App.State.globalReturns = Array.isArray(res.data) ? res.data : []; }));
    }
    if (App.State.globalProduction.length === 0) {
      fetches.push(Api.call('getProductionData').then(res => { if (res?.success) App.State.globalProduction = Array.isArray(res.data) ? res.data : []; }));
    }
    if (App.State.globalStockAdjustments.length === 0) {
      fetches.push(Api.call('getStockAdjustmentHistory').then(res => { if (res?.success) App.State.globalStockAdjustments = Array.isArray(res.data) ? res.data : []; }));
    }
    if (fetches.length) await Promise.all(fetches);
  },

  async openLedgerModal(name, size) {
    const titleEl = document.getElementById('itemLedgerTitle');
    if (titleEl) titleEl.innerText = `Item Ledger & Comparison: ${name}`;

    await this.ensureLedgerSourceDataLoaded();

    const { compHtml, histHtml, stockHtml } = this.getLedgerData(name);

    const stockBody = document.getElementById('itemLedgerStockBody');
    if (stockBody) stockBody.innerHTML = stockHtml || '<tr><td colspan="4" class="text-center text-muted p-4">No stock record found for this item.</td></tr>';

    const compBody = document.getElementById('itemLedgerComparisonBody');
    if (compBody) compBody.innerHTML = compHtml || '<tr><td colspan="6" class="text-center text-muted p-4">No variant comparisons available.</td></tr>';

    const historyBody = document.getElementById('itemLedgerHistoryBody');
    if (historyBody) historyBody.innerHTML = histHtml || '<tr><td colspan="10" class="text-center text-muted p-4">No transaction history found for this item.</td></tr>';

    const modalEl = document.getElementById('itemLedgerModal');
    if (modalEl && typeof bootstrap !== 'undefined') {
      bootstrap.Modal.getOrCreateInstance(modalEl).show();
    }
  },

  printLedger() {
    if (typeof App.Print === 'undefined') {
      App.Utils.notPortedYet('Printing');
      return;
    }
    const title = document.getElementById('itemLedgerTitle')?.innerText || 'Item Ledger';
    const name = title.replace('Item Ledger & Comparison: ', '').trim();

    const nameEl = document.getElementById('print-item-name');
    if (nameEl) nameEl.innerText = name;
    const dateEl = document.getElementById('print-item-report-date');
    if (dateEl) dateEl.innerText = new Date().toLocaleDateString('en-GB');

    const stockTableSource = document.getElementById('itemLedgerStockBody');
    const stockTableDest = document.getElementById('print-item-stock-body');
    if (stockTableSource && stockTableDest) stockTableDest.innerHTML = stockTableSource.innerHTML;

    const compTableSource = document.getElementById('itemLedgerComparisonBody');
    const compTableDest = document.getElementById('print-item-comparison-body');
    if (compTableSource && compTableDest) compTableDest.innerHTML = compTableSource.innerHTML;

    const histTableSource = document.getElementById('itemLedgerHistoryBody');
    const histTableDest = document.getElementById('print-item-history-body');
    if (histTableSource && histTableDest) histTableDest.innerHTML = histTableSource.innerHTML;

    App.Print.trigger('print-item-ledger-container', `Item_Ledger_${name.replace(/[^a-zA-Z0-9_-]/g, '_')}`);
  },

  // Only reachable once App.Print exists (bulkPrint guards this) -- left
  // as an unmodified port for that round.
  buildItemLedgerPrintPageHtml(name) {
    const BRAND = '#17a2b8';
    const { compHtml, histHtml, stockHtml } = this.getLedgerData(name);
    const stockRows = stockHtml || '<tr><td colspan="4" style="padding:10px;text-align:center;color:#999;">No stock record found for this item.</td></tr>';
    const compRows = compHtml || '<tr><td colspan="6" style="padding:10px;text-align:center;color:#999;">No variant comparisons available.</td></tr>';
    const histRows = histHtml || '<tr><td colspan="10" style="padding:10px;text-align:center;color:#999;">No transaction history found for this item.</td></tr>';
    const reportDate = new Date().toLocaleDateString('en-GB');

    return `
    <div style="background:#fff;color:#1a1a1a;font-family:'Segoe UI',Arial,sans-serif;font-size:12px;line-height:1.5;padding:14px 20px 12px 20px;margin:0;box-sizing:border-box;width:100%;border-top:5px solid ${BRAND};border-bottom:3px solid ${BRAND};-webkit-print-color-adjust:exact;print-color-adjust:exact;">
      <div style="text-align:center;padding:4px 0 8px 0;">
        ${App.Print.brandHeaderHtml(BRAND)}
        <div style="font-size:10px;color:#555;margin-top:3px;letter-spacing:0.3px;">6-B, SHIV SHAKTI ESTATE, VERKA CHOWK, DEHLON ROAD, BHAGWANPURA, 141114 LUDHIANA</div>
        <div style="font-size:11px;color:${BRAND};font-weight:700;margin-top:4px;letter-spacing:1px;text-transform:uppercase;">Item Transaction Ledger &amp; Comparison Report</div>
      </div>
      <div style="height:2px;background:${BRAND};margin:0 0 12px 0;-webkit-print-color-adjust:exact;print-color-adjust:exact;"></div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <div style="text-align:left;">
          <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Item Name</span>
          <div style="font-size:16px;font-weight:700;color:#111;">${escapeHtml(name)}</div>
        </div>
        <div style="text-align:right;">
          <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Report Date</span>
          <div style="font-size:13px;font-weight:700;color:#1a1a1a;">${escapeHtml(reportDate)}</div>
        </div>
      </div>
      <div style="height:1px;background:#bbb;margin-bottom:14px;"></div>
      <div style="margin-bottom:20px;page-break-inside:avoid;break-inside:avoid;">
        <h6 style="color:${BRAND};font-size:11px;font-weight:700;margin:0 0 8px 0;text-transform:uppercase;letter-spacing:0.5px;-webkit-print-color-adjust:exact;print-color-adjust:exact;">Stock Position (Initial vs Current)</h6>
        <table style="width:100%;border-collapse:collapse;font-size:11px;">
          <thead><tr style="background-color:${BRAND};color:#fff;font-weight:700;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
            <th style="padding:6px;border:1px solid #bbb;text-align:left;width:20%;">Size</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:center;width:18%;">Initial Stock</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:center;width:18%;">Current Stock</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:center;width:44%;">Pending Order</th>
          </tr></thead>
          <tbody>${stockRows}</tbody>
        </table>
      </div>
      <div style="margin-bottom:20px;page-break-inside:avoid;break-inside:avoid;">
        <h6 style="color:${BRAND};font-size:11px;font-weight:700;margin:0 0 8px 0;text-transform:uppercase;letter-spacing:0.5px;-webkit-print-color-adjust:exact;print-color-adjust:exact;">Master Rates &amp; Comparison</h6>
        <table style="width:100%;border-collapse:collapse;font-size:11px;">
          <thead><tr style="background-color:${BRAND};color:#fff;font-weight:700;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
            <th style="padding:6px;border:1px solid #bbb;text-align:left;width:10%;">Size</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:left;width:20%;">Narration</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:left;width:25%;">Vendor Name</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:left;width:21%;">Contact Info</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:right;width:12%;">Master Rate</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:right;width:12%;">Latest PO Rate</th>
          </tr></thead>
          <tbody>${compRows}</tbody>
        </table>
      </div>
      <div style="margin-bottom:20px;">
        <h6 style="color:${BRAND};font-size:11px;font-weight:700;margin:0 0 8px 0;text-transform:uppercase;letter-spacing:0.5px;-webkit-print-color-adjust:exact;print-color-adjust:exact;">Transaction History (POs, Bills &amp; Production Consumption)</h6>
        <table style="width:100%;border-collapse:collapse;font-size:11px;">
          <thead><tr style="background-color:${BRAND};color:#fff;font-weight:700;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
            <th style="padding:6px;border:1px solid #bbb;text-align:left;width:9%;">Date</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:left;width:11%;">Type</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:left;width:10%;">Ref #</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:left;width:16%;">Vendor / Source</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:left;width:9%;">Size</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:left;width:13%;">Narration</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:center;width:9%;">Order Qty</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:center;width:9%;">Incoming Qty</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:center;width:9%;">Outgoing Qty</th>
            <th style="padding:6px;border:1px solid #bbb;text-align:right;width:9%;">Price</th>
          </tr></thead>
          <tbody>${histRows}</tbody>
        </table>
      </div>
    </div>`;
  },

  async bulkPrint() {
    if (typeof App.Print === 'undefined') {
      App.Utils.notPortedYet('Printing');
      return;
    }
    const selectedKeys = App.State.selectedItems;
    if (!selectedKeys.length) {
      App.Utils.showToast('No items selected.', true);
      return;
    }

    await this.ensureLedgerSourceDataLoaded();

    const items = App.State.globalItems.filter(i => App.Selection.isSelected(selectedKeys, this.itemKey(i)));
    const names = [...new Set(items.map(i => i.name))];

    App.Print.triggerBulk(names, name => this.buildItemLedgerPrintPageHtml(name), 'Item_Ledgers_Selected');
  },

  openCreateModal() {
    document.getElementById('itemForm')?.reset();
    document.getElementById('originalItemName').value = '';
    document.getElementById('originalItemSize').value = '';
    document.getElementById('itemFormTitle').innerText = 'Register New Master Item';
    document.getElementById('itemSubmitBtn').innerText = 'Save Item Record';

    const stockRow = document.getElementById('initialStockRow');
    if (stockRow) stockRow.style.display = '';
    const stockHint = document.getElementById('initialStockHint');
    if (stockHint) stockHint.textContent = 'Creates a matching Stock entry for this item. Leave blank for 0.';

    const tbody = document.getElementById('itemVendorsBody');
    if (tbody) tbody.innerHTML = this.getVendorRowHtml();

    const thresholdInput = document.getElementById('formItemThreshold');
    if (thresholdInput) thresholdInput.value = '';

    safeModalShow('itemModal');
  },

  openEditModal(name, size) {
    const item = App.State.globalItems.find(i => (i.name || '') === (name || '') && (i.size || '') === (size || ''));
    if (!item) {
      App.Utils.showToast('Item not found in state.', true);
      return;
    }

    document.getElementById('itemForm')?.reset();
    document.getElementById('originalItemName').value = item.name || '';
    document.getElementById('originalItemSize').value = item.size || '';
    document.getElementById('itemFormTitle').innerText = 'Edit Master Item';
    document.getElementById('itemSubmitBtn').innerText = 'Update Item Record';

    const stockRow = document.getElementById('initialStockRow');
    if (stockRow) stockRow.style.display = '';
    const stockHint = document.getElementById('initialStockHint');
    if (stockHint) stockHint.textContent = 'Only used to create a Stock entry if this item doesn\'t already have one (e.g. orphaned items). Has no effect otherwise.';

    App.Utils.setFieldValues({
      formItemName: item.name || '',
      formItemSize: item.size || '',
      formItemRemarks: item.remarks || '',
      formItemNarration: item.narration || '',
      formItemSpec: item.specification || '',
      formItemBaseUnit: item.baseUnit || 'Pcs',
      formItemPurchaseUnit: item.purchaseUnit || item.baseUnit || 'Pcs',
      formItemWeightPerBaseUnit: item.weightPerBaseUnit || ''
    });

    const stockEntry = (App.State.globalStock || []).find(s => (s.name || '') === (item.name || '') && (s.size || '') === (item.size || ''));
    const thresholdInput = document.getElementById('formItemThreshold');
    if (thresholdInput) thresholdInput.value = stockEntry ? (stockEntry.threshold ?? '') : '';

    const tbody = document.getElementById('itemVendorsBody');
    if (tbody) {
      tbody.innerHTML = (item.vendors || []).length ? item.vendors.map(v => this.getVendorRowHtml(v)).join('') : this.getVendorRowHtml();
    }

    safeModalShow('itemModal');
  },

  async delete(name, size) {
    App.Utils.confirmAction(
      `Are you sure you want to permanently delete "${name}" (${size || 'no size'}) from the Items Master?`,
      async () => {
        try {
          const res = await Api.mutate('deleteItem', name, size);
          App.Utils.showToast(res?.message || 'Delete completed.', !res?.success);
          if (res?.success) {
            App.State.globalStock = [];
            await this.loadData();
          }
        } catch (err) {
          App.Utils.showToast(err.message || 'Failed to delete item.', true);
        }
      }
    );
  },

  toggleSelectAll(masterChk) {
    App.Selection.toggleAll(App.State.selectedItems, 'item-select-chk', masterChk);
    this.updateBulkDeleteButton();
  },

  onRowSelectChange() {
    App.Selection.syncFromRows(App.State.selectedItems, 'item-select-chk', 'selectAllItems');
    this.updateBulkDeleteButton();
  },

  updateBulkDeleteButton() {
    const count = App.State.selectedItems.length;

    const btn = document.getElementById('btnBulkDeleteItems');
    if (btn) {
      if (count > 0) {
        btn.classList.remove('d-none');
        btn.innerHTML = `<i class="bi bi-trash"></i> Delete Selected (${count})`;
      } else {
        btn.classList.add('d-none');
      }
    }

    const mergeBtn = document.getElementById('btnMergeSelected');
    if (mergeBtn) mergeBtn.classList.toggle('d-none', count !== 2);

    App.Selection.updateButton('btnBulkPrintItems', count, '<i class="bi bi-printer"></i> Print Selected');
  },

  async mergeSelected() {
    const selectedKeys = App.State.selectedItems;
    if (selectedKeys.length !== 2) {
      App.Utils.showToast('Check exactly 2 items to merge.', true);
      return;
    }

    const selected = selectedKeys.map(key => App.State.globalItems.find(i => this.itemKey(i) === key)).filter(Boolean);
    if (selected.length !== 2) {
      App.Utils.showToast('Selected items could not be resolved. Please refresh and try again.', true);
      return;
    }

    const [keep, remove] = selected;
    App.Utils.confirmAction(
      `Merge "${remove.name}" (${remove.size || 'no size'}) into "${keep.name}" (${keep.size || 'no size'})? ` +
      `"${keep.name}" will survive with combined stock, vendors, remarks/narration/spec, and "${remove.name}" will be deleted. ` +
      `Any PO/Bill/BOM rows referencing "${remove.name}" will be re-pointed to "${keep.name}". This cannot be undone.`,
      async () => {
        try {
          setDisabled('btnMergeSelected', true);
          const res = await Api.mutate('mergeSelectedItems', selected);
          App.Utils.showToast(res?.message || 'Merge complete.', !res?.success);
          if (res?.success) {
            App.State.selectedItems = [];
            this.updateBulkDeleteButton();
            App.State.globalStock = [];
            await this.loadData();
          }
        } catch (err) {
          App.Utils.showToast(err.message || 'Merge failed.', true);
        } finally {
          setDisabled('btnMergeSelected', false);
        }
      }
    );
  },

  async bulkDelete() {
    const count = App.State.selectedItems.length;
    if (count === 0) return;

    App.Utils.confirmAction(
      `Are you sure you want to permanently delete the ${count} selected item(s) from the Items Master?`,
      async () => {
        try {
          setDisabled('btnBulkDeleteItems', true);
          App.Utils.showToast('Deleting selected items...');
          const items = App.State.globalItems.filter(i => App.Selection.isSelected(App.State.selectedItems, this.itemKey(i)));
          const res = await Api.mutate('deleteItemsBulk', items);
          App.Utils.showToast(res?.message || 'Bulk delete completed.', !res?.success);
          if (res?.success) {
            App.State.selectedItems = [];
            App.State.globalStock = [];
            await this.loadData();
          }
        } catch (err) {
          App.Utils.showToast(err.message || 'Failed to bulk delete items.', true);
        } finally {
          setDisabled('btnBulkDeleteItems', false);
        }
      }
    );
  },

  addVendorRow() {
    document.getElementById('itemVendorsBody')?.insertAdjacentHTML('beforeend', this.getVendorRowHtml());
  },

  getVendorRowHtml(vendor = {}) {
    const hint = (vendor.ratePerBaseUnit && Math.abs(vendor.ratePerBaseUnit - (vendor.rate || 0)) > 0.0001)
      ? `<div class="form-text">≈ ₹${Number(vendor.ratePerBaseUnit).toFixed(4)} per Base Unit</div>`
      : '';
    return `
    <tr>
      <td><input type="text"   class="form-control item-vendor-name" list="vendorList" value="${escapeHtml(vendor.vendor || '')}" placeholder="e.g. Avon Cycles" required></td>
      <td><input type="number" class="form-control item-vendor-rate" step="0.01"        value="${escapeHtml(String(vendor.rate ?? ''))}" placeholder="0.00 (optional)" min="0">${hint}</td>
      <td><button type="button" class="btn btn-outline-danger btn-sm" data-action="remove-row">✕</button></td>
    </tr>`;
  },

  async syncFromStock() {
    App.Utils.confirmAction(
      'Import all items from the Stock sheet that are not yet in Item Master? They will be added with blank metadata — you can enrich them later via Edit.',
      async () => {
        const btn = document.getElementById('btnSyncFromStock');
        try {
          if (btn) { btn.disabled = true; btn.innerHTML = '<i class="bi bi-arrow-repeat"></i> Syncing…'; }
          const res = await Api.mutate('importItemsFromStock');
          App.Utils.showToast(res?.message || 'Sync complete.', !res?.success);
          if (res?.success) await this.loadData();
        } catch (err) {
          App.Utils.showToast(err.message || 'Sync failed.', true);
        } finally {
          if (btn) { btn.disabled = false; btn.innerHTML = '<i class="bi bi-arrow-repeat"></i> Sync from Stock'; }
        }
      }
    );
  },

  async mergeDuplicates() {
    App.Utils.confirmAction(
      'Scan Item Master for duplicates? This will: (1) auto-fix rows whose name is an unambiguous truncated/typo prefix of another row with the same size (renaming, merging stock, and re-pointing PO/Bill/BOM references), then (2) merge any remaining rows that share the exact same Name + Size (combining their remarks/narration/spec and vendor rates). This cannot be undone.',
      async () => {
        const btn = document.getElementById('btnMergeDuplicates');
        try {
          if (btn) { btn.disabled = true; btn.innerHTML = '<i class="bi bi-magic"></i> Merging…'; }
          const res = await Api.mutate('runScheduledItemCleanup');
          App.Utils.showToast(res?.message || 'Merge complete.', !res?.success);
          if (res?.success) {
            App.State.globalStock = [];
            await this.loadData();
          }
        } catch (err) {
          App.Utils.showToast(err.message || 'Merge failed.', true);
        } finally {
          if (btn) { btn.disabled = false; btn.innerHTML = '<i class="bi bi-magic"></i> Merge Duplicates'; }
        }
      }
    );
  },

  serializeForm() {
    const form = document.getElementById('itemForm');
    const formData = Object.fromEntries(new FormData(form));
    const vendors = [];

    $$('#itemVendorsBody tr').forEach(row => {
      const vendor = $('.item-vendor-name', row)?.value?.trim();
      if (vendor) vendors.push({ vendor, rate: toNumber($('.item-vendor-rate', row)?.value) });
    });

    formData.vendors = JSON.stringify(vendors);
    formData.originalName = document.getElementById('originalItemName')?.value || '';
    formData.originalSize = document.getElementById('originalItemSize')?.value || '';
    return { formData, vendors };
  }
};

// Item row click -> open Item Ledger (matches source's row-click delegate,
// separate from the explicit "Item Ledger" button for the same action).
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('itemTableBody')?.addEventListener('click', e => {
    const row = e.target.closest('.item-row-clickable');
    if (!row || e.target.closest('button')) return;
    App.Item.openLedgerModal(
      decodeURIComponent(row.dataset.rowName || ''),
      decodeURIComponent(row.dataset.rowSize || '')
    );
  });

  const itemForm = document.getElementById('itemForm');
  if (itemForm) {
    itemForm.addEventListener('submit', async e => {
      e.preventDefault();
      const { formData } = App.Item.serializeForm();

      setDisabled('itemSubmitBtn', true);
      try {
        const res = await Api.mutate('saveItem', formData);

        if (!res?.success && res?.data?.mergeable) {
          const { targetName, targetSize, targetStock, targetVendorCount } = res.data;
          App.Utils.confirmAction(
            `Item "${targetName}" (size: ${targetSize || '-'}) already exists with ` +
            `Stock: ${targetStock} and ${targetVendorCount} vendor(s) mapped. ` +
            `Merge this edit into it? Stock will combine and this edit's vendors will be added.`,
            async () => {
              setDisabled('itemSubmitBtn', true);
              try {
                const mergeRes = await Api.mutate('mergeItemEdit', formData);
                safeModalHide('itemModal');
                App.Utils.showToast(mergeRes?.message || 'Item merged.', !mergeRes?.success);
                if (mergeRes?.success) {
                  App.State.globalStock = [];
                  await App.Item.loadData();
                }
              } catch (mergeErr) {
                App.Utils.showToast(mergeErr.message || 'Failed to merge item.', true);
              } finally {
                setDisabled('itemSubmitBtn', false);
              }
            }
          );
          return;
        }

        const isEdit = !!formData.originalName;
        if (res?.success) {
          const thresholdInput = document.getElementById('formItemThreshold');
          const thresholdVal = thresholdInput ? parseInt(thresholdInput.value, 10) : NaN;
          if (!isNaN(thresholdVal) && thresholdVal >= 0) {
            const savedName = formData.itemName?.trim() || '';
            const savedSize = formData.itemSize?.trim() || '';
            try {
              await Api.mutate('updateThreshold', savedName, savedSize, thresholdVal);
            } catch (_) { /* best-effort, matches source */ }
          }
          App.State.globalStock = [];
          await App.Item.loadData();
        }
        if (res?.success && !isEdit) {
          App.Item.openCreateModal();
        } else {
          safeModalHide('itemModal');
        }
        App.Utils.showToast(res?.message || 'Item saved.', !res?.success);
      } catch (err) {
        App.Utils.showToast(err.message || 'Failed to save item.', true);
      } finally {
        setDisabled('itemSubmitBtn', false);
      }
    });
  }
});
