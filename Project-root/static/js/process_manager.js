/**
 * Process Manager - Universal Process Framework
 * Handles CRUD operations for process management page
 */

const processManager = {
    // State
    processes: [],
    currentPage: 1,
    perPage: 25,
    totalPages: 0,
    totalProcesses: 0,
    currentFilters: {
        search: '',
        status: '',
        class: ''
    },
    editingProcessId: null,
    deletingProcessId: null,
    deletingProcessName: '',

    /**
     * Initialize the process manager
     */
    init() {
        console.log('Process Manager initialized');
        this.loadProcesses();
    },

    /**
     * Load processes from API
     */
    async loadProcesses(page = 1) {
        this.currentPage = page;
        this.showLoading();

        try {
            // Build query string
            const params = new URLSearchParams({
                page: this.currentPage,
                per_page: this.perPage
            });

            if (this.currentFilters.status) {
                params.append('status', this.currentFilters.status);
            }

            const response = await fetch(`/api/upf/processes?${params.toString()}`, {
                method: 'GET',
                credentials: 'include'
            });

            if (response.status === 401) {
                window.location.href = '/auth/login';
                return;
            }

            if (!response.ok) {
                throw new Error('Failed to load processes');
            }

            const data = await response.json();
            this.processes = data.processes || [];
            this.totalProcesses = data.total || 0;
            this.totalPages = data.pages || 0;

            this.applyClientSideFilters();
            this.renderTable();
            this.renderPagination();

        } catch (error) {
            console.error('Error loading processes:', error);
            this.showAlert('Failed to load processes. Please try again.', 'error');
            this.hideLoading();
        }
    },

    /**
     * Apply client-side filters (search and class filter)
     */
    applyClientSideFilters() {
        let filtered = [...this.processes];

        // Search filter
        if (this.currentFilters.search) {
            const query = this.currentFilters.search.toLowerCase();
            filtered = filtered.filter(p => 
                p.name.toLowerCase().includes(query) || 
                (p.description && p.description.toLowerCase().includes(query))
            );
        }

        // Class filter
        if (this.currentFilters.class) {
            filtered = filtered.filter(p => p.class === this.currentFilters.class);
        }

        this.processes = filtered;
    },

    /**
     * Render processes table
     */
    renderTable() {
        const tbody = document.getElementById('processes-tbody');
        const table = document.getElementById('processes-table');
        const emptyState = document.getElementById('empty-state');
        const loading = document.getElementById('loading-indicator');

        loading.style.display = 'none';

        if (this.processes.length === 0) {
            table.style.display = 'none';
            emptyState.style.display = 'block';
            document.getElementById('pagination-container').style.display = 'none';
            return;
        }

        emptyState.style.display = 'none';
        table.style.display = 'table';

        tbody.innerHTML = this.processes.map(process => `
            <tr>
                <td>
                    <strong>${this.escapeHtml(process.name)}</strong>
                    ${process.description ? `<br><small style="color: #999;">${this.escapeHtml(process.description).substring(0, 60)}${process.description.length > 60 ? '...' : ''}</small>` : ''}
                </td>
                <td><span class="status-badge">${this.formatClass(process.class)}</span></td>
                <td><span class="status-badge status-${process.status}">${this.formatStatus(process.status)}</span></td>
                <td class="cost-display">$${this.formatCurrency(process.total_worst_case_cost || 0)}</td>
                <td>${this.formatProfitability(process)}</td>
                <td>${this.formatDate(process.created_at)}</td>
                <td>
                    <button class="btn-upf-secondary" onclick="processManager.editProcess(${process.id})" title="Edit Process">
                        ✏️ Edit
                    </button>
                    <button class="btn-upf-secondary" onclick="processManager.viewProcess(${process.id})" title="View Details">
                        👁️ View
                    </button>
                    <button class="btn-upf-danger" onclick="processManager.deleteProcess(${process.id}, '${this.escapeHtml(process.name)}')" title="Delete Process">
                        🗑️
                    </button>
                </td>
            </tr>
        `).join('');
    },

    /**
     * Render pagination controls
     */
    renderPagination() {
        const container = document.getElementById('pagination-container');

        if (this.totalPages <= 1) {
            container.style.display = 'none';
            return;
        }

        container.style.display = 'flex';

        const buttons = [];

        // Previous button
        buttons.push(`
            <button ${this.currentPage === 1 ? 'disabled' : ''} 
                    onclick="processManager.loadProcesses(${this.currentPage - 1})">
                ← Previous
            </button>
        `);

        // Page numbers (show up to 5 pages)
        const startPage = Math.max(1, this.currentPage - 2);
        const endPage = Math.min(this.totalPages, this.currentPage + 2);

        if (startPage > 1) {
            buttons.push(`<button onclick="processManager.loadProcesses(1)">1</button>`);
            if (startPage > 2) {
                buttons.push(`<span style="padding: 8px;">...</span>`);
            }
        }

        for (let i = startPage; i <= endPage; i++) {
            buttons.push(`
                <button class="${i === this.currentPage ? 'page-current' : ''}" 
                        onclick="processManager.loadProcesses(${i})">
                    ${i}
                </button>
            `);
        }

        if (endPage < this.totalPages) {
            if (endPage < this.totalPages - 1) {
                buttons.push(`<span style="padding: 8px;">...</span>`);
            }
            buttons.push(`<button onclick="processManager.loadProcesses(${this.totalPages})">${this.totalPages}</button>`);
        }

        // Next button
        buttons.push(`
            <button ${this.currentPage === this.totalPages ? 'disabled' : ''} 
                    onclick="processManager.loadProcesses(${this.currentPage + 1})">
                Next →
            </button>
        `);

        container.innerHTML = `
            <div>
                ${buttons.join('')}
            </div>
            <div style="color: #999; font-size: 14px;">
                Showing ${this.processes.length} of ${this.totalProcesses} processes
            </div>
        `;
    },

    /**
     * Show create process modal
     */
    showCreateModal() {
        this.editingProcessId = null;
        document.getElementById('modal-title').textContent = 'Create New Process';
        document.getElementById('process-form').reset();
        document.getElementById('process-id').value = '';
        document.getElementById('process-modal').style.display = 'block';
    },

    /**
     * Edit process
     */
    async editProcess(processId) {
        try {
            const response = await fetch(`/api/upf/process/${processId}`, {
                credentials: 'include'
            });

            if (!response.ok) {
                throw new Error('Failed to load process');
            }

            const process = await response.json();

            this.editingProcessId = processId;
            document.getElementById('modal-title').textContent = 'Edit Process';
            document.getElementById('process-id').value = processId;
            document.getElementById('process-name').value = process.name;
            document.getElementById('process-class').value = process.class;
            document.getElementById('process-description').value = process.description || '';
            document.getElementById('process-modal').style.display = 'block';

        } catch (error) {
            console.error('Error loading process:', error);
            this.showAlert('Failed to load process details', 'error');
        }
    },

    /**
     * View process details (redirect to editor)
     */
    viewProcess(processId) {
        window.location.href = `/upf/process/${processId}`;
    },

    /**
     * Delete process (show confirmation)
     */
    deleteProcess(processId, processName) {
        this.deletingProcessId = processId;
        this.deletingProcessName = processName;
        document.getElementById('delete-process-name').textContent = processName;
        document.getElementById('delete-modal').style.display = 'block';
    },

    /**
     * Confirm delete
     */
    async confirmDelete() {
        try {
            const csrf_token = document.querySelector('[name=csrf-token]')?.content;
            
            const response = await fetch(`/api/upf/process/${this.deletingProcessId}`, {
                method: 'DELETE',
                headers: {
                    'X-CSRFToken': csrf_token
                },
                credentials: 'include'
            });

            if (!response.ok) {
                throw new Error('Failed to delete process');
            }

            this.showAlert(`Process "${this.deletingProcessName}" deleted successfully`, 'success');
            this.closeDeleteModal();
            this.loadProcesses(this.currentPage);

        } catch (error) {
            console.error('Error deleting process:', error);
            this.showAlert('Failed to delete process', 'error');
        }
    },

    /**
     * Handle form submit
     */
    async handleSubmit(event) {
        event.preventDefault();

        const processId = document.getElementById('process-id').value;
        const name = document.getElementById('process-name').value.trim();
        const processClass = document.getElementById('process-class').value;
        const description = document.getElementById('process-description').value.trim();

        const data = {
            name,
            class: processClass,
            description: description || null
        };

        try {
            const csrf_token = document.querySelector('[name=csrf-token]')?.content;
            const url = processId ? `/api/upf/process/${processId}` : '/api/upf/process';
            const method = processId ? 'PUT' : 'POST';

            const response = await fetch(url, {
                method,
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': csrf_token
                },
                credentials: 'include',
                body: JSON.stringify(data)
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Failed to save process');
            }

            const result = await response.json();
            this.showAlert(`Process "${result.name}" ${processId ? 'updated' : 'created'} successfully!`, 'success');
            this.closeModal();
            this.loadProcesses(this.currentPage);

        } catch (error) {
            console.error('Error saving process:', error);
            this.showAlert(error.message, 'error');
        }
    },

    /**
     * Close modal
     */
    closeModal() {
        document.getElementById('process-modal').style.display = 'none';
        document.getElementById('process-form').reset();
        this.editingProcessId = null;
    },

    /**
     * Close delete modal
     */
    closeDeleteModal() {
        document.getElementById('delete-modal').style.display = 'none';
        this.deletingProcessId = null;
        this.deletingProcessName = '';
    },

    /**
     * Handle search keyup
     */
    handleSearchKeyup(event) {
        this.currentFilters.search = event.target.value;
        clearTimeout(this.searchTimeout);
        this.searchTimeout = setTimeout(() => {
            this.loadProcesses(1);
        }, 500);
    },

    /**
     * Apply filters
     */
    applyFilters() {
        this.currentFilters.status = document.getElementById('status-filter').value;
        this.currentFilters.class = document.getElementById('class-filter').value;
        this.loadProcesses(1);
    },

    /**
     * Clear filters
     */
    clearFilters() {
        this.currentFilters = { search: '', status: '', class: '' };
        document.getElementById('search-input').value = '';
        document.getElementById('status-filter').value = '';
        document.getElementById('class-filter').value = '';
        this.loadProcesses(1);
    },

    /**
     * Show loading indicator
     */
    showLoading() {
        document.getElementById('loading-indicator').style.display = 'block';
        document.getElementById('processes-table').style.display = 'none';
        document.getElementById('empty-state').style.display = 'none';
    },

    /**
     * Hide loading indicator
     */
    hideLoading() {
        document.getElementById('loading-indicator').style.display = 'none';
    },

    /**
     * Show alert message
     */
    showAlert(message, type = 'info') {
        const container = document.getElementById('alert-container');
        const alert = document.createElement('div');
        alert.className = `alert alert-${type}`;
        alert.textContent = message;
        container.appendChild(alert);

        setTimeout(() => {
            alert.remove();
        }, 5000);
    },

    /**
     * Format currency
     */
    formatCurrency(value) {
        return parseFloat(value || 0).toFixed(2);
    },

    /**
     * Format date
     */
    formatDate(dateString) {
        if (!dateString) return 'N/A';
        const date = new Date(dateString);
        return date.toLocaleDateString('en-US', { 
            year: 'numeric', 
            month: 'short', 
            day: 'numeric' 
        });
    },

    /**
     * Format status
     */
    formatStatus(status) {
        return status.charAt(0).toUpperCase() + status.slice(1);
    },

    /**
     * Format class
     */
    formatClass(className) {
        return className.charAt(0).toUpperCase() + className.slice(1);
    },

    /**
     * Format profitability
     */
    formatProfitability(process) {
        if (!process.profit_margin) {
            return '<span style="color: #999;">Not set</span>';
        }
        const margin = parseFloat(process.profit_margin);
        const color = margin > 20 ? '#4CAF50' : margin > 10 ? '#FF9800' : '#f44336';
        return `<span style="color: ${color}; font-weight: 600;">${margin.toFixed(1)}%</span>`;
    },

    /**
     * Escape HTML
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
};

// Close modals when clicking outside
window.onclick = function(event) {
    const processModal = document.getElementById('process-modal');
    const deleteModal = document.getElementById('delete-modal');
    
    if (event.target === processModal) {
        processManager.closeModal();
    }
    if (event.target === deleteModal) {
        processManager.closeDeleteModal();
    }
};
