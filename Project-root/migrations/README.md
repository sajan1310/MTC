# Database Migrations

This directory contains all database migration scripts for the MTC Inventory Management System.

## Schema Initialization

### `init_schema.sql`

**Purpose**: Creates all core database tables required for the application to run.

**Tables Created**:
- User Management: `users`
- Master Data: `model_master`, `variation_master`, `color_master`, `size_master`, `item_category_master`, `item_type_master`, `item_brand_master`
- Inventory: `item_master`, `item_variant`
- Supplier Management: `suppliers`, `supplier_contacts`, `supplier_item_rates`
- Purchase Orders: `purchase_orders`, `purchase_order_items`
- Stock Management: `stock_entries`, `stock_receipts`
- System: `schema_migrations`

**Usage**:

For local development:
```bash
psql -h localhost -U postgres -d your_database -f migrations/init_schema.sql
```

For CI/CD (already integrated):
```bash
psql "postgresql://testuser:testpass@127.0.0.1:5432/testdb" -f Project-root/migrations/init_schema.sql
```

## Python Migrations

After running `init_schema.sql`, you can apply incremental Python migrations using:

```bash
python migrations/migrations.py
```

This will:
1. Create a `schema_migrations` table (if not exists)
2. Discover all `migration_*.py` files
3. Apply them in alphabetical order
4. Track applied migrations to avoid duplicates

## Migration Files

All Python migration files follow the pattern: `migration_<description>.py`

Each migration file must have:
- `upgrade()` function - applies the migration
- `downgrade()` function - reverts the migration

Example:
```python
def upgrade():
    with get_conn() as (conn, cur):
        cur.execute("ALTER TABLE items ADD COLUMN new_field VARCHAR(255);")
        conn.commit()

def downgrade():
    with get_conn() as (conn, cur):
        cur.execute("ALTER TABLE items DROP COLUMN new_field;")
        conn.commit()
```

## CI/CD Integration

The GitHub Actions workflow (`.github/workflows/ci.yml`) automatically:

1. **Creates test databases**: `testdb` and `testuser`
2. **Initializes schema**: Runs `init_schema.sql` on both databases
3. **Runs tests**: Executes test suite with initialized schema

This ensures all tests have access to the required database structure.

## Troubleshooting

### "relation does not exist" errors

If you see errors like:
- `relation "users" does not exist`
- `relation "item_master" does not exist`

**Solution**: Run `init_schema.sql` to create the base schema:
```bash
psql -U your_user -d your_database -f migrations/init_schema.sql
```

### Migration tracking issues

To reset migration tracking (⚠️ WARNING: This doesn't undo migrations):
```sql
DELETE FROM schema_migrations WHERE version = 'migration_name';
```

To see applied migrations:
```sql
SELECT * FROM schema_migrations ORDER BY applied_at DESC;
```

## Order of Operations

**For a fresh database**:
1. Run `init_schema.sql` (creates base tables)
2. Run `python migrations/migrations.py` (applies incremental changes)
3. Application is ready to use

**For existing database**:
- Just run `python migrations/migrations.py` to apply new migrations
- The script automatically skips already-applied migrations

## Best Practices

1. **Always test migrations locally** before committing
2. **Write downgrade functions** for reversibility
3. **Use transactions** in migration scripts
4. **Document complex migrations** with inline comments
5. **Test in CI/CD** - migrations run automatically in workflows
