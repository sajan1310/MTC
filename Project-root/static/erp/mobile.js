'use strict';
// mobile.js -- MApp, ported from Apps_Script/Mobile_Script.html.
//
// Own MApp namespace, sharing nothing with desktop's App except the
// Api.call/Api.mutate wrapper (api.js, already shared with desktop) and
// the print.html templates (App.Print.trigger's desktop implementation
// isn't reused directly -- MApp.Print below is its own small port of the
// same trigger(containerId, documentTitle) contract, since the desktop
// App.Print also tracks a companyLogo
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
  error(message) { this.show(message, 'error'); },

  // A toast that waits for an answer instead of expiring. Used for the
  // "new version" prompt: an update the operator missed because it faded
  // after 2.6 seconds is an update that never happens. Returns a dismiss
  // function so the caller can take it down itself.
  action(message, label, onAct) {
    const stack = document.getElementById('mapp-toast-stack');
    if (!stack) return () => {};
    const el = document.createElement('div');
    el.className = 'mb-toast mb-toast-action';
    // The stack is pointer-events:none so toasts never block the list
    // underneath; this one has a button, so it opts back in.
    el.style.pointerEvents = 'auto';

    const text = document.createElement('span');
    text.textContent = message;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mb-toast-action-btn';
    btn.textContent = label;

    const dismiss = () => el.remove();
    btn.addEventListener('click', () => { dismiss(); if (onAct) onAct(); });
    el.appendChild(text);
    el.appendChild(btn);
    stack.appendChild(el);
    return dismiss;
  }
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
      <div class="mb-offline-banner" style="background:var(--mb-enamel-blue-bg);color:var(--mb-enamel-blue-ink);grid-column:1 / -1;">
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
// FORM — renders fields from a spec, and validates them where the
// operator can see it.
//
// Validation was 23 calls to MApp.Toast.error(): a message at the bottom
// of the screen, unattached to the field that caused it, gone in 4.2
// seconds, with no way to bring it back. On a long form the offending
// field is often scrolled out of view, and nothing scrolled to it. There
// was no aria-invalid anywhere in the app, so a screen-reader user had
// nothing to navigate by at all.
//
// A field spec is:
//   { key, label, type, required, hint, placeholder, validate }
// type drives the keyboard as well as the markup -- 'tel' is the reason
// entering a vendor's phone number stops raising a full QWERTY.
//
// Usage:
//   MApp.Form.render('entity-form-body', spec, record);
//   const values = MApp.Form.read(spec);          // trimmed
//   if (!MApp.Form.validate(spec, values)) return; // paints + focuses
// ================================================================
MApp.Form = {
  // [input type, inputmode, autocomplete] per field type. The mobile
  // keyboard is chosen here rather than at 20-odd call sites.
  TYPES: {
    text: ['text', null, null],
    tel: ['tel', 'tel', 'tel'],
    email: ['email', 'email', 'email'],
    decimal: ['number', 'decimal', null],
    integer: ['number', 'numeric', null],
    date: ['date', null, null],
    password: ['password', null, 'new-password'],
    multiline: [null, null, null]
  },

  _id(spec, field) {
    return `${spec.id}-${field.key}`;
  },

  render(bodyId, spec, record) {
    const body = document.getElementById(bodyId);
    if (!body) return;
    const values = record || {};
    body.innerHTML = spec.fields.map(f => this._fieldHtml(spec, f, values[f.key])).join('');
  },

  _fieldHtml(spec, field, value) {
    const id = this._id(spec, field);
    const [type, inputmode, autocomplete] = this.TYPES[field.type] || this.TYPES.text;
    const val = MApp.Util.escapeHtml(value == null ? '' : String(value));
    const label = MApp.Util.escapeHtml(field.label || field.key);
    // aria-describedby points at BOTH the hint and the error slot; the
    // error element is empty until validate() fills it, and an empty
    // referenced node contributes nothing to the announcement.
    const described = [field.hint ? `${id}-hint` : null, `${id}-error`].filter(Boolean).join(' ');
    const attrs = [
      `id="${id}"`,
      `aria-describedby="${described}"`,
      field.required ? 'aria-required="true"' : '',
      field.placeholder ? `placeholder="${MApp.Util.escapeHtml(field.placeholder)}"` : '',
      inputmode ? `inputmode="${inputmode}"` : '',
      autocomplete ? `autocomplete="${autocomplete}"` : 'autocomplete="off"',
      field.type === 'decimal' || field.type === 'integer' ? 'step="any"' : ''
    ].filter(Boolean).join(' ');

    const control = field.type === 'multiline'
      ? `<textarea ${attrs} rows="${field.rows || 2}">${val}</textarea>`
      : `<input type="${type}" ${attrs} value="${val}">`;

    return `
      <div class="mb-field" data-field="${MApp.Util.escapeHtml(field.key)}">
        <label for="${id}">${label}${field.required ? ' <span class="mb-field-req" aria-hidden="true">*</span>' : ''}</label>
        ${control}
        ${field.hint ? `<div class="mb-field-hint" id="${id}-hint">${MApp.Util.escapeHtml(field.hint)}</div>` : ''}
        <div class="mb-field-error" id="${id}-error" hidden></div>
      </div>`;
  },

  read(spec) {
    const out = {};
    spec.fields.forEach(f => {
      const el = document.getElementById(this._id(spec, f));
      if (!el) return;
      const raw = el.value == null ? '' : String(el.value);
      out[f.key] = f.type === 'decimal' || f.type === 'integer' ? raw.trim() : raw.trim();
    });
    return out;
  },

  // Returns true when the form is valid. When it is not, every offending
  // field is marked and the FIRST one is scrolled to and focused -- the
  // half of this that a toast could never do.
  validate(spec, values) {
    this.clearErrors(spec);
    const vals = values || this.read(spec);
    const failed = [];

    spec.fields.forEach(field => {
      const value = vals[field.key];
      let message = null;

      if (field.required && !value) {
        message = `${field.label || field.key} is required.`;
      } else if (value && (field.type === 'decimal' || field.type === 'integer')) {
        const n = Number(value);
        if (!isFinite(n)) message = `${field.label} must be a number.`;
        else if (field.type === 'integer' && !Number.isInteger(n)) message = `${field.label} must be a whole number.`;
        else if (field.min != null && n < field.min) message = `${field.label} must be at least ${field.min}.`;
      } else if (value && field.type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
        message = 'Enter a valid email address.';
      }

      if (!message && field.validate) message = field.validate(value, vals) || null;
      if (message) failed.push({ field, message });
    });

    failed.forEach(({ field, message }) => this.setError(spec, field.key, message));

    if (failed.length) {
      const first = document.getElementById(this._id(spec, failed[0].field));
      if (first) {
        // scrollIntoView before focus: focusing alone scrolls the field to
        // whichever edge it entered from, which on a phone often leaves it
        // under the sheet header.
        if (first.scrollIntoView) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
        first.focus({ preventScroll: true });
      }
      return false;
    }
    return true;
  },

  setError(spec, key, message) {
    const field = spec.fields.find(f => f.key === key);
    if (!field) return;
    const id = this._id(spec, field);
    const input = document.getElementById(id);
    const error = document.getElementById(`${id}-error`);
    if (input) input.setAttribute('aria-invalid', 'true');
    if (error) { error.textContent = message; error.hidden = false; }
    const wrap = input && input.closest('.mb-field');
    if (wrap) wrap.classList.add('mb-field-invalid');
  },

  clearErrors(spec) {
    spec.fields.forEach(f => {
      const id = this._id(spec, f);
      const input = document.getElementById(id);
      const error = document.getElementById(`${id}-error`);
      if (input) input.removeAttribute('aria-invalid');
      if (error) { error.textContent = ''; error.hidden = true; }
      const wrap = input && input.closest('.mb-field');
      if (wrap) wrap.classList.remove('mb-field-invalid');
    });
  }
};

// ================================================================
// UPDATE — offers a reload when a new version is ready, instead of
// swapping the app out from under whoever is using it.
//
// mobile-sw.js used to call skipWaiting() the moment it finished
// installing. A deploy while an operator had a half-filled Log Lot form
// open therefore replaced the cached assets underneath the running page:
// the page kept the old mobile.js in memory while the worker served new
// ones to every subsequent request, with nothing on screen to say so.
//
// Now the new worker waits. This offers the reload, and only sends
// skip-waiting when the operator accepts -- and it will not ask at all
// while a sheet is open, because a sheet is a half-entered record and a
// reload would discard it.
// ================================================================
MApp.Update = {
  RETRY_MS: 30000,
  _waiting: null,
  _dismiss: null,
  _reloading: false,

  watch(registration) {
    if (!registration) return;

    // Already waiting when this page loaded (installed during a previous
    // visit and never accepted).
    if (registration.waiting && navigator.serviceWorker.controller) {
      this._offer(registration.waiting);
    }

    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        // `controller` being present is what distinguishes an UPDATE from
        // this app's very first install -- on a first install there is
        // nothing to reload into and no interruption to warn about.
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          this._offer(installing);
        }
      });
    });
  },

  _offer(worker) {
    this._waiting = worker;
    // Never interrupt a half-entered record. Ask again once the sheet
    // stack is empty; the update keeps until then either way.
    if (MApp.Sheet._stack.length > 0) {
      setTimeout(() => { if (this._waiting) this._offer(this._waiting); }, this.RETRY_MS);
      return;
    }
    if (this._dismiss) return; // already asking

    this._dismiss = MApp.Toast.action(
      'A new version is ready.',
      'Reload',
      () => this.apply()
    );
  },

  apply() {
    this._dismiss = null;
    if (!this._waiting) return;
    this._waiting.postMessage({ type: 'skip-waiting' });
    this._waiting = null;
  },

  // The new worker taking control is the signal that the swap is done and
  // the page can safely reload into it. Guarded so the reload happens
  // once even if controllerchange fires more than once.
  initReloadOnActivate() {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (this._reloading) return;
      this._reloading = true;
      window.location.reload();
    });
  }
};

// ================================================================
// SEARCH — one keyword matcher for every list in the app.
//
// Replaces eleven hand-written onSearch() methods, each of which took the
// whole query as ONE substring and tested it against one to three
// hard-coded fields. That fails the query shape operators actually use: a
// bike is identified on the floor by size, model and colour, and those
// live in three different fields on every record here, so "26 kalpi red"
// matched nothing anywhere.
//
// The rule that fixes it is AND across tokens, OR across fields. Every
// whitespace-separated token must appear SOMEWHERE in the record; no
// single token has to be in any particular field.
//
// Usage, per module:
//   SEARCH: { fields: [{ key, weight, label, get }] }
//   this.entries  = MApp.Search.index(rows, this.SEARCH);   // once, on load
//   this.filtered = MApp.Search.run(this.entries, term);    // per query
// ================================================================
MApp.Search = {
  // ── Normalisation ──────────────────────────────────────────────────
  // NFKD + combining-mark strip so "Kalpí" and "Kalpi" are one token.
  // Punctuation becomes a SPACE rather than being deleted, so "PO-1042"
  // indexes as "po 1042" and is found by "1042", by "po 1042", and by
  // "po-1042" (which normalises to the same two tokens) alike.
  norm(value) {
    return String(value == null ? '' : value)
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  },

  tokens(query) {
    const normalised = this.norm(query);
    return normalised ? normalised.split(' ') : [];
  },

  // ── Query grammar ──────────────────────────────────────────────────
  // Parsed from the RAW query, before norm() strips the operators.
  //
  //   red kalpi        both tokens must appear, anywhere
  //   -kalpi           exclude rows containing it
  //   vendor:acme      match only within that field
  //   -vendor:acme     exclude rows whose vendor matches
  //   "26 inch"        the words, adjacent, in that order
  //
  // Before this, `-kalpi` normalised to `kalpi` and returned exactly the
  // rows the operator was trying to exclude, and `vendor:acme` became the
  // two tokens "vendor" and "acme" -- the first appearing nowhere, so the
  // whole query silently returned nothing. Both inverted or discarded
  // intent without saying so.
  parse(query, fields) {
    const out = { include: [], exclude: [], phrases: [], excludePhrases: [], scoped: [], unknownFields: [] };
    // Quoted runs stay whole; everything else splits on whitespace.
    const parts = String(query || '').match(/-?"[^"]*"|\S+/g) || [];

    for (let part of parts) {
      let negate = false;
      if (part.charAt(0) === '-' && part.length > 1) { negate = true; part = part.slice(1); }

      // "quoted phrase"
      if (part.charAt(0) === '"') {
        const phrase = this.norm(part.replace(/"/g, ''));
        if (phrase) (negate ? out.excludePhrases : out.phrases).push(phrase);
        continue;
      }

      // field:value -- the field name is matched against the spec's own
      // keys and labels, so both `vendor:` and `assignedto:` work.
      const scoped = part.match(/^([A-Za-z][A-Za-z0-9_]*):(.+)$/);
      if (scoped) {
        const key = this._resolveField(scoped[1], fields);
        const valueTokens = this.tokens(scoped[2]);
        if (key) {
          valueTokens.forEach(token => out.scoped.push({ key, token, negate }));
          continue;
        }
        // Unknown field: search the VALUE as ordinary text rather than
        // returning nothing, and record the name so the UI can say the
        // qualifier was ignored instead of leaving a silent empty list.
        out.unknownFields.push(scoped[1]);
        valueTokens.forEach(t => (negate ? out.exclude : out.include).push(t));
        continue;
      }

      this.tokens(part).forEach(t => (negate ? out.exclude : out.include).push(t));
    }
    return out;
  },

  _resolveField(name, fields) {
    const wanted = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const match = (fields || []).find(f =>
      String(f.key || '').toLowerCase().replace(/[^a-z0-9]/g, '') === wanted ||
      String(f.label || '').toLowerCase().replace(/[^a-z0-9]/g, '') === wanted);
    return match ? match.key : null;
  },

  // ── Indexing ───────────────────────────────────────────────────────
  _fieldText(row, field) {
    const raw = field.get ? field.get(row) : row[field.key];
    return this.norm(Array.isArray(raw) ? raw.join(' ') : raw);
  },

  // Precomputes each row's haystacks ONCE per data load. The old code
  // called .toLowerCase() on every field of every row on every keystroke.
  // _words is the de-duplicated word list, used only by the fuzzy pass.
  index(rows, spec) {
    const fields = (spec && spec.fields) || [];
    return (rows || []).map(row => {
      const fieldHays = fields.map(f => this._fieldText(row, f));
      const hay = fieldHays.join(' ');
      return { row, fields, _fieldHays: fieldHays, _hay: hay, _words: hay ? [...new Set(hay.split(' '))] : [] };
    });
  },

  // ── Token matching ─────────────────────────────────────────────────
  // Substring, EXCEPT for tokens of three characters or fewer, which must
  // sit at a word start. "rim" matching "trimming" is noise on a parts
  // list; requiring a word start kills it while still letting "kal" find
  // "kalpi" and "rim" find "Rim 26". Longer tokens keep plain substring
  // matching, because a document number like "1042" inside "lot1042" has
  // no word boundary to sit at and must stay findable.
  _hit(hay, token) {
    if (!hay) return false;
    if (token.length > 3) return hay.indexOf(token) !== -1;
    return hay === token || hay.startsWith(token + '') && hay.charAt(token.length) === ' '
      ? true
      : new RegExp('(^| )' + token).test(hay);
  },

  // ── Fuzzy fallback ─────────────────────────────────────────────────
  // Edit distance is allowed only in proportion to token length, and
  // never at all below four characters: "red" and "rod" are two colours,
  // and guessing between them on a shop floor is worse than finding
  // nothing. Three characters of slack on a long word is safe; one
  // character on a short one is not.
  _maxEdits(token) {
    if (token.length <= 3) return 0;
    if (token.length <= 6) return 1;
    return 2;
  },

  // Bounded Levenshtein: bails out as soon as the best possible result
  // exceeds `max`, so a non-match on a long word costs almost nothing.
  _editDistance(a, b, max) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const curr = [i];
      let best = i;
      for (let jj = 1; jj <= b.length; jj++) {
        const cost = a.charAt(i - 1) === b.charAt(jj - 1) ? 0 : 1;
        curr[jj] = Math.min(prev[jj] + 1, curr[jj - 1] + 1, prev[jj - 1] + cost);
        if (curr[jj] < best) best = curr[jj];
      }
      if (best > max) return max + 1;
      prev = curr;
    }
    return prev[b.length];
  },

  _fuzzyHit(entry, token) {
    const max = this._maxEdits(token);
    if (!max) return false;
    return entry._words.some(word => this._editDistance(token, word, max) <= max);
  },

  _tokenInEntry(entry, token, fuzzy) {
    if (this._hit(entry._hay, token)) return true;
    return fuzzy ? this._fuzzyHit(entry, token) : false;
  },

  _scopedHay(entry, key) {
    const i = entry.fields.findIndex(f => f.key === key);
    return i === -1 ? '' : entry._fieldHays[i];
  },

  // ── Matching + ranking ─────────────────────────────────────────────
  // Returns the matching rows, best first. An empty query returns
  // everything in its original order.
  //
  // Sorting is by score only, and Array.prototype.sort is stable, so rows
  // that score EQUALLY keep their original relative order: searching a
  // vendor name leaves that vendor's bills newest-first, while searching
  // a bill number floats the exact match to the top.
  run(entries, query) {
    const list = entries || [];
    const fields = (list[0] && list[0].fields) || [];
    const parsed = this.parse(query, fields);
    const hasPositive = parsed.include.length || parsed.phrases.length || parsed.scoped.length;
    const hasNegative = parsed.exclude.length || parsed.excludePhrases.length;

    if (!hasPositive && !hasNegative) return this._decorate(list.map(e => e.row), { query: '' });

    // Exact pass first. Fuzzy only ever runs as a FALLBACK, so an
    // approximate match can never displace, dilute or outrank a real one.
    let hits = this._collect(list, parsed, false);
    let fuzzy = false;
    if (!hits.length && hasPositive) {
      const candidates = this._collect(list, parsed, true);
      if (candidates.length) { hits = candidates; fuzzy = true; }
    }

    hits.sort((a, b) => b.score - a.score);
    return this._decorate(hits.map(h => {
      Object.defineProperty(h.entry.row, '_matchedOn', {
        value: h.matchedOn, configurable: true, enumerable: false, writable: true
      });
      return h.entry.row;
    }), { query: String(query || ''), fuzzy, unknownFields: parsed.unknownFields });
  },

  _collect(list, parsed, fuzzy) {
    const hits = [];
    for (const entry of list) {
      if (parsed.exclude.some(t => this._hit(entry._hay, t))) continue;
      if (parsed.excludePhrases.some(p => entry._hay.indexOf(p) !== -1)) continue;
      if (parsed.phrases.some(p => entry._hay.indexOf(p) === -1)) continue;

      let ok = true;
      for (const s of parsed.scoped) {
        const hay = this._scopedHay(entry, s.key);
        const found = this._hit(hay, s.token) ||
          (fuzzy && this._maxEdits(s.token) > 0 &&
            hay.split(' ').some(w => this._editDistance(s.token, w, this._maxEdits(s.token)) <= this._maxEdits(s.token)));
        if (s.negate ? found : !found) { ok = false; break; }
      }
      if (!ok) continue;

      for (const token of parsed.include) {
        if (!this._tokenInEntry(entry, token, fuzzy)) { ok = false; break; }
      }
      if (!ok) continue;

      hits.push(this._score(entry, parsed, fuzzy));
    }
    return hits;
  },

  _score(entry, parsed, fuzzy) {
    const wanted = parsed.include.concat(parsed.scoped.filter(s => !s.negate).map(s => s.token));
    let score = 0;
    const matchedOn = [];
    entry.fields.forEach((field, i) => {
      const hay = entry._fieldHays[i];
      if (!hay) return;
      for (const token of wanted) {
        if (!this._hit(hay, token)) continue;
        // A whole-word hit beats a mid-word one, and a field that STARTS
        // with the token beats both -- so an exact lot number outranks a
        // record that merely contains those digits somewhere.
        const wholeWord = new RegExp('(^| )' + token + '( |$)').test(hay);
        const startsWith = hay.startsWith(token);
        score += (field.weight || 1) * (startsWith ? 3 : wholeWord ? 2 : 1);
        if (field.label && matchedOn.indexOf(field.label) === -1) matchedOn.push(field.label);
      }
    });
    // Every fuzzy hit ranks below every exact one within the same result
    // set; the set is already all-fuzzy or all-exact, so this only keeps
    // scores honest for the caller.
    if (fuzzy) score = score / 2;
    return { entry, score, matchedOn };
  },

  // Diagnostics ride on the returned array, non-enumerably, so the 13
  // render call sites keep receiving a plain array of rows.
  _decorate(rows, meta) {
    Object.defineProperty(rows, '_meta', {
      value: { fuzzy: false, unknownFields: [], ...meta },
      configurable: true, enumerable: false, writable: true
    });
    return rows;
  }
};

// ================================================================
// PAGING — progressive reveal, replacing thirteen hard caps.
//
// Every list rendered `rows.slice(0, N)` with no way to see row N+1.
// Production and Dispatch cap at 50, so a lot logged three weeks ago was
// not merely hard to find, it was unreachable: no scroll, no page, no
// filter got to it. Phase 2 made the cap visible ("Showing 50 of 312");
// this makes it passable.
//
// Deliberately "show more" rather than infinite scroll: an operator on a
// factory floor with gloves scrolls past things, and an accidental fetch
// of 300 more rows on a low-end handset is a stall they cannot cancel.
// A tap is explicit, and it keeps the scroll position stable.
//
// Usage, inside a render() -- one call, plus one concatenation:
//   const page = MApp.Paging.take('production', rows, () => this.render());
//   listEl.innerHTML = page.rows.map(...).join('') + MApp.Paging.moreHtml(page);
// and MApp.Paging.reset('production') wherever the result set changes
// (a load, or a new query).
// ================================================================
MApp.Paging = {
  DEFAULT_SIZE: 50,
  _shown: {},
  _rerender: {},

  // Called on every data load and whenever the query changes, so a new
  // search starts from the first page rather than inheriting however far
  // the previous one had been expanded.
  reset(key, size) {
    this._shown[key] = size || this.DEFAULT_SIZE;
  },

  // take() also records how to re-render this list, so expanding a page
  // needs no per-screen click wiring -- one delegated listener (below)
  // serves all thirteen. Screens call exactly one Paging function.
  take(key, rows, onRender) {
    const all = rows || [];
    if (this._shown[key] == null) this.reset(key);
    if (typeof onRender === 'function') this._rerender[key] = onRender;
    const limit = this._shown[key];
    return {
      key,
      rows: all.slice(0, limit),
      total: all.length,
      shown: Math.min(limit, all.length),
      hasMore: all.length > limit,
      step: this.DEFAULT_SIZE,
      // Carried through from MApp.Search.run so the count line can say
      // when results are approximate. Undefined for lists that are not
      // search results.
      meta: all._meta
    };
  },

  // Appended to the list's own innerHTML string, so a render stays a
  // single assignment rather than an assignment plus DOM surgery.
  moreHtml(page) {
    if (!page || !page.hasMore) return '';
    const remaining = page.total - page.shown;
    const next = Math.min(remaining, page.step);
    return `
      <button type="button" class="mb-btn mb-btn-secondary mb-load-more" data-paging-key="${MApp.Util.escapeHtml(page.key)}">
        Show ${next} more <span class="mb-load-more-sub">(${remaining} not shown)</span>
      </button>`;
  },

  // One delegated listener for every list in the app. Bound at boot, so
  // it survives the innerHTML rebuilds that would drop a per-button
  // handler, and costs nothing per render.
  init() {
    document.addEventListener('click', e => {
      const btn = e.target.closest && e.target.closest('.mb-load-more');
      if (!btn) return;
      const key = btn.dataset.pagingKey;
      if (!key) return;
      this._shown[key] = (this._shown[key] || this.DEFAULT_SIZE) + this.DEFAULT_SIZE;
      const rerender = this._rerender[key];
      if (rerender) rerender();
    });
  }
};
MApp.Paging.init();

// ================================================================
// SEARCH BOX — the one search input, upgraded in place.
//
// Every .mb-search input was type="text" with an inline
// oninput="MApp.X.onSearch(this.value)". That meant: no native clear
// button (clearing a query was eleven backspaces with a gloved thumb), a
// keyboard whose return key said "return" rather than "Search", iOS
// capitalising the first letter of every query, and a full innerHTML
// rebuild plus event rebind on every keystroke -- MApp.Util.debounce()
// existed but was called from nowhere in the file.
//
// attach() owns all of that so no screen has to remember any of it.
// ================================================================
MApp.SearchBox = {
  DEBOUNCE_MS: 120,

  // Idempotent: sheets live permanently in the DOM and their open() runs
  // again on every visit, so attach() must be safe to call repeatedly.
  attach(inputId, onQuery) {
    const input = document.getElementById(inputId);
    if (!input) return null;

    const wrap = input.closest('.mb-search');
    const api = {
      input,
      value: () => input.value,
      reset: () => { input.value = ''; this._syncClear(input); this.setCount(inputId, null); },
      setCount: (shown, total) => this.setCount(inputId, shown, total)
    };

    if (input.dataset.mbSearchBound === '1') {
      // Re-attaching replaces the callback (the module object is the same,
      // but its closure may capture fresh state) without stacking listeners.
      this._handlers[inputId] = onQuery;
      return api;
    }
    input.dataset.mbSearchBound = '1';
    this._handlers[inputId] = onQuery;

    // type="search" gives the platform clear affordance where one exists;
    // enterkeyhint relabels the return key; autocapitalize/autocorrect stop
    // the OS "helping" with item codes and vendor names.
    input.setAttribute('type', 'search');
    input.setAttribute('enterkeyhint', 'search');
    input.setAttribute('autocapitalize', 'none');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('spellcheck', 'false');
    input.removeAttribute('oninput');
    input.oninput = null;

    if (wrap) {
      wrap.classList.add('mb-search-sticky');
      if (!wrap.querySelector('.mb-search-clear')) {
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'mb-search-clear';
        clear.setAttribute('aria-label', 'Clear search');
        clear.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
        clear.addEventListener('click', () => {
          input.value = '';
          this._syncClear(input);
          this._fire(inputId, '');   // immediate: clearing is not typing
          input.focus();
        });
        wrap.appendChild(clear);
      }
      if (!wrap.nextElementSibling || !wrap.nextElementSibling.classList.contains('mb-search-count')) {
        const count = document.createElement('div');
        count.className = 'mb-search-count';
        // The only way a screen-reader user learns the list changed under
        // a search that never moves focus.
        count.setAttribute('role', 'status');
        count.setAttribute('aria-live', 'polite');
        count.hidden = true;
        wrap.insertAdjacentElement('afterend', count);
      }
    }

    const debounced = MApp.Util.debounce(value => this._fire(inputId, value), this.DEBOUNCE_MS);
    input.addEventListener('input', () => {
      this._syncClear(input);
      debounced(input.value);
    });
    // Enter should apply what is typed now, not wait out the debounce.
    input.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      this._fire(inputId, input.value);
      input.blur(); // drops the keyboard so the results are visible
    });

    this._syncClear(input);
    return api;
  },

  _handlers: {},

  _fire(inputId, value) {
    const handler = this._handlers[inputId];
    if (handler) handler(value);
  },

  _syncClear(input) {
    const wrap = input.closest('.mb-search');
    const clear = wrap && wrap.querySelector('.mb-search-clear');
    if (clear) clear.hidden = !input.value;
  },

  // "Showing 50 of 312" is also how the silent list caps finally become
  // visible: before this, thirteen screens truncated with no indication,
  // so a record past the cap simply appeared not to exist.
  setCount(inputId, shown, total, meta) {
    const input = document.getElementById(inputId);
    const wrap = input && input.closest('.mb-search');
    const el = wrap && wrap.nextElementSibling;
    if (!el || !el.classList.contains('mb-search-count')) return;

    if (shown == null) { el.hidden = true; el.textContent = ''; return; }
    const searching = !!(input.value || '').trim();

    const notes = [];
    // The safety half of fuzzy matching: approximate results must never
    // look like exact ones. Without this the operator has no way to tell
    // that what they are reading is a guess.
    if (meta && meta.fuzzy) notes.push('No exact matches — showing near matches');
    if (meta && meta.unknownFields && meta.unknownFields.length) {
      const names = meta.unknownFields.join(', ');
      notes.push(`${names} isn't a field — searched the text instead`);
    }

    let text = '';
    if (total != null && shown < total) {
      // No "refine your search" any more -- MApp.Paging puts a Show-more
      // button under the list, so the rest is reachable rather than
      // something the operator has to word a better query to see.
      text = `Showing ${shown} of ${total}`;
    } else if (searching) {
      text = shown === 1 ? '1 match' : `${shown} matches`;
    }

    if (!text && !notes.length) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = notes.length ? [text, ...notes].filter(Boolean).join(' · ') : text;
    el.classList.toggle('mb-search-count-note', notes.length > 0);
    el.hidden = false;
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
    window.addEventListener('hashchange', () => this.handleHashChange());
    this.showTab(this.resolveInitialTab(), { replace: true });
  },

  tabFromHash() {
    const tab = String(location.hash || '').replace(/^#/, '');
    return this.TABS.indexOf(tab) > -1 ? tab : null;
  },

  // Same split as the desktop shell's Navigation.resolveInitialTab: the URL
  // hash is per-browser-tab and so wins, localStorage is the origin-wide
  // fallback for a tab opened without a hash. Reading localStorage alone
  // meant two tabs open on two modules overwrote each other's "last tab",
  // and both then reloaded onto whichever was touched most recently.
  resolveInitialTab() {
    const fromHash = this.tabFromHash();
    if (fromHash) return fromHash;
    let stored = null;
    try { stored = localStorage.getItem(this.LAST_TAB_KEY); } catch (e) { /* storage inaccessible */ }
    return this.TABS.indexOf(stored) > -1 ? stored : 'home';
  },

  // Written through the history API rather than by assigning location.hash
  // so it fires no hashchange and never re-enters showTab. `replace` keeps
  // the boot-time write from leaving an entry behind the user's first Back.
  syncHash(tab, replace) {
    const target = `#${tab}`;
    if (location.hash === target) return;
    try {
      history[replace ? 'replaceState' : 'pushState'](null, '', target);
    } catch (e) {
      location.hash = tab; // history API unavailable
    }
  },

  handleHashChange() {
    const tab = this.tabFromHash();
    if (!tab || tab === this.current) return;
    this.showTab(tab);
  },

  showTab(tab, opts) {
    if (this.TABS.indexOf(tab) === -1) return;
    const changed = tab !== this.current;
    this.current = tab;
    this.syncHash(tab, !!(opts && opts.replace));
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
  // Entries are { id, onDismiss } -- onDismiss lets a sheet that owns
  // more state than its DOM (the Picker, which has a pending promise to
  // settle) be torn down correctly when something other than its own
  // close button dismisses it.
  _stack: [],
  _drag: null,
  // True only while a popstate is being handled. close() reads it to know
  // the history entry is already gone and must not be popped a second
  // time -- which matters through indirection like popstate -> onDismiss
  // -> Picker.cancel() -> Sheet.close().
  _inPopstate: false,
  DRAG_DISMISS_PX: 110,

  open(sheetId, opts) {
    const backdrop = document.getElementById('mapp-sheet-backdrop');
    const sheet = document.getElementById(sheetId);
    if (!sheet) return;
    if (backdrop) backdrop.classList.add('open');
    sheet.classList.add('open');
    document.body.style.overflow = 'hidden';
    // A sheet covers the tab bar, so anything that positions itself above
    // the tab bar (the multi-select action bar) must drop to the bottom
    // edge while one is open, or it floats with a strip of sheet showing
    // underneath it.
    document.body.classList.add('mb-sheet-open');
    this._stack.push({ id: sheetId, onDismiss: opts && opts.onDismiss });

    // Sheets are this app's entire secondary navigation (Log Lot, New
    // Dispatch, Log Return, ~20 of them) and none of them used to
    // participate in history. Android's hardware Back and iOS's back-swipe
    // therefore fell through to MApp.Shell's hash router, which switched
    // the tab BEHIND the open sheet -- or, on the first history entry,
    // exited the PWA. Either way a half-entered lot was gone with no
    // warning. One entry per sheet, pushed with no URL argument so the
    // hash is untouched: Back over it fires popstate (which we handle)
    // and NOT hashchange (which Shell handles), so the two routers never
    // fight over the same gesture.
    try {
      history.pushState({ mappSheet: sheetId }, '');
    } catch (e) { /* history API unavailable -- Back reverts to old behaviour */ }
  },

  // `fromHistory` is set only by the popstate handler below.
  close(sheetId, fromHistory) {
    const sheet = document.getElementById(sheetId);
    const wasTop = this._stack.length > 0 && this._stack[this._stack.length - 1].id === sheetId;
    if (sheet) sheet.classList.remove('open');
    this._stack = this._stack.filter(entry => entry.id !== sheetId);
    if (this._stack.length === 0) {
      const backdrop = document.getElementById('mapp-sheet-backdrop');
      if (backdrop) backdrop.classList.remove('open');
      document.body.style.overflow = '';
      document.body.classList.remove('mb-sheet-open');
    }

    // Closing by any route other than Back (the X button, a successful
    // save, picking a picker option) leaves behind the history entry
    // open() pushed. Consume it, or the user's next Back press moves over
    // a stale entry and appears to do nothing. Only for the top sheet:
    // closing something mid-stack out of order would pop the wrong entry,
    // and leaving that one behind is the safer of the two failures.
    if (!fromHistory && !this._inPopstate && wasTop) {
      try { history.back(); } catch (e) { /* history API unavailable */ }
    }
  },

  // Closes the topmost sheet the way a Back press or Escape should:
  // through its own dismiss handler when it has one, so a Picker's
  // pending promise still settles.
  dismissTop(fromHistory) {
    const top = this._stack[this._stack.length - 1];
    if (!top) return false;
    if (typeof top.onDismiss === 'function') top.onDismiss();
    else this.close(top.id, fromHistory);
    return true;
  },

  initHistory() {
    window.addEventListener('popstate', () => {
      if (this._stack.length === 0) return; // not ours -- let Shell's hashchange handle it
      this._inPopstate = true;
      try {
        this.dismissTop(true);
      } finally {
        this._inPopstate = false;
      }
    });

    // Escape closes the top sheet. This app is used with bluetooth
    // barcode scanners, which present as keyboards, so a hardware Escape
    // is a real input path here -- and it costs nothing on touch.
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || this._stack.length === 0) return;
      e.preventDefault();
      this.dismissTop(false);
    });
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
      // Sets the Y variable, not transform: the sheet composes its
      // transform from --mb-sheet-x (frame centring on a tablet) and
      // --mb-sheet-y, and assigning transform here would discard the X.
      d.sheet.style.setProperty('--mb-sheet-y', dy + 'px');
    });

    const end = e => {
      const d = this._drag;
      if (!d || e.pointerId !== d.pointerId) return;
      this._drag = null;
      d.sheet.classList.remove('mb-dragging');
      d.sheet.style.removeProperty('--mb-sheet-y');
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
MApp.Sheet.initHistory();

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

      this._entries = MApp.Search.index(this._items, this.SEARCH);
      MApp.SearchBox.attach('mapp-picker-search', t => this.onSearch(t));

      this._renderList(this._items, '');
      // onDismiss so a Back press or Escape settles the pending promise
      // (as cancel() does) instead of closing the DOM and leaving whoever
      // awaited open() hanging forever.
      MApp.Sheet.open('mapp-picker-sheet', { onDismiss: () => this.cancel() });

      if (searchable && searchInput) {
        setTimeout(() => searchInput.focus(), 280);
      }
    });
  },

  // Same matcher as every list, which is what lets a picker find "26 inch
  // Kalpi" by typing "kalpi 26". The raw term is still passed through to
  // _renderList for the allowCustom free-text option, which compares
  // against what was actually typed rather than the normalised form.
  SEARCH: {
    fields: [
      { key: 'label', weight: 10, label: 'Name' },
      { key: 'sublabel', weight: 4, label: 'Detail' }
    ]
  },

  onSearch(term) {
    this._renderList(MApp.Search.run(this._entries || [], term), term || '');
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
  // Data URL of the company logo, or null for the text fallback. Same
  // contract as desktop's App.companyLogo.
  companyLogo: null,

  // A challan printed from the shop floor and the same challan printed
  // from the office used to be different documents: desktop's
  // App.Print.trigger() calls injectLogo() and MApp's port deliberately
  // did not, so every phone-printed challan, PO and bill went to the
  // customer unbranded. Ported now, including the text fallback, so both
  // surfaces produce the same document.
  injectLogo() {
    document.querySelectorAll('.print-brand-text').forEach(el => {
      if (this.companyLogo) {
        el.innerHTML = `<img src="${MApp.Util.escapeHtml(this.companyLogo)}" style="max-height:60px;max-width:220px;object-fit:contain;-webkit-print-color-adjust:exact;print-color-adjust:exact;">`;
      } else {
        el.textContent = 'Maharaja Bikes';
      }
    });
  },

  // callCached, not call: printing is a shop-floor action and the factory
  // LAN is not reliable, so the logo has to survive an outage the same way
  // Home/Stock/Production/Dispatch data does. Best-effort throughout --
  // a missing logo prints the brand name, it never blocks a print.
  async loadLogo() {
    try {
      const res = await MApp.Api.callCached('getLogo');
      if (res && res.success && res.data) {
        this.companyLogo = res.data;
        this.injectLogo();
      }
    } catch (e) {
      /* offline with nothing cached -- the text fallback is correct here */
    }
  },

  trigger(containerId, documentTitle) {
    this.injectLogo();
    // '.print-container' is the same hook desktop print.js and both
    // stylesheets use. It replaces an '[id^="print-"]' prefix match, which
    // was wrong in a way that only showed up on the PO: that prefix also
    // matches #print-grand-total-container, a block NESTED inside the PO
    // template, so printing a purchase order from the phone hid its own
    // grand-total block. Only the 11 top-level containers carry the class.
    document.querySelectorAll('.print-container').forEach(el => {
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
  },

  // ── PDF: download and share ──────────────────────────────────────────
  // window.print() cannot hand back a file, so a phone could print a
  // challan and had no way to keep one or send one. Desktop has had
  // Download PDF since the server renderer landed; POST /erp/render-pdf is
  // a generic endpoint that takes the same print-container markup this
  // shell already builds, so the whole gap was a caller.
  //
  // Share is new to the product rather than ported, and it is the one of
  // the three that only makes sense here: a challan into WhatsApp is what
  // the office asks the floor for, and the alternative today is a photo of
  // a screen.

  _csrfToken() {
    return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
  },

  // Set false the first time the server proves it cannot render, so the
  // rest of the session stops asking and falls straight to the message.
  serverPdfAvailable: null,
  lastPdfError: null,

  // A Download button downloads. It does NOT quietly become a print
  // dialog -- the same reasoning desktop records: the user asked for a
  // file, a print dialog is a different task with a different outcome,
  // and appearing without warning is not a fallback. Say what happened
  // and name the alternative.
  PDF_ERRORS: {
    offline: 'No connection to the server, so nothing was downloaded. Use Print to save this through the print dialog instead.',
    'no-renderer': 'The server has no PDF renderer installed. Print still works meanwhile.',
    'no-endpoint': 'This server does not have the PDF endpoint — it is probably an older build and needs restarting. Print still works meanwhile.',
    rejected: 'The server refused the request, which usually means the session expired. Reload and try again.',
    failed: 'The server could not render this document. Nothing was downloaded.'
  },

  reportPdfUnavailable() {
    MApp.Toast.error(this.PDF_ERRORS[this.lastPdfError] || this.PDF_ERRORS.failed);
  },

  // Same status taxonomy as desktop's App.Print._postForBlob: which of
  // these five happened decides what the operator is told, and "could not
  // reach the renderer" covers four situations that need different
  // answers.
  async _postForBlob(body) {
    if (this.serverPdfAvailable === false) return null;

    let res;
    try {
      res = await fetch('/erp/render-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRFToken': this._csrfToken() },
        credentials: 'same-origin',
        body: JSON.stringify(body)
      });
    } catch (err) {
      // Never completed: offline, or the server is unreachable. The
      // common case on this LAN, and the reason Print stays the fallback.
      this.lastPdfError = 'offline';
      this.serverPdfAvailable = false;
      return null;
    }

    if (res.status === 503) { this.lastPdfError = 'no-renderer'; this.serverPdfAvailable = false; return null; }
    if (res.status === 404) { this.lastPdfError = 'no-endpoint'; this.serverPdfAvailable = false; return null; }
    if (res.status === 401 || res.status === 403 || res.status === 400) { this.lastPdfError = 'rejected'; return null; }
    if (!res.ok) { this.lastPdfError = 'failed'; return null; }

    this.lastPdfError = null;
    this.serverPdfAvailable = true;
    return await res.blob();
  },

  // Renders whatever is currently inside a print container. The container
  // is populated by the same _populatePrintData the Print button uses, so
  // the downloaded file and the printed page are one document.
  async _pdfFor(containerId, filename, landscape) {
    const el = document.getElementById(containerId);
    if (!el) return null;
    this.injectLogo();
    return this._postForBlob({
      html: el.innerHTML,
      landscape: !!landscape,
      // Desktop measures a fit density off the table's column count. The
      // documents reachable from here are the narrow ones -- challan, PO,
      // bill, statement -- so they take the server default rather than
      // porting the whole fit-tier machinery for a case it never hits.
      density: '',
      filename
    });
  },

  _pdfName(filename) {
    return filename.toLowerCase().endsWith('.pdf') ? filename : `${filename}.pdf`;
  },

  async download(containerId, filename, opts) {
    const name = this._pdfName(filename);
    const blob = await this._pdfFor(containerId, name, opts && opts.landscape);
    if (!blob) { this.reportPdfUnavailable(); return false; }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoked on a later turn: revoking synchronously cancels the
    // download in some browsers before they have read the blob.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return true;
  },

  // Feature-detected with a real File, because canShare({files}) is the
  // only reliable test -- navigator.share exists on browsers that cannot
  // take files at all, and desktop Chrome is one of them. A button that
  // opens nothing is worse than a button that is not there.
  canShareFiles() {
    try {
      if (!navigator.share || !navigator.canShare) return false;
      const probe = new File([new Blob([''], { type: 'application/pdf' })], 'p.pdf', { type: 'application/pdf' });
      return navigator.canShare({ files: [probe] });
    } catch (e) {
      return false;
    }
  },

  async share(containerId, filename, opts) {
    const name = this._pdfName(filename);
    const blob = await this._pdfFor(containerId, name, opts && opts.landscape);
    if (!blob) { this.reportPdfUnavailable(); return false; }

    try {
      await navigator.share({
        files: [new File([blob], name, { type: 'application/pdf' })],
        title: name
      });
      return true;
    } catch (err) {
      // Dismissing the share sheet is not a failure and must not be
      // reported as one -- it is the most common outcome of opening it.
      if (err && err.name === 'AbortError') return false;
      MApp.Toast.error('Could not share this document. It can still be downloaded.');
      return false;
    }
  },

  // One button per card rather than three. Three icons on a list row is
  // most of the row, and two of the three are occasional; the picker is
  // already this app's way of choosing one of a few things.
  //
  // `populate` fills the print container for the record in question --
  // the same call the Print path makes -- so all three actions describe
  // one document.
  async chooseAction({ containerId, filename, title, populate, landscape }) {
    const items = [
      { value: 'print', label: 'Print', sublabel: 'Opens the print dialog' },
      { value: 'download', label: 'Download PDF', sublabel: 'Saves a file' }
    ];
    if (this.canShareFiles()) {
      items.push({ value: 'share', label: 'Share', sublabel: 'Send it from this phone' });
    }

    const picked = await MApp.Picker.open({ title: title || 'Document', items });
    if (!picked) return;

    if (typeof populate === 'function') populate();
    if (picked.value === 'print') { this.trigger(containerId, filename); return; }
    if (picked.value === 'download') { await this.download(containerId, filename, { landscape }); return; }
    await this.share(containerId, filename, { landscape });
  }
};

// Cross-tab one-shot pre-filters set by Home's stat tiles, consumed and
// cleared by the target tab's own mount().
MApp.State = {
  stockFilter: '',
  // 'pool' sends the Stock tab to its Warehouse Pool pane on the next
  // mount. Read and cleared there, same as the filters below.
  stockView: '',
  productionFilter: '',
  dispatchFilter: '',
  lastDashboard: null // cached getMobileDashboard() payload, reused by the More tab's About row
};

// ================================================================
// HOME LAYOUT — which figures and charts Home shows.
//
// Home shipped with three fixed tiles. They are the right three for most
// people and the wrong three for anyone whose job is contractor
// payables, or purchase orders, or watching a queue drain. The numbers
// all existed; the choice did not.
//
// The blocks below declare which endpoint feeds them, and that is the
// whole reason this file is careful. getMobileDashboard is three numbers
// and is offline-cached; getDashboardData is the full set and is not
// cheap -- Home has always used the small one deliberately. So the cost
// follows the choice: pick only default tiles and Home makes exactly the
// request it always did. Pick anything else and it additionally asks for
// the full payload, renders the cheap tiles first, and fills the rest in
// when they land.
// ================================================================
MApp.HomeLayout = {
  KEY: 'maharaja-erp-mobile-home-blocks',

  // source: 'mobile' -- in getMobileDashboard, cached, free
  //         'full'   -- needs getDashboardData
  BLOCKS: [
    // ── Figures ────────────────────────────────────────────────────────
    { key: 'pendingProduction', group: 'Production', label: 'Pending production',
      source: 'mobile', kind: 'tile', accent: 'mb-accent-blue',
      value: d => d.pendingProductionCount || 0, tab: 'production' },
    { key: 'inProgressProduction', group: 'Production', label: 'In progress',
      source: 'full', kind: 'tile', accent: 'mb-accent-blue',
      value: d => (d.kpis || {}).inProgressProductionCount || 0, tab: 'production' },
    { key: 'queuedProduction', group: 'Production', label: 'Queued',
      source: 'full', kind: 'tile',
      value: d => (d.kpis || {}).queuedProductionCount || 0, tab: 'production' },
    { key: 'oldestPending', group: 'Production', label: 'Oldest pending lot',
      source: 'full', kind: 'tile', accent: 'mb-accent-red',
      value: d => (d.kpis || {}).oldestPendingProductionDays || 0, unit: 'days',
      tab: 'production' },

    { key: 'todaysDispatches', group: 'Dispatch', label: 'Today’s dispatches',
      source: 'mobile', kind: 'tile', accent: 'mb-accent-safety',
      value: d => d.todaysDispatchCount || 0, tab: 'dispatch' },
    { key: 'readyToDispatch', group: 'Dispatch', label: 'Ready to dispatch',
      source: 'full', kind: 'tile', accent: 'mb-accent-safety',
      value: d => (d.kpis || {}).readyToDispatchUnits || 0, unit: 'units',
      tab: 'dispatch' },

    { key: 'lowStock', group: 'Stock', label: 'Low-stock alerts',
      source: 'mobile', kind: 'tile', wide: true,
      value: d => d.lowStockCount || 0, alertWhenPositive: true, tab: 'stock' },
    { key: 'lowStockDeficit', group: 'Stock', label: 'Total shortfall',
      source: 'full', kind: 'tile',
      value: d => (d.kpis || {}).lowStockTotalDeficit || 0, unit: 'units', tab: 'stock' },

    { key: 'openPos', group: 'Money', label: 'Open POs',
      source: 'full', kind: 'tile',
      value: d => (d.kpis || {}).openPoCount || 0,
      sub: d => MApp.Util.formatCurrency((d.kpis || {}).openPoValue || 0) },
    { key: 'billsThisMonth', group: 'Money', label: 'Bills this month',
      source: 'full', kind: 'tile',
      value: d => (d.kpis || {}).billsThisMonthCount || 0,
      sub: d => MApp.Util.formatCurrency((d.kpis || {}).billsThisMonthValue || 0) },
    { key: 'contractorPayables', group: 'Money', label: 'Contractor payables',
      source: 'full', kind: 'tile', accent: 'mb-accent-red', wide: true,
      value: d => MApp.Util.formatCurrency((d.kpis || {}).contractorPayablesDue || 0),
      sub: d => `${(d.kpis || {}).contractorPayablesCount || 0} contractor(s)` },

    // ── Charts ─────────────────────────────────────────────────────────
    // Drawn as inline SVG from data the server already returns. No
    // charting library: this app self-hosts everything because it runs on
    // factory LANs with no reliable internet, and the service worker only
    // caches same-origin /static/erp/ URLs.
    { key: 'dispatchTrend', group: 'Charts', label: 'Dispatch, last 30 days',
      source: 'full', kind: 'chart', chart: 'sparkline',
      series: d => d.dispatchTrend || [] },
    // A pie is a claim that the slices add up to something -- so each of
    // these three is parts of a whole, and each says what its whole is.
    // The two whose rows the server truncates pass a `total` as well, and
    // the remainder becomes an explicit Other slice: a pie of the top
    // five drawn as if it were everything is a lie about proportion.
    { key: 'productionMix', group: 'Charts', label: 'Lots by status',
      source: 'full', kind: 'chart', chart: 'pie',
      // A GROUP BY over every lot: already the whole, nothing withheld.
      series: d => (d.productionStatusBreakdown || [])
        .map(r => ({ label: r.status, value: r.count })) },
    { key: 'lowStockWorst', group: 'Charts', label: 'Where the shortfall is',
      source: 'full', kind: 'chart', chart: 'pie',
      total: d => (d.kpis || {}).lowStockTotalDeficit || 0,
      series: d => (d.lowStockItems || [])
        .map(r => ({ label: `${r.name}${r.size ? ' · ' + r.size : ''}`, value: r.deficit })) },
    { key: 'payablesByContractor', group: 'Charts', label: 'Payables by contractor',
      source: 'full', kind: 'chart', chart: 'pie', money: true,
      total: d => (d.kpis || {}).contractorPayablesDue || 0,
      series: d => (d.contractorPayables || [])
        .map(r => ({ label: MApp.Util.formatNameCase(r.contractorName), value: r.balanceDue })) }
  ],

  // The three Home has always shown. Anyone who never opens the picker
  // keeps exactly the screen -- and exactly the one request -- they had.
  DEFAULTS: ['pendingProduction', 'todaysDispatches', 'lowStock'],

  block(key) {
    return this.BLOCKS.find(b => b.key === key) || null;
  },

  read() {
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(this.KEY) || 'null'); } catch (e) { stored = null; }
    // Absent or malformed means never chosen, which is what gets the
    // defaults. A valid EMPTY array is a choice -- somebody who wants
    // only the activity list -- and is honoured, not quietly refilled.
    if (!Array.isArray(stored)) return this.DEFAULTS.slice();
    // Filtered through the catalogue: a key from an older build that no
    // longer exists must not leave a hole in the render.
    return stored.filter(k => this.block(k));
  },

  write(keys) {
    try { localStorage.setItem(this.KEY, JSON.stringify(keys)); } catch (e) { /* storage inaccessible */ }
  },

  selected() {
    // Rendered in catalogue order rather than pick order, so the grid
    // keeps a stable shape and related figures stay together.
    const chosen = new Set(this.read());
    return this.BLOCKS.filter(b => chosen.has(b.key));
  },

  // True when anything chosen needs the expensive payload. This is the
  // question Home asks before deciding to make a second request.
  needsFullData() {
    return this.selected().some(b => b.source === 'full');
  },

  // ── The picker ───────────────────────────────────────────────────────
  open() {
    this._draft = new Set(this.read());
    this.render();
    MApp.Sheet.open('sheet-home-layout');
  },

  close() { MApp.Sheet.close('sheet-home-layout'); },

  toggle(key) {
    if (!this.block(key)) return;
    if (this._draft.has(key)) this._draft.delete(key);
    else this._draft.add(key);
    this.render();
  },

  reset() {
    this._draft = new Set(this.DEFAULTS);
    this.render();
  },

  render() {
    const body = document.getElementById('home-layout-body');
    if (!body) return;

    const groups = [];
    this.BLOCKS.forEach(b => {
      let g = groups.find(x => x.name === b.group);
      if (!g) { g = { name: b.group, blocks: [] }; groups.push(g); }
      g.blocks.push(b);
    });

    body.innerHTML = groups.map(g => `
      <div class="mapp-section-label">${MApp.Util.escapeHtml(g.name)}</div>
      ${g.blocks.map(b => {
    const on = this._draft.has(b.key);
    return `
        <button type="button" class="mb-card mb-card-tappable" data-block-toggle="${MApp.Util.escapeHtml(b.key)}">
          <div class="mb-card-row">
            <div>
              <div class="mb-card-title">${MApp.Util.escapeHtml(b.label)}</div>
              ${b.source === 'full'
    ? '<div class="mb-card-sub">Needs the full dashboard — a slower load</div>'
    : '<div class="mb-card-sub">Always loaded, works offline</div>'}
            </div>
            <span class="mb-chip${on ? ' mb-chip-completed' : ''}">${on ? 'Shown' : 'Hidden'}</span>
          </div>
        </button>`;
  }).join('')}
    `).join('');

    body.querySelectorAll('[data-block-toggle]').forEach(btn => {
      btn.addEventListener('click', () => this.toggle(btn.dataset.blockToggle));
    });

    const note = document.getElementById('home-layout-note');
    if (note) {
      const heavy = [...this._draft].filter(k => (this.block(k) || {}).source === 'full').length;
      note.textContent = heavy
        ? `${heavy} of these need the full dashboard, so Home will take a moment longer and those tiles will not be there offline.`
        : 'All of these come from the small payload Home already caches, so it stays instant and works offline.';
    }
  },

  save() {
    // An empty Home is a real choice -- somebody who only wants the
    // activity list -- so it is allowed rather than silently refilled.
    this.write([...this._draft]);
    this.close();
    MApp.Home.mount();
  }
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

      // Only when the operator has chosen a figure the small payload does
      // not carry. Home has always used getMobileDashboard on purpose --
      // three numbers, cached, instant -- and anyone who leaves the
      // default tiles alone still makes exactly that one request.
      if (MApp.HomeLayout.needsFullData()) await this._loadFullData();
    } catch (err) {
      MApp.Util.renderError(statsEl, err && err.message, () => this.mount());
      if (activityEl) activityEl.innerHTML = '';
    }
  },

  // Fills in the blocks that were rendered as placeholders. Failing here
  // is not failing the screen: the cheap tiles and the activity list are
  // already up, and offline this request simply will not arrive.
  async _loadFullData() {
    try {
      const res = await MApp.Api.call('getDashboardData');
      if (!res || !res.success) { this._markFullBlocksUnavailable(); return; }
      this._full = res.data || {};
      this.renderBlocks({ ...MApp.State.lastDashboard, ...this._full });
    } catch (err) {
      this._markFullBlocksUnavailable();
    }
  },

  _markFullBlocksUnavailable() {
    document.querySelectorAll('[data-block-pending]').forEach(el => {
      const val = el.querySelector('.mb-stat-tile-value');
      if (val) val.textContent = '—';
      const chart = el.querySelector('.mapp-chart-body');
      if (chart) chart.innerHTML = '<div class="mb-text-sm mb-text-steel">Not available offline.</div>';
    });
  },

  render(data, offlineCachedAt) {
    const statsEl = document.getElementById('home-stats');
    if (statsEl) {
      const banner = offlineCachedAt ? MApp.Util.offlineBannerHtml(offlineCachedAt) : '';
      statsEl.innerHTML = banner + '<div class="mb-stat-grid" id="home-blocks"></div>';
      this.renderBlocks(data);
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

  // ── The chosen blocks ──────────────────────────────────────────────
  // Re-run twice on a customised Home: once with the small payload, once
  // more when the full one lands. A block whose source has not arrived
  // yet draws its frame and a dash rather than a zero -- "we do not know
  // yet" and "there are none" are different answers, and on a dashboard
  // the difference is the whole point.
  renderBlocks(data) {
    const host = document.getElementById('home-blocks');
    if (!host) return;

    const blocks = MApp.HomeLayout.selected();
    if (blocks.length === 0) {
      host.innerHTML = `
        <div class="mb-card" style="grid-column:1 / -1;">
          <div class="mb-card-sub">No figures chosen.
            <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" onclick="MApp.HomeLayout.open()">Pick some</button>.
          </div>
        </div>`;
      return;
    }

    const ready = key => key !== 'full' || !!this._full;

    host.innerHTML = blocks.map(b => {
      const pending = !ready(b.source);
      const attrs = pending ? ' data-block-pending="1"' : '';
      return b.kind === 'chart'
        ? this._chartHtml(b, data, pending, attrs)
        : this._tileHtml(b, data, pending, attrs);
    }).join('');

    host.querySelectorAll('[data-block-tab]').forEach(el => {
      el.addEventListener('click', () => this.goTo(el.dataset.blockTab));
    });
  },

  _tileHtml(b, data, pending, attrs) {
    const value = pending ? '—' : b.value(data);
    const sub = !pending && b.sub ? b.sub(data) : '';
    const alert = b.alertWhenPositive && !pending && Number(value) > 0;
    const accent = alert ? ' mb-accent-red' : (b.accent ? ' ' + b.accent : '');
    const tag = b.tab ? 'button' : 'div';
    const tabAttr = b.tab ? ` type="button" data-block-tab="${MApp.Util.escapeHtml(b.tab)}"` : '';
    return `
      <${tag} class="mb-stat-tile${accent}"${b.wide ? ' style="grid-column:1 / -1;"' : ''}${tabAttr}${attrs}>
        <div class="mb-stat-tile-top">
          <span class="mb-stat-tile-label">${MApp.Util.escapeHtml(b.label)}</span>
        </div>
        <div class="mb-stat-tile-value${alert ? ' mb-alert' : ''}">${MApp.Util.escapeHtml(String(value))}</div>
        ${sub ? `<div class="mb-card-sub">${MApp.Util.escapeHtml(sub)}</div>` : ''}
        ${!pending && b.unit ? `<div class="mb-card-sub">${MApp.Util.escapeHtml(b.unit)}</div>` : ''}
      </${tag}>`;
  },

  _chartHtml(b, data, pending, attrs) {
    const body = pending
      ? '<div class="mb-skel mb-skel-line" style="width:100%;height:48px;"></div>'
      : (b.chart === 'sparkline'
        ? this._sparkline(b.series(data))
        // `total` is how a block declares that its rows are a top-N and
        // names the real whole they came out of.
        : this._pie(b.series(data), { money: b.money, total: b.total ? b.total(data) : 0 }));
    return `
      <div class="mb-card mapp-chart" style="grid-column:1 / -1;"${attrs}>
        <div class="mb-stat-tile-label">${MApp.Util.escapeHtml(b.label)}</div>
        <div class="mapp-chart-body mb-mt-2">${body}</div>
      </div>`;
  },

  // Inline SVG, no library: this app self-hosts everything because it
  // runs on factory LANs with no reliable internet, and the service
  // worker only caches same-origin /static/erp/ URLs.
  //
  // aria-hidden with a text summary beside it, rather than a chart that
  // announces 30 unlabelled numbers: the shape is for eyes, the total
  // and the peak are what a screen reader can actually use.
  _sparkline(series) {
    const points = (series || []).map(p => Number(p.qty) || 0);
    if (points.length < 2) return '<div class="mb-text-sm mb-text-steel">Not enough days yet.</div>';

    const max = Math.max(...points, 1);
    const w = 100, h = 32;
    const step = w / (points.length - 1);
    const path = points
      .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(2)},${(h - (v / max) * h).toFixed(2)}`)
      .join(' ');
    const total = points.reduce((a, v) => a + v, 0);
    const peak = Math.max(...points);

    return `
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="mapp-spark" aria-hidden="true">
        <path d="${path}" fill="none" stroke="var(--mb-safety)" stroke-width="1.5"
              vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>
      </svg>
      <div class="mb-card-sub mb-mt-2">${MApp.Util.formatQty(total)} units over ${points.length} days · peak ${MApp.Util.formatQty(peak)}</div>`;
  },

  // Slice colours come from the enamel palette, which keeps the same
  // paint codes in both themes (see mobile_contrast.test.js) -- so a
  // slice does not change meaning when the theme does. Six, then Other:
  // past that the wedges are thinner than a fingertip and the legend is
  // doing all the work anyway.
  PIE_COLOURS: [
    'var(--mb-enamel-blue)', 'var(--mb-enamel-green)', 'var(--mb-enamel-amber)',
    'var(--mb-enamel-red)', 'var(--mb-enamel-slate)', 'var(--mb-safety)'
  ],
  PIE_MAX_SLICES: 6,

  /**
   * A pie is a claim that the slices add up to something, so this needs
   * to be told what the whole IS. Two of the three callers hand it rows
   * the server has already truncated to a top-N; `total` is that set's
   * real sum, and the difference becomes an explicit Other slice. A pie
   * of the top five drawn as if it were everything is not a simplified
   * chart, it is a wrong one -- every percentage on it would be inflated.
   */
  _pie(series, opts) {
    const o = opts || {};
    const fmt = v => (o.money ? MApp.Util.formatCurrency(v) : MApp.Util.formatQty(v));

    let rows = (series || [])
      .map(r => ({ label: String(r.label || ''), value: Number(r.value) || 0 }))
      .filter(r => r.value > 0)
      .sort((a, b) => b.value - a.value);

    if (rows.length === 0) return '<div class="mb-text-sm mb-text-steel">Nothing to show.</div>';

    // Anything past the sixth slice, plus whatever the server held back,
    // is one Other wedge rather than a fringe of unreadable slivers.
    let other = 0;
    if (rows.length > this.PIE_MAX_SLICES) {
      other += rows.slice(this.PIE_MAX_SLICES).reduce((a, r) => a + r.value, 0);
      rows = rows.slice(0, this.PIE_MAX_SLICES);
    }
    const shown = rows.reduce((a, r) => a + r.value, 0);
    const declared = Number(o.total) || 0;
    if (declared > shown + other + 0.0001) other += declared - shown - other;
    if (other > 0.0001) rows.push({ label: 'Other', value: other, isOther: true });

    const total = rows.reduce((a, r) => a + r.value, 0);
    if (total <= 0) return '<div class="mb-text-sm mb-text-steel">Nothing to show.</div>';

    const R = 50, C = 52; // radius, centre -- 2px of margin for the stroke
    const point = frac => {
      // Start at twelve o'clock and go clockwise, which is how a pie is
      // read. -PI/2 rotates the zero angle up from three o'clock.
      const a = frac * Math.PI * 2 - Math.PI / 2;
      return [(C + R * Math.cos(a)).toFixed(3), (C + R * Math.sin(a)).toFixed(3)];
    };

    let acc = 0;
    const wedges = rows.map((r, i) => {
      const frac = r.value / total;
      const fill = r.isOther ? 'var(--mb-steel-light)' : this.PIE_COLOURS[i % this.PIE_COLOURS.length];
      // A single slice covering the whole circle has identical start and
      // end points, and an arc between two identical points draws
      // nothing at all. It is a circle, so draw a circle.
      if (frac >= 0.9999) {
        return `<circle cx="${C}" cy="${C}" r="${R}" fill="${fill}"/>`;
      }
      const [x1, y1] = point(acc);
      acc += frac;
      const [x2, y2] = point(acc);
      const large = frac > 0.5 ? 1 : 0;
      return `<path d="M${C},${C} L${x1},${y1} A${R},${R} 0 ${large},1 ${x2},${y2} Z" fill="${fill}"/>`;
    }).join('');

    // The SVG is decoration; the legend carries the numbers. A pie read
    // aloud as a list of unlabelled wedges tells nobody anything.
    const legend = rows.map((r, i) => {
      const pct = Math.round((r.value / total) * 100);
      const swatch = r.isOther ? 'var(--mb-steel-light)' : this.PIE_COLOURS[i % this.PIE_COLOURS.length];
      return `
      <div class="mapp-pie-row">
        <span class="mapp-pie-swatch" style="background:${swatch};" aria-hidden="true"></span>
        <span class="mapp-pie-label">${MApp.Util.escapeHtml(r.label)}</span>
        <span class="mapp-pie-value">${MApp.Util.escapeHtml(fmt(r.value))} · ${pct}%</span>
      </div>`;
    }).join('');

    return `
      <div class="mapp-pie-wrap">
        <svg viewBox="0 0 104 104" class="mapp-pie" aria-hidden="true">${wedges}</svg>
        <div class="mapp-pie-legend">${legend}</div>
      </div>
      <div class="mb-card-sub mb-mt-2">Total ${MApp.Util.escapeHtml(fmt(total))}</div>`;
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
// call). Tapping a card expands recent movements.
//
// Those movements used to be merged client-side from six datasets
// (Bill/Return/Wastage/Issue/Production/Stock-adjustment), on the stated
// grounds that "there is no dedicated item ledger server endpoint
// (confirmed: the desktop Item Ledger tab derives it the same way)".
// That was true when written and is not any more: getItemLedgerData
// exists, desktop moved onto it, and its docstring records exactly why
// deriving this in the browser is wrong. It now backs this panel too --
// see _loadMovements for what the merge got wrong.
// ================================================================
MApp.Stock = {
  // Narration and unit were not searchable before; on a 1,600-row stock
  // list the extra fields are the difference between finding a part and
  // scrolling for it.
  SEARCH: {
    fields: [
      { key: 'name', weight: 10, label: 'Item' },
      { key: 'size', weight: 6, label: 'Size' },
      { key: 'narration', weight: 3, label: 'Narration' },
      { key: 'unit', weight: 1, label: 'Unit' }
    ]
  },

  searchTerm: '',
  all: [],
  filtered: [],
  expandedKey: null,
  _ledgerCache: null, // per item name, for the session -- see _loadMovements

  mount() {
    this.expandedKey = null;
    this._ledgerCache = null;
    const searchInput = document.getElementById('stock-search');
    if (searchInput) searchInput.value = '';

    // Reset per tab ENTRY, not per view switch: MApp.Shell re-clones the
    // tab template on every entry, so a pane that was loaded during the
    // last visit is an empty div now.
    this._mounted = {};

    // MApp.State.stockView is the handoff from anything that navigates
    // straight to the pool -- the More tab's card, global search, a pool
    // write reloading afterwards. Read once and cleared, exactly like
    // stockFilter below it.
    const wanted = MApp.State.stockView === 'pool' ? 'pool' : 'stock';
    MApp.State.stockView = '';
    this.showView(wanted);
  },

  // ── The two views ────────────────────────────────────────────────────
  // Stock and Warehouse Pool answer the same floor question -- how much
  // of this do we have -- out of two different records: what the item
  // master holds, and what is in progress between process stages. They
  // share a tab because that is how the question gets asked, and a
  // segmented switch rather than a filter chip because swapping which
  // record you are reading is not the same act as narrowing one list.
  view: 'stock',

  showView(view) {
    const target = view === 'pool' ? 'pool' : 'stock';
    const switched = this.view !== target;
    this.view = target;

    ['stock', 'pool'].forEach(v => {
      const pane = document.getElementById('stock-pane-' + v);
      if (pane) pane.hidden = v !== target;
      const tab = document.getElementById('stock-view-tab-' + v);
      if (tab) tab.setAttribute('aria-selected', String(v === target));
    });

    // Both the screen heading and the top bar follow, so the answer on
    // screen is never labelled with the other record's name.
    const label = target === 'pool' ? 'Warehouse Pool' : 'Stock';
    const titleEl = document.getElementById('stock-screen-title');
    if (titleEl) titleEl.textContent = label;
    const topbarEl = document.getElementById('mapp-topbar-title');
    if (topbarEl) topbarEl.textContent = label;

    // Each side loads the first time it is shown and not again on every
    // toggle -- flipping back and forth is a normal fidget and should
    // not cost a round trip. A pool write reloads its own side.
    this._mounted = this._mounted || {};
    if (target === 'pool') {
      if (!this._mounted.pool) { this._mounted.pool = true; MApp.Pool.mount(); }
    } else if (!this._mounted.stock) {
      this._mounted.stock = true;
      this.load();
    }
    if (switched) MApp.Haptics.light();
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

      this.searchTerm = '';
      MApp.SearchBox.attach('stock-search', term => this.onSearch(term));
      this._applyFilters();

      this.render();
    } catch (err) {
      MApp.Util.renderError(listEl, err && err.message, () => this.load());
    }
  },

  _key(name, size) {
    return String(name || '').trim().toLowerCase() + '||' + String(size || '').trim().toLowerCase();
  },

  onSearch(term) {
    this.searchTerm = term || '';
    this._applyFilters();
    this.render();
  },

  // One place decides what `filtered` is, so the low-stock filter and the
  // search term compose instead of each clobbering the other -- clearing
  // the search inside a low-stock view used to drop you back to the full
  // list.
  _applyFilters() {
    const base = this._lowStockOnly ? this.all.filter(s => s.isLowStock) : this.all;
    this.filtered = MApp.Search.run(MApp.Search.index(base, this.SEARCH), this.searchTerm);
  },

  clearLowStockFilter() {
    this._lowStockOnly = false;
    this._applyFilters();
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

    MApp.SearchBox.setCount('stock-search', this.filtered.length, this.filtered.length, this.filtered._meta);

    if (this.filtered.length === 0) {
      listEl.innerHTML = banner;
      const empty = document.createElement('div');
      listEl.appendChild(empty);
      const term = (this.searchTerm || '').trim();
      MApp.Util.renderEmpty(empty, {
        title: 'No items found',
        body: term
          ? `Nothing matches “${term}”.`
          : (this._lowStockOnly ? 'Nothing is currently below its threshold.' : 'No stock records yet.')
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
          ${item.isLowStock || item.deadStock ? `<div class="mb-mt-2" style="display:flex;gap:6px;flex-wrap:wrap;">
            ${item.isLowStock ? '<span class="mb-chip mb-chip-lowstock">Low stock</span>' : ''}
            ${item.deadStock ? '<span class="mb-chip">Dead stock</span>' : ''}
          </div>` : ''}
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
      const movements = await this._loadMovements(item.name, item.size);

      if (movements.length === 0) {
        panel.innerHTML = adjustBtn + '<div class="mb-text-sm mb-text-steel" style="padding:var(--mb-sp-2) 0;">No recorded movements for this item yet.</div>';
        return;
      }

      panel.innerHTML = adjustBtn + movements.slice(0, 8).map(m => {
        const delta = (m.incomingQty || 0) - (m.outgoingQty || 0);
        // A row the Stock formula does not count -- a "Ledger only" bill,
        // or a PO, which is an intent to buy rather than a receipt. Shown
        // for context, muted, and never given a signed quantity that
        // would read as a movement.
        const counts = m.countsTowardStock !== false;
        const qtyHtml = counts
          ? `<span style="font-weight:700;color:${delta >= 0 ? 'var(--mb-enamel-green-ink)' : 'var(--mb-enamel-red-ink)'};">${delta >= 0 ? '+' : ''}${MApp.Util.formatQty(delta)}</span>`
          : '<span class="mb-text-steel">not counted</span>';
        // enteredQty differs from the base quantity whenever the line was
        // entered in a non-base unit -- a line entered in Dozen moves 12.
        // Showing both is the point: the old client-side version showed
        // only the as-entered figure, so it read 1.
        const entered = m.enteredQty != null && Math.abs(m.enteredQty - Math.abs(delta)) > 0.0001
          ? ` <span class="mb-text-steel">(${MApp.Util.formatQty(m.enteredQty)} ${MApp.Util.escapeHtml(m.unit || '')})</span>`
          : '';
        return `
        <div class="mb-flex-row" style="justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--mb-steel-faint);">
          <div>
            <div class="mb-text-sm" style="font-weight:600;color:var(--mb-ink);">${MApp.Util.escapeHtml(m.type)}${m.ref ? ' ' + MApp.Util.escapeHtml(m.ref) : ''}</div>
            <div class="mb-text-sm mb-text-steel">${MApp.Util.formatDateDisplay(m.dateRaw)}${m.party ? ' · ' + MApp.Util.escapeHtml(MApp.Util.formatNameCase(m.party)) : ''}</div>
          </div>
          <div class="mb-text-sm" style="text-align:right;white-space:nowrap;">
            ${qtyHtml}${entered}
            ${m.balance != null ? `<div class="mb-text-sm mb-text-steel">bal ${MApp.Util.formatQty(m.balance)}</div>` : ''}
          </div>
        </div>`;
      }).join('');
    } catch (err) {
      panel.innerHTML = adjustBtn + `<div class="mb-text-sm" style="color:var(--mb-enamel-red-ink);">Couldn't load movement history: ${MApp.Util.escapeHtml(err.message || '')}</div>`;
    }
  },

  // getItemLedgerData returns every movement for one Items Master NAME,
  // across all its size variants, so the size filter happens here.
  //
  // This replaces a client-side merge of six separate datasets that was
  // wrong in two ways the server endpoint exists to fix: quantities were
  // as-entered rather than base units (a line entered in Dozen showed 1
  // while moving 12), and every bill line was counted -- including ones
  // the operator had explicitly excluded from Stock through the
  // stock-adjustment conflict flow, which the server marks
  // countsTowardStock:false. It also cost six round trips per expand,
  // on a factory LAN, to compute an answer the server already had.
  //
  // Cached per item name for the session: expanding, collapsing and
  // re-expanding a card is a normal fidget and should not refetch.
  async _loadMovements(name, size) {
    this._ledgerCache = this._ledgerCache || {};
    const key = String(name || '').trim().toLowerCase();
    if (!this._ledgerCache[key]) {
      const res = await MApp.Api.call('getItemLedgerData', name);
      if (!res || !res.success) throw new Error((res && res.message) || 'Could not load the item ledger.');
      this._ledgerCache[key] = (res.data && res.data.entries) || [];
    }
    const wanted = String(size || '').trim().toLowerCase();
    return this._ledgerCache[key].filter(e => String(e.size || '').trim().toLowerCase() === wanted);
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

    const thresholdEl = document.getElementById('stock-threshold-value');
    if (thresholdEl) thresholdEl.value = item.threshold != null ? item.threshold : '';
    this._deadStock = !!item.deadStock;
    this._paintDeadToggle();

    MApp.Sheet.open('sheet-stock-adjust');
  },

  closeAdjustSheet() {
    MApp.Sheet.close('sheet-stock-adjust');
  },

  // ── Low-stock settings ──────────────────────────────────────────────
  // Home leads with a "Low-stock alerts" tile and Stock has a low-stock
  // filter, and until now nothing on the phone could change the threshold
  // that raises either. The app was sounding an alarm it gave no way to
  // tune, which is the shape of thing that teaches people to ignore it.
  //
  // Saved separately from the stock correction above. That correction is
  // an audited event about what is physically on the shelf; these two are
  // settings about how the item is WATCHED. One Save meaning both would
  // make an audit entry out of changing a threshold.
  toggleDeadStock() {
    this._deadStock = !this._deadStock;
    this._paintDeadToggle();
  },

  _paintDeadToggle() {
    const btn = document.getElementById('stock-dead-toggle');
    if (!btn) return;
    btn.textContent = this._deadStock ? 'Yes' : 'No';
    btn.setAttribute('aria-pressed', this._deadStock ? 'true' : 'false');
    btn.classList.toggle('mb-placeholder', !this._deadStock);
  },

  async saveSettings() {
    const item = this._adjustItem;
    if (!item) return;
    // Deliberately not MApp.Util.toNumber here: it answers 0 for "abc" and
    // for an empty field, and 0 is a threshold the server will happily
    // store -- it just switches the item's low-stock alert off for good.
    const raw = String(document.getElementById('stock-threshold-value')?.value ?? '').trim();
    const threshold = parseFloat(raw);
    if (raw === '' || !isFinite(threshold) || threshold < 0) {
      MApp.Toast.error('Enter a threshold of zero or more.');
      return;
    }

    const btn = document.getElementById('stock-settings-save-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

    // Two independent mutations. The threshold is sent only when it
    // actually changed, so re-saving to flip the dead-stock flag does not
    // write an identical threshold back.
    // NaN when the item had no threshold at all, which compares unequal to
    // every number -- so setting an unset threshold to 0 still sends.
    const current = item.threshold == null || item.threshold === ''
      ? NaN
      : parseFloat(item.threshold);

    let ok = true;
    if (threshold !== current) {
      const res = await MApp.Util.mutateSimple(
        'updateThreshold', [item.name, item.size || '', threshold], null
      );
      ok = ok && res.success;
    }
    if (ok && this._deadStock !== !!item.deadStock) {
      const res = await MApp.Util.mutateSimple(
        'updateDeadStock', [item.name, item.size || '', this._deadStock], null
      );
      ok = ok && res.success;
    }

    if (btn) { btn.disabled = false; btn.textContent = 'Save low-stock settings'; }
    if (ok) {
      MApp.Toast.success('Low-stock settings saved.');
      this.closeAdjustSheet();
      this.load();
    }
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

  // Production had no search at all and capped its list at 50 rows, so the
  // 51st lot was unreachable by any interaction the app offered. Process
  // name, contractor, status and colour are all searchable here because
  // that is how a lot is described on the floor -- "26 kalpi red" spans
  // three of these fields and matched nothing before.
  SEARCH: {
    fields: [
      { key: 'lotNumber', weight: 10, label: 'Lot' },
      { key: 'process', weight: 6, label: 'Process',
        get: l => (MApp.Production.processById[l.processId] || {}).processName || l.processId },
      { key: 'assignedTo', weight: 5, label: 'Assigned to' },
      { key: 'status', weight: 4, label: 'Status' },
      { key: 'productName', weight: 4, label: 'Product' },
      { key: 'colors', weight: 3, label: 'Colour',
        get: l => (l.colorQty || []).map(c => c && c.color) },
      { key: 'date', weight: 2, label: 'Date',
        get: l => MApp.Util.formatDateDisplay(l.dateRaw) }
    ]
  },

  // deleteProductionBulk takes production row IDs, which is what
  // deleteProduction already sends for a single lot (lot.rowIdx).
  SELECT: {
    key: 'production',
    noun: 'lot',
    plural: 'lots',
    method: 'deleteProductionBulk',
    payload: rows => [rows.map(r => r.rowIdx)],
    onDone: () => MApp.Production.load()
  },

  entries: [],
  searchTerm: '',
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

      // Indexed after processById is built -- the Process field resolves
      // through it, so indexing earlier would bake in raw processIds.
      this.entries = MApp.Search.index(this.lots, this.SEARCH);
      MApp.SearchBox.attach('production-search', term => this.onSearch(term));
      this.searchTerm = '';
      MApp.Paging.reset('production');

      this.render();
    } catch (err) {
      MApp.Util.renderError(listEl, err && err.message, () => this.load());
    }
  },

  onSearch(term) {
    this.searchTerm = term || '';
    // A new query starts at page one rather than inheriting however far
    // the previous result set had been expanded.
    MApp.Paging.reset('production');
    this.render();
  },

  render() {
    const listEl = document.getElementById('production-list');
    if (!listEl) return;

    let lots = MApp.Search.run(this.entries, this.searchTerm);
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

    const page = MApp.Paging.take('production', lots, () => this.render());
    const shown = page.rows;
    MApp.SearchBox.setCount('production-search', page.shown, page.total, page.meta);

    if (lots.length === 0) {
      listEl.innerHTML = banner;
      const empty = document.createElement('div');
      listEl.appendChild(empty);
      MApp.Util.renderEmpty(empty, this.searchTerm.trim()
        ? { title: 'No matching lots', body: `Nothing matches “${this.searchTerm.trim()}”.` }
        : { title: 'No lots logged today', body: 'Tap + to log the first lot.' });
    } else {
      listEl.innerHTML = banner + shown.map((l, i) => {
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
            <div class="mb-mt-2">
              <button type="button" class="mb-chip ${MApp.Util.statusChipClass(l.status)}" style="border:none;cursor:pointer;min-height:var(--mb-tap-min);" data-lot-action="status" data-lot-index="${i}">${MApp.Util.escapeHtml(l.status || 'Pending')} ▾</button>
            </div>
            <div class="mb-mt-2" style="display:flex; gap:var(--mb-sp-4);">
              <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" data-lot-action="edit" data-lot-index="${i}">Edit</button>
              <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" data-lot-action="sheet" data-lot-index="${i}">Sheet</button>
              <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;color:var(--mb-enamel-red-ink);" data-lot-action="delete" data-lot-index="${i}">Delete</button>
            </div>
          </div>`;
      }).join('') + MApp.Paging.moreHtml(page);

      listEl.querySelectorAll('[data-lot-action]').forEach(btn => {
        btn.addEventListener('click', () => {
          // Index into the array the rows were rendered FROM. It happened
          // to be safe to index `lots` while mapping `shown` only because
          // one is a prefix of the other -- but Edit/Delete acting on the
          // wrong lot is not a bug worth leaving to that coincidence.
          const lot = shown[Number(btn.dataset.lotIndex)];
          if (!lot) return;
          if (btn.dataset.lotAction === 'status') this.changeStatus(lot);
          else if (btn.dataset.lotAction === 'edit') this.openEditSheet(lot);
          else if (btn.dataset.lotAction === 'sheet') MApp.ProductionSheet.open(lot);
          else this.deleteLot(lot);
        });
      });

      MApp.Select.enable(listEl, shown, this.SELECT);
    }

    const clearBtn = listEl.querySelector('[data-clear-filter]');
    if (clearBtn) clearBtn.addEventListener('click', () => { this._pendingOnly = false; this.render(); });
  },

  STATUS_OPTIONS: ['Pending', 'In Progress', 'Completed', 'Cancelled'],

  // Marking a lot done at the machine. Previously this meant opening the
  // full edit sheet -- process cascade, colour checklist and all -- to
  // change one field, which is why it is the single most obvious phone
  // action in the product and was the one it could not do.
  //
  // Two things this does NOT do with the server's answer:
  //
  //   It does not send a canned success message. Completing a lot can
  //   drive a Warehouse Pool bucket negative, and the server says so in
  //   its own message ("Warehouse Pool stock will now show negative for
  //   this item"). MApp.Util.mutateSimple replaces that with whatever
  //   string the caller passed, which would swallow exactly the signal
  //   this app treats as important, so the toast is raised here instead.
  //
  //   It does not skip expected_qty. That is a concurrency guard: the
  //   server refuses the update if the record has been modified or
  //   shifted since this list was drawn, which on a phone showing a list
  //   loaded some time ago is a real possibility rather than a formality.
  async changeStatus(lot) {
    const picked = await MApp.Picker.open({
      title: `Lot ${lot.lotNumber}`,
      items: this.STATUS_OPTIONS.map(s => ({ value: s, label: s })),
      selectedValue: lot.status || 'Pending',
      searchable: false
    });
    if (!picked || picked.value === lot.status) return;

    try {
      const res = await Api.mutateWithId(
        'updateProductionStatus', Api.newMutationId(), lot.rowIdx, lot.qty, picked.value
      );
      if (!res || !res.success) {
        MApp.Toast.error((res && res.message) || 'Could not update the status.');
        return;
      }
      // The server's own message, warning and all.
      MApp.Toast.success(res.message || `Status set to ${picked.value}.`);
      this.load();
    } catch (err) {
      MApp.Toast.error(err.message || 'Could not reach the server. Please try again.');
    }
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
        <div class="mb-field-hint" id="lot-rate-hint" hidden></div>
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
        <div class="mb-field-hint" id="lot-rate-hint" hidden></div>
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
    this._showContractorRate();
  },

  // Shows what this contractor is paid for this process type and size,
  // once both are known. The rate is on their rate card and was
  // previously only visible at a desk -- so the person logging the lot
  // could not see what it would cost, and a missing rate card entry only
  // surfaced later as a zero payable.
  async _showContractorRate() {
    const hint = document.getElementById('lot-rate-hint');
    if (!hint) return;
    const contractor = this.selectedAssignedTo;
    const processType = this.selection.type;
    const size = this.selection.size;
    if (!contractor || !processType) { hint.textContent = ''; hint.hidden = true; return; }

    // The pick may have changed again while this was in flight.
    const token = ++this._rateSeq;
    try {
      const res = await MApp.Api.call('getContractorRateForProcessType', contractor, processType, size || '');
      if (token !== this._rateSeq) return;
      const rate = res && res.success ? MApp.Util.toNumber(res.data && res.data.ratePerUnit != null ? res.data.ratePerUnit : res.data) : 0;
      hint.hidden = false;
      hint.textContent = rate > 0
        ? `Rate on file: ${MApp.Util.formatCurrency(rate)} per unit.`
        : 'No rate on file for this contractor and process type — the payable will be zero.';
      hint.style.color = rate > 0 ? 'var(--mb-steel)' : 'var(--mb-enamel-amber-ink)';
    } catch (err) {
      if (token === this._rateSeq) { hint.textContent = ''; hint.hidden = true; }
    }
  },

  _rateSeq: 0,

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

  // Dispatch had no search and the same 50-row cap as Production. Client
  // and product are what an operator actually remembers about a challan.
  SEARCH: {
    fields: [
      { key: 'dispatchNumber', weight: 10, label: 'Challan' },
      { key: 'clientName', weight: 7, label: 'Client' },
      { key: 'productName', weight: 6, label: 'Product' },
      { key: 'logisticsContractor', weight: 4, label: 'Transport' },
      { key: 'date', weight: 2, label: 'Date',
        get: d => MApp.Util.formatDateDisplay(d.dateRaw) }
    ]
  },

  // getDispatchData is flattened one-row-per-line, so several cards can
  // share a dispatchNumber. deleteDispatchBulk deletes whole dispatches,
  // matching deleteDispatch's own contract -- so the payload is
  // de-duplicated, and selecting two lines of one challan deletes that
  // challan once rather than erroring on the second.
  SELECT: {
    key: 'dispatch',
    noun: 'dispatch',
    plural: 'dispatches',
    method: 'deleteDispatchBulk',
    payload: rows => [[...new Set(rows.map(r => r.dispatchNumber))]],
    onDone: () => MApp.Dispatch.load()
  },

  entries: [],
  searchTerm: '',

  mount() {
    this.load();
  },

  onSearch(term) {
    this.searchTerm = term || '';
    MApp.Paging.reset('dispatch');
    this.render();
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

      this.entries = MApp.Search.index(this.dispatches, this.SEARCH);
      MApp.SearchBox.attach('dispatch-search', term => this.onSearch(term));
      this.searchTerm = '';
      MApp.Paging.reset('dispatch');

      this.render();
    } catch (err) {
      MApp.Util.renderError(listEl, err && err.message, () => this.load());
    }
  },

  render() {
    const listEl = document.getElementById('dispatch-list');
    if (!listEl) return;

    let list = MApp.Search.run(this.entries, this.searchTerm);
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

    const page = MApp.Paging.take('dispatch', list, () => this.render());
    const shown = page.rows;
    MApp.SearchBox.setCount('dispatch-search', page.shown, page.total, page.meta);

    if (list.length === 0) {
      listEl.innerHTML = banner;
      const empty = document.createElement('div');
      listEl.appendChild(empty);
      MApp.Util.renderEmpty(empty, this.searchTerm.trim()
        ? { title: 'No matching dispatches', body: `Nothing matches “${this.searchTerm.trim()}”.` }
        : { title: 'No dispatches yet', body: 'Tap + to record the first dispatch.' });
    } else {
      listEl.innerHTML = banner + shown.map((d, idx) => `
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
          <button type="button" class="mb-btn mb-btn-secondary mb-mt-2" style="min-height:40px;" data-print-idx="${idx}">Challan…</button>
          <div class="mb-mt-2" style="display:flex; gap:var(--mb-sp-4);">
            <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" data-dispatch-action="edit" data-dispatch-number="${MApp.Util.escapeHtml(d.dispatchNumber)}">Edit</button>
            <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;color:var(--mb-enamel-red-ink);" data-dispatch-action="delete" data-dispatch-number="${MApp.Util.escapeHtml(d.dispatchNumber)}">Delete</button>
          </div>
        </div>
      `).join('') + MApp.Paging.moreHtml(page);
    }

    const clearBtn = listEl.querySelector('[data-clear-filter]');
    if (clearBtn) clearBtn.addEventListener('click', () => { this._todayOnly = false; this.render(); });

    listEl.querySelectorAll('[data-print-idx]').forEach(btn => {
      // `shown`, not `list` -- the indices were emitted while mapping the
      // sliced array, and printing the wrong challan is not a mistake to
      // leave resting on the two arrays sharing a prefix.
      btn.addEventListener('click', () => this.documentActions(parseInt(btn.dataset.printIdx, 10), shown));
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

    MApp.Select.enable(listEl, shown, this.SELECT);
  },

  // Fills #print-dispatch-container for one challan. Split out of the old
  // print(idx) so Download and Share populate the identical document
  // rather than each building their own.
  _populatePrintData(d) {
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

  },

  // Print, Download and Share over one populated container, so all three
  // describe the same challan.
  documentActions(idx, listRef) {
    const d = (listRef || this.dispatches)[idx];
    if (!d) return;
    MApp.Print.chooseAction({
      containerId: 'print-dispatch-container',
      filename: `Challan_${d.dispatchNumber}`,
      title: `Challan ${d.dispatchNumber}`,
      populate: () => this._populatePrintData(d)
    });
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
        ${this.lines.length > 1 ? `<button type="button" class="mb-btn-text mb-mt-2" style="padding:0;min-height:auto;color:var(--mb-enamel-red-ink);" onclick="MApp.Dispatch.removeLine(${i})">Remove</button>` : ''}
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
  // deleteReturnsBulk keys on the return NUMBER, and getReturnData is
  // one row per header (not flattened per line like Dispatch), so a card
  // is a whole return and the numbers need no de-duplicating.
  SELECT: {
    key: 'returns', noun: 'return', plural: 'returns',
    method: 'deleteReturnsBulk',
    payload: rows => [rows.map(r => r.returnNumber)],
    onDone: () => MApp.Returns.load()
  },

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
          <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;color:var(--mb-enamel-red-ink);" data-return-action="delete" data-return-index="${i}">Delete</button>
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

    MApp.Select.enable(listEl, this.returns, this.SELECT);
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
        ${this.lines.length > 1 ? `<button type="button" class="mb-btn-text mb-mt-2" style="padding:0;min-height:auto;color:var(--mb-enamel-red-ink);" onclick="MApp.Returns.removeLine(${i})">Remove</button>` : ''}
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
  // deletePOsBulk takes PO numbers, as deletePO does for one.
  SELECT: {
    key: 'po', noun: 'purchase order', plural: 'purchase orders',
    method: 'deletePOsBulk',
    payload: rows => [rows.map(r => r.poNumber)],
    onDone: () => MApp.PO.openLedgerSheet()
  },

  // Narration and item names were not searchable before, so a PO could only
  // be found by its number or vendor -- never by what was ordered.
  SEARCH: {
    fields: [
      { key: 'poNumber', weight: 10, label: 'PO' },
      { key: 'vendor', weight: 7, label: 'Vendor' },
      { key: 'status', weight: 4, label: 'Status' },
      { key: 'items', weight: 5, label: 'Item', get: p => (p.items || []).map(i => i && i.name) },
      { key: 'date', weight: 2, label: 'Date', get: p => MApp.Util.formatDateDisplay(p.dateRaw) }
    ]
  },

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
    MApp.SearchBox.attach('po-ledger-search', term => this.onSearch(term));
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
    MApp.Paging.reset('po');
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
    const base = this.statusFilter === 'all'
      ? this.pos
      : this.pos.filter(po => po.status === this.statusFilter);
    this.filtered = MApp.Search.run(MApp.Search.index(base, this.SEARCH), this.searchTerm);
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

    const page = MApp.Paging.take('po', this.filtered, () => this.render());
    MApp.SearchBox.setCount('po-ledger-search', page.shown, page.total, page.meta);
    listEl.innerHTML = pendingSyncBanner + page.rows.map(po => {
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
            <button type="button" class="mapp-topbar-btn" aria-label="Document actions for PO ${MApp.Util.escapeHtml(po.poNumber)}" onclick="MApp.PO.documentActions(${idx})">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/></svg>
            </button>
          </div>
        </div>
        <div class="mb-card-sub" style="margin-top:4px;">Qty: ${MApp.Util.formatQty(po.totalQty)} · Total: ${MApp.Util.formatCurrency(po.grandTotal)}</div>
        ${pendingLines ? `<div class="mb-card-sub" style="margin-top:4px;color:var(--mb-enamel-amber-ink);">${pendingLines}</div>` : ''}
        <div class="mb-mt-2" style="display:flex; gap:var(--mb-sp-4);">
          <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" data-po-action="edit" data-po-index="${idx}">Edit</button>
          <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;color:var(--mb-enamel-red-ink);" data-po-action="delete" data-po-index="${idx}">Delete</button>
        </div>
      </div>`;
    }).join('') + MApp.Paging.moreHtml(page);

    listEl.querySelectorAll('[data-po-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const po = this.pos[Number(btn.dataset.poIndex)];
        if (!po) return;
        if (btn.dataset.poAction === 'edit') this.openEditSheet(po);
        else this.deletePo(po);
      });
    });

    MApp.Select.enable(listEl, page.rows, this.SELECT);
  },

  _printTitle(po) {
    return `PO_${po.poNumber}_${String(po.vendor || '').replace(/[^a-zA-Z0-9 \-]/g, '').trim().replace(/\s+/g, '_')}`;
  },

  // Print, Download and Share over one populated container, so all three
  // describe the same document.
  documentActions(index) {
    const po = this.pos[index];
    if (!po) return;
    MApp.Print.chooseAction({
      containerId: 'print-po-container',
      filename: this._printTitle(po),
      title: `PO ${po.poNumber}`,
      populate: () => this._populatePrintData(po)
    });
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
        ${this.lines.length > 1 ? `<button type="button" class="mb-btn-text mb-mt-2" style="padding:0;min-height:auto;color:var(--mb-enamel-red-ink);" onclick="MApp.PO.removeLine(${i})">Remove</button>` : ''}
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
  // deleteBillsBulk keys on (vendor, billNumber) pairs -- the same two
  // values deleteBill takes as separate arguments.
  SELECT: {
    key: 'bill', noun: 'bill', plural: 'bills',
    method: 'deleteBillsBulk',
    payload: rows => [rows.map(r => ({ vendor: r.vendor, billNumber: r.billNumber }))],
    onDone: () => MApp.Bill.openLedgerSheet()
  },

  // Item names make a bill findable by what was received, not only by its
  // number or the vendor who sent it.
  SEARCH: {
    fields: [
      { key: 'billNumber', weight: 10, label: 'Bill' },
      { key: 'vendor', weight: 7, label: 'Vendor' },
      { key: 'items', weight: 5, label: 'Item', get: b => (b.items || []).map(i => i && i.name) },
      { key: 'poNumbers', weight: 4, label: 'PO', get: b => b.poNumbers || [] },
      { key: 'date', weight: 2, label: 'Date', get: b => MApp.Util.formatDateDisplay(b.dateRaw) }
    ]
  },

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
    MApp.SearchBox.attach('bill-ledger-search', term => this.onSearch(term));
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
    MApp.Paging.reset('bill');
    this.searchTerm = String(term || '').trim().toLowerCase();
    this._applyFilters();
  },

  _applyFilters() {
    this.filtered = MApp.Search.run(MApp.Search.index(this.bills, this.SEARCH), this.searchTerm);
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

    const page = MApp.Paging.take('bill', this.filtered, () => this.render());
    MApp.SearchBox.setCount('bill-ledger-search', page.shown, page.total, page.meta);
    listEl.innerHTML = page.rows.map(bill => {
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
          <button type="button" class="mapp-topbar-btn" aria-label="Document actions for bill ${MApp.Util.escapeHtml(bill.billNumber)}" onclick="MApp.Bill.documentActions(${idx})">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/></svg>
          </button>
        </div>
        <div class="mb-card-sub" style="margin-top:4px;">Qty: ${MApp.Util.formatQty(bill.totalQty)} · Total: ${MApp.Util.formatCurrency(bill.totalAmount)}</div>
        <div class="mb-card-sub" style="margin-top:4px;">${poRef}</div>
        <div class="mb-mt-2" style="display:flex; gap:var(--mb-sp-4);">
          <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" data-bill-action="edit" data-bill-index="${idx}">Edit</button>
          <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;color:var(--mb-enamel-red-ink);" data-bill-action="delete" data-bill-index="${idx}">Delete</button>
        </div>
      </div>`;
    }).join('') + MApp.Paging.moreHtml(page);

    listEl.querySelectorAll('[data-bill-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const bill = this.bills[Number(btn.dataset.billIndex)];
        if (!bill) return;
        if (btn.dataset.billAction === 'edit') this.openForm(bill);
        else this.deleteBillRecord(bill);
      });
    });

    MApp.Select.enable(listEl, page.rows, this.SELECT);
  },

  _printTitle(bill) {
    return `Bill_${bill.billNumber}_${String(bill.vendor || '').replace(/[^a-zA-Z0-9 \-]/g, '').trim().replace(/\s+/g, '_')}`;
  },

  documentActions(index) {
    const bill = this.bills[index];
    if (!bill) return;
    MApp.Print.chooseAction({
      containerId: 'print-bill-container',
      filename: this._printTitle(bill),
      title: `Bill ${bill.billNumber}`,
      populate: () => this._populatePrintData(bill)
    });
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
        <div class="mb-field" style="margin-bottom:var(--mb-sp-2);">
          <label>GST %</label>
          <input type="number" inputmode="decimal" min="0" step="0.01" value="${line.gst != null ? line.gst : 18}" oninput="MApp.Bill.updateLine(${i}, 'gst', this.value)">
        </div>
        ${this._poBadgeHtml(line, i)}
        ${this.lines.length > 1 ? `<button type="button" class="mb-btn-text mb-mt-2" style="padding:0;min-height:auto;color:var(--mb-enamel-red-ink);" onclick="MApp.Bill.removeLine(${i})">Remove</button>` : ''}
      </div>
    `).join('');
  },

  // Which PO this line draws down, and a tap to unlink it. Desktop shows
  // the same information as a badge per row; this is that, sized for a
  // phone. `manual` means the operator chose Direct and a later
  // suggestion must not silently overwrite that choice.
  _poBadgeHtml(line, i) {
    const allocs = line.allocs || [];
    const label = line.poManual || !allocs.length
      ? 'Direct — not against a PO'
      : allocs.map(a => (a.poNumber === 'DIRECT' ? 'Direct' : `PO-${a.poNumber}`) +
          (allocs.length > 1 ? ` (${MApp.Util.formatQty(a.qty)})` : '')).join(' + ');
    const linked = !line.poManual && allocs.length;
    return `
      <div class="mb-mt-2" style="display:flex; align-items:center; gap:var(--mb-sp-2); flex-wrap:wrap;">
        <span class="mb-chip ${linked ? 'mb-chip-inprogress' : ''}">${MApp.Util.escapeHtml(label)}</span>
        ${linked ? `<button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" onclick="MApp.Bill.unlinkPo(${i})">Unlink</button>` : ''}
      </div>`;
  },

  unlinkPo(i) {
    if (!this.lines[i]) return;
    this.lines[i].poManual = true;
    this.lines[i].allocs = [];
    this._renderLines();
  },

  _renderLines() {
    const el = document.getElementById('bill-form-lines');
    if (el) el.innerHTML = this._linesHtml();
  },

  // Asks the server which open PO lines each bill line most likely belongs
  // to, and records the answer on the lines.
  //
  // Without this, mobile sent no per-item `po` and no top-level
  // `poNumbers`, so bill_service.py defaulted every line to "DIRECT" --
  // a bill entered on the phone drew down no PO's pending quantity at
  // all. The auto-match is a convenience; the LINK is data, and it was
  // missing entirely.
  //
  // Advisory, exactly like desktop's: the server itself fails open and
  // returns an empty list rather than blocking bill entry, and so does
  // this.
  async matchPos() {
    const vendor = this.selection.vendor;
    const lines = this.lines.filter(l => l.name && l.qty > 0);
    if (!vendor || !lines.length) return;

    // rowIndex refers to the position in THIS payload, so it has to be
    // mapped back to the real line afterwards.
    const payload = lines.map((l, idx) => ({
      rowIndex: idx, name: l.name, size: l.size || '',
      unit: l.unit || 'Pcs', qty: l.qty, price: l.price || 0
    }));
    const billDate = document.getElementById('bill-form-date')?.value || MApp.Util.todayInputValue();

    let results = [];
    try {
      const res = await MApp.Api.call('suggestPoAllocations', vendor, payload, billDate);
      results = (res && res.success && res.data) ? res.data : [];
    } catch (err) {
      return; // offline or failing: leave the lines as they are
    }

    const byRow = {};
    results.forEach(r => { byRow[r.rowIndex] = r; });
    lines.forEach((line, idx) => {
      // Never overwrite a deliberate Unlink, even if a suggestion for
      // that line arrives afterwards -- the same rule desktop applies
      // with its `autoMatched === 'manual'` check.
      if (line.poManual) return;
      const result = byRow[idx];
      const allocs = (result && result.allocations || []).map(a => ({ poNumber: a.poNumber, qty: a.qty }));
      if (result && result.unmatchedQty > 0 && allocs.length) {
        allocs.push({ poNumber: 'DIRECT', qty: result.unmatchedQty });
      }
      line.allocs = allocs;
    });
    this._renderLines();
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

    // Settle the PO match before serialising. Desktop debounces this as
    // the operator types and flushes it at submit; on a phone, where the
    // form is short and the LAN is not, running it once here is the same
    // guarantee for one round trip instead of one per keystroke.
    await this.matchPos();

    const formData = {
      billNumber,
      billDate: document.getElementById('bill-form-date')?.value || MApp.Util.todayInputValue(),
      vendor: this.selection.vendor,
      contact: (document.getElementById('bill-form-contact')?.value || '').trim(),
      remarks: (document.getElementById('bill-form-remarks')?.value || '').trim(),
      // A line allocated across several POs stays ONE line on screen but
      // saveBill links one PO per item, so it is expanded into one item
      // per allocation here, at save time -- the same place desktop
      // expands it. A line with no allocation sends DIRECT explicitly
      // rather than relying on the server's default, so the payload says
      // what it means.
      items: JSON.stringify(validLines.flatMap(l => {
        const base = {
          name: l.name, size: l.size || '', narration: l.narration || '', unit: l.unit || 'Pcs',
          price: l.price || 0, gst: l.gst != null ? l.gst : 18
        };
        const allocs = l.poManual ? [] : (l.allocs || []);
        if (allocs.length > 1) return allocs.map(a => ({ ...base, qty: a.qty, po: a.poNumber }));
        return [{ ...base, qty: l.qty, po: allocs.length ? allocs[0].poNumber : 'DIRECT' }];
      }))
    };
    if (this.editingBillNumber) {
      formData.existingBillNumber = this.editingBillNumber;
      formData.existingVendor = this.editingBillVendor;
    }

    // Stock-correction conflict check, mirroring desktop's pre-save flow in
    // bill.js. Without this MApp sent no excludeFromStockKeys at all, which
    // bill_service.py reads as an empty set -- so every item on a
    // phone-entered bill hit Stock's Billed Qty even when the bill predates
    // a physical recount that already counted those goods. Silent double
    // counting, and exactly the kind of discrepancy a recount is meant to
    // resolve. Advisory: a failure here must never block the save, same as
    // desktop.
    formData.excludeFromStockKeys = '[]';
    try {
      // The RPC wants the item array itself, not formData.items' JSON string.
      const conflictItems = validLines.map(l => ({ name: l.name, size: l.size || '' }));
      const conflictRes = await MApp.Api.call('checkStockAdjustmentConflicts', conflictItems, formData.billDate);
      if (conflictRes && conflictRes.success && conflictRes.data && conflictRes.data.length) {
        const choice = await this.showStockConflictChoice(conflictRes.data);
        if (choice === 'cancel') return;
        if (choice === 'ledger') {
          formData.excludeFromStockKeys = JSON.stringify(
            conflictRes.data.map(c => `${c.itemName}|${c.size || ''}`.trim().toLowerCase())
          );
        }
      }
    } catch (err) {
      /* advisory only -- fall through and save with excludeFromStockKeys '[]' */
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

  // Resolves to 'update' (bill hits Stock normally), 'ledger' (saved but
  // excluded from Stock's Billed Qty sum) or 'cancel' (abort the save).
  // Dismissing the sheet -- X, Back or Escape -- means cancel: the safe
  // default when the operator did not actively choose.
  _stockConflictResolve: null,

  showStockConflictChoice(conflicts) {
    const listEl = document.getElementById('bill-stock-conflict-list');
    if (listEl) {
      listEl.innerHTML = conflicts.map(c => `
        <div class="mb-card">
          <div class="mb-card-title">${MApp.Util.escapeHtml(c.itemName)}${c.size ? ` <span class="mb-card-sub">(${MApp.Util.escapeHtml(c.size)})</span>` : ''}</div>
          <div class="mb-card-sub">Recounted ${MApp.Util.escapeHtml(MApp.Util.formatDateDisplay(c.adjustmentDate))}${c.reason ? ` — ${MApp.Util.escapeHtml(c.reason)}` : ''}</div>
        </div>`).join('');
    }
    return new Promise(resolve => {
      this._stockConflictResolve = resolve;
      MApp.Sheet.open('sheet-bill-stock-conflict', {
        onDismiss: () => this.resolveStockConflict('cancel')
      });
    });
  },

  resolveStockConflict(choice) {
    MApp.Sheet.close('sheet-bill-stock-conflict');
    const resolve = this._stockConflictResolve;
    this._stockConflictResolve = null;
    if (resolve) resolve(choice);
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
  SELECT: {
    key: 'issue', noun: 'issue record', plural: 'issue records',
    method: 'deleteIssueBulk',
    payload: rows => [rows.map(r => r.issueId)],
    onDone: () => MApp.Issue.open()
  },

  // issuedTo and item names were already searchable; size and narration are
  // what distinguishes two issues of the same part.
  SEARCH: {
    fields: [
      { key: 'issuedTo', weight: 9, label: 'Issued to' },
      { key: 'items', weight: 8, label: 'Item', get: r => (r.items || []).map(i => i && i.name) },
      { key: 'sizes', weight: 4, label: 'Size', get: r => (r.items || []).map(i => i && i.size) },
      { key: 'remarks', weight: 3, label: 'Remarks' },
      { key: 'date', weight: 2, label: 'Date', get: r => MApp.Util.formatDateDisplay(r.dateRaw) }
    ]
  },

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
    MApp.SearchBox.attach('issue-log-search', term => this.onSearch(term));
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
    MApp.Paging.reset('issue');
    this.searchTerm = String(term || '').trim().toLowerCase();
    this._applyFilters();
  },

  _applyFilters() {
    this.filtered = MApp.Search.run(MApp.Search.index(this.records, this.SEARCH), this.searchTerm);
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

    const page = MApp.Paging.take('issue', this.filtered, () => this.render());
    MApp.SearchBox.setCount('issue-log-search', page.shown, page.total, page.meta);
    listEl.innerHTML = page.rows.map((r, i) => {
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
        <div class="mb-mt-2" style="display:flex; gap:var(--mb-sp-4);">
          <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" data-issue-action="edit" data-issue-index="${i}">Edit</button>
          <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;color:var(--mb-enamel-red-ink);" data-issue-action="delete" data-issue-index="${i}">Delete</button>
        </div>
      </div>`;
    }).join('') + MApp.Paging.moreHtml(page);

    listEl.querySelectorAll('[data-issue-index]').forEach(btn => {
      btn.addEventListener('click', () => {
        // page.rows, not this.filtered: the indices were emitted while
        // mapping the paged array. The two share a prefix today, which is
        // not a property worth resting Edit and Delete on.
        const record = page.rows[Number(btn.dataset.issueIndex)];
        if (!record) return;
        if (btn.dataset.issueAction === 'edit') this.openForm(record);
        else this.deleteIssue(record);
      });
    });

    MApp.Select.enable(listEl, page.rows, this.SELECT);
  },

  // `record` opens the form in edit mode. saveIssueStock has accepted
  // existingIssueId since it was written -- the server could edit and the
  // screen could not, so correcting a mistyped issue meant deleting the
  // record and retyping it.
  async openForm(record) {
    this.editingIssueId = record ? record.issueId : null;
    this.lines = record && (record.items || []).length
      ? record.items.map(it => ({
        name: it.name || '', size: it.size || '', unit: it.unit || 'Pcs',
        qty: it.qty, rate: it.rate || ''
      }))
      : [{ name: '', size: '', unit: 'Pcs', qty: '', rate: '' }];
    this._editingRecord = record || null;

    const titleEl = document.querySelector('#sheet-issue-form h2');
    if (titleEl) titleEl.textContent = record ? 'Edit Issue' : 'Log Issue';
    const saveLabel = document.getElementById('issue-form-save-btn');
    if (saveLabel) saveLabel.textContent = record ? 'Save Changes' : 'Log Issue';

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
    // Values come from _editingRecord in edit mode and are blank on
    // create, so one template serves both.
    const r = this._editingRecord || {};
    const v = s => MApp.Util.escapeHtml(s == null ? '' : String(s));
    const date = r.dateRaw ? String(r.dateRaw).slice(0, 10) : MApp.Util.todayInputValue();
    return `
      <div class="mb-field">
        <label for="issue-form-date">Date</label>
        <input type="date" id="issue-form-date" value="${v(date)}">
      </div>
      <div class="mb-field">
        <label for="issue-form-issuedto">Issued To</label>
        <input type="text" id="issue-form-issuedto" placeholder="Contractor or person name" value="${v(r.issuedTo)}">
      </div>
      <div class="mb-field">
        <label for="issue-form-reference">Reference (optional)</label>
        <input type="text" id="issue-form-reference" placeholder="e.g. Production Lot #" value="${v(r.reference)}">
      </div>

      <div class="mapp-section-label">Items</div>
      <div id="issue-form-lines">${this._linesHtml()}</div>
      <button type="button" class="mb-btn mb-btn-secondary mb-mt-2 mb-mb-4" onclick="MApp.Issue.addLine()">+ Add Item</button>

      <div class="mb-field">
        <label for="issue-form-remarks">Remarks (optional)</label>
        <textarea id="issue-form-remarks" rows="3">${v(r.remarks)}</textarea>
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
        ${this.lines.length > 1 ? `<button type="button" class="mb-btn-text mb-mt-2" style="padding:0;min-height:auto;color:var(--mb-enamel-red-ink);" onclick="MApp.Issue.removeLine(${i})">Remove</button>` : ''}
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
    // The issueId itself never changes on edit -- it has no override
    // field, same as on create (see issue_service.py).
    if (this.editingIssueId) formData.existingIssueId = this.editingIssueId;

    const isEdit = !!this.editingIssueId;
    const saveBtn = document.getElementById('issue-form-save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

    const res = await MApp.Util.mutateSimple(
      'saveIssueStock', [formData], isEdit ? 'Issue updated.' : 'Stock issue logged.'
    );
    if (res.success) {
      this.closeForm();
      this.open();
      return;
    }
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = isEdit ? 'Save Changes' : 'Log Issue'; }
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
  SELECT: {
    key: 'wastage', noun: 'wastage record', plural: 'wastage records',
    method: 'deleteWastageBulk',
    payload: rows => [rows.map(r => r.wastageId)],
    onDone: () => MApp.Wastage.open()
  },

  // Same shape as the issue log: vendor plus the items on the record.
  SEARCH: {
    fields: [
      { key: 'vendor', weight: 9, label: 'Vendor' },
      { key: 'items', weight: 8, label: 'Item', get: r => (r.items || []).map(i => i && i.name) },
      { key: 'sizes', weight: 4, label: 'Size', get: r => (r.items || []).map(i => i && i.size) },
      { key: 'remarks', weight: 3, label: 'Remarks' },
      { key: 'date', weight: 2, label: 'Date', get: r => MApp.Util.formatDateDisplay(r.dateRaw) }
    ]
  },

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
    MApp.SearchBox.attach('wastage-log-search', term => this.onSearch(term));
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
    MApp.Paging.reset('wastage');
    this.searchTerm = String(term || '').trim().toLowerCase();
    this._applyFilters();
  },

  _applyFilters() {
    this.filtered = MApp.Search.run(MApp.Search.index(this.records, this.SEARCH), this.searchTerm);
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

    const page = MApp.Paging.take('wastage', this.filtered, () => this.render());
    MApp.SearchBox.setCount('wastage-log-search', page.shown, page.total, page.meta);
    listEl.innerHTML = page.rows.map((r, i) => {
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
        <div class="mb-mt-2" style="display:flex; gap:var(--mb-sp-4);">
          <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" data-wastage-action="edit" data-wastage-index="${i}">Edit</button>
          <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;color:var(--mb-enamel-red-ink);" data-wastage-action="delete" data-wastage-index="${i}">Delete</button>
        </div>
      </div>`;
    }).join('') + MApp.Paging.moreHtml(page);

    listEl.querySelectorAll('[data-wastage-index]').forEach(btn => {
      btn.addEventListener('click', () => {
        // page.rows, not this.filtered -- the indices were emitted while
        // mapping the paged array.
        const record = page.rows[Number(btn.dataset.wastageIndex)];
        if (!record) return;
        if (btn.dataset.wastageAction === 'edit') this.openForm(record);
        else this.deleteWastage(record);
      });
    });

    MApp.Select.enable(listEl, page.rows, this.SELECT);
  },

  // Same shape as MApp.Issue: saveWastage has accepted existingWastageId
  // since it was written (it folds the source's separate edit RPC into
  // one optional field), so the server could edit a wastage record while
  // the screen could only delete and retype it.
  async openForm(record) {
    this.editingWastageId = record ? record.wastageId : null;
    this._editingRecord = record || null;
    this.lines = record && (record.items || []).length
      ? record.items.map(it => ({
        name: it.name || '', size: it.size || '', unit: it.unit || 'Pcs',
        qty: it.qty, reason: it.reason || ''
      }))
      : [{ name: '', size: '', unit: 'Pcs', qty: '', reason: '' }];

    const titleEl = document.querySelector('#sheet-wastage-form h2');
    if (titleEl) titleEl.textContent = record ? 'Edit Wastage' : 'Log Wastage';
    const label = document.getElementById('wastage-form-save-btn');
    if (label) label.textContent = record ? 'Save Changes' : 'Log Wastage';

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
    // One template serves create and edit; values are blank on create.
    const r = this._editingRecord || {};
    const v = x => MApp.Util.escapeHtml(x == null ? '' : String(x));
    const date = r.dateRaw ? String(r.dateRaw).slice(0, 10) : MApp.Util.todayInputValue();
    return `
      <div class="mb-field">
        <label for="wastage-form-date">Date</label>
        <input type="date" id="wastage-form-date" value="${v(date)}">
      </div>
      <div class="mb-field">
        <label for="wastage-form-vendor">Vendor (optional)</label>
        <input type="text" id="wastage-form-vendor" value="${v(r.vendor)}">
      </div>

      <div class="mapp-section-label">Items</div>
      <div id="wastage-form-lines">${this._linesHtml()}</div>
      <button type="button" class="mb-btn mb-btn-secondary mb-mt-2 mb-mb-4" onclick="MApp.Wastage.addLine()">+ Add Item</button>

      <div class="mb-field">
        <label for="wastage-form-remarks">Remarks (optional)</label>
        <textarea id="wastage-form-remarks" rows="3">${v(r.remarks)}</textarea>
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
        ${this.lines.length > 1 ? `<button type="button" class="mb-btn-text mb-mt-2" style="padding:0;min-height:auto;color:var(--mb-enamel-red-ink);" onclick="MApp.Wastage.removeLine(${i})">Remove</button>` : ''}
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
    if (this.editingWastageId) formData.existingWastageId = this.editingWastageId;

    const isEdit = !!this.editingWastageId;
    const saveBtn = document.getElementById('wastage-form-save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

    const res = await MApp.Util.mutateSimple(
      'saveWastage', [formData], isEdit ? 'Wastage updated.' : 'Wastage logged.'
    );
    if (res.success) {
      this.closeForm();
      this.open();
      return;
    }
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = isEdit ? 'Save Changes' : 'Log Wastage'; }
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
  // deleteItemsBulk keys on {name, size} and skips anything still in
  // use server-side, so a selection that includes a referenced item
  // deletes the rest and reports the skip rather than failing whole.
  SELECT: {
    key: 'items', noun: 'item', plural: 'items',
    method: 'deleteItemsBulk',
    payload: rows => [rows.map(r => ({ name: r.name, size: r.size || '' }))],
    onDone: () => MApp.Items.openLookupSheet()
  },

  // Unit and stock group widen a lookup that previously only saw name,
  // size and narration.
  SEARCH: {
    fields: [
      { key: 'name', weight: 10, label: 'Item' },
      { key: 'size', weight: 6, label: 'Size' },
      { key: 'narration', weight: 4, label: 'Narration' },
      { key: 'baseUnit', weight: 2, label: 'Unit' },
      { key: 'stockGroup', weight: 2, label: 'Group' }
    ]
  },

  items: [],
  filtered: [],
  editingItem: null,
  vendorRows: [],
  photoBase64: null,

  async openLookupSheet() {
    const listEl = document.getElementById('items-lookup-list');
    const searchInput = document.getElementById('items-lookup-search');
    if (searchInput) searchInput.value = '';
    this.searchTerm = '';
    MApp.SearchBox.attach('items-lookup-search', term => this.onSearch(term));
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
    MApp.Paging.reset('items');
    this.searchTerm = term || '';
    this.filtered = MApp.Search.run(MApp.Search.index(this.items, this.SEARCH), this.searchTerm);
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
    const page = MApp.Paging.take('items', this.filtered, () => this.render());
    MApp.SearchBox.setCount('items-lookup-search', page.shown, page.total, page.meta);
    listEl.innerHTML = page.rows.map((it, i) => `
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
        <div class="mb-mt-2" style="display:flex; gap:var(--mb-sp-4);">
          <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" data-item-action="edit" data-edit-item="${i}">Edit</button>
          <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" data-item-action="processes" data-edit-item="${i}">Used in</button>
        </div>
      </div>
    `).join('') + MApp.Paging.moreHtml(page);

    listEl.querySelectorAll('[data-edit-item]').forEach(btn => {
      btn.addEventListener('click', () => {
        // page.rows, not this.filtered -- the indices were emitted while
        // mapping the paged array.
        const item = page.rows[Number(btn.dataset.editItem)];
        if (!item) return;
        if (btn.dataset.itemAction === 'processes') MApp.ItemProcesses.open(item);
        else this.openForm(item);
      });
    });

    MApp.Select.enable(listEl, page.rows, this.SELECT);
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
        <button type="button" class="mb-btn-text mb-mt-2" style="padding:0;min-height:auto;color:var(--mb-enamel-red-ink);" onclick="MApp.Items.removeVendorRow(${i})">Remove</button>
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
  // Address was not searchable, so a vendor could not be found by the town
  // they are in -- which is often all anyone remembers.
  SEARCH: {
    fields: [
      { key: 'name', weight: 10, label: 'Name' },
      { key: 'contact', weight: 6, label: 'Contact' },
      { key: 'address', weight: 3, label: 'Address' },
      { key: 'gstin', weight: 3, label: 'GSTIN' }
    ]
  },

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
    MApp.SearchBox.attach('directory-search', term => this.onSearch(term));
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

      // Contractors only, and after the list is already on screen: the
      // overview is a nicety and must never delay the thing it sits above.
      if (type === 'contractor') {
        const html = await MApp.ContractorDetail.overviewHtml();
        const listEl = document.getElementById('directory-list');
        if (html && listEl && this.type === 'contractor') {
          listEl.insertAdjacentHTML('afterbegin', html);
        }
      }
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

  // One sheet serves vendors, clients and contractors, so unlike every
  // other screen's static SELECT this one is built per open(): the bulk
  // method and the noun both depend on which type is showing. All three
  // RPCs take a plain array of names, which is what deleteVendor /
  // deleteClient / deleteContractor already send for one.
  BULK_METHODS: {
    vendor: 'deleteVendorsBulk',
    client: 'deleteClientsBulk',
    contractor: 'deleteContractorsBulk'
  },

  _selectConfig() {
    const cfg = this.CONFIGS[this.type] || {};
    const singular = (cfg.title || 'entry').replace(/s$/, '').toLowerCase();
    return {
      key: 'directory-' + this.type,
      noun: singular,
      plural: singular + 's',
      method: this.BULK_METHODS[this.type],
      payload: rows => [rows.map(r => r.name)],
      onDone: () => MApp.Directory.open(MApp.Directory.type)
    };
  },

  close() {
    MApp.Sheet.close('sheet-directory');
  },

  onSearch(term) {
    MApp.Paging.reset('directory');
    this.searchTerm = term || '';
    this.filtered = MApp.Search.run(MApp.Search.index(this.items, this.SEARCH), this.searchTerm);
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

    const page = MApp.Paging.take('directory', this.filtered, () => this.render());
    MApp.SearchBox.setCount('directory-search', page.shown, page.total, page.meta);
    listEl.innerHTML = page.rows.map(e => {
      const contactHtml = e.contact
        ? `<a href="tel:${MApp.Util.escapeHtml(e.contact)}" onclick="event.stopPropagation()">${MApp.Util.escapeHtml(e.contact)}</a>`
        : 'No contact on file';
      // Contractors get 2 extra quick-add actions (Rate/Payment) alongside
      // Edit; Vendors/Clients just get Edit. Kept as separate <button>s
      // (not a tappable card) so nothing here nests interactive content.
      const actions = this.type === 'contractor'
        // "Account" leads, because reading the balance is what an
        // operator opens a contractor for -- and until now it was the one
        // thing they could not do. The three quick-adds stay, but the
        // detail sheet offers them too, alongside what they produced.
        ? [['account', 'Account'], ['edit', 'Edit'], ['rate', '+ Rate'], ['charge', '+ Charge'], ['payment', '+ Payment']]
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
    }).join('') + MApp.Paging.moreHtml(page);

    MApp.Select.enable(listEl, page.rows, this._selectConfig());

    listEl.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const record = this.filtered.find(x => x.name === btn.dataset.name);
        if (!record) return;
        if (btn.dataset.action === 'account') MApp.ContractorDetail.open(record.name);
        else if (btn.dataset.action === 'edit') this.openForm(record);
        else if (btn.dataset.action === 'rate') this.openRateSheet(record.name);
        else if (btn.dataset.action === 'charge') this.openExtraChargeSheet(record.name);
        else if (btn.dataset.action === 'payment') this.openPaymentSheet(record.name);
      });
    });
  },

  // ── Add/Edit (Phase 1) ──────────────────────────────────────────────
  // The MApp.Form spec for whichever directory type is showing. `type`
  // per field is what finally gives the contact field a phone keypad:
  // it was type="text" on a card advertised as tap-to-call, while 24
  // numeric fields elsewhere in the app already carried inputmode.
  formSpec() {
    const cfg = this.CONFIGS[this.type] || { fields: [] };
    const singular = (cfg.title || 'Entry').replace(/s$/, '');
    const TYPE_BY_KEY = { contact: 'tel', email: 'email' };
    return {
      id: 'entity-form',
      fields: [
        { key: 'name', label: `${singular} Name`, type: 'text', required: true }
      ].concat((cfg.fields || []).map(f => ({
        key: f.key,
        label: f.label,
        type: f.multiline ? 'multiline' : (TYPE_BY_KEY[f.key] || 'text')
      })))
    };
  },

  openForm(record) {
    const cfg = this.CONFIGS[this.type];
    if (!cfg) return;
    this.editingRecord = record || null;
    const singular = cfg.title.replace(/s$/, '');

    const titleEl = document.getElementById('entity-form-title');
    if (titleEl) titleEl.textContent = record ? `Edit ${singular}` : `Add ${singular}`;

    MApp.Form.render('entity-form-body', this.formSpec(), record || {});

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
    const spec = this.formSpec();
    const values = MApp.Form.read(spec);
    // Marks the field, keeps the message there, and scrolls to it -- the
    // toast this replaced said "Enter a vendor name." at the bottom of the
    // screen and was gone before a gloved operator had finished reading it.
    if (!MApp.Form.validate(spec, values)) return;

    const formData = { [cfg.nameFormKey]: values.name };
    cfg.fields.forEach(f => { formData[f.key] = values[f.key] || ''; });
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
// CUSTOM ROLES (Admin) — who can see and change which tab.
//
// The plan filed this as "read-only + handoff", on the assumption that a
// permissions editor is a desktop job. Reading the contract says
// otherwise: a role is a name plus eleven tabs each set to one of three
// levels. That is a list of eleven rows with a three-way choice, which
// is a shape a phone is good at -- and it is the same segmented control
// already used for the theme.
//
// The levels and the tab list are the server's, mirrored here rather
// than invented: _validate_permissions rejects an unknown tab or level
// outright, so a picker offering anything else would be offering a save
// that bounces.
// ================================================================
MApp.Roles = {
  TABS: [
    ['vendorMaster', 'Vendors'],
    ['itemMaster', 'Items Master'],
    ['poLedger', 'Purchase Orders'],
    ['billLedger', 'Bill Ledger'],
    ['returnLedger', 'Returns'],
    ['stockTab', 'Stock'],
    ['productsTab', 'Products & Processes'],
    ['contractorsTab', 'Contractors'],
    ['productionTab', 'Production'],
    ['clientsTab', 'Clients'],
    ['dispatchTab', 'Dispatch']
  ],
  LEVELS: [
    ['none', 'No access'],
    ['viewer', 'View'],
    ['commenter', 'Comment'],
    ['editor', 'Edit']
  ],

  roles: [],
  editing: null,
  draft: null,

  async open() {
    const listEl = document.getElementById('roles-list');
    MApp.Util.renderSkeleton(listEl, 3);
    MApp.Sheet.open('sheet-roles');
    await this.load();
  },

  close() { MApp.Sheet.close('sheet-roles'); },

  async load() {
    const listEl = document.getElementById('roles-list');
    if (!listEl) return;
    try {
      const res = await MApp.Api.call('getCustomRoles');
      if (!res || !res.success) {
        MApp.Util.renderError(listEl, res && res.message, () => this.load());
        return;
      }
      this.roles = res.data || [];
      this.render();
    } catch (err) {
      MApp.Util.renderError(listEl, err && err.message, () => this.load());
    }
  },

  render() {
    const listEl = document.getElementById('roles-list');
    if (!listEl) return;

    if (this.roles.length === 0) {
      MApp.Util.renderEmpty(listEl, {
        title: 'No custom roles',
        body: 'Admin and Super Admin are built in. Tap Add to define a role between them.'
      });
      return;
    }

    listEl.innerHTML = this.roles.map((r, i) => {
      const granted = Object.values(r.permissions || {}).filter(v => v && v !== 'none').length;
      return `
      <div class="mb-card">
        <div class="mb-card-row">
          <div>
            <div class="mb-card-title">${MApp.Util.escapeHtml(r.roleName)}</div>
            <div class="mb-card-sub">${granted} of ${this.TABS.length} tabs</div>
          </div>
          <div style="text-align:right;">
            <div class="mb-card-number">${r.userCount}</div>
            <div class="mb-card-sub">${r.userCount === 1 ? 'user' : 'users'}</div>
          </div>
        </div>
        <div class="mb-mt-2" style="display:flex; gap:var(--mb-sp-4);">
          <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" data-role-action="edit" data-role-index="${i}">Edit</button>
          <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;color:var(--mb-enamel-red-ink);" data-role-action="delete" data-role-index="${i}">Delete</button>
        </div>
      </div>`;
    }).join('');

    listEl.querySelectorAll('[data-role-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const role = this.roles[Number(btn.dataset.roleIndex)];
        if (!role) return;
        if (btn.dataset.roleAction === 'edit') this.openForm(role);
        else this.remove(role);
      });
    });
  },

  openForm(role) {
    this.editing = role || null;
    // A tab absent from permissions means no access. Kept as an explicit
    // 'none' in the draft so every row has a selected state, then
    // stripped again on save -- the server rejects 'none' as a level.
    this.draft = {};
    this.TABS.forEach(([key]) => {
      const level = (role && role.permissions && role.permissions[key]) || 'none';
      this.draft[key] = level;
    });

    const titleEl = document.getElementById('role-form-title');
    if (titleEl) titleEl.textContent = role ? `Edit ${role.roleName}` : 'New role';
    const nameEl = document.getElementById('role-form-name');
    if (nameEl) {
      nameEl.value = role ? role.roleName : '';
      // The key is derived from the name server-side and is what users
      // are stored against, so renaming an existing role is not offered
      // here rather than silently doing nothing.
      nameEl.disabled = !!role;
    }

    this.renderPermissions();
    MApp.Sheet.open('sheet-role-form');
  },

  closeForm() { MApp.Sheet.close('sheet-role-form'); },

  renderPermissions() {
    const body = document.getElementById('role-form-permissions');
    if (!body) return;
    body.innerHTML = this.TABS.map(([key, label]) => `
      <div class="mb-field">
        <label>${MApp.Util.escapeHtml(label)}</label>
        <div class="mb-segmented" role="tablist" aria-label="${MApp.Util.escapeHtml(label)} access">
          ${this.LEVELS.map(([level, text]) => `
            <button type="button" role="tab" data-role-tab="${key}" data-role-level="${level}"
                    aria-selected="${this.draft[key] === level ? 'true' : 'false'}">${text}</button>`).join('')}
        </div>
      </div>`).join('');

    body.querySelectorAll('[data-role-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.draft[btn.dataset.roleTab] = btn.dataset.roleLevel;
        this.renderPermissions();
      });
    });
  },

  async save() {
    const name = String(document.getElementById('role-form-name')?.value || '').trim();
    if (!this.editing && !name) {
      MApp.Toast.error('Give the role a name.');
      return;
    }

    // 'none' is this screen's word for "not granted", not the server's --
    // _validate_permissions rejects it as a level. An absent key is how
    // no-access is actually expressed.
    const permissions = {};
    Object.entries(this.draft).forEach(([key, level]) => {
      if (level && level !== 'none') permissions[key] = level;
    });

    const btn = document.getElementById('role-form-save-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    const res = this.editing
      ? await MApp.Util.mutateSimple('updateCustomRole', [this.editing.roleKey, this.editing.roleName, permissions], null)
      : await MApp.Util.mutateSimple('createCustomRole', [name, permissions], null);
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
    if (!res.success) return;

    MApp.Toast.success(res.message || 'Role saved.');
    this.closeForm();
    this.load();
  },

  async remove(role) {
    // The server refuses while the role is still assigned and says how
    // many hold it. Nothing is pre-judged here, but a role with users on
    // it is worth warning about before the round trip.
    const warning = role.userCount > 0
      ? ` ${role.userCount} user(s) still hold it, so this will be refused until they are reassigned.`
      : '';
    if (!window.confirm(`Delete the role “${role.roleName}”?${warning}`)) return;

    const res = await MApp.Util.mutateSimple('deleteCustomRole', [role.roleKey], null);
    if (res.success) {
      MApp.Toast.success(res.message || 'Role deleted.');
      this.load();
    }
  }
};
// ================================================================
// ADMIN — USERS & ROLES (Phase 4, minimal v1). Entry point is Jinja-
// gated (mobile_views.html's More tab, {% if current_user.is_admin %}),
// but every RPC here is independently enforced server-side regardless
// (roles=frozenset({"admin"}) in app/erp/rpc.py) -- that Jinja gate is
// UX only, same as desktop's own. This sheet ASSIGNS a role; defining
// one is MApp.Roles above it. That editor was filed as desktop-only on
// the assumption a permissions matrix needs a desktop -- reading the
// contract said otherwise: a role is a name plus eleven tabs at one of
// three levels, which is eleven rows with a three-way choice.
// ================================================================
MApp.Admin = {
  // bulkDeactivateUsers SKIPS rather than refuses two kinds of account --
  // the caller's own, and any other super_admin -- so a select-all that
  // catches either still deactivates the rest and says what it left. The
  // server message carries that, which is why none is supplied here.
  SELECT: {
    key: 'adminUsers', noun: 'user', plural: 'users',
    method: 'bulkDeactivateUsers',
    verb: 'Deactivate',
    pastTense: 'deactivated',
    note: 'They can be reactivated afterwards; nothing they recorded is removed.',
    payload: rows => [rows.map(u => u.id)],
    onDone: () => MApp.Admin.open()
  },

  // Role is searchable so an admin can list everyone with a given role by
  // typing it, which previously needed a scroll through the whole list.
  SEARCH: {
    fields: [
      { key: 'name', weight: 10, label: 'Name' },
      { key: 'email', weight: 8, label: 'Email' },
      { key: 'role', weight: 5, label: 'Role', get: u => MApp.Admin._roleLabel(u.role) },
      { key: 'status', weight: 3, label: 'Status', get: u => (u.isActive ? 'active' : 'inactive') }
    ]
  },

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
    MApp.SearchBox.attach('admin-users-search', term => this.onSearch(term));
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
    MApp.Paging.reset('admin');
    this.searchTerm = String(term || '').trim().toLowerCase();
    this._applyFilters();
  },

  _applyFilters() {
    this.filtered = MApp.Search.run(MApp.Search.index(this.users, this.SEARCH), this.searchTerm);
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

    const page = MApp.Paging.take('admin', this.filtered, () => this.render());
    MApp.SearchBox.setCount('admin-users-search', page.shown, page.total, page.meta);
    listEl.innerHTML = page.rows.map((u, i) => {
      const isSelf = u.email.toLowerCase() === myEmail;
      const actions = isSelf ? '<div class="mb-mt-2 mb-text-sm mb-text-steel">This is you</div>' : `
        <div class="mb-mt-2" style="display:flex; gap:var(--mb-sp-4);">
          <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" data-admin-action="role" data-admin-index="${i}">Change Role</button>
          <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;${u.active ? 'color:var(--mb-enamel-red-ink);' : ''}" data-admin-action="${u.active ? 'deactivate' : 'reactivate'}" data-admin-index="${i}">${u.active ? 'Deactivate' : 'Reactivate'}</button>
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
    }).join('') + MApp.Paging.moreHtml(page);

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

    // Deactivating is reversible and the server skips what it must not
    // touch, so this is the one bulk action here that is safe to offer.
    MApp.Select.enable(listEl, page.rows, this.SELECT);
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
// REORDER — move one row up or down in a sequence.
//
// reorderProcesses and reorderBOM both take the WHOLE ordered list and
// renumber sequence = position in it. That is the trap this module
// exists to close: sending the visible page, or a search's matches,
// renumbers those rows and silently leaves every other row's sequence
// pointing at the old arrangement. Process sequence decides what the
// Log Lot cascade offers next, so a wrong one is not cosmetic.
//
// So a move always recomputes against the full list, and is not offered
// at all while a search is narrowing it -- with three of forty rows on
// screen, "up" has no answer the operator would predict.
// ================================================================
MApp.Reorder = {
  // The list with `index` moved by `delta`, or null when that would fall
  // off either end. Returns a new array; the caller keeps the old one
  // until the server agrees.
  moved(list, index, delta) {
    const to = index + delta;
    if (!Array.isArray(list) || index < 0 || index >= list.length) return null;
    if (to < 0 || to >= list.length) return null;
    const next = list.slice();
    const [row] = next.splice(index, 1);
    next.splice(to, 0, row);
    return next;
  },

  // Up/down controls for one card. Rendered only when the list is whole:
  // `disabled` at the ends rather than hidden, so the row does not change
  // width as it travels.
  controlsHtml(action, index, total) {
    const btn = (delta, label, path) => `
      <button type="button" class="mb-btn-text mapp-reorder-btn"
              data-${action}="${index}" data-reorder-delta="${delta}"
              aria-label="${label}"
              ${(delta < 0 && index === 0) || (delta > 0 && index === total - 1) ? 'disabled' : ''}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
             stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>
      </button>`;
    return `
      <span class="mapp-reorder">
        ${btn(-1, 'Move up', '<path d="M18 15l-6-6-6 6"/>')}
        ${btn(1, 'Move down', '<path d="M6 9l6 6 6-6"/>')}
      </span>`;
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
  SELECT: {
    key: 'process', noun: 'process', plural: 'processes',
    method: 'deleteProcessesBulk',
    payload: rows => [rows.map(r => r.processId)],
    onDone: () => MApp.Process.open()
  },

  // Process type and the output item's size/model are how a process is
  // actually described on the floor.
  SEARCH: {
    fields: [
      { key: 'processName', weight: 10, label: 'Process' },
      { key: 'outputItemName', weight: 7, label: 'Output' },
      { key: 'processType', weight: 5, label: 'Type' },
      { key: 'processId', weight: 4, label: 'ID' }
    ]
  },

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
    MApp.SearchBox.attach('process-list-search', term => this.onSearch(term));
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
    MApp.Paging.reset('process');
    this.searchTerm = String(term || '').trim().toLowerCase();
    this._applyFilters();
  },

  _applyFilters() {
    this.filtered = MApp.Search.run(MApp.Search.index(this.processes, this.SEARCH), this.searchTerm);
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

    const page = MApp.Paging.take('process', this.filtered, () => this.render());
    MApp.SearchBox.setCount('process-list-search', page.shown, page.total, page.meta);
    // Only when the list is whole. reorderProcesses renumbers by position
    // in the array it is sent, so a move computed from a search's matches
    // would renumber those and leave every other process pointing at the
    // old order -- and process sequence is what the Log Lot cascade reads.
    const reorderable = !this.searchTerm.trim();
    listEl.innerHTML = page.rows.map((p, i) => `
      <div class="mb-card">
        <div class="mb-card-row">
          <div>
            <div class="mb-card-title">${MApp.Util.escapeHtml(p.processName)}</div>
            <div class="mb-card-sub">${MApp.Util.escapeHtml(p.outputItemName || '')}</div>
          </div>
          <div style="text-align:right;">
            <div class="mb-card-sub">Stage ${MApp.Util.escapeHtml(String(p.sequence))}</div>
            <div class="mb-card-sub">${MApp.Util.escapeHtml(p.lotPrefix || '')}</div>
            ${reorderable ? MApp.Reorder.controlsHtml('process-move', this.processes.indexOf(p), this.processes.length) : ''}
          </div>
        </div>
        ${!p.active ? '<div class="mb-mt-2"><span class="mb-chip mb-chip-cancelled">Inactive</span></div>' : ''}
        <div class="mb-mt-2" style="display:flex; gap:var(--mb-sp-4);">
          <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" data-process-action="edit" data-process-index="${i}">Edit</button>
          <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" data-process-action="wip" data-process-index="${i}">Availability</button>
          <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" data-process-action="colors" data-process-index="${i}">Colours</button>
        </div>
        <div class="mb-card-sub mb-mt-2" id="process-wip-${i}" hidden></div>
      </div>`).join('') + MApp.Paging.moreHtml(page);

    listEl.querySelectorAll('[data-process-index]').forEach(btn => {
      btn.addEventListener('click', () => {
        // page.rows, not this.filtered -- indices come from the paged map.
        const process = page.rows[Number(btn.dataset.processIndex)];
        if (!process) return;
        if (btn.dataset.processAction === 'wip') this.showWip(process, Number(btn.dataset.processIndex));
        else if (btn.dataset.processAction === 'colors') MApp.ProcessColors.open(process);
        else this.openForm(process);
      });
    });

    listEl.querySelectorAll('[data-process-move]').forEach(btn => {
      btn.addEventListener('click', e => {
        // Stops the card's own long-press selection claiming the tap.
        e.stopPropagation();
        this.move(Number(btn.dataset.processMove), Number(btn.dataset.reorderDelta));
      });
    });

    MApp.Select.enable(listEl, page.rows, this.SELECT);
  },

  // Sends the WHOLE order, because that is what the server renumbers
  // from. The local list is only rebuilt once the server has agreed: a
  // failed reorder that left the screen rearranged would show an
  // ordering the lot numbers do not follow.
  async move(index, delta) {
    const next = MApp.Reorder.moved(this.processes, index, delta);
    if (!next) return;

    const res = await MApp.Util.mutateSimple(
      'reorderProcesses', [next.map(p => p.processId)], null
    );
    if (!res.success) return;

    MApp.Toast.success(res.message || 'Process order updated.');
    MApp.Haptics.light();
    this.load();
  },

  // What is actually available in the pool for this process's inputs.
  // Answers "can I run this now?" at the racks, which previously meant
  // opening the pool on a desktop and reading it against the recipe by
  // hand. Toggles inline rather than opening a sheet -- it is a glance,
  // not a screen.
  async showWip(process, idx) {
    const el = document.getElementById('process-wip-' + idx);
    if (!el) return;
    if (!el.hidden) { el.hidden = true; return; }

    el.hidden = false;
    el.textContent = 'Checking availability…';
    try {
      const res = await MApp.Api.call('getProcessWipData', process.processId);
      if (!res || !res.success) {
        el.textContent = (res && res.message) || "Couldn't load availability.";
        return;
      }
      const rows = res.data || [];
      if (!rows.length) {
        el.textContent = 'No pool-sourced inputs on this process.';
        return;
      }
      // A null availableQty is "no pool bucket for this input", which is
      // not the same as zero and must not read as it.
      el.innerHTML = rows.map(r => {
        const known = r.availableQty != null;
        const short = known && r.availableQty <= 0;
        return `<div style="color:${short ? 'var(--mb-enamel-red-ink)' : 'inherit'};">
          ${MApp.Util.escapeHtml(r.outputItemName)}: ${known ? MApp.Util.formatQty(r.availableQty) + ' available' : 'no pool bucket'}
        </div>`;
      }).join('');
    } catch (err) {
      el.textContent = "Couldn't load availability.";
    }
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
        ${this.lines.length > 1 ? `<button type="button" class="mb-btn-text mb-mt-2" style="padding:0;min-height:auto;color:var(--mb-enamel-red-ink);" onclick="MApp.Process.removeLine(${i})">Remove</button>` : ''}
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
  // deleteBOMsBulk is password-gated like every other BOM write, so
  // the unlock token rides along as the second argument exactly as
  // deleteBOM sends it.
  SELECT: {
    key: 'bom', noun: 'recipe', plural: 'recipes',
    method: 'deleteBOMsBulk',
    payload: rows => [rows.map(r => r.productId), MApp.BOM.token],
    onDone: () => MApp.BOM.open()
  },

  // productId was not searchable at all, so a recipe could not be found by
  // the code printed on the work order.
  SEARCH: {
    fields: [
      { key: 'productName', weight: 10, label: 'Product' },
      { key: 'productId', weight: 7, label: 'ID' }
    ]
  },

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
    MApp.SearchBox.attach('bom-list-search', term => this.onSearch(term));
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
    MApp.Paging.reset('bom');
    this.searchTerm = String(term || '').trim().toLowerCase();
    this._applyFilters();
  },

  _applyFilters() {
    this.filtered = MApp.Search.run(MApp.Search.index(this.products, this.SEARCH), this.searchTerm);
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

    const page = MApp.Paging.take('bom', this.filtered, () => this.render());
    MApp.SearchBox.setCount('bom-list-search', page.shown, page.total, page.meta);
    // reorderBOM renumbers by position in the array it is sent, so a move
    // computed from a search's matches would renumber those and leave
    // every other recipe pointing at the old order.
    const reorderable = !this.searchTerm.trim();
    listEl.innerHTML = page.rows.map((p, i) => `
      <div class="mb-card">
        <div class="mb-card-row">
          <div>
            <div class="mb-card-title">${MApp.Util.escapeHtml(p.productName)}</div>
            <div class="mb-card-sub">${(p.components || []).length} component(s)</div>
          </div>
          <div style="text-align:right;">
            <div class="mb-card-number">${MApp.Util.formatCurrency((p.totalCost || 0) + (p.totalAdditionalCost || 0))}</div>
            <div class="mb-card-sub">Total cost</div>
            ${reorderable ? MApp.Reorder.controlsHtml('bom-move', this.products.indexOf(p), this.products.length) : ''}
          </div>
        </div>
        <div class="mb-mt-2"><button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" data-bom-index="${i}">Edit</button></div>
      </div>`).join('') + MApp.Paging.moreHtml(page);

    listEl.querySelectorAll('[data-bom-index]').forEach(btn => {
      btn.addEventListener('click', () => {
        const product = this.filtered[Number(btn.dataset.bomIndex)];
        if (product) this.openForm(product);
      });
    });

    listEl.querySelectorAll('[data-bom-move]').forEach(btn => {
      btn.addEventListener('click', ev => {
        // Stops the card's own long-press selection claiming the tap.
        ev.stopPropagation();
        this.move(Number(btn.dataset.bomMove), Number(btn.dataset.reorderDelta));
      });
    });

    MApp.Select.enable(listEl, page.rows, this.SELECT);
  },

  // The whole order, and the unlock token every BOM write carries.
  // The local list is only rebuilt once the server has agreed.
  async move(index, delta) {
    const next = MApp.Reorder.moved(this.products, index, delta);
    if (!next) return;

    const res = await MApp.Util.mutateSimple(
      'reorderBOM', [next.map(x => x.productId), this.token], null
    );
    if (!res.success) {
      if (this._isAccessError(res)) this._resetToken();
      return;
    }

    MApp.Toast.success(res.message || 'Recipe order updated.');
    MApp.Haptics.light();
    this._loadList();
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
        ${this.components.length > 1 ? `<button type="button" class="mb-btn-text mb-mt-2" style="padding:0;min-height:auto;color:var(--mb-enamel-red-ink);" onclick="MApp.BOM.removeComponent(${i})">Remove</button>` : ''}
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
        <button type="button" class="mb-btn-text mb-mt-2" style="padding:0;min-height:auto;color:var(--mb-enamel-red-ink);" onclick="MApp.BOM.removeCost(${i})">Remove</button>
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
          ${isFailed && entry.lastError ? `<div class="mb-card-sub mb-mt-2" style="color:var(--mb-enamel-red-ink);">${MApp.Util.escapeHtml(entry.lastError)}</div>` : ''}
          <div class="mb-flex-row mb-mt-2" style="gap:var(--mb-sp-3);">
            ${isFailed ? `<button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" data-retry="${entry.id}">Retry</button>` : ''}
            <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;color:var(--mb-enamel-red-ink);" data-discard="${entry.id}">Discard</button>
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
// SELECT — long-press multi-select, and the bulk delete behind it.
//
// Desktop selects rows with checkboxes in a table and a mouse. The same
// capability on a phone is a long press to enter selection mode, then
// plain taps to add and remove. One component covers every list, so the
// ~20 *Bulk RPC methods that had no mobile route become one config block
// per screen rather than twenty implementations.
//
// This is the only destructive feature in the app that operates on more
// than one record at a time, on a device used with gloves, so it is built
// to fail in the safe direction:
//
//  - Entering selection mode takes a deliberate half-second press. A tap
//    can never start it.
//  - enable() refuses to arm the feature unless the number of rendered
//    row elements exactly matches the number of rows it was given. A
//    markup change that breaks that mapping makes selection quietly
//    unavailable instead of deleting the wrong records.
//  - The confirm names the count and the noun ("Delete 7 lots?"), never
//    a bare "Are you sure?".
//  - Selection is dropped on every re-render, so a filtered-out row can
//    never stay silently selected.
// ================================================================
MApp.Select = {
  LONG_PRESS_MS: 500,
  MOVE_CANCEL_PX: 10,

  // { key, config, rows, nodes, selected:Set<number>, listEl }
  _state: null,
  _press: null,

  // Called at the end of a render, with the rows that were rendered.
  enable(listEl, rows, config) {
    if (!listEl || !config || !config.method) return;
    const nodes = [...listEl.querySelectorAll(config.rowSelector || '.mb-card')];

    // The safety interlock. If the DOM and the data have drifted apart --
    // a banner that matches the row selector, a template edit that adds a
    // card -- index N in one is no longer index N in the other, and a
    // bulk delete would act on records the operator never chose. Refuse
    // rather than guess.
    if (nodes.length !== rows.length) {
      if (this._state && this._state.key === config.key) this.exit();
      return;
    }

    // A re-render invalidates any previous selection: the rows may have
    // been filtered, paged or reloaded underneath it.
    if (this._state && this._state.key === config.key) this.exit();

    this._bindLongPress(listEl, nodes, rows, config);
  },

  _bindLongPress(listEl, nodes, rows, config) {
    nodes.forEach((node, idx) => {
      node.addEventListener('pointerdown', e => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (this.isActive(config.key)) return; // already selecting: taps toggle
        const start = { x: e.clientX, y: e.clientY };
        this._press = setTimeout(() => {
          this._press = null;
          this._start(listEl, nodes, rows, config, idx);
        }, this.LONG_PRESS_MS);

        const cancel = ev => {
          if (ev && ev.type === 'pointermove' &&
              Math.abs(ev.clientX - start.x) < this.MOVE_CANCEL_PX &&
              Math.abs(ev.clientY - start.y) < this.MOVE_CANCEL_PX) return;
          clearTimeout(this._press);
          this._press = null;
          node.removeEventListener('pointerup', cancel);
          node.removeEventListener('pointercancel', cancel);
          node.removeEventListener('pointermove', cancel);
        };
        node.addEventListener('pointerup', cancel);
        node.addEventListener('pointercancel', cancel);
        node.addEventListener('pointermove', cancel);
      });

      node.addEventListener('click', e => {
        if (!this.isActive(config.key)) return;
        // Swallow the row's own actions (Edit / Delete / Print) while
        // selecting -- a tap means "toggle this row" and nothing else.
        e.preventDefault();
        e.stopPropagation();
        this.toggle(idx);
      }, true);
    });
  },

  _start(listEl, nodes, rows, config, idx) {
    this._state = { key: config.key, config, rows, nodes, listEl, selected: new Set([idx]) };
    MApp.Haptics.light();
    document.body.classList.add('mb-selecting');
    this._paint();
  },

  isActive(key) {
    return !!(this._state && this._state.key === key);
  },

  toggle(idx) {
    const s = this._state;
    if (!s) return;
    if (s.selected.has(idx)) s.selected.delete(idx);
    else s.selected.add(idx);
    // Deselecting the last row leaves selection mode, so there is never a
    // selection bar offering to delete nothing.
    if (s.selected.size === 0) { this.exit(); return; }
    this._paint();
  },

  exit() {
    if (this._state) {
      this._state.nodes.forEach(n => n.classList.remove('mb-selected'));
    }
    this._state = null;
    document.body.classList.remove('mb-selecting');
    const bar = document.getElementById('mapp-select-bar');
    if (bar) bar.classList.remove('open');
  },

  _paint() {
    const s = this._state;
    if (!s) return;
    s.nodes.forEach((n, i) => n.classList.toggle('mb-selected', s.selected.has(i)));

    const bar = document.getElementById('mapp-select-bar');
    const label = document.getElementById('mapp-select-count');
    if (label) {
      const n = s.selected.size;
      const noun = n === 1 ? (s.config.noun || 'item') : (s.config.plural || (s.config.noun || 'item') + 's');
      label.textContent = `${n} ${noun} selected`;
    }
    if (bar) bar.classList.add('open');
  },

  async deleteSelected() {
    const s = this._state;
    if (!s || !s.selected.size) return;
    const rows = [...s.selected].sort((a, b) => a - b).map(i => s.rows[i]);
    const n = rows.length;
    const noun = n === 1 ? (s.config.noun || 'item') : (s.config.plural || (s.config.noun || 'item') + 's');

    // Names the count and the noun. "Are you sure?" on a destructive
    // multi-record action tells the operator nothing they need.
    //
    // `note` replaces the default tail where "this can't be undone" is the
    // wrong thing to say -- deleting a master-data entry does not touch
    // the records already using it, and saying otherwise would stop
    // someone doing a tidy-up that is in fact safe.
    const tail = s.config.note || "This can't be undone.";
    //  for the one action here that is not a delete: deactivating
    // a user is reversible, and asking "Delete 3 users?" would describe
    // something worse than what the button does.
    const verb = s.config.verb || 'Delete';
    if (!window.confirm(`${verb} ${n} ${noun}? ${tail}`)) return;

    const config = s.config;
    const args = config.payload(rows);
    this.exit();

    // The server's own message wins over the count we were about to
    // announce. Several of these endpoints delete PART of a selection on
    // purpose -- deleteItemsBulk skips items still in use, and
    // deleteClientOrdersBulk skips any PI with a dispatch or a queued
    // production lot against it -- and each says so, naming what it left
    // behind. "5 items deleted" over the top of that is not merely
    // uninformative, it is wrong.
    const res = await MApp.Util.mutateSimple(config.method, args, null);
    if (!res || !res.success) return;
    MApp.Toast.success(res.message || `${n} ${noun} ${(s.config.pastTense || 'deleted')}.`);
    if (typeof config.onDone === 'function') config.onDone();
  }
};

// ================================================================
// GLOBAL SEARCH — one box over every dataset and every destination.
//
// Reaching the Wastage log used to be More -> scroll -> tap -> search,
// and any cross-module lookup ("which PO covered this item?") required
// the operator to already know which module owned the answer. This is
// one gesture from any tab, and because it indexes DESTINATIONS as well
// as records it is also the filter the More tab's fourteen entries never
// had.
//
// Records deep-link by navigating to the owning module with its own
// search prefilled, rather than trying to open one specific record's
// sheet. That reuses machinery that already works on every screen, and
// lands the operator on a filtered list they can act on -- a narrower,
// more honest promise than a per-record router that would need bespoke
// knowledge of thirteen modules to be correct.
// ================================================================
MApp.GlobalSearch = {
  // Destinations are indexed exactly like records, so "wast", "recipe" or
  // "roles" all resolve. keywords carries the words an operator would
  // actually type for a screen whose label they cannot remember.
  DESTINATIONS: [
    { label: 'Home', keywords: 'dashboard today activity', run: () => MApp.Shell.showTab('home') },
    { label: 'Stock', keywords: 'items quantity low stock levels', run: () => MApp.Shell.showTab('stock') },
    { label: 'Production', keywords: 'lots log lot process', run: () => MApp.Shell.showTab('production') },
    { label: 'Dispatch', keywords: 'challan client delivery', run: () => MApp.Shell.showTab('dispatch') },
    { label: 'Log Lot', keywords: 'new production lot create', run: () => MApp.Production.openLogLotSheet() },
    { label: 'New Dispatch', keywords: 'challan create send', run: () => MApp.Dispatch.openNewDispatchSheet() },
    { label: 'Log Return', keywords: 'returns vendor create', run: () => MApp.Returns.openNewReturnSheet() },
    { label: 'Issued Stock', keywords: 'issue contractor material log', run: () => MApp.Issue.open() },
    { label: 'Wastage', keywords: 'waste loss scrap log', run: () => MApp.Wastage.open() },
    { label: 'PO Ledger', keywords: 'purchase orders pending', run: () => MApp.PO.openLedgerSheet() },
    { label: 'Bill Ledger', keywords: 'bills invoices vendor', run: () => MApp.Bill.openLedgerSheet() },
    { label: 'Items lookup', keywords: 'item master search parts', run: () => MApp.Items.openLookupSheet() },
    { label: 'Vendors', keywords: 'suppliers directory contact', run: () => MApp.Directory.open('vendor') },
    { label: 'Clients', keywords: 'customers directory contact', run: () => MApp.Directory.open('client') },
    { label: 'Contractors', keywords: 'directory contact rates labour', run: () => MApp.Directory.open('contractor') },
    { label: 'Processes', keywords: 'stages output recipe components', run: () => MApp.Process.open() },
    { label: 'Product Recipes', keywords: 'bom bill of materials components', run: () => MApp.BOM.open() },
    { label: 'Users & Roles', keywords: 'admin accounts permissions', run: () => MApp.Admin.open() },
    { label: 'Sync Issues', keywords: 'offline outbox pending failed queue', run: () => MApp.SyncIssues.open() },
    { label: 'Account', keywords: 'profile name email password change my', run: () => MApp.Account.open() },
    { label: 'Warehouse Pool', keywords: 'pool buckets negative available wip intermediate stock tab', run: () => MApp.Pool.open() },
    { label: 'System Status', keywords: 'backup health activity log notifications audit', run: () => MApp.Status.open() },
    { label: 'Full dashboard', keywords: 'kpi totals payables ready low stock overview', run: () => MApp.Dashboard.open() },
    { label: 'Colours', keywords: 'colour color master paint shade', run: () => MApp.Master.open('color') },
    { label: 'Models', keywords: 'model master kalpi ranger', run: () => MApp.Master.open('model') },
    { label: 'Process Types', keywords: 'process type master stage', run: () => MApp.Master.open('processType') },
    { label: 'Units', keywords: 'unit master conversion dozen kg factor', run: () => MApp.Master.open('unit') },
    { label: 'Stock Groups', keywords: 'group set collection low stock report stickers bolts', run: () => MApp.StockGroups.open() },
    { label: 'PI / Estimates', keywords: 'client order proforma invoice quote estimate confirm', run: () => MApp.ClientOrders.open() },
    { label: 'Opening balances', keywords: 'pool opening stock credit rack correction warehouse', run: () => MApp.PoolOpenings.open() },
    { label: 'Dispatch plan', keywords: 'plan planned loading bay tomorrow schedule challan client', run: () => MApp.DispatchPlan.open() },
    { label: 'Custom Roles', keywords: 'permissions access admin role tab viewer editor', run: () => MApp.Roles.open() }
  ],

  DEST_SPEC: {
    fields: [
      { key: 'label', weight: 10, label: 'Screen' },
      { key: 'keywords', weight: 4, label: 'Screen' }
    ]
  },

  // Only the datasets that are already offline-cached, so global search
  // keeps working on a factory LAN that has dropped -- the condition this
  // app was built for. Extending this list is one entry per dataset once
  // that dataset is added to MApp.Api.callCached's set.
  SOURCES: [
    {
      id: 'stock', label: 'Stock', method: 'getStockData', tab: 'stock',
      searchInput: 'stock-search',
      spec: { fields: [
        { key: 'name', weight: 10, label: 'Item' },
        { key: 'size', weight: 6, label: 'Size' }
      ] },
      title: r => r.name,
      subtitle: r => [r.size, r.currentStock != null ? `${MApp.Util.formatQty(r.currentStock)} in stock` : null].filter(Boolean).join(' · '),
      term: r => r.name
    },
    {
      id: 'production', label: 'Production', method: 'getProductionData', tab: 'production',
      searchInput: 'production-search',
      spec: { fields: [
        { key: 'lotNumber', weight: 10, label: 'Lot' },
        { key: 'assignedTo', weight: 5, label: 'Assigned to' },
        { key: 'status', weight: 4, label: 'Status' }
      ] },
      title: r => r.lotNumber,
      subtitle: r => [r.status, MApp.Util.formatNameCase(r.assignedTo)].filter(Boolean).join(' · '),
      term: r => r.lotNumber
    },
    {
      id: 'dispatch', label: 'Dispatch', method: 'getDispatchData', tab: 'dispatch',
      searchInput: 'dispatch-search',
      spec: { fields: [
        { key: 'dispatchNumber', weight: 10, label: 'Challan' },
        { key: 'clientName', weight: 7, label: 'Client' },
        { key: 'productName', weight: 6, label: 'Product' }
      ] },
      title: r => r.dispatchNumber,
      subtitle: r => [MApp.Util.formatNameCase(r.clientName) || 'Direct supply', r.productName].filter(Boolean).join(' · '),
      term: r => r.dispatchNumber
    }
  ],

  PER_GROUP: 5,
  _indexes: {},
  _loaded: false,
  _term: '',

  open() {
    this._term = '';
    MApp.Sheet.open('sheet-global-search');
    MApp.SearchBox.attach('global-search-input', term => this.onSearch(term));
    const input = document.getElementById('global-search-input');
    if (input) {
      input.value = '';
      setTimeout(() => input.focus(), 280);
    }
    this.render();
    this._loadSources();
  },

  close() {
    MApp.Sheet.close('sheet-global-search');
  },

  onSearch(term) {
    this._term = term || '';
    this.render();
  },

  // Best-effort and non-blocking: destinations are searchable instantly,
  // and each dataset joins the index as it arrives. A source that fails
  // (offline with nothing cached) simply contributes nothing rather than
  // breaking the whole search.
  async _loadSources() {
    this._indexes.destinations = MApp.Search.index(this.DESTINATIONS, this.DEST_SPEC);
    await Promise.all(this.SOURCES.map(async source => {
      try {
        const res = await MApp.Api.callCached(source.method);
        if (res && res.success) {
          this._indexes[source.id] = MApp.Search.index(res.data || [], source.spec);
        }
      } catch (e) {
        /* unreachable and uncached -- this group is simply absent */
      }
    }));
    this._loaded = true;
    this.render();
  },

  render() {
    const el = document.getElementById('global-search-results');
    if (!el) return;
    const term = this._term.trim();

    if (!term) {
      el.innerHTML = `
        <div class="mapp-section-label">Go to</div>
        ${this._groupHtml('destinations', 'Screens', this.DESTINATIONS.slice(0, 6), null)}`;
      this._bind(el);
      return;
    }

    const destHits = MApp.Search.run(this._indexes.destinations || [], term);
    const groups = [{ id: 'destinations', label: 'Screens', rows: destHits, source: null }];

    this.SOURCES.forEach(source => {
      const entries = this._indexes[source.id];
      if (!entries) return;
      const hits = MApp.Search.run(entries, term);
      if (hits.length) groups.push({ id: source.id, label: source.label, rows: hits, source });
    });

    const total = groups.reduce((n, g) => n + g.rows.length, 0);
    if (!total) {
      MApp.Util.renderEmpty(el, {
        title: 'Nothing found',
        body: this._loaded
          ? `Nothing matches “${term}”.`
          : 'Still loading — results will fill in as data arrives.'
      });
      return;
    }

    el.innerHTML = groups
      .filter(g => g.rows.length)
      .map(g => this._groupHtml(g.id, g.label, g.rows, g.source))
      .join('');
    this._bind(el);
  },

  _groupHtml(groupId, label, rows, source) {
    const shown = rows.slice(0, this.PER_GROUP);
    const more = rows.length > shown.length
      ? `<div class="mb-card-sub" style="padding:0 var(--mb-sp-1) var(--mb-sp-3);">+${rows.length - shown.length} more — open ${MApp.Util.escapeHtml(label)} to see them</div>`
      : '';
    const cards = shown.map((row, i) => {
      const title = source ? source.title(row) : row.label;
      const sub = source ? source.subtitle(row) : 'Screen';
      return `
        <button type="button" class="mb-card mb-card-tappable" style="border:none;width:100%;text-align:left;"
                data-group="${MApp.Util.escapeHtml(groupId)}" data-idx="${i}">
          <div class="mb-card-row">
            <span class="mb-card-title">${MApp.Util.escapeHtml(String(title == null ? '' : title))}</span>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
          </div>
          <div class="mb-card-sub">${MApp.Util.escapeHtml(String(sub == null ? '' : sub))}</div>
        </button>`;
    }).join('');
    // Stashed so the click handler resolves by index rather than
    // interpolating record values into an inline onclick, where a name
    // containing a quote would break out of the handler's string.
    this._lastGroups = this._lastGroups || {};
    this._lastGroups[groupId] = { rows: shown, source };
    return `<div class="mapp-section-label">${MApp.Util.escapeHtml(label)}</div>${cards}${more}`;
  },

  _bind(el) {
    el.querySelectorAll('[data-group]').forEach(btn => {
      btn.addEventListener('click', () => {
        const group = (this._lastGroups || {})[btn.dataset.group];
        if (!group) return;
        const row = group.rows[Number(btn.dataset.idx)];
        if (!row) return;
        this.close();
        if (!group.source) { row.run(); return; }
        this._goToRecord(group.source, row);
      });
    });
  },

  // Navigate to the owning tab and prefill its search with something that
  // identifies this record, so the operator lands on a list already
  // filtered to it.
  _goToRecord(source, row) {
    MApp.Shell.showTab(source.tab);
    const term = String(source.term(row) || '');
    // The tab's mount() is async (it fetches, then attaches its search
    // box), so the prefill has to wait for the input to exist. Give up
    // quietly rather than spin: the operator is on the right screen
    // either way, which is most of the value.
    let tries = 0;
    const prefill = () => {
      const input = document.getElementById(source.searchInput);
      if (!input) {
        if (tries++ < 20) setTimeout(prefill, 100);
        return;
      }
      input.value = term;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setTimeout(prefill, 120);
  }
};

// ================================================================
// MASTER DATA — colours, models, process types, units.
//
// These feed every picker in the app, so a value that was missing had no
// route in on a phone: the Log Lot cascade simply could not be completed
// until someone opened a laptop. Twenty-one RPC methods were unreachable
// here, and four of them are the ones that unblock a shift.
//
// One screen serves all four because three of them share an identical
// {name, remarks} contract and units differ only by two extra fields --
// the same reasoning MApp.Directory already uses for vendors, clients and
// contractors. The spec IS the difference between them.
// ================================================================
MApp.Master = {
  TYPES: {
    color: {
      title: 'Colours', singular: 'Colour',
      read: 'getColors', save: 'saveColor', remove: 'deleteColor', removeBulk: 'deleteColorsBulk',
      note: 'Components already tagged with one keep the text, but it will no longer appear in suggestions.',
      identity: 'name', originalKey: 'originalName',
      fields: [
        { key: 'name', label: 'Colour Name', type: 'text', required: true },
        { key: 'remarks', label: 'Remarks', type: 'multiline' }
      ]
    },
    model: {
      title: 'Models', singular: 'Model',
      read: 'getModels', save: 'saveModel', remove: 'deleteModel', removeBulk: 'deleteModelsBulk',
      note: 'Records already naming one keep the text, but it will no longer appear in suggestions.',
      identity: 'name', originalKey: 'originalName',
      fields: [
        { key: 'name', label: 'Model Name', type: 'text', required: true },
        { key: 'remarks', label: 'Remarks', type: 'multiline' }
      ]
    },
    processType: {
      title: 'Process Types', singular: 'Process Type',
      read: 'getProcessTypes', save: 'saveProcessType', remove: 'deleteProcessType', removeBulk: 'deleteProcessTypesBulk',
      note: 'Processes already using one keep the text, but it will no longer appear in suggestions.',
      identity: 'name', originalKey: 'originalName',
      fields: [
        { key: 'name', label: 'Process Type', type: 'text', required: true },
        { key: 'remarks', label: 'Remarks', type: 'multiline' }
      ]
    },
    unit: {
      title: 'Units', singular: 'Unit',
      read: 'getUnitsData', save: 'saveUnit', remove: 'deleteUnit', removeBulk: 'deleteUnitsBulk',
      note: 'Items already using one keep the text, but it will no longer appear in suggestions.',
      identity: 'unitName', originalKey: 'originalUnitName',
      // factorToBase is how many base units one of these is. Getting it
      // wrong silently rescales every quantity entered in this unit, so
      // it is required and must be positive.
      fields: [
        { key: 'unitName', label: 'Unit Name', type: 'text', required: true },
        { key: 'family', label: 'Family', type: 'text', required: true,
          hint: 'Units convert only within a family, e.g. Count, Weight.' },
        { key: 'factorToBase', label: 'Factor to base unit', type: 'decimal', required: true, min: 0,
          hint: 'How many base units one of these equals. A Dozen is 12.' },
        { key: 'remarks', label: 'Remarks', type: 'multiline' }
      ]
    }
  },

  type: null,
  rows: [],
  entries: [],
  filtered: [],
  searchTerm: '',
  editing: null,

  cfg() { return this.TYPES[this.type] || {}; },

  // Built per render rather than declared as a constant, because which
  // endpoint a bulk delete calls depends on the register that is open.
  // The key is the same for all four on purpose: MApp.Select exits any
  // selection whose key matches when the list re-renders, so switching
  // from Colours to Units cannot leave a colour selection live behind a
  // list of units.
  selectSpec() {
    const cfg = this.cfg();
    const singular = (cfg.singular || 'entry').toLowerCase();
    return {
      key: 'master',
      noun: singular,
      plural: singular + 's',
      note: cfg.note,
      method: cfg.removeBulk,
      payload: rows => [rows.map(r => r[cfg.identity])],
      onDone: () => this.open(this.type)
    };
  },

  searchSpec() {
    return { fields: this.cfg().fields.map(f => ({ key: f.key, weight: 5, label: f.label })) };
  },

  async open(type) {
    if (!this.TYPES[type]) return;
    this.type = type;
    this.searchTerm = '';
    const cfg = this.cfg();
    const titleEl = document.getElementById('master-title');
    if (titleEl) titleEl.textContent = cfg.title;
    const input = document.getElementById('master-search');
    if (input) { input.value = ''; input.placeholder = `Search ${cfg.title.toLowerCase()}…`; }
    MApp.SearchBox.attach('master-search', term => this.onSearch(term));

    const listEl = document.getElementById('master-list');
    MApp.Util.renderSkeleton(listEl, 5);
    MApp.Sheet.open('sheet-master');

    try {
      const res = await MApp.Api.call(cfg.read);
      if (!res || !res.success) {
        MApp.Util.renderError(listEl, res && res.message, () => this.open(type));
        return;
      }
      if (this.type !== type) return; // a different register was opened meanwhile
      this.rows = res.data || [];
      this.entries = MApp.Search.index(this.rows, this.searchSpec());
      MApp.Paging.reset('master');
      this.filtered = this.rows;
      this.render();
    } catch (err) {
      MApp.Util.renderError(listEl, err && err.message, () => this.open(type));
    }
  },

  close() { MApp.Sheet.close('sheet-master'); },

  onSearch(term) {
    this.searchTerm = term || '';
    MApp.Paging.reset('master');
    this.filtered = MApp.Search.run(this.entries, this.searchTerm);
    this.render();
  },

  render() {
    const listEl = document.getElementById('master-list');
    if (!listEl) return;
    const cfg = this.cfg();

    const page = MApp.Paging.take('master', this.filtered, () => this.render());
    MApp.SearchBox.setCount('master-search', page.shown, page.total, page.meta);

    if (this.filtered.length === 0) {
      MApp.Util.renderEmpty(listEl, {
        title: `No ${cfg.title.toLowerCase()} found`,
        body: this.searchTerm.trim() ? `Nothing matches “${this.searchTerm.trim()}”.` : 'Tap Add to create the first one.'
      });
      return;
    }

    listEl.innerHTML = page.rows.map((r, i) => `
      <div class="mb-card">
        <div class="mb-card-row">
          <div>
            <div class="mb-card-title">${MApp.Util.escapeHtml(r[cfg.identity])}</div>
            ${this.type === 'unit'
    ? `<div class="mb-card-sub">${MApp.Util.escapeHtml(r.family || '')} · 1 = ${MApp.Util.formatQty(r.factorToBase)} base</div>`
    : (r.remarks ? `<div class="mb-card-sub">${MApp.Util.escapeHtml(r.remarks)}</div>` : '')}
          </div>
        </div>
        <div class="mb-mt-2" style="display:flex; gap:var(--mb-sp-4);">
          <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" data-master-action="edit" data-master-index="${i}">Edit</button>
          <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;color:var(--mb-enamel-red-ink);" data-master-action="delete" data-master-index="${i}">Delete</button>
        </div>
      </div>`).join('') + MApp.Paging.moreHtml(page);

    listEl.querySelectorAll('[data-master-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const row = page.rows[Number(btn.dataset.masterIndex)];
        if (!row) return;
        if (btn.dataset.masterAction === 'edit') this.openForm(row);
        else this.remove(row);
      });
    });

    MApp.Select.enable(listEl, page.rows, this.selectSpec());
  },

  formSpec() {
    return { id: 'master-form', fields: this.cfg().fields };
  },

  openForm(record) {
    const cfg = this.cfg();
    this.editing = record || null;
    const titleEl = document.getElementById('master-form-title');
    if (titleEl) titleEl.textContent = (record ? 'Edit ' : 'Add ') + cfg.singular;
    MApp.Form.render('master-form-body', this.formSpec(), record || {});
    MApp.Sheet.open('sheet-master-form');
  },

  closeForm() { MApp.Sheet.close('sheet-master-form'); },

  async save() {
    const cfg = this.cfg();
    const spec = this.formSpec();
    const values = MApp.Form.read(spec);
    if (!MApp.Form.validate(spec, values)) return;

    const formData = { ...values };
    // An edit is identified by the name it had BEFORE this form, not the
    // one now typed -- renaming is a normal edit here.
    if (this.editing) formData[cfg.originalKey] = this.editing[cfg.identity];

    const btn = document.getElementById('master-form-save-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    const res = await MApp.Util.mutateSimple(cfg.save, [formData], `${cfg.singular} saved.`);
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
    if (res.success) { this.closeForm(); this.open(this.type); }
  },

  async remove(row) {
    const cfg = this.cfg();
    const name = row[cfg.identity];
    // Not a referential check: the server soft-deletes the row without
    // asking who points at it, so records already carrying this name keep
    // it as text and only the pickers stop offering it. Say that, rather
    // than the generic "this can't be undone", which is both untrue of a
    // soft delete and scarier than the thing deserves.
    if (!window.confirm(`Delete ${cfg.singular.toLowerCase()} “${name}”? ${cfg.note}`)) return;
    const res = await MApp.Util.mutateSimple(cfg.remove, [name], `${cfg.singular} deleted.`);
    if (res.success) this.open(this.type);
  }
};

// ================================================================
// STOCK GROUPS (More tab) — named collections of item/size rows.
//
// The point of a group is that somebody already did the picking: the
// Low Stock Report filters and prints group-wise instead of making the
// operator re-select the same forty rows every time. Building one was
// desktop-only, which meant the person who knows which parts belong
// together -- the one standing at the rack -- could not record it.
//
// Two sheets, because they are two different jobs: the register (name
// and remarks) and the membership checklist, which is a long list of
// every item/size row in stock.
// ================================================================
MApp.StockGroups = {
  SEARCH: {
    fields: [
      { key: 'name', weight: 10, label: 'Group' },
      { key: 'remarks', weight: 3, label: 'Remarks' }
    ]
  },

  groups: [],
  entries: [],
  filtered: [],
  searchTerm: '',
  editing: null,

  async open() {
    const listEl = document.getElementById('stock-groups-list');
    const input = document.getElementById('stock-groups-search');
    if (input) input.value = '';
    this.searchTerm = '';
    MApp.SearchBox.attach('stock-groups-search', term => this.onSearch(term));

    MApp.Util.renderSkeleton(listEl, 4);
    MApp.Sheet.open('sheet-stock-groups');

    try {
      const res = await MApp.Api.call('getStockGroupsData');
      if (!res || !res.success) {
        MApp.Util.renderError(listEl, res && res.message, () => this.open());
        return;
      }
      this.groups = res.data || [];
      this.entries = MApp.Search.index(this.groups, this.SEARCH);
      MApp.Paging.reset('stockGroups');
      this.filtered = this.groups;
      this.render();
    } catch (err) {
      MApp.Util.renderError(listEl, err && err.message, () => this.open());
    }
  },

  close() { MApp.Sheet.close('sheet-stock-groups'); },

  onSearch(term) {
    this.searchTerm = term || '';
    MApp.Paging.reset('stockGroups');
    this.filtered = MApp.Search.run(this.entries, this.searchTerm);
    this.render();
  },

  render() {
    const listEl = document.getElementById('stock-groups-list');
    if (!listEl) return;

    const page = MApp.Paging.take('stockGroups', this.filtered, () => this.render());
    MApp.SearchBox.setCount('stock-groups-search', page.shown, page.total, page.meta);

    if (this.filtered.length === 0) {
      MApp.Util.renderEmpty(listEl, {
        title: 'No stock groups',
        body: this.searchTerm.trim()
          ? `Nothing matches “${this.searchTerm.trim()}”.`
          : 'Tap Add to make one, then choose which item/size rows belong to it.'
      });
      return;
    }

    listEl.innerHTML = page.rows.map((g, i) => {
      const count = (g.items || []).length;
      return `
      <div class="mb-card">
        <div class="mb-card-row">
          <div>
            <div class="mb-card-title">${MApp.Util.escapeHtml(g.name)}</div>
            ${g.remarks ? `<div class="mb-card-sub">${MApp.Util.escapeHtml(g.remarks)}</div>` : ''}
          </div>
          <div style="text-align:right;">
            <div class="mb-card-number">${count}</div>
            <div class="mb-card-sub">${count === 1 ? 'row' : 'rows'}</div>
          </div>
        </div>
        <div class="mb-mt-2" style="display:flex; gap:var(--mb-sp-4); flex-wrap:wrap;">
          <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" data-group-action="items" data-group-index="${i}">Manage items</button>
          <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" data-group-action="edit" data-group-index="${i}">Rename</button>
          <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;color:var(--mb-enamel-red-ink);" data-group-action="delete" data-group-index="${i}">Delete</button>
        </div>
      </div>`;
    }).join('') + MApp.Paging.moreHtml(page);

    listEl.querySelectorAll('[data-group-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const g = page.rows[Number(btn.dataset.groupIndex)];
        if (!g) return;
        const action = btn.dataset.groupAction;
        if (action === 'items') this.openItems(g);
        else if (action === 'edit') this.openForm(g);
        else this.remove(g);
      });
    });
  },

  formSpec() {
    return {
      id: 'stock-group-form',
      fields: [
        { key: 'name', label: 'Group Name', type: 'text', required: true },
        { key: 'remarks', label: 'Remarks', type: 'multiline' }
      ]
    };
  },

  openForm(group) {
    this.editing = group || null;
    const titleEl = document.getElementById('stock-group-form-title');
    if (titleEl) titleEl.textContent = group ? `Rename “${group.name}”` : 'Add Stock Group';
    MApp.Form.render('stock-group-form-body', this.formSpec(), group || {});
    MApp.Sheet.open('sheet-stock-group-form');
  },

  closeForm() { MApp.Sheet.close('sheet-stock-group-form'); },

  async save() {
    const spec = this.formSpec();
    const values = MApp.Form.read(spec);
    if (!MApp.Form.validate(spec, values)) return;

    // The server keys an edit off a numeric id and skips its duplicate-
    // name check only when the name is unchanged, so the id has to be the
    // real one rather than the typed name.
    const editing = this.editing;
    const payload = {
      id: editing ? editing.id : null,
      name: values.name,
      remarks: values.remarks || ''
    };

    const btn = document.getElementById('stock-group-form-save-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    const res = await MApp.Util.mutateSimple('saveStockGroup', [payload], null);
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
    if (!res.success) return;

    MApp.Toast.success(res.message || 'Stock group saved.');
    this.closeForm();
    await this.open();

    // A group with nothing in it does nothing, so a brand-new one goes
    // straight into its own checklist rather than leaving the operator to
    // find the Manage items button on their own.
    if (!editing) {
      const id = res.data && res.data.id;
      const created = this.groups.find(g => g.id === id);
      if (created) this.openItems(created);
    }
  },

  async remove(group) {
    // Soft delete, and the membership rows are deliberately left behind
    // server-side, so this is recoverable in the database. It is still a
    // named thing somebody built by hand, so say what goes.
    const n = (group.items || []).length;
    if (!window.confirm(`Delete stock group “${group.name}”? Its ${n} item/size row(s) stop being grouped; the items themselves are untouched.`)) return;
    const res = await MApp.Util.mutateSimple('deleteStockGroup', [group.id], null);
    if (res.success) {
      MApp.Toast.success(res.message || 'Stock group deleted.');
      this.open();
    }
  },

  // ── Membership checklist ────────────────────────────────────────────
  // Keyed on MApp.Stock._key(name, size), the same normalisation the
  // Stock tab uses, so a group built here and one built on desktop agree
  // about what "the same row" means.
  itemsGroup: null,
  selectedKeys: null,
  itemsSearch: '',
  itemsFilter: 'all',
  stockRows: [],

  async openItems(group) {
    this.itemsGroup = group;
    this.itemsSearch = '';
    this.itemsFilter = 'all';
    this.selectedKeys = new Set((group.items || []).map(it => MApp.Stock._key(it.name, it.size)));

    const titleEl = document.getElementById('stock-group-items-title');
    if (titleEl) titleEl.textContent = `Items — ${group.name}`;
    const input = document.getElementById('stock-group-items-search');
    if (input) input.value = '';
    MApp.SearchBox.attach('stock-group-items-search', term => {
      this.itemsSearch = term || '';
      this.renderItems();
    });
    this._paintFilterChips();

    const body = document.getElementById('stock-group-items-body');
    MApp.Util.renderSkeleton(body, 5);
    MApp.Sheet.open('sheet-stock-group-items');

    try {
      const res = await MApp.Api.callCached('getStockData');
      if (!res || !res.success) {
        MApp.Util.renderError(body, res && res.message, () => this.openItems(group));
        return;
      }
      this.stockRows = res.data || [];
      this.renderItems();
    } catch (err) {
      MApp.Util.renderError(body, err && err.message, () => this.openItems(group));
    }
  },

  closeItems() { MApp.Sheet.close('sheet-stock-group-items'); },

  setItemsFilter(mode) {
    this.itemsFilter = mode || 'all';
    this._paintFilterChips();
    this.renderItems();
  },

  _paintFilterChips() {
    const bar = document.getElementById('stock-group-items-filters');
    if (!bar) return;
    bar.querySelectorAll('[data-items-filter]').forEach(b => {
      const on = b.dataset.itemsFilter === this.itemsFilter;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  },

  // The rows the current search and filter leave on screen. Select all
  // and Select none act on exactly this set: a "select all" that quietly
  // reached past the filter would be the one destructive control here,
  // because the save replaces the group's whole membership.
  visibleRows() {
    const term = String(this.itemsSearch || '').trim().toLowerCase();
    return (this.stockRows || []).filter(r => {
      if (term) {
        const hay = `${r.name || ''} ${r.size || ''}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      const on = this.selectedKeys.has(MApp.Stock._key(r.name, r.size));
      if (this.itemsFilter === 'selected' && !on) return false;
      if (this.itemsFilter === 'unselected' && on) return false;
      return true;
    });
  },

  selectAllVisible(on) {
    this.visibleRows().forEach(r => {
      const key = MApp.Stock._key(r.name, r.size);
      if (on) this.selectedKeys.add(key);
      else this.selectedKeys.delete(key);
    });
    this.renderItems();
  },

  toggleRow(name, size) {
    const key = MApp.Stock._key(name, size);
    if (this.selectedKeys.has(key)) this.selectedKeys.delete(key);
    else this.selectedKeys.add(key);
    this.renderItems();
  },

  toggleItem(name, on) {
    this.visibleRows()
      .filter(r => String(r.name) === String(name))
      .forEach(r => {
        const key = MApp.Stock._key(r.name, r.size);
        if (on) this.selectedKeys.add(key);
        else this.selectedKeys.delete(key);
      });
    this.renderItems();
  },

  renderItems() {
    const body = document.getElementById('stock-group-items-body');
    if (!body) return;

    const countEl = document.getElementById('stock-group-items-count');
    if (countEl) {
      const n = this.selectedKeys.size;
      countEl.textContent = n === 1 ? '1 row selected' : `${n} rows selected`;
    }

    const visible = this.visibleRows();
    if (visible.length === 0) {
      MApp.Util.renderEmpty(body, {
        title: 'Nothing to show',
        body: 'No stock row matches this search and filter.'
      });
      return;
    }

    // One card per item name, its sizes as chips inside it. Stock is one
    // row per item/size and a flat list of a thousand of those is
    // unreadable on a phone -- the sizes of one item belong together, and
    // the header toggles all of them at once.
    const byName = new Map();
    visible.forEach(r => {
      if (!byName.has(r.name)) byName.set(r.name, []);
      byName.get(r.name).push(r);
    });
    const names = [...byName.keys()].sort((a, b) => String(a).localeCompare(String(b)));

    body.innerHTML = names.map(name => {
      const rows = byName.get(name).slice()
        .sort((a, b) => String(a.size || '').localeCompare(String(b.size || '')));
      const on = rows.filter(r => this.selectedKeys.has(MApp.Stock._key(r.name, r.size))).length;
      const all = on === rows.length;
      return `
      <div class="mb-card">
        <div class="mb-card-row">
          <div class="mb-card-title">${MApp.Util.escapeHtml(name)}</div>
          <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;"
                  data-item-toggle="${MApp.Util.escapeHtml(name)}" data-item-on="${all ? '0' : '1'}">
            ${on}/${rows.length} · ${all ? 'Clear all' : 'Select all'}
          </button>
        </div>
        <div class="mb-color-chip-list mb-mt-2">
          ${rows.map(r => {
    const checked = this.selectedKeys.has(MApp.Stock._key(r.name, r.size));
    return `
            <div class="mb-color-chip${checked ? ' checked' : ''}">
              <button type="button" class="mb-color-chip-toggle" aria-pressed="${checked ? 'true' : 'false'}"
                      data-size-item="${MApp.Util.escapeHtml(r.name)}" data-size-toggle="${MApp.Util.escapeHtml(r.size || '')}">
                <span>${MApp.Util.escapeHtml(r.size || 'GENERAL')}</span>
                <span class="mb-text-sm${r.isLowStock ? ' mb-alert' : ' mb-text-steel'}">${MApp.Util.formatQty(r.currentStock)}</span>
              </button>
            </div>`;
  }).join('')}
        </div>
      </div>`;
    }).join('');

    body.querySelectorAll('[data-item-toggle]').forEach(btn => {
      btn.addEventListener('click', () => this.toggleItem(btn.dataset.itemToggle, btn.dataset.itemOn === '1'));
    });
    body.querySelectorAll('[data-size-toggle]').forEach(btn => {
      btn.addEventListener('click', () => this.toggleRow(btn.dataset.sizeItem, btn.dataset.sizeToggle));
    });
  },

  async saveItems() {
    const group = this.itemsGroup;
    if (!group) return;

    // Sent as the whole desired set rather than a diff: setStockGroupItems
    // deletes the group's rows and re-inserts these. That also makes an
    // empty selection a real instruction -- empty the group -- rather
    // than a mistake to swallow, so it is confirmed, not blocked.
    const keys = [...this.selectedKeys];
    if (keys.length === 0 &&
        !window.confirm(`Save “${group.name}” with no items? The group stays, but nothing is in it.`)) return;

    // The key is lower-cased for comparison and the server stores what it
    // is given, so send the stock row's own casing back, not the key's.
    // A key with no matching row is one the group already held for an
    // item that has since left Stock; it is carried through unchanged
    // rather than silently dropped by this screen.
    const byKey = {};
    (this.stockRows || []).forEach(r => { byKey[MApp.Stock._key(r.name, r.size)] = r; });
    const payload = keys.map(key => {
      const row = byKey[key];
      if (row) return { name: row.name, size: row.size || '' };
      const at = key.lastIndexOf('||');
      return { name: key.slice(0, at), size: key.slice(at + 2) };
    });

    const btn = document.getElementById('stock-group-items-save-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    const res = await MApp.Util.mutateSimple(
      'setStockGroupItems', [{ groupId: group.id, items: payload }], null
    );
    if (btn) { btn.disabled = false; btn.textContent = 'Save items'; }
    if (!res.success) return;

    MApp.Toast.success(res.message || 'Group items saved.');
    this.closeItems();
    this.open();
  }
};


// ================================================================
// DISPATCH PLAN — what is meant to go out, and on what day.
//
// Desktop plans this on a drag-and-drop board: pool items on the left,
// client cards on the right, lines dragged between them. That board is
// the wrong object on a phone and always would be. What survives the
// translation is the thing the floor actually needs from it -- today's
// list, by client, and whether each line has gone yet.
//
// So this is a checklist over the same lines. saveDispatchPlanLine
// upserts ONE line rather than resubmitting a whole plan (see migration
// 027), which is what makes a checklist a faithful client for it: every
// edit here is exactly one line, the same unit the board's drags are.
// ================================================================
MApp.DispatchPlan = {
  lines: [],
  planDate: '',
  clients: [],
  products: [],
  editing: null,
  selection: null,

  async open(dateIso) {
    this.planDate = dateIso || MApp.Util.todayInputValue();
    const dateEl = document.getElementById('dispatch-plan-date');
    if (dateEl) dateEl.value = this.planDate;

    const listEl = document.getElementById('dispatch-plan-list');
    MApp.Util.renderSkeleton(listEl, 4);
    MApp.Sheet.open('sheet-dispatch-plan');
    await this.load();
  },

  close() { MApp.Sheet.close('sheet-dispatch-plan'); },

  onDateChange(value) {
    this.planDate = value || MApp.Util.todayInputValue();
    this.load();
  },

  async load() {
    const listEl = document.getElementById('dispatch-plan-list');
    if (!listEl) return;
    MApp.Util.renderSkeleton(listEl, 4);
    try {
      const res = await MApp.Api.call('getDispatchPlans');
      if (!res || !res.success) {
        MApp.Util.renderError(listEl, res && res.message, () => this.load());
        return;
      }
      this.lines = res.data || [];
      this.render();
    } catch (err) {
      MApp.Util.renderError(listEl, err && err.message, () => this.load());
    }
  },

  forDate() {
    return this.lines
      .filter(l => String(l.planDate || '').slice(0, 10) === this.planDate)
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  },

  render() {
    const listEl = document.getElementById('dispatch-plan-list');
    if (!listEl) return;

    const rows = this.forDate();
    const done = rows.filter(l => l.fulfilled).length;

    const summary = document.getElementById('dispatch-plan-summary');
    if (summary) {
      summary.textContent = rows.length === 0
        ? 'Nothing planned for this day.'
        : `${done} of ${rows.length} dispatched`;
    }

    if (rows.length === 0) {
      MApp.Util.renderEmpty(listEl, {
        title: 'Nothing planned',
        body: 'Tap Add to put a line on this day’s plan.'
      });
      return;
    }

    // Grouped by client, because that is how the loading bay works
    // through it -- one vehicle, one client, everything for them at once.
    const byClient = new Map();
    rows.forEach(l => {
      const key = l.clientName || 'Unassigned';
      if (!byClient.has(key)) byClient.set(key, []);
      byClient.get(key).push(l);
    });

    listEl.innerHTML = [...byClient.entries()].map(([client, lines]) => `
      <div class="mapp-section-label">${MApp.Util.escapeHtml(MApp.Util.formatNameCase(client))}</div>
      ${lines.map(l => `
        <div class="mb-card">
          <div class="mb-card-row">
            <div>
              <div class="mb-card-title">${MApp.Util.escapeHtml(l.productName || l.productId)}</div>
              <div class="mb-card-sub">${MApp.Util.escapeHtml(l.productId)}${l.transport ? ' · ' + MApp.Util.escapeHtml(l.transport) : ''}</div>
            </div>
            <div style="text-align:right;">
              <div class="mb-card-number">${MApp.Util.formatQty(l.qty)}</div>
            </div>
          </div>
          ${l.remarks ? `<div class="mb-card-sub mb-mt-2">${MApp.Util.escapeHtml(l.remarks)}</div>` : ''}
          ${l.fulfilled
    // A dispatched line is a record, not a plan any more. The server
    // refuses to edit or remove one, so offering either would be
    // offering a save that bounces.
    ? `<div class="mb-mt-2"><span class="mb-chip mb-chip-completed">Dispatched${l.fulfilledDispatchNumber ? ' · ' + MApp.Util.escapeHtml(l.fulfilledDispatchNumber) : ''}</span></div>`
    : `<div class="mb-mt-2" style="display:flex; gap:var(--mb-sp-4);">
             <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" data-plan-action="edit" data-plan-line="${l.lineId}">Edit</button>
             <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;color:var(--mb-enamel-red-ink);" data-plan-action="remove" data-plan-line="${l.lineId}">Remove</button>
           </div>`}
        </div>`).join('')}
    `).join('');

    listEl.querySelectorAll('[data-plan-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const line = rows.find(l => String(l.lineId) === btn.dataset.planLine);
        if (!line) return;
        if (btn.dataset.planAction === 'edit') this.openForm(line);
        else this.remove(line);
      });
    });
  },

  // ── The form ─────────────────────────────────────────────────────────
  async openForm(line) {
    this.editing = line || null;
    this.selection = {
      clientName: line ? line.clientName : '',
      productId: line ? line.productId : '',
      productName: line ? (line.productName || '') : ''
    };

    const titleEl = document.getElementById('dispatch-plan-form-title');
    if (titleEl) titleEl.textContent = line ? 'Edit plan line' : 'Add to plan';
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set('plan-line-date', line ? String(line.planDate || '').slice(0, 10) : this.planDate);
    set('plan-line-qty', line ? line.qty : '');
    set('plan-line-rate', line && line.rate ? line.rate : '');
    set('plan-line-remarks', line ? (line.remarks || '') : '');
    set('plan-line-transport', line ? (line.transport || '') : '');

    this._paintClient();
    this._paintProduct();
    MApp.Sheet.open('sheet-dispatch-plan-form');

    const [clientsRes, productsRes] = await Promise.all([
      MApp.Api.call('getClientsData').catch(() => null),
      MApp.Api.call('getBOMProductionData').catch(() => null)
    ]);
    this.clients = clientsRes && clientsRes.success ? (clientsRes.data || []) : [];
    this.products = productsRes && productsRes.success ? (productsRes.data || []) : [];
  },

  closeForm() { MApp.Sheet.close('sheet-dispatch-plan-form'); },

  _paintClient() {
    const el = document.getElementById('plan-line-client-field');
    if (!el) return;
    const name = this.selection.clientName;
    el.textContent = name ? MApp.Util.formatNameCase(name) : 'Choose a client…';
    el.classList.toggle('mb-placeholder', !name);
  },

  _paintProduct() {
    const el = document.getElementById('plan-line-product-field');
    if (!el) return;
    const id = this.selection.productId;
    el.textContent = id ? `${this.selection.productName || id} (${id})` : 'Choose a product…';
    el.classList.toggle('mb-placeholder', !id);
  },

  async pickClient() {
    if (!this.clients.length) { MApp.Toast.error('Client list is still loading. Try again in a moment.'); return; }
    const picked = await MApp.Picker.open({
      title: 'Choose a client',
      items: this.clients.map(c => ({ value: c.name, label: MApp.Util.formatNameCase(c.name), sublabel: c.contact || '' })),
      selectedValue: this.selection.clientName
    });
    if (!picked) return;
    this.selection.clientName = picked.value;
    this._paintClient();
  },

  async pickProduct() {
    if (!this.products.length) { MApp.Toast.error('Product list is still loading. Try again in a moment.'); return; }
    const picked = await MApp.Picker.open({
      title: 'Choose a product',
      items: this.products.map(p => ({ value: p.productId, label: p.productName, sublabel: p.productId })),
      selectedValue: this.selection.productId
    });
    if (!picked) return;
    const match = this.products.find(p => p.productId === picked.value);
    this.selection.productId = picked.value;
    this.selection.productName = match ? match.productName : picked.label;
    this._paintProduct();
  },

  async save() {
    if (!this.selection.clientName) { MApp.Toast.error('Choose a client.'); return; }
    if (!this.selection.productId) { MApp.Toast.error('Choose a product.'); return; }

    const qty = MApp.Util.toNumber(document.getElementById('plan-line-qty')?.value);
    if (!(qty > 0)) { MApp.Toast.error('Enter a quantity greater than zero.'); return; }

    // A new line goes to the end of its day rather than the front. The
    // board's order is somebody's loading sequence, and inserting into
    // the middle of it from here would rearrange a plan nobody asked to
    // rearrange.
    const sortOrder = this.editing
      ? (this.editing.sortOrder || 0)
      : this.forDate().reduce((n, l) => Math.max(n, l.sortOrder || 0), 0) + 1;

    const payload = {
      lineId: this.editing ? this.editing.lineId : '',
      planDate: document.getElementById('plan-line-date')?.value || this.planDate,
      clientName: this.selection.clientName,
      productId: this.selection.productId,
      qty,
      sortOrder,
      rate: MApp.Util.toNumber(document.getElementById('plan-line-rate')?.value),
      remarks: document.getElementById('plan-line-remarks')?.value || '',
      transport: document.getElementById('plan-line-transport')?.value || ''
    };

    const btn = document.getElementById('dispatch-plan-save-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    const res = await MApp.Util.mutateSimple('saveDispatchPlanLine', [payload], null);
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
    if (!res.success) return;

    MApp.Toast.success(res.message || 'Plan updated.');
    this.closeForm();
    // The saved line may have moved to another day, so follow it rather
    // than leaving the operator looking at a list it is no longer in.
    this.planDate = payload.planDate;
    const dateEl = document.getElementById('dispatch-plan-date');
    if (dateEl) dateEl.value = this.planDate;
    this.load();
  },

  async remove(line) {
    if (!window.confirm(`Remove ${line.productName || line.productId} for ${MApp.Util.formatNameCase(line.clientName)} from this plan? The dispatch itself is not affected.`)) return;
    const res = await MApp.Util.mutateSimple('deleteDispatchPlanLine', [line.lineId], null);
    if (res.success) {
      MApp.Toast.success(res.message || 'Removed from plan.');
      this.load();
    }
  }
};
// ================================================================
// CLIENT ORDERS — PI / Estimates (More tab).
//
// A PI is where a client's order enters the system, and marking one
// "Order Confirmed" is what queues the Production lots against it. That
// whole entry point was desktop-only: an order taken on the phone had to
// wait for somebody to reach a laptop before any of it could be made.
//
// Header plus lines, edit-by-replace, exactly like BOM. Product IDs come
// from getBOMProductionData because the server validates every line
// against BOM and rejects anything not defined there -- so the picker
// offers only what will be accepted, rather than letting the operator
// type something the save will bounce.
// ================================================================
MApp.ClientOrders = {
  STATUSES: ['Estimate', 'Order Confirmed', 'Cancelled'],

  // deleteClientOrdersBulk deletes what it can and names what it skipped
  // (anything with a dispatch record or a queued production lot), so a
  // selection that includes an untouchable PI still clears the rest.
  SELECT: {
    key: 'clientOrder', noun: 'PI / Estimate', plural: 'PI / Estimates',
    method: 'deleteClientOrdersBulk',
    payload: rows => [rows.map(r => r.orderNumber)],
    onDone: () => MApp.ClientOrders.open()
  },

  // Product name and ID make an order findable by what was ordered, not
  // only by its number or the client who placed it.
  SEARCH: {
    fields: [
      { key: 'orderNumber', weight: 10, label: 'PI' },
      { key: 'clientName', weight: 8, label: 'Client' },
      { key: '_products', weight: 5, label: 'Products' },
      { key: 'status', weight: 2, label: 'Status' },
      { key: 'orderRemarks', weight: 2, label: 'Remarks' }
    ]
  },

  orders: [],
  entries: [],
  filtered: [],
  searchTerm: '',
  statusFilter: 'all',
  clients: [],
  products: [],
  editing: null,
  lines: [],
  selection: null,

  async open() {
    const listEl = document.getElementById('client-orders-list');
    const input = document.getElementById('client-orders-search');
    if (input) input.value = '';
    this.searchTerm = '';
    MApp.SearchBox.attach('client-orders-search', term => this.onSearch(term));

    MApp.Util.renderSkeleton(listEl, 5);
    MApp.Sheet.open('sheet-client-orders');

    try {
      const res = await MApp.Api.call('getClientOrdersData');
      if (!res || !res.success) {
        MApp.Util.renderError(listEl, res && res.message, () => this.open());
        return;
      }
      this.orders = (res.data || []).map(o => ({
        ...o,
        _products: (o.lines || []).map(l => `${l.productId} ${l.productName}`).join(' ')
      }));
      this.entries = MApp.Search.index(this.orders, this.SEARCH);
      MApp.Paging.reset('clientOrder');
      this._applyFilters();
      this.render();
    } catch (err) {
      MApp.Util.renderError(listEl, err && err.message, () => this.open());
    }
  },

  close() { MApp.Sheet.close('sheet-client-orders'); },

  onSearch(term) {
    this.searchTerm = term || '';
    MApp.Paging.reset('clientOrder');
    this._applyFilters();
    this.render();
  },

  filterBy(status) {
    this.statusFilter = status || 'all';
    MApp.Paging.reset('clientOrder');
    const bar = document.getElementById('client-orders-filters');
    if (bar) {
      bar.querySelectorAll('[data-order-filter]').forEach(b => {
        const on = b.dataset.orderFilter === this.statusFilter;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
    this._applyFilters();
    this.render();
  },

  _applyFilters() {
    const hits = MApp.Search.run(this.entries, this.searchTerm);
    this.filtered = this.statusFilter === 'all'
      ? hits
      : hits.filter(o => o.status === this.statusFilter);
  },

  _statusChipClass(status) {
    if (status === 'Order Confirmed') return 'mb-chip-completed';
    if (status === 'Cancelled') return 'mb-chip-cancelled';
    return 'mb-chip-pending';
  },

  render() {
    const listEl = document.getElementById('client-orders-list');
    if (!listEl) return;

    const page = MApp.Paging.take('clientOrder', this.filtered, () => this.render());
    MApp.SearchBox.setCount('client-orders-search', page.shown, page.total, page.meta);

    if (this.filtered.length === 0) {
      MApp.Util.renderEmpty(listEl, {
        title: 'No PI / Estimates',
        body: this.searchTerm.trim() || this.statusFilter !== 'all'
          ? 'Nothing matches this search and filter.'
          : 'Tap New to record the first one.'
      });
      return;
    }

    listEl.innerHTML = page.rows.map((o, i) => {
      const lines = o.lines || [];
      const totalQty = lines.reduce((sum, l) => sum + (Number(l.qty) || 0), 0);
      // A line the server could not map to a single final-stage process
      // is marked Manual: the PI is confirmed but nothing was queued for
      // it, and somebody has to log that lot by hand. That is the one
      // thing on this card worth interrupting for.
      const manual = lines.filter(l => l.needsManualProduction).length;
      return `
      <div class="mb-card">
        <div class="mb-card-row">
          <div>
            <div class="mb-card-title">${MApp.Util.escapeHtml(o.orderNumber)}</div>
            <div class="mb-card-sub">${MApp.Util.escapeHtml(MApp.Util.formatNameCase(o.clientName))}</div>
            <div class="mb-card-sub">${MApp.Util.escapeHtml(o.orderDate || '')}</div>
          </div>
          <div style="text-align:right;">
            <span class="mb-chip ${this._statusChipClass(o.status)}">${MApp.Util.escapeHtml(o.status)}</span>
            <div class="mb-card-sub mb-mt-2">${lines.length} line(s) · ${MApp.Util.formatQty(totalQty)}</div>
          </div>
        </div>
        ${manual ? `<div class="mb-mt-2 mb-text-sm" style="color:var(--mb-enamel-amber-ink);">${manual} line(s) need a Production lot logged by hand.</div>` : ''}
        ${o.orderRemarks ? `<div class="mb-card-sub mb-mt-2">${MApp.Util.escapeHtml(o.orderRemarks)}</div>` : ''}
        <div class="mb-mt-2" style="display:flex; gap:var(--mb-sp-4); flex-wrap:wrap;">
          <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" data-order-action="edit" data-order-index="${i}">Open</button>
          <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;color:var(--mb-enamel-red-ink);" data-order-action="delete" data-order-index="${i}">Delete</button>
        </div>
      </div>`;
    }).join('') + MApp.Paging.moreHtml(page);

    listEl.querySelectorAll('[data-order-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const o = page.rows[Number(btn.dataset.orderIndex)];
        if (!o) return;
        if (btn.dataset.orderAction === 'edit') this.openForm(o);
        else this.remove(o);
      });
    });

    MApp.Select.enable(listEl, page.rows, this.SELECT);
  },

  // ── Form ─────────────────────────────────────────────────────────────
  async openForm(order) {
    this.editing = order || null;
    this.selection = {
      clientName: order ? order.clientName : '',
      status: order ? order.status : 'Estimate'
    };
    this.lines = order && (order.lines || []).length
      ? order.lines.map(l => ({
        productId: l.productId,
        productName: l.productName,
        qty: l.qty,
        lineRemarks: l.lineRemarks || ''
      }))
      : [{ productId: '', productName: '', qty: '', lineRemarks: '' }];

    const titleEl = document.getElementById('client-order-form-title');
    if (titleEl) titleEl.textContent = order ? order.orderNumber : 'New PI / Estimate';

    const dateEl = document.getElementById('client-order-date');
    if (dateEl) dateEl.value = (order && order.dateRaw) || MApp.Util.todayInputValue();
    const remarksEl = document.getElementById('client-order-remarks');
    if (remarksEl) remarksEl.value = (order && order.orderRemarks) || '';

    this._paintClient();
    this._paintStatus();
    this._renderLines();
    MApp.Sheet.open('sheet-client-order-form');

    // Both pickers are best-effort and independent: a failed client list
    // must not also cost the operator the product list.
    const [clientsRes, productsRes] = await Promise.all([
      MApp.Api.call('getClientsData').catch(() => null),
      MApp.Api.call('getBOMProductionData').catch(() => null)
    ]);
    this.clients = clientsRes && clientsRes.success ? (clientsRes.data || []) : [];
    this.products = productsRes && productsRes.success ? (productsRes.data || []) : [];
  },

  closeForm() { MApp.Sheet.close('sheet-client-order-form'); },

  _paintClient() {
    const el = document.getElementById('client-order-client-field');
    if (!el) return;
    const name = this.selection.clientName;
    el.textContent = name ? MApp.Util.formatNameCase(name) : 'Choose a client…';
    el.classList.toggle('mb-placeholder', !name);
  },

  _paintStatus() {
    const el = document.getElementById('client-order-status-field');
    if (el) el.textContent = this.selection.status;
    // Confirming is the consequential one and it is not obvious from the
    // word alone that saving here creates Production lots.
    const hint = document.getElementById('client-order-status-hint');
    if (hint) {
      hint.textContent = this.selection.status === 'Order Confirmed'
        ? 'Saving queues a Pending Production lot for each line whose product maps to one final-stage process. Lines that do not map are flagged for you to log by hand.'
        : 'Nothing is queued into Production until this is Order Confirmed.';
    }
  },

  async pickClient() {
    if (!this.clients.length) {
      MApp.Toast.error('Client list is still loading. Try again in a moment.');
      return;
    }
    const picked = await MApp.Picker.open({
      title: 'Choose a client',
      items: this.clients.map(c => ({ value: c.name, label: MApp.Util.formatNameCase(c.name), sublabel: c.contact || '' })),
      selectedValue: this.selection.clientName
    });
    if (!picked) return;
    this.selection.clientName = picked.value;
    this._paintClient();
  },

  async pickStatus() {
    const picked = await MApp.Picker.open({
      title: 'Status',
      items: this.STATUSES.map(s => ({ value: s, label: s })),
      selectedValue: this.selection.status
    });
    if (!picked) return;
    this.selection.status = picked.value;
    this._paintStatus();
  },

  _linesHtml() {
    return this.lines.map((line, i) => `
      <div class="mb-card" style="padding:var(--mb-sp-3);">
        <div class="mb-field" style="margin-bottom:var(--mb-sp-2);">
          <label>Product</label>
          <button type="button" class="mb-picker-field${line.productId ? '' : ' mb-placeholder'}" onclick="MApp.ClientOrders.pickLineProduct(${i})">${line.productId ? MApp.Util.escapeHtml(line.productName || line.productId) + ` (${MApp.Util.escapeHtml(line.productId)})` : 'Choose a product…'}</button>
        </div>
        <div class="mb-field" style="margin-bottom:var(--mb-sp-2);">
          <label>Quantity</label>
          <input type="number" inputmode="decimal" min="0" step="any" value="${line.qty || ''}" oninput="MApp.ClientOrders.updateLine(${i}, 'qty', this.value)">
        </div>
        <div class="mb-field" style="margin-bottom:0;">
          <label>Line remarks</label>
          <input type="text" value="${MApp.Util.escapeHtml(line.lineRemarks || '')}" oninput="MApp.ClientOrders.updateLine(${i}, 'lineRemarks', this.value)">
        </div>
        ${this.lines.length > 1 ? `<button type="button" class="mb-btn-text mb-mt-2" style="padding:0;min-height:auto;color:var(--mb-enamel-red-ink);" onclick="MApp.ClientOrders.removeLine(${i})">Remove</button>` : ''}
      </div>`).join('');
  },

  _renderLines() {
    const el = document.getElementById('client-order-lines');
    if (el) el.innerHTML = this._linesHtml();
  },

  addLine() {
    this.lines.push({ productId: '', productName: '', qty: '', lineRemarks: '' });
    this._renderLines();
  },

  removeLine(i) {
    this.lines.splice(i, 1);
    if (this.lines.length === 0) this.lines.push({ productId: '', productName: '', qty: '', lineRemarks: '' });
    this._renderLines();
  },

  updateLine(i, key, value) {
    if (!this.lines[i]) return;
    this.lines[i][key] = key === 'qty' ? MApp.Util.toNumber(value) : value;
  },

  async pickLineProduct(i) {
    if (!this.lines[i]) return;
    if (!this.products.length) {
      MApp.Toast.error('Product list is still loading. Try again in a moment.');
      return;
    }
    const picked = await MApp.Picker.open({
      title: 'Choose a product',
      items: this.products.map(p => ({ value: p.productId, label: p.productName, sublabel: p.productId })),
      selectedValue: this.lines[i].productId
    });
    if (!picked || !this.lines[i]) return;
    const match = this.products.find(p => p.productId === picked.value);
    this.lines[i].productId = picked.value;
    this.lines[i].productName = match ? match.productName : picked.label;
    this._renderLines();
  },

  async save() {
    const client = this.selection.clientName;
    if (!client) { MApp.Toast.error('Choose a client.'); return; }

    const lines = this.lines
      .filter(l => l.productId && MApp.Util.toNumber(l.qty) > 0)
      .map(l => ({
        productId: l.productId,
        productName: l.productName,
        qty: MApp.Util.toNumber(l.qty),
        lineRemarks: String(l.lineRemarks || '').trim()
        // productionPushed is deliberately not sent: save_client_order
        // recomputes it per product from the rows already in the table
        // (a COUNT, not a flag), so a second line for a product that was
        // pushed once is not wrongly marked pushed. A value from here
        // would be ignored, and sending one would read as if it mattered.
      }));

    if (lines.length === 0) {
      MApp.Toast.error('Add at least one product line with a quantity.');
      return;
    }

    const payload = {
      orderNumber: this.editing ? this.editing.orderNumber : '',
      clientName: client,
      status: this.selection.status,
      orderDate: document.getElementById('client-order-date')?.value || '',
      orderRemarks: document.getElementById('client-order-remarks')?.value || '',
      lines
    };

    const btn = document.getElementById('client-order-save-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    const res = await MApp.Util.mutateSimple('saveClientOrder', [payload], null);
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
    if (!res.success) return;

    // The server's message is the only place that says how many lines
    // were queued into Production and how many need logging by hand.
    // Replacing it with "Saved." would drop the half of the outcome the
    // operator has to act on.
    MApp.Toast.success(res.message || 'PI / Estimate saved.');
    this.closeForm();
    this.open();
  },

  async remove(order) {
    // The server refuses this outright when the PI has dispatch records
    // or a queued Production lot, and says which. Nothing is pre-judged
    // here; the refusal is reported as it comes back.
    if (!window.confirm(`Delete PI / Estimate ${order.orderNumber} for ${MApp.Util.formatNameCase(order.clientName)}? Its ${(order.lines || []).length} line(s) go with it.`)) return;
    const res = await MApp.Util.mutateSimple('deleteClientOrder', [order.orderNumber], null);
    if (res.success) {
      MApp.Toast.success(res.message || 'PI / Estimate deleted.');
      this.open();
    }
  }
};

// ================================================================
// PRODUCTION SHEET — a lot's customized component list.
//
// What actually goes out with a lot is not always what its recipe says:
// a substitution asked for by the customer, a size swapped at the
// machine. The Production Sheet records that separately from the lot's
// real consumption, which it never touches. Making one was desktop-only,
// so the change was made at the machine and written down at a desk later
// if at all.
//
// Desktop renders this as a Common table plus a per-colour matrix with
// one column per colour. That is a rendering, not the data: underneath
// it is a flat list of components each tagged with its own colour, which
// is exactly what save_production_sheet stores and reads back. This
// screen groups that same list by colour down the page instead of across
// it -- nothing is lost, and a wide editable grid is the wrong shape for
// a phone held in one hand.
//
// Not ported: printing the sheet. That is desktop's own layout work and
// is tracked separately; the data is the part that could not be entered
// anywhere else.
// ================================================================
MApp.ProductionSheet = {
  lot: null,
  rows: [],
  remarks: '',

  // The lot's own recorded consumption is the fallback, not a BOM:
  // production lots are tied to a Process recipe, not a Product recipe,
  // so there is nothing else to fall back to. Same rule as desktop's
  // _populateProductionSheetData.
  _rowsFor(lot) {
    const custom = lot.customComponents || [];
    const source = custom.length > 0 ? custom : (lot.componentsConsumed || []);
    return source.map(c => ({
      itemName: c.itemName || '',
      size: c.size || '',
      narration: c.narration || '',
      color: this._colorKey(c),
      requiredQty: c.requiredQty !== undefined ? MApp.Util.toNumber(c.requiredQty) : MApp.Util.toNumber(c.qty)
    }));
  },

  // A recorded-consumption row carries colorGroup ('COMMON' for the
  // shared ones); a saved sheet row carries color and no colorGroup at
  // all. Reading both is what lets a sheet be re-opened into the same
  // grouping it was saved from -- desktop's _resolveSheetColorKey.
  _colorKey(c) {
    const group = String(c.colorGroup || '').trim();
    if (group && group.toUpperCase() !== 'COMMON') return group;
    return String(c.color || '').trim();
  },

  open(lot) {
    if (!lot) return;
    this.lot = lot;
    this.rows = this._rowsFor(lot);
    this.remarks = lot.sheetRemarks || '';

    const titleEl = document.getElementById('production-sheet-title');
    if (titleEl) titleEl.textContent = `Sheet — ${lot.lotNumber}`;
    const subEl = document.getElementById('production-sheet-sub');
    if (subEl) {
      subEl.textContent = `${lot.productName || lot.outputItemName || lot.processId || ''} · ${MApp.Util.formatQty(lot.qty)} unit(s)`;
    }
    const remarksEl = document.getElementById('production-sheet-remarks');
    if (remarksEl) remarksEl.value = this.remarks;

    this.render();
    MApp.Sheet.open('sheet-production-sheet');
  },

  close() { MApp.Sheet.close('sheet-production-sheet'); },

  render() {
    const body = document.getElementById('production-sheet-body');
    if (!body) return;

    const custom = (this.lot.customComponents || []).length > 0;
    const banner = custom
      ? ''
      : '<div class="mb-field-hint mb-mb-4">Starting from what this lot actually consumed. Nothing is customized until you save.</div>';

    if (this.rows.length === 0) {
      body.innerHTML = banner;
      const empty = document.createElement('div');
      body.appendChild(empty);
      MApp.Util.renderEmpty(empty, {
        title: 'No components',
        body: 'This lot recorded no consumption. Add the rows this sheet should show.'
      });
      return;
    }

    // Grouped by colour, blank first: the shared components come before
    // the ones that only apply to one colour, which is the order they are
    // read in on the floor.
    const groups = new Map();
    this.rows.forEach((r, i) => {
      const key = r.color || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ row: r, i });
    });
    const keys = [...groups.keys()].sort((a, b) => {
      if (a === '') return -1;
      if (b === '') return 1;
      return a.localeCompare(b);
    });

    body.innerHTML = banner + keys.map(key => `
      <div class="mapp-section-label">${key ? MApp.Util.escapeHtml(key) : 'Common — all colours'}</div>
      ${groups.get(key).map(({ row, i }) => `
        <div class="mb-card" style="padding:var(--mb-sp-3);">
          <div class="mb-card-title">${MApp.Util.escapeHtml(row.itemName)}</div>
          ${row.size || row.narration ? `<div class="mb-card-sub">${MApp.Util.escapeHtml([row.size, row.narration].filter(Boolean).join(' · '))}</div>` : ''}
          <div class="mb-field mb-mt-2" style="margin-bottom:0;">
            <label for="prod-sheet-qty-${i}">Required quantity</label>
            <input type="number" id="prod-sheet-qty-${i}" inputmode="decimal" min="0" step="any"
                   value="${row.requiredQty === '' ? '' : row.requiredQty}" data-sheet-qty="${i}">
          </div>
          <button type="button" class="mb-btn-text mb-mt-2" style="padding:0;min-height:auto;color:var(--mb-enamel-red-ink);" data-sheet-remove="${i}">Remove</button>
        </div>`).join('')}
    `).join('');

    body.querySelectorAll('[data-sheet-qty]').forEach(input => {
      input.addEventListener('input', () => {
        const row = this.rows[Number(input.dataset.sheetQty)];
        if (row) row.requiredQty = MApp.Util.toNumber(input.value);
      });
    });
    body.querySelectorAll('[data-sheet-remove]').forEach(btn => {
      btn.addEventListener('click', () => this.removeRow(Number(btn.dataset.sheetRemove)));
    });
  },

  // Reads the live inputs before any action that re-renders, so a
  // quantity typed but not yet blurred is not thrown away by adding a
  // row or removing another one.
  _readQtys() {
    const body = document.getElementById('production-sheet-body');
    if (!body) return;
    body.querySelectorAll('[data-sheet-qty]').forEach(input => {
      const row = this.rows[Number(input.dataset.sheetQty)];
      if (row) row.requiredQty = MApp.Util.toNumber(input.value);
    });
  },

  removeRow(i) {
    this._readQtys();
    this.rows.splice(i, 1);
    this.render();
  },

  async addRow() {
    this._readQtys();
    const items = await this._items();
    if (!items.length) {
      MApp.Toast.error('Could not load the item list. Try again in a moment.');
      return;
    }
    const picked = await MApp.Picker.open({
      title: 'Add an item',
      items: items.map(it => ({
        value: it.name + '||' + (it.size || ''), label: it.name, sublabel: it.size ? `Size: ${it.size}` : ''
      }))
    });
    if (!picked) return;
    const match = items.find(it => (it.name + '||' + (it.size || '')) === picked.value);

    // A new row lands in Common. Tagging it to a colour is the one thing
    // this screen cannot infer, and guessing a colour would put a
    // quantity against a colour nobody chose.
    this.rows.push({
      itemName: match ? match.name : picked.label,
      size: match ? (match.size || '') : '',
      narration: '',
      color: '',
      requiredQty: ''
    });
    this.render();
  },

  async _items() {
    if (this._itemCache) return this._itemCache;
    try {
      const res = await MApp.Api.call('getItemsData');
      this._itemCache = (res && res.success) ? (res.data || []) : [];
    } catch (err) {
      this._itemCache = [];
    }
    return this._itemCache;
  },

  // Back to what the lot actually consumed. The customization is only
  // discarded once this is saved, so this is a local reset, not a write.
  reset() {
    if (!window.confirm('Discard this sheet’s changes and go back to what the lot consumed? Nothing is saved until you tap Save.')) return;
    this.rows = (this.lot.componentsConsumed || []).map(c => ({
      itemName: c.itemName || '',
      size: c.size || '',
      narration: c.narration || '',
      color: this._colorKey(c),
      requiredQty: MApp.Util.toNumber(c.qty)
    }));
    this.render();
  },

  async save() {
    const lot = this.lot;
    if (!lot) return;
    this._readQtys();

    const remarksEl = document.getElementById('production-sheet-remarks');
    const remarks = remarksEl ? remarksEl.value.trim() : '';

    // The server drops any row with no item name and any quantity outside
    // 0..10,000,000; filtering here means the saved sheet matches what is
    // on screen rather than quietly losing rows on the way.
    const components = this.rows
      .filter(r => r.itemName && MApp.Util.toNumber(r.requiredQty) > 0)
      .map(r => ({
        itemName: r.itemName,
        size: r.size || '',
        narration: r.narration || '',
        color: r.color || '',
        requiredQty: MApp.Util.toNumber(r.requiredQty)
      }));

    // An empty sheet is a real instruction -- it clears the customization
    // and the lot falls back to its recorded consumption -- but it is not
    // what someone who mistyped a quantity meant, so it is confirmed.
    if (components.length === 0 &&
        !window.confirm('Save an empty sheet? This clears the customization and the lot goes back to showing what it consumed.')) return;

    const btn = document.getElementById('production-sheet-save-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

    // expected_product_id / expected_qty are the server's concurrency
    // guard: it refuses if the lot shifted since this list was drawn,
    // which on a phone showing a list loaded some time ago is a real
    // possibility. Sent exactly as desktop sends them.
    let res;
    try {
      res = await Api.mutateWithId(
        'saveProductionSheet', Api.newMutationId(),
        lot.rowIdx, lot.productId, lot.qty, JSON.stringify(components), remarks
      );
    } catch (err) {
      MApp.Toast.error(err.message || 'Could not reach the server. Please try again.');
      if (btn) { btn.disabled = false; btn.textContent = 'Save sheet'; }
      return;
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Save sheet'; }

    if (!res || !res.success) {
      MApp.Toast.error((res && res.message) || 'Could not save this sheet.');
      return;
    }

    // Patch the lot in place from what the server echoed back, so
    // re-opening the sheet shows what was stored rather than what was
    // typed -- the server normalises narration against Items Master.
    lot.customComponents = (res.data && res.data.customComponents) || components;
    lot.sheetRemarks = (res.data && res.data.sheetRemarks) || remarks;

    MApp.Toast.success(res.message || 'Production sheet saved.');
    this.close();
  }
};

// ================================================================
// FULL DASHBOARD — the drill-down behind Home's three tiles.
//
// Home deliberately uses getMobileDashboard: three numbers is the right
// default on a phone, and computing the full set on every tab visit
// would not be. But defaulting to less is different from being capped at
// less, and the reduced endpoint was the only dashboard mobile could ever
// show. This is the rest of it, on request.
// ================================================================
MApp.Dashboard = {
  async open() {
    const body = document.getElementById('dashboard-body');
    MApp.Util.renderSkeleton(body, 5);
    MApp.Sheet.open('sheet-dashboard');
    try {
      const res = await MApp.Api.call('getDashboardData');
      if (!res || !res.success) {
        MApp.Util.renderError(body, res && res.message, () => this.open());
        return;
      }
      this.render(res.data || {});
    } catch (err) {
      MApp.Util.renderError(body, err && err.message, () => this.open());
    }
  },

  close() { MApp.Sheet.close('sheet-dashboard'); },

  render(data) {
    const body = document.getElementById('dashboard-body');
    if (!body) return;
    const k = data.kpis || {};
    const money = v => MApp.Util.formatCurrency(v || 0);
    const qty = v => MApp.Util.formatQty(v || 0);

    const tile = (label, value, sub) => `
      <div class="mb-stat-tile" style="cursor:default;">
        <div class="mb-stat-tile-top"><span class="mb-stat-tile-label">${MApp.Util.escapeHtml(label)}</span></div>
        <div class="mb-stat-tile-value">${MApp.Util.escapeHtml(String(value))}</div>
        ${sub ? `<div class="mb-card-sub">${MApp.Util.escapeHtml(sub)}</div>` : ''}
      </div>`;

    const list = (rows, render, emptyText) => rows && rows.length
      ? rows.map(render).join('')
      : `<div class="mb-text-sm mb-text-steel" style="padding:var(--mb-sp-2) 0;">${emptyText}</div>`;

    body.innerHTML = `
      <div class="mb-stat-grid">
        ${tile('Open POs', k.openPoCount || 0, money(k.openPoValue))}
        ${tile('Bills this month', k.billsThisMonthCount || 0, money(k.billsThisMonthValue))}
        ${tile('Low stock', k.lowStockCount || 0, `${qty(k.lowStockTotalDeficit)} short`)}
        ${tile('In progress', k.inProgressProductionCount || 0, `${k.queuedProductionCount || 0} queued`)}
        ${tile('Ready to dispatch', qty(k.readyToDispatchUnits), `${k.readyToDispatchProductCount || 0} product(s)`)}
        ${tile('Contractor payables', money(k.contractorPayablesDue), `${k.contractorPayablesCount || 0} contractor(s)`)}
      </div>

      ${k.oldestPendingProductionDays ? `
        <div class="mb-offline-banner" style="background:var(--mb-enamel-amber-bg);color:var(--mb-enamel-amber-ink);margin:var(--mb-sp-3) 0;">
          <span>Oldest pending lot has been waiting ${k.oldestPendingProductionDays} day(s).</span>
        </div>` : ''}

      <div class="mapp-section-label mb-mt-4">Low stock</div>
      ${list(data.lowStockItems, i => `
        <div class="mb-card">
          <div class="mb-card-row">
            <div>
              <div class="mb-card-title">${MApp.Util.escapeHtml(i.name)}</div>
              <div class="mb-card-sub">${MApp.Util.escapeHtml(i.size || 'General')}</div>
            </div>
            <div style="text-align:right;">
              <div class="mb-card-number mb-alert">${qty(i.currentStock)}</div>
              <div class="mb-card-sub">need ${qty(i.threshold)}</div>
            </div>
          </div>
        </div>`, 'Nothing below its threshold.')}
      ${data.lowStockTotalCount > (data.lowStockItems || []).length
    ? `<div class="mb-card-sub">+${data.lowStockTotalCount - data.lowStockItems.length} more — open Stock to see them all.</div>` : ''}

      <div class="mapp-section-label mb-mt-4">Ready to dispatch</div>
      ${list(data.readyToDispatchItems, r => `
        <div class="mb-card">
          <div class="mb-card-row">
            <span class="mb-card-title">${MApp.Util.escapeHtml(r.productName)}</span>
            <span class="mb-card-number">${qty(r.readyQty)}</span>
          </div>
        </div>`, 'Nothing ready.')}

      <div class="mapp-section-label mb-mt-4">Contractor payables</div>
      ${list(data.contractorPayables, c => `
        <div class="mb-card">
          <div class="mb-card-row">
            <span class="mb-card-title">${MApp.Util.escapeHtml(MApp.Util.formatNameCase(c.contractorName))}</span>
            <span class="mb-card-number">${money(c.balanceDue)}</span>
          </div>
        </div>`, 'Nothing outstanding.')}`;
  }
};

// ================================================================
// USED IN PROCESSES — which recipes consume one item, and how much.
//
// The read half answers a question asked constantly on the floor and
// previously only answerable at a desk: "what actually uses this part?"
// The write half toggles membership and edits the per-unit quantity.
//
// A removal is not blocked when the process already has lots, because
// past lots keep their own snapshotted Components Consumed and only
// FUTURE lots change -- the server's own reasoning. It is worth saying
// out loud though, so the operator knows the process is live.
// ================================================================
MApp.ItemProcesses = {
  item: null,
  rows: [],

  async open(item) {
    this.item = item;
    this.rows = [];
    const titleEl = document.getElementById('item-processes-title');
    if (titleEl) titleEl.textContent = item.name + (item.size ? ` (${item.size})` : '');
    const body = document.getElementById('item-processes-body');
    MApp.Util.renderSkeleton(body, 4);
    MApp.Sheet.open('sheet-item-processes');

    try {
      const res = await MApp.Api.call('getProcessesForItem', item.name, item.size || '');
      if (!res || !res.success) {
        MApp.Util.renderError(body, res && res.message, () => this.open(item));
        return;
      }
      // A copy per row: `inRecipe` and `qtyPerUnit` are edited in place
      // and the original response stays the baseline for what changed.
      this.rows = (res.data || []).map(p => ({ ...p, _inRecipe: p.inRecipe, _qty: p.qtyPerUnit }));
      this.render();
    } catch (err) {
      MApp.Util.renderError(body, err && err.message, () => this.open(item));
    }
  },

  close() { MApp.Sheet.close('sheet-item-processes'); },

  render() {
    const body = document.getElementById('item-processes-body');
    if (!body) return;
    if (this.rows.length === 0) {
      MApp.Util.renderEmpty(body, {
        title: 'No processes defined',
        body: 'There are no processes to map this item to yet.'
      });
      return;
    }

    body.innerHTML = this.rows.map((p, i) => `
      <div class="mb-card">
        <div class="mb-card-row">
          <div>
            <div class="mb-card-title">${MApp.Util.escapeHtml(p.processName)}</div>
            <div class="mb-card-sub">${MApp.Util.escapeHtml(p.processType || 'General')}${p.active ? '' : ' · inactive'}</div>
          </div>
          <button type="button" class="mb-chip ${p._inRecipe ? 'mb-chip-completed' : ''}"
                  style="border:none;cursor:pointer;min-height:var(--mb-tap-min);"
                  aria-pressed="${p._inRecipe ? 'true' : 'false'}"
                  data-toggle-recipe="${i}">${p._inRecipe ? 'In recipe' : 'Not used'}</button>
        </div>
        ${p._inRecipe ? `
          <div class="mb-field mb-mt-2" style="margin-bottom:0;">
            <label for="item-proc-qty-${i}">Quantity per unit${p.unit ? ` (${MApp.Util.escapeHtml(p.unit)})` : ''}</label>
            <input type="number" id="item-proc-qty-${i}" inputmode="decimal" min="0" step="any"
                   value="${p._qty == null ? '' : p._qty}" data-qty-index="${i}">
          </div>` : ''}
        ${(p.colorVariants || []).length ? `<div class="mb-card-sub mb-mt-2">${p.colorVariants.length} colour variant(s) — edit those on desktop.</div>` : ''}
      </div>`).join('');

    body.querySelectorAll('[data-toggle-recipe]').forEach(btn => {
      btn.addEventListener('click', () => {
        const row = this.rows[Number(btn.dataset.toggleRecipe)];
        if (!row) return;
        this._readQtys();
        row._inRecipe = !row._inRecipe;
        // A newly-added mapping needs a quantity; default rather than
        // send an empty one the server would reject.
        if (row._inRecipe && (row._qty == null || row._qty === '')) row._qty = 1;
        this.render();
      });
    });
  },

  _readQtys() {
    this.rows.forEach((row, i) => {
      const el = document.getElementById('item-proc-qty-' + i);
      if (el) row._qty = el.value;
    });
  },

  async save() {
    this._readQtys();
    const mappings = this.rows.map(p => ({
      processId: p.processId,
      inRecipe: !!p._inRecipe,
      qtyPerUnit: p._inRecipe ? MApp.Util.toNumber(p._qty) : 0
    }));

    const bad = this.rows.find(p => p._inRecipe && MApp.Util.toNumber(p._qty) <= 0);
    if (bad) {
      MApp.Toast.error(`Enter a quantity greater than zero for ${bad.processName}.`);
      return;
    }

    // Removing an item from a live process only affects future lots, but
    // say so rather than let it be discovered later.
    const removed = this.rows.filter(p => p.inRecipe && !p._inRecipe);
    if (removed.length && !window.confirm(
      `Remove this item from ${removed.length} process${removed.length === 1 ? '' : 'es'}? `
      + 'Lots already logged keep the components they were built with; only future lots change.'
    )) return;

    const btn = document.getElementById('item-processes-save-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    const res = await MApp.Util.mutateSimple(
      'saveItemProcessMappings', [this.item.name, this.item.size || '', mappings], 'Processes updated.'
    );
    if (btn) { btn.disabled = false; btn.textContent = 'Save Changes'; }
    if (res.success) this.close();
  }
};

// ================================================================
// SYSTEM STATUS — backup health, recent ledger notifications, and the
// activity log. All three RPCs existed and none was reachable from a
// phone, so "is the backup healthy?" could only be answered at a desk.
//
// The backup section follows the server's own rule about defaults:
// snapshot_verified starts False on purpose, because before any run has
// happened "is there a verified backup?" must answer NO rather than
// render blank and look fine. Nothing here paints an unknown state as
// reassuring.
// ================================================================
MApp.Status = {
  _polling: null,

  isAdmin() {
    const role = (window.MOBILE_CURRENT_USER || {}).role || '';
    return role === 'admin' || role === 'super_admin';
  },

  async open() {
    const body = document.getElementById('status-body');
    MApp.Util.renderSkeleton(body, 4);
    MApp.Sheet.open('sheet-status');
    await this.refresh();
  },

  close() {
    clearTimeout(this._polling);
    this._polling = null;
    MApp.Sheet.close('sheet-status');
  },

  async refresh() {
    // The activity log is admin-only server-side (rpc.py enforces
    // roles={"admin"}); asking as a non-admin would just be a denied call,
    // so don't make it. This is UX, not the gate.
    const [backup, notifications, activity] = await Promise.all([
      MApp.Api.call('getBackupStatus').catch(() => null),
      MApp.Api.call('getRecentNotificationLogs').catch(() => null),
      this.isAdmin() ? MApp.Api.call('getActivityLog', {}, 1, 20).catch(() => null) : Promise.resolve(null)
    ]);
    this.render({
      backup: (backup && backup.success) ? (backup.data || {}) : null,
      notifications: (notifications && notifications.success) ? (notifications.data || []) : null,
      activity: (activity && activity.success) ? (activity.data || {}) : null
    });
  },

  render(data) {
    const body = document.getElementById('status-body');
    if (!body) return;
    const b = data.backup;

    let backupHtml;
    if (!b) {
      backupHtml = `<div class="mb-card"><div class="mb-card-sub">Couldn't reach the backup service.</div></div>`;
    } else {
      // Verified is the only reassuring state. NEVER, a failure, and an
      // unreachable check all read as not-verified rather than as blank.
      const verified = b.snapshot_verified === true;
      const failures = Number(b.consecutive_failures || 0);
      const running = b.run_state === 'running';
      backupHtml = `
        <div class="mb-card">
          <div class="mb-card-row">
            <span class="mb-card-title">Database backup</span>
            <span class="mb-chip ${verified ? 'mb-chip-completed' : 'mb-chip-cancelled'}">${verified ? 'Verified' : 'Not verified'}</span>
          </div>
          <div class="mb-card-sub mb-mt-2">
            ${b.last_verified_at
    ? 'Last verified ' + MApp.Util.escapeHtml(String(b.last_verified_at))
    : 'No backup has been verified yet.'}
          </div>
          ${failures > 0 ? `<div class="mb-card-sub" style="color:var(--mb-enamel-red-ink);">${failures} consecutive failure${failures === 1 ? '' : 's'}.</div>` : ''}
          ${b.mirror_status ? `<div class="mb-card-sub">Mirror: ${MApp.Util.escapeHtml(String(b.mirror_status))}${b.mirror_message ? ' — ' + MApp.Util.escapeHtml(String(b.mirror_message)) : ''}</div>` : ''}
          ${b.message ? `<div class="mb-card-sub">${MApp.Util.escapeHtml(String(b.message))}</div>` : ''}
          ${running ? `<div class="mb-card-sub" style="color:var(--mb-enamel-blue-ink);">Running${b.run_phase_label ? ' — ' + MApp.Util.escapeHtml(String(b.run_phase_label)) : ''}${b.run_percent != null ? ' (' + b.run_percent + '%)' : ''}</div>` : ''}
          ${this.isAdmin() ? `<button type="button" class="mb-btn mb-btn-secondary mb-mt-2" id="status-backup-btn" ${running ? 'disabled' : ''} onclick="MApp.Status.runBackup()">${running ? 'Backup running…' : 'Run a backup now'}</button>` : ''}
        </div>`;
    }

    const notifHtml = data.notifications === null
      ? `<div class="mb-card"><div class="mb-card-sub">Couldn't load recent notifications.</div></div>`
      : (data.notifications.length === 0
        ? `<div class="mb-text-sm mb-text-steel" style="padding:var(--mb-sp-2) 0;">Nothing recent.</div>`
        : data.notifications.slice(0, 20).map(n => `
          <div class="mb-card">
            <div class="mb-card-row">
              <span class="mb-card-title">${MApp.Util.escapeHtml(n.action || '')}</span>
              <span class="mb-card-sub">${MApp.Util.formatDateDisplay(n.timestamp)}</span>
            </div>
            ${n.details ? `<div class="mb-card-sub">${MApp.Util.escapeHtml(String(n.details))}</div>` : ''}
          </div>`).join(''));

    let activityHtml = '';
    if (this.isAdmin()) {
      const entries = data.activity && data.activity.entries;
      activityHtml = `
        <div class="mapp-section-label mb-mt-4">Activity log</div>
        ${data.activity === null
    ? `<div class="mb-card"><div class="mb-card-sub">Couldn't load the activity log.</div></div>`
    : (!entries || entries.length === 0
      ? `<div class="mb-text-sm mb-text-steel" style="padding:var(--mb-sp-2) 0;">No activity recorded.</div>`
      : entries.slice(0, 20).map(e => `
            <div class="mb-card">
              <div class="mb-card-row">
                <div>
                  <div class="mb-card-title">${MApp.Util.escapeHtml(e.action || '')}</div>
                  <div class="mb-card-sub">${MApp.Util.escapeHtml(e.userEmail || '')}${e.entityType ? ' · ' + MApp.Util.escapeHtml(e.entityType) : ''}</div>
                </div>
                <span class="mb-chip ${e.status === 'success' ? 'mb-chip-completed' : 'mb-chip-cancelled'}">${MApp.Util.escapeHtml(e.status || '')}</span>
              </div>
              <div class="mb-card-sub mb-mt-2">${MApp.Util.formatDateDisplay(e.timestamp)}${e.detail ? ' · ' + MApp.Util.escapeHtml(String(e.detail)) : ''}</div>
            </div>`).join(''))}`;
    }

    body.innerHTML = `
      <div class="mapp-section-label">Backup</div>
      ${backupHtml}
      <div class="mapp-section-label mb-mt-4">Recent notifications</div>
      ${notifHtml}
      ${activityHtml}`;
  },

  // triggerBackup returns before the work is done, so the outcome is
  // polled -- and the run state is read from a shared record rather than
  // one worker's memory, which is why polling works across gunicorn
  // workers at all. Stops when the sheet closes.
  async runBackup() {
    const btn = document.getElementById('status-backup-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Starting…'; }
    const res = await MApp.Util.mutateSimple('triggerBackup', [], 'Backup started.');
    if (!res.success) {
      if (btn) { btn.disabled = false; btn.textContent = 'Run a backup now'; }
      return;
    }
    this._poll(0);
  },

  _poll(attempt) {
    clearTimeout(this._polling);
    // ~2 minutes at 4s, then stop rather than poll a factory LAN forever.
    if (attempt > 30) return;
    this._polling = setTimeout(async () => {
      // _stack holds {id, onDismiss} entries, not bare ids.
      if (!MApp.Sheet._stack.some(entry => entry.id === 'sheet-status')) return;
      await this.refresh();
      const running = document.getElementById('status-backup-btn');
      if (running && running.disabled) this._poll(attempt + 1);
    }, 4000);
  }
};

// ================================================================
// WAREHOUSE POOL — read-only, and deliberately so.
//
// A negative bucket here is a SIGNAL, not a number to be corrected. This
// screen therefore offers no adjust, no zero and no delete: the mobile
// job is to let someone on the floor SEE a negative and know which kind
// it is, not to let them tidy it away where the evidence lives.
//
// Two kinds, and telling them apart is the whole point:
//
//   Attribution -- nothing was ever produced in this colour, yet real
//     consumption is recorded against it. The units are almost always
//     sitting in a sibling bucket under a fuller composite name, so the
//     stock exists and is merely misfiled. Desktop reports 189 of 241
//     negative units in this pool are this shape.
//   Needs a count -- produced and consumed both moved, and it still went
//     negative. That is the one that may mean a physical recount is owed.
//
// Once both are just a red negative they are indistinguishable, and the
// genuine "a count is owed" signal gets lost among the misfiled ones.
// Same classification desktop uses (stock.js#isUnattributed), including
// naming the sibling buckets whose colour contains this one.
// ================================================================
MApp.Pool = {
  // Mirrors warehouse_service.color_segments (COLOR_COMBO_DELIMITER
  // = " / "): the axis values of a composite bucket colour.
  // "Purple-Wine / Black" -> ["Purple-Wine", "Black"].
  colorSegments(color) {
    return String(color || '').split(' / ').map(s => s.trim()).filter(Boolean);
  },

  SEARCH: {
    fields: [
      { key: 'outputItemName', weight: 10, label: 'Item' },
      { key: 'color', weight: 6, label: 'Colour' },
      { key: 'productTag', weight: 5, label: 'Product' },
      { key: 'processId', weight: 3, label: 'Process' }
    ]
  },

  rows: [],
  entries: [],
  filtered: [],
  searchTerm: '',
  filter: 'all',

  // producedQty === 0 with real consumption and a colour: the debit side
  // opened this bucket on its own, naming a colour no credit ever used.
  isAttribution(r) {
    return r.producedQty === 0 && r.consumedQty > 0 && !!r.color;
  },

  needsCount(r) {
    return r.availableQty < 0 && !this.isAttribution(r);
  },

  // The buckets for the same item that DID produce, and whose composite
  // colour contains this bucket's colour as one of its segments. Naming
  // them is what lets someone act on an attribution negative without
  // deleting or zeroing anything.
  siblings(r) {
    if (!this.isAttribution(r)) return [];
    const item = String(r.outputItemName || '').trim().toLowerCase();
    const color = String(r.color || '').trim().toLowerCase();
    return this.rows
      .filter(x => String(x.outputItemName || '').trim().toLowerCase() === item
        && x.producedQty > 0
        && this.colorSegments(x.color).some(s => s.toLowerCase() === color))
      .map(x => x.color);
  },

  // Called by MApp.Stock the first time the pool pane is shown in a tab
  // visit. Resets the query and filter, because the pane's markup came
  // back fresh from the template and its inputs are blank again.
  mount() {
    this.searchTerm = '';
    this.filter = 'all';
    MApp.SearchBox.attach('pool-search', term => this.onSearch(term));
    this.load();
  },

  // Navigates to the pool rather than opening it: this list is the second
  // pane of the Stock tab now, not a sheet. Kept under the old name
  // because every entry point into the pool -- the More tab's card,
  // global search -- asks for it this way.
  open() {
    MApp.State.stockView = 'pool';
    if (MApp.Shell.current === 'stock') {
      // Already here: re-mount rather than rely on showTab, which is a
      // no-op for the tab it is already on and would leave the pane
      // hidden behind the stock list.
      MApp.Stock.mount();
      return;
    }
    MApp.Shell.showTab('stock');
  },

  async load() {
    const listEl = document.getElementById('pool-list');
    // The pane is only in the DOM while the Stock tab is showing it, and
    // several things that recalculate the pool -- an opening balance, a
    // colour exclusion -- can be done from screens where it is not. They
    // ask for a refresh unconditionally; this is where that costs
    // nothing instead of throwing.
    if (!listEl) return;
    MApp.Util.renderSkeleton(listEl, 5);

    try {
      const res = await MApp.Api.call('getWarehousePoolData');
      if (!res || !res.success) {
        MApp.Util.renderError(listEl, res && res.message, () => this.load());
        return;
      }
      this.rows = res.data || [];
      this.entries = MApp.Search.index(this.rows, this.SEARCH);
      MApp.Paging.reset('pool');
      this._applyFilters();
      this.render();
    } catch (err) {
      MApp.Util.renderError(listEl, err && err.message, () => this.load());
    }
  },

  onSearch(term) {
    this.searchTerm = term || '';
    MApp.Paging.reset('pool');
    this._applyFilters();
    this.render();
  },

  filterBy(kind) {
    this.filter = kind;
    document.querySelectorAll('#pool-filter-bar .mb-filter-chip').forEach(chip => {
      chip.classList.toggle('active', chip.dataset.poolFilter === kind);
    });
    MApp.Paging.reset('pool');
    this._applyFilters();
    this.render();
  },

  _applyFilters() {
    const matched = MApp.Search.run(this.entries, this.searchTerm);
    this.filtered = matched.filter(r => {
      if (this.filter === 'negative') return r.availableQty < 0;
      if (this.filter === 'attribution') return this.isAttribution(r);
      if (this.filter === 'recount') return this.needsCount(r);
      return true;
    });
  },

  render() {
    const listEl = document.getElementById('pool-list');
    if (!listEl) return;

    const negatives = this.rows.filter(r => r.availableQty < 0);
    const attribution = negatives.filter(r => this.isAttribution(r)).length;
    const banner = negatives.length ? `
      <div class="mb-offline-banner" style="background:var(--mb-enamel-amber-bg);color:var(--mb-enamel-amber-ink);margin-bottom:var(--mb-sp-3);display:block;">
        <div><strong>${negatives.length} negative bucket${negatives.length === 1 ? '' : 's'}.</strong></div>
        <div class="mb-text-sm">${attribution} look like attribution — the units are probably in a sibling bucket. ${negatives.length - attribution} may need a physical count.</div>
      </div>` : '';

    const page = MApp.Paging.take('pool', this.filtered, () => this.render());
    MApp.SearchBox.setCount('pool-search', page.shown, page.total, page.meta);

    if (this.filtered.length === 0) {
      listEl.innerHTML = banner;
      const empty = document.createElement('div');
      listEl.appendChild(empty);
      MApp.Util.renderEmpty(empty, {
        title: 'Nothing here',
        body: this.searchTerm.trim() ? `Nothing matches “${this.searchTerm.trim()}”.` : 'No buckets in this view.'
      });
      return;
    }

    listEl.innerHTML = banner + page.rows.map((r, i) => {
      const negative = r.availableQty < 0;
      const attributionCase = this.isAttribution(r);
      const sibs = this.siblings(r);

      // Named, not just coloured: "negative" alone is the state that
      // makes the two kinds indistinguishable.
      const flag = !negative ? '' : attributionCase
        ? `<div class="mb-card-sub" style="color:var(--mb-enamel-amber-ink);margin-top:var(--mb-sp-2);">
             Never produced in this colour, yet ${MApp.Util.formatQty(r.consumedQty)} consumed.
             ${sibs.length
    ? 'Likely belongs to: ' + MApp.Util.escapeHtml(sibs.join(', ')) + '. An attribution issue, not a shortage.'
    : 'No sibling bucket carries this colour — check the consuming recipe.'}
           </div>`
        : `<div class="mb-card-sub" style="color:var(--mb-enamel-red-ink);margin-top:var(--mb-sp-2);">
             Produced and consumed both moved and it still went negative — this one may need a physical count.
           </div>`;

      return `
        <div class="mb-card">
          <div class="mb-card-row">
            <div>
              <div class="mb-card-title">${MApp.Util.escapeHtml(r.outputItemName)}</div>
              <div class="mb-card-sub">${r.color ? MApp.Util.escapeHtml(r.color) : 'No colour'}${r.productTag ? ' · ' + MApp.Util.escapeHtml(r.productTag) : ''}</div>
            </div>
            <div style="text-align:right;">
              <div class="mb-card-number${negative ? ' mb-alert' : ''}">${MApp.Util.formatQty(r.availableQty)}</div>
              <div class="mb-card-sub">${MApp.Util.formatQty(r.producedQty)} in · ${MApp.Util.formatQty(r.consumedQty)} out</div>
            </div>
          </div>
          ${flag}
          ${r.countsTowardTotal === false
    ? `<div class="mb-card-sub mb-mt-2">Sub-group — recorded per colour on units already counted, so it is left out of this process's totals and out of Ready to Dispatch.</div>`
    : ''}
          <div class="mb-mt-2">
            <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" data-pool-ledger="${i}">View ledger</button>
            <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" data-pool-adjust="${i}">Correct count</button>
            ${r.color
    ? `<button type="button" class="mb-btn-text" style="padding:0;min-height:auto;" data-pool-counts="${i}">${r.countsTowardTotal === false ? 'Count as stock' : 'Not stock'}</button>`
    : ''}
          </div>
        </div>`;
    }).join('') + MApp.Paging.moreHtml(page);

    listEl.querySelectorAll('[data-pool-ledger]').forEach(btn => {
      btn.addEventListener('click', () => {
        const row = page.rows[Number(btn.dataset.poolLedger)];
        if (row) this.openLedger(row);
      });
    });

    listEl.querySelectorAll('[data-pool-adjust]').forEach(btn => {
      btn.addEventListener('click', () => {
        const row = page.rows[Number(btn.dataset.poolAdjust)];
        if (row) this.openAdjust(row);
      });
    });

    listEl.querySelectorAll('[data-pool-counts]').forEach(btn => {
      btn.addEventListener('click', () => {
        const row = page.rows[Number(btn.dataset.poolCounts)];
        if (row) this.setBucketCounts(row);
      });
    });
  },

  // Declare a bucket stock or a sub-group. Where a production lot credited
  // it the server reads the answer off the lot; this is for the buckets no
  // lot ever touched (opening stock, a correction), where nothing can infer
  // it -- see migration 044.
  //
  // Confirmed rather than instant, unlike desktop: the same tap target
  // sits beside "Correct count", and this one silently moves a process
  // total and what Dispatch will offer.
  async setBucketCounts(row) {
    const excluded = row.countsTowardTotal === false;
    const label = row.outputItemName + (row.color ? ' · ' + row.color : '');
    if (!window.confirm(excluded
      ? `Count “${label}” as stock again? Its quantity goes back into this process's totals and into Ready to Dispatch.`
      : `Mark “${label}” a sub-group? It stays listed with its own history, but its quantity leaves this process's totals and Ready to Dispatch.`)) return;

    const res = await MApp.Util.mutateSimple(
      'setWarehousePoolBucketCountsTowardTotal',
      [row.outputItemName, row.processId, row.productTag || '', row.color || '', excluded],
      null
    );
    if (res.success) {
      MApp.Toast.success(res.message || 'Bucket updated.');
      this.load();
    }
  },

  // getWarehousePoolLedger replays the pool's own arithmetic server-side.
  // Its docstring records that the client used to assemble this and had
  // drifted from the backend in five ways, so this must never be derived
  // here. Note the three SEPARATE arguments: Api.call is variadic, and
  // passing them as one array yields HTTP 200, success true, and a
  // silently empty ledger.
  async openLedger(row) {
    const body = document.getElementById('pool-ledger-body');
    const titleEl = document.getElementById('pool-ledger-title');
    if (titleEl) titleEl.textContent = row.outputItemName + (row.color ? ' · ' + row.color : '');
    MApp.Util.renderSkeleton(body, 4);
    MApp.Sheet.open('sheet-pool-ledger');

    try {
      const res = await MApp.Api.call('getWarehousePoolLedger', row.outputItemName, row.productTag || '', row.color || '');
      if (!res || !res.success) {
        MApp.Util.renderError(body, res && res.message, () => this.openLedger(row));
        return;
      }
      const entries = res.data || [];
      if (!entries.length) {
        MApp.Util.renderEmpty(body, { title: 'No movements', body: 'Nothing has moved in or out of this bucket.' });
        return;
      }
      body.innerHTML = entries.map(e => `
        <div class="mb-card">
          <div class="mb-card-row">
            <div>
              <div class="mb-card-title">${MApp.Util.escapeHtml(e.type)}${e.ref ? ' · ' + MApp.Util.escapeHtml(e.ref) : ''}</div>
              <div class="mb-card-sub">${MApp.Util.formatDateDisplay(e.dateRaw)}${e.remarks ? ' · ' + MApp.Util.escapeHtml(e.remarks) : ''}</div>
            </div>
            <div style="text-align:right;white-space:nowrap;">
              <div style="font-weight:700;color:${e.inQty ? 'var(--mb-enamel-green-ink)' : 'var(--mb-enamel-red-ink)'};">
                ${e.inQty ? '+' + MApp.Util.formatQty(e.inQty) : '-' + MApp.Util.formatQty(e.outQty)}
              </div>
              <div class="mb-card-sub">bal ${MApp.Util.formatQty(e.balance)}</div>
            </div>
          </div>
        </div>`).join('');
    } catch (err) {
      MApp.Util.renderError(body, err && err.message, () => this.openLedger(row));
    }
  },

  closeLedger() { MApp.Sheet.close('sheet-pool-ledger'); },

  // ── Manual correction ────────────────────────────────────────────────
  // adjustWarehousePoolManually does not set the bucket directly: it
  // appends a compensating opening row for (new - old) and recalculates,
  // then records the before/after in the adjustment log. So a correction
  // is an auditable event, not an overwrite -- which is the only reason
  // it is safe to offer on a phone at all.
  //
  // What is NOT safe, and is refused below, is using it to make a
  // negative bucket stop being negative when the negative is an
  // attribution case. warehouse_service._assert_produced_stays_nonnegative
  // says it plainly in its own docstring: a negative available qty "is the
  // legitimate over-consumption signal ... and it must stay visible so the
  // shortfall gets counted and entered". The server guards only the
  // arithmetic that cannot be true (produced going negative) and leaves
  // this to the caller. On an attribution bucket the units are not
  // missing -- they were credited to a sibling colour -- so zeroing it
  // destroys the trail the next stage's checklist reads and fixes
  // nothing.
  openAdjust(row) {
    if (!row) return;
    this._adjustRow = row;

    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.value = val;
    };
    set('pool-adjust-bucket', row.outputItemName + (row.color ? ' · ' + row.color : '')
      + (row.productTag ? ' · ' + row.productTag : ''));
    set('pool-adjust-old', MApp.Util.formatQty(row.availableQty));
    set('pool-adjust-new', row.availableQty);
    set('pool-adjust-reason', '');

    const note = document.getElementById('pool-adjust-note');
    if (note) {
      if (this.isAttribution(row)) {
        const sibs = this.siblings(row);
        note.innerHTML = `<strong>This is an attribution negative, not a shortage.</strong>
          Nothing was ever produced in this colour, yet ${MApp.Util.formatQty(row.consumedQty)} was consumed —
          ${sibs.length
    ? 'the units were credited to ' + MApp.Util.escapeHtml(sibs.join(', ')) + '.'
    : 'and no sibling bucket carries this colour, so the consuming recipe is what to check.'}
          Correcting this to zero would hide it without moving a single part. Fix the recipe or the lot's colour pairing instead.`;
        note.hidden = false;
      } else if (row.availableQty < 0) {
        note.innerHTML = `<strong>Count this one first.</strong> Both sides moved and it still went negative,
          so the number to enter is what is physically on the shelf — not zero.`;
        note.hidden = false;
      } else {
        note.hidden = true;
        note.innerHTML = '';
      }
    }

    MApp.Sheet.open('sheet-pool-adjust');
  },

  closeAdjust() { MApp.Sheet.close('sheet-pool-adjust'); },

  async submitAdjust() {
    const row = this._adjustRow;
    if (!row) return;

    const raw = String(document.getElementById('pool-adjust-new')?.value ?? '').trim();
    const newQty = parseFloat(raw);
    if (raw === '' || !isFinite(newQty)) {
      MApp.Toast.error('Enter the corrected quantity.');
      return;
    }
    const reason = String(document.getElementById('pool-adjust-reason')?.value || '').trim();
    if (!reason) {
      MApp.Toast.error('A reason is required — the server records it against this correction.');
      return;
    }
    if (newQty === row.availableQty) {
      MApp.Toast.error('That is the value it already has.');
      return;
    }

    // The one refusal. Narrow on purpose: only an attribution negative,
    // and only a correction that lifts it out of negative. Anything else
    // -- including a correction that leaves it negative, and any
    // correction to a bucket that needs a physical count -- goes through.
    if (this.isAttribution(row) && row.availableQty < 0 && newQty >= 0) {
      const sibs = this.siblings(row);
      MApp.Toast.error(sibs.length
        ? `Not this way. These units are in ${sibs.join(', ')} — correct the pairing, not this bucket.`
        : 'Not this way. Nothing was produced in this colour, so there is nothing here to count. Check the consuming recipe.');
      return;
    }

    const delta = newQty - row.availableQty;
    const label = row.outputItemName + (row.color ? ' · ' + row.color : '');
    if (!window.confirm(
      `Correct ${label} from ${MApp.Util.formatQty(row.availableQty)} to ${MApp.Util.formatQty(newQty)}`
      + ` (${delta > 0 ? '+' : ''}${MApp.Util.formatQty(delta)})?`
      + ' This is logged against your name in the adjustment history.')) return;

    const btn = document.getElementById('pool-adjust-save-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

    let res;
    try {
      res = await Api.mutateWithId(
        'adjustWarehousePoolManually', Api.newMutationId(),
        row.outputItemName, row.processId, row.productTag || '', row.color || '',
        newQty, reason
      );
    } catch (err) {
      MApp.Toast.error(err.message || 'Could not reach the server. Please try again.');
      if (btn) { btn.disabled = false; btn.textContent = 'Save correction'; }
      return;
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Save correction'; }

    if (!res || !res.success) {
      // A no-op edit comes back success:false WITH the current value
      // attached, deliberately (the server bypasses build_response to do
      // it), so the screen can reconcile instead of arguing with a stale
      // number.
      if (res && res.data && res.data.oldAvailableQty !== undefined) {
        row.availableQty = res.data.oldAvailableQty;
        const el = document.getElementById('pool-adjust-old');
        if (el) el.value = MApp.Util.formatQty(row.availableQty);
      }
      MApp.Toast.error((res && res.message) || 'Could not save this correction.');
      return;
    }

    // The entered figure always holds -- the server widens the correction
    // until it does. What can differ is how much widening that took: a
    // bucket carrying an unattributed colour-agnostic (COMMON) shortfall
    // has part of any correction drained straight back out, so the pool
    // needs more than the difference on screen to land on the count. That
    // surplus is consumption recorded against stock the pool never had, and
    // it is exactly the thing an audit later has to account for -- too
    // important to fade after 2.6 seconds, so it gets the toast that waits.
    const applied = res.data && res.data.appliedDelta;
    const expected = res.data && res.data.expectedDelta;
    if (typeof applied === 'number' && typeof expected === 'number' && applied !== expected) {
      MApp.Toast.action(res.message, 'Got it', () => {});
      this.closeAdjust();
      this.load();
      return;
    }

    MApp.Toast.success(res.message || 'Warehouse Pool stock adjusted.');
    this.closeAdjust();
    // load(), not open(): the pane is already on screen behind the sheet
    // that just closed, and open() would re-enter the whole tab.
    this.load();
  },

  // ── Adjustment history ───────────────────────────────────────────────
  // Every correction, who made it and why. A pool number that changed
  // without a lot behind it is exactly the thing somebody later needs to
  // account for, and the record existed with no way to read it here.
  async openHistory() {
    const body = document.getElementById('pool-history-body');
    MApp.Util.renderSkeleton(body, 5);
    MApp.Sheet.open('sheet-pool-history');

    try {
      const res = await MApp.Api.call('getWarehousePoolAdjustmentHistory');
      if (!res || !res.success) {
        MApp.Util.renderError(body, res && res.message, () => this.openHistory());
        return;
      }
      const rows = res.data || [];
      if (!rows.length) {
        MApp.Util.renderEmpty(body, {
          title: 'No corrections',
          body: 'No pool bucket has been corrected by hand.'
        });
        return;
      }
      body.innerHTML = rows.map(a => {
        const delta = a.newValue - a.oldValue;
        return `
        <div class="mb-card">
          <div class="mb-card-row">
            <div>
              <div class="mb-card-title">${MApp.Util.escapeHtml(a.outputItemName)}</div>
              <div class="mb-card-sub">${a.color ? MApp.Util.escapeHtml(a.color) : 'No colour'}${a.productTag ? ' · ' + MApp.Util.escapeHtml(a.productTag) : ''}</div>
            </div>
            <div style="text-align:right;white-space:nowrap;">
              <div style="font-weight:700;color:${delta >= 0 ? 'var(--mb-enamel-green-ink)' : 'var(--mb-enamel-red-ink)'};">
                ${MApp.Util.formatQty(a.oldValue)} → ${MApp.Util.formatQty(a.newValue)}
              </div>
              <div class="mb-card-sub">${MApp.Util.formatDateDisplay(a.date)}</div>
            </div>
          </div>
          <div class="mb-card-sub mb-mt-2">${MApp.Util.escapeHtml(a.reason)}</div>
          <div class="mb-card-sub">${MApp.Util.escapeHtml(a.user || 'unknown')}</div>
        </div>`;
      }).join('');
    } catch (err) {
      MApp.Util.renderError(body, err && err.message, () => this.openHistory());
    }
  },

  closeHistory() { MApp.Sheet.close('sheet-pool-history'); }
};

// ================================================================
// WAREHOUSE POOL OPENING BALANCES.
//
// The only way to credit a pool bucket without completing a lot: what
// was already on the rack before this system started counting, and the
// dated corrections adjustWarehousePoolManually writes as (new - old)
// deltas -- both land in the same table, which is why the correction
// entries show up in this list too and are labelled as such.
//
// A negative opening entry is legitimate and is how a downward
// correction is expressed. The server's only floor is that a bucket's
// PRODUCED quantity may not go below zero, since produced is the sum of
// credits and a negative one is not a shortage, it is arithmetically
// impossible. A negative AVAILABLE is left alone on purpose -- it is the
// over-consumption signal and has to stay visible.
// ================================================================
MApp.PoolOpenings = {
  SEARCH: {
    fields: [
      { key: 'outputItemName', weight: 10, label: 'Item' },
      { key: 'color', weight: 6, label: 'Colour' },
      { key: 'processName', weight: 4, label: 'Process' },
      { key: 'productTag', weight: 4, label: 'Product' },
      { key: 'remarks', weight: 2, label: 'Remarks' }
    ]
  },

  rows: [],
  entries: [],
  filtered: [],
  searchTerm: '',
  processes: [],
  products: [],
  colors: [],
  selection: null,

  async open() {
    const listEl = document.getElementById('pool-openings-list');
    const input = document.getElementById('pool-openings-search');
    if (input) input.value = '';
    this.searchTerm = '';
    MApp.SearchBox.attach('pool-openings-search', term => this.onSearch(term));

    MApp.Util.renderSkeleton(listEl, 4);
    MApp.Sheet.open('sheet-pool-openings');

    try {
      const res = await MApp.Api.call('getWarehousePoolOpeningData');
      if (!res || !res.success) {
        MApp.Util.renderError(listEl, res && res.message, () => this.open());
        return;
      }
      this.rows = res.data || [];
      this.entries = MApp.Search.index(this.rows, this.SEARCH);
      MApp.Paging.reset('poolOpening');
      this.filtered = this.rows;
      this.render();
    } catch (err) {
      MApp.Util.renderError(listEl, err && err.message, () => this.open());
    }
  },

  close() { MApp.Sheet.close('sheet-pool-openings'); },

  onSearch(term) {
    this.searchTerm = term || '';
    MApp.Paging.reset('poolOpening');
    this.filtered = MApp.Search.run(this.entries, this.searchTerm);
    this.render();
  },

  render() {
    const listEl = document.getElementById('pool-openings-list');
    if (!listEl) return;

    const page = MApp.Paging.take('poolOpening', this.filtered, () => this.render());
    MApp.SearchBox.setCount('pool-openings-search', page.shown, page.total, page.meta);

    if (this.filtered.length === 0) {
      MApp.Util.renderEmpty(listEl, {
        title: 'No opening balances',
        body: this.searchTerm.trim()
          ? `Nothing matches “${this.searchTerm.trim()}”.`
          : 'Nothing has been credited to a bucket outside a completed lot.'
      });
      return;
    }

    listEl.innerHTML = page.rows.map((r, i) => {
      // A correction writes into this same table with a "Correction: "
      // remark. Saying which is which matters: one is what was on the
      // rack to begin with, the other is somebody's later judgement.
      const isCorrection = /^Correction: /.test(r.remarks || '');
      return `
      <div class="mb-card">
        <div class="mb-card-row">
          <div>
            <div class="mb-card-title">${MApp.Util.escapeHtml(r.outputItemName)}</div>
            <div class="mb-card-sub">${r.color ? MApp.Util.escapeHtml(r.color) : 'No colour'}${r.productTag ? ' · ' + MApp.Util.escapeHtml(r.productTag) : ''}</div>
            <div class="mb-card-sub">${MApp.Util.escapeHtml(r.processName || r.processId || '')} · ${MApp.Util.escapeHtml(r.date || '')}</div>
          </div>
          <div style="text-align:right;">
            <div class="mb-card-number" style="color:${r.qty < 0 ? 'var(--mb-enamel-red-ink)' : 'var(--mb-enamel-green-ink)'};">${r.qty > 0 ? '+' : ''}${MApp.Util.formatQty(r.qty)}</div>
          </div>
        </div>
        ${isCorrection ? '<div class="mb-mt-2"><span class="mb-chip">Correction</span></div>' : ''}
        ${r.remarks ? `<div class="mb-card-sub mb-mt-2">${MApp.Util.escapeHtml(r.remarks)}</div>` : ''}
        <div class="mb-mt-2">
          <button type="button" class="mb-btn-text" style="padding:0;min-height:auto;color:var(--mb-enamel-red-ink);" data-opening-delete="${i}">Delete</button>
        </div>
      </div>`;
    }).join('') + MApp.Paging.moreHtml(page);

    listEl.querySelectorAll('[data-opening-delete]').forEach(btn => {
      btn.addEventListener('click', () => {
        const r = page.rows[Number(btn.dataset.openingDelete)];
        if (r) this.remove(r);
      });
    });
  },

  // ── The form ─────────────────────────────────────────────────────────
  async openForm() {
    this.selection = { processId: '', process: null, color: '', productTag: '' };
    ['pool-opening-qty', 'pool-opening-remarks', 'pool-opening-output'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    const dateEl = document.getElementById('pool-opening-date');
    if (dateEl) dateEl.value = MApp.Util.todayInputValue();

    this._paintProcess();
    this._paintColor();
    this._paintTag();
    MApp.Sheet.open('sheet-pool-opening-form');

    const [procRes, bomRes] = await Promise.all([
      MApp.Api.call('getProcessData').catch(() => null),
      MApp.Api.call('getBOMProductionData').catch(() => null)
    ]);
    this.processes = procRes && procRes.success ? (procRes.data || []).filter(p => p.active) : [];
    this.products = bomRes && bomRes.success ? (bomRes.data || []) : [];
  },

  closeForm() { MApp.Sheet.close('sheet-pool-opening-form'); },

  _paintProcess() {
    const el = document.getElementById('pool-opening-process-field');
    if (!el) return;
    const p = this.selection.process;
    el.textContent = p ? `${p.processName} (Seq ${p.sequence})` : 'Choose a process…';
    el.classList.toggle('mb-placeholder', !p);

    // The per-entry Output Item Name override, and the Product Tag, only
    // mean anything for a final-stage process's own finished output. The
    // server silently blanks both for a WIP process, so offering them
    // there would be offering an edit that quietly does nothing.
    const finalStage = !!(p && p.isFinalStage);
    const outputEl = document.getElementById('pool-opening-output');
    if (outputEl) {
      outputEl.value = p ? (p.outputItemName || '') : '';
      outputEl.readOnly = !finalStage;
    }
    const outputHint = document.getElementById('pool-opening-output-hint');
    if (outputHint) {
      outputHint.textContent = finalStage
        ? 'Override only if this batch is tagged differently from the process default.'
        : 'Set by the process. A per-entry name is only kept for a final-stage process.';
    }
    const tagField = document.getElementById('pool-opening-tag-field');
    if (tagField) tagField.closest('.mb-field').hidden = !finalStage;
  },

  _paintColor() {
    const el = document.getElementById('pool-opening-color-field');
    if (!el) return;
    const has = this.colors.length > 0;
    el.textContent = this.selection.color || (has ? 'Choose a colour…' : 'No colour');
    el.classList.toggle('mb-placeholder', !this.selection.color);
    const wrap = el.closest('.mb-field');
    if (wrap) wrap.hidden = !has;
    const hint = document.getElementById('pool-opening-color-hint');
    if (hint) {
      // Required, and worth saying why: an opening balance logged without
      // a colour on a colour-tracking process lands in an untagged bucket
      // that a colour-aware lot never looks at, so the stock is entered
      // and still invisible.
      hint.textContent = has
        ? 'Required. This process tracks stock per colour, and an untagged balance is one no lot will ever draw from.'
        : '';
    }
  },

  _paintTag() {
    const el = document.getElementById('pool-opening-tag-field');
    if (!el) return;
    el.textContent = this.selection.productTag || 'Untagged — stays in the pool';
    el.classList.toggle('mb-placeholder', !this.selection.productTag);
  },

  async pickProcess() {
    if (!this.processes.length) {
      MApp.Toast.error('Process list is still loading. Try again in a moment.');
      return;
    }
    const picked = await MApp.Picker.open({
      title: 'Choose a process',
      items: this.processes.map(p => ({
        value: p.processId, label: p.processName, sublabel: `Seq ${p.sequence}${p.isFinalStage ? ' · final stage' : ''}`
      })),
      selectedValue: this.selection.processId
    });
    if (!picked) return;

    this.selection.processId = picked.value;
    this.selection.process = this.processes.find(p => p.processId === picked.value) || null;
    // A colour chosen for the previous process means nothing here.
    this.selection.color = '';
    this.selection.productTag = '';
    this.colors = [];
    this._paintProcess();
    this._paintTag();
    this._paintColor();

    // Same source the server checks against, so "the picker offered
    // choices" and "a colour is required" can never disagree.
    const token = this.selection.processId;
    let colors = [];
    try {
      const res = await MApp.Api.call('getProcessColorGroups', token);
      colors = (res && res.success) ? (res.data || []) : [];
    } catch (err) {
      colors = [];
    }
    // A slower response for a process that is no longer chosen must not
    // paint its colours against the current one.
    if (this.selection.processId !== token) return;
    this.colors = colors;
    this._paintColor();
  },

  async pickColor() {
    if (!this.colors.length) return;
    const picked = await MApp.Picker.open({
      title: 'Choose a colour',
      items: this.colors.map(c => ({ value: c, label: c })),
      selectedValue: this.selection.color
    });
    if (!picked) return;
    this.selection.color = picked.value;
    this._paintColor();
  },

  async pickTag() {
    const items = [{ value: '', label: 'Untagged — stays in the pool' }].concat(
      this.products.map(p => ({ value: p.productId, label: p.productName, sublabel: p.productId }))
    );
    const picked = await MApp.Picker.open({
      title: 'Product tag', items, selectedValue: this.selection.productTag
    });
    if (!picked) return;
    this.selection.productTag = picked.value;
    this._paintTag();
  },

  async save() {
    if (!this.selection.processId) {
      MApp.Toast.error('Choose a process.');
      return;
    }
    if (this.colors.length > 0 && !this.selection.color) {
      MApp.Toast.error('This process tracks stock per colour — choose one, or the balance lands where no lot will look.');
      return;
    }

    const raw = String(document.getElementById('pool-opening-qty')?.value ?? '').trim();
    const qty = parseFloat(raw);
    if (raw === '' || !isFinite(qty)) {
      MApp.Toast.error('Enter the opening quantity.');
      return;
    }
    if (qty === 0) {
      MApp.Toast.error('An opening quantity of zero records nothing.');
      return;
    }

    // A negative entry is how a downward correction is written, and it is
    // allowed -- but it is not what someone recording what was on the
    // rack meant to type, so it is confirmed rather than assumed.
    if (qty < 0 && !window.confirm(
      `Record ${MApp.Util.formatQty(qty)} — a negative opening balance? That takes stock OUT of this bucket.`
      + ' Use it only to correct an earlier entry.')) return;

    const payload = {
      processId: this.selection.processId,
      outputItemName: document.getElementById('pool-opening-output')?.value || '',
      productTag: this.selection.productTag || '',
      color: this.selection.color || '',
      qty,
      date: document.getElementById('pool-opening-date')?.value || '',
      remarks: document.getElementById('pool-opening-remarks')?.value || ''
    };

    const btn = document.getElementById('pool-opening-save-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    const res = await MApp.Util.mutateSimple('saveWarehousePoolOpening', [payload], null);
    if (btn) { btn.disabled = false; btn.textContent = 'Record opening stock'; }
    if (!res.success) return;

    MApp.Toast.success(res.message || 'Opening stock recorded.');
    this.closeForm();
    this.open();
    // The server recalculated the pool, so the bucket list behind this
    // sheet is now wrong. A no-op when that pane is not on screen.
    MApp.Pool.load();
  },

  async remove(row) {
    // Deleting an opening entry removes a credit from the bucket and
    // recalculates, so it can drive an available balance negative. Say
    // what it is worth rather than asking a bare "are you sure".
    if (!window.confirm(
      `Delete this ${MApp.Util.formatQty(row.qty)} entry for ${row.outputItemName}${row.color ? ' · ' + row.color : ''}?`
      + ' The bucket is recalculated without it.')) return;

    // Both expected values or neither: the server only applies its
    // concurrency check when both arrive, and skipping it would let a
    // stale list delete an entry that is no longer the one on screen.
    const res = await MApp.Util.mutateSimple(
      'deleteWarehousePoolOpening', [row.rowIdx, row.outputItemName, row.qty], null
    );
    if (res.success) {
      MApp.Toast.success(res.message || 'Opening stock entry deleted.');
      this.open();
      MApp.Pool.load();
    }
  }
};

// ================================================================
// PROCESS COLOUR COMBINATIONS — which colours a process's pool tracks.
//
// The pool derives a process's colour list from its recipe, its linked
// processes, and whatever colours have actually been seen in Production
// and Warehouse Pool. That derivation is usually right and sometimes
// picks up a combination nobody wanted, or misses one that is about to
// be run for the first time. Both fixes were desktop-only.
//
// Which rows may be removed is the server's call, not this screen's:
// getAllProcessColorGroups returns `removable`, the subset
// excludeWarehousePoolColors will actually accept -- not on the recipe,
// and carrying no real (non-manual) production or consumption history.
// Everything else is shown as protected rather than offered and then
// refused.
//
// That flag is also what keeps this screen away from the pool's
// negatives. An attribution bucket -- consumed but never produced --
// has real consumption history by definition, so its colour is never
// removable and this screen cannot be used to make one disappear.
// ================================================================
MApp.ProcessColors = {
  process: null,
  colors: [],
  removable: [],
  masterColors: [],

  isRemovable(color) {
    const c = String(color || '').trim().toLowerCase();
    return this.removable.some(r => String(r || '').trim().toLowerCase() === c);
  },

  async open(process) {
    if (!process) return;
    this.process = process;
    this.colors = [];
    this.removable = [];

    const titleEl = document.getElementById('process-colors-title');
    if (titleEl) titleEl.textContent = `Colours — ${process.processName}`;

    const body = document.getElementById('process-colors-body');
    MApp.Util.renderSkeleton(body, 4);
    MApp.Sheet.open('sheet-process-colors');

    await this.load();

    // Only needed by the Add button, and only after the list is up.
    if (!this.masterColors.length) {
      try {
        const res = await MApp.Api.call('getColors');
        this.masterColors = (res && res.success) ? (res.data || []) : [];
      } catch (err) {
        this.masterColors = [];
      }
    }
  },

  async load() {
    const body = document.getElementById('process-colors-body');
    const process = this.process;
    try {
      // One call returns every process's list; this screen reads its own
      // out of it rather than asking for a per-process endpoint that
      // does not carry `removable`.
      const res = await MApp.Api.call('getAllProcessColorGroups');
      if (!res || !res.success) {
        MApp.Util.renderError(body, res && res.message, () => this.load());
        return;
      }
      if (this.process !== process) return; // a different process was opened
      const entry = (res.data || {})[process.processId] || { colors: [], removable: [] };
      this.colors = entry.colors || [];
      this.removable = entry.removable || [];
      this.render();
    } catch (err) {
      MApp.Util.renderError(body, err && err.message, () => this.load());
    }
  },

  close() { MApp.Sheet.close('sheet-process-colors'); },

  render() {
    const body = document.getElementById('process-colors-body');
    if (!body) return;

    if (this.colors.length === 0) {
      MApp.Util.renderEmpty(body, {
        title: 'No colour combinations',
        body: 'This process does not track stock per colour. Adding one starts it doing so.'
      });
      return;
    }

    body.innerHTML = this.colors.map((c, i) => {
      const removable = this.isRemovable(c);
      return `
      <div class="mb-card">
        <div class="mb-card-row">
          <div class="mb-card-title">${MApp.Util.escapeHtml(c)}</div>
          ${removable
    ? `<button type="button" class="mb-btn-text" style="padding:0;min-height:auto;color:var(--mb-enamel-red-ink);" data-color-remove="${i}">Remove</button>`
    : '<span class="mb-chip">Protected</span>'}
        </div>
        ${removable
    ? ''
    // Named, because a greyed-out control that does not say why is
    // indistinguishable from a broken one.
    : '<div class="mb-card-sub mb-mt-2">On this process’s recipe, or it has real production or consumption history. Removing it would not stick — the pool rebuilds it from that same history.</div>'}
      </div>`;
    }).join('');

    body.querySelectorAll('[data-color-remove]').forEach(btn => {
      btn.addEventListener('click', () => this.remove(this.colors[Number(btn.dataset.colorRemove)]));
    });
  },

  async remove(color) {
    if (!color || !this.process) return;

    // Excluding a colour also DELETES its opening-stock and correction
    // rows, so the pool does not rebuild the bucket on the next
    // recalculation. That is real entered data going away, and it is the
    // part of this action nobody would guess from the word "Remove".
    if (!window.confirm(
      `Remove “${color}” from ${this.process.processName}?`
      + ' Any opening balance or correction recorded against this colour is deleted with it,'
      + ' and the pool is recalculated.')) return;

    const res = await MApp.Util.mutateSimple(
      'excludeWarehousePoolColors', [this.process.processId, [color]], null
    );
    // The server reports what it removed and what it refused, naming each
    // refusal's reason. A canned message would drop exactly the half that
    // says why nothing happened.
    if (res.success) {
      MApp.Toast.success(res.message || 'Combination removed.');
      this.load();
    }
  },

  async add() {
    if (!this.process) return;
    if (!this.masterColors.length) {
      MApp.Toast.error('Colour list is still loading. Try again in a moment.');
      return;
    }
    // Already-known colours are left in the picker on purpose: re-adding
    // one is how a previous exclusion is undone, and the server says so
    // plainly if it was already included rather than excluded.
    const picked = await MApp.Picker.open({
      title: 'Add a colour combination',
      items: this.masterColors.map(c => ({
        value: c.name, label: c.name,
        sublabel: this.colors.some(x => x.toLowerCase() === String(c.name).toLowerCase()) ? 'Already tracked' : (c.remarks || '')
      }))
    });
    if (!picked) return;

    const res = await MApp.Util.mutateSimple(
      'includeWarehousePoolColor', [this.process.processId, picked.value], null
    );
    if (res.success) {
      MApp.Toast.success(res.message || 'Combination added.');
      this.load();
    }
  }
};

// ================================================================
// CONTRACTOR DETAIL — the read side of what MApp could already write.
//
// Rates, extra charges and payments were all quick-addable from the
// Directory, and none of them could be read back. Write-without-read is
// the worst asymmetry in the app: an operator records a payment, has no
// way to confirm it landed, no way to see the balance it changed, and no
// way to correct a mistake -- so the predictable outcome is a duplicate
// entry, and the cleanup lands on whoever opens desktop next.
//
// Mirrors desktop's Rate Card / Extra Charges / Ledger panes. The three
// reads run in parallel and each is caught independently, so a slow or
// failing ledger does not hide the rate card.
// ================================================================
MApp.ContractorDetail = {
  name: null,
  data: null,

  // Every contractor's balance in one call, for the "who owes what"
  // question that otherwise means opening each contractor in turn.
  // Rendered as a banner above the contractor Directory list.
  async overviewHtml() {
    try {
      const res = await MApp.Api.call('getContractorLedgerData');
      if (!res || !res.success) return '';
      const owed = (res.data || []).filter(c => c.balanceDue > 0.0001)
        .sort((a, b) => b.balanceDue - a.balanceDue);
      if (!owed.length) return '';
      const total = owed.reduce((n, c) => n + c.balanceDue, 0);
      const top = owed.slice(0, 3)
        .map(c => `${MApp.Util.escapeHtml(MApp.Util.formatNameCase(c.contractorName))} ${MApp.Util.formatCurrency(c.balanceDue)}`)
        .join(' · ');
      return `
        <div class="mb-offline-banner" style="background:var(--mb-enamel-blue-bg);color:var(--mb-enamel-blue-ink);margin-bottom:var(--mb-sp-3);display:block;">
          <div><strong>${MApp.Util.formatCurrency(total)} owed across ${owed.length} contractor${owed.length === 1 ? '' : 's'}.</strong></div>
          <div class="mb-text-sm">${top}${owed.length > 3 ? ' …' : ''}</div>
        </div>`;
    } catch (err) {
      return ''; // an overview is a nicety; never let it break the list
    }
  },

  async open(contractorName) {
    this.name = contractorName;
    this.data = null;

    const titleEl = document.getElementById('contractor-detail-title');
    if (titleEl) titleEl.textContent = MApp.Util.formatNameCase(contractorName) || 'Contractor';
    const body = document.getElementById('contractor-detail-body');
    MApp.Util.renderSkeleton(body, 4);
    MApp.Sheet.open('sheet-contractor-detail');

    const [ledger, rates, charges] = await Promise.all([
      MApp.Api.call('getContractorAccountLedger', contractorName).catch(() => null),
      MApp.Api.call('getContractorRatesData', contractorName).catch(() => null),
      MApp.Api.call('getContractorServiceChargesData', contractorName).catch(() => null)
    ]);

    // A different contractor was opened while these were in flight.
    if (this.name !== contractorName) return;

    this.data = {
      ledger: (ledger && ledger.success) ? (ledger.data || {}) : null,
      rates: (rates && rates.success) ? (rates.data || []) : null,
      charges: (charges && charges.success) ? (charges.data || []) : null
    };
    this.render();
  },

  close() {
    MApp.Sheet.close('sheet-contractor-detail');
  },

  render() {
    const body = document.getElementById('contractor-detail-body');
    if (!body || !this.data) return;
    const { ledger, rates, charges } = this.data;
    const money = v => MApp.Util.formatCurrency(v);

    // A section that failed to load says so, rather than rendering as an
    // empty list -- "no rates on file" and "we could not fetch the rates"
    // are different answers and must not look the same.
    const failed = label =>
      `<div class="mb-text-sm mb-text-steel" style="padding:var(--mb-sp-2) 0;">Couldn't load ${label}.</div>`;
    const empty = text =>
      `<div class="mb-text-sm mb-text-steel" style="padding:var(--mb-sp-2) 0;">${text}</div>`;

    const summary = ledger ? `
      <div class="mb-card">
        <div class="mb-card-row">
          <span class="mb-card-sub">Balance due</span>
          <span class="mb-card-number ${ledger.balanceDue > 0 ? 'mb-alert' : ''}">${money(ledger.balanceDue)}</span>
        </div>
        <div class="mb-card-row mb-mt-2">
          <span class="mb-text-sm mb-text-steel">Payable ${money(ledger.totalPayable)}</span>
          <span class="mb-text-sm mb-text-steel">Paid ${money(ledger.totalPaid)}</span>
        </div>
        <button type="button" class="mb-btn mb-btn-secondary mb-mt-2" onclick="MApp.ContractorDetail.print()">Statement…</button>
      </div>` : failed('the account ledger');

    // Payments get their own section as well as their place in the
    // chronological ledger. The ledger is a STATEMENT -- it mixes derived
    // Payables with real Payment rows, so a selection across it would
    // offer to delete something that is not a record. Listing the
    // payments separately gives them a container of one row kind, which
    // is what MApp.Select's interlock requires and what makes a bulk
    // delete here honest.
    const payments = ledger ? (ledger.entries || []).filter(e => e.type === 'Payment') : [];
    const paymentRows = !ledger ? '' : (payments.length === 0
      ? empty('No payments recorded yet.')
      : payments.map(p => `
        <div class="mb-card">
          <div class="mb-card-row">
            <div>
              <div class="mb-card-title">${money(p.rawAmount)}</div>
              <div class="mb-card-sub">${MApp.Util.formatDateDisplay(p.dateRaw)}${p.ref && p.ref !== '-' ? ' · ' + MApp.Util.escapeHtml(p.ref) : ''}</div>
            </div>
          </div>
          ${p.description && p.description !== '-' ? `<div class="mb-card-sub">${MApp.Util.escapeHtml(p.description)}</div>` : ''}
        </div>`).join(''));

    const ledgerRows = !ledger ? '' : ((ledger.entries || []).length === 0
      ? empty('No ledger entries yet.')
      : ledger.entries.slice(0, 30).map(e => `
        <div class="mb-card">
          <div class="mb-card-row">
            <div>
              <div class="mb-card-title">${MApp.Util.escapeHtml(e.type)}${e.ref && e.ref !== '-' ? ' · ' + MApp.Util.escapeHtml(e.ref) : ''}</div>
              <div class="mb-card-sub">${MApp.Util.formatDateDisplay(e.dateRaw)}${e.description && e.description !== '-' ? ' · ' + MApp.Util.escapeHtml(e.description) : ''}</div>
            </div>
            <div style="text-align:right;white-space:nowrap;">
              <div style="font-weight:700;color:${e.amount < 0 ? 'var(--mb-enamel-green-ink)' : 'var(--mb-ink)'};">${money(e.amount)}</div>
              <div class="mb-card-sub">bal ${money(e.balance)}</div>
            </div>
          </div>
          ${e.type === 'Payment' ? `<div class="mb-mt-2"><button type="button" class="mb-btn-text" style="padding:0;min-height:auto;color:var(--mb-enamel-red-ink);" data-del-payment="${MApp.Util.escapeHtml(String(e.rowIdx))}" data-amount="${MApp.Util.escapeHtml(String(e.rawAmount))}">Delete payment</button></div>` : ''}
        </div>`).join(''));

    const rateRows = !rates ? failed('the rate card') : (rates.length === 0
      ? empty('No rates on file.')
      : rates.map(r => `
        <div class="mb-card">
          <div class="mb-card-row">
            <div>
              <div class="mb-card-title">${MApp.Util.escapeHtml(r.processType)}</div>
              <div class="mb-card-sub">${MApp.Util.escapeHtml(r.size || 'All sizes')}${r.remarks ? ' · ' + MApp.Util.escapeHtml(r.remarks) : ''}</div>
            </div>
            <div class="mb-card-number">${money(r.ratePerUnit)}</div>
          </div>
          <div class="mb-mt-2"><button type="button" class="mb-btn-text" style="padding:0;min-height:auto;color:var(--mb-enamel-red-ink);" data-del-rate="${MApp.Util.escapeHtml(r.processType)}" data-size="${MApp.Util.escapeHtml(r.size || '')}">Delete rate</button></div>
        </div>`).join(''));

    const chargeRows = !charges ? failed('the extra charges') : (charges.length === 0
      ? empty('No extra charges on file.')
      : charges.map(c => `
        <div class="mb-card">
          <div class="mb-card-row">
            <div>
              <div class="mb-card-title">${MApp.Util.escapeHtml(c.serviceType)}</div>
              ${c.remarks ? `<div class="mb-card-sub">${MApp.Util.escapeHtml(c.remarks)}</div>` : ''}
            </div>
            <div class="mb-card-number">${money(c.chargeAmount)}</div>
          </div>
          <div class="mb-mt-2"><button type="button" class="mb-btn-text" style="padding:0;min-height:auto;color:var(--mb-enamel-red-ink);" data-del-charge="${MApp.Util.escapeHtml(c.serviceType)}">Delete charge</button></div>
        </div>`).join(''));

    body.innerHTML = `
      ${summary}
      <div class="mapp-section-label mb-mt-4">Ledger</div>
      ${ledgerRows}
      <div class="mapp-section-label mb-mt-4">Payments</div>
      <div id="contractor-payment-list">${paymentRows}</div>
      <div class="mapp-section-label mb-mt-4">Rate Card</div>
      <div id="contractor-rate-list">${rateRows}</div>
      <button type="button" class="mb-btn mb-btn-secondary mb-mt-2" onclick="MApp.Directory.openRateSheet(MApp.ContractorDetail.name)">+ Add Rate</button>
      <div class="mapp-section-label mb-mt-4">Extra Charges</div>
      <div id="contractor-charge-list">${chargeRows}</div>
      <button type="button" class="mb-btn mb-btn-secondary mb-mt-2" onclick="MApp.Directory.openExtraChargeSheet(MApp.ContractorDetail.name)">+ Add Charge</button>
      <button type="button" class="mb-btn mb-btn-secondary mb-mt-4 mb-mb-4" onclick="MApp.Directory.openPaymentSheet(MApp.ContractorDetail.name)">+ Record Payment</button>`;

    this._bind(body);

    // Long-press multi-select, per list. Each gets its OWN container:
    // MApp.Select refuses to arm unless the rendered row count matches the
    // data it was handed, and three lists sharing one container could
    // never satisfy that. Only lists whose rows are all one kind of record
    // get this -- the ledger mixes derived Payables with real Payment
    // rows, and a selection spanning both would offer to delete something
    // that is not a record at all.
    if (payments.length) {
      MApp.Select.enable(document.getElementById('contractor-payment-list'), payments, {
        key: 'contractor-payments', noun: 'payment', plural: 'payments',
        method: 'deleteContractorPaymentsBulk',
        payload: rows => [rows.map(p => p.rowIdx)],
        onDone: () => MApp.ContractorDetail.open(MApp.ContractorDetail.name)
      });
    }
    if (rates && rates.length) {
      MApp.Select.enable(document.getElementById('contractor-rate-list'), rates, {
        key: 'contractor-rates', noun: 'rate', plural: 'rates',
        method: 'deleteContractorRatesBulk',
        payload: rows => [rows.map(r => ({
          contractorName: r.contractorName, processType: r.processType, size: r.size || ''
        }))],
        onDone: () => MApp.ContractorDetail.open(MApp.ContractorDetail.name)
      });
    }
    if (charges && charges.length) {
      MApp.Select.enable(document.getElementById('contractor-charge-list'), charges, {
        key: 'contractor-charges', noun: 'charge', plural: 'charges',
        method: 'deleteContractorServiceChargesBulk',
        payload: rows => [rows.map(c => ({
          contractorName: c.contractorName, serviceType: c.serviceType
        }))],
        onDone: () => MApp.ContractorDetail.open(MApp.ContractorDetail.name)
      });
    }
  },

  _bind(body) {
    body.querySelectorAll('[data-del-rate]').forEach(btn => {
      btn.addEventListener('click', () => this._remove(
        'deleteContractorRate',
        [this.name, btn.dataset.delRate, btn.dataset.size || ''],
        `the ${btn.dataset.delRate} rate`, 'Rate deleted.'
      ));
    });
    body.querySelectorAll('[data-del-charge]').forEach(btn => {
      btn.addEventListener('click', () => this._remove(
        'deleteContractorServiceCharge',
        [this.name, btn.dataset.delCharge],
        `the ${btn.dataset.delCharge} charge`, 'Charge deleted.'
      ));
    });
    body.querySelectorAll('[data-del-payment]').forEach(btn => {
      // The expected contractor and amount ride along: the server uses
      // them to refuse a delete whose row has changed underneath, which
      // matters most on a phone that may have been showing this list for
      // a while.
      btn.addEventListener('click', () => this._remove(
        'deleteContractorPayment',
        [btn.dataset.delPayment, this.name, MApp.Util.toNumber(btn.dataset.amount)],
        `this ${MApp.Util.formatCurrency(btn.dataset.amount)} payment`, 'Payment deleted.'
      ));
    });
  },

  async _remove(method, args, label, successMsg) {
    if (!MApp.Util.confirmDelete(label)) return;
    const res = await MApp.Util.mutateSimple(method, args, successMsg);
    if (res.success) this.open(this.name);
  },

  // Print, filling the same print.html container desktop fills -- one of
  // eight templates MApp.Print could reach and never populated. A
  // contractor asking for their account is a conversation that happens at
  // the gate, not at a desk.
  print() {
    if (!this.data || !this.data.ledger) {
      MApp.Toast.error('The ledger has not loaded, so there is nothing to print.');
      return;
    }
    const ledger = this.data.ledger;
    const contractor = (MApp.Directory.items || []).find(
      c => String(c.name || '').trim().toLowerCase() === String(this.name || '').trim().toLowerCase()
    ) || {};

    const setText = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value == null ? '' : String(value);
    };
    setText('print-contractor-name', MApp.Util.formatNameCase(this.name));
    setText('print-contractor-gstpan', contractor.gstPan || '-');
    setText('print-contractor-contact', contractor.contact || '-');
    setText('print-contractor-address', contractor.address || '-');
    setText('print-contractor-remarks', contractor.remarks || 'No remarks');
    setText('print-contractor-report-date', new Date().toLocaleDateString('en-GB'));
    setText('print-contractor-total-payable', MApp.Util.formatCurrency(ledger.totalPayable));
    setText('print-contractor-total-paid', MApp.Util.formatCurrency(ledger.totalPaid));
    setText('print-contractor-balance-due', MApp.Util.formatCurrency(ledger.balanceDue));

    const bodyEl = document.getElementById('print-contractor-ledger-body');
    if (bodyEl) {
      const cell = 'padding:6px;border:1px solid #999;color:#000;';
      const num = cell + 'text-align:right;font-weight:700;';
      bodyEl.innerHTML = (ledger.entries || []).length
        ? ledger.entries.map(e => `<tr>
            <td style="${cell}">${MApp.Util.escapeHtml(e.date)}</td>
            <td style="${cell}">${MApp.Util.escapeHtml(e.type)}</td>
            <td style="${cell}">${MApp.Util.escapeHtml(e.ref)}</td>
            <td style="${cell}">${MApp.Util.escapeHtml(e.description)}</td>
            <td style="${num}">${e.type === 'Payable' ? MApp.Util.formatCurrency(e.amount) : '-'}</td>
            <td style="${num}">${e.type === 'Payment' ? MApp.Util.formatCurrency(e.rawAmount) : '-'}</td>
            <td style="${num}">${MApp.Util.formatCurrency(e.balance)}</td>
          </tr>`).join('')
        : '<tr><td colspan="7" style="padding:10px;text-align:center;color:#999;">No transactions yet for this contractor.</td></tr>';
    }

    return MApp.Print.chooseAction({
      containerId: 'print-contractor-ledger-container',
      filename: `Contractor_Ledger_${String(this.name || '').replace(/[^a-zA-Z0-9_-]/g, '_')}`,
      title: `Statement — ${MApp.Util.formatNameCase(this.name || '')}`
      // No populate: the container is filled by the lines above, which
      // run every time this is opened.
    });
  }
};

// ================================================================
// ACCOUNT — your own name, email and password.
//
// Both RPCs existed on the server and neither was reachable from the
// phone: changing your own password on a mobile-first app was simply
// impossible. Two independent forms with their own save buttons, for the
// reason desktop's core.js gives for the same split -- a typo in the
// password fields must not block saving a corrected email.
// ================================================================
MApp.Account = {
  PROFILE_SPEC: {
    id: 'account-profile',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'email', label: 'Email', type: 'email', required: true }
    ]
  },

  // `current` is deliberately NOT required. An account created by Google
  // sign-in has no password_hash at all (see profile_service.py), and
  // making them prove a password they never set would lock them out of
  // ever setting one. The server decides; the hint says so.
  PASSWORD_SPEC: {
    id: 'account-password',
    fields: [
      { key: 'current', label: 'Current Password', type: 'password',
        hint: 'Leave blank if you sign in with Google and have never set one.' },
      { key: 'next', label: 'New Password', type: 'password', required: true },
      { key: 'confirm', label: 'Confirm New Password', type: 'password', required: true,
        validate: (v, all) => (v !== all.next ? 'The two passwords do not match.' : null) }
    ]
  },

  open() {
    const me = window.MOBILE_CURRENT_USER || {};
    MApp.Form.render('account-profile-body', this.PROFILE_SPEC, {
      name: document.getElementById('more-account-name')?.textContent?.trim() || me.name || '',
      email: me.email || ''
    });
    MApp.Form.render('account-password-body', this.PASSWORD_SPEC, {});
    MApp.Sheet.open('sheet-account');
  },

  close() {
    MApp.Sheet.close('sheet-account');
  },

  async saveProfile() {
    const values = MApp.Form.read(this.PROFILE_SPEC);
    if (!MApp.Form.validate(this.PROFILE_SPEC, values)) return;

    const btn = document.getElementById('account-profile-save-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    const res = await MApp.Util.mutateSimple('updateMyProfile', [values.name, values.email], 'Profile updated.');
    if (btn) { btn.disabled = false; btn.textContent = 'Save Profile'; }
    if (!res.success) return;

    // The More tab's card is rendered from Jinja at page load and never
    // re-fetched, so patch it rather than leaving the old name on screen
    // until the next reload -- the same reasoning core.js gives.
    const nameEl = document.getElementById('more-account-name');
    if (nameEl) nameEl.textContent = values.name;
    const emailEl = document.getElementById('more-account-email');
    if (emailEl) emailEl.textContent = values.email;
    if (window.MOBILE_CURRENT_USER) window.MOBILE_CURRENT_USER.email = values.email;
  },

  async savePassword() {
    const values = MApp.Form.read(this.PASSWORD_SPEC);
    if (!MApp.Form.validate(this.PASSWORD_SPEC, values)) return;

    const btn = document.getElementById('account-password-save-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Changing…'; }
    const res = await MApp.Util.mutateSimple(
      'changeMyPassword', [values.current, values.next, values.confirm], 'Password changed.'
    );
    if (btn) { btn.disabled = false; btn.textContent = 'Change Password'; }
    if (!res.success) return;

    // Never leave a typed password sitting in the DOM after it has been
    // accepted -- the sheet stays open for the profile form above it.
    MApp.Form.render('account-password-body', this.PASSWORD_SPEC, {});
  }
};

// ================================================================
// THEME — System / Light / Dark.
//
// The app followed prefers-color-scheme and nothing else, which is the
// right default and the wrong only option. A phone on a factory floor
// goes from a dark shed to full glare in the time it takes to walk
// there, and the OS setting is usually on a schedule that has nothing to
// do with where its owner is standing.
//
// The choice is applied by stamping data-theme on <html>; the palette
// lives in the stylesheet under both that attribute and the media query
// (see the note above the dark block). Stored per device, not per user:
// it describes the screen in someone's hand, not their account.
// ================================================================
MApp.Theme = {
  KEY: 'maharaja-erp-mobile-theme',
  MODES: ['system', 'light', 'dark'],
  LABELS: { system: 'System', light: 'Light', dark: 'Dark' },

  // The two OS chrome colours, matching the topbar in each palette.
  BAR: { light: '#14181c', dark: '#0c1014' },

  read() {
    let stored = null;
    try { stored = localStorage.getItem(this.KEY); } catch (e) { /* storage inaccessible */ }
    return this.MODES.indexOf(stored) > -1 ? stored : 'system';
  },

  // Called at boot before anything renders, and again on every change.
  // 'system' removes the attribute rather than writing a value, so the
  // media query is back in charge and a phone that changes theme at dusk
  // still follows along without the app being reopened.
  apply(mode) {
    const value = this.MODES.indexOf(mode) > -1 ? mode : 'system';
    const root = document.documentElement;
    if (value === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', value);
    this._syncBarColour(value);
    return value;
  },

  set(mode) {
    const value = this.apply(mode);
    try { localStorage.setItem(this.KEY, value); } catch (e) { /* storage inaccessible */ }
    this._paintPicker();
    return value;
  },

  init() {
    this.apply(this.read());
  },

  // The <meta name="theme-color"> pair in the template is keyed on
  // prefers-color-scheme, so an explicit choice that disagrees with the
  // OS would leave the status bar painted for the other palette. A single
  // unconditional meta wins over both, and is removed again when the
  // choice goes back to System.
  _syncBarColour(mode) {
    const id = 'mapp-theme-color-override';
    const existing = document.getElementById(id);
    if (mode === 'system') {
      if (existing) existing.remove();
      return;
    }
    const meta = existing || document.createElement('meta');
    meta.id = id;
    meta.setAttribute('name', 'theme-color');
    meta.setAttribute('content', this.BAR[mode]);
    if (!existing) document.head.appendChild(meta);
  },

  // Rendered into the More tab on every mount, so it always opens showing
  // what is actually in force.
  render() {
    this._paintPicker();
  },

  _paintPicker() {
    const current = this.read();
    document.querySelectorAll('[data-theme-mode]').forEach(btn => {
      btn.setAttribute('aria-selected', String(btn.dataset.themeMode === current));
    });
    const hint = document.getElementById('theme-hint');
    if (hint) {
      hint.textContent = current === 'system'
        ? 'Following the phone’s own light/dark setting.'
        : `Always ${this.LABELS[current].toLowerCase()}, whatever the phone is set to.`;
    }
  }
};

// ================================================================
// LIST DENSITY — Comfortable / Compact / Grid.
//
// One card per row at a comfortable size is the right default and, on a
// stock list of a thousand-odd item/size rows, a lot of scrolling. The
// two alternatives are not different screens, only different amounts of
// the same screen at once: nothing here changes what a card contains. A
// density control that also hid fields would be a different feature
// wearing this one's name, and the field you cannot see is always the
// one you needed.
//
// Stamped on <html> like the theme, for the same reason: every list
// follows at once and no render function has to know this exists.
// ================================================================
MApp.Density = {
  KEY: 'maharaja-erp-mobile-density',
  MODES: ['comfortable', 'compact', 'grid'],
  LABELS: {
    comfortable: 'Comfortable',
    compact: 'Compact',
    grid: 'Grid'
  },
  BLURB: {
    comfortable: 'One card per row, full size.',
    compact: 'Same cards, tighter — about a third more rows per screen.',
    grid: 'Side by side where the screen is wide enough for it.'
  },

  read() {
    let stored = null;
    try { stored = localStorage.getItem(this.KEY); } catch (e) { /* storage inaccessible */ }
    return this.MODES.indexOf(stored) > -1 ? stored : 'comfortable';
  },

  // Comfortable removes the attribute rather than writing a value, so the
  // default costs no selector matching and the stylesheet reads as
  // "cards, plus two overrides" rather than three equal branches.
  apply(mode) {
    const value = this.MODES.indexOf(mode) > -1 ? mode : 'comfortable';
    const root = document.documentElement;
    if (value === 'comfortable') root.removeAttribute('data-density');
    else root.setAttribute('data-density', value);
    return value;
  },

  set(mode) {
    const value = this.apply(mode);
    try { localStorage.setItem(this.KEY, value); } catch (e) { /* storage inaccessible */ }
    this.paintButton();
    return value;
  },

  init() {
    this.apply(this.read());
    this.paintButton();
  },

  // In the top bar rather than buried in More: this is a per-list reading
  // preference, and the moment someone wants it is while they are looking
  // at the list that is too long.
  async choose() {
    const current = this.read();
    const picked = await MApp.Picker.open({
      title: 'List layout',
      items: this.MODES.map(m => ({
        value: m, label: this.LABELS[m], sublabel: this.BLURB[m]
      })),
      selectedValue: current
    });
    if (!picked) return;
    this.set(picked.value);
    MApp.Haptics.light();
  },

  paintButton() {
    const btn = document.getElementById('mapp-density-btn');
    if (!btn) return;
    const mode = this.read();
    btn.setAttribute('aria-label', `List layout: ${this.LABELS[mode]}`);
    // Three glyphs, one per mode, so the control shows the state it is in
    // instead of a generic icon that means "settings are somewhere".
    const icons = {
      comfortable: '<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/>',
      compact: '<rect x="3" y="4" width="18" height="3.4" rx="1"/><rect x="3" y="10.3" width="18" height="3.4" rx="1"/><rect x="3" y="16.6" width="18" height="3.4" rx="1"/>',
      grid: '<rect x="3" y="4" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="4" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="12.5" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="12.5" width="7.5" height="7.5" rx="1.5"/>'
    };
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${icons[mode]}</svg>`;
  }
};

// ================================================================
// MORE-TAB SECTIONS — which ones are open.
//
// Twelve sections and about forty destinations. As a flat scroll that
// meant hunting, so each section is a <details> and the tab opens as an
// index. The disclosure itself is the browser's; this only remembers.
//
// Remembering matters more than it sounds: the More tab is re-cloned
// from its template on every visit, so without this every section would
// snap shut the moment you came back from the screen you just opened.
// ================================================================
MApp.MoreGroups = {
  KEY: 'maharaja-erp-mobile-more-groups',

  // Only sections the user has opened are stored. An absent key means
  // "never touched", which is what lets the markup's own `open`
  // attribute decide the default -- Account is open because signing out
  // should not be behind a disclosure.
  read() {
    try {
      const raw = localStorage.getItem(this.KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
      return {}; // storage inaccessible, or someone else's data in the key
    }
  },

  write(state) {
    try { localStorage.setItem(this.KEY, JSON.stringify(state)); } catch (e) { /* storage inaccessible */ }
  },

  // Called from MApp.More.mount(), after the template has been cloned in.
  mount() {
    const state = this.read();
    document.querySelectorAll('.mapp-group[data-group]').forEach(el => {
      const key = el.dataset.group;
      if (Object.prototype.hasOwnProperty.call(state, key)) el.open = !!state[key];
      el.addEventListener('toggle', () => this._remember(key, el.open));
    });
  },

  _remember(key, open) {
    const state = this.read();
    state[key] = !!open;
    this.write(state);
  },

  // Every section at once, for when the index itself is what you want --
  // or when you want the old flat scroll back.
  setAll(open) {
    const state = this.read();
    document.querySelectorAll('.mapp-group[data-group]').forEach(el => {
      el.open = open;
      state[el.dataset.group] = open;
    });
    this.write(state);
  }
};

// ================================================================
// MORE — links out to Returns/Items lookup/desktop UI + About row
// ================================================================
MApp.More = {
  mount() {
    MApp.MoreGroups.mount();
    MApp.Theme.render();
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
  // Idempotent with the inline snippet in mobile.html's <head>, which is
  // what actually prevents the flash. This one also fixes up the
  // theme-color meta, which needs a <head> that exists.
  MApp.Theme.init();
  MApp.Density.init();
  MApp.PullToRefresh.init();
  MApp.Shell.init();

  // Fire-and-forget: the logo is only needed by the time something is
  // printed, and a failure here must never delay or block the shell.
  MApp.Print.loadLogo();

  // Register the mobile shell's own service worker (Phase 5: PWA
  // installability). Scoped to /erp/mobile/sw.js, not /static/erp/
  // mobile-sw.js, so its default scope naturally covers /erp/mobile/*
  // -- see app/erp/pages.py's mobile_service_worker route for why.
  // Registration failures are non-fatal -- the app works identically
  // without it, just without install/offline-shell support.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/erp/mobile/sw.js', { scope: '/erp/mobile' })
      .then(reg => MApp.Update.watch(reg))
      .catch(err => console.warn('[PWA] Mobile service worker registration failed:', err));
    MApp.Update.initReloadOnActivate();
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
