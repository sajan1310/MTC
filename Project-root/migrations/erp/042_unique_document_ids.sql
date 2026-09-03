-- Unique identifiers for issues and wastages.
--
-- 011_wastage_and_issue.sql recorded the omission as deliberate: "No unique
-- index on wastage_id/issue_id -- the source itself never checks". Faithful
-- to the Apps Script original, but it makes a real collision silent.
--
-- Both ids are generated as PFX-YYYYMMDD-HHMMSS (issue_service.py,
-- wastage_service.py). That is second-resolution, so two saves inside the
-- same second produce the same string -- and with no constraint and no
-- application check, the second one is simply written. The result is two
-- different documents sharing one identifier, with nothing raised at the
-- time and no way to tell them apart afterwards.
--
-- The equivalent case for returns is NOT silent, because
-- 009_return_ledger.sql already added ux_erp_return_headers_number_ci and
-- save_return checks it. These two indexes bring issue and wastage up to
-- that same standard; app/erp/services/document_numbers.py is the matching
-- generator, shared by all three.
--
-- Shape copied exactly from the return index:
--   * lower(...) so ids differing only in case still collide
--   * WHERE deleted_at IS NULL so a soft delete frees the number again,
--     which is what the application's own uniqueness checks already assume
--
-- Safe to apply as-is: at the time of writing production held 28 issues and
-- 0 wastages with zero duplicates, so the index builds without a backfill.
-- That is only true while it stays true -- once a duplicate exists this
-- migration fails and somebody has to decide which document keeps the id.

CREATE UNIQUE INDEX IF NOT EXISTS ux_erp_issue_headers_issue_id_ci
    ON erp.issue_headers (lower(issue_id::text))
    WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_erp_wastage_headers_wastage_id_ci
    ON erp.wastage_headers (lower(wastage_id::text))
    WHERE deleted_at IS NULL;
