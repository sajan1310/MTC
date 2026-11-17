/**
 * The screen the app opens on appears whole; a screen switched to fades in.
 *
 * Every screen used to fade in, the first one included. A fade's first frame
 * is drawn at opacity 0, and the browser does not count that -- or the rest
 * of the fade -- as the screen appearing: the greeting on a phone's Home was
 * on screen at about a second and counted as the page's Largest Contentful
 * Paint only when something repainted it, at 2.2-2.4 s (lab, 2026-11-15).
 * Replaying the fade also forces a layout, which start-up can do without.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function loadAsGlobal(relPath, exportName) {
  const code = fs
    .readFileSync(path.join(__dirname, '..', relPath), 'utf8')
    .replace(new RegExp(`^const ${exportName} = `, 'm'), `global.${exportName} = `);
  eval(code);
}

beforeEach(() => {
  jest.resetModules();
  global.fetch = jest.fn();
  history.replaceState(null, '', '/erp/mobile');
  localStorage.clear();
  document.body.innerHTML = `
    <header class="mapp-topbar"><div id="mapp-topbar-title"></div></header>
    <main id="mapp-content"></main>
    <nav>
      <div id="mapp-tab-indicator"></div>
      <button id="mapp-tab-home" role="tab"></button>
      <button id="mapp-tab-stock" role="tab"></button>
    </nav>
    <template id="tpl-home"><h1 id="home-greeting">Today</h1></template>
    <template id="tpl-stock"><div id="stock-list"></div></template>`;
  loadAsGlobal('api.js', 'Api');
  loadAsGlobal('mobile.js', 'MApp');
  MApp.Home.mount = jest.fn();
  MApp.Stock.mount = jest.fn();
});

afterEach(() => { delete global.fetch; });

const fading = () => document.getElementById('mapp-content').classList.contains('mapp-screen-enter');

test('the screen the app opens on does not fade in', () => {
  MApp.Shell.showTab('home', { replace: true });

  expect(document.getElementById('home-greeting')).not.toBeNull();
  expect(fading()).toBe(false);
  expect(MApp.Home.mount).toHaveBeenCalledTimes(1);
});

test('whichever screen that is', () => {
  MApp.Shell.showTab('stock', { replace: true });

  expect(document.getElementById('stock-list')).not.toBeNull();
  expect(fading()).toBe(false);
});

test('a screen switched to fades in, as before', () => {
  MApp.Shell.showTab('home', { replace: true });
  MApp.Shell.showTab('stock');

  expect(fading()).toBe(true);
  expect(MApp.Stock.mount).toHaveBeenCalledTimes(1);
});

test('so does the opening screen when it is come back to', () => {
  MApp.Shell.showTab('home', { replace: true });
  MApp.Shell.showTab('stock');
  MApp.Shell.showTab('home');

  expect(fading()).toBe(true);
});

test('start-up forces no layout to replay a fade it is not showing', () => {
  const content = document.getElementById('mapp-content');
  const asked = jest.fn(() => 390);
  Object.defineProperty(content, 'offsetWidth', { configurable: true, get: asked });

  MApp.Shell.showTab('home', { replace: true });
  expect(asked).not.toHaveBeenCalled();

  MApp.Shell.showTab('stock');
  expect(asked).toHaveBeenCalledTimes(1);
});
