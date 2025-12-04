# UPF COMPREHENSIVE REPAIR - DETAILED FIXES

## Summary of Fixes Applied

### Fix 1: Process Editor - Reorder Subprocesses URL ✅ APPLIED
**File:** `static/js/process_editor.js` line 864
**Change:** `/api/upf/process/` → `/api/upf/processes/` (singular to plural)
**Status:** FIXED

### Fix 2: Response Data Structure Handling
**Issue:** Frontend accesses `response.data.items` but backend returns `response.data`
**Files Affected:**
  - `upf_api_client.js` - Lines 182 (getProcesses method)
  - `process_framework_unified.js` - Multiple locations

**Current Code:**
```javascript
return data.data?.processes || data.processes || [];
```

**Status:** ✅ Already handles fallbacks correctly

### Fix 3: Variant Usage ID Tracking
**Issue:** Frontend needs to track `usage_id` for deletion
**Solution:** 
- Backend already returns `id` in variant_usage responses ✅
- Frontend needs to store this ID when adding variants
- When deleting: use `DELETE /api/upf/variant_usage/{id}`

**Files to verify:**
- `process_editor.js` - Variant addition handler (line 630+)
- `production_lot_detail.js` - Variant selection handlers
- `process_framework_unified.js` - Variant management (line 1662+)

**Status:** ⚠️ Need to verify storage and retrieval of usage_id

### Fix 4: Production Lot API URLs
**Issue:** URLs use hyphenated format `/production-lots`
**Verification:** ✅ Correct throughout codebase

### Fix 5: Cost Item Field Naming
**Issue:** Frontend may send `rate` but backend expects `amount`
**Files:** `cost_calculator.js`, `process_editor.js`
**Status:** ⚠️ Need to standardize field name

### Fix 6: Reports API
**Issue:** `upf_reports.js` calls non-existent endpoints
**Solution:** Either implement endpoints or route to existing data
**Status:** ❌ NOT YET FIXED

---

## REMAINING CRITICAL ISSUES

1. **Variant Usage ID Storage** - Frontend may not properly store/retrieve usage_id
2. **Reports Endpoints** - Missing implementation
3. **Error Handling** - Incomplete error messages in frontend
4. **Response Format** - Standardize across all endpoints

---

## TESTING STRATEGY

After fixes, run through this workflow:

1. **Create Process**
   - POST /api/upf/processes with name, description, class
   - Verify response includes id

2. **Add Subprocess**
   - POST /api/upf/processes/{id}/subprocesses with subprocess_id, sequence_order
   - Verify response includes process_subprocess_id

3. **Add Variant to Subprocess**
   - POST /api/upf/variant_usage with subprocess_id, item_id, quantity
   - Verify response includes id (usage_id)
   - Store id for deletion

4. **Reorder Subprocesses**
   - POST /api/upf/processes/{id}/reorder_subprocesses with sequence_map
   - Verify order changes

5. **Remove Variant**
   - DELETE /api/upf/variant_usage/{usage_id} (using stored id)
   - Verify variant removed

6. **Production Lot**
   - POST /api/upf/production-lots with process_id, quantity
   - GET /api/upf/production-lots/{id} 
   - Verify lot details

---

## NOTES

Most API endpoints are correctly implemented and match frontend expectations. The main issues are:

1. Minor URL path differences (mostly fixed)
2. Response data structure handling (mostly handled)
3. Variant usage ID tracking (needs verification)
4. Missing reports endpoints (needs implementation)

The backend is generally **production-ready**, frontend needs minor adjustments.

