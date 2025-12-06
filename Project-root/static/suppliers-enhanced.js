/**
 * Enhanced Suppliers Module
 * Integrates new APIResponseHandler, FormHandler, and PaginationHandler
 * for improved error handling, form validation, and pagination
 */

const SuppliersEnhanced = {
    state: {
        suppliers: [],
        currentSupplierId: null,
        ledger: { page: 1, per_page: 50, total: 0, items: [] },
    },
    handlers: {},

    /**
     * Initialize enhanced suppliers module
     */
    init() {
        if (!document.getElementById("suppliers-table-body")) return;

        console.log("[Suppliers] Enhanced module initializing...");

        // Initialize pagination handlers
        this.initializePagination();

        // Initialize modal handlers
        this.initializeModals();

        // Bind event listeners
        this.bindEventListeners();

        // Load initial data
        this.loadSuppliers();
    },

    /**
     * Initialize pagination controls
     */
    initializePagination() {
        this.handlers.ledgerPagination = new PaginationHandler(
            "ledger-table-body",
            "ledger-per-page",
            "ledger-page-info",
            "ledger-prev-page",
            "ledger-next-page"
        );

        this.handlers.ledgerPagination.onPageChange = () => this.loadLedgerData();
    },

    /**
     * Initialize modal handlers
     */
    initializeModals() {
        this.handlers.supplierModal = new ModalHandler("supplier-modal");
        this.handlers.ledgerModal = new ModalHandler("ledger-modal");
        this.handlers.ratesModal = new ModalHandler("rates-modal");
    },

    /**
     * Bind event listeners
     */
    bindEventListeners() {
        // Add supplier button
        document.getElementById("add-supplier-btn")?.addEventListener("click", () => {
            this.handlers.supplierModal.clearForm();
            this.handlers.supplierModal.open();
        });

        // Supplier form submission
        document.getElementById("supplier-form")?.addEventListener("submit", (e) => {
            e.preventDefault();
            this.handleSupplierSubmit();
        });

        // Tab navigation
        document.querySelectorAll(".tab-link").forEach((link) => {
            link.addEventListener("click", (e) => {
                const tabName = e.target.getAttribute("data-tab");
                this.switchTab(tabName);
            });
        });

        // Ledger search
        document.getElementById("ledger-search-btn")?.addEventListener("click", () => {
            this.handlers.ledgerPagination.state.page = 1;
            this.loadLedgerData();
        });

        document.getElementById("ledger-clear-btn")?.addEventListener("click", () => {
            document.getElementById("ledger-search-input").value = "";
            document.getElementById("ledger-search-type").value = "supplier";
            this.handlers.ledgerPagination.state.page = 1;
            this.loadLedgerData();
        });

        // Bulk delete
        document.getElementById("bulk-delete-btn-suppliers")?.addEventListener("click", () => {
            this.handleBulkDelete();
        });
    },

    /**
     * Load suppliers with error handling
     */
    async loadSuppliers() {
        const container = document.getElementById("suppliers-table-body");
        APIResponseHandler.showLoading(container, "Loading suppliers...");

        try {
            const response = await APIResponseHandler.request("/api/suppliers", {
                context: "Load Suppliers",
            });

            this.state.suppliers = response.data || [];
            this.renderSupplierTable();
            APIResponseHandler.hideLoading(container);
        } catch (error) {
            APIResponseHandler.showNotification(error, "error");
            console.error("[Suppliers] Load error:", error);
            container.innerHTML = '<tr><td colspan="5">Failed to load suppliers</td></tr>';
        }
    },

    /**
     * Render supplier table
     */
    renderSupplierTable() {
        const tbody = document.getElementById("suppliers-table-body");
        if (!tbody) return;

        if (!this.state.suppliers || this.state.suppliers.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;">No suppliers found</td></tr>';
            return;
        }

        tbody.innerHTML = this.state.suppliers
            .map(
                (supplier) => `
            <tr>
                <td><input type="checkbox" class="supplier-checkbox" value="${supplier.id}"></td>
                <td><strong>${this.escapeHtml(supplier.firm_name)}</strong></td>
                <td>${this.escapeHtml(supplier.address || "")}</td>
                <td>${this.escapeHtml(supplier.gstin || "")}</td>
                <td>
                    <button class="button secondary" onclick="SuppliersEnhanced.editSupplier(${supplier.id})">Edit</button>
                    <button class="button danger" onclick="SuppliersEnhanced.deleteSupplier(${supplier.id})">Delete</button>
                </td>
            </tr>
        `
            )
            .join("");
    },

    /**
     * Handle supplier form submission
     */
    async handleSupplierSubmit() {
        const form = document.getElementById("supplier-form");
        if (!FormHandler.validateRequired(form)) {
            APIResponseHandler.showNotification("Please fill all required fields", "warning");
            return;
        }

        const supplierId = document.getElementById("supplier-id").value;
        const method = supplierId ? "PUT" : "POST";
        const endpoint = supplierId ? `/api/suppliers/${supplierId}` : "/api/suppliers";

        const body = {
            firm_name: document.getElementById("firm-name").value,
            address: document.getElementById("address").value,
            gstin: document.getElementById("gstin").value,
            contacts: this.getContactsFromForm(),
            variants: this.getVariantsFromForm(),
        };

        try {
            const response = await APIResponseHandler.request(endpoint, {
                method,
                body,
                context: supplierId ? "Update Supplier" : "Add Supplier",
            });

            APIResponseHandler.showNotification(
                supplierId ? "Supplier updated successfully" : "Supplier added successfully",
                "success"
            );

            this.handlers.supplierModal.close();
            this.loadSuppliers();
        } catch (error) {
            APIResponseHandler.showNotification(error, "error");
        }
    },

    /**
     * Edit supplier
     */
    async editSupplier(id) {
        try {
            const response = await APIResponseHandler.request(`/api/suppliers/${id}`, {
                context: "Load Supplier",
            });

            const supplier = response.data;
            document.getElementById("supplier-id").value = supplier.id;
            document.getElementById("firm-name").value = supplier.firm_name;
            document.getElementById("address").value = supplier.address || "";
            document.getElementById("gstin").value = supplier.gstin || "";

            this.handlers.supplierModal.open();
        } catch (error) {
            APIResponseHandler.showNotification(error, "error");
        }
    },

    /**
     * Delete supplier
     */
    async deleteSupplier(id) {
        if (!confirm("Are you sure you want to delete this supplier?")) return;

        try {
            await APIResponseHandler.request(`/api/suppliers/${id}`, {
                method: "DELETE",
                context: "Delete Supplier",
            });

            APIResponseHandler.showNotification("Supplier deleted successfully", "success");
            this.loadSuppliers();
        } catch (error) {
            APIResponseHandler.showNotification(error, "error");
        }
    },

    /**
     * Load ledger data
     */
    async loadLedgerData() {
        const pagination = this.handlers.ledgerPagination;
        const searchType = document.getElementById("ledger-search-type")?.value || "supplier";
        const searchInput = document.getElementById("ledger-search-input")?.value || "";

        let endpoint = `/api/suppliers/ledger?page=${pagination.state.page}&per_page=${pagination.state.per_page}`;

        if (searchInput) {
            endpoint += `&${searchType}=${encodeURIComponent(searchInput)}`;
        }

        try {
            const response = await APIResponseHandler.request(endpoint, {
                context: "Load Ledger",
            });

            pagination.update(response.data, (items, container) => {
                container.innerHTML = items
                    .map(
                        (entry) => `
                    <tr>
                        <td>${new Date(entry.event_date).toLocaleDateString()}</td>
                        <td>${entry.supplier_id}</td>
                        <td>${entry.reference_number || ""}</td>
                        <td>${entry.variant_id || ""}</td>
                        <td>${entry.quantity || ""}</td>
                        <td>${entry.cost_per_unit || ""}</td>
                        <td>
                            <button class="button secondary">View</button>
                        </td>
                    </tr>
                `
                    )
                    .join("");
            });
        } catch (error) {
            APIResponseHandler.showNotification(error, "error");
            document.getElementById("ledger-table-body").innerHTML = '<tr><td colspan="7">Failed to load ledger</td></tr>';
        }
    },

    /**
     * Switch tabs
     */
    switchTab(tabName) {
        // Hide all tabs
        document.querySelectorAll(".tab-content").forEach((tab) => {
            tab.style.display = "none";
        });

        // Deactivate all tab links
        document.querySelectorAll(".tab-link").forEach((link) => {
            link.classList.remove("active");
        });

        // Show selected tab
        const tabElement = document.getElementById(tabName);
        if (tabElement) {
            tabElement.style.display = "block";
        }

        // Activate tab link
        document.querySelector(`[data-tab="${tabName}"]`)?.classList.add("active");

        // Load ledger data if switching to Ledger tab
        if (tabName === "Ledger") {
            this.loadLedgerData();
        }
    },

    /**
     * Get contacts from form
     */
    getContactsFromForm() {
        const contacts = [];
        document.querySelectorAll(".contact-field-group").forEach((group) => {
            const name = group.querySelector('input[name="contact_name"]')?.value;
            const phone = group.querySelector('input[name="contact_phone"]')?.value;
            const email = group.querySelector('input[name="contact_email"]')?.value;

            if (name) {
                contacts.push({ name, phone, email });
            }
        });
        return contacts;
    },

    /**
     * Get variants from form
     */
    getVariantsFromForm() {
        const variants = [];
        document.querySelectorAll(".variant-row").forEach((row) => {
            const variantId = row.querySelector('input[name="variant_id"]')?.value;
            const rate = row.querySelector('input[name="rate"]')?.value;

            if (variantId && rate) {
                variants.push({ variant_id: parseInt(variantId), rate: parseFloat(rate) });
            }
        });
        return variants;
    },

    /**
     * Handle bulk delete
     */
    async handleBulkDelete() {
        const selected = document.querySelectorAll(".supplier-checkbox:checked");
        if (!selected.length) {
            APIResponseHandler.showNotification("No suppliers selected", "warning");
            return;
        }

        if (!confirm(`Delete ${selected.length} supplier(s)?`)) return;

        const ids = Array.from(selected).map((cb) => cb.value);
        const errors = [];

        for (const id of ids) {
            try {
                await APIResponseHandler.request(`/api/suppliers/${id}`, {
                    method: "DELETE",
                    context: `Delete Supplier ${id}`,
                });
            } catch (error) {
                errors.push(`ID ${id}: ${error.message}`);
            }
        }

        if (errors.length) {
            APIResponseHandler.showNotification(`Some deletions failed: ${errors.join("; ")}`, "warning");
        } else {
            APIResponseHandler.showNotification("All suppliers deleted successfully", "success");
        }

        this.loadSuppliers();
    },

    /**
     * Escape HTML special characters
     */
    escapeHtml(text) {
        const div = document.createElement("div");
        div.textContent = text;
        return div.innerHTML;
    },
};

// Initialize when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
    SuppliersEnhanced.init();
});
