#!/usr/bin/env bash
#
# NOTIFYCMD handler for NUT's upsmon. Installed by deploy/ups-setup.sh.
#
# upsmon calls this with the human-readable message as $1 and the event in
# NOTIFYTYPE. It runs SYNCHRONOUSLY inside upsmon, so anything slow here
# delays upsmon itself -- which on a machine running out of power is the last
# thing anyone wants. Everything expensive is therefore backgrounded, and
# this script's own job is only to decide what should happen.
#
# The event that matters is ONBATT, not LOWBATT
# ---------------------------------------------
# "When the battery is nearly gone, save everything" is the obvious design
# and it is backwards. At LOWBATT there are minutes of power left and the one
# correct action is to shut down cleanly. Starting a database dump and an
# internet upload at that moment DELAYS the shutdown and can cause the hard
# crash the UPS was bought to prevent -- and by then the site's router is
# usually dark too, so the send blocks until its own timeout while the
# battery drains.
#
# So the snapshot fires at ONBATT: the instant mains fails, when the battery
# is still full and the network is most likely still up. LOWBATT does the
# opposite job -- it KILLS any run still in flight so nothing competes with
# the shutdown.
#
#   ONBATT   mains failed          -> snapshot now, mail it, in background
#   LOWBATT  minutes left          -> kill any in-flight run, get out of the way
#   ONLINE   mains back            -> let an in-flight run finish; log it
#
# Everything is logged to the journal with the `mtc-ups` tag:
#   journalctl -t mtc-ups
set -uo pipefail

APP_DIR="${MTC_APP_DIR:-/opt/mtc/src/Project-root}"
VENV_PY="${MTC_VENV_PYTHON:-/opt/mtc/venv/bin/python}"
APP_USER="${MTC_APP_USER:-mtc}"
BUDGET="${EMERGENCY_BACKUP_BUDGET:-180}"

# /run is tmpfs: the pid file cannot survive a reboot and be mistaken for a
# live run. Falls back to /tmp where /run is not writable.
STATE_DIR="/run/mtc"
mkdir -p "$STATE_DIR" 2>/dev/null || STATE_DIR="/tmp"
PID_FILE="$STATE_DIR/ups-emergency.pid"

NOTIFYTYPE="${NOTIFYTYPE:-${1:-UNKNOWN}}"

log() {
    # Journal when systemd-cat exists, stderr otherwise, so running this by
    # hand still shows something.
    if command -v systemd-cat >/dev/null 2>&1; then
        printf '%s\n' "$*" | systemd-cat -t mtc-ups -p info
    else
        printf '[mtc-ups] %s\n' "$*" >&2
    fi
}

running_pid() {
    [[ -f "$PID_FILE" ]] || return 1
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null)" || return 1
    [[ "$pid" =~ ^[0-9]+$ ]] || return 1
    kill -0 "$pid" 2>/dev/null || return 1
    printf '%s' "$pid"
}

start_emergency_backup() {
    if running_pid >/dev/null; then
        log "ONBATT: an emergency backup is already running; not starting a second."
        return 0
    fi
    if [[ ! -x "$VENV_PY" ]]; then
        log "ONBATT: interpreter $VENV_PY not found -- cannot take an emergency snapshot."
        return 1
    fi

    # Run as the app user when this handler is root (upsmon usually is), so
    # the dump is not left root-owned in backups/ where the nightly job's
    # retention could no longer delete it.
    local -a prefix=()
    if [[ "$(id -u)" == "0" ]] && id -u "$APP_USER" >/dev/null 2>&1; then
        prefix=(runuser -u "$APP_USER" --)
    fi

    # setsid detaches it into its own session and process group. Two reasons:
    # upsmon must not wait for it, and the LOWBATT path can then signal the
    # whole group and be sure the python process AND the pg_dump it spawned
    # both go, rather than orphaning the child that is doing the actual work.
    setsid "${prefix[@]}" "$VENV_PY" "$APP_DIR/scripts/emergency_backup.py" \
        --reason ONBATT --budget "$BUDGET" \
        >>"$STATE_DIR/ups-emergency.log" 2>&1 &
    local pid=$!
    echo "$pid" > "$PID_FILE"
    log "ONBATT: mains failed. Emergency snapshot started (pid $pid, budget ${BUDGET}s)."
}

stop_emergency_backup() {
    local pid
    if ! pid="$(running_pid)"; then
        rm -f "$PID_FILE"
        return 0
    fi
    # Negative pid = the whole process group setsid created, so pg_dump dies
    # with its parent instead of holding the database open during shutdown.
    log "LOWBATT: killing the in-flight emergency backup (pid $pid) so it cannot delay shutdown."
    kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
    # One short grace period, then insist. There is no time for more.
    for _ in 1 2 3 4 5; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 1
    done
    kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
    rm -f "$PID_FILE"
}

case "$NOTIFYTYPE" in
    ONBATT)
        start_emergency_backup
        ;;
    LOWBATT)
        # Deliberately does NOT start a backup. See the header.
        stop_emergency_backup
        log "LOWBATT: battery is nearly gone; leaving the shutdown to upsmon."
        ;;
    ONLINE)
        # An in-flight run is left alone on purpose: mains is back, so there
        # is no longer any hurry, and the snapshot it is finishing is still a
        # perfectly good snapshot.
        log "ONLINE: mains restored."
        ;;
    COMMBAD|NOCOMM)
        log "$NOTIFYTYPE: lost contact with the UPS. The data link is the whole point -- check the cable and the driver."
        ;;
    *)
        log "$NOTIFYTYPE: ${1:-no message}"
        ;;
esac

exit 0
