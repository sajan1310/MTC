"""Contractors + Contractor Rates + Contractor Payments, ported from
Apps_Script/module_contractors.js. Fully self-contained -- its only real
cross-module dependency (Production/Dispatch, for the ledger reports'
Payable side) degrades gracefully to a guarded no-op, same tolerance every
other not-yet-ported dependency in this codebase gets.

Registering CONTRACTOR_RATES activates
process_service._rename_process_name_in_contractor_rates, a guarded no-op
since Phase 3a -- no code changes needed there. Symmetrically,
_rename_contractor_everywhere below reaches erp.bom_additional_costs.contractor_name
immediately too, since BOM_ADDITIONAL_COSTS was registered in Phase 3c
specifically for this.

Contractor Rates is keyed on (Contractor Name, Process **Name**) -- a free
string, not a Process ID (confirmed by reading _getContractorRate
directly: pure string comparison, no ID column anywhere on this sheet).
_getContractorRate/_get_contractor_rate is the cross-module dependency
Production/Dispatch will call once ported to resolve a lot's/logistics
payable at save time -- built now even with no caller yet, since it's
read-only and side-effect-free.

getContractorLedgerData/getContractorAccountLedger are derived,
computed-on-read reports (no table of their own). Ported now (cheap,
side-effect-free, and Contractor Payments -- half of the balance -- is
real this round), but the Payable side is structurally empty until
Production/Dispatch land: a contractor with only payments recorded still
shows up correctly (totalPayable=0, totalPaid=X, balanceDue=-X), matching
the source's own "advance paid before any lot is completed" fallback
branch exactly. This is a deviation in completeness, not in code.

Deliberate deviation: getContractorPaymentsData's dateRaw uses this
project's own date_utils.to_iso_string (plain YYYY-MM-DD) rather than the
source's native Date.toISOString() (a full timestamp) -- genuinely
different from the source, but for internal consistency with every other
module's dateRaw convention; any reasonable JS Date parsing on the
frontend handles both forms identically.

Not ported: initContractorsSheet/initContractorRatesSheet/
initContractorPaymentsSheet (GAS sheet-bootstrap, no Postgres equivalent
needed), getCachedListResponse-based caching on getContractorsData (same
"DB reads aren't the bottleneck" rationale vendors_service.py already
documents for dropping the same pattern there).
"""

from __future__ import annotations

import math
from datetime import date

import psycopg2.extras

import database
from . import process_service
from . import rename_utils
from .current_user import get_current_user_id
from .. import config_maps
from .. import date_utils
from ..envelope import build_response
from ..registry import rpc_method

_MAX_REMARKS_LENGTH = 500


def _validate_number(value, min_value: float, max_value: float) -> float:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(n) or n < min_value or n > max_value:
        return 0.0
    return n


def _find_contractor_id(cur, name: str):
    if not name:
        return None
    cur.execute(
        "SELECT id FROM erp.contractors WHERE lower(contractor_name) = lower(%s) AND deleted_at IS NULL",
        (name,),
    )
    row = cur.fetchone()
    return row["id"] if row else None


def _ensure_contractor_exists(cur, contractor_name: str) -> None:
    """Auto-creates a minimal contractor record (name only) if one doesn't
    exist -- a contractor typed fresh into a rate/payment picker should
    just work without a separate trip to the Contractors tab first.
    """
    name = str(contractor_name or "").strip()
    if not name:
        return
    cur.execute(
        "SELECT 1 FROM erp.contractors WHERE lower(contractor_name) = lower(%s) AND deleted_at IS NULL",
        (name,),
    )
    if cur.fetchone():
        return
    cur.execute(
        "INSERT INTO erp.contractors (contractor_name, remarks) VALUES (%s, %s)",
        (name, "Auto-created from rate card entry"),
    )


def _contractor_in_use_message(cur, contractor_name: str):
    """Human-readable block reason, or None if clear. Deletion is blocked
    once Production, Dispatch, or Contractor Payments hold a row under this
    name -- those aren't cleaned up on delete (only the rate card is), so
    removing the master record would orphan that history.
    """
    name = str(contractor_name or "").strip()
    if not name:
        return None

    if table := config_maps.TABLE_NAMES.get("PRODUCTION"):
        col = config_maps.to_snake_case("assignedTo")
        cur.execute(f"SELECT 1 FROM {table} WHERE deleted_at IS NULL AND lower({col}) = lower(%s) LIMIT 1", (name,))
        if cur.fetchone():
            return f'Cannot delete "{contractor_name}": referenced by Production lots.'

    if table := config_maps.TABLE_NAMES.get("DISPATCH_HEADERS"):
        col = config_maps.to_snake_case("logisticsContractor")
        cur.execute(f"SELECT 1 FROM {table} WHERE deleted_at IS NULL AND lower({col}) = lower(%s) LIMIT 1", (name,))
        if cur.fetchone():
            return f'Cannot delete "{contractor_name}": referenced by Dispatch logistics entries.'

    cur.execute("SELECT 1 FROM erp.contractor_payments WHERE lower(contractor_name) = lower(%s) LIMIT 1", (name,))
    if cur.fetchone():
        return f'Cannot delete "{contractor_name}": has recorded payments.'

    return None


def _rename_contractor_everywhere(cur, old_name: str, new_name: str) -> None:
    old = (old_name or "").strip()
    new = (new_name or "").strip()
    if not old or not new or old == new:
        return

    cur.execute(
        "UPDATE erp.contractor_rates SET contractor_name = %s WHERE lower(contractor_name) = lower(%s)",
        (new, old),
    )
    cur.execute(
        "UPDATE erp.contractor_service_charges SET contractor_name = %s WHERE lower(contractor_name) = lower(%s)",
        (new, old),
    )
    cur.execute(
        "UPDATE erp.contractor_payments SET contractor_name = %s WHERE lower(contractor_name) = lower(%s)",
        (new, old),
    )

    if table := config_maps.TABLE_NAMES.get("PRODUCTION"):
        rename_utils.rename_in_column(cur, table, config_maps.to_snake_case("assignedTo"), old, new)

    if table := config_maps.TABLE_NAMES.get("DISPATCH_HEADERS"):
        rename_utils.rename_in_column(cur, table, config_maps.to_snake_case("logisticsContractor"), old, new)

    # Display-only "sourced from" snapshot on a Product's Additional Cost
    # line -- never used in a lookup or balance calc, but still a
    # de-normalized copy of the name this function otherwise promises to
    # fully propagate.
    if table := config_maps.TABLE_NAMES.get("BOM_ADDITIONAL_COSTS"):
        rename_utils.rename_in_column(cur, table, "contractor_name", old, new)


def _get_size_from_output_item_name(text: str) -> str:
    """Python port of static/erp/core.js's getSizeFromOutputItemName -- a
    lowercase substring match against config_maps.PROCESS_SIZE_LIST (also
    duplicated in mobile.js), defaulting to config_maps.PROCESS_SIZE_FALLBACK
    ('General'). Used to resolve Layer 1's Size key server-side from a
    lot's Process outputItemName -- never a value the operator types
    directly, same derivation the UI's Size cascade dropdown already does.
    """
    lower = str(text or "").lower()
    for size in config_maps.PROCESS_SIZE_LIST:
        if size in lower:
            return size
    return config_maps.PROCESS_SIZE_FALLBACK


def _get_contractor_rate(cur, contractor_name: str, process_type: str, size: str) -> float:
    c_name = str(contractor_name or "").strip()
    p_type = str(process_type or "").strip()
    p_size = str(size or "").strip()
    if not c_name or not p_type or not p_size:
        return 0.0
    cur.execute(
        "SELECT rate_per_unit FROM erp.contractor_rates "
        "WHERE lower(contractor_name) = lower(%s) AND lower(process_type) = lower(%s) AND lower(size) = lower(%s)",
        (c_name, p_type, p_size),
    )
    row = cur.fetchone()
    return float(row["rate_per_unit"]) if row else 0.0


def _get_extra_charge(cur, contractor_name: str, service_type: str) -> float:
    c_name = str(contractor_name or "").strip()
    s_type = str(service_type or "").strip()
    if not c_name or not s_type:
        return 0.0
    cur.execute(
        "SELECT charge_amount FROM erp.contractor_service_charges "
        "WHERE lower(contractor_name) = lower(%s) AND lower(service_type) = lower(%s)",
        (c_name, s_type),
    )
    row = cur.fetchone()
    return float(row["charge_amount"]) if row else 0.0


def _get_dispatch_logistics_payable_rows(cur, contractor_name_filter: str = None) -> list:
    """Dispatch lines with a recorded (header-level) Logistics Contractor +
    positive (line-level) Logistics Cost -- the "Dispatch / Logistics"
    virtual process category's payable entries. One row per LINE, same
    granularity the flat table used to give (each product's own shipment is
    its own payable entry) -- Logistics Contractor/rate are header-level
    (one snapshot per bill), Qty/Logistics Cost are line-level (migration
    023), so this is a join, not a flat single-table lookup.
    """
    headers_table = config_maps.TABLE_NAMES.get("DISPATCH_HEADERS")
    lines_table = config_maps.TABLE_NAMES.get("DISPATCH_LINES")
    if not (headers_table and lines_table):
        return []

    contractor_col = config_maps.to_snake_case("logisticsContractor")
    cost_col = config_maps.to_snake_case("logisticsCost")
    date_col = config_maps.to_snake_case("dispatchDate")
    qty_col = config_maps.to_snake_case("qty")
    number_col = config_maps.to_snake_case("dispatchNumber")
    product_col = config_maps.to_snake_case("productName")

    sql = (
        f"SELECT h.{date_col} AS dispatch_date, h.{contractor_col} AS contractor_name, l.{qty_col} AS qty, "
        f"l.{cost_col} AS payable, h.{number_col} AS dispatch_number, l.{product_col} AS product_name "
        f"FROM {lines_table} l JOIN {headers_table} h ON h.id = l.header_id "
        f"WHERE h.deleted_at IS NULL AND h.{contractor_col} IS NOT NULL AND h.{contractor_col} != '' "
        f"AND l.{cost_col} > 0"
    )
    params = []
    filter_name = str(contractor_name_filter or "").strip()
    if filter_name:
        sql += f" AND lower(h.{contractor_col}) = lower(%s)"
        params.append(filter_name)

    cur.execute(sql, params)
    rows = []
    for row in cur.fetchall():
        rows.append(
            {
                "date": date_utils.to_display_string(row["dispatch_date"]) or "",
                "dateRaw": date_utils.to_iso_string(row["dispatch_date"]) or "",
                "contractorName": row["contractor_name"],
                "qty": float(row["qty"] or 0),
                "payable": float(row["payable"] or 0),
                "dispatchNumber": row["dispatch_number"] or "",
                "productName": row["product_name"] or "",
            }
        )
    return rows


def _get_total_paid_map(cur) -> dict:
    cur.execute("SELECT contractor_name, amount FROM erp.contractor_payments")
    result: dict = {}
    for row in cur.fetchall():
        name = str(row["contractor_name"] or "").strip()
        if not name:
            continue
        entry = result.setdefault(name.lower(), {"contractorName": name, "amount": 0.0})
        entry["amount"] += float(row["amount"] or 0)
    return result


# ─────────────────────────────────────────────────────────────────────────
# Contractors
# ─────────────────────────────────────────────────────────────────────────


@rpc_method("getContractorsData")
def get_contractors_data():
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        cur.execute(
            """
            SELECT contractor_name, contact, address, gst_pan, remarks
            FROM erp.contractors WHERE deleted_at IS NULL ORDER BY lower(contractor_name)
            """
        )
        rows = cur.fetchall()

    contractors = [
        {
            "contractorName": row["contractor_name"],
            "contact": row["contact"] or "",
            "address": row["address"] or "",
            "gstPan": row["gst_pan"] or "",
            "remarks": row["remarks"] or "",
        }
        for row in rows
    ]
    return build_response(True, contractors)


@rpc_method("saveContractor", mutation=True)
@database.transactional
def save_contractor(conn, cur, form_data):
    form_data = form_data or {}

    new_name = str(form_data.get("contractorName") or "").strip()
    if not new_name:
        raise ValueError("Contractor name cannot be empty.")

    is_edit = bool(form_data.get("originalContractorName"))
    original_name = str(form_data.get("originalContractorName")).strip() if is_edit else new_name

    cur.execute(
        "SELECT id FROM erp.contractors WHERE lower(contractor_name) = lower(%s) AND deleted_at IS NULL",
        (original_name,),
    )
    existing = cur.fetchone()

    if is_edit and existing is None:
        raise ValueError("Original contractor not found in sheet.")
    if not is_edit and existing is not None:
        raise ValueError("A contractor with this name already exists.")

    if is_edit and new_name.lower() != original_name.lower():
        cur.execute(
            "SELECT id FROM erp.contractors WHERE lower(contractor_name) = lower(%s) AND deleted_at IS NULL AND id != %s",
            (new_name, existing["id"]),
        )
        if cur.fetchone():
            raise ValueError("Another contractor with this new name already exists.")

    contact = str(form_data.get("contact") or "").strip()
    address = str(form_data.get("address") or "").strip()
    gst_pan = str(form_data.get("gstPan") or "").strip()
    remarks = str(form_data.get("remarks") or "").strip()
    user_id = get_current_user_id()

    if is_edit:
        cur.execute(
            """
            UPDATE erp.contractors SET contractor_name = %s, contact = %s, address = %s, gst_pan = %s,
                remarks = %s, updated_by = %s WHERE id = %s
            """,
            (new_name, contact, address, gst_pan, remarks, user_id, existing["id"]),
        )
        # Plain string compare (not case-insensitive) -- a casing-only edit
        # still cascades.
        if new_name != original_name:
            _rename_contractor_everywhere(cur, original_name, new_name)
        message = f'Contractor "{new_name}" updated.'
    else:
        cur.execute(
            "INSERT INTO erp.contractors (contractor_name, contact, address, gst_pan, remarks, updated_by) VALUES (%s, %s, %s, %s, %s, %s)",
            (new_name, contact, address, gst_pan, remarks, user_id),
        )
        message = f'Contractor "{new_name}" registered.'

    return build_response(True, {"name": new_name}, message)


@rpc_method("deleteContractor", mutation=True)
@database.transactional
def delete_contractor(conn, cur, contractor_name):
    target = str(contractor_name or "").strip()
    if not target:
        raise ValueError("Contractor not found.")

    cur.execute(
        "SELECT id FROM erp.contractors WHERE lower(contractor_name) = lower(%s) AND deleted_at IS NULL",
        (target,),
    )
    row = cur.fetchone()
    if row is None:
        raise ValueError("Contractor not found.")

    in_use = _contractor_in_use_message(cur, target)
    if in_use:
        raise ValueError(in_use)

    cur.execute(
        "UPDATE erp.contractors SET deleted_at = NOW(), updated_by = %s WHERE id = %s",
        (get_current_user_id(), row["id"]),
    )
    # Rate card rows are physically removed, not soft-invisible-via-join --
    # matches the source's own deleteRowsById cleanup exactly, and neither
    # erp.contractor_rates nor erp.contractor_service_charges has a
    # deleted_at of its own to soft-delete with.
    cur.execute("DELETE FROM erp.contractor_rates WHERE lower(contractor_name) = lower(%s)", (target,))
    cur.execute("DELETE FROM erp.contractor_service_charges WHERE lower(contractor_name) = lower(%s)", (target,))

    return build_response(True, None, f'Contractor "{target}" deleted.')


@rpc_method("deleteContractorsBulk", mutation=True)
@database.transactional
def delete_contractors_bulk(conn, cur, contractor_names):
    requested = [str(n or "").strip() for n in (contractor_names or []) if str(n or "").strip()]
    if not requested:
        return build_response(True, None, "No contractors selected.")

    in_use = [n for n in requested if _contractor_in_use_message(cur, n)]
    deletable = [n for n in requested if n not in in_use]

    if not deletable:
        if in_use:
            return build_response(
                False, None,
                f"No contractors deleted -- all selected have Production, Dispatch, or payment history: {', '.join(in_use)}.",
            )
        return build_response(True, None, "No contractors to delete.")

    user_id = get_current_user_id()
    cur.execute(
        "UPDATE erp.contractors SET deleted_at = NOW(), updated_by = %s WHERE deleted_at IS NULL AND lower(contractor_name) = ANY(%s)",
        (user_id, [n.lower() for n in deletable]),
    )
    rows_deleted = cur.rowcount
    cur.execute("DELETE FROM erp.contractor_rates WHERE lower(contractor_name) = ANY(%s)", ([n.lower() for n in deletable],))
    cur.execute("DELETE FROM erp.contractor_service_charges WHERE lower(contractor_name) = ANY(%s)", ([n.lower() for n in deletable],))

    message = f"Deleted {rows_deleted} contractor(s)."
    if in_use:
        message += f" Skipped (has history): {', '.join(in_use)}."
    return build_response(True, None, message)


# ─────────────────────────────────────────────────────────────────────────
# Contractor Rate Card
# ─────────────────────────────────────────────────────────────────────────


@rpc_method("getContractorRatesData")
def get_contractor_rates_data(contractor_name=""):
    filter_name = str(contractor_name or "").strip().lower()
    sql = "SELECT id, contractor_name, process_type, size, rate_per_unit, remarks FROM erp.contractor_rates"
    params: list = []
    if filter_name:
        sql += " WHERE lower(contractor_name) = %s"
        params.append(filter_name)
    sql += " ORDER BY lower(contractor_name), lower(process_type), lower(size)"

    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        cur.execute(sql, params)
        rows = cur.fetchall()

    rates = [
        {
            "rowIdx": row["id"],
            "contractorName": row["contractor_name"],
            "processType": row["process_type"],
            "size": row["size"],
            "ratePerUnit": float(row["rate_per_unit"]),
            "remarks": row["remarks"] or "",
        }
        for row in rows
    ]
    return build_response(True, rates)


@rpc_method("getContractorRateForProcessType")
def get_contractor_rate_for_process_type(contractor_name, process_type, size):
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        rate = _get_contractor_rate(cur, contractor_name, process_type, size)
    return build_response(True, {"ratePerUnit": rate})


@rpc_method("saveContractorRate", mutation=True)
@database.transactional
def save_contractor_rate(conn, cur, form_data):
    form_data = form_data or {}

    contractor_name = str(form_data.get("contractorName") or "").strip()
    process_type = str(form_data.get("processType") or "").strip()
    size = str(form_data.get("size") or "").strip()
    if not contractor_name or not process_type or not size:
        raise ValueError("Contractor, Process Type, and Size are all required.")

    rate_per_unit = _validate_number(form_data.get("ratePerUnit"), 0, 10000000)
    remarks = str(form_data.get("remarks") or "").strip()[:_MAX_REMARKS_LENGTH]

    _ensure_contractor_exists(cur, contractor_name)
    contractor_id = _find_contractor_id(cur, contractor_name)

    cur.execute(
        "SELECT id FROM erp.contractor_rates WHERE lower(contractor_name) = lower(%s) AND lower(process_type) = lower(%s) AND lower(size) = lower(%s)",
        (contractor_name, process_type, size),
    )
    existing = cur.fetchone()

    if existing:
        cur.execute(
            """
            UPDATE erp.contractor_rates SET contractor_name = %s, process_type = %s, size = %s, rate_per_unit = %s,
                remarks = %s, contractor_id = %s WHERE id = %s
            """,
            (contractor_name, process_type, size, rate_per_unit, remarks, contractor_id, existing["id"]),
        )
    else:
        cur.execute(
            "INSERT INTO erp.contractor_rates (contractor_name, contractor_id, process_type, size, rate_per_unit, remarks) VALUES (%s, %s, %s, %s, %s, %s)",
            (contractor_name, contractor_id, process_type, size, rate_per_unit, remarks),
        )

    return build_response(True, None, f'Rate for "{contractor_name}" ({process_type} / {size}) saved.')


@rpc_method("deleteContractorRate", mutation=True)
@database.transactional
def delete_contractor_rate(conn, cur, contractor_name, process_type, size):
    cur.execute("SELECT COUNT(*) AS n FROM erp.contractor_rates")
    if cur.fetchone()["n"] == 0:
        return build_response(True, None, "No rates to delete.")

    cur.execute(
        "DELETE FROM erp.contractor_rates WHERE lower(contractor_name) = lower(%s) AND lower(process_type) = lower(%s) AND lower(size) = lower(%s)",
        (str(contractor_name or "").strip(), str(process_type or "").strip(), str(size or "").strip()),
    )
    if cur.rowcount == 0:
        raise ValueError("Rate card entry not found.")
    return build_response(True, None, "Rate deleted successfully.")


@rpc_method("deleteContractorRatesBulk", mutation=True)
@database.transactional
def delete_contractor_rates_bulk(conn, cur, rates):
    # No single id column on this table -- identity is the (contractor,
    # process_type, size) triple, same as the single-delete above, so this
    # loops rather than a single ANY(%s) DELETE (rate cards per contractor
    # are always a short list, unlike e.g. Production/Dispatch's row counts).
    triples = []
    for r in rates or []:
        r = r or {}
        contractor_name = str(r.get("contractorName") or "").strip()
        process_type = str(r.get("processType") or "").strip()
        size = str(r.get("size") or "").strip()
        if contractor_name and process_type and size:
            triples.append((contractor_name, process_type, size))

    if not triples:
        return build_response(True, None, "No rates selected.")

    deleted = 0
    for contractor_name, process_type, size in triples:
        cur.execute(
            "DELETE FROM erp.contractor_rates WHERE lower(contractor_name) = lower(%s) AND lower(process_type) = lower(%s) AND lower(size) = lower(%s)",
            (contractor_name, process_type, size),
        )
        deleted += cur.rowcount
    return build_response(True, None, f"Deleted {deleted} rate(s).")


# ─────────────────────────────────────────────────────────────────────────
# Contractor Extra Charges (Layer 2 -- optional flat per-lot charge)
# ─────────────────────────────────────────────────────────────────────────


@rpc_method("getContractorServiceChargesData")
def get_contractor_service_charges_data(contractor_name=""):
    filter_name = str(contractor_name or "").strip().lower()
    sql = "SELECT id, contractor_name, service_type, charge_amount, remarks FROM erp.contractor_service_charges"
    params: list = []
    if filter_name:
        sql += " WHERE lower(contractor_name) = %s"
        params.append(filter_name)
    sql += " ORDER BY lower(contractor_name), lower(service_type)"

    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        cur.execute(sql, params)
        rows = cur.fetchall()

    charges = [
        {
            "rowIdx": row["id"],
            "contractorName": row["contractor_name"],
            "serviceType": row["service_type"],
            "chargeAmount": float(row["charge_amount"]),
            "remarks": row["remarks"] or "",
        }
        for row in rows
    ]
    return build_response(True, charges)


@rpc_method("getContractorServiceChargesForContractor")
def get_contractor_service_charges_for_contractor(contractor_name):
    """Powers the Production form's per-lot Extra Charge radio group --
    only that contractor's own service types/charges should ever show up,
    since they vary contractor to contractor.
    """
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        cur.execute(
            "SELECT service_type, charge_amount FROM erp.contractor_service_charges "
            "WHERE lower(contractor_name) = lower(%s) ORDER BY lower(service_type)",
            (str(contractor_name or "").strip(),),
        )
        rows = cur.fetchall()

    charges = [{"serviceType": row["service_type"], "chargeAmount": float(row["charge_amount"])} for row in rows]
    return build_response(True, charges)


@rpc_method("saveContractorServiceCharge", mutation=True)
@database.transactional
def save_contractor_service_charge(conn, cur, form_data):
    form_data = form_data or {}

    contractor_name = str(form_data.get("contractorName") or "").strip()
    service_type = str(form_data.get("serviceType") or "").strip()
    if not contractor_name or not service_type:
        raise ValueError("Contractor and Service Type are both required.")

    charge_amount = _validate_number(form_data.get("chargeAmount"), 0, 10000000)
    remarks = str(form_data.get("remarks") or "").strip()[:_MAX_REMARKS_LENGTH]

    _ensure_contractor_exists(cur, contractor_name)
    contractor_id = _find_contractor_id(cur, contractor_name)

    cur.execute(
        "SELECT id FROM erp.contractor_service_charges WHERE lower(contractor_name) = lower(%s) AND lower(service_type) = lower(%s)",
        (contractor_name, service_type),
    )
    existing = cur.fetchone()

    if existing:
        cur.execute(
            """
            UPDATE erp.contractor_service_charges SET contractor_name = %s, service_type = %s, charge_amount = %s,
                remarks = %s, contractor_id = %s WHERE id = %s
            """,
            (contractor_name, service_type, charge_amount, remarks, contractor_id, existing["id"]),
        )
    else:
        cur.execute(
            "INSERT INTO erp.contractor_service_charges (contractor_name, contractor_id, service_type, charge_amount, remarks) VALUES (%s, %s, %s, %s, %s)",
            (contractor_name, contractor_id, service_type, charge_amount, remarks),
        )

    return build_response(True, None, f'Extra charge for "{contractor_name}" ({service_type}) saved.')


@rpc_method("deleteContractorServiceCharge", mutation=True)
@database.transactional
def delete_contractor_service_charge(conn, cur, contractor_name, service_type):
    cur.execute("SELECT COUNT(*) AS n FROM erp.contractor_service_charges")
    if cur.fetchone()["n"] == 0:
        return build_response(True, None, "No extra charges to delete.")

    cur.execute(
        "DELETE FROM erp.contractor_service_charges WHERE lower(contractor_name) = lower(%s) AND lower(service_type) = lower(%s)",
        (str(contractor_name or "").strip(), str(service_type or "").strip()),
    )
    if cur.rowcount == 0:
        raise ValueError("Extra charge entry not found.")
    return build_response(True, None, "Extra charge deleted successfully.")


@rpc_method("deleteContractorServiceChargesBulk", mutation=True)
@database.transactional
def delete_contractor_service_charges_bulk(conn, cur, charges):
    pairs = []
    for c in charges or []:
        c = c or {}
        contractor_name = str(c.get("contractorName") or "").strip()
        service_type = str(c.get("serviceType") or "").strip()
        if contractor_name and service_type:
            pairs.append((contractor_name, service_type))

    if not pairs:
        return build_response(True, None, "No extra charges selected.")

    deleted = 0
    for contractor_name, service_type in pairs:
        cur.execute(
            "DELETE FROM erp.contractor_service_charges WHERE lower(contractor_name) = lower(%s) AND lower(service_type) = lower(%s)",
            (contractor_name, service_type),
        )
        deleted += cur.rowcount
    return build_response(True, None, f"Deleted {deleted} extra charge(s).")


# ─────────────────────────────────────────────────────────────────────────
# Contractor Payments
# ─────────────────────────────────────────────────────────────────────────


@rpc_method("getContractorPaymentsData")
def get_contractor_payments_data(contractor_name=""):
    filter_name = str(contractor_name or "").strip().lower()
    sql = "SELECT id, payment_date, contractor_name, amount, mode_reference, remarks FROM erp.contractor_payments"
    params: list = []
    if filter_name:
        sql += " WHERE lower(contractor_name) = %s"
        params.append(filter_name)
    sql += " ORDER BY payment_date ASC, id ASC"

    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        cur.execute(sql, params)
        rows = cur.fetchall()

    payments = [
        {
            "rowIdx": row["id"],
            "date": date_utils.to_display_string(row["payment_date"]) or "",
            "dateRaw": date_utils.to_iso_string(row["payment_date"]) or "",
            "contractorName": row["contractor_name"],
            "amount": float(row["amount"]),
            "modeReference": row["mode_reference"] or "",
            "remarks": row["remarks"] or "",
        }
        for row in rows
    ]
    return build_response(True, payments)


@rpc_method("recordContractorPayment", mutation=True)
@database.transactional
def record_contractor_payment(conn, cur, form_data):
    form_data = form_data or {}

    contractor_name = str(form_data.get("contractorName") or "").strip()
    if not contractor_name:
        raise ValueError("Contractor is required.")

    amount = _validate_number(form_data.get("amount"), 0.01, 100000000)
    if amount <= 0:
        raise ValueError("Payment amount must be greater than zero.")

    payment_date = date_utils.to_safe_date(form_data.get("date")) or date.today()
    mode_reference = str(form_data.get("modeReference") or "").strip()
    remarks = str(form_data.get("remarks") or "").strip()[:_MAX_REMARKS_LENGTH]

    _ensure_contractor_exists(cur, contractor_name)
    contractor_id = _find_contractor_id(cur, contractor_name)

    cur.execute(
        """
        INSERT INTO erp.contractor_payments (payment_date, contractor_name, contractor_id, amount, mode_reference, remarks)
        VALUES (%s, %s, %s, %s, %s, %s)
        """,
        (payment_date, contractor_name, contractor_id, amount, mode_reference, remarks),
    )

    return build_response(True, None, f'Payment of {amount:,.2f} recorded for "{contractor_name}".')


@rpc_method("deleteContractorPayment", mutation=True)
@database.transactional
def delete_contractor_payment(conn, cur, row_idx, expected_contractor_name=None, expected_amount=None):
    try:
        target_id = int(row_idx)
    except (TypeError, ValueError):
        raise ValueError("Invalid payment record selected for deletion.")

    cur.execute("SELECT contractor_name, amount FROM erp.contractor_payments WHERE id = %s", (target_id,))
    row = cur.fetchone()
    if row is None:
        raise ValueError("Invalid payment record selected for deletion.")

    # Optimistic-concurrency check, only applied if BOTH expected values
    # were provided -- matches deleteProduction/deleteDispatch's cited
    # precedent, guarding against a stale client reference deleting the
    # wrong row.
    if expected_contractor_name is not None and expected_amount is not None:
        if (
            str(row["contractor_name"] or "").strip().lower() != str(expected_contractor_name or "").strip().lower()
            or abs(float(row["amount"]) - float(expected_amount)) > 0.0001
        ):
            raise ValueError("Data mismatch: The record has been modified or shifted. Please refresh.")

    cur.execute("DELETE FROM erp.contractor_payments WHERE id = %s", (target_id,))
    return build_response(True, None, "Payment record deleted successfully.")


@rpc_method("deleteContractorPaymentsBulk", mutation=True)
@database.transactional
def delete_contractor_payments_bulk(conn, cur, row_idxs):
    target_ids = []
    for r in row_idxs or []:
        try:
            target_ids.append(int(r))
        except (TypeError, ValueError):
            continue

    if not target_ids:
        return build_response(True, None, "No payment records selected.")

    cur.execute("DELETE FROM erp.contractor_payments WHERE id = ANY(%s)", (target_ids,))
    rows_deleted = cur.rowcount
    return build_response(True, None, f"Deleted {rows_deleted} payment record(s).")


# ─────────────────────────────────────────────────────────────────────────
# Contractor Ledger (read-only, computed from Production/Dispatch/Payments)
# ─────────────────────────────────────────────────────────────────────────


@rpc_method("getContractorLedgerData")
def get_contractor_ledger_data():
    result: dict = {}

    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        if table := config_maps.TABLE_NAMES.get("PRODUCTION"):
            process_name_by_id = {
                p["processId"].strip().lower(): p["processName"] for p in process_service._get_all_processes(cur)
            }
            status_col = config_maps.to_snake_case("status")
            assigned_col = config_maps.to_snake_case("assignedTo")
            payable_col = config_maps.to_snake_case("contractorPayable")
            rate_col = config_maps.to_snake_case("contractorRate")
            extra_col = config_maps.to_snake_case("extraChargeAmount")
            qty_col = config_maps.to_snake_case("qty")
            process_id_col = config_maps.to_snake_case("processId")
            cur.execute(
                f"SELECT {status_col} AS status, {assigned_col} AS assigned_to, {payable_col} AS payable, "
                f"{rate_col} AS contractor_rate, {extra_col} AS extra_charge_amount, {qty_col} AS qty, "
                f"{process_id_col} AS process_id FROM {table} WHERE deleted_at IS NULL"
            )
            for row in cur.fetchall():
                if str(row["status"] or "").strip().lower() != "completed":
                    continue
                contractor_name = str(row["assigned_to"] or "").strip()
                if not contractor_name:
                    continue
                # Gate on whether a rate card OR an extra charge applied --
                # not on the payable's sign (Production allows negative qty
                # for corrections, and a real rate against a negative qty is
                # a legitimate negative payable that must still be summed,
                # not dropped) and not on contractor_rate alone (a lot can
                # carry only an extra charge with no Layer 1 rate card entry).
                if float(row["contractor_rate"] or 0) == 0 and float(row["extra_charge_amount"] or 0) == 0:
                    continue
                payable = float(row["payable"] or 0)
                qty = float(row["qty"] or 0)
                process_id = str(row["process_id"] or "").strip().lower()
                process_name = process_name_by_id.get(process_id, "Uncategorized")

                entry = result.setdefault(
                    contractor_name.lower(),
                    {"contractorName": contractor_name, "lotCount": 0, "totalQty": 0.0, "totalPayable": 0.0, "byProcess": {}},
                )
                entry["lotCount"] += 1
                entry["totalQty"] += qty
                entry["totalPayable"] += payable
                bucket = entry["byProcess"].setdefault(
                    process_name, {"processName": process_name, "lotCount": 0, "qty": 0.0, "payable": 0.0}
                )
                bucket["lotCount"] += 1
                bucket["qty"] += qty
                bucket["payable"] += payable

        for d in _get_dispatch_logistics_payable_rows(cur):
            entry = result.setdefault(
                d["contractorName"].lower(),
                {"contractorName": d["contractorName"], "lotCount": 0, "totalQty": 0.0, "totalPayable": 0.0, "byProcess": {}},
            )
            entry["lotCount"] += 1
            entry["totalQty"] += d["qty"]
            entry["totalPayable"] += d["payable"]
            bucket = entry["byProcess"].setdefault(
                config_maps.LOGISTICS_PROCESS_NAME,
                {"processName": config_maps.LOGISTICS_PROCESS_NAME, "lotCount": 0, "qty": 0.0, "payable": 0.0},
            )
            bucket["lotCount"] += 1
            bucket["qty"] += d["qty"]
            bucket["payable"] += d["payable"]

        paid_map = _get_total_paid_map(cur)

    for entry in result.values():
        entry["byProcess"] = list(entry["byProcess"].values())
        paid_entry = paid_map.get(entry["contractorName"].lower())
        entry["totalPaid"] = paid_entry["amount"] if paid_entry else 0.0
        entry["balanceDue"] = entry["totalPayable"] - entry["totalPaid"]

    # Contractors with payments recorded but no Payable lots (e.g. an
    # advance paid before any lot is completed) still need to show up.
    for key, paid_entry in paid_map.items():
        if key in result:
            continue
        result[key] = {
            "contractorName": paid_entry["contractorName"],
            "lotCount": 0,
            "totalQty": 0.0,
            "totalPayable": 0.0,
            "byProcess": [],
            "totalPaid": paid_entry["amount"],
            "balanceDue": -paid_entry["amount"],
        }

    records = sorted(result.values(), key=lambda r: r["contractorName"].lower())
    return build_response(True, records)


@rpc_method("getContractorAccountLedger")
def get_contractor_account_ledger(contractor_name):
    name = str(contractor_name or "").strip()
    if not name:
        raise ValueError("Contractor is required.")

    entries = []

    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        if table := config_maps.TABLE_NAMES.get("PRODUCTION"):
            process_name_by_id = {
                p["processId"].strip().lower(): p["processName"] for p in process_service._get_all_processes(cur)
            }
            status_col = config_maps.to_snake_case("status")
            assigned_col = config_maps.to_snake_case("assignedTo")
            payable_col = config_maps.to_snake_case("contractorPayable")
            rate_col = config_maps.to_snake_case("contractorRate")
            extra_type_col = config_maps.to_snake_case("extraChargeType")
            extra_amount_col = config_maps.to_snake_case("extraChargeAmount")
            date_col = config_maps.to_snake_case("productionDate")
            process_id_col = config_maps.to_snake_case("processId")
            product_col = config_maps.to_snake_case("productName")
            lot_col = config_maps.to_snake_case("lotNumber")
            cur.execute(
                f"SELECT {status_col} AS status, {assigned_col} AS assigned_to, {payable_col} AS payable, "
                f"{rate_col} AS contractor_rate, {extra_type_col} AS extra_charge_type, "
                f"{extra_amount_col} AS extra_charge_amount, {date_col} AS prod_date, "
                f"{process_id_col} AS process_id, {product_col} AS product_name, {lot_col} AS lot_number "
                f"FROM {table} WHERE deleted_at IS NULL"
            )
            for row in cur.fetchall():
                if str(row["status"] or "").strip().lower() != "completed":
                    continue
                if str(row["assigned_to"] or "").strip().lower() != name.lower():
                    continue
                # Gate on whether a rate card OR an extra charge applied --
                # see get_contractor_ledger_data's identical comment.
                if float(row["contractor_rate"] or 0) == 0 and float(row["extra_charge_amount"] or 0) == 0:
                    continue
                payable = float(row["payable"] or 0)
                process_id = str(row["process_id"] or "").strip().lower()
                process_name = process_name_by_id.get(process_id, "Uncategorized")
                extra_charge_type = str(row["extra_charge_type"] or "").strip()
                description = f"{process_name} — {row['product_name'] or ''}"
                if extra_charge_type:
                    description += f" (+ {extra_charge_type})"
                entries.append(
                    {
                        "date": date_utils.to_display_string(row["prod_date"]) or "",
                        "dateRaw": date_utils.to_iso_string(row["prod_date"]) or "",
                        "type": "Payable",
                        "ref": row["lot_number"] or "-",
                        "description": description,
                        "amount": payable,
                    }
                )

        for d in _get_dispatch_logistics_payable_rows(cur, name):
            entries.append(
                {
                    "date": d["date"],
                    "dateRaw": d["dateRaw"],
                    "type": "Payable",
                    "ref": d["dispatchNumber"] or "-",
                    "description": f"{config_maps.LOGISTICS_PROCESS_NAME} — {d['productName']}",
                    "amount": d["payable"],
                }
            )

        cur.execute(
            """
            SELECT id, payment_date, mode_reference, remarks, amount FROM erp.contractor_payments
            WHERE lower(contractor_name) = lower(%s) ORDER BY payment_date ASC, id ASC
            """,
            (name,),
        )
        for row in cur.fetchall():
            amount = float(row["amount"])
            entries.append(
                {
                    "date": date_utils.to_display_string(row["payment_date"]) or "",
                    "dateRaw": date_utils.to_iso_string(row["payment_date"]) or "",
                    "type": "Payment",
                    "ref": row["mode_reference"] or "-",
                    "description": row["remarks"] or "-",
                    "amount": -amount,
                    "rowIdx": row["id"],
                    "rawAmount": amount,
                }
            )

    # Oldest-first to accumulate the running balance correctly.
    entries.sort(key=lambda e: e["dateRaw"] or "")

    running_balance = 0.0
    total_payable = 0.0
    total_paid = 0.0
    for entry in entries:
        running_balance += entry["amount"]
        entry["balance"] = running_balance
        if entry["type"] == "Payable":
            total_payable += entry["amount"]
        else:
            total_paid += -entry["amount"]

    # Newest-first for display, matching every other ledger/table in this app.
    entries.reverse()

    return build_response(
        True,
        {
            "entries": entries,
            "totalPayable": total_payable,
            "totalPaid": total_paid,
            "balanceDue": total_payable - total_paid,
        },
    )
