"""PO Tracker, ported from Apps_Script/module_po.js.

The first denormalized sheet: one Sheet row per PO line, with header fields
(Vendor, PO Date, ...) repeated on every line. Split here into
erp.po_headers + erp.po_lines (see config_maps.TABLE_NAMES's PO_HEADERS/
PO_LINES keys and the Phase 2b plan for why a single "PO" table-name entry
doesn't work for a denormalized sheet).

savePO's auto-extraction side effects (vendor/item/rate-history upsert) are
not optional/bonus behavior -- the source performs them unconditionally on
every save, so they're in scope here too, not deferred.

PO status (_attachPoStatus) is real as of Phase 2c: `billed_map` comes from
bill_service._aggregate_billed_base_qty_by_po (module_bill.js's
_aggregateBilledBaseQtyByPo -- module_po.js just calls it, matching the
source's own module boundary). _build_po_line_key also lives in
bill_service.py for the same reason, not duplicated here.

suggestPoAllocations (Phase 2e) matches unlinked bill lines to open PO
lines to support bill entry -- non-mutating (never writes) and fail-open
(any internal error returns success with an empty list rather than
blocking bill entry).
"""

from __future__ import annotations

import json
from datetime import date

import psycopg2.extras

import database
from . import bill_service
from . import items_service
from . import units_service
from . import vendors_service
from .current_user import get_current_user_id
from .. import config_maps
from .. import date_utils
from ..envelope import build_response
from ..registry import rpc_method

# Below this rate, a PO line contributes nothing to vendor/item/rate-history
# auto-extraction (but the line itself still saves normally) -- matches the
# source's MIN_VENDOR_RATE early-return in autoExtractFromPoOrBill exactly.
_MIN_VENDOR_RATE = 0.01

# Max difference (in base-unit currency) allowed between a bill item's price
# and a PO line's price for them to be considered the same deal --
# suggest_po_allocations's soft price-match preference.
_PO_PRICE_MATCH_EPSILON = 0.01


# ─────────────────────────────────────────────────────────────────────────
# Normalization
# ─────────────────────────────────────────────────────────────────────────


def _normalize_items(cur, raw_items) -> list:
    if isinstance(raw_items, str):
        try:
            items = json.loads(raw_items) if raw_items else []
        except ValueError:
            raise ValueError("Invalid items data: could not parse JSON.")
    else:
        items = raw_items or []

    if not isinstance(items, list) or len(items) == 0:
        raise ValueError("Cannot save a PO with zero items.")

    item_unit_map = items_service.get_item_unit_info_map(cur)
    units_map = units_service.get_units_map()

    normalized = []
    for idx, item in enumerate(items):
        item = item or {}
        name = str(item.get("name") or "").strip()
        if not name:
            raise ValueError(f"Item name at row {idx + 1} must not be empty.")

        narration = str(item.get("narration") or "").strip()
        size = str(item.get("size") or "").strip()

        try:
            qty = float(item.get("qty"))
        except (TypeError, ValueError):
            qty = -1
        if qty < 0:
            raise ValueError(f"Qty at row {idx + 1} must be a non-negative number.")

        unit = str(item.get("unit") or "Pcs").strip() or "Pcs"

        try:
            price = float(item.get("price"))
        except (TypeError, ValueError):
            price = -1
        if price < 0:
            raise ValueError(f"Price at row {idx + 1} must be a non-negative number.")

        # An unconvertible unit must never block saving the PO -- fall back
        # to treating the as-entered qty/price as already in the Base Unit.
        unit_info = items_service.lookup_item_unit_info(item_unit_map, name, size)
        try:
            base_qty = units_service.convert_qty_to_base_unit(qty, unit, unit_info, units_map)
            base_rate = units_service.convert_rate_to_base_unit(price, unit, unit_info, units_map)
        except ValueError:
            base_qty = qty
            base_rate = price

        normalized.append(
            {
                "name": name,
                "narration": narration,
                "size": size,
                "qty": qty,
                "unit": unit,
                "price": price,
                "total": qty * price,
                "baseQty": base_qty,
                "baseRate": base_rate,
            }
        )
    return normalized


# ─────────────────────────────────────────────────────────────────────────
# Status derivation (stubbed -- see module docstring)
# ─────────────────────────────────────────────────────────────────────────


def _attach_po_status(po: dict, billed_map: dict) -> None:
    items = po["items"]
    any_billed = False
    all_lines_complete = len(items) > 0

    for item in items:
        key = bill_service._build_po_line_key(po["poNumber"], item["name"], item["size"], item["narration"])
        billed_base_qty = billed_map.get(key, 0)

        # Legacy/unconverted rows (baseQty 0) are treated as 1:1 with the
        # entered unit -- one value, used for both the completion check and
        # the qty conversion below, so they can't drift apart.
        effective_base_qty = item["baseQty"] if item["baseQty"] > 0 else item["qty"]
        ordered_base_qty = effective_base_qty or 0

        ratio = (item["qty"] / effective_base_qty) if effective_base_qty > 0 else 1
        item["receivedQty"] = billed_base_qty * ratio
        # Not clamped to 0 -- a negative value means this line has been
        # billed beyond what was ordered (see save_bill's advisory
        # over-billing warning). Every current reader of pendingQty already
        # filters to > 0.0001 before display, so this stays invisible in
        # "pending" lists but is now available to surface the overage.
        item["pendingQty"] = item["qty"] - item["receivedQty"]

        if billed_base_qty > 0.0001:
            any_billed = True
        if ordered_base_qty - billed_base_qty > 0.0001:
            all_lines_complete = False

    if any_billed and all_lines_complete:
        po["status"] = config_maps.PO_STATUS["COMPLETED"]
    elif any_billed:
        po["status"] = config_maps.PO_STATUS["PARTIAL"]
    else:
        po["status"] = config_maps.PO_STATUS["ISSUED"]


def _po_sort_num(po_number: str) -> int:
    digits = "".join(ch for ch in str(po_number) if ch.isdigit())
    return int(digits) if digits else 0


# ─────────────────────────────────────────────────────────────────────────
# Lookups
# ─────────────────────────────────────────────────────────────────────────


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


# ─────────────────────────────────────────────────────────────────────────
# Auto-extraction (vendor/item/rate-history upsert -- see module docstring)
# ─────────────────────────────────────────────────────────────────────────


def _auto_extract_from_po(cur, vendor_name: str, contact: str, items: list, po_number: str, doc_date) -> None:
    vendor_name = (vendor_name or "").strip()
    if not vendor_name:
        return
    vendors_service.ensure_vendor(cur, vendor_name, contact)

    for item in items:
        name = item["name"]
        if not name:
            continue
        rate = item["baseRate"]
        if rate < _MIN_VENDOR_RATE:
            continue

        items_service._auto_extract_item(cur, name, item["size"], item["narration"], item["unit"], vendor_name, rate)

        cur.execute(
            """
            INSERT INTO erp.rate_history (rate_date, item_name, size, narration, vendor_name, rate, po_number, bill_number)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (doc_date, name, item["size"], item["narration"], vendor_name, rate, po_number, ""),
        )


# ─────────────────────────────────────────────────────────────────────────
# RPC methods
# ─────────────────────────────────────────────────────────────────────────


def _load_po_list(cur, billed_map: dict, only_po_number: str | None = None) -> list:
    """Core of getPOData: query + group + status-attach, given an
    already-computed billed_map. Shared cursor, no envelope -- reused by
    get_po_data() (which computes its own billed_map),
    suggest_po_allocations() (which reuses one already computed, avoiding a
    second full Bill Ledger read -- matches the source's own
    getPOData(preloadedBilledMap) optimization), and save_po() (which passes
    only_po_number to read back just its own freshly-written PO for the
    client's in-place row-patch response).
    """
    query = """
        SELECT h.po_number, h.po_date, h.vendor, h.contact, h.po_description,
               h.po_remarks, h.supplier_remarks,
               l.item_name, l.narration, l.size, l.qty, l.unit, l.price, l.base_qty, l.base_rate
        FROM erp.po_headers h
        JOIN erp.po_lines l ON l.header_id = h.id
        WHERE h.deleted_at IS NULL
        """
    params: list = []
    if only_po_number is not None:
        query += " AND lower(h.po_number) = lower(%s)"
        params.append(only_po_number)
    query += " ORDER BY h.id, l.id"

    cur.execute(query, params)
    rows = cur.fetchall()

    po_map: dict = {}
    for row in rows:
        po_number = row["po_number"]
        po = po_map.get(po_number)
        if po is None:
            po = {
                "poNumber": po_number,
                "poDate": date_utils.to_display_string(row["po_date"]) or "",
                "poDateRaw": date_utils.to_iso_string(row["po_date"]) or "",
                "vendor": row["vendor"] or "",
                "contact": row["contact"] or "",
                "poDescription": row["po_description"] or "",
                "poRemarks": row["po_remarks"] or "",
                "supplierRemarks": row["supplier_remarks"] or "",
                "items": [],
                "grandTotal": 0.0,
                "totalQty": 0.0,
            }
            po_map[po_number] = po

        qty = float(row["qty"])
        price = float(row["price"])
        po["items"].append(
            {
                "name": row["item_name"],
                "narration": row["narration"] or "",
                "size": row["size"] or "",
                "qty": qty,
                "unit": row["unit"] or "Pcs",
                "price": price,
                "baseQty": float(row["base_qty"]),
                "baseRate": float(row["base_rate"]),
            }
        )
        po["grandTotal"] += qty * price
        po["totalQty"] += qty

    for po in po_map.values():
        _attach_po_status(po, billed_map)

    return sorted(po_map.values(), key=lambda p: _po_sort_num(p["poNumber"]), reverse=True)


@rpc_method("getPOData")
def get_po_data():
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        billed_map = bill_service._aggregate_billed_base_qty_by_po(cur)
        pos = _load_po_list(cur, billed_map)
    return build_response(True, pos)


@rpc_method("savePO", mutation=True)
@database.transactional
def save_po(conn, cur, form_data):
    form_data = form_data or {}

    items = _normalize_items(cur, form_data.get("items"))

    old_po_number = str(form_data.get("existingPoNumber") or "").strip()
    is_edit = bool(old_po_number)

    if is_edit:
        po_number = str(form_data.get("poNumber") or old_po_number).strip()
        if not po_number:
            raise ValueError("PO number must not be empty.")
    else:
        cur.execute("SELECT nextval('erp.po_number_seq') AS n")
        po_number = str(cur.fetchone()["n"])

    # Resolve date: provided / preserve-on-edit / today-on-create.
    raw_date = form_data.get("poDate")
    if raw_date and str(raw_date).strip():
        po_date = date_utils.to_safe_date(raw_date)
        if not po_date:
            raise ValueError(
                f'Could not understand the date format: "{raw_date}". Please use DD/MM/YYYY or YYYY-MM-DD.'
            )
    elif is_edit:
        cur.execute(
            "SELECT po_date FROM erp.po_headers WHERE lower(po_number) = lower(%s) AND deleted_at IS NULL",
            (old_po_number,),
        )
        existing = cur.fetchone()
        po_date = existing["po_date"] if existing and existing["po_date"] else date.today()
    else:
        po_date = date.today()

    vendor = str(form_data.get("vendor") or "").strip()
    if not vendor:
        raise ValueError("Vendor must not be empty.")
    contact = str(form_data.get("contact") or "").strip()
    po_description = str(form_data.get("poDescription") or "").strip()
    po_remarks = str(form_data.get("poRemarks") or "").strip()
    supplier_remarks = str(form_data.get("supplierRemarks") or "").strip()

    vendor_id = _find_vendor_id(cur, vendor)
    user_id = get_current_user_id()

    if is_edit:
        cur.execute(
            "SELECT id FROM erp.po_headers WHERE lower(po_number) = lower(%s) AND deleted_at IS NULL",
            (old_po_number,),
        )
        header_row = cur.fetchone()
        if header_row is None:
            raise ValueError(f"Original PO #{old_po_number} not found in sheet. Edit aborted to prevent data corruption.")
        header_id = header_row["id"]

        # The source allows renumbering a PO with no duplicate check -- a
        # latent gap (two rows could end up sharing a PO number). Not
        # preserved as-is: a friendly pre-check here, same style as every
        # other rename-collision check in this codebase.
        if po_number.lower() != old_po_number.lower():
            cur.execute(
                "SELECT id FROM erp.po_headers WHERE lower(po_number) = lower(%s) AND deleted_at IS NULL AND id != %s",
                (po_number, header_id),
            )
            if cur.fetchone():
                raise ValueError(f"PO #{po_number} already exists.")

        cur.execute(
            """
            UPDATE erp.po_headers
            SET po_number = %s, po_date = %s, vendor = %s, vendor_id = %s, contact = %s,
                po_description = %s, po_remarks = %s, supplier_remarks = %s, updated_by = %s
            WHERE id = %s
            """,
            (po_number, po_date, vendor, vendor_id, contact, po_description, po_remarks, supplier_remarks, user_id, header_id),
        )
        cur.execute("DELETE FROM erp.po_lines WHERE header_id = %s", (header_id,))
    else:
        cur.execute(
            """
            INSERT INTO erp.po_headers (po_number, po_date, vendor, vendor_id, contact,
                po_description, po_remarks, supplier_remarks, updated_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (po_number, po_date, vendor, vendor_id, contact, po_description, po_remarks, supplier_remarks, user_id),
        )
        header_id = cur.fetchone()["id"]

    for item in items:
        item_id = _find_item_id(cur, item["name"], item["size"])
        cur.execute(
            """
            INSERT INTO erp.po_lines (header_id, item_name, narration, size, qty, unit, price, base_qty, base_rate, item_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                header_id,
                item["name"],
                item["narration"],
                item["size"],
                item["qty"],
                item["unit"],
                item["price"],
                item["baseQty"],
                item["baseRate"],
                item_id,
            ),
        )

    _auto_extract_from_po(cur, vendor, contact, items, po_number, po_date)

    message = f"PO #{po_number} ({vendor}) updated successfully." if is_edit else f"PO #{po_number} ({vendor}) created successfully."

    # Read this PO's own just-written rows back so the client can patch it
    # into an already-loaded list in place instead of a full reload.
    fresh_billed_map = bill_service._aggregate_billed_base_qty_by_po(cur)
    fresh_list = _load_po_list(cur, fresh_billed_map, only_po_number=po_number)
    fresh_po = fresh_list[0] if fresh_list else None

    return build_response(True, {"poNumber": po_number, "po": fresh_po}, message)


@rpc_method("deletePO", mutation=True)
@database.transactional
def delete_po(conn, cur, po_number):
    target = str(po_number or "").strip()
    if not target:
        raise ValueError("PO number must not be empty.")

    cur.execute(
        "SELECT id FROM erp.po_headers WHERE lower(po_number) = lower(%s) AND deleted_at IS NULL",
        (target,),
    )
    row = cur.fetchone()
    if row is None:
        raise ValueError(f"PO #{target} not found.")

    # Deletes the PO only -- Bill Ledger rows referencing this PO number
    # (once Bill Ledger exists) are an independent financial record and are
    # never touched by a PO delete.
    cur.execute(
        "UPDATE erp.po_headers SET deleted_at = NOW(), updated_by = %s WHERE id = %s",
        (get_current_user_id(), row["id"]),
    )
    return build_response(True, None, f"PO #{target} deleted.")


@rpc_method("deletePOsBulk", mutation=True)
@database.transactional
def delete_pos_bulk(conn, cur, po_numbers):
    targets = {str(p or "").strip().lower() for p in (po_numbers or []) if str(p or "").strip()}
    if not targets:
        return build_response(True, None, "No purchase orders selected.")

    user_id = get_current_user_id()
    cur.execute(
        """
        UPDATE erp.po_headers SET deleted_at = NOW(), updated_by = %s
        WHERE deleted_at IS NULL AND lower(po_number) = ANY(%s)
        """,
        (user_id, list(targets)),
    )
    rows_deleted = cur.rowcount

    return build_response(True, {"deletedIds": list(targets)}, f"Deleted {rows_deleted} PO(s).")


@rpc_method("suggestPoAllocations")
def suggest_po_allocations(vendor, items, bill_date=None):
    """Given a vendor + a set of unlinked bill line items, suggests which
    open PO line(s) each most likely belongs to. Never writes -- only
    proposes allocations for the UI to confirm/override before a bill save.
    Fails open: any internal error returns success with an empty list
    rather than blocking bill entry.
    """
    try:
        vendor_name = str(vendor or "").strip()
        if not vendor_name or not isinstance(items, list) or len(items) == 0:
            return build_response(True, [])

        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
            billed_map = bill_service._aggregate_billed_base_qty_by_po(cur)
            all_pos = _load_po_list(cur, billed_map)
            item_unit_map = items_service.get_item_unit_info_map(cur)

        units_map = units_service.get_units_map()

        vendor_pos = [po for po in all_pos if po["vendor"].strip().lower() == vendor_name.lower()]
        if not vendor_pos:
            return build_response(True, [])

        bill_date_obj = date_utils.to_safe_date(bill_date)
        if bill_date_obj:
            vendor_pos = [
                po
                for po in vendor_pos
                if not po["poDateRaw"] or date_utils.to_safe_date(po["poDateRaw"]) <= bill_date_obj
            ]
        if not vendor_pos:
            return build_response(True, [])

        # Flatten to open PO lines (remaining base qty > 0), oldest PO first.
        candidates = []
        for po in vendor_pos:
            for po_item in po["items"]:
                key = bill_service._build_po_line_key(po["poNumber"], po_item["name"], po_item["size"], po_item["narration"])
                billed_base_qty = billed_map.get(key, 0)
                remaining_base_qty = po_item["baseQty"] - billed_base_qty
                if remaining_base_qty > 0.0001:
                    candidates.append(
                        {
                            "poNumber": po["poNumber"],
                            "poDateRaw": po["poDateRaw"],
                            "name": str(po_item["name"]),
                            "size": str(po_item["size"]),
                            "narration": str(po_item["narration"] or ""),
                            "price": po_item["price"],
                            "unit": str(po_item["unit"] or "Pcs"),
                            "baseRate": po_item["baseRate"],
                            "remainingBaseQty": remaining_base_qty,
                        }
                    )

        candidates.sort(key=lambda c: (c["poDateRaw"] or "", _po_sort_num(c["poNumber"])))

        # Grouped once by (name,size) so each bill line's lookup is O(1).
        # Each group holds the SAME candidate dicts (not copies), so
        # mutating remainingBaseQty further down correctly reduces capacity
        # for every other bill row sharing this key.
        candidates_by_key: dict = {}
        for c in candidates:
            key = f'{c["name"].lower()}|{c["size"].lower()}'
            candidates_by_key.setdefault(key, []).append(c)

        results = []
        for item in items:
            item = item or {}
            row_index = item.get("rowIndex")
            name = str(item.get("name") or "").strip()
            size = str(item.get("size") or "").strip()
            try:
                qty = float(item.get("qty") or 0)
            except (TypeError, ValueError):
                qty = 0
            try:
                price = float(item.get("price") or 0)
            except (TypeError, ValueError):
                price = 0
            unit = str(item.get("unit") or "Pcs")

            if not name or qty <= 0:
                results.append({"rowIndex": row_index, "allocations": [], "unmatchedQty": qty})
                continue

            unit_info = items_service.lookup_item_unit_info(item_unit_map, name, size)
            try:
                base_qty = units_service.convert_qty_to_base_unit(qty, unit, unit_info, units_map)
                base_rate = units_service.convert_rate_to_base_unit(price, unit, unit_info, units_map)
            except ValueError:
                base_qty = qty
                base_rate = price

            # qty-per-1-baseQty, used to convert allocated base qty back to
            # the unit this bill line was actually entered in.
            ratio = (qty / base_qty) if base_qty > 0 else 1

            same_name_size = [
                c for c in candidates_by_key.get(f"{name.lower()}|{size.lower()}", []) if c["remainingBaseQty"] > 0.0001
            ]

            # Narration/price are preferences, not hard requirements -- a
            # missing/mismatched value never forces a fallback to unmatched.
            narration = str(item.get("narration") or "").strip().lower()
            narration_matched = (
                [c for c in same_name_size if c["narration"].strip().lower() == narration] if narration else []
            )
            narration_pool = narration_matched if narration_matched else same_name_size

            price_matched = (
                [c for c in narration_pool if abs(c["baseRate"] - base_rate) <= _PO_PRICE_MATCH_EPSILON] if price > 0 else []
            )
            matching = price_matched if price_matched else narration_pool

            base_qty_left = base_qty
            allocations = []
            for c in matching:
                if base_qty_left <= 0.0001:
                    break
                take = min(c["remainingBaseQty"], base_qty_left)
                if take <= 0:
                    continue

                # Bill rate has dominion over PO rate -- flag the
                # disagreement so the UI can offer to keep the PO's rate
                # instead, rather than silently overwriting it.
                allocation = {"poNumber": c["poNumber"], "qty": round(take * ratio, 4)}
                if price > 0 and abs(c["baseRate"] - base_rate) > _PO_PRICE_MATCH_EPSILON:
                    allocation["rateConflict"] = {
                        "poRate": c["price"],
                        "poUnit": c["unit"],
                        "billRate": price,
                        "billUnit": unit,
                    }
                allocations.append(allocation)

                # Mutate the shared candidate so other bill rows in this
                # same batch don't also get allocated against capacity this
                # row just claimed.
                c["remainingBaseQty"] -= take
                base_qty_left -= take

            results.append(
                {
                    "rowIndex": row_index,
                    "allocations": allocations,
                    "unmatchedQty": round(base_qty_left * ratio, 4),
                }
            )

        return build_response(True, results)
    except Exception:  # noqa: BLE001 -- fail open, never block bill entry on a suggestion error
        return build_response(True, [])
