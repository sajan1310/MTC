# Quick Test Setup & Run Guide

## Prerequisites
- PostgreSQL installed and running
- Python 3.10+ with dependencies installed

## One-Time Setup

### Create Test Database
```powershell
# Windows PowerShell
psql -U postgres -c "CREATE DATABASE testuser;"
```

### Optional: Initialize Schema
```powershell
# If you have migrations
psql -U postgres -d testuser -f Project-root/migrations/init_schema.sql
```

## Running Tests

### Quick Test Run
```powershell
cd Project-root
pytest -v
```

### Test Specific Module
```powershell
# Test integration flows
pytest tests/test_integration_flows.py -v

# Test authentication
pytest tests/test_auth.py -v

# Test smoke tests
pytest tests/test_smoke.py -v
```

### Run with Coverage
```powershell
pytest --cov=app --cov-report=term-missing -v
```

### Run Specific Test Class
```powershell
pytest tests/test_integration_flows.py::TestAuthenticationFlows -v
pytest tests/test_integration_flows.py::TestProcessManagement -v
```

### Run Specific Test
```powershell
pytest tests/test_integration_flows.py::TestAuthenticationFlows::test_login_endpoint_exists -v
```

## Common Issues & Solutions

### Issue: Database Connection Error
```
Error: could not connect to server
```
**Solution:**
- Ensure PostgreSQL is running
- Check database exists: `psql -U postgres -l`
- Verify credentials in config.py match your PostgreSQL setup

### Issue: Tests Return 302 Redirects
```
AssertionError: assert 302 in [200, 401]
```
**Solution:**
- This is now fixed! The `LOGIN_DISABLED=True` setting bypasses authentication
- Make sure you're using the updated `conftest.py`

### Issue: Missing Database Tables
```
psycopg2.errors.UndefinedTable: relation "users" does not exist
```
**Solution:**
- Run schema initialization:
  ```powershell
  psql -U postgres -d testuser -f Project-root/migrations/init_schema.sql
  ```

## Environment Variables (Optional)

Override test database settings if needed:

```powershell
# PowerShell
$env:TEST_DB_NAME = "testuser"
$env:TEST_DB_HOST = "127.0.0.1"
$env:TEST_DB_USER = "postgres"
$env:TEST_DB_PASS = "your_password"

# Run tests
pytest -v
```

## Useful pytest Options

```powershell
# Show print statements
pytest -v -s

# Stop on first failure
pytest -v -x

# Run last failed tests
pytest --lf

# Show slowest tests
pytest --durations=10

# Generate HTML coverage report
pytest --cov=app --cov-report=html
# Open htmlcov/index.html in browser

# Run tests in parallel (requires pytest-xdist)
pytest -n auto
```

## CI/CD Testing

GitHub Actions automatically runs tests on push/PR. Check workflow status at:
- Main CI Pipeline: `.github/workflows/ci.yml`
- Legacy Tests: `Project-root/.github/workflows/test.yml`

## Quick Verification

Run this command to verify your setup is working:

```powershell
cd Project-root
pytest tests/test_smoke.py -v
```

If smoke tests pass, your setup is correct!

---

**Need Help?** See `TESTING_FIXES_SUMMARY.md` for detailed documentation.
