"""BOM (Bill of Materials): Product Master + recipe lines + additional
costs, ported from Apps_Script/module_bom.js. Opens the Product side of
Phase 3 manufacturing, alongside Process Master's already-ported Process
side -- see migrations/erp/012_bom.sql.

BOM access gate: the source's CacheService-backed 6-hour token
(verifyBOMAccess/_requireBOMAccess) is replaced with a DB-backed
erp.bom_access_tokens table (same TTL). The SHA-256 password hash lives in
erp.app_settings (reserved for exactly this since Phase 0's migration
comment: "e.g. the BOM access password hash"). set_bom_password() is a
plain Python function, not an RPC method -- the source itself says "Not
exposed to the client UI," and this is the closest faithful adaptation
(invoke via `flask shell`, not a new CLI surface). There is no default
password anywhere in this port: the source's own ONE_TIME_setBOMPassword
has a real plaintext password hardcoded in the reference file, which is
deliberately not reproduced here.

Registering BOM_PRODUCTS/BOM_LINES this round fixes and activates four
guarded targets from earlier phases that predated this round's
header+lines split (see the "flat key" fixes to items_service.py's
_get_item_keys_in_use/_propagate_item_identity_change, process_service.py's
_get_process_ids_in_use, vendors_service.py's
_VENDOR_RENAME_SINGLE_COLUMN_TARGETS, and tags_service.py's
_rename_color_everywhere -- the same class of fix already made for
PO/Bill/Return/Wastage/Issue).

getNextProductId is a bare-string return, not the usual {success, data,
message} envelope -- same as getNextProcessId (Phase 3a). Its auth-failure
path is a genuine exception to this port's usual "raise ValueError for a
friendly error envelope" idiom: the source swallows even an auth failure
into the same hardcoded 'PRD-1001' fallback string rather than an error,
so a shape-mismatch (dict vs. bare string) never happens for this specific
method -- ported verbatim, not "fixed" to raise like everything else does.

Process rename needs no BOM-side cascade: process_group stores the Process
ID (stable), resolved to a display name live at read time via
process_service._get_all_processes -- validates preferring real FKs over
free-text snapshots. Product rename is never propagated anywhere in the
source either (confirmed: no _renameProduct*Everywhere/backfillProduct*
function exists anywhere) -- not replicated as a gap; future Production/
Client-Orders/Dispatch rounds should join to erp.bom_products by
product_id at read time instead of storing a redundant name snapshot.

Not ported: initBOMSheet/ensureBOM*Column/initBOMCostsSheet/
ensureBOMCostsExtraColumns (GAS sheet-bootstrap, no Postgres equivalent
needed -- schema is created correctly from day one via SQL migrations).
"""

from __future__ import annotations

import hashlib
import json
import math
import uuid

import psycopg2.extras

import database
from . import items_service
from . import process_service
from .current_user import get_current_user_id
from .. import config_maps
from ..envelope import build_response
from ..registry import rpc_method

_MAX_REMARKS_LENGTH = 500
_BOM_PASSWORD_SETTING_KEY = "bom_password_hash"


def _hash_bom_password(password) -> str:
    return hashlib.sha256(str(password or "").encode("utf-8")).hexdigest()


@database.transactional
def set_bom_password(conn, cur, password) -> None:
    """Sets (or changes) the BOM access password. Not reachable via the RPC
    surface -- invoke directly (e.g. `flask shell`) as a one-off admin
    action, matching the source's own "not exposed to client UI" design.
    Raises ValueError if the password is too short; no default is ever
    stored anywhere in this codebase.
    """
    password = str(password or "")
    if len(password) < 4:
        raise ValueError("Password must be at least 4 characters.")
    cur.execute(
        """
        INSERT INTO erp.app_settings (key, value, updated_at) VALUES (%s, %s, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
        """,
        (_BOM_PASSWORD_SETTING_KEY, _hash_bom_password(password)),
    )


def _require_bom_access(cur, token) -> None:
    """Raises a friendly ValueError (-> {success:false} via the RPC
    bridge's generic handler) if `token` is missing/malformed/expired.
    Validates UUID shape in Python first (mirrors app/erp/rpc.py's own
    X-Mutation-Id check) rather than letting a malformed string reach
    Postgres as a UUID-typed query parameter -- a DataError there would
    abort the enclosing transaction, breaking every later query in the
    same @database.transactional call.
    """
    token = str(token or "").strip()
    if token:
        try:
            uuid.UUID(token)
        except ValueError:
            token = ""
    valid = False
    if token:
        cur.execute("SELECT 1 FROM erp.bom_access_tokens WHERE token = %s AND expires_at > NOW()", (token,))
        valid = cur.fetchone() is not None
    if not valid:
        raise ValueError("This section is password-protected.")


def _validate_number(value, min_value: float, max_value: float) -> float:
    """Ports utils.js's validateNumber: 0 (never raises) if `value` isn't
    finite or falls outside [min_value, max_value]."""
    try:
        n = float(value)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(n) or n < min_value or n > max_value:
        return 0.0
    return n


def _parse_json_array(raw, error_message: str) -> list:
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw) if raw else []
        except ValueError:
            raise ValueError(error_message)
    else:
        parsed = raw or []
    return parsed if isinstance(parsed, list) else []


def _find_vendor_id(cur, name: str):
    if not name:
        return None
    cur.execute("SELECT id FROM erp.vendors WHERE lower(vendor_name) = lower(%s) AND deleted_at IS NULL", (name,))
    row = cur.fetchone()
    return row["id"] if row else None


def _find_process_master_id(cur, process_id_str: str):
    if not process_id_str:
        return None
    cur.execute(
        "SELECT id FROM erp.process_master WHERE lower(process_id) = lower(%s) AND deleted_at IS NULL",
        (process_id_str,),
    )
    row = cur.fetchone()
    return row["id"] if row else None


def _process_name_by_id_lower(cur) -> dict:
    return {p["processId"].strip().lower(): p["processName"] for p in process_service._get_all_processes(cur)}


def _resolve_process_group_label(process_name_by_id: dict, process_id: str) -> str:
    process_id = (process_id or "").strip()
    if not process_id:
        return "General"
    return process_name_by_id.get(process_id.lower()) or process_id


def _get_bom_final_stage_process_map(cur) -> dict:
    """productIdLower -> the single unambiguous final-stage process record
    referenced by that product's BOM lines. 0 or 2+ distinct final-stage
    matches are intentionally omitted -- ports getBOMFinalStageProcessMap
    exactly: callers (a future Client Orders -> Production auto-queue) fall
    back to a manual flow instead of guessing which process actually
    produces the finished good.
    """
    cur.execute(
        """
        SELECT bp.product_id, bl.process_group
        FROM erp.bom_lines bl
        JOIN erp.bom_products bp ON bp.id = bl.header_id
        WHERE bp.deleted_at IS NULL AND bl.process_group IS NOT NULL AND bl.process_group != ''
        """
    )
    process_ids_by_product: dict = {}
    for row in cur.fetchall():
        key = row["product_id"].strip().lower()
        process_ids_by_product.setdefault(key, set()).add(row["process_group"].strip().lower())

    final_stage_by_id = {
        p["processId"].strip().lower(): p for p in process_service._get_all_processes(cur) if p["isFinalStage"]
    }

    result = {}
    for product_key, process_id_set in process_ids_by_product.items():
        matches = [final_stage_by_id[pid] for pid in process_id_set if pid in final_stage_by_id]
        if len(matches) == 1:
            result[product_key] = matches[0]
    return result


def _get_product_ids_in_use(cur, product_ids: list) -> set:
    """Lower-cased Product IDs referenced by a Production lot, a Client
    Order, or a Dispatch record -- unsafe to delete. Guarded via
    config_maps.TABLE_NAMES exactly like process_service.
    _get_process_ids_in_use.
    """
    requested = {str(p or "").strip().lower() for p in product_ids if str(p or "").strip()}
    in_use: set = set()
    if not requested:
        return in_use

    col = config_maps.to_snake_case("productId")

    table = config_maps.TABLE_NAMES.get("PRODUCTION")
    if table:
        cur.execute(f"SELECT DISTINCT {col} AS product_id FROM {table} WHERE deleted_at IS NULL")
        for row in cur.fetchall():
            pid = str(row["product_id"] or "").strip().lower()
            if pid in requested:
                in_use.add(pid)

    # Client Orders and Dispatch are both header+lines split (product_id is
    # a line-level column) -- a join against the header for deleted_at, not
    # a flat single-table lookup.
    for lines_key, headers_key in (
        ("CLIENT_ORDERS_LINES", "CLIENT_ORDERS_HEADERS"),
        ("DISPATCH_LINES", "DISPATCH_HEADERS"),
    ):
        lines_table = config_maps.TABLE_NAMES.get(lines_key)
        headers_table = config_maps.TABLE_NAMES.get(headers_key)
        if not (lines_table and headers_table):
            continue
        cur.execute(
            f"SELECT DISTINCT l.{col} AS product_id FROM {lines_table} l "
            f"JOIN {headers_table} h ON h.id = l.header_id WHERE h.deleted_at IS NULL"
        )
        for row in cur.fetchall():
            pid = str(row["product_id"] or "").strip().lower()
            if pid in requested:
                in_use.add(pid)

    return in_use


# ─────────────────────────────────────────────────────────────────────────
# BOM access gate
# ─────────────────────────────────────────────────────────────────────────


@rpc_method("verifyBOMAccess")
@database.transactional
def verify_bom_access(conn, cur, password):
    cur.execute("SELECT value FROM erp.app_settings WHERE key = %s", (_BOM_PASSWORD_SETTING_KEY,))
    row = cur.fetchone()
    if row is None or not row["value"]:
        return build_response(False, None, "BOM password has not been configured yet.")

    if _hash_bom_password(password) != row["value"]:
        return build_response(False, None, "Incorrect password.")

    token = str(uuid.uuid4())
    cur.execute(
        "INSERT INTO erp.bom_access_tokens (token, expires_at) VALUES (%s, NOW() + INTERVAL '6 hours')",
        (token,),
    )
    return build_response(True, {"token": token}, "Access granted.")


# ─────────────────────────────────────────────────────────────────────────
# RPC methods
# ─────────────────────────────────────────────────────────────────────────


def _finalize_bom_product_costs(product: dict) -> None:
    """Aggregate a product's components into per-color costs, then derive
    totalCost/totalQty/grandTotal from the primary (first-seen) color.

    A blank-Color component row is common to every color; a non-blank one is
    an alternative exclusive to that color, not additive across colors. A
    product's headline totalCost/totalQty is the first color's total (common
    + that color's own rows) so a 3-color product isn't reported as 3x its
    real per-unit cost. Mutates ``product`` in place.
    """
    common_cost = 0.0
    common_qty = 0.0
    per_color: dict = {}
    for component in product["components"]:
        color = component["color"]
        if not color:
            common_cost += component["lineCost"]
            common_qty += component["qtyPerProduct"]
            continue
        key = color.lower()
        bucket = per_color.setdefault(key, {"cost": 0.0, "qty": 0.0})
        bucket["cost"] += component["lineCost"]
        bucket["qty"] += component["qtyPerProduct"]

    color_costs = []
    for color in product["colors"]:
        bucket = per_color.get(color.lower(), {"cost": 0.0, "qty": 0.0})
        color_costs.append(
            {
                "color": color,
                "totalCost": common_cost + bucket["cost"],
                "totalQty": common_qty + bucket["qty"],
            }
        )
    product["colorCosts"] = color_costs

    primary = color_costs[0] if color_costs else None
    product["totalCost"] = primary["totalCost"] if primary else common_cost
    product["totalQty"] = primary["totalQty"] if primary else common_qty
    product["grandTotal"] = product["totalCost"] + product["totalAdditionalCost"]


def _load_bom_list(cur, only_product_id=None) -> list:
    """Core of getBOMData: query + group + cost-finalize, optionally scoped
    to one product. Shared by get_bom_data() (full list) and save_bom()
    (only_product_id, to read back just its own freshly-written product
    for the client's in-place row-patch response).
    """
    process_name_by_id = _process_name_by_id_lower(cur)

    query = """
        SELECT bp.product_id, bp.product_name, bp.remarks, bp.sequence,
               bl.item_name, bl.size, bl.narration, bl.rate, bl.vendor,
               bl.qty_per_product, bl.process_group, bl.color
        FROM erp.bom_products bp
        JOIN erp.bom_lines bl ON bl.header_id = bp.id
        WHERE bp.deleted_at IS NULL
        """
    params: list = []
    if only_product_id is not None:
        query += " AND lower(bp.product_id) = lower(%s)"
        params.append(only_product_id)
    query += " ORDER BY bp.id, bl.id"

    cur.execute(query, params)
    rows = cur.fetchall()

    product_map: dict = {}
    colors_seen: dict = {}
    for row in rows:
        product_id = row["product_id"]
        product_name = row["product_name"]
        item_name = row["item_name"]
        if not product_id or not product_name or not item_name:
            continue

        product = product_map.get(product_id)
        if product is None:
            product = {
                "productId": product_id,
                "productName": product_name,
                "components": [],
                "colors": [],
                "totalCost": 0.0,
                "totalQty": 0.0,
                "additionalCosts": [],
                "totalAdditionalCost": 0.0,
                "remarks": row["remarks"] or "",
                "sequence": row["sequence"] or 0,
            }
            product_map[product_id] = product
            colors_seen[product_id] = set()

        rate = float(row["rate"] or 0)
        qty = float(row["qty_per_product"] or 0)
        line_cost = rate * qty
        process_id = (row["process_group"] or "").strip()
        color = (row["color"] or "").strip()

        product["components"].append(
            {
                "itemName": item_name,
                "size": row["size"] or "",
                "narration": row["narration"] or "",
                "rate": rate,
                "vendor": row["vendor"] or "",
                "qtyPerProduct": qty,
                "lineCost": line_cost,
                "processId": process_id,
                "processGroup": _resolve_process_group_label(process_name_by_id, process_id),
                "color": color,
            }
        )

        if color and color not in colors_seen[product_id]:
            colors_seen[product_id].add(color)
            product["colors"].append(color)

    if product_map:
        cost_query = """
            SELECT bp.product_id, bc.description, bc.rate, bc.process_name, bc.contractor_name
            FROM erp.bom_additional_costs bc
            JOIN erp.bom_products bp ON bp.id = bc.header_id
            WHERE bp.deleted_at IS NULL
            """
        cost_params: list = []
        if only_product_id is not None:
            cost_query += " AND lower(bp.product_id) = lower(%s)"
            cost_params.append(only_product_id)
        cost_query += " ORDER BY bc.id"

        cur.execute(cost_query, cost_params)
        for row in cur.fetchall():
            product = product_map.get(row["product_id"])
            description = row["description"]
            if product is None or not description:
                continue
            rate = float(row["rate"] or 0)
            product["additionalCosts"].append(
                {
                    "description": description,
                    "rate": rate,
                    "processName": row["process_name"] or "",
                    "contractorName": row["contractor_name"] or "",
                }
            )
            product["totalAdditionalCost"] += rate

    products = list(product_map.values())
    for p in products:
        _finalize_bom_product_costs(p)
    products.sort(key=lambda p: p["sequence"])

    return products


@rpc_method("getBOMData")
def get_bom_data(token=None):
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        _require_bom_access(cur, token)
        products = _load_bom_list(cur)
    return build_response(True, products)


@rpc_method("getBOMProductionData")
def get_bom_production_data():
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        process_name_by_id = _process_name_by_id_lower(cur)

        cur.execute(
            """
            SELECT bp.product_id, bp.product_name, bp.sequence,
                   bl.item_name, bl.size, bl.narration, bl.vendor,
                   bl.qty_per_product, bl.process_group, bl.color
            FROM erp.bom_products bp
            JOIN erp.bom_lines bl ON bl.header_id = bp.id
            WHERE bp.deleted_at IS NULL
            ORDER BY bp.id, bl.id
            """
        )
        rows = cur.fetchall()

    product_map: dict = {}
    colors_seen: dict = {}
    for row in rows:
        product_id = row["product_id"]
        product_name = row["product_name"]
        item_name = row["item_name"]
        if not product_id or not product_name or not item_name:
            continue

        product = product_map.get(product_id)
        if product is None:
            product = {
                "productId": product_id,
                "productName": product_name,
                "components": [],
                "colors": [],
                "sequence": row["sequence"] or 0,
            }
            product_map[product_id] = product
            colors_seen[product_id] = set()

        process_id = (row["process_group"] or "").strip()
        color = (row["color"] or "").strip()
        product["components"].append(
            {
                "itemName": item_name,
                "size": row["size"] or "",
                "narration": row["narration"] or "",
                "vendor": row["vendor"] or "",
                "qtyPerProduct": float(row["qty_per_product"] or 0),
                "processId": process_id,
                "processGroup": _resolve_process_group_label(process_name_by_id, process_id),
                "color": color,
            }
        )
        if color and color not in colors_seen[product_id]:
            colors_seen[product_id].add(color)
            product["colors"].append(color)

    products = list(product_map.values())
    products.sort(key=lambda p: p["sequence"])
    return build_response(True, products)


@rpc_method("getNextProductId")
def get_next_product_id(token=None):
    # Bare string return, not build_response(...) -- see module docstring.
    try:
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
            _require_bom_access(cur, token)
            cur.execute("SELECT nextval('erp.product_id_seq') AS n")
            n = cur.fetchone()["n"]
        return f"PRD-{n}"
    except ValueError:
        # Matches the source's own swallowed-auth-failure fallback exactly
        # -- see module docstring.
        return "PRD-1001"


@rpc_method("saveBOM", mutation=True)
@database.transactional
def save_bom(conn, cur, form_data, token=None):
    _require_bom_access(cur, token)

    form_data = form_data or {}

    product_name = str(form_data.get("productName") or "").strip()
    if not product_name:
        raise ValueError("Product Name is required.")

    remarks = str(form_data.get("remarks") or "").strip()[:_MAX_REMARKS_LENGTH]

    components = _parse_json_array(form_data.get("components"), "Invalid components data format.")
    if not components:
        raise ValueError("BOM must contain at least one component.")

    additional_costs = _parse_json_array(form_data.get("additionalCosts"), "Invalid additional costs data format.")

    product_id_input = str(form_data.get("productId") or "").strip()
    is_edit = bool(product_id_input)

    user_id = get_current_user_id()

    if is_edit:
        cur.execute(
            "SELECT id, sequence FROM erp.bom_products WHERE lower(product_id) = lower(%s) AND deleted_at IS NULL",
            (product_id_input,),
        )
        existing = cur.fetchone()
        if existing is None:
            raise ValueError(f'Product BOM with ID "{product_id_input}" not found.')
        header_id = existing["id"]
        sequence = existing["sequence"]
        product_id = product_id_input

        cur.execute(
            "UPDATE erp.bom_products SET product_name = %s, remarks = %s, updated_by = %s WHERE id = %s",
            (product_name, remarks, user_id, header_id),
        )
        cur.execute("DELETE FROM erp.bom_lines WHERE header_id = %s", (header_id,))
        cur.execute("DELETE FROM erp.bom_additional_costs WHERE header_id = %s", (header_id,))
    else:
        cur.execute("SELECT nextval('erp.product_id_seq') AS n")
        product_id = f"PRD-{cur.fetchone()['n']}"
        cur.execute("SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM erp.bom_products WHERE deleted_at IS NULL")
        sequence = (cur.fetchone()["max_seq"] or 0) + 1

        cur.execute(
            """
            INSERT INTO erp.bom_products (product_id, product_name, remarks, sequence, updated_by)
            VALUES (%s, %s, %s, %s, %s) RETURNING id
            """,
            (product_id, product_name, remarks, sequence, user_id),
        )
        header_id = cur.fetchone()["id"]

    rows_written = 0
    for comp in components:
        comp = comp or {}
        item_name = str(comp.get("itemName") or "").strip()
        if not item_name:
            continue
        size = str(comp.get("size") or "").strip()
        narration = str(comp.get("narration") or "").strip()
        rate = _validate_number(comp.get("rate"), 0, 10000000)
        vendor = str(comp.get("vendor") or "").strip()
        # No `|| 1` fallback here -- a real, deliberate difference from
        # Process Components' qtyPerUnit; an invalid qty becomes 0.
        qty_per_product = _validate_number(comp.get("qtyPerProduct"), 0.0001, 1000000)
        process_id_str = str(comp.get("processId") or "").strip()
        color = str(comp.get("color") or "").strip()

        vendor_id = _find_vendor_id(cur, vendor)
        process_master_id = _find_process_master_id(cur, process_id_str)
        item_id = items_service._find_item(cur, item_name, size)

        cur.execute(
            """
            INSERT INTO erp.bom_lines
                (header_id, item_name, size, narration, rate, vendor, vendor_id, qty_per_product,
                 process_group, process_master_id, color, item_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                header_id, item_name, size, narration, rate, vendor, vendor_id, qty_per_product,
                process_id_str, process_master_id, color, item_id,
            ),
        )
        rows_written += 1

    if rows_written == 0:
        raise ValueError("Please specify valid component items.")

    for cost in additional_costs:
        cost = cost or {}
        description = str(cost.get("description") or "").strip()
        if not description:
            continue
        rate = _validate_number(cost.get("rate"), 0, 10000000)
        process_name = str(cost.get("processName") or "").strip()
        contractor_name = str(cost.get("contractorName") or "").strip()
        cur.execute(
            """
            INSERT INTO erp.bom_additional_costs (header_id, description, rate, process_name, contractor_name)
            VALUES (%s, %s, %s, %s, %s)
            """,
            (header_id, description, rate, process_name, contractor_name),
        )

    message = "BOM updated successfully." if is_edit else "Product BOM saved successfully."

    # Read this product's own just-written rows back so the client can
    # patch it into an already-loaded list in place instead of a full
    # reload.
    fresh_list = _load_bom_list(cur, only_product_id=product_id)
    fresh_product = fresh_list[0] if fresh_list else None

    return build_response(True, {"productId": product_id, "productName": product_name, "product": fresh_product}, message)


@rpc_method("deleteBOM", mutation=True)
@database.transactional
def delete_bom(conn, cur, product_id, token=None):
    _require_bom_access(cur, token)

    target = str(product_id or "").strip()
    if not target:
        raise ValueError("Product ID is required.")

    if target.lower() in _get_product_ids_in_use(cur, [target]):
        raise ValueError(
            f'Cannot delete BOM: Product ID "{target}" is already referenced by Production lots, '
            "a Client Order, or Dispatch. Clear those first."
        )

    cur.execute(
        "SELECT id FROM erp.bom_products WHERE lower(product_id) = lower(%s) AND deleted_at IS NULL",
        (target,),
    )
    row = cur.fetchone()
    if row is None:
        raise ValueError(f'Product BOM with ID "{target}" not found.')

    cur.execute(
        "UPDATE erp.bom_products SET deleted_at = NOW(), updated_by = %s WHERE id = %s",
        (get_current_user_id(), row["id"]),
    )
    # bom_lines/bom_additional_costs stay physically present, made invisible
    # via the parent's deleted_at at read time -- same soft-delete
    # treatment every header+lines table in this schema gets.
    return build_response(True, None, f'BOM for Product ID "{target}" deleted successfully.')


@rpc_method("deleteBOMsBulk", mutation=True)
@database.transactional
def delete_boms_bulk(conn, cur, product_ids, token=None):
    _require_bom_access(cur, token)

    requested = [str(p or "").strip() for p in (product_ids or []) if str(p or "").strip()]
    if not requested:
        return build_response(True, None, "No BOMs selected.")

    in_use_lower = _get_product_ids_in_use(cur, requested)
    in_use = [p for p in requested if p.lower() in in_use_lower]
    deletable = [p for p in requested if p not in in_use]

    user_id = get_current_user_id()
    rows_deleted = 0
    if deletable:
        cur.execute(
            """
            UPDATE erp.bom_products SET deleted_at = NOW(), updated_by = %s
            WHERE deleted_at IS NULL AND lower(product_id) = ANY(%s)
            """,
            (user_id, [p.lower() for p in deletable]),
        )
        rows_deleted = cur.rowcount

    message = f"Deleted {len(deletable)} BOM(s) ({rows_deleted} row(s) removed)."
    if in_use:
        message += (
            f" Skipped {len(in_use)} BOM(s) still in use by Production, a Client Order, or Dispatch: "
            f"{', '.join(in_use)}."
        )

    return build_response(True, {"skipped": in_use}, message)


@rpc_method("reorderBOM", mutation=True)
@database.transactional
def reorder_bom(conn, cur, ordered_product_ids, token=None):
    _require_bom_access(cur, token)

    order = [str(p or "").strip() for p in (ordered_product_ids or []) if str(p or "").strip()]
    if not order:
        raise ValueError("No product order provided.")

    cur.execute("SELECT COUNT(*) AS n FROM erp.bom_products WHERE deleted_at IS NULL")
    if cur.fetchone()["n"] == 0:
        return build_response(True, None, "No products to reorder.")

    user_id = get_current_user_id()
    for index, product_id in enumerate(order, start=1):
        cur.execute(
            "UPDATE erp.bom_products SET sequence = %s, updated_by = %s WHERE lower(product_id) = lower(%s) AND deleted_at IS NULL",
            (index, user_id, product_id),
        )

    return build_response(True, None, f"Reordered {len(order)} product(s).")


@rpc_method("getBomProcessComponentsDrift")
def get_bom_process_components_drift():
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        cur.execute("SELECT COUNT(*) AS n FROM erp.bom_products WHERE deleted_at IS NULL")
        if cur.fetchone()["n"] == 0:
            return build_response(True, [], "No BOM data to check.")

        final_stage_map = _get_bom_final_stage_process_map(cur)

        cur.execute(
            """
            SELECT bp.product_id, bp.product_name, bl.item_name, bl.size, bl.qty_per_product
            FROM erp.bom_lines bl
            JOIN erp.bom_products bp ON bp.id = bl.header_id
            WHERE bp.deleted_at IS NULL
            ORDER BY bp.id, bl.id
            """
        )
        rows = cur.fetchall()

    by_product: dict = {}
    for row in rows:
        product_id = row["product_id"]
        key = product_id.lower()
        product = by_product.get(key)
        if product is None:
            product = {"productId": product_id, "productName": row["product_name"] or "", "rows": []}
            by_product[key] = product
        product["rows"].append(
            {
                "itemName": row["item_name"],
                "size": row["size"] or "",
                "qtyPerProduct": float(row["qty_per_product"] or 0),
            }
        )

    recipe_cache: dict = {}

    def get_recipe(process_id: str) -> dict:
        key = process_id.lower()
        if key not in recipe_cache:
            resp = process_service.get_process_components_data(process_id)
            comps = resp.get("data") or []
            recipe = {}
            for c in comps:
                if c["sourceType"] != "ITEM" or not process_service._is_common_color_group(c["colorGroup"]):
                    continue
                recipe[f'{c["itemName"].lower()}|{(c["size"] or "").lower()}'] = c["qtyPerUnit"]
            recipe_cache[key] = recipe
        return recipe_cache[key]

    drift = []
    for product in by_product.values():
        process = final_stage_map.get(product["productId"].lower())
        if not process:
            continue
        recipe = get_recipe(process["processId"])

        for row in product["rows"]:
            recipe_qty = recipe.get(f'{row["itemName"].lower()}|{row["size"].lower()}')
            if recipe_qty is None:
                continue
            if abs(recipe_qty - row["qtyPerProduct"]) > 0.0001:
                drift.append(
                    {
                        "productId": product["productId"],
                        "productName": product["productName"],
                        "itemName": row["itemName"],
                        "size": row["size"],
                        "bomQtyPerProduct": row["qtyPerProduct"],
                        "recipeQtyPerUnit": recipe_qty,
                    }
                )

    message = (
        f"{len(drift)} item(s) differ between BOM costing and the process recipe."
        if drift
        else "No drift found -- BOM and process recipe quantities match everywhere they overlap."
    )
    return build_response(True, drift, message)
