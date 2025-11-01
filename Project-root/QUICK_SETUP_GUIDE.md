# Quick Setup Guide - UPSERT Import System

## Prerequisites

- PostgreSQL database
- Redis server (optional, will fallback to in-memory if unavailable)
- Python 3.8+
- Flask application

## Setup Steps

### 1. Install Dependencies

All required dependencies are already in `requirements.txt`:

```bash
pip install -r requirements.txt
```

**Key dependencies:**
- `redis>=5.0.8` - For progress tracking (optional)
- `psycopg[binary]>=3.2.2` - PostgreSQL adapter
- `flask>=3.0.0` - Web framework

### 2. Update Configuration

Add to `.env` file:

```env
# Import Configuration
IMPORT_BATCH_SIZE=1000
IMPORT_MAX_ROWS=50000
IMPORT_TIMEOUT_SECONDS=600
IMPORT_BACKGROUND_THRESHOLD=1000

# Redis for Progress Tracking (optional)
RATELIMIT_STORAGE_URL=redis://localhost:6379/0
REDIS_PROGRESS_EXPIRY=86400

# Feature Flag (start disabled for gradual migration)
USE_NEW_IMPORT_SYSTEM=false
```

### 3. Run Database Migrations

```bash
# Navigate to project root
cd c:\Users\erkar\OneDrive\Desktop\MTC\Project-root

# Run migrations
python migrations/migration_add_unique_indexes_for_upsert.py
python migrations/migration_add_import_jobs.py
```

**Verify migrations:**
```sql
-- Check indexes
SELECT tablename, indexname FROM pg_indexes 
WHERE indexname LIKE 'idx_%unique';

-- Check tables
SELECT table_name FROM information_schema.tables 
WHERE table_name IN ('import_jobs', 'import_results');
```

### 4. Initialize Services in Flask App

Update your Flask app initialization (e.g., `app/__init__.py` or `run.py`):

```python
from flask import Flask
from app.services import init_progress_tracker, init_background_worker
from app.api.imports import imports_bp

def create_app():
    app = Flask(__name__)
    app.config.from_object('config.get_config()')
    
    # ... existing initialization (database, login, etc.) ...
    
    # Initialize import services
    with app.app_context():
        # Initialize progress tracker
        init_progress_tracker(
            redis_url=app.config.get('RATELIMIT_STORAGE_URL'),
            expiry_seconds=app.config.get('REDIS_PROGRESS_EXPIRY', 86400)
        )
        
        # Initialize background worker (only if using new system)
        if app.config.get('USE_NEW_IMPORT_SYSTEM', False):
            init_background_worker(poll_interval=5, max_retries=3)
    
    # Register new imports blueprint
    app.register_blueprint(imports_bp)
    
    return app
```

### 5. Test the System

```bash
# Start Flask application
python run.py

# Test endpoints (use Postman, curl, or your API client)
```

**Test small import (synchronous):**
```bash
curl -X POST http://localhost:5000/api/imports/items \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "mappings": {"Item": "name", "Stock": "opening_stock", "Color": "color", "Size": "size"},
    "data": [
      {"Item": "Test Item", "Stock": 100, "Color": "Red", "Size": "M"}
    ]
  }'
```

**Expected response:**
```json
{
  "message": "Import completed: 1/1 rows imported",
  "import_id": "550e8400-e29b-41d4-a716-446655440000",
  "summary": {
    "total_rows": 1,
    "processed": 1,
    "failed": 0,
    "skipped": 0,
    "success_rate": 100.0,
    "duration_seconds": 0.15
  },
  "status": "completed"
}
```

### 6. Gradual Deployment

**Phase 1: Test Only (Week 1-2)**
```env
USE_NEW_IMPORT_SYSTEM=false  # Keep disabled
```

**Phase 2: Test Users (Week 3)**
```env
USE_NEW_IMPORT_SYSTEM=test_users_only
```

**Phase 3: Gradual Rollout (Week 4)**
```env
USE_NEW_IMPORT_SYSTEM=percentage:10  # 10% of traffic
```

**Phase 4: Full Migration (Week 5)**
```env
USE_NEW_IMPORT_SYSTEM=true
```

---

## API Endpoints

### Submit Import
```
POST /api/imports/items
Authorization: Bearer TOKEN
Content-Type: application/json

{
  "mappings": {"CSV_Col": "DB_Col"},
  "data": [{...}]
}
```

### Check Progress
```
GET /api/imports/<import_id>/progress
Authorization: Bearer TOKEN
```

### Get Results
```
GET /api/imports/<import_id>/results
Authorization: Bearer TOKEN
```

### Cancel Import
```
POST /api/imports/<import_id>/cancel
Authorization: Bearer TOKEN
```

### List Jobs
```
GET /api/imports/jobs?status=completed&limit=50
Authorization: Bearer TOKEN
```

---

## Monitoring

### Check System Health

**Database indexes:**
```sql
SELECT indexname, indexdef 
FROM pg_indexes 
WHERE tablename = 'item_master' AND indexname LIKE '%unique%';
```

**Active imports:**
```sql
SELECT import_id, status, total_rows, processed_rows, created_at
FROM import_jobs
WHERE status IN ('pending', 'processing')
ORDER BY created_at DESC;
```

**Recent imports:**
```sql
SELECT 
    ij.import_id,
    ij.status,
    ir.processed,
    ir.failed,
    ir.success_rate,
    ir.duration_seconds
FROM import_jobs ij
LEFT JOIN import_results ir USING (import_id)
ORDER BY ij.created_at DESC
LIMIT 10;
```

### View Logs

```bash
# Application logs
tail -f logs/app.log | grep import

# Import-specific logs
tail -f logs/app.log | grep "import_service\|progress_tracker\|background_worker"
```

---

## Troubleshooting

### Issue: "Import not found or expired"

**Cause:** Progress data expired (24 hours) or Redis unavailable.

**Solution:**
- Check Redis connection: `redis-cli ping`
- Import completed more than 24 hours ago (use `/results` endpoint)

### Issue: "Unique constraint violation"

**Cause:** Duplicate item names in database.

**Solution:**
```sql
-- Find duplicates
SELECT name, COUNT(*) FROM item_master 
WHERE deleted_at IS NULL 
GROUP BY name HAVING COUNT(*) > 1;

-- Resolve by renaming
UPDATE item_master 
SET name = name || ' (duplicate)'
WHERE item_id IN (SELECT item_id FROM duplicates);
```

### Issue: Import hangs/times out

**Cause:** Too many rows or database performance.

**Solution:**
- Check `IMPORT_MAX_ROWS` limit (50,000)
- Reduce `IMPORT_BATCH_SIZE` to 500
- Check database query performance

### Issue: Background worker not processing

**Cause:** Worker not initialized or crashed.

**Solution:**
```python
# Check worker status
from app.services import get_background_worker
worker = get_background_worker()
print(f"Running: {worker.running}")

# Restart if needed
worker.stop()
worker.start()
```

---

## Performance Tuning

### Optimal Batch Sizes

| Scenario | Batch Size |
|----------|------------|
| Simple imports (few constraints) | 1000 |
| Complex imports (many constraints) | 500 |
| Very large imports (>10,000 rows) | 500-750 |

### Database Connection Pool

```env
DB_POOL_MIN=5
DB_POOL_MAX=20
DB_CONNECT_TIMEOUT=10
DB_STATEMENT_TIMEOUT=60000
```

### Redis Configuration

```env
# If Redis unavailable, system falls back to in-memory
RATELIMIT_STORAGE_URL=redis://localhost:6379/0
REDIS_PROGRESS_EXPIRY=86400  # 24 hours
```

---

## Rollback Procedure

If issues arise, disable new system immediately:

```env
USE_NEW_IMPORT_SYSTEM=false
```

Restart application:
```bash
systemctl restart mtc-app  # or your restart command
```

---

## Next Steps

1. ✅ Complete setup steps above
2. ✅ Test with small import (<100 rows)
3. ✅ Test with medium import (1000 rows)
4. ✅ Test with large import (10,000 rows)
5. ✅ Monitor metrics for 1 week
6. ✅ Plan gradual migration schedule
7. ✅ Follow migration guide for production deployment

---

## Support

**Documentation:**
- Full Guide: `IMPORT_SYSTEM_GUIDE.md`
- Migration Guide: `IMPORT_MIGRATION_GUIDE.md`
- Implementation Summary: `IMPORT_IMPLEMENTATION_SUMMARY.md`

**Quick Help:**
```bash
# View all import-related files
ls -la app/services/import*.py
ls -la app/validators/import*.py
ls -la app/api/imports.py
ls -la migrations/migration_add_*import*.py
```

---

**Setup Time:** ~30 minutes  
**Testing Time:** ~1 hour  
**Full Deployment:** 4-6 weeks (gradual migration)
