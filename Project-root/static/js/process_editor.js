// Helper: Show error notification modal
function showErrorNotification(title, message, options = {}) {
    // Use existing notification system or fallback to modal
    let errorDiv = document.getElementById('error-notification');
    if (!errorDiv) {
        errorDiv = document.createElement('div');
        errorDiv.id = 'error-notification';
        errorDiv.className = 'error-notification';
        document.body.appendChild(errorDiv);
    }
    errorDiv.innerHTML = `
        <div class="error-content">
            <h3>${title}</h3>
            <p>${message}</p>
            <div class="error-actions">
                ${options.actions ? options.actions.map(action =>
                    `<button onclick="(${action.onClick.toString()})()">${action.label}</button>`
                ).join('') : ''}
            </div>
        </div>
    `;
    errorDiv.style.display = 'block';
}

// Helper: Disable all editing controls
function disableEditingControls() {
    document.querySelectorAll('button, input, select, textarea').forEach(el => {
        el.disabled = true;
    });
}
// Helper: Show/hide loading spinner
function showLoadingSpinner() {
    let spinner = document.getElementById('loading-spinner');
    if (!spinner) {
        spinner = document.createElement('div');
        spinner.id = 'loading-spinner';
        spinner.className = 'loading-spinner';
        spinner.innerHTML = '<div class="spinner"></div>';
        document.body.appendChild(spinner);
    }
    spinner.style.display = 'block';
}

function hideLoadingSpinner() {
    const spinner = document.getElementById('loading-spinner');
    if (spinner) spinner.style.display = 'none';
}
// Main process data loader with error handling
async function loadProcessData(processId) {
    try {
        showLoadingSpinner();
        const response = await fetch(`/api/upf/processes/${processId}`);
        if (!response.ok) {
            throw new Error(`Failed to load process: ${response.status} ${response.statusText}`);
        }
        const data = await response.json();
        if (!data || !data.id) {
            throw new Error('Invalid process data received');
        }
        // ...rest of the function (populate UI, etc.)
    } catch (error) {
        console.error('Error loading process:', error);
        showErrorNotification(
            'Failed to Load Process',
            `Unable to load process data. ${error.message}. Please refresh the page or contact support.`,
            {
                actions: [
                    { label: 'Retry', onClick: () => loadProcessData(processId) },
                    { label: 'Go Back', onClick: () => window.location.href = '/upf/processes' }
                ]
            }
        );
        disableEditingControls();
    } finally {
        hideLoadingSpinner();
    }
}
/**
 * Process Editor Component
 * Main controller for the process editor page
 */

const processEditor = {
    processId: null,
    processData: null,
    subprocesses: [],
    availableSubprocesses: [],
    sortableInstances: [],
    isDirty: false,

    /**
     * Initialize the editor
     */
    async init(processId) {
        this.processId = processId;
        console.log('Initializing process editor for process:', processId);

        // Warn on unsaved changes
        window.addEventListener('beforeunload', (e) => {
            if (this.isDirty) {
                e.preventDefault();
                e.returnValue = '';
            }
        });

        // Listen for variant selection from Select2
        document.addEventListener('variantSelected', (e) => {
            console.log('Variant selected event received:', e.detail);
            // Store selected variant for user to add to subprocess
            this.selectedVariant = e.detail;
            this.showAlert('Variant selected! Now click on a subprocess to add it.', 'success');
        });

        await this.loadProcess();
        await this.loadAvailableSubprocesses();
        await this.loadProcessStructure();
        this.initializeSortable();
    },

    /**
     * Load process details
     */
    async loadProcess() {
        try {
            const response = await fetch(`/api/upf/processes/${this.processId}`, {
                method: 'GET',
                credentials: 'include'
            });

            if (response.status === 401) {
                window.location.href = '/auth/login';
                return;
            }

            if (!response.ok) {
                throw new Error('Failed to load process');
            }

            const data = await response.json();
            this.processData = data.process;
            this.renderProcessHeader();
        } catch (error) {
            console.error('Error loading process:', error);
            this.showAlert('Failed to load process details', 'error');
        }
    },

    /**
     * Load available subprocess templates
     */
    async loadAvailableSubprocesses() {
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
            this.availableSubprocesses = data.subprocesses || [];
            this.renderSubprocessDropdown();
        } catch (error) {
            console.error('Error loading subprocesses:', error);
            this.showAlert('Failed to load subprocess templates', 'error');
        }
    },

    /**
     * Load process structure (subprocesses and variants)
     */
    async loadProcessStructure() {
        try {
            const response = await fetch(`/api/upf/processes/${this.processId}/structure`, {
                method: 'GET',
                credentials: 'include'
            });

            if (response.status === 401) {
                window.location.href = '/auth/login';
                return;
            }

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: response.statusText }));
                const errorMessage = errorData.error || errorData.message || `HTTP ${response.status}`;
                console.error(`Failed to load process structure: ${response.status}`, errorData);
                throw new Error(errorMessage);
            }

            const data = await response.json();
            this.subprocesses = data.subprocesses || [];
            this.renderSubprocesses();
            costCalculator.calculate();
        } catch (error) {
            console.error('Error loading process structure:', error);
            this.showAlert(`Failed to load process structure: ${error.message}. Please check the console for details.`, 'error');
            
            // Show more helpful error in development
            if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
                console.group('Debug Information');
                console.log('Process ID:', this.processId);
                console.log('Error:', error);
                console.groupEnd();
            }
        }
    },

    /**
     * Render process header
     */
    renderProcessHeader() {
        if (!this.processData) return;

        const nameEl = document.getElementById('process-name');
        if (nameEl) {
            nameEl.textContent = this.processData.name;
        }
    },

    /**
     * Render subprocess dropdown in modal
     */
    renderSubprocessDropdown() {
        const select = document.getElementById('subprocess-select');
        if (!select) return;

        let html = '<option value="">-- Select Subprocess --</option>';
        this.availableSubprocesses.forEach(sp => {
            html += `<option value="${sp.id}">${sp.name} (${sp.category})</option>`;
        });
        select.innerHTML = html;
    },

    /**
     * Render subprocesses in the main list
     */
    renderSubprocesses() {
        const container = document.getElementById('subprocess-list');
        const countEl = document.getElementById('subprocess-count');

        if (!container) return;

        if (countEl) {
            countEl.textContent = `${this.subprocesses.length} subprocess${this.subprocesses.length !== 1 ? 'es' : ''}`;
        }

        if (this.subprocesses.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i>📋</i>
                    <p>No subprocesses yet. Click "Add Subprocess" to get started!</p>
                </div>
            `;
            return;
        }

        let html = '';
        this.subprocesses.forEach((sp, index) => {
            html += this.renderSubprocessItem(sp, index);
        });

        container.innerHTML = html;
        this.initializeDropZones();
    },

    /**
     * Render a single subprocess item
     */
    renderSubprocessItem(subprocess, index) {
        const variants = subprocess.variants || [];
        const hasORGroups = variants.some(v => v.or_group_id);

        return `
            <div class="subprocess-item" data-subprocess-index="${index}" data-subprocess-id="${subprocess.process_subprocess_id}">
                <div class="subprocess-item-header">
                    <div class="subprocess-name">
                        <span class="drag-handle">☰</span>
                        <span>${subprocess.custom_name || subprocess.subprocess_name}</span>
                        ${hasORGroups ? '<span class="or-group-badge">Has OR Groups</span>' : ''}
                    </div>
                    <div class="subprocess-actions">
                        <button onclick="processEditor.configureORGroups(${index})" title="Configure OR Groups">⚙️ OR Groups</button>
                        <button onclick="processEditor.openCostItemModal(${index})" title="Add Cost Item">💰 Cost</button>
                        <button onclick="processEditor.removeSubprocess(${index})" title="Remove Subprocess">🗑️ Remove</button>
                    </div>
                </div>
                <div class="subprocess-content">
                    ${this.renderVariantsSection(subprocess, index)}
                </div>
            </div>
        `;
    },

    /**
     * Render variants section for a subprocess
     */
    renderVariantsSection(subprocess, spIndex) {
        const variants = subprocess.variants || [];

        let html = '<div class="variants-section">';
        html += '<div class="section-title">🔧 Variants</div>';

        if (variants.length === 0) {
            html += `
                <div class="drop-zone"
                     ondrop="processEditor.handleDrop(event, ${spIndex})"
                     ondragover="processEditor.handleDragOver(event)"
                     ondragleave="processEditor.handleDragLeave(event)">
                    Drag variants here to add them to this subprocess
                </div>
            `;
        } else {
            variants.forEach((variant, vIndex) => {
                const orGroupBadge = variant.or_group_id ?
                    `<span class="or-group-badge">OR Group ${variant.or_group_id}</span>` : '';

                html += `
                    <div class="variant-item">
                        <div class="variant-info">
                            <span class="variant-quantity">${variant.quantity} ${variant.unit}</span>
                            <span>${variant.variant_name}</span>
                            ${orGroupBadge}
                        </div>
                        <span class="variant-remove" onclick="processEditor.removeVariant(${spIndex}, ${vIndex})">
                            ✖️
                        </span>
                    </div>
                `;
            });
        }

        html += '</div>';
        return html;
    },

    /**
     * Initialize SortableJS for subprocess reordering
     */
    initializeSortable() {
        const container = document.getElementById('subprocess-list');
        if (!container) return;

        // Destroy existing sortable if any
        this.sortableInstances.forEach(s => s.destroy());
        this.sortableInstances = [];

        const sortable = new Sortable(container, {
            animation: 150,
            handle: '.drag-handle',
            ghostClass: 'sortable-ghost',
            onEnd: (evt) => {
                this.handleSubprocessReorder(evt.oldIndex, evt.newIndex);
            }
        });

        this.sortableInstances.push(sortable);
    },

    /**
     * Initialize drop zones for variants
     */
    initializeDropZones() {
        const dropZones = document.querySelectorAll('.drop-zone');
        dropZones.forEach(zone => {
            // Events are already attached via inline handlers
        });
    },

    /**
     * Handle subprocess reordering
     */
    handleSubprocessReorder(oldIndex, newIndex) {
        if (oldIndex === newIndex) return;

        const [moved] = this.subprocesses.splice(oldIndex, 1);
        this.subprocesses.splice(newIndex, 0, moved);

        // Update sequence numbers
        this.subprocesses.forEach((sp, index) => {
            sp.sequence = index + 1;
        });

        this.isDirty = true;
        this.renderSubprocesses();
    },

    /**
     * Handle drag over event
     */
    handleDragOver(event) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        event.currentTarget.classList.add('drag-over');
    },

    /**
     * Handle drag leave event
     */
    handleDragLeave(event) {
        event.currentTarget.classList.remove('drag-over');
    },

    /**
     * Handle drop event
     */
    async handleDrop(event, subprocessIndex) {
        event.preventDefault();
        event.currentTarget.classList.remove('drag-over');

        try {
            const variantData = JSON.parse(event.dataTransfer.getData('application/json'));

            // Show modal to get quantity
            document.getElementById('selected-variant-id').value = variantData.id;
            document.getElementById('selected-variant-name').textContent = variantData.name;
            document.getElementById('target-subprocess-id').value = subprocessIndex;
            document.getElementById('variant-quantity').value = '1';
            document.getElementById('variant-unit').value = 'pcs';

            document.getElementById('variant-modal').style.display = 'block';
        } catch (error) {
            console.error('Error handling drop:', error);
            this.showAlert('Failed to add variant', 'error');
        }
    },

    /**
     * Show add subprocess modal
     */
    addSubprocess() {
        document.getElementById('subprocess-modal').style.display = 'block';
        document.getElementById('subprocess-form').reset();
    },

    /**
     * Close subprocess modal
     */
    closeSubprocessModal() {
        document.getElementById('subprocess-modal').style.display = 'none';
    },

    /**
     * Handle add subprocess form submission
     */
    async handleAddSubprocess(event) {
        event.preventDefault();

        const subprocessId = document.getElementById('subprocess-select').value;
        const customName = document.getElementById('custom-name').value;

        if (!subprocessId) {
            this.showAlert('Please select a subprocess', 'error');
            return;
        }

        try {
            const response = await fetch(`/api/upf/processes/${this.processId}/subprocesses`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': this.getCSRFToken()
                },
                credentials: 'include',
                body: JSON.stringify({
                    subprocess_id: parseInt(subprocessId),
                    custom_name: customName || null,
                    sequence: this.subprocesses.length + 1
                })
            });

            if (response.status === 401) {
                window.location.href = '/auth/login';
                return;
            }

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.message || 'Failed to add subprocess');
            }

            this.showAlert('Subprocess added successfully', 'success');
            this.closeSubprocessModal();
            await this.loadProcessStructure();
            this.isDirty = false;
        } catch (error) {
            console.error('Error adding subprocess:', error);
            this.showAlert(error.message, 'error');
        }
    },

    /**
     * Close variant modal
     */
    closeVariantModal() {
        document.getElementById('variant-modal').style.display = 'none';
    },

    /**
     * Handle add variant form submission
     */
    async handleAddVariant(event) {
        event.preventDefault();

        const variantId = document.getElementById('selected-variant-id').value;
        const subprocessIndex = parseInt(document.getElementById('target-subprocess-id').value);
        const quantity = parseFloat(document.getElementById('variant-quantity').value);
        const unit = document.getElementById('variant-unit').value;

        const subprocess = this.subprocesses[subprocessIndex];
        if (!subprocess) {
            this.showAlert('Invalid subprocess', 'error');
            return;
        }

        try {
            // Fixed: Use correct endpoint and payload format
            const response = await fetch(`/api/upf/variant_usage`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': this.getCSRFToken()
                },
                credentials: 'include',
                body: JSON.stringify({
                    subprocess_id: subprocess.subprocess_id,  // Note: subprocess_id, not process_subprocess_id
                    item_id: parseInt(variantId),  // Note: item_id, not variant_id
                    quantity: quantity,
                    unit: unit
                })
            });

            if (response.status === 401) {
                window.location.href = '/auth/login';
                return;
            }

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || error.message || 'Failed to add variant');
            }

            this.showAlert('Variant added successfully', 'success');
            this.closeVariantModal();
            await this.loadProcessStructure();
            this.isDirty = false;
        } catch (error) {
            console.error('Error adding variant:', error);
            this.showAlert(error.message, 'error');
        }
    },

    /**
     * Remove variant from subprocess
     */
    async removeVariant(subprocessIndex, variantIndex) {
        if (!confirm('Remove this variant?')) return;

        const subprocess = this.subprocesses[subprocessIndex];
        const variant = subprocess.variants[variantIndex];

        try {
            // Fixed: Use correct endpoint with usage_id (assuming backend returns 'id' as usage_id)
            const usageId = variant.id || variant.usage_id;
            if (!usageId) {
                throw new Error('Variant usage ID not found');
            }

            const response = await fetch(`/api/upf/variant_usage/${usageId}`, {
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
                throw new Error('Failed to remove variant');
            }

            this.showAlert('Variant removed successfully', 'success');
            await this.loadProcessStructure();
        } catch (error) {
            console.error('Error removing variant:', error);
            this.showAlert('Failed to remove variant', 'error');
        }
    },

    /**
     * Remove subprocess
     */
    async removeSubprocess(index) {
        if (!confirm('Remove this subprocess and all its variants?')) return;

        const subprocess = this.subprocesses[index];

        try {
            // Fixed: Use correct endpoint path
            const response = await fetch(`/api/upf/process_subprocess/${subprocess.process_subprocess_id}`, {
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
                throw new Error('Failed to remove subprocess');
            }

            this.showAlert('Subprocess removed successfully', 'success');
            await this.loadProcessStructure();
        } catch (error) {
            console.error('Error removing subprocess:', error);
            this.showAlert('Failed to remove subprocess', 'error');
        }
    },

    /**
     * Configure OR groups for subprocess
     */
    configureORGroups(index) {
        this.openORGroupModal(index);
    },

    /**
     * Save process changes
     */
    async saveProcess() {
        if (!this.isDirty) {
            this.showAlert('No changes to save', 'success');
            return;
        }

        // Save sequence changes if any
        try {
            // Build sequence_map: {process_subprocess_id: sequence_order}
            const sequence_map = {};
            this.subprocesses.forEach((sp, index) => {
                sequence_map[sp.process_subprocess_id] = index + 1;
            });

            // Fixed: Use correct endpoint and payload format
            const response = await fetch(`/api/upf/process/${this.processId}/reorder_subprocesses`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': this.getCSRFToken()
                },
                credentials: 'include',
                body: JSON.stringify({ sequence_map })
            });

            if (response.status === 401) {
                window.location.href = '/auth/login';
                return;
            }

            if (!response.ok) {
                throw new Error('Failed to save changes');
            }

            this.showAlert('Changes saved successfully', 'success');
            this.isDirty = false;
        } catch (error) {
            console.error('Error saving changes:', error);
            this.showAlert('Failed to save changes', 'error');
        }
    },

    /**
     * Go back to process list
     */
    goBack() {
        if (this.isDirty && !confirm('You have unsaved changes. Are you sure you want to leave?')) {
            return;
        }
        window.location.href = '/upf/processes';
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
    },

    // ==================== OR GROUP MANAGEMENT ====================

    /**
     * Open OR Group configuration modal for a subprocess
     */
    async openORGroupModal(subprocessIndex) {
        const subprocess = this.subprocesses[subprocessIndex];
        if (!subprocess) return;

        // Store subprocess ID
        document.getElementById('or-group-subprocess-id').value = subprocess.process_subprocess_id;

        // Load existing OR groups
        await this.loadORGroups(subprocess.process_subprocess_id);

        // Populate variant selection checkboxes
        this.populateVariantSelection(subprocess);

        // Show modal
        document.getElementById('or-group-modal').style.display = 'block';
    },

    /**
     * Load existing OR groups for subprocess
     */
    async loadORGroups(processSubprocessId) {
        try {
            const response = await fetch(`/api/upf/process_subprocess/${processSubprocessId}/substitute_groups`, {
                method: 'GET',
                credentials: 'include'
            });

            if (!response.ok) throw new Error('Failed to load OR groups');

            const groups = await response.json();
            this.renderORGroups(groups);
        } catch (error) {
            console.error('Error loading OR groups:', error);
            this.showAlert('Failed to load OR groups', 'error');
        }
    },

    /**
     * Render OR groups in modal
     */
    renderORGroups(groups) {
        const container = document.getElementById('or-groups-container');

        if (!groups || groups.length === 0) {
            container.innerHTML = '<p style="color: #999; font-style: italic;">No OR groups configured yet.</p>';
            return;
        }

        container.innerHTML = groups.map(group => `
            <div class="or-group-item" style="border: 1px solid #ddd; border-radius: 4px; padding: 12px; margin-bottom: 10px; background: #f9f9f9;">
                <div style="display: flex; justify-content: space-between; align-items: start;">
                    <div style="flex: 1;">
                        <strong style="font-size: 15px;">${group.group_name || 'Unnamed Group'}</strong>
                        ${group.description ? `<p style="font-size: 13px; color: #666; margin: 4px 0 8px 0;">${group.description}</p>` : ''}
                        <div style="font-size: 13px; color: #666;">
                            Variants: ${group.variants ? group.variants.map(v => v.item_number).join(', ') : 'None'}
                        </div>
                    </div>
                    <button type="button" class="btn btn-danger" style="padding: 4px 10px; font-size: 12px;"
                            onclick="processEditor.deleteORGroup(${group.id})">Delete</button>
                </div>
            </div>
        `).join('');
    },

    /**
     * Populate variant selection checkboxes
     */
    populateVariantSelection(subprocess) {
        const container = document.getElementById('or-group-variant-selection');
        const variants = subprocess.variants || [];

        if (variants.length === 0) {
            container.innerHTML = '<p style="color: #999; font-style: italic;">No variants available. Add variants first.</p>';
            return;
        }

        container.innerHTML = variants.map((variant, idx) => `
            <label style="display: block; padding: 6px; cursor: pointer; border-bottom: 1px solid #eee;">
                <input type="checkbox" name="or-variant" value="${variant.id}"
                       data-item-id="${variant.item_id}" style="margin-right: 8px;">
                <strong>${variant.item_number}</strong> - ${variant.description || 'No description'}
                <span style="color: #666; font-size: 12px;">(Qty: ${variant.quantity} ${variant.unit || ''})</span>
            </label>
        `).join('');
    },

    /**
     * Handle OR Group creation
     */
    async handleCreateORGroup(event) {
        event.preventDefault();

        const subprocessId = document.getElementById('or-group-subprocess-id').value;
        const groupName = document.getElementById('or-group-name').value.trim();
        const description = document.getElementById('or-group-description').value.trim();

        // Get selected variants
        const selectedCheckboxes = document.querySelectorAll('input[name="or-variant"]:checked');
        const selectedVariants = Array.from(selectedCheckboxes).map(cb => parseInt(cb.value, 10));

        // Validate
        if (selectedVariants.length < 2) {
            this.showAlert('Please select at least 2 variants for the OR group', 'error');
            return;
        }

        try {
            // Create OR group
            const response = await fetch('/api/upf/substitute_group', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': this.getCSRFToken()
                },
                credentials: 'include',
                body: JSON.stringify({
                    process_subprocess_id: parseInt(subprocessId, 10),
                    group_name: groupName,
                    description: description || null,
                    variant_usage_ids: selectedVariants
                })
            });

            if (!response.ok) throw new Error('Failed to create OR group');

            const result = await response.json();
            this.showAlert('OR group created successfully', 'success');

            // Reload OR groups
            await this.loadORGroups(subprocessId);

            // Clear form
            document.getElementById('create-or-group-form').reset();
            selectedCheckboxes.forEach(cb => cb.checked = false);

        } catch (error) {
            console.error('Error creating OR group:', error);
            this.showAlert('Failed to create OR group', 'error');
        }
    },

    /**
     * Delete OR Group
     */
    async deleteORGroup(groupId) {
        if (!confirm('Delete this OR group? Variants will remain but will no longer be grouped.')) {
            return;
        }

        try {
            const response = await fetch(`/api/upf/substitute_group/${groupId}`, {
                method: 'DELETE',
                headers: {
                    'X-CSRFToken': this.getCSRFToken()
                },
                credentials: 'include'
            });

            if (!response.ok) throw new Error('Failed to delete OR group');

            this.showAlert('OR group deleted successfully', 'success');

            // Reload OR groups
            const subprocessId = document.getElementById('or-group-subprocess-id').value;
            await this.loadORGroups(subprocessId);

        } catch (error) {
            console.error('Error deleting OR group:', error);
            this.showAlert('Failed to delete OR group', 'error');
        }
    },

    /**
     * Close OR Group modal
     */
    closeORGroupModal() {
        document.getElementById('or-group-modal').style.display = 'none';
        document.getElementById('create-or-group-form').reset();
    },

    // ==================== COST ITEM MANAGEMENT ====================

    /**
     * Open cost item modal
     */
    openCostItemModal(subprocessIndex) {
        const subprocess = this.subprocesses[subprocessIndex];
        if (!subprocess) return;

        document.getElementById('cost-subprocess-id').value = subprocess.process_subprocess_id;
        document.getElementById('cost-item-modal').style.display = 'block';

        // Add listeners for real-time total calculation
        const quantity = document.getElementById('cost-quantity');
        const rate = document.getElementById('cost-rate');
        const calculateTotal = () => {
            const total = (parseFloat(quantity.value) || 0) * (parseFloat(rate.value) || 0);
            document.getElementById('cost-total-display').textContent = `$${total.toFixed(2)}`;
        };
        quantity.addEventListener('input', calculateTotal);
        rate.addEventListener('input', calculateTotal);
    },

    /**
     * Handle cost item addition
     */
    async handleAddCostItem(event) {
        event.preventDefault();

        const subprocessId = document.getElementById('cost-subprocess-id').value;
        const costType = document.getElementById('cost-type').value;
        const description = document.getElementById('cost-description').value.trim();
        const quantity = parseFloat(document.getElementById('cost-quantity').value);
        const rate = parseFloat(document.getElementById('cost-rate').value);

        try {
            const response = await fetch('/api/upf/cost_item', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': this.getCSRFToken()
                },
                credentials: 'include',
                body: JSON.stringify({
                    process_subprocess_id: parseInt(subprocessId, 10),
                    cost_type: costType,
                    description: description || null,
                    quantity: quantity,
                    rate_per_unit: rate
                })
            });

            if (!response.ok) throw new Error('Failed to add cost item');

            this.showAlert('Cost item added successfully', 'success');
            this.closeCostItemModal();
            await this.loadProcessStructure(); // Reload to show new cost

        } catch (error) {
            console.error('Error adding cost item:', error);
            this.showAlert('Failed to add cost item', 'error');
        }
    },

    /**
     * Close cost item modal
     */
    closeCostItemModal() {
        document.getElementById('cost-item-modal').style.display = 'none';
        document.getElementById('cost-item-form').reset();
        document.getElementById('cost-total-display').textContent = '$0.00';
    }
};

// Close modals on click outside
window.addEventListener('click', function(event) {
    const subprocessModal = document.getElementById('subprocess-modal');
    const variantModal = document.getElementById('variant-modal');
    const orGroupModal = document.getElementById('or-group-modal');
    const costItemModal = document.getElementById('cost-item-modal');

    if (event.target === subprocessModal) {
        processEditor.closeSubprocessModal();
    }
    if (event.target === variantModal) {
        processEditor.closeVariantModal();
    }
    if (event.target === orGroupModal) {
        processEditor.closeORGroupModal();
    }
    if (event.target === costItemModal) {
        processEditor.closeCostItemModal();
    }
});
