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
document.addEventListener('hidden.bs.modal', (e) => {
  const stillOpen = document.querySelectorAll('.modal.show').length;
  if (stillOpen === 0) {
    document.body.classList.remove('modal-open');
    document.body.style.removeProperty('overflow');
    document.body.style.removeProperty('padding-right');
    document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
  } else {
    document.body.classList.add('modal-open');
  }
  // Prev/Next context (App.Nav) is only meaningful while the modal it was
  // opened for is still showing -- drop it as soon as that modal closes so
  // a later unrelated open of the same modal never inherits a stale
  // record list or nav bar.
  if (e.target?.id) App.Nav.clear(e.target.id);
});

// Keyboard shortcut for App.Nav: N/P or the Left/Right arrows step to the
// next/previous record in whichever edit modal currently has focus.
// Deliberately ignores every text-entry control (input/textarea/select,
// incl. Select2's hidden search input) -- "N"/"P" are ordinary letters
// that appear constantly in Narration/Remarks/Item Name fields, and the
// arrows already have a native job there, so firing on those would
// hijack normal typing instead of navigating.
document.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  const delta = (key === 'n' || key === 'arrowright') ? 1
    : (key === 'p' || key === 'arrowleft') ? -1
    : null;
  if (delta === null) return;
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;

  const target = e.target;
  if (target.matches?.('input, textarea, select') || target.isContentEditable) return;

  const modalEl = target.closest?.('.modal.show');
  if (!modalEl || !App.Nav._ctx[modalEl.id]) return;

  e.preventDefault();
  App.Nav.go(modalEl.id, delta);
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

    // Warehouse Pool sub-tab's own state (Script_Stock.html's App.Stock,
    // "Warehouse Pool" section) -- intermediate/finished process outputs
    // (painted frames, fitted rims, packed products...), grouped by
    // Process using the same 3-tier picker as the Processes sub-tab.
    globalWarehousePool: [],
    globalWarehousePoolOpening: [],
    globalWarehousePoolAdjustments: [],
    warehousePoolColorsByProcess: {},
    warehousePoolSearchTerm: '',
    warehousePoolGroupOrder: ['size', 'type', 'model'],
    selectedWarehousePool: [],

    // globalDispatch was forward-declared in Round 17 for the Warehouse
    // Pool Ledger (a plain data cache read via the real getDispatchData
    // RPC, no dependency on this module). Its own pagination/filter/
    // selection/sort state for the Dispatched Goods sub-tab, plus
    // globalReadyToDispatch/filteredReadyToDispatch for the Ready to
    // Dispatch sub-tab, land here now that App.Dispatch itself exists.
    // globalDispatch stays FLAT (one entry per line, header fields
    // repeated) after the header+lines redesign (migration 023) -- client.js
    // and stock.js both already iterate it assuming that shape.
    // globalDispatchBills/filteredDispatchBills are a separate, client-side-
    // grouped view (App.Dispatch.buildDispatchBills) the Dispatch module's
    // own ledger table/modal use instead.
    globalDispatch: [],
    globalDispatchBills: [],
    filteredDispatchBills: [],
    globalReadyToDispatch: [],
    filteredReadyToDispatch: [],
    dispatchCurrentPage: 1,
    dispatchRowsPerPage: 15,
    dispatchSortBy: 'dateDesc',
    selectedDispatch: [],

    // Dispatch Plan (App.DispatchPlan, static/erp/dispatch-plan.js) -- the
    // day-ahead drag-and-drop board's own data. FLAT, one entry per plan
    // line (same "flat cache, grouped client-side" convention as
    // globalDispatch/buildDispatchBills above) -- App.DispatchPlan groups
    // it into per-client cards itself. dispatchPlanDate defaults to
    // tomorrow (see api.js's tomorrowIso) the first time the sub-tab loads.
    globalDispatchPlans: [],
    dispatchPlanDate: '',

    // Set by App.Dispatch.openPrefilledDispatchModal when a plan card is
    // being converted, read once by the dispatchForm submit handler and
    // included as saveDispatch's sourcePlanLineIds so the converted
    // card's lines get marked fulfilled atomically with the bill save.
    dispatchSourcePlanLineIds: [],

    // Clients / PI-Estimates (Script_Clients.html's App.Client) -- its
    // own pagination/filter/selection state for both sub-tabs, plus the
    // Global Pending Orders modal's own list (allPendingOrders --
    // distinct from PO Ledger's unrelated allPendingPOs).
    globalClients: [],
    filteredClients: [],
    clientCurrentPage: 1,
    clientRowsPerPage: 15,
    selectedClients: [],
    globalOrders: [],
    filteredOrders: [],
    orderCurrentPage: 1,
    orderRowsPerPage: 15,
    selectedOrders: [],
    allPendingOrders: [],
    filteredPendingOrders: [],

    // Small header-shortcut masters (Unit/Color/Model/Process Type),
    // deferred since Round 1 -- ported this round alongside Stock since
    // Script_Stock.html bundles them together and Item Master's Base/
    // Purchase Unit fields need unitList populated.
    globalUnits: [],
    globalColors: [],
    globalModels: [],
    globalProcessTypes: [],
    selectedUnits: [],
    selectedColors: [],
    selectedModels: [],
    selectedProcessTypes: [],

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
    selectedContractorRates: [],
    selectedContractorPayments: [],
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
    currentProductionSheet: null,

    // Issued Stock Log (Script_Return.html's App.Issue, despite living
    // in Production's own Issued Stock sub-tab) -- globalIssues was
    // already forward-declared in Round 1.
    filteredIssues: [],
    selectedIssues: [],
    issueCurrentPage: 1,
    issueRowsPerPage: 15,
    issueSearchTerm: '',
    issueDateFilter: '',

    // Users tab (admin-only, users.js's App.Users) -- same flat state
    // shape as every other module here. No pagination: user lists are
    // small enough that the flag isn't worth adding until it isn't.
    globalUsers: [],
    filteredUsers: [],
    usersSearchTerm: '',
    // Custom roles (roles_service.py) -- fetched alongside globalUsers.
    globalCustomRoles: []
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

  // ── Prev/Next record navigation + unsaved-changes guard ──────────────
  // Generic across every edit modal in the app: a module calls
  // App.Nav.register(modalId, ids, currentId, openFn) when it opens an
  // edit modal, and this builds its own Prev/Next bar (inserted at the
  // top of the modal's own submit-button container, no per-modal HTML
  // needed) plus wires N/P and arrow-key shortcuts and an Exit action
  // that warns before discarding unsaved edits. A module with no matching
  // HTML support (no submit button found) is a silent no-op -- this must
  // never be a hard dependency for a modal to open at all.
  Nav: {
    _ctx: {},

    // `extraDirtyFn` (optional) lets a module report unsaved state that
    // _serialize can't see -- e.g. a dynamically-rendered sub-table with
    // no id/name-bearing inputs at snapshot time.
    register(modalId, ids, currentId, openFn, extraDirtyFn) {
      this._ctx[modalId] = { ids: (ids || []).slice(), currentId, openFn, extraDirtyFn };
      this._ensureBar(modalId);
      this._snapshot(modalId);
      this._updateBar(modalId);
    },

    clear(modalId) {
      delete this._ctx[modalId];
      const bar = document.getElementById(modalId)?.querySelector('.app-modal-nav');
      if (bar) bar.style.display = 'none';
    },

    go(modalId, delta) {
      const ctx = this._ctx[modalId];
      if (!ctx) return;
      const idx = this._indexOf(ctx.ids, ctx.currentId);
      const targetIdx = idx + delta;
      if (targetIdx < 0 || targetIdx >= ctx.ids.length) return;
      const targetId = ctx.ids[targetIdx];
      const proceed = () => ctx.openFn(targetId);

      if (this.isDirty(modalId)) {
        App.Utils.confirmAction('You have unsaved changes in this form. Discard them and continue?', proceed);
      } else {
        proceed();
      }
    },

    isDirty(modalId) {
      const ctx = this._ctx[modalId];
      const modalEl = document.getElementById(modalId);
      if (!ctx || !modalEl) return false;
      if (this._serialize(modalEl) !== ctx.snapshot) return true;
      try {
        return !!(ctx.extraDirtyFn && ctx.extraDirtyFn());
      } catch (e) {
        // A broken hook must never wedge Exit/Prev/Next.
        return false;
      }
    },

    // The Exit button (edit-mode-only -- each module's openEditModal swaps
    // Cancel for Exit) closes the modal WITHOUT saving, exactly like
    // Cancel always has, but first warns if the form has unsaved edits.
    // Saving-and-staying-open is the Save button's own job; Exit never
    // touches the server.
    exit(modalId) {
      const modalEl = document.getElementById(modalId);
      const proceed = () => {
        if (modalEl && typeof bootstrap !== 'undefined') {
          bootstrap.Modal.getInstance(modalEl)?.hide();
        }
      };
      if (this.isDirty(modalId)) {
        App.Utils.confirmAction('You have unsaved changes in this form. Discard them and continue?', proceed);
      } else {
        proceed();
      }
    },

    _indexOf(ids, id) {
      const key = JSON.stringify(id);
      return ids.findIndex(x => JSON.stringify(x) === key);
    },

    _serialize(modalEl) {
      const data = {};
      modalEl.querySelectorAll('input, select, textarea').forEach(el => {
        const key = el.id || el.name;
        if (!key) return;
        data[key] = (el.type === 'checkbox' || el.type === 'radio') ? el.checked : el.value;
      });
      return JSON.stringify(data);
    },

    _snapshot(modalId) {
      const ctx = this._ctx[modalId];
      const modalEl = document.getElementById(modalId);
      if (ctx && modalEl) ctx.snapshot = this._serialize(modalEl);
    },

    _ensureBar(modalId) {
      const modalEl = document.getElementById(modalId);
      if (!modalEl) return;

      // Every edit modal in this app puts Cancel/Save inside .modal-body
      // (a "text-end" div), not a real Bootstrap .modal-footer -- anchor
      // off the submit button's own parent instead so this works without
      // depending on a footer element none of them actually have.
      let bar = modalEl.querySelector('.app-modal-nav');
      if (!bar) {
        const submitBtn = modalEl.querySelector('button[type="submit"]');
        const container = modalEl.querySelector('.modal-footer') || submitBtn?.parentElement;
        if (!container) return;

        bar = document.createElement('div');
        bar.className = 'app-modal-nav d-flex align-items-center mb-2';
        bar.innerHTML =
          '<button type="button" class="btn btn-sm btn-outline-secondary app-modal-nav-prev" title="Previous record (P or &larr;)"><i class="bi bi-chevron-left"></i> Prev</button>' +
          '<span class="mx-2 small text-muted app-modal-nav-pos"></span>' +
          '<button type="button" class="btn btn-sm btn-outline-secondary app-modal-nav-next" title="Next record (N or &rarr;)">Next <i class="bi bi-chevron-right"></i></button>';
        container.insertBefore(bar, container.firstChild);
        bar.querySelector('.app-modal-nav-prev').addEventListener('click', () => App.Nav.go(modalId, -1));
        bar.querySelector('.app-modal-nav-next').addEventListener('click', () => App.Nav.go(modalId, 1));
      }
      bar.style.display = '';
    },

    _updateBar(modalId) {
      const ctx = this._ctx[modalId];
      const modalEl = document.getElementById(modalId);
      const bar = modalEl?.querySelector('.app-modal-nav');
      if (!ctx || !bar) return;

      const idx = this._indexOf(ctx.ids, ctx.currentId);
      const pos = bar.querySelector('.app-modal-nav-pos');
      if (pos) pos.textContent = idx >= 0 ? `${idx + 1} of ${ctx.ids.length}` : '';
      bar.querySelector('.app-modal-nav-prev').disabled = idx <= 0;
      bar.querySelector('.app-modal-nav-next').disabled = idx < 0 || idx >= ctx.ids.length - 1;
    }
  },

  // ── Notification History & Panel ─────────────────────────────────────
  // The bell shows a panel of past toast notifications, since the toast
  // itself now auto-dismisses after 3s (see Modals/toast-container's
  // data-bs-delay). Persisted in localStorage so history survives a
  // reload; capped at 50 entries.
  Notify: {
    STORAGE_KEY: 'maharaja-erp-notifications',
    SEEN_LOGS_KEY: 'maharaja-erp-seen-logs',
    items: [],
    unreadCount: 0,
    isOpen: false,
    _listenersBound: false,

    // Click-to-navigate target for a notification whose `link` names one of
    // these keys — {tab, goto(value)}. `goto` resolves the live array index
    // and opens that record's edit modal; a link of {type:'tab', tab:'...'}
    // (no resolver) just switches tabs, used when a notification covers
    // multiple records or the exact one can't be pinpointed server-side.
    NAV: {
      po: {
        tab: 'poLedger',
        async goto(value) {
          await App.PO.loadData();
          const idx = App.State.globalPOs.findIndex(p => String(p.poNumber) === String(value));
          if (idx > -1) App.PO.openEditModal(idx);
        }
      },
      bill: {
        tab: 'billLedger',
        async goto(value) {
          await App.Bill.loadData();
          // Bill identity is (vendor, billNumber) -- see billKey -- since
          // cross-vendor duplicate bill numbers are allowed.
          const [vendor, billNumber] = String(value).split('␟');
          const key = App.Bill.billKey({ vendor, billNumber });
          const idx = App.State.globalBills.findIndex(b => App.Bill.billKey(b) === key);
          if (idx > -1) App.Bill.openEditModal(idx);
        }
      },
      return: {
        tab: 'returnLedger',
        async goto(value) {
          await App.Return.loadData();
          const idx = App.State.globalReturns.findIndex(r => String(r.returnNumber) === String(value));
          if (idx > -1) App.Return.openEditModal(idx);
        }
      },
      item: {
        tab: 'itemMaster',
        async goto(value) {
          await App.Item.loadData();
          const [name, size] = String(value).split('␟');
          if (name) App.Item.openEditModal(name, size || '');
        }
      },
      bom: {
        tab: 'productsTab',
        async goto(value) {
          App.Products.switchSubTab('bomTab');
          await App.BOM.loadData();
          const idx = App.State.globalBOMs.findIndex(b => String(b.productId) === String(value));
          if (idx > -1) App.BOM.openEditModal(idx);
        }
      },
      process: {
        tab: 'productsTab',
        async goto(value) {
          App.Products.switchSubTab('processTab');
          await App.Process.loadData();
          const idx = App.State.globalProcesses.findIndex(p => String(p.processId) === String(value));
          if (idx > -1) App.Process.openEditModal(idx);
        }
      },
      production: {
        tab: 'productionTab',
        async goto(value) {
          await App.Production.loadData();
          const idx = App.State.globalProduction.findIndex(p => String(p.rowIdx) === String(value));
          if (idx > -1) App.Production.openEditModal(idx);
        }
      },
      dispatch: {
        tab: 'dispatchTab',
        // Dispatch became header+lines (migration 023): App.Dispatch.
        // openEditDispatchModal now takes a dispatchNumber directly (a bill,
        // not a single flat row/array index) -- matches the reference's own
        // post-e37529e openEditDispatchModal(value) call exactly, since
        // "value" here is the same dispatchNumber save_dispatch's toast link
        // carries.
        async goto(value) {
          await App.Dispatch.enterTab();
          App.Dispatch.switchSubTab('dispatchedGoodsSubTab');
          App.Dispatch.openEditDispatchModal(String(value));
        }
      },
      client: {
        tab: 'clientsTab',
        async goto(value) {
          await App.Client.enterTab();
          App.Client.switchSubTab('clientsListSubTab');
          App.Client.openEditClientModal(value);
        }
      },
      clientOrder: {
        tab: 'clientsTab',
        async goto(value) {
          await App.Client.enterTab();
          App.Client.switchSubTab('clientOrdersSubTab');
          const idx = App.State.globalOrders.findIndex(o => String(o.orderNumber) === String(value));
          if (idx > -1) App.Client.openEditOrderModal(idx);
        }
      },
      contractor: {
        tab: 'contractorsTab',
        async goto(value) {
          await App.Contractor.loadData();
          App.Contractor.openProfileModal(value);
        }
      },
      vendor: {
        tab: 'vendorMaster',
        async goto(value) {
          await App.Vendor.loadData();
          App.Vendor.openProfileModal(value);
        }
      },
      stock: {
        tab: 'stockTab',
        async goto() { await App.Stock.loadData(); }
      }
    },

    load() {
      try {
        const raw = localStorage.getItem(this.STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed?.items)) {
            this.items = parsed.items.map(item => ({
              ...item,
              timestamp: item.timestamp ? new Date(item.timestamp) : new Date()
            }));
            this.unreadCount = Number(parsed.unreadCount) || 0;
            this.updateBadge();
          }
        }
      } catch (e) {
        console.warn('[Notify] Failed to load persisted notifications:', e);
      }
    },

    save() {
      try {
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify({
          items: this.items.slice(0, 50),
          unreadCount: this.unreadCount
        }));
      } catch (e) {
        console.warn('[Notify] Storage access denied:', e);
      }
    },

    // `options.link` -- {type, value?} per NAV above -- makes the
    // notification clickable-to-navigate. `options.detail` is the full
    // explanation shown in the detail modal when there's no link (e.g. a
    // plain error); when omitted, the detail modal falls back to `message`
    // itself.
    add(message, isError = false, options = {}) {
      if (!message) return;
      const notif = {
        id: Date.now() + '-' + Math.random().toString(36).substring(2, 5),
        message: String(message),
        isError: !!isError,
        timestamp: new Date(),
        unread: true,
        link: options.link || null,
        detail: options.detail || null
      };
      this.items.unshift(notif);
      if (this.items.length > 50) this.items.pop();
      this.unreadCount++;
      this.save();
      this.updateBadge();
      if (this.isOpen) {
        this.render();
      }
      this._renderAllModalIfOpen();
    },

    remove(id, event) {
      if (event && typeof event.stopPropagation === 'function') {
        event.stopPropagation();
      }
      const idx = this.items.findIndex(item => item.id === id);
      if (idx !== -1) {
        if (this.items[idx].unread && this.unreadCount > 0) {
          this.unreadCount--;
        }
        this.items.splice(idx, 1);
        this.save();
        this.updateBadge();
        this.render();
        this._renderAllModalIfOpen();
      }
    },

    // Click handler for a notification row (not its dismiss button).
    // Navigates to the linked record/tab when possible, otherwise shows the
    // full message in the detail modal -- the "error explanation" fallback
    // for notifications with no resolvable destination.
    async openItem(id) {
      const notif = this.items.find(n => n.id === id);
      if (!notif) return;

      if (notif.unread) {
        notif.unread = false;
        this.unreadCount = Math.max(0, this.unreadCount - 1);
        this.save();
        this.updateBadge();
      }
      this.close();
      safeModalHide('notifAllModal');

      const link = notif.link;
      if (link && link.type === 'tab' && link.tab) {
        App.Navigation.showTab(link.tab);
        return;
      }
      const nav = link && this.NAV[link.type];
      if (nav) {
        App.Navigation.showTab(nav.tab);
        try {
          await nav.goto(link.value);
        } catch (e) {
          App.Utils.showToast('Could not open the related record — it may have been deleted or changed since.', true);
        }
        return;
      }
      this.showDetail(id);
    },

    showDetail(id) {
      const notif = this.items.find(n => n.id === id);
      if (!notif) return;
      const titleEl = document.getElementById('notifDetailTitle');
      const bodyEl = document.getElementById('notifDetailBody');
      const timeEl = document.getElementById('notifDetailTime');
      if (titleEl) titleEl.textContent = notif.isError ? 'Error Details' : 'Notification Details';
      if (bodyEl) bodyEl.textContent = notif.detail || notif.message;
      if (timeEl) timeEl.textContent = notif.timestamp instanceof Date && !isNaN(notif.timestamp.getTime())
        ? notif.timestamp.toLocaleString()
        : '';
      safeModalShow('notifDetailModal');
    },

    viewAll() {
      this.close();
      this.renderAllModal();
      safeModalShow('notifAllModal');
    },

    renderAllModal() {
      const listEl = document.getElementById('notif-all-list');
      if (!listEl) return;
      if (this.items.length === 0) {
        listEl.innerHTML = '<div class="notif-empty">No notifications yet.</div>';
        return;
      }
      listEl.innerHTML = this.items.map(item => this._rowHtml(item)).join('');
    },

    _renderAllModalIfOpen() {
      const modalEl = document.getElementById('notifAllModal');
      if (modalEl && modalEl.classList.contains('show')) this.renderAllModal();
    },

    toggle() {
      if (this.isOpen) {
        this.close();
      } else {
        this.open();
      }
    },

    open() {
      const panel = document.getElementById('notif-panel');
      const btn = document.getElementById('notif-bell-btn');
      if (!panel) return;

      this.isOpen = true;
      panel.style.display = 'flex';
      if (btn) btn.setAttribute('aria-expanded', 'true');

      this.unreadCount = 0;
      this.items.forEach(item => { item.unread = false; });
      this.save();
      this.updateBadge();
      this.render();

      this._bindOutsideListeners();
    },

    close() {
      const panel = document.getElementById('notif-panel');
      const btn = document.getElementById('notif-bell-btn');
      if (panel) panel.style.display = 'none';
      if (btn) btn.setAttribute('aria-expanded', 'false');
      this.isOpen = false;

      this._unbindOutsideListeners();
    },

    clear() {
      this.items = [];
      this.unreadCount = 0;
      this.save();
      this.updateBadge();
      this.render();
      this._renderAllModalIfOpen();
    },

    updateBadge() {
      const badge = document.getElementById('notif-badge');
      if (!badge) return;
      if (this.unreadCount > 0) {
        badge.textContent = this.unreadCount > 99 ? '99+' : String(this.unreadCount);
        badge.style.display = 'inline-flex';
      } else {
        badge.style.display = 'none';
      }
    },

    formatTime(date) {
      if (!(date instanceof Date) || isNaN(date.getTime())) return '';
      const diffMs = Date.now() - date.getTime();
      const diffSec = Math.floor(diffMs / 1000);
      if (diffSec < 10) return 'Just now';
      if (diffSec < 60) return `${diffSec}s ago`;
      const diffMin = Math.floor(diffSec / 60);
      if (diffMin < 60) return `${diffMin}m ago`;
      const diffHours = Math.floor(diffMin / 60);
      if (diffHours < 24) return `${diffHours}h ago`;
      const diffDays = Math.floor(diffHours / 24);
      if (diffDays < 7) return `${diffDays}d ago`;
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    },

    render() {
      const listEl = document.getElementById('notif-list');
      const clearBtn = document.getElementById('notif-clear-btn');
      if (clearBtn) {
        clearBtn.disabled = this.items.length === 0;
      }
      if (!listEl) return;

      if (this.items.length === 0) {
        listEl.innerHTML = '<div class="notif-empty">No notifications yet.</div>';
        return;
      }

      // The dropdown panel is a quick-glance list -- only the most recent
      // handful; "View all" (notifAllModal) shows every item.
      listEl.innerHTML = this.items.slice(0, 8).map(item => this._rowHtml(item)).join('');
    },

    // Shared row markup for both the dropdown panel and the "View all"
    // modal, so the two stay visually/behaviorally identical.
    _rowHtml(item) {
      const errorClass = item.isError ? ' notif-error' : '';
      const unreadClass = item.unread ? ' notif-unread' : '';
      const timeStr = this.formatTime(item.timestamp);
      const goHint = item.link
        ? '<i class="bi bi-box-arrow-up-right notif-item-go" title="Go to record"></i>'
        : (item.isError ? '<i class="bi bi-info-circle notif-item-go" title="View details"></i>' : '');
      return `
            <div class="notif-item notif-item-clickable${errorClass}${unreadClass}" onclick="App.Notify.openItem('${escapeHtml(item.id)}')" role="button" tabindex="0">
              <div class="notif-item-dot"></div>
              <div class="notif-item-body">
                <div class="notif-item-msg">${escapeHtml(item.message)}</div>
                <div class="notif-item-time">${timeStr}</div>
              </div>
              ${goHint}
              <button type="button" class="notif-item-remove" title="Dismiss notification" onclick="App.Notify.remove('${escapeHtml(item.id)}', event)">&times;</button>
            </div>
          `;
    },

    _handleOutsideClick(e) {
      const wrap = document.querySelector('.notif-wrap');
      if (wrap && !wrap.contains(e.target)) {
        App.Notify.close();
      }
    },

    _handleKeyDown(e) {
      if (e.key === 'Escape') {
        App.Notify.close();
        const btn = document.getElementById('notif-bell-btn');
        if (btn) btn.focus();
      }
    },

    _bindOutsideListeners() {
      if (this._listenersBound) return;
      this._listenersBound = true;
      this._onOutsideClick = this._handleOutsideClick.bind(this);
      this._onKeyDown = this._handleKeyDown.bind(this);
      setTimeout(() => {
        if (this.isOpen) {
          document.addEventListener('click', this._onOutsideClick);
          document.addEventListener('keydown', this._onKeyDown);
        }
      }, 0);
    },

    _unbindOutsideListeners() {
      if (!this._listenersBound) return;
      this._listenersBound = false;
      if (this._onOutsideClick) document.removeEventListener('click', this._onOutsideClick);
      if (this._onKeyDown) document.removeEventListener('keydown', this._onKeyDown);
    },

    async checkSmartAlerts() {
      if (!this._alertKeys) this._alertKeys = new Set();

      // Fetch stock data if state is empty
      if ((!App.State?.globalStock || App.State.globalStock.length === 0) && typeof Api !== 'undefined') {
        try {
          const res = await Api.call('getStockData');
          if (res?.success && Array.isArray(res.data)) {
            App.State.globalStock = res.data;
          }
        } catch (e) { /* ignore best effort */ }
      }

      // 1. Low Stock Smart Alert
      const stockItems = App.State?.globalStock || [];
      const lowStock = stockItems.filter(i => (i.isLowStock || (Number(i.threshold) > 0 && Number(i.currentStock) <= Number(i.threshold))));
      if (lowStock.length > 0) {
        const key = `lowstock-${lowStock.length}-${lowStock.slice(0, 3).map(i => i.name + i.size).join('|')}`;
        if (!this._alertKeys.has(key)) {
          this._alertKeys.add(key);
          const preview = lowStock.slice(0, 2).map(i => `${i.name}${i.size ? ` [${i.size}]` : ''} (${i.currentStock} left)`).join(', ');
          const extra = lowStock.length > 2 ? ` and ${lowStock.length - 2} more` : '';
          this.add(`⚠️ Smart Alert: ${lowStock.length} item(s) below threshold (${preview}${extra}).`, true, { link: { type: 'stock' } });
        }
      }

      // 2. Overdue Pending Purchase Orders Alert (pending > 7 days)
      if (typeof App.PO !== 'undefined') {
        try { await App.PO.ensureLoaded(); } catch (e) { /* ignore best effort */ }
      }
      const pos = App.State?.globalPOs || [];
      const now = new Date();
      const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
      const overduePOs = pos.filter(po => {
        if (!po || po.status === PO_STATUS.COMPLETED) return false;
        const poDate = parseRecordDate(po.poDateRaw, po.poDate);
        return !isNaN(poDate.getTime()) && (now - poDate) > SEVEN_DAYS_MS;
      });
      if (overduePOs.length > 0) {
        const key = `overduepo-${overduePOs.length}-${overduePOs.slice(0, 3).map(p => p.poNumber).join('|')}`;
        if (!this._alertKeys.has(key)) {
          this._alertKeys.add(key);
          const nums = overduePOs.slice(0, 3).map(p => `#${p.poNumber}`).join(', ');
          const extra = overduePOs.length > 3 ? ` and ${overduePOs.length - 3} more` : '';
          this.add(`📋 Smart Alert: ${overduePOs.length} purchase order(s) pending >7 days (${nums}${extra}).`, false, { link: { type: 'tab', tab: 'poLedger' } });
        }
      }
    },

    // Surfaces backend-detected problems -- Internal Ledger Audit findings
    // (module_audit.js's port, erp.ledger_audit_log via
    // getRecentNotificationLogs) -- into the same notification feed, so
    // findings from a scheduler run nobody was watching still show up here.
    // Dedupes against a persisted "seen" set (unlike _alertKeys, which is
    // in-memory only) so the same log row isn't re-notified on every page
    // reload. See ledger_audit_service.get_recent_notification_logs's own
    // docstring for why this covers ledger-audit findings only, not
    // arbitrary backend errors (source's Logs-sheet script-error half has
    // no equivalent table here).
    async checkBackendAlerts() {
      if (typeof Api === 'undefined') return;

      let seen;
      try {
        seen = new Set(JSON.parse(localStorage.getItem(this.SEEN_LOGS_KEY) || '[]'));
      } catch (e) {
        seen = new Set();
      }

      let res;
      try {
        res = await Api.call('getRecentNotificationLogs');
      } catch (e) {
        return; // best-effort -- a failure here must never block startup
      }
      if (!res?.success || !Array.isArray(res.data)) return;

      let sawNew = false;
      res.data.forEach(log => {
        if (!log?.key || seen.has(log.key)) return;
        seen.add(log.key);
        sawNew = true;

        const link = this._guessBackendLink(log);
        if (log.action === 'LEDGER_AUDIT_FINDING') {
          this.add(`📒 Ledger Audit: ${log.details}`, true, { link, detail: log.details });
        } else {
          this.add(`⚙️ Backend error in ${log.source || 'a background process'}: ${log.details}`, true, {
            link,
            detail: `${log.action}${log.source ? ' — ' + log.source : ''}\n${log.details}`
          });
        }
      });

      if (sawNew) {
        try {
          localStorage.setItem(this.SEEN_LOGS_KEY, JSON.stringify(Array.from(seen).slice(-300)));
        } catch (e) { /* storage denied -- dedupe just won't persist */ }
      }
    },

    // Best-effort {type, value|tab} guess for a ledger-audit log row --
    // never throws, returns null when nothing can be inferred (falls back
    // to the detail modal, which is always correct even with no link).
    _guessBackendLink(log) {
      if (log.action === 'LEDGER_AUDIT_FINDING') {
        const findingType = String(log.details || '').split(':')[0].trim();
        if (findingType === 'over_billed_po_line') return { type: 'po', value: log.recordId };
        if (findingType === 'orphaned_return_bill_ref' || findingType === 'return_item_not_on_bill') {
          return { type: 'return', value: log.recordId };
        }
        return null;
      }
      // Regular script errors log the failing function's name in `source`
      // -- not a stable record id, so only guess which TAB it likely
      // relates to, never a specific record.
      const fn = String(log.source || '');
      const guesses = [
        ['PO', 'po'], ['Bill', 'bill'], ['Return', 'return'], ['Dispatch', 'dispatch'],
        ['Production', 'production'], ['Process', 'process'], ['Contractor', 'contractor'],
        ['Vendor', 'vendor'], ['Client', 'client'], ['BOM', 'bom'], ['Item', 'item'], ['Stock', 'stock']
      ];
      const hit = guesses.find(([token]) => fn.includes(token));
      return hit ? { type: 'tab', tab: this.NAV[hit[1]]?.tab } : null;
    }
  },

  // ── Shared UX primitives ─────────────────────────────────────────────
  Utils: {
    // `link` -- {type, value?} per App.Notify.NAV -- makes the resulting
    // bell notification clickable-to-navigate straight to the form/list
    // the action affected.
    showToast(message, isError = false, link = null) {
      if (App.Notify && typeof App.Notify.add === 'function') {
        App.Notify.add(message, isError, { link });
      }
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

    // Toggles an edit modal's footer between its two states, shared by
    // every module's openCreateModal (isEditMode=false) and
    // openEditModal (isEditMode=true) pair:
    //   - Add New: Cancel (discard, close) + a Save/Create-labeled submit
    //     button.
    //   - Edit: Exit (App.Nav.exit -- warns before discarding unsaved
    //     edits) + a submit button labeled per submitLabel. Exit is the
    //     intended close path from edit mode so Prev/Next keeps working
    //     without the operator losing their place.
    // Centralized so this toggle doesn't drift into slightly different
    // shapes across every modal that uses it.
    setFormButtonsForMode(cancelBtnId, exitBtnId, submitBtnId, isEditMode, submitLabel) {
      const cancelBtn = document.getElementById(cancelBtnId);
      const exitBtn = document.getElementById(exitBtnId);
      const submitBtn = document.getElementById(submitBtnId);
      if (cancelBtn) cancelBtn.style.display = isEditMode ? 'none' : '';
      if (exitBtn) exitBtn.style.display = isEditMode ? '' : 'none';
      if (submitBtn && submitLabel !== undefined) submitBtn.innerText = submitLabel;
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

    // Same real color, ignoring case/whitespace -- a color name reaches the
    // browser from several independent places (Color Master, a recipe's
    // Color Sub-Group, a Warehouse Pool bucket, a saved lot's Color
    // Breakdown), and "Blue"/"BLUE"/"blue" is one color in every one of them.
    sameColor(a, b) {
      return this.sameText(a, b);
    },

    // True when a component row's Color Sub-Group is the COMMON sentinel
    // rather than a real color name.
    isCommonColorGroup(colorGroup) {
      return String(colorGroup == null ? '' : colorGroup).trim().toUpperCase() === 'COMMON';
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

    // Helper to resolve select2 dropdownParent container (modal if inside one, else document.body)
    select2DropdownParent(target) {
      if (!target) return window.jQuery ? window.jQuery(document.body) : document.body;
      const $target = window.jQuery ? window.jQuery(target) : null;
      if (!$target || !$target.length) return window.jQuery ? window.jQuery(document.body) : document.body;
      const $modal = $target.closest ? $target.closest('.modal') : null;
      return ($modal && $modal.length) ? $modal : window.jQuery(document.body);
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

  // ── My Profile (self-service, every role) ───────────────────────────────
  // Two independent forms/mutations (updateMyProfile / changeMyPassword,
  // see profile_service.py) since a mistake in one (e.g. a password typo)
  // shouldn't block saving the other.
  Profile: {
    openModal() {
      const profileForm = document.getElementById('myProfileForm');
      if (profileForm) profileForm.reset();
      const passwordForm = document.getElementById('myPasswordForm');
      if (passwordForm) passwordForm.reset();
      safeModalShow('myProfileModal');
    },

    async submitProfile(e) {
      e.preventDefault();
      const form = e.target;
      const name = form.name.value.trim();
      const email = form.email.value.trim();

      const btn = document.getElementById('myProfileSaveBtn');
      if (btn) btn.disabled = true;
      try {
        const res = await Api.mutate('updateMyProfile', name, email);
        App.Utils.showToast(res?.message || (res?.success ? 'Profile updated.' : 'Failed to update profile.'), !res?.success);
        if (res?.success) {
          // The header/dropdown's name+avatar-initial are rendered from
          // Jinja at page load, not re-fetched -- patch them directly so
          // the change is visible without a full reload.
          const nameEl = document.querySelector('.account-name');
          if (nameEl) nameEl.textContent = name || email;
          const avatarEl = document.querySelector('.account-avatar');
          if (avatarEl) avatarEl.textContent = (name || email || '?').charAt(0).toUpperCase();
        }
      } catch (err) {
        App.Utils.showToast(err.message || 'Failed to update profile.', true);
      } finally {
        if (btn) btn.disabled = false;
      }
    },

    async submitPassword(e) {
      e.preventDefault();
      const form = e.target;
      const currentPassword = form.currentPassword.value;
      const newPassword = form.newPassword.value;
      const confirmNewPassword = form.confirmNewPassword.value;

      if (newPassword !== confirmNewPassword) {
        App.Utils.showToast('New passwords do not match.', true);
        return;
      }

      const btn = document.getElementById('myPasswordSaveBtn');
      if (btn) btn.disabled = true;
      try {
        const res = await Api.mutate('changeMyPassword', currentPassword, newPassword, confirmNewPassword);
        App.Utils.showToast(res?.message || (res?.success ? 'Password updated.' : 'Failed to update password.'), !res?.success);
        if (res?.success) form.reset();
      } catch (err) {
        App.Utils.showToast(err.message || 'Failed to update password.', true);
      } finally {
        if (btn) btn.disabled = false;
      }
    }
  },

  // ── Navigation ────────────────────────────────────────────────────────
  Navigation: {
    LAST_TAB_KEY: 'maharaja-erp-last-tab',

    showTab(id) {
      $$('.tab-content').forEach(tab => {
        tab.style.display = tab.id === id ? 'block' : 'none';
      });

      $$('#mainTabs .nav-link').forEach(btn => btn.classList.remove('active'));
      document.getElementById(`btn-${id}`)?.classList.add('active');

      try { localStorage.setItem(this.LAST_TAB_KEY, id); } catch (e) { /* storage inaccessible */ }

      if (typeof App.Dashboard !== 'undefined') App.Dashboard.stopAutoRefresh();

      // Only the tab being switched to fetches its data -- each module loads
      // lazily right here, on its own visit, rather than every module eagerly
      // fetching on every page load regardless of which tab is shown (see
      // Init). Returns that one load's promise so a caller like Init can
      // await/report on it instead of every module racing in parallel.
      let loadPromise;
      if (id === 'dashboardTab' && typeof App.Dashboard !== 'undefined') {
        loadPromise = App.Dashboard.loadData();
        App.Dashboard.startAutoRefresh();
      } else if (id === 'vendorMaster' && typeof App.Vendor !== 'undefined') {
        loadPromise = App.Vendor.loadData();
      } else if (id === 'itemMaster' && typeof App.Item !== 'undefined') {
        loadPromise = App.Item.loadData();
      } else if (id === 'poLedger' && typeof App.PO !== 'undefined') {
        loadPromise = App.PO.loadData();
      } else if (id === 'billLedger' && typeof App.Bill !== 'undefined') {
        loadPromise = App.Bill.loadData();
      } else if (id === 'returnLedger' && typeof App.Return !== 'undefined') {
        loadPromise = App.Return.loadData();
      } else if (id === 'stockTab' && typeof App.Stock !== 'undefined') {
        loadPromise = App.Stock.loadData();
      } else if (id === 'productsTab' && typeof App.Products !== 'undefined') {
        loadPromise = App.Products.enterTab();
      } else if (id === 'contractorsTab' && typeof App.Contractor !== 'undefined') {
        loadPromise = App.Contractor.loadData();
      } else if (id === 'productionTab' && typeof App.Production !== 'undefined') {
        loadPromise = App.Production.loadData();
      } else if (id === 'clientsTab' && typeof App.Client !== 'undefined') {
        loadPromise = App.Client.enterTab();
      } else if (id === 'dispatchTab' && typeof App.Dispatch !== 'undefined') {
        loadPromise = App.Dispatch.enterTab();
      } else if (id === 'usersTab' && typeof App.Users !== 'undefined') {
        loadPromise = App.Users.loadData();
      }
      // Every other module's own `else if (id === '<tab>') loadPromise =
      // App.<Module>.loadData();` branch lands here in that module's own
      // round -- same guarded pattern Navigation.showTab already used in
      // source for not-yet-loaded modules.
      return loadPromise;
    }
  },

  // ── Logo Management ──────────────────────────────────────────────────
  Logo: {
    async load() {
      try {
        const res = await Api.call('getLogo');
        if (res?.success && res.data) {
          App.companyLogo = res.data;
          App.Print.injectLogo();
          this._updateHeaderUI(res.data);
        }
      } catch (e) {
        console.warn('[Logo] Failed to load saved logo:', e);
      }
    },

    upload(file) {
      if (!file || !file.type.startsWith('image/')) {
        App.Utils.showToast('Please select an image file.', true);
        return;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          // Compress to max 300px wide, JPEG 0.75 to keep chunks small
          const MAX_W = 300;
          const scale = Math.min(1, MAX_W / img.width);
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/png');

          // Source split this into 8000-char chunks to stay under Apps
          // Script's ~9KB PropertiesService value limit -- kept here only
          // as the wire shape saveLogo's args expect (an array), not
          // because Postgres has any such limit (see
          // company_settings_service.py, which just joins them back).
          const CHUNK = 8000;
          const chunks = [];
          for (let i = 0; i < dataUrl.length; i += CHUNK) chunks.push(dataUrl.slice(i, i + CHUNK));

          Api.mutate('saveLogo', chunks)
            .then(res => {
              if (res?.success) {
                App.companyLogo = dataUrl;
                App.Print.injectLogo();
                this._updateHeaderUI(dataUrl);
                App.Utils.showToast('Logo saved — all print templates updated.');
              } else {
                App.Utils.showToast(res?.message || 'Failed to save logo.', true);
              }
            })
            .catch(err => App.Utils.showToast(err.message || 'Failed to save logo.', true));
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    },

    clear() {
      Api.mutate('clearLogo')
        .then(res => {
          if (res?.success) {
            App.companyLogo = null;
            App.Print.injectLogo();
            this._updateHeaderUI(null);
            App.Utils.showToast('Logo removed.');
          } else {
            App.Utils.showToast(res?.message || 'Failed to remove logo.', true);
          }
        })
        .catch(err => App.Utils.showToast(err.message || 'Failed to remove logo.', true));
    },

    _updateHeaderUI(dataUrl) {
      const container = document.getElementById('brand-icon-container');
      const svg = document.getElementById('brand-icon-svg');
      const logoImg = document.getElementById('brand-icon-logo');
      const clearBtn = document.getElementById('logo-clear-btn');

      if (dataUrl) {
        if (svg) svg.style.display = 'none';
        if (logoImg) { logoImg.src = dataUrl; logoImg.style.display = 'block'; }
        if (container) container.style.background = 'transparent';
      } else {
        if (svg) svg.style.display = '';
        if (logoImg) { logoImg.src = ''; logoImg.style.display = 'none'; }
        if (container) container.style.background = 'linear-gradient(135deg, var(--primary-color) 0%, var(--primary-light) 100%)';
      }

      if (clearBtn) clearBtn.style.display = dataUrl ? 'inline-flex' : 'none';
    }
  },

  // targetTab is the tab about to be shown (the last one the user was on,
  // or Dashboard by default -- see the DOMContentLoaded handler). Only that
  // tab's own data loads here; every other module was previously fetched
  // unconditionally on every single page load regardless of which tab the
  // user actually landed on (Dashboard *and* Vendor, Item, PO, Bill, Return
  // every time), which was most of this app's "heavy first load" cost. Each
  // other module now lazy-loads the moment its own tab is switched to (see
  // Navigation.showTab) instead.
  async Init(targetTab) {
    // Load persisted company logo and notification history (non-blocking,
    // best-effort).
    this.Logo.load();
    if (this.Notify) this.Notify.load();

    const promises = [App.Navigation.showTab(targetTab || 'dashboardTab')];

    // Unit Master stays eager (matches source) since Item Master's
    // Base/Purchase Unit fields need unitList populated whenever that
    // modal opens, which can happen before the user ever visits Stock or
    // Item Master itself -- unlike the per-tab data above, there's no
    // single "visit" that reliably happens before it's needed.
    // Color/Model/ProcessType stay lazy (ensureLoaded() from their own
    // openModal()) -- nothing needs them before their own modal opens.
    if (this.Unit) promises.push(this.Unit.ensureLoaded());

    const results = await Promise.allSettled(promises);
    const failed = results.filter(r => r.status === 'rejected');
    failed.forEach(r => console.error('[Init] data load failed:', r.reason));
    if (failed.length > 0) {
      this.Utils.showToast('Failed to load some data. Check your connection and retry.', true);
    }

    // Trigger smart notifications (low stock, pending POs) and surface any
    // backend-logged ledger-audit findings since the last visit --
    // best-effort, never blocks init.
    if (this.Notify) {
      this.Notify.checkSmartAlerts().catch(e => console.error('[Init] checkSmartAlerts failed:', e));
      this.Notify.checkBackendAlerts().catch(e => console.error('[Init] checkBackendAlerts failed:', e));
    }
  }
};

window.App = App;

function bindGlobalEvents() {
  const logoInput = document.getElementById('logo-upload-input');
  if (logoInput) {
    logoInput.addEventListener('change', function () {
      if (this.files?.[0]) {
        App.Logo.upload(this.files[0]);
        this.value = ''; // reset so the same file can be re-selected
      }
    });
  }

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
      case 'issue-page':
        App.Issue.changePage(toNumber(btn.dataset.page, 1));
        break;
      case 'client-page':
        App.Client.changeClientsPage(toNumber(btn.dataset.page, 1));
        break;
      case 'order-page':
        App.Client.changeOrdersPage(toNumber(btn.dataset.page, 1));
        break;
      case 'dispatch-page':
        App.Dispatch.changeDispatchPage(toNumber(btn.dataset.page, 1));
        break;
    }
  });

  document.getElementById('myProfileForm')?.addEventListener('submit', e => App.Profile.submitProfile(e));
  document.getElementById('myPasswordForm')?.addEventListener('submit', e => App.Profile.submitPassword(e));
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

  // Reload/refresh used to always land back on Dashboard because the tab
  // shown was whatever the static HTML marked active, with nothing to say
  // otherwise -- and Init() didn't decide which tab to load until after it
  // had already eagerly fetched every module's data. Decide the target tab
  // FIRST, before Init() runs, so it loads only that tab's data (and shows
  // it) instead of every module's -- but only if its nav button actually
  // exists (role-gated tabs like usersTab disappear for non-admins, and a
  // stale id from an older build shouldn't crash init).
  const lastTab = safeGetItem(App.Navigation.LAST_TAB_KEY);
  const targetTab = (lastTab && document.getElementById(`btn-${lastTab}`)) ? lastTab : 'dashboardTab';
  await App.Init(targetTab);

  // Register the shell service worker (Phase 5: PWA installability).
  // Scoped to /erp/sw.js, not /static/erp/sw.js, so its default scope
  // naturally covers /erp/* -- see app/erp/pages.py's service_worker
  // route for why. Registration failures (e.g. sandboxed iframe, browser
  // without SW support) are non-fatal -- the app works identically
  // without it, just without install/offline-shell support.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/erp/sw.js', { scope: '/erp' })
      .catch(err => console.warn('[PWA] Service worker registration failed:', err));
  }
});
