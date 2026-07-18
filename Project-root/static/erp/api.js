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

  function _newMutationId() {
    return (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
          const r = (Math.random() * 16) | 0;
          return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
        });
  }

  return {
    call(method, ...args) {
      return _request(method, args, null);
    },

    mutate(method, ...args) {
      return _request(method, args, _newMutationId());
    },

    // Phase 6 Round 3 -- for callers (the offline outbox) that need the
    // SAME mutation-id across a live attempt and a later replay, so a
    // request that reached the server but lost its response on the way
    // back doesn't execute twice when retried. Ordinary callers should
    // keep using .mutate(), which generates a fresh id per call same as
    // before.
    newMutationId: _newMutationId,

    mutateWithId(method, mutationId, ...args) {
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
          (i.affectsStock === false ? ' <span class="badge bg-warning text-dark">Ledger only</span>' : '')
        : escapeHtml(i)
    )
    .join('<br>');
}

function todayIso() {
  const d = new Date();
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
