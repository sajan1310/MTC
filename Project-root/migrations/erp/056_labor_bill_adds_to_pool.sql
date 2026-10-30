-- A Labor Job bill can put its goods into the Warehouse Pool, when the person
-- saving it says so.
--
-- Labor lines stay out of Items Stock (2026-10-14) because goods worked on for
-- us come back through a Production lot, which credits the pool. A maker is
-- different: Heato Cycles makes and paints a frame and bills it finished, so
-- no lot of ours ever touches it, and logging one would take raw frames we
-- never held out of Stock. Bill 1339 (58 frames, 2026-10-30) was entered and
-- its goods then had to be typed into the pool by hand, colour by colour.
--
-- So each new Labor bill now asks: Add to Warehouse Pool, or Ledger only.
--
--   bill_lines.adds_to_pool  what was chosen. Chosen per bill, stored per line
--                            as bill_type is, because the ledger badges lines.
--   warehouse_pool_opening.bill_header_id
--                            the bill behind a row. A credit is an ordinary
--                            Pass 0 row, so recounts, the Pool Ledger, renames
--                            and the audit treat it as they treat any other.
--                            The link is what lets a bill edit or delete take
--                            its own rows back, and stops those rows being
--                            deleted from the pool screens behind the bill.
--
-- Nothing existing changes: every line stays FALSE, so bills already saved
-- stay Ledger only until somebody edits one and chooses otherwise.

ALTER TABLE erp.bill_lines
    ADD COLUMN IF NOT EXISTS adds_to_pool BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE erp.warehouse_pool_opening
    ADD COLUMN IF NOT EXISTS bill_header_id INTEGER REFERENCES erp.bill_headers(id);

CREATE INDEX IF NOT EXISTS ix_erp_warehouse_pool_opening_bill
    ON erp.warehouse_pool_opening (bill_header_id)
    WHERE bill_header_id IS NOT NULL;
