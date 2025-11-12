/**
 * Variant Search Component - Multi-select with search bar
 * @version 3.0.0
 * Simpler UI: text input + checkbox results + Add Selected
 */

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

const variantSearch = {
    categories: [],
    selected: new Set(),
    lastQuery: '',
    page: 1,
    hasMore: true,
    loading: false,

    async init() {
        console.log('Initializing Variant Search (multi-select)...');
        await this.loadCategories();
        this.attachEventListeners();
        // Insert the select/unselect toggle button into the UI (will insert near results)
        this.insertToggleButton();
        this.performSearch('');
        console.log('Variant Search initialized successfully');
    },

    renderResultRow(variant) {
        const checked = this.selected.has(variant.id) ? 'checked' : '';
        const stock = this.getStockStatusHTML(variant);
        const vname = escapeHtml(variant.text || variant.item_name || 'Unknown');
        return `
            <label class="variant-row" draggable="true" data-variant-id="${variant.id}" data-variant-name="${vname}" style="display:flex; gap:8px; align-items:flex-start; padding:8px; border-bottom:1px solid #f2f2f2; cursor:grab;">
                <input type="checkbox" data-variant-id="${variant.id}" ${checked} />
                <div style="flex:1;">
                    <div style="font-weight:600;">${vname}</div>
                    <div style="font-size:12px; color:#666; display:flex; gap:12px;">
                        <span>${escapeHtml(variant.brand || 'N/A')}</span>
                        <span>${escapeHtml(variant.model || 'N/A')}</span>
                        ${stock}
                    </div>
                </div>
                <span title="Drag to subprocess" style="font-size:14px; color:#999;">↔</span>
            </label>
        `;
    },

    getStockStatusHTML(variant) {
        const qty = parseInt(variant.quantity) || 0;
        const reorder = parseInt(variant.reorder_level) || 0;
        let statusClass = 'stock-good';
        let statusText = `In Stock (${qty})`;
        let statusIcon = '';

        if (qty === 0) {
            statusClass = 'stock-out';
            statusText = 'Out of Stock';
            statusIcon = '';
        } else if (qty <= reorder) {
            statusClass = 'stock-low';
            statusText = `Low Stock (${qty})`;
            statusIcon = '';
        }

        return `<span class="variant-stock ${statusClass}">${statusIcon} ${statusText}</span>`;
    },

    async performSearch(query) {
        if (this.loading) return;
        this.loading = true;
        this.lastQuery = query;
        this.page = 1;
        const resultsEl = document.getElementById('variant-search-results');
        if (!resultsEl) { this.loading = false; return; }
        resultsEl.innerHTML = '<div style="padding:8px; color:#666;">Searching...</div>';
        try {
            const resp = await fetch(`/api/variants/select2?q=${encodeURIComponent(query)}&page=${this.page}&page_size=30`, {
                credentials: 'include'
            });
            const data = await resp.json();
            const items = data.results || [];
            this.hasMore = data.pagination ? !!data.pagination.more : false;
            resultsEl.innerHTML = items.map(v => this.renderResultRow(v)).join('') || '<div style="padding:8px; color:#999;">No results</div>';
            this.wireResultCheckboxes();
        } catch (e) {
            console.error('Search error', e);
            resultsEl.innerHTML = '<div style="padding:8px; color:#d32f2f;">Failed to load variants</div>';
        } finally {
            this.loading = false;
        }
    },

    wireResultCheckboxes() {
        const container = document.getElementById('variant-search-results');
        if (!container) return;
        container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            cb.addEventListener('change', (e) => {
                const id = parseInt(e.target.getAttribute('data-variant-id'));
                if (e.target.checked) this.selected.add(id); else this.selected.delete(id);
                // Keep toggle button label/state up to date
                this.updateToggleButton();
            });
        });
        // Enable drag-and-drop
        container.querySelectorAll('.variant-row').forEach(row => {
            row.addEventListener('dragstart', (e) => {
                const id = parseInt(row.getAttribute('data-variant-id'));
                const name = row.getAttribute('data-variant-name') || '';
                try {
                    e.dataTransfer.effectAllowed = 'copy';
                    
                    // If multiple variants are selected, include all of them
                    if (this.selected.size > 0) {
                        const selectedIds = Array.from(this.selected);
                        e.dataTransfer.setData('application/json', JSON.stringify({ 
                            ids: selectedIds,
                            multiSelect: true
                        }));
                    } else {
                        // Single variant drag
                        e.dataTransfer.setData('application/json', JSON.stringify({ 
                            id: id, 
                            name: name 
                        }));
                    }
                } catch(err) {
                    console.error('Drag start error', err);
                }
            });
        });
        // After wiring checkboxes and drag, update the toggle button state
        this.updateToggleButton();
    },

    // Insert a single toggle button that switches between Select All and Unselect All
    insertToggleButton() {
        // Prefer explicit container if developer added one; otherwise place next to results element
        const resultsEl = document.getElementById('variant-search-results');
        if (!resultsEl) return;

        const resultsContainer = document.getElementById('variant-search-results-container') || resultsEl.parentNode;
        if (!resultsContainer) return;

        let toggleBtn = document.getElementById('variant-toggle-select-btn');
        if (!toggleBtn) {
            toggleBtn = document.createElement('button');
            toggleBtn.id = 'variant-toggle-select-btn';
            toggleBtn.className = 'variant-toggle-btn';
            toggleBtn.style.margin = '8px 0';
            toggleBtn.textContent = 'Select All';
            // Accessibility attributes
            toggleBtn.setAttribute('role', 'button');
            toggleBtn.setAttribute('aria-pressed', 'false');
            toggleBtn.setAttribute('aria-label', 'Select all visible variants');
            toggleBtn.tabIndex = 0;
            // Insert before the results list so it appears above
            resultsContainer.insertBefore(toggleBtn, resultsEl);
        }

        toggleBtn.onclick = (e) => {
            e.preventDefault();
            this.toggleSelectAll();
        };
        // Keyboard activation (Enter / Space)
        toggleBtn.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                this.toggleSelectAll();
            }
        });
    },

    // Toggle all visible checkboxes: select them if any are unselected, otherwise unselect all
    toggleSelectAll() {
        const resultsEl = document.getElementById('variant-search-results');
        if (!resultsEl) return;
        const checkboxes = Array.from(resultsEl.querySelectorAll('input[type="checkbox"]'));
        if (checkboxes.length === 0) return;
        // If any checkbox is selected, interpret the toggle as "Unselect All".
        // This makes the toggle respond immediately when the user selects a single checkbox.
        const anySelected = checkboxes.some(cb => cb.checked);
        if (anySelected) {
            // Unselect all
            checkboxes.forEach(cb => {
                cb.checked = false;
                const id = parseInt(cb.getAttribute('data-variant-id'));
                this.selected.delete(id);
            });
        } else {
            // Select all
            checkboxes.forEach(cb => {
                cb.checked = true;
                const id = parseInt(cb.getAttribute('data-variant-id'));
                this.selected.add(id);
            });
        }
        this.updateToggleButton();
    },

    // Update the toggle button label according to the visible checkbox state
    updateToggleButton() {
        const resultsEl = document.getElementById('variant-search-results');
        const toggleBtn = document.getElementById('variant-toggle-select-btn');
        if (!resultsEl || !toggleBtn) return;
        const checkboxes = Array.from(resultsEl.querySelectorAll('input[type="checkbox"]'));
        // Show 'Unselect All' as soon as any visible checkbox is selected
        const anySelected = checkboxes.length > 0 && checkboxes.some(cb => cb.checked);
        // Use the internal selected set for a stable selected count (may include selections across pages)
        const selectedCount = (this.selected && typeof this.selected.size === 'number') ? this.selected.size : (checkboxes.filter(cb => cb.checked).length);
        if (anySelected && selectedCount > 0) {
            toggleBtn.textContent = `Unselect All (${selectedCount})`;
        } else if (anySelected && selectedCount === 0) {
            // Fallback: some visible checkboxes are checked but selectedSet is empty (sync issue) — show visible count
            const visibleCount = checkboxes.filter(cb => cb.checked).length;
            toggleBtn.textContent = `Unselect All (${visibleCount})`;
        } else {
            toggleBtn.textContent = 'Select All';
        }
        // Update ARIA pressed state and label for screen readers
        try {
            toggleBtn.setAttribute('aria-pressed', anySelected ? 'true' : 'false');
            const ariaLabel = anySelected ? `Unselect all visible variants${selectedCount ? ` (${selectedCount})` : ''}` : 'Select all visible variants';
            toggleBtn.setAttribute('aria-label', ariaLabel);
        } catch (err) {
            // ignore
        }
    },

    attachEventListeners() {
        const input = document.getElementById('variant-search-input');
        if (input) {
            input.addEventListener('input', this.debounce((e) => {
                this.performSearch(e.target.value || '');
            }, 300));
        }

        const addBtn = document.getElementById('add-selected-variants-btn');
        if (addBtn) {
            console.debug('[VariantSearch] add-selected-variants-btn found, attaching click handler');
            addBtn.addEventListener('click', (evt) => {
                console.debug('[VariantSearch] add-selected-variants-btn clicked', { selectedCount: this.selected.size });
                const pf = window.processFramework || (typeof processFramework !== 'undefined' ? processFramework : null);
                if (pf && typeof pf.openBatchAddModal === 'function') {
                    try {
                        // If a subprocess is already selected in the inline editor, open batch modal
                        if (pf.currentInlineSelectedSubprocessId) {
                            pf.openBatchAddModal();
                        } else {
                            // No subprocess selected — open the subprocess selection modal to let user pick a target
                            console.debug('[VariantSearch] No subprocess selected — opening subprocess selector');
                            // Ensure the subprocess modal knows which process we're editing
                            try {
                                window.currentProcessIdForSubprocess = pf.currentEditProcessId;
                                // Use the inline helper to show the selector
                                if (typeof pf.showSubprocessSelectionModal === 'function') {
                                    pf.showSubprocessSelectionModal();
                                } else {
                                    // Fallback: alert the user to click a subprocess
                                    alert('Please select a subprocess on the left, then click Add selected.');
                                }
                            } catch (innerErr) {
                                console.error('[VariantSearch] Error opening subprocess selector', innerErr);
                                alert('Please select a subprocess on the left, then click Add selected.');
                            }
                        }
                    } catch (err) {
                        console.error('[VariantSearch] Error calling processFramework.openBatchAddModal', err);
                        alert('Failed to open batch add dialog. See console for details.');
                    }
                } else {
                    console.warn('[VariantSearch] processFramework.openBatchAddModal not available');
                    alert('Select a process and subprocess first');
                }
            });
        } else {
            console.warn('[VariantSearch] add-selected-variants-btn NOT found in DOM when attaching listeners');
        }
    },

    async loadCategories() {
        try {
            const response = await fetch('/api/categories', {
                method: 'GET',
                credentials: 'include',
                headers: { 'Accept': 'application/json' }
            });

            if (response.status === 401) {
                window.location.href = '/auth/login';
                return;
            }

            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const data = await response.json();
            this.categories = Array.isArray(data) ? data : (data.categories || []);
            this.renderCategoryFilter();
            console.log(`Loaded ${this.categories.length} categories`);
        } catch (error) {
            console.error('Error loading categories:', error);
            this.categories = [];
            this.renderCategoryFilter();
        }
    },

    renderCategoryFilter() {
        const select = document.getElementById('category-filter');
        if (!select) return;

        try {
            let html = '<option value="">All Categories</option>';
            this.categories.forEach(cat => {
                const name = escapeHtml(cat.name || 'Unnamed');
                const id = cat.id || cat.item_category_id || '';
                html += `<option value="${id}">${name}</option>`;
            });
            select.innerHTML = html;
        } catch (error) {
            console.error('Error rendering category filter:', error);
        }
    },

    destroy() {
        // no-op for simple component
    },

    refresh() {
        this.performSearch(this.lastQuery || '');
    },

    // simple debounce
    debounce(fn, wait) {
        let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), wait); };
    }
};
