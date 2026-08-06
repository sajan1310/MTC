"""Bill Ledger, ported from Apps_Script/module_bill.js.

A real structural difference from PO Tracker: PO_NUMBER is line-level here
(one bill can combine items fulfilling several different POs, or 'DIRECT'
for non-PO purchases), and the header's identity key is (vendor,
bill_number) -- the same bill number can legitimately recur across
different vendors, so bill_number alone isn't unique.

_buildPoLineKey/_aggregateBilledBaseQtyByPo live here (matching the
source's own module boundary -- module_bill.js defines them, module_po.js
just calls them) and are what unblock po_service.py's real PO status
derivation this round, replacing its Phase 2b stub.

Deliberately not ported: _ensureBillSheetColumns (GAS self-healing legacy-
column migration -- the Postgres schema has every column from day one) and
MIN_LINE_ITEM_AMOUNT (declared in the source but never actually used
anywhere -- dead code).
"""

from __future__ import annotations

import json

import psycopg2.extras

import database
from . import items_service
from . import process_service
from . import units_service
from . import vendors_service
from .current_user import get_current_user_id
from .. import date_utils
from ..envelope import build_response
from ..registry import rpc_method

# Below this rate, a line contributes nothing to item/rate-history
# auto-extraction (but the line itself still saves normally) -- matches
# module_vendors.js's autoExtractFromPoOrBill exactly (same threshold
# po_service.py uses for PO lines).
_MIN_VENDOR_RATE = 0.01


def _compute_line_totals(qty: float, price: float, gst_rate_pct: float) -> dict:
    subtotal = qty * price
    gst_amount = subtotal * (gst_rate_pct / 100)
    line_total = subtotal + gst_amount
    return {
        "subtotal": round(subtotal, 2),
        "gstAmount": round(gst_amount, 2),
        "lineTotal": round(line_total, 2),
    }


def _build_po_line_key(po_number, name, size, narration) -> str:
    """The ONE canonical key for aggregating/looking up billed quantity
    against a PO line -- every caller (po_service._attach_po_status today;
    suggestPoAllocations/dashboard KPIs in later rounds) MUST derive an
    identical key for the same (PO, item, size, narration), so this lives
    in exactly one place, not re-built per caller.
    """
    def part(v) -> str:
        return str(v if v is not None else "").strip().lower()

    return f"{part(po_number)}|{part(name)}|{part(size)}|{part(narration)}"


def _aggregate_billed_base_qty_by_po(cur) -> dict:
    """Sums already-billed base quantity per (PO_NUMBER, item name, size,
    narration) across the entire Bill Ledger. Lines with a blank or
    'DIRECT' PO number aren't fulfilling any PO, so they're excluded.
    """
    cur.execute(
        """
        SELECT l.po_number, l.item_name, l.size, l.narration, l.base_qty
        FROM erp.bill_lines l
        JOIN erp.bill_headers h ON h.id = l.header_id
        WHERE h.deleted_at IS NULL
        """
    )
    result: dict = {}
    for row in cur.fetchall():
        po_num = (row["po_number"] or "").strip()
        if not po_num or po_num.upper() == "DIRECT":
            continue
        key = _build_po_line_key(po_num, row["item_name"], row["size"], row["narration"])
        result[key] = result.get(key, 0) + float(row["base_qty"] or 0)
    return result


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


def _compute_bill_overage_warnings(cur, items: list) -> list[str]:
    """Advisory, non-blocking check run after a bill has been saved: for
    every bill line linked to a real PO (not "DIRECT"/blank), re-aggregates
    the Bill Ledger fresh (on the same cursor/transaction, so it reflects
    this save's own effect) and flags any PO line whose cumulative billed
    base qty now exceeds what was ordered. Bills are intentionally allowed
    to exceed a PO line (freight corrections, renegotiated quantities,
    etc.) -- this only surfaces the overage in the save's response message
    rather than leaving it invisible (see po_service._attach_po_status,
    which no longer clamps pendingQty to 0). `items` is the same list
    save_bill just wrote, each already carrying poNumber/baseQty.

    Local import to avoid a circular top-level import: po_service already
    imports bill_service (for _aggregate_billed_base_qty_by_po).
    """
    from . import po_service

    try:
        po_numbers = {
            str(it.get("poNumber") or "").strip()
            for it in items or []
            if str(it.get("poNumber") or "").strip().upper() not in ("", "DIRECT")
        }
        if not po_numbers:
            return []

        billed_map = _aggregate_billed_base_qty_by_po(cur)
        pos_by_number = {po["poNumber"]: po for po in po_service._load_po_list(cur, billed_map)}

        warnings = []
        seen_keys = set()
        for it in items or []:
            po_num = str(it.get("poNumber") or "").strip()
            if not po_num or po_num.upper() == "DIRECT":
                continue

            key = _build_po_line_key(po_num, it.get("name"), it.get("size") or "", it.get("narration") or "")
            if key in seen_keys:
                continue
            seen_keys.add(key)

            po = pos_by_number.get(po_num)
            if po is None:
                continue

            po_item = next(
                (pi for pi in po["items"] if _build_po_line_key(po_num, pi["name"], pi["size"], pi["narration"]) == key),
                None,
            )
            if po_item is None:
                continue

            billed_base_qty = billed_map.get(key, 0)
            ordered_base_qty = po_item.get("baseQty") or 0
            if billed_base_qty > ordered_base_qty + 0.0001:
                over_by = billed_base_qty - ordered_base_qty
                warnings.append(
                    f'"{it.get("name")}" on PO {po_num} is now billed {billed_base_qty:.2f} vs '
                    f'ordered {ordered_base_qty:.2f} ({over_by:.2f} over).'
                )
        return warnings
    except Exception:
        # Advisory only -- never let this check block or fail a bill save.
        return []


def _load_bill_list(cur, only_header_id=None) -> list:
    """Core of getBillData: query + group, optionally scoped to one header.
    Shared by get_bill_data() (full list) and save_bill() (only_header_id,
    to read back just its own freshly-written bill for the client's
    in-place row-patch response, without re-reading the whole ledger).
    """
    query = """
        SELECT h.id AS header_id, h.bill_number, h.vendor, h.contact, h.bill_date, h.remarks,
               h.issuing_party, h.manufacturing_vendor,
               l.po_number, l.item_name, l.size, l.narration, l.unit, l.qty, l.price,
               l.gst_rate_pct, l.base_qty, l.base_rate, l.affects_stock,
               l.bill_type, l.process_name, l.color
        FROM erp.bill_headers h
        JOIN erp.bill_lines l ON l.header_id = h.id
        WHERE h.deleted_at IS NULL
        """
    params: list = []
    if only_header_id is not None:
        query += " AND h.id = %s"
        params.append(only_header_id)
    query += " ORDER BY h.id, l.id"

    cur.execute(query, params)
    rows = cur.fetchall()

    bill_map: dict = {}
    for row in rows:
        key = f'{row["vendor"].strip().lower()}|{row["bill_number"].strip().lower()}'
        bill = bill_map.get(key)
        if bill is None:
            bill = {
                "poNumber": row["po_number"] or "",
                "poNumbers": [],
                "billNumber": row["bill_number"],
                "billDate": date_utils.to_display_string(row["bill_date"]) or "",
                "billDateRaw": date_utils.to_iso_string(row["bill_date"]) or "",
                "vendor": row["vendor"],
                "contact": row["contact"] or "",
                "remarks": row["remarks"] or "",
                # Labor Job bills only -- optional free text, blank on Goods
                # bills. Header-level: one value per bill, like vendor/contact.
                "issuingParty": row["issuing_party"] or "",
                "manufacturingVendor": row["manufacturing_vendor"] or "",
                # A bill is a Labor Job bill when its lines are; carried on the
                # header too so the ledger can badge a row without inspecting
                # every line. Set from the first line below.
                "billType": "GOODS",
                "items": [],
                "totalQty": 0.0,
                "totalAmount": 0.0,
                "_headerId": row["header_id"],
            }
            bill_map[key] = bill

        row_po_num = (row["po_number"] or "").strip()
        if row_po_num and row_po_num not in bill["poNumbers"]:
            bill["poNumbers"].append(row_po_num)

        qty = float(row["qty"])
        price = float(row["price"])
        gst_rate_pct = float(row["gst_rate_pct"])
        totals = _compute_line_totals(qty, price, gst_rate_pct)

        # Blank (legacy rows predating migration 022) reads as a goods bill.
        line_bill_type = "LABOR" if str(row["bill_type"] or "").strip().upper() == "LABOR" else "GOODS"
        if line_bill_type == "LABOR":
            bill["billType"] = "LABOR"

        bill["items"].append(
            {
                "name": row["item_name"],
                "size": row["size"] or "",
                "narration": row["narration"] or "",
                "unit": row["unit"] or "Pcs",
                "qty": qty,
                "price": price,
                "gstRatePct": gst_rate_pct,
                "lineTotal": totals["lineTotal"],
                "poNumber": row_po_num,
                "baseQty": float(row["base_qty"]),
                "baseRate": float(row["base_rate"]),
                "affectsStock": bool(row["affects_stock"]),
                "billType": line_bill_type,
                # Labor Job lines only -- which Process this line's job-work
                # was for, and the color processed (both blank on GOODS rows).
                "processName": row["process_name"] or "",
                "color": row["color"] or "",
            }
        )
        bill["totalQty"] += qty
        bill["totalAmount"] += totals["lineTotal"]

    # Newest bill date first; ties broken by most-recently-created bill first.
    bills = sorted(bill_map.values(), key=lambda b: (b["billDateRaw"] or "", b["_headerId"]), reverse=True)
    for b in bills:
        del b["_headerId"]

    return bills


@rpc_method("getBillData")
def get_bill_data():
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        bills = _load_bill_list(cur)
    return build_response(True, bills)


@rpc_method("saveBill", mutation=True)
@database.transactional
def save_bill(conn, cur, form_data):
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
        raise ValueError("Cannot save a bill with zero items. Add at least one item.")

    old_bill_number = str(form_data.get("existingBillNumber") or "").strip()
    old_vendor = str(form_data.get("existingVendor") or "").strip()
    is_edit = bool(old_bill_number)

    bill_number = str(form_data.get("billNumber") or "").strip()
    if not bill_number:
        raise ValueError("Bill number must not be empty.")
    vendor = str(form_data.get("vendor") or "").strip()
    if not vendor:
        raise ValueError("Vendor must not be empty.")

    # Uniqueness on (vendor, bill number) -- the same bill number can
    # legitimately recur across different vendors -- excluding self on edit.
    cur.execute(
        "SELECT id FROM erp.bill_headers WHERE lower(vendor) = lower(%s) AND lower(bill_number) = lower(%s) AND deleted_at IS NULL",
        (vendor, bill_number),
    )
    existing_match = cur.fetchone()
    is_self = is_edit and vendor.lower() == old_vendor.lower() and bill_number.lower() == old_bill_number.lower()
    if existing_match and not is_self:
        if is_edit:
            raise ValueError(f'Bill #{bill_number} for vendor "{vendor}" already exists in another record. Edit aborted.')
        raise ValueError(f'Bill #{bill_number} already exists for vendor "{vendor}". Please use a unique bill number for this vendor.')

    header_id = None
    if is_edit:
        cur.execute(
            "SELECT id FROM erp.bill_headers WHERE lower(vendor) = lower(%s) AND lower(bill_number) = lower(%s) AND deleted_at IS NULL",
            (old_vendor, old_bill_number),
        )
        old_header = cur.fetchone()
        if old_header is None:
            raise ValueError(
                f'Original Bill #{old_bill_number} for vendor "{old_vendor}" not found in sheet. Edit aborted to prevent data corruption.'
            )
        header_id = old_header["id"]

    # poNumbers array (multi-PO support), falling back to the legacy
    # singular poNumber field. There's no mandatory top-level PO selection
    # -- each item carries its own PO -- so this is only the fallback for
    # items that don't specify one.
    raw_po = form_data.get("poNumbers") or form_data.get("poNumber") or []
    if isinstance(raw_po, str):
        raw_po_str = raw_po.strip()
        if raw_po_str.startswith("["):
            try:
                po_numbers_array = json.loads(raw_po_str)
            except ValueError:
                po_numbers_array = [raw_po_str] if raw_po_str else []
        else:
            po_numbers_array = [p.strip() for p in raw_po_str.split(",") if p.strip()]
    elif isinstance(raw_po, list):
        po_numbers_array = raw_po
    else:
        po_numbers_array = []
    default_po_number = (str(po_numbers_array[0]).strip() if po_numbers_array else "") or "DIRECT"

    bill_date = date_utils.to_safe_date(form_data.get("billDate"))
    if not bill_date:
        raise ValueError("Invalid bill date. Accepted formats: DD/MM/YYYY or YYYY-MM-DD.")

    contact = str(form_data.get("contact") or "").strip()
    remarks = str(form_data.get("remarks") or "").strip()

    # Labor Job bills only -- optional free text, blank on Goods bills.
    # Header-level: one value per bill, like vendor/contact.
    issuing_party = str(form_data.get("issuingParty") or "").strip()
    manufacturing_vendor = str(form_data.get("manufacturingVendor") or "").strip()

    bill_type = "LABOR" if str(form_data.get("billType") or "GOODS").strip().upper() == "LABOR" else "GOODS"

    # Labor Job bills carry a Process per line (item_name is then forced to
    # that process's Output Item Name, not whatever the client sent) -- build
    # the lookup once, keyed by Process Name, so every line below can
    # validate/resolve against it instead of trusting client-supplied text.
    process_by_name = {}
    if bill_type == "LABOR":
        for p in process_service._get_all_processes(cur):
            if p["active"]:
                process_by_name[p["processName"].strip().lower()] = p

    # Items the user chose "Ledger only" for in the checkStockAdjustmentConflicts
    # warning flow -- still saved and shown in the ledger, but excluded from
    # Stock's Billed Qty sum (see stock_service._get_billed_and_consumed_qty_maps).
    exclude_raw = form_data.get("excludeFromStockKeys")
    if isinstance(exclude_raw, str):
        try:
            exclude_list = json.loads(exclude_raw) if exclude_raw else []
        except ValueError:
            exclude_list = []
    elif isinstance(exclude_raw, list):
        exclude_list = exclude_raw
    else:
        exclude_list = []
    exclude_set = {str(k).strip().lower() for k in exclude_list}

    item_unit_map = items_service.get_item_unit_info_map(cur)
    units_map = units_service.get_units_map()
    vendor_id = _find_vendor_id(cur, vendor)
    user_id = get_current_user_id()

    if is_edit:
        cur.execute(
            """
            UPDATE erp.bill_headers
            SET bill_number = %s, vendor = %s, vendor_id = %s, contact = %s, bill_date = %s, remarks = %s,
                issuing_party = %s, manufacturing_vendor = %s, updated_by = %s
            WHERE id = %s
            """,
            (bill_number, vendor, vendor_id, contact, bill_date, remarks, issuing_party, manufacturing_vendor, user_id, header_id),
        )
        cur.execute("DELETE FROM erp.bill_lines WHERE header_id = %s", (header_id,))
    else:
        cur.execute(
            """
            INSERT INTO erp.bill_headers
                (bill_number, vendor, vendor_id, contact, bill_date, remarks, issuing_party, manufacturing_vendor, updated_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (bill_number, vendor, vendor_id, contact, bill_date, remarks, issuing_party, manufacturing_vendor, user_id),
        )
        header_id = cur.fetchone()["id"]

    extraction_items = []
    for item in items:
        item = item or {}
        name = str(item.get("name") or "").strip()

        # Labor Job rows: resolve the chosen Process against Process Master
        # (rejecting anything that doesn't match a real, active process) and
        # force item_name to that process's Output Item Name -- the same
        # "server owns the canonical value" rule save_production already
        # applies, so a Labor bill's item name can never drift from what the
        # process actually produces.
        line_process_name = ""
        line_color = ""
        if bill_type == "LABOR":
            raw_process_name = str(item.get("processName") or item.get("process") or "").strip()
            process = process_by_name.get(raw_process_name.lower()) if raw_process_name else None
            if not process:
                raise ValueError(
                    f'"{raw_process_name or "(blank)"}" is not a recognized active Process. '
                    f"Pick a Process for every Labor Job line."
                )
            line_process_name = process["processName"]
            name = process["outputItemName"]
            line_color = str(item.get("color") or "").strip()

        if not name:
            continue
        size = str(item.get("size") or "").strip()
        narration = str(item.get("narration") or "").strip()

        try:
            qty = float(item.get("qty"))
        except (TypeError, ValueError):
            qty = -1
        if qty < 0:
            raise ValueError("Qty must be a non-negative number.")

        try:
            price = float(item.get("price"))
        except (TypeError, ValueError):
            price = -1
        if price < 0:
            raise ValueError("Price must be a non-negative number.")

        # 18% default applies only when GST is genuinely unset -- an
        # explicit 0 (GST-exempt line) must survive, not get overridden.
        gst_raw = item.get("gst")
        gst_rate_pct = float(gst_raw) if gst_raw is not None and gst_raw != "" else 18.0
        if gst_rate_pct < 0 or gst_rate_pct > 100:
            raise ValueError("GST rate must be between 0 and 100 percent.")

        item_po_number = (str(item.get("po") or item.get("poNumber") or "").strip()) or default_po_number
        unit = str(item.get("unit") or "Pcs").strip() or "Pcs"

        # An unconvertible unit must never block saving the bill.
        unit_info = items_service.lookup_item_unit_info(item_unit_map, name, size)
        try:
            base_qty = units_service.convert_qty_to_base_unit(qty, unit, unit_info, units_map)
            base_rate = units_service.convert_rate_to_base_unit(price, unit, unit_info, units_map)
        except ValueError:
            base_qty = qty
            base_rate = price

        item_key = f"{name.lower()}|{size.lower()}"
        affects_stock = item_key not in exclude_set

        item_id = _find_item_id(cur, name, size)
        cur.execute(
            """
            INSERT INTO erp.bill_lines (header_id, po_number, item_name, size, narration, qty, unit, price,
                gst_rate_pct, base_qty, base_rate, affects_stock, item_id, bill_type, process_name, color)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                header_id,
                item_po_number,
                name,
                size,
                narration,
                qty,
                unit,
                price,
                gst_rate_pct,
                base_qty,
                base_rate,
                affects_stock,
                item_id,
                bill_type,
                line_process_name,
                line_color,
            ),
        )

        extraction_items.append(
            {"name": name, "size": size, "narration": narration, "unit": unit, "baseRate": base_rate, "poNumber": item_po_number}
        )

    # Auto-extract vendor/items/rates -- same as PO's autoExtractFromPoOrBill.
    vendors_service.ensure_vendor(cur, vendor, contact)
    for item in extraction_items:
        rate = item["baseRate"]
        if rate < _MIN_VENDOR_RATE:
            continue
        items_service._auto_extract_item(cur, item["name"], item["size"], item["narration"], item["unit"], vendor, rate)
        cur.execute(
            """
            INSERT INTO erp.rate_history (rate_date, item_name, size, narration, vendor_name, rate, po_number, bill_number)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (bill_date, item["name"], item["size"], item["narration"], vendor, rate, item["poNumber"], bill_number),
        )

    message = f"Bill #{bill_number} ({vendor}) updated successfully." if is_edit else f"Bill #{bill_number} ({vendor}) recorded successfully."

    overage_warnings = _compute_bill_overage_warnings(cur, extraction_items)
    if overage_warnings:
        message += " Warning: " + " ".join(overage_warnings)

    # Read this bill's own just-written rows back so the client can patch it
    # into an already-loaded Bill Ledger in place instead of a full reload.
    fresh_list = _load_bill_list(cur, only_header_id=header_id)
    fresh_bill = fresh_list[0] if fresh_list else None

    return build_response(True, {"billNumber": bill_number, "bill": fresh_bill}, message)


@rpc_method("deleteBill", mutation=True)
@database.transactional
def delete_bill(conn, cur, vendor, bill_number):
    valid_vendor = str(vendor or "").strip()
    valid_bill_number = str(bill_number or "").strip()
    if not valid_bill_number:
        raise ValueError("Bill number must not be empty.")

    cur.execute(
        "SELECT id FROM erp.bill_headers WHERE lower(vendor) = lower(%s) AND lower(bill_number) = lower(%s) AND deleted_at IS NULL",
        (valid_vendor, valid_bill_number),
    )
    row = cur.fetchone()
    if row is None:
        raise ValueError(f'Bill #{valid_bill_number} for vendor "{valid_vendor}" not found.')

    cur.execute(
        "UPDATE erp.bill_headers SET deleted_at = NOW(), updated_by = %s WHERE id = %s",
        (get_current_user_id(), row["id"]),
    )
    return build_response(True, None, f"Bill #{valid_bill_number} deleted successfully.")


@rpc_method("deleteBillsBulk", mutation=True)
@database.transactional
def delete_bills_bulk(conn, cur, bills):
    pairs = []
    for b in bills or []:
        b = b or {}
        vendor = str(b.get("vendor") or "").strip()
        bill_number = str(b.get("billNumber") or "").strip()
        if bill_number:
            pairs.append((vendor, bill_number))

    if not pairs:
        return build_response(True, None, "No bills selected.")

    user_id = get_current_user_id()
    deleted_keys = []
    for vendor, bill_number in pairs:
        cur.execute(
            "SELECT id FROM erp.bill_headers WHERE lower(vendor) = lower(%s) AND lower(bill_number) = lower(%s) AND deleted_at IS NULL",
            (vendor, bill_number),
        )
        row = cur.fetchone()
        if row is None:
            continue
        cur.execute("UPDATE erp.bill_headers SET deleted_at = NOW(), updated_by = %s WHERE id = %s", (user_id, row["id"]))
        deleted_keys.append({"vendor": vendor, "billNumber": bill_number})

    message = f"Deleted {len(deleted_keys)} bill(s) ({len(deleted_keys)} row(s) removed)."
    return build_response(True, {"deletedKeys": deleted_keys}, message)
