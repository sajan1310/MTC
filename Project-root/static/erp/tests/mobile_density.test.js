/**
 * List layout — Comfortable / Compact / Grid.
 *
 * One card per row at full size is the right default and, on a stock list
 * of a thousand-odd item/size rows, a lot of scrolling. The two
 * alternatives are not different screens, only different amounts of the
 * same screen at once.
 *
 * The assertion this file exists for is the last one: nothing about a
 * density mode changes what a card CONTAINS. A layout control that also
 * hid fields would be a different feature wearing this one's name, and
 * the field you cannot see is always the one you needed.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'mobile_styles.css'), 'utf8');
const SHELL_HTML = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'mobile.html'), 'utf8'
);
const VIEWS_HTML = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', 'mobile_views.html'), 'utf8'
);

function loadAsGlobal(relPath, exportName) {
  const code = fs
    .readFileSync(path.join(__dirname, '..', relPath), 'utf8')
    .replace(new RegExp(`^const ${exportName} = `, 'm'), `global.${exportName} = `);
  // eslint-disable-next-line no-eval
  eval(code);
}

function mount() {
  jest.resetModules();
  global.fetch = jest.fn();
  document.documentElement.removeAttribute('data-density');
  document.body.innerHTML = `
    <button id="mapp-density-btn"></button>
    <div class="mb-sheet" id="mapp-picker-sheet">
      <h2 id="mapp-picker-title"></h2>
      <div id="mapp-picker-search-wrap"><input id="mapp-picker-search"></div>
      <div id="mapp-picker-list"></div>
    </div>
    <div id="mapp-sheet-backdrop"></div>`;
  try { localStorage.clear(); } catch (e) { /* ignore */ }
  loadAsGlobal('api.js', 'Api');
  loadAsGlobal('mobile.js', 'MApp');
  MApp.Sheet._stack = [];
  Element.prototype.scrollIntoView = jest.fn();
}

const attr = () => document.documentElement.getAttribute('data-density');
const btn = () => document.getElementById('mapp-density-btn');
const pick = label => {
  const b = [...document.querySelectorAll('#mapp-picker-list .mb-picker-option')]
    .find(x => x.textContent.trim().startsWith(label));
  b.click();
};

describe('choosing a layout', () => {
  beforeEach(mount);

  test('Comfortable is the default and stamps no attribute', () => {
    expect(MApp.Density.read()).toBe('comfortable');
    MApp.Density.init();
    expect(attr()).toBeNull();
  });

  test('the other two stamp the root and persist', () => {
    MApp.Density.set('compact');
    expect(attr()).toBe('compact');
    expect(localStorage.getItem(MApp.Density.KEY)).toBe('compact');

    MApp.Density.set('grid');
    expect(attr()).toBe('grid');
  });

  test('going back to Comfortable clears the attribute', () => {
    MApp.Density.set('grid');
    MApp.Density.set('comfortable');

    expect(attr()).toBeNull();
  });

  test('the choice survives a reload', () => {
    MApp.Density.set('grid');
    document.documentElement.removeAttribute('data-density');

    MApp.Density.init();

    expect(attr()).toBe('grid');
  });

  test('a junk stored value falls back to Comfortable', () => {
    localStorage.setItem(MApp.Density.KEY, 'mosaic');
    expect(MApp.Density.read()).toBe('comfortable');
  });

  test('an unknown mode is refused rather than stamped', () => {
    MApp.Density.set('mosaic');
    expect(attr()).toBeNull();
  });

  test('storage being unavailable does not stop the layout applying', () => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error('denied'); };

    expect(() => MApp.Density.set('compact')).not.toThrow();
    expect(attr()).toBe('compact');

    Storage.prototype.setItem = real;
  });
});

describe('the control', () => {
  beforeEach(mount);

  test('lives in the top bar, where the too-long list is', async () => {
    expect(SHELL_HTML).toContain('id="mapp-density-btn"');
    expect(SHELL_HTML).toContain('MApp.Density.choose()');
  });

  test('the picker offers all three, each saying what it does', async () => {
    MApp.Density.init();

    const done = MApp.Density.choose();
    await Promise.resolve();
    const rows = [...document.querySelectorAll('#mapp-picker-list .mb-picker-option')]
      .map(b => b.textContent.trim());
    pick('Grid');
    await done;

    expect(rows.length).toBe(3);
    expect(rows[0]).toContain('One card per row');
    expect(rows[1]).toContain('more rows per screen');
    expect(attr()).toBe('grid');
  });

  test('dismissing the picker changes nothing', async () => {
    MApp.Density.set('compact');

    const done = MApp.Density.choose();
    await Promise.resolve();
    MApp.Picker.cancel();
    await done;

    expect(attr()).toBe('compact');
  });

  test('the icon shows the mode in force, not a generic gear', () => {
    // Otherwise the control says "a setting lives here" and nothing about
    // which one is on.
    MApp.Density.set('comfortable');
    const comfortable = btn().innerHTML;
    MApp.Density.set('compact');
    const compact = btn().innerHTML;
    MApp.Density.set('grid');
    const grid = btn().innerHTML;

    expect(new Set([comfortable, compact, grid]).size).toBe(3);
    expect(btn().getAttribute('aria-label')).toBe('List layout: Grid');
  });

  test('a missing button is survivable', () => {
    // The top bar is not present in every mounted context.
    btn().remove();
    expect(() => MApp.Density.set('grid')).not.toThrow();
  });
});

describe('what the modes actually do', () => {
  test('compact only tightens spacing and type', () => {
    const rules = CSS.match(/:root\[data-density="compact"\][^{]*\{[^}]*\}/g) || [];
    expect(rules.length).toBeGreaterThan(0);
    rules.forEach(r => {
      expect(r).not.toMatch(/display:\s*none/);
      expect(r).not.toMatch(/visibility:\s*hidden/);
    });
  });

  test('grid is auto-fill, so it falls back to one column when narrow', () => {
    // A fixed two-column count would crush the cards on a small phone
    // rather than giving up and stacking.
    expect(CSS).toMatch(/:root\[data-density="grid"\] \.mb-list \{[^}]*repeat\(auto-fill/);
  });

  test('neither mode hides a field', () => {
    // The whole point: these are amounts of the same screen, not
    // different screens.
    const all = CSS.match(/:root\[data-density="[a-z]+"\][^{]*\{[^}]*\}/g) || [];
    expect(all.length).toBeGreaterThan(0);
    all.forEach(r => expect(r).not.toMatch(/display:\s*none|visibility:\s*hidden|content-visibility/));
  });

  test('non-record children span the full row in grid', () => {
    // A banner, "Show 50 more", an empty state or a Stock card's expanded
    // panel becoming a sibling tile would each be its own bug.
    ['.mb-offline-banner', '.mb-load-more', '.mb-state', '[id^="stock-expand-"]'].forEach(sel => {
      expect(CSS).toContain(`:root[data-density="grid"] .mb-list > ${sel}`);
    });
    expect(CSS).toMatch(/grid-column: 1 \/ -1/);
  });
});

describe('which lists opt in', () => {
  const tagged = [...VIEWS_HTML.matchAll(/<div class="mb-list" id="([\w-]+)"/g)].map(m => m[1]);

  test('every tab list and every register is covered', () => {
    ['stock-list', 'production-list', 'dispatch-list', 'pool-list', 'po-ledger-list',
      'bill-ledger-list', 'master-list', 'directory-list', 'client-orders-list',
      'items-lookup-list'].forEach(id => expect(tagged).toContain(id));
  });

  test('the picker\'s own option list is NOT a card list', () => {
    // It is the one [id$="-list"] that must never become a grid -- which
    // is exactly why this opts in by class rather than by id suffix.
    expect(tagged).not.toContain('mapp-picker-list');
    expect(VIEWS_HTML).not.toContain('<div class="mb-list" id="mapp-picker-list"');
  });

  test('the reconciliation screens stay out of it', () => {
    // Neither holds a uniform run of .mb-card.
    expect(tagged).not.toContain('bill-stock-conflict-list');
    expect(tagged).not.toContain('sync-issues-list');
  });
});
