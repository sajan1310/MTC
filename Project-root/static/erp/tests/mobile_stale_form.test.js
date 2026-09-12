/**
 * A form that is overtaken while it loads must not be repainted by the
 * load it no longer belongs to.
 *
 * Every one of these forms opens, awaits its reference data, then paints.
 * Tap Edit on one lot and Edit on another before the first load lands, and
 * the first response repaints the form the second one is now showing: the
 * markup on screen is lot A's, `this.editingLot` is lot B, and saving
 * writes A's numbers onto B. Nothing looks wrong at any point.
 *
 * MApp.Bill had solved this for itself with a private _formSeq counter.
 * MApp.Util.openGuard is that idiom once, for every form that needs it,
 * and this file is what stops a new form being written without it.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function loadAsGlobal(relPath, exportName) {
  const code = fs
    .readFileSync(path.join(__dirname, '..', relPath), 'utf8')
    .replace(new RegExp(`^const ${exportName} = `, 'm'), `global.${exportName} = `);
  // eslint-disable-next-line no-eval
  eval(code);
}

const MOBILE_SRC = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');

beforeEach(() => {
  jest.resetModules();
  global.fetch = jest.fn();
  document.body.innerHTML = '';
  loadAsGlobal('api.js', 'Api');
  loadAsGlobal('print-templates.js', 'PrintTemplates');
  loadAsGlobal('mobile.js', 'MApp');
});

describe('MApp.Util.openGuard', () => {
  test('the first open is not stale while it is the only one', () => {
    const owner = {};
    const stale = MApp.Util.openGuard(owner);
    expect(stale()).toBe(false);
  });

  test('a second open makes the first stale, and itself current', () => {
    const owner = {};
    const first = MApp.Util.openGuard(owner);
    const second = MApp.Util.openGuard(owner);

    expect(first()).toBe(true);   // overtaken -- must not paint
    expect(second()).toBe(false); // the one the user is looking at
  });

  test('two different sheets do not cancel each other', () => {
    // Each owner counts separately, or opening a picker over a form would
    // read as the form being overtaken.
    const form = {};
    const picker = {};
    const formGuard = MApp.Util.openGuard(form);
    MApp.Util.openGuard(picker);

    expect(formGuard()).toBe(false);
  });

  test('it survives an owner that has never been guarded before', () => {
    expect(() => MApp.Util.openGuard(undefined)).not.toThrow();
  });

  test('the slow response loses to the fast one, whichever resolves first', async () => {
    // The real shape: two opens in flight, the FIRST one resolving last.
    const owner = {};
    const order = [];

    const open = (label, delay) => {
      const stale = MApp.Util.openGuard(owner);
      return new Promise(resolve => setTimeout(resolve, delay)).then(() => {
        if (stale()) return;
        order.push(label);
      });
    };

    await Promise.all([open('first', 20), open('second', 0)]);

    // Only the second painted, even though the first answered later.
    expect(order).toEqual(['second']);
  });
});

describe('every form that awaits before painting is guarded', () => {
  // Scanned from source rather than exercised one by one: the point is
  // that NO form opener is missing the guard, which a per-form test can
  // only say about the forms somebody remembered to write a test for.
  const FORM_OPENERS = [
    'openLogLotSheet',
    'openNewDispatchSheet',
    'openNewReturnSheet',
    'openNewSheet',
    'openEditSheet',
    'openForm'
  ];

  function bodyOf(name, from = 0) {
    const header = MOBILE_SRC.indexOf(`  async ${name}(`, from);
    if (header === -1) return null;
    const end = MOBILE_SRC.indexOf('\n  },', header);
    return { text: MOBILE_SRC.slice(header, end), next: end };
  }

  test.each(FORM_OPENERS)('%s paints only for the open it belongs to', name => {
    let from = 0;
    let found = 0;
    for (;;) {
      const body = bodyOf(name, from);
      if (!body) break;
      from = body.next + 1;
      // Only forms that actually await can be overtaken.
      if (!body.text.includes('await ')) continue;
      found += 1;
      const guarded = body.text.includes('openGuard') // the shared helper
        || body.text.includes('_formSeq');            // Bill's own, predating it
      expect(guarded).toBe(true);
    }
    expect(found).toBeGreaterThan(0);
  });

  test('the guard is checked, not just taken', () => {
    // Declaring it and never calling it would pass the scan above while
    // fixing nothing.
    const declarations = (MOBILE_SRC.match(/MApp\.Util\.openGuard\(this\)/g) || []).length;
    const checks = (MOBILE_SRC.match(/if \(stale\(\)\) return;/g) || []).length;

    expect(declarations).toBeGreaterThan(0);
    expect(checks).toBeGreaterThanOrEqual(declarations);
  });
});
