# Database migrations

There is **one** migration path:

```bash
python migrations/erp/runner.py            # apply everything pending
python migrations/erp/runner.py --status   # show applied / pending
```

It applies `migrations/erp/*.sql` in filename order under a Postgres advisory
lock, and records what it applied in `erp.migrations_applied`. It is
idempotent, safe to run on every start, and safe to run concurrently — the
lock makes a second instance wait and then find nothing pending, rather than
half-applying a schema alongside the first.

The deploy path (`deploy/deploy.sh`, `docker-entrypoint.sh`,
`deploy/mtc.service`'s `ExecStartPre`) runs exactly this command and nothing
else.

## Layout

| Path | What it is |
|---|---|
| `erp/000_public_core.sql` | The public-schema core: `users`, `password_reset_tokens`. Runs first because every migration from `003` on has a foreign key to `users`. |
| `erp/0NN_*.sql` | The schema, in order. Add new ones here. |
| `erp/runner.py` | The runner described above. |
| `legacy/` | Pre-ERP scripts. **Nothing runs these.** See `legacy/README.md`. |

## Adding a migration

Create `erp/0NN_short_name.sql` with the next number and write plain SQL.
There is no `upgrade()` function, no Python entry point, and no registration
step — the runner picks up any `.sql` file in that directory that is not
already in `erp.migrations_applied`.

Two rules:

- **Idempotent where it can be.** `CREATE TABLE IF NOT EXISTS`,
  `ADD COLUMN IF NOT EXISTS`. The runner will not re-apply a recorded
  migration, but a half-applied one has to be re-runnable.
- **A data migration is not idempotent, so say so in the file.** `032_recalc_
  contractor_payable_per_unit_extra_charge.sql` is the example: a
  recalculation applied twice produces wrong money. The advisory lock is what
  protects those.

## Verifying a fresh build

The chain builds a complete database from empty. To check it still does:

```bash
createdb scratch_check
DATABASE_URL=postgresql://.../scratch_check python migrations/erp/runner.py
```

The result should match production: 50 tables in `erp`, three in `public`
(`users`, `password_reset_tokens`, `custom_roles`), and **zero seeded user
accounts**. A migration that mints an account is a bug — see
`legacy/README.md` for what that cost the last time.

## History

Until this was consolidated (MIG-001) there were three migration trackers —
`erp.migrations_applied`, `public.migrations_applied` and
`public.schema_migrations` — two of which described a schema production no
longer had, and the public core tables were created by a `psql -f
init_schema.sql` step outside all three. `legacy/README.md` has the evidence
and the measurements.
