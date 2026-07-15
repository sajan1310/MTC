-- Structured replacement for module_stock.js's _logStockChange/
-- getStockAdjustmentHistory, which piggyback on the generic Logs sheet and
-- regex-parse a fixed-format Details string back into fields. Postgres has
-- a real place to put structured data, so this is a normal table instead.
-- Append-only audit log -- no sync columns, matching erp.item_vendors'
-- precedent for a table that isn't independently synced.

CREATE TABLE IF NOT EXISTS erp.stock_adjustments (
    id SERIAL PRIMARY KEY,
    item_name VARCHAR(255) NOT NULL,
    size VARCHAR(255) NOT NULL DEFAULT '',
    action VARCHAR(10) NOT NULL CHECK (action IN ('ADJUST', 'RESET')),
    old_value NUMERIC NOT NULL,
    new_value NUMERIC NOT NULL,
    reason TEXT,
    created_by INTEGER REFERENCES public.users(user_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_erp_stock_adjustments_item
    ON erp.stock_adjustments (lower(item_name), lower(size));
