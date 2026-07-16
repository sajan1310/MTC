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

Deferred: mergeItemEdit, mergeSelectedItems, keepOrphanItem(sBulk),
autoMergeDuplicateItems, autoFixTruncatedDuplicateItems,
runScheduledItemCleanup -- data hygiene tooling, not core CRUD; their own
round later. importItemsFromStock (module_items.js:1928) is ported below,
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
from . import rename_utils
from . import stock_rows
from . import units_service
from .current_user import get_current_user_id
from .. import config_maps
from ..envelope import build_response
from ..registry import rpc_method


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
    cur.execute("SELECT COUNT(*) AS n FROM erp.item_vendors WHERE item_id = %s", (item_id,))
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


def _propagate_item_identity_change(cur, old_name: str, old_size: str, new_name: str, new_size: str) -> None:
    for sheet_key in ("PO_LINES", "BILL_LINES", "BOM_LINES"):
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


def _get_item_keys_in_use(cur, items: list) -> set:
    """"nameLower|sizeLower" keys referenced by a BOM component row or an
    ITEM-sourced Process Components row -- unsafe to delete. Guarded via
    config_maps.TABLE_NAMES exactly like Phase 1a's rename cascades; both
    targets are real as of Phase 3c (BOM) and Phase 3a (Process Components).
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

    return in_use


# ─────────────────────────────────────────────────────────────────────────
# RPC methods
# ─────────────────────────────────────────────────────────────────────────


@rpc_method("getItemsData")
def get_items_data():
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        cur.execute(
            """
            SELECT id, item_name, size, remarks, narration, specification,
                   base_unit, purchase_unit, weight_per_base_unit
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

    units_map = units_service.get_units_map()

    items = []
    for row in item_rows:
        base_unit = row["base_unit"] or "Pcs"
        purchase_unit = row["purchase_unit"] or base_unit
        weight_per_base_unit = float(row["weight_per_base_unit"] or 0)
        item_for_conversion = {"baseUnit": base_unit, "weightPerBaseUnit": weight_per_base_unit}

        vendors = []
        for v in vendors_by_item.get(row["id"], []):
            rate = float(v["rate"])
            try:
                rate_per_base_unit = units_service.convert_rate_to_base_unit(
                    rate, purchase_unit, item_for_conversion, units_map
                )
            except ValueError:
                rate_per_base_unit = rate
            vendors.append({"vendor": v["vendor"], "rate": rate, "ratePerBaseUnit": rate_per_base_unit})

        items.append(
            {
                "name": row["item_name"],
                "size": row["size"] or "",
                "remarks": row["remarks"] or "",
                "narration": row["narration"] or "",
                "specification": row["specification"] or "",
                "baseUnit": base_unit,
                "purchaseUnit": purchase_unit,
                "weightPerBaseUnit": weight_per_base_unit,
                "vendors": vendors,
            }
        )

    return build_response(True, items)


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
                base_unit = %s, purchase_unit = %s, weight_per_base_unit = %s, updated_by = %s
            WHERE id = %s
            """,
            (new_name, new_size, remarks, narration, spec, base_unit, purchase_unit, weight_per_base_unit, user_id, item_id),
        )
        cur.execute("DELETE FROM erp.item_vendors WHERE item_id = %s", (item_id,))
    else:
        cur.execute(
            """
            INSERT INTO erp.items (item_name, size, remarks, narration, specification,
                base_unit, purchase_unit, weight_per_base_unit, updated_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (new_name, new_size, remarks, narration, spec, base_unit, purchase_unit, weight_per_base_unit, user_id),
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

    message = "Item updated successfully." if is_edit else "Item added successfully."
    return build_response(True, {"name": new_name, "size": new_size}, message)


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
        raise ValueError(f'Cannot delete "{valid_name}"{size_suffix}: referenced by a Product\'s BOM or a Process recipe.')

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
            f" Skipped {len(skipped)} item(s) referenced by a Product's BOM or a Process recipe: "
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
      ensured for it.
    - Existing item: blank narration is filled; Purchase Unit is kept synced
      to whatever unit was actually used on this line; this vendor's rate is
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
        cur.execute("SELECT narration, purchase_unit FROM erp.items WHERE id = %s", (item_id,))
        row = cur.fetchone()
        if narration and not (row["narration"] or "").strip():
            cur.execute("UPDATE erp.items SET narration = %s WHERE id = %s", (narration, item_id))
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

    return item_id
