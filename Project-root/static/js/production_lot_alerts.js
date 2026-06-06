// Production Lot Alert Handler with Bulk Acknowledgment Support
window.ProductionLotAlertHandler = (function () {
  const state = {
    production_lot_id: null,
    alerts_list: [],
    pending_acknowledgments: {},
  };

  const api = async (url, opts = {}) => {
    const csrfToken = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content');
    const res = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        ...(csrfToken ? { 'X-CSRFToken': csrfToken } : {}),
      },
      credentials: 'include',
      ...opts,
    });
    const data = await res.json();
    if (!res.ok || data.success === false) {
      throw new Error(data.message || data.error?.message || res.statusText);
    }
    return data.data || data;
  };

  // Normalize alert record from backend to a consistent shape.
  // Backend may use different field names depending on the endpoint used.
  function normalizeAlert(a) {
    return {
      alert_id: a.alert_id,
      // severity: prefer 'severity' (production_lot_detail.js style), fall back to 'alert_severity'
      severity: a.severity || a.alert_severity || 'WARNING',
      alert_severity: a.severity || a.alert_severity || 'WARNING',
      // variant
      variant_name: a.variant_name || a.item_variant_id || '',
      variant_id: a.variant_id || a.item_variant_id,
      // stock fields — normalize to both naming conventions
      current_stock: a.current_stock ?? a.current_stock_quantity ?? 0,
      current_stock_quantity: a.current_stock ?? a.current_stock_quantity ?? 0,
      required_quantity: a.required_quantity ?? 0,
      shortfall: a.shortfall ?? a.shortfall_quantity ?? 0,
      shortfall_quantity: a.shortfall ?? a.shortfall_quantity ?? 0,
      suggested_procurement: a.suggested_procurement,
      // status
      status: a.status || (a.user_acknowledged ? 'ACKNOWLEDGED' : 'PENDING'),
      user_acknowledged: a.user_acknowledged || a.status === 'ACKNOWLEDGED',
      acknowledged_by: a.acknowledged_by,
    };
  }

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
    const bulkBtn = getEl('bulk-acknowledge-btn', 'bulk-acknowledge');
    if (bulkBtn) {
      bulkBtn.addEventListener('click', handleBulkAcknowledge);
    }
  }

  function displayAlerts(alerts) {
    state.alerts_list = (alerts || []).map(normalizeAlert);
    const container = getEl('alerts-table-body', 'alerts-list');
    if (!container) return;
    container.innerHTML = '';

    if (state.alerts_list.length === 0) {
      if (container.tagName === 'TBODY') {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 9;
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
        const tr = document.createElement('tr');
        tr.dataset.alertId = a.alert_id;

        // Checkbox
        const tdCheckbox = document.createElement('td');
        const chk = document.createElement('input');
        chk.type = 'checkbox';
        if (isAcknowledged) {
          chk.disabled = true;
          chk.checked = true;
        } else {
          chk.className = 'alert-checkbox';
          chk.dataset.alertId = a.alert_id;
        }
        tdCheckbox.appendChild(chk);
        tr.appendChild(tdCheckbox);

        // Severity
        const tdSeverity = document.createElement('td');
        tdSeverity.innerHTML = `<span class="status ${a.severity === 'CRITICAL' ? 'status--error' : 'status--warning'}">${a.severity}</span>`;
        tr.appendChild(tdSeverity);

        // Variant
        const tdVariant = document.createElement('td');
        tdVariant.textContent = a.variant_name || '';
        tr.appendChild(tdVariant);

        // Current stock
        const tdStock = document.createElement('td');
        tdStock.textContent = a.current_stock;
        tr.appendChild(tdStock);

        // Required
        const tdReq = document.createElement('td');
        tdReq.textContent = a.required_quantity;
        tr.appendChild(tdReq);

        // Shortfall
        const tdShort = document.createElement('td');
        tdShort.textContent = a.shortfall;
        tr.appendChild(tdShort);

        // Suggested Procurement
        const tdSugg = document.createElement('td');
        tdSugg.textContent = a.suggested_procurement ?? '—';
        tr.appendChild(tdSugg);

        // Status
        const tdStatus = document.createElement('td');
        tdStatus.innerHTML = isAcknowledged
          ? '<span class="status status--success">Acknowledged</span>'
          : '<span class="status status--warning">Pending</span>';
        tr.appendChild(tdStatus);

        // Action
        const tdAction = document.createElement('td');
        if (isAcknowledged) {
          tdAction.innerHTML = '<span class="text-muted">—</span>';
        } else {
          const btn = document.createElement('button');
          btn.className = 'btn btn--secondary btn--sm';
          btn.dataset.action = 'ack-alert';
          btn.dataset.alertId = a.alert_id;
          btn.textContent = 'Acknowledge';
          tdAction.appendChild(btn);
        }
        tr.appendChild(tdAction);

        container.appendChild(tr);
      } else {
        // Legacy card layout
        const div = document.createElement('div');
        div.className = `alert-item alert-severity-${a.severity}`;
        div.dataset.alertId = a.alert_id;

        const checkboxHtml = isAcknowledged
          ? '<input type="checkbox" disabled checked title="Already acknowledged">'
          : `<input type="checkbox" class="alert-checkbox" data-alert-id="${a.alert_id}">`;

        div.innerHTML = `
          <div class="alert-header">
            ${checkboxHtml}
            <span class="severity-badge ${a.severity}">${a.severity}</span>
            <span class="variant-name">${a.variant_name || 'Variant #' + (a.variant_id || '')}</span>
          </div>
          <div class="alert-body">
            <div class="info-row"><span class="label">Current Stock:</span><span class="value">${a.current_stock}</span></div>
            <div class="info-row"><span class="label">Required:</span><span class="value">${a.required_quantity}</span></div>
            <div class="info-row alert-shortfall"><span class="label">Shortfall:</span><span class="value">${a.shortfall}</span></div>
            ${!isAcknowledged ? `
              <div class="alert-actions-inline">
                <button class="btn btn--secondary btn--sm" data-action="ack-alert" data-alert-id="${a.alert_id}">Acknowledge</button>
              </div>
            ` : `<div style="color:#28a745;font-weight:bold;margin-top:8px;">✓ Acknowledged${a.acknowledged_by ? ' by ' + a.acknowledged_by : ''}</div>`}
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

    const alert_ids = Array.from(checkboxes).map((cb) => parseInt(cb.dataset.alertId));

    try {
      // Use the generic bulk-acknowledge endpoint (accepts alert_ids array)
      const result = await api('/api/upf/inventory-alerts/bulk-acknowledge', {
        method: 'POST',
        body: JSON.stringify({ alert_ids }),
      });

      alert(`Successfully acknowledged ${result.acknowledged_count || alert_ids.length} alert(s).`);
      await loadAlertsForLot(state.production_lot_id);
    } catch (err) {
      console.error('Bulk acknowledge failed:', err);
      alert('Failed to acknowledge alerts: ' + err.message);
    }
  }

  async function loadAlertsForLot(lotId) {
    try {
      const data = await api(`/api/upf/inventory-alerts/lot/${lotId}`);
      // Backend returns { lot_id, alert_details: [...], alerts_summary: {...} }
      const alertDetails = data.alert_details || data.alerts || [];
      displayAlerts(alertDetails);

      const summaryEl = document.getElementById('alerts-summary');
      if (summaryEl && data.alerts_summary) {
        summaryEl.innerHTML = Object.entries(data.alerts_summary)
          .filter(([, count]) => count > 0)
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
