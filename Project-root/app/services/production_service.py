"""
Production Service for Universal Process Framework.

Handles production lot creation, variant selection, execution, and inventory integration.
This is where the OR/Substitute feature comes to life - users select specific variants
from each substitute group, and the system tracks actual costs vs. estimates.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import database
import psycopg2.extras
from flask import current_app

from ..models.production_lot import (
    ProductionLot,
    ProductionLotSelection,
    generate_lot_number,
)
from .costing_service import CostingService


class ProductionService:
    """
    Service for production lot management and execution.
    """

    @staticmethod
    def create_production_lot(
        process_id: int,
        user_id: int,
        quantity: int = 1,
        lot_number: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Create a new production lot from a process.

        Args:
            process_id: The process to execute
            user_id: User creating the lot
            quantity: Number of units to produce
            lot_number: Optional custom lot number (auto-generated if not provided)

        Returns:
            Created production lot with initial cost estimate
        """
        if not lot_number:
            lot_number = generate_lot_number()

        # Calculate worst-case estimated cost
        cost_breakdown = CostingService.calculate_process_total_cost(process_id)
        worst_case_cost = cost_breakdown["totals"]["grand_total"] * quantity

        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            cur.execute(
                """
                INSERT INTO production_lots (
                    process_id, lot_number, created_by, quantity,
                    total_cost, status
                ) VALUES (%s, %s, %s, %s, %s, 'Planning')
                RETURNING *
            """,
                (process_id, lot_number, user_id, quantity, worst_case_cost),
            )

            lot_data = cur.fetchone()
            conn.commit()

        lot = ProductionLot(lot_data)
        # Merge raw DB fields back into result to preserve any extra keys
        result = lot.to_dict()
        for k, v in dict(lot_data).items():
            if k not in result:
                result[k] = v
        # Ensure alias exists if callers expect it
        if "worst_case_estimated_cost" not in result:
            result["worst_case_estimated_cost"] = result.get("total_cost")
        return result

    @staticmethod
    def create_production_lot_with_alerts(
        process_id: int,
        user_id: int,
        quantity: int = 1,
        lot_number: Optional[str] = None,
        description: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Create a production lot and immediately run inventory checks to produce alerts
        and procurement recommendations per UPF plan.
        """
        lot = ProductionService.create_production_lot(
            process_id=process_id,
            user_id=user_id,
            quantity=quantity,
            lot_number=lot_number,
        )
        lot_id = int(lot.get("id") or lot.get("lot_id") or 0)
        # If DB returned id with a different key, normalize
        if not lot_id:
            with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
                conn,
                cur,
            ):
                cur.execute(
                    "SELECT id FROM production_lots WHERE lot_number = %s",
                    (lot.get("lot_number"),),
                )
                row = cur.fetchone()
                lot_id = int(row["id"]) if row else 0

        # Run inventory checks and create alerts
        from .inventory_alert_service import InventoryAlertService

        alerts_list = InventoryAlertService.check_inventory_levels_for_production_lot(
            lot_id
        )
        created_ids = InventoryAlertService.create_production_lot_alerts(
            lot_id, alerts_list
        )
        # Generate recommendations for high/critical
        rec_ids = InventoryAlertService.generate_procurement_recommendations(
            lot_id, alerts_list
        )
        summary = InventoryAlertService.get_production_lot_alert_summary(lot_id)

        # Compose enriched response (additive)
        lot.update(
            {
                "lot_id": lot_id or lot.get("lot_id"),
                "alerts_present": len(created_ids) > 0,
                "alerts_summary": {
                    "total": summary.get("total_alerts", 0),
                    "by_severity": summary.get("alerts_by_severity", {}),
                    "action_required": any(
                        s in ("CRITICAL", "HIGH") and c > 0
                        for s, c in summary.get("alerts_by_severity", {}).items()
                    ),
                },
                "alerts_details": alerts_list[:5],  # preview first 5
                "procurement_recommendations": rec_ids,
            }
        )
        # Derive lot_status from summary for convenience
        lot["lot_status"] = summary.get("lot_status") or lot.get("status")
        return lot

    @staticmethod
    def acknowledge_and_validate_production_lot_alerts(
        production_lot_id: int,
        user_id: int,
        acknowledgments: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """Bulk acknowledge alerts, then recompute lot status."""
        from app.validators.production_lot_validator import (
            validate_alert_acknowledgment,
        )
        from .inventory_alert_service import InventoryAlertService

        # Validate first
        all_errors: List[str] = []
        for ack in acknowledgments:
            errs = validate_alert_acknowledgment(
                int(ack.get("alert_id")),
                str(ack.get("user_action")),
                ack.get("action_notes"),
            )
            all_errors.extend(errs)
        if all_errors:
            return {"error": "validation_error", "details": all_errors}

        with database.get_conn() as (conn, cur):
            try:
                for ack in acknowledgments:
                    cur.execute(
                        """
                        UPDATE production_lot_inventory_alerts
                        SET user_acknowledged = TRUE,
                            acknowledged_at = CURRENT_TIMESTAMP,
                            user_action = %s,
                            action_notes = %s
                        WHERE alert_id = %s AND production_lot_id = %s
                        """,
                        (
                            ack.get("user_action"),
                            ack.get("action_notes"),
                            int(ack.get("alert_id")),
                            production_lot_id,
                        ),
                    )
                conn.commit()
            except Exception:
                conn.rollback()
                raise

        summary = InventoryAlertService.get_production_lot_alert_summary(
            production_lot_id
        )
        # Apply simple transitions based on acknowledgments
        if summary.get("alerts_by_severity", {}).get("CRITICAL", 0) > 0:
            status = "PENDING_PROCUREMENT"
        elif summary.get("alerts_by_severity", {}).get("HIGH", 0) > 0:
            status = "PARTIAL_FULFILLMENT_REQUIRED"
        else:
            status = "READY"

        with database.get_conn() as (conn, cur):
            cur.execute(
                "UPDATE production_lots SET lot_status_inventory = %s WHERE id = %s",
                (status, production_lot_id),
            )
            conn.commit()

        summary["lot_status"] = status
        return summary

    @staticmethod
    def get_production_lot(
        lot_id: int, include_selections: bool = True
    ) -> Optional[Dict[str, Any]]:
        """
        Get production lot with optional selections and cost details.

        Args:
            lot_id: The lot ID
            include_selections: Whether to include variant selections

        Returns:
            Complete lot information or None if not found
        """
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            cur.execute(
                """
                SELECT
                    pl.*,
                    p.name as process_name,
                    p.description as process_description,
                    u.name as created_by_name
                FROM production_lots pl
                JOIN processes p ON p.id = pl.process_id
                LEFT JOIN users u ON u.user_id = pl.created_by
                WHERE pl.id = %s
            """,
                (lot_id,),
            )

            lot_data = cur.fetchone()

            if not lot_data:
                return None

            result = dict(lot_data)
            # Compatibility alias: ensure expected key exists
            if "worst_case_estimated_cost" not in result:
                result["worst_case_estimated_cost"] = result.get("total_cost")

            if include_selections:
                # Get all variant selections (schema differences tolerated)
                result["selections"] = []
                try:
                    cur.execute(
                        """
                        SELECT
                            pls.*,
                            sg.group_name,
                            iv.name as variant_name,
                            s.firm_name as supplier_name
                        FROM production_lot_variant_selections pls
                        JOIN substitute_groups sg ON sg.id = pls.substitute_group_id
                        JOIN item_variant iv ON iv.variant_id = pls.selected_variant_id
                        LEFT JOIN suppliers s ON s.supplier_id = pls.selected_supplier_id
                        WHERE pls.lot_id = %s
                        """,
                        (lot_id,),
                    )
                    result["selections"] = [dict(sel) for sel in cur.fetchall()]
                except Exception:
                    # Fallback: schema may use production_lot_selections or lack substitute_group_id
                    try:
                        cur.execute(
                            """
                            SELECT * FROM production_lot_selections WHERE production_lot_id = %s
                            """,
                            (lot_id,),
                        )
                        result["selections"] = [dict(sel) for sel in cur.fetchall()]
                    except Exception:
                        result["selections"] = []

                # Get actual costing if available
                try:
                    cur.execute(
                        """
                        SELECT
                            plac.*,
                            iv.name as variant_name,
                            s.firm_name as supplier_name
                        FROM production_lot_actual_costing plac
                        JOIN item_variant iv ON iv.variant_id = plac.variant_id
                        LEFT JOIN suppliers s ON s.supplier_id = plac.supplier_id
                        WHERE plac.production_lot_id = %s
                        """,
                        (lot_id,),
                    )
                    result["actual_costing"] = [dict(ac) for ac in cur.fetchall()]
                except Exception:
                    result["actual_costing"] = []

            # Enrich with alert summary + procurement recommendations (plan Phase 3.2)
            try:
                from .inventory_alert_service import (
                    InventoryAlertService,
                    ProcurementRecommendationService,
                )

                summary = InventoryAlertService.get_production_lot_alert_summary(lot_id)
                recs = ProcurementRecommendationService.list_recommendations(
                    production_lot_id=lot_id
                )
                result["alerts_summary"] = {
                    "total_alerts": summary.get("total_alerts", 0),
                    "by_severity": summary.get("alerts_by_severity", {}),
                    "acknowledged_count": summary.get("acknowledged_count", 0),
                }
                result["procurement_recommendations"] = recs
            except Exception:
                # Non-fatal if alert tables not present in some environments
                result.setdefault(
                    "alerts_summary",
                    {"total_alerts": 0, "by_severity": {}, "acknowledged_count": 0},
                )
                result.setdefault("procurement_recommendations", [])

        return result

    @staticmethod
    def list_production_lots(
        process_id: Optional[int] = None,
        user_id: Optional[int] = None,
        status: Optional[str] = None,
        page: int = 1,
        per_page: int = 25,
    ) -> Dict[str, Any]:
        """
        List production lots with filtering and pagination.

        Args:
            process_id: Filter by process
            user_id: Filter by user
            status: Filter by status
            page: Page number
            per_page: Items per page

        Returns:
            Paginated list of lots
        """
        offset = (page - 1) * per_page

        conditions = []
        params = []

        if process_id:
            conditions.append("pl.process_id = %s")
            params.append(process_id)

        if user_id:
            conditions.append("pl.created_by = %s")
            params.append(user_id)

        if status:
            conditions.append("pl.status = %s")
            params.append(status)

        where_clause = "WHERE " + " AND ".join(conditions) if conditions else ""

        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            # Get total count
            cur.execute(
                f"""
                SELECT COUNT(*) as total
                FROM production_lots pl
                {where_clause}
            """,
                params,
            )
            total = cur.fetchone()["total"]

            # Get page of results
            cur.execute(
                f"""
                SELECT
                    pl.*,
                    p.name as process_name,
                    u.name as created_by_name,
                    COUNT(plvs.id) as selections_count
                FROM production_lots pl
                JOIN processes p ON p.id = pl.process_id
                LEFT JOIN users u ON u.user_id = pl.created_by
                LEFT JOIN production_lot_variant_selections plvs ON plvs.lot_id = pl.id
                {where_clause}
                GROUP BY pl.id, p.name, u.name
                ORDER BY pl.created_at DESC
                LIMIT %s OFFSET %s
            """,
                params + [per_page, offset],
            )

            lots = cur.fetchall()

        # [BUG FIX] Return both "production_lots" (for frontend) and "lots" (for legacy)
        # Frontend JavaScript expects response.data.production_lots
        return {
            "production_lots": [dict(lot) for lot in lots],
            "lots": [dict(lot) for lot in lots],  # Legacy compatibility
            "pagination": {
                "page": page,
                "per_page": per_page,
                "total": total,
                "pages": (total + per_page - 1) // per_page,
            },
        }

    @staticmethod
    def select_variant_for_group(
        lot_id: int,
        substitute_group_id: int,
        variant_id: int,
        supplier_id: Optional[int] = None,
        quantity: Optional[float] = None,
    ) -> Dict[str, Any]:
        """
        Select a specific variant from an OR/substitute group for a production lot.

        This is the core OR feature - allowing production-time variant selection.

        Args:
            lot_id: The production lot
            substitute_group_id: The OR group
            variant_id: The chosen variant
            supplier_id: Optional specific supplier
            quantity: Optional quantity (defaults to group quantity)

        Returns:
            Created or updated selection
        """
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            # Get variant cost (use supplier-specific or worst-case)
            if supplier_id:
                cur.execute(
                    """
                    SELECT cost_per_unit
                    FROM variant_supplier_pricing
                    WHERE variant_id = %s AND supplier_id = %s AND is_active = TRUE
                    ORDER BY effective_from DESC
                    LIMIT 1
                """,
                    (variant_id, supplier_id),
                )
                cost_row = cur.fetchone()
                cost = float(cost_row["cost_per_unit"]) if cost_row else None
            else:
                cost_info = CostingService.get_variant_worst_case_cost(variant_id)
                cost = cost_info["worst_case_cost"] if cost_info else None

            # Get default quantity if not provided
            if quantity is None:
                cur.execute(
                    """
                    SELECT vu.quantity
                    FROM variant_usage vu
                    WHERE vu.substitute_group_id = %s
                      AND vu.variant_id = %s
                    LIMIT 1
                """,
                    (substitute_group_id, variant_id),
                )
                qty_row = cur.fetchone()
                quantity = float(qty_row["quantity"]) if qty_row else 1

            # Insert or update selection
            cur.execute(
                """
                INSERT INTO production_lot_variant_selections (
                    production_lot_id, substitute_group_id, selected_variant_id,
                    selected_supplier_id, selected_cost, selected_quantity
                ) VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (production_lot_id, substitute_group_id)
                DO UPDATE SET
                    selected_variant_id = EXCLUDED.selected_variant_id,
                    selected_supplier_id = EXCLUDED.selected_supplier_id,
                    selected_cost = EXCLUDED.selected_cost,
                    selected_quantity = EXCLUDED.selected_quantity,
                    updated_at = CURRENT_TIMESTAMP
                RETURNING *
            """,
                (lot_id, substitute_group_id, variant_id, supplier_id, cost, quantity),
            )

            selection_data = cur.fetchone()
            conn.commit()

        selection = ProductionLotSelection(selection_data)
        return selection.to_dict()

    @staticmethod
    def validate_lot_readiness(lot_id: int) -> Tuple[bool, List[str]]:
        """
        Validate that lot is ready for execution (all OR groups have selections).

        Args:
            lot_id: The production lot

        Returns:
            Tuple of (is_ready, list_of_missing_groups)
        """
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            # Get the process for this lot
            cur.execute(
                """
                SELECT process_id FROM production_lots WHERE id = %s
            """,
                (lot_id,),
            )
            lot = cur.fetchone()

            if not lot:
                return False, ["Lot not found"]

            # Get all substitute groups for this process
            cur.execute(
                """
                SELECT
                    sg.id,
                    sg.group_name
                FROM substitute_groups sg
                JOIN process_subprocesses ps ON ps.id = sg.process_subprocess_id
                WHERE ps.process_id = %s
            """,
                (lot["process_id"],),
            )

            required_groups = cur.fetchall()

            if not required_groups:
                return True, []  # No OR groups, lot is ready

            # Get selections made for this lot
            cur.execute(
                """
                SELECT substitute_group_id
                FROM production_lot_variant_selections
                WHERE lot_id = %s
            """,
                (lot_id,),
            )

            selected_group_ids = {row["substitute_group_id"] for row in cur.fetchall()}

            # Find missing selections
            missing = []
            for group in required_groups:
                if group["id"] not in selected_group_ids:
                    missing.append(group["group_name"])

            return len(missing) == 0, missing

    @staticmethod
    def calculate_lot_actual_cost(lot_id: int) -> float:
        """
        Calculate actual cost based on selected variants.

        Args:
            lot_id: The production lot

        Returns:
            Total actual cost with selections
        """
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            # Get lot details
            cur.execute(
                """
                SELECT pl.*, p.id as process_id
                FROM production_lots pl
                JOIN processes p ON p.id = pl.process_id
                WHERE pl.id = %s
            """,
                (lot_id,),
            )
            lot = cur.fetchone()

            if not lot:
                return 0

            # Get fixed variant costs (not in substitute groups)
            cur.execute(
                """
                SELECT
                    vu.variant_id,
                    vu.quantity
                FROM variant_usage vu
                JOIN process_subprocesses ps ON ps.id = vu.process_subprocess_id
                WHERE ps.process_id = %s
                  AND vu.substitute_group_id IS NULL
            """,
                (lot["process_id"],),
            )

            fixed_variants = cur.fetchall()
            fixed_costs = []

            for variant in fixed_variants:
                cost_info = CostingService.get_variant_worst_case_cost(
                    variant["variant_id"]
                )
                if cost_info:
                    fixed_costs.append(
                        cost_info["worst_case_cost"] * float(variant["quantity"])
                    )

            # Get selected variant costs
            cur.execute(
                """
                SELECT selected_cost, selected_quantity
                FROM production_lot_variant_selections
                WHERE lot_id = %s
            """,
                (lot_id,),
            )

            selections = cur.fetchall()
            selected_costs = [
                float(sel["selected_cost"] or 0) * float(sel["selected_quantity"] or 0)
                for sel in selections
            ]

            # Get cost items and additional costs
            cur.execute(
                """
                SELECT
                    SUM(ci.quantity * ci.amount) as total_cost_items
                FROM cost_items ci
                JOIN process_subprocesses ps ON ps.id = ci.process_subprocess_id
                WHERE ps.process_id = %s
            """,
                (lot["process_id"],),
            )

            cost_items_total = float(cur.fetchone()["total_cost_items"] or 0)

            cur.execute(
                """
                SELECT SUM(amount) as total_additional
                FROM additional_costs
                WHERE process_id = %s
            """,
                (lot["process_id"],),
            )

            additional_total = float(cur.fetchone()["total_additional"] or 0)

            # Calculate total
            total = (
                sum(fixed_costs)
                + sum(selected_costs)
                + cost_items_total
                + additional_total
            ) * lot["quantity"]

            return total

    @staticmethod
    def execute_production_lot(lot_id: int) -> Dict[str, Any]:
        """
        Execute production lot - deduct inventory and record actual costs.

        This is the final step that integrates with the inventory system.

        Args:
            lot_id: The production lot to execute

        Returns:
            Execution summary with inventory deductions
        """
        # Validate lot is ready
        is_ready, missing = ProductionService.validate_lot_readiness(lot_id)
        if not is_ready:
            raise ValueError(
                f"Lot not ready for execution. Missing selections: {', '.join(missing)}"
            )

        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            # Get lot details
            cur.execute(
                """
                SELECT pl.*, p.id as process_id
                FROM production_lots pl
                JOIN processes p ON p.id = pl.process_id
                WHERE pl.id = %s
            """,
                (lot_id,),
            )
            lot = cur.fetchone()

            if not lot:
                raise ValueError("Lot not found")

            if lot["status"] not in ("draft", "ready"):
                raise ValueError(f"Lot cannot be executed from status: {lot['status']}")

            # Calculate actual cost
            actual_cost = ProductionService.calculate_lot_actual_cost(lot_id)

            # Get all variants to deduct (fixed + selected)
            deductions = []

            # Fixed variants
            cur.execute(
                """
                SELECT
                    vu.variant_id,
                    vu.quantity,
                    iv.name as variant_name,
                    iv.opening_stock as current_stock
                FROM variant_usage vu
                JOIN process_subprocesses ps ON ps.id = vu.process_subprocess_id
                JOIN item_variant iv ON iv.variant_id = vu.variant_id
                WHERE ps.process_id = %s
                  AND vu.substitute_group_id IS NULL
            """,
                (lot["process_id"],),
            )

            for variant in cur.fetchall():
                required_qty = float(variant["quantity"]) * lot["quantity"]
                current_stock = float(variant["current_stock"] or 0)

                if current_stock < required_qty:
                    raise ValueError(
                        f"Insufficient stock for {variant['variant_name']}. "
                        f"Required: {required_qty}, Available: {current_stock}"
                    )

                deductions.append(
                    {
                        "variant_id": variant["variant_id"],
                        "variant_name": variant["variant_name"],
                        "quantity": required_qty,
                        "stock_before": current_stock,
                    }
                )

            # Selected variants
            cur.execute(
                """
                SELECT
                    pls.selected_variant_id as variant_id,
                    pls.selected_quantity as quantity,
                    iv.name as variant_name,
                    iv.opening_stock as current_stock
                FROM production_lot_variant_selections pls
                JOIN item_variant iv ON iv.variant_id = pls.selected_variant_id
                WHERE pls.lot_id = %s
            """,
                (lot_id,),
            )

            for variant in cur.fetchall():
                required_qty = float(variant["quantity"]) * lot["quantity"]
                current_stock = float(variant["current_stock"] or 0)

                if current_stock < required_qty:
                    raise ValueError(
                        f"Insufficient stock for {variant['variant_name']}. "
                        f"Required: {required_qty}, Available: {current_stock}"
                    )

                deductions.append(
                    {
                        "variant_id": variant["variant_id"],
                        "variant_name": variant["variant_name"],
                        "quantity": required_qty,
                        "stock_before": current_stock,
                    }
                )

            # Perform inventory deductions
            for deduction in deductions:
                cur.execute(
                    """
                    UPDATE item_variant
                    SET opening_stock = opening_stock - %s
                    WHERE variant_id = %s
                """,
                    (deduction["quantity"], deduction["variant_id"]),
                )

                deduction["stock_after"] = (
                    deduction["stock_before"] - deduction["quantity"]
                )

            # Update lot status
            cur.execute(
                """
                UPDATE production_lots
                SET status = 'completed',
                    actual_cost = %s,
                    started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
                    completed_at = CURRENT_TIMESTAMP
                WHERE id = %s
            """,
                (actual_cost, lot_id),
            )

            conn.commit()

            current_app.logger.info(
                f"Production lot {lot['lot_number']} executed successfully. "
                f"Deducted {len(deductions)} variants."
            )

        return {
            "lot_id": lot_id,
            "lot_number": lot["lot_number"],
            "status": "completed",
            "actual_cost": actual_cost,
            # Use alias to support schemas where only total_cost exists
            "worst_case_estimated_cost": float(
                (lot.get("worst_case_estimated_cost") or lot.get("total_cost") or 0)
            ),
            "variance": actual_cost
            - float(
                (lot.get("worst_case_estimated_cost") or lot.get("total_cost") or 0)
            ),
            "deductions": deductions,
            "executed_at": datetime.now().isoformat(),
        }

    @staticmethod
    def finalize_production_lot(lot_id: int, user_id: int) -> Dict[str, Any]:
        """Finalize a production lot (lock it) if no CRITICAL alerts pending.

        Raises ValueError if blocking alerts exist.
        """
        from .inventory_alert_service import InventoryAlertService

        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            cur.execute(
                "SELECT id, lot_number, status FROM production_lots WHERE id = %s",
                (lot_id,),
            )
            lot = cur.fetchone()
            if not lot:
                raise ValueError("Lot not found")

        summary = InventoryAlertService.get_production_lot_alert_summary(lot_id)
        crit_pending = summary.get("alerts_by_severity", {}).get("CRITICAL", 0)
        if crit_pending:
            raise ValueError(
                "Critical inventory alerts pending. Please acknowledge before finalizing."
            )

        with database.get_conn() as (conn, cur):
            cur.execute(
                """
                UPDATE production_lots
                SET status = 'finalized', finalized_at = CURRENT_TIMESTAMP
                WHERE id = %s
                """,
                (lot_id,),
            )
            conn.commit()

        return {
            "lot_id": lot_id,
            "lot_number": lot["lot_number"],
            "status": "finalized",
            "alerts_summary": summary.get("alerts_by_severity"),
            "finalized_at": datetime.utcnow().isoformat(),
        }

    @staticmethod
    def cancel_production_lot(lot_id: int, reason: Optional[str] = None) -> bool:
        """
        Cancel a production lot.

        Args:
            lot_id: The lot to cancel
            reason: Optional cancellation reason

        Returns:
            True if successful
        """
        with database.get_conn() as (conn, cur):
            cur.execute(
                """
                UPDATE production_lots
                SET status = 'cancelled'
                WHERE id = %s
                  AND status NOT IN ('completed', 'cancelled')
            """,
                (lot_id,),
            )

            affected = cur.rowcount
            conn.commit()

            if affected > 0 and reason:
                current_app.logger.info(f"Lot {lot_id} cancelled. Reason: {reason}")

        return affected > 0

    @staticmethod
    def get_variance_analysis(lot_id: int) -> Dict[str, Any]:
        """
        Get detailed variance analysis for a completed lot.

        Args:
            lot_id: The production lot

        Returns:
            Variance breakdown by variant, supplier, cost type
        """
        lot = ProductionService.get_production_lot(lot_id, include_selections=True)

        if not lot:
            return {}

        if lot["status"] != "completed":
            return {
                "error": "Variance analysis only available for completed lots",
                "status": lot["status"],
            }

        variance = float(lot["actual_cost"] or 0) - float(
            lot["worst_case_estimated_cost"] or 0
        )
        variance_pct = (
            (variance / float(lot["worst_case_estimated_cost"]) * 100)
            if lot["worst_case_estimated_cost"]
            else 0
        )

        return {
            "lot_id": lot_id,
            "lot_number": lot["lot_number"],
            "worst_case_estimated": float(lot["worst_case_estimated_cost"] or 0),
            "actual_cost": float(lot["actual_cost"] or 0),
            "variance_amount": variance,
            "variance_percentage": variance_pct,
            "is_under_budget": variance < 0,
            "savings_amount": abs(variance) if variance < 0 else 0,
            "overrun_amount": variance if variance > 0 else 0,
            "selections": lot.get("selections", []),
            "actual_costing": lot.get("actual_costing", []),
        }
