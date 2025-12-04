"""
Production Lot Subprocess Management Utilities

Handles subprocess tracking and linkage with production lots.
Ensures all required subprocesses are tracked and status transitions are properly managed.
"""

from __future__ import annotations

from typing import List, Dict, Any, Optional
from datetime import datetime

import database
import psycopg2.extras
from flask import current_app


def link_subprocesses_to_production_lot(
    production_lot_id: int, process_id: int
) -> List[int]:
    """
    Link all subprocesses from a process to a production lot.

    This should be called immediately after lot creation to establish
    the subprocess tracking relationships.

    Args:
        production_lot_id: The newly created production lot
        process_id: The process whose subprocesses to link

    Returns:
        List of created production_lot_subprocess IDs

    Raises:
        ValueError: If subprocess linking fails
    """
    logger = current_app.logger if current_app else None

    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        conn,
        cur,
    ):
        try:
            # Get all subprocesses for this process
            cur.execute(
                """
                SELECT id FROM process_subprocesses
                WHERE process_id = %s
                ORDER BY id
                """,
                (process_id,),
            )

            subprocesses = cur.fetchall()

            if not subprocesses:
                msg = f"No subprocesses found for process {process_id}"
                if logger:
                    logger.warning(msg)
                return []

            # Create subprocess-lot links
            created_ids = []

            for subprocess_row in subprocesses:
                process_subprocess_id = subprocess_row["id"]

                # Insert into production_lot_subprocesses
                cur.execute(
                    """
                    INSERT INTO production_lot_subprocesses (
                        production_lot_id, process_subprocess_id, status
                    ) VALUES (%s, %s, %s)
                    ON CONFLICT (production_lot_id, process_subprocess_id)
                    DO UPDATE SET updated_at = CURRENT_TIMESTAMP
                    RETURNING id
                    """,
                    (production_lot_id, process_subprocess_id, "Planning"),
                )

                row = cur.fetchone()
                if row:
                    created_ids.append(row["id"])

            conn.commit()

            if logger:
                logger.info(
                    f"Linked {len(created_ids)} subprocesses to lot {production_lot_id}"
                )

            return created_ids

        except Exception as e:
            conn.rollback()
            msg = f"Error linking subprocesses to lot {production_lot_id}: {str(e)}"
            if logger:
                logger.error(msg)
            raise ValueError(msg)


def get_production_lot_subprocesses(
    production_lot_id: int,
) -> List[Dict[str, Any]]:
    """
    Get all subprocesses for a production lot.

    Args:
        production_lot_id: The production lot ID

    Returns:
        List of subprocess records with status information
    """
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        conn,
        cur,
    ):
        cur.execute(
            """
            SELECT
                pls.id,
                pls.production_lot_id,
                pls.process_subprocess_id,
                pls.status,
                pls.started_at,
                pls.completed_at,
                pls.notes,
                pls.created_at,
                pls.updated_at,
                ps.subprocess_id,
                s.name as subprocess_name
            FROM production_lot_subprocesses pls
            JOIN process_subprocesses ps ON ps.id = pls.process_subprocess_id
            JOIN subprocesses s ON s.id = ps.subprocess_id
            WHERE pls.production_lot_id = %s
            ORDER BY ps.id
            """,
            (production_lot_id,),
        )

        return [dict(row) for row in cur.fetchall()]


def update_subprocess_status(
    production_lot_subprocess_id: int, new_status: str, notes: Optional[str] = None
) -> bool:
    """
    Update the status of a subprocess execution within a lot.

    Valid statuses:
    - Planning: Initial state
    - In Progress: Subprocess execution started
    - Completed: Subprocess execution finished successfully
    - Failed: Subprocess execution failed
    - Skipped: Subprocess skipped (e.g., no variants selected)

    Args:
        production_lot_subprocess_id: The production_lot_subprocesses ID
        new_status: New status value
        notes: Optional notes about the status change

    Returns:
        True if updated successfully

    Raises:
        ValueError: If status update fails
    """
    valid_statuses = {"Planning", "In Progress", "Completed", "Failed", "Skipped"}

    if new_status not in valid_statuses:
        raise ValueError(f"Invalid status: {new_status}. Valid: {valid_statuses}")

    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        conn,
        cur,
    ):
        try:
            # Determine started_at and completed_at based on status
            started_at = None
            completed_at = None

            if new_status == "In Progress":
                started_at = datetime.now()
            elif new_status in ("Completed", "Failed"):
                completed_at = datetime.now()

            cur.execute(
                """
                UPDATE production_lot_subprocesses
                SET status = %s,
                    started_at = COALESCE(started_at, %s),
                    completed_at = %s,
                    notes = COALESCE(notes, %s),
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = %s
                RETURNING id
                """,
                (new_status, started_at, completed_at, notes, production_lot_subprocess_id),
            )

            result = cur.fetchone()
            conn.commit()

            return result is not None

        except Exception as e:
            conn.rollback()
            raise ValueError(f"Error updating subprocess status: {str(e)}")


def get_lot_subprocess_status_summary(
    production_lot_id: int,
) -> Dict[str, Any]:
    """
    Get a summary of subprocess execution status for a lot.

    Returns count and breakdown of subprocesses by status, plus overall completion percentage.

    Args:
        production_lot_id: The production lot ID

    Returns:
        Summary dict with status counts and completion info
    """
    subprocesses = get_production_lot_subprocesses(production_lot_id)

    if not subprocesses:
        return {
            "total": 0,
            "by_status": {},
            "completion_percentage": 0,
            "all_completed": False,
        }

    status_counts = {}
    for sp in subprocesses:
        status = sp["status"]
        status_counts[status] = status_counts.get(status, 0) + 1

    total = len(subprocesses)
    completed = status_counts.get("Completed", 0)
    completion_percentage = (completed / total * 100) if total > 0 else 0

    return {
        "total": total,
        "by_status": status_counts,
        "completion_percentage": completion_percentage,
        "all_completed": completed == total,
        "any_failed": status_counts.get("Failed", 0) > 0,
    }


def validate_lot_subprocess_readiness(production_lot_id: int) -> tuple[bool, List[str]]:
    """
    Validate that all subprocesses for a lot have been properly configured.

    Args:
        production_lot_id: The production lot ID

    Returns:
        Tuple of (is_ready, list_of_issues)
    """
    issues: List[str] = []

    subprocesses = get_production_lot_subprocesses(production_lot_id)

    if not subprocesses:
        issues.append("No subprocesses configured for this lot")
        return False, issues

    # Check that each subprocess has required information
    for sp in subprocesses:
        if not sp["subprocess_name"]:
            issues.append(f"Subprocess {sp['process_subprocess_id']} has no name")

        if sp["status"] not in ("Planning", "In Progress", "Completed", "Failed", "Skipped"):
            issues.append(f"Subprocess {sp['process_subprocess_id']} has invalid status")

    return len(issues) == 0, issues
