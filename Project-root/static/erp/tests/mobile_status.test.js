/**
 * MApp.Status -- backup health, recent notifications, activity log
 * (Phase 5).
 *
 * All three RPCs existed and none was reachable from a phone, so "is the
 * backup healthy?" could only be answered at a desk.
 *
 * The backup section follows the server's own rule about its defaults:
 * snapshot_verified starts False on purpose, because before any run has
 * happened "is there a verified backup?" must answer NO rather than
 * render blank and look fine. Most of what follows checks that an unknown
 * or failed state is never painted as reassuring.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function loadAsGlobal(relPath, exportName) {
  const code = fs
    .readFileSync(path.join(__dirname, '..', relPath), 'utf8')
    .replace(new RegExp(`^const ${exportName} = `, 'm'), `global.${exportName} = `);
  // eslint-disable-next-line no-eval
  eval(code);
}

const HEALTHY = {
  status: 'SUCCESS', message: 'Backup completed.', snapshot_verified: true,
  consecutive_failures: 0, last_verified_at: '2026-09-05 02:00',
  mirror_status: 'OK', mirror_message: 'Mirrored to F:',
};
const NOTIFICATIONS = [
  { key: 'k1', timestamp: '2026-09-05T09:00:00', action: 'Ledger recalculated', details: 'stock rebuilt' },
];
const ACTIVITY = {
  entries: [
    { id: 1, timestamp: '2026-09-05T09:10:00', userEmail: 'a@b.com', action: 'saveProduction', entityType: 'production', status: 'success', detail: 'LOT-1042' },
  ],
  total: 1, page: 1,
};

function mount(role) {
  jest.resetModules();
  global.fetch = jest.fn();
  document.body.innerHTML = `
    <div id="mapp-sheet-backdrop"></div>
    <div class="mb-sheet" id="sheet-status"><div id="status-body"></div></div>`;
  window.MOBILE_CURRENT_USER = { email: 'a@b.com', role };
  loadAsGlobal('api.js', 'Api');
  loadAsGlobal('mobile.js', 'MApp');
  MApp.Sheet._stack = [];
}

const body = () => document.getElementById('status-body').textContent;

describe('MApp.Status backup health', () => {
  beforeEach(() => mount('manager'));

  const withBackup = backup => {
    MApp.Api.call = jest.fn(async method => ({
      success: true,
      data: { getBackupStatus: backup, getRecentNotificationLogs: NOTIFICATIONS }[method],
    }));
  };

  test('a verified backup reads as verified', async () => {
    withBackup(HEALTHY);
    await MApp.Status.open();

    expect(body()).toContain('Verified');
    expect(body()).toContain('Last verified 2026-09-05 02:00');
    expect(body()).toContain('Mirrored to F:');
  });

  test('a never-run backup reads as NOT verified, not as blank', async () => {
    // The server defaults snapshot_verified to False for exactly this
    // reason. A blank or absent state must not look fine.
    withBackup({ status: 'NEVER', message: 'No backup has been executed yet.', snapshot_verified: false, consecutive_failures: 0, last_verified_at: null });
    await MApp.Status.open();

    expect(body()).toContain('Not verified');
    expect(body()).toContain('No backup has been verified yet.');
  });

  test('an empty status object still reads as not verified', async () => {
    withBackup({});
    await MApp.Status.open();

    expect(body()).toContain('Not verified');
  });

  test('consecutive failures are called out', async () => {
    withBackup({ ...HEALTHY, snapshot_verified: false, consecutive_failures: 3 });
    await MApp.Status.open();

    expect(body()).toContain('Not verified');
    expect(body()).toContain('3 consecutive failures');
  });

  test('an unreachable backup service says so rather than showing nothing', async () => {
    MApp.Api.call = jest.fn(async method => {
      if (method === 'getBackupStatus') throw new Error('offline');
      return { success: true, data: NOTIFICATIONS };
    });
    await MApp.Status.open();

    expect(body()).toContain("Couldn't reach the backup service");
    // …and does not imply health by omission.
    expect(body()).not.toContain('Verified');
  });

  test('a run in progress is reported', async () => {
    withBackup({ ...HEALTHY, run_state: 'running', run_phase_label: 'Dumping tables', run_percent: 40 });
    await MApp.Status.open();

    expect(body()).toContain('Running');
    expect(body()).toContain('Dumping tables');
    expect(body()).toContain('40%');
  });
});

describe('MApp.Status permissions', () => {
  test('a non-admin sees no activity log and no backup trigger', async () => {
    // Both RPCs are roles={"admin"} server-side; asking as a non-admin
    // would only be a denied call, so it is not made.
    mount('manager');
    MApp.Api.call = jest.fn(async method => ({
      success: true,
      data: { getBackupStatus: HEALTHY, getRecentNotificationLogs: NOTIFICATIONS }[method],
    }));

    await MApp.Status.open();

    expect(MApp.Api.call).not.toHaveBeenCalledWith('getActivityLog', expect.anything(), expect.anything(), expect.anything());
    expect(body()).not.toContain('Activity log');
    expect(document.getElementById('status-backup-btn')).toBeNull();
  });

  test('an admin sees both', async () => {
    mount('admin');
    MApp.Api.call = jest.fn(async method => ({
      success: true,
      data: { getBackupStatus: HEALTHY, getRecentNotificationLogs: NOTIFICATIONS, getActivityLog: ACTIVITY }[method],
    }));

    await MApp.Status.open();

    expect(MApp.Api.call).toHaveBeenCalledWith('getActivityLog', {}, 1, 20);
    expect(body()).toContain('Activity log');
    expect(body()).toContain('saveProduction');
    expect(document.getElementById('status-backup-btn')).not.toBeNull();
  });

  test('super_admin counts as admin', async () => {
    mount('super_admin');
    MApp.Api.call = jest.fn(async () => ({ success: true, data: {} }));

    expect(MApp.Status.isAdmin()).toBe(true);
  });
});

describe('MApp.Status sections', () => {
  beforeEach(() => mount('admin'));

  test('a failing section says so without hiding the others', async () => {
    MApp.Api.call = jest.fn(async method => {
      if (method === 'getRecentNotificationLogs') throw new Error('offline');
      return { success: true, data: method === 'getBackupStatus' ? HEALTHY : ACTIVITY };
    });

    await MApp.Status.open();

    expect(body()).toContain("Couldn't load recent notifications");
    expect(body()).toContain('Verified');       // backup still rendered
    expect(body()).toContain('saveProduction'); // activity still rendered
  });

  test('empty sections read as empty, not as broken', async () => {
    MApp.Api.call = jest.fn(async method => ({
      success: true,
      data: { getBackupStatus: HEALTHY, getRecentNotificationLogs: [], getActivityLog: { entries: [] } }[method],
    }));

    await MApp.Status.open();

    expect(body()).toContain('Nothing recent.');
    expect(body()).toContain('No activity recorded.');
  });

  test('a log detail containing markup cannot break the sheet', async () => {
    MApp.Api.call = jest.fn(async method => ({
      success: true,
      data: {
        getBackupStatus: HEALTHY,
        getRecentNotificationLogs: [{ key: 'k', timestamp: '2026-09-05T09:00:00', action: '<script>x</script>', details: '"quoted"' }],
        getActivityLog: { entries: [] },
      }[method],
    }));

    await MApp.Status.open();

    expect(document.querySelector('#status-body script')).toBeNull();
  });
});

describe('MApp.Status backup trigger', () => {
  beforeEach(() => {
    mount('admin');
    jest.useFakeTimers();
    MApp.Api.call = jest.fn(async method => ({
      success: true,
      data: { getBackupStatus: HEALTHY, getRecentNotificationLogs: [], getActivityLog: { entries: [] } }[method],
    }));
  });

  afterEach(() => jest.useRealTimers());

  test('starting a backup calls the mutation', async () => {
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: true }));
    await MApp.Status.open();

    await MApp.Status.runBackup();

    expect(MApp.Util.mutateSimple).toHaveBeenCalledWith('triggerBackup', [], 'Backup started.');
  });

  test('a refused start re-enables the button rather than stranding it', async () => {
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: false }));
    await MApp.Status.open();

    await MApp.Status.runBackup();

    const btn = document.getElementById('status-backup-btn');
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('Run a backup now');
  });

  test('polling stops once the sheet is closed', async () => {
    // triggerBackup returns before the work is done, so the outcome is
    // polled -- but a closed sheet must not keep a factory LAN busy.
    MApp.Util.mutateSimple = jest.fn(async () => ({ success: true }));
    await MApp.Status.open();
    await MApp.Status.runBackup();

    MApp.Status.close();
    MApp.Api.call.mockClear();
    jest.advanceTimersByTime(20000);

    expect(MApp.Api.call).not.toHaveBeenCalled();
  });
});
