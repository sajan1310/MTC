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
converts the whole problem class into a non-event.

**An inverter is already in place at this site, and it is not enough.** The
missing piece is not capacity — it is a **data link**. An inverter carries
the load and then dies silently, so the server gets the same hard cut it
would have got without one, several hours later. Sizing up only moves the
failure later; there is always an outage longer than the battery you bought.

What removes the failure is the server *hearing* "battery at 20%" over USB
or serial, so it can shut down cleanly while power remains. A clean shutdown
needs no WAL replay, no fsck, and no gamble.

Two ways to get there, and the second is the cheap retrofit:

- A UPS with a USB or serial port for the server and the network gear, on
  their own supply. Server + switch + ONT is roughly 100–150 W against the
  whole office load, so a dedicated line multiplies runtime as well.
- Keep the existing inverter as the bulk supply and put a small
  line-interactive UPS **between it and the server**. That buys the data
  link plus a final few minutes to flush and halt — which is all the
  shutdown actually needs.

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

### 3. Get the backups off this machine — use `offsite-pull.sh`

Already flagged as a gap in `PRODUCTION_REMEDIATION_RUNBOOK.md`; repeated
power loss makes it urgent. Snapshots land in `/opt/mtc/src/backups`, on the
same disk as the database. A backup on the same disk as the database is not
a backup — the failure that takes the disk takes both. There is also no
download endpoint in the app (`triggerBackup` and `getBackupStatus` are the
only backup RPCs), so nothing leaves that box unless something fetches it.

`deploy/offsite-pull.sh` is that something. It runs on the machine holding
the copy — **not** on the server — and over Tailscale the server's tailnet
name is a stable address from anywhere, so it works from the factory, from
home, or from a hotel, with no port forwarding and no dynamic DNS.

```bash
./offsite-pull.sh --source mtc-server:/opt/mtc/src/backups \
                  --dest ~/mtc-backups --keep 14
```

It fetches only what it does not already hold, verifies every copy against
its `.sha256` sidecar, discards anything that fails, and prunes its own
copies to `--keep`. Being idempotent, it needs no state and no coordination:
a laptop that was closed for three days collects all three snapshots on its
next run. A local `--source` (a mounted NAS, a USB disk) works too, which is
also how to rehearse the setup before pointing it at the real server.

Three properties worth knowing, because they are the difference between a
backup and a file that looks like one:

- **It is not a mirror.** It never deletes a local snapshot because the
  source no longer has it. A mirror faithfully reproduces the deletion that
  destroyed the original. If you use Syncthing or `rsync --delete` instead,
  turn on file versioning at the receiving end or you have two copies of one
  failure.
- **It never keeps an unverified copy.** A checksum mismatch deletes the
  local file and exits non-zero, rather than leaving something under a
  trusted name that a restore would reach for.
- **It exits non-zero on any failure**, so Task Scheduler or cron surfaces a
  stale copy instead of letting it rot quietly — which is how backups
  usually die.

**Scheduling on a Windows laptop.** Git for Windows already ships Git Bash,
which provides `bash`, `ssh`, `scp` and `sha256sum`, so the script runs as
is — no WSL, no PowerShell port. In Task Scheduler, run:

```
"C:\Program Files\Git\bin\bash.exe" -lc "~/mtc/deploy/offsite-pull.sh --source mtc-server:/opt/mtc/src/backups --dest ~/mtc-backups --keep 14"
```

Set it to *Run whether user is logged on or not* and tick *Run task as soon
as possible after a scheduled start is missed* — the closed-lid case is the
normal case for a laptop.

**Pull, don't push.** The server knows exactly when a fresh verified dump
exists and could push it, but that needs the server to hold an SSH key for
the laptop, turning a server compromise into laptop access. Pulling keeps
the credential on the machine being protected.

**Then restore from the off-site copy once, on purpose.** This is the step
everyone skips and the only one that proves the rest worked. Commands are in
`PRODUCTION_REMEDIATION_RUNBOOK.md`.

**Encrypt the machine holding the copy.** These dumps are the complete
vendor, client, costing and payment history. On a laptop that leaves the
site, that wants BitLocker or FileVault on.

**Lock down the tailnet.** Tailscale ACLs default to flat — every device
reaching every other device on every port. Restrict the server to the
devices that actually need it, on the ports they actually need.

The Google Sheets mirror is a convenience, not a restore path. It does not
round-trip into a database: no schema, no sequences, no constraints, no
foreign-key ordering.

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
