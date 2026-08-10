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
        if (!byClient.has(line.clientName)) byClient.set(line.clientName, { transport: line.transport || '', lines: [] });
        // An untagged final-stage output reports its Output Item Name as
        // BOTH productId and productName (see _buildPool's own identical
        // check) -- appending "(productId)" would just repeat the name.
        const label = line.productId === line.productName
          ? line.productName
          : `${line.productName} (${line.productId})`;
        byClient.get(line.clientName).lines.push({
          lineId: line.lineId,
          label,
          qty: line.qty,
          rate: line.rate,
          remarks: line.remarks,
          fulfilled: line.fulfilled,
        });
      });
    this._pendingEmptyCards.forEach(name => {
      if (!byClient.has(name)) byClient.set(name, { transport: '', lines: [] });
    });
    return Array.from(byClient.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([clientName, data]) => ({ id: clientName, title: clientName, transport: data.transport, lines: data.lines }));
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
      onRateChange: (lineId, rate) => this._handleRateChange(lineId, rate),
      onRemarksChange: (lineId, remarks) => this._handleRemarksChange(lineId, remarks),
      onRemoveLine: (lineId) => this._handleRemoveLine(lineId),
      onTransportChange: (cardId, transport) => this._handleTransportChange(cardId, transport),
      onAddCard: (title) => this._handleAddCard(title),
      onConvertCard: (cardId) => this._handleConvertCard(cardId),
      onCancelCard: (cardId) => this._handleCancelCard(cardId),
    });
  },

  // Sequential, not parallel -- each save's own availableToPlan guard must
  // see the previous drop's commit, or two items dropped in the same
  // multi-select gesture could both pass a check against the same
  // not-yet-decremented pool.
  async _handleDrop(drops, clientName) {
    const date = App.State.dispatchPlanDate;
    const readyByProduct = new Map((App.State.globalReadyToDispatch || []).map(r => [r.productId, r]));
    // A new line dropped onto a card that already has a Transport value
    // set inherits it -- Transport is presented as ONE shared field per
    // card, so a freshly-dropped line shouldn't silently start blank while
    // its siblings already carry a value.
    const existingLine = (App.State.globalDispatchPlans || [])
      .find(l => l.planDate === date && l.clientName === clientName);
    const transport = existingLine ? existingLine.transport : '';
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
        transport,
      });
      if (!res.success) App.Utils.showToast(res.message, true);
    }
    this._pendingEmptyCards.delete(clientName);
    await this._reload();
  },

  _lineSavePayload(line, overrides) {
    return Object.assign({
      lineId: line.lineId,
      planDate: line.planDate,
      clientName: line.clientName,
      productId: line.productId,
      productName: line.productName,
      qty: line.qty,
      sortOrder: line.sortOrder,
      rate: line.rate,
      remarks: line.remarks,
      transport: line.transport,
    }, overrides);
  },

  // Shared by every single-field edit below (qty/rate/remarks) --
  // saveDispatchPlanLine is a full UPDATE, not a partial patch, so every
  // call must resend every column via _lineSavePayload or an edit to ONE
  // field (e.g. qty) would silently reset the others (e.g. rate) to their
  // defaults.
  async _saveLineField(lineId, overrides) {
    const line = (App.State.globalDispatchPlans || []).find(l => l.lineId === lineId);
    if (!line) return;
    const res = await Api.mutate('saveDispatchPlanLine', this._lineSavePayload(line, overrides));
    if (!res.success) App.Utils.showToast(res.message, true);
    await this._reload();
  },

  async _handleQtyChange(lineId, qty) {
    await this._saveLineField(lineId, { qty });
  },

  async _handleRateChange(lineId, rate) {
    await this._saveLineField(lineId, { rate });
  },

  async _handleRemarksChange(lineId, remarks) {
    await this._saveLineField(lineId, { remarks });
  },

  // Transport is ONE shared field per card, denormalized across every one
  // of its lines (see migration 029) -- editing it updates all of them
  // together. No-op on a pending/empty card: there's nothing to persist
  // a value onto yet, it'll be picked up by _handleDrop's own inherit
  // logic once the card's first line actually exists.
  async _handleTransportChange(clientName, transport) {
    const date = App.State.dispatchPlanDate;
    const lines = (App.State.globalDispatchPlans || [])
      .filter(l => l.planDate === date && l.clientName === clientName && !l.fulfilled);
    if (!lines.length) return;
    const results = await Promise.all(
      lines.map(line => Api.mutate('saveDispatchPlanLine', this._lineSavePayload(line, { transport })))
    );
    const failed = results.find(r => !r.success);
    if (failed) App.Utils.showToast(failed.message, true);
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
    // rate: an untouched (0) rate stays UNDEFINED, not 0 -- addDispatchLineRow
    // renders undefined/null as a blank, optional field (matching the real
    // bill's own placeholder="optional"); an explicit 0 would render as a
    // literal "0" in every line the operator never bothered pricing.
    const modalLines = lines.map(l => ({ productId: l.productId, qty: l.qty, rate: l.rate || undefined }));
    const transport = lines[0].transport || '';
    // The real bill has ONE Remarks field (header-level); the plan has one
    // PER LINE. A single line's remarks carries over as-is; more than one
    // distinct remark gets prefixed by product name so the operator can
    // still tell them apart, as a starting point they can edit further.
    const withRemarks = lines.filter(l => l.remarks);
    const remarks = withRemarks.length <= 1
      ? (withRemarks[0]?.remarks || '')
      : withRemarks.map(l => `${l.productName}: ${l.remarks}`).join('; ');
    App.Dispatch.openPrefilledDispatchModal(clientName, modalLines, sourcePlanLineIds, transport, remarks);
  },

  // A pending (not-yet-saved) empty card just gets dropped locally -- no
  // backend state exists for it yet. A real card's still-open lines are
  // deleted (with confirmation, since this can clear several items at
  // once); any already-fulfilled lines are left alone -- deleteDispatchPlanLine
  // rejects those server-side anyway (see dispatch_service.py), and they're
  // a record of what was actually dispatched, not a draft to discard.
  _handleCancelCard(clientName) {
    const date = App.State.dispatchPlanDate;
    const openLines = (App.State.globalDispatchPlans || [])
      .filter(l => l.planDate === date && l.clientName === clientName && !l.fulfilled);

    if (!openLines.length) {
      this._pendingEmptyCards.delete(clientName);
      this.render();
      return;
    }

    App.Utils.confirmAction(
      `Remove ${clientName}'s plan card? This clears ${openLines.length} item(s) not yet dispatched.`,
      async () => {
        const results = await Promise.all(openLines.map(line => Api.mutate('deleteDispatchPlanLine', line.lineId)));
        const failed = results.find(r => !r.success);
        if (failed) App.Utils.showToast(failed.message, true);
        this._pendingEmptyCards.delete(clientName);
        await this._reload();
      }
    );
  },

  async _reload() {
    await Promise.all([this.loadData(), App.Dispatch.loadReadyData()]);
    this.render();
  },

  // Prints the currently-selected plan date as one consolidated document
  // (one section per client, not one page per client -- most days have
  // several small cards, forcing a page break per client would waste
  // paper). Dispatch Plan has no fixed record shape to pre-declare a
  // dedicated static container for in print.html (client count and line
  // count both vary freely, same situation Production's Work Order is in
  // -- see _buildWorkOrderHtml), so this reuses the shared
  // #print-bulk-container/#print-bulk-body App.Print already exposes for
  // exactly this "dynamically-built, no fixed schema" case, but sets its
  // innerHTML directly instead of going through App.Print.renderBulkPages
  // (that helper forces a page-break after every record, which is the
  // wrong shape for one combined document).
  printPlan() {
    if (typeof App.Print === 'undefined') {
      App.Utils.notPortedYet('Printing');
      return;
    }
    const body = document.getElementById('print-bulk-body');
    if (!body) return;

    const date = App.State.dispatchPlanDate;
    body.innerHTML = this._buildPrintHtml(date, this._buildCards().filter(c => c.lines.length));
    App.Print.trigger('print-bulk-container', `Dispatch Plan - ${date}`);
  },

  // Every text-bearing element below sets its OWN explicit color rather
  // than relying on inheritance, matching _buildWorkOrderHtml's own
  // documented reasoning (production.js) even though this specific path
  // renders into a normally-hidden print.html-style container rather than
  // a live on-page preview -- App.Print.trigger briefly makes it visible
  // in the actual browser window (not just the print dialog) between
  // hideAll() and window.print(), so the same dark-mode-inheritance risk
  // applies for that brief window too.
  _buildPrintHtml(dateIso, cards) {
    const BRAND = '#0D6EFD'; // matches dispatch.js's own Delivery Challan BRAND -- same document family.
    const [y, m, d] = String(dateIso || '').split('-');
    const displayDate = (y && m && d) ? `${d}/${m}/${y}` : (dateIso || '');

    const cardsHtml = cards.length
      ? cards.map(card => `
        <div style="margin-bottom:16px;page-break-inside:avoid;break-inside:avoid;">
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;padding-bottom:3px;border-bottom:1px solid ${BRAND};">
            <span style="font-size:13px;font-weight:700;color:${BRAND};-webkit-print-color-adjust:exact;print-color-adjust:exact;">
              ${escapeHtml(card.title)}
            </span>
            ${card.transport
              ? `<span style="font-size:11px;color:#555;">Transport: <span style="font-weight:700;color:#1a1a1a;">${escapeHtml(card.transport)}</span></span>`
              : ''}
          </div>
          <table style="width:100%;border-collapse:collapse;font-size:12px;">
            <thead style="background-color:${BRAND};color:#fff;text-align:center;font-weight:700;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
              <tr>
                <th style="padding:7px 6px;border:1px solid ${BRAND};width:5%;">#</th>
                <th style="padding:7px 6px;border:1px solid ${BRAND};text-align:left;width:36%;">Product</th>
                <th style="padding:7px 6px;border:1px solid ${BRAND};width:11%;">Qty</th>
                <th style="padding:7px 6px;border:1px solid ${BRAND};width:12%;">Rate</th>
                <th style="padding:7px 6px;border:1px solid ${BRAND};text-align:left;width:22%;">Remarks</th>
                <th style="padding:7px 6px;border:1px solid ${BRAND};width:14%;">Loaded</th>
              </tr>
            </thead>
            <tbody style="color:#1a1a1a;text-align:center;">
              ${card.lines.map((line, idx) => `
                <tr>
                  <td style="padding:7px 6px;border:1px solid #e5e5e5;color:#999;font-weight:600;">${idx + 1}</td>
                  <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:left;font-weight:600;">${escapeHtml(line.label)}</td>
                  <td style="padding:7px 6px;border:1px solid #e5e5e5;font-weight:600;">${escapeHtml(String(line.qty))}</td>
                  <td style="padding:7px 6px;border:1px solid #e5e5e5;">${line.rate ? escapeHtml(String(line.rate)) : '-'}</td>
                  <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:left;">${line.remarks ? escapeHtml(line.remarks) : '-'}</td>
                  <td style="padding:7px 6px;border:1px solid #e5e5e5;">
                    ${line.fulfilled
                      ? `<span style="color:#198754;font-weight:700;-webkit-print-color-adjust:exact;print-color-adjust:exact;">Dispatched</span>`
                      : `<span style="display:inline-block;width:14px;height:14px;border:1px solid #666;"></span>`}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `).join('')
      : `<div style="text-align:center;color:#888;padding:30px 0;">No products planned for this date.</div>`;

    return `
    <div style="background:#fff;color:#1a1a1a;font-family:'Segoe UI',Arial,sans-serif;font-size:12px;line-height:1.5;padding:14px 20px 12px 20px;margin:0;box-sizing:border-box;width:100%;border-top:5px solid ${BRAND};border-bottom:3px solid ${BRAND};-webkit-print-color-adjust:exact;print-color-adjust:exact;">
      <div style="text-align:center;padding:4px 0 8px 0;">
        ${App.Print.brandHeaderHtml(BRAND)}
        <div style="font-size:10px;color:#555;margin-top:3px;letter-spacing:0.3px;">
          6-B, SHIV SHAKTI ESTATE, VERKA CHOWK, DEHLON ROAD, BHAGWANPURA, 141114 LUDHIANA
        </div>
        <div style="font-size:10px;color:#555;margin-top:2px;letter-spacing:0.3px;">
          Ph : 86996-42398, 91546-94000, 94170-42398 &nbsp;|&nbsp; E-mail : maharaja.bikes@gmail.com
          &nbsp;&nbsp; GSTIN : 03AFIPS4089J1Z1
        </div>
      </div>
      <div style="height:2px;background:${BRAND};margin:0 0 12px 0;-webkit-print-color-adjust:exact;print-color-adjust:exact;"></div>

      <div style="text-align:center;margin-bottom:14px;">
        <span style="font-size:18px;font-weight:800;color:${BRAND};letter-spacing:3px;text-transform:uppercase;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
          Dispatch Plan
        </span>
        <div style="font-size:13px;font-weight:700;color:#1a1a1a;margin-top:4px;">${escapeHtml(displayDate)}</div>
      </div>
      <div style="height:1px;background:#bbb;margin-bottom:14px;"></div>

      ${cardsHtml}

      <div style="display:flex;justify-content:flex-end;margin-top:10px;page-break-inside:avoid;break-inside:avoid;">
        <div style="width:180px;text-align:center;padding-top:5px;border-top:2px solid ${BRAND};-webkit-print-color-adjust:exact;print-color-adjust:exact;">
          <span style="font-size:10px;color:#666;letter-spacing:0.5px;font-style:italic;">Authorized Signatory</span>
        </div>
      </div>
    </div>`;
  },
};
