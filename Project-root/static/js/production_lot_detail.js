(function(){
  'use strict';

  // Minimal, single-copy production lot detail script.

  function safeFetchJson(url, opts){
    return fetch(url, opts).then(r => {
      if (!r.ok) throw new Error('Network response not ok: ' + r.status);
      return r.json().catch(()=>({}));
    });
  }

  function findSummaryCostElement(){
    (function(){
        'use strict';

        // Clean single-copy production lot detail script.

        function safeFetchJson(url, opts){
            return fetch(url, opts).then(r => {
                if (!r.ok) throw new Error('Network response not ok: ' + r.status);
                return r.json().catch(()=>({}));
            });
        }

        function findSummaryCostElement(){
            const rows = document.querySelectorAll('#summary-content .detail-row');
            for (const r of rows){
                const label = r.querySelector('.detail-label');
                if (!label) continue;
                if (label.textContent.trim().toLowerCase().includes('total cost')){
                    return r.querySelector('.detail-value');
                }
            }
            return null;
        }

        function updateTotalCostDisplay(amount){
            const el = findSummaryCostElement();
            if (!el) return;
            const num = (typeof amount === 'number') ? amount : Number(amount || 0);
            el.textContent = `$${(isFinite(num)? num.toFixed(2) : '0.00')}`;
        }

        async function recalculateLotCosts(lotId){
            try{
                const resp = await safeFetchJson(`/api/upf/production-lots/${lotId}/recalculate`, { credentials: 'include' });
                const total = resp.total_cost ?? resp.data?.total_cost ?? resp.totalCost ?? null;
                if (typeof total !== 'undefined' && total !== null) updateTotalCostDisplay(Number(total));
                return resp;
            }catch(e){
                console.warn('recalculateLotCosts failed', e);
                return null;
            }
        }

        async function loadVariantOptionsForSubprocess(subprocessId){
            const candidates = [
                `/api/upf/subprocess/${subprocessId}/variant-options`,
                `/api/upf/subprocesses/${subprocessId}/variant_options`,
                `/api/upf/production-lots/${window.LOT_ID || ''}/variant_options?subprocess_id=${subprocessId}`
            ];
            for (const url of candidates){
                try{
                    const res = await fetch(url, { credentials: 'include' });
                    if (!res.ok) continue;
                    const data = await res.json();
                    const ev = new CustomEvent('production:subprocess-variant-options', { detail: { subprocessId, data } });
                    document.dispatchEvent(ev);
                    return data;
                }catch(e){/* try next */}
            }
            console.warn('loadVariantOptionsForSubprocess: no endpoint returned data');
            return null;
        }

        const lotDetailPage = {
            lotId: window.LOT_ID || null,
            lotData: null,
            alertsData: null,

            async init() {
                await this.loadLotDetails();
                await this.loadAlerts();
                try { await this.fetchVariantOptions(); } catch (e) {}
                this.setupEventListeners();
            },

            async loadLotDetails() {
                try {
                    if (!this.lotId) return;
                    const response = await fetch(`/api/upf/production-lots/${this.lotId}`, { method: 'GET', credentials: 'include' });
                    if (response.status === 401) { window.location.href = '/auth/login'; return; }
                    if (!response.ok) throw new Error('Failed to load lot details');
                    const data = await response.json();
                    this.lotData = data.data || data;
                    this.renderLotDetails(); this.renderSummary();
                } catch (error) {
                    console.error('Error loading lot details:', error);
                    const el = document.getElementById('lot-details-content'); if (el) el.innerHTML = '<div class="empty-state">❌ Failed to load lot details</div>';
                }
            },

            async loadAlerts() {
                try {
                    if (!this.lotId) return;
                    const response = await fetch(`/api/upf/inventory-alerts/lot/${this.lotId}`, { credentials: 'include' });
                    if (!response.ok) throw new Error('Failed to load alerts');
                    const data = await response.json(); this.alertsData = data.data || data; this.renderAlerts(); this.updateCriticalBanner(); this.updateFinalizeButton();
                } catch (error) { console.error('Error loading alerts:', error); const ac = document.getElementById('alerts-content'); if (ac) ac.innerHTML = '<div class="empty-state">No alerts available</div>'; }
            },

            async fetchVariantOptions() {
                try {
                    if (!this.lotId) return;
                    const resp = await fetch(`/api/upf/production-lots/${this.lotId}/variant_options`, { credentials: 'include' });
                    if (!resp.ok) throw new Error('Failed to fetch variant options');
                    const data = await resp.json(); this._variantOptions = data.data || data || {};
                } catch (e) { console.error('Error fetching variant options:', e); }
            },

            renderLotDetails() {
                const lot = this.lotData || {};
                const title = document.getElementById('page-title'); if (title) title.textContent = `🏭 Production Lot: ${lot.lot_number || 'N/A'}`;
                const statusClass = (lot.status || 'planning').toLowerCase().replace(/\s+/g, '-');
                const badge = document.getElementById('lot-status-badge'); if (badge) badge.innerHTML = `<span class="status-badge status-${statusClass}">${lot.status || 'Planning'}</span>`;
                const details = document.getElementById('lot-details-content'); if (details) {
                    const notes = this.escapeHtml(lot.notes || '');
                    details.innerHTML = `<div class="detail-row"><span class="detail-label">Lot Number</span><span class="detail-value">${this.escapeHtml(lot.lot_number || 'N/A')}</span></div><div class="detail-row"><span class="detail-label">Notes</span><span class="detail-value">${notes}</span></div>`;
                }
            },

            renderSummary() {
                const lot = this.lotData || {};
                const rawCost = (lot && (lot.total_cost ?? lot.worst_case_estimated_cost)) || 0;
                const costNum = Number(rawCost); const costDisplay = isFinite(costNum) ? costNum.toFixed(2) : '0.00';
                const summaryEl = document.getElementById('summary-content'); if (summaryEl) {
                    summaryEl.innerHTML = `
                        <div class="detail-row"><span class="detail-label">Total Cost</span><span class="detail-value">$${costDisplay}</span></div>
                        <div class="detail-row"><span class="detail-label">Total Alerts</span><span class="detail-value" id="total-alerts-count">-</span></div>
                        <div class="detail-row"><span class="detail-label">Acknowledged</span><span class="detail-value" id="acknowledged-count">-</span></div>
                        <div class="detail-row"><span class="detail-label">Pending</span><span class="detail-value" id="pending-count">-</span></div>
                    `;
                }
            },

            renderAlerts() {
                const alerts = this.alertsData?.alert_details || [];
                const totalAlerts = alerts.length; const badgeEl = document.getElementById('alerts-count-badge'); if (badgeEl) badgeEl.innerHTML = totalAlerts > 0 ? `<span class="status-badge">${totalAlerts} Total</span>` : '';
                const acknowledgedCount = alerts.filter(a => a.user_acknowledged).length; const pendingCount = totalAlerts - acknowledgedCount;
                const totalEl = document.getElementById('total-alerts-count'); const ackEl = document.getElementById('acknowledged-count'); const pendingEl = document.getElementById('pending-count'); if (totalEl) totalEl.textContent = String(totalAlerts); if (ackEl) ackEl.textContent = String(acknowledgedCount); if (pendingEl) pendingEl.textContent = String(pendingCount);
                const container = document.getElementById('alerts-table-body'); if (!container) return;
                if (alerts.length === 0) { const ac = document.getElementById('alerts-content'); if (ac) ac.innerHTML = '<div class="empty-state">✅ No inventory alerts for this lot</div>'; return; }
                container.innerHTML = alerts.map(a => `<tr data-alert-id="${a.alert_id}"><td>${a.alert_id}</td><td>${this.escapeHtml(a.variant_name || 'N/A')}</td><td>${a.current_stock_quantity || 0}</td><td>${a.required_quantity || 0}</td></tr>`).join('');
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

            setupEventListeners() {
                const editBtn = document.getElementById('edit-lot-btn'); if (editBtn) editBtn.addEventListener('click', (e) => { if (editBtn.dataset.editing === '1') { this.submitInlineEdit(); } else { this.showInlineEdit(); } });
                const refreshBtn = document.getElementById('refresh-variant-options'); if (refreshBtn) refreshBtn.addEventListener('click', async () => { await this.fetchVariantOptions(); this.renderSubprocesses && this.renderSubprocesses(); this.showToast && this.showToast('Variant options refreshed', 'success'); });
                const bulkBtn = document.getElementById('bulk-acknowledge-btn'); if (bulkBtn) bulkBtn.addEventListener('click', () => this.handleBulkAcknowledge());
                const finalizeBtn = document.getElementById('finalize-btn'); if (finalizeBtn) finalizeBtn.addEventListener('click', () => this.handleFinalize());
            },

            showToast(message, type = 'info') { try { const container = document.getElementById('global-toast-container'); if (!container) { console.log(type, message); return; } const t = document.createElement('div'); t.className = `toast ${type}`; t.innerHTML = `${this.escapeHtml(String(message))}`; container.appendChild(t); setTimeout(() => t.remove(), 4000); } catch (e) { console.warn(e); } },

            showInlineEdit() { const content = document.getElementById('lot-details-content'); const lot = this.lotData || {}; const qty = this.lotData?.quantity || 1; const notes = this.escapeHtml(this.lotData?.notes || ''); if (!content) return; content.innerHTML = `
                        <div style="display:flex;flex-direction:column;gap:8px">
                            <div class="detail-row"><span class="detail-label">Lot Number</span><span class="detail-value">${this.escapeHtml(lot.lot_number || 'N/A')}</span></div>
                            <div class="detail-row"><span class="detail-label">Process</span><span class="detail-value">${this.escapeHtml(lot.process_name || 'N/A')}</span></div>
                            <div class="detail-row"><span class="detail-label">Quantity</span><span class="detail-value"><input id="inline-lot-quantity" type="number" min="1" value="${qty}" style="width:120px" /></span></div>
                            <div class="detail-row"><span class="detail-label">Notes</span><span class="detail-value"><textarea id="inline-lot-notes" rows="3">${notes}</textarea></span></div>
                        </div>
                    `; const editBtn = document.getElementById('edit-lot-btn'); if (editBtn) { editBtn.textContent = '💾 Save'; editBtn.dataset.editing = '1'; } },

            hideInlineEdit() { const editBtn = document.getElementById('edit-lot-btn'); if (editBtn) { editBtn.textContent = '✏️ Edit'; editBtn.dataset.editing = '0'; } this.renderLotDetails(); },

            async submitInlineEdit() { const qty = Number(document.getElementById('inline-lot-quantity')?.value) || 0; const notes = document.getElementById('inline-lot-notes')?.value || ''; const payload = { quantity: qty, notes }; try { const resp = await fetch(`/api/upf/production-lots/${this.lotId}`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); if (!resp.ok) { const err = await resp.json().catch(()=>({})); throw new Error(err.message || 'Update failed'); } await this.loadLotDetails(); alert('Lot updated'); } catch (e) { console.error(e); alert('Failed to update lot: ' + e.message); } },

            renderSubprocesses() { /* noop in minimal build; full renderer available in original file */ },

            async handleBulkAcknowledge() {
                const selectedCheckboxes = document.querySelectorAll('.alert-checkbox:checked:not(:disabled)'); if (selectedCheckboxes.length === 0) { alert('Please select at least one alert to acknowledge'); return; }
                const acknowledgments = Array.from(selectedCheckboxes).map(cb => { const alertId = parseInt(cb.dataset.alertId); const actionSelect = document.querySelector(`.alert-user-action[data-alert-id="${alertId}"]`); const notesTextarea = document.querySelector(`.alert-action-notes[data-alert-id="${alertId}"]`); const userAction = actionSelect?.value || 'PROCEED'; const actionNotes = notesTextarea?.value || null; return { alert_id: alertId, user_action: userAction, action_notes: actionNotes }; });
                try { const response = await fetch(`/api/upf/inventory-alerts/lot/${this.lotId}/acknowledge-bulk`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ acknowledgments }) }); if (!response.ok) { const error = await response.json(); throw new Error(error.message || 'Failed to acknowledge alerts'); } const result = await response.json(); alert(`Successfully acknowledged ${result.data?.acknowledged_count || acknowledgments.length} alert(s)`); await this.loadAlerts(); } catch (error) { console.error('Error acknowledging alerts:', error); alert('Failed to acknowledge alerts: ' + error.message); }
            },

            async handleFinalize() { if (!confirm('Are you sure you want to finalize this production lot? This action cannot be undone.')) return; try { const response = await fetch(`/api/upf/production-lots/${this.lotId}/finalize`, { method: 'PUT', credentials: 'include' }); if (!response.ok) { const error = await response.json(); throw new Error(error.error?.message || error.message || 'Failed to finalize lot'); } alert('Production lot finalized successfully!'); await this.loadLotDetails(); await this.loadAlerts(); } catch (error) { console.error('Error finalizing lot:', error); alert('Failed to finalize lot: ' + error.message); } },

            escapeHtml(text) { const div = document.createElement('div'); div.textContent = text; return div.innerHTML; }
        };

        window.lotDetailPage = lotDetailPage;

        document.addEventListener('DOMContentLoaded', function() { try { lotDetailPage.init(); } catch (e) { console.warn('lotDetailPage init failed', e); } });

        window.productionLotDetailHelpers = { loadVariantOptionsForSubprocess, recalculateLotCosts, updateTotalCostDisplay };

    })();
            const label = r.querySelector('.detail-label');
            if (!label) continue;
            if (label.textContent.trim().toLowerCase().includes('total cost')){
                return r.querySelector('.detail-value');
            }
        }
        return null;
    }

    function updateTotalCostDisplay(amount){
        const el = findSummaryCostElement();
        if (!el) return;
        const num = (typeof amount === 'number') ? amount : Number(amount || 0);
        el.textContent = `$${(isFinite(num)? num.toFixed(2) : '0.00')}`;
    }

    async function recalculateLotCosts(lotId){
        try{
            const resp = await safeFetchJson(`/api/upf/production-lots/${lotId}/recalculate`, { credentials: 'include' });
            const total = resp.total_cost ?? resp.data?.total_cost ?? resp.totalCost ?? null;
            if (typeof total !== 'undefined' && total !== null) updateTotalCostDisplay(Number(total));
            return resp;
        }catch(e){
            console.warn('recalculateLotCosts failed', e);
            return null;
        }
    }

    async function loadVariantOptionsForSubprocess(subprocessId){
        const candidates = [
            `/api/upf/subprocess/${subprocessId}/variant-options`,
            `/api/upf/subprocesses/${subprocessId}/variant_options`,
            `/api/upf/production-lots/${window.LOT_ID || ''}/variant_options?subprocess_id=${subprocessId}`
        ];
        for (const url of candidates){
            try{
                const res = await fetch(url, { credentials: 'include' });
                if (!res.ok) continue;
                const data = await res.json();
                const ev = new CustomEvent('production:subprocess-variant-options', { detail: { subprocessId, data } });
                document.dispatchEvent(ev);
                return data;
            }catch(e){/* try next */}
        }
        console.warn('loadVariantOptionsForSubprocess: no endpoint returned data');
        return null;
    }

    const lotDetailPage = {
        lotId: window.LOT_ID || null,
        lotData: null,
        alertsData: null,

        async init() {
            await this.loadLotDetails();
            await this.loadAlerts();
            try { await this.fetchVariantOptions(); } catch (e) {}
            this.setupEventListeners();
        },

        async loadLotDetails() {
            try {
                if (!this.lotId) return;
                const response = await fetch(`/api/upf/production-lots/${this.lotId}`, { method: 'GET', credentials: 'include' });
                if (response.status === 401) { window.location.href = '/auth/login'; return; }
                if (!response.ok) throw new Error('Failed to load lot details');
                const data = await response.json();
                this.lotData = data.data || data;
                this.renderLotDetails(); this.renderSummary();
            } catch (error) {
                console.error('Error loading lot details:', error);
                const el = document.getElementById('lot-details-content'); if (el) el.innerHTML = '<div class="empty-state">❌ Failed to load lot details</div>';
            }
        },

        async loadAlerts() {
            try {
                if (!this.lotId) return;
                const response = await fetch(`/api/upf/inventory-alerts/lot/${this.lotId}`, { credentials: 'include' });
                if (!response.ok) throw new Error('Failed to load alerts');
                const data = await response.json(); this.alertsData = data.data || data; this.renderAlerts(); this.updateCriticalBanner(); this.updateFinalizeButton();
            } catch (error) { console.error('Error loading alerts:', error); const ac = document.getElementById('alerts-content'); if (ac) ac.innerHTML = '<div class="empty-state">No alerts available</div>'; }
        },

        async fetchVariantOptions() {
            try {
                if (!this.lotId) return;
                const resp = await fetch(`/api/upf/production-lots/${this.lotId}/variant_options`, { credentials: 'include' });
                if (!resp.ok) throw new Error('Failed to fetch variant options');
                const data = await resp.json(); this._variantOptions = data.data || data || {};
            } catch (e) { console.error('Error fetching variant options:', e); }
        },

        renderLotDetails() {
            const lot = this.lotData || {};
            const title = document.getElementById('page-title'); if (title) title.textContent = `🏭 Production Lot: ${lot.lot_number || 'N/A'}`;
            const statusClass = (lot.status || 'planning').toLowerCase().replace(/\s+/g, '-');
            const badge = document.getElementById('lot-status-badge'); if (badge) badge.innerHTML = `<span class="status-badge status-${statusClass}">${lot.status || 'Planning'}</span>`;
            const details = document.getElementById('lot-details-content'); if (details) {
                const notes = this.escapeHtml(lot.notes || '');
                details.innerHTML = `<div class="detail-row"><span class="detail-label">Lot Number</span><span class="detail-value">${this.escapeHtml(lot.lot_number || 'N/A')}</span></div><div class="detail-row"><span class="detail-label">Notes</span><span class="detail-value">${notes}</span></div>`;
            }
        },

        renderSummary() {
            const lot = this.lotData || {};
            const rawCost = (lot && (lot.total_cost ?? lot.worst_case_estimated_cost)) || 0;
            const costNum = Number(rawCost); const costDisplay = isFinite(costNum) ? costNum.toFixed(2) : '0.00';
            const summaryEl = document.getElementById('summary-content'); if (summaryEl) {
                summaryEl.innerHTML = `
                    <div class="detail-row"><span class="detail-label">Total Cost</span><span class="detail-value">$${costDisplay}</span></div>
                    <div class="detail-row"><span class="detail-label">Total Alerts</span><span class="detail-value" id="total-alerts-count">-</span></div>
                    <div class="detail-row"><span class="detail-label">Acknowledged</span><span class="detail-value" id="acknowledged-count">-</span></div>
                    <div class="detail-row"><span class="detail-label">Pending</span><span class="detail-value" id="pending-count">-</span></div>
                `;
            }
        },

        renderAlerts() {
            const alerts = this.alertsData?.alert_details || [];
            const totalAlerts = alerts.length; const badgeEl = document.getElementById('alerts-count-badge'); if (badgeEl) badgeEl.innerHTML = totalAlerts > 0 ? `<span class="status-badge">${totalAlerts} Total</span>` : '';
            const acknowledgedCount = alerts.filter(a => a.user_acknowledged).length; const pendingCount = totalAlerts - acknowledgedCount;
            const totalEl = document.getElementById('total-alerts-count'); const ackEl = document.getElementById('acknowledged-count'); const pendingEl = document.getElementById('pending-count'); if (totalEl) totalEl.textContent = String(totalAlerts); if (ackEl) ackEl.textContent = String(acknowledgedCount); if (pendingEl) pendingEl.textContent = String(pendingCount);
            const container = document.getElementById('alerts-table-body'); if (!container) return;
            if (alerts.length === 0) { const ac = document.getElementById('alerts-content'); if (ac) ac.innerHTML = '<div class="empty-state">✅ No inventory alerts for this lot</div>'; return; }
            container.innerHTML = alerts.map(a => `<tr data-alert-id="${a.alert_id}"><td>${a.alert_id}</td><td>${this.escapeHtml(a.variant_name || 'N/A')}</td><td>${a.current_stock_quantity || 0}</td><td>${a.required_quantity || 0}</td></tr>`).join('');
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

        setupEventListeners() {
            const editBtn = document.getElementById('edit-lot-btn'); if (editBtn) editBtn.addEventListener('click', (e) => { if (editBtn.dataset.editing === '1') { this.submitInlineEdit(); } else { this.showInlineEdit(); } });
            const refreshBtn = document.getElementById('refresh-variant-options'); if (refreshBtn) refreshBtn.addEventListener('click', async () => { await this.fetchVariantOptions(); this.renderSubprocesses && this.renderSubprocesses(); this.showToast && this.showToast('Variant options refreshed', 'success'); });
            const bulkBtn = document.getElementById('bulk-acknowledge-btn'); if (bulkBtn) bulkBtn.addEventListener('click', () => this.handleBulkAcknowledge());
            const finalizeBtn = document.getElementById('finalize-btn'); if (finalizeBtn) finalizeBtn.addEventListener('click', () => this.handleFinalize());
        },

        showToast(message, type = 'info') { try { const container = document.getElementById('global-toast-container'); if (!container) { console.log(type, message); return; } const t = document.createElement('div'); t.className = `toast ${type}`; t.innerHTML = `${this.escapeHtml(String(message))}`; container.appendChild(t); setTimeout(() => t.remove(), 4000); } catch (e) { console.warn(e); } },

        showInlineEdit() { const content = document.getElementById('lot-details-content'); const lot = this.lotData || {}; const qty = this.lotData?.quantity || 1; const notes = this.escapeHtml(this.lotData?.notes || ''); const status = this.lotData?.status || 'Planning'; if (!content) return; content.innerHTML = `
                <div style="display:flex;flex-direction:column;gap:8px">
                    <div class="detail-row"><span class="detail-label">Lot Number</span><span class="detail-value">${this.escapeHtml(lot.lot_number || 'N/A')}</span></div>
                    <div class="detail-row"><span class="detail-label">Process</span><span class="detail-value">${this.escapeHtml(lot.process_name || 'N/A')}</span></div>
                    <div class="detail-row"><span class="detail-label">Quantity</span><span class="detail-value"><input id="inline-lot-quantity" type="number" min="1" value="${qty}" style="width:120px" /></span></div>
                    <div class="detail-row"><span class="detail-label">Notes</span><span class="detail-value"><textarea id="inline-lot-notes" rows="3">${notes}</textarea></span></div>
                </div>
            `; const editBtn = document.getElementById('edit-lot-btn'); if (editBtn) { editBtn.textContent = '💾 Save'; editBtn.dataset.editing = '1'; } },

        hideInlineEdit() { const editBtn = document.getElementById('edit-lot-btn'); if (editBtn) { editBtn.textContent = '✏️ Edit'; editBtn.dataset.editing = '0'; } this.renderLotDetails(); },

        async submitInlineEdit() { const qty = Number(document.getElementById('inline-lot-quantity')?.value) || 0; const notes = document.getElementById('inline-lot-notes')?.value || ''; const payload = { quantity: qty, notes }; try { const resp = await fetch(`/api/upf/production-lots/${this.lotId}`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); if (!resp.ok) { const err = await resp.json().catch(()=>({})); throw new Error(err.message || 'Update failed'); } await this.loadLotDetails(); alert('Lot updated'); } catch (e) { console.error(e); alert('Failed to update lot: ' + e.message); } },

        renderSubprocesses() { /* noop in minimal build; full renderer available in original file */ },

        async handleBulkAcknowledge() {
            const selectedCheckboxes = document.querySelectorAll('.alert-checkbox:checked:not(:disabled)'); if (selectedCheckboxes.length === 0) { alert('Please select at least one alert to acknowledge'); return; }
            const acknowledgments = Array.from(selectedCheckboxes).map(cb => { const alertId = parseInt(cb.dataset.alertId); const actionSelect = document.querySelector(`.alert-user-action[data-alert-id="${alertId}"]`); const notesTextarea = document.querySelector(`.alert-action-notes[data-alert-id="${alertId}"]`); const userAction = actionSelect?.value || 'PROCEED'; const actionNotes = notesTextarea?.value || null; return { alert_id: alertId, user_action: userAction, action_notes: actionNotes }; });
            try { const response = await fetch(`/api/upf/inventory-alerts/lot/${this.lotId}/acknowledge-bulk`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ acknowledgments }) }); if (!response.ok) { const error = await response.json(); throw new Error(error.message || 'Failed to acknowledge alerts'); } const result = await response.json(); alert(`Successfully acknowledged ${result.data?.acknowledged_count || acknowledgments.length} alert(s)`); await this.loadAlerts(); } catch (error) { console.error('Error acknowledging alerts:', error); alert('Failed to acknowledge alerts: ' + error.message); }
        },

        async handleFinalize() { if (!confirm('Are you sure you want to finalize this production lot? This action cannot be undone.')) return; try { const response = await fetch(`/api/upf/production-lots/${this.lotId}/finalize`, { method: 'PUT', credentials: 'include' }); if (!response.ok) { const error = await response.json(); throw new Error(error.error?.message || error.message || 'Failed to finalize lot'); } alert('Production lot finalized successfully!'); await this.loadLotDetails(); await this.loadAlerts(); } catch (error) { console.error('Error finalizing lot:', error); alert('Failed to finalize lot: ' + error.message); } },

        escapeHtml(text) { const div = document.createElement('div'); div.textContent = text; return div.innerHTML; }
    };

    window.lotDetailPage = lotDetailPage;

    document.addEventListener('DOMContentLoaded', function() { try { lotDetailPage.init(); } catch (e) { console.warn('lotDetailPage init failed', e); } });

    window.productionLotDetailHelpers = { loadVariantOptionsForSubprocess, recalculateLotCosts, updateTotalCostDisplay };

})();
(function(){
    'use strict';

    // Cleaned production lot page script.
    // Keeps helper APIs and a minimal, robust page object for the detail view.

    function safeFetchJson(url, opts){
        return fetch(url, opts).then(r => {
            if (!r.ok) throw new Error('Network response not ok: ' + r.status);
            return r.json().catch(()=>({}));
        });
    }

    function findSummaryCostElement(){
        const rows = document.querySelectorAll('#summary-content .detail-row');
        for (const r of rows){
            const label = r.querySelector('.detail-label');
            if (!label) continue;
            if (label.textContent.trim().toLowerCase().includes('total cost')){
                return r.querySelector('.detail-value');
            }
        }
        return null;
    }

    function updateTotalCostDisplay(amount){
        const el = findSummaryCostElement();
        if (!el) return;
        const num = (typeof amount === 'number') ? amount : Number(amount || 0);
        el.textContent = `$${(isFinite(num)? num.toFixed(2) : '0.00')}`;
    }

    async function recalculateLotCosts(lotId){
        try{
            const resp = await safeFetchJson(`/api/upf/production-lots/${lotId}/recalculate`, { credentials: 'include' });
            const total = resp.total_cost ?? resp.data?.total_cost ?? resp.totalCost ?? null;
            if (typeof total !== 'undefined' && total !== null) updateTotalCostDisplay(Number(total));
            return resp;
        }catch(e){
            console.warn('recalculateLotCosts failed', e);
            return null;
        }
    }

    async function loadVariantOptionsForSubprocess(subprocessId){
        const candidates = [
            `/api/upf/subprocess/${subprocessId}/variant-options`,
            `/api/upf/subprocesses/${subprocessId}/variant_options`,
            `/api/upf/production-lots/${window.LOT_ID || ''}/variant_options?subprocess_id=${subprocessId}`
        ];
        for (const url of candidates){
            try{
                const res = await fetch(url, { credentials: 'include' });
                if (!res.ok) continue;
                const data = await res.json();
                const ev = new CustomEvent('production:subprocess-variant-options', { detail: { subprocessId, data } });
                document.dispatchEvent(ev);
                return data;
            }catch(e){/* try next */}
        }
        console.warn('loadVariantOptionsForSubprocess: no endpoint returned data');
        return null;
    }

    const lotDetailPage = {
        lotId: window.LOT_ID || null,
        lotData: null,
        alertsData: null,

        async init() {
            await this.loadLotDetails();
            await this.loadAlerts();
            try { await this.fetchVariantOptions(); } catch (e) {}
            this.setupEventListeners();
        },

        async loadLotDetails() {
            try {
                if (!this.lotId) return;
                const response = await fetch(`/api/upf/production-lots/${this.lotId}`, { method: 'GET', credentials: 'include' });
                if (response.status === 401) { window.location.href = '/auth/login'; return; }
                if (!response.ok) throw new Error('Failed to load lot details');
                const data = await response.json();
                this.lotData = data.data || data;
                this.renderLotDetails(); this.renderSummary();
            } catch (error) {
                console.error('Error loading lot details:', error);
                const el = document.getElementById('lot-details-content'); if (el) el.innerHTML = '<div class="empty-state">❌ Failed to load lot details</div>';
            }
        },

        async loadAlerts() {
            try {
                if (!this.lotId) return;
                const response = await fetch(`/api/upf/inventory-alerts/lot/${this.lotId}`, { credentials: 'include' });
                if (!response.ok) throw new Error('Failed to load alerts');
                const data = await response.json(); this.alertsData = data.data || data; this.renderAlerts(); this.updateCriticalBanner(); this.updateFinalizeButton();
            } catch (error) { console.error('Error loading alerts:', error); const ac = document.getElementById('alerts-content'); if (ac) ac.innerHTML = '<div class="empty-state">No alerts available</div>'; }
        },

        async fetchVariantOptions() {
            try {
                if (!this.lotId) return;
                const resp = await fetch(`/api/upf/production-lots/${this.lotId}/variant_options`, { credentials: 'include' });
                if (!resp.ok) throw new Error('Failed to fetch variant options');
                const data = await resp.json(); this._variantOptions = data.data || data || {};
            } catch (e) { console.error('Error fetching variant options:', e); }
        },

        renderLotDetails() {
            const lot = this.lotData || {};
            const title = document.getElementById('page-title'); if (title) title.textContent = `🏭 Production Lot: ${lot.lot_number || 'N/A'}`;
            const statusClass = (lot.status || 'planning').toLowerCase().replace(/\s+/g, '-');
            const badge = document.getElementById('lot-status-badge'); if (badge) badge.innerHTML = `<span class="status-badge status-${statusClass}">${lot.status || 'Planning'}</span>`;
            const details = document.getElementById('lot-details-content'); if (details) {
                const notes = this.escapeHtml(lot.notes || '');
                details.innerHTML = `<div class="detail-row"><span class="detail-label">Lot Number</span><span class="detail-value">${this.escapeHtml(lot.lot_number || 'N/A')}</span></div><div class="detail-row"><span class="detail-label">Notes</span><span class="detail-value">${notes}</span></div>`;
            }
        },

        renderSummary() {
            const lot = this.lotData || {};
            const rawCost = (lot && (lot.total_cost ?? lot.worst_case_estimated_cost)) || 0;
            const costNum = Number(rawCost); const costDisplay = isFinite(costNum) ? costNum.toFixed(2) : '0.00';
            const summaryEl = document.getElementById('summary-content'); if (summaryEl) {
                summaryEl.innerHTML = `
                    <div class="detail-row"><span class="detail-label">Total Cost</span><span class="detail-value">$${costDisplay}</span></div>
                    <div class="detail-row"><span class="detail-label">Total Alerts</span><span class="detail-value" id="total-alerts-count">-</span></div>
                    <div class="detail-row"><span class="detail-label">Acknowledged</span><span class="detail-value" id="acknowledged-count">-</span></div>
                    <div class="detail-row"><span class="detail-label">Pending</span><span class="detail-value" id="pending-count">-</span></div>
                `;
            }
        },

        renderAlerts() {
            const alerts = this.alertsData?.alert_details || [];
            const totalAlerts = alerts.length; const badgeEl = document.getElementById('alerts-count-badge'); if (badgeEl) badgeEl.innerHTML = totalAlerts > 0 ? `<span class="status-badge">${totalAlerts} Total</span>` : '';
            const acknowledgedCount = alerts.filter(a => a.user_acknowledged).length; const pendingCount = totalAlerts - acknowledgedCount;
            const totalEl = document.getElementById('total-alerts-count'); const ackEl = document.getElementById('acknowledged-count'); const pendingEl = document.getElementById('pending-count'); if (totalEl) totalEl.textContent = String(totalAlerts); if (ackEl) ackEl.textContent = String(acknowledgedCount); if (pendingEl) pendingEl.textContent = String(pendingCount);
            const container = document.getElementById('alerts-table-body'); if (!container) return;
            if (alerts.length === 0) { const ac = document.getElementById('alerts-content'); if (ac) ac.innerHTML = '<div class="empty-state">✅ No inventory alerts for this lot</div>'; return; }
            container.innerHTML = alerts.map(a => `<tr data-alert-id="${a.alert_id}"><td>${a.alert_id}</td><td>${this.escapeHtml(a.variant_name || 'N/A')}</td><td>${a.current_stock_quantity || 0}</td><td>${a.required_quantity || 0}</td></tr>`).join('');
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

        setupEventListeners() {
            const editBtn = document.getElementById('edit-lot-btn'); if (editBtn) editBtn.addEventListener('click', (e) => { if (editBtn.dataset.editing === '1') { this.submitInlineEdit(); } else { this.showInlineEdit(); } });
            const refreshBtn = document.getElementById('refresh-variant-options'); if (refreshBtn) refreshBtn.addEventListener('click', async () => { await this.fetchVariantOptions(); this.renderSubprocesses && this.renderSubprocesses(); this.showToast && this.showToast('Variant options refreshed', 'success'); });
            const bulkBtn = document.getElementById('bulk-acknowledge-btn'); if (bulkBtn) bulkBtn.addEventListener('click', () => this.handleBulkAcknowledge());
            const finalizeBtn = document.getElementById('finalize-btn'); if (finalizeBtn) finalizeBtn.addEventListener('click', () => this.handleFinalize());
        },

        showToast(message, type = 'info') { try { const container = document.getElementById('global-toast-container'); if (!container) { console.log(type, message); return; } const t = document.createElement('div'); t.className = `toast ${type}`; t.innerHTML = `${this.escapeHtml(String(message))}`; container.appendChild(t); setTimeout(() => t.remove(), 4000); } catch (e) { console.warn(e); } },

        showInlineEdit() { const content = document.getElementById('lot-details-content'); const lot = this.lotData || {}; const qty = this.lotData?.quantity || 1; const notes = this.escapeHtml(this.lotData?.notes || ''); const status = this.lotData?.status || 'Planning'; if (!content) return; content.innerHTML = `
                <div style="display:flex;flex-direction:column;gap:8px">
                    <div class="detail-row"><span class="detail-label">Lot Number</span><span class="detail-value">${this.escapeHtml(lot.lot_number || 'N/A')}</span></div>
                    <div class="detail-row"><span class="detail-label">Process</span><span class="detail-value">${this.escapeHtml(lot.process_name || 'N/A')}</span></div>
                    <div class="detail-row"><span class="detail-label">Quantity</span><span class="detail-value"><input id="inline-lot-quantity" type="number" min="1" value="${qty}" style="width:120px" /></span></div>
                    <div class="detail-row"><span class="detail-label">Notes</span><span class="detail-value"><textarea id="inline-lot-notes" rows="3">${notes}</textarea></span></div>
                </div>
            `; const editBtn = document.getElementById('edit-lot-btn'); if (editBtn) { editBtn.textContent = '💾 Save'; editBtn.dataset.editing = '1'; } },

        hideInlineEdit() { const editBtn = document.getElementById('edit-lot-btn'); if (editBtn) { editBtn.textContent = '✏️ Edit'; editBtn.dataset.editing = '0'; } this.renderLotDetails(); },

        async submitInlineEdit() { const qty = Number(document.getElementById('inline-lot-quantity')?.value) || 0; const notes = document.getElementById('inline-lot-notes')?.value || ''; const payload = { quantity: qty, notes }; try { const resp = await fetch(`/api/upf/production-lots/${this.lotId}`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); if (!resp.ok) { const err = await resp.json().catch(()=>({})); throw new Error(err.message || 'Update failed'); } await this.loadLotDetails(); alert('Lot updated'); } catch (e) { console.error(e); alert('Failed to update lot: ' + e.message); } },

        renderSubprocesses() { /* noop in minimal build; full renderer available in original file */ },

        async handleBulkAcknowledge() {
            const selectedCheckboxes = document.querySelectorAll('.alert-checkbox:checked:not(:disabled)'); if (selectedCheckboxes.length === 0) { alert('Please select at least one alert to acknowledge'); return; }
            const acknowledgments = Array.from(selectedCheckboxes).map(cb => { const alertId = parseInt(cb.dataset.alertId); const actionSelect = document.querySelector(`.alert-user-action[data-alert-id="${alertId}"]`); const notesTextarea = document.querySelector(`.alert-action-notes[data-alert-id="${alertId}"]`); const userAction = actionSelect?.value || 'PROCEED'; const actionNotes = notesTextarea?.value || null; return { alert_id: alertId, user_action: userAction, action_notes: actionNotes }; });
            try { const response = await fetch(`/api/upf/inventory-alerts/lot/${this.lotId}/acknowledge-bulk`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ acknowledgments }) }); if (!response.ok) { const error = await response.json(); throw new Error(error.message || 'Failed to acknowledge alerts'); } const result = await response.json(); alert(`Successfully acknowledged ${result.data?.acknowledged_count || acknowledgments.length} alert(s)`); await this.loadAlerts(); } catch (error) { console.error('Error acknowledging alerts:', error); alert('Failed to acknowledge alerts: ' + error.message); }
        },

        async handleFinalize() { if (!confirm('Are you sure you want to finalize this production lot? This action cannot be undone.')) return; try { const response = await fetch(`/api/upf/production-lots/${this.lotId}/finalize`, { method: 'PUT', credentials: 'include' }); if (!response.ok) { const error = await response.json(); throw new Error(error.error?.message || error.message || 'Failed to finalize lot'); } alert('Production lot finalized successfully!'); await this.loadLotDetails(); await this.loadAlerts(); } catch (error) { console.error('Error finalizing lot:', error); alert('Failed to finalize lot: ' + error.message); } },

        escapeHtml(text) { const div = document.createElement('div'); div.textContent = text; return div.innerHTML; }
    };

    window.lotDetailPage = lotDetailPage;

    document.addEventListener('DOMContentLoaded', function() { try { lotDetailPage.init(); } catch (e) { console.warn('lotDetailPage init failed', e); } });

    window.productionLotDetailHelpers = { loadVariantOptionsForSubprocess, recalculateLotCosts, updateTotalCostDisplay };

})();
*** End Patch

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

        setupEventListeners() {
            const selectAllCheckbox = document.getElementById('select-all-alerts'); if (selectAllCheckbox) { selectAllCheckbox.addEventListener('change', (e) => { const checkboxes = document.querySelectorAll('.alert-checkbox:not(:disabled)'); checkboxes.forEach(cb => cb.checked = e.target.checked); this.updateBulkActionButton(); }); }
            document.addEventListener('change', (e) => { if (e.target.classList && e.target.classList.contains('alert-checkbox')) this.updateBulkActionButton(); });
            const bulkBtn = document.getElementById('bulk-acknowledge-btn'); if (bulkBtn) bulkBtn.addEventListener('click', () => this.handleBulkAcknowledge());
            const finalizeBtn = document.getElementById('finalize-btn'); if (finalizeBtn) finalizeBtn.addEventListener('click', () => this.handleFinalize());
            const editBtn = document.getElementById('edit-lot-btn'); if (editBtn) editBtn.addEventListener('click', (e) => { if (editBtn.dataset.editing === '1') { this.submitInlineEdit(); } else { this.showInlineEdit(); } });
            const deleteBtn = document.getElementById('delete-lot-btn'); if (deleteBtn) deleteBtn.addEventListener('click', () => this.handleDeleteLot());
            const addVariantBtn = document.getElementById('add-variant-btn'); if (addVariantBtn) addVariantBtn.addEventListener('click', () => this.showAddVariantModal());
            const headerAddBtn = document.getElementById('header-add-variant-btn'); if (headerAddBtn) headerAddBtn.addEventListener('click', () => { const sel = document.getElementById('subprocess-select-for-add'); let val = sel ? sel.value : null; if (!val && sel && sel.options && sel.options.length > 0) { for (let i = 0; i < sel.options.length; i++) { const o = sel.options[i]; if (o && o.value) { sel.selectedIndex = i; val = o.value; break; } } } if (!val && this._variantOptions && Array.isArray(this._variantOptions.subprocesses) && this._variantOptions.subprocesses.length > 0) { const first = this._variantOptions.subprocesses[0]; val = first.process_subprocess_id || first.sequence_order || null; } if (!val) { alert('Please select a subprocess from the dropdown before adding a variant.'); return; } try { this.showEditSubprocessModal(Number(val)); } catch (e) { console.error('header-add-variant-btn: failed to open subprocess editor', e); alert('Failed to open subprocess editor: ' + (e && e.message ? e.message : 'unknown')); } });
            const refreshBtn = document.getElementById('refresh-variant-options'); if (refreshBtn) refreshBtn.addEventListener('click', async () => { await this.fetchVariantOptions(); this.renderSubprocesses(); alert('Variant options refreshed'); });
            const modalCloseBtn = document.getElementById('modal-close'); if (modalCloseBtn) modalCloseBtn.addEventListener('click', () => this.hideEditModal()); const modalCancelBtn = document.getElementById('modal-cancel'); if (modalCancelBtn) modalCancelBtn.addEventListener('click', () => this.hideEditModal()); const variantModalClose = document.getElementById('variant-modal-close'); if (variantModalClose) variantModalClose.addEventListener('click', () => this.hideAddVariantModal()); const variantModalCancel = document.getElementById('variant-modal-cancel'); if (variantModalCancel) variantModalCancel.addEventListener('click', () => this.hideAddVariantModal());
            const editSubprocessClose = document.getElementById('edit-subprocess-modal-close'); if (editSubprocessClose) editSubprocessClose.addEventListener('click', () => this.hideEditSubprocessModal()); const editSubprocessCancel = document.getElementById('edit-subprocess-cancel'); if (editSubprocessCancel) editSubprocessCancel.addEventListener('click', () => this.hideEditSubprocessModal());
            const groupSelect = document.getElementById('variant-group-select'); if (groupSelect) groupSelect.addEventListener('change', () => this.onVariantGroupChange()); const variantSearch = document.getElementById('variant-search'); if (variantSearch) { const debounce = (fn, wait) => { let t = null; return (...args) => { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), wait); }; }; variantSearch.addEventListener('input', debounce((e) => this.onVariantSearchInput(e.target.value), 300)); }
            document.addEventListener('input', (e) => { if (e.target && e.target.classList && e.target.classList.contains('inline-qty-input')) { const perUnit = Number(e.target.value) || 0; const lotQty = (this.lotData && Number(this.lotData.quantity)) || 1; const lotTotal = perUnit * lotQty; const td = e.target.closest('td'); if (td && td.nextElementSibling) td.nextElementSibling.textContent = lotTotal; e.target.dataset.dirty = '1'; } });
            const editLotForm = document.getElementById('edit-lot-form'); if (editLotForm) editLotForm.addEventListener('submit', (e) => { e.preventDefault(); this.submitEditModal(); }); const addVariantForm = document.getElementById('add-variant-form'); if (addVariantForm) addVariantForm.addEventListener('submit', (e) => { e.preventDefault(); this.submitAddVariant(); });
        },

        async handleEditLot() { this.showEditModal(); },

        async handleDeleteLot() { if (!confirm('Delete this production lot? This action cannot be undone.')) return; try { const resp = await fetch(`/api/upf/production-lots/${this.lotId}`, { method: 'DELETE', credentials: 'include' }); if (!resp.ok) { const err = await resp.json().catch(() => ({})); throw new Error(err.message || 'Delete failed'); } alert('Lot deleted'); window.location.href = '/upf/production-lots'; } catch (e) { console.error('Error deleting lot:', e); alert('Failed to delete lot: ' + e.message); } },

        async handleAddVariant() { this.showAddVariantModal(); },

        async handleRemoveVariant(selectionId) { if (!confirm('Remove this variant selection from the lot?')) return; try { const resp = await fetch(`/api/upf/production-lots/${this.lotId}/selections/${selectionId}`, { method: 'DELETE', credentials: 'include' }); if (!resp.ok) { const err = await resp.json().catch(() => ({})); throw new Error(err.message || 'Remove failed'); } alert('Selection removed'); await this.loadLotDetails(); } catch (e) { console.error('Error removing selection:', e); alert('Failed to remove selection: ' + e.message); } },

        showEditModal() { const qtyEl = document.getElementById('modal-quantity'); const notesEl = document.getElementById('modal-notes'); const statusEl = document.getElementById('modal-status'); qtyEl.value = this.lotData?.quantity || 1; notesEl.value = this.lotData?.notes || ''; statusEl.value = this.lotData?.status || 'Planning'; document.getElementById('modal-overlay').style.display = 'flex'; },

        hideEditModal() { document.getElementById('modal-overlay').style.display = 'none'; },

        async submitEditModal() { const qty = Number(document.getElementById('modal-quantity').value) || 0; const notes = document.getElementById('modal-notes').value; const status = document.getElementById('modal-status').value; const payload = { quantity: qty, notes: notes, status: status }; try { const resp = await fetch(`/api/upf/production-lots/${this.lotId}`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); if (!resp.ok) { const err = await resp.json().catch(() => ({})); throw new Error(err.message || 'Update failed'); } this.hideEditModal(); await this.loadLotDetails(); alert('Lot updated'); } catch (e) { console.error('Error updating lot:', e); alert('Failed to update lot: ' + e.message); } },

        showInlineEdit() { const content = document.getElementById('lot-details-content'); const lot = this.lotData || {}; const qty = this.lotData?.quantity || 1; const notes = this.escapeHtml(this.lotData?.notes || ''); const status = this.lotData?.status || 'Planning'; content.innerHTML = `\n+            <div style="display:flex;flex-direction:column;gap:8px">\n+                <div class="detail-row">\n+                    <span class="detail-label">Lot Number</span>\n+                    <span class="detail-value">${this.escapeHtml(lot.lot_number || 'N/A')}</span>\n+                </div>\n+                <div class="detail-row">\n+                    <span class="detail-label">Process</span>\n+                    <span class="detail-value">${this.escapeHtml(lot.process_name || 'N/A')}</span>\n+                </div>\n+                <div class="detail-row">\n+                    <span class="detail-label">Quantity</span>\n+                    <span class="detail-value"><input id="inline-lot-quantity" type="number" min="1" value="${qty}" style="width:120px" /></span>\n+                </div>\n+                <div class="detail-row">\n+                    <span class="detail-label">Status</span>\n+                    <span class="detail-value">\n+                        <select id="inline-lot-status">\n+                            <option value="Planning">Planning</option>\n+                            <option value="Ready">Ready</option>\n+                            <option value="In Progress">In Progress</option>\n+                            <option value="completed">completed</option>\n+                            <option value="finalized">finalized</option>\n+                            <option value="cancelled">cancelled</option>\n+                        </select>\n+                    </span>\n+                </div>\n+                <div class="detail-row">\n+                    <span class="detail-label">Notes</span>\n+                    <span class="detail-value"><textarea id="inline-lot-notes" rows="3">${notes}</textarea></span>\n+                </div>\n+                <div class="detail-row">\n+                    <span class="detail-label">Created By</span>\n+                    <span class="detail-value">${this.escapeHtml(lot.created_by_name || String(lot.created_by || ''))}</span>\n+                </div>\n+                <div class="detail-row">\n+                    <span class="detail-label">Created At</span>\n+                    <span class="detail-value">${lot.created_at ? new Date(lot.created_at).toLocaleString() : 'N/A'}</span>\n+                </div>\n+            </div>\n+        `; const statusEl = document.getElementById('inline-lot-status'); if (statusEl) statusEl.value = status; const editBtn = document.getElementById('edit-lot-btn'); if (editBtn) { editBtn.textContent = '💾 Save'; editBtn.classList.add('btn-primary'); editBtn.dataset.editing = '1'; } if (!document.getElementById('cancel-edit-btn')) { const header = document.querySelector('.page-header div'); if (header) { const cancelBtn = document.createElement('button'); cancelBtn.id = 'cancel-edit-btn'; cancelBtn.className = 'btn'; cancelBtn.textContent = '✖ Cancel'; cancelBtn.style.marginLeft = '8px'; cancelBtn.addEventListener('click', () => this.hideInlineEdit()); header.appendChild(cancelBtn); } } },

        hideInlineEdit() { const editBtn = document.getElementById('edit-lot-btn'); if (editBtn) { editBtn.textContent = '✏️ Edit'; editBtn.classList.remove('btn-primary'); editBtn.dataset.editing = '0'; } const cancelBtn = document.getElementById('cancel-edit-btn'); if (cancelBtn) cancelBtn.remove(); this.renderLotDetails(); },

        async submitInlineEdit() { const qty = Number(document.getElementById('inline-lot-quantity')?.value) || 0; const notes = document.getElementById('inline-lot-notes')?.value || ''; const status = document.getElementById('inline-lot-status')?.value || ''; const payload = { quantity: qty, notes: notes, status: status }; try { const resp = await fetch(`/api/upf/production-lots/${this.lotId}`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); if (!resp.ok) { const err = await resp.json().catch(() => ({})); throw new Error(err.message || 'Update failed'); } await this.loadLotDetails(); const cancelBtn = document.getElementById('cancel-edit-btn'); if (cancelBtn) cancelBtn.remove(); const editBtn = document.getElementById('edit-lot-btn'); if (editBtn) { editBtn.textContent = '✏️ Edit'; editBtn.classList.remove('btn-primary'); editBtn.dataset.editing = '0'; } alert('Lot updated'); } catch (e) { console.error('Error updating lot (inline):', e); alert('Failed to update lot: ' + e.message); } },

        showAddVariantModal(processSubprocessId) {
            try { if (processSubprocessId && document.querySelector) { const psEl = document.querySelector(`[data-ps-id="${processSubprocessId}"]`); if (psEl) { psEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); try { psEl.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {} } } } catch (e) { console.warn('showAddVariantModal: error selecting subprocess element', e); }
            this._activeProcessSubprocessId = processSubprocessId || null; const qtyEl = document.getElementById('variant-qty'); if (qtyEl) qtyEl.value = 1; try { const immediateOverlay = document.getElementById('variant-modal-overlay'); if (immediateOverlay) { immediateOverlay.style.display = 'flex'; immediateOverlay.style.pointerEvents = 'auto'; immediateOverlay.style.background = 'rgba(0,0,0,0.5)'; immediateOverlay.style.zIndex = '1000000'; } } catch (err) { console.warn('showAddVariantModal: failed to force-open overlay', err); }
            this.fetchVariantOptions().then(() => {
                try {
                    const groupSelect = document.getElementById('variant-group-select');
                    if (this._activeProcessSubprocessId && this._variantOptions) {
                        groupSelect.innerHTML = '<option value="">-- Select Group (or standalone) --</option>';
                        const sp = (this._variantOptions.subprocesses || []).find(s => s.process_subprocess_id === this._activeProcessSubprocessId);
                        if (sp) {
                            (sp.or_groups || []).forEach(g => { const opt = document.createElement('option'); const gid = g.group_id || g.id; opt.value = gid; opt.textContent = g.group_name || g.name || `Group ${gid}`; groupSelect.appendChild(opt); });
                            const variantSelect = document.getElementById('variant-select'); variantSelect.innerHTML = '<option value="">-- Select Variant --</option>'; (sp.standalone_variants || []).forEach(v => { const vo = document.createElement('option'); const vid = v.item_id || v.variant_id || v.usage_id || v.id; const nameParts = [v.item_number || v.variant_name || v.description || String(vid), v.model_name || v.model || '', v.variation_name || v.variation || '', v.size_name || v.size || ''].filter(Boolean); vo.value = vid; vo.textContent = nameParts.join(' - ') + (v.color_name ? ` (${v.color_name})` : ''); variantSelect.appendChild(vo); });
                        }
                    }
                } catch (e) { console.warn('Error scoping add-variant modal to subprocess:', e); }
                const overlay = document.getElementById('variant-modal-overlay'); if (overlay) { overlay.style.display = 'flex'; overlay.style.pointerEvents = 'auto'; overlay.style.background = overlay.style.background || 'rgba(0,0,0,0.5)'; overlay.style.zIndex = overlay.style.zIndex || '1000000'; }
            }).catch((e) => { console.error('Failed to load variant options:', e); const overlay = document.getElementById('variant-modal-overlay'); if (overlay) { overlay.style.display = 'flex'; overlay.style.pointerEvents = 'auto'; overlay.style.background = overlay.style.background || 'rgba(0,0,0,0.5)'; overlay.style.zIndex = overlay.style.zIndex || '1000000'; } });
        },

        hideAddVariantModal() { document.getElementById('variant-modal-overlay').style.display = 'none'; },

        async submitAddVariant() { const groupVal = document.getElementById('variant-group-select').value; const variantVal = document.getElementById('variant-select').value; const qty = Number(document.getElementById('variant-qty').value) || 0; const substitute_group_id = groupVal ? Number(groupVal) : null; const variant_id = variantVal ? (isNaN(Number(variantVal)) ? variantVal : Number(variantVal)) : null; if (!variant_id) { alert('Please select a variant'); return; } const payload = { substitute_group_id, selected_variant_id: variant_id, variant_id, quantity: qty }; if (this._activeProcessSubprocessId) payload.process_subprocess_id = this._activeProcessSubprocessId; try { const resp = await fetch(`/api/upf/production-lots/${this.lotId}/select-variant`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); if (!resp.ok) { const err = await resp.json().catch(() => ({})); throw new Error(err.message || 'Add variant failed'); } this.hideAddVariantModal(); await this.loadLotDetails(); alert('Variant added/updated'); } catch (e) { console.error('Error adding variant:', e); alert('Failed to add variant: ' + e.message); } },

        async fetchVariantOptions() {
            try {
                const resp = await fetch(`/api/upf/production-lots/${this.lotId}/variant_options`, { credentials: 'include' });
                if (!resp.ok) throw new Error('Failed to fetch variant options');
                const data = await resp.json(); const payload = data.data || data; this._variantOptions = payload; const groupSelect = document.getElementById('variant-group-select'); const variantSelect = document.getElementById('variant-select'); groupSelect.innerHTML = '<option value="">-- Select Group (or standalone) --</option>'; variantSelect.innerHTML = '<option value="">-- Select Variant --</option>';
                const groups = []; const variantsByGroup = {}; const standalone = [];
                (payload.subprocesses || []).forEach(sp => { (sp.or_groups || []).forEach(g => { if (!groups.find(x => x.group_id === g.group_id || x.id === g.id)) { const gid = g.group_id || g.id; groups.push({ id: gid, name: g.group_name || g.group_name || g.name || `Group ${gid}` }); variantsByGroup[gid] = []; } }); const gv = sp.grouped_variants || {}; Object.keys(gv || {}).forEach(k => { const gid = Number(k); const arr = gv[k] || []; variantsByGroup[gid] = (variantsByGroup[gid] || []).concat(arr.map(v => { const id = v.item_id || v.variant_id || v.usage_id || v.id; const itemName = v.item_number || v.variant_name || v.description || String(id); const model = v.model_name || v.model || ''; const variation = v.variation_name || v.variation || ''; const size = v.size_name || v.size || ''; const color = v.color_name || v.color || ''; const labelParts = [itemName, model, variation, size].filter(Boolean); const label = labelParts.join(' - ') + (color ? ` (${color})` : ''); return { id, label }; })); }); (sp.standalone_variants || []).forEach(v => { const id = v.item_id || v.variant_id || v.usage_id || v.id; const itemName = v.item_number || v.variant_name || v.description || String(id); const model = v.model_name || v.model || ''; const variation = v.variation_name || v.variation || ''; const size = v.size_name || v.size || ''; const color = v.color_name || v.color || ''; const labelParts = [itemName, model, variation, size].filter(Boolean); const label = labelParts.join(' - ') + (color ? ` (${color})` : ''); standalone.push({ id, label }); }); });
                groups.forEach(g => { const opt = document.createElement('option'); opt.value = g.id; opt.textContent = g.name; groupSelect.appendChild(opt); });
                if (standalone.length > 0) { standalone.forEach(v => { const vo = document.createElement('option'); vo.value = v.id; vo.textContent = v.label; variantSelect.appendChild(vo); }); }
                this._variantsByGroup = variantsByGroup; this._standaloneVariants = standalone;
            } catch (e) { console.error('Error fetching variant options:', e); throw e; }
        },

        onVariantGroupChange() { const groupVal = document.getElementById('variant-group-select').value; const variantSelect = document.getElementById('variant-select'); variantSelect.innerHTML = '<option value="">-- Select Variant --</option>'; if (!groupVal) { (this._standaloneVariants || []).forEach(v => { const vo = document.createElement('option'); vo.value = v.id; vo.textContent = v.label; variantSelect.appendChild(vo); }); return; } const gid = Number(groupVal); const variants = (this._variantsByGroup && this._variantsByGroup[gid]) || []; variants.forEach(v => { const vo = document.createElement('option'); vo.value = v.id; vo.textContent = v.label; variantSelect.appendChild(vo); }); },

        async onVariantSearchInput(query) { const q = String(query || '').trim(); const variantSelect = document.getElementById('variant-select'); if (!variantSelect) return; if (!q) { this.onVariantGroupChange(); return; } try { const resp = await fetch(`/api/upf/variants/search?q=${encodeURIComponent(q)}&limit=50`, { credentials: 'include' }); if (!resp.ok) { console.warn('Variant search returned non-ok response'); return; } const data = await resp.json(); const results = data.data || data || []; variantSelect.innerHTML = '<option value="">-- Select Variant --</option>'; (results || []).forEach(v => { const id = v.item_id || v.variant_id || v.id; const label = v.item_number || v.variant_name || v.name || (v.description && v.description.slice(0,60)) || String(id); const opt = document.createElement('option'); opt.value = id; opt.textContent = `${label}`; variantSelect.appendChild(opt); }); } catch (e) { console.error('Error during variant search:', e); } },

        openVariantSearchForSubprocess(processSubprocessId) {
            try {
                const modal = document.getElementById('variant-search-modal');
                if (!modal) { alert('Variant search modal is not available on this page.'); return; }
                modal.dataset.targetProcessSubprocessId = processSubprocessId;
                if (this._variantSearchProdHandler) { try { document.getElementById('add-selected-variants-btn')?.removeEventListener('click', this._variantSearchProdHandler); } catch (e) {} this._variantSearchProdHandler = null; }
                const handler = async (ev) => {
                    const resultsEl = document.getElementById('variant-search-results'); if (!resultsEl) { this.showToast('Variant search results are not available.', 'error'); return; }
                    const selected = Array.from(resultsEl.querySelectorAll('input[type="checkbox"]:checked')); if (!selected || selected.length === 0) { this.showToast('Please select at least one variant to add.', 'info'); return; }
                    const variantIds = selected.map(cb => cb.dataset.variantId || cb.getAttribute('data-variant-id')).filter(Boolean).map(v => Number(v)); if (variantIds.length === 0) { this.showToast('No valid variant ids found in selection.', 'error'); return; }
                    const addBtn = document.getElementById('add-selected-variants-btn'); this.showButtonLoading(addBtn, 'Adding...');
                    try {
                        const selections = variantIds.map(id => ({ selected_variant_id: id })); const body = { selections, process_subprocess_id: processSubprocessId };
                        const tryUrls = [ `/api/upf/production-lots/${this.lotId}/batch_select_variants`, `/api/upf/production_lot/${this.lotId}/batch_select_variants` ];
                        let resp = null; for (const url of tryUrls) { try { resp = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); if (resp.status === 404) { resp = null; continue; } break; } catch (e) { resp = null; } }
                        if (!resp) throw new Error('Failed to reach batch add endpoint'); if (!resp.ok) { const err = await resp.json().catch(() => ({})); throw new Error(err.message || `Server returned ${resp.status}`); }
                        try { Modal.close(modal); } catch (e) { modal.classList.remove('is-open'); }
                        await this.loadLotDetails(); await this.fetchVariantOptions(); this.renderSubprocesses(); this.showToast(`Added ${variantIds.length} variant(s) to subprocess.`, 'success');
                    } catch (err) { console.error('Error adding selected variants to subprocess:', err); this.showToast('Failed to add selected variants: ' + (err && err.message ? err.message : String(err)), 'error'); } finally { if (addBtn) this.restoreButton(addBtn); }
                };
                this._variantSearchProdHandler = handler.bind(this); document.getElementById('add-selected-variants-btn')?.addEventListener('click', this._variantSearchProdHandler);
                try { Modal.open(modal); } catch (e) { modal.classList.add('is-open'); }
            } catch (e) { console.error('openVariantSearchForSubprocess error', e); alert('Unable to open variant search: ' + (e && e.message ? e.message : 'unknown')); }
        },

        updateBulkActionButton() { const selectedCheckboxes = document.querySelectorAll('.alert-checkbox:checked:not(:disabled)'); const bulkBtn = document.getElementById('bulk-acknowledge-btn'); if (bulkBtn) { bulkBtn.disabled = selectedCheckboxes.length === 0; bulkBtn.textContent = selectedCheckboxes.length > 0 ? `Acknowledge ${selectedCheckboxes.length} Selected Alert${selectedCheckboxes.length > 1 ? 's' : ''}` : 'Acknowledge Selected Alerts'; } },

        async handleBulkAcknowledge() {
            const selectedCheckboxes = document.querySelectorAll('.alert-checkbox:checked:not(:disabled)'); if (selectedCheckboxes.length === 0) { alert('Please select at least one alert to acknowledge'); return; }
            const acknowledgments = Array.from(selectedCheckboxes).map(cb => { const alertId = parseInt(cb.dataset.alertId); const actionSelect = document.querySelector(`.alert-user-action[data-alert-id="${alertId}"]`); const notesTextarea = document.querySelector(`.alert-action-notes[data-alert-id="${alertId}"]`); const userAction = actionSelect?.value || 'PROCEED'; const actionNotes = notesTextarea?.value || null; return { alert_id: alertId, user_action: userAction, action_notes: actionNotes }; });
            try { const response = await fetch(`/api/upf/inventory-alerts/lot/${this.lotId}/acknowledge-bulk`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ acknowledgments }) }); if (!response.ok) { const error = await response.json(); throw new Error(error.message || 'Failed to acknowledge alerts'); } const result = await response.json(); alert(`Successfully acknowledged ${result.data?.acknowledged_count || acknowledgments.length} alert(s)`); await this.loadAlerts(); } catch (error) { console.error('Error acknowledging alerts:', error); alert('Failed to acknowledge alerts: ' + error.message); }
        },

        async handleFinalize() { if (!confirm('Are you sure you want to finalize this production lot? This action cannot be undone.')) return; try { const response = await fetch(`/api/upf/production-lots/${this.lotId}/finalize`, { method: 'PUT', credentials: 'include' }); if (!response.ok) { const error = await response.json(); throw new Error(error.error?.message || error.message || 'Failed to finalize lot'); } alert('Production lot finalized successfully!'); await this.loadLotDetails(); await this.loadAlerts(); } catch (error) { console.error('Error finalizing lot:', error); alert('Failed to finalize lot: ' + error.message); } },

        escapeHtml(text) { const div = document.createElement('div'); div.textContent = text; return div.innerHTML; }
    };

    (function(){
        'use strict';

        // Minimal, cleaned version of the production lot page script.
        // Purpose: preserve the helper API and primary page object while
        // removing stray characters that caused literal '+' to appear in HTML.

        function safeFetchJson(url, opts){
            return fetch(url, opts).then(r => {
                if (!r.ok) throw new Error('Network response not ok: ' + r.status);
                return r.json().catch(()=>({}));
            });
        }

        function findSummaryCostElement(){
            const rows = document.querySelectorAll('#summary-content .detail-row');
            for (const r of rows){
                const label = r.querySelector('.detail-label');
                if (!label) continue;
                if (label.textContent.trim().toLowerCase().includes('total cost')){
                    return r.querySelector('.detail-value');
                }
            }
            return null;
        }

        function updateTotalCostDisplay(amount){
            const el = findSummaryCostElement();
            if (!el) return;
            const num = (typeof amount === 'number') ? amount : Number(amount || 0);
            el.textContent = `$${(isFinite(num)? num.toFixed(2) : '0.00')}`;
        }

        async function recalculateLotCosts(lotId){
            try{
                const resp = await safeFetchJson(`/api/upf/production-lots/${lotId}/recalculate`, { credentials: 'include' });
                const total = resp.total_cost ?? resp.data?.total_cost ?? resp.totalCost ?? null;
                if (typeof total !== 'undefined' && total !== null) updateTotalCostDisplay(Number(total));
                return resp;
            }catch(e){
                console.warn('recalculateLotCosts failed', e);
                return null;
            }
        }

        async function loadVariantOptionsForSubprocess(subprocessId){
            const candidates = [
                `/api/upf/subprocess/${subprocessId}/variant-options`,
                `/api/upf/subprocesses/${subprocessId}/variant_options`,
                `/api/upf/production-lots/${window.LOT_ID || ''}/variant_options?subprocess_id=${subprocessId}`
            ];
            for (const url of candidates){
                try{
                    const res = await fetch(url, { credentials: 'include' });
                    if (!res.ok) continue;
                    const data = await res.json();
                    const ev = new CustomEvent('production:subprocess-variant-options', { detail: { subprocessId, data } });
                    document.dispatchEvent(ev);
                    return data;
                }catch(e){/* try next */}
            }
            console.warn('loadVariantOptionsForSubprocess: no endpoint returned data');
            return null;
        }

        const lotDetailPage = {
            lotId: window.LOT_ID || null,
            lotData: null,
            alertsData: null,

            async init() {
                await this.loadLotDetails();
                await this.loadAlerts();
                try { await this.fetchVariantOptions(); } catch (e) {}
                this.setupEventListeners();
            },

            async loadLotDetails() {
                try {
                    if (!this.lotId) return;
                    const response = await fetch(`/api/upf/production-lots/${this.lotId}`, { method: 'GET', credentials: 'include' });
                    if (response.status === 401) { window.location.href = '/auth/login'; return; }
                    if (!response.ok) throw new Error('Failed to load lot details');
                    const data = await response.json();
                    this.lotData = data.data || data;
                    this.renderLotDetails(); this.renderSummary();
                } catch (error) {
                    console.error('Error loading lot details:', error);
                    const el = document.getElementById('lot-details-content'); if (el) el.innerHTML = '<div class="empty-state">❌ Failed to load lot details</div>';
                }
            },

            async loadAlerts() {
                try {
                    if (!this.lotId) return;
                    const response = await fetch(`/api/upf/inventory-alerts/lot/${this.lotId}`, { credentials: 'include' });
                    if (!response.ok) throw new Error('Failed to load alerts');
                    const data = await response.json(); this.alertsData = data.data || data; this.renderAlerts(); this.updateCriticalBanner(); this.updateFinalizeButton();
                } catch (error) { console.error('Error loading alerts:', error); const ac = document.getElementById('alerts-content'); if (ac) ac.innerHTML = '<div class="empty-state">No alerts available</div>'; }
            },

            async fetchVariantOptions() {
                try {
                    if (!this.lotId) return;
                    const resp = await fetch(`/api/upf/production-lots/${this.lotId}/variant_options`, { credentials: 'include' });
                    if (!resp.ok) throw new Error('Failed to fetch variant options');
                    const data = await resp.json(); this._variantOptions = data.data || data || {};
                } catch (e) { console.error('Error fetching variant options:', e); }
            },

            renderLotDetails() {
                const lot = this.lotData || {};
                const title = document.getElementById('page-title'); if (title) title.textContent = `🏭 Production Lot: ${lot.lot_number || 'N/A'}`;
                const statusClass = (lot.status || 'planning').toLowerCase().replace(/\s+/g, '-');
                const badge = document.getElementById('lot-status-badge'); if (badge) badge.innerHTML = `<span class="status-badge status-${statusClass}">${lot.status || 'Planning'}</span>`;
                const details = document.getElementById('lot-details-content'); if (details) {
                    const notes = this.escapeHtml(lot.notes || '');
                    details.innerHTML = `<div class="detail-row"><span class="detail-label">Lot Number</span><span class="detail-value">${this.escapeHtml(lot.lot_number || 'N/A')}</span></div><div class="detail-row"><span class="detail-label">Notes</span><span class="detail-value">${notes}</span></div>`;
                }
            },

            renderSummary() {
                const lot = this.lotData || {};
                const rawCost = (lot && (lot.total_cost ?? lot.worst_case_estimated_cost)) || 0;
                const costNum = Number(rawCost); const costDisplay = isFinite(costNum) ? costNum.toFixed(2) : '0.00';
                const summaryEl = document.getElementById('summary-content'); if (summaryEl) {
                    summaryEl.innerHTML = `
                        <div class="detail-row"><span class="detail-label">Total Cost</span><span class="detail-value">$${costDisplay}</span></div>
                        <div class="detail-row"><span class="detail-label">Total Alerts</span><span class="detail-value" id="total-alerts-count">-</span></div>
                        <div class="detail-row"><span class="detail-label">Acknowledged</span><span class="detail-value" id="acknowledged-count">-</span></div>
                        <div class="detail-row"><span class="detail-label">Pending</span><span class="detail-value" id="pending-count">-</span></div>
                    `;
                }
            },

            renderAlerts() {
                const alerts = this.alertsData?.alert_details || [];
                const totalAlerts = alerts.length; const badgeEl = document.getElementById('alerts-count-badge'); if (badgeEl) badgeEl.innerHTML = totalAlerts > 0 ? `<span class="status-badge">${totalAlerts} Total</span>` : '';
                const acknowledgedCount = alerts.filter(a => a.user_acknowledged).length; const pendingCount = totalAlerts - acknowledgedCount;
                const totalEl = document.getElementById('total-alerts-count'); const ackEl = document.getElementById('acknowledged-count'); const pendingEl = document.getElementById('pending-count'); if (totalEl) totalEl.textContent = String(totalAlerts); if (ackEl) ackEl.textContent = String(acknowledgedCount); if (pendingEl) pendingEl.textContent = String(pendingCount);
                const container = document.getElementById('alerts-table-body'); if (!container) return;
                if (alerts.length === 0) { const ac = document.getElementById('alerts-content'); if (ac) ac.innerHTML = '<div class="empty-state">✅ No inventory alerts for this lot</div>'; return; }
                container.innerHTML = alerts.map(a => `<tr data-alert-id="${a.alert_id}"><td>${a.alert_id}</td><td>${this.escapeHtml(a.variant_name || 'N/A')}</td><td>${a.current_stock_quantity || 0}</td><td>${a.required_quantity || 0}</td></tr>`).join('');
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

            setupEventListeners() {
                const editBtn = document.getElementById('edit-lot-btn'); if (editBtn) editBtn.addEventListener('click', (e) => { if (editBtn.dataset.editing === '1') { this.submitInlineEdit(); } else { this.showInlineEdit(); } });
                const refreshBtn = document.getElementById('refresh-variant-options'); if (refreshBtn) refreshBtn.addEventListener('click', async () => { await this.fetchVariantOptions(); this.renderSubprocesses && this.renderSubprocesses(); this.showToast && this.showToast('Variant options refreshed', 'success'); });
            },

            showToast(message, type = 'info') { try { const container = document.getElementById('global-toast-container'); if (!container) { console.log(type, message); return; } const t = document.createElement('div'); t.className = `toast ${type}`; t.innerHTML = `${this.escapeHtml(String(message))}`; container.appendChild(t); setTimeout(() => t.remove(), 4000); } catch (e) { console.warn(e); } },

            showInlineEdit() { const content = document.getElementById('lot-details-content'); const lot = this.lotData || {}; const qty = this.lotData?.quantity || 1; const notes = this.escapeHtml(this.lotData?.notes || ''); const status = this.lotData?.status || 'Planning'; if (!content) return; content.innerHTML = `
                <div style="display:flex;flex-direction:column;gap:8px">
                    <div class="detail-row"><span class="detail-label">Lot Number</span><span class="detail-value">${this.escapeHtml(lot.lot_number || 'N/A')}</span></div>
                    <div class="detail-row"><span class="detail-label">Process</span><span class="detail-value">${this.escapeHtml(lot.process_name || 'N/A')}</span></div>
                    <div class="detail-row"><span class="detail-label">Quantity</span><span class="detail-value"><input id="inline-lot-quantity" type="number" min="1" value="${qty}" style="width:120px" /></span></div>
                    <div class="detail-row"><span class="detail-label">Notes</span><span class="detail-value"><textarea id="inline-lot-notes" rows="3">${notes}</textarea></span></div>
                </div>
            `; const editBtn = document.getElementById('edit-lot-btn'); if (editBtn) { editBtn.textContent = '💾 Save'; editBtn.dataset.editing = '1'; } },

            hideInlineEdit() { const editBtn = document.getElementById('edit-lot-btn'); if (editBtn) { editBtn.textContent = '✏️ Edit'; editBtn.dataset.editing = '0'; } this.renderLotDetails(); },

            async submitInlineEdit() { const qty = Number(document.getElementById('inline-lot-quantity')?.value) || 0; const notes = document.getElementById('inline-lot-notes')?.value || ''; const payload = { quantity: qty, notes }; try { const resp = await fetch(`/api/upf/production-lots/${this.lotId}`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); if (!resp.ok) { const err = await resp.json().catch(()=>({})); throw new Error(err.message || 'Update failed'); } await this.loadLotDetails(); alert('Lot updated'); } catch (e) { console.error(e); alert('Failed to update lot: ' + e.message); } },

            renderSubprocesses() { /* noop in minimal build; full renderer available in original file */ },

            escapeHtml(text) { const div = document.createElement('div'); div.textContent = text; return div.innerHTML; }
        };

        window.lotDetailPage = lotDetailPage;

        document.addEventListener('DOMContentLoaded', function() { try { lotDetailPage.init(); } catch (e) { console.warn('lotDetailPage init failed', e); } });

        window.productionLotDetailHelpers = { loadVariantOptionsForSubprocess, recalculateLotCosts, updateTotalCostDisplay };

    })();
