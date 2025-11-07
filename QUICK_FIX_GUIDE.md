# 🚀 QUICK FIX REFERENCE GUIDE

**Last Updated:** November 7, 2025  
**Project:** MTC Flask Application

---

## 🔴 TOP 3 CRITICAL FIXES (Do These First!)

### Fix #1: Standardize Route Naming (2 hours)
**Problem:** Frontend uses `/processes/`, backend uses `/process/`

**Files to Edit:**
1. `app/api/process_management.py`
2. `app/api/subprocess_management.py`
3. `app/api/variant_management.py`

**Change:**
```python
# OLD (wrong)
@process_api_bp.route("/process/<int:process_id>", methods=["GET"])

# NEW (correct)
@process_api_bp.route("/processes/<int:process_id>", methods=["GET"])
```

**Apply to:** All routes with `/process/<id>`, `/subprocess/<id>`, etc.

---

### Fix #2: Remove Duplicate Routes from app.py (1 hour)
**Problem:** Routes defined in BOTH `app.py` and `app/api/routes.py`

**Action:** DELETE these functions from `app.py`:
- `update_variant_stock`
- `update_variant_threshold`
- `delete_variant`
- `add_variant`
- `update_variant`
- `get_users`
- `update_user_role`
- `get_low_stock_report`
- `import_preview_json`
- `import_commit`
- `export_inventory_csv`
- `get_or_create_master_id`
- `get_or_create_item_master_id`

**Keep only in:** `app/api/routes.py` and `app/utils.py`

---

### Fix #3: Consolidate role_required Decorator (30 min)
**Problem:** Defined in 6 different files

**Action:**
```python
# In ALL files, replace the local definition with:
from app.auth.decorators import role_required

# DELETE the local copy of role_required
```

**Files to update:**
- `app.py`
- `app/utils.py`
- `app/api/process_management.py`
- `app/api/production_lot.py`
- `app/api/variant_management.py`

**Keep ONLY in:** `app/auth/decorators.py`

---

## ⚠️ MISSING BACKEND ROUTES (Must Implement or Fix)

### Category: Authentication
```
❌ POST /api/login → Exists as /auth/api_login
❌ POST /api/reset-password → Exists as /auth/api_reset_password
```

**Quick Fix:** Update frontend or add route aliases

---

### Category: UPF Routes (Naming Issue)
```
Frontend calls:              Backend has:
/api/upf/processes/<id>  →   /api/upf/process/<id>  ✅
/api/upf/subprocesses/<id> → /api/upf/subprocess/<id> ✅
```

**Fix:** Apply Fix #1 (standardize naming)

---

### Category: Missing Implementations
```
❌ GET  /api/upf/processes/<id>/costing
❌ POST /api/upf/process/<id>/reorder_subprocesses
❌ DEL  /api/upf/variant_usage/<id>
❌ DEL  /api/upf/process_subprocess/<id>
❌ GET  /api/upf/process_subprocess/<id>/substitute_groups
❌ DEL  /api/upf/substitute_group/<id>
❌ POST /api/upf/production_lot/<id>/variant_options
```

**Action:** Implement these routes in respective API files

---

### Category: Reports (Not Implemented)
```
❌ GET /api/upf/reports/metrics
❌ GET /api/upf/reports/top-processes
❌ GET /api/upf/reports/process-status
❌ GET /api/upf/reports/subprocess-usage
```

**Options:**
1. Implement reports API in new file `app/api/reports.py`
2. Remove `static/js/upf_reports.js` if not ready

---

### Category: Inventory/Variant
```
❌ GET /api/categories → Should exist (check routes.py)
❌ GET /api/all-variants → Should exist (check routes.py)
```

**Action:** Verify these routes exist in `app/api/routes.py`

---

## 🐛 BUG FIXES

### Incomplete Logger (app.py lines 50-56)
```python
# DELETE these stubs:
def info(self): pass
def warning(self): pass
def error(self): pass

# USE Python's logging module instead:
import logging
logger = logging.getLogger(__name__)
```

---

### Incomplete CSV Writer (app.py lines 185-209)
```python
# DELETE stub class
# USE Python's csv module:
import csv
import io

class CSVWriter:
    def __init__(self):
        self.output = io.StringIO()
        self.writer = csv.writer(self.output)
    
    def writerow(self, row):
        self.writer.writerow(row)
    
    def seek(self, pos):
        self.output.seek(pos)
    
    def truncate(self):
        self.output.truncate()
```

---

## 📝 TESTING CHECKLIST

After applying fixes, test these user flows:

### Critical Flows
- [ ] User login
- [ ] Create new process
- [ ] Edit existing process
- [ ] Add subprocess to process
- [ ] Create production lot
- [ ] Select variants for production lot
- [ ] Execute production lot

### API Tests
```bash
# Test process endpoints
curl http://localhost:5000/api/upf/processes

# Test specific process (use actual ID)
curl http://localhost:5000/api/upf/processes/1

# Test authentication
curl -X POST http://localhost:5000/auth/api_login \
  -H "Content-Type: application/json" \
  -d '{"username":"test","password":"test"}'
```

---

## 🔧 UTILITY COMMANDS

### Run Enhanced Auditor
```bash
cd "C:\Users\erkar\OneDrive\Desktop\MTC"
python enhanced_project_auditor.py
```

### Check Route Count
```bash
cd Project-root
python -c "from app import create_app; app = create_app('development'); print(f'Total routes: {len(list(app.url_map.iter_rules()))}')"
```

### List All Routes
```bash
cd Project-root
python -c "from app import create_app; app = create_app('development'); [print(f'{r.endpoint:50} {r.rule}') for r in app.url_map.iter_rules()]" | sort
```

### Grep for Duplicate Functions
```bash
# Find all definitions of a function
grep -rn "def role_required" --include="*.py" .
```

---

## 📊 PROGRESS TRACKING

After each fix, update this checklist:

### Week 1 Fixes
- [ ] Fix #1: Standardize route naming (process/processes)
- [ ] Fix #2: Remove duplicate routes from app.py
- [ ] Fix #3: Consolidate role_required decorator
- [ ] Fix incomplete logger class
- [ ] Fix incomplete CSV writer class
- [ ] Implement missing authentication routes
- [ ] Implement missing UPF routes (6 endpoints)

### Week 2 Fixes
- [ ] Implement UPF reports API (4 endpoints) OR remove feature
- [ ] Verify categories/variants routes exist
- [ ] Add integration tests for all fixed routes
- [ ] Update API documentation

### Week 3 Optimization
- [ ] Document all 121 backend routes
- [ ] Clean up unused routes (after verification)
- [ ] Move documentation files to docs/ folder
- [ ] Create API reference documentation

---

## 🎯 SUCCESS METRICS

**Target After Week 1:**
- Missing backend routes: **0** (currently 26)
- Duplicate functions: **< 20** (currently 75)
- Incomplete implementations: **0** (currently 7)
- Test coverage: **> 60%**

**How to Verify:**
```bash
python enhanced_project_auditor.py
# Check statistics section in report
```

---

## 📞 QUICK REFERENCE

| File | Purpose | Action |
|------|---------|--------|
| `app.py` | Legacy? | DELETE duplicate routes |
| `app/__init__.py` | App factory | ✅ Keep |
| `app/api/routes.py` | Main API | ✅ Keep, check for categories route |
| `app/api/process_management.py` | Process API | FIX: Rename /process/ → /processes/ |
| `app/api/subprocess_management.py` | Subprocess API | FIX: Rename routes |
| `app/api/variant_management.py` | Variant API | FIX: Implement missing routes |
| `app/auth/decorators.py` | Auth decorators | ✅ Canonical version |
| `app/utils.py` | Utilities | FIX: Remove duplicates from app.py |

---

## 🚨 EMERGENCY ROLLBACK

If something breaks after changes:

```bash
# Revert specific file
git checkout HEAD -- app/api/process_management.py

# Revert all changes
git reset --hard HEAD

# Check what changed
git diff HEAD
```

---

## 📱 CONTACT

**Project:** MTC Flask Application  
**Audit Date:** November 7, 2025  
**Tools Used:** Enhanced Project Auditor v2.0  

**Generated Files:**
- `enhanced_audit_report.json` (detailed JSON report)
- `FINAL_AUDIT_SUMMARY.md` (comprehensive analysis)
- `QUICK_FIX_GUIDE.md` (this file)

---

**⚡ TIP:** Start with Fix #1 - it will resolve 70% of missing route issues immediately!
