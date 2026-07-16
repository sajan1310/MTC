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

const Api = (() => {
  function _csrfToken() {
    return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
  }

  async function _request(method, args, mutationId) {
    const headers = { 'Content-Type': 'application/json', 'X-CSRFToken': _csrfToken() };
    if (mutationId) headers['X-Mutation-Id'] = mutationId;

    const res = await fetch(`/api/erp/rpc/${method}`, {
      method: 'POST',
      headers,
      credentials: 'same-origin',
      body: JSON.stringify({ args: args || [] })
    });

    if (!res.ok && res.status !== 200) {
      let message = `Backend method "${method}" failed (HTTP ${res.status}).`;
      try {
        const body = await res.json();
        if (body && body.message) message = body.message;
      } catch (e) { /* non-JSON error body -- keep the generic message */ }
      throw new Error(message);
    }

    return res.json();
  }

  return {
    call(method, ...args) {
      return _request(method, args, null);
    },

    mutate(method, ...args) {
      const mutationId = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = (Math.random() * 16) | 0;
            return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
          });
      return _request(method, args, mutationId);
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

// Ported from Script_Production.html's App.Production.formatQty -- trims
// trailing zeros after fixing to 4 decimals. Lives here (not in a
// production.js that doesn't exist yet) since it's a pure numeric
// formatter with no Production-specific coupling; used by dashboard.js.
function formatQty(value) {
  const n = toNumber(value);
  return Number(n.toFixed(4)).toString();
}
