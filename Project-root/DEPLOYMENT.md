# 🚀 Deployment Guide - Inventory Management System

Complete guide for deploying the Inventory Management System to production.

---

## 📋 Table of Contents

1. [Pre-Deployment Checklist](#pre-deployment-checklist)
2. [Environment Configuration](#environment-configuration)
3. [Database Setup](#database-setup)
4. [Deployment Platforms](#deployment-platforms)
   - [Railway](#railway-deployment)
   - [Render](#render-deployment)
   - [Heroku](#heroku-deployment)
   - [VPS / Ubuntu 24.04 (scripted)](#vps-deployment-ubuntu-2404-lts)
5. [LAN Deployment (factory WiFi, no internet)](#lan-deployment-factory-wifi-no-reliable-internet)
6. [PDF Export](#pdf-export)
7. [Post-Deployment](#post-deployment)
8. [Monitoring & Maintenance](#monitoring--maintenance)
9. [Troubleshooting](#troubleshooting)
10. [Additional Deployment Guides](#additional-deployment-guides)

---

## Pre-Deployment Checklist

Before deploying, ensure you have:

- [ ] PostgreSQL database provisioned (managed or self-hosted)
- [ ] Google OAuth credentials configured for production domain
- [ ] SECRET_KEY generated (32+ character random string)
- [ ] All environment variables documented
- [ ] Database migrations tested
- [ ] Tests passing (`pytest`)
- [ ] Static assets minified (optional: `python minify_assets.py`)

---

## Environment Configuration

### Required Environment Variables

Create a `.env` file or set these in your deployment platform:

```bash
# === Flask Configuration ===
SECRET_KEY=your-super-secret-key-min-32-chars-random
FLASK_ENV=production
ENV=production

# === Database Configuration ===
DATABASE_URL=postgresql://user:password@host:5432/dbname
DB_POOL_MIN=4
DB_POOL_MAX=20
DB_CONNECT_TIMEOUT=10
DB_STATEMENT_TIMEOUT=60000

# === Google OAuth ===
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
BASE_URL=https://yourdomain.com

# === Optional: Rate Limiting ===
RATELIMIT_STORAGE_URL=redis://localhost:6379

# === Optional: Logging ===
LOG_LEVEL=INFO
```

**Note:** The Universal Process Framework (UPF) inventory alert system requires no additional environment variables. All alert and monitoring features use the existing database connection.

### Generating SECRET_KEY

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

### Database URL Format

```
postgresql://username:password@host:port/database_name
```

Example:
```
postgresql://myuser:mypassword@db.example.com:5432/inventory_db
```

---

## Database Setup

### 1. Create PostgreSQL Database

**Managed Services (Recommended):**
- **Railway**: Provision PostgreSQL plugin → copy `DATABASE_URL`
- **Render**: Create PostgreSQL instance → copy internal connection string
- **Supabase**: Free PostgreSQL with 500MB storage
- **ElephantSQL**: Free tier with 20MB storage

**Self-Hosted:**
```bash
sudo -u postgres psql
CREATE DATABASE inventory_db;
CREATE USER inventory_user WITH ENCRYPTED PASSWORD 'secure_password';
GRANT ALL PRIVILEGES ON DATABASE inventory_db TO inventory_user;
\q
```

### 2. Run Migrations

After deployment, run:

```bash
# Connect via SSH or platform CLI
python migrations/erp/runner.py
```

Or execute migrations manually:

```bash
# (no manual step: runner.py applies every migration, indexes included)
```

---

## Deployment Platforms

### Railway Deployment

**Fastest deployment option (recommended for beginners).**

#### Step 1: Install Railway CLI

```bash
npm i -g @railway/cli
railway login
```

#### Step 2: Initialize Project

```bash
cd Project-root
railway init
railway link
```

#### Step 3: Add PostgreSQL

```bash
railway add postgresql
```

#### Step 4: Set Environment Variables

```bash
railway variables set SECRET_KEY=$(python -c "import secrets; print(secrets.token_hex(32))")
railway variables set GOOGLE_CLIENT_ID="your-client-id"
railway variables set GOOGLE_CLIENT_SECRET="your-secret"
railway variables set BASE_URL="https://your-app.up.railway.app"
```

#### Step 5: Deploy

```bash
railway up
```

**Railway will automatically:**
- Detect `Procfile`
- Install dependencies from `requirements.txt`
- Run `gunicorn wsgi:app`

> **PDF export** needs no build step and no browser install — it is the
> user's own browser print engine. See [PDF Export](#pdf-export).
> documents.

#### Step 6: Configure Domain

1. Go to Railway dashboard → Settings
2. Generate domain or add custom domain
3. Update `BASE_URL` environment variable
4. Update Google OAuth redirect URIs

---

### Render Deployment

**Great for free tier with auto-scaling.**

#### Step 1: Create Web Service

1. Go to [render.com](https://render.com) → New → Web Service
2. Connect GitHub repository
3. Configure:
   - **Name**: inventory-management
   - **Environment**: Python 3
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `gunicorn wsgi:app`

#### Step 2: Add PostgreSQL

1. Create PostgreSQL database in Render
2. Copy **Internal Database URL**
3. Add as environment variable `DATABASE_URL`

#### Step 3: Environment Variables

Add in Render dashboard → Environment:

```
SECRET_KEY=<generated-secret>
GOOGLE_CLIENT_ID=<your-client-id>
GOOGLE_CLIENT_SECRET=<your-secret>
BASE_URL=https://inventory-management.onrender.com
```

#### Step 4: Deploy

Render auto-deploys on git push to main branch.

**Manual Deploy:**
- Dashboard → Manual Deploy → Deploy latest commit

---

### Heroku Deployment

**Industry standard with extensive add-ons.**

#### Step 1: Install Heroku CLI

```bash
curl https://cli-assets.heroku.com/install.sh | sh
heroku login
```

#### Step 2: Create Heroku App

```bash
cd Project-root
heroku create your-app-name
```

#### Step 3: Add PostgreSQL

```bash
heroku addons:create heroku-postgresql:mini
```

#### Step 4: Set Environment Variables

```bash
heroku config:set SECRET_KEY=$(python -c "import secrets; print(secrets.token_hex(32))")
heroku config:set GOOGLE_CLIENT_ID="your-client-id"
heroku config:set GOOGLE_CLIENT_SECRET="your-secret"
heroku config:set BASE_URL="https://your-app-name.herokuapp.com"
```

#### Step 5: Deploy

```bash
git push heroku main
```

#### Step 6: Run Migrations

```bash
heroku run python migrations/erp/runner.py
```

---

### VPS Deployment (Ubuntu 24.04 LTS)

**Scripted. Do not follow these steps by hand -- `deploy/` does them, and does
the several that are easy to forget.**

| File | What it is |
|---|---|
| [`deploy/provision.sh`](deploy/provision.sh) | One-time host setup: packages, timezone, PostgreSQL 17, Redis, nginx, the systemd unit |
| [`deploy/deploy.sh`](deploy/deploy.sh) | Every deploy: pull, sync venv, **verify the runtime**, migrate, restart, health-check |
| [`deploy/mtc.service`](deploy/mtc.service) | systemd unit |
| [`deploy/nginx-mtc.conf`](deploy/nginx-mtc.conf) | Reverse proxy + static serving |
| [`deploy/mtc.env.example`](deploy/mtc.env.example) | Annotated `/etc/mtc/mtc.env` template |

#### Why Ubuntu 24.04 specifically

Its system Python is **3.12** -- what the Dockerfile pins and what CI tests
(3.10 / 3.11 / 3.12). There is no `requires-python` in the repo, so the CI
matrix *is* the support contract. It is also Debian-family, so WeasyPrint's
three packages carry the same names as in the Dockerfile.

Avoid Ubuntu 25.x and Debian 13 (Python 3.13, never tested by CI) and
RHEL/Rocky 9 (Python 3.9, below the floor, different package names).

#### Install

```bash
sudo ./deploy/provision.sh                 # once per host
sudo -u mtc git clone <repo-url> /opt/mtc/src
sudoedit /etc/mtc/mtc.env                  # BASE_URL, Google creds, WEB_CONCURRENCY
sudo /opt/mtc/src/Project-root/deploy/deploy.sh
sudo certbot --nginx -d your.domain        # if internet-facing
```

Layout: `/opt/mtc/src` (checkout), `/opt/mtc/venv` (the **one** interpreter),
`/etc/mtc/mtc.env` (secrets, `root:mtc` `0640`). The service runs as the
unprivileged `mtc` user.

#### Sizing

Concurrency is `--workers`, because these are **sync** workers -- one request
each, start to finish. Ordinary requests are ~2.4 ms, so they are never the
constraint; PDF rendering is, at ~0.66 s per document and one full core per
render.

| Load | Spec | `WEB_CONCURRENCY` | `DB_POOL_MAX` |
|---|---|---|---|
| ≤25 users, occasional exports | 2 vCPU / 4 GB | 5 | 6 |
| 25–100 users, exports routine | **4 vCPU / 8 GB** | 9 | 6 |

Use **dedicated** vCPU, not burstable. A 50-document export is ~33 seconds of
sustained single-core work, which drains the CPU credits on t3/t4g-class
instances and leaves the box throttled exactly when it is busiest.

RAM tracks `WEB_CONCURRENCY`, not user count: sessions are signed cookies and
connections are pooled, so 50 and 100 users cost the same. A worker is ~85 MB
until it renders a PDF and ~130 MB after.

`DB_POOL_MAX` is **per worker process**, so the ceiling is
`WEB_CONCURRENCY × DB_POOL_MAX` and it must stay under Postgres'
`max_connections`. The default 20 at 9 workers asks for 180 against a stock
limit of 100, which surfaces as "too many connections" and reads like a
database fault. 6 is measured: instrumenting all 8,158 `get_conn()`
acquisitions in the ERP suite showed a maximum of 3 held at once by any one
path, plus the audit and backup threads. `provision.sh` sets
`max_connections = 120` and sizes `shared_buffers` from actual RAM.

#### What the scripts do that a hand-written setup forgets

- **`ExecStartPre` runs the migrations.** `docker-entrypoint.sh` did this; a
  systemd unit written from scratch usually does not, and then new code runs
  against the old schema.
- **WeasyPrint's three apt packages.** Missing, the Download PDF endpoints
  return 503 and silently fall back to the print dialog. `requirements.txt`
  records this exact outage happening once already.
- **`deploy.sh` verifies the runtime before restarting.** It imports every
  critical dependency and calls `pdf_render_service.probe()` -- which is not
  the same as importing WeasyPrint, since that succeeds without the C
  libraries and only fails at render time. A bad deploy aborts while the old
  workers are still serving.
- **`PROXY_FIX=x_for=1,x_proto=1`.** Without it Flask trusts no proxy header,
  so every request looks like `127.0.0.1` over http. The rate limiter keys on
  `remote_addr`, putting the entire userbase in one 200/day bucket; and
  `url_for(_external=True)` emits `http://`, so Google rejects the OAuth
  `redirect_uri`.
- **`Asia/Kolkata`.** The app stores naive datetimes and reads local time for
  "today's dispatches", month-to-date totals, and the default order/dispatch
  dates it writes to the database. On a UTC host "today" rolls over at 05:30
  IST.
- **Writable `logs/` and `backups/`.** `create_app()` does
  `os.makedirs("logs")` relative to the working directory and raises if it
  cannot; `backup_service.py` resolves `backups/` to the **repo root**, one
  level above `Project-root`. Both are named in the unit's `ReadWritePaths`,
  which `ProtectSystem=strict` makes mandatory.
- **Redis before the app.** `create_app()` raises if the rate-limit backend
  is unreachable under `FLASK_ENV=production`; there is no fallback outside
  development. The unit `Requires=` it.
- **`LANG=C.UTF-8`.** Migration scripts print Unicode status characters and
  systemd gives a service no locale; an encoding error aborts a migration
  mid-transaction.

#### Operating it

```bash
sudo systemctl status mtc
journalctl -u mtc -f
sudo /opt/mtc/src/Project-root/deploy/deploy.sh --ref v1.2.0   # deploy a tag
sudo -u mtc /opt/mtc/venv/bin/python \
    /opt/mtc/src/Project-root/migrations/erp/runner.py --status
curl -s localhost:8000/health
```

> **Never put a `.env` in the checkout.** `config.py` calls
> `load_dotenv(override=True)`, which *overwrites* the process environment --
> a stray `.env` silently beats everything systemd sets, and the symptom is a
> value with no visible source. `deploy.sh` refuses to run if one exists.

---


## LAN Deployment (factory WiFi, no reliable internet)

**The UI needs no internet. Sign-in, password reset and the Sheets backup do.**

A server on the shop-floor LAN (`http://192.168.1.50:8000`) is a supported
deployment, but three things behave differently from an internet-facing one.
Read this before provisioning.

### Moving an existing system across

**Everything lives in PostgreSQL. One dump carries the lot.**

There is no file storage to migrate — not because it was left out, but by
design. The company logo is `erp.company_settings.logo_data_url` and item
photos are `erp.items.image`, both base64 data URLs in TEXT columns (see
migration `024_items_image.sql`). Users, password hashes, roles, company
settings, every lot, PO and ledger row are ordinary tables.
`static/uploads/` holds only git-tracked legacy files that travel with the
code.

`erp.migrations_applied` is in the dump too, so the restored database
arrives knowing which migrations it has, and the next `deploy.sh` applies
only what is genuinely new.

**On the old machine:**

```bash
pg_dump --format=custom --no-owner --no-privileges \
        -U postgres -d MTC -f mtc.dump
```

`--no-owner --no-privileges` because the new database is owned by the `mtc`
role, not by whatever owns it today.

**On the new server** — provision and place the code, but do **not** start
the app yet, or it will build an empty schema you then have to restore over:

```bash
sudo ./install.sh --repo <url> --base-url http://192.168.1.50 --no-deploy

sudo -u postgres pg_restore --no-owner --role=mtc -d mtc /tmp/mtc.dump
sudo /opt/mtc/src/Project-root/deploy/deploy.sh
```

**Version matters and only moves one way.** `pg_restore` can load an older
dump into a newer server, never the reverse. `provision.sh` installs
PostgreSQL 17 for exactly this reason; if the machine you are dumping from
is newer than that, raise `PG_VERSION` in `provision.sh` to match before
provisioning. Check with `psql -c "SHOW server_version"`.

**Config does not come across in the dump.** `/etc/mtc/mtc.env` is written
fresh by `provision.sh` with a new `SECRET_KEY` and database password.
Carry over only the values that are genuinely yours — mail settings, Google
credentials if the deployment can still use them — and leave `BASE_URL` and
`DATABASE_URL` as the new machine set them.

### 0. Before you cut over: every user needs a password

**Do this while the internet still works. There is no way to do it afterwards.**

An account created through Google sign-in has no password —
`get_or_create_user()` inserts name, email, role and picture, and nothing
else. That is invisible online and total offline: on the LAN there is no
route to `accounts.google.com`, and Google will not register a private-IP
redirect URI in any case, so the account cannot sign in **at all**.

Such users now see a standing banner prompting them to set one (My Profile →
Set a Password; the *Current Password* field is hidden for an account that
has none, so there is nothing to leave blank). The banner can be dismissed,
but only for the current browser session — it returns on the next sign-in,
because what it warns about does not go away by being acknowledged.

**First, make sure the form it points at can actually work.** On a database
provisioned before `users.updated_at` existed, every `UPDATE users` — Set
Password included — fails with `UndefinedColumn`, which the RPC layer masks
as *"Something went wrong on our end. If this keeps happening, quote
reference …"*. The banner then warns about a lockout and points at a form
that cannot possibly fix it. `035_users_updated_at` repairs this; confirm it
is applied:

```bash
sudo -u mtc /opt/mtc/venv/bin/python     /opt/mtc/src/Project-root/migrations/erp/runner.py --status
```

It is also not blocking, so it does not guarantee coverage. **Check before
you cut over:**

```sql
SELECT email, name, role
FROM users
WHERE password_hash IS NULL AND deleted_at IS NULL
ORDER BY email;
```

Every row is a person who will be locked out the moment the server moves to
the LAN. Chase them while they can still sign in with Google.

For anyone who slips through, an admin can create a fresh account for them
with a password (Users → Add User). The forgot-password route also works for
a passwordless account now — it used to filter those out, which shut the one
self-service door on exactly the people who needed it — but that needs SMTP,
which the LAN will not have either, so it is an *online* remedy, not a
rescue after the fact.

### 1. Sign in with email + password, not Google

**Google Sign-In cannot work on a private address.** Google only accepts
`localhost` or a public HTTPS domain as an OAuth redirect URI -- it will
reject `http://192.168.1.50:8000/auth/google/callback` at registration time --
and the flow has to reach `accounts.google.com` anyway. On a LAN the
"Sign in with Google" button on the login page will fail.

Users log in with email and password (the form posts to
`/auth/api/login`). Create accounts through the normal signup/admin flow.

> The button is rendered unconditionally in `templates/login.html`, so it is
> visible but dead on a LAN. If that generates support calls, gate it on a
> config flag -- it is a one-line `{% if %}`.

**The app still refuses to start without Google credentials.** `_load_config()`
lists `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` as required in every
non-testing config, so an empty value aborts boot with
`Missing required configuration keys`. Set placeholders:

```bash
GOOGLE_CLIENT_ID=unused-on-lan
GOOGLE_CLIENT_SECRET=unused-on-lan
```

### 2. Password reset has no email, but the link is in the log

`MAIL_SERVER` points at an SMTP relay, which needs internet. Leave it unset on
an isolated LAN: `/auth/api/forgot-password` then logs

```
[ForgotPassword] Reset link for <email>: http://192.168.1.50:8000/auth/reset-password/<token>
```

at INFO level and warns that the user cannot receive it. An administrator
reads the link out of the log (`journalctl -u mtc` or `logs/app.log`) and
passes it on. The request still succeeds and still returns the same response
either way, so the flow does not leak which addresses are registered.

### 3. Plain HTTP works, but a certificate is better

`SESSION_COOKIE_SECURE` follows `BASE_URL`'s scheme. Set
`BASE_URL=http://192.168.1.50:8000` and the session cookie is issued without
`Secure`, so the browser sends it back over HTTP and login persists.
`force_https` and HSTS switch off on the same signal.

That means the session cookie crosses the WiFi in the clear. On a WPA2/WPA3
network it is not readable by a passive outsider, but anyone with the WiFi
password is on the same broadcast domain. **Prefer an internal certificate**
-- give the box a hostname, issue a cert from an internal CA (or self-sign and
install the root on the tablets), and set `BASE_URL=https://mtc.local`. Every
hardening flag turns itself back on with no other change.

Do **not** reach for `FLASK_ENV=development` to work around a cookie problem:
it enables the debugger, restricts CORS to localhost, and the app raises
`Application running with debug=True in production environment` by design.

### 4. What still tries to reach the internet

| Feature | Without internet |
|---|---|
| The whole UI (jQuery, Bootstrap, icons, fonts, charts, Excel) | **Works** -- all self-hosted, see below |
| Email password reset | Link is logged instead (§2) |
| Google Sign-In | Unavailable (§1) |
| Nightly Google Sheets backup | Fails and logs; the **local SQL dump still runs** |

### 5. Third-party assets are self-hosted

Everything the browser loads comes from `static/erp/vendor/` -- jQuery,
Bootstrap, Bootstrap Icons, Select2, htm/preact, SortableJS, Chart.js, SheetJS
and the Inter/Outfit/Oswald webfonts (Latin subsets). Nothing is fetched from
`cdn.jsdelivr.net`, `code.jquery.com` or Google Fonts at runtime, and the CSP
no longer permits those hosts.

This is not a preference. The service worker caches only same-origin
`/static/erp/` URLs, so while these came from a CDN they were never in the
offline shell: with no internet the browser fetched no jQuery, and with no
jQuery none of the app's JavaScript ran -- a blank page. It failed unevenly
too, since devices with a warm HTTP cache kept working, which makes it a
miserable fault to diagnose.

**To update one:** replace the file in `static/erp/vendor/`, update the
reference, and **bump `CACHE_NAME` in `static/erp/sw.js`** -- otherwise
installed clients keep serving the old shell forever. Verify a download
against the publisher's SRI hash before committing it:

```bash
curl -sL <url> | openssl dgst -sha384 -binary | openssl base64 -A
```

Do not re-add a CDN host to fix a missing library. Vendor it.

---

## PDF Export

**Printing needs nothing installed. Downloading needs three apt packages.**

Every document in the app --
purchase orders, goods receipts, delivery challans, ledgers, production sheets
-- is produced by the browser's own print engine via `window.print()`. Choosing
"Save as PDF" in the print dialog yields a real document: selectable text,
searchable, copyable, readable by a screen reader.

This replaced two earlier renderers, and the deployment story is the whole
reason it is simpler now:

| | Before | Now |
|---|---|---|
| Server dependency | Playwright + a ~400 MB Chromium layer | none |
| Client dependency | a 946 KB vendored `html2pdf.js` bundle | none |
| Searchable output | only when Chromium was installed | always |
| Works offline | yes, but as unsearchable images | yes, unchanged |
| Env vars | `PDF_SERVER_RENDER` | none |

Because Chromium was a ~400 MB image layer it was **off by default**, which
meant a default deployment silently produced image-based PDFs. That failure
mode no longer exists: there is no configuration that can turn searchable
output off.

### What users do

Every button is where it always was. **Print** and **Download PDF** both open
the print dialog; choosing "Save as PDF" there produces the file.

- **One document** -- the row's Print or Download PDF button.
- **Several documents** -- select rows, then Print Selected or Download PDFs.
  They arrive as one multi-page PDF, one record per page.

Chrome and Edge pre-fill the save dialog's filename from `document.title`,
which the app sets per document (`App.Print.trigger`), so files still land
named `PO_1041_Acme` rather than `document.pdf`.

### Download PDF: the one thing that needs installing

A print dialog cannot hand back a *file*, so the **Download PDF** buttons post
the same HTML to WeasyPrint, which returns bytes. **Download PDFs** on a ledger
returns a ZIP of one separately-named PDF per selected record.

```
Debian / Ubuntu / Docker
    apt install libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0
    (already in the Dockerfile)

Windows (dev)
    winget install --id=MSYS2.MSYS2 -e
    C:/msys64/usr/bin/pacman -S --noconfirm mingw-w64-x86_64-pango
    then add C:/msys64/mingw64/bin to PATH
```

Check it with:

```bash
python -m app.erp.services.pdf_render_service
```

**It degrades, it does not break.** Without the libraries the endpoint returns
503, Download PDF falls back to the print dialog, and the app says so once. The
output is still a searchable vector PDF -- you just pick the destination
yourself, and bulk export gives one multi-page document instead of N files. The
boot log states which mode this deployment is in.

> **Not restored:** folder-write delivery (File System Access API). Bulk export
> returns one archive; see `docs/audit/PDF_GENERATION_REVIEW.md` PDF-010.

## Post-Deployment

### 1. Verify Health Endpoint

```bash
curl https://yourdomain.com/health
```

Expected response:
```json
{
  "status": "healthy",
  "database": "connected",
  "timestamp": "2025-01-12T10:30:00Z"
}
```

It returns **200** when the database answers and **503** when it does not, so a
load balancer actually drains a broken instance instead of leaving it in
rotation behind a cheerful 200. The check is exempt from the rate limiter --
`RATELIMIT_DEFAULT` is 200/day and a 10-second probe interval is 8,640
requests/day, which would otherwise start returning 429 within the hour and
fail every instance at once.

The `/health` endpoint can be used for:
- **Load balancer health checks**: Configure AWS ALB, Azure LB, or GCP Load Balancer to use `/health` as the health check path.
- **Uptime monitoring**: Services like UptimeRobot, Pingdom, or StatusCake can monitor `/health` and alert on failures.
- **Container orchestration**: Kubernetes liveness and readiness probes can use `/health` to determine pod health.

Example Kubernetes probe config:
```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 8000        # Dockerfile EXPOSEs 8000; docker-entrypoint.sh binds ${PORT:-8000}
  initialDelaySeconds: 30
  periodSeconds: 10
```

### 2. Test OAuth Login

1. Go to `https://yourdomain.com/login`
2. Click "Sign in with Google"
3. Verify redirect to Google
4. Verify callback success

### 3. Create Admin User

```bash
# Via Python shell
python
>>> from app import app
>>> from database import get_conn
>>> with app.app_context():
...     with get_conn() as (conn, cur):
...         cur.execute("UPDATE users SET role='admin' WHERE email='your@email.com'")
...     print("Admin user created")
```

### 4. Run Smoke Tests

```bash
pytest tests/test_smoke.py -v
```

---

## Monitoring & Maintenance

### Metrics (`/metrics`)

Prometheus exposition format. **Not public**: it answers an admin session or a
bearer token, and returns 404 to anything else so a prober cannot confirm it
exists.

```bash
# .env
METRICS_TOKEN=$(python -c "import secrets; print(secrets.token_urlsafe(32))")
```

```yaml
# prometheus.yml
scrape_configs:
  - job_name: mtc
    authorization:
      credentials: <METRICS_TOKEN>
    static_configs:
      - targets: ['mtc.internal:8000']
```

Worth alerting on:

| Metric | Why it matters |
|---|---|
| `mtc_database_up == 0` | the application cannot reach Postgres |
| `mtc_db_connections{state="idle in transaction"}` rising | a leaked transaction holding locks |
| `mtc_db_connections` approaching `mtc_db_max_connections` | pool exhaustion — this pool raises `PoolError`, it does not queue |
| `mtc_mutations_in_progress` rising | requests dying mid-mutation |
| `mtc_warehouse_pool_negative_rows` increasing | new over-allocation despite the DATA-002 locks |
| `mtc_admin_accounts` changing unexpectedly | an admin created outside the approval flow |

**There are no request-rate metrics, deliberately.** With 4 workers behind one
port, a scrape reaches one worker, so a per-worker counter would report a
random fraction of traffic. Use the reverse proxy's access log, which sees
every request exactly once. Adding real request metrics means configuring
`prometheus_client` multiprocess mode — a dependency, a shared writable
directory, `PROMETHEUS_MULTIPROC_DIR`, and a gunicorn `child_exit` hook.

### Application Logs

**Railway:**
```bash
railway logs
```

**Render:**
Dashboard → Logs tab

**Heroku:**
```bash
heroku logs --tail
```

**VPS:**
```bash
sudo journalctl -u inventory -f
```

### Database Backups

**Automated Backups:**
- Railway: Automatic daily backups
- Render: Point-in-time recovery
- Heroku: `heroku pg:backups:schedule`

**Manual Backup:**
```bash
pg_dump $DATABASE_URL > backup_$(date +%Y%m%d).sql
```

### Performance Monitoring

**Recommended Tools:**
- **Sentry**: Error tracking
- **New Relic**: APM monitoring
- **Prometheus + Grafana**: Metrics
- **UptimeRobot**: Uptime monitoring

**Add Sentry:**
```bash
pip install sentry-sdk[flask]
```

```python
# In app.py
import sentry_sdk
from sentry_sdk.integrations.flask import FlaskIntegration

sentry_sdk.init(
    dsn="your-sentry-dsn",
    integrations=[FlaskIntegration()],
    traces_sample_rate=1.0
)
```

---

## Troubleshooting

### Issue: 404 on OAuth Callback

**Cause**: Redirect URI mismatch.

**Solution**:
1. Check `BASE_URL` environment variable matches deployed domain
2. Verify Google Console redirect URIs include: `https://yourdomain.com/auth/google/callback`
3. Run diagnostic: `python check_oauth_config.py`

### Issue: Database Connection Failed

**Cause**: Incorrect `DATABASE_URL` or network issue.

**Solution**:
```bash
# Test connection
psql $DATABASE_URL -c "SELECT 1"

# Check environment variable
echo $DATABASE_URL
```

### Issue: 500 Internal Server Error

**Cause**: Application error.

**Solution**:
1. Check logs for stack trace
2. Verify all environment variables are set
3. Run locally: `python run_production.py`
4. Check database migrations ran successfully

### Issue: Static Files Not Loading

**Cause**: Nginx misconfiguration or missing files.

**Solution**:
```bash
# Verify files exist
ls -la /var/www/inventory-system/Project-root/static

# Check Nginx config
sudo nginx -t

# Restart Nginx
sudo systemctl restart nginx
```

### Issue: Slow Performance

**Cause**: Insufficient database pool size or unoptimized queries.

**Solution**:
1. Increase `DB_POOL_MAX` environment variable
2. Database indexes ship as migrations -- `python migrations/erp/runner.py`
3. Monitor slow queries: `heroku pg:ps` or check PostgreSQL logs

---

## Additional Deployment Guides

For more comprehensive deployment scenarios, see:

### 📦 [Docker & Container Orchestration](docs/DEPLOYMENT_DOCKER.md)
Complete guide for containerized deployments including:
- **Docker Compose**: Local development with PostgreSQL + Redis
- **Docker Swarm**: Simple production clustering
- **Kubernetes**: Full orchestration with auto-scaling
- **AWS ECS**: Managed container service on AWS
- Best practices for image optimization and security

### 🛡️ [Production Readiness Checklist](docs/PRODUCTION_READINESS.md)
Comprehensive pre-launch and post-launch checklist covering:
- **Security Hardening**: HTTPS, headers, secrets management, vulnerability scanning
- **Performance Optimization**: Database indexing, connection pooling, caching
- **Monitoring & Alerting**: Sentry, Prometheus, CloudWatch, uptime monitoring
- **Backup & Recovery**: Automated backups, disaster recovery procedures
- **Incident Response**: Rollback procedures, status pages, post-mortems
- **Scalability**: Horizontal/vertical scaling, load balancing strategies

### 📊 [UPF Inventory Alerts Usage](docs/UPF_INVENTORY_ALERTS_USAGE.md)
Complete guide for the Universal Process Framework inventory alert system:
- API endpoints for alert management and monitoring
- Health metrics dashboard at `/monitoring`
- Bulk acknowledgment workflows
- Finalize blocking on CRITICAL alerts
- Integration examples and troubleshooting

### 🎨 [Alert UI Integration Guide](docs/ALERT_UI_INTEGRATION.md)
Developer guide for integrating alert UI components:
- HTML structure examples with Jinja2 syntax
- JavaScript API usage (ProductionLotAlertHandler)
- CSS class reference for severity badges and status indicators
- User action options (PROCEED, USE_SUBSTITUTE, DELAY, PROCURE)
- Troubleshooting common integration issues

---

## Additional Resources

- [Flask Production Deployment](https://flask.palletsprojects.com/en/2.3.x/deploying/)
- [PostgreSQL Performance Tuning](https://wiki.postgresql.org/wiki/Performance_Optimization)
- [Google OAuth Setup](https://developers.google.com/identity/protocols/oauth2)
- [Gunicorn Configuration](https://docs.gunicorn.org/en/stable/configure.html)
- [Docker Best Practices](https://docs.docker.com/develop/dev-best-practices/)
- [Kubernetes Documentation](https://kubernetes.io/docs/home/)
- [OWASP Security Guide](https://owasp.org/www-project-top-ten/)

---

## Support

For issues or questions:
1. Check existing GitHub Issues
2. Review application logs
3. Run diagnostic tools: `python check_oauth_config.py`
4. Create new issue with logs and environment details

---

**Last Updated**: November 2025
**Version**: 1.1.0
