/**
 * The keyboard in every Select2 dropdown (core.js), against the REAL jQuery
 * and Select2 the app ships, because both faults live in how the two behave
 * together:
 *
 *   - Opening a list left focus on the closed box, so what was typed straight
 *     after went nowhere until the search box was clicked.
 *   - Escape closed the list and carried on up to the dialog around it, which
 *     closed too and took whatever was typed into the form with it.
 *
 * Fixed once in core.js, so these drive the setups the app really uses rather
 * than one form's dropdown.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Parses and runs the real bundles: see production_component_select2.test.js.
jest.setTimeout(30000);

const VENDOR = path.join(__dirname, '..', 'vendor');

function loadVendorLibs() {
  const jq = fs.readFileSync(path.join(VENDOR, 'jquery-3.6.0.min.js'), 'utf8');
  new Function('window', 'document', 'module', 'exports', jq)(window, document, undefined, undefined);
  const s2 = fs.readFileSync(path.join(VENDOR, 'select2-4.1.0.min.js'), 'utf8');
  new Function('window', 'document', 'jQuery', 'module', 'exports', 'define', s2)(
    window, document, window.jQuery, undefined, undefined, undefined);
}

const SETUPS = [
  ['a plain list', { placeholder: 'Choose a Size...' }],
  ['one that takes a new name', { tags: true }],
  ['one that can be cleared', { allowClear: true, placeholder: 'Any' }]
];

const key = (el, name) => {
  const ev = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev;
};
const search = () => document.querySelector('.select2-container--open .select2-search__field');
const instance = el => window.jQuery(el).data('select2');

describe('Select2 dropdowns, from the keyboard', () => {
  let dialog;
  let reachedDialog;

  beforeAll(() => {
    loadVendorLibs();
    // core.js's own listeners are all this needs from it.
    eval(fs.readFileSync(path.join(__dirname, '..', 'core.js'), 'utf8'));
  });

  function mount(options) {
    document.body.innerHTML = `
      <div class="modal" id="dialog">
        <input id="typed" value="what the operator typed">
        <select id="first"><option value=""></option><option value="a">14 inch</option><option value="b">20 inch</option></select>
        <select id="second"><option value=""></option><option value="c">Crysta</option></select>
      </div>`;
    dialog = document.getElementById('dialog');
    reachedDialog = jest.fn();
    dialog.addEventListener('keydown', reachedDialog);
    ['first', 'second'].forEach(id => {
      window.jQuery(`#${id}`).select2({ width: '100%', dropdownParent: window.jQuery(dialog), ...options });
    });
  }

  afterEach(() => {
    ['first', 'second'].forEach(id => {
      const el = document.getElementById(id);
      if (el && instance(el)) window.jQuery(el).select2('destroy');
    });
  });

  describe.each(SETUPS)('%s', (_name, options) => {
    beforeEach(() => mount(options));

    test('opening it puts the cursor in the search box', () => {
      window.jQuery('#first').select2('open');

      expect(search()).not.toBeNull();
      expect(document.activeElement).toBe(search());
    });

    test('Escape in the search box closes the list and leaves the form alone', () => {
      const first = document.getElementById('first');
      window.jQuery(first).select2('open');

      key(search(), 'Escape');

      expect(instance(first).isOpen()).toBe(false);
      expect(reachedDialog).not.toHaveBeenCalled();
      expect(document.getElementById('typed').value).toBe('what the operator typed');
    });

    test('Escape with focus on the box itself does the same', () => {
      const first = document.getElementById('first');
      window.jQuery(first).select2('open');
      const box = first.nextElementSibling.querySelector('.select2-selection');
      box.focus();

      key(box, 'Escape');

      expect(instance(first).isOpen()).toBe(false);
      expect(reachedDialog).not.toHaveBeenCalled();
    });
  });

  test('with no list open, Escape reaches the dialog as it always has', () => {
    mount({});

    key(document.getElementById('typed'), 'Escape');

    expect(reachedDialog).toHaveBeenCalledTimes(1);
  });

  test('the second Escape is the dialog\'s: the first only closed the list', () => {
    mount({});
    window.jQuery('#first').select2('open');

    key(search(), 'Escape');
    expect(reachedDialog).not.toHaveBeenCalled();

    key(document.getElementById('typed'), 'Escape');
    expect(reachedDialog).toHaveBeenCalledTimes(1);
  });

  test('other keys are not swallowed while a list is open', () => {
    mount({});
    window.jQuery('#first').select2('open');

    const ev = key(search(), 'a');

    expect(ev.defaultPrevented).toBe(false);
    expect(instance(document.getElementById('first')).isOpen()).toBe(true);
  });

  test('Escape closes only the list that is open', () => {
    mount({});
    const first = document.getElementById('first');
    const second = document.getElementById('second');
    window.jQuery(second).select2('open');

    key(search(), 'Escape');

    expect(instance(second).isOpen()).toBe(false);
    expect(instance(first).isOpen()).toBe(false);
    expect(reachedDialog).not.toHaveBeenCalled();
  });

  test('a list closed by destroying it leaves nothing for Escape to trip on', () => {
    mount({});
    const first = document.getElementById('first');
    window.jQuery(first).select2('open');
    window.jQuery(first).select2('destroy');

    expect(() => key(document.getElementById('typed'), 'Escape')).not.toThrow();
    expect(reachedDialog).toHaveBeenCalledTimes(1);
  });
});
