"use strict";

const Suppliers = {
  state: {
    suppliers: [],
    currentSupplierId: null,
    variantsList: [],
    ledger: { page: 1, per_page: 50, total: 0, items: [] },
  },
  elements: {},

  init() {
    if (!document.getElementById("suppliers-table-body")) return;
    console.log("Suppliers module initialized.");

    this.cacheDOMElements();
    this.bindEventListeners();
    this.fetchSuppliers();
  },

  cacheDOMElements() {
    this.elements.suppliersTableBody = document.getElementById("suppliers-table-body");
    this.elements.addSupplierBtn = document.getElementById("add-supplier-btn");
    this.elements.supplierModal = document.getElementById("supplier-modal");
    this.elements.supplierForm = document.getElementById("supplier-form");
    this.elements.contactsContainer = document.getElementById("contacts-container");
    this.elements.addContactBtn = document.getElementById("add-contact-btn");
    // Try to find variants container/button globally first, then within the modal as a fallback
    this.elements.variantsContainer = document.getElementById("variants-container") || this.elements.supplierModal?.querySelector('#variants-container') || null;
    this.elements.addVariantBtn = document.getElementById("add-variant-btn") || this.elements.supplierModal?.querySelector('#add-variant-btn') || null;
  },

  bindEventListeners() {
    this.elements.addSupplierBtn?.addEventListener("click", () => this.openSupplierModal());
    this.elements.supplierForm?.addEventListener("submit", (e) => this.handleSupplierFormSubmit(e));
    this.elements.addContactBtn?.addEventListener("click", () => this.addContactField());
    this.elements.contactsContainer?.addEventListener("click", (e) => {
      if (e.target.classList.contains("remove-contact-btn")) {
        e.target.closest(".contact-field-group").remove();
      }
    });
    this.elements.addVariantBtn?.addEventListener("click", () => this.addVariantRow());
    this.elements.variantsContainer?.addEventListener("click", (e) => {
      if (e.target.classList.contains("remove-variant-btn")) {
        e.target.closest(".variant-row").remove();
      }
    });
    // Delegated click handler on modal - covers dynamically created elements or missing cached nodes
    this.elements.supplierModal?.addEventListener('click', (e) => {
      const target = e.target;
      if (target && (target.id === 'add-variant-btn' || target.closest('#add-variant-btn'))) {
        this.addVariantRow();
        return;
      }

      if (target && target.classList && target.classList.contains('remove-variant-btn')) {
        const row = target.closest('.variant-row');
        if (row) row.remove();
        return;
      }

      if (target && target.classList && target.classList.contains('remove-contact-btn')) {
        const group = target.closest('.contact-field-group');
        if (group) group.remove();
        return;
      }
    });
    this.elements.suppliersTableBody?.addEventListener("click", (e) => this.handleSupplierActions(e));
    // Ledger search/filter controls (present if ledger tab is in the page)
    const ledgerSearchBtn = document.getElementById('ledger-search-btn');
    const ledgerClearBtn = document.getElementById('ledger-clear-btn');
    ledgerSearchBtn?.addEventListener('click', () => this.handleLedgerSearch());
    ledgerClearBtn?.addEventListener('click', () => this.clearLedgerSearch());
    // When Ledger tab is clicked, load recent ledger entries lazily
    // Prefer data-tab attribute instead of parsing inline onclick handlers (avoids ReferenceError if
    // legacy openTab() is not present). Fall back to textContent when data-tab missing.
    document.querySelectorAll('.tab-link').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tabName = (btn.dataset && btn.dataset.tab) || btn.getAttribute('data-tab') || btn.textContent?.trim();
        if (tabName === 'Ledger') {
          // fetch recent ledger entries if table is empty
          const tbody = document.getElementById('ledger-table-body');
          if (tbody && tbody.children.length === 0) {
            this.fetchLedger();
          }
        }
      });
    });
  },

  /**
   * Fetch list of available variants (products/variants) to populate selects
   */
  async fetchVariantsList() {
    // If already fetched, return immediately
    if (this.state.variantsList && this.state.variantsList.length > 0) return this.state.variantsList;

    try {
      // Use the existing all-variants endpoint used elsewhere in the app (purchaseOrders)
      // Fallback to /variants/select2 if server exposes that instead
      let variants = null;
      try {
        variants = await App.fetchJson(`${App.config.apiBase}/all-variants`);
      } catch (e) {
        // Try the select2 endpoint as a fallback
        try { variants = await App.fetchJson(`${App.config.apiBase}/variants/select2?q=&page=1&page_size=100`); } catch (e2) { throw e; }
      }
      if (variants && Array.isArray(variants)) {
        this.state.variantsList = variants;
      } else {
        // If backend returned paginated object { items: [...] }
        if (variants && variants.items && Array.isArray(variants.items)) {
          this.state.variantsList = variants.items;
        } else if (variants && variants.results && Array.isArray(variants.results)) {
          // Some select2 endpoints return { results: [...] }
          this.state.variantsList = variants.results;
        } else {
          this.state.variantsList = [];
        }
      }
    } catch (err) {
      console.error('Error fetching variants list:', err);
      this.state.variantsList = [];
    }

    return this.state.variantsList;
  },

  /**
   * Fetch variants supplied by a specific supplier and populate modal
   */
  async fetchAndPopulateVariants(supplierId) {
    // Clear container first
    if (this.elements.variantsContainer) this.elements.variantsContainer.innerHTML = "";

    try {
  const supplierVariants = await App.fetchJson(`${App.config.apiBase}/upf/supplier/${supplierId}/variants`);
      if (supplierVariants && Array.isArray(supplierVariants) && supplierVariants.length > 0) {
        supplierVariants.forEach(v => this.addVariantRow(v));
      } else {
        // Add an empty row if none
        this.addVariantRow();
      }
    } catch (err) {
      console.error('Error fetching supplier variants:', err);
      this.addVariantRow();
    }
  },

  /**
   * Fetches all suppliers from the backend
   * Handles loading and error states
   */
  async fetchSuppliers() {
    try {
      const suppliers = await App.fetchJson(`${App.config.apiBase}/suppliers`);
      if (suppliers && Array.isArray(suppliers)) {
        this.state.suppliers = suppliers;
        this.renderSuppliersList();
      } else {
        // Handle empty or invalid response
        this.state.suppliers = [];
        this.renderSuppliersList();
        if (!suppliers) {
          App.showNotification("Failed to load suppliers. Please try again.", "error");
        }
      }
    } catch (error) {
      console.error('Error fetching suppliers:', error);
      this.state.suppliers = [];
      this.renderSuppliersList();
      App.showNotification("Network error loading suppliers.", "error");
    }
  },

  /**
   * Renders the suppliers list in the table
   * Shows appropriate message when list is empty
   */
  renderSuppliersList() {
    if (!this.elements.suppliersTableBody) return;

    if (this.state.suppliers.length === 0) {
      this.elements.suppliersTableBody.innerHTML = `
        <tr>
          <td colspan="5" class="text-center p-8">
            No suppliers found. Click "Add New Supplier" to get started!
          </td>
        </tr>
      `;
      return;
    }

    this.elements.suppliersTableBody.innerHTML = this.state.suppliers.map(s => `
      <tr data-supplier-id="${s.supplier_id}">
        <td><input type="checkbox" class="supplier-checkbox" data-supplier-id="${s.supplier_id}"></td>
        <td>${App.escapeHtml(s.firm_name)}</td>
        <td>${App.escapeHtml(s.address || 'N/A')}</td>
        <td>${App.escapeHtml(s.gstin || 'N/A')}</td>
        <td class="actions-cell">
          <button class="button-icon view-contacts" title="View Contacts"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle></svg></button>
          <button class="button-icon edit-supplier" title="Edit Supplier"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></button>
          <button class="button-icon delete-supplier" title="Delete Supplier"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>
        </td>
      </tr>
    `).join("");
  },

  openSupplierModal(supplier = null) {
    this.state.currentSupplierId = supplier ? supplier.supplier_id : null;
    const modalTitle = this.elements.supplierModal?.querySelector(".modal-title");
    if (modalTitle) {
      modalTitle.textContent = supplier ? "Edit Supplier" : "Add New Supplier";
    } else {
      console.warn('Suppliers.openSupplierModal: modal title element not found');
    }

    // Reset form and contacts container if present
    this.elements.supplierForm?.reset();
    if (this.elements.contactsContainer) {
      this.elements.contactsContainer.innerHTML = "";
    } else {
      console.warn('Suppliers.openSupplierModal: contacts container not found');
    }

    // Reset variants container and ensure variants list is ready
    if (!this.elements.variantsContainer) {
      // Try to locate again inside modal
      this.elements.variantsContainer = this.elements.supplierModal?.querySelector('#variants-container') || null;
    }

    if (!this.elements.variantsContainer) {
      // If still not found, create the variants markup dynamically and append to the form
      if (this.elements.supplierForm) {
        const html = `
          <hr>
          <h4>Products / Variants Supplied</h4>
          <div class="form-field">
            <div class="table-wrapper">
              <table class="inventory-table compact">
                <thead>
                  <tr>
                    <th>Variant</th>
                    <th>Rate</th>
                    <th>Remarks</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody id="variants-container"></tbody>
              </table>
            </div>
            <button type="button" id="add-variant-btn" class="button">Add Variant</button>
          </div>
        `;
        // Append at the end of the form
        this.elements.supplierForm.insertAdjacentHTML('beforeend', html);
        // Re-cache the elements
        this.elements.variantsContainer = this.elements.supplierForm.querySelector('#variants-container');
        this.elements.addVariantBtn = this.elements.supplierForm.querySelector('#add-variant-btn');
        // Attach listeners
        this.elements.addVariantBtn?.addEventListener('click', () => this.addVariantRow());
        this.elements.variantsContainer?.addEventListener('click', (e) => {
          if (e.target.classList.contains('remove-variant-btn')) e.target.closest('.variant-row').remove();
        });
      } else {
        console.warn('Suppliers.openSupplierModal: variants container not found and supplier form unavailable to create it');
      }
    } else {
      // Clear existing
      this.elements.variantsContainer.innerHTML = '';
    }

    // Ensure we have variants list and populate variant rows appropriately
    this.fetchVariantsList().then(() => {
      if (supplier) {
        this.fetchAndPopulateVariants(supplier.supplier_id);
      } else {
        this.addVariantRow();
      }
    }).catch(err => {
      console.warn('Suppliers.openSupplierModal: could not fetch variants list', err);
      // still add an empty row as fallback
      this.addVariantRow();
    });

    if (supplier) {
      const firmInput = this.elements.supplierForm?.querySelector('[name="firm_name"]');
      if (firmInput) firmInput.value = supplier.firm_name;

      const addressInput = this.elements.supplierForm?.querySelector('[name="address"]');
      if (addressInput) addressInput.value = supplier.address || "";

      const gstinInput = this.elements.supplierForm?.querySelector('[name="gstin"]');
      if (gstinInput) gstinInput.value = supplier.gstin || "";

      // Fetch and populate contacts (addContactField is defensive)
      this.fetchAndPopulateContacts(supplier.supplier_id);
    } else {
      this.addContactField(); // Add one empty contact field for new suppliers
    }

    if (this.elements.supplierModal) {
      try {
        if (typeof Modal !== 'undefined' && Modal.open) {
          Modal.open(this.elements.supplierModal);
        } else {
          this.elements.supplierModal.classList.add("is-open");
        }
      } catch (e) {
        // Fallback toggle class if Modal API misbehaves
        try { this.elements.supplierModal.classList.add("is-open"); } catch (err) {}
      }
    } else {
      console.warn('Suppliers.openSupplierModal: supplier modal element not found');
    }
  },

  /**
   * Fetches and populates contacts for a supplier in the modal form
   * @param {string|number} supplierId - The supplier ID
   */
  async fetchAndPopulateContacts(supplierId) {
    try {
      const contacts = await App.fetchJson(`${App.config.apiBase}/suppliers/${supplierId}/contacts`);
      if (contacts && Array.isArray(contacts)) {
        if (contacts.length > 0) {
          contacts.forEach(contact => this.addContactField(contact));
        } else {
          // Add one empty contact field if no contacts exist
          this.addContactField();
        }
      } else {
        // Fallback: add empty field on error
        this.addContactField();
      }
    } catch (error) {
      console.error('Error fetching supplier contacts:', error);
      this.addContactField(); // Add empty field as fallback
    }
  },

  addContactField(contact = {}) {
    if (!this.elements.contactsContainer) {
      console.warn('Suppliers.addContactField: contacts container not found; cannot add contact field');
      return;
    }

    const fieldGroup = document.createElement("div");
    fieldGroup.className = "contact-field-group";
    fieldGroup.innerHTML = `
      <input type="text" name="contact_name" placeholder="Contact Name" value="${App.escapeHtml(contact.contact_name || '')}">
      <input type="text" name="contact_phone" placeholder="Phone" value="${App.escapeHtml(contact.contact_phone || '')}">
      <input type="email" name="contact_email" placeholder="Email" value="${App.escapeHtml(contact.contact_email || '')}">
      <button type="button" class="button-icon remove-contact-btn" title="Remove Contact">&times;</button>
    `;
    this.elements.contactsContainer.appendChild(fieldGroup);
  },

  /**
   * Add a variant/product row to the variants table inside the modal
   * variant param may be { variant_id, rate, remarks } or empty
   */
  addVariantRow(variant = {}) {
    if (!this.elements.variantsContainer) {
      console.warn('Suppliers.addVariantRow: variants container not found; cannot add variant row');
      return;
    }

    const tr = document.createElement('tr');
    tr.className = 'variant-row';

    // Build variant select (if variantsList available) or fallback to text input
    let variantFieldHtml = '';
    if (this.state.variantsList && this.state.variantsList.length > 0) {
      variantFieldHtml = `<select class="variant-select">
        <option value="">-- Select Variant --</option>
        ${this.state.variantsList.map(v => {
          const id = v.variant_id ?? v.id ?? v.variantId ?? v.value;
          const label = App.escapeHtml(v.name || v.label || (`Variant ${id}`));
          const selected = (variant.variant_id && String(variant.variant_id) === String(id)) ? 'selected' : '';
          return `<option value="${id}" ${selected}>${label}</option>`;
        }).join('')}
      </select>`;
    } else {
      // fallback to free text
      variantFieldHtml = `<input type="text" class="variant-name" placeholder="Variant name" value="${App.escapeHtml(variant.name || '')}">`;
    }

    const rateVal = variant.rate ?? variant.supply_rate ?? '';
    const remarksVal = variant.remarks ?? variant.note ?? '';

    tr.innerHTML = `
      <td>${variantFieldHtml}</td>
      <td><input type="number" step="0.01" class="variant-rate" value="${App.escapeHtml(rateVal)}"></td>
      <td><input type="text" class="variant-remarks" value="${App.escapeHtml(remarksVal)}"></td>
      <td><button type="button" class="button-icon remove-variant-btn" title="Remove">&times;</button></td>
    `;

    this.elements.variantsContainer.appendChild(tr);
  },

  async handleSupplierFormSubmit(e) {
    e.preventDefault();
    if (!this.elements.supplierForm) {
      console.error('Suppliers.handleSupplierFormSubmit: supplier form not found');
      return;
    }

    const formData = new FormData(e.target);
    const data = {
      firm_name: formData.get("firm_name"),
      address: formData.get("address"),
      gstin: formData.get("gstin"),
      contacts: [],
      variants: [],
    };

    if (this.elements.contactsContainer) {
      this.elements.contactsContainer.querySelectorAll(".contact-field-group").forEach(group => {
        const nameEl = group.querySelector('[name="contact_name"]');
        const phoneEl = group.querySelector('[name="contact_phone"]');
        const emailEl = group.querySelector('[name="contact_email"]');
        data.contacts.push({
          name: nameEl ? nameEl.value : "",
          phone: phoneEl ? phoneEl.value : "",
          email: emailEl ? emailEl.value : "",
        });
      });
    }

    // Collect variant rows (variant id/name, rate, remarks)
    if (this.elements.variantsContainer) {
      this.elements.variantsContainer.querySelectorAll('.variant-row').forEach(row => {
        const select = row.querySelector('.variant-select');
        const nameInput = row.querySelector('.variant-name');
        const rateInput = row.querySelector('.variant-rate');
        const remarksInput = row.querySelector('.variant-remarks');

        const variantId = select ? select.value : (nameInput ? nameInput.value : '');
        const rateVal = rateInput ? rateInput.value : '';
        const remarksVal = remarksInput ? remarksInput.value : '';

        if (variantId || rateVal || remarksVal) {
          data.variants.push({
            variant_id: variantId,
            rate: rateVal,
            remarks: remarksVal,
          });
        }
      });
    }

    const url = this.state.currentSupplierId
      ? `${App.config.apiBase}/suppliers/${this.state.currentSupplierId}`
      : `${App.config.apiBase}/suppliers`;
    const method = this.state.currentSupplierId ? "PUT" : "POST";

    const result = await App.fetchJson(url, {
      method,
      body: JSON.stringify(data),
    });

    if (result) {
      try { Modal.close(this.elements.supplierModal); } catch (e) { this.elements.supplierModal.classList.remove("is-open"); }
      this.fetchSuppliers(); // Refresh the list
      App.showNotification(`Supplier ${this.state.currentSupplierId ? 'updated' : 'added'} successfully.`, "success");
    }
  },

  handleSupplierActions(e) {
    const button = e.target.closest("button");
    if (!button) return;

    const row = button.closest("tr");
    const supplierId = row.dataset.supplierId;
    const supplier = this.state.suppliers.find(s => s.supplier_id == supplierId);

    if (button.classList.contains("edit-supplier")) {
      this.openSupplierModal(supplier);
    } else if (button.classList.contains("delete-supplier")) {
      this.deleteSupplier(supplierId, supplier.firm_name);
    } else if (button.classList.contains("view-contacts")) {
      // Could open a read-only modal with contacts, rates, ledger etc.
      // For now, we'll just log it.
      console.log("Viewing details for", supplier.firm_name);
    }
  },

  async deleteSupplier(supplierId, firmName) {
    if (!confirm(`Are you sure you want to delete supplier "${firmName}"?`)) return;

    const result = await App.fetchJson(`${App.config.apiBase}/suppliers/${supplierId}`, {
      method: "DELETE",
    });

    if (result) {
      this.fetchSuppliers();
      App.showNotification("Supplier deleted successfully.", "success");
    }
  },
};

// --- Ledger support: fetch and render ledger entries ---
Suppliers.fetchLedger = async function ({ type = '', q = '' } = {}) {
  const params = new URLSearchParams();
  if (type) params.append("type", type);
  if (q) params.append("q", q);
  // include pagination params so server-side endpoints can paginate results
  params.append('page', Suppliers.state.ledger.page || 1);
  params.append('per_page', Suppliers.state.ledger.per_page || 50);

  // Prefer server-side endpoints that are already implemented and efficient:
  // - For supplier lookups by id: /api/suppliers/<id>/ledger
  // - For variant lookups by id: /api/variant-ledger?variant_id=<id>
    try {
    if (type === 'supplier' && q) {
      // If q is a numeric id, call supplier ledger directly (support pagination)
      const maybeId = parseInt(q, 10);
      if (!isNaN(maybeId)) {
        const sParams = new URLSearchParams();
        sParams.set('page', this.state.ledger.page || 1);
        sParams.set('per_page', this.state.ledger.per_page || 50);
        const sUrl = `${App.config.apiBase}/suppliers/${maybeId}/ledger?${sParams.toString()}`;
        const data = await App.fetchJson(sUrl);
        if (data) {
          // Accept either paginated { items, total, page, per_page } or plain array
          if (Array.isArray(data)) return this.renderLedger(data);
          return this.renderLedger(data);
        }
      }
      // else fallthrough to stock-receipts search by supplier name
    }

    if (type === 'variant' && q) {
      const maybeId = parseInt(q, 10);
      if (!isNaN(maybeId)) {
        const vParams = new URLSearchParams();
        vParams.set('variant_id', maybeId);
        vParams.set('page', this.state.ledger.page || 1);
        vParams.set('per_page', this.state.ledger.per_page || 50);
        const vUrl = `${App.config.apiBase}/variant-ledger?${vParams.toString()}`;
        const data = await App.fetchJson(vUrl);
        if (data) return this.renderLedger(data);
      }
      // else fallthrough to stock-receipts search by text
    }
  } catch (err) {
    console.debug('Preferred ledger endpoints not available or returned error; falling back:', err?.message || err);
  }

  // Fallback: expand stock receipts into ledger rows (server supports filtering; we will pass query if provided)
  try {
    const receiptsUrl = `${App.config.apiBase}/stock-receipts${params.toString() ? `?${params.toString()}` : ''}`;
    const receipts = await App.fetchJson(receiptsUrl);
    if (!receipts || !Array.isArray(receipts) || receipts.length === 0) return this.renderLedger([]);

    // Limit expansion to avoid large loads when no query provided
    const receiptsToExpand = q ? receipts : receipts.slice(0, 50);
    const detailPromises = receiptsToExpand.map(r => App.fetchJson(`${App.config.apiBase}/stock-receipts/${r.receipt_id}`).then(items => ({ receipt: r, items })).catch(() => ({ receipt: r, items: [] })));
    const detailed = await Promise.all(detailPromises);

    const ledgerRows = [];
    detailed.forEach(({ receipt, items }) => {
      if (!items || !Array.isArray(items)) return;
      items.forEach(it => {
        ledgerRows.push({
          date: receipt.receipt_date || receipt.receipt_date || receipt.receipt_date,
          supplier_name: receipt.firm_name || receipt.supplier_name || receipt.supplier || '',
          bill_number: receipt.bill_number || receipt.bill_no || receipt.bill || '',
          item_name: it.item_name || it.name || it.variant_name || '',
          qty: it.quantity_added ?? it.quantity ?? it.qty ?? '',
          cost_per_unit: it.cost_per_unit ?? it.cost ?? it.rate ?? '',
        });
      });
    });

    // if server-side filtering isn't available, apply simple client-side filter
    let filtered = ledgerRows;
    if (q) {
      const qLower = String(q).toLowerCase();
      if (type === 'supplier')
        filtered = ledgerRows.filter((r) => String(r.supplier_name || '').toLowerCase().includes(qLower));
      else if (type === 'variant' || type === 'item')
        filtered = ledgerRows.filter((r) => String(r.item_name || '').toLowerCase().includes(qLower));
      else
        filtered = ledgerRows.filter(
          (r) =>
            String(r.supplier_name || '').toLowerCase().includes(qLower) ||
            String(r.item_name || '').toLowerCase().includes(qLower)
        );
    }

    return this.renderLedger(filtered);
  } catch (err) {
    console.error('Error expanding stock receipts for ledger', err);
    return this.renderLedger([]);
  }
};

/**
 * Fetch and display details for a single ledger row (receipt or purchase order)
 * Opens the #ledger-modal and populates #ledger-modal-table-body with the items
 */
Suppliers.showLedgerRowDetails = async function(eventType, eventId) {
  if (!eventType || !eventId) return;
  const modal = document.getElementById('ledger-modal');
  const modalBodyTbody = document.getElementById('ledger-modal-table-body');
  if (!modal || !modalBodyTbody) return;

  try {
    let url = '';
    if (String(eventType).toLowerCase() === 'receipt' || String(eventType).toLowerCase() === 'stock_receipt') {
      url = `${App.config.apiBase}/stock-receipts/${encodeURIComponent(eventId)}`;
    } else if (String(eventType).toLowerCase() === 'po' || String(eventType).toLowerCase() === 'purchase_order' || String(eventType).toLowerCase() === 'purchaseorder') {
      url = `${App.config.apiBase}/purchase-orders/${encodeURIComponent(eventId)}`;
    } else {
      // unknown type: try receipt first then po
      url = `${App.config.apiBase}/stock-receipts/${encodeURIComponent(eventId)}`;
    }

    const data = await App.fetchJson(url);
    // Normalize items array: different endpoints return different shapes
    let items = [];
    if (Array.isArray(data)) items = data;
    else if (data && Array.isArray(data.items)) items = data.items;
    else if (data && Array.isArray(data.receipt_items)) items = data.receipt_items;
    else if (data && Array.isArray(data.purchase_order_items)) items = data.purchase_order_items;

    if (!items || items.length === 0) {
      modalBodyTbody.innerHTML = `<tr><td colspan="4" class="text-center p-8">No details available.</td></tr>`;
    } else {
      modalBodyTbody.innerHTML = items.map(it => {
        const date = App.escapeHtml(data.receipt_date || data.order_date || data.date || '');
        const item = App.escapeHtml(it.item_name || it.name || it.variant_name || it.sku || '');
        const qty = App.escapeHtml(it.quantity_added ?? it.quantity ?? it.qty ?? it.ordered_quantity ?? '');
        const cost = App.escapeHtml(it.cost_per_unit ?? it.cost ?? it.rate ?? it.unit_price ?? '');
        return `\n          <tr>\n            <td>${date}</td>\n            <td>${item}</td>\n            <td>${qty}</td>\n            <td>${cost}</td>\n          </tr>\n        `;
      }).join('');
    }

    // Open modal (use Modal helper if available)
    try { if (typeof Modal !== 'undefined' && Modal.open) Modal.open(modal); else modal.classList.add('is-open'); } catch (e) { modal.classList.add('is-open'); }
  } catch (err) {
    console.error('Failed to fetch ledger row details', err);
    modalBodyTbody.innerHTML = `<tr><td colspan="4" class="text-center p-8">Failed to load details.</td></tr>`;
    try { if (typeof Modal !== 'undefined' && Modal.open) Modal.open(modal); else modal.classList.add('is-open'); } catch (e) { modal.classList.add('is-open'); }
  }
};

Suppliers.renderLedger = function(entriesOrResponse = []) {
  // entriesOrResponse may be either:
  // - an array of ledger entry objects
  // - a paginated response object: { items: [...], total, page, per_page }
  let entries = [];
  if (Array.isArray(entriesOrResponse)) entries = entriesOrResponse;
  else if (entriesOrResponse && Array.isArray(entriesOrResponse.items)) entries = entriesOrResponse.items;
  else entries = [];

  // Update pagination state when provided
  if (entriesOrResponse && typeof entriesOrResponse === 'object') {
    if (typeof entriesOrResponse.total === 'number') Suppliers.state.ledger.total = entriesOrResponse.total;
    if (typeof entriesOrResponse.page === 'number') Suppliers.state.ledger.page = entriesOrResponse.page;
    if (typeof entriesOrResponse.per_page === 'number') Suppliers.state.ledger.per_page = entriesOrResponse.per_page;
  }

  // Update page info UI
  const pageInfo = document.getElementById('ledger-page-info');
  if (pageInfo) {
    const pg = Suppliers.state.ledger.page || 1;
    const per = Suppliers.state.ledger.per_page || 50;
    const tot = Suppliers.state.ledger.total || (Array.isArray(entries) ? entries.length : 0);
    const maxPage = Math.max(1, Math.ceil(tot / per));
    pageInfo.textContent = `Page ${pg} of ${maxPage} (${tot} items)`;
  }

  const tbody = document.getElementById('ledger-table-body');
  const modalTbody = document.getElementById('ledger-modal-table-body');
  if (!tbody && !modalTbody) return;

  const renderInto = (node, arr) => {
    if (!node) return;
    if (!arr || arr.length === 0) {
      node.innerHTML = `\n        <tr><td colspan="7" class="text-center p-8">No ledger entries found.</td></tr>\n      `;
      return;
    }
    node.innerHTML = arr.map(e => {
      const date = App.escapeHtml(e.date || e.recorded_at || '');
      const supplier = App.escapeHtml(e.supplier_name || e.firm_name || '');
      const bill = App.escapeHtml(e.bill_number || e.invoice_no || '');
      const item = App.escapeHtml(e.item_name || e.variant_name || '');
      const qty = App.escapeHtml(e.qty ?? e.quantity ?? e.quantity_added ?? '');
      const cost = App.escapeHtml(e.cost_per_unit ?? e.cost ?? e.rate ?? '');

      // attempt to derive an event id/type for the 'View' action. The ledger view/backends often
      // provide receipt_id or po_id or event_type/event_id. We support common variants.
      const eventId = e.receipt_id || e.entry_id || e.event_id || e.po_id || e.purchase_order_id || '';
      const eventType = e.event_type || (e.po_id || e.purchase_order_id ? 'po' : (e.receipt_id || e.entry_id ? 'receipt' : ''));

      const viewBtn = eventId ? `<button type="button" class="button small ledger-view-btn" data-event-type="${App.escapeHtml(eventType)}" data-event-id="${App.escapeHtml(String(eventId))}">View</button>` : '';

      return `\n        <tr data-event-type="${App.escapeHtml(eventType)}" data-event-id="${App.escapeHtml(String(eventId))}">\n          <td>${date}</td>\n          <td>${supplier}</td>\n          <td>${bill}</td>\n          <td>${item}</td>\n          <td>${qty}</td>\n          <td>${cost}</td>\n          <td>${viewBtn}</td>\n        </tr>\n      `;
    }).join('');
  };

  renderInto(tbody, entries);
  // Modal view may show condensed columns; reuse same data but render subset
  if (modalTbody) {
    modalTbody.innerHTML = entries.map(e => {
      const date = App.escapeHtml(e.date || e.recorded_at || '');
      const item = App.escapeHtml(e.item_name || e.variant_name || '');
      const qty = App.escapeHtml(e.qty ?? e.quantity ?? e.quantity_added ?? '');
      const cost = App.escapeHtml(e.cost_per_unit ?? e.cost ?? e.rate ?? '');
      return `\n        <tr>\n          <td>${date}</td>\n          <td>${item}</td>\n          <td>${qty}</td>\n          <td>${cost}</td>\n        </tr>\n      `;
    }).join('');
  }
};

Suppliers.handleLedgerSearch = function() {
  const type = (document.getElementById('ledger-search-type')?.value) || '';
  const q = (document.getElementById('ledger-search-input')?.value || '').trim();
  this.fetchLedger({ type, q });
};

Suppliers.clearLedgerSearch = function() {
  const input = document.getElementById('ledger-search-input');
  if (input) input.value = '';
  this.fetchLedger();
};

// ensure listeners for ledger search buttons are present
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('ledger-search-btn')?.addEventListener('click', () => Suppliers.handleLedgerSearch());
  document.getElementById('ledger-clear-btn')?.addEventListener('click', () => Suppliers.clearLedgerSearch());
  // lazy-load ledger when opening the Ledger tab
  document.querySelectorAll('.tab-link[data-tab="Ledger"]').forEach(btn => {
      btn.addEventListener('click', () => {
      const tbody = document.getElementById('ledger-table-body');
      if (tbody && tbody.children.length === 0) Suppliers.fetchLedger();
    });
  });
});


// Handle pagination UI events
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('ledger-prev-page')?.addEventListener('click', () => {
    if (Suppliers.state.ledger.page > 1) {
      Suppliers.state.ledger.page -= 1;
      Suppliers.fetchLedger();
    }
  });
  document.getElementById('ledger-next-page')?.addEventListener('click', () => {
    const total = Suppliers.state.ledger.total || 0;
    const per = Suppliers.state.ledger.per_page || 50;
    const maxPage = Math.max(1, Math.ceil(total / per));
    if (Suppliers.state.ledger.page < maxPage) {
      Suppliers.state.ledger.page += 1;
      Suppliers.fetchLedger();
    }
  });
  document.getElementById('ledger-per-page')?.addEventListener('change', (e) => {
    Suppliers.state.ledger.per_page = parseInt(e.target.value, 10) || 50;
    Suppliers.state.ledger.page = 1;
    Suppliers.fetchLedger();
  });
  // Delegated handler for per-row ledger View buttons
  document.getElementById('ledger-table-body')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.ledger-view-btn');
    if (!btn) return;
    const eventType = btn.dataset.eventType || btn.getAttribute('data-event-type') || btn.parentElement?.closest('tr')?.dataset?.eventType;
    const eventId = btn.dataset.eventId || btn.getAttribute('data-event-id') || btn.parentElement?.closest('tr')?.dataset?.eventId;
    if (eventId) Suppliers.showLedgerRowDetails(eventType, eventId);
  });
});
