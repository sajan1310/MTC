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

What removes the failure is the server *hearing* "five minutes of battery
left" over USB or serial, so it can shut down cleanly while power remains. A
clean shutdown needs no WAL replay, no fsck, and no gamble. Choosing that
threshold is its own decision — see below; it is not a fixed 20%.

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

#### Picking the low-battery threshold

There is no built-in "20%" — it is a number you choose, and 20% is the wrong
one here. The UPS reports `battery.charge` (percent) and/or
`battery.runtime` (seconds left) over the data link; NUT raises the
low-battery flag (`LB`) when one crosses your threshold, and `upsmon` then
runs `SHUTDOWNCMD`.

**First find out what this UPS actually reports.** Cheap units expose only a
binary `LB` set by firmware at a point you cannot change; better ones give
charge and runtime. Design around what is present, not what is documented:

```bash
upsc ups                      # battery.charge, battery.runtime, ups.status
```

Set your own threshold with driver-level overrides in `/etc/nut/ups.conf`
(`override.` always wins; `default.` applies only when the UPS reports
nothing of its own). Whichever trips first raises `LB`:

```ini
override.battery.runtime.low = 300   # seconds remaining — prefer this
override.battery.charge.low  = 40    # percent, as a backstop
```

**Prefer runtime over percentage.** On lead-acid the reported percentage is
usually inferred from voltage — a crude estimate that degrades badly as the
battery ages. Batteries that "fail on long outages" are already tired, and
20% of a tired battery can be under a minute.

**Budget the shutdown this server actually needs.** `mtc.service` allows
`TimeoutStopSec=45` for gunicorn alone, then PostgreSQL shuts down with a
final checkpoint, then the OS halts. Two minutes is a comfortable estimate,
which is why 300 seconds is the starting point above — and why a percentage
that might mean 40 seconds is not.

**Then measure it instead of trusting the estimate.** `upsmon -c fsd` forces
the real sequence; time it from trigger to power-off and set
`battery.runtime.low` to roughly three times what you observe.

The trade is deliberately lopsided. Going down too early costs a few minutes
of availability during an outage in which the office desktops are dead
anyway, so nobody is using the ERP. Going down too late costs the hard crash
the UPS was bought to prevent. Err early, by a lot.

#### Getting told about it

If you want notification and not just protection, add to `upsmon.conf`:

```ini
NOTIFYCMD  /usr/local/bin/ups-notify.sh
NOTIFYFLAG ONBATT   SYSLOG+WALL+EXEC
NOTIFYFLAG LOWBATT  SYSLOG+WALL+EXEC
NOTIFYFLAG ONLINE   SYSLOG+WALL+EXEC
```

The script reads `$NOTIFYTYPE` and sends whatever you like.

One caveat that inverts the obvious priority: **the alert that matters most
is the one least likely to arrive.** When the site loses power the router and
ONT go with it unless they are on the same protected supply, so a LOWBATT
message may never leave the building. Alert on **ONBATT** — sent in the first
seconds, while the link is still up — and treat LOWBATT as a local log entry
you read afterwards. Putting the network gear on the UPS fixes this properly,
which is the plan anyway.

Rehearse all of it. A UPS integration nobody has tested is a UPS integration
that does not work.

#### Setting it up

`deploy/ups-setup.sh` does the whole data-link side: installs NUT, finds the
UPS with `nut-scanner`, writes every config file (backing up what was there),
sets the thresholds above, wires the handler, and enables the services.

```bash
sudo ./deploy/ups-setup.sh --detect   # just show what is on the USB bus
sudo ./deploy/ups-setup.sh            # configure and enable
```

It refuses to write a configuration when `nut-scanner` finds nothing, because
the most likely reason is the one that matters: the unit is an inverter with
no data port at all, which is exactly the situation this section exists to
fix. A socket the server is plugged into tells it nothing.

#### The emergency snapshot: why it fires at ONBATT, not LOWBATT

The obvious design — "when the battery is nearly gone, save everything" — is
backwards, and worth spelling out because it is the instinct everyone has.

At LOWBATT there are minutes of power left and exactly one correct action:
shut down cleanly. Starting a database dump and an internet upload at that
moment *delays* the shutdown, and can cause the hard crash the UPS was bought
to prevent. Worse, by then the site's router is usually dark too, so the send
blocks until its own timeout while the battery drains.

So the snapshot fires the instant mains fails, when the battery is still full
and the network is most likely still up:

| Event | What `deploy/ups-notify.sh` does |
| --- | --- |
| `ONBATT` | Take a snapshot now and mail it — backgrounded, so upsmon is never blocked |
| `LOWBATT` | **Kill** any run still in flight, and get out of the shutdown's way |
| `ONLINE` | Let an in-flight run finish; mains is back, there is no hurry |
| `COMMBAD` / `NOCOMM` | Warn that the data link is gone, which defeats the whole arrangement |

The run is capped by `EMERGENCY_BACKUP_BUDGET` (180s) and started with
`setsid`, so LOWBATT can signal the whole process group and be sure `pg_dump`
dies with its parent rather than being orphaned holding the database open.

Run it by hand any time — this is also the rehearsal:

```bash
sudo -u mtc /opt/mtc/venv/bin/python     /opt/mtc/src/Project-root/scripts/emergency_backup.py --dry-run
journalctl -t mtc-ups -f          # watch it during a real event
```

Its exit codes are deliberately graded: `0` sent, `1` snapshot written but
sending failed, `2` no snapshot at all, `3` nothing configured to send to.
Only `2` is genuinely bad. A `1` still leaves a verified snapshot on disk for
`offsite-pull.sh` to collect.

#### No UPS data link? Watch the modem — but understand what it tells you

The NUT arrangement above needs a UPS that can talk over USB. This site has an
inverter that says nothing, so the trigger has to be inferred — and the point
that matters is **which** event is the emergency.

Losing mains is not. The server is on the inverter precisely so that work
carries on through an outage, and shutting down then throws away the only
reason to own one. The emergency is the **inverter giving out**, because the
machine has minutes left at that point and a clean stop beats a hard cut.

The modem answers that question by proxy, because it is on the same inverter:

| Observation | Meaning | Action |
| --- | --- | --- |
| Mains out, modem answering | Running on inverter, as designed | **Nothing.** Carry on. |
| Modem answering, WAN dead | The ISP has a problem | Log it. Nothing else. |
| Modem not answering | The inverter is exhausted | Snapshot, then shut down |

The middle row is why "no internet" must never be the trigger: the journal
carries isolated `connectivity impacted` entries on days with no outage at
all (Sep 15, Sep 17). Acting on those would power a factory's ERP off over an
ISP blip — and nothing turns it back on, so the cost is a walk to the machine.

**The budget, measured rather than guessed.** During the last hard cut this
server recorded its own death:

```
08:59:57  tailscaled: connectivity impacted
09:00:57  tailscaled: "Your Internet connection might be down"
09:01:57  <log ends; machine dead>
```

The modem went quiet about two minutes before the server did.
`deploy/inverter-watch.sh` spends those two minutes in two stages rather than
one, because the two decisions have very different costs:

- **~10s of silence → take a snapshot.** About three seconds, entirely local,
  and harmless if this turns out to be a blip — retention prunes a spare dump.
  The data is banked before anything irreversible is considered.
- **~45s of silence → shut down.** By now it is not a dropped packet. Because
  the snapshot is already safe, this decision gets to be the slow one.

The snapshot runs with `--no-send`: the modem is down, so SMTP would only burn
its 45-second timeout against a draining battery. It is marked
`.pending-send` instead.

**It ships disarmed**, because a bug in something that can power off a
production server should cost a journal line rather than a working day:

```bash
sudo systemctl edit inverter-watch   # [Service] / Environment=INVERTER_WATCH_ENABLE=1
sudo systemctl restart inverter-watch
journalctl -t mtc-power -f
```

Rehearse it against an address known to be dead — which is how this was
verified against the live server:

```bash
sudo INVERTER_WATCH_GATEWAY=203.0.113.1 INVERTER_WATCH_POLL=2      INVERTER_WATCH_SHUTDOWN_AFTER=3 bash deploy/inverter-watch.sh
```

Two caveats worth knowing before arming it:

- **A deliberate modem reboot looks exactly like a modem that lost power**,
  and takes 30–90s to come back. Run `sudo systemctl stop inverter-watch`
  before power-cycling the modem on purpose.
- **Check the machine can come back by itself.** The desktop's BIOS wants
  *restore power state on AC loss*, and the VM wants *start automatically*
  with the VMware host. Without both, this shuts the server down correctly
  and then waits for a human.

#### Where the emergency copy goes, and why not Drive

It goes out by **email**, as an attachment, over the relay the app already
uses for password resets (`MAIL_SERVER`, to `EMERGENCY_BACKUP_TO` or
`MAIL_DEFAULT_SENDER`).

Google Drive was tried first and cannot work here. The credentials are a
**service account**; a service account owns whatever it uploads, and service
accounts have **zero bytes** of Drive storage. Only a Shared Drive bypasses
that — storage belongs to the organisation instead — and Shared Drives are a
Google Workspace feature that a consumer Gmail account does not have. The
upload fails with `storageQuotaExceeded`.

The trap is that the *spreadsheet* backup works fine, which looks like proof
that Drive is configured correctly. It is not: Google Sheets/Docs files are
exempt from storage quota and binary files are not.
`app/erp/services/drive_backup.py` is written and correct, and turns that
failure into these instructions rather than a stack trace — but it stays
unwired until the credentials become OAuth user credentials (scope
`drive.file`, consent screen set to **In production**, or Google expires the
refresh token after 7 days and backups stop silently).

Two things to know about the email route:

- **Size.** A compressed dump of this database is about 1 MB; base64 makes it
  ~1.4 MB against a Mailjet ceiling near 15 MB. `EMERGENCY_MAIL_MAX_BYTES`
  (10 MB) is checked *before* connecting, because a relay rejects an
  oversized message only after the whole attachment has gone up the wire —
  the most expensive possible way to discover a limit on a dying battery.
- **Exposure.** The attachment is the entire vendor, client, costing and
  payment history, passing through a third-party relay and landing in a
  mailbox. TLS covers it in transit. Keep that mailbox private, and consider
  encrypting the attachment if that is not good enough.

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
