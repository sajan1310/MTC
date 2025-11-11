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
            addBtn.addEventListener('click', () => {
                const pf = window.processFramework || (typeof processFramework !== 'undefined' ? processFramework : null);
                if (pf && typeof pf.openBatchAddModal === 'function') {
                    pf.openBatchAddModal();
                } else {
                    alert('Select a process and subprocess first');
                }
            });
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
