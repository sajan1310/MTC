# deploy/ — Ubuntu 24.04 LTS, without Docker

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
