"""Inventory Alerts & Procurement Recommendations API

Provides REST endpoints for:
- Inventory alert rules
- Production lot inventory alerts
- Procurement recommendations

Hyphenated primary endpoints + underscored legacy compatibility.
"""

from flask import request, current_app, Blueprint
from flask_login import login_required, current_user
from datetime import datetime
from app.utils.response import APIResponse
from app.services.inventory_alert_service import (
    InventoryAlertService,
    ProcurementRecommendationService,
)
from . import api_bp  # reuse existing /api prefix blueprint

# New UPF-specific blueprint mounted at /api/upf per action plan
inventory_alerts_bp = Blueprint("inventory_alerts", __name__)


def is_admin():
    return (
        current_user.is_authenticated and getattr(current_user, "role", None) == "admin"
    )


# === ALERT RULES ===
@api_bp.route("/inventory-alert-rules", methods=["POST"])
@api_bp.route("/inventory_alert_rules", methods=["POST"])  # legacy
@login_required
def upsert_alert_rule():
    data = request.json or {}
    required = [
        "variant_id",
        "safety_stock_quantity",
        "reorder_point_quantity",
        "alert_threshold_percentage",
    ]
    missing = [f for f in required if f not in data]
    if missing:
        return APIResponse.error(
            "validation_error", f"Missing fields: {', '.join(missing)}", 400
        )
    try:
        rule = InventoryAlertService.upsert_alert_rule(
            variant_id=int(data["variant_id"]),
            safety_stock_quantity=int(data["safety_stock_quantity"]),
            reorder_point_quantity=int(data["reorder_point_quantity"]),
            alert_threshold_percentage=float(data["alert_threshold_percentage"]),
            user_id=current_user.id,
        )
        return APIResponse.created(rule, "Alert rule upserted")
    except Exception as e:
        current_app.logger.error(f"Error upserting alert rule: {e}")
        return APIResponse.error("internal_error", str(e), 500)


# Plan-aligned route: PUT /api/upf/inventory-alerts/rules/<item_variant_id>
@inventory_alerts_bp.route(
    "/inventory-alerts/rules/<int:item_variant_id>", methods=["PUT"]
)
@login_required
def upf_put_rule(item_variant_id: int):
    if not is_admin():
        return APIResponse.error("forbidden", "Admin required", 403)
    data = request.json or {}
    try:
        rule = InventoryAlertService.upsert_alert_rule(
            variant_id=item_variant_id,
            safety_stock_quantity=int(data.get("safety_stock_quantity", 10)),
            reorder_point_quantity=int(data.get("reorder_point_quantity", 20)),
            alert_threshold_percentage=float(
                data.get("alert_threshold_percentage", 75.0)
            ),
            user_id=current_user.id,
        )
        return APIResponse.success(rule, "Rule updated")
    except Exception as e:
        current_app.logger.error(f"UPF PUT rule failed: {e}")
        return APIResponse.error("internal_error", str(e), 500)


@api_bp.route("/inventory-alert-rules", methods=["GET"])
@api_bp.route("/inventory_alert_rules", methods=["GET"])  # legacy
@login_required
def list_alert_rules():
    active_only = request.args.get("active_only") == "true"
    variant_id = request.args.get("variant_id")
    try:
        rules = InventoryAlertService.list_rules(
            active_only=active_only, variant_id=int(variant_id) if variant_id else None
        )
        return APIResponse.success(rules)
    except Exception as e:
        current_app.logger.error(f"Error listing alert rules: {e}")
        return APIResponse.error("internal_error", str(e), 500)


# Plan-aligned route: GET /api/upf/inventory-alerts/rules
@inventory_alerts_bp.route("/inventory-alerts/rules", methods=["GET"])
@login_required
def upf_get_rules():
    item_variant_id = request.args.get("item_variant_id")
    rules = InventoryAlertService.list_rules(
        active_only=True, variant_id=int(item_variant_id) if item_variant_id else None
    )
    return APIResponse.success({"rules": rules})


@api_bp.route("/inventory-alert-rules/<int:rule_id>/deactivate", methods=["PATCH"])
@api_bp.route(
    "/inventory_alert_rules/<int:rule_id>/deactivate", methods=["PATCH"]
)  # legacy
@login_required
def deactivate_alert_rule(rule_id):
    try:
        if not is_admin():
            return APIResponse.error("forbidden", "Admin required", 403)
        ok = InventoryAlertService.deactivate_rule(rule_id)
        if not ok:
            return APIResponse.not_found("Alert rule", rule_id)
        return APIResponse.success(
            {"alert_rule_id": rule_id, "deactivated": True}, "Rule deactivated"
        )
    except Exception as e:
        current_app.logger.error(f"Error deactivating alert rule: {e}")
        return APIResponse.error("internal_error", str(e), 500)


# === INVENTORY ALERTS ===
@api_bp.route("/inventory-alerts", methods=["POST"])
@api_bp.route("/inventory_alerts", methods=["POST"])  # legacy
@login_required
def create_inventory_alert():
    data = request.json or {}
    required = ["production_lot_id", "variant_id", "required_quantity"]
    missing = [f for f in required if f not in data]
    if missing:
        return APIResponse.error(
            "validation_error", f"Missing fields: {', '.join(missing)}", 400
        )
    try:
        alert = InventoryAlertService.create_lot_alert(
            production_lot_id=int(data["production_lot_id"]),
            variant_id=int(data["variant_id"]),
            required_quantity=int(data["required_quantity"]),
        )
        return APIResponse.created(alert, "Inventory alert created")
    except Exception as e:
        current_app.logger.error(f"Error creating inventory alert: {e}")
        return APIResponse.error("internal_error", str(e), 500)


@api_bp.route("/inventory-alerts", methods=["GET"])
@api_bp.route("/inventory_alerts", methods=["GET"])  # legacy
@login_required
def list_inventory_alerts():
    lot_id = request.args.get("production_lot_id")
    severity = request.args.get("severity")
    try:
        alerts = InventoryAlertService.list_alerts(
            production_lot_id=int(lot_id) if lot_id else None,
            severity=severity if severity else None,
        )
        return APIResponse.success(alerts)
    except Exception as e:
        current_app.logger.error(f"Error listing alerts: {e}")
        return APIResponse.error("internal_error", str(e), 500)


@api_bp.route("/inventory-alerts/<int:alert_id>/acknowledge", methods=["POST"])
@api_bp.route(
    "/inventory_alerts/<int:alert_id>/acknowledge", methods=["POST"]
)  # legacy
@login_required
def acknowledge_inventory_alert(alert_id):
    data = request.json or {}
    try:
        updated = InventoryAlertService.acknowledge_alert(
            alert_id=alert_id,
            user_id=current_user.id,
            user_action=data.get("user_action"),
            action_notes=data.get("action_notes"),
        )
        if updated.get("error"):
            return APIResponse.not_found("Inventory alert", alert_id)
        return APIResponse.success(updated, "Alert acknowledged")
    except Exception as e:
        current_app.logger.error(f"Error acknowledging alert: {e}")
        return APIResponse.error("internal_error", str(e), 500)


# Plan-aligned route: POST /api/upf/inventory-alerts/<alert_id>/acknowledge
@inventory_alerts_bp.route(
    "/inventory-alerts/<int:alert_id>/acknowledge", methods=["POST"]
)
@login_required
def upf_acknowledge_alert(alert_id: int):
    return acknowledge_inventory_alert(alert_id)


# === PROCUREMENT RECOMMENDATIONS ===
@api_bp.route("/procurement-recommendations", methods=["POST"])
@api_bp.route("/procurement_recommendations", methods=["POST"])  # legacy
@login_required
def create_procurement_recommendation():
    data = request.json or {}
    required = [
        "production_lot_id",
        "variant_id",
        "recommended_quantity",
        "required_delivery_date",
    ]
    missing = [f for f in required if f not in data]
    if missing:
        return APIResponse.error(
            "validation_error", f"Missing fields: {', '.join(missing)}", 400
        )
    try:
        # Parse date (YYYY-MM-DD)
        req_date = datetime.strptime(data["required_delivery_date"], "%Y-%m-%d").date()
        rec = ProcurementRecommendationService.create_recommendation(
            production_lot_id=int(data["production_lot_id"]),
            variant_id=int(data["variant_id"]),
            supplier_id=int(data["supplier_id"]) if data.get("supplier_id") else None,
            recommended_quantity=int(data["recommended_quantity"]),
            required_delivery_date=req_date,
            estimated_cost=float(data.get("estimated_cost"))
            if data.get("estimated_cost")
            else None,
        )
        return APIResponse.created(rec, "Procurement recommendation created")
    except Exception as e:
        current_app.logger.error(f"Error creating recommendation: {e}")
        return APIResponse.error("internal_error", str(e), 500)


@api_bp.route("/procurement-recommendations", methods=["GET"])
@api_bp.route("/procurement_recommendations", methods=["GET"])  # legacy
@login_required
def list_procurement_recommendations():
    lot_id = request.args.get("production_lot_id")
    status = request.args.get("status")
    try:
        recs = ProcurementRecommendationService.list_recommendations(
            production_lot_id=int(lot_id) if lot_id else None,
            status=status if status else None,
        )
        return APIResponse.success(recs)
    except Exception as e:
        current_app.logger.error(f"Error listing recommendations: {e}")
        return APIResponse.error("internal_error", str(e), 500)


# Plan-aligned route: GET /api/upf/inventory-alerts/procurement-recommendations
@inventory_alerts_bp.route(
    "/inventory-alerts/procurement-recommendations", methods=["GET"]
)
@login_required
def upf_list_procurement():
    return list_procurement_recommendations()


@api_bp.route(
    "/procurement-recommendations/<int:recommendation_id>/status", methods=["PATCH"]
)
@api_bp.route(
    "/procurement_recommendations/<int:recommendation_id>/status", methods=["PATCH"]
)  # legacy
@login_required
def update_procurement_status(recommendation_id):
    data = request.json or {}
    if "procurement_status" not in data:
        return APIResponse.error(
            "validation_error", "procurement_status is required", 400
        )
    try:
        updated = ProcurementRecommendationService.update_status(
            recommendation_id=recommendation_id,
            procurement_status=data["procurement_status"],
            purchase_order_id=int(data["purchase_order_id"])
            if data.get("purchase_order_id")
            else None,
        )
        if updated.get("error"):
            return APIResponse.not_found(
                "Procurement recommendation", recommendation_id
            )
        return APIResponse.success(updated, "Procurement status updated")
    except Exception as e:
        current_app.logger.error(f"Error updating procurement status: {e}")
        return APIResponse.error("internal_error", str(e), 500)


# Basic health check for this blueprint
@api_bp.route("/inventory-alerts/health", methods=["GET"])
@login_required
def health():
    return APIResponse.success({"ok": True, "timestamp": datetime.utcnow().isoformat()})


# === Plan-specific endpoints ===


@inventory_alerts_bp.route(
    "/inventory-alerts/check-lot/<int:production_lot_id>", methods=["POST"]
)
@login_required
def upf_check_lot(production_lot_id: int):
    try:
        alerts = InventoryAlertService.check_inventory_levels_for_production_lot(
            production_lot_id
        )
        created = InventoryAlertService.create_production_lot_alerts(
            production_lot_id, alerts
        )
        summary = InventoryAlertService.get_production_lot_alert_summary(
            production_lot_id
        )
        return APIResponse.success(
            {
                "status": "success",
                "lot_id": production_lot_id,
                "alerts_generated": len(created),
                "alerts_by_severity": summary.get("alerts_by_severity"),
                "alerts": alerts,
            }
        )
    except Exception as e:
        current_app.logger.error(f"Error checking lot {production_lot_id}: {e}")
        return APIResponse.error("internal_error", "Inventory check failed", 500)


@inventory_alerts_bp.route(
    "/inventory-alerts/lot/<int:production_lot_id>", methods=["GET"]
)
@login_required
def upf_get_lot_alerts(production_lot_id: int):
    try:
        summary = InventoryAlertService.get_production_lot_alert_summary(
            production_lot_id
        )
        return APIResponse.success(
            {
                "lot_id": production_lot_id,
                "lot_status_inventory": summary.get("lot_status"),
                "total_alerts": summary.get("total_alerts"),
                "alerts_summary": summary.get("alerts_by_severity"),
                "alert_details": summary.get("alerts"),
            }
        )
    except Exception as e:
        current_app.logger.error(
            f"Error retrieving lot alerts {production_lot_id}: {e}"
        )
        return APIResponse.error("internal_error", "Failed to fetch alerts", 500)


@inventory_alerts_bp.route(
    "/inventory-alerts/lot/<int:production_lot_id>/acknowledge-bulk", methods=["POST"]
)
@login_required
def upf_acknowledge_bulk(production_lot_id: int):
    data = request.json or {}
    acks = data.get("acknowledgments", [])
    from app.services.production_service import ProductionService

    # Support tests running with AnonymousUser when LOGIN_DISABLED or no auth context
    uid = getattr(current_user, "id", None)
    result = ProductionService.acknowledge_and_validate_production_lot_alerts(
        production_lot_id=production_lot_id,
        user_id=uid if uid is not None else 0,
        acknowledgments=acks,
    )
    if result.get("error"):
        return APIResponse.error("validation_error", result.get("details"), 400)
    return APIResponse.success(
        {
            "status": "success",
            "acknowledged_count": len(acks),
            "updated_lot_status": result.get("lot_status"),
            "alerts_summary": result.get("alerts_by_severity"),
        }
    )


@inventory_alerts_bp.route("/monitoring/alerts-health", methods=["GET"])
@login_required
def monitoring_alerts_health():
    """System-wide inventory alert health metrics for monitoring dashboard.

    Returns:
        JSON with:
        - total_active_alerts: total count of alerts
        - critical_count, high_count, medium_count, low_count: counts by severity
        - acknowledged_count: number of acknowledged alerts
        - oldest_critical_age_hours: hours since oldest unacknowledged CRITICAL alert (null if none)
    """
    try:
        metrics = InventoryAlertService.get_alerts_health_metrics()
        return APIResponse.success(metrics)
    except Exception as e:
        current_app.logger.error(f"Error fetching alerts health metrics: {e}")
        return APIResponse.error(
            "internal_error", "Failed to fetch health metrics", 500
        )
