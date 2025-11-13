(function() {
  "use strict";

  const PoModal = {
    poModal: null,
    poForm: null,
    poItemsContainer: null,
    addPoItemBtn: null,
    variantSearchModal: null,
    variantSearchInput: null,
    variantSearchResults: null,
    addSelectedVariantsBtn: null,
    selectAllVariants: null,
    addPoBtn: null,

    init() {
      this.cache();
      this.attachListeners();
    },

    cache() {
      this.poModal = document.getElementById('po-modal');
      this.poForm = document.getElementById('po-form');
      this.poItemsContainer = document.getElementById('po-items-container');
      this.addPoItemBtn = document.getElementById('add-po-item-btn');
      this.variantSearchModal = document.getElementById('variant-search-modal');
      this.variantSearchInput = document.getElementById('variant-search-input');
      this.variantSearchResults = document.getElementById('variant-search-results');
      this.addSelectedVariantsBtn = document.getElementById('add-selected-variants-btn');
      this.selectAllVariants = document.getElementById('select-all-variants');
      this.addPoBtn = document.getElementById('add-po-btn');
    },

    attachListeners() {
      // Add PO floating button
      if (this.addPoBtn) {
        this.addPoBtn.addEventListener('click', async (e) => {
          e.preventDefault();
          await this.open();
        });
      }

      // Global generate PO buttons (dashboard etc.)
      document.querySelectorAll('#generate-po-btn, .generate-po-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.preventDefault();
          // If Inventory module exists prefer its native handler
          if (window.Inventory && typeof Inventory.openPOModal === 'function') {
            Inventory.openPOModal();
            return;
          }
          await this.open();
        });
      });

      // Delegated handler: catch links that navigate with ?action=generate-po (dashboard quick action)
      document.addEventListener('click', (e) => {
        try {
          const anchor = e.target.closest && e.target.closest('a');
          if (!anchor) return;
          const href = anchor.getAttribute('href') || '';
          // Match query param action=generate-po anywhere in href
          if (href.indexOf('action=generate-po') !== -1) {
            e.preventDefault();
            // Prefer Inventory handler if available
            if (window.Inventory && typeof Inventory.openPOModal === 'function') {
              Inventory.openPOModal();
              return;
            }
            // Otherwise open the centralized PoModal
            if (window.PoModal && typeof PoModal.open === 'function') {
              PoModal.open();
            }
          }
        } catch (err) {
          // swallow errors to avoid breaking other click handlers
          console.error('PoModal delegated click handler error:', err);
        }
      });

      // Variant search input -> delegate to PurchaseOrders (debounced)
      if (this.variantSearchInput) {
        let debounceTimer = null;
        this.variantSearchInput.addEventListener('input', () => {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            if (window.PurchaseOrders && typeof PurchaseOrders.renderVariantSearchResults === 'function') {
              PurchaseOrders.renderVariantSearchResults();
            }
          }, 300);
        });
      }

      // Add selected variants
      if (this.addSelectedVariantsBtn) {
        this.addSelectedVariantsBtn.addEventListener('click', () => {
          if (window.PurchaseOrders && typeof PurchaseOrders.addSelectedVariantsToPO === 'function') {
            PurchaseOrders.addSelectedVariantsToPO();
          }
        });
      }

      // Select all checkbox
      if (this.selectAllVariants) {
        this.selectAllVariants.addEventListener('change', (e) => {
          const resultsEl = this.variantSearchResults;
          if (!resultsEl) return;
          resultsEl.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = e.target.checked);
        });
      }

      // PO form submit -> delegate to PurchaseOrders
      if (this.poForm) {
        this.poForm.addEventListener('submit', (e) => {
          if (window.PurchaseOrders && typeof PurchaseOrders.handlePOFormSubmit === 'function') {
            PurchaseOrders.handlePOFormSubmit(e);
          }
        });
      }

      // Add item button opens variant search modal (delegate)
      if (this.addPoItemBtn) {
        this.addPoItemBtn.addEventListener('click', () => {
          if (window.PurchaseOrders && typeof PurchaseOrders.openVariantSearchModal === 'function') {
            PurchaseOrders.openVariantSearchModal();
          }
        });
      }

      // Use a delegated close handler is already present globally in main.js; no duplicate needed
    },

    async loadSuppliersForPO() {
      try {
        const data = await App.fetchJson(`${App.config.apiBase}/suppliers`);
        const container = document.getElementById('po-supplier-container');
        if (container && data && Array.isArray(data)) {
          container.innerHTML = `
            <div class="form-field">
              <label for="po-supplier-id">Supplier *</label>
              <select id="po-supplier-id" name="supplier_id" required>
                <option value="">Select Supplier...</option>
                ${data.map(s => `<option value="${s.id}">${App.escapeHtml(s.firm_name)}</option>`).join('')}
              </select>
            </div>
          `;
        }
      } catch (err) {
        console.error('PoModal: failed to load suppliers', err);
      }
    },

    clearPOForm() {
      const form = document.getElementById('po-form');
      if (form && typeof form.reset === 'function') form.reset();
      // clear both legacy container and new table body for safety
      const itemsContainer = document.getElementById('po-items-container');
      if (itemsContainer) itemsContainer.innerHTML = '';
      const tbody = document.getElementById('po-items-tbody');
      if (tbody) tbody.innerHTML = '';
    },

    async open() {
      // Ensure we have up-to-date elements
      this.cache();

      // Load supplier list and clear the form
      await this.loadSuppliersForPO();
      this.clearPOForm();

      if (this.poModal) {
        // Use shared Modal helper to manage aria/focus
        try { Modal.open(this.poModal); } catch (e) {
          // Fallback to previous behavior
          try { this.poModal.setAttribute('aria-hidden', 'false'); } catch (e) {}
          this.poModal.classList.add('is-open');
        }
      } else {
        console.warn('PoModal.open: po-modal element not found in DOM. Make sure _po_modals.html is included in base template.');
      }
    },

    close() {
      if (this.poModal) {
        try { Modal.close(this.poModal); } catch (e) {
          this.poModal.classList.remove('is-open');
          try { this.poModal.setAttribute('aria-hidden', 'true'); } catch (e) {}
        }
      }
    }
  };

  // Expose globally
  window.PoModal = PoModal;

  document.addEventListener('DOMContentLoaded', () => PoModal.init());
})();
