# UPF Synchronization Fixes - Quick Start Guide

**TL;DR:** Copy prompts from `COPILOT_PROMPTS.md` into GitHub Copilot and execute in order. Takes ~3-4 hours.

---

## What You Need

- ✅ GitHub Copilot installed in VS Code
- ✅ Access to your MTC repository locally
- ✅ Database connection working (for testing endpoints)
- ✅ ~3-4 hours of focused time
- ❌ No need to manually write code

---

## Step-by-Step Execution

### 1. Open GitHub Copilot Chat

In VS Code:
- Press `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows/Linux)
- Type "GitHub Copilot: Start Chat in Editor"
- Click to open chat panel on right side

### 2. Navigate to Project Files

Before pasting each prompt, make sure you're in the right file:

**For PROMPTS 1-5 (Reports API):**
- Click on `app/api/` folder in VS Code explorer
- For Prompt 1-4: Right-click → "New File" → name it `reports.py`
- Then open it and paste prompt

**For PROMPTS 6-8 (Inventory Alerts & Process Management):**
- Open existing files: `app/api/inventory_alerts.py` and `app/api/process_management.py`

**For PROMPTS 9-10 (Tests):**
- Create new files in `tests/` folder: `test_upf_reports_contracts.py` and `test_upf_alerts_contracts.py`

### 3. Execute Each Prompt

Copy and paste into Copilot chat in order:

```
PROMPT 1: Implement Reporting API (Reports/Metrics Endpoint)
↓ Review code ↓ Accept/Modify ↓ Save
↓
PROMPT 2: Implement Top Processes Report Endpoint
↓ Review code ↓ Accept/Modify ↓ Save
↓
PROMPT 3: Implement Process Status Report Endpoint
↓ Review code ↓ Accept/Modify ↓ Save
↓
[continue through PROMPT 11...]
```

---

## What Copilot Will Generate

Each prompt results in code that:
- ✅ Implements real database queries
- ✅ Returns correct response formats
- ✅ Includes error handling
- ✅ Has logging for debugging
- ✅ Uses your existing utilities (APIResponse, get_conn, etc.)

**Your job:** 
1. Review generated code
2. Verify it looks correct
3. Accept or request changes
4. Save file
5. Move to next prompt

---

## Quality Checks for Each Prompt

After Copilot generates code, check:

### For Database Query Prompts (1-4, 6-8):
- [ ] Imports include: `from database import get_conn`, `from psycopg2.extras import RealDictCursor`
- [ ] Query uses correct table names (check your schema)
- [ ] Query uses correct column names (check your schema)
- [ ] Response uses exact field names from prompt (e.g., `total_processes`, not `total_proc`)
- [ ] Uses `APIResponse.success()` wrapper for success
- [ ] Uses `APIResponse.error()` for failures
- [ ] Has `@login_required` decorator
- [ ] Has `try-except` error handling with logging

### For Registration Prompt (5):
- [ ] Import added to top of file
- [ ] `app.register_blueprint()` call added
- [ ] URL prefix is `/api/upf`
- [ ] `csrf.exempt()` line added

### For Test Prompts (9-10):
- [ ] Uses `pytest` and fixtures
- [ ] Tests make actual HTTP requests to endpoints
- [ ] Tests verify response status codes
- [ ] Tests verify response has expected fields
- [ ] Tests use assertions not print statements

---

## If Copilot Generates Incomplete Code

Say this in chat:

**For incomplete database queries:**
```
The SELECT query is incomplete. Please expand it to:
1. Include all columns needed for response
2. Add WHERE clauses to filter deleted_at IS NULL
3. Include LIMIT and ORDER BY clauses
4. Use proper JOINs if needed
Full query should be wrapped in cur.execute() call.
```

**For incomplete response format:**
```
The response format is wrong. It must be exactly:
{
  "field1": value1,
  "field2": value2
}
Not wrapped in "data" or any other key. Use APIResponse.success({"field1": value1, ...})
```

**For missing error handling:**
```
Add a try-except block around the entire function.
On exception, log the error and return APIResponse.error("internal_error", str(e), 500).
Include current_app.logger.error() for logging.
```

---

## Testing After Each Prompt

**Quick sanity check:**

After PROMPT 5 (once Reports API is registered):

Open browser console and run:
```javascript
fetch('/api/upf/reports/metrics', {credentials: 'include'})
  .then(r => r.json())
  .then(d => {
    console.log('✅ Endpoint exists' , d);
    console.log('Status:', d.status || 'no status field');
  })
  .catch(e => console.error('❌ Error:', e));
```

Expected output:
```
✅ Endpoint exists { total_processes: 5, total_lots: 3, avg_cost: 125.50, ... }
```

If you see `404 Not Found` → blueprint not registered correctly (Prompt 5)
If you see `500 Internal Server Error` → database query error (Prompts 1-4)

---

## Common Issues & Fixes

### Issue: "ImportError: cannot import name 'get_conn'"
**Fix:** Ensure prompt includes `from database import get_conn`

### Issue: "psycopg2 error: column 'xyz' does not exist"
**Fix:** Your table schema differs from prompt. Ask Copilot:
```
The column name is wrong. In my database schema, the columns are [LIST THEM].
Update the SELECT query to use correct column names.
```

### Issue: "Frontend says endpoint returns wrong format"
**Fix:** Response field names must match exactly. Check:
```javascript
// Open console, run:
fetch('/api/upf/reports/metrics', {credentials: 'include'})
  .then(r => r.json())
  .then(d => console.log(Object.keys(d)))
  // Should print: ["total_processes", "total_lots", "avg_cost", ...]
```

### Issue: Endpoint returns 401 Unauthorized
**Fix:** Missing `@login_required` decorator. Ask Copilot to add it.

### Issue: Tests fail with "fixture 'test_client' not found"
**Fix:** Ensure test file has this at top:
```python
import pytest
from app import create_app

@pytest.fixture
def test_client():
    app = create_app('testing')
    app.config['TESTING'] = True
    with app.test_client() as client:
        yield client
```

---

## Expected Time per Prompt

| Prompt | Time | Notes |
|--------|------|-------|
| 1 | 20 min | First reports endpoint, sets pattern |
| 2 | 10 min | Similar to Prompt 1 |
| 3 | 10 min | Similar pattern |
| 4 | 10 min | Similar pattern |
| 5 | 5 min | Just registration |
| 6 | 10 min | Verification, may need adjustments |
| 7 | 15 min | Real delete implementation |
| 8 | 15 min | More complex query with JOINs |
| 9 | 20 min | Test setup + 4 test functions |
| 10 | 20 min | Test setup + 4 test functions |
| 11 | 10 min | Documentation markdown table |
| **Testing & Fixes** | **30 min** | Run tests, fix any failures |
| **Total** | **~3.5 hours** | Depends on how many adjustments needed |

---

## Post-Implementation Checklist

After all 11 prompts:

- [ ] All 4 Reports endpoints exist and return real data
- [ ] Reports page in browser shows metrics
- [ ] Inventory alerts work without 404s
- [ ] Process editor can delete subprocesses
- [ ] process_subprocess table rows are actually deleted
- [ ] Substitute groups endpoint returns data
- [ ] All contract tests pass (`pytest tests/test_upf_*.py -v`)
- [ ] No console errors in browser
- [ ] `ENDPOINT_INVENTORY.md` created and up-to-date
- [ ] All changes committed to git

---

## Success Indicators

✅ **You're done when:**
1. `pytest tests/test_upf_reports_contracts.py -v` → **PASSED** (4/4)
2. `pytest tests/test_upf_alerts_contracts.py -v` → **PASSED** (4/4)
3. Reports page displays real data (metrics, top processes, statuses)
4. No 404 errors when using production lot alerts
5. Process editor can delete subprocesses and see them removed
6. All 9 original issues from audit marked RESOLVED

---

## Next Steps After Phase 1

Once Phase 1 prompts are complete (29 hours of work compressed to 3.5 hours of Copilot prompting!):

1. **Run Full Test Suite**
   ```bash
   pytest tests/ -v
   ```

2. **Manual E2E Testing**
   - Create process → Add subprocesses → Add variants → Create production lot → Execute
   - Check reports page shows correct numbers
   - Check alerts work correctly

3. **Phase 2: Response Standardization** (if time permits)
   - Ask Copilot to audit all endpoints for consistent APIResponse usage
   - Create standardized error response format

4. **Phase 3: Integration Tests** (if time permits)
   - Ask Copilot to create full workflow tests

---

## Copilot Tips for Best Results

1. **Be specific about database schema:**
   ```
   In my database, the processes table has columns: id, name, worst_case_cost, status, deleted_at, created_at
   The production_lots table has: id, process_id, quantity, status, created_at, total_cost
   Use these exact column names in the query.
   ```

2. **Reference existing code patterns:**
   ```
   Follow the same pattern as the existing endpoint GET /api/upf/process/<id>.
   Use the same error handling, logging, and response format.
   ```

3. **Ask for multiple options:**
   ```
   Show me 2 different approaches to this query. Which is more efficient?
   ```

4. **Request code reviews:**
   ```
   Review this code for:
   1. Security issues
   2. Performance issues (N+1 queries?)
   3. Error handling completeness
   4. Logging statements
   ```

5. **Test generation:**
   ```
   Generate 5 test cases for this endpoint covering:
   - Happy path
   - Missing parameters
   - Invalid IDs
   - Database errors
   - Authorization failures
   ```

---

## Questions? Refer Back To

- **Full audit details** → See `UPF_SYNC_AUDIT.md`
- **What exactly to implement** → Copy from this file or prompts
- **Database schema** → Your `database.py` or migration files
- **Response format expectations** → Check frontend JS files in `static/js/`

---

**You've got this! Let Copilot do the coding work. Your job is to review, verify, and test. 🚀**
