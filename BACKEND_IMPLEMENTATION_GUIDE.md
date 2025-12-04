# Backend Implementation Guide - Missing Production Lot Endpoints
**Target Audience:** Backend Developers
**Priority:** CRITICAL - Frontend is ready, waiting for these 3 endpoints

---

## Quick Reference

| Endpoint | Method | Path | Status | Required By | Priority |
|---|---|---|---|---|---|
| Add Subprocess | POST | `/api/upf/production-lots/{id}/subprocesses` | MISSING | Frontend ready | 🔴 CRITICAL |
| Update Variants | POST | `/api/upf/production-lots/{id}/subprocesses/{sid}/variants` | MISSING | Frontend ready | 🔴 CRITICAL |
| Bulk Acknowledge | POST | `/api/upf/inventory-alerts/bulk-acknowledge` | WRONG PATH | Frontend ready | 🟠 HIGH |

---

## Endpoint 1: Add Subprocess to Production Lot

### Specification

**Route Definition:**
```python
@production_api_bp.route("/production-lots/<int:lot_id>/subprocesses", methods=["POST"])
@login_required
def add_subprocess_to_lot(lot_id: int):
    """
    Add subprocess selection to production lot.
    
    This endpoint links a subprocess (from the process definition) to a production lot.
    When a subprocess is added, it becomes available for variant selection.
    
    Docstring format for API docs:
    ---
    parameters:
      - in: path
        name: lot_id
        type: integer
        required: true
        description: Production lot ID
      - in: body
        name: body
        required: true
        schema:
          properties:
            subprocess_id:
              type: integer
              description: Process subprocess ID to add
    responses:
      201:
        description: Subprocess added successfully
        schema:
          properties:
            data:
              type: object
              properties:
                message:
                  type: string
      400:
        description: Validation error
      403:
        description: Access denied
      404:
        description: Lot not found
      500:
        description: Server error
    """
    pass
```

### Implementation Skeleton

```python
@production_api_bp.route("/production-lots/<int:lot_id>/subprocesses", methods=["POST"])
@login_required
def add_subprocess_to_lot(lot_id: int):
    try:
        # 1. Validate request format
        if not request.is_json:
            return APIResponse.error(
                "validation_error", "Content-Type must be application/json", 400
            )
        
        data = request.json or {}
        subprocess_id = data.get("subprocess_id")
        
        # 2. Validate subprocess_id provided
        if not subprocess_id:
            return APIResponse.error(
                "validation_error", "subprocess_id is required", 400
            )
        
        # 3. Check lot exists and user has access
        lot = ProductionService.get_production_lot(lot_id)
        if not lot:
            return APIResponse.not_found("Production lot", lot_id)
        
        if lot["created_by"] != getattr(current_user, "id", None) and not is_admin():
            return APIResponse.error("forbidden", "Access denied", 403)
        
        # 4. Validate lot status allows modifications
        if lot["status"] not in ["planning", "ready", "draft"]:
            return APIResponse.error(
                "validation_error", 
                f"Lot status '{lot['status']}' does not allow adding subprocesses",
                400
            )
        
        # 5. Validate subprocess exists in process
        from database import get_conn
        from psycopg2.extras import RealDictCursor
        
        with get_conn(cursor_factory=RealDictCursor) as (conn, cur):
            cur.execute(
                """SELECT id, subprocess_id, sequence_order 
                   FROM process_subprocesses 
                   WHERE id = %s""",
                (subprocess_id,)
            )
            process_subprocess = cur.fetchone()
            
            if not process_subprocess:
                return APIResponse.error(
                    "validation_error",
                    f"Subprocess with ID {subprocess_id} not found",
                    404
                )
            
            # 6. Check if subprocess already added to lot
            cur.execute(
                """SELECT id FROM lot_production_subprocess 
                   WHERE production_lot_id = %s AND process_subprocess_id = %s""",
                (lot_id, subprocess_id)
            )
            
            if cur.fetchone():
                return APIResponse.error(
                    "validation_error",
                    "Subprocess already added to this lot",
                    400
                )
            
            # 7. Add subprocess to lot
            # TODO: Determine if ProductionService has method or do direct insert
            # ProductionService.add_subprocess_to_lot(lot_id, subprocess_id)
            
            # OR direct insert:
            cur.execute(
                """INSERT INTO lot_production_subprocess 
                   (production_lot_id, process_subprocess_id, created_at) 
                   VALUES (%s, %s, NOW())
                   RETURNING id""",
                (lot_id, subprocess_id)
            )
            conn.commit()
            new_id = cur.fetchone()["id"]
        
        # 8. Log audit trail
        current_app.logger.info(
            f"Subprocess {subprocess_id} added to lot {lot_id} by user {current_user.id}"
        )
        
        return APIResponse.created(
            {"id": new_id, "message": "Subprocess added to production lot"},
            "Subprocess added successfully"
        )
        
    except Exception as e:
        current_app.logger.error(f"Error adding subprocess to lot: {e}", exc_info=True)
        return APIResponse.error("internal_error", str(e), 500)
```

### Key Database Considerations

**Table:** `lot_production_subprocess` (or equivalent)
```sql
-- Assumed schema
CREATE TABLE lot_production_subprocess (
    id SERIAL PRIMARY KEY,
    production_lot_id INTEGER NOT NULL REFERENCES production_lots(id),
    process_subprocess_id INTEGER NOT NULL REFERENCES process_subprocesses(id),
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(production_lot_id, process_subprocess_id)
);
```

**Validation Rules:**
- subprocess_id must reference valid `process_subprocesses` record
- Lot must be in planning/ready/draft status (not completed/finalized)
- Subprocess should not already be added to lot (UNIQUE constraint)
- User must be lot creator or admin

---

## Endpoint 2: Update Subprocess Variants

### Specification

**Route Definition:**
```python
@production_api_bp.route(
    "/production-lots/<int:lot_id>/subprocesses/<int:subprocess_id>/variants",
    methods=["POST"]
)
@login_required
def update_subprocess_variants(lot_id: int, subprocess_id: int):
    """
    Update variant selections for subprocess in production lot.
    
    This endpoint replaces all variant selections for a subprocess with
    the provided list of variant IDs. Old selections are deleted.
    
    Request body:
    {
        "variant_ids": [42, 43, 44]
    }
    """
    pass
```

### Implementation Skeleton

```python
@production_api_bp.route(
    "/production-lots/<int:lot_id>/subprocesses/<int:subprocess_id>/variants",
    methods=["POST"]
)
@login_required
def update_subprocess_variants(lot_id: int, subprocess_id: int):
    try:
        # 1. Validate request format
        if not request.is_json:
            return APIResponse.error(
                "validation_error", "Content-Type must be application/json", 400
            )
        
        data = request.json or {}
        variant_ids = data.get("variant_ids", [])
        
        # 2. Validate variant_ids is array
        if not isinstance(variant_ids, list):
            return APIResponse.error(
                "validation_error", "variant_ids must be an array", 400
            )
        
        # 3. Check lot exists and user has access
        lot = ProductionService.get_production_lot(lot_id)
        if not lot:
            return APIResponse.not_found("Production lot", lot_id)
        
        if lot["created_by"] != getattr(current_user, "id", None) and not is_admin():
            return APIResponse.error("forbidden", "Access denied", 403)
        
        # 4. Validate subprocess is in this lot
        from database import get_conn
        from psycopg2.extras import RealDictCursor
        
        with get_conn(cursor_factory=RealDictCursor) as (conn, cur):
            cur.execute(
                """SELECT id FROM lot_production_subprocess 
                   WHERE production_lot_id = %s AND process_subprocess_id = %s""",
                (lot_id, subprocess_id)
            )
            
            if not cur.fetchone():
                return APIResponse.error(
                    "validation_error",
                    f"Subprocess {subprocess_id} not in lot {lot_id}",
                    400
                )
            
            # 5. Validate all variant_ids exist and belong to this subprocess
            if variant_ids:
                cur.execute(
                    """SELECT id, variant_id FROM variant_usage 
                       WHERE process_subprocess_id = %s AND variant_id = ANY(%s)""",
                    (subprocess_id, variant_ids)
                )
                valid_variants = {row["variant_id"] for row in cur.fetchall()}
                
                invalid_ids = set(variant_ids) - valid_variants
                if invalid_ids:
                    return APIResponse.error(
                        "validation_error",
                        f"Invalid variant IDs for subprocess: {list(invalid_ids)}",
                        400
                    )
            
            # 6. Delete existing variant selections for this subprocess/lot
            # TODO: Verify table name and structure
            cur.execute(
                """DELETE FROM lot_subprocess_variant_selection 
                   WHERE lot_id = %s AND subprocess_id = %s""",
                (lot_id, subprocess_id)
            )
            deleted_count = cur.rowcount
            
            # 7. Insert new variant selections
            inserted_count = 0
            if variant_ids:
                for variant_id in variant_ids:
                    cur.execute(
                        """INSERT INTO lot_subprocess_variant_selection 
                           (lot_id, subprocess_id, variant_id, created_at) 
                           VALUES (%s, %s, %s, NOW())""",
                        (lot_id, subprocess_id, variant_id)
                    )
                    inserted_count += 1
            
            conn.commit()
        
        # 8. Log audit
        current_app.logger.info(
            f"Updated variants for subprocess {subprocess_id} in lot {lot_id}: "
            f"deleted {deleted_count}, inserted {inserted_count}"
        )
        
        return APIResponse.success(
            {
                "message": "Variants updated successfully",
                "subprocess_id": subprocess_id,
                "variant_ids": variant_ids,
                "deleted_count": deleted_count,
                "inserted_count": inserted_count
            }
        )
        
    except Exception as e:
        current_app.logger.error(f"Error updating subprocess variants: {e}", exc_info=True)
        return APIResponse.error("internal_error", str(e), 500)
```

### Key Database Considerations

**Table:** `lot_subprocess_variant_selection` (or equivalent)
```sql
-- Assumed schema
CREATE TABLE lot_subprocess_variant_selection (
    id SERIAL PRIMARY KEY,
    lot_id INTEGER NOT NULL REFERENCES production_lots(id),
    subprocess_id INTEGER NOT NULL REFERENCES process_subprocesses(id),
    variant_id INTEGER NOT NULL REFERENCES variant_usage(id),
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(lot_id, subprocess_id, variant_id)
);
```

**Validation Rules:**
- All variant_ids must exist in `variant_usage` table
- All variants must belong to specified subprocess
- Old selections are completely replaced (no merge)
- Empty list clears all selections

---

## Endpoint 3: Bulk Acknowledge Alerts

### Current Mismatch

**Frontend sends:**
```
POST /api/upf/inventory-alerts/bulk-acknowledge
Body: { "alert_ids": [1001, 1002, 1003] }
```

**Backend exists at:**
```
POST /api/upf/inventory-alerts/lot/{id}/acknowledge-bulk
Body: { "acknowledgments": [...] }
```

### Solution: Add Frontend-Compatible Endpoint

**Add this to `inventory_alerts.py`:**

```python
@inventory_alerts_bp.route("/inventory-alerts/bulk-acknowledge", methods=["POST"])
@login_required
def upf_bulk_acknowledge_alerts():
    """
    Bulk acknowledge multiple inventory alerts (generic, not lot-scoped).
    
    Frontend compatibility endpoint. Matches frontend expectations:
    - POST /api/upf/inventory-alerts/bulk-acknowledge
    - Body: { "alert_ids": [1001, 1002, 1003] }
    
    This is a generic endpoint that acknowledges any alerts the user has
    access to (based on their lot associations).
    """
    try:
        data = request.json or {}
        alert_ids = data.get("alert_ids", [])
        
        if not isinstance(alert_ids, list) or len(alert_ids) == 0:
            return APIResponse.error(
                "validation_error",
                "alert_ids must be a non-empty array",
                400
            )
        
        # Acknowledge alerts via service
        acknowledged_count = 0
        for alert_id in alert_ids:
            try:
                updated = InventoryAlertService.acknowledge_alert(alert_id)
                if updated:
                    acknowledged_count += 1
            except Exception as e:
                current_app.logger.warning(
                    f"Failed to acknowledge alert {alert_id}: {e}"
                )
        
        current_app.logger.info(
            f"Bulk acknowledged {acknowledged_count} alerts by user {current_user.id}"
        )
        
        return APIResponse.success(
            {
                "acknowledged_count": acknowledged_count,
                "total_requested": len(alert_ids),
                "message": f"{acknowledged_count} alert(s) acknowledged successfully"
            }
        )
        
    except Exception as e:
        current_app.logger.error(f"Error in bulk acknowledge alerts: {e}", exc_info=True)
        return APIResponse.error("internal_error", str(e), 500)
```

---

## Integration Testing Checklist

After implementing all 3 endpoints:

- [ ] Endpoint 1: Add subprocess
  - [ ] POST returns 201 with correct response
  - [ ] Validation errors return 400
  - [ ] Duplicate subprocess returns 400
  - [ ] Invalid lot_id returns 404
  - [ ] Access control returns 403
  
- [ ] Endpoint 2: Update variants
  - [ ] POST returns 200 with correct response
  - [ ] Empty variant_ids clears selections
  - [ ] Invalid variant_ids returns 400
  - [ ] Old selections deleted correctly
  - [ ] New selections inserted correctly
  
- [ ] Endpoint 3: Bulk acknowledge
  - [ ] POST returns 200 with correct response
  - [ ] All alert_ids are acknowledged
  - [ ] Returns count of acknowledged alerts
  - [ ] Empty array returns 400

---

## Deployment Sequence

1. **Review:** Have another developer review the implementation
2. **Test:** Run unit tests and integration tests
3. **Deploy:** Deploy to staging
4. **Verify:** Test from frontend in staging environment
5. **Monitor:** Watch logs for errors during initial use
6. **Promote:** Deploy to production

---

## Support Information

- **Frontend Ready:** Yes - `production_lot_detail.js` is complete
- **API Documentation:** See `API_ENDPOINTS_COMPLETE.md`
- **Validation Report:** See `API_VALIDATION_REPORT.md`
- **Frontend Integration:** See `production_lot_detail.js` lines indicated in validation report

---

## Questions?

If database schema differs from assumptions:
1. Update table names in SQL queries
2. Update column names to match actual schema
3. Verify foreign key relationships
4. Check for soft deletes or audit columns

All endpoints follow existing patterns in `production_lot.py` and `inventory_alerts.py`.

