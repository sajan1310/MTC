"""Production Lot API for Universal Process Framework.

Provides REST API endpoints for production lot lifecycle: creation,
variant selection, validation, execution, and variance analysis.

[BUG FIX] Routes: prefer hyphenated URLs (`/production-lots`) as primary
endpoints. Underscored versions (`/production_lot`, `/production_lots`) are
kept for legacy compatibility. Frontend JavaScript expects hyphenated URLs
(for example: `/api/upf/production-lots`).
"""

import warnings
from functools import wraps

from flask import Blueprint, current_app, request, jsonify
from flask_login import current_user, login_required

from app import limiter
from app.services.production_service import ProductionService
from datetime import datetime
from app.validators.production_lot_validator import (
    validate_production_lot_creation
)
from app.utils.response import APIResponse

production_api_bp = Blueprint("production_api", __name__)


# Helper function to safely check user role
def get_user_role():
    """Get current user's role, returning None if not authenticated or role doesn't exist."""
    if current_user.is_authenticated and hasattr(current_user, "role"):
        return current_user.role
    return None


def is_admin():
    """Check if current user is an admin."""
    return get_user_role() == "admin"


def role_required(*roles):
    """Decorator to require specific user role."""

    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            if not current_user.is_authenticated:
                return APIResponse.error(
                    "unauthenticated", "Authentication required", 401
                )
            user_role = get_user_role()
            if user_role not in roles and user_role != "admin":
                return APIResponse.error("forbidden", "Insufficient permissions", 403)
            return f(*args, **kwargs)

        return decorated_function

    return decorator


# ===== PRODUCTION LOT CRUD =====


@production_api_bp.route("/production-lots", methods=["POST"])
@production_api_bp.route("/production_lot", methods=["POST"])  # Legacy compatibility
@login_required
@limiter.limit("50 per hour")
def create_production_lot():
    """Create a new production lot."""
    # Deprecation warning for underscore route
    if request.path == "/api/upf/production_lot":
        msg = (
            "POST /api/upf/production_lot is deprecated. Use POST /api/upf/"
            "production-lots instead. Underscore routes will be removed after "
            "November 23, 2025."
        )
        warnings.warn(msg, DeprecationWarning, stacklevel=2)
        current_app.logger.warning(f"DEPRECATION: {msg}")

    try:
        if not request.is_json:
            return APIResponse.error(
                "validation_error", "Content-Type must be application/json", 400
            )

        data = request.json or {}

        if not data.get("process_id"):
            return APIResponse.error("validation_error", "process_id is required", 400)
        if "quantity" not in data:
            return APIResponse.error("validation_error", "quantity is required", 400)

        # Validate numeric quantity
        try:
            qty_val = float(data.get("quantity"))
            if qty_val <= 0:
                return APIResponse.error(
                    "validation_error", "Quantity must be greater than 0", 400
                )
        except (TypeError, ValueError):
            return APIResponse.error(
                "validation_error", "Quantity must be a valid number", 400
            )

        # Pre-validate per plan
        user_id_safe = getattr(current_user, "id", None)
        errs = validate_production_lot_creation(
            int(data["process_id"]), int(qty_val), int(user_id_safe or 0)
        )
        if errs:
            return APIResponse.error("validation_error", errs, 400)

        # Verify process exists before creating
        from database import get_conn
        from psycopg2.extras import RealDictCursor

        with get_conn(cursor_factory=RealDictCursor) as (conn, cur):
            cur.execute("SELECT 1 FROM processes WHERE id = %s LIMIT 1", (data.get("process_id"),))
            if not cur.fetchone():
                return APIResponse.error(
                    "validation_error", f"Invalid process_id: {data.get('process_id')}", 400
                )

        # Enhanced creation with alerts
        lot = ProductionService.create_production_lot_with_alerts(
            process_id=int(data["process_id"]),
            quantity=int(qty_val),
            user_id=int(current_user.id),
            description=data.get("notes"),
        )

        current_app.logger.info(
            f"Production lot created: {lot['lot_number']} by user {current_user.id}"
        )
        return APIResponse.created(lot, "Production lot created")
    except Exception as e:
        current_app.logger.error(f"Error creating production lot: {e}")
        return APIResponse.error("internal_error", str(e), 500)


# Plan: manual inventory validate endpoint
@production_api_bp.route(
    "/production-lots/<int:lot_id>/validate-inventory", methods=["POST"]
)
@login_required
def validate_inventory(lot_id: int):
    try:
        from app.services.inventory_alert_service import InventoryAlertService

        alerts = InventoryAlertService.check_inventory_levels_for_production_lot(lot_id)
        created = InventoryAlertService.create_production_lot_alerts(lot_id, alerts)
        summary = InventoryAlertService.get_production_lot_alert_summary(lot_id)
        return APIResponse.success(
            {
                "lot_id": lot_id,
                "validation_timestamp": datetime.utcnow().isoformat(),
                "alerts_updated": len(created) > 0,
                "new_alerts_count": len(created),
                "alerts_cleared_count": 0,  # simplified
                "current_status": summary.get("lot_status"),
            }
        )
    except Exception as e:
        current_app.logger.error(f"Error validating inventory for lot {lot_id}: {e}")
        return APIResponse.error("internal_error", "Validation failed", 500)


@production_api_bp.route(
    "/production-lots/<int:lot_id>/acknowledge-all-alerts", methods=["POST"]
)
@login_required
def acknowledge_all_alerts(lot_id: int):
    try:
        from app.services.production_service import ProductionService
        from app.services.inventory_alert_service import InventoryAlertService

        # Fetch unacknowledged alerts and mark based on global action
        data = request.json or {}
        global_action = data.get("global_action", "PROCEED_ALL")
        action = "PROCEED" if global_action == "PROCEED_ALL" else "DELAY"
        # Build ack list
        alerts = InventoryAlertService.list_alerts(production_lot_id=lot_id)
        acks = [
            {
                "alert_id": a["alert_id"],
                "user_action": action,
                "action_notes": data.get("notes"),
            }
            for a in alerts
            if not a.get("user_acknowledged")
        ]
        result = ProductionService.acknowledge_and_validate_production_lot_alerts(
            production_lot_id=lot_id, user_id=current_user.id, acknowledgments=acks
        )
        if result.get("error"):
            return APIResponse.error("validation_error", result.get("details"), 400)
        return APIResponse.success(
            {
                "lot_id": lot_id,
                "acknowledged_count": len(acks),
                "updated_lot_status": result.get("lot_status"),
            }
        )
    except Exception as e:
        current_app.logger.error(
            f"Error bulk-acknowledging alerts for lot {lot_id}: {e}"
        )
        return APIResponse.error("internal_error", "Bulk acknowledge failed", 500)


@production_api_bp.route("/production-lots/<int:lot_id>", methods=["GET"])
@production_api_bp.route(
    "/production_lot/<int:lot_id>", methods=["GET"]
)  # Legacy compatibility
@login_required
def get_production_lot_data(lot_id):
    """Get production lot by ID."""
    # Import at function level to avoid circular dependency
    from flask import current_app

    # Deprecation warning for underscore route
    if "production_lot" in request.path and "production-lots" not in request.path:
        msg = (
            f"GET /api/upf/production_lot/{lot_id} is deprecated. Use GET /api/upf/"
            f"production-lots/{lot_id} instead. Underscore routes will be removed "
            "after November 23, 2025."
        )
        warnings.warn(msg, DeprecationWarning, stacklevel=2)
        current_app.logger.warning(f"DEPRECATION: {msg}")

    try:
        lot = ProductionService.get_production_lot(lot_id)
        if not lot:
            return APIResponse.not_found("Production lot", lot_id)

        # Check access - skip in test mode with LOGIN_DISABLED
        if not current_app.config.get("LOGIN_DISABLED", False):
            # Only enforce access control in production
            if (
                lot.get("created_by") != getattr(current_user, "id", None)
                and not is_admin()
            ):
                return APIResponse.error("forbidden", "Access denied", 403)

        # Ensure frontend-friendly username fields exist (some clients expect created_by_username)
        # ProductionService currently returns `created_by_name` where available; create aliases.
        try:
            if isinstance(lot, dict):
                if "created_by_name" in lot and "created_by_username" not in lot:
                    lot["created_by_username"] = lot.get("created_by_name")
                # also map created_by to a consistent key if present
                if "created_by" in lot and "created_by_id" not in lot:
                    lot["created_by_id"] = lot.get("created_by")
        except Exception:
            # non-fatal; continue returning the lot as-is
            pass

        return APIResponse.success(lot)
    except Exception as e:
        current_app.logger.error(f"Error retrieving production lot: {e}")
        return APIResponse.error("internal_error", str(e), 500)


@production_api_bp.route(
    "/production-lots/<int:lot_id>/variant_options", methods=["GET"]
)
@production_api_bp.route(
    "/production_lot/<int:lot_id>/variant_options", methods=["GET"]
)
@login_required
def get_variant_options(lot_id):
    """Get variant selection options for production lot."""
    try:
        from database import get_conn
        from psycopg2.extras import RealDictCursor

        # Check access
        lot = ProductionService.get_production_lot(lot_id)
        if not lot:
            return APIResponse.not_found("Production lot", lot_id)

        # Allow any authenticated user to view variant options (read-only).
        # Previously this endpoint was restricted to the creator/admin which
        # prevented other users from seeing subprocess/variant information in
        # the production lot detail page. Keep modifications restricted elsewhere.
        try:
            if not current_user.is_authenticated:
                return APIResponse.error(
                    "unauthenticated", "Authentication required", 401
                )
        except Exception:
            # Fallback: if current_user isn't available, deny access
            return APIResponse.error("forbidden", "Access denied", 403)

        with get_conn(cursor_factory=RealDictCursor) as (conn, cur):

            # Helper to check whether a given column exists on a table in current schema
            def _column_exists(table: str, column: str) -> bool:
                cur.execute(
                    """
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = current_schema() AND table_name = %s AND column_name = %s
                    """,
                    (table, column),
                )
                return bool(cur.fetchone())

            ps_has_deleted = _column_exists("process_subprocesses", "deleted_at")
            s_has_deleted = _column_exists("subprocesses", "deleted_at")
            vu_has_deleted = _column_exists("variant_usage", "deleted_at")

            # Build process_subprocesses + subprocesses query conditionally including deleted_at filters
            base_subprocess_q = """
                SELECT
                    ps.id as process_subprocess_id,
                    ps.id as sequence_order,
                    s.id as subprocess_id,
                    s.name as subprocess_name,
                    ps.custom_name
                FROM process_subprocesses ps
                JOIN subprocesses s ON s.id = ps.subprocess_id
                WHERE ps.process_id = %s
                """

            if ps_has_deleted:
                base_subprocess_q += "\n  AND ps.deleted_at IS NULL"
            if s_has_deleted:
                base_subprocess_q += "\n  AND s.deleted_at IS NULL"

            base_subprocess_q += "\nORDER BY ps.id"

            cur.execute(base_subprocess_q, (lot["process_id"],))

            # Normalize rows to dict to avoid tuple-vs-dict cursor inconsistencies
            subprocesses = [dict(r) for r in cur.fetchall()]

            result = []

            # Batch fetch: collect subprocess ids and fetch related data in bulk
            subprocess_ids = [sp["process_subprocess_id"] for sp in subprocesses]
            variants_by_subprocess = {}
            or_groups_by_subprocess = {}
            cost_items_by_subprocess = {}

            if subprocess_ids:
                placeholders = ",".join(["%s"] * len(subprocess_ids))

                # Fetch all variants for these subprocesses
                base_variants_q = f"""
                    SELECT
                        vu.id as usage_id,
                        vu.variant_id,
                        vu.quantity,
                        iv.unit,
                        vu.substitute_group_id,
                        vu.is_alternative,
                        vu.alternative_order,
                        im.name as item_number,
                        im.description,
                        iv.opening_stock,
                        COALESCE((
                            SELECT rate
                            FROM supplier_item_rates sir
                            WHERE sir.item_id = iv.item_id
                            ORDER BY rate ASC
                            LIMIT 1
                        ), 0) as unit_price,
                        iv.item_id,
                        -- Enrich with item/variant attributes to let frontend build concatenated details and color/size/model columns
                        COALESCE(mm.model_name, '') as model_name,
                        COALESCE(vm.variation_name, '') as variation_name,
                        COALESCE(cm.color_name, '') as color_name,
                        COALESCE(sm.size_name, '') as size_name
                    FROM variant_usage vu
                    JOIN item_variant iv ON iv.variant_id = vu.variant_id
                    LEFT JOIN item_master im ON im.item_id = iv.item_id
                    LEFT JOIN model_master mm ON im.model_id = mm.model_id
                    LEFT JOIN variation_master vm ON im.variation_id = vm.variation_id
                    LEFT JOIN color_master cm ON iv.color_id = cm.color_id
                    LEFT JOIN size_master sm ON iv.size_id = sm.size_id
                    WHERE vu.process_subprocess_id IN ({placeholders})
                    """

                if vu_has_deleted:
                    base_variants_q += "\n  AND vu.deleted_at IS NULL"

                base_variants_q += (
                    "\nORDER BY vu.substitute_group_id NULLS FIRST, "
                    "vu.alternative_order NULLS LAST"
                )

                cur.execute(base_variants_q, tuple(subprocess_ids))
                all_variants = [dict(r) for r in cur.fetchall()]

                # Fetch OR groups in one query
                cur.execute(
                    f"SELECT DISTINCT og.id as group_id, og.name as group_name, og.description, og.process_subprocess_id FROM or_groups og WHERE og.process_subprocess_id IN ({placeholders}) ORDER BY og.id",
                    tuple(subprocess_ids),
                )
                all_or_groups = [dict(g) for g in cur.fetchall()]

                # Fetch cost items in one query; ensure deleted check
                try:
                    cur.execute(
                        f"SELECT ci.*, ci.process_subprocess_id FROM cost_items ci WHERE ci.process_subprocess_id IN ({placeholders}) AND ci.deleted_at IS NULL ORDER BY ci.id",
                        tuple(subprocess_ids),
                    )
                    all_cost_items = [dict(ci) for ci in cur.fetchall()]
                except Exception:
                    current_app.logger.exception("Error fetching cost_items for subprocesses")
                    all_cost_items = []

                # Organize fetched data by subprocess id
                variants_by_subprocess = {}
                for v in all_variants:
                    psid = v.get("process_subprocess_id")
                    variants_by_subprocess.setdefault(psid, []).append(v)

                or_groups_by_subprocess = {}
                for g in all_or_groups:
                    psid = g.get("process_subprocess_id")
                    or_groups_by_subprocess.setdefault(psid, []).append(g)

                cost_items_by_subprocess = {}
                for ci in all_cost_items:
                    psid = ci.get("process_subprocess_id")
                    cost_items_by_subprocess.setdefault(psid, []).append(ci)

            # assemble result per subprocess
            for sp in subprocesses:
                spid = sp["process_subprocess_id"]
                variants = variants_by_subprocess.get(spid, [])
                or_groups = or_groups_by_subprocess.get(spid, [])
                cost_items = cost_items_by_subprocess.get(spid, [])

                grouped_variants = {}
                standalone_variants = []

                for v in variants:
                    variant_data = dict(v)
                    gid = variant_data.get("substitute_group_id")
                    if gid is not None:
                        grouped_variants.setdefault(gid, []).append(variant_data)
                    else:
                        standalone_variants.append(variant_data)

                result.append(
                    {
                        "process_subprocess_id": sp["process_subprocess_id"],
                        "subprocess_id": sp["subprocess_id"],
                        "subprocess_name": sp["custom_name"] or sp["subprocess_name"],
                        "sequence_order": sp["sequence_order"],
                        "or_groups": [dict(g) for g in or_groups],
                        "grouped_variants": grouped_variants,
                        "standalone_variants": standalone_variants,
                        "cost_items": [dict(ci) for ci in (cost_items or [])],
                    }
                )

            return APIResponse.success(
                {
                    "lot_id": lot_id,
                    "lot_number": lot["lot_number"],
                    "process_name": lot["process_name"],
                    "quantity": lot["quantity"],
                    "subprocesses": result,
                }
            )

    except Exception as e:
        current_app.logger.error(f"Error getting variant options: {e}")
        return APIResponse.error("internal_error", str(e), 500)


# Compatibility: allow fetching variant options by subprocess id directly
@production_api_bp.route(
    "/subprocess/<int:subprocess_id>/variant-options", methods=["GET"]
)
@production_api_bp.route(
    "/subprocesses/<int:subprocess_id>/variant_options", methods=["GET"]
)  # alternate style
@login_required
def get_variant_options_by_subprocess(subprocess_id: int):
    """Return variant options scoped to a single process_subprocess id.

    This provides compatibility for frontend code that queries by subprocess id.
    Response format mirrors `get_variant_options` but `subprocesses` will contain a single item.
    """
    try:
        from database import get_conn
        from psycopg2.extras import RealDictCursor

        with get_conn(cursor_factory=RealDictCursor) as (conn, cur):

            # Fetch the process_subprocess and its process_id
            cur.execute(
                """
                SELECT
                    ps.id as process_subprocess_id,
                    ps.process_id,
                    s.name as subprocess_name,
                    ps.custom_name
                FROM process_subprocesses ps
                JOIN subprocesses s ON s.id = ps.subprocess_id
                WHERE ps.id = %s
                """,
                (subprocess_id,),
            )
            sp_row = cur.fetchone()
            sp = dict(sp_row) if sp_row else None
            if not sp:
                return APIResponse.not_found("Process subprocess", subprocess_id)

            # Reuse logic similar to get_variant_options to fetch variants and groups for this subprocess
            cur.execute(
                """
                SELECT
                    vu.id as usage_id,
                    vu.variant_id,
                    vu.quantity,
                    iv.unit,
                    vu.substitute_group_id,
                    vu.is_alternative,
                    vu.alternative_order,
                    im.name as item_number,
                    im.description,
                    iv.opening_stock,
                    COALESCE((
                        SELECT rate FROM supplier_item_rates sir WHERE sir.item_id = iv.item_id ORDER BY rate ASC LIMIT 1
                    ), 0) as unit_price,
                    iv.item_id,
                    COALESCE(mm.model_name, '') as model_name,
                    COALESCE(vm.variation_name, '') as variation_name,
                    COALESCE(cm.color_name, '') as color_name,
                    COALESCE(sm.size_name, '') as size_name
                FROM variant_usage vu
                JOIN item_variant iv ON iv.variant_id = vu.variant_id
                LEFT JOIN item_master im ON im.item_id = iv.item_id
                LEFT JOIN model_master mm ON im.model_id = mm.model_id
                LEFT JOIN variation_master vm ON im.variation_id = vm.variation_id
                LEFT JOIN color_master cm ON iv.color_id = cm.color_id
                LEFT JOIN size_master sm ON iv.size_id = sm.size_id
                WHERE vu.process_subprocess_id = %s
                """,
                (subprocess_id,),
            )
            variants = [dict(r) for r in cur.fetchall()]

            cur.execute(
                """
                SELECT DISTINCT
                    og.id as group_id,
                    og.name as group_name,
                    og.description
                FROM or_groups og
                WHERE og.process_subprocess_id = %s
                ORDER BY og.id
                """,
                (subprocess_id,),
            )
            or_groups = [dict(g) for g in cur.fetchall()]

            # cost items
            try:
                cur.execute(
                    (
                        "SELECT ci.* FROM cost_items ci WHERE "
                        "ci.process_subprocess_id = %s AND ci.deleted_at IS NULL ORDER BY ci.id"
                    ),
                    (subprocess_id,),
                )
                cost_items = [dict(ci) for ci in cur.fetchall()]
            except Exception:
                cost_items = []

            grouped_variants = {}
            standalone_variants = []
            for v in variants:
                variant_data = dict(v)
                gid = variant_data.get("substitute_group_id")
                if gid is not None:
                    grouped_variants.setdefault(gid, []).append(variant_data)
                else:
                    standalone_variants.append(variant_data)

            result = [
                {
                    "process_subprocess_id": sp["process_subprocess_id"],
                    "subprocess_id": None,
                    "subprocess_name": (
                        sp.get("custom_name") or sp.get("subprocess_name")
                    ),
                    "sequence_order": sp.get("process_subprocess_id"),
                    "or_groups": [dict(g) for g in or_groups],
                    "grouped_variants": grouped_variants,
                    "standalone_variants": standalone_variants,
                    "cost_items": [dict(ci) for ci in (cost_items or [])],
                }
            ]

            return APIResponse.success(
                {
                    "lot_id": None,
                    "lot_number": None,
                    "process_name": None,
                    "quantity": None,
                    "subprocesses": result,
                }
            )
    except Exception as e:
        current_app.logger.error(f"Error getting variant options by subprocess: {e}")
        return APIResponse.error("internal_error", str(e), 500)


@production_api_bp.route("/production-lots/<int:lot_id>/recalculate", methods=["GET"])
@production_api_bp.route(
    "/production_lot/<int:lot_id>/recalculate", methods=["GET"]
)  # Legacy compatibility
@login_required
def recalculate_lot(lot_id: int):
    """Recalculate estimated and actual costs for a production lot.

    Returns a JSON object with consistent keys:
      - total_cost: (estimated total cost) - primary key frontend looks for
      - estimated_total: alias for total_cost
      - actual_cost: actual cost (if calculated)
      - data: { total_cost, actual_cost } (for callers expecting nested data)
    """
    try:
        lot = ProductionService.get_production_lot(lot_id)
        if not lot:
            return APIResponse.not_found("Production lot", lot_id)

        # Estimated cost: use costing service to compute worst-case estimate for process
        from app.services.costing_service import CostingService

        process_id = lot.get("process_id")
        qty = int(lot.get("quantity") or 1)
        estimated = 0
        try:
            estimate_breakdown = CostingService.calculate_process_total_cost(process_id)
            # Some implementations return nested totals.grand_total
            estimated = float(
                (estimate_breakdown.get("totals") or {}).get("grand_total", 0)
            )
        except Exception:
            # Fallback: use lot.total_cost or worst_case_estimated_cost
            estimated = float(
                lot.get("worst_case_estimated_cost") or lot.get("total_cost") or 0
            )

        estimated_total = estimated * qty

        # Actual cost: may be costly to compute; attempt but tolerate failures
        actual_total = None
        try:
            actual_total = float(
                ProductionService.calculate_lot_actual_cost(lot_id) or 0
            )
        except Exception:
            actual_total = None

        payload = {
            "total_cost": estimated_total,
            "estimated_total": estimated_total,
            "actual_cost": actual_total,
            "data": {"total_cost": estimated_total, "actual_cost": actual_total},
        }
        return APIResponse.success(payload)
    except Exception as e:
        current_app.logger.error(f"Error recalculating lot costs for {lot_id}: {e}")
        return APIResponse.error("internal_error", str(e), 500)


@production_api_bp.route("/production-lots", methods=["GET"])
@production_api_bp.route("/production_lots", methods=["GET"])  # Legacy compatibility
@login_required
def list_production_lots():
    """List production lots with pagination."""
    # Deprecation warning for underscore route
    if request.path == "/api/upf/production_lots":
        msg = (
            "GET /api/upf/production_lots is deprecated. Use GET /api/upf/production-lots instead. "
            "Underscore routes will be removed after November 23, 2025."
        )
        warnings.warn(msg, DeprecationWarning, stacklevel=2)
        current_app.logger.warning(f"DEPRECATION: {msg}")

    try:
        page = int(request.args.get("page", 1))
        per_page = min(int(request.args.get("per_page", 25)), 100)
        status = request.args.get("status")
        process_id = request.args.get("process_id")

        # Determine user_id filter based on authentication and admin status
        user_id = None
        if current_user.is_authenticated and not is_admin():
            user_id = current_user.id

        result = ProductionService.list_production_lots(
            user_id=user_id,
            status=status,
            process_id=int(process_id) if process_id else None,
            page=page,
            per_page=per_page,
        )

        return APIResponse.success(result)
    except Exception as e:
        current_app.logger.error(f"Error listing production lots: {e}")
        return APIResponse.error("internal_error", str(e), 500)


# ===== VARIANT SELECTION (OR FEATURE) =====


@production_api_bp.route(
    "/production-lots/<int:lot_id>/select-variant", methods=["POST"]
)
@production_api_bp.route(
    "/production_lot/<int:lot_id>/select_variant", methods=["POST"]
)  # Legacy compatibility
@login_required
def select_variant_for_group(lot_id):
    """Select variant from substitute group (OR feature)."""
    # Deprecation warning for underscore route
    if "select_variant" in request.path:
        msg = (
            f"POST /api/upf/production_lot/{lot_id}/select_variant is deprecated. "
            f"Use POST /api/upf/production-lots/{lot_id}/select-variant instead. "
            "Underscore routes will be removed after November 23, 2025."
        )
        warnings.warn(msg, DeprecationWarning, stacklevel=2)
        current_app.logger.warning(f"DEPRECATION: {msg}")

    try:
        if not request.is_json:
            return APIResponse.error(
                "validation_error", "Content-Type must be application/json", 400
            )
        data = request.json or {}
        # Check access
        lot = ProductionService.get_production_lot(lot_id)
        if not lot:
            return APIResponse.not_found("Production lot", lot_id)

        if lot["created_by"] != getattr(current_user, "id", None) and not is_admin():
            return APIResponse.error("forbidden", "Access denied", 403)

        if lot["status"] != "planning":
            return APIResponse.error(
                "validation_error", "Lot must be in planning status", 400
            )

        # numeric validation for quantity if provided
        if "quantity" in data:
            try:
                qty = float(data["quantity"])
                if qty <= 0:
                    return APIResponse.error(
                        "validation_error", "Quantity must be greater than 0", 400
                    )
            except (TypeError, ValueError):
                return APIResponse.error(
                    "validation_error", "Quantity must be a valid number", 400
                )

        # allow either substitute_group_id (or_group) OR process_subprocess_id to be provided
        if not data.get("substitute_group_id") and not data.get(
            "process_subprocess_id"
        ):
            return APIResponse.error(
                "validation_error",
                "Either substitute_group_id or process_subprocess_id is required",
                400,
            )
        if not data.get("selected_variant_id"):
            return APIResponse.error(
                "validation_error", "selected_variant_id is required", 400
            )

        # Validate foreign keys exist before delegating to service
        from database import get_conn
        from psycopg2.extras import RealDictCursor

        sel_variant_id = data.get("selected_variant_id")
        substitute_group_id = data.get("substitute_group_id")
        process_subprocess_id = data.get("process_subprocess_id")

        with get_conn(cursor_factory=RealDictCursor) as (conn, cur):
            if sel_variant_id:
                cur.execute(
                    "SELECT 1 FROM variant_usage WHERE id = %s LIMIT 1", (sel_variant_id,)
                )
                if not cur.fetchone():
                    return APIResponse.error(
                        "validation_error",
                        f"Invalid selected_variant_id: {sel_variant_id}",
                        400,
                    )

            if substitute_group_id is not None:
                cur.execute(
                    "SELECT 1 FROM or_groups WHERE id = %s LIMIT 1",
                    (substitute_group_id,),
                )
                if not cur.fetchone():
                    return APIResponse.error(
                        "validation_error",
                        f"Invalid substitute_group_id: {substitute_group_id}",
                        400,
                    )

            if process_subprocess_id is not None:
                cur.execute(
                    "SELECT 1 FROM process_subprocesses WHERE id = %s LIMIT 1",
                    (process_subprocess_id,),
                )
                if not cur.fetchone():
                    return APIResponse.error(
                        "validation_error",
                        f"Invalid process_subprocess_id: {process_subprocess_id}",
                        400,
                    )

        selection = ProductionService.select_variant_for_group(
            lot_id=lot_id,
            substitute_group_id=substitute_group_id,
            variant_id=sel_variant_id,
            supplier_id=data.get("selected_supplier_id"),
            quantity=data.get("quantity"),
            process_subprocess_id=process_subprocess_id,
        )

        current_app.logger.info(
            f"Variant selected for lot {lot_id}, group {data['substitute_group_id']}"
        )
        return APIResponse.created(selection, "Variant selected")
    except Exception as e:
        current_app.logger.error(f"Error selecting variant: {e}")
        return APIResponse.error("internal_error", str(e), 500)


@production_api_bp.route("/production-lots/<int:lot_id>/selections", methods=["GET"])
@production_api_bp.route(
    "/production_lot/<int:lot_id>/selections", methods=["GET"]
)  # Legacy compatibility
@login_required
def get_lot_selections(lot_id):
    """Get all variant selections for a lot."""
    # Deprecation warning for underscore route
    if "production_lot" in request.path and "production-lots" not in request.path:
        msg = (
            f"GET /api/upf/production_lot/{lot_id}/selections is deprecated. "
            f"Use GET /api/upf/production-lots/{lot_id}/selections instead. "
            "Underscore routes will be removed after November 23, 2025."
        )
        warnings.warn(msg, DeprecationWarning, stacklevel=2)
        current_app.logger.warning(f"DEPRECATION: {msg}")

    try:
        # Check access
        lot = ProductionService.get_production_lot(lot_id)
        if not lot:
            return APIResponse.not_found("Production lot", lot_id)

        if lot["created_by"] != getattr(current_user, "id", None) and not is_admin():
            return APIResponse.error("forbidden", "Access denied", 403)

        return APIResponse.success(lot.get("selections", []))

    except Exception as e:
        current_app.logger.error(f"Error getting selections: {e}")
        return APIResponse.error("internal_error", str(e), 500)


@production_api_bp.route(
    "/production-lots/<int:lot_id>/batch_select_variants", methods=["POST"]
)
@production_api_bp.route(
    "/production_lot/<int:lot_id>/batch_select_variants", methods=["POST"]
)
@login_required
def batch_select_variants(lot_id):
    """Save multiple variant selections at once."""
    try:
        if not request.is_json:
            return APIResponse.error(
                "validation_error", "Content-Type must be application/json", 400
            )

        from database import get_conn

        from app.services.audit_service import audit

        # Check access
        lot = ProductionService.get_production_lot(lot_id)
        if not lot:
            return APIResponse.not_found("Production lot", lot_id)

        if lot["created_by"] != getattr(current_user, "id", None) and not is_admin():
            return APIResponse.error("forbidden", "Access denied", 403)

        if lot["status"] not in ["planning", "ready"]:
            return APIResponse.error(
                "validation_error", "Lot must be in planning or ready status", 400
            )

        data = request.json or {}
        selections = data.get("selections", [])

        if not selections:
            return APIResponse.error("validation_error", "No selections provided", 400)

        # Validate all selections BEFORE any DB modification
        validated = []
        with get_conn(cursor_factory=None) as (conn, cur):
            try:
                for sel in selections:
                    variant_usage_id = sel.get("variant_usage_id") or sel.get(
                        "selected_variant_id"
                    )
                    or_group_id = sel.get("or_group_id")

                    if not variant_usage_id:
                        raise ValueError(f"Missing variant_usage_id in selection: {sel}")
                    if or_group_id is None:
                        raise ValueError(f"Missing or_group_id in selection: {sel}")

                    # Verify variant_usage exists
                    cur.execute(
                        "SELECT 1 FROM variant_usage WHERE id = %s LIMIT 1",
                        (variant_usage_id,),
                    )
                    if not cur.fetchone():
                        raise ValueError(f"Invalid variant_usage_id: {variant_usage_id}")

                    # Verify or_group exists
                    cur.execute("SELECT 1 FROM or_groups WHERE id = %s LIMIT 1", (or_group_id,))
                    if not cur.fetchone():
                        raise ValueError(f"Invalid or_group_id: {or_group_id}")

                    # validated tuple matches insert order
                    validated.append(
                        (
                            lot_id,
                            or_group_id,
                            variant_usage_id,
                            sel.get("quantity_override"),
                            sel.get("reason"),
                            current_user.id,
                        )
                    )

                # All validations passed; perform delete + batch inserts
                try:
                    cur.execute(
                        "DELETE FROM production_lot_variant_selections WHERE lot_id = %s",
                        (lot_id,),
                    )

                    insert_q = (
                        "INSERT INTO production_lot_variant_selections (lot_id, or_group_id, variant_usage_id, quantity_override, reason, created_by) VALUES (%s, %s, %s, %s, %s, %s)"
                    )
                    for params in validated:
                        cur.execute(insert_q, params)

                    conn.commit()
                except Exception:
                    try:
                        conn.rollback()
                    except Exception:
                        pass
                    raise
            except Exception:
                # Convert validation/database errors to structured response
                try:
                    conn.rollback()
                except Exception:
                    pass
                raise

        # Audit log
        try:
            audit.log_action(
                action="UPDATE",
                resource_type="production_lot",
                resource_id=lot_id,
                resource_name=lot.get("lot_number"),
                changes={"selections": selections},
                user_id=getattr(current_user, "id", None),
                timestamp=datetime.utcnow(),
                metadata={"selection_count": len(selections)},
            )
        except Exception:
            current_app.logger.exception("Failed to write audit log for batch_select_variants")

        current_app.logger.info(
            f"Saved {len(selections)} variant selections for lot {lot_id}"
        )
        return APIResponse.success(
            {"success": True, "selections_saved": len(selections)}, "Selections saved"
        )
    except Exception as e:
        current_app.logger.error(f"Error saving variant selections: {e}")
        return APIResponse.error("internal_error", str(e), 500)


# ===== LOT VALIDATION & EXECUTION =====


@production_api_bp.route("/production-lots/<int:lot_id>/validate", methods=["POST"])
@production_api_bp.route(
    "/production_lot/<int:lot_id>/validate", methods=["POST"]
)  # Legacy compatibility
@login_required
def validate_lot_readiness(lot_id):
    """Validate lot readiness (all OR groups selected, stock available)."""
    # Deprecation warning for underscore route
    if "production_lot" in request.path and "production-lots" not in request.path:
        msg = (
            f"POST /api/upf/production_lot/{lot_id}/validate is deprecated. "
            f"Use POST /api/upf/production-lots/{lot_id}/validate instead. "
            "Underscore routes will be removed after November 23, 2025."
        )
        warnings.warn(msg, DeprecationWarning, stacklevel=2)
        current_app.logger.warning(f"DEPRECATION: {msg}")

    try:
        # Check access
        lot = ProductionService.get_production_lot(lot_id)
        if not lot:
            return APIResponse.not_found("Production lot", lot_id)

        if lot["created_by"] != getattr(current_user, "id", None) and not is_admin():
            return APIResponse.error("forbidden", "Access denied", 403)

        validation_result = ProductionService.validate_lot_readiness(lot_id)

        return APIResponse.success(validation_result)
    except Exception as e:
        current_app.logger.error(f"Error validating lot: {e}")
        return APIResponse.error("internal_error", str(e), 500)


@production_api_bp.route("/production-lots/<int:lot_id>/execute", methods=["POST"])
@production_api_bp.route(
    "/production_lot/<int:lot_id>/execute", methods=["POST"]
)  # Legacy compatibility
@login_required
@role_required("admin", "inventory_manager", "production_manager")
def execute_production_lot(lot_id):
    """Execute production lot (deduct inventory, track actual costs)."""
    # Deprecation warning for underscore route
    if "production_lot" in request.path and "production-lots" not in request.path:
        msg = (
            f"POST /api/upf/production_lot/{lot_id}/execute is deprecated. "
            f"Use POST /api/upf/production-lots/{lot_id}/execute instead. "
            "Underscore routes will be removed after November 23, 2025."
        )
        warnings.warn(msg, DeprecationWarning, stacklevel=2)
        current_app.logger.warning(f"DEPRECATION: {msg}")

    try:
        # Check access
        lot = ProductionService.get_production_lot(lot_id)
        if not lot:
            return APIResponse.not_found("Production lot", lot_id)

        if lot["created_by"] != current_user.id and not is_admin():
            return APIResponse.error("forbidden", "Access denied", 403)

        if lot["status"] != "planning":
            return APIResponse.error(
                "validation_error", "Lot must be in planning status", 400
            )

        # Validate before execution
        validation = ProductionService.validate_lot_readiness(lot_id)
        if not validation["is_ready"]:
            return APIResponse.error(
                "validation_error", "Lot is not ready for execution", 400
            )

        # Execute
        executed_lot = ProductionService.execute_production_lot(lot_id)

        safe_uid = getattr(current_user, "id", "anon")
        current_app.logger.info(
            f"Production lot executed: {executed_lot['lot_number']} by user {safe_uid}"
        )

        # Audit
        try:
            from app.services.audit_service import audit

            audit.log_action(
                action="EXECUTE",
                resource_type="production_lot",
                resource_id=lot_id,
                resource_name=executed_lot.get("lot_number"),
                changes={"status": executed_lot.get("status")},
                user_id=getattr(current_user, "id", None),
                timestamp=datetime.utcnow(),
            )
        except Exception:
            current_app.logger.exception("Failed to write audit log for execute_production_lot")

        return APIResponse.success(executed_lot, "Production lot executed")
    except Exception as e:
        current_app.logger.error(f"Error executing production lot: {e}")
        return APIResponse.error("internal_error", str(e), 500)


@production_api_bp.route("/production-lots/<int:lot_id>/finalize", methods=["POST", "PUT"])  # accept PUT for backward compatibility
@production_api_bp.route("/production_lot/<int:lot_id>/finalize", methods=["POST", "PUT"])  # Legacy underscore route
@login_required
def finalize_production_lot(lot_id: int):
    """Finalize lot if no CRITICAL alerts remain unacknowledged."""
    try:
        # Pre-check using alert summary to confirm CRITICAL recognition
        try:
            from app.services.inventory_alert_service import InventoryAlertService

            summary = InventoryAlertService.get_production_lot_alert_summary(lot_id)
            crit = (summary.get("alerts_by_severity") or {}).get("CRITICAL", 0)
            if crit and crit > 0:
                msg = "Critical inventory alerts pending. Please acknowledge before finalizing."
                return (
                    jsonify(
                        {
                            "success": False,
                            "data": None,
                            "error": {"code": "conflict", "message": msg},
                            "message": msg,
                        }
                    ),
                    409,
                )
        except Exception:
            # If pre-check fails, proceed to service which will also validate
            pass
        try:
            uid = getattr(current_user, "id", None)
            result = ProductionService.finalize_production_lot(
                lot_id, uid if uid is not None else 0
            )
        except ValueError as ve:
            # Provide structured conflict error consistent with tests
            msg = str(ve)
            return (
                jsonify(
                    {
                        "success": False,
                        "data": None,
                        "error": {"code": "conflict", "message": msg},
                        "message": msg,
                    }
                ),
                409,
            )
        # Audit (fetch lot info for audit name)
        try:
            from app.services.audit_service import audit

            lot = ProductionService.get_production_lot(lot_id)
            audit.log_action(
                action="FINALIZE",
                resource_type="production_lot",
                resource_id=lot_id,
                resource_name=lot.get("lot_number") if lot else None,
                changes={"status": result.get("status")},
                user_id=getattr(current_user, "id", None),
                timestamp=datetime.utcnow(),
            )
        except Exception:
            current_app.logger.exception("Failed to write audit log for finalize_production_lot")

        return APIResponse.success(
            {
                "lot_id": result.get("lot_id"),
                "status": result.get("status"),
                "alerts_summary": result.get("alerts_summary"),
                "finalized_at": result.get("finalized_at"),
            }
        )
    except Exception as e:
        current_app.logger.error(f"Error finalizing production lot {lot_id}: {e}")
        return APIResponse.error("internal_error", str(e), 500)


@production_api_bp.route("/production-lots/<int:lot_id>/cancel", methods=["POST"])
@production_api_bp.route(
    "/production_lot/<int:lot_id>/cancel", methods=["POST"]
)  # Legacy compatibility
@login_required
def cancel_production_lot(lot_id):
    """Cancel production lot."""
    # Deprecation warning for underscore route
    if "production_lot" in request.path and "production-lots" not in request.path:
        msg = (
            f"POST /api/upf/production_lot/{lot_id}/cancel is deprecated. "
            f"Use POST /api/upf/production-lots/{lot_id}/cancel instead. "
            "Underscore routes will be removed after November 23, 2025."
        )
        warnings.warn(msg, DeprecationWarning, stacklevel=2)
        current_app.logger.warning(f"DEPRECATION: {msg}")

    try:
        if not request.is_json:
            return APIResponse.error(
                "validation_error", "Content-Type must be application/json", 400
            )

        # Check access
        lot = ProductionService.get_production_lot(lot_id)
        if not lot:
            return APIResponse.not_found("Production lot", lot_id)

        if lot["created_by"] != current_user.id and not is_admin():
            return APIResponse.error("forbidden", "Access denied", 403)

        data = request.json or {}
        reason = data.get("reason", "User cancelled")

        cancelled_lot = ProductionService.cancel_production_lot(lot_id, reason)

        safe_uid = getattr(current_user, "id", "anon")
        current_app.logger.info(
            f"Production lot cancelled: {cancelled_lot['lot_number']} by user {safe_uid}"
        )

        # Audit
        try:
            from app.services.audit_service import audit

            audit.log_action(
                action="CANCEL",
                resource_type="production_lot",
                resource_id=lot_id,
                resource_name=cancelled_lot.get("lot_number"),
                changes={"status": cancelled_lot.get("status")},
                user_id=getattr(current_user, "id", None),
                timestamp=datetime.utcnow(),
            )
        except Exception:
            current_app.logger.exception("Failed to write audit log for cancel_production_lot")

        return APIResponse.success(cancelled_lot, "Production lot cancelled")
    except Exception as e:
        current_app.logger.error(f"Error cancelling production lot: {e}")
        return APIResponse.error("internal_error", str(e), 500)


# ----- Update / Delete endpoints for production lots -----
@production_api_bp.route("/production-lots/<int:lot_id>", methods=["PUT"])
@login_required
def update_production_lot(lot_id: int):
    """Update editable fields for a production lot."""
    try:
        if not request.is_json:
            return APIResponse.error(
                "validation_error", "Content-Type must be application/json", 400
            )

        data = request.json or {}

        # Permission: only creator or admin
        lot = ProductionService.get_production_lot(lot_id)
        if not lot:
            return APIResponse.not_found("Production lot", lot_id)

        if (
            lot.get("created_by") != getattr(current_user, "id", None)
            and not is_admin()
        ):
            return APIResponse.error("forbidden", "Insufficient permissions", 403)

        updated = ProductionService.update_production_lot(
            lot_id, data, getattr(current_user, "id", None)
        )
        return APIResponse.success(updated, "Production lot updated")
    except ValueError as ve:
        current_app.logger.warning(f"Update validation error for lot {lot_id}: {ve}")
        return APIResponse.error("validation_error", str(ve), 400)
    except Exception as e:
        current_app.logger.error(f"Error updating production lot: {e}")
        return APIResponse.error("internal_error", str(e), 500)


@production_api_bp.route("/production-lots/<int:lot_id>", methods=["DELETE"])
@production_api_bp.route("/production_lot/<int:lot_id>", methods=["DELETE"])  # Legacy compatibility
@login_required
def delete_production_lot(lot_id: int):
    """Delete a production lot (if allowed)."""
    try:
        lot = ProductionService.get_production_lot(lot_id)
        if not lot:
            return APIResponse.not_found("Production lot", lot_id)

        if (
            lot.get("created_by") != getattr(current_user, "id", None)
            and not is_admin()
        ):
            return APIResponse.error("forbidden", "Insufficient permissions", 403)

        result = ProductionService.delete_production_lot(
            lot_id, getattr(current_user, "id", None)
        )
        if not result:
            return APIResponse.error(
                "not_found", "Production lot not found or could not be deleted", 404
            )

        # Audit
        try:
            from app.services.audit_service import audit

            audit.log_action(
                action="DELETE",
                resource_type="production_lot",
                resource_id=lot_id,
                resource_name=lot.get("lot_number"),
                changes={"status": "deleted"},
                user_id=getattr(current_user, "id", None),
                timestamp=datetime.utcnow(),
            )
        except Exception:
            current_app.logger.exception("Failed to write audit log for delete_production_lot")

        return APIResponse.success({"deleted": True}, "Production lot deleted")
    except ValueError as ve:
        return APIResponse.error("validation_error", str(ve), 400)
    except Exception as e:
        current_app.logger.error(f"Error deleting production lot: {e}")
        return APIResponse.error("internal_error", str(e), 500)


@production_api_bp.route(
    "/production-lots/<int:lot_id>/selections/<int:selection_id>", methods=["DELETE"]
)
@login_required
def delete_variant_selection(lot_id: int, selection_id: int):
    """Delete a single variant selection from a production lot."""
    try:
        lot = ProductionService.get_production_lot(lot_id)
        if not lot:
            return APIResponse.not_found("Production lot", lot_id)

        if (
            lot.get("created_by") != getattr(current_user, "id", None)
            and not is_admin()
        ):
            return APIResponse.error("forbidden", "Insufficient permissions", 403)

        removed = ProductionService.remove_variant_selection(selection_id, lot_id)
        if not removed:
            return APIResponse.error("not_found", "Selection not found", 404)
        return APIResponse.success({"removed": True}, "Selection removed")
    except Exception as e:
        current_app.logger.error(
            f"Error removing selection {selection_id} from lot {lot_id}: {e}"
        )
        return APIResponse.error("internal_error", str(e), 500)


# ===== ACTUAL COSTING & VARIANCE ANALYSIS =====


@production_api_bp.route(
    "/production-lots/<int:lot_id>/actual-costing", methods=["GET"]
)
@production_api_bp.route(
    "/production_lot/<int:lot_id>/actual_costing", methods=["GET"]
)  # Legacy compatibility
@login_required
def get_lot_actual_costing(lot_id):
    """Get actual costing breakdown for lot."""
    # Deprecation warning for underscore route
    if "actual_costing" in request.path:
        msg = (
            f"GET /api/upf/production_lot/{lot_id}/actual_costing is deprecated. "
            f"Use GET /api/upf/production-lots/{lot_id}/actual-costing instead. "
            "Underscore routes will be removed after November 23, 2025."
        )
        warnings.warn(msg, DeprecationWarning, stacklevel=2)
        current_app.logger.warning(f"DEPRECATION: {msg}")

    try:
        # Check access
        lot = ProductionService.get_production_lot(lot_id)
        if not lot:
            return APIResponse.not_found("Production lot", lot_id)

        if lot["created_by"] != current_user.id and not is_admin():
            return APIResponse.error("forbidden", "Access denied", 403)

        actual_costs = ProductionService.calculate_lot_actual_cost(lot_id)

        return APIResponse.success(actual_costs)
    except Exception as e:
        current_app.logger.error(f"Error getting actual costing: {e}")
        return APIResponse.error("internal_error", str(e), 500)


@production_api_bp.route(
    "/production-lots/<int:lot_id>/variance-analysis", methods=["GET"]
)
@production_api_bp.route(
    "/production_lot/<int:lot_id>/variance_analysis", methods=["GET"]
)  # Legacy compatibility
@login_required
def get_variance_analysis(lot_id):
    """Get variance analysis (worst-case vs actual)."""
    # Deprecation warning for underscore route
    if "variance_analysis" in request.path:
        msg = (
            f"GET /api/upf/production_lot/{lot_id}/variance_analysis is deprecated. "
            f"Use GET /api/upf/production-lots/{lot_id}/variance-analysis instead. "
            "Underscore routes will be removed after November 23, 2025."
        )
        warnings.warn(msg, DeprecationWarning, stacklevel=2)
        current_app.logger.warning(f"DEPRECATION: {msg}")

    try:
        # Check access
        lot = ProductionService.get_production_lot(lot_id)
        if not lot:
            return APIResponse.not_found("Production lot", lot_id)

        if lot["created_by"] != current_user.id and not is_admin():
            return APIResponse.error("forbidden", "Access denied", 403)

        if lot["status"] != "completed":
            return APIResponse.error(
                "validation_error", "Lot must be completed for variance analysis", 400
            )

        variance = ProductionService.get_variance_analysis(lot_id)

        return APIResponse.success(variance)
    except Exception as e:
        current_app.logger.error(f"Error getting variance analysis: {e}")
        return APIResponse.error("internal_error", str(e), 500)


# ===== REPORTING =====


@production_api_bp.route("/production-lots/summary", methods=["GET"])
@production_api_bp.route(
    "/production_lots/summary", methods=["GET"]
)  # Legacy compatibility
@login_required
def get_production_summary():
    """Get production summary statistics."""
    # Deprecation warning for underscore route
    if request.path == "/api/upf/production_lots/summary":
        msg = (
            "GET /api/upf/production_lots/summary is deprecated. Use GET /api/upf/production-lots/summary instead. "
            "Underscore routes will be removed after November 23, 2025."
        )
        warnings.warn(msg, DeprecationWarning, stacklevel=2)
        current_app.logger.warning(f"DEPRECATION: {msg}")

    try:
        from database import get_conn
        from psycopg2.extras import RealDictCursor

        # Get summary by status using a RealDictCursor so rows are dict-like
        with get_conn(cursor_factory=RealDictCursor) as (conn, cur):
            user_filter_sql = ""
            user_filter_params = []
            if not is_admin():
                user_filter_sql = "AND created_by = %s"
                user_filter_params = [getattr(current_user, "id", None)]

            cur.execute(
                f"""
                SELECT
                    status,
                    COUNT(*) as count,
                    SUM(quantity) as total_quantity,
                    AVG(total_cost) as avg_estimated_cost
                FROM production_lots
                WHERE 1=1 {user_filter_sql}
                GROUP BY status
            """,
                tuple(user_filter_params),
            )

            summary = cur.fetchall()

        return APIResponse.success([dict(row) for row in summary])
    except Exception as e:
        current_app.logger.error(f"Error getting production summary: {e}")
        return APIResponse.error("internal_error", str(e), 500)


@production_api_bp.route("/production-lots/recent", methods=["GET"])
@production_api_bp.route(
    "/production_lots/recent", methods=["GET"]
)  # Legacy compatibility
@login_required
def get_recent_lots():
    """Get recently executed production lots."""
    # Deprecation warning for underscore route
    if request.path == "/api/upf/production_lots/recent":
        msg = (
            "GET /api/upf/production_lots/recent is deprecated. Use GET /api/upf/production-lots/recent instead. "
            "Underscore routes will be removed after November 23, 2025."
        )
        warnings.warn(msg, DeprecationWarning, stacklevel=2)
        current_app.logger.warning(f"DEPRECATION: {msg}")

    try:
        limit = min(int(request.args.get("limit", 10)), 50)

        from database import get_conn
        from psycopg2.extras import RealDictCursor

        user_filter_sql = ""
        user_filter_params = []
        if not is_admin():
            user_filter_sql = "AND pl.created_by = %s"
            user_filter_params = [getattr(current_user, "id", None)]

        with get_conn(cursor_factory=RealDictCursor) as (conn, cur):
            params = tuple(user_filter_params + [limit])
            cur.execute(
                f"""
                SELECT
                    pl.*,
                    p.name as process_name
                FROM production_lots pl
                JOIN processes p ON pl.process_id = p.id
                WHERE pl.status = 'Completed'
                    {user_filter_sql}
                ORDER BY pl.created_at DESC
                LIMIT %s
            """,
                params,
            )

            lots = cur.fetchall()

        return APIResponse.success([dict(row) for row in lots])
    except Exception as e:
        current_app.logger.error(f"Error getting recent lots: {e}")
        return APIResponse.error("internal_error", str(e), 500)


# Error handlers
@production_api_bp.errorhandler(404)
def not_found(error):
    return APIResponse.error("not_found", "Resource not found", 404)


@production_api_bp.errorhandler(500)
def internal_error(error):
    current_app.logger.error(f"Internal server error: {error}")
    return APIResponse.error("internal_error", "Internal server error", 500)
