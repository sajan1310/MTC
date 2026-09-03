"""Issued Stock Log, ported from Apps_Script/module_issue.js.

Records ad-hoc issuance of Stock items -- components a contractor needs
beyond what a Process's own recipe (BOM) calls for. Deliberately separate
from Production's Components Consumed list: issuing an item here never
touches a lot's BOM/costing, it only debits Stock directly (same mechanism
as Wastage -- see stock_service._get_billed_and_consumed_qty_maps's ISSUE
term). Reference (e.g. a Production Lot #) is optional and purely
informational.

Create-only in the source, same as Wastage -- no singular deleteIssue, only
deleteIssueBulk. The port additionally supports editing an existing record
(saveIssueStock's `existingIssueId`), a deliberate PWA-only addition with no
GAS equivalent; issueId itself never changes on edit, matching how it has
no override field on create either.

Issued To is required and is matched case-insensitively against Vendor
Master to auto-populate a Vendor snapshot for Vendor Ledger purposes --
there's no separate Vendor input field. This is why WASTAGE (a direct,
user-set vendor) is a vendors_service rename-cascade target and ISSUE
(a derived snapshot) is not -- confirmed against module_vendors.js's
_renameVendorEverywhere, which targets PO/BILL/RETURN/WASTAGE/BOM only.

issueId is always auto-generated (ISS-YYYYMMDD-HHMMSS) with no override
field and no collision check, same as Wastage's wastageId -- see that
module's docstring and migrations/erp/011_wastage_and_issue.sql for why no
unique index is added either.

Not ported: initIssueSheet, _ensureIssueColumns (GAS sheet-bootstrap/
self-healing column backfill -- Postgres has every column from day one).
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


def _match_vendor_name(cur, issued_to: str) -> str:
    """Case-insensitive lookup against Vendor Master, returning the
    canonical stored name if "Issued To" matches a known vendor, else "".
    Ports _getVendorNameMap's effective behavior as one targeted query
    instead of reading the whole Vendors sheet into a map.
    """
    if not issued_to:
        return ""
    cur.execute(
        "SELECT vendor_name FROM erp.vendors WHERE lower(vendor_name) = lower(%s) AND deleted_at IS NULL",
        (issued_to,),
    )
    row = cur.fetchone()
    return row["vendor_name"] if row else ""


def _find_item_id(cur, name: str, size: str):
    cur.execute(
        "SELECT id FROM erp.items WHERE lower(item_name) = lower(%s) AND lower(size) = lower(%s) AND deleted_at IS NULL",
        (name, size),
    )
    row = cur.fetchone()
    return row["id"] if row else None


@rpc_method("getIssueData")
def get_issue_data():
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        _conn,
        cur,
    ):
        cur.execute(
            """
            SELECT h.id AS header_id, h.issue_id, h.issue_date, h.issued_to, h.reference, h.vendor, h.remarks,
                   l.item_name, l.size, l.qty, l.unit, l.base_qty, l.rate
            FROM erp.issue_headers h
            JOIN erp.issue_lines l ON l.header_id = h.id
            WHERE h.deleted_at IS NULL
            ORDER BY h.id, l.id
            """
        )
        rows = cur.fetchall()

    issue_map: dict = {}
    for row in rows:
        key = row["issue_id"]
        rec = issue_map.get(key)
        if rec is None:
            rec = {
                "issueId": row["issue_id"],
                "date": date_utils.to_display_string(row["issue_date"]) or "",
                "dateRaw": date_utils.to_iso_string(row["issue_date"]) or "",
                "issuedTo": row["issued_to"] or "",
                "reference": row["reference"] or "",
                "vendor": row["vendor"] or "",
                "remarks": row["remarks"] or "",
                "items": [],
                "totalQty": 0.0,
                "totalValue": 0.0,
                "_headerId": row["header_id"],
            }
            issue_map[key] = rec

        qty = float(row["qty"])
        rate = float(row["rate"] or 0)
        base_qty = float(row["base_qty"]) or qty
        rec["items"].append(
            {
                "name": row["item_name"],
                "size": row["size"] or "",
                "qty": qty,
                "unit": row["unit"] or "Pcs",
                "baseQty": base_qty,
                "rate": rate,
                "value": qty * rate,
            }
        )
        rec["totalQty"] += qty
        rec["totalValue"] += qty * rate

    records = sorted(
        issue_map.values(),
        key=lambda r: (r["dateRaw"] or "", r["_headerId"]),
        reverse=True,
    )
    for r in records:
        del r["_headerId"]

    return build_response(True, records)


@rpc_method("saveIssueStock", mutation=True)
@database.transactional
def save_issue_stock(conn, cur, form_data):
    """Create-only in the source; the port additionally supports editing an
    existing record when `existingIssueId` is provided (issueId itself never
    changes on edit -- it has no override field, same as on create). Not a
    ported behavior: nothing in module_issue.js offers an edit path, this is
    a deliberate PWA-only addition.
    """
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
        raise ValueError("Cannot issue stock with zero items. Add at least one item.")

    existing_issue_id = str(form_data.get("existingIssueId") or "").strip()
    is_edit = bool(existing_issue_id)

    header_id = None
    if is_edit:
        cur.execute(
            "SELECT id FROM erp.issue_headers WHERE lower(issue_id) = lower(%s) AND deleted_at IS NULL",
            (existing_issue_id,),
        )
        existing = cur.fetchone()
        if existing is None:
            raise ValueError(
                f"Original issue {existing_issue_id} not found. Edit aborted to prevent data corruption."
            )
        header_id = existing["id"]

    issued_to = str(form_data.get("issuedTo") or "").strip()
    if not issued_to:
        raise ValueError("Issued To is required.")

    issue_date = date_utils.to_safe_date(form_data.get("date"))
    if not issue_date:
        raise ValueError(
            "Invalid issue date. Accepted formats: DD/MM/YYYY or YYYY-MM-DD."
        )

    reference = str(form_data.get("reference") or "").strip()
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
        rate = return_service._to_valid_number(item.get("rate") or 0, "Rate")

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
                "rate": rate,
                "baseQty": base_qty,
            }
        )

    # A blank item name is a no-op row -- source computes it anyway but
    # never validates its presence; skipped here, matching Process
    # Components' identical treatment of the same edge case (see
    # wastage_service's module docstring for the full rationale).
    normalized = [n for n in normalized if n["name"]]
    if not normalized:
        raise ValueError("Cannot issue stock with zero items. Add at least one item.")

    vendor = _match_vendor_name(cur, issued_to)
    vendor_id = _find_vendor_id(cur, vendor) if vendor else None
    user_id = get_current_user_id()

    if is_edit:
        issue_id = existing_issue_id
        cur.execute(
            """
            UPDATE erp.issue_headers
            SET issue_date = %s, issued_to = %s, reference = %s, vendor = %s, vendor_id = %s, remarks = %s, updated_by = %s
            WHERE id = %s
            """,
            (
                issue_date,
                issued_to,
                reference,
                vendor,
                vendor_id,
                remarks,
                user_id,
                header_id,
            ),
        )
        cur.execute("DELETE FROM erp.issue_lines WHERE header_id = %s", (header_id,))
    else:
        now = datetime.now()
        issue_id = f"ISS-{now.strftime('%Y%m%d')}-{now.strftime('%H%M%S')}"
        cur.execute(
            """
            INSERT INTO erp.issue_headers (issue_id, issue_date, issued_to, reference, vendor, vendor_id, remarks, updated_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (
                issue_id,
                issue_date,
                issued_to,
                reference,
                vendor,
                vendor_id,
                remarks,
                user_id,
            ),
        )
        header_id = cur.fetchone()["id"]

    for n in normalized:
        item_id = _find_item_id(cur, n["name"], n["size"])
        cur.execute(
            """
            INSERT INTO erp.issue_lines (header_id, item_name, size, qty, unit, base_qty, rate, item_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                header_id,
                n["name"],
                n["size"],
                n["qty"],
                n["unit"],
                n["baseQty"],
                n["rate"],
                item_id,
            ),
        )

    message = (
        f"Issue {issue_id} updated successfully."
        if is_edit
        else f"Stock issue {issue_id} logged successfully."
    )
    return build_response(True, {"issueId": issue_id}, message)


@rpc_method("deleteIssueBulk", mutation=True)
@database.transactional
def delete_issue_bulk(conn, cur, issue_ids):
    targets = {
        str(i or "").strip().lower() for i in (issue_ids or []) if str(i or "").strip()
    }
    if not targets:
        return build_response(True, None, "No issued stock records selected.")

    user_id = get_current_user_id()
    cur.execute(
        """
        UPDATE erp.issue_headers SET deleted_at = NOW(), updated_by = %s
        WHERE deleted_at IS NULL AND lower(issue_id) = ANY(%s)
        """,
        (user_id, list(targets)),
    )
    rows_deleted = cur.rowcount

    return build_response(
        True,
        {"deletedIds": list(targets)},
        f"Deleted {rows_deleted} issued stock record(s).",
    )
