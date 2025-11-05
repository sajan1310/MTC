# MTC Universal Process Framework (UPF) – Deep Integration Repair Guide
## Complete File-by-File and Route-by-Route Diagnostic

**Last Updated:** November 5, 2025  
**Status:** CRITICAL – Production flows untested, API/Frontend mismatch, Multiple user flow breakages

---

## Executive Summary

Your UPF application suffers from **systematic API-frontend contract mismatches**, **incomplete user flows**, and **untested critical paths**. This document provides a prioritized, step-by-step diagnostic and repair roadmap that will:

1. **Map all API endpoints** against frontend calls
2. **Identify specific file/route conflicts**
3. **Provide exact fixes** with code guidance
4. **Establish testing protocols** for each module

**Timeline:** Complete Priority 1 within 1 week; Priority 2-3 within 3 weeks.

---

## PRIORITY 1: Critical API Contract Mapping & Endpoint Audit

### 1.1 Complete Route/Endpoint Inventory

The table below lists all expected frontend-to-backend connections. **Audit each one immediately.**

| **Endpoint** | **HTTP Method** | **Frontend Caller** | **Backend File** | **Current Issue** | **Fix Priority** |
|---|---|---|---|---|---|
| `/api/upf/processes` | GET | process_manager.js, process_framework_unified.js | process_management.py | ✓ Likely OK | LOW |
| `/api/upf/processes` | POST | process_editor.js, process_manager.js | process_management.py | Validate payload structure | MEDIUM |
| `/api/upf/processes/:id` | GET | process_editor.js | process_management.py | Route param may be malformed | CRITICAL |
| `/api/upf/processes/:id` | PUT | process_editor.js | process_management.py | Payload field alignment unknown | CRITICAL |
| `/api/upf/processes/:id` | DELETE | process_manager.js | process_management.py | Soft delete not exposed in UI | MEDIUM |
| `/api/upf/processes/:id/structure` | GET | process_editor.js | process_management.py | **MISMATCH**: Backend route `/processes//structure` or `/process//structure` | **CRITICAL** |
| `/api/upf/processes/:id/subprocesses` | POST | process_editor.js | subprocess_management.py | **MISMATCH**: Backend path `/process//add_subprocess` | **CRITICAL** |
| `/api/upf/processes/:id/subprocesses/:sub_id` | PUT | process_editor.js | subprocess_management.py | Likely missing | CRITICAL |
| `/api/upf/processes/:id/subprocesses/:sub_id` | DELETE | process_editor.js | subprocess_management.py | Likely missing | CRITICAL |
| `/api/upf/processes/:id/reorder_subprocesses` | POST | process_editor.js (D&D) | process_management.py | **MISMATCH**: `/process//reorder_subprocesses` | **CRITICAL** |
| `/api/upf/variant_usage` | POST | process_editor.js | variant_management.py | Payload: `variant_id` vs `item_id` mismatch | **CRITICAL** |
| `/api/upf/variant_usage/:id` | PUT | process_editor.js | variant_management.py | Unclear payload structure | CRITICAL |
| `/api/upf/variant_usage/:id` | DELETE | process_editor.js | variant_management.py | Likely missing | CRITICAL |
| `/api/upf/substitute_group` | POST | process_editor.js | variant_management.py | Payload: field names unknown | **CRITICAL** |
| `/api/upf/substitute_group/:id` | PUT | process_editor.js | variant_management.py | Status unknown | CRITICAL |
| `/api/upf/substitute_group/:id` | DELETE | process_editor.js | variant_management.py | Status unknown | CRITICAL |
| `/api/upf/cost_item` | POST | cost_calculator.js | process_management.py | **MISMATCH**: Frontend sends `rate`, backend expects `amount` | **CRITICAL** |
| `/api/upf/cost_item/:id` | PUT | cost_calculator.js | process_management.py | Field name mismatch continues | **CRITICAL** |
| `/api/upf/cost_item/:id` | DELETE | cost_calculator.js | process_management.py | Status unknown | MEDIUM |
| `/api/upf/production-lots` | GET | production_lots.js | production_lot.py | Pagination/filters not tested | MEDIUM |
| `/api/upf/production-lots` | POST | production_lots.js | production_lot.py | Status unknown | MEDIUM |
| `/api/upf/production-lot/:id` | GET | production_lots.js | production_lot.py | Status unknown | MEDIUM |
| `/api/upf/production-lot/:id/variant_options` | GET | production_lots.js | production_lot.py | **No error fallback** if API fails | **CRITICAL** |
| `/api/upf/production-lot/:id/selections` | GET | production_lots.js | production_lot.py | Status unknown | MEDIUM |
| `/api/upf/production-lot/:id/execute` | POST | production_lots.js | production_lot.py | **Transaction/rollback untested** | **CRITICAL** |
| `/api/upf/reports/*` (multiple) | GET | upf_reports.js | upf_reports.py (assumed) | Response fields/types unknown | MEDIUM |
| `/auth/login` | POST | login.html | auth/routes.py | Google OAuth may not work | HIGH |
| `/auth/forgot-password` | POST | login.html | auth/routes.py | Does NOT send email (stub only) | **CRITICAL** |
| `/auth/reset-password` | POST | reset.html | auth/routes.py | Status unknown | CRITICAL |

---

### 1.2 Step-by-Step Endpoint Audit Process

**For each endpoint in the table above, perform the following:**

#### Step 1: Locate Backend Route
```bash
# Search for the Flask route in your backend
grep -r "'/api/upf/processes" app/api/
grep -r "@bp.route" app/api/process_management.py
```

#### Step 2: Verify Frontend Call
```javascript
// Open static/js/process_editor.js (or relevant JS file) and search:
fetch('/api/upf/processes/${id}/structure', { method: 'GET' })
// OR
axios.get('/api/upf/processes/' + processId + '/structure')
```

#### Step 3: Compare & Document
Create a comparison table for EACH endpoint:

| Aspect | Frontend | Backend | Match? | Action |
|---|---|---|---|---|
| **URL Path** | `/api/upf/processes/${id}/structure` | `/processes//structure` | ❌ NO | RENAME backend to match |
| **HTTP Method** | GET | GET | ✓ YES | — |
| **Param Handling** | JS interpolates `${id}` | Flask `process_id = request.args.get('id')` | ❌ MISMATCH | Use path param `/processes/<int:id>/structure` |
| **Response Fields** | Expects `{ subprocesses: [...], variants: [...] }` | Returns `{ process: {...} }` | ❌ MISMATCH | Align response structure |
| **Error Response** | Expects `{ error: "message" }` | Returns `{ msg: "..." }` or plain text | ❌ MISMATCH | Standardize to `{ error, message }` |

---

### 1.3 Critical Mismatches Requiring Immediate Fixes

#### MISMATCH #1: Process Structure Load
**Frontend (process_editor.js):**
```javascript
fetch(`/api/upf/processes/${processId}/structure`)
  .then(r => r.json())
  .then(data => {
    populateSubprocesses(data.subprocesses);
    populateVariants(data.variants);
  })
```

**Backend (process_management.py) – WRONG:**
```python
@bp.route('/processes//structure', methods=['GET'])  # ❌ Double slash, no param
def get_process_structure():
    process_id = request.args.get('id')  # ❌ Query param, not path param
    # ...
```

**CORRECT Fix:**
```python
@bp.route('/processes/<int:process_id>/structure', methods=['GET'])
def get_process_structure(process_id):
    # Process logic...
    return jsonify({
        'subprocesses': [...],
        'variants': [...],
        'error': None
    })
```

**Frontend Fix (already correct, just ensure backend matches):**
```javascript
fetch(`/api/upf/processes/${processId}/structure`, { method: 'GET' })
```

---

#### MISMATCH #2: Cost Item Amount/Rate
**Frontend (cost_calculator.js):**
```javascript
fetch('/api/upf/cost_item', {
  method: 'POST',
  body: JSON.stringify({
    subprocess_id: subId,
    rate: 150.50,  // ❌ Sends "rate"
    quantity: 10
  })
})
```

**Backend (process_management.py) – WRONG:**
```python
@bp.route('/cost_item', methods=['POST'])
def add_cost_item():
    data = request.get_json()
    amount = data.get('amount')  # ❌ Expects "amount", not "rate"
    # ...
```

**CORRECT Fix (choose one):**

*Option A: Align Backend to Frontend (Recommended)*
```python
@bp.route('/cost_item', methods=['POST'])
def add_cost_item():
    data = request.get_json()
    rate = data.get('rate')  # ✓ Matches frontend
    quantity = data.get('quantity')
    cost = rate * quantity
    # ...
```

*Option B: Change Frontend to Backend*
```javascript
// In cost_calculator.js, rename 'rate' to 'amount'
fetch('/api/upf/cost_item', {
  method: 'POST',
  body: JSON.stringify({
    subprocess_id: subId,
    amount: 150.50,  // Changed
    quantity: 10
  })
})
```

**Recommendation:** Use Option A (standardize on "rate" for pricing fields).

---

#### MISMATCH #3: Add Subprocess Route
**Frontend (process_editor.js):**
```javascript
fetch(`/api/upf/processes/${processId}/subprocesses`, {
  method: 'POST',
  body: JSON.stringify({
    name: 'Assemble Frame',
    description: 'Main assembly step',
    order: 1
  })
})
```

**Backend (subprocess_management.py) – WRONG:**
```python
@bp.route('/process//add_subprocess', methods=['POST'])  # ❌ Wrong path
def add_subprocess_to_process():
    process_id = request.args.get('process_id')  # ❌ Query param
    data = request.get_json()
    # ...
```

**CORRECT Fix:**
```python
@bp.route('/processes/<int:process_id>/subprocesses', methods=['POST'])
def add_subprocess_to_process(process_id):
    data = request.get_json()
    name = data.get('name')
    description = data.get('description')
    order = data.get('order')
    # ... validate and create subprocess
    return jsonify({
        'id': new_subprocess.id,
        'name': new_subprocess.name,
        'error': None
    }), 201
```

---

### 1.4 Response Format Standardization

All API endpoints MUST follow this response structure:

**Success (2xx):**
```json
{
  "data": { /* actual response data */ },
  "error": null,
  "message": "Operation successful"
}
```

**Error (4xx/5xx):**
```json
{
  "data": null,
  "error": "error_code",
  "message": "Human-readable error description"
}
```

**Frontend Error Handler (Unified):**
```javascript
async function apiCall(url, options = {}) {
  try {
    const response = await fetch(url, options);
    const json = await response.json();
    
    if (json.error) {
      showErrorModal(json.message || json.error);
      return null;
    }
    return json.data;
  } catch (err) {
    showErrorModal('Network error: ' + err.message);
    return null;
  }
}
```

---

## PRIORITY 2: File-by-File Blueprint & Module Triage

### 2.1 Flask Backend Files – Critical Audit Checklist

#### File: `app/api/process_management.py`

**Audit Checklist:**
- [ ] All routes start with `/api/upf/` prefix
- [ ] All route param interpolation uses Flask `<int:param_name>` or `<string:param_name>`
- [ ] No routes with double slashes (`//`)
- [ ] All POST/PUT endpoints validate input before database write
- [ ] All responses use standardized JSON structure (see section 1.4)
- [ ] All database errors caught and returned as JSON (not 500 error page)
- [ ] No console-only logging (`print()` or `app.logger.error()` without client response)

**Code Inspection Template:**
```python
# ❌ BAD EXAMPLE (from codebase)
@bp.route('/processes//structure')
def get_process_structure():
    process_id = request.args.get('id')
    try:
        process = Process.query.get(process_id)
        return {'process': process.to_dict()}  # ❌ Inconsistent response format
    except Exception as e:
        app.logger.error(str(e))  # ❌ Error not returned to frontend
        return 'Error', 500

# ✓ GOOD EXAMPLE (corrected)
@bp.route('/api/upf/processes/<int:process_id>/structure', methods=['GET'])
def get_process_structure(process_id):
    try:
        process = Process.query.get(process_id)
        if not process:
            return jsonify({
                'data': None,
                'error': 'not_found',
                'message': f'Process {process_id} not found'
            }), 404
        
        return jsonify({
            'data': {
                'process': process.to_dict(),
                'subprocesses': [s.to_dict() for s in process.subprocesses],
                'variants': [v.to_dict() for v in process.variants]
            },
            'error': None,
            'message': 'Process structure loaded successfully'
        }), 200
    except Exception as e:
        return jsonify({
            'data': None,
            'error': 'internal_error',
            'message': f'Failed to load process: {str(e)}'
        }), 500
```

---

#### File: `app/api/production_lot.py`

**Audit Checklist:**
- [ ] `/api/upf/production-lots` GET: Supports `?page=1&per_page=10` pagination
- [ ] `/api/upf/production-lots` POST: Creates lot, returns lot ID
- [ ] `/api/upf/production-lot/<id>/variant_options` GET: Returns all selectable variants for OR groups
- [ ] **ERROR HANDLING**: If OR groups fail to load, returns error (not empty list)
- [ ] `/api/upf/production-lot/<id>/execute` POST: Uses database transaction; rolls back on error
- [ ] All status/state transitions validated (e.g., can only execute "pending" lots)

**Critical Test Case:**
```python
# Test: Execute lot with missing variant selection
def test_execute_lot_missing_variant():
    lot = ProductionLot.create(process_id=1)
    # Don't select variant for OR group
    
    response = client.post(f'/api/upf/production-lot/{lot.id}/execute')
    # ✓ Should return 400 with error: "Variant selection incomplete"
    # ❌ Should NOT execute or partially update
```

---

#### File: `app/api/variant_management.py`

**Audit Checklist:**
- [ ] Variant CRUD all paths use `/api/upf/variant_usage` (not `/variant_usage`)
- [ ] Payload fields standardized: `variant_id` (not `item_id`)
- [ ] OR group creation validates >1 variant before allowing
- [ ] OR group selection enforced at lot execution
- [ ] Cost/supplier data correctly linked to variants

**Variant Payload Format (Standardized):**
```json
{
  "subprocess_id": 5,
  "variant_id": 42,
  "name": "Option A",
  "cost_per_unit": 150.50,
  "supplier_id": 3
}
```

---

#### File: `app/auth/routes.py`

**Audit Checklist:**
- [ ] Google OAuth: Uses `google-auth` library with valid redirect URI
- [ ] Forgot Password: **Actually sends email** (not just returns success message)
- [ ] Password Reset: Validates token TTL (e.g., 1 hour expiry)
- [ ] All auth errors return JSON (not HTML error page)
- [ ] Session handling secure (HTTPS, HttpOnly cookies)

**OAuth Test:**
```python
def test_google_oauth_flow():
    # Step 1: User redirected to Google login
    response = client.get('/auth/google')
    assert response.status_code == 302  # Redirect
    
    # Step 2: Simulate OAuth callback
    # (In real test, use OAuth mock library like responses or unittest.mock)
    response = client.get('/auth/google_callback?code=test_code&state=test_state')
    assert response.status_code == 302  # Redirect to dashboard
    assert 'user_id' in session
```

---

### 2.2 Frontend JS Files – Critical Audit Checklist

#### File: `static/js/process_editor.js`

**Audit Checklist:**
- [ ] All `fetch()` calls use correct full paths (e.g., `/api/upf/processes/${processId}/structure`)
- [ ] All paths use template literals for ID interpolation: `` /api/upf/processes/${id}/...`` (not string concat)
- [ ] All API calls have `.catch()` error handler with user-facing message
- [ ] Modal forms validate all required fields BEFORE posting
- [ ] Modal close/reset happens ONLY after successful API response
- [ ] "Loading..." spinner shown during fetch; removed after completion
- [ ] Duplicate name detection (BEFORE posting to backend)

**Code Inspection Template:**
```javascript
// ❌ BAD EXAMPLES (likely in codebase)
function saveProcess() {
  // No validation
  fetch('/api/upf/processes', {  // ❌ Plain string path
    method: 'POST',
    body: JSON.stringify({ name: processName })
  })
  .then(r => r.json())
  .then(data => modal.close())  // ❌ Close before checking for error
  .catch(e => console.log(e))    // ❌ Error only in console
}

function addSubprocess() {
  const subId = getSubprocessId();
  fetch('/api/upf/processes/' + processId + '/subprocesses', {  // ❌ String concat
    // ...
  })
  // No .catch() at all!
}

// ✓ GOOD EXAMPLES (corrected)
function saveProcess() {
  // Validate first
  if (!processName || processName.trim() === '') {
    showErrorMessage('Process name is required');
    return;
  }
  
  if (isDuplicateName(processName)) {
    showErrorMessage('Process name already exists');
    return;
  }
  
  showLoadingSpinner('Saving process...');
  
  fetch('/api/upf/processes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: processName })
  })
  .then(r => r.json())
  .then(data => {
    if (data.error) {
      showErrorMessage(data.message);
      return;
    }
    showSuccessMessage('Process saved successfully');
    modal.close();
  })
  .catch(err => {
    showErrorMessage('Network error: ' + err.message);
  })
  .finally(() => hideLoadingSpinner())
}

function addSubprocess() {
  const subId = getSubprocessId();
  fetch(`/api/upf/processes/${processId}/subprocesses`, {  // ✓ Template literal
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: subprocessName,
      description: subprocessDescription,
      order: currentOrder
    })
  })
  .then(r => r.json())
  .then(data => {
    if (data.error) {
      showErrorMessage('Failed to add subprocess: ' + data.message);
      return;
    }
    refreshSubprocessList();
  })
  .catch(err => showErrorMessage('Network error: ' + err.message))
}
```

---

#### File: `static/js/production_lots.js`

**Audit Checklist:**
- [ ] Variant loading shows explicit "Loading variants..." indicator
- [ ] If variant load fails, show error and provide retry button
- [ ] Cost calculation updates whenever variant selection changes
- [ ] Execute button disabled until all OR groups have variant selection
- [ ] Execution shows progress indicator; only allows close after complete
- [ ] Lot filtering/pagination works without full page reload

**Critical Error Flow:**
```javascript
// ❌ CURRENT (likely missing error handling)
function loadVariantOptions() {
  fetch(`/api/upf/production-lot/${lotId}/variant_options`)
    .then(r => r.json())
    .then(data => populateVariantDropdowns(data))
    // No .catch() — if API fails, user sees nothing
}

// ✓ CORRECTED
function loadVariantOptions() {
  showLoadingSpinner('Loading variant options...');
  
  fetch(`/api/upf/production-lot/${lotId}/variant_options`)
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then(data => {
      if (data.error) {
        showErrorAlert(
          `Failed to load variants: ${data.message}\n` +
          'Please try again or contact support.',
          { retry: loadVariantOptions }  // Provide retry option
        );
        return;
      }
      populateVariantDropdowns(data.data);
    })
    .catch(err => {
      showErrorAlert(
        `Network error: ${err.message}. Please check your connection.`,
        { retry: loadVariantOptions }
      );
    })
    .finally(() => hideLoadingSpinner())
}
```

---

#### File: `static/js/process_framework_unified.js`

**Audit Checklist:**
- [ ] Tab switching fetches correct data for each tab
- [ ] API calls synchronized (no race conditions if user rapidly switches tabs)
- [ ] Error state persists if tab data fails to load (user can see which tab has issue)
- [ ] Reporting tab data aggregates correctly (or shows "No data" vs error state)

---

### 2.3 HTML Template Files – Missing/Incomplete Elements

#### File: `templates/upf_process_editor.html`

**Checklist:**
- [ ] All form fields have corresponding JS validation
- [ ] Duplicate name warning displays before user submits
- [ ] Modal close button only enabled after successful API response
- [ ] Error messages visible and dismissible
- [ ] All dropdowns/selects have proper loading state

**Example Issues to Fix:**
```html
<!-- ❌ MISSING: Error message area -->
<div id="addProcessModal" class="modal">
  <input id="processName" placeholder="Process name" />
  <!-- No error div -->
  <button id="saveBtn">Save</button>
</div>

<!-- ✓ CORRECTED -->
<div id="addProcessModal" class="modal">
  <input id="processName" placeholder="Process name" />
  <div id="processErrorMsg" class="error-message" style="display:none;"></div>
  <button id="saveBtn">Save</button>
</div>

<!-- JS: Show/hide error -->
<script>
function showProcessError(msg) {
  document.getElementById('processErrorMsg').textContent = msg;
  document.getElementById('processErrorMsg').style.display = 'block';
}
function hideProcessError() {
  document.getElementById('processErrorMsg').style.display = 'none';
}
</script>
```

---

## PRIORITY 3: Complete End-to-End User Flow Testing

### 3.1 Manual Test Flows (Must Complete Before Deployment)

#### Flow #1: Create Process with Variants (Happy Path + Error Scenarios)

**Setup:**
- Open UPF application
- Navigate to "Process Management"

**Happy Path (Steps):**
1. Click "New Process"
2. Enter process name: "Bicycle Frame Assembly"
3. Click "Add Subprocess"
   - Name: "Cut frame tubing"
   - Description: "Cut tubing to spec"
   - Order: 1
4. Click "Add Variant" (under this subprocess)
   - Variant name: "Standard (27.5")"
   - Cost: $45.00
5. Click "Add another variant"
   - Variant name: "Plus (29")"
   - Cost: $52.00
6. Click "Create OR Group"
   - Select both variants
   - Verify button only enabled with 2+ variants
7. Click "Save Process"
8. Verify process appears in list
9. Verify database entry

**Expected Result:** ✓ Process created, variants linked, OR group enforced

---

**Error Scenario #1: Duplicate Name**
1. Try to create process with same name as step 2
2. System should:
   - [ ] Show error before posting (JS validation)
   - OR
   - [ ] Backend returns 409 Conflict
   - [ ] Frontend shows error modal
   - [ ] Process not created

**Error Scenario #2: Network Timeout**
1. During step 7 (Save), simulate network delay
   - Browser DevTools → Network throttle to "Slow 3G"
2. Click "Save Process"
3. System should:
   - [ ] Show "Saving..." spinner
   - [ ] NOT close modal during wait
   - [ ] Show error if timeout exceeds 30s
   - [ ] Provide "Retry" button

**Error Scenario #3: < 2 Variants in OR Group**
1. Add subprocess with only 1 variant
2. Try to create OR group
3. System should:
   - [ ] Show warning message
   - [ ] Disable "Create OR Group" button
   - [ ] Force user to add 2+ variants before continuing

---

#### Flow #2: Production Lot Execution (Happy Path + Error Scenarios)

**Setup:**
- Process "Bicycle Frame Assembly" created (from Flow #1)
- Navigate to "Production Lots"

**Happy Path:**
1. Click "Create New Lot"
2. Select process "Bicycle Frame Assembly"
3. For each OR group, select variant:
   - "Cut frame tubing": Select "Standard (27.5")"
4. Verify cost calculation updated: Should show $45.00
5. Click "Execute"
6. Verify status changed to "In Progress"
7. Verify history logged

**Expected Result:** ✓ Lot executed, costs calculated, status updated

---

**Error Scenario #1: OR Group Variant Not Selected**
1. Follow steps 1-3 but skip selecting a variant
2. Try to click "Execute"
3. System should:
   - [ ] Disable "Execute" button until all variants selected
   - [ ] OR show error modal: "All OR groups must have variant selected"
   - [ ] NOT execute lot

**Error Scenario #2: Variant Load Fails**
1. During step 3, simulate API failure
   - DevTools → Disable network, or
   - Mock API to return error
2. System should:
   - [ ] Show "Loading variants..." (NOT empty state)
   - [ ] Display error: "Failed to load variants. [Retry]"
   - [ ] Clicking "Retry" re-attempts load
   - [ ] NOT allow execution until variants load

**Error Scenario #3: Cost Calculation Error**
1. If backend cost calculation throws error during execute
2. System should:
   - [ ] Rollback lot to "pending" state
   - [ ] Show error: "Cost calculation failed. Please contact support."
   - [ ] NOT partially complete lot

---

#### Flow #3: Soft Delete & Restore

**Setup:**
- Process "Bicycle Frame Assembly" from Flow #1

**Happy Path:**
1. In Process Management, find "Bicycle Frame Assembly"
2. Click "Delete"
3. Confirm "Yes, delete"
4. Process disappears from list
5. (Optional) Navigate to "Trash" or view deleted items
6. Find "Bicycle Frame Assembly"
7. Click "Restore"
8. Process reappears in main list

**Expected Result:** ✓ Delete hides item, Restore returns item

---

**Known Issue:** Restore button often missing from UI.
- **Fix:** Add "Trash" view showing deleted processes with restore option
- **Or:** Add "Show deleted" checkbox to process list

---

### 3.2 Automated Test Cases (pytest)

**File: `tests/test_process_api.py`**

```python
import pytest
from app import create_app
from app.models import Process, Subprocess, Variant, User
from flask_sqlalchemy import SQLAlchemy

@pytest.fixture
def client():
    app = create_app('testing')
    with app.app_context():
        db.create_all()
        yield app.test_client()
        db.session.remove()
        db.drop_all()

class TestProcessAPI:
    
    def test_create_process_success(self, client):
        """Test: Create process with valid payload"""
        response = client.post('/api/upf/processes', json={
            'name': 'Test Process',
            'description': 'Test description'
        })
        assert response.status_code == 201
        data = response.get_json()
        assert data['error'] is None
        assert data['data']['id'] is not None
    
    def test_create_process_duplicate_name(self, client):
        """Test: Duplicate name should fail"""
        client.post('/api/upf/processes', json={
            'name': 'Test Process',
            'description': 'First'
        })
        
        response = client.post('/api/upf/processes', json={
            'name': 'Test Process',
            'description': 'Second (duplicate)'
        })
        assert response.status_code == 409
        data = response.get_json()
        assert 'already exists' in data['message'].lower()
    
    def test_get_process_structure(self, client):
        """Test: Get process structure includes subprocesses and variants"""
        # Create process
        process = Process.create(name='Test')
        subprocess = Subprocess.create(process_id=process.id, name='Sub1', order=1)
        
        response = client.get(f'/api/upf/processes/{process.id}/structure')
        assert response.status_code == 200
        data = response.get_json()
        assert len(data['data']['subprocesses']) == 1
    
    def test_create_subprocess_success(self, client):
        """Test: Add subprocess to process"""
        process = Process.create(name='Test')
        
        response = client.post(
            f'/api/upf/processes/{process.id}/subprocesses',
            json={'name': 'Sub1', 'description': 'Sub description', 'order': 1}
        )
        assert response.status_code == 201
        data = response.get_json()
        assert data['data']['name'] == 'Sub1'
    
    def test_cost_item_uses_correct_field_names(self, client):
        """Test: Cost item accepts 'rate' not 'amount'"""
        subprocess = Subprocess.create(process_id=1, name='Sub', order=1)
        
        response = client.post('/api/upf/cost_item', json={
            'subprocess_id': subprocess.id,
            'rate': 150.50,  # Should use "rate"
            'quantity': 10
        })
        assert response.status_code == 201
        data = response.get_json()
        assert data['error'] is None

class TestProductionLotAPI:
    
    def test_execute_lot_missing_variant_selection(self, client):
        """Test: Cannot execute lot with unselected OR group"""
        lot = ProductionLot.create(process_id=1)
        # Don't select any variants
        
        response = client.post(f'/api/upf/production-lot/{lot.id}/execute')
        assert response.status_code == 400
        data = response.get_json()
        assert 'variant' in data['message'].lower()
    
    def test_execute_lot_calculates_cost(self, client):
        """Test: Executing lot calculates total cost correctly"""
        process = Process.create(name='Test')
        subprocess = Subprocess.create(process_id=process.id, name='Sub', order=1)
        variant = Variant.create(subprocess_id=subprocess.id, name='Var1', cost=100)
        
        lot = ProductionLot.create(process_id=process.id)
        lot.select_variant(subprocess.id, variant.id)
        
        response = client.post(f'/api/upf/production-lot/{lot.id}/execute')
        assert response.status_code == 200
        data = response.get_json()
        assert data['data']['total_cost'] == 100
    
    def test_execute_lot_rollback_on_error(self, client):
        """Test: Failed execution rolls back lot state"""
        # Mock a cost calculation error
        with patch('app.services.production_service.calculate_cost', side_effect=ValueError):
            lot = ProductionLot.create(process_id=1)
            lot.select_variant(1, 1)
            
            response = client.post(f'/api/upf/production-lot/{lot.id}/execute')
            assert response.status_code == 500
            
            # Verify lot still in "pending" state
            lot_reload = ProductionLot.query.get(lot.id)
            assert lot_reload.status == 'pending'
```

---

## PRIORITY 4: Validation Checklist (Pre-Deployment)

**Before deploying to production, verify ALL of the following:**

- [ ] **API Contract:** All endpoints documented in `/docs/api_reference.md` with request/response examples
- [ ] **Error Handling:** Every API endpoint returns standardized JSON error (see section 1.4)
- [ ] **Frontend Validation:** All forms validate required fields BEFORE posting
- [ ] **Modal Behavior:** Modals only close on successful API response
- [ ] **Loading States:** All async operations show spinner; spinner removed after completion
- [ ] **Duplicate Detection:** Process/subprocess names checked before submit
- [ ] **OR Group Enforcement:** Cannot save subprocess with <2 variants in OR group
- [ ] **Cost Calculations:** All cost updates reflect variant selection changes
- [ ] **Production Execution:** Transaction rollback tested if cost calculation fails
- [ ] **Soft Delete:** Processes can be deleted and restored from UI
- [ ] **Reporting Dashboard:** Empty states show "No data available" (not "0" or blank)
- [ ] **Google OAuth:** Login flow works end-to-end (test with real Google account)
- [ ] **Forgot Password:** Email actually sent (not just success message returned)
- [ ] **Pagination:** Lots list pagination works without full page reload
- [ ] **Error Recovery:** Every error scenario has a "Retry" or "Go back" option
- [ ] **Route Sync:** All /api/upf/* routes audited and match frontend calls

---

## APPENDIX: File Checklist & Next Steps

### File Organization Quick Reference

```
Project-root/
├── app/
│   ├── api/
│   │   ├── process_management.py         [AUDIT - path mismatches]
│   │   ├── subprocess_management.py      [AUDIT - missing routes]
│   │   ├── variant_management.py         [AUDIT - payload mismatch]
│   │   ├── production_lot.py             [AUDIT - error handling]
│   │   └── upf_reports.py                [REVIEW - data aggregation]
│   ├── services/
│   │   ├── process_service.py            [CHECK - CRUD logic]
│   │   ├── production_service.py         [CHECK - transaction handling]
│   │   └── ...
│   ├── auth/
│   │   └── routes.py                     [FIX - OAuth, password reset]
│   ├── models/
│   │   ├── process.py
│   │   ├── subprocess.py
│   │   ├── variant.py
│   │   ├── production_lot.py
│   │   └── ...
│   └── __init__.py                       [VERIFY - blueprint registration]
├── static/js/
│   ├── process_manager.js                [AUDIT - all fetch() calls]
│   ├── process_editor.js                 [AUDIT - modal validation, error handling]
│   ├── production_lots.js                [FIX - variant load error fallback]
│   ├── subprocess_library.js             [AUDIT - CRUD endpoints]
│   ├── cost_calculator.js                [FIX - rate vs amount field]
│   ├── process_framework_unified.js      [AUDIT - tab data fetching]
│   └── upf_reports.js                    [REVIEW - report aggregation]
├── templates/
│   ├── upf_process_editor.html           [ADD - error message divs]
│   ├── upf_process_management.html       [AUDIT - form validation]
│   ├── upf_production_lots.html          [FIX - loading/error states]
│   ├── upf_subprocess_library.html       [AUDIT - modal buttons]
│   ├── upf_variant_selection.html        [AUDIT - OR group validation]
│   └── upf_unified.html                  [CHECK - tab switching]
├── tests/
│   ├── test_process_api.py               [CREATE - add test cases from section 3.2]
│   ├── test_production_lot_api.py        [CREATE]
│   └── test_variant_api.py               [CREATE]
└── README.md or AUDIT_LOG.md             [CREATE - document all fixes]
```

---

### Immediate Action Items (Week 1)

1. **Day 1-2:** Audit all API routes (section 1.1-1.3)
   - Create spreadsheet comparing frontend calls to backend routes
   - Identify all mismatches and document

2. **Day 2-3:** Fix Critical Mismatches (section 1.3)
   - Fix `/api/upf/processes/:id/structure` route
   - Fix cost item field names (`rate` vs `amount`)
   - Fix subprocess add route

3. **Day 3-4:** Standardize Response Format (section 1.4)
   - Update all API endpoints to use standardized JSON response
   - Update frontend error handlers

4. **Day 4-5:** Frontend Error Handling (section 2.2)
   - Add error fallback for all API calls
   - Add loading spinners
   - Add error messages to templates

5. **Day 5:** Manual Testing (section 3.1)
   - Run Flow #1 (Create Process) with all error scenarios
   - Document any additional issues found
   - Fix blocking issues before moving to production lots

---

### Recommended Tools for Debugging

1. **Postman/Insomnia:** Test all API endpoints independently
2. **Chrome DevTools:** Monitor network requests, console errors
3. **Database Browser:** Verify data actually persists after API calls
4. **Flask Debugger:** Add breakpoints in backend to trace execution

---

## Summary Table: Top 15 Critical Issues to Fix

| # | Issue | Impact | Fix Effort | Priority |
|---|---|---|---|---|
| 1 | `/api/upf/processes/:id/structure` route mismatch | Process editor completely broken | 30 min | CRITICAL |
| 2 | Cost item field: `rate` vs `amount` | Cost calculations silently fail | 20 min | CRITICAL |
| 3 | `/api/upf/processes/:id/subprocesses` path wrong | Cannot add subprocesses | 20 min | CRITICAL |
| 4 | Missing error fallback for variant load | User sees empty state, no retry | 1 hour | CRITICAL |
| 5 | Modals close without saving | Data loss risk | 2 hours | CRITICAL |
| 6 | Production lot execution not tested | May corrupt data | 3 hours | CRITICAL |
| 7 | "Forgot Password" doesn't send email | Users cannot reset password | 1 hour | HIGH |
| 8 | Google OAuth not working | Cannot login | 2 hours | HIGH |
| 9 | No error messages in templates | Users confused on failures | 2 hours | HIGH |
| 10 | Duplicate name validation missing | Data integrity risk | 1 hour | MEDIUM |
| 11 | OR group <2 variant enforcement weak | Invalid process config possible | 1 hour | MEDIUM |
| 12 | Soft delete/restore UI missing | Users cannot restore items | 1.5 hours | MEDIUM |
| 13 | Drag-and-drop reorder untested | Subprocess order may corrupt | 2 hours | MEDIUM |
| 14 | Dashboard "No data" handling | Confusing to users | 1 hour | MEDIUM |
| 15 | All "pending testing" code | Unknown functionality | TBD | ONGOING |

---

**Total Estimated Fix Time:** 18-25 hours for all critical issues

**Recommended Schedule:**
- **Week 1 (Days 1-5):** Priority 1 (API contract fixes, standardization)
- **Week 2 (Days 6-10):** Priority 2 (File audits, error handling)
- **Week 3 (Days 11-15):** Priority 3 (Testing, deployment prep)

---

## Document Versioning

| Version | Date | Author | Changes |
|---|---|---|---|
| 1.0 | 2025-11-05 | AI Diagnostic | Initial comprehensive audit |
| TBD | TBD | Your Team | Add findings, mark resolved issues |

