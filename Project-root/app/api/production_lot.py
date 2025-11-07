"""
Production Lot API for Universal Process Framework.

Provides REST API endpoints for production lot lifecycle: creation, variant selection,
validation, execution, and variance analysis.

[BUG FIX] Updated all routes to use hyphenated URLs (/production-lots) as primary endpoints
with underscored versions (/production_lot, /production_lots) as legacy compatibility.
Frontend JavaScript expects hyphenated URLs (e.g., /api/upf/production-lots).
"""

from functools import wraps

from flask import Blueprint, current_app, request
from flask_login import current_user, login_required

from app import limiter
from app.services.production_service import ProductionService
from app.utils.response import APIResponse

production_api_bp = Blueprint("production_api", __name__)


# Helper function to safely check user role
def get_user_role():
    """Get current user's role, returning None if not authenticated or role doesn't exist."""
    if current_user.is_authenticated and hasattr(current_user, 'role'):
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
    try:
        data = request.json

        if not data.get("process_id"):
            return APIResponse.error("validation_error", "process_id is required", 400)
        if not data.get("quantity"):
            return APIResponse.error("validation_error", "quantity is required", 400)

        lot = ProductionService.create_production_lot(
            process_id=data["process_id"],
            quantity=data["quantity"],
            user_id=current_user.id,
            notes=data.get("notes"),
        )

        current_app.logger.info(
            f"Production lot created: {lot['lot_number']} by user {current_user.id}"
        )
        return APIResponse.created(lot, "Production lot created")
    except Exception as e:
        current_app.logger.error(f"Error creating production lot: {e}")
        return APIResponse.error("internal_error", str(e), 500)


@production_api_bp.route("/production-lots/<int:lot_id>", methods=["GET"])
@production_api_bp.route("/production_lot/<int:lot_id>", methods=["GET"])  # Legacy compatibility
@login_required
def get_production_lot(lot_id):
    """Get production lot with full details."""
    try:
        lot = ProductionService.get_production_lot(lot_id)

        if not lot:
            return APIResponse.not_found("Production lot", lot_id)

        # Check access
        if lot["created_by"] != current_user.id and not is_admin():
            return APIResponse.error("forbidden", "Access denied", 403)

        return APIResponse.success(lot)

    except Exception as e:
        current_app.logger.error(f"Error retrieving production lot: {e}")
        return APIResponse.error("internal_error", str(e), 500)


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

        if lot["created_by"] != current_user.id and not is_admin():
            return APIResponse.error("forbidden", "Access denied", 403)

        with get_conn() as (conn, cur):
            cur = conn.cursor(cursor_factory=RealDictCursor)

            # Get process structure with subprocesses and variants
            cur.execute(
                """
                SELECT
                    ps.id as process_subprocess_id,
                    ps.id as sequence_order,
                    s.id as subprocess_id,
                    s.name as subprocess_name,
                    ps.custom_name
                FROM process_subprocesses ps
                JOIN subprocesses s ON s.id = ps.subprocess_id
                WHERE ps.process_id = %s
                  AND ps.deleted_at IS NULL
                  AND s.deleted_at IS NULL
                ORDER BY ps.id
            """,
                (lot["process_id"],),
            )

            subprocesses = cur.fetchall()

            result = []
            for sp in subprocesses:
                # Get all variants for this subprocess
                cur.execute(
                    """
                    SELECT
                        vu.id as usage_id,
                        vu.item_id,
                        vu.quantity,
                        vu.unit,
                        vu.substitute_group_id,
                        vu.is_alternative,
                        vu.alternative_order,
                        iv.item_number,
                        iv.description,
                        iv.opening_stock,
                        iv.unit_price
                    FROM variant_usage vu
                    JOIN item_variant iv ON iv.item_id = vu.item_id
                    WHERE vu.process_subprocess_id = %s
                      AND vu.deleted_at IS NULL
                    ORDER BY vu.substitute_group_id NULLS FIRST, vu.alternative_order NULLS LAST
                """,
                    (sp["process_subprocess_id"],),
                )

                variants = cur.fetchall()

                # Get OR groups for this subprocess
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
                    (sp["process_subprocess_id"],),
                )

                or_groups = cur.fetchall()

                # Organize variants by OR group
                grouped_variants = {}
                standalone_variants = []

                for v in variants:
                    variant_data = dict(v)
                    if v["substitute_group_id"]:
                        if v["substitute_group_id"] not in grouped_variants:
                            grouped_variants[v["substitute_group_id"]] = []
                        grouped_variants[v["substitute_group_id"]].append(variant_data)
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


@production_api_bp.route("/production-lots", methods=["GET"])
@production_api_bp.route("/production_lots", methods=["GET"])  # Legacy compatibility
@login_required
def list_production_lots():
    """List production lots with pagination."""
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

        data = request.json

        if not data.get("substitute_group_id"):
            return APIResponse.error(
                "validation_error", "substitute_group_id is required", 400
            )
        if not data.get("selected_variant_id"):
            return APIResponse.error(
                "validation_error", "selected_variant_id is required", 400
            )

        selection = ProductionService.select_variant_for_group(
            lot_id=lot_id,
            substitute_group_id=data["substitute_group_id"],
            selected_variant_id=data["selected_variant_id"],
            reason=data.get("reason"),
        )

        current_app.logger.info(
            f"Variant selected for lot {lot_id}, group {data['substitute_group_id']}"
        )
        return APIResponse.created(selection, "Variant selected")
    except Exception as e:
        current_app.logger.error(f"Error selecting variant: {e}")
        return APIResponse.error("internal_error", str(e), 500)


@production_api_bp.route("/production-lots/<int:lot_id>/selections", methods=["GET"])
@production_api_bp.route("/production_lot/<int:lot_id>/selections", methods=["GET"])  # Legacy compatibility
@login_required
def get_lot_selections(lot_id):
    """Get all variant selections for a lot."""
    try:
        # Check access
        lot = ProductionService.get_production_lot(lot_id)
        if not lot:
            return APIResponse.not_found("Production lot", lot_id)

        if lot["created_by"] != current_user.id and not is_admin():
            return APIResponse.error("forbidden", "Access denied", 403)

        return APIResponse.success(lot.get("selections", []))

    except Exception as e:
        current_app.logger.error(f"Error getting selections: {e}")
        return APIResponse.error("internal_error", str(e), 500)


@production_api_bp.route(
    "/production_lot/<int:lot_id>/batch_select_variants", methods=["POST"]
)
@login_required
def batch_select_variants(lot_id):
    """Save multiple variant selections at once."""
    try:
        from database import get_conn

        from app.services.audit_service import audit

        # Check access
        lot = ProductionService.get_production_lot(lot_id)
        if not lot:
            return APIResponse.not_found("Production lot", lot_id)

        if lot["created_by"] != current_user.id and not is_admin():
            return APIResponse.error("forbidden", "Access denied", 403)

        if lot["status"] not in ["planning", "ready"]:
            return APIResponse.error(
                "validation_error", "Lot must be in planning or ready status", 400
            )

        data = request.json
        selections = data.get("selections", [])

        if not selections:
            return APIResponse.error("validation_error", "No selections provided", 400)

        with get_conn() as (conn, cur):
            # Delete existing selections for this lot
            cur.execute(
                "DELETE FROM production_lot_variant_selections WHERE lot_id = %s",
                (lot_id,),
            )

            # Insert new selections
            for sel in selections:
                cur.execute(
                    """
                    INSERT INTO production_lot_variant_selections
                    (lot_id, or_group_id, variant_usage_id, quantity_override, reason, created_by)
                    VALUES (%s, %s, %s, %s, %s, %s)
                """,
                    (
                        lot_id,
                        sel.get("or_group_id"),
                        sel["variant_usage_id"],
                        sel.get("quantity_override"),
                        sel.get("reason"),
                        current_user.id,
                    ),
                )

            conn.commit()

        # Audit log
        audit.log_action(
            "UPDATE",
            "production_lot",
            lot_id,
            lot["lot_number"],
            changes={"selections": selections},
            metadata={"selection_count": len(selections)},
        )

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
@production_api_bp.route("/production_lot/<int:lot_id>/validate", methods=["POST"])  # Legacy compatibility
@login_required
def validate_lot_readiness(lot_id):
    """Validate lot readiness (all OR groups selected, stock available)."""
    try:
        # Check access
        lot = ProductionService.get_production_lot(lot_id)
        if not lot:
            return APIResponse.not_found("Production lot", lot_id)

        if lot["created_by"] != current_user.id and not is_admin():
            return APIResponse.error("forbidden", "Access denied", 403)

        validation_result = ProductionService.validate_lot_readiness(lot_id)

        return APIResponse.success(validation_result)
    except Exception as e:
        current_app.logger.error(f"Error validating lot: {e}")
        return APIResponse.error("internal_error", str(e), 500)


@production_api_bp.route("/production-lots/<int:lot_id>/execute", methods=["POST"])
@production_api_bp.route("/production_lot/<int:lot_id>/execute", methods=["POST"])  # Legacy compatibility
@login_required
@role_required("admin", "inventory_manager", "production_manager")
def execute_production_lot(lot_id):
    """Execute production lot (deduct inventory, track actual costs)."""
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

        current_app.logger.info(
            f"Production lot executed: {executed_lot['lot_number']} by user {current_user.id}"
        )
        return APIResponse.success(executed_lot, "Production lot executed")
    except Exception as e:
        current_app.logger.error(f"Error executing production lot: {e}")
        return APIResponse.error("internal_error", str(e), 500)


@production_api_bp.route("/production-lots/<int:lot_id>/cancel", methods=["POST"])
@production_api_bp.route("/production_lot/<int:lot_id>/cancel", methods=["POST"])  # Legacy compatibility
@login_required
def cancel_production_lot(lot_id):
    """Cancel production lot."""
    try:
        # Check access
        lot = ProductionService.get_production_lot(lot_id)
        if not lot:
            return APIResponse.not_found("Production lot", lot_id)

        if lot["created_by"] != current_user.id and not is_admin():
            return APIResponse.error("forbidden", "Access denied", 403)

        data = request.json
        reason = data.get("reason", "User cancelled")

        cancelled_lot = ProductionService.cancel_production_lot(lot_id, reason)

        current_app.logger.info(
            f"Production lot cancelled: {cancelled_lot['lot_number']} by user {current_user.id}"
        )
        return APIResponse.success(cancelled_lot, "Production lot cancelled")
    except Exception as e:
        current_app.logger.error(f"Error cancelling production lot: {e}")
        return APIResponse.error("internal_error", str(e), 500)


# ===== ACTUAL COSTING & VARIANCE ANALYSIS =====


@production_api_bp.route("/production-lots/<int:lot_id>/actual-costing", methods=["GET"])
@production_api_bp.route("/production_lot/<int:lot_id>/actual_costing", methods=["GET"])  # Legacy compatibility
@login_required
def get_lot_actual_costing(lot_id):
    """Get actual costing breakdown for lot."""
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
@production_api_bp.route("/production_lots/summary", methods=["GET"])  # Legacy compatibility
@login_required
def get_production_summary():
    """Get production summary statistics."""
    try:
        from database import get_conn
        from psycopg2.extras import RealDictCursor

        conn = get_conn()
        cur = conn.cursor(cursor_factory=RealDictCursor)

        # Get summary by status
        user_filter = (
            "" if is_admin() else f"AND created_by = {current_user.id}"
        )

        cur.execute(f"""
            SELECT
                status,
                COUNT(*) as count,
                SUM(quantity) as total_quantity,
                AVG(total_cost) as avg_estimated_cost
            FROM production_lots
            WHERE 1=1 {user_filter}
            GROUP BY status
        """)

        summary = cur.fetchall()
        cur.close()

        return APIResponse.success([dict(row) for row in summary])
    except Exception as e:
        current_app.logger.error(f"Error getting production summary: {e}")
        return APIResponse.error("internal_error", str(e), 500)


@production_api_bp.route("/production-lots/recent", methods=["GET"])
@production_api_bp.route("/production_lots/recent", methods=["GET"])  # Legacy compatibility
@login_required
def get_recent_lots():
    """Get recently executed production lots."""
    try:
        limit = min(int(request.args.get("limit", 10)), 50)

        from database import get_conn
        from psycopg2.extras import RealDictCursor

        conn = get_conn()
        cur = conn.cursor(cursor_factory=RealDictCursor)

        user_filter = (
            ""
            if is_admin()
            else f"AND pl.created_by = {current_user.id}"
        )

        cur.execute(
            f"""
            SELECT
                pl.*,
                p.name as process_name
            FROM production_lots pl
            JOIN processes p ON pl.process_id = p.id
            WHERE pl.status = 'Completed'
                {user_filter}
            ORDER BY pl.created_at DESC
            LIMIT %s
        """,
            (limit,),
        )

        lots = cur.fetchall()
        cur.close()

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
