# SQL Optimization Report — Phase 6 (Data Layer)

Scope: `app/erp/services/*.py` (390 `.execute()` calls), `migrations/erp/001–023`,
`database.py`.

> **Caveat.** No `EXPLAIN ANALYZE` was run and no production row counts or
> `pg_stat_statements` data were available. Findings are structural — patterns
> provable from source that will cost time as data grows. SQL-008 recommends the
> measurement loop needed to prioritise by actual cost.

---

## What is already correct

Stated first because it materially changes how the findings below should be read.

| Practice | Evidence |
|---|---|
| **Parameterised values everywhere** | All 390 `execute()` calls pass values via `%s` placeholders. No user data is ever string-formatted into SQL. |
| **Explicit column lists** | Exactly **1 `SELECT *`** across the whole service layer. |
| **Connection pooling** | `ThreadedConnectionPool` with cores-based sizing (`database.py:57`), broken-connection detection and `putconn(conn, close=True)` on failure (`:138`, `:162`). |
| **Transaction discipline** | `@database.transactional` decorator injects `(conn, cur)` and owns commit/rollback; used on all mutating service functions. |
| **Case-insensitive unique constraints** | 10+ partial unique indexes of the form `ux_erp_*_ci … WHERE deleted_at IS NULL` — exactly the right pattern for soft-deleted, case-insensitive natural keys. |
| **22 expression indexes on `lower(...)`** | Matching the `lower()` predicates the service layer uses. Someone thought about this. |
| **107 index definitions** across the ERP migrations. |

This is a well-built data layer. The findings are about **scaling patterns**, not
correctness or safety.

---

## Findings

| ID | Title | Severity | Priority |
|---|---|---|---|
| SQL-001 | No `LIMIT` anywhere — unbounded result sets by design | Critical | P0 |
| SQL-002 | Full-table scan + Python-side filter instead of `WHERE … = ANY()` | High | P1 |
| SQL-003 | 18 sites of f-string-interpolated SQL identifiers | High | P1 |
| SQL-004 | Row-by-row `UPDATE` loops in rename/propagation paths | High | P1 |
| SQL-005 | 183 `deleted_at IS NULL` predicates, only 3 supporting indexes | Medium | P2 |
| SQL-006 | JSON columns filtered in Python rather than with JSONB operators | Medium | P2 |
| SQL-007 | Legacy migrations target tables outside the `erp` schema | Medium | P2 |
| SQL-008 | No query instrumentation, slow-query log, or `EXPLAIN` in CI | High (process) | P1 |
| SQL-009 | Materialised cache (`erp.warehouse_pool`) fully recomputed on write | Medium | P2 |

---

## SQL-001 · No `LIMIT` anywhere — unbounded result sets by design
**Location** all read methods in `app/erp/services/*.py` · **Severity** Critical · **Priority** P0

**Measured.** 390 `.execute()` calls contain **one `LIMIT`**
(`ledger_audit_service.py:309`). Every `getXData` RPC method returns its entire
table.

**Current behaviour.** `get_po_data()` (`po_service.py:299-303`) fetches all POs,
plus a full billed-quantity aggregate, on every call — and it is called on every
visit to the PO tab (see `PERFORMANCE_AUDIT.md` PERF-003). The client then
displays 15 rows (`core.js:139`, `poRowsPerPage: 15`).

Costs that grow linearly and without bound: rows scanned, tuples materialised,
Python dict construction, JSON serialisation, network bytes, browser memory.

**Expected behaviour.** Push pagination, filtering and sorting into SQL:

```sql
SELECT <explicit cols>
FROM erp.po_headers
WHERE deleted_at IS NULL
  AND (%(q)s IS NULL OR po_number ILIKE %(q)s OR vendor_name ILIKE %(q)s)
ORDER BY po_date DESC, id DESC          -- id tiebreak = stable pagination
LIMIT %(limit)s OFFSET %(offset)s;
```
Return `{rows, total}`, with `total` from a separate `COUNT(*)` over the same
predicate (or a window function if the row count is small enough to make the
extra scan cheap).

**Two implementation notes that matter:**
1. **Always include a unique tiebreaker in `ORDER BY`.** Without it, Postgres may
   return rows in a different order across pages, silently duplicating and
   skipping records.
2. **Prefer keyset ("seek") pagination** over `OFFSET` for the large ledgers.
   `OFFSET 10000` still scans 10,000 rows. `WHERE (po_date, id) < (%s, %s)` does
   not. Worth doing for `getProductionData` and `getBillData` specifically.

**Sort/filter columns must be allowlisted server-side** — map a client token
(`"dateDesc"`) to a fixed SQL fragment. Never interpolate a client string. See SQL-003.

**Effort** L (3–4 wk across six methods), shippable one method at a time.
**Dependencies** paired with `PERFORMANCE_AUDIT.md` PERF-002 client work.
**Business impact** This is the finding that determines whether the system still
performs in three years.

---

## SQL-002 · Full-table scan + Python-side filter instead of `WHERE … = ANY()`
**Location** `process_service.py:177`, `:205`; `bom_service.py:218`;
`clients_service.py:648`, `:655`; plus similar in `items_service.py`, `tags_service.py`
**Severity** High · **Priority** P1

**Description.** A recurring pattern: fetch an entire column, then compare in
Python. From `process_service.py:170-208` (the delete-guard):

```python
requested = {str(p).strip().lower() for p in process_ids}   # usually 1–5 values
...
cur.execute(f"SELECT DISTINCT {col} AS process_id FROM {table} WHERE deleted_at IS NULL")
for row in cur.fetchall():                       # ← every distinct value in the table
    pid = str(row["process_id"] or "").strip().lower()
    if pid in requested:                         # ← filter in Python
        in_use.add(pid)
```

To answer "are any of these 3 process IDs in use?" the database returns every
distinct process ID in the production table, the BOM lines table and the
warehouse-pool-opening table. Three full scans plus three network transfers to
evaluate a 3-element membership test.

**Expected behaviour.** Push the predicate down:

```python
cur.execute(
    f"SELECT DISTINCT lower({col}) AS pid FROM {table} "
    f"WHERE deleted_at IS NULL AND lower({col}) = ANY(%s)",
    (list(requested),),
)
in_use.update(r["pid"] for r in cur.fetchall())
```
With the existing `lower()` expression indexes (22 of them already exist), this
becomes an index lookup returning at most `len(requested)` rows. Add
`EXISTS`-style short-circuiting where only a boolean is needed.

**Performance impact** Turns O(table) into O(input) at every delete-guard and
uniqueness check — and these run on *every* delete and *every* save.
**UX impact** Delete and save latency stops growing with table size.
**Effort** M (1 wk for all sites) · **Risk** Low — pure query rewrite, behaviour
identical, easily covered by the existing service tests.

---

## SQL-003 · 18 sites of f-string-interpolated SQL identifiers
**Location** `process_service.py:177,205,240,1838`; `tags_service.py:172,176,192,226`;
`clients_service.py:648,655`; `contractors_service.py:117,123`;
`dispatch_service.py:546,622,778`; `bom_service.py:218`; `production_service.py:290,302`
**Severity** High · **Priority** P1

**Description.** Table and column names are interpolated into SQL strings:

```python
cur.execute(f"UPDATE {table} SET {column} = %s WHERE id = %s", (renamed, row["id"]))
```

**Assessment — this is not currently exploitable.** The identifiers come from
`config_maps.TABLE_NAMES` / `to_snake_case()`, which are module-level constants
derived from the Apps Script schema (`config_maps.py:26`). No request data
reaches them. **Values are always parameterised.** Rated High for the *absence of
a guardrail*, not for a live vulnerability.

**Why it still needs fixing.** The pattern is indistinguishable, to a reviewer or
a linter, from genuine injection. The moment someone adds a dynamic sort column
(which SQL-001 will require) the same idiom becomes exploitable, and nothing in
the codebase will flag it.

**Expected behaviour.** Use `psycopg2.sql` composition so identifiers are
escaped and the type system enforces the distinction:

```python
from psycopg2 import sql
cur.execute(
    sql.SQL("UPDATE {tbl} SET {col} = %s WHERE id = %s").format(
        tbl=sql.Identifier(*table.split(".")),
        col=sql.Identifier(column),
    ),
    (renamed, row["id"]),
)
```
Then add a lint rule banning f-strings in `execute()` outright. Once
`sql.Identifier` is the only mechanism, the rule has no false positives.

**Security impact** Converts a convention-based guarantee into a
compiler-enforced one — the difference that matters before SQL-001 adds dynamic
sorting. **Effort** S–M (2–3 d) · **Priority: do this before SQL-001.**

---

## SQL-004 · Row-by-row `UPDATE` loops in rename/propagation paths
**Location** `process_service.py:240-257`, `:305-326`; `tags_service.py:172-193`;
plus rename paths in `items_service.py`, `bill_service.py`
**Severity** High · **Priority** P1

**Description.** A genuine N+1. From `process_service.py:305-326` (propagating a
process rename to dispatch lines):

```python
cur.execute(f"""SELECT l.id, l.product_name FROM {dispatch_lines_table} l
                JOIN {dispatch_headers_table} h ON h.id = l.header_id
                WHERE h.deleted_at IS NULL AND l.product_name IS NOT NULL""")
for row in cur.fetchall():                # every dispatch line ever
    ...
    cur.execute(f"UPDATE {dispatch_lines_table} SET product_name = %s WHERE id = %s",
                (updated_name, row["id"]))     # one round trip per matching row
```

Every dispatch line in history is fetched into Python; each match issues its own
`UPDATE`. Inside a transaction, this holds row locks for the full duration.

**Mitigating context, stated fairly:** these are *rename* operations — infrequent
administrative actions, not hot paths. The surrounding comments
(`process_service.py:258-280`) document a real production bug this code fixes,
and the logic is correct. Severity is High because the cost is **unbounded and
transactional**, not because it runs often.

**Expected behaviour.** Single set-based statement:

```sql
UPDATE erp.dispatch_lines l
SET product_name = CASE
      WHEN lower(l.product_name) = lower(%(old)s) THEN %(new)s
      ELSE %(new)s || substring(l.product_name from char_length(%(old)s) + 1)
    END
FROM erp.dispatch_headers h
WHERE h.id = l.header_id
  AND h.deleted_at IS NULL
  AND (lower(l.product_name) = lower(%(old)s)
       OR lower(l.product_name) LIKE lower(%(old)s) || ' / %%');
```
One round trip, one plan, locks held briefly. Where the transform is genuinely
too complex for SQL (the JSON case in SQL-006), batch with
`execute_values` + `UPDATE … FROM (VALUES …)` instead of per-row statements.

**Effort** M (1 wk) · **Risk** Medium — rename correctness is business-critical
and the current code encodes hard-won bug fixes. **Require a test asserting
identical before/after state on a seeded fixture for each rename path before
rewriting.** The existing `tests/erp/` suite gives a foundation.

---

## SQL-005 · 183 `deleted_at IS NULL` predicates, 3 supporting indexes
**Severity** Medium · **Priority** P2

**Measured.** `deleted_at IS NULL` appears **183 times** in the service layer —
it is effectively on every query. Only **3 index definitions** across
`migrations/erp/*.sql` reference `deleted_at`, and those are the `WHERE` clause
of partial *unique* indexes on natural keys, not general-purpose read indexes.

**Consequence.** A query like
`SELECT … FROM erp.production WHERE deleted_at IS NULL ORDER BY production_date DESC`
cannot use a plain `production_date` index efficiently once soft-deleted rows
accumulate — Postgres must filter them after the index scan.

**Expected behaviour.** Make the soft-delete predicate part of the index for the
main read paths:

```sql
CREATE INDEX CONCURRENTLY idx_erp_production_live_date
  ON erp.production (production_date DESC, id DESC)
  WHERE deleted_at IS NULL;
```
Partial indexes here are strictly better than composite ones: they are smaller
(dead rows excluded entirely) and they exactly match the query shape. Apply to
the high-traffic ledgers: `po_headers`, `bill_headers`, `return_headers`,
`production`, `dispatch_headers`, `items`, `stock`.

**Do this in the same change as SQL-001** — the `ORDER BY … LIMIT` introduced
there is precisely what these indexes serve. Use `CREATE INDEX CONCURRENTLY` to
avoid write locks.

**Caveat.** Only worth building where soft-deleted rows are a meaningful fraction
of the table. Measure first (`SELECT count(*) FILTER (WHERE deleted_at IS NOT NULL)`)
rather than adding all seven blind — every index costs write throughput.

**Effort** S (1–2 d) · **Depends on** SQL-008 measurement

---

## SQL-006 · JSON columns filtered in Python rather than with JSONB operators
**Location** `process_service.py:240-257` (`components_consumed`),
`:1838` (`color_breakdown`); `tags_service.py:226`
**Severity** Medium · **Priority** P2

**Description.** `erp.production.components_consumed` holds a JSON array of
component objects. To find lots consuming a given item, the code fetches **every
non-null `components_consumed` value in the table** and iterates the arrays in
Python:

```python
cur.execute(f"SELECT id, components_consumed FROM {table} "
            f"WHERE deleted_at IS NULL AND components_consumed IS NOT NULL")
for row in cur.fetchall():
    for comp in row["components_consumed"] or []:
        if comp.get("sourceType") == "POOL" and comp.get("itemName","").lower() == old.lower():
            ...
```

**Expected behaviour.** If the column is `jsonb` (verify — if it is `json`, migrate),
filter in the database:

```sql
SELECT id, components_consumed
FROM erp.production
WHERE deleted_at IS NULL
  AND components_consumed @> %s::jsonb    -- '[{"sourceType":"POOL","itemName":"X"}]'
```
backed by `CREATE INDEX … USING gin (components_consumed jsonb_path_ops)`.

For the *update* half, `jsonb_set` with a `jsonb_array_elements` subquery can
perform the rewrite in one statement — though this is the one place where the
Python loop may remain more readable. If it stays in Python, at minimum narrow
the `SELECT` with the `@>` predicate above so only affected rows are fetched, and
batch the writes (SQL-004).

**Effort** M · **Depends on** confirming `jsonb` vs `json` column types

---

## SQL-007 · Legacy migrations target tables outside the `erp` schema
**Location** `migrations/006_add_performance_indexes.sql`, `migrations/add_indexes.sql`,
`migrations/add_missing_upf_tables.sql`, `migrations/migration_add_*.py` (~35 files)
**Severity** Medium · **Priority** P2

**Description.** `migrations/` contains two distinct generations:

- `migrations/erp/001–023` — the **current** schema. Ordered, `.sql`, coherent,
  with a runner (`migrations/erp/runner.py`).
- `migrations/*.py` and `migrations/*.sql` at the top level — **~35 files from
  the pre-port application**, targeting tables like
  `production_lot_inventory_alerts`, `upf_production_lots`,
  `subprocess_variants` that do not exist in the current `erp` schema.

`006_add_performance_indexes.sql` creates indexes on `upf_production_lots` — a
table the current application never queries. Running it against a current
database either fails or creates indexes on orphaned tables.

**Risk.** `run_migration.py` at repo root is one of 19 loose scripts; it is not
obvious to a new operator which migration set is authoritative. A wrong
invocation during deployment is a real hazard.

**Expected behaviour.** Move the legacy set to `migrations/_archive/` with a
`README.md` stating it is historical and must not be run. Make
`migrations/erp/runner.py` the single documented entry point. Verify against
`docs/DEPLOYMENT_DOCKER.md` and `DEPLOYMENT.md` and correct any reference.

**Effort** S (1 d) · **Business impact** Removes a deployment footgun.
**Cross-reference** `TECHNICAL_DEBT_REPORT.md` TD-002.

---

## SQL-008 · No query instrumentation, slow-query log, or `EXPLAIN` in CI
**Severity** High (process) · **Priority** P1

`scripts/db_explain.py` exists — a good foundation — but nothing runs it
routinely. There is no `pg_stat_statements`, no `log_min_duration_statement`, no
per-method timing. **Everything above is prioritised by structural reasoning
because no measurement exists to prioritise by cost.**

**Expected behaviour.**
1. `log_min_duration_statement = 200ms` in Postgres config.
2. Enable `pg_stat_statements`; review top-20 by `total_exec_time` weekly.
3. Wrap `database.get_conn` to record per-RPC-method query count and duration
   into the existing logging setup (`logging_config.py`), tagged with the request
   id already provided by `app/middleware/request_id.py`. **A query-count metric
   per method makes N+1 regressions self-reporting.**
4. Wire `scripts/db_explain.py` into CI against a seeded database, failing on
   `Seq Scan` over tables above a row threshold.

**Effort** M (1 wk) · **Do this before SQL-001**, so the pagination work can be
targeted at the methods that actually cost the most.

---

## SQL-009 · Materialised cache recomputed in full on every write
**Location** `process_service.py:330-340` and `warehouse_service.py`
(`_recalculate_warehouse_pool`) · **Severity** Medium · **Priority** P2

`erp.warehouse_pool` is described in-code as "a materialized cache, entirely
rewritten by `_recalculate_warehouse_pool()`". The comment
(`process_service.py:326-338`) explains the trigger correctly — a rename must
force a recompute or the cached bucket keeps the old name.

The concern is cost: a **full** recompute on every mutation that touches pool
inputs, inside the mutation's transaction. As production, dispatch and pool
history grow, every save pays for a full rebuild.

**Expected behaviour.** Options in increasing order of effort:
1. **Scope the recompute** to affected buckets rather than all.
2. **Move to a Postgres materialised view** with `REFRESH MATERIALIZED VIEW
   CONCURRENTLY`, run out-of-band — the `ledger_audit_service` scheduler
   (`app/__init__.py:554`) is an existing home for this.
3. **Incremental maintenance** via triggers on the source tables.

Option 1 is the pragmatic first step. **Do not change this without the
reconciliation tests** — `tests/erp/test_warehouse.py` and
`test_warehouse_composite.py` exist and must be extended first. The in-code
comment documents a production incident where a missed recompute made shipped
goods reappear as available; correctness clearly outranks speed here.

**Effort** M–L · **Risk** High (business-critical correctness) · **Priority P2
deliberately** — do not attempt before SQL-008 shows it is actually costly.

---

## Recommended order

| Order | Item | Effort | Rationale |
|---|---|---|---|
| 1 | **SQL-008** instrumentation | 1 wk | Nothing below should be prioritised without it |
| 2 | **SQL-003** `psycopg2.sql` composition + lint | 2–3 d | Must precede dynamic sorting in SQL-001 |
| 3 | **SQL-007** archive legacy migrations | 1 d | Removes a deployment hazard |
| 4 | **SQL-002** `= ANY()` pushdown | 1 wk | Pure win, low risk, hits every save/delete |
| 5 | **SQL-001 + SQL-005** pagination + partial indexes | 3–4 wk | Removes the scaling ceiling |
| 6 | **SQL-004** set-based renames | 1 wk | Needs regression tests first |
| 7 | **SQL-006** JSONB predicates | 1 wk | After measurement confirms cost |
| 8 | **SQL-009** pool recompute | 2 wk | Highest risk; last, and only if measured |
