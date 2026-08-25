"""Return Ledger, ported from Apps_Script/module_return.js.

Mirrors module_bill.js but in reverse: QTY/BASE_QTY here are debited from
Stock instead of credited (see stock_service._get_billed_and_consumed_qty_maps's
RETURN term). Return's identity is `return_number` alone (globally unique)
-- unlike Bill's (vendor, billNumber) composite.

Deliberately not ported: no autoExtractFromPoOrBill call -- the source
itself never calls it here (a return references existing vendors/items, it
doesn't auto-register new ones), a genuine behavioral difference from
PO/Bill, not an oversight. No rename-backfill function exists for Return in
the source either (confirmed by reading the whole file), so
items_service._propagate_item_identity_change has no Return target,
matching that. initReturnSheet/_getReturnSheet (GAS self-healing sheet
bootstrap) -- same category as every prior round's dropped init functions.
"""

from __future__ import annotations

import json
import math
from datetime import datetime

import psycopg2.extras

import database
from . import items_service
from . import units_service
from .current_user import get_current_user_id
from .. import date_utils
from ..envelope import build_response
from ..registry import rpc_method


def _to_valid_number(value, field_label: str, allow_zero: bool = True) -> float:
    try:
        n = float(value)
    except (TypeError, ValueError):
        n = math.nan
    if not math.isfinite(n):
        raise ValueError(f"{field_label} must be a valid number.")
    if not allow_zero and n == 0:
        raise ValueError(f"{field_label} must be greater than zero.")
    if n < 0:
        raise ValueError(f"{field_label} must not be negative.")
    return n


def _find_vendor_id(cur, name: str):
    cur.execute("SELECT id FROM erp.vendors WHERE lower(vendor_name) = lower(%s) AND deleted_at IS NULL", (name,))
    row = cur.fetchone()
    return row["id"] if row else None


def _find_item_id(cur, name: str, size: str):
    cur.execute(
        "SELECT id FROM erp.items WHERE lower(item_name) = lower(%s) AND lower(size) = lower(%s) AND deleted_at IS NULL",
        (name, size),
    )
    row = cur.fetchone()
    return row["id"] if row else None


def _load_return_list(cur, only_header_id=None) -> list:
    """Core of getReturnData: query + group, optionally scoped to one
    header. Shared by get_return_data() (full list) and save_return()
    (only_header_id, to read back just its own freshly-written return for
    the client's in-place row-patch response).
    """
    query = """
        SELECT h.id AS header_id, h.return_number, h.return_date, h.vendor, h.contact,
               h.bill_number, h.remarks,
               l.item_name, l.size, l.narration, l.unit, l.qty, l.price, l.reason,
               l.base_qty, l.base_rate
        FROM erp.return_headers h
        JOIN erp.return_lines l ON l.header_id = h.id
        WHERE h.deleted_at IS NULL
        """
    params: list = []
    if only_header_id is not None:
        query += " AND h.id = %s"
        params.append(only_header_id)
    query += " ORDER BY h.id, l.id"

    cur.execute(query, params)
    rows = cur.fetchall()

    return_map: dict = {}
    for row in rows:
        key = row["return_number"]
        r = return_map.get(key)
        if r is None:
            r = {
                "returnNumber": row["return_number"],
                "returnDate": date_utils.to_display_string(row["return_date"]) or "",
                "returnDateRaw": date_utils.to_iso_string(row["return_date"]) or "",
                "vendor": row["vendor"] or "",
                "contact": row["contact"] or "",
                "billNumber": row["bill_number"] or "",
                "remarks": row["remarks"] or "",
                "items": [],
                "totalQty": 0.0,
                "totalAmount": 0.0,
                "_headerId": row["header_id"],
            }
            return_map[key] = r

        qty = float(row["qty"])
        price = float(row["price"])
        line_total = round(qty * price, 2)

        r["items"].append(
            {
                "name": row["item_name"],
                "size": row["size"] or "",
                "narration": row["narration"] or "",
                "unit": row["unit"] or "Pcs",
                "qty": qty,
                "price": price,
                "lineTotal": line_total,
                "reason": row["reason"] or "",
                "baseQty": float(row["base_qty"]),
                "baseRate": float(row["base_rate"]),
            }
        )
        r["totalQty"] += qty
        r["totalAmount"] += line_total

    # Newest return date first; ties broken by most-recently-created first.
    returns = sorted(return_map.values(), key=lambda r: (r["returnDateRaw"] or "", r["_headerId"]), reverse=True)
    for r in returns:
        del r["_headerId"]

    return returns


@rpc_method("getReturnData")
def get_return_data():
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        returns = _load_return_list(cur)
    return build_response(True, returns)


@rpc_method("saveReturn", mutation=True)
@database.transactional
def save_return(conn, cur, form_data):
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
        raise ValueError("Cannot save a return with zero items. Add at least one item.")

    old_return_number = str(form_data.get("existingReturnNumber") or "").strip()
    is_edit = bool(old_return_number)

    return_number = str(form_data.get("returnNumber") or "").strip()
    if not return_number:
        now = datetime.now()
        return_number = f"RET-{now.strftime('%Y%m%d')}-{now.strftime('%H%M%S')}"

    # Global uniqueness (return_number alone, unlike Bill's (vendor,
    # billNumber) composite), excluding self on edit.
    cur.execute(
        "SELECT id FROM erp.return_headers WHERE lower(return_number) = lower(%s) AND deleted_at IS NULL",
        (return_number,),
    )
    existing_match = cur.fetchone()
    is_self = is_edit and return_number.lower() == old_return_number.lower()
    if existing_match and not is_self:
        if is_edit:
            raise ValueError(f'The return number "{return_number}" already exists in another record. Edit aborted.')
        raise ValueError(f'Return number "{return_number}" already exists. Please use a unique return number.')

    header_id = None
    if is_edit:
        cur.execute(
            "SELECT id FROM erp.return_headers WHERE lower(return_number) = lower(%s) AND deleted_at IS NULL",
            (old_return_number,),
        )
        old_header = cur.fetchone()
        if old_header is None:
            raise ValueError(f"Original Return #{old_return_number} not found in sheet. Edit aborted to prevent data corruption.")
        header_id = old_header["id"]

    return_date = date_utils.to_safe_date(form_data.get("returnDate"))
    if not return_date:
        raise ValueError("Invalid return date. Accepted formats: DD/MM/YYYY or YYYY-MM-DD.")

    vendor = str(form_data.get("vendor") or "").strip()
    if not vendor:
        raise ValueError("Vendor must not be empty.")
    contact = str(form_data.get("contact") or "").strip()
    bill_number = str(form_data.get("billNumber") or "").strip()
    remarks = str(form_data.get("remarks") or "").strip()

    item_unit_map = items_service.get_item_unit_info_map(cur)
    units_map = units_service.get_units_map(cur)
    vendor_id = _find_vendor_id(cur, vendor)
    user_id = get_current_user_id()

    if is_edit:
        cur.execute(
            """
            UPDATE erp.return_headers
            SET return_number = %s, return_date = %s, vendor = %s, vendor_id = %s, contact = %s,
                bill_number = %s, remarks = %s, updated_by = %s
            WHERE id = %s
            """,
            (return_number, return_date, vendor, vendor_id, contact, bill_number, remarks, user_id, header_id),
        )
        cur.execute("DELETE FROM erp.return_lines WHERE header_id = %s", (header_id,))
    else:
        cur.execute(
            """
            INSERT INTO erp.return_headers (return_number, return_date, vendor, vendor_id, contact,
                bill_number, remarks, updated_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (return_number, return_date, vendor, vendor_id, contact, bill_number, remarks, user_id),
        )
        header_id = cur.fetchone()["id"]

    for item in items:
        item = item or {}
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        size = str(item.get("size") or "").strip()
        narration = str(item.get("narration") or "").strip()

        # A return of zero quantity is meaningless -- allow_zero=False,
        # unlike PO/Bill lines where qty=0 is tolerated.
        qty = _to_valid_number(item.get("qty"), "Qty", allow_zero=False)
        price = _to_valid_number(item.get("price"), "Price")

        unit = str(item.get("unit") or "Pcs").strip() or "Pcs"
        reason = str(item.get("reason") or "").strip()

        # An unconvertible unit must never block saving the return.
        unit_info = items_service.lookup_item_unit_info(item_unit_map, name, size)
        try:
            base_qty = units_service.convert_qty_to_base_unit(qty, unit, unit_info, units_map)
            base_rate = units_service.convert_rate_to_base_unit(price, unit, unit_info, units_map)
        except ValueError:
            base_qty = qty
            base_rate = price

        item_id = _find_item_id(cur, name, size)
        cur.execute(
            """
            INSERT INTO erp.return_lines (header_id, item_name, size, narration, qty, unit, price,
                reason, base_qty, base_rate, item_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (header_id, name, size, narration, qty, unit, price, reason, base_qty, base_rate, item_id),
        )

    message = f"Return #{return_number} updated successfully." if is_edit else f"Return #{return_number} recorded successfully."

    # Read this return's own just-written rows back so the client can patch
    # it into an already-loaded Return Ledger in place instead of a full
    # reload.
    fresh_list = _load_return_list(cur, only_header_id=header_id)
    fresh_return = fresh_list[0] if fresh_list else None

    return build_response(True, {"returnNumber": return_number, "ret": fresh_return}, message)


@rpc_method("deleteReturn", mutation=True)
@database.transactional
def delete_return(conn, cur, return_number):
    target = str(return_number or "").strip()
    if not target:
        raise ValueError("Return number must not be empty.")

    cur.execute(
        "SELECT id FROM erp.return_headers WHERE lower(return_number) = lower(%s) AND deleted_at IS NULL",
        (target,),
    )
    row = cur.fetchone()
    if row is None:
        raise ValueError(f"Return #{target} not found.")

    cur.execute(
        "UPDATE erp.return_headers SET deleted_at = NOW(), updated_by = %s WHERE id = %s",
        (get_current_user_id(), row["id"]),
    )
    return build_response(True, None, f"Return #{target} deleted successfully.")


@rpc_method("deleteReturnsBulk", mutation=True)
@database.transactional
def delete_returns_bulk(conn, cur, return_numbers):
    targets = {str(r or "").strip().lower() for r in (return_numbers or []) if str(r or "").strip()}
    if not targets:
        return build_response(True, None, "No returns selected.")

    user_id = get_current_user_id()
    cur.execute(
        """
        UPDATE erp.return_headers SET deleted_at = NOW(), updated_by = %s
        WHERE deleted_at IS NULL AND lower(return_number) = ANY(%s)
        """,
        (user_id, list(targets)),
    )
    rows_deleted = cur.rowcount

    return build_response(True, {"deletedIds": list(targets)}, f"Deleted {rows_deleted} return(s).")
