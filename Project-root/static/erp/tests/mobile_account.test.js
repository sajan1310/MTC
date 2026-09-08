/**
 * MApp.Account and the Issued Stock edit path (Phase 4).
 *
 * Both RPCs behind the account screen existed on the server and neither
 * was reachable from the phone: changing your own password on a
 * mobile-first app was impossible.
 *
 * saveIssueStock has accepted `existingIssueId` since it was written --
 * the server could edit an issue record and the screen could not, so
 * correcting a mistyped one meant deleting it and retyping it.
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

const VIEWS = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', 'mobile_views.html'), 'utf8'
);

describe('MApp.Account', () => {
  let sent;

  beforeEach(() => {
    jest.resetModules();
    global.fetch = jest.fn();
    document.body.innerHTML = `
      <div id="mapp-sheet-backdrop"></div>
      <div id="more-account-name">Old Name</div>
      <div id="more-account-email">old@example.com</div>
      <div class="mb-sheet" id="sheet-account">
        <div id="account-profile-body"></div>
        <button id="account-profile-save-btn">Save Profile</button>
        <div id="account-password-body"></div>
        <button id="account-password-save-btn">Change Password</button>
      </div>`;
    window.MOBILE_CURRENT_USER = { email: 'old@example.com', role: 'admin' };
    loadAsGlobal('api.js', 'Api');
    loadAsGlobal('mobile.js', 'MApp');
    MApp.Sheet._stack = [];
    Element.prototype.scrollIntoView = jest.fn();

    sent = [];
    MApp.Util.mutateSimple = jest.fn(async (method, args) => {
      sent.push({ method, args });
      return { success: true };
    });
  });

  const field = (form, key) => document.getElementById(`account-${form}-${key}`);

  test('opens prefilled with the current name and email', () => {
    MApp.Account.open();

    expect(field('profile', 'name').value).toBe('Old Name');
    expect(field('profile', 'email').value).toBe('old@example.com');
    expect(MApp.Sheet._stack.map(e => e.id)).toContain('sheet-account');
  });

  test('the two forms save independently', () => {
    // Desktop splits them for the same reason: a typo in the password
    // fields must not block saving a corrected email.
    MApp.Account.open();
    expect(document.getElementById('account-profile-save-btn')).not.toBeNull();
    expect(document.getElementById('account-password-save-btn')).not.toBeNull();
  });

  describe('profile', () => {
    test('sends name and email as positional arguments', async () => {
      MApp.Account.open();
      field('profile', 'name').value = 'New Name';
      field('profile', 'email').value = 'new@example.com';

      await MApp.Account.saveProfile();

      expect(sent[0].method).toBe('updateMyProfile');
      expect(sent[0].args).toEqual(['New Name', 'new@example.com']);
    });

    test('patches the More tab card rather than leaving a stale name on screen', async () => {
      // That card is rendered from Jinja at page load and never
      // re-fetched, so without this the old name sits there until reload.
      MApp.Account.open();
      field('profile', 'name').value = 'New Name';
      field('profile', 'email').value = 'new@example.com';

      await MApp.Account.saveProfile();

      expect(document.getElementById('more-account-name').textContent).toBe('New Name');
      expect(document.getElementById('more-account-email').textContent).toBe('new@example.com');
      expect(window.MOBILE_CURRENT_USER.email).toBe('new@example.com');
    });

    test('an invalid email is rejected at the field, and nothing is sent', async () => {
      MApp.Account.open();
      field('profile', 'email').value = 'not-an-email';

      await MApp.Account.saveProfile();

      expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();
      expect(field('profile', 'email').getAttribute('aria-invalid')).toBe('true');
    });

    test('a blank name is rejected', async () => {
      MApp.Account.open();
      field('profile', 'name').value = '';

      await MApp.Account.saveProfile();

      expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();
    });
  });

  describe('password', () => {
    const fill = (current, next, confirm) => {
      field('password', 'current').value = current;
      field('password', 'next').value = next;
      field('password', 'confirm').value = confirm;
    };

    test('sends all three values positionally', async () => {
      MApp.Account.open();
      fill('old-secret', 'new-secret', 'new-secret');

      await MApp.Account.savePassword();

      expect(sent[0].method).toBe('changeMyPassword');
      expect(sent[0].args).toEqual(['old-secret', 'new-secret', 'new-secret']);
    });

    test('a mismatch is caught before anything is sent', async () => {
      MApp.Account.open();
      fill('old-secret', 'new-secret', 'different');

      await MApp.Account.savePassword();

      expect(MApp.Util.mutateSimple).not.toHaveBeenCalled();
      expect(document.getElementById('account-password-confirm-error').textContent)
        .toContain('do not match');
    });

    test('the current password is NOT required', async () => {
      // An account created by Google sign-in has no password_hash at all
      // (profile_service.py). Requiring them to prove one they never set
      // would lock them out of ever setting one.
      MApp.Account.open();
      fill('', 'new-secret', 'new-secret');

      await MApp.Account.savePassword();

      expect(sent[0].args).toEqual(['', 'new-secret', 'new-secret']);
    });

    test('the fields are cleared after a successful change', async () => {
      // The sheet stays open for the profile form above, so a typed
      // password must not be left sitting in the DOM.
      MApp.Account.open();
      fill('old-secret', 'new-secret', 'new-secret');

      await MApp.Account.savePassword();

      expect(field('password', 'next').value).toBe('');
      expect(field('password', 'confirm').value).toBe('');
    });

    test('the fields are real password inputs', () => {
      MApp.Account.open();
      ['current', 'next', 'confirm'].forEach(k => {
        expect(field('password', k).getAttribute('type')).toBe('password');
      });
    });
  });

  test('reachable from the More tab and from global search', () => {
    expect(VIEWS).toContain('MApp.Account.open()');
    const dest = MApp.GlobalSearch.DESTINATIONS.find(d => d.label === 'Account');
    expect(dest).toBeDefined();
    expect(dest.keywords).toContain('password');
  });
});

describe('MApp.Issue edit', () => {
  beforeEach(() => {
    jest.resetModules();
    global.fetch = jest.fn();
    document.body.innerHTML = `
      <div id="mapp-sheet-backdrop"></div>
      <div class="mb-sheet" id="sheet-issue-form">
        <h2>Log Issue</h2>
        <div id="issue-form-body"></div>
        <button id="issue-form-save-btn">Log Issue</button>
      </div>`;
    loadAsGlobal('api.js', 'Api');
    loadAsGlobal('mobile.js', 'MApp');
    MApp.Sheet._stack = [];
    MApp.Api.call = jest.fn(async () => ({ success: true, data: [] }));
  });

  const RECORD = {
    issueId: 'ISS-7',
    dateRaw: '2026-08-14T00:00:00',
    issuedTo: 'Rakesh',
    reference: 'LOT-1042',
    remarks: 'partial',
    items: [{ name: 'Rim 26', size: '26 inch', unit: 'Pcs', qty: 12, rate: 40 }],
  };

  test('opening with a record fills the form and relabels the sheet', async () => {
    await MApp.Issue.openForm(RECORD);

    expect(document.querySelector('#sheet-issue-form h2').textContent).toBe('Edit Issue');
    expect(document.getElementById('issue-form-issuedto').value).toBe('Rakesh');
    expect(document.getElementById('issue-form-reference').value).toBe('LOT-1042');
    expect(document.getElementById('issue-form-remarks').value).toBe('partial');
    expect(document.getElementById('issue-form-date').value).toBe('2026-08-14');
    expect(MApp.Issue.lines).toHaveLength(1);
    expect(MApp.Issue.lines[0].name).toBe('Rim 26');
  });

  test('saving an edit sends existingIssueId', async () => {
    let sent = null;
    MApp.Util.mutateSimple = jest.fn(async (method, args) => { sent = args[0]; return { success: false }; });
    await MApp.Issue.openForm(RECORD);

    await MApp.Issue.save();

    expect(sent.existingIssueId).toBe('ISS-7');
    expect(sent.issuedTo).toBe('Rakesh');
  });

  test('opening without a record is still a create, with no id', async () => {
    let sent = null;
    MApp.Util.mutateSimple = jest.fn(async (method, args) => { sent = args[0]; return { success: false }; });
    await MApp.Issue.openForm();
    expect(document.querySelector('#sheet-issue-form h2').textContent).toBe('Log Issue');

    document.getElementById('issue-form-issuedto').value = 'Suresh';
    MApp.Issue.lines = [{ name: 'Spoke', size: '', unit: 'Pcs', qty: 5, rate: 0 }];
    await MApp.Issue.save();

    expect(sent.existingIssueId).toBeUndefined();
  });

  test('a record with quotes in a field cannot break out of the form markup', async () => {
    await MApp.Issue.openForm({ ...RECORD, issuedTo: 'O\'Brien "Sons"', reference: '<script>x</script>' });

    expect(document.querySelector('#issue-form-body script')).toBeNull();
    expect(document.getElementById('issue-form-issuedto').value).toBe('O\'Brien "Sons"');
    expect(document.getElementById('issue-form-reference').value).toBe('<script>x</script>');
  });
});
