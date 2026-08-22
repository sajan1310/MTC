#!/usr/bin/env bash
#
# MTC ERP — one-time host provisioning for Ubuntu 24.04 LTS.
#
#   sudo ./deploy/provision.sh
#
# Installs and configures everything the app needs from the OS, then stops.
# It does NOT deploy code: run deploy/deploy.sh afterwards. Idempotent --
# safe to re-run after editing.
#
# Ubuntu 24.04 specifically: its system Python is 3.12, which is what the
# Dockerfile pins and what CI tests (3.10/3.11/3.12). Ubuntu 25.x and
# Debian 13 ship Python 3.13, which CI has never run.
set -euo pipefail

APP_USER=mtc
APP_DIR=/opt/mtc
SRC_DIR="$APP_DIR/src"
ENV_FILE=/etc/mtc/mtc.env
DB_NAME=mtc
DB_USER=mtc
# 17, to match the development database a production install is restored
# FROM. pg_dump/pg_restore only move forward across versions: a dump taken
# on 17 cannot be loaded into 16, and you find that out half way through a
# migration with the new box already built. Ubuntu 24.04 ships 16, which is
# why provision.sh adds the PGDG repository rather than using the distro's.
# The app itself is version-agnostic (CI runs 14, docker-compose runs 16).
PG_VERSION=17
TIMEZONE="${TIMEZONE:-Asia/Kolkata}"

log()  { printf '\n==> %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }

[[ $EUID -eq 0 ]] || { echo "Run with sudo." >&2; exit 1; }

if ! grep -q 'VERSION_ID="24.04"' /etc/os-release 2>/dev/null; then
    warn "Not Ubuntu 24.04. Check that python3 --version is 3.10-3.12;"
    warn "outside that range the app runs on a version CI never tests."
fi

# ── Timezone ─────────────────────────────────────────────────────────────
# Not cosmetic. The app stores NAIVE datetimes and reads local time
# throughout -- date.today() decides the dashboard's "today's dispatches"
# and month-to-date totals, and supplies the DEFAULT order and dispatch
# dates WRITTEN TO THE DATABASE. Cloud images default to UTC, where "today"
# rolls over at 05:30 IST: every dispatch entered before then is filed under
# the previous day, and month-end closes half a day early.
log "Timezone -> $TIMEZONE"
timedatectl set-timezone "$TIMEZONE"

# ── Packages ─────────────────────────────────────────────────────────────
log "Installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends \
    python3 python3-venv python3-dev build-essential \
    git curl ca-certificates gnupg openssl \
    nginx redis-server \
    certbot python3-certbot-nginx \
    libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0
# ^ the last line is WeasyPrint's runtime, the same three packages the
#   Dockerfile installs. Without them the Download PDF endpoints return 503
#   and quietly fall back to the browser print dialog. The app keeps working,
#   so this is a fault you hear about from a user weeks later.

# PGDG, because Ubuntu 24.04 ships PostgreSQL 16 and $PG_VERSION above is 17
# -- see the note there for why the version has to match the database being
# restored from, not whatever the distro happens to package.
if [[ ! -f /etc/apt/sources.list.d/pgdg.list ]]; then
    log "Adding the PostgreSQL PGDG repository"
    install -d /usr/share/postgresql-common/pgdg
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
        -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
    codename="$(. /etc/os-release && echo "$VERSION_CODENAME")"
    printf 'deb [signed-by=%s] %s %s-pgdg main\n' \
        /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
        https://apt.postgresql.org/pub/repos/apt \
        "$codename" > /etc/apt/sources.list.d/pgdg.list
    apt-get update -qq
fi
apt-get install -y --no-install-recommends \
    "postgresql-$PG_VERSION" "postgresql-client-$PG_VERSION"

# ── Service account and directories ──────────────────────────────────────
log "Creating the $APP_USER user and directories"
id -u "$APP_USER" &>/dev/null || useradd --system --create-home \
    --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"

# logs/ resolves relative to the unit's WorkingDirectory, and backups/ to the
# REPO ROOT -- backup_service.py walks four levels up from itself, landing
# one level ABOVE Project-root. Both are created here and both are named in
# the unit's ReadWritePaths; ProtectSystem=strict makes everything else
# read-only, so a directory missed in one place fails in the other.
install -d -o "$APP_USER" -g "$APP_USER" -m 0755 \
    "$APP_DIR" "$SRC_DIR" "$SRC_DIR/backups" "$SRC_DIR/Project-root/logs"
install -d -o root -g "$APP_USER" -m 0750 /etc/mtc

# ── PostgreSQL ───────────────────────────────────────────────────────────
log "Configuring PostgreSQL $PG_VERSION"
systemctl enable --now postgresql

DB_PASS="$(openssl rand -hex 24)"
if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
    echo "    role $DB_USER already exists; leaving its password alone"
    DB_PASS=""
else
    sudo -u postgres psql -qc "CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASS'"
fi
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 \
    || sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"

# Tuning derived from the RAM actually present, so this is right on a 2 GB
# box as well as an 8 GB one.
RAM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
SHARED_BUFFERS=$((RAM_MB / 4))
EFFECTIVE_CACHE=$((RAM_MB * 3 / 5))
PG_CONF_D="/etc/postgresql/$PG_VERSION/main/conf.d"
install -d "$PG_CONF_D"
cat > "$PG_CONF_D/10-mtc.conf" <<PGCONF
# Managed by deploy/provision.sh -- edits here are overwritten on re-run.
# Sized for ${RAM_MB} MB of RAM, detected at provisioning time.

# The app's connection pool is per WORKER PROCESS, so the real ceiling is
# WEB_CONCURRENCY x DB_POOL_MAX. 120 leaves headroom above the recommended
# 9 x 6 = 54 for psql sessions, pg_dump, and a later worker-count bump.
max_connections = 120

shared_buffers = ${SHARED_BUFFERS}MB
effective_cache_size = ${EFFECTIVE_CACHE}MB
work_mem = 8MB
maintenance_work_mem = 512MB

# NVMe/SSD assumptions. On spinning disks raise random_page_cost to 4.
random_page_cost = 1.1
effective_io_concurrency = 200

# The app caps its own statements via DB_STATEMENT_TIMEOUT (60 s). This is
# the backstop for sessions opened outside it, such as an interactive psql.
statement_timeout = 300000
idle_in_transaction_session_timeout = 60000

log_min_duration_statement = 1000
PGCONF
systemctl restart postgresql

# ── Redis ────────────────────────────────────────────────────────────────
# Not optional: create_app() RAISES if the rate-limit backend is unreachable
# when FLASK_ENV=production, so a missing Redis is a boot failure, not a
# degraded start.
log "Configuring Redis"
cat > /etc/redis/redis-mtc.conf <<'REDISCONF'
# Managed by deploy/provision.sh. Included from the END of redis.conf so
# these directives win over the defaults above them.

bind 127.0.0.1 -::1
protected-mode yes

# Persistence off, deliberately. This Redis holds rate-limit counters and
# import-progress keys: both ephemeral, both self-expiring. With no RDB or
# AOF there is no background fork, which is the only reason a Redis this
# small would care about transparent hugepages or memory overcommit.
save ""
appendonly no

maxmemory 256mb
maxmemory-policy allkeys-lru
REDISCONF
grep -q 'redis-mtc.conf' /etc/redis/redis.conf \
    || echo 'include /etc/redis/redis-mtc.conf' >> /etc/redis/redis.conf
systemctl enable --now redis-server
systemctl restart redis-server

# ── systemd unit and nginx ───────────────────────────────────────────────
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
log "Installing the systemd unit and nginx site"
install -m 0644 "$HERE/mtc.service" /etc/systemd/system/mtc.service
systemctl daemon-reload
systemctl enable mtc

install -m 0644 "$HERE/nginx-mtc.conf" /etc/nginx/sites-available/mtc
ln -sfn /etc/nginx/sites-available/mtc /etc/nginx/sites-enabled/mtc
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# ── Environment file ─────────────────────────────────────────────────────
if [[ ! -f "$ENV_FILE" ]]; then
    log "Seeding $ENV_FILE"
    install -m 0640 -o root -g "$APP_USER" "$HERE/mtc.env.example" "$ENV_FILE"
    sed -i "s|^SECRET_KEY=.*|SECRET_KEY=$(openssl rand -hex 32)|" "$ENV_FILE"
    if [[ -n "$DB_PASS" ]]; then
        sed -i "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://$DB_USER:$DB_PASS@127.0.0.1:5432/$DB_NAME|" "$ENV_FILE"
    fi
else
    log "$ENV_FILE already exists; leaving it untouched"
    if [[ -n "$DB_PASS" ]]; then
        warn "A new database password was generated but the env file was not rewritten."
        warn "Set it by hand: DATABASE_URL=postgresql://$DB_USER:$DB_PASS@127.0.0.1:5432/$DB_NAME"
    fi
fi

CORES=$(nproc)
cat <<DONE

Provisioning complete. Still to do, in order:

  1. Edit $ENV_FILE

       BASE_URL         the URL browsers actually use. Its SCHEME decides
                        HTTPS enforcement, HSTS and Secure cookies -- use
                        http:// for a LAN box with no certificate, or nobody
                        will be able to stay logged in.

       GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
                        required for boot even when unused. Placeholders are
                        fine on a LAN, where Google Sign-In cannot work at
                        all (Google rejects private-IP redirect URIs).

       WEB_CONCURRENCY  (2 x cores) + 1. This host has $CORES cores -> $((CORES * 2 + 1)).

  2. Put the code in place and run the first deploy:

       sudo -u $APP_USER git clone <repo-url> $SRC_DIR
       sudo $SRC_DIR/Project-root/deploy/deploy.sh

  3. TLS, if this is internet-facing:

       sudo certbot --nginx -d your.domain

     then set BASE_URL=https://your.domain and: sudo systemctl restart mtc

DONE
