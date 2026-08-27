/**
 * A failed table load stops claiming to be loading (UX-001).
 *
 * Twenty-four loaders wrote a "Loading ..." row into a tbody and then, on
 * failure, showed a toast and returned. The toast disappears after a few
 * seconds; the row does not. So a failed load left a table saying it was
 * loading -- permanently -- and the only visible evidence that anything had
 * gone wrong removed itself. A user could sit in front of "Loading
 * Clients..." indefinitely, with nothing to click and no reason to suspect a
 * failure had occurred at all.
 *
 * Both failure shapes are covered here, because the loaders use both: an
 * envelope with success:false, and a thrown error.
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

// core.js calls the global escapeHtml from api.js.
global.escapeHtml = str => String(str ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

let tbody;

beforeEach(() => {
  document.body.innerHTML = '<table><tbody id="t"></tbody></table>';
  tbody = document.getElementById('t');
  loadCoreAsGlobal();
});

// ── The loading state ──────────────────────────────────────────────────

describe('tableLoading', () => {
  test('renders a placeholder spanning the table', () => {
    App.Utils.tableLoading(tbody, 6, 'Loading Clients...');
    expect(tbody.querySelector('td').getAttribute('colspan')).toBe('6');
    expect(tbody.textContent).toContain('Loading Clients...');
  });

  test('accepts an element id as well as an element', () => {
    App.Utils.tableLoading('t', 4, 'Loading…');
    expect(tbody.querySelector('td').getAttribute('colspan')).toBe('4');
  });

  test('a missing element is a no-op, not a crash', () => {
    expect(() => App.Utils.tableLoading('nope', 3, 'Loading…')).not.toThrow();
  });

  test('the label is escaped', () => {
    App.Utils.tableLoading(tbody, 2, '<img src=x onerror=alert(1)>');
    expect(tbody.querySelector('img')).toBeNull();
  });
});

// ── The error state ────────────────────────────────────────────────────

describe('tableError', () => {
  test('replaces the loading row', () => {
    // THE regression test: after this, the table must no longer claim to be
    // loading.
    App.Utils.tableLoading(tbody, 6, 'Loading Clients...');
    App.Utils.tableError(tbody, 'Database unavailable');

    expect(tbody.textContent).not.toContain('Loading');
    expect(tbody.textContent).toContain('Database unavailable');
  });

  test('spans the same columns as the placeholder it replaces', () => {
    // Without the remembered colspan the error row sits in column one and
    // the table renders lopsided.
    App.Utils.tableLoading(tbody, 9, 'Loading…');
    App.Utils.tableError(tbody, 'nope');
    expect(tbody.querySelector('td').getAttribute('colspan')).toBe('9');
  });

  test('offers a retry when one is available', () => {
    const retry = jest.fn();
    App.Utils.tableLoading(tbody, 3, 'Loading…');
    App.Utils.tableError(tbody, 'failed', retry);

    const button = tbody.querySelector('[data-action="retry-table-load"]');
    expect(button).not.toBeNull();
    button.click();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test('retrying puts the table back into a loading state', () => {
    App.Utils.tableLoading(tbody, 3, 'Loading…');
    App.Utils.tableError(tbody, 'failed', () => {});
    tbody.querySelector('[data-action="retry-table-load"]').click();
    expect(tbody.textContent).toContain('Retrying…');
  });

  test('shows no retry button when there is nothing to retry', () => {
    // A button that does nothing is worse than no button.
    App.Utils.tableLoading(tbody, 3, 'Loading…');
    App.Utils.tableError(tbody, 'failed');
    expect(tbody.querySelector('[data-action="retry-table-load"]')).toBeNull();
  });

  test('announces itself to assistive technology', () => {
    // Otherwise a screen-reader user is left on a table that silently
    // stopped changing.
    App.Utils.tableLoading(tbody, 3, 'Loading…');
    App.Utils.tableError(tbody, 'failed');
    expect(tbody.querySelector('td').getAttribute('role')).toBe('alert');
  });

  test('falls back to a usable message', () => {
    App.Utils.tableLoading(tbody, 3, 'Loading…');
    App.Utils.tableError(tbody, undefined);
    expect(tbody.textContent).toMatch(/could not load/i);
  });

  test('a server message cannot inject markup', () => {
    // The message comes from the server and lands in innerHTML beside a
    // button -- exactly the shape SEC-004 was about.
    App.Utils.tableLoading(tbody, 3, 'Loading…');
    App.Utils.tableError(tbody, '<img src=x onerror="alert(1)">');
    expect(tbody.querySelector('img')).toBeNull();
    expect(tbody.textContent).toContain('<img src=x');
  });
});

// ── The call sites ─────────────────────────────────────────────────────

describe('the loaders actually use them', () => {
  const MODULES = [
    'bom.js', 'client.js', 'contractor.js', 'dispatch.js', 'issue.js',
    'po.js', 'process.js', 'production.js', 'stock.js', 'users.js',
    'vendors.js',
  ];

  test.each(MODULES)('%s renders an error state on failure', (file) => {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    expect(src).toContain('App.Utils.tableError(');
  });

  test('no module still writes a raw Loading row', () => {
    // The whole finding, as one assertion: a hand-written "Loading" row is a
    // row nothing will ever clear.
    const offenders = [];
    for (const file of MODULES) {
      const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      const raw = src.match(/innerHTML\s*=\s*'<tr><td colspan="\d+"[^']*[Ll]oading[^']*'/g);
      if (raw) offenders.push(`${file}: ${raw.length}`);
    }
    expect(offenders).toEqual([]);
  });
});
