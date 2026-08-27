-- User activity log (AUDIT-001).
--
-- History: this application used to have one. `app/services/audit_service.py`
-- wrote CREATE/UPDATE/DELETE/EXECUTE rows to a `public.audit_log` table
-- created by `migrations/legacy/migration_add_audit_log.py`. Both were
-- dropped in cbd1c80 ("make ERP the only registered UI") along with the rest
-- of the pre-port surface, and the ERP port never carried the concept over --
-- 019_ledger_audit.sql says so explicitly ("a general-purpose audit trail
-- this port never carried over anywhere else"). Since then the only record of
-- who did what has been each table's own `updated_by`/`updated_at` columns,
-- which hold the LAST writer only: no history, nothing for deletes, and
-- nothing at all for reads, sign-ins or refused actions.
--
-- This table restores that capability in the port's own architecture. It is
-- written from the one place every user action already passes through --
-- app/erp/rpc.py's dispatcher -- plus the auth routes, rather than from ~104
-- individual call sites the way the old AuditService was.
--
-- Deliberately NOT a foreign key to public.users(user_id)
-- ------------------------------------------------------
-- Two reasons. An audit row must outlive the account it describes, so a
-- purged user cannot erase their own trail; and the dev/test demo account
-- (app/auth/routes.py's DEMO_USER_ID = -1) has no users row at all, so an FK
-- would make every demo sign-in fail its own logging. `user_email` and
-- `user_role` are denormalised snapshots taken at the time of the action --
-- what the account was then, not what it is now.

CREATE TABLE IF NOT EXISTS erp.activity_log (
    id           BIGSERIAL PRIMARY KEY,
    logged_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    -- Who. NULL only for an action taken with no session at all (a failed
    -- sign-in against an address that does not exist).
    user_id      INTEGER,
    user_email   VARCHAR(255),
    user_role    VARCHAR(50),
    -- What. 'rpc' for a business mutation (action = the RPC method name,
    -- e.g. 'saveBill'), 'auth' for sign-in/sign-out/password events.
    category     VARCHAR(20)  NOT NULL,
    action       VARCHAR(100) NOT NULL,
    -- The service module the method lives in ('bill_service'), which is also
    -- what roles_service.TAB_BY_SERVICE_MODULE maps to a sidebar tab.
    entity_type  VARCHAR(100),
    -- 'success' | 'failure' (the user was told no: validation, a business
    -- rule, bad credentials) | 'denied' (authorization refused) | 'error'
    -- (an unhandled exception -- a bug).
    status       VARCHAR(20)  NOT NULL,
    -- The message shown to the user, so a failure row says why.
    detail       TEXT,
    -- The call's arguments, redacted and size-capped by activity_service.
    args         JSONB,
    ip_address   VARCHAR(45),
    user_agent   VARCHAR(255),
    -- Ties a row to the request-id middleware's id, and so to the
    -- application log lines and the reference id rpc.py quotes to the user.
    request_id   VARCHAR(64),
    duration_ms  NUMERIC(12, 2)
);

-- "What happened recently", the default view.
CREATE INDEX IF NOT EXISTS ix_erp_activity_log_logged_at
    ON erp.activity_log (logged_at DESC);

-- "What has this user been doing" -- the old AuditService.get_user_activity().
CREATE INDEX IF NOT EXISTS ix_erp_activity_log_user
    ON erp.activity_log (user_id, logged_at DESC);

-- "Every save of a bill", and the module filter behind it.
CREATE INDEX IF NOT EXISTS ix_erp_activity_log_action
    ON erp.activity_log (action, logged_at DESC);

-- Partial, because these are the rows anyone investigating an incident wants
-- and they are a small fraction of the table.
CREATE INDEX IF NOT EXISTS ix_erp_activity_log_problems
    ON erp.activity_log (logged_at DESC)
    WHERE status IN ('denied', 'error');
