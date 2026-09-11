/**
 * "Go to" — the modules you actually use, one tap from Home.
 *
 * Five tabs hold Home, Stock, Production and Dispatch. The other twenty
 * destinations -- both ledgers, the whole directory, the master screens --
 * live behind More, which means More, then the right disclosure group, then
 * the row. Three taps and a scan for a screen someone may open forty times
 * a day, and the tab bar cannot grow: five is the limit at which targets
 * stay thumb-sized on a 360px phone.
 *
 * So the order is learned rather than authored. These pin the two things
 * that make that safe: the ranking actually responds to use, and every
 * registered destination really opens something -- a typo in an opener
 * makes a module unreachable from the one surface that now launches it,
 * since the More tab's rows were rewired through here.
 */

'use strict';

const fs = require('fs');
const path = require('path');

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
  document.body.innerHTML = `
    <div class="mapp-section-label">Go to</div>
    <div class="mb-quick-actions" id="home-shortcuts"></div>`;
  try { localStorage.clear(); } catch (e) { /* ignore */ }
  loadAsGlobal('api.js', 'Api');
  loadAsGlobal('mobile.js', 'MApp');
}

const labels = () =>
  [...document.querySelectorAll('#home-shortcuts .mapp-shortcut')].map(b => b.textContent.trim());

describe('the catalogue', () => {
  beforeEach(mount);

  test('every destination has a key, a label and an opener', () => {
    MApp.Shortcuts.DESTINATIONS.forEach(d => {
      expect(typeof d.key).toBe('string');
      expect(d.key.trim()).not.toBe('');
      expect(d.label.trim()).not.toBe('');
      expect(typeof d.open).toBe('function');
    });
  });

  test('keys are unique -- two rows sharing one would share a counter', () => {
    const keys = MApp.Shortcuts.DESTINATIONS.map(d => d.key);
    expect(keys.length).toBe(new Set(keys).size);
  });

  test('every opener names a module and method that exist', () => {
    // The real failure this guards: the More tab's rows were rewired to
    // MApp.Shortcuts.go(), so a bad opener here is a module nothing can
    // reach any more. Calling them for real would open twenty sheets, so
    // the source of each arrow function is checked instead.
    MApp.Shortcuts.DESTINATIONS.forEach(d => {
      const src = d.open.toString();
      const call = src.match(/MApp\.(\w+)\.(\w+)/);
      expect(call).not.toBeNull();
      const [, moduleName, method] = call;
      expect(MApp[moduleName]).toBeDefined();
      expect(typeof MApp[moduleName][method]).toBe('function');
    });
  });

  test('every More-tab destination is registered here', () => {
    // The counter only learns from launches it sees. A row still calling a
    // module directly would never be ranked, so it could never rise to the
    // Home row however often it was used.
    const more = VIEWS_HTML.slice(
      VIEWS_HTML.indexOf('<template id="tpl-more">'),
      VIEWS_HTML.indexOf('</template>', VIEWS_HTML.indexOf('<template id="tpl-more">'))
    );
    const wired = [...more.matchAll(/MApp\.Shortcuts\.go\('(\w+)'\)/g)].map(m => m[1]);

    expect(wired.length).toBeGreaterThan(15);
    wired.forEach(key => expect(MApp.Shortcuts.destination(key)).not.toBeNull());
  });
});

describe('ranking', () => {
  beforeEach(mount);

  test('a fresh install still shows a full row, in catalogue order', () => {
    // An empty row would be a promise the feature does not keep on day one.
    MApp.Shortcuts.render();
    expect(labels()).toHaveLength(MApp.Shortcuts.MAX);
    expect(labels()[0]).toBe(MApp.Shortcuts.DESTINATIONS[0].label);
  });

  test('using a module moves it to the front', () => {
    const last = MApp.Shortcuts.DESTINATIONS[MApp.Shortcuts.DESTINATIONS.length - 1];
    MApp.Shortcuts.DESTINATIONS.forEach(d => { d.open = jest.fn(); });

    MApp.Shortcuts.go(last.key);

    expect(MApp.Shortcuts.top()[0].key).toBe(last.key);
    expect(labels()[0]).toBe(last.label);
  });

  test('the most-used wins, not the most-recent', () => {
    MApp.Shortcuts.DESTINATIONS.forEach(d => { d.open = jest.fn(); });
    const [a, b] = MApp.Shortcuts.DESTINATIONS.slice(-2);

    MApp.Shortcuts.go(a.key);
    MApp.Shortcuts.go(a.key);
    MApp.Shortcuts.go(b.key);

    expect(MApp.Shortcuts.top()[0].key).toBe(a.key);
  });

  test('catalogue order breaks a tie, so the row does not shuffle', () => {
    const order = MApp.Shortcuts.top().map(d => d.key);
    expect(MApp.Shortcuts.top().map(d => d.key)).toEqual(order);
  });

  test('go() opens the destination as well as counting it', () => {
    const dest = MApp.Shortcuts.DESTINATIONS[0];
    dest.open = jest.fn();

    MApp.Shortcuts.go(dest.key);

    expect(dest.open).toHaveBeenCalled();
  });

  test('an unknown key opens nothing rather than throwing', () => {
    expect(() => MApp.Shortcuts.go('no-such-module')).not.toThrow();
  });
});

describe('when storage is unavailable', () => {
  beforeEach(mount);

  test('a corrupt value falls back to the default order', () => {
    localStorage.setItem(MApp.Shortcuts.KEY, 'not json');
    expect(MApp.Shortcuts.top()[0].key).toBe(MApp.Shortcuts.DESTINATIONS[0].key);
  });

  test('an array where an object belongs is ignored', () => {
    // JSON.parse succeeds, so a typeof check alone would let an array
    // through and every lookup on it would read undefined.
    localStorage.setItem(MApp.Shortcuts.KEY, '[1,2,3]');
    expect(MApp.Shortcuts.counts()).toEqual({});
  });

  test('a write that throws does not stop the module opening', () => {
    const dest = MApp.Shortcuts.DESTINATIONS[0];
    dest.open = jest.fn();
    const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    expect(() => MApp.Shortcuts.go(dest.key)).not.toThrow();
    expect(dest.open).toHaveBeenCalled();

    setItem.mockRestore();
  });

  test('rendering with no container is a no-op, not a crash', () => {
    document.body.innerHTML = '';
    expect(() => MApp.Shortcuts.render()).not.toThrow();
  });
});
