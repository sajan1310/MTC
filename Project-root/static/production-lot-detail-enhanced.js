/**
 * Enhanced Production Lot Detail Module
 * Provides improved error handling, form validation, and APIResponse envelope support
 */

const ProductionLotDetailEnhanced = {
    state: {
        lotId: null,
        lotData: null,
        variants: [],
        subprocesses: [],
    },
    handlers: {},

    /**
     * Initialize enhanced production lot detail module
     */
    init() {
        const lotId = this.extractLotIdFromUrl();
        if (!lotId) return;

        this.state.lotId = lotId;
        console.log("[ProductionLotDetail] Enhanced module initializing for lot:", lotId);

        // Initialize modal handlers
        this.initializeModals();

        // Bind event listeners
        this.bindEventListeners();

        // Load initial data
        this.loadLotDetails();
    },

    /**
     * Extract lot ID from URL
     */
    extractLotIdFromUrl() {
        const match = window.location.pathname.match(/\/upf\/production-lots\/(\d+)/);
        return match ? match[1] : null;
    },

    /**
     * Initialize modal handlers
     */
    initializeModals() {
        this.handlers.editModal = new ModalHandler("modal-overlay");
        this.handlers.variantModal = new ModalHandler("variant-modal-overlay");
        this.handlers.subprocessModal = new ModalHandler("edit-subprocess-modal-overlay");
    },

    /**
     * Bind event listeners
     */
    bindEventListeners() {
        // Edit lot button
        document.getElementById("edit-lot-btn")?.addEventListener("click", () => {
            this.openEditLotModal();
        });

        // Delete lot button
        document.getElementById("delete-lot-btn")?.addEventListener("click", () => {
            this.deleteLot();
        });

        // Edit lot form submission
        document.getElementById("edit-lot-form")?.addEventListener("submit", (e) => {
            e.preventDefault();
            this.handleEditLotSubmit();
        });

        // Add variant button
        document.querySelector('[data-action="add-variant"]')?.addEventListener("click", () => {
            this.openAddVariantModal();
        });

        // Add variant form submission
        document.getElementById("add-variant-form")?.addEventListener("submit", (e) => {
            e.preventDefault();
            this.handleAddVariantSubmit();
        });

        // Recalculate cost button
        document.getElementById("recalc-cost-btn")?.addEventListener("click", () => {
            this.recalculateCost();
        });

        // Refresh variants button
        document.getElementById("refresh-variant-options")?.addEventListener("click", () => {
            this.loadLotDetails();
        });
    },

    /**
     * Load lot details with error handling
     */
    async loadLotDetails() {
        const container = document.getElementById("lot-details-content");
        APIResponseHandler.showLoading(container, "Loading lot details...");

        try {
            const response = await APIResponseHandler.request(
                `/api/upf/production-lots/${this.state.lotId}`,
                {
                    context: "Load Production Lot",
                }
            );

            this.state.lotData = response.data;
            this.renderLotDetails();
            this.loadVariants();
            this.loadSubprocesses();
            APIResponseHandler.hideLoading(container);
        } catch (error) {
            APIResponseHandler.showNotification(error, "error");
            console.error("[ProductionLotDetail] Load error:", error);
            container.innerHTML = "<p>Failed to load lot details</p>";
        }
    },

    /**
     * Render lot details
     */
    renderLotDetails() {
        const container = document.getElementById("lot-details-content");
        if (!container || !this.state.lotData) return;

        const lot = this.state.lotData;

        container.innerHTML = `
            <div class="detail-row">
                <span class="detail-label">Lot ID:</span>
                <span class="detail-value">${lot.id}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Process:</span>
                <span class="detail-value">${this.escapeHtml(lot.process_name || "N/A")}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Quantity:</span>
                <span class="detail-value">${lot.quantity} units</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Status:</span>
                <span class="detail-value">
                    <span class="status-badge ${this.getStatusClass(lot.status)}">
                        ${this.escapeHtml(lot.status)}
                    </span>
                </span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Created:</span>
                <span class="detail-value">${new Date(lot.created_at).toLocaleString()}</span>
            </div>
            ${lot.notes ? `
                <div class="detail-row">
                    <span class="detail-label">Notes:</span>
                    <span class="detail-value">${this.escapeHtml(lot.notes)}</span>
                </div>
            ` : ""}
        `;
    },

    /**
     * Get status badge class
     */
    getStatusClass(status) {
        const statusMap = {
            planning: "info",
            ready: "warning",
            "in progress": "warning",
            completed: "success",
            finalized: "success",
            cancelled: "error",
        };
        return statusMap[status?.toLowerCase()] || "info";
    },

    /**
     * Load variants
     */
    async loadVariants() {
        try {
            const response = await APIResponseHandler.request(
                `/api/upf/production-lots/${this.state.lotId}/variants`,
                {
                    context: "Load Variants",
                }
            );

            this.state.variants = response.data || [];
            this.renderVariants();
        } catch (error) {
            console.error("[ProductionLotDetail] Load variants error:", error);
        }
    },

    /**
     * Render variants
     */
    renderVariants() {
        const container = document.getElementById("variants-content");
        if (!container) return;

        if (!this.state.variants.length) {
            container.innerHTML = "<p>No variants selected</p>";
            return;
        }

        container.innerHTML = this.state.variants
            .map(
                (variant) => `
            <div class="variant-item">
                <span>${this.escapeHtml(variant.name)}</span>
                <span class="variant-qty">Qty: ${variant.quantity}</span>
                <button class="button danger" onclick="ProductionLotDetailEnhanced.removeVariant(${variant.id})">Remove</button>
            </div>
        `
            )
            .join("");
    },

    /**
     * Load subprocesses
     */
    async loadSubprocesses() {
        try {
            const response = await APIResponseHandler.request(
                `/api/upf/production-lots/${this.state.lotId}/subprocesses`,
                {
                    context: "Load Subprocesses",
                }
            );

            this.state.subprocesses = response.data || [];
            this.renderSubprocesses();
        } catch (error) {
            console.error("[ProductionLotDetail] Load subprocesses error:", error);
        }
    },

    /**
     * Render subprocesses
     */
    renderSubprocesses() {
        const container = document.getElementById("subprocesses-content");
        if (!container) return;

        if (!this.state.subprocesses.length) {
            container.innerHTML = "<p>No subprocesses assigned</p>";
            return;
        }

        container.innerHTML = `
            <div class="subprocesses-list">
                ${this.state.subprocesses
                    .map(
                        (sp) => `
                    <div class="subprocess-item">
                        <strong>${this.escapeHtml(sp.name)}</strong>
                        <p>${this.escapeHtml(sp.description)}</p>
                        <button class="button secondary" onclick="ProductionLotDetailEnhanced.editSubprocess(${sp.id})">Edit Options</button>
                    </div>
                `
                    )
                    .join("")}
            </div>
        `;
    },

    /**
     * Open edit lot modal
     */
    openEditLotModal() {
        if (!this.state.lotData) {
            APIResponseHandler.showNotification("Lot data not loaded", "warning");
            return;
        }

        document.getElementById("modal-quantity").value = this.state.lotData.quantity;
        document.getElementById("modal-status").value = this.state.lotData.status;
        document.getElementById("modal-notes").value = this.state.lotData.notes || "";

        this.handlers.editModal.open();
    },

    /**
     * Handle edit lot form submission
     */
    async handleEditLotSubmit() {
        const form = document.getElementById("edit-lot-form");
        if (!FormHandler.validateRequired(form)) {
            APIResponseHandler.showNotification("Please fill all required fields", "warning");
            return;
        }

        const body = {
            quantity: parseInt(document.getElementById("modal-quantity").value),
            status: document.getElementById("modal-status").value,
            notes: document.getElementById("modal-notes").value,
        };

        try {
            await APIResponseHandler.request(`/api/upf/production-lots/${this.state.lotId}`, {
                method: "PUT",
                body,
                context: "Update Production Lot",
            });

            APIResponseHandler.showNotification("Lot updated successfully", "success");
            this.handlers.editModal.close();
            this.loadLotDetails();
        } catch (error) {
            APIResponseHandler.showNotification(error, "error");
        }
    },

    /**
     * Delete lot
     */
    async deleteLot() {
        if (!confirm("Are you sure you want to delete this production lot? This action cannot be undone.")) {
            return;
        }

        try {
            await APIResponseHandler.request(`/api/upf/production-lots/${this.state.lotId}`, {
                method: "DELETE",
                context: "Delete Production Lot",
            });

            APIResponseHandler.showNotification("Lot deleted successfully", "success");
            setTimeout(() => {
                window.location.href = "/upf/processes?tab=production";
            }, 1500);
        } catch (error) {
            APIResponseHandler.showNotification(error, "error");
        }
    },

    /**
     * Open add variant modal
     */
    openAddVariantModal() {
        this.handlers.variantModal.clearForm();
        this.handlers.variantModal.open();
    },

    /**
     * Handle add variant form submission
     */
    async handleAddVariantSubmit() {
        const form = document.getElementById("add-variant-form");
        if (!FormHandler.validateRequired(form)) {
            APIResponseHandler.showNotification("Please fill all required fields", "warning");
            return;
        }

        const variantId = document.getElementById("variant-select").value;
        const quantity = document.getElementById("variant-qty").value;

        const body = {
            variant_id: parseInt(variantId),
            quantity: parseFloat(quantity),
        };

        try {
            await APIResponseHandler.request(
                `/api/upf/production-lots/${this.state.lotId}/variants`,
                {
                    method: "POST",
                    body,
                    context: "Add Variant to Lot",
                }
            );

            APIResponseHandler.showNotification("Variant added successfully", "success");
            this.handlers.variantModal.close();
            this.loadVariants();
        } catch (error) {
            APIResponseHandler.showNotification(error, "error");
        }
    },

    /**
     * Remove variant from lot
     */
    async removeVariant(variantId) {
        if (!confirm("Remove this variant from the lot?")) return;

        try {
            await APIResponseHandler.request(
                `/api/upf/production-lots/${this.state.lotId}/variants/${variantId}`,
                {
                    method: "DELETE",
                    context: "Remove Variant",
                }
            );

            APIResponseHandler.showNotification("Variant removed successfully", "success");
            this.loadVariants();
        } catch (error) {
            APIResponseHandler.showNotification(error, "error");
        }
    },

    /**
     * Edit subprocess
     */
    editSubprocess(subprocessId) {
        // Load subprocess details and show modal
        this.handlers.subprocessModal.open();
    },

    /**
     * Recalculate cost
     */
    async recalculateCost() {
        try {
            const response = await APIResponseHandler.request(
                `/api/upf/production-lots/${this.state.lotId}/recalculate-cost`,
                {
                    method: "POST",
                    context: "Recalculate Cost",
                }
            );

            document.getElementById("lot-total-cost").textContent = `$${response.data.total_cost.toFixed(2)}`;
            APIResponseHandler.showNotification("Cost recalculated successfully", "success");
        } catch (error) {
            APIResponseHandler.showNotification(error, "error");
        }
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
    ProductionLotDetailEnhanced.init();
});
