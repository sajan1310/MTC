-- Dispatch redesign: flat single-item-per-row -> header+lines, matching
-- reference commits e37529e/6a22f0e (module_dispatch.js), which restructured
-- the Dispatch sheet into "one Dispatch Number shared by one-or-more line
-- rows" (same header+lines convention already used here for PO/Bill/Return
-- -- see 007_po_tracker.sql). Rate/Amount are new, optional, per-line,
-- record-keeping-only fields (never read by any availability/pool-crediting
-- math), matching the reference's own documented "record-keeping only"
-- framing for those two columns.
--
-- Header carries the same identity/audit columns as every other header
-- table in this schema (row_version/updated_at/updated_by/client_uuid/
-- deleted_at) plus a unique index on lower(dispatch_number), mirroring
-- 007_po_tracker.sql's ux_erp_po_headers_number_ci exactly.
--
-- Lines carry NO sync columns, matching erp.po_lines/erp.bom_lines's
-- documented precedent: a line has no independent lifecycle, it is always
-- rewritten wholesale alongside its header (delete-and-reinsert on every
-- save), so row_version/deleted_at on a line would never be read.
--
-- logistics_rate stays a single header-level snapshot (the contractor rate
-- card value at save time, same for every line of one bill); logistics_cost
-- is genuinely per-line (= header.logistics_rate * that line's qty) so a
-- line's own row carries its own contribution to the bill's total, same
-- convention the flat table already used per-row.

CREATE TABLE IF NOT EXISTS erp.dispatch_headers (
    id SERIAL PRIMARY KEY,
    dispatch_number VARCHAR(50) NOT NULL,
    dispatch_date DATE NOT NULL,
    order_number VARCHAR(50),
    client_name VARCHAR(255),
    transport VARCHAR(255),
    remarks TEXT,
    invoice_number VARCHAR(100),
    private_mark VARCHAR(100),
    gr_number VARCHAR(100),
    logistics_contractor VARCHAR(255),
    contractor_id INTEGER REFERENCES erp.contractors(id),
    logistics_rate NUMERIC NOT NULL DEFAULT 0,
    row_version BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by INTEGER REFERENCES public.users(user_id),
    client_uuid UUID UNIQUE,
    deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_erp_dispatch_headers_number_ci
    ON erp.dispatch_headers (lower(dispatch_number)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_erp_dispatch_headers_order_number
    ON erp.dispatch_headers (lower(order_number));

CREATE TRIGGER trg_erp_dispatch_headers_touch_row_version
    BEFORE INSERT OR UPDATE ON erp.dispatch_headers
    FOR EACH ROW EXECUTE FUNCTION erp.touch_row_version();

-- No sync columns -- a child with no independent lifecycle, same precedent
-- as erp.po_lines/erp.bom_lines. Always rewritten wholesale alongside its
-- header (save_dispatch's delete-all-existing-then-reinsert).
CREATE TABLE IF NOT EXISTS erp.dispatch_lines (
    id SERIAL PRIMARY KEY,
    header_id INTEGER NOT NULL REFERENCES erp.dispatch_headers(id) ON DELETE CASCADE,
    product_id VARCHAR(50) NOT NULL,
    bom_product_id INTEGER REFERENCES erp.bom_products(id),
    product_name VARCHAR(255) NOT NULL,
    qty NUMERIC NOT NULL,
    rate NUMERIC NOT NULL DEFAULT 0,
    amount NUMERIC NOT NULL DEFAULT 0,
    logistics_cost NUMERIC NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS ix_erp_dispatch_lines_header_id ON erp.dispatch_lines (header_id);
CREATE INDEX IF NOT EXISTS ix_erp_dispatch_lines_product_id ON erp.dispatch_lines (lower(product_id));

-- Non-destructive carry-over from the old flat erp.dispatch table, run only
-- once (guarded by "headers already has rows" so re-running this file, or
-- applying it against a DB that already migrated, is a no-op). Old rows are
-- grouped by dispatch_number defensively -- the flat table had no unique
-- constraint on it, so if any duplicate numbers ever existed (they
-- shouldn't have, since dispatch_number was always sequence-generated
-- per-row under the old one-product-per-save model), this naturally folds
-- them into one header with multiple lines instead of erroring. The old
-- table is renamed, never dropped -- a safety net, not deleted history.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'erp' AND table_name = 'dispatch'
    ) AND NOT EXISTS (SELECT 1 FROM erp.dispatch_headers LIMIT 1) THEN

        INSERT INTO erp.dispatch_headers (
            dispatch_number, dispatch_date, order_number, client_name,
            transport, remarks, invoice_number, private_mark, gr_number,
            logistics_contractor, contractor_id, logistics_rate,
            updated_at, updated_by, deleted_at
        )
        SELECT DISTINCT ON (lower(d.dispatch_number))
            d.dispatch_number, d.dispatch_date, d.order_number, d.client_name,
            d.transport, d.remarks, d.invoice_number, d.private_mark, d.gr_number,
            d.logistics_contractor, d.contractor_id, d.logistics_rate,
            d.updated_at, d.updated_by, d.deleted_at
        FROM erp.dispatch d
        ORDER BY lower(d.dispatch_number), d.id;

        INSERT INTO erp.dispatch_lines (
            header_id, product_id, bom_product_id, product_name, qty, rate, amount, logistics_cost
        )
        SELECT h.id, d.product_id, d.bom_product_id, d.product_name, d.qty, 0, 0, d.logistics_cost
        FROM erp.dispatch d
        JOIN erp.dispatch_headers h ON lower(h.dispatch_number) = lower(d.dispatch_number);

        ALTER TABLE erp.dispatch RENAME TO dispatch_legacy;
    END IF;
END $$;
