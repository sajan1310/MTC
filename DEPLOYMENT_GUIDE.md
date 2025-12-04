# Production Lot Fixes - Deployment & Implementation Guide

## Overview

This guide provides step-by-step instructions for deploying the production lot fixes.
All high-priority issues have been addressed:
- ✅ Zero value calculations fixed
- ✅ Database queries corrected
- ✅ Error logging implemented
- ✅ Subprocess linkage completed
- ✅ Comprehensive validation added
- ✅ Integration tests created

---

## DEPLOYMENT STEPS

### Step 1: Backup Current Database

```powershell
# Backup production database before migration
pg_dump -h localhost -U postgres mtc_database > backup_mtc_$(Get-Date -Format 'yyyyMMdd_HHmmss').sql
```

### Step 2: Apply Database Migration

The migration creates the `production_lot_subprocesses` table for tracking subprocess execution:

```powershell
# Navigate to project root
cd C:\Users\erkar\OneDrive\Desktop\MTC\Project-root

# Run migration
python ..\migrations\migration_add_production_lot_subprocesses.py

# Verify table creation
psql -h localhost -U postgres -d mtc_database -c "SELECT * FROM information_schema.tables WHERE table_name='production_lot_subprocesses';"
```

**What it creates:**
- `production_lot_subprocesses` table
- Foreign keys to `production_lots` and `process_subprocesses`
- Indexes for performance
- Default status and timestamps

### Step 3: Install/Update Dependencies

The new code uses existing Flask and database dependencies. No new packages required.

```powershell
# Verify all dependencies in venv
pip list | findstr Flask psycopg2
```

### Step 4: Deploy Code Changes

**Files to deploy:**

1. **Production Service** (Enhanced)
   - `app/services/production_service.py`
   - Changes: Added cost validation, improved queries, subprocess linking

2. **Costing Service** (No changes - already has good error handling)
   - `app/services/costing_service.py` 
   - No changes needed

3. **New Utility Module**
   - `app/utils/production_lot_utils.py`
   - NEW: Cost validation, logging utilities

4. **Production Lot Validator** (Enhanced)
   - `app/validators/production_lot_validator.py`
   - Changes: Added zero-cost detection, validation functions

5. **New Subprocess Manager**
   - `app/services/production_lot_subprocess_manager.py`
   - NEW: Subprocess tracking and status management

6. **New Migration File**
   - `migrations/migration_add_production_lot_subprocesses.py`
   - NEW: Database schema update

7. **New Test Suite**
   - `tests/test_production_lot_lifecycle.py`
   - NEW: 40+ comprehensive integration tests

### Step 5: Run Test Suite

```powershell
# Activate virtual environment
. venv2\Scripts\Activate.ps1

# Run production lot tests
pytest tests/test_production_lot_lifecycle.py -v

# Expected output: 40+ tests passing
# All tests should show green ✓

# Run with coverage
pytest tests/test_production_lot_lifecycle.py --cov=app.services.production_service --cov=app.utils.production_lot_utils
```

### Step 6: Check Logs During Startup

```powershell
# Start application in development mode
python app.py

# In another terminal, monitor logs
Get-Content -Path app\logs\app.log -Wait | findstr -i "production\|cost\|subprocess"
```

### Step 7: Manual Verification

#### Test 1: Create a Production Lot

```powershell
# Use Python REPL or test client
from app import create_app
from app.services.production_service import ProductionService

app = create_app()

with app.app_context():
    # Create a test lot
    lot = ProductionService.create_production_lot(
        process_id=1,
        user_id=1,
        quantity=5
    )
    
    print(f"Created lot: {lot['lot_number']}")
    print(f"Cost: {lot.get('total_cost', 0)}")
    print(f"Linked subprocesses: {lot.get('linked_subprocesses', 0)}")
```

#### Test 2: Verify Subprocess Linking

```powershell
from app.services.production_lot_subprocess_manager import get_production_lot_subprocesses

with app.app_context():
    subprocesses = get_production_lot_subprocesses(lot_id=1)
    print(f"Found {len(subprocesses)} linked subprocesses")
    for sp in subprocesses:
        print(f"  - {sp['subprocess_name']}: {sp['status']}")
```

#### Test 3: Check Cost Validation Logging

```powershell
# Create a lot and monitor logs for validation messages
# If supplier pricing is missing, you should see:
# WARNING: Creating lot with zero cost for process 1; this may indicate missing supplier pricing data

# This is expected if no pricing configured
# It shows the validation is working
```

#### Test 4: Test Status Transitions

```powershell
from app.validators.production_lot_validator import validate_lot_status_transition

with app.app_context():
    # Valid transition
    errors = validate_lot_status_transition(1, "Planning", "Cancelled")
    print(f"Valid transition errors: {errors}")  # Should be empty []
    
    # Invalid transition
    errors = validate_lot_status_transition(1, "Completed", "Planning")
    print(f"Invalid transition errors: {errors}")  # Should have errors
```

---

## CONFIGURATION

No configuration changes needed. The system uses existing:
- Database connection settings
- Flask logging configuration
- Process framework structure

---

## MONITORING

### Key Logs to Watch

1. **Cost Validation Warnings:**
   ```
   grep "Creating lot with zero cost" app/logs/app.log
   ```

2. **Subprocess Linking:**
   ```
   grep "Linked.*subprocesses to lot" app/logs/app.log
   ```

3. **Database Errors:**
   ```
   grep "ERROR\|Error linking" app/logs/error.log
   ```

4. **Status Transitions:**
   ```
   grep "transition from\|Invalid transition" app/logs/app.log
   ```

### Dashboard Queries

```sql
-- Check lot statistics
SELECT 
    status,
    COUNT(*) as lot_count,
    AVG(total_cost) as avg_cost,
    MAX(total_cost) as max_cost,
    MIN(total_cost) as min_cost
FROM production_lots
GROUP BY status;

-- Check subprocess tracking
SELECT 
    pls.status,
    COUNT(*) as subprocess_count,
    COUNT(DISTINCT pls.production_lot_id) as lots_affected
FROM production_lot_subprocesses pls
GROUP BY pls.status;

-- Find lots with zero cost
SELECT 
    id, lot_number, quantity, total_cost, status, created_at
FROM production_lots
WHERE total_cost = 0 OR total_cost IS NULL
ORDER BY created_at DESC;
```

---

## ROLLBACK PROCEDURE

If issues occur, rollback is straightforward:

### Code Rollback

```powershell
# Restore from git
git checkout main -- app/services/production_service.py
git checkout main -- app/validators/production_lot_validator.py

# Or restore specific versions
git revert <commit-hash>
```

### Database Rollback

```powershell
# Drop new table
python migrations/migration_add_production_lot_subprocesses.py downgrade

# Or manually
psql -h localhost -U postgres -d mtc_database -c "DROP TABLE IF EXISTS production_lot_subprocesses CASCADE;"

# Restore from backup
psql -h localhost -U postgres -d mtc_database < backup_mtc_20250204_120000.sql
```

---

## PERFORMANCE CONSIDERATIONS

### New Indexes Created

The migration adds indexes for optimal query performance:

```sql
-- Speeds up queries filtering by lot
CREATE INDEX idx_prod_lot_subprocess_lot 
ON production_lot_subprocesses(production_lot_id);

-- Speeds up status-based queries
CREATE INDEX idx_prod_lot_subprocess_status 
ON production_lot_subprocesses(status);
```

### Query Optimization

The enhanced `list_production_lots()` query is optimized:
- Uses explicit column selection (not `pl.*`)
- Properly groups by all selected columns
- Uses COALESCE to avoid NULL handling issues
- Still maintains good performance with pagination

---

## TROUBLESHOOTING

### Issue: Zero Costs Appearing

**Cause:** No supplier pricing configured for process

**Solution:**
```sql
-- Check for missing pricing
SELECT DISTINCT p.id, p.name
FROM processes p
WHERE p.id NOT IN (
    SELECT DISTINCT ps.process_id
    FROM process_subprocesses ps
    JOIN variant_usage vu ON vu.process_subprocess_id = ps.id
    JOIN variant_supplier_pricing vsp ON vsp.variant_id = vu.variant_id
    WHERE vsp.is_active = TRUE
);

-- Add pricing for variants in the process
INSERT INTO variant_supplier_pricing (variant_id, supplier_id, cost_per_unit, is_active)
VALUES (variant_id, supplier_id, cost, TRUE);
```

### Issue: Subprocesses Not Linking

**Cause:** Migration not applied or process has no subprocesses

**Solution:**
```powershell
# Verify migration applied
psql -h localhost -U postgres -d mtc_database -c "SELECT * FROM production_lot_subprocesses LIMIT 1;"

# Verify process has subprocesses
psql -h localhost -U postgres -d mtc_database -c "SELECT * FROM process_subprocesses WHERE process_id=1;"

# If missing, add subprocesses to process
INSERT INTO process_subprocesses (process_id, subprocess_id)
VALUES (1, subprocess_id);
```

### Issue: Tests Failing

**Cause:** Database schema not ready or dependencies missing

**Solution:**
```powershell
# Ensure database has all tables
python -c "import database; database.get_conn()"

# Reinstall dependencies
pip install --force-reinstall flask psycopg2-binary pytest

# Run tests with verbose output
pytest tests/test_production_lot_lifecycle.py -vv -s
```

---

## VALIDATION CHECKLIST

After deployment, verify:

- [ ] Database migration applied successfully
- [ ] `production_lot_subprocesses` table created
- [ ] All indexes created
- [ ] Application starts without errors
- [ ] Production lot creation works
- [ ] Costs are calculated (may be zero if no pricing)
- [ ] Subprocesses are linked to lots
- [ ] Status transitions validated
- [ ] Logs show validation messages
- [ ] All 40+ tests pass
- [ ] Zero costs logged as warnings
- [ ] Database queries return complete data

---

## FEATURE VERIFICATION

### Feature 1: Cost Validation

```python
from app.utils.production_lot_utils import validate_cost_breakdown, validate_cost_calculation

# Test breakdown validation
breakdown = {"totals": {"grand_total": 100.0}}
is_valid, warnings = validate_cost_breakdown(breakdown)
assert is_valid == True

# Test calculation validation
is_valid, total, issues = validate_cost_calculation(1, 5, breakdown)
assert total == 500.0  # 100 * 5
```

### Feature 2: Subprocess Tracking

```python
from app.services.production_lot_subprocess_manager import get_production_lot_subprocesses

# After creating lot, verify subprocesses linked
subprocesses = get_production_lot_subprocesses(lot_id=1)
assert len(subprocesses) > 0
assert all(sp['status'] == 'Planning' for sp in subprocesses)
```

### Feature 3: Error Logging

```python
# Check logs for:
# - Cost validation warnings
# - Subprocess linking messages
# - Status transition attempts
# - Database operation details
```

---

## SUCCESS INDICATORS

✅ Deployment successful when:

1. All database tables created
2. Application starts without errors
3. Test suite runs with 40+ passing tests
4. Production lot creation includes cost validation
5. Subprocesses automatically linked to lots
6. Logs show detailed operation information
7. Zero costs generate appropriate warnings
8. Status transitions properly validated
9. Frontend receives complete cost data
10. No SQL errors in application logs

---

## SUPPORT & NEXT STEPS

### For Issues:

1. Check application logs: `tail -f app/logs/app.log`
2. Run tests with verbose output: `pytest -vv`
3. Verify database schema: `psql` commands above
4. Review code changes in this document

### For Enhancements:

1. **Performance:** Add query result caching
2. **Reporting:** Create cost variance dashboard
3. **Integration:** Connect to inventory system
4. **Automation:** Auto-generate procurement recommendations

---

**Deployment Status:** Ready for Production ✅
