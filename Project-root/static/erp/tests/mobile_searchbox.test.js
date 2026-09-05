/**
 * MApp.SearchBox -- the one search input (Phase 2, F3).
 *
 * Every .mb-search input was type="text" with an inline
 * oninput="MApp.X.onSearch(this.value)": no clear button, a return key
 * labelled "return", iOS capitalising every query, and a full list rebuild
 * on each keystroke. MApp.Util.debounce() existed at the top of mobile.js
 * and was called from nowhere in the file.
 *
 * The last two tests are the migration guard: they read the real
 * mobile.js and mobile_views.html and fail if a screen is left half-wired,
 * which is the failure mode that would otherwise ship a dead search box.
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
const VIEWS = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', 'mobile_views.html'), 'utf8'
);

describe('MApp.SearchBox', () => {
  let onQuery;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    global.fetch = jest.fn();
    document.body.innerHTML = `
      <div class="mb-search">
        <svg></svg>
        <input type="search" id="test-search" placeholder="Search…">
      </div>
      <div id="test-list"></div>`;
    loadAsGlobal('api.js', 'Api');
    loadAsGlobal('mobile.js', 'MApp');
    MApp.SearchBox._handlers = {};
    onQuery = jest.fn();
  });

  afterEach(() => jest.useRealTimers());

  const input = () => document.getElementById('test-search');
  const type = value => {
    input().value = value;
    input().dispatchEvent(new window.Event('input'));
  };

  test('applies the mobile keyboard hints the templates cannot express alone', () => {
    MApp.SearchBox.attach('test-search', onQuery);
    const el = input();

    expect(el.getAttribute('type')).toBe('search');
    expect(el.getAttribute('enterkeyhint')).toBe('search');
    // Without this iOS capitalises the first letter of every item code.
    expect(el.getAttribute('autocapitalize')).toBe('none');
    expect(el.getAttribute('autocorrect')).toBe('off');
    expect(el.getAttribute('spellcheck')).toBe('false');
  });

  test('debounces typing instead of filtering on every keystroke', () => {
    MApp.SearchBox.attach('test-search', onQuery);

    type('r');
    type('ri');
    type('rim');
    expect(onQuery).not.toHaveBeenCalled();

    jest.advanceTimersByTime(MApp.SearchBox.DEBOUNCE_MS);

    expect(onQuery).toHaveBeenCalledTimes(1);
    expect(onQuery).toHaveBeenCalledWith('rim');
  });

  test('Enter applies immediately rather than waiting out the debounce', () => {
    MApp.SearchBox.attach('test-search', onQuery);
    input().value = 'rim';

    input().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(onQuery).toHaveBeenCalledWith('rim');
  });

  test('the clear button appears only when there is something to clear', () => {
    MApp.SearchBox.attach('test-search', onQuery);
    const clear = document.querySelector('.mb-search-clear');

    expect(clear).not.toBeNull();
    expect(clear.hidden).toBe(true);

    type('rim');
    expect(clear.hidden).toBe(false);
  });

  test('clearing empties the field and fires immediately', () => {
    MApp.SearchBox.attach('test-search', onQuery);
    type('rim');
    jest.advanceTimersByTime(MApp.SearchBox.DEBOUNCE_MS);
    onQuery.mockClear();

    document.querySelector('.mb-search-clear').click();

    // No timer advance: clearing is not typing, and making the operator
    // wait 120ms to see the full list back reads as lag.
    expect(onQuery).toHaveBeenCalledWith('');
    expect(input().value).toBe('');
  });

  test('re-attaching does not stack listeners', () => {
    // Sheets live permanently in the DOM and their open() runs again on
    // every visit, so attach() has to be idempotent or a query fires N
    // times after N visits.
    MApp.SearchBox.attach('test-search', onQuery);
    MApp.SearchBox.attach('test-search', onQuery);
    MApp.SearchBox.attach('test-search', onQuery);

    type('rim');
    jest.advanceTimersByTime(MApp.SearchBox.DEBOUNCE_MS);

    expect(onQuery).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('.mb-search-clear')).toHaveLength(1);
    expect(document.querySelectorAll('.mb-search-count')).toHaveLength(1);
  });

  test('a missing input is survivable', () => {
    expect(MApp.SearchBox.attach('nope', onQuery)).toBeNull();
  });

  describe('the result count', () => {
    beforeEach(() => MApp.SearchBox.attach('test-search', onQuery));
    const count = () => document.querySelector('.mb-search-count');

    test('announces a truncated list, which is how the silent caps become visible', () => {
      MApp.SearchBox.setCount('test-search', 50, 312);

      expect(count().hidden).toBe(false);
      // No "refine your search" advice any more: MApp.Paging puts a
      // Show-more button under the list, so the remaining rows are
      // reachable rather than something to word a better query for.
      expect(count().textContent).toBe('Showing 50 of 312');
      // A live region: the only way a screen-reader user learns the list
      // changed under a search that never moves focus.
      expect(count().getAttribute('role')).toBe('status');
      expect(count().getAttribute('aria-live')).toBe('polite');
    });

    test('reports match counts while searching', () => {
      input().value = 'rim';

      MApp.SearchBox.setCount('test-search', 3, 3);
      expect(count().textContent).toBe('3 matches');

      MApp.SearchBox.setCount('test-search', 1, 1);
      expect(count().textContent).toBe('1 match');
    });

    test('stays quiet on a complete, unsearched list', () => {
      input().value = '';
      MApp.SearchBox.setCount('test-search', 12, 12);
      expect(count().hidden).toBe(true);
    });

    test('says so when results are approximate', () => {
      // The safety half of fuzzy matching. Without this the operator has
      // no way to tell that what they are reading is a guess rather than
      // a record that actually matches what they typed.
      input().value = 'kalpli';
      MApp.SearchBox.setCount('test-search', 2, 2, { fuzzy: true, unknownFields: [] });

      expect(count().hidden).toBe(false);
      expect(count().textContent).toContain('No exact matches');
      expect(count().classList.contains('mb-search-count-note')).toBe(true);
    });

    test('says so when a field qualifier was ignored', () => {
      input().value = 'supplier:acme';
      MApp.SearchBox.setCount('test-search', 3, 3, { fuzzy: false, unknownFields: ['supplier'] });

      expect(count().textContent).toContain("supplier isn't a field");
      expect(count().classList.contains('mb-search-count-note')).toBe(true);
    });

    test('an approximate note shows even on an unsearched-looking count', () => {
      // Fuzzy with a complete result set would otherwise fall into the
      // "stay quiet" branch and hide the warning.
      input().value = 'kalpli';
      MApp.SearchBox.setCount('test-search', 2, 2, { fuzzy: true, unknownFields: [] });
      expect(count().hidden).toBe(false);
    });

    test('drops the note styling once results are exact again', () => {
      input().value = 'kalpli';
      MApp.SearchBox.setCount('test-search', 2, 2, { fuzzy: true, unknownFields: [] });
      MApp.SearchBox.setCount('test-search', 2, 2, { fuzzy: false, unknownFields: [] });

      expect(count().classList.contains('mb-search-count-note')).toBe(false);
      expect(count().textContent).not.toContain('No exact matches');
    });
  });
});

describe('search migration is complete across every screen', () => {
  // Ids of every search INPUT in the mobile templates. Matched off the
  // <input> tag itself, not on any id containing "search" -- the picker's
  // wrapper div is #mapp-picker-search-wrap and is not a search box.
  const ids = [...VIEWS.matchAll(/<input[^>]*\bid="([a-z-]*-search|mapp-picker-search)"/g)].map(m => m[1]);

  test('the templates still declare every search box', () => {
    expect(ids.length).toBeGreaterThanOrEqual(13);
  });

  test.each(ids)('%s is type=search and has no inline oninput', id => {
    const tag = VIEWS.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`));
    expect(tag).not.toBeNull();
    expect(tag[0]).toContain('type="search"');
    // An inline handler would bypass the debounce and the clear button.
    expect(tag[0]).not.toContain('oninput');
  });

  test.each(ids)('%s is wired to MApp.SearchBox.attach', id => {
    // Removing the inline oninput without attaching leaves a dead search
    // box that looks perfectly functional -- exactly the regression this
    // migration could have shipped.
    expect(MOBILE_JS).toContain(`MApp.SearchBox.attach('${id}'`);
  });

  test('no hand-rolled substring filter survives', () => {
    // The old shape was `.toLowerCase().includes(term)` inside a filter.
    // Every one of those is now MApp.Search.run.
    const survivors = MOBILE_JS.split(/\r?\n/)
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => /\.toLowerCase\(\)\.includes\((term|lower|this\.searchTerm)\)/.test(line));

    expect(survivors.map(s => `${s.n}: ${s.line}`)).toEqual([]);
  });
});
