"""Vendors master, ported from Apps_Script/module_vendors.js.

getVendorsData/saveVendor/deleteVendor/deleteVendorsBulk are the RPC-exposed
CRUD surface -- same shape as Phase 1a's Units/Tags masters.

autoExtractFromPoOrBill itself isn't a standalone RPC method -- its two
halves (ensure_vendor here, items_service._auto_extract_item) already run
unconditionally on every PO/Bill save (po_service._auto_extract_from_po,
bill_service's own save path), matching the source's "not optional/bonus
behavior" design. syncVendorsFromPOHistory below is the explicit,
user-triggered backfill of that same pairing across *existing* PO history
(e.g. for rows that predate this auto-extraction, or were bulk-imported
directly into the DB) -- it intentionally skips the Rate History insert
that a live PO save also does, since re-running that per historical row
would duplicate Rate History entries that already exist from the original
save; ensure_vendor/_auto_extract_item are both idempotent upserts, so
re-running just those two is safe to call repeatedly.

Deliberately not ported: LockService/CacheService, same reasoning as every
prior master (Phase 1a) -- Postgres transactions + unique indexes are
strictly stronger, and a SELECT against this table isn't the bottleneck the
Sheets API was.
"""

from __future__ import annotations

import psycopg2.extras

import database
from . import items_service
from . import rename_utils
from .current_user import get_current_user_id
from .. import config_maps
from ..envelope import build_response
from ..registry import rpc_method

# Sheets whose VENDOR column gets renamed alongside a Vendors master rename.
# Guarded by config_maps.TABLE_NAMES -- entries not yet present there are
# silently skipped. PO/BILL/RETURN are denormalized (header+lines); VENDOR
# is header-level, so these target the *_HEADERS table, not a flat
# "PO"/"BILL"/"RETURN" entry (see config_maps.TABLE_NAMES).
_VENDOR_RENAME_SINGLE_COLUMN_TARGETS = [
    ("PO_HEADERS", "vendor"),
    ("BILL_HEADERS", "vendor"),
    ("RETURN_HEADERS", "vendor"),
    ("WASTAGE_HEADERS", "vendor"),
    ("BOM_LINES", "vendor"),
]


def _rename_vendor_everywhere(cur, old_name: str, new_name: str) -> None:
    old = (old_name or "").strip()
    new = (new_name or "").strip()
    if not old or not new or old == new:
        return

    for sheet_key, field in _VENDOR_RENAME_SINGLE_COLUMN_TARGETS:
        table = config_maps.TABLE_NAMES.get(sheet_key)
        if not table:
            continue
        rename_utils.rename_in_column(cur, table, config_maps.to_snake_case(field), old, new)

    # Items Master's vendor list is a normal relational column here (not the
    # source's JSON-in-a-cell), and it's real today -- unlike every target
    # above, this one actually fires.
    cur.execute(
        "UPDATE erp.item_vendors SET vendor = %s WHERE lower(vendor) = lower(%s)",
        (new, old),
    )


def ensure_vendor(cur, name: str, contact: str) -> None:
    """The vendor-upsert half of module_vendors.js's autoExtractFromPoOrBill.
    Plain cur-based helper (not its own transaction) -- callers (PO/Bill
    save) run this inside their own transaction. Creates the vendor if
    missing; fills a blank contact if the vendor exists but has none.
    Never overwrites an existing non-blank contact.
    """
    name = (name or "").strip()
    if not name:
        return
    contact = (contact or "").strip()

    cur.execute(
        "SELECT id, contact FROM erp.vendors WHERE lower(vendor_name) = lower(%s) AND deleted_at IS NULL",
        (name,),
    )
    row = cur.fetchone()
    if row is None:
        cur.execute(
            "INSERT INTO erp.vendors (vendor_name, contact, remarks) VALUES (%s, %s, %s)",
            (name, contact, "Auto-extracted on save"),
        )
    elif contact and not (row["contact"] or "").strip():
        cur.execute("UPDATE erp.vendors SET contact = %s WHERE id = %s", (contact, row["id"]))


@rpc_method("getVendorsData")
def get_vendors_data():
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        cur.execute(
            """
            SELECT vendor_name, contact, address, gstin, remarks
            FROM erp.vendors
            WHERE deleted_at IS NULL
            ORDER BY lower(vendor_name)
            """
        )
        rows = cur.fetchall()

    vendors = [
        {
            "name": row["vendor_name"],
            "contact": row["contact"] or "",
            "address": row["address"] or "",
            "gstin": row["gstin"] or "",
            "remarks": row["remarks"] or "",
        }
        for row in rows
    ]
    return build_response(True, vendors)


@rpc_method("saveVendor", mutation=True)
@database.transactional
def save_vendor(conn, cur, form_data):
    form_data = form_data or {}

    new_name = str(form_data.get("vendorName") or "").strip()
    if not new_name:
        raise ValueError("Vendor name cannot be empty.")

    contact = str(form_data.get("contact") or "").strip()
    address = str(form_data.get("address") or "").strip()
    gstin = str(form_data.get("gstin") or "").strip()
    remarks = str(form_data.get("remarks") or "").strip()

    is_edit = bool(form_data.get("originalVendorName"))
    original_name = str(form_data.get("originalVendorName")).strip() if is_edit else new_name

    cur.execute(
        "SELECT id FROM erp.vendors WHERE lower(vendor_name) = lower(%s) AND deleted_at IS NULL",
        (original_name,),
    )
    existing = cur.fetchone()

    if is_edit and existing is None:
        raise ValueError("Original vendor not found in sheet.")
    if not is_edit and existing is not None:
        raise ValueError("A vendor with this name already exists.")

    if is_edit and new_name.lower() != original_name.lower():
        cur.execute(
            "SELECT id FROM erp.vendors WHERE lower(vendor_name) = lower(%s) AND deleted_at IS NULL AND id != %s",
            (new_name, existing["id"]),
        )
        if cur.fetchone():
            raise ValueError("Another vendor with this new name already exists.")

    user_id = get_current_user_id()

    if is_edit:
        cur.execute(
            """
            UPDATE erp.vendors
            SET vendor_name = %s, contact = %s, address = %s, gstin = %s, remarks = %s, updated_by = %s
            WHERE id = %s
            """,
            (new_name, contact, address, gstin, remarks, user_id, existing["id"]),
        )
        # Plain string compare (not case-insensitive) -- a casing-only edit
        # must still cascade, matching every prior rename cascade.
        if new_name != original_name:
            _rename_vendor_everywhere(cur, original_name, new_name)
    else:
        cur.execute(
            "INSERT INTO erp.vendors (vendor_name, contact, address, gstin, remarks, updated_by) VALUES (%s, %s, %s, %s, %s, %s)",
            (new_name, contact, address, gstin, remarks, user_id),
        )

    message = "Vendor profile updated successfully." if is_edit else "New Vendor registered."
    return build_response(True, {"name": new_name}, message)


@rpc_method("deleteVendor", mutation=True)
@database.transactional
def delete_vendor(conn, cur, vendor_name):
    target = str(vendor_name or "").strip()
    if not target:
        raise ValueError("Vendor not found.")

    cur.execute(
        "SELECT id FROM erp.vendors WHERE lower(vendor_name) = lower(%s) AND deleted_at IS NULL",
        (target,),
    )
    row = cur.fetchone()
    if row is None:
        raise ValueError("Vendor not found.")

    cur.execute(
        "UPDATE erp.vendors SET deleted_at = NOW(), updated_by = %s WHERE id = %s",
        (get_current_user_id(), row["id"]),
    )
    return build_response(True, None, f'Vendor "{vendor_name}" deleted from master.')


@rpc_method("deleteVendorsBulk", mutation=True)
@database.transactional
def delete_vendors_bulk(conn, cur, vendor_names):
    targets = {str(n or "").strip().lower() for n in (vendor_names or []) if str(n or "").strip()}
    if not targets:
        return build_response(True, None, "No vendors selected.")

    user_id = get_current_user_id()
    cur.execute(
        """
        UPDATE erp.vendors SET deleted_at = NOW(), updated_by = %s
        WHERE deleted_at IS NULL AND lower(vendor_name) = ANY(%s)
        """,
        (user_id, list(targets)),
    )
    rows_deleted = cur.rowcount

    return build_response(True, None, f"Deleted {rows_deleted} vendor(s) from master.")


@rpc_method("syncVendorsFromPOHistory", mutation=True)
@database.transactional
def sync_vendors_from_po_history(conn, cur):
    """Backfills Vendor Master + item-vendor rates from every existing PO
    line -- see the module docstring for why this only replays
    ensure_vendor/_auto_extract_item (both idempotent) and not the Rate
    History insert a live PO save also does.
    """
    cur.execute(
        """
        SELECT h.vendor, h.contact, l.item_name, l.size, l.narration, l.unit, l.base_rate
        FROM erp.po_headers h
        JOIN erp.po_lines l ON l.header_id = h.id
        WHERE h.deleted_at IS NULL
        """
    )
    rows = cur.fetchall()

    synced_vendors = set()
    items_synced = 0
    for row in rows:
        vendor_name = (row["vendor"] or "").strip()
        if not vendor_name:
            continue
        if vendor_name.lower() not in synced_vendors:
            ensure_vendor(cur, vendor_name, row["contact"] or "")
            synced_vendors.add(vendor_name.lower())

        item_name = (row["item_name"] or "").strip()
        rate = row["base_rate"]
        if item_name and rate is not None and float(rate) >= items_service.MIN_VENDOR_RATE:
            items_service._auto_extract_item(cur, item_name, row["size"], row["narration"], row["unit"], vendor_name, rate)
            items_synced += 1

    message = f"Synced {len(synced_vendors)} vendor(s) and {items_synced} item-vendor rate(s) from PO history."
    return build_response(True, {"vendors": len(synced_vendors), "items": items_synced}, message)
