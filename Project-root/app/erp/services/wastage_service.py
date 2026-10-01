"""Wastage Log, ported from Apps_Script/module_wastage.js.

Records component-wise material wastage/losses. Vendor is optional.
BASE_QTY debits Stock the same way vendor Returns do -- see
stock_service._get_billed_and_consumed_qty_maps's WASTAGE term.

saveWastage's `existingWastageId` folds in the source's separate
updateWastage(wastageId, formData) (module_wastage.js) -- same convention
already used for PO/Bill/Return's edit paths in this port: one save_* RPC
with an optional existing-id field, rather than a second registered RPC
method. wastageId itself never changes on edit (source has no override
field on either create or update). Still no singular deleteWastage -- only
deleteWastageBulk, same as source.

wastageId is always auto-generated on create (WST-YYYYMMDD-HHMMSS, second
precision, no override field accepted -- unlike Return's returnNumber). The
source never checks for a same-second collision on it either; ported with
zero deviation there (no unique index -- see migrations/erp/011_wastage_and_issue.sql).

A blank item name is silently dropped rather than stored: the source never
validates item.name's presence (only qty is strictly validated via
_toValidNumber, imported here from return_service, its current owner and
module_bill.js's original shared home), so a blank-name row would
literally be written to the sheet as-is. Matches Process Components'
identical `.filter(c => c.itemName)` treatment of the same edge case,
avoiding both a nonsense stock-debit key and a NOT NULL violation (every
line table in this schema requires item_name). If every item in a save
ends up blank, the whole save is rejected rather than committing an empty
header.

Not ported: initWastageSheet (GAS sheet-bootstrap, no Postgres equivalent
needed). recalculateStock() calls at the end of saveWastage/updateWastage/
deleteWastageBulk are no-ops here -- Stock is computed live (Phase 1c
architecture), nothing to recalculate.

A line can also be written off the Warehouse Pool (migration 048): a
processed item -- a painted frame, a fitted rim -- that came out defective.
`sourceType` says which, with process_components' two values: 'ITEM' (the
default, every line before 048) debits Items Stock as above; 'POOL' names a
pool bucket by Output Item Name, Product Tag and Color, and debits that
bucket in _recalculate_warehouse_pool's Pass 2b instead. The Warehouse Pool
is a stored cache, unlike Stock, so a save or delete that touches a POOL
line rebuilds it.
"""

from __future__ import annotations

import json
from datetime import datetime

from . import document_numbers

import psycopg2.extras

import database
from . import items_service
from . import locks
from . import return_service
from . import units_service
from . import warehouse_service
from .current_user import get_current_user_id
from .. import date_utils
from ..envelope import build_response
from ..registry import rpc_method

_SOURCE_ITEM = "ITEM"
_SOURCE_POOL = "POOL"


def _find_vendor_id(cur, name: str):
    cur.execute(
        "SELECT id FROM erp.vendors WHERE lower(vendor_name) = lower(%s) AND deleted_at IS NULL",
        (name,),
    )
    row = cur.fetchone()
    return row["id"] if row else None


def _find_item_id(cur, name: str, size: str):
    cur.execute(
        "SELECT id FROM erp.items WHERE lower(item_name) = lower(%s) AND lower(size) = lower(%s) AND deleted_at IS NULL",
        (name, size),
    )
    row = cur.fetchone()
    return row["id"] if row else None


def _pool_key(name: str, tag: str, color: str) -> tuple:
    """A pool bucket's identity, keyed exactly as warehouse_service's
    get_bucket() keys one: name, tag, colour, case-insensitively."""
    return (name.strip().lower(), tag.strip().lower(), color.strip().lower())


def _pool_label(name: str, tag: str, color: str) -> str:
    label = f'"{name}"'
    if color:
        label += f' in "{color}"'
    if tag:
        label += f" (Product {tag})"
    return label


def _get_pool_bucket(cur, name: str, tag: str, color: str):
    cur.execute(
        """
        SELECT output_item_name, product_tag, color, available_qty, counts_toward_total
        FROM erp.warehouse_pool
        WHERE lower(output_item_name) = lower(%s) AND lower(COALESCE(product_tag, '')) = lower(%s)
              AND lower(COALESCE(color, '')) = lower(%s)
        """,
        (name, tag, color),
    )
    return cur.fetchone()


def _pool_qty_by_bucket(cur, header_id) -> dict:
    """{bucket key: qty} this record's POOL lines take -- read before an
    edit rewrites them, so the edit is judged against the pool as it stands
    without this record in it."""
    cur.execute(
        "SELECT item_name, product_tag, color, base_qty, qty FROM erp.wastage_lines "
        "WHERE header_id = %s AND source_type = %s",
        (header_id, _SOURCE_POOL),
    )
    taken: dict = {}
    for row in cur.fetchall():
        key = _pool_key(
            row["item_name"] or "", row["product_tag"] or "", row["color"] or ""
        )
        taken[key] = taken.get(key, 0.0) + (
            float(row["base_qty"] or 0) or float(row["qty"] or 0)
        )
    return taken


def _check_pool_lines(
    cur, normalized: list, previously_taken: dict, wastage_at
) -> tuple[list, list]:
    """Validates every POOL line against the live Warehouse Pool, rewrites
    each to its bucket's stored spelling, and returns (shortfall warnings,
    recount notes).

    A bucket must exist and must hold units. A non-counting bucket is a
    sub-group recorded per colour on units its primary axis already counted
    (migration 043), so a write-off there would come off something that
    holds no stock of its own -- and, excluded from every total, it would
    vanish from them. Both checks are skipped for a bucket this record was
    already writing off before the edit, so a record whose bucket has since
    changed can still have its date or remarks corrected.

    Over-drawing is a warning, never a refusal -- the same call Production
    makes for a lot drawing more than the pool holds. The negative it leaves
    is how somebody learns a count is owed.

    A write-off dated at or before its bucket's latest recount is already
    inside that count, so Pass 2b leaves the bucket where it is (see
    warehouse_service's frozen()). That is correct, and silent: the operator
    would log three frames and watch the pool not move. So it is said, and
    such a line is not measured against availability it will never draw on.
    """
    anchors = warehouse_service._get_bucket_anchors(cur)
    need: dict = {}
    counted: dict = {}
    for n in normalized:
        if n["sourceType"] != _SOURCE_POOL:
            continue
        key = _pool_key(n["name"], n["productTag"], n["color"])
        bucket = _get_pool_bucket(cur, n["name"], n["productTag"], n["color"])
        if key not in previously_taken:
            label = _pool_label(n["name"], n["productTag"], n["color"])
            if bucket is None:
                raise ValueError(
                    f"{label} is not in the Warehouse Pool. Pick the item and "
                    "colour from the Warehouse Pool list."
                )
            if not bucket["counts_toward_total"]:
                raise ValueError(
                    f"{label} is a sub-group recorded on units already counted "
                    "under their main colour, so it holds no stock of its own. "
                    "Log the wastage against the main colour instead."
                )
        if bucket is not None:
            n["name"] = bucket["output_item_name"]
            n["productTag"] = bucket["product_tag"] or ""
            n["color"] = bucket["color"] or ""

        anchor = anchors.get(key)
        if anchor is not None and wastage_at <= anchor[0]:
            counted.setdefault(
                key, (_pool_label(n["name"], n["productTag"], n["color"]), anchor[0])
            )
            continue

        entry = need.setdefault(
            key,
            {
                "label": _pool_label(n["name"], n["productTag"], n["color"]),
                "available": (float(bucket["available_qty"]) if bucket else 0.0)
                + previously_taken.get(key, 0.0),
                "qty": 0.0,
            },
        )
        entry["qty"] += n["baseQty"]

    warnings = [
        f"Only {e['available']:g} unit(s) of {e['label']} are available in the Warehouse Pool."
        for e in need.values()
        if e["qty"] > e["available"] + 0.0001
    ]
    notes = [
        f"{label} was recounted on {when:%d/%m/%Y}, after this date, so the count "
        "already left these units out and the Warehouse Pool does not change."
        for label, when in counted.values()
    ]
    return warnings, notes


@rpc_method("getWastageData")
def get_wastage_data():
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        _conn,
        cur,
    ):
        cur.execute(
            """
            SELECT h.id AS header_id, h.wastage_id, h.wastage_date, h.vendor, h.remarks,
                   l.item_name, l.size, l.qty, l.unit, l.reason, l.base_qty,
                   l.source_type, l.color, l.product_tag
            FROM erp.wastage_headers h
            JOIN erp.wastage_lines l ON l.header_id = h.id
            WHERE h.deleted_at IS NULL
            ORDER BY h.id, l.id
            """
        )
        rows = cur.fetchall()

    wastage_map: dict = {}
    for row in rows:
        key = row["wastage_id"]
        w = wastage_map.get(key)
        if w is None:
            w = {
                "wastageId": row["wastage_id"],
                "date": date_utils.to_display_string(row["wastage_date"]) or "",
                "dateRaw": date_utils.to_iso_string(row["wastage_date"]) or "",
                "vendor": row["vendor"] or "",
                "remarks": row["remarks"] or "",
                "items": [],
                "totalQty": 0.0,
                "_headerId": row["header_id"],
            }
            wastage_map[key] = w

        qty = float(row["qty"])
        base_qty = float(row["base_qty"]) or qty
        w["items"].append(
            {
                "name": row["item_name"],
                "size": row["size"] or "",
                "qty": qty,
                "unit": row["unit"] or "Pcs",
                "reason": row["reason"] or "",
                # Duplicated at item level too -- matches getWastageData's
                # own response shape exactly, even though storage only has
                # one remarks value (header-level in this schema).
                "remarks": w["remarks"],
                "baseQty": base_qty,
                # 'POOL' lines name a Warehouse Pool bucket: `name` is its
                # Output Item Name, and color/productTag complete the key.
                "sourceType": row["source_type"] or _SOURCE_ITEM,
                "color": row["color"] or "",
                "productTag": row["product_tag"] or "",
            }
        )
        w["totalQty"] += qty

    records = sorted(
        wastage_map.values(),
        key=lambda w: (w["dateRaw"] or "", w["_headerId"]),
        reverse=True,
    )
    for w in records:
        del w["_headerId"]

    return build_response(True, records)


@rpc_method("saveWastage", mutation=True)
@database.transactional
def save_wastage(conn, cur, form_data):
    form_data = form_data or {}

    items_raw = form_data.get("items")
    if isinstance(items_raw, str):
        try:
            items = json.loads(items_raw) if items_raw else []
        except ValueError:
            raise ValueError("Invalid items data: could not parse JSON.")
    else:
        items = items_raw or []
    if not isinstance(items, list) or len(items) == 0:
        raise ValueError("Cannot save wastage with zero items. Add at least one item.")

    existing_wastage_id = str(form_data.get("existingWastageId") or "").strip()
    is_edit = bool(existing_wastage_id)

    header_id = None
    # When the record was entered -- with its date, what places it against a
    # recount (warehouse_service._effective_at). A new one is being entered
    # now; an edit keeps the moment it was first written.
    entered_at = datetime.now()
    if is_edit:
        cur.execute(
            "SELECT id, created_at FROM erp.wastage_headers WHERE lower(wastage_id) = lower(%s) AND deleted_at IS NULL",
            (existing_wastage_id,),
        )
        existing = cur.fetchone()
        if existing is None:
            raise ValueError(
                f"Original wastage record {existing_wastage_id} not found. Edit aborted."
            )
        header_id = existing["id"]
        entered_at = existing["created_at"] or entered_at

    wastage_date = date_utils.to_safe_date(form_data.get("date"))
    if not wastage_date:
        raise ValueError(
            "Invalid wastage date. Accepted formats: DD/MM/YYYY or YYYY-MM-DD."
        )

    vendor = str(form_data.get("vendor") or "").strip()
    remarks = str(form_data.get("remarks") or "").strip()

    item_unit_map = items_service.get_item_unit_info_map(cur)
    units_map = units_service.get_units_map(cur)

    normalized = []
    for item in items:
        item = item or {}
        source_type = str(item.get("sourceType") or _SOURCE_ITEM).strip().upper()
        if source_type not in (_SOURCE_ITEM, _SOURCE_POOL):
            raise ValueError(
                "Each wastage line must come from Items Stock or the Warehouse Pool."
            )
        name = str(item.get("name") or "").strip()
        qty = return_service._to_valid_number(item.get("qty"), "Qty", allow_zero=False)
        reason = str(item.get("reason") or "").strip()

        if source_type == _SOURCE_POOL:
            # A bucket has no size, and the pool counts units -- whatever a
            # client sends for either, a pool line is stored as pieces.
            normalized.append(
                {
                    "sourceType": _SOURCE_POOL,
                    "name": name,
                    "size": "",
                    "qty": qty,
                    "unit": "Pcs",
                    "reason": reason,
                    "baseQty": qty,
                    "color": str(item.get("color") or "").strip(),
                    "productTag": str(item.get("productTag") or "").strip(),
                }
            )
            continue

        size = str(item.get("size") or "").strip()
        unit = str(item.get("unit") or "Pcs").strip() or "Pcs"

        unit_info = items_service.lookup_item_unit_info(item_unit_map, name, size)
        try:
            base_qty = units_service.convert_qty_to_base_unit(
                qty, unit, unit_info, units_map
            )
        except ValueError:
            base_qty = qty

        normalized.append(
            {
                "sourceType": _SOURCE_ITEM,
                "name": name,
                "size": size,
                "qty": qty,
                "unit": unit,
                "reason": reason,
                "baseQty": base_qty,
                "color": "",
                "productTag": "",
            }
        )

    normalized = [n for n in normalized if n["name"]]
    if not normalized:
        raise ValueError("Cannot save wastage with zero items. Add at least one item.")

    # What this record already takes from the pool, if it is an edit -- read
    # before its lines are rewritten below.
    previously_taken = _pool_qty_by_bucket(cur, header_id) if is_edit else {}
    touches_pool = bool(previously_taken) or any(
        n["sourceType"] == _SOURCE_POOL for n in normalized
    )
    pool_warnings, pool_notes = [], []
    if touches_pool:
        # The same lock Production's availability check and the pool rebuild
        # take, so this decision and the rebuild that applies it cannot
        # interleave with another write to the pool.
        locks.lock_namespace(cur, locks.POOL)
        pool_warnings, pool_notes = _check_pool_lines(
            cur,
            normalized,
            previously_taken,
            warehouse_service._effective_at(wastage_date, entered_at),
        )

    vendor_id = _find_vendor_id(cur, vendor) if vendor else None
    user_id = get_current_user_id()

    if is_edit:
        wastage_id = existing_wastage_id
        cur.execute(
            """
            UPDATE erp.wastage_headers
            SET wastage_date = %s, vendor = %s, vendor_id = %s, remarks = %s, updated_by = %s
            WHERE id = %s
            """,
            (wastage_date, vendor, vendor_id, remarks, user_id, header_id),
        )
        cur.execute("DELETE FROM erp.wastage_lines WHERE header_id = %s", (header_id,))
    else:
        # See the note in issue_service: same generator, same silent-duplicate
        # failure before 042_unique_document_ids.sql.
        wastage_id = document_numbers.next_document_number(
            cur, prefix="WST", table="wastage_headers", column="wastage_id"
        )
        cur.execute(
            """
            INSERT INTO erp.wastage_headers (wastage_id, wastage_date, vendor, vendor_id, remarks, updated_by)
            VALUES (%s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (wastage_id, wastage_date, vendor, vendor_id, remarks, user_id),
        )
        header_id = cur.fetchone()["id"]

    for n in normalized:
        # A pool line's name is an Output Item Name -- a different identity
        # space from Items Master -- so it is never linked to an item, even
        # on a coincidence of names.
        item_id = (
            _find_item_id(cur, n["name"], n["size"])
            if n["sourceType"] == _SOURCE_ITEM
            else None
        )
        cur.execute(
            """
            INSERT INTO erp.wastage_lines
                (header_id, item_name, size, qty, unit, reason, base_qty, item_id,
                 source_type, color, product_tag)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                header_id,
                n["name"],
                n["size"],
                n["qty"],
                n["unit"],
                n["reason"],
                n["baseQty"],
                item_id,
                n["sourceType"],
                n["color"],
                n["productTag"],
            ),
        )

    if touches_pool:
        # Stock is computed live; the Warehouse Pool is stored, so it has to
        # be rebuilt to show this record -- including an edit that removed
        # its pool lines, or moved its date across a recount.
        warehouse_service._recalculate_warehouse_pool(cur)

    message = (
        f"Wastage {wastage_id} updated successfully."
        if is_edit
        else f"Wastage {wastage_id} logged successfully."
    )
    if pool_warnings:
        message = (
            f"{message} Warning: {' '.join(pool_warnings)} "
            "Warehouse Pool stock will now show negative for this item."
        )
    if pool_notes:
        message = f"{message} {' '.join(pool_notes)}"
    return build_response(True, {"wastageId": wastage_id}, message)


@rpc_method("deleteWastageBulk", mutation=True)
@database.transactional
def delete_wastage_bulk(conn, cur, wastage_ids):
    targets = {
        str(w or "").strip().lower()
        for w in (wastage_ids or [])
        if str(w or "").strip()
    }
    if not targets:
        return build_response(True, None, "No wastage records selected.")

    user_id = get_current_user_id()
    cur.execute(
        """
        UPDATE erp.wastage_headers SET deleted_at = NOW(), updated_by = %s
        WHERE deleted_at IS NULL AND lower(wastage_id) = ANY(%s)
        RETURNING id
        """,
        (user_id, list(targets)),
    )
    deleted_header_ids = [row["id"] for row in cur.fetchall()]
    rows_deleted = len(deleted_header_ids)

    if deleted_header_ids:
        cur.execute(
            "SELECT 1 FROM erp.wastage_lines WHERE header_id = ANY(%s) AND source_type = %s LIMIT 1",
            (deleted_header_ids, _SOURCE_POOL),
        )
        if cur.fetchone() is not None:
            # Deleting a write-off puts its units back in the pool.
            warehouse_service._recalculate_warehouse_pool(cur)

    return build_response(
        True,
        {"deletedIds": list(targets)},
        f"Deleted {rows_deleted} wastage record(s).",
    )
