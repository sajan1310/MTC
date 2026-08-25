"""Clients + PI/Estimates (Client Orders), ported from
Apps_Script/module_clients.js. Closes Phase 4: Clients is the only
remaining cross-module *write* dependency in the whole port (Production,
Warehouse Pool, Dispatch, Contractors, BOM all get read by other modules,
but nothing else writes into another module's table the way this one
writes into erp.production).

Clients master CRUD mirrors module_vendors.js's rename-by-
original-name pattern (vendors_service.py) -- but with one real
deviation: Clients blocks delete when referenced by a PI/Estimate or a
Dispatch record (_client_in_use_message); Vendors' own delete has no
such guard at all. _rename_client_everywhere cascades a rename into
Client Orders' client_name and Dispatch's client_name, using a
case-sensitive top-level guard (`old == new`, not `old.lower() ==
new.lower()`) so a casing-only rename still cascades -- matches every
prior rename cascade's own convention.

PI/Estimates (Client Orders) is header+lines, edit-by-replace like BOM
(bom_service.py) -- registered as TWO TABLE_NAMES keys
(CLIENT_ORDERS_HEADERS/CLIENT_ORDERS_LINES), not a flat CLIENT_ORDERS
key, since header-level fields (orderDate, clientName, status,
orderRemarks) and line-level fields (productId, qty, lineRemarks,
productionPushed) live on different tables -- the same "flat key" trap
this project has hit and fixed several times before (BOM, Phase 3c).
Fixed two pre-existing instances of exactly this mistake as part of this
round: bom_service._get_product_ids_in_use (had looped CLIENT_ORDERS as
if it were a flat single table) and dispatch_service.
_get_client_order_line_qty (same mistake, written speculatively in
Phase 4a before this schema was decided).

saveClientOrder validates every line's Product ID against
bom_service.get_bom_production_data() (already ported, ungated) -- a
product not in BOM is a hard reject. Edit-by-replace carries forward
each product's *count* of already-pushed lines (not a per-product
boolean), so a second line for the same product on the same PI isn't
wrongly marked pushed just because an earlier line for that product
already was.

_push_order_lines_to_production ports _pushOrderLinesToProduction
exactly: a RAW INSERT into erp.production, deliberately bypassing
production_service.save_production's validation entirely (no
color-breakdown checks, no contractor payable, hardcoded
status='Pending', assignedTo left blank) -- matches source's own raw
sheet-row append. Reuses bom_service._get_bom_final_stage_process_map
(pre-written in Phase 3c, dormant until now), process_service.
get_process_color_groups/get_process_components_data, and
production_service._generate_lot_number/_find_process_master_id. Does
not touch Stock or Warehouse Pool -- a Pending lot doesn't affect either
until it's later marked Completed through the normal Production flow.

erp.clients and erp.client_orders_headers get full sync columns + soft
delete, the same deliberate deviation from source's hard
deleteRow/deleteRowsById as every other "document" table this project
has ported. erp.client_orders_lines is a child table with no sync
columns, wholesale deleted+reinserted on edit -- mirrors erp.bom_lines
exactly.

order_number uses a real Postgres SEQUENCE (erp.order_number_seq), same
deliberate deviation as PO/Process/Product/Dispatch numbers: a global,
unscoped counter.

Column note: config_maps.CLIENTS_COL_NAMES (transcribed from config.js
in Phase 0) uses 'gstNumber' as its sheet-column-index key, but the
actual RPC field name used throughout module_clients.js (formData.gstin,
getClientsData's response key) is 'gstin' -- a genuine mismatch in the
source's own config between its column registry and its RPC payload
shape. This port's erp.clients.gstin column follows the real RPC field
name, matching this project's established convention; no guarded
cascade touches this field, so the choice is local to this module.
"""

from __future__ import annotations

import json
import math
import re
from datetime import date

import psycopg2.extras

import database
from . import bom_service
from . import process_service
from . import production_service
from . import rename_utils
from .current_user import get_current_user_id
from .. import config_maps
from .. import date_utils
from ..envelope import build_response
from ..registry import rpc_method

_CLIENT_ORDER_STATUSES = ("Estimate", "Order Confirmed", "Cancelled")
_COLOR_GROUP_COMMON = config_maps.COMPONENT_COLOR_GROUP_COMMON
_MAX_REMARKS_LENGTH = 500


def _validate_number(value, min_value: float, max_value: float) -> float:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(n) or n < min_value or n > max_value:
        return 0.0
    return n


def _natural_sort_key(s: str) -> list:
    return [int(chunk) if chunk.isdigit() else chunk.lower() for chunk in re.split(r"(\d+)", s or "")]


def _find_bom_product_id(cur, product_id_str: str):
    if not product_id_str:
        return None
    cur.execute(
        "SELECT id FROM erp.bom_products WHERE lower(product_id) = lower(%s) AND deleted_at IS NULL",
        (product_id_str,),
    )
    row = cur.fetchone()
    return row["id"] if row else None


# ─────────────────────────────────────────────────────────────────────────
# Clients master
# ─────────────────────────────────────────────────────────────────────────


def _client_in_use_message(cur, client_name: str):
    name = str(client_name or "").strip()
    if not name:
        return None

    if headers_table := config_maps.TABLE_NAMES.get("CLIENT_ORDERS_HEADERS"):
        cur.execute(
            f"SELECT 1 FROM {headers_table} WHERE deleted_at IS NULL AND lower(client_name) = lower(%s) LIMIT 1",
            (name,),
        )
        if cur.fetchone():
            return f'Cannot delete "{client_name}": referenced by PI/Estimate records.'

    if table := config_maps.TABLE_NAMES.get("DISPATCH_HEADERS"):
        cur.execute(
            f"SELECT 1 FROM {table} WHERE deleted_at IS NULL AND lower(client_name) = lower(%s) LIMIT 1",
            (name,),
        )
        if cur.fetchone():
            return f'Cannot delete "{client_name}": referenced by Dispatch records.'

    return None


def _rename_client_everywhere(cur, old_name: str, new_name: str) -> None:
    old = str(old_name or "").strip()
    new = str(new_name or "").strip()
    if not old or not new or old == new:
        return

    if headers_table := config_maps.TABLE_NAMES.get("CLIENT_ORDERS_HEADERS"):
        rename_utils.rename_in_column(cur, headers_table, "client_name", old, new)

    if dispatch_table := config_maps.TABLE_NAMES.get("DISPATCH_HEADERS"):
        rename_utils.rename_in_column(cur, dispatch_table, "client_name", old, new)

    # Dispatch Plan cards are drafts, not commitments -- deliberately NOT
    # added to _client_in_use_message's delete-guard above (an open plan
    # card shouldn't block deleting a client), but a rename still needs to
    # flow through here or an open card would silently keep pointing at a
    # name that no longer exists.
    if plan_lines_table := config_maps.TABLE_NAMES.get("DISPATCH_PLAN_LINES"):
        rename_utils.rename_in_column(cur, plan_lines_table, "client_name", old, new)


@rpc_method("getClientsData")
def get_clients_data():
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        cur.execute("SELECT client_name, contact, address, gstin, remarks FROM erp.clients WHERE deleted_at IS NULL")
        rows = cur.fetchall()

    clients = [
        {
            "name": row["client_name"],
            "contact": row["contact"] or "",
            "address": row["address"] or "",
            "gstin": row["gstin"] or "",
            "remarks": row["remarks"] or "",
        }
        for row in rows
    ]
    clients.sort(key=lambda c: c["name"].lower())
    return build_response(True, clients)


@rpc_method("saveClient", mutation=True)
@database.transactional
def save_client(conn, cur, form_data):
    form_data = form_data or {}

    new_name = str(form_data.get("clientName") or "").strip()
    if not new_name:
        raise ValueError("Client name cannot be empty.")

    contact = str(form_data.get("contact") or "").strip()
    address = str(form_data.get("address") or "").strip()
    gstin = str(form_data.get("gstin") or "").strip()
    remarks = str(form_data.get("remarks") or "").strip()

    is_edit = bool(form_data.get("originalClientName"))
    original_name = str(form_data.get("originalClientName")).strip() if is_edit else new_name

    cur.execute(
        "SELECT id FROM erp.clients WHERE lower(client_name) = lower(%s) AND deleted_at IS NULL",
        (original_name,),
    )
    existing = cur.fetchone()

    if is_edit and existing is None:
        raise ValueError("Original client not found in sheet.")
    if not is_edit and existing is not None:
        raise ValueError("A client with this name already exists.")

    if is_edit and new_name.lower() != original_name.lower():
        cur.execute(
            "SELECT id FROM erp.clients WHERE lower(client_name) = lower(%s) AND deleted_at IS NULL AND id != %s",
            (new_name, existing["id"]),
        )
        if cur.fetchone():
            raise ValueError("Another client with this new name already exists.")

    user_id = get_current_user_id()

    if is_edit:
        cur.execute(
            """
            UPDATE erp.clients SET client_name = %s, contact = %s, address = %s, gstin = %s, remarks = %s, updated_by = %s
            WHERE id = %s
            """,
            (new_name, contact, address, gstin, remarks, user_id, existing["id"]),
        )
        # Plain string compare (not case-insensitive) -- a casing-only edit
        # must still cascade, matching every prior rename cascade.
        if new_name != original_name:
            _rename_client_everywhere(cur, original_name, new_name)
    else:
        cur.execute(
            "INSERT INTO erp.clients (client_name, contact, address, gstin, remarks, updated_by) VALUES (%s, %s, %s, %s, %s, %s)",
            (new_name, contact, address, gstin, remarks, user_id),
        )

    message = f'Client "{new_name}" updated.' if is_edit else f'Client "{new_name}" registered.'

    # The client can patch this into an already-loaded list in place
    # instead of a full reload.
    fresh_client = {"name": new_name, "contact": contact, "address": address, "gstin": gstin, "remarks": remarks}

    return build_response(True, {"name": new_name, "client": fresh_client}, message)


@rpc_method("deleteClient", mutation=True)
@database.transactional
def delete_client(conn, cur, client_name):
    target = str(client_name or "").strip()
    if not target:
        raise ValueError("Client not found.")

    cur.execute(
        "SELECT id FROM erp.clients WHERE lower(client_name) = lower(%s) AND deleted_at IS NULL",
        (target,),
    )
    row = cur.fetchone()
    if row is None:
        raise ValueError("Client not found.")

    in_use = _client_in_use_message(cur, target)
    if in_use:
        raise ValueError(in_use)

    cur.execute(
        "UPDATE erp.clients SET deleted_at = NOW(), updated_by = %s WHERE id = %s",
        (get_current_user_id(), row["id"]),
    )
    return build_response(True, None, f'Client "{client_name}" deleted from master.')


@rpc_method("deleteClientsBulk", mutation=True)
@database.transactional
def delete_clients_bulk(conn, cur, client_names):
    requested = [str(n or "").strip() for n in (client_names or []) if str(n or "").strip()]
    if not requested:
        return build_response(True, None, "No clients selected.")

    in_use = [n for n in requested if _client_in_use_message(cur, n)]
    deletable = [n for n in requested if n not in in_use]

    if not deletable:
        if in_use:
            return build_response(
                False, None,
                f"No clients deleted -- all selected have PI/Estimate or Dispatch history: {', '.join(in_use)}.",
            )
        return build_response(True, None, "No clients to delete.")

    user_id = get_current_user_id()
    cur.execute(
        "UPDATE erp.clients SET deleted_at = NOW(), updated_by = %s WHERE deleted_at IS NULL AND lower(client_name) = ANY(%s)",
        (user_id, [n.lower() for n in deletable]),
    )
    rows_deleted = cur.rowcount

    message = f"Deleted {rows_deleted} client(s) from master."
    if in_use:
        message += f" Skipped {len(in_use)} client(s) with PI/Estimate or Dispatch history: {', '.join(in_use)}."

    return build_response(True, None, message)


# ─────────────────────────────────────────────────────────────────────────
# PI / Estimates (Client Orders)
# ─────────────────────────────────────────────────────────────────────────


@rpc_method("getNextOrderNumber")
def get_next_order_number():
    # Bare string return, not build_response(...) -- see module docstring.
    with database.get_conn() as (_conn, cur):
        cur.execute("SELECT nextval('erp.order_number_seq') AS n")
        n = cur.fetchone()[0]
    return f"ORD-{n}"


@rpc_method("getClientOrdersData")
def get_client_orders_data():
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        cur.execute(
            """
            SELECT h.id AS header_id, h.order_number, h.order_date, h.client_name, h.status, h.order_remarks,
                   l.product_id, l.product_name, l.qty, l.line_remarks, l.production_pushed
            FROM erp.client_orders_headers h
            LEFT JOIN erp.client_orders_lines l ON l.header_id = h.id
            WHERE h.deleted_at IS NULL
            ORDER BY h.id, l.id
            """
        )
        rows = cur.fetchall()

    order_map: dict = {}
    for row in rows:
        order_number = row["order_number"]
        order = order_map.get(order_number)
        if order is None:
            order = {
                "orderNumber": order_number,
                "orderDate": date_utils.to_display_string(row["order_date"]) or "",
                "dateRaw": date_utils.to_iso_string(row["order_date"]) or "",
                "clientName": row["client_name"] or "",
                "status": row["status"] or "Estimate",
                "orderRemarks": row["order_remarks"] or "",
                "lines": [],
            }
            order_map[order_number] = order

        product_id = row["product_id"]
        if not product_id:
            continue
        pushed_raw = str(row["production_pushed"] or "").strip().lower()
        order["lines"].append(
            {
                "productId": product_id,
                "productName": row["product_name"] or "",
                "qty": float(row["qty"]),
                "lineRemarks": row["line_remarks"] or "",
                "productionPushed": pushed_raw == "yes",
                "needsManualProduction": pushed_raw == "manual",
            }
        )

    orders = list(order_map.values())
    orders.sort(key=lambda o: _natural_sort_key(o["orderNumber"]), reverse=True)
    return build_response(True, orders)


def _push_order_lines_to_production(cur, order_number: str, client_name: str, lines: list) -> dict:
    """Appends a new Pending Production lot for each line whose product
    resolves to exactly one final-stage Process that isn't itself
    multi-color. Raw INSERT, deliberately bypassing
    production_service.save_production -- see module docstring.
    """
    auto_queued: set = set()
    lots_created = 0

    final_stage_by_product = bom_service._get_bom_final_stage_process_map(cur)
    user_id = get_current_user_id()

    for line in lines:
        process = final_stage_by_product.get(line["productId"].lower())
        if process is None:
            continue

        color_groups = process_service._fetch_process_color_groups(cur, process["processId"])
        if color_groups:
            continue

        recipe_components = process_service._fetch_process_components(cur, process["processId"])
        components_consumed = []
        for c in recipe_components:
            if not process_service._is_common_color_group(c["colorGroup"]):
                continue
            item_name = c["itemName"]
            qty = (float(c.get("qtyPerUnit") or 0)) * line["qty"]
            if not item_name or qty <= 0:
                continue
            components_consumed.append(
                {
                    "itemName": item_name,
                    "size": c.get("size") or "",
                    "color": "",
                    "sourceType": "POOL" if c["sourceType"] == "POOL" else "ITEM",
                    "qty": qty,
                    "colorGroup": _COLOR_GROUP_COMMON,
                    "unit": c.get("unit") or "",
                }
            )

        lot_number = production_service._generate_lot_number(cur, process["lotPrefix"])
        bom_product_id = _find_bom_product_id(cur, line["productId"])
        process_master_id = production_service._find_process_master_id(cur, process["processId"])

        cur.execute(
            """
            INSERT INTO erp.production
                (production_date, product_id, bom_product_id, product_name, qty, assigned_to, status, remarks,
                 process_id, process_master_id, lot_number, output_item_name, components_consumed,
                 order_number, updated_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                date.today(), line["productId"], bom_product_id, line["productName"], line["qty"], "",
                "Pending", f"Auto-queued from PI {order_number} - {client_name}",
                process["processId"], process_master_id, lot_number, process["outputItemName"],
                json.dumps(components_consumed), order_number, user_id,
            ),
        )
        auto_queued.add(line["productId"].lower())
        lots_created += 1

    return {"autoQueued": auto_queued, "lotsCreated": lots_created}


@rpc_method("saveClientOrder", mutation=True)
@database.transactional
def save_client_order(conn, cur, form_data):
    form_data = form_data or {}

    client_name = str(form_data.get("clientName") or "").strip()
    if not client_name:
        raise ValueError("Client is required.")

    status = str(form_data.get("status") or "Estimate").strip()
    if status not in _CLIENT_ORDER_STATUSES:
        raise ValueError("Invalid status value.")

    order_date = date_utils.to_safe_date(form_data.get("orderDate")) or date.today()
    order_remarks = str(form_data.get("orderRemarks") or "").strip()[:_MAX_REMARKS_LENGTH]

    raw_lines = form_data.get("lines")
    if isinstance(raw_lines, str):
        try:
            raw_lines = json.loads(raw_lines) if raw_lines else []
        except ValueError:
            raise ValueError("Invalid product line data format.")
    if not isinstance(raw_lines, list) or not raw_lines:
        raise ValueError("PI / Estimate must contain at least one product line.")

    bom_products = bom_service._fetch_bom_production_data(cur)
    valid_product_ids = {p["productId"].lower() for p in bom_products}
    product_name_map = {p["productId"].lower(): p["productName"] for p in bom_products}

    order_number_input = str(form_data.get("orderNumber") or "").strip()
    is_edit = bool(order_number_input)

    pushed_count_by_product: dict = {}

    if is_edit:
        order_number = order_number_input
        cur.execute(
            "SELECT id FROM erp.client_orders_headers WHERE lower(order_number) = lower(%s) AND deleted_at IS NULL",
            (order_number,),
        )
        existing = cur.fetchone()
        if existing is None:
            raise ValueError(f'PI / Estimate "{order_number}" not found.')
        header_id = existing["id"]

        cur.execute("SELECT product_id, production_pushed FROM erp.client_orders_lines WHERE header_id = %s", (header_id,))
        for row in cur.fetchall():
            pid = str(row["product_id"] or "").strip().lower()
            pushed = str(row["production_pushed"] or "").strip().lower() == "yes"
            if pid and pushed:
                pushed_count_by_product[pid] = pushed_count_by_product.get(pid, 0) + 1

        cur.execute(
            """
            UPDATE erp.client_orders_headers SET order_date = %s, client_name = %s, status = %s, order_remarks = %s,
                updated_by = %s
            WHERE id = %s
            """,
            (order_date, client_name, status, order_remarks, get_current_user_id(), header_id),
        )
        cur.execute("DELETE FROM erp.client_orders_lines WHERE header_id = %s", (header_id,))
    else:
        cur.execute("SELECT nextval('erp.order_number_seq') AS n")
        order_number = f"ORD-{cur.fetchone()['n']}"
        cur.execute(
            """
            INSERT INTO erp.client_orders_headers (order_number, order_date, client_name, status, order_remarks, updated_by)
            VALUES (%s, %s, %s, %s, %s, %s) RETURNING id
            """,
            (order_number, order_date, client_name, status, order_remarks, get_current_user_id()),
        )
        header_id = cur.fetchone()["id"]

    clean_lines = []
    for line in raw_lines:
        line = line or {}
        product_id = str(line.get("productId") or "").strip()
        if not product_id:
            continue

        if product_id.lower() not in valid_product_ids:
            raise ValueError(f'Product "{product_id}" is not defined in BOM and cannot be added to a PI / Estimate.')

        qty = _validate_number(line.get("qty"), 0.001, 10000000)
        if qty <= 0:
            continue

        pid_key = product_id.lower()
        already_pushed = False
        if pushed_count_by_product.get(pid_key, 0) > 0:
            pushed_count_by_product[pid_key] -= 1
            already_pushed = True

        clean_lines.append(
            {
                "productId": product_id,
                "productName": product_name_map.get(pid_key) or str(line.get("productName") or "").strip(),
                "qty": qty,
                "lineRemarks": str(line.get("lineRemarks") or "").strip(),
                "productionPushed": already_pushed,
                "needsManualProduction": False,
            }
        )

    if not clean_lines:
        raise ValueError("Please specify at least one valid product line with quantity greater than zero.")

    pushed_count = 0
    manual_count = 0
    if status == "Order Confirmed":
        lines_to_push = [line for line in clean_lines if not line["productionPushed"]]
        if lines_to_push:
            push_result = _push_order_lines_to_production(cur, order_number, client_name, lines_to_push)
            for line in lines_to_push:
                if line["productId"].lower() in push_result["autoQueued"]:
                    line["productionPushed"] = True
                else:
                    line["needsManualProduction"] = True
            pushed_count = push_result["lotsCreated"]
            manual_count = len(lines_to_push) - pushed_count

    for line in clean_lines:
        bom_product_id = _find_bom_product_id(cur, line["productId"])
        pushed_value = "Yes" if line["productionPushed"] else ("Manual" if line["needsManualProduction"] else "")
        cur.execute(
            """
            INSERT INTO erp.client_orders_lines
                (header_id, product_id, bom_product_id, product_name, qty, line_remarks, production_pushed)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            """,
            (header_id, line["productId"], bom_product_id, line["productName"], line["qty"], line["lineRemarks"], pushed_value),
        )

    message = f'PI / Estimate "{order_number}" updated.' if is_edit else f'PI / Estimate "{order_number}" saved.'
    if pushed_count > 0:
        message += f" {pushed_count} product line(s) queued into Production."
    if manual_count > 0:
        message += (
            f" {manual_count} line(s) need manual Production setup -- log them yourself in the Production tab "
            "(BOM doesn't unambiguously map to one final-stage Process, or it's multi-color)."
        )

    # The client can patch this into an already-loaded list in place
    # instead of a full reload.
    fresh_order = {
        "orderNumber": order_number,
        "orderDate": date_utils.to_display_string(order_date) or "",
        "dateRaw": date_utils.to_iso_string(order_date) or "",
        "clientName": client_name,
        "status": status,
        "orderRemarks": order_remarks,
        "lines": clean_lines,
    }

    return build_response(True, {"orderNumber": order_number, "order": fresh_order}, message)


@rpc_method("deleteClientOrder", mutation=True)
@database.transactional
def delete_client_order(conn, cur, order_number):
    order_clean = str(order_number or "").strip()
    if not order_clean:
        raise ValueError("Order number is required.")

    if table := config_maps.TABLE_NAMES.get("DISPATCH_HEADERS"):
        cur.execute(
            f"SELECT 1 FROM {table} WHERE deleted_at IS NULL AND lower(order_number) = lower(%s) LIMIT 1",
            (order_clean,),
        )
        if cur.fetchone():
            raise ValueError(f'Cannot delete PI / Estimate "{order_clean}": it has dispatch records against it.')

    if table := config_maps.TABLE_NAMES.get("PRODUCTION"):
        cur.execute(
            f"SELECT 1 FROM {table} WHERE deleted_at IS NULL AND lower(order_number) = lower(%s) LIMIT 1",
            (order_clean,),
        )
        if cur.fetchone():
            raise ValueError(f'Cannot delete PI / Estimate "{order_clean}": it already has a Production lot queued from it.')

    cur.execute(
        "SELECT id FROM erp.client_orders_headers WHERE lower(order_number) = lower(%s) AND deleted_at IS NULL",
        (order_clean,),
    )
    row = cur.fetchone()
    if row is None:
        raise ValueError(f'PI / Estimate "{order_clean}" not found.')

    cur.execute("SELECT COUNT(*) AS n FROM erp.client_orders_lines WHERE header_id = %s", (row["id"],))
    line_count = cur.fetchone()["n"]

    cur.execute(
        "UPDATE erp.client_orders_headers SET deleted_at = NOW(), updated_by = %s WHERE id = %s",
        (get_current_user_id(), row["id"]),
    )

    return build_response(True, None, f'PI / Estimate "{order_clean}" deleted ({line_count} line(s) removed).')


@rpc_method("deleteClientOrdersBulk", mutation=True)
@database.transactional
def delete_client_orders_bulk(conn, cur, order_numbers):
    requested = [str(o or "").strip() for o in (order_numbers or []) if str(o or "").strip()]
    if not requested:
        return build_response(True, None, "No PI / Estimates selected.")

    in_use: set = set()

    if table := config_maps.TABLE_NAMES.get("DISPATCH_HEADERS"):
        cur.execute(f"SELECT DISTINCT order_number FROM {table} WHERE deleted_at IS NULL AND order_number IS NOT NULL AND order_number != ''")
        used = {str(r["order_number"]).strip().lower() for r in cur.fetchall()}
        for o in requested:
            if o.lower() in used:
                in_use.add(o)

    if table := config_maps.TABLE_NAMES.get("PRODUCTION"):
        cur.execute(f"SELECT DISTINCT order_number FROM {table} WHERE deleted_at IS NULL AND order_number IS NOT NULL AND order_number != ''")
        used = {str(r["order_number"]).strip().lower() for r in cur.fetchall()}
        for o in requested:
            if o.lower() in used:
                in_use.add(o)

    to_delete = [o for o in requested if o not in in_use]

    lines_removed = 0
    deleted_ids = []
    if to_delete:
        cur.execute(
            "SELECT id, order_number FROM erp.client_orders_headers WHERE deleted_at IS NULL AND lower(order_number) = ANY(%s)",
            ([o.lower() for o in to_delete],),
        )
        matched = cur.fetchall()
        ids = [r["id"] for r in matched]
        deleted_ids = [r["order_number"] for r in matched]
        if ids:
            cur.execute("SELECT COUNT(*) AS n FROM erp.client_orders_lines WHERE header_id = ANY(%s)", (ids,))
            lines_removed = cur.fetchone()["n"]
            cur.execute(
                "UPDATE erp.client_orders_headers SET deleted_at = NOW(), updated_by = %s WHERE id = ANY(%s)",
                (get_current_user_id(), ids),
            )

    message = f"Deleted {len(to_delete)} PI / Estimate(s) ({lines_removed} line(s) removed)."
    if in_use:
        message += (
            f" Skipped {len(in_use)} PI / Estimate(s) with dispatch records or a queued Production lot against them: "
            f"{', '.join(sorted(in_use))}."
        )

    return build_response(
        len(to_delete) > 0, {"deletedIds": deleted_ids, "skipped": sorted(in_use)}, message
    )
