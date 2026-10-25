/**
 * The Dashboard's Audit report (dashboard.js, App.Dashboard *Audit*).
 *
 * The audit only reports; the user reviews and hands findings to Claude
 * Code. So what matters here is that the report shows what the server
 * ranked, in its order, that review decisions reach the server with the
 * numbers they were made on, and that the hand-off works on the LAN's plain
 * http address, where the Clipboard API is unavailable.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function loadDashboard() {
  global.App = { Utils: { showToast: jest.fn(), formatNameCase: s => s } };
  eval([
    fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8'),
    'global.escapeHtml = escapeHtml;',
    'global.toNumber = toNumber;',
    'global.formatCurrency = formatCurrency;',
    'global.formatQty = formatQty;',
  ].join('\n'));
  eval(fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8'));
}

function mountModal() {
  document.body.innerHTML = `
    <div id="auditRunMeta"></div><div id="auditSummary"></div>
    <button id="auditRunBtn"></button><div id="auditProgress"></div>
    <input type="checkbox" id="auditShowDismissed"><div id="auditBody"></div>`;
}

const finding = (over) => ({
  fingerprint: 'fp', valueSig: 'sig', check: 'negative_shortfall', kind: 'entry',
  area: 'pool', title: 'Title', detail: 'Detail', refs: [], priority: 'P2',
  review: 'open', ...over,
});

const report = (findings, summary = {}) => ({
  runId: 7, trigger: 'button', finishedAt: '2026-10-15T15:10:00+05:30',
  summary: { integrityOk: true, byBand: {}, byKind: {}, ...summary },
  findings,
});

describe('App.Dashboard audit report', () => {
  beforeEach(() => {
    jest.resetModules();
    loadDashboard();
    mountModal();
    global.Api = { call: jest.fn(), callFresh: jest.fn(), mutate: jest.fn(async () => ({ success: true })) };
  });

  test('shows the bands in priority order, escaped, and hides dismissed findings', () => {
    App.Dashboard._audit = report([
      finding({ fingerprint: 'a', priority: 'P3', title: 'Third' }),
      finding({ fingerprint: 'b', priority: 'P1', kind: 'integrity', title: '<b>First</b>' }),
      finding({ fingerprint: 'c', priority: 'P2', title: 'Gone', review: 'dismissed' }),
    ], { integrityOk: false, byKind: { integrity: 1 } });
    App.Dashboard.renderAuditReport();

    const body = document.getElementById('auditBody');
    const titles = [...body.querySelectorAll('.fw-semibold')].map(el => el.textContent);
    expect(titles[0]).toContain('<b>First</b>'); // shown as text, not markup
    expect(titles[1]).toContain('Third');
    expect(body.textContent).not.toContain('Gone');
    expect(document.getElementById('auditSummary').textContent).toContain('1 calculation problem');

    document.getElementById('auditShowDismissed').checked = true;
    App.Dashboard.renderAuditReport();
    expect(body.textContent).toContain('Gone');
  });

  test('a review decision is sent with the numbers it was made on', async () => {
    App.Dashboard._audit = report([finding({ fingerprint: 'x', valueSig: 's1' })]);
    App.Dashboard.renderAuditReport();
    document.querySelector('.audit-tick').checked = true;

    await App.Dashboard.markAuditFindings('dismissed');

    expect(Api.mutate).toHaveBeenCalledWith(
      'setAuditFindingStatus', [{ fingerprint: 'x', valueSig: 's1' }], 'dismissed');
    expect(document.getElementById('auditBody').textContent).not.toContain('Title');
  });

  test('runAudit polls the live status, then shows that run', async () => {
    App.Dashboard.AUDIT_POLL_INTERVAL_MS = 1;
    Api.mutate.mockResolvedValueOnce({ success: true, data: { runId: 9 } });
    Api.callFresh
      .mockResolvedValueOnce({ success: true, data: { status: 'RUNNING' } })
      .mockResolvedValueOnce({ success: true, data: { status: 'DONE' } })
      .mockResolvedValueOnce({ success: true, data: report([finding({ title: 'Fresh' })]) });

    await App.Dashboard.runAudit();

    expect(Api.callFresh).toHaveBeenCalledWith('getAuditStatus', 9);
    expect(Api.callFresh).toHaveBeenLastCalledWith('getAuditReport', 9);
    expect(document.getElementById('auditBody').textContent).toContain('Fresh');
  });

  test('Copy for Claude Code works on plain http and marks the findings sent', async () => {
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    document.execCommand = jest.fn(() => true);
    App.Dashboard._audit = report([finding({ fingerprint: 'y', valueSig: 's2' })]);
    App.Dashboard.renderAuditReport();
    document.querySelector('.audit-tick').checked = true;
    Api.call.mockResolvedValueOnce({ success: true, data: { markdown: '# brief' } });

    await App.Dashboard.copyAuditBrief();

    expect(Api.call).toHaveBeenCalledWith('getAuditBrief', 7, ['y']);
    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(Api.mutate).toHaveBeenCalledWith(
      'setAuditFindingStatus', [{ fingerprint: 'y', valueSig: 's2' }], 'sent_to_claude');
    expect(document.getElementById('auditBody').textContent).toContain('sent to Claude');
  });
});
