/**
 * System / Light / Dark, chosen in the More tab.
 *
 * The app followed prefers-color-scheme and nothing else -- the right
 * default and the wrong only option. A phone here walks from a dark shed
 * into full glare faster than any OS schedule accounts for.
 *
 * Two things in this file are guards rather than behaviour tests, and
 * both exist because the implementation duplicates something on purpose:
 * the dark palette is declared twice (a media context and an attribute
 * selector, which CSS gives no way to share), and the storage key is
 * written twice (once inline in <head> to beat the first paint, once in
 * MApp.Theme). Duplication that is checked is a tradeoff; duplication
 * that is trusted is a bug waiting for a rename.
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

/** Every `--token: value;` inside one brace-balanced block, by name. */
function tokensIn(source, selector) {
  const at = source.indexOf(selector);
  if (at === -1) throw new Error(`no block for ${selector}`);
  const open = source.indexOf('{', at);
  let depth = 0, end = open;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = source.slice(open + 1, end);
  const out = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

function mount() {
  jest.resetModules();
  global.fetch = jest.fn();
  document.documentElement.removeAttribute('data-theme');
  document.head.innerHTML = '';
  document.body.innerHTML = `
    <div class="mb-segmented">
      <button data-theme-mode="system" aria-selected="true">System</button>
      <button data-theme-mode="light" aria-selected="false">Light</button>
      <button data-theme-mode="dark" aria-selected="false">Dark</button>
    </div>
    <div id="theme-hint"></div>`;
  try { localStorage.clear(); } catch (e) { /* ignore */ }
  loadAsGlobal('api.js', 'Api');
  loadAsGlobal('mobile.js', 'MApp');
}

const attr = () => document.documentElement.getAttribute('data-theme');
const override = () => document.getElementById('mapp-theme-color-override');
const selected = () => [...document.querySelectorAll('[data-theme-mode]')]
  .filter(b => b.getAttribute('aria-selected') === 'true')
  .map(b => b.dataset.themeMode);

describe('choosing a theme', () => {
  beforeEach(mount);

  test('System is the default and stamps no attribute', () => {
    expect(MApp.Theme.read()).toBe('system');
    MApp.Theme.init();
    expect(attr()).toBeNull();
  });

  test('an explicit choice stamps the root and persists', () => {
    MApp.Theme.set('dark');

    expect(attr()).toBe('dark');
    expect(localStorage.getItem(MApp.Theme.KEY)).toBe('dark');
  });

  test('going back to System removes the attribute again', () => {
    // Not "write light": the media query has to be back in charge, so a
    // phone that flips at dusk still follows without being reopened.
    MApp.Theme.set('dark');
    MApp.Theme.set('system');

    expect(attr()).toBeNull();
    expect(localStorage.getItem(MApp.Theme.KEY)).toBe('system');
  });

  test('the choice survives a reload', () => {
    MApp.Theme.set('light');
    mountAgain();

    function mountAgain() {
      document.documentElement.removeAttribute('data-theme');
      MApp.Theme.init();
    }
    expect(attr()).toBe('light');
  });

  test('a junk stored value falls back to System', () => {
    localStorage.setItem(MApp.Theme.KEY, 'neon');
    expect(MApp.Theme.read()).toBe('system');
  });

  test('an unknown mode is refused rather than stamped', () => {
    MApp.Theme.set('neon');
    expect(attr()).toBeNull();
    expect(localStorage.getItem(MApp.Theme.KEY)).toBe('system');
  });

  test('the picker shows what is actually in force', () => {
    MApp.Theme.set('dark');
    expect(selected()).toEqual(['dark']);

    MApp.Theme.set('system');
    expect(selected()).toEqual(['system']);
  });

  test('the hint says what the choice means, not just its name', () => {
    MApp.Theme.set('system');
    expect(document.getElementById('theme-hint').textContent).toContain('phone’s own');

    MApp.Theme.set('dark');
    expect(document.getElementById('theme-hint').textContent).toContain('whatever the phone is set to');
  });

  test('storage being unavailable does not stop the theme applying', () => {
    // Private mode, or site data blocked. The choice is lost on reload,
    // which is a smaller failure than the app refusing to change.
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error('denied'); };

    expect(() => MApp.Theme.set('dark')).not.toThrow();
    expect(attr()).toBe('dark');

    Storage.prototype.setItem = real;
  });
});

describe('the OS chrome colour follows the choice', () => {
  beforeEach(mount);

  test('an explicit choice adds one unconditional theme-color meta', () => {
    // The pair in the template is keyed on prefers-color-scheme, so a
    // choice that disagrees with the OS would leave the status bar
    // painted for the other palette.
    MApp.Theme.set('dark');

    expect(override()).not.toBeNull();
    expect(override().getAttribute('content')).toBe('#0c1014');
  });

  test('switching rewrites it rather than stacking a second', () => {
    MApp.Theme.set('dark');
    MApp.Theme.set('light');

    expect(document.querySelectorAll('meta[name="theme-color"]').length).toBe(1);
    expect(override().getAttribute('content')).toBe('#14181c');
  });

  test('System removes it, handing the meta pair back the decision', () => {
    MApp.Theme.set('dark');
    MApp.Theme.set('system');

    expect(override()).toBeNull();
  });
});

describe('the duplication is checked, not trusted', () => {
  test('both dark blocks declare exactly the same tokens', () => {
    // CSS has no way to share a declaration block between a media context
    // and a plain one, so the dark palette is written twice. Drifting is
    // the failure this catches: a token fixed in one and not the other.
    const media = tokensIn(CSS, '@media (prefers-color-scheme: dark)');
    const attrBlock = tokensIn(CSS, ':root[data-theme="dark"] {');

    expect(Object.keys(attrBlock).sort()).toEqual(Object.keys(media).sort());
    Object.keys(media).forEach(name => {
      expect(`${name}: ${attrBlock[name]}`).toBe(`${name}: ${media[name]}`);
    });
  });

  test('the media query yields to an explicit light choice', () => {
    // Without the :not(), a phone set to dark would ignore someone
    // choosing Light -- the media block would win on the tokens.
    expect(CSS).toContain(':root:not([data-theme="light"])');
  });

  test('both explicit themes declare color-scheme, so native UI follows', () => {
    // Form controls, scrollbars and the like read this, not the tokens.
    expect(tokensIn(CSS, ':root[data-theme="dark"] {')).toBeTruthy();
    expect(CSS).toMatch(/:root\[data-theme="dark"\] \{[^}]*color-scheme: dark/);
    expect(CSS).toMatch(/:root\[data-theme="light"\] \{[^}]*color-scheme: light/);
  });

  test('the inline head snippet uses the same key as MApp.Theme', () => {
    // Written twice because mobile.js loads at the end of <body> and even
    // its DOMContentLoaded runs after first paint -- an explicit Dark
    // choice would flash white on every launch without the inline copy.
    mount();
    expect(SHELL_HTML).toContain(`localStorage.getItem('${MApp.Theme.KEY}')`);
  });

  test('the inline snippet stamps only the two explicit modes', () => {
    // 'system' must leave the attribute off so the media query applies.
    const at = SHELL_HTML.indexOf('maharaja-erp-mobile-theme');
    const snippet = SHELL_HTML.slice(at - 200, at + 400);
    expect(snippet).toContain("mode === 'dark' || mode === 'light'");
  });

  test('the inline snippet cannot throw the page down', () => {
    // localStorage throws outright in some privacy modes.
    const at = SHELL_HTML.indexOf('maharaja-erp-mobile-theme');
    expect(SHELL_HTML.slice(at - 200, at + 400)).toContain('catch');
  });
});

describe('the control in the More tab', () => {
  test('offers the three modes, System first', () => {
    const at = VIEWS_HTML.indexOf('aria-label="Theme"');
    expect(at).toBeGreaterThan(-1);
    const block = VIEWS_HTML.slice(at, at + 700);
    const modes = [...block.matchAll(/data-theme-mode="(\w+)"/g)].map(m => m[1]);
    expect(modes).toEqual(['system', 'light', 'dark']);
  });

  test('More repaints it on mount, so it opens showing the truth', () => {
    mount();
    const spy = jest.spyOn(MApp.Theme, 'render');
    MApp.More._wireDesktopLink = jest.fn();
    MApp.More.loadAbout = jest.fn();
    MApp.Returns.mount = jest.fn();
    MApp.SyncIssues.updateSummary = jest.fn();

    MApp.More.mount();

    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
