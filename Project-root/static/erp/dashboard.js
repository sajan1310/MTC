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
    // Self-hosted, not cdn.jsdelivr.net: this app runs on factory LANs with
    // no reliable internet, where a CDN fetch simply fails and the dashboard
    // renders with no charts at all. No integrity argument -- SRI guards
    // against a third party serving something else, and there is no third
    // party any more. The file was verified byte-identical to the CDN copy
    // against this call site's own former sha384 hash when it was vendored.
    await loadScript('/static/erp/vendor/chart-4.4.0.umd.min.js');
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
  REDRAWN_REGIONS: '#dashboardStageChart, #dashboardPipeline, #dashboardUpcoming, ' +
    '#dashLowStockBody, #dashReadyToDispatchBody, #dashContractorPayablesBody, ' +
    '.dash-table-footer',

  // Identify the focused control well enough to find it again after the
  // rebuild. Its data-action names WHAT it is; one of the id attributes
  // names WHICH one. Together they survive a re-render, where a node
  // reference does not.
  _captureFocus() {
    const el = document.activeElement;
    if (!el || el === document.body || !el.closest) return null;
    const region = el.closest(this.REDRAWN_REGIONS);
    if (!region) return null;
    if (!el.dataset || !el.dataset.action) return null;
    // The region id disambiguates the two stage lists, whose rows carry the
    // same data-action and the same process id: without it, focus captured
    // on an Upcoming row would be restored onto the Pipeline row for the
    // same stage, silently scrolling the user somewhere they were not.
    return { action: el.dataset.action, key: this._focusKey(el), region: region.id || '' };
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
    const root = token.region
      ? document.getElementById(token.region)
      : document.getElementById('dashboardTab');
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
      this.renderStageChart(data.pipeline, data.upcoming);
      this.renderPipeline(data.pipeline);
      this.renderUpcoming(data.upcoming);
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

  // How long to keep polling before giving up on a run we started. A backup
  // is ~2 minutes of Google Sheets round trips; ten gives generous room for
  // a slow link and the API's own retry backoff without leaving the modal
  // spinning indefinitely if the worker running it was recycled mid-job.
  BACKUP_POLL_TIMEOUT_MS: 10 * 60 * 1000,
  BACKUP_POLL_INTERVAL_MS: 3000,

  // Poll getBackupStatus until OUR run reaches a terminal state, reporting
  // progress through `setProgress` as it goes.
  //
  // Every check is gated on run_id matching the run we started. Without
  // that, a status read arriving before the run's first record was written
  // would show the PREVIOUS run's terminal state -- so a backup that never
  // started would report yesterday's success and the operator would believe
  // they had a backup they do not have.
  //
  // Resolves with the run's result rather than throwing on a failed backup:
  // FAILED is an outcome the caller renders, with the server's explanation
  // of what went wrong. It throws only when the outcome cannot be learned.
  async _pollBackupUntilDone(runId, setProgress) {
    const deadline = Date.now() + this.BACKUP_POLL_TIMEOUT_MS;
    let watching = runId;

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, this.BACKUP_POLL_INTERVAL_MS));

      let d;
      try {
        const response = await Api.call('getBackupStatus');
        d = (response && response.data) ? response.data : null;
      } catch {
        // A single failed poll is not a failed backup -- the run lives in a
        // server-side thread and carries on regardless of whether this one
        // request made it. Keep polling until the deadline.
        continue;
      }
      if (!d) continue;

      if (watching && d.run_id !== watching) {
        // A different run holds the server's single backup slot: our thread
        // lost the race for the advisory lock, or the nightly job was already
        // going. Adopt it rather than waiting out the deadline for a run_id
        // that will never be published -- the user asked for a backup, one is
        // running, and its result is the honest answer to give them.
        if (d.run_state === 'RUNNING') {
          watching = d.run_id;
        } else {
          // Anything else with a foreign id is a PREVIOUS run's leftover
          // record. Ignoring it is the point of the id check: reporting it
          // would show an old success for a backup that never started.
          continue;
        }
      }

      if (d.run_state === 'RUNNING') {
        setProgress(d.run_percent || 20, d.run_phase_label || 'Backing up...');
        continue;
      }
      if (d.run_state === 'STALE') {
        throw new Error(d.run_phase_label || 'The backup stopped without reporting a result.');
      }
      if (['SUCCESS', 'PARTIAL', 'FAILED'].includes(d.run_state)) {
        setProgress(100, 'Done');
        return d;
      }
    }

    throw new Error(
      'The backup is taking longer than expected. It may still be running -- ' +
      'reopen this dialog in a few minutes to check before starting another.'
    );
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
    if (progressStep) progressStep.textContent = 'Starting backup...';
    // The subtext is set once and left alone: it says the one thing that is
    // true for the whole run and that the user needs in order not to give up
    // on it. The step line above carries the phase, from the server.
    if (progressSubtext) {
      progressSubtext.textContent =
        'This usually takes a couple of minutes. The backup continues on the ' +
        'server even if you close this dialog.';
    }
    if (percentText) percentText.textContent = '20%';
    if (triggerBtn) triggerBtn.disabled = true;

    bsModal.show();

    const setProgress = (percent, step, subtext) => {
      if (progressBar) progressBar.style.width = percent + '%';
      if (percentText) percentText.textContent = percent + '%';
      if (step && progressStep) progressStep.textContent = step;
      if (subtext && progressSubtext) progressSubtext.textContent = subtext;
    };

    try {
      // triggerBackup only STARTS the run -- a full backup is ~2 minutes of
      // Google Sheets round trips, far past both Api's 45s abort and
      // gunicorn's 120s worker timeout, so it cannot be awaited inline. The
      // server publishes progress to a record every worker shares; we poll
      // it. See backup_service.rpc_trigger_backup.
      const started = await Api.mutate('triggerBackup');
      const runId = (started && started.data) ? started.data.run_id : null;

      const data = await this._pollBackupUntilDone(runId, setProgress);
      const statusStr = data.status || 'FAILED';

      this._showBackupResultState(progressState, resultState, doneBtn, closeHeaderBtn);

      if (detailTime) detailTime.textContent = data.timestamp ? new Date(data.timestamp).toLocaleString() : new Date().toLocaleString();
      if (detailFile) detailFile.textContent = data.local_file ? data.local_file.split(/[\/\\]/).pop() : 'N/A';
      if (detailStatus) detailStatus.textContent = statusStr;

      if (statusStr === 'SUCCESS') {
        resultIcon.innerHTML = '<i class="bi bi-check-circle-fill text-success" style="font-size: 3rem;"></i>';
        resultTitle.textContent = 'Backup Completed Successfully!';
        resultTitle.className = 'fw-bold text-success mb-1';
        detailStatus.className = 'fw-bold text-success';
        resultMessage.textContent = data.message || 'Database snapshot created and synced to Google Sheets.';
        
        if (data.spreadsheet_url) {
          openSheetBtn.href = data.spreadsheet_url;
          openSheetBtn.style.display = 'inline-block';
        }
      } else if (statusStr === 'PARTIAL') {
        resultIcon.innerHTML = '<i class="bi bi-exclamation-triangle-fill text-warning" style="font-size: 3rem;"></i>';
        resultTitle.textContent = 'Local Snapshot Backup Created';
        resultTitle.className = 'fw-bold text-warning mb-1';
        detailStatus.className = 'fw-bold text-warning';
        resultMessage.textContent = data.message || 'Local database snapshot was saved. Google Sheets sync was skipped or requires credentials.';
      } else {
        resultIcon.innerHTML = '<i class="bi bi-x-circle-fill text-danger" style="font-size: 3rem;"></i>';
        resultTitle.textContent = 'Backup Failed';
        resultTitle.className = 'fw-bold text-danger mb-1';
        detailStatus.className = 'fw-bold text-danger';
        resultMessage.textContent = data.message || 'An unexpected error occurred while creating the backup.';
      }

      await this.loadBackupStatus();
    } catch (err) {
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

    Object.values(this.STAGE_LISTS).forEach(config => {
      const el = document.getElementById(config.containerId);
      if (el) el.innerHTML = `<div class="text-danger small">${config.error}</div>`;
    });
    const chartEl = document.getElementById('dashboardStageChart');
    if (chartEl) chartEl.innerHTML = '<div class="text-danger small">Failed to load stage load.</div>';

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

    // The tile is labelled "Production In Progress", so its VALUE is the
    // In Progress count -- it used to be Pending + In Progress, which read
    // as a direct contradiction of the WIP pipeline immediately below it
    // now that the pipeline draws only what is actually running. The
    // queued half is not lost, it moves into the note, where "queued" says
    // what it is. Status still keys off the oldest OPEN lot of either
    // kind: a pending lot three weeks old is the same problem as a running
    // one three weeks old, and burying it would be the point of the split
    // going wrong.
    const openLots = toNumber(k.pendingProductionCount);
    const running = toNumber(k.inProgressProductionCount);
    const queued = toNumber(k.queuedProductionCount);
    const oldestDays = k.oldestPendingProductionDays;
    const productionNote = [
      `${plural(running, 'lot')} running`,
      queued > 0 ? `${queued} queued` : null,
      oldestDays === null || oldestDays === undefined ? null : `oldest ${plural(oldestDays, 'day')}`,
    ].filter(Boolean).join(' &middot; ');
    this._setHero(
      'heroPendingProduction', 'kpiPendingProduction', 'kpiPendingProductionSub',
      running,
      openLots === 0 ? 'ok' : this._statusFor(oldestDays, this.THRESHOLDS.oldestProductionDays),
      openLots === 0 ? 'No lots open' : productionNote
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

  // The literal dashboard_service._stage_group_title falls back to when a
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

  // The two stage lists on this page. Same row component, same grid, same
  // sequence order -- so a stage sits in the same horizontal position in
  // both, and "running now" reads directly against "queued behind it".
  // Only the wording and the bar treatment differ, and both live here
  // rather than in two near-identical render functions.
  STAGE_LISTS: {
    pipeline: {
      containerId: 'dashboardPipeline',
      variant: 'wip',
      unitsLabel: 'units in progress',
      empty: 'Nothing is in progress right now.',
      error: 'Failed to load pipeline data.',
      // Not called a bottleneck: this is "where the most material is
      // sitting", which is a fact; whether that is a blockage is a
      // judgement the data here cannot make.
      peakLabel: 'most WIP',
      peakTitle: 'More units are sitting at this stage than at any other',
      ageTitle: days => `Oldest lot at this stage was logged ${days} day${days === 1 ? '' : 's'} ago`,
      ageSrText: days => `oldest lot ${days} day${days === 1 ? '' : 's'} old`,
    },
    upcoming: {
      containerId: 'dashboardUpcoming',
      variant: 'upcoming',
      unitsLabel: 'units queued',
      empty: 'No pending lots waiting to start.',
      error: 'Failed to load upcoming lots.',
      peakLabel: 'longest queue',
      peakTitle: 'More units are queued at this stage than at any other',
      ageTitle: days => `Oldest lot here has been waiting ${days} day${days === 1 ? '' : 's'}`,
      ageSrText: days => `waiting ${days} day${days === 1 ? '' : 's'}`,
    },
  },

  // Age of a stage's oldest lot, as a badge. Units alone say how much is
  // somewhere; age says whether it is moving -- a stage holding 400 units
  // logged this morning is busy, one holding 40 logged three weeks ago is
  // stuck, and the list could not tell those apart before. Reuses the
  // oldestProductionDays thresholds, so the badge turns amber and red at
  // the same ages the "Production" tile above it does. The visually-hidden
  // half is what makes "12d" mean something to a screen reader: the row is
  // a <button>, so its contents ARE its accessible name.
  _ageBadge(stage, config) {
    const days = stage.oldestDays;
    if (days === null || days === undefined || days === '') return '';
    const n = toNumber(days);
    const status = this._statusFor(n, this.THRESHOLDS.oldestProductionDays);
    return `<span class="dash-wip-age" data-status="${status}" title="${escapeHtml(config.ageTitle(n))}">` +
      `${n}d<span class="visually-hidden"> ${escapeHtml(config.ageSrText(n))}</span></span>`;
  },

  // Plot geometry. The gridline layer, the y-axis gutter and the columns all
  // have to agree on these, so they are one set of numbers rather than three.
  STAGE_PLOT_H: 150,
  STAGE_HEAD_H: 20,

  // Axis maximum, rounded UP to a 1 / 2 / 2.5 / 5 x 10^n step. Gridlines
  // landing on 500 and 1,000 read as a scale; gridlines landing on 437 and
  // 874 read as an accident.
  _niceMax(value) {
    if (!(value > 0)) return 0;
    const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
    const step = [1, 2, 2.5, 5, 10].find(x => value / magnitude <= x + 1e-9) || 10;
    return step * magnitude;
  },

  // Merge the two status payloads into one row per process, then group those
  // rows into bands by Process Type.
  //
  // Three levels, which is what makes this chart worth its space: the BAND is
  // the process type (six of them across 262 processes -- low enough
  // cardinality to label an axis), the COLUMN is the process, and the STACK
  // is the status. A process name cannot be labelled under a ~35px column,
  // but "Packing" over a band of them can, and that is the reading this adds
  // over anything the dashboard showed before: which part of the shop is
  // carrying the load, not just which single stage.
  _stageBands(pipeline, upcoming) {
    const byProcess = new Map();
    const merge = (stages, key) => (stages || []).forEach(stage => {
      const row = byProcess.get(stage.processId) || {
        processId: stage.processId,
        processName: stage.processName,
        processType: (stage.processType || '').trim(),
        sequence: toNumber(stage.sequence),
        wip: 0, queued: 0, lots: 0,
      };
      row.processType = row.processType || (stage.processType || '').trim();
      row[key] = toNumber(stage.totalQty);
      row.lots += toNumber(stage.totalLotCount);
      byProcess.set(stage.processId, row);
    });
    merge(pipeline, 'wip');
    merge(upcoming, 'queued');

    // A process whose type was never set still has to appear -- dropping it
    // would silently lose stock from the chart's totals.
    const UNTYPED = 'Other';
    const bands = new Map();
    Array.from(byProcess.values())
      .filter(r => r.wip + r.queued > 0)
      .sort((a, b) => a.sequence - b.sequence)
      .forEach(row => {
        const name = row.processType || UNTYPED;
        if (!bands.has(name)) bands.set(name, { name, columns: [], total: 0 });
        const band = bands.get(name);
        band.columns.push(row);
        band.total += row.wip + row.queued;
      });

    // Busiest band first: the question this chart answers is which part of
    // the shop is loaded, so the answer belongs where the eye starts.
    return Array.from(bands.values()).sort((a, b) => b.total - a.total);
  },

  renderStageChart(pipeline, upcoming) {
    const el = document.getElementById('dashboardStageChart');
    if (!el) return;

    const bands = this._stageBands(pipeline, upcoming);
    if (bands.length === 0) {
      el.innerHTML = '<div class="text-muted small">No open production lots at any stage.</div>';
      return;
    }

    const columnTotal = c => c.wip + c.queued;
    const axisMax = this._niceMax(Math.max(...bands.flatMap(b => b.columns.map(columnTotal))));
    if (!(axisMax > 0)) {
      el.innerHTML = '<div class="text-muted small">No open production lots at any stage.</div>';
      return;
    }

    const totals = bands.reduce((acc, b) => {
      b.columns.forEach(c => { acc.wip += c.wip; acc.queued += c.queued; });
      return acc;
    }, { wip: 0, queued: 0 });

    // A legend, always, for two series -- identity is never colour alone.
    const legend = `
      <div class="dash-band-legend">
        <span class="dash-band-legend-item">
          <span class="dash-band-swatch" data-series="wip" aria-hidden="true"></span>
          In Progress <strong>${formatQty(totals.wip)}</strong>
        </span>
        <span class="dash-band-legend-item">
          <span class="dash-band-swatch" data-series="queued" aria-hidden="true"></span>
          Pending <strong>${formatQty(totals.queued)}</strong>
        </span>
      </div>`;

    const ticks = [axisMax, axisMax / 2, 0];
    const yAxis = `
      <div class="dash-band-yaxis" aria-hidden="true">
        ${ticks.map((t, i) => `<span class="dash-band-tick" style="bottom:${100 - i * 50}%">${formatQty(t)}</span>`).join('')}
      </div>`;
    const gridlines = `
      <div class="dash-band-gridlines" aria-hidden="true">
        ${ticks.map((_t, i) => `<span class="dash-band-gridline" style="bottom:${100 - i * 50}%"></span>`).join('')}
      </div>`;

    // Bands are flex-sized by their column count, so every column across the
    // whole chart comes out the same width -- a 15-process band next to a
    // 2-process one must not make its columns five times thinner.
    const bandsHtml = bands.map(band => {
      const columns = band.columns.map(col => {
        const total = columnTotal(col);
        const segments = [
          { key: 'wip', qty: col.wip },
          { key: 'queued', qty: col.queued },
        ].filter(seg => seg.qty > 0).map(seg => {
          // Floor the height so a token 1-unit segment stays visible without
          // reading as a real quantity.
          const pct = Math.max((seg.qty / axisMax) * 100, 1.2);
          return `<span class="dash-band-seg" data-series="${seg.key}" style="height:${pct.toFixed(2)}%"></span>`;
        }).join('');

        const description =
          `${col.processName} (${band.name}): ${formatQty(col.wip)} in progress, ` +
          `${formatQty(col.queued)} pending, ${col.lots} lot${col.lots === 1 ? '' : 's'}`;

        return `
          <button type="button" class="dash-band-col" data-action="dash-pipeline-stage"
                  data-processid="${encodeURIComponent(col.processId)}"
                  title="${escapeHtml(description)}">
            <span class="dash-band-col-stack">${segments}</span>
            <span class="visually-hidden">${escapeHtml(description)}</span>
          </button>`;
      }).join('');

      return `
        <div class="dash-band" style="flex-grow:${band.columns.length}">
          <div class="dash-band-cols">${columns}</div>
          <div class="dash-band-label">
            <span class="dash-band-name">${escapeHtml(band.name)}</span>
            <span class="dash-band-total">${formatQty(band.total)}</span>
          </div>
        </div>`;
    }).join('');

    el.innerHTML = `
      <div class="dash-band-chart">
        ${legend}
        <div class="dash-band-plot">
          ${yAxis}
          <div class="dash-band-area">
            ${gridlines}
            <div class="dash-band-bands">${bandsHtml}</div>
          </div>
        </div>
      </div>`;
  },

  renderPipeline(pipeline) {
    this._renderStageList(pipeline, this.STAGE_LISTS.pipeline);
  },

  renderUpcoming(upcoming) {
    this._renderStageList(upcoming, this.STAGE_LISTS.upcoming);
  },

  _renderStageList(stages, config) {
    const el = document.getElementById(config.containerId);
    if (!el) return;
    if (!stages || stages.length === 0) {
      el.innerHTML = `<div class="text-muted small">${escapeHtml(config.empty)}</div>`;
      return;
    }

    // A card grid, not the full-width ranked list this replaced. That list
    // gave every stage a whole row of a ~860px section to carry a name and
    // three short numbers, so the name sat at the far left and its own
    // figures at the far right with a quarter-metre of empty rule between
    // them -- and a long process name still had to truncate, because the
    // name column had to leave room for the numbers beside it.
    //
    // A card gives each stage a column instead of a row: the numbers sit
    // directly under the name they belong to, the name gets two lines of
    // its own to wrap into rather than an ellipsis, and three to five
    // stages occupy one band of vertical space instead of five.
    const qtyOf = p => toNumber(p.totalQty);
    const totalQty = stages.reduce((sum, p) => sum + qtyOf(p), 0);
    const totalLots = stages.reduce((sum, p) => sum + toNumber(p.totalLotCount), 0);
    const peakQty = Math.max(...stages.map(qtyOf));

    const summary =
      `<div class="dash-wip-summary">
         <span><strong>${formatQty(totalQty)}</strong> ${escapeHtml(config.unitsLabel)}</span>
         <span><strong>${totalLots}</strong> lot${totalLots === 1 ? '' : 's'}</span>
         <span>across <strong>${stages.length}</strong> stage${stages.length === 1 ? '' : 's'}</span>
       </div>`;

    const cards = stages.map((p, i) => {
      const qty = qtyOf(p);
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

      const flags = `
        <span class="dash-wip-flags">
          ${isPeak && stages.length > 1
            ? `<span class="dash-wip-peak" title="${escapeHtml(config.peakTitle)}">${escapeHtml(config.peakLabel)}</span>`
            : ''}
          ${this._ageBadge(p, config)}
        </span>`;

      return `
        <button type="button" class="dash-wip-card" data-action="dash-pipeline-stage"
                data-processid="${encodeURIComponent(p.processId)}"
                title="View ${escapeHtml(p.processName)} in Production">
          <span class="dash-wip-card-head">
            <span class="dash-wip-seq">${i + 1}</span>
            <span class="dash-wip-name">${escapeHtml(p.processName)}</span>
          </span>
          <span class="dash-wip-card-figure">
            <span class="dash-wip-qty">${formatQty(qty)}<small> units</small></span>
            <span class="dash-wip-lots">${p.totalLotCount} lot${p.totalLotCount === 1 ? '' : 's'}</span>
          </span>
          ${flags}
          ${chips}
        </button>`;
    }).join('');

    el.innerHTML = summary + `<div class="dash-wip-grid" data-variant="${config.variant}">${cards}</div>`;
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
