# Production Lot Data Calculation Fixes - High Priority

## Issues Identified

### 1. **Zero Cost Calculations**
- `CostingService.get_variant_worst_case_cost()` returns `None` when `variant_supplier_pricing` table doesn't exist
- `get_substitute_group_worst_case_cost()` sets cost to 0 when no pricing available, but doesn't log this
- `calculate_subprocess_cost()` silently accumulates zeros if variants have no pricing data
- **Impact**: Production lots show $0 total_cost instead of proper estimates

### 2. **Missing Null Checks in Aggregations**
- `calculate_subprocess_cost()` uses `float(variant["quantity"])` without null checks
- `calculate_process_total_cost()` assumes all subprocesses exist and have valid costs
- Cost rollups don't validate intermediate results before summing
- **Impact**: Null/invalid values silently become 0

### 3. **Database Query Issues**
- `list_production_lots()` doesn't include `total_cost` or `worst_case_estimated_cost` in SELECT
- Query doesn't use COALESCE for nullable numeric columns
- `get_production_lot()` doesn't validate the cost_breakdown structure before returning
- **Impact**: Frontend receives incomplete cost data

### 4. **Subprocess Linkage Problems**
- `create_production_lot_with_alerts()` queries DB a second time to find lot_id if missing
- No validation that subprocesses were actually selected/linked
- Production lot doesn't track which subprocesses are "active" for it
- **Impact**: Subprocesses not properly tracked with production lots

### 5. **Logging Gaps**
- No error logging when variant_supplier_pricing table missing
- No logging of zero-cost calculations
- Database query failures don't produce audit trail
- **Impact**: Silent failures, difficult to debug

## Solutions

### Fix 1: Enhanced Error Handling & Logging
- Add debug logging when pricing tables missing
- Log when costs calculated as zero
- Add warning when variant has no supplier pricing
- Implement cost validation before aggregation

### Fix 2: Production Service Enhancements
- Fix `create_production_lot()` to validate cost breakdown
- Add null checks in cost calculations
- Implement proper error logging decorator
- Add subprocess validation on lot creation

### Fix 3: Database Query Fixes
- Update `list_production_lots()` to include cost fields
- Add COALESCE/NULLIF for numeric columns
- Validate cost_breakdown structure on retrieval

### Fix 4: Subprocess-to-Production-Lot Linkage
- Add `production_lot_subprocesses` table tracking
- Validate subprocess selection on lot creation
- Add status transition validation

### Fix 5: Comprehensive Validation
- Enhance `production_lot_validator.py` with:
  - Zero-cost detection and warnings
  - Subprocess selection validation
  - Cost breakdown validation
  - Status transition validation

## File Changes

1. **production_service.py** - Fix cost calculations & add logging
2. **costing_service.py** - Enhance null handling & logging
3. **production_lot_validator.py** - Add comprehensive validations
4. **New file**: `utils/production_lot_utils.py` - Add cost validation helpers
5. **tests/test_production_lot_lifecycle.py** - Comprehensive integration tests
