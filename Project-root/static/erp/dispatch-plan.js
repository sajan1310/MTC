'use strict';
// dispatch-plan.js -- App.DispatchPlan, the Dispatch-specific glue between
// App.PlanningBoard (generic, see planning-board.js) and the Dispatch
// Plan RPCs (dispatch_service.py: getDispatchPlans/saveDispatchPlanLine/
// deleteDispatchPlanLine). Keeps ALL Dispatch-specific naming/mapping in
// this file so planning-board.js stays reusable for Production planning
// later.
//
// Data shapes:
// - App.State.globalDispatchPlans: FLAT array of plan lines (mirrors how
//   globalDispatch is flat and dispatch.js's buildDispatchBills groups it
//   client-side) -- grouped here into per-client cards by _buildCards().
// - App.State.globalReadyToDispatch (already loaded by App.Dispatch) drives
//   the pool: availableToPlan (server-computed, see dispatch_service.
//   get_ready_to_dispatch_data) is what caps what a card can accept.
//
// "Empty" cards (added via the board's own "+ New Client..." form before
// any product has been dropped on them) have no backing plan line yet, so
// they can't come from grouping App.State.globalDispatchPlans -- tracked
// in _pendingEmptyCards here, purely client-side, until their first drop
// makes them real.
App.DispatchPlan = {
  _pendingEmptyCards: new Set(),

  async loadData() {
    const res = await Api.call('getDispatchPlans');
    if (res.success) App.State.globalDispatchPlans = res.data;
    else App.Utils.showToast(res.message, true);
  },

  // Called once after loadData()/loadReadyData() both resolve (see
  // App.Dispatch.enterTab). Safe to call again (e.g. on switchSubTab) --
  // idempotent, just re-renders from current state.
  init() {
    if (!App.State.dispatchPlanDate) App.State.dispatchPlanDate = tomorrowIso();
    this._wireDateInput();
    this.render();
  },

  _wireDateInput() {
    const input = document.getElementById('dispatchPlanDate');
    if (!input) return;
    input.value = App.State.dispatchPlanDate;
    if (input.dataset.wired) return;
    input.dataset.wired = '1';
    input.addEventListener('change', () => {
      App.State.dispatchPlanDate = input.value || tomorrowIso();
      this._pendingEmptyCards.clear();
      this.render();
    });
  },

  // One pool entry per productId (not per differentiated Ready to Dispatch
  // row -- a plan line, like a dispatch line, can't record which color
  // variant it's for either, see dispatch_service._ready_product_name).
  // availableToPlan is already pooled per productId server-side, so every
  // differentiated row for the same productId reports the same number.
  _buildPool() {
    const byProduct = new Map();
    (App.State.globalReadyToDispatch || []).forEach(r => {
      if (!byProduct.has(r.productId)) {
        // An untagged final-stage output reports its Output Item Name as
        // BOTH productId and productName (see dispatch_service's
        // _compute_ready_to_dispatch_map) -- showing the id underneath
        // would just repeat the label, so it's only a sublabel when it
        // genuinely differs (a real Product Tag).
        const sublabel = r.productId === r.productName ? '' : r.productId;
        byProduct.set(r.productId, {
          id: r.productId,
          label: r.productName,
          sublabel,
          availableQty: r.availableToPlan != null ? r.availableToPlan : r.readyQty,
        });
      }
    });
    return Array.from(byProduct.values()).filter(item => item.availableQty > 0);
  },

  _buildCards() {
    const date = App.State.dispatchPlanDate;
    const byClient = new Map();
    (App.State.globalDispatchPlans || [])
      .filter(l => l.planDate === date)
      .forEach(line => {
        if (!byClient.has(line.clientName)) byClient.set(line.clientName, []);
        byClient.get(line.clientName).push({
          lineId: line.lineId,
          label: `${line.productName} (${line.productId})`,
          qty: line.qty,
          fulfilled: line.fulfilled,
        });
      });
    this._pendingEmptyCards.forEach(name => {
      if (!byClient.has(name)) byClient.set(name, []);
    });
    return Array.from(byClient.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([clientName, lines]) => ({ id: clientName, title: clientName, lines }));
  },

  render() {
    const container = document.getElementById('dispatchPlanRoot');
    if (!container || !window.App.PlanningBoard) return;
    App.PlanningBoard.mount(container, {
      pool: this._buildPool(),
      cards: this._buildCards(),
      cardActionLabel: 'Dispatch',
      onDropToCard: (drops, cardId) => this._handleDrop(drops, cardId),
      onQtyChange: (lineId, qty) => this._handleQtyChange(lineId, qty),
      onRemoveLine: (lineId) => this._handleRemoveLine(lineId),
      onAddCard: (title) => this._handleAddCard(title),
      onConvertCard: (cardId) => this._handleConvertCard(cardId),
    });
  },

  // Sequential, not parallel -- each save's own availableToPlan guard must
  // see the previous drop's commit, or two items dropped in the same
  // multi-select gesture could both pass a check against the same
  // not-yet-decremented pool.
  async _handleDrop(drops, clientName) {
    const date = App.State.dispatchPlanDate;
    const readyByProduct = new Map((App.State.globalReadyToDispatch || []).map(r => [r.productId, r]));
    for (const drop of drops) {
      const ready = readyByProduct.get(drop.poolItemId);
      const productName = ready ? ready.productName : drop.poolItemId;
      const res = await Api.mutate('saveDispatchPlanLine', {
        planDate: date,
        clientName,
        productId: drop.poolItemId,
        productName,
        qty: drop.qty,
        sortOrder: 0,
      });
      if (!res.success) App.Utils.showToast(res.message, true);
    }
    this._pendingEmptyCards.delete(clientName);
    await this._reload();
  },

  async _handleQtyChange(lineId, qty) {
    const line = (App.State.globalDispatchPlans || []).find(l => l.lineId === lineId);
    if (!line) return;
    const res = await Api.mutate('saveDispatchPlanLine', {
      lineId,
      planDate: line.planDate,
      clientName: line.clientName,
      productId: line.productId,
      productName: line.productName,
      qty,
      sortOrder: line.sortOrder,
    });
    if (!res.success) App.Utils.showToast(res.message, true);
    await this._reload();
  },

  async _handleRemoveLine(lineId) {
    const res = await Api.mutate('deleteDispatchPlanLine', lineId);
    if (!res.success) App.Utils.showToast(res.message, true);
    await this._reload();
  },

  _handleAddCard(title) {
    this._pendingEmptyCards.add(title);
    this.render();
  },

  _handleConvertCard(clientName) {
    const date = App.State.dispatchPlanDate;
    const lines = (App.State.globalDispatchPlans || [])
      .filter(l => l.planDate === date && l.clientName === clientName && !l.fulfilled);
    if (!lines.length) return;
    const sourcePlanLineIds = lines.map(l => l.lineId);
    const modalLines = lines.map(l => ({ productId: l.productId, qty: l.qty }));
    App.Dispatch.openPrefilledDispatchModal(clientName, modalLines, sourcePlanLineIds);
  },

  async _reload() {
    await Promise.all([this.loadData(), App.Dispatch.loadReadyData()]);
    this.render();
  },
};
