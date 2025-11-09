# GitHub Copilot Prompts for UPF Synchronization Fixes
## Copy-Paste Ready Prompts for Phase 1 Critical Fixes

---

## PROMPT 1: Implement Reporting API (Reports/Metrics Endpoint)

```
I need to implement a complete Reports API for the Universal Process Framework. 
Create a new file app/api/reports.py with a Flask blueprint that provides real business intelligence.

Requirements:
1. Create reports_api_bp Blueprint named "reports_api"
2. Implement GET /api/upf/reports/metrics endpoint that returns:
   - total_processes: COUNT of all non-deleted processes
   - total_lots: COUNT of all production lots
   - avg_cost: AVERAGE worst_case_cost from processes
   - completed_lots: COUNT of production lots with status='completed'
   - processes_change: % change in process count vs last month (can be 0 if can't calculate)
   - lots_change: % change in lot count vs last month
   - cost_change: % change in avg cost vs last month
   - completed_change: % change in completed lots vs last month

3. Use database queries (psycopg2) to fetch real data from:
   - processes table (filter deleted_at IS NULL)
   - production_lots table
   - Count aggregations with date comparisons

4. Wrap all responses with APIResponse.success({...}) utility
5. Include @login_required decorator on all routes
6. Include error handling with try-catch returning APIResponse.error()
7. Add logging for debugging

The response MUST use these exact field names (frontend depends on them):
- total_processes, total_lots, avg_cost, completed_lots
- processes_change, lots_change, cost_change, completed_change

Use get_conn() from database module for database access.
Include psycopg2.extras.RealDictCursor for readable results.
```

---

## PROMPT 2: Implement Top Processes Report Endpoint

```
In app/api/reports.py, add GET /api/upf/reports/top-processes endpoint.

Requirements:
1. Return top 5 processes by worst_case_cost (most expensive first)
2. Response format MUST be exactly:
   {
     "processes": [
       {"name": string, "worst_case_cost": float},
       {"name": string, "worst_case_cost": float},
       ...
     ]
   }
3. Query processes table ordering by worst_case_cost DESC LIMIT 5
4. Filter deleted_at IS NULL
5. Use APIResponse.success() wrapper
6. Include @login_required decorator
7. Include error handling

The frontend expects response.json.processes to be iterable list of objects with "name" and "worst_case_cost" fields.
```

---

## PROMPT 3: Implement Process Status Report Endpoint

```
In app/api/reports.py, add GET /api/upf/reports/process-status endpoint.

Requirements:
1. Return count of processes by status
2. Response format MUST be exactly:
   {
     "active": integer,
     "inactive": integer,
     "draft": integer
   }
3. Query processes table and COUNT(*) grouped by status field
4. Filter deleted_at IS NULL
5. Return 0 for any status with no processes
6. Use APIResponse.success() wrapper
7. Include @login_required decorator
8. Include error handling with try-catch

Note: Check your processes table schema for actual status values. 
If status field uses different values than "active/inactive/draft", adjust accordingly.
You can comment in the code what you find.
```

---

## PROMPT 4: Implement Subprocess Usage Report Endpoint

```
In app/api/reports.py, add GET /api/upf/reports/subprocess-usage endpoint.

Requirements:
1. Return top 5 subprocesses by usage count (how many times used in process_subprocesses)
2. Response format MUST be exactly:
   {
     "subprocesses": [
       {"name": string, "usage_count": integer},
       {"name": string, "usage_count": integer},
       ...
     ]
   }
3. Query: SELECT s.name, COUNT(ps.id) as usage_count FROM subprocesses s 
          LEFT JOIN process_subprocesses ps ON ps.subprocess_id = s.id 
          GROUP BY s.id, s.name 
          ORDER BY usage_count DESC LIMIT 5
4. Filter subprocesses.deleted_at IS NULL
5. Use APIResponse.success() wrapper
6. Include @login_required decorator
7. Include error handling

Frontend expects response.json.subprocesses to be iterable with "name" and "usage_count" fields.
```

---

## PROMPT 5: Register Reports Blueprint in app/__init__.py

```
In app/__init__.py, find the section where blueprints are imported and registered (around line with "from .api.process_management import").

Add these two lines to the imports section:
from .api.reports import reports_api_bp

Then find where blueprints are registered with app.register_blueprint() calls.
Add this line after the other UPF blueprints:
app.register_blueprint(reports_api_bp, url_prefix="/api/upf")

Then find the csrf.exempt() section and add:
csrf.exempt(reports_api_bp)

This registers the new reports API and makes it accessible at /api/upf/reports/*.
```

---

## PROMPT 6: Fix Inventory Alerts Lot-Scoped Routes Verification

```
In app/api/inventory_alerts.py, verify these routes exist and are correctly implemented:

1. @inventory_alerts_bp.route("/inventory-alerts/lot/<int:production_lot_id>", methods=["GET"])
   Function: upf_get_lot_alerts()
   Should return response with: lot_id, lot_status_inventory, total_alerts, alerts_summary, alert_details

2. @inventory_alerts_bp.route("/inventory-alerts/lot/<int:production_lot_id>/acknowledge-bulk", methods=["POST"])
   Function: upf_acknowledge_bulk()
   Should accept JSON payload: {"acknowledgments": [{"alert_id": int, "user_action": string, "action_notes": string}]}
   Should return: status, acknowledged_count, updated_lot_status, alerts_summary

If these routes/functions don't exist, create them. If they exist, verify:
- They return APIResponse.success() wrapped responses
- Alert details include: alert_id, user_acknowledged, severity, message
- alerts_summary has by_severity: {CRITICAL: int, HIGH: int, MEDIUM: int, LOW: int}
- Error responses return APIResponse.error() with 400/500 status codes

Test by running: 
  curl -X GET http://localhost:5000/api/upf/inventory-alerts/lot/1 -H "Cookie: session=..."
  (verify response contains alert_details and alerts_summary)
```

---

## PROMPT 7: Implement Real process_subprocess Delete Endpoint

```
In app/api/process_management.py, find or create the DELETE /api/upf/process_subprocess/<id> endpoint.

Requirements:
1. Route should be: @process_api_bp.route('/process_subprocess/<int:subprocess_id>', methods=['DELETE'])
2. Function name: delete_process_subprocess(subprocess_id)
3. Implementation:
   - Get database connection using get_conn()
   - DELETE FROM process_subprocesses WHERE id = %s AND deleted_at IS NULL
   - If no rows deleted, return APIResponse.not_found('Process subprocess', subprocess_id)
   - On success, return APIResponse.success({"process_subprocess_id": subprocess_id, "deleted": True})
   - Wrap in try-catch, return APIResponse.error() on exception
4. Add @login_required decorator
5. Optionally add permission check (admin or subprocess owner)
6. Add logging: current_app.logger.info(f"Process subprocess {subprocess_id} deleted by user {current_user.id}")

IMPORTANT: This should do a HARD delete (DELETE, not soft delete with deleted_at). 
If your table uses soft deletes, use: UPDATE process_subprocesses SET deleted_at = NOW() WHERE id = %s

Current behavior: Endpoint returns stub response from stubs.py
After fix: Should actually delete the row from database
```

---

## PROMPT 8: Implement Substitute Groups Retrieval Endpoint

```
In app/api/process_management.py, find or create the GET /api/upf/process_subprocess/<id>/substitute_groups endpoint.

Requirements:
1. Route should be: @process_api_bp.route('/process_subprocess/<int:process_subprocess_id>/substitute_groups', methods=['GET'])
2. Function name: get_substitute_groups(process_subprocess_id)
3. Implementation:
   - Query: SELECT * FROM or_groups WHERE process_subprocess_id = %s AND deleted_at IS NULL ORDER BY id
   - For each or_group, also fetch related variants from variant_usage table
   - Format response as array of objects with fields: id, name, description, variants[]
   - Where variants is array of {id, item_id, quantity, unit, is_alternative}
4. Wrap response with APIResponse.success({"substitute_groups": [...]})
5. Add @login_required decorator
6. Include error handling with try-catch
7. Add logging for debugging

Response format should be:
{
  "substitute_groups": [
    {
      "id": int,
      "name": string,
      "description": string,
      "variants": [
        {"id": int, "item_id": int, "quantity": int, "unit": string, "is_alternative": bool},
        ...
      ]
    }
  ]
}

Current behavior: Endpoint returns empty array stub from stubs.py
After fix: Should return actual or_groups from database with related variants
```

---

## PROMPT 9: Create Contract Test for Reports API

```
Create a new file tests/test_upf_reports_contracts.py for contract validation.

Requirements:
1. Import pytest, create_app from app, get_conn from database
2. Create fixture for test_client that initializes testing app
3. Test function: test_reports_metrics_endpoint_contract()
   - Make GET request to /api/upf/reports/metrics
   - Verify status_code == 200
   - Verify response has fields: total_processes, total_lots, avg_cost, completed_lots
   - Verify each field is correct type (int, float, int)
   - Assert response values make sense (not negative, reasonable ranges)

4. Test function: test_reports_top_processes_contract()
   - Make GET request to /api/upf/reports/top-processes
   - Verify status_code == 200
   - Verify response has "processes" key
   - Verify processes is list
   - Verify each process has "name" and "worst_case_cost" fields
   - If list not empty, verify worst_case_cost values are floats >= 0

5. Test function: test_reports_process_status_contract()
   - Make GET request to /api/upf/reports/process-status
   - Verify status_code == 200
   - Verify response has "active", "inactive", "draft" keys
   - Verify each value is integer >= 0

6. Test function: test_reports_subprocess_usage_contract()
   - Make GET request to /api/upf/reports/subprocess-usage
   - Verify status_code == 200
   - Verify response has "subprocesses" key
   - Verify subprocesses is list
   - Verify each has "name" and "usage_count" fields
   - Verify usage_count is integer >= 0

Run tests with: pytest tests/test_upf_reports_contracts.py -v
```

---

## PROMPT 10: Create Contract Test for Inventory Alerts

```
Create a new file tests/test_upf_alerts_contracts.py for alert endpoint validation.

Requirements:
1. Import pytest, create_app, get_conn
2. Create test_client fixture
3. Create fixture to set up test data: a production_lot with some alert rules

4. Test function: test_get_lot_alerts_response_contract()
   - Make GET request to /api/upf/inventory-alerts/lot/{test_lot_id}
   - Verify status_code in [200, 404] (depends on test data setup)
   - If 200, verify response structure:
     - Has keys: lot_id, lot_status_inventory, total_alerts, alerts_summary, alert_details
     - alerts_summary has "by_severity" key with counts
     - alert_details is list with objects containing: alert_id, severity, message, user_acknowledged

5. Test function: test_acknowledge_bulk_payload_contract()
   - Create sample payload: {"acknowledgments": [{"alert_id": 1, "user_action": "PROCEED", "action_notes": "test"}]}
   - Make POST request to /api/upf/inventory-alerts/lot/{test_lot_id}/acknowledge-bulk
   - Verify request doesn't return 400 (invalid payload)
   - Verify response status in [200, 409, 422, 500]
   - If 200, verify response has: status, acknowledged_count, updated_lot_status

6. Test function: test_missing_acknowledge_action_fails()
   - Create payload WITHOUT user_action: {"acknowledgments": [{"alert_id": 1}]}
   - Make POST request
   - Verify returns error status (400 or 422)
   - Verify error message is readable

Run tests with: pytest tests/test_upf_alerts_contracts.py -v
```

---

## PROMPT 11: Update Documentation - Create ENDPOINT_INVENTORY.md

```
Create a new file Project-root/ENDPOINT_INVENTORY.md that documents the current state of all UPF endpoints.

Format as a markdown table with columns:
- Endpoint (path)
- Method (GET/POST/DELETE)
- Status (✅ Implemented | ⚠️ Partial | ❌ Stubbed | ⏳ Planned)
- Response Format (expected JSON structure)
- Frontend Caller (which JS file uses this)
- Last Verified (date)
- Notes

Include all endpoints from:
1. Reports API:
   - GET /api/upf/reports/metrics
   - GET /api/upf/reports/top-processes
   - GET /api/upf/reports/process-status
   - GET /api/upf/reports/subprocess-usage

2. Inventory Alerts:
   - GET /api/upf/inventory-alerts/lot/<id>
   - POST /api/upf/inventory-alerts/lot/<id>/acknowledge-bulk
   - GET /api/upf/inventory-alerts/rules
   - POST /api/upf/inventory-alerts/rules/<id> (PUT)

3. Process Management:
   - DELETE /api/upf/process_subprocess/<id>
   - GET /api/upf/process_subprocess/<id>/substitute_groups

4. Categories & Variants:
   - GET /api/categories
   - GET /api/all-variants

This becomes the single source of truth for synchronization status.
Update it every time an endpoint is fixed or broken.
```

---

## EXECUTION CHECKLIST

Run these prompts in order:

- [ ] PROMPT 1: Implement Reports/Metrics Endpoint
- [ ] PROMPT 2: Implement Top Processes Endpoint  
- [ ] PROMPT 3: Implement Process Status Endpoint
- [ ] PROMPT 4: Implement Subprocess Usage Endpoint
- [ ] PROMPT 5: Register Reports Blueprint in app/__init__.py
- [ ] PROMPT 6: Verify Inventory Alerts Routes
- [ ] PROMPT 7: Implement Real process_subprocess Delete
- [ ] PROMPT 8: Implement Substitute Groups Endpoint
- [ ] PROMPT 9: Create Reports Contract Tests
- [ ] PROMPT 10: Create Alerts Contract Tests
- [ ] PROMPT 11: Create ENDPOINT_INVENTORY.md

---

## POST-IMPLEMENTATION VERIFICATION

After running all prompts, verify fixes:

```bash
# Run contract tests
pytest tests/test_upf_reports_contracts.py -v
pytest tests/test_upf_alerts_contracts.py -v

# Manual verification (in browser console)
fetch('/api/upf/reports/metrics', {credentials: 'include'})
  .then(r => r.json())
  .then(d => console.log('Metrics:', d));

fetch('/api/upf/reports/top-processes', {credentials: 'include'})
  .then(r => r.json())
  .then(d => console.log('Top processes:', d));

fetch('/api/upf/reports/process-status', {credentials: 'include'})
  .then(r => r.json())
  .then(d => console.log('Process status:', d));

fetch('/api/upf/reports/subprocess-usage', {credentials: 'include'})
  .then(r => r.json())
  .then(d => console.log('Subprocess usage:', d));

fetch('/api/upf/inventory-alerts/lot/1', {credentials: 'include'})
  .then(r => r.json())
  .then(d => console.log('Lot alerts:', d));

# Check process_subprocess deletion works
curl -X DELETE http://localhost:5000/api/upf/process_subprocess/1 \
  -H "Cookie: session=..." \
  -H "Content-Type: application/json"

# Check substitute groups endpoint
curl http://localhost:5000/api/upf/process_subprocess/1/substitute_groups \
  -H "Cookie: session=..."
```

---

## TROUBLESHOOTING

If GitHub Copilot generates incomplete code:

1. **For database queries:** Specify "use psycopg2.extras.RealDictCursor for readable column names"
2. **For imports:** Explicitly list: "from app.utils.response import APIResponse", "from flask_login import login_required"
3. **For response format:** Copy-paste exact expected JSON structure from prompts
4. **For errors:** Say "Add comprehensive error handling with try-catch block"
5. **For testing:** Say "Use pytest fixture pattern and assertions not just print statements"

---

## NOTES FOR EFFICIENT EXECUTION

- Use VS Code Command Palette (Cmd+Shift+P) → "GitHub Copilot: Start Chat in Editor"
- Copy prompt into chat, let Copilot generate code
- Review generated code for:
  - Correct database table names (verify in your schema)
  - Correct column names (verify in your schema)
  - Proper error handling
  - Proper logging
- Test immediately after each implementation
- Commit to git after each working prompt
