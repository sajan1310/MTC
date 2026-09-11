/**
 * The production lot card's layout.
 *
 * It stacked lot number, process, date, status and three text links all
 * down the left edge, with the quantity marooned on the right -- a tall
 * left column against an empty one. Status and date belong together (what
 * state is this lot in, and since when), and the actions belong opposite
 * them, which balances the card.
 *
 * The actions were also the smallest targets in the app: three words in a
 * row as `mb-btn-text` with `padding: 0`, well under the 44px minimum this
 * stylesheet sets everywhere else, and close enough together that Delete
 * was a slip away from Edit. On a phone held in a workshop that is the
 * difference between editing a lot and destroying one.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'mobile_styles.css'), 'utf8');

function loadAsGlobal(relPath, exportName) {
  const code = fs
    .readFileSync(path.join(__dirname, '..', relPath), 'utf8')
    .replace(new RegExp(`^const ${exportName} = `, 'm'), `global.${exportName} = `);
  // eslint-disable-next-line no-eval
  eval(code);
}

const LOTS = [
  {
    rowIdx: 1, lotNumber: 'LOT-PFI2IT-0010', processId: 'PRC-1',
    date: '12/09/2026', dateRaw: '2026-09-12', qty: 10,
    assignedTo: 'sanjay', status: 'Pending', colorQty: [],
  },
];

function mount() {
  jest.resetModules();
  global.fetch = jest.fn();
  document.body.innerHTML = `
    <div id="mapp-sheet-backdrop"></div>
    <div id="production-list"></div>
    <div class="mb-toast-stack" id="mapp-toast-stack"></div>`;
  loadAsGlobal('api.js', 'Api');
  loadAsGlobal('mobile.js', 'MApp');
  MApp.Sheet._stack = [];
  // render() reads its rows through MApp.Search over `entries`, which is
  // what load() indexes -- not a plain array.
  MApp.Production.entries = MApp.Search.index(LOTS, MApp.Production.SEARCH);
  MApp.Production.searchTerm = '';
  MApp.Production.processById = { 'PRC-1': { processName: 'Packing Ferari IBC 24 inch' } };
  MApp.Production.render();
}

const card = () => document.querySelector('#production-list .mb-card');
const footer = () => document.querySelector('.mapp-lot-footer');
const actions = () => [...document.querySelectorAll('.mapp-lot-action')];

describe('the card is balanced', () => {
  beforeEach(mount);

  test('status and date sit together', () => {
    const meta = document.querySelector('.mapp-lot-meta');
    expect(meta).not.toBeNull();
    expect(meta.querySelector('[data-lot-action="status"]')).not.toBeNull();
    expect(meta.textContent).toContain('12 Sep');
  });

  test('the date is no longer stacked under the process name', () => {
    // That stacking is what left everything hugging the left edge.
    const left = card().querySelector('.mb-card-row > div');
    expect(left.textContent).toContain('Packing Ferari');
    expect(left.textContent).not.toContain('12 Sep');
  });

  test('the actions sit opposite the status, not beneath it', () => {
    expect(footer().querySelector('.mapp-lot-actions')).not.toBeNull();
    expect(CSS).toMatch(/\.mapp-lot-footer\s*\{[^}]*justify-content:\s*space-between/);
  });

  test('quantity and contractor stay on the right', () => {
    const right = card().querySelectorAll('.mb-card-row > div')[1];
    expect(right.textContent).toContain('10');
    expect(right.textContent).toContain('Sanjay');
  });
});

describe('the actions', () => {
  beforeEach(mount);

  test('all three are still there and still wired', () => {
    // The hooks the delegated handler reads must survive a restyle.
    ['edit', 'sheet', 'delete'].forEach(action => {
      expect(document.querySelector(`[data-lot-action="${action}"]`)).not.toBeNull();
    });
  });

  test('each carries a label for anyone who cannot see the icon', () => {
    // They are icons now, so the name has to live in the accessible name.
    actions().forEach(btn => {
      expect(btn.getAttribute('aria-label')).toBeTruthy();
      expect(btn.getAttribute('title')).toBeTruthy();
    });
  });

  test('they meet the tap minimum the rest of the app uses', () => {
    // THE fix. They were mb-btn-text with padding:0 -- a target far under
    // 44px, with Delete a slip away from Edit.
    const rule = CSS.match(/\.mapp-lot-action\s*\{[^}]*\}/)[0];
    expect(rule).toContain('width: var(--mb-tap-min)');
    expect(rule).toContain('height: var(--mb-tap-min)');
  });

  test('only Delete carries colour', () => {
    // The one that cannot be undone says so before it is pressed.
    const del = document.querySelector('[data-lot-action="delete"]');
    expect(del.classList.contains('mapp-lot-action-danger')).toBe(true);

    ['edit', 'sheet'].forEach(a => {
      expect(document.querySelector(`[data-lot-action="${a}"]`)
        .classList.contains('mapp-lot-action-danger')).toBe(false);
    });
    expect(CSS).toMatch(/\.mapp-lot-action-danger\s*\{[^}]*--mb-enamel-red-ink/);
  });

  test('clicking one still acts on the right lot', () => {
    MApp.Production.openEditSheet = jest.fn();
    document.querySelector('[data-lot-action="edit"]').click();

    expect(MApp.Production.openEditSheet).toHaveBeenCalled();
  });

  test('every class the card renders is one the stylesheet defines', () => {
    const used = new Set();
    document.querySelectorAll('#production-list *').forEach(el => {
      el.classList.forEach(c => used.add(c));
    });
    expect([...used].filter(c => !CSS.includes(`.${c}`))).toEqual([]);
  });
});

describe('it survives a narrow card', () => {
  beforeEach(mount);

  test('the footer wraps rather than crushing the status chip', () => {
    // A long status word plus a date can exceed a 320px card.
    expect(CSS).toMatch(/\.mapp-lot-footer\s*\{[^}]*flex-wrap:\s*wrap/);
  });

  test('a lot with no date still renders the row', () => {
    MApp.Production.entries = MApp.Search.index(
      [{ ...LOTS[0], dateRaw: '', date: '' }], MApp.Production.SEARCH);
    MApp.Production.render();

    expect(document.querySelector('.mapp-lot-date').textContent).toBe('—');
    expect(actions()).toHaveLength(3);
  });
});
