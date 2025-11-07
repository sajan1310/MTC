"""
Process Management API for Universal Process Framework.

Provides REST API endpoints for process CRUD operations, subprocess management,
and process structure manipulation.
"""

from functools import wraps

import psycopg2.errors
from flask import Blueprint, current_app, request
from flask_login import current_user, login_required

from app import limiter
from app.services.audit_service import audit
from app.services.costing_service import CostingService
from app.services.process_service import ProcessService
from app.services.subprocess_service import SubprocessService
from app.utils.response import APIResponse

process_api_bp = Blueprint("process_api", __name__)


# Helper function to safely check user role
def get_user_role():
    """Get current user's role, returning None if not authenticated or role doesn't exist."""
    if current_user.is_authenticated and hasattr(current_user, 'role'):
        return current_user.role
    return None


def is_admin():
    """Check if current user is an admin."""
    return get_user_role() == "admin"


def can_access_process(process):
    """Check if current user can access the given process.
    Returns True if user is admin, owns the process, or not authenticated (for testing)."""
    if not current_user.is_authenticated:
        return True  # Allow access in test mode with LOGIN_DISABLED
    if is_admin():
        return True
    return process.get("user_id") == current_user.id


@process_api_bp.before_request
def log_request_info():
    """Log incoming request details for debugging."""
    current_app.logger.debug(f"[PROCESS API] {request.method} {request.path}")
    current_app.logger.debug(f"[PROCESS API] Headers: {dict(request.headers)}")
    if request.method in ["POST", "PUT", "PATCH"]:
        current_app.logger.debug(f"[PROCESS API] Content-Type: {request.content_type}")
        current_app.logger.debug(
            f"[PROCESS API] Content-Length: {request.content_length}"
        )


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


# ===== PROCESS CRUD OPERATIONS =====


@process_api_bp.route("/processes", methods=["POST"])  # New plural (frontend uses this)
@process_api_bp.route("/process", methods=["POST"], endpoint="create_process_singular_deprecated")  # Keep old singular
@login_required
@limiter.limit("20 per hour")
def create_process():
    """Create a new process.
    
    Note: Dual routing for backward compatibility.
    - /processes is the preferred endpoint (plural)
    - /process is deprecated but maintained for compatibility
    """
    try:
        # Log request details for debugging
        current_app.logger.info(
            f"[CREATE PROCESS] Received request from user {current_user.id}"
        )
        current_app.logger.debug(
            f"[CREATE PROCESS] Content-Type: {request.content_type}"
        )
        current_app.logger.debug(
            f"[CREATE PROCESS] Request data: {request.data[:500] if request.data else 'None'}"
        )

        # Validate Content-Type
        if not request.is_json:
            current_app.logger.warning(
                f"[CREATE PROCESS] Invalid Content-Type: {request.content_type}"
            )
            return APIResponse.error(
                "invalid_content_type",
                f"Expected application/json but received {request.content_type}",
                400,
            )

        # Parse JSON with error handling
        data = request.get_json(silent=True)

        if data is None:
            current_app.logger.error(
                "[CREATE PROCESS] Failed to parse JSON request body"
            )
            return APIResponse.error(
                "invalid_json",
                "Request body must be valid JSON. Check for syntax errors, trailing commas, or improper quotes.",
                400,
            )

        current_app.logger.debug(f"[CREATE PROCESS] Parsed data: {data}")

        # Validate required fields
        if not data.get("name"):
            current_app.logger.warning("[CREATE PROCESS] Missing required field: name")
            return APIResponse.error(
                "validation_error", "Process name is required", 400
            )

        # Validate name is not empty or just whitespace
        if not data["name"].strip():
            current_app.logger.warning("[CREATE PROCESS] Empty process name")
            return APIResponse.error(
                "validation_error", "Process name cannot be empty", 400
            )

        # Normalize process_class to match allowed DB values
        allowed_classes = [
            "Manufacturing",
            "Assembly",
            "Packaging",
            "Testing",
            "Logistics",
        ]
        raw_class = data.get("class", "Assembly")

        # Try to match ignoring case
        process_class = next(
            (c for c in allowed_classes if c.lower() == str(raw_class).lower()),
            "Assembly",
        )

        current_app.logger.info(
            f"[CREATE PROCESS] Creating process '{data['name']}' with class '{process_class}'"
        )

        process = ProcessService.create_process(
            name=data["name"].strip(),
            user_id=current_user.id,
            description=data.get("description"),
            process_class=process_class,
        )

        # Audit log
        audit.log_create("process", process["id"], data["name"])

        current_app.logger.info(
            f"[CREATE PROCESS] Process created successfully: {process['id']} by user {current_user.id}"
        )
        return APIResponse.created(process, "Process created successfully")

    except psycopg2.errors.UniqueViolation:
        current_app.logger.warning(
            f"[CREATE PROCESS] Duplicate process name: {data.get('name')}"
        )
        return APIResponse.error(
            "duplicate_name",
            f"A process with the name '{data.get('name')}' already exists. Please choose a different name.",
            409,
        )
    except KeyError as e:
        current_app.logger.error(f"[CREATE PROCESS] Missing key: {e}")
        return APIResponse.error(
            "validation_error", f"Missing required field: {str(e)}", 400
        )
    except ValueError as e:
        current_app.logger.error(f"[CREATE PROCESS] Invalid value: {e}")
        return APIResponse.error("validation_error", str(e), 400)
    except Exception as e:
        current_app.logger.error(
            f"[CREATE PROCESS] Unexpected error: {e}", exc_info=True
        )
        return APIResponse.error(
            "internal_error",
            str(e) if current_app.debug else "An unexpected error occurred",
            500,
        )


@process_api_bp.route("/processes/<int:process_id>", methods=["GET"])  # New plural (frontend uses this)
@process_api_bp.route("/process/<int:process_id>", methods=["GET"], endpoint="get_process_singular_deprecated")  # Keep old singular for backward compatibility
@login_required
def get_process(process_id):
    """Get process with full structure.
    
    Note: Dual routing for backward compatibility.
    - /processes/<id> is the preferred endpoint (plural)
    - /process/<id> is deprecated but maintained for compatibility
    """
    try:
        process = ProcessService.get_process_full_structure(process_id)

        if not process:
            return APIResponse.not_found("Process", process_id)

        # Check user access
        if not can_access_process(process):
            return APIResponse.error("forbidden", "Access denied", 403)

        return APIResponse.success(process)

    except Exception as e:
        current_app.logger.error(f"Error retrieving process {process_id}: {e}")
        return APIResponse.error("internal_error", str(e), 500)


@process_api_bp.route("/processes/<int:process_id>/structure", methods=["GET"])
@login_required
def get_process_structure(process_id):
    """Get complete process structure for editor (subprocesses, variants, groups, costs)."""
    try:
        process = ProcessService.get_process_full_structure(process_id)
        if not process:
            return APIResponse.not_found("Process", process_id)

        # Check user access - only if user is authenticated
        if current_user.is_authenticated:
            # Use correct key - process may have 'user_id' or 'created_by'
            process_owner = process.get("user_id") or process.get("created_by")
            if not can_access_process({"user_id": process_owner}):
                return APIResponse.error("forbidden", "Access denied", 403)

        return APIResponse.success(process)
    except Exception as e:
        current_app.logger.error(
            f"Error retrieving process structure {process_id}: {e}", exc_info=True
        )
        return APIResponse.error("internal_error", str(e), 500)


@process_api_bp.route("/processes", methods=["GET"])
@login_required
def list_processes():
    """List processes with pagination and filtering."""
    try:
        page = int(request.args.get("page", 1))
        per_page = min(int(request.args.get("per_page", 25)), 100)  # Max 100
        status = request.args.get("status")

        # Check if user is authenticated and not admin
        user_id = None
        if current_user.is_authenticated and not is_admin():
            user_id = current_user.id

        result = ProcessService.list_processes(
            user_id=user_id,
            status=status,
            page=page,
            per_page=per_page,
        )
        return APIResponse.success(result)

    except Exception as e:
        current_app.logger.error(f"Error listing processes: {e}")
        return APIResponse.error("internal_error", str(e), 500)


@process_api_bp.route("/processes/<int:process_id>", methods=["PUT"])  # New plural (frontend uses this)
@process_api_bp.route("/process/<int:process_id>", methods=["PUT"], endpoint="update_process_singular_deprecated")  # Keep old singular
@login_required
def update_process(process_id):
    """Update process details.
    
    Note: Dual routing for backward compatibility.
    - /processes/<id> is the preferred endpoint (plural)
    - /process/<id> is deprecated but maintained for compatibility
    """
    try:
        # Check ownership
        process = ProcessService.get_process(process_id)
        if not process:
            return APIResponse.not_found("Process", process_id)

        if not can_access_process(process):
            return APIResponse.error("forbidden", "Access denied", 403)

        data = request.json
        updated = ProcessService.update_process(
            process_id,
            name=data.get("name"),
            description=data.get("description"),
            process_class=data.get("class"),
            status=data.get("status"),
        )

        if not updated:
            return APIResponse.error("update_failed", "Update failed", 400)

        # Audit log
        audit.log_update(
            "process", process_id, process["name"], old_data=process, new_data=data
        )

        current_app.logger.info(
            f"Process updated: {process_id} by user {current_user.id}"
        )
        return APIResponse.success(updated, "Process updated")

    except Exception as e:
        current_app.logger.error(f"Error updating process {process_id}: {e}")
        return APIResponse.error("internal_error", str(e), 500)


@process_api_bp.route("/processes/<int:process_id>", methods=["DELETE"])  # New plural (frontend uses this)
@process_api_bp.route("/process/<int:process_id>", methods=["DELETE"], endpoint="delete_process_singular_deprecated")  # Keep old singular
@login_required
def delete_process(process_id):
    """Soft delete a process.
    
    Note: Dual routing for backward compatibility.
    - /processes/<id> is the preferred endpoint (plural)
    - /process/<id> is deprecated but maintained for compatibility
    """
    try:
        # Check ownership
        process = ProcessService.get_process(process_id)
        if not process:
            return APIResponse.not_found("Process", process_id)

        if not can_access_process(process):
            return APIResponse.error("forbidden", "Access denied", 403)

        success = ProcessService.delete_process(process_id, hard_delete=False)

        if not success:
            return APIResponse.error("delete_failed", "Delete failed", 400)

        # Audit log
        audit.log_delete("process", process_id, process["name"], data=process)

        current_app.logger.info(
            f"Process deleted: {process_id} by user {current_user.id}"
        )
        return APIResponse.success(None, "Process deleted successfully")

    except Exception as e:
        current_app.logger.error(f"Error deleting process {process_id}: {e}")
        return APIResponse.error("internal_error", str(e), 500)


@process_api_bp.route("/processes/<int:process_id>/restore", methods=["POST"])  # New plural (frontend uses this)
@process_api_bp.route("/process/<int:process_id>/restore", methods=["POST"], endpoint="restore_process_singular_deprecated")  # Keep old singular
@login_required
def restore_process(process_id):
    """Restore a soft-deleted process.
    
    Note: Dual routing for backward compatibility.
    - /processes/<id>/restore is the preferred endpoint (plural)
    - /process/<id>/restore is deprecated but maintained for compatibility
    """
    try:
        success = ProcessService.restore_process(process_id)

        if not success:
            return APIResponse.error(
                "not_found_or_active", "Process not found or already active", 404
            )

        current_app.logger.info(
            f"Process restored: {process_id} by user {current_user.id}"
        )
        return APIResponse.success({"id": process_id}, "Process restored successfully")

    except Exception as e:
        current_app.logger.error(f"Error restoring process {process_id}: {e}")
        return APIResponse.error("internal_error", str(e), 500)


@process_api_bp.route("/processes/search", methods=["GET"])  # New plural (frontend uses this)
@process_api_bp.route("/process/search", methods=["GET"], endpoint="search_processes_singular_deprecated")  # Keep old singular
@login_required
def search_processes():
    """Search processes by name or description.
    
    Note: Dual routing for backward compatibility.
    - /processes/search is the preferred endpoint (plural)
    - /process/search is deprecated but maintained for compatibility
    """
    try:
        query = request.args.get("q", "")

        if len(query) < 2:
            return APIResponse.error(
                "validation_error", "Search query must be at least 2 characters", 400
            )

        results = ProcessService.search_processes(query, current_user.id)
        return APIResponse.success(results)

    except Exception as e:
        current_app.logger.error(f"Error searching processes: {e}")
        return APIResponse.error("internal_error", str(e), 500)


# ===== SUBPROCESS MANAGEMENT =====


@process_api_bp.route("/processes/<int:process_id>/subprocesses", methods=["POST"])
@login_required
def add_subprocess_to_process(process_id):
    """Add a subprocess to a process (creates template if needed)."""
    try:
        # Check ownership
        process = ProcessService.get_process(process_id)
        if not process:
            return APIResponse.not_found("Process", process_id)

        if (
            process.get("user_id") not in (None, current_user.id)
            and not is_admin()
        ):
            return APIResponse.error("forbidden", "Access denied", 403)

        data = request.get_json(silent=True) or {}

        # Accept either an existing subprocess_id or name/description to create
        subprocess_id = data.get("subprocess_id")
        order = data.get("order") or data.get("sequence_order") or 0

        if not subprocess_id:
            name = (data.get("name") or "").strip()
            description = (data.get("description") or "").strip() or None
            if not name:
                return APIResponse.error(
                    "validation_error", "Subprocess name required", 400
                )
            created = SubprocessService.create_subprocess(
                name=name, description=description
            )
            subprocess_id = created["id"]

        association = ProcessService.add_subprocess_to_process(
            process_id=process_id,
            subprocess_id=subprocess_id,
            sequence_order=int(order)
            if isinstance(order, (int, float, str)) and str(order).isdigit()
            else 0,
            custom_name=data.get("custom_name"),
            notes=data.get("notes"),
        )

        current_app.logger.info(
            f"Subprocess {subprocess_id} added to process {process_id}"
        )
        return APIResponse.created(association, "Subprocess added to process")
    except Exception as e:
        current_app.logger.error(f"Error adding subprocess to process: {e}")
        return APIResponse.error("internal_error", str(e), 500)


@process_api_bp.route(
    "/processes/<int:process_id>/subprocesses/<int:ps_id>", methods=["PUT"]
)
@login_required
def update_process_subprocess(process_id, ps_id):
    """Update a process-subprocess association (order, custom_name, notes)."""
    try:
        data = request.get_json(silent=True) or {}
        from database import get_conn

        with get_conn() as (conn, cur):
            updates = []
            params = []
            if "order" in data or "sequence_order" in data:
                updates.append("sequence_order = %s")
                params.append(int(data.get("order") or data.get("sequence_order") or 0))
            if "custom_name" in data:
                updates.append("custom_name = %s")
                params.append(data.get("custom_name"))
            if "notes" in data:
                updates.append("notes = %s")
                params.append(data.get("notes"))
            if not updates:
                return APIResponse.error("validation_error", "No fields to update", 400)
            params.extend([ps_id, process_id])
            cur.execute(
                f"""
                UPDATE process_subprocesses
                SET {', '.join(updates)}, updated_at = CURRENT_TIMESTAMP
                WHERE id = %s AND process_id = %s
                RETURNING id
            """,
                params,
            )
            updated = cur.fetchone()
            conn.commit()
        if not updated:
            return APIResponse.not_found("ProcessSubprocess", ps_id)
        return APIResponse.success({"id": ps_id}, "Association updated")
    except Exception as e:
        current_app.logger.error(f"Error updating process_subprocess {ps_id}: {e}")
        return APIResponse.error("internal_error", str(e), 500)


@process_api_bp.route(
    "/processes/<int:process_id>/subprocesses/<int:ps_id>", methods=["DELETE"]
)
@login_required
def remove_subprocess_from_process(process_id, ps_id):
    """Remove a subprocess from a process."""
    try:
        success = ProcessService.remove_subprocess_from_process(ps_id)
        if not success:
            return APIResponse.not_found("Association", ps_id)
        current_app.logger.info(f"Subprocess removed from process: {ps_id}")
        return APIResponse.success(None, "Subprocess removed")
    except Exception as e:
        current_app.logger.error(f"Error removing subprocess: {e}")
        return APIResponse.error("internal_error", str(e), 500)


@process_api_bp.route("/processes/<int:process_id>/reorder_subprocesses", methods=["POST"])  # New plural (frontend uses this)
@process_api_bp.route("/process/<int:process_id>/reorder_subprocesses", methods=["POST"], endpoint="reorder_subprocesses_singular_deprecated")  # Keep old singular
@login_required
def reorder_subprocesses(process_id):
    """Reorder subprocesses (drag-and-drop support).
    
    Note: Dual routing for backward compatibility.
    - /processes/<id>/reorder_subprocesses is the preferred endpoint (plural)
    - /process/<id>/reorder_subprocesses is deprecated but maintained for compatibility
    """
    try:
        # Check ownership
        process = ProcessService.get_process(process_id)
        if not process:
            return APIResponse.not_found("Process", process_id)

        # Check user access - only if user is authenticated
        if current_user.is_authenticated:
            if not can_access_process(process):
                return APIResponse.error("forbidden", "Access denied", 403)

        data = request.get_json(silent=True) or {}
        sequence_map = data.get("sequence_map", {})

        if not sequence_map:
            return APIResponse.error(
                "validation_error", "sequence_map is required", 400
            )

        # Convert string keys to int
        sequence_map = {int(k): v for k, v in sequence_map.items()}

        success = ProcessService.reorder_subprocesses(process_id, sequence_map)

        if not success:
            return APIResponse.error("reorder_failed", "Reorder failed", 400)

        return APIResponse.success(None, "Subprocesses reordered successfully")

    except Exception as e:
        current_app.logger.error(f"Error reordering subprocesses: {e}")
        return APIResponse.error("internal_error", str(e), 500)


# ===== COSTING OPERATIONS =====


@process_api_bp.route("/processes/<int:process_id>/costing", methods=["GET"])  # New plural (frontend uses this path)
@process_api_bp.route("/process/<int:process_id>/worst_case_costing", methods=["GET"], endpoint="get_worst_case_costing_singular_deprecated")  # Keep old singular
@login_required
def get_worst_case_costing(process_id):
    """Get complete worst-case cost breakdown for a process.
    
    Note: Dual routing for backward compatibility.
    - /processes/<id>/costing is the preferred endpoint (plural, shorter path)
    - /process/<id>/worst_case_costing is deprecated but maintained for compatibility
    """
    try:
        # Check access
        process = ProcessService.get_process(process_id)
        if not process:
            return APIResponse.not_found("Process", process_id)

        # Check user access - only if user is authenticated
        if current_user.is_authenticated:
            if not can_access_process(process):
                return APIResponse.error("forbidden", "Access denied", 403)

        cost_breakdown = CostingService.calculate_process_total_cost(process_id)
        return APIResponse.success(cost_breakdown)

    except Exception as e:
        current_app.logger.error(f"Error calculating worst-case costing: {e}")
        return APIResponse.error("internal_error", str(e), 500)


@process_api_bp.route("/processes/<int:process_id>/profitability", methods=["GET"])  # New plural (frontend uses this)
@process_api_bp.route("/process/<int:process_id>/profitability", methods=["GET"], endpoint="get_profitability_singular_deprecated")  # Keep old singular
@login_required
def get_profitability(process_id):
    """Get profitability metrics for a process.
    
    Note: Dual routing for backward compatibility.
    - /processes/<id>/profitability is the preferred endpoint (plural)
    - /process/<id>/profitability is deprecated but maintained for compatibility
    """
    try:
        # Check access
        process = ProcessService.get_process(process_id)
        if not process:
            return APIResponse.not_found("Process", process_id)

        if not can_access_process(process):
            return APIResponse.error("forbidden", "Access denied", 403)

        profitability = CostingService.update_profitability(process_id)
        return APIResponse.success(profitability)

    except Exception as e:
        current_app.logger.error(f"Error getting profitability: {e}")
        return APIResponse.error("internal_error", str(e), 500)


@process_api_bp.route("/processes/<int:process_id>/set_sales_price", methods=["POST"])  # New plural (frontend uses this)
@process_api_bp.route("/process/<int:process_id>/set_sales_price", methods=["POST"], endpoint="set_sales_price_singular_deprecated")  # Keep old singular
@login_required
def set_sales_price(process_id):
    """Set estimated sales price and recalculate profitability.
    
    Note: Dual routing for backward compatibility.
    - /processes/<id>/set_sales_price is the preferred endpoint (plural)
    - /process/<id>/set_sales_price is deprecated but maintained for compatibility
    """
    try:
        # Check ownership
        process = ProcessService.get_process(process_id)
        if not process:
            return APIResponse.not_found("Process", process_id)

        if not can_access_process(process):
            return APIResponse.error("forbidden", "Access denied", 403)

        data = request.json
        sales_price = data.get("sales_price")

        if sales_price is None:
            return APIResponse.error("validation_error", "sales_price is required", 400)

        try:
            sales_price = float(sales_price)
        except ValueError:
            return APIResponse.error(
                "validation_error", "sales_price must be a number", 400
            )

        profitability = CostingService.update_profitability(process_id, sales_price)

        current_app.logger.info(
            f"Sales price set for process {process_id}: {sales_price}"
        )
        return APIResponse.success(profitability, "Sales price updated")

    except Exception as e:
        current_app.logger.error(f"Error setting sales price: {e}")
        return APIResponse.error("internal_error", str(e), 500)


@process_api_bp.route(
    "/process/<int:process_id>/recalculate_worst_case", methods=["POST"]
)
@login_required
def recalculate_worst_case(process_id):
    """Recalculate worst-case costing and profitability."""
    try:
        # Check access
        process = ProcessService.get_process(process_id)
        if not process:
            return APIResponse.not_found("Process", process_id)

        if not can_access_process(process):
            return APIResponse.error("forbidden", "Access denied", 403)

        # Recalculate costs
        cost_breakdown = CostingService.calculate_process_total_cost(process_id)

        # Update profitability
        profitability = CostingService.update_profitability(process_id)

        return APIResponse.success(
            {"cost_breakdown": cost_breakdown, "profitability": profitability}
        )

    except Exception as e:
        current_app.logger.error(f"Error recalculating costs: {e}")
        return APIResponse.error("internal_error", str(e), 500)


# Error handlers
@process_api_bp.errorhandler(400)
def bad_request(error):
    """Handle 400 Bad Request errors with detailed information."""
    current_app.logger.warning(f"[PROCESS API] Bad Request: {error}")

    # Try to extract meaningful error details
    error_message = "Bad Request"
    error_details = None

    if hasattr(error, "description"):
        error_message = error.description

    # Check if it's a CSRF error
    if "CSRF" in str(error):
        error_details = "CSRF token is missing or invalid. This endpoint may require CSRF protection."
    return APIResponse.error(
        "bad_request",
        error_message,
        400,
        data={
            "details": error_details,
            "request_id": request.headers.get("X-Request-ID", "N/A"),
        },
    )


@process_api_bp.errorhandler(404)
def not_found(error):
    return APIResponse.error("not_found", "Resource not found", 404)


@process_api_bp.errorhandler(500)
def internal_error(error):
    current_app.logger.error(f"Internal server error: {error}")
    return APIResponse.error("internal_error", "Internal server error", 500)
