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

  function PoolItem({ item }) {
    return html`
      <div class="pb-pool-item" data-pool-item-id=${item.id} data-pool-item-qty=${item.availableQty}>
        <div class="pb-pool-item-label">${item.label}</div>
        ${item.sublabel ? html`<div class="pb-pool-item-sublabel">${item.sublabel}</div>` : null}
        <div class="pb-pool-item-qty">${item.availableQty}</div>
      </div>
    `;
  }

  function Pool({ pool }) {
    const listRef = useRef(null);

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
      });
      return () => sortable.destroy();
    }, []);

    return html`
      <div class="pb-pool-list" ref=${listRef}>
        ${pool.map(item => html`<${PoolItem} key=${item.id} item=${item} />`)}
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

  function Card({ card, onDropToCard, onQtyChange, onRemoveLine, onConvertCard, cardActionLabel }) {
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
          ${card.lines.length && onConvertCard
            ? html`<button type="button" class="pb-card-action" onClick=${() => onConvertCard(card.id)}>${cardActionLabel || 'Dispatch'}</button>`
            : null}
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
    const { pool, cards, onDropToCard, onQtyChange, onRemoveLine, onAddCard, onConvertCard, cardActionLabel } = config;
    return html`
      <div class="pb-board">
        <div class="pb-pool-panel">
          <div class="pb-panel-heading">
            Ready to Dispatch <span class="pb-panel-hint">(click to multi-select, drag onto a card)</span>
          </div>
          <${Pool} pool=${pool} />
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
                cardActionLabel=${cardActionLabel}
              />
            `)}
          </div>
          <${AddCardForm} onAddCard=${onAddCard} />
        </div>
      </div>
    `;
  }

  window.App.PlanningBoard = {
    mount(container, config) {
      if (!container) return;
      render(html`<${Board} ...${config} />`, container);
    },
  };
})();
