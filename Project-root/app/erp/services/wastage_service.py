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
"""

from __future__ import annotations

import json
from datetime import datetime

import psycopg2.extras

import database
from . import items_service
from . import return_service
from . import units_service
from .current_user import get_current_user_id
from .. import date_utils
from ..envelope import build_response
from ..registry import rpc_method


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


@rpc_method("getWastageData")
def get_wastage_data():
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        _conn,
        cur,
    ):
        cur.execute(
            """
            SELECT h.id AS header_id, h.wastage_id, h.wastage_date, h.vendor, h.remarks,
                   l.item_name, l.size, l.qty, l.unit, l.reason, l.base_qty
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
    if is_edit:
        cur.execute(
            "SELECT id FROM erp.wastage_headers WHERE lower(wastage_id) = lower(%s) AND deleted_at IS NULL",
            (existing_wastage_id,),
        )
        existing = cur.fetchone()
        if existing is None:
            raise ValueError(
                f"Original wastage record {existing_wastage_id} not found. Edit aborted."
            )
        header_id = existing["id"]

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
        name = str(item.get("name") or "").strip()
        size = str(item.get("size") or "").strip()
        qty = return_service._to_valid_number(item.get("qty"), "Qty", allow_zero=False)
        unit = str(item.get("unit") or "Pcs").strip() or "Pcs"
        reason = str(item.get("reason") or "").strip()

        unit_info = items_service.lookup_item_unit_info(item_unit_map, name, size)
        try:
            base_qty = units_service.convert_qty_to_base_unit(
                qty, unit, unit_info, units_map
            )
        except ValueError:
            base_qty = qty

        normalized.append(
            {
                "name": name,
                "size": size,
                "qty": qty,
                "unit": unit,
                "reason": reason,
                "baseQty": base_qty,
            }
        )

    normalized = [n for n in normalized if n["name"]]
    if not normalized:
        raise ValueError("Cannot save wastage with zero items. Add at least one item.")

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
        now = datetime.now()
        wastage_id = f"WST-{now.strftime('%Y%m%d')}-{now.strftime('%H%M%S')}"
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
        item_id = _find_item_id(cur, n["name"], n["size"])
        cur.execute(
            """
            INSERT INTO erp.wastage_lines (header_id, item_name, size, qty, unit, reason, base_qty, item_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
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
            ),
        )

    message = (
        f"Wastage {wastage_id} updated successfully."
        if is_edit
        else f"Wastage {wastage_id} logged successfully."
    )
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
        """,
        (user_id, list(targets)),
    )
    rows_deleted = cur.rowcount

    return build_response(
        True,
        {"deletedIds": list(targets)},
        f"Deleted {rows_deleted} wastage record(s).",
    )
