# UPF Inventory Alert System – Usage Guide

**Last Updated:** November 8, 2025  
**Status:** Phases 7–8 Complete (UI + Monitoring)

---

## Overview

The Universal Process Framework now includes a complete inventory alert and procurement management system integrated across production lots. This guide covers:

1. **Production Lots UI** – View and manage production lots with alert visibility
2. **Monitoring Dashboard** – Real-time system-wide alert health metrics
3. **API Endpoints** – Integration reference for custom tools

---

## 1. Production Lots UI

**Access:** Navigate to `/upf/production-lots` after logging in.

### Features

- **Lot Listing:** View all production lots with status, quantity, and alert counts
- **Search & Filter:** Find lots by lot number, process name, or status
- **Alert Summary:** Each lot row displays alert count badges (CRITICAL, HIGH, MEDIUM, LOW)
- **Pagination:** Handle large datasets efficiently

### Usage Flow

1. **Navigate** to the Production Lots page from the main navigation menu
2. **Search/Filter** to find specific lots
3. **Click on a lot row** to view detailed alert breakdown (detail page integration TBD Phase 9)
4. **Create new lots** via the "Create Production Lot" button

### Technical Details

- **Template:** `templates/upf_production_lots.html`
- **JavaScript:** `static/js/production_lots.js`
- **Data Source:** `/api/upf/production-lots` (GET endpoint)
- **Alert Integration:** Alerts are computed during lot validation and displayed in summary

---

## 2. Monitoring Dashboard

**Access:** Navigate to `/monitoring` after logging in.

### Features

- **Real-time Metrics:** Auto-refreshes every 30 seconds
- **Total Active Alerts:** Count of all alerts across all production lots
- **Severity Breakdown:** Separate counts for CRITICAL, HIGH, MEDIUM, LOW alerts
- **Acknowledged Count:** Track user-reviewed alerts
- **Oldest Critical Age:** Hours since the oldest unacknowledged CRITICAL alert was created
- **Visual Indicators:** Color-coded cards for each severity level
- **Alert Banner:** Displays when CRITICAL alerts require immediate attention

### Metric Definitions

| Metric | Description |
|--------|-------------|
| **Total Active Alerts** | Sum of all inventory alerts across all lots |
| **Critical Count** | Alerts requiring immediate action (stock shortfall >= reorder point) |
| **High Count** | Alerts requiring attention soon (shortfall >= safety stock) |
| **Medium Count** | Stock below safety level but no immediate shortfall |
| **Low Count** | Stock below reorder point but above safety stock |
| **Acknowledged** | Alerts that have been reviewed and acknowledged by users |
| **Oldest Critical Age** | Time in hours since the oldest unacknowledged CRITICAL alert; `null` if none exist |

### Usage Flow

1. **Navigate** to Monitoring Dashboard from main menu or directly at `/monitoring`
2. **Review metrics** to identify system-wide alert patterns
3. **Respond to critical alerts** using the banner link (redirects to detailed lot view)
4. **Monitor auto-refresh** – page updates every 30 seconds without manual intervention

### Technical Details

- **Template:** `templates/monitoring.html`
- **API Endpoint:** `/api/upf/monitoring/alerts-health` (GET)
- **Service Layer:** `InventoryAlertService.get_alerts_health_metrics()`
- **Auto-Refresh:** JavaScript interval set to 30,000ms

---

## 3. API Reference

### GET /api/upf/monitoring/alerts-health

**Description:** Returns system-wide inventory alert health metrics for monitoring dashboards.

**Authentication:** Requires `@login_required`

**Response:**
```json
{
  "success": true,
  "data": {
    "total_active_alerts": 42,
    "critical_count": 5,
    "high_count": 12,
    "medium_count": 8,
    "low_count": 15,
    "acknowledged_count": 18,
    "oldest_critical_age_hours": 12.5
  }
}
```

**Fields:**
- `total_active_alerts` (int): Total count of alerts
- `critical_count` (int): Count of CRITICAL severity alerts
- `high_count` (int): Count of HIGH severity alerts
- `medium_count` (int): Count of MEDIUM severity alerts
- `low_count` (int): Count of LOW severity alerts
- `acknowledged_count` (int): Count of acknowledged alerts
- `oldest_critical_age_hours` (float|null): Hours since oldest unacknowledged CRITICAL alert created; `null` if no unacknowledged CRITICAL alerts exist

**Error Handling:**
- **500:** Internal server error (DB connection failure, query error)

**Example Usage (JavaScript):**
```javascript
fetch('/api/upf/monitoring/alerts-health')
  .then(res => res.json())
  .then(json => {
    if (json.success) {
      const { critical_count, oldest_critical_age_hours } = json.data;
      console.log(`CRITICAL: ${critical_count}, Oldest: ${oldest_critical_age_hours}h`);
    }
  });
```

---

### GET /api/upf/inventory-alerts/lot/<lot_id>

**Description:** Retrieve alert summary and details for a specific production lot.

**Authentication:** Requires `@login_required`

**Path Parameters:**
- `lot_id` (int): Production lot ID

**Response:**
```json
{
  "success": true,
  "data": {
    "lot_id": 123,
    "lot_status_inventory": "PENDING_PROCUREMENT",
    "total_alerts": 5,
    "alerts_summary": {
      "CRITICAL": 2,
      "HIGH": 2,
      "MEDIUM": 0,
      "LOW": 1,
      "OK": 0
    },
    "alert_details": [
      {
        "alert_id": 456,
        "variant_id": 78,
        "alert_severity": "CRITICAL",
        "current_stock_quantity": 10,
        "required_quantity": 50,
        "shortfall_quantity": 40,
        "suggested_procurement_quantity": 40,
        "user_acknowledged": false,
        "created_at": "2025-11-08T10:30:00Z"
      }
    ]
  }
}
```

---

### POST /api/upf/inventory-alerts/lot/<lot_id>/acknowledge-bulk

**Description:** Acknowledge multiple alerts for a production lot in bulk.

**Authentication:** Requires `@login_required`

**Path Parameters:**
- `lot_id` (int): Production lot ID

**Request Body:**
```json
{
  "acknowledgments": [
    {
      "alert_id": 456,
      "user_action": "PROCEED",
      "action_notes": "Supplier confirmed delivery in 2 days"
    },
    {
      "alert_id": 457,
      "user_action": "USE_SUBSTITUTE",
      "action_notes": "Using variant #82 as substitute"
    }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "status": "success",
    "acknowledged_count": 2,
    "updated_lot_status": "PENDING_PROCUREMENT",
    "alerts_summary": {
      "CRITICAL": 0,
      "HIGH": 1,
      "MEDIUM": 0,
      "LOW": 0
    }
  }
}
```

**Notes:**
- Lot status updates automatically based on remaining unacknowledged CRITICAL/HIGH alerts
- If all CRITICAL alerts are acknowledged, lot status may transition to `READY`

---

## 4. Testing

### Smoke Tests

**Production Lots Page:**
```bash
pytest tests/ui/test_upf_pages.py::test_upf_production_lots_page -v
```

**Monitoring Dashboard:**
```bash
pytest tests/api/test_monitoring.py::test_monitoring_page_renders -v
```

### Integration Tests

**Alert Health Metrics (with alerts):**
```bash
pytest tests/api/test_monitoring.py::test_alerts_health_endpoint_with_alerts -v
```

**Alert Health Metrics (empty state):**
```bash
pytest tests/api/test_monitoring.py::test_alerts_health_endpoint_empty -v
```

**Inventory Alert Workflow:**
```bash
pytest tests/api/test_inventory_alerts.py -v
```

### Full Suite

```bash
cd Project-root
pytest -q --tb=line
```

**Expected:** 141 passed, 1 skipped, 1 warning

---

## 5. Deployment Notes

### Static Assets

Ensure static assets are collected before deployment:
```bash
# If using collectstatic or minification
python minify_assets.py
```

**Required Files:**
- `static/js/production_lots.js` – Production lots page JS
- `static/js/production_lot_alerts.js` – Alert display helper
- `static/css/inventory_alerts.css` – Alert styling (optional, inline in templates)

### Blueprint Registration

The `inventory_alerts_bp` blueprint is already registered in `app/__init__.py`:
```python
app.register_blueprint(inventory_alerts_bp, url_prefix="/api/upf")
```

No additional configuration needed.

### Environment Variables

No new environment variables required. Existing DB connection settings apply:
- `DB_HOST`
- `DB_NAME`
- `DB_USER`
- `DB_PASS`

### Monitoring Endpoint Security

The `/api/upf/monitoring/alerts-health` endpoint requires authentication (`@login_required`). For external monitoring systems:

1. **Option A:** Create a dedicated monitoring user with read-only access
2. **Option B:** Add an API key authentication decorator for specific endpoints
3. **Option C:** Expose a separate health check endpoint without auth (aggregate metrics only, no sensitive data)

**Recommendation:** Use Option A for internal dashboards, Option C for external monitoring (Prometheus, DataDog, etc.)

---

## 6. Next Steps (Phase 9–11)

### Phase 9: Production Lot Detail Page Enhancement
- Add full alert detail table with acknowledge buttons
- Integrate procurement recommendations display
- Add finalize action button with CRITICAL alert blocking

### Phase 10: Deployment Scripts
- Document Heroku/Railway/Cloud deployment steps
- Add sample Procfile and runtime.txt updates
- Static asset CDN integration guide

### Phase 11: Final Verification
- End-to-end user flow testing
- Performance benchmarks (alert query optimization)
- Security audit (SQL injection, XSS checks)

---

## Troubleshooting

### Issue: Monitoring page shows "Failed to load metrics"

**Cause:** Database connection issue or blueprint not registered

**Fix:**
1. Check DB connectivity: `pytest tests/api/test_monitoring.py::test_alerts_health_endpoint_empty -v`
2. Verify blueprint registration in `app/__init__.py`
3. Check logs for specific error: `tail -f logs/app.log`

### Issue: Production lots page returns 404

**Cause:** Route not registered or template missing

**Fix:**
1. Verify route exists: `grep -r "upf_production_lots" app/main/routes.py`
2. Check template exists: `ls templates/upf_production_lots.html`
3. Ensure blueprint registered: `grep "main_bp" app/__init__.py`

### Issue: Alert counts are zero but alerts exist in DB

**Cause:** Schema migration mismatch or query filter issue

**Fix:**
1. Run a direct DB query to verify data:
   ```sql
   SELECT COUNT(*) FROM production_lot_inventory_alerts;
   ```
2. Check service method query in `inventory_alert_service.py`
3. Verify no WHERE clause is filtering out all results

---

## Support

For issues or questions:
1. Check test output: `pytest -v`
2. Review application logs: `tail -f logs/app.log`
3. Consult API reference above for endpoint details
4. Open GitHub issue with reproduction steps

---

**End of UPF Inventory Alert System Usage Guide**
