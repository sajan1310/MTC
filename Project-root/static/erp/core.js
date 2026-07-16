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

  State: {
    confirmCallback: null
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
