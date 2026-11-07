# deploy/ — Ubuntu 24.04 / 26.04 LTS, without Docker

Full narrative, sizing and rationale: **[DEPLOYMENT.md § VPS Deployment](../DEPLOYMENT.md#vps-deployment-ubuntu-2404-lts)**.
This file is the short version.

**First install**, one command — clones, provisions, configures and starts:

```bash
sudo ./install.sh --repo <repo-url> --base-url http://192.168.1.50
```

**Every release after that:**

```bash
sudo /opt/mtc/src/Project-root/deploy/deploy.sh --ref v1.2.0
```

Or run the two underneath by hand, which is what `install.sh` wraps:

```bash
sudo ./provision.sh                                  # once per host
sudo -u mtc git clone <repo-url> /opt/mtc/src
sudoedit /etc/mtc/mtc.env                            # BASE_URL, Google creds, WEB_CONCURRENCY
sudo /opt/mtc/src/Project-root/deploy/deploy.sh      # every release
```

| File | Installed to | Purpose |
|---|---|---|
| `install.sh` | — | First install: clone + provision + configure + deploy, in one step. |
| `provision.sh` | — | Packages, timezone, PostgreSQL 17, Redis, nginx, unit. Idempotent. |
| `deploy.sh` | — | Pull, sync venv, verify runtime, migrate, restart, health-check. |
| `health.py` | `/usr/local/bin/mtc-health` | `/health` as a readable panel, plus unit states, disk, memory, load. |
| `backup.sh` | `/usr/local/bin/mtc-backup` | One verified snapshot, now. Local dump only — not the Sheets sync. |
| `mtc.service` | `/etc/systemd/system/` | gunicorn under systemd |
| `wait-for-deps.sh` | — | Startup gate: blocks until Postgres and Redis actually accept connections. |
| `offsite-pull.sh` | — | Runs on the laptop/NAS, not the server: fetches and verifies snapshots over Tailscale or a LAN. |
| `ups-setup.sh` | — | Gives the server a data link to its UPS (NUT), and wires the emergency snapshot to it. |
| `ups-notify.sh` | — | NUT event handler: snapshot+mail on ONBATT, kill it on LOWBATT. |
| `inverter-watch.sh` | — | No UPS data link: shuts down when the modem dies (inverter exhausted), not when mains fails. |
| `inverter-watch.service` | `/etc/systemd/system/` | Runs the inverter watchdog. Ships disarmed. |
| `mtc-boot-backup.service` | `/etc/systemd/system/` | At boot, mails any snapshot the outage could not send. |
| `nginx-mtc.conf` | `/etc/nginx/sites-available/mtc` | Reverse proxy, static, `/health` |
| `mtc.env.example` | `/etc/mtc/mtc.env` | Annotated config template |
| `POWER_OUTAGE_RESILIENCE.md` | — | Sites with long outages: what survives a hard cut, and what to fix on the host. |

Layout: `/opt/mtc/src` checkout · `/opt/mtc/venv` the one interpreter ·
`/etc/mtc/mtc.env` secrets (`root:mtc` `0640`) · service user `mtc`.

### Is it healthy?

`curl /health` answers a load balancer. `mtc-health` answers a person:

```bash
sudo ln -sf /opt/mtc/src/Project-root/deploy/health.py /usr/local/bin/mtc-health

mtc-health              # the panel, once
mtc-health --watch      # redraw every 5s
mtc-health --json       # the raw payload, for a script
```

Exits 0 healthy · 1 wants attention · 2 the app is not answering, so it also
works from cron. It reads `/health` for the application's own vitals and the
host for unit states, root disk, memory and load — and still draws when the
application is down, which is when it is worth having.

The database row is the cluster, `postgresql@17-main`, not `postgresql`. On
Debian that one is an umbrella that stays "active (exited)" whatever the
database is doing, so its uptime is the machine's. The cluster's name is also
the one to give `systemctl status` and `journalctl -u`.

### Take a snapshot before you touch something

```bash
sudo ln -sf /opt/mtc/src/Project-root/deploy/backup.sh /usr/local/bin/mtc-backup

sudo mtc-backup            # one verified snapshot, now
sudo mtc-backup --quiet     # silent unless it fails, for cron
```

The local dump only — `pg_dump`, verified by `pg_restore`, with its sha256
sidecar — not the Google Sheets sync the nightly job also runs. It holds the
same advisory lock as that job, so the two can never overlap, and it runs in
its own process, so it cannot disturb the running workers' connection pool
the way the in-app trigger does.

Restoring one is `pg_restore`; the snapshot is a custom-format archive:

```bash
pg_restore --clean --if-exists --no-owner --no-privileges \
    -d "$DATABASE_URL" /opt/mtc/src/backups/mtc_<stamp>.dump
```

### Getting the code onto the server without GitHub

Neither script requires a remote. `deploy.sh` pulls only when `/opt/mtc/src`
is a git checkout, and falls back to a `RELEASE` file (then to
`unversioned`) for the revision it reports. Pick whichever transport suits.

**A. A bare repo on the server — best for regular updates.** Keeps history
and tags, so `deploy.sh --ref v1.2.0` and rollbacks keep working, and never
leaves the LAN.

```bash
# on the server, once
sudo -u mtc git init --bare /opt/mtc/repo.git
sudo chgrp -R mtc /opt/mtc/repo.git && sudo chmod -R g+rwX /opt/mtc/repo.git
sudo usermod -aG mtc "$USER"          # your SSH login needs push rights; re-login after
sudo -u mtc git clone /opt/mtc/repo.git /opt/mtc/src

# on your machine, once
git remote add factory ssh://you@192.168.1.50/opt/mtc/repo.git

# every release
git push factory main --tags
sudo /opt/mtc/src/Project-root/deploy/deploy.sh --ref v1.2.0
```

Push as your own SSH user, not `mtc` — `mtc` has `nologin` by design, and it
only needs to *read* the bare repo.

**B. A tarball — simplest, and the one that works from Windows.**

```bash
# on your machine
git archive --format=tar.gz --prefix=src/ -o mtc-v1.2.0.tar.gz v1.2.0
scp mtc-v1.2.0.tar.gz you@192.168.1.50:/tmp/

# on the server -- extract OVER the tree, do not replace it (see below)
sudo tar -xzf /tmp/mtc-v1.2.0.tar.gz -C /opt/mtc/src --strip-components=1
echo v1.2.0 | sudo tee /opt/mtc/src/RELEASE
sudo chown -R mtc:mtc /opt/mtc/src
sudo /opt/mtc/src/Project-root/deploy/deploy.sh
```

> **Do not `rm -rf /opt/mtc/src` to get a clean tree.** `backup_service.py`
> resolves `backups/` to the repo root, so the nightly database dumps live
> at `/opt/mtc/src/backups` — deleting the directory to "start fresh"
> destroys every backup you have. Extracting over the top leaves them (and
> `logs/`) alone. The cost is that files deleted upstream linger; if that
> matters, move `backups/` aside first, then swap.

**C. rsync — fastest incremental, if you have it.**

```bash
rsync -a --delete \
  --exclude '.git' --exclude 'venv*' --exclude 'node_modules' \
  --exclude '.env' --exclude 'logs' --exclude 'backups' \
  ./ you@192.168.1.50:/opt/mtc/src/
sudo chown -R mtc:mtc /opt/mtc/src && sudo /opt/mtc/src/Project-root/deploy/deploy.sh
```

Excluding `backups` and `logs` is what keeps `--delete` safe here.

### Sites with unreliable power

If mains outages at the installation run for hours and the inverters do not
always outlast them, read
**[POWER_OUTAGE_RESILIENCE.md](POWER_OUTAGE_RESILIENCE.md)**. Short version:
committed data survives a hard cut, the service now comes back on its own
without anyone SSHing in, and the remaining work is a UPS with a data link
so the machine can shut down cleanly instead of being killed.

### After an Ubuntu release upgrade

Production went 24.04 → 26.04 with `do-release-upgrade` and was down most of
a day. Nothing here is hypothetical; each step below is one that bit.

**Before:** take a VMware snapshot, and run the upgrade inside `tmux`. An SSH
session that drops mid-upgrade leaves a half-upgraded system -- that is how
the new kernel ended up with no initramfs and panicked on boot
(`VFS: Unable to mount root fs on unknown-block(0,0)`). Make the GRUB menu
visible first, so an older kernel is one keypress away:

```bash
sudo sed -i 's/^GRUB_TIMEOUT_STYLE=.*/GRUB_TIMEOUT_STYLE=menu/' /etc/default/grub
sudo sed -i 's/^GRUB_TIMEOUT=.*/GRUB_TIMEOUT=10/' /etc/default/grub
sudo update-grub
```

**If it was interrupted:** boot the previous kernel from GRUB's *Advanced
options*, then finish the job:

```bash
sudo dpkg --configure -a && sudo apt -f install
sudo update-initramfs -c -k all && sudo update-grub
```

**After, in this order:**

1. **Network.** Check `ip a show ens33` has `192.168.31.86`. cloud-init can
   bring back a `50-cloud-init.yaml` (DHCP) next to `99-static.yaml`; keep
   only the static one and stop cloud-init rewriting it:
   `echo 'network: {config: disabled}' | sudo tee /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg`
2. **Third-party apt repos.** The upgrader disables them (renamed to
   `*.disabled`, `*.distUpgrade`, `*.migrate`). Re-add them for the new
   codename:
   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh
   sudo apt update && sudo apt upgrade      # NOT full-upgrade, NOT autoremove
   ```
3. **The venv.** `sudo ./deploy.sh --no-pull`. It notices the venv was built
   on the old Python and rebuilds it on the new one, verifying before it
   restarts anything. (Before this was automatic, the symptom was
   `ModuleNotFoundError: No module named 'psycopg2'` in `journalctl -u mtc`
   and a 502 from nginx.)
4. **Collation.** A new glibc changes text sort order, and Postgres warns
   `collation version mismatch` on every connection. Indexes on text are
   then in the wrong order until rebuilt (~seconds at this size):
   ```bash
   sudo mtc-backup
   for db in mtc postgres template1; do
     sudo -u postgres psql -d $db -c "REINDEX DATABASE $db;"
     sudo -u postgres psql -d $db -c "ALTER DATABASE $db REFRESH COLLATION VERSION;"
   done
   ```
5. `sudo mtc-health` → *All checks passed*, then a fresh snapshot.

Do **not** `apt autoremove` until the venv is on the new Python: it lists the
old `python3.X` as no longer required, and removing it breaks a venv that
still uses it. `apt-mark manual python3.X` protects it in the meantime.

### Three things that bite

- **Never put a `.env` in the checkout.** `config.py` calls
  `load_dotenv(override=True)`, so it *overrides* everything systemd sets.
  `deploy.sh` refuses to run if one exists.
- **`DB_POOL_MAX` is per worker.** The ceiling is
  `WEB_CONCURRENCY × DB_POOL_MAX` against Postgres' `max_connections`.
- **`PROXY_FIX` is required behind nginx.** Without it every user shares one
  rate-limit bucket and OAuth redirect URIs come out as `http://`.

### Rollback

```bash
sudo ./deploy.sh --ref <previous-tag>
```

Migrations are **not** reversed -- the runner only rolls forward. Check
`runner.py --status` and restore from `/opt/mtc/src/backups/` if a release
changed the schema in a way the previous code cannot read.
