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

  async fetchPurchaseOrders() {
    const url = new URL(`${App.config.apiBase}/purchase-orders`);
    const params = {
      status: this.elements.poStatusFilter?.value,
      start_date: this.elements.poStartDateFilter?.value,
      end_date: this.elements.poEndDateFilter?.value,
    };
    Object.entries(params).forEach(([key, value]) => {
      if (value) url.searchParams.append(key, value);
    });
    
    const data = await App.fetchJson(url.toString());
    if (data) {
      this.state.purchaseOrders = data;
      this.renderPurchaseOrdersList();
    }
  },

  async fetchAllVariantsForSearch() {
    const data = await App.fetchJson(`${App.config.apiBase}/all-variants`);
    if (data) {
      this.state.allVariants = data;
    }
  },

  renderPurchaseOrdersList() {
    const tbody = this.elements.poTableBody;
    if (!tbody) return;
    tbody.innerHTML = this.state.purchaseOrders.map(po => `
      <tr data-po-id="${po.po_id}">
        <td>${App.escapeHtml(po.po_number)}</td>
        <td>${App.escapeHtml(po.firm_name)}</td>
        <td>${new Date(po.order_date).toLocaleDateString()}</td>
        <td>${po.total_amount.toFixed(2)}</td>
        <td><span class="status-badge ${po.status.toLowerCase().replace(' ', '-')}">${App.escapeHtml(po.status)}</span></td>
        <td class="actions-cell">
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

  async handlePOFormSubmit(e) {
    e.preventDefault();
    // Logic to gather data and submit PO
  },

  openReceiveStockModal(po = null) {
    this.elements.receiveStockModal.classList.add('is-open');
    // Pre-fill from PO if provided
  },

  addReceiveItemRow() {
    // Logic to add a row to the receive stock form
  },

  async handleReceiveStockFormSubmit(e) {
    e.preventDefault();
    // Logic to submit stock receipt
  },
};

document.addEventListener("DOMContentLoaded", () => PurchaseOrders.init());
