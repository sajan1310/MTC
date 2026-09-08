/**
 * MApp.Form -- fields from a spec, and validation the operator can see
 * (Phase 4, F4 / MB-A05, MB-A06).
 *
 * Validation was 23 calls to MApp.Toast.error(): a message at the bottom
 * of the screen, unattached to the field that caused it, gone in 4.2
 * seconds, with no way to bring it back. On a long form the offending
 * field is usually scrolled out of view and nothing scrolled to it. There
 * was no aria-invalid anywhere in the app, so a screen-reader user had
 * nothing to navigate by at all.
 *
 * The field `type` also drives the mobile keyboard, which is what finally
 * gives a vendor's phone number a keypad instead of a full QWERTY.
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

const SPEC = {
  id: 'test-form',
  fields: [
    { key: 'name', label: 'Vendor Name', type: 'text', required: true },
    { key: 'contact', label: 'Contact Number', type: 'tel' },
    { key: 'email', label: 'Email', type: 'email' },
    { key: 'qty', label: 'Quantity', type: 'decimal', min: 0 },
    { key: 'boxes', label: 'Boxes', type: 'integer' },
    { key: 'address', label: 'Address', type: 'multiline', hint: 'Street and city' },
  ],
};

describe('MApp.Form', () => {
  beforeEach(() => {
    jest.resetModules();
    global.fetch = jest.fn();
    document.body.innerHTML = '<div id="body"></div>';
    loadAsGlobal('api.js', 'Api');
    loadAsGlobal('mobile.js', 'MApp');
  });

  const field = key => document.getElementById(`test-form-${key}`);
  const errorOf = key => document.getElementById(`test-form-${key}-error`);
  const set = (key, value) => { field(key).value = value; };

  describe('rendering', () => {
    beforeEach(() => MApp.Form.render('body', SPEC, {}));

    test('gives each field type the keyboard it needs', () => {
      // The defect this replaces: a contact field was type="text" on a
      // card advertising tap-to-call, while 24 numeric fields elsewhere
      // already carried inputmode.
      expect(field('contact').getAttribute('type')).toBe('tel');
      expect(field('contact').getAttribute('inputmode')).toBe('tel');
      expect(field('email').getAttribute('type')).toBe('email');
      expect(field('qty').getAttribute('inputmode')).toBe('decimal');
      expect(field('boxes').getAttribute('inputmode')).toBe('numeric');
      expect(field('name').getAttribute('type')).toBe('text');
    });

    test('renders multiline as a textarea', () => {
      expect(field('address').tagName).toBe('TEXTAREA');
    });

    test('labels are associated, not merely adjacent', () => {
      const label = document.querySelector('label[for="test-form-name"]');
      expect(label).not.toBeNull();
      expect(label.textContent).toContain('Vendor Name');
    });

    test('required fields say so to assistive tech, not only with an asterisk', () => {
      expect(field('name').getAttribute('aria-required')).toBe('true');
      expect(field('contact').getAttribute('aria-required')).toBeNull();
    });

    test('hints and the error slot are both described-by from the input', () => {
      const described = field('address').getAttribute('aria-describedby');
      expect(described).toContain('test-form-address-hint');
      expect(described).toContain('test-form-address-error');
      expect(errorOf('address').hidden).toBe(true);
    });

    test('populates from a record', () => {
      MApp.Form.render('body', SPEC, { name: 'Acme', contact: '9876543210' });
      expect(field('name').value).toBe('Acme');
      expect(field('contact').value).toBe('9876543210');
    });

    test('a value containing quotes or markup cannot break out of the field', () => {
      MApp.Form.render('body', SPEC, { name: 'Rim 26" <script>alert(1)</script>' });
      expect(document.querySelector('#body script')).toBeNull();
      expect(field('name').value).toBe('Rim 26" <script>alert(1)</script>');
    });
  });

  describe('reading', () => {
    beforeEach(() => MApp.Form.render('body', SPEC, {}));

    test('trims values', () => {
      set('name', '  Acme  ');
      expect(MApp.Form.read(SPEC).name).toBe('Acme');
    });

    test('missing fields do not throw', () => {
      document.getElementById('body').innerHTML = '';
      expect(() => MApp.Form.read(SPEC)).not.toThrow();
    });
  });

  describe('validation', () => {
    beforeEach(() => {
      MApp.Form.render('body', SPEC, {});
      // jsdom implements neither.
      Element.prototype.scrollIntoView = jest.fn();
    });

    test('a required field that is empty is marked AT the field', () => {
      expect(MApp.Form.validate(SPEC)).toBe(false);

      expect(field('name').getAttribute('aria-invalid')).toBe('true');
      expect(errorOf('name').hidden).toBe(false);
      expect(errorOf('name').textContent).toBe('Vendor Name is required.');
      expect(field('name').closest('.mb-field').classList.contains('mb-field-invalid')).toBe(true);
    });

    test('the first invalid field is scrolled to and focused', () => {
      // The half a toast could never do: on a long form the offending
      // field is usually off screen.
      set('name', '');
      MApp.Form.validate(SPEC);

      expect(field('name').scrollIntoView).toHaveBeenCalled();
      expect(document.activeElement).toBe(field('name'));
    });

    test('a valid form passes and marks nothing', () => {
      set('name', 'Acme');
      expect(MApp.Form.validate(SPEC)).toBe(true);
      expect(field('name').getAttribute('aria-invalid')).toBeNull();
      expect(errorOf('name').hidden).toBe(true);
    });

    test('numbers are checked, and the message names the field', () => {
      // Values are passed explicitly rather than typed in, because a
      // type="number" input silently discards non-numeric input -- in
      // jsdom and in every browser. The guard exists for the path
      // saveEntity actually uses (validate(spec, values)), where a value
      // can arrive from somewhere other than that input.
      expect(MApp.Form.validate(SPEC, { name: 'Acme', qty: 'abc' })).toBe(false);
      expect(errorOf('qty').textContent).toContain('Quantity');
    });

    test('a whole-number field rejects a fraction', () => {
      set('name', 'Acme');
      set('boxes', '2.5');
      expect(MApp.Form.validate(SPEC)).toBe(false);
      expect(errorOf('boxes').textContent).toContain('whole number');
    });

    test('a minimum is enforced', () => {
      set('name', 'Acme');
      set('qty', '-1');
      expect(MApp.Form.validate(SPEC)).toBe(false);
      expect(errorOf('qty').textContent).toContain('at least 0');
    });

    test('email shape is checked only when something was entered', () => {
      set('name', 'Acme');
      expect(MApp.Form.validate(SPEC)).toBe(true); // blank optional email is fine

      set('email', 'not-an-email');
      expect(MApp.Form.validate(SPEC)).toBe(false);
      expect(errorOf('email').textContent).toContain('valid email');
    });

    test('a custom rule can reject, and sees the other values', () => {
      const spec = {
        id: 'test-form',
        fields: [
          { key: 'name', label: 'Name', type: 'text' },
          { key: 'alias', label: 'Alias', type: 'text',
            validate: (v, all) => (v && v === all.name ? 'Alias must differ from Name.' : null) },
        ],
      };
      MApp.Form.render('body', spec, { name: 'Acme', alias: 'Acme' });
      expect(MApp.Form.validate(spec)).toBe(false);
      expect(document.getElementById('test-form-alias-error').textContent)
        .toBe('Alias must differ from Name.');
    });

    test('re-validating clears the previous errors rather than stacking them', () => {
      MApp.Form.validate(SPEC);
      expect(errorOf('name').hidden).toBe(false);

      set('name', 'Acme');
      expect(MApp.Form.validate(SPEC)).toBe(true);
      expect(errorOf('name').hidden).toBe(true);
      expect(document.querySelectorAll('.mb-field-invalid')).toHaveLength(0);
    });

    test('every failing field is marked, not just the first', () => {
      MApp.Form.validate(SPEC, { name: '', qty: 'abc', email: 'nope' });

      expect(document.querySelectorAll('[aria-invalid="true"]')).toHaveLength(3);
    });
  });
});

describe('the Directory form uses it', () => {
  test('saveEntity validates through MApp.Form, not a toast', () => {
    // The migration guard: reverting to MApp.Toast.error for a missing
    // name puts the message back at the bottom of the screen on a 4.2
    // second timer.
    const save = MOBILE_JS.slice(
      MOBILE_JS.indexOf('async saveEntity()'),
      MOBILE_JS.indexOf('async deleteEntity()')
    );
    expect(save).toContain('MApp.Form.validate');
    expect(save).not.toMatch(/MApp\.Toast\.error\([`'"]Enter a/);
  });

  test('the contact field is declared as a phone number', () => {
    // Anchored on the DEFINITIONS: 'openForm(record)' also appears as a
    // call site earlier in the file, which inverted the slice.
    const spec = MOBILE_JS.slice(
      MOBILE_JS.indexOf('formSpec() {'),
      MOBILE_JS.indexOf('openForm(record) {')
    );
    expect(spec).toContain("contact: 'tel'");
  });
});
