# Code Implementation Reference

## Summary of Changes

### File 1: `app/api/production_lot.py`

#### Addition 1: Add Subprocess to Lot Endpoint
**Location:** Lines 1433-1534 (102 lines)

Features:
- POST endpoint to add subprocess to production lot
- Comprehensive validation of inputs
- Transaction safety with commit
- Detailed logging and error handling

Key validations:
- Lot must exist
- User must be creator or admin
- Lot must be in planning/ready status
- Process subprocess must exist
- Subprocess must belong to lot's process
- Subprocess cannot already be in lot

#### Addition 2: Update Subprocess Variants Endpoint
**Location:** Lines 1537-1689 (153 lines)

Features:
- POST endpoint to update variants for subprocess in lot
- Support for batch variant operations
- Quantity override tracking
- Notes attachment

Key validations:
- Lot must exist
- User must be creator or admin
- Lot must be in planning/ready status
- Subprocess must exist in lot
- Each variant must exist and belong to subprocess
- Quantities must be positive
- Batch validation before any database changes

---

### File 2: `app/api/inventory_alerts.py`

#### Addition: Bulk Acknowledge Alerts Endpoint
**Location:** Lines 477-569 (93 lines)

Features:
- POST endpoint for bulk alert acknowledgment
- Dual input format support (alert_ids or acknowledgments array)
- Per-alert error handling
- Detailed success/failure reporting

Key validations:
- User must be authenticated
- At least one input format required
- Each alert must exist in database
- Update tracking (acknowledged_by, acknowledged_at, user_action)

---

## Database Changes

### Migration Script: `migration_final.py`

**Executed Changes:**

1. **Create Table:**
```sql
CREATE TABLE production_lot_subprocess_variants (
    id SERIAL PRIMARY KEY,
    lot_id INTEGER,
    process_subprocess_id INTEGER,
    variant_usage_id INTEGER,
    quantity_override NUMERIC(12, 4),
    notes TEXT,
    created_by INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

2. **Create Indexes:**
```sql
CREATE INDEX idx_psl_subprocess_variants_lot_id 
ON production_lot_subprocess_variants(lot_id);

CREATE INDEX idx_psl_subprocess_variants_process_subprocess_id 
ON production_lot_subprocess_variants(process_subprocess_id);
```

3. **Add Foreign Keys:**
```sql
ALTER TABLE production_lot_subprocess_variants
ADD CONSTRAINT fk_pslsv_lot_id
FOREIGN KEY (lot_id) REFERENCES production_lots(id) ON DELETE CASCADE;

ALTER TABLE production_lot_subprocess_variants
ADD CONSTRAINT fk_pslsv_process_subprocess_id
FOREIGN KEY (process_subprocess_id) REFERENCES process_subprocesses(id) ON DELETE CASCADE;

ALTER TABLE production_lot_subprocess_variants
ADD CONSTRAINT fk_pslsv_variant_usage_id
FOREIGN KEY (variant_usage_id) REFERENCES variant_usage(id) ON DELETE CASCADE;
```

4. **Add Columns to Existing Table:**
```sql
ALTER TABLE production_lot_inventory_alerts
ADD COLUMN user_acknowledged BOOLEAN DEFAULT false;

ALTER TABLE production_lot_inventory_alerts
ADD COLUMN user_action VARCHAR(50);

ALTER TABLE production_lot_inventory_alerts
ADD COLUMN action_notes TEXT;

ALTER TABLE production_lot_inventory_alerts
ADD COLUMN acknowledged_at TIMESTAMP;

ALTER TABLE production_lot_inventory_alerts
ADD COLUMN acknowledged_by INTEGER REFERENCES users(user_id);
```

---

## Validation Rules

### Add Subprocess Validations

| Rule | Type | Error Code |
|------|------|-----------|
| Lot exists | Database | 404 not_found |
| User permission | Authorization | 403 forbidden |
| Lot status in (planning, ready) | Business | 400 validation_error |
| Subprocess exists | Database | 400 validation_error |
| Subprocess belongs to process | Business | 400 validation_error |
| Subprocess not already in lot | Uniqueness | 400 validation_error |
| JSON content type | Format | 400 validation_error |

### Update Variants Validations

| Rule | Type | Error Code |
|------|------|-----------|
| Lot exists | Database | 404 not_found |
| User permission | Authorization | 403 forbidden |
| Lot status in (planning, ready) | Business | 400 validation_error |
| Subprocess exists in lot | Database | 400 validation_error |
| Variants array not empty | Required | 400 validation_error |
| Each variant exists | Database | 400 validation_error |
| Variant belongs to subprocess | Business | 400 validation_error |
| Quantities > 0 if provided | Range | 400 validation_error |
| JSON content type | Format | 400 validation_error |

### Bulk Acknowledge Validations

| Rule | Type | Error Code |
|------|------|-----------|
| User authenticated | Authentication | 401 unauthenticated |
| alert_ids OR acknowledgments provided | Required | 400 validation_error |
| Each alert_id is integer | Type | 400 validation_error |
| Each alert exists | Database | Success with failure detail |
| JSON content type | Format | 400 validation_error |

---

## Error Responses

### Example 1: Validation Error
```json
{
    "success": false,
    "data": null,
    "error": {
        "code": "validation_error",
        "message": "Lot must be in planning or ready status to add subprocesses"
    },
    "message": "Lot must be in planning or ready status to add subprocesses"
}
```

### Example 2: Not Found Error
```json
{
    "success": false,
    "data": null,
    "error": {
        "code": "not_found",
        "message": "Production lot not found with id: 999"
    },
    "message": "Production lot not found with id: 999"
}
```

### Example 3: Access Denied
```json
{
    "success": false,
    "data": null,
    "error": {
        "code": "forbidden",
        "message": "Access denied"
    },
    "message": "Access denied"
}
```

### Example 4: Bulk Acknowledge Partial Success
```json
{
    "success": true,
    "data": {
        "acknowledged_count": 2,
        "failed_count": 1,
        "alerts_acknowledged": [
            {"id": 5, "production_lot_id": 10, "user_acknowledged": true},
            {"id": 12, "production_lot_id": 10, "user_acknowledged": true}
        ],
        "failed_alerts": [
            {"alert_id": 18, "error": "Alert not found"}
        ]
    }
}
```

---

## Testing Scenarios

### Test Scenario 1: Add Subprocess Happy Path
1. Create production lot
2. Call POST /production-lots/{id}/subprocesses with valid subprocess_id
3. Verify response returns 201 with record details
4. Verify record inserted in database
5. Verify user_id captured correctly

### Test Scenario 2: Add Subprocess - Lot Not Found
1. Call POST /production-lots/999/subprocesses with valid subprocess_id
2. Verify response returns 404 not_found

### Test Scenario 3: Add Subprocess - Duplicate
1. Add subprocess once (succeeds)
2. Add same subprocess again
3. Verify response returns 400 validation_error
4. Verify only one record in database

### Test Scenario 4: Update Variants Batch
1. Add multiple variants (5+) in single request
2. Verify all inserted in transaction
3. Verify failure on one variant doesn't affect others (rollback)
4. Verify records searchable by lot_id and process_subprocess_id (indexes)

### Test Scenario 5: Bulk Acknowledge Mixed Success
1. Call with 5 alert_ids (3 exist, 2 don't)
2. Verify response shows 3 acknowledged, 2 failed
3. Verify database updated only for existing alerts
4. Verify user_id and timestamp recorded

---

## Performance Notes

### Query Patterns

**Add Subprocess Query Pattern:**
- 1 SELECT on production_lots (indexed by id)
- 1 SELECT on process_subprocesses (indexed by id) 
- 1 SELECT on production_lot_subprocesses (check duplicate)
- 1 INSERT into production_lot_subprocesses

**Update Variants Query Pattern:**
- 1 SELECT on production_lots (indexed by id)
- Multiple SELECTs on variant_usage (indexed by process_subprocess_id)
- 1 DELETE (old records if any)
- N INSERTs in single transaction

**Bulk Acknowledge Query Pattern:**
- N UPDATE queries (one per alert)
- Each UPDATE is small and fast (indexed by id)

### Index Coverage
- ✓ production_lot_subprocess_variants.lot_id - Fast filtering by lot
- ✓ production_lot_subprocess_variants.process_subprocess_id - Fast joins
- ✓ production_lots.id - PK index (implicit)
- ✓ process_subprocesses.id - PK index (implicit)
- ✓ variant_usage.id - PK index (implicit)

---

## Logging

### Log Entries Created

**Info Level:**
```
f"Subprocess {process_subprocess_id} added to lot {lot_id} by user {current_user.id}"
f"Updated {len(variant_records_inserted)} variants for subprocess {subprocess_id} in lot {lot_id}"
f"Bulk acknowledged {len(acknowledged_records)} alerts by user {uid}"
```

**Warning Level:**
- FK constraint violations
- Duplicate key violations (caught and handled)

**Error Level:**
- Database connection issues
- Validation failures (for troubleshooting)
- Unexpected exceptions

---

## Integration Points

### Frontend Integration
The frontend JavaScript will call these endpoints:

```javascript
// Add subprocess
POST /api/upf/production-lots/{lotId}/subprocesses
{
    process_subprocess_id: processSubprocessId,
    custom_name: customName,
    sequence_order: sequenceOrder
}

// Update variants
POST /api/upf/production-lots/{lotId}/subprocesses/{subprocessId}/variants
{
    selected_variants: [
        {
            variant_usage_id: variantId,
            quantity: qty,
            notes: note
        }
    ]
}

// Bulk acknowledge
POST /api/upf/inventory-alerts/bulk-acknowledge
{
    alert_ids: [id1, id2, id3]
}
```

### State Management Integration
After each successful call:
1. Frontend updates state with returned data
2. State change triggers re-render
3. UI displays updated values
4. Toast notification shows success message

---

**Implementation Date:** December 4, 2025  
**Status:** Ready for Testing & Integration
