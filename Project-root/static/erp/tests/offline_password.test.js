/**
 * App.OfflinePassword + App.Profile.applyPasswordMode (../core.js) -- the
 * offline sign-in banner and the profile modal wording it drives.
 *
 * Run against the real source via the const-rewrite require() technique
 * nav.test.js and outbox_chaos.test.js already use for loading a classic
 * script (no module.exports) into a Jest module scope.
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

/** The page fragments App.OfflinePassword.init() reaches for, and nothing else. */
function buildPage({ hasPassword, userId = '7' }) {
  document.head.innerHTML = `
    <meta name="current-user-id" content="${userId}">
    <meta name="current-user-has-password" content="${hasPassword ? 'yes' : 'no'}">`;
  document.body.innerHTML = `
    <div id="offlinePasswordPrompt" class="alert alert-warning d-none align-items-center gap-3">
      <button type="button" id="offlinePasswordPromptBtn">Set password</button>
      <button type="button" class="btn-close" id="offlinePasswordPromptClose"></button>
    </div>
    <h6 id="myPasswordHeading">Change Password</h6>
    <form id="myPasswordForm">
      <div class="mb-3" id="currentPasswordField">
        <input type="password" name="currentPassword">
      </div>
      <input type="password" name="newPassword">
      <input type="password" name="confirmNewPassword">
      <button type="submit" id="myPasswordSaveBtn">Change Password</button>
    </form>`;
}

const isVisible = (id) => !document.getElementById(id).classList.contains('d-none');

describe('App.OfflinePassword', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    sessionStorage.clear();
    document.documentElement.style.removeProperty('--offline-banner-offset');
    loadCoreAsGlobal();
  });

  test('shows the banner for an account with no password', () => {
    buildPage({ hasPassword: false });
    App.OfflinePassword.init();

    expect(isVisible('offlinePasswordPrompt')).toBe(true);
    expect(document.getElementById('offlinePasswordPrompt').classList.contains('d-flex')).toBe(true);
  });

  test('leaves the banner hidden for an account that already has one', () => {
    buildPage({ hasPassword: true });
    App.OfflinePassword.init();

    expect(isVisible('offlinePasswordPrompt')).toBe(false);
  });

  test('a missing meta is treated as "has a password"', () => {
    buildPage({ hasPassword: false });
    document.querySelector('meta[name="current-user-has-password"]').remove();
    App.OfflinePassword.init();

    expect(isVisible('offlinePasswordPrompt')).toBe(false);
    expect(App.OfflinePassword.hasPassword).toBe(true);
  });

  test('the close button dismisses the banner and it stays dismissed on the next load', () => {
    buildPage({ hasPassword: false });
    App.OfflinePassword.init();

    document.getElementById('offlinePasswordPromptClose').click();
    expect(isVisible('offlinePasswordPrompt')).toBe(false);

    // Same session, same user, fresh page load.
    buildPage({ hasPassword: false });
    App.OfflinePassword.init();
    expect(isVisible('offlinePasswordPrompt')).toBe(false);
  });

  test('one user dismissing it does not suppress it for another on the same terminal', () => {
    buildPage({ hasPassword: false, userId: '7' });
    App.OfflinePassword.init();
    document.getElementById('offlinePasswordPromptClose').click();

    buildPage({ hasPassword: false, userId: '8' });
    App.OfflinePassword.init();
    expect(isVisible('offlinePasswordPrompt')).toBe(true);
  });

  test('dismissing never hides the Current Password field fix', () => {
    // The dismissal must not take the modal's "set" mode down with it --
    // otherwise closing the banner would put back the field the user has
    // nothing to type into.
    buildPage({ hasPassword: false });
    App.OfflinePassword.init();
    document.getElementById('offlinePasswordPromptClose').click();

    buildPage({ hasPassword: false });
    App.OfflinePassword.init();
    expect(isVisible('currentPasswordField')).toBe(false);
  });

  test('showing the banner pushes the sticky header down by its height', () => {
    // The banner is pinned (styles.css #offlinePasswordPrompt: position
    // sticky) because it sits above .app-header in the document and the app
    // scrolls itself down on load to the restored tab -- which used to carry
    // the banner off the top of the screen on every single load. Pinning it
    // means .app-header has to start below it, and --offline-banner-offset
    // is the only thing that knows how tall it is. jsdom reports 0-height
    // boxes, so this asserts the contract (the variable is published, and
    // returns to 0px when hidden), not the pixel value.
    buildPage({ hasPassword: false });
    jest.spyOn(Element.prototype, 'getBoundingClientRect')
      .mockReturnValue({ height: 75, width: 1436, top: 0, left: 0, bottom: 75, right: 1436 });

    App.OfflinePassword.init();
    expect(document.documentElement.style.getPropertyValue('--offline-banner-offset')).toBe('75px');

    App.OfflinePassword.hidePrompt();
    expect(document.documentElement.style.getPropertyValue('--offline-banner-offset')).toBe('0px');

    jest.restoreAllMocks();
  });

  test('an account that has a password never displaces the header', () => {
    buildPage({ hasPassword: true });
    App.OfflinePassword.init();

    // Never set at all, so .app-header keeps its own `top: 0` fallback --
    // the overwhelmingly common case must not move a single pixel.
    expect(document.documentElement.style.getPropertyValue('--offline-banner-offset')).toBe('');
  });

  test('unreachable sessionStorage leaves the banner showing rather than throwing', () => {
    const spy = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });

    buildPage({ hasPassword: false });
    expect(() => App.OfflinePassword.init()).not.toThrow();
    expect(isVisible('offlinePasswordPrompt')).toBe(true);

    expect(() => document.getElementById('offlinePasswordPromptClose').click()).not.toThrow();
    expect(isVisible('offlinePasswordPrompt')).toBe(false);

    spy.mockRestore();
    jest.restoreAllMocks();
  });
});

describe('App.Profile.applyPasswordMode', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    sessionStorage.clear();
    loadCoreAsGlobal();
  });

  test('an account with no password is never asked for its current one', () => {
    buildPage({ hasPassword: false });
    App.OfflinePassword.init();

    expect(isVisible('currentPasswordField')).toBe(false);
    expect(document.getElementById('myPasswordHeading').textContent).toBe('Set a Password');
    expect(document.getElementById('myPasswordSaveBtn').textContent).toBe('Set Password');
  });

  test('an account that has one still is', () => {
    buildPage({ hasPassword: true });
    App.OfflinePassword.init();

    expect(isVisible('currentPasswordField')).toBe(true);
    expect(document.getElementById('myPasswordHeading').textContent).toBe('Change Password');
    expect(document.getElementById('myPasswordSaveBtn').textContent).toBe('Change Password');
  });

  test('a value typed before the mode switched is not left in the hidden field', () => {
    buildPage({ hasPassword: true });
    App.OfflinePassword.init();
    document.querySelector('[name="currentPassword"]').value = 'typed-then-hidden';

    App.Profile.applyPasswordMode(false);
    expect(document.querySelector('[name="currentPassword"]').value).toBe('');
  });

  test('setting the first password brings the field and the change wording back', () => {
    buildPage({ hasPassword: false });
    App.OfflinePassword.init();
    expect(isVisible('currentPasswordField')).toBe(false);

    App.OfflinePassword.onPasswordSet();

    expect(isVisible('offlinePasswordPrompt')).toBe(false);
    expect(App.OfflinePassword.hasPassword).toBe(true);
    expect(isVisible('currentPasswordField')).toBe(true);
    expect(document.getElementById('myPasswordSaveBtn').textContent).toBe('Change Password');
  });
});
