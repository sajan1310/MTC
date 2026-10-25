'use strict';
// inspection.js -- App.Inspection, the desktop side of lot inspection:
// Production > Inspections lists what inspectors have done, opens one lot's
// checklist read-only, and lets an admin send a flagged lot back for
// re-inspection once it has been changed. Inspectors check and clear lots
// in the phone app (MApp.Inspection, mobile.js). Every rule -- what the
// checklist is, which checks survive an edit to the lot, when a lot may be
// cleared -- lives in app/erp/services/inspection_service.py.

const INSPECTION_STATES = {
  '': ['bg-secondary-subtle text-secondary-emphasis', 'Not started'],
  in_progress: ['bg-primary-subtle text-primary-emphasis', 'In inspection'],
  flagged: ['bg-warning-subtle text-warning-emphasis', 'Flagged for admin'],
  cleared: ['bg-success-subtle text-success-emphasis', 'Inspected']
};

const INSPECTION_LOT_STATUS = {
  Pending: 'bg-secondary',
  'In Progress': 'bg-primary',
  Completed: 'bg-success',
  Cancelled: 'bg-danger'
};

// Flagged first: those are waiting on an admin.
const INSPECTION_RANK = { flagged: 0, in_progress: 1, '': 2, cleared: 3 };

App.Inspection = {
  _lots: [],
  _filter: 'attention',
  _search: '',
  _current: null,
  _seq: 0,

  async load() {
    const tbody = document.getElementById('inspectionsTableBody');
    if (tbody) App.Utils.tableLoading(tbody, 8, 'Loading inspections…');
    try {
      // callFresh: an admin pressing Refresh wants what the floor did a
      // moment ago, not the read cache's last answer.
      const res = await Api.callFresh('getInspectionLots');
      if (!res?.success) {
        App.Utils.showToast(res?.message || 'Failed to load inspections.', true);
        if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="text-center p-4 text-danger">Failed to load inspections.</td></tr>';
        return;
      }
      this._lots = res.data || [];
      this.render();
    } catch (err) {
      App.Utils.tableError(tbody, err && err.message, () => App.Inspection.load());
    }
  },

  setFilter(value) {
    this._filter = value || 'attention';
    this.render();
  },

  onSearch(value) {
    this._search = String(value || '').trim().toLowerCase();
    this.render();
  },

  _state(lot) {
    return (lot.inspection || {}).status || '';
  },

  _visible() {
    const keep = {
      attention: lot => ['flagged', 'in_progress'].includes(this._state(lot)),
      flagged: lot => this._state(lot) === 'flagged',
      notStarted: lot => this._state(lot) === '',
      cleared: lot => this._state(lot) === 'cleared',
      all: () => true
    }[this._filter] || (() => true);
    // Every word must appear somewhere, in any field -- the phone's grammar.
    const words = this._search.split(/\s+/).filter(Boolean);
    return this._lots
      .map((lot, i) => ({ lot, i }))
      .filter(({ lot }) => keep(lot))
      .filter(({ lot }) => {
        const insp = lot.inspection || {};
        const hay = [lot.lotNumber, lot.processName, lot.outputItemName, lot.date, lot.status,
          insp.remarks, insp.clearedByName, insp.flaggedByName].join(' ').toLowerCase();
        return words.every(w => hay.includes(w));
      })
      .sort((a, b) => (INSPECTION_RANK[this._state(a.lot)] - INSPECTION_RANK[this._state(b.lot)]) || (a.i - b.i))
      .map(({ lot }) => lot);
  },

  _when(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  },

  _stateBadge(insp) {
    const [cls, label] = INSPECTION_STATES[insp.status || ''] || INSPECTION_STATES[''];
    const changed = insp.changedSinceCleared
      ? '<br><span class="badge bg-warning text-dark mt-1">Sheet changed since</span>' : '';
    return `<span class="badge ${cls}">${escapeHtml(label)}</span>${changed}`;
  },

  render() {
    const tbody = document.getElementById('inspectionsTableBody');
    const empty = document.getElementById('inspectionsEmptyState');
    if (!tbody) return;
    const rows = this._visible();
    if (!rows.length) {
      tbody.innerHTML = '';
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';

    tbody.innerHTML = rows.map(lot => {
      const insp = lot.inspection || {};
      const s = insp.summary || {};
      const recheck = (s.revised || 0) + (s.added || 0);
      const by = insp.clearedByName || insp.flaggedByName || '';
      const remarks = String(insp.remarks || '');
      return `<tr>
        <td><strong>${escapeHtml(lot.lotNumber)}</strong><br><span class="text-muted small">${escapeHtml(lot.date)}</span></td>
        <td>${escapeHtml(lot.processName)}<br><span class="text-muted small">${escapeHtml(lot.outputItemName)}</span></td>
        <td class="text-center"><span class="badge ${INSPECTION_LOT_STATUS[lot.status] || 'bg-secondary'}">${escapeHtml(lot.status)}</span></td>
        <td>${this._stateBadge(insp)}</td>
        <td class="text-end text-nowrap">${toNumber(s.checked)}/${toNumber(s.total, lot.itemCount)}${s.failed ? `<br><span class="text-danger small">${toNumber(s.failed)} failed</span>` : ''}${recheck ? `<br><span class="text-warning-emphasis small">${recheck} to re-check</span>` : ''}</td>
        <td class="small">${escapeHtml(remarks.length > 140 ? `${remarks.slice(0, 140)}…` : remarks)}</td>
        <td class="small text-nowrap">${escapeHtml(this._when(lot.lastUpdated))}${by ? `<br><span class="text-muted">by ${escapeHtml(by)}</span>` : ''}</td>
        <td class="text-center"><button type="button" class="btn btn-sm btn-outline-dark btn-action" onclick="App.Inspection.openDetail(${toNumber(lot.rowIdx)})">View</button></td>
      </tr>`;
    }).join('');
  },

  async openDetail(rowIdx) {
    const modalEl = document.getElementById('inspectionDetailModal');
    const body = document.getElementById('inspectionDetailBody');
    const actions = document.getElementById('inspectionDetailFooterActions');
    if (!modalEl || !body) return;
    const seq = ++this._seq;
    this._current = null;
    body.innerHTML = '<div class="text-center p-4 text-muted">Loading…</div>';
    if (actions) actions.innerHTML = '';
    if (typeof bootstrap !== 'undefined') bootstrap.Modal.getOrCreateInstance(modalEl).show();
    try {
      const res = await Api.callFresh('getInspection', rowIdx);
      if (seq !== this._seq) return; // another lot was opened meanwhile
      if (!res?.success) {
        body.innerHTML = `<div class="alert alert-danger mb-0">${escapeHtml(res?.message || 'Could not load this inspection.')}</div>`;
        return;
      }
      this._current = res.data;
      this.renderDetail();
    } catch (err) {
      if (seq !== this._seq) return;
      body.innerHTML = `<div class="alert alert-danger mb-0">${escapeHtml((err && err.message) || 'Could not load this inspection.')}</div>`;
    }
  },

  _was(item) {
    const prev = item.previous;
    if (!prev) return '';
    const parts = [];
    if (prev.qty !== null && prev.qty !== undefined && toNumber(prev.qty) !== toNumber(item.qty)) {
      parts.push(`was ${escapeHtml(formatQty(prev.qty))}`);
    }
    if (String(prev.narration || '').toLowerCase() !== String(item.narration || '').toLowerCase()) {
      parts.push(`spec was "${escapeHtml(prev.narration || '—')}"`);
    }
    return parts.length ? `<br><span class="small text-warning-emphasis">${parts.join(', ')}</span>` : '';
  },

  _itemRow(item) {
    const badge = item.state === 'revised' ? ' <span class="badge bg-warning text-dark">Revised</span>'
      : item.state === 'new' ? ' <span class="badge bg-info text-dark">New</span>' : '';
    const result = item.state !== 'checked' ? '<span class="text-muted">Not checked</span>'
      : item.result === 'pass' ? '<span class="badge bg-success">Pass</span>' : '<span class="badge bg-danger">Fail</span>';
    const unit = item.unit ? ` ${escapeHtml(item.unit)}` : '';
    return `<tr>
      <td>${escapeHtml(item.itemName)}${badge}</td>
      <td>${escapeHtml(item.size)}</td>
      <td>${escapeHtml(item.color)}</td>
      <td>${escapeHtml(item.narration)}</td>
      <td class="text-end text-nowrap">${escapeHtml(formatQty(item.qty))}${unit}${this._was(item)}</td>
      <td class="text-center">${result}</td>
    </tr>`;
  },

  _diffLine(x) {
    const name = [x.itemName, x.size, x.color].filter(Boolean).map(escapeHtml).join(' · ');
    if (x.kind === 'added') return `<li>${name}: added (${escapeHtml(formatQty(x.qty))})</li>`;
    if (x.kind === 'removed') return `<li>${name}: removed from the sheet</li>`;
    const changes = (x.changes || []).map(c => (c.field === 'qty'
      ? `quantity ${escapeHtml(formatQty(c.from))} → ${escapeHtml(formatQty(c.to))}`
      : `specification "${escapeHtml(c.from || '—')}" → "${escapeHtml(c.to || '—')}"`)).join('; ');
    return `<li>${name}: ${changes || 'changed'}</li>`;
  },

  renderDetail() {
    const d = this._current;
    const body = document.getElementById('inspectionDetailBody');
    const actions = document.getElementById('inspectionDetailFooterActions');
    if (!d || !body) return;
    const lot = d.lot;
    const insp = d.inspection || {};
    const s = d.summary || {};
    const title = document.getElementById('inspectionDetailTitle');
    if (title) title.textContent = `Inspection: ${lot.lotNumber} · ${lot.processName}`;

    const banners = [];
    if (insp.status === 'flagged') {
      banners.push(`<div class="alert alert-warning py-2">Flagged for an admin${insp.flaggedByName ? ` by <strong>${escapeHtml(insp.flaggedByName)}</strong>` : ''}${insp.flaggedAt ? `, ${escapeHtml(this._when(insp.flaggedAt))}` : ''}. Change the lot (Edit Lot or its Production Sheet), then send it back.</div>`);
    }
    if (insp.status === 'cleared') {
      banners.push(`<div class="alert alert-success py-2">Cleared by <strong>${escapeHtml(insp.clearedByName)}</strong> (${escapeHtml(insp.clearedByRole)}), ${escapeHtml(this._when(insp.clearedAt))}.${insp.changedSinceCleared ? ' The Production Sheet has changed since.' : ''}</div>`);
      if ((insp.acknowledged || []).length) {
        banners.push(`<div class="alert alert-info py-2 mb-2">Production Sheet changes an admin accepted at sign-off:<ul class="mb-0">${insp.acknowledged.map(x => this._diffLine(x)).join('')}</ul></div>`);
      }
    }
    if (insp.status === 'in_progress' && insp.returnedAt) {
      banners.push(`<div class="alert alert-info py-2">Sent back for re-inspection${insp.reviewNote ? `: ${escapeHtml(insp.reviewNote)}` : '.'}</div>`);
    }

    const facts = [
      ['Lot status', `<span class="badge ${INSPECTION_LOT_STATUS[lot.status] || 'bg-secondary'}">${escapeHtml(lot.status)}</span>`],
      ['Inspection', this._stateBadge(insp)],
      ['Date', escapeHtml(lot.date)],
      ['Output', escapeHtml(lot.outputItemName || lot.productName || '—')],
      ['Lot qty', escapeHtml(formatQty(lot.qty))],
      ['Checked', `${toNumber(s.checked)}/${toNumber(s.total)}${s.failed ? ` · <span class="text-danger">${toNumber(s.failed)} failed</span>` : ''}`]
    ];

    body.innerHTML = `
      ${banners.join('')}
      <div class="row g-2 mb-3">
        ${facts.map(([k, v]) => `<div class="col-6 col-md-4"><div class="text-muted small fw-bold">${escapeHtml(k)}</div><div>${v}</div></div>`).join('')}
      </div>
      <div class="table-responsive">
        <table class="table table-sm table-bordered align-middle mb-2">
          <thead class="table-light"><tr><th>Item</th><th>Size</th><th>Colour</th><th>Specification</th><th class="text-end">Qty</th><th class="text-center">Result</th></tr></thead>
          <tbody>${d.items.length ? d.items.map(item => this._itemRow(item)).join('') : '<tr><td colspan="6" class="text-center text-muted">Nothing on the Production Sheet.</td></tr>'}</tbody>
        </table>
      </div>
      ${d.removed.length ? `<div class="small text-muted mb-2"><strong>Removed from the sheet since inspection began:</strong> ${d.removed.map(r => escapeHtml([r.itemName, r.size, r.color].filter(Boolean).join(' · '))).join(', ')}</div>` : ''}
      <div class="mb-0"><div class="text-muted small fw-bold">Remarks / required lot changes</div><div class="text-break" style="white-space: pre-wrap;">${escapeHtml(insp.remarks || '—')}</div></div>`;

    if (actions) {
      actions.innerHTML = insp.status === 'flagged' && d.canReturn ? `
        <div style="min-width: min(26rem, 100%);">
          <label for="inspectionReturnNote" class="form-label small fw-bold mb-1">Note for the inspector (optional)</label>
          <input type="text" id="inspectionReturnNote" class="form-control" maxlength="1000" placeholder="What was changed on the lot">
        </div>
        <button type="button" class="btn btn-warning fw-bold" id="inspectionReturnBtn" onclick="App.Inspection.sendBack()">Send back for re-inspection</button>` : '';
    }
  },

  // Admin only; the server refuses anyone else.
  async sendBack() {
    const d = this._current;
    if (!d) return;
    const note = document.getElementById('inspectionReturnNote')?.value || '';
    const btn = document.getElementById('inspectionReturnBtn');
    if (btn) btn.disabled = true;
    try {
      const res = await Api.mutate('returnInspection', d.lot.rowIdx, note);
      if (!res?.success) {
        App.Utils.showToast(res?.message || 'The lot was not sent back.', true);
        return;
      }
      App.Utils.showToast(res.message || 'Sent back for re-inspection.');
      await this.openDetail(d.lot.rowIdx);
      this.load();
    } catch (err) {
      App.Utils.showToast((err && err.message) || 'The lot was not sent back.', true);
    } finally {
      if (btn && btn.isConnected) btn.disabled = false;
    }
  }
};
