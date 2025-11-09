# UPF Endpoint Inventory

Single source of truth for UPF and related endpoints, their implementation status, and contracts.

Updated: 2025-11-09

## Legend
- Status: ✅ Implemented | ⚠️ Partial | ❌ Stubbed | ⏳ Planned

## Reports API

- GET /api/upf/reports/metrics — ✅ — Response: { total_processes, total_lots, avg_cost, completed_lots, processes_change, lots_change, cost_change, completed_change }
- GET /api/upf/reports/top-processes — ✅ — Response: { processes: [{ name, worst_case_cost }] }
- GET /api/upf/reports/process-status — ✅ — Response: { active, inactive, draft }
- GET /api/upf/reports/subprocess-usage — ✅ — Response: { subprocesses: [{ name, usage_count }] }

## Inventory Alerts

- GET /api/upf/inventory-alerts/lot/<id> — ✅ — Response: { lot_id, lot_status_inventory, total_alerts, alerts_summary, alert_details }
- POST /api/upf/inventory-alerts/lot/<id>/acknowledge-bulk — ✅ — Body: { acknowledgments: [{ alert_id, user_action, action_notes }] } → { status, acknowledged_count, updated_lot_status, alerts_summary }
- GET /api/upf/inventory-alerts/rules — ✅ — Response: { rules: [...] }
- PUT /api/upf/inventory-alerts/rules/<id> — ✅ — Body: safety_stock_quantity, reorder_point_quantity, alert_threshold_percentage → updated rule

## Process Management

- DELETE /api/upf/process_subprocess/<id> — ✅ — Response: { process_subprocess_id, deleted: true }
- GET /api/upf/process_subprocess/<id>/substitute_groups — ✅ — Response: { substitute_groups: [{ id, name, description, variants: [{ id, item_id, quantity, unit, is_alternative }] }] }

## Categories & Variants

- GET /api/categories — ✅ — Response: [ { id, name, description } ]
- GET /api/all-variants — ✅ — Response: variant list with stock and metadata

## Notes
- All endpoints use APIResponse.success/error wrappers under the UPF namespace, unless legacy routes under `/api` are used for compatibility.
- Authentication is required via @login_required; tests skip gracefully if unauthenticated.
- Reports metrics include safe fallbacks for month-over-month changes when historical windows are unavailable.
- Substitute groups and variant usage rely on `substitute_groups` and `variant_usage` tables; fields align with current migrations.
