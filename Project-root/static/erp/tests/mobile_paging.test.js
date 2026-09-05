/**
 * MApp.Paging -- progressive reveal, replacing thirteen hard caps
 * (Phase 2, F2).
 *
 * Every list rendered `rows.slice(0, N)` with no way to reach row N+1.
 * Production and Dispatch cap at 50, so a lot logged three weeks ago was
 * not merely hard to find, it was unreachable: no scroll, no page, no
 * filter got to it. Phase 2's first half made the cap visible; this makes
 * it passable.
 *
 * The last block is a migration guard over the real mobile.js. The two
 * bugs it encodes both actually happened during this migration: a
 * `.slice(0, N)` left behind is a cap that silently survives, and a
 * setCount landing in the wrong render reports one screen's numbers on
 * another's.
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
const rows = n => Array.from({ length: n }, (_, i) => ({ id: i }));

describe('MApp.Paging', () => {
  beforeEach(() => {
    jest.resetModules();
    global.fetch = jest.fn();
    document.body.innerHTML = '<div id="list"></div>';
    loadAsGlobal('api.js', 'Api');
    loadAsGlobal('mobile.js', 'MApp');
    MApp.Paging._shown = {};
    MApp.Paging._rerender = {};
  });

  test('shows the first page and reports what is held back', () => {
    const page = MApp.Paging.take('k', rows(312));

    expect(page.rows).toHaveLength(50);
    expect(page.shown).toBe(50);
    expect(page.total).toBe(312);
    expect(page.hasMore).toBe(true);
  });

  test('a list shorter than one page has no more to show', () => {
    const page = MApp.Paging.take('k', rows(12));

    expect(page.rows).toHaveLength(12);
    expect(page.hasMore).toBe(false);
    expect(MApp.Paging.moreHtml(page)).toBe('');
  });

  test('the button says how many come next and how many remain', () => {
    const html = MApp.Paging.moreHtml(MApp.Paging.take('k', rows(312)));

    expect(html).toContain('Show 50 more');
    expect(html).toContain('262 not shown');
  });

  test('the last page offers only what is left, not a full step', () => {
    MApp.Paging.reset('k');
    MApp.Paging._shown.k = 300;
    const html = MApp.Paging.moreHtml(MApp.Paging.take('k', rows(312)));

    expect(html).toContain('Show 12 more');
    expect(html).toContain('12 not shown');
  });

  test('tapping Show more expands the page and re-renders', () => {
    const render = jest.fn();
    const page = MApp.Paging.take('k', rows(312), render);
    document.getElementById('list').innerHTML = MApp.Paging.moreHtml(page);

    document.querySelector('.mb-load-more').click();

    expect(render).toHaveBeenCalledTimes(1);
    expect(MApp.Paging.take('k', rows(312)).rows).toHaveLength(100);
  });

  test('the click handler is delegated, so it survives an innerHTML rebuild', () => {
    // Per-button listeners are dropped every time a render reassigns
    // innerHTML -- which is exactly what Show-more triggers. The second
    // tap is the one that would fail.
    const list = document.getElementById('list');
    const render = jest.fn(() => {
      list.innerHTML = MApp.Paging.moreHtml(MApp.Paging.take('k', rows(312), render));
    });
    render();

    list.querySelector('.mb-load-more').click();
    list.querySelector('.mb-load-more').click();

    expect(MApp.Paging.take('k', rows(312)).shown).toBe(150);
  });

  test('reset returns to the first page, so a new query does not inherit an expanded one', () => {
    MApp.Paging.take('k', rows(312));
    MApp.Paging._shown.k = 200;

    MApp.Paging.reset('k');

    expect(MApp.Paging.take('k', rows(312)).rows).toHaveLength(50);
  });

  test('each list pages independently', () => {
    MApp.Paging.take('a', rows(312));
    MApp.Paging.take('b', rows(312));
    MApp.Paging._shown.a = 150;

    expect(MApp.Paging.take('a', rows(312)).shown).toBe(150);
    expect(MApp.Paging.take('b', rows(312)).shown).toBe(50);
  });

  test('empty and missing inputs are survivable', () => {
    expect(MApp.Paging.take('k', []).rows).toEqual([]);
    expect(MApp.Paging.take('k', null).total).toBe(0);
    expect(MApp.Paging.moreHtml(null)).toBe('');
  });
});

describe('every list is paged, and reports its own numbers', () => {
  const KEYS = ['production', 'dispatch', 'po', 'bill', 'issue', 'wastage',
    'items', 'directory', 'admin', 'process', 'bom'];

  test('no hard cap survives anywhere', () => {
    // `.slice(0, 50)` / `.slice(0, 100)` / `.slice(0, 200)` on a render is
    // the shape this whole module exists to remove.
    const survivors = MOBILE_JS.split(/\r?\n/)
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => /\.slice\(0,\s*(50|100|200)\)/.test(line));

    expect(survivors.map(s => `${s.n}: ${s.line}`)).toEqual([]);
  });

  test.each(KEYS)('%s takes a page and offers the rest', key => {
    expect(MOBILE_JS).toContain(`MApp.Paging.take('${key}'`);
    expect(MOBILE_JS).toContain(`MApp.Paging.reset('${key}')`);
  });

  test('every take() is followed by its own moreHtml before the next take', () => {
    // Guards the failure where a screen slices to a page and then never
    // renders the button, leaving the remaining rows unreachable again.
    const lines = MOBILE_JS.split(/\r?\n/);
    const takes = [];
    lines.forEach((l, i) => { if (/MApp\.Paging\.take\('/.test(l) && !l.trim().startsWith('//')) takes.push(i); });

    expect(takes.length).toBe(KEYS.length);

    takes.forEach((start, idx) => {
      const end = idx + 1 < takes.length ? takes[idx + 1] : lines.length;
      const between = lines.slice(start, end).join('\n');
      expect(between).toContain('MApp.Paging.moreHtml(page)');
    });
  });

  test('each setCount sits in the render of the list it names', () => {
    // Both previous scripted passes put two screens' count lines into one
    // render, which reports the wrong totals on the other screen. Anchor
    // each setCount to the nearest preceding take() and check they agree.
    const lines = MOBILE_JS.split(/\r?\n/);
    const KEY_FOR_INPUT = {
      'production-search': 'production', 'dispatch-search': 'dispatch',
      'po-ledger-search': 'po', 'bill-ledger-search': 'bill',
      'issue-log-search': 'issue', 'wastage-log-search': 'wastage',
      'items-lookup-search': 'items', 'directory-search': 'directory',
      'admin-users-search': 'admin', 'process-list-search': 'process',
      'bom-list-search': 'bom',
    };

    const mismatches = [];
    lines.forEach((line, i) => {
      const m = line.match(/MApp\.SearchBox\.setCount\('([a-z-]+)'/);
      if (!m || !KEY_FOR_INPUT[m[1]]) return;
      let takeKey = null;
      for (let j = i; j >= 0 && j > i - 40; j--) {
        const t = lines[j].match(/MApp\.Paging\.take\('([a-z]+)'/);
        if (t && !lines[j].trim().startsWith('//')) { takeKey = t[1]; break; }
      }
      if (takeKey !== KEY_FOR_INPUT[m[1]]) {
        mismatches.push(`${i + 1}: setCount('${m[1]}') sits under take('${takeKey}')`);
      }
    });

    expect(mismatches).toEqual([]);
  });
});
