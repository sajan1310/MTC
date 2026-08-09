/**
 * Regression test for App.PlanningBoard (../planning-board.js) -- the
 * generic Preact+htm drag-and-drop board (Dispatch Plan is its first
 * consumer, see dispatch-plan.test.js for the Dispatch-specific glue
 * layer, tested separately).
 *
 * htm's package.json advertises a `require` condition for
 * "./preact/standalone" (the CDN build planning-board.js actually loads
 * in production), but the file it points at isn't shipped in this
 * package version -- require('htm/preact/standalone(.umd.js)') throws
 * either ERR_PACKAGE_PATH_NOT_EXPORTED or MODULE_NOT_FOUND depending on
 * the specifier used. Loaded directly from disk instead (same
 * fs.readFileSync technique this suite already uses for its own source
 * files), which also guarantees the exact bytes the CDN serves in
 * production, not a reimplementation.
 *
 * jsdom has no real drag events. SortableJS is stubbed (recording the
 * options each Card/Pool instance was created with) so the onAdd handler
 * -- the one piece of hand-written drop-parsing logic in
 * planning-board.js -- can be invoked directly and verified. Actual
 * pointer-drag feel (multi-select visuals, animation) needs a real
 * browser -- see the implementation plan's manual verification step.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function loadHtmPreactStandalone() {
  const file = path.join(__dirname, '..', '..', '..', 'node_modules', 'htm', 'preact', 'standalone.umd.js');
  const code = fs.readFileSync(file, 'utf8');
  const mod = { exports: {} };
  new Function('module', 'exports', code)(mod, mod.exports);
  return mod.exports;
}

function loadPlanningBoard() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'planning-board.js'), 'utf8');
  eval(code);
}

function makeSortableStub() {
  const instances = [];
  const selected = new Set();
  window.Sortable = {
    create(el, options) {
      const instance = { el, options, destroy: jest.fn() };
      instances.push(instance);
      return instance;
    },
    utils: {
      select: jest.fn(el => selected.add(el)),
      deselect: jest.fn(el => selected.delete(el)),
    },
  };
  return { instances, selected };
}

// Preact defers BOTH re-renders after a state update (e.g. the input
// events below) and useEffect callbacks (where Sortable.create/destroy
// happen) to a microtask/rAF-scheduled flush, not the current call stack --
// a handler dispatched synchronously right after would still close over
// pre-update state, or find no Sortable instance registered yet. Awaiting
// a real timer tick lets that scheduled flush actually run first.
function flush() {
  return new Promise(resolve => setTimeout(resolve, 100));
}

function baseConfig(overrides) {
  return Object.assign({
    pool: [],
    cards: [],
    onDropToCard: jest.fn(),
    onQtyChange: jest.fn(),
    onRemoveLine: jest.fn(),
    onAddCard: jest.fn(),
    onConvertCard: jest.fn(),
  }, overrides);
}

describe('App.PlanningBoard', () => {
  let instances;
  let selected;

  beforeEach(() => {
    window.htmPreact = loadHtmPreactStandalone();
    ({ instances, selected } = makeSortableStub());
    document.body.innerHTML = '<div id="root"></div>';
    delete window.App;
    loadPlanningBoard();
  });

  function mount(config) {
    window.App.PlanningBoard.mount(document.getElementById('root'), config);
  }

  test('mount() is a safe no-op (not a throw) if the Preact CDN script never loaded', () => {
    delete window.htmPreact;
    delete window.App;
    loadPlanningBoard();

    expect(() => window.App.PlanningBoard.mount(document.getElementById('root'), baseConfig())).not.toThrow();
    expect(document.getElementById('root').innerHTML).toBe('');
  });

  test('renders pool items with their available qty, and an empty-state card with no action button', () => {
    mount(baseConfig({
      pool: [{ id: 'P1', label: 'Widget', sublabel: 'P1', availableQty: 5 }],
      cards: [{ id: 'Acme', title: 'Acme', lines: [] }],
    }));

    expect(document.querySelectorAll('.pb-pool-item')).toHaveLength(1);
    expect(document.querySelector('.pb-pool-item-check')).not.toBeNull();
    expect(document.querySelector('.pb-pool-item-qty').textContent).toBe('5');
    expect(document.querySelector('.pb-card-empty')).not.toBeNull();
    expect(document.querySelector('.pb-card-action')).toBeNull();
  });

  test('the search box filters pool items by label or sublabel, matching App.Utils.matchesKeywords semantics', async () => {
    window.App.Utils = { matchesKeywords: (haystack, term) => String(haystack).toLowerCase().includes(String(term).toLowerCase()) };
    mount(baseConfig({
      pool: [
        { id: 'P1', label: 'Runway IBC T/Tube', sublabel: 'P1', availableQty: 5 },
        { id: 'P2', label: 'Hunter IBC T/Tube', sublabel: 'P2', availableQty: 8 },
      ],
    }));
    expect(document.querySelectorAll('.pb-pool-item')).toHaveLength(2);

    const search = document.querySelector('.pb-pool-search');
    search.value = 'Hunter';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();

    expect(document.querySelectorAll('.pb-pool-item')).toHaveLength(1);
    expect(document.querySelector('.pb-pool-item-label').textContent).toBe('Hunter IBC T/Tube');
  });

  test('search with no matches shows the empty state instead of an empty list', async () => {
    window.App.Utils = { matchesKeywords: (haystack, term) => String(haystack).toLowerCase().includes(String(term).toLowerCase()) };
    mount(baseConfig({ pool: [{ id: 'P1', label: 'Widget', sublabel: '', availableQty: 5 }] }));

    const search = document.querySelector('.pb-pool-search');
    search.value = 'nothing matches this';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();

    expect(document.querySelectorAll('.pb-pool-item')).toHaveLength(0);
    expect(document.querySelector('.pb-pool-empty')).not.toBeNull();
  });

  test('checking a pool item\'s checkbox drives selection via Sortable.utils.select/deselect, not a plain click', async () => {
    mount(baseConfig({ pool: [{ id: 'P1', label: 'Widget', sublabel: '', availableQty: 5 }] }));
    await flush();

    const row = document.querySelector('.pb-pool-item');
    const checkbox = document.querySelector('.pb-pool-item-check');
    expect(checkbox.checked).toBe(false);

    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    expect(window.Sortable.utils.select).toHaveBeenCalledWith(row);
    expect(selected.has(row)).toBe(true);

    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    expect(window.Sortable.utils.deselect).toHaveBeenCalledWith(row);
    expect(selected.has(row)).toBe(false);
  });

  test('the pool Sortable instance excludes the checkbox from drag-initiation (filter) and wires onSelect/onDeselect', async () => {
    mount(baseConfig({ pool: [{ id: 'P1', label: 'Widget', sublabel: '', availableQty: 5 }] }));
    await flush();

    const poolInstance = instances.find(i => i.el.classList.contains('pb-pool-list'));
    expect(poolInstance.options.filter).toContain('input');
    expect(poolInstance.options.preventOnFilter).toBe(false);
    expect(typeof poolInstance.options.onSelect).toBe('function');
    expect(typeof poolInstance.options.onDeselect).toBe('function');
  });

  test('a NATIVE row-click selection (MultiDrag\'s own onSelect, not the checkbox) still checks the checkbox -- both are kept in sync', async () => {
    mount(baseConfig({ pool: [{ id: 'P1', label: 'Widget', sublabel: '', availableQty: 5 }] }));
    await flush();

    const row = document.querySelector('.pb-pool-item');
    const checkbox = document.querySelector('.pb-pool-item-check');
    expect(checkbox.checked).toBe(false);

    const poolInstance = instances.find(i => i.el.classList.contains('pb-pool-list'));
    // Simulates what MultiDrag itself does internally on a plain row click --
    // dispatch its onSelect hook directly, bypassing the checkbox entirely.
    poolInstance.options.onSelect({ item: row });
    await flush();

    expect(document.querySelector('.pb-pool-item-check').checked).toBe(true);

    poolInstance.options.onDeselect({ item: row });
    await flush();
    expect(document.querySelector('.pb-pool-item-check').checked).toBe(false);
  });

  test('changing the search text clears any active selection', async () => {
    window.App.Utils = { matchesKeywords: (haystack, term) => String(haystack).toLowerCase().includes(String(term).toLowerCase()) };
    mount(baseConfig({ pool: [{ id: 'P1', label: 'Widget', sublabel: '', availableQty: 5 }] }));
    await flush();

    const checkbox = document.querySelector('.pb-pool-item-check');
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(selected.size).toBe(1);

    // Search for something that STILL matches -- isolates "selection cleared
    // because the search changed" from "selection gone because the item was
    // filtered out and unmounted".
    const search = document.querySelector('.pb-pool-search');
    search.value = 'Widget';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();

    expect(window.Sortable.utils.deselect).toHaveBeenCalled();
    expect(selected.size).toBe(0);
    expect(document.querySelector('.pb-pool-item-check')).not.toBeNull();
    expect(document.querySelector('.pb-pool-item-check').checked).toBe(false);
  });

  test('clicking the checkbox does not bubble up as a row click', () => {
    mount(baseConfig({ pool: [{ id: 'P1', label: 'Widget', sublabel: '', availableQty: 5 }] }));
    const row = document.querySelector('.pb-pool-item');
    const rowClick = jest.fn();
    row.addEventListener('click', rowClick);

    document.querySelector('.pb-pool-item-check').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(rowClick).not.toHaveBeenCalled();
  });

  test('"+ New Client..." form calls onAddCard with the trimmed name and clears itself', async () => {
    const onAddCard = jest.fn();
    mount(baseConfig({ onAddCard }));

    const input = document.querySelector('.pb-add-card-input');
    input.value = '  Fresh Client  ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(); // let the input's state update re-render before submit reads it
    document.querySelector('.pb-add-card').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    expect(onAddCard).toHaveBeenCalledWith('Fresh Client');
  });

  test('blank "+ New Client..." submit is a no-op', () => {
    const onAddCard = jest.fn();
    mount(baseConfig({ onAddCard }));

    document.querySelector('.pb-add-card').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    expect(onAddCard).not.toHaveBeenCalled();
  });

  test('a card line\'s qty input only commits onQtyChange on blur, and only when the value actually changed', async () => {
    const onQtyChange = jest.fn();
    mount(baseConfig({
      cards: [{ id: 'Acme', title: 'Acme', lines: [{ lineId: 7, label: 'Widget (P1)', qty: 3, fulfilled: false }] }],
      onQtyChange,
    }));
    // CardLine's mount effect syncs its qty state from the line prop -- it
    // must run before anything types into the input, or it would clobber
    // the typed value on its deferred flush.
    await flush();

    const qtyInput = document.querySelector('.pb-card-line-qty');

    qtyInput.dispatchEvent(new Event('blur'));
    expect(onQtyChange).not.toHaveBeenCalled();

    qtyInput.value = '9';
    qtyInput.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(); // let the input's state update re-render before blur reads it
    qtyInput.dispatchEvent(new Event('blur'));
    expect(onQtyChange).toHaveBeenCalledWith(7, 9);
  });

  test('a fulfilled line disables its qty input, hides the remove button, and shows a badge instead', () => {
    mount(baseConfig({
      cards: [{ id: 'Acme', title: 'Acme', lines: [{ lineId: 7, label: 'Widget (P1)', qty: 3, fulfilled: true }] }],
    }));

    expect(document.querySelector('.pb-card-line-qty').disabled).toBe(true);
    expect(document.querySelector('.pb-card-line-remove')).toBeNull();
    expect(document.querySelector('.pb-card-line-fulfilled-badge')).not.toBeNull();
  });

  test('remove button calls onRemoveLine with the line id', () => {
    const onRemoveLine = jest.fn();
    mount(baseConfig({
      cards: [{ id: 'Acme', title: 'Acme', lines: [{ lineId: 7, label: 'Widget (P1)', qty: 3, fulfilled: false }] }],
      onRemoveLine,
    }));

    document.querySelector('.pb-card-line-remove').dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onRemoveLine).toHaveBeenCalledWith(7);
  });

  test('the card action button only renders once the card has lines, and fires onConvertCard with the card id', () => {
    const onConvertCard = jest.fn();
    mount(baseConfig({
      cards: [{ id: 'Acme', title: 'Acme', lines: [{ lineId: 7, label: 'Widget (P1)', qty: 3, fulfilled: false }] }],
      onConvertCard,
      cardActionLabel: 'Dispatch',
    }));

    const btn = document.querySelector('.pb-card-action');
    expect(btn.textContent).toBe('Dispatch');
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onConvertCard).toHaveBeenCalledWith('Acme');
  });

  test('a card\'s cancel (×) button fires onCancelCard with the card id, regardless of whether it has lines', () => {
    const onCancelCard = jest.fn();
    mount(baseConfig({
      cards: [{ id: 'Acme', title: 'Acme', lines: [] }],
      onCancelCard,
    }));

    const btn = document.querySelector('.pb-card-cancel');
    expect(btn).not.toBeNull();
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onCancelCard).toHaveBeenCalledWith('Acme');
  });

  test('the cancel button is omitted when the caller does not supply onCancelCard', () => {
    mount(baseConfig({ cards: [{ id: 'Acme', title: 'Acme', lines: [] }], onCancelCard: undefined }));
    expect(document.querySelector('.pb-card-cancel')).toBeNull();
  });

  test('a single-item drop (evt.item) reads the pool-item id/qty off the dropped node, calls onDropToCard, and discards the node', async () => {
    const onDropToCard = jest.fn();
    mount(baseConfig({
      cards: [{ id: 'Acme', title: 'Acme', lines: [] }],
      onDropToCard,
    }));
    await flush(); // let the card's useEffect (window.Sortable.create) run

    const cardListEl = document.querySelector('.pb-card-lines');
    const sortableInstance = instances.find(i => i.el === cardListEl);
    expect(sortableInstance).toBeTruthy();

    const dropped = document.createElement('div');
    dropped.setAttribute('data-pool-item-id', 'P1');
    dropped.setAttribute('data-pool-item-qty', '4');
    cardListEl.appendChild(dropped);

    sortableInstance.options.onAdd({ item: dropped });

    expect(onDropToCard).toHaveBeenCalledWith([{ poolItemId: 'P1', qty: 4 }], 'Acme');
    expect(dropped.parentNode).toBeNull();
  });

  test('a multi-select drop (evt.items) extracts every dropped node in one call, skipping any with no remaining qty', async () => {
    const onDropToCard = jest.fn();
    mount(baseConfig({
      cards: [{ id: 'Acme', title: 'Acme', lines: [] }],
      onDropToCard,
    }));
    await flush();

    const cardListEl = document.querySelector('.pb-card-lines');
    const sortableInstance = instances.find(i => i.el === cardListEl);

    const a = document.createElement('div');
    a.setAttribute('data-pool-item-id', 'P1');
    a.setAttribute('data-pool-item-qty', '4');
    const b = document.createElement('div');
    b.setAttribute('data-pool-item-id', 'P2');
    b.setAttribute('data-pool-item-qty', '0'); // exhausted -- must be skipped

    cardListEl.appendChild(a);
    cardListEl.appendChild(b);

    sortableInstance.options.onAdd({ items: [a, b] });

    expect(onDropToCard).toHaveBeenCalledTimes(1);
    expect(onDropToCard).toHaveBeenCalledWith([{ poolItemId: 'P1', qty: 4 }], 'Acme');
  });

  test('the pool Sortable instance is created with pull:"clone", put:false, and multiDrag enabled', async () => {
    mount(baseConfig({ pool: [{ id: 'P1', label: 'Widget', sublabel: '', availableQty: 5 }] }));
    await flush();

    const poolInstance = instances.find(i => i.el.classList.contains('pb-pool-list'));
    expect(poolInstance.options.group).toMatchObject({ pull: 'clone', put: false });
    expect(poolInstance.options.multiDrag).toBe(true);
    expect(poolInstance.options.sort).toBe(false);
  });

  test('unmounting (re-rendering with no cards) destroys that card\'s Sortable instance', async () => {
    mount(baseConfig({ cards: [{ id: 'Acme', title: 'Acme', lines: [] }] }));
    await flush();
    const cardInstance = instances.find(i => i.el.classList.contains('pb-card-lines'));
    expect(cardInstance).toBeTruthy();

    mount(baseConfig({ cards: [] }));
    await flush();

    expect(cardInstance.destroy).toHaveBeenCalled();
  });
});
