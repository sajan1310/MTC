-- PERF-005: checkStockAdjustmentConflicts runs on every bill save and now asks
-- for the latest adjustment of only the items on that bill, via
--     WHERE (lower(item_name), lower(COALESCE(size,''))) IN (...)
--     ORDER BY lower(item_name), lower(COALESCE(size,'')), created_at DESC
-- It previously pulled the ENTIRE adjustments table into Python and reduced it
-- there. This index is what makes the narrowed query a lookup rather than a
-- scan; the column expressions must match the query's exactly or Postgres will
-- not use it.
CREATE INDEX IF NOT EXISTS ix_erp_stock_adjustments_item_size_created
    ON erp.stock_adjustments (
        lower(item_name),
        lower(COALESCE(size, '')),
        created_at DESC
    );
