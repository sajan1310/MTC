'use strict';
// core.js -- App shell, ported from Apps_Script/Script_Core.html's shared
// pieces (Api/escapeHtml/formatCurrency live in api.js, loaded first).
// Classic scripts share one top-level scope, so `App` is declared here and
// each future module's own <module>.js just extends it (`App.PO = {...}`,
// etc.) -- same load-order contract source used (Script_Core MUST load
// before any Script_<Module>.html).
//
// App.State is a minimal scaffold this round -- source's own App.State
// holds a large per-module cache (globalPOs, globalItems, selection
// arrays, pagination state, ...) that only exists because those modules
// exist. Each later round adds its own fields here as that module lands,
// rather than pre-declaring fields for modules that aren't built yet.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const _scriptLoadPromises = {};
function loadScript(src) {
  if (!_scriptLoadPromises[src]) {
    _scriptLoadPromises[src] = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = () => resolve();
      script.onerror = () => {
        delete _scriptLoadPromises[src];
        reject(new Error(`Failed to load script: ${src}`));
      };
      document.head.appendChild(script);
    });
  }
  return _scriptLoadPromises[src];
}

function safeModalShow(id) {
  const el = document.getElementById(id);
  if (!el || typeof bootstrap === 'undefined') return;
  const isNested = Array.from(document.querySelectorAll('.modal.show')).some(m => m !== el);
  if (isNested) {
    const existing = bootstrap.Modal.getInstance(el);
    if (existing) existing.dispose();
    el.style.zIndex = 1070;
    new bootstrap.Modal(el, { backdrop: false, keyboard: true }).show();
  } else {
    el.style.zIndex = '';
    bootstrap.Modal.getOrCreateInstance(el).show();
  }
}

function safeModalHide(id) {
  const el = document.getElementById(id);
  if (el && typeof bootstrap !== 'undefined') {
    bootstrap.Modal.getOrCreateInstance(el).hide();
  }
}

function setDisabled(id, state) {
  const el = document.getElementById(id);
  if (el) el.disabled = !!state;
}

// Bootstrap 5 doesn't support real nested modals -- re-sync the body
// scroll-lock to reality every time any modal finishes hiding, instead of
// trusting Bootstrap's per-instance bookkeeping (which strips the lock as
// soon as ANY modal closes, even if another is still open underneath it).
document.addEventListener('hidden.bs.modal', () => {
  const stillOpen = document.querySelectorAll('.modal.show').length;
  if (stillOpen === 0) {
    document.body.classList.remove('modal-open');
    document.body.style.removeProperty('overflow');
    document.body.style.removeProperty('padding-right');
    document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
  } else {
    document.body.classList.add('modal-open');
  }
});

const App = {
  companyLogo: null,

  // Print-only accent color (Script_Core.html) -- needed by the PO/Vendor/
  // Item print-page builders, all currently unreachable dead code until
  // App.Print exists, but kept here since they reference it unconditionally.
  BRAND_COLOR: '#C0392B',

  // Forward-declared empty arrays for globals other not-yet-ported modules
  // will own (globalPOs/globalBills/globalReturns/globalIssues/globalItems)
  // -- Vendor's ledger/pending-orders calculation reads these defensively
  // (`App.State.globalPOs || []`, matching source's own guard style for
  // globalReturns/globalIssues), so declaring them now means each of those
  // modules' own future round just overwrites the array with real data and
  // the ledger starts working with zero further changes here. Same
  // guard-now-activate-later shape the backend port used throughout.
  State: {
    confirmCallback: null,
    globalPOs: [],
    globalBills: [],
    globalReturns: [],
    globalIssues: [],
    globalItems: [],
    globalProduction: [],
    globalStockAdjustments: [],
    globalStock: [],
    filteredStock: [],

    // PO Ledger's own pagination/filter/selection state (Script_PO.html).
    filteredPOs: [],
    poCurrentPage: 1,
    poRowsPerPage: 15,
    poSearchTerm: '',
    poDateFilter: '',
    poStatusFilter: 'all',
    poSortBy: 'poNumberDesc',
    selectedPOs: [],
    allPendingPOs: [],
    filteredPendingPOs: [],
    rowSeq: 0,

    // Bill Ledger's own pagination/filter/selection state (Script_Bill.html).
    filteredBills: [],
    billCurrentPage: 1,
    billRowsPerPage: 15,
    billSearchTerm: '',
    billDateFilter: '',
    billSortBy: 'dateDesc',
    selectedBills: [],
    billAutoMatchTimer: null,
    billAutoMatchPromise: null,

    // Return Ledger's own pagination/filter/selection state (Script_Return.html).
    filteredReturns: [],
    returnCurrentPage: 1,
    returnRowsPerPage: 15,
    returnSearchTerm: '',
    returnDateFilter: '',
    selectedReturns: [],

    // Wastage Log's own pagination/filter/selection state -- nested inside
    // the Return Ledger tab/view (Script_Return.html's App.Wastage).
    globalWastage: [],
    filteredWastage: [],
    wastageCurrentPage: 1,
    wastageRowsPerPage: 15,
    wastageSearchTerm: '',
    wastageDateFilter: '',
    selectedWastage: [],

    // Items Stock sub-tab's own pagination/filter/selection state
    // (Script_Stock.html's App.Stock). globalStock/filteredStock were
    // already forward-declared in Round 1.
    stockCurrentPage: 1,
    stockRowsPerPage: 20,
    stockSearchTerm: '',
    stockDeadSortMode: 'default',
    selectedStock: [],

    // Small header-shortcut masters (Unit/Color/Model/Process Type),
    // deferred since Round 1 -- ported this round alongside Stock since
    // Script_Stock.html bundles them together and Item Master's Base/
    // Purchase Unit fields need unitList populated.
    globalUnits: [],
    globalColors: [],
    globalModels: [],
    globalProcessTypes: [],

    // Process Master's own state (Script_Process.html's App.Process).
    globalProcesses: [],
    filteredProcesses: [],
    selectedProcesses: [],
    collapsedProcessGroups: new Set(),
    processGroupOrder: ['size', 'type', 'model'],
    // Forward-declared in Round 8 so Process's contractor-rate mini-table
    // select2 degraded gracefully before Contractors existed -- now
    // populated for real by App.Contractor.loadData()/ensureLoaded().
    globalContractors: [],
    currentProcessContractorRates: { processName: '', rates: [] },

    // Product BOM's own state (Script_Items.html's App.BOM).
    globalBOMs: [],
    filteredBOMs: [],
    selectedBOMs: [],
    bomCurrentPage: 1,
    bomRowsPerPage: 10,

    // Contractors & Rate Card's own state (Script_Contractors.html's
    // App.Contractor).
    filteredContractors: [],
    globalContractorLedger: [],
    selectedContractors: [],
    currentContractorRates: { contractorName: '', rates: [] },
    currentAccountLedgerContractor: '',
    currentAccountLedgerData: null,

    // Production Lot's own list/report state (Script_Production.html's
    // App.Production) -- globalProduction was already forward-declared
    // in Round 1. productionAllSearchTerm backs the "All Activity"
    // sub-tab's search box. currentProductionSheet remembers which lot
    // + color columns are in play while the Production Sheet modal is
    // open (Save/Reset/Add-row/Add-color actions all read it).
    filteredProduction: [],
    selectedProduction: [],
    productionCurrentPage: 1,
    productionRowsPerPage: 15,
    productionSortBy: 'dateDesc',
    productionAllSearchTerm: '',
    currentProductionSheet: null
  },

  // ── Bulk Selection Helpers ────────────────────────────────────────────
  // Generic helpers shared by every tab's "Delete Selected" / "Print
  // Selected" checkbox columns. Selection state is a plain array of
  // string keys (vendor names, PO numbers, row indexes, etc.).
  Selection: {
    toggle(arr, key, isSelected) {
      const idx = arr.indexOf(key);
      if (isSelected) {
        if (idx === -1) arr.push(key);
      } else if (idx !== -1) {
        arr.splice(idx, 1);
      }
    },

    isSelected(arr, key) {
      return arr.indexOf(key) !== -1;
    },

    toggleAll(arr, chkClass, masterChk) {
      const isChecked = masterChk.checked;
      $$('.' + chkClass).forEach(chk => {
        chk.checked = isChecked;
        this.toggle(arr, chk.dataset.key, isChecked);
      });
    },

    syncFromRows(arr, chkClass, selectAllId) {
      const checkboxes = $$('.' + chkClass);
      checkboxes.forEach(chk => this.toggle(arr, chk.dataset.key, chk.checked));
      const selectAllChk = document.getElementById(selectAllId);
      if (selectAllChk) {
        selectAllChk.checked = checkboxes.length > 0 && checkboxes.every(chk => chk.checked);
      }
    },

    updateButton(btnId, count, label) {
      const btn = document.getElementById(btnId);
      if (!btn) return;
      if (count > 0) {
        btn.classList.remove('d-none');
        btn.innerHTML = `${label} (${count})`;
      } else {
        btn.classList.add('d-none');
      }
    }
  },

  // ── Shared UX primitives ─────────────────────────────────────────────
  Utils: {
    showToast(message, isError = false) {
      const toastEl = document.getElementById('systemToast');
      const msgEl = document.getElementById('toastMessage');
      if (msgEl) msgEl.innerText = message || '';
      if (!toastEl) {
        console[isError ? 'error' : 'log'](message);
        return;
      }

      toastEl.classList.remove('bg-success', 'bg-danger');
      toastEl.classList.add(isError ? 'bg-danger' : 'bg-success');

      if (typeof bootstrap !== 'undefined') {
        bootstrap.Toast.getOrCreateInstance(toastEl).show();
      }
    },

    confirmAction(message, callback) {
      const msgText = document.getElementById('confirmMessageText');
      if (msgText) {
        msgText.style.whiteSpace = 'pre-line';
        msgText.innerText = message;
      }
      App.State.confirmCallback = callback;

      const el = document.getElementById('confirmModal');
      if (!el || typeof bootstrap === 'undefined') return;

      const existing = bootstrap.Modal.getInstance(el);
      if (existing) existing.dispose();

      const isNested = Array.from(document.querySelectorAll('.modal.show')).some(m => m !== el);
      new bootstrap.Modal(el, { backdrop: isNested ? false : true, keyboard: !isNested }).show();
    },

    // Placeholder for a module not yet ported this round -- keeps a Quick
    // Action / nav click from throwing instead of silently doing nothing.
    notPortedYet(feature) {
      this.showToast(`${feature || 'This feature'} isn't wired up yet.`, true);
    },

    setFieldValues(fields) {
      Object.entries(fields).forEach(([id, val]) => {
        const el = document.getElementById(id);
        if (el) el.value = val;
      });
    },

    // Removes the closest <tr> a button lives in, unless it's the last
    // remaining row in that <tbody> (a vendor-rows/component-rows table
    // must always keep at least one row to add into).
    removeRow(buttonEl) {
      const row = buttonEl?.closest('tr');
      const tbody = buttonEl?.closest('tbody');
      if (row && tbody && $$('tr', tbody).length > 1) {
        row.remove();
      }
    },

    // Fills #formContact from Vendor Master (preferred) or, failing that,
    // the most recent PO that used this vendor -- so a vendor picked by
    // free-text (Select2 tags:true) before Vendor Master even lists them
    // still gets a contact prefilled if any past PO recorded one.
    updateVendorContact(vendorName) {
      const contactEl = document.getElementById('formContact');
      if (!contactEl) return;
      const vendor = (App.State.globalVendors || []).find(
        v => App.Utils.sameText(v.name, vendorName) && v.contact
      );
      if (vendor) {
        contactEl.value = vendor.contact;
        return;
      }
      const match = App.State.globalPOs.find(
        po => App.Utils.sameText(po.vendor, vendorName) && po.contact
      );
      contactEl.value = match?.contact || '';
    },

    // Sizes that actually exist for a given item name in Item Master, so
    // PO/Bill size pickers can be filtered to valid sizes for the item just
    // entered. Returns [] if the name doesn't match any known item.
    getSizesForItemName(name) {
      const nameLower = String(name || '').trim().toLowerCase();
      if (!nameLower) return [];
      const sizes = new Set();
      (App.State.globalItems || []).forEach(item => {
        if (String(item.name || '').trim().toLowerCase() === nameLower && item.size) {
          sizes.add(item.size);
        }
      });
      return [...sizes];
    },

    // Filters a row's per-row size <datalist> to the sizes valid for the
    // entered item name, falling back to the full size list for unrecognized
    // item names (so registering a brand-new item via PO/Bill still works).
    // Auto-fills the size input when only one valid size exists.
    applyDependentSizeList(nameInput, sizeListSelector) {
      const row = nameInput.closest('tr');
      if (!row) return;
      const sizeInput = row.querySelector(sizeListSelector);
      const datalist = row.querySelector('datalist.row-size-list');
      if (!sizeInput || !datalist) return;

      const name = nameInput.value.trim();
      let sizes = App.Utils.getSizesForItemName(name);
      if (!sizes.length) {
        sizes = [...new Set((App.State.globalItems || []).map(i => i.size).filter(Boolean))];
      }

      datalist.innerHTML = sizes.map(s => `<option value="${escapeHtml(s)}">`).join('');
      if (sizes.length === 1 && !sizeInput.value.trim()) sizeInput.value = sizes[0];
    },

    // Defaults a PO/Bill row's Unit field to the matched item's Purchase
    // Unit (e.g. 'Gross') so the market-quoted unit is pre-selected instead
    // of the generic 'Pcs' placeholder every row starts with. Only
    // overwrites when the field still holds that generic default -- never
    // clobbers a unit the user already picked deliberately.
    applyDefaultPurchaseUnit(triggerEl, nameSelector, sizeSelector, unitSelector) {
      const row = triggerEl.closest('tr');
      if (!row) return;
      const unitInput = row.querySelector(unitSelector);
      const nameInput = row.querySelector(nameSelector);
      if (!unitInput || !nameInput) return;

      const name = nameInput.value.trim();
      const sizeInput = row.querySelector(sizeSelector);
      const size = sizeInput ? sizeInput.value.trim() : '';
      if (!name) return;

      const item = (App.State.globalItems || []).find(i =>
        String(i.name || '').trim().toLowerCase() === name.toLowerCase() &&
        String(i.size || '').trim().toLowerCase() === size.toLowerCase()
      );
      if (!item) return;

      const purchaseUnit = item.purchaseUnit || item.baseUnit || 'Pcs';
      const current = unitInput.value.trim();
      if (!current || current === 'Pcs') {
        unitInput.value = purchaseUnit;
      }
    },

    // Aggregates outstanding (ordered - billed) quantity per item (name+size)
    // across all open POs, so Item Master / Item Ledger / search can all
    // share one source of truth. Returns a Map keyed by "name|size"
    // (lowercased) -> { qty, poNumbers: Set }. Safe before PO/Bill are
    // ported -- App.State.globalPOs starts as an empty array, so the loop
    // body (including the App.Bill._getBilledQty call PO/Bill's own round
    // will make real) never runs.
    getPendingByItem() {
      const map = new Map();
      (App.State.globalPOs || []).forEach(po => {
        (po.items || []).forEach(line => {
          const name = String(line.name || '').trim();
          if (!name) return;
          const size = String(line.size || '').trim();
          const ordered = Number(line.baseQty) || 0;
          if (ordered <= 0) return;

          const billed = App.Bill._getBilledQty(po.poNumber, name, size, line.narration);
          const pending = ordered - billed;
          if (pending <= 0.0001) return;

          const key = `${name.toLowerCase()}|${size.toLowerCase()}`;
          const entry = map.get(key) || { qty: 0, poNumbers: new Set() };
          entry.qty += pending;
          entry.poNumbers.add(String(po.poNumber));
          map.set(key, entry);
        });
      });
      return map;
    },

    // Case/whitespace-insensitive equality for name-like fields (vendor,
    // item, contractor, ... names) -- "SEAT"/"seat"/"Seat" are the same
    // real-world thing. Use instead of === wherever two user-typed/stored
    // strings are compared this way (not for programmatic IDs/enums).
    sameText(a, b) {
      return String(a == null ? '' : a).trim().toLowerCase() === String(b == null ? '' : b).trim().toLowerCase();
    },

    // Keyword search: every whitespace-split keyword must appear somewhere
    // in the haystack, regardless of order.
    matchesKeywords(haystack, term) {
      const keywords = String(term || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
      if (!keywords.length) return true;
      const text = String(haystack || '').toLowerCase();
      return keywords.every(kw => text.includes(kw));
    },

    // Select2 matcher using keyword search -- pass as `matcher:` in any
    // Select2 config to replace the default substring match with
    // multi-word keyword matching.
    select2Matcher(params, data) {
      if (!params.term) return data;
      return App.Utils.matchesKeywords(data.text, params.term) ? data : null;
    },

    // Fixed bicycle-size categories a Process's Output Item Name may embed
    // (e.g. "Painted Frame Ford 14 inch D/Gaddi"). Output Item Name is the
    // only place size is recorded on a Process, so it's matched as a
    // substring rather than read from a dedicated column.
    PROCESS_SIZE_LIST: ['12 inch', '14 inch', '16 inch', '20 inch', '24 inch', '26 inch'],

    // Returns the size token found in text (e.g. a Process's Output Item
    // Name), or 'General' if none of PROCESS_SIZE_LIST appears in it.
    getSizeFromOutputItemName(text) {
      const lower = String(text || '').toLowerCase();
      return this.PROCESS_SIZE_LIST.find(s => lower.includes(s)) || 'General';
    },

    // Returns the Model Master name found in text (e.g. a Process's Output
    // Item Name), or 'General' if none of the current models appears in
    // it. Models are read live from App.State.globalModels (not a fixed
    // list like PROCESS_SIZE_LIST) since new models can be added in Model
    // Master at any time. Longest name first, so a multi-word model (e.g.
    // "Eagle Pro") wins over a shorter one that's also a substring of it
    // (e.g. "Eagle").
    getModelFromOutputItemName(text) {
      const lower = String(text || '').toLowerCase();
      const models = [...(App.State.globalModels || [])].sort((a, b) => String(b.name || '').length - String(a.name || '').length);
      const match = models.find(m => m.name && lower.includes(String(m.name).toLowerCase()));
      return match ? match.name : 'General';
    },

    // Auto-selects a <select>'s only remaining real option (any option
    // besides a blank-value placeholder) once filtering/cascading has
    // narrowed it down to exactly one choice. Never overrides a value the
    // select already holds, and intentionally does NOT dispatch a
    // 'change' event -- callers that need to cascade into a dependent
    // dropdown read select.value right after calling this and pass it
    // along themselves. Returns true if it changed the value.
    autoSelectOnlyOption(selectEl) {
      if (!selectEl || selectEl.value) return false;
      const realOptions = Array.from(selectEl.options).filter(o => o.value !== '');
      if (realOptions.length !== 1) return false;
      selectEl.value = realOptions[0].value;
      if (window.jQuery?.fn?.select2 && window.jQuery(selectEl).data('select2'))
        window.jQuery(selectEl).trigger('change.select2');
      return true;
    },

    // Clamps a requested page number to a valid range for the given item count.
    clampPage(page, totalItems, rowsPerPage) {
      const totalPages = Math.max(1, Math.ceil(totalItems / rowsPerPage));
      return Math.max(1, Math.min(totalPages, toNumber(page, 1)));
    },

    // Renders a "Showing X-Y of Z" label + Bootstrap pagination control.
    // actionName is the data-action value the delegated click handler
    // (bindGlobalEvents, below) dispatches on click.
    renderPagination(containerId, totalItems, currentPage, rowsPerPage, actionName, label = 'Records') {
      const container = document.getElementById(containerId);
      if (!container) return;

      if (!totalItems) {
        container.innerHTML = '';
        return;
      }

      const totalPages = Math.ceil(totalItems / rowsPerPage);
      const startItem = (currentPage - 1) * rowsPerPage + 1;
      const endItem = Math.min(currentPage * rowsPerPage, totalItems);

      let html = `<span class="text-secondary fw-bold">Showing ${startItem}–${endItem} of ${totalItems} ${label}</span>`;

      if (totalPages > 1) {
        html += `<ul class="pagination pagination-sm mb-0 shadow-sm">
          <li class="page-item ${currentPage === 1 ? 'disabled' : ''}">
            <button class="page-link text-dark" data-action="${actionName}" data-page="${currentPage - 1}">Prev</button>
          </li>`;

        let ellipsisLeft = false;
        let ellipsisRight = false;

        for (let i = 1; i <= totalPages; i++) {
          if (i === 1 || i === totalPages || (i >= currentPage - 1 && i <= currentPage + 1)) {
            const active = currentPage === i;
            html += `<li class="page-item ${active ? 'active' : ''}">
              <button class="page-link ${active ? 'bg-info border-info text-dark' : 'text-dark'}"
                      data-action="${actionName}" data-page="${i}">${i}</button>
            </li>`;
          } else if (currentPage > i && !ellipsisLeft) {
            html += '<li class="page-item disabled"><span class="page-link text-muted">…</span></li>';
            ellipsisLeft = true;
          } else if (i > currentPage && !ellipsisRight && totalPages > i) {
            html += '<li class="page-item disabled"><span class="page-link text-muted">…</span></li>';
            ellipsisRight = true;
          }
        }

        html += `<li class="page-item ${currentPage === totalPages ? 'disabled' : ''}">
          <button class="page-link text-dark" data-action="${actionName}" data-page="${currentPage + 1}">Next</button>
        </li></ul>`;
      }

      container.innerHTML = html;
    }
  },

  // ── Navigation ────────────────────────────────────────────────────────
  Navigation: {
    showTab(id) {
      $$('.tab-content').forEach(tab => {
        tab.style.display = tab.id === id ? 'block' : 'none';
      });

      $$('#mainTabs .nav-link').forEach(btn => btn.classList.remove('active'));
      document.getElementById(`btn-${id}`)?.classList.add('active');

      if (typeof App.Dashboard !== 'undefined') App.Dashboard.stopAutoRefresh();
      if (id === 'dashboardTab' && typeof App.Dashboard !== 'undefined') {
        App.Dashboard.loadData();
        App.Dashboard.startAutoRefresh();
      }
      if (id === 'vendorMaster' && typeof App.Vendor !== 'undefined') App.Vendor.loadData();
      if (id === 'itemMaster' && typeof App.Item !== 'undefined') App.Item.loadData();
      if (id === 'poLedger' && typeof App.PO !== 'undefined') App.PO.loadData();
      if (id === 'billLedger' && typeof App.Bill !== 'undefined') App.Bill.loadData();
      if (id === 'returnLedger' && typeof App.Return !== 'undefined') App.Return.loadData();
      if (id === 'stockTab' && typeof App.Stock !== 'undefined') App.Stock.loadData();
      if (id === 'productsTab' && typeof App.Products !== 'undefined') App.Products.enterTab();
      if (id === 'contractorsTab' && typeof App.Contractor !== 'undefined') App.Contractor.loadData();
      if (id === 'productionTab' && typeof App.Production !== 'undefined') App.Production.loadData();
      // Every other module's own `if (id === '<tab>') App.<Module>.loadData();`
      // line lands here in that module's own round -- same guarded pattern
      // Navigation.showTab already used in source for not-yet-loaded modules.
    }
  },

  async Init() {
    const labels = [];
    const promises = [];

    if (this.Dashboard) {
      labels.push('Dashboard');
      promises.push(this.Dashboard.loadData());
      this.Dashboard.startAutoRefresh();
    }

    if (this.Vendor) {
      labels.push('Vendor');
      promises.push(this.Vendor.loadData());
    }

    if (this.Item) {
      labels.push('Item');
      promises.push(this.Item.loadData());
    }

    if (this.PO) {
      labels.push('PO');
      promises.push(this.PO.loadData());
    }

    if (this.Bill) {
      labels.push('Bill');
      promises.push(this.Bill.loadData());
    }

    if (this.Return) {
      labels.push('Return');
      promises.push(this.Return.loadData());
    }

    // Unit Master loads eagerly (matches source) since Item Master's
    // Base/Purchase Unit fields need unitList populated whenever that
    // modal opens, which can happen before the user ever visits Stock.
    // Color/Model/ProcessType stay lazy (ensureLoaded() from their own
    // openModal()) -- nothing needs them before their own modal opens.
    if (this.Unit) {
      labels.push('Unit');
      promises.push(this.Unit.ensureLoaded());
    }

    const results = await Promise.allSettled(promises);
    const failedLabels = [];
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        failedLabels.push(labels[i]);
        console.error(`[Init] ${labels[i]} data load failed:`, r.reason);
      }
    });
    if (failedLabels.length > 0) {
      this.Utils.showToast(`Failed to load: ${failedLabels.join(', ')}. Check your connection and retry.`, true);
    }
  }
};

window.App = App;

function bindGlobalEvents() {
  document.getElementById('confirmActionBtn')?.addEventListener('click', () => {
    safeModalHide('confirmModal');
    const cb = App.State.confirmCallback;
    App.State.confirmCallback = null;
    if (typeof cb === 'function') cb();
  });

  const confirmModalEl = document.getElementById('confirmModal');
  if (confirmModalEl) {
    confirmModalEl.addEventListener('hidden.bs.modal', () => {
      App.State.confirmCallback = null;
    });
  }

  // Sidebar nav clicks (data-action="show-tab") + any other future
  // data-action delegate land here, mirroring source's single delegated
  // click handler instead of one listener per button.
  document.body.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    switch (btn.dataset.action) {
      case 'show-tab':
        App.Navigation.showTab(btn.dataset.tab);
        break;
      case 'not-ported-yet':
        App.Utils.notPortedYet(btn.dataset.feature);
        break;
      case 'vendor-page':
        App.Vendor.changePage(toNumber(btn.dataset.page, 1));
        break;
      case 'remove-row':
        App.Utils.removeRow(btn);
        break;
      case 'item-page':
        App.Item.changePage(toNumber(btn.dataset.page, 1));
        break;
      case 'item-ledger':
        App.Item.openLedgerModal(decodeURIComponent(btn.dataset.name || ''), decodeURIComponent(btn.dataset.size || ''));
        break;
      case 'item-edit':
        App.Item.openEditModal(decodeURIComponent(btn.dataset.name || ''), decodeURIComponent(btn.dataset.size || ''));
        break;
      case 'item-delete':
        App.Item.delete(decodeURIComponent(btn.dataset.name || ''), decodeURIComponent(btn.dataset.size || ''));
        break;
      case 'po-print':
        App.PO.print(toNumber(btn.dataset.index));
        break;
      case 'po-edit':
        App.PO.openEditModal(toNumber(btn.dataset.index));
        break;
      case 'po-pdf':
        App.PO.downloadPDF(toNumber(btn.dataset.index));
        break;
      case 'po-delete':
        App.PO.delete(decodeURIComponent(btn.dataset.ponumber || ''));
        break;
      case 'po-page':
        App.PO.changePage(toNumber(btn.dataset.page, 1));
        break;
      case 'bill-print':
        App.Bill.print(toNumber(btn.dataset.index));
        break;
      case 'bill-edit':
        App.Bill.openEditModal(toNumber(btn.dataset.index));
        break;
      case 'bill-delete':
        App.Bill.delete(decodeURIComponent(btn.dataset.vendor || ''), decodeURIComponent(btn.dataset.billnumber || ''));
        break;
      case 'bill-page':
        App.Bill.changePage(toNumber(btn.dataset.page, 1));
        break;
      case 'return-print':
        App.Return.print(toNumber(btn.dataset.index));
        break;
      case 'return-edit':
        App.Return.openEditModal(toNumber(btn.dataset.index));
        break;
      case 'return-delete':
        App.Return.delete(decodeURIComponent(btn.dataset.returnnumber || ''));
        break;
      case 'return-page':
        App.Return.changePage(toNumber(btn.dataset.page, 1));
        break;
      case 'wastage-page':
        App.Wastage.changePage(toNumber(btn.dataset.page, 1));
        break;
      case 'stock-page':
        App.Stock.changePage(toNumber(btn.dataset.page, 1));
        break;
      case 'production-page':
        App.Production.changePage(toNumber(btn.dataset.page, 1));
        break;
    }
  });
}

// ── Page chrome: dark mode + sidebar collapse ───────────────────────────
// Ported from Index.html's own inline bootstrap script -- page-local, not
// part of App, same as source (this logic lives in Index.html itself,
// never in Script_Core.html).
document.addEventListener('DOMContentLoaded', async () => {
  const container = document.getElementById('app-container');
  if (container) container.classList.add('loaded');

  const safeGetItem = (key) => {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  };
  const safeSetItem = (key, val) => {
    try { localStorage.setItem(key, val); } catch (e) { /* storage inaccessible */ }
  };

  const THEME_KEY = 'maharaja-erp-theme';
  const html = document.documentElement;
  const toggleBtn = document.getElementById('dark-mode-toggle');
  const moonIcon = document.getElementById('dm-icon-moon');
  const sunIcon = document.getElementById('dm-icon-sun');

  function isDark() {
    return html.getAttribute('data-theme') === 'dark';
  }
  function syncToggleIcon() {
    if (!toggleBtn) return;
    if (isDark()) {
      moonIcon.style.display = 'none';
      sunIcon.style.display = '';
      toggleBtn.title = 'Switch to Light Mode';
    } else {
      moonIcon.style.display = '';
      sunIcon.style.display = 'none';
      toggleBtn.title = 'Switch to Dark Mode';
    }
  }
  if (toggleBtn) {
    syncToggleIcon();
    toggleBtn.addEventListener('click', () => {
      document.body.classList.add('theme-transitioning');
      if (isDark()) {
        html.removeAttribute('data-theme');
        safeSetItem(THEME_KEY, 'light');
      } else {
        html.setAttribute('data-theme', 'dark');
        safeSetItem(THEME_KEY, 'dark');
      }
      syncToggleIcon();
      setTimeout(() => document.body.classList.remove('theme-transitioning'), 350);
    });
  }

  const SIDEBAR_KEY = 'maharaja-erp-sidebar-collapsed';
  const sidebar = document.getElementById('app-sidebar');
  const sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');
  const sidebarBackdrop = document.getElementById('sidebar-backdrop');
  const MOBILE_BREAKPOINT = 768;
  const isMobile = () => window.innerWidth <= MOBILE_BREAKPOINT;

  function openMobileSidebar() {
    sidebar.classList.add('mobile-open');
    sidebarBackdrop.classList.add('show');
    sidebarToggleBtn.setAttribute('aria-expanded', 'true');
  }
  function closeMobileSidebar() {
    sidebar.classList.remove('mobile-open');
    sidebarBackdrop.classList.remove('show');
    sidebarToggleBtn.setAttribute('aria-expanded', 'false');
  }

  if (sidebar && sidebarToggleBtn) {
    if (!isMobile() && safeGetItem(SIDEBAR_KEY) === 'true') {
      sidebar.classList.add('collapsed');
      sidebarToggleBtn.setAttribute('aria-expanded', 'false');
    }
    sidebarToggleBtn.addEventListener('click', () => {
      if (isMobile()) {
        sidebar.classList.contains('mobile-open') ? closeMobileSidebar() : openMobileSidebar();
      } else {
        const collapsed = sidebar.classList.toggle('collapsed');
        sidebarToggleBtn.setAttribute('aria-expanded', String(!collapsed));
        safeSetItem(SIDEBAR_KEY, String(collapsed));
      }
    });
    sidebarBackdrop?.addEventListener('click', closeMobileSidebar);
    sidebar.addEventListener('click', (e) => {
      if (isMobile() && e.target.closest('[data-action="show-tab"]')) closeMobileSidebar();
    });
  }

  bindGlobalEvents();
  await App.Init();
});
