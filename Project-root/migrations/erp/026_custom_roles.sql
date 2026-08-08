-- Admin/super_admin-defined roles beyond the four built-in ones (user,
-- admin, super_admin, pending_approval -- see app/models/user.py). Each
-- custom role's `permissions` is a JSON OBJECT mapping a sidebar tab id to
-- an access level ("viewer"/"commenter"/"editor" -- see
-- app/erp/services/roles_service.py), not just a flat list of tabs, so a
-- role can grant read-only access to one tab and full access to another.
-- Assigned to a user through the existing users.role column -- still a
-- plain VARCHAR with no FK here, matching how the four built-in role
-- strings already work there.
--
-- Lives unqualified (public schema, no `erp.` prefix) since it's a direct
-- extension of `users`, which itself lives in public -- not ERP business-
-- domain data like the rest of this migrations/erp/ directory.
CREATE TABLE IF NOT EXISTS custom_roles (
    role_key VARCHAR(50) PRIMARY KEY,
    role_name VARCHAR(100) NOT NULL,
    permissions JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
