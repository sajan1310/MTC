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


MAX_LOT_QUANTITY = 1_000_000


def validate_production_lot_creation(
    process_id: int, quantity: int, user_id: int
) -> List[str]:
    """Validate inputs before creating a production lot.

    Returns a list of human-readable error strings. Empty if valid.
    """
    errors: List[str] = []
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        conn,
        cur,
    ):
        # Helper: detect if a column exists on the connected DB/schema
        def _column_exists(table: str, column: str) -> bool:
            cur.execute(
                """
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema() AND table_name = %s AND column_name = %s
                """,
                (table, column),
            )
            return bool(cur.fetchone())

        # Detect whether soft-delete column exists for processes and process_subprocesses
        processes_has_deleted = _column_exists("processes", "deleted_at")
        subprocesses_has_deleted = _column_exists(
            "process_subprocesses", "deleted_at"
        )

        # 1) process exists and is active/draft
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
        cur.execute("SELECT 1 FROM users WHERE user_id = %s", (user_id,))
        if not cur.fetchone():
            errors.append(f"user_id {user_id} not found")

        # 4) process has at least 1 subprocess
        if subprocesses_has_deleted:
            cur.execute(
                """
                SELECT 1
                FROM process_subprocesses
                WHERE process_id = %s AND deleted_at IS NULL
                LIMIT 1
                """,
                (process_id,),
            )
        else:
            cur.execute(
                """
                SELECT 1
                FROM process_subprocesses
                WHERE process_id = %s
                LIMIT 1
                """,
                (process_id,),
            )
        if not cur.fetchone():
            errors.append(
                f"Process {process_id} has no subprocesses; cannot create lot"
            )

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
