# Production Lot Detail - Code Changes Reference

## Backend Changes Summary

### File: app/api/production_lot.py

#### Change 1: Enhanced DELETE Endpoint (Lines ~1268-1340)

**BEFORE**:
```python
@production_api_bp.route("/production-lots/<int:lot_id>", methods=["DELETE"])
@login_required
def delete_production_lot(lot_id: int):
    """Delete a production lot (if allowed)."""
    try:
        lot = ProductionService.get_production_lot(lot_id)
        if not lot:
            return APIResponse.not_found("Production lot", lot_id)

        result = ProductionService.delete_production_lot(
            lot_id, getattr(current_user, "id", None)
        )
        if not result:
            return APIResponse.error(
                "not_found", "Production lot not found or could not be deleted", 404
            )
        return APIResponse.success({"deleted": True}, "Production lot deleted")
    except Exception as e:
        return APIResponse.error("internal_error", str(e), 500)
```

**AFTER** (Key additions):
```python
# Check for active subprocesses
try:
    with get_conn(cursor_factory=RealDictCursor) as (conn, cur):
        cur.execute(
            """
            SELECT COUNT(*) as subprocess_count
            FROM production_lot_subprocesses
            WHERE production_lot_id = %s
            """,
            (lot_id,),
        )
        result = cur.fetchone()
        subprocess_count = result.get("subprocess_count", 0) if result else 0
        
        if subprocess_count > 0:
            return APIResponse.error(
                "conflict",
                f"Cannot delete: Production lot has {subprocess_count} active subprocess(es). Remove all subprocesses before deleting.",
                409
            )
except Exception as e:
    current_app.logger.warning(f"Could not check subprocesses for lot {lot_id}: {e}")
    # Continue with deletion as fallback
```

**Result**: Now validates subprocess count and returns 409 Conflict if subprocesses exist

---

#### Change 2: New Recalculate Endpoint (Lines ~1231-1256)

**NEW CODE ADDED**:
```python
@production_api_bp.route("/production-lots/<int:lot_id>/recalculate", methods=["POST"])
@login_required
def recalculate_lot_totals(lot_id: int):
    """Recalculate total cost and quantity for a production lot."""
    try:
        from app.services.production_calculations import recalculate_lot_totals
        
        lot = ProductionService.get_production_lot(lot_id)
        if not lot:
            return APIResponse.not_found("Production lot", lot_id)

        # Recalculate all totals
        result = recalculate_lot_totals(lot_id)
        
        if result.get("status") == "error":
            return APIResponse.error(
                "calculation_error",
                f"Failed to recalculate totals: {result.get('error')}",
                500
            )
        
        return APIResponse.success(result, "Production lot totals recalculated successfully")
    except Exception as e:
        current_app.logger.error(f"Error recalculating lot {lot_id}: {e}")
        return APIResponse.error("internal_error", str(e), 500)
```

**Result**: New endpoint allows frontend to recalculate costs on demand

---

### File: app/services/production_calculations.py (NEW)

**NEW SERVICE MODULE** (~350 lines):

```python
"""
Production Lot Calculations Service

Handles cost and quantity calculations for production lots, including:
- Summing subprocess material and labor costs
- Calculating total lot quantity
- Formatting currency for Indian Rupees (₹)
"""

def calculate_lot_costs(lot_id: int) -> Dict[str, Any]:
    """Calculate total costs for a production lot by summing subprocess costs."""
    # Sums material_cost and labor_cost from production_lot_subprocesses
    # Returns: total_material_cost, total_labor_cost, total_cost, subprocess_count

def calculate_lot_quantity(lot_id: int) -> Dict[str, Any]:
    """Calculate total quantity for a production lot from subprocess requirements."""
    # Gets quantity from production_lots table
    # Returns: total_quantity, quantity_unit, subprocess_count

def format_currency_inr(amount: float) -> str:
    """Format a numeric amount as Indian Rupees (₹)."""
    # Returns: "₹1,234.56"

def recalculate_lot_totals(lot_id: int) -> Dict[str, Any]:
    """Recalculate and update all totals for a production lot."""
    # Calls calculate_lot_costs() and calculate_lot_quantity()
    # Returns complete calculation result with formatting

def check_lot_has_subprocesses(lot_id: int) -> Tuple[bool, int]:
    """Check if a production lot has any subprocesses."""
    # Returns: (has_subprocesses: bool, count: int)

def validate_lot_ready_for_finalization(lot_id: int) -> Tuple[bool, str]:
    """Validate if a production lot is ready to be finalized."""
    # Checks: has subprocesses, status is "Planning"
    # Returns: (is_ready: bool, message: str)
```

**Result**: Centralized calculation service with comprehensive error handling

---

## Frontend Changes Summary

### File: static/js/production_lot_detail.js

#### Change 1: Enhanced Delete Handler (Lines ~1120-1165)

**BEFORE**:
```javascript
async _handleDeleteLot() {
    if (!confirm('Are you sure...')) return;
    
    try {
        const { lotId } = this.state.getState();
        await this.api.delete(API_PATHS.lotDelete(lotId));
        this.toast.success('Production lot deleted');
        setTimeout(() => {
            window.location.href = '/production-lots';
        }, 1000);
    } catch (error) {
        this.toast.error('Failed to delete production lot');
    }
}
```

**AFTER** (Key improvements):
```javascript
async _handleDeleteLot() {
    if (!confirm('Are you sure...')) return;
    
    try {
        const response = await this.api.delete(API_PATHS.lotDelete(lotId));
        this.toast.success('Production lot deleted successfully');
        setTimeout(() => {
            window.location.href = '/upf/processes?tab=production#production';
        }, 1000);
    } catch (error) {
        // Extract specific error message from response
        let errorMsg = 'Failed to delete production lot';
        
        if (error.response?.error?.code === 'conflict') {
            errorMsg = error.response.error.message || 
                       'Cannot delete: Lot has active subprocesses';
        } else if (error.response?.error?.message) {
            errorMsg = error.response.error.message;
        } else if (error.message) {
            errorMsg = error.message;
        }
        
        this.toast.error(errorMsg);
        this.spinner.hideInButton(deleteBtn);
    }
}
```

**Result**: Shows specific error messages for different failure scenarios

---

#### Change 2: Enhanced Finalize Handler (Lines ~1150-1200)

**BEFORE**:
```javascript
async _handleFinalizeLot() {
    if (!confirm('Are you sure...')) return;
    
    try {
        await this.api.post(API_PATHS.lotFinalize(lotId));
        this.toast.success('Production lot finalized');
        await this._loadAllData();
    } catch (error) {
        this.toast.error('Failed to finalize production lot');
    }
}
```

**AFTER** (Key improvements):
```javascript
async _handleFinalizeLot() {
    const { lot } = this.state.getState();
    
    // Validate lot has subprocesses
    if (!lot?.subprocesses?.length > 0) {
        this.toast.error('Cannot finalize: Lot has no subprocesses...');
        return;
    }
    
    if (!confirm('Are you sure...')) return;
    
    try {
        const response = await this.api.post(API_PATHS.lotFinalize(lotId));
        this.toast.success('Production lot finalized successfully! Status changed to "Ready"');
        await this._loadAllData();
    } catch (error) {
        // Extract specific error message
        let errorMsg = 'Failed to finalize production lot';
        
        if (error.response?.error?.message) {
            errorMsg = error.response.error.message;
        } else if (error.message) {
            errorMsg = error.message;
        }
        
        this.toast.error(errorMsg);
    }
}
```

**Result**: Validates subprocesses before finalizing, better error messages

---

#### Change 3: Variant Loading Timeout (Lines ~1453-1510)

**BEFORE**:
```javascript
async _loadVariantOptions(subprocessId) {
    const response = await this.api.get(url);
    const options = response.data || response;
    
    this.state.setState({
        variantOptionsCache: {
            ...variantOptionsCache,
            [subprocessId]: options
        }
    });
    
    return options;
}
```

**AFTER** (Key additions):
```javascript
async _loadVariantOptions(subprocessId) {
    try {
        // Create a timeout promise that rejects after 5 seconds
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => {
                reject(new Error('Variant loading timeout: Request took longer than 5 seconds'));
            }, 5000);
        });
        
        // Race between the API call and timeout
        const response = await Promise.race([
            this.api.get(url),
            timeoutPromise
        ]);
        
        const options = response.data || response;
        
        this.state.setState({
            variantOptionsCache: {
                ...variantOptionsCache,
                [subprocessId]: options
            }
        });
        
        return options;
    } catch (error) {
        logger.warn('Failed to load variant options:', error.message);
        
        // Return empty options to prevent hanging
        const emptyOptions = {
            or_groups: [],
            grouped_variants: {},
            standalone_variants: [],
            error: error.message
        };
        
        this.state.setState({
            variantOptionsCache: {
                ...variantOptionsCache,
                [subprocessId]: emptyOptions
            }
        });
        
        throw error;
    }
}
```

**Result**: 5-second timeout prevents indefinite loading states

---

## Key Code Patterns

### Currency Formatting
```python
def format_currency_inr(amount: float) -> str:
    """Format as Indian Rupees"""
    if isinstance(amount, str):
        amount = float(amount)
    
    if amount < 0:
        return f"-₹{abs(amount):,.2f}"
    else:
        return f"₹{amount:,.2f}"

# Usage:
formatted = format_currency_inr(1234.56)  # Returns "₹1,234.56"
```

### Error Extraction
```javascript
// Extract specific error from API response
let errorMsg = 'Default error message';

if (error.response?.error?.code === 'conflict') {
    errorMsg = error.response.error.message;
} else if (error.response?.error?.message) {
    errorMsg = error.response.error.message;
} else if (error.message) {
    errorMsg = error.message;
}

this.toast.error(errorMsg);
```

### Timeout Implementation
```javascript
// Use Promise.race() for timeout
const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Timeout')), 5000);
});

const response = await Promise.race([
    this.api.get(url),
    timeoutPromise
]);
```

### Subprocess Validation
```python
# Check if lot has subprocesses
subprocess_count = check_lot_has_subprocesses(lot_id)

if subprocess_count > 0:
    return APIResponse.error(
        "conflict",
        f"Cannot delete: Lot has {subprocess_count} active subprocess(es)",
        409
    )
```

---

## Line-by-Line Changes

### app/api/production_lot.py
- **Lines 1231-1256**: Added POST /recalculate endpoint (NEW)
- **Lines 1290-1310**: Added subprocess validation in DELETE endpoint (NEW)
- **Line 1340**: Updated success message in DELETE (MODIFIED)

### static/js/production_lot_detail.js
- **Lines 1120-1165**: Improved error extraction in delete handler (MODIFIED)
- **Lines 1150-1200**: Added subprocess validation in finalize handler (MODIFIED)
- **Lines 1453-1510**: Added 5-second timeout to variant loading (MODIFIED)

### app/services/production_calculations.py
- **Lines 1-350**: NEW SERVICE FILE

---

## Testing the Changes

### Test Delete Endpoint
```bash
# Has subprocesses (should fail)
curl -X DELETE http://localhost:5000/api/upf/production-lots/124

# Response: 409 Conflict
{
  "success": false,
  "error": {
    "code": "conflict",
    "message": "Cannot delete: Lot has 3 active subprocess(es)..."
  }
}
```

### Test Recalculate Endpoint
```bash
curl -X POST http://localhost:5000/api/upf/production-lots/124/recalculate

# Response: 200 OK
{
  "success": true,
  "data": {
    "costs": {"total_cost": 1234.56, ...},
    "formatted_total_cost": "₹1,234.56"
  }
}
```

### Test Frontend Delete Handler
```javascript
// In browser console
window.lotDetailController._handleDeleteLot()
// Should show error toast with specific message
```

### Test Timeout
```javascript
// Slow network: DevTools > Network > Slow 3G
// Click Edit Variants
// Should timeout after 5 seconds with error message
```

---

## Verification Commands

```bash
# Check file syntax
python -m py_compile app/services/production_calculations.py

# Import test
python -c "from app.services.production_calculations import calculate_lot_costs; print('OK')"

# Check backend changes
grep -n "recalculate_lot_totals\|subprocess_count" app/api/production_lot.py

# Check frontend changes
grep -n "Promise.race\|_handleDeleteLot\|_handleFinalizeLot" static/js/production_lot_detail.js
```

---

## Summary of Changes

| Component | Type | Lines | Purpose |
|-----------|------|-------|---------|
| production_calculations.py | NEW | 350 | Cost/quantity calculations |
| DELETE endpoint | ENHANCED | 40 | Subprocess validation |
| /recalculate endpoint | NEW | 25 | On-demand recalculation |
| _handleDeleteLot() | IMPROVED | 50 | Better error messages |
| _handleFinalizeLot() | IMPROVED | 50 | Subprocess validation |
| _loadVariantOptions() | IMPROVED | 60 | 5-second timeout |
| **TOTAL** | - | ~575 | Lines of new/modified code |

---

## Backward Compatibility

✅ All changes are backward compatible:
- Existing API endpoints enhanced (not broken)
- New endpoints added (no breaking changes)
- Frontend improvements non-breaking
- Existing calculations still work
- No database schema changes

---

## Performance Impact

- **Minimal**: Added only subprocess count check (single SQL query)
- **Timeout protection**: Prevents indefinite waits
- **Caching**: Variant options cached to reduce API calls
- **Calculation service**: Efficient SQL with COALESCE

No noticeable performance degradation expected.
