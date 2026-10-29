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

closePO / reopenPO (migration 054): the PO Ledger's Status dropdown can mark
a Partially Received PO Completed (the rest is never coming), or cancel a PO
that is not fully received. A status set by hand supersedes the derived one
(closedAs), and what each line is still owed is short (shortQty), not
pending -- so it leaves every pending figure, and new bills are no longer
suggested against it. Reopening hands the PO back to its bills.
"""

from __future__ import annotations

import json
from collections import Counter
from datetime import date

import psycopg2.extras

import database
from . import bill_service
from . import items_service
from . import units_service
from . import vendors_service
from .current_user import get_current_user_id, get_current_user_name
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
    units_map = units_service.get_units_map(cur)

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
            base_qty = units_service.convert_qty_to_base_unit(
                qty, unit, unit_info, units_map
            )
            base_rate = units_service.convert_rate_to_base_unit(
                price, unit, unit_info, units_map
            )
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


def _effective_base_qty(item: dict) -> float:
    """A PO line's ordered quantity in base units. Legacy/unconverted rows
    (baseQty 0) are 1:1 with the entered unit -- one value, used for both
    the completion check and the qty conversion, so they can't drift apart.
    """
    return item["baseQty"] if item["baseQty"] > 0 else item["qty"]


def _billed_base_by_line(po: dict, billed_map: dict) -> list:
    """Billed base quantity per line of `po`, in line order.

    Bills are matched to a PO line by item + size + narration, so two
    identical lines on one PO share a single billed total. Each line used to
    be handed that whole total: PO 1269 orders RIM---BLACK 14" twice, 1000
    each, and its one 1000-piece bill marked both lines received -- the PO
    read Completed with 1000 still to come. Identical lines now fill in
    order instead, each up to what it ordered, and the last of them takes
    whatever is left, an overage included.
    """
    keys = [
        bill_service._build_po_line_key(
            po["poNumber"], item["name"], item["size"], item["narration"]
        )
        for item in po["items"]
    ]
    lines_left = Counter(keys)
    given: dict = {}
    result = []
    for item, key in zip(po["items"], keys):
        lines_left[key] -= 1
        available = billed_map.get(key, 0) - given.get(key, 0.0)
        take = (
            available
            if lines_left[key] == 0
            else min(available, _effective_base_qty(item))
        )
        take = max(take, 0.0)
        given[key] = given.get(key, 0.0) + take
        result.append(take)
    return result


def _attach_po_status(po: dict, billed_map: dict) -> None:
    items = po["items"]
    any_billed = False
    all_lines_complete = len(items) > 0
    # Completed or cancelled by hand (closePO): nothing more is expected.
    closed_as = po.get("closedAs") or ""

    for item, billed_base_qty in zip(items, _billed_base_by_line(po, billed_map)):
        effective_base_qty = _effective_base_qty(item)
        ordered_base_qty = effective_base_qty or 0

        ratio = (item["qty"] / effective_base_qty) if effective_base_qty > 0 else 1
        item["receivedQty"] = billed_base_qty * ratio
        # Not clamped to 0 -- a negative value means this line has been
        # billed beyond what was ordered (see save_bill's advisory
        # over-billing warning). Every current reader of pendingQty already
        # filters to > 0.0001 before display, so this stays invisible in
        # "pending" lists but is now available to surface the overage.
        pending = item["qty"] - item["receivedQty"]
        # On a PO closed by hand, what is still owed is never coming: it
        # moves to shortQty, so every reader of pendingQty drops it as it
        # drops a received line. An overage stays negative, as on any PO.
        item["shortQty"] = max(pending, 0.0) if closed_as else 0.0
        item["pendingQty"] = min(pending, 0.0) if closed_as else pending

        if billed_base_qty > 0.0001:
            any_billed = True
        if ordered_base_qty - billed_base_qty > 0.0001:
            all_lines_complete = False

    if any_billed and all_lines_complete:
        from_bills = config_maps.PO_STATUS["COMPLETED"]
    elif any_billed:
        from_bills = config_maps.PO_STATUS["PARTIAL"]
    else:
        from_bills = config_maps.PO_STATUS["ISSUED"]
    # What the bills alone say -- what a reopened PO goes back to.
    po["statusFromBills"] = from_bills
    po["status"] = closed_as or from_bills


def _po_sort_num(po_number: str) -> int:
    digits = "".join(ch for ch in str(po_number) if ch.isdigit())
    return int(digits) if digits else 0


def _po_rate_in_bill_unit(po_line: dict, bill_unit: str, unit_info: dict, units_map):
    """The PO line's rate, per ONE of the unit a bill line is entered in.

    A PO raised at 1200/Box and received as Pcs has to be quoted as 100/Pcs,
    or filling the bill with it would bill every piece at the price of a box.
    The PO's own figure is returned untouched when the units already agree,
    so a rate that needs no conversion picks up no float noise from one.

    Converted from the PO line's own unit and price, NOT from its stored
    baseRate: that was computed against whatever the item's Base Unit was
    when the PO was saved -- "Pcs" by fallback, for an item the PO itself
    introduced, which savePO then creates with the PO's unit as its base.
    Both units measured against today's Items Master cannot disagree.

    None when either unit cannot be converted: no rate is better than a rate
    in the wrong unit.
    """
    po_unit = str(po_line["unit"] or "Pcs")
    if po_unit.strip().lower() == str(bill_unit or "").strip().lower():
        return po_line["price"]
    try:
        per_bill_unit = units_service.convert_qty_to_base_unit(
            1, bill_unit, unit_info, units_map
        )
        per_po_unit = units_service.convert_qty_to_base_unit(
            1, po_unit, unit_info, units_map
        )
    except ValueError:
        return None
    if per_bill_unit <= 0 or per_po_unit <= 0:
        return None
    return round(po_line["price"] * per_bill_unit / per_po_unit, 4)


# ─────────────────────────────────────────────────────────────────────────
# Lookups
# ─────────────────────────────────────────────────────────────────────────


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


# ─────────────────────────────────────────────────────────────────────────
# Auto-extraction (vendor/item/rate-history upsert -- see module docstring)
# ─────────────────────────────────────────────────────────────────────────


def _auto_extract_from_po(
    cur, vendor_name: str, contact: str, items: list, po_number: str, doc_date
) -> None:
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

        # Items Master holds a vendor's rate in the unit it was quoted in:
        # _auto_extract_item files this line's unit as the Purchase Unit
        # beside it, and every reader converts from that unit. Handed the
        # base rate instead, it filed spokes bought at Rs 100 a Gross as
        # Rs 0.69 a Gross. Rate History stays per Base Unit.
        items_service._auto_extract_item(
            cur,
            name,
            item["size"],
            item["narration"],
            item["unit"],
            vendor_name,
            item["price"],
        )

        cur.execute(
            """
            INSERT INTO erp.rate_history (rate_date, item_name, size, narration, vendor_name, rate, po_number, bill_number)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                doc_date,
                name,
                item["size"],
                item["narration"],
                vendor_name,
                rate,
                po_number,
                "",
            ),
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
               h.closed_as, h.closed_at, h.closed_by_name, h.close_note,
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

    item_unit_map = items_service.get_item_unit_info_map(cur) if rows else {}
    units_map = units_service.get_units_map(cur) if rows else {}

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
                # The status set by hand (closePO), "" when the bills decide
                # -- see _attach_po_status.
                "closedAs": row["closed_as"] or "",
                "closedAt": date_utils.to_display_string(row["closed_at"]) or "",
                "closedBy": row["closed_by_name"] or "",
                "closeNote": row["close_note"] or "",
                "items": [],
                "grandTotal": 0.0,
                "totalQty": 0.0,
            }
            po_map[po_number] = po

        qty = float(row["qty"])
        price = float(row["price"])
        unit = row["unit"] or "Pcs"
        po["items"].append(
            {
                "name": row["item_name"],
                "narration": row["narration"] or "",
                "size": row["size"] or "",
                "qty": qty,
                "unit": unit,
                "price": price,
                "baseQty": float(row["base_qty"]),
                "baseRate": float(row["base_rate"]),
                # What a rate suggested from this line is measured in --
                # see units_service.rate_per_base_unit_now.
                "ratePerBaseUnit": units_service.rate_per_base_unit_now(
                    price,
                    unit,
                    items_service.lookup_item_unit_info(
                        item_unit_map, row["item_name"], row["size"] or ""
                    ),
                    units_map,
                ),
            }
        )
        po["grandTotal"] += qty * price
        po["totalQty"] += qty

    for po in po_map.values():
        _attach_po_status(po, billed_map)

    return sorted(
        po_map.values(), key=lambda p: _po_sort_num(p["poNumber"]), reverse=True
    )


@rpc_method("getPOData")
def get_po_data():
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        _conn,
        cur,
    ):
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
        po_date = (
            existing["po_date"] if existing and existing["po_date"] else date.today()
        )
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
            raise ValueError(
                f"Original PO #{old_po_number} not found in sheet. Edit aborted to prevent data corruption."
            )
        header_id = header_row["id"]

        # What this PO's lines had billed against them before the edit, so
        # the edit can be told exactly what it strands -- and only that.
        cur.execute(
            "SELECT item_name AS name, size, narration FROM erp.po_lines WHERE header_id = %s",
            (header_id,),
        )
        before_attached = _attached_by_item(
            old_po_number,
            cur.fetchall(),
            bill_service._aggregate_billed_base_qty_by_po(cur),
        )

        # The source allows renumbering a PO with no duplicate check -- a
        # latent gap (two rows could end up sharing a PO number). Not
        # preserved as-is: a friendly pre-check here, same style as every
        # other rename-collision check in this codebase.
        renumbered = po_number.lower() != old_po_number.lower()
        if renumbered:
            cur.execute(
                "SELECT id FROM erp.po_headers WHERE lower(po_number) = lower(%s) AND deleted_at IS NULL AND id != %s",
                (po_number, header_id),
            )
            if cur.fetchone():
                raise ValueError(f"PO #{po_number} already exists.")
            # A number with a past is not free, even if no live PO holds it.
            # The uniqueness index only covers live POs, so a DELETED PO's
            # number could be taken -- and every bill still naming it would
            # silently start counting against this, a different order.
            cur.execute(
                "SELECT 1 FROM erp.po_headers WHERE lower(po_number) = lower(%s) AND id != %s",
                (po_number, header_id),
            )
            if cur.fetchone():
                raise ValueError(
                    f"PO #{po_number} belonged to a PO that has since been deleted. "
                    "Pick a number that has never been used."
                )
            cur.execute(
                "SELECT count(*) AS n FROM erp.bill_lines WHERE lower(btrim(po_number)) = lower(%s)",
                (po_number,),
            )
            named = cur.fetchone()["n"]
            if named:
                raise ValueError(
                    f"{named} bill line(s) already name PO #{po_number}. "
                    "Pick a number no bill refers to."
                )

        cur.execute(
            """
            UPDATE erp.po_headers
            SET po_number = %s, po_date = %s, vendor = %s, vendor_id = %s, contact = %s,
                po_description = %s, po_remarks = %s, supplier_remarks = %s, updated_by = %s
            WHERE id = %s
            """,
            (
                po_number,
                po_date,
                vendor,
                vendor_id,
                contact,
                po_description,
                po_remarks,
                supplier_remarks,
                user_id,
                header_id,
            ),
        )
        if renumbered:
            # Bills link to a PO by NUMBER. Renaming the PO without carrying
            # the new number to them used to disconnect every bill against
            # it: the order fell back to "PO Issued" with its full quantity
            # pending, and the bills fulfilled nothing. Rate history names
            # the PO too, so it moves with it rather than pointing at a
            # number that no longer exists.
            cur.execute(
                "UPDATE erp.bill_lines SET po_number = %s WHERE lower(btrim(po_number)) = lower(%s)",
                (po_number, old_po_number),
            )
            cur.execute(
                "UPDATE erp.rate_history SET po_number = %s WHERE lower(btrim(po_number)) = lower(%s)",
                (po_number, old_po_number),
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
            (
                po_number,
                po_date,
                vendor,
                vendor_id,
                contact,
                po_description,
                po_remarks,
                supplier_remarks,
                user_id,
            ),
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

    message = (
        f"PO #{po_number} ({vendor}) updated successfully."
        if is_edit
        else f"PO #{po_number} ({vendor}) created successfully."
    )

    repeated = _repeated_lines(items)
    if repeated:
        message += (
            f" Note: {', '.join(repeated)} {'is' if len(repeated) == 1 else 'are'} on this "
            "PO more than once with the same narration. Bills fill those lines in order -- "
            "merge them, or tell them apart in Narration."
        )

    # Read this PO's own just-written rows back so the client can patch it
    # into an already-loaded list in place instead of a full reload.
    fresh_billed_map = bill_service._aggregate_billed_base_qty_by_po(cur)
    fresh_list = _load_po_list(cur, fresh_billed_map, only_po_number=po_number)
    fresh_po = fresh_list[0] if fresh_list else None

    if is_edit:
        after_attached = _attached_by_item(po_number, items, fresh_billed_map)
        stranded = sorted(
            f'"{name}{" " + size if size else ""}"'
            for (name, size), billed in before_attached.items()
            if billed > after_attached.get((name, size), 0.0) + 0.0001
        )
        if stranded:
            message += (
                f" Warning: {', '.join(stranded)} "
                f"{'has' if len(stranded) == 1 else 'have'} already been billed against this PO "
                "but no longer appear on it, so those bills now fulfil nothing. "
                "Put the item back, or mark those bill lines Direct."
            )

    return build_response(True, {"poNumber": po_number, "po": fresh_po}, message)


def _repeated_lines(items) -> list:
    """Each item a PO orders on more than one line with nothing -- not even
    narration -- telling those lines apart, as "NAME [size]"."""

    def part(v) -> str:
        return str(v if v is not None else "").strip().lower()

    counts = Counter(
        (part(i["name"]), part(i["size"]), part(i["narration"])) for i in items
    )
    labels = []
    for item in items:
        key = (part(item["name"]), part(item["size"]), part(item["narration"]))
        label = f'"{item["name"]}{" [" + item["size"] + "]" if item["size"] else ""}"'
        if counts[key] > 1 and label not in labels:
            labels.append(label)
    return labels


def _attached_by_item(po_number, lines, billed_map) -> dict:
    """Billed base quantity attached to a PO's lines, per (item, size).

    Bills link to a PO line by item + size (+ narration where the PO needs
    it to tell two lines apart), so removing a line, or renaming its item
    or size, leaves what was already billed against it attached to nothing
    -- the PO then reads as though those goods never came. Comparing this
    before and after an edit names exactly what the edit stranded, and
    nothing that was already unmatched beforehand.

    Grouped per item + size rather than per line, so an edit that only
    re-words a narration -- which the billed aggregate's fallback still
    connects when the item has a single line -- is not reported as a loss.
    """
    attached = {}
    seen = set()
    for line in lines or []:
        key = bill_service._build_po_line_key(
            po_number, line["name"], line["size"], line["narration"]
        )
        if key in seen:  # two identical lines share one billed total
            continue
        seen.add(key)
        group = (
            str(line["name"] or "").strip().lower(),
            str(line["size"] or "").strip().lower(),
        )
        attached[group] = attached.get(group, 0.0) + float(
            (billed_map or {}).get(key, 0.0)
        )
    return attached


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
    return build_response(
        True, None, f"PO #{target} deleted." + _bills_still_naming(cur, [target])
    )


def _bills_still_naming(cur, po_numbers) -> str:
    """A sentence to append to a delete's confirmation, naming how many
    bill lines still point at the PO(s) just deleted -- or "" if none do.

    Bills are an independent financial record and a PO delete never touches
    them. But a bill line naming a deleted PO fulfils nothing, and the bill
    form will refuse to re-save it until it is marked Direct or linked to an
    open PO (bill_service._assert_po_links_are_live). Saying so at the
    moment of deleting is what makes that a to-do rather than a surprise.
    """
    keys = [str(p).strip().lower() for p in po_numbers if str(p).strip()]
    if not keys:
        return ""
    cur.execute(
        """
        SELECT count(*) AS lines, count(DISTINCT h.id) AS bills
        FROM erp.bill_lines l
        JOIN erp.bill_headers h ON h.id = l.header_id
        WHERE h.deleted_at IS NULL AND lower(btrim(l.po_number)) = ANY(%s)
        """,
        (keys,),
    )
    row = cur.fetchone()
    if not row or not row["lines"]:
        return ""
    return (
        f" {row['lines']} line(s) on {row['bills']} bill(s) still name "
        f"{'this PO' if len(keys) == 1 else 'these POs'}: mark them Direct, "
        "or link them to an open PO, next time those bills are edited."
    )


@rpc_method("deletePOsBulk", mutation=True)
@database.transactional
def delete_pos_bulk(conn, cur, po_numbers):
    targets = {
        str(p or "").strip().lower() for p in (po_numbers or []) if str(p or "").strip()
    }
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

    return build_response(
        True,
        {"deletedIds": list(targets)},
        f"Deleted {rows_deleted} PO(s)." + _bills_still_naming(cur, list(targets)),
    )


# Longer than the screen's reason box ever sends.
_MAX_CLOSE_NOTE = 500


def _lock_live_po_header(cur, po_number: str):
    cur.execute(
        """
        SELECT id, po_number, closed_as FROM erp.po_headers
        WHERE lower(po_number) = lower(%s) AND deleted_at IS NULL
        FOR UPDATE
        """,
        (po_number,),
    )
    return cur.fetchone()


def _load_one_po(cur, po_number: str):
    listed = _load_po_list(
        cur, bill_service._aggregate_billed_base_qty_by_po(cur), po_number
    )
    return listed[0] if listed else None


@rpc_method("closePO", mutation=True)
@database.transactional
def close_po(conn, cur, po_number, closed_as, note=""):
    """Sets a PO's status by hand: Completed or Cancelled.

    Completed is for a Partially Received PO whose balance is never coming;
    with nothing received yet there is nothing to complete, and the PO is
    cancelled instead. Cancelled is for any PO not received in full -- what
    did arrive stays received.
    """
    target = str(po_number or "").strip()
    if not target:
        raise ValueError("PO number must not be empty.")
    completed = config_maps.PO_STATUS["COMPLETED"]
    cancelled = config_maps.PO_STATUS["CANCELLED"]
    wanted = {completed.lower(): completed, cancelled.lower(): cancelled}.get(
        str(closed_as or "").strip().lower()
    )
    if wanted is None:
        raise ValueError("A PO can be set to Completed or Cancelled by hand.")
    note = str(note or "").strip()
    if len(note) > _MAX_CLOSE_NOTE:
        raise ValueError(f"Keep the reason under {_MAX_CLOSE_NOTE} characters.")

    header = _lock_live_po_header(cur, target)
    if header is None:
        raise ValueError(f"PO #{target} not found.")
    shown = header["po_number"]
    if header["closed_as"]:
        raise ValueError(
            f"PO #{shown} is already {header['closed_as']}. Reopen it first."
        )

    po = _load_one_po(cur, shown)
    from_bills = po["statusFromBills"] if po else None
    if from_bills == completed:
        raise ValueError(f"PO #{shown} has been received in full already.")
    if wanted == completed and from_bills != config_maps.PO_STATUS["PARTIAL"]:
        raise ValueError(
            f"Nothing has been received against PO #{shown} yet, so there is "
            "nothing to complete. Cancel it instead."
        )
    if po is None:
        raise ValueError(f"PO #{shown} has no items.")

    user_id = get_current_user_id()
    cur.execute(
        """
        UPDATE erp.po_headers
           SET closed_as = %s, closed_at = NOW(), closed_by = %s,
               closed_by_name = %s, close_note = %s, updated_by = %s
         WHERE id = %s
        """,
        (wanted, user_id, get_current_user_name(), note, user_id, header["id"]),
    )

    fresh = _load_one_po(cur, shown)
    left = [
        f"{units_service.format_qty(item['shortQty'])} {item['unit']} {item['name']}"
        + (f" [{item['size']}]" if item["size"] else "")
        for item in fresh["items"]
        if item["shortQty"] > 0.0001
    ]
    message = (
        f"PO #{shown} {'marked complete' if wanted == completed else 'cancelled'}."
    )
    if left:
        message += f" No longer pending: {', '.join(left)}."
    return build_response(True, {"poNumber": shown, "po": fresh}, message)


@rpc_method("reopenPO", mutation=True)
@database.transactional
def reopen_po(conn, cur, po_number):
    """Undoes closePO: the PO's status follows its bills again."""
    target = str(po_number or "").strip()
    if not target:
        raise ValueError("PO number must not be empty.")

    header = _lock_live_po_header(cur, target)
    if header is None:
        raise ValueError(f"PO #{target} not found.")
    shown = header["po_number"]
    if not header["closed_as"]:
        raise ValueError(
            f"PO #{shown} was not completed or cancelled by hand, "
            "so there is nothing to reopen."
        )

    cur.execute(
        """
        UPDATE erp.po_headers
           SET closed_as = NULL, closed_at = NULL, closed_by = NULL,
               closed_by_name = NULL, close_note = '', updated_by = %s
         WHERE id = %s
        """,
        (get_current_user_id(), header["id"]),
    )

    fresh = _load_one_po(cur, shown)
    message = f"PO #{shown} reopened."
    if fresh:
        message += f" It is {fresh['status']} again."
    return build_response(True, {"poNumber": shown, "po": fresh}, message)


@rpc_method("suggestPoAllocations")
def suggest_po_allocations(vendor, items, bill_date=None, editing=None):
    """Given a vendor + a set of unlinked bill line items, suggests which
    open PO line(s) each most likely belongs to. Never writes -- only
    proposes allocations for the UI to confirm/override before a bill save.
    Fails open: any internal error returns success with an empty list
    rather than blocking bill entry.

    `editing` -- {"vendor", "billNumber"} of the bill being edited, if any --
    leaves that bill's own saved lines out of what each PO has received.
    Counted in, they made the PO look already received by the very bill
    being matched: editing bill 288 from 500 to 498 cartons found PO 1187
    full and saved the line Direct, and the 500 still showed as pending.
    """
    try:
        vendor_name = str(vendor or "").strip()
        if not vendor_name or not isinstance(items, list) or len(items) == 0:
            return build_response(True, [])

        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            _conn,
            cur,
        ):
            editing = editing if isinstance(editing, dict) else {}
            billed_map = bill_service._aggregate_billed_base_qty_by_po(
                cur,
                exclude_header_id=bill_service.find_live_bill_id(
                    cur, editing.get("vendor"), editing.get("billNumber")
                ),
            )
            all_pos = _load_po_list(cur, billed_map)
            item_unit_map = items_service.get_item_unit_info_map(cur)
            # Inside the block: `cur` is closed once the `with` exits
            # (PERF-003 -- this used to open a second connection out here).
            units_map = units_service.get_units_map(cur)

        # A PO completed or cancelled by hand expects nothing more, however
        # much it is short.
        vendor_pos = [
            po
            for po in all_pos
            if po["vendor"].strip().lower() == vendor_name.lower()
            and not po["closedAs"]
        ]
        if not vendor_pos:
            return build_response(True, [])

        bill_date_obj = date_utils.to_safe_date(bill_date)
        if bill_date_obj:
            vendor_pos = [
                po
                for po in vendor_pos
                if not po["poDateRaw"]
                or date_utils.to_safe_date(po["poDateRaw"]) <= bill_date_obj
            ]
        if not vendor_pos:
            return build_response(True, [])

        # Flatten to open PO lines (remaining base qty > 0), oldest PO first.
        candidates = []
        for po in vendor_pos:
            for po_item, billed_base_qty in zip(
                po["items"], _billed_base_by_line(po, billed_map)
            ):
                remaining_base_qty = _effective_base_qty(po_item) - billed_base_qty
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
                            # Today's reading of the PO's rate, not the one
                            # stored with it -- a line saved while its unit
                            # was missing holds a base rate 144x too high,
                            # and would disagree with every bill line.
                            "baseRate": po_item["ratePerBaseUnit"],
                            "remainingBaseQty": remaining_base_qty,
                        }
                    )

        candidates.sort(
            key=lambda c: (c["poDateRaw"] or "", _po_sort_num(c["poNumber"]))
        )

        # Grouped once by (name,size) so each bill line's lookup is O(1).
        # Each group holds the SAME candidate dicts (not copies), so
        # mutating remainingBaseQty further down correctly reduces capacity
        # for every other bill row sharing this key.
        candidates_by_key: dict = {}
        for c in candidates:
            key = f"{c['name'].lower()}|{c['size'].lower()}"
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
                results.append(
                    {"rowIndex": row_index, "allocations": [], "unmatchedQty": qty}
                )
                continue

            unit_info = items_service.lookup_item_unit_info(item_unit_map, name, size)
            try:
                base_qty = units_service.convert_qty_to_base_unit(
                    qty, unit, unit_info, units_map
                )
                base_rate = units_service.convert_rate_to_base_unit(
                    price, unit, unit_info, units_map
                )
            except ValueError:
                base_qty = qty
                base_rate = price

            # qty-per-1-baseQty, used to convert allocated base qty back to
            # the unit this bill line was actually entered in.
            ratio = (qty / base_qty) if base_qty > 0 else 1

            same_name_size = [
                c
                for c in candidates_by_key.get(f"{name.lower()}|{size.lower()}", [])
                if c["remainingBaseQty"] > 0.0001
            ]

            # Narration and price decide which open PO is filled FIRST; they
            # never shut the others out. As filters they did: the rest of a
            # bill went Direct while an older order for the same item still
            # waited -- bill 522 put 1000 pairs on PO 1271, the one PO with
            # its exact narration, and sent 1000 Direct with PO 1205's 2000
            # pending; the PO then read as owed goods that had arrived.
            narration = str(item.get("narration") or "").strip().lower()

            def same_narration(c):
                return bool(narration) and c["narration"].strip().lower() == narration

            # The one exception: a PO ordering this item on several lines
            # that narration tells apart (16T and 18T freewheels). Where one
            # of them carries the bill's narration, that is the line meant,
            # and the PO's others are different goods.
            meant = {c["poNumber"] for c in same_name_size if same_narration(c)}
            eligible = [
                c
                for c in same_name_size
                if c["poNumber"] not in meant or same_narration(c)
            ]
            # Stable, so the oldest PO still comes first within each rank.
            matching = sorted(
                eligible,
                key=lambda c: (
                    not same_narration(c),
                    not (
                        price > 0
                        and abs(c["baseRate"] - base_rate) <= _PO_PRICE_MATCH_EPSILON
                    ),
                ),
            )

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
                #
                # The PO's rate travels on every allocation, not only on a
                # conflict: a bill line entered with no price yet is filled
                # from the PO it draws down, and a conflict can only be
                # reported once there is a bill price to disagree with.
                allocation = {
                    "poNumber": c["poNumber"],
                    "qty": round(take * ratio, 4),
                    "poRate": c["price"],
                    "poUnit": c["unit"],
                    "poRateInBillUnit": _po_rate_in_bill_unit(
                        c, unit, unit_info, units_map
                    ),
                }
                if (
                    price > 0
                    and abs(c["baseRate"] - base_rate) > _PO_PRICE_MATCH_EPSILON
                ):
                    allocation["rateConflict"] = {
                        "poRate": c["price"],
                        "poUnit": c["unit"],
                        # What adopting the PO's rate puts on this line --
                        # quoted in the line's own unit, which stays.
                        "poRateInBillUnit": allocation["poRateInBillUnit"],
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
