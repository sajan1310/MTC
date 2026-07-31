"""Dispatch, ported from Apps_Script/module_dispatch.js -- the Dispatched
Goods ledger. Opens Phase 4, closing Warehouse Pool's Pass 3 (finished-
goods debit, deferred since Phase 3e/3g) and activating two other
already-shipped guarded stubs with zero code changes there:
contractors_service._get_dispatch_logistics_payable_rows (Phase 3d) and
bom_service._get_product_ids_in_use's DISPATCH leg (Phase 3c).

getReadyToDispatchData is a pure read computed on the fly from
erp.warehouse_pool -- mirrors Stock's own live-computation for raw
materials, needs no table of its own. A pool row surfaces here only when
it was produced by a final-stage Process: a Product-tagged row surfaces
under that tag regardless of whether the process is confirmed
final-stage (tagged rows get the benefit of the doubt when unknown); an
untagged row only surfaces when the process is confirmed final-stage,
keyed by its own Output Item Name instead. Product Name for tagged rows
resolves from erp.bom_products directly, bypassing the BOM password gate
-- that gate is a UI convenience for the editable product master, not a
data-access control, and source's own _computeReadyToDispatchMap reads
the BOM sheet directly the same way.

saveDispatch validates twice: against the aggregate Ready-to-Dispatch qty
for the product, and -- if an Order Number is given -- against that
specific PI/Estimate line's own remaining qty, so one dispatch can't
over-fulfill a small order using stock really earmarked for a different
order of the same product. _get_client_order_line_qty is guarded via
TABLE_NAMES.get("CLIENT_ORDERS_HEADERS"/"_LINES") -- real as of Phase 4b
(Clients). Originally written in this phase against a flat single-table
assumption; fixed to the real header+lines join once Clients decided the
schema, the same "flat key" mistake this project has hit and fixed
before finalizing other denormalized sheets.

Logistics Contractor rate is snapshotted via contractors_service.
_get_contractor_rate(name, config_maps.LOGISTICS_PROCESS_NAME) -- an
admin sets a Logistics Contractor's rate by creating a normal Contractor
Rate entry with that exact hardcoded virtual process-name string, no
real Process Master row needed. Reused as-is, zero new code needed in
contractors_service.py.

dispatch_number uses a real Postgres SEQUENCE (erp.dispatch_number_seq),
same deliberate deviation as PO/Process/Product IDs: a global, unscoped
counter. getNextDispatchNumber previews via nextval() same as
getNextProcessId -- a preview call followed by a real save can
legitimately consume two different values (harmless, already-accepted
tradeoff).
"""

from __future__ import annotations

import math
import re
from datetime import date

import psycopg2.extras

import database
from . import contractors_service
from . import process_service
from . import warehouse_service
from .current_user import get_current_user_id
from .. import config_maps
from .. import date_utils
from ..envelope import build_response
from ..registry import rpc_method

_NATURAL_SORT_RE = re.compile(r"(\d+)")


def _validate_number(value, min_value: float, max_value: float) -> float:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(n) or n < min_value or n > max_value:
        return 0.0
    return n


def _natural_sort_key(s: str) -> list:
    return [int(chunk) if chunk.isdigit() else chunk.lower() for chunk in _NATURAL_SORT_RE.split(s or "")]


def _get_bom_product_name_map(cur) -> dict:
    cur.execute("SELECT product_id, product_name FROM erp.bom_products WHERE deleted_at IS NULL")
    return {
        str(row["product_id"]).strip().lower(): str(row["product_name"] or "").strip()
        for row in cur.fetchall()
        if row["product_id"]
    }


def _build_differentiator_defs(cur, all_processes: list) -> dict:
    """{processIdLower: {"label": str, "colorsLower": set}} for every
    final-stage process that names a Dispatch Differentiator axis.

    The axis is stored as a LABEL (see migration 021), so it's resolved
    against the process's live computed axes. A process whose axis was
    renamed or removed simply drops out of this map and falls back to one
    aggregate row -- deliberately not an error.
    """
    defs: dict = {}
    differentiated = [
        p for p in all_processes
        if p["isFinalStage"] and str(p.get("dispatchDifferentiator") or "").strip()
    ]
    if not differentiated:
        return defs

    pool_rows = process_service._get_all_warehouse_pool_rows_for_color_axes(cur)
    color_links = process_service._get_all_process_color_links(cur)
    # One read for every process, not one per differentiated process.
    components_by_process: dict = {}
    for component in process_service._fetch_process_components(cur):
        pid = str(component.get("processId") or "").strip().lower()
        if pid:
            components_by_process.setdefault(pid, []).append(component)

    for p in differentiated:
        axis_label = str(p["dispatchDifferentiator"]).strip().lower()
        try:
            axes = process_service._compute_color_axes_for_process(
                p["processId"],
                components_by_process.get(p["processId"].strip().lower(), []),
                pool_rows,
                color_links,
            ) or []
        except Exception:
            continue  # leave this process undifferentiated
        axis = next((a for a in axes if str(a.get("label") or "").strip().lower() == axis_label), None)
        if not axis:
            continue
        defs[p["processId"].strip().lower()] = {
            "label": axis["label"],
            "colorsLower": {str(c).strip().lower() for c in (axis.get("colors") or [])},
        }
    return defs


def _differentiator_value(defs: dict, process_id: str, color: str) -> str:
    """The segment of `color` belonging to this process's differentiator
    axis, or "" when the process has none configured or nothing matches.

    Matches by VALUE against the axis's own colors, never by segment
    position -- see warehouse_service.color_segments.
    """
    definition = defs.get(str(process_id or "").strip().lower())
    if not definition:
        return ""
    for segment in warehouse_service.color_segments(color):
        if segment.lower() in definition["colorsLower"]:
            return segment
    return ""


def _compute_ready_to_dispatch_map(cur) -> dict:
    all_processes = process_service._get_all_processes(cur)
    final_stage_ids = {p["processId"].strip().lower() for p in all_processes if p["isFinalStage"]}

    cur.execute(
        "SELECT output_item_name, process_id, product_tag, color, produced_qty, consumed_qty FROM erp.warehouse_pool"
    )
    pool_rows = cur.fetchall()
    if not pool_rows:
        return {}

    product_name_by_id = _get_bom_product_name_map(cur)
    differentiator_defs = _build_differentiator_defs(cur, all_processes)

    result: dict = {}
    for r in pool_rows:
        process_id = str(r["process_id"] or "").strip()
        product_tag = str(r["product_tag"] or "").strip()
        output_item_name = str(r["output_item_name"] or "").strip()
        known_final_stage = (process_id.lower() in final_stage_ids) if process_id else None
        is_tagged = bool(product_tag)

        if is_tagged:
            if process_id and not known_final_stage:
                continue
        else:
            if not known_final_stage:
                continue

        # One row per differentiator value when the producing process names
        # one, so Dispatch acts on a specific variant instead of an aggregate
        # the operator has to drill into.
        diff_value = _differentiator_value(differentiator_defs, process_id, r["color"])
        base_key = product_tag.lower() if is_tagged else f"__output__{output_item_name.lower()}"
        key = f"{base_key}||{diff_value.lower()}" if diff_value else base_key
        base_name = (
            product_name_by_id.get(product_tag.lower(), product_tag) if is_tagged else output_item_name
        )
        entry = result.setdefault(
            key,
            {
                # The map key itself, carried onto the record so a client has
                # something unique per row to address. productId below is NOT
                # unique once a differentiator splits one output into several
                # rows -- every variant reports the same bare Product Tag /
                # Output Item Name, because that is all a Dispatch row can
                # store (erp.dispatch has no differentiator column, and the
                # pool debit in _recalculate_warehouse_pool Pass 3 is
                # deliberately color-blind).
                "key": key,
                # The bare key this row's availability actually pools with --
                # every variant of one output draws from the same buckets.
                # See _ready_available_qty_for.
                "baseKey": base_key,
                "productId": product_tag if is_tagged else output_item_name,
                "productName": f"{base_name} / {diff_value}" if diff_value else base_name,
                "differentiator": diff_value,
                "producedQty": 0.0,
                "dispatchedQty": 0.0,
                # One Product Tag can accumulate credits from several
                # Completed lots logged with different Colors to Produce
                # combinations. The aggregate above is color-blind by design,
                # but this keeps each color's own numbers so the operator can
                # still tell which color batch they're dispatching.
                "colors": {},
            },
        )
        produced = float(r["produced_qty"] or 0)
        consumed = float(r["consumed_qty"] or 0)
        entry["producedQty"] += produced
        entry["dispatchedQty"] += consumed

        color_label = str(r["color"] or "").strip()
        color_entry = entry["colors"].setdefault(color_label, {"producedQty": 0.0, "dispatchedQty": 0.0})
        color_entry["producedQty"] += produced
        color_entry["dispatchedQty"] += consumed

    return result


def _ready_available_qty_for(ready_map: dict, product_id: str) -> float:
    """Currently-available Ready to Dispatch qty for one `product_id` as the
    client echoes it back -- i.e. the bare Product Tag or Output Item Name.

    _compute_ready_to_dispatch_map keys an untagged output under
    '__output__<name>' (so it can't collide with a differently-named Product
    Tag) and, when the producing final-stage process names a Dispatch
    Differentiator, splits it further into '<baseKey>||<value>'. A product_id
    carries neither the prefix nor the value, so a lookup of just those two
    literal spellings finds nothing for any differentiated product and reads
    its availability as 0 -- which would reject every dispatch of that
    product outright.

    Availability is therefore summed across the bare key AND every variant of
    it. That is not a loosening of the guard -- it's what the ledger actually
    models: an erp.dispatch row records only the product_id, and
    _recalculate_warehouse_pool Pass 3 drains whichever color buckets have
    stock, so per-variant consumption isn't representable in the current
    schema. The differentiator splits the Ready to Dispatch *list* for the
    operator's benefit; the quantity guard pools per product, exactly as it
    did before that column existed.
    """
    key = str(product_id or "").strip().lower()
    if not key:
        return 0.0
    wanted = {key, f"__output__{key}"}
    total = 0.0
    for k, entry in ready_map.items():
        base = k.split("||", 1)[0]
        if base in wanted:
            total += entry["producedQty"] - entry["dispatchedQty"]
    return total


def _get_client_order_line_qty(cur, order_number: str, product_id: str):
    """Sums Qty Ordered across every Client Orders line matching (order,
    product) case-insensitively. Returns None if no such line exists at
    all (order/product not found, or Client Orders doesn't exist yet),
    which callers use to distinguish "nothing to check against" from "0
    remaining". Client Orders is header+lines split (order_number is
    header-level, product_id/qty are line-level) -- a join, not a flat
    single-table lookup.
    """
    headers_table = config_maps.TABLE_NAMES.get("CLIENT_ORDERS_HEADERS")
    lines_table = config_maps.TABLE_NAMES.get("CLIENT_ORDERS_LINES")
    if not headers_table or not lines_table:
        return None

    order_col = config_maps.to_snake_case("orderNumber")
    product_col = config_maps.to_snake_case("productId")
    qty_col = config_maps.to_snake_case("qty")
    cur.execute(
        f"SELECT l.{qty_col} AS qty FROM {lines_table} l "
        f"JOIN {headers_table} h ON h.id = l.header_id "
        f"WHERE h.deleted_at IS NULL AND lower(h.{order_col}) = lower(%s) AND lower(l.{product_col}) = lower(%s)",
        (order_number, product_id),
    )
    rows = cur.fetchall()
    if not rows:
        return None
    return sum(float(row["qty"] or 0) for row in rows)


def _get_dispatched_qty_for_order(cur, order_number: str, product_id: str, exclude_id=None) -> float:
    sql = (
        "SELECT COALESCE(SUM(qty), 0) AS total FROM erp.dispatch "
        "WHERE deleted_at IS NULL AND lower(order_number) = lower(%s) AND lower(product_id) = lower(%s)"
    )
    params = [order_number, product_id]
    if exclude_id is not None:
        sql += " AND id != %s"
        params.append(exclude_id)
    cur.execute(sql, params)
    return float(cur.fetchone()["total"] or 0)


def _find_bom_product_id(cur, product_id_str: str):
    if not product_id_str:
        return None
    cur.execute(
        "SELECT id FROM erp.bom_products WHERE lower(product_id) = lower(%s) AND deleted_at IS NULL",
        (product_id_str,),
    )
    row = cur.fetchone()
    return row["id"] if row else None


def _find_contractor_id_by_name(cur, name: str):
    if not name:
        return None
    cur.execute(
        "SELECT id FROM erp.contractors WHERE lower(contractor_name) = lower(%s) AND deleted_at IS NULL",
        (name,),
    )
    row = cur.fetchone()
    return row["id"] if row else None


@rpc_method("getReadyToDispatchData")
def get_ready_to_dispatch_data():
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        ready_map = _compute_ready_to_dispatch_map(cur)

    records = [
        {
            # Unique per row even when a Dispatch Differentiator splits one
            # output into several -- productId does NOT distinguish those, so
            # anything addressing a single row must key on this.
            "key": r["key"],
            "productId": r["productId"],
            "productName": r["productName"],
            # Blank unless the producing final-stage process names a Dispatch
            # Differentiator; productName already embeds it as
            # "<output> / <value>".
            "differentiator": r["differentiator"],
            "producedQty": r["producedQty"],
            "dispatchedQty": r["dispatchedQty"],
            "readyQty": r["producedQty"] - r["dispatchedQty"],
            "colorBreakdown": sorted(
                (
                    {
                        "color": color,
                        "producedQty": c["producedQty"],
                        "dispatchedQty": c["dispatchedQty"],
                        "readyQty": c["producedQty"] - c["dispatchedQty"],
                    }
                    for color, c in r["colors"].items()
                ),
                key=lambda c: c["color"],
            ),
        }
        for r in ready_map.values()
    ]
    records.sort(key=lambda r: _natural_sort_key(r["productId"]), reverse=True)
    return build_response(True, records)


def _row_to_dispatch_record(row) -> dict:
    return {
        "rowIdx": row["id"],
        "dispatchNumber": row["dispatch_number"] or "",
        "dispatchDate": date_utils.to_display_string(row["dispatch_date"]) or "",
        "dateRaw": date_utils.to_iso_string(row["dispatch_date"]) or "",
        "orderNumber": row["order_number"] or "",
        "clientName": row["client_name"] or "",
        "productId": row["product_id"] or "",
        "productName": row["product_name"] or "",
        "qty": float(row["qty"]),
        "transport": row["transport"] or "",
        "remarks": row["remarks"] or "",
        "invoiceNumber": row["invoice_number"] or "",
        "privateMark": row["private_mark"] or "",
        "grNumber": row["gr_number"] or "",
        "logisticsContractor": row["logistics_contractor"] or "",
        "logisticsRate": float(row["logistics_rate"]),
        "logisticsCost": float(row["logistics_cost"]),
    }


_DISPATCH_SELECT_COLS = """
    id, dispatch_number, dispatch_date, order_number, client_name, product_id, product_name,
    qty, transport, remarks, invoice_number, private_mark, gr_number,
    logistics_contractor, logistics_rate, logistics_cost
"""


@rpc_method("getDispatchData")
def get_dispatch_data():
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        cur.execute(f"SELECT {_DISPATCH_SELECT_COLS} FROM erp.dispatch WHERE deleted_at IS NULL")
        rows = cur.fetchall()

    records = [_row_to_dispatch_record(row) for row in rows]
    records.sort(key=lambda r: (r["dateRaw"] or "", r["rowIdx"]), reverse=True)
    return build_response(True, records)


def _fetch_dispatch_record(cur, dispatch_id):
    """Reads one freshly-written dispatch row back by id, so save_dispatch
    can hand it to the client for an in-place row-patch instead of a full
    reload."""
    cur.execute(f"SELECT {_DISPATCH_SELECT_COLS} FROM erp.dispatch WHERE id = %s", (dispatch_id,))
    row = cur.fetchone()
    return _row_to_dispatch_record(row) if row else None


@rpc_method("getNextDispatchNumber")
def get_next_dispatch_number():
    # Bare string return, not build_response(...) -- see module docstring.
    with database.get_conn() as (_conn, cur):
        cur.execute("SELECT nextval('erp.dispatch_number_seq') AS n")
        n = cur.fetchone()[0]
    return f"DSP-{n}"


@rpc_method("saveDispatch", mutation=True)
@database.transactional
def save_dispatch(conn, cur, form_data):
    form_data = form_data or {}

    product_id = str(form_data.get("productId") or "").strip()
    product_name = str(form_data.get("productName") or "").strip()
    if not product_id or not product_name:
        raise ValueError("Valid Product ID and Product Name are required.")

    qty = _validate_number(form_data.get("qty"), 0.001, 10000000)
    if qty <= 0:
        raise ValueError("Dispatch Quantity must be greater than zero.")

    dispatch_date = date_utils.to_safe_date(form_data.get("dispatchDate")) or date.today()

    order_number = str(form_data.get("orderNumber") or "").strip()
    client_name = str(form_data.get("clientName") or "").strip()
    transport = str(form_data.get("transport") or "").strip()
    remarks = str(form_data.get("remarks") or "").strip()
    invoice_number = str(form_data.get("invoiceNumber") or "").strip()
    private_mark = str(form_data.get("privateMark") or "").strip()
    gr_number = str(form_data.get("grNumber") or "").strip()
    logistics_contractor = str(form_data.get("logisticsContractor") or "").strip()

    row_idx = form_data.get("rowIdx")
    is_edit = bool(row_idx)

    existing = None
    original_qty = 0.0
    if is_edit:
        try:
            target_id = int(row_idx)
        except (TypeError, ValueError):
            raise ValueError("Invalid dispatch record selected for edit.")
        cur.execute(
            "SELECT id, dispatch_number, product_id, qty FROM erp.dispatch WHERE id = %s AND deleted_at IS NULL",
            (target_id,),
        )
        existing = cur.fetchone()
        if existing is None:
            raise ValueError("Invalid dispatch record selected for edit.")

        if str(existing["product_id"] or "").strip().lower() != product_id.lower():
            raise ValueError("Data mismatch: Product ID does not match original row record.")

        original_qty = float(existing["qty"] or 0)

    ready_map = _compute_ready_to_dispatch_map(cur)
    # Pools the bare Product Tag, the '__output__'-prefixed untagged key, and
    # every '||<differentiator>' variant of either -- see
    # _ready_available_qty_for for why the guard is per-product even though
    # the list splits per variant.
    current_ready_qty = _ready_available_qty_for(ready_map, product_id)
    available_qty = current_ready_qty + original_qty

    if qty > available_qty + 0.0001:
        raise ValueError(f'Only {available_qty} unit(s) of "{product_name}" are Ready to Dispatch.')

    order_line_qty = None
    if order_number:
        order_line_qty = _get_client_order_line_qty(cur, order_number, product_id)
        if order_line_qty is not None:
            already_dispatched_for_order = _get_dispatched_qty_for_order(
                cur, order_number, product_id, existing["id"] if is_edit else None
            )
            available_for_order = order_line_qty - already_dispatched_for_order
            if qty > available_for_order + 0.0001:
                raise ValueError(
                    f'Only {available_for_order} unit(s) of "{product_name}" remain pending on PI/Estimate '
                    f'"{order_number}" (ordered {order_line_qty}, already dispatched {already_dispatched_for_order} '
                    "against it). Use a different order reference, or Direct, if this dispatch is really for other stock."
                )

    if is_edit:
        dispatch_number = str(existing["dispatch_number"] or "").strip()
    else:
        cur.execute("SELECT nextval('erp.dispatch_number_seq') AS n")
        dispatch_number = f"DSP-{cur.fetchone()['n']}"

    logistics_rate = contractors_service._get_contractor_rate(cur, logistics_contractor, config_maps.LOGISTICS_PROCESS_NAME)
    logistics_cost = logistics_rate * qty

    resolved_bom_product_id = _find_bom_product_id(cur, product_id)
    resolved_contractor_id = _find_contractor_id_by_name(cur, logistics_contractor)
    user_id = get_current_user_id()

    if is_edit:
        cur.execute(
            """
            UPDATE erp.dispatch SET
                dispatch_date = %s, order_number = %s, client_name = %s, product_id = %s, bom_product_id = %s,
                product_name = %s, qty = %s, transport = %s, remarks = %s, invoice_number = %s,
                private_mark = %s, gr_number = %s, logistics_contractor = %s, contractor_id = %s,
                logistics_rate = %s, logistics_cost = %s, updated_by = %s
            WHERE id = %s
            """,
            (
                dispatch_date, order_number, client_name, product_id, resolved_bom_product_id,
                product_name, qty, transport, remarks, invoice_number,
                private_mark, gr_number, logistics_contractor, resolved_contractor_id,
                logistics_rate, logistics_cost, user_id,
                existing["id"],
            ),
        )
        new_id = existing["id"]
    else:
        cur.execute(
            """
            INSERT INTO erp.dispatch
                (dispatch_number, dispatch_date, order_number, client_name, product_id, bom_product_id,
                 product_name, qty, transport, remarks, invoice_number, private_mark, gr_number,
                 logistics_contractor, contractor_id, logistics_rate, logistics_cost, updated_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (
                dispatch_number, dispatch_date, order_number, client_name, product_id, resolved_bom_product_id,
                product_name, qty, transport, remarks, invoice_number, private_mark, gr_number,
                logistics_contractor, resolved_contractor_id, logistics_rate, logistics_cost, user_id,
            ),
        )
        new_id = cur.fetchone()["id"]

    warehouse_service._recalculate_warehouse_pool(cur)

    message = "Dispatch record updated successfully." if is_edit else "Dispatch recorded successfully."
    if order_number and order_line_qty is None:
        message += f' Note: PI / Estimate "{order_number}" has no line for "{product_name}" (it may have been edited or removed).'

    # Read this dispatch's own just-written row back so the client can
    # patch it into an already-loaded list in place instead of a full
    # reload.
    fresh_row = _fetch_dispatch_record(cur, new_id)

    return build_response(True, {"dispatchNumber": dispatch_number, "row": fresh_row}, message)


@rpc_method("deleteDispatch", mutation=True)
@database.transactional
def delete_dispatch(conn, cur, row_idx, expected_dispatch_number=None, expected_qty=None):
    try:
        target_id = int(row_idx)
    except (TypeError, ValueError):
        raise ValueError("Invalid dispatch record selected for deletion.")

    cur.execute("SELECT dispatch_number, qty FROM erp.dispatch WHERE id = %s AND deleted_at IS NULL", (target_id,))
    row = cur.fetchone()
    if row is None:
        raise ValueError("Invalid dispatch record selected for deletion.")

    if expected_dispatch_number is not None and expected_qty is not None:
        dispatch_number = str(row["dispatch_number"] or "").strip()
        qty = float(row["qty"] or 0)
        if (
            dispatch_number.lower() != str(expected_dispatch_number or "").strip().lower()
            or abs(qty - float(expected_qty)) > 0.0001
        ):
            raise ValueError("Data mismatch: The record has been modified or shifted. Please refresh.")

    cur.execute("UPDATE erp.dispatch SET deleted_at = NOW(), updated_by = %s WHERE id = %s", (get_current_user_id(), target_id))

    warehouse_service._recalculate_warehouse_pool(cur)

    return build_response(True, None, "Dispatch record deleted successfully.")


@rpc_method("deleteDispatchBulk", mutation=True)
@database.transactional
def delete_dispatch_bulk(conn, cur, row_idxs, expected_rows=None):
    target_ids = []
    for r in row_idxs or []:
        try:
            target_ids.append(int(r))
        except (TypeError, ValueError):
            continue

    if not target_ids:
        return build_response(True, None, "No dispatch records selected.")

    expected_by_id = {}
    for e in expected_rows or []:
        e = e or {}
        if e.get("rowIdx") is not None:
            try:
                expected_by_id[int(e["rowIdx"])] = e
            except (TypeError, ValueError):
                continue

    cur.execute(
        "SELECT id, dispatch_number, qty FROM erp.dispatch WHERE deleted_at IS NULL AND id = ANY(%s)",
        (target_ids,),
    )
    rows_by_id = {row["id"]: row for row in cur.fetchall()}

    deletable_ids = []
    skipped_mismatch = 0
    for target_id in target_ids:
        row = rows_by_id.get(target_id)
        if row is None:
            continue

        expected = expected_by_id.get(target_id)
        if expected and expected.get("expectedDispatchNumber") is not None and expected.get("expectedQty") is not None:
            dispatch_number = str(row["dispatch_number"] or "").strip()
            qty = float(row["qty"] or 0)
            if (
                dispatch_number.lower() != str(expected.get("expectedDispatchNumber") or "").strip().lower()
                or abs(qty - float(expected.get("expectedQty"))) > 0.0001
            ):
                skipped_mismatch += 1
                continue

        deletable_ids.append(target_id)

    if not deletable_ids:
        return build_response(False, None, "Data mismatch: the selected record(s) have been modified or shifted. Please refresh.")

    user_id = get_current_user_id()
    cur.execute("UPDATE erp.dispatch SET deleted_at = NOW(), updated_by = %s WHERE id = ANY(%s)", (user_id, deletable_ids))
    rows_deleted = cur.rowcount

    warehouse_service._recalculate_warehouse_pool(cur)

    if skipped_mismatch > 0:
        message = (
            f"Deleted {rows_deleted} dispatch record(s). Skipped {skipped_mismatch} that were modified or "
            "shifted -- please refresh and retry those."
        )
    else:
        message = f"Deleted {rows_deleted} dispatch record(s)."

    return build_response(True, None, message)
