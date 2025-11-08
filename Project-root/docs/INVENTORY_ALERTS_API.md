# Inventory Alerts & Procurement API

Scope: Inventory alert rules, lot alerts, acknowledgments, and procurement recommendations for Universal Process Framework (UPF).

Base URLs
- Primary (UPF): /api/upf
- Legacy (compat): /api

Authentication: Login required. In tests, LOGIN_DISABLED=True bypasses checks.
Content-Type: application/json

## Alert Rules

PUT /api/upf/inventory-alerts/rules/{item_variant_id}
- Body: { "safety_stock_quantity": 10, "reorder_point_quantity": 20, "alert_threshold_percentage": 75.0 }
- Admin only. Creates/updates rule for a variant.
- 200 OK: { data: { ...rule } }

GET /api/upf/inventory-alerts/rules?item_variant_id=123
- 200 OK: { data: { rules: [ ... ] } }

POST /api/inventory-alert-rules
- Body: { variant_id, safety_stock_quantity, reorder_point_quantity, alert_threshold_percentage }
- 201 Created: { data: { ...rule } }

PATCH /api/inventory-alert-rules/{rule_id}/deactivate
- Admin only.
- 200 OK: { data: { alert_rule_id, deactivated: true } }

## Inventory Alerts (per Lot)

POST /api/upf/inventory-alerts/check-lot/{production_lot_id}
- Runs evaluation for the lot’s process structure, inserts alerts and returns summary.
- 200 OK: { data: { status, lot_id, alerts_generated, alerts_by_severity, alerts: [ ...computed ] } }

GET /api/upf/inventory-alerts/lot/{production_lot_id}
- 200 OK: { data: { lot_id, lot_status_inventory, total_alerts, alerts_summary, alert_details } }

POST /api/upf/inventory-alerts/lot/{production_lot_id}/acknowledge-bulk
- Body: { "acknowledgments": [ { "alert_id": 1, "user_action": "PROCEED", "action_notes": "note" }, ... ] }
- 200 OK: { data: { status: "success", acknowledged_count, updated_lot_status, alerts_summary } }
- 400: { error: { code: "validation_error", message, details } }

POST /api/upf/inventory-alerts/{alert_id}/acknowledge
- Body: { user_action: "PROCEED"|"DELAY"|"SUBSTITUTE"|"PARTIAL_FULFILL", action_notes?: string }
- 200 OK: { data: { ...updated_alert } }

Legacy routes also exist under /api/inventory-alerts and /api/inventory_alerts.

## Procurement Recommendations

GET /api/upf/inventory-alerts/procurement-recommendations?production_lot_id=123
- 200 OK: { data: [ ...recommendations ] }

POST /api/procurement-recommendations
- Body: { production_lot_id, variant_id, recommended_quantity, required_delivery_date: "YYYY-MM-DD", supplier_id?, estimated_cost? }
- 201 Created: { data: { ...recommendation } }

PATCH /api/procurement-recommendations/{id}/status
- Body: { procurement_status: "RECOMMENDED"|"ORDERED"|"RECEIVED"|"PARTIAL"|"CANCELLED", purchase_order_id?: number }
- 200 OK: { data: { ...updated } }

## Production Lot integration

POST /api/upf/production-lots
- Body: { process_id, quantity, notes? }
- Creates lot and immediately evaluates inventory; response enriched with alerts summary.
- 201 Created: { data: { id/lot_id, lot_number, alerts_present, alerts_summary, procurement_recommendations, ... } }

POST /api/upf/production-lots/{lot_id}/validate-inventory
- Re-runs evaluation and updates alerts; returns update summary.

PUT /api/upf/production-lots/{lot_id}/finalize
- Finalizes lot if no CRITICAL alerts remain unacknowledged.
- 200 OK: { data: { status: "finalized", alerts_summary, finalized_at, ... } }
- 409 Conflict: { error: { code: "conflict", message: "Critical inventory alerts pending..." } }

## Status & Severity
- Alert severities: CRITICAL, HIGH, MEDIUM, LOW, OK
- Lot inventory status transitions:
  - Any CRITICAL -> PENDING_PROCUREMENT
  - Any HIGH (no CRITICAL) -> PARTIAL_FULFILLMENT_REQUIRED
  - Else -> READY

## Notes
- CSRF: UPF blueprints are exempted to support fetch() from the frontend. Ensure session auth is present.
- Backwards compatibility: Underscored routes are maintained for existing callers.
- Validation: Acknowledgment payloads are validated server-side; invalid IDs or actions return validation_error.
