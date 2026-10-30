'use strict';
// lot-reference.js -- the optional Lot Reference on the Log Production Lot
// form (migration 057). App.LotRef is the field: a searchable dropdown of the
// lots related to the chosen process, and a link to each lot picked -- only a
// link, so the field stays small (the owner, 2026-10-30). App.LotPanel shows a
// lot beside the form when its link is clicked. Which lots are related, and
// which date a lot shows, is decided in lot_reference_service.py, so this and
// the phone (MApp.LotRef, mobile.js) agree.

const LOT_STATUS_BADGE = {
  Pending: 'bg-secondary',
  'In Progress': 'bg-primary',
  Completed: 'bg-success',
  Cancelled: 'bg-danger'
};

App.LotRef = {
  _seq: 0,
  // Every lot on screen, by rowIdx: the dropdown's, and what is connected.
  _lots: new Map(),
  // rowIdx of each connected lot, in the order they were connected.
  _picked: [],

  _part(selector) {
    return document.querySelector(`#productionLotRefSection ${selector}`);
  },

  _destroySelect() {
    const select = this._part('.lot-ref-select');
    if (select && window.jQuery?.fn?.select2 && window.jQuery(select).data('select2')) {
      // The same <select> is reused for every process, and destroy leaves
      // handlers added from outside behind.
      window.jQuery(select).off('.lotRef').select2('destroy');
    }
    return select;
  },

  // No field at all, and nothing sent: while the hidden input is disabled the
  // form leaves lotRefs out, and the server leaves the lot's connections
  // alone. That is what stops a failed load from wiping them.
  reset() {
    this._seq++;
    this._lots = new Map();
    this._picked = [];
    this._destroySelect();
    const section = document.getElementById('productionLotRefSection');
    if (section) section.style.display = 'none';
    const input = document.getElementById('productionLotRefs');
    if (input) {
      input.value = '[]';
      input.disabled = true;
    }
    App.LotPanel.close();
  },

  // Called with the process picked, and with the lot being edited. Awaited by
  // openEditModal, before Nav's snapshot, so that a lot's saved connections
  // don't read as an unsaved edit.
  async load(processId, rowIdx) {
    this.reset();
    if (!processId) return;
    const seq = this._seq;
    let data = null;
    try {
      const res = await Api.call('getRelatedLots', processId, rowIdx || null);
      if (seq !== this._seq) return;
      if (res && res.success) data = res.data;
    } catch {
      if (seq !== this._seq) return;
    }

    const section = document.getElementById('productionLotRefSection');
    if (!section) return;
    if (!data) {
      section.style.display = '';
      this._fillSelect([], 'Could not load lots. The lot can still be saved.');
      return;
    }
    // Sequence 1: nothing comes before it.
    if (!data.applicable) return;

    data.references.forEach(lot => this._lots.set(lot.rowIdx, lot));
    data.lots.forEach(lot => this._lots.set(lot.rowIdx, lot));
    this._picked = data.references.map(lot => lot.rowIdx);
    const input = document.getElementById('productionLotRefs');
    input.value = JSON.stringify(this._picked);
    input.disabled = false;

    section.style.display = '';
    const scope = [data.model, data.size].filter(v => v && v !== 'General').join(' ');
    this._part('.lot-ref-scope').textContent = [`Stage ${data.sequence}`, scope].filter(Boolean).join(', ');
    this._fillSelect(data.lots, data.lots.length ? 'Search by lot number...' : 'No related lots');
    this._renderConnected();
  },

  _optionText(lot) {
    const parts = [lot.lotNumber, lot.outputItemName];
    if (lot.status !== 'Completed') parts.push(lot.status);
    parts.push(`${lot.dateLabel} ${lot.date}`);
    return parts.join(' · ');
  },

  _fillSelect(lots, prompt) {
    const select = this._destroySelect();
    select.innerHTML = `<option value="">${escapeHtml(prompt)}</option>` + lots.map(lot =>
      `<option value="${lot.rowIdx}">${escapeHtml(this._optionText(lot))}</option>`
    ).join('');
    select.disabled = lots.length === 0;

    if (!window.jQuery?.fn?.select2) return;
    window.jQuery(select).select2({
      placeholder: prompt,
      width: '100%',
      matcher: (params, option) => this._matches(params, option),
      dropdownParent: App.Utils.select2DropdownParent(select)
    }).on('select2:select.lotRef', ev => {
      this.connect(Number(ev.params.data.id));
      window.jQuery(select).val(null).trigger('change.select2');
    });
  },

  // A connected lot leaves the list, as it does on the phone. Disabling its
  // <option> does nothing here: Select2 keeps the copy it read first.
  _matches(params, option) {
    return this._picked.includes(Number(option.id)) ? null : App.Utils.select2Matcher(params, option);
  },

  connect(rowIdx) {
    if (!rowIdx || this._picked.includes(rowIdx)) return;
    this._picked.push(rowIdx);
    this._afterChange();
  },

  disconnect(rowIdx) {
    this._picked = this._picked.filter(id => id !== rowIdx);
    this._afterChange();
  },

  _afterChange() {
    document.getElementById('productionLotRefs').value = JSON.stringify(this._picked);
    this._renderConnected();
  },

  _renderConnected() {
    const list = this._part('.lot-ref-list');
    if (!list) return;
    list.innerHTML = this._picked.map(rowIdx => this._link(this._lots.get(rowIdx) || { rowIdx })).join('');
  },

  // Just the lot number. What the lot is, and when it was done, open in the
  // side window when someone asks; the form gives them no room of its own.
  _link(lot) {
    const number = escapeHtml(lot.lotNumber || `#${lot.rowIdx}`);
    const link = lot.deleted
      ? `<span class="lot-ref-link lot-ref-deleted" title="This lot was deleted">${number}</span>`
      : `<button type="button" class="lot-ref-link" title="View ${number}" onclick="App.LotPanel.open(${lot.rowIdx})">${number}</button>`;
    return `<span class="lot-ref-chip">${link}<button type="button" class="btn-close" aria-label="Remove ${number}" onclick="App.LotRef.disconnect(${lot.rowIdx})"></button></span>`;
  }
};

// ── A lot, beside the form ─────────────────────────────────────────────
// Read-only. Mounted inside the form's dialog for the reason App.PhotoViewer
// is (core.js): Bootstrap's focus trap pulls focus back out of anything
// outside it. It is not a dialog of its own: from 992px the form narrows
// beside it and stays usable (.lot-panel-open, styles.css). Escape closes
// only this, and no key pressed in here reaches the form's Nav shortcuts.
App.LotPanel = {
  _el: null,
  _seq: 0,
  // The lots walked through, newest last: Back returns along it.
  _trail: [],
  _returnFocus: null,

  _dialog() {
    return document.getElementById('editProductionModal');
  },

  isOpen() {
    return !!this._el && !this._el.hidden;
  },

  open(rowIdx) {
    const dialog = this._dialog();
    if (!dialog) return;
    if (!this._el) this._el = this._build(dialog);
    if (!this.isOpen()) this._returnFocus = document.activeElement;
    this._trail = [rowIdx];
    this._el.hidden = false;
    dialog.classList.add('lot-panel-open');
    this._show();
    this._el.querySelector('.lot-panel-close').focus();
  },

  // To a lot listed in the panel, keeping the way back.
  walk(rowIdx) {
    this._trail.push(rowIdx);
    this._show();
  },

  back() {
    if (this._trail.length < 2) return;
    this._trail.pop();
    this._show();
  },

  close() {
    if (!this.isOpen()) return;
    this._seq++;
    this._el.hidden = true;
    this._dialog()?.classList.remove('lot-panel-open');
    if (this._returnFocus && this._returnFocus.isConnected) this._returnFocus.focus();
    this._returnFocus = null;
  },

  _build(dialog) {
    const el = document.createElement('aside');
    el.className = 'lot-panel';
    el.hidden = true;
    el.setAttribute('aria-label', 'Lot details');
    el.innerHTML = `
      <div class="lot-panel-bar">
        <button type="button" class="btn btn-light btn-sm lot-panel-back" hidden><i class="bi bi-arrow-left me-1"></i>Back</button>
        <span class="lot-panel-title"></span>
        <button type="button" class="btn-close lot-panel-close" aria-label="Close"></button>
      </div>
      <div class="lot-panel-body"></div>`;
    el.querySelector('.lot-panel-close').addEventListener('click', () => this.close());
    el.querySelector('.lot-panel-back').addEventListener('click', () => this.back());
    el.addEventListener('keydown', ev => {
      ev.stopPropagation();
      if (ev.key === 'Escape') this.close();
    });
    // Escape with focus still in the form: the panel goes first, not the
    // form and whatever was typed into it. An open dropdown goes before
    // either (core.js).
    dialog.addEventListener('keydown', ev => {
      if (ev.key !== 'Escape' || !this.isOpen()) return;
      ev.stopPropagation();
      this.close();
    }, true);
    dialog.addEventListener('hidden.bs.modal', () => this.close());
    dialog.appendChild(el);
    return el;
  },

  async _show() {
    const rowIdx = this._trail[this._trail.length - 1];
    const seq = ++this._seq;
    const body = this._el.querySelector('.lot-panel-body');
    this._el.querySelector('.lot-panel-title').textContent = 'Lot';
    this._el.querySelector('.lot-panel-back').hidden = this._trail.length < 2;
    body.innerHTML = '<div class="text-muted small">Loading…</div>';
    body.scrollTop = 0;

    let res;
    try {
      res = await Api.call('getLotDetail', rowIdx);
    } catch (err) {
      res = { success: false, message: err.message };
    }
    if (seq !== this._seq) return;
    if (!res || !res.success) {
      body.innerHTML = `<div class="text-danger small">${escapeHtml((res && res.message) || 'This lot could not be loaded.')}</div>`;
      return;
    }
    this._el.querySelector('.lot-panel-title').textContent = res.data.lot.lotNumber;
    body.innerHTML = this._html(res.data);
  },

  _fact(label, value) {
    return value === '' || value === null || value === undefined
      ? ''
      : `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
  },

  _lotRow(lot) {
    const facts = [
      lot.processType || lot.processName,
      lot.status && lot.status !== 'Completed' ? lot.status : '',
      `${lot.dateLabel} ${lot.date}`
    ].filter(Boolean).map(escapeHtml).join(' · ');
    return lot.deleted
      ? `<div class="lot-panel-lot"><span class="fw-bold">${escapeHtml(lot.lotNumber)}</span> <span class="badge bg-secondary">Deleted</span><div class="small text-muted">${facts}</div></div>`
      : `<button type="button" class="lot-panel-lot" onclick="App.LotPanel.walk(${lot.rowIdx})"><span class="fw-bold">${escapeHtml(lot.lotNumber)}</span><div class="small text-muted">${facts}</div></button>`;
  },

  _html({ lot, receipts, references }) {
    const status = LOT_STATUS_BADGE[lot.status] || 'bg-secondary';
    const facts = [
      this._fact('Process', lot.processName),
      this._fact('Stage', lot.sequence),
      this._fact('Lot date', lot.lotDate),
      this._fact('Completed', lot.completedOn),
      this._fact('Assigned to', lot.assignedTo),
      this._fact('Quantity', formatQty(lot.qty)),
      lot.receivedQty ? this._fact('Received', formatQty(lot.receivedQty)) : '',
      lot.balanceQty ? this._fact('Balance', formatQty(lot.balanceQty)) : '',
      this._fact('Colours', lot.colors.join(', '))
    ].join('');
    const receiptRows = receipts.map(r =>
      `<tr><td>${escapeHtml(r.date)}</td><td class="text-end">${escapeHtml(formatQty(r.qty))}</td><td>${escapeHtml(r.byName)}</td></tr>`
    ).join('');
    const materialRows = lot.materials.map(m =>
      `<tr><td>${escapeHtml([m.itemName, m.size].filter(Boolean).join(' '))}${m.color && m.color !== 'COMMON' ? `<div class="small text-muted">${escapeHtml(m.color)}</div>` : ''}</td><td class="text-end">${escapeHtml([formatQty(m.qty), m.unit].filter(Boolean).join(' '))}</td></tr>`
    ).join('');

    return `
      <div class="mb-2"><span class="badge ${status}">${escapeHtml(lot.status)}</span></div>
      <div class="small mb-2">${escapeHtml(lot.outputItemName)}</div>
      <dl class="lot-panel-facts">${facts}</dl>
      ${references.length ? `<h6>Connected lots</h6>${references.map(l => this._lotRow(l)).join('')}` : ''}
      ${receiptRows ? `<h6>Received</h6><table class="table table-sm mb-0"><tbody>${receiptRows}</tbody></table>` : ''}
      ${materialRows ? `<h6>Materials</h6><table class="table table-sm mb-0"><tbody>${materialRows}</tbody></table>` : ''}
      ${lot.remarks ? `<h6>Remarks</h6><div class="small">${escapeHtml(lot.remarks)}</div>` : ''}`;
  }
};
