# 🚀 Quick Fix Reference - CI/CD Database Initialization

## What Was Fixed

✅ **Problem**: CI/CD tests failing with "relation does not exist" errors  
✅ **Solution**: Added automatic database schema initialization in CI/CD workflow

## Files Created/Modified

### ✨ New Files
1. `Project-root/migrations/init_schema.sql` - Creates all database tables
2. `Project-root/migrations/README.md` - Migration documentation
3. `CI_DATABASE_FIX_SUMMARY.md` - Detailed fix documentation

### 📝 Modified Files
1. `.github/workflows/ci.yml` - Added schema initialization step

## For Developers: Local Setup

### Quick Start (Fresh Database)
```bash
# 1. Create database
createdb mtc_dev

# 2. Initialize schema
psql -U postgres -d mtc_dev -f Project-root/migrations/init_schema.sql

# 3. Run the app
cd Project-root
python app.py
```

### Running Tests Locally
```bash
# 1. Create test database
createdb mtc_test

# 2. Initialize schema
psql -U postgres -d mtc_test -f Project-root/migrations/init_schema.sql

# 3. Run tests
cd Project-root
DATABASE_URL=postgresql://postgres@localhost/mtc_test pytest
```

## What Happens in CI/CD Now

```
1. Setup Python ✓
2. Install Dependencies ✓
3. Wait for PostgreSQL ✓
4. Create Databases (testdb, testuser) ✓
5. ⭐ Initialize Schema (NEW!) ✓
6. Run Tests ✓
```

## Tables Created

The `init_schema.sql` creates these tables:

**Core Tables**:
- `users` - User accounts
- `item_master` - Products/items
- `item_variant` - Item variants (color/size)
- `suppliers` - Supplier information
- `purchase_orders` - Purchase orders

**Master Data**:
- `model_master`, `variation_master`
- `color_master`, `size_master`
- `item_category_master`, `item_type_master`, `item_brand_master`

**Related Tables**:
- `supplier_contacts`, `supplier_item_rates`
- `purchase_order_items`
- `stock_entries`, `stock_receipts`

## Troubleshooting

### "relation does not exist" locally?
```bash
# Run the schema initialization
psql -U postgres -d your_database -f Project-root/migrations/init_schema.sql
```

### Check if tables exist
```sql
SELECT tablename FROM pg_tables WHERE schemaname = 'public';
```

### Reset database (⚠️ destroys all data)
```bash
dropdb your_database
createdb your_database
psql -U postgres -d your_database -f Project-root/migrations/init_schema.sql
```

## Key Features

✅ **Idempotent** - Safe to run multiple times (uses `CREATE TABLE IF NOT EXISTS`)  
✅ **Complete** - Creates all required tables and indexes  
✅ **Documented** - Inline comments explain each section  
✅ **CI/CD Ready** - Automatically runs in GitHub Actions  
✅ **Test Data** - Includes demo users for testing  

## Need Help?

- 📖 Read: `Project-root/migrations/README.md`
- 📋 Details: `CI_DATABASE_FIX_SUMMARY.md`
- 🐛 Issues: Check GitHub Actions logs

---

**Last Updated**: November 6, 2025  
**Status**: ✅ Production Ready
