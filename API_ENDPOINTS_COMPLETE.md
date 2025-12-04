# Complete API Endpoints Documentation
**Generated from Frontend Analysis - December 4, 2025**

## Overview
This document maps all API endpoints used by the Production Lot Detail frontend (`production_lot_detail.js`). The frontend uses a comprehensive overlay-based modal system with real-time state management.

---

## Production Lot Endpoints

### 1. GET /api/upf/production-lots/{id}
**Purpose:** Fetch production lot details

**Request:**
```
GET /api/upf/production-lots/{lot_id}
Headers: {
    'Content-Type': 'application/json'
}
```

**Response (Success 200):**
```json
{
    "data": {
        "lot_id": 1,
        "lot_number": "LOT-2025-001",
        "process_name": "Manufacturing Process A",
        "quantity": 100,
        "status": "draft",
        "total_cost": 15000.00,
        "worst_case_estimated_cost": 16000.00,
        "notes": "Quality inspection required",
        "subprocesses": [
            {
                "subprocess_id": 5,
                "subprocess_name": "Assembly",
                "subprocess_description": "Final assembly step",
                "variants": [
                    {
                        "variant_id": 42,
                        "variant_name": "Variant A",
                        "variant_sku": "SKU-A001",
                        "quantity": 100
                    }
                ]
            }
        ]
    }
}
```

**Frontend Integration:**
- Called during initialization in `_loadAllData()`
- Response data merged into state as `lot` object
- Used by `_renderLotDetails()` to populate page title, status badge, cost, and summary

**Alternative Responses:**
- Frontend handles both `{ data: {...} }` and `{...}` (unwrapped) responses
- Falls back to `lot.selections` if `lot.subprocesses` missing
- Uses `total_cost` or `worst_case_estimated_cost` if available

---

### 2. PUT /api/upf/production-lots/{id}
**Purpose:** Update production lot details

**Request:**
```
PUT /api/upf/production-lots/{lot_id}
Content-Type: application/json

{
    "quantity": 100,
    "status": "in_progress",
    "notes": "Updated notes"
}
```

**Response (Success 200):**
```json
{
    "data": {
        "lot_id": 1,
        "message": "Lot updated successfully"
    }
}
```

**Frontend Integration:**
- Triggered by `_handleSaveEditLot()` from edit modal
- Modal fields populated in `_handleEditLot()` from current state
- Form fields: `#modal-quantity`, `#modal-status`, `#modal-notes`
- After successful save, calls `_loadAllData()` to refresh all data

---

### 3. DELETE /api/upf/production-lots/{id}
**Purpose:** Delete a production lot

**Request:**
```
DELETE /api/upf/production-lots/{lot_id}
```

**Response (Success 200):**
```json
{
    "data": {
        "message": "Lot deleted successfully"
    }
}
```

**Frontend Integration:**
- Triggered by `_handleDeleteLot()` with user confirmation
- Redirects to `/production-lots` after 1 second delay
- Shows spinner on delete button during request

---

### 4. POST /api/upf/production-lots/{id}/finalize
**Purpose:** Finalize a production lot (lock changes)

**Request:**
```
POST /api/upf/production-lots/{lot_id}
```

**Response (Success 200):**
```json
{
    "data": {
        "message": "Lot finalized successfully",
        "lot_id": 1
    }
}
```

**Frontend Integration:**
- Triggered by `_handleFinalizeLot()` with confirmation dialog
- Button disabled if critical unacknowledged alerts exist
- After success, reloads all data via `_loadAllData()`

---

### 5. POST /api/upf/production-lots/{id}/recalculate
**Purpose:** Recalculate total cost of production lot

**Request:**
```
POST /api/upf/production-lots/{lot_id}
```

**Response (Success 200):**
```json
{
    "data": {
        "total_cost": 15500.00,
        "worst_case_estimated_cost": 16500.00
    }
}
```

**Frontend Integration:**
- Triggered by `_handleRecalculateCost()` from recalc button
- Updates state immediately: `lot.total_cost = newCost`
- Updates DOM element `#lot-total-cost` with formatted cost
- Uses formatter: `₹{number}.toLocaleString('en-IN', { minimumFractionDigits: 2 })`

---

## Subprocess Endpoints

### 6. POST /api/upf/production-lots/{lot_id}/subprocesses
**Purpose:** Add subprocess to production lot

**Request:**
```
POST /api/upf/production-lots/{lot_id}/subprocesses
Content-Type: application/json

{
    "subprocess_id": 5
}
```

**Response (Success 200):**
```json
{
    "data": {
        "message": "Subprocess added successfully"
    }
}
```

**Frontend Integration:**
- Triggered by `_handleAddSubprocess()` from add button
- Reads selected value from `#subprocess-select-for-add` dropdown
- After success, reloads all data via `_loadAllData()`
- Shows validation errors from `error.responseData`

**Error Handling:**
- Server may return structured errors: `{ errors: [...], field: ["message"] }`
- Frontend displays validation errors below the select element
- Error message format: `field: message`

---

### 7. GET /api/upf/subprocesses?per_page=1000
**Purpose:** Get all available subprocesses for selection

**Request:**
```
GET /api/upf/subprocesses?per_page=1000
```

**Response (Success 200):**
```json
{
    "data": {
        "subprocesses": [
            {
                "subprocess_id": 5,
                "subprocess_name": "Assembly",
                "id": 5,
                "name": "Assembly"
            },
            {
                "subprocess_id": 6,
                "subprocess_name": "Testing",
                "id": 6,
                "name": "Testing"
            }
        ],
        "pagination": {
            "total": 2,
            "page": 1,
            "per_page": 1000
        }
    }
}
```

**Frontend Integration:**
- Called during initialization in `_loadAvailableSubprocesses()`
- Response normalized - accepts multiple shapes:
  - `{ data: { subprocesses: [...] } }`
  - `{ subprocesses: [...] }`
  - Raw array `[...]`
- Populates dropdown `#subprocess-select-for-add`
- Fallback to global endpoint if lot-scoped endpoint fails

---

### 8. POST /api/upf/production-lots/{lot_id}/subprocesses/{subprocess_id}/variants
**Purpose:** Update variants for subprocess in lot

**Request:**
```
POST /api/upf/production-lots/{lot_id}/subprocesses/{subprocess_id}/variants
Content-Type: application/json

{
    "variant_ids": [42, 43, 44]
}
```

**Response (Success 200):**
```json
{
    "data": {
        "message": "Variants updated successfully"
    }
}
```

**Frontend Integration:**
- Triggered by `_handleSaveSubprocessVariants()` from modal save button
- Collects variant IDs from modal:
  - Dropdowns: `.variant-select` (selects one option each)
  - Checkboxes: `.variant-checkbox:checked` (multiple selections)
- After success, reloads all data via `_loadAllData()`

---

### 9. GET /api/upf/subprocess/{subprocess_id}/variant-options
**Purpose:** Get variant options (groups and standalone) for subprocess

**Request:**
```
GET /api/upf/subprocess/{subprocess_id}/variant-options
```

**Response (Success 200):**
```json
{
    "data": {
        "variant_groups": [
            {
                "group_id": 10,
                "group_name": "Size Options",
                "description": "Select size variant",
                "variants": [
                    {
                        "variant_id": 42,
                        "variant_name": "Size Small",
                        "variant_sku": "SKU-S"
                    },
                    {
                        "variant_id": 43,
                        "variant_name": "Size Medium",
                        "variant_sku": "SKU-M"
                    }
                ]
            }
        ],
        "standalone_variants": [
            {
                "variant_id": 100,
                "variant_name": "Add-on Feature X",
                "variant_sku": "SKU-ADDON"
            }
        ]
    }
}
```

**Alternative Response Format (Backend may return different shape):**
```json
{
    "data": {
        "or_groups": [
            {
                "group_id": 10,
                "group_name": "Size Options"
            }
        ],
        "grouped_variants": {
            "10": [
                {
                    "variant_id": 42,
                    "variant_name": "Size Small",
                    "variant_sku": "SKU-S"
                }
            ]
        },
        "standalone_variants": [...]
    }
}
```

**Frontend Integration:**
- Called in `_loadVariantOptions()` when editing subprocess variants
- Result cached in state: `variantOptionsCache[subprocess_id]`
- Normalized to single format in `_populateVariantModal()`
- Supports both `variant_groups` and `or_groups + grouped_variants` shapes

---

## Inventory Alerts Endpoints

### 10. GET /api/upf/inventory-alerts/lot/{lot_id}
**Purpose:** Get all inventory alerts for production lot

**Request:**
```
GET /api/upf/inventory-alerts/lot/{lot_id}
```

**Response (Success 200):**
```json
{
    "data": {
        "alert_details": [
            {
                "alert_id": 1001,
                "lot_id": 1,
                "variant_id": 42,
                "variant_name": "Size Small",
                "variant_sku": "SKU-S",
                "severity": "CRITICAL",
                "status": "PENDING",
                "current_stock": 10,
                "required_quantity": 50,
                "shortfall": 40,
                "suggested_procurement": 50
            },
            {
                "alert_id": 1002,
                "lot_id": 1,
                "variant_id": 43,
                "variant_name": "Size Medium",
                "variant_sku": "SKU-M",
                "severity": "WARNING",
                "status": "ACKNOWLEDGED",
                "current_stock": 25,
                "required_quantity": 60,
                "shortfall": 35,
                "suggested_procurement": 40
            }
        ]
    }
}
```

**Frontend Integration:**
- Called in `_loadAllData()` alongside lot details fetch
- Response normalized - accepts:
  - `{ data: { alert_details: [...] } }`
  - `{ alert_details: [...] }`
  - Raw array `[...]`
- Non-critical failure - continues if alerts endpoint fails
- Stored in state: `alerts: [...]`
- Used by `_renderAlerts()` and `_updateFinalizeButton()`

**Alert Rendering:**
- Table columns: Checkbox | Severity | Variant | SKU | Current | Required | Shortfall | Suggested | Status
- Severity badge styling: `CRITICAL` = red, `WARNING` = orange
- Acknowledged alerts show "Acknowledged" badge instead of button
- Acknowledged alert checkboxes are disabled

**Finalize Lock Logic:**
- Lot cannot be finalized if any `CRITICAL` alert has status != `ACKNOWLEDGED`
- Finalize button disabled with tooltip: "Cannot finalize: Critical alerts must be acknowledged"

---

### 11. POST /api/upf/inventory-alerts/{alert_id}/acknowledge
**Purpose:** Acknowledge single inventory alert

**Request:**
```
POST /api/upf/inventory-alerts/{alert_id}
```

**Response (Success 200):**
```json
{
    "data": {
        "message": "Alert acknowledged successfully",
        "alert_id": 1001
    }
}
```

**Frontend Integration:**
- Triggered by `_handleAcknowledgeAlert()` from alert table button
- Updates state immediately: `alert.status = 'ACKNOWLEDGED'`
- Re-renders alert table via `_renderAlerts()`
- Calls `_updateFinalizeButton()` to check if finalize is now allowed

---

### 12. POST /api/upf/inventory-alerts/bulk-acknowledge
**Purpose:** Acknowledge multiple inventory alerts at once

**Request:**
```
POST /api/upf/inventory-alerts/bulk-acknowledge
Content-Type: application/json

{
    "alert_ids": [1001, 1002, 1003]
}
```

**Response (Success 200):**
```json
{
    "data": {
        "message": "3 alert(s) acknowledged successfully",
        "acknowledged_count": 3
    }
}
```

**Frontend Integration:**
- Triggered by `_handleBulkAcknowledge()` from bulk acknowledge button
- Collects alert IDs from checked checkboxes: `.alert-checkbox:checked:not(:disabled)`
- Bulk button only enabled when 1+ alerts selected
- Updates state immediately for all acknowledged alerts
- Re-renders alert table via `_renderAlerts()`
- Calls `_updateFinalizeButton()` after bulk operation

---

## Variant Options Endpoint (Alternative Format)

### GET /api/upf/production-lots/{lot_id}/variant-options
**Purpose:** Get lot-scoped variant options for all subprocesses

**Request:**
```
GET /api/upf/production-lots/{lot_id}/variant-options
```

**Response (Success 200):**
```json
{
    "data": {
        "subprocesses": [
            {
                "subprocess_id": 5,
                "subprocess_name": "Assembly",
                "variants": [
                    {
                        "variant_id": 42,
                        "variant_name": "Size Small",
                        "variant_sku": "SKU-S"
                    }
                ]
            }
        ]
    }
}
```

**Frontend Integration:**
- Called in `_loadAllData()` after main lot fetch
- Supplements lot data with subprocess/variant info
- Used to populate `lot.subprocesses` if not already present
- Non-critical - continues if endpoint fails

---

## Error Response Formats

### HTTP 401 Unauthorized
```json
{
    "message": "Unauthorized"
}
```
**Frontend Action:** Redirects to `/auth/login`

### HTTP 4xx Validation Error
```json
{
    "message": "Validation failed",
    "errors": [
        {
            "field": "quantity",
            "message": "Must be positive integer"
        }
    ]
}
```
**OR**
```json
{
    "quantity": ["Must be positive integer"],
    "status": ["Invalid status value"]
}
```
**Frontend Action:** 
- Extracts error messages
- Displays field-level errors below form elements
- Shows toast notification with error summary

### HTTP 5xx Server Error
```json
{
    "message": "Internal server error"
}
```
**Frontend Action:**
- Shows error toast
- Logs error details
- Retries up to 2 times with exponential backoff (1s, 2s)

---

## State Management Flow

### Initialization
1. `init()` → `_waitForDOM()`
2. Extract `window.LOT_ID` or from URL
3. `_loadAvailableSubprocesses()` → populates dropdown
4. `_setupEventListeners()` → attaches all handlers
5. `_loadAllData()` → parallel fetch of lot + alerts
6. Render all components

### Data Loading
```
_loadAllData()
├── GET /api/upf/production-lots/{id}
├── GET /api/upf/inventory-alerts/lot/{id}
├── GET /api/upf/production-lots/{id}/variant-options (supplemental)
└── Update state + render all components
```

### State Structure
```javascript
{
    lotId: "1",
    lot: {
        lot_id: 1,
        lot_number: "LOT-2025-001",
        quantity: 100,
        status: "draft",
        total_cost: 15000,
        subprocesses: [...],
        ...
    },
    subprocesses: [],
    alerts: [...],
    variantOptionsCache: {
        "5": { variant_groups: [...] }
    },
    ui: {
        loading: false,
        error: null,
        editingSubprocess: null
    }
}
```

---

## Event Flow Examples

### Adding Subprocess
1. User selects subprocess from dropdown
2. Click "Add Subprocess" button
3. `_handleAddSubprocess()`:
   - Validates selection
   - POST to `/api/upf/production-lots/{id}/subprocesses`
   - On success: `_loadAllData()`
   - Renders subprocess cards

### Editing Variants
1. User clicks "Edit Variants" on subprocess card
2. `_handleEditSubprocessVariants()`:
   - Load variant options: `_loadVariantOptions()`
   - Populate modal: `_populateVariantModal()`
   - Show modal overlay
3. User selects variants
4. Click "Save Selections" button
5. `_handleSaveSubprocessVariants()`:
   - Collect selected variant IDs
   - POST to `/api/upf/production-lots/{id}/subprocesses/{sid}/variants`
   - On success: `_loadAllData()`

### Acknowledging Alert
1. Click "Acknowledge" button on alert row
2. `_handleAcknowledgeAlert()`:
   - POST to `/api/upf/inventory-alerts/{id}/acknowledge`
   - Update state immediately
   - Re-render table
   - Check finalize button state

---

## Important Implementation Notes

### Modal System
- Uses overlay-based modals (not Bootstrap modals)
- All modals managed by `ModalService` class
- ESC key closes active modal
- Modal IDs:
  - Edit lot: `#modal-overlay`
  - Edit variants: `#edit-subprocess-modal-overlay`
  - Add variant: `#variant-modal-overlay`

### Retry Logic
- Automatic retry on network failures: 2 attempts
- Exponential backoff: 1s, 2s delays
- No retry on 401 (auth errors)
- Retry on 5xx errors

### UI Patterns
- Spinner service for loading states
- Toast notifications (top-right, auto-dismiss after 4s)
- Form error display below invalid fields
- Checkbox delegation for table rows
- Button state management (disabled, spinner)

### Response Normalization
- Frontend handles multiple response envelope formats
- Prefers `response.data` but accepts unwrapped responses
- Maps field aliases:
  - `subprocess_name` / `name` / `label`
  - `variant_name` / `name` / `variation_name` / `full_name`
  - `variant_sku` / `sku`

### Cost Formatting
- Uses Indian locale: `toLocaleString('en-IN', { minimumFractionDigits: 2 })`
- Format: `₹15,000.00`

### Debug Mode
- Accessible via `CONFIG.DEBUG = true` in code
- Logs all API calls, state changes, DOM updates
- Exposed as `window.__UPF_DEBUG__` if `config.DEBUG` in Flask

---

## Testing Scenarios

### 1. Full Workflow
- Load production lot
- View alerts
- Acknowledge critical alerts
- Finalize lot

### 2. Subprocess Management
- Add subprocess to lot
- Edit variant selections for subprocess
- Verify subprocess card updates

### 3. Cost Recalculation
- View current cost
- Click recalc button
- Verify cost updates

### 4. Error Handling
- Try adding duplicate subprocess (validation error)
- Try finalizing with critical alerts (disabled button)
- Network timeout during API call (automatic retry)

---

## Version History

| Date | Version | Changes |
|------|---------|---------|
| 2025-12-04 | 1.0 | Initial comprehensive documentation from production_lot_detail.js analysis |

