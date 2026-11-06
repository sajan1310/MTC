/**
 * The offline copy of a response is written out of the way of taps.
 *
 * Storing getProductionData (7.5 MB by November 2026) blocked a budget
 * phone's main thread for 360-410 ms, the moment the list arrived -- right
 * after the tap that opened Production -- and it was stored again on every
 * remount, even when Api.call answered from memory with the very object
 * stored last time. A search typed then waited for it: the phone's worst
 * INP. Now each response is stored once, when the browser is idle, as JSON
 * text, and rows written the old way still read.
 */

'use strict';

if (typeof structuredClone === 'undefined') {
  global.structuredClone = obj => JSON.parse(JSON.stringify(obj));
}

require('fake-indexeddb/auto');
const fs = require('fs');
const path = require('path');

function loadAsGlobal(relPath, exportName) {
  const code = fs
    .readFileSync(path.join(__dirname, '..', relPath), 'utf8')
    .replace(new RegExp(`^const ${exportName} = `, 'm'), `global.${exportName} = `);
  eval(code);
}

function freshCache() {
  jest.resetModules();
  global.indexedDB = require('fake-indexeddb').indexedDB;
  loadAsGlobal('offline-cache.js', 'OfflineCache');
}

/** The raw row offline-cache.js keeps for `method`. */
function rawRow(method) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('erp-offline-cache', 2);
    req.onsuccess = () => {
      const get = req.result.transaction('rpcResponses', 'readonly').objectStore('rpcResponses').get(method);
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(get.error);
    };
    req.onerror = () => reject(req.error);
  });
}

function writeRawRow(row) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('erp-offline-cache', 2);
    req.onsuccess = () => {
      const tx = req.result.transaction('rpcResponses', 'readwrite');
      tx.objectStore('rpcResponses').put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

const settle = () => new Promise(r => setTimeout(r, 50));
const LOTS = { success: true, data: [{ rowIdx: 1, lotNumber: 'LOT-1', componentsConsumed: [{ itemName: 'Rim', qty: 2 }] }] };

describe('offline-cache.js', () => {
  beforeEach(freshCache);

  test('a response is stored as JSON text and reads back as the same data', async () => {
    await OfflineCache.put('getProductionData', LOTS);
    await settle();

    const row = await rawRow('getProductionData');
    expect(typeof row.json).toBe('string');
    expect(row.response).toBeUndefined();
    const hit = await OfflineCache.get('getProductionData');
    expect(hit.response).toEqual(LOTS);
    expect(typeof hit.cachedAt).toBe('number');
  });

  test('a row written before this change still reads', async () => {
    await OfflineCache.get('warm-up'); // opens the database and its stores
    await writeRawRow({ method: 'getStockData', response: { success: true, data: [1, 2] }, cachedAt: 1234 });

    expect(await OfflineCache.get('getStockData')).toEqual({ response: { success: true, data: [1, 2] }, cachedAt: 1234 });
  });

  test('an unreadable row is treated as nothing stored', async () => {
    await OfflineCache.get('warm-up');
    await writeRawRow({ method: 'getStockData', json: '{"success":tr', cachedAt: 1 });

    expect(await OfflineCache.get('getStockData')).toBeNull();
  });
});

describe('MApp.OfflineWrites', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    global.fetch = jest.fn();
    loadAsGlobal('api.js', 'Api');
    loadAsGlobal('mobile.js', 'MApp');
    global.OfflineCache = { put: jest.fn() };
    delete global.requestIdleCallback; // jsdom has none: the setTimeout path
  });

  afterEach(() => {
    jest.useRealTimers();
    delete global.OfflineCache;
  });

  test('nothing is written in the same breath as the response', () => {
    MApp.OfflineWrites.store('getProductionData', LOTS);
    expect(OfflineCache.put).not.toHaveBeenCalled();
    jest.runOnlyPendingTimers();
    expect(OfflineCache.put).toHaveBeenCalledWith('getProductionData', LOTS);
  });

  test('the same response is written once, however often it is handed over', () => {
    MApp.OfflineWrites.store('getProductionData', LOTS);
    jest.runOnlyPendingTimers();
    MApp.OfflineWrites.store('getProductionData', LOTS);
    MApp.OfflineWrites.store('getProductionData', LOTS);
    jest.runOnlyPendingTimers();
    expect(OfflineCache.put).toHaveBeenCalledTimes(1);
  });

  test('only the newest response per method is written', () => {
    const older = { success: true, data: ['old'] };
    MApp.OfflineWrites.store('getProductionData', older);
    MApp.OfflineWrites.store('getProductionData', LOTS);
    jest.runOnlyPendingTimers();
    expect(OfflineCache.put.mock.calls).toEqual([['getProductionData', LOTS]]);
  });

  test('one method per idle moment, so two lists never make one long task', () => {
    const stock = { success: true, data: [] };
    MApp.OfflineWrites.store('getProductionData', LOTS);
    MApp.OfflineWrites.store('getStockData', stock);
    jest.runOnlyPendingTimers();
    expect(OfflineCache.put).toHaveBeenCalledTimes(1);
    jest.runOnlyPendingTimers();
    expect(OfflineCache.put).toHaveBeenCalledTimes(2);
  });

  test('a store that is not there (or throws) changes nothing for the caller', () => {
    global.OfflineCache = {};
    MApp.OfflineWrites.store('getProductionData', LOTS);
    expect(() => jest.runOnlyPendingTimers()).not.toThrow();
  });

  test('an idle callback is used where the browser has one', () => {
    const idle = [];
    global.requestIdleCallback = jest.fn((fn, opts) => { idle.push({ fn, opts }); return 1; });
    MApp.OfflineWrites.store('getProductionData', LOTS);
    expect(idle).toHaveLength(1);
    expect(idle[0].opts).toEqual({ timeout: 5000 });
    idle[0].fn();
    expect(OfflineCache.put).toHaveBeenCalledWith('getProductionData', LOTS);
  });

  test('callCached hands its response over and answers at once', async () => {
    MApp.Api.call = jest.fn(async () => LOTS);
    MApp.Api.callCached = MApp.Api.callCached.bind(MApp.Api);
    Api.call = MApp.Api.call;
    const res = await MApp.Api.callCached('getProductionData');
    expect(res).toBe(LOTS);
    expect(OfflineCache.put).not.toHaveBeenCalled();
    jest.runOnlyPendingTimers();
    expect(OfflineCache.put).toHaveBeenCalledWith('getProductionData', LOTS);
  });
});
