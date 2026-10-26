'use strict';
// inspection.js -- App.Inspection, the desktop side of lot inspection.
// Production > Inspections lists every lot waiting for inspection or already
// inspected; opening one shows its checklist. Anyone the server lets inspect
// ticks items, asks for an admin's review and clears a lot here exactly as
// in the phone app (MApp.Inspection, mobile.js): the same RPCs, so the same
// rules. An admin also reviews and clears any open lot -- partly ticked or
// waiting for review -- after seeing what is not ticked, and can send a lot
// back. Every rule lives in app/erp/services/inspection_service.py.

// Where a lot stands, as inspection_service.stage() names it. `rank` orders
// the list: what waits on an admin first.
const INSPECTION_STAGES = {
  needs_review: { label: 'Needs review', cls: 'bg-warning text-dark', rank: 0 },
  complete: { label: 'All checked', cls: 'bg-info text-dark', rank: 1 },
  partial: { label: 'Partially checked', cls: 'bg-primary-subtle text-primary-emphasis', rank: 2 },
  not_started: { label: 'Not started', cls: 'bg-secondary-subtle text-secondary-emphasis', rank: 3 },
  cleared: { label: 'Inspected', cls: 'bg-success', rank: 4 }
};

const INSPECTION_LOT_STATUS = {
  Pending: 'bg-secondary',
  'In Progress': 'bg-primary',
  Completed: 'bg-success',
  Cancelled: 'bg-danger'
};

// What an empty list means depends on the filter. "All" is the default:
// a narrower one is empty until inspectors get going, which on the first day
// read as "there is no inspection module".
const INSPECTION_EMPTY = {
  all: 'No lot is Pending or In Progress, and none has been inspected yet.',
  needs_review: 'No lot is waiting for an admin\'s review.',
  partial: 'No lot is partly checked.',
  complete: 'No lot is waiting to be cleared with every item ticked.',
  not_started: 'Every Pending or In Progress lot has been started.',
  cleared: 'No lot has been inspected yet.'
};

App.Inspection = {
  _lots: [],
  _filter: 'all',
  _search: '',
  _current: null,
  _seq: 0,
  _saving: new Set(),
  _reconcile: null,
  _dirty: false,
  _bound: false,

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
    this._filter = value || 'all';
    this.render();
  },

  onSearch(value) {
    this._search = String(value || '').trim().toLowerCase();
    this.render();
  },

  _stage(insp) {
    const stage = (insp || {}).stage;
    return INSPECTION_STAGES[stage] ? stage : 'not_started';
  },

  _visible() {
    const keep = this._filter === 'all' ? () => true : lot => this._stage(lot.inspection) === this._filter;
    // Every word must appear somewhere, in any field -- the phone's grammar.
    const words = this._search.split(/\s+/).filter(Boolean);
    const rank = lot => INSPECTION_STAGES[this._stage(lot.inspection)].rank;
    return this._lots
      .map((lot, i) => ({ lot, i }))
      .filter(({ lot }) => keep(lot))
      .filter(({ lot }) => {
        const insp = lot.inspection || {};
        const hay = [lot.lotNumber, lot.processName, lot.outputItemName, lot.date, lot.status,
          insp.remarks, insp.clearedByName, insp.flaggedByName].join(' ').toLowerCase();
        return words.every(w => hay.includes(w));
      })
      .sort((a, b) => (rank(a.lot) - rank(b.lot)) || (a.i - b.i))
      .map(({ lot }) => lot);
  },

  _when(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  },

  _stageBadge(insp) {
    const { label, cls } = INSPECTION_STAGES[this._stage(insp)];
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
      const text = document.getElementById('inspectionsEmptyText');
      if (text) text.textContent = INSPECTION_EMPTY[this._filter] || INSPECTION_EMPTY.all;
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
      const done = this._stage(insp) === 'cleared';
      return `<tr>
        <td><strong>${escapeHtml(lot.lotNumber)}</strong><br><span class="text-muted small">${escapeHtml(lot.date)}</span></td>
        <td>${escapeHtml(lot.processName)}<br><span class="text-muted small">${escapeHtml(lot.outputItemName)}</span></td>
        <td class="text-center"><span class="badge ${INSPECTION_LOT_STATUS[lot.status] || 'bg-secondary'}">${escapeHtml(lot.status)}</span></td>
        <td>${this._stageBadge(insp)}</td>
        <td class="text-end text-nowrap">${toNumber(s.checked)}/${toNumber(s.total, lot.itemCount)}${recheck ? `<br><span class="text-warning-emphasis small">${recheck} to re-check</span>` : ''}</td>
        <td class="small">${escapeHtml(remarks.length > 140 ? `${remarks.slice(0, 140)}…` : remarks)}</td>
        <td class="small text-nowrap">${escapeHtml(this._when(lot.lastUpdated))}${by ? `<br><span class="text-muted">by ${escapeHtml(by)}</span>` : ''}</td>
        <td class="text-center"><button type="button" class="btn btn-sm ${done ? 'btn-outline-dark' : 'btn-dark'} btn-action" onclick="App.Inspection.openDetail(${toNumber(lot.rowIdx)})">${done ? 'View' : 'Inspect'}</button></td>
      </tr>`;
    }).join('');
  },

  // ── One lot ──────────────────────────────────────────────────────────

  _bindOnce() {
    if (this._bound) return;
    const body = document.getElementById('inspectionDetailBody');
    if (!body) return;
    this._bound = true;
    // One delegated listener, because rows are re-rendered after each tick.
    body.addEventListener('change', ev => {
      const box = ev.target.closest('[data-insp-key]');
      if (box) this.toggle(box.dataset.inspKey);
      else if (ev.target.id === 'inspectionNeedsReview') this.saveReview();
    });
    // Counts and badges on the list may have moved while the lot was open.
    document.getElementById('inspectionDetailModal')?.addEventListener('hidden.bs.modal', () => {
      if (!this._dirty) return;
      this._dirty = false;
      this.load();
    });
  },

  async openDetail(rowIdx) {
    const modalEl = document.getElementById('inspectionDetailModal');
    const body = document.getElementById('inspectionDetailBody');
    const actions = document.getElementById('inspectionDetailFooterActions');
    if (!modalEl || !body) return;
    this._bindOnce();
    const seq = ++this._seq;
    this._current = null;
    this._saving = new Set();
    this._reconcile = null;
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

  // A row of the checklist: its box while the lot is open, a badge once the
  // lot is cleared.
  _itemRow(item, closed) {
    const badge = item.state === 'revised' ? ' <span class="badge bg-warning text-dark">Revised</span>'
      : item.state === 'new' ? ' <span class="badge bg-info text-dark">New</span>' : '';
    const ticked = item.state === 'checked';
    const unit = item.unit ? ` ${escapeHtml(item.unit)}` : '';
    const id = `inspectionItem-${String(item.key).replace(/\s/g, '_')}`; // ids may not hold spaces
    const tick = closed
      ? (ticked ? '<span class="badge bg-success">Ticked</span>' : '<span class="text-muted">Not ticked</span>')
      : `<input type="checkbox" class="form-check-input fs-4 m-0 p-0" id="${escapeHtml(id)}" data-insp-key="${escapeHtml(item.key)}"${ticked ? ' checked' : ''}${this._saving.has(item.key) ? ' disabled' : ''}>`;
    const name = closed ? escapeHtml(item.itemName) : `<label class="form-check-label" for="${escapeHtml(id)}">${escapeHtml(item.itemName)}</label>`;
    return `<tr data-insp-row="${escapeHtml(item.key)}"${ticked ? ' class="table-success"' : ''}>
      <td class="text-center">${tick}</td>
      <td>${name}${badge}</td>
      <td>${escapeHtml(item.size)}</td>
      <td>${escapeHtml(item.color)}</td>
      <td>${escapeHtml(item.narration)}</td>
      <td class="text-end text-nowrap">${escapeHtml(formatQty(item.qty))}${unit}${this._was(item)}</td>
    </tr>`;
  },

  _diffLine(x) {
    const name = [x.itemName, x.size, x.color].filter(Boolean).map(escapeHtml).join(' · ');
    if (x.kind === 'unchecked') return `<li>${name}: not ticked (${escapeHtml(formatQty(x.qty))}${x.unit ? ` ${escapeHtml(x.unit)}` : ''})</li>`;
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
    if (!d || !body) return;
    const lot = d.lot;
    const insp = d.inspection || {};
    const closed = insp.status === 'cleared';
    const title = document.getElementById('inspectionDetailTitle');
    if (title) title.textContent = `${closed ? 'Inspection' : 'Inspect'}: ${lot.lotNumber} · ${lot.processName}`;

    const banners = [];
    if (insp.status === 'flagged') {
      const by = insp.flaggedByName ? ` by <strong>${escapeHtml(insp.flaggedByName)}</strong>` : '';
      banners.push(d.canReturn
        ? `<div class="alert alert-warning py-2">Needs admin review${by}${insp.flaggedAt ? `, ${escapeHtml(this._when(insp.flaggedAt))}` : ''}. Read the remarks, then clear the lot or send it back.</div>`
        : `<div class="alert alert-warning py-2">Needs admin review${by}. You can keep ticking; an admin reviews the lot and can clear it.</div>`);
    }
    if (closed) {
      banners.push(`<div class="alert alert-success py-2">Cleared by <strong>${escapeHtml(insp.clearedByName)}</strong> (${escapeHtml(insp.clearedByRole)}), ${escapeHtml(this._when(insp.clearedAt))}.${insp.changedSinceCleared ? ' The Production Sheet has changed since.' : ''}</div>`);
      if ((insp.acknowledged || []).length) {
        banners.push(`<div class="alert alert-info py-2 mb-2">Accepted by an admin at sign-off:<ul class="mb-0">${insp.acknowledged.map(x => this._diffLine(x)).join('')}</ul></div>`);
      }
    }
    if (insp.status === 'in_progress' && insp.returnedAt) {
      banners.push(`<div class="alert alert-info py-2">Sent back for re-inspection${insp.reviewNote ? `: ${escapeHtml(insp.reviewNote)}` : '.'} Items that changed are marked Revised or New.</div>`);
    }

    const facts = [
      ['Lot status', `<span id="inspectionLotStatus" class="badge ${INSPECTION_LOT_STATUS[lot.status] || 'bg-secondary'}">${escapeHtml(lot.status)}</span>`],
      ['Inspection', `<span id="inspectionStage">${this._stageBadge(insp)}</span>`],
      ['Date', escapeHtml(lot.date)],
      ['Output', escapeHtml(lot.outputItemName || lot.productName || '—')],
      ['Lot qty', escapeHtml(formatQty(lot.qty))],
      ['Colours', escapeHtml((lot.colors || []).join(', ') || '—')]
    ];
    const removed = d.removed.length
      ? `<div class="small text-muted mb-2"><strong>Removed from the sheet since inspection began:</strong> ${d.removed.map(r => escapeHtml([r.itemName, r.size, r.color].filter(Boolean).join(' · '))).join(', ')}</div>`
      : '';
    const remarks = closed
      ? `<div class="mb-0"><div class="text-muted small fw-bold">Remarks</div><div class="text-break" style="white-space: pre-wrap;">${escapeHtml(insp.remarks || '—')}</div></div>`
      : this._reviewHtml(d);

    body.innerHTML = `
      ${banners.join('')}
      <div class="row g-2 mb-3">
        ${facts.map(([k, v]) => `<div class="col-6 col-md-4"><div class="text-muted small fw-bold">${escapeHtml(k)}</div><div>${v}</div></div>`).join('')}
      </div>
      <div id="inspectionProgress" class="mb-2" role="status" aria-live="polite"></div>
      <div class="table-responsive">
        <table class="table table-sm table-bordered align-middle mb-2">
          <thead class="table-light"><tr><th class="text-center" style="width: 4.5rem;">Ticked</th><th>Item</th><th>Size</th><th>Colour</th><th>Specification</th><th class="text-end">Qty</th></tr></thead>
          <tbody>${d.items.length ? d.items.map(item => this._itemRow(item, closed)).join('') : '<tr><td colspan="6" class="text-center text-muted">Nothing on the Production Sheet to inspect.</td></tr>'}</tbody>
        </table>
      </div>
      ${removed}
      ${remarks}`;
    this._paintProgress();
    this._paintActions();
  },

  // "Needs admin review" and the remarks it is about. The box saves the
  // moment it changes; an admin looking at a lot that needs review can also
  // send it back.
  _reviewHtml(d) {
    const insp = d.inspection || {};
    const flagged = insp.status === 'flagged';
    const sendBack = flagged && d.canReturn ? `
      <div class="d-flex flex-wrap gap-2 align-items-end mt-3">
        <div style="min-width: min(26rem, 100%);">
          <label for="inspectionReturnNote" class="form-label small fw-bold mb-1">Note for the inspector (optional)</label>
          <input type="text" id="inspectionReturnNote" class="form-control" maxlength="1000" placeholder="What was changed on the lot">
        </div>
        <button type="button" class="btn btn-outline-dark fw-bold" id="inspectionReturnBtn" onclick="App.Inspection.sendBack()">Send back for re-inspection</button>
      </div>` : '';
    return `
      <div class="border rounded-3 p-3 mt-3${flagged ? ' border-warning bg-warning-subtle' : ''}">
        <label class="d-flex align-items-start gap-2 mb-2" style="cursor: pointer;">
          <input class="form-check-input fs-4 m-0 p-0 flex-shrink-0" type="checkbox" id="inspectionNeedsReview"${flagged ? ' checked' : ''}>
          <span>
            <span class="d-block fw-bold">Needs admin review</span>
            <span class="d-block form-text mt-0">Something is wrong or missing. An admin reviews the lot and can clear it.</span>
          </span>
        </label>
        <label for="inspectionRemarks" class="form-label small fw-bold mb-1">Remarks</label>
        <textarea id="inspectionRemarks" class="form-control mb-2" rows="3" maxlength="2000" placeholder="What is wrong or missing, for the admin">${escapeHtml(insp.remarks || '')}</textarea>
        <button type="button" class="btn btn-sm btn-outline-dark fw-bold" id="inspectionSaveRemarksBtn" onclick="App.Inspection.saveReview()">Save remarks</button>
        ${sendBack}
      </div>`;
  },

  _paintProgress() {
    const el = document.getElementById('inspectionProgress');
    const d = this._current;
    const s = d && d.summary;
    if (!el || !s) return;
    const total = toNumber(s.total);
    const checked = toNumber(s.checked);
    const pct = total ? Math.round((checked / total) * 100) : 0;
    const extra = [INSPECTION_STAGES[this._stage(d.inspection)].label];
    if (s.revised) extra.push(`${toNumber(s.revised)} revised`);
    if (s.added) extra.push(`${toNumber(s.added)} new`);
    el.innerHTML = `
      <div class="small mb-1"><strong>${checked}/${total}</strong> items ticked · ${extra.map(escapeHtml).join(' · ')}</div>
      <div class="progress" style="height: 6px;" role="progressbar" aria-label="Items ticked" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${checked}"><div class="progress-bar bg-success" style="width: ${pct}%;"></div></div>`;
  },

  // The footer: who is signing, and the one primary action. An inspector
  // clears a lot once every item is ticked and nobody asked for a review; an
  // admin clears any open lot, after seeing what is not ticked.
  _paintActions() {
    const actions = document.getElementById('inspectionDetailFooterActions');
    const d = this._current;
    if (!actions || !d) return;
    const insp = d.inspection || {};
    if (insp.status === 'cleared') {
      actions.innerHTML = '';
      return;
    }
    const s = d.summary || {};
    const review = insp.status === 'flagged';
    const left = toNumber(s.total) - toNumber(s.checked);
    const items = `${left} item${left === 1 ? '' : 's'}`;
    let why;
    let ready;
    if (d.canAcknowledge) {
      why = review ? 'Needs your review: read the remarks, then clear the lot or send it back.'
        : !s.complete ? `${items} not ticked. You can still clear the lot; you will see them first.` : '';
      ready = toNumber(s.total) > 0;
    } else {
      why = review ? 'Waiting for an admin to review this lot.'
        : !s.complete ? `${items} still to tick.` : '';
      ready = s.complete && !review;
    }
    actions.innerHTML = `
      <div class="small">
        <div>Inspector: <strong>${escapeHtml(d.inspector.name)}</strong> <span aria-hidden="true">|</span> Role: <strong>${escapeHtml(d.inspector.roleLabel)}</strong></div>
        ${why ? `<div class="text-muted" id="inspectionWhy">${escapeHtml(why)}</div>` : ''}
      </div>
      <button type="button" class="btn btn-success fw-bold" id="inspectionClearBtn" onclick="App.Inspection.submit()"${ready ? '' : ' disabled'}${why ? ' aria-describedby="inspectionWhy"' : ''}>Complete Inspection &amp; Clear Lot</button>`;
  },

  _rowEl(key) {
    return [...document.querySelectorAll('#inspectionDetailBody [data-insp-row]')].find(el => el.dataset.inspRow === key) || null;
  },

  _repaintRow(item) {
    const el = this._rowEl(item.key);
    if (el) el.outerHTML = this._itemRow(item, false);
  },

  _repaintStage() {
    const d = this._current;
    const el = document.getElementById('inspectionStage');
    if (d && el) el.innerHTML = this._stageBadge(d.inspection);
  },

  // Tick or untick one item. The box shows the click at once and is held
  // until the save answers; the row is then redrawn from what was saved.
  async toggle(key) {
    const d = this._current;
    const item = d && d.items.find(i => i.key === key);
    if (!item || this._saving.has(key)) return;
    const next = item.state === 'checked' ? '' : 'checked';
    this._saving.add(key);
    const box = this._rowEl(key)?.querySelector('[data-insp-key]');
    if (box) box.disabled = true;
    try {
      const res = await Api.mutate('setInspectionCheck', d.lot.rowIdx, key, next, item.fingerprint);
      if (this._current !== d) return;
      if (!res?.success) {
        App.Utils.showToast(res?.message || 'That tick was not saved.', true);
        // Most refusals mean the sheet moved; show it as it is now.
        await this.openDetail(d.lot.rowIdx);
        return;
      }
      if (res.data.item) Object.assign(item, res.data.item);
      d.summary = res.data.summary;
      if (res.data.stage) d.inspection.stage = res.data.stage;
      this._dirty = true;
      if (res.data.lotStatus && res.data.lotStatus !== d.lot.status) {
        d.lot.status = res.data.lotStatus;
        const badge = document.getElementById('inspectionLotStatus');
        if (badge) {
          badge.textContent = d.lot.status;
          badge.className = `badge ${INSPECTION_LOT_STATUS[d.lot.status] || 'bg-secondary'}`;
        }
        if (res.message) App.Utils.showToast(res.message);
      }
    } catch (err) {
      App.Utils.showToast((err && err.message) || 'No connection. That tick was not saved.', true);
    } finally {
      this._saving.delete(key);
      if (this._current === d) {
        this._repaintRow(item);
        this._repaintStage();
        this._paintProgress();
        this._paintActions();
      }
    }
  },

  // Saves "Needs admin review" and the remarks together: the box saves the
  // moment it changes, "Save remarks" whenever the text does. Asking for a
  // review needs remarks saying what the admin should look at.
  async saveReview() {
    const d = this._current;
    if (!d) return;
    const box = document.getElementById('inspectionNeedsReview');
    const field = document.getElementById('inspectionRemarks');
    const saved = d.inspection.status === 'flagged';
    const needsReview = box ? box.checked : saved;
    const remarks = field ? field.value : '';
    if (needsReview && !remarks.trim()) {
      if (box) box.checked = saved;
      App.Utils.showToast('Write what the admin should look at, then tick Needs admin review.', true);
      if (field) field.focus();
      return;
    }
    const btn = document.getElementById('inspectionSaveRemarksBtn');
    if (box) box.disabled = true;
    if (btn) btn.disabled = true;
    try {
      const res = await Api.mutate('setInspectionReview', d.lot.rowIdx, needsReview, remarks);
      if (this._current !== d) return;
      if (!res?.success) {
        App.Utils.showToast(res?.message || 'Not saved.', true);
        if (box) box.checked = saved;
        return;
      }
      Object.assign(d.inspection, {
        status: res.data.status, remarks: res.data.remarks,
        stage: res.data.stage, flaggedByName: res.data.flaggedByName
      });
      if (res.data.summary) d.summary = res.data.summary;
      this._dirty = true;
      App.Utils.showToast(res.message || 'Saved.');
      // The banner, the footer and an admin's "Send back" all follow the box.
      const nowFlagged = d.inspection.status === 'flagged';
      if (nowFlagged !== saved) this.renderDetail();
    } catch (err) {
      App.Utils.showToast((err && err.message) || 'No connection. Not saved.', true);
      if (box) box.checked = saved;
    } finally {
      if (box && box.isConnected) box.disabled = false;
      if (btn && btn.isConnected) btn.disabled = false;
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
      this._dirty = true;
      App.Utils.showToast(res.message || 'Sent back for re-inspection.');
      await this.openDetail(d.lot.rowIdx);
    } catch (err) {
      App.Utils.showToast((err && err.message) || 'The lot was not sent back.', true);
    } finally {
      if (btn && btn.isConnected) btn.disabled = false;
    }
  },

  // Sign-off. The server re-reads the live Production Sheet; whatever the
  // clear would accept -- sheet changes, and for an admin the items nobody
  // ticked -- comes back first, to be re-inspected or (an admin) accepted,
  // echoing the token of exactly the list shown.
  async submit(acknowledgeToken) {
    const d = this._current;
    if (!d) return;
    const btn = document.getElementById(acknowledgeToken ? 'inspectionAcknowledgeBtn' : 'inspectionClearBtn');
    const idle = btn ? btn.innerHTML : '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Checking the Production Sheet…';
    }
    try {
      const res = acknowledgeToken
        ? await Api.mutate('clearInspection', d.lot.rowIdx, acknowledgeToken)
        : await Api.mutate('clearInspection', d.lot.rowIdx);
      if (this._current !== d) return;
      if (!res?.success) {
        App.Utils.showToast(res?.message || 'The lot was not cleared.', true);
        await this.openDetail(d.lot.rowIdx);
        return;
      }
      if (res.data.cleared) {
        this._dirty = true;
        this._showCleared(res.data);
        return;
      }
      this._openReconcile(res.data);
    } catch (err) {
      App.Utils.showToast((err && err.message) || 'No connection. The lot was not cleared.', true);
    } finally {
      if (btn && btn.isConnected) {
        btn.disabled = false;
        btn.innerHTML = idle;
      }
    }
  },

  _openReconcile(result) {
    const d = this._current;
    const body = document.getElementById('inspectionDetailBody');
    const actions = document.getElementById('inspectionDetailFooterActions');
    if (!d || !body || !actions) return;
    this._reconcile = result;
    const all = result.discrepancies || [];
    const changes = all.filter(x => x.kind !== 'unchecked');
    const unticked = all.filter(x => x.kind === 'unchecked');
    const n = unticked.length;
    body.innerHTML = `
      ${result.changedAgain ? '<div class="alert alert-warning py-2">The list changed while you were deciding. This is how it stands now.</div>' : ''}
      ${changes.length ? `
        <p class="fw-bold text-body">Targeted changes have been detected in the live Production Sheet. Do you confirm these changes apply to this inspected lot?</p>
        <ul class="mb-3">${changes.map(x => this._diffLine(x)).join('')}</ul>` : ''}
      ${n ? `
        <p class="fw-bold text-body">${n} item${n === 1 ? ' is' : 's are'} not ticked. Clear the lot without ${n === 1 ? 'it' : 'them'}?</p>
        <ul class="mb-3">${unticked.map(x => this._diffLine(x)).join('')}</ul>` : ''}
      ${result.canAcknowledge ? '' : '<p class="small text-muted mb-0">Only an admin can accept these changes without re-inspecting. Re-inspect the changed items, or tick Needs admin review.</p>'}`;
    actions.innerHTML = `
      <button type="button" class="btn btn-outline-dark fw-bold" id="inspectionReinspectBtn" onclick="App.Inspection.openDetail(${toNumber(d.lot.rowIdx)})">${changes.length ? 'Re-inspect Modified Items' : 'Back to the checklist'}</button>
      ${result.canAcknowledge ? '<button type="button" class="btn btn-success fw-bold" id="inspectionAcknowledgeBtn" onclick="App.Inspection.acknowledge()">Acknowledge &amp; Proceed</button>' : ''}`;
  },

  acknowledge() {
    if (!this._reconcile || !this._reconcile.token) return Promise.resolve();
    return this.submit(this._reconcile.token);
  },

  _showCleared(result) {
    const d = this._current;
    const name = (result.inspector && result.inspector.name) || (d && d.inspector.name) || '';
    if (d) d.inspection.status = 'cleared';
    const accepted = result.acknowledged || [];
    const unticked = accepted.filter(x => x.kind === 'unchecked').length;
    const notes = [];
    if (accepted.length > unticked) notes.push('Production Sheet changes accepted by an admin');
    if (unticked) notes.push(`${unticked} item${unticked === 1 ? '' : 's'} cleared by an admin without a tick`);
    const title = document.getElementById('inspectionDetailTitle');
    if (title && d) title.textContent = `Inspection: ${d.lot.lotNumber} · ${d.lot.processName}`;
    const body = document.getElementById('inspectionDetailBody');
    const actions = document.getElementById('inspectionDetailFooterActions');
    if (body) {
      body.innerHTML = `
        <div class="text-center py-4" role="status">
          <i class="bi bi-check-circle-fill text-success" style="font-size: 3rem;" aria-hidden="true"></i>
          <p class="fs-5 fw-bold mt-3 mb-1">Thank you, ${escapeHtml(name)}. Your lot has been cleared for ${escapeHtml(result.processName)}.</p>
          <p class="text-muted mb-0">Lot ${escapeHtml(result.lotNumber)}${notes.map(note => ` · ${escapeHtml(note)}`).join('')}</p>
        </div>`;
    }
    if (actions) actions.innerHTML = '';
  }
};
