-- Adds users.deleted_at, used by users_service.py's deactivateUser/
-- reactivateUser and enforced on every login path (app/__init__.py's
-- load_user() Flask-Login user_loader, and app/auth/routes.py's
-- api_login()) so a deactivated user's session dies immediately and they
-- can't sign back in with a password.
--
-- init_schema.sql already defines this column for a brand-new database,
-- but an existing, already-provisioned `users` table (created before that
-- column was added there) never picked it up -- there is no other
-- migration path for the public schema's pre-existing core tables. Without
-- it, both queries above raise UndefinedColumn on every single request,
-- which load_user() catches and turns into "no user" -- silently logging
-- every real (non-demo) user out on the very next page load after any
-- successful login, Google OAuth included. ADD COLUMN IF NOT EXISTS is
-- additive and non-destructive, safe to run against a table that may or
-- may not already have it.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;
