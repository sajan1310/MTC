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
    globalItems: []
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
