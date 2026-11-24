-- A Warehouse Pool photo for each colour of a processed item, not one for
-- the item (the owner, 2026-11-24: "every processed item is supposed to have
-- different image for its different color combinations").
--
-- Migration 058 kept one photo per Output Item Name, every colour of it
-- alike, the way Items Master keeps one per item. A pool item is not bought
-- in a colour, though: its colour is what the Process made of it. A Red-White
-- frame and a Black frame look nothing alike, and an inspector holding the
-- material against the photo must see the colour the row asks for.
--
-- `color` is the pool bucket's colour exactly as the bucket spells it
-- (erp.warehouse_pool.color): a single colour, a combination ("Red-White"),
-- or a fitted frame and rim ("Orange-White / Black"). Product tags share a
-- colour's photo. '' is the item's photo with no colour: the bucket that
-- has none, and an inspection row drawing on every colour (COMMON).
--
-- Every photo 058 saved becomes its item's no-colour photo. Which colour
-- it showed is not recorded, so it is not guessed onto one; each colour
-- shows a camera until it has its own.
--
-- A colour renamed in Color Master renames it here too
-- (tags_service._rename_color_everywhere), and a renamed Output Item carries
-- its photos, colour by colour (process_service).

ALTER TABLE erp.pool_item_photos
    ADD COLUMN IF NOT EXISTS color VARCHAR(255) NOT NULL DEFAULT '';

DROP INDEX IF EXISTS erp.ux_erp_pool_item_photos_name_ci;

CREATE UNIQUE INDEX IF NOT EXISTS ux_erp_pool_item_photos_name_color_ci
    ON erp.pool_item_photos (lower(output_item_name), lower(color));
