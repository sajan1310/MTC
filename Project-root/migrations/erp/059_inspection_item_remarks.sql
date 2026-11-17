-- A remark on each inspection checklist row: what the inspector found on
-- that one item -- "13G, not 12G", "5 short", "wrong shade" -- for the admin
-- reviewing the lot and whoever modifies it (the owner, 2026-11-17: "add
-- remarks column for inspector for each item to review modifications").
--
-- Kept on the inspection, keyed by the checklist row's key (item|size|colour,
-- inspection_service.sheet_rows), not on erp.lot_inspection_checks: a check
-- row exists only while its item is ticked, and a remark belongs just as
-- much to an item that is not -- it is usually why it is not. A remark is a
-- note, not a tick, so it is not tied to the row's quantity and
-- specification: it stays when an admin changes them, and the fix shows as
-- Revised beside the remark that asked for it.
--
--   {"<row key>": {"text": "...", "by": <user_id>, "byName": "...", "at": "<timestamptz>"}}
--
-- A row with no remark has no entry. Written only while the inspection is
-- open; kept as it stood once the lot is cleared.

ALTER TABLE erp.lot_inspections
    ADD COLUMN IF NOT EXISTS item_remarks JSONB NOT NULL DEFAULT '{}'::jsonb;
