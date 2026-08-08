"""Dispatch, ported from Apps_Script/module_dispatch.js -- the Dispatched
Goods ledger. Header+lines (erp.dispatch_headers/erp.dispatch_lines, see
migrations/erp/023_dispatch_header_lines.sql): one Dispatch Number is a
"bill" shared by one-or-more line items, each carrying its own Product/Qty
and an optional Rate (Amount = Qty * Rate, record-keeping only -- never read
by any availability/pool-crediting math, matching the reference's own
documented framing for those two columns). Split from a flat single-item
table into this shape to match module_dispatch.js's own header+lines model
(reference commits e37529e/6a22f0e), same convention already used here for
PO/Bill/Return (see po_service.py).

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
the BOM sheet directly the same way. None of this changed by the
header+lines split -- it reads warehouse_pool, never erp.dispatch*.

saveDispatch validates every line twice: against the aggregate Ready-to-
Dispatch qty for that line's product (cumulative across every line of this
same bill -- two lines of the same product both draw down the same pool),
and -- if an Order Number is given -- against that specific PI/Estimate
line's own remaining qty, so one dispatch bill can't over-fulfill a small
order using stock really earmarked for a different order of the same
product. Mirrors module_dispatch.js's saveDispatch Validation #1/#2
exactly, just run once per line instead of once per (single-product) save.

Logistics Contractor rate is snapshotted onto the header (one rate for the
whole bill) via contractors_service._get_contractor_rate(name,
config_maps.LOGISTICS_PROCESS_NAME) -- an admin sets a Logistics
Contractor's rate by creating a normal Contractor Rate entry with that
exact hardcoded virtual process-name string, no real Process Master row
needed. Logistics Cost is genuinely per-line (= header's logistics_rate *
that line's qty), stored on the line so each line carries its own
contribution to the bill's total.

dispatch_number uses a real Postgres SEQUENCE (erp.dispatch_number_seq),
same deliberate deviation as PO/Process/Product IDs: a global, unscoped
counter. getNextDispatchNumber previews via nextval() same as
getNextProcessId -- a preview call followed by a real save can
legitimately consume two different values (harmless, already-accepted
tradeoff). Unlike PO, a dispatch bill cannot be renumbered on edit -- the
reference's own saveDispatch has no such feature, so none is added here.

Dispatch Plan (erp.dispatch_plan_lines, see migrations/erp/027_dispatch_
plan.sql) is a day-ahead drag-and-drop staging area, separate from a real
Dispatch bill: warehouse staff pre-assign Ready-to-Dispatch stock to
clients before actually recording anything. It's a flat table (no header
-- see the migration's own comment for why), each line independently
CRUD'd (saveDispatchPlanLine/deleteDispatchPlanLine) rather than replaced
wholesale, guarded against over-committing stock the same way saveDispatch
guards a bill (availableToPlan = pooled Ready-to-Dispatch minus whatever's
already claimed by other still-open plan lines). A card "converts" to a
real bill by opening the ordinary Dispatch modal pre-filled -- save_dispatch
itself marks the source plan lines fulfilled (sourcePlanLineIds), atomic
with the bill save, rather than a second write.
"""

from __future__ import annotations

import json
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
                # Output Item Name, because that is all a Dispatch line can
                # store (erp.dispatch_lines has no differentiator column, and
                # the pool debit in _recalculate_warehouse_pool Pass 3 is
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
    models: a dispatch line records only the product_id, and
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


def _open_planned_qty_map(cur) -> dict:
    """product_id(lower) -> qty already committed to still-open (not yet
    fulfilled) Dispatch Plan lines, summed across EVERY plan date -- a unit
    planned for tomorrow isn't re-plannable for the day after either, until
    its line is fulfilled (converted to a real bill) or removed from its
    card. A fulfilled line is excluded: its qty is already reflected in the
    live dispatchedQty _compute_ready_to_dispatch_map reports, so counting
    it again here would double-subtract from availableToPlan.
    """
    table = config_maps.TABLE_NAMES.get("DISPATCH_PLAN_LINES")
    cur.execute(f"SELECT product_id, qty FROM {table} WHERE fulfilled_dispatch_number IS NULL")
    result: dict = {}
    for row in cur.fetchall():
        key = str(row["product_id"] or "").strip().lower()
        result[key] = result.get(key, 0.0) + float(row["qty"] or 0)
    return result


def _ready_product_name(ready_map: dict, product_id: str) -> str:
    """Best-effort productName lookup by matching product_id against
    _compute_ready_to_dispatch_map's baseKey (same matching
    _ready_available_qty_for uses). Returns "" when the product isn't (or
    is no longer) in Ready to Dispatch at all -- the caller falls back to a
    client-supplied name, mirroring save_dispatch/_normalize_lines' own
    trust model (there is no dedicated product-name-lookup-by-id helper
    anywhere else in this module either).
    """
    key = str(product_id or "").strip().lower()
    for entry in ready_map.values():
        if entry["baseKey"] in (key, f"__output__{key}"):
            return entry["productName"].split(" / ", 1)[0]
    return ""


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


def _get_dispatched_qty_for_order(cur, order_number: str, product_id: str, exclude_header_id=None) -> float:
    """Sums Dispatch qty already committed to (order_number, product_id)
    across every line of every bill, optionally excluding one bill's own
    lines entirely (the header being edited) -- so re-saving a bill against
    the same order/product doesn't double-count its own prior contribution.
    """
    headers_table = config_maps.TABLE_NAMES.get("DISPATCH_HEADERS")
    lines_table = config_maps.TABLE_NAMES.get("DISPATCH_LINES")
    sql = (
        f"SELECT COALESCE(SUM(l.qty), 0) AS total FROM {lines_table} l "
        f"JOIN {headers_table} h ON h.id = l.header_id "
        "WHERE h.deleted_at IS NULL AND lower(h.order_number) = lower(%s) AND lower(l.product_id) = lower(%s)"
    )
    params = [order_number, product_id]
    if exclude_header_id is not None:
        sql += " AND h.id != %s"
        params.append(exclude_header_id)
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


def _normalize_lines(raw_lines) -> list:
    """Parses/validates the `lines` array a dispatch save submits. A line
    missing a product or with qty <= 0 is silently dropped (matches the
    reference's own line-cleaning in saveDispatch), not errored -- only a
    save with ZERO valid lines left after cleaning is rejected.
    """
    if isinstance(raw_lines, str):
        try:
            lines = json.loads(raw_lines) if raw_lines else []
        except ValueError:
            raise ValueError("Invalid line-items data: could not parse JSON.")
    else:
        lines = raw_lines or []

    if not isinstance(lines, list):
        lines = []

    normalized = []
    for line in lines:
        line = line or {}
        product_id = str(line.get("productId") or "").strip()
        product_name = str(line.get("productName") or "").strip()
        if not product_id or not product_name:
            continue
        qty = _validate_number(line.get("qty"), 0.001, 10000000)
        if qty <= 0:
            continue
        rate = _validate_number(line.get("rate"), 0, 10000000)
        normalized.append(
            {
                "productId": product_id,
                "productName": product_name,
                "qty": qty,
                "rate": rate,
                "amount": qty * rate,
            }
        )

    if not normalized:
        raise ValueError("Please specify at least one valid item with a Product and Quantity greater than zero.")
    return normalized


@rpc_method("getReadyToDispatchData")
def get_ready_to_dispatch_data():
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        ready_map = _compute_ready_to_dispatch_map(cur)
        planned_map = _open_planned_qty_map(cur)

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
            # Committed to other still-open Dispatch Plan cards. Pooled per
            # productId the same way the plan's own availability GUARD pools
            # it (see _ready_available_qty_for) -- not scoped to this row's
            # own differentiator variant, since a plan line (like a dispatch
            # line) can't record which variant it's for either.
            "plannedQty": planned_map.get(r["productId"].strip().lower(), 0.0),
            "availableToPlan": max(
                _ready_available_qty_for(ready_map, r["productId"])
                - planned_map.get(r["productId"].strip().lower(), 0.0),
                0.0,
            ),
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


def _load_dispatch_plan_lines(cur, plan_date=None) -> list:
    """Flat read of erp.dispatch_plan_lines, optionally filtered to one
    date. Mirrors _load_dispatch_rows' flatten-then-let-the-frontend-group
    convention -- static/erp/dispatch-plan.js groups these into per-client
    cards client-side, the same way dispatch.js's buildDispatchBills groups
    flat globalDispatch into bills.
    """
    table = config_maps.TABLE_NAMES.get("DISPATCH_PLAN_LINES")
    query = (
        f"SELECT id, plan_date, client_name, product_id, product_name, qty, "
        f"sort_order, fulfilled_dispatch_number FROM {table}"
    )
    params: list = []
    if plan_date is not None:
        query += " WHERE plan_date = %s"
        params.append(plan_date)
    query += " ORDER BY plan_date, lower(client_name), sort_order, id"
    cur.execute(query, params)
    return [
        {
            "lineId": row["id"],
            "planDate": date_utils.to_iso_string(row["plan_date"]) or "",
            "clientName": row["client_name"] or "",
            "productId": row["product_id"] or "",
            "productName": row["product_name"] or "",
            "qty": float(row["qty"]),
            "sortOrder": int(row["sort_order"] or 0),
            "fulfilledDispatchNumber": row["fulfilled_dispatch_number"] or "",
            "fulfilled": row["fulfilled_dispatch_number"] is not None,
        }
        for row in cur.fetchall()
    ]


@rpc_method("getDispatchPlans")
def get_dispatch_plans():
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        records = _load_dispatch_plan_lines(cur)
    return build_response(True, records)


@rpc_method("saveDispatchPlanLine", mutation=True)
@database.transactional
def save_dispatch_plan_line(conn, cur, form_data):
    """Upserts ONE Dispatch Plan line -- a single drag-and-drop action, not
    a whole-plan resubmit (see migration 027's own comment for why plan
    lines have independent CRUD instead of the delete-and-reinsert
    convention every other header+lines module here uses).
    """
    form_data = form_data or {}
    table = config_maps.TABLE_NAMES.get("DISPATCH_PLAN_LINES")

    raw_line_id = form_data.get("lineId")
    line_id = int(raw_line_id) if raw_line_id not in (None, "") else None
    plan_date = date_utils.to_safe_date(form_data.get("planDate"))
    if not plan_date:
        raise ValueError("A Plan Date is required.")
    client_name = str(form_data.get("clientName") or "").strip()
    if not client_name:
        raise ValueError("A Client is required.")
    product_id = str(form_data.get("productId") or "").strip()
    if not product_id:
        raise ValueError("A Product is required.")
    qty = _validate_number(form_data.get("qty"), 0.001, 10000000)
    if qty <= 0:
        raise ValueError("Quantity must be greater than zero.")
    sort_order = int(_validate_number(form_data.get("sortOrder"), 0, 1000000))

    # Credit back this line's own currently-saved qty (only when the
    # product wasn't also changed by this same save) -- same convention as
    # save_dispatch's original_qty_by_product, so re-saving/re-qty-ing a
    # line never rejects against its own prior contribution to the pool.
    credit_back_qty = 0.0
    if line_id is not None:
        cur.execute(f"SELECT product_id, qty, fulfilled_dispatch_number FROM {table} WHERE id = %s", (line_id,))
        existing = cur.fetchone()
        if existing is None:
            raise ValueError("This plan line no longer exists -- it may have already been removed.")
        if existing["fulfilled_dispatch_number"] is not None:
            raise ValueError("This line has already been dispatched and can no longer be edited.")
        if str(existing["product_id"] or "").strip().lower() == product_id.lower():
            credit_back_qty = float(existing["qty"] or 0)

    ready_map = _compute_ready_to_dispatch_map(cur)
    current_ready_qty = _ready_available_qty_for(ready_map, product_id)
    planned_qty = _open_planned_qty_map(cur).get(product_id.lower(), 0.0)
    available_qty = current_ready_qty - planned_qty + credit_back_qty
    if qty > available_qty + 0.0001:
        raise ValueError(
            f'Only {available_qty} unit(s) of "{product_id}" are available to plan '
            "(Ready to Dispatch minus what other open plan cards already claim)."
        )

    product_name = _ready_product_name(ready_map, product_id) or str(form_data.get("productName") or "").strip()
    if not product_name:
        raise ValueError("Could not resolve a Product Name for this line.")

    user_id = get_current_user_id()
    if line_id is not None:
        cur.execute(
            f"""
            UPDATE {table} SET
                plan_date = %s, client_name = %s, product_id = %s, product_name = %s,
                qty = %s, sort_order = %s, updated_at = NOW(), updated_by = %s
            WHERE id = %s
            RETURNING id
            """,
            (plan_date, client_name, product_id, product_name, qty, sort_order, user_id, line_id),
        )
    else:
        cur.execute(
            f"""
            INSERT INTO {table}
                (plan_date, client_name, product_id, product_name, qty, sort_order, updated_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (plan_date, client_name, product_id, product_name, qty, sort_order, user_id),
        )
    saved_id = cur.fetchone()["id"]

    return build_response(True, {"lineId": saved_id}, "Plan saved.")


@rpc_method("deleteDispatchPlanLine", mutation=True)
@database.transactional
def delete_dispatch_plan_line(conn, cur, line_id):
    table = config_maps.TABLE_NAMES.get("DISPATCH_PLAN_LINES")
    cur.execute(f"SELECT fulfilled_dispatch_number FROM {table} WHERE id = %s", (line_id,))
    row = cur.fetchone()
    if row is None:
        return build_response(True, None, "Already removed.")
    if row["fulfilled_dispatch_number"] is not None:
        raise ValueError("This line has already been dispatched and can no longer be removed from the plan.")
    cur.execute(f"DELETE FROM {table} WHERE id = %s", (line_id,))
    return build_response(True, None, "Removed from plan.")


def _load_dispatch_rows(cur, only_dispatch_number: str | None = None) -> list:
    """Core of getDispatchData: one FLAT record per line, header fields
    denormalized onto every line -- deliberately NOT grouped into bills
    server-side, even though Postgres already has the header+lines split
    available for a JOIN. App.State.globalDispatch is consumed as a flat
    per-line array by several other client modules that predate this
    header+lines redesign (client.js's ledger/pending-order-line
    calculations, stock.js's stock-history projection) -- the exact
    "everything else keeps working unchanged" reason the reference itself
    documents for keeping its own globalDispatch flat and grouping into
    "bills" separately, client-side, only for the Dispatch module's own
    ledger table/modal (see static/erp/dispatch.js's buildDispatchBills).
    Matches _row_to_dispatch_record's pre-redesign field set exactly, plus
    lineId/rate/amount.
    """
    headers_table = config_maps.TABLE_NAMES.get("DISPATCH_HEADERS")
    lines_table = config_maps.TABLE_NAMES.get("DISPATCH_LINES")
    query = f"""
        SELECT h.dispatch_number, h.dispatch_date, h.order_number, h.client_name,
               h.transport, h.remarks, h.invoice_number, h.private_mark, h.gr_number,
               h.logistics_contractor, h.logistics_rate,
               l.id AS line_id, l.product_id, l.product_name, l.qty, l.rate, l.amount, l.logistics_cost
        FROM {headers_table} h
        JOIN {lines_table} l ON l.header_id = h.id
        WHERE h.deleted_at IS NULL
    """
    params: list = []
    if only_dispatch_number is not None:
        query += " AND lower(h.dispatch_number) = lower(%s)"
        params.append(only_dispatch_number)
    query += " ORDER BY h.id, l.id"

    cur.execute(query, params)

    records = [
        {
            "lineId": row["line_id"],
            "dispatchNumber": row["dispatch_number"] or "",
            "dispatchDate": date_utils.to_display_string(row["dispatch_date"]) or "",
            "dateRaw": date_utils.to_iso_string(row["dispatch_date"]) or "",
            "orderNumber": row["order_number"] or "",
            "clientName": row["client_name"] or "",
            "productId": row["product_id"] or "",
            "productName": row["product_name"] or "",
            "qty": float(row["qty"]),
            "rate": float(row["rate"]),
            "amount": float(row["amount"]),
            "transport": row["transport"] or "",
            "remarks": row["remarks"] or "",
            "invoiceNumber": row["invoice_number"] or "",
            "privateMark": row["private_mark"] or "",
            "grNumber": row["gr_number"] or "",
            "logisticsContractor": row["logistics_contractor"] or "",
            "logisticsRate": float(row["logistics_rate"]),
            "logisticsCost": float(row["logistics_cost"]),
        }
        for row in cur.fetchall()
    ]
    records.sort(key=lambda r: (r["dateRaw"] or "", r["dispatchNumber"], r["lineId"]), reverse=True)
    return records


@rpc_method("getDispatchData")
def get_dispatch_data():
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        records = _load_dispatch_rows(cur)
    return build_response(True, records)


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

    lines = _normalize_lines(form_data.get("lines"))

    dispatch_date = date_utils.to_safe_date(form_data.get("dispatchDate")) or date.today()
    order_number = str(form_data.get("orderNumber") or "").strip()
    client_name = str(form_data.get("clientName") or "").strip()
    transport = str(form_data.get("transport") or "").strip()
    remarks = str(form_data.get("remarks") or "").strip()
    invoice_number = str(form_data.get("invoiceNumber") or "").strip()
    private_mark = str(form_data.get("privateMark") or "").strip()
    gr_number = str(form_data.get("grNumber") or "").strip()
    logistics_contractor = str(form_data.get("logisticsContractor") or "").strip()

    old_dispatch_number = str(form_data.get("existingDispatchNumber") or "").strip()
    is_edit = bool(old_dispatch_number)

    headers_table = config_maps.TABLE_NAMES.get("DISPATCH_HEADERS")
    lines_table = config_maps.TABLE_NAMES.get("DISPATCH_LINES")

    header_id = None
    # This bill's own currently-saved qty per product -- credited back onto
    # that product's availability below, so re-saving a bill (unchanged, or
    # with only some lines changed) never rejects against its own prior
    # consumption before the pool has a chance to reflect the edit.
    original_qty_by_product: dict = {}
    if is_edit:
        cur.execute(
            f"SELECT id FROM {headers_table} WHERE lower(dispatch_number) = lower(%s) AND deleted_at IS NULL",
            (old_dispatch_number,),
        )
        header_row = cur.fetchone()
        if header_row is None:
            raise ValueError(f'Dispatch "{old_dispatch_number}" not found.')
        header_id = header_row["id"]

        cur.execute(f"SELECT product_id, qty FROM {lines_table} WHERE header_id = %s", (header_id,))
        for r in cur.fetchall():
            key = str(r["product_id"] or "").strip().lower()
            original_qty_by_product[key] = original_qty_by_product.get(key, 0.0) + float(r["qty"] or 0)

        dispatch_number = old_dispatch_number
    else:
        cur.execute("SELECT nextval('erp.dispatch_number_seq') AS n")
        dispatch_number = f"DSP-{cur.fetchone()['n']}"

    # Guard #1: Ready-to-Dispatch availability, cumulative across this
    # bill's own lines -- two lines of the same product both draw down the
    # same pool. Mirrors module_dispatch.js's saveDispatch Validation #1.
    ready_map = _compute_ready_to_dispatch_map(cur)
    reserved_by_product: dict = {}
    for line in lines:
        key = line["productId"].strip().lower()
        current_ready_qty = _ready_available_qty_for(ready_map, line["productId"])
        available_qty = current_ready_qty + original_qty_by_product.get(key, 0.0)
        reserved_so_far = reserved_by_product.get(key, 0.0)
        if reserved_so_far + line["qty"] > available_qty + 0.0001:
            raise ValueError(
                f'Only {available_qty} unit(s) of "{line["productName"]}" are Ready to Dispatch '
                f'(requested {reserved_so_far + line["qty"]} across this bill).'
            )
        reserved_by_product[key] = reserved_so_far + line["qty"]

    # Guard #2: per-order-line remaining qty, only when an order/PI is
    # referenced. A line whose product has no matching order line at all is
    # a soft "Note:" on the response (not blocking); a line that would
    # over-fulfill what actually remains open on the order is a hard block.
    # Mirrors Validation #2, run per line and reserved cumulatively the same
    # way as Guard #1.
    order_line_notes: list = []
    if order_number:
        order_reserved_by_product: dict = {}
        for line in lines:
            key = line["productId"].strip().lower()
            order_line_qty = _get_client_order_line_qty(cur, order_number, line["productId"])
            if order_line_qty is None:
                if line["productName"] not in order_line_notes:
                    order_line_notes.append(line["productName"])
                continue
            already_dispatched_for_order = _get_dispatched_qty_for_order(
                cur, order_number, line["productId"], header_id if is_edit else None
            )
            available_for_order = order_line_qty - already_dispatched_for_order
            reserved_so_far = order_reserved_by_product.get(key, 0.0)
            if reserved_so_far + line["qty"] > available_for_order + 0.0001:
                raise ValueError(
                    f'Only {available_for_order} unit(s) of "{line["productName"]}" remain pending on PI/Estimate '
                    f'"{order_number}" (ordered {order_line_qty}, already dispatched {already_dispatched_for_order} '
                    "against it). Use a different order reference, or Direct, if this dispatch is really for other stock."
                )
            order_reserved_by_product[key] = reserved_so_far + line["qty"]

    logistics_rate = contractors_service._get_contractor_rate(cur, logistics_contractor, config_maps.LOGISTICS_PROCESS_NAME)
    resolved_contractor_id = _find_contractor_id_by_name(cur, logistics_contractor)
    user_id = get_current_user_id()

    if is_edit:
        cur.execute(
            f"""
            UPDATE {headers_table} SET
                dispatch_date = %s, order_number = %s, client_name = %s, transport = %s, remarks = %s,
                invoice_number = %s, private_mark = %s, gr_number = %s,
                logistics_contractor = %s, contractor_id = %s, logistics_rate = %s, updated_by = %s
            WHERE id = %s
            """,
            (
                dispatch_date, order_number, client_name, transport, remarks,
                invoice_number, private_mark, gr_number,
                logistics_contractor, resolved_contractor_id, logistics_rate, user_id,
                header_id,
            ),
        )
        cur.execute(f"DELETE FROM {lines_table} WHERE header_id = %s", (header_id,))
    else:
        cur.execute(
            f"""
            INSERT INTO {headers_table}
                (dispatch_number, dispatch_date, order_number, client_name, transport, remarks,
                 invoice_number, private_mark, gr_number, logistics_contractor, contractor_id,
                 logistics_rate, updated_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (
                dispatch_number, dispatch_date, order_number, client_name, transport, remarks,
                invoice_number, private_mark, gr_number, logistics_contractor, resolved_contractor_id,
                logistics_rate, user_id,
            ),
        )
        header_id = cur.fetchone()["id"]

    for line in lines:
        resolved_bom_product_id = _find_bom_product_id(cur, line["productId"])
        line_logistics_cost = logistics_rate * line["qty"]
        cur.execute(
            f"""
            INSERT INTO {lines_table}
                (header_id, product_id, bom_product_id, product_name, qty, rate, amount, logistics_cost)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                header_id, line["productId"], resolved_bom_product_id, line["productName"],
                line["qty"], line["rate"], line["amount"], line_logistics_cost,
            ),
        )

    # Dispatch Plan hand-off: when this bill was saved by converting a
    # plan card (App.Dispatch.openPrefilledDispatchModal), mark those plan
    # lines fulfilled atomically with the bill itself -- one write, no
    # partial-failure window between "bill saved" and "plan card cleared".
    # Regardless of any qty edited in the modal before saving: converting
    # IS the action, a plan is a forecast, not a contract to match exactly.
    # An id already removed by someone else is a silent no-op (correct).
    raw_source_plan_line_ids = form_data.get("sourcePlanLineIds")
    if raw_source_plan_line_ids:
        try:
            parsed_ids = (
                json.loads(raw_source_plan_line_ids)
                if isinstance(raw_source_plan_line_ids, str)
                else raw_source_plan_line_ids
            )
        except ValueError:
            parsed_ids = []
        source_plan_line_ids = [int(i) for i in (parsed_ids or []) if str(i).strip().lstrip("-").isdigit()]
        if source_plan_line_ids:
            plan_lines_table = config_maps.TABLE_NAMES.get("DISPATCH_PLAN_LINES")
            cur.execute(
                f"UPDATE {plan_lines_table} SET fulfilled_dispatch_number = %s, fulfilled_at = NOW() "
                "WHERE id = ANY(%s)",
                (dispatch_number, source_plan_line_ids),
            )

    warehouse_service._recalculate_warehouse_pool(cur)

    message = f'Dispatch "{dispatch_number}" updated successfully.' if is_edit else f'Dispatch "{dispatch_number}" recorded successfully.'
    if order_line_notes:
        names = ", ".join(f'"{n}"' for n in order_line_notes)
        message += f' Note: PI / Estimate "{order_number}" has no line for {names} (it may have been edited or removed).'

    # Read this bill's own just-written lines back (flat, one per line) so
    # the client can patch them into its already-loaded globalDispatch array
    # in place instead of a full reload -- mirrors the reference's own
    # saveDispatch response (freshRows).
    fresh_rows = _load_dispatch_rows(cur, only_dispatch_number=dispatch_number)

    return build_response(True, {"dispatchNumber": dispatch_number, "rows": fresh_rows}, message)


@rpc_method("deleteDispatch", mutation=True)
@database.transactional
def delete_dispatch(conn, cur, dispatch_number, expected_item_count=None, expected_total_qty=None):
    target = str(dispatch_number or "").strip()
    if not target:
        raise ValueError("Dispatch number must not be empty.")

    headers_table = config_maps.TABLE_NAMES.get("DISPATCH_HEADERS")
    lines_table = config_maps.TABLE_NAMES.get("DISPATCH_LINES")

    cur.execute(
        f"SELECT id FROM {headers_table} WHERE lower(dispatch_number) = lower(%s) AND deleted_at IS NULL",
        (target,),
    )
    row = cur.fetchone()
    if row is None:
        raise ValueError(f'Dispatch "{target}" not found.')
    header_id = row["id"]

    # Cheap two-number fingerprint of the bill (item count + total qty),
    # mirroring module_dispatch.js's deleteDispatch(dispatchNumber,
    # expectedItemCount, expectedTotalQty) exactly -- itemCount alone can't
    # catch "a line's qty was edited without changing line count", totalQty
    # alone can't catch "a line was swapped for a different one that happens
    # to sum the same"; together they catch both without a full line-by-line
    # diff. Only enforced when the caller actually provides both (older
    # callers omitting them keep unconditional-delete behavior).
    if expected_item_count is not None and expected_total_qty is not None:
        cur.execute(
            f"SELECT COUNT(*) AS item_count, COALESCE(SUM(qty), 0) AS total_qty FROM {lines_table} WHERE header_id = %s",
            (header_id,),
        )
        stats = cur.fetchone()
        if (
            int(stats["item_count"]) != int(expected_item_count)
            or abs(float(stats["total_qty"]) - float(expected_total_qty)) > 0.0001
        ):
            raise ValueError("Data mismatch: The bill has been modified since it was loaded. Please refresh.")

    cur.execute(
        f"UPDATE {headers_table} SET deleted_at = NOW(), updated_by = %s WHERE id = %s",
        (get_current_user_id(), header_id),
    )

    warehouse_service._recalculate_warehouse_pool(cur)

    return build_response(True, None, f'Dispatch "{target}" deleted.')


@rpc_method("deleteDispatchBulk", mutation=True)
@database.transactional
def delete_dispatch_bulk(conn, cur, dispatch_numbers, expected_bills=None):
    targets = [str(n or "").strip() for n in (dispatch_numbers or []) if str(n or "").strip()]
    if not targets:
        return build_response(True, None, "No dispatch bills selected.")

    headers_table = config_maps.TABLE_NAMES.get("DISPATCH_HEADERS")
    lines_table = config_maps.TABLE_NAMES.get("DISPATCH_LINES")

    expected_by_number = {}
    for e in expected_bills or []:
        e = e or {}
        number = str(e.get("dispatchNumber") or "").strip().lower()
        if number:
            expected_by_number[number] = e

    cur.execute(
        f"""
        SELECT h.id, h.dispatch_number, COUNT(l.id) AS item_count, COALESCE(SUM(l.qty), 0) AS total_qty
        FROM {headers_table} h LEFT JOIN {lines_table} l ON l.header_id = h.id
        WHERE h.deleted_at IS NULL AND lower(h.dispatch_number) = ANY(%s)
        GROUP BY h.id, h.dispatch_number
        """,
        ([t.lower() for t in targets],),
    )
    rows_by_number = {row["dispatch_number"].lower(): row for row in cur.fetchall()}

    # Skip-not-abort, per bill -- a mismatched/missing bill is excluded from
    # this batch rather than failing the whole delete, so the rest still
    # goes through. Mirrors deleteDispatchBulk exactly.
    deletable_ids = []
    skipped_missing = 0
    skipped_mismatch = 0
    for target in targets:
        row = rows_by_number.get(target.lower())
        if row is None:
            skipped_missing += 1
            continue

        expected = expected_by_number.get(target.lower())
        if expected and expected.get("expectedItemCount") is not None and expected.get("expectedTotalQty") is not None:
            if (
                int(row["item_count"]) != int(expected["expectedItemCount"])
                or abs(float(row["total_qty"]) - float(expected["expectedTotalQty"])) > 0.0001
            ):
                skipped_mismatch += 1
                continue

        deletable_ids.append(row["id"])

    if not deletable_ids:
        if skipped_mismatch > 0 and skipped_missing == 0:
            return build_response(False, None, "Data mismatch: the selected bill(s) have been modified or shifted. Please refresh.")
        return build_response(False, None, "None of the selected dispatch bills were found.")

    user_id = get_current_user_id()
    cur.execute(f"UPDATE {headers_table} SET deleted_at = NOW(), updated_by = %s WHERE id = ANY(%s)", (user_id, deletable_ids))
    bills_deleted = cur.rowcount

    warehouse_service._recalculate_warehouse_pool(cur)

    notes = []
    if skipped_mismatch:
        notes.append(f"Skipped {skipped_mismatch} that were modified or shifted -- please refresh and retry those.")
    if skipped_missing:
        notes.append(f"{skipped_missing} were already gone.")
    message = f"Deleted {bills_deleted} dispatch bill(s)."
    if notes:
        message += " " + " ".join(notes)

    return build_response(True, None, message)
