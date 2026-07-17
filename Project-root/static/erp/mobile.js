'use strict';
// mobile.js -- MApp, ported from Apps_Script/Mobile_Script.html.
//
// Own MApp namespace, sharing nothing with desktop's App except the
// Api.call/Api.mutate wrapper (api.js, already shared with desktop) and
// the print.html templates (App.Print.trigger's desktop implementation
// isn't reused directly -- MApp.Print below is its own small port of the
// same trigger(containerId, documentTitle) contract, since the desktop
// App.Print also tracks a CONTAINER_IDS hideAll() list and a companyLogo
// injectLogo() step that source's own Mobile_Script.html MApp.Print
// deliberately doesn't replicate -- ported faithfully to that narrower
// scope, not upgraded to match desktop's).
//
// Structure: MApp.Api / MApp.Toast / MApp.Util / MApp.Shell / MApp.Sheet /
// MApp.Picker are the shared engine; MApp.Home / MApp.Stock / MApp.Production /
// MApp.Dispatch / MApp.Returns / MApp.Items / MApp.PO / MApp.Bill /
// MApp.Directory / MApp.More are one module per tab/feature, each with a
// mount() called by MApp.Shell.showTab().
//
// Round M1 (Shell + Home) ships only MApp.Home for real. Every other
// screen's <template id="tpl-*"> and sheet markup already shipped in full
// (templates/erp/partials/mobile_views.html) -- MApp.Shell.showTab()'s own
// `mod && typeof mod.mount === 'function'` guard already makes tapping an
// unported tab safely show its static skeleton and stop there, exactly
// mirroring desktop's `typeof App.X !== 'undefined'` guard. The one gap
// that guard doesn't cover: a handful of onclick handlers baked directly
// into that markup (Production/Dispatch's FABs, the More tab's Returns/PO
// Ledger/Bill Ledger/Items lookup/Directory action rows) call straight
// into a not-yet-ported module's method, bypassing showTab entirely. The
// small stub objects at the bottom of this file are exactly those methods
// -- nothing more -- each showing a "coming soon" toast instead of
// throwing. Each stub is deleted (not extended) the round its real module
// ships, same "guard now, activate later" spirit as desktop's
// notPortedYet(), applied per-module here since MApp has no central
// Navigation.showTab guard table.
const MApp = {};

// ================================================================
// GAS API WRAPPER — source's own MApp.Api was `{ call: _apiCall }`,
// a single verb, because google.script.run needed no CSRF token or
// per-mutation idempotency key. This Flask backend's RPC bridge does
// (see api.js's own header) via Api.call (read) vs Api.mutate (write) --
// so MApp.Api exposes both, and every mutating MApp.*.save()/submit*()
// call below uses .mutate, not .call, unlike source's single _apiCall.
// ================================================================
MApp.Api = { call: Api.call, mutate: Api.mutate };

// ================================================================
// TOAST
// ================================================================
MApp.Toast = {
  show(message, type) {
    const stack = document.getElementById('mapp-toast-stack');
    if (!stack) return;
    const el = document.createElement('div');
    el.className = 'mb-toast' + (type === 'error' ? ' mb-toast-error' : type === 'success' ? ' mb-toast-success' : '');
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => {
      el.remove();
    }, type === 'error' ? 4200 : 2600);
  },
  success(message) { this.show(message, 'success'); },
  error(message) { this.show(message, 'error'); }
};

// ================================================================
// SHARED UTILITIES
// ================================================================
MApp.Util = {
  escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  toNumber(val) {
    const n = parseFloat(val);
    return isNaN(n) ? 0 : n;
  },

  // For a date input's default value / server payload — local YYYY-MM-DD,
  // not toISOString() (which shifts to UTC and can land on the wrong day).
  todayInputValue() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  },

  // dateRaw is an ISO timestamp string (see getProductionData/getDispatchData)
  formatDateDisplay(dateRaw) {
    if (!dateRaw) return '—';
    const d = new Date(dateRaw);
    if (isNaN(d.getTime())) return '—';
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${d.getDate()} ${months[d.getMonth()]}`;
  },

  isToday(dateRaw) {
    if (!dateRaw) return false;
    return String(dateRaw).slice(0, 10) === this.todayInputValue();
  },

  debounce(fn, wait) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  },

  // Renders `count` skeleton cards into a container while a load() is in flight.
  renderSkeleton(container, count) {
    if (!container) return;
    container.innerHTML = Array.from({ length: count || 3 })
      .map(() => '<div class="mb-skel mb-skel-card"></div>')
      .join('');
  },

  // icon defaults to a simple inbox glyph — good enough for every empty state
  // in this app; body copy is what actually varies per screen.
  renderEmpty(container, { title, body }) {
    if (!container) return;
    container.innerHTML = `
      <div class="mb-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l1.5-5h15L21 9"/><path d="M3 9h18v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9z"/><path d="M9 13a3 3 0 0 0 6 0"/></svg>
        <div class="mb-state-title">${this.escapeHtml(title)}</div>
        <div class="mb-state-body">${this.escapeHtml(body)}</div>
      </div>`;
  },

  // The "no connection — retry" state required for every list load failure.
  renderError(container, message, onRetry) {
    if (!container) return;
    container.innerHTML = `
      <div class="mb-state mb-state-error">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>
        <div class="mb-state-title">No connection</div>
        <div class="mb-state-body">${this.escapeHtml(message || "Couldn't reach the server. Check your connection and try again.")}</div>
        <button type="button" class="mb-state-retry">Retry</button>
      </div>`;
    const btn = container.querySelector('.mb-state-retry');
    if (btn && typeof onRetry === 'function') btn.addEventListener('click', onRetry);
  },

  // Disables/enables every input, select, textarea and button inside a
  // sheet body + swaps the footer save button's label — the "hard-disable
  // the whole form" requirement, so a fast-tapping operator can never
  // trigger a second overlapping save.
  setSheetBusy(sheetBodyId, saveBtnId, isBusy, busyLabel, idleLabel) {
    const body = document.getElementById(sheetBodyId);
    if (body) {
      body.querySelectorAll('input, select, textarea, button').forEach(el => {
        el.disabled = isBusy;
      });
    }
    const btn = document.getElementById(saveBtnId);
    if (btn) {
      btn.disabled = isBusy;
      btn.textContent = isBusy ? (busyLabel || 'Saving…') : (idleLabel || btn.dataset.idleLabel || btn.textContent);
      if (!isBusy && idleLabel) btn.dataset.idleLabel = idleLabel;
    }
  },

  statusChipClass(status) {
    switch (String(status || '').trim()) {
      case 'Pending': return 'mb-chip-pending';
      case 'In Progress': return 'mb-chip-inprogress';
      case 'Completed': return 'mb-chip-completed';
      case 'Cancelled': return 'mb-chip-cancelled';
      // PO status (module_po.js#_attachPoStatus, mirrored client-side as
      // the shared PO_STATUS constant in api.js) reuses this same chip
      // set rather than adding new colors -- blue for issued (mirrors
      // desktop's bg-primary), amber for partial (an "in-between, needs
      // attention" cue; desktop uses bg-info/cyan, but that hue has no
      // chip here yet). PO_STATUS.COMPLETED already matches the
      // 'Completed' case above, shared with Production's own status.
      case PO_STATUS.ISSUED: return 'mb-chip-inprogress';
      case PO_STATUS.PARTIAL: return 'mb-chip-pending';
      default: return '';
    }
  },

  // Mirrors App.Production.formatQty() on desktop -- round to 4dp then
  // strip trailing zeros via the Number()->toString() round-trip, so
  // quantities never show binary-float noise like "3.0000000000000004".
  formatQty(value) {
    const n = this.toNumber(value);
    return Number(n.toFixed(4)).toString();
  },

  // Mirrors formatCurrency() on desktop.
  formatCurrency(value) {
    return `₹${this.toNumber(value).toFixed(2)}`;
  }
};

// ================================================================
// SHELL — tab routing. Each tab root is a <template id="tpl-*"> in
// mobile_views.html, cloned fresh into #mapp-content on every visit so a
// tab always starts from its skeleton state rather than stale DOM.
// ================================================================
MApp.Shell = {
  TABS: ['home', 'stock', 'production', 'dispatch', 'more'],
  TITLES: { home: 'Home', stock: 'Stock', production: 'Production', dispatch: 'Dispatch', more: 'More' },
  current: null,

  init() {
    this.showTab('home');
  },

  showTab(tab) {
    if (this.TABS.indexOf(tab) === -1) return;
    this.current = tab;

    const titleEl = document.getElementById('mapp-topbar-title');
    if (titleEl) titleEl.textContent = this.TITLES[tab];

    this.TABS.forEach(t => {
      const btn = document.getElementById('mapp-tab-' + t);
      if (!btn) return;
      const active = t === tab;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
    });

    const content = document.getElementById('mapp-content');
    const tpl = document.getElementById('tpl-' + tab);
    if (content) {
      content.innerHTML = '';
      if (tpl) content.appendChild(tpl.content.cloneNode(true));
      content.scrollTop = 0;
    }

    const moduleName = tab.charAt(0).toUpperCase() + tab.slice(1);
    const mod = MApp[moduleName];
    if (mod && typeof mod.mount === 'function') mod.mount();
  }
};

// ================================================================
// SHEET — full-screen form overlays (Log Lot, New Dispatch, ...)
// ================================================================
MApp.Sheet = {
  _stack: [],

  open(sheetId) {
    const backdrop = document.getElementById('mapp-sheet-backdrop');
    const sheet = document.getElementById(sheetId);
    if (!sheet) return;
    if (backdrop) backdrop.classList.add('open');
    sheet.classList.add('open');
    document.body.style.overflow = 'hidden';
    this._stack.push(sheetId);
  },

  close(sheetId) {
    const sheet = document.getElementById(sheetId);
    if (sheet) sheet.classList.remove('open');
    this._stack = this._stack.filter(id => id !== sheetId);
    if (this._stack.length === 0) {
      const backdrop = document.getElementById('mapp-sheet-backdrop');
      if (backdrop) backdrop.classList.remove('open');
      document.body.style.overflow = '';
    }
  }
};

// ================================================================
// PICKER — generic full-screen searchable picker (replaces Select2).
// Usage: const picked = await MApp.Picker.open({ title, items }); items:
// [{ value, label, sublabel }]. Resolves the chosen item, or null if
// dismissed.
// ================================================================
MApp.Picker = {
  _resolve: null,
  _items: [],
  _selectedValue: null,

  open({ title, items, selectedValue, searchable = true, allowCustom = false }) {
    return new Promise(resolve => {
      this._resolve = resolve;
      this._items = items || [];
      this._selectedValue = selectedValue;
      this._allowCustom = allowCustom;

      const titleEl = document.getElementById('mapp-picker-title');
      if (titleEl) titleEl.textContent = title || 'Choose';

      const searchWrap = document.getElementById('mapp-picker-search-wrap');
      const searchInput = document.getElementById('mapp-picker-search');
      if (searchWrap) searchWrap.style.display = searchable ? '' : 'none';
      if (searchInput) searchInput.value = '';

      this._renderList(this._items, '');
      MApp.Sheet.open('mapp-picker-sheet');

      if (searchable && searchInput) {
        setTimeout(() => searchInput.focus(), 280);
      }
    });
  },

  onSearch(term) {
    const lower = String(term || '').toLowerCase();
    const filtered = !lower ? this._items : this._items.filter(i =>
      String(i.label || '').toLowerCase().includes(lower) ||
      String(i.sublabel || '').toLowerCase().includes(lower));
    this._renderList(filtered, term || '');
  },

  _renderList(items, term) {
    const list = document.getElementById('mapp-picker-list');
    if (!list) return;

    // Free-text option: offered whenever allowCustom is set and the typed
    // term doesn't already exactly match an existing option — lets
    // "Assigned To" take an in-house name with no Contractor Master entry,
    // same as desktop's Select2 tags:true behavior.
    const trimmedTerm = String(term || '').trim();
    const exactMatch = trimmedTerm && (items || []).some(i => String(i.label || '').toLowerCase() === trimmedTerm.toLowerCase());
    const showCustomOption = this._allowCustom && trimmedTerm && !exactMatch;

    if ((!items || items.length === 0) && !showCustomOption) {
      MApp.Util.renderEmpty(list, { title: 'No matches', body: 'Try a different search term.' });
      return;
    }

    list.innerHTML = '';

    if (showCustomOption) {
      const customBtn = document.createElement('button');
      customBtn.type = 'button';
      customBtn.className = 'mb-picker-option';
      customBtn.style.color = 'var(--mb-safety)';
      customBtn.style.fontWeight = '700';
      customBtn.textContent = `Use "${trimmedTerm}"`;
      customBtn.addEventListener('click', () => {
        MApp.Sheet.close('mapp-picker-sheet');
        const resolve = this._resolve;
        this._resolve = null;
        if (resolve) resolve({ value: trimmedTerm, label: trimmedTerm, isCustom: true });
      });
      list.appendChild(customBtn);
    }

    (items || []).forEach(item => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mb-picker-option' + (item.value === this._selectedValue ? ' selected' : '');
      const sub = item.sublabel
        ? `<br><span class="mb-text-sm mb-text-steel">${MApp.Util.escapeHtml(item.sublabel)}</span>`
        : '';
      btn.innerHTML = `<span>${MApp.Util.escapeHtml(item.label)}${sub}</span>`;
      btn.addEventListener('click', () => {
        MApp.Sheet.close('mapp-picker-sheet');
        const resolve = this._resolve;
        this._resolve = null;
        if (resolve) resolve(item);
      });
      list.appendChild(btn);
    });
  },

  cancel() {
    MApp.Sheet.close('mapp-picker-sheet');
    const resolve = this._resolve;
    this._resolve = null;
    if (resolve) resolve(null);
  }
};

// ================================================================
// PRINT — shows the one requested #print-*-container (reused as-is from
// print.html, the same templates desktop's App.Print populates), calls
// window.print(), restores on 'afterprint'.
// ================================================================
MApp.Print = {
  trigger(containerId, documentTitle) {
    document.querySelectorAll('[id^="print-"]').forEach(el => {
      el.classList.remove('active-print');
      el.style.display = 'none';
    });

    const container = document.getElementById(containerId);
    if (container) {
      container.classList.add('active-print');
      container.style.display = 'block';
    }

    const originalTitle = document.title;
    document.title = documentTitle || originalTitle;

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      document.title = originalTitle;
      if (container) {
        container.classList.remove('active-print');
        container.style.display = 'none';
      }
      window.removeEventListener('afterprint', cleanup);
    };

    window.addEventListener('afterprint', cleanup);
    window.print();
    setTimeout(cleanup, 1000);
  }
};

// Cross-tab one-shot pre-filters set by Home's stat tiles, consumed and
// cleared by the target tab's own mount().
MApp.State = {
  stockFilter: '',
  productionFilter: '',
  dispatchFilter: '',
  lastDashboard: null // cached getMobileDashboard() payload, reused by the More tab's About row
};

// ================================================================
// HOME
// ================================================================
MApp.Home = {
  async mount() {
    const statsEl = document.getElementById('home-stats');
    const activityEl = document.getElementById('home-activity');

    try {
      const res = await MApp.Api.call('getMobileDashboard');
      if (!res || !res.success) {
        MApp.Util.renderError(statsEl, res && res.message, () => this.mount());
        if (activityEl) activityEl.innerHTML = '';
        return;
      }
      MApp.State.lastDashboard = res.data || {};
      this.render(res.data || {});
    } catch (err) {
      MApp.Util.renderError(statsEl, err && err.message, () => this.mount());
      if (activityEl) activityEl.innerHTML = '';
    }
  },

  render(data) {
    const statsEl = document.getElementById('home-stats');
    if (statsEl) {
      const lowStock = data.lowStockCount || 0;
      statsEl.innerHTML = `
        <button type="button" class="mb-stat-tile" onclick="MApp.Home.goTo('production')">
          <div class="mb-stat-tile-label">Pending production</div>
          <div class="mb-stat-tile-value">${data.pendingProductionCount || 0}</div>
        </button>
        <button type="button" class="mb-stat-tile" onclick="MApp.Home.goTo('dispatch')">
          <div class="mb-stat-tile-label">Today's dispatches</div>
          <div class="mb-stat-tile-value">${data.todaysDispatchCount || 0}</div>
        </button>
        <button type="button" class="mb-stat-tile" style="grid-column:1 / -1;" onclick="MApp.Home.goTo('stock')">
          <div class="mb-stat-tile-label">Low-stock alerts</div>
          <div class="mb-stat-tile-value${lowStock > 0 ? ' mb-alert' : ''}">${lowStock}</div>
        </button>`;
    }

    const activityEl = document.getElementById('home-activity');
    if (activityEl) {
      const activity = data.recentActivity || [];
      if (activity.length === 0) {
        MApp.Util.renderEmpty(activityEl, {
          title: 'No activity yet',
          body: 'Production lots and dispatches will show up here as they happen.'
        });
      } else {
        activityEl.innerHTML = activity.map(a => `
          <div class="mb-card">
            <div class="mb-card-row">
              <span class="mb-card-title">${MApp.Util.escapeHtml(a.title)}</span>
              <span class="mb-text-sm mb-text-steel">${MApp.Util.formatDateDisplay(a.dateRaw)}</span>
            </div>
            <div class="mb-card-sub">${MApp.Util.escapeHtml(a.subtitle)}</div>
          </div>
        `).join('');
      }
    }
  },

  goTo(tab) {
    if (tab === 'production') MApp.State.productionFilter = 'pending';
    if (tab === 'dispatch') MApp.State.dispatchFilter = 'today';
    if (tab === 'stock') MApp.State.stockFilter = 'lowstock';
    MApp.Shell.showTab(tab);
  }
};

// ================================================================
// NOT-YET-PORTED STUBS — see this file's header comment. Each is exactly
// the one method the static mobile_views.html markup calls directly
// (FABs / More-tab action rows), nothing more. Deleted (not extended)
// the round its real module ships.
// ================================================================
// MApp.Stock has no mount(), so showTab('stock') safely stops at its
// static skeleton for every part of the screen except the search input --
// that renders immediately as part of the skeleton (not injected by a
// mount() call), so it's reachable the instant a user taps the Stock tab.
// A silent no-op (not a toast) avoids spamming one toast per keystroke.
MApp.Stock = { onSearch() {} };
MApp.Production = { openLogLotSheet() { MApp.Toast.error('Log Lot is coming soon.'); } };
MApp.Dispatch = { openNewDispatchSheet() { MApp.Toast.error('New Dispatch is coming soon.'); } };
MApp.Returns = { openNewReturnSheet() { MApp.Toast.error('Log Return is coming soon.'); } };
MApp.PO = { openLedgerSheet() { MApp.Toast.error('PO Ledger is coming soon.'); } };
MApp.Bill = { openLedgerSheet() { MApp.Toast.error('Bill Ledger is coming soon.'); } };
MApp.Items = { openLookupSheet() { MApp.Toast.error('Items lookup is coming soon.'); } };
MApp.Directory = { open() { MApp.Toast.error('Directory is coming soon.'); } };

// ================================================================
// BOOT
// ================================================================
document.addEventListener('DOMContentLoaded', () => {
  MApp.Shell.init();
});
