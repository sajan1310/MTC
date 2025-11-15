/**
 * Production Lots Component
 * Manages production lot list and navigation
 */

const productionLots = {
    lots: [],
    filteredLots: [],
    processes: [],
    currentPage: 1,
    perPage: 25,
    totalPages: 1,
    searchTimeout: null,

    /**
     * Initialize
     */
    async init() {
        console.log('Initializing production lots...');
        await this.loadProcesses();
        await this.loadLots();
    },

    /**
     * Load processes for filter
     */
    async loadProcesses() {
        try {
            const response = await fetch('/api/upf/processes?per_page=1000', {
                method: 'GET',
                credentials: 'include'
            });

            if (response.ok) {
                const data = await response.json();
                this.processes = data.data?.processes || data.processes || [];
                this.renderProcessFilter();
            }
        } catch (error) {
            console.error('Error loading processes:', error);
        }
    },

    /**
     * Render process filter dropdown
     */
    renderProcessFilter() {
        const select = document.getElementById('process-filter');
        if (!select) return;

        let html = '<option value="">All Processes</option>';
        this.processes.forEach(p => {
            html += `<option value="${p.id}">${p.name}</option>`;
        });
        select.innerHTML = html;
    },

    /**
     * Load production lots
     */
    async loadLots(page = 1) {
        try {
            const response = await fetch(`/api/upf/production-lots?page=${page}&per_page=${this.perPage}`, {
                method: 'GET',
                credentials: 'include'
            });

            if (response.status === 401) {
                window.location.href = '/auth/login';
                return;
            }

            if (!response.ok) {
                throw new Error('Failed to load production lots');
            }

            const data = await response.json();
            this.lots = data.data?.production_lots || data.production_lots || [];
            this.currentPage = data.data?.page || data.page || 1;
            this.totalPages = data.data?.pages || data.pages || 1;
            this.filteredLots = [...this.lots];

            this.renderTable();
            this.renderPagination();
        } catch (error) {
            console.error('Error loading lots:', error);
            this.showAlert('Failed to load production lots', 'error');
        }
    },

    /**
     * Handle search with debouncing
     */
    handleSearch() {
        clearTimeout(this.searchTimeout);
        this.searchTimeout = setTimeout(() => {
            this.applyFilters();
        }, 500);
    },

    /**
     * Apply filters
     */
    applyFilters() {
        const searchTerm = document.getElementById('search-input')?.value.toLowerCase() || '';
        const status = document.getElementById('status-filter')?.value || '';
        const processId = document.getElementById('process-filter')?.value || '';

        this.filteredLots = this.lots.filter(lot => {
            const lotNumber = (lot.lot_number || '').toString().toLowerCase();
            const processName = (lot.process_name || '').toString().toLowerCase();

            const matchesSearch = !searchTerm ||
                lotNumber.includes(searchTerm) ||
                processName.includes(searchTerm);

            const matchesStatus = !status || String(lot.status || '') === String(status);
            const matchesProcess = !processId || String(lot.process_id || '') == String(processId);

            return matchesSearch && matchesStatus && matchesProcess;
        });

        this.renderTable();
    },

    /**
     * Render table
     */
    renderTable() {
        const tbody = document.getElementById('lots-table-body');
        if (!tbody) return;

        if (this.filteredLots.length === 0) {
            const isFiltered = document.getElementById('search-input')?.value || 
                             document.getElementById('status-filter')?.value ||
                             document.getElementById('process-filter')?.value;
            
            if (isFiltered) {
                // Filtered results are empty
                tbody.innerHTML = `
                    <tr>
                        <td colspan="8" class="empty-state">
                            <div style="font-size: 48px; margin-bottom: 15px;">🔍</div>
                            <div style="font-size: 18px; margin-bottom: 10px;">No production lots match your filters</div>
                            <p style="color: #999;">Try adjusting your search term, status, or process filter</p>
                        </td>
                    </tr>
                `;
            } else {
                // No production lots at all
                tbody.innerHTML = `
                    <tr>
                        <td colspan="8" class="empty-state">
                            <div style="font-size: 48px; margin-bottom: 15px;">📦</div>
                            <div style="font-size: 18px; margin-bottom: 10px;">No production lots yet</div>
                            <p style="color: #999; margin-bottom: 20px;">Create your first production lot to start manufacturing</p>
                            <button class="btn btn-primary" onclick="productionLots.createNew()">
                                ➕ Create Your First Production Lot
                            </button>
                        </td>
                    </tr>
                `;
            }
            return;
        }

        let html = '';
        this.filteredLots.forEach(lot => {
            const statusText = lot.status || '';
            const statusClass = `status-${statusText.toString().toLowerCase().replace(/\s+/g, '-')}`;
            const cost = (lot.total_cost != null) ? `$${Number(lot.total_cost).toFixed(2)}` : 'Not Set';
            const createdAt = lot.created_at ? new Date(lot.created_at).toLocaleDateString() : '';

            html += `
                <tr onclick="productionLots.viewDetail(${lot.id})">
                    <td><span class="lot-number">${lot.lot_number || ''}</span></td>
                    <td>${lot.process_name || ''}</td>
                    <td>${lot.quantity != null ? lot.quantity : ''}</td>
                    <td><span class="status-badge ${statusClass}">${statusText}</span></td>
                    <td>${renderAlertsCell(lot)}</td>
                    <td>${cost}</td>
                    <td>${lot.created_by_name || 'System'}</td>
                    <td>${createdAt}</td>
                </tr>
            `;
        });

        tbody.innerHTML = html;
    },

    /**
     * Render pagination
     */
    renderPagination() {
        const container = document.getElementById('pagination');
        if (!container || this.totalPages <= 1) {
            container.innerHTML = '';
            return;
        }

        let html = `
            <button class="page-btn"
                    onclick="productionLots.loadLots(${this.currentPage - 1})"
                    ${this.currentPage === 1 ? 'disabled' : ''}>
                ← Previous
            </button>
        `;

        // Show page numbers
        for (let i = 1; i <= this.totalPages; i++) {
            if (
                i === 1 ||
                i === this.totalPages ||
                (i >= this.currentPage - 2 && i <= this.currentPage + 2)
            ) {
                html += `
                    <button class="page-btn ${i === this.currentPage ? 'active' : ''}"
                            onclick="productionLots.loadLots(${i})">
                        ${i}
                    </button>
                `;
            } else if (i === this.currentPage - 3 || i === this.currentPage + 3) {
                html += '<span style="padding: 0 5px;">...</span>';
            }
        }

        html += `
            <button class="page-btn"
                    onclick="productionLots.loadLots(${this.currentPage + 1})"
                    ${this.currentPage === this.totalPages ? 'disabled' : ''}>
                Next →
            </button>
        `;

        container.innerHTML = html;
    },

    /**
     * Create new production lot
     */
    createNew() {
        window.location.href = '/upf/production-lot/new';
    },

    /**
     * View lot detail
     */
    viewDetail(lotId) {
        window.location.href = `/upf/production-lot/${lotId}`;
    },

    /**
     * Show alert
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

function renderAlertsCell(lot) {
    // Expect enriched lots may have alerts_summary from service
    const summary = lot.alerts_summary || lot.alert_summary || {}; // fallback
    const bySeverity = summary.by_severity || summary.alerts_by_severity || {};
    const total = summary.total_alerts || summary.total || lot.total_alerts || 0;
    if (!total) return '<span style="color:#888">None</span>';
    const sevOrder = ['CRITICAL','HIGH','MEDIUM','LOW'];
    const parts = sevOrder.filter(s => bySeverity[s] > 0).map(s => `<span class="severity-badge ${s}" style="margin-right:4px;">${s[0]}:${bySeverity[s]}</span>`);
    return parts.join('') || total;
}

// Expose helper to global scope for pages that may reuse it
try {
    window.renderAlertsCell = renderAlertsCell;
} catch (e) {
    // ignore in non-browser contexts
}

// Attach some helpful DOM bindings so filters/search work without inline handlers
document.addEventListener('DOMContentLoaded', function() {
    try {
        productionLots.init();
    } catch (e) {
        console.warn('productionLots.init() failed to run automatically:', e);
    }

    const search = document.getElementById('search-input');
    if (search) search.addEventListener('input', () => productionLots.handleSearch());

    const status = document.getElementById('status-filter');
    if (status) status.addEventListener('change', () => productionLots.applyFilters());

    const process = document.getElementById('process-filter');
    if (process) process.addEventListener('change', () => productionLots.applyFilters());
});
