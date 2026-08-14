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
// All ten modules (Home, Stock, Production, Dispatch, Returns, Items, PO,
// Bill, Directory, More) are now shipped for real -- MApp.Shell.showTab()'s
// `mod && typeof mod.mount === 'function'` guard remains in place purely
// as a defensive mirror of desktop's `typeof App.X !== 'undefined'` guard,
// same "guard now, activate later" spirit as desktop's notPortedYet(), in
// case a module is ever pulled during a future round.
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

// ── OFFLINE READ CACHE (Phase 6 Round 1) ────────────────────────────
// callCached(method) is for the small, deliberately short list of
// read-only, zero-argument calls a field worker is likely to want a
// glance at even with no signal (see offline-cache.js's own header for
// why this is a plain "last known good" cache, not a true delta-sync
// system). It is NOT a replacement for MApp.Api.call -- most calls
// should still use .call directly; only Home/Stock's own load paths use
// this. A network-level failure (the fetch itself rejecting) falls back
// to the last cached response, tagged with _offlineCachedAt so the
// caller can show a staleness banner; a normal {success:false} business
// response is returned as-is and never triggers the cache fallback,
// since that's a real answer from a reachable server, not an outage.
MApp.Api.callCached = async function (method) {
  try {
    const res = await Api.call(method);
    OfflineCache.put(method, res); // fire-and-forget
    return res;
  } catch (err) {
    const cached = await OfflineCache.get(method);
    if (cached) {
      return { ...cached.response, _offlineCachedAt: cached.cachedAt };
    }
    throw err;
  }
};

// ── OFFLINE OUTBOX + REPLAY (Phase 6 Round 3) ───────────────────────
// Round 3 scoped this to exactly one mutation (adjustStockManually) --
// the one whose payload is plain strings/numbers, not a server row ID
// that could go stale by replay time. Now extended to all 5: a stale
// reference (a deleted process, a product no longer ready to dispatch)
// was never actually a correctness gap in this design -- it just
// surfaces as an ordinary {success:false} business rejection on replay,
// which the markFailed branch below already handles fine (keeps the
// entry, records the real server message, stops retrying it, and lets
// the rest of the queue continue). No mutation needed special-casing.
//
// The badge lives on the More tab (not per-mutation-type) since outbox
// entries can now come from 5 different screens -- one place to check
// "is anything unsynced" beats duplicating badge logic 4-5 times.
MApp.Outbox = {
  _flushing: false,

  async flush() {
    if (this._flushing) return;
    this._flushing = true;

    try {
      const pending = await OfflineCache.outbox.listPending();
      for (const entry of pending) {
        let res;
        try {
          res = await Api.mutateWithId(entry.method, entry.mutationId, ...entry.args);
        } catch (err) {
          if (err && err.isNetworkError) {
            // Still offline (or reconnected only briefly) -- stop here,
            // leave this and every remaining entry pending for next time.
            break;
          }
          // A real HTTP-level failure (e.g. a CSRF token that expired
          // since this was queued -- a real risk for a replay that could
          // happen hours or days later via Background Sync, not just a
          // quick reconnect). Not safe to retry blindly forever: mark it
          // failed (visible in Sync Issues, retryable there with a fresh
          // token once the page is open again) and move on to the rest
          // of the queue, same as an ordinary {success:false} below.
          await OfflineCache.outbox.markFailed(entry.id, err.message);
          continue;
        }

        if (res && res.success) {
          await OfflineCache.outbox.markDone(entry.id);
        } else {
          // A real, reachable-server rejection (e.g. a stale reference) --
          // stop retrying this one, but don't let it block the rest of
          // the queue.
          await OfflineCache.outbox.markFailed(entry.id, res && res.message);
        }
      }
    } finally {
      this._flushing = false;
      this.updateBadge();
      if (typeof MApp.SyncIssues !== 'undefined') MApp.SyncIssues.updateSummary();
      this._refreshCurrentTab();
    }
  },

  async updateBadge() {
    const badge = document.getElementById('mapp-tab-more-badge');
    if (!badge) return;
    const count = await OfflineCache.outbox.countPendingAndFailed();
    if (count > 0) {
      badge.textContent = count > 9 ? '9+' : String(count);
      badge.classList.remove('mb-hidden');
    } else {
      badge.classList.add('mb-hidden');
    }
  },

  // Provisional-ID reconciliation: once a flush pass finishes, whatever
  // tab the user currently has open should stop showing its "N waiting
  // to sync" banner for anything that just replayed. Only refreshes the
  // CURRENTLY VISIBLE tab (via MApp.Shell.current, the same module-name
  // derivation MApp.Shell.showTab itself uses) -- a tab the user isn't
  // looking at will pick up the accurate count next time they visit it
  // (mount()/openLedgerSheet() re-checks), so there's no need to eagerly
  // refresh screens off-screen.
  _refreshCurrentTab() {
    MApp.Shell.refreshCurrentTab();
  },

  // ── Background Sync (Phase 6 Item 4) ──────────────────────────────
  // Everything above already works with no browser support for this --
  // the 'online' listener and the boot-time flush() call are the
  // fallback and always run first while the app is open. This is
  // strictly additive: it lets a queued mutation replay even after the
  // tab is closed, once the browser decides connectivity is back.
  _registration: null,

  async initBackgroundSync() {
    if (!('serviceWorker' in navigator)) return;
    try {
      // navigator.serviceWorker.ready resolves once a worker is ACTIVE
      // for this scope, regardless of whether this specific register()
      // call installed it (e.g. a second tab reusing an existing
      // registration) -- the right thing to wait on either way, since
      // mobile-sw.js calls skipWaiting()/clients.claim() itself.
      const registration = await navigator.serviceWorker.ready;
      this._registration = registration;
      this._sendCsrfToken(registration);
      this.requestSync();
    } catch (e) {
      // Non-fatal -- the foreground online/boot flush still works.
    }
  },

  // A service worker has no `document` to read the CSRF meta tag from
  // (see api.js's _csrfToken()) -- hand it the page's own token instead.
  // This is necessarily a point-in-time snapshot: if the page has been
  // open for over an hour (Flask-WTF's default WTF_CSRF_TIME_LIMIT),
  // this token may itself already be stale. That's fine -- a stale
  // token now surfaces as an ordinary isHttpError failure (markFailed,
  // visible in Sync Issues, retryable once the page is reloaded and a
  // fresh token is sent) instead of looping forever, which is exactly
  // the failure mode the error-classification fix above exists for.
  _sendCsrfToken(registration) {
    if (!registration.active) return;
    const meta = document.querySelector('meta[name="csrf-token"]');
    registration.active.postMessage({ type: 'csrf-token', token: meta ? meta.getAttribute('content') : '' });
  },

  // Arms a one-shot Background Sync event for the SW to pick up the
  // outbox next time the browser regains connectivity, even if this tab
  // has since closed. Best-effort and silently a no-op where
  // unsupported (Safari, Firefox as of writing) -- those browsers rely
  // entirely on the foreground 'online'/boot flush() above.
  requestSync() {
    const registration = this._registration;
    if (!registration || !('sync' in registration)) return;
    registration.sync.register('outbox-flush').catch(() => {});
  }
};

// The service worker notifies open pages after it replays the outbox in
// the background (see mobile-sw.js's 'sync' handler) so this tab's badge
// and any visible list reflect it immediately instead of only on next
// visit/reload.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data && event.data.type === 'outbox-flushed') {
      MApp.Outbox.updateBadge();
      if (typeof MApp.SyncIssues !== 'undefined') MApp.SyncIssues.updateSummary();
      MApp.Outbox._refreshCurrentTab();
    }
  });
}

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
// HAPTICS — best-effort tactile feedback for tab switches, pull-to-
// refresh, and sheet dismissal. navigator.vibrate is Android-only (no-op
// on iOS Safari, which has no web vibration API); every call site treats
// it as a nice-to-have, never a requirement.
// ================================================================
MApp.Haptics = {
  _supported: typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function',
  light() { if (this._supported) navigator.vibrate(8); },
  success() { if (this._supported) navigator.vibrate([12, 40, 12]); }
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

  // Display casing for name-like fields (Assigned By/To, contractor/client
  // names) -- same rule as core.js's App.Utils.formatNameCase, duplicated
  // here since this page never loads core.js. Display-only.
  formatNameCase(str) {
    const s = String(str == null ? '' : str).trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;
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
  },

  // Phase 6 Round 1 -- the "you're looking at cached data" banner shown
  // when MApp.Api.callCached() fell back to IndexedDB. Reuses the
  // .mb-offline-banner class (already styled, previously only used for
  // the "low-stock filter active" notice). grid-column:1/-1 is a no-op
  // outside a CSS grid parent (Stock's list is plain block flow) and
  // makes it span full-width as the first item inside Home's .mb-stat-grid.
  offlineBannerHtml(cachedAtMs) {
    return `
      <div class="mb-offline-banner" style="grid-column:1 / -1;">
        <span>Showing data from ${this.relativeTime(cachedAtMs)} — you're offline</span>
      </div>`;
  },

  relativeTime(ms) {
    const diffSec = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (diffSec < 60) return 'just now';
    const diffMin = Math.round(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    return `${Math.round(diffHr / 24)}d ago`;
  },

  // Phase 6 (provisional-ID reconciliation, lightweight version) -- "N
  // still waiting to sync" banner, shown by each of the 5 screens with a
  // queueable action when OfflineCache.outbox.countPendingForMethod(...)
  // is > 0. Reuses .mb-offline-banner's shape but overrides to the
  // enamel-blue "in progress" tone (not red) -- this isn't a problem,
  // it's a normal queued-and-will-sync state, same distinction the app
  // already draws between statusChipClass's blue "In Progress" and red
  // "Cancelled". Deliberately a count banner, not a fabricated list
  // card per queued record -- rendering a fully realistic optimistic
  // card in 5 differently-shaped lists (and reconciling each one away
  // individually once synced) is a larger, riskier undertaking than the
  // actual ask here: don't let a queued save go invisible.
  pendingSyncBannerHtml(count, singular, plural) {
    const noun = count === 1 ? singular : (plural || `${singular}s`);
    return `
      <div class="mb-offline-banner" style="background:var(--mb-enamel-blue-bg);color:var(--mb-enamel-blue);grid-column:1 / -1;">
        <span>${count} ${noun} waiting to sync</span>
      </div>`;
  },

  // ── Master-data CRUD helpers (Phase 1+) ─────────────────────────────
  // Shared "fire a mutation, toast the server's message on failure" flow
  // for the growing set of master-data writes that don't need offline-
  // outbox queuing -- unlike the shop-floor actions (Log Lot, Dispatch,
  // Return, PO, Stock Adjust), these are ordinarily done with a normal
  // connection, so a network failure here is just a retryable error, not
  // something to queue for a later background sync. `args` is the
  // positional argument list Api.mutateWithId forwards as-is (most of
  // these RPCs take a single form_data object; a few, like deleteItem,
  // take multiple plain args).
  async mutateSimple(method, args, successMsg) {
    try {
      const res = await Api.mutateWithId(method, Api.newMutationId(), ...args);
      if (!res || !res.success) {
        MApp.Toast.error((res && res.message) || 'Could not save. Please try again.');
        return res || { success: false };
      }
      if (successMsg) MApp.Toast.success(successMsg);
      return res;
    } catch (err) {
      MApp.Toast.error(err.message || 'Could not reach the server. Please try again.');
      return { success: false, _networkError: true };
    }
  },

  // A native confirm() is a deliberately small choice here -- every other
  // destructive action in this app is a single record a user just opened
  // and is looking straight at, so a blocking browser prompt costs one
  // extra tap without needing a whole styled sheet component for it.
  confirmDelete(label) {
    return window.confirm(`Delete ${label}? This can't be undone.`);
  },

  // Client-side downscale before an item photo goes into a base64
  // itemImage payload (saveItem enforces a 3MB cap server-side) -- mirrors
  // desktop's own client-side resize (items.js) so a full-resolution phone
  // photo doesn't blow past it.
  resizeImageToBase64(file, maxDim) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error('Could not read that file.'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('That file is not a readable image.'));
        img.onload = () => {
          let { width, height } = img;
          if (width > maxDim || height > maxDim) {
            const scale = maxDim / Math.max(width, height);
            width = Math.round(width * scale);
            height = Math.round(height * scale);
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          canvas.getContext('2d').drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
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
  LAST_TAB_KEY: 'maharaja-erp-mobile-last-tab',
  current: null,

  init() {
    let lastTab = null;
    try { lastTab = localStorage.getItem(this.LAST_TAB_KEY); } catch (e) { /* storage inaccessible */ }
    this.showTab(this.TABS.indexOf(lastTab) > -1 ? lastTab : 'home');
  },

  showTab(tab) {
    if (this.TABS.indexOf(tab) === -1) return;
    const changed = tab !== this.current;
    this.current = tab;
    try { localStorage.setItem(this.LAST_TAB_KEY, tab); } catch (e) { /* storage inaccessible */ }

    const titleEl = document.getElementById('mapp-topbar-title');
    if (titleEl) titleEl.textContent = this.TITLES[tab];

    const idx = this.TABS.indexOf(tab);
    this.TABS.forEach(t => {
      const btn = document.getElementById('mapp-tab-' + t);
      if (!btn) return;
      const active = t === tab;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
    });
    const indicator = document.getElementById('mapp-tab-indicator');
    if (indicator) indicator.style.transform = `translateX(${idx * 100}%)`;

    const topbar = document.querySelector('.mapp-topbar');
    if (topbar) topbar.classList.remove('mapp-elevated');

    const content = document.getElementById('mapp-content');
    const tpl = document.getElementById('tpl-' + tab);
    if (content) {
      content.classList.remove('mapp-screen-enter');
      content.innerHTML = '';
      if (tpl) content.appendChild(tpl.content.cloneNode(true));
      content.scrollTop = 0;
      if (typeof MApp.PullToRefresh !== 'undefined') MApp.PullToRefresh.attach(content);
      void content.offsetWidth; // force reflow so the enter animation replays every switch
      content.classList.add('mapp-screen-enter');
    }

    if (changed) MApp.Haptics.light();

    const moduleName = tab.charAt(0).toUpperCase() + tab.slice(1);
    const mod = MApp[moduleName];
    if (mod && typeof mod.mount === 'function') mod.mount();
  },

  // Re-runs the currently visible tab's own data load — shared by
  // MApp.Outbox's post-flush refresh and MApp.PullToRefresh, both of
  // which just want "whatever's on screen right now, reloaded" without
  // caring which module that happens to be.
  refreshCurrentTab() {
    const tab = this.current;
    if (!tab) return;
    const moduleName = tab.charAt(0).toUpperCase() + tab.slice(1);
    const mod = MApp[moduleName];
    if (mod && typeof mod.load === 'function') return mod.load();
    if (mod && typeof mod.mount === 'function') return mod.mount();
  }
};

// Elevates the topbar with a shadow once the current screen has scrolled
// under it — a cheap depth cue, and a hint that there's more content
// above the fold isn't the case anymore. #mapp-content itself is never
// replaced (only its innerHTML), so one listener at boot covers every tab.
document.addEventListener('DOMContentLoaded', () => {
  const content = document.getElementById('mapp-content');
  const topbar = document.querySelector('.mapp-topbar');
  if (!content || !topbar) return;
  content.addEventListener('scroll', () => {
    topbar.classList.toggle('mapp-elevated', content.scrollTop > 4);
  }, { passive: true });
});

// ================================================================
// SHEET — full-screen form overlays (Log Lot, New Dispatch, ...)
// ================================================================
MApp.Sheet = {
  _stack: [],
  _drag: null,
  DRAG_DISMISS_PX: 110,

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
  },

  // Swipe-down-to-dismiss — drag starting on a sheet's own header (the
  // grip cue in .mb-sheet-header::before) follows the finger 1:1, then
  // either snaps back or finishes the close past DRAG_DISMISS_PX. Bound
  // once at boot via delegation since every .mb-sheet already lives
  // permanently in the DOM (unlike tab screens, sheets are never re-cloned).
  initDrag() {
    document.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const header = e.target.closest('.mb-sheet-header');
      if (!header || e.target.closest('.mapp-topbar-btn')) return;
      const sheet = header.closest('.mb-sheet');
      if (!sheet || !sheet.classList.contains('open')) return;
      this._drag = { sheet, startY: e.clientY, dy: 0, pointerId: e.pointerId };
      sheet.classList.add('mb-dragging');
      try { header.setPointerCapture(e.pointerId); } catch (err) { /* unsupported target */ }
    });

    document.addEventListener('pointermove', e => {
      const d = this._drag;
      if (!d || e.pointerId !== d.pointerId) return;
      const dy = Math.max(0, e.clientY - d.startY);
      d.dy = dy;
      d.sheet.style.transform = `translateY(${dy}px)`;
    });

    const end = e => {
      const d = this._drag;
      if (!d || e.pointerId !== d.pointerId) return;
      this._drag = null;
      d.sheet.classList.remove('mb-dragging');
      d.sheet.style.transform = '';
      if (d.dy > MApp.Sheet.DRAG_DISMISS_PX) {
        MApp.Haptics.light();
        MApp.Sheet.close(d.sheet.id);
      }
    };
    document.addEventListener('pointerup', end);
    document.addEventListener('pointercancel', end);
  }
};
MApp.Sheet.initDrag();

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
    // A picker session is already pending (e.g. a fast double-tap on two
    // different "Choose an item" buttons) -- resolve it with null so it
    // doesn't hang forever, and so this new session's selection can't get
    // silently misattributed to it.
    if (this._resolve) {
      const prevResolve = this._resolve;
      this._resolve = null;
      prevResolve(null);
    }
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
// PULL-TO-REFRESH — drag down from the very top of #mapp-content to
// re-run the current tab's own load()/mount(). Only arms once the
// content is already scrolled to its top (checked continuously, not
// just at drag-start) so it never fights normal scrolling, and never
// blocks the browser's own scroll while content.scrollTop > 0.
// ================================================================
MApp.PullToRefresh = {
  THRESHOLD: 64,
  _indicator: null,
  _drag: null,

  init() {
    const content = document.getElementById('mapp-content');
    if (!content) return;

    this._indicator = document.createElement('div');
    this._indicator.className = 'mb-ptr-indicator';
    this._indicator.setAttribute('aria-hidden', 'true');
    this._indicator.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/></svg>';
    this.attach(content);

    content.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (content.scrollTop > 0) return;
      this._drag = { startY: e.clientY, dy: 0, pointerId: e.pointerId, ready: false };
    });

    content.addEventListener('pointermove', e => {
      const d = this._drag;
      if (!d || e.pointerId !== d.pointerId) return;
      if (content.scrollTop > 0) { this._cancel(); return; }
      const dy = e.clientY - d.startY;
      if (dy <= 0) { d.dy = 0; this._setHeight(0, false); return; }
      e.preventDefault();
      d.dy = dy;
      this._setHeight(Math.min(dy * 0.5, this.THRESHOLD + 24), false);
      const ready = dy * 0.5 >= this.THRESHOLD;
      if (ready !== d.ready) {
        d.ready = ready;
        this._indicator.classList.toggle('mb-ptr-ready', ready);
        if (ready) MApp.Haptics.light();
      }
    }, { passive: false });

    const end = e => {
      const d = this._drag;
      if (!d || e.pointerId !== d.pointerId) return;
      this._drag = null;
      if (d.ready) this._refresh();
      else this._setHeight(0, true);
    };
    content.addEventListener('pointerup', end);
    content.addEventListener('pointercancel', end);
  },

  _cancel() {
    this._drag = null;
    this._setHeight(0, true);
  },

  // Re-inserted as #mapp-content's first child on every tab switch, since
  // MApp.Shell.showTab() clears the container's innerHTML wholesale to
  // re-clone each tab's <template> fresh.
  attach(content) {
    if (this._indicator && this._indicator.parentNode !== content) {
      content.insertBefore(this._indicator, content.firstChild);
    }
  },

  _setHeight(px, animated) {
    if (!this._indicator) return;
    this._indicator.classList.toggle('mb-ptr-animated', !!animated);
    this._indicator.style.height = px + 'px';
  },

  async _refresh() {
    this._indicator.classList.remove('mb-ptr-ready');
    this._indicator.classList.add('mb-ptr-spinning');
    this._setHeight(this.THRESHOLD, true);
    MApp.Haptics.success();
    try {
      await MApp.Shell.refreshCurrentTab();
    } finally {
      this._indicator.classList.remove('mb-ptr-spinning');
      this._setHeight(0, true);
    }
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
    this.renderGreeting();

    const statsEl = document.getElementById('home-stats');
    const activityEl = document.getElementById('home-activity');

    try {
      const res = await MApp.Api.callCached('getMobileDashboard');
      if (!res || !res.success) {
        MApp.Util.renderError(statsEl, res && res.message, () => this.mount());
        if (activityEl) activityEl.innerHTML = '';
        return;
      }
      MApp.State.lastDashboard = res.data || {};
      this.render(res.data || {}, res._offlineCachedAt);
    } catch (err) {
      MApp.Util.renderError(statsEl, err && err.message, () => this.mount());
      if (activityEl) activityEl.innerHTML = '';
    }
  },

  render(data, offlineCachedAt) {
    const statsEl = document.getElementById('home-stats');
    if (statsEl) {
      const lowStock = data.lowStockCount || 0;
      const banner = offlineCachedAt ? MApp.Util.offlineBannerHtml(offlineCachedAt) : '';
      statsEl.innerHTML = banner + `
        <button type="button" class="mb-stat-tile mb-accent-blue" onclick="MApp.Home.goTo('production')">
          <div class="mb-stat-tile-top">
            <span class="mb-stat-tile-label">Pending production</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M10 8.5v7l6-3.5-6-3.5z"/></svg>
          </div>
          <div class="mb-stat-tile-value">${data.pendingProductionCount || 0}</div>
        </button>
        <button type="button" class="mb-stat-tile mb-accent-safety" onclick="MApp.Home.goTo('dispatch')">
          <div class="mb-stat-tile-top">
            <span class="mb-stat-tile-label">Today's dispatches</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="7" width="14" height="10" rx="1"/><path d="M15 10h4l3 3v4h-7z"/><circle cx="6" cy="19" r="1.6"/><circle cx="17.5" cy="19" r="1.6"/></svg>
          </div>
          <div class="mb-stat-tile-value">${data.todaysDispatchCount || 0}</div>
        </button>
        <button type="button" class="mb-stat-tile${lowStock > 0 ? ' mb-accent-red' : ''}" style="grid-column:1 / -1;" onclick="MApp.Home.goTo('stock')">
          <div class="mb-stat-tile-top">
            <span class="mb-stat-tile-label">Low-stock alerts</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>
          </div>
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
        activityEl.innerHTML = activity.map((a, i) => {
          const isDispatch = a.type === 'dispatch';
          const icon = isDispatch
            ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="7" width="14" height="10" rx="1"/><path d="M15 10h4l3 3v4h-7z"/><circle cx="6" cy="19" r="1.6"/><circle cx="17.5" cy="19" r="1.6"/></svg>'
            : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M10 8.5v7l6-3.5-6-3.5z"/></svg>';
          return `
          <div class="mb-card mb-stagger-in" style="--i:${i};">
            <div class="mb-activity-row">
              <div class="mb-activity-icon ${isDispatch ? 'mb-accent-safety' : 'mb-accent-blue'}">${icon}</div>
              <div class="mb-activity-body">
                <div class="mb-card-row">
                  <span class="mb-card-title">${MApp.Util.escapeHtml(a.title)}</span>
                  <span class="mb-text-sm mb-text-steel">${MApp.Util.formatDateDisplay(a.dateRaw)}</span>
                </div>
                <div class="mb-card-sub">${MApp.Util.escapeHtml(a.subtitle)}</div>
              </div>
            </div>
          </div>`;
        }).join('');
      }
    }
  },

  renderGreeting() {
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const greetingEl = document.getElementById('home-greeting');
    if (greetingEl) greetingEl.textContent = greeting;

    const dateEl = document.getElementById('home-date');
    if (dateEl) {
      const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      const now = new Date();
      dateEl.textContent = `${days[now.getDay()]}, ${now.getDate()} ${months[now.getMonth()]}`;
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
// STOCK — search-first item list. "Searches as you type" is a pure
// client-side filter over the already-loaded list (no per-keystroke API
// call). Tapping a card expands recent movements, merged client-side
// from Bill/Return/Wastage/Issue/Production/Stock-adjustment history —
// there is no dedicated "item ledger" server endpoint (confirmed: the
// desktop Item Ledger tab derives it the same way from already-loaded
// data), and adding one isn't in scope (getMobileDashboard was the only
// new server function this app needed, and it already exists).
// ================================================================
MApp.Stock = {
  all: [],
  filtered: [],
  expandedKey: null,
  ledgerSources: null, // lazy-loaded on first expand; cached after that

  mount() {
    this.expandedKey = null;
    this.ledgerSources = null;
    const searchInput = document.getElementById('stock-search');
    if (searchInput) searchInput.value = '';
    this.load();
  },

  async load() {
    const listEl = document.getElementById('stock-list');
    MApp.Util.renderSkeleton(listEl, 5);

    // getItemsData is supplementary here (unit lookup only, already has a
    // 'Pcs' fallback below) -- best-effort, caught independently so it
    // can never block Stock's own offline-cached render when it fails
    // (e.g. genuinely offline, and getItemsData itself isn't cached this
    // round). Kicked off alongside getStockData to keep them parallel,
    // same as before.
    const itemsPromise = MApp.Api.call('getItemsData').catch(() => null);

    try {
      const stockRes = await MApp.Api.callCached('getStockData');
      if (!stockRes || !stockRes.success) {
        MApp.Util.renderError(listEl, stockRes && stockRes.message, () => this.load());
        return;
      }

      const itemsRes = await itemsPromise;
      const unitByKey = {};
      if (itemsRes && itemsRes.success) {
        (itemsRes.data || []).forEach(it => {
          unitByKey[this._key(it.name, it.size)] = it.baseUnit || 'Pcs';
        });
      }

      this.all = (stockRes.data || []).map(s => ({
        ...s,
        unit: unitByKey[this._key(s.name, s.size)] || 'Pcs'
      }));

      const lowStockOnly = MApp.State.stockFilter === 'lowstock';
      MApp.State.stockFilter = '';
      this._lowStockOnly = lowStockOnly;
      this._offlineCachedAt = stockRes._offlineCachedAt || null;
      this._pendingSyncCount = await OfflineCache.outbox.countPendingForMethod('adjustStockManually');
      this.filtered = lowStockOnly ? this.all.filter(s => s.isLowStock) : this.all;

      this.render();
    } catch (err) {
      MApp.Util.renderError(listEl, err && err.message, () => this.load());
    }
  },

  _key(name, size) {
    return String(name || '').trim().toLowerCase() + '||' + String(size || '').trim().toLowerCase();
  },

  onSearch(term) {
    const lower = String(term || '').toLowerCase();
    const base = this._lowStockOnly ? this.all.filter(s => s.isLowStock) : this.all;
    this.filtered = !lower ? base : base.filter(s =>
      s.name.toLowerCase().includes(lower) || s.size.toLowerCase().includes(lower));
    this.render();
  },

  clearLowStockFilter() {
    this._lowStockOnly = false;
    this.filtered = this.all;
    const searchInput = document.getElementById('stock-search');
    if (searchInput) searchInput.value = '';
    this.render();
  },

  render() {
    const listEl = document.getElementById('stock-list');
    if (!listEl) return;

    const lowStockBanner = this._lowStockOnly
      ? `<div class="mb-offline-banner" style="background:var(--mb-safety-faint);color:var(--mb-ink);margin-bottom:var(--mb-sp-3);">
           <span>Showing low-stock items only</span>
           <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" onclick="MApp.Stock.clearLowStockFilter()">Clear</button>
         </div>`
      : '';
    const offlineBanner = this._offlineCachedAt ? MApp.Util.offlineBannerHtml(this._offlineCachedAt) : '';
    const pendingBanner = this._pendingSyncCount > 0
      ? MApp.Util.pendingSyncBannerHtml(this._pendingSyncCount, 'correction')
      : '';
    const banner = offlineBanner + pendingBanner + lowStockBanner;

    if (this.filtered.length === 0) {
      listEl.innerHTML = banner;
      const empty = document.createElement('div');
      listEl.appendChild(empty);
      MApp.Util.renderEmpty(empty, {
        title: 'No items found',
        body: this._lowStockOnly ? 'Nothing is currently below its threshold.' : 'Try a different search term.'
      });
      return;
    }

    // data-idx (a plain array index) drives the toggle instead of
    // interpolating the item's name/size into an inline onclick string —
    // item names come from sheet data and may contain quote characters
    // that would otherwise break out of an inline handler's string literal.
    listEl.innerHTML = banner + this.filtered.map((item, idx) => {
      const key = this._key(item.name, item.size);
      const isOpen = this.expandedKey === key;
      return `
        <button type="button" class="mb-card mb-card-tappable" style="border:none;width:100%;" data-stock-toggle data-idx="${idx}">
          <div class="mb-card-row">
            <div>
              <div class="mb-card-title">${MApp.Util.escapeHtml(item.name)}</div>
              <div class="mb-card-sub">${MApp.Util.escapeHtml(item.size || 'No size')}</div>
            </div>
            <div style="text-align:right;">
              <div class="mb-card-number${item.isLowStock ? ' mb-alert' : ''}">${item.currentStock}</div>
              <div class="mb-card-sub">${MApp.Util.escapeHtml(item.unit)}</div>
            </div>
          </div>
          ${item.isLowStock ? '<div class="mb-mt-2"><span class="mb-chip mb-chip-lowstock">Low stock</span></div>' : ''}
        </button>
        <div id="stock-expand-${idx}" class="${isOpen ? '' : 'mb-hidden'}" style="margin:-8px 0 12px;padding:0 var(--mb-sp-2);"></div>
      `;
    }).join('');

    listEl.querySelectorAll('[data-stock-toggle]').forEach(btn => {
      btn.addEventListener('click', () => this.toggleExpand(parseInt(btn.dataset.idx, 10)));
    });

    if (this.expandedKey) {
      const idx = this.filtered.findIndex(i => this._key(i.name, i.size) === this.expandedKey);
      if (idx !== -1) this._renderMovements(idx, this.filtered[idx]);
    }
  },

  async toggleExpand(idx) {
    const item = this.filtered[idx];
    if (!item) return;
    const key = this._key(item.name, item.size);
    const panel = document.getElementById('stock-expand-' + idx);
    if (!panel) return;

    if (this.expandedKey === key) {
      this.expandedKey = null;
      panel.classList.add('mb-hidden');
      panel.innerHTML = '';
      return;
    }

    // Collapse any previously open panel
    document.querySelectorAll('[id^="stock-expand-"]').forEach(el => {
      el.classList.add('mb-hidden');
      el.innerHTML = '';
    });

    this.expandedKey = key;
    panel.classList.remove('mb-hidden');
    await this._renderMovements(idx, item);
  },

  async _renderMovements(idx, item) {
    const panel = document.getElementById('stock-expand-' + idx);
    if (!panel) return;
    panel.innerHTML = '<div class="mb-skel mb-skel-line" style="width:60%;"></div><div class="mb-skel mb-skel-line" style="width:40%;"></div>';

    const adjustBtn = `<button type="button" class="mb-btn-text" style="padding:8px 0;" onclick="MApp.Stock.openAdjustSheet(${idx})">Adjust stock</button>`;

    try {
      await this._ensureLedgerSources();
      const movements = this._computeMovements(item.name, item.size);

      if (movements.length === 0) {
        panel.innerHTML = adjustBtn + '<div class="mb-text-sm mb-text-steel" style="padding:var(--mb-sp-2) 0;">No recorded movements for this item yet.</div>';
        return;
      }

      panel.innerHTML = adjustBtn + movements.slice(0, 6).map(m => `
        <div class="mb-flex-row" style="justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--mb-steel-faint);">
          <div>
            <div class="mb-text-sm" style="font-weight:600;color:var(--mb-ink);">${MApp.Util.escapeHtml(m.label)}</div>
            <div class="mb-text-sm mb-text-steel">${MApp.Util.formatDateDisplay(m.dateRaw)}</div>
          </div>
          <div class="mb-text-sm" style="font-weight:700;color:${m.qtyDelta > 0 ? 'var(--mb-enamel-green)' : 'var(--mb-enamel-red)'};white-space:nowrap;">
            ${m.qtyDelta > 0 ? '+' : ''}${m.qtyDelta}
          </div>
        </div>
      `).join('');
    } catch (err) {
      panel.innerHTML = adjustBtn + `<div class="mb-text-sm" style="color:var(--mb-enamel-red);">Couldn't load movement history: ${MApp.Util.escapeHtml(err.message || '')}</div>`;
    }
  },

  // ── MANUAL STOCK ADJUSTMENT — mirrors desktop's App.Stock.handleAdjustSubmit
  // (module_stock.js#adjustStockManually unchanged server-side). Negative
  // corrected values are intentionally allowed here (same exception as
  // desktop) so field operations aren't blocked; the user can fix the
  // number later once the real cause is investigated.
  openAdjustSheet(idx) {
    const item = this.filtered[idx];
    if (!item) return;
    this._adjustItem = item;

    const label = document.getElementById('stock-adjust-item-label');
    if (label) label.value = `${item.name} (${item.size || 'GENERAL'})`;
    const oldVal = document.getElementById('stock-adjust-old-value');
    if (oldVal) oldVal.value = item.currentStock;
    const newVal = document.getElementById('stock-adjust-new-value');
    if (newVal) newVal.value = item.currentStock;
    const reason = document.getElementById('stock-adjust-reason');
    if (reason) reason.value = '';

    MApp.Sheet.open('sheet-stock-adjust');
  },

  closeAdjustSheet() {
    MApp.Sheet.close('sheet-stock-adjust');
  },

  // Note: source's own _apiCall handled both reads and writes with one
  // verb (no CSRF/mutation-id needed under google.script.run) -- this
  // Flask backend's adjustStockManually is mutation=True (registry.py).
  //
  // Phase 6 Round 3: the mutation-id is generated ONCE, up front, and
  // reused for both this live attempt and any later outbox replay (via
  // Api.mutateWithId, not Api.mutate, which would generate a fresh one
  // per call) -- so if this request actually reaches the server but its
  // response is lost (a connection drop mid-response, not mid-request),
  // a later replay under the SAME id is recognized as a duplicate and
  // returns the cached result instead of adjusting stock twice.
  async submitAdjust() {
    const item = this._adjustItem;
    if (!item) return;

    const newValue = parseFloat(document.getElementById('stock-adjust-new-value')?.value);
    const reason = (document.getElementById('stock-adjust-reason')?.value || '').trim();

    if (isNaN(newValue)) {
      MApp.Toast.error('Corrected stock must be a valid number.');
      return;
    }
    if (!reason) {
      MApp.Toast.error('Please provide a reason for this adjustment.');
      return;
    }

    const mutationId = Api.newMutationId();
    const args = [item.name, item.size, newValue, reason];

    MApp.Util.setSheetBusy('stock-adjust-body', 'stock-adjust-save-btn', true, 'Saving…');
    try {
      const res = await Api.mutateWithId('adjustStockManually', mutationId, ...args);
      if (!res || !res.success) {
        // Reached the server -- a real rejection, not an outage. Unchanged
        // from before this round: no outbox fallback for a business error.
        MApp.Toast.error((res && res.message) || 'Could not adjust stock.');
        MApp.Util.setSheetBusy('stock-adjust-body', 'stock-adjust-save-btn', false, null, 'Save Correction');
        return;
      }
      MApp.Toast.success(res.message || 'Stock adjusted.');
      this.closeAdjustSheet();
      MApp.Util.setSheetBusy('stock-adjust-body', 'stock-adjust-save-btn', false, null, 'Save Correction');
      this.load();
    } catch (err) {
      if (err && err.isNetworkError) {
        // The fetch itself never reached the server -- queue it under the
        // same mutationId instead of failing outright.
        await OfflineCache.outbox.enqueue(mutationId, 'adjustStockManually', args);
        MApp.Outbox.updateBadge();
        MApp.Outbox.requestSync();
        MApp.Toast.success('Saved — will sync when back online.');
        this.closeAdjustSheet();
        MApp.Util.setSheetBusy('stock-adjust-body', 'stock-adjust-save-btn', false, null, 'Save Correction');
        this.load();
        return;
      }
      // Reached the server but got a real HTTP-level failure (e.g. a CSRF
      // token that expired since this page loaded) -- not safe to queue
      // for blind retry, unlike a genuine outage.
      MApp.Toast.error(err.message || 'Could not adjust stock. Please try again.');
      MApp.Util.setSheetBusy('stock-adjust-body', 'stock-adjust-save-btn', false, null, 'Save Correction');
    }
  },

  async _ensureLedgerSources() {
    if (this.ledgerSources) return this.ledgerSources;

    const [billsRes, returnsRes, wastageRes, issueRes, productionRes, adjustRes] = await Promise.all([
      MApp.Api.call('getBillData'),
      MApp.Api.call('getReturnData'),
      MApp.Api.call('getWastageData'),
      MApp.Api.call('getIssueData'),
      MApp.Api.call('getProductionData'),
      MApp.Api.call('getStockAdjustmentHistory')
    ]);

    this.ledgerSources = {
      bills: (billsRes && billsRes.success) ? billsRes.data || [] : [],
      returns: (returnsRes && returnsRes.success) ? returnsRes.data || [] : [],
      wastage: (wastageRes && wastageRes.success) ? wastageRes.data || [] : [],
      issues: (issueRes && issueRes.success) ? issueRes.data || [] : [],
      production: (productionRes && productionRes.success) ? productionRes.data || [] : [],
      adjustments: (adjustRes && adjustRes.success) ? adjustRes.data || [] : []
    };
    return this.ledgerSources;
  },

  _computeMovements(name, size) {
    const matches = (n, s) => String(n || '').trim().toLowerCase() === String(name || '').trim().toLowerCase() &&
      String(s || '').trim().toLowerCase() === String(size || '').trim().toLowerCase();
    const src = this.ledgerSources;
    const out = [];

    src.bills.forEach(bill => {
      (bill.items || []).forEach(it => {
        if (!matches(it.name, it.size)) return;
        out.push({ dateRaw: bill.billDateRaw || bill.billDate, label: `Bill ${bill.billNumber} — ${bill.vendor}`, qtyDelta: it.qty });
      });
    });

    src.returns.forEach(ret => {
      (ret.items || []).forEach(it => {
        if (!matches(it.name, it.size)) return;
        out.push({ dateRaw: ret.returnDateRaw, label: `Return ${ret.returnNumber} — ${ret.vendor}`, qtyDelta: -it.qty });
      });
    });

    src.wastage.forEach(w => {
      (w.items || []).forEach(it => {
        if (!matches(it.name, it.size)) return;
        out.push({ dateRaw: w.dateRaw, label: `Wastage — ${it.reason || 'unspecified'}`, qtyDelta: -it.qty });
      });
    });

    src.issues.forEach(iss => {
      (iss.items || []).forEach(it => {
        if (!matches(it.name, it.size)) return;
        out.push({ dateRaw: iss.dateRaw, label: `Issued to ${iss.issuedTo}`, qtyDelta: -it.qty });
      });
    });

    src.production.forEach(lot => {
      if (lot.status !== 'Completed') return;
      (lot.componentsConsumed || []).forEach(c => {
        if (String(c.sourceType || '').toUpperCase() === 'POOL') return;
        if (!matches(c.itemName, c.size)) return;
        out.push({ dateRaw: lot.dateRaw, label: `Production lot ${lot.lotNumber}`, qtyDelta: -(Number(c.qty) || 0) });
      });
    });

    src.adjustments.forEach(adj => {
      if (!matches(adj.itemName, adj.size)) return;
      out.push({
        dateRaw: adj.date,
        label: `Manual adjustment${adj.reason ? ' — ' + adj.reason : ''}`,
        qtyDelta: Math.round(((adj.newValue || 0) - (adj.oldValue || 0)) * 100) / 100
      });
    });

    out.sort((a, b) => new Date(b.dateRaw || 0) - new Date(a.dateRaw || 0));
    return out;
  }
};

// ================================================================
// PRODUCTION — card list + the "Log Lot" full-screen sheet, the primary
// action screen. The Size/Model/Process Type/Process cascade is pure
// client-side array filtering over one already-loaded process list (no
// per-level fetch, so no suppress-flags/sequence counters are needed —
// see _applyCascadeEnabledStates, which always re-derives each picker's
// enabled state from current selection instead of tracking it separately).
// The one real fetch in this flow is loading a chosen process's color
// groups/axes/recipe (_setCascadeBusy brackets it); saving disables the
// whole sheet via MApp.Util.setSheetBusy.
//
// Color checklist scope note: when a process has 2+ independent color
// axes (e.g. Frame + Mudguard), the mobile form treats the PRIMARY axis
// as the real per-color chip+stepper checklist (drives lot qty, exactly
// like desktop), and every OTHER axis as a single "pick one color for
// this whole batch" choice applied to the full lot qty. Desktop instead
// lets different primary colors within the same lot pair with different
// secondary colors (auto-matched via Process Color Links) — a genuinely
// complex feature intentionally simplified here for one-handed field
// logging. A lot that needs mixed secondary colors within one batch
// should still be logged on desktop.
// ================================================================
MApp.Production = {
  PROCESS_SIZE_LIST: ['12 inch', '14 inch', '16 inch', '20 inch', '24 inch', '26 inch'],

  lots: [],
  allProcesses: [],
  activeProcesses: [],
  processById: {},
  models: [],
  processTypes: [],
  contractors: [],
  bomProducts: null,
  _pendingOnly: false,

  selection: { size: '', model: '', type: '', processId: '', process: null, productId: '', productName: '' },
  flatColors: [],
  axes: [],
  primaryAxisKey: '',
  // True whenever primaryAxisKey is only the server's recipe-order
  // fallback (see get_process_color_axes's primaryIsDefault) rather than a
  // choice actually confirmed for THIS lot -- gates _renderQtyOrColorSection
  // into the "pick which group is Primary" step instead of silently
  // trusting the fallback, same reasoning as the desktop Production form's
  // primaryIsDefault handling.
  primaryIsDefault: false,
  recipeComponents: [],
  colorQtyByColor: {},
  secondaryChoice: {},
  selectedStatus: 'Pending',
  selectedAssignedTo: '',
  selectedExtraChargeType: '',
  editingLot: null,
  _procSelectSeq: 0,

  mount() {
    this.bomProducts = null;
    this.load();
  },

  async load() {
    const listEl = document.getElementById('production-list');
    MApp.Util.renderSkeleton(listEl, 4);

    // getProcessData here is supplementary (display-name lookup for
    // processById, plus the Log Lot cascade's own reference data) --
    // best-effort, caught independently so it can never block
    // Production's own offline-cached list render, same pattern as
    // Round 1's Stock fix. On failure the list still renders (falling
    // back to raw processId instead of a friendly name) and opening
    // Log Lot still degrades exactly as it already did offline.
    const procPromise = MApp.Api.call('getProcessData').catch(() => null);

    try {
      const lotsRes = await MApp.Api.callCached('getProductionData');
      if (!lotsRes || !lotsRes.success) {
        MApp.Util.renderError(listEl, lotsRes && lotsRes.message, () => this.load());
        return;
      }

      const procRes = await procPromise;
      this.lots = lotsRes.data || [];
      this.allProcesses = (procRes && procRes.success) ? (procRes.data || []) : [];
      this.activeProcesses = this.allProcesses.filter(p => p.active);
      this.processById = {};
      this.allProcesses.forEach(p => { this.processById[p.processId] = p; });

      this._pendingOnly = MApp.State.productionFilter === 'pending';
      MApp.State.productionFilter = '';
      this._offlineCachedAt = lotsRes._offlineCachedAt || null;
      this._pendingSyncCount = await OfflineCache.outbox.countPendingForMethod('saveProduction');

      this.render();
    } catch (err) {
      MApp.Util.renderError(listEl, err && err.message, () => this.load());
    }
  },

  render() {
    const listEl = document.getElementById('production-list');
    if (!listEl) return;

    let lots = this.lots;
    const offlineBanner = this._offlineCachedAt ? MApp.Util.offlineBannerHtml(this._offlineCachedAt) : '';
    const pendingSyncBanner = this._pendingSyncCount > 0
      ? MApp.Util.pendingSyncBannerHtml(this._pendingSyncCount, 'lot')
      : '';
    const pendingOnlyBanner = this._pendingOnly
      ? `<div class="mb-offline-banner" style="background:var(--mb-safety-faint);color:var(--mb-ink);margin-bottom:var(--mb-sp-3);">
           <span>Showing pending &amp; in-progress lots only</span>
           <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" data-clear-filter>Clear</button>
         </div>`
      : '';
    const banner = offlineBanner + pendingSyncBanner + pendingOnlyBanner;
    if (this._pendingOnly) {
      lots = lots.filter(l => l.status === 'Pending' || l.status === 'In Progress');
    }

    if (lots.length === 0) {
      listEl.innerHTML = banner;
      const empty = document.createElement('div');
      listEl.appendChild(empty);
      MApp.Util.renderEmpty(empty, { title: 'No lots logged today', body: 'Tap + to log the first lot.' });
    } else {
      listEl.innerHTML = banner + lots.slice(0, 50).map((l, i) => {
        const process = this.processById[l.processId];
        const processName = process ? process.processName : l.processId;
        return `
          <div class="mb-card">
            <div class="mb-card-row">
              <div>
                <div class="mb-card-title">${MApp.Util.escapeHtml(l.lotNumber)}</div>
                <div class="mb-card-sub">${MApp.Util.escapeHtml(processName)}</div>
              </div>
              <div style="text-align:right;">
                <div class="mb-card-number">${l.qty}</div>
                <div class="mb-card-sub">${MApp.Util.escapeHtml(MApp.Util.formatNameCase(l.assignedTo) || '—')}</div>
              </div>
            </div>
            <div class="mb-mt-2"><span class="mb-chip ${MApp.Util.statusChipClass(l.status)}">${MApp.Util.escapeHtml(l.status || 'Pending')}</span></div>
            <div class="mb-mt-2" style="display:flex; gap:var(--mb-sp-4);">
              <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" data-lot-action="edit" data-lot-index="${i}">Edit</button>
              <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;color:var(--mb-enamel-red);" data-lot-action="delete" data-lot-index="${i}">Delete</button>
            </div>
          </div>`;
      }).join('');

      listEl.querySelectorAll('[data-lot-action]').forEach(btn => {
        btn.addEventListener('click', () => {
          const lot = lots[Number(btn.dataset.lotIndex)];
          if (!lot) return;
          if (btn.dataset.lotAction === 'edit') this.openEditSheet(lot);
          else this.deleteLot(lot);
        });
      });
    }

    const clearBtn = listEl.querySelector('[data-clear-filter]');
    if (clearBtn) clearBtn.addEventListener('click', () => { this._pendingOnly = false; this.render(); });
  },

  // ── Size/Model/Process Type helpers (mirror desktop's App.Utils, kept
  // local since the mobile bundle shares nothing with desktop Script.html) ──
  getSizeFromOutputItemName(text) {
    const lower = String(text || '').toLowerCase();
    return this.PROCESS_SIZE_LIST.find(s => lower.includes(s)) || 'General';
  },

  getModelFromOutputItemName(text) {
    const lower = String(text || '').toLowerCase();
    const models = [...(this.models || [])].sort((a, b) => String(b.name || '').length - String(a.name || '').length);
    const match = models.find(m => m.name && lower.includes(String(m.name).toLowerCase()));
    return match ? match.name : 'General';
  },

  // ── Log Lot sheet ──────────────────────────────────────────────────
  async openLogLotSheet() {
    this.editingLot = null;
    this.selection = { size: '', model: '', type: '', processId: '', process: null, productId: '', productName: '' };
    this.flatColors = [];
    this.axes = [];
    this.primaryAxisKey = '';
    this.primaryIsDefault = false;
    this.recipeComponents = [];
    this.colorQtyByColor = {};
    this.secondaryChoice = {};
    this.selectedStatus = 'Pending';
    this.selectedAssignedTo = '';
    this.selectedExtraChargeType = '';

    const titleEl = document.querySelector('#sheet-log-lot h2');
    if (titleEl) titleEl.textContent = 'Log Lot';
    const saveBtn = document.getElementById('log-lot-save-btn');
    if (saveBtn) saveBtn.textContent = 'Log Lot';

    document.getElementById('log-lot-body').innerHTML = this._skeletonFormHtml();
    MApp.Sheet.open('sheet-log-lot');

    if (saveBtn) saveBtn.disabled = true;

    try {
      await this._ensureRefData();
      document.getElementById('log-lot-body').innerHTML = this._formHtml();
    } catch (err) {
      MApp.Toast.error('Could not load production reference data: ' + (err.message || ''));
      this.closeLogLotSheet();
      return;
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  },

  closeLogLotSheet() {
    MApp.Sheet.close('sheet-log-lot');
  },

  // ── Edit (Phase 2) — processId is immutable on an existing lot
  // (save_production's own contract: "Process cannot be changed on an
  // existing lot"), so this reuses the create sheet's qty/color-section
  // machinery (onProcessSelected) but skips the size/model/type/process
  // cascade entirely, replacing it with a locked, read-only process label.
  async openEditSheet(lot) {
    this.editingLot = lot;
    this.selection = { size: '', model: '', type: '', processId: lot.processId, process: null, productId: lot.productId || '', productName: lot.productName || '' };
    this.flatColors = [];
    this.axes = [];
    this.primaryAxisKey = '';
    this.primaryIsDefault = false;
    this.recipeComponents = [];
    this.colorQtyByColor = {};
    this.secondaryChoice = {};
    this.selectedStatus = lot.status || 'Pending';
    this.selectedAssignedTo = lot.assignedTo || '';
    this.selectedExtraChargeType = lot.extraChargeType || '';

    const titleEl = document.querySelector('#sheet-log-lot h2');
    if (titleEl) titleEl.textContent = 'Edit Lot';
    const saveBtn = document.getElementById('log-lot-save-btn');
    if (saveBtn) saveBtn.textContent = 'Save Changes';

    document.getElementById('log-lot-body').innerHTML = this._skeletonFormHtml();
    MApp.Sheet.open('sheet-log-lot');
    if (saveBtn) saveBtn.disabled = true;

    try {
      await this._ensureRefData();
      const process = this.processById[lot.processId] || this.allProcesses.find(p => p.processId === lot.processId) || null;
      this.selection.process = process;
      document.getElementById('log-lot-body').innerHTML = this._editFormHtml(lot, process);

      if (process) {
        await this.onProcessSelected(lot.processId);
        // An existing lot already RECORDS which axis was Primary for it
        // (its counts-toward-total entries carry that axisKey), so it must
        // never be sent back through the "pick which group is Primary"
        // step _renderQtyOrColorSection shows for a brand-new lot on a
        // process that has no stored default -- that step would withhold
        // the colour chips and drop the quantities being restored just
        // below. Only a key that still resolves to a live axis is trusted;
        // anything else falls through to the picker, which is the correct
        // outcome once the recorded axis no longer exists.
        if (Array.isArray(lot.colorBreakdown)) {
          const recordedPrimary = lot.colorBreakdown.find(
            cb => cb && cb.countsTowardTotal !== false && cb.axisKey && this.axes.some(a => a.key === cb.axisKey));
          if (recordedPrimary) {
            this.primaryAxisKey = recordedPrimary.axisKey;
            this.primaryIsDefault = false;
          }
        }
        if (this.flatColors.length > 0 && Array.isArray(lot.colorBreakdown)) {
          lot.colorBreakdown.forEach(cb => {
            if (cb.countsTowardTotal === false && cb.axisKey) this.secondaryChoice[cb.axisKey] = cb.color;
            else if (cb.qty > 0) this.colorQtyByColor[cb.color] = cb.qty;
          });
          this._renderQtyOrColorSection();
        } else {
          const qtyInput = document.getElementById('lot-qty');
          if (qtyInput) qtyInput.value = lot.qty;
        }
      }
    } catch (err) {
      MApp.Toast.error('Could not load this lot: ' + (err.message || ''));
      this.closeLogLotSheet();
      return;
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  },

  _editFormHtml(lot, process) {
    const statusOptions = ['Pending', 'In Progress', 'Completed', 'Cancelled'];
    const lotStatus = lot.status || 'Pending';
    return `
      <div class="mb-field">
        <label for="lot-date">Date</label>
        <input type="date" id="lot-date" value="${dateToInputValue(lot.dateRaw, lot.date)}">
      </div>

      <div class="mb-field">
        <label>Process</label>
        <input type="text" value="${MApp.Util.escapeHtml(process ? process.processName : lot.processId)}" readonly>
        <div class="mb-field-hint">The process on an existing lot can't be changed — delete and re-log it under a different process instead.</div>
      </div>

      <div class="mb-field mb-hidden" id="lot-product-tag-wrap">
        <label>Product tag (optional)</label>
        <button type="button" class="mb-picker-field${lot.productName ? '' : ' mb-placeholder'}" id="lot-product-field" onclick="MApp.Production.pickProductTag()">${MApp.Util.escapeHtml(lot.productName || 'Choose a product...')}</button>
        <div class="mb-field-hint">Only needed so Dispatch can find this lot's stock — leave blank for an intermediate stage.</div>
      </div>

      <div class="mb-field mb-hidden" id="lot-qty-wrap">
        <label for="lot-qty">Quantity</label>
        <input type="number" id="lot-qty" inputmode="decimal" min="0" step="1" value="${lot.qty || ''}">
      </div>

      <div id="lot-color-wrap" class="mb-hidden mb-mb-4"></div>

      <div class="mb-field">
        <label>Assigned to</label>
        <button type="button" class="mb-picker-field${lot.assignedTo ? '' : ' mb-placeholder'}" id="lot-assignedto-field" onclick="MApp.Production.pickAssignedTo()">${MApp.Util.escapeHtml(MApp.Util.formatNameCase(lot.assignedTo) || 'Choose or add a name...')}</button>
      </div>

      <div class="mb-field">
        <label>Extra charge (optional)</label>
        <button type="button" class="mb-picker-field${lot.extraChargeType ? '' : ' mb-placeholder'}" id="lot-extracharge-field" onclick="MApp.Production.pickExtraCharge()">${MApp.Util.escapeHtml(lot.extraChargeType || 'None')}</button>
      </div>

      <div class="mb-field">
        <label for="lot-assignedby">Assigned by (optional)</label>
        <input type="text" id="lot-assignedby" placeholder="Supervisor name" value="${MApp.Util.escapeHtml(lot.assignedBy || '')}">
      </div>

      <div class="mb-field">
        <label>Status</label>
        <div class="mb-color-chip-list" id="lot-status-row">
          ${statusOptions.map(s => `<button type="button" class="mb-color-chip${s === lotStatus ? ' checked' : ''}" style="min-width:auto;padding:10px 16px;" data-status="${s}" onclick="MApp.Production.setStatus('${s}')">${s}</button>`).join('')}
        </div>
      </div>

      <div class="mb-field">
        <label for="lot-remarks">Remarks (optional)</label>
        <textarea id="lot-remarks" rows="3" placeholder="Notes for this lot...">${MApp.Util.escapeHtml(lot.remarks || '')}</textarea>
      </div>
    `;
  },

  async deleteLot(lot) {
    if (!MApp.Util.confirmDelete(lot.lotNumber)) return;
    const res = await MApp.Util.mutateSimple('deleteProduction', [lot.rowIdx], 'Lot deleted.');
    if (res.success) this.load();
  },

  async _ensureRefData() {
    if (this.allProcesses.length === 0) await this.load();

    const [modelsRes, typesRes, contractorsRes] = await Promise.all([
      MApp.Api.call('getModels'),
      MApp.Api.call('getProcessTypes'),
      MApp.Api.call('getContractorsData')
    ]);
    this.models = (modelsRes && modelsRes.success) ? (modelsRes.data || []) : [];
    this.processTypes = (typesRes && typesRes.success) ? (typesRes.data || []) : [];
    this.contractors = (contractorsRes && contractorsRes.success) ? (contractorsRes.data || []) : [];
  },

  _skeletonFormHtml() {
    return `
      <div class="mb-skel mb-skel-card" style="height:56px;"></div>
      <div class="mb-skel mb-skel-card" style="height:56px;"></div>
      <div class="mb-skel mb-skel-card" style="height:56px;"></div>
    `;
  },

  _formHtml() {
    const statusOptions = ['Pending', 'In Progress', 'Completed', 'Cancelled'];
    return `
      <div class="mb-field">
        <label for="lot-date">Date</label>
        <input type="date" id="lot-date" value="${MApp.Util.todayInputValue()}">
      </div>

      <div class="mb-field">
        <label>Size</label>
        <button type="button" class="mb-picker-field mb-placeholder" id="lot-size-field" onclick="MApp.Production.pickSize()">Choose a size...</button>
      </div>

      <div class="mb-field">
        <label>Model</label>
        <button type="button" class="mb-picker-field mb-placeholder" id="lot-model-field" disabled onclick="MApp.Production.pickModel()">Choose a size first...</button>
      </div>

      <div class="mb-field">
        <label>Process type</label>
        <button type="button" class="mb-picker-field mb-placeholder" id="lot-type-field" disabled onclick="MApp.Production.pickProcessType()">Choose a model first...</button>
      </div>

      <div class="mb-field">
        <label>Process</label>
        <button type="button" class="mb-picker-field mb-placeholder" id="lot-process-field" disabled onclick="MApp.Production.pickProcess()">Choose a process type first...</button>
      </div>

      <div class="mb-field mb-hidden" id="lot-product-tag-wrap">
        <label>Product tag (optional)</label>
        <button type="button" class="mb-picker-field mb-placeholder" id="lot-product-field" onclick="MApp.Production.pickProductTag()">Choose a product...</button>
        <div class="mb-field-hint">Only needed so Dispatch can find this lot's stock — leave blank for an intermediate stage.</div>
      </div>

      <div class="mb-field mb-hidden" id="lot-qty-wrap">
        <label for="lot-qty">Quantity</label>
        <input type="number" id="lot-qty" inputmode="decimal" min="0" step="1" placeholder="0">
      </div>

      <div id="lot-color-wrap" class="mb-hidden mb-mb-4"></div>

      <div class="mb-field">
        <label>Assigned to</label>
        <button type="button" class="mb-picker-field mb-placeholder" id="lot-assignedto-field" onclick="MApp.Production.pickAssignedTo()">Choose or add a name...</button>
      </div>

      <div class="mb-field">
        <label>Extra charge (optional)</label>
        <button type="button" class="mb-picker-field mb-placeholder" id="lot-extracharge-field" onclick="MApp.Production.pickExtraCharge()">None</button>
      </div>

      <div class="mb-field">
        <label for="lot-assignedby">Assigned by (optional)</label>
        <input type="text" id="lot-assignedby" placeholder="Supervisor name">
      </div>

      <div class="mb-field">
        <label>Status</label>
        <div class="mb-color-chip-list" id="lot-status-row">
          ${statusOptions.map(s => `<button type="button" class="mb-color-chip${s === 'Pending' ? ' checked' : ''}" style="min-width:auto;padding:10px 16px;" data-status="${s}" onclick="MApp.Production.setStatus('${s}')">${s}</button>`).join('')}
        </div>
      </div>

      <div class="mb-field">
        <label for="lot-remarks">Remarks (optional)</label>
        <textarea id="lot-remarks" rows="3" placeholder="Notes for this lot..."></textarea>
      </div>
    `;
  },

  _updateFieldLabel(id, label) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = label;
    el.classList.remove('mb-placeholder');
  },

  _resetDownstreamFieldLabels(levels) {
    const placeholders = { model: 'Choose a model...', type: 'Choose a process type...', process: 'Choose a process...' };
    levels.forEach(level => {
      const el = document.getElementById('lot-' + level + '-field');
      if (!el) return;
      el.textContent = placeholders[level];
      el.classList.add('mb-placeholder');
    });
  },

  _hideProcessDependentSections() {
    const tagWrap = document.getElementById('lot-product-tag-wrap');
    if (tagWrap) tagWrap.classList.add('mb-hidden');

    const qtyWrap = document.getElementById('lot-qty-wrap');
    if (qtyWrap) {
      qtyWrap.classList.add('mb-hidden');
      const q = document.getElementById('lot-qty');
      if (q) q.value = '';
    }

    const colorWrap = document.getElementById('lot-color-wrap');
    if (colorWrap) {
      colorWrap.classList.add('mb-hidden');
      colorWrap.innerHTML = '';
    }

    this.flatColors = [];
    this.axes = [];
    this.primaryAxisKey = '';
    this.primaryIsDefault = false;
    this.recipeComponents = [];
    this.colorQtyByColor = {};
    this.secondaryChoice = {};
    this.selection.productId = '';
    this.selection.productName = '';

    this._updateFieldLabel('lot-product-field', 'Choose a product...');
    document.getElementById('lot-product-field')?.classList.add('mb-placeholder');
  },

  _applyCascadeEnabledStates() {
    const modelBtn = document.getElementById('lot-model-field');
    const typeBtn = document.getElementById('lot-type-field');
    const processBtn = document.getElementById('lot-process-field');
    if (modelBtn) modelBtn.disabled = !this.selection.size;
    if (typeBtn) typeBtn.disabled = !this.selection.model;
    if (processBtn) processBtn.disabled = !this.selection.type;
  },

  // Disables every cascade picker + Save while a process-dependent fetch
  // (color groups/axes/recipe) is in flight, then re-derives each
  // picker's correct enabled state from current selection afterwards —
  // no remembered "previous" state to restore, so nothing can go stale.
  _setCascadeBusy(isBusy) {
    ['lot-size-field', 'lot-model-field', 'lot-type-field', 'lot-process-field', 'lot-product-field'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = isBusy;
    });
    const saveBtn = document.getElementById('log-lot-save-btn');
    if (saveBtn) saveBtn.disabled = isBusy;
    if (!isBusy) this._applyCascadeEnabledStates();
  },

  async pickSize() {
    const sizesPresent = new Set(this.activeProcesses.map(p => this.getSizeFromOutputItemName(p.outputItemName)));
    const ordered = this.PROCESS_SIZE_LIST.filter(s => sizesPresent.has(s));
    if (sizesPresent.has('General')) ordered.push('General');
    const items = ordered.map(s => ({ value: s, label: s }));

    const picked = await MApp.Picker.open({ title: 'Choose a size', items, selectedValue: this.selection.size, searchable: false });
    if (!picked) return;

    this.selection.size = picked.value;
    this.selection.model = '';
    this.selection.type = '';
    this.selection.processId = '';
    this.selection.process = null;
    this._updateFieldLabel('lot-size-field', picked.label);
    this._resetDownstreamFieldLabels(['model', 'type', 'process']);
    this._hideProcessDependentSections();
    this._applyCascadeEnabledStates();
  },

  async pickModel() {
    if (!this.selection.size) return;
    const matches = this.activeProcesses.filter(p => this.getSizeFromOutputItemName(p.outputItemName) === this.selection.size);
    const modelsPresent = new Set(matches.map(p => this.getModelFromOutputItemName(p.outputItemName)));
    const masterNames = (this.models || []).map(m => m.name);
    const ordered = masterNames.filter(n => modelsPresent.has(n));
    if (modelsPresent.has('General')) ordered.push('General');
    const items = ordered.map(m => ({ value: m, label: m }));

    const picked = await MApp.Picker.open({ title: 'Choose a model', items, selectedValue: this.selection.model });
    if (!picked) return;

    this.selection.model = picked.value;
    this.selection.type = '';
    this.selection.processId = '';
    this.selection.process = null;
    this._updateFieldLabel('lot-model-field', picked.label);
    this._resetDownstreamFieldLabels(['type', 'process']);
    this._hideProcessDependentSections();
    this._applyCascadeEnabledStates();
  },

  async pickProcessType() {
    if (!this.selection.model) return;
    const matches = this.activeProcesses
      .filter(p => this.getSizeFromOutputItemName(p.outputItemName) === this.selection.size)
      .filter(p => this.getModelFromOutputItemName(p.outputItemName) === this.selection.model);
    const typesPresent = new Set(matches.map(p => p.processType || 'General'));
    const masterNames = (this.processTypes || []).map(t => t.name);
    const ordered = masterNames.filter(t => typesPresent.has(t));
    if (typesPresent.has('General')) ordered.push('General');
    const items = ordered.map(t => ({ value: t, label: t }));

    const picked = await MApp.Picker.open({ title: 'Choose a process type', items, selectedValue: this.selection.type });
    if (!picked) return;

    this.selection.type = picked.value;
    this.selection.processId = '';
    this.selection.process = null;
    this._updateFieldLabel('lot-type-field', picked.label);
    this._resetDownstreamFieldLabels(['process']);
    this._hideProcessDependentSections();
    this._applyCascadeEnabledStates();
  },

  async pickProcess() {
    if (!this.selection.type) return;
    const matches = this.activeProcesses
      .filter(p => this.getSizeFromOutputItemName(p.outputItemName) === this.selection.size)
      .filter(p => this.getModelFromOutputItemName(p.outputItemName) === this.selection.model)
      .filter(p => (p.processType || 'General') === this.selection.type)
      .sort((a, b) => a.sequence - b.sequence);
    const items = matches.map(p => ({ value: p.processId, label: p.processName, sublabel: 'Stage ' + p.sequence }));

    const picked = await MApp.Picker.open({ title: 'Choose a process', items, selectedValue: this.selection.processId });
    if (!picked) return;

    this._updateFieldLabel('lot-process-field', picked.label);
    await this.onProcessSelected(picked.value);
  },

  async onProcessSelected(processId) {
    const process = this.activeProcesses.find(p => p.processId === processId);
    if (!process) return;

    // Tapping through processes quickly (picking the wrong one, then
    // correcting) can let an EARLIER process's slower getProcessColorAxes/
    // getProcessColorGroups response land AFTER a later one for the process
    // actually selected now -- with no guard, that stale response used to
    // silently overwrite this.axes/flatColors with a DIFFERENT process's
    // color sub-groups (e.g. an unrelated Packing process's "Kit Bag"/
    // "Small Kit" tag axes bleeding into a plain process like Rim Fitting
    // that has none of its own). Same mySeq/_formSeq guard idiom as
    // Bills/Vendors openForm() elsewhere in this file.
    const mySeq = ++this._procSelectSeq;

    this.selection.processId = processId;
    this.selection.process = process;
    this.selection.productId = '';
    this.selection.productName = '';
    this._updateFieldLabel('lot-product-field', 'Choose a product...');
    document.getElementById('lot-product-field')?.classList.add('mb-placeholder');

    this._setCascadeBusy(true);
    try {
      const [groupsRes, axesRes, compRes] = await Promise.all([
        MApp.Api.call('getProcessColorGroups', processId),
        MApp.Api.call('getProcessColorAxes', processId),
        MApp.Api.call('getProcessComponentsData', processId)
      ]);
      if (mySeq !== this._procSelectSeq) return;

      this.flatColors = (groupsRes && groupsRes.success) ? (groupsRes.data || []) : [];
      const axesData = (axesRes && axesRes.success) ? (axesRes.data || {}) : {};
      this.axes = axesData.axes || [];
      this.primaryAxisKey = axesData.primaryAxisKey || (this.axes[0] && this.axes[0].key) || '';
      this.primaryIsDefault = this.axes.length >= 2 ? !!axesData.primaryIsDefault : false;
      this.recipeComponents = (compRes && compRes.success) ? (compRes.data || []) : [];
      this.colorQtyByColor = {};
      this.secondaryChoice = {};

      const tagWrap = document.getElementById('lot-product-tag-wrap');
      if (tagWrap) tagWrap.classList.toggle('mb-hidden', !process.isFinalStage);

      if (process.isFinalStage && this.bomProducts === null) {
        const bomRes = await MApp.Api.call('getBOMProductionData');
        if (mySeq !== this._procSelectSeq) return;
        this.bomProducts = (bomRes && bomRes.success) ? (bomRes.data || []) : [];
      }

      this._renderQtyOrColorSection();
    } catch (err) {
      if (mySeq !== this._procSelectSeq) return;
      MApp.Toast.error('Could not load this process: ' + (err.message || ''));
    } finally {
      if (mySeq === this._procSelectSeq) this._setCascadeBusy(false);
    }
  },

  async pickProductTag() {
    if (this.bomProducts === null) return;
    const items = this.bomProducts.map(p => ({ value: p.productId, label: p.productName, sublabel: p.productId }));
    const picked = await MApp.Picker.open({ title: 'Choose a product', items, selectedValue: this.selection.productId });
    if (!picked) return;
    this.selection.productId = picked.value;
    this.selection.productName = picked.label;
    this._updateFieldLabel('lot-product-field', picked.label);
  },

  // Fixed from source's own c.name -- getContractorsData returns
  // contractorName (verified via Round M2's ledger-source reads and
  // desktop's own Round 10/19 fix for the same field), not name.
  async pickAssignedTo() {
    const items = (this.contractors || []).map(c => ({ value: c.contractorName, label: MApp.Util.formatNameCase(c.contractorName) }));
    const picked = await MApp.Picker.open({
      title: 'Assigned to', items, selectedValue: this.selectedAssignedTo, allowCustom: true
    });
    if (!picked) return;
    this.selectedAssignedTo = picked.value;
    this._updateFieldLabel('lot-assignedto-field', picked.label);
    // A fresh contractor pick invalidates whatever Extra Charge was
    // showing (it belonged to the previous contractor's own rate card) --
    // same reasoning as desktop's refreshExtraChargeOptions reset.
    this.selectedExtraChargeType = '';
    this._updateFieldLabel('lot-extracharge-field', 'None');
  },

  // Extra Charge (Layer 2) options are scoped to whichever contractor is
  // currently Assigned To -- every contractor can offer a different set,
  // so this always fetches fresh rather than caching across contractors.
  async pickExtraCharge() {
    if (!this.selectedAssignedTo) {
      MApp.Toast.error('Choose a contractor first.');
      return;
    }
    let charges = [];
    try {
      const res = await MApp.Api.call('getContractorServiceChargesForContractor', this.selectedAssignedTo);
      charges = (res && res.success) ? (res.data || []) : [];
    } catch (err) {
      charges = [];
    }
    const items = [
      { value: '', label: 'None' },
      ...charges.map(c => ({ value: c.serviceType, label: `${c.serviceType} (+${MApp.Util.formatCurrency(c.chargeAmount)})` }))
    ];
    const picked = await MApp.Picker.open({ title: 'Extra charge', items, selectedValue: this.selectedExtraChargeType });
    if (!picked) return;
    this.selectedExtraChargeType = picked.value;
    this._updateFieldLabel('lot-extracharge-field', picked.value ? picked.label : 'None');
  },

  setStatus(status) {
    this.selectedStatus = status;
    document.querySelectorAll('#lot-status-row [data-status]').forEach(btn => {
      btn.classList.toggle('checked', btn.dataset.status === status);
    });
  },

  // ── Color checklist (chips + stepper) ───────────────────────────────
  _renderQtyOrColorSection() {
    const qtyWrap = document.getElementById('lot-qty-wrap');
    const colorWrap = document.getElementById('lot-color-wrap');
    if (!qtyWrap || !colorWrap) return;

    if (!this.flatColors || this.flatColors.length === 0) {
      colorWrap.classList.add('mb-hidden');
      colorWrap.innerHTML = '';
      qtyWrap.classList.remove('mb-hidden');
      return;
    }

    qtyWrap.classList.add('mb-hidden');
    colorWrap.classList.remove('mb-hidden');

    const isMultiAxis = this.axes.length >= 2;

    // The "pick which group is Primary" step primaryIsDefault has always
    // documented but never actually had. Without it, primaryAxisKey fell
    // back to whatever axis sits first in recipe order, the lot's
    // quantities were attributed to it, AND saveLot sent it as
    // formData.primaryColorAxis -- which save_production persists as this
    // process's default from then on (_set_process_primary_color_axis).
    // So a choice nobody made got silently locked in from mobile, the
    // exact outcome the desktop form refuses to allow (see
    // renderGroupedColorChecklist, which leaves its Primary radio
    // unchecked for the same reason). The colour chips are withheld until
    // the choice is made because which axis is Primary decides which
    // colours carry the lot's quantity at all.
    if (isMultiAxis && this.primaryIsDefault) {
      colorWrap.innerHTML = `
        <div class="mapp-section-label">Which group is Primary?</div>
        <div class="mb-field-hint">This process has more than one independent colour group. The Primary group's quantities become this lot's total — the others are recorded per colour but don't add to it.</div>
        <div class="mb-color-chip-list mb-mt-2" id="lot-primary-axis-pick">
          ${this.axes.map(a => `
            <button type="button" class="mb-color-chip" style="min-width:auto;padding:10px 16px;" data-primary-axis-key="${MApp.Util.escapeHtml(a.key)}">
              ${MApp.Util.escapeHtml(a.label)}
            </button>`).join('')}
        </div>`;
      colorWrap.querySelectorAll('[data-primary-axis-key]').forEach(el => {
        el.addEventListener('click', () => this.pickPrimaryAxis(el.dataset.primaryAxisKey));
      });
      return;
    }

    const primaryAxis = isMultiAxis ? (this.axes.find(a => a.key === this.primaryAxisKey) || this.axes[0]) : null;
    const primaryColors = isMultiAxis ? primaryAxis.colors : this.flatColors;
    const secondaryAxes = isMultiAxis ? this.axes.filter(a => a !== primaryAxis) : [];
    const total = this.currentTotalQty();

    let html = `<div class="mapp-section-label">${MApp.Util.escapeHtml(isMultiAxis ? primaryAxis.label : 'Colors produced')}</div>`;
    html += `<div class="mb-color-chip-list" id="lot-primary-chips">`;
    primaryColors.forEach(color => { html += this._colorChipHtml(color); });
    html += `</div><div class="mb-text-sm mb-text-steel mb-mt-2" id="lot-total-qty-display">Total: ${total} unit(s)</div>`;

    secondaryAxes.forEach(axis => {
      html += `<div class="mapp-section-label mb-mt-4">${MApp.Util.escapeHtml(axis.label)}</div><div class="mb-color-chip-list">`;
      axis.colors.forEach(color => { html += this._secondaryChipHtml(axis.key, color); });
      html += '</div>';
    });

    colorWrap.innerHTML = html;
    this._wireColorSectionEvents();
  },

  // Records THIS lot's Primary Axis choice (see _renderQtyOrColorSection's
  // picker). Any colour quantities already entered are dropped: they were
  // entered against a different axis's colour list, so carrying them over
  // would attribute one axis's quantities to another.
  pickPrimaryAxis(axisKey) {
    if (!axisKey || !this.axes.some(a => a.key === axisKey)) return;
    this.primaryAxisKey = axisKey;
    this.primaryIsDefault = false;
    this.colorQtyByColor = {};
    this.secondaryChoice = {};
    this._renderQtyOrColorSection();
  },

  _wireColorSectionEvents() {
    const colorWrap = document.getElementById('lot-color-wrap');
    if (!colorWrap) return;

    colorWrap.querySelectorAll('[data-chip-color]').forEach(el => {
      const color = el.dataset.chipColor;
      const toggleBtn = el.querySelector('[data-chip-toggle]');
      if (toggleBtn) toggleBtn.addEventListener('click', () => this.toggleColorChip(color));
      const minus = el.querySelector('[data-step="-1"]');
      const plus = el.querySelector('[data-step="1"]');
      if (minus) minus.addEventListener('click', () => this.stepColor(color, -1));
      if (plus) plus.addEventListener('click', () => this.stepColor(color, 1));
    });

    colorWrap.querySelectorAll('[data-secondary-chip]').forEach(el => {
      el.addEventListener('click', () => this.pickSecondaryColor(el.dataset.axisKey, el.dataset.color));
    });
  },

  _colorChipHtml(color) {
    const qty = this.colorQtyByColor[color] || 0;
    const checked = qty > 0;
    return `
      <div class="mb-color-chip${checked ? ' checked' : ''}" data-chip-color="${MApp.Util.escapeHtml(color)}">
        <button type="button" class="mb-color-chip-toggle" data-chip-toggle>
          <span class="mb-flex-row"><span class="mb-color-chip-swatch" style="background:${this._swatchColor(color)};"></span>${MApp.Util.escapeHtml(color)}</span>
        </button>
        ${checked ? `
          <div class="mb-stepper">
            <button type="button" class="mb-stepper-btn" data-step="-1">−</button>
            <span class="mb-stepper-value">${qty}</span>
            <button type="button" class="mb-stepper-btn" data-step="1">+</button>
          </div>` : ''}
      </div>`;
  },

  _secondaryChipHtml(axisKey, color) {
    const selected = this.secondaryChoice[axisKey] === color;
    return `
      <button type="button" class="mb-color-chip${selected ? ' checked' : ''}" style="min-width:auto;padding:10px 16px;" data-secondary-chip data-axis-key="${MApp.Util.escapeHtml(axisKey)}" data-color="${MApp.Util.escapeHtml(color)}">
        <span class="mb-flex-row"><span class="mb-color-chip-swatch" style="background:${this._swatchColor(color)};"></span>${MApp.Util.escapeHtml(color)}</span>
      </button>`;
  },

  // Best-effort CSS swatch for a Color Master name — recognizes common
  // color words, else a deterministic hash-based hue so unrecognized
  // names still get a distinct, stable dot.
  _swatchColor(name) {
    const known = {
      blue: '#1d5fa8', red: '#c81e3a', green: '#1e8a5f', orange: '#ff6a13',
      black: '#14181c', white: '#f3f5f6', yellow: '#e8a400', pink: '#e0669b',
      purple: '#7b4fa6', grey: '#8a97a0', gray: '#8a97a0', silver: '#b7c0c6',
      gold: '#c9a227', maroon: '#7a2030', navy: '#1b3a63', teal: '#1f7a7a', brown: '#7a5230'
    };
    const lower = String(name || '').toLowerCase();
    for (const key in known) {
      if (lower.includes(key)) return known[key];
    }
    let hash = 0;
    for (let i = 0; i < lower.length; i++) hash = (hash * 31 + lower.charCodeAt(i)) >>> 0;
    return `hsl(${hash % 360}, 55%, 45%)`;
  },

  toggleColorChip(color) {
    const current = this.colorQtyByColor[color] || 0;
    this.colorQtyByColor[color] = current > 0 ? 0 : 1;
    this._renderQtyOrColorSection();
  },

  stepColor(color, delta) {
    const next = Math.max(0, (this.colorQtyByColor[color] || 0) + delta);
    this.colorQtyByColor[color] = next;
    this._renderQtyOrColorSection();
  },

  pickSecondaryColor(axisKey, color) {
    this.secondaryChoice[axisKey] = color;
    this._renderQtyOrColorSection();
  },

  currentTotalQty() {
    if (!this.flatColors || this.flatColors.length === 0) {
      return MApp.Util.toNumber(document.getElementById('lot-qty')?.value);
    }
    return Object.values(this.colorQtyByColor).reduce((s, q) => s + (q || 0), 0);
  },

  // Scales this process's recipe (qtyPerUnit) by the lot's total qty for
  // COMMON components, or by that color's own qty for color-scoped ones —
  // the recipe's qtyPerUnit is defined as exactly this ("qty needed per
  // unit of process output"), so this is the recipe's own default, not a
  // guess. Desktop additionally lets an operator hand-override individual
  // component quantities on a per-lot basis; that power-user editing step
  // is out of scope for the mobile "log it and move on" flow.
  buildComponentsConsumed(totalQty, colorBreakdown) {
    const components = [];
    (this.recipeComponents || []).forEach(r => {
      if (!r.itemName) return;
      const isCommon = !r.colorGroup || r.colorGroup.toUpperCase() === 'COMMON';
      let qty;
      let color = '';

      if (isCommon) {
        qty = r.qtyPerUnit * totalQty;
      } else if (colorBreakdown && colorBreakdown.length) {
        const match = colorBreakdown.find(c => c.color.toLowerCase() === r.colorGroup.toLowerCase());
        if (!match) return;
        qty = r.qtyPerUnit * match.qty;
        color = match.color;
      } else {
        return;
      }

      if (qty <= 0) return;
      components.push({
        itemName: r.itemName,
        size: r.size || '',
        color: color,
        sourceType: r.sourceType,
        qty: Math.round(qty * 1000) / 1000,
        colorGroup: isCommon ? 'COMMON' : r.colorGroup,
        // The recipe row's own Unit must ride along, exactly as the desktop
        // form carries it (production.js addComponentRow/_readProdComponentRow).
        // qtyPerUnit is expressed IN that unit, and both consumption paths
        // convert a non-blank unit to the item's Base Unit before debiting
        // (stock_service for ITEM rows, warehouse_service Pass 2 for POOL
        // rows) -- a blank unit means "already in Base Unit". Omitting it
        // therefore did not merely lose a label: a recipe row measured in
        // e.g. Dozen was debited as if its number were Pcs, so a
        // mobile-logged lot silently under-consumed Stock/Warehouse Pool by
        // that item's whole conversion factor, while the identical lot
        // logged on desktop consumed the right amount.
        unit: r.unit || ''
      });
    });
    return components;
  },

  // Note: source's own single-verb _apiCall handled both reads and
  // writes -- saveProduction is mutation=True server-side (registry.py),
  // so this call uses Api.mutateWithId, not .call, unlike source.
  async saveLot() {
    if (!this.selection.process) {
      MApp.Toast.error('Choose a process first.');
      return;
    }
    if (!this.selectedAssignedTo) {
      MApp.Toast.error('Choose or add who this lot is assigned to.');
      return;
    }
    // Mirrors save_production's own "Pick which group is Primary" refusal,
    // caught here so the operator is sent back to the picker instead of to
    // a server error (see _renderQtyOrColorSection).
    if (this.axes.length >= 2 && this.primaryIsDefault) {
      MApp.Toast.error('Pick which colour group is Primary before saving.');
      return;
    }

    const totalQty = this.currentTotalQty();
    if (!totalQty || totalQty <= 0) {
      MApp.Toast.error(this.flatColors.length > 0
        ? 'Select at least one color and set its quantity.'
        : 'Enter a quantity greater than zero.');
      return;
    }

    let colorBreakdown = null;
    if (this.flatColors.length > 0) {
      colorBreakdown = [];
      Object.keys(this.colorQtyByColor).forEach(color => {
        const qty = this.colorQtyByColor[color];
        if (qty > 0) colorBreakdown.push({ color, qty, isCustom: false, countsTowardTotal: true, axisKey: this.primaryAxisKey || '' });
      });
      Object.keys(this.secondaryChoice).forEach(axisKey => {
        const color = this.secondaryChoice[axisKey];
        if (color) colorBreakdown.push({ color, qty: totalQty, isCustom: false, countsTowardTotal: false, axisKey });
      });
    }

    const componentsConsumed = this.buildComponentsConsumed(totalQty, colorBreakdown);
    if (componentsConsumed.length === 0) {
      MApp.Toast.error('This process has no recipe configured yet — add its components on the desktop Products & Processes tab first.');
      return;
    }

    const formData = {
      date: document.getElementById('lot-date')?.value || MApp.Util.todayInputValue(),
      processId: this.selection.process.processId,
      assignedBy: (document.getElementById('lot-assignedby')?.value || '').trim(),
      assignedTo: this.selectedAssignedTo,
      extraChargeType: this.selectedExtraChargeType || '',
      status: this.selectedStatus || 'Pending',
      remarks: (document.getElementById('lot-remarks')?.value || '').trim(),
      componentsConsumed: JSON.stringify(componentsConsumed)
    };

    if (!colorBreakdown) {
      formData.qty = totalQty;
    } else {
      formData.colorBreakdown = JSON.stringify(colorBreakdown);
      if (this.axes.length >= 2) {
        const primaryAxis = this.axes.find(a => a.key === this.primaryAxisKey);
        if (primaryAxis) formData.primaryColorAxis = primaryAxis.label;
      }
    }

    if (this.selection.process.isFinalStage && this.selection.productId) {
      formData.productId = this.selection.productId;
      formData.productName = this.selection.productName;
    }

    if (this.editingLot) {
      formData.rowIdx = this.editingLot.rowIdx;
      // A lot's Output Item Name is editable per lot on desktop (a
      // rework/variant run credits its own Warehouse Pool bucket), and
      // save_production falls back to the PROCESS's default whenever this
      // field arrives blank. Omitting it therefore didn't leave the saved
      // value alone -- it silently reset a customised lot back to the
      // process default, moving that lot's pool credit into a different
      // bucket, just from opening it on mobile and pressing Save.
      if (this.editingLot.outputItemName) formData.outputItemName = this.editingLot.outputItemName;
    }

    // Note: re-enabling after this point is NOT a single blanket
    // setSheetBusy(false) in a finally block — on success, resetLogLotForm()
    // replaces the body with fresh HTML that already bakes in the correct
    // "nothing chosen yet" disabled states (Model/Type/Process locked
    // again); a blanket re-enable afterwards would incorrectly unlock them.
    // Only the failure path restores the still-populated form via
    // setSheetBusy, since nothing was reset there.
    // Phase 6: mutation-id generated once, reused for both this live
    // attempt and any later outbox replay (see MApp.Stock.submitAdjust's
    // own comment for why -- same reasoning applies to every mutation).
    const mutationId = Api.newMutationId();

    const isEdit = !!this.editingLot;
    const busyLabel = isEdit ? 'Saving…' : 'Logging…';
    const idleLabel = isEdit ? 'Save Changes' : 'Log Lot';

    MApp.Util.setSheetBusy('log-lot-body', 'log-lot-save-btn', true, busyLabel);
    try {
      const res = await Api.mutateWithId('saveProduction', mutationId, formData);
      if (!res || !res.success) {
        MApp.Toast.error((res && res.message) || 'Could not save this lot.');
        MApp.Util.setSheetBusy('log-lot-body', 'log-lot-save-btn', false, null, idleLabel);
        return;
      }
      await this._onLotSaved(isEdit ? 'Lot updated.' : `Lot logged${res.data && res.data.lotNumber ? ' — ' + res.data.lotNumber : ''}.`);
    } catch (err) {
      if (err && err.isNetworkError) {
        // The fetch itself never reached the server -- queue under the
        // same mutationId. A stale processId/productId reference (the
        // process was deleted/deactivated by replay time) isn't a gap
        // here: it just surfaces as an ordinary {success:false} on
        // replay, which MApp.Outbox.flush() already handles (marks this
        // one entry failed with the real server message, doesn't block
        // the rest of the queue).
        await OfflineCache.outbox.enqueue(mutationId, 'saveProduction', [formData]);
        MApp.Outbox.updateBadge();
        MApp.Outbox.requestSync();
        await this._onLotSaved('Saved — will sync when back online.');
        return;
      }
      // Reached the server but got a real HTTP-level failure -- not safe
      // to queue for blind retry.
      MApp.Toast.error(err.message || 'Could not save this lot. Please try again.');
      MApp.Util.setSheetBusy('log-lot-body', 'log-lot-save-btn', false, null, idleLabel);
    }
  },

  // Create keeps the sheet OPEN and resets to a blank form so an operator
  // can log several lots back-to-back without re-opening the sheet each
  // time; an edit closes it instead -- "reset to a blank create form"
  // makes no sense as the result of editing one specific existing lot.
  async _onLotSaved(message) {
    MApp.Toast.success(message);
    const saveBtn = document.getElementById('log-lot-save-btn');
    if (this.editingLot) {
      this.editingLot = null;
      this.closeLogLotSheet();
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Log Lot'; }
    } else {
      await this.resetLogLotForm();
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Log Lot'; }
    }
    this.load();
  },

  async resetLogLotForm() {
    this.selection = { size: '', model: '', type: '', processId: '', process: null, productId: '', productName: '' };
    this.flatColors = [];
    this.axes = [];
    this.primaryAxisKey = '';
    this.primaryIsDefault = false;
    this.recipeComponents = [];
    this.colorQtyByColor = {};
    this.secondaryChoice = {};
    this.selectedStatus = 'Pending';
    this.selectedAssignedTo = '';
    this.selectedExtraChargeType = '';
    document.getElementById('log-lot-body').innerHTML = this._formHtml();
  }
};
// ================================================================
// DISPATCH — card list + "New Dispatch" sheet + Print Challan, which
// reuses print.html's #print-dispatch-container verbatim (that
// template is dedicated to dispatch challans only — confirmed not
// shared with PO/other print types) via MApp.Print.trigger.
// ================================================================
MApp.Dispatch = {
  dispatches: [],
  clients: [],
  readyToDispatch: [],
  contractors: [],
  _todayOnly: false,
  // Phase 2: header-only fields stay in `selection`; line items (product +
  // qty, one-or-more) move to `lines` -- saveDispatch already accepts
  // form_data.lines as an array server-side, mobile was just choosing to
  // always send a length-1 one.
  selection: { clientName: '', logisticsContractor: '' },
  lines: [],
  editingDispatchNumber: null,

  mount() {
    this.load();
  },

  async load() {
    const listEl = document.getElementById('dispatch-list');
    MApp.Util.renderSkeleton(listEl, 4);

    // getClientsData here is supplementary (client address/gstin lookup
    // for print(), plus the New Dispatch sheet's own reference data) --
    // best-effort, caught independently so it can never block Dispatch's
    // own offline-cached list render, same pattern as Round 1's Stock fix
    // and this round's Production fix.
    const clientsPromise = MApp.Api.call('getClientsData').catch(() => null);

    try {
      const dispatchRes = await MApp.Api.callCached('getDispatchData');
      if (!dispatchRes || !dispatchRes.success) {
        MApp.Util.renderError(listEl, dispatchRes && dispatchRes.message, () => this.load());
        return;
      }

      const clientsRes = await clientsPromise;
      this.dispatches = dispatchRes.data || [];
      this.clients = (clientsRes && clientsRes.success) ? (clientsRes.data || []) : [];

      this._todayOnly = MApp.State.dispatchFilter === 'today';
      MApp.State.dispatchFilter = '';
      this._offlineCachedAt = dispatchRes._offlineCachedAt || null;
      this._pendingSyncCount = await OfflineCache.outbox.countPendingForMethod('saveDispatch');

      this.render();
    } catch (err) {
      MApp.Util.renderError(listEl, err && err.message, () => this.load());
    }
  },

  render() {
    const listEl = document.getElementById('dispatch-list');
    if (!listEl) return;

    let list = this.dispatches;
    const offlineBanner = this._offlineCachedAt ? MApp.Util.offlineBannerHtml(this._offlineCachedAt) : '';
    const pendingSyncBanner = this._pendingSyncCount > 0
      ? MApp.Util.pendingSyncBannerHtml(this._pendingSyncCount, 'dispatch', 'dispatches')
      : '';
    const todayBanner = this._todayOnly
      ? `<div class="mb-offline-banner" style="background:var(--mb-safety-faint);color:var(--mb-ink);margin-bottom:var(--mb-sp-3);">
           <span>Showing today's dispatches only</span>
           <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" data-clear-filter>Clear</button>
         </div>`
      : '';
    const banner = offlineBanner + pendingSyncBanner + todayBanner;
    if (this._todayOnly) {
      list = list.filter(d => MApp.Util.isToday(d.dateRaw));
    }

    if (list.length === 0) {
      listEl.innerHTML = banner;
      const empty = document.createElement('div');
      listEl.appendChild(empty);
      MApp.Util.renderEmpty(empty, { title: 'No dispatches yet', body: 'Tap + to record the first dispatch.' });
    } else {
      listEl.innerHTML = banner + list.slice(0, 50).map((d, idx) => `
        <div class="mb-card">
          <div class="mb-card-row">
            <div>
              <div class="mb-card-title">${MApp.Util.escapeHtml(d.dispatchNumber)}</div>
              <div class="mb-card-sub">${MApp.Util.escapeHtml(MApp.Util.formatNameCase(d.clientName) || 'Direct supply')}</div>
            </div>
            <div style="text-align:right;">
              <div class="mb-card-number">${d.qty}</div>
              <div class="mb-card-sub">${MApp.Util.formatDateDisplay(d.dateRaw)}</div>
            </div>
          </div>
          <div class="mb-card-sub mb-mt-2">${MApp.Util.escapeHtml(d.productName)}</div>
          <button type="button" class="mb-btn mb-btn-secondary mb-mt-2" style="min-height:40px;" data-print-idx="${idx}">Print Challan</button>
          <div class="mb-mt-2" style="display:flex; gap:var(--mb-sp-4);">
            <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" data-dispatch-action="edit" data-dispatch-number="${MApp.Util.escapeHtml(d.dispatchNumber)}">Edit</button>
            <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;color:var(--mb-enamel-red);" data-dispatch-action="delete" data-dispatch-number="${MApp.Util.escapeHtml(d.dispatchNumber)}">Delete</button>
          </div>
        </div>
      `).join('');
    }

    const clearBtn = listEl.querySelector('[data-clear-filter]');
    if (clearBtn) clearBtn.addEventListener('click', () => { this._todayOnly = false; this.render(); });

    listEl.querySelectorAll('[data-print-idx]').forEach(btn => {
      btn.addEventListener('click', () => this.print(parseInt(btn.dataset.printIdx, 10), list));
    });

    // A dispatch with multiple lines renders as several cards sharing the
    // same dispatchNumber (getDispatchData is flattened one-row-per-line,
    // same as the rest of this list) -- Edit/Delete operate on the whole
    // dispatch (all its lines), matching deleteDispatch's own contract, so
    // any of its cards' buttons resolves to the same grouped action.
    listEl.querySelectorAll('[data-dispatch-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const number = btn.dataset.dispatchNumber;
        if (btn.dataset.dispatchAction === 'edit') this.openEditSheet(number);
        else this.deleteDispatch(number);
      });
    });
  },

  print(idx, listRef) {
    const d = (listRef || this.dispatches)[idx];
    if (!d) return;

    const client = (this.clients || []).find(c => c.name === d.clientName);
    const setText = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val || '';
    };

    setText('print-dispatch-number', d.dispatchNumber);
    setText('print-dispatch-date', d.dispatchDate);
    setText('print-dispatch-client', MApp.Util.formatNameCase(d.clientName) || 'Direct Supply');
    setText('print-dispatch-client-address', client ? client.address : '');
    setText('print-dispatch-client-gstin', client && client.gstin ? 'GSTIN: ' + client.gstin : '');
    setText('print-dispatch-transport', d.transport);
    setText('print-dispatch-order-ref', d.orderNumber);
    setText('print-dispatch-gr-ref', d.grNumber || d.invoiceNumber || '');
    setText('print-dispatch-remarks', d.remarks);

    const body = document.getElementById('print-dispatch-items-body');
    if (body) {
      body.innerHTML = `
        <tr>
          <td style="padding:8px 6px;border:1px solid #ccc;">1</td>
          <td style="padding:8px 6px;border:1px solid #ccc;text-align:left;">${MApp.Util.escapeHtml(d.productName)} (${MApp.Util.escapeHtml(d.productId)})</td>
          <td style="padding:8px 6px;border:1px solid #ccc;"></td>
          <td style="padding:8px 6px;border:1px solid #ccc;">${d.qty}</td>
          <td style="padding:8px 6px;border:1px solid #ccc;">Pcs</td>
        </tr>`;
    }

    MApp.Print.trigger('print-dispatch-container', `Challan ${d.dispatchNumber}`);
  },

  // ── New Dispatch sheet ──────────────────────────────────────────────
  async openNewDispatchSheet() {
    this.editingDispatchNumber = null;
    this.selection = { clientName: '', logisticsContractor: '' };
    this.lines = [{ productId: '', productName: '', qty: '', readyQty: null }];

    const titleEl = document.querySelector('#sheet-new-dispatch h2');
    if (titleEl) titleEl.textContent = 'New Dispatch';
    const saveBtn = document.getElementById('new-dispatch-save-btn');
    if (saveBtn) saveBtn.textContent = 'Save Dispatch';

    document.getElementById('new-dispatch-body').innerHTML = `
      <div class="mb-skel mb-skel-card" style="height:56px;"></div>
      <div class="mb-skel mb-skel-card" style="height:56px;"></div>
      <div class="mb-skel mb-skel-card" style="height:56px;"></div>`;
    MApp.Sheet.open('sheet-new-dispatch');

    if (saveBtn) saveBtn.disabled = true;

    try {
      await this._ensureRefData();
      document.getElementById('new-dispatch-body').innerHTML = this._formHtml();
    } catch (err) {
      MApp.Toast.error('Could not load dispatch reference data: ' + (err.message || ''));
      this.closeNewDispatchSheet();
      return;
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  },

  closeNewDispatchSheet() {
    MApp.Sheet.close('sheet-new-dispatch');
  },

  // ── Edit (Phase 2) — groups every line sharing this dispatchNumber
  // (getDispatchData is flattened one-row-per-line) back into `this.lines`,
  // and reuses the header fields off any one of those rows (they're
  // duplicated per line in the flattened list).
  async openEditSheet(dispatchNumber) {
    const groupLines = this.dispatches.filter(d => d.dispatchNumber === dispatchNumber);
    if (groupLines.length === 0) return;
    const header = groupLines[0];

    this.editingDispatchNumber = dispatchNumber;
    this.selection = { clientName: header.clientName || '', logisticsContractor: header.logisticsContractor || '' };
    this.lines = groupLines.map(l => ({ productId: l.productId, productName: l.productName, qty: l.qty, readyQty: null }));

    const titleEl = document.querySelector('#sheet-new-dispatch h2');
    if (titleEl) titleEl.textContent = 'Edit Dispatch';
    const saveBtn = document.getElementById('new-dispatch-save-btn');
    if (saveBtn) saveBtn.textContent = 'Save Changes';

    document.getElementById('new-dispatch-body').innerHTML = `
      <div class="mb-skel mb-skel-card" style="height:56px;"></div>
      <div class="mb-skel mb-skel-card" style="height:56px;"></div>
      <div class="mb-skel mb-skel-card" style="height:56px;"></div>`;
    MApp.Sheet.open('sheet-new-dispatch');
    if (saveBtn) saveBtn.disabled = true;

    try {
      await this._ensureRefData();
      document.getElementById('new-dispatch-body').innerHTML = this._formHtml();

      const setValue = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
      setValue('dispatch-date', dateToInputValue(header.dateRaw, header.dispatchDate));
      setValue('dispatch-transport', header.transport);
      setValue('dispatch-order-number', header.orderNumber);
      setValue('dispatch-invoice-number', header.invoiceNumber);
      setValue('dispatch-private-mark', header.privateMark);
      setValue('dispatch-gr-number', header.grNumber);
      setValue('dispatch-remarks', header.remarks);

      if (header.clientName) {
        const clientField = document.getElementById('dispatch-client-field');
        if (clientField) { clientField.textContent = MApp.Util.formatNameCase(header.clientName); clientField.classList.remove('mb-placeholder'); }
      }
      if (header.logisticsContractor) {
        const logisticsField = document.getElementById('dispatch-logistics-field');
        if (logisticsField) { logisticsField.textContent = MApp.Util.formatNameCase(header.logisticsContractor); logisticsField.classList.remove('mb-placeholder'); }
      }
    } catch (err) {
      MApp.Toast.error('Could not load this dispatch: ' + (err.message || ''));
      this.closeNewDispatchSheet();
      return;
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  },

  async deleteDispatch(dispatchNumber) {
    if (!MApp.Util.confirmDelete(dispatchNumber)) return;
    const res = await MApp.Util.mutateSimple('deleteDispatch', [dispatchNumber], 'Dispatch deleted.');
    if (res.success) this.load();
  },

  async _ensureRefData() {
    if (this.clients.length === 0) await this.load();

    const [readyRes, contractorsRes] = await Promise.all([
      MApp.Api.call('getReadyToDispatchData'),
      MApp.Api.call('getContractorsData')
    ]);
    this.readyToDispatch = (readyRes && readyRes.success) ? (readyRes.data || []) : [];
    this.contractors = (contractorsRes && contractorsRes.success) ? (contractorsRes.data || []) : [];
  },

  _formHtml() {
    return `
      <div class="mb-field">
        <label for="dispatch-date">Date</label>
        <input type="date" id="dispatch-date" value="${MApp.Util.todayInputValue()}">
      </div>

      <div class="mb-field">
        <label>Client</label>
        <button type="button" class="mb-picker-field mb-placeholder" id="dispatch-client-field" onclick="MApp.Dispatch.pickClient()">Choose a client (optional)...</button>
      </div>

      <div class="mapp-section-label">Items</div>
      <div id="dispatch-lines">${this._linesHtml()}</div>
      <button type="button" class="mb-btn mb-btn-secondary mb-mt-2 mb-mb-4" onclick="MApp.Dispatch.addLine()">+ Add Item</button>

      <div class="mb-field">
        <label for="dispatch-transport">Transport / vehicle</label>
        <input type="text" id="dispatch-transport" placeholder="e.g. Truck no. PB-10-1234">
      </div>

      <div class="mb-field">
        <label>Logistics contractor (optional)</label>
        <button type="button" class="mb-picker-field mb-placeholder" id="dispatch-logistics-field" onclick="MApp.Dispatch.pickLogistics()">Choose or add...</button>
      </div>

      <div class="mb-field">
        <label for="dispatch-order-number">PI / Estimate reference (optional)</label>
        <input type="text" id="dispatch-order-number" placeholder="e.g. ORD-1042">
      </div>

      <div class="mb-field">
        <label for="dispatch-invoice-number">Invoice number (optional)</label>
        <input type="text" id="dispatch-invoice-number">
      </div>

      <div class="mb-field">
        <label for="dispatch-private-mark">Private mark (optional)</label>
        <input type="text" id="dispatch-private-mark">
      </div>

      <div class="mb-field">
        <label for="dispatch-gr-number">GR number (optional)</label>
        <input type="text" id="dispatch-gr-number">
      </div>

      <div class="mb-field">
        <label for="dispatch-remarks">Remarks (optional)</label>
        <textarea id="dispatch-remarks" rows="3" placeholder="Notes for this dispatch..."></textarea>
      </div>
    `;
  },

  async pickClient() {
    const items = (this.clients || []).map(c => ({ value: c.name, label: MApp.Util.formatNameCase(c.name) }));
    const picked = await MApp.Picker.open({ title: 'Choose a client', items, selectedValue: this.selection.clientName, allowCustom: true });
    if (!picked) return;
    this.selection.clientName = picked.value;
    const el = document.getElementById('dispatch-client-field');
    if (el) { el.textContent = picked.label; el.classList.remove('mb-placeholder'); }
  },

  // ── Line items (Phase 2) ─────────────────────────────────────────────
  _linesHtml() {
    if (this.lines.length === 0) return '<div class="mb-text-sm mb-text-steel mb-mb-2">No items added yet.</div>';
    return this.lines.map((line, i) => `
      <div class="mb-card" style="padding:var(--mb-sp-3);">
        <div class="mb-field" style="margin-bottom:var(--mb-sp-2);">
          <label>Product</label>
          <button type="button" class="mb-picker-field${line.productId ? '' : ' mb-placeholder'}" onclick="MApp.Dispatch.pickLineProduct(${i})">${MApp.Util.escapeHtml(line.productName || 'Choose a product...')}</button>
          ${line.readyQty != null ? `<div class="mb-field-hint">${line.readyQty} unit(s) ready to dispatch</div>` : ''}
        </div>
        <div class="mb-field" style="margin-bottom:0;">
          <label>Quantity</label>
          <input type="number" inputmode="decimal" min="0" step="1" value="${line.qty || ''}" oninput="MApp.Dispatch.updateLineQty(${i}, this.value)">
        </div>
        ${this.lines.length > 1 ? `<button type="button" class="mb-btn-text mb-mt-2" style="padding:0;min-height:auto;color:var(--mb-enamel-red);" onclick="MApp.Dispatch.removeLine(${i})">Remove</button>` : ''}
      </div>
    `).join('');
  },

  addLine() {
    this.lines.push({ productId: '', productName: '', qty: '', readyQty: null });
    const el = document.getElementById('dispatch-lines');
    if (el) el.innerHTML = this._linesHtml();
  },

  removeLine(i) {
    this.lines.splice(i, 1);
    if (this.lines.length === 0) this.lines.push({ productId: '', productName: '', qty: '', readyQty: null });
    const el = document.getElementById('dispatch-lines');
    if (el) el.innerHTML = this._linesHtml();
  },

  updateLineQty(i, value) {
    if (!this.lines[i]) return;
    this.lines[i].qty = MApp.Util.toNumber(value);
  },

  async pickLineProduct(i) {
    if (!this.lines[i]) return;
    const items = (this.readyToDispatch || []).map(p => ({
      value: p.productId, label: p.productName, sublabel: `Ready: ${p.readyQty}`
    }));
    const picked = await MApp.Picker.open({ title: 'Choose a product', items, selectedValue: this.lines[i].productId });
    if (!picked) return;

    const match = (this.readyToDispatch || []).find(p => p.productId === picked.value);
    this.lines[i].productId = picked.value;
    this.lines[i].productName = picked.label;
    this.lines[i].readyQty = match ? match.readyQty : null;

    const el = document.getElementById('dispatch-lines');
    if (el) el.innerHTML = this._linesHtml();
  },

  // Fixed from source's own c.name -- getContractorsData returns
  // contractorName, not name (same fix as Production's pickAssignedTo).
  async pickLogistics() {
    const items = (this.contractors || []).map(c => ({ value: c.contractorName, label: MApp.Util.formatNameCase(c.contractorName) }));
    const picked = await MApp.Picker.open({ title: 'Logistics contractor', items, selectedValue: this.selection.logisticsContractor, allowCustom: true });
    if (!picked) return;
    this.selection.logisticsContractor = picked.value;
    const el = document.getElementById('dispatch-logistics-field');
    if (el) { el.textContent = picked.label; el.classList.remove('mb-placeholder'); }
  },

  // Note: source's own single-verb _apiCall handled both reads and
  // writes -- saveDispatch is mutation=True server-side (registry.py),
  // so this call uses Api.mutateWithId, not .call, unlike source.
  async save() {
    const validLines = this.lines.filter(l => l.productId && l.qty > 0);
    if (validLines.length === 0) {
      MApp.Toast.error('Add at least one item with a product and quantity greater than zero.');
      return;
    }

    const formData = {
      dispatchDate: document.getElementById('dispatch-date')?.value || MApp.Util.todayInputValue(),
      clientName: this.selection.clientName || '',
      lines: JSON.stringify(validLines.map(l => ({ productId: l.productId, productName: l.productName, qty: l.qty }))),
      transport: (document.getElementById('dispatch-transport')?.value || '').trim(),
      logisticsContractor: this.selection.logisticsContractor || '',
      orderNumber: (document.getElementById('dispatch-order-number')?.value || '').trim(),
      invoiceNumber: (document.getElementById('dispatch-invoice-number')?.value || '').trim(),
      privateMark: (document.getElementById('dispatch-private-mark')?.value || '').trim(),
      grNumber: (document.getElementById('dispatch-gr-number')?.value || '').trim(),
      remarks: (document.getElementById('dispatch-remarks')?.value || '').trim()
    };
    if (this.editingDispatchNumber) formData.existingDispatchNumber = this.editingDispatchNumber;

    const isEdit = !!this.editingDispatchNumber;
    const idleLabel = isEdit ? 'Save Changes' : 'Save Dispatch';
    const mutationId = Api.newMutationId();

    MApp.Util.setSheetBusy('new-dispatch-body', 'new-dispatch-save-btn', true, 'Saving…');
    try {
      const res = await Api.mutateWithId('saveDispatch', mutationId, formData);
      if (!res || !res.success) {
        MApp.Toast.error((res && res.message) || 'Could not save this dispatch.');
        MApp.Util.setSheetBusy('new-dispatch-body', 'new-dispatch-save-btn', false, null, idleLabel);
        return;
      }
      this._onDispatchSaved(isEdit ? 'Dispatch updated.' : `Dispatch saved${res.data && res.data.dispatchNumber ? ' — ' + res.data.dispatchNumber : ''}.`);
    } catch (err) {
      if (err && err.isNetworkError) {
        // The fetch itself never reached the server -- queue under the
        // same mutationId. A stale Ready-to-Dispatch reference by replay
        // time isn't a gap: it surfaces as an ordinary {success:false},
        // already handled by MApp.Outbox.flush()'s markFailed branch.
        await OfflineCache.outbox.enqueue(mutationId, 'saveDispatch', [formData]);
        MApp.Outbox.updateBadge();
        MApp.Outbox.requestSync();
        this._onDispatchSaved('Saved — will sync when back online.');
        return;
      }
      // Reached the server but got a real HTTP-level failure -- not safe
      // to queue for blind retry.
      MApp.Toast.error(err.message || 'Could not save this dispatch. Please try again.');
      MApp.Util.setSheetBusy('new-dispatch-body', 'new-dispatch-save-btn', false, null, idleLabel);
    }
  },

  // Create keeps the sheet open (reset to a blank line) for fast repeat
  // entry, same rationale as Production's Log Lot; an edit closes it.
  _onDispatchSaved(message) {
    MApp.Toast.success(message);
    if (this.editingDispatchNumber) {
      this.editingDispatchNumber = null;
      this.closeNewDispatchSheet();
      const saveBtn = document.getElementById('new-dispatch-save-btn');
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Dispatch'; }
    } else {
      this.selection = { clientName: '', logisticsContractor: '' };
      this.lines = [{ productId: '', productName: '', qty: '', readyQty: null }];
      document.getElementById('new-dispatch-body').innerHTML = this._formHtml();
      const saveBtn = document.getElementById('new-dispatch-save-btn');
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Dispatch'; }
    }
    this.load();
  }
};
// ================================================================
// RETURNS — card list (recent only, quick field glance) + "Log Return"
// sheet. Logs one item per return, unlike desktop's multi-item form —
// a deliberate scope narrowing for fast field entry (saveReturn accepts
// a multi-item array; the mobile client just always sends a length-1 one).
// ================================================================
MApp.Returns = {
  returns: [],
  vendors: [],
  items: [],
  // Phase 2: header-only fields stay in `selection`; line items (item +
  // qty + price + reason, one-or-more) move to `lines` -- saveReturn
  // already accepts form_data.items as an array server-side (and
  // getReturnData already returns one row per return HEADER with a
  // nested `items` array, not flattened per-line like Dispatch/
  // Production), mobile was just choosing to always send a length-1 one.
  selection: { vendor: '' },
  lines: [],
  editingReturnNumber: null,

  mount() {
    this.load();
  },

  async load() {
    const listEl = document.getElementById('more-returns-list');
    if (!listEl) return;
    MApp.Util.renderSkeleton(listEl, 2);

    try {
      const res = await MApp.Api.call('getReturnData');
      if (!res || !res.success) {
        MApp.Util.renderError(listEl, res && res.message, () => this.load());
        return;
      }
      this.returns = (res.data || []).slice(0, 8);
      this._pendingSyncCount = await OfflineCache.outbox.countPendingForMethod('saveReturn');
      this.render();
    } catch (err) {
      MApp.Util.renderError(listEl, err && err.message, () => this.load());
    }
  },

  render() {
    const listEl = document.getElementById('more-returns-list');
    if (!listEl) return;

    const pendingSyncBanner = this._pendingSyncCount > 0
      ? MApp.Util.pendingSyncBannerHtml(this._pendingSyncCount, 'return')
      : '';

    if (this.returns.length === 0) {
      listEl.innerHTML = pendingSyncBanner;
      const empty = document.createElement('div');
      listEl.appendChild(empty);
      MApp.Util.renderEmpty(empty, { title: 'No returns logged', body: 'Tap "Log Return" to record the first one.' });
      return;
    }

    listEl.innerHTML = pendingSyncBanner + this.returns.map((r, i) => `
      <div class="mb-card">
        <div class="mb-card-row">
          <div>
            <div class="mb-card-title">${MApp.Util.escapeHtml(r.returnNumber)}</div>
            <div class="mb-card-sub">${MApp.Util.escapeHtml(r.vendor)}</div>
          </div>
          <div style="text-align:right;">
            <div class="mb-card-number">${r.totalQty}</div>
            <div class="mb-card-sub">${MApp.Util.escapeHtml(r.returnDate || '')}</div>
          </div>
        </div>
        <div class="mb-mt-2" style="display:flex; gap:var(--mb-sp-4);">
          <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" data-return-action="edit" data-return-index="${i}">Edit</button>
          <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;color:var(--mb-enamel-red);" data-return-action="delete" data-return-index="${i}">Delete</button>
        </div>
      </div>
    `).join('');

    listEl.querySelectorAll('[data-return-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const record = this.returns[Number(btn.dataset.returnIndex)];
        if (!record) return;
        if (btn.dataset.returnAction === 'edit') this.openEditSheet(record);
        else this.deleteReturn(record);
      });
    });
  },

  async openNewReturnSheet() {
    this.editingReturnNumber = null;
    this.selection = { vendor: '' };
    this.lines = [{ name: '', size: '', unit: 'Pcs', qty: '', price: '', reason: '' }];

    const titleEl = document.querySelector('#sheet-log-return h2');
    if (titleEl) titleEl.textContent = 'Log Return';
    const saveBtn = document.getElementById('log-return-save-btn');
    if (saveBtn) saveBtn.textContent = 'Log Return';

    document.getElementById('log-return-body').innerHTML = `
      <div class="mb-skel mb-skel-card" style="height:56px;"></div>
      <div class="mb-skel mb-skel-card" style="height:56px;"></div>
      <div class="mb-skel mb-skel-card" style="height:56px;"></div>`;
    MApp.Sheet.open('sheet-log-return');

    if (saveBtn) saveBtn.disabled = true;

    try {
      await this._ensureRefData();
      document.getElementById('log-return-body').innerHTML = this._formHtml();
    } catch (err) {
      MApp.Toast.error('Could not load return reference data: ' + (err.message || ''));
      this.closeNewReturnSheet();
      return;
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  },

  closeNewReturnSheet() {
    MApp.Sheet.close('sheet-log-return');
  },

  // ── Edit (Phase 2) — getReturnData already groups by header (unlike
  // Dispatch/Production's flattened lists), so the tapped record already
  // carries its full `items` array; just adopt it as `this.lines`.
  async openEditSheet(record) {
    this.editingReturnNumber = record.returnNumber;
    this.selection = { vendor: record.vendor || '' };
    this.lines = (record.items || []).map(it => ({
      name: it.name, size: it.size || '', unit: it.unit || 'Pcs',
      qty: it.qty, price: it.price, reason: it.reason || ''
    }));
    if (this.lines.length === 0) this.lines.push({ name: '', size: '', unit: 'Pcs', qty: '', price: '', reason: '' });

    const titleEl = document.querySelector('#sheet-log-return h2');
    if (titleEl) titleEl.textContent = 'Edit Return';
    const saveBtn = document.getElementById('log-return-save-btn');
    if (saveBtn) saveBtn.textContent = 'Save Changes';

    document.getElementById('log-return-body').innerHTML = `
      <div class="mb-skel mb-skel-card" style="height:56px;"></div>
      <div class="mb-skel mb-skel-card" style="height:56px;"></div>
      <div class="mb-skel mb-skel-card" style="height:56px;"></div>`;
    MApp.Sheet.open('sheet-log-return');
    if (saveBtn) saveBtn.disabled = true;

    try {
      await this._ensureRefData();
      document.getElementById('log-return-body').innerHTML = this._formHtml();

      const dateEl = document.getElementById('return-date');
      if (dateEl) dateEl.value = dateToInputValue(record.returnDateRaw, record.returnDate);
      const remarksEl = document.getElementById('return-remarks');
      if (remarksEl) remarksEl.value = record.remarks || '';
      if (record.vendor) {
        const vendorField = document.getElementById('return-vendor-field');
        if (vendorField) { vendorField.textContent = record.vendor; vendorField.classList.remove('mb-placeholder'); }
      }
    } catch (err) {
      MApp.Toast.error('Could not load this return: ' + (err.message || ''));
      this.closeNewReturnSheet();
      return;
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  },

  async deleteReturn(record) {
    if (!MApp.Util.confirmDelete(record.returnNumber)) return;
    const res = await MApp.Util.mutateSimple('deleteReturn', [record.returnNumber], 'Return deleted.');
    if (res.success) this.load();
  },

  async _ensureRefData() {
    const [vendorsRes, itemsRes] = await Promise.all([
      MApp.Api.call('getVendorsData'),
      MApp.Api.call('getItemsData')
    ]);
    this.vendors = (vendorsRes && vendorsRes.success) ? (vendorsRes.data || []) : [];
    this.items = (itemsRes && itemsRes.success) ? (itemsRes.data || []) : [];
  },

  _formHtml() {
    return `
      <div class="mb-field">
        <label for="return-date">Date</label>
        <input type="date" id="return-date" value="${MApp.Util.todayInputValue()}">
      </div>

      <div class="mb-field">
        <label>Vendor</label>
        <button type="button" class="mb-picker-field mb-placeholder" id="return-vendor-field" onclick="MApp.Returns.pickVendor()">Choose a vendor...</button>
      </div>

      <div class="mapp-section-label">Items</div>
      <div id="return-lines">${this._linesHtml()}</div>
      <button type="button" class="mb-btn mb-btn-secondary mb-mt-2 mb-mb-4" onclick="MApp.Returns.addLine()">+ Add Item</button>

      <div class="mb-field">
        <label for="return-remarks">Remarks (optional)</label>
        <textarea id="return-remarks" rows="3"></textarea>
      </div>
    `;
  },

  async pickVendor() {
    const items = (this.vendors || []).map(v => ({ value: v.name, label: MApp.Util.formatNameCase(v.name) }));
    const picked = await MApp.Picker.open({ title: 'Choose a vendor', items, selectedValue: this.selection.vendor, allowCustom: true });
    if (!picked) return;
    this.selection.vendor = picked.value;
    const el = document.getElementById('return-vendor-field');
    if (el) { el.textContent = picked.label; el.classList.remove('mb-placeholder'); }
  },

  // ── Line items (Phase 2) ─────────────────────────────────────────────
  _linesHtml() {
    if (this.lines.length === 0) return '<div class="mb-text-sm mb-text-steel mb-mb-2">No items added yet.</div>';
    return this.lines.map((line, i) => `
      <div class="mb-card" style="padding:var(--mb-sp-3);">
        <div class="mb-field" style="margin-bottom:var(--mb-sp-2);">
          <label>Item</label>
          <button type="button" class="mb-picker-field${line.name ? '' : ' mb-placeholder'}" onclick="MApp.Returns.pickLineItem(${i})">${line.name ? MApp.Util.escapeHtml(line.name) + (line.size ? ` (${MApp.Util.escapeHtml(line.size)})` : '') : 'Choose an item...'}</button>
        </div>
        <div class="mb-field" style="margin-bottom:var(--mb-sp-2);">
          <label>Quantity</label>
          <input type="number" inputmode="decimal" min="0" step="1" value="${line.qty || ''}" oninput="MApp.Returns.updateLine(${i}, 'qty', this.value)">
        </div>
        <div class="mb-field" style="margin-bottom:var(--mb-sp-2);">
          <label>Rate (per unit)</label>
          <input type="number" inputmode="decimal" min="0" step="0.01" value="${line.price || ''}" oninput="MApp.Returns.updateLine(${i}, 'price', this.value)">
        </div>
        <div class="mb-field" style="margin-bottom:0;">
          <label>Reason</label>
          <input type="text" placeholder="e.g. Defective, Excess, Wrong item" value="${MApp.Util.escapeHtml(line.reason || '')}" oninput="MApp.Returns.updateLine(${i}, 'reason', this.value)">
        </div>
        ${this.lines.length > 1 ? `<button type="button" class="mb-btn-text mb-mt-2" style="padding:0;min-height:auto;color:var(--mb-enamel-red);" onclick="MApp.Returns.removeLine(${i})">Remove</button>` : ''}
      </div>
    `).join('');
  },

  addLine() {
    this.lines.push({ name: '', size: '', unit: 'Pcs', qty: '', price: '', reason: '' });
    const el = document.getElementById('return-lines');
    if (el) el.innerHTML = this._linesHtml();
  },

  removeLine(i) {
    this.lines.splice(i, 1);
    if (this.lines.length === 0) this.lines.push({ name: '', size: '', unit: 'Pcs', qty: '', price: '', reason: '' });
    const el = document.getElementById('return-lines');
    if (el) el.innerHTML = this._linesHtml();
  },

  updateLine(i, key, value) {
    if (!this.lines[i]) return;
    this.lines[i][key] = (key === 'qty' || key === 'price') ? MApp.Util.toNumber(value) : value;
  },

  async pickLineItem(i) {
    if (!this.lines[i]) return;
    const items = (this.items || []).map(it => ({
      value: it.name + '||' + it.size, label: it.name, sublabel: it.size ? `Size: ${it.size}` : ''
    }));
    const picked = await MApp.Picker.open({
      title: 'Choose an item', items, selectedValue: this.lines[i].name + '||' + this.lines[i].size
    });
    if (!picked || !this.lines[i]) return;

    const match = (this.items || []).find(it => (it.name + '||' + it.size) === picked.value);
    this.lines[i].name = match ? match.name : picked.label;
    this.lines[i].size = match ? match.size : '';
    this.lines[i].unit = match ? match.baseUnit : 'Pcs';

    const el = document.getElementById('return-lines');
    if (el) el.innerHTML = this._linesHtml();
  },

  // Note: source's own single-verb _apiCall handled both reads and
  // writes -- saveReturn is mutation=True server-side (registry.py),
  // so this call uses Api.mutateWithId, not .call, unlike source.
  async save() {
    if (!this.selection.vendor) {
      MApp.Toast.error('Choose a vendor first.');
      return;
    }
    const validLines = this.lines.filter(l => l.name && l.qty > 0);
    if (validLines.length === 0) {
      MApp.Toast.error('Add at least one item with a name and quantity greater than zero.');
      return;
    }
    if (validLines.some(l => !l.reason)) {
      MApp.Toast.error('Enter a reason for every item.');
      return;
    }

    const formData = {
      returnDate: document.getElementById('return-date')?.value || MApp.Util.todayInputValue(),
      vendor: this.selection.vendor,
      contact: '',
      remarks: (document.getElementById('return-remarks')?.value || '').trim(),
      items: JSON.stringify(validLines.map(l => ({
        name: l.name, size: l.size || '', narration: '', unit: l.unit || 'Pcs',
        qty: l.qty, price: l.price || 0, reason: l.reason
      })))
    };
    if (this.editingReturnNumber) formData.existingReturnNumber = this.editingReturnNumber;

    const isEdit = !!this.editingReturnNumber;
    const idleLabel = isEdit ? 'Save Changes' : 'Log Return';
    const mutationId = Api.newMutationId();

    MApp.Util.setSheetBusy('log-return-body', 'log-return-save-btn', true, 'Saving…');
    try {
      const res = await Api.mutateWithId('saveReturn', mutationId, formData);
      if (!res || !res.success) {
        MApp.Toast.error((res && res.message) || 'Could not save this return.');
        MApp.Util.setSheetBusy('log-return-body', 'log-return-save-btn', false, null, idleLabel);
        return;
      }
      this._onReturnSaved(isEdit ? 'Return updated.' : `Return logged${res.data && res.data.returnNumber ? ' — ' + res.data.returnNumber : ''}.`);
    } catch (err) {
      if (err && err.isNetworkError) {
        // The fetch itself never reached the server -- queue under the
        // same mutationId. Vendor/item are matched by name (not an
        // opaque row ID), same low staleness risk as adjustStockManually.
        await OfflineCache.outbox.enqueue(mutationId, 'saveReturn', [formData]);
        MApp.Outbox.updateBadge();
        MApp.Outbox.requestSync();
        this._onReturnSaved('Saved — will sync when back online.');
        return;
      }
      // Reached the server but got a real HTTP-level failure -- not safe
      // to queue for blind retry.
      MApp.Toast.error(err.message || 'Could not save this return. Please try again.');
      MApp.Util.setSheetBusy('log-return-body', 'log-return-save-btn', false, null, idleLabel);
    }
  },

  // Create keeps the sheet open (reset to a blank line) for fast repeat
  // entry, same rationale as Production/Dispatch; an edit closes it.
  _onReturnSaved(message) {
    MApp.Toast.success(message);
    if (this.editingReturnNumber) {
      this.editingReturnNumber = null;
      this.closeNewReturnSheet();
      const saveBtn = document.getElementById('log-return-save-btn');
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Log Return'; }
    } else {
      this.selection = { vendor: '' };
      this.lines = [{ name: '', size: '', unit: 'Pcs', qty: '', price: '', reason: '' }];
      document.getElementById('log-return-body').innerHTML = this._formHtml();
      const saveBtn = document.getElementById('log-return-save-btn');
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Log Return'; }
    }
    this.load();
  }
};
// ================================================================
// PO LEDGER — getPOData already returns po.status and per-line
// receivedQty/pendingQty (see module_po.js#_attachPoStatus), so the list
// is a straight read + status-chip + pending-line surface, no new server
// work needed. Print reuses the SAME #print-po-container markup from
// print.html the desktop PO Ledger populates (see po.js's own
// populatePrintData) -- always includes rates/totals (no toggle, unlike
// desktop's printWithRates/printWithTotal checkboxes) to keep the first
// mobile pass simple.
//
// "New PO" (openNewSheet/save) is the one write action here, calling the
// SAME savePO used by desktop, unchanged. Like MApp.Returns, it logs
// exactly one item per PO instead of desktop's multi-line form -- fast
// field entry; a PO with several distinct items should still be raised
// on desktop. Editing/deleting an existing PO is intentionally NOT built
// here, matching every other mobile write flow (Production/Dispatch/
// Returns): mobile only ever creates new records.
// ================================================================
MApp.PO = {
  pos: [],
  filtered: [],
  statusFilter: 'all',
  searchTerm: '',
  vendors: [],
  items: [],
  // Phase 2: header-only fields stay in `selection`; line items (item +
  // qty + price, one-or-more) move to `lines` -- savePO already accepts
  // form_data.items as an array server-side (and getPOData already
  // returns one row per PO header with a nested `items` array, per
  // po.items used by render()/print() above), mobile was just choosing
  // to always send a length-1 one.
  selection: { vendor: '', contact: '' },
  lines: [],
  editingPoNumber: null,

  async openLedgerSheet() {
    const listEl = document.getElementById('po-ledger-list');
    const searchInput = document.getElementById('po-ledger-search');
    if (searchInput) searchInput.value = '';
    this.searchTerm = '';
    this.statusFilter = 'all';
    this._updateFilterChips();
    MApp.Util.renderSkeleton(listEl, 5);
    MApp.Sheet.open('sheet-po-ledger');

    try {
      const res = await MApp.Api.call('getPOData');
      if (!res || !res.success) {
        MApp.Util.renderError(listEl, res && res.message, () => this.openLedgerSheet());
        return;
      }
      this.pos = res.data || [];
      this._pendingSyncCount = await OfflineCache.outbox.countPendingForMethod('savePO');
      this._applyFilters();
    } catch (err) {
      MApp.Util.renderError(listEl, err && err.message, () => this.openLedgerSheet());
    }
  },

  closeLedgerSheet() {
    MApp.Sheet.close('sheet-po-ledger');
  },

  onSearch(term) {
    this.searchTerm = String(term || '').trim().toLowerCase();
    this._applyFilters();
  },

  filterByStatus(status) {
    this.statusFilter = status;
    this._updateFilterChips();
    this._applyFilters();
  },

  _updateFilterChips() {
    document.querySelectorAll('#po-ledger-status-bar .mb-filter-chip').forEach(chip => {
      chip.classList.toggle('active', chip.dataset.status === this.statusFilter);
    });
  },

  _applyFilters() {
    let list = this.pos;
    if (this.statusFilter !== 'all') {
      list = list.filter(po => po.status === this.statusFilter);
    }
    if (this.searchTerm) {
      const term = this.searchTerm;
      list = list.filter(po =>
        String(po.poNumber || '').toLowerCase().includes(term) ||
        String(po.vendor || '').toLowerCase().includes(term));
    }
    this.filtered = list;
    this.render();
  },

  render() {
    const listEl = document.getElementById('po-ledger-list');
    if (!listEl) return;

    const pendingSyncBanner = this._pendingSyncCount > 0
      ? MApp.Util.pendingSyncBannerHtml(this._pendingSyncCount, 'PO', 'POs')
      : '';

    if (this.filtered.length === 0) {
      listEl.innerHTML = pendingSyncBanner;
      const empty = document.createElement('div');
      listEl.appendChild(empty);
      MApp.Util.renderEmpty(empty, {
        title: 'No purchase orders found',
        body: this.pos.length === 0 ? 'No POs recorded yet.' : 'Try a different search or filter.'
      });
      return;
    }

    listEl.innerHTML = pendingSyncBanner + this.filtered.slice(0, 100).map(po => {
      const idx = this.pos.indexOf(po);
      const pendingLines = (po.items || [])
        .filter(item => (item.pendingQty || 0) > 0.0001)
        .map(item => `${MApp.Util.escapeHtml(item.name)}: ${MApp.Util.formatQty(item.pendingQty)} ${MApp.Util.escapeHtml(item.unit || '')} pending`)
        .join('<br>');

      return `
      <div class="mb-card">
        <div class="mb-card-row" style="justify-content:space-between;align-items:flex-start;">
          <div>
            <div class="mb-card-title">${MApp.Util.escapeHtml(po.poNumber)}</div>
            <div class="mb-card-sub">${MApp.Util.escapeHtml(po.vendor || '')} · ${MApp.Util.escapeHtml(po.poDate || '')}</div>
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <span class="mb-chip ${MApp.Util.statusChipClass(po.status)}">${MApp.Util.escapeHtml(po.status || '')}</span>
            <button type="button" class="mapp-topbar-btn" aria-label="Print PO ${MApp.Util.escapeHtml(po.poNumber)}" onclick="MApp.PO.print(${idx})">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/></svg>
            </button>
          </div>
        </div>
        <div class="mb-card-sub" style="margin-top:4px;">Qty: ${MApp.Util.formatQty(po.totalQty)} · Total: ${MApp.Util.formatCurrency(po.grandTotal)}</div>
        ${pendingLines ? `<div class="mb-card-sub" style="margin-top:4px;color:var(--mb-enamel-amber);">${pendingLines}</div>` : ''}
        <div class="mb-mt-2" style="display:flex; gap:var(--mb-sp-4);">
          <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" data-po-action="edit" data-po-index="${idx}">Edit</button>
          <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;color:var(--mb-enamel-red);" data-po-action="delete" data-po-index="${idx}">Delete</button>
        </div>
      </div>`;
    }).join('');

    listEl.querySelectorAll('[data-po-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const po = this.pos[Number(btn.dataset.poIndex)];
        if (!po) return;
        if (btn.dataset.poAction === 'edit') this.openEditSheet(po);
        else this.deletePo(po);
      });
    });
  },

  print(index) {
    const po = this.pos[index];
    if (!po) return;
    this._populatePrintData(po);
    const title = `PO_${po.poNumber}_${String(po.vendor || '').replace(/[^a-zA-Z0-9 \-]/g, '').trim().replace(/\s+/g, '_')}`;
    MApp.Print.trigger('print-po-container', title);
  },

  // Mirrors desktop po.js's populatePrintData() -- same #print-po-container
  // field IDs (shared markup from print.html) -- but always includes
  // rates/totals, no printWithRates/printWithTotal checkboxes like desktop has.
  _populatePrintData(po) {
    const setText = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.innerText = val ?? '';
    };
    setText('print-vendor', po.vendor || '');
    setText('print-contact', po.contact || '');
    setText('print-supp-rem', po.supplierRemarks || '');
    setText('print-ponum', po.poNumber || '');
    setText('print-date', po.poDate || '');
    setText('print-desc', po.poDescription || '');
    setText('print-remarks', po.poRemarks || '');

    const BRAND = '#C0392B';
    const thBase = `padding:8px 6px;background-color:${BRAND};color:#fff;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;border:1px solid ${BRAND};-webkit-print-color-adjust:exact;print-color-adjust:exact;`;
    const tdBase = 'padding:7px 6px;border:1px solid #e5e5e5;word-break:break-word;overflow-wrap:break-word;font-size:12px;';

    const head = document.getElementById('print-table-head');
    if (head) {
      head.innerHTML = `<tr>
        <th style="${thBase}width:5%;text-align:center">#</th>
        <th style="${thBase}width:20%;text-align:left">Item Name</th>
        <th style="${thBase}width:17%;text-align:left">Narration</th>
        <th style="${thBase}width:12%;text-align:left">Size</th>
        <th style="${thBase}width:14%;text-align:center">Qty</th>
        <th style="${thBase}width:14%;text-align:right">Rate</th>
        <th style="${thBase}width:18%;text-align:right">Total</th>
      </tr>`;
    }

    let grandTotal = 0;
    const bodyHtml = (po.items || []).map((item, idx) => {
      const qty = MApp.Util.toNumber(item.qty);
      const price = MApp.Util.toNumber(item.price);
      const lineTotal = qty * price;
      grandTotal += lineTotal;
      const rowBg = idx % 2 === 0 ? '#ffffff' : '#FFF5F5';
      return `<tr style="background-color:${rowBg};-webkit-print-color-adjust:exact;print-color-adjust:exact;page-break-inside:avoid;break-inside:avoid;">
        <td style="${tdBase}text-align:center;color:#999;font-weight:600;">${idx + 1}</td>
        <td style="${tdBase}text-align:left;font-weight:600;">${MApp.Util.escapeHtml(item.name || '')}</td>
        <td style="${tdBase}text-align:left;color:#555;">${MApp.Util.escapeHtml(item.narration || '')}</td>
        <td style="${tdBase}text-align:left;">${MApp.Util.escapeHtml(item.size || '')}</td>
        <td style="${tdBase}text-align:center;font-weight:600;">${MApp.Util.escapeHtml(String(qty))} ${MApp.Util.escapeHtml(item.unit || 'Pcs')}</td>
        <td style="${tdBase}text-align:right;">${MApp.Util.formatCurrency(price)}</td>
        <td style="${tdBase}text-align:right;font-weight:700;color:${BRAND};-webkit-print-color-adjust:exact;print-color-adjust:exact;">${MApp.Util.formatCurrency(lineTotal)}</td>
      </tr>`;
    }).join('');

    const tblBody = document.getElementById('print-items-body');
    if (tblBody) tblBody.innerHTML = bodyHtml;

    const totalContainer = document.getElementById('print-grand-total-container');
    setText('print-grand-total', grandTotal.toFixed(2));
    if (totalContainer) totalContainer.style.display = 'block';
  },

  // ── New PO sheet ─────────────────────────────────────────────────────
  async openNewSheet() {
    this.editingPoNumber = null;
    this.selection = { vendor: '', contact: '' };
    this.lines = [{ name: '', size: '', unit: 'Pcs', qty: '', price: '' }];

    const titleEl = document.querySelector('#sheet-new-po h2');
    if (titleEl) titleEl.textContent = 'New PO';
    const saveBtn = document.getElementById('new-po-save-btn');
    if (saveBtn) saveBtn.textContent = 'Save PO';

    document.getElementById('new-po-body').innerHTML = `
      <div class="mb-skel mb-skel-card" style="height:56px;"></div>
      <div class="mb-skel mb-skel-card" style="height:56px;"></div>
      <div class="mb-skel mb-skel-card" style="height:56px;"></div>`;
    MApp.Sheet.open('sheet-new-po');

    if (saveBtn) saveBtn.disabled = true;

    try {
      await this._ensureNewPoRefData();
      document.getElementById('new-po-body').innerHTML = this._newPoFormHtml();
    } catch (err) {
      MApp.Toast.error('Could not load PO reference data: ' + (err.message || ''));
      this.closeNewSheet();
      return;
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  },

  closeNewSheet() {
    MApp.Sheet.close('sheet-new-po');
  },

  // ── Edit (Phase 2) — getPOData already groups by header (same shape as
  // Returns), so the tapped record already carries its full `items` array;
  // just adopt it as `this.lines`. PO number itself is left unchanged
  // (existingPoNumber only) -- renaming a PO number is a desktop task.
  async openEditSheet(po) {
    this.editingPoNumber = po.poNumber;
    this.selection = { vendor: po.vendor || '', contact: po.contact || '' };
    this.lines = (po.items || []).map(it => ({
      name: it.name, size: it.size || '', unit: it.unit || 'Pcs', qty: it.qty, price: it.price
    }));
    if (this.lines.length === 0) this.lines.push({ name: '', size: '', unit: 'Pcs', qty: '', price: '' });

    const titleEl = document.querySelector('#sheet-new-po h2');
    if (titleEl) titleEl.textContent = 'Edit PO';
    const saveBtn = document.getElementById('new-po-save-btn');
    if (saveBtn) saveBtn.textContent = 'Save Changes';

    document.getElementById('new-po-body').innerHTML = `
      <div class="mb-skel mb-skel-card" style="height:56px;"></div>
      <div class="mb-skel mb-skel-card" style="height:56px;"></div>
      <div class="mb-skel mb-skel-card" style="height:56px;"></div>`;
    MApp.Sheet.open('sheet-new-po');
    if (saveBtn) saveBtn.disabled = true;

    try {
      await this._ensureNewPoRefData();
      document.getElementById('new-po-body').innerHTML = this._newPoFormHtml();

      const setValue = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
      setValue('new-po-date', dateToInputValue(po.poDateRaw, po.poDate));
      setValue('new-po-contact', po.contact);
      setValue('new-po-remarks', po.poRemarks);
      if (po.vendor) {
        const vendorField = document.getElementById('new-po-vendor-field');
        if (vendorField) { vendorField.textContent = po.vendor; vendorField.classList.remove('mb-placeholder'); }
      }
    } catch (err) {
      MApp.Toast.error('Could not load this PO: ' + (err.message || ''));
      this.closeNewSheet();
      return;
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  },

  async deletePo(po) {
    if (!MApp.Util.confirmDelete(po.poNumber)) return;
    const res = await MApp.Util.mutateSimple('deletePO', [po.poNumber], 'PO deleted.');
    if (res.success) this._refreshLedger();
  },

  async _ensureNewPoRefData() {
    const [vendorsRes, itemsRes] = await Promise.all([
      MApp.Api.call('getVendorsData'),
      MApp.Api.call('getItemsData')
    ]);
    this.vendors = (vendorsRes && vendorsRes.success) ? (vendorsRes.data || []) : [];
    this.items = (itemsRes && itemsRes.success) ? (itemsRes.data || []) : [];
  },

  _newPoFormHtml() {
    return `
      <div class="mb-field">
        <label for="new-po-date">Date</label>
        <input type="date" id="new-po-date" value="${MApp.Util.todayInputValue()}">
      </div>

      <div class="mb-field">
        <label>Vendor</label>
        <button type="button" class="mb-picker-field mb-placeholder" id="new-po-vendor-field" onclick="MApp.PO.pickVendor()">Choose a vendor...</button>
      </div>

      <div class="mb-field">
        <label for="new-po-contact">Contact / dispatch address (optional)</label>
        <input type="text" id="new-po-contact" maxlength="100">
      </div>

      <div class="mapp-section-label">Items</div>
      <div id="new-po-lines">${this._linesHtml()}</div>
      <button type="button" class="mb-btn mb-btn-secondary mb-mt-2 mb-mb-4" onclick="MApp.PO.addLine()">+ Add Item</button>

      <div class="mb-field">
        <label for="new-po-remarks">Remarks (optional)</label>
        <textarea id="new-po-remarks" rows="3" placeholder="Shown in the printed PO document..."></textarea>
      </div>
    `;
  },

  async pickVendor() {
    const items = (this.vendors || []).map(v => ({ value: v.name, label: MApp.Util.formatNameCase(v.name) }));
    const picked = await MApp.Picker.open({ title: 'Choose a vendor', items, selectedValue: this.selection.vendor, allowCustom: true });
    if (!picked) return;
    this.selection.vendor = picked.value;
    const el = document.getElementById('new-po-vendor-field');
    if (el) { el.textContent = picked.label; el.classList.remove('mb-placeholder'); }

    // Mirrors desktop's App.Utils.updateVendorContact -- auto-fill the
    // contact field from this vendor's last known contact, if any.
    const match = (this.vendors || []).find(v => v.name === picked.value);
    if (match && match.contact) {
      this.selection.contact = match.contact;
      const contactInput = document.getElementById('new-po-contact');
      if (contactInput) contactInput.value = match.contact;
    }
  },

  // ── Line items (Phase 2) ─────────────────────────────────────────────
  _linesHtml() {
    if (this.lines.length === 0) return '<div class="mb-text-sm mb-text-steel mb-mb-2">No items added yet.</div>';
    return this.lines.map((line, i) => `
      <div class="mb-card" style="padding:var(--mb-sp-3);">
        <div class="mb-field" style="margin-bottom:var(--mb-sp-2);">
          <label>Item</label>
          <button type="button" class="mb-picker-field${line.name ? '' : ' mb-placeholder'}" onclick="MApp.PO.pickLineItem(${i})">${line.name ? MApp.Util.escapeHtml(line.name) + (line.size ? ` (${MApp.Util.escapeHtml(line.size)})` : '') : 'Choose an item...'}</button>
        </div>
        <div class="mb-field" style="margin-bottom:var(--mb-sp-2);">
          <label>Quantity</label>
          <input type="number" inputmode="decimal" min="0" step="1" value="${line.qty || ''}" oninput="MApp.PO.updateLine(${i}, 'qty', this.value)">
        </div>
        <div class="mb-field" style="margin-bottom:0;">
          <label>Rate (per unit)</label>
          <input type="number" inputmode="decimal" min="0" step="0.01" value="${line.price || ''}" oninput="MApp.PO.updateLine(${i}, 'price', this.value)">
        </div>
        ${this.lines.length > 1 ? `<button type="button" class="mb-btn-text mb-mt-2" style="padding:0;min-height:auto;color:var(--mb-enamel-red);" onclick="MApp.PO.removeLine(${i})">Remove</button>` : ''}
      </div>
    `).join('');
  },

  addLine() {
    this.lines.push({ name: '', size: '', unit: 'Pcs', qty: '', price: '' });
    const el = document.getElementById('new-po-lines');
    if (el) el.innerHTML = this._linesHtml();
  },

  removeLine(i) {
    this.lines.splice(i, 1);
    if (this.lines.length === 0) this.lines.push({ name: '', size: '', unit: 'Pcs', qty: '', price: '' });
    const el = document.getElementById('new-po-lines');
    if (el) el.innerHTML = this._linesHtml();
  },

  updateLine(i, key, value) {
    if (!this.lines[i]) return;
    this.lines[i][key] = MApp.Util.toNumber(value);
  },

  async pickLineItem(i) {
    if (!this.lines[i]) return;
    const items = (this.items || []).map(it => ({
      value: it.name + '||' + it.size, label: it.name, sublabel: it.size ? `Size: ${it.size}` : ''
    }));
    const picked = await MApp.Picker.open({
      title: 'Choose an item', items, selectedValue: this.lines[i].name + '||' + this.lines[i].size
    });
    if (!picked || !this.lines[i]) return;

    const match = (this.items || []).find(it => (it.name + '||' + it.size) === picked.value);
    this.lines[i].name = match ? match.name : picked.label;
    this.lines[i].size = match ? match.size : '';
    this.lines[i].unit = match ? match.baseUnit : 'Pcs';

    const el = document.getElementById('new-po-lines');
    if (el) el.innerHTML = this._linesHtml();
  },

  // Note: source's own single-verb _apiCall handled both reads and
  // writes -- savePO is mutation=True server-side (registry.py), so
  // this call uses Api.mutateWithId, not .call, unlike source.
  async save() {
    if (!this.selection.vendor) {
      MApp.Toast.error('Choose a vendor first.');
      return;
    }
    const validLines = this.lines.filter(l => l.name && l.qty > 0);
    if (validLines.length === 0) {
      MApp.Toast.error('Add at least one item with a name and quantity greater than zero.');
      return;
    }

    const formData = {
      poDate: document.getElementById('new-po-date')?.value || MApp.Util.todayInputValue(),
      vendor: this.selection.vendor,
      contact: (document.getElementById('new-po-contact')?.value || '').trim(),
      poRemarks: (document.getElementById('new-po-remarks')?.value || '').trim(),
      items: JSON.stringify(validLines.map(l => ({
        name: l.name, size: l.size || '', narration: '', unit: l.unit || 'Pcs',
        qty: l.qty, price: l.price || 0
      })))
    };
    if (this.editingPoNumber) formData.existingPoNumber = this.editingPoNumber;

    const isEdit = !!this.editingPoNumber;
    const idleLabel = isEdit ? 'Save Changes' : 'Save PO';
    const mutationId = Api.newMutationId();

    MApp.Util.setSheetBusy('new-po-body', 'new-po-save-btn', true, 'Saving…');
    try {
      const res = await Api.mutateWithId('savePO', mutationId, formData);
      if (!res || !res.success) {
        MApp.Toast.error((res && res.message) || 'Could not save this PO.');
        MApp.Util.setSheetBusy('new-po-body', 'new-po-save-btn', false, null, idleLabel);
        return;
      }
      this._onPoSaved(isEdit ? 'PO updated.' : `PO saved${res.data && res.data.poNumber ? ' — ' + res.data.poNumber : ''}.`, idleLabel);
    } catch (err) {
      if (err && err.isNetworkError) {
        // The fetch itself never reached the server -- queue under the
        // same mutationId. Vendor/item are matched by name (not an
        // opaque row ID), same low staleness risk as adjustStockManually.
        await OfflineCache.outbox.enqueue(mutationId, 'savePO', [formData]);
        MApp.Outbox.updateBadge();
        MApp.Outbox.requestSync();
        this._onPoSaved('Saved — will sync when back online.', idleLabel);
        return;
      }
      // Reached the server but got a real HTTP-level failure -- not safe
      // to queue for blind retry.
      MApp.Toast.error(err.message || 'Could not save this PO. Please try again.');
      MApp.Util.setSheetBusy('new-po-body', 'new-po-save-btn', false, null, idleLabel);
    }
  },

  _onPoSaved(message, idleLabel) {
    MApp.Toast.success(message);
    this.editingPoNumber = null;
    this.closeNewSheet();
    MApp.Util.setSheetBusy('new-po-body', 'new-po-save-btn', false, null, idleLabel || 'Save PO');
    this._refreshLedger();
  },

  // Best-effort refresh of the ledger list behind the New PO sheet -- a
  // failure here must not surface as an error toast; the PO itself
  // already saved successfully by this point (see save() above).
  async _refreshLedger() {
    try {
      const res = await MApp.Api.call('getPOData');
      if (res && res.success) {
        this.pos = res.data || [];
        this._applyFilters();
      }
    } catch (err) {
      // Non-critical -- next manual open of the ledger will show it.
    }
  }
};
// ================================================================
// BILL LEDGER (read-only) — same pattern as MApp.PO, but bills have no
// status field (no filter chips needed) and print reuses
// #print-bill-container (desktop bill.js's own populatePrintData)
// instead.
// ================================================================
MApp.Bill = {
  bills: [],
  filtered: [],
  searchTerm: '',
  // Phase 3: New/Edit form state. GOODS bills only for v1 -- see
  // sheet-bill-form's own comment in mobile_views.html for why Labor Job
  // bills stay a desktop task. `editingBillVendor` is the ORIGINAL vendor
  // (kept separate from the editable `selection.vendor`) since saveBill's
  // identity lookup is (existingVendor, existingBillNumber), not just the
  // bill number -- same "old identity preserved separately" pattern as
  // Items' originalName/originalSize.
  vendors: [],
  items: [],
  selection: { vendor: '', contact: '' },
  lines: [],
  editingBillNumber: null,
  editingBillVendor: null,
  _formSeq: 0,

  async openLedgerSheet() {
    const listEl = document.getElementById('bill-ledger-list');
    const searchInput = document.getElementById('bill-ledger-search');
    if (searchInput) searchInput.value = '';
    this.searchTerm = '';
    MApp.Util.renderSkeleton(listEl, 5);
    MApp.Sheet.open('sheet-bill-ledger');

    try {
      const res = await MApp.Api.call('getBillData');
      if (!res || !res.success) {
        MApp.Util.renderError(listEl, res && res.message, () => this.openLedgerSheet());
        return;
      }
      this.bills = res.data || [];
      this._applyFilters();
    } catch (err) {
      MApp.Util.renderError(listEl, err && err.message, () => this.openLedgerSheet());
    }
  },

  closeLedgerSheet() {
    MApp.Sheet.close('sheet-bill-ledger');
  },

  onSearch(term) {
    this.searchTerm = String(term || '').trim().toLowerCase();
    this._applyFilters();
  },

  _applyFilters() {
    let list = this.bills;
    if (this.searchTerm) {
      const term = this.searchTerm;
      list = list.filter(bill =>
        String(bill.billNumber || '').toLowerCase().includes(term) ||
        String(bill.vendor || '').toLowerCase().includes(term));
    }
    this.filtered = list;
    this.render();
  },

  render() {
    const listEl = document.getElementById('bill-ledger-list');
    if (!listEl) return;

    if (this.filtered.length === 0) {
      MApp.Util.renderEmpty(listEl, {
        title: 'No bills found',
        body: this.bills.length === 0 ? 'No bills recorded yet.' : 'Try a different search term.'
      });
      return;
    }

    listEl.innerHTML = this.filtered.slice(0, 100).map(bill => {
      const idx = this.bills.indexOf(bill);
      const poRef = (bill.poNumbers || []).length
        ? bill.poNumbers.map(p => p === 'DIRECT' ? 'Direct' : `PO-${MApp.Util.escapeHtml(String(p))}`).join(', ')
        : 'N/A';

      return `
      <div class="mb-card">
        <div class="mb-card-row" style="justify-content:space-between;align-items:flex-start;">
          <div>
            <div class="mb-card-title">${MApp.Util.escapeHtml(bill.billNumber)}</div>
            <div class="mb-card-sub">${MApp.Util.escapeHtml(bill.vendor || '')} · ${MApp.Util.escapeHtml(bill.billDate || '')}</div>
          </div>
          <button type="button" class="mapp-topbar-btn" aria-label="Print bill ${MApp.Util.escapeHtml(bill.billNumber)}" onclick="MApp.Bill.print(${idx})">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/></svg>
          </button>
        </div>
        <div class="mb-card-sub" style="margin-top:4px;">Qty: ${MApp.Util.formatQty(bill.totalQty)} · Total: ${MApp.Util.formatCurrency(bill.totalAmount)}</div>
        <div class="mb-card-sub" style="margin-top:4px;">${poRef}</div>
        <div class="mb-mt-2" style="display:flex; gap:var(--mb-sp-4);">
          <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" data-bill-action="edit" data-bill-index="${idx}">Edit</button>
          <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;color:var(--mb-enamel-red);" data-bill-action="delete" data-bill-index="${idx}">Delete</button>
        </div>
      </div>`;
    }).join('');

    listEl.querySelectorAll('[data-bill-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const bill = this.bills[Number(btn.dataset.billIndex)];
        if (!bill) return;
        if (btn.dataset.billAction === 'edit') this.openForm(bill);
        else this.deleteBillRecord(bill);
      });
    });
  },

  print(index) {
    const bill = this.bills[index];
    if (!bill) return;
    this._populatePrintData(bill);
    const title = `Bill_${bill.billNumber}_${String(bill.vendor || '').replace(/[^a-zA-Z0-9 \-]/g, '').trim().replace(/\s+/g, '_')}`;
    MApp.Print.trigger('print-bill-container', title);
  },

  // Mirrors desktop bill.js's populatePrintData() -- same #print-bill
  // -container field IDs (shared markup from print.html). Unlike PO's
  // print container, the items-table header here is static HTML already,
  // so only the body + summary fields need populating.
  _populatePrintData(bill) {
    const setText = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.innerText = val ?? '';
    };
    setText('print-bill-number', bill.billNumber || '');
    setText('print-bill-date', bill.billDate || '');
    setText('print-bill-vendor', bill.vendor || '');
    setText('print-bill-remarks', bill.remarks || '');
    setText('print-bill-contact', bill.contact || '');

    const poNums = (bill.poNumbers && bill.poNumbers.length) ? bill.poNumbers : (bill.poNumber ? [bill.poNumber] : []);
    const poRefEl = document.getElementById('print-bill-po-ref');
    if (poRefEl) {
      poRefEl.innerHTML = poNums.length
        ? poNums.map(p => p === 'DIRECT' ? 'Direct Purchase (No PO)' : `PO-${MApp.Util.escapeHtml(String(p))}`).join(' | ')
        : 'N/A';
    }

    const bodyHtml = (bill.items || []).map((item, idx) => {
      const rowBg = idx % 2 === 0 ? '#ffffff' : '#F5F0FB';
      const rowStyle = `background-color:${rowBg};-webkit-print-color-adjust:exact;print-color-adjust:exact;page-break-inside:avoid;break-inside:avoid;`;
      return `<tr style="${rowStyle}">
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:center;color:#999;font-weight:600;">${idx + 1}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:left;font-weight:600;">${MApp.Util.escapeHtml(item.name || '')}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:left;color:#555;">${MApp.Util.escapeHtml(item.narration || '')}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:center;">${MApp.Util.escapeHtml(item.size || '')}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:center;font-weight:600;">${MApp.Util.escapeHtml(String(MApp.Util.toNumber(item.qty)))} ${MApp.Util.escapeHtml(item.unit || 'Pcs')}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:right;">${MApp.Util.formatCurrency(item.price)}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:right;">${MApp.Util.escapeHtml(String(item.gstRatePct ?? 0))}%</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:right;font-weight:700;color:#6F42C1;-webkit-print-color-adjust:exact;print-color-adjust:exact;">${MApp.Util.formatCurrency(item.lineTotal)}</td>
      </tr>`;
    }).join('');
    const tblBody = document.getElementById('print-bill-items-body');
    if (tblBody) tblBody.innerHTML = bodyHtml;

    setText('print-bill-grand-total', MApp.Util.toNumber(bill.totalAmount).toFixed(2));
  },

  // ── New/Edit Bill sheet (Phase 3) ────────────────────────────────────
  async openForm(bill) {
    const mySeq = ++this._formSeq;
    this.editingBillNumber = bill ? bill.billNumber : null;
    this.editingBillVendor = bill ? bill.vendor : null;
    this.selection = { vendor: bill ? bill.vendor : '', contact: bill ? bill.contact : '' };
    this.lines = bill
      ? (bill.items || []).map(it => ({ name: it.name, size: it.size || '', unit: it.unit || 'Pcs', qty: it.qty, price: it.price, gst: it.gstRatePct, narration: it.narration || '' }))
      : [{ name: '', size: '', unit: 'Pcs', qty: '', price: '', gst: 18 }];
    if (this.lines.length === 0) this.lines.push({ name: '', size: '', unit: 'Pcs', qty: '', price: '', gst: 18 });

    const titleEl = document.getElementById('bill-form-title');
    if (titleEl) titleEl.textContent = bill ? 'Edit Bill' : 'New Bill';
    const saveBtn = document.getElementById('bill-form-save-btn');
    if (saveBtn) saveBtn.textContent = bill ? 'Save Changes' : 'Save Bill';

    document.getElementById('bill-form-body').innerHTML = `
      <div class="mb-skel mb-skel-card" style="height:56px;"></div>
      <div class="mb-skel mb-skel-card" style="height:56px;"></div>
      <div class="mb-skel mb-skel-card" style="height:56px;"></div>`;
    MApp.Sheet.open('sheet-bill-form');
    if (saveBtn) saveBtn.disabled = true;

    try {
      const [vendorsRes, itemsRes] = await Promise.all([
        MApp.Api.call('getVendorsData'),
        MApp.Api.call('getItemsData')
      ]);
      // A newer openForm() call superseded this one while we were awaiting --
      // don't let this stale response repaint the (now different) form.
      if (mySeq !== this._formSeq) return;
      this.vendors = (vendorsRes && vendorsRes.success) ? (vendorsRes.data || []) : [];
      this.items = (itemsRes && itemsRes.success) ? (itemsRes.data || []) : [];

      document.getElementById('bill-form-body').innerHTML = this._billFormHtml(bill);

      if (bill && bill.vendor) {
        const vendorField = document.getElementById('bill-form-vendor-field');
        if (vendorField) { vendorField.textContent = bill.vendor; vendorField.classList.remove('mb-placeholder'); }
      }
    } catch (err) {
      if (mySeq !== this._formSeq) return;
      MApp.Toast.error('Could not load bill reference data: ' + (err.message || ''));
      this.closeForm();
      return;
    } finally {
      if (mySeq === this._formSeq && saveBtn) saveBtn.disabled = false;
    }
  },

  closeForm() {
    MApp.Sheet.close('sheet-bill-form');
  },

  _billFormHtml(bill) {
    return `
      <div class="mb-field">
        <label for="bill-form-number">Bill Number</label>
        <input type="text" id="bill-form-number" value="${MApp.Util.escapeHtml(bill ? bill.billNumber : '')}" ${bill ? 'readonly' : ''}>
      </div>

      <div class="mb-field">
        <label for="bill-form-date">Invoice Date</label>
        <input type="date" id="bill-form-date" value="${bill ? dateToInputValue(bill.billDateRaw, bill.billDate) : MApp.Util.todayInputValue()}">
      </div>

      <div class="mb-field">
        <label>Vendor</label>
        <button type="button" class="mb-picker-field mb-placeholder" id="bill-form-vendor-field" onclick="MApp.Bill.pickVendor()">Choose a vendor...</button>
      </div>

      <div class="mb-field">
        <label for="bill-form-contact">Contact (optional)</label>
        <input type="text" id="bill-form-contact" value="${MApp.Util.escapeHtml(bill ? bill.contact : '')}">
      </div>

      <div class="mapp-section-label">Items</div>
      <div id="bill-form-lines">${this._linesHtml()}</div>
      <button type="button" class="mb-btn mb-btn-secondary mb-mt-2 mb-mb-4" onclick="MApp.Bill.addLine()">+ Add Item</button>

      <div class="mb-field">
        <label for="bill-form-remarks">Remarks (optional)</label>
        <textarea id="bill-form-remarks" rows="3">${MApp.Util.escapeHtml(bill ? bill.remarks : '')}</textarea>
      </div>
    `;
  },

  async pickVendor() {
    const items = (this.vendors || []).map(v => ({ value: v.name, label: MApp.Util.formatNameCase(v.name) }));
    const picked = await MApp.Picker.open({ title: 'Choose a vendor', items, selectedValue: this.selection.vendor, allowCustom: true });
    if (!picked) return;
    this.selection.vendor = picked.value;
    const el = document.getElementById('bill-form-vendor-field');
    if (el) { el.textContent = picked.label; el.classList.remove('mb-placeholder'); }
  },

  // ── Line items (Phase 3) ─────────────────────────────────────────────
  _linesHtml() {
    if (this.lines.length === 0) return '<div class="mb-text-sm mb-text-steel mb-mb-2">No items added yet.</div>';
    return this.lines.map((line, i) => `
      <div class="mb-card" style="padding:var(--mb-sp-3);">
        <div class="mb-field" style="margin-bottom:var(--mb-sp-2);">
          <label>Item</label>
          <button type="button" class="mb-picker-field${line.name ? '' : ' mb-placeholder'}" onclick="MApp.Bill.pickLineItem(${i})">${line.name ? MApp.Util.escapeHtml(line.name) + (line.size ? ` (${MApp.Util.escapeHtml(line.size)})` : '') : 'Choose an item...'}</button>
        </div>
        <div class="mb-field" style="margin-bottom:var(--mb-sp-2);">
          <label>Quantity</label>
          <input type="number" inputmode="decimal" min="0" step="1" value="${line.qty === '' ? '' : line.qty}" oninput="MApp.Bill.updateLine(${i}, 'qty', this.value)">
        </div>
        <div class="mb-field" style="margin-bottom:var(--mb-sp-2);">
          <label>Unit Price</label>
          <input type="number" inputmode="decimal" min="0" step="0.01" value="${line.price || ''}" oninput="MApp.Bill.updateLine(${i}, 'price', this.value)">
        </div>
        <div class="mb-field" style="margin-bottom:0;">
          <label>GST %</label>
          <input type="number" inputmode="decimal" min="0" step="0.01" value="${line.gst != null ? line.gst : 18}" oninput="MApp.Bill.updateLine(${i}, 'gst', this.value)">
        </div>
        ${this.lines.length > 1 ? `<button type="button" class="mb-btn-text mb-mt-2" style="padding:0;min-height:auto;color:var(--mb-enamel-red);" onclick="MApp.Bill.removeLine(${i})">Remove</button>` : ''}
      </div>
    `).join('');
  },

  addLine() {
    this.lines.push({ name: '', size: '', unit: 'Pcs', qty: '', price: '', gst: 18 });
    const el = document.getElementById('bill-form-lines');
    if (el) el.innerHTML = this._linesHtml();
  },

  removeLine(i) {
    this.lines.splice(i, 1);
    if (this.lines.length === 0) this.lines.push({ name: '', size: '', unit: 'Pcs', qty: '', price: '', gst: 18 });
    const el = document.getElementById('bill-form-lines');
    if (el) el.innerHTML = this._linesHtml();
  },

  updateLine(i, key, value) {
    if (!this.lines[i]) return;
    this.lines[i][key] = MApp.Util.toNumber(value);
  },

  async pickLineItem(i) {
    if (!this.lines[i]) return;
    const items = (this.items || []).map(it => ({
      value: it.name + '||' + it.size, label: it.name, sublabel: it.size ? `Size: ${it.size}` : ''
    }));
    const picked = await MApp.Picker.open({
      title: 'Choose an item', items, selectedValue: this.lines[i].name + '||' + this.lines[i].size
    });
    if (!picked || !this.lines[i]) return;

    const match = (this.items || []).find(it => (it.name + '||' + it.size) === picked.value);
    this.lines[i].name = match ? match.name : picked.label;
    this.lines[i].size = match ? match.size : '';
    this.lines[i].unit = match ? match.baseUnit : 'Pcs';

    const el = document.getElementById('bill-form-lines');
    if (el) el.innerHTML = this._linesHtml();
  },

  async saveBill() {
    if (!this.selection.vendor) {
      MApp.Toast.error('Choose a vendor first.');
      return;
    }
    const billNumber = (document.getElementById('bill-form-number')?.value || '').trim();
    if (!billNumber) {
      MApp.Toast.error('Enter a bill number.');
      return;
    }
    const validLines = this.lines.filter(l => l.name && l.qty > 0);
    if (validLines.length === 0) {
      MApp.Toast.error('Add at least one item with a name and quantity greater than zero.');
      return;
    }

    const formData = {
      billNumber,
      billDate: document.getElementById('bill-form-date')?.value || MApp.Util.todayInputValue(),
      vendor: this.selection.vendor,
      contact: (document.getElementById('bill-form-contact')?.value || '').trim(),
      remarks: (document.getElementById('bill-form-remarks')?.value || '').trim(),
      items: JSON.stringify(validLines.map(l => ({
        name: l.name, size: l.size || '', narration: l.narration || '', unit: l.unit || 'Pcs',
        qty: l.qty, price: l.price || 0, gst: l.gst != null ? l.gst : 18
      })))
    };
    if (this.editingBillNumber) {
      formData.existingBillNumber = this.editingBillNumber;
      formData.existingVendor = this.editingBillVendor;
    }

    const isEdit = !!this.editingBillNumber;
    const saveBtn = document.getElementById('bill-form-save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

    const res = await MApp.Util.mutateSimple('saveBill', [formData], isEdit ? 'Bill updated.' : 'Bill saved.');
    if (res.success) {
      this.closeForm();
      this.openLedgerSheet();
      return;
    }
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = isEdit ? 'Save Changes' : 'Save Bill'; }
  },

  async deleteBillRecord(bill) {
    if (!MApp.Util.confirmDelete(bill.billNumber)) return;
    const res = await MApp.Util.mutateSimple('deleteBill', [bill.vendor, bill.billNumber], 'Bill deleted.');
    if (res.success) this.openLedgerSheet();
  }
};
// ================================================================
// ISSUED STOCK LOG (Phase 3, More tab) — read + create + delete. No
// edit-existing UI on mobile: saveIssueStock's own existingIssueId
// support is itself a PWA-only addition with no desktop equivalent (see
// issue_service.py's module docstring) -- create/delete-only here
// matches desktop's actual practice, same call as Wastage below.
// ================================================================
MApp.Issue = {
  records: [],
  filtered: [],
  searchTerm: '',
  items: [],
  lines: [],

  async open() {
    const listEl = document.getElementById('issue-log-list');
    const searchInput = document.getElementById('issue-log-search');
    if (searchInput) searchInput.value = '';
    this.searchTerm = '';
    MApp.Util.renderSkeleton(listEl, 4);
    MApp.Sheet.open('sheet-issue-log');

    try {
      const res = await MApp.Api.call('getIssueData');
      if (!res || !res.success) {
        MApp.Util.renderError(listEl, res && res.message, () => this.open());
        return;
      }
      this.records = res.data || [];
      this._applyFilters();
    } catch (err) {
      MApp.Util.renderError(listEl, err && err.message, () => this.open());
    }
  },

  close() {
    MApp.Sheet.close('sheet-issue-log');
  },

  onSearch(term) {
    this.searchTerm = String(term || '').trim().toLowerCase();
    this._applyFilters();
  },

  _applyFilters() {
    let list = this.records;
    if (this.searchTerm) {
      const term = this.searchTerm;
      list = list.filter(r =>
        String(r.issuedTo || '').toLowerCase().includes(term) ||
        (r.items || []).some(it => String(it.name || '').toLowerCase().includes(term)));
    }
    this.filtered = list;
    this.render();
  },

  render() {
    const listEl = document.getElementById('issue-log-list');
    if (!listEl) return;

    if (this.filtered.length === 0) {
      MApp.Util.renderEmpty(listEl, {
        title: 'No issued stock records found',
        body: this.records.length === 0 ? 'Tap "Log Issue" to record the first one.' : 'Try a different search term.'
      });
      return;
    }

    listEl.innerHTML = this.filtered.slice(0, 100).map((r, i) => {
      const itemSummary = (r.items || []).map(it => `${MApp.Util.escapeHtml(it.name)} (${MApp.Util.formatQty(it.qty)} ${MApp.Util.escapeHtml(it.unit || '')})`).join(', ');
      return `
      <div class="mb-card">
        <div class="mb-card-row">
          <div>
            <div class="mb-card-title">${MApp.Util.escapeHtml(r.issuedTo)}</div>
            <div class="mb-card-sub">${itemSummary}</div>
          </div>
          <div style="text-align:right;">
            <div class="mb-card-number">${MApp.Util.formatQty(r.totalQty)}</div>
            <div class="mb-card-sub">${MApp.Util.escapeHtml(r.date || '')}</div>
          </div>
        </div>
        ${r.reference ? `<div class="mb-card-sub mb-mt-2">Ref: ${MApp.Util.escapeHtml(r.reference)}</div>` : ''}
        <div class="mb-mt-2"><button type="button" class="mb-btn-text" style="padding:0;min-height:auto;color:var(--mb-enamel-red);" data-issue-index="${i}">Delete</button></div>
      </div>`;
    }).join('');

    listEl.querySelectorAll('[data-issue-index]').forEach(btn => {
      btn.addEventListener('click', () => {
        const record = this.filtered[Number(btn.dataset.issueIndex)];
        if (record) this.deleteIssue(record);
      });
    });
  },

  async openForm() {
    this.lines = [{ name: '', size: '', unit: 'Pcs', qty: '', rate: '' }];

    document.getElementById('issue-form-body').innerHTML = `
      <div class="mb-skel mb-skel-card" style="height:56px;"></div>
      <div class="mb-skel mb-skel-card" style="height:56px;"></div>`;
    MApp.Sheet.open('sheet-issue-form');

    const saveBtn = document.getElementById('issue-form-save-btn');
    if (saveBtn) saveBtn.disabled = true;

    try {
      // Always refetch (not just "if empty") so an item added earlier in
      // this same session shows up in the picker without a page reload.
      const itemsRes = await MApp.Api.call('getItemsData');
      this.items = (itemsRes && itemsRes.success) ? (itemsRes.data || []) : [];
      document.getElementById('issue-form-body').innerHTML = this._formHtml();
    } catch (err) {
      MApp.Toast.error('Could not load reference data: ' + (err.message || ''));
      this.closeForm();
      return;
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  },

  closeForm() {
    MApp.Sheet.close('sheet-issue-form');
  },

  _formHtml() {
    return `
      <div class="mb-field">
        <label for="issue-form-date">Date</label>
        <input type="date" id="issue-form-date" value="${MApp.Util.todayInputValue()}">
      </div>
      <div class="mb-field">
        <label for="issue-form-issuedto">Issued To</label>
        <input type="text" id="issue-form-issuedto" placeholder="Contractor or person name">
      </div>
      <div class="mb-field">
        <label for="issue-form-reference">Reference (optional)</label>
        <input type="text" id="issue-form-reference" placeholder="e.g. Production Lot #">
      </div>

      <div class="mapp-section-label">Items</div>
      <div id="issue-form-lines">${this._linesHtml()}</div>
      <button type="button" class="mb-btn mb-btn-secondary mb-mt-2 mb-mb-4" onclick="MApp.Issue.addLine()">+ Add Item</button>

      <div class="mb-field">
        <label for="issue-form-remarks">Remarks (optional)</label>
        <textarea id="issue-form-remarks" rows="3"></textarea>
      </div>
    `;
  },

  _linesHtml() {
    if (this.lines.length === 0) return '<div class="mb-text-sm mb-text-steel mb-mb-2">No items added yet.</div>';
    return this.lines.map((line, i) => `
      <div class="mb-card" style="padding:var(--mb-sp-3);">
        <div class="mb-field" style="margin-bottom:var(--mb-sp-2);">
          <label>Item</label>
          <button type="button" class="mb-picker-field${line.name ? '' : ' mb-placeholder'}" onclick="MApp.Issue.pickLineItem(${i})">${line.name ? MApp.Util.escapeHtml(line.name) + (line.size ? ` (${MApp.Util.escapeHtml(line.size)})` : '') : 'Choose an item...'}</button>
        </div>
        <div class="mb-field" style="margin-bottom:var(--mb-sp-2);">
          <label>Quantity</label>
          <input type="number" inputmode="decimal" min="0" step="1" value="${line.qty === '' ? '' : line.qty}" oninput="MApp.Issue.updateLine(${i}, 'qty', this.value)">
        </div>
        <div class="mb-field" style="margin-bottom:0;">
          <label>Rate (optional)</label>
          <input type="number" inputmode="decimal" min="0" step="0.01" value="${line.rate === '' ? '' : line.rate}" oninput="MApp.Issue.updateLine(${i}, 'rate', this.value)">
        </div>
        ${this.lines.length > 1 ? `<button type="button" class="mb-btn-text mb-mt-2" style="padding:0;min-height:auto;color:var(--mb-enamel-red);" onclick="MApp.Issue.removeLine(${i})">Remove</button>` : ''}
      </div>
    `).join('');
  },

  addLine() {
    this.lines.push({ name: '', size: '', unit: 'Pcs', qty: '', rate: '' });
    const el = document.getElementById('issue-form-lines');
    if (el) el.innerHTML = this._linesHtml();
  },

  removeLine(i) {
    this.lines.splice(i, 1);
    if (this.lines.length === 0) this.lines.push({ name: '', size: '', unit: 'Pcs', qty: '', rate: '' });
    const el = document.getElementById('issue-form-lines');
    if (el) el.innerHTML = this._linesHtml();
  },

  updateLine(i, key, value) {
    if (!this.lines[i]) return;
    this.lines[i][key] = MApp.Util.toNumber(value);
  },

  async pickLineItem(i) {
    if (!this.lines[i]) return;
    const items = (this.items || []).map(it => ({
      value: it.name + '||' + it.size, label: it.name, sublabel: it.size ? `Size: ${it.size}` : ''
    }));
    const picked = await MApp.Picker.open({
      title: 'Choose an item', items, selectedValue: this.lines[i].name + '||' + this.lines[i].size
    });
    if (!picked || !this.lines[i]) return;
    const match = (this.items || []).find(it => (it.name + '||' + it.size) === picked.value);
    this.lines[i].name = match ? match.name : picked.label;
    this.lines[i].size = match ? match.size : '';
    this.lines[i].unit = match ? match.baseUnit : 'Pcs';

    const el = document.getElementById('issue-form-lines');
    if (el) el.innerHTML = this._linesHtml();
  },

  async save() {
    const issuedTo = (document.getElementById('issue-form-issuedto')?.value || '').trim();
    if (!issuedTo) {
      MApp.Toast.error('Enter who this stock was issued to.');
      return;
    }
    const validLines = this.lines.filter(l => l.name && l.qty > 0);
    if (validLines.length === 0) {
      MApp.Toast.error('Add at least one item with a name and quantity greater than zero.');
      return;
    }

    const formData = {
      date: document.getElementById('issue-form-date')?.value || MApp.Util.todayInputValue(),
      issuedTo,
      reference: (document.getElementById('issue-form-reference')?.value || '').trim(),
      remarks: (document.getElementById('issue-form-remarks')?.value || '').trim(),
      items: JSON.stringify(validLines.map(l => ({ name: l.name, size: l.size || '', unit: l.unit || 'Pcs', qty: l.qty, rate: l.rate || 0 })))
    };

    const saveBtn = document.getElementById('issue-form-save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

    const res = await MApp.Util.mutateSimple('saveIssueStock', [formData], 'Stock issue logged.');
    if (res.success) {
      this.closeForm();
      this.open();
      return;
    }
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Log Issue'; }
  },

  // deleteIssueBulk takes a plain array (not a form_data object), sent as
  // a single positional arg -- a one-element array for a single-record
  // delete, matching desktop's own "delete one" = "bulk-delete of one".
  async deleteIssue(record) {
    if (!MApp.Util.confirmDelete(record.issueId)) return;
    const res = await MApp.Util.mutateSimple('deleteIssueBulk', [[record.issueId]], 'Issue record deleted.');
    if (res.success) this.open();
  }
};
// ================================================================
// WASTAGE LOG (Phase 3, More tab) — read + create + delete, same scope
// call as Issued Stock above (no edit-existing UI on mobile).
// ================================================================
MApp.Wastage = {
  records: [],
  filtered: [],
  searchTerm: '',
  items: [],
  lines: [],

  async open() {
    const listEl = document.getElementById('wastage-log-list');
    const searchInput = document.getElementById('wastage-log-search');
    if (searchInput) searchInput.value = '';
    this.searchTerm = '';
    MApp.Util.renderSkeleton(listEl, 4);
    MApp.Sheet.open('sheet-wastage-log');

    try {
      const res = await MApp.Api.call('getWastageData');
      if (!res || !res.success) {
        MApp.Util.renderError(listEl, res && res.message, () => this.open());
        return;
      }
      this.records = res.data || [];
      this._applyFilters();
    } catch (err) {
      MApp.Util.renderError(listEl, err && err.message, () => this.open());
    }
  },

  close() {
    MApp.Sheet.close('sheet-wastage-log');
  },

  onSearch(term) {
    this.searchTerm = String(term || '').trim().toLowerCase();
    this._applyFilters();
  },

  _applyFilters() {
    let list = this.records;
    if (this.searchTerm) {
      const term = this.searchTerm;
      list = list.filter(r =>
        String(r.vendor || '').toLowerCase().includes(term) ||
        (r.items || []).some(it => String(it.name || '').toLowerCase().includes(term)));
    }
    this.filtered = list;
    this.render();
  },

  render() {
    const listEl = document.getElementById('wastage-log-list');
    if (!listEl) return;

    if (this.filtered.length === 0) {
      MApp.Util.renderEmpty(listEl, {
        title: 'No wastage records found',
        body: this.records.length === 0 ? 'Tap "Log Wastage" to record the first one.' : 'Try a different search term.'
      });
      return;
    }

    listEl.innerHTML = this.filtered.slice(0, 100).map((r, i) => {
      const itemSummary = (r.items || []).map(it => `${MApp.Util.escapeHtml(it.name)} (${MApp.Util.formatQty(it.qty)} ${MApp.Util.escapeHtml(it.unit || '')})`).join(', ');
      return `
      <div class="mb-card">
        <div class="mb-card-row">
          <div>
            <div class="mb-card-title">${MApp.Util.escapeHtml(r.vendor || 'No vendor')}</div>
            <div class="mb-card-sub">${itemSummary}</div>
          </div>
          <div style="text-align:right;">
            <div class="mb-card-number">${MApp.Util.formatQty(r.totalQty)}</div>
            <div class="mb-card-sub">${MApp.Util.escapeHtml(r.date || '')}</div>
          </div>
        </div>
        <div class="mb-mt-2"><button type="button" class="mb-btn-text" style="padding:0;min-height:auto;color:var(--mb-enamel-red);" data-wastage-index="${i}">Delete</button></div>
      </div>`;
    }).join('');

    listEl.querySelectorAll('[data-wastage-index]').forEach(btn => {
      btn.addEventListener('click', () => {
        const record = this.filtered[Number(btn.dataset.wastageIndex)];
        if (record) this.deleteWastage(record);
      });
    });
  },

  async openForm() {
    this.lines = [{ name: '', size: '', unit: 'Pcs', qty: '', reason: '' }];

    document.getElementById('wastage-form-body').innerHTML = `
      <div class="mb-skel mb-skel-card" style="height:56px;"></div>
      <div class="mb-skel mb-skel-card" style="height:56px;"></div>`;
    MApp.Sheet.open('sheet-wastage-form');

    const saveBtn = document.getElementById('wastage-form-save-btn');
    if (saveBtn) saveBtn.disabled = true;

    try {
      // Always refetch (not just "if empty") so an item added earlier in
      // this same session shows up in the picker without a page reload.
      const itemsRes = await MApp.Api.call('getItemsData');
      this.items = (itemsRes && itemsRes.success) ? (itemsRes.data || []) : [];
      document.getElementById('wastage-form-body').innerHTML = this._formHtml();
    } catch (err) {
      MApp.Toast.error('Could not load reference data: ' + (err.message || ''));
      this.closeForm();
      return;
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  },

  closeForm() {
    MApp.Sheet.close('sheet-wastage-form');
  },

  _formHtml() {
    return `
      <div class="mb-field">
        <label for="wastage-form-date">Date</label>
        <input type="date" id="wastage-form-date" value="${MApp.Util.todayInputValue()}">
      </div>
      <div class="mb-field">
        <label for="wastage-form-vendor">Vendor (optional)</label>
        <input type="text" id="wastage-form-vendor">
      </div>

      <div class="mapp-section-label">Items</div>
      <div id="wastage-form-lines">${this._linesHtml()}</div>
      <button type="button" class="mb-btn mb-btn-secondary mb-mt-2 mb-mb-4" onclick="MApp.Wastage.addLine()">+ Add Item</button>

      <div class="mb-field">
        <label for="wastage-form-remarks">Remarks (optional)</label>
        <textarea id="wastage-form-remarks" rows="3"></textarea>
      </div>
    `;
  },

  _linesHtml() {
    if (this.lines.length === 0) return '<div class="mb-text-sm mb-text-steel mb-mb-2">No items added yet.</div>';
    return this.lines.map((line, i) => `
      <div class="mb-card" style="padding:var(--mb-sp-3);">
        <div class="mb-field" style="margin-bottom:var(--mb-sp-2);">
          <label>Item</label>
          <button type="button" class="mb-picker-field${line.name ? '' : ' mb-placeholder'}" onclick="MApp.Wastage.pickLineItem(${i})">${line.name ? MApp.Util.escapeHtml(line.name) + (line.size ? ` (${MApp.Util.escapeHtml(line.size)})` : '') : 'Choose an item...'}</button>
        </div>
        <div class="mb-field" style="margin-bottom:var(--mb-sp-2);">
          <label>Quantity</label>
          <input type="number" inputmode="decimal" min="0" step="1" value="${line.qty === '' ? '' : line.qty}" oninput="MApp.Wastage.updateLine(${i}, 'qty', this.value)">
        </div>
        <div class="mb-field" style="margin-bottom:0;">
          <label>Reason</label>
          <input type="text" value="${MApp.Util.escapeHtml(line.reason || '')}" oninput="MApp.Wastage.updateLineText(${i}, 'reason', this.value)">
        </div>
        ${this.lines.length > 1 ? `<button type="button" class="mb-btn-text mb-mt-2" style="padding:0;min-height:auto;color:var(--mb-enamel-red);" onclick="MApp.Wastage.removeLine(${i})">Remove</button>` : ''}
      </div>
    `).join('');
  },

  addLine() {
    this.lines.push({ name: '', size: '', unit: 'Pcs', qty: '', reason: '' });
    const el = document.getElementById('wastage-form-lines');
    if (el) el.innerHTML = this._linesHtml();
  },

  removeLine(i) {
    this.lines.splice(i, 1);
    if (this.lines.length === 0) this.lines.push({ name: '', size: '', unit: 'Pcs', qty: '', reason: '' });
    const el = document.getElementById('wastage-form-lines');
    if (el) el.innerHTML = this._linesHtml();
  },

  updateLine(i, key, value) {
    if (!this.lines[i]) return;
    this.lines[i][key] = MApp.Util.toNumber(value);
  },

  updateLineText(i, key, value) {
    if (!this.lines[i]) return;
    this.lines[i][key] = value;
  },

  async pickLineItem(i) {
    if (!this.lines[i]) return;
    const items = (this.items || []).map(it => ({
      value: it.name + '||' + it.size, label: it.name, sublabel: it.size ? `Size: ${it.size}` : ''
    }));
    const picked = await MApp.Picker.open({
      title: 'Choose an item', items, selectedValue: this.lines[i].name + '||' + this.lines[i].size
    });
    if (!picked || !this.lines[i]) return;
    const match = (this.items || []).find(it => (it.name + '||' + it.size) === picked.value);
    this.lines[i].name = match ? match.name : picked.label;
    this.lines[i].size = match ? match.size : '';
    this.lines[i].unit = match ? match.baseUnit : 'Pcs';

    const el = document.getElementById('wastage-form-lines');
    if (el) el.innerHTML = this._linesHtml();
  },

  async save() {
    const validLines = this.lines.filter(l => l.name && l.qty > 0);
    if (validLines.length === 0) {
      MApp.Toast.error('Add at least one item with a name and quantity greater than zero.');
      return;
    }

    const formData = {
      date: document.getElementById('wastage-form-date')?.value || MApp.Util.todayInputValue(),
      vendor: (document.getElementById('wastage-form-vendor')?.value || '').trim(),
      remarks: (document.getElementById('wastage-form-remarks')?.value || '').trim(),
      items: JSON.stringify(validLines.map(l => ({ name: l.name, size: l.size || '', unit: l.unit || 'Pcs', qty: l.qty, reason: l.reason || '' })))
    };

    const saveBtn = document.getElementById('wastage-form-save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

    const res = await MApp.Util.mutateSimple('saveWastage', [formData], 'Wastage logged.');
    if (res.success) {
      this.closeForm();
      this.open();
      return;
    }
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Log Wastage'; }
  },

  async deleteWastage(record) {
    if (!MApp.Util.confirmDelete(record.wastageId)) return;
    const res = await MApp.Util.mutateSimple('deleteWastageBulk', [[record.wastageId]], 'Wastage record deleted.');
    if (res.success) this.open();
  }
};
// ================================================================
// ITEMS LOOKUP (More tab) — read-only search sheet over the full item
// master, for a quick "does this item exist / what's it called" check.
// ================================================================
MApp.Items = {
  items: [],
  filtered: [],
  editingItem: null,
  vendorRows: [],
  photoBase64: null,

  async openLookupSheet() {
    const listEl = document.getElementById('items-lookup-list');
    const searchInput = document.getElementById('items-lookup-search');
    if (searchInput) searchInput.value = '';
    MApp.Util.renderSkeleton(listEl, 5);
    MApp.Sheet.open('sheet-items-lookup');

    try {
      const res = await MApp.Api.call('getItemsData');
      if (!res || !res.success) {
        MApp.Util.renderError(listEl, res && res.message, () => this.openLookupSheet());
        return;
      }
      this.items = res.data || [];

      // Stock-on-hand lives in a separate sheet (getStockData), keyed by
      // (name, size) -- fetched alongside items but allowed to fail open:
      // this is a secondary enhancement, not the primary data this screen
      // exists for, so a stock-load failure shouldn't block the lookup
      // itself (items just render without a stock figure).
      try {
        const stockRes = await MApp.Api.call('getStockData');
        if (stockRes && stockRes.success) {
          const stockMap = new Map();
          (stockRes.data || []).forEach(s => {
            stockMap.set(s.name.toLowerCase() + '|' + s.size.toLowerCase(), s);
          });
          this.items.forEach(it => {
            const stock = stockMap.get(it.name.toLowerCase() + '|' + (it.size || '').toLowerCase());
            it.currentStock = stock ? stock.currentStock : null;
            it.isLowStock = stock ? stock.isLowStock : false;
          });
        }
      } catch (stockErr) {
        // Non-critical -- item lookup still works without stock figures.
      }

      this.filtered = this.items;
      this.render();
    } catch (err) {
      MApp.Util.renderError(listEl, err && err.message, () => this.openLookupSheet());
    }
  },

  closeLookupSheet() {
    MApp.Sheet.close('sheet-items-lookup');
  },

  onSearch(term) {
    const lower = String(term || '').toLowerCase();
    this.filtered = !lower ? this.items : this.items.filter(it =>
      it.name.toLowerCase().includes(lower) ||
      (it.size || '').toLowerCase().includes(lower) ||
      (it.narration || '').toLowerCase().includes(lower));
    this.render();
  },

  render() {
    const listEl = document.getElementById('items-lookup-list');
    if (!listEl) return;

    if (this.filtered.length === 0) {
      MApp.Util.renderEmpty(listEl, { title: 'No items found', body: 'Try a different search term.' });
      return;
    }

    // currentStock is null when getStockData() failed or this item/size
    // has no Stock row yet (see openLookupSheet) -- distinct from a real 0.
    listEl.innerHTML = this.filtered.slice(0, 100).map((it, i) => `
      <div class="mb-card">
        <div class="mb-card-row">
          <div>
            <div class="mb-card-title">${MApp.Util.escapeHtml(it.name)}</div>
            <div class="mb-card-sub">${MApp.Util.escapeHtml(it.size || 'No size')}${it.narration ? ' · ' + MApp.Util.escapeHtml(it.narration) : ''}</div>
          </div>
          ${it.currentStock !== null && it.currentStock !== undefined ? `
          <div style="text-align:right;">
            <div class="mb-card-number${it.isLowStock ? ' mb-alert' : ''}">${MApp.Util.formatQty(it.currentStock)}</div>
            <div class="mb-card-sub">${MApp.Util.escapeHtml(it.baseUnit)}</div>
          </div>` : `<div class="mb-card-sub">${MApp.Util.escapeHtml(it.baseUnit)}</div>`}
        </div>
        ${it.isLowStock ? '<div class="mb-mt-2"><span class="mb-chip mb-chip-lowstock">Low stock</span></div>' : ''}
        <div class="mb-mt-2"><button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" data-edit-item="${i}">Edit</button></div>
      </div>
    `).join('');

    listEl.querySelectorAll('[data-edit-item]').forEach(btn => {
      btn.addEventListener('click', () => {
        const item = this.filtered[Number(btn.dataset.editItem)];
        if (item) this.openForm(item);
      });
    });
  },

  // ── Add/Edit (Phase 1) ──────────────────────────────────────────────
  openForm(item) {
    this.editingItem = item || null;
    this.vendorRows = item && Array.isArray(item.vendors) ? item.vendors.map(v => ({ vendor: v.vendor, rate: v.rate })) : [];
    this.photoBase64 = item ? (item.image || null) : null;

    const titleEl = document.getElementById('item-form-title');
    if (titleEl) titleEl.textContent = item ? 'Edit Item' : 'Add Item';

    this._renderForm();

    const deleteBtn = document.getElementById('item-form-delete-btn');
    if (deleteBtn) deleteBtn.classList.toggle('mb-hidden', !item);
    const saveBtn = document.getElementById('item-form-save-btn');
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }

    MApp.Sheet.open('sheet-item-form');
  },

  closeForm() {
    MApp.Sheet.close('sheet-item-form');
  },

  _renderForm() {
    const body = document.getElementById('item-form-body');
    if (!body) return;
    const it = this.editingItem || {};
    body.innerHTML = `
      <div class="mb-field">
        <label>Photo</label>
        <div style="display:flex; align-items:center; gap:var(--mb-sp-3);">
          <img id="item-form-photo-preview" src="${MApp.Util.escapeHtml(this.photoBase64 || '')}" alt="" style="width:56px;height:56px;border-radius:var(--mb-radius-sm);object-fit:cover;background:var(--mb-steel-faint);${this.photoBase64 ? '' : 'display:none;'}">
          <input type="file" accept="image/*" id="item-form-photo-input" onchange="MApp.Items.onPhotoChange(this.files[0])">
        </div>
      </div>
      <div class="mb-field">
        <label for="item-form-name">Item Name</label>
        <input type="text" id="item-form-name" value="${MApp.Util.escapeHtml(it.name || '')}">
      </div>
      <div class="mb-field">
        <label for="item-form-size">Size</label>
        <input type="text" id="item-form-size" value="${MApp.Util.escapeHtml(it.size || '')}">
      </div>
      <div class="mb-field">
        <label for="item-form-narration">Narration</label>
        <input type="text" id="item-form-narration" value="${MApp.Util.escapeHtml(it.narration || '')}">
      </div>
      <div class="mb-field">
        <label for="item-form-spec">Specification</label>
        <input type="text" id="item-form-spec" value="${MApp.Util.escapeHtml(it.specification || '')}">
      </div>
      <div class="mb-field">
        <label for="item-form-remarks">Remarks</label>
        <textarea id="item-form-remarks" rows="2">${MApp.Util.escapeHtml(it.remarks || '')}</textarea>
      </div>
      <div class="mb-field">
        <label for="item-form-base-unit">Base Unit</label>
        <input type="text" id="item-form-base-unit" value="${MApp.Util.escapeHtml(it.baseUnit || 'Pcs')}">
      </div>
      <div class="mb-field">
        <label for="item-form-purchase-unit">Purchase Unit</label>
        <input type="text" id="item-form-purchase-unit" value="${MApp.Util.escapeHtml(it.purchaseUnit || '')}" placeholder="Same as base unit">
      </div>
      <div class="mb-field">
        <label for="item-form-weight">Weight per Base Unit</label>
        <input type="number" id="item-form-weight" inputmode="decimal" step="any" value="${it.weightPerBaseUnit != null ? it.weightPerBaseUnit : ''}">
      </div>
      ${!this.editingItem ? `
      <div class="mb-field">
        <label for="item-form-initial-stock">Initial Stock</label>
        <input type="number" id="item-form-initial-stock" inputmode="decimal" step="any" placeholder="0">
      </div>` : ''}
      <div class="mapp-section-label mb-mt-4">Vendors &amp; Rates</div>
      <div id="item-form-vendor-rows">${this._vendorRowsHtml()}</div>
      <button type="button" class="mb-btn mb-btn-secondary mb-mt-2" onclick="MApp.Items.addVendorRow()">+ Add Vendor &amp; Rate</button>
    `;
  },

  _vendorRowsHtml() {
    if (this.vendorRows.length === 0) return '<div class="mb-text-sm mb-text-steel mb-mb-4">No vendors linked yet.</div>';
    return this.vendorRows.map((row, i) => `
      <div class="mb-card" style="padding:var(--mb-sp-3);">
        <div class="mb-field" style="margin-bottom:var(--mb-sp-2);">
          <label>Vendor Name</label>
          <input type="text" value="${MApp.Util.escapeHtml(row.vendor || '')}" oninput="MApp.Items.updateVendorRow(${i}, 'vendor', this.value)">
        </div>
        <div class="mb-field" style="margin-bottom:0;">
          <label>Rate</label>
          <input type="number" inputmode="decimal" step="any" value="${row.rate != null ? row.rate : ''}" oninput="MApp.Items.updateVendorRow(${i}, 'rate', this.value)">
        </div>
        <button type="button" class="mb-btn-text mb-mt-2" style="padding:0;min-height:auto;color:var(--mb-enamel-red);" onclick="MApp.Items.removeVendorRow(${i})">Remove</button>
      </div>
    `).join('');
  },

  addVendorRow() {
    this.vendorRows.push({ vendor: '', rate: 0 });
    const el = document.getElementById('item-form-vendor-rows');
    if (el) el.innerHTML = this._vendorRowsHtml();
  },

  removeVendorRow(i) {
    this.vendorRows.splice(i, 1);
    const el = document.getElementById('item-form-vendor-rows');
    if (el) el.innerHTML = this._vendorRowsHtml();
  },

  updateVendorRow(i, key, value) {
    if (!this.vendorRows[i]) return;
    this.vendorRows[i][key] = key === 'rate' ? MApp.Util.toNumber(value) : value;
  },

  async onPhotoChange(file) {
    if (!file) return;
    try {
      this.photoBase64 = await MApp.Util.resizeImageToBase64(file, 800);
      const preview = document.getElementById('item-form-photo-preview');
      if (preview) { preview.src = this.photoBase64; preview.style.display = ''; }
    } catch (err) {
      MApp.Toast.error(err.message || 'Could not read that photo.');
    }
  },

  async saveItem() {
    const name = (document.getElementById('item-form-name')?.value || '').trim();
    if (!name) { MApp.Toast.error('Enter an item name.'); return; }

    const formData = {
      itemName: name,
      itemSize: (document.getElementById('item-form-size')?.value || '').trim(),
      itemNarration: (document.getElementById('item-form-narration')?.value || '').trim(),
      itemSpec: (document.getElementById('item-form-spec')?.value || '').trim(),
      itemRemarks: (document.getElementById('item-form-remarks')?.value || '').trim(),
      itemBaseUnit: (document.getElementById('item-form-base-unit')?.value || '').trim() || 'Pcs',
      itemPurchaseUnit: (document.getElementById('item-form-purchase-unit')?.value || '').trim(),
      itemWeightPerBaseUnit: MApp.Util.toNumber(document.getElementById('item-form-weight')?.value),
      vendors: JSON.stringify(this.vendorRows.filter(r => r.vendor))
    };
    if (this.photoBase64) formData.itemImage = this.photoBase64;
    if (this.editingItem) {
      formData.originalName = this.editingItem.name;
      formData.originalSize = this.editingItem.size || '';
    } else {
      const initialStockEl = document.getElementById('item-form-initial-stock');
      if (initialStockEl && initialStockEl.value !== '') formData.itemInitialStock = MApp.Util.toNumber(initialStockEl.value);
    }

    const saveBtn = document.getElementById('item-form-save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

    // A name/size collision with a DIFFERENT existing item comes back as an
    // ordinary {success:false} here (data.mergeable, per saveItem's own
    // contract) -- mutateSimple's generic failure toast already surfaces
    // the server's message, and per this phase's scope decision, mobile
    // stops there rather than offering a merge flow (that stays a desktop
    // task, same as the other complex/rare screens in the hybrid plan).
    const res = await MApp.Util.mutateSimple('saveItem', [formData], 'Item saved.');
    if (res.success) {
      this.closeForm();
      this.openLookupSheet();
      return;
    }
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
  },

  async deleteItem() {
    if (!this.editingItem) return;
    if (!MApp.Util.confirmDelete(this.editingItem.name)) return;

    const res = await MApp.Util.mutateSimple('deleteItem', [this.editingItem.name, this.editingItem.size || ''], 'Item deleted.');
    if (res.success) {
      this.closeForm();
      this.openLookupSheet();
    }
  }
};

// ================================================================
// DIRECTORY (read-only) — shared by Vendors/Clients/Contractors, one
// sheet instance reused across all 3 (see sheet-directory in
// mobile_views.html): the 3 desktop list APIs are structurally identical
// (name, contact, address, gstin/gstPan, remarks) and none of them
// returns a pre-computed "outstanding" figure -- that's a client-side
// calculation on desktop (e.g. App.Vendor.calculateLedgerAndPending)
// built from separate PO/Bill/Return/Payment reads, out of scope for
// this read-only first pass. Contact renders as a tel: link.
// ================================================================
MApp.Directory = {
  // Phase 1 (mobile-parity): saveMethod/deleteMethod/nameFormKey/identityKey/
  // fields turn this same read-only config into a create+edit+delete driver
  // for sheet-entity-form -- `fields` excludes the name field itself (every
  // type has one, rendered separately in openForm) and maps 1:1 onto each
  // save RPC's form_data keys (confirmed against items_service.py's siblings:
  // vendors_service/clients_service/contractors_service all take flat
  // name+contact+address+…+remarks, no Select2/nested structure).
  CONFIGS: {
    vendor: {
      title: 'Vendors', api: 'getVendorsData', emptyBody: 'No vendors registered yet.',
      saveMethod: 'saveVendor', deleteMethod: 'deleteVendor',
      nameFormKey: 'vendorName', identityKey: 'originalVendorName',
      fields: [
        { key: 'contact', label: 'Contact Number' },
        { key: 'gstin', label: 'GSTIN' },
        { key: 'address', label: 'Address', multiline: true },
        { key: 'remarks', label: 'Remarks', multiline: true }
      ]
    },
    client: {
      title: 'Clients', api: 'getClientsData', emptyBody: 'No clients registered yet.',
      saveMethod: 'saveClient', deleteMethod: 'deleteClient',
      nameFormKey: 'clientName', identityKey: 'originalClientName',
      fields: [
        { key: 'contact', label: 'Contact Number' },
        { key: 'gstin', label: 'GSTIN' },
        { key: 'address', label: 'Address', multiline: true },
        { key: 'remarks', label: 'Remarks', multiline: true }
      ]
    },
    contractor: {
      title: 'Contractors', api: 'getContractorsData', emptyBody: 'No contractors registered yet.',
      saveMethod: 'saveContractor', deleteMethod: 'deleteContractor',
      nameFormKey: 'contractorName', identityKey: 'originalContractorName',
      fields: [
        { key: 'contact', label: 'Contact Number' },
        { key: 'gstPan', label: 'GST / PAN' },
        { key: 'address', label: 'Address', multiline: true },
        { key: 'remarks', label: 'Remarks', multiline: true }
      ]
    }
  },
  type: null,
  items: [],
  filtered: [],
  searchTerm: '',
  editingRecord: null,
  _rateContractor: null,
  _paymentContractor: null,

  async open(type) {
    const cfg = this.CONFIGS[type];
    if (!cfg) return;
    this.type = type;

    const titleEl = document.getElementById('directory-title');
    if (titleEl) titleEl.textContent = cfg.title;
    const fabLabelEl = document.getElementById('directory-fab-label');
    if (fabLabelEl) fabLabelEl.textContent = 'Add ' + cfg.title.replace(/s$/, '');

    const listEl = document.getElementById('directory-list');
    const searchInput = document.getElementById('directory-search');
    if (searchInput) {
      searchInput.value = '';
      searchInput.placeholder = `Search ${cfg.title.toLowerCase()}...`;
    }
    this.searchTerm = '';
    MApp.Util.renderSkeleton(listEl, 5);
    MApp.Sheet.open('sheet-directory');

    try {
      const res = await MApp.Api.call(cfg.api);
      if (!res || !res.success) {
        MApp.Util.renderError(listEl, res && res.message, () => this.open(type));
        return;
      }
      this.items = this._normalize(type, res.data || []);
      this.filtered = this.items;
      this.render();
    } catch (err) {
      MApp.Util.renderError(listEl, err && err.message, () => this.open(type));
    }
  },

  // Contractors' own records use contractorName, not name (getContractorsData
  // -- confirmed in Round M3's pickAssignedTo fix). Vendors/Clients already
  // use name directly. Normalizing here keeps render()/onSearch() identical
  // across all 3 types, matching source's own "structurally identical" design
  // intent -- source itself only worked for vendor/client since it read
  // e.name unconditionally, and would have shown blank contractor names.
  _normalize(type, records) {
    if (type !== 'contractor') return records;
    return records.map(c => ({ ...c, name: c.contractorName }));
  },

  close() {
    MApp.Sheet.close('sheet-directory');
  },

  onSearch(term) {
    this.searchTerm = String(term || '').trim().toLowerCase();
    this.filtered = !this.searchTerm ? this.items : this.items.filter(e =>
      e.name.toLowerCase().includes(this.searchTerm) ||
      (e.contact || '').toLowerCase().includes(this.searchTerm));
    this.render();
  },

  render() {
    const listEl = document.getElementById('directory-list');
    if (!listEl) return;
    const cfg = this.CONFIGS[this.type] || {};

    if (this.filtered.length === 0) {
      MApp.Util.renderEmpty(listEl, {
        title: `No ${(cfg.title || 'entries').toLowerCase()} found`,
        body: this.items.length === 0 ? (cfg.emptyBody || 'None recorded yet.') : 'Try a different search term.'
      });
      return;
    }

    listEl.innerHTML = this.filtered.slice(0, 100).map(e => {
      const contactHtml = e.contact
        ? `<a href="tel:${MApp.Util.escapeHtml(e.contact)}" onclick="event.stopPropagation()">${MApp.Util.escapeHtml(e.contact)}</a>`
        : 'No contact on file';
      // Contractors get 2 extra quick-add actions (Rate/Payment) alongside
      // Edit; Vendors/Clients just get Edit. Kept as separate <button>s
      // (not a tappable card) so nothing here nests interactive content.
      const actions = this.type === 'contractor'
        ? [['edit', 'Edit'], ['rate', '+ Rate'], ['charge', '+ Charge'], ['payment', '+ Payment']]
        : [['edit', 'Edit']];
      const actionsHtml = actions.map(([action, label]) =>
        `<button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" data-action="${action}" data-name="${MApp.Util.escapeHtml(e.name)}">${label}</button>`
      ).join('');
      return `
        <div class="mb-card">
          <div class="mb-card-title">${MApp.Util.escapeHtml(MApp.Util.formatNameCase(e.name))}</div>
          <div class="mb-card-sub">${contactHtml}</div>
          ${e.address ? `<div class="mb-card-sub" style="margin-top:2px;">${MApp.Util.escapeHtml(e.address)}</div>` : ''}
          <div class="mb-mt-2" style="display:flex; gap:var(--mb-sp-4);">${actionsHtml}</div>
        </div>
      `;
    }).join('');

    listEl.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const record = this.filtered.find(x => x.name === btn.dataset.name);
        if (!record) return;
        if (btn.dataset.action === 'edit') this.openForm(record);
        else if (btn.dataset.action === 'rate') this.openRateSheet(record.name);
        else if (btn.dataset.action === 'charge') this.openExtraChargeSheet(record.name);
        else if (btn.dataset.action === 'payment') this.openPaymentSheet(record.name);
      });
    });
  },

  // ── Add/Edit (Phase 1) ──────────────────────────────────────────────
  openForm(record) {
    const cfg = this.CONFIGS[this.type];
    if (!cfg) return;
    this.editingRecord = record || null;
    const singular = cfg.title.replace(/s$/, '');

    const titleEl = document.getElementById('entity-form-title');
    if (titleEl) titleEl.textContent = record ? `Edit ${singular}` : `Add ${singular}`;

    const body = document.getElementById('entity-form-body');
    if (body) {
      body.innerHTML = `
        <div class="mb-field">
          <label for="entity-form-name">${singular} Name</label>
          <input type="text" id="entity-form-name" value="${MApp.Util.escapeHtml(record ? record.name : '')}">
        </div>
        ${cfg.fields.map(f => `
          <div class="mb-field">
            <label for="entity-form-${f.key}">${f.label}</label>
            ${f.multiline
              ? `<textarea id="entity-form-${f.key}" rows="2">${MApp.Util.escapeHtml(record ? (record[f.key] || '') : '')}</textarea>`
              : `<input type="text" id="entity-form-${f.key}" value="${MApp.Util.escapeHtml(record ? (record[f.key] || '') : '')}">`}
          </div>
        `).join('')}
      `;
    }

    const deleteBtn = document.getElementById('entity-form-delete-btn');
    if (deleteBtn) deleteBtn.classList.toggle('mb-hidden', !record);
    const saveBtn = document.getElementById('entity-form-save-btn');
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }

    MApp.Sheet.open('sheet-entity-form');
  },

  closeForm() {
    MApp.Sheet.close('sheet-entity-form');
  },

  async saveEntity() {
    const cfg = this.CONFIGS[this.type];
    if (!cfg) return;
    const singular = cfg.title.replace(/s$/, '');
    const name = (document.getElementById('entity-form-name')?.value || '').trim();
    if (!name) {
      MApp.Toast.error(`Enter a ${singular.toLowerCase()} name.`);
      return;
    }

    const formData = { [cfg.nameFormKey]: name };
    cfg.fields.forEach(f => {
      formData[f.key] = (document.getElementById(`entity-form-${f.key}`)?.value || '').trim();
    });
    if (this.editingRecord) formData[cfg.identityKey] = this.editingRecord.name;

    const saveBtn = document.getElementById('entity-form-save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

    const res = await MApp.Util.mutateSimple(cfg.saveMethod, [formData], `${singular} saved.`);
    if (res.success) {
      this.closeForm();
      this.open(this.type);
    } else if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
  },

  async deleteEntity() {
    const cfg = this.CONFIGS[this.type];
    if (!cfg || !this.editingRecord) return;
    const singular = cfg.title.replace(/s$/, '');
    if (!MApp.Util.confirmDelete(this.editingRecord.name)) return;

    const res = await MApp.Util.mutateSimple(cfg.deleteMethod, [this.editingRecord.name], `${singular} deleted.`);
    if (res.success) {
      this.closeForm();
      this.open(this.type);
    }
  },

  // ── Contractor quick-add sub-flows (Phase 1) ────────────────────────

  // Process Type options are fetched fresh on open rather than relying on
  // MApp.Production.processTypes -- this sheet must work even if the
  // Production tab was never visited this session. Size reuses
  // MApp.Production.PROCESS_SIZE_LIST directly (no session load needed).
  async _populateRateTypeAndSizeSelects() {
    const typeSelect = document.getElementById('contractor-rate-process-type');
    const sizeSelect = document.getElementById('contractor-rate-size');
    if (!typeSelect || !sizeSelect) return;

    typeSelect.innerHTML = '<option value="">Loading…</option>';
    let types = [];
    try {
      const res = await MApp.Api.call('getProcessTypes');
      types = (res && res.success) ? (res.data || []) : [];
    } catch (err) {
      types = [];
    }
    typeSelect.innerHTML = '<option value="">Choose a Process Type…</option>' +
      types.map(t => `<option value="${MApp.Util.escapeHtml(t.name)}">${MApp.Util.escapeHtml(t.name)}</option>`).join('') +
      '<option value="Dispatch / Logistics">Dispatch / Logistics</option>';

    const sizes = [...MApp.Production.PROCESS_SIZE_LIST, 'General'];
    sizeSelect.innerHTML = '<option value="">Choose a Size…</option>' +
      sizes.map(s => `<option value="${MApp.Util.escapeHtml(s)}">${MApp.Util.escapeHtml(s)}</option>`).join('');
  },

  async openRateSheet(contractorName) {
    this._rateContractor = contractorName;
    const nameEl = document.getElementById('contractor-rate-name');
    if (nameEl) nameEl.value = MApp.Util.formatNameCase(contractorName);
    ['contractor-rate-value', 'contractor-rate-remarks'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    await this._populateRateTypeAndSizeSelects();
    MApp.Sheet.open('sheet-contractor-rate');
  },

  closeRateSheet() {
    MApp.Sheet.close('sheet-contractor-rate');
  },

  async saveRate() {
    const processType = (document.getElementById('contractor-rate-process-type')?.value || '').trim();
    const size = (document.getElementById('contractor-rate-size')?.value || '').trim();
    const rate = MApp.Util.toNumber(document.getElementById('contractor-rate-value')?.value);
    if (!processType || !size) { MApp.Toast.error('Choose a Process Type and Size.'); return; }
    if (!rate || rate <= 0) { MApp.Toast.error('Enter a rate greater than zero.'); return; }

    const formData = {
      contractorName: this._rateContractor,
      processType,
      size,
      ratePerUnit: rate,
      remarks: (document.getElementById('contractor-rate-remarks')?.value || '').trim()
    };

    const saveBtn = document.getElementById('contractor-rate-save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    const res = await MApp.Util.mutateSimple('saveContractorRate', [formData], 'Rate saved.');
    if (res.success) this.closeRateSheet();
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Rate'; }
  },

  // ── Contractor Extra Charges (Layer 2, Phase 1 quick-add) ───────────
  openExtraChargeSheet(contractorName) {
    this._extraChargeContractor = contractorName;
    const nameEl = document.getElementById('contractor-extra-charge-name');
    if (nameEl) nameEl.value = MApp.Util.formatNameCase(contractorName);
    ['contractor-extra-charge-service-type', 'contractor-extra-charge-amount', 'contractor-extra-charge-remarks'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    MApp.Sheet.open('sheet-contractor-extra-charge');
  },

  closeExtraChargeSheet() {
    MApp.Sheet.close('sheet-contractor-extra-charge');
  },

  async saveExtraCharge() {
    const serviceType = (document.getElementById('contractor-extra-charge-service-type')?.value || '').trim();
    const chargeAmount = MApp.Util.toNumber(document.getElementById('contractor-extra-charge-amount')?.value);
    if (!serviceType) { MApp.Toast.error('Enter a service type.'); return; }
    if (!chargeAmount || chargeAmount <= 0) { MApp.Toast.error('Enter a charge amount greater than zero.'); return; }

    const formData = {
      contractorName: this._extraChargeContractor,
      serviceType,
      chargeAmount,
      remarks: (document.getElementById('contractor-extra-charge-remarks')?.value || '').trim()
    };

    const saveBtn = document.getElementById('contractor-extra-charge-save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    const res = await MApp.Util.mutateSimple('saveContractorServiceCharge', [formData], 'Extra charge saved.');
    if (res.success) this.closeExtraChargeSheet();
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Charge'; }
  },

  openPaymentSheet(contractorName) {
    this._paymentContractor = contractorName;
    const nameEl = document.getElementById('contractor-payment-name');
    if (nameEl) nameEl.value = MApp.Util.formatNameCase(contractorName);
    const dateEl = document.getElementById('contractor-payment-date');
    if (dateEl) dateEl.value = MApp.Util.todayInputValue();
    ['contractor-payment-amount', 'contractor-payment-mode', 'contractor-payment-remarks'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    MApp.Sheet.open('sheet-contractor-payment');
  },

  closePaymentSheet() {
    MApp.Sheet.close('sheet-contractor-payment');
  },

  async savePayment() {
    const amount = MApp.Util.toNumber(document.getElementById('contractor-payment-amount')?.value);
    if (!amount || amount <= 0) { MApp.Toast.error('Enter an amount greater than zero.'); return; }

    const formData = {
      contractorName: this._paymentContractor,
      date: document.getElementById('contractor-payment-date')?.value || MApp.Util.todayInputValue(),
      amount: amount,
      modeReference: (document.getElementById('contractor-payment-mode')?.value || '').trim(),
      remarks: (document.getElementById('contractor-payment-remarks')?.value || '').trim()
    };

    const saveBtn = document.getElementById('contractor-payment-save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    const res = await MApp.Util.mutateSimple('recordContractorPayment', [formData], 'Payment recorded.');
    if (res.success) this.closePaymentSheet();
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Record Payment'; }
  }
};

// ================================================================
// ADMIN — USERS & ROLES (Phase 4, minimal v1). Entry point is Jinja-
// gated (mobile_views.html's More tab, {% if current_user.is_admin %}),
// but every RPC here is independently enforced server-side regardless
// (roles=frozenset({"admin"}) in app/erp/rpc.py) -- that Jinja gate is
// UX only, same as desktop's own. Deliberately does NOT build the
// custom-role permissions-matrix editor (createCustomRole/updateCustomRole's
// tab x level grid) -- that stays a desktop-only screen per the hybrid-
// strategy plan; this sheet only ASSIGNS existing roles, never creates one.
// ================================================================
MApp.Admin = {
  users: [],
  filtered: [],
  searchTerm: '',
  customRoles: [],

  ROLE_LABELS: {
    pending_approval: 'Pending Approval',
    user: 'User',
    admin: 'Admin',
    super_admin: 'Super Admin'
  },

  async open() {
    const listEl = document.getElementById('admin-users-list');
    const searchInput = document.getElementById('admin-users-search');
    if (searchInput) searchInput.value = '';
    this.searchTerm = '';
    MApp.Util.renderSkeleton(listEl, 5);
    MApp.Sheet.open('sheet-admin-users');

    try {
      const [usersRes, rolesRes] = await Promise.all([
        MApp.Api.call('getUsersData'),
        MApp.Api.call('getCustomRoles').catch(() => null)
      ]);
      if (!usersRes || !usersRes.success) {
        MApp.Util.renderError(listEl, usersRes && usersRes.message, () => this.open());
        return;
      }
      this.users = usersRes.data || [];
      // Best-effort -- an admin (not super_admin) may not have custom
      // roles configured yet; a failure here shouldn't block the user list.
      this.customRoles = (rolesRes && rolesRes.success) ? (rolesRes.data || []) : [];
      this._applyFilters();
    } catch (err) {
      MApp.Util.renderError(listEl, err && err.message, () => this.open());
    }
  },

  close() {
    MApp.Sheet.close('sheet-admin-users');
  },

  onSearch(term) {
    this.searchTerm = String(term || '').trim().toLowerCase();
    this._applyFilters();
  },

  _applyFilters() {
    let list = this.users;
    if (this.searchTerm) {
      const term = this.searchTerm;
      list = list.filter(u => u.name.toLowerCase().includes(term) || u.email.toLowerCase().includes(term));
    }
    this.filtered = list;
    this.render();
  },

  _roleLabel(role) {
    if (this.ROLE_LABELS[role]) return this.ROLE_LABELS[role];
    const custom = this.customRoles.find(r => r.roleKey === role);
    return custom ? custom.roleName : role;
  },

  _roleChipClass(role) {
    if (role === 'admin' || role === 'super_admin') return 'mb-chip-inprogress';
    if (role === 'pending_approval') return 'mb-chip-pending';
    if (role === 'user') return 'mb-chip-completed';
    return '';
  },

  render() {
    const listEl = document.getElementById('admin-users-list');
    if (!listEl) return;

    if (this.filtered.length === 0) {
      MApp.Util.renderEmpty(listEl, {
        title: 'No users found',
        body: this.users.length === 0 ? 'No users yet.' : 'Try a different search term.'
      });
      return;
    }

    // Self-targeting actions (change own role / deactivate self) are
    // blocked server-side anyway (users_service.py's own guards), but
    // hiding them here avoids a guaranteed round-trip error for the one
    // row where they'd always fail.
    const myEmail = String((window.MOBILE_CURRENT_USER || {}).email || '').toLowerCase();

    listEl.innerHTML = this.filtered.slice(0, 200).map((u, i) => {
      const isSelf = u.email.toLowerCase() === myEmail;
      const actions = isSelf ? '<div class="mb-mt-2 mb-text-sm mb-text-steel">This is you</div>' : `
        <div class="mb-mt-2" style="display:flex; gap:var(--mb-sp-4);">
          <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" data-admin-action="role" data-admin-index="${i}">Change Role</button>
          <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;${u.active ? 'color:var(--mb-enamel-red);' : ''}" data-admin-action="${u.active ? 'deactivate' : 'reactivate'}" data-admin-index="${i}">${u.active ? 'Deactivate' : 'Reactivate'}</button>
        </div>`;
      return `
        <div class="mb-card">
          <div class="mb-card-row">
            <div>
              <div class="mb-card-title">${MApp.Util.escapeHtml(MApp.Util.formatNameCase(u.name))}</div>
              <div class="mb-card-sub">${MApp.Util.escapeHtml(u.email)}</div>
            </div>
            <span class="mb-chip ${this._roleChipClass(u.role)}">${MApp.Util.escapeHtml(this._roleLabel(u.role))}</span>
          </div>
          ${!u.active ? '<div class="mb-mt-2"><span class="mb-chip mb-chip-cancelled">Inactive</span></div>' : ''}
          ${actions}
        </div>`;
    }).join('');

    listEl.querySelectorAll('[data-admin-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const user = this.filtered[Number(btn.dataset.adminIndex)];
        if (!user) return;
        const action = btn.dataset.adminAction;
        if (action === 'role') this.changeRole(user);
        else if (action === 'deactivate') this.deactivate(user);
        else this.reactivate(user);
      });
    });
  },

  // Only a super_admin can hand out the Admin role itself (server-enforced
  // in updateUserRole too) -- omitted from the picker entirely for a
  // plain admin rather than offered-then-rejected.
  async changeRole(user) {
    const builtIn = ['pending_approval', 'user'];
    if ((window.MOBILE_CURRENT_USER || {}).role === 'super_admin') builtIn.push('admin');
    const items = builtIn.map(r => ({ value: r, label: this.ROLE_LABELS[r] }))
      .concat(this.customRoles.map(r => ({ value: r.roleKey, label: r.roleName })));

    const picked = await MApp.Picker.open({ title: `Role for ${MApp.Util.formatNameCase(user.name)}`, items, selectedValue: user.role });
    if (!picked) return;

    const res = await MApp.Util.mutateSimple('updateUserRole', [user.id, picked.value], `${MApp.Util.formatNameCase(user.name)} is now ${picked.label}.`);
    if (res.success) this.open();
  },

  async deactivate(user) {
    if (!MApp.Util.confirmDelete(`${MApp.Util.formatNameCase(user.name)}'s access`)) return;
    const res = await MApp.Util.mutateSimple('deactivateUser', [user.id], `${MApp.Util.formatNameCase(user.name)} deactivated.`);
    if (res.success) this.open();
  },

  async reactivate(user) {
    const res = await MApp.Util.mutateSimple('reactivateUser', [user.id], `${MApp.Util.formatNameCase(user.name)} reactivated.`);
    if (res.success) this.open();
  },

  // ── Create User ──────────────────────────────────────────────────────
  openCreateForm() {
    document.getElementById('admin-user-form-body').innerHTML = this._createFormHtml();
    MApp.Sheet.open('sheet-admin-user-form');
  },

  closeCreateForm() {
    MApp.Sheet.close('sheet-admin-user-form');
  },

  _createFormHtml() {
    const isSuperAdmin = (window.MOBILE_CURRENT_USER || {}).role === 'super_admin';
    return `
      <div class="mb-field">
        <label for="admin-user-name">Name</label>
        <input type="text" id="admin-user-name">
      </div>
      <div class="mb-field">
        <label for="admin-user-email">Email</label>
        <input type="email" id="admin-user-email" autocomplete="off">
      </div>
      <div class="mb-field">
        <label for="admin-user-password">Password</label>
        <input type="password" id="admin-user-password" autocomplete="new-password">
      </div>
      <div class="mb-field">
        <label for="admin-user-confirm">Confirm Password</label>
        <input type="password" id="admin-user-confirm" autocomplete="new-password">
      </div>
      <div class="mb-field">
        <label>Role</label>
        <select id="admin-user-role">
          <option value="user" selected>User</option>
          ${isSuperAdmin ? '<option value="admin">Admin</option>' : ''}
        </select>
      </div>
    `;
  },

  async createUser() {
    const name = (document.getElementById('admin-user-name')?.value || '').trim();
    const email = (document.getElementById('admin-user-email')?.value || '').trim();
    const password = document.getElementById('admin-user-password')?.value || '';
    const confirm = document.getElementById('admin-user-confirm')?.value || '';
    const role = document.getElementById('admin-user-role')?.value || 'user';

    if (!name || !email || !password || !confirm) {
      MApp.Toast.error('Fill in every field.');
      return;
    }
    if (password !== confirm) {
      MApp.Toast.error('Passwords do not match.');
      return;
    }

    const saveBtn = document.getElementById('admin-user-form-save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Creating…'; }

    const res = await MApp.Util.mutateSimple('createUser', [name, email, password, confirm, role], `${name} created.`);
    if (res.success) {
      this.closeCreateForm();
      this.open();
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Create User'; }
      return;
    }
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Create User'; }
  }
};

// ================================================================
// PROCESSES (Phase 5, More tab) — header fields + Common Components only.
// Color Sub-Groups/Primary Axis/Dispatch Differentiator/Linked Processes
// stay a desktop task (see mobile_views.html's sheet-process-form comment
// for why that's safe: they're all optional/derived server-side). Not
// admin-gated -- saveProcess/deleteProcess carry no roles= restriction
// server-side, matching desktop's own open access.
// ================================================================
MApp.Process = {
  processes: [],
  filtered: [],
  searchTerm: '',
  items: [],
  editingProcess: null,
  // Rows this screen doesn't have UI for (color sub-groups, POOL-sourced
  // Common rows) -- read on edit and resent completely untouched, since
  // saveProcess replaces the whole components[] array on every save, not
  // a diff. Never populated on create (nothing to preserve).
  preservedComponents: [],
  preservedColorLinks: [],
  lines: [],
  _formSeq: 0,

  async open() {
    const listEl = document.getElementById('process-list-list');
    const searchInput = document.getElementById('process-list-search');
    if (searchInput) searchInput.value = '';
    this.searchTerm = '';
    MApp.Util.renderSkeleton(listEl, 5);
    MApp.Sheet.open('sheet-process-list');

    try {
      const res = await MApp.Api.call('getProcessData');
      if (!res || !res.success) {
        MApp.Util.renderError(listEl, res && res.message, () => this.open());
        return;
      }
      this.processes = res.data || [];
      this._applyFilters();
    } catch (err) {
      MApp.Util.renderError(listEl, err && err.message, () => this.open());
    }
  },

  close() {
    MApp.Sheet.close('sheet-process-list');
  },

  onSearch(term) {
    this.searchTerm = String(term || '').trim().toLowerCase();
    this._applyFilters();
  },

  _applyFilters() {
    let list = this.processes;
    if (this.searchTerm) {
      const term = this.searchTerm;
      list = list.filter(p =>
        p.processName.toLowerCase().includes(term) ||
        (p.outputItemName || '').toLowerCase().includes(term));
    }
    this.filtered = list;
    this.render();
  },

  render() {
    const listEl = document.getElementById('process-list-list');
    if (!listEl) return;

    if (this.filtered.length === 0) {
      MApp.Util.renderEmpty(listEl, {
        title: 'No processes found',
        body: this.processes.length === 0 ? 'Tap + to add the first one.' : 'Try a different search term.'
      });
      return;
    }

    listEl.innerHTML = this.filtered.slice(0, 200).map((p, i) => `
      <div class="mb-card">
        <div class="mb-card-row">
          <div>
            <div class="mb-card-title">${MApp.Util.escapeHtml(p.processName)}</div>
            <div class="mb-card-sub">${MApp.Util.escapeHtml(p.outputItemName || '')}</div>
          </div>
          <div style="text-align:right;">
            <div class="mb-card-sub">Stage ${MApp.Util.escapeHtml(String(p.sequence))}</div>
            <div class="mb-card-sub">${MApp.Util.escapeHtml(p.lotPrefix || '')}</div>
          </div>
        </div>
        ${!p.active ? '<div class="mb-mt-2"><span class="mb-chip mb-chip-cancelled">Inactive</span></div>' : ''}
        <div class="mb-mt-2"><button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" data-process-index="${i}">Edit</button></div>
      </div>`).join('');

    listEl.querySelectorAll('[data-process-index]').forEach(btn => {
      btn.addEventListener('click', () => {
        const process = this.filtered[Number(btn.dataset.processIndex)];
        if (process) this.openForm(process);
      });
    });
  },

  async openForm(process) {
    const mySeq = ++this._formSeq;
    this.editingProcess = process || null;
    this.preservedComponents = [];
    this.preservedColorLinks = [];
    this.lines = [{ itemName: '', size: '', unit: '', qtyPerUnit: '', remarks: '' }];

    const titleEl = document.getElementById('process-form-title');
    if (titleEl) titleEl.textContent = process ? 'Edit Process' : 'Add Process';
    const deleteBtn = document.getElementById('process-form-delete-btn');
    if (deleteBtn) deleteBtn.classList.toggle('mb-hidden', !process);
    const saveBtn = document.getElementById('process-form-save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Save Process'; }

    document.getElementById('process-form-body').innerHTML = `
      <div class="mb-skel mb-skel-card" style="height:56px;"></div>
      <div class="mb-skel mb-skel-card" style="height:56px;"></div>`;
    MApp.Sheet.open('sheet-process-form');

    try {
      if (this.items.length === 0) {
        const itemsRes = await MApp.Api.call('getItemsData');
        if (mySeq !== this._formSeq) return;
        this.items = (itemsRes && itemsRes.success) ? (itemsRes.data || []) : [];
      }

      if (process) {
        const [compRes, linksRes] = await Promise.all([
          MApp.Api.call('getProcessComponentsData', process.processId),
          MApp.Api.call('getProcessColorLinksData', process.processId)
        ]);
        // A newer openForm() call superseded this one while we were
        // awaiting -- don't let this stale response repaint the form.
        if (mySeq !== this._formSeq) return;
        const allComponents = (compRes && compRes.success) ? (compRes.data || []) : [];
        const editable = allComponents.filter(c => this._isEditableRow(c));
        this.preservedComponents = allComponents.filter(c => !this._isEditableRow(c));
        this.lines = editable.length > 0
          ? editable.map(c => ({ ...c }))
          : [{ itemName: '', size: '', unit: '', qtyPerUnit: '', remarks: '' }];
        this.preservedColorLinks = (linksRes && linksRes.success) ? (linksRes.data || []) : [];
      }

      document.getElementById('process-form-body').innerHTML = this._formHtml(process);
    } catch (err) {
      if (mySeq !== this._formSeq) return;
      MApp.Toast.error('Could not load this process: ' + (err.message || ''));
      this.closeForm();
      return;
    } finally {
      if (mySeq === this._formSeq && saveBtn) saveBtn.disabled = false;
    }
  },

  // A COMMON, ITEM-sourced row is the only kind mobile's flat Common
  // Components list can safely represent -- a color sub-group row or a
  // POOL-sourced row (references another process's output, not an Items
  // Master entry) both need UI this screen doesn't build, so they're
  // preserved instead (see preservedComponents above).
  _isEditableRow(c) {
    return String(c.colorGroup || '').toUpperCase() === 'COMMON' && String(c.sourceType || '').toUpperCase() !== 'POOL';
  },

  closeForm() {
    MApp.Sheet.close('sheet-process-form');
  },

  _formHtml(process) {
    return `
      <div class="mb-field">
        <label for="process-form-name">Process Name</label>
        <input type="text" id="process-form-name" value="${MApp.Util.escapeHtml(process ? process.processName : '')}">
      </div>
      <div class="mb-field">
        <label for="process-form-sequence">Sequence</label>
        <input type="number" id="process-form-sequence" min="1" step="1" value="${process ? process.sequence : ''}">
      </div>
      <div class="mb-field">
        <label for="process-form-prefix">Lot Prefix</label>
        <input type="text" id="process-form-prefix" maxlength="6" style="text-transform:uppercase;" value="${MApp.Util.escapeHtml(process ? process.lotPrefix : '')}">
        <div class="mb-field-hint">1-6 letters/numbers, must be unique across every process.</div>
      </div>
      <div class="mb-field">
        <label for="process-form-output">Output Item Name</label>
        <input type="text" id="process-form-output" value="${MApp.Util.escapeHtml(process ? process.outputItemName : '')}">
      </div>
      <div class="mb-field">
        <label for="process-form-type">Process Type (optional)</label>
        <input type="text" id="process-form-type" value="${MApp.Util.escapeHtml(process ? (process.processType || '') : '')}">
      </div>
      <div class="mb-field">
        <label class="mb-flex-row" style="cursor:pointer;">
          <input type="checkbox" id="process-form-final" ${process && process.isFinalStage ? 'checked' : ''} style="width:20px;height:20px;">
          <span>Final stage (produces a dispatchable product)</span>
        </label>
      </div>
      <div class="mb-field">
        <label class="mb-flex-row" style="cursor:pointer;">
          <input type="checkbox" id="process-form-active" ${!process || process.active ? 'checked' : ''} style="width:20px;height:20px;">
          <span>Active</span>
        </label>
      </div>
      <div class="mb-field">
        <label for="process-form-remarks">Remarks (optional)</label>
        <textarea id="process-form-remarks" rows="2">${MApp.Util.escapeHtml(process ? (process.remarks || '') : '')}</textarea>
      </div>

      <div class="mapp-section-label">Common Components</div>
      ${process && this.preservedComponents.length > 0 ? `<div class="mb-field-hint mb-mb-2">This process also has ${this.preservedComponents.length} color-specific/pooled component row(s) not shown here — edit those on desktop.</div>` : ''}
      <div id="process-form-lines">${this._linesHtml()}</div>
      <button type="button" class="mb-btn mb-btn-secondary mb-mt-2 mb-mb-4" onclick="MApp.Process.addLine()">+ Add Component</button>
    `;
  },

  _linesHtml() {
    if (this.lines.length === 0) return '<div class="mb-text-sm mb-text-steel mb-mb-2">No components added yet.</div>';
    return this.lines.map((line, i) => `
      <div class="mb-card" style="padding:var(--mb-sp-3);">
        <div class="mb-field" style="margin-bottom:var(--mb-sp-2);">
          <label>Item</label>
          <button type="button" class="mb-picker-field${line.itemName ? '' : ' mb-placeholder'}" onclick="MApp.Process.pickLineItem(${i})">${line.itemName ? MApp.Util.escapeHtml(line.itemName) + (line.size ? ` (${MApp.Util.escapeHtml(line.size)})` : '') : 'Choose an item...'}</button>
        </div>
        <div class="mb-field" style="margin-bottom:var(--mb-sp-2);">
          <label>Qty per unit</label>
          <input type="number" inputmode="decimal" min="0" step="any" value="${line.qtyPerUnit || ''}" oninput="MApp.Process.updateLine(${i}, 'qtyPerUnit', this.value)">
        </div>
        <div class="mb-field" style="margin-bottom:0;">
          <label>Remarks (optional)</label>
          <input type="text" value="${MApp.Util.escapeHtml(line.remarks || '')}" oninput="MApp.Process.updateLineText(${i}, 'remarks', this.value)">
        </div>
        ${this.lines.length > 1 ? `<button type="button" class="mb-btn-text mb-mt-2" style="padding:0;min-height:auto;color:var(--mb-enamel-red);" onclick="MApp.Process.removeLine(${i})">Remove</button>` : ''}
      </div>
    `).join('');
  },

  addLine() {
    this.lines.push({ itemName: '', size: '', unit: '', qtyPerUnit: '', remarks: '' });
    const el = document.getElementById('process-form-lines');
    if (el) el.innerHTML = this._linesHtml();
  },

  removeLine(i) {
    this.lines.splice(i, 1);
    if (this.lines.length === 0) this.lines.push({ itemName: '', size: '', unit: '', qtyPerUnit: '', remarks: '' });
    const el = document.getElementById('process-form-lines');
    if (el) el.innerHTML = this._linesHtml();
  },

  updateLine(i, key, value) {
    if (!this.lines[i]) return;
    this.lines[i][key] = MApp.Util.toNumber(value);
  },

  updateLineText(i, key, value) {
    if (!this.lines[i]) return;
    this.lines[i][key] = value;
  },

  async pickLineItem(i) {
    if (!this.lines[i]) return;
    const items = (this.items || []).map(it => ({
      value: it.name + '||' + it.size, label: it.name, sublabel: it.size ? `Size: ${it.size}` : ''
    }));
    const picked = await MApp.Picker.open({
      title: 'Choose an item', items, selectedValue: this.lines[i].itemName + '||' + this.lines[i].size
    });
    if (!picked || !this.lines[i]) return;
    const match = (this.items || []).find(it => (it.name + '||' + it.size) === picked.value);
    this.lines[i].itemName = match ? match.name : picked.label;
    this.lines[i].size = match ? match.size : '';
    this.lines[i].unit = match ? match.baseUnit : '';

    const el = document.getElementById('process-form-lines');
    if (el) el.innerHTML = this._linesHtml();
  },

  async save() {
    const name = (document.getElementById('process-form-name')?.value || '').trim();
    const prefix = (document.getElementById('process-form-prefix')?.value || '').trim().toUpperCase();
    const output = (document.getElementById('process-form-output')?.value || '').trim();
    const sequence = MApp.Util.toNumber(document.getElementById('process-form-sequence')?.value);
    if (!name) { MApp.Toast.error('Enter a process name.'); return; }
    if (!prefix) { MApp.Toast.error('Enter a lot prefix.'); return; }
    if (!output) { MApp.Toast.error('Enter an output item name.'); return; }
    if (!sequence || sequence <= 0) { MApp.Toast.error('Enter a sequence greater than zero.'); return; }

    const editableRows = this.lines.filter(l => l.itemName).map(l => ({
      itemName: l.itemName, size: l.size || '', narration: '', qtyPerUnit: l.qtyPerUnit || 1,
      unit: l.unit || '', remarks: l.remarks || '', sourceType: 'ITEM', colorGroup: 'COMMON', colorAxis: ''
    }));
    const components = editableRows.concat(this.preservedComponents.map(c => ({
      itemName: c.itemName, size: c.size, narration: c.narration, qtyPerUnit: c.qtyPerUnit,
      unit: c.unit, remarks: c.remarks, sourceType: c.sourceType, colorGroup: c.colorGroup, colorAxis: c.colorAxis
    })));

    const formData = {
      processName: name,
      lotPrefix: prefix,
      outputItemName: output,
      sequence,
      processType: (document.getElementById('process-form-type')?.value || '').trim(),
      isFinalStage: !!document.getElementById('process-form-final')?.checked,
      active: !!document.getElementById('process-form-active')?.checked,
      remarks: (document.getElementById('process-form-remarks')?.value || '').trim(),
      components: JSON.stringify(components)
    };
    const isEdit = !!this.editingProcess;
    if (isEdit) {
      formData.processId = this.editingProcess.processId;
      // Preserved verbatim -- mobile never edits Linked Processes, but
      // omitting this field entirely would wipe them (saveProcess treats
      // a missing colorLinks key the same as an explicit empty array).
      formData.colorLinks = JSON.stringify(this.preservedColorLinks.map(l => ({
        otherProcessId: l.otherProcessId, myColor: l.myColor, theirColor: l.theirColor,
        myAxisKey: l.myAxisKey, theirAxisKey: l.theirAxisKey
      })));
    }

    const saveBtn = document.getElementById('process-form-save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

    const res = await MApp.Util.mutateSimple('saveProcess', [formData], isEdit ? 'Process updated.' : 'Process saved.');
    if (res.success) {
      this.closeForm();
      this.open();
      return;
    }
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Process'; }
  },

  async deleteProcess() {
    if (!this.editingProcess) return;
    if (!MApp.Util.confirmDelete(this.editingProcess.processName)) return;
    const res = await MApp.Util.mutateSimple('deleteProcess', [this.editingProcess.processId], 'Process deleted.');
    if (res.success) {
      this.closeForm();
      this.open();
    }
  }
};

// ================================================================
// BOM / PRODUCT RECIPES (Phase 5, More tab) — password-gated exactly like
// desktop: verifyBOMAccess mints a session token (erp.bom_access_tokens,
// 6h TTL) that every BOM read/write requires. Cached in a module-level
// variable for the rest of this page load, mirroring desktop's
// sessionStorage persist-for-session behavior (a PWA relaunch re-prompts,
// same as a fresh browser tab does on desktop). save()/deleteBom() bypass
// the shared MApp.Util.mutateSimple helper (unlike every other Phase 1-4
// write) because they need one extra branch mutateSimple doesn't support:
// detecting an expired/invalid token from the response and re-prompting
// instead of just toasting a generic error.
// ================================================================
MApp.BOM = {
  token: null,
  products: [],
  filtered: [],
  searchTerm: '',
  items: [],
  editingProduct: null,
  components: [],
  costs: [],

  async open() {
    if (!this.token) {
      const errEl = document.getElementById('bom-unlock-error');
      if (errEl) errEl.textContent = '';
      const pwEl = document.getElementById('bom-unlock-password');
      if (pwEl) pwEl.value = '';
      MApp.Sheet.open('sheet-bom-unlock');
      return;
    }
    await this._loadList();
  },

  closeUnlock() {
    MApp.Sheet.close('sheet-bom-unlock');
  },

  async unlock() {
    const password = document.getElementById('bom-unlock-password')?.value || '';
    const errEl = document.getElementById('bom-unlock-error');
    if (errEl) errEl.textContent = '';
    if (!password) {
      if (errEl) errEl.textContent = 'Enter the password.';
      return;
    }
    const btn = document.getElementById('bom-unlock-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }

    try {
      const res = await MApp.Api.call('verifyBOMAccess', password);
      if (!res || !res.success) {
        if (errEl) errEl.textContent = (res && res.message) || 'Incorrect password.';
        return;
      }
      this.token = res.data && res.data.token;
      MApp.Sheet.close('sheet-bom-unlock');
      await this._loadList();
    } catch (err) {
      if (errEl) errEl.textContent = err.message || 'Could not reach the server.';
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Unlock'; }
    }
  },

  async _loadList() {
    const listEl = document.getElementById('bom-list-list');
    const searchInput = document.getElementById('bom-list-search');
    if (searchInput) searchInput.value = '';
    this.searchTerm = '';
    MApp.Util.renderSkeleton(listEl, 4);
    MApp.Sheet.open('sheet-bom-list');

    try {
      const res = await MApp.Api.call('getBOMData', this.token);
      if (!res || !res.success) {
        if (this._isAccessError(res)) { this._resetToken(); return; }
        MApp.Util.renderError(listEl, res && res.message, () => this._loadList());
        return;
      }
      this.products = res.data || [];
      this._applyFilters();
    } catch (err) {
      MApp.Util.renderError(listEl, err && err.message, () => this._loadList());
    }
  },

  _isAccessError(res) {
    return !!(res && res.message && /password-protected/i.test(res.message));
  },

  _resetToken() {
    this.token = null;
    MApp.Sheet.close('sheet-bom-list');
    MApp.Toast.error('Your BOM session expired — enter the password again.');
    this.open();
  },

  close() {
    MApp.Sheet.close('sheet-bom-list');
  },

  onSearch(term) {
    this.searchTerm = String(term || '').trim().toLowerCase();
    this._applyFilters();
  },

  _applyFilters() {
    let list = this.products;
    if (this.searchTerm) {
      const term = this.searchTerm;
      list = list.filter(p => p.productName.toLowerCase().includes(term));
    }
    this.filtered = list;
    this.render();
  },

  render() {
    const listEl = document.getElementById('bom-list-list');
    if (!listEl) return;

    if (this.filtered.length === 0) {
      MApp.Util.renderEmpty(listEl, {
        title: 'No recipes found',
        body: this.products.length === 0 ? 'Tap + to add the first one.' : 'Try a different search term.'
      });
      return;
    }

    listEl.innerHTML = this.filtered.slice(0, 200).map((p, i) => `
      <div class="mb-card">
        <div class="mb-card-row">
          <div>
            <div class="mb-card-title">${MApp.Util.escapeHtml(p.productName)}</div>
            <div class="mb-card-sub">${(p.components || []).length} component(s)</div>
          </div>
          <div style="text-align:right;">
            <div class="mb-card-number">${MApp.Util.formatCurrency((p.totalCost || 0) + (p.totalAdditionalCost || 0))}</div>
            <div class="mb-card-sub">Total cost</div>
          </div>
        </div>
        <div class="mb-mt-2"><button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" data-bom-index="${i}">Edit</button></div>
      </div>`).join('');

    listEl.querySelectorAll('[data-bom-index]').forEach(btn => {
      btn.addEventListener('click', () => {
        const product = this.filtered[Number(btn.dataset.bomIndex)];
        if (product) this.openForm(product);
      });
    });
  },

  async openForm(product) {
    this.editingProduct = product || null;
    this.components = product
      ? (product.components || []).map(c => ({ ...c }))
      : [{ itemName: '', size: '', narration: '', color: '', vendor: '', rate: '', qtyPerProduct: '', processId: '' }];
    this.costs = product ? (product.additionalCosts || []).map(c => ({ ...c })) : [];

    const titleEl = document.getElementById('bom-form-title');
    if (titleEl) titleEl.textContent = product ? 'Edit Recipe' : 'Add Recipe';
    const deleteBtn = document.getElementById('bom-form-delete-btn');
    if (deleteBtn) deleteBtn.classList.toggle('mb-hidden', !product);
    const saveBtn = document.getElementById('bom-form-save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Save Recipe'; }

    document.getElementById('bom-form-body').innerHTML = `
      <div class="mb-skel mb-skel-card" style="height:56px;"></div>
      <div class="mb-skel mb-skel-card" style="height:56px;"></div>`;
    MApp.Sheet.open('sheet-bom-form');

    try {
      if (this.items.length === 0) {
        const itemsRes = await MApp.Api.call('getItemsData');
        this.items = (itemsRes && itemsRes.success) ? (itemsRes.data || []) : [];
      }
      document.getElementById('bom-form-body').innerHTML = this._formHtml(product);
    } catch (err) {
      MApp.Toast.error('Could not load reference data: ' + (err.message || ''));
      this.closeForm();
      return;
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  },

  closeForm() {
    MApp.Sheet.close('sheet-bom-form');
  },

  _formHtml(product) {
    return `
      <div class="mb-field">
        <label for="bom-form-name">Product Name</label>
        <input type="text" id="bom-form-name" value="${MApp.Util.escapeHtml(product ? product.productName : '')}">
      </div>
      <div class="mb-field">
        <label for="bom-form-remarks">Remarks (optional)</label>
        <textarea id="bom-form-remarks" rows="2">${MApp.Util.escapeHtml(product ? (product.remarks || '') : '')}</textarea>
      </div>

      <div class="mapp-section-label">Components</div>
      <div id="bom-form-components">${this._componentsHtml()}</div>
      <button type="button" class="mb-btn mb-btn-secondary mb-mt-2 mb-mb-4" onclick="MApp.BOM.addComponent()">+ Add Component</button>

      <div class="mapp-section-label">Additional Costs (optional)</div>
      <div id="bom-form-costs">${this._costsHtml()}</div>
      <button type="button" class="mb-btn mb-btn-secondary mb-mt-2 mb-mb-4" onclick="MApp.BOM.addCost()">+ Add Cost</button>
    `;
  },

  // ── Components ────────────────────────────────────────────────────
  _componentsHtml() {
    if (this.components.length === 0) return '<div class="mb-text-sm mb-text-steel mb-mb-2">No components added yet.</div>';
    return this.components.map((c, i) => `
      <div class="mb-card" style="padding:var(--mb-sp-3);">
        <div class="mb-field" style="margin-bottom:var(--mb-sp-2);">
          <label>Item</label>
          <button type="button" class="mb-picker-field${c.itemName ? '' : ' mb-placeholder'}" onclick="MApp.BOM.pickComponentItem(${i})">${c.itemName ? MApp.Util.escapeHtml(c.itemName) + (c.size ? ` (${MApp.Util.escapeHtml(c.size)})` : '') : 'Choose an item...'}</button>
        </div>
        <div class="mb-field" style="margin-bottom:var(--mb-sp-2);">
          <label>Quantity per Product</label>
          <input type="number" inputmode="decimal" min="0" step="any" value="${c.qtyPerProduct || ''}" oninput="MApp.BOM.updateComponent(${i}, 'qtyPerProduct', this.value)">
        </div>
        <div class="mb-field" style="margin-bottom:var(--mb-sp-2);">
          <label>Vendor (optional)</label>
          <input type="text" value="${MApp.Util.escapeHtml(c.vendor || '')}" oninput="MApp.BOM.updateComponentText(${i}, 'vendor', this.value)">
        </div>
        <div class="mb-field" style="margin-bottom:var(--mb-sp-2);">
          <label>Rate (optional)</label>
          <input type="number" inputmode="decimal" min="0" step="0.01" value="${c.rate || ''}" oninput="MApp.BOM.updateComponent(${i}, 'rate', this.value)">
        </div>
        <div class="mb-field" style="margin-bottom:0;">
          <label>Color (optional)</label>
          <input type="text" value="${MApp.Util.escapeHtml(c.color || '')}" oninput="MApp.BOM.updateComponentText(${i}, 'color', this.value)">
        </div>
        ${this.components.length > 1 ? `<button type="button" class="mb-btn-text mb-mt-2" style="padding:0;min-height:auto;color:var(--mb-enamel-red);" onclick="MApp.BOM.removeComponent(${i})">Remove</button>` : ''}
      </div>
    `).join('');
  },

  addComponent() {
    this.components.push({ itemName: '', size: '', narration: '', color: '', vendor: '', rate: '', qtyPerProduct: '', processId: '' });
    const el = document.getElementById('bom-form-components');
    if (el) el.innerHTML = this._componentsHtml();
  },

  removeComponent(i) {
    this.components.splice(i, 1);
    if (this.components.length === 0) this.components.push({ itemName: '', size: '', narration: '', color: '', vendor: '', rate: '', qtyPerProduct: '', processId: '' });
    const el = document.getElementById('bom-form-components');
    if (el) el.innerHTML = this._componentsHtml();
  },

  updateComponent(i, key, value) {
    if (!this.components[i]) return;
    this.components[i][key] = MApp.Util.toNumber(value);
  },

  updateComponentText(i, key, value) {
    if (!this.components[i]) return;
    this.components[i][key] = value;
  },

  async pickComponentItem(i) {
    if (!this.components[i]) return;
    const items = (this.items || []).map(it => ({
      value: it.name + '||' + it.size, label: it.name, sublabel: it.size ? `Size: ${it.size}` : ''
    }));
    const picked = await MApp.Picker.open({
      title: 'Choose an item', items, selectedValue: this.components[i].itemName + '||' + this.components[i].size
    });
    if (!picked || !this.components[i]) return;
    const match = (this.items || []).find(it => (it.name + '||' + it.size) === picked.value);
    this.components[i].itemName = match ? match.name : picked.label;
    this.components[i].size = match ? match.size : '';

    const el = document.getElementById('bom-form-components');
    if (el) el.innerHTML = this._componentsHtml();
  },

  // ── Additional Costs ─────────────────────────────────────────────────
  _costsHtml() {
    if (this.costs.length === 0) return '<div class="mb-text-sm mb-text-steel mb-mb-2">No additional costs added.</div>';
    return this.costs.map((c, i) => `
      <div class="mb-card" style="padding:var(--mb-sp-3);">
        <div class="mb-field" style="margin-bottom:var(--mb-sp-2);">
          <label>Description</label>
          <input type="text" value="${MApp.Util.escapeHtml(c.description || '')}" oninput="MApp.BOM.updateCostText(${i}, 'description', this.value)">
        </div>
        <div class="mb-field" style="margin-bottom:var(--mb-sp-2);">
          <label>Rate</label>
          <input type="number" inputmode="decimal" min="0" step="0.01" value="${c.rate || ''}" oninput="MApp.BOM.updateCost(${i}, 'rate', this.value)">
        </div>
        <div class="mb-field" style="margin-bottom:var(--mb-sp-2);">
          <label>Process (optional)</label>
          <input type="text" value="${MApp.Util.escapeHtml(c.processName || '')}" oninput="MApp.BOM.updateCostText(${i}, 'processName', this.value)">
        </div>
        <div class="mb-field" style="margin-bottom:0;">
          <label>Contractor (optional)</label>
          <input type="text" value="${MApp.Util.escapeHtml(c.contractorName || '')}" oninput="MApp.BOM.updateCostText(${i}, 'contractorName', this.value)">
        </div>
        <button type="button" class="mb-btn-text mb-mt-2" style="padding:0;min-height:auto;color:var(--mb-enamel-red);" onclick="MApp.BOM.removeCost(${i})">Remove</button>
      </div>
    `).join('');
  },

  addCost() {
    this.costs.push({ description: '', rate: '', processName: '', contractorName: '' });
    const el = document.getElementById('bom-form-costs');
    if (el) el.innerHTML = this._costsHtml();
  },

  removeCost(i) {
    this.costs.splice(i, 1);
    const el = document.getElementById('bom-form-costs');
    if (el) el.innerHTML = this._costsHtml();
  },

  updateCost(i, key, value) {
    if (!this.costs[i]) return;
    this.costs[i][key] = MApp.Util.toNumber(value);
  },

  updateCostText(i, key, value) {
    if (!this.costs[i]) return;
    this.costs[i][key] = value;
  },

  async save() {
    const name = (document.getElementById('bom-form-name')?.value || '').trim();
    if (!name) { MApp.Toast.error('Enter a product name.'); return; }
    const validComponents = this.components.filter(c => c.itemName);
    if (validComponents.length === 0) {
      MApp.Toast.error('Add at least one component.');
      return;
    }
    const zeroQtyComponent = validComponents.find(c => !(MApp.Util.toNumber(c.qtyPerProduct) > 0));
    if (zeroQtyComponent) {
      MApp.Toast.error(`Enter a quantity per product for ${zeroQtyComponent.itemName}.`);
      return;
    }

    const formData = {
      productName: name,
      remarks: (document.getElementById('bom-form-remarks')?.value || '').trim(),
      components: JSON.stringify(validComponents.map(c => ({
        itemName: c.itemName, size: c.size || '', narration: c.narration || '', rate: c.rate || 0,
        vendor: c.vendor || '', qtyPerProduct: c.qtyPerProduct || 0, processId: c.processId || '', color: c.color || ''
      }))),
      additionalCosts: JSON.stringify(this.costs.filter(c => c.description).map(c => ({
        description: c.description, rate: c.rate || 0, processName: c.processName || '', contractorName: c.contractorName || ''
      })))
    };
    const isEdit = !!this.editingProduct;
    if (isEdit) formData.productId = this.editingProduct.productId;

    const saveBtn = document.getElementById('bom-form-save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

    try {
      const res = await Api.mutateWithId('saveBOM', Api.newMutationId(), formData, this.token);
      if (!res || !res.success) {
        if (this._isAccessError(res)) { this.closeForm(); this._resetToken(); return; }
        MApp.Toast.error((res && res.message) || 'Could not save this recipe.');
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Recipe'; }
        return;
      }
      MApp.Toast.success(isEdit ? 'Recipe updated.' : 'Recipe saved.');
      this.closeForm();
      this._loadList();
    } catch (err) {
      MApp.Toast.error(err.message || 'Could not reach the server.');
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Recipe'; }
    }
  },

  async deleteBom() {
    if (!this.editingProduct) return;
    if (!MApp.Util.confirmDelete(this.editingProduct.productName)) return;

    try {
      const res = await Api.mutateWithId('deleteBOM', Api.newMutationId(), this.editingProduct.productId, this.token);
      if (!res || !res.success) {
        if (this._isAccessError(res)) { this.closeForm(); this._resetToken(); return; }
        MApp.Toast.error((res && res.message) || 'Could not delete this recipe.');
        return;
      }
      MApp.Toast.success('Recipe deleted.');
      this.closeForm();
      this._loadList();
    } catch (err) {
      MApp.Toast.error(err.message || 'Could not reach the server.');
    }
  }
};

// ================================================================
// SYNC ISSUES (More tab, Phase 6) -- every offline-queued mutation,
// pending or failed, in one place, with per-item Retry/Discard. The
// count banners on each individual screen (Round 2's
// pendingSyncBannerHtml) tell you SOMETHING is queued; this is where
// you go to actually see what, and do something about a stuck one.
// ================================================================
MApp.SyncIssues = {
  entries: [],

  // Human-readable labels for the 5 queueable RPC methods -- the outbox
  // itself only knows raw method names.
  METHOD_LABELS: {
    adjustStockManually: 'Stock Adjustment',
    saveProduction: 'Log Lot',
    saveDispatch: 'New Dispatch',
    saveReturn: 'Log Return',
    savePO: 'New PO'
  },

  async open() {
    const listEl = document.getElementById('sync-issues-list');
    MApp.Util.renderSkeleton(listEl, 3);
    MApp.Sheet.open('sheet-sync-issues');
    await this.load();
  },

  close() {
    MApp.Sheet.close('sheet-sync-issues');
  },

  async load() {
    this.entries = await OfflineCache.outbox.listAll();
    this.render();
  },

  render() {
    const listEl = document.getElementById('sync-issues-list');
    if (!listEl) return;

    if (this.entries.length === 0) {
      MApp.Util.renderEmpty(listEl, { title: 'All synced', body: 'Nothing is waiting to sync.' });
      return;
    }

    listEl.innerHTML = this.entries.map(entry => {
      const label = this.METHOD_LABELS[entry.method] || entry.method;
      const isFailed = entry.status === 'failed';
      return `
        <div class="mb-card">
          <div class="mb-card-row">
            <div>
              <div class="mb-card-title">${MApp.Util.escapeHtml(label)}</div>
              <div class="mb-card-sub">Queued ${MApp.Util.relativeTime(entry.queuedAt)}</div>
            </div>
            <span class="mb-chip ${isFailed ? 'mb-chip-cancelled' : 'mb-chip-pending'}">${isFailed ? 'Failed' : 'Waiting'}</span>
          </div>
          ${isFailed && entry.lastError ? `<div class="mb-card-sub mb-mt-2" style="color:var(--mb-enamel-red);">${MApp.Util.escapeHtml(entry.lastError)}</div>` : ''}
          <div class="mb-flex-row mb-mt-2" style="gap:var(--mb-sp-3);">
            ${isFailed ? `<button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" data-retry="${entry.id}">Retry</button>` : ''}
            <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;color:var(--mb-enamel-red);" data-discard="${entry.id}">Discard</button>
          </div>
        </div>`;
    }).join('');

    listEl.querySelectorAll('[data-retry]').forEach(btn => {
      btn.addEventListener('click', () => this.retry(parseInt(btn.dataset.retry, 10)));
    });
    listEl.querySelectorAll('[data-discard]').forEach(btn => {
      btn.addEventListener('click', () => this.discard(parseInt(btn.dataset.discard, 10)));
    });
  },

  async retry(id) {
    // A fresh mutation_id, not the original one -- see offline-cache.js's
    // outboxRetry() comment: the entry already got a definitive server
    // response once (that's why it's `failed`, not still `pending`), and
    // the server caches that response under its mutation_id forever, so
    // reusing it here would just replay the same stale rejection.
    await OfflineCache.outbox.retry(id, Api.newMutationId());
    await this.load();
    MApp.Outbox.updateBadge();
    MApp.Toast.success('Will retry now.');
    MApp.Outbox.flush(); // attempt immediately rather than waiting for the next online/boot trigger
    MApp.Outbox.requestSync(); // also arm Background Sync in case this immediate attempt fails too
  },

  // Native confirm() rather than building a custom confirm-sheet
  // component for this one destructive, infrequent action -- discarding
  // permanently loses the queued data, so SOME friction is appropriate.
  async discard(id) {
    if (!window.confirm('Discard this queued item? It will not be saved.')) return;
    await OfflineCache.outbox.discard(id);
    await this.load();
    MApp.Outbox.updateBadge();
    this.updateSummary();
    MApp.Toast.success('Discarded.');
  },

  async updateSummary() {
    const el = document.getElementById('sync-issues-summary');
    if (!el) return;
    const count = await OfflineCache.outbox.countPendingAndFailed();
    el.textContent = count > 0 ? `${count} item(s) need attention` : 'All synced';
  }
};

// ================================================================
// MORE — links out to Returns/Items lookup/desktop UI + About row
// ================================================================
MApp.More = {
  mount() {
    this._wireDesktopLink();
    this.loadAbout();
    MApp.Returns.mount();
    MApp.SyncIssues.updateSummary();
  },

  // Adaptation from source: Mobile_Index.html's own doGet() served both
  // shells from the SAME path, differentiated only by a `ui=mobile` query
  // param -- so source strips that param and reuses window.location.pathname
  // to link back to the desktop shell. This Flask app instead routes them
  // as two distinct paths (/erp vs /erp/mobile -- see app/erp/pages.py),
  // so window.location.pathname here would just point back at /erp/mobile
  // itself. Links directly to /erp instead.
  _wireDesktopLink() {
    const link = document.getElementById('more-desktop-link');
    if (!link) return;
    link.href = '/erp';
  },

  async loadAbout() {
    if (MApp.State.lastDashboard) {
      this._renderAbout(MApp.State.lastDashboard);
      return;
    }
    try {
      const res = await MApp.Api.call('getMobileDashboard');
      if (res && res.success) {
        MApp.State.lastDashboard = res.data;
        this._renderAbout(res.data);
      }
    } catch (err) {
      // Non-critical — the About row just keeps its default text.
    }
  },

  _renderAbout(data) {
    const el = document.getElementById('more-about-line');
    if (!el) return;
    const version = data.appVersion || '1.0.0';
    const email = data.userEmail || 'unknown user';
    // .textContent (not innerHTML) — no HTML-escaping needed or wanted here.
    el.textContent = `Maharaja Bikes ERP — Mobile v${version} — Signed in as ${email}`;
  }
};

// ================================================================
// BOOT
// ================================================================
document.addEventListener('DOMContentLoaded', () => {
  MApp.PullToRefresh.init();
  MApp.Shell.init();

  // Register the mobile shell's own service worker (Phase 5: PWA
  // installability). Scoped to /erp/mobile/sw.js, not /static/erp/
  // mobile-sw.js, so its default scope naturally covers /erp/mobile/*
  // -- see app/erp/pages.py's mobile_service_worker route for why.
  // Registration failures are non-fatal -- the app works identically
  // without it, just without install/offline-shell support.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/erp/mobile/sw.js', { scope: '/erp/mobile' })
      .catch(err => console.warn('[PWA] Mobile service worker registration failed:', err));
  }

  // Phase 6 Round 3 -- replay any outbox entries queued in a previous
  // session (app was closed/reloaded while offline), and again whenever
  // the browser regains connectivity.
  MApp.Outbox.flush();
  window.addEventListener('online', () => MApp.Outbox.flush());

  // Phase 6 Item 4 -- arms Background Sync so the outbox can also replay
  // while the app isn't open at all. Independent of whether the
  // register() call above resolved this load (navigator.serviceWorker.ready
  // covers both cases); purely additive on top of the flush() calls above.
  MApp.Outbox.initBackgroundSync();
});
