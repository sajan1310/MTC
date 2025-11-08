/**
 * Subprocess Library Component
 * Manages subprocess templates CRUD operations
 */

const subprocessLibrary = {
    subprocesses: [],
    filteredSubprocesses: [],
    searchTimeout: null,
    deleteTargetId: null,

    /**
     * Initialize the library
     */
    async init() {
        console.log('Initializing subprocess library...');
        await this.loadSubprocesses();
    },

    /**
     * Load all subprocesses
     */
    async loadSubprocesses() {
        try {
            const response = await fetch('/api/upf/subprocesses?per_page=1000', {
                method: 'GET',
                credentials: 'include'
            });

            if (response.status === 401) {
                window.location.href = '/auth/login';
                return;
            }

            if (!response.ok) {
                throw new Error('Failed to load subprocesses');
            }

            const data = await response.json();
            this.subprocesses = data.data?.subprocesses || data.subprocesses || [];
            this.filteredSubprocesses = [...this.subprocesses];
            this.renderGrid();
        } catch (error) {
            console.error('Error loading subprocesses:', error);
            this.showAlert('Failed to load subprocesses', 'error');
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
     * Apply search and filters
     */
    applyFilters() {
        const searchTerm = document.getElementById('search-input')?.value.toLowerCase() || '';
        const category = document.getElementById('category-filter')?.value || '';

        this.filteredSubprocesses = this.subprocesses.filter(sp => {
            const matchesSearch = !searchTerm ||
                sp.name.toLowerCase().includes(searchTerm) ||
                (sp.description && sp.description.toLowerCase().includes(searchTerm));

            const matchesCategory = !category || sp.category === category;

            return matchesSearch && matchesCategory;
        });

        this.renderGrid();
    },

    /**
     * Clear all filters
     */
    clearFilters() {
        document.getElementById('search-input').value = '';
        document.getElementById('category-filter').value = '';
        this.filteredSubprocesses = [...this.subprocesses];
        this.renderGrid();
    },

    /**
     * Render subprocess grid
     */
    renderGrid() {
        const grid = document.getElementById('subprocess-grid');
        if (!grid) return;

        if (this.filteredSubprocesses.length === 0) {
            grid.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">🔍</div>
                    <div class="empty-state-text">No subprocesses found</div>
                    <p>Try adjusting your search or filters</p>
                </div>
            `;
            return;
        }

        let html = '';
        this.filteredSubprocesses.forEach(sp => {
            html += this.renderCard(sp);
        });

        grid.innerHTML = html;
    },

    /**
     * Render a single subprocess card
     */
    renderCard(subprocess) {
        const description = subprocess.description || 'No description provided';
        const time = subprocess.estimated_time_minutes || 0;
        const cost = parseFloat(subprocess.labor_cost || 0).toFixed(2);

        return `
            <div class="subprocess-card">
                <div class="card-header">
                    <div>
                        <h3 class="card-title">${subprocess.name}</h3>
                        <span class="card-category">${subprocess.category}</span>
                    </div>
                    <div class="card-actions">
                        <button class="icon-btn" onclick="subprocessLibrary.editSubprocess(${subprocess.id})" title="Edit">
                            ✏️
                        </button>
                        <button class="icon-btn" onclick="subprocessLibrary.showDeleteModal(${subprocess.id})" title="Delete">
                            🗑️
                        </button>
                    </div>
                </div>
                <div class="card-description">${description}</div>
                <div class="card-meta">
                    <div class="meta-item">
                        <span>⏱️</span>
                        <span>${time} min</span>
                    </div>
                    <div class="meta-item">
                        <span>💰</span>
                        <span>$${cost}</span>
                    </div>
                </div>
            </div>
        `;
    },

    /**
     * Show create modal
     */
    showCreateModal() {
        document.getElementById('modal-title').textContent = 'Create Subprocess';
        document.getElementById('subprocess-form').reset();
        document.getElementById('subprocess-id').value = '';
        document.getElementById('subprocess-modal').style.display = 'block';
    },

    /**
     * Edit subprocess
     */
    async editSubprocess(id) {
        const subprocess = this.subprocesses.find(sp => sp.id === id);
        if (!subprocess) return;

        document.getElementById('modal-title').textContent = 'Edit Subprocess';
        document.getElementById('subprocess-id').value = subprocess.id;
        document.getElementById('subprocess-name').value = subprocess.name;
        document.getElementById('subprocess-category').value = subprocess.category || '';
        document.getElementById('subprocess-description').value = subprocess.description || '';
        document.getElementById('estimated-time').value = subprocess.estimated_time_minutes || 0;
        document.getElementById('labor-cost').value = subprocess.labor_cost || 0;

        document.getElementById('subprocess-modal').style.display = 'block';
    },

    /**
     * Close modal
     */
    closeModal() {
        document.getElementById('subprocess-modal').style.display = 'none';
    },

    /**
     * Handle form submission
     */
    async handleSubmit(event) {
        event.preventDefault();

        // Get ID and ensure it's a valid value or null
        const idValue = document.getElementById('subprocess-id').value;
        const id = idValue && idValue !== 'undefined' && idValue.trim() !== '' ? idValue : null;
        
        const data = {
            name: document.getElementById('subprocess-name').value,
            category: document.getElementById('subprocess-category').value,
            description: document.getElementById('subprocess-description').value,
            estimated_time_minutes: parseInt(document.getElementById('estimated-time').value) || 0,
            labor_cost: parseFloat(document.getElementById('labor-cost').value) || 0
        };

        try {
            const url = id ? `/api/upf/subprocesses/${id}` : '/api/upf/subprocesses';
            const method = id ? 'PUT' : 'POST';

            const response = await fetch(url, {
                method: method,
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': this.getCSRFToken()
                },
                credentials: 'include',
                body: JSON.stringify(data)
            });

            if (response.status === 401) {
                window.location.href = '/auth/login';
                return;
            }

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.message || 'Failed to save subprocess');
            }

            this.showAlert(id ? 'Subprocess updated successfully' : 'Subprocess created successfully', 'success');
            this.closeModal();
            await this.loadSubprocesses();
        } catch (error) {
            console.error('Error saving subprocess:', error);
            this.showAlert(error.message, 'error');
        }
    },

    /**
     * Show delete confirmation modal
     */
    showDeleteModal(id) {
        this.deleteTargetId = id;
        document.getElementById('delete-modal').style.display = 'block';
    },

    /**
     * Close delete modal
     */
    closeDeleteModal() {
        this.deleteTargetId = null;
        document.getElementById('delete-modal').style.display = 'none';
    },

    /**
     * Confirm deletion
     */
    async confirmDelete() {
        if (!this.deleteTargetId) return;

        try {
            const response = await fetch(`/api/upf/subprocesses/${this.deleteTargetId}`, {
                method: 'DELETE',
                headers: {
                    'X-CSRFToken': this.getCSRFToken()
                },
                credentials: 'include'
            });

            if (response.status === 401) {
                window.location.href = '/auth/login';
                return;
            }

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.message || 'Failed to delete subprocess');
            }

            this.showAlert('Subprocess deleted successfully', 'success');
            this.closeDeleteModal();
            await this.loadSubprocesses();
        } catch (error) {
            console.error('Error deleting subprocess:', error);
            this.showAlert(error.message, 'error');
        }
    },

    /**
     * Get CSRF token
     */
    getCSRFToken() {
        return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
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

// Close modals on click outside
window.addEventListener('click', function(event) {
    const subprocessModal = document.getElementById('subprocess-modal');
    const deleteModal = document.getElementById('delete-modal');

    if (event.target === subprocessModal) {
        subprocessLibrary.closeModal();
    }
    if (event.target === deleteModal) {
        subprocessLibrary.closeDeleteModal();
    }
});
