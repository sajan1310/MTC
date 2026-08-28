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

// Lazily loads a script once, returning the same promise for repeat calls.
//
// `integrity` is REQUIRED for anything served from a third-party CDN: without
// it a compromised or swapped CDN file executes with full access to an
// authenticated ERP session. crossorigin="anonymous" has to go with it --
// without that the response is opaque, the browser cannot verify the hash, and
// the asset is blocked outright rather than checked. Same-origin scripts
// (static/erp/vendor/**) need neither.
//
// A mismatch fires onerror, so it lands in the same rejection path as a
// network failure and the caller's existing error handling covers it.
const _scriptLoadPromises = {};
function loadScript(src, integrity) {
  if (!_scriptLoadPromises[src]) {
    _scriptLoadPromises[src] = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      if (integrity) {
        script.integrity = integrity;
        script.crossOrigin = 'anonymous';
      }
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

// The element focus should return to when the modal closes (A11Y-005).
//
// Bootstrap's focus trap restores focus to whatever was focused when it
// activated, which works for a modal opened by a data-bs-toggle button. Every
// modal here is opened programmatically from a click handler, an async
// callback or a keyboard shortcut, so what was focused at activate time is
// often the <body> -- and focus lands at the top of the document on close,
// dropping a keyboard user back past fourteen nav buttons from wherever they
// actually were.
let _focusBeforeModal = null;

function rememberFocusForModal(el) {
  const active = document.activeElement;
  if (active && active !== document.body && !el.contains(active)) {
    _focusBeforeModal = active;
  }
  if (el.dataset.focusRestoreBound === '1') return;
  el.dataset.focusRestoreBound = '1';
  el.addEventListener('hidden.bs.modal', () => {
    const target = _focusBeforeModal;
    _focusBeforeModal = null;
    // Still in the document: it may have been re-rendered away while the
    // modal was open, which is exactly when blindly focusing it would throw.
    if (target && document.contains(target) && typeof target.focus === 'function') {
      target.focus();
    }
  });
}

function safeModalShow(id) {
  const el = document.getElementById(id);
  if (!el || typeof bootstrap === 'undefined') return;
  rememberFocusForModal(el);
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
  // `key` is only guaranteed on a real keystroke. A synthetic keydown --
  // dispatched by a widget library, a password manager, or any extension
  // injected into the page -- can arrive as a bare Event with no `key` at
  // all, and this listener sees every keydown in the app, so reading it
  // unguarded threw a TypeError into the console on each one.
  const key = String(e.key || '').toLowerCase();
  if (!key) return;
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

    // Item Ledger, keyed by item name lowercased -> the server's own
    // getItemLedgerData payload ({entries, reconciliation}). Cached per
    // name because the ledger is computed server-side from the same terms
    // as the Current Stock formula rather than reassembled in the browser.
    itemLedgers: {},

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
    selectedContractorServiceCharges: [],
    selectedContractorPayments: [],
    currentContractorRates: { contractorName: '', rates: [] },
    currentContractorServiceCharges: { contractorName: '', charges: [] },
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
    // Bulk deactivation's checkbox column (Super Admin only) -- user-id
    // strings, same shape as every other tab's selection array.
    selectedUsers: [],
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
    // ── Announcements to assistive technology (A11Y-005, A11Y-006) ───────
    //
    // Everything on these tabs happens without a page load: data arrives,
    // tables re-render, a filter narrows 1,600 rows to 3, a sort reverses
    // the order. A sighted user sees all of it. A screen-reader user was
    // told none of it -- the DOM changed silently beneath a cursor that had
    // not moved, so the only way to discover the result was to navigate the
    // whole table again and infer it.
    //
    // A polite live region, NOT a focus jump. Moving focus to the table
    // after an async load sounds helpful and is hostile in practice: loads
    // finish while the user is still typing in the search box, and yanking
    // the caret out mid-word is worse than saying nothing. "polite" waits
    // for a pause in speech instead of interrupting.
    _lastAnnouncement: null,

    announce(message) {
      const text = String(message || '').trim();
      if (!text) return;
      const region = document.getElementById('a11y-announcer');
      if (!region) return;
      // A re-render that changed nothing should say nothing: tables re-render
      // for reasons the user did not cause, and repeating "Showing 1 to 25 of
      // 40 Items" every time is noise that trains people to ignore the region.
      if (App.Utils._lastAnnouncement === text) return;
      App.Utils._lastAnnouncement = text;
      // Same string twice in a row is not re-announced by most screen
      // readers, and "3 results" after a different search is worth hearing
      // again. Clearing first forces it to count as a change.
      region.textContent = '';
      window.setTimeout(() => { region.textContent = text; }, 50);
    },

    /** "Showing 12 of 1,633 items" -- the sentence a sighted user reads off the table. */
    announceRowCount(shown, total, noun) {
      const label = noun || 'rows';
      if (total === undefined || total === null || shown === total) {
        App.Utils.announce(`${shown} ${label}`);
      } else {
        App.Utils.announce(`Showing ${shown} of ${total} ${label}`);
      }
    },

    // ── Form validation, programmatically associated (A11Y-007) ──────────
    //
    // Validation failures surfaced as toasts: "Every ticked process needs a
    // Qty per Unit greater than 0". The toast names the rule but not the
    // field, appears in a corner unrelated to the form, and removes itself
    // after a few seconds. A sighted user scans the form and guesses. A
    // screen-reader user gets nothing at all -- no aria-invalid anywhere, so
    // no field announces itself as the problem, and by the time they have
    // navigated to the form the toast is gone.
    //
    // These attach the message TO the field: aria-invalid marks it, and
    // aria-describedby ties the text to it so it is read as part of the
    // field rather than as unrelated page content.

    /** Mark one field invalid and attach `message` to it. */
    markFieldInvalid(field, message) {
      const el = typeof field === 'string' ? document.getElementById(field) : field;
      if (!el) return;

      el.classList.add('is-invalid');
      el.setAttribute('aria-invalid', 'true');

      const id = `${el.id || `field-${Math.random().toString(36).slice(2)}`}-error`;
      let feedback = document.getElementById(id);
      if (!feedback) {
        feedback = document.createElement('div');
        feedback.id = id;
        feedback.className = 'invalid-feedback';
        // After the field, so the reading order matches the visual order.
        el.insertAdjacentElement('afterend', feedback);
      }
      feedback.textContent = String(message || 'This value is not valid.');

      // Appended rather than replacing: a field may already point at help
      // text, and clobbering that would trade one lost message for another.
      const described = (el.getAttribute('aria-describedby') || '')
        .split(/\s+/).filter(Boolean);
      if (!described.includes(id)) {
        described.push(id);
        el.setAttribute('aria-describedby', described.join(' '));
      }
    },

    /** Clear every invalid mark inside `scope` (a form element or its id). */
    clearFieldErrors(scope) {
      const root = typeof scope === 'string' ? document.getElementById(scope) : scope;
      if (!root) return;
      root.querySelectorAll('[aria-invalid="true"]').forEach(el => {
        el.classList.remove('is-invalid');
        el.removeAttribute('aria-invalid');
        const id = `${el.id}-error`;
        const described = (el.getAttribute('aria-describedby') || '')
          .split(/\s+/).filter(Boolean).filter(x => x !== id);
        if (described.length) el.setAttribute('aria-describedby', described.join(' '));
        else el.removeAttribute('aria-describedby');
      });
      root.querySelectorAll('.invalid-feedback').forEach(el => { el.textContent = ''; });
    },

    /**
     * Run the browser's own constraint validation over a form.
     *
     * The forms already carry `required`, `maxlength`, `min` and `step`, and
     * none of it was ever checked: every save is a button click against a
     * form that is never submitted, so the browser had no reason to
     * validate. Constraints that had been written down were simply not
     * enforced.
     *
     * Returns true when the form is valid. When it is not, the first
     * offending field is marked, described, announced and focused -- focus
     * last, because moving it before the message exists means a screen
     * reader announces the field without the reason.
     */
    validateForm(form) {
      const el = typeof form === 'string' ? document.getElementById(form) : form;
      if (!el || typeof el.checkValidity !== 'function') return true;

      App.Utils.clearFieldErrors(el);
      if (el.checkValidity()) return true;

      const invalid = Array.from(el.elements || []).filter(
        f => typeof f.checkValidity === 'function' && !f.checkValidity() && !f.disabled,
      );
      invalid.forEach(field => {
        App.Utils.markFieldInvalid(field, field.validationMessage);
      });

      const first = invalid[0];
      if (first) {
        const label = (
          el.querySelector(`label[for="${first.id}"]`)?.textContent
          || first.getAttribute('aria-label')
          || first.name
          || 'A field'
        ).replace(/\s*\*\s*$/, '').trim();
        App.Utils.announce(`${label}: ${first.validationMessage}`);
        if (typeof first.focus === 'function') first.focus();
      }
      return false;
    },

    // ── Search debounce (UX-002) ─────────────────────────────────────────
    //
    // The 28 desktop search boxes were wired `onkeyup="App.X.filterY(this.value)"`,
    // so every keystroke re-filtered the dataset and re-rendered the whole
    // table. On Stock -- 1,633 rows in production -- typing a six-character
    // item name did that six times, and the typing itself stutters because
    // the render blocks the main thread between keystrokes. The mobile shell
    // has had a debounce since it was written; the desktop never got one.
    //
    // A WeakMap keyed on the input element, so each box has its own timer and
    // two open dialogs cannot cancel each other's. WeakMap rather than a
    // plain object because entries then disappear with the elements when a
    // dialog's markup is replaced, instead of accumulating.
    _filterTimers: new WeakMap(),

    debouncedFilter(el, fn, wait) {
      if (typeof fn !== 'function') return;
      if (!el) { fn(); return; }
      clearTimeout(App.Utils._filterTimers.get(el));
      App.Utils._filterTimers.set(el, setTimeout(fn, wait || 200));
    },

    // ── Table load states (UX-001) ───────────────────────────────────────
    //
    // Twenty-four table loaders wrote a "Loading ..." row into a tbody and
    // then, on failure, showed a toast and returned. The toast vanishes after
    // a few seconds; the row does not. So a failed load left a table saying
    // it was loading, permanently, and the only visible evidence of the
    // failure disappeared on its own. A user could sit in front of "Loading
    // Clients..." indefinitely with nothing to click and no reason to think
    // anything was wrong.
    //
    // These two helpers make the failure state as durable as the loading
    // state, and give it the one thing the user actually wants: a way to try
    // again without reloading the page.

    /** Placeholder row while a table's data is in flight. */
    tableLoading(tbody, colspan, label) {
      const el = typeof tbody === 'string' ? document.getElementById(tbody) : tbody;
      if (!el) return;
      // Remembered so tableError can span the same columns without every
      // caller having to pass the count a second time -- and get it wrong.
      el.dataset.loadColspan = String(colspan);
      el.innerHTML =
        `<tr><td colspan="${colspan}" class="text-center p-4 text-muted">` +
        `<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>` +
        `${escapeHtml(label || 'Loading…')}</td></tr>`;
    },

    /**
     * Error row replacing the placeholder, with a Retry button.
     *
     * `retry` is stored rather than inlined into an onclick attribute: the
     * markup here interpolates a server-supplied message, and an inline
     * handler beside interpolated text is the shape that turns a message into
     * script (SEC-004).
     */
    tableError(tbody, message, retry) {
      const el = typeof tbody === 'string' ? document.getElementById(tbody) : tbody;
      if (!el) return;
      const colspan = el.dataset.loadColspan || 1;
      const text = escapeHtml(
        message || 'Could not load this data.',
      );
      el.innerHTML =
        `<tr><td colspan="${colspan}" class="text-center p-4">` +
        `<div class="text-danger mb-2">` +
        `<i class="bi bi-exclamation-triangle me-1" aria-hidden="true"></i>${text}</div>` +
        `<button type="button" class="btn btn-sm btn-outline-secondary" ` +
        `data-action="retry-table-load">Retry</button></td></tr>`;
      // role="alert" so a screen reader is told the load failed rather than
      // being left on a table that silently stopped changing.
      const cell = el.querySelector('td');
      if (cell) cell.setAttribute('role', 'alert');

      const button = el.querySelector('[data-action="retry-table-load"]');
      if (button && typeof retry === 'function') {
        button.addEventListener('click', () => {
          App.Utils.tableLoading(el, colspan, 'Retrying…');
          retry();
        });
      } else if (button) {
        // No retry available: do not show a button that does nothing.
        button.remove();
      }
    },

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

      rememberFocusForModal(el);
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

    // Display casing for name-like fields (Assigned By/To, ...) so
    // "ANIL"/"anil"/"Anil" -- all the same real contractor per sameText --
    // render identically instead of as visibly different strings. First
    // letter capital, rest lowercase; does not touch what's stored/saved.
    formatNameCase(text) {
      const s = String(text == null ? '' : text).trim();
      return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;
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
        // The case most worth announcing: a filter that matched nothing
        // leaves an empty table and, without this, complete silence.
        App.Utils.announce(`No ${label.toLowerCase()} found`);
        return;
      }

      const totalPages = Math.ceil(totalItems / rowsPerPage);
      const startItem = (currentPage - 1) * rowsPerPage + 1;
      const endItem = Math.min(currentPage * rowsPerPage, totalItems);

      // The same sentence the sighted user reads off the summary line, said
      // out loud (A11Y-005). Every module funnels through here, so one call
      // covers loads, filters, sorts and page changes across all 12 tables
      // -- and it cannot drift from what is on screen, because it IS what is
      // on screen.
      App.Utils.announce(`Showing ${startItem} to ${endItem} of ${totalItems} ${label}`);

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
  // ── Offline password prompt ───────────────────────────────────────────
  //
  // An account created by Google sign-in has no password (get_or_create_user
  // in app/utils.py inserts name/email/role/profile_picture only). That is
  // invisible while the internet is up and total once it is not: on the
  // factory LAN there is no route to accounts.google.com, and Google refuses
  // to register a private-IP redirect URI in any case, so the account simply
  // cannot sign in.
  //
  // So this is a standing banner rather than a toast: it must survive until
  // the thing it warns about is actually fixed, and the window in which it
  // can be acted on closes the moment the internet does. The trade-off of
  // not blocking the app outright is that some accounts will still be
  // missing a password on cut-over day, which is why DEPLOYMENT.md pairs
  // this with a query for finding them.
  OfflinePassword: {
    // Dismissal lives in sessionStorage, not localStorage, and is keyed by
    // user id. Both halves matter:
    //
    //   sessionStorage  -- what this warns about is a permanent lockout, so
    //     a dismissal that outlived the browser session would quietly
    //     delete the only warning the account ever gets. Closing the banner
    //     buys quiet for today; it comes back next time the app is opened.
    //   keyed by user id -- shop-floor terminals are shared. Without the
    //     key, one user dismissing it would suppress the warning for the
    //     next person who signs in on that same tab.
    DISMISS_KEY: 'maharaja-erp-offline-password-dismissed',

    // Whether the signed-in account can authenticate without Google. Read
    // from the meta at startup and flipped by onPasswordSet(); the profile
    // modal reads it too, so the wording there and the banner can never
    // disagree about which state the account is in.
    hasPassword: true,

    init() {
      const meta = document.querySelector('meta[name="current-user-has-password"]');
      // Absent meta means an older template or a page that does not emit it.
      // Treated as "has a password": a spurious banner on every load for
      // every user is worse than a missing one, and the server-side query in
      // DEPLOYMENT.md is the real backstop either way.
      this.hasPassword = !meta || meta.getAttribute('content') !== 'no';

      // Unconditional, and deliberately outside the banner's own early
      // return below: the modal must stop asking an account with no
      // password to prove a current one even when the banner has been
      // dismissed, or the dismissal would take the fix down with it.
      App.Profile.applyPasswordMode(this.hasPassword);

      if (this.hasPassword) return;

      const prompt = document.getElementById('offlinePasswordPrompt');
      if (!prompt) return;

      document.getElementById('offlinePasswordPromptBtn')
        ?.addEventListener('click', () => App.Profile.openModal());
      document.getElementById('offlinePasswordPromptClose')
        ?.addEventListener('click', () => {
          App.OfflinePassword._setDismissed(true);
          App.OfflinePassword.hidePrompt();
        });

      if (this._isDismissed()) return;
      this.showPrompt();
    },

    // Called after changeMyPassword succeeds. Hidden here rather than left
    // to the next page load, because leaving the banner up after the user
    // did exactly what it asked reads as "that did not work".
    onPasswordSet() {
      this.hasPassword = true;
      this._setDismissed(false);
      this.hidePrompt();
      App.Profile.applyPasswordMode(true);
    },

    showPrompt() {
      const prompt = document.getElementById('offlinePasswordPrompt');
      if (!prompt) return;
      prompt.classList.remove('d-none');
      prompt.classList.add('d-flex');
      this._publishHeight();

      // The banner wraps to two or three lines on a narrow window, and the
      // header's offset has to follow or it overlaps. Registered once, only
      // for the accounts that actually see the banner.
      if (!this._resizeBound) {
        this._resizeBound = true;
        window.addEventListener('resize', () => App.OfflinePassword._publishHeight());
      }
    },

    hidePrompt() {
      const prompt = document.getElementById('offlinePasswordPrompt');
      if (!prompt) return;
      prompt.classList.add('d-none');
      prompt.classList.remove('d-flex');
      this._publishHeight();
    },

    // The banner is pinned to the top (styles.css #offlinePasswordPrompt) so
    // it cannot scroll away -- it sits above .app-header in the document,
    // and the app scrolls itself down on load restoring the last tab, which
    // used to carry the banner off the top of the screen before anyone could
    // read it. Pinning means the header has to start below it, and only this
    // knows how tall "it" is. 0 when hidden, which is the common case and
    // leaves the header exactly where it has always been.
    _publishHeight() {
      const prompt = document.getElementById('offlinePasswordPrompt');
      const shown = prompt && !prompt.classList.contains('d-none');
      const px = shown ? Math.ceil(prompt.getBoundingClientRect().height) : 0;
      document.documentElement.style.setProperty('--offline-banner-offset', `${px}px`);
    },

    _dismissKey() {
      const id = document.querySelector('meta[name="current-user-id"]')?.getAttribute('content');
      // No id (older template) falls back to a shared key rather than
      // skipping dismissal entirely -- a button that visibly does nothing
      // is worse than one that is slightly over-broad on a page that should
      // not occur anyway.
      return `${this.DISMISS_KEY}:${id || 'unknown'}`;
    },

    // Storage can throw outright, not just come back empty (Safari private
    // browsing, "block all cookies"). A banner is not worth a broken page,
    // and a failed read must land on "not dismissed" so the warning shows.
    _isDismissed() {
      try {
        return sessionStorage.getItem(this._dismissKey()) === '1';
      } catch (e) {
        return false;
      }
    },

    _setDismissed(dismissed) {
      try {
        if (dismissed) sessionStorage.setItem(this._dismissKey(), '1');
        else sessionStorage.removeItem(this._dismissKey());
      } catch (e) { /* storage inaccessible -- banner returns on reload */ }
    }
  },

  Profile: {
    // Switches the password section between "change" and "set" wording, and
    // hides the Current Password field entirely for an account that has
    // none. A Google-created account has no current password to type, so
    // showing the field asked the user to work out that "blank" was the
    // right answer -- and change_my_password (profile_service.py) already
    // skips the check when password_hash IS NULL, so the field was never
    // doing anything for them anyway.
    applyPasswordMode(hasPassword) {
      const field = document.getElementById('currentPasswordField');
      if (field) field.classList.toggle('d-none', !hasPassword);

      // Cleared as well as hidden. The input stays in the form (so
      // submitPassword's form.currentPassword still resolves), and a value
      // typed before the mode switched would otherwise be submitted from a
      // field the user can no longer see.
      const input = document.querySelector('#myPasswordForm [name="currentPassword"]');
      if (input && !hasPassword) input.value = '';

      const heading = document.getElementById('myPasswordHeading');
      if (heading) heading.textContent = hasPassword ? 'Change Password' : 'Set a Password';
      const btn = document.getElementById('myPasswordSaveBtn');
      if (btn) btn.textContent = hasPassword ? 'Change Password' : 'Set Password';
    },

    openModal() {
      const profileForm = document.getElementById('myProfileForm');
      if (profileForm) profileForm.reset();
      const passwordForm = document.getElementById('myPasswordForm');
      if (passwordForm) passwordForm.reset();
      // reset() restores the field's markup value but not the mode -- and
      // the modal can be opened before or after a password is set, so
      // re-apply rather than trusting whatever the last open left behind.
      this.applyPasswordMode(App.OfflinePassword.hasPassword);
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
        if (res?.success) {
          form.reset();
          // The account now has a password, so the banner has nothing left
          // to warn about and the modal must start asking for a current
          // password again on the next change.
          App.OfflinePassword.onPasswordSet();
        }
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

    // The tab currently on screen. Tracked so handleHashChange can tell a
    // real back/forward navigation from a hash that already matches what's
    // displayed, and skip re-running that tab's data load.
    current: null,

    // A tab id is only usable if its nav button actually exists: role-gated
    // tabs like usersTab disappear for non-admins, and a stale id from an
    // older build -- or a hand-edited URL -- shouldn't crash navigation.
    isValidTab(id) {
      return !!id && !!document.getElementById(`btn-${id}`);
    },

    tabFromHash() {
      const id = String(location.hash || '').replace(/^#/, '');
      return this.isValidTab(id) ? id : null;
    },

    // Which tab a fresh page load lands on. The hash wins because it is
    // per-browser-tab state; localStorage is only the fallback for a tab
    // opened without one (a bookmark to bare /erp, or the first load after
    // this shipped).
    //
    // localStorage used to decide this alone, which broke having two tabs
    // open on two modules: the key is shared by every tab on the origin, so
    // whichever module was clicked most recently *anywhere* overwrote it and
    // both tabs then snapped to that module on their next reload, losing
    // whatever the other one was parked on.
    resolveInitialTab() {
      const fromHash = this.tabFromHash();
      if (fromHash) return fromHash;
      let stored = null;
      try { stored = localStorage.getItem(this.LAST_TAB_KEY); } catch (e) { /* storage inaccessible */ }
      return this.isValidTab(stored) ? stored : 'dashboardTab';
    },

    // Keeps the URL in step with the visible tab. `replace` is for the
    // initial restore, which shouldn't leave a synthetic entry sitting
    // behind the user's first Back press. Writing through the history API
    // rather than assigning location.hash deliberately fires no hashchange,
    // so this never re-enters showTab.
    syncHash(id, replace) {
      const target = `#${id}`;
      if (location.hash === target) return;
      try {
        history[replace ? 'replaceState' : 'pushState'](null, '', target);
      } catch (e) {
        location.hash = id; // history API unavailable (sandboxed iframe, file://)
      }
    },

    // Back/forward between tabs lands here, as does a hand-edited hash.
    // showTab's own syncHash call is a no-op by then (the hash already
    // matches), so this adds no history entry of its own.
    handleHashChange() {
      const id = this.tabFromHash();
      if (!id || id === this.current) return;
      this.showTab(id);
    },

    showTab(id, opts) {
      $$('.tab-content').forEach(tab => {
        tab.style.display = tab.id === id ? 'block' : 'none';
      });

      // aria-selected and roving tabindex, not just the visual class
      // (A11Y-001). The markup ships aria-selected="true" on the Dashboard
      // button and nothing ever changed it, so a screen reader announced
      // "Dashboard, selected" on every tab of the application no matter what
      // was actually on screen -- the one piece of state a tablist exists to
      // convey was permanently wrong.
      //
      // tabindex moves with it (the roving-tabindex pattern): a tablist
      // should be ONE stop in the page's tab order, with the arrow keys
      // moving between tabs. Leaving all 14 focusable meant tabbing to the
      // content took 14 presses, which is what the skip link had to work
      // around.
      $$('#mainTabs .nav-link').forEach(btn => {
        const selected = btn.id === `btn-${id}`;
        btn.classList.toggle('active', selected);
        btn.setAttribute('aria-selected', selected ? 'true' : 'false');
        btn.setAttribute('tabindex', selected ? '0' : '-1');
      });

      this.current = id;
      this.syncHash(id, !!(opts && opts.replace));
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
      } else if (id === 'activityTab' && typeof App.Activity !== 'undefined') {
        loadPromise = App.Activity.loadData();
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
  async Init(targetTab, opts) {
    // Load persisted company logo and notification history (non-blocking,
    // best-effort).
    this.Logo.load();
    if (this.Notify) this.Notify.load();

    const promises = [App.Navigation.showTab(targetTab || 'dashboardTab', opts)];

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
      // Dashboard delegates. These replace inline onclick handlers that
      // interpolated an id straight into a JS string literal
      // (onclick="...openPipelineStage('${escapeHtml(id)}')") -- escapeHtml
      // escapes for HTML, not for a JS string, so any process/product id
      // containing an apostrophe broke the handler outright.
      case 'dash-pipeline-stage':
        App.Dashboard.openPipelineStage(decodeURIComponent(btn.dataset.processid || ''));
        break;
      case 'dash-dispatch-product':
        App.Dashboard.openDispatchFor(decodeURIComponent(btn.dataset.productid || ''));
        break;
      case 'dash-new-dispatch':
        App.Dashboard.openNewDispatch();
        break;
      case 'dash-retry':
        App.Dashboard.loadData();
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
      // Activity Log (AUDIT-001). Guarded on App.Activity existing: the
      // module's <script> tag is admin-only, so for everyone else these
      // actions never render in the first place -- but a stale cached shell
      // could still carry the markup, and a TypeError here would break every
      // other delegated action on the page, not just this one.
      case 'activity-page':
        if (typeof App.Activity !== 'undefined') App.Activity.changePage(toNumber(btn.dataset.page, 1));
        break;
      case 'activity-refresh':
        if (typeof App.Activity !== 'undefined') App.Activity.loadData();
        break;
      case 'activity-clear':
        if (typeof App.Activity !== 'undefined') App.Activity.clearFilters();
        break;
      case 'activity-detail':
        if (typeof App.Activity !== 'undefined') App.Activity.openDetail(btn.dataset.id);
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

  // Before anything that can fail: a Google-only account has a limited
  // window to set a password, and it closes when the internet does.
  App.OfflinePassword.init();

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
  // it) instead of every module's. resolveInitialTab reads the URL hash
  // first and only falls back to localStorage, which is what lets two
  // browser tabs sit on two different modules across a reload -- see its
  // comment for the cross-tab clobbering that caused.
  //
  // Back/forward between tabs arrives as a hashchange; registering before
  // Init means a hash typed or restored mid-boot isn't missed. {replace:
  // true} keeps this first write out of the history stack, so Back leaves
  // the app instead of bouncing off a synthetic entry.
  window.addEventListener('hashchange', () => App.Navigation.handleHashChange());

  // Arrow-key navigation for the sidebar tablist (A11Y-003).
  //
  // role="tablist" is a promise about keyboard behaviour, not only a label:
  // assistive technology tells the user the arrow keys move between tabs,
  // because that is what the role means. Here they did nothing, so a
  // screen-reader user was told to press a key that had no effect.
  //
  // Home/End included because they are part of the same pattern, and cheap.
  // Vertical keys first (this list is a column) but horizontal ones work
  // too, since the same list becomes a horizontal bar on narrow screens.
  document.getElementById('mainTabs')?.addEventListener('keydown', (e) => {
    const keys = ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(e.key)) return;

    // Every rendered nav-link. No visibility filtering: the sidebar is
    // server-rendered per role, so a tab the user may not open is not in the
    // DOM at all -- and `current === -1` below already covers focus being
    // somewhere else entirely.
    const tabs = Array.from(document.querySelectorAll('#mainTabs .nav-link'))
      .filter(btn => !btn.disabled && !btn.hasAttribute('hidden'));
    if (!tabs.length) return;

    const current = tabs.indexOf(document.activeElement);
    if (current === -1) return;

    let next;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (current + 1) % tabs.length;
    else next = (current - 1 + tabs.length) % tabs.length;

    e.preventDefault();
    // Move focus only. Activating on arrow would load a module's data on
    // every keypress while someone is simply moving through the list --
    // Enter and Space (which a <button> handles natively) activate.
    tabs[next].focus();
  });

  await App.Init(App.Navigation.resolveInitialTab(), { replace: true });

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
