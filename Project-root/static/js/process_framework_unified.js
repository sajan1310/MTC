const processFramework = {
    currentTab: 'processes',

    processes: {
        all: [],
        filtered: [],
        searchTimeout: null,

        async load() {
            try {
                const response = await fetch('/api/upf/processes?per_page=1000', {
                    method: 'GET',
                    credentials: 'include'
                });
                if (response.status === 401) {
                    window.location.href = '/auth/login';
                    return;
                }
                const data = await response.json();
                this.all = data.processes || [];
                this.filtered = [...this.all];
                this.render();
            } catch (error) {
                console.error('Error loading processes:', error);
                processFramework.showAlert('Failed to load processes', 'error');
            }
        },

        handleSearch() {
            clearTimeout(this.searchTimeout);
            this.searchTimeout = setTimeout(() => this.applyFilters(), 500);
        },

        applyFilters() {
            const searchTerm = document.getElementById('process-search').value.toLowerCase();
            const statusFilter = document.getElementById('process-status-filter').value;
            const classFilter = document.getElementById('process-class-filter').value;

            this.filtered = this.all.filter(process => {
                const matchesSearch = !searchTerm ||
                    process.name.toLowerCase().includes(searchTerm) ||
                    (process.description && process.description.toLowerCase().includes(searchTerm));
                const matchesStatus = !statusFilter || process.status === statusFilter;
                const matchesClass = !classFilter || process.class === classFilter;
                return matchesSearch && matchesStatus && matchesClass;
            });

            this.render();
        },

        render() {
            const grid = document.getElementById('processes-grid');
            if (this.filtered.length === 0) {
                grid.innerHTML = `
                    <div class="empty-state">
                        <div class="empty-state-icon">📋</div>
                        <p>No processes found</p>
                    </div>
                `;
                return;
            }

            grid.innerHTML = this.filtered.map(process => `
                <div class="card" onclick="processFramework.processes.viewDetail(${process.id})">
                    <div class="card-header">
                        <div>
                            <h3 class="card-title">${this.escapeHtml(process.name)}</h3>
                            <span class="card-badge badge-${process.status.toLowerCase()}">${process.status}</span>
                            <span class="card-badge badge-category">${process.class}</span>
                        </div>
                        <div class="card-actions" onclick="event.stopPropagation()">
                            <button class="icon-btn" onclick="processFramework.processes.edit(${process.id})" title="Edit">✏️</button>
                            <button class="icon-btn" onclick="processFramework.processes.confirmDelete(${process.id})" title="Delete">🗑️</button>
                        </div>
                    </div>
                    <p class="card-description">${this.escapeHtml(process.description || 'No description')}</p>
                    <div class="card-meta">
                        <div class="meta-item">
                            <span>⚙️</span>
                            <span>${process.subprocess_count || 0} subprocesses</span>
                        </div>
                        <div class="meta-item">
                            <span>💰</span>
                            <span>$${(parseFloat(process.worst_case_cost) || 0).toFixed(2)}</span>
                        </div>
                    </div>
                </div>
            `).join('');
        },

        showCreateModal() {
            document.getElementById('process-modal-title').textContent = 'Create Process';
            document.getElementById('process-form').reset();
            document.getElementById('process-id').value = '';
            processFramework.openModal('process-modal');
        },

        async edit(id) {
            try {
                const response = await fetch(`/api/upf/processes/${id}`, {
                    method: 'GET',
                    credentials: 'include'
                });
                if (response.status === 401) {
                    window.location.href = '/auth/login';
                    return;
                }
                const data = await response.json();

                document.getElementById('process-modal-title').textContent = 'Edit Process';
                document.getElementById('process-id').value = data.id;
                document.getElementById('process-name').value = data.name;
                document.getElementById('process-class').value = data.class;
                document.getElementById('process-description').value = data.description || '';
                processFramework.openModal('process-modal');
            } catch (error) {
                console.error('Error loading process:', error);
                processFramework.showAlert('Failed to load process', 'error');
            }
        },

        async handleSubmit(event) {
            event.preventDefault();

            const id = document.getElementById('process-id').value;
            // Ensure process_class is capitalized to match allowed DB values
            let processClass = document.getElementById('process-class').value;
            if (processClass) {
                processClass = processClass.charAt(0).toUpperCase() + processClass.slice(1).toLowerCase();
            }

            // Build form data with validation
            const formData = {
                name: document.getElementById('process-name').value,
                class: processClass,
                description: document.getElementById('process-description').value || null,
                status: 'Active'
            };

            // Validation: Ensure required fields are present
            if (!formData.name || !formData.name.trim()) {
                processFramework.showAlert('Process name is required', 'error');
                return;
            }

            if (!formData.class) {
                processFramework.showAlert('Process class is required', 'error');
                return;
            }

            try {
                const url = id ? `/api/upf/processes/${id}` : '/api/upf/processes';
                const method = id ? 'PUT' : 'POST';

                // Log the request for debugging
                console.log('[Process Submit] Request:', {
                    url,
                    method,
                    payload: formData
                });

                // Validate JSON serialization
                let jsonBody;
                try {
                    jsonBody = JSON.stringify(formData);
                } catch (jsonError) {
                    console.error('[Process Submit] JSON serialization error:', jsonError);
                    processFramework.showAlert('Invalid form data. Please check your inputs.', 'error');
                    return;
                }

                const response = await fetch(url, {
                    method: method,
                    credentials: 'include',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    body: jsonBody
                });

                console.log('[Process Submit] Response status:', response.status);

                if (response.status === 401) {
                    window.location.href = '/auth/login';
                    return;
                }

                if (response.ok) {
                    const result = await response.json();
                    console.log('[Process Submit] Success:', result);
                    processFramework.closeModal('process-modal');
                    processFramework.showAlert(`Process ${id ? 'updated' : 'created'} successfully`, 'success');
                    await this.load();
                } else {
                    // Parse error response
                    let errorMessage = 'Failed to save process';
                    try {
                        const error = await response.json();
                        console.error('[Process Submit] Error response:', error);
                        errorMessage = error.error || error.message || errorMessage;

                        // Display detailed validation errors if available
                        if (error.details) {
                            errorMessage += ': ' + error.details;
                        }
                    } catch (parseError) {
                        // If response is not JSON, try to get text
                        const errorText = await response.text();
                        console.error('[Process Submit] Non-JSON error response:', errorText);
                        errorMessage = `Server error (${response.status}): ${errorText.substring(0, 100)}`;
                    }

                    processFramework.showAlert(errorMessage, 'error');
                }
            } catch (error) {
                console.error('[Process Submit] Network or unexpected error:', error);
                processFramework.showAlert('Network error: Failed to save process. Please check your connection.', 'error');
            }
        },

        async confirmDelete(id) {
            if (!confirm('Are you sure you want to delete this process?')) return;

            try {
                const response = await fetch(`/api/upf/processes/${id}`, {
                    method: 'DELETE',
                    credentials: 'include'
                });

                if (response.status === 401) {
                    window.location.href = '/auth/login';
                    return;
                }

                if (response.ok) {
                    processFramework.showAlert('Process deleted successfully', 'success');
                    await this.load();
                } else {
                    const error = await response.json();
                    processFramework.showAlert(error.error || 'Failed to delete process', 'error');
                }
            } catch (error) {
                console.error('Error deleting process:', error);
                processFramework.showAlert('Failed to delete process', 'error');
            }
        },

        viewDetail(id) {
            window.location.href = `/upf/process/${id}`;
        },

        escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
    },

    subprocesses: {
        all: [],
        filtered: [],
        searchTimeout: null,

        async load() {
            try {
                const response = await fetch('/api/upf/subprocesses?per_page=1000', {
                    method: 'GET',
                    credentials: 'include'
                });
                if (response.status === 401) {
                    window.location.href = '/auth/login';
                    return;
                }
                const data = await response.json();
                this.all = data.subprocesses || [];
                this.filtered = [...this.all];
                this.render();
            } catch (error) {
                console.error('Error loading subprocesses:', error);
                processFramework.showAlert('Failed to load subprocesses', 'error');
            }
        },

        handleSearch() {
            clearTimeout(this.searchTimeout);
            this.searchTimeout = setTimeout(() => this.applyFilters(), 500);
        },

        applyFilters() {
            const searchTerm = document.getElementById('subprocess-search').value.toLowerCase();
            const categoryFilter = document.getElementById('subprocess-category-filter').value;

            this.filtered = this.all.filter(subprocess => {
                const matchesSearch = !searchTerm ||
                    subprocess.name.toLowerCase().includes(searchTerm) ||
                    (subprocess.description && subprocess.description.toLowerCase().includes(searchTerm));
                const matchesCategory = !categoryFilter || subprocess.category === categoryFilter;
                return matchesSearch && matchesCategory;
            });

            this.render();
        },

        render() {
            const grid = document.getElementById('subprocesses-grid');
            if (this.filtered.length === 0) {
                grid.innerHTML = `
                    <div class="empty-state">
                        <div class="empty-state-icon">⚙️</div>
                        <p>No subprocesses found</p>
                    </div>
                `;
                return;
            }

            grid.innerHTML = this.filtered.map(subprocess => `
                <div class="card">
                    <div class="card-header">
                        <div>
                            <h3 class="card-title">${this.escapeHtml(subprocess.name)}</h3>
                            <span class="card-badge badge-category">${subprocess.category}</span>
                        </div>
                        <div class="card-actions">
                            <button class="icon-btn" onclick="processFramework.subprocesses.edit(${subprocess.id})" title="Edit">✏️</button>
                            <button class="icon-btn" onclick="processFramework.subprocesses.confirmDelete(${subprocess.id})" title="Delete">🗑️</button>
                        </div>
                    </div>
                    <p class="card-description">${this.escapeHtml(subprocess.description || 'No description')}</p>
                    <div class="card-meta">
                        <div class="meta-item">
                            <span>⏱️</span>
                            <span>${subprocess.estimated_time_minutes || 0} min</span>
                        </div>
                        <div class="meta-item">
                            <span>💰</span>
                            <span>$${(parseFloat(subprocess.labor_cost) || 0).toFixed(2)}</span>
                        </div>
                    </div>
                </div>
            `).join('');
        },

        showCreateModal() {
            document.getElementById('subprocess-modal-title').textContent = 'Create Subprocess';
            document.getElementById('subprocess-form').reset();
            document.getElementById('subprocess-id').value = '';
            processFramework.openModal('subprocess-modal');
        },

        async edit(id) {
            try {
                const response = await fetch(`/api/upf/subprocesses/${id}`, {
                    method: 'GET',
                    credentials: 'include'
                });
                if (response.status === 401) {
                    window.location.href = '/auth/login';
                    return;
                }
                const data = await response.json();

                document.getElementById('subprocess-modal-title').textContent = 'Edit Subprocess';
                document.getElementById('subprocess-id').value = data.id;
                document.getElementById('subprocess-name').value = data.name;
                document.getElementById('subprocess-category').value = data.category;
                document.getElementById('subprocess-description').value = data.description || '';
                document.getElementById('estimated-time').value = data.estimated_time_minutes || 0;
                document.getElementById('labor-cost').value = data.labor_cost || 0;
                processFramework.openModal('subprocess-modal');
            } catch (error) {
                console.error('Error loading subprocess:', error);
                processFramework.showAlert('Failed to load subprocess', 'error');
            }
        },

        async handleSubmit(event) {
            event.preventDefault();

            const id = document.getElementById('subprocess-id').value;
            const formData = {
                name: document.getElementById('subprocess-name').value,
                category: document.getElementById('subprocess-category').value,
                description: document.getElementById('subprocess-description').value || null,
                estimated_time_minutes: parseInt(document.getElementById('estimated-time').value) || 0,
                labor_cost: parseFloat(document.getElementById('labor-cost').value) || 0
            };

            // Validation: Ensure required fields are present
            if (!formData.name || !formData.name.trim()) {
                processFramework.showAlert('Subprocess name is required', 'error');
                return;
            }

            if (!formData.category) {
                processFramework.showAlert('Subprocess category is required', 'error');
                return;
            }

            try {
                const url = id ? `/api/upf/subprocesses/${id}` : '/api/upf/subprocesses';
                const method = id ? 'PUT' : 'POST';

                // Log the request for debugging
                console.log('[Subprocess Submit] Request:', {
                    url,
                    method,
                    payload: formData
                });

                // Validate JSON serialization
                let jsonBody;
                try {
                    jsonBody = JSON.stringify(formData);
                } catch (jsonError) {
                    console.error('[Subprocess Submit] JSON serialization error:', jsonError);
                    processFramework.showAlert('Invalid form data. Please check your inputs.', 'error');
                    return;
                }

                const response = await fetch(url, {
                    method: method,
                    credentials: 'include',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    body: jsonBody
                });

                console.log('[Subprocess Submit] Response status:', response.status);

                if (response.status === 401) {
                    window.location.href = '/auth/login';
                    return;
                }

                if (response.ok) {
                    const result = await response.json();
                    console.log('[Subprocess Submit] Success:', result);
                    processFramework.closeModal('subprocess-modal');
                    processFramework.showAlert(`Subprocess ${id ? 'updated' : 'created'} successfully`, 'success');
                    await this.load();
                } else {
                    // Parse error response
                    let errorMessage = 'Failed to save subprocess';
                    try {
                        const error = await response.json();
                        console.error('[Subprocess Submit] Error response:', error);
                        errorMessage = error.error || error.message || errorMessage;

                        // Display detailed validation errors if available
                        if (error.details) {
                            errorMessage += ': ' + error.details;
                        }
                    } catch (parseError) {
                        // If response is not JSON, try to get text
                        const errorText = await response.text();
                        console.error('[Subprocess Submit] Non-JSON error response:', errorText);
                        errorMessage = `Server error (${response.status}): ${errorText.substring(0, 100)}`;
                    }

                    processFramework.showAlert(errorMessage, 'error');
                }
            } catch (error) {
                console.error('[Subprocess Submit] Network or unexpected error:', error);
                processFramework.showAlert('Network error: Failed to save subprocess. Please check your connection.', 'error');
            }
        },

        async confirmDelete(id) {
            if (!confirm('Are you sure you want to delete this subprocess?')) return;

            try {
                const response = await fetch(`/api/upf/subprocesses/${id}`, {
                    method: 'DELETE',
                    credentials: 'include'
                });

                if (response.status === 401) {
                    window.location.href = '/auth/login';
                    return;
                }

                if (response.ok) {
                    processFramework.showAlert('Subprocess deleted successfully', 'success');
                    await this.load();
                } else {
                    const error = await response.json();
                    processFramework.showAlert(error.error || 'Failed to delete subprocess', 'error');
                }
            } catch (error) {
                console.error('Error deleting subprocess:', error);
                processFramework.showAlert('Failed to delete subprocess', 'error');
            }
        },

        escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
    },

    production: {
        all: [],
        filtered: [],
        searchTimeout: null,

        async load() {
            try {
                const response = await fetch('/api/upf/production-lots?per_page=1000', {
                    method: 'GET',
                    credentials: 'include'
                });
                if (response.status === 401) {
                    window.location.href = '/auth/login';
                    return;
                }
                const data = await response.json();
                this.all = data.production_lots || [];
                this.filtered = [...this.all];
                this.render();
            } catch (error) {
                console.error('Error loading production lots:', error);
                processFramework.showAlert('Failed to load production lots', 'error');
            }
        },

        handleSearch() {
            clearTimeout(this.searchTimeout);
            this.searchTimeout = setTimeout(() => this.applyFilters(), 500);
        },

        applyFilters() {
            const searchTerm = document.getElementById('lot-search').value.toLowerCase();
            const statusFilter = document.getElementById('lot-status-filter').value;

            this.filtered = this.all.filter(lot => {
                const matchesSearch = !searchTerm ||
                    lot.lot_number.toLowerCase().includes(searchTerm) ||
                    (lot.process_name && lot.process_name.toLowerCase().includes(searchTerm));
                const matchesStatus = !statusFilter || lot.status === statusFilter;
                return matchesSearch && matchesStatus;
            });

            this.render();
        },

        render() {
            const tbody = document.getElementById('lots-table-body');
            if (this.filtered.length === 0) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="6" class="empty-state">No production lots found</td>
                    </tr>
                `;
                return;
            }

            tbody.innerHTML = this.filtered.map(lot => `
                <tr onclick="processFramework.production.viewDetail(${lot.id})" style="cursor: pointer;">
                    <td><strong>${lot.lot_number}</strong></td>
                    <td>${this.escapeHtml(lot.process_name || 'N/A')}</td>
                    <td>${lot.quantity || 0}</td>
                    <td><span class="card-badge badge-${lot.status.toLowerCase().replace(' ', '-')}">${lot.status}</span></td>
                    <td>$${(parseFloat(lot.total_cost) || 0).toFixed(2)}</td>
                    <td>${new Date(lot.created_at).toLocaleDateString()}</td>
                </tr>
            `).join('');
        },

        createNew() {
            window.location.href = '/upf/production-lot/new';
        },

        viewDetail(id) {
            window.location.href = `/upf/production-lot/${id}`;
        },

        escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
    },

    reports: {
        async load() {
            await Promise.all([
                this.loadMetrics(),
                this.loadTopProcesses(),
                this.loadRecentLots()
            ]);
        },

        async loadMetrics() {
            try {
                const [processesRes, lotsRes] = await Promise.all([
                    fetch('/api/upf/processes?per_page=1000', { credentials: 'include' }),
                    fetch('/api/upf/production-lots?per_page=1000', { credentials: 'include' })
                ]);

                const processesData = await processesRes.json();
                const lotsData = await lotsRes.json();

                const processes = processesData.processes || [];
                const lots = lotsData.production_lots || [];

                document.getElementById('total-processes').textContent = processes.length;
                document.getElementById('total-lots').textContent = lots.length;

                const completedLots = lots.filter(l => l.status === 'Completed');
                document.getElementById('completed-lots').textContent = completedLots.length;

                const avgCost = lots.length > 0
                    ? lots.reduce((sum, l) => sum + (parseFloat(l.total_cost) || 0), 0) / lots.length
                    : 0;
                document.getElementById('avg-cost').textContent = '$' + (parseFloat(avgCost) || 0).toFixed(2);
            } catch (error) {
                console.error('Error loading metrics:', error);
            }
        },

        async loadTopProcesses() {
            try {
                const response = await fetch('/api/upf/processes?per_page=1000', { credentials: 'include' });
                const data = await response.json();
                const processes = data.processes || [];

                const sorted = processes
                    .filter(p => p.worst_case_cost > 0)
                    .sort((a, b) => b.worst_case_cost - a.worst_case_cost)
                    .slice(0, 5);

                const container = document.getElementById('top-processes-list');
                if (sorted.length === 0) {
                    container.innerHTML = '<p style="color: #999; text-align: center; padding: 40px;">No process cost data available</p>';
                    return;
                }

                container.innerHTML = sorted.map((p, i) => `
                    <div style="padding: 12px; border-bottom: 1px solid #f0f0f0; display: flex; justify-content: space-between; align-items: center;">
                        <div>
                            <strong>${i + 1}. ${this.escapeHtml(p.name)}</strong>
                            <span style="color: #666; font-size: 12px; margin-left: 8px;">${p.class}</span>
                        </div>
                        <strong style="color: #4CAF50;">$${(parseFloat(p.worst_case_cost) || 0).toFixed(2)}</strong>
                    </div>
                `).join('');
            } catch (error) {
                console.error('Error loading top processes:', error);
            }
        },

        async loadRecentLots() {
            try {
                const response = await fetch('/api/upf/production-lots?per_page=5', { credentials: 'include' });
                const data = await response.json();
                const lots = data.production_lots || [];

                const container = document.getElementById('recent-lots-list');
                if (lots.length === 0) {
                    container.innerHTML = '<p style="color: #999; text-align: center; padding: 40px;">No production lots yet</p>';
                    return;
                }

                container.innerHTML = lots.map(lot => `
                    <div style="padding: 12px; border-bottom: 1px solid #f0f0f0;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
                            <strong>${lot.lot_number}</strong>
                            <span class="card-badge badge-${lot.status.toLowerCase().replace(' ', '-')}">${lot.status}</span>
                        </div>
                        <div style="color: #666; font-size: 13px;">
                            ${this.escapeHtml(lot.process_name || 'N/A')} • Qty: ${lot.quantity || 0} • $${(parseFloat(lot.total_cost) || 0).toFixed(2)}
                        </div>
                    </div>
                `).join('');
            } catch (error) {
                console.error('Error loading recent lots:', error);
            }
        },

        escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
    },

    async init() {
        await this.switchTab('processes');
        this.updateHeaderActions();
    },

    async switchTab(tabName) {
        // Update active tab button
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');

        // Update active tab content
        document.querySelectorAll('.tab-content').forEach(content => {
            content.classList.remove('active');
        });
        document.getElementById(`tab-${tabName}`).classList.add('active');

        this.currentTab = tabName;
        this.updateHeaderActions();

        // Load data for the active tab
        switch(tabName) {
            case 'processes':
                await this.processes.load();
                break;
            case 'subprocesses':
                await this.subprocesses.load();
                break;
            case 'production':
                await this.production.load();
                break;
            case 'reports':
                await this.reports.load();
                break;
        }
    },

    updateHeaderActions() {
        const container = document.getElementById('header-actions');

        switch(this.currentTab) {
            case 'processes':
                container.innerHTML = '<button class="btn btn-primary" onclick="processFramework.processes.showCreateModal()">+ Create Process</button>';
                break;
            case 'subprocesses':
                container.innerHTML = '<button class="btn btn-primary" onclick="processFramework.subprocesses.showCreateModal()">+ Create Subprocess</button>';
                break;
            case 'production':
                container.innerHTML = '<button class="btn btn-primary" onclick="processFramework.production.createNew()">+ New Production Lot</button>';
                break;
            case 'reports':
                container.innerHTML = '';
                break;
        }
    },

    openModal(modalId) {
        document.getElementById(modalId).style.display = 'block';
    },

    closeModal(modalId) {
        document.getElementById(modalId).style.display = 'none';
    },

    showAlert(message, type) {
        const container = document.getElementById('alert-container');
        const alert = document.createElement('div');
        alert.className = `alert alert-${type}`;
        alert.textContent = message;
        container.appendChild(alert);

        setTimeout(() => {
            alert.remove();
        }, 5000);
    }
};

// Close modals when clicking outside
window.onclick = function(event) {
    if (event.target.classList.contains('modal')) {
        event.target.style.display = 'none';
    }
};
