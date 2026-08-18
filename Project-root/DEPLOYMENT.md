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
   - [AWS/DigitalOcean/VPS](#vps-deployment)
5. [PDF Rendering (Chromium)](#pdf-rendering-chromium)
6. [Post-Deployment](#post-deployment)
7. [Monitoring & Maintenance](#monitoring--maintenance)
8. [Troubleshooting](#troubleshooting)
9. [Additional Deployment Guides](#additional-deployment-guides)

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
python run_migration.py
```

Or execute migrations manually:

```bash
psql $DATABASE_URL < migrations/add_indexes.sql
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

> **PDF rendering:** `pip install` does not download the Chromium build the
> server-side PDF renderer needs. See [PDF Rendering (Chromium)](#pdf-rendering-chromium)
> — without it, exported PDFs fall back to being images rather than searchable
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
   - **Build Command**: `pip install -r requirements.txt && playwright install --with-deps chromium`
   - **Start Command**: `gunicorn wsgi:app`

   The `playwright install` half is what enables server-side PDF rendering; see
   [PDF Rendering (Chromium)](#pdf-rendering-chromium). Without it the app still
   works, but exported PDFs are images rather than searchable documents.

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
heroku run python run_migration.py
```

---

### VPS Deployment

**Full control with Ubuntu/CentOS server.**

#### Prerequisites

- Ubuntu 20.04+ or CentOS 8+
- Root or sudo access
- Domain name pointed to server IP

#### Step 1: Install Dependencies

```bash
sudo apt update
sudo apt install -y python3 python3-pip python3-venv postgresql nginx certbot python3-certbot-nginx
```

#### Step 2: Setup PostgreSQL

```bash
sudo systemctl start postgresql
sudo -u postgres psql
CREATE DATABASE inventory_db;
CREATE USER inventory_user WITH ENCRYPTED PASSWORD 'secure_password';
GRANT ALL PRIVILEGES ON DATABASE inventory_db TO inventory_user;
\q
```

#### Step 3: Clone Repository

```bash
cd /var/www
sudo git clone https://github.com/yourusername/inventory-system.git
cd inventory-system/Project-root
```

#### Step 4: Setup Python Virtual Environment

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

#### Step 5: Configure Environment

```bash
sudo nano .env
```

Add all environment variables (see [Environment Configuration](#environment-configuration)).

#### Step 6: Setup Systemd Service

```bash
sudo nano /etc/systemd/system/inventory.service
```

```ini
[Unit]
Description=Inventory Management System
After=network.target

[Service]
User=www-data
Group=www-data
WorkingDirectory=/var/www/inventory-system/Project-root
Environment="PATH=/var/www/inventory-system/Project-root/venv/bin"
ExecStart=/var/www/inventory-system/Project-root/venv/bin/gunicorn wsgi:app --bind 127.0.0.1:8000 --workers 4

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl start inventory
sudo systemctl enable inventory
sudo systemctl status inventory
```

#### Step 7: Configure Nginx

```bash
sudo nano /etc/nginx/sites-available/inventory
```

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /static {
        alias /var/www/inventory-system/Project-root/static;
        expires 30d;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/inventory /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

#### Step 8: Setup SSL with Let's Encrypt

```bash
sudo certbot --nginx -d yourdomain.com
```

---

---

## PDF Rendering (Chromium)

Purchase orders, goods receipts and delivery challans are rendered to PDF
**server-side** by headless Chromium, which is what makes them real documents:
searchable, copyable, and a fraction of the size. Skipping this step does not
break anything — the app falls back to rendering in the browser — but the
fallback embeds each page as a JPEG, so a PO can no longer be searched for its
own PO number. See `docs/audit/PDF_GENERATION_REVIEW.md` PDF-002.

`pip install` brings in the Playwright **library**; it never downloads the
browser. That is a separate step, and it is the one that gets missed.

### What "missed" looks like

The app boots and works. On the first export you get, in the logs:

```
WARNING [PDF] server-side vector rendering DISABLED -- no chromium build under
/root/.cache/ms-playwright -- run: playwright install chromium. /erp/render-pdf
will return 503 and clients will fall back to client-side rasterisation ...
```

That warning is emitted **once at startup**, not only when somebody exports, so
it shows up in the deploy log rather than a week later.

### Docker / docker-compose

Already handled — the `Dockerfile` runs:

```dockerfile
RUN playwright install --with-deps chromium
```

This is the largest layer in the image (~400 MB). It sits after `pip install`
and before `COPY . .`, so ordinary code changes do not rebuild it.

### Railway

Railway uses the `Dockerfile` when one is present, which is the recommended
path here and needs no extra configuration. If you have forced Nixpacks/Procfile
detection instead, add a build step:

```bash
railway variables set NIXPACKS_BUILD_CMD="pip install -r requirements.txt && playwright install --with-deps chromium"
```

### Render

The default Build Command does not install the browser. Change it to:

```
pip install -r requirements.txt && playwright install --with-deps chromium
```

On Render's native Python environment `--with-deps` may not be able to apt-get
the shared libraries Chromium needs. If the build fails on that, deploy via
Docker instead (Render supports a Dockerfile-based service), which is the more
reliable route.

### Heroku / VPS

```bash
pip install -r requirements.txt
playwright install --with-deps chromium
```

On a VPS run it as the same user that runs gunicorn — browsers install into
that user's cache (`~/.cache/ms-playwright`), so installing as `root` and
serving as `www-data` silently leaves the renderer unavailable. Set
`PLAYWRIGHT_BROWSERS_PATH` to a shared location if the two differ.

### Verifying it

Run the smoke check on the deployed box. It probes for the browser, renders a
real document, and exits non-zero on failure, so it can gate a release step:

```bash
python -m app.erp.services.pdf_render_service
```

```
probe        : ok -- chromium available (chromium-1234)
render       : ok -- 17,423 bytes
output       : ok -- server-side vector rendering is working
```

### Memory

Each worker process holds its own Chromium once it has rendered something
(Playwright's sync API binds objects to their creating thread, so a single
shared browser is not possible). With gunicorn's default `--workers 4`, budget
for up to four. On a small instance either lower `WEB_CONCURRENCY` or accept
the client-side fallback by simply not installing the browser.

---

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

The `/health` endpoint can be used for:
- **Load balancer health checks**: Configure AWS ALB, Azure LB, or GCP Load Balancer to use `/health` as the health check path.
- **Uptime monitoring**: Services like UptimeRobot, Pingdom, or StatusCake can monitor `/health` and alert on failures.
- **Container orchestration**: Kubernetes liveness and readiness probes can use `/health` to determine pod health.

Example Kubernetes probe config:
```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 5000
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
2. Add database indexes (see `migrations/add_indexes.sql`)
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
