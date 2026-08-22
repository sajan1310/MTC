#!/usr/bin/env bash
#
# MTC ERP — deploy the current checkout.
#
#   sudo /opt/mtc/src/Project-root/deploy/deploy.sh          # deploy HEAD
#   sudo .../deploy.sh --ref v1.2.0                          # deploy a tag
#   sudo .../deploy.sh --no-pull                             # deploy what is on disk
#
# Idempotent, and safe to re-run. Run deploy/provision.sh once first.
#
# Order matters here: dependencies are installed and VERIFIED before the
# service is restarted, so a broken deploy fails while the old workers are
# still serving traffic rather than after they have been replaced.
set -euo pipefail

APP_USER=mtc
APP_DIR=/opt/mtc
SRC_DIR="$APP_DIR/src"
VENV_DIR="$APP_DIR/venv"
PROJECT_DIR="$SRC_DIR/Project-root"
ENV_FILE=/etc/mtc/mtc.env
HEALTH_URL=http://127.0.0.1:8000/health

REF=""
PULL=1
while [[ $# -gt 0 ]]; do
    case "$1" in
        --ref)     REF="$2"; shift 2 ;;
        --no-pull) PULL=0; shift ;;
        *) echo "Unknown argument: $1" >&2; exit 2 ;;
    esac
done

log()  { printf '\n==> %s\n' "$*"; }
fail() { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "Run with sudo."
[[ -f "$ENV_FILE" ]] || fail "$ENV_FILE missing. Run deploy/provision.sh first."
[[ -d "$PROJECT_DIR" ]] || fail "$PROJECT_DIR missing. Clone the repo to $SRC_DIR first."

# A .env inside the checkout would beat everything in $ENV_FILE: config.py
# calls load_dotenv(override=True), which overwrites the process environment
# rather than filling gaps in it. That silently ignores systemd's settings,
# and the symptom is a value you cannot find the source of.
if [[ -f "$PROJECT_DIR/.env" ]]; then
    fail "$PROJECT_DIR/.env exists and would OVERRIDE $ENV_FILE (load_dotenv(override=True)). Remove it."
fi

# ── Code ─────────────────────────────────────────────────────────────────
if [[ $PULL -eq 1 ]]; then
    log "Fetching code"
    sudo -u "$APP_USER" git -C "$SRC_DIR" fetch --all --tags --prune
    if [[ -n "$REF" ]]; then
        sudo -u "$APP_USER" git -C "$SRC_DIR" checkout --force "$REF"
    else
        sudo -u "$APP_USER" git -C "$SRC_DIR" pull --ff-only
    fi
fi
DEPLOYED_REF="$(git -C "$SRC_DIR" rev-parse --short HEAD)"
log "Deploying $DEPLOYED_REF"

# ── Virtualenv ───────────────────────────────────────────────────────────
# ONE interpreter, at an absolute path, matching the unit's ExecStart.
# requirements.txt documents the outage this prevents: the server ran from
# venv2 while WeasyPrint had been installed into venv, so Download PDF
# returned 503 and reported the renderer as unavailable. A missing package
# here degrades silently instead of crashing, which is exactly why it went
# unnoticed -- hence the explicit verification below, not just an install.
[[ -d "$VENV_DIR" ]] || {
    log "Creating $VENV_DIR"
    python3 -m venv "$VENV_DIR"
    chown -R "$APP_USER:$APP_USER" "$VENV_DIR"
}

log "Syncing dependencies"
"$VENV_DIR/bin/pip" install --quiet --upgrade pip
"$VENV_DIR/bin/pip" install --quiet -r "$PROJECT_DIR/requirements.txt"
chown -R "$APP_USER:$APP_USER" "$VENV_DIR"

log "Verifying the runtime"
# cd first: the check imports app.erp.services, which resolves only with
# Project-root as the working directory -- the same one the unit sets.
cd "$PROJECT_DIR"
"$VENV_DIR/bin/python" - <<'PYCHECK' || fail "Runtime verification failed -- not restarting the service."
import sys

# Fail the DEPLOY on a missing dependency rather than letting a feature
# degrade quietly in production. Each of these is a silent failure mode:
#   weasyprint  -> Download PDF returns 503, falls back to the print dialog
#   redis       -> create_app() raises at boot under FLASK_ENV=production
#   gunicorn    -> the unit's ExecStart is simply not there
missing = []
for mod, why in (
    ("flask",      "the application itself"),
    ("psycopg2",   "every database call"),
    ("gunicorn",   "the WSGI server the unit starts"),
    ("redis",      "rate-limit storage; create_app() raises without it"),
    ("weasyprint", "Download PDF; degrades to 503 rather than crashing"),
):
    try:
        __import__(mod)
    except Exception as exc:
        missing.append(f"  {mod:12} {why}\n               ({type(exc).__name__}: {exc})")

if missing:
    print("Missing or broken imports in this virtualenv:\n" + "\n".join(missing))
    sys.exit(1)

# weasyprint imports fine without its C libraries and only fails when asked
# to render, so import success is NOT proof that PDF export works.
from app.erp.services import pdf_render_service

ok, detail = pdf_render_service.probe()
print(f"  weasyprint   {detail}")
if not ok:
    print("  -> install: apt install libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0")
    sys.exit(1)
print("  runtime      ok")
PYCHECK

# ── Migrations ───────────────────────────────────────────────────────────
# Also run by the unit's ExecStartPre; doing it here as well means a schema
# failure surfaces in this script's output, where someone is watching, and
# aborts before the restart. The runner is idempotent and tracks its own
# state in erp.migrations_applied.
log "Applying database migrations"
# Read DATABASE_URL out of the env file rather than sourcing it. systemd
# accepts unquoted values containing spaces (RATELIMIT_DEFAULT=200 per day);
# `. "$ENV_FILE"` would try to run the second word as a command.
DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' "$ENV_FILE" | head -1)"
[[ -n "$DATABASE_URL" ]] || fail "DATABASE_URL is not set in $ENV_FILE"

# Bootstrap the PUBLIC schema before the ERP runner.
#
# The runner only applies migrations/erp/*.sql, which build the `erp` schema.
# The core tables -- users above all -- live in the public schema and come
# from init_schema.sql, which nothing in the deploy path applies. On a virgin
# database the runner therefore dies at 003_masters.sql with
# `relation "public.users" does not exist`, ExecStartPre fails, and the unit
# never starts. Verified by running the runner against an empty database.
#
# init_schema.sql is fully idempotent (every CREATE is IF NOT EXISTS), so
# this is a no-op on an already-provisioned database and needs no guard.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$PROJECT_DIR/migrations/init_schema.sql" \
    || fail "init_schema.sql failed -- not restarting the service."
sudo -u "$APP_USER" env DATABASE_URL="$DATABASE_URL" \
    "$VENV_DIR/bin/python" "$PROJECT_DIR/migrations/erp/runner.py" \
    || fail "Migrations failed -- not restarting the service."

# ── Ownership ────────────────────────────────────────────────────────────
# git may have written new files as root if anyone ran a command by hand.
chown -R "$APP_USER:$APP_USER" "$SRC_DIR"

# ── Restart and verify ───────────────────────────────────────────────────
log "Restarting mtc"
systemctl restart mtc

# /health reports the DATABASE, not just that Flask answered, so this is a
# real readiness check. It returns 503 while the pool is down, which is why
# a plain "did systemctl exit 0" check is not enough.
log "Waiting for $HEALTH_URL"
for attempt in $(seq 1 30); do
    if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
        echo
        curl -fsS "$HEALTH_URL"; echo
        log "Deployed $DEPLOYED_REF successfully"
        exit 0
    fi
    sleep 2
done

echo
systemctl status mtc --no-pager --lines=30 || true
fail "Service did not become healthy within 60s. Logs: journalctl -u mtc -n 100"
