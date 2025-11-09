# Route Cleanup Strategy Report
**Date:** November 9, 2025  
**Project:** MTC Application  
**Purpose:** Eliminate duplicate routes and standardize naming conventions

---

## Executive Summary

**Total Routes:** 183  
**Duplicate Groups:** 28 (68 routes affected)  
**Cleanup Potential:** Remove 34 routes (18.6% reduction)  

### Duplicate Categories
1. **Exact Duplicates:** 4 routes (same path + method in multiple files)
2. **Naming Variants:** 64 routes (underscore vs hyphen legacy compatibility)

---

## 🔴 CRITICAL: Exact Duplicates (Must Fix)

### Issue #1: `/api/items/<int:item_id>/variants` - POST Handler Conflict

**Problem:** Same route defined TWICE in same file with different handlers

**Location:** `app/api/routes.py`
- Line 1574: `@api_bp.route("/items/<int:item_id>/variants")` → handler: `bulk_delete_items` ❌
- Line 1724: `@api_bp.route("/items/<int:item_id>/variants", methods=["POST"])` → handler: `add_variant` ✅

**Analysis:**
- Line 1574 defaults to GET (no methods specified)
- Line 1724 explicitly defines POST
- **Handler name mismatch:** `bulk_delete_items` doesn't match route purpose (adding variant)
- This is a copy-paste error or refactoring remnant

**Recommended Action:**
```python
# DELETE line 1574 (wrong handler, ambiguous intent)
# KEEP line 1724 with explicit POST method and correct handler
```

**Risk:** HIGH - May break existing functionality if frontend depends on GET

---

### Issue #2: `/api/stock-receipts` - DELETE in Two Files

**Problem:** Same DELETE route defined in production code AND stub file

**Locations:**
- `app/api/routes.py`: `@api_bp.route("/stock-receipts", methods=["DELETE"])` → `delete_stock_receipt`
- `app/api/stubs.py:120`: `@api_bp.route("/stock-receipts", methods=["DELETE"])` → `delete_stock_receipt_stub`

**Analysis:**
- `stubs.py` contains placeholder/mock implementations for testing
- Production code in `routes.py` has real implementation
- Flask will register BOTH, but only one will be executed (undefined behavior)
- Stubs should NEVER be registered in production

**Recommended Action:**
```python
# Option 1: Remove stub registration entirely (preferred)
# DELETE app/api/stubs.py:120 OR remove blueprint registration

# Option 2: Use environment-based registration
if app.config.get('TESTING'):
    api_bp.route("/stock-receipts", methods=["DELETE"])(delete_stock_receipt_stub)
```

**Risk:** CRITICAL - Undefined behavior in production

---

## 🟡 MEDIUM PRIORITY: Naming Variants (Legacy Compatibility)

### Overview

The codebase maintains **dual route registrations** for backward compatibility:
- **Hyphenated** (modern): `/api/inventory-alert-rules`
- **Underscored** (legacy): `/api/inventory_alert_rules`

Both decorated on the **same function** to support old and new clients.

### Affected Routes

**File:** `app/api/inventory_alerts.py`

| Route Pattern | Hyphenated | Underscored | Total |
|---------------|------------|-------------|-------|
| `/inventory-alert-rules` | POST, GET | POST, GET | 4 |
| `/inventory-alert-rules/<int:rule_id>/deactivate` | PATCH | PATCH | 2 |
| `/inventory-alerts` | POST, GET | POST, GET | 4 |
| `/inventory-alerts/<int:alert_id>/acknowledge` | POST | POST | 2 |
| `/procurement-recommendations` | POST, GET | POST, GET | 4 |
| `/procurement-recommendations/<int:recommendation_id>/status` | PATCH | PATCH | 2 |
| **SUBTOTAL** | **9** | **9** | **18** |

**Other Files:** Similar patterns in `app/api/routes.py` for:
- `/api/items/<int:item_id>` (PUT, DELETE)
- `/api/purchase-orders/<int:po_id>` (PUT, DELETE)
- `/api/suppliers/<int:supplier_id>` (PUT, DELETE)
- `/api/upf/process/<int:process_id>` (GET, PUT, DELETE)
- `/api/upf/cost_item/<int:cost_id>` (PUT, DELETE)

**TOTAL NAMING VARIANTS:** ~34 underscore routes

---

## 🎯 Cleanup Strategy

### Phase 1: Immediate (This Week) - Fix Critical Issues

#### Action 1.1: Fix Exact Duplicate #1 - Item Variants
```python
# File: app/api/routes.py

# BEFORE (lines 1574-1578):
@api_bp.route("/items/<int:item_id>/variants")
@login_required
def bulk_delete_items(item_id):  # ❌ Wrong handler name
    # ... code ...

# AFTER: DELETE THESE LINES (1574-1578)
# Only keep the POST handler at line 1724
```

**Test Plan:**
1. Search codebase for calls to `GET /api/items/<item_id>/variants`
2. If found, update frontend to use proper endpoint
3. Run full test suite
4. Deploy to staging

---

#### Action 1.2: Fix Exact Duplicate #2 - Stock Receipts Stub
```python
# File: app/api/stubs.py

# OPTION A (Preferred): Remove stub entirely
# DELETE line 120 and handler function

# OPTION B: Conditional registration
if current_app.config.get('USE_STUBS', False):
    @api_bp.route("/stock-receipts", methods=["DELETE"])
    def delete_stock_receipt_stub():
        return jsonify({"status": "stub", "message": "Deleted (mock)"}), 200
```

**Test Plan:**
1. Verify no production code depends on stub behavior
2. Update test fixtures to mock properly
3. Test DELETE `/api/stock-receipts/<id>` in staging
4. Monitor logs for 500 errors

---

### Phase 2: Short-Term (Next Sprint) - Remove Legacy Routes

#### Strategy: Deprecation Period

**Week 1-2: Add Deprecation Warnings**
```python
# File: app/api/inventory_alerts.py

@api_bp.route("/inventory_alert_rules", methods=["POST"])  # legacy
@login_required
def upsert_alert_rule():
    current_app.logger.warning(
        f"DEPRECATED: Client using underscore route /inventory_alert_rules. "
        f"Update to /inventory-alert-rules. Will be removed in v2.1.0"
    )
    # ... existing code ...
```

**Week 3-4: Monitor Logs**
- Check access logs for underscore route usage
- Contact clients still using old endpoints
- Update internal frontends

**Week 5-6: Remove Legacy Routes**
```python
# Delete all @api_bp.route(..._..., methods=[...]) decorators
# Keep only hyphenated versions
```

---

#### Detailed Removal Plan

**inventory_alerts.py - Remove these lines:**
```python
Line 33:  @api_bp.route("/inventory_alert_rules", methods=["POST"])  
Line 88:  @api_bp.route("/inventory_alert_rules", methods=["GET"])  
Line 115: @api_bp.route("/inventory_alert_rules/<int:rule_id>/deactivate", ...)
Line 136: @api_bp.route("/inventory_alerts", methods=["POST"])  
Line 159: @api_bp.route("/inventory_alerts", methods=["GET"])  
Line 176: @api_bp.route("/inventory_alerts/<int:alert_id>/acknowledge", ...)
Line 208: @api_bp.route("/procurement_recommendations", methods=["POST"])  
Line 243: @api_bp.route("/procurement_recommendations", methods=["GET"])  
Line 271: @api_bp.route("/procurement_recommendations/<int:recommendation_id>/status", ...)
```

**Estimated time:** 30 minutes to remove, 2 hours to test

---

### Phase 3: Long-Term (Future) - Route Consolidation

#### Goal: Move from Dual Blueprint Registration

**Current Architecture:**
- Routes registered under `/api` blueprint
- Same routes also under `/api/upf` for UPF-specific features
- Results in many "unused" routes

**Example:**
```python
# routes.py - Main blueprint
@api_bp.route("/inventory-alerts", methods=["GET"])

# inventory_alerts.py - UPF blueprint  
@inventory_alerts_bp.route("/inventory-alerts", methods=["GET"])
```

**Recommendation:**
1. **Keep UPF variants** - Modern architecture, properly namespaced
2. **Deprecate legacy `/api/*` variants** - Redirect to `/api/upf/*`
3. **Use blueprint inheritance** - Avoid duplicate function definitions

**Timeline:** Q1 2026 (requires frontend migration)

---

## 📊 Impact Analysis

### Before Cleanup
- **Total Routes:** 183
- **Duplicate Routes:** 68
- **Maintenance Burden:** High (changes require updating 2-3 locations)
- **Code Clarity:** Low (which route is canonical?)

### After Cleanup (Phase 1 + 2)
- **Total Routes:** 149 (-34, -18.6%)
- **Duplicate Routes:** 34 (only UPF vs legacy remaining)
- **Maintenance Burden:** Medium
- **Code Clarity:** High (clear naming convention)

### After Full Cleanup (Phase 1 + 2 + 3)
- **Total Routes:** ~120 (-63, -34%)
- **Duplicate Routes:** 0
- **Maintenance Burden:** Low
- **Code Clarity:** Very High (single source of truth)

---

## ⚠️ Risks & Mitigation

### Risk 1: Breaking Existing Clients
**Mitigation:**
- Add deprecation warnings before removal
- Monitor logs for 404 errors on old endpoints
- Provide 30-day notice to API consumers
- Implement redirect middleware (HTTP 301) for critical routes

### Risk 2: Incomplete Frontend Updates
**Mitigation:**
- Audit all fetch() calls in frontend
- Search for both hyphenated and underscore patterns
- Update API client libraries
- Run E2E tests on staging

### Risk 3: Third-Party Integrations
**Mitigation:**
- Check for external API consumers (webhooks, partners)
- Review API documentation for published endpoints
- Maintain legacy routes longer if external dependencies exist

---

## 🧪 Testing Strategy

### Pre-Cleanup Tests
1. ✅ Run full test suite (ensure all pass)
2. ✅ Document current route count: `183`
3. ✅ Take database backup
4. ✅ Export Postman collection of all endpoints

### Post-Cleanup Tests (Per Phase)

**Phase 1 (Exact Duplicates):**
- [ ] Test item variant creation (POST `/api/items/<id>/variants`)
- [ ] Test stock receipt deletion (DELETE `/api/stock-receipts/<id>`)
- [ ] Verify no 500 errors in logs
- [ ] Run integration tests

**Phase 2 (Legacy Routes):**
- [ ] Test all hyphenated endpoints return 200
- [ ] Verify underscore endpoints return 404 or 301
- [ ] Update frontend if 404s detected
- [ ] Run E2E test suite

**Phase 3 (UPF Consolidation):**
- [ ] Smoke test all production features
- [ ] Monitor production logs for 404s
- [ ] Performance test (ensure no regression)
- [ ] Security audit (check for exposed internals)

---

## 📝 Implementation Checklist

### Phase 1 - Critical Fixes (Immediate)
- [ ] **Fix #1:** Remove duplicate GET route for item variants (line 1574)
- [ ] **Fix #2:** Remove or conditionalize stock receipt stub (stubs.py:120)
- [ ] Run pytest suite
- [ ] Deploy to staging
- [ ] Smoke test in staging
- [ ] Deploy to production
- [ ] Monitor logs for 24 hours

### Phase 2 - Legacy Removal (Sprint 12)
- [ ] Add deprecation logging to all underscore routes
- [ ] Monitor logs for 2 weeks
- [ ] Update internal frontend to use hyphenated routes
- [ ] Search for external consumers
- [ ] Remove underscore route decorators (34 lines)
- [ ] Update API documentation
- [ ] Run full test suite
- [ ] Deploy with release notes mentioning deprecations

### Phase 3 - UPF Consolidation (Q1 2026)
- [ ] Audit frontend for `/api/*` vs `/api/upf/*` usage
- [ ] Create migration script for URL updates
- [ ] Implement redirect middleware for legacy routes
- [ ] Update all frontends to use UPF routes
- [ ] Remove legacy `/api/*` variants
- [ ] Update Swagger/OpenAPI docs
- [ ] Performance benchmark
- [ ] Deploy with major version bump

---

## 💡 Recommendations

### DO:
✅ Start with Phase 1 (critical exact duplicates) immediately  
✅ Add logging to track legacy route usage before removal  
✅ Update documentation to reflect canonical routes  
✅ Use HTTP 301 redirects during deprecation period  
✅ Communicate changes to API consumers  

### DON'T:
❌ Remove routes without monitoring usage first  
❌ Break compatibility without deprecation warnings  
❌ Skip testing on staging environment  
❌ Forget to update frontend code  
❌ Remove routes during peak traffic hours  

---

## 📞 Next Steps

1. **Review this strategy** with team
2. **Get approval** for Phase 1 execution
3. **Schedule** Phase 1 implementation (1-2 hours)
4. **Plan** Phase 2 for next sprint
5. **Estimate** Phase 3 effort for Q1 2026 roadmap

---

**Report Prepared By:** Enhanced Project Auditor v3.0  
**Reviewed By:** [Pending]  
**Approved By:** [Pending]  
**Implementation Owner:** [Assign]
