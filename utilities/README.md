# 🔧 Utilities & Tools

**Helper scripts and utilities for development and verification**

---

## 📋 What's Here

```
utilities/
├── verification/        ← Verify setup works
├── auditors/           ← Code quality analysis
├── repairs/            ← Auto-fix scripts
└── database/           ← Database utilities
```

---

## ⚡ Quick Access

### Verify Installation
```bash
python utilities/verification/VERIFY_IMPLEMENTATION.py
```
- Checks all dependencies
- Verifies database setup
- Tests endpoints
- Confirms everything works

### Run Code Audit
```bash
python utilities/auditors/enhanced_project_auditor.py
```
- Analyzes code quality
- Finds issues
- Suggests improvements

### Database Tools
```bash
# Location: utilities/database/
# Check what's available
```

---

## 🛠️ Utility Types

### 1. Verification Scripts
**Purpose:** Verify setup and configuration

**Use when:**
- After installation
- After deployment
- Before committing code
- Troubleshooting issues

**Location:** `utilities/verification/`

### 2. Auditors
**Purpose:** Check code quality and issues

**Use when:**
- Code review
- Before production
- Debugging problems
- Optimizing performance

**Location:** `utilities/auditors/`

### 3. Repair Scripts
**Purpose:** Auto-fix common issues

**Use when:**
- Quick fixes needed
- Test data missing
- Schema needs repair

**Location:** `utilities/repairs/`

### 4. Database Utilities
**Purpose:** Database management and testing

**Use when:**
- Database setup
- Migrations
- Data validation
- Performance testing

**Location:** `utilities/database/`

---

## 📊 Commonly Used Tools

| Tool | Purpose | Command |
|------|---------|---------|
| VERIFY_IMPLEMENTATION.py | Verify setup | `python utilities/verification/VERIFY_IMPLEMENTATION.py` |
| enhanced_project_auditor.py | Code audit | `python utilities/auditors/enhanced_project_auditor.py` |
| verify_production_lot_fixes.py | Test production lots | `python utilities/verification/verify_production_lot_fixes.py` |

---

## ✅ Running Verification

```bash
# 1. Verify everything works
python utilities/verification/VERIFY_IMPLEMENTATION.py

# Expected output:
# ✅ Database connected
# ✅ All endpoints working
# ✅ Tests passing
# ✅ Configuration valid
```

---

## 🐛 Troubleshooting Tools

### When Database Issues Occur
```bash
# Check database utilities
ls utilities/database/
```

### When Tests Fail
```bash
# Use verification script
python utilities/verification/VERIFY_IMPLEMENTATION.py
```

### When Code Quality Issues
```bash
# Run auditor
python utilities/auditors/enhanced_project_auditor.py
```

---

## 📚 Related Documentation

See `../docs/troubleshooting/` for:
- Common issues
- Quick fixes
- Error codes
- FAQ

---

## 💡 Pro Tips

- Run verification after every major change
- Use auditor before code review
- Keep utility scripts updated
- Check logs in `logs/` folder
- Archive old utility results to `../archive/`

---

**Need help?** Check `../docs/troubleshooting/QUICK_FIX_GUIDE.md`
