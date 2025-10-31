"use strict";

const PurchaseOrders = {
  state: {
    purchaseOrders: [],
    allVariants: [],
    currentPOId: null,
  },
  elements: {},

  init() {
    if (!document.getElementById("po-table-body")) return;
    console.log("PurchaseOrders module initialized.");

    this.cacheDOMElements();
    this.bindEventListeners();
    this.fetchPurchaseOrders();
    this.fetchAllVariantsForSearch();
  },

  cacheDOMElements() {
    const ids = [
      "po-table-body", "add-po-btn", "po-modal", "po-form", "po-items-container",
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
    this.elements.addPoBtn?.addEventListener("click", () => this.openPurchaseOrderModal());
    this.elements.poForm?.addEventListener("submit", (e) => this.handlePOFormSubmit(e));
    this.elements.addPoItemBtn?.addEventListener("click", () => this.openVariantSearchModal());
    
    const poFilters = ["poStatusFilter", "poStartDateFilter", "poEndDateFilter"];
    poFilters.forEach(el => {
      this.elements[el]?.addEventListener("change", () => this.fetchPurchaseOrders());
    });

    this.elements.receiveStockBtn?.addEventListener("click", () => this.openReceiveStockModal());
    this.elements.receiveStockForm?.addEventListener("submit", (e) => this.handleReceiveStockFormSubmit(e));
    document.getElementById("add-receive-item-btn")?.addEventListener("click", () => this.addReceiveItemRow());

    this.elements.variantSearchInput?.addEventListener("input", () => this.renderVariantSearchResults());
    this.elements.addSelectedVariantsBtn?.addEventListener("click", () => this.addSelectedVariantsToPO());
    this.elements.selectAllVariants?.addEventListener("change", (e) => {
      const checkboxes = this.elements.variantSearchResults.querySelectorAll('input[type="checkbox"]');
      checkboxes.forEach(checkbox => checkbox.checked = e.target.checked);
    });
  },

  /**
   * Fetches purchase orders with optional filters (status, date range)
   * Handles loading and error states
   */
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
    try {
      const data = await App.fetchJson(`${App.config.apiBase}/all-variants`);
      if (data && Array.isArray(data)) {
        this.state.allVariants = data;
      } else {
        this.state.allVariants = [];
        console.warn('No variants available or invalid response format');
      }
    } catch (error) {
      console.error('Error fetching variants for search:', error);
      this.state.allVariants = [];
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
    this.elements.poModal.querySelector('.modal-title').textContent = po ? `Edit PO #${po.po_number}` : 'Create Purchase Order';
    this.elements.poForm.reset();
    this.elements.poItemsContainer.innerHTML = '';
    if (po) {
        // Populate form for editing
    }
    this.elements.poModal.classList.add('is-open');
  },

  openVariantSearchModal() {
    this.renderVariantSearchResults();
    this.elements.variantSearchModal.classList.add('is-open');
  },

  renderVariantSearchResults() {
    const searchTerm = this.elements.variantSearchInput.value.toLowerCase();
    const filtered = this.state.allVariants.filter(v => v.name.toLowerCase().includes(searchTerm));
    this.elements.variantSearchResults.innerHTML = filtered.map(v => `
      <div class="variant-search-item">
        <input type="checkbox" id="variant-${v.id}" data-variant-id="${v.id}" data-variant-name="${App.escapeHtml(v.name)}">
        <label for="variant-${v.id}">${App.escapeHtml(v.name)}</label>
      </div>
    `).join('');
  },

  addSelectedVariantsToPO() {
    const selected = this.elements.variantSearchResults.querySelectorAll('input[type="checkbox"]:checked');
    selected.forEach(cb => {
      this.addPOItemRow({
        variant_id: cb.dataset.variantId,
        full_name: cb.dataset.variantName,
      });
    });
    this.elements.variantSearchModal.classList.remove('is-open');
  },

  addPOItemRow(item = {}) {
    const row = document.createElement('div');
    row.className = 'po-item-row';
    row.dataset.variantId = item.variant_id;
    row.innerHTML = `
      <span>${App.escapeHtml(item.full_name)}</span>
      <input type="number" name="quantity" placeholder="Qty" required min="1" value="${item.quantity || 1}">
      <input type="number" name="rate" placeholder="Rate" required min="0" step="0.01" value="${item.rate || 0}">
      <button type="button" class="button-icon remove-po-item">&times;</button>
    `;
    this.elements.poItemsContainer.appendChild(row);
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
    const itemRows = this.elements.poItemsContainer.querySelectorAll('.po-item-row');
    
    if (itemRows.length === 0) {
      App.showNotification("Please add at least one item to the purchase order.", "error");
      return;
    }
    
    // Validate and collect items
    let hasError = false;
    itemRows.forEach(row => {
      const variantId = row.dataset.variantId;
      const quantity = parseInt(row.querySelector('[name="quantity"]').value, 10);
      const rate = parseFloat(row.querySelector('[name="rate"]').value);
      
      if (!variantId || isNaN(quantity) || quantity <= 0 || isNaN(rate) || rate < 0) {
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
        this.elements.poModal.classList.remove('is-open');
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
    this.elements.receiveStockModal.classList.add('is-open');
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
          ${this.state.allVariants.map(v => `
            <option value="${v.id}">${App.escapeHtml(v.name || v.full_name)}</option>
          `).join('')}
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
        this.elements.receiveStockModal.classList.remove('is-open');
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

document.addEventListener("DOMContentLoaded", () => PurchaseOrders.init());
