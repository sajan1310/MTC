'use strict';
// planning-board.js -- App.PlanningBoard, a generic drag-and-drop planning
// board on Preact+htm (window.htmPreact, CDN script in templates/erp/
// index.html) and SortableJS+MultiDrag (window.Sortable, same file).
//
// Deliberately Dispatch-agnostic -- Dispatch Plan (dispatch-plan.js) is the
// first consumer, Production planning is meant to reuse this exact board
// later against a different pool (BOM buildable qty) and card type
// (contractor/process instead of client). The config contract below is the
// one thing every future consumer depends on staying stable:
//
//   App.PlanningBoard.mount(container, config)
//     config.pool:  [{id, label, sublabel, availableQty}]
//     config.cards: [{id, title, lines: [{lineId, label, qty, fulfilled}]}]
//     config.onDropToCard(drops, cardId)  -- drops: [{poolItemId, qty}], one
//         or more pool items dropped on a card (qty defaults to that pool
//         item's current availableQty; the caller/glue layer persists it,
//         the operator can then edit it inline via onQtyChange).
//     config.onQtyChange(lineId, qty)     -- a card line's qty was edited
//     config.onRemoveLine(lineId)         -- a card line's remove (x) was clicked
//     config.onAddCard(title)             -- "+ New Client..." form submitted
//     config.onConvertCard(cardId)        -- a card's action button was clicked
//     config.onCancelCard(cardId)         -- a card's own × (cancel/remove) was clicked
//     config.cardActionLabel (optional, default "Dispatch")
//
// SortableJS + a virtual-DOM library is a known-tricky combination:
// Sortable mutates real DOM nodes directly, bypassing Preact's diffing. The
// pattern followed here (same one react-sortablejs/vue-draggable document):
// never treat Sortable's own DOM mutation as state -- read what landed in
// the onAdd handler, call back into config immediately, discard the
// Sortable-inserted node, and let the NEXT render (driven by the caller
// updating `pool`/`cards` props after its own save) rebuild the list from
// scratch. Every card's line-list is keyed by lineId so a render always
// fully reconciles rather than trusting stale DOM.
//
// multiDrag/forceFallback exact event shapes are a runtime detail this
// static review can't execute -- verify the actual multi-select-drag feel
// in a browser (see the implementation plan's verification step) and
// adjust the onAdd handler below if evt.items doesn't show up as expected
// on the pinned SortableJS version.
(function () {
  const lib = window.htmPreact;
  window.App = window.App || {};

  if (!lib) {
    // CDN script failed to load (offline, blocked, etc.) -- keep
    // App.PlanningBoard.mount callable but inert instead of crashing
    // whichever tab's enterTab()/render() calls it.
    window.App.PlanningBoard = { mount() {} };
    return;
  }

  const { html, render, useState, useEffect, useRef } = lib;

  const POOL_GROUP = 'planning-board-pool';

  // Controlled by Pool, NOT its own local state: a plain click on the row
  // ALSO selects natively in MultiDrag (see Pool's onSelect/onDeselect below
  // -- there is no supported way to turn that off without also breaking
  // drag-to-select-then-drag-away, so the checkbox is kept in sync with it
  // rather than fighting it. Both the checkbox and a plain row click are
  // valid, equivalent ways to select -- same as e.g. Gmail's row checkboxes.
  function PoolItem({ item, selected, onToggle }) {
    return html`
      <div class="pb-pool-item" data-pool-item-id=${item.id} data-pool-item-qty=${item.availableQty}>
        <input
          type="checkbox"
          class="pb-pool-item-check"
          checked=${selected}
          onClick=${e => e.stopPropagation()}
          onChange=${e => onToggle(item.id, e.target.checked)}
          aria-label="Select ${item.label} for multi-select drag"
        />
        <div class="pb-pool-item-body">
          <div class="pb-pool-item-label">${item.label}</div>
          ${item.sublabel ? html`<div class="pb-pool-item-sublabel">${item.sublabel}</div>` : null}
        </div>
        <div class="pb-pool-item-qty">${item.availableQty}</div>
      </div>
    `;
  }

  function Pool({ pool }) {
    const listRef = useRef(null);
    const [search, setSearch] = useState('');
    const [selectedIds, setSelectedIds] = useState(() => new Set());

    useEffect(() => {
      if (!listRef.current || !window.Sortable) return undefined;
      const sortable = window.Sortable.create(listRef.current, {
        group: { name: POOL_GROUP, pull: 'clone', put: false },
        sort: false,
        multiDrag: true,
        selectedClass: 'pb-selected',
        animation: 150,
        fallbackTolerance: 3,
        forceFallback: true,
        // No multiDragKey: confirmed against the actual plugin source that
        // it does NOT gate whether a plain click selects at all (a click
        // always does) -- it only gates whether that click clears any prior
        // selection first. Leaving it unset means every click (row OR
        // checkbox) just toggles that one item and leaves the rest alone,
        // matching a checkbox's own natural "accumulate" semantics.
        // The checkbox (and anything else interactive) must not itself be
        // treated as a drag handle -- without this, pressing and slightly
        // moving the mouse on it starts a drag instead of toggling it.
        // preventOnFilter:false keeps the browser's own click-to-toggle
        // behavior on the filtered element intact.
        filter: 'input, button',
        preventOnFilter: false,
        // Fires when MultiDrag selects/deselects an item via ITS OWN native
        // click handling (i.e. the user clicked the row, not the checkbox --
        // Sortable.utils.select/deselect, which the checkbox calls directly
        // below, do NOT fire these) -- keeps this component's own
        // selectedIds (and so the checkbox's checked state) in sync either
        // way, since multiDragElements is the one real source of truth.
        onSelect(evt) {
          const id = evt.item && evt.item.getAttribute('data-pool-item-id');
          if (id) setSelectedIds(prev => new Set(prev).add(id));
        },
        onDeselect(evt) {
          const id = evt.item && evt.item.getAttribute('data-pool-item-id');
          if (id) setSelectedIds(prev => { const next = new Set(prev); next.delete(id); return next; });
        },
      });
      return () => sortable.destroy();
    }, []);

    // A new search deliberately resets any in-progress selection rather
    // than risk a filtered-out (unmounted) item staying selected in
    // Sortable's own tracking with no rendered node behind it. Walks
    // selectedIds (this component's own state, not Sortable's DOM-class
    // side effect) to find which elements to deselect -- selectedIds is
    // already kept authoritative either way (see onSelect/onDeselect and
    // handleToggle above).
    useEffect(() => {
      if (!listRef.current || !window.Sortable || !selectedIds.size) return;
      Array.from(listRef.current.children)
        .filter(child => child.getAttribute && selectedIds.has(child.getAttribute('data-pool-item-id')))
        .forEach(el => window.Sortable.utils.deselect(el));
      setSelectedIds(new Set());
      // Deliberately [search] only, not [search, selectedIds] -- this must
      // fire on a search change, not on every selection change (which would
      // just immediately re-clear whatever the checkbox/row click just set).
    }, [search]);

    const handleToggle = (id, checked) => {
      setSelectedIds(prev => {
        const next = new Set(prev);
        if (checked) next.add(id); else next.delete(id);
        return next;
      });
      const el = listRef.current
        && Array.from(listRef.current.children).find(child => child.getAttribute && child.getAttribute('data-pool-item-id') === id);
      if (el && window.Sortable) {
        if (checked) window.Sortable.utils.select(el);
        else window.Sortable.utils.deselect(el);
      }
    };

    const filtered = search.trim()
      ? pool.filter(item => App.Utils.matchesKeywords(`${item.label} ${item.sublabel || ''}`, search))
      : pool;

    return html`
      <div>
        <input
          type="text"
          class="pb-pool-search"
          placeholder="Search products..."
          value=${search}
          onInput=${e => setSearch(e.target.value)}
        />
        <div class="pb-pool-list" ref=${listRef}>
          ${filtered.map(item => html`
            <${PoolItem} key=${item.id} item=${item} selected=${selectedIds.has(item.id)} onToggle=${handleToggle} />
          `)}
          ${!filtered.length ? html`<div class="pb-pool-empty">No matching products.</div>` : null}
        </div>
      </div>
    `;
  }

  function CardLine({ line, onQtyChange, onRemoveLine }) {
    const [qty, setQty] = useState(line.qty);
    useEffect(() => { setQty(line.qty); }, [line.qty]);

    const commit = () => {
      const n = Number(qty);
      if (!Number.isFinite(n) || n <= 0 || n === line.qty) { setQty(line.qty); return; }
      onQtyChange(line.lineId, n);
    };

    return html`
      <div class="pb-card-line ${line.fulfilled ? 'pb-card-line-fulfilled' : ''}">
        <span class="pb-card-line-label">${line.label}</span>
        <input
          type="number"
          class="pb-card-line-qty"
          min="0.001"
          step="any"
          value=${qty}
          disabled=${line.fulfilled}
          onInput=${e => setQty(e.target.value)}
          onBlur=${commit}
          onKeyDown=${e => { if (e.key === 'Enter') { e.preventDefault(); commit(); e.target.blur(); } }}
        />
        ${!line.fulfilled
          // A literal '×', not the &times; entity -- htm does not decode
          // HTML entities in its tagged templates, it would render as text.
          ? html`<button type="button" class="pb-card-line-remove" title="Remove" aria-label="Remove" onClick=${() => onRemoveLine(line.lineId)}>×</button>`
          : html`<span class="pb-card-line-fulfilled-badge">Dispatched</span>`}
      </div>
    `;
  }

  function Card({ card, onDropToCard, onQtyChange, onRemoveLine, onConvertCard, onCancelCard, cardActionLabel }) {
    const listRef = useRef(null);

    useEffect(() => {
      if (!listRef.current || !window.Sortable) return undefined;
      const sortable = window.Sortable.create(listRef.current, {
        group: { name: POOL_GROUP, pull: false, put: true },
        animation: 150,
        onAdd(evt) {
          // Sortable already spliced the dragged clone(s) into this DOM
          // list. Read what landed, hand it to the caller, then throw the
          // DOM mutation away -- the caller's state update (after its own
          // save) drives the real re-render. evt.items covers MultiDrag's
          // multi-item drop; evt.item covers a plain single-item drag.
          const droppedEls = evt.items && evt.items.length ? evt.items : [evt.item];
          const drops = [];
          droppedEls.forEach(el => {
            const poolItemId = el.getAttribute('data-pool-item-id');
            const qty = Number(el.getAttribute('data-pool-item-qty')) || 0;
            if (poolItemId && qty > 0) drops.push({ poolItemId, qty });
            if (el.parentNode) el.parentNode.removeChild(el);
          });
          if (drops.length) onDropToCard(drops, card.id);
        },
      });
      return () => sortable.destroy();
    }, [card.id]);

    return html`
      <div class="pb-card">
        <div class="pb-card-header">
          <span class="pb-card-title">${card.title}</span>
          <div class="pb-card-header-actions">
            ${card.lines.length && onConvertCard
              ? html`<button type="button" class="pb-card-action" onClick=${() => onConvertCard(card.id)}>${cardActionLabel || 'Dispatch'}</button>`
              : null}
            ${onCancelCard
              // A literal '×' -- htm does not decode HTML entities (see CardLine's own note above).
              ? html`<button type="button" class="pb-card-cancel" title="Cancel card" aria-label="Cancel ${card.title}'s card" onClick=${() => onCancelCard(card.id)}>×</button>`
              : null}
          </div>
        </div>
        <div class="pb-card-lines" ref=${listRef}>
          ${card.lines.map(line => html`
            <${CardLine} key=${line.lineId} line=${line} onQtyChange=${onQtyChange} onRemoveLine=${onRemoveLine} />
          `)}
        </div>
        ${!card.lines.length ? html`<div class="pb-card-empty">Drop products here</div>` : null}
      </div>
    `;
  }

  function AddCardForm({ onAddCard }) {
    const [name, setName] = useState('');
    const submit = e => {
      e.preventDefault();
      const trimmed = name.trim();
      if (!trimmed) return;
      onAddCard(trimmed);
      setName('');
    };
    return html`
      <form class="pb-add-card" onSubmit=${submit}>
        <input
          type="text"
          class="pb-add-card-input"
          placeholder="+ New Client..."
          value=${name}
          onInput=${e => setName(e.target.value)}
        />
      </form>
    `;
  }

  function Board(config) {
    const { pool, cards, onDropToCard, onQtyChange, onRemoveLine, onAddCard, onConvertCard, onCancelCard, cardActionLabel, renderNonce } = config;
    return html`
      <div class="pb-board">
        <div class="pb-pool-panel">
          <div class="pb-panel-heading">
            Ready to Dispatch <span class="pb-panel-hint">(check to multi-select, drag onto a card)</span>
          </div>
          <${Pool} key=${renderNonce} pool=${pool} />
        </div>
        <div class="pb-cards-panel">
          <div class="pb-cards-list">
            ${cards.map(card => html`
              <${Card}
                key=${card.id}
                card=${card}
                onDropToCard=${onDropToCard}
                onQtyChange=${onQtyChange}
                onRemoveLine=${onRemoveLine}
                onConvertCard=${onConvertCard}
                onCancelCard=${onCancelCard}
                cardActionLabel=${cardActionLabel}
              />
            `)}
          </div>
          <${AddCardForm} onAddCard=${onAddCard} />
        </div>
      </div>
    `;
  }

  // Confirmed live (not just theoretical): after a multi-item clone-drag off
  // the pool, SortableJS's own DOM manipulation of the SOURCE list during
  // the drag corrupts Preact's next diff for that subtree -- items that
  // _buildPool() has already correctly excluded (their qty was fully
  // consumed by the drop) kept rendering anyway, stale, alongside the
  // correct remaining rows, i.e. visible near-duplicates. The onAdd handler
  // above already defends the DESTINATION (card) side by discarding
  // Sortable's inserted node itself; nothing defended the SOURCE (pool)
  // side, since pull:'clone' was assumed to leave it untouched -- it
  // doesn't, reliably enough to reproduce every time. Rather than chase the
  // exact internal desync, every mount() call gives Pool a new `key`,
  // forcing Preact to fully discard and rebuild that subtree (and its
  // Sortable instance) from scratch instead of trying to diff/patch DOM
  // Sortable already mutated -- same "never trust the DOM Sortable touched,
  // rebuild from the next render" principle as the onAdd handler, just
  // applied preventatively instead of reactively. Selection resets on any
  // refresh as a result (search changes already do the same, deliberately).
  let renderNonce = 0;

  window.App.PlanningBoard = {
    mount(container, config) {
      if (!container) return;
      renderNonce += 1;
      render(html`<${Board} ...${config} renderNonce=${renderNonce} />`, container);
    },
  };
})();
