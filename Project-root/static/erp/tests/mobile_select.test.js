/**
 * MApp.Select -- long-press multi-select and bulk delete (Phase 2, F2).
 *
 * This is the only feature in the app that destroys more than one record
 * at a time, on a device used with gloves, so most of what follows is
 * about failing in the safe direction rather than about selecting things.
 *
 * The interlock in enable() is the important one: if the number of
 * rendered row elements does not exactly match the number of rows it was
 * handed, index N in the DOM is no longer index N in the data, and a bulk
 * delete would act on records the operator never chose. It refuses to arm
 * instead of guessing.
 *
 * Every payload shape asserted here was read off the server function it
 * calls and cross-checked against what that screen's SINGLE delete
 * already sends.
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

const MOBILE_JS = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');

const CONFIG = {
  key: 'test', noun: 'lot', plural: 'lots',
  method: 'deleteProductionBulk',
  payload: rows => [rows.map(r => r.rowIdx)],
  onDone: jest.fn(),
};
const ROWS = [{ rowIdx: 11 }, { rowIdx: 22 }, { rowIdx: 33 }];

function paint(n = ROWS.length) {
  document.getElementById('list').innerHTML =
    Array.from({ length: n }, (_, i) => `<div class="mb-card">row ${i}</div>`).join('');
  return [...document.querySelectorAll('#list .mb-card')];
}

const press = (node, ms) => {
  node.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  jest.advanceTimersByTime(ms);
};

describe('MApp.Select', () => {
  let listEl;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    global.fetch = jest.fn();
    document.body.innerHTML = `
      <div id="list"></div>
      <div class="mb-select-bar" id="mapp-select-bar">
        <span id="mapp-select-count"></span>
      </div>`;
    loadAsGlobal('api.js', 'Api');
    loadAsGlobal('mobile.js', 'MApp');
    MApp.Select._state = null;
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: true }));
    window.confirm = jest.fn(() => true);
    listEl = document.getElementById('list');
    CONFIG.onDone.mockClear();
  });

  afterEach(() => jest.useRealTimers());

  const bar = () => document.getElementById('mapp-select-bar');
  const count = () => document.getElementById('mapp-select-count').textContent;

  test('a tap does not start selection -- only a deliberate long press does', () => {
    const nodes = paint();
    MApp.Select.enable(listEl, ROWS, CONFIG);

    press(nodes[0], 200);
    expect(MApp.Select.isActive('test')).toBe(false);

    press(nodes[0], MApp.Select.LONG_PRESS_MS);
    expect(MApp.Select.isActive('test')).toBe(true);
  });

  test('the long-pressed row starts selected, and the bar names the count', () => {
    const nodes = paint();
    MApp.Select.enable(listEl, ROWS, CONFIG);
    press(nodes[1], MApp.Select.LONG_PRESS_MS);

    expect(nodes[1].classList.contains('mb-selected')).toBe(true);
    expect(count()).toBe('1 lot selected');
    expect(bar().classList.contains('open')).toBe(true);
  });

  test('taps toggle once selection is active, and the noun pluralises', () => {
    const nodes = paint();
    MApp.Select.enable(listEl, ROWS, CONFIG);
    press(nodes[0], MApp.Select.LONG_PRESS_MS);

    nodes[2].dispatchEvent(new window.Event('click', { bubbles: true }));
    expect(count()).toBe('2 lots selected');

    nodes[2].dispatchEvent(new window.Event('click', { bubbles: true }));
    expect(count()).toBe('1 lot selected');
  });

  test('deselecting the last row leaves selection mode', () => {
    // Otherwise the bar sits there offering to delete nothing.
    const nodes = paint();
    MApp.Select.enable(listEl, ROWS, CONFIG);
    press(nodes[0], MApp.Select.LONG_PRESS_MS);

    nodes[0].dispatchEvent(new window.Event('click', { bubbles: true }));

    expect(MApp.Select.isActive('test')).toBe(false);
    expect(bar().classList.contains('open')).toBe(false);
  });

  test('a tap while selecting does not also fire the row\'s own action', () => {
    // Cards carry Edit / Delete / Print buttons. While selecting, a tap
    // means "toggle this row" and must not open an edit sheet as well.
    const nodes = paint();
    const rowAction = jest.fn();
    nodes[0].addEventListener('click', rowAction);
    MApp.Select.enable(listEl, ROWS, CONFIG);
    press(nodes[1], MApp.Select.LONG_PRESS_MS);

    nodes[0].dispatchEvent(new window.Event('click', { bubbles: true }));

    expect(rowAction).not.toHaveBeenCalled();
  });

  describe('the interlock', () => {
    test('refuses to arm when the DOM and the data disagree', () => {
      // A banner matching the row selector, or a template edit that adds a
      // card, breaks the index mapping. Arming anyway would delete records
      // the operator never chose.
      const nodes = paint(4); // four elements, three rows
      MApp.Select.enable(listEl, ROWS, CONFIG);

      press(nodes[0], MApp.Select.LONG_PRESS_MS);

      expect(MApp.Select.isActive('test')).toBe(false);
    });

    test('a mismatched re-render also drops any live selection', () => {
      const nodes = paint();
      MApp.Select.enable(listEl, ROWS, CONFIG);
      press(nodes[0], MApp.Select.LONG_PRESS_MS);
      expect(MApp.Select.isActive('test')).toBe(true);

      paint(4);
      MApp.Select.enable(listEl, ROWS, CONFIG);

      expect(MApp.Select.isActive('test')).toBe(false);
    });

    test('an ordinary re-render clears the selection too', () => {
      // Rows may have been filtered, paged or reloaded underneath it, so a
      // row selected before the render is not necessarily the row at that
      // index after it.
      const nodes = paint();
      MApp.Select.enable(listEl, ROWS, CONFIG);
      press(nodes[0], MApp.Select.LONG_PRESS_MS);

      MApp.Select.enable(listEl, ROWS, CONFIG);

      expect(MApp.Select.isActive('test')).toBe(false);
    });
  });

  describe('bulk delete', () => {
    test('confirms with the count and the noun, not a bare "are you sure"', async () => {
      const nodes = paint();
      MApp.Select.enable(listEl, ROWS, CONFIG);
      press(nodes[0], MApp.Select.LONG_PRESS_MS);
      nodes[2].dispatchEvent(new window.Event('click', { bubbles: true }));

      await MApp.Select.deleteSelected();

      expect(window.confirm).toHaveBeenCalledWith("Delete 2 lots? This can't be undone.");
    });

    test('declining the confirm deletes nothing and keeps the selection', async () => {
      window.confirm = jest.fn(() => false);
      const nodes = paint();
      MApp.Select.enable(listEl, ROWS, CONFIG);
      press(nodes[0], MApp.Select.LONG_PRESS_MS);

      await MApp.Select.deleteSelected();

      expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();
      expect(MApp.Select.isActive('test')).toBe(true);
    });

    test('sends only the selected rows, in list order', async () => {
      const nodes = paint();
      MApp.Select.enable(listEl, ROWS, CONFIG);
      press(nodes[2], MApp.Select.LONG_PRESS_MS);
      nodes[0].dispatchEvent(new window.Event('click', { bubbles: true }));

      await MApp.Select.deleteSelected();

      expect(MApp.Util.mutateSimple).toHaveBeenCalledWith(
        'deleteProductionBulk', [[11, 33]], '2 lots deleted.'
      );
    });

    test('reloads the list afterwards', async () => {
      const nodes = paint();
      MApp.Select.enable(listEl, ROWS, CONFIG);
      press(nodes[0], MApp.Select.LONG_PRESS_MS);

      await MApp.Select.deleteSelected();

      expect(CONFIG.onDone).toHaveBeenCalled();
      expect(MApp.Select.isActive('test')).toBe(false);
    });

    test('does nothing when nothing is selected', async () => {
      await MApp.Select.deleteSelected();
      expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();
    });
  });
});

describe('every wired list sends the payload its RPC actually expects', () => {
  // Read straight out of mobile.js so a config edited to the wrong shape
  // fails here rather than on the shop floor.
  const config = key => {
    const m = MOBILE_JS.match(new RegExp(`key: '${key}',[\\s\\S]{0,400}?onDone`));
    return m ? m[0] : '';
  };

  test.each([
    // [key, RPC, the payload expression its server signature requires]
    ['production', 'deleteProductionBulk', 'rows.map(r => r.rowIdx)'],
    ['dispatch', 'deleteDispatchBulk', 'new Set(rows.map(r => r.dispatchNumber))'],
    ['po', 'deletePOsBulk', 'rows.map(r => r.poNumber)'],
    ['bill', 'deleteBillsBulk', 'rows.map(r => ({ vendor: r.vendor, billNumber: r.billNumber }))'],
    ['issue', 'deleteIssueBulk', 'rows.map(r => r.issueId)'],
    ['wastage', 'deleteWastageBulk', 'rows.map(r => r.wastageId)'],
    ['items', 'deleteItemsBulk', 'rows.map(r => ({ name: r.name, size: r.size || \'\' }))'],
    ['process', 'deleteProcessesBulk', 'rows.map(r => r.processId)'],
    ['bom', 'deleteBOMsBulk', 'rows.map(r => r.productId), MApp.BOM.token'],
  ])('%s -> %s', (key, method, payload) => {
    const block = config(key);
    expect(block).toContain(`method: '${method}'`);
    expect(block).toContain(payload);
  });

  test('dispatch de-duplicates, because its rows are one-per-line', () => {
    // getDispatchData is flattened, so several cards share a
    // dispatchNumber; deleteDispatchBulk deletes whole dispatches.
    expect(config('dispatch')).toContain('new Set(');
  });

  test('BOM carries its unlock token, like every other BOM write', () => {
    expect(config('bom')).toContain('MApp.BOM.token');
  });

  test('every wired list both declares a config and arms it', () => {
    const declared = [...MOBILE_JS.matchAll(/^  SELECT: \{/gm)].length;
    const armed = [...MOBILE_JS.matchAll(/MApp\.Select\.enable\(/g)].length;
    expect(declared).toBe(9); // Directory builds its config per type, so it is not a SELECT literal
    expect(armed).toBe(10);
  });
});
