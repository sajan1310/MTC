# Production Remediation Runbook

**Release** Phase 0 critical stabilisation + partial Phase 1
**Target** Maharaja Bikes ERP (MTC), single-host deployment (`/opt/mtc`, systemd `mtc.service`)
**Expected window** 45–60 minutes, including verification
**Expected user impact** **Everyone is signed out once.** No data change, no downtime beyond one service restart.

> Read this whole document before starting. Steps 1, 2 and 3 must happen in
> that order — step 3's account audit is meaningless if step 1's backup does
> not exist, and step 2 will refuse to start the service if the environment is
> incomplete.

---

## 0. Why this release logs everyone out

`SECRET_KEY` had a fallback to a value committed to this repository
(`"dev-insecure-key"`), and the startup guard that was supposed to prevent
running on it only tested truthiness — so it could never fire. If this
deployment was running without `SECRET_KEY` in its environment, then **session
cookies and password-reset tokens have been forgeable by anyone with a copy of
the source**, for as long as that has been true.

You therefore need to do two things, not one:

1. Ensure a real `SECRET_KEY` is set (step 2).
2. **Rotate it**, if there is any chance the fallback was in use (step 2b).

Rotation invalidates every existing session — which is the point. Warn the shop
floor first; mid-entry forms will be lost.

**How to check whether you were exposed**, before changing anything:

```bash
sudo grep -c '^SECRET_KEY=' /etc/mtc/mtc.env || echo "NOT SET -- you were running on the fallback"
```

---

## 1. Pre-deployment backup — and prove it restores

Do not skip the proof. The whole reason this release exists is that the
previous backup mechanism produced files that could not be restored while
reporting success.

```bash
# 1a. Snapshot with the NEW engine, from the checkout you are about to deploy.
cd /opt/mtc/src/Project-root
sudo -u mtc /opt/mtc/venv/bin/python - <<'PY'
import sys; sys.path.insert(0, '.')
from app.erp.services import db_backup
snap = db_backup.create_snapshot('/opt/mtc/src/backups')
print(f"{snap.filename}  {snap.size_bytes:,} bytes  {snap.table_count} tables")
print(f"sha256 {snap.sha256}")
PY
```

`create_snapshot` raises rather than returning if `pg_restore` cannot read the
file back or a required table is missing. If it printed a filename, the file is
readable.

```bash
# 1b. Prove it end to end: restore into a scratch database and compare counts.
SNAP=$(ls -t /opt/mtc/src/backups/mtc_*.dump | head -1)
sudo -u postgres createdb mtc_preflight
sudo -u postgres pg_restore --no-owner --no-privileges --exit-on-error \
     --dbname mtc_preflight "$SNAP" && echo "RESTORE OK"

sudo -u postgres psql -tAc "
  SELECT 'users', count(*) FROM public.users
  UNION ALL SELECT 'bill_headers', count(*) FROM erp.bill_headers
  UNION ALL SELECT 'production', count(*) FROM erp.production
  UNION ALL SELECT 'dispatch_headers', count(*) FROM erp.dispatch_headers" mtc_preflight
# Compare against the same query on the live database. They must match.

sudo -u postgres dropdb mtc_preflight
```

**Stop here if the restore fails.** Do not proceed without a recoverable
backup.

```bash
# 1c. Get a copy off this machine. The backup is useless if the disk dies.
scp "$SNAP" backup-host:/srv/mtc-backups/
```

---

## 2. Environment configuration

The application now **refuses to start** when configuration is missing or weak.
That is intentional, and it means a bad `mtc.env` fails loudly at step 6 rather
than silently running insecurely. Get it right now.

```bash
sudo -e /etc/mtc/mtc.env
```

Required (the service will not start without them):

```ini
SECRET_KEY=<64 random characters -- see 2b>
DATABASE_URL=postgresql://mtc:<password>@127.0.0.1:5432/MTC
GOOGLE_CLIENT_ID=<...>
GOOGLE_CLIENT_SECRET=<...>
```

`SECRET_KEY` is now rejected if it is unset, empty, shorter than 32 characters,
or one of the known-weak values in `app/__init__.py`'s `WEAK_SECRET_KEYS`
(which includes the old `dev-insecure-key`).

If you use discrete DB settings instead of `DATABASE_URL`, **`DB_PASS` is now
required too** — its `"abcd"` fallback is gone.

New, optional:

```ini
# Turn self-registration off entirely. Recommended for a single factory where
# every user is known: it removes the unauthenticated write path rather than
# only making its output harmless. Default is "true" (enabled).
ALLOW_SELF_SIGNUP=false

# Per-user RPC rate limits. Defaults shown; raise if legitimate work trips them.
RATELIMIT_RPC_DEFAULT=600 per minute
RATELIMIT_RPC_EXPENSIVE=40 per minute

# Backup retention (defaults shown).
BACKUP_RETAIN_DAILY=7
BACKUP_RETAIN_WEEKLY=4
BACKUP_RETAIN_MONTHLY=12
```

### 2b. Generate and rotate the secret

```bash
/opt/mtc/venv/bin/python -c "import secrets; print(secrets.token_urlsafe(48))"
```

Paste it as `SECRET_KEY`. **Never commit it, never log it, never paste it into
a ticket.** `/etc/mtc/mtc.env` should be `root:mtc 0640`:

```bash
sudo chown root:mtc /etc/mtc/mtc.env && sudo chmod 0640 /etc/mtc/mtc.env
```

Rotating invalidates all sessions and all outstanding password-reset links.
Tell users to sign in again; anyone mid-reset must request a new link.

---

## 3. Audit accounts created through the old signup path

Until this release, `POST /auth/api/signup` created accounts with
`role="user"` — full, unrestricted ERP access — and logged them straight in,
unauthenticated and CSRF-exempt. Find out whether anyone used it.

```bash
sudo -u postgres psql MTC -c "
SELECT user_id, name, email, role, created_at
FROM users
WHERE password_hash IS NOT NULL
  AND role NOT IN ('pending_approval', 'admin', 'super_admin')
ORDER BY created_at DESC;"
```

Review every row **with someone who knows the staff list**. This is a judgement
call the deployment cannot make for you: these may all be legitimate colleagues
whose accounts predate the approval workflow.

For anything unrecognised:

```sql
-- Demote rather than delete, so the audit trail and any updated_by references survive.
UPDATE users SET role = 'pending_approval' WHERE user_id = <id>;
```

Note what you found and what you did. If anything was unrecognised, treat the
`SECRET_KEY` rotation in step 2b as **mandatory**, not optional.

### 3b. The test accounts already in production

This is not hypothetical. Run against the live database on 2026-08-25,
`public.users` held **32 rows: one real person and 31 development/verification
artefacts**, all active and all able to sign in. Four of them hold **admin**:

| Account | Role | Password set | Created |
|---|---|---|---|
| `admin@mtc.local` | admin | yes | 2025-11-07 |
| `demo@example.com` | admin | yes | 2025-11-07 |
| `testuser@example.com` | admin | no | 2025-11-08 |
| `test-admin@example.com` | admin | yes | 2026-07-13 |

The first two were created by the deploy itself: `migrations/init_schema.sql`
ended with two `INSERT INTO users ... 'admin'` statements and the deploy
scripts re-ran that file every time, so deleting them would not have kept them
deleted. **That mechanism is removed in this release** — the runner's new
`000_public_core.sql` seeds nothing, and a test fails the build if any
migration inserts into `users` again. The rows themselves are still there.

List them:

```bash
sudo -u postgres psql MTC -c "
SELECT user_id, email, role, (password_hash IS NOT NULL) AS can_password_login, created_at
FROM users
WHERE email LIKE '%example.com'
   OR email LIKE '%example.invalid'
   OR email LIKE '%@mtc.local'
   OR email LIKE 'smoke%'
   OR email LIKE 'test%'
ORDER BY role, created_at;"
```

**Check the list against the staff roster before acting** — the pattern above
is a heuristic, and a real colleague could match it.

Deactivate rather than delete, so `updated_by` references and the audit trail
survive. Deactivation is enforced on all four sign-in paths (password login,
Google login, password reset, and session loading), so it takes effect
immediately, including for any session already open:

```sql
-- Dry run first: see exactly which rows this would touch.
SELECT user_id, email, role FROM users WHERE user_id IN (<ids>);

UPDATE users SET deleted_at = NOW(), updated_at = NOW() WHERE user_id IN (<ids>);
```

Verify none remain:

```bash
sudo -u postgres psql MTC -c "
SELECT count(*) FROM users
WHERE deleted_at IS NULL AND role IN ('admin','super_admin');"
```

The expected answer is the number of real administrators, and no more.

### 3c. Two dead migration-tracker tables (optional)

`public.schema_migrations` (29 rows) and `public.migrations_applied` (2 rows,
one `status='failed'`) describe a schema production no longer has — the tables
those migrations created were dropped during the ERP rewrite. Nothing reads
either table; `erp.migrations_applied` is the only live tracker.

They are harmless. If you want them gone, take a backup first (step 1) and:

```sql
DROP TABLE IF EXISTS public.schema_migrations;
DROP TABLE IF EXISTS public.migrations_applied;
```

Nothing in the application, the deploy scripts or the test suite references
either name — `tests/test_migration_path.py::test_only_one_tracker_table_is_written_anywhere`
keeps it that way.

---

## 4. Deploy the code

```bash
cd /opt/mtc/src
sudo -u mtc git fetch origin
sudo -u mtc git log --oneline HEAD..origin/<branch>   # review what is landing
sudo -u mtc git checkout <branch> && sudo -u mtc git pull
sudo -u mtc /opt/mtc/venv/bin/pip install -r Project-root/requirements.txt
```

Confirm the PostgreSQL client tools are present — the new backup engine needs
them, and will refuse to run (loudly) without:

```bash
which pg_dump pg_restore || sudo apt install postgresql-client
```

---

## 5. Database migrations

Four new migrations land: **`000_public_core`** (brings `public.users` and
`password_reset_tokens` into the tracked chain — a **no-op on this database**,
where both already exist; it exists so a virgin database can be built by the
runner alone), `036` (users.role default → `pending_approval`),
`037` (stock-adjustment lookup index) and `038` (atomic mutation claim:
adds `status`/`claimed_at` to `erp.rpc_mutations`, relaxes `result` to
nullable, adds two CHECK constraints and two indexes). All are additive;
none rewrites business data.

> **`038` is not optional and must be applied BEFORE the new code serves
> traffic.** `app/erp/mutations.py` writes `rpc_mutations.status` on every
> mutating RPC call, so code newer than this migration fails with
> `column "status" of relation "rpc_mutations" does not exist` on the first
> save anybody attempts — every mutation, not just one module. This happened
> in development: the app started cleanly, served every read, and then
> returned HTTP 500 on the first production save.
>
> `create_app()` now refuses to start when any migration is unapplied, so the
> failure surfaces at boot with the pending list named, instead of one 500 at
> a time. If you see that error, run the migrator — do not set
> `SKIP_MIGRATION_CHECK`.

`mtc.service` runs migrations from `ExecStartPre` on every start, so step 6
applies them. To see what is pending first:

```bash
cd /opt/mtc/src/Project-root
sudo -u mtc /opt/mtc/venv/bin/python migrations/erp/runner.py --status
```

The runner now takes a Postgres advisory lock, so a second instance waits
rather than applying the same migration twice.

---

## 6. Restart

```bash
sudo systemctl restart mtc
sudo systemctl status mtc --no-pager
sudo journalctl -u mtc -n 60 --no-pager
```

**If the service refuses to start**, read the error — it will name exactly what
is wrong, e.g.:

```
RuntimeError: Refusing to start: invalid or missing configuration --
SECRET_KEY (unset, too short, or a known default). Set these in the
environment (see deploy/mtc.env.example).
```

That is the new fail-fast doing its job. Fix `/etc/mtc/mtc.env` and restart.
**Do not work around it.**

---

## 7. Post-deployment verification

```bash
# 7a. Health check must be genuinely healthy (it probes the database).
curl -sS http://127.0.0.1:8000/health | tee /dev/stderr | grep -q '"status": *"healthy"' \
  && echo "HEALTH OK"

# 7b. Logout is no longer a GET side-effect (SEC-008): GET renders a
#     confirmation page, it does not sign anyone out.
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/auth/logout   # 302 to login (unauthenticated)

# 7c. Rate limiting is active on the RPC surface (SEC-005) -- no longer exempt.
for i in $(seq 1 60); do
  curl -sS -o /dev/null -w '%{http_code} ' -X POST \
    http://127.0.0.1:8000/api/erp/rpc/getStockData -H 'Content-Type: application/json' -d '{"args":[]}'
done; echo
# Expect 401/302 (unauthenticated) rather than 200s -- and 429 if you exceed the tier.
```

Then, in a browser:

1. **Sign in** with a known account (everyone was logged out by the rotation).
2. **Open a vendor profile** with a ledger — confirm it renders.
3. **Sign out** — confirm the confirmation page appears and the button works.
4. **Request a password reset**, use the link, then **click the same link
   again** — the second attempt must be refused.
5. **Create a test signup** (if `ALLOW_SELF_SIGNUP` is still on) — confirm it
   lands on the pending-approval page and can do nothing. Then delete it.

```bash
# 7d. Trigger a backup and confirm it reports verified, not merely "created".
cd /opt/mtc/src/Project-root
sudo -u mtc /opt/mtc/venv/bin/python - <<'PY'
import sys; sys.path.insert(0, '.')
from app.erp.services import backup_service
r = backup_service.perform_full_backup()
print(r["status"], "| verified:", r["snapshot_verified"],
      "| tables:", r["snapshot_table_count"], "| failures:", r["consecutive_failures"])
PY
```

`status` may legitimately be `PARTIAL` if the Google Sheets export is not
configured. **`snapshot_verified` must be `True`.** If `status` is `FAILED`,
there is no recoverable backup — investigate before considering the deployment
done.

---

## 8. Rollback

Nothing in this release rewrites data, so rollback is a code revert. Migrations
036 and 037 are additive and safe to leave in place.

```bash
cd /opt/mtc/src
sudo -u mtc git checkout <previous-commit>
sudo -u mtc /opt/mtc/venv/bin/pip install -r Project-root/requirements.txt
sudo systemctl restart mtc
```

**Do not roll back `SECRET_KEY`.** The old value is compromised by
construction. The previous code accepts the new key perfectly well.

If you must reverse the migrations (you almost certainly need not):

```sql
ALTER TABLE public.users ALTER COLUMN role SET DEFAULT 'user';   -- undoes 036
DROP INDEX IF EXISTS erp.ix_erp_stock_adjustments_item_size_created;  -- undoes 037
DELETE FROM erp.migrations_applied
 WHERE migration_name IN ('036_users_role_default_pending',
                          '037_stock_adjustments_lookup_index');
```

### Full restore from a snapshot

Only if the database itself is damaged:

```bash
sudo systemctl stop mtc
sudo -u postgres psql -c "ALTER DATABASE \"MTC\" RENAME TO mtc_damaged_$(date +%Y%m%d)"
sudo -u postgres createdb MTC
sudo -u postgres pg_restore --no-owner --no-privileges --exit-on-error \
     --dbname MTC /opt/mtc/src/backups/mtc_<timestamp>.dump
sudo systemctl start mtc
curl -sS http://127.0.0.1:8000/health
```

Keep the renamed database until you have confirmed the restore is good.

---

## 9. Follow-up (not part of this window)

These are real gaps this release does not close. Track them.

| | |
|---|---|
| **Off-site backups** | Step 1c is manual. Automate it — a backup on the same disk as the database is not a backup. |
| **Backup encryption at rest** | The dump is the entire business database in plaintext. |
| **Backup monitoring** | Nothing alerts if a backup stops running. Absence produces no error at all. Watch `getBackupStatus`'s `consecutive_failures` and `stale`. |
| **Concurrency (DATA-002)** | Two clerks dispatching the same product simultaneously can still over-allocate. Highest remaining correctness risk. |
| **Client fetch timeouts** | Server-side OAuth timeouts are fixed; the browser's `fetch` still has none. |
| **Rate-limit tuning** | Watch for 429s in the journal for a week; raise the tiers if legitimate work is being refused. |

---

## Sign-off checklist

- [ ] Pre-deployment snapshot taken **and restored into a scratch database**, counts matched
- [ ] Snapshot copied off this machine
- [ ] `SECRET_KEY` set to a fresh 48-byte value; old value discarded
- [ ] `DB_PASS` / `DATABASE_URL` confirmed present
- [ ] `/etc/mtc/mtc.env` is `root:mtc 0640`
- [ ] Account audit run; findings recorded; anything unrecognised demoted
- [ ] Code deployed; `pg_dump`/`pg_restore` on PATH
- [ ] Migrations 036, 037 and **038** applied (`runner.py --status` shows `Pending (0)`)
- [ ] Service restarted and healthy; `/health` returns `healthy`
- [ ] Browser checks 1–5 passed
- [ ] Post-deployment backup reports `snapshot_verified: True`
- [ ] Users told they must sign in again
