# Quick Reference: Backend-Frontend-Database Synchronization

## ✅ Status: ALL SYNCHRONIZED

---

## Database Tables (MTC)
```
✅ processes
✅ subprocesses  
✅ process_subprocesses (with notes column)
✅ variant_usage
✅ cost_items
✅ substitute_groups
✅ additional_costs
✅ profitability
✅ process_timing (optional)
✅ conditional_flags (optional)
```

## Key API Endpoints
```
POST   /api/upf/processes              - Create process
GET    /api/upf/processes              - List processes
GET    /api/upf/processes/:id          - Get process
GET    /api/upf/processes/:id/structure - Get full structure ✅ FIXED
PUT    /api/upf/processes/:id          - Update process
DELETE /api/upf/processes/:id          - Delete process

POST   /api/upf/processes/:id/subprocesses - Add subprocess
POST   /api/upf/variant_usage          - Add variant
POST   /api/upf/cost_item              - Add cost
POST   /api/upf/substitute_group       - Create OR group
```

## Frontend Files
```
static/js/process_editor.js     - Process editing UI
static/js/process_manager.js    - Process list/management
static/js/subprocess_library.js - Subprocess library
static/js/production_lots.js    - Production management
```

## Recent Fixes
```
1. ✅ Added ps.notes column to process_subprocesses
2. ✅ Created variant_usage table
3. ✅ Created cost_items table  
4. ✅ Created substitute_groups table
5. ✅ Added all foreign keys and indexes
6. ✅ Configured update triggers
```

## Test Commands
```powershell
# Verify tables
psql -U postgres -h 127.0.0.1 -d MTC -c "\dt+"

# Check columns
psql -U postgres -h 127.0.0.1 -d MTC -c "\d process_subprocesses"

# Test API
python Project-root/scripts/verify_upf_endpoints.py

# Run app
python Project-root/run.py
```

## If You Need to Re-sync
```powershell
# 1. Create missing tables
psql -U postgres -h 127.0.0.1 -d MTC -f Project-root/migrations/add_missing_upf_tables.sql

# 2. Add notes column if missing
psql -U postgres -h 127.0.0.1 -d MTC -c "ALTER TABLE process_subprocesses ADD COLUMN IF NOT EXISTS notes TEXT;"

# 3. Verify
python Project-root/scripts/verify_upf_endpoints.py
```

## Documentation Files
```
BACKEND_FRONTEND_DB_SYNC_REPORT.md   - Detailed analysis
BACKEND_FRONTEND_DB_SYNC_COMPLETE.md - Completion summary
```

---
**Last Updated:** November 7, 2025  
**Status:** ✅ Production Ready
