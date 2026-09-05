/**
 * MApp feature-parity ratchet (Phase 1).
 *
 * The mobile shell is a second, independent implementation of the same
 * product -- mobile.js's own header says it shares "nothing with desktop's
 * App" except the Api wrapper and the print templates. So every feature has
 * to be built twice, and only one of the two ever gets built: at the time
 * this test was written, 98 of the 169 registered RPC methods were reachable
 * from the desktop bundles and NOT from MApp.
 *
 * A one-off catch-up sprint closes that and it reopens next quarter. This
 * test makes the state an invariant instead of an intention:
 *
 *   - Every registered method must be reachable from MApp, or declared in
 *     DESKTOP_ONLY (a deliberate product decision, with the MApp handoff
 *     screen that must exist for it), or listed in BACKLOG (not ported
 *     yet, tagged with the phase that closes it).
 *   - Nothing may be merely absent. A new desktop-only feature cannot land
 *     silently -- it lands with a decision attached, visible in review as a
 *     diff to one of these two maps.
 *   - Neither map may name a method that IS now reachable. That is the
 *     ratchet: porting a feature makes its entry stale and fails the build
 *     until the entry is deleted, so the backlog can only shrink.
 *   - BACKLOG may not grow past its recorded baseline.
 *
 * Reachability here means "the method name appears as a quoted string in
 * that bundle". That does not prove the call site is wired to a control a
 * user can actually reach, so this is an upper bound on real coverage --
 * deliberately, because the alternative is a test that cannot run without
 * a browser. It is a ratchet against drift, not a proof of parity.
 *
 * CI precedent: the "Service Worker Cache Bump" job already fails the build
 * on a mechanical repo-wide invariant. This is the same idea for features.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const STATIC_DIR = path.join(__dirname, '..');
// tests/ -> erp/ -> static/ -> Project-root/
const SERVICES_DIR = path.join(__dirname, '..', '..', '..', 'app', 'erp', 'services');

// api.js / offline-cache.js are shared infrastructure (both shells load
// them) and the two service workers are not user-facing surfaces, so none
// of them count as "desktop reached it".
const NOT_A_DESKTOP_SURFACE = ['mobile.js', 'mobile-sw.js', 'sw.js', 'offline-cache.js', 'api.js'];

/** Every name registered via @rpc_method("...") across the service layer. */
function registeredMethods() {
  const names = new Set();
  for (const file of fs.readdirSync(SERVICES_DIR).filter(f => f.endsWith('.py'))) {
    const src = fs.readFileSync(path.join(SERVICES_DIR, file), 'utf8');
    for (const m of src.matchAll(/rpc_method\(\s*"([A-Za-z_]+)"/g)) names.add(m[1]);
  }
  return [...names].sort();
}

function read(file) {
  return fs.readFileSync(path.join(STATIC_DIR, file), 'utf8');
}

/** A method is reachable from a bundle if its name appears there quoted. */
function reachableFrom(src, method) {
  return new RegExp(`['"\`]${method}['"\`]`).test(src);
}

const REGISTERED = registeredMethods();
const MOBILE_SRC = read('mobile.js');
const DESKTOP_SRC = fs
  .readdirSync(STATIC_DIR)
  .filter(f => f.endsWith('.js') && !NOT_A_DESKTOP_SURFACE.includes(f))
  .map(read)
  .join('\n');

// ── Deliberately desktop-only ────────────────────────────────────────
// Bulk imports, multi-hundred-row reconciliation, data-hygiene tooling:
// capabilities that would be worse as phone screens, not gaps. The value
// is the MApp screen that must explain the capability and hand off to
// desktop -- silence is the degradation, a documented handoff is not.
const DESKTOP_ONLY = {
  clearLogo: 'Settings → Logo',
  extractColorsFromItemMaster: 'Stock → Colour Master',
  fixItemIdentityDriftReference: 'Items → Sync Review',
  getBomProcessComponentsDrift: 'Products & Processes',
  getItemIdentityDriftReport: 'Items → Sync Review',
  importItemsFromStock: 'Items → Sync Review',
  importProcessTypesFromProcessNames: 'Products & Processes',
  importStockData: 'Stock',
  keepOrphanItem: 'Items → Sync Review',
  keepOrphanItemsBulk: 'Items → Sync Review',
  mergeItemEdit: 'Items → Sync Review',
  mergeSelectedItems: 'Items → Sync Review',
  refreshProcessComponentsFromItemsMaster: 'Products & Processes',
  refreshProductionComponentsFromItemsMaster: 'Production',
  runScheduledItemCleanup: 'Items → Sync Review',
  saveLogo: 'Settings → Logo',
  syncVendorsFromPOHistory: 'Vendors',
};

// ── Not ported yet ───────────────────────────────────────────────────
// The backlog, each tagged with the program phase that closes it. This
// list may only shrink. Deleting an entry is how a port is "done".
const BACKLOG = {
  adjustWarehousePoolManually: 'P5 warehouse pool read + ledger, P6 adjust',
  bulkDeactivateUsers: 'P7 roles (read-only + handoff)',
  changeMyPassword: 'P4 account + password',
  createCustomRole: 'P7 roles (read-only + handoff)',
  deleteClientOrder: 'P6 client orders',
  deleteClientOrdersBulk: 'P2 multi-select in the shared list renderer',
  deleteColor: 'P6 master-data registers',
  deleteColorsBulk: 'P2 multi-select in the shared list renderer',
  deleteContractorPayment: 'P5 contractor ledger (descriptor `related`)',
  deleteContractorPaymentsBulk: 'P2 multi-select in the shared list renderer',
  deleteContractorRate: 'P5 contractor ledger (descriptor `related`)',
  deleteContractorRatesBulk: 'P2 multi-select in the shared list renderer',
  deleteContractorServiceCharge: 'P5 contractor ledger (descriptor `related`)',
  deleteContractorServiceChargesBulk: 'P2 multi-select in the shared list renderer',
  deleteCustomRole: 'P7 roles (read-only + handoff)',
  deleteDispatchPlanLine: 'P7 dispatch plan checklist',
  deleteModel: 'P6 master-data registers',
  deleteModelsBulk: 'P2 multi-select in the shared list renderer',
  deleteProcessType: 'P6 master-data registers',
  deleteProcessTypesBulk: 'P2 multi-select in the shared list renderer',
  deleteReturnsBulk: 'P2 multi-select in the shared list renderer',
  deleteStockGroup: 'P6 master-data registers',
  deleteUnit: 'P6 master-data registers',
  deleteUnitsBulk: 'P2 multi-select in the shared list renderer',
  deleteWarehousePoolOpening: 'P5 warehouse pool read + ledger, P6 adjust',
  excludeWarehousePoolColors: 'P5 warehouse pool read + ledger, P6 adjust',
  getActivityLog: 'P5 read-only screens',
  getAllProcessColorGroups: 'P6 master-data registers',
  getBackupStatus: 'P5 read-only screens',
  getClientOrdersData: 'P6 client orders',
  getColors: 'P6 master-data registers',
  getContractorAccountLedger: 'P5 contractor ledger (descriptor `related`)',
  getContractorLedgerData: 'P5 contractor ledger (descriptor `related`)',
  getContractorRateForProcessType: 'P5 contractor ledger (descriptor `related`)',
  getContractorRatesData: 'P5 contractor ledger (descriptor `related`)',
  getContractorServiceChargesData: 'P5 contractor ledger (descriptor `related`)',
  getDashboardData: 'P5 read-only screens',
  getDispatchPlans: 'P7 dispatch plan checklist',
  getItemLedgerData: 'P5 item ledger + process mappings',
  getNextProductId: 'P6 master-data registers',
  getProcessWipData: 'P5 read-only screens',
  getProcessesForItem: 'P5 item ledger + process mappings',
  getRecentNotificationLogs: 'P5 read-only screens',
  getStockGroupsData: 'P6 master-data registers',
  getUnitsData: 'P6 master-data registers',
  getWarehousePoolData: 'P5 warehouse pool read + ledger, P6 adjust',
  getWarehousePoolLedger: 'P5 warehouse pool read + ledger, P6 adjust',
  getWarehousePoolOpeningData: 'P5 warehouse pool read + ledger, P6 adjust',
  includeWarehousePoolColor: 'P5 warehouse pool read + ledger, P6 adjust',
  reorderBOM: 'P7 move-up / move-down ordering',
  reorderProcesses: 'P7 move-up / move-down ordering',
  saveClientOrder: 'P6 client orders',
  saveColor: 'P6 master-data registers',
  saveDispatchPlanLine: 'P7 dispatch plan checklist',
  saveItemProcessMappings: 'P5 item ledger + process mappings',
  saveModel: 'P6 master-data registers',
  saveProcessType: 'P6 master-data registers',
  saveProductionSheet: 'P6 production status + sheet',
  saveStockGroup: 'P6 master-data registers',
  saveUnit: 'P6 master-data registers',
  saveWarehousePoolOpening: 'P5 warehouse pool read + ledger, P6 adjust',
  setStockGroupItems: 'P6 master-data registers',
  suggestPoAllocations: 'P4 per-line PO allocation in the bill form',
  triggerBackup: 'P5 read-only screens',
  updateCustomRole: 'P7 roles (read-only + handoff)',
  updateDeadStock: 'P6 stock thresholds',
  updateMyProfile: 'P4 account + password',
  updateProductionStatus: 'P6 production status + sheet',
  updateThreshold: 'P6 stock thresholds',
};

// Phase 1 opened at 79. Lower this line as ports land; never raise it.
const BACKLOG_BASELINE = 69;

describe('MApp / desktop feature parity', () => {
  test('the registry is being read at all', () => {
    // Guards the whole suite against silently passing because a moved
    // services directory made REGISTERED empty.
    expect(REGISTERED.length).toBeGreaterThan(150);
    expect(REGISTERED).toContain('saveProduction');
  });

  test('every registered method is reachable from MApp, or declared', () => {
    const undeclared = REGISTERED.filter(
      m => !reachableFrom(MOBILE_SRC, m) && !(m in DESKTOP_ONLY) && !(m in BACKLOG)
    );

    // A method reachable from NEITHER shell is dead server surface, not a
    // mobile gap -- it is not this test's business, so exclude it here.
    const mobileGaps = undeclared.filter(m => reachableFrom(DESKTOP_SRC, m));

    expect(mobileGaps).toEqual([]);
  });

  test('no declared entry is stale -- the ratchet', () => {
    // Porting a feature makes its entry wrong. This fails until the entry
    // is deleted, which is what stops the backlog drifting back upward.
    const stale = [...Object.keys(DESKTOP_ONLY), ...Object.keys(BACKLOG)]
      .filter(m => reachableFrom(MOBILE_SRC, m));

    expect(stale).toEqual([]);
  });

  test('no declared entry names a method that no longer exists', () => {
    const unknown = [...Object.keys(DESKTOP_ONLY), ...Object.keys(BACKLOG)]
      .filter(m => !REGISTERED.includes(m));

    expect(unknown).toEqual([]);
  });

  test('a method is declared in one map or the other, never both', () => {
    const both = Object.keys(DESKTOP_ONLY).filter(m => m in BACKLOG);
    expect(both).toEqual([]);
  });

  test('the backlog has not grown', () => {
    expect(Object.keys(BACKLOG).length).toBeLessThanOrEqual(BACKLOG_BASELINE);
  });

  test('every desktop-only capability names the MApp screen that hands off to it', () => {
    // The commitment behind "all features accessible": a capability that
    // stays on desktop must still be findable from the phone. These are
    // the screens Phase 7 has to build -- named here so the list cannot be
    // quietly forgotten.
    const missing = Object.entries(DESKTOP_ONLY).filter(([, screen]) => !screen || !screen.trim());
    expect(missing).toEqual([]);
  });
});
