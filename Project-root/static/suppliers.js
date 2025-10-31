"use strict";

const Suppliers = {
  state: {
    suppliers: [],
    currentSupplierId: null,
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
    this.elements.suppliersTableBody?.addEventListener("click", (e) => this.handleSupplierActions(e));
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
    const modalTitle = this.elements.supplierModal.querySelector(".modal-title");
    modalTitle.textContent = supplier ? "Edit Supplier" : "Add New Supplier";
    
    this.elements.supplierForm.reset();
    this.elements.contactsContainer.innerHTML = "";

    if (supplier) {
      this.elements.supplierForm.querySelector('[name="firm_name"]').value = supplier.firm_name;
      this.elements.supplierForm.querySelector('[name="address"]').value = supplier.address || "";
      this.elements.supplierForm.querySelector('[name="gstin"]').value = supplier.gstin || "";
      // Fetch and populate contacts
      this.fetchAndPopulateContacts(supplier.supplier_id);
    } else {
      this.addContactField(); // Add one empty contact field for new suppliers
    }

    this.elements.supplierModal.classList.add("is-open");
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

  async handleSupplierFormSubmit(e) {
    e.preventDefault();
    const formData = new FormData(e.target);
    const data = {
      firm_name: formData.get("firm_name"),
      address: formData.get("address"),
      gstin: formData.get("gstin"),
      contacts: [],
    };

    this.elements.contactsContainer.querySelectorAll(".contact-field-group").forEach(group => {
      data.contacts.push({
        name: group.querySelector('[name="contact_name"]').value,
        phone: group.querySelector('[name="contact_phone"]').value,
        email: group.querySelector('[name="contact_email"]').value,
      });
    });

    const url = this.state.currentSupplierId
      ? `${App.config.apiBase}/suppliers/${this.state.currentSupplierId}`
      : `${App.config.apiBase}/suppliers`;
    const method = this.state.currentSupplierId ? "PUT" : "POST";

    const result = await App.fetchJson(url, {
      method,
      body: JSON.stringify(data),
    });

    if (result) {
      this.elements.supplierModal.classList.remove("is-open");
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

document.addEventListener("DOMContentLoaded", () => Suppliers.init());
