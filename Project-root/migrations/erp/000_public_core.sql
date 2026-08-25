-- The public-schema core tables, brought into the tracked migration chain
-- (MIG-001).
--
-- Why this file exists
-- --------------------
-- Every migration from 003_masters.sql onward carries a foreign key to
-- public.users, but nothing in migrations/erp/ ever created it. That table
-- came from migrations/init_schema.sql, which the runner does not apply --
-- so the ERP chain had a hard dependency on a table outside its own control
-- and outside its own tracker. 025_users_deleted_at.sql and
-- 035_users_updated_at.sql both say so in their own comments ("there is no
-- other migration path for the public schema's pre-existing core tables"),
-- each patching one column of the drift that caused.
--
-- The deploy path papered over it by running `psql -f init_schema.sql`
-- before the runner (deploy/deploy.sh, docker-entrypoint.sh). That worked,
-- but it meant a second, untracked schema source executing on every deploy,
-- and init_schema.sql carries a great deal this application no longer uses:
-- 17 legacy tables (item_master, suppliers, purchase_orders, stock_entries,
-- ...) that no longer exist in production and that no code reads, plus two
-- seeded admin accounts. See migrations/legacy/README.md.
--
-- Numbered 000 so the runner (which applies sorted(*.sql) under an advisory
-- lock) creates these before 001. Idempotent, and a no-op against the
-- existing production database, where every object below already exists --
-- it simply records itself in erp.migrations_applied so that from here on
-- there is ONE migration path with ONE tracker.
--
-- The column types below are production's, verified against the live MTC
-- database rather than copied from init_schema.sql -- the two had drifted
-- (name 150 vs 255, password_hash 256 vs 255, mobile/company text vs
-- varchar, role default 'pending_approval' vs 'user'). A fresh database must
-- come up matching production, not matching a file production never
-- followed.

CREATE TABLE IF NOT EXISTS public.users (
    user_id         SERIAL PRIMARY KEY,
    name            VARCHAR(150) NOT NULL,
    email           VARCHAR(255) NOT NULL UNIQUE,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- 'pending_approval', not 'user': an INSERT that omits the role must not
    -- silently produce a privileged account (SEC-002; 036 applies the same
    -- default to an already-existing table).
    role            VARCHAR(50) DEFAULT 'pending_approval',
    profile_picture VARCHAR(255),
    password_hash   VARCHAR(256),
    company         TEXT,
    mobile          TEXT,
    deleted_at      TIMESTAMP WITH TIME ZONE,
    updated_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_email ON public.users (email);
CREATE INDEX IF NOT EXISTS idx_users_role ON public.users (role);

-- Password reset tokens (app/auth/routes.py). Previously created only by
-- migrations/legacy/migration_add_password_reset.py, i.e. by a script the
-- deploy path never ran -- so a virgin database got no such table and every
-- reset raised UndefinedProgram at the first query.
CREATE TABLE IF NOT EXISTS public.password_reset_tokens (
    token_id   SERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES public.users (user_id) ON DELETE CASCADE,
    token      TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    used       BOOLEAN NOT NULL DEFAULT FALSE,
    used_at    TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user
    ON public.password_reset_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires
    ON public.password_reset_tokens (expires_at);

-- Deliberately seeds NOTHING. init_schema.sql seeded admin@mtc.local and
-- demo@example.com as role 'admin' with a placeholder scrypt hash, and
-- because the deploy path re-ran that file on every deploy, deleting those
-- accounts did not keep them deleted. Both still exist in the production
-- database today. A schema migration must not mint privileged accounts; the
-- first real account is created by the operator (see
-- PRODUCTION_REMEDIATION_RUNBOOK.md).
