# deploy/ — Ubuntu 24.04 LTS, without Docker

Full narrative, sizing and rationale: **[DEPLOYMENT.md § VPS Deployment](../DEPLOYMENT.md#vps-deployment-ubuntu-2404-lts)**.
This file is the short version.

```bash
sudo ./provision.sh                                  # once per host
sudo -u mtc git clone <repo-url> /opt/mtc/src
sudoedit /etc/mtc/mtc.env                            # BASE_URL, Google creds, WEB_CONCURRENCY
sudo /opt/mtc/src/Project-root/deploy/deploy.sh      # every release
```

| File | Installed to | Purpose |
|---|---|---|
| `provision.sh` | — | Packages, timezone, PostgreSQL 16, Redis, nginx, unit. Idempotent. |
| `deploy.sh` | — | Pull, sync venv, verify runtime, migrate, restart, health-check. |
| `mtc.service` | `/etc/systemd/system/` | gunicorn under systemd |
| `nginx-mtc.conf` | `/etc/nginx/sites-available/mtc` | Reverse proxy, static, `/health` |
| `mtc.env.example` | `/etc/mtc/mtc.env` | Annotated config template |

Layout: `/opt/mtc/src` checkout · `/opt/mtc/venv` the one interpreter ·
`/etc/mtc/mtc.env` secrets (`root:mtc` `0640`) · service user `mtc`.

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
