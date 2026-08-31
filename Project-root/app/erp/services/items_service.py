"""Items Master, ported from Apps_Script/module_items.js.

Vendor storage is NOT a JSON-in-cell blob in the source -- it's adjacent grid
column pairs, a spreadsheet-export concern that doesn't apply here. The
{vendor, rate} JSON shape only exists at the RPC boundary; erp.item_vendors
is a normal child table, rewritten wholesale on every saveItem (matching the
source's own "clear vendor columns, write fresh" behavior).

saveItem's `formData` keys (itemName/itemSize/itemRemarks/itemNarration/
itemSpec/itemInitialStock/itemBaseUnit/itemPurchaseUnit/
itemWeightPerBaseUnit/vendors/originalName/originalSize) are a *different*
naming convention than getItemsData's response fields (name/size/remarks/
narration/specification/baseUnit/purchaseUnit/weightPerBaseUnit/vendors) --
both preserved exactly as in the source for frontend compatibility.

Deliberately not ported: Apps Script's sanitizeString() call on every string
field exists to guard against Sheets formula injection (a value starting
with '=' being interpreted as a spreadsheet formula) -- meaningless for a
Postgres text column, which is never evaluated as a formula. Plain
str().strip() is used instead; all values are still sent through
parameterized queries, so there's no SQL-injection concern either.

mergeItemEdit, mergeSelectedItems, keepOrphanItem(sBulk), and
runScheduledItemCleanup (data hygiene tooling) are ported below too.
autoMergeDuplicateItems/autoFixTruncatedDuplicateItems aren't their own RPC
methods -- nothing on the frontend calls them directly, only
runScheduledItemCleanup, which folds both phases into itself as private
helpers. importItemsFromStock (module_items.js:1928) is ported below,
now that erp.stock is real (Phase 1c). _propagateItemIdentityChange
(module_items.js:1125) is ported below too, now that erp.po_lines is real
(Phase 2b) -- guarded per target table exactly like every other rename
cascade, so its still-missing targets (Bill/BOM/Process Components) stay
no-ops until their own rounds land, the same tolerance the source's own
`typeof fn !== 'function'` guard provides.
"""

from __future__ import annotations

import json
import math

import psycopg2.extras

import database
from . import production_service
from . import rename_utils
from . import stock_rows
from . import units_service
from .current_user import get_current_user_id
from .. import config_maps
from .. import date_utils
from ..envelope import build_response
from ..registry import rpc_method

# Minimum vendor rate to surface -- prevents an empty/zero rate (a vendor
# pair slot with no real rate entered) from showing up as if it were a
# real quoted price. Matches module_items.js's own MIN_VENDOR_RATE exactly.
MIN_VENDOR_RATE = 0.01


# ─────────────────────────────────────────────────────────────────────────
# Validators (module_items.js's _validate*)
# ─────────────────────────────────────────────────────────────────────────


def _validate_item_name(name) -> str:
    s = str(name or "").strip()
    if not s:
        raise ValueError("Item name must not be empty.")
    return s


def _validate_vendor_rate(rate) -> float:
    try:
        r = float(rate)
    except (TypeError, ValueError):
        r = math.nan
    if not math.isfinite(r) or r < 0:
        raise ValueError("Vendor rate must be a non-negative number.")
    return r


def _validate_base_unit(value) -> str:
    s = str(value or "").strip()
    return s or "Pcs"


def _validate_purchase_unit(value, base_unit: str) -> str:
    s = str(value or "").strip()
    return s or base_unit


def _validate_weight_per_base_unit(value) -> float:
    if value in (None, ""):
        return 0.0
    try:
        n = float(value)
    except (TypeError, ValueError):
        raise ValueError("Weight per Base Unit must be a non-negative number.")
    if not math.isfinite(n) or n < 0:
        raise ValueError("Weight per Base Unit must be a non-negative number.")
    return n


def _validate_initial_stock(value) -> float:
    # Negative allowed on purpose -- an over-consumed item (e.g. production
    # issued more than was on hand) can leave stock negative; the user
    # should see and correct that, not be blocked from saving.
    if value in (None, ""):
        return 0.0
    try:
        n = float(value)
    except (TypeError, ValueError):
        raise ValueError("Initial stock must be a valid number.")
    if not math.isfinite(n):
        raise ValueError("Initial stock must be a valid number.")
    return n


# ─────────────────────────────────────────────────────────────────────────
# Lookups
# ─────────────────────────────────────────────────────────────────────────


def _find_item(cur, name: str, size: str):
    cur.execute(
        "SELECT id FROM erp.items WHERE lower(item_name) = lower(%s) AND lower(size) = lower(%s) AND deleted_at IS NULL",
        (name, size),
    )
    row = cur.fetchone()
    return row["id"] if row else None


def _item_name_size_still_exists(cur, name: str, size: str) -> bool:
    return _find_item(cur, name, size) is not None


def _count_vendors(cur, item_id) -> int:
    cur.execute(
        "SELECT COUNT(*) AS n FROM erp.item_vendors WHERE item_id = %s AND rate >= %s",
        (item_id, MIN_VENDOR_RATE),
    )
    return cur.fetchone()["n"]


def _get_stock_initial(cur, name: str, size: str) -> float:
    cur.execute(
        "SELECT initial_stock FROM erp.stock WHERE lower(item_name) = lower(%s) AND lower(size) = lower(%s) AND deleted_at IS NULL",
        (name, size),
    )
    row = cur.fetchone()
    return float(row["initial_stock"]) if row else 0.0


def get_item_unit_info_map(cur) -> dict:
    """{name_lower|size_lower: {"baseUnit", "purchaseUnit", "weightPerBaseUnit"}}
    for every active item -- ports _getItemUnitInfoMap. Not an RPC method;
    for PO/Bill's _normalizeItems-equivalent to resolve an item's Base Unit
    for qty/rate conversion.
    """
    cur.execute("SELECT item_name, size, base_unit, purchase_unit, weight_per_base_unit FROM erp.items WHERE deleted_at IS NULL")
    result = {}
    for row in cur.fetchall():
        name = (row["item_name"] or "").strip()
        if not name:
            continue
        size = (row["size"] or "").strip()
        base_unit = (row["base_unit"] or "").strip() or "Pcs"
        purchase_unit = (row["purchase_unit"] or "").strip() or base_unit
        result[f"{name.lower()}|{size.lower()}"] = {
            "baseUnit": base_unit,
            "purchaseUnit": purchase_unit,
            "weightPerBaseUnit": float(row["weight_per_base_unit"] or 0),
        }
    return result


def lookup_item_unit_info(unit_map: dict, name: str, size: str) -> dict:
    """Falls back to Pcs/Pcs/0 for an item not yet registered -- matches
    _lookupItemUnitInfo.
    """
    key = f'{str(name or "").strip().lower()}|{str(size or "").strip().lower()}'
    return unit_map.get(key) or {"baseUnit": "Pcs", "purchaseUnit": "Pcs", "weightPerBaseUnit": 0}


def get_item_narration_map(cur) -> dict:
    """{name_lower|size_lower: narration} for every item with a non-blank
    narration -- ports _getItemNarrationMap. Only non-blank narrations are
    included: a blank one carries no information and must never overwrite a
    note somebody typed by hand into a consumer, so "absent from the map"
    reads as "keep what you have" everywhere this is used, with no second
    check needed.
    """
    cur.execute("SELECT item_name, size, narration FROM erp.items WHERE deleted_at IS NULL")
    result = {}
    for row in cur.fetchall():
        name = (row["item_name"] or "").strip()
        narration = (row["narration"] or "").strip()
        if not name or not narration:
            continue
        size = (row["size"] or "").strip()
        result[f"{name.lower()}|{size.lower()}"] = narration
    return result


def get_item_master_refresh_map(cur) -> dict:
    """{name_lower|size_lower: {"canonicalName", "narration", "baseUnit"}}
    for every item -- ports _getItemMasterRefreshMap. Combines the 3 fields
    production_service.refresh_production_components_from_items_master
    resyncs onto every already-logged lot's stored components.
    canonicalName and baseUnit are always included (a blank Base Unit still
    defaults to 'Pcs', same as get_item_unit_info_map); narration is blank
    when Items Master has none, same non-blank-wins semantics as
    get_item_narration_map.
    """
    cur.execute("SELECT item_name, size, narration, base_unit FROM erp.items WHERE deleted_at IS NULL")
    result = {}
    for row in cur.fetchall():
        name = (row["item_name"] or "").strip()
        if not name:
            continue
        size = (row["size"] or "").strip()
        result[f"{name.lower()}|{size.lower()}"] = {
            "canonicalName": name,
            "narration": (row["narration"] or "").strip(),
            "baseUnit": (row["base_unit"] or "").strip() or "Pcs",
        }
    return result


def _propagate_item_identity_change(cur, old_name: str, old_size: str, new_name: str, new_size: str) -> None:
    for sheet_key in (
        "PO_LINES", "BILL_LINES", "BOM_LINES", "RETURN_LINES", "WASTAGE_LINES", "ISSUE_LINES",
        "STOCK_GROUP_ITEMS",
    ):
        table = config_maps.TABLE_NAMES.get(sheet_key)
        if table:
            rename_utils.rename_composite_key(cur, table, "item_name", "size", old_name, old_size, new_name, new_size)

    # Process Components: only ITEM-sourced rows -- a POOL row's item_name is
    # a different identity space (an upstream process's Output Item Name),
    # handled by process_service's own _rename_pool_output_item_name_everywhere,
    # and must never be touched by an Items Master rename even on a
    # name+size coincidence (backfillProcessComponentItemRefs).
    comp_table = config_maps.TABLE_NAMES.get("PROCESS_COMPONENTS")
    if comp_table:
        rename_utils.rename_composite_key(
            cur, comp_table, "item_name", "size", old_name, old_size, new_name, new_size,
            extra_where=" AND source_type != 'POOL'",
        )

    # Production's Components Consumed / Production Sheet custom components
    # live as JSONB, not a plain column -- can't go through rename_utils'
    # SQL-only helpers. Guarded the same way as every other target here:
    # a no-op until erp.production exists.
    if config_maps.TABLE_NAMES.get("PRODUCTION"):
        production_service.backfill_production_consumed_item_refs(cur, old_name, old_size, new_name, new_size)


def _get_item_keys_in_use(cur, items: list) -> set:
    """"nameLower|sizeLower" keys referenced by a BOM component row, an
    ITEM-sourced Process Components row, or a saved Stock Group -- unsafe to
    delete. Guarded via config_maps.TABLE_NAMES exactly like Phase 1a's
    rename cascades; all three targets are real as of Phase 3c (BOM),
    Phase 3a (Process Components), and this round (Stock Groups).
    """
    requested = {
        f'{str(it.get("name") or "").strip().lower()}|{str(it.get("size") or "").strip().lower()}'
        for it in items
        if str(it.get("name") or "").strip()
    }
    in_use: set = set()
    if not requested:
        return in_use

    bom_lines_table = config_maps.TABLE_NAMES.get("BOM_LINES")
    bom_products_table = config_maps.TABLE_NAMES.get("BOM_PRODUCTS")
    if bom_lines_table and bom_products_table:
        # erp.bom_lines has no deleted_at of its own -- same join-through-
        # the-parent treatment as the PROCESS_COMPONENTS branch below.
        cur.execute(
            f"""
            SELECT bl.item_name, bl.size
            FROM {bom_lines_table} bl
            JOIN {bom_products_table} bp ON bp.id = bl.header_id
            WHERE bp.deleted_at IS NULL
            """
        )
        for row in cur.fetchall():
            key = f'{(row["item_name"] or "").strip().lower()}|{(row["size"] or "").strip().lower()}'
            if key in requested:
                in_use.add(key)

    comp_table = config_maps.TABLE_NAMES.get("PROCESS_COMPONENTS")
    master_table = config_maps.TABLE_NAMES.get("PROCESS_MASTER")
    if comp_table and master_table:
        # erp.process_components has no deleted_at of its own (a child with
        # no independent lifecycle, same as erp.po_lines) -- visibility
        # comes from its parent's deleted_at via this join, not a direct
        # column reference.
        cur.execute(
            f"""
            SELECT pc.item_name, pc.size
            FROM {comp_table} pc
            JOIN {master_table} pm ON pm.id = pc.master_id
            WHERE pm.deleted_at IS NULL AND upper(pc.source_type) != 'POOL'
            """
        )
        for row in cur.fetchall():
            key = f'{(row["item_name"] or "").strip().lower()}|{(row["size"] or "").strip().lower()}'
            if key in requested:
                in_use.add(key)

    group_items_table = config_maps.TABLE_NAMES.get("STOCK_GROUP_ITEMS")
    if group_items_table:
        # erp.stock_group_items has no deleted_at of its own (rewritten
        # wholesale alongside its parent group, same as erp.item_vendors) --
        # visibility comes from the parent group's deleted_at via this join.
        cur.execute(
            f"""
            SELECT gi.item_name, gi.size
            FROM {group_items_table} gi
            JOIN erp.stock_group_master gm ON gm.id = gi.group_id
            WHERE gm.deleted_at IS NULL
            """
        )
        for row in cur.fetchall():
            key = f'{(row["item_name"] or "").strip().lower()}|{(row["size"] or "").strip().lower()}'
            if key in requested:
                in_use.add(key)

    return in_use


# ─────────────────────────────────────────────────────────────────────────
# Item identity drift diagnostic ("Check Reference Integrity")
# ─────────────────────────────────────────────────────────────────────────
#
# Read-only diagnostic -- never blocks a save, never auto-fixes anything.
# Verifies that every (Item Name, Size) reference outside Items Master
# still resolves to a row that actually exists there.
#
# Exists because a rename/merge cascade (_propagate_item_identity_change)
# only knows how to repoint the sheets it's explicitly wired to backfill --
# a sheet added later without a matching backfill, or historical rows
# saved before a given backfill existed, would otherwise drift silently
# out of sync with Items Master and nobody would notice until Stock math
# went wrong. This scans every table that stores an Items Master (name,
# size) reference and flags any that don't currently resolve to a real
# item -- whether that's leftover damage from before a fix existed, or a
# brand new gap in a cascade that hasn't been added yet.
#
# POOL-sourced rows (Process Components / Production Components Consumed)
# are skipped -- their "item name" is an upstream process's Output Item
# Name (Warehouse Pool), not an Items Master reference.


def _get_valid_item_identity_keys(cur) -> set:
    cur.execute("SELECT item_name, size FROM erp.items WHERE deleted_at IS NULL")
    keys = set()
    for row in cur.fetchall():
        name = (row["item_name"] or "").strip().lower()
        if not name:
            continue
        size = (row["size"] or "").strip().lower()
        keys.add(f"{name}|{size}")
    return keys


@rpc_method("getItemIdentityDriftReport")
def get_item_identity_drift_report():
    findings: list = []

    def check(sheet_label: str, context: str, item_name, size, valid_keys: set) -> None:
        name = str(item_name or "").strip()
        if not name:
            return
        key = f'{name.lower()}|{str(size or "").strip().lower()}'
        if key in valid_keys:
            return
        findings.append({"sheet": sheet_label, "context": context, "itemName": name, "size": str(size or "").strip()})

    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        valid_keys = _get_valid_item_identity_keys(cur)

        cur.execute(
            """
            SELECT h.bill_number, l.item_name, l.size
            FROM erp.bill_lines l JOIN erp.bill_headers h ON h.id = l.header_id
            WHERE h.deleted_at IS NULL
            """
        )
        for row in cur.fetchall():
            check("Bill Ledger", f'Bill #{row["bill_number"] or ""}', row["item_name"], row["size"], valid_keys)

        cur.execute(
            """
            SELECT h.po_number, l.item_name, l.size
            FROM erp.po_lines l JOIN erp.po_headers h ON h.id = l.header_id
            WHERE h.deleted_at IS NULL
            """
        )
        for row in cur.fetchall():
            check("PO Tracker", f'PO #{row["po_number"] or ""}', row["item_name"], row["size"], valid_keys)

        cur.execute(
            """
            SELECT bp.product_name, bp.product_id, l.item_name, l.size
            FROM erp.bom_lines l JOIN erp.bom_products bp ON bp.id = l.header_id
            WHERE bp.deleted_at IS NULL
            """
        )
        for row in cur.fetchall():
            context = f'{row["product_name"] or ""} ({row["product_id"] or ""})'
            check("BOM", context, row["item_name"], row["size"], valid_keys)

        cur.execute(
            """
            SELECT pm.process_id, pc.item_name, pc.size
            FROM erp.process_components pc JOIN erp.process_master pm ON pm.id = pc.master_id
            WHERE pm.deleted_at IS NULL AND upper(pc.source_type) != 'POOL'
            """
        )
        for row in cur.fetchall():
            check("Process Components", f'Process {row["process_id"] or ""}', row["item_name"], row["size"], valid_keys)

        cur.execute(
            """
            SELECT h.return_number, l.item_name, l.size
            FROM erp.return_lines l JOIN erp.return_headers h ON h.id = l.header_id
            WHERE h.deleted_at IS NULL
            """
        )
        for row in cur.fetchall():
            check("Return Ledger", f'Return #{row["return_number"] or ""}', row["item_name"], row["size"], valid_keys)

        cur.execute(
            """
            SELECT h.wastage_id, l.item_name, l.size
            FROM erp.wastage_lines l JOIN erp.wastage_headers h ON h.id = l.header_id
            WHERE h.deleted_at IS NULL
            """
        )
        for row in cur.fetchall():
            check("Wastage Log", f'Wastage {row["wastage_id"] or ""}', row["item_name"], row["size"], valid_keys)

        cur.execute(
            """
            SELECT h.issue_id, l.item_name, l.size
            FROM erp.issue_lines l JOIN erp.issue_headers h ON h.id = l.header_id
            WHERE h.deleted_at IS NULL
            """
        )
        for row in cur.fetchall():
            check("Issued Stock Log", f'Issue {row["issue_id"] or ""}', row["item_name"], row["size"], valid_keys)

        cur.execute(
            """
            SELECT id, lot_number, components_consumed
            FROM erp.production
            WHERE deleted_at IS NULL AND components_consumed IS NOT NULL
            """
        )
        for row in cur.fetchall():
            components = row["components_consumed"] or []
            if not isinstance(components, list):
                continue
            lot_label = row["lot_number"] or f'(row id {row["id"]})'
            context = f"Lot {lot_label}"
            for comp in components:
                comp = comp or {}
                if str(comp.get("sourceType") or "").strip().upper() == "POOL":
                    continue
                check("Production (Components Consumed)", context, comp.get("itemName"), comp.get("size"), valid_keys)

        cur.execute(
            """
            SELECT gm.name AS group_name, gi.item_name, gi.size
            FROM erp.stock_group_items gi JOIN erp.stock_group_master gm ON gm.id = gi.group_id
            WHERE gm.deleted_at IS NULL
            """
        )
        for row in cur.fetchall():
            check("Stock Groups", f'Group "{row["group_name"] or ""}"', row["item_name"], row["size"], valid_keys)

    counts: dict = {}
    for f in findings:
        counts[f["sheet"]] = counts.get(f["sheet"], 0) + 1
    message = (
        "No drift found -- every Item Name/Size reference resolves to a current Items Master row."
        if not findings
        else f"{len(findings)} stale reference(s) found: " + ", ".join(f"{v} in {k}" for k, v in counts.items())
    )

    return build_response(True, findings, message)


@rpc_method("fixItemIdentityDriftReference", mutation=True)
@database.transactional
def fix_item_identity_drift_reference(conn, cur, stale_name, stale_size="", target_name="", target_size=""):
    """Repairs one distinct stale reference surfaced by
    getItemIdentityDriftReport by repointing EVERY row across EVERY
    referencing table from the stale (name, size) to a real,
    currently-existing Items Master (name, size) that the caller
    identifies -- the system cannot infer this on its own, since Items
    Master keeps no rename history, so the target must be a deliberate
    human choice from the "Check Reference Integrity" dialog.

    Reuses the exact same backfill (_propagate_item_identity_change) the
    rename/merge cascade already relies on -- a stale reference and a
    normal rename are the same repair, just with the "before" identity
    sourced from the drift report instead of a live save_item() call.

    No Stock recalculation step follows this (unlike the source's own
    recalculateStock() call): Stock here is always computed live from the
    ledger tables at read time (see stock_service.get_stock_data), not
    cached, so there's nothing to invalidate.
    """
    valid_stale_name = str(stale_name or "").strip()
    if not valid_stale_name:
        raise ValueError("A stale item name is required.")
    valid_stale_size = str(stale_size or "").strip()

    valid_target_name = _validate_item_name(target_name)
    valid_target_size = str(target_size or "").strip()

    if _find_item(cur, valid_target_name, valid_target_size) is None:
        size_suffix = f' (size: "{valid_target_size}")' if valid_target_size else ""
        raise ValueError(
            f'Target item "{valid_target_name}"{size_suffix} was not found in Items Master. '
            "Pick an item that currently exists."
        )

    _propagate_item_identity_change(cur, valid_stale_name, valid_stale_size, valid_target_name, valid_target_size)

    stale_display = f" ({valid_stale_size})" if valid_stale_size else ""
    target_display = f" ({valid_target_size})" if valid_target_size else ""
    message = f'Repointed all references from "{valid_stale_name}"{stale_display} to "{valid_target_name}"{target_display}.'
    return build_response(True, None, message)


# ─────────────────────────────────────────────────────────────────────────
# RPC methods
# ─────────────────────────────────────────────────────────────────────────


def _row_to_item_record(row, vendor_rows, units_map) -> dict:
    base_unit = row["base_unit"] or "Pcs"
    purchase_unit = row["purchase_unit"] or base_unit
    weight_per_base_unit = float(row["weight_per_base_unit"] or 0)
    item_for_conversion = {"baseUnit": base_unit, "weightPerBaseUnit": weight_per_base_unit}

    vendors = []
    for v in vendor_rows:
        rate = float(v["rate"])
        if rate < MIN_VENDOR_RATE:
            continue
        try:
            rate_per_base_unit = units_service.convert_rate_to_base_unit(
                rate, purchase_unit, item_for_conversion, units_map
            )
        except ValueError:
            rate_per_base_unit = rate
        vendors.append({"vendor": v["vendor"], "rate": rate, "ratePerBaseUnit": rate_per_base_unit})

    return {
        "name": row["item_name"],
        "size": row["size"] or "",
        "remarks": row["remarks"] or "",
        "narration": row["narration"] or "",
        "specification": row["specification"] or "",
        "baseUnit": base_unit,
        "purchaseUnit": purchase_unit,
        "weightPerBaseUnit": weight_per_base_unit,
        "image": row["image"] or "",
        "vendors": vendors,
    }


@rpc_method("getItemsData")
def get_items_data():
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        cur.execute(
            """
            SELECT id, item_name, size, remarks, narration, specification,
                   base_unit, purchase_unit, weight_per_base_unit, image
            FROM erp.items
            WHERE deleted_at IS NULL
            ORDER BY lower(item_name)
            """
        )
        item_rows = cur.fetchall()

        vendors_by_item: dict = {}
        if item_rows:
            cur.execute(
                "SELECT item_id, vendor, rate FROM erp.item_vendors WHERE item_id = ANY(%s) ORDER BY item_id, id",
                ([row["id"] for row in item_rows],),
            )
            for v in cur.fetchall():
                vendors_by_item.setdefault(v["item_id"], []).append(v)

        # Inside the connection block: `cur` is closed once the `with` exits
        # (PERF-003 -- this used to open a second connection out here).
        units_map = units_service.get_units_map(cur)

    items = [_row_to_item_record(row, vendors_by_item.get(row["id"], []), units_map) for row in item_rows]
    return build_response(True, items)


def _fetch_item_record(cur, item_id):
    """Reads one freshly-written item + its vendors back by id, so
    save_item can hand it to the client for an in-place row-patch instead
    of a full reload."""
    cur.execute(
        """
        SELECT id, item_name, size, remarks, narration, specification,
               base_unit, purchase_unit, weight_per_base_unit, image
        FROM erp.items WHERE id = %s
        """,
        (item_id,),
    )
    row = cur.fetchone()
    if row is None:
        return None
    cur.execute("SELECT item_id, vendor, rate FROM erp.item_vendors WHERE item_id = %s ORDER BY id", (item_id,))
    vendor_rows = cur.fetchall()
    units_map = units_service.get_units_map(cur)
    return _row_to_item_record(row, vendor_rows, units_map)


@rpc_method("saveItem", mutation=True)
@database.transactional
def save_item(conn, cur, form_data):
    form_data = form_data or {}

    vendors_raw = form_data.get("vendors")
    if isinstance(vendors_raw, str):
        try:
            vendors = json.loads(vendors_raw) if vendors_raw else []
        except ValueError:
            raise ValueError("Invalid vendors data: could not parse JSON.")
    else:
        vendors = vendors_raw or []
    if not isinstance(vendors, list):
        vendors = []

    new_name = _validate_item_name(form_data.get("itemName"))
    new_size = str(form_data.get("itemSize") or "").strip()
    remarks = str(form_data.get("itemRemarks") or "").strip()
    narration = str(form_data.get("itemNarration") or "").strip()
    spec = str(form_data.get("itemSpec") or "").strip()
    image = str(form_data.get("itemImage") or "").strip()
    if len(image) > 3_000_000:
        # Client-side resize (items.js, same canvas-resize approach as the
        # company logo) targets well under this -- a value this large means
        # something bypassed that resize, not a legitimate photo.
        raise ValueError("Item photo is too large. Please choose a smaller image.")
    if image and not image.startswith("data:image/"):
        # The only legitimate producer is canvas-resize, which always emits
        # a data:image/... URI -- anything else is not a photo (and, since
        # this value is rendered into an <img src="..."> on mobile, letting
        # arbitrary strings through here is a stored-XSS vector).
        raise ValueError("Item photo is not a valid image.")
    initial_stock = _validate_initial_stock(form_data.get("itemInitialStock"))
    base_unit = _validate_base_unit(form_data.get("itemBaseUnit"))
    purchase_unit = _validate_purchase_unit(form_data.get("itemPurchaseUnit"), base_unit)
    weight_per_base_unit = _validate_weight_per_base_unit(form_data.get("itemWeightPerBaseUnit"))

    is_edit = bool(form_data.get("originalName"))
    original_name = _validate_item_name(form_data.get("originalName")) if is_edit else new_name
    original_size = str(form_data.get("originalSize") or "").strip() if is_edit else new_size

    existing_id = _find_item(cur, original_name, original_size)

    # Identity-changed decisions use an exact (case-sensitive) compare,
    # matching the source -- a pure-casing rename ("Widget" -> "widget")
    # still counts as a rename, distinct from the case-insensitive
    # duplicate/lookup checks above and below.
    identity_changed = new_name != original_name or new_size != original_size

    if identity_changed:
        dupe_id = _find_item(cur, new_name, new_size)
        if dupe_id is not None and dupe_id != existing_id:
            dupe_msg = f'Duplicate: "{new_name}" with size "{new_size}" already exists.'
            if is_edit:
                # buildResponse() always nulls `data` on failure -- bypassed
                # here (matches the source) so the client can offer a
                # "merge into existing item" confirmation instead of just
                # blocking the save. targetStock sources from
                # erp.stock.initial_stock -- the best number available until
                # the real Current Stock view exists.
                return {
                    "success": False,
                    "data": {
                        "mergeable": True,
                        "targetName": new_name,
                        "targetSize": new_size,
                        "targetStock": _get_stock_initial(cur, new_name, new_size),
                        "targetVendorCount": _count_vendors(cur, dupe_id),
                    },
                    "message": dupe_msg,
                }
            raise ValueError(dupe_msg)
    elif not is_edit and existing_id is not None:
        raise ValueError(f'Duplicate: "{new_name}" with size "{new_size}" already exists.')

    if is_edit and existing_id is None:
        raise ValueError(
            f'Item "{original_name}" (size: "{original_size}") not found. '
            f"Edit aborted to prevent data inconsistency."
        )

    user_id = get_current_user_id()

    if is_edit:
        item_id = existing_id
        cur.execute(
            """
            UPDATE erp.items
            SET item_name = %s, size = %s, remarks = %s, narration = %s, specification = %s,
                base_unit = %s, purchase_unit = %s, weight_per_base_unit = %s, image = %s, updated_by = %s
            WHERE id = %s
            """,
            (new_name, new_size, remarks, narration, spec, base_unit, purchase_unit, weight_per_base_unit, image, user_id, item_id),
        )
        cur.execute("DELETE FROM erp.item_vendors WHERE item_id = %s", (item_id,))
    else:
        cur.execute(
            """
            INSERT INTO erp.items (item_name, size, remarks, narration, specification,
                base_unit, purchase_unit, weight_per_base_unit, image, updated_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (new_name, new_size, remarks, narration, spec, base_unit, purchase_unit, weight_per_base_unit, image, user_id),
        )
        item_id = cur.fetchone()["id"]

    for v in vendors:
        v = v or {}
        vendor_name = str(v.get("vendor") or "").strip()
        if not vendor_name:
            continue
        rate = _validate_vendor_rate(v.get("rate") or 0)
        cur.execute(
            "INSERT INTO erp.item_vendors (item_id, vendor, rate) VALUES (%s, %s, %s)",
            (item_id, vendor_name, rate),
        )

    # Keep Stock in sync (Item Name + Size as common key).
    if not is_edit:
        stock_rows.sync_stock_for_item(
            cur, "ensure", {"name": new_name, "size": new_size, "initialStock": initial_stock}
        )
    elif identity_changed:
        if _item_name_size_still_exists(cur, original_name, original_size):
            stock_rows.sync_stock_for_item(
                cur, "ensure", {"name": new_name, "size": new_size, "initialStock": initial_stock}
            )
        else:
            stock_rows.sync_stock_for_item(
                cur,
                "rename",
                {"oldName": original_name, "oldSize": original_size, "newName": new_name, "newSize": new_size},
            )
            _propagate_item_identity_change(cur, original_name, original_size, new_name, new_size)
    else:
        # Plain edit (identity unchanged) -- backfills a missing Stock row
        # for orphaned items. No-ops if a Stock row already exists.
        stock_rows.sync_stock_for_item(
            cur, "ensure", {"name": new_name, "size": new_size, "initialStock": initial_stock}
        )

    # Include the item's identity in the toast so the user can tell which row
    # was affected -- plain "Item updated successfully." was ambiguous on a
    # page with a freshly-patched list of many items (reference: module_items.js
    # saveItem, commit e37529e).
    item_label = f'"{new_name}"' + (f" ({new_size})" if new_size else "")
    message = f"Item {item_label} updated successfully." if is_edit else f"Item {item_label} added successfully."

    # Read this item's own just-written row back so the client can patch it
    # into an already-loaded list in place instead of a full reload.
    fresh_item = _fetch_item_record(cur, item_id)

    return build_response(True, {"name": new_name, "size": new_size, "item": fresh_item}, message)


@rpc_method("deleteItem", mutation=True)
@database.transactional
def delete_item(conn, cur, name, size=""):
    valid_name = _validate_item_name(name)
    valid_size = str(size or "").strip()

    item_id = _find_item(cur, valid_name, valid_size)
    if item_id is None:
        raise ValueError(f'Item "{valid_name}" (size: "{valid_size}") not found.')

    in_use_key = f"{valid_name.lower()}|{valid_size.lower()}"
    if in_use_key in _get_item_keys_in_use(cur, [{"name": valid_name, "size": valid_size}]):
        size_suffix = f" ({valid_size})" if valid_size else ""
        raise ValueError(f'Cannot delete "{valid_name}"{size_suffix}: referenced by a Product\'s BOM, a Process recipe, or a Stock Group.')

    cur.execute(
        "UPDATE erp.items SET deleted_at = NOW(), updated_by = %s WHERE id = %s",
        (get_current_user_id(), item_id),
    )

    if not _item_name_size_still_exists(cur, valid_name, valid_size):
        stock_rows.sync_stock_for_item(cur, "remove", {"name": valid_name, "size": valid_size})

    return build_response(True, None, f'Item "{valid_name}" deleted successfully.')


@rpc_method("deleteItemsBulk", mutation=True)
@database.transactional
def delete_items_bulk(conn, cur, items):
    requested = [
        {"name": str((it or {}).get("name") or "").strip(), "size": str((it or {}).get("size") or "").strip()}
        for it in (items or [])
    ]
    requested = [it for it in requested if it["name"]]

    if not requested:
        return build_response(True, None, "No items to delete.")

    def key_of(it: dict) -> str:
        return f'{it["name"].lower()}|{it["size"].lower()}'

    in_use_keys = _get_item_keys_in_use(cur, requested)
    skipped = [it for it in requested if key_of(it) in in_use_keys]
    deletable = [it for it in requested if key_of(it) not in in_use_keys]

    user_id = get_current_user_id()
    deleted_items = []
    for it in deletable:
        item_id = _find_item(cur, it["name"], it["size"])
        if item_id is None:
            continue
        cur.execute("UPDATE erp.items SET deleted_at = NOW(), updated_by = %s WHERE id = %s", (user_id, item_id))
        deleted_items.append(it)

    for it in deleted_items:
        if not _item_name_size_still_exists(cur, it["name"], it["size"]):
            stock_rows.sync_stock_for_item(cur, "remove", {"name": it["name"], "size": it["size"]})

    message = f"Successfully deleted {len(deleted_items)} item(s) from master."
    if skipped:
        labels = [f'{it["name"]} ({it["size"]})' if it["size"] else it["name"] for it in skipped]
        message += (
            f" Skipped {len(skipped)} item(s) referenced by a Product's BOM, a Process recipe, or a Stock Group: "
            f"{', '.join(labels)}."
        )

    return build_response(True, {"deletedItems": deleted_items, "skipped": skipped}, message)


def _import_items_from_stock(cur) -> dict:
    """Reads erp.stock, inserts a vendor-less erp.items row for any
    (name,size) not already present -- the reverse direction of
    stock_rows.sync_stock_for_item.

    Plain cur-based helper, not its own transaction, so callers already
    holding a transaction (e.g. stock_service.import_stock_data) see rows
    they just inserted in the same call. The RPC-exposed
    import_items_from_stock() below wraps this with its own transaction for
    standalone calls.
    """
    cur.execute("SELECT item_name, size FROM erp.stock WHERE deleted_at IS NULL")
    stock_rows_ = cur.fetchall()

    cur.execute("SELECT lower(item_name) AS name, lower(size) AS size FROM erp.items WHERE deleted_at IS NULL")
    existing_keys = {f'{r["name"]}|{r["size"]}' for r in cur.fetchall()}

    added = 0
    skipped = 0
    user_id = get_current_user_id()

    for row in stock_rows_:
        name = str(row["item_name"] or "").strip()
        size = str(row["size"] or "").strip()
        if not name:
            continue

        key = f"{name.lower()}|{size.lower()}"
        if key in existing_keys:
            skipped += 1
            continue

        cur.execute(
            "INSERT INTO erp.items (item_name, size, updated_by) VALUES (%s, %s, %s)",
            (name, size, user_id),
        )
        existing_keys.add(key)
        added += 1

    if added > 0:
        message = f"Imported {added} item(s) from Stock. {skipped} already existed and were skipped."
    else:
        message = f"All {skipped} Stock item(s) already exist in Item Master. Nothing new to import."

    return build_response(True, {"added": added, "skipped": skipped}, message)


@rpc_method("importItemsFromStock", mutation=True)
@database.transactional
def import_items_from_stock(conn, cur):
    return _import_items_from_stock(cur)


def _auto_extract_item(cur, name: str, size: str, narration: str, unit: str, vendor_name: str, rate) -> int:
    """The item-upsert half of module_vendors.js's autoExtractFromPoOrBill.
    Plain cur-based helper (not its own transaction) -- callers (PO/Bill
    save) run this inside their own transaction.

    - New item: created with `unit` as both Base Unit and Purchase Unit (no
      prior Base Unit to convert against, so this is an identity no-op until
      the user edits it) plus this vendor/rate pair, and a Stock row is
      ensured for it. `narration` seeds the item's own Narration -- it would
      otherwise have none at all for Production to resolve against.
    - Existing item: `narration` overwrites the item's REMARKS (not its
      Narration), so Remarks always reflects the latest purchase-side
      description -- Narration is the hand-maintained note Production prints
      and resolves against, and a vendor's wording overwriting it would
      change printed production sheets. Purchase Unit is kept synced to
      whatever unit was actually used on this line; this vendor's rate is
      inserted or updated (existing rates for other vendors are untouched).

    Returns the item's id.
    """
    name = (name or "").strip()
    size = (size or "").strip()
    narration = (narration or "").strip()
    unit = (unit or "").strip() or "Pcs"
    vendor_name = (vendor_name or "").strip()

    item_id = _find_item(cur, name, size)

    if item_id is None:
        cur.execute(
            """
            INSERT INTO erp.items (item_name, size, narration, base_unit, purchase_unit)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING id
            """,
            (name, size, narration, unit, unit),
        )
        item_id = cur.fetchone()["id"]
        stock_rows.sync_stock_for_item(cur, "ensure", {"name": name, "size": size})
    else:
        cur.execute("SELECT remarks, purchase_unit FROM erp.items WHERE id = %s", (item_id,))
        row = cur.fetchone()
        if narration and narration != (row["remarks"] or "").strip():
            cur.execute("UPDATE erp.items SET remarks = %s WHERE id = %s", (narration, item_id))
        if unit and unit != (row["purchase_unit"] or ""):
            cur.execute("UPDATE erp.items SET purchase_unit = %s WHERE id = %s", (unit, item_id))

    if vendor_name:
        cur.execute(
            "SELECT id FROM erp.item_vendors WHERE item_id = %s AND lower(vendor) = lower(%s)",
            (item_id, vendor_name),
        )
        vendor_row = cur.fetchone()
        if vendor_row is None:
            cur.execute(
                "INSERT INTO erp.item_vendors (item_id, vendor, rate) VALUES (%s, %s, %s)",
                (item_id, vendor_name, rate),
            )
        else:
            cur.execute("UPDATE erp.item_vendors SET rate = %s WHERE id = %s", (rate, vendor_row["id"]))


# ─────────────────────────────────────────────────────────────────────────
# Data hygiene: orphan Stock rows + duplicate/merge tooling
# ─────────────────────────────────────────────────────────────────────────


def _convert_vendor_rate_across_items(rate, source_info: dict, target_info: dict, units_map: dict) -> float:
    """A vendor rate is quoted per the item's Purchase Unit -- carrying it
    across a merge/edit-collision without conversion silently misreads it
    when the two items don't share a Purchase Unit (e.g. a per-Dozen rate
    copied onto a per-Pcs row is read 12x wrong). Converts `rate` (quoted
    per source_info['purchaseUnit']) into a rate quoted per
    target_info['purchaseUnit'].
    """
    if source_info.get("purchaseUnit") == target_info.get("purchaseUnit"):
        return float(rate or 0)
    rate_per_target_base_unit = units_service.convert_rate_to_base_unit(
        rate, source_info.get("purchaseUnit"), target_info, units_map
    )
    base_units_per_target_purchase_unit = units_service.convert_qty_to_base_unit(
        1, target_info.get("purchaseUnit"), target_info, units_map
    )
    return rate_per_target_base_unit * base_units_per_target_purchase_unit


def _add_vendors_skip_existing(
    cur, item_id, vendors: list, *, source_info: dict | None = None, target_info: dict | None = None
) -> None:
    """Adds each of `vendors` ({"vendor", "rate"}) to `item_id`, skipping any
    vendor name already present (case-insensitive) -- shared by every merge
    path below so a merge never clobbers an existing vendor's rate with an
    incoming one.

    When `source_info`/`target_info` are given, each rate is first converted
    from the source item's Purchase Unit into the target's (see
    _convert_vendor_rate_across_items) so a merge across items with
    different Purchase Units doesn't silently attach a misscaled rate.
    """
    cur.execute("SELECT vendor FROM erp.item_vendors WHERE item_id = %s", (item_id,))
    existing = {(row["vendor"] or "").strip().lower() for row in cur.fetchall()}
    units_map = units_service.get_units_map(cur) if source_info and target_info else None
    for v in vendors or []:
        v = v or {}
        vendor_name = str(v.get("vendor") or "").strip()
        if not vendor_name or vendor_name.lower() in existing:
            continue
        rate = _validate_vendor_rate(v.get("rate") or 0)
        if source_info and target_info:
            rate = _validate_vendor_rate(
                _convert_vendor_rate_across_items(rate, source_info, target_info, units_map)
            )
        cur.execute(
            "INSERT INTO erp.item_vendors (item_id, vendor, rate) VALUES (%s, %s, %s)",
            (item_id, vendor_name, rate),
        )
        existing.add(vendor_name.lower())


def _merge_stock_and_delete(cur, keep_name: str, keep_size: str, remove_name: str, remove_size: str, remove_id) -> None:
    """The tail every merge shares once vendors/text fields are settled:
    combine Stock (stock_rows' own "merge" action), re-point PO/Bill/BOM/
    Process Component references via the same cascade saveItem's own
    identity-change path uses, then soft-delete the losing item row.
    """
    stock_rows.sync_stock_for_item(
        cur, "merge",
        {"oldName": remove_name, "oldSize": remove_size, "newName": keep_name, "newSize": keep_size},
    )
    _propagate_item_identity_change(cur, remove_name, remove_size, keep_name, keep_size)
    cur.execute(
        "UPDATE erp.items SET deleted_at = NOW(), updated_by = %s WHERE id = %s",
        (get_current_user_id(), remove_id),
    )


def _merge_item_records(
    cur, keep_id, keep_name: str, keep_size: str, remove_id, remove_name: str, remove_size: str,
    *, merge_text_fields: bool,
) -> None:
    """Folds `remove` into `keep`: optionally fills any of keep's blank
    remarks/narration/specification from remove's, merges vendors, merges
    Stock, re-points references, then soft-deletes `remove`.
    """
    if merge_text_fields:
        cur.execute("SELECT remarks, narration, specification FROM erp.items WHERE id = %s", (keep_id,))
        keep_row = cur.fetchone()
        cur.execute("SELECT remarks, narration, specification FROM erp.items WHERE id = %s", (remove_id,))
        remove_row = cur.fetchone()
        cur.execute(
            """
            UPDATE erp.items SET remarks = %s, narration = %s, specification = %s, updated_by = %s
            WHERE id = %s
            """,
            (
                (keep_row["remarks"] or "").strip() or (remove_row["remarks"] or "").strip(),
                (keep_row["narration"] or "").strip() or (remove_row["narration"] or "").strip(),
                (keep_row["specification"] or "").strip() or (remove_row["specification"] or "").strip(),
                get_current_user_id(),
                keep_id,
            ),
        )

    unit_map = get_item_unit_info_map(cur)
    source_info = lookup_item_unit_info(unit_map, remove_name, remove_size)
    target_info = lookup_item_unit_info(unit_map, keep_name, keep_size)

    cur.execute("SELECT vendor, rate FROM erp.item_vendors WHERE item_id = %s", (remove_id,))
    _add_vendors_skip_existing(cur, keep_id, cur.fetchall(), source_info=source_info, target_info=target_info)

    _merge_stock_and_delete(cur, keep_name, keep_size, remove_name, remove_size, remove_id)


@rpc_method("keepOrphanItem", mutation=True)
@database.transactional
def keep_orphan_item(conn, cur, name, size="", initial_stock=0):
    """An orphan is an Item Master row with no matching Stock row (by Name +
    Size) -- "Keep" just backfills that missing Stock row via the same
    stock_rows "ensure" action saveItem itself uses for a plain edit.
    """
    valid_name = _validate_item_name(name)
    valid_size = str(size or "").strip()
    if _find_item(cur, valid_name, valid_size) is None:
        raise ValueError(f'Item "{valid_name}" (size: "{valid_size}") not found in Item Master.')

    stock_rows.sync_stock_for_item(
        cur, "ensure",
        {"name": valid_name, "size": valid_size, "initialStock": _validate_initial_stock(initial_stock)},
    )
    return build_response(True, None, f'Stock row created for "{valid_name}".')


@rpc_method("keepOrphanItemsBulk", mutation=True)
@database.transactional
def keep_orphan_items_bulk(conn, cur, rows):
    requested = [
        {
            "name": str((r or {}).get("name") or "").strip(),
            "size": str((r or {}).get("size") or "").strip(),
            "initialStock": _validate_initial_stock((r or {}).get("initialStock")),
        }
        for r in (rows or [])
    ]
    requested = [r for r in requested if r["name"]]
    if not requested:
        return build_response(True, None, "No items to keep.")

    created = 0
    for r in requested:
        if _find_item(cur, r["name"], r["size"]) is None:
            continue
        stock_rows.sync_stock_for_item(cur, "ensure", r)
        created += 1

    return build_response(True, {"created": created}, f"Created {created} Stock row(s).")


@rpc_method("mergeSelectedItems", mutation=True)
@database.transactional
def merge_selected_items(conn, cur, selected):
    """selected = [keep, remove] (exactly 2, in that order -- matches the
    frontend's own `const [keep, remove] = selected`). `keep` survives with
    combined Stock/vendors/remarks/narration/spec; `remove` is deleted and
    any PO/Bill/BOM rows referencing it are re-pointed to `keep`.
    """
    selected = selected or []
    if len(selected) != 2:
        raise ValueError("Exactly 2 items must be selected to merge.")

    keep_in, remove_in = selected[0] or {}, selected[1] or {}
    keep_name = _validate_item_name(keep_in.get("name"))
    keep_size = str(keep_in.get("size") or "").strip()
    remove_name = _validate_item_name(remove_in.get("name"))
    remove_size = str(remove_in.get("size") or "").strip()

    keep_id = _find_item(cur, keep_name, keep_size)
    remove_id = _find_item(cur, remove_name, remove_size)
    if keep_id is None:
        raise ValueError(f'Item "{keep_name}" (size: "{keep_size}") not found.')
    if remove_id is None:
        raise ValueError(f'Item "{remove_name}" (size: "{remove_size}") not found.')
    if keep_id == remove_id:
        raise ValueError("Cannot merge an item into itself.")

    _merge_item_records(cur, keep_id, keep_name, keep_size, remove_id, remove_name, remove_size, merge_text_fields=True)

    return build_response(True, {"name": keep_name, "size": keep_size}, f'Merged "{remove_name}" into "{keep_name}".')


@rpc_method("mergeItemEdit", mutation=True)
@database.transactional
def merge_item_edit(conn, cur, form_data):
    """Called after saveItem rejects an edit as a duplicate (its `mergeable`
    response) -- the item being edited (originalName/originalSize) is merged
    into the pre-existing target it collided with (itemName/itemSize). Only
    "this edit's vendors" (the submitted form's list, not the original's own
    stored vendors) are added to the target, matching the confirm dialog's
    exact promise; Stock is combined and references are re-pointed the same
    way every other merge here does it.
    """
    form_data = form_data or {}

    vendors_raw = form_data.get("vendors")
    if isinstance(vendors_raw, str):
        try:
            vendors = json.loads(vendors_raw) if vendors_raw else []
        except ValueError:
            raise ValueError("Invalid vendors data: could not parse JSON.")
    else:
        vendors = vendors_raw or []
    if not isinstance(vendors, list):
        vendors = []

    target_name = _validate_item_name(form_data.get("itemName"))
    target_size = str(form_data.get("itemSize") or "").strip()
    original_name = _validate_item_name(form_data.get("originalName"))
    original_size = str(form_data.get("originalSize") or "").strip()

    target_id = _find_item(cur, target_name, target_size)
    if target_id is None:
        raise ValueError(f'Item "{target_name}" (size: "{target_size}") not found.')

    original_id = _find_item(cur, original_name, original_size)
    if original_id is None:
        raise ValueError(f'Item "{original_name}" (size: "{original_size}") not found.')
    if original_id == target_id:
        raise ValueError("Cannot merge an item into itself.")

    unit_map = get_item_unit_info_map(cur)
    source_info = lookup_item_unit_info(unit_map, original_name, original_size)
    target_info = lookup_item_unit_info(unit_map, target_name, target_size)

    _add_vendors_skip_existing(cur, target_id, vendors, source_info=source_info, target_info=target_info)
    _merge_stock_and_delete(cur, target_name, target_size, original_name, original_size, original_id)

    return build_response(True, {"name": target_name, "size": target_size}, f'Merged into "{target_name}".')


# Truncated/typo auto-fix only folds a shorter name into a longer one when
# the pairing can't be confused with anything else in the same size group --
# no source spec exists for this tool's exact matching rule (the Apps
# Script reference isn't checked out here), so this stays deliberately
# conservative (small length gap, exactly one candidate on each side)
# rather than risk silently merging two genuinely different items that
# happen to share a text prefix (e.g. "Screw" / "Screwdriver").
_TRUNCATION_MAX_LENGTH_GAP = 4
_TRUNCATION_MIN_PREFIX_LENGTH = 3


def _find_unambiguous_truncated_pairs(cur) -> list:
    """[(shorter_row, longer_row), ...] for every (name, size) pair in the
    same size group where the shorter name is a case-insensitive prefix of
    the longer one, the length gap is small, and neither row participates
    in any other such pairing.
    """
    cur.execute(
        "SELECT id, item_name, size FROM erp.items WHERE deleted_at IS NULL ORDER BY lower(size), length(item_name)"
    )
    by_size: dict = {}
    for row in cur.fetchall():
        by_size.setdefault((row["size"] or "").strip().lower(), []).append(row)

    pairs = []
    for rows in by_size.values():
        if len(rows) < 2:
            continue
        shorter_matches: dict = {}
        longer_matches: dict = {}
        for a in rows:
            name_a = (a["item_name"] or "").strip()
            if len(name_a) < _TRUNCATION_MIN_PREFIX_LENGTH:
                continue
            for b in rows:
                if a["id"] == b["id"]:
                    continue
                name_b = (b["item_name"] or "").strip()
                if len(name_b) <= len(name_a) or len(name_b) - len(name_a) > _TRUNCATION_MAX_LENGTH_GAP:
                    continue
                if not name_b.lower().startswith(name_a.lower()):
                    continue
                shorter_matches.setdefault(a["id"], []).append(b)
                longer_matches.setdefault(b["id"], []).append(a)

        for short_id, candidates in shorter_matches.items():
            if len(candidates) != 1:
                continue
            long_row = candidates[0]
            if len(longer_matches.get(long_row["id"], [])) != 1:
                continue
            pairs.append((next(r for r in rows if r["id"] == short_id), long_row))

    return pairs


@rpc_method("runScheduledItemCleanup", mutation=True, roles=frozenset({"admin"}))
@database.transactional
def run_scheduled_item_cleanup(conn, cur):
    """(1) auto-fixes unambiguous truncated/typo-prefix duplicates (see
    _find_unambiguous_truncated_pairs), then (2) merges any rows left
    sharing the exact same Name + Size -- matches the confirm dialog's own
    two-phase description exactly.
    """
    fixed = 0
    for short_row, long_row in _find_unambiguous_truncated_pairs(cur):
        short_name = (short_row["item_name"] or "").strip()
        long_name = (long_row["item_name"] or "").strip()
        size = (long_row["size"] or "").strip()
        _merge_item_records(cur, long_row["id"], long_name, size, short_row["id"], short_name, size, merge_text_fields=True)
        fixed += 1

    # Ordered by id (creation order), not name -- a whitespace-padded
    # duplicate (e.g. " Foo " vs "Foo", both invisible to the DB's own
    # untrimmed unique index but the same item once app-level .strip() is
    # applied) must never win survivorship over the clean original just
    # because leading whitespace sorts first alphabetically.
    cur.execute("SELECT id, item_name, size FROM erp.items WHERE deleted_at IS NULL ORDER BY id")
    merged = 0
    seen: dict = {}
    for row in cur.fetchall():
        key = f'{(row["item_name"] or "").strip().lower()}|{(row["size"] or "").strip().lower()}'
        if key not in seen:
            seen[key] = row
            continue
        keep = seen[key]
        _merge_item_records(
            cur, keep["id"], keep["item_name"], keep["size"] or "",
            row["id"], row["item_name"], row["size"] or "",
            merge_text_fields=True,
        )
        merged += 1

    if fixed == 0 and merged == 0:
        message = "No duplicates found. Item Master is already clean."
    else:
        message = f"Auto-fixed {fixed} truncated/typo duplicate(s) and merged {merged} exact duplicate(s)."

    return build_response(True, {"autoFixed": fixed, "merged": merged}, message)


# ─────────────────────────────────────────────────────────────────────────
# Item Ledger
# ─────────────────────────────────────────────────────────────────────────


def _ledger_entry(date_value, entry_type, kind, ref, party, size, narration, **kwargs) -> dict:
    entry = {
        "date": date_utils.to_display_string(date_value) or "",
        "dateRaw": date_utils.to_iso_string(date_value) or "",
        "type": entry_type,
        "kind": kind,
        "ref": ref or "",
        "party": party or "",
        "size": size or "",
        "narration": narration or "",
        "orderQty": 0.0,
        "incomingQty": 0.0,
        "outgoingQty": 0.0,
        "price": None,
        "unit": "",
        "enteredQty": None,
        # Stock on hand for this size immediately after this row, filled in
        # by get_item_ledger_data once every entry is known and ordered.
        # None on rows that move no stock -- see countsTowardStock below.
        "balance": None,
        # Whether this row is part of the Current Stock arithmetic. False for
        # rows that are informational only (a PO is an intent to buy, not a
        # receipt; a manual adjustment is already absorbed into initial_stock
        # -- see the reconciliation note in get_item_ledger_data).
        "countsTowardStock": True,
    }
    entry.update(kwargs)
    return entry


@rpc_method("getItemLedgerData")
def get_item_ledger_data(item_name):
    """Every stock movement for one Items Master name, across all its size
    variants, in BASE UNITS -- computed server-side from the exact same
    terms, signs and unit conversions as the Current Stock formula
    (_get_billed_and_consumed_qty_maps), so the ledger reconciles with the
    Stock page by construction rather than by two implementations happening
    to agree.

    This exists because the Item Ledger was previously assembled entirely
    client-side (items.js#getLedgerData) from whatever collections the
    browser happened to have loaded, which made it wrong in three ways at
    once: Production consumption was reconstructed from the BOM recipe
    instead of the lot's real components_consumed (see
    _iter_completed_production_components), Wastage and Issue -- two full
    terms of the Stock formula -- were missing from the history entirely,
    and quantities were shown as-entered rather than in base units, so a
    line entered in Dozen displayed 1 while moving 12 units of stock.

    `countsTowardStock` marks which rows participate in the arithmetic:

    - A Bill line with affects_stock = FALSE ("Ledger only", chosen in the
      stock-adjustment conflict flow) is shown but excluded, matching the
      Stock formula's own affects_stock filter.
    - A PO row is an order, not a movement -- shown for context in the
      Order Qty column, never counted.
    - A manual Stock Adjustment is NOT a movement either, despite reading
      like one. adjust_stock_manually rewrites initial_stock to
      (new_stock - billed + consumed), so an adjustment is already fully
      absorbed into the initialStock the reconciliation starts from.
      Counting its delta again would double-apply it -- these rows are
      history annotations, and `reconciliation` proves the balance without
      them.

    The returned `reconciliation` block does that proof per size variant:
    initialStock + incoming - outgoing (counted rows only) must equal the
    currentStock the Stock page shows for the same variant, and `balanced`
    reports whether it does.
    """
    # Local import: stock_service imports THIS module, so a module-level
    # import would be circular -- same precedent as stock_rows.py's own
    # deferred items_service/units_service imports.
    from . import stock_service

    target = str(item_name or "").strip()
    if not target:
        return build_response(True, {"itemName": "", "entries": [], "reconciliation": []})
    target_lower = target.lower()

    entries: list = []

    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        # Bill: the one term that ADDS to stock.
        cur.execute(
            """
            SELECT h.bill_number, h.bill_date, h.vendor, l.size, l.narration,
                   l.qty, l.unit, l.base_qty, l.base_rate, l.affects_stock
            FROM erp.bill_lines l
            JOIN erp.bill_headers h ON h.id = l.header_id
            WHERE h.deleted_at IS NULL AND lower(btrim(l.item_name)) = %s
            """,
            (target_lower,),
        )
        for row in cur.fetchall():
            affects_stock = bool(row["affects_stock"])
            entries.append(
                _ledger_entry(
                    row["bill_date"],
                    "Bill Received" if affects_stock else "Bill (Ledger only)",
                    "BILL",
                    row["bill_number"],
                    row["vendor"],
                    row["size"],
                    row["narration"],
                    incomingQty=float(row["base_qty"] or 0),
                    price=float(row["base_rate"] or 0),
                    unit=row["unit"] or "",
                    enteredQty=float(row["qty"] or 0),
                    countsTowardStock=affects_stock,
                )
            )

        # Return / Wastage / Issue: all three DEBIT stock, same direction.
        cur.execute(
            """
            SELECT h.return_number, h.return_date, h.vendor, l.size, l.narration,
                   l.qty, l.unit, l.base_qty, l.base_rate
            FROM erp.return_lines l
            JOIN erp.return_headers h ON h.id = l.header_id
            WHERE h.deleted_at IS NULL AND lower(btrim(l.item_name)) = %s
            """,
            (target_lower,),
        )
        for row in cur.fetchall():
            entries.append(
                _ledger_entry(
                    row["return_date"], "Goods Returned", "RETURN",
                    row["return_number"], row["vendor"], row["size"], row["narration"],
                    outgoingQty=float(row["base_qty"] or 0),
                    price=float(row["base_rate"] or 0),
                    unit=row["unit"] or "",
                    enteredQty=float(row["qty"] or 0),
                )
            )

        cur.execute(
            """
            SELECT h.wastage_id, h.wastage_date, h.vendor, l.size, l.reason,
                   l.qty, l.unit, l.base_qty
            FROM erp.wastage_lines l
            JOIN erp.wastage_headers h ON h.id = l.header_id
            WHERE h.deleted_at IS NULL AND lower(btrim(l.item_name)) = %s
            """,
            (target_lower,),
        )
        for row in cur.fetchall():
            entries.append(
                _ledger_entry(
                    row["wastage_date"], "Wastage", "WASTAGE",
                    row["wastage_id"], row["vendor"], row["size"], row["reason"],
                    outgoingQty=float(row["base_qty"] or 0),
                    unit=row["unit"] or "",
                    enteredQty=float(row["qty"] or 0),
                )
            )

        cur.execute(
            """
            SELECT h.issue_id, h.issue_date, h.issued_to, h.reference, l.size,
                   l.qty, l.unit, l.base_qty, l.rate
            FROM erp.issue_lines l
            JOIN erp.issue_headers h ON h.id = l.header_id
            WHERE h.deleted_at IS NULL AND lower(btrim(l.item_name)) = %s
            """,
            (target_lower,),
        )
        for row in cur.fetchall():
            entries.append(
                _ledger_entry(
                    row["issue_date"], "Stock Issued", "ISSUE",
                    row["issue_id"], row["issued_to"], row["size"], row["reference"],
                    outgoingQty=float(row["base_qty"] or 0),
                    price=float(row["rate"] or 0),
                    unit=row["unit"] or "",
                    enteredQty=float(row["qty"] or 0),
                )
            )

        # Production: the lot's OWN recorded consumption, every process
        # stage -- not a BOM estimate, and not final-stage lots only.
        for comp in stock_service._iter_completed_production_components(cur):
            if comp["itemName"].strip().lower() != target_lower:
                continue
            source = comp["productName"] or comp["outputItemName"] or comp["processId"] or "Production"
            entries.append(
                _ledger_entry(
                    comp["productionDate"], "Production Consumption", "PRODUCTION",
                    comp["lotNumber"], source, comp["size"], comp["processId"],
                    outgoingQty=comp["baseQty"],
                    unit=comp["unit"],
                    enteredQty=comp["enteredQty"],
                )
            )

        # PO: informational only (an order, not a movement).
        cur.execute(
            """
            SELECT h.po_number, h.po_date, h.vendor, l.size, l.narration, l.qty, l.unit, l.base_qty, l.base_rate
            FROM erp.po_lines l
            JOIN erp.po_headers h ON h.id = l.header_id
            WHERE h.deleted_at IS NULL AND lower(btrim(l.item_name)) = %s
            """,
            (target_lower,),
        )
        for row in cur.fetchall():
            entries.append(
                _ledger_entry(
                    row["po_date"], "PO Issued", "PO",
                    f'PO-{row["po_number"]}', row["vendor"], row["size"], row["narration"],
                    orderQty=float(row["base_qty"] or 0),
                    price=float(row["base_rate"] or 0),
                    unit=row["unit"] or "",
                    enteredQty=float(row["qty"] or 0),
                    countsTowardStock=False,
                )
            )

        # Manual adjustments: informational -- already absorbed into
        # initial_stock, see this function's docstring.
        cur.execute(
            """
            SELECT sa.size, sa.action, sa.old_value, sa.new_value, sa.reason, sa.created_at,
                   u.email AS user_email
            FROM erp.stock_adjustments sa
            LEFT JOIN public.users u ON u.user_id = sa.created_by
            WHERE lower(btrim(sa.item_name)) = %s
            """,
            (target_lower,),
        )
        for row in cur.fetchall():
            delta = float(row["new_value"] or 0) - float(row["old_value"] or 0)
            is_reset = str(row["action"] or "").strip().upper() == "RESET"
            entries.append(
                _ledger_entry(
                    row["created_at"],
                    "Stock Reset" if is_reset else "Manual Adjustment",
                    "ADJUSTMENT",
                    "-",
                    row["user_email"] or "System",
                    row["size"],
                    row["reason"],
                    incomingQty=delta if delta > 0 else 0.0,
                    outgoingQty=-delta if delta < 0 else 0.0,
                    countsTowardStock=False,
                )
            )

        # Reconciliation, per size variant, against the very same maps
        # get_stock_data renders from.
        bill_qty_map, consumed_qty_map = stock_service._get_billed_and_consumed_qty_maps(cur)
        cur.execute(
            """
            SELECT item_name, size, initial_stock, threshold
            FROM erp.stock
            WHERE deleted_at IS NULL AND lower(btrim(item_name)) = %s
            ORDER BY size
            """,
            (target_lower,),
        )
        stock_rows_found = cur.fetchall()

    reconciliation = []
    for row in stock_rows_found:
        size = (row["size"] or "").strip()
        key = f'{row["item_name"].strip().lower()}|{size.lower()}'
        initial = float(row["initial_stock"])
        current = initial + bill_qty_map.get(key, 0) - consumed_qty_map.get(key, 0)

        size_lower = size.lower()
        counted = [
            e for e in entries
            if e["countsTowardStock"] and (e["size"] or "").strip().lower() == size_lower
        ]
        incoming = sum(e["incomingQty"] for e in counted)
        outgoing = sum(e["outgoingQty"] for e in counted)
        computed = initial + incoming - outgoing

        reconciliation.append(
            {
                "size": size,
                "initialStock": initial,
                "incomingQty": incoming,
                "outgoingQty": outgoing,
                "computedStock": computed,
                "currentStock": current,
                "threshold": float(row["threshold"]),
                "isLowStock": current < float(row["threshold"]),
                # Any drift here means a movement exists that the Stock
                # formula counts (or doesn't) differently from this ledger --
                # surfaced rather than hidden, so it can't go unnoticed.
                "balanced": abs(computed - current) < 0.0001,
            }
        )

    # Running stock balance, per size variant.
    #
    # Computed here rather than in items.js for the reason the whole ledger
    # moved server-side: the balance has to start from the same
    # initial_stock, count the same rows and apply the same signs as the
    # Current Stock formula, or it is a second implementation that merely
    # happens to agree. Doing it beside `reconciliation` -- which already
    # holds each size's initial_stock and proves initial + in - out ==
    # currentStock -- makes the last row's balance the same arithmetic that
    # block asserts, so a drift shows up as `balanced: false` rather than as
    # a quietly wrong column.
    #
    # Accumulated oldest-first, then re-sorted newest-first for display,
    # matching get_contractor_account_ledger and get_warehouse_pool_ledger.
    initial_by_size = {
        (row["size"] or "").strip().lower(): float(row["initial_stock"])
        for row in stock_rows_found
    }
    entries_by_size: dict = {}
    for entry in entries:
        entries_by_size.setdefault(
            (entry["size"] or "").strip().lower(), []
        ).append(entry)

    for size_lower, group in entries_by_size.items():
        group.sort(key=lambda e: (e["dateRaw"] or "", e["type"]))
        # A size with movements but no erp.stock row opens at zero rather
        # than being skipped: its rows still need a balance, and starting
        # from nothing is the honest reading of "no opening stock recorded".
        running = initial_by_size.get(size_lower, 0.0)
        for entry in group:
            if entry["countsTowardStock"]:
                running += entry["incomingQty"] - entry["outgoingQty"]
                entry["balance"] = running
            else:
                # A PO, a "Ledger only" bill or a manual adjustment moved no
                # stock, so it has no balance to report. Deliberately None
                # and not the carried-forward figure: repeating the previous
                # row's number here reads as "this row settled at that
                # balance", which is the one thing these rows did not do.
                entry["balance"] = None

    entries.sort(key=lambda e: (e["dateRaw"] or "", e["type"]), reverse=True)

    return build_response(True, {"itemName": target, "entries": entries, "reconciliation": reconciliation})
