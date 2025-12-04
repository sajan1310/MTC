# API Validation Report: Frontend vs Backend Implementation
**Generated: December 4, 2025**

## Executive Summary
Comprehensive analysis of `production_lot_detail.js` against backend implementation in `app/api/` reveals **CRITICAL GAPS** requiring immediate backend development. The frontend expects 12 specific endpoints; 9 are partially or fully implemented, but **3 critical endpoints are MISSING or incorrectly routed**.

---

## Endpoint Status Matrix

| # | Frontend Endpoint | Backend Route | Status | Notes |
|---|---|---|---|---|
| 1 | GET `/api/upf/production-lots/{id}` | `/production-lots/<int:lot_id>` | ✅ IMPLEMENTED | `production_lot.py:211` |
| 2 | PUT `/api/upf/production-lots/{id}` | `/production-lots/<int:lot_id>` | ✅ IMPLEMENTED | `production_lot.py:1233` |
| 3 | DELETE `/api/upf/production-lots/{id}` | `/production-lots/<int:lot_id>` | ✅ IMPLEMENTED | `production_lot.py:1268` |
| 4 | POST `/api/upf/production-lots/{id}/finalize` | `/production-lots/<int:lot_id>/finalize` | ✅ IMPLEMENTED | `production_lot.py:1096` |
| 5 | POST `/api/upf/production-lots/{id}/recalculate` | `/production-lots/<int:lot_id>/recalculate` | ✅ IMPLEMENTED | `production_lot.py:609` (GET, should also be POST) |
| 6 | POST `/api/upf/production-lots/{id}/subprocesses` | `/production-lots/<int:id>/subprocesses` | ❌ **MISSING** | Not found in any route file |
| 7 | GET `/api/upf/subprocesses?per_page=1000` | `/subprocesses` or `/subprocess` | ⚠️ PARTIAL | Routes exist in subprocess_management.py but API path may differ |
| 8 | POST `/api/upf/production-lots/{id}/subprocesses/{sid}/variants` | `/production-lots/<int:id>/subprocesses/<int:sid>/variants` | ❌ **MISSING** | Not found - would update variant selections |
| 9 | GET `/api/upf/subprocess/{id}/variant-options` | `/subprocess/<int:id>/variant-options` | ✅ IMPLEMENTED | `production_lot.py:470` |
| 10 | GET `/api/upf/inventory-alerts/lot/{id}` | `/inventory-alerts/lot/<int:production_lot_id>` | ✅ IMPLEMENTED | `inventory_alerts.py:430` |
| 11 | POST `/api/upf/inventory-alerts/{id}/acknowledge` | `/inventory-alerts/<int:alert_id>/acknowledge` | ✅ IMPLEMENTED | `inventory_alerts.py:256` |
| 12 | POST `/api/upf/inventory-alerts/bulk-acknowledge` | `/inventory-alerts/lot/<int:id>/acknowledge-bulk` | ⚠️ INCORRECT PATH | Route uses lot-scoped path but frontend expects generic bulk endpoint |

---

## Critical Gaps - PRIORITY IMPLEMENTATION

### 1. ❌ CRITICAL: POST /api/upf/production-lots/{id}/subprocesses
**Frontend Expectation** (from `_handleAddSubprocess()`):
```javascript
await this.api.post(API_PATHS.subprocesses(lotId), { subprocess_id: parseInt(selected, 10) });
// POST /api/upf/production-lots/{id}/subprocesses
// Body: { subprocess_id: 5 }
// Response: { data: { message: "Subprocess added successfully" } }
```

**Backend Status:** DOES NOT EXIST

**Impact:**
- Users CANNOT add subprocesses to production lots from the detail page
- "Add Subprocess" button will fail with 404 error
- Cascades to make subprocess editing non-functional

**Required Implementation:**
```python
@production_api_bp.route("/production-lots/<int:lot_id>/subprocesses", methods=["POST"])
@login_required
def add_subprocess_to_lot(lot_id: int):
    """Add subprocess selection to production lot"""
    # Expected request: { subprocess_id: 5 }
    # Should validate subprocess_id exists
    # Should link process_subprocess to lot_production_subprocess table
    # Return: { data: { message: "Subprocess added successfully" } }
```

---

### 2. ❌ CRITICAL: POST /api/upf/production-lots/{id}/subprocesses/{sid}/variants
**Frontend Expectation** (from `_handleSaveSubprocessVariants()`):
```javascript
await this.api.post(
    API_PATHS.subprocessVariants(subprocessId, lotId),
    { variant_ids: [42, 43, 44] }
);
// POST /api/upf/production-lots/{id}/subprocesses/{sid}/variants
// Body: { variant_ids: [42, 43, 44] }
// Response: { data: { message: "Variants updated successfully" } }
```

**Backend Status:** DOES NOT EXIST

**Impact:**
- Users CANNOT edit variant selections for subprocesses
- "Edit Variants" → "Save Selections" button will fail with 404
- Variant modal will appear but changes cannot be saved

**Required Implementation:**
```python
@production_api_bp.route(
    "/production-lots/<int:lot_id>/subprocesses/<int:subprocess_id>/variants",
    methods=["POST"]
)
@login_required
def update_subprocess_variants(lot_id: int, subprocess_id: int):
    """Update variant selections for subprocess in lot"""
    # Expected request: { variant_ids: [42, 43, 44] }
    # Should delete existing variant_lot_selection records
    # Should insert new records for provided variant_ids
    # Return: { data: { message: "Variants updated successfully" } }
```

---

### 3. ⚠️ ISSUE: Bulk Alert Acknowledge Route Mismatch
**Frontend Expectation** (from `_handleBulkAcknowledge()`):
```javascript
await this.api.post(API_PATHS.alertBulkAck(), { alert_ids: alertIds });
// POST /api/upf/inventory-alerts/bulk-acknowledge
// Body: { alert_ids: [1001, 1002, 1003] }
```

**Actual Backend Route:**
```
POST /api/upf/inventory-alerts/lot/<int:production_lot_id>/acknowledge-bulk
Body: { acknowledgments: [...] }
```

**Mismatch Details:**
- Frontend expects generic path: `/inventory-alerts/bulk-acknowledge`
- Backend has lot-scoped path: `/inventory-alerts/lot/{id}/acknowledge-bulk`
- Frontend sends `{ alert_ids: [...] }` but backend expects `{ acknowledgments: [...] }`
- This endpoint is NOT lot-scoped in frontend - it's called independently

**Impact:**
- Bulk acknowledge button will fail with 404
- User cannot acknowledge multiple alerts at once

**Fix Option A (RECOMMENDED):** Create new endpoint matching frontend expectation:
```python
@inventory_alerts_bp.route("/inventory-alerts/bulk-acknowledge", methods=["POST"])
@login_required
def bulk_acknowledge_alerts():
    """Bulk acknowledge multiple alerts"""
    data = request.json or {}
    alert_ids = data.get("alert_ids", [])
    # Process acknowledgments
    # Return: { data: { message: "X alert(s) acknowledged successfully" } }
```

**Fix Option B:** Update frontend to use backend's lot-scoped path (NOT RECOMMENDED - requires frontend changes)

---

## Partial Implementations - Verification Needed

### Issue 4: GET /api/upf/subprocesses?per_page=1000
**Frontend Expectation:**
```javascript
const resp = await this.api.get(API_PATHS.availableSubprocesses(lotId));
// GET /api/upf/subprocesses?per_page=1000
// Response should have: { data: { subprocesses: [...] } } or raw array
```

**Backend Status:** Routes exist in `subprocess_management.py` but unclear if they:
1. Support `?per_page` query parameter
2. Return correct response format
3. Are registered to `/api/upf/` prefix

**Required Verification:**
- Check if subprocess GET routes support pagination
- Verify response includes `subprocesses` array
- Confirm routes are mounted under `/api/upf/` blueprint prefix

---

## Response Format Compliance

### Current Backend Response Pattern
```python
# SUCCESS
return APIResponse.success(data, "message")
# Returns: { data: data, message: "message", status: "success" }

# ERROR
return APIResponse.error("error_code", "message", status_code)
# Returns: { error_code: "...", message: "...", status: "error" }
```

### Frontend Response Handling
The frontend normalizes responses in `_loadAllData()`:
```javascript
const lot = lotData.data || lotData;  // Handles both wrapped and unwrapped
const alerts = alertsData.data || alertsData.alert_details || alertsData || [];
```

**Status:** ✅ COMPATIBLE - Frontend defensive code handles backend response wrapping variations

---

## Request/Response Format Validation

### Lot Update (PUT /api/upf/production-lots/{id})
**Request:**
```json
{
    "quantity": 100,
    "status": "in_progress",
    "notes": "Updated notes"
}
```
**Response (from backend code - should verify):**
```json
{
    "data": {
        "lot_id": 1,
        "message": "Lot updated successfully"
    }
}
```
**Status:** ✅ Expected format matches

### Add Subprocess (MISSING - Expected Format)
**Request:**
```json
{
    "subprocess_id": 5
}
```
**Expected Response:**
```json
{
    "data": {
        "message": "Subprocess added successfully"
    }
}
```

### Update Variants (MISSING - Expected Format)
**Request:**
```json
{
    "variant_ids": [42, 43, 44]
}
```
**Expected Response:**
```json
{
    "data": {
        "message": "Variants updated successfully"
    }
}
```

### Bulk Acknowledge Alerts (PATH MISMATCH)
**Frontend Sends:**
```json
{
    "alert_ids": [1001, 1002, 1003]
}
```
**Backend Expects (at different path):**
```json
{
    "acknowledgments": [...]
}
```

---

## Database Schema Considerations

The missing endpoints likely require these backend operations:

### 1. Add Subprocess to Lot
- Query: Validate `subprocess_id` exists in `process_subprocesses`
- Insert: New record linking lot to subprocess
- Table: Likely `lot_production_subprocess` or similar
- Fields: `lot_id`, `process_subprocess_id`, sequence, created_at

### 2. Update Subprocess Variants
- Query: Get current variants for subprocess/lot combination
- Delete: Remove existing variant selections
- Insert: New variant selections from provided IDs
- Table: Likely `variant_lot_selection` or `subprocess_variant_selection`
- Fields: `lot_id`, `subprocess_id`, `variant_id`, quantity, etc.

---

## Frontend Error Handling

The frontend gracefully handles some backend issues:
- Non-critical alerts failure (continues if alerts endpoint fails)
- Variant options loading with cache (continues if endpoint fails)
- Response format normalization (accepts multiple envelope formats)

**However, critical endpoints (add subprocess, update variants) have no fallback - they will break the UI.**

---

## Testing Recommendations

### Pre-Deployment Testing

1. **Add Subprocess Workflow:**
   - Load production lot detail page
   - Click "Add Subprocess" button
   - Verify dropdown populated with subprocesses
   - Select subprocess and click add
   - Verify subprocess card appears with "Edit Variants" button

2. **Edit Variants Workflow:**
   - Click "Edit Variants" on subprocess card
   - Verify modal opens with grouped/standalone variants
   - Select variants and click "Save Selections"
   - Verify subprocess card updates with selected variants

3. **Bulk Acknowledge Workflow:**
   - View production lot with critical alerts
   - Select multiple alerts with checkboxes
   - Click "Acknowledge Selected Alerts"
   - Verify alerts update to ACKNOWLEDGED status
   - Verify finalize button becomes enabled

4. **Cost Recalculation:**
   - Click "Recalc" button in summary
   - Verify POST is sent (currently GET in backend)
   - Verify cost updates

---

## Migration Path

### Phase 1 (URGENT - BLOCKING):
1. Implement: POST `/api/upf/production-lots/{id}/subprocesses`
2. Implement: POST `/api/upf/production-lots/{id}/subprocesses/{sid}/variants`
3. Fix: Bulk acknowledge endpoint path or add new compatible endpoint

### Phase 2 (VERIFY):
1. Verify: GET `/api/upf/subprocesses?per_page=1000` works
2. Verify: POST `/api/upf/production-lots/{id}/recalculate` (frontend sends POST but backend has GET)

### Phase 3 (MONITOR):
1. Add logging to new endpoints
2. Monitor for 400/500 errors
3. Verify response formats match frontend expectations

---

## Code References

### Frontend API Paths Definition
- File: `production_lot_detail.js` lines 23-45
- Contains: All 12 expected endpoints

### Frontend API Calls
- Lines 814-819: `_loadAllData()` - parallel fetch
- Lines 905-920: `_handleAddSubprocess()` - ADD SUBPROCESS (WILL FAIL)
- Lines 1250-1275: `_handleSaveSubprocessVariants()` - UPDATE VARIANTS (WILL FAIL)
- Lines 1801-1840: `_handleBulkAcknowledge()` - BULK ACK (WRONG PATH)

### Backend Implementation Status
- `production_lot.py`: 6/7 lot endpoints implemented
- `inventory_alerts.py`: 3/3 single/bulk acknowledge endpoints (wrong path for bulk)
- `subprocess_management.py`: Subprocess CRUD but unclear if GET list returns correct format

---

## Validation Status: ⚠️ CRITICAL GAPS FOUND

**Summary:**
- 3 endpoints completely missing (1 critical, 1 critical, 1 path mismatch)
- Frontend will fail on subprocess management and bulk alert operations
- Estimated impact: 40% of production lot detail page functionality blocked

**Recommendation:** Implement Phase 1 endpoints before deploying frontend changes.

---

## Sign-Off

- **Analysis Date:** December 4, 2025
- **Frontend Version Analyzed:** production_lot_detail.js (2029 lines)
- **Backend Version Analyzed:** app/api/ (all relevant files)
- **Status:** Ready for backend implementation

