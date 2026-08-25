# Legacy migrations — not part of the deployment path

Everything in this directory predates the ERP rewrite. **Nothing here runs on
deploy, in CI, or in the test suite.** It is kept for history and for reading,
not for execution.

The one migration path is:

```bash
python migrations/erp/runner.py            # apply pending
python migrations/erp/runner.py --status   # show applied/pending
```

That runner applies `migrations/erp/*.sql` in filename order, under a
Postgres advisory lock, tracked in `erp.migrations_applied`. It builds a
complete database from empty — including the public-schema core tables, via
`000_public_core.sql`.

## Why these were retired (MIG-001)

The audit found three competing migration trackers. Measured against the live
production database and the test database:

| | Production `MTC` | Test `testdb` |
|---|---:|---:|
| `erp` tables | 50 | 50 |
| `public` tables | 5 | 52 |

- **`erp.migrations_applied`** — 38 rows, current, authoritative. Written by
  `migrations/erp/runner.py`. This is the real one.
- **`public.schema_migrations`** — 29 rows dated Oct–Nov 2025, written by
  `tests/conftest.py`'s own bootstrap. The tables those 29 scripts create
  (`item_master`, `production_lots`, `suppliers`, the UPF set, …) **no longer
  exist in production**; they were dropped during the ERP rewrite. The tracker
  rows outlived the schema they describe.
- **`public.migrations_applied`** — 2 rows, written by
  `migration_tracker.py`. One of them:

  ```
  ('migration', 'failed', 'UndefinedColumn: column "model" does not exist')
  ```

  That script globbed `migrations/*.py` and executed them **in alphabetical
  order** — which is not dependency order — against whatever `DATABASE_URL`
  resolved to, with no advisory lock. It was run against production once, on
  2025-12-06, and died on the second file because the legacy schema was
  already gone.

So of the three trackers, one was authoritative and two recorded a schema that
production no longer has.

## What the application actually uses

Verified by searching every SQL statement in `app/`:

- `erp.*` — 405 references
- `public.users` — 27
- `public.custom_roles` — 9
- everything else in this directory — **0**

The only exceptions were `get_or_create_master_id` and
`get_or_create_item_master_id` in `app/utils.py`, which referenced
`item_master`/`model_master`/`variation_master` and had **no callers**; they
were removed with this change.

No test asserts anything about these tables either. Before this change the test
suite built 47 tables that production does not have, on every session, from 29
scripts, purely to satisfy a self-check in its own bootstrap.

## Two things here were dangerous, not merely unused

- **`migration_tracker.py`** imported `create_app()` — so it resolved
  `DATABASE_URL` from `.env`, i.e. **production by default** — then executed
  every `migrations/*.py` alphabetically with no lock. The `failed` row above is
  what that looked like when someone ran it.
- **`init_schema.sql`** was executed by `deploy/deploy.sh` and
  `docker-entrypoint.sh` on **every deploy**, because the ERP runner had no way
  to create `public.users`. Besides the 17 dead tables it creates, it ends with:

  ```sql
  INSERT INTO users (name, email, password_hash, role)
  VALUES ('Admin User', 'admin@mtc.local', 'scrypt:...', 'admin')
  ON CONFLICT (email) DO NOTHING;
  -- and the same for demo@example.com, also role 'admin'
  ```

  Two admin accounts, seeded by the deploy. Both still exist in production
  (user_id 4 and 5, created 2025-11-07). Because the deploy re-ran the file
  every time, deleting them would not have kept them deleted.

  `migrations/erp/000_public_core.sql` replaces that step. It creates the three
  public tables production actually has, with production's actual column types,
  and seeds **nothing**. `deploy.sh` and `docker-entrypoint.sh` no longer invoke
  `psql` at all — the runner does the whole job.

## Verified

`migrations/erp/runner.py` was run against a freshly created, empty database and
the result compared to production, table by table and column by column:

```
erp tables:    virgin=50  prod=50
public tables: virgin=['custom_roles', 'password_reset_tokens', 'users']
               prod  =['custom_roles', 'password_reset_tokens', 'users']
                       (+ the two stale tracker tables listed above)
seeded users in virgin database: 0
→ No drift.
```

## The stale tracker tables in production

`public.migrations_applied` and `public.schema_migrations` are inert — no code
reads them any more. They are **not** dropped by this change, because dropping
tables in a production database is an operator's decision, not a migration's.
`PRODUCTION_REMEDIATION_RUNBOOK.md` carries the SQL if you want them gone.
