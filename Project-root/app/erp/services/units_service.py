"""Unit Master, ported from Apps_Script/module_units.js.

getUnitsData/saveUnit/deleteUnit are the RPC-exposed CRUD surface. The
conversion helpers (get_units_map/lookup_unit/convert_qty_to_base_unit/
convert_rate_to_base_unit) are plain internal functions -- not RPC methods --
for later modules (Items, PO, Bill) to import, exactly mirroring how
module_units.js's non-underscore-but-still-internal helpers are only ever
called server-side from other modules, never via google.script.run.

Deliberately not ported: Apps Script's LockService document lock (Postgres's
own transaction + the partial unique index on lower(unit_name) give strictly
stronger correctness) and the CacheService list cache (a SELECT against this
table is not the bottleneck the Sheets API was).
"""

from __future__ import annotations

import psycopg2.extras

import database
from . import rename_utils
from .current_user import get_current_user_id
from .. import config_maps
from ..envelope import build_response
from ..registry import rpc_method

# Sheets whose UNIT column gets renamed alongside a Unit Master rename.
# Guarded by config_maps.TABLE_NAMES -- entries not yet present there (every
# one of these, until later phases) are silently skipped, exactly like the
# source's try/catch around a missing sheet. PO/BILL/RETURN are denormalized
# (header+lines); UNIT is line-level, so these target the *_LINES table, not
# a flat "PO"/"BILL"/"RETURN" entry (see config_maps.TABLE_NAMES).
_UNIT_RENAME_SINGLE_COLUMN_TARGETS = [
    ("PO_LINES", "unit"),
    ("BILL_LINES", "unit"),
    ("RETURN_LINES", "unit"),
    ("WASTAGE_LINES", "unit"),
    ("ISSUE_LINES", "unit"),
]

# Items Master has two unit-name columns to rename.
_ITEMS_UNIT_FIELDS = ["baseUnit", "purchaseUnit"]


def _rename_unit_everywhere(cur, old_name: str, new_name: str) -> None:
    old = (old_name or "").strip()
    new = (new_name or "").strip()
    if not old or not new or old == new:
        return

    for sheet_key, field in _UNIT_RENAME_SINGLE_COLUMN_TARGETS:
        table = config_maps.TABLE_NAMES.get(sheet_key)
        if not table:
            continue
        rename_utils.rename_in_column(cur, table, config_maps.to_snake_case(field), old, new)

    items_table = config_maps.TABLE_NAMES.get("ITEMS")
    if items_table:
        for field in _ITEMS_UNIT_FIELDS:
            rename_utils.rename_in_column(cur, items_table, config_maps.to_snake_case(field), old, new)


@rpc_method("getUnitsData")
def get_units_data():
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        cur.execute(
            """
            SELECT unit_name, family, factor_to_base, remarks
            FROM erp.units
            WHERE deleted_at IS NULL
            ORDER BY lower(unit_name)
            """
        )
        rows = cur.fetchall()

    units = [
        {
            "unitName": row["unit_name"],
            "family": row["family"],
            "factorToBase": float(row["factor_to_base"]),
            "remarks": row["remarks"] or "",
        }
        for row in rows
    ]
    return build_response(True, units)


@rpc_method("saveUnit", mutation=True)
@database.transactional
def save_unit(conn, cur, form_data):
    form_data = form_data or {}

    new_name = str(form_data.get("unitName") or "").strip()
    if not new_name:
        raise ValueError("Unit name must not be empty.")

    family = str(form_data.get("family") or "").strip()
    if not family:
        raise ValueError("Family must not be empty.")

    try:
        factor = float(form_data.get("factorToBase"))
    except (TypeError, ValueError):
        factor = None
    if factor is None or factor <= 0:
        raise ValueError("Factor to Base must be a positive number.")

    remarks = str(form_data.get("remarks") or "").strip()

    is_edit = bool(form_data.get("originalUnitName"))
    original_name = str(form_data.get("originalUnitName")).strip() if is_edit else new_name

    cur.execute(
        "SELECT id FROM erp.units WHERE lower(unit_name) = lower(%s) AND deleted_at IS NULL",
        (original_name,),
    )
    existing = cur.fetchone()

    if is_edit and existing is None:
        raise ValueError("Original unit not found.")
    if not is_edit and existing is not None:
        raise ValueError(f'Unit "{new_name}" already exists.')

    if is_edit and new_name.lower() != original_name.lower():
        cur.execute(
            "SELECT id FROM erp.units WHERE lower(unit_name) = lower(%s) AND deleted_at IS NULL AND id != %s",
            (new_name, existing["id"]),
        )
        if cur.fetchone():
            raise ValueError(f'Another unit named "{new_name}" already exists.')

    user_id = get_current_user_id()

    if is_edit:
        cur.execute(
            """
            UPDATE erp.units
            SET unit_name = %s, family = %s, factor_to_base = %s, remarks = %s, updated_by = %s
            WHERE id = %s
            """,
            (new_name, family, factor, remarks, user_id, existing["id"]),
        )
    else:
        cur.execute(
            """
            INSERT INTO erp.units (unit_name, family, factor_to_base, remarks, updated_by)
            VALUES (%s, %s, %s, %s, %s)
            """,
            (new_name, family, factor, remarks, user_id),
        )

    if is_edit and new_name != original_name:
        _rename_unit_everywhere(cur, original_name, new_name)

    message = f'Unit "{new_name}" updated.' if is_edit else f'Unit "{new_name}" added.'
    return build_response(True, {"unitName": new_name}, message)


@rpc_method("deleteUnit", mutation=True)
@database.transactional
def delete_unit(conn, cur, unit_name):
    target = str(unit_name or "").strip()
    if not target:
        raise ValueError("Unit not found.")

    cur.execute(
        "SELECT id FROM erp.units WHERE lower(unit_name) = lower(%s) AND deleted_at IS NULL",
        (target,),
    )
    row = cur.fetchone()
    if row is None:
        raise ValueError("Unit not found.")

    cur.execute(
        "UPDATE erp.units SET deleted_at = NOW(), updated_by = %s WHERE id = %s",
        (get_current_user_id(), row["id"]),
    )
    return build_response(True, None, f'Unit "{unit_name}" deleted.')


@rpc_method("deleteUnitsBulk", mutation=True)
@database.transactional
def delete_units_bulk(conn, cur, unit_names):
    targets = {str(n or "").strip().lower() for n in (unit_names or []) if str(n or "").strip()}
    if not targets:
        return build_response(True, None, "No units selected.")

    cur.execute(
        """
        UPDATE erp.units SET deleted_at = NOW(), updated_by = %s
        WHERE deleted_at IS NULL AND lower(unit_name) = ANY(%s)
        """,
        (get_current_user_id(), list(targets)),
    )
    rows_deleted = cur.rowcount
    return build_response(True, None, f"Deleted {rows_deleted} unit(s).")


# ─────────────────────────────────────────────────────────────────────────
# Conversion helpers (not RPC methods) -- for module_items.js/module_po.js/
# module_bill.js's Python ports to import in a later round.
# ─────────────────────────────────────────────────────────────────────────


def get_units_map() -> dict:
    """{unit_name.lower(): {"unitName", "family", "factorToBase"}} for every active unit."""
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        cur.execute("SELECT unit_name, family, factor_to_base FROM erp.units WHERE deleted_at IS NULL")
        rows = cur.fetchall()
    return {
        row["unit_name"].strip().lower(): {
            "unitName": row["unit_name"],
            "family": row["family"],
            "factorToBase": float(row["factor_to_base"]),
        }
        for row in rows
        if row["unit_name"]
    }


def lookup_unit(unit_name: str, fallback_family: str, units_map: dict) -> dict:
    """Defaults to factor 1 for an unknown unit, matching the source's
    typo-tolerant fallback (an unrecognized unit is treated as already being
    the base unit rather than hard-failing the save).
    """
    entry = units_map.get(str(unit_name or "").strip().lower())
    if entry:
        return entry
    return {"unitName": unit_name, "family": fallback_family, "factorToBase": 1}


def convert_qty_to_base_unit(qty, from_unit: str, item: dict, units_map: dict | None = None) -> float:
    """Converts `qty` in `from_unit` into item['baseUnit'].

    Same family (e.g. Gross -> Pcs, both 'Count'): factor ratio.
    Crossing families (only Weight -> Count is supported): via
    item['weightPerBaseUnit'] (grams per Base Unit).
    """
    units_map = units_map if units_map is not None else get_units_map()
    base_unit_name = item.get("baseUnit") or "Pcs"
    base_entry = lookup_unit(base_unit_name, "Count", units_map)
    from_entry = lookup_unit(from_unit, base_entry["family"], units_map)

    q = float(qty or 0)

    if from_entry["family"] == base_entry["family"]:
        return (q * from_entry["factorToBase"]) / base_entry["factorToBase"]

    weight_per_base_unit = float(item.get("weightPerBaseUnit") or 0)
    if weight_per_base_unit <= 0:
        raise ValueError(
            f'Cannot convert "{from_unit}" ({from_entry["family"]}) to "{base_unit_name}" '
            f'({base_entry["family"]}) -- set a Weight per {base_unit_name} on this item first.'
        )

    if from_entry["family"] == "Weight" and base_entry["family"] == "Count":
        qty_in_grams = q * from_entry["factorToBase"]
        return qty_in_grams / weight_per_base_unit

    raise ValueError(f'Unsupported unit conversion from "{from_unit}" to "{base_unit_name}".')


def convert_rate_to_base_unit(rate, from_unit: str, item: dict, units_map: dict | None = None) -> float:
    """Inverse of convert_qty_to_base_unit: rate per `from_unit` -> rate per item's Base Unit."""
    units_map = units_map if units_map is not None else get_units_map()
    base_units_per_from_unit = convert_qty_to_base_unit(1, from_unit, item, units_map)
    if base_units_per_from_unit <= 0:
        return 0.0
    return float(rate or 0) / base_units_per_from_unit
