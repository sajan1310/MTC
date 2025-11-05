# How to Use the Repair Documents and Copilot Prompt
## Complete Workflow Guide

---

## Overview: What You Have

You now have **4 comprehensive repair documents** that work together:

| Document | Purpose | When to Use |
|---|---|---|
| **MTC_Deep_Integration_Audit.md** | Reference guide with all details | When you need to understand "why" something is broken |
| **MTC_Code_Fixes_Guide.md** | Copy-paste code ready to use | When implementing fixes in your code |
| **MTC_Action_Plan.md** | Project management checklist | When tracking progress, timeline, risks |
| **GitHub_Copilot_Prompt.md** | Instructions for Copilot | When using GitHub Copilot to assist repairs |

Plus: **MTC_Endpoints_Audit.csv** (if downloaded) - Track endpoint status

---

## Step-by-Step: How to Start Repairs

### Step 1: Prepare Your Workspace

1. **Download all 4 documents** to: `C:\Users\erkar\OneDrive\Desktop\MTC\`
   - MTC_Deep_Integration_Audit.md
   - MTC_Code_Fixes_Guide.md
   - MTC_Action_Plan.md
   - GitHub_Copilot_Prompt.md

2. **Open your MTC project:**
   ```bash
   cd C:\Users\erkar\MTC
   ```

3. **Ensure you have tools installed:**
   - Python 3.8+ with Flask
   - Postman or Insomnia (for API testing)
   - Chrome/Firefox with DevTools (for browser testing)
   - GitHub Copilot VS Code extension (if using Copilot)
   - pytest (for automated tests)

4. **Start Flask dev server in one terminal:**
   ```bash
   python run.py
   # or
   flask run
   ```

---

### Step 2: Read the Action Plan (30 minutes)

**Open:** `MTC_Action_Plan.md`

**Read these sections:**
- Executive Summary (understand the problem in 30 seconds)
- Timeline (Week 1/2/3 overview)
- Critical Fixes table (see what needs fixing first)
- Checklist: Before Going Live (success criteria)

**Why:** You need to understand the overall scope and timeline before diving into code.

---

### Step 3: Choose Your Approach

#### **Option A: Use GitHub Copilot (Recommended for Speed)**

**Steps:**
1. Open VS Code → GitHub Copilot Chat
2. Copy entire **GitHub_Copilot_Prompt.md** into Copilot
3. Follow the "EXECUTION ORDER" (16 tasks)
4. Copilot will help you create/fix files
5. You validate and test each fix

**Timeline:** 8-12 hours (3-4 days of work)

**Best for:** Developers comfortable with AI, want speed

---

#### **Option B: Manual Repairs with Code Guide (Most Control)**

**Steps:**
1. Read **MTC_Code_Fixes_Guide.md** Section A (Python fixes)
2. Manually implement each fix in your code
3. Read Section B (JavaScript fixes)
4. Manually implement JavaScript fixes
5. Read Section C (HTML fixes)
6. Update templates

**Timeline:** 15-20 hours (5-7 days of work)

**Best for:** Developers who prefer full control, understanding each change

---

#### **Option C: Hybrid (Recommended)**

**Steps:**
1. Use Copilot for repetitive fixes (Task 1.1, 1.2, 2.1, 2.4)
2. Manually review and test each fix
3. Use Copilot for testing/validation (Task 3, 4)

**Timeline:** 10-15 hours (4-6 days of work)

**Best for:** Balance of speed and control

---

## Detailed Workflow by Approach

### APPROACH A: GitHub Copilot (Fastest)

#### Step 1: Copy Copilot Prompt
```
1. Open: GitHub_Copilot_Prompt.md
2. Select ALL text (Ctrl+A)
3. Copy (Ctrl+C)
4. Open: VS Code → Copilot Chat
5. Paste prompt (Ctrl+V)
6. Send to Copilot
```

#### Step 2: Execute Task 1.1

**Copilot will ask:** "Should I create the response handler?"

**Your response:** "Yes, follow the checklist exactly. After creating, show me the final file and confirm all 4 methods exist."

**Copilot will:**
1. Create `app/utils/response.py`
2. Add APIResponse class
3. Show the created code

**Your verification:**
```python
# ✓ Check that it has these 4 methods:
# 1. success() - returns JSON with data
# 2. error() - returns JSON with error code
# 3. created() - calls success() with 201 status
# 4. not_found() - returns 404 error
```

If all present → Proceed to Task 1.2

If missing → Ask Copilot: "The created() method is missing, add it based on the Code Fixes Guide Section A.1"

#### Step 3: Execute Tasks 1.2-4.3

**For each task:**
1. Read the task description
2. Tell Copilot to execute (e.g., "Now do Task 1.2 Fix #1: Process Structure Route")
3. Copilot will implement the fix
4. Copilot will show you the code
5. **Verify against the Validation checklist** in the task
6. If correct, type: "Validation passed. Proceed to next task."
7. If incorrect, type: "This doesn't match the Code Fixes Guide. Show me the comparison."

#### Step 4: Use Copilot for Testing

**For Postman testing (Task 1.4):**
```
Tell Copilot: "For Task 1.4, give me the exact Postman request format for testing 
GET /api/upf/processes/1/structure including headers, expected response format, and where 
to look for errors if the test fails."
```

**For Pytest (Task 3.1):**
```
Tell Copilot: "Create pytest test suite for tests/test_process_api.py using the test cases 
from Code Fixes Guide Section 3.2. Include setup/teardown and all 5 test cases."
```

#### Step 5: Final Verdict (Task 4.3)

After all 16 tasks complete:

```
Tell Copilot: "Complete the Final Verdict Template. Run the 5 critical route verifications 
and tell me: PASS or FAIL for each. If any FAIL, explain why and what needs to be fixed next."
```

---

### APPROACH B: Manual Implementation (Most Control)

#### Step 1: Create Response Handler (30 min)

**File:** `app/utils/response.py`

1. Open: **MTC_Code_Fixes_Guide.md → Section A.1**
2. Copy the entire APIResponse class code
3. Create new file: `app/utils/response.py`
4. Paste code
5. Save

**Verify:**
- [ ] File exists at `app/utils/response.py`
- [ ] Contains `class APIResponse` with 4 methods
- [ ] No syntax errors (Python will show red squiggly if error)

#### Step 2: Fix Process Structure Route (1 hour)

**File:** `app/api/process_management.py`

1. Open: **MTC_Code_Fixes_Guide.md → Section A.2**
2. Find this function in your code: `get_process_structure()`
3. Compare current code to guide (side by side)
4. Replace your version with corrected version from guide
5. Save

**Verify in VS Code:**
- [ ] Route decorator shows: `@bp.route('/processes/<int:process_id>/structure'...`
- [ ] Function param is: `process_id` (not `process_id` from query)
- [ ] Uses `APIResponse.success()` for return
- [ ] No syntax errors

#### Step 3: Repeat for All Fixes

Follow same pattern for each fix:
1. Identify the file
2. Open Code Fixes Guide section
3. Find your current code
4. Replace with guide version
5. Verify
6. Test in Postman

**Fixes in order:**
1. Task 1.1: response.py (5 min)
2. Task 1.2 #1: Process structure route (10 min)
3. Task 1.2 #2: Cost item route (10 min)
4. Task 1.2 #3: Subprocess route (10 min)
5. Task 1.3: Standardize all responses (30 min)
6. Task 2.1: Create APIClient (30 min)
7. Task 2.2: Fix process_editor.js (45 min)
8. Task 2.3: Fix production_lots.js (45 min)
9. Task 2.4: Update templates (1 hour)

**Total:** 15-20 hours

#### Step 4: Test Each Fix

After each fix:

1. **For Python fixes:** Restart Flask server
   ```bash
   Ctrl+C (stop server)
   python run.py (restart)
   ```

2. **For JavaScript fixes:** Refresh browser
   ```
   Ctrl+Shift+R (hard refresh to clear cache)
   ```

3. **Test in Postman:** Follow the test case in the task description

4. **Check browser console:** DevTools → Console (should be no red errors)

---

### APPROACH C: Hybrid (Recommended)

**Use Copilot for:**
- Creating new files (faster)
- Repetitive updates (templates)
- Running test suites
- Generating code from requirements

**Do manually:**
- Complex logic changes (more control)
- Understanding each change
- Testing each piece
- Final validation

**Suggested hybrid breakdown:**

| Task | Approach |
|---|---|
| 1.1 Create response.py | Copilot (5 min vs 30 min) |
| 1.2 Fix routes | Manual (need understanding) |
| 1.3 Standardize responses | Copilot (it's repetitive) |
| 1.4 Test with Postman | Manual (you validate) |
| 2.1 Create APIClient | Copilot (it's just copying) |
| 2.2 Fix process_editor.js | Manual or Copilot (either works) |
| 2.3 Fix production_lots.js | Manual or Copilot (either works) |
| 2.4 Update templates | Copilot (repetitive) |
| 3.1 Create pytest | Copilot (from guide) |
| 3.2 Manual testing | Manual (you do it) |
| 3.3 Browser testing | Manual (you do it) |
| 4.1 Endpoint audit | Manual (comparing) |
| 4.2 Checklist | Manual (checking) |
| 4.3 Final verdict | Either (you review) |

**Time with hybrid:** 10-15 hours

---

## Testing: How to Validate Each Fix

### Test 1: Python File Syntax (Always)

**How:** Open file in VS Code, look for red squiggly lines
- If red squiggles → Syntax error, fix it
- If no squiggles → Syntax OK

### Test 2: Flask Server Starts (After Python Changes)

**How:**
```bash
python run.py
# Should output:
# * Running on http://127.0.0.1:5000
# * Press CTRL+C to quit
```

If error → Flask won't start, fix import statements

### Test 3: Postman API Test (After Each Route Fix)

**How:**
1. Open Postman
2. Click "New Request"
3. Copy URL from task (e.g., `http://localhost:5000/api/upf/processes/1/structure`)
4. Select GET/POST method
5. Add Body (if POST) from task description
6. Click "Send"
7. Check response:
   - Status code should be 200-201
   - Response should be JSON: `{ "data": {...}, "error": null }`

**If fails:**
- Check status code (500 = error)
- Look at response text (error message)
- Go back to fix, compare with guide
- Test again

### Test 4: Browser Console (After JavaScript Changes)

**How:**
1. Open browser to `http://localhost:5000/upf`
2. Press F12 (Developer Tools)
3. Click "Console" tab
4. Look for red errors
5. If error, click it to see details

### Test 5: Manual User Flow (After All Fixes)

**How:** Follow Test Flow #1 from MTC_Action_Plan.md

1. Create new process
2. Add subprocess
3. Add variant
4. Save
5. Check:
   - Process appears in list
   - No console errors
   - Database updated (check with DB tool)

---

## Troubleshooting: When Something Breaks

### Problem: "Module not found" error

**Solution:**
1. Check import statement matches file name
2. Example: `from app.utils.response import APIResponse`
   - File must be: `app/utils/response.py` (not Response.py or response_handler.py)
3. Restart Flask server

### Problem: Postman returns 404

**Solution:**
1. Check route path in Flask matches Postman URL
2. Example: If Flask has `/api/upf/processes/<int:process_id>/structure`
   - Postman should call: `http://localhost:5000/api/upf/processes/1/structure`
   - NOT `http://localhost:5000/processes/1/structure` (missing `/api/upf`)
3. Compare with Code Fixes Guide route definition

### Problem: JavaScript error "APIClient is not defined"

**Solution:**
1. Check script tags in HTML:
   - `<script src="/static/js/api_client.js"></script>` must be BEFORE other scripts
2. Check file exists: `static/js/api_client.js`
3. Hard refresh browser: Ctrl+Shift+R (clear cache)

### Problem: Cost field still wrong

**Solution:**
1. Check you changed ALL references from `amount` to `rate`
2. Use Find & Replace:
   - In VS Code: Ctrl+H
   - Find: `amount`
   - Replace: `rate`
   - Check each replacement (some might be in comments)

### Problem: Tests fail

**Solution:**
1. Run test with verbose output: `pytest -vv tests/test_process_api.py`
2. Read error message carefully
3. Check:
   - Database table exists for test
   - Test data is correct
   - Flask app configured for testing
4. If confused, reference Test section in Code Fixes Guide

---

## Progress Tracking: Use the Checklist

**Open:** `MTC_Action_Plan.md → Checklist: Before Going Live`

After each task, mark in the checklist:
- [ ] Task complete
- [ ] Tests pass
- [ ] Code reviewed

**Count:**
- Tasks completed: X/16
- Tests passed: X/10
- Checklist items: X/20

**When you reach:**
- Tasks: 16/16
- Tests: 10/10
- Checklist: 20/20

**Then:** You are PRODUCTION READY

---

## Final Double-Check: Critical Routes

**Before claiming victory, test these 5 routes in Postman:**

1. **GET /api/upf/processes/1/structure** → 200 OK
2. **POST /api/upf/processes/1/subprocesses** → 201 Created
3. **POST /api/upf/cost_item** (with `rate` field) → 201 Created
4. **GET /api/upf/production-lot/1/variant_options** → 200 OK (with error handling)
5. **POST /api/upf/production-lot/1/execute** → 200 OK or 400 if validation fails

**If ALL 5 pass:** ✓ PRODUCTION READY

**If ANY fail:** Re-read that section in Code Fixes Guide and fix

---

## Document Map: Where to Find Everything

**"Where is the fix for..."**

- **Process editor not loading?** → Code Fixes Guide A.2 or Deep Audit 1.3
- **Cost calculations failing?** → Code Fixes Guide A.4 or Deep Audit 1.3 (cost field)
- **No error messages in UI?** → Code Fixes Guide B.2, B.3, C.1
- **Modal closing without saving?** → Code Fixes Guide B.2 (saveProcess function)
- **Variant selection broken?** → Code Fixes Guide B.3 (loadVariantOptions)
- **Subprocess not adding?** → Code Fixes Guide A.3 or Deep Audit 1.3 (subprocess route)
- **Test failing?** → Code Fixes Guide 3.2 (pytest section)
- **What should I test?** → Deep Audit 3.1 or Action Plan "Manual Test Flows"
- **How long will this take?** → Action Plan "Timeline"
- **What are all the broken routes?** → Deep Audit 1.1 (endpoint table)
- **Why is it broken?** → Deep Audit 1 (root cause analysis)
- **How do I use Copilot?** → This document + GitHub_Copilot_Prompt.md

---

## Success Criteria: When You're Done

✓ **All 16 tasks completed**
✓ **Pytest suite passes (5+ tests)**
✓ **Manual user flows work (no errors)**
✓ **5 critical routes tested in Postman (all pass)**
✓ **Browser console clean (no red errors)**
✓ **Pre-deployment checklist 18/20+ items**
✓ **No known issues remaining**

When ALL true → **PRODUCTION READY**

---

## What to Do Next

1. **Choose your approach** (Copilot, Manual, or Hybrid)
2. **Open the appropriate reference document**:
   - Copilot → GitHub_Copilot_Prompt.md
   - Manual → MTC_Code_Fixes_Guide.md
   - Hybrid → Both
3. **Start with Task 1.1** (Create response.py)
4. **Follow the execution order**
5. **Validate each fix before moving to next task**
6. **Track progress** in Action Plan checklist

---

## Estimated Timeline

| Approach | Time | Effort | Quality |
|---|---|---|---|
| Copilot | 8-12 hours (1-2 days) | Low | High (if validated) |
| Manual | 15-20 hours (5-7 days) | High | Very High |
| Hybrid | 10-15 hours (3-5 days) | Medium | High |

**Recommendation:** Hybrid approach balances speed, control, and quality.

---

**Ready to start? Choose your approach above and begin!**
