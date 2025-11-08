# Production Lot Alert UI Integration Guide

This document provides integration examples for the enhanced alert display and bulk acknowledgment features.

## HTML Structure

Add the following structure to any production lot detail page to display alerts with bulk acknowledgment:

```html
{% block extra_css %}
<link rel="stylesheet" href="{{ url_for('static', filename='css/inventory_alerts.css') }}">
{% endblock %}

{% block content %}
<div class="production-lot-detail">
    <h2>Production Lot #{{ lot_number }}</h2>
    
    <!-- Alert Panel -->
    <div id="alert-panel" class="alert-panel hidden">
        <div class="alert-header">
            <h3>🔔 Inventory Alerts</h3>
            <button id="bulk-acknowledge-btn" class="btn-success">
                Acknowledge Selected
            </button>
        </div>
        
        <!-- Summary Stats -->
        <div id="alerts-summary" class="alerts-summary">
            <!-- Populated by JS -->
        </div>
        
        <!-- Alerts List with Checkboxes -->
        <div id="alerts-list" class="alerts-list">
            <!-- Populated by JS -->
        </div>
        
        <div class="alert-actions">
            <button class="btn-secondary" onclick="location.reload()">Refresh</button>
            <button id="bulk-acknowledge-btn" class="btn-success">
                Acknowledge Selected Alerts
            </button>
        </div>
    </div>

    <!-- Procurement Recommendations Panel -->
    <div id="procurement-panel" class="procurement-panel hidden">
        <h3>📦 Procurement Recommendations</h3>
        <table class="recommendations-table">
            <thead>
                <tr>
                    <th>Variant</th>
                    <th>Supplier</th>
                    <th>Quantity</th>
                    <th>Required Date</th>
                    <th>Est. Cost</th>
                    <th>Status</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody id="recommendations-tbody">
                <!-- Populated by JS -->
            </tbody>
        </table>
    </div>
</div>
{% endblock %}

{% block extra_js %}
<script src="{{ url_for('static', filename='js/production_lot_alerts.js') }}"></script>
<script>
    document.addEventListener('DOMContentLoaded', function() {
        // Initialize the alert handler with lot ID
        const lotId = {{ lot_id }};
        ProductionLotAlertHandler.init(lotId);
        
        // Load alerts for this lot
        ProductionLotAlertHandler.loadAlertsForLot(lotId);
    });
</script>
{% endblock %}
```

## JavaScript API Usage

### Initialize Handler

```javascript
// Initialize with production lot ID
ProductionLotAlertHandler.init(123);
```

### Load Alerts

```javascript
// Fetches and displays alerts for a lot
await ProductionLotAlertHandler.loadAlertsForLot(123);
```

### Display Alerts Manually

```javascript
// Display alerts from custom data source
const alerts = [
    {
        alert_id: 1,
        alert_severity: 'CRITICAL',
        variant_name: 'Red T-Shirt - Medium',
        current_stock_quantity: 5,
        required_quantity: 50,
        shortfall_quantity: 45,
        user_acknowledged: false
    }
];
ProductionLotAlertHandler.displayAlerts(alerts);
```

### Display Procurement Recommendations

```javascript
const recommendations = [
    {
        recommendation_id: 1,
        variant_name: 'Red T-Shirt - Medium',
        supplier_name: 'ABC Textiles',
        recommended_quantity: 50,
        required_delivery_date: '2025-11-15',
        estimated_cost: 250.00,
        procurement_status: 'RECOMMENDED'
    }
];
ProductionLotAlertHandler.displayProcurementRecommendations(recommendations);
```

### Bulk Acknowledge (Automatic)

The bulk acknowledge button is automatically wired when present in the DOM:

```html
<button id="bulk-acknowledge-btn" class="btn-success">
    Acknowledge Selected
</button>
```

When clicked:
1. Collects all checked alert checkboxes
2. Gathers user_action and action_notes for each selected alert
3. Sends bulk POST to `/api/upf/inventory-alerts/lot/{lot_id}/acknowledge-bulk`
4. Displays success/error message
5. Reloads alerts to show updated state

## CSS Classes Reference

### Alert Severity Styling

- `.alert-severity-CRITICAL` - Red border-left, light red background
- `.alert-severity-HIGH` - Orange border-left, light orange background
- `.alert-severity-MEDIUM` - Yellow border-left, light yellow background
- `.alert-severity-LOW` - Blue border-left, light blue background
- `.alert-severity-OK` - Green border-left, light green background

### Severity Badges

- `.severity-badge.CRITICAL` - Red background, white text
- `.severity-badge.HIGH` - Orange background, white text
- `.severity-badge.MEDIUM` - Yellow background, white text
- `.severity-badge.LOW` - Blue background, white text
- `.severity-badge.OK` - Green background, white text

### Status Badges (Procurement)

- `.status-badge.RECOMMENDED` - Yellow background
- `.status-badge.ORDERED` - Blue background
- `.status-badge.RECEIVED` - Green background
- `.status-badge.CANCELLED` - Red background

### Action Buttons

- `.btn-primary` - Blue (main actions)
- `.btn-secondary` - Gray (secondary actions)
- `.btn-warning` - Yellow (warning actions)
- `.btn-success` - Green (positive actions)

## User Action Options

When acknowledging alerts, users can select from:

- **PROCEED** - Accept the shortfall and proceed with production
- **USE_SUBSTITUTE** - Use an alternative variant
- **DELAY** - Delay production until stock available
- **PROCURE** - Create procurement order immediately

## API Integration

The handler communicates with these endpoints:

### GET Alert Summary
```
GET /api/upf/inventory-alerts/lot/{lot_id}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "lot_id": 123,
    "total_alerts": 5,
    "alerts_summary": {
      "CRITICAL": 2,
      "HIGH": 2,
      "LOW": 1
    },
    "alert_details": [...]
  }
}
```

### POST Bulk Acknowledge
```
POST /api/upf/inventory-alerts/lot/{lot_id}/acknowledge-bulk
Content-Type: application/json

{
  "acknowledgments": [
    {
      "alert_id": 1,
      "user_action": "PROCEED",
      "action_notes": "Supplier confirmed delivery tomorrow"
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
    "acknowledged_count": 1,
    "updated_lot_status": "PENDING_PROCUREMENT",
    "alerts_summary": {...}
  }
}
```

## Testing

Test the UI components:

```bash
# Test production lot page rendering
pytest tests/ui/test_upf_pages.py::test_upf_production_lots_page -v

# Test alert endpoints
pytest tests/api/test_inventory_alerts.py -v

# Test monitoring endpoint
pytest tests/api/test_monitoring.py -v
```

## Troubleshooting

### Alerts not displaying

1. Check browser console for JavaScript errors
2. Verify API endpoint returns 200 status
3. Ensure `alerts-list` element exists in DOM
4. Check CSS file is loaded (inspect network tab)

### Bulk acknowledge button not working

1. Verify button has `id="bulk-acknowledge-btn"`
2. Check `ProductionLotAlertHandler.init(lotId)` was called
3. Ensure at least one alert checkbox is checked
4. Check browser console for API errors

### Styles not applying

1. Ensure `inventory_alerts.css` is included in template
2. Clear browser cache
3. Check CSS selector specificity conflicts
4. Verify CSS file path in network tab

---

**Last Updated:** November 8, 2025
