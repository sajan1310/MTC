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
    <div id="auditCoverage"></div><div id="auditLedgers"></div><div id="auditMissing"></div>
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

  test('says what it checked, module by module, and a chip filters the list', () => {
    App.Dashboard._audit = report([
      finding({ fingerprint: 'a', area: 'bills', title: 'Bill one' }),
      finding({ fingerprint: 'b', area: 'pool', title: 'Pool one' }),
    ], {
      coverage: [
        { area: 'bills', label: 'Received bills', findings: 1, integrity: 0, failed: 0 },
        { area: 'pool', label: 'Warehouse Pool', findings: 1, integrity: 0, failed: 0 },
        { area: 'wastage', label: 'Wastage', findings: 0, integrity: 0, failed: 0 },
        { area: 'units', label: 'Units', findings: 0, integrity: 0, failed: 2 },
      ],
    });
    App.Dashboard.renderAuditReport();

    const chips = document.getElementById('auditCoverage');
    const body = document.getElementById('auditBody');
    expect(chips.textContent).toContain('Received bills · 1');
    // Nothing to report reads as checked, and a check that failed says so.
    expect(chips.textContent).toContain('Wastage');
    expect(chips.textContent).toContain('2 could not run');
    expect(body.textContent).toContain('Received bills'); // on the finding too

    App.Dashboard.filterAuditArea('bills');
    expect(body.textContent).toContain('Bill one');
    expect(body.textContent).not.toContain('Pool one');
    expect(chips.querySelector('[aria-pressed="true"]').textContent).toContain('Received bills');

    App.Dashboard.filterAuditArea('wastage');
    expect(body.textContent).toContain('Nothing to review in Wastage');

    App.Dashboard.filterAuditArea('wastage'); // the same chip again clears it
    expect(body.textContent).toContain('Pool one');
  });

  test('traces each ledger and lists what is missing, and filtering leaves the panels alone', () => {
    App.Dashboard._audit = report([
      finding({
        title: 'Bill one',
        area: 'bills',
        missing: { type: 'logic', text: 'Saving a bill does not compare its price.' },
      }),
    ], {
      coverage: [{ area: 'bills', label: 'Received bills', findings: 1, integrity: 0, failed: 0 }],
      stockStatement: { items: 1630, disagree: 0 },
      recipeCheck: { judged: 647, byNeighbours: 267, notJudged: 434 },
      ledgers: [
        { area: 'bills', label: 'Bill Ledger', lands: 'its item', checked: '1,598 lines on 624 bills', misplaced: 3, wrongFigures: 0 },
        { area: 'stock', label: 'Item Ledger', lands: 'its size', checked: '1,630 items', misplaced: 0, wrongFigures: 1 },
      ],
      missing: [
        { type: 'calculation', text: 'No payable is worked out.', findings: 6, checks: ['lot_without_rate'] },
        { type: 'logic', text: 'Saving a bill does not compare its price.', findings: 45, checks: ['bill_rate_above_po'] },
      ],
    });
    App.Dashboard.renderAuditReport();

    const ledgers = document.getElementById('auditLedgers');
    expect(ledgers.textContent).toContain('Ledgers traced: 2 · 3 landing finding(s) · 1 wrong figure(s)');
    expect(ledgers.textContent).toContain('1,598 lines on 624 bills');
    expect(ledgers.textContent).toContain('all agree with the Stock page');
    expect(ledgers.textContent).toContain('267 older ones against the lots around them; 434 had too little');

    const missing = document.getElementById('auditMissing');
    expect(missing.textContent).toContain('Missing: 1 calculation(s), 1 piece(s) of logic');
    expect(missing.textContent).toContain('No payable is worked out.');

    expect(document.getElementById('auditBody').textContent)
      .toContain('Missing logic: Saving a bill does not compare its price.');

    missing.querySelector('details').open = true;
    App.Dashboard.filterAuditArea('bills');
    expect(document.getElementById('auditMissing').querySelector('details').open).toBe(true);
  });

  test('a run from before these panels shows none', () => {
    App.Dashboard._audit = report([finding({})]);
    App.Dashboard.renderAuditReport();
    expect(document.getElementById('auditLedgers').textContent).toBe('');
    expect(document.getElementById('auditMissing').textContent).toBe('');
    expect(document.getElementById('auditBody').textContent).toContain('Title');
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
