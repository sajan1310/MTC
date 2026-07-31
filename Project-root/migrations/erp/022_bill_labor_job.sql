-- Labor Job (job-work) bills, ported from Apps_Script's BILL_COL.BILL_TYPE
-- / PROCESS_NAME / COLOR / ISSUING_PARTY / MANUFACTURING_VENDOR
-- (c63771d, 9eba5a8).
--
-- A Labor Job bill records work a contractor performed on our own material,
-- rather than goods bought from a vendor. The header's `vendor` holds the
-- contractor's name for these bills (source keeps the same column too --
-- contractors and vendors share one name space on a bill).
--
-- Line-level, because one bill can mix job-work lines across processes:
--   bill_type    'GOODS' (default/legacy) or 'LABOR'
--   process_name LABOR only -- the Process Master process this line's
--                job-work was for. item_name is forced server-side to that
--                process's Output Item Name (see bill_service.save_bill),
--                the same "server owns the canonical value" rule
--                save_production already applies.
--   color        LABOR only -- the color processed on this line, picked
--                from that process's color sub-groups.
ALTER TABLE erp.bill_lines
    ADD COLUMN IF NOT EXISTS bill_type VARCHAR(10) NOT NULL DEFAULT 'GOODS',
    ADD COLUMN IF NOT EXISTS process_name VARCHAR(255) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS color VARCHAR(255) NOT NULL DEFAULT '';

-- Header-level, because both are one value per bill (like vendor/contact):
-- who issued the raw material to the contractor, and who manufactured the
-- raw item(s) processed. Optional free text, blank on Goods bills.
ALTER TABLE erp.bill_headers
    ADD COLUMN IF NOT EXISTS issuing_party VARCHAR(255) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS manufacturing_vendor VARCHAR(255) NOT NULL DEFAULT '';
