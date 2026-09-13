-- When a document was actually entered, on the five tables that never said.
--
-- Every ledger row in this system is dated to a DAY. That is enough to put
-- a bill in August, and not enough to say whether it was entered before or
-- after the recount somebody did that afternoon. 045 added created_at to
-- production and dispatch_headers for exactly that reason -- the warehouse
-- pool's recount anchors need to know what a day's entries came before and
-- after. Bills, issues, wastage, POs and returns were left on a bare date,
-- and they are half of what moves stock.
--
-- updated_at is NOT a substitute and cannot be made into one. It moves on
-- every edit, so it says when a row was last touched, not when it was
-- written. Measured on this database:
--
--     production        671 rows   94% edited after their own date
--     bill_headers      401 rows   73%
--     issue_headers      32 rows   53%
--
-- Reading those as creation times would place a lot edited last week as
-- though it happened last week. So a real column, defaulted at insert, is
-- the only honest way to record this.
--
-- The backfill is the same rule 045 used: date known, time unknown, so the
-- start of that day. It is deliberately not a guess dressed up as
-- precision -- every historical row lands on midnight and therefore ties
-- with its neighbours, which leaves the existing deterministic ordering in
-- place for them. Only rows entered after this deploy carry a real moment,
-- and those are the ones that can be ordered by it.
--
-- Nothing displays this yet, by request. It is recorded so the time is
-- there to be used: within-day ledger ordering, and the same recount
-- anchoring on bills and issues that lots and dispatches already have.

ALTER TABLE erp.bill_headers
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
UPDATE erp.bill_headers
   SET created_at = bill_date::timestamptz
 WHERE created_at IS NULL AND bill_date IS NOT NULL;
ALTER TABLE erp.bill_headers
    ALTER COLUMN created_at SET DEFAULT NOW();

ALTER TABLE erp.issue_headers
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
UPDATE erp.issue_headers
   SET created_at = issue_date::timestamptz
 WHERE created_at IS NULL AND issue_date IS NOT NULL;
ALTER TABLE erp.issue_headers
    ALTER COLUMN created_at SET DEFAULT NOW();

ALTER TABLE erp.wastage_headers
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
UPDATE erp.wastage_headers
   SET created_at = wastage_date::timestamptz
 WHERE created_at IS NULL AND wastage_date IS NOT NULL;
ALTER TABLE erp.wastage_headers
    ALTER COLUMN created_at SET DEFAULT NOW();

ALTER TABLE erp.po_headers
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
UPDATE erp.po_headers
   SET created_at = po_date::timestamptz
 WHERE created_at IS NULL AND po_date IS NOT NULL;
ALTER TABLE erp.po_headers
    ALTER COLUMN created_at SET DEFAULT NOW();

ALTER TABLE erp.return_headers
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
UPDATE erp.return_headers
   SET created_at = return_date::timestamptz
 WHERE created_at IS NULL AND return_date IS NOT NULL;
ALTER TABLE erp.return_headers
    ALTER COLUMN created_at SET DEFAULT NOW();

-- A row written without a date at all would otherwise sit at NULL forever
-- and sort unpredictably. There are none today; this is the guard for the
-- next one.
UPDATE erp.bill_headers   SET created_at = NOW() WHERE created_at IS NULL;
UPDATE erp.issue_headers  SET created_at = NOW() WHERE created_at IS NULL;
UPDATE erp.wastage_headers SET created_at = NOW() WHERE created_at IS NULL;
UPDATE erp.po_headers     SET created_at = NOW() WHERE created_at IS NULL;
UPDATE erp.return_headers SET created_at = NOW() WHERE created_at IS NULL;
