/**
 * "Only on desktop" — the handoff screen (Phase 7).
 *
 * The parity ratchet has always held two maps: BACKLOG, which is now
 * empty, and DESKTOP_ONLY, the capabilities kept on desktop on purpose
 * because a bulk import or a several-hundred-row reconciliation is worse
 * on a phone. Each DESKTOP_ONLY entry has always been required to name
 * "the MApp screen that must exist for it" -- and the test checked only
 * that the label was a non-empty string. It could not tell a built screen
 * from a string, and for most of this program there was no screen: a
 * phone user who went looking for one of these capabilities met nothing.
 * Silence is the exact degradation the map was written to prevent.
 *
 * mobile_parity.test.js now enforces the catalogue against DESKTOP_ONLY
 * in both directions. This file tests the screen itself: that it renders,
 * that it says where to go, and that it lands there.
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

/** The real sheet markup, so the test cannot pass against a fixture the
 *  template does not actually contain. */
function sheetMarkup() {
  const at = VIEWS_HTML.indexOf('id="sheet-desktop-only"');
  const open = VIEWS_HTML.lastIndexOf('<div', at);
  const end = VIEWS_HTML.indexOf('<!--', at);
  return VIEWS_HTML.slice(open, end === -1 ? undefined : end);
}

function mount() {
  jest.resetModules();
  global.fetch = jest.fn();
  document.body.innerHTML = `
    <div id="mapp-sheet-backdrop"></div>
    ${sheetMarkup()}
    <div class="mb-toast-stack" id="mapp-toast-stack"></div>`;
  loadAsGlobal('api.js', 'Api');
  loadAsGlobal('mobile.js', 'MApp');
  MApp.Sheet._stack = [];
}

const cards = () => [...document.querySelectorAll('#desktop-only-list .mb-card')];
const links = () => [...document.querySelectorAll('#desktop-only-list a')];

describe('the catalogue', () => {
  beforeEach(mount);

  test('every entry says what it is and why it is not here', () => {
    // A handoff that only says "not available on mobile" is a dead end.
    // Each entry has to carry the capability, and the reason -- except
    // the one deliberate non-handoff (see below).
    MApp.Handoff.CAPABILITIES.forEach(c => {
      expect(c.title.trim()).not.toBe('');
      expect(c.body.trim()).not.toBe('');
      expect(Array.isArray(c.methods)).toBe(true);
      expect(c.methods.length).toBeGreaterThan(0);
    });
  });

  test('no method is claimed by two entries', () => {
    const all = MApp.Handoff.CAPABILITIES.flatMap(c => c.methods);
    expect(all.length).toBe(new Set(all).size);
  });

  test('every destination is a real desktop tab, or the shell itself', () => {
    // core.js's Navigation.isValidTab rejects a hash with no btn-<id>, so
    // a typo here would land on the dashboard and look like a bad link.
    const REAL_TABS = [
      'itemMaster', 'vendorMaster', 'stockTab', 'productsTab',
      'productionTab', 'poLedger', 'billLedger', 'returnLedger',
      'contractorsTab', 'dispatchTab', 'clientsTab', 'usersTab',
      'activityTab', 'dashboardTab'
    ];
    MApp.Handoff.CAPABILITIES.forEach(c => {
      if (c.tab) expect(REAL_TABS).toContain(c.tab);
    });
  });
});

describe('the screen', () => {
  beforeEach(mount);

  test('opening it renders one card per capability', () => {
    MApp.Handoff.open();

    expect(cards()).toHaveLength(MApp.Handoff.CAPABILITIES.length);
    expect(document.getElementById('sheet-desktop-only').classList.contains('open')).toBe(true);
  });

  test('each card names the desktop screen to go to', () => {
    MApp.Handoff.open();

    const text = document.getElementById('desktop-only-list').textContent;
    expect(text).toContain('Items Master → Sync Review');
    expect(text).toContain('Products & Processes');
    expect(text).toContain('Top bar, beside the company name');
  });

  test('a link lands on that screen, not on the dashboard', () => {
    MApp.Handoff.open();

    const hrefs = links().map(a => a.getAttribute('href'));
    expect(hrefs).toContain('/erp#itemMaster');
    expect(hrefs).toContain('/erp#stockTab');
    expect(hrefs).toContain('/erp#vendorMaster');
    // The logo lives in the top bar, which no hash selects.
    expect(hrefs).toContain('/erp');
  });

  test('links break out of the app shell', () => {
    // An installed PWA runs in its own window; rendering the desktop UI
    // inside it would trap the user in a shell built for a phone.
    MApp.Handoff.open();

    links().forEach(a => expect(a.getAttribute('target')).toBe('_top'));
  });

  test('the one entry with nowhere to go offers no link', () => {
    // getNextProductId is listed because the DIFFERENCE is visible --
    // desktop shows a "next ID" and this app shows none -- not because
    // there is somewhere to send you. Desktop's preview is wrong (opening
    // the form burns the sequence value the recipe then does not get), so
    // sending someone to it would be sending them to a number that lies.
    MApp.Handoff.open();

    const card = cards().find(c => c.textContent.includes('Next recipe ID'));
    expect(card).toBeDefined();
    expect(card.querySelector('a')).toBeNull();
    expect(card.textContent).toContain('never the number assigned');
  });

  test('rendering escapes its own copy', () => {
    MApp.Handoff.CAPABILITIES.push({
      title: '<img src=x onerror=alert(1)>', body: 'b', where: '', tab: '', why: '',
      methods: ['x']
    });
    MApp.Handoff.open();

    expect(document.querySelector('#desktop-only-list img')).toBeNull();
  });

  test('every class it renders is one the stylesheet defines', () => {
    // Caught a real one: the cards were written with mb-mt-1, which does
    // not exist (the scale is mt-2 / mt-4). A missing utility class is
    // invisible in jsdom and silently unstyled on a phone.
    const CSS = fs.readFileSync(path.join(__dirname, '..', 'mobile_styles.css'), 'utf8');
    MApp.Handoff.open();

    const used = new Set();
    document.querySelectorAll('#desktop-only-list *').forEach(el => {
      el.classList.forEach(c => used.add(c));
    });

    const undefined_ = [...used].filter(c => !CSS.includes(`.${c}`));
    expect(undefined_).toEqual([]);
  });

  test('closing it leaves the sheet shut', () => {
    MApp.Handoff.open();
    MApp.Handoff.close();

    expect(document.getElementById('sheet-desktop-only').classList.contains('open')).toBe(false);
  });

  test('renders nothing rather than throwing if the sheet is absent', () => {
    document.body.innerHTML = '<div id="mapp-sheet-backdrop"></div>';
    expect(() => MApp.Handoff.render()).not.toThrow();
  });
});
