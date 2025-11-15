// Minimal, authoritative production lot detail script (single IIFE)
(function () {
    'use strict';

    // Lightweight helper to fetch JSON safely
    function safeFetchJson(url, opts) {
        return fetch(url, opts).then((r) => {
            if (!r.ok) throw new Error('Network response not ok: ' + r.status);
            return r.json().catch(() => ({}));
        });
    }

    // Find the element used to display the summary Total Cost row
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

    async function recalculateLotCosts(lotId) {
        try {
            const resp = await safeFetchJson(`/api/upf/production-lots/${lotId}/recalculate`, { credentials: 'include' });
            const total = resp.total_cost ?? resp.data?.total_cost ?? resp.totalCost ?? null;
            if (typeof total !== 'undefined' && total !== null) updateTotalCostDisplay(Number(total));
            return resp;
        } catch (e) {
            console.warn('recalculateLotCosts failed', e);
            return null;
        }
    }

    // Try several endpoint shapes to fetch variant options for a subprocess
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
            }
        }
        return null;
    }

    const lotDetailPage = {
        lotId: window.LOT_ID || null,
        lotData: null,
        alertsData: null,

        async init() {
            await this.loadLotDetails();
            await this.loadAlerts();
            try { await this.fetchVariantOptions(); } catch (e) { /* non-fatal */ }
            this.setupEventListeners();
        },

        async loadLotDetails() {
            try {
                if (!this.lotId) return;
                const response = await fetch(`/api/upf/production-lots/${this.lotId}`, { credentials: 'include' });
                if (response.status === 401) { window.location.href = '/auth/login'; return; }
                if (!response.ok) throw new Error('Failed to load lot details');
                const data = await response.json();
                this.lotData = data.data || data;
                this.renderLotDetails();
                this.renderSummary();
            } catch (err) {
                console.error('Error loading lot details:', err);
                const el = document.getElementById('lot-details-content'); if (el) el.innerHTML = '<div class="empty-state">❌ Failed to load lot details</div>';
            }
        },

        async loadAlerts() {
            try {
                if (!this.lotId) return;
                const response = await fetch(`/api/upf/inventory-alerts/lot/${this.lotId}`, { credentials: 'include' });
                if (!response.ok) throw new Error('Failed to load alerts');
                const data = await response.json();
                this.alertsData = data.data || data;
                this.renderAlerts();
                this.updateCriticalBanner();
                this.updateFinalizeButton();
            } catch (err) {
                console.error('Error loading alerts:', err);
                const ac = document.getElementById('alerts-content'); if (ac) ac.innerHTML = '<div class="empty-state">No alerts available</div>';
            }
        },

        async fetchVariantOptions() {
            try {
                if (!this.lotId) return;
                const resp = await fetch(`/api/upf/production-lots/${this.lotId}/variant_options`, { credentials: 'include' });
                if (!resp.ok) throw new Error('Failed to fetch variant options');
                const data = await resp.json(); this._variantOptions = data.data || data || {};
            } catch (e) {
                console.error('Error fetching variant options:', e);
            }
        },

        renderLotDetails() {
            const lot = this.lotData || {};
            const title = document.getElementById('page-title'); if (title) title.textContent = `🏭 Production Lot: ${lot.lot_number || 'N/A'}`;
            const statusClass = (lot.status || 'planning').toLowerCase().replace(/\s+/g, '-');
            const badge = document.getElementById('lot-status-badge'); if (badge) badge.innerHTML = `<span class="status-badge status-${statusClass}">${lot.status || 'Planning'}</span>`;
            const details = document.getElementById('lot-details-content');
            if (details) {
                const notes = this.escapeHtml(lot.notes || '');
                details.innerHTML = `<div class="detail-row"><span class="detail-label">Lot Number</span><span class="detail-value">${this.escapeHtml(lot.lot_number || 'N/A')}</span></div><div class="detail-row"><span class="detail-label">Notes</span><span class="detail-value">${notes}</span></div>`;
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

        renderAlerts() {
            const alerts = this.alertsData?.alert_details || [];
            const totalAlerts = alerts.length;
            const badgeEl = document.getElementById('alerts-count-badge'); if (badgeEl) badgeEl.innerHTML = totalAlerts > 0 ? `<span class="status-badge">${totalAlerts} Total</span>` : '';
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
            const editBtn = document.getElementById('edit-lot-btn'); if (editBtn) editBtn.addEventListener('click', () => { if (editBtn.dataset.editing === '1') { this.submitInlineEdit(); } else { this.showInlineEdit(); } });
            const refreshBtn = document.getElementById('refresh-variant-options'); if (refreshBtn) refreshBtn.addEventListener('click', async () => { await this.fetchVariantOptions(); this.renderSubprocesses && this.renderSubprocesses(); this.showToast && this.showToast('Variant options refreshed', 'success'); });
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

        renderSubprocesses() { /* noop in minimal build */ },

        escapeHtml(text) { const d = document.createElement('div'); d.textContent = text; return d.innerHTML; }
    };

    window.lotDetailPage = lotDetailPage;
    document.addEventListener('DOMContentLoaded', function () { try { lotDetailPage.init(); } catch (e) { console.warn('lotDetailPage init failed', e); } });
    window.productionLotDetailHelpers = { loadVariantOptionsForSubprocess, recalculateLotCosts, updateTotalCostDisplay };

})();
