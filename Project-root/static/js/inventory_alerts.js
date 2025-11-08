(function(){
  const $ = (sel, ctx=document) => ctx.querySelector(sel);
  const $$ = (sel, ctx=document) => Array.from(ctx.querySelectorAll(sel));
  const api = async (path, opts={}) => {
    const res = await fetch(`/api${path}`, Object.assign({
      headers: { 'Content-Type': 'application/json' }
    }, opts));
    const data = await res.json().catch(()=>({}));
    if (!res.ok || data.success === false) throw new Error(data.message || res.statusText);
    return data.data ?? data;
  };

  async function loadRules(){
    const tbody = $('#rules-table tbody');
    tbody.innerHTML = '<tr><td colspan="6">Loading…</td></tr>';
    try{
      const rules = await api('/inventory-alert-rules');
      tbody.innerHTML = '';
      for(const r of rules){
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${r.variant_id}</td>
          <td>${r.safety_stock_quantity}</td>
          <td>${r.reorder_point_quantity}</td>
          <td>${r.alert_threshold_percentage}</td>
          <td>${r.is_active ? 'Yes':'No'}</td>
          <td>
            <button data-deactivate="${r.alert_rule_id}">Deactivate</button>
          </td>`;
        tbody.appendChild(tr);
      }
    }catch(e){ tbody.innerHTML = `<tr><td colspan="6">Error: ${e.message}</td></tr>`; }
  }

  async function loadAlerts(){
    const tbody = $('#alerts-table tbody');
    tbody.innerHTML = '<tr><td colspan="7">Loading…</td></tr>';
    try{
      const alerts = await api('/inventory-alerts');
      tbody.innerHTML = '';
      for(const a of alerts){
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${a.alert_id}</td>
          <td>${a.production_lot_id}</td>
          <td>${a.variant_id}</td>
          <td>${a.alert_severity}</td>
          <td>${a.shortfall_quantity}</td>
          <td>${a.user_acknowledged ? 'Yes':'No'}</td>
          <td>
            <button data-ack="${a.alert_id}">Acknowledge</button>
          </td>`;
        tbody.appendChild(tr);
      }
    }catch(e){ tbody.innerHTML = `<tr><td colspan="7">Error: ${e.message}</td></tr>`; }
  }

  async function loadRecs(){
    const tbody = $('#recs-table tbody');
    tbody.innerHTML = '<tr><td colspan="8">Loading…</td></tr>';
    try{
      const recs = await api('/procurement-recommendations');
      tbody.innerHTML = '';
      for(const r of recs){
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${r.recommendation_id}</td>
          <td>${r.production_lot_id}</td>
          <td>${r.variant_id}</td>
          <td>${r.supplier_id ?? ''}</td>
          <td>${r.recommended_quantity}</td>
          <td>${r.procurement_status}</td>
          <td>${r.updated_at || r.created_at || ''}</td>
          <td>
            <button data-mark-ordered="${r.recommendation_id}">Mark Ordered</button>
          </td>`;
        tbody.appendChild(tr);
      }
    }catch(e){ tbody.innerHTML = `<tr><td colspan="8">Error: ${e.message}</td></tr>`; }
  }

  // Forms
  $('#rule-form').addEventListener('submit', async (e)=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = Object.fromEntries(fd.entries());
    payload.variant_id = Number(payload.variant_id);
    payload.safety_stock_quantity = Number(payload.safety_stock_quantity);
    payload.reorder_point_quantity = Number(payload.reorder_point_quantity);
    payload.alert_threshold_percentage = Number(payload.alert_threshold_percentage);
    try{
      await api('/inventory-alert-rules', { method:'POST', body: JSON.stringify(payload)});
      await loadRules();
      e.target.reset();
    }catch(err){ alert(err.message); }
  });

  $('#alert-form').addEventListener('submit', async (e)=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = Object.fromEntries(fd.entries());
    payload.production_lot_id = Number(payload.production_lot_id);
    payload.variant_id = Number(payload.variant_id);
    payload.required_quantity = Number(payload.required_quantity);
    try{
      await api('/inventory-alerts', { method:'POST', body: JSON.stringify(payload)});
      await loadAlerts();
      e.target.reset();
    }catch(err){ alert(err.message); }
  });

  $('#recs-table').addEventListener('click', async (e)=>{
    const id = e.target?.dataset?.markOrdered;
    if(!id) return;
    try{
      await api(`/procurement-recommendations/${id}/status`, { method: 'PATCH', body: JSON.stringify({ procurement_status: 'ORDERED' })});
      await loadRecs();
    }catch(err){ alert(err.message); }
  });

  $('#rules-table').addEventListener('click', async (e)=>{
    const id = e.target?.dataset?.deactivate;
    if(!id) return;
    try{
      await api(`/inventory-alert-rules/${id}/deactivate`, { method: 'PATCH' });
      await loadRules();
    }catch(err){ alert(err.message); }
  });

  $('#rec-form').addEventListener('submit', async (e)=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = Object.fromEntries(fd.entries());
    payload.production_lot_id = Number(payload.production_lot_id);
    payload.variant_id = Number(payload.variant_id);
    if(payload.supplier_id) payload.supplier_id = Number(payload.supplier_id);
    payload.recommended_quantity = Number(payload.recommended_quantity);
    try{
      await api('/procurement-recommendations', { method:'POST', body: JSON.stringify(payload)});
      await loadRecs();
      e.target.reset();
    }catch(err){ alert(err.message); }
  });

  // Initial loads
  loadRules();
  loadAlerts();
  loadRecs();
})();
