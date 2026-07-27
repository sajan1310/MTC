# Sheets ↔ Postgres migration & nightly backup

Closes the one open gap flagged in `verification-report.md` item 6: there was no
script that bulk-imports the Apps Script spreadsheet's historical rows into the
`erp` Postgres schema. This directory adds that importer, plus a nightly
job that goes the other direction (Postgres → dated Sheets backup) now that
Postgres is the canonical store.

**Status: scaffold, not yet run against real data.** `mapping.yaml` is built
from `app/erp/config_maps.py` and the 20 `migrations/erp/*.sql` files (the
project's actual sources of truth), not from a live spreadsheet — there is no
`Apps_Script/*.js` source checked into this repo to verify column semantics
against. 18 of 26 sheets are marked `status: ready`; 8 are marked
`needs_review` (BOM, BOM_COSTS, CLIENT_ORDERS, DISPATCH, PRODUCTION,
PROCESS_COLOR_LINKS, plus the ITEMS `vendors`-column child mapping) because
they involve a judgment call — JSON cell parsing, FK resolution, or a sheet
column with no obvious DB column. **Get a second pair of eyes on those
specific entries in `mapping.yaml` before trusting them past a dry-run.**

## Files

| File | Purpose |
|---|---|
| `mapping.yaml` | Sheet → table column mapping, one entry per Apps Script tab. Edit this, not the Python, when the mapping needs a fix. |
| `sheets_client.py` | Google Sheets/Drive API auth + fetch/write helpers, shared by both scripts. |
| `transforms.py` | Cell-string → Python value coercion (dates, currency-safe numbers, booleans, JSON). |
| `migrate_sheets_to_pg.py` | Sheets → Postgres. Dry-run by default. |
| `backup_db_to_sheets.py` | Postgres → dated Sheets backup. Meant to run nightly via cron/Cloud Scheduler. |

## Setup

```bash
pip install -r requirements.txt   # adds google-api-python-client + PyYAML

export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
export DATABASE_URL=postgresql://user:pass@localhost:5432/erp_dev   # LOCAL/DEV first
```

The service account needs:
- Sheets API + Drive API enabled on its GCP project.
- The source spreadsheet(s) shared with it (**Viewer** is enough for migration).
- A Drive folder shared with it as **Editor** if you want nightly backups
  filed into a specific folder (`DRIVE_FOLDER_ID`) instead of its own My
  Drive root.

Fill in `default_spreadsheet_id` (or per-sheet `spreadsheet_id`) in
`mapping.yaml`. Any sheet left without one is skipped with a warning, not a
hard failure — useful for bringing sheets online incrementally.

## Step 1 — Dry run (always first, no DB writes)

```bash
python migrate_sheets_to_pg.py --mapping mapping.yaml
```

Reports, per sheet: raw row count, parsed-OK count, parse errors (row +
column + reason), and duplicate `unique_on` keys. Fix everything it flags
before touching `--execute`. Iterate on one sheet at a time with:

```bash
python migrate_sheets_to_pg.py --only ITEMS,VENDORS,STOCK
```

## Step 2 — Load into a **local/dev** Postgres, never production first

```bash
# 1. Snapshot whatever's already there (even a throwaway dev DB — habit matters):
pg_dump -Fc "$DATABASE_URL" -f "pre_migration_$(date +%Y%m%dT%H%M%S).dump"

# 2. Execute. Both flags are required on purpose -- --execute alone is a no-op.
python migrate_sheets_to_pg.py --mapping mapping.yaml \
    --execute --yes-really-truncate
```

What this does:
1. Truncates **only tables in the `erp` schema** (`TRUNCATE ... RESTART IDENTITY CASCADE`,
   scoped via `pg_tables WHERE schemaname = 'erp'`). `public.users` and every
   other `public.*` table (auth, sessions) are never touched — this is
   hard-coded, not a flag. (This deliberately narrows the generic
   "truncate every public table" approach sometimes suggested for this kind
   of job — that shape is wrong for this schema, since `public` holds live
   user accounts alongside the two, separately-tracked pre-existing
   migration systems.)
2. Loads sheets in the dependency-safe order already encoded in
   `mapping.yaml` (masters → process/warehouse → PO/Bill/Return/Wastage/Issue
   → BOM → client orders/dispatch/production).
3. Runs a `fk_resolve` backfill pass (`UPDATE ... FROM ... WHERE lower(x) =
   lower(y)`) to populate soft FK columns (`vendor_id`, `item_id`,
   `contractor_id`, `process_master_id`, `bom_product_id`) by name-matching
   against the just-loaded master tables — same "text is source of truth, FK
   is for joins" precedent the schema itself already uses everywhere.
4. Everything runs in **one transaction**: any error rolls back the whole
   run, so a failed load never leaves the DB half-populated.
5. Fresh serial IDs are generated on every insert (per project decision —
   original Sheet identity is preserved only through business-key text
   columns like `po_number`, not through the Postgres primary key).

## Step 3 — Verify

```sql
-- Row counts per table (compare against the dry-run report's parsed counts)
SELECT 'erp.po_headers', count(*) FROM erp.po_headers
UNION ALL SELECT 'erp.po_lines', count(*) FROM erp.po_lines
UNION ALL SELECT 'erp.items', count(*) FROM erp.items;
-- ... etc for every table you loaded

-- Spot-check a few resolved FKs actually resolved
SELECT po_number, vendor, vendor_id FROM erp.po_headers WHERE vendor_id IS NULL LIMIT 20;
```

A `NULL` `vendor_id`/`item_id`/etc. after the backfill pass means that row's
sheet value didn't case-insensitively match any row in the corresponding
master table — expected for typos/renamed vendors, worth eyeballing before
declaring the load clean.

## Post-load: things this script deliberately does NOT do for you

- **Advance sequences.** `erp.po_number_seq`, `erp.process_id_seq`,
  `erp.product_id_seq`, `erp.dispatch_number_seq`, `erp.order_number_seq` all
  `START WITH 1001` for *new* records generated by the app. If you preserved
  historical numbers higher than 1001 (likely), advance each sequence past
  the max imported value once you've confirmed the app's actual number
  format (e.g. `SELECT setval('erp.po_number_seq', (SELECT max(...) ...))`)
  — the exact numeric-suffix parsing depends on each sequence's real string
  format, which isn't verified in this pass.
- **Recompute `erp.warehouse_pool`.** It's a materialized cache, rewritten
  wholesale by `warehouse_service._recalculate_warehouse_pool()`. After
  loading `WAREHOUSE_POOL_OPENING` + `PRODUCTION` + `DISPATCH`, trigger that
  recompute (call the function directly, or hit whichever RPC/route wraps
  it) before trusting `erp.warehouse_pool`'s numbers.
- **`ANALYZE`** the `erp` schema afterward for the query planner.
- **Restart the app / clear any caches** so it picks up the new data.

## Nightly backup (Postgres → Sheets)

```bash
python backup_db_to_sheets.py --database-url "$DATABASE_URL" \
    --drive-folder-id "$DRIVE_FOLDER_ID"
```

Creates `MTC-backup-YYYY-MM-DD`, one tab per `erp.*` table (including
materialized/cache tables like `erp.warehouse_pool` — a backup should
capture what Postgres actually has, unlike the migration importer which
deliberately skips computed data on the way *in*). Read-only against
Postgres; never writes back.

**Retention**: if `--drive-folder-id`/`DRIVE_FOLDER_ID` is set, deletes
backup spreadsheets older than `--retention-days` (default 90) from that
folder after each run. Skipped (not defaulted to "delete everywhere") if no
folder is set, since there'd be no safe way to scope the deletion query to
"backups this job created" vs. anything else in Drive.

### Scheduling — cron

```cron
# /etc/cron.d/mtc-backup — nightly at 02:00 server time
0 2 * * * mtc  cd /srv/mtc/Project-root/scripts/migration && \
  DATABASE_URL=postgresql://... GOOGLE_APPLICATION_CREDENTIALS=/srv/secrets/sa.json DRIVE_FOLDER_ID=... \
  /srv/mtc/venv/bin/python backup_db_to_sheets.py >> /var/log/mtc/backup.log 2>&1
```

### Scheduling — Google Cloud Scheduler + Cloud Run

1. Containerize this directory (or add it to the existing `Dockerfile` as an
   alternate entrypoint) and deploy as a Cloud Run **Job** (not a Service —
   this isn't HTTP-triggered).
2. Grant the Cloud Run job's service account the Sheets/Drive scopes
   directly (no key file needed inside GCP — use Application Default
   Credentials instead of `GOOGLE_APPLICATION_CREDENTIALS` pointing at a
   checked-in key).
3. Create a Cloud Scheduler job targeting `2 * * *` (02:00 daily) that
   triggers the Cloud Run job execution via its HTTP trigger URL, with
   `DATABASE_URL`/`DRIVE_FOLDER_ID` set as the job's environment variables
   (secrets via Secret Manager, not plaintext env).

## Rollback

If a `--execute` load fails or verification turns up bad data:

```bash
# Restore from the pg_dump taken in Step 2:
pg_restore -d "$DATABASE_URL" --clean --if-exists "pre_migration_<timestamp>.dump"
```

If the failure happened *mid-run*, there's nothing to roll back — the whole
load is one transaction, so a raised exception already rolled it back
automatically (see the script's own "ERROR -- transaction rolled back, no
partial data was committed" message). `pg_restore` is only needed if you
committed a load, verified it, and *then* decided it was wrong.

## Safety notes carried over from the original ask

- Never commit `GOOGLE_APPLICATION_CREDENTIALS`'s JSON key or `DATABASE_URL`
  to the repo — export them as environment variables or pull from a secrets
  manager.
- `--execute` requires `--yes-really-truncate` as a second, separate flag —
  this is intentional friction against a fat-fingered wipe.
- Run the real (non-dev) load in a maintenance window if the app has active
  users, and tell them beforehand.
- This script never truncates anything outside the `erp` schema. If a future
  edit to `truncate_erp_schema()` in `migrate_sheets_to_pg.py` ever widens
  that scope, treat it as a breaking change requiring explicit sign-off, not
  a routine tweak.
