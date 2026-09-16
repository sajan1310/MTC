# Surviving long power outages

Written for the factory installation, where mains outages run for hours and
the inverters do not always outlast them. The assumption throughout is that
**the server loses power without warning, repeatedly** — not that it might
one day.

Two of the three sections below are already done in this repo. The third is
the one that matters most, and it is hardware and host configuration, not
code.

---

## What an unclean shutdown does *not* break

Worth stating first, because it bounds the problem.

**Committed data is safe.** PostgreSQL's durability defaults —
`fsync=on`, `synchronous_commit=on`, `full_page_writes=on` — are all in
force; `provision.sh` tunes memory and planner costs and deliberately
touches none of them. Every commit is on disk before the app is told it
succeeded, and `full_page_writes` is what repairs a page torn in half by a
cut mid-write. **Never** set any of those three to `off` to make the app
feel faster. It is the one edit that turns a power cut into data loss.

**In-flight work rolls back cleanly.** Every request runs inside one
transaction (`database.get_conn()` commits at the end of the block, rolls
back on any exception). A cut mid-request loses that request and nothing
else — the operator re-enters one bill, rather than finding half of one in
the ledger. The same holds for the migration runner: each migration is one
transaction, so an interrupted deploy leaves the schema at the last
*complete* migration, never between two.

**Redis losing everything is fine, by design.** It holds rate-limit
counters and import-progress keys, both self-expiring, and `provision.sh`
configures `save ""` / `appendonly no`. There is no RDB or AOF file to be
found corrupt on restart, which is a common way for a Redis-backed app not
to come back after an outage.

**An interrupted backup does not produce a bad backup.** A snapshot is
written as `mtc_<stamp>.dump.partial` and renamed into place only after
`pg_restore` has confirmed it lists every required table, so a directory
listing can never show a truncated file that a later restore would trust.

---

## What was breaking, and is now fixed

### 1. The ERP did not come back after the power did

This was the big one, and it was pure startup ordering.

`mtc.service` declares `After=postgresql.service`, which sounds sufficient
and is not. On Debian and Ubuntu, `postgresql.service` is a `Type=oneshot`
**wrapper** whose `ExecStart` is `/bin/true`; the cluster itself runs as
`postgresql@17-main.service`. systemd therefore considers PostgreSQL
"started" the moment the wrapper exits — which, after a clean boot, is
milliseconds before the database is genuinely ready, and after a **power
cut** is minutes before it.

A cluster replaying its write-ahead log does not merely fail to answer; it
*actively rejects* connections with `the database system is starting up`.
So, every time the power came back:

1. `mtc.service` starts. `ExecStartPre` runs `migrations/erp/runner.py`.
2. It cannot connect. Non-zero exit. systemd records a failed start.
3. `Restart=always`, `RestartSec=5` — try again in five seconds.
4. Five failures inside ~25 seconds trip `StartLimitBurst=5`, and **systemd
   stops trying.**

The unit then sits in `failed (start-limit-hit)` until a human runs
`systemctl reset-failed mtc && systemctl start mtc`. The database finished
recovering a minute later and was fine. Nobody was there to notice.

**Fix:** `deploy/wait-for-deps.sh`, wired in as the first `ExecStartPre`. It
blocks until `pg_isready` reports the cluster is *accepting* connections
(exit 0, not the exit 1 that means "rejecting, still recovering"), then does
the same for Redis, then gets out of the way. `DEPS_WAIT_TIMEOUT` defaults
to 600s — enough for WAL replay plus a filesystem journal recovery — and
`TimeoutStartSec=900` gives systemd room to contain the wait.

The start limit is deliberately left at 5/300s. It now only catches what it
was meant to catch: a genuine config error, which still fails in under a
second and still stops the unit with a legible `systemctl status`. And
because each attempt now spans minutes instead of five seconds, a database
that really is taking a long time gets window after window instead of
wedging the unit permanently.

Recovery is now unattended. Nothing to do by hand when the power returns.

### 2. Abandoned backups filled the disk

`create_snapshot` deletes its `.partial` file on any failure — in an
`except BaseException` handler. A power cut runs no handler. The file
survived as an orphan, and retention could not see it to clean up, because
those rules match on the final `.dump` name.

One abandoned full dump per outage, accumulating in the same directory as
the backups, on the same disk as the database, until the disk filled — at
which point PostgreSQL cannot write WAL and the outage is total. The backup
directory becomes the outage.

**Fix:** `reap_orphaned_partials()` removes `.partial` files older than
`ORPHAN_PARTIAL_AGE_SECONDS` (well past the point where `pg_dump` would have
been killed by its own timeout, so it can never race a live run). It runs
both from `prune_snapshots()` after a successful backup *and* on the way
into `create_snapshot()` — because the site that generates orphans is
exactly the site where runs keep getting killed and none ever reaches the
post-success sweep.

### 3. A "verified" snapshot that the disk never received

`pg_dump` exiting 0 means the bytes reached the kernel, not the platter.
They sit in the page cache for up to 30 seconds by default
(`vm.dirty_expire_centisecs`).

That window was dangerous out of proportion to its length, because
everything downstream agreed the file was good: `verify_snapshot()` read it
back through the same page cache, so `pg_restore` listed every required
table; `_sha256()` hashed the same cached bytes, so the `.sha256` sidecar
recorded a checksum for data the disk never got. A cut inside those 30
seconds left a snapshot that *presents as verified* and fails at restore —
discovered, by definition, on the day the database is already gone.

**Fix:** `fsync` the dump before the rename that makes it visible under a
trusted name, `fsync` the sidecar, and `fsync` the directory afterwards (a
file's *data* being durable says nothing about its *name* being durable).
Failures are logged and never fatal — narrowing the window must not become a
new way for the nightly job to report `FAILED`.

---

## What still needs doing on the host

Code cannot fix the underlying event. Every hard cut is a gamble that the
WAL and `full_page_writes` cover whatever was in flight; they almost always
do, but "almost always", several times a week, for years, is a losing bet.
These are in priority order.

### 1. Let the machine shut itself down before the battery dies — do this first

This is the single highest-value change available, and it is the one that
converts the whole problem class into a non-event. An inverter that fails
mid-outage yanks power with no warning. A UPS with a **data link** (USB or
serial, not just a socket the server is plugged into) can say "battery at
20%", and the server can shut down cleanly while it still has power to do
it. A clean shutdown needs no WAL replay, no fsck, and no gamble.

```bash
sudo apt install nut
```

Configure Network UPS Tools for a directly-attached UPS (`standalone` mode):

| File | Key settings |
| --- | --- |
| `/etc/nut/ups.conf` | the `[ups]` section — `driver`, `port`; run `nut-scanner -U` to find both |
| `/etc/nut/upsd.users` | a user with `upsmon primary` |
| `/etc/nut/upsmon.conf` | `MONITOR ups@localhost 1 <user> <pass> primary`, and `SHUTDOWNCMD "/sbin/shutdown -h +0"` |
| `/etc/nut/nut.conf` | `MODE=standalone` |

```bash
sudo systemctl enable --now nut-server nut-monitor
upsc ups                      # should print battery.charge, ups.status
sudo upsmon -c fsd            # rehearse the shutdown, on purpose, once
```

Set the shutdown threshold generously — `upsmon.conf`'s `FINALDELAY` and the
driver's low-battery point. Shutting down at 40% battery and coming back up
ten minutes later costs a short outage; running the battery to zero costs a
recovery and, eventually, a restore.

Rehearse it. A UPS integration nobody has tested is a UPS integration that
does not work.

### 2. Check that the disk is not lying about flushes

`fsync=on` is only as good as the hardware's honesty. Consumer SSDs and USB
enclosures routinely acknowledge a flush that is still in volatile cache,
which silently undoes everything above.

```bash
sudo -u postgres pg_test_fsync          # ships with the postgresql server package
lsblk -o NAME,ROTA,MODEL
sudo hdparm -W /dev/sda                 # 1 = volatile write cache ON
```

`pg_test_fsync` reporting implausible numbers for `fdatasync` (tens of
thousands of ops/sec on a single device) means the flush is not reaching
stable storage. Either turn the drive's write cache off (`hdparm -W0`) or —
better, and the right answer for a site like this — use a drive with power-
loss protection. A UPS covers this too: a cache that is never surprised by a
cut cannot lose what it holds.

### 3. Get the backups off this machine

Already flagged as a gap in `PRODUCTION_REMEDIATION_RUNBOOK.md`; repeated
power loss makes it urgent. Snapshots land in `/opt/mtc/src/backups`, on the
same disk as the database. A backup on the same disk as the database is not
a backup — the failure that takes the disk takes both.

Anything off-box beats nothing: a `rsync` to another machine on the LAN, a
nightly copy to an external drive, `rclone` to cloud storage. The snapshot
has a `.sha256` sidecar; verify against it after the copy.

The Google Sheets mirror is a convenience, not a restore path. It does not
round-trip into a database.

### 4. Turn on data checksums

Checksums make PostgreSQL *detect* a corrupt page and raise an error instead
of serving the damage as data. On a machine taking repeated hard cuts, that
is the difference between finding out immediately and finding out months
later from a wrong number in a report.

```bash
sudo -u postgres psql -tAc "SHOW data_checksums"   # "on" or "off"
```

If it says `off`, `pg_checksums --enable` turns them on **with the cluster
stopped** — it rewrites every page, so budget downtime proportional to
database size, and take a snapshot first:

```bash
sudo systemctl stop mtc postgresql
sudo -u postgres /usr/lib/postgresql/17/bin/pg_checksums --enable \
    -D /var/lib/postgresql/17/main
sudo systemctl start postgresql mtc
```

No dump and reload needed. New clusters get it from
`initdb --data-checksums`.

### 5. Confirm everything is enabled at boot

`provision.sh` does this, but a hand-edited host drifts. After a reboot,
nothing should need starting by hand:

```bash
systemctl is-enabled mtc postgresql redis-server nginx
```

---

## After an outage: what to check

Normally nothing — that is the point of the readiness gate. When something
does look wrong, in this order:

```bash
# 1. Did everything come back?
systemctl status mtc postgresql redis-server nginx --no-pager
curl -fsS http://127.0.0.1:8000/health          # {"status":"healthy",...}

# 2. How long did the gate wait? (Names the outage, in the journal.)
journalctl -u mtc -b | grep wait-for-deps

# 3. Did PostgreSQL recover cleanly, or complain?
journalctl -u postgresql@17-main -b | head -40
#    "database system was not properly shut down; automatic recovery in
#    progress" followed by "database system is ready" is the NORMAL,
#    healthy sequence. Anything mentioning "invalid page" or
#    "could not read block" is not -- stop and restore.

# 4. Is the data self-consistent?
#    The hourly internal ledger audit is the app's own answer to this.
#    Findings surface in the dashboard's notification log; see
#    ledger_audit_service.run_internal_ledger_audit().

# 5. Is there a recent, verified backup?
ls -lt /opt/mtc/src/backups/mtc_*.dump | head -5
#    getBackupStatus also reports snapshot_verified and
#    consecutive_failures. The nightly job is elapsed-time based, not
#    clock-based: if the machine was off at the scheduled hour it runs
#    within a minute of coming back up, rather than skipping the day.
```

If the unit is `failed (start-limit-hit)` — which should no longer happen,
and means something other than a slow database is wrong — read the real
cause first, then clear it:

```bash
journalctl -u mtc -n 100 --no-pager
sudo systemctl reset-failed mtc && sudo systemctl start mtc
```

Restore instructions are in `PRODUCTION_REMEDIATION_RUNBOOK.md`.
