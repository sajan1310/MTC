-- Findings log for the internal ledger-reconciliation audit, ported from
-- Apps_Script/module_audit.js's runInternalLedgerAudit(). Source wrote one
-- row per finding (plus one summary row every run) to a spreadsheet "Logs"
-- sheet via logAction() -- a general-purpose audit trail this port never
-- carried over anywhere else (every other mutation instead relies on its
-- own table's updated_at/updated_by columns). This table exists only for
-- this one job, not as a reintroduction of that whole concept: the audit
-- itself is "deliberately NOT wired into the web app UI" (source's own
-- words) -- an unattended backend safety net, not a user-facing feature.

CREATE TABLE IF NOT EXISTS erp.ledger_audit_log (
    id SERIAL PRIMARY KEY,
    logged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    action VARCHAR(50) NOT NULL,
    record_id VARCHAR(255) NOT NULL,
    details TEXT NOT NULL,
    status VARCHAR(20) NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_erp_ledger_audit_log_logged_at ON erp.ledger_audit_log (logged_at DESC);
