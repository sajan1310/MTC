// Null-safe variant card renderer
function renderVariantCard(variant) {
    // Null safety
    if (!variant) {
        console.warn('Attempted to render null variant');
        return '';
    }
    const variantName = variant.variant_name || 'Unnamed Variant';
    const itemName = variant.item_name || 'Unknown Item';
    const color = variant.color || 'N/A';
    const size = variant.size || 'N/A';
    const sku = variant.sku || 'N/A';
    const rate = variant.rate !== undefined ? `₹${parseFloat(variant.rate).toFixed(2)}` : 'N/A';
    return `
        <div class="variant-card" data-variant-id="${variant.id || ''}">
            <h4>${escapeHtml(variantName)}</h4>
            <p><strong>Item:</strong> ${escapeHtml(itemName)}</p>
            <p><strong>Color:</strong> ${escapeHtml(color)}</p>
            <p><strong>Size:</strong> ${escapeHtml(size)}</p>
            <p><strong>SKU:</strong> ${escapeHtml(sku)}</p>
            <p><strong>Rate:</strong> ${rate}</p>
        </div>
    `;
}

// HTML escaping for security
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
/**
 * Variant Search Component
 * Handles variant searching, filtering, and drag-and-drop initialization
 */

const variantSearch = {
    variants: [],
    filteredVariants: [],
    categories: [],
    searchTimeout: null,

    /**
     * Initialize the variant search component
     */
    async init() {
        console.log('Initializing variant search...');
        await this.loadCategories();
        await this.loadVariants();
    },

    /**
     * Load all categories for filter dropdown
     */
    async loadCategories() {
        try {
            const response = await fetch('/api/categories', {
                method: 'GET',
                credentials: 'include'
            });

            if (response.status === 401) {
                window.location.href = '/auth/login';
                return;
            }

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`Failed to load categories: ${response.status} ${response.statusText}`, errorText);
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            // Handle both array and object responses
            this.categories = Array.isArray(data) ? data : (data.categories || []);
            this.renderCategoryFilter();
        } catch (error) {
            console.error('Error loading categories:', error);
            this.showAlert(`Failed to load categories: ${error.message}`, 'error');
        }
    },

    /**
     * Render category filter dropdown
     */
    renderCategoryFilter() {
        const select = document.getElementById('category-filter');
        if (!select) return;

        let html = '<option value="">All Categories</option>';
        this.categories.forEach(cat => {
            html += `<option value="${cat.id}">${cat.name}</option>`;
        });
        select.innerHTML = html;
    },

    /**
     * Load all variants
     */
    async loadVariants() {
        try {
            const response = await fetch('/api/all-variants', {
                method: 'GET',
                credentials: 'include'
            });

            if (response.status === 401) {
                window.location.href = '/auth/login';
                return;
            }

            if (!response.ok) {
                throw new Error('Failed to load variants');
            }

            const data = await response.json();
            // Handle response format: may be array or object with 'variants' key
            this.variants = Array.isArray(data) ? data : (data.variants || []);
            this.filteredVariants = [...this.variants];
            this.renderVariants();
        } catch (error) {
            console.error('Error loading variants:', error);
            this.showAlert('Failed to load variants', 'error');
        }
    },

    /**
     * Handle search input with debouncing
     */
    handleSearch(event) {
        clearTimeout(this.searchTimeout);
        this.searchTimeout = setTimeout(() => {
            this.applyFilters();
        }, 500);
    },

    /**
     * Apply search and filters
     */
    applyFilters() {
        const searchTerm = document.getElementById('variant-search')?.value.toLowerCase() || '';
        const categoryId = document.getElementById('category-filter')?.value || '';
        const stockFilter = document.getElementById('stock-filter')?.value || '';

        this.filteredVariants = this.variants.filter(variant => {
            // Search filter
            const matchesSearch = !searchTerm ||
                variant.name.toLowerCase().includes(searchTerm) ||
                variant.model.toLowerCase().includes(searchTerm) ||
                variant.brand.toLowerCase().includes(searchTerm);

            // Category filter
            const matchesCategory = !categoryId || variant.category_id == categoryId;

            // Stock filter
            let matchesStock = true;
            if (stockFilter === 'in_stock') {
                matchesStock = variant.quantity > variant.reorder_level;
            } else if (stockFilter === 'low_stock') {
                matchesStock = variant.quantity <= variant.reorder_level && variant.quantity > 0;
            }

            return matchesSearch && matchesCategory && matchesStock;
        });

        this.renderVariants();
    },

    /**
     * Render variant cards
     */
    renderVariants() {
        const container = document.getElementById('variant-list');
        if (!container) return;

        if (this.filteredVariants.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i>🔍</i>
                    <p>No variants found. Try adjusting your search or filters.</p>
                </div>
            `;
            return;
        }

        let html = '';
        this.filteredVariants.forEach(variant => {
            const stockStatus = this.getStockStatus(variant);
            const stockClass = stockStatus.level === 'good' ? 'stock-good' :
                             stockStatus.level === 'low' ? 'stock-low' : 'stock-out';

            html += `
                <div class="variant-card"
                     draggable="true"
                     data-variant-id="${variant.id}"
                     ondragstart="variantSearch.handleDragStart(event, ${variant.id})"
                     ondragend="variantSearch.handleDragEnd(event)">
                    <div class="variant-card-header">
                        <div class="variant-name">${variant.name}</div>
                        <div class="variant-price">$${parseFloat(variant.unit_price || 0).toFixed(2)}</div>
                    </div>
                    <div class="variant-meta">
                        <span>
                            <span class="stock-indicator ${stockClass}"></span>
                            ${stockStatus.text}
                        </span>
                        <span>📦 ${variant.brand || 'N/A'}</span>
                        <span>🏷️ ${variant.model || 'N/A'}</span>
                    </div>
                </div>
            `;
        });

        container.innerHTML = html;
    },

    /**
     * Get stock status for variant
     */
    getStockStatus(variant) {
        const qty = variant.quantity || 0;
        const reorder = variant.reorder_level || 0;

        if (qty === 0) {
            return { level: 'out', text: 'Out of Stock' };
        } else if (qty <= reorder) {
            return { level: 'low', text: `Low Stock (${qty})` };
        } else {
            return { level: 'good', text: `In Stock (${qty})` };
        }
    },

    /**
     * Handle drag start event
     */
    handleDragStart(event, variantId) {
        const variant = this.variants.find(v => v.id === variantId);
        if (!variant) return;

        event.dataTransfer.effectAllowed = 'copy';
        event.dataTransfer.setData('application/json', JSON.stringify(variant));
        event.dataTransfer.setData('text/plain', variant.name);

        const card = event.target;
        card.classList.add('dragging');

        // Optional: Create custom drag image
        const dragImage = card.cloneNode(true);
        dragImage.style.opacity = '0.8';
        document.body.appendChild(dragImage);
        event.dataTransfer.setDragImage(dragImage, 0, 0);
        setTimeout(() => document.body.removeChild(dragImage), 0);
    },

    /**
     * Handle drag end event
     */
    handleDragEnd(event) {
        event.target.classList.remove('dragging');
    },

    /**
     * Show alert message
     */
    showAlert(message, type = 'success') {
        const container = document.getElementById('alert-container');
        if (!container) return;

        const alert = document.createElement('div');
        alert.className = `alert alert-${type}`;
        alert.textContent = message;

        container.appendChild(alert);

        setTimeout(() => {
            alert.remove();
        }, 5000);
    }
};
