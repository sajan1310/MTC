"""
Production Lot Validator

Provides input validation helpers for production lot creation and
inventory alert acknowledgment per the UPF action plan.
"""

from __future__ import annotations
from typing import List, Dict, Any, Optional
from datetime import date

import psycopg2.extras
import database
from flask import current_app


MAX_LOT_QUANTITY = 1_000_000


def _get_logger():
    """Get Flask logger with fallback."""
    try:
        return current_app.logger
    except (RuntimeError, AttributeError):
        import logging
        return logging.getLogger("production_lot_validator")


def validate_production_lot_creation(
    process_id: int, quantity: int, user_id: int
) -> List[str]:
    """Validate inputs before creating a production lot.

    Returns a list of human-readable error strings. Empty if valid.
    """
    errors: List[str] = []
    logger = _get_logger()

    try:
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            # Helper: detect if a column exists on the connected DB/schema
            def _column_exists(table: str, column: str) -> bool:
                try:
                    cur.execute(
                        """
                        SELECT 1 FROM information_schema.columns
                        WHERE table_schema = current_schema() AND table_name = %s AND column_name = %s
                        """,
                        (table, column),
                    )
                    return bool(cur.fetchone())
                except Exception as e:
                    logger.warning(f"Could not check if {table}.{column} exists: {e}")
                    return False

            # Detect whether soft-delete column exists for processes and process_subprocesses
            processes_has_deleted = _column_exists("processes", "deleted_at")
            subprocesses_has_deleted = _column_exists("process_subprocesses", "deleted_at")

            # 1) process exists and is active/draft
            try:
                if processes_has_deleted:
                    cur.execute(
                        """
                        SELECT id, status
                        FROM processes
                        WHERE id = %s AND deleted_at IS NULL
                        """,
                        (process_id,),
                    )
                else:
                    cur.execute(
                        """
                        SELECT id, status
                        FROM processes
                        WHERE id = %s
                        """,
                        (process_id,),
                    )
                row = cur.fetchone()
                if not row:
                    errors.append(f"Process {process_id} not found")
                else:
                    if str(row.get("status", "")).lower() not in ("active", "draft"):
                        errors.append(f"Process {process_id} not active/draft")
            except Exception as e:
                logger.error(f"Error checking process {process_id}: {e}")
                errors.append(f"Failed to validate process: {str(e)}")

            # 2) quantity bounds
            try:
                q = int(quantity)
                if q <= 0:
                    errors.append("quantity must be > 0")
                if q > MAX_LOT_QUANTITY:
                    errors.append(f"quantity exceeds MAX_LOT_QUANTITY ({MAX_LOT_QUANTITY})")
            except Exception:
                errors.append("quantity must be an integer")

            # 3) user exists (basic check)
            try:
                cur.execute("SELECT 1 FROM users WHERE user_id = %s", (user_id,))
                if not cur.fetchone():
                    errors.append(f"user_id {user_id} not found")
            except Exception as e:
                logger.error(f"Error checking user {user_id}: {e}")
                errors.append(f"Failed to validate user: {str(e)}")

            # 4) process has at least 1 subprocess
            try:
                if subprocesses_has_deleted:
                    cur.execute(
                        """
                        SELECT id FROM process_subprocesses
                        WHERE process_id = %s AND deleted_at IS NULL
                        LIMIT 1
                        """,
                        (process_id,),
                    )
                else:
                    cur.execute(
                        """
                        SELECT id FROM process_subprocesses
                        WHERE process_id = %s
                        LIMIT 1
                        """,
                        (process_id,),
                    )
                if not cur.fetchone():
                    errors.append(
                        f"Process {process_id} has no subprocesses; cannot create lot"
                    )
            except Exception as e:
                logger.error(f"Error checking subprocesses for process {process_id}: {e}")
                errors.append(f"Failed to validate subprocesses: {str(e)}")

            # 5) Check for cost data availability (NEW VALIDATION)
            # Warn if process has no supplier pricing configured
            try:
                cur.execute(
                    """
                    SELECT COUNT(DISTINCT vsp.variant_id) as variants_with_pricing
                    FROM process_subprocesses ps
                    JOIN variant_usage vu ON vu.process_subprocess_id = ps.id
                    JOIN variant_supplier_pricing vsp ON vsp.variant_id = vu.variant_id
                    WHERE ps.process_id = %s AND vsp.is_active = TRUE
                    """,
                    (process_id,),
                )
                pricing_result = cur.fetchone()
                variants_with_pricing = pricing_result.get("variants_with_pricing", 0) if pricing_result else 0

                if variants_with_pricing == 0:
                    logger.warning(
                        f"Process {process_id} has no supplier pricing configured; "
                        f"production lot will be created with zero cost estimate"
                    )
                    # This is a warning but not a hard error - lot can still be created
            except Exception as e:
                logger.warning(f"Error checking pricing for process {process_id}: {e}")
                # Don't add error - pricing check is informational only
    except Exception as e:
        logger.error(f"Unexpected error during production lot validation: {e}")
        errors.append(f"Validation error: {str(e)}")

    return errors


def validate_alert_acknowledgment(
    alert_id: int, user_action: str, action_notes: Optional[str]
) -> List[str]:
    """Validate user decision for an alert acknowledgment."""
    errors: List[str] = []
    logger = _get_logger()

    valid_actions = {"PROCEED", "DELAY", "SUBSTITUTE", "PARTIAL_FULFILL"}
    if user_action not in valid_actions:
        errors.append(
            "user_action must be one of PROCEED, DELAY, SUBSTITUTE, PARTIAL_FULFILL"
        )

    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        conn,
        cur,
    ):
        cur.execute(
            "SELECT user_acknowledged FROM production_lot_inventory_alerts WHERE alert_id = %s",
            (alert_id,),
        )
        row = cur.fetchone()
        if not row:
            errors.append(f"alert_id {alert_id} not found")
        else:
            if row.get("user_acknowledged"):
                errors.append("alert already acknowledged")

    if action_notes is not None and len(str(action_notes)) > 500:
        errors.append("action_notes must be < 500 characters")

    return errors


def validate_procurement_recommendation(rec: Dict[str, Any]) -> List[str]:
    """Validate procurement recommendation fields."""
    errors: List[str] = []
    logger = _get_logger()

    qty = int(rec.get("recommended_quantity", 0) or 0)
    if qty <= 0:
        errors.append("recommended_quantity must be > 0")

    rdate = rec.get("required_delivery_date")
    if not isinstance(rdate, date):
        errors.append("required_delivery_date must be a date")

    variant_id = rec.get("variant_id")
    supplier_id = rec.get("supplier_id")

    with database.get_conn() as (conn, cur):
        cur.execute("SELECT 1 FROM item_variant WHERE variant_id = %s", (variant_id,))
        if not cur.fetchone():
            errors.append(f"variant_id {variant_id} not found")
        if supplier_id is not None:
            cur.execute(
                "SELECT 1 FROM suppliers WHERE supplier_id = %s", (supplier_id,)
            )
            if not cur.fetchone():
                errors.append(f"supplier_id {supplier_id} not found")

    est = rec.get("estimated_cost")
    if est is not None:
        try:
            cost_val = float(est)
            if cost_val < 0:
                errors.append("estimated_cost must be non-negative")
        except Exception:
            errors.append("estimated_cost must be a number")

    return errors


def validate_variant_selection(
    lot_id: int, 
    substitute_group_id: Optional[int],
    variant_id: int,
    selected_cost: Optional[float] = None,
) -> List[str]:
    """Validate a variant selection for a production lot.
    
    NEW VALIDATION - checks:
    - Variant exists and is valid
    - Substitute group exists (if provided)
    - Cost is non-negative (warns if zero)
    - Variant is actually in the substitute group (if applicable)
    """
    errors: List[str] = []
    logger = _get_logger()

    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        conn,
        cur,
    ):
        # Check variant exists
        cur.execute(
            "SELECT variant_id FROM item_variant WHERE variant_id = %s",
            (variant_id,),
        )
        if not cur.fetchone():
            errors.append(f"Variant {variant_id} not found")
            return errors

        # Check substitute group exists (if provided)
        if substitute_group_id:
            cur.execute(
                "SELECT id FROM substitute_groups WHERE id = %s",
                (substitute_group_id,),
            )
            if not cur.fetchone():
                errors.append(f"Substitute group {substitute_group_id} not found")
                return errors

            # Verify variant is actually in this substitute group
            cur.execute(
                """
                SELECT 1 FROM variant_usage 
                WHERE substitute_group_id = %s AND variant_id = %s
                """,
                (substitute_group_id, variant_id),
            )
            if not cur.fetchone():
                errors.append(
                    f"Variant {variant_id} not in substitute group {substitute_group_id}"
                )

    # Check cost is non-negative
    if selected_cost is not None:
        try:
            cost_val = float(selected_cost)
            if cost_val < 0:
                errors.append("Selected cost cannot be negative")
            elif cost_val == 0:
                logger.warning(
                    f"Zero cost selected for variant {variant_id} in lot {lot_id}; "
                    f"this may indicate missing supplier pricing"
                )
        except (TypeError, ValueError):
            errors.append("Selected cost must be numeric")

    return errors


def validate_lot_status_transition(
    lot_id: int, current_status: str, new_status: str
) -> List[str]:
    """Validate status transition for a production lot.
    
    NEW VALIDATION - enforces valid transitions:
    - Planning -> Ready (all selections complete)
    - Ready -> In Progress (execution starts)
    - In Progress -> Completed/Failed (execution ends)
    - Any -> Cancelled (user cancellation)
    """
    errors: List[str] = []
    logger = _get_logger()

    valid_transitions = {
        "Planning": ["Ready", "Cancelled"],
        "Ready": ["In Progress", "Planning", "Cancelled"],
        "In Progress": ["Completed", "Failed", "Cancelled"],
        "Completed": ["Cancelled"],
        "Failed": ["Cancelled", "Planning"],
        "Cancelled": [],
        "PENDING_PROCUREMENT": ["Ready", "Cancelled"],
        "PARTIAL_FULFILLMENT_REQUIRED": ["In Progress", "Cancelled"],
    }

    if current_status not in valid_transitions:
        errors.append(f"Unknown current status: {current_status}")
        return errors

    if new_status not in valid_transitions[current_status]:
        valid = valid_transitions[current_status]
        errors.append(
            f"Invalid transition from {current_status} to {new_status}. Valid transitions: {valid}"
        )

    # Additional validation for transitions to Ready
    if new_status == "Ready":
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            # Get process for this lot
            cur.execute(
                """
                SELECT process_id FROM production_lots WHERE id = %s
                """,
                (lot_id,),
            )
            lot = cur.fetchone()
            if not lot:
                errors.append(f"Production lot {lot_id} not found")
                return errors

            process_id = lot["process_id"]

            # Count substitute groups needing selection
            cur.execute(
                """
                SELECT COUNT(DISTINCT sg.id) as groups_needing_selection
                FROM process_subprocesses ps
                JOIN substitute_groups sg ON sg.process_subprocess_id = ps.id
                WHERE ps.process_id = %s
                  AND sg.id NOT IN (
                      SELECT substitute_group_id FROM production_lot_variant_selections
                      WHERE production_lot_id = %s
                  )
                """,
                (process_id, lot_id),
            )
            result = cur.fetchone()
            missing_selections = result.get("groups_needing_selection", 0) if result else 0

            if missing_selections > 0:
                errors.append(
                    f"Cannot transition to Ready: {missing_selections} substitute group(s) still need variant selection"
                )
                logger.warning(f"Lot {lot_id} has {missing_selections} incomplete selections")

    return errors


def validate_alert_acknowledgment(
    alert_id: int, user_action: str, action_notes: Optional[str]
) -> List[str]:
    """Validate user decision for an alert acknowledgment."""
    errors: List[str] = []
    valid_actions = {"PROCEED", "DELAY", "SUBSTITUTE", "PARTIAL_FULFILL"}
    if user_action not in valid_actions:
        errors.append(
            "user_action must be one of PROCEED, DELAY, SUBSTITUTE, PARTIAL_FULFILL"
        )

    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        conn,
        cur,
    ):
        cur.execute(
            "SELECT user_acknowledged FROM production_lot_inventory_alerts WHERE alert_id = %s",
            (alert_id,),
        )
        row = cur.fetchone()
        if not row:
            errors.append(f"alert_id {alert_id} not found")
        else:
            if row.get("user_acknowledged"):
                errors.append("alert already acknowledged")

    if action_notes is not None and len(str(action_notes)) > 500:
        errors.append("action_notes must be < 500 characters")

    return errors


def validate_procurement_recommendation(rec: Dict[str, Any]) -> List[str]:
    """Validate procurement recommendation fields."""
    errors: List[str] = []

    qty = int(rec.get("recommended_quantity", 0) or 0)
    if qty <= 0:
        errors.append("recommended_quantity must be > 0")

    rdate = rec.get("required_delivery_date")
    if not isinstance(rdate, date):
        errors.append("required_delivery_date must be a date")

    variant_id = rec.get("variant_id")
    supplier_id = rec.get("supplier_id")

    with database.get_conn() as (conn, cur):
        cur.execute("SELECT 1 FROM item_variant WHERE variant_id = %s", (variant_id,))
        if not cur.fetchone():
            errors.append(f"variant_id {variant_id} not found")
        if supplier_id is not None:
            cur.execute(
                "SELECT 1 FROM suppliers WHERE supplier_id = %s", (supplier_id,)
            )
            if not cur.fetchone():
                errors.append(f"supplier_id {supplier_id} not found")

    est = rec.get("estimated_cost")
    if est is not None:
        try:
            if float(est) <= 0:
                errors.append("estimated_cost must be positive")
        except Exception:
            errors.append("estimated_cost must be a number")

    return errors
