/**
 * Regression tests for the manual backup trigger's poll loop.
 *
 * The bug these exist to prevent coming back: triggerBackup used to run the
 * whole backup inside the RPC and await it. A full run is ~2 minutes of
 * Google Sheets round trips (four API calls per table across 46 tables, plus
 * 28 mirrored sheets), while api.js aborts any RPC after 45s and gunicorn
 * kills the worker at 120s. So the dashboard showed "Backup Error -- the
 * server did not respond within 45s" on every single click, on runs that
 * were in fact still working and, for the local snapshot, had already
 * succeeded. The request now only STARTS the run; this loop is what turns
 * the server's shared progress record back into an outcome for the user.
 *
 * Three properties matter, and all three are ways the loop could silently
 * report the wrong thing rather than merely fail:
 *
 *   1. A terminal record belonging to a DIFFERENT run is never reported as
 *      this run's result. Otherwise a backup that failed to start at all
 *      shows the previous run's SUCCESS, and the operator believes they
 *      have a backup they do not have. That is the same class of defect as
 *      DATA-001 (a green dashboard over a backup that captured three of
 *      fifty tables) and is worth more than the convenience it costs.
 *
 *   2. A FAILED run resolves rather than throwing, so the modal renders the
 *      server's explanation instead of a generic "Failed to communicate".
 *
 *   3. A poll that itself fails does not end the watch -- the run is in a
 *      server-side thread and does not care whether one poll got through.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function loadDashboardAsGlobal() {
  global.App = { Utils: { showToast: jest.fn(), formatNameCase: s => s } };
  const api = [
    fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8'),
    'global.toNumber = toNumber;',
    'global.escapeHtml = escapeHtml;',
    'global.formatCurrency = formatCurrency;',
    'global.formatQty = formatQty;',
  ].join('\n');
  eval(api);
  const code = fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8');
  eval(code);
}

// Feeds getBackupStatus one queued reply per poll. A queued Error is thrown
// rather than returned, standing in for a poll that never reached the server.
function stubStatusSequence(replies) {
  const queue = replies.slice();
  global.Api = {
    call: jest.fn(async () => {
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) throw next;
      return { success: true, data: next };
    }),
    mutate: jest.fn(),
  };
  return global.Api;
}

describe('App.Dashboard._pollBackupUntilDone', () => {
  beforeEach(() => {
    jest.resetModules();
    loadDashboardAsGlobal();
    // The real loop waits 3s between polls and gives up after 10 minutes.
    // Shortened rather than faked with timers: the loop interleaves awaited
    // fetches with awaited sleeps, which jest.useFakeTimers cannot advance
    // through without a tick-pumping helper per iteration.
    App.Dashboard.BACKUP_POLL_INTERVAL_MS = 1;
    App.Dashboard.BACKUP_POLL_TIMEOUT_MS = 500;
  });

  test('reports the result of the run it started', async () => {
    stubStatusSequence([
      { run_id: 'mine', run_state: 'RUNNING', run_percent: 20, run_phase_label: 'Snapshotting...' },
      { run_id: 'mine', run_state: 'SUCCESS', status: 'SUCCESS', message: 'Done', local_file: '/b/mtc.dump' },
    ]);
    const progress = jest.fn();

    const data = await App.Dashboard._pollBackupUntilDone('mine', progress);

    expect(data.status).toBe('SUCCESS');
    expect(data.local_file).toBe('/b/mtc.dump');
    // Progress comes from the server's real phase, not a local timer.
    expect(progress).toHaveBeenCalledWith(20, 'Snapshotting...');
    expect(progress).toHaveBeenLastCalledWith(100, 'Done');
  });

  test('a FAILED run resolves with the failure, it does not throw', async () => {
    stubStatusSequence([
      { run_id: 'mine', run_state: 'RUNNING', run_percent: 5, run_phase_label: 'Snapshotting...' },
      { run_id: 'mine', run_state: 'FAILED', status: 'FAILED', message: 'pg_dump is not on PATH' },
    ]);

    const data = await App.Dashboard._pollBackupUntilDone('mine', jest.fn());

    expect(data.status).toBe('FAILED');
    expect(data.message).toBe('pg_dump is not on PATH');
  });

  test('never reports a previous run\'s success as this run\'s result', async () => {
    // Our run never publishes anything -- the thread died, or never started.
    // The only record present is the last run's, which succeeded.
    stubStatusSequence([
      { run_id: 'yesterday', run_state: 'SUCCESS', status: 'SUCCESS', message: 'Old run' },
    ]);

    await expect(
      App.Dashboard._pollBackupUntilDone('mine', jest.fn())
    ).rejects.toThrow(/taking longer than expected/);
  });

  test('adopts a run already in flight when ours lost the race for the lock', async () => {
    // The server allows one backup at a time. If the nightly job or another
    // admin holds the advisory lock, our thread exits without publishing --
    // so waiting for our own id would time out while a real backup runs.
    stubStatusSequence([
      { run_id: 'theirs', run_state: 'RUNNING', run_percent: 75, run_phase_label: 'Mirroring...' },
      { run_id: 'theirs', run_state: 'PARTIAL', status: 'PARTIAL', message: 'Snapshot ok, Sheets skipped' },
    ]);

    const data = await App.Dashboard._pollBackupUntilDone('mine', jest.fn());

    expect(data.status).toBe('PARTIAL');
  });

  test('a failed poll does not abandon the run', async () => {
    stubStatusSequence([
      new Error('network down'),
      { run_id: 'mine', run_state: 'RUNNING', run_percent: 20, run_phase_label: 'Working...' },
      { run_id: 'mine', run_state: 'SUCCESS', status: 'SUCCESS', message: 'Done' },
    ]);

    const data = await App.Dashboard._pollBackupUntilDone('mine', jest.fn());

    expect(data.status).toBe('SUCCESS');
  });

  test('a run abandoned mid-flight is reported, not waited out', async () => {
    // The server marks a RUNNING record STALE once it stops being updated,
    // which is what a worker recycled mid-backup leaves behind.
    stubStatusSequence([
      { run_id: 'mine', run_state: 'STALE', run_phase_label: 'The backup process stopped without reporting a result.' },
    ]);

    await expect(
      App.Dashboard._pollBackupUntilDone('mine', jest.fn())
    ).rejects.toThrow(/stopped without reporting a result/);
  });
});
