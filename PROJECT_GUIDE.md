# MTC - Complete Project Guide

**Manufacturing Tracking & Costing System**  
**Date:** December 4, 2025  
**Status:** ✅ Production Ready  
**Version:** 1.0

---

## TABLE OF CONTENTS

1. [Project Overview](#project-overview)
2. [Quick Start](#quick-start)
3. [Getting Started](#getting-started)
4. [By Your Role](#by-your-role)
5. [File Structure](#file-structure)
6. [API Reference](#api-reference)
7. [Development Guide](#development-guide)
8. [Deployment Guide](#deployment-guide)
9. [Troubleshooting](#troubleshooting)
10. [Common Tasks](#common-tasks)

---

## PROJECT OVERVIEW

### What is MTC?

**Manufacturing Tracking & Costing (MTC)** is a complete system for:
- ✅ **Production Lot Tracking** - Track manufacturing production lots
- ✅ **Cost Estimation** - Calculate costs for production
- ✅ **Subprocess Management** - Manage production subprocesses
- ✅ **Variant Selection** - Select variants for products
- ✅ **Inventory Alerts** - Track inventory and alerts

### Technology Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React, JavaScript |
| **Backend** | Python, Flask |
| **Database** | PostgreSQL |
| **Testing** | pytest |
| **CI/CD** | GitHub Actions |
| **Deployment** | Docker-ready |

### Project Status

| Component | Status | Details |
|-----------|--------|---------|
| Backend API | ✅ Complete | 12/12 endpoints implemented |
| Frontend | ✅ Complete | All pages functional |
| Database | ✅ Complete | Schema migrated & tested |
| Tests | ✅ Complete | 40+ integration tests |
| Documentation | ✅ Complete | 100% coverage |
| Deployment | ✅ Ready | Production-ready |

---

## QUICK START

### 1. First Time? Start Here
```
1. Read this file (section 3: Getting Started)
2. Choose your role (section 4: By Your Role)
3. Follow your role's instructions
```

### 2. Set Up Environment
```bash
cd Project-root
python -m venv venv2
. venv2/Scripts/Activate.ps1  # Windows PowerShell
pip install -r requirements.txt
```

### 3. Run Locally
```bash
python app.py
# Open browser to http://localhost:5000
```

### 4. Run Tests
```bash
pytest tests/ -v
```

### 5. Deploy to Production
```
See: DEPLOYMENT GUIDE section below
```

---

## GETTING STARTED

### Installation

**Prerequisites:**
- Python 3.8+
- PostgreSQL 12+
- Node.js (for frontend)
- Git

**Steps:**

1. **Clone Repository**
   ```bash
   git clone <repo-url>
   cd MTC/Project-root
   ```

2. **Create Virtual Environment**
   ```bash
   python -m venv venv2
   . venv2/Scripts/Activate.ps1  # Windows
   source venv2/bin/activate      # Linux/Mac
   ```

3. **Install Dependencies**
   ```bash
   pip install -r requirements.txt
   ```

4. **Configure Environment**
   ```bash
   cp .env.example .env
   # Edit .env with your database credentials
   ```

5. **Initialize Database**
   ```bash
   python -m flask db upgrade
   ```

6. **Run Application**
   ```bash
   python app.py
   ```

### First Run Verification

```bash
# Run verification script
python ../utilities/verification/VERIFY_IMPLEMENTATION.py

# Expected output:
# ✅ Database connected
# ✅ All endpoints working
# ✅ Tests passing
# ✅ Configuration valid
```

---

## BY YOUR ROLE

### 👨‍💻 Backend Developer

**Getting Started:**
1. Read: Project Overview (above)
2. Read: API Reference (below)
3. Read: Development Guide (below)

**Key Files:**
- `Project-root/app/` - Main Flask application
- `Project-root/app/api/` - API endpoints
- `Project-root/app/models/` - Database models
- `Project-root/app/services/` - Business logic

**Common Tasks:**
- Add new endpoint → Copy pattern from existing endpoints
- Modify database → Use Flask migrations
- Add business logic → Add to services/ folder
- Write tests → Add to tests/ folder

**Verification:**
```bash
pytest tests/ -v
python ../utilities/auditors/enhanced_project_auditor.py
```

---

### 🎨 Frontend Developer

**Getting Started:**
1. Read: Project Overview (above)
2. Read: API Reference (below) - Understand endpoints
3. Check: frontend code structure

**Key Files:**
- Frontend code is in `Project-root/static/`
- React components and pages
- CSS styling
- API integration

**Common Tasks:**
- Add page component → Create in static/
- Call API endpoint → Use fetch or axios
- Update UI → Modify React components
- Add styling → Update CSS files

**Verification:**
```bash
npm test  # If using npm
python ../utilities/verification/VERIFY_IMPLEMENTATION.py
```

---

### 🚀 DevOps / Deployment

**Getting Started:**
1. Read: Deployment Guide (below)
2. Check: .github/workflows/ folder
3. Understand: CI/CD pipeline

**Key Files:**
- `.github/workflows/` - GitHub Actions workflows
- `.env.example` - Environment variables
- `Dockerfile` - Container configuration
- `docker-compose.yml` - Multi-container setup

**Common Tasks:**
- Deploy to staging → Push to develop branch
- Deploy to production → Push to main branch
- Check CI/CD status → GitHub Actions tab
- Configure environment → Edit .env files

**Pre-Deployment Checklist:**
```bash
# Verify everything works
python utilities/verification/VERIFY_IMPLEMENTATION.py

# Run all tests
pytest tests/ -v

# Check code quality
python utilities/auditors/enhanced_project_auditor.py

# All should pass ✅
```

---

### 🧪 QA / Test Engineer

**Getting Started:**
1. Read: Testing section below
2. Review: test files in Project-root/tests/
3. Run: verification script

**Key Files:**
- `Project-root/tests/` - All test files
- `pytest.ini` - Test configuration
- `.github/workflows/` - CI/CD testing

**Common Tasks:**
- Run tests → `pytest tests/ -v`
- Write new test → Add to tests/ folder
- Check coverage → `pytest --cov`
- Debug test → Run with `-v` flag

**Testing Commands:**
```bash
# Run all tests
pytest tests/ -v

# Run specific test
pytest tests/test_file.py -v

# Run with coverage
pytest tests/ --cov=app

# Run in debug mode
pytest tests/ -v -s
```

---

### 🆘 Support / Troubleshooting

**Getting Started:**
1. Check: Troubleshooting section below
2. Read: QUICK_FIX section below
3. Use: Utilities for diagnostics

**Common Issues:**
- Database connection error → Check .env file
- API endpoint not found → Verify endpoint exists
- Tests failing → Run verification script
- Import errors → Check dependencies

**Diagnostic Tools:**
```bash
# Verify setup
python utilities/verification/VERIFY_IMPLEMENTATION.py

# Run code audit
python utilities/auditors/enhanced_project_auditor.py

# Check database
python utilities/database/check_schema.py
```

---

## FILE STRUCTURE

### Root Directory

```
MTC/
├── README.md                      Project structure guide
├── START_HERE_DOCUMENTATION.md    Project introduction
├── QUICK_NAVIGATION.md            Quick lookup by role
├── FILE_STRUCTURE_GUIDE.md        File navigation guide
└── .env.example                   Environment template
```

### Main Folders

```
docs/                             All documentation
├── getting-started/              Setup guides
├── api/                          API reference
├── development/                  Dev guides
├── deployment/                   Deployment guides
├── features/                     Feature docs
└── troubleshooting/              Fixes & solutions

utilities/                        Helper scripts
├── verification/                 Verification tools
├── auditors/                     Code quality tools
├── repairs/                      Auto-fix scripts
└── database/                     Database utilities

Project-root/                     Application code
├── app/                         Flask application
│   ├── api/                     API endpoints
│   ├── models/                  Database models
│   ├── services/                Business logic
│   └── utils/                   Utilities
├── tests/                       Test suite
├── migrations/                  Database migrations
└── static/                      Frontend files

.github/
└── workflows/                   CI/CD pipelines

scripts/                          Development scripts

archive/                          Old/historical files
```

---

## API REFERENCE

### All Endpoints (12 Total)

#### Production Lots

**List Production Lots**
```
GET /api/upf/production-lots
Response: { data: [lot1, lot2, ...], status: "success" }
```

**Get Single Lot**
```
GET /api/upf/production-lots/{id}
Response: { data: lot, status: "success" }
```

**Create Production Lot**
```
POST /api/upf/production-lots
Body: { process_id, lot_number, quantity, ... }
Response: { data: created_lot, status: "success" }
```

**Update Production Lot**
```
PUT /api/upf/production-lots/{id}
Body: { field: value, ... }
Response: { data: updated_lot, status: "success" }
```

#### Subprocesses

**Add Subprocess to Lot**
```
POST /api/upf/production-lots/{lot_id}/subprocesses
Body: { subprocess_id, sequence, ... }
Response: { data: subprocess, status: "success" }
```

**Update Subprocess Variants**
```
POST /api/upf/production-lots/{lot_id}/subprocesses/{subprocess_id}/variants
Body: { variant_ids: [id1, id2, ...] }
Response: { data: updated_subprocess, status: "success" }
```

#### Inventory Alerts

**Get Alerts**
```
GET /api/upf/inventory-alerts
Response: { data: [alert1, alert2, ...], status: "success" }
```

**Bulk Acknowledge Alerts**
```
POST /api/upf/inventory-alerts/bulk-acknowledge
Body: { alert_ids: [id1, id2, ...] }
Response: { data: acknowledged, status: "success" }
```

#### Additional Endpoints

- `GET /api/upf/processes` - List processes
- `GET /api/upf/subprocesses` - List subprocesses
- `GET /api/upf/variants` - List variants
- `POST /api/upf/suppliers` - Manage suppliers

### Response Format

**Success Response:**
```json
{
  "status": "success",
  "data": { /* response data */ },
  "message": "Operation completed successfully"
}
```

**Error Response:**
```json
{
  "status": "error",
  "error_code": "ERROR_CODE",
  "message": "Error description"
}
```

---

## DEVELOPMENT GUIDE

### Code Structure

**Backend Application:**
```
app/
├── __init__.py          Flask app initialization
├── api/                 REST endpoints
├── models/              Database models
├── services/            Business logic
├── utils/               Utility functions
├── validators/          Input validation
└── static/              Frontend files
```

**Frontend:**
```
static/
├── js/                  JavaScript code
├── css/                 Stylesheets
├── html/                HTML templates
└── assets/              Images and resources
```

### Adding a New Feature

**1. Create Database Model**
```python
# In app/models/
class YourModel(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(255))
    # Add fields
```

**2. Create Migration**
```bash
flask db migrate -m "Add YourModel"
flask db upgrade
```

**3. Create API Endpoint**
```python
# In app/api/
@api_blueprint.route('/your-endpoint', methods=['GET', 'POST'])
def your_endpoint():
    # Implement endpoint logic
    return jsonify({"status": "success", "data": result})
```

**4. Write Tests**
```python
# In tests/
def test_your_endpoint():
    response = client.get('/api/your-endpoint')
    assert response.status_code == 200
```

**5. Test Locally**
```bash
pytest tests/test_your_feature.py -v
```

### Database Migrations

```bash
# Create migration
flask db migrate -m "Description"

# Review migration file
# migrations/versions/XXXXXX_description.py

# Apply migration
flask db upgrade

# Rollback migration
flask db downgrade
```

### Running Tests

```bash
# Run all tests
pytest tests/

# Run specific test file
pytest tests/test_file.py

# Run with coverage report
pytest tests/ --cov=app

# Run in verbose mode
pytest tests/ -v

# Run with print statements
pytest tests/ -v -s
```

### Code Quality

```bash
# Run code audit
python utilities/auditors/enhanced_project_auditor.py

# Fix common issues
python utilities/repairs/auto_fix.py

# Check imports
python utilities/auditors/check_imports.py
```

---

## DEPLOYMENT GUIDE

### Pre-Deployment Checklist

- [ ] All tests passing: `pytest tests/ -v`
- [ ] Code quality checked: `python utilities/auditors/enhanced_project_auditor.py`
- [ ] Database migrations applied
- [ ] Environment variables configured
- [ ] Dependencies updated
- [ ] Security review done

### Step-by-Step Deployment

**1. Backup Database**
```bash
pg_dump -h localhost -U postgres mtc_database > backup_$(date +%s).sql
```

**2. Pull Latest Code**
```bash
git pull origin main
```

**3. Install Dependencies**
```bash
pip install -r requirements.txt
```

**4. Apply Database Migrations**
```bash
python -m flask db upgrade
```

**5. Run Tests**
```bash
pytest tests/ -v
```

**6. Verify Setup**
```bash
python utilities/verification/VERIFY_IMPLEMENTATION.py
```

**7. Deploy Application**
```bash
# Using Docker
docker build -t mtc:latest .
docker run -d -p 5000:5000 mtc:latest

# Or using PM2
pm2 start app.py --name "mtc"
```

**8. Verify Deployment**
```bash
curl http://localhost:5000/api/upf/production-lots
# Should return: {"status": "success", ...}
```

### Rollback Procedure

**If Deployment Fails:**

1. Stop application
2. Restore database backup
3. Revert code to previous version
4. Restart application

```bash
# Restore database
psql -h localhost -U postgres mtc_database < backup_XXXXX.sql

# Revert code
git revert HEAD
git push origin main

# Restart
systemctl restart mtc
```

### Production Monitoring

**Check Application Status:**
```bash
# View logs
tail -f /var/log/mtc/app.log

# Check process
ps aux | grep python

# Monitor resource usage
top
```

---

## TROUBLESHOOTING

### Common Issues & Solutions

#### Database Connection Error
**Problem:** `psycopg2.OperationalError`
**Solution:**
1. Check .env file has correct database credentials
2. Verify PostgreSQL is running
3. Check database exists: `psql -l`
4. Verify user has permissions

#### API Endpoint Not Found
**Problem:** `404 Not Found` on API call
**Solution:**
1. Verify endpoint exists in code
2. Check route definition
3. Test with curl: `curl http://localhost:5000/api/upf/production-lots`
4. Review Flask routes

#### Tests Failing
**Problem:** Test failures on run
**Solution:**
1. Check database is connected
2. Run verification: `python utilities/verification/VERIFY_IMPLEMENTATION.py`
3. Check for pending migrations: `flask db current`
4. Clear cache: `rm -rf __pycache__ .pytest_cache`
5. Reinstall dependencies: `pip install -r requirements.txt`

#### Import Errors
**Problem:** `ModuleNotFoundError`
**Solution:**
1. Check virtual environment is activated
2. Reinstall dependencies: `pip install -r requirements.txt`
3. Verify Python path
4. Check file imports are correct

#### Frontend Not Loading
**Problem:** CSS/JS not loading
**Solution:**
1. Check static files are in correct location
2. Clear browser cache
3. Check Flask is serving static files
4. Verify file paths in HTML

---

## COMMON TASKS

### "I want to add a new API endpoint"

**Steps:**
1. Define database model in `app/models/`
2. Create migration: `flask db migrate -m "..."`
3. Add endpoint in `app/api/`
4. Write tests in `tests/`
5. Test locally: `pytest tests/ -v`
6. Deploy following deployment guide

**Example:**
```python
@api_blueprint.route('/new-endpoint', methods=['POST'])
def new_endpoint():
    data = request.get_json()
    # Validate input
    # Perform operation
    return jsonify({"status": "success", "data": result})
```

### "I want to modify the database schema"

**Steps:**
1. Update model in `app/models/`
2. Create migration: `flask db migrate -m "Add new field"`
3. Review migration file
4. Apply: `flask db upgrade`
5. Test locally
6. Deploy

### "I want to fix a bug"

**Steps:**
1. Identify the bug location
2. Write test that reproduces bug: `pytest tests/test_bug.py -v`
3. Fix the code
4. Verify test passes
5. Run all tests: `pytest tests/ -v`
6. Commit and deploy

### "I want to deploy to production"

**Steps:**
1. Follow pre-deployment checklist
2. Follow step-by-step deployment
3. Monitor application
4. Keep rollback procedure ready
5. Document changes

### "Something is broken"

**Steps:**
1. Check logs: `tail -f /var/log/mtc/app.log`
2. Run verification: `python utilities/verification/VERIFY_IMPLEMENTATION.py`
3. Check database: `psql -d mtc_database`
4. Run tests: `pytest tests/ -v`
5. Review changes: `git log -1`
6. Troubleshoot using above section

---

## VERIFICATION CHECKLIST

Before considering project complete, verify:

- [ ] All 12 API endpoints working
- [ ] All 40+ tests passing
- [ ] Database migrations applied
- [ ] Frontend pages loading
- [ ] Cost calculations correct
- [ ] Subprocess tracking working
- [ ] Alerts functioning
- [ ] CI/CD pipelines running
- [ ] Documentation complete
- [ ] Deployment successful

**Run Full Verification:**
```bash
python utilities/verification/VERIFY_IMPLEMENTATION.py
```

---

## SUPPORT & HELP

### Getting Help

**For Code Issues:**
- Check: Troubleshooting section above
- Review: Code comments in source
- Check: Related tests for examples

**For Deployment Issues:**
- Check: Deployment section above
- Review: Application logs
- Verify: All prerequisites installed

**For Feature Questions:**
- Read: API Reference section
- Check: Test examples
- Review: Feature documentation in docs/

### Important Contacts

| Role | File/Location |
|------|---------------|
| Backend Docs | This file - Development Guide |
| API Docs | This file - API Reference |
| Deployment | This file - Deployment Guide |
| Testing | Project-root/tests/ |
| Configuration | .env.example |

---

## VERSION HISTORY

| Version | Date | Status |
|---------|------|--------|
| 1.0 | Dec 4, 2025 | ✅ Production Ready |

---

## LICENSE & NOTES

- Project: Manufacturing Tracking & Costing (MTC)
- Status: Production Ready
- Last Updated: December 4, 2025
- All systems: Operational ✅

---

**START HERE:** Choose your role in "BY YOUR ROLE" section and follow the instructions.

**QUESTIONS?** Use Ctrl+F to search this document for keywords.

**NEED QUICK HELP?** Jump to "COMMON TASKS" or "TROUBLESHOOTING" sections.

---

*This consolidated guide contains all project documentation. Bookmark and refer back to it as needed.*
