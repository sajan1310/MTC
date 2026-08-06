'use strict';
// dashboard.js -- App.Dashboard, ported from Apps_Script/Script_Dashboard.html.
// Talks to the already-shipped getDashboardData RPC (app/erp/services/
// dashboard_service.py) -- no backend changes needed, the response shape
// matches this renderer's expectations exactly.

App.Dashboard = {
  charts: { status: null, trend: null },
  chartLibLoaded: false,
  refreshTimer: null,
  isLoading: false,
  hasLoadedOnce: false,
  REFRESH_INTERVAL_MS: 5 * 60 * 1000,

  async ensureChartLib() {
    if (this.chartLibLoaded || typeof Chart !== 'undefined') {
      this.chartLibLoaded = true;
      return;
    }
    await loadScript('https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js');
    this.chartLibLoaded = true;
  },

  startAutoRefresh() {
    this.stopAutoRefresh();
    if (!this._visibilityHandler) {
      this._visibilityHandler = () => {
        if (document.visibilityState === 'hidden') {
          if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
          }
        } else if (!this.refreshTimer) {
          this.refreshTimer = setInterval(() => this.loadData(), this.REFRESH_INTERVAL_MS);
        }
      };
    }
    document.addEventListener('visibilitychange', this._visibilityHandler);
    if (document.visibilityState !== 'hidden') {
      this.refreshTimer = setInterval(() => this.loadData(), this.REFRESH_INTERVAL_MS);
    }
  },

  stopAutoRefresh() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
    }
  },

  _showBackupResultState(progressState, resultState, doneBtn, closeHeaderBtn) {
    progressState.style.display = 'none';
    resultState.style.display = 'block';
    doneBtn.style.display = 'inline-block';
    closeHeaderBtn.style.display = 'block';
  },

  async loadData() {
    if (this.isLoading) return;
    this.isLoading = true;
    this.setRefreshBtnState(true);
    try {
      const response = await Api.call('getDashboardData');
      if (!response.success) {
        this.renderError(response.message);
        return;
      }
      const data = response.data;
      this.renderKpis(data.kpis);
      this.renderPipeline(data.pipeline);
      this.renderLowStock(data.lowStockItems, data.lowStockTotalCount);
      this.renderReadyToDispatch(data.readyToDispatchItems, data.readyToDispatchTotalCount);
      this.renderContractorPayables(data.contractorPayables, data.contractorPayablesTotalCount);
      await this.ensureChartLib();
      this.renderProductionStatusChart(data.productionStatusBreakdown);
      this.renderDispatchTrendChart(data.dispatchTrend);
      this.hasLoadedOnce = true;
      this.setLastUpdated(data.generatedAt);
      this.loadBackupStatus();
    } catch (err) {
      this.renderError(err.message || 'Failed to load dashboard data');
    } finally {
      this.isLoading = false;
      this.setRefreshBtnState(false);
    }
  },

  async triggerBackup() {
    const modalEl = document.getElementById('backupProgressModal');
    if (!modalEl) return;

    const bsModal = bootstrap.Modal.getOrCreateInstance(modalEl);
    
    // UI elements inside modal
    const progressState = document.getElementById('backupProgressState');
    const resultState = document.getElementById('backupResultState');
    const progressBar = document.getElementById('backupProgressBar');
    const progressStep = document.getElementById('backupProgressStep');
    const progressSubtext = document.getElementById('backupProgressSubtext');
    const percentText = document.getElementById('backupPercentText');
    
    const resultIcon = document.getElementById('backupResultIcon');
    const resultTitle = document.getElementById('backupResultTitle');
    const resultMessage = document.getElementById('backupResultMessage');
    const detailStatus = document.getElementById('backupDetailStatus');
    const detailTime = document.getElementById('backupDetailTime');
    const detailFile = document.getElementById('backupDetailFile');
    
    const openSheetBtn = document.getElementById('backupOpenSheetBtn');
    const doneBtn = document.getElementById('backupModalDoneBtn');
    const closeHeaderBtn = document.getElementById('backupModalCloseBtn');
    const triggerBtn = document.getElementById('dashboardBackupBtn');

    // Reset Modal to initial progress state
    progressState.style.display = 'block';
    resultState.style.display = 'none';
    openSheetBtn.style.display = 'none';
    doneBtn.style.display = 'none';
    closeHeaderBtn.style.display = 'none';
    
    if (progressBar) {
      progressBar.style.width = '20%';
      progressBar.className = 'progress-bar progress-bar-striped progress-bar-animated bg-primary';
    }
    if (progressStep) progressStep.textContent = 'Creating local database snapshot...';
    if (progressSubtext) progressSubtext.textContent = 'Dumping PostgreSQL tables to backups directory...';
    if (percentText) percentText.textContent = '20%';
    if (triggerBtn) triggerBtn.disabled = true;

    bsModal.show();

    // Simulated progress step timer while waiting for backend response
    let progressTimer = setInterval(() => {
      if (!progressBar) return;
      let currentWidth = parseInt(progressBar.style.width || '20', 10);
      if (currentWidth < 85) {
        let nextWidth = currentWidth + 15;
        progressBar.style.width = nextWidth + '%';
        if (percentText) percentText.textContent = nextWidth + '%';
        if (nextWidth >= 50 && progressStep) {
          progressStep.textContent = 'Formatting & syncing to Google Sheets...';
          if (progressSubtext) progressSubtext.textContent = 'Exporting erp.* tables into dated spreadsheet tabs...';
        }
      }
    }, 800);

    try {
      const response = await Api.mutate('triggerBackup');

      clearInterval(progressTimer);

      if (progressBar) progressBar.style.width = '100%';
      if (percentText) percentText.textContent = '100%';

      await new Promise(resolve => setTimeout(resolve, 400));

      const isOk = response && response.success;
      const data = (response && response.data) ? response.data : {};
      const statusStr = data.status || (isOk ? 'SUCCESS' : 'FAILED');

      this._showBackupResultState(progressState, resultState, doneBtn, closeHeaderBtn);

      if (detailTime) detailTime.textContent = data.timestamp ? new Date(data.timestamp).toLocaleString() : new Date().toLocaleString();
      if (detailFile) detailFile.textContent = data.local_file ? data.local_file.split(/[\/\\]/).pop() : 'N/A';
      if (detailStatus) detailStatus.textContent = statusStr;

      if (statusStr === 'SUCCESS') {
        resultIcon.innerHTML = '<i class="bi bi-check-circle-fill text-success" style="font-size: 3rem;"></i>';
        resultTitle.textContent = 'Backup Completed Successfully!';
        resultTitle.className = 'fw-bold text-success mb-1';
        detailStatus.className = 'fw-bold text-success';
        resultMessage.textContent = response.message || 'Database snapshot created and synced to Google Sheets.';
        
        if (data.spreadsheet_url) {
          openSheetBtn.href = data.spreadsheet_url;
          openSheetBtn.style.display = 'inline-block';
        }
      } else if (statusStr === 'PARTIAL') {
        resultIcon.innerHTML = '<i class="bi bi-exclamation-triangle-fill text-warning" style="font-size: 3rem;"></i>';
        resultTitle.textContent = 'Local Snapshot Backup Created';
        resultTitle.className = 'fw-bold text-warning mb-1';
        detailStatus.className = 'fw-bold text-warning';
        resultMessage.textContent = response.message || 'Local database snapshot was saved. Google Sheets sync was skipped or requires credentials.';
      } else {
        resultIcon.innerHTML = '<i class="bi bi-x-circle-fill text-danger" style="font-size: 3rem;"></i>';
        resultTitle.textContent = 'Backup Failed';
        resultTitle.className = 'fw-bold text-danger mb-1';
        detailStatus.className = 'fw-bold text-danger';
        resultMessage.textContent = (response && response.message) ? response.message : 'An unexpected error occurred while creating the backup.';
      }

      await this.loadBackupStatus();
    } catch (err) {
      clearInterval(progressTimer);
      this._showBackupResultState(progressState, resultState, doneBtn, closeHeaderBtn);

      resultIcon.innerHTML = '<i class="bi bi-x-circle-fill text-danger" style="font-size: 3rem;"></i>';
      resultTitle.textContent = 'Backup Error';
      resultTitle.className = 'fw-bold text-danger mb-1';
      resultMessage.textContent = err.message || 'Failed to communicate with backup service.';
      if (detailStatus) detailStatus.textContent = 'ERROR';
      if (detailStatus) detailStatus.className = 'fw-bold text-danger';
    } finally {
      if (triggerBtn) triggerBtn.disabled = false;
    }
  },


  async loadBackupStatus() {
    try {
      const response = await Api.call('getBackupStatus');
      if (response && response.success && response.data) {
        const el = document.getElementById('backupLastTime');
        if (el) {
          const d = response.data;
          if (d.timestamp) {
            const dateObj = new Date(d.timestamp);
            el.textContent = dateObj.toLocaleDateString() + ' ' + dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          } else {
            el.textContent = 'Active (Scheduled)';
          }
        }
      }
    } catch (e) {
      // Ignore background status fetch error
    }
  },


  setRefreshBtnState(loading) {
    const btn = document.getElementById('dashboardRefreshBtn');
    if (btn) {
      btn.disabled = loading;
      btn.classList.toggle('dash-refresh-spinning', loading);
    }
  },

  setLastUpdated(isoString) {
    const el = document.getElementById('dashboardLastUpdated');
    if (!el) return;
    const d = isoString ? new Date(isoString) : new Date();
    el.textContent = 'Updated ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  },

  renderError(message) {
    App.Utils.showToast(message || 'Failed to load dashboard data', true);
    const lastUpdatedEl = document.getElementById('dashboardLastUpdated');
    if (lastUpdatedEl) {
      lastUpdatedEl.innerHTML = '<span class="text-danger">Failed to refresh</span> &middot; ' +
        '<a href="#" onclick="App.Dashboard.loadData(); return false;">Retry</a>';
    }
    if (this.hasLoadedOnce) return;

    ['kpiOpenPoCount', 'kpiBillsMonthCount', 'kpiLowStockCount', 'kpiPendingProduction',
      'kpiReadyDispatch', 'kpiContractorPayables', 'kpiReturnsMonthCount', 'kpiWastageMonthQty']
      .forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '—'; });

    const pipelineEl = document.getElementById('dashboardPipeline');
    if (pipelineEl) pipelineEl.innerHTML = '<div class="text-danger small">Failed to load pipeline data.</div>';

    this.renderTableError('dashLowStockBody', 4);
    this.renderTableError('dashReadyToDispatchBody', 3);
    this.renderTableError('dashContractorPayablesBody', 2);
  },

  renderTableError(tbodyId, colspan) {
    const tbody = document.getElementById(tbodyId);
    if (tbody) tbody.innerHTML = `<tr><td colspan="${colspan}" class="text-danger text-center">Failed to load.</td></tr>`;
  },

  renderTableFooter(footerId, shownCount, totalCount, tabId) {
    const el = document.getElementById(footerId);
    if (!el) return;
    if (!totalCount || totalCount <= shownCount) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = `Showing ${shownCount} of ${totalCount} &middot; ` +
      `<a href="#" onclick="App.Navigation.showTab('${tabId}'); return false;">View all</a>`;
  },

  deltaLabel(curr, prev) {
    const diff = Math.round((curr - prev) * 100) / 100;
    if (diff === 0) return '<span class="dash-kpi-delta">No change vs last mo.</span>';
    const icon = diff > 0 ? '&#9650;' : '&#9660;';
    return `<span class="dash-kpi-delta">${icon} ${Math.abs(diff)} vs last mo.</span>`;
  },

  renderKpis(k) {
    const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    const setHtml = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };

    set('kpiOpenPoCount', k.openPoCount);
    setHtml('kpiOpenPoValue', `${formatCurrency(k.openPoValue)} pending`);

    set('kpiBillsMonthCount', k.billsThisMonthCount);
    setHtml('kpiBillsMonthValue', `${formatCurrency(k.billsThisMonthValue)} &middot; ${this.deltaLabel(k.billsThisMonthCount, k.billsLastMonthCount)}`);

    set('kpiLowStockCount', k.lowStockCount);
    setHtml('kpiLowStockSub', k.lowStockTotalDeficit > 0 ? `${k.lowStockTotalDeficit} units short` : 'No shortfall');

    set('kpiPendingProduction', k.pendingProductionCount);
    setHtml('kpiPendingProductionSub', k.oldestPendingProductionDays === null
      ? '&nbsp;'
      : `Oldest: ${k.oldestPendingProductionDays}d`);

    set('kpiReadyDispatch', k.readyToDispatchUnits);
    setHtml('kpiReadyDispatchSub', `${k.readyToDispatchProductCount} product${k.readyToDispatchProductCount === 1 ? '' : 's'}`);

    set('kpiContractorPayables', formatCurrency(k.contractorPayablesDue));
    setHtml('kpiContractorPayablesSub', `${k.contractorPayablesCount} contractor${k.contractorPayablesCount === 1 ? '' : 's'}`);

    set('kpiReturnsMonthCount', k.returnsThisMonthCount);
    setHtml('kpiReturnsMonthSub', `${formatCurrency(k.returnsThisMonthValue)} &middot; ${this.deltaLabel(k.returnsThisMonthCount, k.returnsLastMonthCount)}`);

    set('kpiWastageMonthQty', formatQty(k.wastageThisMonthQty));
    setHtml('kpiWastageMonthSub', `${k.wastageThisMonthCount} record${k.wastageThisMonthCount === 1 ? '' : 's'} &middot; ${this.deltaLabel(k.wastageThisMonthQty, k.wastageLastMonthQty)}`);
  },

  renderPipeline(pipeline) {
    const el = document.getElementById('dashboardPipeline');
    if (!el) return;
    if (!pipeline || pipeline.length === 0) {
      el.innerHTML = '<div class="text-muted small">No active processes configured.</div>';
      return;
    }
    el.innerHTML = pipeline.map((p, i) => `
      <div class="dash-pipeline-stage dash-pipeline-clickable" onclick="App.Dashboard.openPipelineStage('${escapeHtml(p.processId)}')" role="button" tabindex="0" title="View ${escapeHtml(p.processName)} in Production">
        <div class="dash-pipeline-name">${escapeHtml(p.processName)}</div>
        <div class="dash-pipeline-total">${p.totalQty} unit${p.totalQty === 1 ? '' : 's'} &middot; ${p.totalLotCount} lot${p.totalLotCount === 1 ? '' : 's'}</div>
        <div class="dash-pipeline-groups">
          ${p.groups.length === 0
            ? '<div class="dash-pipeline-empty">No active lots</div>'
            : p.groups.map(g => `
                <div class="dash-pipeline-group-row">
                  <span class="dash-pipeline-group-title" title="${escapeHtml(g.title)}">${escapeHtml(g.title)}</span>
                  <span class="dash-pipeline-group-qty">${g.qty}</span>
                </div>
              `).join('')}
        </div>
      </div>
      ${i < pipeline.length - 1 ? '<div class="dash-pipeline-arrow"><i class="bi bi-arrow-right"></i></div>' : ''}
    `).join('');
  },

  async openPipelineStage(processId) {
    App.Navigation.showTab('productionTab');
    await App.Production.loadData();
    App.Production.openColorwiseSummaryModal(processId);
  },

  renderLowStock(items, totalCount) {
    const tbody = document.getElementById('dashLowStockBody');
    if (!tbody) return;
    if (!items || items.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="text-muted text-center">No low stock items.</td></tr>';
      this.renderTableFooter('dashLowStockFooter', 0, 0, 'stockTab');
      return;
    }
    tbody.innerHTML = items.map(i => `
      <tr style="cursor:pointer" onclick="App.Navigation.showTab('stockTab')">
        <td>${escapeHtml(i.name)}</td>
        <td>${escapeHtml(i.size || '-')}</td>
        <td class="text-end text-danger fw-bold">${i.currentStock}</td>
        <td class="text-end">${i.threshold}</td>
      </tr>
    `).join('');
    this.renderTableFooter('dashLowStockFooter', items.length, totalCount, 'stockTab');
  },

  renderReadyToDispatch(items, totalCount) {
    const tbody = document.getElementById('dashReadyToDispatchBody');
    if (!tbody) return;
    if (!items || items.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" class="text-muted text-center">Nothing ready to dispatch.</td></tr>';
      this.renderTableFooter('dashReadyToDispatchFooter', 0, 0, 'dispatchTab');
      return;
    }
    tbody.innerHTML = items.map(r => `
      <tr>
        <td style="cursor:pointer" onclick="App.Navigation.showTab('dispatchTab')">${escapeHtml(r.productName)}</td>
        <td class="text-end text-success fw-bold">${formatQty(r.readyQty)}</td>
        <td class="text-end">
          <button class="btn btn-sm btn-success" onclick="App.Dashboard.openDispatchFor('${escapeHtml(r.productId)}')">Dispatch</button>
        </td>
      </tr>
    `).join('');
    this.renderTableFooter('dashReadyToDispatchFooter', items.length, totalCount, 'dispatchTab');
  },

  openDispatchFor(productId) {
    App.Navigation.showTab('dispatchTab');
    App.Dispatch.enterTab().then(() => App.Dispatch.openCreateDispatchModal(productId));
  },

  renderContractorPayables(rows, totalCount) {
    const tbody = document.getElementById('dashContractorPayablesBody');
    if (!tbody) return;
    if (!rows || rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="2" class="text-muted text-center">No outstanding payables.</td></tr>';
      this.renderTableFooter('dashContractorPayablesFooter', 0, 0, 'contractorsTab');
      return;
    }
    tbody.innerHTML = rows.map(r => `
      <tr style="cursor:pointer" onclick="App.Navigation.showTab('contractorsTab')">
        <td>${escapeHtml(r.contractorName)}</td>
        <td class="text-end fw-bold">${formatCurrency(r.balanceDue)}</td>
      </tr>
    `).join('');
    this.renderTableFooter('dashContractorPayablesFooter', rows.length, totalCount, 'contractorsTab');
  },

  renderProductionStatusChart(breakdown) {
    const canvas = document.getElementById('dashProductionStatusChart');
    if (!canvas || typeof Chart === 'undefined') return;
    if (this.charts.status) this.charts.status.destroy();

    const colors = { Pending: '#94a3b8', 'In Progress': '#fbbf24', Completed: '#34d399', Cancelled: '#f87171' };
    this.charts.status = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: (breakdown || []).map(b => b.status),
        datasets: [{
          data: (breakdown || []).map(b => b.count),
          backgroundColor: (breakdown || []).map(b => colors[b.status] || '#6366f1')
        }]
      },
      options: { plugins: { legend: { position: 'bottom' } }, maintainAspectRatio: false }
    });
  },

  renderDispatchTrendChart(trend) {
    const canvas = document.getElementById('dashDispatchTrendChart');
    if (!canvas || typeof Chart === 'undefined') return;
    if (this.charts.trend) this.charts.trend.destroy();

    this.charts.trend = new Chart(canvas, {
      type: 'line',
      data: {
        labels: (trend || []).map(t => t.date.slice(5)),
        datasets: [{
          label: 'Qty Dispatched',
          data: (trend || []).map(t => t.qty),
          borderColor: '#6366f1',
          backgroundColor: 'rgba(99,102,241,0.15)',
          fill: true,
          tension: 0.3
        }]
      },
      options: {
        plugins: { legend: { display: false } },
        maintainAspectRatio: false,
        scales: { y: { beginAtZero: true } }
      }
    });
  }
};
