'use strict';
// contractor.js -- App.Contractor, ported from Apps_Script/Script_Contractors.html.
//
// Adaptations from source (documented, not silent):
// - Every reference to a contractor record's name field is
//   `c.contractorName`, not source's `c.name`: contractors_service.py's
//   getContractorsData returns {contractorName, contact, address,
//   gstPan, remarks} (confirmed against tests/erp/test_contractors.py,
//   which asserts `c["contractorName"] == name` on the list response)
//   -- an undocumented deviation from the original Apps Script backend
//   (module_contractors.js's own getContractorsData returns `name`, not
//   `contractorName`). This never surfaced in Round 8/9 (Process's
//   contractor-rate mini-table, BOM's cost-row contractor picker) because
//   App.State.globalContractors was still empty then; both of those
//   call sites were corrected to `.contractorName` alongside this round.
//   getContractorRatesData/getContractorLedgerData/getContractorAccountLedger
//   all already use `contractorName` consistently, matching source's own
//   field names there -- no adaptation needed for rate/ledger rows.
// - saveContractor/deleteContractor/deleteContractorsBulk/
//   saveContractorRate/deleteContractorRate/recordContractorPayment/
//   deleteContractorPayment all use Api.mutate (not Api.call): every one
//   is mutation=True on the backend.
// - printLedger() is guarded behind App.Print not existing yet; it
//   otherwise stays a direct port (no separate dead-code builder here --
//   it populates static #print-contractor-ledger-* elements this
//   round's partial doesn't include, same reasoning as every prior
//   round's print guard).

App.Contractor = {
  async loadData() {
    const tbody = document.getElementById('contractorTableBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="text-center p-4">Loading Contractors...</td></tr>';

    try {
      const [, contractorsRes, ledgerRes] = await Promise.all([
        App.Process.ensureLoaded(),
        Api.call('getContractorsData'),
        Api.call('getContractorLedgerData')
      ]);

      if (!contractorsRes.success) {
        App.Utils.showToast(contractorsRes.message, true);
        return;
      }

      App.State.globalContractors = contractorsRes.data;
      App.State.filteredContractors = contractorsRes.data;
      App.State.globalContractorLedger = ledgerRes.success ? ledgerRes.data : [];
      App.State.selectedContractors = [];
      this.renderTable();
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to load contractors', true);
    }
  },

  // Ensures App.State.globalContractors is populated (used by Production's,
  // BOM's, and Dispatch's Select2 contractor fields without requiring the
  // Contractors tab to have been visited first).
  async ensureLoaded() {
    if (App.State.globalContractors && App.State.globalContractors.length) return;
    try {
      const res = await Api.call('getContractorsData');
      if (res.success) App.State.globalContractors = res.data;
    } catch (err) {
      // Ignored -- Contractor dropdowns will simply be empty until loaded elsewhere.
    }
  },

  _ledgerFor(contractorName) {
    const key = (contractorName || '').toLowerCase();
    return (App.State.globalContractorLedger || []).find(l => l.contractorName.toLowerCase() === key);
  },

  filterData(searchTerm) {
    const term = searchTerm.toLowerCase().trim();
    if (!term) {
      App.State.filteredContractors = App.State.globalContractors;
    } else {
      App.State.filteredContractors = App.State.globalContractors.filter(c => {
        const haystack = [c.contractorName, c.contact, c.address, c.remarks].join(' ');
        return App.Utils.matchesKeywords(haystack, term);
      });
    }
    this.renderTable();
  },

  renderTable() {
    const tbody = document.getElementById('contractorTableBody');
    if (!tbody) return;

    const emptyState = document.getElementById('contractorEmptyState');
    if (App.State.filteredContractors.length === 0) {
      tbody.innerHTML = '';
      if (emptyState) emptyState.style.display = 'block';
      this.updateBulkButtons();
      return;
    }
    if (emptyState) emptyState.style.display = 'none';

    const selectAllChk = document.getElementById('selectAllContractors');
    if (selectAllChk) {
      selectAllChk.checked = App.State.filteredContractors.every(c =>
        App.Selection.isSelected(App.State.selectedContractors, c.contractorName));
    }

    let html = '';
    App.State.filteredContractors.forEach(c => {
      const ledger = this._ledgerFor(c.contractorName);
      const balanceDue = ledger ? ledger.balanceDue : 0;
      const balanceClass = balanceDue > 0 ? 'text-danger' : (balanceDue < 0 ? 'text-success' : 'text-dark');
      const checkedAttr = App.Selection.isSelected(App.State.selectedContractors, c.contractorName) ? 'checked' : '';
      html += `<tr>
    <td class="text-center">
      <input type="checkbox" class="form-check-input contractor-select-chk" data-key="${escapeHtml(c.contractorName)}" ${checkedAttr} onchange="App.Contractor.onRowSelectChange()">
    </td>
    <td><strong>${escapeHtml(c.contractorName)}</strong></td>
    <td>${escapeHtml(c.contact || '-')}</td>
    <td class="text-center">${ledger ? escapeHtml(String(ledger.lotCount)) : '0'}</td>
    <td class="text-end fw-bold ${balanceClass}">${formatCurrency(balanceDue)}</td>
    <td class="text-center">
      <button class="btn btn-sm btn-outline-primary btn-action mb-1" onclick="App.Contractor.openProfileModal('${escapeHtml(c.contractorName)}')">Profile / Rate Card</button>
      <button class="btn btn-sm btn-danger btn-action" onclick="App.Contractor.delete('${escapeHtml(c.contractorName)}')">Delete</button>
    </td>
  </tr>`;
    });

    tbody.innerHTML = html;
    this.updateBulkButtons();
  },

  toggleSelectAll(masterChk) {
    App.Selection.toggleAll(App.State.selectedContractors, 'contractor-select-chk', masterChk);
    this.updateBulkButtons();
  },

  onRowSelectChange() {
    App.Selection.syncFromRows(App.State.selectedContractors, 'contractor-select-chk', 'selectAllContractors');
    this.updateBulkButtons();
  },

  updateBulkButtons() {
    const count = App.State.selectedContractors.length;
    App.Selection.updateButton('btnBulkDeleteContractors', count, '<i class="bi bi-trash"></i> Delete Selected');
  },

  async bulkDelete() {
    const selected = App.State.selectedContractors;
    if (!selected.length) return;

    App.Utils.confirmAction(
      `Are you sure you want to delete ${selected.length} selected contractor(s)? Their rate card will also be removed. Contractors with Production, Dispatch, or payment history will be skipped.`,
      async () => {
        try {
          const res = await Api.mutate('deleteContractorsBulk', selected);
          App.Utils.showToast(res?.message || 'Delete completed.', !res?.success);
          if (res?.success) {
            App.State.selectedContractors = [];
            await this.loadData();
          }
        } catch (err) {
          App.Utils.showToast(err.message || 'Failed to delete contractors.', true);
        }
      }
    );
  },

  switchTab(tabId) {
    document.querySelectorAll('.contractor-tab-content').forEach(t => t.style.display = 'none');
    document.getElementById(tabId).style.display = 'block';

    document.querySelectorAll('#contractorTabs .nav-link').forEach(btn => {
      btn.classList.remove('active', 'bg-warning');
    });
    const activeBtn = document.getElementById('btn-' + tabId);
    if (activeBtn) activeBtn.classList.add('active', 'bg-warning');
  },

  openCreateModal() {
    const form = document.getElementById('contractorForm');
    if (form) form.reset();
    document.getElementById('originalContractorName').value = '';
    document.getElementById('contractorProfileTitle').innerText = 'Register New Contractor';
    document.getElementById('contractorSubmitBtn').innerText = 'Register Contractor';

    this.switchTab('c-profile');
    document.getElementById('btn-c-rates').parentElement.style.display = 'none';
    document.getElementById('btn-c-extra-charges').parentElement.style.display = 'none';
    document.getElementById('btn-c-ledger').parentElement.style.display = 'none';

    const modalEl = document.getElementById('contractorProfileModal');
    if (modalEl && typeof bootstrap !== 'undefined') new bootstrap.Modal(modalEl).show();
  },

  async openProfileModal(contractorName) {
    const contractor = App.State.globalContractors.find(c => App.Utils.sameText(c.contractorName, contractorName));
    if (!contractor) return;

    App.State.selectedContractorRates = [];
    App.State.selectedContractorServiceCharges = [];
    App.State.selectedContractorPayments = [];

    const form = document.getElementById('contractorForm');
    if (form) form.reset();

    document.getElementById('originalContractorName').value = contractor.contractorName;
    document.getElementById('ctrFormName').value = contractor.contractorName;
    document.getElementById('ctrFormContact').value = contractor.contact;
    document.getElementById('ctrFormAddress').value = contractor.address;
    document.getElementById('ctrFormGstPan').value = contractor.gstPan;
    document.getElementById('ctrFormRemarks').value = contractor.remarks;

    document.getElementById('contractorProfileTitle').innerText = `Contractor: ${contractor.contractorName}`;
    document.getElementById('contractorSubmitBtn').innerText = 'Update Profile Info';

    document.getElementById('btn-c-rates').parentElement.style.display = 'block';
    document.getElementById('btn-c-extra-charges').parentElement.style.display = 'block';
    document.getElementById('btn-c-ledger').parentElement.style.display = 'block';

    await App.ProcessType.ensureLoaded();
    await this.loadRateCard(contractor.contractorName);
    await this.loadServiceCharges(contractor.contractorName);
    await this.renderLedgerTab(contractor.contractorName);

    this.switchTab('c-profile');

    const modalEl = document.getElementById('contractorProfileModal');
    if (modalEl && typeof bootstrap !== 'undefined') new bootstrap.Modal(modalEl).show();
  },

  // Builds the Process Type <option> list for a rate card row, from
  // Process Type Master (App.State.globalProcessTypes) plus the
  // hardcoded "Dispatch / Logistics" pseudo-type (Dispatch has no real
  // Process record, but its logistics rate lives on this same rate card
  // -- see dispatch_service.py's use of config_maps.LOGISTICS_PROCESS_NAME).
  // A row's already-saved type is always included even if it's since
  // been renamed/removed from the master.
  buildProcessTypeOptionsHtml(selected) {
    const names = (App.State.globalProcessTypes || []).map(t => t.name);
    names.push('Dispatch / Logistics');
    const sel = String(selected || '').trim();
    if (sel && !names.some(n => n.toLowerCase() === sel.toLowerCase())) {
      names.unshift(sel);
      return names.map(n => `<option value="${escapeHtml(n)}" ${n === sel ? 'selected' : ''}>${escapeHtml(n)}${n === sel ? ' (removed)' : ''}</option>`).join('');
    }
    return `<option value="">Choose a Process Type...</option>` +
      names.map(n => `<option value="${escapeHtml(n)}" ${n === sel ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('');
  },

  // Sizes are a fixed list (App.Utils.PROCESS_SIZE_LIST), same one the
  // Production form's Size cascade dropdown already uses -- plus
  // 'General', the fallback contractors_service.
  // _get_size_from_output_item_name resolves to for any Process whose
  // Output Item Name doesn't mention a recognized size.
  buildSizeOptionsHtml(selected) {
    const names = [...App.Utils.PROCESS_SIZE_LIST, 'General'];
    const sel = String(selected || '').trim();
    return `<option value="">Choose a Size...</option>` +
      names.map(n => `<option value="${escapeHtml(n)}" ${n === sel ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('');
  },

  async loadRateCard(contractorName) {
    const tbody = document.getElementById('contractorRatesBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="text-center p-3">Loading rate card...</td></tr>';

    try {
      const res = await Api.call('getContractorRatesData', contractorName);
      const rates = res.success ? res.data : [];
      App.State.currentContractorRates = { contractorName, rates };

      if (!rates.length) {
        tbody.innerHTML = '';
        this.updateRatesBulkButton();
        return;
      }
      tbody.innerHTML = rates.map(r => this.renderRateRow(r)).join('');
      this.updateRatesBulkButton();
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to load rate card', true);
    }
  },

  renderRateRow(rate) {
    const rowId = 'rate_row_' + Math.floor(Math.random() * 1000000);
    const originalProcessType = rate.processType || '';
    const originalSize = rate.size || '';
    // A freshly-added, not-yet-saved row (originalProcessType blank) has
    // nothing server-side to bulk-delete yet -- no checkbox for it, same
    // as its own ✕ (deleteRateRow) already just removing the DOM row for
    // that case instead of calling the API.
    const key = `${originalProcessType}||${originalSize}`;
    const checkboxCell = originalProcessType
      ? `<input type="checkbox" class="form-check-input rate-select-chk" data-key="${escapeHtml(key)}" ${App.Selection.isSelected(App.State.selectedContractorRates, key) ? 'checked' : ''} onchange="App.Contractor.onRateRowSelectChange()">`
      : '';
    return `<tr id="${rowId}" data-original-process-type="${escapeHtml(originalProcessType)}" data-original-size="${escapeHtml(originalSize)}">
  <td class="text-center">${checkboxCell}</td>
  <td><select class="form-select form-select-sm rate-process-type">${this.buildProcessTypeOptionsHtml(originalProcessType)}</select></td>
  <td><select class="form-select form-select-sm rate-size">${this.buildSizeOptionsHtml(originalSize)}</select></td>
  <td><input type="number" class="form-control form-control-sm text-end rate-amount" value="${rate.ratePerUnit || 0}" min="0" step="0.01"></td>
  <td><input type="text" class="form-control form-control-sm rate-remarks" value="${escapeHtml(rate.remarks || '')}"></td>
  <td class="text-center">
    <button type="button" class="btn btn-sm btn-outline-danger" onclick="App.Contractor.deleteRateRow('${rowId}')">✕</button>
  </td>
</tr>`;
  },

  toggleSelectAllRates(masterChk) {
    App.Selection.toggleAll(App.State.selectedContractorRates, 'rate-select-chk', masterChk);
    this.updateRatesBulkButton();
  },

  onRateRowSelectChange() {
    App.Selection.syncFromRows(App.State.selectedContractorRates, 'rate-select-chk', 'selectAllContractorRates');
    this.updateRatesBulkButton();
  },

  updateRatesBulkButton() {
    App.Selection.updateButton('btnBulkDeleteContractorRates', App.State.selectedContractorRates.length, '<i class="bi bi-trash"></i> Delete Selected');
  },

  async bulkDeleteRates() {
    const selected = App.State.selectedContractorRates;
    const contractorName = App.State.currentContractorRates?.contractorName;
    if (!selected.length || !contractorName) return;

    App.Utils.confirmAction(
      `Delete ${selected.length} selected rate card entr${selected.length === 1 ? 'y' : 'ies'} for "${contractorName}"? This cannot be undone.`,
      async () => {
        try {
          const res = await Api.mutate('deleteContractorRatesBulk', selected.map(key => {
            const [processType, size] = key.split('||');
            return { contractorName, processType, size };
          }));
          App.Utils.showToast(res?.message || 'Delete completed.', !res?.success);
          if (res?.success) {
            App.State.selectedContractorRates = [];
            await this.loadRateCard(contractorName);
          }
        } catch (err) {
          App.Utils.showToast(err.message || 'Failed to delete rates.', true);
        }
      }
    );
  },

  addRateRow() {
    const tbody = document.getElementById('contractorRatesBody');
    if (!tbody) return;
    tbody.insertAdjacentHTML('beforeend', this.renderRateRow({ processType: '', size: '', ratePerUnit: 0, remarks: '' }));
  },

  // Saves every row in the Rate Card table in one action instead of a
  // per-row Save button -- rate cards routinely need several Process
  // Type/Size combinations set at once, and clicking Save on each row
  // individually was the exact tedium this feature was meant to avoid.
  // Rows are saved sequentially (always a short list per contractor) so
  // one failure's toast doesn't get lost among a burst of others.
  async saveAllRates() {
    const contractorName = App.State.currentContractorRates?.contractorName;
    if (!contractorName) return;

    const rows = Array.from(document.querySelectorAll('#contractorRatesBody tr'));
    if (!rows.length) {
      App.Utils.showToast('No rates to save.', true);
      return;
    }

    const btn = document.getElementById('btnSaveAllContractorRates');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="bi bi-hourglass-split"></i> Saving…'; }

    let saved = 0;
    let skipped = 0;
    const failures = [];

    for (const row of rows) {
      const processType = row.querySelector('.rate-process-type')?.value || '';
      const size = row.querySelector('.rate-size')?.value || '';
      const ratePerUnit = row.querySelector('.rate-amount')?.value;
      const remarks = row.querySelector('.rate-remarks')?.value || '';
      const originalProcessType = row.dataset.originalProcessType || '';
      const originalSize = row.dataset.originalSize || '';

      // A freshly-added row nobody filled in yet -- skip quietly rather
      // than blocking the whole batch on it.
      if (!processType && !size && !originalProcessType) {
        skipped++;
        continue;
      }
      if (!processType || !size) {
        failures.push(`${originalProcessType || 'New row'}: choose both a Process Type and Size`);
        continue;
      }

      try {
        const res = await Api.mutate('saveContractorRate', { contractorName, processType, size, ratePerUnit, remarks });
        if (!res.success) {
          failures.push(`${processType} / ${size}: ${res.message}`);
          continue;
        }
        // Upserts by (contractor, processType, size) -- it has no idea this
        // row used to mean a different type/size. If either dropdown was
        // switched away from the row's original saved values, the old
        // (contractor, oldType, oldSize) entry would otherwise be left
        // behind as an orphaned duplicate.
        const typeOrSizeChanged = originalProcessType && (
          originalProcessType.toLowerCase() !== processType.toLowerCase() || originalSize.toLowerCase() !== size.toLowerCase()
        );
        if (typeOrSizeChanged) {
          await Api.mutate('deleteContractorRate', contractorName, originalProcessType, originalSize);
        }
        saved++;
      } catch (err) {
        failures.push(`${processType} / ${size}: ${err.message || 'failed'}`);
      }
    }

    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="bi bi-check2-all"></i> Save All Rates'; }

    const parts = [];
    if (saved) parts.push(`${saved} rate${saved === 1 ? '' : 's'} saved`);
    if (skipped) parts.push(`${skipped} empty row${skipped === 1 ? '' : 's'} skipped`);
    if (failures.length) parts.push(`${failures.length} failed (${failures.join('; ')})`);
    App.Utils.showToast(parts.join(', ') || 'Nothing to save.', failures.length > 0);

    await this.loadRateCard(contractorName);
  },

  async deleteRateRow(rowId) {
    const row = document.getElementById(rowId);
    if (!row) return;

    const originalProcessType = row.dataset.originalProcessType || '';
    const originalSize = row.dataset.originalSize || '';
    const contractorName = App.State.currentContractorRates?.contractorName;

    const existing = (App.State.currentContractorRates?.rates || [])
      .find(r => App.Utils.sameText(r.processType, originalProcessType) && App.Utils.sameText(r.size, originalSize));
    if (!existing || !contractorName) {
      row.remove();
      return;
    }

    App.Utils.confirmAction(
      `Delete the rate card entry for "${contractorName}" on "${originalProcessType} / ${originalSize}"? This cannot be undone.`,
      async () => {
        try {
          const res = await Api.mutate('deleteContractorRate', contractorName, originalProcessType, originalSize);
          App.Utils.showToast(res.message, !res.success);
          if (res.success) await this.loadRateCard(contractorName);
        } catch (err) {
          App.Utils.showToast(err.message || 'Failed to delete rate', true);
        }
      }
    );
  },

  // ───────────────────────────────────────────────────────────────────
  // Extra Charges (Layer 2 -- optional flat per-lot charge, e.g.
  // "Mounting Tyre/Tube"). Same table pattern as the Rate Card above,
  // upserting by (contractor, serviceType) instead of a numeric row id.
  // ───────────────────────────────────────────────────────────────────

  async loadServiceCharges(contractorName) {
    const tbody = document.getElementById('contractorServiceChargesBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="text-center p-3">Loading extra charges...</td></tr>';

    try {
      const res = await Api.call('getContractorServiceChargesData', contractorName);
      const charges = res.success ? res.data : [];
      App.State.currentContractorServiceCharges = { contractorName, charges };

      if (!charges.length) {
        tbody.innerHTML = '';
        this.updateServiceChargesBulkButton();
        return;
      }
      tbody.innerHTML = charges.map(c => this.renderServiceChargeRow(c)).join('');
      this.updateServiceChargesBulkButton();
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to load extra charges', true);
    }
  },

  renderServiceChargeRow(charge) {
    const rowId = 'charge_row_' + Math.floor(Math.random() * 1000000);
    const originalServiceType = charge.serviceType || '';
    const checkboxCell = originalServiceType
      ? `<input type="checkbox" class="form-check-input service-charge-select-chk" data-key="${escapeHtml(originalServiceType)}" ${App.Selection.isSelected(App.State.selectedContractorServiceCharges, originalServiceType) ? 'checked' : ''} onchange="App.Contractor.onServiceChargeRowSelectChange()">`
      : '';
    return `<tr id="${rowId}" data-original-service-type="${escapeHtml(originalServiceType)}">
  <td class="text-center">${checkboxCell}</td>
  <td><input type="text" class="form-control form-control-sm charge-service-type" value="${escapeHtml(originalServiceType)}" placeholder="e.g. Mounting Tyre/Tube"></td>
  <td><input type="number" class="form-control form-control-sm text-end charge-amount" value="${charge.chargeAmount || 0}" min="0" step="0.01"></td>
  <td><input type="text" class="form-control form-control-sm charge-remarks" value="${escapeHtml(charge.remarks || '')}"></td>
  <td class="text-center">
    <button type="button" class="btn btn-sm btn-outline-danger" onclick="App.Contractor.deleteServiceChargeRow('${rowId}')">✕</button>
  </td>
</tr>`;
  },

  toggleSelectAllServiceCharges(masterChk) {
    App.Selection.toggleAll(App.State.selectedContractorServiceCharges, 'service-charge-select-chk', masterChk);
    this.updateServiceChargesBulkButton();
  },

  onServiceChargeRowSelectChange() {
    App.Selection.syncFromRows(App.State.selectedContractorServiceCharges, 'service-charge-select-chk', 'selectAllContractorServiceCharges');
    this.updateServiceChargesBulkButton();
  },

  updateServiceChargesBulkButton() {
    App.Selection.updateButton('btnBulkDeleteContractorServiceCharges', App.State.selectedContractorServiceCharges.length, '<i class="bi bi-trash"></i> Delete Selected');
  },

  async bulkDeleteServiceCharges() {
    const selected = App.State.selectedContractorServiceCharges;
    const contractorName = App.State.currentContractorServiceCharges?.contractorName;
    if (!selected.length || !contractorName) return;

    App.Utils.confirmAction(
      `Delete ${selected.length} selected extra charge(s) for "${contractorName}"? This cannot be undone.`,
      async () => {
        try {
          const res = await Api.mutate('deleteContractorServiceChargesBulk', selected.map(serviceType => ({ contractorName, serviceType })));
          App.Utils.showToast(res?.message || 'Delete completed.', !res?.success);
          if (res?.success) {
            App.State.selectedContractorServiceCharges = [];
            await this.loadServiceCharges(contractorName);
          }
        } catch (err) {
          App.Utils.showToast(err.message || 'Failed to delete extra charges.', true);
        }
      }
    );
  },

  addServiceChargeRow() {
    const tbody = document.getElementById('contractorServiceChargesBody');
    if (!tbody) return;
    tbody.insertAdjacentHTML('beforeend', this.renderServiceChargeRow({ serviceType: '', chargeAmount: 0, remarks: '' }));
  },

  // Saves every row in the Extra Charges table in one action instead of
  // a per-row Save button -- same reasoning and shape as saveAllRates
  // above. Upserts by (contractor, serviceType); if Service Type was
  // edited away from a row's original saved value, the old (contractor,
  // oldServiceType) entry would otherwise be left behind as an orphaned
  // duplicate, so it's explicitly deleted after the new one saves.
  async saveAllServiceCharges() {
    const contractorName = App.State.currentContractorServiceCharges?.contractorName;
    if (!contractorName) return;

    const rows = Array.from(document.querySelectorAll('#contractorServiceChargesBody tr'));
    if (!rows.length) {
      App.Utils.showToast('No extra charges to save.', true);
      return;
    }

    const btn = document.getElementById('btnSaveAllContractorServiceCharges');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="bi bi-hourglass-split"></i> Saving…'; }

    let saved = 0;
    let skipped = 0;
    const failures = [];

    for (const row of rows) {
      const serviceType = (row.querySelector('.charge-service-type')?.value || '').trim();
      const chargeAmount = row.querySelector('.charge-amount')?.value;
      const remarks = row.querySelector('.charge-remarks')?.value || '';
      const originalServiceType = row.dataset.originalServiceType || '';

      // A freshly-added row nobody filled in yet -- skip quietly rather
      // than blocking the whole batch on it.
      if (!serviceType && !originalServiceType) {
        skipped++;
        continue;
      }
      if (!serviceType) {
        failures.push(`${originalServiceType || 'New row'}: enter a Service Type`);
        continue;
      }

      try {
        const res = await Api.mutate('saveContractorServiceCharge', { contractorName, serviceType, chargeAmount, remarks });
        if (!res.success) {
          failures.push(`${serviceType}: ${res.message}`);
          continue;
        }
        if (originalServiceType && originalServiceType.toLowerCase() !== serviceType.toLowerCase()) {
          await Api.mutate('deleteContractorServiceCharge', contractorName, originalServiceType);
        }
        saved++;
      } catch (err) {
        failures.push(`${serviceType}: ${err.message || 'failed'}`);
      }
    }

    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="bi bi-check2-all"></i> Save All Charges'; }

    const parts = [];
    if (saved) parts.push(`${saved} charge${saved === 1 ? '' : 's'} saved`);
    if (skipped) parts.push(`${skipped} empty row${skipped === 1 ? '' : 's'} skipped`);
    if (failures.length) parts.push(`${failures.length} failed (${failures.join('; ')})`);
    App.Utils.showToast(parts.join(', ') || 'Nothing to save.', failures.length > 0);

    await this.loadServiceCharges(contractorName);
  },

  async deleteServiceChargeRow(rowId) {
    const row = document.getElementById(rowId);
    if (!row) return;

    const originalServiceType = row.dataset.originalServiceType || '';
    const contractorName = App.State.currentContractorServiceCharges?.contractorName;

    const existing = (App.State.currentContractorServiceCharges?.charges || [])
      .find(c => App.Utils.sameText(c.serviceType, originalServiceType));
    if (!existing || !contractorName) {
      row.remove();
      return;
    }

    App.Utils.confirmAction(
      `Delete the extra charge "${originalServiceType}" for "${contractorName}"? This cannot be undone.`,
      async () => {
        try {
          const res = await Api.mutate('deleteContractorServiceCharge', contractorName, originalServiceType);
          App.Utils.showToast(res.message, !res.success);
          if (res.success) await this.loadServiceCharges(contractorName);
        } catch (err) {
          App.Utils.showToast(err.message || 'Failed to delete extra charge', true);
        }
      }
    );
  },

  async renderLedgerTab(contractorName) {
    const tbody = document.getElementById('contractorLedgerBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="text-center p-3">Loading ledger...</td></tr>';

    App.State.currentAccountLedgerContractor = contractorName;
    document.getElementById('paymentFormDate').value = todayIso();
    document.getElementById('paymentFormAmount').value = '';
    document.getElementById('paymentFormModeReference').value = '';
    document.getElementById('paymentFormRemarks').value = '';

    try {
      const res = await Api.call('getContractorAccountLedger', contractorName);
      if (!res.success) {
        App.Utils.showToast(res.message, true);
        return;
      }

      const { entries, totalPayable, totalPaid, balanceDue } = res.data;
      App.State.currentAccountLedgerData = { contractorName, entries, totalPayable, totalPaid, balanceDue };

      document.getElementById('ledgerTotalPayable').innerText = formatCurrency(totalPayable);
      document.getElementById('ledgerTotalPaid').innerText = formatCurrency(totalPaid);
      const balanceEl = document.getElementById('ledgerBalanceDue');
      balanceEl.innerText = formatCurrency(balanceDue);
      balanceEl.className = `fs-5 fw-bold ${balanceDue > 0 ? 'text-danger' : (balanceDue < 0 ? 'text-success' : 'text-dark')}`;

      if (!tbody) return;
      if (!entries.length) {
        tbody.innerHTML = '<tr><td colspan="9" class="text-center text-muted p-4">No transactions yet for this contractor.</td></tr>';
        this.updatePaymentsBulkButton();
        return;
      }

      tbody.innerHTML = entries.map(e => {
        const badgeClass = e.type === 'Payable' ? 'bg-warning text-dark' : 'bg-success';
        // Only a Payment row is a real, individually-deletable record --
        // a Payable row is computed live from Production/Dispatch, so
        // it gets neither the checkbox nor the ✕.
        const checkboxCell = e.type === 'Payment'
          ? `<input type="checkbox" class="form-check-input payment-select-chk" data-key="${e.rowIdx}" ${App.Selection.isSelected(App.State.selectedContractorPayments, String(e.rowIdx)) ? 'checked' : ''} onchange="App.Contractor.onPaymentRowSelectChange()">`
          : '';
        const deleteBtn = e.type === 'Payment'
          ? `<button class="btn btn-sm btn-outline-danger" onclick="App.Contractor.deletePayment(${e.rowIdx}, '${escapeHtml(contractorName)}', ${e.rawAmount}, '${escapeHtml(e.date)}')">✕</button>`
          : '';
        return `<tr>
      <td class="text-center">${checkboxCell}</td>
      <td>${escapeHtml(e.date)}</td>
      <td><span class="badge ${badgeClass}">${escapeHtml(e.type)}</span></td>
      <td>${escapeHtml(e.ref)}</td>
      <td><small>${escapeHtml(e.description)}</small></td>
      <td class="text-end">${e.type === 'Payable' ? formatCurrency(e.amount) : '-'}</td>
      <td class="text-end text-success">${e.type === 'Payment' ? formatCurrency(e.rawAmount) : '-'}</td>
      <td class="text-end fw-bold">${formatCurrency(e.balance)}</td>
      <td class="text-center">${deleteBtn}</td>
    </tr>`;
      }).join('');
      this.updatePaymentsBulkButton();
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to load account ledger', true);
    }
  },

  toggleSelectAllPayments(masterChk) {
    App.Selection.toggleAll(App.State.selectedContractorPayments, 'payment-select-chk', masterChk);
    this.updatePaymentsBulkButton();
  },

  onPaymentRowSelectChange() {
    App.Selection.syncFromRows(App.State.selectedContractorPayments, 'payment-select-chk', 'selectAllContractorPayments');
    this.updatePaymentsBulkButton();
  },

  updatePaymentsBulkButton() {
    App.Selection.updateButton('btnBulkDeleteContractorPayments', App.State.selectedContractorPayments.length, '<i class="bi bi-trash"></i> Delete Selected');
  },

  async bulkDeletePayments() {
    const selected = App.State.selectedContractorPayments;
    const contractorName = App.State.currentAccountLedgerContractor;
    if (!selected.length || !contractorName) return;

    App.Utils.confirmAction(
      `Delete ${selected.length} selected payment record(s) for "${contractorName}"? This cannot be undone.`,
      async () => {
        try {
          const res = await Api.mutate('deleteContractorPaymentsBulk', selected);
          App.Utils.showToast(res?.message || 'Delete completed.', !res?.success);
          if (res?.success) {
            App.State.selectedContractorPayments = [];
            await this.renderLedgerTab(contractorName);
            await this.loadData();
          }
        } catch (err) {
          App.Utils.showToast(err.message || 'Failed to delete payments.', true);
        }
      }
    );
  },

  printLedger() {
    if (typeof App.Print === 'undefined') {
      App.Utils.notPortedYet('Printing');
      return;
    }

    const ledgerData = App.State.currentAccountLedgerData;
    const contractorName = App.State.currentAccountLedgerContractor;
    if (!ledgerData || !contractorName) return;

    const contractor = App.State.globalContractors.find(c => App.Utils.sameText(c.contractorName, contractorName)) || {};

    document.getElementById('print-contractor-name').innerText = contractorName;
    document.getElementById('print-contractor-gstpan').innerText = contractor.gstPan || '-';
    document.getElementById('print-contractor-contact').innerText = contractor.contact || '-';
    document.getElementById('print-contractor-address').innerText = contractor.address || '-';
    document.getElementById('print-contractor-remarks').innerText = contractor.remarks || 'No remarks';
    document.getElementById('print-contractor-report-date').innerText = new Date().toLocaleDateString('en-GB');

    document.getElementById('print-contractor-total-payable').innerText = formatCurrency(ledgerData.totalPayable);
    document.getElementById('print-contractor-total-paid').innerText = formatCurrency(ledgerData.totalPaid);
    document.getElementById('print-contractor-balance-due').innerText = formatCurrency(ledgerData.balanceDue);

    const ledgerBody = document.getElementById('print-contractor-ledger-body');
    if (ledgerBody) {
      ledgerBody.innerHTML = ledgerData.entries.length
        ? ledgerData.entries.map(e => `<tr>
      <td style="padding:6px;border:1px solid #999;color:#000;">${escapeHtml(e.date)}</td>
      <td style="padding:6px;border:1px solid #999;color:#000;">${escapeHtml(e.type)}</td>
      <td style="padding:6px;border:1px solid #999;color:#000;">${escapeHtml(e.ref)}</td>
      <td style="padding:6px;border:1px solid #999;color:#000;">${escapeHtml(e.description)}</td>
      <td style="padding:6px;border:1px solid #999;text-align:right;font-weight:700;color:#000;">${e.type === 'Payable' ? formatCurrency(e.amount) : '-'}</td>
      <td style="padding:6px;border:1px solid #999;text-align:right;font-weight:700;color:#000;">${e.type === 'Payment' ? formatCurrency(e.rawAmount) : '-'}</td>
      <td style="padding:6px;border:1px solid #999;text-align:right;font-weight:700;color:#000;">${formatCurrency(e.balance)}</td>
    </tr>`).join('')
        : '<tr><td colspan="7" style="padding:10px;text-align:center;color:#999;">No transactions yet for this contractor.</td></tr>';
    }

    App.Print.trigger('print-contractor-ledger-container', `Contractor_Ledger_${contractorName.replace(/[^a-zA-Z0-9_-]/g, '_')}`);
  },

  async recordPayment() {
    const contractorName = App.State.currentAccountLedgerContractor;
    if (!contractorName) return;

    const date = document.getElementById('paymentFormDate').value;
    const amount = document.getElementById('paymentFormAmount').value;
    const modeReference = document.getElementById('paymentFormModeReference').value;
    const remarks = document.getElementById('paymentFormRemarks').value;

    if (!toNumber(amount) || toNumber(amount) <= 0) {
      App.Utils.showToast('Enter a valid payment amount.', true);
      return;
    }

    try {
      const res = await Api.mutate('recordContractorPayment', { contractorName, date, amount, modeReference, remarks });
      App.Utils.showToast(res.message, !res.success);
      if (res.success) {
        await this.renderLedgerTab(contractorName);
        await this.loadData(); // refresh Balance Due on the main list
      }
    } catch (err) {
      App.Utils.showToast(err.message || 'Failed to record payment', true);
    }
  },

  deletePayment(rowIdx, contractorName, amount, date) {
    App.Utils.confirmAction(
      `Delete ${contractorName}'s payment of ${formatCurrency(amount)}${date ? ` dated ${date}` : ''}? This cannot be undone.`,
      async () => {
        try {
          const res = await Api.mutate('deleteContractorPayment', rowIdx, contractorName, amount);
          App.Utils.showToast(res.message, !res.success);
          if (res.success) {
            await this.renderLedgerTab(contractorName);
            await this.loadData();
          }
        } catch (err) {
          App.Utils.showToast(err.message || 'Failed to delete payment', true);
        }
      }
    );
  },

  delete(contractorName) {
    App.Utils.confirmAction(
      `Are you sure you want to delete contractor "${contractorName}"? Their rate card will also be removed.`,
      async () => {
        try {
          const res = await Api.mutate('deleteContractor', contractorName);
          App.Utils.showToast(res.message, !res.success);
          if (res.success) await this.loadData();
        } catch (err) {
          App.Utils.showToast(err.message || 'Failed to delete contractor', true);
        }
      }
    );
  }
};

// Wire up Contractor profile form submission
document.addEventListener('DOMContentLoaded', function () {
  const contractorForm = document.getElementById('contractorForm');
  if (contractorForm) {
    contractorForm.onsubmit = async function (e) {
      e.preventDefault();

      const formData = Object.fromEntries(new FormData(contractorForm));
      const isEdit = !!formData.originalContractorName;
      const submitBtn = document.getElementById('contractorSubmitBtn');
      if (submitBtn) submitBtn.disabled = true;

      try {
        const response = await Api.mutate('saveContractor', formData);
        if (response.success) {
          await App.Contractor.loadData();
          if (isEdit) {
            const modalEl = document.getElementById('contractorProfileModal');
            if (modalEl) bootstrap.Modal.getOrCreateInstance(modalEl).hide();
          } else {
            App.Contractor.openCreateModal();
          }
        }
        App.Utils.showToast(response.message, !response.success, response.success
          ? { type: 'contractor', value: formData.contractorName || formData.originalContractorName }
          : null);
      } catch (err) {
        App.Utils.showToast(err.message || 'Failed to save contractor', true);
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    };
  }
});
