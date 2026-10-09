-- Repairs for the day "Gross" was missing from the Units master.
--
-- "Gross" (144 Pcs) was deleted on 2026-09-08 at 16:34 and added back on
-- 2026-09-09 at 14:58. lookup_unit treats an unknown unit as one of the
-- item's Base Unit, so the three POs saved in between -- 1233, 1234, 1235,
-- all spokes -- stored every line 1:1: 200 Gross as 200, and Rs 100 a Gross
-- as Rs 100 a piece. Nothing failed; the figures were just wrong. What
-- followed from them:
--
--   * Bills 8483 and 2836 were matched against those POs' 1:1 figures, so
--     the allocator linked only what the PO seemed to have left -- 200 or
--     500 pieces, 1.3889 / 3.4722 Gross -- and saved the rest of each line
--     as a separate DIRECT line. The POs read as received; the deliveries
--     read as unordered. Bill 1435 (June, PO 1128) carries the same split
--     from the Apps Script era, which is why PO 1128 showed 149 Gross of
--     235/260 mm spokes still owed.
--   * Bill 2179 (Tushar, PO 1235) was entered as 200 Pcs at the per-Gross
--     rate, so the 200 Gross that arrived (confirmed by the user, 2026-10-09)
--     added 200 pieces to stock instead of 28,800. Saving it in Pcs also
--     switched both ZINC spokes' Purchase Unit to Pcs.
--   * PO and bill saves filed each vendor's rate in Items Master per piece,
--     while Items Master reads a vendor rate per the Purchase Unit -- so
--     spokes bought at Rs 102 a Gross read as Rs 0.71 a Gross. The code now
--     files the rate in the line's own unit; this puts the existing ones
--     right.
--
-- The 235/260 mm spokes are packed into the carton as they come and are
-- counted in Grs (factor 1, deliberately: one Grs per packet); POs 1233 and
-- 1234 ordered them as "Gross" only because they were raised before those
-- items moved to Grs that afternoon. Their stored 1:1 figures are already
-- right in Grs, so those lines just take the Grs label -- re-saved as
-- "Gross", they would become 144 times too large.
--
-- Every statement touches only rows still exactly as they stood in the
-- 2026-10-08 22:57 backup, so one already corrected by hand is left alone
-- and a second run changes nothing. Only bill 2179 moves stock: +28,600 Pcs
-- for each of the two ZINC spokes.

-- 1. PO lines for rim spokes (counted in Pcs): 1 Gross = 144 Pcs.
UPDATE erp.po_lines l
   SET base_qty = l.qty * 144, base_rate = l.price / 144
  FROM erp.po_headers h, erp.items i
 WHERE h.id = l.header_id AND h.deleted_at IS NULL
   AND h.po_number IN ('1233', '1234', '1235')
   AND lower(btrim(l.unit)) = 'gross'
   AND l.base_qty = l.qty AND l.base_rate = l.price
   AND i.deleted_at IS NULL
   AND lower(i.item_name) = lower(l.item_name) AND lower(i.size) = lower(l.size)
   AND lower(btrim(i.base_unit)) = 'pcs';

-- 2. PO lines for carton spokes (counted in Grs): ordered in Grs.
UPDATE erp.po_lines l
   SET unit = 'Grs'
  FROM erp.po_headers h, erp.items i
 WHERE h.id = l.header_id AND h.deleted_at IS NULL
   AND h.po_number IN ('1233', '1234')
   AND lower(btrim(l.unit)) = 'gross'
   AND l.base_qty = l.qty
   AND i.deleted_at IS NULL
   AND lower(i.item_name) = lower(l.item_name) AND lower(i.size) = lower(l.size)
   AND lower(btrim(i.base_unit)) = 'grs';

-- 3. Put each split bill line back together on the PO line it was split
-- from: the DIRECT part folds into the PO-linked part, which keeps its
-- place. Identical in every other field, so nothing else is lost.
WITH frag AS (
    SELECT d.id AS direct_id, p.id AS po_id, d.qty AS d_qty, d.base_qty AS d_base
      FROM erp.bill_headers h
      JOIN erp.bill_lines p ON p.header_id = h.id
      JOIN erp.bill_lines d ON d.header_id = h.id
     WHERE h.deleted_at IS NULL
       AND (   (h.bill_number = '8483' AND h.vendor = 'WeBest Bikes' AND p.po_number = '1233'
                AND p.item_name = 'R-SPOKE & NIPPLE---BLACK-85-110-144-195'
                AND ((p.size = '14 inch' AND p.qty = 1.3889 AND d.qty = 28.6111)
                  OR (p.size = '20 inch' AND p.qty = 3.4722 AND d.qty = 296.5278)))
            OR (h.bill_number = '2836' AND h.vendor = 'Mahadev Industries' AND p.po_number = '1234'
                AND p.item_name = 'R-SPOKE & NIPPLE---BLACK-85-110-144-195'
                AND p.size = '14 inch' AND p.qty = 1.3889 AND d.qty = 188.6111)
            OR (h.bill_number = '1435' AND h.vendor = 'Mahadev Industries' AND p.po_number = '1128'
                AND p.item_name IN ('R-SPOKE & NIPPLE-235-MM-BLACK', 'R-SPOKE & NIPPLE-260-MM---BLACK')
                AND p.qty = 1.0417 AND d.qty = 148.9583))
       AND d.id <> p.id AND d.po_number = 'DIRECT'
       AND d.item_name = p.item_name AND d.size = p.size AND d.unit = p.unit
       AND d.price = p.price AND d.gst_rate_pct = p.gst_rate_pct
       AND d.affects_stock = p.affects_stock AND d.bill_type = p.bill_type
       AND d.narration IS NOT DISTINCT FROM p.narration
       AND d.item_id IS NOT DISTINCT FROM p.item_id
), merged AS (
    UPDATE erp.bill_lines l
       SET qty = round(l.qty + f.d_qty, 4), base_qty = round(l.base_qty + f.d_base, 4)
      FROM frag f
     WHERE l.id = f.po_id
    RETURNING l.id
)
DELETE FROM erp.bill_lines l
 USING frag f
 WHERE l.id = f.direct_id
   AND EXISTS (SELECT 1 FROM merged m WHERE m.id = f.po_id);

-- 4. Bill 8483's carton spokes, entered against PO 1233 on 17 Sep at 13:06
-- and moved to DIRECT at the 15:24 edit: back on PO 1233.
UPDATE erp.bill_lines l
   SET po_number = '1233'
  FROM erp.bill_headers h
 WHERE h.id = l.header_id AND h.deleted_at IS NULL
   AND h.bill_number = '8483' AND h.vendor = 'WeBest Bikes'
   AND l.po_number = 'DIRECT' AND lower(btrim(l.unit)) = 'grs' AND l.qty = 300
   AND l.item_name IN ('R-SPOKE & NIPPLE-235-MM-BLACK', 'R-SPOKE & NIPPLE-260-MM---BLACK');

-- 5. Bill 2179: 200 Gross of each ZINC spoke, as PO 1235 ordered and the
-- bill's own per-Gross rates (Rs 85, Rs 88) say.
UPDATE erp.bill_lines l
   SET unit = 'Gross', base_qty = l.qty * 144, base_rate = l.price / 144
  FROM erp.bill_headers h
 WHERE h.id = l.header_id AND h.deleted_at IS NULL
   AND h.bill_number = '2179' AND h.vendor = 'Tushar Impex'
   AND lower(btrim(l.unit)) = 'pcs' AND l.qty = 200 AND l.base_qty = 200
   AND l.item_name IN ('R-SPOKE & NIPPLE--ZINC--MM--110-BCP', 'R-SPOKE & NIPPLE--ZINC-144-BCP');

-- 6. Both ZINC spokes are bought by the Gross.
UPDATE erp.items
   SET purchase_unit = 'Gross'
 WHERE deleted_at IS NULL
   AND lower(btrim(base_unit)) = 'pcs' AND lower(btrim(purchase_unit)) = 'pcs'
   AND (item_name, size) IN (('R-SPOKE & NIPPLE--ZINC--MM--110-BCP', '14 inch'),
                             ('R-SPOKE & NIPPLE--ZINC-144-BCP', '16 inch'));

-- 7. Vendor rates filed per piece on the rim spokes, which Items Master
-- reads per Gross. A gross of these spokes costs Rs 85-110; anything under
-- Rs 5 can only be a per-piece figure.
UPDATE erp.item_vendors v
   SET rate = round(v.rate * 144, 2)
  FROM erp.items i
 WHERE v.item_id = i.id AND i.deleted_at IS NULL
   AND lower(btrim(i.base_unit)) = 'pcs' AND lower(btrim(i.purchase_unit)) = 'gross'
   AND v.rate >= 0.01 AND v.rate < 5
   AND (i.item_name, i.size) IN (
       ('R-SPOKE & NIPPLE---BLACK-85-110-144-195', '12 inch'),
       ('R-SPOKE & NIPPLE---BLACK-85-110-144-195', '14 inch'),
       ('R-SPOKE & NIPPLE---BLACK-85-110-144-195', '16 inch'),
       ('R-SPOKE & NIPPLE---BLACK-85-110-144-195', '20 inch'),
       ('R-SPOKE & NIPPLE--ZINC--MM--110-BCP', '14 inch'),
       ('R-SPOKE & NIPPLE--ZINC--MM--194-195-BCP', '20 inch'),
       ('R-SPOKE & NIPPLE--ZINC--MM--85--BCP', '12 inch'),
       ('R-SPOKE & NIPPLE--ZINC-144-BCP', '16 inch'));
