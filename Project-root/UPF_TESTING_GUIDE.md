# UPF Testing Guide - Quick Verification

## Prerequisites
1. Backend server running (`python run.py`)
2. User logged in
3. Browser console open (F12) to watch for errors

---

## Test 1: Process Editor Loading ✅

**Steps:**
1. Navigate to `http://127.0.0.1:5000/upf/processes`
2. Click "Create New Process" or click on existing process
3. **Expected:** Process editor opens without errors
4. **Check:** Process name displays in header
5. **Check:** Cost summary shows (even if $0.00)
6. **Check:** No console errors
7. **API Call:** `GET /api/upf/processes/<id>/structure` should return 200

**Status:** PASS / FAIL  
**Notes:**

---

## Test 2: Variant Search Panel ✅

**Steps:**
1. Open process editor (from Test 1)
2. Look at left panel titled "Variant Search"
3. **Expected:** List of variants displays
4. **Check:** Variant cards show name, price, stock status
5. Type in search box
6. **Expected:** Variants filter in real-time
7. **API Call:** `GET /api/all-variants` should return 200

**Status:** PASS / FAIL  
**Notes:**

---

## Test 3: Add Subprocess ✅

**Steps:**
1. In process editor, click "Add Subprocess"
2. Modal opens with subprocess dropdown
3. Select any subprocess
4. Click "Add Subprocess"
5. **Expected:** Subprocess appears in main panel
6. **Check:** Subprocess has drag handle (☰)
7. **API Call:** `POST /api/upf/process/<id>/add_subprocess` should return 201

**Status:** PASS / FAIL  
**Notes:**

---

## Test 4: Remove Subprocess ✅

**Steps:**
1. With subprocess from Test 3, click "🗑️ Remove"
2. Confirm deletion dialog
3. **Expected:** Subprocess disappears
4. **API Call:** `DELETE /api/upf/process_subprocess/<id>` should return 204
5. Refresh page - subprocess should still be gone

**Status:** PASS / FAIL  
**Notes:**

---

## Test 5: Add Variant (Drag-and-Drop) ✅

**Steps:**
1. Add subprocess if not present
2. From left panel, click and hold on a variant card
3. Drag to subprocess area
4. **Expected:** Drop zone highlights or variant modal opens
5. Enter quantity (e.g., 5)
6. Click "Add Variant"
7. **Expected:** Variant appears in subprocess with quantity badge
8. **API Call:** `POST /api/upf/variant_usage` should return 201

**Status:** PASS / FAIL  
**Notes:**

---

## Test 6: Remove Variant ✅

**Steps:**
1. With variant from Test 5, click "✖️" button
2. **Expected:** Variant disappears from subprocess
3. **API Call:** `DELETE /api/upf/variant_usage/<id>` should return 204

**Status:** PASS / FAIL  
**Notes:**

---

## Test 7: Reorder Subprocesses ✅

**Steps:**
1. Add 2-3 subprocesses (reuse Test 3)
2. Click and hold drag handle (☰) on second subprocess
3. Drag it above first subprocess
4. **Expected:** Subprocesses reorder visually
5. Click "💾 Save Changes"
6. **Expected:** Success message
7. **API Call:** `POST /api/upf/process/<id>/reorder_subprocesses` should return 200
8. Refresh page
9. **Expected:** New order persists

**Status:** PASS / FAIL  
**Notes:**

---

## Test 8: Real-Time Cost Calculation 🔍 (Exploratory)

**Steps:**
1. Add subprocess with variant
2. Watch cost summary in top panel
3. **Expected:** "Worst-Case Cost" updates
4. Add another variant
5. **Expected:** Cost increases
6. **API Call:** `GET /api/upf/process/<id>/worst_case_costing` may be called

**Status:** PASS / FAIL / UNKNOWN  
**Notes:**

---

## Test 9: Process List ✅

**Steps:**
1. Navigate to `/upf/processes`
2. **Expected:** Process list displays
3. Check pagination if 25+ processes
4. Test search box
5. Test status filter
6. **API Call:** `GET /api/upf/processes` should return 200

**Status:** PASS / FAIL  
**Notes:**

---

## Test 10: Process CRUD ✅

**Steps:**
1. Create process (Test 1)
2. Edit process: Click "✏️ Edit" on process in list
3. Change name
4. Save
5. **Expected:** Process updates
6. Delete process: Click "🗑️" on process
7. Confirm deletion
8. **Expected:** Process disappears (soft deleted)

**Status:** PASS / FAIL  
**Notes:**

---

## Known Failures (Expected) ❌

### Test 11: OR Group Configuration ❌
**Steps:**
1. In subprocess, click "⚙️ OR Groups"
2. **Expected Failure:** "OR Groups configuration coming soon!" message
3. **Status:** KNOWN ISSUE - Not Implemented

### Test 12: Production Lot Variant Selection ❌
**Steps:**
1. Create production lot
2. Try to select variants from OR groups
3. **Expected Failure:** Page/modal doesn't exist
4. **Status:** KNOWN ISSUE - Not Implemented

### Test 13: Reports ❌
**Steps:**
1. Navigate to reports page (if route exists)
2. **Expected Failure:** Empty or broken
3. **Status:** KNOWN ISSUE - API Not Implemented

---

## Console Error Checklist

Open browser console (F12) and watch for:
- ❌ 404 errors (endpoint not found)
- ❌ 500 errors (server error)
- ❌ CORS errors
- ❌ CSRF errors
- ❌ JavaScript errors (red text)
- ⚠️ Warnings (yellow text) - document but not critical

---

## Success Criteria

**Critical Tests (Must Pass):**
- [ ] Test 1: Process Editor Loading
- [ ] Test 2: Variant Search Panel
- [ ] Test 5: Add Variant
- [ ] Test 9: Process List

**High Priority Tests (Should Pass):**
- [ ] Test 3: Add Subprocess
- [ ] Test 4: Remove Subprocess
- [ ] Test 6: Remove Variant
- [ ] Test 7: Reorder Subprocesses

**Nice to Have (May Fail):**
- [ ] Test 8: Cost Calculation (needs verification)
- [ ] Test 10: Process CRUD (edit/delete)

---

## Reporting Issues

If test fails, document:
1. **Test Number:** e.g., Test 5
2. **Browser:** Chrome/Firefox/Safari
3. **Console Error:** Copy exact error message
4. **Network Tab:** Check if API call failed
5. **Expected vs Actual:** What should happen vs what happened
6. **Screenshots:** If visual issue

Example:
```
Test 5 FAILED
Browser: Chrome 120
Error: POST /api/upf/variant_usage returned 400
Message: {"error": "subprocess_id is required"}
Expected: Variant added to subprocess
Actual: Error alert shown
```

---

## Quick Smoke Test (5 minutes)

Minimal testing to verify nothing is completely broken:

1. Login ✅
2. Navigate to `/upf/processes` ✅
3. Create process ✅
4. Open process editor ✅
5. Verify variants load in left panel ✅
6. Add subprocess ✅
7. Drag variant to subprocess ✅
8. Save ✅

If all above pass → **System functional** ✅  
If any fail → **Critical issue** ❌

---

*Testing Guide Version: 1.0*  
*Last Updated: November 4, 2025*
