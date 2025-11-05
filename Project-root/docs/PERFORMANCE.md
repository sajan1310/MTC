# Performance Optimization Guide

> **Audience:** Developers working on database queries, API endpoints, and production deployments.

## Overview

This document covers database performance optimization, query analysis, and best practices for the MTC application. The PostgreSQL database is the primary bottleneck for most operations, so proper indexing and query design are critical.

---

## 1. Current Index Coverage

### Existing Indexes (Audit)

The following indexes are currently deployed via migrations:

#### **Inventory & Items** (`add_indexes.sql`, `migration_add_performance_indexes.py`)
- `idx_item_master_name` → `item_master(name)` — Text search on item names
- `idx_item_master_model` → `item_master(model_id)` — FK lookup for model
- `idx_item_master_variation` → `item_master(variation_id)` — FK lookup for variation
- `idx_item_master_category` → `item_master(category)` — Filter by category
- `idx_item_variant_item_id` → `item_variant(item_id)` — FK lookup from variant to item
- `idx_item_variant_composite` → `item_variant(item_id, color_id, size_id)` — Composite lookup for unique variants
- `idx_item_variant_stock_check` → `item_variant(item_id, opening_stock, threshold)` — Stock level queries

#### **Suppliers & Rates**
- `idx_suppliers_firm_name` → `suppliers(firm_name)` — Supplier name search
- `idx_supplier_item_rates_lookup` → `supplier_item_rates(supplier_id, item_id)` — FK composite lookup
- `idx_supplier_rates_item_supplier` → `supplier_item_rates(item_id, supplier_id)` — Reverse FK composite
- `idx_supplier_rates_unique` → UNIQUE `supplier_item_rates(item_id, supplier_id, effective_date)` — Prevent duplicate rates

#### **Purchase Orders & Stock**
- `idx_purchase_orders_supplier` → `purchase_orders(supplier_id, order_date DESC)` — Filter POs by supplier + date sort
- `idx_po_number` → `purchase_orders(po_number)` — Lookup by PO number
- `idx_po_supplier` → `purchase_orders(supplier_id)` — FK to suppliers
- `idx_po_date` → `purchase_orders(created_at DESC)` — Recent orders sort
- `idx_stock_entries_variant` → `stock_entries(variant_id, entry_date DESC)` — Stock history by variant
- `idx_stock_item_date` → `stock_ledger(item_id, transaction_date DESC)` — Ledger queries

#### **Master Data Lookups**
- `idx_color_master_name` → `color_master(color_name)` — Color name search
- `idx_size_master_name` → `size_master(size_name)` — Size name search
- `idx_model_master_name` → `model_master(model_name)` — Model name search
- `idx_variation_master_name` → `variation_master(variation_name)` — Variation name search

#### **Users & Auth**
- `idx_users_email` → `users(email)` — Login queries
- `idx_users_role` → `users(role)` — Role-based filtering

---

## 2. Recommended Index Candidates

### High Priority (Based on Service Layer Analysis)

The following columns are frequently queried but **not yet indexed**:

#### **Processes & Workflows**
```sql
-- processes table: WHERE clauses filter by status, user, dates
CREATE INDEX CONCURRENTLY idx_processes_status ON processes(status);
CREATE INDEX CONCURRENTLY idx_processes_user ON processes(created_by);
CREATE INDEX CONCURRENTLY idx_processes_date ON processes(created_at DESC);

-- process_subprocesses: JOIN queries always filter by process_id (already has FK index)
-- Consider composite if filtering subprocesses by sequence_order is common:
CREATE INDEX CONCURRENTLY idx_process_subprocesses_composite 
ON process_subprocesses(process_id, sequence_order);
```

#### **Production Lots**
```sql
-- production_lots: WHERE clauses filter by status, user, process_id, dates
CREATE INDEX CONCURRENTLY idx_production_lots_status ON production_lots(status);
CREATE INDEX CONCURRENTLY idx_production_lots_process ON production_lots(process_id);
CREATE INDEX CONCURRENTLY idx_production_lots_user ON production_lots(user_id);
CREATE INDEX CONCURRENTLY idx_production_lots_date ON production_lots(created_at DESC);
CREATE INDEX CONCURRENTLY idx_production_lots_lot_number ON production_lots(lot_number);
```

#### **Subprocesses**
```sql
-- subprocesses: Text search on name, filter by active status
CREATE INDEX CONCURRENTLY idx_subprocesses_name ON subprocesses(name);
CREATE INDEX CONCURRENTLY idx_subprocesses_is_active ON subprocesses(is_active);
```

#### **Variants**
```sql
-- variants: Text search on name, filter by process_id
CREATE INDEX CONCURRENTLY idx_variants_name ON variants(name);
CREATE INDEX CONCURRENTLY idx_variants_process ON variants(process_id);
```

#### **Cost Items**
```sql
-- cost_items: JOIN queries filter by subprocess_id, variant_id
CREATE INDEX CONCURRENTLY idx_cost_items_subprocess ON cost_items(subprocess_id);
CREATE INDEX CONCURRENTLY idx_cost_items_variant ON cost_items(variant_id);
```

### Medium Priority (Future Optimization)

- **Audit Log:** `idx_audit_log_user`, `idx_audit_log_date`, `idx_audit_log_entity` for compliance/debugging queries
- **Import Jobs:** `idx_import_jobs_status`, `idx_import_jobs_user`, `idx_import_jobs_date` for job tracking
- **Password Resets:** `idx_password_resets_token`, `idx_password_resets_expiry` for token validation (already may have unique constraint)

---

## 3. Query Analysis with EXPLAIN

### Using EXPLAIN ANALYZE

Run `EXPLAIN ANALYZE` on slow queries to identify bottlenecks:

```sql
EXPLAIN ANALYZE
SELECT * FROM processes
WHERE status = 'active' AND created_by = 123
ORDER BY created_at DESC
LIMIT 20;
```

**Key Metrics to Check:**
- **Seq Scan** vs **Index Scan:** Sequential scans read the entire table (slow); index scans are fast.
- **Execution Time:** Total time in milliseconds.
- **Rows:** Estimated vs actual rows read.
- **Buffers:** Disk I/O vs shared buffer hits (cached reads are fast).

**Example Output Interpretation:**

```
Seq Scan on processes  (cost=0.00..180.50 rows=10 width=512) (actual time=0.123..12.456 rows=8 loops=1)
  Filter: ((status = 'active') AND (created_by = 123))
  Rows Removed by Filter: 4523
Planning Time: 0.234 ms
Execution Time: 12.789 ms
```

**Problem:** Sequential scan + 4523 rows filtered → add `idx_processes_status` and `idx_processes_user`.

**After Index:**
```
Index Scan using idx_processes_status on processes  (cost=0.29..8.31 rows=1 width=512) (actual time=0.012..0.034 rows=8 loops=1)
  Index Cond: (status = 'active')
  Filter: (created_by = 123)
Planning Time: 0.078 ms
Execution Time: 0.045 ms
```

**Result:** 280x faster (12.789ms → 0.045ms).

---

### Common Query Patterns to EXPLAIN

#### 1. List Processes with Filters
```sql
EXPLAIN ANALYZE
SELECT id, name, status, created_at 
FROM processes
WHERE status IN ('active', 'draft') 
  AND created_by = :user_id
ORDER BY created_at DESC
LIMIT 20 OFFSET 0;
```

**Expected:** Index scan on `idx_processes_status` or `idx_processes_user`.

#### 2. Load Production Lot with JOIN
```sql
EXPLAIN ANALYZE
SELECT 
    pl.*,
    p.name as process_name,
    u.name as created_by
FROM production_lots pl
JOIN processes p ON p.id = pl.process_id
JOIN users u ON u.id = pl.user_id
WHERE pl.id = :lot_id;
```

**Expected:** Index scan on `production_lots.pkey`, nested loop joins using FK indexes.

#### 3. Search Items by Name
```sql
EXPLAIN ANALYZE
SELECT id, name, model_id 
FROM item_master
WHERE name ILIKE '%shirt%'
LIMIT 50;
```

**Expected:** Seq scan (ILIKE with leading wildcard can't use index). Consider full-text search with `tsvector` for large datasets.

#### 4. Get Subprocess Costs
```sql
EXPLAIN ANALYZE
SELECT ci.subprocess_id, SUM(ci.cost) as total_cost
FROM cost_items ci
WHERE ci.variant_id = :variant_id
GROUP BY ci.subprocess_id;
```

**Expected:** Index scan on `idx_cost_items_variant` (if created).

---

## 4. Query Optimization Best Practices

### Avoid N+1 Queries

**Bad:**
```python
processes = get_all_processes()  # 1 query
for process in processes:
    subprocesses = get_subprocesses(process['id'])  # N queries
```

**Good:**
```python
processes = get_all_processes()  # 1 query
process_ids = [p['id'] for p in processes]
subprocesses = get_subprocesses_bulk(process_ids)  # 1 query with WHERE IN
# Group subprocesses by process_id in Python
```

**Better (for Flask/SQLAlchemy):**
Use `joinedload` or `subqueryload` for eager loading relationships.

---

### Use Pagination Efficiently

**Always use LIMIT + OFFSET:**
```sql
SELECT * FROM production_lots
WHERE status = 'active'
ORDER BY created_at DESC
LIMIT 20 OFFSET 40;  -- Page 3 (20 per page)
```

**For large OFFSET values (>10,000 rows), use cursor-based pagination:**
```sql
-- Page 1
SELECT * FROM production_lots
WHERE status = 'active'
ORDER BY created_at DESC, id DESC
LIMIT 20;

-- Page 2 (using last row's created_at and id as cursor)
SELECT * FROM production_lots
WHERE status = 'active'
  AND (created_at, id) < (:last_created_at, :last_id)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

---

### Batch Inserts & Upserts

**Bad:**
```python
for row in csv_rows:
    execute("INSERT INTO items ... VALUES (%s, %s)", row)
```

**Good:**
```python
execute_values(cur, "INSERT INTO items ... VALUES %s", csv_rows)
```

**Upserts (ON CONFLICT):**
```sql
INSERT INTO item_master (name, model_id, category)
VALUES (%s, %s, %s)
ON CONFLICT (name, model_id) DO UPDATE SET category = EXCLUDED.category;
```

---

### Use Connection Pooling

The `database.py` module uses `psycopg2.pool.SimpleConnectionPool` (10 connections). This is sufficient for development; for production:

- **Increase pool size:** `minconn=5, maxconn=20` (adjust based on load)
- **Use PgBouncer:** External connection pooler for thousands of clients
- **Monitor active connections:** `SELECT count(*) FROM pg_stat_activity;`

---

### Index Maintenance

**Check Index Usage:**
```sql
SELECT 
    schemaname,
    tablename,
    indexname,
    idx_scan as index_scans,
    idx_tup_read as tuples_read,
    idx_tup_fetch as tuples_fetched
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
ORDER BY idx_scan ASC;  -- Low scan count = unused index
```

**Drop Unused Indexes:**
```sql
-- If idx_scan = 0 after weeks in production, consider dropping
DROP INDEX CONCURRENTLY idx_unused_example;
```

**Rebuild Bloated Indexes:**
```sql
REINDEX INDEX CONCURRENTLY idx_item_master_name;
```

---

## 5. Production Monitoring

### Key Metrics to Track

1. **Query Performance:**
   - Enable `log_min_duration_statement = 500` in PostgreSQL config (log queries >500ms)
   - Use `pg_stat_statements` extension to track slow queries

2. **Connection Pool Health:**
   - Monitor active vs idle connections: `SELECT state, count(*) FROM pg_stat_activity GROUP BY state;`
   - Alert on pool exhaustion (all connections busy)

3. **Index Hit Ratio:**
   ```sql
   SELECT 
       sum(idx_blks_hit) / nullif(sum(idx_blks_hit + idx_blks_read), 0) AS index_hit_ratio
   FROM pg_statio_user_indexes;
   ```
   - Target: >0.99 (99%+ cache hit ratio)

4. **Table Bloat:**
   - Monitor table/index size growth
   - Run `VACUUM ANALYZE` regularly (autovacuum handles this in production)

---

## 6. Tools & Resources

### Local Analysis
- **pgAdmin:** GUI for EXPLAIN visualizations
- **psql `\d table_name`:** Show table schema + indexes
- **psql `\di`:** List all indexes

### Production Tools
- **New Relic / Datadog APM:** Track slow queries, connection pool metrics
- **pg_stat_statements:** Built-in query performance tracking
- **PgHero:** Open-source dashboard for PostgreSQL health

### Further Reading
- [PostgreSQL EXPLAIN Documentation](https://www.postgresql.org/docs/current/sql-explain.html)
- [Use The Index, Luke!](https://use-the-index-luke.com/) — SQL indexing guide
- [Postgres Performance Tuning](https://wiki.postgresql.org/wiki/Performance_Optimization)

---

## Quick Reference: Index Creation Commands

All index creation should use `CONCURRENTLY` to avoid table locks in production:

```sql
-- Create index without blocking writes
CREATE INDEX CONCURRENTLY idx_table_column ON table_name(column_name);

-- Drop index without blocking writes
DROP INDEX CONCURRENTLY idx_table_column;

-- Check index creation progress
SELECT 
    phase,
    blocks_total,
    blocks_done,
    tuples_total,
    tuples_done
FROM pg_stat_progress_create_index;
```

**Note:** `CONCURRENTLY` cannot run inside a transaction block. Use separate migration scripts for production deployments.

---

**Last Updated:** November 2025  
**Next Steps:** Implement high-priority index candidates in a new migration, measure impact with EXPLAIN ANALYZE.
