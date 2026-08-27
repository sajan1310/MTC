/**
 * Validation errors are attached to their field (A11Y-007).
 *
 * Validation failures surfaced as toasts: "Every ticked process needs a Qty
 * per Unit greater than 0". The toast names the rule but not the field,
 * appears in a corner unrelated to the form, and removes itself after a few
 * seconds. A sighted user scans the form and guesses. A screen-reader user
 * gets nothing at all: no `aria-invalid` anywhere, so no field announces
 * itself as the problem, and by the time they have navigated to the form the
 * toast is gone.
 *
 * These helpers attach the message TO the field -- `aria-invalid` marks it,
 * `aria-describedby` ties the text to it -- so it is read as part of the
 * field rather than as unrelated page content.
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

global.escapeHtml = str => String(str ?? '');

beforeEach(() => {
  jest.useFakeTimers();
  document.body.innerHTML = `
    <div id="a11y-announcer" role="status" aria-live="polite"></div>
    <form id="f">
      <label for="name">Vendor Name *</label>
      <input id="name" name="name" required>
      <label for="qty">Quantity</label>
      <input id="qty" name="qty" type="number" min="1">
      <input id="notes" name="notes" aria-describedby="notes-help">
      <div id="notes-help">Optional</div>
    </form>`;
  loadCoreAsGlobal();
});

afterEach(() => jest.useRealTimers());

const field = id => document.getElementById(id);

// ── Marking one field ──────────────────────────────────────────────────

describe('markFieldInvalid', () => {
  test('marks the field as invalid for assistive technology', () => {
    App.Utils.markFieldInvalid('name', 'Vendor Name is required.');
    expect(field('name').getAttribute('aria-invalid')).toBe('true');
  });

  test('attaches the message so it is read as part of the field', () => {
    App.Utils.markFieldInvalid('name', 'Vendor Name is required.');
    const describedBy = field('name').getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const message = document.getElementById(describedBy.split(/\s+/).pop());
    expect(message.textContent).toBe('Vendor Name is required.');
  });

  test('the message element follows the field', () => {
    // Reading order should match visual order.
    App.Utils.markFieldInvalid('name', 'nope');
    expect(field('name').nextElementSibling.className).toContain('invalid-feedback');
  });

  test('existing descriptions are kept, not clobbered', () => {
    // A field may already point at help text; replacing it would trade one
    // lost message for another.
    App.Utils.markFieldInvalid('notes', 'Too long.');
    const ids = field('notes').getAttribute('aria-describedby').split(/\s+/);
    expect(ids).toContain('notes-help');
    expect(ids.length).toBe(2);
  });

  test('marking twice does not duplicate the reference', () => {
    App.Utils.markFieldInvalid('name', 'first');
    App.Utils.markFieldInvalid('name', 'second');
    const ids = field('name').getAttribute('aria-describedby').split(/\s+/);
    expect(new Set(ids).size).toBe(ids.length);
    expect(document.getElementById(ids[0]).textContent).toBe('second');
  });

  test('a missing field is a no-op', () => {
    expect(() => App.Utils.markFieldInvalid('nope', 'x')).not.toThrow();
  });
});

// ── Clearing ───────────────────────────────────────────────────────────

describe('clearFieldErrors', () => {
  test('removes the invalid state', () => {
    App.Utils.markFieldInvalid('name', 'nope');
    App.Utils.clearFieldErrors('f');
    expect(field('name').hasAttribute('aria-invalid')).toBe(false);
    expect(field('name').classList.contains('is-invalid')).toBe(false);
  });

  test('leaves unrelated descriptions intact', () => {
    // Clearing an error must not strip the help text the field had before.
    App.Utils.markFieldInvalid('notes', 'nope');
    App.Utils.clearFieldErrors('f');
    expect(field('notes').getAttribute('aria-describedby')).toBe('notes-help');
  });
});

// ── Native constraints, actually enforced ──────────────────────────────

describe('validateForm', () => {
  test('passes a valid form', () => {
    field('name').value = 'Acme';
    expect(App.Utils.validateForm('f')).toBe(true);
  });

  test('fails and marks the offending field', () => {
    expect(App.Utils.validateForm('f')).toBe(false);
    expect(field('name').getAttribute('aria-invalid')).toBe('true');
  });

  test('announces the field by its label, not its id', () => {
    // "name: Constraints not satisfied" helps nobody; the label is what the
    // user sees on screen.
    App.Utils.validateForm('f');
    jest.advanceTimersByTime(100);
    const said = document.getElementById('a11y-announcer').textContent;
    expect(said).toContain('Vendor Name');
    // The label's required asterisk is not read out as punctuation.
    expect(said).not.toContain('*');
  });

  test('moves focus to the first offending field', () => {
    App.Utils.validateForm('f');
    expect(document.activeElement.id).toBe('name');
  });

  test('a disabled field is not enforced', () => {
    // Cascading selects here are `required disabled` until an earlier choice
    // is made. Enforcing those would make the form unsubmittable.
    field('name').value = 'Acme';
    const extra = document.createElement('input');
    extra.id = 'later';
    extra.required = true;
    extra.disabled = true;
    document.getElementById('f').appendChild(extra);
    expect(App.Utils.validateForm('f')).toBe(true);
  });

  test('re-validating clears the previous marks', () => {
    App.Utils.validateForm('f');
    expect(field('name').getAttribute('aria-invalid')).toBe('true');
    field('name').value = 'Acme';
    expect(App.Utils.validateForm('f')).toBe(true);
    expect(field('name').hasAttribute('aria-invalid')).toBe(false);
  });

  test('a missing form does not block the save', () => {
    // Fail open: a helper that cannot find the form must not silently
    // prevent every save.
    expect(App.Utils.validateForm('does-not-exist')).toBe(true);
  });
});
