/**
 * Regression test for App.Nav (../core.js) -- the generic Prev/Next
 * record navigation + unsaved-changes guard used by every edit modal's
 * openEditModal. Run against the real source (not a reimplementation)
 * via a require() of the actual file, same const-rewrite technique
 * outbox_chaos.test.js already established for loading a classic script
 * (no module.exports) into a Jest module scope.
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

function buildModal(id) {
  document.body.innerHTML = `
    <div class="modal" id="${id}">
      <div class="modal-body">
        <input type="text" id="fieldA" value="original">
        <div class="text-end">
          <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
          <button type="submit" class="btn btn-dark">Save</button>
        </div>
      </div>
    </div>`;
  return document.getElementById(id);
}

describe('App.Nav', () => {
  let openFn;

  beforeEach(() => {
    document.body.innerHTML = '';
    loadCoreAsGlobal();
    openFn = jest.fn();
    // App.Utils.confirmAction depends on a real #confirmModal + bootstrap,
    // neither present in jsdom -- stub it to immediately invoke the
    // callback, simulating "user confirmed discard".
    App.Utils.confirmAction = jest.fn((message, callback) => callback());
  });

  test('register builds a nav bar showing position 1 of N', () => {
    const modalEl = buildModal('testModal');
    App.Nav.register('testModal', ['A', 'B', 'C'], 'A', openFn);

    const bar = modalEl.querySelector('.app-modal-nav');
    expect(bar).not.toBeNull();
    expect(bar.querySelector('.app-modal-nav-pos').textContent).toBe('1 of 3');
    expect(bar.querySelector('.app-modal-nav-prev').disabled).toBe(true);
    expect(bar.querySelector('.app-modal-nav-next').disabled).toBe(false);
  });

  test('go(+1) calls openFn with the next id when the form is clean', () => {
    buildModal('testModal');
    App.Nav.register('testModal', ['A', 'B', 'C'], 'A', openFn);

    App.Nav.go('testModal', 1);
    expect(openFn).toHaveBeenCalledWith('B');
    expect(App.Utils.confirmAction).not.toHaveBeenCalled();
  });

  test('go(-1) at the first record is a no-op', () => {
    buildModal('testModal');
    App.Nav.register('testModal', ['A', 'B', 'C'], 'A', openFn);

    App.Nav.go('testModal', -1);
    expect(openFn).not.toHaveBeenCalled();
  });

  test('go(+1) at the last record is a no-op', () => {
    buildModal('testModal');
    App.Nav.register('testModal', ['A', 'B', 'C'], 'C', openFn);

    App.Nav.go('testModal', 1);
    expect(openFn).not.toHaveBeenCalled();
  });

  test('a dirty form triggers the unsaved-changes confirm before navigating', () => {
    const modalEl = buildModal('testModal');
    App.Nav.register('testModal', ['A', 'B'], 'A', openFn);

    modalEl.querySelector('#fieldA').value = 'edited';
    App.Nav.go('testModal', 1);

    expect(App.Utils.confirmAction).toHaveBeenCalledWith(
      expect.stringContaining('unsaved changes'),
      expect.any(Function)
    );
    // The stub immediately invokes the callback, simulating confirm.
    expect(openFn).toHaveBeenCalledWith('B');
  });

  test('isDirty is false right after register, true after editing a field', () => {
    const modalEl = buildModal('testModal');
    App.Nav.register('testModal', ['A'], 'A', openFn);
    expect(App.Nav.isDirty('testModal')).toBe(false);

    modalEl.querySelector('#fieldA').value = 'changed';
    expect(App.Nav.isDirty('testModal')).toBe(true);
  });

  test('extraDirtyFn contributes to isDirty even when tracked inputs are unchanged', () => {
    buildModal('testModal');
    let extraDirty = false;
    App.Nav.register('testModal', ['A'], 'A', openFn, () => extraDirty);
    expect(App.Nav.isDirty('testModal')).toBe(false);

    extraDirty = true;
    expect(App.Nav.isDirty('testModal')).toBe(true);
  });

  test('clear removes the nav context and hides the bar', () => {
    const modalEl = buildModal('testModal');
    App.Nav.register('testModal', ['A', 'B'], 'A', openFn);
    expect(App.Nav._ctx['testModal']).toBeDefined();

    App.Nav.clear('testModal');
    expect(App.Nav._ctx['testModal']).toBeUndefined();
    expect(modalEl.querySelector('.app-modal-nav').style.display).toBe('none');
  });

  test('exit hides the modal via bootstrap when the form is clean', () => {
    buildModal('testModal');
    App.Nav.register('testModal', ['A'], 'A', openFn);

    const hide = jest.fn();
    global.bootstrap = { Modal: { getInstance: () => ({ hide }) } };

    App.Nav.exit('testModal');
    expect(hide).toHaveBeenCalled();
  });
});
