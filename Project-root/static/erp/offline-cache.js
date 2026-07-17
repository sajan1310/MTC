'use strict';
// offline-cache.js -- a small generic IndexedDB read-through cache.
//
// Phase 6 Round 1 scope: cache the LAST SUCCESSFUL response of a chosen
// handful of read RPCs, keyed by method name, so a screen can fall back
// to "last known good" data when a network call fails outright. This is
// deliberately NOT a true delta-sync/changes-since system (see mobile.js's
// MApp.Api.callCached header comment for why) -- just a plain read-through
// cache. Framework-agnostic so a later round can reuse it for desktop too.
//
// Every method is best-effort: IndexedDB being unavailable (private
// browsing in some browsers, very old browsers with no indexedDB at all)
// must never break the app -- it just means no offline fallback, same as
// if nothing had ever been cached.

const OfflineCache = (() => {
  const DB_NAME = 'erp-offline-cache';
  const DB_VERSION = 1;
  const STORE_NAME = 'rpcResponses';

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

  return { open, get, put };
})();
