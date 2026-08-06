-- Item Master photo. Stored the same way as the company logo
-- (company_settings_service.py's saveLogo/getLogo): a client-resized
-- (canvas, max ~480px wide, JPEG) data: URL string, saved as-is in one TEXT
-- column. No new upload endpoint/file storage needed -- it travels through
-- the same JSON RPC transport as every other item field (see saveItem's
-- itemImage arg), which is why this is a single column, not a file path.
--
-- Blank on every pre-existing row, which reads as "no photo" -- items.js
-- falls back to a placeholder icon exactly like it already does for any
-- item with no vendors/no image.
ALTER TABLE erp.items
    ADD COLUMN IF NOT EXISTS image TEXT NOT NULL DEFAULT '';
