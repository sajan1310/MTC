/**
 * Regression test for App.Notify (../core.js) -- the notification bell +
 * history panel backing showToast's persisted history. Run against the
 * real source (not a reimplementation) via a require() of the actual
 * file, same const-rewrite technique outbox_chaos.test.js established for
 * loading a classic script (no module.exports) into a Jest module scope.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function loadCoreAsGlobal() {
  const code = fs
    .readFileSync(path.join(__dirname, '..', 'core.js'), 'utf8')
    .replace(/^const App = /m, 'global.App = ');
  // eslint-disable-next-line no-eval
  eval(code);
}

const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function buildBellMarkup() {
  document.body.innerHTML = `
    <div class="notif-wrap">
      <button id="notif-bell-btn" type="button" aria-expanded="false">
        <span id="notif-badge" style="display:none;">0</span>
      </button>
      <div id="notif-panel" style="display:none;">
        <button type="button" id="notif-clear-btn"></button>
        <div id="notif-list"></div>
      </div>
    </div>`;
}

describe('App.Notify', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    // escapeHtml lives in api.js, a separate script -- stub the real
    // implementation here rather than a jest.fn(), so render() assertions
    // exercise real escaping behavior.
    global.escapeHtml = value => String(value).replace(/[&<>"']/g, ch => HTML_ESCAPE_MAP[ch]);
    loadCoreAsGlobal();
    buildBellMarkup();
  });

  test('add() pushes a notification and increments the unread badge', () => {
    App.Notify.add('PO #1001 created successfully.');

    expect(App.Notify.items).toHaveLength(1);
    expect(App.Notify.items[0].message).toBe('PO #1001 created successfully.');
    expect(App.Notify.items[0].isError).toBe(false);
    expect(App.Notify.unreadCount).toBe(1);

    const badge = document.getElementById('notif-badge');
    expect(badge.textContent).toBe('1');
    expect(badge.style.display).toBe('inline-flex');
  });

  test('add() with isError=true is flagged as an error notification', () => {
    App.Notify.add('Failed to save PO.', true);
    expect(App.Notify.items[0].isError).toBe(true);
  });

  test('badge shows 99+ once unread count exceeds 99', () => {
    for (let i = 0; i < 100; i++) App.Notify.add(`msg ${i}`);
    expect(document.getElementById('notif-badge').textContent).toBe('99+');
  });

  test('a blank message is a no-op', () => {
    App.Notify.add('');
    App.Notify.add(null);
    expect(App.Notify.items).toHaveLength(0);
    expect(App.Notify.unreadCount).toBe(0);
  });

  test('history is capped at 50 entries, newest first', () => {
    for (let i = 0; i < 55; i++) App.Notify.add(`msg ${i}`);
    expect(App.Notify.items).toHaveLength(50);
    // unshift() means the most recently added is at index 0.
    expect(App.Notify.items[0].message).toBe('msg 54');
  });

  test('save()/load() round-trips through localStorage', () => {
    App.Notify.add('Bill #INV-1 recorded successfully.');
    App.Notify.add('Warning: overage detected.', true);

    // Simulate a fresh page load: a brand-new Notify state re-reading
    // whatever the previous instance persisted.
    App.Notify.items = [];
    App.Notify.unreadCount = 0;
    App.Notify.load();

    expect(App.Notify.items).toHaveLength(2);
    expect(App.Notify.unreadCount).toBe(2);
    expect(App.Notify.items[0].timestamp).toBeInstanceOf(Date);
  });

  test('open() reveals the panel, clears unread state, and re-renders', () => {
    App.Notify.add('Item saved.');
    App.Notify.open();

    expect(document.getElementById('notif-panel').style.display).toBe('flex');
    expect(document.getElementById('notif-bell-btn').getAttribute('aria-expanded')).toBe('true');
    expect(App.Notify.unreadCount).toBe(0);
    expect(document.getElementById('notif-badge').style.display).toBe('none');
    expect(App.Notify.items[0].unread).toBe(false);

    // render() painted the message into #notif-list.
    expect(document.getElementById('notif-list').textContent).toContain('Item saved.');
  });

  test('render() escapes HTML in the message (XSS safety)', () => {
    App.Notify.add('<img src=x onerror=alert(1)>');
    App.Notify.open();

    const listHtml = document.getElementById('notif-list').innerHTML;
    expect(listHtml).not.toContain('<img src=x');
    expect(listHtml).toContain('&lt;img src=x');
  });

  test('close() hides the panel', () => {
    App.Notify.open();
    App.Notify.close();

    expect(document.getElementById('notif-panel').style.display).toBe('none');
    expect(document.getElementById('notif-bell-btn').getAttribute('aria-expanded')).toBe('false');
    expect(App.Notify.isOpen).toBe(false);
  });

  test('toggle() flips between open and closed', () => {
    expect(App.Notify.isOpen).toBe(false);
    App.Notify.toggle();
    expect(App.Notify.isOpen).toBe(true);
    App.Notify.toggle();
    expect(App.Notify.isOpen).toBe(false);
  });

  test('remove() deletes one item and decrements unread count if it was unread', () => {
    App.Notify.add('first');
    App.Notify.add('second');
    expect(App.Notify.unreadCount).toBe(2);

    const targetId = App.Notify.items[0].id;
    App.Notify.remove(targetId);

    expect(App.Notify.items).toHaveLength(1);
    expect(App.Notify.items[0].message).toBe('first');
    expect(App.Notify.unreadCount).toBe(1);
  });

  test('clear() empties the list and resets the badge', () => {
    App.Notify.add('one');
    App.Notify.add('two');
    App.Notify.clear();

    expect(App.Notify.items).toHaveLength(0);
    expect(App.Notify.unreadCount).toBe(0);
    expect(document.getElementById('notif-badge').style.display).toBe('none');
    expect(document.getElementById('notif-list').textContent).toContain('No notifications yet.');
  });

  test('formatTime renders relative labels for recent timestamps', () => {
    expect(App.Notify.formatTime(new Date())).toBe('Just now');
    expect(App.Notify.formatTime(new Date(Date.now() - 90 * 1000))).toBe('1m ago');
    expect(App.Notify.formatTime(new Date(Date.now() - 3 * 3600 * 1000))).toBe('3h ago');
  });

  // Regression test: App.Utils.showToast used to silently drop its `link`
  // argument (App.Notify.add(message, isError) -- no third arg), so every
  // domain's save-toast passed a {type, value} link that never reached the
  // stored notification. Clicking the resulting bell entry could therefore
  // never navigate anywhere even though NAV had a resolver registered for
  // it -- only App.Notify.add()'s own direct callers (smart alerts) worked.
  test('showToast forwards its `link` argument through to App.Notify.add', () => {
    App.Utils.showToast('PO #1001 saved.', false, { type: 'po', value: '1001' });

    expect(App.Notify.items).toHaveLength(1);
    expect(App.Notify.items[0].link).toEqual({ type: 'po', value: '1001' });
  });

  test('showToast with no link stores a null link (falls back to detail modal)', () => {
    App.Utils.showToast('Something happened.');
    expect(App.Notify.items[0].link).toBeNull();
  });
});
