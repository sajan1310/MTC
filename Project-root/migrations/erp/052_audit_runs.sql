-- The Audit report (audit_service): what each run found, and what the user
-- decided about each finding.
--
-- The audit only reads business data. These two tables are the only things
-- it writes, so a run can never change a stock figure, a lot or a count.
--
-- erp.audit_runs keeps every run whole -- findings, priority, summary -- so
-- a run is inside every backup and can be re-read exactly when its findings
-- are handed to Claude Code to investigate.
CREATE TABLE IF NOT EXISTS erp.audit_runs (
    id          BIGSERIAL PRIMARY KEY,
    started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    trigger     VARCHAR(20) NOT NULL DEFAULT 'button',
    status      VARCHAR(20) NOT NULL DEFAULT 'RUNNING',
    findings    JSONB NOT NULL DEFAULT '[]'::jsonb,
    summary     JSONB NOT NULL DEFAULT '{}'::jsonb,
    ai          JSONB,
    usage       JSONB,
    error       TEXT,
    created_by  INTEGER,
    CONSTRAINT audit_runs_trigger_check CHECK (trigger IN ('button', 'nightly')),
    CONSTRAINT audit_runs_status_check CHECK (status IN ('RUNNING', 'DONE', 'FAILED'))
);

CREATE INDEX IF NOT EXISTS ix_erp_audit_runs_started_at
    ON erp.audit_runs (started_at DESC);

-- One row per finding the user has looked at, keyed by the finding's
-- fingerprint (check + item + size + colour + primary reference), which is
-- the same in every run that finds the same thing. value_sig records the
-- numbers the decision was made on: a dismissed finding stays hidden only
-- while they are unchanged, and comes back the moment they move.
CREATE TABLE IF NOT EXISTS erp.audit_finding_reviews (
    fingerprint VARCHAR(40) PRIMARY KEY,
    status      VARCHAR(20) NOT NULL,
    value_sig   VARCHAR(64) NOT NULL DEFAULT '',
    note        TEXT NOT NULL DEFAULT '',
    updated_by  INTEGER,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT audit_finding_reviews_status_check
        CHECK (status IN ('open', 'reviewed', 'dismissed', 'sent_to_claude'))
);
