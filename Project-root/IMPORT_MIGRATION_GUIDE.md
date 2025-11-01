# Migration Guide: From Table-Level Locking to UPSERT-Based Imports

## Overview

This guide provides step-by-step instructions for migrating from the old table-level locking import system to the new UPSERT-based import system.

**Migration Timeline:** 4-6 weeks  
**Rollback Plan:** Yes (see Rollback section)  
**Production Impact:** Minimal with gradual migration

---

## Pre-Migration Checklist

Before starting the migration, ensure:

- [ ] Database backup completed
- [ ] All team members aware of migration schedule
- [ ] Test environment available for validation
- [ ] Monitoring and alerting configured
- [ ] Rollback plan documented and tested
- [ ] Production maintenance window scheduled (if needed)

---

## Phase 1: Preparation (Week 1)

### 1.1 Backup Database

```bash
# PostgreSQL backup
pg_dump -h localhost -U postgres -d MTC > backup_$(date +%Y%m%d_%H%M%S).sql

# Verify backup
psql -h localhost -U postgres -d MTC_test < backup_*.sql
```

### 1.2 Document Current System

Document current import behavior:

```bash
# Count current import operations
SELECT COUNT(*) FROM import_logs WHERE created_at > NOW() - INTERVAL '30 days';

# Average import duration
SELECT AVG(duration_seconds) FROM import_logs WHERE status = 'completed';

# Peak import times
SELECT EXTRACT(HOUR FROM created_at) as hour, COUNT(*) 
FROM import_logs 
GROUP BY hour 
ORDER BY count DESC;
```

### 1.3 Identify All Import Operations

Find all code that uses table locks:

```bash
# Search for LOCK TABLE statements
grep -r "LOCK TABLE" . --include="*.py"

# Expected locations:
# - app.py (line ~2325)
# - app/api/routes.py (line ~1348)
```

### 1.4 Set Up Test Environment

Create test environment with production-like data:

```bash
# Create test database
createdb MTC_test

# Restore production data (sample)
pg_dump -h prod-host -U postgres -d MTC | psql -h localhost -U postgres -d MTC_test
```

---

## Phase 2: Deploy New System (Week 2)

### 2.1 Run Database Migrations

**Step 1: Add Unique Indexes**

```bash
python migrations/migration_add_unique_indexes_for_upsert.py
```

**Expected Output:**
```
Creating unique indexes for UPSERT operations...
✅ Created unique index on item_master(name)
✅ Created unique index on color_master(color_name)
✅ Created unique index on size_master(size_name)
✅ Created unique index on item_variant(item_id, color_id, size_id)
✅ Migration completed successfully!
```

**Verify Indexes:**
```sql
SELECT indexname, indexdef 
FROM pg_indexes 
WHERE tablename IN ('item_master', 'color_master', 'size_master', 'item_variant')
AND indexname LIKE 'idx_%unique';
```

**Step 2: Create Import Jobs Table**

```bash
python migrations/migration_add_import_jobs.py
```

**Expected Output:**
```
Creating import_jobs table...
✅ Created import_jobs table
✅ Created import_results table
✅ Created trigger for updated_at timestamp
✅ Migration completed successfully!
```

**Verify Tables:**
```sql
SELECT table_name FROM information_schema.tables 
WHERE table_name IN ('import_jobs', 'import_results');
```

### 2.2 Update Configuration

Add to `.env`:

```env
# Import Configuration
IMPORT_BATCH_SIZE=1000
IMPORT_MAX_ROWS=50000
IMPORT_TIMEOUT_SECONDS=600
IMPORT_BACKGROUND_THRESHOLD=1000

# Feature Flag (start disabled)
USE_NEW_IMPORT_SYSTEM=false

# Redis Configuration
RATELIMIT_STORAGE_URL=redis://localhost:6379/0
REDIS_PROGRESS_EXPIRY=86400
```

### 2.3 Deploy New Code

```bash
# Pull latest code
git pull origin main

# Install dependencies
pip install -r requirements.txt

# Restart application
systemctl restart mtc-app  # or your deployment method
```

### 2.4 Initialize Services

Ensure services are initialized in app startup (add to `__init__.py` or `app.py`):

```python
from app.services import init_progress_tracker, init_background_worker

def create_app():
    app = Flask(__name__)
    
    # ... existing initialization ...
    
    with app.app_context():
        # Initialize progress tracker
        init_progress_tracker(
            redis_url=app.config.get('RATELIMIT_STORAGE_URL'),
            expiry_seconds=app.config.get('REDIS_PROGRESS_EXPIRY', 86400)
        )
        
        # Initialize background worker
        if app.config.get('USE_NEW_IMPORT_SYSTEM', False):
            init_background_worker(poll_interval=5, max_retries=3)
    
    # Register new imports blueprint
    from app.api.imports import imports_bp
    app.register_blueprint(imports_bp)
    
    return app
```

---

## Phase 3: Gradual Migration (Weeks 3-4)

### 3.1 Enable Feature Flag for Testing

Update `.env`:
```env
USE_NEW_IMPORT_SYSTEM=test_users_only
```

Route test users to new system:

```python
# In existing import route
USE_NEW_IMPORT = os.getenv('USE_NEW_IMPORT_SYSTEM', 'false').lower()

if USE_NEW_IMPORT == 'true':
    use_new_system = True
elif USE_NEW_IMPORT == 'test_users_only':
    test_user_ids = [1, 2, 3]  # Your test user IDs
    use_new_system = current_user.id in test_user_ids
else:
    use_new_system = False

if use_new_system:
    # Redirect to new imports API
    from app.api.imports import import_items as new_import
    return new_import()
else:
    # Use old locking-based import
    # ... existing code ...
```

### 3.2 Parallel Testing

Run imports in parallel with both systems:

```python
def parallel_import_test(data):
    """
    Run import with both old and new system, compare results.
    """
    # Old system
    old_result = run_old_import(data)
    
    # New system
    new_result = run_new_import(data)
    
    # Compare results
    assert old_result['processed'] == new_result['processed']
    assert old_result['failed'] == new_result['failed']
    
    logger.info(f"Parallel test passed: {old_result['processed']} rows")
```

### 3.3 Monitor Metrics

Create monitoring dashboard:

```python
# Track import metrics
import_metrics = {
    'old_system': {
        'count': 0,
        'avg_duration': 0,
        'success_rate': 0,
        'errors': []
    },
    'new_system': {
        'count': 0,
        'avg_duration': 0,
        'success_rate': 0,
        'errors': []
    }
}

# Compare performance
def compare_systems():
    old_avg = import_metrics['old_system']['avg_duration']
    new_avg = import_metrics['new_system']['avg_duration']
    improvement = (old_avg - new_avg) / old_avg * 100
    print(f"Performance improvement: {improvement:.1f}%")
```

### 3.4 Gradual Rollout

Week 3: 10% of traffic
```env
USE_NEW_IMPORT_SYSTEM=percentage:10
```

Week 4: 50% of traffic
```env
USE_NEW_IMPORT_SYSTEM=percentage:50
```

Implement percentage-based routing:

```python
import random

def should_use_new_system():
    percentage = int(os.getenv('USE_NEW_IMPORT_PERCENTAGE', '0'))
    return random.randint(1, 100) <= percentage
```

---

## Phase 4: Full Migration (Week 5)

### 4.1 Enable for All Users

Update `.env`:
```env
USE_NEW_IMPORT_SYSTEM=true
```

### 4.2 Monitor Closely

For the first 48 hours after full migration:

- Monitor import success rates (every hour)
- Check error logs (every 2 hours)
- Review database performance (query times, connection pool)
- Monitor user reports/complaints

**Alert Thresholds:**
- Success rate < 95%: Investigate immediately
- Import duration > 10 minutes: Check database performance
- Error rate > 5%: Review error logs

### 4.3 Performance Comparison

Compare old vs new system:

```sql
-- Old system performance (from logs)
SELECT 
    AVG(duration_seconds) as avg_duration,
    AVG(success_rate) as avg_success_rate,
    COUNT(*) as total_imports
FROM import_logs_old
WHERE created_at > NOW() - INTERVAL '30 days';

-- New system performance
SELECT 
    AVG(duration_seconds) as avg_duration,
    AVG(success_rate) as avg_success_rate,
    COUNT(*) as total_imports
FROM import_results
JOIN import_jobs USING (import_id)
WHERE created_at > NOW() - INTERVAL '7 days';
```

---

## Phase 5: Cleanup (Week 6)

### 5.1 Remove Old Code

Once new system is stable (2-4 weeks after full migration):

```bash
# Remove old import code
git rm app/old_import_service.py

# Update routes to remove old import logic
# In app.py or app/api/routes.py:
# - Remove LOCK TABLE statements
# - Remove old import route handlers
# - Remove feature flag logic
```

### 5.2 Remove Feature Flag

Update `.env`:
```env
# Remove or comment out
# USE_NEW_IMPORT_SYSTEM=true
```

Remove feature flag code:

```python
# Before:
if os.getenv('USE_NEW_IMPORT_SYSTEM', 'false') == 'true':
    return new_import()
else:
    return old_import()

# After:
return new_import()  # Always use new system
```

### 5.3 Update Documentation

- Update API documentation
- Update user guides
- Update runbooks
- Train team on new import process

### 5.4 Archive Old Code

Keep old code for reference:

```bash
# Create archive branch
git checkout -b archive/old-import-system
git push origin archive/old-import-system
```

---

## Rollback Plan

If critical issues arise, follow this rollback procedure:

### Rollback Step 1: Disable New System (Immediate)

```env
USE_NEW_IMPORT_SYSTEM=false
```

Restart application:
```bash
systemctl restart mtc-app
```

**Impact:** Reverts to old locking-based system immediately.

### Rollback Step 2: Remove Migrations (If Needed)

If indexes cause performance issues:

```bash
# Downgrade indexes migration
python migrations/migration_add_unique_indexes_for_upsert.py downgrade
```

**Warning:** Only do this if indexes are causing significant performance degradation.

### Rollback Step 3: Review and Plan

After rollback:

1. Analyze what went wrong
2. Fix issues in new system
3. Re-test thoroughly
4. Plan new migration attempt

---

## Validation Checklist

After migration, verify:

- [ ] Imports complete successfully (>95% success rate)
- [ ] No table-level locks are used (check `pg_locks` table)
- [ ] Concurrent imports work correctly
- [ ] Progress tracking works
- [ ] Background processing works for large imports
- [ ] Error handling works (partial success scenarios)
- [ ] Database performance is acceptable (<100ms queries)
- [ ] Connection pool utilization is healthy (<80%)
- [ ] No memory leaks during large imports
- [ ] Failed rows are captured and retrievable

---

## Common Migration Issues

### Issue 1: Duplicate Key Errors

**Symptom:** Imports fail with "duplicate key value violates unique constraint"

**Cause:** Existing data has duplicates that weren't enforced before.

**Solution:**
```sql
-- Find duplicates
SELECT name, COUNT(*) 
FROM item_master 
WHERE deleted_at IS NULL
GROUP BY name 
HAVING COUNT(*) > 1;

-- Resolve duplicates (rename or merge)
UPDATE item_master 
SET name = name || ' (duplicate-' || item_id || ')'
WHERE item_id IN (
    SELECT item_id FROM (
        SELECT item_id, ROW_NUMBER() OVER (PARTITION BY name ORDER BY item_id) as rn
        FROM item_master WHERE deleted_at IS NULL
    ) t WHERE rn > 1
);
```

### Issue 2: Performance Degradation

**Symptom:** Imports are slower than old system.

**Cause:** Missing indexes or inefficient batch size.

**Solution:**
```sql
-- Check index usage
EXPLAIN ANALYZE
INSERT INTO item_master (name, description) 
VALUES ('Test', 'Test') 
ON CONFLICT (name) WHERE deleted_at IS NULL 
DO UPDATE SET description = EXCLUDED.description;

-- Adjust batch size
IMPORT_BATCH_SIZE=500  # Reduce from 1000
```

### Issue 3: Background Worker Not Processing

**Symptom:** Jobs stuck in "pending" status.

**Cause:** Worker not started or database connection issues.

**Solution:**
```python
# Check worker status
from app.services import get_background_worker

worker = get_background_worker()
print(f"Worker running: {worker.running}")

# Restart worker
worker.stop()
worker.start()
```

---

## Post-Migration Tasks

After successful migration:

1. **Update Monitoring**
   - Remove old system metrics
   - Add new system dashboards
   - Configure new alerts

2. **Document Lessons Learned**
   - What went well?
   - What challenges did we face?
   - How can we improve next time?

3. **Train Team**
   - Conduct training sessions
   - Update internal documentation
   - Share best practices

4. **Optimize Performance**
   - Review query performance
   - Adjust batch sizes if needed
   - Fine-tune connection pool settings

---

## Support Contacts

For migration assistance:

- **Technical Lead:** [Name]
- **Database Admin:** [Name]
- **DevOps:** [Name]

**Emergency Contact:** [Phone/Email]

---

**Document Version:** 1.0  
**Last Updated:** 2024-11-01  
**Review Date:** 2024-12-01
