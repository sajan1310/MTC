/**
 * Enhanced API Response Handler
 * Provides consistent handling of APIResponse envelopes across all UI components
 * Replaces raw fetch calls with standardized response parsing and error handling
 */

class APIResponseHandler {
    /**
     * Parse APIResponse envelope and handle errors gracefully
     * @param {Response} response - Fetch response object
     * @param {string} context - Operation context for error messages
     * @returns {Promise<object>} - Parsed APIResponse data or throws error
     */
    static async parseResponse(response, context = "API") {
        const data = await response.json();

        // Check if response follows APIResponse envelope format
        if (typeof data !== "object" || !("success" in data)) {
            throw new Error(`${context}: Invalid response format`);
        }

        // Handle success responses
        if (data.success) {
            return data;
        }

        // Handle error responses with error codes
        const errorCode = data.error || "unknown_error";
        const errorMessage = data.message || "An error occurred";
        const error = new Error(errorMessage);
        error.code = errorCode;
        error.statusCode = response.status;

        throw error;
    }

    /**
     * Make an authenticated API request with proper error handling
     * @param {string} endpoint - API endpoint URL
     * @param {object} options - Fetch options (method, body, headers, etc.)
     * @returns {Promise<object>} - Parsed APIResponse data
     */
    static async request(endpoint, options = {}) {
        const {
            method = "GET",
            body = null,
            headers = {},
            context = endpoint,
            timeout = 30000,
        } = options;

        const config = {
            method,
            headers: {
                "Content-Type": "application/json",
                ...headers,
            },
        };

        if (body) {
            config.body = JSON.stringify(body);
        }

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);

            const response = await fetch(endpoint, {
                ...config,
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            return await this.parseResponse(response, context);
        } catch (error) {
            if (error.name === "AbortError") {
                throw new Error(
                    `${context}: Request timeout (${timeout}ms) - server may be unresponsive`
                );
            }
            throw error;
        }
    }

    /**
     * Show user-friendly error notification
     * @param {Error|string} error - Error object or message
     * @param {string} type - Notification type (error, warning, info)
     */
    static showNotification(error, type = "error") {
        const message = error instanceof Error ? error.message : String(error);
        const container = document.getElementById("notification-container") || this.createNotificationContainer();

        const notification = document.createElement("div");
        notification.className = `notification notification-${type}`;
        notification.setAttribute("role", "alert");
        notification.setAttribute("aria-live", "polite");

        const closeBtn = document.createElement("button");
        closeBtn.className = "notification-close";
        closeBtn.innerHTML = "&times;";
        closeBtn.onclick = () => notification.remove();

        const content = document.createElement("div");
        content.className = "notification-content";
        content.textContent = message;

        notification.appendChild(content);
        notification.appendChild(closeBtn);
        container.appendChild(notification);

        // Auto-remove after 6 seconds
        setTimeout(() => notification.remove(), 6000);
    }

    /**
     * Create notification container if it doesn't exist
     */
    static createNotificationContainer() {
        const container = document.createElement("div");
        container.id = "notification-container";
        container.className = "notification-container";
        document.body.appendChild(container);
        return container;
    }

    /**
     * Show loading state on element
     * @param {HTMLElement} element - Element to show loading state on
     * @param {string} message - Loading message
     */
    static showLoading(element, message = "Loading...") {
        if (!element) return;
        element.innerHTML = `
            <div class="loading-spinner">
                <div class="spinner"></div>
                <p>${message}</p>
            </div>
        `;
        element.classList.add("loading-state");
    }

    /**
     * Hide loading state on element
     * @param {HTMLElement} element - Element to hide loading state from
     */
    static hideLoading(element) {
        if (!element) return;
        element.classList.remove("loading-state");
    }
}

/**
 * Enhanced Form Validation and Submission Handler
 */
class FormHandler {
    /**
     * Validate required fields in form
     * @param {HTMLFormElement} form - Form element to validate
     * @returns {boolean} - True if valid, false otherwise
     */
    static validateRequired(form) {
        const requiredFields = form.querySelectorAll("[required]");
        let isValid = true;

        requiredFields.forEach((field) => {
            if (!field.value || field.value.trim() === "") {
                this.markFieldError(field, `${field.name || "Field"} is required`);
                isValid = false;
            } else {
                this.clearFieldError(field);
            }
        });

        return isValid;
    }

    /**
     * Validate email field
     * @param {HTMLInputElement} field - Email input field
     * @returns {boolean} - True if valid
     */
    static validateEmail(field) {
        const pattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (field.value && !pattern.test(field.value)) {
            this.markFieldError(field, "Invalid email address");
            return false;
        }
        this.clearFieldError(field);
        return true;
    }

    /**
     * Validate numeric field
     * @param {HTMLInputElement} field - Numeric input field
     * @returns {boolean} - True if valid
     */
    static validateNumeric(field) {
        if (field.value && isNaN(field.value)) {
            this.markFieldError(field, "Must be a number");
            return false;
        }
        this.clearFieldError(field);
        return true;
    }

    /**
     * Mark field as invalid with error message
     * @param {HTMLElement} field - Form field
     * @param {string} message - Error message
     */
    static markFieldError(field, message) {
        field.classList.add("field-error");
        let errorDisplay = field.nextElementSibling;

        if (!errorDisplay || !errorDisplay.classList.contains("field-error-message")) {
            errorDisplay = document.createElement("div");
            errorDisplay.className = "field-error-message";
            field.parentNode.insertBefore(errorDisplay, field.nextSibling);
        }

        errorDisplay.textContent = message;
    }

    /**
     * Clear error state from field
     * @param {HTMLElement} field - Form field
     */
    static clearFieldError(field) {
        field.classList.remove("field-error");
        const errorDisplay = field.nextElementSibling;
        if (errorDisplay && errorDisplay.classList.contains("field-error-message")) {
            errorDisplay.remove();
        }
    }

    /**
     * Submit form with validation and APIResponse handling
     * @param {HTMLFormElement} form - Form element
     * @param {string} endpoint - API endpoint
     * @param {Function} onSuccess - Success callback
     */
    static async submitForm(form, endpoint, onSuccess) {
        if (!this.validateRequired(form)) {
            APIResponseHandler.showNotification("Please fill in all required fields", "warning");
            return;
        }

        const submitBtn = form.querySelector("button[type=submit]");
        const originalText = submitBtn?.textContent;

        try {
            submitBtn && (submitBtn.disabled = true);
            submitBtn && (submitBtn.textContent = "Submitting...");

            const formData = new FormData(form);
            const body = Object.fromEntries(formData);

            const response = await APIResponseHandler.request(endpoint, {
                method: form.method === "POST" ? "POST" : "PUT",
                body,
                context: form.id || "Form submission",
            });

            APIResponseHandler.showNotification("Operation successful", "success");
            onSuccess && onSuccess(response);
        } catch (error) {
            APIResponseHandler.showNotification(error);
        } finally {
            submitBtn && (submitBtn.disabled = false);
            submitBtn && (submitBtn.textContent = originalText);
        }
    }
}

/**
 * Enhanced Pagination Handler
 * Manages paginated data display with navigation and page size controls
 */
class PaginationHandler {
    constructor(containerId, perPageSelectId, pageInfoId, prevBtnId, nextBtnId) {
        this.container = document.getElementById(containerId);
        this.perPageSelect = document.getElementById(perPageSelectId);
        this.pageInfo = document.getElementById(pageInfoId);
        this.prevBtn = document.getElementById(prevBtnId);
        this.nextBtn = document.getElementById(nextBtnId);

        this.state = {
            page: 1,
            per_page: 50,
            total: 0,
            items: [],
        };

        this.setupEventListeners();
    }

    setupEventListeners() {
        this.prevBtn?.addEventListener("click", () => this.previousPage());
        this.nextBtn?.addEventListener("click", () => this.nextPage());
        this.perPageSelect?.addEventListener("change", (e) => {
            this.state.per_page = parseInt(e.target.value);
            this.state.page = 1;
            this.onPageChange && this.onPageChange();
        });
    }

    /**
     * Update pagination state with API response data
     * @param {object} data - APIResponse data with pagination info
     * @param {Function} renderFn - Function to render items
     */
    update(data, renderFn) {
        if (data.page) this.state.page = data.page;
        if (data.per_page) this.state.per_page = data.per_page;
        if (data.total !== undefined) this.state.total = data.total;
        if (data.items) this.state.items = data.items;

        this.render(renderFn);
    }

    /**
     * Render pagination controls
     * @param {Function} renderFn - Function to render items
     */
    render(renderFn) {
        const totalPages = Math.ceil(this.state.total / this.state.per_page);

        // Render items
        if (renderFn && this.container) {
            renderFn(this.state.items, this.container);
        }

        // Update page info
        if (this.pageInfo) {
            this.pageInfo.textContent = `Page ${this.state.page} of ${totalPages || 1}`;
        }

        // Update button states
        if (this.prevBtn) {
            this.prevBtn.disabled = this.state.page <= 1;
        }
        if (this.nextBtn) {
            this.nextBtn.disabled = this.state.page >= totalPages;
        }
    }

    previousPage() {
        if (this.state.page > 1) {
            this.state.page--;
            this.onPageChange && this.onPageChange();
        }
    }

    nextPage() {
        const totalPages = Math.ceil(this.state.total / this.state.per_page);
        if (this.state.page < totalPages) {
            this.state.page++;
            this.onPageChange && this.onPageChange();
        }
    }
}

/**
 * Enhanced Modal Handler
 * Manages modal lifecycle with keyboard navigation and focus management
 */
class ModalHandler {
    constructor(modalId) {
        this.modal = document.getElementById(modalId);
        this.closeBtn = this.modal?.querySelector(".close-modal-btn, [data-close]");
        this.backdrop = this.modal?.querySelector(".modal-content")?.parentElement;

        this.setupEventListeners();
    }

    setupEventListeners() {
        if (!this.modal) return;

        // Close button
        this.closeBtn?.addEventListener("click", () => this.close());

        // ESC key
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && this.isOpen()) {
                this.close();
            }
        });

        // Click outside to close (backdrop)
        this.modal.addEventListener("click", (e) => {
            if (e.target === this.modal) {
                this.close();
            }
        });
    }

    /**
     * Open modal with optional data
     * @param {object} data - Data to populate modal with
     */
    open(data = null) {
        if (!this.modal) return;

        this.modal.style.display = "flex";
        this.modal.setAttribute("aria-hidden", "false");

        // Focus first input or close button
        const firstInput = this.modal.querySelector("input, textarea, select");
        (firstInput || this.closeBtn)?.focus();
    }

    /**
     * Close modal
     */
    close() {
        if (!this.modal) return;

        this.modal.style.display = "none";
        this.modal.setAttribute("aria-hidden", "true");
    }

    /**
     * Check if modal is open
     * @returns {boolean}
     */
    isOpen() {
        return this.modal?.style.display !== "none";
    }

    /**
     * Clear form in modal
     */
    clearForm() {
        const form = this.modal?.querySelector("form");
        if (form) {
            form.reset();
            form.querySelectorAll(".field-error-message").forEach((el) => el.remove());
            form.querySelectorAll(".field-error").forEach((el) => el.classList.remove("field-error"));
        }
    }
}

// Export for use in other modules
if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        APIResponseHandler,
        FormHandler,
        PaginationHandler,
        ModalHandler,
    };
}
