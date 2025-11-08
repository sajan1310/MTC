# 🛡️ Production Readiness Checklist

Complete checklist to ensure your Inventory Management System is production-ready.

---

## 📋 Pre-Launch Checklist

### Security

- [ ] **SECRET_KEY** generated with 32+ characters random string
- [ ] **DEBUG mode** disabled (`FLASK_ENV=production`)
- [ ] **HTTPS/SSL** enabled with valid certificate
- [ ] **CSRF protection** enabled (default in Flask-WTF)
- [ ] **Rate limiting** configured (Redis or in-memory)
- [ ] **SQL injection** protection verified (using parameterized queries)
- [ ] **XSS protection** headers set
- [ ] **Content Security Policy** configured
- [ ] **OAuth redirect URIs** whitelisted for production domain only
- [ ] **Database credentials** stored securely (environment variables, secrets manager)
- [ ] **File upload validation** enabled and tested
- [ ] **Session security** configured (secure cookies, httponly, samesite)
- [ ] **Dependency vulnerabilities** scanned (`pip-audit` or `safety check`)
- [ ] **Input validation** on all user-facing endpoints
- [ ] **Authentication** required for sensitive endpoints
- [ ] **Authorization** verified (role-based access control)

### Database

- [ ] **PostgreSQL version** 12+ running
- [ ] **Database migrations** applied successfully
- [ ] **Indexes created** for frequently queried columns (see `migrations/add_indexes.sql`)
- [ ] **Connection pooling** configured (min 4, max 20)
- [ ] **Query timeout** set (60 seconds recommended)
- [ ] **Backup strategy** implemented and tested
- [ ] **Point-in-time recovery** enabled (for managed databases)
- [ ] **Foreign key constraints** verified
- [ ] **Database user permissions** follow least privilege principle
- [ ] **Connection SSL/TLS** enabled for remote databases

### Application

- [ ] **All tests passing** (`pytest` runs without errors)
- [ ] **Static assets minified** (run `python minify_assets.py`)
- [ ] **Gunicorn workers** configured (recommended: 2-4 × CPU cores)
- [ ] **Worker timeout** set appropriately (120 seconds)
- [ ] **Health check endpoint** responding (`/health`)
- [ ] **Logging configured** (INFO level minimum, structured logs)
- [ ] **Error tracking** integrated (Sentry, Rollbar, or similar)
- [ ] **Performance monitoring** configured (New Relic, DataDog, or similar)
- [ ] **Environment variables** documented and set
- [ ] **OAuth configuration** tested end-to-end
- [ ] **Alert system** verified (UPF inventory alerts working)
- [ ] **Email notifications** configured (if applicable)
- [ ] **Cron jobs** scheduled (background workers, cleanup tasks)

### Infrastructure

- [ ] **Domain name** configured and DNS propagated
- [ ] **Load balancer** health checks configured (using `/health`)
- [ ] **Auto-scaling** configured (if using cloud platform)
- [ ] **CDN configured** for static assets (optional but recommended)
- [ ] **Firewall rules** configured (only necessary ports open)
- [ ] **DDoS protection** enabled
- [ ] **Monitoring alerts** configured (CPU, memory, disk, database)
- [ ] **Uptime monitoring** enabled (UptimeRobot, Pingdom)
- [ ] **Backup retention policy** defined (30 days recommended)
- [ ] **Disaster recovery plan** documented and tested

### Documentation

- [ ] **Deployment runbook** created
- [ ] **Environment variables** documented
- [ ] **API documentation** up to date
- [ ] **User guide** created for admin features
- [ ] **Incident response plan** documented
- [ ] **Rollback procedures** documented
- [ ] **Contact information** for on-call team documented

### Compliance & Legal

- [ ] **Privacy policy** published
- [ ] **Terms of service** published
- [ ] **Cookie consent** implemented (if applicable)
- [ ] **GDPR compliance** verified (if handling EU data)
- [ ] **Data retention policy** defined and implemented
- [ ] **User data export** functionality available
- [ ] **User data deletion** functionality available

---

## 🔒 Security Hardening

### Application Security

#### 1. Secure Headers

Add to `app/__init__.py`:

```python
from flask_talisman import Talisman

# Content Security Policy
csp = {
    'default-src': "'self'",
    'script-src': ["'self'", "'unsafe-inline'", "https://accounts.google.com"],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", "data:", "https:"],
    'font-src': ["'self'", "data:"],
}

Talisman(app, 
    content_security_policy=csp,
    force_https=True,
    strict_transport_security=True,
    session_cookie_secure=True,
    session_cookie_httponly=True,
    session_cookie_samesite='Lax'
)
```

Install: `pip install flask-talisman`

#### 2. Rate Limiting Configuration

Update `config.py`:

```python
# Rate limiting (production)
if ENV == 'production':
    RATELIMIT_STORAGE_URL = os.getenv('RATELIMIT_STORAGE_URL', 'redis://localhost:6379')
    RATELIMIT_STRATEGY = 'moving-window'
    RATELIMIT_DEFAULT = "200 per hour"
else:
    RATELIMIT_STORAGE_URL = 'memory://'
```

#### 3. Dependency Scanning

```bash
# Install security tools
pip install pip-audit safety

# Scan dependencies
pip-audit
safety check

# Update vulnerable packages
pip install --upgrade <package-name>
```

#### 4. Secret Management

**Never commit secrets to version control!**

Use environment variables or managed secret services:

- **AWS**: AWS Secrets Manager or Systems Manager Parameter Store
- **Azure**: Azure Key Vault
- **GCP**: Secret Manager
- **Heroku**: Config Vars
- **Railway/Render**: Environment Variables

### Database Security

#### 1. Connection Security

```python
# config.py - Enforce SSL for production databases
import os

DATABASE_URL = os.getenv('DATABASE_URL')
if DATABASE_URL and 'sslmode' not in DATABASE_URL:
    DATABASE_URL += '?sslmode=require'
```

#### 2. Least Privilege Access

```sql
-- Create read-only user for reporting/analytics
CREATE USER readonly_user WITH PASSWORD 'secure_password';
GRANT CONNECT ON DATABASE inventory_db TO readonly_user;
GRANT USAGE ON SCHEMA public TO readonly_user;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO readonly_user;

-- Revoke unnecessary permissions from main app user
REVOKE ALL ON SCHEMA information_schema FROM inventory_user;
REVOKE ALL ON pg_catalog.* FROM inventory_user;
```

#### 3. Audit Logging

Enable PostgreSQL audit logging:

```sql
-- postgresql.conf
log_statement = 'mod'  # Log all INSERT, UPDATE, DELETE
log_min_duration_statement = 1000  # Log queries > 1 second
```

### Infrastructure Security

#### 1. Firewall Configuration

```bash
# UFW (Ubuntu)
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP
sudo ufw allow 443/tcp   # HTTPS
sudo ufw enable

# Only allow PostgreSQL from app server
sudo ufw allow from <app-server-ip> to any port 5432
```

#### 2. SSH Hardening

```bash
# /etc/ssh/sshd_config
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
AllowUsers yourusername
```

#### 3. Fail2Ban

```bash
# Install fail2ban
sudo apt install fail2ban

# Configure for Nginx
sudo nano /etc/fail2ban/jail.local
```

```ini
[nginx-http-auth]
enabled = true
filter = nginx-http-auth
port = http,https
logpath = /var/log/nginx/error.log

[nginx-noscript]
enabled = true
port = http,https
filter = nginx-noscript
logpath = /var/log/nginx/access.log
maxretry = 6
```

---

## 📊 Performance Optimization

### Database Optimization

#### 1. Index Creation

Verify these indexes exist (from `migrations/add_indexes.sql`):

```sql
-- Check existing indexes
SELECT tablename, indexname, indexdef 
FROM pg_indexes 
WHERE schemaname = 'public' 
ORDER BY tablename, indexname;

-- Ensure critical indexes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_processes_status ON processes(status);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_production_lots_process_id ON production_lots(process_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_production_lots_status ON production_lots(status);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_inventory_alerts_lot_id ON production_lot_inventory_alerts(production_lot_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_inventory_alerts_severity ON production_lot_inventory_alerts(alert_severity);
```

#### 2. Connection Pooling

Verify `database.py` settings:

```python
DB_POOL_MIN = int(os.getenv('DB_POOL_MIN', 4))
DB_POOL_MAX = int(os.getenv('DB_POOL_MAX', 20))
```

Adjust based on:
- **Formula**: `DB_POOL_MAX = (num_workers * 2) + extra_connections`
- **Example**: 4 Gunicorn workers → 4 × 2 + 4 = 12 connections

#### 3. Query Optimization

Monitor slow queries:

```sql
-- Enable slow query logging
ALTER DATABASE inventory_db SET log_min_duration_statement = 1000;

-- Find slow queries
SELECT 
    query,
    calls,
    total_time,
    mean_time,
    max_time
FROM pg_stat_statements
ORDER BY mean_time DESC
LIMIT 10;
```

#### 4. VACUUM and ANALYZE

```bash
# Schedule maintenance (cron job)
0 2 * * * psql $DATABASE_URL -c "VACUUM ANALYZE;"
```

### Application Optimization

#### 1. Gunicorn Configuration

Create `gunicorn.conf.py`:

```python
import multiprocessing

# Worker processes
workers = multiprocessing.cpu_count() * 2 + 1
worker_class = 'gthread'
threads = 2
worker_connections = 1000

# Timeouts
timeout = 120
keepalive = 5

# Logging
accesslog = '-'
errorlog = '-'
loglevel = 'info'

# Performance
preload_app = True
max_requests = 1000
max_requests_jitter = 100

# Process naming
proc_name = 'inventory-system'

# Server socket
bind = '0.0.0.0:5000'
backlog = 2048
```

Run with: `gunicorn -c gunicorn.conf.py wsgi:app`

#### 2. Static Asset Optimization

```bash
# Minify CSS and JavaScript
python minify_assets.py

# Compress static files
find static/ -type f \( -name "*.css" -o -name "*.js" \) -exec gzip -k {} \;
```

Configure Nginx to serve compressed files:

```nginx
location /static {
    alias /var/www/inventory-system/Project-root/static;
    expires 30d;
    add_header Cache-Control "public, immutable";
    
    # Enable gzip
    gzip on;
    gzip_static on;
    gzip_types text/css application/javascript;
}
```

#### 3. Caching Strategy

Implement Redis caching for frequently accessed data:

```python
from flask_caching import Cache

cache = Cache(app, config={
    'CACHE_TYPE': 'redis',
    'CACHE_REDIS_URL': os.getenv('REDIS_URL', 'redis://localhost:6379/0')
})

@app.route('/api/processes')
@cache.cached(timeout=300)  # Cache for 5 minutes
def get_processes():
    # Expensive query
    return jsonify(processes)
```

### Infrastructure Optimization

#### 1. CDN Configuration

**CloudFlare (Free tier):**
1. Sign up and add domain
2. Update DNS nameservers
3. Enable "Always Use HTTPS"
4. Set caching rules for `/static/*`

**AWS CloudFront:**
```bash
aws cloudfront create-distribution \
  --origin-domain-name yourdomain.com \
  --default-cache-behavior MinTTL=86400,DefaultTTL=86400
```

#### 2. Load Balancer Health Checks

Configure health check to use `/health` endpoint:

- **Path**: `/health`
- **Interval**: 30 seconds
- **Timeout**: 5 seconds
- **Healthy threshold**: 2 consecutive successes
- **Unhealthy threshold**: 3 consecutive failures

#### 3. Auto-Scaling Rules

**AWS ECS:**
```bash
aws application-autoscaling register-scalable-target \
  --service-namespace ecs \
  --scalable-dimension ecs:service:DesiredCount \
  --resource-id service/inventory-cluster/inventory-service \
  --min-capacity 2 \
  --max-capacity 10

aws application-autoscaling put-scaling-policy \
  --service-namespace ecs \
  --scalable-dimension ecs:service:DesiredCount \
  --resource-id service/inventory-cluster/inventory-service \
  --policy-name cpu70-target-tracking \
  --policy-type TargetTrackingScaling \
  --target-tracking-scaling-policy-configuration file://scaling-policy.json
```

`scaling-policy.json`:
```json
{
  "TargetValue": 70.0,
  "PredefinedMetricSpecification": {
    "PredefinedMetricType": "ECSServiceAverageCPUUtilization"
  },
  "ScaleInCooldown": 300,
  "ScaleOutCooldown": 60
}
```

---

## 🔍 Monitoring & Alerting

### Application Monitoring

#### 1. Sentry Integration

```bash
pip install sentry-sdk[flask]
```

```python
# app/__init__.py
import sentry_sdk
from sentry_sdk.integrations.flask import FlaskIntegration
from sentry_sdk.integrations.sqlalchemy import SqlalchemyIntegration

if ENV == 'production':
    sentry_sdk.init(
        dsn=os.getenv('SENTRY_DSN'),
        integrations=[
            FlaskIntegration(),
            SqlalchemyIntegration()
        ],
        traces_sample_rate=0.1,  # 10% of transactions
        profiles_sample_rate=0.1,
        environment=ENV,
        release=os.getenv('RELEASE_VERSION', 'unknown')
    )
```

#### 2. Prometheus Metrics

```bash
pip install prometheus-flask-exporter
```

```python
# app/__init__.py
from prometheus_flask_exporter import PrometheusMetrics

metrics = PrometheusMetrics(app)
metrics.info('app_info', 'Inventory Management System', version='1.0.0')

# Custom metrics
from prometheus_client import Counter, Histogram

alert_acknowledgments = Counter(
    'inventory_alert_acknowledgments_total',
    'Total number of inventory alert acknowledgments',
    ['severity', 'user_action']
)

request_duration = Histogram(
    'http_request_duration_seconds',
    'HTTP request latency',
    ['method', 'endpoint']
)
```

Expose metrics at `/metrics` endpoint.

#### 3. Health Check Enhancements

Expand `/health` endpoint to include component health:

```python
@app.route('/health')
def health_check():
    health_status = {
        'status': 'healthy',
        'timestamp': datetime.utcnow().isoformat(),
        'version': os.getenv('RELEASE_VERSION', 'unknown'),
        'checks': {}
    }
    
    # Database check
    try:
        with database.get_conn() as (conn, cur):
            cur.execute('SELECT 1')
            health_status['checks']['database'] = 'connected'
    except Exception as e:
        health_status['checks']['database'] = f'error: {str(e)}'
        health_status['status'] = 'unhealthy'
    
    # Redis check (if using)
    try:
        redis_client.ping()
        health_status['checks']['redis'] = 'connected'
    except Exception as e:
        health_status['checks']['redis'] = f'warning: {str(e)}'
    
    status_code = 200 if health_status['status'] == 'healthy' else 503
    return jsonify(health_status), status_code
```

### Infrastructure Monitoring

#### 1. CloudWatch (AWS)

```bash
# Install CloudWatch agent
wget https://s3.amazonaws.com/amazoncloudwatch-agent/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb
sudo dpkg -i amazon-cloudwatch-agent.deb

# Configure CloudWatch
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-config-wizard
```

#### 2. Grafana Dashboard

Import pre-built dashboard for PostgreSQL and Flask apps:

- **PostgreSQL**: Dashboard ID 9628
- **Flask**: Dashboard ID 11022
- **Nginx**: Dashboard ID 12708

#### 3. Alert Rules

**CPU Usage Alert**:
```yaml
# Prometheus alert rule
- alert: HighCPUUsage
  expr: (100 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100) > 80
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "High CPU usage detected"
    description: "CPU usage is above 80% for more than 5 minutes."
```

**Database Connection Pool Alert**:
```yaml
- alert: DatabaseConnectionPoolExhausted
  expr: pg_stat_activity_count{state="active"} > 18
  for: 2m
  labels:
    severity: critical
  annotations:
    summary: "Database connection pool near limit"
    description: "Active database connections: {{ $value }}/20"
```

### Uptime Monitoring

**UptimeRobot (Free):**
1. Sign up at uptimerobot.com
2. Add monitor: HTTPS, `https://yourdomain.com/health`
3. Check interval: 5 minutes
4. Alert contacts: Email, SMS, Slack

**Pingdom:**
Similar setup with more advanced features in paid tiers.

---

## 🔄 Backup & Recovery

### Database Backup Strategy

#### 1. Automated Backups

**Heroku:**
```bash
heroku pg:backups:schedule DATABASE_URL --at '02:00 America/New_York'
```

**AWS RDS:**
- Automated backups: 7-35 days retention
- Manual snapshots: Retain indefinitely

**Custom Script** (`backup.sh`):
```bash
#!/bin/bash
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/backups"
DB_NAME="inventory_db"

pg_dump $DATABASE_URL > $BACKUP_DIR/backup_$DATE.sql
gzip $BACKUP_DIR/backup_$DATE.sql

# Upload to S3
aws s3 cp $BACKUP_DIR/backup_$DATE.sql.gz s3://your-bucket/backups/

# Clean old backups (keep 30 days)
find $BACKUP_DIR -name "backup_*.sql.gz" -mtime +30 -delete
```

Schedule with cron:
```cron
0 2 * * * /path/to/backup.sh
```

#### 2. Point-in-Time Recovery

Enable Write-Ahead Logging (WAL) archiving:

```sql
-- postgresql.conf
wal_level = replica
archive_mode = on
archive_command = 'aws s3 cp %p s3://your-bucket/wal-archive/%f'
```

#### 3. Restore Procedures

**From pg_dump backup:**
```bash
gunzip backup_20250108_020000.sql.gz
psql $DATABASE_URL < backup_20250108_020000.sql
```

**From Heroku backup:**
```bash
heroku pg:backups:restore b001 DATABASE_URL
```

### Application State Backup

Backup critical data:
- User sessions (if stored in database)
- Uploaded files
- Configuration settings

---

## 🚨 Incident Response

### Incident Response Plan

1. **Detection**: Monitoring alerts, user reports, error tracking
2. **Assessment**: Determine severity and impact
3. **Communication**: Notify stakeholders (status page, email)
4. **Mitigation**: Implement fix or rollback
5. **Resolution**: Verify fix, monitor stability
6. **Post-mortem**: Document root cause and prevention

### Rollback Procedure

**Heroku:**
```bash
heroku releases
heroku rollback v42
```

**Railway:**
```bash
railway rollback
```

**Docker/Kubernetes:**
```bash
kubectl rollout undo deployment/inventory-web
```

**Manual (VPS):**
```bash
cd /var/www/inventory-system
git checkout <previous-commit>
sudo systemctl restart inventory
```

### Status Page

Use services like:
- **StatusPage.io** (Atlassian)
- **Statuspage** (open source)
- **Cachet** (self-hosted)

---

## 📈 Scalability Recommendations

### Horizontal Scaling

- **Stateless application**: Ensure no local session storage
- **Database connection pooling**: Increase max connections as you scale
- **Load balancer**: Distribute traffic across multiple instances
- **Session storage**: Use Redis for shared session storage

### Vertical Scaling

- **Increase CPU/RAM**: For database-heavy workloads
- **Optimize queries**: Before adding more resources
- **Database read replicas**: For read-heavy applications

### Caching Strategy

- **Application-level**: Flask-Caching with Redis
- **Database query caching**: Redis or Memcached
- **CDN**: For static assets
- **Browser caching**: Set appropriate cache headers

---

## ✅ Launch Day Checklist

**24 Hours Before:**
- [ ] Final backup of production database
- [ ] Verify monitoring and alerts working
- [ ] Test rollback procedure
- [ ] Notify team of launch schedule

**Launch Day:**
- [ ] Deploy to production
- [ ] Run smoke tests
- [ ] Monitor error rates, CPU, memory
- [ ] Verify OAuth flow
- [ ] Test critical user workflows
- [ ] Monitor logs for errors

**Post-Launch (First Week):**
- [ ] Daily monitoring review
- [ ] Address any performance bottlenecks
- [ ] Collect user feedback
- [ ] Plan optimization iterations

---

## 🎓 Additional Resources

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [PostgreSQL Performance](https://wiki.postgresql.org/wiki/Performance_Optimization)
- [Flask Security](https://flask.palletsprojects.com/en/2.3.x/security/)
- [12 Factor App](https://12factor.net/)

---

**Last Updated**: November 2025
**Version**: 1.0.0
