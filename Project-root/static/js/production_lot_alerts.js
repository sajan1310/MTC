// Production Lot Alert Handler with Bulk Acknowledgment Support
window.ProductionLotAlertHandler = (function () {
  const state = {
    production_lot_id: null,
    alerts_list: [],
    pending_acknowledgments: {},
  };

  const api = async (url, opts = {}) => {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    const data = await res.json();
    if (!res.ok || data.success === false) {
      throw new Error(data.message || data.error?.message || res.statusText);
    }
    return data.data || data;
  };

  // Compatibility helper: prefer first existing id from list
  function getEl(...ids) {
    for (let i = 0; i < ids.length; i++) {
      const el = document.getElementById(ids[i]);
      if (el) return el;
    }
    return null;
  }

  function init(productionLotId) {
    state.production_lot_id = productionLotId;
    // Attach bulk acknowledge button listener if present
    const bulkBtn = getEl('bulk-acknowledge-btn', 'bulk-acknowledge');
    if (bulkBtn) {
      bulkBtn.addEventListener('click', handleBulkAcknowledge);
    }
  }

  function displayAlerts(alerts) {
    state.alerts_list = alerts || [];
    // Prefer table body if present (new layout), otherwise fall back to legacy list
    const container = getEl('alerts-table-body', 'alerts-list');
    if (!container) return;
    // Clear existing content
    container.innerHTML = '';

    if (state.alerts_list.length === 0) {
      if (container.tagName === 'TBODY') {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 7;
        td.style.textAlign = 'center';
        td.style.color = '#999';
        td.textContent = 'No alerts found';
        tr.appendChild(td);
        container.appendChild(tr);
      } else {
        container.innerHTML = '<p style="text-align: center; color: #999;">No alerts found</p>';
      }
      return;
    }

    state.alerts_list.forEach((a) => {
      const isAcknowledged = a.user_acknowledged;
      if (container.tagName === 'TBODY') {
        // Render as table row (compact)
        const tr = document.createElement('tr');
        tr.dataset.alertId = a.alert_id;

        // Checkbox cell
        const tdCheckbox = document.createElement('td');
        if (isAcknowledged) {
          const chk = document.createElement('input');
          chk.type = 'checkbox';
          chk.disabled = true;
          chk.checked = true;
          tdCheckbox.appendChild(chk);
        } else {
          const chk = document.createElement('input');
          chk.type = 'checkbox';
          chk.className = 'alert-checkbox';
          chk.dataset.alertId = a.alert_id;
          tdCheckbox.appendChild(chk);
        }
        tr.appendChild(tdCheckbox);

        // Severity
        const tdSeverity = document.createElement('td');
        tdSeverity.textContent = a.alert_severity || 'OK';
        tr.appendChild(tdSeverity);

        // Variant
        const tdVariant = document.createElement('td');
        tdVariant.textContent = a.variant_name || a.item_variant_id || '';
        tr.appendChild(tdVariant);

        // Current stock
        const tdStock = document.createElement('td');
        tdStock.textContent = a.current_stock_quantity || a.current_stock || 0;
        tr.appendChild(tdStock);

        // Required
        const tdReq = document.createElement('td');
        tdReq.textContent = a.required_quantity || 0;
        tr.appendChild(tdReq);

        // Shortfall
        const tdShort = document.createElement('td');
        tdShort.textContent = a.shortfall_quantity || a.shortfall || 0;
        tr.appendChild(tdShort);

        // Actions
        const tdActions = document.createElement('td');
        if (!isAcknowledged) {
          const select = document.createElement('select');
          select.className = 'action-select';
          select.dataset.alertId = a.alert_id;
          ['','PROCEED','USE_SUBSTITUTE','DELAY','PROCURE'].forEach((v)=>{
            const opt = document.createElement('option');
            opt.value = v;
            opt.textContent = v === '' ? 'Select action...' : v;
            select.appendChild(opt);
          });
          const txt = document.createElement('textarea');
          txt.className = 'alert-notes';
          txt.dataset.alertId = a.alert_id;
          txt.rows = 1;
          txt.placeholder = 'Action notes (optional)...';
          tdActions.appendChild(select);
          tdActions.appendChild(txt);
        } else {
          tdActions.textContent = 'Acknowledged';
        }
        tr.appendChild(tdActions);

        container.appendChild(tr);
      } else {
        // Legacy card layout
        const div = document.createElement('div');
        div.className = `alert-item alert-severity-${a.alert_severity || 'OK'}`;
        div.dataset.alertId = a.alert_id;

        const checkboxHtml = isAcknowledged
          ? '<input type="checkbox" disabled checked title="Already acknowledged">'
          : '<input type="checkbox" class="alert-checkbox" data-alert-id="' + a.alert_id + '">';

        div.innerHTML = `
          <div class="alert-header">
            ${checkboxHtml}
            <span class="severity-badge ${a.alert_severity}">${a.alert_severity}</span>
            <span class="variant-name">${a.variant_name || a.item_variant_id || 'Variant #' + a.variant_id}</span>
          </div>
          <div class="alert-body">
            <div class="info-row"><span class="label">Current Stock:</span><span class="value">${a.current_stock_quantity || 0}</span></div>
            <div class="info-row"><span class="label">Required:</span><span class="value">${a.required_quantity || 0}</span></div>
            <div class="info-row alert-shortfall"><span class="label">Shortfall:</span><span class="value">${a.shortfall_quantity || 0}</span></div>
            ${!isAcknowledged ? `
              <div class="alert-actions-inline">
                <select class="action-select" data-alert-id="${a.alert_id}">
                  <option value="">Select action...</option>
                  <option value="PROCEED">Proceed (accept shortfall)</option>
                  <option value="USE_SUBSTITUTE">Use substitute variant</option>
                  <option value="DELAY">Delay production</option>
                  <option value="PROCURE">Create procurement order</option>
                </select>
                <textarea class="alert-notes" data-alert-id="${a.alert_id}" placeholder="Action notes (optional)..." rows="2"></textarea>
              </div>
            ` : `<div style="color: #28a745; font-weight: bold; margin-top: 8px;">✓ Acknowledged by ${a.acknowledged_by || 'user'}</div>`}
          </div>`;
        container.appendChild(div);
      }
    });

    // Reveal panel if present
    const panel = getEl('alert-panel', 'alerts-panel');
    if (panel) panel.classList.remove('hidden');
  }

  async function handleBulkAcknowledge() {
    const checkboxes = document.querySelectorAll('.alert-checkbox:checked');
    if (checkboxes.length === 0) {
      alert('Please select at least one alert to acknowledge.');
      return;
    }

    const acknowledgments = [];
    checkboxes.forEach((cb) => {
      const alertId = parseInt(cb.dataset.alertId);
      const actionSelect = document.querySelector(`.action-select[data-alert-id="${alertId}"]`);
      const notesTextarea = document.querySelector(`.alert-notes[data-alert-id="${alertId}"]`);
      
      acknowledgments.push({
        alert_id: alertId,
        user_action: actionSelect?.value || 'PROCEED',
        action_notes: notesTextarea?.value || '',
      });
    });

    try {
      const result = await api(`/api/upf/inventory-alerts/lot/${state.production_lot_id}/acknowledge-bulk`, {
        method: 'POST',
        body: JSON.stringify({ acknowledgments }),
      });
      
      alert(`Successfully acknowledged ${result.acknowledged_count || acknowledgments.length} alert(s). Lot status: ${result.updated_lot_status || 'updated'}`);
      
      // Reload alerts to show updated state
      await loadAlertsForLot(state.production_lot_id);
    } catch (err) {
      console.error('Bulk acknowledge failed:', err);
      alert('Failed to acknowledge alerts: ' + err.message);
    }
  }

  async function loadAlertsForLot(lotId) {
    try {
      const data = await api(`/api/upf/inventory-alerts/lot/${lotId}`);
      displayAlerts(data.alert_details || []);
      
      // Update summary if present
      const summaryEl = document.getElementById('alerts-summary');
      if (summaryEl && data.alerts_summary) {
        summaryEl.innerHTML = Object.entries(data.alerts_summary)
          .filter(([sev, count]) => count > 0)
          .map(([sev, count]) => `<span class="summary-stat ${sev.toLowerCase()}">${sev}: ${count}</span>`)
          .join('');
      }
    } catch (err) {
      console.error('Failed to load alerts:', err);
    }
  }

  function displayProcurementRecommendations(recs) {
    const tbody = document.getElementById('recommendations-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    (recs || []).forEach((r) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${r.variant_name || r.variant_id || ''}</td>
        <td>${r.supplier_name || r.supplier_id || ''}</td>
        <td>${r.recommended_quantity || ''}</td>
        <td>${r.required_delivery_date || ''}</td>
        <td>${r.estimated_cost || ''}</td>
        <td><span class="status-badge ${r.procurement_status}">${r.procurement_status}</span></td>
        <td><button class="btn-secondary" onclick="ProductionLotAlertHandler.viewRecommendation(${r.recommendation_id})">View</button></td>`;
      tbody.appendChild(tr);
    });
    const panel = document.getElementById('procurement-panel');
    if (panel) panel.classList.remove('hidden');
  }

  function viewRecommendation(recId) {
    // Placeholder for viewing recommendation details
    console.log('View recommendation:', recId);
  }

  return {
    init,
    displayAlerts,
    displayProcurementRecommendations,
    loadAlertsForLot,
    handleBulkAcknowledge,
    viewRecommendation,
  };
})();
