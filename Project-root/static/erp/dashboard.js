'use strict';
// dashboard.js -- App.Dashboard, ported from Apps_Script/Script_Dashboard.html.
// Talks to the getDashboardData RPC (app/erp/services/dashboard_service.py);
// the response shape is unchanged by the layout redesign in
// templates/erp/partials/dashboard.html, which reorganised and re-ranked
// the same payload rather than asking the server for anything new.
//
// The renderer's job here is to make a number legible without the reader
// already knowing what a good value is. Two rules carry that:
//
//   * THRESHOLDS (below) turn a raw number into ok/warn/critical, which
//     the template paints via [data-status]. Colour reports whether a
//     number is BAD, never merely which metric it belongs to.
//   * Whatever the colour says, the tile's note says in words too, so the
//     state survives greyscale, colour-blindness and a screen reader
//     (WCAG 1.4.1). See static/erp/tests/dashboard_status.test.js.
//
// Chart colours are read from the CSS custom properties rather than
// hardcoded, so both charts follow the app palette and actually respond to
// the dark-mode toggle.
//
// Refresh cadence: every REFRESH_INTERVAL_MS while the Dashboard tab is
// open AND the browser tab is visible, plus on entering the tab and on the
// manual refresh button. core.js's showTab tears the timer down when you
// navigate away, so it never polls from a background tab. Scheduling is a
// self-rescheduling setTimeout keyed off _msUntilDue rather than a plain
// setInterval -- see _scheduleRefresh for why both of those matter.
//
// Each refresh rebuilds its containers' innerHTML outright, which destroys
// whatever the user had tabbed to. _captureFocus/_restoreFocus put that
// focus back on the same logical control, matching on data-action plus the
// row's own id rather than on a node reference.

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
    await loadScript(
        'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
        'sha384-e6nUZLBkQ86NJ6TVVKAeSaK8jWa3NhkYWZFomE39AvDbQWeie9PlQqM3pmYW5d1g'
      );
    this.chartLibLoaded = true;
  },

  // Milliseconds until the next refresh is due, given when we last tried.
  // Time spent with the browser tab hidden counts toward it: the timer is
  // torn down while hidden, so on returning this is what decides whether
  // the data on screen is already stale enough to reload at once.
  _msUntilDue() {
    if (!this._lastLoadAt) return 0;
    return Math.max(0, this.REFRESH_INTERVAL_MS - (Date.now() - this._lastLoadAt));
  },

  // A self-rescheduling setTimeout rather than setInterval. Two reasons:
  // a slow or hung load can no longer have the next tick fire on top of it
  // (setInterval queues regardless of whether the previous run finished),
  // and an arbitrary first delay becomes expressible -- which is what lets
  // a tab returning from hidden refresh immediately instead of waiting out
  // a fresh full interval.
  _scheduleRefresh(delayMs) {
    this.stopAutoRefresh({ keepVisibilityHandler: true, keepActive: true });
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      Promise.resolve(this.loadData()).then(() => {
        // _autoRefreshActive is what stops a load that was already in
        // flight when the user navigated to another tab from re-arming a
        // timer for the tab they just left: showTab calls stopAutoRefresh
        // synchronously, but it cannot cancel this pending .then().
        if (this._autoRefreshActive && document.visibilityState !== 'hidden') {
          this._scheduleRefresh(this.REFRESH_INTERVAL_MS);
        }
      });
    }, delayMs);
  },

  startAutoRefresh() {
    this.stopAutoRefresh();
    this._autoRefreshActive = true;
    if (!this._visibilityHandler) {
      this._visibilityHandler = () => {
        if (document.visibilityState === 'hidden') {
          if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
          }
          return;
        }
        // Back in view. Previously this only armed a fresh 5-minute
        // interval, so a tab left alone for three hours went on showing
        // three-hour-old numbers for up to five minutes more. _msUntilDue
        // returns 0 in that case and the reload happens on the next tick
        // of the event loop; a quick flick away and back is still within
        // the interval and does not refetch.
        if (!this.refreshTimer) this._scheduleRefresh(this._msUntilDue());
      };
    }
    document.addEventListener('visibilitychange', this._visibilityHandler);
    if (document.visibilityState !== 'hidden') {
      this._scheduleRefresh(this._msUntilDue());
    }
  },

  // The two `keep*` options are for _scheduleRefresh's own re-arming, which
  // must not tear down the listener that will re-arm it later, nor mark
  // auto-refresh as stopped. Every other caller wants the full teardown.
  stopAutoRefresh(options) {
    if (!(options && options.keepActive)) this._autoRefreshActive = false;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this._visibilityHandler && !(options && options.keepVisibilityHandler)) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
    }
  },

  // Regions rebuilt wholesale by a refresh. Anything focused inside one of
  // them is destroyed by that rebuild.
  REDRAWN_REGIONS: '#dashboardPipeline, #dashLowStockBody, #dashReadyToDispatchBody, ' +
    '#dashContractorPayablesBody, .dash-table-footer',

  // Identify the focused control well enough to find it again after the
  // rebuild. Its data-action names WHAT it is; one of the id attributes
  // names WHICH one. Together they survive a re-render, where a node
  // reference does not.
  _captureFocus() {
    const el = document.activeElement;
    if (!el || el === document.body || !el.closest) return null;
    if (!el.closest(this.REDRAWN_REGIONS)) return null;
    if (!el.dataset || !el.dataset.action) return null;
    return { action: el.dataset.action, key: this._focusKey(el) };
  },

  _focusKey(el) {
    return el.dataset.processid || el.dataset.productid || el.dataset.tab || '';
  },

  // Deliberately matches by iterating rather than by building a selector
  // string: the key half is a process/product id -- user-controlled data --
  // and interpolating that into a querySelector is how you get a thrown
  // SyntaxError on the first id containing a quote or bracket.
  _restoreFocus(token) {
    if (!token) return;
    const root = document.getElementById('dashboardTab');
    if (!root) return;
    for (const el of root.querySelectorAll('[data-action]')) {
      if (el.dataset.action !== token.action) continue;
      if (this._focusKey(el) !== token.key) continue;
      // preventScroll: the row was on screen when it had focus, and
      // yanking the viewport back mid-refresh would be worse than the
      // focus loss this is fixing.
      el.focus({ preventScroll: true });
      return;
    }
    // No match: the stage or product legitimately disappeared between
    // refreshes. Leaving focus on <body> is correct -- moving it somewhere
    // arbitrary would be worse.
  },

  async loadData() {
    if (this.isLoading) return;
    this.isLoading = true;
    // Last ATTEMPT, not last success: a failing endpoint plus a user
    // switching browser tabs must not turn into an immediate-retry loop.
    // A failed load surfaces its own Retry control via renderError.
    this._lastLoadAt = Date.now();
    this.setRefreshBtnState(true);
    try {
      // Start the Chart.js CDN fetch alongside the RPC instead of after it.
      // These are independent, and awaiting the library only after every
      // table had already rendered made the two charts the last thing on
      // the page to appear by a full network round trip. Rejection is
      // swallowed here so a blocked CDN costs the charts but not the rest
      // of the dashboard; the render calls below no-op when Chart is
      // undefined.
      const chartLibReady = this.ensureChartLib().catch(() => {});
      const response = await Api.call('getDashboardData');
      if (!response.success) {
        this.renderError(response.message);
        return;
      }
      const data = response.data;

      // Every render below replaces its container's innerHTML, so a control
      // the user had tabbed to is destroyed and focus falls back to <body>.
      const focused = this._captureFocus();

      this.renderKpis(data.kpis);
      this.renderPipeline(data.pipeline);
      this.renderLowStock(data.lowStockItems, data.lowStockTotalCount);
      this.renderReadyToDispatch(data.readyToDispatchItems, data.readyToDispatchTotalCount);
      this.renderContractorPayables(data.contractorPayables, data.contractorPayablesTotalCount);

      this._restoreFocus(focused);

      this.hasLoadedOnce = true;
      this.setLastUpdated(data.generatedAt);
      this.loadBackupStatus();

      await chartLibReady;
      this.renderProductionStatusChart(data.productionStatusBreakdown);
      this.renderDispatchTrendChart(data.dispatchTrend);
    } catch (err) {
      this.renderError(err.message || 'Failed to load dashboard data');
    } finally {
      this.isLoading = false;
      this.setRefreshBtnState(false);
    }
  },

  _showBackupResultState(progressState, resultState, doneBtn, closeHeaderBtn) {
    progressState.style.display = 'none';
    resultState.style.display = 'block';
    doneBtn.style.display = 'inline-block';
    closeHeaderBtn.style.display = 'block';
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
        '<button type="button" class="btn btn-link btn-sm p-0 align-baseline" data-action="dash-retry">Retry</button>';
    }
    if (this.hasLoadedOnce) return;

    ['kpiOpenPoCount', 'kpiBillsMonthCount', 'kpiLowStockCount', 'kpiPendingProduction',
      'kpiReadyDispatch', 'kpiContractorPayables', 'kpiReturnsMonthCount', 'kpiWastageMonthQty']
      .forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '—'; });

    // Clear any status colour too: a stale amber/red border on a tile whose
    // number failed to load reads as a live alert about that metric.
    ['heroLowStock', 'heroPendingProduction', 'heroReadyDispatch', 'heroContractorPayables']
      .forEach(id => { const el = document.getElementById(id); if (el) el.setAttribute('data-status', 'neutral'); });

    ['kpiLowStockSub', 'kpiPendingProductionSub', 'kpiReadyDispatchSub', 'kpiContractorPayablesSub']
      .forEach(id => { const el = document.getElementById(id); if (el) el.textContent = 'Unavailable'; });

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

  // Always renders a "View all" control, not only when the list is
  // truncated. The table rows themselves are click-to-navigate, but a <tr>
  // takes no keyboard focus -- without a real focusable link here, these
  // three panels had no keyboard route to the tab they summarise.
  renderTableFooter(footerId, shownCount, totalCount, tabId, tabLabel) {
    const el = document.getElementById(footerId);
    if (!el) return;
    const truncated = totalCount && totalCount > shownCount;
    const prefix = truncated ? `Showing ${shownCount} of ${totalCount} &middot; ` : '';
    el.innerHTML = `${prefix}<button type="button" class="btn btn-link btn-sm p-0 align-baseline" ` +
      `data-action="show-tab" data-tab="${escapeHtml(tabId)}">View all in ${escapeHtml(tabLabel)}</button>`;
  },

  // Thresholds that turn a raw number into a status the user can read
  // without already knowing what a good value looks like. These are the
  // single place to tune "when does this go amber / red" -- they are
  // deliberately plain numbers rather than anything derived, because they
  // encode a business judgement about this shop floor, not a computation.
  //
  // Defaults chosen to be conservative: a metric only escalates when it is
  // unambiguously worth interrupting someone over.
  THRESHOLDS: {
    // Distinct items sitting below their reorder threshold.
    lowStockCount: { warn: 1, critical: 6 },
    // Age in days of the OLDEST lot still Pending/In Progress. Age is a
    // far better distress signal than the open-lot count: 40 lots opened
    // this morning is a busy day, one lot open for three weeks is a
    // problem.
    oldestProductionDays: { warn: 7, critical: 15 },
    // Contractor money owed, in rupees. Payables always exist in a
    // working shop, so any outstanding balance shows amber and nothing
    // here ever reaches critical: no `critical` bound is set, because
    // "how much owed is an emergency" is a business call this file should
    // not invent. Add one here if the shop wants that escalation.
    contractorPayables: { warn: 1 },
  },

  // status: 'ok' | 'warn' | 'critical' | 'neutral'
  _statusFor(value, bounds) {
    if (value === null || value === undefined) return 'neutral';
    if (bounds.critical !== undefined && value >= bounds.critical) return 'critical';
    if (bounds.warn !== undefined && value >= bounds.warn) return 'warn';
    return 'ok';
  },

  _setHero(heroId, valueId, noteId, value, status, note) {
    const hero = document.getElementById(heroId);
    if (hero) hero.setAttribute('data-status', status);
    const valueEl = document.getElementById(valueId);
    if (valueEl) valueEl.textContent = value;
    const noteEl = document.getElementById(noteId);
    if (noteEl) noteEl.innerHTML = note;
  },

  // Percentage change vs last month. The old version printed the raw
  // difference ("3 vs last mo."), which cannot be interpreted without
  // knowing the base -- 3 more on a base of 4 and 3 more on a base of 400
  // rendered identically. Direction is carried by the arrow glyph as well
  // as by the wording, never by colour alone (WCAG 1.4.1), and is not
  // colour-coded at all: "up" is good for Bills and bad for Wastage, so a
  // single up-is-green palette would mislead on half the strip.
  deltaLabel(curr, prev) {
    const current = toNumber(curr);
    const previous = toNumber(prev);

    if (previous === 0) {
      if (current === 0) return '<span class="dash-delta" data-dir="flat">no change vs last mo.</span>';
      return '<span class="dash-delta" data-dir="up">new vs last mo.</span>';
    }

    const pct = Math.round(((current - previous) / Math.abs(previous)) * 100);
    if (pct === 0) return '<span class="dash-delta" data-dir="flat">about level vs last mo.</span>';

    const dir = pct > 0 ? 'up' : 'down';
    const glyph = pct > 0 ? '&#9650;' : '&#9660;';
    return `<span class="dash-delta" data-dir="${dir}">${glyph} ${Math.abs(pct)}% vs last mo.</span>`;
  },

  renderKpis(k) {
    const setHtml = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
    const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

    // -- Needs Attention -----------------------------------------------
    // Each note states the status in words as well as in colour, so the
    // tile still reads correctly in greyscale or to a screen reader.

    const lowStock = toNumber(k.lowStockCount);
    this._setHero(
      'heroLowStock', 'kpiLowStockCount', 'kpiLowStockSub',
      lowStock,
      this._statusFor(lowStock, this.THRESHOLDS.lowStockCount),
      lowStock === 0
        ? 'All items above threshold'
        : `${plural(lowStock, 'item')} below threshold &middot; ${formatQty(k.lowStockTotalDeficit)} units short`
    );

    const pending = toNumber(k.pendingProductionCount);
    const oldestDays = k.oldestPendingProductionDays;
    this._setHero(
      'heroPendingProduction', 'kpiPendingProduction', 'kpiPendingProductionSub',
      pending,
      pending === 0 ? 'ok' : this._statusFor(oldestDays, this.THRESHOLDS.oldestProductionDays),
      pending === 0
        ? 'No lots open'
        : (oldestDays === null || oldestDays === undefined
          ? `${plural(pending, 'lot')} open`
          : `${plural(pending, 'lot')} open &middot; oldest ${plural(oldestDays, 'day')}`)
    );

    const readyUnits = toNumber(k.readyToDispatchUnits);
    const readyProducts = toNumber(k.readyToDispatchProductCount);
    this._setHero(
      'heroReadyDispatch', 'kpiReadyDispatch', 'kpiReadyDispatchSub',
      formatQty(readyUnits),
      readyUnits > 0 ? 'ok' : 'neutral',
      readyUnits > 0
        ? `${plural(readyProducts, 'product')} ready to ship`
        : 'Nothing waiting to ship'
    );

    const payables = toNumber(k.contractorPayablesDue);
    const payableCount = toNumber(k.contractorPayablesCount);
    this._setHero(
      'heroContractorPayables', 'kpiContractorPayables', 'kpiContractorPayablesSub',
      formatCurrency(payables),
      this._statusFor(payables, this.THRESHOLDS.contractorPayables),
      payables > 0
        ? `Owed to ${plural(payableCount, 'contractor')}`
        : 'Nothing outstanding'
    );

    // -- This Month ----------------------------------------------------
    setText('kpiOpenPoCount', k.openPoCount);
    setHtml('kpiOpenPoValue', `${formatCurrency(k.openPoValue)} pending`);

    setText('kpiBillsMonthCount', k.billsThisMonthCount);
    setHtml('kpiBillsMonthValue',
      `${formatCurrency(k.billsThisMonthValue)} &middot; ${this.deltaLabel(k.billsThisMonthCount, k.billsLastMonthCount)}`);

    setText('kpiReturnsMonthCount', k.returnsThisMonthCount);
    setHtml('kpiReturnsMonthSub',
      `${formatCurrency(k.returnsThisMonthValue)} &middot; ${this.deltaLabel(k.returnsThisMonthCount, k.returnsLastMonthCount)}`);

    setText('kpiWastageMonthQty', formatQty(k.wastageThisMonthQty));
    setHtml('kpiWastageMonthSub',
      `${plural(toNumber(k.wastageThisMonthCount), 'record')} &middot; ${this.deltaLabel(k.wastageThisMonthQty, k.wastageLastMonthQty)}`);
  },

  // The literal dashboard_service._get_pipeline_data falls back to when a
  // lot carries neither a product name nor a size. A stage whose ONLY group
  // is this one has nothing to add to its own total, so its breakdown is
  // suppressed -- that case was the bulk of the old pipeline's height,
  // rendering a full-width "Unspecified <n>" row that just restated the
  // number printed directly above it.
  UNSPECIFIED_GROUP_TITLE: 'Unspecified',

  // Breakdown chips shown inline before collapsing to "+N more". The rest
  // are one click away in the stage's colourwise summary modal.
  PIPELINE_CHIP_LIMIT: 3,

  // A stage's breakdown earns its space only if it says something the
  // stage header does not.
  _informativeGroups(stage) {
    const groups = stage.groups || [];
    if (groups.length === 0) return [];
    if (groups.length === 1 && groups[0].title === this.UNSPECIFIED_GROUP_TITLE) return [];
    return groups;
  },

  renderPipeline(pipeline) {
    const el = document.getElementById('dashboardPipeline');
    if (!el) return;
    if (!pipeline || pipeline.length === 0) {
      el.innerHTML = '<div class="text-muted small">No active processes configured.</div>';
      return;
    }

    // Was a wrapping flex of full-size cards with a "->" between each: at a
    // dozen active processes that ran past a full screen, and the arrows
    // pointed off the end of every wrapped line at nothing. A ranked list
    // reads top-to-bottom in the same sequence order, in a fraction of the
    // height, and adds the two things the card wall could not show at all:
    // how the stages compare, and where the most material is sitting.
    const qtyOf = p => toNumber(p.totalQty);
    const totalQty = pipeline.reduce((sum, p) => sum + qtyOf(p), 0);
    const totalLots = pipeline.reduce((sum, p) => sum + toNumber(p.totalLotCount), 0);
    const peakQty = Math.max(...pipeline.map(qtyOf));

    const summary =
      `<div class="dash-wip-summary">
         <span><strong>${formatQty(totalQty)}</strong> units in progress</span>
         <span><strong>${totalLots}</strong> lot${totalLots === 1 ? '' : 's'}</span>
         <span>across <strong>${pipeline.length}</strong> stage${pipeline.length === 1 ? '' : 's'}</span>
       </div>`;

    const rows = pipeline.map((p, i) => {
      const qty = qtyOf(p);
      // Bar is scaled against the busiest stage, not the total: with a
      // dozen stages every share-of-total bar would be a stub, and the
      // useful comparison here is between stages anyway.
      const width = peakQty > 0 ? Math.max((qty / peakQty) * 100, 1.5) : 0;
      const isPeak = qty === peakQty && peakQty > 0;
      const groups = this._informativeGroups(p);
      const shown = groups.slice(0, this.PIPELINE_CHIP_LIMIT);
      const hidden = groups.length - shown.length;

      const chips = groups.length === 0 ? '' : `
        <span class="dash-wip-chips">
          ${shown.map(g => `
            <span class="dash-wip-chip" title="${escapeHtml(g.title)}">
              <span class="dash-wip-chip-title">${escapeHtml(g.title)}</span>
              <span class="dash-wip-chip-qty">${formatQty(g.qty)}</span>
            </span>`).join('')}
          ${hidden > 0 ? `<span class="dash-wip-chip dash-wip-chip-more">+${hidden} more</span>` : ''}
        </span>`;

      return `
        <button type="button" class="dash-wip-row" data-action="dash-pipeline-stage"
                data-processid="${encodeURIComponent(p.processId)}"
                title="View ${escapeHtml(p.processName)} in Production">
          <span class="dash-wip-seq">${i + 1}</span>
          <span class="dash-wip-name">${escapeHtml(p.processName)}</span>
          <span class="dash-wip-bar">
            <span class="dash-wip-bar-fill" data-peak="${isPeak}" style="width:${width.toFixed(1)}%"></span>
          </span>
          <span class="dash-wip-qty">${formatQty(qty)}<small> units</small></span>
          <span class="dash-wip-lots">${p.totalLotCount} lot${p.totalLotCount === 1 ? '' : 's'}</span>
          ${isPeak && pipeline.length > 1
            ? '<span class="dash-wip-peak" title="More units are sitting at this stage than at any other">most WIP</span>'
            : ''}
          ${chips}
        </button>`;
    }).join('');

    el.innerHTML = summary + `<div class="dash-wip-list">${rows}</div>`;
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
      this.renderTableFooter('dashLowStockFooter', 0, 0, 'stockTab', 'Stock');
      return;
    }
    tbody.innerHTML = items.map(i => `
      <tr class="dash-row-link" data-action="show-tab" data-tab="stockTab">
        <td>${escapeHtml(i.name)}</td>
        <td>${escapeHtml(i.size || '-')}</td>
        <td class="text-end text-danger fw-bold">${formatQty(i.currentStock)}</td>
        <td class="text-end">${formatQty(i.threshold)}</td>
      </tr>
    `).join('');
    this.renderTableFooter('dashLowStockFooter', items.length, totalCount, 'stockTab', 'Stock');
  },

  renderReadyToDispatch(items, totalCount) {
    const tbody = document.getElementById('dashReadyToDispatchBody');
    if (!tbody) return;
    if (!items || items.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" class="text-muted text-center">Nothing ready to dispatch.</td></tr>';
      this.renderTableFooter('dashReadyToDispatchFooter', 0, 0, 'dispatchTab', 'Dispatch');
      return;
    }
    tbody.innerHTML = items.map(r => `
      <tr>
        <td class="dash-row-link" data-action="show-tab" data-tab="dispatchTab">${escapeHtml(r.productName)}</td>
        <td class="text-end text-success fw-bold">${formatQty(r.readyQty)}</td>
        <td class="text-end">
          <button type="button" class="btn btn-sm btn-success"
                  data-action="dash-dispatch-product" data-productid="${encodeURIComponent(r.productId)}">Dispatch</button>
        </td>
      </tr>
    `).join('');
    this.renderTableFooter('dashReadyToDispatchFooter', items.length, totalCount, 'dispatchTab', 'Dispatch');
  },

  openDispatchFor(productId) {
    App.Navigation.showTab('dispatchTab');
    App.Dispatch.enterTab().then(() => App.Dispatch.openCreateDispatchModal(productId));
  },

  openNewDispatch() {
    App.Navigation.showTab('dispatchTab');
    App.Dispatch.enterTab().then(() => App.Dispatch.openCreateDispatchModal());
  },

  renderContractorPayables(rows, totalCount) {
    const tbody = document.getElementById('dashContractorPayablesBody');
    if (!tbody) return;
    if (!rows || rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="2" class="text-muted text-center">No outstanding payables.</td></tr>';
      this.renderTableFooter('dashContractorPayablesFooter', 0, 0, 'contractorsTab', 'Contractors');
      return;
    }
    tbody.innerHTML = rows.map(r => `
      <tr class="dash-row-link" data-action="show-tab" data-tab="contractorsTab">
        <td>${escapeHtml(App.Utils.formatNameCase(r.contractorName))}</td>
        <td class="text-end fw-bold">${formatCurrency(r.balanceDue)}</td>
      </tr>
    `).join('');
    this.renderTableFooter('dashContractorPayablesFooter', rows.length, totalCount, 'contractorsTab', 'Contractors');
  },

  // Chart colours are read from the CSS design tokens rather than hardcoded,
  // so the charts follow the same palette as the rest of the app AND
  // actually respond to the dark-mode toggle. Previously these were five
  // literal hexes that matched neither the light tokens nor the dark ones,
  // leaving both charts stuck in light-theme colours on a dark page.
  _chartPalette() {
    const css = getComputedStyle(document.documentElement);
    const tok = (name, fallback) => (css.getPropertyValue(name) || '').trim() || fallback;
    const accent = tok('--secondary-color', '#6366f1');
    return {
      accent,
      accentFill: tok('--secondary-light', '#818cf8'),
      surface: tok('--bg-light', '#ffffff'),
      grid: tok('--border-color', '#e2e8f0'),
      text: tok('--text-secondary', '#64748b'),
      byStatus: {
        Pending: tok('--text-secondary', '#64748b'),
        'In Progress': tok('--warning-color', '#ffc107'),
        Completed: tok('--success-color', '#15803d'),
        Cancelled: tok('--danger-color', '#dc3545'),
      },
      fallback: accent,
    };
  },

  // Re-theme both charts in place when the dark-mode toggle flips
  // <html data-theme>. Cheap: the last payload is kept so this never
  // re-fetches, and the observer is installed once.
  _watchThemeChanges() {
    if (this._themeObserver) return;
    this._themeObserver = new MutationObserver(() => {
      if (this._lastStatusBreakdown) this.renderProductionStatusChart(this._lastStatusBreakdown);
      if (this._lastDispatchTrend) this.renderDispatchTrendChart(this._lastDispatchTrend);
    });
    this._themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
  },

  renderProductionStatusChart(breakdown) {
    const canvas = document.getElementById('dashProductionStatusChart');
    if (!canvas || typeof Chart === 'undefined') return;
    this._lastStatusBreakdown = breakdown;
    this._watchThemeChanges();

    const rows = breakdown || [];
    const palette = this._chartPalette();
    const labels = rows.map(b => b.status);
    const data = rows.map(b => b.count);
    const colors = rows.map(b => palette.byStatus[b.status] || palette.fallback);

    // Update in place rather than destroy/recreate: a full rebuild on every
    // 5-minute auto-refresh re-runs the entry animation and throws away any
    // legend items the user had toggled off.
    if (this.charts.status) {
      const chart = this.charts.status;
      chart.data.labels = labels;
      chart.data.datasets[0].data = data;
      chart.data.datasets[0].backgroundColor = colors;
      chart.data.datasets[0].borderColor = palette.surface;
      chart.options.plugins.legend.labels.color = palette.text;
      chart.update();
      return;
    }

    this.charts.status = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{
          data,
          backgroundColor: colors,
          // A surface-coloured ring between slices keeps adjacent segments
          // distinguishable without relying on the fills contrasting.
          borderColor: palette.surface,
          borderWidth: 2,
        }],
      },
      options: {
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { color: palette.text, boxWidth: 12, padding: 12 } },
        },
      },
    });
  },

  renderDispatchTrendChart(trend) {
    const canvas = document.getElementById('dashDispatchTrendChart');
    if (!canvas || typeof Chart === 'undefined') return;
    this._lastDispatchTrend = trend;
    this._watchThemeChanges();

    const rows = trend || [];
    const palette = this._chartPalette();
    const labels = rows.map(t => t.date.slice(5));
    const data = rows.map(t => t.qty);

    if (this.charts.trend) {
      const chart = this.charts.trend;
      chart.data.labels = labels;
      chart.data.datasets[0].data = data;
      chart.data.datasets[0].borderColor = palette.accent;
      chart.options.scales.x.ticks.color = palette.text;
      chart.options.scales.y.ticks.color = palette.text;
      chart.options.scales.x.grid.color = palette.grid;
      chart.options.scales.y.grid.color = palette.grid;
      chart.update();
      return;
    }

    this.charts.trend = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Qty Dispatched',
          data,
          borderColor: palette.accent,
          backgroundColor: 'rgba(99, 102, 241, 0.15)',
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          pointHitRadius: 12,
        }],
      },
      options: {
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: {
            // 30 date labels in ~600px overlap into an unreadable smear.
            // autoSkip with a cap thins them to roughly weekly.
            ticks: { color: palette.text, autoSkip: true, maxTicksLimit: 8, maxRotation: 0 },
            grid: { color: palette.grid, display: false },
          },
          y: {
            beginAtZero: true,
            ticks: { color: palette.text, precision: 0 },
            grid: { color: palette.grid },
          },
        },
      },
    });
  },
};
