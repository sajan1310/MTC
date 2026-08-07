'use strict';
// dispatch.js -- App.Dispatch, ported from Apps_Script/Script_Dispatch.html.
//
// Two sub-tabs: Ready to Dispatch (finished-goods qty ready to ship, per
// product -- produced minus already-dispatched) and Dispatched Goods
// (the actual dispatch ledger, each bill optionally tied to a PI/Estimate
// order and a logistics contractor).
//
// Header+lines (migration 023): one Dispatch Number is a "bill" that can
// carry several line items (Product/Qty/optional Rate each). App.State.
// globalDispatch stays a FLAT array -- one entry per LINE, header fields
// repeated on every line -- because client.js's client-ledger/pending-
// order-line calculations and stock.js's stock-history projection both
// already iterate it assuming that flat shape; keeping it flat means
// neither file needed to change. App.State.globalDispatchBills is a
// SEPARATE, client-side-grouped view (built by buildDispatchBills below)
// used only by this module's own ledger table + edit modal -- exactly the
// same two-shapes-of-the-same-data split the reference itself documents
// keeping, for the same reason.
//
// Adaptations from source (documented, not silent):
// - saveDispatch/deleteDispatch/deleteDispatchBulk use Api.mutate (not
//   Api.call): every one is mutation=True on the backend.
// - print/bulkPrint are guarded behind App.Print not existing yet;
//   buildDispatchPrintPageHtml stays as ported dead code.
// - Logistics Cost is computed and persisted entirely server-side, once
//   per LINE (= header's logistics_rate snapshot * that line's qty), from
//   a "Dispatch / Logistics" rate-card lookup (config_maps.
//   LOGISTICS_PROCESS_NAME) -- the client-side refreshLogisticsCostHint is
//   purely an advisory estimate (rate * this form's current total qty),
//   never sent to or trusted by the server.
// - existingDispatchNumber (edit-identity) / dispatchNumber (create/edit
//   result) follow this codebase's own PO/Bill naming convention, not the
//   reference's single dispatchNumber-does-double-duty field -- a dispatch
//   bill can't be renumbered on edit either way (the reference's own
//   saveDispatch has no such feature).

App.Dispatch = {
  async enterTab() {
    const fetches = [
      App.Contractor.ensureLoaded(),
      // Delivery Challan print's HSN column looks item names up against
      // Items Master (see dispatchPrintItemRowsHtml) -- ensured here so
      // it's not silently blank just because Item Master wasn't visited.
      App.Item ? App.Item.ensureLoaded() : Promise.resolve(),
      this.loadReadyData(),
      this.loadDispatchData()
    ];

    if (!App.State.globalOrders || !App.State.globalOrders.length) {
      fetches.push(
        Api.call('getClientOrdersData')
          .then(res => { if (res.success) App.State.globalOrders = res.data; })
          .catch(() => { /* Ignored -- order dropdown will simply be empty until PI/Estimates load elsewhere. */ })
      );
    }
    if (!App.State.globalClients || !App.State.globalClients.length) {
      fetches.push(
        Api.call('getClientsData')
          .then(res => { if (res.success) App.State.globalClients = res.data; })
          .catch(() => { /* Ignored -- client dropdown will simply be empty until Clients load elsewhere. */ })
      );
    }

    await Promise.all(fetches);

    this.switchSubTab('readyToDispatchSubTab');
  },

  switchSubTab(id) {
    $$('.dispatch-sub-tab').forEach(t => t.style.display = 'none');
    const target = document.getElementById(id);
    if (target) target.style.display = 'block';

    $$('#dispatchSubTabs .nav-link').forEach(btn => btn.classList.remove('active'));
    document.getElementById('btn-' + id)?.classList.add('active');
  },

  // ── Ready to Dispatch ──────────────────────────────────────
  async loadReadyData() {
    const tbody = document.getElementById('readyToDispatchTableBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="text-center p-4">Loading Ready to Dispatch Data...</td></tr>';

    try {
      const response = await Api.call('getReadyToDispatchData');
      if (!response.success) {
        App.Utils.showToast(response.message, true);
        return;
      }
      App.State.globalReadyToDispatch = response.data;
      App.State.filteredReadyToDispatch = response.data;
      this.renderReadyTable();
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to load Ready to Dispatch data', true);
    }
  },

  filterReady(searchTerm) {
    const term = String(searchTerm || '').toLowerCase().trim();
    App.State.filteredReadyToDispatch = term
      ? App.State.globalReadyToDispatch.filter(r => App.Utils.matchesKeywords(`${r.productId} ${r.productName}`, term))
      : App.State.globalReadyToDispatch;
    this.renderReadyTable();
  },

  renderReadyTable() {
    const tbody = document.getElementById('readyToDispatchTableBody');
    if (!tbody) return;

    const emptyState = document.getElementById('readyToDispatchEmptyState');
    if (App.State.filteredReadyToDispatch.length === 0) {
      tbody.innerHTML = '';
      if (emptyState) emptyState.style.display = 'block';
      return;
    }
    if (emptyState) emptyState.style.display = 'none';

    let html = '';
    App.State.filteredReadyToDispatch.forEach(r => {
      const readyClass = r.readyQty > 0 ? 'text-success fw-bold' : 'text-muted';
      // A row can span several Completed lots logged under different Colors
      // to Produce combinations. Only worth a button when there's real color
      // info to show: 2+ distinct entries, or a single one that isn't just
      // the blank/untagged bucket.
      const breakdown = r.colorBreakdown || [];
      const hasColorInfo = breakdown.length > 1 || (breakdown.length === 1 && breakdown[0].color);
      const colorsCell = hasColorInfo
        ? `<button type="button" class="btn btn-sm btn-outline-dark" onclick="App.Dispatch.openColorBreakdown('${escapeHtml(r.key || r.productId)}')">
             <i class="bi bi-palette me-1"></i>${breakdown.length}
           </button>`
        : '<span class="text-muted">&#8211;</span>';
      html += `<tr>
        <td><span class="badge bg-dark fs-6 shadow-sm">${escapeHtml(r.productId)}</span></td>
        <td><strong>${escapeHtml(r.productName)}</strong></td>
        <td class="text-center">${App.Production.formatQty(r.producedQty)}</td>
        <td class="text-center">${App.Production.formatQty(r.dispatchedQty)}</td>
        <td class="text-center ${readyClass}">${App.Production.formatQty(r.readyQty)}</td>
        <td class="text-center">${colorsCell}</td>
        <td class="text-center">
          <button class="btn btn-sm btn-success btn-action" ${r.readyQty > 0 ? '' : 'disabled'} onclick="App.Dispatch.openCreateDispatchModal('${escapeHtml(r.productId)}')">Dispatch</button>
        </td>
      </tr>`;
    });

    tbody.innerHTML = html;
  },

  // Read-only detail popup for one row's own color makeup -- see
  // getReadyToDispatchData's colorBreakdown. Reads straight from the
  // already-loaded globalReadyToDispatch (no extra API round trip).
  // Addressed by the record's `key`, not its productId: a Dispatch
  // Differentiator splits one output into several rows that all report the
  // SAME productId, so matching on that would open the first variant's
  // breakdown no matter which row's button was clicked. Falls back to
  // productId for an older cached payload with no key.
  openColorBreakdown(rowKey) {
    const list = App.State.globalReadyToDispatch || [];
    const record = list.find(r => (r.key || r.productId) === rowKey);
    if (!record) return;

    const titleEl = document.getElementById('dispatchColorBreakdownTitle');
    if (titleEl) titleEl.innerText = `Color Breakdown: ${record.productName} (${record.productId})`;

    const body = document.getElementById('dispatchColorBreakdownBody');
    if (body) {
      const rows = (record.colorBreakdown || []).map(c => {
        const readyClass = c.readyQty > 0 ? 'text-success fw-bold' : 'text-muted';
        const colorCell = c.color
          ? `<span class="badge bg-info text-dark">${escapeHtml(c.color)}</span>`
          : '<span class="text-muted">&#8211; (no color recorded)</span>';
        return `<tr>
          <td>${colorCell}</td>
          <td class="text-center">${App.Production.formatQty(c.producedQty)}</td>
          <td class="text-center">${App.Production.formatQty(c.dispatchedQty)}</td>
          <td class="text-center ${readyClass}">${App.Production.formatQty(c.readyQty)}</td>
        </tr>`;
      }).join('');
      body.innerHTML = rows || '<tr><td colspan="4" class="text-center text-muted p-3">No color data recorded for this product.</td></tr>';
    }

    safeModalShow('dispatchColorBreakdownModal');
  },

  // ── Dispatched Goods ───────────────────────────────────────
  async loadDispatchData() {
    const tbody = document.getElementById('dispatchTableBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="11" class="text-center p-4">Loading Dispatched Goods...</td></tr>';

    try {
      const response = await Api.call('getDispatchData');
      if (!response.success) {
        App.Utils.showToast(response.message, true);
        return;
      }
      // Flat, one entry per line -- see module header. Other modules
      // (client.js, stock.js) read this same array directly.
      App.State.globalDispatch = response.data;
      this.buildDispatchBills();
      App.State.filteredDispatchBills = App.State.globalDispatchBills;
      App.State.dispatchCurrentPage = 1;
      App.State.dispatchSortBy = App.State.dispatchSortBy || 'dateDesc';
      App.State.selectedDispatch = [];
      this.sortFilteredDispatch();
      this.renderDispatchTable();
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to load dispatch data', true);
    }
  },

  // Groups the flat globalDispatch (one entry per line) into one object per
  // bill (dispatchNumber), each carrying its own `items` array + aggregate
  // totals -- the shape this module's own ledger table/modal actually want.
  // A Map preserves first-seen order (globalDispatch already arrives sorted
  // newest-first from the server); re-derived on every load/save, never
  // mutated independently of globalDispatch.
  buildDispatchBills() {
    const byNumber = new Map();
    (App.State.globalDispatch || []).forEach(d => {
      let bill = byNumber.get(d.dispatchNumber);
      if (!bill) {
        bill = {
          dispatchNumber: d.dispatchNumber,
          dispatchDate: d.dispatchDate,
          dateRaw: d.dateRaw,
          orderNumber: d.orderNumber,
          clientName: d.clientName,
          transport: d.transport,
          remarks: d.remarks,
          invoiceNumber: d.invoiceNumber,
          privateMark: d.privateMark,
          grNumber: d.grNumber,
          logisticsContractor: d.logisticsContractor,
          logisticsRate: d.logisticsRate,
          items: [],
          totalQty: 0,
          totalAmount: 0,
          totalLogisticsCost: 0
        };
        byNumber.set(d.dispatchNumber, bill);
      }
      bill.items.push({
        lineId: d.lineId,
        productId: d.productId,
        productName: d.productName,
        qty: d.qty,
        rate: d.rate,
        amount: d.amount,
        logisticsCost: d.logisticsCost
      });
      bill.totalQty += Number(d.qty) || 0;
      bill.totalAmount += Number(d.amount) || 0;
      bill.totalLogisticsCost += Number(d.logisticsCost) || 0;
    });
    App.State.globalDispatchBills = Array.from(byNumber.values());
  },

  filterDispatch(searchTerm) {
    const term = String(searchTerm || '').toLowerCase().trim();
    App.State.filteredDispatchBills = term
      ? App.State.globalDispatchBills.filter(b => App.Utils.matchesKeywords(
          `${b.dispatchNumber} ${b.orderNumber} ${b.clientName} ${(b.items || []).map(i => `${i.productId} ${i.productName}`).join(' ')}`,
          term
        ))
      : App.State.globalDispatchBills;
    this.sortFilteredDispatch();
    App.State.dispatchCurrentPage = 1;
    this.renderDispatchTable();
  },

  // Field/direction combos selectable via the "Sort by" dropdown
  // (dispatch.html#dispatchSortBy). Applied to filteredDispatchBills after
  // every filter pass, before the pagination slice in renderDispatchTable.
  // Operates on bill-level aggregates -- never per-line.
  DISPATCH_SORT_COMPARATORS: {
    dateDesc: (a, b) => parseRecordDate(b.dateRaw, b.dispatchDate) - parseRecordDate(a.dateRaw, a.dispatchDate),
    dateAsc: (a, b) => parseRecordDate(a.dateRaw, a.dispatchDate) - parseRecordDate(b.dateRaw, b.dispatchDate),
    clientAsc: (a, b) => String(a.clientName || '').localeCompare(String(b.clientName || '')),
    clientDesc: (a, b) => String(b.clientName || '').localeCompare(String(a.clientName || '')),
    qtyDesc: (a, b) => (b.totalQty || 0) - (a.totalQty || 0),
    qtyAsc: (a, b) => (a.totalQty || 0) - (b.totalQty || 0),
    dispatchNumberDesc: (a, b) => (parseInt(String(b.dispatchNumber).replace(/\D/g, ''), 10) || 0) - (parseInt(String(a.dispatchNumber).replace(/\D/g, ''), 10) || 0),
    dispatchNumberAsc: (a, b) => (parseInt(String(a.dispatchNumber).replace(/\D/g, ''), 10) || 0) - (parseInt(String(b.dispatchNumber).replace(/\D/g, ''), 10) || 0)
  },

  sortFilteredDispatch() {
    const cmp = this.DISPATCH_SORT_COMPARATORS[App.State.dispatchSortBy];
    if (cmp) App.State.filteredDispatchBills.sort(cmp);
  },

  sortDispatchBy(value) {
    App.State.dispatchSortBy = value;
    this.sortFilteredDispatch();
    App.State.dispatchCurrentPage = 1;
    this.renderDispatchTable();
  },

  changeDispatchPage(page) {
    App.State.dispatchCurrentPage = App.Utils.clampPage(page, App.State.filteredDispatchBills.length, App.State.dispatchRowsPerPage);
    this.renderDispatchTable();
  },

  renderDispatchTable() {
    const tbody = document.getElementById('dispatchTableBody');
    if (!tbody) return;

    const emptyState = document.getElementById('dispatchEmptyState');
    if (App.State.filteredDispatchBills.length === 0) {
      tbody.innerHTML = '';
      if (emptyState) emptyState.style.display = 'block';
      App.Utils.renderPagination('dispatchPagination', 0, 1, App.State.dispatchRowsPerPage, 'dispatch-page', 'Dispatch Bills');
      this.updateDispatchBulkButtons();
      return;
    }
    if (emptyState) emptyState.style.display = 'none';

    const { filteredDispatchBills, dispatchCurrentPage: cur, dispatchRowsPerPage: rpp } = App.State;
    const start = (cur - 1) * rpp;
    const pageItems = filteredDispatchBills.slice(start, start + rpp);

    const selectAllChk = document.getElementById('selectAllDispatch');
    if (selectAllChk) {
      selectAllChk.checked = pageItems.length > 0 &&
        pageItems.every(b => App.Selection.isSelected(App.State.selectedDispatch, b.dispatchNumber));
    }

    tbody.innerHTML = pageItems.map(b => this.billRowHtml(b)).join('');

    App.Utils.renderPagination('dispatchPagination', filteredDispatchBills.length, cur, rpp, 'dispatch-page', 'Dispatch Bills');
    this.updateDispatchBulkButtons();
  },

  // Renders one <tr> for a dispatch BILL (one or more line items stacked
  // into the Product/Qty cells). Shared by renderDispatchTable's full
  // rebuild and patchBillInPlace's single-row swap below.
  billRowHtml(b) {
    const key = String(b.dispatchNumber);
    const checked = App.Selection.isSelected(App.State.selectedDispatch, key) ? 'checked' : '';
    const items = b.items || [];

    const productsCell = items
      .map(i => `<strong>${escapeHtml(i.productName)}</strong> <small class="text-muted">x${App.Production.formatQty(i.qty)}</small>`)
      .join('<br>');

    return `<tr data-row-key="${escapeHtml(key)}">
        <td class="text-center">
          <input type="checkbox" class="form-check-input dispatch-select-chk" data-key="${escapeHtml(key)}" ${checked} onchange="App.Dispatch.onDispatchRowSelectChange()">
        </td>
        <td><span class="badge bg-dark fs-6 shadow-sm">${escapeHtml(b.dispatchNumber)}</span></td>
        <td>${escapeHtml(b.dispatchDate)}</td>
        <td>${b.orderNumber ? escapeHtml(b.orderNumber) : '<span class="text-muted">&mdash;</span>'}</td>
        <td>${escapeHtml(b.clientName) || '-'}</td>
        <td><small>${productsCell}</small></td>
        <td class="text-center fw-bold">${App.Production.formatQty(b.totalQty)}</td>
        <td>${escapeHtml(b.transport) || '-'}</td>
        <td><small>${b.invoiceNumber ? `Inv: ${escapeHtml(b.invoiceNumber)}` : '<span class="text-muted">No Invoice #</span>'}${b.grNumber ? `<br>GR: ${escapeHtml(b.grNumber)}` : ''}</small></td>
        <td class="text-end">${b.totalLogisticsCost ? `${formatCurrency(b.totalLogisticsCost)}<br><small class="text-muted">${escapeHtml(b.logisticsContractor)}</small>` : '<span class="text-muted">&mdash;</span>'}</td>
        <td class="text-center">
          <button class="btn btn-sm btn-outline-dark btn-action w-100 mb-1" onclick="App.Dispatch.print('${escapeHtml(key)}')">Print Challan</button>
          <button class="btn btn-sm btn-outline-primary btn-action w-100 mb-1" onclick="App.Dispatch.openEditDispatchModal('${escapeHtml(key)}')">Edit</button>
          <button class="btn btn-sm btn-danger btn-action w-100" onclick="App.Dispatch.delete('${escapeHtml(key)}', ${items.length}, ${b.totalQty})">Delete</button>
        </td>
      </tr>`;
  },

  // Patches one already-loaded bill's data + its rendered <tr> after a save,
  // instead of a full loadDispatchData() reload. `freshRows` is the flat
  // (one-per-line) array save_dispatch hands back for exactly this
  // dispatchNumber -- splices those into globalDispatch in place of
  // whatever lines that number used to have, then rebuilds
  // globalDispatchBills from the patched flat array. Returns false --
  // caller should fall back to loadDispatchData() -- if the bill isn't
  // currently on the displayed page.
  patchBillInPlace(freshRows) {
    if (!freshRows || !freshRows.length) return false;
    const dispatchNumber = freshRows[0].dispatchNumber;

    App.State.globalDispatch = (App.State.globalDispatch || []).filter(d => d.dispatchNumber !== dispatchNumber);
    App.State.globalDispatch.push(...freshRows);
    this.buildDispatchBills();

    const freshBill = App.State.globalDispatchBills.find(b => b.dispatchNumber === dispatchNumber);
    if (!freshBill) return false;

    const idxInFiltered = (App.State.filteredDispatchBills || []).findIndex(b => b.dispatchNumber === dispatchNumber);
    if (idxInFiltered !== -1) App.State.filteredDispatchBills[idxInFiltered] = freshBill;

    const tr = document.querySelector(`#dispatchTableBody tr[data-row-key="${CSS.escape(dispatchNumber)}"]`);
    if (!tr) return false;

    tr.outerHTML = this.billRowHtml(freshBill);
    return true;
  },

  toggleSelectAllDispatch(masterChk) {
    App.Selection.toggleAll(App.State.selectedDispatch, 'dispatch-select-chk', masterChk);
    this.updateDispatchBulkButtons();
  },

  onDispatchRowSelectChange() {
    App.Selection.syncFromRows(App.State.selectedDispatch, 'dispatch-select-chk', 'selectAllDispatch');
    this.updateDispatchBulkButtons();
  },

  updateDispatchBulkButtons() {
    const count = App.State.selectedDispatch.length;
    App.Selection.updateButton('btnBulkDeleteDispatch', count, '<i class="bi bi-trash"></i> Delete Selected');
    App.Selection.updateButton('btnBulkPrintDispatch', count, '<i class="bi bi-printer"></i> Print Selected');
    App.Selection.updateButton('btnBulkDownloadPdfDispatch', count, '<i class="bi bi-file-earmark-pdf"></i> Download PDFs');
  },

  // Populates #print-dispatch-container's fields from one Dispatch BILL for
  // the per-row "Print Challan" button -- a GST delivery challan, since
  // goods physically leave the factory on a Dispatch. Consignee
  // address/GSTIN aren't stored on the bill itself (only clientName is),
  // so they're looked up from Client Master here. Renders one table row per
  // line item (a real items loop now that a bill can carry more than one).
  populateDispatchPrintData(dispatchNumber) {
    const b = (App.State.globalDispatchBills || []).find(x => x.dispatchNumber === dispatchNumber);
    if (!b) return null;

    const setText = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.innerText = val ?? '';
    };

    const client = (App.State.globalClients || []).find(c => App.Utils.sameText(c.name, b.clientName));

    setText('print-dispatch-number', b.dispatchNumber || '');
    setText('print-dispatch-date', b.dispatchDate || '');
    setText('print-dispatch-client', b.clientName || '');
    setText('print-dispatch-client-address', client?.address || '');
    setText('print-dispatch-client-gstin', client?.gstin || '');
    setText('print-dispatch-transport', b.transport || '');
    setText('print-dispatch-order-ref', b.orderNumber || '');

    const grRefParts = [];
    if (b.invoiceNumber) grRefParts.push(`Inv: ${b.invoiceNumber}`);
    if (b.grNumber) grRefParts.push(`GR: ${b.grNumber}`);
    setText('print-dispatch-gr-ref', grRefParts.join(' | '));
    setText('print-dispatch-remarks', b.remarks || '');

    const tbody = document.getElementById('print-dispatch-items-body');
    if (tbody) tbody.innerHTML = this.dispatchPrintItemRowsHtml(b.items || []);

    return b;
  },

  // One <tr> per line item for the printed Delivery Challan. HSN looked up
  // from Items Master by product name (Dispatch itself has no HSN column).
  dispatchPrintItemRowsHtml(items) {
    return items.map((i, idx) => {
      const item = (App.State.globalItems || []).find(it => App.Utils.sameText(it.name, i.productName));
      return `<tr>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:center;color:#999;font-weight:600;">${idx + 1}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;text-align:left;font-weight:600;">${escapeHtml(i.productName || '')}${i.productId ? ` <small style="color:#888;">(${escapeHtml(i.productId)})</small>` : ''}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;">${escapeHtml(item?.hsn || '')}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;font-weight:600;">${escapeHtml(String(toNumber(i.qty)))}</td>
        <td style="padding:7px 6px;border:1px solid #e5e5e5;">Pcs</td>
      </tr>`;
    }).join('');
  },

  print(dispatchNumber) {
    if (typeof App.Print === 'undefined') {
      App.Utils.notPortedYet('Printing');
      return;
    }

    const b = this.populateDispatchPrintData(dispatchNumber);
    if (!b) return;

    const title = `Delivery_Challan_${b.dispatchNumber}_${String(b.clientName || '')
      .replace(/[^a-zA-Z0-9 \-]/g, '')
      .trim()
      .replace(/\s+/g, '_')}`;
    App.Print.trigger('print-dispatch-container', title);
  },

  bulkPrint() {
    if (typeof App.Print === 'undefined') {
      App.Utils.notPortedYet('Printing');
      return;
    }

    const selected = App.State.selectedDispatch;
    if (!selected.length) {
      App.Utils.showToast('No dispatch bills selected.', true);
      return;
    }

    const bills = App.State.globalDispatchBills.filter(b => App.Selection.isSelected(selected, b.dispatchNumber));
    if (!bills.length) return;

    App.Print.triggerBulk(bills, b => this.buildDispatchPrintPageHtml(b), 'Delivery_Challans_Selected');
  },

  async bulkDownloadPDF() {
    const selected = App.State.selectedDispatch;
    if (!selected.length) {
      App.Utils.showToast('No dispatch bills selected.', true);
      return;
    }

    const bills = App.State.globalDispatchBills.filter(b => App.Selection.isSelected(selected, b.dispatchNumber));
    if (!bills.length) return;

    App.Print.renderBulkPages(bills, b => this.buildDispatchPrintPageHtml(b));
    const filename = App.Print.bulkPdfFilename('Delivery_Challans', bills.length);
    const ok = await App.Print.downloadElementAsPDF('print-bulk-container', filename);
    if (ok) App.Utils.showToast(`${bills.length} delivery challan(s) exported to PDF!`, false);
  },

  // Builds a fully self-contained "Delivery Challan" page (mirrors
  // #print-dispatch-container's markup/styling) for use in bulk printing.
  // One table row per line item.
  buildDispatchPrintPageHtml(b) {
    const BRAND = '#0D6EFD';
    const client = (App.State.globalClients || []).find(c => App.Utils.sameText(c.name, b.clientName));

    const grRefParts = [];
    if (b.invoiceNumber) grRefParts.push(`Inv: ${escapeHtml(b.invoiceNumber)}`);
    if (b.grNumber) grRefParts.push(`GR: ${escapeHtml(b.grNumber)}`);

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

      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <div style="flex:1;text-align:left;">
          <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Challan Number</span>
          <div style="font-size:15px;font-weight:700;color:${BRAND};-webkit-print-color-adjust:exact;print-color-adjust:exact;">${escapeHtml(b.dispatchNumber || '')}</div>
        </div>
        <div style="flex:2;text-align:center;">
          <span style="font-size:18px;font-weight:800;color:${BRAND};letter-spacing:3px;text-transform:uppercase;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
            Delivery Challan
          </span>
        </div>
        <div style="flex:1;text-align:right;">
          <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Date</span>
          <div style="font-size:13px;font-weight:700;color:#1a1a1a;">${escapeHtml(b.dispatchDate || '')}</div>
        </div>
      </div>

      <div style="height:1px;background:#bbb;margin-bottom:14px;"></div>

      <div style="margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid #ccc;">
        <div style="display:flex;gap:16px;">
          <div style="flex:1;">
            <div style="margin-bottom:6px;">
              <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Consignee (Ship To)</span>
              <div style="font-weight:700;font-size:13px;color:#1a1a1a;margin-top:1px;">${escapeHtml(b.clientName || '')}</div>
            </div>
            <div style="margin-bottom:6px;">
              <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Address</span>
              <div style="font-size:11px;color:#333;margin-top:1px;white-space:pre-wrap;">${escapeHtml(client?.address || '')}</div>
            </div>
            <div>
              <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">GSTIN</span>
              <div style="font-size:11px;color:#333;margin-top:1px;font-weight:600;">${escapeHtml(client?.gstin || '')}</div>
            </div>
          </div>
          <div style="flex:1;">
            <div style="margin-bottom:6px;">
              <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Vehicle / Transport</span>
              <div style="font-size:11px;color:#333;margin-top:1px;">${escapeHtml(b.transport || '')}</div>
            </div>
            <div style="margin-bottom:6px;">
              <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Order Reference</span>
              <div style="font-size:11px;color:#333;margin-top:1px;">${escapeHtml(b.orderNumber || '')}</div>
            </div>
            <div>
              <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">GR / Invoice #</span>
              <div style="font-size:11px;color:#333;margin-top:1px;">${grRefParts.join(' | ')}</div>
            </div>
          </div>
        </div>
      </div>

      <table style="width:100%;border-collapse:collapse;margin-bottom:14px;font-size:12px;">
        <thead style="background-color:${BRAND};color:#fff;text-align:center;font-weight:700;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
          <tr>
            <th style="padding:8px 6px;border:1px solid ${BRAND};text-align:center;width:6%;">#</th>
            <th style="padding:8px 6px;border:1px solid ${BRAND};text-align:left;width:52%;">Item / Product Name</th>
            <th style="padding:8px 6px;border:1px solid ${BRAND};text-align:center;width:17%;">HSN</th>
            <th style="padding:8px 6px;border:1px solid ${BRAND};text-align:center;width:12%;">Qty</th>
            <th style="padding:8px 6px;border:1px solid ${BRAND};text-align:center;width:13%;">Unit</th>
          </tr>
        </thead>
        <tbody style="color:#1a1a1a;text-align:center;">
          ${this.dispatchPrintItemRowsHtml(b.items || [])}
        </tbody>
      </table>

      <div style="display:flex;gap:20px;margin-bottom:24px;min-height:40px;page-break-inside:avoid;break-inside:avoid;">
        <div style="flex:1;padding-top:6px;border-top:1px solid #ccc;">
          <div style="font-size:9px;color:${BRAND};text-transform:uppercase;letter-spacing:1px;font-weight:700;margin-bottom:4px;-webkit-print-color-adjust:exact;print-color-adjust:exact;">Remarks</div>
          <span style="white-space:pre-wrap;font-size:11px;color:#444;line-height:1.5;">${escapeHtml(b.remarks || '')}</span>
        </div>
      </div>

      <div style="display:flex;justify-content:flex-end;page-break-inside:avoid;break-inside:avoid;">
        <div style="width:180px;text-align:center;padding-top:5px;border-top:2px solid ${BRAND};-webkit-print-color-adjust:exact;print-color-adjust:exact;">
          <span style="font-size:10px;color:#666;letter-spacing:0.5px;font-style:italic;">Authorized Signatory</span>
        </div>
      </div>
    </div>`;
  },

  async bulkDeleteDispatch() {
    const selected = App.State.selectedDispatch.slice();
    if (!selected.length) return;

    // Same shifted/modified-bill guard as the single delete() below -- lets
    // the server skip (not blindly delete) any bill that no longer matches
    // what was on screen when it was selected. Item count + total qty is a
    // cheap fingerprint of the whole bill (see deleteDispatch's own
    // docstring for why both, not just one).
    const expectedBills = (App.State.globalDispatchBills || [])
      .filter(b => App.Selection.isSelected(selected, b.dispatchNumber))
      .map(b => ({ dispatchNumber: b.dispatchNumber, expectedItemCount: (b.items || []).length, expectedTotalQty: b.totalQty }));

    App.Utils.confirmAction(
      `Are you sure you want to permanently delete ${selected.length} selected dispatch bill(s)? This will increase the Ready to Dispatch quantity for the affected products.`,
      async () => {
        try {
          const res = await Api.mutate('deleteDispatchBulk', selected, expectedBills);
          App.Utils.showToast(res.message, !res.success);
          if (res.success) {
            App.State.selectedDispatch = [];
            await this.loadDispatchData();
            await this.loadReadyData();
          }
        } catch (err) {
          App.Utils.showToast(err.message || 'Failed to delete dispatch bills', true);
        }
      }
    );
  },

  delete(dispatchNumber, itemCount, totalQty) {
    App.Utils.confirmAction(
      `Are you sure you want to permanently delete Dispatch "${dispatchNumber}" (${itemCount} item(s), Qty: ${totalQty})? This will increase the Ready to Dispatch quantity for the affected products.`,
      async () => {
        try {
          const res = await Api.mutate('deleteDispatch', dispatchNumber, itemCount, totalQty);
          App.Utils.showToast(res.message, !res.success);
          if (res.success) {
            await this.loadDispatchData();
            await this.loadReadyData();
          }
        } catch (err) {
          App.Utils.showToast(err.message || 'Failed to delete dispatch bill', true);
        }
      }
    );
  },

  // ── Line-item grid (Create/Edit modal) ─────────────────────
  // One <tr> per line: a Ready-to-Dispatch product picker, Qty, an optional
  // Rate, and a computed (read-only) Amount cell. Mirrors po.js's
  // addRow/getRowHtml + the shared data-action="remove-row" delegate
  // (App.Utils.removeRow, core.js) -- same pattern, Dispatch's own fields.
  dispatchLineRowHtml(line) {
    line = line || {};
    const qty = line.qty ?? '';
    const rate = line.rate ?? '';
    return `<tr>
      <td>
        <select class="form-select form-select-sm dispatch-line-product" required onchange="App.Dispatch.handleDispatchLineProductChange(this)"></select>
      </td>
      <td>
        <input type="number" class="form-control form-control-sm dispatch-line-qty" min="0.001" step="any" value="${escapeHtml(String(qty))}" placeholder="0" required oninput="App.Dispatch.handleDispatchLineQtyOrRateChange(this)">
        <small class="text-muted dispatch-line-avail"></small>
      </td>
      <td>
        <input type="number" class="form-control form-control-sm dispatch-line-rate" min="0" step="any" value="${escapeHtml(String(rate))}" placeholder="optional" oninput="App.Dispatch.handleDispatchLineQtyOrRateChange(this)">
      </td>
      <td class="text-end dispatch-line-amount">&#8211;</td>
      <td class="text-center">
        <button type="button" class="btn btn-sm btn-outline-danger" data-action="remove-row" title="Remove"><i class="bi bi-x-lg"></i></button>
      </td>
    </tr>`;
  },

  addDispatchLineRow(line) {
    const tbody = document.getElementById('dispatchLinesBody');
    if (!tbody) return;
    tbody.insertAdjacentHTML('beforeend', this.dispatchLineRowHtml(line));
    const row = tbody.lastElementChild;
    this.populateDispatchLineProductSelect(row.querySelector('.dispatch-line-product'), line?.productId);
    this.recalcDispatchLineAmount(row);
    this.refreshDispatchLineHints();
  },

  // Ready-to-Dispatch options for one line's product picker. `preselect` is
  // kept selectable even if its readyQty is currently exhausted (e.g.
  // reopening a saved line whose product has since sold out elsewhere), so
  // editing a bill never silently drops a line's product choice.
  populateDispatchLineProductSelect(select, preselect) {
    if (!select) return;
    let html = '<option value="">Choose a Product...</option>';
    (App.State.globalReadyToDispatch || []).forEach(r => {
      html += `<option value="${escapeHtml(r.productId)}" data-product-name="${escapeHtml(r.productName)}">${escapeHtml(r.productName)} (${escapeHtml(r.productId)}) — Ready: ${App.Production.formatQty(r.readyQty)}</option>`;
    });
    select.innerHTML = html;
    if (preselect) {
      if (!Array.from(select.options).some(o => o.value === preselect)) {
        select.add(new Option(preselect, preselect));
      }
      select.value = preselect;
    }
  },

  handleDispatchLineProductChange(select) {
    this.recalcDispatchLineAmount(select.closest('tr'));
    this.refreshDispatchLineHints();
    this.refreshLogisticsCostHint();
  },

  handleDispatchLineQtyOrRateChange(input) {
    this.recalcDispatchLineAmount(input.closest('tr'));
    this.refreshDispatchLineHints();
    this.refreshLogisticsCostHint();
  },

  recalcDispatchLineAmount(row) {
    if (!row) return;
    const qty = toNumber(row.querySelector('.dispatch-line-qty')?.value);
    const rate = toNumber(row.querySelector('.dispatch-line-rate')?.value);
    const amountCell = row.querySelector('.dispatch-line-amount');
    if (amountCell) amountCell.innerText = rate ? formatCurrency(qty * rate) : '–';
  },

  // Client-side mirror of the server's availability guard -- informational
  // only, the server is authoritative at save time (see saveDispatch's own
  // per-line cumulative check). For each row, sums qty used by OTHER rows
  // of the same product in the currently-open form, and credits back this
  // bill's own original qty for that product when editing (dispatchEdit
  // OriginalQtyByProduct, populated in openEditDispatchModal).
  refreshDispatchLineHints() {
    const rows = $$('#dispatchLinesBody tr');
    const usedByProduct = new Map();
    rows.forEach(row => {
      const pid = row.querySelector('.dispatch-line-product')?.value;
      if (!pid) return;
      const qty = toNumber(row.querySelector('.dispatch-line-qty')?.value);
      const key = pid.toLowerCase();
      usedByProduct.set(key, (usedByProduct.get(key) || 0) + qty);
    });

    const originalByProduct = App.State.dispatchEditOriginalQtyByProduct || {};

    rows.forEach(row => {
      const select = row.querySelector('.dispatch-line-product');
      const avail = row.querySelector('.dispatch-line-avail');
      if (!select || !avail) return;
      const pid = select.value;
      if (!pid) { avail.innerText = ''; return; }
      const key = pid.toLowerCase();
      const ready = (App.State.globalReadyToDispatch || []).find(r => r.productId === pid);
      const readyQty = ready ? ready.readyQty : 0;
      const available = readyQty + (originalByProduct[key] || 0);
      avail.innerText = `Available: ${App.Production.formatQty(available)} unit(s) (this bill uses ${App.Production.formatQty(usedByProduct.get(key) || 0)})`;
    });
  },

  serializeDispatchLines() {
    return $$('#dispatchLinesBody tr').map(row => {
      const select = row.querySelector('.dispatch-line-product');
      const option = select?.selectedOptions?.[0];
      return {
        productId: select?.value || '',
        productName: option?.dataset.productName || '',
        qty: toNumber(row.querySelector('.dispatch-line-qty')?.value),
        rate: toNumber(row.querySelector('.dispatch-line-rate')?.value)
      };
    }).filter(l => l.productId && l.qty > 0);
  },

  // ── Modal: Create / Edit Dispatch ──────────────────────────
  // Populates the optional PI/Order dropdown with open order-lines (pending
  // qty > 0). `currentValue` ("orderNumber|productId") is always kept
  // selectable even if its pending qty is exhausted, so editing an existing
  // dispatch line doesn't lose its order reference. globalDispatch stays
  // flat, so this aggregation is unchanged from the pre-redesign version
  // except for which bill's own lines get excluded while editing (by
  // dispatchNumber now, not a single rowIdx -- a bill can have several
  // lines against the same order/product).
  populateDispatchOrderSelect(currentValue) {
    const select = document.getElementById('dispatchOrderSelect');
    if (!select) return;

    const editingDispatchNumber = document.getElementById('dispatchNumberHidden')?.value || '';

    const dispatchedByKey = new Map();
    (App.State.globalDispatch || []).forEach(d => {
      if (editingDispatchNumber && d.dispatchNumber === editingDispatchNumber) return;
      const key = `${d.orderNumber}|${d.productId}`;
      dispatchedByKey.set(key, (dispatchedByKey.get(key) || 0) + (Number(d.qty) || 0));
    });

    let html = '<option value="">— Direct Supply (No Order) —</option>';
    (App.State.globalOrders || []).forEach(o => {
      if (o.status !== 'Order Confirmed') return;

      (o.lines || []).forEach(line => {
        const dispatched = dispatchedByKey.get(`${o.orderNumber}|${line.productId}`) || 0;
        const pending = (Number(line.qty) || 0) - dispatched;
        const value = `${o.orderNumber}|${line.productId}`;
        if (pending <= 0.0001 && value !== currentValue) return;

        html += `<option value="${escapeHtml(value)}"
      data-order="${escapeHtml(o.orderNumber)}"
      data-client="${escapeHtml(o.clientName)}">
      ${escapeHtml(o.orderNumber)} - ${escapeHtml(o.clientName)} - ${escapeHtml(line.productName)} (Pending: ${App.Production.formatQty(pending)})
    </option>`;
      });
    });

    select.innerHTML = html;
    if (currentValue) select.value = currentValue;
  },

  handleDispatchOrderChange(value) {
    const select = document.getElementById('dispatchOrderSelect');
    const option = select?.selectedOptions?.[0];

    if (!value || !option || !option.dataset.order) {
      document.getElementById('dispatchOrderNumber').value = '';
      return;
    }

    document.getElementById('dispatchOrderNumber').value = option.dataset.order;

    const clientSelect = document.getElementById('dispatchClientSelect');
    if (clientSelect) {
      clientSelect.value = option.dataset.client || '';
      if (window.jQuery?.fn?.select2 && window.jQuery(clientSelect).data('select2'))
        window.jQuery(clientSelect).trigger('change.select2');
    }
  },

  // `originalQty` adds back this dispatch's own quantity when editing, since
  // the computed Ready Qty already has it subtracted out.
  updateDispatchQtyHelp(productId, originalQty = 0) {
    const help = document.getElementById('dispatchQtyHelp');
    if (!help) return;

    const entry = (App.State.globalReadyToDispatch || []).find(r => r.productId === productId);
    const ready = entry ? entry.readyQty : 0;
    const available = ready + originalQty;
    help.innerText = productId ? `Available to Dispatch: ${App.Production.formatQty(available)} unit(s)` : '';
  },

  openCreateDispatchModal(prefillProductId) {
    const form = document.getElementById('dispatchForm');
    if (form) form.reset();

    document.getElementById('dispatchNumberHidden').value = '';
    document.getElementById('dispatchVisibleNumber').value = '';
    document.getElementById('dispatchDate').value = todayIso();
    App.State.dispatchEditOriginalQtyByProduct = {};

    this.populateDispatchOrderSelect('');
    document.getElementById('dispatchOrderNumber').value = '';

    const dispatchClientEl = document.getElementById('dispatchClientSelect');
    if (window.jQuery?.fn?.select2 && window.jQuery(dispatchClientEl).data('select2'))
      window.jQuery(dispatchClientEl).select2('destroy');
    App.Client.populateClientSelect(dispatchClientEl);
    if (dispatchClientEl && window.jQuery?.fn?.select2) {
      const $modal = window.jQuery(dispatchClientEl).closest('.modal');
      window.jQuery(dispatchClientEl).select2({
        placeholder: 'Choose a Client...',
        width: '100%',
        matcher: App.Utils.select2Matcher,
        dropdownParent: $modal.length ? $modal : window.jQuery(document.body)
      });
    }

    document.getElementById('dispatchLinesBody').innerHTML = '';
    this.addDispatchLineRow(prefillProductId ? { productId: prefillProductId, qty: '' } : null);

    this.initLogisticsContractorSelect2('');
    document.getElementById('dispatchLogisticsCostHint').innerText = '';

    document.getElementById('dispatchFormTitle').innerText = 'New Dispatch';
    document.getElementById('dispatchSubmitBtn').innerText = 'Save Dispatch';

    App.Utils.setFormButtonsForMode('dispatchCancelBtn', 'dispatchExitBtn', 'dispatchSubmitBtn', false, 'Save Dispatch');
    App.Nav.clear('dispatchModal');
    safeModalShow('dispatchModal');
  },

  // Initializes a searchable Select2 on Logistics Contractor, same pattern
  // as Production's Assigned To and BOM's cost-row Contractor fields.
  initLogisticsContractorSelect2(currentValue) {
    const selectEl = document.getElementById('dispatchLogisticsContractor');
    if (!selectEl || !window.jQuery?.fn?.select2) return;

    const $select = window.jQuery(selectEl);
    if ($select.data('select2')) $select.select2('destroy');
    selectEl.innerHTML = '';
    if (currentValue) selectEl.add(new Option(currentValue, currentValue, true, true));

    const $parentModal = $select.closest('.modal');

    $select.select2({
      placeholder: 'Search or type a logistics contractor...',
      width: '100%',
      tags: true,
      allowClear: true,
      matcher: App.Utils.select2Matcher,
      dropdownParent: $parentModal.length ? $parentModal : window.jQuery(document.body),
      data: (App.State.globalContractors || []).map(c => ({ id: c.contractorName, text: c.contractorName })),
      createTag(params) {
        const term = (params.term || '').trim();
        if (!term) return null;
        // Resolve to an existing contractor differing only by case/whitespace
        // instead of minting a second, differently-cased entry for the
        // same real contractor (e.g. typing "seat" when "Seat" is on file).
        const existing = (App.State.globalContractors || []).find(c => App.Utils.sameText(c.contractorName, term));
        if (existing) return { id: existing.contractorName, text: existing.contractorName };
        return { id: term, text: term, newTag: true };
      }
    });

    // Same Select2 v4 synchronous re-entrant double-'change' quirk as
    // Production's initContractorSelect2 -- see its comment for details.
    // Namespaced for the same reason too: plain `.off('change')` strips
    // Select2's own internal 'change.select2' listener that repaints the
    // visible selection box, leaving the underlying value updated but
    // the on-screen label frozen on the old selection.
    let handlingChange = false;
    $select.off('change.dispatchLogisticsContractor').on('change.dispatchLogisticsContractor', () => {
      if (handlingChange) return;
      handlingChange = true;
      Promise.resolve().then(() => { handlingChange = false; });
      this.refreshLogisticsCostHint();
    });
  },

  // Fetches and displays the logistics cost estimate for the current
  // Logistics Contractor + this form's TOTAL qty across every line, so the
  // operator sees the cost before save. Purely advisory -- the server
  // independently recomputes and persists the authoritative logisticsCost
  // (per line, rate * that line's own qty) itself on save, never trusting
  // this client-side figure.
  async refreshLogisticsCostHint() {
    const hintEl = document.getElementById('dispatchLogisticsCostHint');
    if (!hintEl) return;

    const contractorName = document.getElementById('dispatchLogisticsContractor')?.value;
    const totalQty = $$('#dispatchLinesBody .dispatch-line-qty').reduce((sum, el) => sum + toNumber(el.value), 0);

    if (!contractorName || !totalQty) {
      hintEl.innerText = '';
      return;
    }

    try {
      const res = await Api.call('getContractorRateForProcess', contractorName, 'Dispatch / Logistics');
      const rate = res.success ? toNumber(res.data?.ratePerUnit) : 0;
      if (!rate) {
        hintEl.innerText = `No rate card entry for "${contractorName}" / Dispatch / Logistics — cost will be 0.`;
        return;
      }
      hintEl.innerText = `Logistics Cost: ${formatCurrency(totalQty * rate)} (${totalQty} x ${rate}/unit, across all lines)`;
    } catch (err) {
      hintEl.innerText = '';
    }
  },

  openEditDispatchModal(dispatchNumber) {
    const b = (App.State.globalDispatchBills || []).find(x => x.dispatchNumber === dispatchNumber);
    if (!b) return;

    const form = document.getElementById('dispatchForm');
    if (form) form.reset();

    document.getElementById('dispatchNumberHidden').value = b.dispatchNumber;
    document.getElementById('dispatchVisibleNumber').value = b.dispatchNumber;

    let inputDateStr = todayIso();
    if (b.dispatchDate && b.dispatchDate.includes('/')) {
      const [day, month, year] = b.dispatchDate.split('/');
      inputDateStr = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    } else if (b.dateRaw) {
      inputDateStr = b.dateRaw.split('T')[0];
    }
    document.getElementById('dispatchDate').value = inputDateStr;
    document.getElementById('dispatchTransport').value = b.transport || '';
    document.getElementById('dispatchInvoiceNumber').value = b.invoiceNumber || '';
    document.getElementById('dispatchPrivateMark').value = b.privateMark || '';
    document.getElementById('dispatchGrNumber').value = b.grNumber || '';
    document.getElementById('dispatchRemarks').value = b.remarks || '';

    // This bill's own currently-saved qty per product -- credited back onto
    // each line's availability hint, matching the server's own edit-mode
    // guard credit (see save_dispatch's original_qty_by_product).
    const originalByProduct = {};
    (b.items || []).forEach(i => {
      const key = String(i.productId || '').toLowerCase();
      originalByProduct[key] = (originalByProduct[key] || 0) + (Number(i.qty) || 0);
    });
    App.State.dispatchEditOriginalQtyByProduct = originalByProduct;

    const firstItem = (b.items || [])[0];
    this.populateDispatchOrderSelect(b.orderNumber && firstItem ? `${b.orderNumber}|${firstItem.productId}` : '');
    document.getElementById('dispatchOrderNumber').value = b.orderNumber || '';

    const editDispatchClientEl = document.getElementById('dispatchClientSelect');
    if (window.jQuery?.fn?.select2 && window.jQuery(editDispatchClientEl).data('select2'))
      window.jQuery(editDispatchClientEl).select2('destroy');
    App.Client.populateClientSelect(editDispatchClientEl);
    if (editDispatchClientEl) editDispatchClientEl.value = b.clientName || '';
    if (editDispatchClientEl && window.jQuery?.fn?.select2) {
      const $modal = window.jQuery(editDispatchClientEl).closest('.modal');
      window.jQuery(editDispatchClientEl).select2({
        placeholder: 'Choose a Client...',
        width: '100%',
        matcher: App.Utils.select2Matcher,
        dropdownParent: $modal.length ? $modal : window.jQuery(document.body)
      });
      window.jQuery(editDispatchClientEl).trigger('change.select2');
    }

    document.getElementById('dispatchLinesBody').innerHTML = '';
    (b.items && b.items.length ? b.items : [null]).forEach(item => this.addDispatchLineRow(item));

    this.initLogisticsContractorSelect2(b.logisticsContractor || '');
    this.refreshLogisticsCostHint();

    document.getElementById('dispatchFormTitle').innerText = `Edit Dispatch: ${b.dispatchNumber}`;
    document.getElementById('dispatchSubmitBtn').innerText = 'Update Dispatch';

    App.Utils.setFormButtonsForMode('dispatchCancelBtn', 'dispatchExitBtn', 'dispatchSubmitBtn', true, 'Update Dispatch');
    App.Nav.register(
      'dispatchModal',
      (App.State.filteredDispatchBills || []).map(x => x.dispatchNumber),
      b.dispatchNumber,
      (dispatchNumber) => this.openEditDispatchModal(String(dispatchNumber))
    );
    safeModalShow('dispatchModal');
  }
};

// Wire up Dispatch form submission
document.addEventListener('DOMContentLoaded', function () {
  const dispatchForm = document.getElementById('dispatchForm');
  if (dispatchForm) {
    dispatchForm.onsubmit = async function (e) {
      e.preventDefault();
      const formData = Object.fromEntries(new FormData(this));
      const isEdit = !!formData.existingDispatchNumber;
      formData.lines = JSON.stringify(App.Dispatch.serializeDispatchLines());

      if (JSON.parse(formData.lines).length === 0) {
        App.Utils.showToast('Please add at least one item with a Product and Quantity greater than zero.', true);
        return;
      }

      const btn = document.getElementById('dispatchSubmitBtn');
      if (btn) btn.disabled = true;

      try {
        const res = await Api.mutate('saveDispatch', formData);
        if (res.success) {
          await App.Dispatch.loadReadyData();

          if (isEdit) {
            // Save (edit mode): patch just this one bill's lines + <tr> in
            // place instead of a full loadDispatchData() reload -- falls
            // back to a full reload if the bill can't be patched.
            const patched = res.data && res.data.rows
              ? App.Dispatch.patchBillInPlace(res.data.rows)
              : false;
            if (!patched) await App.Dispatch.loadDispatchData();

            // Stay open on the SAME bill instead of closing -- Exit
            // (App.Nav.exit) is the only way to close from here now.
            if ((App.State.globalDispatchBills || []).some(x => x.dispatchNumber === res.data.dispatchNumber)) {
              App.Dispatch.openEditDispatchModal(res.data.dispatchNumber);
            } else {
              safeModalHide('dispatchModal');
            }
          } else {
            // A brand-new bill's sorted/paginated position can't be
            // determined cheaply on the client -- full reload here (an
            // edit doesn't need to, see App.Dispatch.patchBillInPlace).
            await App.Dispatch.loadDispatchData();
            App.Dispatch.openCreateDispatchModal('');
          }
        }
        App.Utils.showToast(res.message, !res.success, res.success
          ? { type: 'dispatch', value: res.data?.dispatchNumber || formData.existingDispatchNumber }
          : null);
      } catch (err) {
        App.Utils.showToast(err.message || 'Failed to save dispatch', true);
      } finally {
        if (btn) btn.disabled = false;
      }
    };
  }

  // Delegated: remove a line-item row from the dispatch modal's grid, same
  // shared handler as PO/Bill's own line-item removal (won't remove the
  // last remaining row).
  document.getElementById('dispatchLinesBody')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="remove-row"]');
    if (!btn) return;
    App.Utils.removeRow(btn);
    App.Dispatch.refreshDispatchLineHints();
    App.Dispatch.refreshLogisticsCostHint();
  });

  document.getElementById('dispatchAddLineBtn')?.addEventListener('click', () => App.Dispatch.addDispatchLineRow());
});
