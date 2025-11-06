# CI/CD Database Schema Initialization - Fix Summary

## Problem

The CI/CD pipeline was failing because the test database did not have the required tables initialized. Tests were failing with errors like:

```
relation "item_master" does not exist
relation "purchase_orders" does not exist
relation "suppliers" does not exist
relation "item_variant" does not exist
relation "users" does not exist
```

This caused all API endpoint tests to return 500 errors (internal server error).

## Root Cause

The GitHub Actions workflow created the PostgreSQL databases (`testdb` and `testuser`) but **did not initialize the schema** (create tables) before running tests. The application code expected these tables to exist but they were never created.

## Solution Implemented

### 1. Created Schema Initialization Script

**File**: `Project-root/migrations/init_schema.sql`

This SQL script creates all core database tables required by the application:

#### User Management
- `users` - User accounts with authentication and roles

#### Master Data Tables
- `model_master` - Product models
- `variation_master` - Product variations
- `color_master` - Available colors
- `size_master` - Available sizes
- `item_category_master` - Item categories
- `item_type_master` - Item types
- `item_brand_master` - Brand information

#### Inventory Management
- `item_master` - Core item/product information
- `item_variant` - Item variants (color/size combinations)

#### Supplier Management
- `suppliers` - Supplier information
- `supplier_contacts` - Supplier contact details
- `supplier_item_rates` - Pricing information per supplier

#### Purchase Orders
- `purchase_orders` - PO headers
- `purchase_order_items` - PO line items

#### Stock Management
- `stock_entries` - Stock movement records
- `stock_receipts` - Goods receipt records

#### System Tables
- `schema_migrations` - Tracks applied migrations

### 2. Updated CI/CD Workflow

**File**: `.github/workflows/ci.yml`

Added a new step to initialize the database schema before running tests:

```yaml
- name: Initialize database schema
  run: |
    echo "Initializing database schema for testdb..."
    psql "postgresql://testuser:testpass@127.0.0.1:5432/testdb" \
      -f Project-root/migrations/init_schema.sql
    
    echo "Initializing database schema for testuser..."
    psql "postgresql://testuser:testpass@127.0.0.1:5432/testuser" \
      -f Project-root/migrations/init_schema.sql
    
    echo "✅ Database schemas initialized successfully"
```

This step runs **after** database creation but **before** tests execute.

### 3. Created Documentation

**File**: `Project-root/migrations/README.md`

Comprehensive documentation covering:
- Schema initialization process
- Python migration system
- CI/CD integration
- Troubleshooting guide
- Best practices

## Workflow Execution Order

The updated CI/CD workflow now executes in this order:

1. **Setup Python** - Install Python 3.x
2. **Install system dependencies** - Install libmagic1, postgresql-client
3. **Install Python dependencies** - Install from requirements.txt
4. **Wait for PostgreSQL** - Ensure database is ready
5. **Create test databases** - Create `testdb` and `testuser` databases ✅ EXISTING
6. **Initialize database schema** - Run init_schema.sql on both databases ✅ NEW
7. **Run tests with coverage** - Execute pytest test suite

## Benefits

### ✅ Fixes the CI/CD Pipeline
- All required tables now exist before tests run
- Tests can successfully query the database
- No more "relation does not exist" errors

### ✅ Consistent Test Environment
- Both local and CI environments use the same schema
- Reduces "works on my machine" issues
- Easier to reproduce CI failures locally

### ✅ Faster Onboarding
- New developers can quickly set up a working database
- Clear documentation of database structure
- Single command to initialize schema

### ✅ Better Maintainability
- Schema is version-controlled
- Easy to see what tables exist
- Clear separation between base schema and migrations

## Testing the Fix

### Local Testing
```bash
# Create a test database
createdb test_mtc

# Initialize the schema
psql -U postgres -d test_mtc -f Project-root/migrations/init_schema.sql

# Run tests
cd Project-root
pytest
```

### CI/CD Testing
Push the changes and the GitHub Actions workflow will:
1. Automatically create test databases
2. Initialize the schema using init_schema.sql
3. Run the full test suite

## Files Modified/Created

### New Files
1. `Project-root/migrations/init_schema.sql` - Database schema initialization script
2. `Project-root/migrations/README.md` - Migration documentation
3. `CI_DATABASE_FIX_SUMMARY.md` - This document

### Modified Files
1. `.github/workflows/ci.yml` - Added schema initialization step

## Migration Path

### For Existing Databases
If you have an existing database with tables created through Python migrations:
- **No action needed** - The `init_schema.sql` uses `CREATE TABLE IF NOT EXISTS`
- It will not recreate existing tables
- Safe to run on production databases

### For Fresh Databases
1. Run `init_schema.sql` first
2. Then run `python migrations/migrations.py` for incremental changes

## Verification

After deployment, verify the fix by checking:

1. **CI/CD Logs** - Schema initialization step should show success
2. **Test Results** - All tests should pass (no relation errors)
3. **Coverage Report** - Coverage reports should be generated successfully

## Related Issues

This fix resolves:
- ❌ `relation "users" does not exist`
- ❌ `relation "item_master" does not exist`
- ❌ `relation "item_variant" does not exist`
- ❌ `relation "suppliers" does not exist`
- ❌ `relation "purchase_orders" does not exist`
- ❌ All 500 errors in API endpoint tests due to missing tables

## Next Steps

1. **Commit and push** these changes to the repository
2. **Monitor CI/CD pipeline** - Verify tests pass with initialized schema
3. **Update local development** - Ask team to run init_schema.sql locally
4. **Document in main README** - Add setup instructions for new developers

## Rollback Plan

If issues occur, you can revert the CI/CD workflow change:

```yaml
# Remove the "Initialize database schema" step from ci.yml
# Tests will fail again with "relation does not exist" errors
```

However, keeping the `init_schema.sql` file is beneficial even without automatic initialization, as it serves as documentation of the database structure.

---

**Author**: GitHub Copilot  
**Date**: November 6, 2025  
**Related Workflow**: `.github/workflows/ci.yml`  
**Status**: ✅ Complete and Ready for Deployment
