-- Dispatch Plan: a day-ahead drag-and-drop board -- warehouse staff
-- pre-assign Ready-to-Dispatch stock to clients before the actual Dispatch
-- bill (erp.dispatch_headers/_lines, see 023_dispatch_header_lines.sql) is
-- recorded. A card converts into a real bill later (dispatch_service.
-- save_dispatch, given sourcePlanLineIds), which is what actually debits
-- the warehouse pool -- this table never does.
--
-- Deliberately FLAT, no header table, unlike dispatch_headers/_lines: a
-- plan has no header-only data (no transport/invoice/logistics fields --
-- those only exist once a real bill is recorded), and client_name lives on
-- the LINE because one plan_date holds several clients' cards at once. A
-- header row here would carry nothing but plan_date itself, so it's
-- skipped -- plan_date is a plain, non-unique column, several clients (or
-- several rows of the same client) can freely share one date with no
-- header-row contention to resolve.
--
-- Deliberate deviation from erp.dispatch_lines/erp.po_lines/erp.bom_lines's
-- documented "no independent lifecycle, always delete-and-reinsert
-- wholesale alongside its header" precedent: a plan line IS its own row
-- with an independent lifecycle -- drag-and-drop adds/edits/removes ONE
-- line at a time, never a whole-plan resubmit, so each line gets its own
-- CRUD (saveDispatchPlanLine/deleteDispatchPlanLine).
--
-- No row_version/client_uuid/deleted_at (the header+lines sync-column
-- convention) and hard-deleted, not soft: plans are same-team drafts with
-- no offline-mutation or audit-trail requirement -- every line's qty is
-- independently re-validated against live Ready-to-Dispatch availability
-- on every save, and again for real by save_dispatch's own guard at
-- conversion time, so optimistic-concurrency machinery would only protect
-- against a low-stakes, self-correcting scenario (two staff editing the
-- same card).
CREATE TABLE IF NOT EXISTS erp.dispatch_plan_lines (
    id SERIAL PRIMARY KEY,
    plan_date DATE NOT NULL,
    client_name VARCHAR(255) NOT NULL,
    -- VARCHAR(255), NOT the VARCHAR(50) erp.dispatch_lines.product_id uses:
    -- a "product id" here is whatever getReadyToDispatchData reports, which
    -- for an untagged final-stage output is its full Output Item Name, not a
    -- short code ("24 inch Hunter IBC T/Tube 2.40 Unbranded Caliper Break"
    -- is 54 chars). Sized to match product_name for that reason.
    product_id VARCHAR(255) NOT NULL,
    product_name VARCHAR(255) NOT NULL,
    qty NUMERIC NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    -- NULL = still an open/draft card line. Set atomically by save_dispatch
    -- when a real bill is recorded from this line's card -- never edited or
    -- cleared once set (saveDispatchPlanLine/deleteDispatchPlanLine both
    -- reject once this is non-null).
    fulfilled_dispatch_number VARCHAR(50),
    fulfilled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by INTEGER REFERENCES public.users(user_id)
);

CREATE INDEX IF NOT EXISTS ix_erp_dispatch_plan_lines_plan_date ON erp.dispatch_plan_lines (plan_date);
CREATE INDEX IF NOT EXISTS ix_erp_dispatch_plan_lines_client_name ON erp.dispatch_plan_lines (lower(client_name));
CREATE INDEX IF NOT EXISTS ix_erp_dispatch_plan_lines_product_id ON erp.dispatch_plan_lines (lower(product_id));
