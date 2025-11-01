# UPSERT-Based Import System - Implementation Guide

## Overview

This document provides a comprehensive guide for the new UPSERT-based import system that replaces table-level locking with PostgreSQL's `ON CONFLICT` pattern. The new system enables concurrent reads and writes during imports while maintaining data integrity.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Components](#components)
3. [Migration Steps](#migration-steps)
4. [API Documentation](#api-documentation)
5. [Configuration](#configuration)
6. [Monitoring and Logging](#monitoring-and-logging)
7. [Testing](#testing)
8. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

### Old System (Table-Level Locking)
```
User → API → LOCK TABLE → Sequential Insert → COMMIT → Unlock
          └─── Application unavailable during import ───┘
```

**Problems:**
- Blocks all concurrent operations (reads and writes)
- Application unavailable during large imports
- Denial-of-service vulnerability
- No progress tracking or error recovery

### New System (UPSERT Pattern)
```
User → API → Validation → Chunked Batches → UPSERT → Commit per Batch
          └─── Concurrent operations allowed ───┘
          └─── Progress tracking ───┘
          └─── Row-level error handling ───┘
```

**Benefits:**
- Concurrent reads and writes during imports
- Chunked processing with progress tracking
- Row-level error handling (partial success)
- Background processing for large imports
- No application downtime

---

## Components

### 1. Data Validation Layer
**Location:** `app/validators/import_validators.py`

**Purpose:** Validates and sanitizes import data before database operations.

**Features:**
- SQL injection prevention
- Field-level validation (length, type, required fields)
- Batch duplicate detection
- Data sanitization (trim, normalize, escape)

**Usage:**
```python
from app.validators import validate_batch

valid_rows, invalid_rows = validate_batch(import_data)
```

### 2. Import Service
**Location:** `app/services/import_service.py`

**Purpose:** Core import logic using UPSERT pattern with chunked batch processing.

**Features:**
- Chunked batch processing (configurable batch size)
- UPSERT operations for all master tables
- Row-level error handling
- Progress tracking integration
- Connection pooling and retry logic

**Usage:**
```python
from app.services import ImportService

service = ImportService(batch_size=1000)
result = service.import_items_chunked(data=import_data)
```

### 3. Progress Tracker
**Location:** `app/services/progress_tracker.py`

**Purpose:** Real-time progress tracking for long-running imports.

**Features:**
- Redis-based storage with 24-hour auto-expiry
- Estimated time remaining calculation
- Graceful fallback to in-memory storage
- Thread-safe operations

**Usage:**
```python
from app.services import create_import_id, track_progress, get_progress

import_id = create_import_id()
track_progress(import_id, processed=500, total=1000)
progress = get_progress(import_id)
```

### 4. Background Worker
**Location:** `app/services/background_worker.py`

**Purpose:** Process large imports in the background without blocking API requests.

**Features:**
- Database-backed job queue
- Automatic retry on transient failures
- Job cancellation support
- Worker thread management

**Usage:**
```python
from app.services import queue_import_job

job_id = queue_import_job(
    import_id=import_id,
    user_id=user_id,
    table_name='item_master',
    total_rows=total_rows,
    import_data=data
)
```

### 5. API Routes
**Location:** `app/api/imports.py`

**Purpose:** REST API endpoints for import operations.

**Endpoints:**
- `POST /api/imports/items` - Submit import (sync or async)
- `GET /api/imports/<import_id>/progress` - Check progress
- `GET /api/imports/<import_id>/results` - Get final results
- `POST /api/imports/<import_id>/cancel` - Cancel import
- `GET /api/imports/jobs` - List user's import jobs

---

## Migration Steps

### Step 1: Run Database Migrations

```bash
# 1. Add unique indexes for UPSERT operations
python migrations/migration_add_unique_indexes_for_upsert.py

# 2. Create import_jobs table for background processing
python migrations/migration_add_import_jobs.py
```

**What this does:**
- Creates UNIQUE indexes on `item_master(name)`, `color_master(color_name)`, `size_master(size_name)`
- Creates partial indexes excluding soft-deleted records (`WHERE deleted_at IS NULL`)
- Creates `import_jobs` and `import_results` tables
- Adds performance indexes for frequently queried columns

### Step 2: Update Configuration

Add the following to your `.env` file:

```env
# Import configuration
IMPORT_BATCH_SIZE=1000
IMPORT_MAX_ROWS=50000
IMPORT_TIMEOUT_SECONDS=600
IMPORT_BACKGROUND_THRESHOLD=1000

# Redis configuration for progress tracking
RATELIMIT_STORAGE_URL=redis://localhost:6379/0
REDIS_PROGRESS_EXPIRY=86400
```

### Step 3: Initialize Services in Flask App

Update your Flask app initialization (in `__init__.py` or `app.py`):

```python
from flask import Flask
from app.services import init_progress_tracker, init_background_worker

def create_app():
    app = Flask(__name__)
    app.config.from_object('config.get_config()')
    
    # ... existing initialization ...
    
    # Initialize progress tracker
    with app.app_context():
        init_progress_tracker(
            redis_url=app.config.get('RATELIMIT_STORAGE_URL'),
            expiry_seconds=app.config.get('REDIS_PROGRESS_EXPIRY', 86400)
        )
        
        # Initialize background worker
        init_background_worker(poll_interval=5, max_retries=3)
    
    # Register new imports blueprint
    from app.api.imports import imports_bp
    app.register_blueprint(imports_bp)
    
    return app
```

### Step 4: Test New System

Run tests to verify the new system works correctly:

```bash
# Run unit tests
pytest tests/test_import_service.py

# Run integration tests
pytest tests/test_imports_api.py

# Run performance tests
pytest tests/test_import_performance.py
```

### Step 5: Deploy with Feature Flag

Deploy the new code with a feature flag to gradually migrate traffic:

```python
# In your existing import route
USE_NEW_IMPORT_SYSTEM = os.getenv('USE_NEW_IMPORT_SYSTEM', 'false').lower() == 'true'

if USE_NEW_IMPORT_SYSTEM:
    # Route to new imports API
    return redirect(url_for('imports.import_items'))
else:
    # Use old locking-based import
    # ... existing code ...
```

### Step 6: Monitor and Validate

Monitor the new system for 2-4 weeks:

- Check import success rates
- Monitor database performance
- Review error logs
- Compare import duration (old vs new)
- Verify concurrent operations work correctly

### Step 7: Remove Old Code

After successful validation:

1. Remove old locking-based import code
2. Remove feature flag
3. Update documentation
4. Train team on new import process

---

## API Documentation

### 1. Submit Import (Synchronous or Background)

**Endpoint:** `POST /api/imports/items`

**Authentication:** Required (admin role)

**Rate Limit:** 10 requests per hour

**Request Body:**
```json
{
  "mappings": {
    "Item": "name",
    "Category": "category",
    "Description": "description",
    "Color": "color",
    "Size": "size",
    "Stock": "opening_stock"
  },
  "data": [
    {
      "Item": "T-Shirt",
      "Category": "Clothing",
      "Description": "Cotton T-Shirt",
      "Color": "Red",
      "Size": "M",
      "Stock": 100
    }
  ]
}
```

**Response (Synchronous - <1000 rows):**
```json
{
  "message": "Import completed: 950/1000 rows imported",
  "import_id": "550e8400-e29b-41d4-a716-446655440000",
  "summary": {
    "total_rows": 1000,
    "processed": 950,
    "failed": 30,
    "skipped": 20,
    "success_rate": 95.0,
    "duration_seconds": 12.34
  },
  "failed_rows": [
    {
      "row_number": 15,
      "row": {...},
      "error": "Duplicate item name",
      "field": "name"
    }
  ],
  "status": "completed"
}
```

**Response (Background - >=1000 rows):**
```json
{
  "message": "Import queued for background processing (5000 rows)",
  "import_id": "550e8400-e29b-41d4-a716-446655440000",
  "job_id": 123,
  "total_rows": 5000,
  "status": "queued"
}
```

### 2. Check Import Progress

**Endpoint:** `GET /api/imports/<import_id>/progress`

**Authentication:** Required

**Response:**
```json
{
  "import_id": "550e8400-e29b-41d4-a716-446655440000",
  "processed": 3000,
  "total": 5000,
  "percentage": 60.0,
  "failed": 50,
  "current_batch": 3,
  "total_batches": 5,
  "estimated_seconds_remaining": 45,
  "updated_at": "2024-11-01T12:34:56Z",
  "status": "processing"
}
```

### 3. Get Import Results

**Endpoint:** `GET /api/imports/<import_id>/results`

**Authentication:** Required

**Response:**
```json
{
  "import_id": "550e8400-e29b-41d4-a716-446655440000",
  "processed": 4950,
  "failed": 30,
  "skipped": 20,
  "total_rows": 5000,
  "success_rate": 99.0,
  "duration_seconds": 67.89,
  "failed_rows": [
    {
      "row_number": 42,
      "row": {...},
      "error": "Invalid stock value",
      "field": "stock"
    }
  ],
  "created_at": "2024-11-01T12:30:00Z",
  "status": "completed"
}
```

### 4. Cancel Import

**Endpoint:** `POST /api/imports/<import_id>/cancel`

**Authentication:** Required (admin role)

**Response:**
```json
{
  "message": "Import cancelled successfully",
  "import_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "cancelled"
}
```

### 5. List Import Jobs

**Endpoint:** `GET /api/imports/jobs?status=completed&limit=50&offset=0`

**Authentication:** Required

**Query Parameters:**
- `status` (optional): Filter by status (pending, processing, completed, failed, cancelled)
- `limit` (optional): Max results (default 50, max 200)
- `offset` (optional): Pagination offset (default 0)

**Response:**
```json
{
  "jobs": [
    {
      "import_id": "550e8400-e29b-41d4-a716-446655440000",
      "table_name": "item_master",
      "total_rows": 5000,
      "processed_rows": 4950,
      "failed_rows": 50,
      "status": "completed",
      "error_message": null,
      "created_at": "2024-11-01T12:30:00Z",
      "started_at": "2024-11-01T12:30:05Z",
      "completed_at": "2024-11-01T12:35:00Z"
    }
  ],
  "count": 1,
  "limit": 50,
  "offset": 0
}
```

---

## Configuration

### Environment Variables

```env
# Import Settings
IMPORT_BATCH_SIZE=1000              # Rows per batch (default: 1000)
IMPORT_MAX_ROWS=50000               # Maximum rows per import (default: 50000)
IMPORT_TIMEOUT_SECONDS=600          # Import timeout (default: 600s = 10 minutes)
IMPORT_BACKGROUND_THRESHOLD=1000    # Trigger background if rows >= threshold

# Database Connection Pool
DB_POOL_MIN=5                       # Minimum connections (default: 2)
DB_POOL_MAX=20                      # Maximum connections (default: 20)
DB_CONNECT_TIMEOUT=10               # Connection timeout in seconds
DB_STATEMENT_TIMEOUT=60000          # Query timeout in milliseconds

# Redis for Progress Tracking
RATELIMIT_STORAGE_URL=redis://localhost:6379/0
REDIS_PROGRESS_EXPIRY=86400         # Progress data expiry (24 hours)
```

### Recommended Settings by Environment

#### Development
```env
IMPORT_BATCH_SIZE=500
IMPORT_BACKGROUND_THRESHOLD=500
DB_POOL_MIN=2
DB_POOL_MAX=10
```

#### Production
```env
IMPORT_BATCH_SIZE=1000
IMPORT_BACKGROUND_THRESHOLD=1000
DB_POOL_MIN=5
DB_POOL_MAX=20
```

---

## Monitoring and Logging

### Key Metrics to Track

1. **Import Success Rate**
   - Target: ≥95% success rate
   - Alert if falls below 90%

2. **Import Duration**
   - Baseline: ~1000 rows in <15 seconds
   - Alert if exceeds 600 seconds (10 minutes)

3. **Database Performance**
   - Query time: <100ms for UPSERT operations
   - Connection pool: <80% utilization
   - Alert if query time exceeds 1 second

4. **Failed Rows Count**
   - Track by error type (validation, constraint, connection)
   - Alert if >10% failure rate

### Logging

All import operations are logged with the following levels:

- `INFO`: Import start, progress milestones (25%, 50%, 75%, 100%), completion
- `WARNING`: Row-level failures, validation errors
- `ERROR`: Database errors, connection failures
- `CRITICAL`: System-level failures

**Log Format:**
```
2024-11-01 12:34:56,789 [INFO] import_service: Starting import of 5000 rows (batch size: 1000)
2024-11-01 12:35:10,123 [INFO] import_service: Processing batch 1/5 (1000 rows)
2024-11-01 12:35:15,456 [WARNING] import_service: Row 42 failed: Invalid stock value
2024-11-01 12:36:30,789 [INFO] import_service: Import complete: 4950/5000 successful (99.0%), duration: 93.00s
```

### Monitoring Dashboard

Create a dashboard to visualize:
- Active imports (count, status)
- Import success rate over time
- Average import duration
- Failed rows by error type
- Database connection pool utilization

---

## Testing

### Unit Tests

Test individual components in isolation:

```python
# Test validators
def test_validate_item_data():
    row = {'Item': 'T-Shirt', 'Category': 'Clothing'}
    validated = validate_item(row)
    assert validated['name'] == 'T-Shirt'
    assert validated['category'] == 'Clothing'

# Test import service UPSERT
def test_upsert_item_master():
    service = ImportService()
    # ... test UPSERT logic
```

### Integration Tests

Test end-to-end import flow:

```python
def test_import_items_api(client, auth_headers):
    data = {
        'mappings': {'Item': 'name', 'Stock': 'opening_stock'},
        'data': [{'Item': 'Test', 'Stock': 100}]
    }
    response = client.post('/api/imports/items', json=data, headers=auth_headers)
    assert response.status_code == 200
    assert response.json['summary']['processed'] == 1
```

### Performance Tests

Measure import performance at scale:

```python
@pytest.mark.performance
def test_import_10000_rows(client):
    data = generate_test_data(10000)
    start = time.time()
    response = client.post('/api/imports/items', json=data)
    duration = time.time() - start
    assert duration < 120  # Should complete in < 2 minutes
```

---

## Troubleshooting

### Common Issues

#### 1. Import Fails with "Unique Constraint Violation"

**Cause:** Duplicate item names in import data or database.

**Solution:**
- Check for duplicates in import file
- Remove or rename duplicates
- UPSERT will update existing records on conflict

#### 2. Import Times Out

**Cause:** Too many rows or slow database.

**Solution:**
- Split import into smaller batches
- Increase `IMPORT_TIMEOUT_SECONDS`
- Check database performance (slow queries, missing indexes)

#### 3. Progress Tracking Not Working

**Cause:** Redis not available or misconfigured.

**Solution:**
- Check Redis connection: `redis-cli ping`
- Verify `RATELIMIT_STORAGE_URL` in `.env`
- System will fall back to in-memory tracking

#### 4. Background Job Not Processing

**Cause:** Worker not started or database connection issues.

**Solution:**
- Check worker logs for errors
- Verify `init_background_worker()` is called during app initialization
- Check database connection pool health

#### 5. High Memory Usage During Import

**Cause:** Batch size too large or connection leak.

**Solution:**
- Reduce `IMPORT_BATCH_SIZE`
- Check connection pool settings
- Monitor memory usage during import

### Debug Mode

Enable detailed logging:

```python
import logging
logging.getLogger('app.services.import_service').setLevel(logging.DEBUG)
logging.getLogger('app.validators').setLevel(logging.DEBUG)
```

---

## Best Practices

1. **Always validate data before import**
   - Use validation layer to catch errors early
   - Sanitize user input to prevent SQL injection

2. **Use appropriate batch sizes**
   - Small batches (500): Complex imports with many constraints
   - Large batches (1000): Standard imports
   - Monitor memory usage and adjust accordingly

3. **Handle errors gracefully**
   - Log all errors with row data for debugging
   - Continue processing remaining rows (partial success)
   - Provide clear error messages to users

4. **Monitor performance**
   - Track import duration and success rate
   - Alert on performance degradation
   - Review slow query logs

5. **Test at scale**
   - Test with maximum row count (50,000)
   - Test with concurrent imports
   - Test error scenarios (network failures, constraint violations)

---

## Support

For questions or issues:
- Check logs in `logs/import.log`
- Review failed rows in import results
- Contact development team for assistance

---

**Document Version:** 1.0  
**Last Updated:** 2024-11-01  
**Authors:** Development Team
