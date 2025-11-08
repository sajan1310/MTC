# Universal Process Framework Integration Action Plan
## Complete Technical Implementation Guide for Advanced BOM + Production Lot Alert System

**Document Version:** 1.0  
**Target System:** MTC (Manufacturing/Tracking/Control) Application  
**Scope:** Database schema updates, backend services, API endpoints, frontend templates, and integration testing  
**Status:** Ready for GitHub Copilot Implementation

---

## PHASE 0: PRE-INTEGRATION VALIDATION & BACKUP

### Step 0.1: Create Comprehensive Backup
**Copilot Prompt:**
```
Create a complete database backup and code snapshot before proceeding with integration:
1. Export all PostgreSQL tables to timestamped SQL dump file
2. Create Git feature branch named 'feature/upf-alert-system-integration'
3. Document all current table row counts for rollback verification
4. Create pre-integration snapshot of all service functions currently in use
5. Verify all existing tests pass before proceeding
Location: /scripts/pre_integration_backup.py
Dependencies: psycopg2, datetime, subprocess, git
Output: Generate timestamped backup files in /backups/ directory with manifest
```

### Step 0.2: Audit Current Feature Dependencies
**Copilot Prompt:**
```
Analyze all existing features that depend on production_lots table:
1. Search codebase for imports/references to production_lots table and ProductionLot model
2. Identify all endpoints that query/modify production_lots (grep: '/api/upf/production')
3. Document current production_lot fields and their usage in services
4. List all production_lots-related frontend templates and JS files
5. Create dependency map showing service → API → template relationships
Location: /scripts/analyze_dependencies.py
Output: Generate dependency_report.json documenting all touchpoints
```

---

## PHASE 1: DATABASE SCHEMA ENHANCEMENT

### Step 1.1: Create Migration for Inventory Alert Tables
**Copilot Prompt:**
```
Create PostgreSQL migration script for inventory alert system:

1. Create new table 'inventory_alert_rules':
   - alert_rule_id SERIAL PRIMARY KEY
   - item_variant_id BIGINT REFERENCES item_variant(variant_id) ON DELETE CASCADE
   - safety_stock_quantity INTEGER NOT NULL DEFAULT 10
   - reorder_point_quantity INTEGER NOT NULL DEFAULT 20
   - alert_threshold_percentage DECIMAL(5,2) NOT NULL DEFAULT 75.00
   - is_active BOOLEAN DEFAULT TRUE
   - created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
   - updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
   - created_by BIGINT REFERENCES users(user_id)
   - Indexes: (item_variant_id, is_active)

2. Create new table 'production_lot_inventory_alerts':
   - alert_id SERIAL PRIMARY KEY
   - production_lot_id BIGINT REFERENCES production_lots(lot_id) ON DELETE CASCADE
   - item_variant_id BIGINT REFERENCES item_variant(variant_id) ON DELETE CASCADE
   - alert_severity VARCHAR(20) CHECK (alert_severity IN ('CRITICAL','HIGH','MEDIUM','LOW','OK'))
   - current_stock_quantity INTEGER NOT NULL
   - required_quantity INTEGER NOT NULL
   - shortfall_quantity INTEGER NOT NULL
   - suggested_procurement_quantity INTEGER
   - user_acknowledged BOOLEAN DEFAULT FALSE
   - acknowledged_at TIMESTAMP
   - user_action VARCHAR(50) CHECK (user_action IN ('PROCEED','DELAY','SUBSTITUTE','PARTIAL_FULFILL'))
   - action_notes TEXT
   - created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
   - Indexes: (production_lot_id, alert_severity), (item_variant_id, created_at)

3. Create new table 'production_lot_procurement_recommendations':
   - recommendation_id SERIAL PRIMARY KEY
   - production_lot_id BIGINT REFERENCES production_lots(lot_id) ON DELETE CASCADE
   - item_variant_id BIGINT REFERENCES item_variant(variant_id) ON DELETE CASCADE
   - supplier_id BIGINT REFERENCES suppliers(supplier_id)
   - recommended_quantity INTEGER NOT NULL
   - required_delivery_date DATE NOT NULL
   - procurement_status VARCHAR(30) CHECK (procurement_status IN ('RECOMMENDED','ORDERED','RECEIVED','PARTIAL','CANCELLED'))
   - purchase_order_id BIGINT REFERENCES purchase_orders(po_id) ON DELETE SET NULL
   - estimated_cost DECIMAL(12,2)
   - created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
   - updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
   - Indexes: (production_lot_id, procurement_status), (supplier_id, required_delivery_date)

4. Alter existing table 'production_lots':
   - Add column: lot_status_inventory VARCHAR(30) DEFAULT 'READY' CHECK (lot_status_inventory IN ('READY','PENDING_PROCUREMENT','PARTIAL_FULFILLMENT_REQUIRED','ON_HOLD'))
   - Add column: alert_summary_json JSONB DEFAULT '{}'
   - Add column: inventory_validated_at TIMESTAMP
   - Add column: inventory_validated_by BIGINT REFERENCES users(user_id)
   - Create index on (lot_status_inventory)

5. Create trigger function 'update_lot_inventory_status()':
   - When alert created/updated, recalculate lot_status_inventory based on alert severities
   - If any CRITICAL alert exists → lot_status_inventory = 'PENDING_PROCUREMENT'
   - Else if any HIGH alert → lot_status_inventory = 'PARTIAL_FULFILLMENT_REQUIRED'
   - Else → lot_status_inventory = 'READY'
   - Update alert_summary_json with alert counts by severity

6. Create index on 'variant_usage' (process_subprocess_id, item_variant_id) for fast alert lookup

Location: /migrations/migration_add_inventory_alert_system.py
File format: Python script with up() and down() functions
Include: Transaction safety, rollback logic, data validation
Verify: All FK constraints, CHECK constraints, indexes created successfully
```

### Step 1.2: Verify Schema Integrity
**Copilot Prompt:**
```
Create schema validation script post-migration:
1. Verify all new tables created successfully
2. Confirm all FK constraints in place
3. Check all indexes exist and are accessible
4. Validate trigger function syntax and execution
5. Run sample inserts to verify constraints work
6. Test cascade delete behavior on production_lots deletion
7. Confirm JSONB column accepts valid JSON
8. Performance test: query 1M rows from production_lot_inventory_alerts with alert_severity filter
Location: /scripts/validate_alert_schema.py
Output: Generate schema_validation_report.txt with all checks PASSED/FAILED
```

---

## PHASE 2: BACKEND SERVICE LAYER ENHANCEMENT

### Step 2.1: Create InventoryAlertService
**Copilot Prompt:**
```
Create new file /app/services/inventory_alert_service.py with following methods:

Class: InventoryAlertService

Method 1: get_safety_stock_rules(item_variant_id=None)
- Purpose: Retrieve safety stock and reorder point configuration for variants
- Input: Optional item_variant_id filter (if None, return all active rules)
- Database: SELECT from inventory_alert_rules WHERE is_active=TRUE
- Output: List[Dict] with variant_id, safety_stock_quantity, reorder_point_quantity, alert_threshold_percentage
- Error handling: Handle missing rules (return defaults if not configured)

Method 2: check_inventory_levels_for_production_lot(production_lot_id)
- Purpose: Real-time stock level analysis for all variants in a production lot
- Input: production_lot_id (integer)
- Database queries:
  a) SELECT production_lot.process_id, production_lot.quantity FROM production_lots WHERE lot_id = production_lot_id
  b) SELECT process_subprocesses + variant_usage (JOIN with process to get structure)
  c) For each variant in structure:
     - Calculate required_quantity = variant_usage.quantity × production_lot.quantity
     - Query item_inventory.current_stock for each variant
     - Lookup safety_stock_rules for thresholds
- Logic:
  1. For each variant, determine alert_severity based on:
     - current_stock = 0 → CRITICAL
     - current_stock < required_quantity → HIGH
     - current_stock < (required_quantity + safety_stock) → MEDIUM
     - current_stock < reorder_point → LOW
     - current_stock >= (required_quantity + safety_stock) → OK
  2. Compile alerts list
- Output: List[Dict] containing:
  {
    "item_variant_id": int,
    "variant_name": str,
    "supplier_id": int,
    "current_stock": int,
    "required_quantity": int,
    "alert_severity": str,
    "shortfall_quantity": int,
    "suggested_procurement_qty": int,
    "lead_time_days": int,
    "supplier_name": str
  }
- Error handling: If process/structure not found, raise ProcessNotFoundError
- Performance: Use batch queries (CTEs) to minimize DB round-trips

Method 3: create_production_lot_alerts(production_lot_id, alerts_list)
- Purpose: Insert alerts into production_lot_inventory_alerts table
- Input: production_lot_id (int), alerts_list from check_inventory_levels_for_production_lot
- Database:
  - For each alert in alerts_list:
    - INSERT INTO production_lot_inventory_alerts (production_lot_id, item_variant_id, alert_severity, current_stock_quantity, required_quantity, shortfall_quantity, suggested_procurement_quantity, user_acknowledged, created_at)
  - Call trigger to update lot_status_inventory
- Output: List[alert_id] of created alerts
- Error handling: Transaction rollback if any insert fails

Method 4: acknowledge_inventory_alert(alert_id, user_action, action_notes)
- Purpose: Record user response to inventory alert
- Input: alert_id (int), user_action (enum: PROCEED|DELAY|SUBSTITUTE|PARTIAL_FULFILL), action_notes (optional str)
- Database:
  - UPDATE production_lot_inventory_alerts SET user_acknowledged=TRUE, acknowledged_at=NOW(), user_action=user_action, action_notes=action_notes WHERE alert_id=alert_id
  - Trigger updates lot_status_inventory
- Output: Updated alert record as Dict
- Error handling: If alert_id not found, raise AlertNotFoundError

Method 5: generate_procurement_recommendations(production_lot_id, alerts_list)
- Purpose: Create procurement recommendations for high/critical alerts
- Input: production_lot_id (int), alerts_list (filtered to HIGH + CRITICAL severity)
- Database:
  1. Query supplier_pricing for each variant (get min lead time and supplier)
  2. For each high/critical alert:
     - INSERT INTO production_lot_procurement_recommendations
     - Set required_delivery_date = production_lot.created_date + lead_time_days
     - Set recommended_quantity = shortfall_quantity + (safety_stock_buffer)
     - Set procurement_status = 'RECOMMENDED'
- Output: List[recommendation_id]
- Side effects: Notify procurement team (webhook/email if configured)
- Error handling: Handle missing supplier_pricing gracefully (use default lead time)

Method 6: get_production_lot_alert_summary(production_lot_id)
- Purpose: Retrieve complete alert status for a production lot
- Input: production_lot_id (int)
- Database:
  - SELECT * FROM production_lot_inventory_alerts WHERE production_lot_id = production_lot_id
  - SELECT lot_status_inventory, alert_summary_json FROM production_lots WHERE lot_id = production_lot_id
- Output: Dict with:
  {
    "lot_id": int,
    "lot_status": str,
    "total_alerts": int,
    "alerts_by_severity": {"CRITICAL": int, "HIGH": int, "MEDIUM": int, "LOW": int, "OK": int},
    "acknowledged_count": int,
    "alerts": [list of alert records],
    "procurement_recommendations": [list of recommendations]
  }
- Error handling: Return empty if lot_id not found

Method 7: update_safety_stock_rules(item_variant_id, safety_stock_qty, reorder_point_qty, alert_threshold_pct, user_id)
- Purpose: Create or update safety stock configuration for a variant
- Input: item_variant_id (int), safety_stock_qty (int), reorder_point_qty (int), alert_threshold_pct (decimal), user_id (int)
- Database:
  - UPSERT into inventory_alert_rules (treat existing as update, new as insert)
  - Use ON CONFLICT syntax or INSERT/UPDATE logic
- Output: Updated rule record as Dict
- Validation:
  - safety_stock_qty > 0
  - reorder_point_qty > safety_stock_qty
  - alert_threshold_pct between 0-100
- Error handling: Raise ValidationError if constraints violated

Utilities:
- Use @transactional decorator for multi-step operations
- Implement connection pooling via database.get_conn()
- Add logging at each critical step (DEBUG for queries, INFO for business events)
- Cache safety_stock_rules (LRU with 1-hour TTL invalidation)

Location: /app/services/inventory_alert_service.py
Testing: Unit tests in /tests/test_inventory_alert_service.py (minimum 30 test cases)
Dependencies: database.py, models (data containers), validators, logging
```

### Step 2.2: Enhance ProductionLotService
**Copilot Prompt:**
```
Extend existing /app/services/production_lot_service.py with alert integration:

Method: create_production_lot_with_alerts(process_id, quantity, user_id, description)
- Purpose: Create production lot AND automatically check inventory, generate alerts, and handle procurement recommendations
- Input: process_id (int), quantity (int), user_id (int), description (str)
- Flow:
  1. Call existing create_production_lot method (to get production_lot_id, lot_structure)
  2. Instantiate InventoryAlertService
  3. Call check_inventory_levels_for_production_lot(production_lot_id)
  4. Call create_production_lot_alerts(production_lot_id, alerts_list)
  5. Separate alerts by severity:
     - CRITICAL/HIGH → Call generate_procurement_recommendations()
     - MEDIUM → Log as informational
  6. Call get_production_lot_alert_summary(production_lot_id) to get complete status
  7. If any CRITICAL alert:
     - Set production_lot.lot_status = 'PENDING_PROCUREMENT' (use new column)
     - Return response with flag: "requires_procurement": true, alerts_list, action_required
  8. Else if HIGH alert:
     - Set production_lot.lot_status = 'PARTIAL_FULFILLMENT_REQUIRED'
     - Return response with flag: "partial_fulfillment": true, alerts_list
  9. Else:
     - Set production_lot.lot_status = 'READY'
     - Return standard response with alerts_list (all OK)
- Output: Dict with:
  {
    "lot_id": int,
    "status": str,
    "alerts_present": bool,
    "alerts_summary": {...},
    "alerts_details": [...],
    "procurement_recommendations": [...],
    "action_required": bool,
    "action_type": "none" | "acknowledge_and_proceed" | "delay_production" | "select_alternatives"
  }
- Error handling:
  - If process_id invalid, raise ProcessNotFoundError before creating lot
  - If inventory check fails, rollback production lot creation (transaction safety)
  - Log all errors with context for debugging
- Backward Compatibility:
  - Existing create_production_lot() method remains unchanged
  - New method is create_production_lot_with_alerts() (additive, not breaking)

Method: acknowledge_and_validate_production_lot_alerts(production_lot_id, user_id, acknowledgments)
- Purpose: Bulk acknowledge multiple alerts with user decisions
- Input:
  production_lot_id (int)
  user_id (int)
  acknowledgments: List[Dict] with {alert_id, user_action, action_notes}
- Flow:
  1. Validate all alert_ids belong to production_lot_id
  2. For each acknowledgment:
     - Call InventoryAlertService.acknowledge_inventory_alert()
     - If user_action = 'SUBSTITUTE', verify substitute variant exists (from OR-groups)
     - If user_action = 'DELAY', flag lot for rescheduling (don't proceed)
  3. After all acknowledgments, recalculate lot_status_inventory
  4. If all CRITICAL acknowledged with PROCEED action, update lot_status to 'READY_WITH_PROCUREMENT_PENDING'
  5. If any DELAY action, update lot_status to 'ON_HOLD'
- Output: Updated lot status and alert summary
- Validation: Ensure user_id matches lot creator or has admin role

Method: get_production_lot_with_alerts(production_lot_id)
- Purpose: Retrieve complete production lot data including alert details
- Output: Extended lot record with nested alerts_summary and procurement_recommendations
- Replaces need for separate alert queries on frontend

Add to existing finalize_production_lot(production_lot_id, user_id):
- Before finalizing, verify no CRITICAL alerts remain unacknowledged (if they do, raise PendingAlertsException)
- Capture alert_summary_json in ledger entry for historical audit trail

Location: /app/services/production_lot_service.py
Update: Add import statements for InventoryAlertService
Backward Compatibility: All changes additive; no modifications to existing method signatures
Testing: Integration tests with scenario: lot_creation → alerts_generated → user_acknowledges → lot_ready (10+ scenarios)
```

### Step 2.3: Create ProductionLotValidator Enhancement
**Copilot Prompt:**
```
Extend /app/validators/production_lot_validator.py:

Add method: validate_production_lot_creation(process_id, quantity, user_id)
- Purpose: Pre-validation before lot creation
- Validations:
  1. process_id exists and is active (query processes table)
  2. quantity > 0 and < MAX_LOT_QUANTITY (config: 1000000)
  3. user_id exists and has permission to create lots
  4. Process status is 'active' or 'draft' (not 'archived')
  5. Process has at least 1 subprocess (validate process completeness)
- Output: List of validation errors (empty if all pass)
- Error messages: descriptive, e.g. "Process {id} has no subprocesses; cannot create lot"

Add method: validate_alert_acknowledgment(alert_id, user_action, action_notes)
- Purpose: Validate user response to alert
- Validations:
  1. alert_id exists in production_lot_inventory_alerts
  2. user_action is one of: PROCEED, DELAY, SUBSTITUTE, PARTIAL_FULFILL
  3. If SUBSTITUTE: verify substitute variant available and valid
  4. action_notes (if provided) is string < 500 chars
  5. Alert not already acknowledged (user_acknowledged = FALSE)
- Output: List of validation errors

Add method: validate_procurement_recommendation(recommendation_dict)
- Purpose: Validate procurement recommendation before inserting
- Validations:
  1. recommended_quantity > 0
  2. required_delivery_date is valid date and >= today
  3. item_variant_id exists and supplier_id valid
  4. estimated_cost (if provided) is positive decimal
- Output: List of validation errors

Location: /app/validators/production_lot_validator.py
Testing: Unit tests in /tests/test_production_lot_validator.py
```

---

## PHASE 3: BACKEND API ENDPOINTS

### Step 3.1: Create InventoryAlertAPI Blueprint
**Copilot Prompt:**
```
Create new file /app/api/inventory_alerts.py (Flask blueprint):

Blueprint name: 'inventory_alerts'
Base route: '/api/upf/inventory-alerts'

Endpoint 1: POST /api/upf/inventory-alerts/check-lot/<int:production_lot_id>
- Purpose: Trigger manual inventory check for a production lot
- Auth: Requires login
- Request: Empty body
- Response:
  {
    "status": "success",
    "lot_id": int,
    "alerts_generated": int,
    "alerts_by_severity": {CRITICAL, HIGH, MEDIUM, LOW, OK: counts},
    "alerts": [...]
  }
- Error responses:
  - 404 if lot not found
  - 400 if lot already finalized
  - 500 if inventory check fails
- Rate limit: 10 per hour per user

Endpoint 2: GET /api/upf/inventory-alerts/lot/<int:production_lot_id>
- Purpose: Retrieve all alerts for a production lot
- Auth: Requires login
- Response:
  {
    "lot_id": int,
    "lot_status_inventory": str,
    "total_alerts": int,
    "alerts_summary": {...},
    "alert_details": [{id, severity, variant, current_stock, required_qty, ...}],
    "procurement_recommendations": [...]
  }
- Pagination: alerts_details paginated (default 20 per page, max 100)
- Filters: ?severity=HIGH,CRITICAL or ?acknowledged=false
- Response: 404 if lot not found

Endpoint 3: POST /api/upf/inventory-alerts/<int:alert_id>/acknowledge
- Purpose: Acknowledge single alert with user decision
- Auth: Requires login
- Request body:
  {
    "user_action": "PROCEED" | "DELAY" | "SUBSTITUTE" | "PARTIAL_FULFILL",
    "action_notes": "optional string"
  }
- Response:
  {
    "status": "success",
    "alert_id": int,
    "acknowledged_at": timestamp,
    "updated_lot_status": str
  }
- Validation: Call ProductionLotValidator.validate_alert_acknowledgment()
- Error responses:
  - 400 if user_action invalid
  - 404 if alert not found
  - 409 if alert already acknowledged

Endpoint 4: POST /api/upf/inventory-alerts/lot/<int:production_lot_id>/acknowledge-bulk
- Purpose: Acknowledge multiple alerts at once
- Auth: Requires login
- Request body:
  {
    "acknowledgments": [
      {"alert_id": int, "user_action": str, "action_notes": optional str},
      ...
    ]
  }
- Response:
  {
    "status": "success",
    "acknowledged_count": int,
    "updated_lot_status": str,
    "alerts_summary": {...}
  }
- Validation: Validate all acknowledgments before processing any
- Error handling: Transactional (all or nothing)
- Rate limit: 5 per hour per lot

Endpoint 5: GET /api/upf/inventory-alerts/rules?item_variant_id=<id>
- Purpose: Retrieve safety stock rules for variants
- Auth: Requires login
- Response:
  {
    "rules": [
      {
        "item_variant_id": int,
        "variant_name": str,
        "safety_stock_quantity": int,
        "reorder_point_quantity": int,
        "alert_threshold_percentage": decimal
      },
      ...
    ]
  }
- Query params: Optional item_variant_id filter
- Pagination: 50 items per page

Endpoint 6: PUT /api/upf/inventory-alerts/rules/<int:item_variant_id>
- Purpose: Update/create safety stock rules for a variant
- Auth: Requires admin role
- Request body:
  {
    "safety_stock_quantity": int,
    "reorder_point_quantity": int,
    "alert_threshold_percentage": decimal
  }
- Response:
  {
    "status": "success",
    "rule": {...}
  }
- Validation: Call ProductionLotValidator.validate_alert_acknowledgment()
- Error responses:
  - 400 if validation fails
  - 403 if not admin

Endpoint 7: GET /api/upf/inventory-alerts/procurement-recommendations
- Purpose: List all active procurement recommendations across lots
- Auth: Requires login (admin sees all; non-admin see own lots)
- Query params: ?status=RECOMMENDED,ORDERED or ?created_after=2025-01-01
- Response:
  {
    "recommendations": [
      {
        "recommendation_id": int,
        "production_lot_id": int,
        "variant_name": str,
        "supplier_name": str,
        "recommended_quantity": int,
        "required_delivery_date": date,
        "estimated_cost": decimal,
        "procurement_status": str
      },
      ...
    ],
    "total_cost": decimal,
    "count_by_status": {...}
  }
- Pagination: 20 items per page

Error handling (all endpoints):
- Catch all exceptions, log with request ID
- Return standardized APIResponse format (use existing utils)
- Never expose DB errors to client; use generic 500 messages internally logged

Location: /app/api/inventory_alerts.py
Register blueprint: In app/__init__.py, add:
  from app.api.inventory_alerts import inventory_alerts_bp
  app.register_blueprint(inventory_alerts_bp, url_prefix='/api/upf')

CORS: Allow same-origin requests (production_lots frontend will call these)
Rate Limiting: Use existing @limiter decorator from config
Testing: API tests in /tests/test_inventory_alerts_api.py (20+ endpoint tests)
```

### Step 3.2: Enhance ProductionLotAPI Blueprint
**Copilot Prompt:**
```
Update existing /app/api/production_lot.py:

Modify endpoint: POST /api/upf/production-lots
- OLD behavior: Create lot, return standard response
- NEW behavior:
  1. Extract request body: {process_id, quantity, user_id, description}
  2. Call ProductionLotValidator.validate_production_lot_creation()
  3. If validation errors, return 400 response (unchanged)
  4. Call NEW ProductionLotService.create_production_lot_with_alerts() instead of create_production_lot()
  5. Response now includes alert information:
     {
       "status": "success",
       "lot_id": int,
       "lot_status": str,  // NEW: may be PENDING_PROCUREMENT, PARTIAL_FULFILLMENT_REQUIRED, READY
       "alerts_present": bool,
       "alerts_summary": {
         "total": int,
         "by_severity": {CRITICAL, HIGH, MEDIUM, LOW, OK: counts},
         "action_required": bool,
         "action_description": str
       },
       "alerts_details": [...],  // First 5 alerts, user can paginate
       "procurement_recommendations": [...],
       "next_step": "proceed_to_review" | "acknowledge_alerts" | "contact_procurement"
     }
  6. If action_required=true, frontend should present alert review before allowing production
- Backward Compatibility:
  - Response still includes all original fields (lot_id, quantity, process_id, etc.)
  - New fields are additive, don't break existing clients
  - If alerts empty, behaves as before with alerts_present=false

Modify endpoint: GET /api/upf/production-lots/<int:lot_id>
- OLD behavior: Return lot details
- NEW behavior:
  1. Call ProductionLotService.get_production_lot_with_alerts(lot_id)
  2. Response includes nested alert_summary and procurement_recommendations (from new tables)
  3. Response structure:
     {
       ...existing fields...,
       "alerts_summary": {
         "total_alerts": int,
         "by_severity": {...},
         "acknowledged_count": int,
         "pending_actions": [...]
       },
       "procurement_recommendations": [
         {"recommendation_id": int, "variant": str, "qty": int, "status": str, ...}
       ]
     }
- Query optimization: Use batch query to fetch lot + alerts + recommendations in 2-3 queries (not N+1)

Modify endpoint: PUT /api/upf/production-lots/<int:lot_id>/finalize
- OLD behavior: Finalize lot (lock for editing)
- NEW behavior:
  1. Check if lot has CRITICAL alerts that are NOT acknowledged with PROCEED action
  2. If yes: return 409 Conflict response: {"status": "error", "message": "Critical inventory alerts pending. Please acknowledge before finalizing."}
  3. Else: proceed with finalization (unchanged)
  4. Store alert_summary_json in ledger entry (audit trail)

Add endpoint: POST /api/upf/production-lots/<int:lot_id>/validate-inventory
- Purpose: Manual trigger for inventory validation (user can re-check after procurement)
- Auth: Requires login
- Request body: {} (empty)
- Response:
  {
    "lot_id": int,
    "validation_timestamp": ISO timestamp,
    "alerts_updated": bool,
    "new_alerts_count": int,
    "alerts_cleared_count": int,
    "current_status": str
  }
- Use case: User may want to manually re-check after receiving partial shipment

Add endpoint: POST /api/upf/production-lots/<int:lot_id>/acknowledge-all-alerts
- Purpose: Acknowledge all alerts for a lot with single action
- Auth: Requires login
- Request body:
  {
    "global_action": "PROCEED_ALL" | "DELAY_ALL",
    "notes": "optional"
  }
- Logic:
  1. Query all unacknowledged alerts for lot
  2. For each: acknowledge with action PROCEED or DELAY (based on global_action)
  3. Update lot_status based on final alert state
- Response: Updated lot with alerts_summary

All existing endpoints: Maintain 100% backward compatibility
- Existing response fields unchanged
- New fields are optional/additive
- No breaking changes to request/response structure

Location: /app/api/production_lot.py (file already exists, modifications only)
Update imports: Add InventoryAlertService import
Testing: Regression tests ensuring all old endpoints work + new alert scenarios (20+ tests)
```

---

## PHASE 4: FRONTEND TEMPLATES & UI/UX

### Step 4.1: Update Production Lot Creation Template
**Copilot Prompt:**
```
Update /templates/upf_production_lots.html:

Step 1: Add Alert Display Section (NEW)
HTML structure:
  <div id="alert-panel" class="alert-panel hidden">
    <div class="alert-header">
      <h3>Inventory Alerts</h3>
      <button id="dismiss-alerts" class="btn-secondary">Dismiss</button>
    </div>
    <div class="alerts-summary">
      <div class="summary-stat critical"><span class="count">0</span> Critical</div>
      <div class="summary-stat high"><span class="count">0</span> High</div>
      <div class="summary-stat medium"><span class="count">0</span> Medium</div>
      <div class="summary-stat low"><span class="count">0</span> Low</div>
    </div>
    <div id="alerts-list" class="alerts-list">
      <!-- Populated dynamically by JS -->
    </div>
    <div class="alert-actions">
      <button id="proceed-anyway" class="btn-primary">Acknowledge & Proceed</button>
      <button id="delay-production" class="btn-secondary">Delay Production</button>
      <button id="contact-procurement" class="btn-warning">Contact Procurement</button>
    </div>
  </div>

Step 2: Update Production Lot Form
- Add hidden div after lot creation: <div id="production-lot-result" class="hidden"></div>
- Modify form submit handler to:
  1. Show loading spinner
  2. POST to /api/upf/production-lots with form data
  3. If response.alerts_present = true:
     - Show alert-panel (unhide)
     - Populate alerts-list with each alert UI
     - Disable form submission until alerts acknowledged
  4. If response.alerts_present = false:
     - Show success message
     - Auto-redirect to lot details page after 2 seconds
  5. If response has CRITICAL alerts:
     - Set button text for "Acknowledge & Proceed" to "Acknowledge & Proceed (With Procurement)"
     - Add warning banner: "Critical inventory shortage. Production may be delayed pending procurement."

Step 3: Alert Display Template (each alert item)
HTML for single alert item (template):
  <div class="alert-item alert-severity-{severity}" data-alert-id="{alert_id}">
    <div class="alert-header">
      <span class="severity-badge {severity}">{severity}</span>
      <span class="variant-name">{variant_name}</span>
      <span class="supplier-badge">{supplier_name}</span>
    </div>
    <div class="alert-body">
      <div class="stock-info">
        <div class="info-row">
          <span class="label">Current Stock:</span>
          <span class="value">{current_stock} units</span>
        </div>
        <div class="info-row">
          <span class="label">Required:</span>
          <span class="value">{required_quantity} units</span>
        </div>
        <div class="info-row alert-shortfall">
          <span class="label">Shortfall:</span>
          <span class="value">{shortfall_quantity} units</span>
        </div>
      </div>
      <div class="supplier-info">
        <span class="label">Supplier:</span>
        <span class="value">{supplier_name} (Lead time: {lead_time_days} days)</span>
      </div>
      {if suggested_procurement_qty}
      <div class="procurement-suggestion">
        <span class="label">Suggested Procurement:</span>
        <span class="value">{suggested_procurement_qty} units</span>
      </div>
      {/if}
    </div>
    <div class="alert-actions-item">
      <select id="action-select-{alert_id}" class="action-select" data-alert-id="{alert_id}">
        <option value="">-- Select Action --</option>
        <option value="PROCEED">Proceed (Accept shortage)</option>
        <option value="DELAY">Delay Production (Wait for procurement)</option>
        {if substitute_available}<option value="SUBSTITUTE">Use Alternative (Substitute)</option>{/if}
        {if partial_fulfill}<option value="PARTIAL_FULFILL">Partial Fulfillment (Use available)</option>{/if}
      </select>
      <textarea id="notes-{alert_id}" class="alert-notes" placeholder="Optional notes..."></textarea>
    </div>
  </div>

Step 4: Add CSS Styles (new file or append to existing)
File: /static/css/inventory_alerts.css
Content:
  .alert-panel {
    border: 2px solid #ffa500;
    border-radius: 8px;
    padding: 20px;
    margin: 20px 0;
    background-color: #fff8f0;
    box-shadow: 0 4px 6px rgba(255, 165, 0, 0.1);
  }
  .alert-panel.hidden { display: none; }
  .alert-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
  .alerts-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; margin-bottom: 20px; }
  .summary-stat { padding: 10px; border-radius: 4px; text-align: center; font-weight: bold; }
  .summary-stat.critical { background-color: #ffcccc; color: #cc0000; }
  .summary-stat.high { background-color: #ffe6cc; color: #ff6600; }
  .summary-stat.medium { background-color: #fffacc; color: #ffaa00; }
  .summary-stat.low { background-color: #e6f3ff; color: #0066cc; }
  
  .alerts-list { max-height: 400px; overflow-y: auto; margin-bottom: 20px; }
  .alert-item { border: 1px solid #ddd; border-radius: 4px; padding: 12px; margin-bottom: 12px; }
  .alert-item.alert-severity-CRITICAL { border-left: 4px solid #cc0000; background-color: #ffe6e6; }
  .alert-item.alert-severity-HIGH { border-left: 4px solid #ff6600; background-color: #fff0e6; }
  .alert-item.alert-severity-MEDIUM { border-left: 4px solid #ffaa00; background-color: #fffae6; }
  .alert-item.alert-severity-LOW { border-left: 4px solid #0066cc; background-color: #e6f3ff; }
  
  .severity-badge { display: inline-block; padding: 4px 8px; border-radius: 3px; font-size: 12px; font-weight: bold; margin-right: 10px; }
  .severity-badge.CRITICAL { background-color: #cc0000; color: white; }
  .severity-badge.HIGH { background-color: #ff6600; color: white; }
  .severity-badge.MEDIUM { background-color: #ffaa00; color: white; }
  .severity-badge.LOW { background-color: #0066cc; color: white; }
  
  .info-row { display: flex; justify-content: space-between; padding: 6px 0; }
  .info-row.alert-shortfall { color: #cc0000; font-weight: bold; }
  .action-select, .alert-notes { width: 100%; padding: 8px; margin: 8px 0; border: 1px solid #ccc; border-radius: 4px; }
  .alert-actions { display: flex; gap: 10px; margin-top: 20px; }
  .btn-primary, .btn-secondary, .btn-warning { padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; }
  .btn-primary { background-color: #0066cc; color: white; }
  .btn-secondary { background-color: #ccc; color: #333; }
  .btn-warning { background-color: #ffaa00; color: white; }

Step 5: Link CSS in template
Add to <head>:
  <link rel="stylesheet" href="{{ url_for('static', filename='css/inventory_alerts.css') }}">
```

### Step 4.2: Create JavaScript Alert Handler
**Copilot Prompt:**
```
Create new file /static/js/production_lot_alerts.js:

Object: ProductionLotAlertHandler

Properties:
  - production_lot_id: int or null
  - alerts_list: Array of alert objects
  - pending_acknowledgments: Object (alert_id → action mapping)
  - csrf_token: string (from meta tag)

Method: init()
- Purpose: Initialize event listeners on page load
- Actions:
  1. Extract csrf_token from <meta name="csrf-token">
  2. Attach click listeners to #proceed-anyway, #delay-production, #contact-procurement
  3. Attach change listeners to all .action-select dropdowns
  4. Store reference to alert-panel, alerts-list, summary-stat elements

Method: displayAlerts(alerts_array)
- Purpose: Render alerts from API response
- Input: alerts_array from /api/upf/production-lots response.alerts_details
- Logic:
  1. Clear #alerts-list
  2. For each alert in alerts_array:
     - Create alert-item HTML (clone template)
     - Set severity class
     - Populate all fields (variant_name, current_stock, required_qty, etc.)
     - Generate action dropdown (check if SUBSTITUTE available)
     - Append to #alerts-list
  3. Update .summary-stat counts for each severity
  4. Show alert-panel (remove hidden class)
  5. Scroll to alert-panel (smooth scroll)

Method: handleActionSelect(alert_id, user_action)
- Purpose: Record user selection on dropdown change
- Input: alert_id (int), user_action (string from dropdown value)
- Logic:
  1. Store in pending_acknowledgments[alert_id] = user_action
  2. Enable/disable action buttons based on completeness:
     - If all alerts have selected actions → Enable "Acknowledge & Proceed"
     - Else → Disable button, show tooltip "Select action for all alerts"
  3. Highlight selected row with subtle background change

Method: handleProceedAnyway()
- Purpose: User acknowledges all alerts and proceeds to production
- Logic:
  1. Validate all alerts have selected actions
  2. If not: show toast error "Please select action for all alerts"
  3. Collect acknowledgments:
     {
       "acknowledgments": [
         {"alert_id": id, "user_action": action, "action_notes": notes_from_textarea},
         ...
       ]
     }
  4. POST to /api/upf/inventory-alerts/lot/{lot_id}/acknowledge-bulk
  5. On success response:
     - Show toast "Alerts acknowledged. Production ready."
     - Update lot_status display
     - Auto-redirect to lot details page after 2 seconds
  6. On error (409 Conflict - pending CRITICAL):
     - Show alert dialog "Critical alerts require procurement. Contact procurement team."
     - Disable proceed button
     - Enable "Contact Procurement" button

Method: handleDelayProduction()
- Purpose: User delays production lot
- Logic:
  1. Show confirmation dialog: "Delay production? This lot will be put on hold."
  2. If confirmed:
     - Collect all acknowledgments with action = "DELAY"
     - POST to /api/upf/inventory-alerts/lot/{lot_id}/acknowledge-bulk
  3. On success:
     - Show message "Production delayed. You can resume later."
     - Disable all action buttons
     - Show "Resume Production" button
  4. Update lot status to "ON_HOLD" in UI

Method: handleContactProcurement()
- Purpose: User requests procurement intervention
- Logic:
  1. Show modal with:
     - Summary of critical/high alerts
     - Pre-populated email to procurement team
     - Recommended procurement quantities (from response.procurement_recommendations)
  2. Allow user to edit message and send
  3. Call backend endpoint to send notification (existing or new)
  4. Show confirmation "Procurement team notified. They will prioritize this order."
  5. Disable button after sending (until production delayed)

Method: fetchProductionLotAlerts(lot_id)
- Purpose: Retrieve alerts for a specific lot (used in lot details page)
- Input: lot_id (int)
- Fetch: GET /api/upf/inventory-alerts/lot/{lot_id}
- On success:
  - Update alerts_list
  - Call displayAlerts(response.alert_details)
  - Show procurement recommendations (if any) in separate section
- On 404: Show "Production lot not found"
- On 500: Show "Error retrieving alerts. Please refresh."

Method: updateSafetyStockRule(item_variant_id, safety_qty, reorder_qty, threshold_pct)
- Purpose: Send safety stock configuration to backend (admin feature)
- Input: configuration values
- PUT to /api/upf/inventory-alerts/rules/{item_variant_id}
- On success: Show toast "Safety stock rule updated"
- On error: Show "Failed to update rule. " + error message

Utilities:
  - getCookie(name): Extract CSRF token or session cookie
  - showToast(message, type='info'): Display temporary notification (top of page)
  - showModal(title, content, actions): Display confirmation/alert dialog
  - smoothScroll(elementId): Scroll to element smoothly

Initialization:
  - Call init() on document.DOMContentLoaded
  - Attach to window.ProductionLotAlertHandler (global reference)

Error Handling:
  - Network errors: Show retry toast with option to retry
  - Validation errors (400): Show detailed error message from API
  - Auth errors (401): Redirect to login
  - Permission errors (403): Show "You don't have permission to acknowledge these alerts"

Location: /static/js/production_lot_alerts.js
Dependencies: None (vanilla JS, no jQuery required)
Testing: Unit tests using Jest/Mocha in /tests/test_production_lot_alerts.js
```

### Step 4.3: Create Procurement Recommendations Panel
**Copilot Prompt:**
```
Update /templates/upf_production_lots.html:

Add new section: Procurement Recommendations Panel

HTML structure:
  <div id="procurement-panel" class="procurement-panel hidden">
    <div class="panel-header">
      <h3>Procurement Recommendations</h3>
      <button id="export-recommendations" class="btn-secondary">Export to CSV</button>
    </div>
    <table class="recommendations-table">
      <thead>
        <tr>
          <th>Variant</th>
          <th>Supplier</th>
          <th>Recommended Qty</th>
          <th>Delivery Date</th>
          <th>Est. Cost</th>
          <th>Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody id="recommendations-tbody">
        <!-- Populated dynamically -->
      </tbody>
    </table>
  </div>

CSS:
  .procurement-panel {
    border: 1px solid #0066cc;
    border-radius: 8px;
    padding: 20px;
    margin: 20px 0;
    background-color: #f0f5ff;
  }
  .procurement-panel.hidden { display: none; }
  .recommendations-table { width: 100%; border-collapse: collapse; }
  .recommendations-table th { background-color: #0066cc; color: white; padding: 10px; text-align: left; }
  .recommendations-table td { padding: 10px; border-bottom: 1px solid #ddd; }
  .recommendations-table tr:hover { background-color: #f9f9f9; }
  .status-badge { padding: 4px 8px; border-radius: 3px; font-weight: bold; }
  .status-badge.RECOMMENDED { background-color: #fff3cd; color: #856404; }
  .status-badge.ORDERED { background-color: #d1ecf1; color: #0c5460; }
  .status-badge.RECEIVED { background-color: #d4edda; color: #155724; }

JS integration (in production_lot_alerts.js):
  Method: displayProcurementRecommendations(recommendations_array)
  - For each recommendation:
    - Create table row
    - Populate: variant name, supplier, qty, delivery date, cost, status
    - Add action button: "View Details" or "Create PO" (if status = RECOMMENDED)
  - Show procurement-panel (unhide)
  - Calculate total procurement cost (sum of all est_cost)
  - Display total at bottom of table

Location: /templates/upf_production_lots.html (append section)
Also update: /static/js/production_lot_alerts.js (add displayProcurementRecommendations method)
```

### Step 4.4: Update Production Lot Details Page
**Copilot Prompt:**
```
Update /templates/upf_lot_details.html (or equivalent):

Add new Alert Summary Section (top of page):
HTML:
  <div id="lot-alert-summary" class="alert-summary-card">
    <h3>Inventory Alert Summary</h3>
    <div class="summary-grid">
      <div class="summary-item critical">
        <span class="count" id="critical-count">0</span>
        <span class="label">Critical</span>
      </div>
      <div class="summary-item high">
        <span class="count" id="high-count">0</span>
        <span class="label">High</span>
      </div>
      <div class="summary-item medium">
        <span class="count" id="medium-count">0</span>
        <span class="label">Medium</span>
      </div>
      <div class="summary-item low">
        <span class="count" id="low-count">0</span>
        <span class="label">Low</span>
      </div>
      <div class="summary-item ok">
        <span class="count" id="ok-count">0</span>
        <span class="label">OK</span>
      </div>
    </div>
    <div class="summary-actions">
      <button id="refresh-alerts" class="btn-secondary">Refresh Inventory Check</button>
      <button id="view-all-alerts" class="btn-primary">View All Alerts</button>
    </div>
  </div>

Add new Alerts Detail Section (collapsible):
HTML:
  <div id="alerts-detail-section" class="section collapsible closed">
    <div class="section-header">
      <h3>Inventory Alerts ({total_count})</h3>
      <button class="toggle-btn">▼</button>
    </div>
    <div id="alerts-detail-list" class="section-content hidden">
      <!-- Populated by JS -->
    </div>
  </div>

CSS:
  .alert-summary-card { background-color: #f9f9f9; border: 1px solid #ddd; border-radius: 8px; padding: 20px; margin-bottom: 20px; }
  .summary-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin: 15px 0; }
  .summary-item { text-align: center; padding: 15px; border-radius: 4px; }
  .summary-item.critical { background-color: #ffcccc; }
  .summary-item.high { background-color: #ffe6cc; }
  .summary-item.medium { background-color: #fffacc; }
  .summary-item.low { background-color: #e6f3ff; }
  .summary-item.ok { background-color: #e6ffe6; }
  .summary-item .count { display: block; font-size: 24px; font-weight: bold; }
  .summary-item .label { display: block; font-size: 12px; margin-top: 5px; }

JS (add to production_lot_alerts.js):
  Method: initLotDetailsAlerts(lot_id)
  - On page load:
    1. Call fetchProductionLotAlerts(lot_id)
    2. Display alert summary
    3. Attach click listener to #view-all-alerts (expand details)
    4. Attach click listener to #refresh-alerts (manually re-check inventory)
  - Refresh button calls POST /api/upf/production-lots/{lot_id}/validate-inventory
    - Shows loading spinner while waiting
    - Updates alert counts on success

Location: /templates/ (update existing lot details template)
Also: Ensure production_lot_alerts.js is loaded on this page
```

---

## PHASE 5: DATABASE MIGRATION EXECUTION

### Step 5.1: Execute Migration
**Copilot Prompt:**
```
Create migration execution script /scripts/execute_alert_migration.py:

Purpose: Safely execute the inventory alert system migration with rollback capability

Steps:
1. Pre-migration validation:
   - Verify database connectivity
   - Check existing table structure (confirm production_lots exists)
   - Create backup snapshot with timestamp
   - Verify all FK constraints from existing schema

2. Execute up() migration:
   - Run migration_add_inventory_alert_system.py up()
   - Log each DDL statement executed
   - Verify all tables created successfully
   - Verify all indexes created and accessible
   - Test trigger function compilation

3. Post-migration validation:
   - Query information_schema to verify all tables
   - Verify all constraints in place
   - Test sample INSERT into each new table
   - Verify FK constraints work (cascade delete test)
   - Performance test: SELECT on large tables

4. Rollback capability:
   - If any step fails: call down() migration
   - Restore from backup if down() fails
   - Log detailed error with context

5. Generate migration report:
   - Total execution time
   - Tables created/modified
   - Indexes added
   - Triggers created
   - Any warnings or non-critical issues

Execution:
  python scripts/execute_alert_migration.py --environment=production --backup=true

Location: /scripts/execute_alert_migration.py
Testing: Run against development database first, verify no data loss, then production
```

---

## PHASE 6: SERVICE LAYER INTEGRATION & TESTING

### Step 6.1: Create Comprehensive Test Suite
**Copilot Prompt:**
```
Create test file /tests/test_inventory_alert_integration.py:

Test Class 1: TestInventoryAlertService
- test_check_inventory_levels_ok_stock()
  - Setup: Create production lot with variants in stock
  - Expected: All alerts = OK
- test_check_inventory_levels_critical_alert()
  - Setup: Variant with 0 stock, required qty > 0
  - Expected: CRITICAL alert generated
- test_check_inventory_levels_high_alert()
  - Setup: Variant with stock < required
  - Expected: HIGH alert with correct shortfall
- test_check_inventory_levels_medium_alert()
  - Setup: Stock adequate but below safety threshold
  - Expected: MEDIUM alert with reorder recommendation
- test_acknowledge_inventory_alert_proceed()
  - Setup: Create alert, acknowledge with PROCEED
  - Expected: Alert.user_acknowledged = TRUE, lot_status updated
- test_acknowledge_inventory_alert_delay()
  - Setup: Create alert, acknowledge with DELAY
  - Expected: production_lot.lot_status = ON_HOLD
- test_generate_procurement_recommendations()
  - Setup: HIGH alert with supplier pricing
  - Expected: Recommendation created with correct qty and delivery date
- test_get_production_lot_alert_summary()
  - Setup: Multiple alerts, some acknowledged
  - Expected: Summary includes counts and audit trail

Test Class 2: TestProductionLotServiceWithAlerts
- test_create_production_lot_with_alerts_all_ok()
  - Setup: Product with all variants in stock
  - Expected: lot_status = READY, alerts_present = false
- test_create_production_lot_with_alerts_critical()
  - Setup: Product with 1 critical alert
  - Expected: lot_status = PENDING_PROCUREMENT, action_required = true
- test_create_production_lot_with_alerts_high()
  - Setup: Product with HIGH alert only
  - Expected: lot_status = PARTIAL_FULFILLMENT_REQUIRED
- test_finalize_lot_with_pending_critical_alerts()
  - Setup: Try to finalize lot with unacknowledged CRITICAL alerts
  - Expected: 409 Conflict error
- test_finalize_lot_with_acknowledged_alerts()
  - Setup: CRITICAL alert acknowledged with PROCEED
  - Expected: Lot finalizes successfully, alert_summary captured
- test_acknowledge_and_validate_production_lot_alerts_bulk()
  - Setup: 5 alerts with mixed actions
  - Expected: All acknowledged, lot_status recalculated

Test Class 3: TestInventoryAlertsAPI
- test_post_check_lot_inventory()
  - Request: POST /api/upf/inventory-alerts/check-lot/{lot_id}
  - Expected: 200 response with alerts_generated count
- test_get_lot_alerts_by_severity_filter()
  - Request: GET /api/upf/inventory-alerts/lot/{lot_id}?severity=CRITICAL,HIGH
  - Expected: 200 with only filtered alerts
- test_post_acknowledge_alert()
  - Request: POST /api/upf/inventory-alerts/{alert_id}/acknowledge
  - Expected: 200, alert.user_acknowledged = TRUE
- test_post_acknowledge_alert_invalid_action()
  - Request: POST /api/upf/inventory-alerts/{alert_id}/acknowledge with invalid action
  - Expected: 400 validation error
- test_post_acknowledge_bulk_alerts()
  - Request: POST /api/upf/inventory-alerts/lot/{lot_id}/acknowledge-bulk
  - Expected: 200, all alerts acknowledged
- test_get_safety_stock_rules()
  - Request: GET /api/upf/inventory-alerts/rules
  - Expected: 200 with rules list
- test_put_update_safety_stock_rule()
  - Request: PUT /api/upf/inventory-alerts/rules/{variant_id}
  - Expected: 200, rule created/updated
- test_auth_required_for_alerts()
  - Request: GET /api/upf/inventory-alerts/lot/{lot_id} without auth
  - Expected: 401 Unauthorized

Test Class 4: TestBackwardCompatibility
- test_existing_production_lot_creation_still_works()
  - Call old endpoint /api/upf/production-lots with old request format
  - Expected: 200 response with new alert fields (additive, not breaking)
- test_existing_process_retrieval_unchanged()
  - Call GET /api/upf/processes/{id}
  - Expected: Same response as before, no regressions
- test_existing_subprocess_crud_unchanged()
  - CRUD operations on subprocesses
  - Expected: No functional changes
- test_no_alerts_for_processes_without_lots()
  - Query processes directly
  - Expected: No alert data (alerts only on production lots)

Test Class 5: TestDataIntegrity
- test_fk_constraint_production_lot_id()
  - Try to insert alert with invalid lot_id
  - Expected: FK constraint violation
- test_cascade_delete_alerts_on_lot_delete()
  - Delete production lot
  - Expected: All related alerts deleted
- test_alert_summary_json_validity()
  - Create lot with alerts
  - Expected: alert_summary_json is valid JSON
- test_trigger_updates_lot_status()
  - Create multiple alerts
  - Expected: Trigger recalculates lot_status_inventory correctly
- test_deduplication_no_duplicate_alerts()
  - Run inventory check twice
  - Expected: No duplicate alerts (or old ones updated)

Test Class 6: TestPerformance
- test_inventory_check_performance_1000_variants()
  - Setup: Process with 1000 variants
  - Run check_inventory_levels_for_production_lot()
  - Expected: Completes in < 2 seconds
- test_alert_retrieval_pagination()
  - Setup: Production lot with 1000 alerts
  - Fetch alerts with pagination (20 items/page)
  - Expected: Correct page returned, < 500ms per page

Setup/Teardown:
- Use fixtures for:
  - Test user
  - Test inventory items with variants
  - Test products/processes
  - Test suppliers
- Cleanup: Delete all test data after each test

Coverage:
  - Target: >= 90% code coverage for new services
  - Run: pytest --cov=app.services.inventory_alert_service tests/test_inventory_alert_integration.py

Location: /tests/test_inventory_alert_integration.py
Run: pytest tests/test_inventory_alert_integration.py -v
```

### Step 6.2: Regression Testing
**Copilot Prompt:**
```
Create regression test suite /tests/test_regression_alert_integration.py:

Purpose: Verify no existing functionality broken by alert system integration

Test Scenarios:
1. Full Process Creation to Production Lot Flow (Original + New):
   - Create process with subprocesses
   - Add variants to subprocesses
   - Set costs, margins, taxes
   - Create production lot
   - Expected: All steps work, no errors
   - Verify: Process data unchanged, costs calculated correctly

2. Variant and Cost Manipulation:
   - Create process, add variant with cost override
   - Modify variant cost multiple times
   - Verify costing recalculates correctly
   - Expected: No interference from alert system

3. OR-Group Alternative Selection:
   - Create process with OR-group
   - Select alternatives at production lot time
   - Expected: Alternatives work as before

4. Subprocess Template Reuse:
   - Create subprocess template
   - Use in multiple processes
   - Edit template
   - Expected: Changes propagate correctly, alerts don't interfere

5. Multi-User Concurrent Operations:
   - User A creates production lot
   - User B creates production lot simultaneously (different product)
   - Expected: Both succeed with isolated alerts, no race conditions

6. Audit Trail and Logging:
   - Perform various operations
   - Check application logs
   - Expected: No new errors, logs include alert operations

7. User Role and Permissions:
   - Admin creates/updates safety stock rules
   - Non-admin attempts same (should fail)
   - Expected: Role-based access control works

8. Data Export and Import:
   - Export process with variants to CSV/JSON
   - Import into new database
   - Expected: All data preserved, no alert-related issues

9. Dashboard and Reporting:
   - View production lot dashboard
   - Expected: All metrics display correctly, no UI errors

10. Session and Authentication:
    - Create production lot in one session
    - Switch users
    - Expected: Users see only their own lots/alerts

Test Format:
- For each scenario: Setup → Action → Verify → Cleanup
- Use transactions to rollback test data
- Log detailed error messages if verification fails
- Take screenshot on UI test failures (if using Selenium)

Expected Outcome:
- All tests pass
- No regression warnings
- Performance metrics stable
- No memory leaks

Location: /tests/test_regression_alert_integration.py
Run: pytest tests/test_regression_alert_integration.py -v
Report: Generate regression_test_report.html with pass/fail summary
```

---

## PHASE 7: FRONTEND INTEGRATION & TESTING

### Step 7.1: Update JavaScript Integration
**Copilot Prompt:**
```
Update /static/js/process_editor.js and related files:

1. Ensure production_lot_alerts.js loaded before dependent scripts
   - Add to base.html: <script src="{{ url_for('static', filename='js/production_lot_alerts.js') }}"></script> (before process_editor.js)

2. Update process_editor.js:
   - After process structure loaded:
     - Fetch safety stock rules (GET /api/upf/inventory-alerts/rules)
     - Display rule indicators for each variant (show reorder point on variant info)
   - Add visual indicator if variant approaching reorder point: orange badge "Low Stock"

3. Update production lot creation flow:
   - Form submit → Check alerts → Show alert panel or proceed
   - Integration with existing ProductionLotAlertHandler

4. Update variant_search.js:
   - When displaying variant in search results: include current_stock and status indicator
   - Add color coding: Red if out of stock, Orange if low, Green if adequate

Location: /static/js/ (multiple files)
Testing: Use Jest/Mocha for unit tests
```

### Step 7.2: Template Updates for Alert Display
**Copilot Prompt:**
```
Update all production lot related templates:

1. /templates/upf_production_lots.html:
   - Add alert panel (see Step 4.1)
   - Link CSS and JS files
   - Add placeholders for dynamic content

2. /templates/upf_lot_details.html:
   - Add alert summary card (see Step 4.4)
   - Add alert detail section
   - Add procurement recommendations panel

3. /templates/base.html:
   - Ensure CSRF token in meta tag: <meta name="csrf-token" content="{{ csrf_token() }}">
   - Add script imports for alert JS

Location: /templates/
Verification: Render templates, check all elements present and accessible
```

### Step 7.3: Frontend Unit Tests
**Copilot Prompt:**
```
Create frontend test file /tests/test_production_lot_alerts_frontend.js:

Using Jest/Mocha framework:

Test 1: Alert Display
- Mock API response with alerts
- Call displayAlerts()
- Expected: DOM updated with alert items

Test 2: Action Selection
- Select action from dropdown
- Expected: pending_acknowledgments updated, button enabled

Test 3: Proceed Button Click
- Select action for all alerts
- Click proceed-anyway
- Expected: POST request sent with acknowledgments

Test 4: Error Handling
- Mock API error response (500)
- Expected: Error message displayed

Test 5: Alert Summary Counts
- Mock alerts with mixed severities
- Expected: Summary counts updated correctly

Test 6: CSS Classes Applied
- Check alert item has correct severity class
- Expected: Correct styling applied

Location: /tests/test_production_lot_alerts_frontend.js
Run: npm test
```

---

## PHASE 8: DEPLOYMENT & VERIFICATION

### Step 8.1: Pre-Deployment Checklist
**Copilot Prompt:**
```
Create /scripts/pre_deployment_checklist.py:

Checklist items:
1. Database
   ☐ Migration tested in staging environment
   ☐ Backup created
   ☐ Schema verified
   ☐ Indexes created and performant
   ☐ FK constraints validated

2. Backend Services
   ☐ All new services unit tested (90%+ coverage)
   ☐ API endpoints tested
   ☐ Error handling verified
   ☐ Rate limiting configured
   ☐ Logging statements in place

3. Frontend
   ☐ Templates render without errors
   ☐ JavaScript files loaded correctly
   ☐ CSS styles applied
   ☐ No console errors
   ☐ Responsive on mobile/tablet

4. Integration
   ☐ End-to-end flow tested
   ☐ Backward compatibility verified
   ☐ No regressions detected
   ☐ Performance acceptable
   ☐ Memory/CPU usage normal

5. Documentation
   ☐ README updated with new features
   ☐ API documentation generated
   ☐ Database schema documented
   ☐ Deployment notes written

6. Rollback Plan
   ☐ Rollback script tested
   ☐ Data recovery procedure documented
   ☐ Communication plan ready

Output: Generate pre_deployment_report.txt with all checks PASSED/FAILED
If any FAILED: Print action items and block deployment
```

### Step 8.2: Staged Deployment
**Copilot Prompt:**
```
Create deployment strategy /scripts/staged_deployment.md:

Stage 1: Development Environment (Immediate)
- Deploy schema changes
- Deploy services
- Deploy API endpoints
- Run full test suite
- Expected timeline: 1 day

Stage 2: Staging Environment (After Stage 1 passes)
- Deploy to staging
- Run end-to-end tests
- Load testing with realistic data volume
- Security audit
- User acceptance testing
- Expected timeline: 2-3 days

Stage 3: Production Environment (After Stage 2 passes)
- Schedule maintenance window (optional, system can be live during deployment)
- Database migration (with read-only safety measures)
- Deploy backend code
- Deploy frontend code
- Monitoring and validation
- Expected timeline: 2-4 hours

Rollback Plan:
- If any stage fails: Execute down() migration and restore from backup
- Deployment can be halted at any stage with no data loss

Monitoring during deployment:
- Watch error logs for new exception types
- Monitor database query performance
- Check API response times
- Verify alert generation working
- Test user workflows manually

Post-deployment verification (24 hours):
- Check system health
- Review alert generation (test with low inventory scenario)
- Verify user feedback
- Check logs for issues
- Enable full feature set if all green
```

---

## PHASE 9: DOCUMENTATION & KNOWLEDGE TRANSFER

### Step 9.1: Generate API Documentation
**Copilot Prompt:**
```
Create API documentation /docs/inventory_alerts_api.md:

Document each endpoint:
1. POST /api/upf/inventory-alerts/check-lot/{lot_id}
2. GET /api/upf/inventory-alerts/lot/{lot_id}
3. POST /api/upf/inventory-alerts/{alert_id}/acknowledge
4. POST /api/upf/inventory-alerts/lot/{lot_id}/acknowledge-bulk
5. GET /api/upf/inventory-alerts/rules
6. PUT /api/upf/inventory-alerts/rules/{item_variant_id}
7. GET /api/upf/inventory-alerts/procurement-recommendations
8. (Enhanced) POST /api/upf/production-lots
9. (Enhanced) GET /api/upf/production-lots/{lot_id}
10. (Enhanced) PUT /api/upf/production-lots/{lot_id}/finalize

For each endpoint document:
- Purpose
- Request format (method, URL, body)
- Response format (status code, body)
- Error responses
- Example curl command
- Rate limits

Include:
- Authentication requirements
- Permission levels
- Performance notes
- Common use cases
- Troubleshooting guide
```

### Step 9.2: Create Database Schema Documentation
**Copilot Prompt:**
```
Create database documentation /docs/inventory_alerts_schema.md:

Document each new table:
1. inventory_alert_rules
2. production_lot_inventory_alerts
3. production_lot_procurement_recommendations

For each table:
- Purpose
- Column definitions with types
- Constraints
- Indexes
- Foreign key relationships
- Sample queries

Include:
- Schema diagram (ASCII or image)
- Trigger functions
- Performance considerations
- Backup/recovery procedures
```

### Step 9.3: Create User Guide
**Copilot Prompt:**
```
Create user guide /docs/production_lot_alert_user_guide.md:

Sections:
1. Understanding Inventory Alerts
   - What are alerts?
   - Alert severity levels
   - When alerts are triggered

2. Creating a Production Lot
   - Step-by-step guide
   - What to do if alerts appear
   - Understanding each alert

3. Acknowledging Alerts
   - How to acknowledge
   - Different action options (PROCEED, DELAY, SUBSTITUTE, PARTIAL_FULFILL)
   - When to choose each option

4. Managing Procurement
   - Understanding procurement recommendations
   - How to contact procurement
   - Tracking procurement status

5. Troubleshooting
   - Common issues
   - How to fix them
   - Contacting support

6. Best Practices
   - Setting safety stock levels
   - Managing production planning with alerts
   - Optimizing procurement
```

---

## PHASE 10: MONITORING & SUPPORT

### Step 10.1: Create Monitoring Dashboard
**Copilot Prompt:**
```
Create monitoring endpoint /api/upf/monitoring/alerts-health:

Returns:
{
  "alerts_generated_today": int,
  "alerts_by_severity": {...},
  "production_lots_pending_procurement": int,
  "average_alert_resolution_time": "HHmm",
  "variants_below_safety_stock": int,
  "procurement_recommendations_pending": int,
  "system_health": "healthy" | "warning" | "critical"
}

Dashboard page: /monitoring/alerts (admin only)
- Display metrics in charts/tables
- Show recent alerts
- Show pending recommendations
- Alert trend analysis
```

### Step 10.2: Create Error Logging and Support
**Copilot Prompt:**
```
Enhanced error logging for alert system:

Log all:
- Alert generation events (info level)
- Acknowledgments (audit level)
- Procurement recommendations created (info level)
- API errors related to alerts (error level)
- Performance metrics for alert queries (debug level)

Centralize logs with:
- Request ID correlation
- User context (who triggered the action)
- Timestamps
- Error stack traces (if applicable)

Enable:
- Log aggregation (ELK stack or similar)
- Alert on critical errors (e.g., alert generation failure)
- Performance monitoring (alert query latency)
```

---

## PHASE 11: FINAL INTEGRATION CHECKLIST

### Step 11.1: Complete Integration Verification
**Copilot Prompt:**
```
Run final integration verification:

1. Database Layer
   ☐ All tables created
   ☐ All indexes functional
   ☐ All triggers working
   ☐ FK constraints enforced
   ☐ No orphaned data

2. Services Layer
   ☐ All methods implemented
   ☐ All methods tested
   ☐ Error handling working
   ☐ Logging functional
   ☐ Caching strategy applied

3. API Layer
   ☐ All endpoints functional
   ☐ Request/response validation working
   ☐ Auth/permissions enforced
   ☐ Rate limiting active
   ☐ CORS configured

4. Frontend Layer
   ☐ All templates render
   ☐ All JavaScript loaded
   ☐ All CSS styles applied
   ☐ User interactions working
   ☐ Error messages clear

5. Business Logic
   ☐ Alert generation correct
   ☐ Severity classification accurate
   ☐ Acknowledgment workflow working
   ☐ Procurement recommendations accurate
   ☐ Lot status transitions correct

6. Data Integrity
   ☐ No data loss
   ☐ Audit trail complete
   ☐ Historical data preserved
   ☐ Backup/restore working
   ☐ Rollback tested

7. Performance
   ☐ Alert generation < 2 seconds (1000 variants)
   ☐ Alert retrieval < 500ms
   ☐ API responses < 1 second
   ☐ Database queries optimized
   ☐ No memory leaks

8. Security
   ☐ All inputs validated
   ☐ SQL injection prevented
   ☐ XSS protection active
   ☐ CSRF tokens enforced
   ☐ Rate limiting effective

Output: Generate final_integration_report.txt
If any item FAILED: Document action items and retry
If all PASSED: System ready for production deployment
```

---

## IMPLEMENTATION TIMELINE

| Phase | Task | Duration | Depends On |
|-------|------|----------|-----------|
| 0 | Pre-Integration | 1 day | None |
| 1 | Database Schema | 2 days | Phase 0 |
| 2 | Backend Services | 5 days | Phase 1 |
| 3 | API Endpoints | 3 days | Phase 2 |
| 4 | Frontend Templates | 4 days | Phase 2 |
| 5 | Migration Execution | 1 day | Phase 1 |
| 6 | Testing | 4 days | Phases 2-4 |
| 7 | Frontend Testing | 2 days | Phase 4 |
| 8 | Deployment Prep | 1 day | Phases 6-7 |
| 9 | Documentation | 2 days | Phases 1-8 |
| 10 | Monitoring | 1 day | Phase 8 |
| 11 | Final Verification | 1 day | All phases |
| **Total** | | **27 days** | |

---

## COPILOT EXECUTION SUMMARY

To execute this entire plan with GitHub Copilot:

1. Start with Phase 0 prompts (copy entire prompt into Copilot)
2. Execute Phase 1 migration creation
3. Move through Phases 2-4 sequentially
4. Run Phase 5 migration
5. Execute test suites (Phase 6-7)
6. Prepare deployment (Phase 8)
7. Generate documentation (Phase 9)
8. Set up monitoring (Phase 10)
9. Run final verification (Phase 11)

**Key Success Factors:**
- Execute prompts in sequence (dependencies matter)
- Test thoroughly at each phase
- Maintain backward compatibility throughout
- Keep detailed logs of all changes
- Communicate timeline to stakeholders
- Have rollback plan ready

**Risk Mitigation:**
- Backup before every phase
- Test in staging before production
- Deploy incrementally
- Monitor closely post-deployment
- Have support team on standby

---

**Document Status:** READY FOR GITHUB COPILOT IMPLEMENTATION
**Last Updated:** 2025-11-08
**Version:** 1.0
