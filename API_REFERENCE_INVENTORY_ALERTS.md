API Reference: Inventory Alerts & Procurement

Base URL prefix: /api

Alert Rules
- POST /inventory-alert-rules
  Body: { variant_id, safety_stock_quantity, reorder_point_quantity, alert_threshold_percentage }
  Response: 201 Created, rule object
- GET /inventory-alert-rules?active_only=true&variant_id=123
  Response: 200 OK, [rule]
- PATCH /inventory-alert-rules/{rule_id}/deactivate
  Admin-only. Response: 200 OK

Inventory Alerts
- POST /inventory-alerts
  Body: { production_lot_id, variant_id, required_quantity }
  Response: 201 Created, alert object
- GET /inventory-alerts?production_lot_id=...&severity=CRITICAL
  Response: 200 OK, [alerts]
- POST /inventory-alerts/{alert_id}/acknowledge
  Body: { user_action?: 'PROCEED'|'DELAY'|'SUBSTITUTE'|'PARTIAL_FULFILL', action_notes?: string }
  Response: 200 OK

Procurement Recommendations
- POST /procurement-recommendations
  Body: { production_lot_id, variant_id, supplier_id?, recommended_quantity, required_delivery_date: YYYY-MM-DD, estimated_cost? }
  Response: 201 Created
- GET /procurement-recommendations?production_lot_id=...&status=RECOMMENDED
  Response: 200 OK, [recommendations]
- PATCH /procurement-recommendations/{id}/status
  Body: { procurement_status, purchase_order_id? }
  Response: 200 OK

Notes
- All endpoints require login.
- Legacy underscore paths provided for backward compatibility.
- Errors follow APIResponse.error format.
