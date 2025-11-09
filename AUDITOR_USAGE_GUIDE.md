# Enhanced Project Auditor - Quick Usage Guide

## Overview
The Enhanced Flask Auditor v3.0 performs comprehensive verification of your Universal Process Framework (UPF) implementation against the executive summary requirements.

## How to Run

### Basic Usage
```powershell
python enhanced_project_auditor.py Project-root
```

### With UTF-8 Encoding (Recommended for Windows)
```powershell
$env:PYTHONIOENCODING='utf-8'
python enhanced_project_auditor.py Project-root
```

## What It Audits

### 1. Advanced BOM-Centric Process Architecture (Section 1)
- ✅ Process as BOM root entity
- ✅ Sub-process design and template system
- ✅ Variant/cost/supplier integration
- ✅ User experience and data entry
- ✅ Audit, calculation, and state management

### 2. Production Lot Architecture with Alert System (Section 2)
- ✅ Streamlined lot creation
- ✅ Real-time stock level analysis
- ✅ Alert severity levels (CRITICAL, HIGH, MEDIUM, LOW, OK)
- ✅ Alert display and user interaction
- ✅ Automatic procurement alerts
- ✅ Item requirement sheet generation
- ✅ Lot registration and audit trail
- ✅ Traceable manufacturing operations

### 3. Alert System Technical Architecture (Section 3)
- ✅ Real-time inventory query integration
- ✅ Alert escalation rules
- ✅ Safety stock and reorder points

### 4. Data Flow Overview (Section 4)
- ✅ Inventory system integration
- ✅ Supplier/vendor database
- ✅ Process/BOM library
- ✅ Production lot module with alerts
- ✅ Alert & notification engine
- ✅ Ledger/reporting

### 5. Additional Audits
- Routes & API synchronization
- Database models and migrations
- Test coverage
- Documentation completeness
- Security configuration
- Static asset optimization

## Output Files

### 1. Console Output
Real-time progress with emoji indicators and color-coded sections.

### 2. JSON Report
`enhanced_audit_report.json` - Complete structured audit results including:
- All routes and API calls
- UPF component analysis
- Missing/unused routes
- Database schema verification
- Test and documentation stats

### 3. Summary Document
`UPF_AUDIT_SUMMARY.md` - Human-readable comprehensive report.

## Interpreting Results

### Overall UPF Completeness Score
- **100%** - Full implementation, production-ready ✅
- **90-99%** - Nearly complete, minor gaps
- **80-89%** - Mostly implemented, some features missing
- **< 80%** - Significant implementation required

### Component Scores
Each UPF section receives individual score:
- **Process/BOM Architecture**
- **Production Lot Alerts**
- **Alert Technical Architecture**
- **Data Flow Integration**

### Status Indicators
- ✅ **Yes** - Feature fully implemented
- ❌ **No** - Feature missing or incomplete
- ⚠️ **Warning** - Potential issue requiring attention
- ℹ️ **Info** - Informational message

## Key Metrics

### Routes & API Sync
- **Matched:** Frontend and backend routes properly synchronized
- **Missing Backend:** Frontend calls routes that don't exist (potential errors)
- **Method Mismatches:** Routes exist but HTTP methods don't match
- **Unused Backend:** Backend routes not called from frontend (may be admin/internal)

### Alert System
- **Endpoints:** Number of alert-related API endpoints
- **Services:** Alert service modules
- **Templates:** UI templates for alert display
- **Static Assets:** CSS/JS files for alert functionality
- **Tests:** Test coverage for alert features
- **Documentation:** API and usage documentation

## Troubleshooting

### Issue: Unicode Encoding Errors (Windows)
**Solution:** Set UTF-8 encoding before running:
```powershell
$env:PYTHONIOENCODING='utf-8'
```

### Issue: "Path not found" errors
**Solution:** Run from parent directory of Project-root:
```powershell
cd C:\Users\erkar\OneDrive\Desktop\MTC
python enhanced_project_auditor.py Project-root
```

### Issue: Permission denied writing report
**Solution:** Check file isn't open in another program and you have write permissions.

## Customization

### Adding New Checks
Edit `enhanced_project_auditor.py` and add methods:
1. Create audit method (e.g., `_audit_new_feature()`)
2. Call from `audit_upf_alert_system()`
3. Update `_calculate_upf_completeness()` to include new score

### Modifying Thresholds
Edit these sections:
- Alert severity patterns in `_audit_production_lot_alerts()`
- Required file lists in each audit method
- Completeness calculation weights in `_calculate_upf_completeness()`

## Best Practices

### When to Run Audit
- ✅ After implementing new UPF features
- ✅ Before production deployment
- ✅ After major refactoring
- ✅ Weekly during active development
- ✅ As part of CI/CD pipeline

### Reviewing Results
1. **Check Overall Score** - Quick health indicator
2. **Review Component Scores** - Identify weak areas
3. **Examine Missing Features** - Prioritize implementation
4. **Verify Critical Systems** - Alert system, procurement, audit trail
5. **Address Warnings** - Security issues, missing routes, etc.

## Integration with CI/CD

### GitHub Actions Example
```yaml
name: UPF Audit
on: [push, pull_request]
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - name: Run UPF Audit
        run: |
          python enhanced_project_auditor.py Project-root
          # Fail if completeness < 95%
          python -c "import json; data=json.load(open('Project-root/enhanced_audit_report.json')); exit(0 if data['statistics']['upf_overall_score'] >= 95 else 1)"
```

## Quick Reference Commands

### Full Audit
```powershell
python enhanced_project_auditor.py Project-root
```

### View UPF Score Only
```powershell
python enhanced_project_auditor.py Project-root 2>&1 | findstr "Overall Framework Completeness"
```

### Generate Summary Only
```powershell
python enhanced_project_auditor.py Project-root > /dev/null 2>&1
# Review: UPF_AUDIT_SUMMARY.md
```

### Check for Errors
```powershell
python enhanced_project_auditor.py Project-root 2>&1 | findstr "ERROR"
```

## Understanding the Report Structure

### JSON Report Schema
```json
{
  "audit_timestamp": "ISO datetime",
  "project_root": "path",
  "upf_alert_system": {
    "process_bom_architecture": {
      "completeness": 100,
      "process_as_bom": { "present": true, "files": [...] },
      "subprocess_templates": { ... },
      "variant_cost_supplier": { ... },
      "user_experience": { ... },
      "audit_trail": { ... }
    },
    "production_lot_alerts": { ... },
    "alert_technical": { ... },
    "data_flow_integration": { ... },
    "completeness": {
      "overall_score": 100,
      "process_bom": 100,
      "production_lot_alerts": 100,
      "alert_technical": 100,
      "data_flow": 100
    }
  },
  "statistics": { ... }
}
```

## Support & Maintenance

### Updating Auditor
When UPF requirements change:
1. Update audit methods in `enhanced_project_auditor.py`
2. Update expected file lists
3. Update completeness calculations
4. Re-run full audit
5. Update `UPF_AUDIT_SUMMARY.md` template

### Common False Positives
- **Unused Routes:** Admin/internal routes not called from frontend (normal)
- **Missing Backend Routes:** Dynamic routes with template variables (check normalization)
- **Missing Indexes:** Database may have additional indexes not in migration files

---

**Last Updated:** November 9, 2025  
**Auditor Version:** 3.0  
**Maintainer:** MTC Development Team
