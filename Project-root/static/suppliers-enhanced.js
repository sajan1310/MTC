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

        // Override clearForm to also clear dynamic rows
        const originalClearForm = this.handlers.supplierModal.clearForm.bind(this.handlers.supplierModal);
        this.handlers.supplierModal.clearForm = () => {
            originalClearForm();
            this.clearDynamicRows();
        };
    },

    /**
     * Clear dynamically added contact and variant rows
     */
    clearDynamicRows() {
        // Clear contacts
        const contactsContainer = document.getElementById("contacts-container");
        if (contactsContainer) {
            contactsContainer.innerHTML = "";
        }

        // Clear variants and destroy Select2 instances
        const variantsContainer = document.getElementById("variants-container");
        if (variantsContainer) {
            // Destroy Select2 instances before clearing
            if (typeof $ !== "undefined" && $.fn.select2) {
                variantsContainer.querySelectorAll(".variant-select").forEach((select) => {
                    try {
                        $(select).select2("destroy");
                    } catch (e) {
                        // Ignore errors if Select2 wasn't initialized
                    }
                });
            }
            variantsContainer.innerHTML = "";
        }
    },

    /**
     * Bind event listeners
     */
    bindEventListeners() {
        // Add supplier button
        document.getElementById("add-supplier-btn")?.addEventListener("click", () => {
            this.handlers.supplierModal.clearForm();
            // Start with one empty contact and variant row for convenience
            this.addContactRow();
            this.addVariantRow();
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

        // Add Contact button
        document.getElementById("add-contact-btn")?.addEventListener("click", () => {
            this.addContactRow();
        });

        // Remove Contact (delegated)
        document.getElementById("contacts-container")?.addEventListener("click", (e) => {
            if (e.target.closest(".remove-contact-btn")) {
                e.preventDefault();
                e.target.closest(".contact-field-group")?.remove();
            }
        });

        // Add Variant button
        document.getElementById("add-variant-btn")?.addEventListener("click", () => {
            this.addVariantRow();
        });

        // Remove Variant (delegated)
        document.getElementById("variants-container")?.addEventListener("click", (e) => {
            if (e.target.closest(".remove-variant-btn")) {
                e.preventDefault();
                e.target.closest(".variant-row")?.remove();
            }
        });

        // Ledger row actions (view button)
        document.getElementById("ledger-table-body")?.addEventListener("click", (e) => {
            const btn = e.target.closest("button[data-ledger-index]");
            if (!btn) return;
            const idx = parseInt(btn.getAttribute("data-ledger-index"), 10);
            this.openLedgerModal(idx);
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
            .map((supplier) => {
                const supplierId = supplier.id || supplier.supplier_id;
                return `
            <tr>
                <td><input type="checkbox" class="supplier-checkbox" value="${supplierId}"></td>
                <td><strong>${this.escapeHtml(supplier.firm_name)}</strong></td>
                <td>${this.escapeHtml(supplier.address || "")}</td>
                <td>${this.escapeHtml(supplier.gstin || "")}</td>
                <td>
                    <button class="button secondary" onclick="SuppliersEnhanced.editSupplier(${supplierId})">Edit</button>
                    <button class="button danger" onclick="SuppliersEnhanced.deleteSupplier(${supplierId})">Delete</button>
                </td>
            </tr>
        `;
            })
            .join("");

        // Set a default current supplier for ledger loading if not already set
        if (!this.state.currentSupplierId && this.state.suppliers.length > 0) {
            this.state.currentSupplierId = this.state.suppliers[0].id || this.state.suppliers[0].supplier_id;
        }
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
        // No GET endpoint for a single supplier; use cached list
        const supplier = this.state.suppliers.find((s) => (s.id || s.supplier_id) === id);
        if (!supplier) {
            APIResponseHandler.showNotification("Supplier not found in current list", "warning");
            return;
        }

        // Reset dynamic rows before populating
        this.clearDynamicRows();

        document.getElementById("supplier-id").value = supplier.id || supplier.supplier_id || "";
        document.getElementById("firm-name").value = supplier.firm_name || "";
        document.getElementById("address").value = supplier.address || "";
        document.getElementById("gstin").value = supplier.gstin || "";

        // Seed one variant row ready for selection (existing variants not loaded individually)
        this.addVariantRow();

        this.handlers.supplierModal.open();
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

        // Require a supplier context for ledger endpoint
        const supplierId = this.state.currentSupplierId;
        if (!supplierId) {
            const body = document.getElementById("ledger-table-body");
            if (body) body.innerHTML = '<tr><td colspan="7">Select a supplier to view ledger</td></tr>';
            return;
        }

        let endpoint = `/api/suppliers/${supplierId}/ledger?page=${pagination.state.page}&per_page=${pagination.state.per_page}`;

        if (searchInput) {
            endpoint += `&${searchType}=${encodeURIComponent(searchInput)}`;
        }

        try {
            const response = await APIResponseHandler.request(endpoint, {
                context: "Load Ledger",
            });

            // Persist items for modal view
            this.state.ledger.items = response.data.items || [];

            pagination.update(response.data, (items, container) => {
                container.innerHTML = items
                    .map(
                        (entry, idx) => `
                    <tr>
                        <td>${new Date(entry.event_date).toLocaleDateString()}</td>
                        <td>${entry.supplier_id}</td>
                        <td>${entry.reference_number || ""}</td>
                        <td>${entry.variant_id || ""}</td>
                        <td>${entry.quantity || ""}</td>
                        <td>${entry.cost_per_unit || ""}</td>
                        <td>
                            <button class="button secondary" data-ledger-index="${idx}">View</button>
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
     * Open ledger modal for a specific entry
     */
    openLedgerModal(index) {
        const entry = this.state.ledger.items?.[index];
        if (!entry) return;

        const body = document.getElementById("ledger-modal-table-body");
        if (body) {
            body.innerHTML = `
                <tr>
                    <td>${new Date(entry.event_date).toLocaleString()}</td>
                    <td>${entry.reference_number || ""}</td>
                    <td>${entry.variant_id || ""}</td>
                    <td>${entry.quantity || ""}</td>
                    <td>${entry.cost_per_unit || ""}</td>
                </tr>
            `;
        }

        this.handlers.ledgerModal?.open();
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
     * Get variants from form (works with Select2 select elements)
     */
    getVariantsFromForm() {
        const variants = [];
        document.querySelectorAll(".variant-row").forEach((row) => {
            const variantSelect = row.querySelector('select[name="variant_id"]');
            const variantId = variantSelect?.value;
            const rate = row.querySelector('input[name="rate"]')?.value;
            const remarks = row.querySelector('input[name="variant_remarks"]')?.value;

            if (variantId && rate) {
                variants.push({
                    variant_id: parseInt(variantId, 10),
                    rate: parseFloat(rate),
                    remarks: remarks || undefined,
                });
            }
        });
        return variants;
    },

    /**
     * Add a variant row to the form with Select2 searchable dropdown
     */
    addVariantRow() {
        const container = document.getElementById("variants-container");
        if (!container) return;

        const row = document.createElement("tr");
        row.className = "variant-row";
        const uniqueId = `variant-select-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        row.innerHTML = `
            <td>
                <select class="variant-select" name="variant_id" id="${uniqueId}" required style="width:100%">
                    <option value="">-- Search Variant --</option>
                </select>
            </td>
            <td>
                <input type="number" step="0.01" name="rate" placeholder="Rate" required style="width:100%" />
            </td>
            <td>
                <input type="text" name="variant_remarks" placeholder="Remarks" style="width:100%" />
            </td>
            <td>
                <button class="button danger remove-variant-btn" type="button">Remove</button>
            </td>
        `;

        container.appendChild(row);

        // Initialize Select2 on the new select element after DOM insertion
        setTimeout(() => {
            this.initializeVariantSelect(`#${uniqueId}`);
        }, 0);
    },

    /**
     * Initialize Select2 for variant dropdown
     */
    initializeVariantSelect(selector) {
        if (typeof $ === "undefined" || !$.fn.select2) {
            console.warn("[Suppliers] Select2 not available, falling back to standard select");
            return;
        }

        const $element = $(selector);
        if ($element.length === 0) {
            console.warn("[Suppliers] Element not found for selector:", selector);
            return;
        }

        // Destroy existing Select2 if already initialized
        if ($element.hasClass("select2-hidden-accessible")) {
            try {
                $element.select2("destroy");
            } catch (e) {
                console.warn("[Suppliers] Error destroying existing Select2:", e);
            }
        }

        try {
            console.log("[Suppliers] Initializing Select2 for:", selector);
            $element.select2({
                ajax: {
                    url: "/api/variants/select2",
                    dataType: "json",
                    delay: 250,
                    data: function (params) {
                        return {
                            q: params.term || "",
                            page: params.page || 1,
                            page_size: 30,
                        };
                    },
                    processResults: function (data) {
                        // Guard against HTML responses (e.g., auth redirect)
                        if (!data || typeof data !== "object") {
                            console.warn("[Suppliers] Unexpected response for Select2", data);
                            return { results: [], pagination: { more: false } };
                        }

                        const results = Array.isArray(data)
                            ? data
                            : data.results || data.items || [];
                        const pagination = data.pagination || { more: false };
                        return { results, pagination };
                    },
                    cache: true,
                },
                placeholder: "Search for variant...",
                minimumInputLength: 0,
                allowClear: true,
                width: "100%",
                dropdownParent: $("#supplier-modal"),
                templateResult: (item) => {
                    if (item.loading) return "Loading...";
                    const name = item.text || item.name || item.item_name || `Variant ${item.id || ""}`;
                    const color = item.color || item.color_name || item.colour || "";
                    const size = item.size || item.size_name || "";
                    const model = item.model || item.model_name || "";
                    const unit = item.unit || item.unit_name || "";
                    const parts = [name];
                    const meta = [color, size, model, unit].filter(Boolean).join(" · ");
                    if (meta) parts.push(`<span style="color:#666;font-size:12px;">${meta}</span>`);
                    return $(
                        `<div style="display:flex;flex-direction:column;gap:2px;">${parts.join("<br>")}</div>`
                    );
                },
                templateSelection: (item) => {
                    if (!item || !item.id) return item.text || "";
                    const name = item.text || item.name || item.item_name || `Variant ${item.id}`;
                    return name;
                },
            });
            console.log("[Suppliers] Select2 initialized successfully for:", selector);
        } catch (error) {
            console.error("[Suppliers] Failed to initialize Select2:", error);
        }
    },

    /**
     * Add a contact row to the form
     */
    addContactRow() {
        const container = document.getElementById("contacts-container");
        if (!container) return;

        const group = document.createElement("div");
        group.className = "contact-field-group";
        group.style.cssText = "margin-bottom: 1rem; padding: 1rem; border: 1px solid #ddd; border-radius: 4px; position: relative;";
        group.innerHTML = `
            <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0.75rem; margin-bottom: 0.5rem;">
                <div>
                    <label style="display: block; margin-bottom: 0.25rem; font-size: 0.875rem;">Name</label>
                    <input type="text" name="contact_name" placeholder="Name" style="width:100%; padding: 0.5rem; border: 1px solid #ddd; border-radius: 4px;" />
                </div>
                <div>
                    <label style="display: block; margin-bottom: 0.25rem; font-size: 0.875rem;">Phone</label>
                    <input type="tel" name="contact_phone" placeholder="Phone" style="width:100%; padding: 0.5rem; border: 1px solid #ddd; border-radius: 4px;" />
                </div>
                <div>
                    <label style="display: block; margin-bottom: 0.25rem; font-size: 0.875rem;">Email</label>
                    <input type="email" name="contact_email" placeholder="Email" style="width:100%; padding: 0.5rem; border: 1px solid #ddd; border-radius: 4px;" />
                </div>
            </div>
            <button class="button danger remove-contact-btn" type="button" style="position: absolute; top: 0.5rem; right: 0.5rem; padding: 0.25rem 0.5rem; font-size: 0.75rem;">Remove</button>
        `;

        container.appendChild(group);
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
