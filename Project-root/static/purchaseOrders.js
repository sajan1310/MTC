"use strict";

const PurchaseOrders = {
  state: {
    purchaseOrders: [],
    allVariants: [],
    // variant search pagination state
    variantSearchPage: 1,
    variantSearchPerPage: 50,
    variantSearchMore: false,
    variantSearchQuery: '',
    currentPOId: null,
  },
  elements: {},

  init() {
    // Initialize on all pages so PO modal can be opened from anywhere.
    this.isPOPage = !!document.getElementById("po-table-body");
    console.log("PurchaseOrders module initialized. PO page:", this.isPOPage);

    this.cacheDOMElements();
    this.bindEventListeners();

  // Only fetch list if on PO listing page
  if (this.isPOPage) this.fetchPurchaseOrders();
  },

  cacheDOMElements() {
    const ids = [
      "po-table-body", "add-po-btn", "po-modal", "po-form", "po-items-container",
      "po-items-table", "po-items-tbody", "hide-rates-checkbox",
      "add-po-item-btn", "po-status-filter", "po-start-date-filter", "po-end-date-filter",
      "receive-stock-btn", "receive-stock-modal", "receive-stock-form",
      "variant-search-modal", "variant-search-input", "variant-search-results",
      "add-selected-variants-btn", "select-all-variants",
    ];
    ids.forEach(id => {
      const camelCaseId = id.replace(/-(\w)/g, (_, c) => c.toUpperCase());
      this.elements[camelCaseId] = document.getElementById(id);
    });
  },

  bindEventListeners() {
    // Bind page-specific listeners (filters, receive stock). Modal-related bindings are handled by PoModal module.
    const poFilters = ["poStatusFilter", "poStartDateFilter", "poEndDateFilter"];
    poFilters.forEach(el => {
      this.elements[el]?.addEventListener("change", () => this.fetchPurchaseOrders());
    });

    this.elements.receiveStockBtn?.addEventListener("click", () => this.openReceiveStockModal());
    this.elements.receiveStockForm?.addEventListener("submit", (e) => this.handleReceiveStockFormSubmit(e));
    document.getElementById("add-receive-item-btn")?.addEventListener("click", () => this.addReceiveItemRow());

    // Hide rates checkbox toggling
    const hideRates = this.elements.hideRatesCheckbox;
    if (hideRates) {
      hideRates.addEventListener('change', (e) => {
        const hide = !!e.target.checked;
        // toggle header
        const table = document.getElementById('po-items-table');
        if (table) {
          const th = table.querySelector('th.rate-column');
          if (th) th.style.display = hide ? 'none' : '';
          table.querySelectorAll('.rate-cell').forEach(td => td.style.display = hide ? 'none' : '');
        }
      });
    }
  },
  /**
   * Ensure PO modal (and related variant-search modal) exist in the DOM.
   * If not present, create and attach them, then refresh cached elements and attach listeners.
   */
  async ensurePOModalExists() {
    // Kept for backward compatibility: re-cache elements if needed
    this.cacheDOMElements();
    return;
  },
  // Modal behavior has been moved to static/js/poModal.js (PoModal). PurchaseOrders keeps core data methods.
  async fetchPurchaseOrders() {
    try {
      const url = new URL(`${App.config.apiBase}/purchase-orders`, window.location.origin);
      const params = {
        status: this.elements.poStatusFilter?.value,
        start_date: this.elements.poStartDateFilter?.value,
        end_date: this.elements.poEndDateFilter?.value,
      };

      // Only append non-empty parameters
      Object.entries(params).forEach(([key, value]) => {
        if (value) url.searchParams.append(key, value);
      });

      const data = await App.fetchJson(url.toString());
      if (data && Array.isArray(data)) {
        this.state.purchaseOrders = data;
        this.renderPurchaseOrdersList();
      } else {
        this.state.purchaseOrders = [];
        this.renderPurchaseOrdersList();
        if (!data) {
          App.showNotification("Failed to load purchase orders. Please try again.", "error");
        }
      }
    } catch (error) {
      console.error('Error fetching purchase orders:', error);
      this.state.purchaseOrders = [];
      this.renderPurchaseOrdersList();
      App.showNotification("Network error loading purchase orders.", "error");
    }
  },

  /**
   * Fetches all available variants for the variant search/selection modal
   * Used when adding items to purchase orders
   */
  async fetchAllVariantsForSearch() {
    // Deprecated: we no longer preload the entire variants list — use paginated fetch instead
    this.state.allVariants = [];
  },

  /**
   * Fetch a page of variants from the backend. Returns an object with items, page, per_page, total.
   */
  async fetchVariantsPage(page = 1, perPage = 50, q = '') {
    try {
      const url = new URL(`${App.config.apiBase}/all-variants`, window.location.origin);
      url.searchParams.append('page', page);
      url.searchParams.append('per_page', perPage);
      if (q) url.searchParams.append('q', q);
      const data = await App.fetchJson(url.toString());
      // Expect { items: [...], page, per_page, total }
      if (data && data.items && Array.isArray(data.items)) {
        return data;
      }
      // If backend didn't return paginated shape, try to interpret array
      if (Array.isArray(data)) {
        return { items: data, page: 1, per_page: data.length, total: data.length };
      }
      return { items: [], page: page, per_page: perPage, total: 0 };
    } catch (err) {
      console.error('Error fetching variants page:', err);
      return { items: [], page: page, per_page: perPage, total: 0 };
    }
  },

  /**
   * Renders the purchase orders list in the table
   * Shows appropriate message when list is empty
   */
  renderPurchaseOrdersList() {
    const tbody = this.elements.poTableBody;
    if (!tbody) return;

    if (this.state.purchaseOrders.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" class="text-center p-8">
            No purchase orders found. Click "New Purchase Order" to create one!
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = this.state.purchaseOrders.map(po => `
      <tr data-po-id="${po.po_id}">
        <td>${App.escapeHtml(po.po_number || 'N/A')}</td>
        <td>${App.escapeHtml(po.firm_name || 'Unknown Supplier')}</td>
        <td>${po.order_date ? new Date(po.order_date).toLocaleDateString() : 'N/A'}</td>
        <td>₹${(parseFloat(po.total_amount) || 0).toFixed(2)}</td>
        <td><span class="status-badge status-${(po.status || 'draft').toLowerCase().replace(' ', '-')}">${App.escapeHtml(po.status || 'Draft')}</span></td>
        <td class="actions-cell">
          <button class="button-icon view-po" title="View Details"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M12 5c-7 0-10 7-10 7s3 7 10 7 10-7 10-7-3-7-10-7z"></path></svg></button>
          <button class="button-icon edit-po" title="Edit PO"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></button>
          <button class="button-icon delete-po" title="Delete PO"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>
        </td>
      </tr>
    `).join("");
  },

  openPurchaseOrderModal(po = null) {
    this.state.currentPOId = po ? po.po_id : null;
    const modal = this.elements.poModal;
    const form = this.elements.poForm;
    const itemsContainer = this.elements.poItemsContainer;

    if (!modal) {
      console.error('openPurchaseOrderModal: poModal element not found in DOM.');
      return;
    }

    // Safely update modal title if present
    const titleEl = modal.querySelector('.modal-title');
    if (titleEl) titleEl.textContent = po ? `Edit PO #${po.po_number}` : 'Create Purchase Order';

    if (form && typeof form.reset === 'function') form.reset();
    if (itemsContainer) itemsContainer.innerHTML = '';
    if (po) {
        // Populate form for editing
    }
    // Use shared Modal helper for consistent ARIA/focus behavior
    try { Modal.open(this.elements.poModal); } catch (e) { this.elements.poModal.classList.add('is-open'); }
  },

  openVariantSearchModal() {
    // Ensure modal exists before opening and rendering results
    if (!this.elements.variantSearchModal) {
      console.error('openVariantSearchModal: variantSearchModal element not found in DOM.');
      return;
    }
    // reset pagination and render first page
    this.state.variantSearchPage = 1;
    this.state.variantSearchQuery = this.elements.variantSearchInput ? this.elements.variantSearchInput.value.trim() : '';
    this.renderVariantSearchResults();
    // Use shared Modal helper for consistent ARIA/focus behavior
    try { Modal.open(this.elements.variantSearchModal); } catch (e) { this.elements.variantSearchModal.classList.add('is-open'); }
  },

  // PurchaseOrders uses the global Modal helper for open/close to keep behavior consistent.

  renderVariantSearchResults() {
    const inputEl = this.elements.variantSearchInput;
    const resultsEl = this.elements.variantSearchResults;

    if (!inputEl || !resultsEl) return;

    const searchTerm = inputEl.value.trim();

    // If query changed, reset to first page
    if (this.state.variantSearchQuery !== searchTerm) {
      this.state.variantSearchQuery = searchTerm;
      this.state.variantSearchPage = 1;
      resultsEl.innerHTML = '';
    }

    const pageToLoad = this.state.variantSearchPage || 1;

  // Show a simple loading indicator as a table row (tbody must contain tr elements)
  const loadingRow = document.createElement('tr');
  loadingRow.className = 'loading-row';
  loadingRow.innerHTML = `<td colspan="5" class="muted">Loading...</td>`;
  resultsEl.appendChild(loadingRow);

    this.fetchVariantsPage(pageToLoad, this.state.variantSearchPerPage, searchTerm)
      .then((resp) => {
        // Debug: log backend response for variant search to help diagnose loading issues
        try { console.log('DEBUG: /api/all-variants response', resp); } catch (e) {}
        const { items, page, per_page, total } = resp || { items: [], page: 1, per_page: 0, total: 0 };
  // remove loading
  loadingRow.remove();

        if (!items || items.length === 0) {
          // remove loading row
          loadingRow.remove();
          if (pageToLoad === 1) {
            const emptyRow = document.createElement('tr');
            emptyRow.innerHTML = `<td colspan="5" class="muted">No items found.</td>`;
            resultsEl.appendChild(emptyRow);
          }
          this.state.variantSearchMore = false;
          return;
        }

        // Append items as table rows to the tbody (variant-search-results is a tbody)
        const fragment = document.createDocumentFragment();
        items.forEach(v => {
          const tr = document.createElement('tr');
          const variantName = App.escapeHtml(v.name || v.full_name || v.text || '');
          const variation = App.escapeHtml(v.variation || v.variant || '');
          const color = App.escapeHtml(v.color || '');
          const size = App.escapeHtml(v.size || '');

          tr.innerHTML = `
            <td><input type="checkbox" class="variant-checkbox" data-variant-id="${v.id}" data-variant-name="${variantName}"></td>
            <td>${variantName}</td>
            <td>${variation}</td>
            <td>${color}</td>
            <td>${size}</td>
          `;

          fragment.appendChild(tr);
        });

        // If first page, replace contents; otherwise append
        if (pageToLoad === 1) {
          resultsEl.innerHTML = '';
        }
        // append new rows
        resultsEl.appendChild(fragment);

        const loaded = page * per_page;
        this.state.variantSearchMore = loaded < (total || 0);

        // Add or update Load more as a table row
        const existingLoadMoreRow = resultsEl.querySelector('.load-more-variants-row');
        if (this.state.variantSearchMore) {
          if (!existingLoadMoreRow) {
            const loadMoreRow = document.createElement('tr');
            loadMoreRow.className = 'load-more-variants-row';
            loadMoreRow.innerHTML = `<td colspan="5" style="text-align:center;"><button type=\"button\" class=\"button small load-more-variants\">Load more</button></td>`;
            // attach handler on the button
            loadMoreRow.querySelector('.load-more-variants').addEventListener('click', (e) => {
              e.preventDefault();
              this.state.variantSearchPage = (this.state.variantSearchPage || 1) + 1;
              // Render next page (will append)
              this.renderVariantSearchResults();
            });
            resultsEl.appendChild(loadMoreRow);
          }
        } else if (existingLoadMoreRow) {
          existingLoadMoreRow.remove();
        }
      })
      .catch(err => {
        console.error('Variant search render error:', err);
        // Ensure loadingRow is removed if present
        try { loadingRow.remove(); } catch (e) {}
      });
  },

  addSelectedVariantsToPO() {
    const resultsEl = this.elements.variantSearchResults;
    const modal = this.elements.variantSearchModal;

    if (!resultsEl) {
      console.error('addSelectedVariantsToPO: variantSearchResults element not found in DOM.');
      return;
    }

    const selected = resultsEl.querySelectorAll('input[type="checkbox"]:checked');
    selected.forEach(cb => {
      this.addPOItemRow({
        variant_id: cb.dataset.variantId,
        full_name: cb.dataset.variantName,
      });
    });

    if (modal) {
      try { Modal.close(modal); } catch (e) { modal.classList.remove('is-open'); }
    }
  },

  addPOItemRow(item = {}) {
    const tbody = document.getElementById('po-items-tbody') || this.elements.poItemsTbody;
    if (!tbody) {
      console.error('addPOItemRow: po-items-tbody not found');
      return;
    }

    const tr = document.createElement('tr');
    tr.className = 'po-item-row';
    tr.dataset.variantId = item.variant_id;

    const qtyVal = item.quantity || 1;
    const rateVal = (typeof item.rate !== 'undefined') ? item.rate : 0;

    tr.innerHTML = `
      <td>${App.escapeHtml(item.full_name)}</td>
      <td><input type="number" name="quantity" class="po-quantity" required min="1" value="${qtyVal}"></td>
      <td class="rate-cell"><input type="number" name="rate" class="po-rate" required min="0" step="0.01" value="${rateVal}"></td>
      <td class="po-item-total">₹${(parseFloat(qtyVal) * parseFloat(rateVal)).toFixed(2)}</td>
      <td><button type="button" class="button-icon remove-po-item" title="Remove Item">&times;</button></td>
    `;

    // quantity/rate change handlers to update row total
    const qtyInput = tr.querySelector('input[name="quantity"]');
    const rateInput = tr.querySelector('input[name="rate"]');
    const totalCell = tr.querySelector('.po-item-total');

    const updateRow = () => {
      const q = parseFloat(qtyInput.value) || 0;
      const r = parseFloat(rateInput.value) || 0;
      totalCell.textContent = `₹${(q * r).toFixed(2)}`;
      this.updatePOGrandTotal();
    };

    qtyInput.addEventListener('input', updateRow);
    rateInput.addEventListener('input', updateRow);

    // remove handler
    tr.querySelector('.remove-po-item').addEventListener('click', () => {
      tr.remove();
      this.updatePOGrandTotal();
    });

    tbody.appendChild(tr);
    this.updatePOGrandTotal();
  },

  updatePOGrandTotal() {
    // compute grand total and store in hidden field (or console log)
    try {
      const tbody = document.getElementById('po-items-tbody') || this.elements.poItemsTbody;
      if (!tbody) return;
      let grand = 0;
      tbody.querySelectorAll('tr.po-item-row').forEach(r => {
        const q = parseFloat(r.querySelector('input[name="quantity"]').value) || 0;
        const rt = parseFloat(r.querySelector('input[name="rate"]').value) || 0;
        grand += q * rt;
      });
      // expose total in a hidden input so server can show/use it if needed
      let totalEl = document.getElementById('po-grand-total');
      if (!totalEl) {
        totalEl = document.createElement('input');
        totalEl.type = 'hidden';
        totalEl.id = 'po-grand-total';
        totalEl.name = 'grand_total';
        const form = document.getElementById('po-form');
        if (form) form.appendChild(totalEl);
      }
      totalEl.value = grand.toFixed(2);
    } catch (err) {
      console.error('updatePOGrandTotal error:', err);
    }
  },

  /**
   * Handles purchase order form submission
   * Gathers all PO items and submits to backend
   * @param {Event} e - Form submit event
   */
  async handlePOFormSubmit(e) {
    e.preventDefault();

    const form = e.target;
    const supplierId = form.querySelector('[name="supplier_id"]')?.value;
    const notes = form.querySelector('[name="notes"]')?.value || '';
    const status = form.querySelector('[name="status"]')?.value || 'Draft';

    // Validate supplier selection
    if (!supplierId) {
      App.showNotification("Please select a supplier.", "error");
      return;
    }

    // Gather PO items
  const items = [];
  const tbody = document.getElementById('po-items-tbody') || this.elements.poItemsTbody;
  const itemRows = tbody ? tbody.querySelectorAll('.po-item-row') : [];

    if (itemRows.length === 0) {
      App.showNotification("Please add at least one item to the purchase order.", "error");
      return;
    }

    // Validate and collect items
    let hasError = false;
    const hideRates = document.getElementById('hide-rates-checkbox')?.checked;
    itemRows.forEach(row => {
      const variantId = row.dataset.variantId;
      const quantity = parseInt(row.querySelector('[name="quantity"]').value, 10);
      let rate = 0;
      if (!hideRates) {
        rate = parseFloat(row.querySelector('[name="rate"]').value);
      } else {
        // if rates are hidden, default to 0 (or could be left undefined)
        rate = 0;
      }

      if (!variantId || isNaN(quantity) || quantity <= 0 || (!hideRates && (isNaN(rate) || rate < 0))) {
        hasError = true;
        return;
      }

      items.push({
        variant_id: variantId,
        quantity: quantity,
        rate: rate
      });
    });

    if (hasError) {
      App.showNotification("Please ensure all items have valid quantity and rate values.", "error");
      return;
    }

    // Prepare PO data
    const poData = {
      supplier_id: parseInt(supplierId, 10),
      items: items,
      notes: notes,
      status: status
    };

    try {
      const url = this.state.currentPOId
        ? `${App.config.apiBase}/purchase-orders/${this.state.currentPOId}`
        : `${App.config.apiBase}/purchase-orders`;
      const method = this.state.currentPOId ? 'PUT' : 'POST';

      const result = await App.fetchJson(url, {
        method: method,
        body: JSON.stringify(poData)
      });

      if (result) {
        try { Modal.close(this.elements.poModal); } catch (e) { this.elements.poModal.classList.remove('is-open'); }
        this.fetchPurchaseOrders(); // Refresh list
        App.showNotification(
          `Purchase order ${this.state.currentPOId ? 'updated' : 'created'} successfully.`,
          'success'
        );
      } else {
        App.showNotification("Failed to save purchase order. Please try again.", "error");
      }
    } catch (error) {
      console.error('Error saving purchase order:', error);
      App.showNotification("Network error saving purchase order.", "error");
    }
  },

  openReceiveStockModal(po = null) {
    try { Modal.open(this.elements.receiveStockModal); } catch (e) { this.elements.receiveStockModal.classList.add('is-open'); }
    // Pre-fill from PO if provided
  },

  /**
   * Adds a new item row to the receive stock form
   * Allows adding multiple items to a single stock receipt
   */
  addReceiveItemRow() {
    const tbody = document.getElementById('receive-items-body');
    if (!tbody) return;

    const row = document.createElement('tr');
    row.className = 'receive-item-row';
    row.innerHTML = `
      <td>
        <select name="variant_id" class="variant-select" required>
          <option value="">Select Item/Variant...</option>
        </select>
      </td>
      <td><input type="number" name="quantity" placeholder="Qty" required min="1" value="1"></td>
      <td><input type="number" name="cost_per_unit" placeholder="Cost" required min="0" step="0.01" value="0"></td>
      <td class="receive-item-total">₹0.00</td>
      <td>
        <button type="button" class="button-icon remove-receive-item" title="Remove Item">&times;</button>
      </td>
    `;

    // Add event listeners for automatic calculation
    const qtyInput = row.querySelector('[name="quantity"]');
    const costInput = row.querySelector('[name="cost_per_unit"]');
    const totalCell = row.querySelector('.receive-item-total');

    const updateTotal = () => {
      const qty = parseFloat(qtyInput.value) || 0;
      const cost = parseFloat(costInput.value) || 0;
      const total = qty * cost;
      totalCell.textContent = `₹${total.toFixed(2)}`;
      this.updateReceiveTotals();
    };

    qtyInput.addEventListener('input', updateTotal);
    costInput.addEventListener('input', updateTotal);

    // Handle remove button
    row.querySelector('.remove-receive-item').addEventListener('click', () => {
      row.remove();
      this.updateReceiveTotals();
    });

    tbody.appendChild(row);

    // Populate select options lazily if not preloaded
    const selectEl = row.querySelector('select.variant-select');
    if (selectEl && (!this.state.allVariants || this.state.allVariants.length === 0)) {
      // fetch first page of variants to populate the dropdown
      this.fetchVariantsPage(1, 100, '')
        .then(({ items }) => {
          if (items && items.length) {
            items.forEach(v => {
              const opt = document.createElement('option');
              opt.value = v.id;
              opt.textContent = v.name || v.text || '';
              selectEl.appendChild(opt);
            });
          }
        })
        .catch(err => console.error('Error loading variants for receive select:', err));
    } else if (selectEl && this.state.allVariants && this.state.allVariants.length) {
      this.state.allVariants.forEach(v => {
        const opt = document.createElement('option');
        opt.value = v.id;
        opt.textContent = v.name || v.full_name || '';
        selectEl.appendChild(opt);
      });
    }
  },

  /**
   * Updates the totals in the receive stock form
   * Calculates subtotal, tax, discount, and grand total
   */
  updateReceiveTotals() {
    const rows = document.querySelectorAll('.receive-item-row');
    let subtotal = 0;

    rows.forEach(row => {
      const qty = parseFloat(row.querySelector('[name="quantity"]').value) || 0;
      const cost = parseFloat(row.querySelector('[name="cost_per_unit"]').value) || 0;
      subtotal += qty * cost;
    });

    const taxPercent = parseFloat(document.getElementById('receive-tax-percentage')?.value) || 0;
    const discountPercent = parseFloat(document.getElementById('receive-discount-percentage')?.value) || 0;

    const discountAmount = (subtotal * discountPercent) / 100;
    const taxableAmount = subtotal - discountAmount;
    const taxAmount = (taxableAmount * taxPercent) / 100;
    const grandTotal = taxableAmount + taxAmount;

    // Update display elements
    document.getElementById('receive-discount-amount').textContent = `₹${discountAmount.toFixed(2)}`;
    document.getElementById('receive-total-amount').textContent = `₹${subtotal.toFixed(2)}`;
    document.getElementById('receive-grand-total').textContent = `₹${grandTotal.toFixed(2)}`;
  },

  /**
   * Handles stock receipt form submission
   * Submits received items to update inventory
   * @param {Event} e - Form submit event
   */
  async handleReceiveStockFormSubmit(e) {
    e.preventDefault();

    const form = e.target;
    const supplierId = document.getElementById('receive-supplier-select')?.value;
    const billNumber = document.getElementById('receive-bill-number')?.value || '';
    const poNumber = document.getElementById('receive-po-number')?.value || '';

    // Validate supplier
    if (!supplierId) {
      App.showNotification("Please select a supplier.", "error");
      return;
    }

    // Gather receive items
    const items = [];
    const itemRows = document.querySelectorAll('.receive-item-row');

    if (itemRows.length === 0) {
      App.showNotification("Please add at least one item to receive.", "error");
      return;
    }

    let hasError = false;
    itemRows.forEach(row => {
      const variantId = row.querySelector('[name="variant_id"]').value;
      const quantity = parseInt(row.querySelector('[name="quantity"]').value, 10);
      const costPerUnit = parseFloat(row.querySelector('[name="cost_per_unit"]').value);

      if (!variantId || isNaN(quantity) || quantity <= 0 || isNaN(costPerUnit) || costPerUnit < 0) {
        hasError = true;
        return;
      }

      items.push({
        variant_id: variantId,
        quantity: quantity,
        cost_per_unit: costPerUnit
      });
    });

    if (hasError) {
      App.showNotification("Please ensure all items have valid values.", "error");
      return;
    }

    // Prepare receipt data
    const receiptData = {
      supplier_id: parseInt(supplierId, 10),
      bill_number: billNumber,
      po_number: poNumber,
      items: items,
      tax_percentage: parseFloat(document.getElementById('receive-tax-percentage')?.value) || 0,
      discount_percentage: parseFloat(document.getElementById('receive-discount-percentage')?.value) || 0
    };

    try {
      const result = await App.fetchJson(`${App.config.apiBase}/stock-receipts`, {
        method: 'POST',
        body: JSON.stringify(receiptData)
      });

    if (result) {
      try { Modal.close(this.elements.receiveStockModal); } catch (e) { this.elements.receiveStockModal.classList.remove('is-open'); }
        App.showNotification("Stock received and inventory updated successfully.", "success");
        // Optionally refresh PO list or inventory
      } else {
        App.showNotification("Failed to record stock receipt. Please try again.", "error");
      }
    } catch (error) {
      console.error('Error submitting stock receipt:', error);
      App.showNotification("Network error submitting stock receipt.", "error");
    }
  },
};

// Expose to window so other modules (PoModal, Inventory) can safely call into it
window.PurchaseOrders = PurchaseOrders;

document.addEventListener("DOMContentLoaded", () => PurchaseOrders.init());
