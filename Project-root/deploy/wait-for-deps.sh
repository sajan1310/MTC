#!/usr/bin/env bash
#
# MTC ERP — block until PostgreSQL and Redis are actually usable.
#
# Run from mtc.service's FIRST ExecStartPre, before the migration runner.
#
# Why this exists
# ---------------
# The unit declares After=/Requires=postgresql.service, and that is not
# enough. On Debian/Ubuntu `postgresql.service` is a Type=oneshot WRAPPER
# whose ExecStart is /bin/true; the real cluster runs as
# postgresql@17-main.service. So systemd considers "postgresql" started the
# instant the wrapper exits, which happens long before the cluster accepts a
# connection.
#
# Normally nobody notices, because the gap is milliseconds. After an UNCLEAN
# shutdown -- a power cut -- it is not milliseconds. PostgreSQL replays the
# write-ahead log before it opens the door, and while it does it actively
# REJECTS connections with "the database system is starting up". On a small
# factory box with a busy day's WAL to replay, plus a journal recovery on the
# filesystem underneath it, that is tens of seconds to minutes.
#
# What used to happen in that window, every time the power came back:
#
#   1. mtc.service starts, ExecStartPre runs migrations/erp/runner.py.
#   2. psycopg2 cannot connect. The runner exits non-zero.
#   3. systemd counts a failed start and retries after RestartSec=5.
#   4. Five failures inside StartLimitIntervalSec -- about 25 seconds --
#      trip StartLimitBurst, and systemd STOPS TRYING.
#
# The ERP then stays down until somebody SSHes in and runs
# `systemctl reset-failed mtc && systemctl start mtc`. At a site whose power
# goes out for hours and whose inverters do not always outlast it, that is
# the difference between "the server came back by itself" and "the server is
# dead every morning".
#
# Waiting here converts five fast failures into one slow, honest start. The
# start-limit protection still works as designed for its real purpose -- a
# bad config or a missing dependency fails in under a second and still trips
# the burst limit after five tries.
#
# Exiting non-zero on timeout is deliberate: a database that is still absent
# after DEPS_WAIT_TIMEOUT is not "recovering", and the journal should say so
# rather than hiding it behind an infinite wait. systemd retries the whole
# unit, so a genuinely long recovery just gets another window; because each
# attempt now spans minutes rather than five seconds, the burst limit's
# window resets between them and the unit never wedges itself.
#
# Environment (all optional, all read from /etc/mtc/mtc.env via the unit):
#   DEPS_WAIT_TIMEOUT   seconds to wait for each dependency   (default 600)
#   DEPS_WAIT_INTERVAL  seconds between probes                (default 3)
#   DATABASE_URL        preferred; else DB_HOST/DB_PORT/DB_NAME/DB_USER
#   RATELIMIT_STORAGE_URL  redis:// URL; Redis is skipped if unset
set -uo pipefail

TIMEOUT="${DEPS_WAIT_TIMEOUT:-600}"
INTERVAL="${DEPS_WAIT_INTERVAL:-3}"

log() { printf '[wait-for-deps] %s\n' "$*"; }

# ── Work out where Postgres is ───────────────────────────────────────────
# Same resolution order as database.py and migrations/erp/runner.py:
# DATABASE_URL wins, discrete DB_* variables are the fallback. Only the
# host and port are needed -- pg_isready does not authenticate, and proving
# the role and database are right is the migration runner's job on the very
# next line of the unit.
PGHOST="${DB_HOST:-127.0.0.1}"
PGPORT="${DB_PORT:-5432}"

if [[ -n "${DATABASE_URL:-}" ]]; then
    # postgresql://user:pass@host:port/dbname?args -- strip scheme, then
    # userinfo, then anything from the first / or ? onwards, and only then
    # split host from port. Done with parameter expansion rather than a
    # regex so a password containing @ or : cannot rewrite the host: the
    # userinfo strip uses the LAST @ (${x#*@} would stop at the first).
    _hostport="${DATABASE_URL#*://}"
    _hostport="${_hostport##*@}"
    _hostport="${_hostport%%[/?]*}"
    if [[ -n "$_hostport" ]]; then
        if [[ "$_hostport" == \[*\]* ]]; then
            # Bracketed IPv6 literal: [::1]:5432
            PGHOST="${_hostport%%\]*}"
            PGHOST="${PGHOST#\[}"
            _port="${_hostport##*\]}"
            [[ "$_port" == :* ]] && PGPORT="${_port#:}"
        else
            PGHOST="${_hostport%%:*}"
            [[ "$_hostport" == *:* ]] && PGPORT="${_hostport##*:}"
        fi
    fi
fi

# ── Probe helpers ────────────────────────────────────────────────────────
# pg_isready's exit codes carry exactly the distinction that matters here:
#   0  accepting connections            -> ready
#   1  REJECTING connections            -> alive, still replaying WAL
#   2  no response                      -> not up yet
#   3  no attempt made (bad arguments)  -> our problem, not the server's
# Anything but 0 means keep waiting; 1 is the crash-recovery case and is the
# whole reason this script exists.
probe_postgres() {
    pg_isready --quiet --host="$PGHOST" --port="$PGPORT" --timeout=3
}

# A TCP connect is a weaker check than PING, but it is the one that needs no
# tooling at all. Used only if redis-cli is missing.
probe_tcp() {
    local host="$1" port="$2"
    timeout 3 bash -c "exec 3<>/dev/tcp/${host}/${port}" 2>/dev/null
}

probe_redis() {
    if command -v redis-cli >/dev/null 2>&1; then
        [[ "$(redis-cli -u "$REDIS_URL" --no-raw ping 2>/dev/null)" == *PONG* ]]
    else
        probe_tcp "$REDIS_HOST" "$REDIS_PORT"
    fi
}

# Poll `probe_fn` until it succeeds or TIMEOUT elapses. Measured against the
# clock rather than by counting iterations, so a probe that itself blocks for
# its own timeout cannot stretch the total wait past what was asked for.
#
# $3 is the one-line reason a wait here is expected rather than alarming.
# It is per-dependency because the reasons differ: PostgreSQL waits are
# almost always WAL replay, and saying so is the difference between an
# operator reading the journal as "recovering, leave it" and reading it as
# "broken, start pulling things apart".
wait_for() {
    local name="$1" probe_fn="$2" why="$3"
    local deadline=$(( SECONDS + TIMEOUT ))
    local announced=0

    while :; do
        if "$probe_fn"; then
            if (( announced )); then
                log "$name is ready."
            fi
            return 0
        fi
        if (( SECONDS >= deadline )); then
            log "TIMEOUT: $name was still not ready after ${TIMEOUT}s. Giving up"
            log "so systemd retries the unit and the journal records the wait."
            return 1
        fi
        if (( ! announced )); then
            # Only says anything once it has actually had to wait, so a
            # normal boot leaves nothing in the journal instead of a
            # progress log nobody reads.
            log "Waiting up to ${TIMEOUT}s for $name."
            log "$why"
            announced=1
        fi
        sleep "$INTERVAL"
    done
}

# ── Run ──────────────────────────────────────────────────────────────────
if ! command -v pg_isready >/dev/null 2>&1; then
    # Not fatal. Skipping the gate restores the previous behaviour -- the
    # migration runner reports the connection failure itself -- which is
    # strictly better than refusing to start over a missing diagnostic tool.
    log "WARNING: pg_isready not found (install postgresql-client);"
    log "skipping the PostgreSQL readiness gate."
else
    wait_for "PostgreSQL at ${PGHOST}:${PGPORT}" probe_postgres \
        "Expected after a power cut: a cluster replaying its write-ahead log rejects connections until replay finishes." \
        || exit 1
fi

# Redis is a hard dependency of create_app() under FLASK_ENV=production --
# an unreachable rate-limit backend RAISES rather than degrading -- so it
# gets the same gate. It is skipped when unconfigured rather than assumed,
# because a development or single-process install legitimately runs with
# RATELIMIT_STORAGE_URL unset and memory:// storage.
REDIS_URL="${RATELIMIT_STORAGE_URL:-}"
if [[ "$REDIS_URL" == redis://* || "$REDIS_URL" == rediss://* ]]; then
    _redis_hostport="${REDIS_URL#*://}"
    _redis_hostport="${_redis_hostport##*@}"
    _redis_hostport="${_redis_hostport%%[/?]*}"
    REDIS_HOST="${_redis_hostport%%:*}"
    REDIS_PORT=6379
    [[ "$_redis_hostport" == *:* ]] && REDIS_PORT="${_redis_hostport##*:}"
    wait_for "Redis at ${REDIS_HOST}:${REDIS_PORT}" probe_redis \
        "Redis persistence is off by design, so it starts clean and fast; a long wait here means it is not running." \
        || exit 1
elif [[ -n "$REDIS_URL" ]]; then
    log "RATELIMIT_STORAGE_URL is not a redis:// URL; skipping the Redis gate."
fi

exit 0
