"""Reports API Blueprint for Universal Process Framework

Implements business intelligence endpoints:
- GET /api/upf/reports/metrics
- GET /api/upf/reports/top-processes
- GET /api/upf/reports/process-status
- GET /api/upf/reports/subprocess-usage

Each endpoint returns real aggregated data (where possible) with
standardized APIResponse wrappers and @login_required protection.

If historical comparison ("change" metrics) cannot be derived due to
absent timestamp columns or insufficient data, we safely return 0.

NOTE: Adjust table/column names if schema differs. This code assumes:
- processes table: id, name, worst_case_cost, status, deleted_at, created_at
- production_lots table: id, process_id, status, created_at
- process_subprocesses table: id, process_id, subprocess_id, deleted_at
- subprocesses table: id, name, deleted_at
- variant_usage table for usage metrics (optional for future expansion)

Change metrics logic is defensive: attempts month-over-month comparison
using created_at ranges. If created_at missing or counts zero, returns 0.
"""
from __future__ import annotations

from flask import Blueprint, current_app
from flask_login import login_required, current_user
from psycopg2.extras import RealDictCursor

from app.utils.response import APIResponse
from database import get_conn

reports_api_bp = Blueprint("reports_api", __name__)

# Helper utilities ---------------------------------------------------------

def _safe_pct_change(current: int | float, previous: int | float) -> float:
    """Compute percentage change, guarding division by zero.
    Returns 0.0 if previous is 0 or None.
    """
    try:
        if previous in (None, 0):
            return 0.0
        return round(((current - previous) / previous) * 100.0, 2)
    except Exception:
        return 0.0


def _coalesce_number(value, cast=float, default=0):
    try:
        if value is None:
            return default
        return cast(value)
    except Exception:
        return default

# Endpoints ----------------------------------------------------------------

@reports_api_bp.route("/reports/metrics", methods=["GET"])
@login_required
def get_upf_metrics():
    """Return aggregated high-level UPF metrics.
    Response fields (frontend contract):
    - total_processes, total_lots, avg_cost, completed_lots
    - processes_change, lots_change, cost_change, completed_change
    """
    try:
        with get_conn(cursor_factory=RealDictCursor) as (conn, cur):
            # Core current period metrics (non-deleted processes; lots overall)
            cur.execute(
                """
                SELECT
                    COUNT(*) FILTER (WHERE p.deleted_at IS NULL) AS total_processes,
                    AVG(p.worst_case_cost) FILTER (WHERE p.deleted_at IS NULL) AS avg_cost,
                    COUNT(pl.id) AS total_lots,
                    COUNT(pl.id) FILTER (WHERE pl.status = 'completed') AS completed_lots
                FROM processes p
                LEFT JOIN production_lots pl ON pl.process_id = p.id;
                """
            )
            metrics = cur.fetchone() or {}

            # Month-over-month snapshot comparisons (last 30 vs previous 30 days)
            # If created_at doesn't exist or yields nulls, fall back to zeros.
            change_data = {
                "processes_change": 0.0,
                "lots_change": 0.0,
                "cost_change": 0.0,
                "completed_change": 0.0,
            }
            try:
                cur.execute(
                    """
                    SELECT
                        COUNT(*) FILTER (WHERE p.deleted_at IS NULL AND p.created_at >= NOW() - INTERVAL '30 days') AS proc_recent,
                        COUNT(*) FILTER (WHERE p.deleted_at IS NULL AND p.created_at < NOW() - INTERVAL '30 days' AND p.created_at >= NOW() - INTERVAL '60 days') AS proc_prev,
                        AVG(p.worst_case_cost) FILTER (WHERE p.deleted_at IS NULL AND p.created_at >= NOW() - INTERVAL '30 days') AS cost_recent,
                        AVG(p.worst_case_cost) FILTER (WHERE p.deleted_at IS NULL AND p.created_at < NOW() - INTERVAL '30 days' AND p.created_at >= NOW() - INTERVAL '60 days') AS cost_prev
                    FROM processes p;
                    """
                )
                proc_change = cur.fetchone() or {}

                cur.execute(
                    """
                    SELECT
                        COUNT(pl.id) FILTER (WHERE pl.created_at >= NOW() - INTERVAL '30 days') AS lots_recent,
                        COUNT(pl.id) FILTER (WHERE pl.created_at < NOW() - INTERVAL '30 days' AND pl.created_at >= NOW() - INTERVAL '60 days') AS lots_prev,
                        COUNT(pl.id) FILTER (WHERE pl.status='completed' AND pl.created_at >= NOW() - INTERVAL '30 days') AS completed_recent,
                        COUNT(pl.id) FILTER (WHERE pl.status='completed' AND pl.created_at < NOW() - INTERVAL '30 days' AND pl.created_at >= NOW() - INTERVAL '60 days') AS completed_prev
                    FROM production_lots pl;
                    """
                )
                lot_change = cur.fetchone() or {}

                change_data = {
                    "processes_change": _safe_pct_change(
                        _coalesce_number(proc_change.get("proc_recent"), int, 0),
                        _coalesce_number(proc_change.get("proc_prev"), int, 0),
                    ),
                    "lots_change": _safe_pct_change(
                        _coalesce_number(lot_change.get("lots_recent"), int, 0),
                        _coalesce_number(lot_change.get("lots_prev"), int, 0),
                    ),
                    "cost_change": _safe_pct_change(
                        _coalesce_number(proc_change.get("cost_recent"), float, 0.0),
                        _coalesce_number(proc_change.get("cost_prev"), float, 0.0),
                    ),
                    "completed_change": _safe_pct_change(
                        _coalesce_number(lot_change.get("completed_recent"), int, 0),
                        _coalesce_number(lot_change.get("completed_prev"), int, 0),
                    ),
                }
            except Exception as e:
                current_app.logger.warning(
                    f"[REPORTS] Change metric calculation failed; defaulting to 0: {e}"
                )

        response = {
            "total_processes": _coalesce_number(metrics.get("total_processes"), int, 0),
            "total_lots": _coalesce_number(metrics.get("total_lots"), int, 0),
            "avg_cost": _coalesce_number(metrics.get("avg_cost"), float, 0.0),
            "completed_lots": _coalesce_number(metrics.get("completed_lots"), int, 0),
            **change_data,
        }
        return APIResponse.success(response)
    except Exception as e:
        current_app.logger.error(f"[REPORTS] Error in metrics endpoint: {e}", exc_info=True)
        return APIResponse.error("internal_error", "Failed to compute metrics", 500)


@reports_api_bp.route("/reports/top-processes", methods=["GET"])
@login_required
def get_top_processes():
    """Return top 5 processes by worst_case_cost.
    Response: {"processes": [{"name": str, "worst_case_cost": float}, ...]}
    """
    try:
        with get_conn(cursor_factory=RealDictCursor) as (conn, cur):
            cur.execute(
                """
                SELECT name, worst_case_cost
                FROM processes
                WHERE deleted_at IS NULL
                ORDER BY worst_case_cost DESC NULLS LAST
                LIMIT 5;
                """
            )
            rows = cur.fetchall() or []
        processes = [
            {
                "name": r.get("name"),
                "worst_case_cost": _coalesce_number(r.get("worst_case_cost"), float, 0.0),
            }
            for r in rows
        ]
        return APIResponse.success({"processes": processes})
    except Exception as e:
        current_app.logger.error(f"[REPORTS] Error in top-processes: {e}", exc_info=True)
        return APIResponse.error("internal_error", "Failed to load top processes", 500)


@reports_api_bp.route("/reports/process-status", methods=["GET"])
@login_required
def get_process_status():
    """Return counts of processes grouped by status.
    Response: {"active": int, "inactive": int, "draft": int}
    Missing statuses default to 0. If schema uses different status values,
    adapt mapping accordingly; we log unmapped statuses.
    """
    try:
        with get_conn(cursor_factory=RealDictCursor) as (conn, cur):
            cur.execute(
                """
                SELECT status, COUNT(*) AS count
                FROM processes
                WHERE deleted_at IS NULL
                GROUP BY status;
                """
            )
            rows = cur.fetchall() or []
        # Normalize known statuses; anything else logged and ignored.
        normalized = {"active": 0, "inactive": 0, "draft": 0}
        for r in rows:
            status = (r.get("status") or "").lower()
            count = _coalesce_number(r.get("count"), int, 0)
            if status in normalized:
                normalized[status] = count
            else:
                current_app.logger.debug(
                    f"[REPORTS] Unrecognized process status '{status}' encountered"
                )
        return APIResponse.success(normalized)
    except Exception as e:
        current_app.logger.error(f"[REPORTS] Error in process-status: {e}", exc_info=True)
        return APIResponse.error("internal_error", "Failed to compute process status", 500)


@reports_api_bp.route("/reports/subprocess-usage", methods=["GET"])
@login_required
def get_subprocess_usage():
    """Return top 5 subprocesses by usage frequency in process_subprocesses.
    Response: {"subprocesses": [{"name": str, "usage_count": int}, ...]}
    """
    try:
        with get_conn(cursor_factory=RealDictCursor) as (conn, cur):
            cur.execute(
                """
                SELECT s.name AS name, COUNT(ps.id) AS usage_count
                FROM subprocesses s
                LEFT JOIN process_subprocesses ps ON ps.subprocess_id = s.id
                WHERE s.deleted_at IS NULL
                GROUP BY s.id, s.name
                ORDER BY usage_count DESC
                LIMIT 5;
                """
            )
            rows = cur.fetchall() or []
        subprocesses = [
            {
                "name": r.get("name"),
                "usage_count": _coalesce_number(r.get("usage_count"), int, 0),
            }
            for r in rows
        ]
        return APIResponse.success({"subprocesses": subprocesses})
    except Exception as e:
        current_app.logger.error(f"[REPORTS] Error in subprocess-usage: {e}", exc_info=True)
        return APIResponse.error("internal_error", "Failed to compute subprocess usage", 500)


# Optional future endpoint examples (commented for clarity)
# @reports_api_bp.route('/reports/variant-usage', methods=['GET'])
# @login_required
# def get_variant_usage():
#     """Potential expansion: variant usage stats."""
#     pass

__all__ = [
    "reports_api_bp",
]  # Allow explicit import in app factory
