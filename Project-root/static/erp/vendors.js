'use strict';
// vendors.js -- App.Vendor, ported from Apps_Script/Script_Vendors.html.
// Talks to already-shipped RPCs (app/erp/services/vendors_service.py):
// getVendorsData/saveVendor/deleteVendor/deleteVendorsBulk -- no backend
// changes needed, form field names match saveVendor's expected keys
// exactly (vendorName/contact/address/gstin/remarks/originalVendorName).
//
// syncFromPOHistory calls syncVendorsFromPOHistory (vendors_service.py),
// now real -- backfills Vendor Master + item-vendor rates from PO history.
//
// The vendor table's own "Pending" badge and the Ledger/Pending Orders/
// Rates tabs inside the profile modal all read App.State.globalPOs/
// globalBills/globalReturns (via calculateLedgerAndPending) -- loadData
// ensureLoads all three alongside Vendor's own data (see below) so this
// always reflects real history, not whatever tabs happened to be visited
// earlier this session. bulkPrint/printLedger are guarded against
// App.Print not existing yet (print pages are their own later round).

App.State.globalVendors = [];
App.State.filteredVendors = [];
App.State.vendorCurrentPage = 1;
App.State.vendorRowsPerPage = 10;
App.State.selectedVendors = [];

App.Vendor = {
  // Mirrors App.Item.ensureLoaded/App.Process.ensureLoaded -- lets a caller
  // outside the Vendor Master tab (e.g. a Bill/Return vendor picker, the
  // Vendor Profile modal's own Ledger tab) guarantee globalVendors is
  // populated without re-fetching if Vendor Master already loaded it.
  async ensureLoaded() {
    if (App.State.globalVendors && App.State.globalVendors.length) return;
    await this.loadData();
  },

  async loadData() {
    const vTbody = document.getElementById('vendorTableBody');
    if (vTbody) vTbody.innerHTML = '<tr><td colspan="6" class="text-center p-4">Loading Vendor Database...</td></tr>';

    try {
      // renderTable's own per-row "Pending" badge (see calculateLedgerAndPending)
      // reads globalPOs/globalBills/globalReturns -- fetched alongside Vendor's
      // own data (not just inside openProfileModal) so the table itself is
      // never showing "All Clear" for a vendor that actually has pending
      // history, just because PO/Bill/Return hadn't been visited yet.
      const [response] = await Promise.all([
        Api.call('getVendorsData'),
        App.PO ? App.PO.ensureLoaded() : Promise.resolve(),
        App.Bill ? App.Bill.ensureLoaded() : Promise.resolve(),
        App.Return ? App.Return.ensureLoaded() : Promise.resolve()
      ]);
      if (!response.success) {
        App.Utils.showToast(response.message, true);
        return;
      }
      App.State.globalVendors = response.data;
      App.State.filteredVendors = response.data;
      App.State.vendorCurrentPage = 1;
      App.State.selectedVendors = [];
      this.renderTable();
      if (App.PO && App.PO.populateVendorSelects) {
        App.PO.populateVendorSelects();
      }
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to load vendors', true);
    }
  },

  filterData(searchTerm) {
    const term = String(searchTerm || '').toLowerCase().trim();
    App.State.filteredVendors = term
      ? App.State.globalVendors.filter(v =>
        App.Utils.matchesKeywords(`${v.name} ${v.contact} ${v.gstin}`, term)
      )
      : App.State.globalVendors;
    App.State.vendorCurrentPage = 1;
    this.renderTable();
  },

  changePage(page) {
    App.State.vendorCurrentPage = App.Utils.clampPage(page, App.State.filteredVendors.length, App.State.vendorRowsPerPage);
    this.renderTable();
  },

  renderTable() {
    const tbody = document.getElementById('vendorTableBody');
    if (!tbody) return;

    const { filteredVendors, vendorCurrentPage: cur, vendorRowsPerPage: rpp } = App.State;
    const start = (cur - 1) * rpp;
    const pageItems = filteredVendors.slice(start, start + rpp);

    const selectAllChk = document.getElementById('selectAllVendors');
    if (selectAllChk) {
      selectAllChk.checked = pageItems.length > 0 &&
        pageItems.every(v => App.Selection.isSelected(App.State.selectedVendors, v.name));
    }

    let html = '';
    pageItems.forEach(v => {
      const { pendingList } = this.calculateLedgerAndPending(v.name);
      const pendingCount = pendingList.reduce((sum, p) => sum + p.pending, 0);
      const pendingBadge = pendingCount > 0
        ? `<span class="badge bg-warning text-dark">${pendingCount} Units Pending</span>`
        : `<span class="badge bg-success">All Clear</span>`;

      const checkedAttr = App.Selection.isSelected(App.State.selectedVendors, v.name) ? 'checked' : '';
      html += `<tr>
        <td class="text-center">
          <input type="checkbox" class="form-check-input vendor-select-chk" data-key="${escapeHtml(v.name)}" ${checkedAttr} onchange="App.Vendor.onRowSelectChange()">
        </td>
        <td><strong class="text-dark fs-5">${escapeHtml(App.Utils.formatNameCase(v.name))}</strong></td>
        <td>
          <div><small class="text-muted">Ph:</small> ${escapeHtml(v.contact) || '-'}</div>
          <div><small class="text-muted">Add:</small> ${escapeHtml(v.address) || '-'}</div>
        </td>
        <td><span class="badge bg-light text-dark border">${v.gstin || 'No GSTIN'}</span></td>
        <td>${pendingBadge}</td>
        <td>
          <button class="btn btn-sm btn-outline-dark fw-bold btn-action w-100" data-vendor-name="${escapeHtml(v.name)}" onclick="App.Vendor.openProfileModal(this.dataset.vendorName)">View Profile / Ledger</button>
          <button class="btn btn-sm btn-outline-danger btn-action w-100 mt-1" data-vendor-name="${escapeHtml(v.name)}" onclick="App.Vendor.delete(this.dataset.vendorName)">Delete</button>
        </td>
      </tr>`;
    });

    tbody.innerHTML = html || ((App.State.globalVendors || []).length === 0
      ? '<tr><td colspan="6" class="text-center text-muted p-4">No vendors yet — register one with <strong>+ Register New Vendor</strong>.</td></tr>'
      : '<tr><td colspan="6" class="text-center text-muted p-4">No vendors match your search.</td></tr>');

    App.Utils.renderPagination('vendorPagination', filteredVendors.length, cur, rpp, 'vendor-page', 'Vendors');
    this.updateBulkButtons();
  },

  toggleSelectAll(masterChk) {
    App.Selection.toggleAll(App.State.selectedVendors, 'vendor-select-chk', masterChk);
    this.updateBulkButtons();
  },

  onRowSelectChange() {
    App.Selection.syncFromRows(App.State.selectedVendors, 'vendor-select-chk', 'selectAllVendors');
    this.updateBulkButtons();
  },

  updateBulkButtons() {
    const count = App.State.selectedVendors.length;
    App.Selection.updateButton('btnBulkDeleteVendors', count, '<i class="bi bi-trash"></i> Delete Selected');
    App.Selection.updateButton('btnBulkPrintVendors', count, '<i class="bi bi-printer"></i> Print Selected');
    App.Selection.updateButton('btnBulkDownloadPdfVendors', count, '<i class="bi bi-file-earmark-pdf"></i> Download PDFs');
  },

  async bulkDelete() {
    const selected = App.State.selectedVendors;
    if (!selected.length) return;

    App.Utils.confirmAction(
      `Are you sure you want to delete ${selected.length} selected vendor(s) from the Master list? (Historical POs/Bills will not be deleted).`,
      async () => {
        try {
          const res = await Api.mutate('deleteVendorsBulk', selected);
          App.Utils.showToast(res?.message || 'Delete completed.', !res?.success);
          if (res?.success) {
            App.State.selectedVendors = [];
            await this.loadData();
          }
        } catch (err) {
          App.Utils.showToast(err.message || 'Failed to delete vendors.', true);
        }
      }
    );
  },

  async bulkPrint() {
    const selected = App.State.selectedVendors;
    if (!selected.length) {
      App.Utils.showToast('No vendors selected.', true);
      return;
    }
    if (typeof App.Print === 'undefined') {
      App.Utils.notPortedYet('Printing');
      return;
    }

    const vendors = App.State.globalVendors.filter(v => App.Selection.isSelected(selected, v.name));
    if (!vendors.length) return;

    if (typeof App.Issue !== 'undefined' && !App.State.globalIssues.length) {
      await App.Issue.loadData();
    }

    App.Print.triggerBulk(
      vendors,
      vendor => this.buildVendorLedgerPrintPageHtml(vendor),
      'Vendor_Ledgers_Selected'
    );
  },

  async bulkDownloadPDF() {
    const selected = App.State.selectedVendors;
    if (!selected.length) {
      App.Utils.showToast('No vendors selected.', true);
      return;
    }

    const vendors = App.State.globalVendors.filter(v => App.Selection.isSelected(selected, v.name));
    if (!vendors.length) return;

    if (typeof App.Issue !== 'undefined' && !App.State.globalIssues.length) {
      await App.Issue.loadData();
    }

    const count = await App.Print.downloadSeparatePDFs(
      vendors,
      vendor => this.buildVendorLedgerPrintPageHtml(vendor),
      vendor => `Vendor_Ledger_${App.Print.sanitizeFilename(String(vendor.name || 'Vendor'), false)}.pdf`,
      { progressButtonId: 'btnBulkDownloadPdfVendors' }
    );
    App.Print.reportBulkResult(count, vendors.length, 'vendor ledger PDF');
  },

  switchTab(tabId) {
    document.querySelectorAll('.vendor-tab-content').forEach(t => t.style.display = 'none');
    document.getElementById(tabId).style.display = 'block';

    document.querySelectorAll('#vendorTabs .nav-link').forEach(btn => {
      btn.classList.remove('active', 'bg-warning');
    });
    const activeBtn = document.getElementById('btn-' + tabId);
    if (activeBtn) {
      activeBtn.classList.add('active', 'bg-warning');
    }
  },

  openCreateModal() {
    const vForm = document.getElementById('vendorForm');
    if (vForm) vForm.reset();
    document.getElementById('originalVendorName').value = '';
    document.getElementById('vendorProfileTitle').innerText = 'Register New Vendor';
    document.getElementById('vendorSubmitBtn').innerText = 'Register Vendor';

    this.switchTab('v-profile');

    document.getElementById('btn-v-ledger').parentElement.style.display = 'none';
    document.getElementById('btn-v-pending').parentElement.style.display = 'none';

    const ratesSec = document.getElementById('v-profile-rates-section');
    if (ratesSec) ratesSec.style.display = 'none';

    const printBtn = document.getElementById('btn-print-vendor-ledger');
    if (printBtn) printBtn.style.display = 'none';

    const modalEl = document.getElementById('vendorProfileModal');
    if (modalEl && typeof bootstrap !== 'undefined') new bootstrap.Modal(modalEl).show();
  },

  async openProfileModal(vendorName) {
    const vendor = App.State.globalVendors.find(v => App.Utils.sameText(v.name, vendorName));
    if (!vendor) return;

    if (typeof App.Issue !== 'undefined' && !App.State.globalIssues.length) {
      await App.Issue.loadData();
    }

    const vForm = document.getElementById('vendorForm');
    if (vForm) vForm.reset();

    document.getElementById('originalVendorName').value = vendor.name;
    document.getElementById('vFormName').value = vendor.name;
    document.getElementById('vFormContact').value = vendor.contact;
    document.getElementById('vFormAddress').value = vendor.address;
    document.getElementById('vFormGstin').value = vendor.gstin;
    document.getElementById('vFormRemarks').value = vendor.remarks;

    document.getElementById('vendorProfileTitle').innerText = `Vendor Dashboard: ${App.Utils.formatNameCase(vendor.name)}`;
    document.getElementById('vendorSubmitBtn').innerText = 'Update Profile Info';

    document.getElementById('btn-v-ledger').parentElement.style.display = 'block';
    document.getElementById('btn-v-pending').parentElement.style.display = 'block';

    const ratesSec = document.getElementById('v-profile-rates-section');
    if (ratesSec) ratesSec.style.display = 'block';

    const printBtn = document.getElementById('btn-print-vendor-ledger');
    if (printBtn) printBtn.style.display = 'inline-block';

    this.switchTab('v-profile');
    this.populateLedgerAndPending(vendor.name);

    const modalEl = document.getElementById('vendorProfileModal');
    if (modalEl && typeof bootstrap !== 'undefined') new bootstrap.Modal(modalEl).show();
  },

  calculateLedgerAndPending(vendorName) {
    const vendorPOs = App.State.globalPOs.filter(po => App.Utils.sameText(po.vendor, vendorName));
    const vendorBills = App.State.globalBills.filter(b => App.Utils.sameText(b.vendor, vendorName));
    const vendorReturns = (App.State.globalReturns || []).filter(r => App.Utils.sameText(r.vendor, vendorName));
    const vendorIssues = (App.State.globalIssues || []).filter(iss => App.Utils.sameText(iss.vendor, vendorName));

    let ledger = [];
    vendorPOs.forEach(po => {
      ledger.push({
        dateObj: parseRecordDate(po.poDateRaw, po.poDate),
        dateStr: po.poDate,
        type: 'PO Issued',
        ref: `PO-${po.poNumber}`,
        items: po.items.map(i => `${escapeHtml(i.name)} (${escapeHtml(String(i.qty))})`).join(', '),
        orderQty: po.items.reduce((sum, i) => sum + toNumber(i.qty), 0),
        incomingQty: 0,
        outgoingQty: 0,
        value: po.grandTotal,
        badgeClass: 'bg-primary'
      });
    });

    vendorBills.forEach(b => {
      const itemsStr = b.items.length
        ? (typeof b.items[0] === 'object'
          ? b.items.map(i => `${escapeHtml(i.name)} (${escapeHtml(String(i.qty))})`).join(', ')
          : b.items.map(s => escapeHtml(String(s))).join(', '))
        : '';
      const billQty = typeof b.items[0] === 'object'
        ? b.items.reduce((sum, i) => sum + toNumber(i.qty), 0)
        : 0;
      ledger.push({
        dateObj: parseRecordDate(b.billDateRaw, b.billDate),
        dateStr: b.billDate,
        type: 'Bill Received',
        ref: b.billNumber,
        items: itemsStr,
        orderQty: 0,
        incomingQty: billQty,
        outgoingQty: 0,
        value: b.totalAmount,
        badgeClass: 'bg-success'
      });
    });

    vendorReturns.forEach(r => {
      const itemsStr = (r.items || []).map(i => `${escapeHtml(i.name)} (${escapeHtml(String(i.qty))})`).join(', ');
      const returnQty = (r.items || []).reduce((sum, i) => sum + toNumber(i.qty), 0);
      ledger.push({
        dateObj: parseRecordDate(r.returnDateRaw, r.returnDate),
        dateStr: r.returnDate,
        type: 'Goods Returned',
        ref: r.returnNumber,
        items: itemsStr,
        orderQty: 0,
        incomingQty: 0,
        outgoingQty: returnQty,
        value: r.totalAmount,
        badgeClass: 'bg-danger'
      });
    });

    vendorIssues.forEach(iss => {
      const itemsStr = (iss.items || []).map(i => `${escapeHtml(i.name)} (${escapeHtml(String(i.qty))})`).join(', ');
      ledger.push({
        dateObj: parseRecordDate(iss.dateRaw, iss.date),
        dateStr: iss.date,
        type: 'Stock Issued',
        ref: iss.issueId,
        items: itemsStr,
        orderQty: 0,
        incomingQty: 0,
        outgoingQty: toNumber(iss.totalQty),
        value: toNumber(iss.totalValue) || 0,
        badgeClass: 'bg-warning text-dark'
      });
    });

    ledger.sort((a, b) => b.dateObj - a.dateObj);

    let itemMap = {};

    vendorPOs.forEach(po => {
      po.items.forEach(i => {
        const key = `${i.name}|${i.size || ''}`;
        if (!itemMap[key]) itemMap[key] = { name: i.name, size: i.size, ordered: 0, received: 0 };
        itemMap[key].ordered += (Number(i.qty) || 0);
      });
    });

    vendorBills.forEach(b => {
      b.items.forEach(i => {
        const name = typeof i === 'object' ? i.name : String(i).split(' [')[0];
        const size = typeof i === 'object' ? (i.size || '') : '';
        const qty = typeof i === 'object' ? (Number(i.qty) || 0) : 0;
        const key = `${name}|${size}`;
        if (itemMap[key]) {
          itemMap[key].received += qty;
        }
      });
    });

    const pendingList = Object.values(itemMap)
      .map(item => ({ ...item, pending: item.ordered - item.received }))
      .filter(item => item.pending !== 0);

    return { ledger, pendingList };
  },

  populateLedgerAndPending(vendorName) {
    const { ledger, pendingList } = this.calculateLedgerAndPending(vendorName);

    const lBody = document.getElementById('vendorLedgerBody');
    if (lBody) {
      let lHtml = '';
      ledger.forEach(entry => {
        lHtml += `<tr>
          <td>${entry.dateStr}</td>
          <td><span class="badge ${entry.badgeClass}">${entry.type}</span></td>
          <td><strong class="text-dark">${entry.ref}</strong></td>
          <td><small class="text-muted">${entry.items}</small></td>
          <td class="text-center text-primary fw-bold">${entry.orderQty || '-'}</td>
          <td class="text-center text-success fw-bold">${entry.incomingQty || '-'}</td>
          <td class="text-center text-danger fw-bold">${entry.outgoingQty || '-'}</td>
          <td class="fw-bold text-end">${formatCurrency(entry.value)}</td>
        </tr>`;
      });
      lBody.innerHTML = lHtml || '<tr><td colspan="8" class="text-center text-muted p-4">No transaction history found.</td></tr>';
    }

    const pBody = document.getElementById('vendorPendingBody');
    if (pBody) {
      let pHtml = '';
      pendingList.forEach(item => {
        const isOver = 0 > item.pending;
        pHtml += `<tr>
          <td><strong class="text-primary">${item.name}</strong></td>
          <td>${item.size || '-'}</td>
          <td class="text-center">${item.ordered}</td>
          <td class="text-center">${item.received}</td>
          <td class="${isOver ? 'text-success' : 'text-danger'} fw-bold text-center">
            ${isOver ? '+' : ''}${Math.abs(item.pending)} ${isOver ? '(Over-Delivered)' : ''}
          </td>
        </tr>`;
      });
      pBody.innerHTML = pHtml || '<tr><td colspan="5" class="text-center text-success fw-bold p-4">No pending orders. All caught up!</td></tr>';
    }

    const rBody = document.getElementById('vendorRatesBody');
    if (rBody) {
      const activeVendorLower = vendorName.toLowerCase();
      const itemMap = {};

      const getVKey = (name, size) => {
        return `${String(name || '').trim().toLowerCase()}|${String(size || '').trim().toLowerCase()}`;
      };

      const sortedPOs = [...(App.State.globalPOs || [])].sort((a, b) => {
        const ad = parseRecordDate(a.poDateRaw, a.poDate);
        const bd = parseRecordDate(b.poDateRaw, b.poDate);
        return ad - bd;
      });

      sortedPOs.forEach(po => {
        if ((po.vendor || '').toLowerCase() === activeVendorLower) {
          (po.items || []).forEach(item => {
            const key = getVKey(item.name, item.size);
            itemMap[key] = {
              name: item.name,
              size: item.size || '-',
              narration: item.narration || '-',
              masterRate: null,
              latestPoRate: item.price
            };
          });
        }
      });

      (App.State.globalItems || []).forEach(item => {
        const vMap = (item.vendors || []).find(v => (v.vendor || '').toLowerCase() === activeVendorLower);
        if (vMap) {
          const key = getVKey(item.name, item.size);
          if (itemMap[key]) {
            itemMap[key].masterRate = vMap.rate;
          } else {
            itemMap[key] = {
              name: item.name,
              size: item.size || '-',
              narration: item.narration || '-',
              masterRate: vMap.rate,
              latestPoRate: null
            };
          }
        }
      });

      let rHtml = '';
      const itemsList = Object.values(itemMap);
      itemsList.sort((a, b) => {
        const nc = a.name.localeCompare(b.name);
        if (nc !== 0) return nc;
        return a.size.localeCompare(b.size);
      });

      itemsList.forEach(entry => {
        const mRateText = entry.masterRate !== null ? formatCurrency(entry.masterRate) : '-';
        const pRateText = entry.latestPoRate !== null ? formatCurrency(entry.latestPoRate) : '-';
        rHtml += `<tr>
          <td><strong class="text-primary">${escapeHtml(entry.name)}</strong></td>
          <td><small class="text-muted">${escapeHtml(entry.narration)}</small></td>
          <td>${escapeHtml(entry.size)}</td>
          <td class="text-end fw-bold">${mRateText}</td>
          <td class="text-end fw-bold text-success">${pRateText}</td>
        </tr>`;
      });

      rBody.innerHTML = rHtml || '<tr><td colspan="5" class="text-center text-muted p-4">No items supplied by this vendor.</td></tr>';
    }
  },

  printLedger() {
    if (typeof App.Print === 'undefined') {
      App.Utils.notPortedYet('Printing');
      return;
    }
    const originalName = document.getElementById('originalVendorName')?.value;
    if (!originalName) return;

    const nameEl = document.getElementById('print-vendor-name');
    if (nameEl) nameEl.innerText = originalName;
    const gstinEl = document.getElementById('print-vendor-gstin');
    if (gstinEl) gstinEl.innerText = document.getElementById('vFormGstin')?.value || '-';
    const contactEl = document.getElementById('print-vendor-contact');
    if (contactEl) contactEl.innerText = document.getElementById('vFormContact')?.value || '-';
    const addressEl = document.getElementById('print-vendor-address');
    if (addressEl) addressEl.innerText = document.getElementById('vFormAddress')?.value || '-';
    const remarksEl = document.getElementById('print-vendor-remarks');
    if (remarksEl) remarksEl.innerText = document.getElementById('vFormRemarks')?.value || 'No remarks';

    const ledgerSource = document.getElementById('vendorLedgerBody');
    const ledgerDest = document.getElementById('print-vendor-ledger-body');
    if (ledgerSource && ledgerDest) ledgerDest.innerHTML = ledgerSource.innerHTML;

    const pendingSource = document.getElementById('vendorPendingBody');
    const pendingDest = document.getElementById('print-vendor-pending-body');
    if (pendingSource && pendingDest) pendingDest.innerHTML = pendingSource.innerHTML;

    App.Print.trigger('print-vendor-ledger-container', `Vendor_Ledger_${originalName.replace(/[^a-zA-Z0-9_-]/g, '_')}`);
  },

  // Builds a fully self-contained "Vendor Profile & Transaction Ledger"
  // page for bulk printing -- only reachable once App.Print exists
  // (bulkPrint guards this), left as an unmodified port for that round.
  buildVendorLedgerPrintPageHtml(vendor) {
    const BRAND = '#D35400';
    const { ledger, pendingList } = this.calculateLedgerAndPending(vendor.name);

    let ledgerHtml = '';
    ledger.forEach(entry => {
      ledgerHtml += `<tr>
        <td style="padding:6px;border:1px solid #e5e5e5;">${escapeHtml(entry.dateStr)}</td>
        <td style="padding:6px;border:1px solid #e5e5e5;">${escapeHtml(entry.type)}</td>
        <td style="padding:6px;border:1px solid #e5e5e5;font-weight:700;">${escapeHtml(entry.ref)}</td>
        <td style="padding:6px;border:1px solid #e5e5e5;color:#555;">${escapeHtml(entry.items)}</td>
        <td style="padding:6px;border:1px solid #e5e5e5;text-align:center;font-weight:700;">${entry.orderQty || '-'}</td>
        <td style="padding:6px;border:1px solid #e5e5e5;text-align:center;font-weight:700;">${entry.incomingQty || '-'}</td>
        <td style="padding:6px;border:1px solid #e5e5e5;text-align:center;font-weight:700;">-</td>
        <td style="padding:6px;border:1px solid #e5e5e5;text-align:right;font-weight:700;">${formatCurrency(entry.value)}</td>
      </tr>`;
    });
    const ledgerRows = ledgerHtml || '<tr><td colspan="8" style="padding:10px;text-align:center;color:#999;">No transaction history found.</td></tr>';

    let pendingHtml = '';
    pendingList.forEach(item => {
      const isOver = item.pending < 0;
      pendingHtml += `<tr>
        <td style="padding:6px;border:1px solid #e5e5e5;font-weight:700;color:#0d6efd;">${escapeHtml(item.name)}</td>
        <td style="padding:6px;border:1px solid #e5e5e5;">${escapeHtml(item.size || '-')}</td>
        <td style="padding:6px;border:1px solid #e5e5e5;text-align:center;">${item.ordered}</td>
        <td style="padding:6px;border:1px solid #e5e5e5;text-align:center;">${item.received}</td>
        <td style="padding:6px;border:1px solid #e5e5e5;text-align:center;font-weight:700;color:${isOver ? '#198754' : '#dc3545'};">
          ${isOver ? '+' : ''}${Math.abs(item.pending)}${isOver ? ' (Over-Delivered)' : ''}
        </td>
      </tr>`;
    });
    const pendingRows = pendingHtml || '<tr><td colspan="5" style="padding:10px;text-align:center;color:#198754;font-weight:700;">No pending orders. All caught up!</td></tr>';

    return `
    <div style="background:#fff;color:#1a1a1a;font-family:'Segoe UI',Arial,sans-serif;font-size:12px;line-height:1.5;padding:14px 20px 12px 20px;margin:0;box-sizing:border-box;width:100%;border-top:5px solid ${BRAND};border-bottom:3px solid ${BRAND};-webkit-print-color-adjust:exact;print-color-adjust:exact;">
      <div style="text-align:center;padding:4px 0 8px 0;">
        ${App.Print.brandHeaderHtml(BRAND)}
        <div style="font-size:10px;color:#555;margin-top:3px;letter-spacing:0.3px;">
          6-B, SHIV SHAKTI ESTATE, VERKA CHOWK, DEHLON ROAD, BHAGWANPURA, 141114 LUDHIANA
        </div>
        <div style="font-size:11px;color:${BRAND};font-weight:700;margin-top:4px;letter-spacing:1px;text-transform:uppercase;">
          Vendor Profile &amp; Transaction Ledger Report
        </div>
      </div>
      <div style="height:2px;background:${BRAND};margin:0 0 12px 0;-webkit-print-color-adjust:exact;print-color-adjust:exact;"></div>

      <div style="margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid #ccc;page-break-inside:avoid;break-inside:avoid;">
        <div style="display:flex;gap:16px;">
          <div style="flex:1;">
            <div style="margin-bottom:6px;">
              <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Vendor Name</span>
              <div style="font-weight:700;font-size:14px;color:#1a1a1a;margin-top:1px;">${escapeHtml(App.Utils.formatNameCase(vendor.name))}</div>
            </div>
            <div>
              <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">GSTIN</span>
              <div style="font-size:11px;color:#333;margin-top:1px;font-weight:600;">${escapeHtml(vendor.gstin || '-')}</div>
            </div>
          </div>
          <div style="flex:1;">
            <div style="margin-bottom:6px;">
              <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Contact Info</span>
              <div style="font-size:11px;color:#333;margin-top:1px;">${escapeHtml(vendor.contact || '-')}</div>
            </div>
            <div>
              <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Address</span>
              <div style="font-size:11px;color:#333;margin-top:1px;">${escapeHtml(vendor.address || '-')}</div>
            </div>
          </div>
        </div>
        <div style="margin-top:8px;">
          <span style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Remarks</span>
          <div style="font-size:11px;color:#444;margin-top:1px;font-style:italic;">${escapeHtml(vendor.remarks || 'No remarks')}</div>
        </div>
      </div>

      <div style="margin-bottom:20px;">
        <h6 style="color:${BRAND};font-size:11px;font-weight:700;margin:0 0 8px 0;text-transform:uppercase;letter-spacing:0.5px;-webkit-print-color-adjust:exact;print-color-adjust:exact;">Ledger Transaction History</h6>
        <table style="width:100%;border-collapse:collapse;font-size:11px;">
          <thead>
            <tr style="background-color:${BRAND};color:#fff;font-weight:700;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
              <th style="padding:6px;border:1px solid #bbb;text-align:left;width:12%;">Date</th>
              <th style="padding:6px;border:1px solid #bbb;text-align:left;width:15%;">Doc Type</th>
              <th style="padding:6px;border:1px solid #bbb;text-align:left;width:15%;">Reference #</th>
              <th style="padding:6px;border:1px solid #bbb;text-align:left;width:43%;">Items Summary</th>
              <th style="padding:6px;border:1px solid #bbb;text-align:right;width:15%;">Total Value</th>
            </tr>
          </thead>
          <tbody>${ledgerRows}</tbody>
        </table>
      </div>

      <div style="margin-bottom:20px;page-break-inside:avoid;break-inside:avoid;">
        <h6 style="color:${BRAND};font-size:11px;font-weight:700;margin:0 0 8px 0;text-transform:uppercase;letter-spacing:0.5px;-webkit-print-color-adjust:exact;print-color-adjust:exact;">Pending Quantities Summary</h6>
        <table style="width:100%;border-collapse:collapse;font-size:11px;">
          <thead>
            <tr style="background-color:${BRAND};color:#fff;font-weight:700;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
              <th style="padding:6px;border:1px solid #bbb;text-align:left;width:45%;">Item Name</th>
              <th style="padding:6px;border:1px solid #bbb;text-align:left;width:15%;">Size</th>
              <th style="padding:6px;border:1px solid #bbb;text-align:center;width:13%;">Total Ordered</th>
              <th style="padding:6px;border:1px solid #bbb;text-align:center;width:13%;">Total Received</th>
              <th style="padding:6px;border:1px solid #bbb;text-align:center;width:14%;">Pending Qty</th>
            </tr>
          </thead>
          <tbody>${pendingRows}</tbody>
        </table>
      </div>
    </div>`;
  },

  delete(vendorName) {
    App.Utils.confirmAction(
      `Are you sure you want to delete vendor "${App.Utils.formatNameCase(vendorName)}" from the Master list? (Historical POs/Bills will not be deleted).`,
      async () => {
        try {
          const res = await Api.mutate('deleteVendor', vendorName);
          App.Utils.showToast(res.message, !res.success);
          if (res.success) App.Vendor.loadData();
        } catch (err) {
          App.Utils.showToast(err.message || 'Failed to delete vendor', true);
        }
      }
    );
  },

  async syncFromPOHistory() {
    const btn = document.getElementById('vendorSyncBtn');
    if (btn) btn.disabled = true;

    try {
      const res = await Api.mutate('syncVendorsFromPOHistory');
      App.Utils.showToast(res.message, !res.success);

      if (res.success) {
        await Promise.allSettled([
          App.Vendor.loadData(),
          App.Item && App.Item.loadData ? App.Item.loadData() : Promise.resolve()
        ]);
        if (App.PO && App.PO.populateVendorSelects) {
          App.PO.populateVendorSelects();
        }
      }
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to sync from PO history', true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }
};

document.addEventListener('DOMContentLoaded', function () {
  const vendorForm = document.getElementById('vendorForm');
  if (vendorForm) {
    vendorForm.onsubmit = async function (e) {
      e.preventDefault();
      const formData = Object.fromEntries(new FormData(this));
      const isEdit = !!formData.originalVendorName;
      const btn = document.getElementById('vendorSubmitBtn');
      if (btn) btn.disabled = true;

      try {
        const res = await Api.mutate('saveVendor', formData);
        if (res.success) {
          App.Vendor.loadData();
          if (isEdit) {
            safeModalHide('vendorProfileModal');
          } else {
            App.Vendor.openCreateModal();
          }
        }
        App.Utils.showToast(res.message, !res.success, res.success
          ? { type: 'vendor', value: formData.vendorName || formData.originalVendorName }
          : null);
      } catch (err) {
        App.Utils.showToast(err.message || 'Failed to save vendor', true);
      } finally {
        if (btn) btn.disabled = false;
      }
    };
  }
});
