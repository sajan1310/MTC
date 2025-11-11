const processFramework = {
    currentTab: 'processes',

    // Centralized error handler - shows user-friendly messages in UI
    handleError(error, context = '', fallbackMessage = 'An error occurred') {
        const userMessage = error?.message || fallbackMessage;
        this.showAlert(`${context ? context + ': ' : ''}${userMessage}`, 'error');
        
        // Still log to console for debugging, but only in development
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
            console.error(`[${context || 'Error'}]`, error);
        }
    },

    processes: {
        all: [],
        filtered: [],
        searchTimeout: null,

        async load() {
            try {
                // Use centralized API client with caching
                this.all = await window.upfApi.getProcesses({ perPage: 1000 });
                this.filtered = [...this.all];
                this.render();
            } catch (error) {
                processFramework.handleError(error, 'Load Processes', 'Failed to load processes');
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
            
            if (!grid) {
                processFramework.handleError(
                    new Error('processes-grid element not found'),
                    'Render Processes',
                    'Unable to display processes - page element missing'
                );
                return;
            }
            
            if (this.filtered.length === 0) {
                const isFiltered = document.getElementById('process-search')?.value || 
                                 document.getElementById('process-status-filter')?.value ||
                                 document.getElementById('process-class-filter')?.value;
                
                if (isFiltered) {
                    // Filtered results are empty
                    grid.innerHTML = `
                        <div class="empty-state">
                            <div class="empty-state-icon">🔍</div>
                            <p>No processes match your filters</p>
                            <p style="color: #999; font-size: 14px;">Try adjusting your search or filters</p>
                        </div>
                    `;
                } else {
                    // No processes at all
                    grid.innerHTML = `
                        <div class="empty-state">
                            <div class="empty-state-icon">📋</div>
                            <p>No processes created yet</p>
                            <p style="color: #999; font-size: 14px; margin-bottom: 15px;">
                                Create your first process to define manufacturing workflows
                            </p>
                            <button class="btn btn-primary" onclick="processFramework.processes.showCreateModal()">
                                ➕ Create Your First Process
                            </button>
                        </div>
                    `;
                }
                return;
            }

            const html = this.filtered.map(process => `
                <div class="card" onclick="processFramework.processes.viewDetail(${process.id})">
                    <div class="card-header">
                        <div>
                            <h3 class="card-title">${this.escapeHtml(process.name)}</h3>
                            <span class="card-badge badge-${process.status.toLowerCase()}">${process.status}</span>
                            <span class="card-badge badge-category">${process.class}</span>
                        </div>
                        <div class="card-actions">
                            <button class="icon-btn" onclick="event.stopPropagation(); processFramework.processes.edit(${process.id})" title="Edit">✏️</button>
                            <button class="icon-btn" onclick="event.stopPropagation(); processFramework.processes.confirmDelete(${process.id})" title="Delete">🗑️</button>
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
            
            grid.innerHTML = html;
        },

        async showCreateModal() {
            document.getElementById('process-modal-title').textContent = 'Create Process';
            document.getElementById('process-form').reset();
            document.getElementById('process-id').value = '';
            // Preload metadata for class/status dropdowns
            await processFramework.processes.ensureMetadata();
            processFramework.processes.populateClassOptions();
            processFramework.processes.populateStatusOptions();
            processFramework.openModal('process-modal');
        },
            async ensureMetadata() {
                if (this._metadataLoaded) return;
                try {
                    // Use centralized API client with caching
                    this._metadata = await window.upfApi.getProcessMetadata();
                    this._metadataLoaded = true;
                } catch (e) {
                    processFramework.handleError(e, 'Process Metadata', 'Failed to load process metadata');
                }
            },

            populateClassOptions() {
                const select = document.getElementById('process-class');
                if (!select || !this._metadata?.data?.classes) return;
                const classes = this._metadata.data.classes_display || this._metadata.data.classes;
                select.innerHTML = classes.map(c => `<option value="${c}">${c}</option>`).join('');
            },

            populateStatusOptions() {
                const select = document.getElementById('process-status');
                if (!select) return;
                const statuses = this._metadata?.data?.statuses || ['Draft','Active'];
                select.innerHTML = statuses.map(s => `<option value="${s}">${s}</option>`).join('');
                // Set default status returned by metadata
                if (this._metadata?.data?.default_status) {
                    select.value = this._metadata.data.default_status;
                }
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
                processFramework.handleError(error, 'Load Process', 'Failed to load process');
            }
        },

        async handleSubmit(event) {
            event.preventDefault();

            // Get ID and ensure it's a valid value or null
            const idValue = document.getElementById('process-id').value;
            const id = idValue && idValue !== 'undefined' && idValue.trim() !== '' ? idValue : null;
            
            // Ensure process_class is capitalized to match allowed DB values
            let processClass = document.getElementById('process-class').value;
            if (processClass) {
                processClass = processClass.charAt(0).toUpperCase() + processClass.slice(1).toLowerCase();
            }

            // Build form data with validation
            const statusEl = document.getElementById('process-status');
            const selectedStatus = statusEl && statusEl.value ? statusEl.value : 'Draft';

            const formData = {
                name: document.getElementById('process-name').value,
                class: processClass,
                description: document.getElementById('process-description').value || null,
                // Friendlier default: start new processes as Draft (or selected)
                status: selectedStatus
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
                        console.log('[Process Submit] Error response:', error);
                        
                        // Extract the message from the API response
                        errorMessage = error.message || error.error || errorMessage;

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

                    console.log('[Process Submit] Showing alert with message:', errorMessage);
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
                processFramework.handleError(error, 'Delete Process', 'Failed to delete process');
            }
        },

        viewDetail(id) {
            // Open inline editor instead of navigating to separate page
            processFramework.openInlineEditor(id);
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
                // Use centralized API client with caching
                this.all = await window.upfApi.getSubprocesses({ perPage: 1000 });
                this.filtered = [...this.all];
                this.render();
            } catch (error) {
                processFramework.handleError(error, 'Load Subprocesses', 'Failed to load subprocesses');
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
                const isFiltered = document.getElementById('subprocess-search')?.value || 
                                 document.getElementById('subprocess-category-filter')?.value;
                
                if (isFiltered) {
                    // Filtered results are empty
                    grid.innerHTML = `
                        <div class="empty-state">
                            <div class="empty-state-icon">🔍</div>
                            <p>No subprocesses match your filters</p>
                            <p style="color: #999; font-size: 14px;">Try adjusting your search or category filter</p>
                        </div>
                    `;
                } else {
                    // No subprocesses at all
                    grid.innerHTML = `
                        <div class="empty-state">
                            <div class="empty-state-icon">⚙️</div>
                            <p>No subprocesses in library</p>
                            <p style="color: #999; font-size: 14px; margin-bottom: 15px;">
                                Build a library of reusable subprocesses (steps) for your workflows
                            </p>
                            <button class="btn btn-primary" onclick="processFramework.subprocesses.showCreateModal()">
                                ➕ Create Your First Subprocess
                            </button>
                        </div>
                    `;
                }
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

        async showCreateModal() {
            document.getElementById('subprocess-modal-title').textContent = 'Create Subprocess';
            document.getElementById('subprocess-form').reset();
            document.getElementById('subprocess-id').value = '';
            // Preload metadata for category dropdown
            await processFramework.subprocesses.ensureMetadata();
            processFramework.subprocesses.populateCategoryOptions();
            processFramework.openModal('subprocess-modal');
        },

        async ensureMetadata() {
            if (this._metadataLoaded) return;
            try {
                // Use centralized API client with caching
                this._metadata = await window.upfApi.getSubprocessMetadata();
                this._metadataLoaded = true;
            } catch (e) {
                console.warn('[Subprocess Metadata] Error:', e);
            }
        },

        populateCategoryOptions() {
            const select = document.getElementById('subprocess-category');
            if (!select || !this._metadata?.data?.categories) return;
            const categories = this._metadata.data.categories;
            select.innerHTML = '<option value="">-- Select Category --</option>' +
                categories.map(c => `<option value="${c}">${c}</option>`).join('');
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
                processFramework.handleError(error, 'Load Subprocess', 'Failed to load subprocess');
            }
        },

        async handleSubmit(event) {
            event.preventDefault();

            // Get ID and ensure it's a valid value or null
            const idValue = document.getElementById('subprocess-id').value;
            const id = idValue && idValue !== 'undefined' && idValue.trim() !== '' ? idValue : null;
            
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
                processFramework.handleError(error, 'Delete Subprocess', 'Failed to delete subprocess');
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
                // Use centralized API client with caching
                this.all = await window.upfApi.getProductionLots({ perPage: 1000 });
                this.filtered = [...this.all];
                this.render();
            } catch (error) {
                processFramework.handleError(error, 'Load Production Lots', 'Failed to load production lots');
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
                const isFiltered = document.getElementById('lot-search')?.value || 
                                 document.getElementById('lot-status-filter')?.value;
                
                if (isFiltered) {
                    // Filtered results are empty
                    tbody.innerHTML = `
                        <tr>
                            <td colspan="6" class="empty-state">
                                <div style="padding: 20px;">
                                    <div style="font-size: 36px; margin-bottom: 10px;">🔍</div>
                                    <div>No production lots match your filters</div>
                                    <div style="color: #999; font-size: 14px; margin-top: 5px;">
                                        Try adjusting your search or status filter
                                    </div>
                                </div>
                            </td>
                        </tr>
                    `;
                } else {
                    // No production lots at all
                    tbody.innerHTML = `
                        <tr>
                            <td colspan="6" class="empty-state">
                                <div style="padding: 30px;">
                                    <div style="font-size: 48px; margin-bottom: 10px;">🏭</div>
                                    <div style="font-size: 18px; margin-bottom: 10px;">No production lots yet</div>
                                    <div style="color: #999; font-size: 14px; margin-bottom: 20px;">
                                        Create production lots from your processes to start manufacturing
                                    </div>
                                    <button class="btn btn-primary" onclick="processFramework.production.createNew()">
                                        ➕ Create Your First Production Lot
                                    </button>
                                </div>
                            </td>
                        </tr>
                    `;
                }
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

                const processes = processesData.data?.processes || processesData.processes || [];
                const lots = lotsData.data?.production_lots || lotsData.production_lots || [];

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
                const processes = data.data?.processes || data.processes || [];

                const sorted = processes
                    .filter(p => p.worst_case_cost > 0)
                    .sort((a, b) => b.worst_case_cost - a.worst_case_cost)
                    .slice(0, 5);

                const container = document.getElementById('top-processes-list');
                if (sorted.length === 0) {
                    container.innerHTML = `
                        <div style="text-align: center; padding: 40px; color: #999;">
                            <div style="font-size: 36px; margin-bottom: 10px;">📊</div>
                            <div style="font-size: 14px;">No process cost data available</div>
                            <div style="font-size: 12px; margin-top: 8px;">
                                Create processes with subprocesses to see cost analysis
                            </div>
                        </div>
                    `;
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
                const lots = data.data?.production_lots || data.production_lots || [];

                const container = document.getElementById('recent-lots-list');
                if (lots.length === 0) {
                    container.innerHTML = `
                        <div style="text-align: center; padding: 40px; color: #999;">
                            <div style="font-size: 36px; margin-bottom: 10px;">🏭</div>
                            <div style="font-size: 14px;">No production lots yet</div>
                            <div style="font-size: 12px; margin-top: 8px;">
                                Create production lots to track manufacturing activity
                            </div>
                        </div>
                    `;
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

    selectedVariant: null,

    async init() {
        // Listen for variant selection from Select2
        document.addEventListener('variantSelected', (e) => {
            console.log('[Variant Selection] Variant selected event received:', e.detail);
            this.selectedVariant = e.detail;
            this.updateSelectedVariantChip();
            this.showAlert('Variant selected! Drag to a subprocess or click ➕ Variant.', 'success');
        });

        // Check if there's a tab parameter in the URL
        const urlParams = new URLSearchParams(window.location.search);
        const initialTab = urlParams.get('tab') || 'processes';
        
        // Validate tab name
        const validTabs = ['processes', 'subprocesses', 'production', 'reports'];
        const tabToLoad = validTabs.includes(initialTab) ? initialTab : 'processes';
        
        await this.switchTab(tabToLoad);
        this.updateHeaderActions();
    },

    updateSelectedVariantChip() {
        const chip = document.getElementById('selected-variant-chip');
        const nameEl = document.getElementById('selected-variant-name');
        const detailsEl = document.getElementById('selected-variant-details');
        
        if (!chip || !nameEl) {
            console.log('[Variant Chip] Elements not found');
            return;
        }

        if (!this.selectedVariant) {
            chip.style.display = 'none';
            return;
        }

        const variantName = this.selectedVariant.text || this.selectedVariant.item_name || this.selectedVariant.name || `Variant #${this.selectedVariant.id}`;
        const variantBrand = this.selectedVariant.brand || 'N/A';
        const variantModel = this.selectedVariant.model || 'N/A';
        
        nameEl.textContent = variantName;
        if (detailsEl) {
            detailsEl.textContent = `${variantBrand} | ${variantModel}`;
        }
        chip.style.display = 'flex';
        
        // Make chip draggable
        chip.setAttribute('draggable', 'true');
        chip.ondragstart = (e) => {
            const payload = {
                id: this.selectedVariant.id,
                name: variantName
            };
            e.dataTransfer.setData('application/json', JSON.stringify(payload));
            e.dataTransfer.effectAllowed = 'copy';
            chip.style.opacity = '0.5';
        };
        chip.ondragend = () => {
            chip.style.opacity = '1';
        };
    },

    clearSelectedVariant() {
        this.selectedVariant = null;
        this.updateSelectedVariantChip();
    },

    async switchTab(tabName) {
        console.log('[Tab Switch] Switching to tab:', tabName);
        
        // Update active tab button
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        const tabButton = document.querySelector(`[data-tab="${tabName}"]`);
        console.log('[Tab Switch] Tab button found:', tabButton);
        if (tabButton) tabButton.classList.add('active');

        // Update active tab content
        const allTabs = document.querySelectorAll('.tab-content');
        console.log('[Tab Switch] Removing active from', allTabs.length, 'tabs');
        allTabs.forEach(content => {
            console.log('[Tab Switch] Removing active from:', content.id);
            content.classList.remove('active');
        });
        
        const tabContent = document.getElementById(`tab-${tabName}`);
        console.log('[Tab Switch] Tab content element:', tabContent);
        if (tabContent) {
            tabContent.classList.add('active');
            console.log('[Tab Switch] Tab content classes after add:', tabContent.className);
            
            // Verify other tabs don't have active
            allTabs.forEach(content => {
                if (content.id !== `tab-${tabName}`) {
                    console.log('[Tab Switch] Other tab', content.id, 'classes:', content.className);
                }
            });
        }

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

    // Inline Process Editor Methods
    currentEditProcessId: null,
    currentEditorTab: 'details',

    async openInlineEditor(processId) {
        try {
            console.log('[Inline Editor] Opening editor for process:', processId);
            this.currentEditProcessId = processId;
            
            // Ensure metadata is loaded for class/status options
            if (!this.processes._metadataLoaded) {
                await this.processes.ensureMetadata();
            }
            
            // Populate select options
            await this.populateInlineEditorOptions();
            
            // Load process details from API
            const process = await window.upfApi.getProcess(processId);
            console.log('[Inline Editor] Process loaded:', process);
            
            // Populate form fields
            document.getElementById('inline-process-name').value = process.name || '';
            document.getElementById('inline-process-class').value = process.class || '';
            document.getElementById('inline-process-status').value = process.status || 'draft';
            document.getElementById('inline-process-description').value = process.description || '';
            
            // Update title
            document.getElementById('inline-editor-title').textContent = `Edit Process: ${process.name}`;
            document.getElementById('inline-editor-subtitle').textContent = `ID: ${processId} | Class: ${process.class || 'N/A'}`;
            
            // Load subprocesses for structure tab
            await this.loadInlineSubprocesses(processId);
            
            // Switch to details tab
            this.switchEditorTab('details');
            
            // Show the editor panel with expand animation
            const panel = document.getElementById('inline-editor-panel');
            panel.style.display = 'block';
            
            // Smooth scroll to the editor
            setTimeout(() => {
                panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }, 100);
            
        } catch (error) {
            console.error('[Inline Editor] Error opening editor:', error);
            this.showAlert('Failed to load process details', 'error');
        }
    },

    async populateInlineEditorOptions() {
        // Populate class options
        const classSelect = document.getElementById('inline-process-class');
        if (classSelect && this.processes._metadata?.data?.classes) {
            const classes = this.processes._metadata.data.classes_display || this.processes._metadata.data.classes;
            classSelect.innerHTML = '<option value="">Select class...</option>' + 
                classes.map(c => `<option value="${c}">${c}</option>`).join('');
        }
        
        // Populate status options
        const statusSelect = document.getElementById('inline-process-status');
        if (statusSelect) {
            const statuses = this.processes._metadata?.data?.statuses || ['draft', 'active', 'completed'];
            statusSelect.innerHTML = '<option value="">Select status...</option>' + 
                statuses.map(s => `<option value="${s}">${s.charAt(0).toUpperCase() + s.slice(1)}</option>`).join('');
        }
    },

    closeInlineEditor() {
        console.log('[Inline Editor] Collapsing editor');
        const panel = document.getElementById('inline-editor-panel');
        
        // Add collapse animation - collapse upwards (to top)
        panel.style.transformOrigin = 'top center';
        panel.style.opacity = '0';
        panel.style.transform = 'scaleY(0)';
        panel.style.maxHeight = '0';
        
        setTimeout(() => {
            panel.style.display = 'none';
            panel.style.opacity = '1';
            panel.style.transform = 'scaleY(1)';
            panel.style.maxHeight = '600px';
        }, 300);
        
        this.currentEditProcessId = null;
        this.currentEditorTab = 'details';
        
        // Clear form
        document.getElementById('inline-process-form').reset();
    },

    switchEditorTab(tab) {
        console.log('[Inline Editor] Switching to tab:', tab);
        this.currentEditorTab = tab;
        
        // Update tab buttons
        document.querySelectorAll('.editor-tab').forEach(btn => {
            btn.classList.remove('active');
        });
        document.querySelector(`.editor-tab[onclick*="${tab}"]`).classList.add('active');
        
        // Update tab content visibility
        document.getElementById('editor-tab-details').style.display = tab === 'details' ? 'block' : 'none';
        document.getElementById('editor-tab-structure').style.display = tab === 'structure' ? 'block' : 'none';
        document.getElementById('editor-tab-costing').style.display = tab === 'costing' ? 'block' : 'none';
        
        // Initialize variant search when structure tab is shown
        if (tab === 'structure' && typeof variantSearch !== 'undefined') {
            console.log('[Inline Editor] Initializing variant search for structure tab');
            setTimeout(() => {
                variantSearch.init();
            }, 100);
        }
    },

    async saveInlineProcessEdit(event) {
        event.preventDefault();
        
        if (!this.currentEditProcessId) {
            processFramework.handleError(new Error('No process selected'), 'Inline Editor', 'Please select a process first');
            return;
        }
        
        try {
            console.log('[Inline Editor] Saving process:', this.currentEditProcessId);
            
            const data = {
                name: document.getElementById('inline-process-name').value,
                class: document.getElementById('inline-process-class').value,
                status: document.getElementById('inline-process-status').value,
                description: document.getElementById('inline-process-description').value
            };
            
            // Save using API client
            await window.upfApi.updateProcess(this.currentEditProcessId, data);
            
            console.log('[Inline Editor] Process saved successfully');
            this.showAlert('Process updated successfully', 'success');
            
            // Close editor
            this.closeInlineEditor();
            
            // Refresh process list (event listener will handle this automatically)
            
        } catch (error) {
            console.error('[Inline Editor] Error saving process:', error);
            this.showAlert('Failed to update process', 'error');
        }
    },

    async loadInlineSubprocesses(processId) {
        try {
            console.log('[Inline Editor] Loading subprocesses for process:', processId);
            
            // Use the process structure endpoint to get subprocesses
            const response = await fetch(`/api/upf/processes/${processId}/structure`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const structure = await response.json();
            const subprocesses = structure.data?.subprocesses || [];
            console.log('[Inline Editor] Subprocesses loaded:', subprocesses.length);
            
            const container = document.getElementById('inline-subprocesses-list');
            
            if (!subprocesses || subprocesses.length === 0) {
                container.innerHTML = '<p style="color: #666; text-align: center; padding: 20px;">No subprocesses added yet</p>';
                this.updateInlineCosting([]);
                return;
            }
            
            // Sort by sequence
            subprocesses.sort((a, b) => {
                const seqA = a.sequence_order || a.sequence || 0;
                const seqB = b.sequence_order || b.sequence || 0;
                return seqA - seqB;
            });
            
            container.innerHTML = subprocesses.map((sp, idx) => {
                const sequence = sp.sequence_order || sp.sequence || 0;
                const name = sp.subprocess?.name || sp.subprocess_name || sp.name || 'Unknown';
                const category = sp.subprocess?.category || sp.category || 'N/A';
                // Get the correct ID - structure endpoint returns process_subprocess_id
                const psId = sp.process_subprocess_id || sp.id;
                const variants = sp.variants || [];
                
                let variantsHtml = '';
                                if (variants.length > 0) {
                                        variantsHtml = `
                                                <div class="variants-list" style="margin-top: 10px; padding: 10px; background: #f5f5f5; border-radius: 4px;">
                                                        <div style="font-size: 12px; font-weight: 600; color: #666; margin-bottom: 8px;">🔧 Variants (${variants.length})</div>
                                                        <div style="overflow-x:auto;">
                                                            <table style="width:100%; border-collapse:collapse; font-size:13px;">
                                                                <thead>
                                                                    <tr style="text-align:left; color:#555;">
                                                                        <th style="padding:6px 4px;">Item</th>
                                                                        <th style="padding:6px 4px; width:90px;">Qty</th>
                                                                        <th style="padding:6px 4px; width:120px;">Rate</th>
                                                                        <th style="padding:6px 4px; width:120px;">Total</th>
                                                                        <th style="padding:6px 4px; width:40px;"></th>
                                                                    </tr>
                                                                </thead>
                                                                <tbody>
                                                                    ${variants.map(v => {
                                                                        const qty = parseFloat(v.quantity || 0);
                                                                        const rate = parseFloat(v.cost_per_unit || 0);
                                                                        const total = qty * rate;
                                                                        const vid = v.id; // usage id
                                                                        return `
                                                                            <tr data-usage-id="${vid}">
                                                                                <td style="padding:6px 4px;">${v.variant_name || 'Unknown'}</td>
                                                                                <td style="padding:6px 4px;"><input type="number" min="0" step="0.01" value="${qty}" style="width:80px;" onchange="processFramework.updateVariantUsageDebounced(${vid}, this.value, null)" oninput="processFramework.updateTotalCell(${vid})" /></td>
                                                                                <td style="padding:6px 4px;"><input type="number" min="0" step="0.01" value="${isNaN(rate)?'':rate}" placeholder="0.00" style="width:110px;" onchange="processFramework.updateVariantUsageDebounced(${vid}, null, this.value)" oninput="processFramework.updateTotalCell(${vid})" /></td>
                                                                                <td style="padding:6px 4px;" class="total-cell" data-usage-id="${vid}">$${total.toFixed(2)}</td>
                                                                                <td style="padding:6px 4px;"><button class="btn btn-sm" style="padding:2px 8px; font-size:11px; background:#f44336; color:white;" onclick="processFramework.removeVariantFromSubprocess(${psId}, ${vid})">×</button></td>
                                                                            </tr>
                                                                        `;
                                                                    }).join('')}
                                                                </tbody>
                                                            </table>
                                                        </div>
                                                </div>
                                        `;
                                } else {
                    variantsHtml = `
                        <div class="drop-zone" 
                             style="margin-top: 10px; padding: 20px; background: #f9f9f9; border: 2px dashed #ddd; border-radius: 4px; text-align: center; color: #999; font-size: 12px;"
                             ondrop="processFramework.handleVariantDrop(event, ${psId})"
                             ondragover="processFramework.handleDragOver(event)"
                             ondragleave="processFramework.handleDragLeave(event)">
                            Drag variant here or click ➕ Variant
                        </div>
                    `;
                }
                
                return `
                    <div class="subprocess-item" style="margin-bottom: 15px; border:2px solid #e0e0e0; border-radius:8px; padding:10px;" data-ps-id="${psId}" onclick="processFramework.selectInlineSubprocess(${psId}, event)">
                        <div class="subprocess-info" style="display: flex; justify-content: space-between; align-items: start;">
                            <div>
                                <h4>${sequence}. ${name}</h4>
                                <p style="font-size: 12px; color: #666; margin: 4px 0;">Category: ${category}</p>
                            </div>
                            <div class="subprocess-actions" style="display: flex; gap: 4px;">
                                <button class="btn btn-sm btn-primary" onclick="processFramework.addVariantToSubprocess(${psId}); event.stopPropagation();" title="Add Variant">➕ Variant</button>
                                <button class="btn btn-sm btn-secondary" onclick="processFramework.moveSubprocess(${psId}, 'up'); event.stopPropagation();" title="Move Up">↑</button>
                                <button class="btn btn-sm btn-secondary" onclick="processFramework.moveSubprocess(${psId}, 'down'); event.stopPropagation();" title="Move Down">↓</button>
                                <button class="btn btn-sm btn-danger" onclick="processFramework.removeInlineSubprocess(${psId}); event.stopPropagation();" title="Remove">×</button>
                            </div>
                        </div>
                        ${variantsHtml}
                    </div>
                `;
            }).join('');
            
            // Update costing tab
            this.updateInlineCosting(subprocesses);
            
        } catch (error) {
            processFramework.handleError(error, 'Load Subprocesses', 'Failed to load subprocesses');
        }
    },
    
    selectInlineSubprocess(psId, evt) {
        // Remove selection from others
        document.querySelectorAll('#inline-subprocesses-list .subprocess-item').forEach(el => el.classList.remove('selected'));
        const el = document.querySelector(`#inline-subprocesses-list .subprocess-item[data-ps-id="${psId}"]`);
        if (el) {
            el.classList.add('selected');
        }
        this.currentInlineSelectedSubprocessId = psId;
    },

    updateInlineCosting(subprocesses) {
        const totalLaborCost = subprocesses.reduce((sum, sp) => {
            const cost = parseFloat(sp.subprocess?.labor_cost || sp.labor_cost || 0);
            return sum + (isNaN(cost) ? 0 : cost);
        }, 0);

        const materialCost = subprocesses.reduce((sum, sp) => {
            const variants = sp.variants || [];
            const spMat = variants.reduce((s, v) => {
                const qty = parseFloat(v.quantity || 0);
                const rate = parseFloat(v.cost_per_unit || 0);
                let total = (!isNaN(qty) && !isNaN(rate) && rate > 0) ? qty * rate : 0;
                if (!total && v.total_cost) {
                    const t = parseFloat(v.total_cost);
                    total = isNaN(t) ? 0 : t;
                }
                return s + total;
            }, 0);
            return sum + spMat;
        }, 0);

        const total = totalLaborCost + materialCost;

        document.getElementById('inline-labor-cost').textContent = `$${totalLaborCost.toFixed(2)}`;
        document.getElementById('inline-material-cost').textContent = `$${materialCost.toFixed(2)}`;
        document.getElementById('inline-total-cost').textContent = `$${total.toFixed(2)}`;
    },

    async removeInlineSubprocess(subprocessId) {
        if (!confirm('Remove this subprocess from the process?')) {
            return;
        }
        
        try {
            console.log('[Inline Editor] Removing subprocess:', subprocessId);
            await window.upfApi.removeSubprocessFromProcess(this.currentEditProcessId, subprocessId);
            
            this.showAlert('Subprocess removed successfully', 'success');
            
            // Reload subprocesses
            await this.loadInlineSubprocesses(this.currentEditProcessId);
            
        } catch (error) {
            processFramework.handleError(error, 'Remove Subprocess', 'Failed to remove subprocess');
        }
    },

    // Variant handling functions
    handleDragOver(event) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        event.currentTarget.style.background = '#e8f5e9';
        event.currentTarget.style.borderColor = '#4CAF50';
    },

    handleDragLeave(event) {
        event.currentTarget.style.background = '#f9f9f9';
        event.currentTarget.style.borderColor = '#ddd';
    },

    async handleVariantDrop(event, subprocessId) {
        event.preventDefault();
        event.currentTarget.style.background = '#f9f9f9';
        event.currentTarget.style.borderColor = '#ddd';
        
        try {
            const data = JSON.parse(event.dataTransfer.getData('application/json'));
            console.log('[Variant Drop] Dropped variant:', data, 'on subprocess:', subprocessId);
            
            // Check if this is a multi-select drag
            if (data.multiSelect && data.ids && Array.isArray(data.ids)) {
                // Add all selected variants
                for (const variantId of data.ids) {
                    await this.addVariantToSubprocessById(subprocessId, variantId, 1);
                }
                // Clear selections after adding
                if (window.variantSearch) {
                    variantSearch.selected.clear();
                    variantSearch.refresh();
                }
            } else if (data.id) {
                // Single variant drag (legacy behavior)
                await this.addVariantToSubprocessById(subprocessId, data.id, 1);
            } else {
                this.showAlert('Invalid variant data', 'error');
                return;
            }
            
        } catch (error) {
            processFramework.handleError(error, 'Variant Drop', 'Failed to add variant via drag-and-drop');
        }
    },

    async addVariantToSubprocess(subprocessId) {
        // New behavior: set target subprocess and focus the variant search to guide user
        this.currentInlineSelectedSubprocessId = subprocessId;
        // visually mark as selected
        document.querySelectorAll('#inline-subprocesses-list .subprocess-item').forEach(el => el.classList.remove('selected'));
        const el = document.querySelector(`#inline-subprocesses-list .subprocess-item[data-ps-id="${subprocessId}"]`);
        if (el) el.classList.add('selected');
        // focus the search input on the right
        const input = document.getElementById('variant-search-input');
        if (input) input.focus();
        this.showAlert('Select variants on the right, then click "Add selected to subprocess"', 'info');
    },

    async addVariantToSubprocessById(subprocessId, variantId, quantity, costPerUnit) {
        try {
            console.log('[Add Variant] Adding variant', variantId, 'to subprocess', subprocessId, 'qty:', quantity);
            
            const response = await fetch('/api/upf/variant_usage', {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    subprocess_id: subprocessId,
                    item_id: variantId,
                    quantity: quantity,
                    ...(typeof costPerUnit !== 'undefined' && costPerUnit !== null ? { cost_per_unit: costPerUnit } : {})
                })
            });
            
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error || errorData.message || 'Failed to add variant');
            }
            
            this.showAlert('Variant added successfully', 'success');
            
            // Reload subprocesses to show the new variant
            await this.loadInlineSubprocesses(this.currentEditProcessId);
            
            // Clear selected variant
            this.clearSelectedVariant();
            
        } catch (error) {
            processFramework.handleError(error, 'Add Variant', 'Failed to add variant');
        }
    },

    openBatchAddModal() {
        if (!this.currentInlineSelectedSubprocessId) {
            this.showAlert('Select a subprocess first', 'warning');
            return;
        }
        this.openModal('batch-add-variants-modal');
    },

    async confirmBatchAddVariants() {
        try {
            const qtyInput = document.getElementById('batch-default-quantity');
            const rateInput = document.getElementById('batch-default-rate');
            const qty = parseFloat(qtyInput.value || '0');
            const rateRaw = rateInput.value;
            const rate = rateRaw ? parseFloat(rateRaw) : null;
            if (isNaN(qty) || qty <= 0) {
                this.showAlert('Enter a valid quantity > 0', 'error');
                return;
            }
            const ids = Array.from(variantSearch.selected);
            if (!ids.length) {
                this.showAlert('No variants selected', 'warning');
                return;
            }
            const target = this.currentInlineSelectedSubprocessId;
            for (const vid of ids) {
                await this.addVariantToSubprocessById(target, vid, qty, rate);
            }
            variantSearch.selected.clear();
            variantSearch.refresh();
            this.closeModal('batch-add-variants-modal');
            this.showAlert('Variants added', 'success');
        } catch (e) {
            console.error('[Batch Add] Error', e);
            this.showAlert(e.message || 'Failed batch add', 'error');
        }
    },

    async removeVariantFromSubprocess(subprocessId, variantUsageId) {
        if (!confirm('Remove this variant from the subprocess?')) {
            return;
        }
        
        try {
            console.log('[Remove Variant] Removing variant usage:', variantUsageId);
            
            const response = await fetch(`/api/upf/variant_usage/${variantUsageId}`, {
                method: 'DELETE',
                credentials: 'include'
            });
            
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error || errorData.message || 'Failed to remove variant');
            }
            
            this.showAlert('Variant removed successfully', 'success');
            
            // Reload subprocesses
            await this.loadInlineSubprocesses(this.currentEditProcessId);
            
        } catch (error) {
            processFramework.handleError(error, 'Remove Variant', 'Failed to remove variant');
        }
    },

    // expose to global
    

    async updateVariantUsage(usageId, quantityOrNull, rateOrNull) {
        try {
            const payload = {};
            if (quantityOrNull !== null && quantityOrNull !== undefined) {
                const q = parseFloat(quantityOrNull);
                if (!isNaN(q)) payload.quantity = q;
            }
            if (rateOrNull !== null && rateOrNull !== undefined) {
                const r = parseFloat(rateOrNull);
                if (!isNaN(r)) payload.cost_per_unit = r;
            }
            if (Object.keys(payload).length === 0) return;

            const resp = await fetch(`/api/upf/variant_usage/${usageId}`, {
                method: 'PUT',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            
            // Check if we got redirected to login (HTML response instead of JSON)
            const contentType = resp.headers.get('content-type');
            if (contentType && contentType.includes('text/html')) {
                throw new Error('Session expired. Please refresh the page and log in again.');
            }
            
            // Handle 401 Unauthorized
            if (resp.status === 401) {
                throw new Error('Session expired. Please refresh the page and log in again.');
            }
            
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.error || err.message || 'Failed to update variant usage');
            }
            
            // refresh list to reflect totals
            await this.loadInlineSubprocesses(this.currentEditProcessId);
        } catch (e) {
            processFramework.handleError(e, 'Variant Usage Update', 'Failed to update variant');
        }
    },

    // Debounced wrapper to minimize excessive reloads
    updateVariantUsageDebounced: (() => {
        let timers = {};
        return function(usageId, quantityOrNull, rateOrNull) {
            if (timers[usageId]) clearTimeout(timers[usageId]);
            timers[usageId] = setTimeout(() => {
                this.updateVariantUsage(usageId, quantityOrNull, rateOrNull);
            }, 400);
        };
    })(),

    updateTotalCell(usageId) {
        // Update the total cell in real-time as user types
        const row = document.querySelector(`tr[data-usage-id="${usageId}"]`);
        if (!row) return;
        
        const qtyInput = row.querySelector('input[type="number"]:nth-of-type(1)');
        const rateInput = row.querySelector('input[type="number"]:nth-of-type(2)');
        const totalCell = row.querySelector('.total-cell');
        
        if (qtyInput && rateInput && totalCell) {
            const qty = parseFloat(qtyInput.value) || 0;
            const rate = parseFloat(rateInput.value) || 0;
            const total = qty * rate;
            totalCell.textContent = `$${total.toFixed(2)}`;
        }
    },

    addSubprocessInline() {
        // Open the subprocess modal to add a new subprocess to the current process
        if (!this.currentEditProcessId) {
            console.error('[Inline Editor] No process ID set for adding subprocess');
            this.showAlert('No process selected', 'error');
            return;
        }
        
        console.log('[Inline Editor] Opening subprocess modal for process:', this.currentEditProcessId);
        
        // Store the process ID for the subprocess form
        window.currentProcessIdForSubprocess = this.currentEditProcessId;
        
        // Show the modal with tabs
        this.showSubprocessSelectionModal();
    },

    async showSubprocessSelectionModal() {
        // Show modal tabs
        document.getElementById('subprocess-modal-tabs').style.display = 'flex';
        
        // Switch to select tab by default
        this.switchSubprocessModalTab('select');
        
        // Load existing subprocesses
        await this.loadExistingSubprocessesForSelection();
        
        // Open the modal
        this.openModal('subprocess-modal');
    },

    switchSubprocessModalTab(tab) {
        const selectTab = document.getElementById('subprocess-select-tab');
        const createForm = document.getElementById('subprocess-form');
        const tabs = document.querySelectorAll('.modal-tab');
        
        tabs.forEach(t => t.classList.remove('active'));
        
        if (tab === 'select') {
            selectTab.style.display = 'block';
            createForm.style.display = 'none';
            document.querySelector('.modal-tab:first-child').classList.add('active');
        } else {
            selectTab.style.display = 'none';
            createForm.style.display = 'block';
            document.querySelector('.modal-tab:last-child').classList.add('active');
            
            // Override form submission when in inline mode
            this.setupCreateSubprocessForm();
        }
    },

    async loadExistingSubprocessesForSelection() {
        const container = document.getElementById('existing-subprocesses-list');
        container.innerHTML = '<p style="color: #999; text-align: center;">Loading...</p>';
        
        try {
            // getSubprocesses already returns the unwrapped array
            const subprocesses = await window.upfApi.getSubprocesses({ perPage: 1000 });
            
            console.log('[Inline Editor] Loaded subprocesses for selection:', subprocesses);
            
            if (!subprocesses || subprocesses.length === 0) {
                container.innerHTML = '<p style="color: #999; text-align: center;">No subprocesses available. Create one using the "Create New" tab.</p>';
                return;
            }
            
            window.availableSubprocesses = subprocesses;
            this.renderSubprocessList(subprocesses);
        } catch (error) {
            console.error('[Inline Editor] Error loading subprocesses:', error);
            container.innerHTML = '<p style="color: #d32f2f; text-align: center;">Failed to load subprocesses</p>';
        }
    },

    renderSubprocessList(subprocesses) {
        const container = document.getElementById('existing-subprocesses-list');
        
        if (subprocesses.length === 0) {
            container.innerHTML = '<p style="color: #999; text-align: center;">No subprocesses found</p>';
            return;
        }
        
        container.innerHTML = subprocesses.map(sp => {
            // Safely parse numeric values
            const laborCost = parseFloat(sp.labor_cost) || 0;
            const estimatedTime = parseInt(sp.estimated_time_minutes) || 0;
            
            return `
                <div class="subprocess-item" data-subprocess-id="${sp.id}" onclick="processFramework.selectSubprocess(${sp.id})">
                    <div class="subprocess-item-name">${sp.name}</div>
                    <div class="subprocess-item-details">
                        ${sp.category || 'No category'} • 
                        ${estimatedTime} min • 
                        $${laborCost.toFixed(2)}
                    </div>
                </div>
            `;
        }).join('');
    },

    selectSubprocess(subprocessId) {
        // Deselect all
        document.querySelectorAll('.subprocess-item').forEach(item => {
            item.classList.remove('selected');
        });
        
        // Select clicked
        const item = document.querySelector(`.subprocess-item[data-subprocess-id="${subprocessId}"]`);
        if (item) {
            item.classList.add('selected');
            window.selectedSubprocessId = subprocessId;
        }
    },

    async addSelectedSubprocess() {
        if (!window.selectedSubprocessId) {
            this.showAlert('Please select a subprocess', 'warning');
            return;
        }
        
        if (!this.currentEditProcessId) {
            this.showAlert('No process selected', 'error');
            return;
        }
        
        try {
            // Compute next sequence_order to keep ordering consistent
            const nextSequence = await this._getNextSequenceForProcess(this.currentEditProcessId);
            await window.upfApi.addSubprocessToProcess(this.currentEditProcessId, {
                subprocess_id: window.selectedSubprocessId,
                sequence_order: nextSequence
            });
            
            this.showAlert('Subprocess added successfully', 'success');
            this.closeModal('subprocess-modal');
            
            // Reload subprocesses in inline editor
            await this.loadInlineSubprocesses(this.currentEditProcessId);
            
            // Clear selection
            window.selectedSubprocessId = null;
        } catch (error) {
            console.error('[Inline Editor] Error adding subprocess:', error);
            this.showAlert('Failed to add subprocess: ' + error.message, 'error');
        }
    },

    filterExistingSubprocesses(searchTerm) {
        const allSubprocesses = window.availableSubprocesses || [];
        const filtered = allSubprocesses.filter(sp => 
            sp.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
            (sp.category && sp.category.toLowerCase().includes(searchTerm.toLowerCase()))
        );
        this.renderSubprocessList(filtered);
    },

    setupCreateSubprocessForm() {
        // Store reference to this for use in the async function
        const self = this;
        
        // Override the form submission to add to current process
        const form = document.getElementById('subprocess-form');
        const originalSubmit = form.onsubmit;
        
        form.onsubmit = async (event) => {
            event.preventDefault();
            
            try {
                const subprocessData = {
                    name: document.getElementById('subprocess-name').value,
                    category: document.getElementById('subprocess-category').value,
                    description: document.getElementById('subprocess-description').value || null,
                    estimated_time_minutes: parseInt(document.getElementById('estimated-time').value || '0', 10),
                    labor_cost: parseFloat(document.getElementById('labor-cost').value || '0')
                };
                
                console.log('[Inline Editor] Creating subprocess:', subprocessData);
                
                // Create the subprocess first
                const subprocessResponse = await window.upfApi.createSubprocess(subprocessData);
                console.log('[Inline Editor] Subprocess created:', subprocessResponse);
                
                // Extract subprocess ID from response (API returns {success, data, error, message})
                const subprocessId = subprocessResponse.data?.id || subprocessResponse.id;
                
                if (!subprocessId) {
                    throw new Error('Failed to get subprocess ID from response');
                }
                
                // Then add it to the current process
                const nextSequence = await self._getNextSequenceForProcess(self.currentEditProcessId);
                await window.upfApi.addSubprocessToProcess(self.currentEditProcessId, {
                    subprocess_id: subprocessId,
                    sequence_order: nextSequence
                });
                
                self.showAlert('Subprocess created and added successfully', 'success');
                self.closeModal('subprocess-modal');
                
                // Reload subprocesses in inline editor
                await self.loadInlineSubprocesses(self.currentEditProcessId);
                
                // Restore original form handler
                form.onsubmit = originalSubmit;
                
            } catch (error) {
                console.error('[Inline Editor] Error adding subprocess:', error);
                self.showAlert('Failed to add subprocess: ' + error.message, 'error');
            }
        };
    },

    /**
     * Compute next sequence_order for a process by inspecting structure
     */
    async _getNextSequenceForProcess(processId) {
        try {
            const res = await fetch(`/api/upf/processes/${processId}/structure`, { credentials: 'include' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            const data = json.data || json;
            const list = data.subprocesses || [];
            if (list.length === 0) return 1;
            const maxSeq = Math.max(
                ...list.map(sp => {
                    const seq = sp.sequence_order || sp.sequence || 0;
                    return typeof seq === 'number' ? seq : parseInt(seq) || 0;
                })
            );
            return maxSeq + 1;
        } catch (e) {
            console.warn('[Inline Editor] Failed to compute next sequence, defaulting to 1', e);
            return 1;
        }
    },

    moveSubprocess(subprocessId, direction) {
        // Delegate to async handler
        this._moveSubprocessAsync(subprocessId, direction).catch(err => {
            console.error('[Inline Editor] Reorder failed:', err);
            this.showAlert('Failed to reorder subprocesses', 'error');
        });
    },

    async _moveSubprocessAsync(processSubprocessId, direction) {
        if (!this.currentEditProcessId) {
            this.showAlert('No process selected', 'error');
            return;
        }

        // Load current structure to compute new order safely
        const res = await fetch(`/api/upf/processes/${this.currentEditProcessId}/structure`, { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const data = json.data || json;
        const list = (data.subprocesses || []).slice();

        if (list.length === 0) return;

        // Sort by sequence for predictable operations
        list.sort((a,b)=>{
            const sa = a.sequence_order || a.sequence || 0;
            const sb = b.sequence_order || b.sequence || 0;
            return (parseInt(sa)||0) - (parseInt(sb)||0);
        });

        const idFor = (sp) => sp.process_subprocess_id || sp.id;
        const idx = list.findIndex(sp => idFor(sp) == processSubprocessId);
        if (idx === -1) throw new Error('Subprocess not found in structure');

        const target = direction === 'up' ? idx - 1 : idx + 1;
        if (target < 0 || target >= list.length) {
            this.showAlert(direction === 'up' ? 'Already at the top' : 'Already at the bottom', 'info');
            return;
        }

        // Swap
        const temp = list[idx];
        list[idx] = list[target];
        list[target] = temp;

        // Build new sequence_map (1..n in current visual order)
        const sequence_map = {};
        list.forEach((sp, i) => {
            sequence_map[idFor(sp)] = i + 1;
        });

        // Persist via API
        const resp = await fetch(`/api/upf/process/${this.currentEditProcessId}/reorder_subprocesses`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': this.getCSRFToken()
            },
            credentials: 'include',
            body: JSON.stringify({ sequence_map })
        });

        if (!resp.ok) {
            let msg = 'Failed to save order';
            try { const e = await resp.json(); msg = e.error || e.message || msg; } catch(_){}
            throw new Error(msg);
        }

        this.showAlert('Subprocess order updated', 'success');
        await this.loadInlineSubprocesses(this.currentEditProcessId);
    },

    getCSRFToken() {
        return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
    },

    showAlert(message, type) {
        const container = document.getElementById('alert-container');
        if (!container) {
            console.error('[Alert] alert-container element not found!');
            alert(message); // Fallback to browser alert
            return;
        }
        
        console.log('[Alert] Creating alert:', message, type);
        const alertDiv = document.createElement('div');
        alertDiv.className = `alert alert-${type}`;
        alertDiv.textContent = message;
        container.appendChild(alertDiv);

        console.log('[Alert] Alert appended to container');

        setTimeout(() => {
            alertDiv.remove();
        }, 5000);
    }
};

// Initialize event listeners for cross-component reactivity
if (window.upfApi) {
    // Auto-refresh processes when data changes
    window.upfApi.on('process:created', () => {
        console.log('[Process Framework] Process created, refreshing list');
        if (processFramework.currentTab === 'processes') {
            processFramework.processes.load();
        }
    });
    
    window.upfApi.on('process:updated', () => {
        console.log('[Process Framework] Process updated, refreshing list');
        if (processFramework.currentTab === 'processes') {
            processFramework.processes.load();
        }
    });
    
    window.upfApi.on('process:deleted', () => {
        console.log('[Process Framework] Process deleted, refreshing list');
        if (processFramework.currentTab === 'processes') {
            processFramework.processes.load();
        }
    });

    // Auto-refresh subprocesses when data changes
    window.upfApi.on('subprocess:created', () => {
        console.log('[Process Framework] Subprocess created, refreshing list');
        if (processFramework.currentTab === 'subprocesses') {
            processFramework.subprocesses.load();
        }
    });
    
    window.upfApi.on('subprocess:updated', () => {
        console.log('[Process Framework] Subprocess updated, refreshing list');
        if (processFramework.currentTab === 'subprocesses') {
            processFramework.subprocesses.load();
        }
    });
    
    window.upfApi.on('subprocess:deleted', () => {
        console.log('[Process Framework] Subprocess deleted, refreshing list');
        if (processFramework.currentTab === 'subprocesses') {
            processFramework.subprocesses.load();
        }
    });

    // Auto-refresh production lots when data changes
    window.upfApi.on('production-lot:created', () => {
        console.log('[Process Framework] Production lot created, refreshing list');
        if (processFramework.currentTab === 'lots') {
            processFramework.productionLots.load();
        }
    });
    
    window.upfApi.on('production-lot:updated', () => {
        console.log('[Process Framework] Production lot updated, refreshing list');
        if (processFramework.currentTab === 'lots') {
            processFramework.productionLots.load();
        }
    });
    
    window.upfApi.on('production-lot:deleted', () => {
        console.log('[Process Framework] Production lot deleted, refreshing list');
        if (processFramework.currentTab === 'lots') {
            processFramework.productionLots.load();
        }
    });

    console.log('[Process Framework] Event listeners registered for reactive updates');
}

// Close modals when clicking outside
window.onclick = function(event) {
    if (event.target.classList.contains('modal')) {
        event.target.style.display = 'none';
    }
};

    // Expose to global for other modules (e.g., variant_search.js) and inline handlers
    window.processFramework = processFramework;
