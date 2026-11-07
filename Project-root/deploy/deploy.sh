#!/usr/bin/env bash
#
# MTC ERP — deploy the current checkout.
#
#   sudo /opt/mtc/src/Project-root/deploy/deploy.sh          # deploy HEAD
#   sudo .../deploy.sh --ref v1.2.0                          # deploy a tag
#   sudo .../deploy.sh --no-pull                             # deploy what is on disk
#   sudo .../deploy.sh --python python3.12                   # pin the interpreter
#
# The virtualenv is built with --python, else MTC_PYTHON from mtc.env, else
# python3. If the existing venv was built on a different Python -- which is
# what an Ubuntu release upgrade does to it, silently -- it is rebuilt.
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
PYTHON_ARG=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --ref)     REF="$2"; shift 2 ;;
        --no-pull) PULL=0; shift ;;
        --python)  PYTHON_ARG="$2"; shift 2 ;;
        *) echo "Unknown argument: $1" >&2; exit 2 ;;
    esac
done

# Set when this run moved a working venv aside to rebuild it. Until the
# service has been restarted onto the new one, a failure puts the old one
# back, so a deploy that cannot build its environment leaves the server
# exactly as it found it.
#
# Only a venv that still WORKED is put back. After a release upgrade the old
# one is broken by definition, and restoring it would trade a half-built new
# venv -- worth inspecting -- for one known not to start.
VENV_REPLACED=""
RESTARTED=""
fail() {
    printf '\nFAILED: %s\n' "$*" >&2
    if [[ -n "$VENV_REPLACED" && -d "$VENV_REPLACED" ]]; then
        # "Worked" = its interpreter runs and finds its OWN site-packages: the
        # same test venv_matches() applies, minus the version it was asked for.
        local v
        if v="$("$VENV_REPLACED/bin/python" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null)" \
                && [[ -d "$VENV_REPLACED/lib/python$v/site-packages" ]]; then
            printf 'Restoring the previous virtualenv from %s\n' "$VENV_REPLACED" >&2
            rm -rf "$VENV_DIR"
            mv "$VENV_REPLACED" "$VENV_DIR"
            if [[ -n "$RESTARTED" ]]; then
                printf 'Restarting mtc on the restored virtualenv\n' >&2
                systemctl restart mtc || true
            fi
        else
            printf 'The previous virtualenv (%s) does not run either; leaving the new one in place.\n' \
                "$VENV_REPLACED" >&2
        fi
    fi
    exit 1
}
log()  { printf '\n==> %s\n' "$*"; }

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
# A git checkout is the usual case but not a requirement: the code can also
# arrive by rsync, by tarball, or from a bare repo on this machine. Pulling
# is skipped automatically when there is nothing to pull from, so --no-pull
# is only needed to deliberately hold a checkout at its current revision.
if [[ $PULL -eq 1 && -d "$SRC_DIR/.git" ]]; then
    log "Fetching code"
    sudo -u "$APP_USER" git -C "$SRC_DIR" fetch --all --tags --prune
    if [[ -n "$REF" ]]; then
        sudo -u "$APP_USER" git -C "$SRC_DIR" checkout --force "$REF"
    else
        sudo -u "$APP_USER" git -C "$SRC_DIR" pull --ff-only
    fi
elif [[ $PULL -eq 1 ]]; then
    log "No git checkout at $SRC_DIR -- deploying the code already in place"
    [[ -z "$REF" ]] || fail "--ref needs a git checkout; $SRC_DIR has none."
fi

# What got deployed, for the log and the closing message. Never fatal: under
# `set -e` an unconditional `git rev-parse` here aborted the whole deploy
# before it did anything whenever the code had arrived any way other than
# git -- which is exactly the case this branch exists to support.
#   git SHA  ->  a RELEASE file, which a tarball can carry  ->  give up.
if DEPLOYED_REF="$(git -C "$SRC_DIR" rev-parse --short HEAD 2>/dev/null)"; then
    :
elif [[ -f "$SRC_DIR/RELEASE" ]]; then
    DEPLOYED_REF="$(head -1 "$SRC_DIR/RELEASE")"
else
    DEPLOYED_REF="unversioned"
fi
log "Deploying $DEPLOYED_REF"

# ── Virtualenv ───────────────────────────────────────────────────────────
# ONE interpreter, at an absolute path, matching the unit's ExecStart.
# requirements.txt documents the outage this prevents: the server ran from
# venv2 while WeasyPrint had been installed into venv, so Download PDF
# returned 503 and reported the renderer as unavailable. A missing package
# here degrades silently instead of crashing, which is exactly why it went
# unnoticed -- hence the explicit verification below, not just an install.
#
# The interpreter is chosen explicitly and the venv is checked against it on
# every deploy. A venv is bound to the Python it was built with: its packages
# live in lib/pythonX.Y/. A release upgrade replaces the system python3, and
# bin/python then starts the NEW interpreter, which looks in a lib/pythonX.Y/
# that does not exist -- so the unit dies on `No module named 'psycopg2'`
# while the venv directory, the thing the old `[[ -d ]]` test looked at, is
# still there. That took production down after 24.04 -> 26.04.
PYTHON="$PYTHON_ARG"
[[ -n "$PYTHON" ]] || PYTHON="$(sed -n 's/^MTC_PYTHON=//p' "$ENV_FILE" | tail -1)"
[[ -n "$PYTHON" ]] || PYTHON=python3
PYTHON_BIN="$(command -v "$PYTHON")" \
    || fail "Python interpreter '$PYTHON' not found (from --python, MTC_PYTHON in $ENV_FILE, or the python3 default)."
PY_VER="$("$PYTHON_BIN" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
log "Python: $PYTHON_BIN ($PY_VER)"

# Healthy means: bin/python runs, it IS the chosen X.Y, and that X.Y's
# site-packages exists. The last test is the one that catches the upgrade
# case, where bin/python happily runs the new interpreter.
venv_matches() {
    local v
    v="$("$VENV_DIR/bin/python" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null)" || return 1
    [[ "$v" == "$PY_VER" && -d "$VENV_DIR/lib/python$v/site-packages" ]]
}

if [[ -d "$VENV_DIR" ]] && ! venv_matches; then
    VENV_REPLACED="$VENV_DIR.replaced-$(date +%Y%m%d-%H%M%S)"
    log "Virtualenv was not built on Python $PY_VER -- rebuilding (previous kept at $VENV_REPLACED)"
    mv "$VENV_DIR" "$VENV_REPLACED"
fi

[[ -d "$VENV_DIR" ]] || {
    log "Creating $VENV_DIR on Python $PY_VER"
    "$PYTHON_BIN" -m venv "$VENV_DIR" \
        || fail "Could not create the venv. Install the venv module: apt install python$PY_VER-venv"
    chown -R "$APP_USER:$APP_USER" "$VENV_DIR"
}

log "Syncing dependencies"
"$VENV_DIR/bin/pip" install --quiet --upgrade pip \
    || fail "pip upgrade failed -- not restarting the service."
"$VENV_DIR/bin/pip" install --quiet -r "$PROJECT_DIR/requirements.txt" \
    || fail "Dependency install failed -- not restarting the service."
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

# Said, not failed: a missing script font spoils only text in that script, and
# the rest of the deploy is worth having meanwhile.
missing = pdf_render_service.missing_scripts()
if missing:
    print(f"  fonts        WARNING: no {' or '.join(missing)} font -- that text prints as boxes")
    print("  -> install: sudo apt install fonts-noto-core")
else:
    print("  fonts        Gurmukhi and Devanagari covered")
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

# One migration path (MIG-001). runner.py builds the public core tables too,
# via 000_public_core.sql, so a virgin database comes up complete from this
# single command. Verified by running the runner against an empty database
# and diffing the result against production: 50 erp tables, 3 public tables,
# matching columns, zero seeded accounts.
#
# This replaces a `psql -f migrations/init_schema.sql` step that ran on every
# deploy. Besides being a second, untracked schema source, that file created
# 17 tables this application no longer uses and seeded two admin accounts
# (admin@mtc.local and demo@example.com, both role 'admin') -- which meant
# deleting those accounts did not keep them deleted. See
# migrations/legacy/README.md.
#
# runuser, not sudo, with the URL in the environment, not on the command
# line. sudo writes to the journal (readable by group adm) every command line
# it runs and every variable it is told to keep. This used to be
# `sudo -u mtc env DATABASE_URL=postgresql://mtc:<password>@...`, so each
# deploy logged the database password, and `sudo --preserve-env=` logs it
# too (as ENV=...). runuser logs neither; it needs root, which this script has.
DATABASE_URL="$DATABASE_URL" runuser -u "$APP_USER" -- \
    "$VENV_DIR/bin/python" "$PROJECT_DIR/migrations/erp/runner.py" \
    || fail "Migrations failed -- not restarting the service."

# ── Ownership ────────────────────────────────────────────────────────────
# git may have written new files as root if anyone ran a command by hand.
chown -R "$APP_USER:$APP_USER" "$SRC_DIR"

# ── Restart and verify ───────────────────────────────────────────────────
log "Restarting mtc"
RESTARTED=1
systemctl restart mtc

# /health reports the DATABASE, not just that Flask answered, so this is a
# real readiness check. It returns 503 while the pool is down, which is why
# a plain "did systemctl exit 0" check is not enough.
log "Waiting for $HEALTH_URL"
for attempt in $(seq 1 30); do
    if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
        echo
        curl -fsS "$HEALTH_URL"; echo
        if [[ -n "$VENV_REPLACED" ]]; then
            log "Rebuilt the virtualenv on Python $PY_VER. Once satisfied: rm -rf $VENV_REPLACED"
        fi
        log "Deployed $DEPLOYED_REF successfully"
        exit 0
    fi
    sleep 2
done

echo
systemctl status mtc --no-pager --lines=30 || true
fail "Service did not become healthy within 60s. Logs: journalctl -u mtc -n 100"
