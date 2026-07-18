'use strict';
// offline-cache.js -- a small generic IndexedDB read-through cache, plus
// (Phase 6 Round 3) an outbox store for queueing mutations made offline.
//
// Phase 6 Round 1 scope: cache the LAST SUCCESSFUL response of a chosen
// handful of read RPCs, keyed by method name, so a screen can fall back
// to "last known good" data when a network call fails outright. This is
// deliberately NOT a true delta-sync/changes-since system (see mobile.js's
// MApp.Api.callCached header comment for why) -- just a plain read-through
// cache. Framework-agnostic so a later round can reuse it for desktop too.
//
// Phase 6 Round 3 adds a second object store, `outbox`, for exactly the
// same reason: plain IndexedDB CRUD with no MApp/Api dependency, so the
// actual replay orchestration (which needs Api.mutateWithId and
// MApp.Toast) stays in mobile.js while the persistence primitives stay
// here, reusable by desktop later.
//
// Every method is best-effort: IndexedDB being unavailable (private
// browsing in some browsers, very old browsers with no indexedDB at all)
// must never break the app -- it just means no offline fallback, same as
// if nothing had ever been cached.

const OfflineCache = (() => {
  const DB_NAME = 'erp-offline-cache';
  const DB_VERSION = 2;
  const STORE_NAME = 'rpcResponses';
  const OUTBOX_STORE_NAME = 'outbox';

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;

    if (typeof indexedDB === 'undefined') {
      // No IndexedDB support at all -- resolve to null so every get/put
      // call below can silently no-op instead of throwing.
      dbPromise = Promise.resolve(null);
      return dbPromise;
    }

    dbPromise = new Promise(resolve => {
      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        resolve(null);
        return;
      }

      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'method' });
        }
        if (!db.objectStoreNames.contains(OUTBOX_STORE_NAME)) {
          db.createObjectStore(OUTBOX_STORE_NAME, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });

    return dbPromise;
  }

  // Keyed by method name only -- both of this round's cached calls
  // (getMobileDashboard, getStockData) take no arguments. A parameterized
  // call added to the cache list later would need a compound key (e.g.
  // `${method}|${JSON.stringify(args)}`) -- not needed yet.
  async function get(method) {
    const db = await open();
    if (!db) return null;

    return new Promise(resolve => {
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(method);
        req.onsuccess = () => {
          const row = req.result;
          resolve(row ? { response: row.response, cachedAt: row.cachedAt } : null);
        };
        req.onerror = () => resolve(null);
      } catch (err) {
        resolve(null);
      }
    });
  }

  async function put(method, response) {
    const db = await open();
    if (!db) return;

    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({ method, response, cachedAt: Date.now() });
    } catch (err) {
      // Best-effort -- a write failure here must never surface to the caller.
    }
  }

  // ── Outbox (Phase 6 Round 3) ─────────────────────────────────────────
  // mutationId is generated once by the caller (see api.js's
  // Api.newMutationId) and stored here as-is -- it must be reused
  // unchanged on replay, never regenerated, or the idempotency guarantee
  // this whole design leans on breaks. `id` (the auto-increment primary
  // key) is what gives listPending() its FIFO ordering for free.
  async function outboxEnqueue(mutationId, method, args) {
    const db = await open();
    if (!db) return;

    try {
      const tx = db.transaction(OUTBOX_STORE_NAME, 'readwrite');
      tx.objectStore(OUTBOX_STORE_NAME).add({
        mutationId, method, args, queuedAt: Date.now(), status: 'pending', lastError: null
      });
    } catch (err) {
      // Best-effort, same as put() above -- a queueing failure here just
      // means this one action didn't get an offline fallback.
    }
  }

  async function outboxListPending() {
    const db = await open();
    if (!db) return [];

    return new Promise(resolve => {
      try {
        const tx = db.transaction(OUTBOX_STORE_NAME, 'readonly');
        const req = tx.objectStore(OUTBOX_STORE_NAME).getAll();
        req.onsuccess = () => resolve((req.result || []).filter(e => e.status === 'pending'));
        req.onerror = () => resolve([]);
      } catch (err) {
        resolve([]);
      }
    });
  }

  async function outboxMarkDone(id) {
    const db = await open();
    if (!db) return;

    try {
      const tx = db.transaction(OUTBOX_STORE_NAME, 'readwrite');
      tx.objectStore(OUTBOX_STORE_NAME).delete(id);
    } catch (err) {
      // Best-effort.
    }
  }

  async function outboxMarkFailed(id, message) {
    const db = await open();
    if (!db) return;

    try {
      const tx = db.transaction(OUTBOX_STORE_NAME, 'readwrite');
      const store = tx.objectStore(OUTBOX_STORE_NAME);
      const req = store.get(id);
      req.onsuccess = () => {
        const row = req.result;
        if (!row) return;
        row.status = 'failed';
        row.lastError = message || 'Unknown error';
        store.put(row);
      };
    } catch (err) {
      // Best-effort.
    }
  }

  async function outboxCountPendingAndFailed() {
    const db = await open();
    if (!db) return 0;

    return new Promise(resolve => {
      try {
        const tx = db.transaction(OUTBOX_STORE_NAME, 'readonly');
        const req = tx.objectStore(OUTBOX_STORE_NAME).getAll();
        req.onsuccess = () => {
          const rows = req.result || [];
          resolve(rows.filter(e => e.status === 'pending' || e.status === 'failed').length);
        };
        req.onerror = () => resolve(0);
      } catch (err) {
        resolve(0);
      }
    });
  }

  // Phase 6 (provisional-ID reconciliation): a lightweight "N still
  // waiting to sync" count scoped to one RPC method, so each screen can
  // show its own queued-item banner without needing to fabricate a fake
  // list card for every queued record. Pending only (not failed) --
  // a failed entry is a real, already-seen rejection, not something
  // still "waiting."
  async function outboxCountPendingForMethod(method) {
    const db = await open();
    if (!db) return 0;

    return new Promise(resolve => {
      try {
        const tx = db.transaction(OUTBOX_STORE_NAME, 'readonly');
        const req = tx.objectStore(OUTBOX_STORE_NAME).getAll();
        req.onsuccess = () => {
          const rows = req.result || [];
          resolve(rows.filter(e => e.status === 'pending' && e.method === method).length);
        };
        req.onerror = () => resolve(0);
      } catch (err) {
        resolve(0);
      }
    });
  }

  return {
    open, get, put,
    outbox: {
      enqueue: outboxEnqueue,
      listPending: outboxListPending,
      markDone: outboxMarkDone,
      markFailed: outboxMarkFailed,
      countPendingAndFailed: outboxCountPendingAndFailed,
      countPendingForMethod: outboxCountPendingForMethod
    }
  };
})();
