"""
Production Lot Utilities - Cost validation, logging, and helpers.

Provides reusable functions for production lot operations including:
- Cost breakdown validation
- Cost calculation logging and debugging
- Null/zero cost detection
- Status transition validation
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Tuple

from flask import current_app


def get_logger() -> logging.Logger:
    """Get Flask application logger with proper context."""
    try:
        return current_app.logger
    except (RuntimeError, AttributeError):
        return logging.getLogger("production_lot")


def validate_cost_breakdown(
    breakdown: Dict[str, Any], context: str = ""
) -> Tuple[bool, List[str]]:
    """
    Validate a cost breakdown dictionary structure and values.

    Args:
        breakdown: Cost breakdown dict from CostingService
        context: Additional context for logging (e.g., "subprocess_123")

    Returns:
        Tuple of (is_valid, list_of_warnings)
    """
    warnings: List[str] = []
    logger = get_logger()

    if not breakdown or not isinstance(breakdown, dict):
        msg = f"Invalid cost breakdown structure {context}; got {type(breakdown)}"
        logger.error(msg)
        warnings.append(msg)
        return False, warnings

    # Check required keys
    if "totals" not in breakdown:
        warnings.append(f"Missing 'totals' key in cost breakdown {context}")
    else:
        totals = breakdown["totals"]
        grand_total = totals.get("grand_total", 0)

        # Warn if grand_total is zero (may be legitimate but worth logging)
        if grand_total == 0:
            msg = f"Zero grand_total calculated for {context}"
            logger.warning(msg)
            warnings.append(msg)

        # Validate numeric types
        for key in ["subprocesses", "additional_costs", "grand_total"]:
            val = totals.get(key)
            if val is not None:
                try:
                    float(val)
                except (TypeError, ValueError):
                    warnings.append(
                        f"Non-numeric value for totals.{key} in {context}: {val}"
                    )

    # Check for suspicious patterns
    if "subprocesses" in breakdown:
        for i, sp in enumerate(breakdown.get("subprocesses", [])):
            sp_total = sp.get("total_cost", 0)
            if sp_total == 0:
                logger.warning(
                    f"Zero subprocess cost for {context} at index {i}; subprocess_id={sp.get('subprocess_id')}"
                )

    return len(warnings) == 0, warnings


def validate_cost_calculation(
    process_id: int,
    quantity: int,
    cost_breakdown: Dict[str, Any],
) -> Tuple[bool, Optional[float], List[str]]:
    """
    Validate a complete production lot cost calculation.

    Args:
        process_id: The process ID
        quantity: The lot quantity
        cost_breakdown: Cost breakdown from CostingService

    Returns:
        Tuple of (is_valid, calculated_total_cost, list_of_issues)
    """
    issues: List[str] = []
    logger = get_logger()

    # Validate breakdown structure
    is_valid, breakdown_warnings = validate_cost_breakdown(
        cost_breakdown, f"process_{process_id}"
    )
    issues.extend(breakdown_warnings)

    # Calculate expected total
    try:
        per_unit_cost = float(cost_breakdown.get("totals", {}).get("grand_total", 0))
        total_cost = per_unit_cost * quantity

        if total_cost == 0:
            msg = f"Zero total cost for process {process_id}, quantity {quantity}"
            logger.warning(msg)
            issues.append(msg)
        elif per_unit_cost == 0:
            msg = f"Per-unit cost is zero for process {process_id}"
            logger.warning(msg)
            issues.append(msg)

        logger.debug(
            f"Validated cost for process {process_id}: per_unit={per_unit_cost}, qty={quantity}, total={total_cost}"
        )

        return is_valid, total_cost, issues

    except Exception as e:
        msg = f"Error validating cost calculation for process {process_id}: {str(e)}"
        logger.error(msg)
        issues.append(msg)
        return False, None, issues


def log_zero_cost_analysis(
    variant_id: Optional[int] = None,
    subprocess_id: Optional[int] = None,
    supplier_pricing_exists: bool = False,
) -> None:
    """
    Log analysis when zero-cost scenario detected.

    Args:
        variant_id: The variant with zero cost (if applicable)
        subprocess_id: The subprocess with zero cost (if applicable)
        supplier_pricing_exists: Whether pricing table exists
    """
    logger = get_logger()

    if variant_id:
        logger.warning(
            f"Zero cost calculated for variant {variant_id}; "
            f"supplier_pricing_table_exists={supplier_pricing_exists}"
        )
    if subprocess_id:
        logger.warning(
            f"Zero cost calculated for subprocess {subprocess_id}; "
            f"check if all variants have supplier pricing"
        )


def validate_status_transition(
    current_status: str, new_status: str
) -> Tuple[bool, Optional[str]]:
    """
    Validate production lot status transitions.

    Valid transitions:
    - Planning -> Ready (all selections made)
    - Ready -> In Progress (execution started)
    - In Progress -> Completed (execution finished)
    - In Progress -> Failed (execution error)
    - Any -> Cancelled (user cancellation)

    Args:
        current_status: Current lot status
        new_status: Desired new status

    Returns:
        Tuple of (is_valid, error_message)
    """
    valid_transitions = {
        "Planning": ["Ready", "Cancelled"],
        "Ready": ["In Progress", "Planning", "Cancelled"],
        "In Progress": ["Completed", "Failed", "Cancelled"],
        "Completed": ["Cancelled"],
        "Failed": ["Cancelled", "Planning"],
        "Cancelled": [],
        "PENDING_PROCUREMENT": ["Planning", "Ready", "Cancelled"],
        "PARTIAL_FULFILLMENT_REQUIRED": ["Ready", "In Progress", "Cancelled"],
    }

    if current_status not in valid_transitions:
        return False, f"Unknown current status: {current_status}"

    if new_status not in valid_transitions.get(current_status, []):
        valid = valid_transitions.get(current_status, [])
        return False, f"Cannot transition from {current_status} to {new_status}. Valid: {valid}"

    return True, None


def validate_subprocess_selection(
    lot_id: int, process_id: int, selected_subprocesses: List[int]
) -> Tuple[bool, List[str]]:
    """
    Validate that required subprocesses have been selected for a lot.

    Args:
        lot_id: The production lot ID
        process_id: The process ID
        selected_subprocesses: List of selected subprocess IDs

    Returns:
        Tuple of (is_valid, list_of_errors)
    """
    import database
    import psycopg2.extras

    errors: List[str] = []
    logger = get_logger()

    try:
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            # Get all required subprocesses for this process
            cur.execute(
                """
                SELECT id, subprocess_id FROM process_subprocesses
                WHERE process_id = %s
                ORDER BY id
            """,
                (process_id,),
            )
            required = cur.fetchall()

            if not required:
                msg = f"Process {process_id} has no subprocesses"
                logger.warning(msg)
                errors.append(msg)
                return False, errors

            # Check that all required subprocesses are selected
            required_ids = {row["subprocess_id"] for row in required}
            selected_ids = set(selected_subprocesses or [])

            missing = required_ids - selected_ids
            if missing:
                msg = f"Lot {lot_id} missing subprocess selections: {missing}"
                logger.warning(msg)
                errors.append(msg)

            # Also check for extra (invalid) selections
            extra = selected_ids - required_ids
            if extra:
                msg = f"Lot {lot_id} has invalid subprocess selections: {extra}"
                logger.warning(msg)
                errors.append(msg)

            return len(errors) == 0, errors

    except Exception as e:
        msg = f"Error validating subprocess selection for lot {lot_id}: {str(e)}"
        logger.error(msg)
        errors.append(msg)
        return False, errors


def log_production_lot_creation(
    lot_id: int,
    lot_number: str,
    process_id: int,
    quantity: int,
    total_cost: float,
    status: str,
) -> None:
    """Log production lot creation with context."""
    logger = get_logger()
    logger.info(
        f"Production lot created: id={lot_id}, lot_number={lot_number}, "
        f"process_id={process_id}, quantity={quantity}, total_cost={total_cost}, status={status}"
    )


def log_variant_selection(
    lot_id: int,
    substitute_group_id: Optional[int],
    variant_id: int,
    selected_cost: Optional[float],
    supplier_id: Optional[int] = None,
) -> None:
    """Log variant selection for production lot."""
    logger = get_logger()
    logger.debug(
        f"Variant selected for lot {lot_id}: group={substitute_group_id}, "
        f"variant={variant_id}, cost={selected_cost}, supplier={supplier_id}"
    )


def coerce_numeric(value: Any, default: float = 0.0, context: str = "") -> float:
    """
    Safely coerce a value to float with logging.

    Args:
        value: Value to coerce
        default: Default if conversion fails
        context: Context string for logging

    Returns:
        Numeric value or default
    """
    if value is None:
        return default

    try:
        return float(value)
    except (TypeError, ValueError):
        logger = get_logger()
        logger.warning(f"Failed to coerce {value} to float {context}; using {default}")
        return default
