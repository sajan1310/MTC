/* Variant search component
   A compact, self-contained module that exposes `window.variantSearch`.
   It provides: search (fetch), multi-select, drag-and-drop payload, and a small
   Select All / Unselect All toggle button. Designed to be defensive and avoid
   injecting HTML outside of template literals (fixes previous syntax error).
*/

(function(){
    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    const variantSearch = {
        selected: new Set(),
        loading: false,
        lastQuery: '',
        page: 1,
        hasMore: false,
        categories: [],

        renderResultRow(variant) {
            const id = variant.id || variant.item_id || variant.itemId || 0;

            // Helper to pick the first available field from possible keys
            const pick = (...keys) => {
                for (const k of keys) {
                    // support nested keys like 'item.name'
                    if (k.includes('.')) {
                        const parts = k.split('.');
                        let v = variant;
                        for (const p of parts) {
                            if (!v) break;
                            v = v[p];
                        }
                        if (v !== undefined && v !== null && String(v).trim() !== '') return v;
                    } else if (variant[k] !== undefined && variant[k] !== null && String(variant[k]).trim() !== '') {
                        return variant[k];
                    }
                }
                return '';
            };

            // Primary display name: try variant_name, item_name, nested item.name, name, title
            const rawName = pick('variant_name', 'item_name', 'item.name', 'item.item_name', 'name', 'title') || 'Unnamed';
            let displayText = String(rawName);
            // Guard against literal placeholder keys being returned
            if (/^variant[-_\s]?name$/i.test(displayText.trim())) {
                displayText = pick('item_name', 'name', 'title') || displayText;
            }

            const name = escapeHtml(displayText || 'Unnamed');

            // Secondary fields: model, variation, size, color, variation_name
            const model = escapeHtml(pick('model', 'item.model', 'model_name') || '');
            const variation = escapeHtml(pick('variation', 'variation_name', 'item.variation') || '');
            const size = escapeHtml(pick('size', 'dimensions.size', 'item.size') || '');
            const color = escapeHtml(pick('color', 'item.color') || '');

            const stock = this.getStockStatusHTML(variant);

            // Convert possible HTML stock snippet into plain text for tooltip
            const htmlToText = (html) => {
                try {
                    const d = document.createElement('div');
                    d.innerHTML = html || '';
                    return (d.textContent || d.innerText || '').trim();
                } catch (e) {
                    return String(html || '').replace(/<[^>]*>/g, '').trim();
                }
            };

            const stockText = htmlToText(stock);

            // Tooltip should point to DOM node .item-description-detail when present
            const findDomDescription = (vid, v) => {
                try {
                    const selectors = [
                        `.item-description-detail[data-id="${vid}"]`,
                        `.item-description-detail[data-item-id="${vid}"]`,
                        `#item-description-detail-${vid}`,
                        `.item_description_detail[data-id="${vid}"]`,
                        `.item-description-detail[data-variant-id="${vid}"]`,
                        `.item-description-detail`
                    ];
                    for (const sel of selectors) {
                        const el = document.querySelector(sel);
                        if (el && el.textContent && el.textContent.trim()) return el.textContent.trim();
                    }
                    // Fallback: match by item name inside any .item-description-detail nodes
                    const nameToMatch = v && (v.item_name || v.name || v.title || '');
                    if (nameToMatch) {
                        const nodes = document.querySelectorAll('.item-description-detail, .item_description_detail');
                        for (const n of nodes) {
                            if (n && n.textContent && n.textContent.includes(nameToMatch)) return n.textContent.trim();
                        }
                    }
                } catch (e) {
                    // ignore DOM access errors
                }
                return '';
            };

            const domDescription = findDomDescription(id, variant) || '';
            const tooltipParts = [];
            if (domDescription) tooltipParts.push(String(domDescription).replace(/\s+/g, ' ').trim());
            if (stockText) tooltipParts.push(String(stockText).trim());
            const tooltipText = tooltipParts.join(' — ');

            return `
                <label class="variant-row" draggable="true" data-variant-id="${id}" data-variant-name="${escapeHtml(String(rawName))}" style="display:flex; align-items:center; gap:8px; padding:8px; border-bottom:1px solid #eee;">
                    <input type="checkbox" data-variant-id="${id}" style="flex:0 0 auto;" />
                    <div style="flex:1; display:flex; flex-direction:column; gap:4px; min-width:0;">
                        <div class="variant-name" title="${escapeHtml(tooltipText)}" style="font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${name}</div>
                        <div style="font-size:12px; color:#666; display:flex; gap:12px; align-items:center; flex-wrap:wrap;">
                            <span>${model}</span>
                            <span>${variation}</span>
                            <span>${size}</span>
                            <span>${color}</span>
                        </div>
                    </div>
                    <span title="Drag to subprocess" style="font-size:14px; color:#999; flex-shrink:0;">↔</span>
                </label>
            `;
        },

        getStockStatusHTML(variant) {
            const qty = parseInt(variant.quantity) || 0;
            const reorder = parseInt(variant.reorder_level) || 0;
            let statusClass = 'stock-good';
            let statusText = `In Stock (${qty})`;

            if (qty === 0) {
                statusClass = 'stock-out';
                statusText = 'Out of Stock';
            } else if (qty <= reorder) {
                statusClass = 'stock-low';
                statusText = `Low Stock (${qty})`;
            }

            return `<span class="variant-stock ${statusClass}" style="font-size:12px;">${statusText}</span>`;
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

                // If server returned HTML (session expired or error page), guard
                const ct = resp.headers.get('content-type') || '';
                if (ct.includes('text/html')) {
                    resultsEl.innerHTML = '<div style="padding:8px; color:#d32f2f;">Server returned HTML (session?)</div>';
                    console.error('[VariantSearch] Expected JSON but got HTML response');
                    this.loading = false;
                    return;
                }

                const data = await resp.json();
                const items = data.results || [];
                this.hasMore = data.pagination ? !!data.pagination.more : false;

                // If the results container is a table body, render rows (tr); otherwise render compact label blocks
                if (resultsEl.tagName && resultsEl.tagName.toUpperCase() === 'TBODY') {
                    const rowsHtml = items.map(v => {
                        const id = v.id || v.item_id || 0;
                        const name = escapeHtml(v.text || v.name || v.item_name || v.title || 'Unnamed');
                        const variation = escapeHtml(v.variation || v.variant || '');
                        const color = escapeHtml(v.color || '');
                        const size = escapeHtml(v.size || '');
                        return `
                            <tr data-variant-id="${id}">
                                <td><input type="checkbox" data-variant-id="${id}" class="variant-checkbox" /></td>
                                <td>${name}</td>
                                <td>${variation}</td>
                                <td>${color}</td>
                                <td>${size}</td>
                            </tr>
                        `;
                    }).join('');
                    resultsEl.innerHTML = rowsHtml || '<tr><td colspan="5" style="padding:8px; color:#999;">No results</td></tr>';
                } else {
                    resultsEl.innerHTML = items.map(v => this.renderResultRow(v)).join('') || '<div style="padding:8px; color:#999;">No results</div>';
                }
                this.wireResultCheckboxes();
                this.insertToggleButton();
                this.updateToggleButton();
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
                cb.removeEventListener('change', cb._vs_change);
                const handler = (e) => {
                    const id = parseInt(e.target.getAttribute('data-variant-id'));
                    if (e.target.checked) this.selected.add(id); else this.selected.delete(id);
                    this.updateToggleButton();
                };
                cb._vs_change = handler;
                cb.addEventListener('change', handler);
            });
            // Enable drag-and-drop where possible. Support both label-based and table-row based renderings.
            const dragRows = Array.from(container.querySelectorAll('.variant-row')).concat(Array.from(container.querySelectorAll('tr[data-variant-id]')));
            dragRows.forEach(row => {
                row.addEventListener('dragstart', (e) => {
                    const id = parseInt(row.getAttribute('data-variant-id')) || parseInt(row.querySelector('input[type="checkbox"]')?.getAttribute('data-variant-id')) || 0;
                    const name = row.getAttribute('data-variant-name') || row.querySelector('[data-variant-name]')?.getAttribute('data-variant-name') || '';
                    try {
                        e.dataTransfer.effectAllowed = 'copy';
                        if (this.selected.size > 0) {
                            const selectedIds = Array.from(this.selected);
                            e.dataTransfer.setData('application/json', JSON.stringify({ 
                                ids: selectedIds,
                                multiSelect: true
                            }));
                        } else {
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

        insertToggleButton() {
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
                toggleBtn.setAttribute('role', 'button');
                toggleBtn.setAttribute('aria-pressed', 'false');
                toggleBtn.setAttribute('aria-label', 'Select all visible variants');
                toggleBtn.tabIndex = 0;
                resultsContainer.insertBefore(toggleBtn, resultsEl);
                toggleBtn.addEventListener('click', (e) => { e.preventDefault(); this.toggleSelectAll(); });
                toggleBtn.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.toggleSelectAll(); }
                });
            }
        },

        toggleSelectAll() {
            const resultsEl = document.getElementById('variant-search-results');
            if (!resultsEl) return;
            const checkboxes = Array.from(resultsEl.querySelectorAll('input[type="checkbox"]'));
            if (checkboxes.length === 0) return;
            const anySelected = checkboxes.some(cb => cb.checked);
            if (anySelected) {
                checkboxes.forEach(cb => { cb.checked = false; const id = parseInt(cb.getAttribute('data-variant-id')); this.selected.delete(id); });
            } else {
                checkboxes.forEach(cb => { cb.checked = true; const id = parseInt(cb.getAttribute('data-variant-id')); this.selected.add(id); });
            }
            this.updateToggleButton();
        },

        updateToggleButton() {
            const resultsEl = document.getElementById('variant-search-results');
            const toggleBtn = document.getElementById('variant-toggle-select-btn');
            if (!resultsEl || !toggleBtn) return;
            const checkboxes = Array.from(resultsEl.querySelectorAll('input[type="checkbox"]'));
            const anySelected = checkboxes.length > 0 && checkboxes.some(cb => cb.checked);
            const selectedCount = this.selected.size || 0;
            if (anySelected && selectedCount > 0) toggleBtn.textContent = `Unselect All (${selectedCount})`;
            else if (anySelected) toggleBtn.textContent = `Unselect All`;
            else toggleBtn.textContent = 'Select All';
            try { toggleBtn.setAttribute('aria-pressed', anySelected ? 'true' : 'false'); } catch(e){}
        },

        attachEventListeners() {
            const input = document.getElementById('variant-search-input');
            if (input) input.addEventListener('input', this.debounce((e) => this.performSearch(e.target.value || ''), 300));
            const addBtn = document.getElementById('add-selected-variants-btn');
            if (addBtn) addBtn.addEventListener('click', (evt) => {
                const pf = window.processFramework || (typeof processFramework !== 'undefined' ? processFramework : null);
                if (pf) {
                    if (pf.currentInlineSelectedSubprocessId) {
                        if (this.selected.size > 0) {
                            if (typeof pf.confirmBatchAddVariants === 'function') pf.confirmBatchAddVariants();
                            else pf.openBatchAddModal && pf.openBatchAddModal();
                        } else { this.updateToggleButton(); alert('No variants selected. Please select variants to add.'); }
                    } else {
                        try { window.currentProcessIdForSubprocess = pf.currentEditProcessId; if (typeof pf.showSubprocessSelectionModal === 'function') pf.showSubprocessSelectionModal(); else alert('Please select a subprocess on the left, then click Add selected.'); } catch(_) { alert('Please select a subprocess on the left, then click Add selected.'); }
                    }
                } else { alert('Select a process and subprocess first'); }
            });
        },

        async loadCategories() {
            try {
                const response = await fetch('/api/categories', { method: 'GET', credentials: 'include', headers: { 'Accept': 'application/json' } });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const data = await response.json();
                this.categories = Array.isArray(data) ? data : (data.categories || []);
                this.renderCategoryFilter();
            } catch (e) { console.warn('Error loading categories', e); this.categories = []; this.renderCategoryFilter(); }
        },

        renderCategoryFilter() {
            const select = document.getElementById('category-filter');
            if (!select) return;
            try {
                let html = '<option value="">All Categories</option>';
                this.categories.forEach(cat => { const name = escapeHtml(cat.name || 'Unnamed'); const id = cat.id || ''; html += `<option value="${id}">${name}</option>`; });
                select.innerHTML = html;
            } catch(e) { console.error('Error rendering category filter', e); }
        },

        destroy() {},

        init() {
            // Initialize UI bindings and perform an initial empty search
            try {
                this.attachEventListeners();
                // do not block; run an initial refresh to populate UI
                setTimeout(() => { try { this.performSearch(this.lastQuery || ''); } catch(e){} }, 0);
            } catch (e) {
                console.warn('[VariantSearch] init failed', e);
            }
        },

        refresh() { this.performSearch(this.lastQuery || ''); },

        debounce(fn, wait) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), wait); }; }
    };

    // Expose globally
    window.variantSearch = variantSearch;
    // Auto-attach listeners when DOM ready (safe-no-op if elements missing)
    document.addEventListener('DOMContentLoaded', () => variantSearch.attachEventListeners());

})();
