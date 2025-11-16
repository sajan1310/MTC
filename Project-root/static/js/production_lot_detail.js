// Production lot detail script (single IIFE)
(function () {
    'use strict';

    // =========================
    // Lightweight helpers
    // =========================
    /**
     * Safely fetch JSON with error handling
     * @param {string} url
     * @param {RequestInit} opts
     */
    async function safeFetchJson(url, opts = {}) {
        const defaultOpts = { credentials: 'include' };
        const merged = Object.assign({}, defaultOpts, opts);
        try {
            const res = await fetch(url, merged);
            if (res.status === 401) {
                // Redirect to login if auth expired
                window.location.href = '/auth/login';
                throw new Error('Unauthorized');
            }
            if (!res.ok) {
                const txt = await res.text().catch(() => '');
                throw new Error(`Network response not ok: ${res.status} ${txt}`);
            }
            return await res.json().catch(() => ({}));
        } catch (err) {
            console.error('safeFetchJson error for', url, err);
            throw err;
        }
    }

    /**
     * Create or return the global toast container
     * @returns {HTMLElement}
     */
    function getToastContainer() {
        let c = document.getElementById('global-toast-container');
        if (!c) {
            c = document.createElement('div');
            c.id = 'global-toast-container';
            c.style.position = 'fixed';
            c.style.right = '16px';
            c.style.bottom = '16px';
            c.style.zIndex = 99999;
            c.style.display = 'flex';
            c.style.flexDirection = 'column';
            c.style.gap = '8px';
            document.body.appendChild(c);
        }
        return c;
    }

    /**
     * Get border color for toast type
     * @param {'success'|'error'|'info'|'warning'} type
     */
    function getToastBorderColor(type) {
        switch (type) {
            case 'success': return '#276749';
            case 'error': return '#C53030';
            case 'warning': return '#B7791F';
            case 'info':
            default:
                return '#2B6CB0';
        }
    }

    /**
     * Show a toast notification
     * @param {string} message
     * @param {'success'|'error'|'info'|'warning'} [type]
     * @param {number} [timeout]
     */
    function showToast(message, type = 'info', timeout = 4000) {
        try {
            const container = getToastContainer();
            const t = document.createElement('div');
            t.className = `toast toast-${type}`;
            t.style.minWidth = '220px';
            t.style.padding = '10px 12px';
            t.style.borderRadius = '6px';
            t.style.background = '#fff';
            t.style.boxShadow = '0 6px 18px rgba(0,0,0,0.08)';
            t.style.borderLeft = `4px solid ${getToastBorderColor(type)}`;
            t.style.display = 'flex';
            t.style.justifyContent = 'space-between';
            t.style.alignItems = 'center';
            t.style.gap = '8px';

            const msg = document.createElement('div');
            msg.innerHTML = escapeHtml(String(message));
            msg.style.flex = '1 1 auto';
            t.appendChild(msg);

            const close = document.createElement('button');
            close.type = 'button';
            close.innerHTML = '✕';
            close.style.border = 'none';
            close.style.background = 'transparent';
            close.style.cursor = 'pointer';
            close.style.fontSize = '14px';
            close.addEventListener('click', () => t.remove());
            t.appendChild(close);

            container.appendChild(t);
            setTimeout(() => t.remove(), timeout);
            return t;
        } catch (e) {
            console.error('showToast failed', e);
        }
    }

    /**
     * Create a small spinner element
     * @returns {HTMLElement}
     */
    function createSpinner() {
        const s = document.createElement('span');
        s.className = 'tiny-spinner';
        s.style.display = 'inline-block';
        s.style.width = '14px';
        s.style.height = '14px';
        s.style.border = '2px solid rgba(0,0,0,0.1)';
        s.style.borderTop = '2px solid rgba(0,0,0,0.6)';
        s.style.borderRadius = '50%';
        s.style.animation = 'spin 1s linear infinite';
        return s;
    }

    // Add keyframes if not present
    (function ensureSpinnerKeyframes() {
        if (!document.getElementById('production-lot-spinner-style')) {
            const st = document.createElement('style');
            st.id = 'production-lot-spinner-style';
            st.textContent = '@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }';
            document.head.appendChild(st);
        }
    })();

    /**
     * Escape HTML to prevent XSS when inserting untrusted text
     * @param {string} text
     */
    function escapeHtml(text) {
        const d = document.createElement('div');
        d.textContent = text == null ? '' : String(text);
        return d.innerHTML;
    }

    // =========================
    // Existing helpers preserved
    // =========================
    /**
     * Find the element used to display the summary Total Cost row
     */
    function findSummaryCostElement() {
        const rows = document.querySelectorAll('#summary-content .detail-row');
        for (const r of rows) {
            const label = r.querySelector('.detail-label');
            if (!label) continue;
            if (label.textContent.trim().toLowerCase().includes('total cost')) {
                return r.querySelector('.detail-value');
            }
        }
        return null;
    }

    function updateTotalCostDisplay(amount) {
        const el = findSummaryCostElement();
        if (!el) return;
        const num = typeof amount === 'number' ? amount : Number(amount || 0);
        el.textContent = `$${(isFinite(num) ? num.toFixed(2) : '0.00')}`;
    }

    // =========================
    // Variant options loader (preserve + improved)
    // =========================
    async function loadVariantOptionsForSubprocess(subprocessId) {
        const candidates = [
            `/api/upf/subprocess/${subprocessId}/variant-options`,
            `/api/upf/subprocesses/${subprocessId}/variant_options`,
            `/api/upf/production-lots/${window.LOT_ID || ''}/variant_options?subprocess_id=${subprocessId}`,
        ];
        for (const url of candidates) {
            try {
                const res = await fetch(url, { credentials: 'include' });
                if (!res.ok) continue;
                const data = await res.json();
                document.dispatchEvent(new CustomEvent('production:subprocess-variant-options', { detail: { subprocessId, data } }));
                return data;
            } catch (e) {
                // try next
                console.error('variant options attempt failed for', url, e);
            }
        }
        return null;
    }

    // =========================
    // Singleton object
    // =========================
    const lotDetailPage = {
        lotId: window.LOT_ID || null,
        lotData: null,
        alertsData: null,
        _variantOptions: {},

        // -------------------------
        // Initialization
        // -------------------------
        async init() {
            try {
                // Helpful debug log to quickly see why the page may not load in-browser
                try { console.debug('lotDetailPage.init - LOT_ID =', this.lotId); } catch (e) { /* ignore */ }

                if (!this.lotId) {
                    // Show a friendly message in the UI so users/developers notice immediately
                    const el = document.getElementById('lot-details-content');
                    if (el) el.innerHTML = '<div class="empty-state">⚠️ Production lot not specified (LOT_ID missing)</div>';
                    console.warn('lotDetailPage.init: LOT_ID is missing; aborting data loads');
                    return;
                }

                await this.loadLotDetails();
                await this.loadAlerts();
                try { await this.fetchVariantOptions(); } catch (e) { console.error('fetchVariantOptions', e); }
                this.setupEventListeners();
            } catch (e) {
                console.error('Initialization failed', e);
                // Surface an inline error so it is visible without opening devtools
                const el = document.getElementById('lot-details-content');
                if (el) el.innerHTML = '<div class="empty-state">❌ Initialization error: see console for details</div>';
            }
        },

        // -------------------------
        // Data loading
        // -------------------------
        async loadLotDetails() {
            if (!this.lotId) return;
            try {
                const data = await safeFetchJson(`/api/upf/production-lots/${this.lotId}`);
                this.lotData = data.data || data || {};
                this.renderLotDetails();
                this.renderSummary();
                this.populateSubprocessSelect();
            } catch (err) {
                console.error('Error loading lot details:', err);
                const el = document.getElementById('lot-details-content'); if (el) el.innerHTML = '<div class="empty-state">❌ Failed to load lot details</div>';
                showToast('Failed to load lot details', 'error');
            }
        },

        async loadAlerts() {
            if (!this.lotId) return;
            try {
                const data = await safeFetchJson(`/api/upf/inventory-alerts/lot/${this.lotId}`);
                this.alertsData = data.data || data || { alert_details: [] };
                this.renderAlerts();
                this.updateCriticalBanner();
                this.updateFinalizeButton();
            } catch (err) {
                console.error('Error loading alerts:', err);
                const ac = document.getElementById('alerts-content'); if (ac) ac.innerHTML = '<div class="empty-state">No alerts available</div>';
                showToast('Failed to load alerts', 'error');
            }
        },

        async fetchVariantOptions() {
            if (!this.lotId) return;
            try {
                const data = await safeFetchJson(`/api/upf/production-lots/${this.lotId}/variant_options`);
                this._variantOptions = data.data || data || {};
            } catch (e) {
                console.error('Error fetching variant options:', e);
            }
        },

        // -------------------------
        // Rendering
        // -------------------------
        renderLotDetails() {
            const lot = this.lotData || {};
            const title = document.getElementById('page-title'); if (title) title.textContent = `🏭 Production Lot: ${lot.lot_number || 'N/A'}`;
            const statusClass = (lot.status || 'planning').toLowerCase().replace(/\s+/g, '-');
            const badge = document.getElementById('lot-status-badge'); if (badge) badge.innerHTML = `<span class="status-badge status-${statusClass}">${escapeHtml(lot.status || 'Planning')}</span>`;
            const details = document.getElementById('lot-details-content');
            if (details) {
                const notes = escapeHtml(lot.notes || '');
                const qty = Number(lot.quantity || 0);
                details.innerHTML = `
                    <div class="detail-row"><span class="detail-label">Lot Number</span><span class="detail-value">${escapeHtml(lot.lot_number || 'N/A')}</span></div>
                    <div class="detail-row"><span class="detail-label">Quantity</span><span class="detail-value">${qty}</span></div>
                    <div class="detail-row"><span class="detail-label">Notes</span><span class="detail-value">${notes}</span></div>
                `;
            }
        },

        renderSummary() {
            const lot = this.lotData || {};
            const rawCost = (lot && (lot.total_cost ?? lot.worst_case_estimated_cost)) || 0;
            const costNum = Number(rawCost); const costDisplay = isFinite(costNum) ? costNum.toFixed(2) : '0.00';
            const summaryEl = document.getElementById('summary-content');
            if (summaryEl) {
                summaryEl.innerHTML = `
                    <div class="detail-row"><span class="detail-label">Total Cost</span><span class="detail-value">$${costDisplay}</span></div>
                    <div class="detail-row"><span class="detail-label">Total Alerts</span><span class="detail-value" id="total-alerts-count">-</span></div>
                    <div class="detail-row"><span class="detail-label">Acknowledged</span><span class="detail-value" id="acknowledged-count">-</span></div>
                    <div class="detail-row"><span class="detail-label">Pending</span><span class="detail-value" id="pending-count">-</span></div>
                `;
            }
        },

        /**
         * Render the alerts table with all 9 required columns
         */
        renderAlerts() {
            const alerts = this.alertsData?.alert_details || [];
            const totalAlerts = alerts.length;
            const badgeEl = document.getElementById('alerts-count-badge'); if (badgeEl) badgeEl.innerHTML = totalAlerts > 0 ? `<span class="status-badge">${totalAlerts} Total</span>` : '';

            const acknowledgedCount = alerts.filter(a => a.user_acknowledged).length;
            const pendingCount = totalAlerts - acknowledgedCount;
            const totalEl = document.getElementById('total-alerts-count'); const ackEl = document.getElementById('acknowledged-count'); const pendingEl = document.getElementById('pending-count');
            if (totalEl) totalEl.textContent = String(totalAlerts);
            if (ackEl) ackEl.textContent = String(acknowledgedCount);
            if (pendingEl) pendingEl.textContent = String(pendingCount);

            const container = document.getElementById('alerts-table-body');
            const tableContainer = document.getElementById('alerts-table-container');
            const alertsContent = document.getElementById('alerts-content');
            if (!container) return;

            if (alerts.length === 0) {
                if (alertsContent) alertsContent.innerHTML = '<div class="empty-state">✅ No inventory alerts for this lot</div>';
                container.innerHTML = '';
                if (tableContainer) tableContainer.style.display = 'none';
                if (alertsContent) alertsContent.style.display = '';
                return;
            }
            // Hide loading content and show table
            if (tableContainer) tableContainer.style.display = '';
            if (alertsContent) alertsContent.style.display = 'none';

            // Build rows
            container.innerHTML = '';
            for (const a of alerts) {
                const row = document.createElement('tr');
                row.dataset.alertId = String(a.alert_id || '');

                // Column 1: Checkbox
                const tdCheck = document.createElement('td');
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.className = 'alert-checkbox';
                cb.dataset.alertId = String(a.alert_id || '');
                if (a.user_acknowledged) cb.checked = true;
                tdCheck.appendChild(cb);
                row.appendChild(tdCheck);

                // Column 2: Severity badge
                const tdSeverity = document.createElement('td');
                const sev = (a.alert_severity || 'WARNING').toUpperCase();
                const sevSpan = document.createElement('span');
                sevSpan.className = `severity-badge severity-${sev.toLowerCase()}`;
                sevSpan.textContent = sev;
                tdSeverity.appendChild(sevSpan);
                row.appendChild(tdSeverity);

                // Column 3: Variant name + SKU
                const tdVariant = document.createElement('td');
                const variantName = escapeHtml(a.variant_name || 'N/A');
                const sku = a.sku ? ` <small class="muted">(${escapeHtml(a.sku)})</small>` : '';
                tdVariant.innerHTML = `${variantName}${sku}`;
                row.appendChild(tdVariant);

                // Column 4: Current stock quantity (right-aligned)
                const tdCurrent = document.createElement('td');
                tdCurrent.style.textAlign = 'right';
                tdCurrent.textContent = String(a.current_stock_quantity ?? 0);
                row.appendChild(tdCurrent);

                // Column 5: Required quantity (right-aligned)
                const tdRequired = document.createElement('td');
                tdRequired.style.textAlign = 'right';
                tdRequired.textContent = String(a.required_quantity ?? 0);
                row.appendChild(tdRequired);

                // Column 6: Shortfall (required - current)
                const shortfall = (Number(a.required_quantity || 0) - Number(a.current_stock_quantity || 0));
                const tdShort = document.createElement('td');
                tdShort.style.textAlign = 'right';
                tdShort.textContent = String(shortfall);
                if (shortfall > 0) tdShort.style.color = '#C53030';
                row.appendChild(tdShort);

                // Column 7: Suggested procurement quantity
                const tdSuggested = document.createElement('td');
                tdSuggested.style.textAlign = 'right';
                tdSuggested.textContent = String(a.suggested_procurement_quantity ?? '-');
                row.appendChild(tdSuggested);

                // Column 8: Status badge
                const tdStatus = document.createElement('td');
                const statusSpan = document.createElement('span');
                statusSpan.className = a.user_acknowledged ? 'status-badge status-ack' : 'status-badge status-pending';
                statusSpan.textContent = a.user_acknowledged ? '✓ Acknowledged' : '⏳ Pending';
                tdStatus.appendChild(statusSpan);
                row.appendChild(tdStatus);

                // Column 9: Action button
                const tdAction = document.createElement('td');
                const actionBtn = document.createElement('button');
                actionBtn.type = 'button';
                actionBtn.className = 'alert-action-btn';
                actionBtn.dataset.alertId = String(a.alert_id || '');
                actionBtn.textContent = a.user_acknowledged ? 'Done' : 'Acknowledge';
                actionBtn.disabled = !!a.user_acknowledged;
                tdAction.appendChild(actionBtn);
                row.appendChild(tdAction);

                container.appendChild(row);
            }

            // Attach listeners to checkboxes and action buttons
            this.attachAlertTableListeners();
        },

        updateCriticalBanner() {
            const alerts = this.alertsData?.alert_details || [];
            const hasCriticalUnacknowledged = alerts.some(a => a.alert_severity === 'CRITICAL' && !a.user_acknowledged);
            const banner = document.getElementById('critical-alert-banner'); if (banner) banner.style.display = hasCriticalUnacknowledged ? 'flex' : 'none';
        },

        updateFinalizeButton() {
            const alerts = this.alertsData?.alert_details || [];
            const hasCriticalUnacknowledged = alerts.some(a => a.alert_severity === 'CRITICAL' && !a.user_acknowledged);
            const finalizeBtn = document.getElementById('finalize-btn'); if (finalizeBtn) { finalizeBtn.disabled = hasCriticalUnacknowledged; finalizeBtn.title = hasCriticalUnacknowledged ? 'Cannot finalize: Unacknowledged CRITICAL alerts present' : 'Finalize this production lot'; }
        },

        // -------------------------
        // Modal lifecycle
        // -------------------------
        /**
         * Open modal by id and prevent body scroll
         * @param {string} modalId
         */
        openModal(modalId) {
            const m = document.getElementById(modalId);
            if (!m) return;
            m.classList.add('active');
            document.body.style.overflow = 'hidden';
            // Attach ESC close
            const escHandler = (e) => { if (e.key === 'Escape') { this.closeModal(modalId); } };
            m._escHandler = escHandler;
            document.addEventListener('keydown', escHandler);
        },

        /**
         * Close modal by id and restore body scroll
         * @param {string} modalId
         */
        closeModal(modalId) {
            const m = document.getElementById(modalId);
            if (!m) return;
            m.classList.remove('active');
            document.body.style.overflow = 'auto';
            if (m._escHandler) document.removeEventListener('keydown', m._escHandler);
            m._escHandler = null;
        },

        // Match modal IDs used in templates
        openEditModal() { this.populateEditForm(); this.openModal('modal-overlay'); },
        closeEditModal() { this.closeModal('modal-overlay'); },
        openVariantModal() { this.populateAddVariantForm(); this.openModal('variant-modal-overlay'); },
        closeVariantModal() { this.closeModal('variant-modal-overlay'); },
        openEditSubprocessModal(subprocessId) { this.populateEditSubprocessForm(subprocessId); this.openModal('edit-subprocess-modal-overlay'); },
        closeEditSubprocessModal() { this.closeModal('edit-subprocess-modal-overlay'); },

        // -------------------------
        // Form population and submit handlers
        // -------------------------
        populateEditForm() {
            try {
                const lot = this.lotData || {};
                const qtyEl = document.getElementById('modal-quantity');
                const notesEl = document.getElementById('modal-notes');
                const statusEl = document.getElementById('modal-status');
                if (qtyEl) qtyEl.value = String(lot.quantity ?? '');
                if (notesEl) notesEl.value = lot.notes ?? '';
                if (statusEl) statusEl.value = lot.status ?? '';
            } catch (e) { console.error('populateEditForm', e); }
        },

        /**
         * Submit edit lot form
         */
        async submitEditLotForm(e) {
            e && e.preventDefault();
            // Form submit button may not have a stable id; find it via form
            const form = document.getElementById('edit-lot-form');
            const btn = form ? form.querySelector('button[type="submit"]') : null;
            if (btn && btn.disabled) return;
            const originalText = btn ? btn.textContent : '';
            try {
                if (btn) { btn.disabled = true; btn.textContent = '💾 Saving...'; }
                const qty = Number(document.getElementById('modal-quantity')?.value) || 0;
                const notes = document.getElementById('modal-notes')?.value || '';
                const status = document.getElementById('modal-status')?.value || '';
                const payload = { quantity: qty, notes, status };
                const resp = await safeFetchJson(`/api/upf/production-lots/${this.lotId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                showToast('Lot saved', 'success');
                await this.loadLotDetails(); // refresh
                this.closeEditModal();
            } catch (err) {
                console.error('submitEditLotForm', err);
                showToast('Failed to save lot: ' + (err.message || ''), 'error');
            } finally {
                if (btn) { btn.disabled = false; btn.textContent = originalText; }
            }
        },

        populateAddVariantForm() {
            try {
                // Populate header subprocess select (where user picks subprocess to add to)
                const subprocessSelect = document.getElementById('subprocess-select-for-add');
                if (subprocessSelect) {
                    subprocessSelect.innerHTML = '<option value="">Select subprocess</option>';
                    const subs = (this.lotData?.subprocesses) || [];
                    for (const s of subs) {
                        const o = document.createElement('option'); o.value = s.id; o.text = s.name; subprocessSelect.appendChild(o);
                    }
                }

                // Reset variant selects inside modal
                const group = document.getElementById('variant-group-select'); if (group) group.value = '';
                const variantSelect = document.getElementById('variant-select'); if (variantSelect) variantSelect.value = '';
                const qty = document.getElementById('variant-qty'); if (qty) qty.value = '1';
            } catch (e) { console.error('populateAddVariantForm', e); }
        },

        async submitAddVariantForm(e) {
            e && e.preventDefault();
            // submit button inside form
            const form = document.getElementById('add-variant-form');
            const btn = form ? form.querySelector('button[type="submit"]') : null;
            if (btn && btn.disabled) return;
            const original = btn ? btn.textContent : '';
            try {
                if (btn) { btn.disabled = true; btn.textContent = 'Adding...'; }
                const subprocess_id = document.getElementById('subprocess-select-for-add')?.value;
                const variant_id = document.getElementById('variant-select')?.value;
                const quantity_per_unit = Number(document.getElementById('variant-qty')?.value) || 0;
                if (!subprocess_id || !variant_id) throw new Error('Please select subprocess and variant');
                const payload = { subprocess_id, variant_id, quantity_per_unit };
                const data = await safeFetchJson(`/api/upf/production-lots/${this.lotId}/variant-selections`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                showToast('Variant added', 'success');
                // Recalculate costs and refresh
                try { await safeFetchJson(`/api/upf/production-lots/${this.lotId}/recalculate`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }); } catch (e) { console.error('recalc after add variant failed', e); }
                await this.loadLotDetails();
                this.closeVariantModal();
            } catch (err) {
                console.error('submitAddVariantForm', err);
                showToast('Failed to add variant: ' + (err.message || ''), 'error');
            } finally {
                if (btn) { btn.disabled = false; btn.textContent = original; }
            }
        },

        populateEditSubprocessForm(subprocessId) {
            try {
                const body = document.getElementById('edit-subprocess-body');
                if (!body) return;

                // Clear previous content
                body.innerHTML = '';

                // Try to find variant options for this subprocess from cached variant options
                let subprocessData = null;
                try {
                    const vo = this._variantOptions || {};
                    // If server returned { subprocesses: [...] }
                    const subsArr = vo.subprocesses || vo;
                    if (Array.isArray(subsArr)) {
                        subprocessData = subsArr.find(s => Number(s.process_subprocess_id) === Number(subprocessId) || Number(s.subprocess_id) === Number(subprocessId) || Number(s.sequence_order) === Number(subprocessId));
                    }
                } catch (e) {
                    console.error('lookup variant options failed', e);
                }

                // Fallback to lotData subprocesses
                if (!subprocessData) {
                    const subs = this.lotData?.subprocesses || [];
                    subprocessData = subs.find(s => Number(s.id) === Number(subprocessId) || Number(s.process_subprocess_id) === Number(subprocessId) || Number(s.subprocess_id) === Number(subprocessId));
                }

                // Header
                const header = document.createElement('div');
                header.style.marginBottom = '12px';
                header.innerHTML = `<strong>Edit selections for subprocess</strong> <span style="color:#666;margin-left:8px">ID: ${escapeHtml(String(subprocessId))}</span>`;
                body.appendChild(header);

                // If we have grouped_variants or standalone_variants, render selects for each group
                const form = document.createElement('div');
                form.id = 'edit-subprocess-form-inner';
                body.appendChild(form);

                const groups = (subprocessData && (subprocessData.grouped_variants || {})) || {};
                const standalone = (subprocessData && (subprocessData.standalone_variants || [])) || [];

                // OR groups (grouped_variants is an object mapping group_id -> [variants])
                for (const [groupId, variants] of Object.entries(groups || {})) {
                    const wrap = document.createElement('div');
                    wrap.style.marginBottom = '10px';
                    const label = document.createElement('label');
                    label.textContent = `Group ${groupId} (choose one)`;
                    label.style.display = 'block';
                    label.style.fontWeight = '600';
                    wrap.appendChild(label);

                    const sel = document.createElement('select');
                    sel.dataset.processSubprocessId = subprocessId;
                    sel.dataset.groupId = groupId;
                    const emptyOpt = document.createElement('option'); emptyOpt.value = ''; emptyOpt.text = '-- No selection --'; sel.appendChild(emptyOpt);
                    for (const v of variants) {
                        const opt = document.createElement('option');
                        // Prefer usage_id if present
                        opt.value = v.usage_id || v.variant_id || v.id || '';
                        const labelText = `${v.model_name || ''} ${v.variation_name || ''} ${v.color_name || ''} ${v.size_name || ''}`.trim() || (v.item_number || v.name || ('Variant ' + opt.value));
                        opt.text = `${labelText} (${v.quantity ?? ''})`;
                        sel.appendChild(opt);
                    }
                    wrap.appendChild(sel);
                    form.appendChild(wrap);
                }

                // Standalone variants
                if (standalone && standalone.length) {
                    const wrap = document.createElement('div');
                    wrap.style.marginBottom = '10px';
                    const label = document.createElement('label');
                    label.textContent = 'Standalone variants (choose one per subprocess if applicable)';
                    label.style.display = 'block';
                    label.style.fontWeight = '600';
                    wrap.appendChild(label);

                    const sel = document.createElement('select');
                    sel.dataset.processSubprocessId = subprocessId;
                    const emptyOpt = document.createElement('option'); emptyOpt.value = ''; emptyOpt.text = '-- No selection --'; sel.appendChild(emptyOpt);
                    for (const v of standalone) {
                        const opt = document.createElement('option');
                        opt.value = v.usage_id || v.variant_id || v.id || '';
                        const labelText = `${v.model_name || ''} ${v.variation_name || ''} ${v.color_name || ''} ${v.size_name || ''}`.trim() || (v.item_number || v.name || ('Variant ' + opt.value));
                        opt.text = `${labelText} (${v.quantity ?? ''})`;
                        sel.appendChild(opt);
                    }
                    wrap.appendChild(sel);
                    form.appendChild(wrap);
                }

                // If no options found, inform the user
                if (Object.keys(groups || {}).length === 0 && (!standalone || standalone.length === 0)) {
                    const p = document.createElement('div');
                    p.className = 'empty-state';
                    p.textContent = 'No variant options available for this subprocess.';
                    form.appendChild(p);
                }

                // Attach brief help and ensure Save button remains wired via existing handler
                const help = document.createElement('div');
                help.style.marginTop = '8px';
                help.style.color = '#666';
                help.style.fontSize = '13px';
                help.textContent = 'Select variants and click Save Selections.';
                body.appendChild(help);
            } catch (e) { console.error('populateEditSubprocessForm', e); }
        },

        async submitEditSubprocessForm(e) {
            e && e.preventDefault();
            try {
                const body = document.getElementById('edit-subprocess-body');
                if (!body) return showToast('Edit form not available', 'error');

                // Collect selections from selects we rendered
                const selects = Array.from(body.querySelectorAll('select[data-process-subprocess-id]'));
                const selections = [];
                for (const s of selects) {
                    const pid = s.dataset.processSubprocessId || s.dataset.process_subprocess_id || s.dataset.processSubprocessid;
                    const val = s.value;
                    if (!pid) continue;
                    if (!val) continue;
                    selections.push({ process_subprocess_id: Number(pid), variant_usage_id: Number(val) });
                }

                if (!selections.length) return showToast('No selections made', 'warning');

                const btn = document.getElementById('edit-subprocess-save');
                const original = btn ? btn.textContent : '';
                if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

                const payload = { selections };
                const resp = await safeFetchJson(`/api/upf/production-lots/${this.lotId}/batch_select_variants`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                showToast('Subprocess selections saved', 'success');
                // Refresh data and close modal
                await this.loadLotDetails();
                this.closeEditSubprocessModal();
            } catch (err) {
                console.error('submitEditSubprocessForm', err);
                showToast('Failed to save subprocess selections: ' + (err.message || ''), 'error');
            } finally {
                const btn = document.getElementById('edit-subprocess-save');
                if (btn) { btn.disabled = false; btn.textContent = 'Save Selections'; }
            }
        },

        // -------------------------
        // Delete and finalize
        // -------------------------
        async deleteLot() {
            const confirmed = confirm('Delete this production lot? This action cannot be undone.');
            if (!confirmed) return;
            const btn = document.getElementById('delete-lot-btn');
            const original = btn ? btn.textContent : '';
            try {
                if (btn) { btn.disabled = true; btn.textContent = 'Deleting...'; }
                const resp = await safeFetchJson(`/api/upf/production-lots/${this.lotId}`, { method: 'DELETE' });
                if (resp && resp.success) {
                    showToast('Lot deleted', 'success');
                    // Redirect to lots list
                    window.location.href = '/production-lots';
                } else {
                    throw new Error('Delete failed');
                }
            } catch (err) {
                console.error('deleteLot', err);
                showToast('Failed to delete lot: ' + (err.message || ''), 'error');
            } finally { if (btn) { btn.disabled = false; btn.textContent = original; } }
        },

        async finalizeLot() {
            const confirmed = confirm('Finalize this production lot? This will lock edits.');
            if (!confirmed) return;
            const btn = document.getElementById('finalize-btn');
            const original = btn ? btn.textContent : '';
            try {
                if (btn) { btn.disabled = true; btn.textContent = 'Finalizing...'; }
                const data = await safeFetchJson(`/api/upf/production-lots/${this.lotId}/finalize`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
                showToast('Lot finalized', 'success');
                await this.loadLotDetails();
            } catch (err) {
                console.error('finalizeLot', err);
                showToast('Failed to finalize lot: ' + (err.message || ''), 'error');
            } finally { if (btn) { btn.disabled = false; btn.textContent = original; } }
        },

        // -------------------------
        // Alert acknowledge handlers
        // -------------------------
        /**
         * Acknowledge a single alert
         * @param {string|number} alertId
         */
        async acknowledgeAlert(alertId) {
            try {
                const btn = document.querySelector(`button.alert-action-btn[data-alert-id="${alertId}"]`);
                if (btn) { btn.disabled = true; btn.textContent = 'Working...'; }
                const data = await safeFetchJson(`/api/upf/inventory-alerts/${alertId}/acknowledge`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
                showToast('Alert acknowledged', 'success');
                await this.loadAlerts();
                await this.loadLotDetails();
            } catch (err) {
                console.error('acknowledgeAlert', err);
                showToast('Failed to acknowledge alert: ' + (err.message || ''), 'error');
            }
        },

        /**
         * Bulk acknowledge alerts
         * @param {string[]} alertIds
         */
        async bulkAcknowledgeAlerts(alertIds) {
            if (!alertIds || !alertIds.length) return;
            const btn = document.getElementById('bulk-acknowledge-btn');
            const original = btn ? btn.textContent : '';
            try {
                if (btn) { btn.disabled = true; btn.textContent = `Acknowledging (${alertIds.length})...`; }
                const payload = { alert_ids: alertIds };
                const resp = await safeFetchJson(`/api/upf/inventory-alerts/acknowledge-bulk`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                showToast(`Acknowledged ${resp.acknowledged_count ?? alertIds.length} alerts`, 'success');
                await this.loadAlerts();
                await this.loadLotDetails();
            } catch (err) {
                console.error('bulkAcknowledgeAlerts', err);
                showToast('Failed to bulk acknowledge: ' + (err.message || ''), 'error');
            } finally { if (btn) { btn.disabled = false; btn.textContent = original; } }
        },

        // -------------------------
        // Checkbox logic
        // -------------------------
        attachAlertTableListeners() {
            const container = document.getElementById('alerts-table-body');
            const selectAll = document.getElementById('select-all-alerts');
            const bulkBtn = document.getElementById('bulk-acknowledge-btn');
            if (!container) {
                // Still wire select-all and bulk if table not present
                if (selectAll && !this._selectAllHandler) {
                    const selAllHandler = (e) => { this.toggleSelectAllAlerts(!!e.target.checked); };
                    selectAll.addEventListener('change', selAllHandler);
                    this._selectAllHandler = selAllHandler;
                }
                if (bulkBtn && !this._bulkHandler) {
                    const bulkHandler = (e) => {
                        e.preventDefault();
                        const selected = Array.from(document.querySelectorAll('input.alert-checkbox:checked')).map(i => i.dataset.alertId);
                        if (!selected.length) return showToast('No alerts selected', 'warning');
                        this.bulkAcknowledgeAlerts(selected);
                    };
                    bulkBtn.addEventListener('click', bulkHandler);
                    this._bulkHandler = bulkHandler;
                }
                return;
            }

            // Remove previous delegated handlers if any
            if (this._alertsDelegate) {
                container.removeEventListener('click', this._alertsDelegate.click);
                container.removeEventListener('change', this._alertsDelegate.change);
            }

            // Delegated click handler for action buttons
            const clickHandler = (e) => {
                const btn = e.target.closest && e.target.closest('button.alert-action-btn');
                if (btn && container.contains(btn)) {
                    const id = btn.dataset.alertId;
                    if (id) this.acknowledgeAlert(id);
                }
            };

            // Delegated change handler for checkboxes
            const changeHandler = (e) => {
                const cb = e.target.closest && e.target.closest('input.alert-checkbox');
                if (cb && container.contains(cb)) {
                    this.updateBulkActionButtons();
                    this.updateSelectAllState();
                }
            };

            container.addEventListener('click', clickHandler);
            container.addEventListener('change', changeHandler);
            this._alertsDelegate = { click: clickHandler, change: changeHandler };

            // Select-all
            if (selectAll) {
                selectAll.removeEventListener('change', this._selectAllHandler);
                const selAllHandler = (e) => { this.toggleSelectAllAlerts(!!e.target.checked); };
                selectAll.addEventListener('change', selAllHandler);
                this._selectAllHandler = selAllHandler;
            }

            // Bulk acknowledge button
            if (bulkBtn) {
                bulkBtn.removeEventListener('click', this._bulkHandler);
                const bulkHandler = (e) => {
                    e.preventDefault();
                    const selected = Array.from(document.querySelectorAll('input.alert-checkbox:checked')).map(i => i.dataset.alertId);
                    if (!selected.length) return showToast('No alerts selected', 'warning');
                    this.bulkAcknowledgeAlerts(selected);
                };
                bulkBtn.addEventListener('click', bulkHandler);
                this._bulkHandler = bulkHandler;
            }

            // Update UI state
            this.updateBulkActionButtons();
            this.updateSelectAllState();
        },

        updateBulkActionButtons() {
            const selectedCount = document.querySelectorAll('input.alert-checkbox:checked').length;
            const bulkBtn = document.getElementById('bulk-acknowledge-btn');
            if (bulkBtn) {
                bulkBtn.disabled = selectedCount === 0;
                bulkBtn.textContent = selectedCount > 0 ? `Acknowledge (${selectedCount})` : 'Acknowledge Selected';
            }
        },

        updateSelectAllState() {
            const selectAll = document.getElementById('select-all-alerts');
            if (!selectAll) return;
            const all = Array.from(document.querySelectorAll('input.alert-checkbox'));
            if (!all.length) { selectAll.checked = false; selectAll.indeterminate = false; return; }
            const checked = all.filter(i => i.checked).length;
            selectAll.checked = checked === all.length;
            selectAll.indeterminate = checked > 0 && checked < all.length;
        },

        toggleSelectAllAlerts(checked) {
            const all = Array.from(document.querySelectorAll('input.alert-checkbox'));
            all.forEach(i => { i.checked = !!checked; });
            this.updateBulkActionButtons();
        },

        // -------------------------
        // Subprocess rendering and population
        // -------------------------
        populateSubprocessSelect() {
            try {
                // Use header select id present in template
                const select = document.getElementById('subprocess-select-for-add');
                if (!select) return;
                select.innerHTML = '<option value="">Select subprocess</option>';
                const subs = (this.lotData?.subprocesses) || [];
                for (const s of subs) {
                    const o = document.createElement('option'); o.value = s.id; o.text = s.name; select.appendChild(o);
                }
            } catch (e) { console.error('populateSubprocessSelect', e); }
        },

        renderSubprocesses() {
            const container = document.getElementById('subprocesses-content');
            if (!container) return;
            const subs = this.lotData?.subprocesses || [];
            container.innerHTML = '';
            for (const s of subs) {
                const el = document.createElement('div');
                el.className = 'subprocess-row';
                el.innerHTML = `<div class="subprocess-name">${escapeHtml(s.name)}</div><div><button type="button" class="edit-subprocess-btn" data-subprocess-id="${s.id}">Edit</button></div>`;
                container.appendChild(el);
            }
            // attach edit handlers
            Array.from(container.querySelectorAll('button.edit-subprocess-btn')).forEach(b => {
                b.addEventListener('click', (ev) => { const id = b.dataset.subprocessId; this.openEditSubprocessModal(id); });
            });
        },

        // -------------------------
        // Event wiring
        // -------------------------
        setupEventListeners() {
            // Edit modal open/submit
            const editOpen = document.getElementById('edit-lot-btn');
            if (editOpen) editOpen.addEventListener('click', () => this.openEditModal());
            const editForm = document.getElementById('edit-lot-form');
            if (editForm) editForm.addEventListener('submit', (e) => this.submitEditLotForm(e));

            // Delete
            const deleteBtn = document.getElementById('delete-lot-btn');
            if (deleteBtn) deleteBtn.addEventListener('click', () => this.deleteLot());

            // Finalize
            const finalizeBtn = document.getElementById('finalize-btn');
            if (finalizeBtn) finalizeBtn.addEventListener('click', () => this.finalizeLot());

            // Variant modal open/submit (header button id in template)
            const addVariantBtn = document.getElementById('header-add-variant-btn') || document.getElementById('add-variant-btn');
            if (addVariantBtn) addVariantBtn.addEventListener('click', () => this.openVariantModal());
            const addVariantForm = document.getElementById('add-variant-form');
            if (addVariantForm) addVariantForm.addEventListener('submit', (e) => this.submitAddVariantForm(e));

            // Close modal buttons (explicit IDs from template)
            const modalClose = document.getElementById('modal-close'); if (modalClose) modalClose.addEventListener('click', () => this.closeModal('modal-overlay'));
            const modalCancel = document.getElementById('modal-cancel'); if (modalCancel) modalCancel.addEventListener('click', () => this.closeModal('modal-overlay'));
            const variantClose = document.getElementById('variant-modal-close'); if (variantClose) variantClose.addEventListener('click', () => this.closeModal('variant-modal-overlay'));
            const variantCancel = document.getElementById('variant-modal-cancel'); if (variantCancel) variantCancel.addEventListener('click', () => this.closeModal('variant-modal-overlay'));
            const editSubClose = document.getElementById('edit-subprocess-modal-close'); if (editSubClose) editSubClose.addEventListener('click', () => this.closeModal('edit-subprocess-modal-overlay'));
            const editSubCancel = document.getElementById('edit-subprocess-cancel'); if (editSubCancel) editSubCancel.addEventListener('click', () => this.closeModal('edit-subprocess-modal-overlay'));
            const editSubSave = document.getElementById('edit-subprocess-save'); if (editSubSave) editSubSave.addEventListener('click', (e) => this.submitEditSubprocessForm(e));

            // Refresh variant options
            const refreshBtn = document.getElementById('refresh-variant-options');
            if (refreshBtn) refreshBtn.addEventListener('click', async () => { await this.fetchVariantOptions(); this.renderSubprocesses(); showToast('Variant options refreshed', 'success'); });

            // Modal overlay click should NOT close by requirement; no handler attached.
        },

        // -------------------------
        // Utility
        // -------------------------
        escapeHtml: escapeHtml,
    };

    // Expose singleton and helpers
    window.lotDetailPage = lotDetailPage;
    window.productionLotDetailHelpers = {
        loadVariantOptionsForSubprocess,
        updateTotalCostDisplay,
        recalculateLotCosts: async function (lotId) {
            try {
                // POST per API expectation
                const data = await safeFetchJson(`/api/upf/production-lots/${lotId}/recalculate`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
                const total = data.total_cost ?? data.data?.total_cost ?? data.totalCost ?? null;
                if (typeof total !== 'undefined' && total !== null) updateTotalCostDisplay(Number(total));
                return data;
            } catch (e) { console.error('recalculateLotCosts failed', e); return null; }
        }
    };

    // Initialize when DOM ready
    document.addEventListener('DOMContentLoaded', function () { try { lotDetailPage.init(); } catch (e) { console.error('lotDetailPage init failed', e); showToast('Initialization error', 'error'); } });

})();
