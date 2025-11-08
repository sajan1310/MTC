"""
Inventory Alert & Procurement Recommendation Service

Provides business logic for:
- Managing inventory alert rules per variant
- Generating / acknowledging production lot inventory alerts
- Managing procurement recommendations tied to production lots

All methods return simple Python dicts ready for JSON serialization.
"""

from __future__ import annotations
from typing import Any, Dict, List, Optional
from datetime import date
import database
import psycopg2.extras

SEVERITY_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "OK"]


class InventoryAlertService:
    @staticmethod
    def upsert_alert_rule(
        variant_id: int,
        safety_stock_quantity: int,
        reorder_point_quantity: int,
        alert_threshold_percentage: float,
        user_id: int,
    ) -> Dict[str, Any]:
        """Create or update an inventory alert rule for a variant.
        Logic: if a rule exists for the variant, update it; else insert new.
        """
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            cur.execute(
                "SELECT * FROM inventory_alert_rules WHERE variant_id = %s",
                (variant_id,),
            )
            existing = cur.fetchone()
            if existing:
                cur.execute(
                    """
                    UPDATE inventory_alert_rules
                    SET safety_stock_quantity = %s,
                        reorder_point_quantity = %s,
                        alert_threshold_percentage = %s,
                        updated_at = CURRENT_TIMESTAMP,
                        is_active = TRUE
                    WHERE variant_id = %s
                    RETURNING *
                    """,
                    (
                        safety_stock_quantity,
                        reorder_point_quantity,
                        alert_threshold_percentage,
                        variant_id,
                    ),
                )
                rule = cur.fetchone()
            else:
                cur.execute(
                    """
                    INSERT INTO inventory_alert_rules (
                        variant_id, safety_stock_quantity, reorder_point_quantity,
                        alert_threshold_percentage, created_by
                    ) VALUES (%s, %s, %s, %s, %s)
                    RETURNING *
                    """,
                    (
                        variant_id,
                        safety_stock_quantity,
                        reorder_point_quantity,
                        alert_threshold_percentage,
                        user_id,
                    ),
                )
                rule = cur.fetchone()
            conn.commit()
        return dict(rule)

    @staticmethod
    def deactivate_rule(rule_id: int) -> bool:
        with database.get_conn() as (conn, cur):
            cur.execute(
                "UPDATE inventory_alert_rules SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE alert_rule_id = %s",
                (rule_id,),
            )
            affected = cur.rowcount
            conn.commit()
        return affected > 0

    @staticmethod
    def list_rules(
        active_only: bool = False, variant_id: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        conditions = []
        params: List[Any] = []
        if active_only:
            conditions.append("is_active = TRUE")
        if variant_id is not None:
            conditions.append("variant_id = %s")
            params.append(variant_id)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            cur.execute(
                f"SELECT * FROM inventory_alert_rules {where} ORDER BY variant_id",
                params,
            )
            rows = cur.fetchall()
        return [dict(r) for r in rows]

    @staticmethod
    def evaluate_variant_stock(
        variant_id: int, required_quantity: int
    ) -> Dict[str, Any]:
        """Evaluate variant stock against its rule and return computed severity.
        Severity logic (simplified):
        - If shortfall > 0 and shortfall >= reorder_point -> CRITICAL
        - Else if shortfall > 0 and shortfall >= safety_stock -> HIGH
        - Else if stock below safety stock but no immediate shortfall -> MEDIUM
        - Else if stock below reorder point but above safety -> LOW
        - Else OK
        """
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            cur.execute(
                "SELECT opening_stock FROM item_variant WHERE variant_id = %s",
                (variant_id,),
            )
            row = cur.fetchone()
            if not row:
                return {"variant_id": variant_id, "error": "Variant not found"}
            current_stock = int(row["opening_stock"] or 0)
            cur.execute(
                "SELECT * FROM inventory_alert_rules WHERE variant_id = %s AND is_active = TRUE",
                (variant_id,),
            )
            rule = cur.fetchone()
            if not rule:
                # Default thresholds
                safety_stock = 10
                reorder_point = 20
            else:
                safety_stock = int(rule["safety_stock_quantity"])
                reorder_point = int(rule["reorder_point_quantity"])

            shortfall = max(0, required_quantity - current_stock)
            if shortfall > 0 and shortfall >= reorder_point:
                severity = "CRITICAL"
            elif shortfall > 0 and shortfall >= safety_stock:
                severity = "HIGH"
            elif current_stock < safety_stock and shortfall == 0:
                severity = "MEDIUM"
            elif current_stock < reorder_point and current_stock >= safety_stock:
                severity = "LOW"
            else:
                severity = "OK"
            return {
                "variant_id": variant_id,
                "current_stock": current_stock,
                "required_quantity": required_quantity,
                "shortfall": shortfall,
                "severity": severity,
                "safety_stock": safety_stock,
                "reorder_point": reorder_point,
            }

    @staticmethod
    def create_lot_alert(
        production_lot_id: int, variant_id: int, required_quantity: int
    ) -> Dict[str, Any]:
        eval_result = InventoryAlertService.evaluate_variant_stock(
            variant_id, required_quantity
        )
        if eval_result.get("error"):
            return eval_result
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            cur.execute(
                """
                INSERT INTO production_lot_inventory_alerts (
                    production_lot_id, variant_id, alert_severity,
                    current_stock_quantity, required_quantity,
                    shortfall_quantity, suggested_procurement_quantity
                ) VALUES (%s, %s, %s, %s, %s, %s, %s)
                RETURNING *
                """,
                (
                    production_lot_id,
                    variant_id,
                    eval_result["severity"],
                    eval_result["current_stock"],
                    eval_result["required_quantity"],
                    eval_result["shortfall"],
                    eval_result["shortfall"],  # simplistic suggestion
                ),
            )
            alert = cur.fetchone()
            conn.commit()
        return dict(alert)

    @staticmethod
    def acknowledge_alert(
        alert_id: int,
        user_id: int,
        user_action: Optional[str] = None,
        action_notes: Optional[str] = None,
    ) -> Dict[str, Any]:
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            cur.execute(
                """
                UPDATE production_lot_inventory_alerts
                SET user_acknowledged = TRUE,
                    acknowledged_at = CURRENT_TIMESTAMP,
                    user_action = %s,
                    action_notes = %s
                WHERE alert_id = %s
                RETURNING *
                """,
                (user_action, action_notes, alert_id),
            )
            updated = cur.fetchone()
            conn.commit()
        return (
            dict(updated)
            if updated
            else {"error": "Alert not found", "alert_id": alert_id}
        )

    @staticmethod
    def list_alerts(
        production_lot_id: Optional[int] = None, severity: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        conditions = []
        params: List[Any] = []
        if production_lot_id is not None:
            conditions.append("production_lot_id = %s")
            params.append(production_lot_id)
        if severity is not None:
            conditions.append("alert_severity = %s")
            params.append(severity)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            cur.execute(
                f"SELECT * FROM production_lot_inventory_alerts {where} ORDER BY created_at DESC",
                params,
            )
            rows = cur.fetchall()
        return [dict(r) for r in rows]

    # === Phase 2.1 additional methods ===
    @staticmethod
    def check_inventory_levels_for_production_lot(
        production_lot_id: int,
    ) -> List[Dict[str, Any]]:
        """Compute required quantities for all variants in the lot's process structure
        and return alert candidates with severity using evaluate_variant_stock.
        """
        results: List[Dict[str, Any]] = []
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            # Get lot details
            cur.execute(
                "SELECT process_id, quantity FROM production_lots WHERE id = %s",
                (production_lot_id,),
            )
            lot = cur.fetchone()
            if not lot:
                return []

            # Gather variant usages for the process (fixed + OR groups)
            cur.execute(
                """
                SELECT vu.variant_id, vu.quantity
                FROM variant_usage vu
                JOIN process_subprocesses ps ON ps.id = vu.process_subprocess_id
                WHERE ps.process_id = %s AND vu.deleted_at IS NULL
                """,
                (lot["process_id"],),
            )
            usages = cur.fetchall()

            # Fetch variant names in one go
            variant_ids = tuple({u["variant_id"] for u in usages}) or tuple([-1])
            cur.execute(
                "SELECT variant_id, name FROM item_variant WHERE variant_id IN %s",
                (variant_ids,),
            )
            name_map = {r["variant_id"]: r["name"] for r in cur.fetchall()}

        for u in usages:
            req_qty = int((u["quantity"] or 0) * (lot["quantity"] or 0))
            eval_res = InventoryAlertService.evaluate_variant_stock(
                u["variant_id"], req_qty
            )
            # Normalize to planned output shape
            results.append(
                {
                    "item_variant_id": u["variant_id"],
                    "variant_name": name_map.get(u["variant_id"]) or "Variant",
                    "current_stock": eval_res.get("current_stock", 0),
                    "required_quantity": req_qty,
                    "alert_severity": eval_res.get("severity", "OK"),
                    "shortfall_quantity": eval_res.get("shortfall", 0),
                    "suggested_procurement_qty": eval_res.get("shortfall", 0),
                    "lead_time_days": 0,
                    "supplier_id": None,
                    "supplier_name": None,
                }
            )
        return results

    @staticmethod
    def create_production_lot_alerts(
        production_lot_id: int, alerts_list: List[Dict[str, Any]]
    ) -> List[int]:
        """Insert alerts for a lot; returns created alert IDs."""
        if not alerts_list:
            return []
        created_ids: List[int] = []
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            for a in alerts_list:
                cur.execute(
                    """
                    INSERT INTO production_lot_inventory_alerts (
                        production_lot_id, variant_id, alert_severity,
                        current_stock_quantity, required_quantity, shortfall_quantity,
                        suggested_procurement_quantity
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s)
                    RETURNING alert_id
                    """,
                    (
                        production_lot_id,
                        int(a.get("item_variant_id")),
                        a.get("alert_severity"),
                        int(a.get("current_stock") or 0),
                        int(a.get("required_quantity") or 0),
                        int(a.get("shortfall_quantity") or 0),
                        int(a.get("suggested_procurement_qty") or 0),
                    ),
                )
                rid = cur.fetchone()["alert_id"]
                created_ids.append(int(rid))
            conn.commit()
        return created_ids

    @staticmethod
    def generate_procurement_recommendations(
        production_lot_id: int, alerts_list: List[Dict[str, Any]]
    ) -> List[int]:
        """Create recommendations for HIGH/CRITICAL alerts; returns recommendation IDs."""
        rec_ids: List[int] = []
        if not alerts_list:
            return rec_ids
        high_crit = [
            a for a in alerts_list if a.get("alert_severity") in ("HIGH", "CRITICAL")
        ]
        if not high_crit:
            return rec_ids
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            # Determine a default required date = today + 7 days (placeholder if production_lots has no created_at)
            cur.execute(
                "SELECT COALESCE(created_at, CURRENT_DATE)::date FROM production_lots WHERE id = %s",
                (production_lot_id,),
            )
            lot_date = cur.fetchone()[0]
            for a in high_crit:
                variant_id = int(a.get("item_variant_id"))
                qty = int(a.get("shortfall_quantity") or 0)
                cur.execute(
                    """
                    INSERT INTO production_lot_procurement_recommendations (
                        production_lot_id, variant_id, supplier_id, recommended_quantity,
                        required_delivery_date, procurement_status
                    ) VALUES (%s, %s, NULL, %s, %s + INTERVAL '7 days', 'RECOMMENDED')
                    RETURNING recommendation_id
                    """,
                    (production_lot_id, variant_id, qty, lot_date),
                )
                rec_ids.append(int(cur.fetchone()["recommendation_id"]))
            conn.commit()
        return rec_ids

    @staticmethod
    def get_production_lot_alert_summary(production_lot_id: int) -> Dict[str, Any]:
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            cur.execute(
                "SELECT lot_status_inventory, alert_summary_json FROM production_lots WHERE id = %s",
                (production_lot_id,),
            )
            lot = cur.fetchone()
            cur.execute(
                "SELECT * FROM production_lot_inventory_alerts WHERE production_lot_id = %s ORDER BY created_at DESC",
                (production_lot_id,),
            )
            alerts = [dict(r) for r in cur.fetchall()]
        alerts_by_sev = {s: 0 for s in SEVERITY_ORDER}
        for a in alerts:
            sev = a.get("alert_severity")
            if sev in alerts_by_sev:
                alerts_by_sev[sev] += 1
        return {
            "lot_id": production_lot_id,
            "lot_status": (lot or {}).get("lot_status_inventory"),
            "total_alerts": len(alerts),
            "alerts_by_severity": alerts_by_sev,
            "acknowledged_count": sum(1 for a in alerts if a.get("user_acknowledged")),
            "alerts": alerts,
        }

    @staticmethod
    def get_alerts_health_metrics() -> Dict[str, Any]:
        """Return system-wide alert health metrics for monitoring dashboard.

        Returns:
            - total_active_alerts: count of all alerts across all lots
            - critical_count: count of CRITICAL alerts
            - high_count: count of HIGH alerts
            - medium_count: count of MEDIUM alerts
            - low_count: count of LOW alerts
            - acknowledged_count: count of acknowledged alerts
            - oldest_critical_age_hours: hours since oldest unacknowledged CRITICAL alert created (None if no CRITICAL)
        """
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            # Count by severity
            cur.execute(
                """
                SELECT alert_severity, COUNT(*) as cnt
                FROM production_lot_inventory_alerts
                GROUP BY alert_severity
                """
            )
            severity_counts = {
                row["alert_severity"]: int(row["cnt"]) for row in cur.fetchall()
            }

            # Total and acknowledged
            cur.execute("SELECT COUNT(*) FROM production_lot_inventory_alerts")
            row = cur.fetchone()
            total = (
                int(row[0] if not isinstance(row, dict) else row.get("count", 0))
                if row
                else 0
            )

            cur.execute(
                "SELECT COUNT(*) FROM production_lot_inventory_alerts WHERE user_acknowledged = TRUE"
            )
            row = cur.fetchone()
            acked = (
                int(row[0] if not isinstance(row, dict) else row.get("count", 0))
                if row
                else 0
            )

            # Oldest unacknowledged CRITICAL alert age
            cur.execute(
                """
                SELECT EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - created_at)) / 3600.0 as age_hours
                FROM production_lot_inventory_alerts
                WHERE alert_severity = 'CRITICAL' AND user_acknowledged = FALSE
                ORDER BY created_at ASC
                LIMIT 1
                """
            )
            oldest_row = cur.fetchone()
            oldest_critical_age_hours = (
                round(float(oldest_row["age_hours"]), 2)
                if oldest_row and oldest_row.get("age_hours") is not None
                else None
            )

        return {
            "total_active_alerts": total,
            "critical_count": severity_counts.get("CRITICAL", 0),
            "high_count": severity_counts.get("HIGH", 0),
            "medium_count": severity_counts.get("MEDIUM", 0),
            "low_count": severity_counts.get("LOW", 0),
            "acknowledged_count": acked,
            "oldest_critical_age_hours": oldest_critical_age_hours,
        }


class ProcurementRecommendationService:
    @staticmethod
    def create_recommendation(
        production_lot_id: int,
        variant_id: int,
        supplier_id: Optional[int],
        recommended_quantity: int,
        required_delivery_date: date,
        estimated_cost: Optional[float] = None,
    ) -> Dict[str, Any]:
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            cur.execute(
                """
                INSERT INTO production_lot_procurement_recommendations (
                    production_lot_id, variant_id, supplier_id,
                    recommended_quantity, required_delivery_date,
                    procurement_status, estimated_cost
                ) VALUES (%s, %s, %s, %s, %s, 'RECOMMENDED', %s)
                RETURNING *
                """,
                (
                    production_lot_id,
                    variant_id,
                    supplier_id,
                    recommended_quantity,
                    required_delivery_date,
                    estimated_cost,
                ),
            )
            rec = cur.fetchone()
            conn.commit()
        return dict(rec)

    @staticmethod
    def update_status(
        recommendation_id: int,
        procurement_status: str,
        purchase_order_id: Optional[int] = None,
    ) -> Dict[str, Any]:
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            cur.execute(
                """
                UPDATE production_lot_procurement_recommendations
                SET procurement_status = %s,
                    purchase_order_id = %s,
                    updated_at = CURRENT_TIMESTAMP
                WHERE recommendation_id = %s
                RETURNING *
                """,
                (procurement_status, purchase_order_id, recommendation_id),
            )
            rec = cur.fetchone()
            conn.commit()
        return (
            dict(rec)
            if rec
            else {
                "error": "Recommendation not found",
                "recommendation_id": recommendation_id,
            }
        )

    @staticmethod
    def list_recommendations(
        production_lot_id: Optional[int] = None, status: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        conditions = []
        params: List[Any] = []
        if production_lot_id is not None:
            conditions.append("production_lot_id = %s")
            params.append(production_lot_id)
        if status is not None:
            conditions.append("procurement_status = %s")
            params.append(status)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            cur.execute(
                f"SELECT * FROM production_lot_procurement_recommendations {where} ORDER BY created_at DESC",
                params,
            )
            rows = cur.fetchall()
        return [dict(r) for r in rows]
