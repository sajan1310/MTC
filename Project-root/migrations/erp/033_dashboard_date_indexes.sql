-- Dashboard aggregate indexes.
--
-- getDashboardData used to derive its Bills/Returns/Wastage "this month vs
-- last month" KPIs and its 30-day dispatch trend by loading each ledger's
-- ENTIRE history through that module's getter and bucketing in Python --
-- an O(all history) scan on every dashboard load, auto-refreshed every 5
-- minutes per open tab. dashboard_service.py now asks Postgres for just
-- the date window it needs instead; these four partial indexes are what
-- make that window cheap rather than a seq scan that merely returns less.
--
-- Partial on `deleted_at IS NULL` because every one of these queries filters
-- that way (soft-deleted headers are invisible to every ledger getter), so
-- the index only ever needs to cover live rows.
CREATE INDEX IF NOT EXISTS ix_erp_bill_headers_bill_date
    ON erp.bill_headers (bill_date)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_erp_return_headers_return_date
    ON erp.return_headers (return_date)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_erp_wastage_headers_wastage_date
    ON erp.wastage_headers (wastage_date)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_erp_dispatch_headers_dispatch_date
    ON erp.dispatch_headers (dispatch_date)
    WHERE deleted_at IS NULL;
