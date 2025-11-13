// variantLedger.js - fetch and render variant ledger rows for rate comparison
(function(){
  'use strict';
  const el = {
    variantSelect: null,
    supplierFilter: null,
    startDate: null,
    endDate: null,
    searchBtn: null,
    clearBtn: null,
    tbody: null,
    pager: null,
    count: null
  };

  function init() {
    el.variantSelect = $('#variant-select');
    el.supplierFilter = $('#supplier-filter');
    el.startDate = document.getElementById('start-date');
    el.endDate = document.getElementById('end-date');
    el.searchBtn = document.getElementById('variant-search-btn');
    el.clearBtn = document.getElementById('variant-clear-btn');
    el.tbody = document.getElementById('variant-ledger-body');
    el.pager = document.getElementById('variant-ledger-pager');
    el.count = document.getElementById('variant-ledger-count');

    // select2 for variant (remote)
    el.variantSelect.select2({
      ajax: {
        url: `${App.config.apiBase}/variants/select2`,
        dataType: 'json',
        delay: 250,
        data: function(params){
          return { q: params.term, page: params.page || 1 };
        },
        processResults: function(data, params){
          return { results: data.results, pagination: data.pagination };
        },
      },
      placeholder: 'Search for variant by name',
      minimumInputLength: 1,
      width: 'resolve'
    });

    // supplier filter: load all suppliers (small list) or use API
    App.fetchJson(`${App.config.apiBase}/suppliers`).then(suppliers => {
      const sel = document.getElementById('supplier-filter');
      sel.innerHTML = '<option value="">All Suppliers</option>' + suppliers.map(s => `<option value="${s.supplier_id}">${App.escapeHtml(s.firm_name)}</option>`).join('');
    }).catch(()=>{});

    el.searchBtn.addEventListener('click', doSearch);
    el.clearBtn.addEventListener('click', clearFilters);

    // support enter key on variant select input
    document.getElementById('variant-select').addEventListener('keypress', function(e){ if(e.key === 'Enter'){ doSearch(); } });
  }

  async function doSearch(page=1){
    const variantId = el.variantSelect.val();
    if (!variantId) {
      App.showToast && App.showToast('Please select a variant to search', 'error');
      return;
    }
    const supplierId = el.supplierFilter.value;
    const start = el.startDate.value;
    const end = el.endDate.value;

    const params = new URLSearchParams();
    params.append('variant_id', variantId);
    if (supplierId) params.append('supplier_id', supplierId);
    if (start) params.append('start_date', start);
    if (end) params.append('end_date', end);
    params.append('page', page);
    params.append('per_page', 50);

    try{
      const url = `${App.config.apiBase}/variant-ledger?${params.toString()}`;
      const data = await App.fetchJson(url);
      renderRows(data.items || []);
      renderPager(data.page || 1, data.per_page || 50, data.total || 0);
    }catch(err){
      console.error('variant-ledger fetch failed', err);
      App.showToast && App.showToast('Failed to fetch ledger data', 'error');
    }
  }

  function renderRows(rows){
    if(!el.tbody) return;
    if(!rows || rows.length === 0){
      el.tbody.innerHTML = '<tr><td colspan="8" class="text-center p-8">No entries found.</td></tr>';
      el.count.textContent = '';
      return;
    }
    el.tbody.innerHTML = rows.map(r => {
      const date = App.escapeHtml(r.entry_date || '');
      const supplier = App.escapeHtml(r.supplier_name || '');
      const bill = App.escapeHtml(r.bill_number || r.receipt_number || '');
      const variant = App.escapeHtml((r.item_name || '') + (r.variant_id ? ` (v:${r.variant_id})` : ''));
      const qty = App.escapeHtml(r.qty ?? r.quantity_added ?? '');
      const cost = App.escapeHtml(r.cost_per_unit ?? r.cost ?? '');
      const supplierRate = App.escapeHtml(r.supplier_current_rate ?? '');
      const viewBtn = r.receipt_id
        ? `<button class="button ledger-open-btn" data-href="/purchase-orders?receipt=${r.receipt_id}" data-receipt-id="${r.receipt_id}">View</button>`
        : '';
      return `\n        <tr>\n          <td>${date}</td>\n          <td>${supplier}</td>\n          <td>${bill}</td>\n          <td>${variant}</td>\n          <td>${qty}</td>\n          <td>${cost}</td>\n          <td>${supplierRate}</td>\n          <td>${viewBtn}</td>\n        </tr>`;
    }).join('');
  }

  function renderPager(page, perPage, total){
    el.count.textContent = `Showing page ${page} — ${total} total`;
    // simple prev/next pager
    const totalPages = Math.ceil(total / perPage) || 1;
    const prevDisabled = page <= 1 ? 'disabled' : '';
    const nextDisabled = page >= totalPages ? 'disabled' : '';
    el.pager.innerHTML = `
      <button class="button" ${prevDisabled} id="pager-prev">Prev</button>
      <span style="margin:0 8px">Page ${page} of ${totalPages}</span>
      <button class="button" ${nextDisabled} id="pager-next">Next</button>
    `;
    document.getElementById('pager-prev')?.addEventListener('click', ()=>{ if(page>1) doSearch(page-1); });
    document.getElementById('pager-next')?.addEventListener('click', ()=>{ if(page<totalPages) doSearch(page+1); });
  }

  function clearFilters(){
    el.variantSelect.val(null).trigger('change');
    el.supplierFilter.value = '';
    el.startDate.value = '';
    el.endDate.value = '';
    el.tbody.innerHTML = '';
    el.count.textContent = '';
    el.pager.innerHTML = '';
  }

  document.addEventListener('DOMContentLoaded', init);
})();
