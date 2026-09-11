/**
 * Collapsible sections on the More tab.
 *
 * Twelve sections and about forty destinations, which as a flat scroll
 * meant hunting. Each is a <details>, so the tab opens as an index.
 *
 * The disclosure itself is the browser's -- deliberately, so the
 * keyboard handling, the aria-expanded semantics and the open/closed
 * state are the platform's rather than a reimplementation, and the
 * sections still open if the script never runs. MApp.MoreGroups adds
 * only the remembering, which matters more than it sounds: the More tab
 * is re-cloned from its template on every visit, so without it every
 * section would snap shut the moment you came back from the screen you
 * just opened.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'mobile_styles.css'), 'utf8');
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

/** The More template, with Jinja stripped, mounted live. */
function moreTemplate() {
  const at = VIEWS_HTML.indexOf('<template id="tpl-more">');
  const end = VIEWS_HTML.indexOf('</template>', at);
  return VIEWS_HTML.slice(VIEWS_HTML.indexOf('>', at) + 1, end)
    .replace(/\{%[^%]*%\}/g, '')
    .replace(/\{\{[^}]*\}\}/g, 'x');
}

function mount() {
  jest.resetModules();
  global.fetch = jest.fn();
  document.body.innerHTML = `<main id="mapp-content">${moreTemplate()}</main>`;
  try { localStorage.clear(); } catch (e) { /* ignore */ }
  loadAsGlobal('api.js', 'Api');
  loadAsGlobal('mobile.js', 'MApp');
}

const groups = () => [...document.querySelectorAll('.mapp-group[data-group]')];
const group = key => document.querySelector(`.mapp-group[data-group="${key}"]`);
const openKeys = () => groups().filter(g => g.open).map(g => g.dataset.group);

describe('the sections', () => {
  beforeEach(mount);

  test('every heading is a native summary, not a div with a click handler', () => {
    // The platform gives keyboard operation and the expanded state for
    // free, and it keeps working if the script does not.
    expect(groups().length).toBeGreaterThan(8);
    groups().forEach(g => {
      expect(g.tagName).toBe('DETAILS');
      expect(g.querySelector(':scope > summary')).not.toBeNull();
    });
  });

  test('each section has a stable key to be remembered by', () => {
    const keys = groups().map(g => g.dataset.group);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('master');
    expect(keys).toContain('ledgers');
  });

  test('the default is collapsed, except the one holding the exit', () => {
    // Sign Out is what somebody arrives at this tab already knowing they
    // want; putting it behind a disclosure would be hiding the exit.
    expect(openKeys()).toEqual(['account']);
  });

  test('no destination was lost in the regrouping', () => {
    // These rows now launch through MApp.Shortcuts.go(), which counts the
    // use so Home's "Go to" row can rank by it -- the destination is the
    // same, the call site is one level of indirection deeper. Asserted by
    // key here; that each key resolves to a real module and method is
    // mobile_shortcuts.test.js's job.
    const html = document.getElementById('mapp-content').innerHTML;
    ['syncIssues', 'status', 'colors', 'stockGroups', 'pool', 'issued',
      'wastage', 'poLedger', 'billLedger', 'clientOrders', 'itemsLookup',
      'vendors', 'processes', 'recipes']
      .forEach(key => expect(html).toContain(`MApp.Shortcuts.go('${key}')`));

    // Still called directly: Account is not a module you "go to" often
    // enough to rank, and New Return is an action rather than a
    // destination -- ranking it alongside ledgers would be a category
    // error.
    ['MApp.Account.open()', 'MApp.Returns.openNewReturnSheet()']
      .forEach(call => expect(html).toContain(call));
  });

  test('the elements other modules write into are still there', () => {
    // They are inside closed sections now, which keeps them in the DOM --
    // but a rename during the regrouping would break them silently.
    ['sync-issues-summary', 'more-returns-list', 'more-desktop-link',
      'more-account-name', 'more-account-email', 'more-about-line',
      'theme-hint'].forEach(id => {
      expect(document.getElementById(id)).not.toBeNull();
    });
  });

  test('System Status got a heading of its own', () => {
    // It used to sit loose under Returns, which is not what it is.
    expect(group('system')).not.toBeNull();
    expect(group('system').textContent).toContain('System Status');
  });
});

describe('remembering what was open', () => {
  beforeEach(mount);

  test('opening a section is stored', () => {
    MApp.MoreGroups.mount();

    group('master').open = true;
    group('master').dispatchEvent(new window.Event('toggle'));

    expect(JSON.parse(localStorage.getItem(MApp.MoreGroups.KEY)).master).toBe(true);
  });

  test('and restored on the next visit, when the template is re-cloned', () => {
    // Without this the section would snap shut every time you came back
    // from the screen you just opened from it.
    MApp.MoreGroups.mount();
    group('logs').open = true;
    group('logs').dispatchEvent(new window.Event('toggle'));

    mountAgainKeepingStorage();

    expect(openKeys()).toContain('logs');

    function mountAgainKeepingStorage() {
      document.body.innerHTML = `<main id="mapp-content">${moreTemplate()}</main>`;
      MApp.MoreGroups.mount();
    }
  });

  test('closing one is remembered too, including the one open by default', () => {
    MApp.MoreGroups.mount();
    group('account').open = false;
    group('account').dispatchEvent(new window.Event('toggle'));

    document.body.innerHTML = `<main id="mapp-content">${moreTemplate()}</main>`;
    MApp.MoreGroups.mount();

    expect(openKeys()).not.toContain('account');
  });

  test('a section never touched keeps the markup\'s own default', () => {
    localStorage.setItem(MApp.MoreGroups.KEY, JSON.stringify({ logs: true }));
    MApp.MoreGroups.mount();

    expect(openKeys().sort()).toEqual(['account', 'logs']);
  });

  test('junk in the key is ignored rather than thrown', () => {
    localStorage.setItem(MApp.MoreGroups.KEY, 'not json at all');

    expect(() => MApp.MoreGroups.mount()).not.toThrow();
    expect(openKeys()).toEqual(['account']);
  });

  test('a stored value of the wrong shape is ignored', () => {
    localStorage.setItem(MApp.MoreGroups.KEY, '"a string"');
    expect(MApp.MoreGroups.read()).toEqual({});
  });

  test('storage being unavailable does not stop the sections working', () => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error('denied'); };
    MApp.MoreGroups.mount();

    expect(() => {
      group('master').open = true;
      group('master').dispatchEvent(new window.Event('toggle'));
    }).not.toThrow();

    Storage.prototype.setItem = real;
  });
});

describe('expand and collapse all', () => {
  beforeEach(mount);

  test('expand all opens every section and remembers it', () => {
    MApp.MoreGroups.mount();

    MApp.MoreGroups.setAll(true);

    expect(openKeys().length).toBe(groups().length);
    const stored = JSON.parse(localStorage.getItem(MApp.MoreGroups.KEY));
    expect(Object.values(stored).every(Boolean)).toBe(true);
  });

  test('collapse all closes every section, the default-open one included', () => {
    MApp.MoreGroups.mount();

    MApp.MoreGroups.setAll(false);

    expect(openKeys()).toEqual([]);
  });

  test('both controls are wired in the markup', () => {
    expect(VIEWS_HTML).toContain('MApp.MoreGroups.setAll(true)');
    expect(VIEWS_HTML).toContain('MApp.MoreGroups.setAll(false)');
  });
});

describe('the chevron', () => {
  test('the browser\'s own marker is suppressed in both engines', () => {
    // Otherwise a default triangle sits beside our chevron -- Safari
    // ignores list-style on a summary and needs the pseudo-element.
    expect(CSS).toMatch(/\.mapp-group-summary \{[^}]*list-style: none/);
    expect(CSS).toContain('.mapp-group-summary::-webkit-details-marker { display: none; }');
  });

  test('it turns when the section opens', () => {
    expect(CSS).toContain('.mapp-group[open] > .mapp-group-summary .mapp-group-chevron');
  });

  test('the heading is a full-width tap target', () => {
    expect(CSS).toMatch(/\.mapp-group-summary \{[^}]*min-height: var\(--mb-tap-min\)/);
  });
});
