'use strict';
// api.js -- the client-side seam ported from Apps_Script/Script_ApiCore.html's
// _apiCall. Source wrapped google.script.run in a Promise; this wraps a POST
// to /api/erp/rpc/<method> (app/erp/rpc.py) the same way, adding the two
// things Apps Script's transport handled for free: CSRF (this Flask app's
// erp_rpc_bp is not CSRF-exempt -- see app/__init__.py) and X-Mutation-Id
// (rpc.py requires one, a fresh UUID per call, for any RPC method whose
// registry.py spec has mutation=True -- replays of the same id return the
// cached first-execution result instead of re-running the method).
//
// Api.call(method, ...args) is for read-only methods. Api.mutate(method, ...args)
// is for mutating ones -- callers must pick the right one; there is no way to
// ask the server which a method is without an extra round trip, and every
// ported view already knows which of its own calls are saves/deletes.
//
// Api.mutateWithId(method, mutationId, ...args) + Api.newMutationId() (Phase
// 6 Round 3) exist for the mobile offline outbox: it needs the exact same
// mutation-id on both a live attempt and any later replay of that same user
// action, which .mutate()'s always-fresh-UUID behavior can't provide.
//
// Phase 6 (Background Sync): this file is also loaded inside the mobile
// service worker (mobile-sw.js's importScripts) so a background sync event
// can replay the outbox without the page being open. A service worker has
// no `document` -- _csrfToken() below falls back to an explicit override
// (Api.setCsrfToken, called by the page via a postMessage the SW forwards
// to itself) instead of the meta-tag read that only works in page context.

const Api = (() => {
  let _csrfOverride = null;

  // ── Read cache (stale-while-revalidate-lite) ───────────────────────────
  // Fixes the "every tab switch re-downloads the whole table" problem
  // (App.Navigation.showTab in core.js unconditionally calls each module's
  // loadData(), and no getXData method paginates -- see PERFORMANCE_AUDIT.md
  // PERF-003). A cache hit resolves instantly with no network round trip; a
  // miss behaves exactly as before. Concurrent identical calls (two views
  // asking for the same data at once) share one in-flight request.
  //
  // Invalidation is deliberately blunt: ANY successful (or failed, in case a
  // network error masked a write that actually landed) Api.mutate() clears
  // the whole cache, rather than trying to map which of the 135 RPC methods'
  // getters a given mutation affects -- no such mapping exists, and guessing
  // wrong would show stale data after a save, which is worse than the extra
  // re-fetches a full clear costs.
  //
  // A short denylist bypasses the cache entirely for methods where a stale
  // answer would be actively wrong, not just annoying: BOM-access and
  // stock-adjustment-conflict checks must reflect the live server state at
  // the moment they're asked, and testConnection is a diagnostic that must
  // always hit the network.
  // Ceiling on any single RPC round trip (REL-001). Generous: the slowest
  // legitimate calls here are whole-table reads like getStockData, which get
  // slower as the database grows (see PERF-002), and a bulk save can take
  // seconds. This is a backstop against a request that will NEVER return, not
  // a performance budget -- set it too tight and a slow-but-working save is
  // reported as a failure the user then repeats.
  const REQUEST_TIMEOUT_MS = 45_000;

  const CACHE_TTL_MS = 15_000;
  const NO_CACHE_METHODS = new Set(['verifyBOMAccess', 'checkStockAdjustmentConflicts', 'testConnection']);
  const _cache = new Map();    // key -> {value, at}
  const _inflight = new Map(); // key -> Promise

  function _cacheKey(method, args) {
    return method + '::' + JSON.stringify(args || []);
  }

  function _invalidateCache() {
    _cache.clear();
    _inflight.clear();
  }

  async function _cachedRequest(method, args) {
    if (NO_CACHE_METHODS.has(method)) return _request(method, args, null);

    const key = _cacheKey(method, args);
    const hit = _cache.get(key);
    if (hit && (Date.now() - hit.at) < CACHE_TTL_MS) return hit.value;

    const pending = _inflight.get(key);
    if (pending) return pending;

    const p = _request(method, args, null).then(
      value => {
        // Only cache a SUCCESSFUL envelope (API-001).
        //
        // Domain failures come back as HTTP 200 with {success:false} (see
        // app/erp/rpc.py), so the previous unconditional _cache.set() stored
        // failures too. A transient error -- a lock conflict, a validation
        // race, a momentary backend fault -- was then replayed from cache for
        // the next 15 seconds, so the user pressing the button again got the
        // identical error back without a request ever reaching the server. It
        // looked like a hard failure rather than something worth retrying.
        if (value && value.success) {
          _cache.set(key, { value, at: Date.now() });
        }
        _inflight.delete(key);
        return value;
      },
      err => { _inflight.delete(key); throw err; }
    );
    _inflight.set(key, p);
    return p;
  }

  function _csrfToken() {
    if (_csrfOverride) return _csrfOverride;
    if (typeof document === 'undefined') return ''; // service worker context, no override set yet
    return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
  }

  async function _request(method, args, mutationId) {
    const headers = { 'Content-Type': 'application/json', 'X-CSRFToken': _csrfToken() };
    if (mutationId) headers['X-Mutation-Id'] = mutationId;

    let res;
    // REL-001. fetch() has NO default timeout: a request that stalls -- a
    // half-open TCP connection after the factory WiFi drops, a captive
    // portal swallowing packets, a worker wedged mid-query -- never settles.
    // The awaiting caller's spinner then spins forever, and the user's only
    // recovery is reloading the page and losing whatever they had typed.
    //
    // An abort is reported as a network error, deliberately: it is
    // indistinguishable from an outage from the client's point of view, and
    // routing it down that path means the mobile offline outbox's existing
    // retry logic picks it up unchanged rather than needing a new case.
    const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      : null;
    try {
      res = await fetch(`/api/erp/rpc/${method}`, {
        method: 'POST',
        headers,
        credentials: 'same-origin',
        body: JSON.stringify({ args: args || [] }),
        signal: controller ? controller.signal : undefined
      });
    } catch (networkErr) {
      // The fetch itself never completed -- DNS failure, no connection,
      // CORS, a dropped connection before any response arrived, or our own
      // abort above. This is the ONLY case that means "still offline, retry
      // later"; see isNetworkError below.
      const aborted = networkErr && networkErr.name === 'AbortError';
      const err = new Error(
        aborted
          ? `The server did not respond within ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s. It may still be working — check before retrying.`
          : (networkErr && networkErr.message) || 'Network request failed.'
      );
      err.isNetworkError = true;
      err.isTimeout = !!aborted;
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!res.ok && res.status !== 200) {
      // The server WAS reached and responded -- a real HTTP-level failure
      // (a CSRF token that expired since this page loaded, a 500, rate
      // limiting, ...). Distinct from isNetworkError: retrying this
      // blindly forever would never succeed on its own, unlike a genuine
      // outage. Callers (the offline outbox) must mark this failed, not
      // silently requeue it -- see mobile.js's MApp.Outbox.flush().
      let message = `Backend method "${method}" failed (HTTP ${res.status}).`;
      try {
        const body = await res.json();
        if (body && (body.message || body.error)) {
          message = body.message || body.error;
        }
      } catch (e) { /* non-JSON error body -- keep the generic message */ }
      const err = new Error(message);
      err.isHttpError = true;
      err.status = res.status;
      throw err;
    }

    return res.json();
  }

  function _newMutationId() {
    return (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
          const r = (Math.random() * 16) | 0;
          return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
        });
  }

  // ── One id per user action (DATA-003) ──────────────────────────────────
  // Two submissions of the same save within this window are treated as the
  // same action and share a mutation id, so the server executes them once.
  //
  // 10s covers a double-click, an Enter-key repeat, an impatient second click
  // while a slow save is in flight, and a user retrying after a stall -- the
  // realistic ways one intended action becomes two requests. It is short
  // enough that deliberately repeating an identical save (adding the same
  // item twice on purpose) is not swallowed: that takes longer than ten
  // seconds to do, and the args would usually differ anyway.
  const DEDUPE_WINDOW_MS = 10_000;
  const _actionIds = new Map();   // key -> {id, at}

  function _actionKey(method, args) {
    try {
      return method + '::' + JSON.stringify(args || []);
    } catch (e) {
      // Argument that will not serialise (a cyclic object, a DOM node). Fall
      // back to a unique key so this call simply gets its own id rather than
      // colliding with an unrelated one.
      return method + '::' + _newMutationId();
    }
  }

  function _actionMutationId(method, args) {
    const key = _actionKey(method, args);
    const now = Date.now();

    // Opportunistic sweep -- this map must not grow for the life of the page.
    if (_actionIds.size > 200) {
      for (const [k, v] of _actionIds) {
        if ((now - v.at) > DEDUPE_WINDOW_MS) _actionIds.delete(k);
      }
    }

    const hit = _actionIds.get(key);
    if (hit && (now - hit.at) < DEDUPE_WINDOW_MS) return hit.id;

    const id = _newMutationId();
    _actionIds.set(key, { id, at: now });
    return id;
  }

  function _forgetActionId(method, args) {
    _actionIds.delete(_actionKey(method, args));
  }

  return {
    call(method, ...args) {
      return _cachedRequest(method, args);
    },

    // Bypasses the read cache entirely. For the rare caller that must see
    // live server state even within the 15s window (most callers don't need
    // this -- the NO_CACHE_METHODS denylist above already excludes the
    // methods where that's a correctness requirement, not just a preference).
    callFresh(method, ...args) {
      return _request(method, args, null);
    },

    // Drops every cached read. Exposed mainly for tests and for callers that
    // know something changed the server didn't tell this tab about (e.g. the
    // mobile outbox reconciling after a background sync).
    invalidateCache: _invalidateCache,

    // One mutation id per USER ACTION, not per network call (DATA-003).
    //
    // This used to mint a fresh UUID on every invocation, which meant the
    // server-side idempotency table could never match for ordinary desktop
    // use -- it was pure write amplification, and double-submit protection
    // rested entirely on client-side button disabling (defeated by a second
    // tab, an Enter-key repeat, or a user retrying after a network stall).
    //
    // The id is now derived from the method plus its arguments and held for
    // DEDUPE_WINDOW_MS, so the same save fired twice in quick succession
    // carries the same id and the server executes it once. A genuinely
    // different save -- different args -- gets its own id immediately, and
    // the same save repeated deliberately after the window is a new action,
    // which it is.
    mutate(method, ...args) {
      const mutationId = _actionMutationId(method, args);
      return _request(method, args, mutationId).then(
        res => { _invalidateCache(); return res; },
        err => {
          _invalidateCache();
          // A request that never reached the server did not consume its id.
          // Forgetting it lets an immediate retry start cleanly instead of
          // colliding with a claim that was never taken.
          if (err && err.isNetworkError) _forgetActionId(method, args);
          throw err;
        }
      );
    },

    // Phase 6 Round 3 -- for callers (the offline outbox) that need the
    // SAME mutation-id across a live attempt and a later replay, so a
    // request that reached the server but lost its response on the way
    // back doesn't execute twice when retried. Ordinary callers should
    // keep using .mutate(), which generates a fresh id per call same as
    // before.
    newMutationId: _newMutationId,

    mutateWithId(method, mutationId, ...args) {
      return _request(method, args, mutationId).then(
        res => { _invalidateCache(); return res; },
        err => { _invalidateCache(); throw err; }
      );
    },

    // Phase 6 (Background Sync) -- lets the service worker (which has no
    // meta-tag to read) use a CSRF token the page handed it via
    // postMessage. Page contexts never need to call this; the meta-tag
    // read in _csrfToken() already works there.
    setCsrfToken(token) {
      _csrfOverride = token || null;
    }
  };
})();

// ── Shared formatting/escaping helpers ──────────────────────────────────
// Ported from Script_Core.html -- used by every rendered view, not just
// Dashboard, so they live here alongside Api rather than in core.js.

const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, ch => HTML_ESCAPE_MAP[ch]);
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function formatCurrency(value) {
  return `₹${toNumber(value).toFixed(2)}`;
}

// Resolves a sortable Date from a record's ISO timestamp, falling back to
// its DD/MM/YYYY display date (e.g. PO/Bill poDate/billDate fields).
function parseRecordDate(rawIso, displayDate) {
  if (rawIso) {
    const fromRaw = new Date(rawIso);
    if (!isNaN(fromRaw.getTime())) return fromRaw;
  }
  const parts = String(displayDate || '').split('/');
  if (parts.length === 3) {
    return new Date(parts.reverse().join('-'));
  }
  return new Date(NaN);
}

// Ported from Script_Production.html's App.Production.formatQty -- trims
// trailing zeros after fixing to 4 decimals. Lives here (not in a
// production.js that doesn't exist yet) since it's a pure numeric
// formatter with no Production-specific coupling; used by dashboard.js.
function formatQty(value) {
  const n = toNumber(value);
  return Number(n.toFixed(4)).toString();
}

// Mirrors config.js#PO_STATUS (server) exactly -- the one client-side copy
// of the 3 status strings module_po.js#_attachPoStatus derives from the
// Bill ledger. Ported from Script_ApiCore.html, which both desktop and
// mobile shells load before their own module scripts.
const PO_STATUS = Object.freeze({
  ISSUED: 'PO Issued',
  PARTIAL: 'Partially Received',
  COMPLETED: 'Completed'
});

// Renders a PO/Bill line-item list as an HTML preview string. Handles both
// structured item objects and legacy plain-string item entries.
function formatItemsPreview(items) {
  if (!Array.isArray(items)) return '';
  return items
    .map(i =>
      typeof i === 'object' && i !== null
        ? `${escapeHtml(i.name)}${i.size ? ` [${escapeHtml(i.size)}]` : ''} (${escapeHtml(i.qty)} ${escapeHtml(i.unit || 'Pcs')})` +
          // Only Labor Job Bill items carry this field -- undefined for
          // Goods Bill/PO/Return items, so this is a no-op for them.
          (i.color ? ` <span class="badge bg-info-subtle text-info-emphasis border border-info-subtle">${escapeHtml(i.color)}</span>` : '') +
          (i.affectsStock === false ? ' <span class="badge bg-warning text-dark">Ledger only</span>' : '')
        : escapeHtml(i)
    )
    .join('<br>');
}

function todayIso() {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

// Same local-timezone field-based construction as todayIso (not
// toISOString(), which shifts to UTC and can land on the wrong day near
// midnight) -- Dispatch Plan's whole premise is "plan tomorrow", so this
// needs to be the browser's own tomorrow, not a UTC one.
function tomorrowIso() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

// Converts a record's raw ISO timestamp (preferred) or DD/MM/YYYY display
// date into the YYYY-MM-DD format <input type="date"> expects/produces.
function dateToInputValue(rawIso, displayDate) {
  if (rawIso) {
    const iso = String(rawIso).split('T')[0];
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  }
  const d = String(displayDate || '');
  if (d.includes('/')) {
    const [day, month, year] = d.split('/');
    if (day && month && year?.length === 4) {
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  return '';
}

function normalizeDateForInput(po) {
  if (!po) return '';
  return dateToInputValue(po.poDateRaw, po.poDate);
}
