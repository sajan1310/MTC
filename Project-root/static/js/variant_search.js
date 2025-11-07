/**
 * Variant Search Component - Select2 Enhanced Version
 * @version 2.0.0
 * @requires jQuery, Select2
 */

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

const variantSearch = {
    select2Instance: null,
    categories: [],
    
    async init() {
        console.log('Initializing Variant Search with Select2...');
        if (!this.checkDependencies()) return;
        await this.loadCategories();
        this.initSelect2();
        this.attachEventListeners();
        console.log('Variant Search initialized successfully');
    },

    checkDependencies() {
        if (typeof jQuery === 'undefined') {
            console.error('jQuery is not loaded! Select2 requires jQuery.');
            return false;
        }
        if (typeof jQuery.fn.select2 === 'undefined') {
            console.error('Select2 is not loaded!');
            return false;
        }
        return true;
    },

    initSelect2() {
        const selectElement = $('#variant-search-select');
        if (selectElement.length === 0) {
            console.warn('Variant search select element not found');
            return;
        }

        try {
            this.select2Instance = selectElement.select2({
                ajax: {
                    url: '/api/variants/select2',
                    dataType: 'json',
                    delay: 250,
                    data: function (params) {
                        return {
                            q: params.term,
                            page: params.page || 1,
                            page_size: 30
                        };
                    },
                    processResults: function (data, params) {
                        params.page = params.page || 1;
                        if (data.error) {
                            console.error('API Error:', data.error);
                            return { results: [], pagination: { more: false } };
                        }
                        return {
                            results: data.results || [],
                            pagination: { more: data.pagination ? data.pagination.more : false }
                        };
                    },
                    cache: true
                },
                placeholder: 'Search for variants...',
                minimumInputLength: 0,
                allowClear: true,
                width: '100%',
                templateResult: this.formatVariant.bind(this),
                templateSelection: this.formatVariantSelection.bind(this)
            });

            selectElement.on('select2:select', (e) => {
                this.onVariantSelected(e.params.data);
            });
            
            console.log('Select2 initialized successfully');
        } catch (error) {
            console.error('Failed to initialize Select2:', error);
        }
    },

    formatVariant(variant) {
        if (variant.loading) return variant.text;
        if (!variant.id) return variant.text;

        try {
            const stockStatus = this.getStockStatusHTML(variant);
            const html = `
                <div class="select2-variant-result">
                    <div class="variant-name">
                        <strong>${escapeHtml(variant.text || variant.item_name || 'Unknown')}</strong>
                    </div>
                    <div class="variant-details">
                        <span class="variant-brand"> ${escapeHtml(variant.brand || 'N/A')}</span>
                        <span class="variant-model"> ${escapeHtml(variant.model || 'N/A')}</span>
                        ${stockStatus}
                    </div>
                </div>
            `;
            return $(html);
        } catch (error) {
            console.error('Error formatting variant:', error);
            return variant.text || 'Error';
        }
    },

    formatVariantSelection(variant) {
        return variant.text || variant.item_name || 'Select a variant';
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

    onVariantSelected(variant) {
        console.log('Variant selected:', variant);
        try {
            const event = new CustomEvent('variantSelected', {
                detail: variant,
                bubbles: true,
                cancelable: true
            });
            document.dispatchEvent(event);

            setTimeout(() => {
                if (this.select2Instance) {
                    $('#variant-search-select').val(null).trigger('change');
                }
            }, 100);
        } catch (error) {
            console.error('Error handling selection:', error);
        }
    },

    attachEventListeners() {
        const categoryFilter = document.getElementById('category-filter');
        if (categoryFilter) {
            categoryFilter.addEventListener('change', () => {
                if (this.select2Instance) {
                    $('#variant-search-select').val(null).trigger('change');
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
        if (this.select2Instance) {
            try {
                $('#variant-search-select').select2('destroy');
                this.select2Instance = null;
            } catch (error) {
                console.error('Error destroying Select2:', error);
            }
        }
    },

    refresh() {
        if (this.select2Instance) {
            try {
                $('#variant-search-select').val(null).trigger('change');
            } catch (error) {
                console.error('Error refreshing Select2:', error);
            }
        }
    }
};
