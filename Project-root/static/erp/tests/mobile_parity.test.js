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

// MApp.Handoff.CAPABILITIES names every desktop-only method, so that the
// handoff screen and DESKTOP_ONLY cannot drift apart (see the last test).
// It has to come OUT of the reachability scan first: that scan means "the
// method name appears as a quoted string in this bundle", and naming a
// capability on a screen that explains where to go for it is the opposite
// of implementing it. Left in, all eighteen entries would read as ported
// and the ratchet would declare every one of them stale.
const RAW_MOBILE_SRC = read('mobile.js');
const CATALOGUE_START = 'parity:handoff-catalogue:start';
const CATALOGUE_END = 'parity:handoff-catalogue:end';

function sliceCatalogue(src) {
  const from = src.indexOf(CATALOGUE_START);
  const to = src.indexOf(CATALOGUE_END);
  return from === -1 || to === -1 || to < from ? null : src.slice(from, to);
}

const HANDOFF_CATALOGUE = sliceCatalogue(RAW_MOBILE_SRC);
const MOBILE_SRC = HANDOFF_CATALOGUE
  ? RAW_MOBILE_SRC.replace(HANDOFF_CATALOGUE, '')
  : RAW_MOBILE_SRC;

/** Every method named in a `methods: [...]` list inside the catalogue. */
function handoffMethods() {
  if (!HANDOFF_CATALOGUE) return [];
  const names = new Set();
  for (const list of HANDOFF_CATALOGUE.matchAll(/methods:\s*\[([^\]]*)\]/g)) {
    for (const m of list[1].matchAll(/'([A-Za-z_]+)'/g)) names.add(m[1]);
  }
  return [...names];
}
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
  // Deliberately NOT ported. It is a preview of the ID a new recipe will
  // get, and it is not one: get_next_product_id calls nextval() on
  // erp.product_id_seq, and so does save_bom. Opening desktop's Add BOM
  // modal therefore burns a sequence value and the recipe saves under the
  // NEXT one -- the number shown is never the number assigned. Mobile's
  // add-recipe form shows no ID at all, which is the accurate thing to
  // show, and reproducing the preview would ship a number that lies.
  getNextProductId: 'Products & Processes',
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
};

// Phase 1 opened at 79. Lower this line as ports land; never raise it.
const BACKLOG_BASELINE = 0;

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
    // stays on desktop must still be findable from the phone.
    const missing = Object.entries(DESKTOP_ONLY).filter(([, screen]) => !screen || !screen.trim());
    expect(missing).toEqual([]);
  });

  // ── The handoff actually exists ────────────────────────────────────
  // The check above only ever proved the LABEL was non-empty. It could
  // not tell a built screen from a string, and for most of this program
  // it was naming screens nobody had built: a phone user who went looking
  // for one of these capabilities met silence, which is the exact
  // degradation DESKTOP_ONLY was written to prevent. MApp.Handoff is that
  // screen, and these tests are what stop it drifting from the map.
  describe('the handoff screen', () => {
    test('is present, with its catalogue markers intact', () => {
      expect(HANDOFF_CATALOGUE).not.toBeNull();
      expect(RAW_MOBILE_SRC).toContain('MApp.Handoff');
      expect(handoffMethods().length).toBeGreaterThan(0);
    });

    test('accounts for every desktop-only method', () => {
      const unexplained = Object.keys(DESKTOP_ONLY).filter(
        m => !handoffMethods().includes(m)
      );

      expect(unexplained).toEqual([]);
    });

    test('explains nothing that is not desktop-only', () => {
      // The other direction: an entry left behind after a capability was
      // ported would send someone to desktop for something the phone now
      // does. Stale in exactly the way the ratchet exists to catch.
      const orphaned = handoffMethods().filter(m => !(m in DESKTOP_ONLY));

      expect(orphaned).toEqual([]);
    });

    test('is reachable from the More tab', () => {
      // A screen nothing opens is not a handoff. The entry point lives in
      // the More tab's Desktop group.
      const views = fs.readFileSync(
        path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', 'mobile_views.html'),
        'utf8'
      );

      expect(views).toContain('MApp.Handoff.open()');
      expect(views).toContain('id="sheet-desktop-only"');
      expect(views).toContain('id="desktop-only-list"');
    });
  });
});
