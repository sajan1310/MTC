(function(){
    'use strict';

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
            // Expecting { total_cost: 123.45 } or similar
            const total = resp.total_cost ?? resp.data?.total_cost ?? resp.data?.totalCost ?? resp.totalCost;
            if (typeof total !== 'undefined') updateTotalCostDisplay(Number(total));
            return resp;
        }catch(e){
            console.warn('recalculateLotCosts failed', e);
            return null;
        }
    }

    async function loadVariantOptionsForSubprocess(subprocessId){
        // Try a few fallback endpoints commonly used in this app
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
                // dispatch a custom event so page code can pick it up
                const ev = new CustomEvent('production:subprocess-variant-options', { detail: { subprocessId, data } });
                document.dispatchEvent(ev);
                return data;
            }catch(e){/* try next */}
        }
        console.warn('loadVariantOptionsForSubprocess: no endpoint returned data');
        return null;
    }

    // The large page object extracted from the template
    const lotDetailPage = {
        lotId: window.LOT_ID || null,
        lotData: null,
        alertsData: null,

        async init() {
            await this.loadLotDetails();
            await this.loadAlerts();
            try { await this.fetchVariantOptions(); } catch (e) {}
            this.setupEventListeners();
            this.renderSubprocesses();
            if (window.ProductionLotAlertHandler) {
                window.ProductionLotAlertHandler.init(this.lotId);
            }
        },

        showToast(message, type = 'info', timeout = 4000) {
            try {
                const container = document.getElementById('global-toast-container');
                if (!container) { try { alert(message); } catch (e) {} return; }
                const toast = document.createElement('div');
                toast.className = `toast ${type}`;
                toast.role = 'status';
                toast.innerHTML = `
                <div style="flex-shrink:0">${type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️'}</div>
                <div style="flex:1;">${this.escapeHtml(String(message))}</div>
                <div class="toast-close" aria-label="close">✖</div>
            `;
                container.appendChild(toast);
                requestAnimationFrame(() => toast.classList.add('show'));
                toast.querySelector('.toast-close')?.addEventListener('click', () => { try { toast.classList.remove('show'); setTimeout(() => toast.remove(), 240); } catch (e) {} });
                if (timeout > 0) setTimeout(() => { try { toast.classList.remove('show'); setTimeout(() => toast.remove(), 240); } catch (e) {} }, timeout);
            } catch (e) { console.warn('showToast failed', e); }
        },

        showButtonLoading(btn, text) {
            if (!btn) return;
            try {
                if (!btn.dataset._prevHtml) btn.dataset._prevHtml = btn.innerHTML || '';
                if (typeof btn.disabled !== 'undefined' && !btn.dataset._prevDisabled) btn.dataset._prevDisabled = btn.disabled ? '1' : '0';
                btn.disabled = true;
                btn.innerHTML = `<span class="spinner" aria-hidden="true"></span>${this.escapeHtml(String(text || 'Loading...'))}`;
            } catch (e) { console.warn('showButtonLoading failed', e); }
        },

        restoreButton(btn) {
            if (!btn) return;
            try {
                if (btn.dataset._prevHtml !== undefined) { btn.innerHTML = btn.dataset._prevHtml; delete btn.dataset._prevHtml; }
                if (btn.dataset._prevDisabled !== undefined) { btn.disabled = btn.dataset._prevDisabled === '1'; delete btn.dataset._prevDisabled; } else { btn.disabled = false; }
            } catch (e) { console.warn('restoreButton failed', e); }
        },

        async loadLotDetails() {
            try {
                const response = await fetch(`/api/upf/production-lots/${this.lotId}`, { method: 'GET', credentials: 'include' });
                if (response.status === 401) { window.location.href = '/auth/login'; return; }
                if (!response.ok) throw new Error('Failed to load lot details');
                const data = await response.json();
                this.lotData = data.data || data;
                this.renderLotDetails(); this.renderSummary(); this.renderVariants();
            } catch (error) {
                console.error('Error loading lot details:', error);
                document.getElementById('lot-details-content').innerHTML = '<div class="empty-state">❌ Failed to load lot details</div>';
            }
        },

        renderVariants() {
            const selections = this.lotData?.selections || [];
            const container = document.getElementById('variants-content'); if (!container) return;
            if (selections.length === 0) { container.innerHTML = '<div class="empty-state">No variant selections yet.</div>'; return; }
            const lotQty = (this.lotData && Number(this.lotData.quantity)) || 1;
            const rows = selections.map(s => {
                const selId = s.get ? s.get('id') : s.id || s['id'];
                const itemName = s.item_number || s.item_name || s.variant_name || '';
                const model = s.model || s.item_model || '';
                const variation = s.variation || s.variant_sku || '';
                const size = s.size || '';
                const details = [itemName, model, variation, size].filter(Boolean).join(' - ') || (s.selected_variant_id || 'Variant');
                const perUnitQty = Number(s.selected_quantity || s.quantity || 0);
                const totalQty = (perUnitQty * lotQty) || 0;
                return `
                <div class="detail-row" data-selection-id="${selId}">
                    <div style="flex:1">
                        <div class="detail-label">${this.escapeHtml(String(details))}</div>
                        <div class="detail-value">Quantity per unit: ${perUnitQty} — Total required: ${totalQty}</div>
                    </div>
                    <div style="display:flex;gap:8px;align-items:center">
                        <button class="btn" onclick="lotDetailPage.handleRemoveVariant(${selId})">Remove</button>
                    </div>
                </div>
            `;
            }).join('');
            container.innerHTML = rows;
        },

        renderSubprocesses() {
            const data = (this._variantOptions || {});
            const subs = data.subprocesses || [];
            const container = document.getElementById('subprocesses-content'); if (!container) return;
            if (subs.length === 0) { container.innerHTML = '<div class="empty-state">No subprocess variant options available.</div>'; return; }
            const lotQty = (this.lotData && Number(this.lotData.quantity)) || 1;

            const html = subs.map(sp => {
                const costItems = sp.cost_items || []; let subtotalPerUnit = 0;
                costItems.forEach(ci => { const q = Number(ci.quantity) || 0; const rate = Number(ci.amount || ci.rate) || 0; subtotalPerUnit += q * rate; });
                const scaledSubtotal = subtotalPerUnit * lotQty;
                const variants = []; (Object.values(sp.grouped_variants || {}).flat() || []).forEach(v => variants.push(v)); (sp.standalone_variants || []).forEach(v => variants.push(v));
                const uniqueColors = Array.from(new Set(variants.map(v => (v.color_name || v.color || v.variant_color || 'Default').toString())));
                const colorHeaders = uniqueColors.map(c => `<th colspan="2">${this.escapeHtml(c)}</th>`).join('');
                const colorSubHeaders = uniqueColors.map(_ => `<th>Qty per Unit</th><th>Lot Qty</th>`).join('');
                const rowsById = {};
                variants.forEach(v => { const vid = v.usage_id || v.id || v.variant_id || v.item_id; if (!rowsById[vid]) rowsById[vid] = { variants: [] }; rowsById[vid].variants.push(v); });

                const rowsHtml = Object.keys(rowsById).map(vid => {
                    const vGroup = rowsById[vid].variants[0];
                    const itemName = vGroup.item_number || vGroup.variant_name || vGroup.description || String(vid);
                    const model = vGroup.model_name || vGroup.model || vGroup.item_model || '';
                    const variation = vGroup.variation_name || vGroup.variation || vGroup.variant_sku || '';
                    const size = vGroup.size_name || vGroup.size || '';
                    const details = [itemName, model, variation, size].filter(Boolean).join(' - ');
                    const colorCells = uniqueColors.map(col => {
                        const match = rowsById[vid].variants.find(x => (x.color_name || x.color || x.variant_color || x.description || 'Default').toString() === col);
                        if (!match) return '<td></td><td></td>';
                        const perUnit = Number(match.quantity || match.qty || 0);
                        const lotTotal = perUnit * lotQty;
                        return `<td><input type="number" value="${perUnit}" min="0" step="0.01" data-usage-id="${match.usage_id || match.id || ''}" class="inline-qty-input"/></td><td class="lot-total">${lotTotal}</td>`;
                    }).join('');
                    return `<tr><td>${this.escapeHtml(details)}</td>${colorCells}</tr>`;
                }).join('');

                return `
                <div data-ps-id="${sp.process_subprocess_id}" style="margin-bottom:12px;padding-bottom:12px;border-bottom:2px solid #f5f5f5">
                            <div class="detail-row" style="align-items:center;gap:12px;">
                                <div style="flex:1">
                                    <div class="detail-label">${this.escapeHtml(sp.subprocess_name || sp.custom_name || 'Subprocess')}</div>
                                    <div class="detail-value">Sequence: ${sp.sequence_order || ''}</div>
                                </div>
                                <div style="display:flex;align-items:center;gap:12px">
                                    <button class="btn btn-primary" onclick="lotDetailPage.showEditSubprocessModal(${sp.process_subprocess_id})">+ Add Variant</button>
                                    <div style="text-align:right">
                                        <div style="font-size:13px;color:#666">Labour subtotal (scaled):</div>
                                        <div style="font-weight:600;font-size:18px">${Number(scaledSubtotal || 0).toFixed(2)}</div>
                                    </div>
                                </div>
                            </div>
                    <div style="overflow:auto;margin-top:8px" class="variant-matrix" data-lot-quantity="${lotQty}">
                        <table class="matrix-table" style="width:100%">
                            <thead>
                                <tr>
                                            <th rowspan="2">Item Details</th>
                                            ${colorHeaders}
                                </tr>
                                <tr>
                                    ${colorSubHeaders}
                                </tr>
                            </thead>
                            <tbody>
                                ${rowsHtml}
                            </tbody>
                        </table>
                    </div>
                    ${costItems.length ? `
                      <hr/>
                      <div style="margin-top:8px"><strong>Cost Items (per process unit)</strong></div>
                      <ul style="margin:6px 0 0 12px;padding:0;list-style:disc">
                        ${costItems.map(ci => `<li>${this.escapeHtml(ci.name || 'Labour')} — qty: ${ci.quantity || 0}, rate: ${Number(ci.amount || ci.rate || 0).toFixed(2)}, line: ${(Number(ci.quantity || 0) * Number(ci.amount || ci.rate || 0)).toFixed(2)}</li>`).join('')}
                      </ul>
                    ` : ''}
                </div>
            `;
            }).join('');

            container.innerHTML = html;

            try {
                const headerSelect = document.getElementById('subprocess-select-for-add');
                if (headerSelect) {
                    headerSelect.innerHTML = '<option value="">-- Select subprocess --</option>';
                    subs.forEach(s => { const opt = document.createElement('option'); opt.value = s.process_subprocess_id || s.sequence_order || ''; opt.textContent = s.subprocess_name || s.custom_name || (`Subprocess ${opt.value}`); headerSelect.appendChild(opt); });
                }
            } catch (e) { console.warn('renderSubprocesses: failed to populate header subprocess select', e); }
        },

        showEditSubprocessModal(processSubprocessId) {
            const payload = this._variantOptions || {};
            const sp = (payload.subprocesses || []).find(s => s.process_subprocess_id === processSubprocessId || s.sequence_order === processSubprocessId);
            if (!sp) { alert('Subprocess options not available'); return; }
            const modal = document.getElementById('edit-subprocess-modal-overlay');
            const body = document.getElementById('edit-subprocess-body'); body.innerHTML = '';
            try {
                const searchWrapper = document.createElement('div'); searchWrapper.style.marginBottom = '12px'; const searchBtn = document.createElement('button'); searchBtn.type = 'button'; searchBtn.className = 'btn'; searchBtn.textContent = '🔎 Search / Add from Catalog'; searchBtn.addEventListener('click', (e) => { e.preventDefault(); try { this.openVariantSearchForSubprocess(processSubprocessId); } catch (err) { console.warn('openVariantSearchForSubprocess failed', err); } }); searchWrapper.appendChild(searchBtn); body.appendChild(searchWrapper);
            } catch (e) { console.warn('Failed to add search button', e); }

            (sp.or_groups || []).forEach(g => { const gid = g.group_id || g.id; const wrapper = document.createElement('div'); wrapper.style.marginBottom = '10px'; const label = document.createElement('label'); label.textContent = `OR Group: ${g.group_name || g.name || gid}`; wrapper.appendChild(label); const sel = document.createElement('select'); sel.dataset.orGroupId = gid; sel.style.marginTop = '6px'; sel.style.width = '100%'; sel.innerHTML = '<option value="">-- None --</option>'; const groupVariants = (sp.grouped_variants && sp.grouped_variants[gid]) || []; groupVariants.forEach(v => { const opt = document.createElement('option'); const id = v.usage_id || v.id || v.item_id || v.variant_id; const itemName = v.item_number || v.variant_name || v.description || String(id); const model = v.model_name || v.model || ''; const variation = v.variation_name || v.variation || ''; const size = v.size_name || v.size || ''; const color = v.color_name || v.color || ''; const labelParts = [itemName, model, variation, size].filter(Boolean); opt.value = id; opt.textContent = labelParts.join(' - ') + (color ? ` (${color})` : ''); sel.appendChild(opt); }); wrapper.appendChild(sel); body.appendChild(wrapper); });

            if ((sp.standalone_variants || []).length > 0) {
                const h = document.createElement('div'); h.style.marginTop = '8px'; h.innerHTML = '<strong>Standalone Variants</strong>'; body.appendChild(h);
                (sp.standalone_variants || []).forEach(v => { const row = document.createElement('div'); row.style.display = 'flex'; row.style.gap = '8px'; row.style.alignItems = 'center'; row.style.marginTop = '6px'; const cb = document.createElement('input'); cb.type = 'checkbox'; cb.dataset.usageId = v.usage_id || v.id || v.item_id || v.variant_id; const itemName = v.item_number || v.variant_name || v.description || String(cb.dataset.usageId); const model = v.model_name || v.model || ''; const variation = v.variation_name || v.variation || ''; const size = v.size_name || v.size || ''; const color = v.color_name || v.color || ''; const labelParts = [itemName, model, variation, size].filter(Boolean); const lbl = document.createElement('div'); lbl.style.flex = '1'; lbl.innerHTML = `<div class="detail-label">${this.escapeHtml(labelParts.join(' - ') + (color ? ` (${color})` : ''))}</div>\n                                 <div class="detail-value">Qty: ${v.quantity || '-'}</div>`; const qty = document.createElement('input'); qty.type = 'number'; qty.min = '0'; qty.step = '0.01'; qty.value = v.quantity || 1; qty.style.width = '80px'; row.appendChild(cb); row.appendChild(lbl); row.appendChild(qty); body.appendChild(row); });
            }

            const saveBtn = document.getElementById('edit-subprocess-save');
            saveBtn.onclick = async () => {
                const selections = [];
                Array.from(body.querySelectorAll('select[data-or-group-id]')).forEach(sel => { const gid = sel.dataset.orGroupId; const usageId = sel.value ? Number(sel.value) : null; if (usageId) selections.push({ or_group_id: Number(gid), variant_usage_id: usageId }); });
                Array.from(body.querySelectorAll('input[type="checkbox"][data-usage-id]')).forEach((cb, idx) => { if (cb.checked) { const usage = Number(cb.dataset.usageId); const qtyInput = body.querySelectorAll('input[type="number"]')[idx]; const q = qtyInput ? Number(qtyInput.value) : null; selections.push({ or_group_id: null, variant_usage_id: usage, quantity_override: q }); } });

                if (selections.length === 0) { if (!confirm('No selections chosen — this will clear selections for this subprocess. Proceed?')) return; }

                try {
                    const resp = await fetch(`/api/upf/production-lots/${this.lotId}/batch_select_variants`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selections }) });
                    if (!resp.ok) { const err = await resp.json().catch(() => ({})); throw new Error(err.message || 'Save failed'); }
                    this.hideEditSubprocessModal(); await this.loadLotDetails(); await this.fetchVariantOptions(); this.renderSubprocesses(); alert('Selections saved');
                } catch (e) { console.error('Failed to save selections:', e); alert('Failed to save selections: ' + e.message); }
            };

            modal.style.display = 'flex';
        },

        hideEditSubprocessModal() { document.getElementById('edit-subprocess-modal-overlay').style.display = 'none'; },

        async loadAlerts() {
            try {
                const response = await fetch(`/api/upf/inventory-alerts/lot/${this.lotId}`, { credentials: 'include' });
                if (!response.ok) throw new Error('Failed to load alerts');
                const data = await response.json(); this.alertsData = data.data || data; this.renderAlerts(); this.updateCriticalBanner(); this.updateFinalizeButton();
            } catch (error) { console.error('Error loading alerts:', error); document.getElementById('alerts-content').innerHTML = '<div class="empty-state">No alerts available</div>'; }
        },

        renderLotDetails() {
            const lot = this.lotData || {};
            document.getElementById('page-title').textContent = `🏭 Production Lot: ${lot.lot_number || 'N/A'}`;
            const statusClass = (lot.status || 'planning').toLowerCase().replace(/\s+/g, '-');
            document.getElementById('lot-status-badge').innerHTML = `<span class="status-badge status-${statusClass}">${lot.status || 'Planning'}</span>`;
            document.getElementById('lot-details-content').innerHTML = detailsHtml;
        }

        renderSummary() {
            const lot = this.lotData || {};
            const rawCost = (lot && (lot.total_cost ?? lot.worst_case_estimated_cost)) || 0;
            const costNum = Number(rawCost); const costDisplay = isFinite(costNum) ? costNum.toFixed(2) : '0.00';
            const summaryHtml = `
            <div class="detail-row">
                <span class="detail-label">Total Cost</span>
                <span class="detail-value">$${costDisplay}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Total Alerts</span>
                <span class="detail-value" id="total-alerts-count">-</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Acknowledged</span>
                <span class="detail-value" id="acknowledged-count">-</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Pending</span>
                <span class="detail-value" id="pending-count">-</span>
            </div>
        `;
            const summaryEl = document.getElementById('summary-content'); if (summaryEl) summaryEl.innerHTML = summaryHtml;
        }

        renderAlerts() {
            const alerts = this.alertsData?.alert_details || [];
            const totalAlerts = alerts.length; const badgeEl = document.getElementById('alerts-count-badge'); if (badgeEl) badgeEl.innerHTML = totalAlerts > 0 ? `<span class="status-badge">${totalAlerts} Total</span>` : '';
            const acknowledgedCount = alerts.filter(a => a.user_acknowledged).length; const pendingCount = totalAlerts - acknowledgedCount;
            const totalEl = document.getElementById('total-alerts-count'); const ackEl = document.getElementById('acknowledged-count'); const pendingEl = document.getElementById('pending-count'); if (totalEl) totalEl.textContent = String(totalAlerts); if (ackEl) ackEl.textContent = String(acknowledgedCount); if (pendingEl) pendingEl.textContent = String(pendingCount);
            if (alerts.length === 0) { document.getElementById('alerts-content').innerHTML = '<div class="empty-state">✅ No inventory alerts for this lot</div>'; return; }
            document.getElementById('alerts-content').style.display = 'none'; document.getElementById('alerts-table-container').style.display = 'block';
            const tbody = document.getElementById('alerts-table-body'); tbody.innerHTML = alerts.map(alert => {
                const severityClass = (alert.alert_severity || '').toString().toLowerCase(); const statusText = alert.user_acknowledged ? 'Acknowledged' : 'Pending'; const statusClass = alert.user_acknowledged ? 'acknowledged' : 'pending';
                return `
                <tr data-alert-id="${alert.alert_id}">
                    <td>
                        <input type="checkbox" class="alert-checkbox" ${alert.user_acknowledged ? 'disabled' : ''} data-alert-id="${alert.alert_id}">
                    </td>
                    <td>
                        <span class="alert-severity alert-severity-${severityClass}">${alert.alert_severity}</span>
                    </td>
                    <td>${this.escapeHtml(alert.variant_name || 'N/A')}</td>
                    <td>${alert.current_stock_quantity || 0}</td>
                    <td>${alert.required_quantity || 0}</td>
                    <td class="shortfall-qty">${alert.shortfall_quantity || 0}</td>
                    <td>${alert.suggested_procurement_quantity || 0}</td>
                    <td>
                        <span class="status-badge status-${statusClass}">${statusText}</span>
                    </td>
                    <td class="alert-actions-inline">
                        ${!alert.user_acknowledged ? `
                            <select class="alert-user-action" data-alert-id="${alert.alert_id}">
                                <option value="">Select action...</option>
                                <option value="PROCEED">Proceed</option>
                                <option value="USE_SUBSTITUTE">Use Substitute</option>
                                <option value="DELAY">Delay Production</option>
                                <option value="PROCURE">Procure Now</option>
                            </select>
                            <textarea class="alert-action-notes" data-alert-id="${alert.alert_id}" placeholder="Action notes..."></textarea>
                        ` : `
                            <div class="acknowledged-info">
                                Action: ${alert.user_action || 'N/A'}<br>
                                ${alert.action_notes ? `Notes: ${this.escapeHtml(alert.action_notes)}` : ''}
                            </div>
                        `}
                    </td>
                </tr>
            `;
            }).join('');
        }
        
            document.getElementById('lot-details-content').innerHTML = detailsHtml;
        },

        renderSummary() {
            const lot = this.lotData || {};
            const rawCost = (lot && (lot.total_cost ?? lot.worst_case_estimated_cost)) || 0;
            const costNum = Number(rawCost); const costDisplay = isFinite(costNum) ? costNum.toFixed(2) : '0.00';
            const summaryHtml = `\n+            <div class="detail-row">\n+                <span class="detail-label">Total Cost</span>\n+                <span class="detail-value">$${costDisplay}</span>\n+            </div>\n+            <div class="detail-row">\n+                <span class="detail-label">Total Alerts</span>\n+                <span class="detail-value" id="total-alerts-count">-</span>\n+            </div>\n+            <div class="detail-row">\n+                <span class="detail-label">Acknowledged</span>\n+                <span class="detail-value" id="acknowledged-count">-</span>\n+            </div>\n+            <div class="detail-row">\n+                <span class="detail-label">Pending</span>\n+                <span class="detail-value" id="pending-count">-</span>\n+            </div>\n+        `;
            const summaryEl = document.getElementById('summary-content'); if (summaryEl) summaryEl.innerHTML = summaryHtml;
        },

        renderAlerts() {
            const alerts = this.alertsData?.alert_details || [];
            const totalAlerts = alerts.length; const badgeEl = document.getElementById('alerts-count-badge'); if (badgeEl) badgeEl.innerHTML = totalAlerts > 0 ? `<span class="status-badge">${totalAlerts} Total</span>` : '';
            const acknowledgedCount = alerts.filter(a => a.user_acknowledged).length; const pendingCount = totalAlerts - acknowledgedCount;
            const totalEl = document.getElementById('total-alerts-count'); const ackEl = document.getElementById('acknowledged-count'); const pendingEl = document.getElementById('pending-count'); if (totalEl) totalEl.textContent = String(totalAlerts); if (ackEl) ackEl.textContent = String(acknowledgedCount); if (pendingEl) pendingEl.textContent = String(pendingCount);
            if (alerts.length === 0) { document.getElementById('alerts-content').innerHTML = '<div class="empty-state">✅ No inventory alerts for this lot</div>'; return; }
            document.getElementById('alerts-content').style.display = 'none'; document.getElementById('alerts-table-container').style.display = 'block';
            const tbody = document.getElementById('alerts-table-body'); tbody.innerHTML = alerts.map(alert => {
                const severityClass = (alert.alert_severity || '').toString().toLowerCase(); const statusText = alert.user_acknowledged ? 'Acknowledged' : 'Pending'; const statusClass = alert.user_acknowledged ? 'acknowledged' : 'pending';
                return `\n+                <tr data-alert-id="${alert.alert_id}">\n+                    <td>\n+                        <input type="checkbox" class="alert-checkbox" ${alert.user_acknowledged ? 'disabled' : ''} data-alert-id="${alert.alert_id}">\n+                    </td>\n+                    <td>\n+                        <span class="alert-severity alert-severity-${severityClass}">${alert.alert_severity}</span>\n+                    </td>\n+                    <td>${this.escapeHtml(alert.variant_name || 'N/A')}</td>\n+                    <td>${alert.current_stock_quantity || 0}</td>\n+                    <td>${alert.required_quantity || 0}</td>\n+                    <td class="shortfall-qty">${alert.shortfall_quantity || 0}</td>\n+                    <td>${alert.suggested_procurement_quantity || 0}</td>\n+                    <td>\n+                        <span class="status-badge status-${statusClass}">${statusText}</span>\n+                    </td>\n+                    <td class="alert-actions-inline">\n+                        ${!alert.user_acknowledged ? `\n+                            <select class="alert-user-action" data-alert-id="${alert.alert_id}">\n+                                <option value="">Select action...</option>\n+                                <option value="PROCEED">Proceed</option>\n+                                <option value="USE_SUBSTITUTE">Use Substitute</option>\n+                                <option value="DELAY">Delay Production</option>\n+                                <option value="PROCURE">Procure Now</option>\n+                            </select>\n+                            <textarea class="alert-action-notes" data-alert-id="${alert.alert_id}" placeholder="Action notes..."></textarea>\n+                        ` : `\n+                            <div class="acknowledged-info">\n+                                Action: ${alert.user_action || 'N/A'}<br>\n+                                ${alert.action_notes ? `Notes: ${this.escapeHtml(alert.action_notes)}` : ''}\n+                            </div>\n+                        `}\n+                    </td>\n+                </tr>\n+            `;
            }).join('');
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

    window.lotDetailPage = lotDetailPage;

    document.addEventListener('DOMContentLoaded', function() {
        lotDetailPage.init();
        try {
            if (window.__UPF_DEBUG__) {
                const headerAdd = document.getElementById('header-add-variant-btn');
                if (headerAdd) {
                    headerAdd.addEventListener('click', function(e) {
                        try {
                            const cs = window.getComputedStyle(headerAdd);
                            console.debug('DEBUG: header-add-variant-btn clicked', { disabled: headerAdd.disabled, display: cs.display, visibility: cs.visibility, pointerEvents: cs.pointerEvents, zIndex: cs.zIndex });
                            const prev = headerAdd.style.outline; headerAdd.style.outline = '3px solid lime'; setTimeout(() => { headerAdd.style.outline = prev; }, 900);
                        } catch (inner) { console.warn('DEBUG handler error', inner); }
                    }, true);
                }
            }
        } catch (e) { console.warn('Failed to attach debug handler to header add button', e); }

        try { window.addEventListener('error', function(evt) { try { const msg = String(evt.message || ''); if (msg.includes('Extension context invalidated') || msg.includes('message port closed') || msg.includes('The message port closed')) { console.warn('External extension error (non-fatal):', msg); } } catch (e) {} }, true); } catch (e) {}
    });

    // Move modal overlays into document.body early and defensively manage pointer-events.
    function _moveOverlaysToBodyAndDefensiveHide() {
        try {
            const moveOne = (ov) => {
                if (!ov) return;
                try {
                    if (ov.parentElement !== document.body) document.body.appendChild(ov);
                    ov.style.position = ov.style.position || 'fixed';
                    ov.style.top = ov.style.top || '0';
                    ov.style.left = ov.style.left || '0';
                    ov.style.right = ov.style.right || '0';
                    ov.style.bottom = ov.style.bottom || '0';
                    // defensive: ensure backdrop doesn't capture pointer events unless visible intentionally
                    if (!ov.dataset.keepOpen) {
                        ov.style.pointerEvents = 'none';
                        const modal = ov.querySelector && ov.querySelector('.modal');
                        if (modal) modal.style.pointerEvents = 'auto';
                    }
                } catch (e) { /* swallow per-run errors */ }
            };

            document.querySelectorAll && document.querySelectorAll('.modal-overlay').forEach(moveOne);

            // Observe later DOM additions and move overlays
            try {
                const observer = new MutationObserver(function(mutations) {
                    mutations.forEach(function(m) {
                        (m.addedNodes || []).forEach(function(n) {
                            if (n && n.nodeType === 1) {
                                if (n.classList && n.classList.contains('modal-overlay')) moveOne(n);
                                n.querySelectorAll && n.querySelectorAll('.modal-overlay').forEach(moveOne);
                            }
                        });
                    });
                });
                observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
            } catch (e) { /* if MutationObserver unavailable, no-op */ }
        } catch (e) { console.warn('overlay management failed', e); }
    }

    // Debug controls for overlays — only applied when the server exposes debug flag
    function _attachDebugOverlayToggle() {
        try {
            if (!window.__UPF_DEBUG__) return;
            const btn = document.getElementById('debug-toggle-overlays');
            if (!btn) return;
            let hidden = false;
            const setStatus = (msg) => { try { const s = document.getElementById('debug-tools-status'); if (s) s.textContent = msg; } catch (e) {} };
            btn.addEventListener('click', function() {
                const overlays = Array.from(document.querySelectorAll('.modal-overlay'));
                hidden = !hidden;
                overlays.forEach(function(ov) {
                    try {
                        if (hidden) {
                            ov.dataset._prevDisplay = ov.style.display || '';
                            ov.style.display = 'none';
                            ov.style.pointerEvents = 'none';
                        } else {
                            ov.style.display = ov.dataset._prevDisplay || '';
                            ov.style.pointerEvents = 'none';
                            const modal = ov.querySelector && ov.querySelector('.modal');
                            if (modal) modal.style.pointerEvents = 'auto';
                            delete ov.dataset._prevDisplay;
                        }
                    } catch (e) {}
                });
                btn.textContent = hidden ? 'Show overlays (debug)' : 'Hide overlays (debug)';
                setStatus(hidden ? `${overlays.length} overlays hidden` : 'overlays restored');
                setTimeout(() => setStatus(''), 2000);
            }, true);
        } catch (e) { console.warn('Failed to attach debug overlay toggle', e); }
    }

    // Run overlay move early (if DOM already ready run now, else on DOMContentLoaded)
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() { _moveOverlaysToBodyAndDefensiveHide(); _attachDebugOverlayToggle(); });
    } else {
        _moveOverlaysToBodyAndDefensiveHide(); _attachDebugOverlayToggle();
    }

    // Expose some helper functions for other scripts
    window.productionLotDetailHelpers = { loadVariantOptionsForSubprocess, recalculateLotCosts, updateTotalCostDisplay };

})();
