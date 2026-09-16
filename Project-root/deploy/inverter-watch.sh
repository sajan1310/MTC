#!/usr/bin/env bash
#
# Shut the server down when the INVERTER runs out -- not when mains fails.
#
# Installed as inverter-watch.service. Runs forever; systemd restarts it if it
# dies. Watch it:  journalctl -t mtc-power -f
#
# The distinction this script exists for
# --------------------------------------
# Losing mains is normal here and must change nothing. The server is on the
# inverter precisely so that work continues through an outage, and powering it
# off at that moment would throw away the whole point of having one.
#
# What must trigger a shutdown is the inverter GIVING OUT, because the machine
# has minutes left at that point and a clean stop beats a hard cut. There is
# no UPS data link to ask -- the inverter says nothing -- so the modem answers
# it by proxy: the modem is on that same inverter, so
#
#     modem loses power  =>  the inverter is exhausted  =>  we are next.
#
# Three states, and only one of them is an emergency:
#
#   mains out, modem answering   -> running on inverter. Carry on. Do nothing.
#   modem answering, WAN dead    -> the ISP's problem. Log it. Do nothing.
#   modem NOT answering          -> inverter is gone. Snapshot, shut down.
#
# The middle case is why "no internet" is never the trigger. The journal
# carries isolated connectivity-impacted entries on days with no outage at
# all, and acting on those would power a factory's ERP off over an ISP blip.
#
# Why two stages
# --------------
# The budget is what the server's own journal measured during the last hard
# cut: the modem went quiet at 08:59:57 and the machine died at 09:01:57, so
# roughly two minutes. Spending all of it on deliberation before doing
# anything would be a poor use of it, and shutting down on the first dropped
# packet would be worse.
#
# So the two decisions are separated:
#
#   after ~10s of silence   take a snapshot. Cheap (about 3 seconds), local,
#                           and harmless if this turns out to be a blip --
#                           retention prunes a spare dump. The data is banked
#                           before anything else is decided.
#
#   after ~45s of silence   shut down. By now this is not a dropped packet.
#                           The snapshot is already safe, so this decision
#                           gets to be the slow, careful one.
#
# A modem REBOOT looks exactly like a modem that has lost power, and takes
# 30-90s to come back -- so a deliberate reboot can trip the shutdown. Disarm
# this first if you are power-cycling the modem on purpose:
#     sudo systemctl stop inverter-watch
#
# Safety
# ------
#   INVERTER_WATCH_ENABLE=1   required to arm; otherwise it only reports
#   INVERTER_WATCH_DRYRUN=1   detect and snapshot, but never actually poweroff
set -uo pipefail

APP_DIR="${MTC_APP_DIR:-/opt/mtc/src/Project-root}"
VENV_PY="${MTC_VENV_PYTHON:-/opt/mtc/venv/bin/python}"
APP_USER="${MTC_APP_USER:-mtc}"

ENABLED="${INVERTER_WATCH_ENABLE:-0}"
DRYRUN="${INVERTER_WATCH_DRYRUN:-0}"

POLL_SECONDS="${INVERTER_WATCH_POLL:-5}"
SNAPSHOT_AFTER="${INVERTER_WATCH_SNAPSHOT_AFTER:-2}"    # ~10s
SHUTDOWN_AFTER="${INVERTER_WATCH_SHUTDOWN_AFTER:-9}"    # ~45s

# One last patient burst before committing. A false positive costs a walk to
# the machine, because nothing powers it back on.
CONFIRM_COUNT="${INVERTER_WATCH_CONFIRM:-3}"

log() {
    if command -v systemd-cat >/dev/null 2>&1; then
        printf '%s\n' "$*" | systemd-cat -t mtc-power -p info
    else
        printf '[mtc-power] %s\n' "$*" >&2
    fi
}

detect_gateway() {
    # An explicit target wins. Two uses: rehearsing against an address known
    # to be dead, and installations where the thing sharing the inverter is
    # not the default route -- an AP or switch rather than the modem itself.
    if [[ -n "${INVERTER_WATCH_GATEWAY:-}" ]]; then
        printf '%s' "$INVERTER_WATCH_GATEWAY"
        return
    fi
    # Re-read every time rather than caching: DHCP can hand out a different
    # gateway after the modem reboots, and a cached one would then look
    # permanently dead and power the server off on a healthy network.
    ip route show default 2>/dev/null | awk '/default/ {print $3; exit}'
}

probe() {
    ping -c 1 -W 1 "$1" >/dev/null 2>&1
}

take_snapshot() {
    if [[ ! -x "$VENV_PY" ]]; then
        log "Cannot snapshot: interpreter $VENV_PY not found."
        return 1
    fi
    local -a prefix=()
    if [[ "$(id -u)" == "0" ]] && id -u "$APP_USER" >/dev/null 2>&1; then
        prefix=(runuser -u "$APP_USER" --)
    fi
    # --no-send on purpose: the modem is down, so SMTP cannot succeed and
    # trying would spend 45 seconds of battery discovering that. The dump is
    # marked .pending-send and mailed once the network is back.
    log "Modem quiet for ~$((POLL_SECONDS * SNAPSHOT_AFTER))s -- banking a snapshot now, before deciding anything else."
    "${prefix[@]}" "$VENV_PY" "$APP_DIR/scripts/emergency_backup.py" \
        --reason INVERTER --no-send --budget 60 2>&1 |
        while IFS= read -r line; do log "  $line"; done
    return 0
}

power_off() {
    if [[ "$DRYRUN" == "1" ]]; then
        log "DRY RUN: would run 'systemctl poweroff' now. Not doing it."
        return 0
    fi
    log "Shutting down cleanly while the inverter still has a little charge."
    # systemd stops mtc.service before postgresql.service by itself, because
    # the unit declares Requires=/After= on it -- gunicorn drains first and
    # PostgreSQL gets its final checkpoint, which is the entire reason to shut
    # down rather than be cut off.
    systemctl poweroff || shutdown -h now
}

# ── Main loop ────────────────────────────────────────────────────────────
GW="$(detect_gateway)"
if [[ -z "$GW" ]]; then
    log "No default gateway on this host; nothing to watch. Exiting."
    exit 0
fi

if [[ "$ENABLED" != "1" ]]; then
    log "Watching $GW in REPORT-ONLY mode (set INVERTER_WATCH_ENABLE=1 to arm)."
else
    log "Armed. Watching $GW every ${POLL_SECONDS}s. Snapshot after $((POLL_SECONDS * SNAPSHOT_AFTER))s of silence, shutdown after $((POLL_SECONDS * SHUTDOWN_AFTER))s."
fi
log "Mains failure alone does NOT trigger anything -- that is what the inverter is for."

misses=0
snapshotted=0
while :; do
    GW="$(detect_gateway)"
    if [[ -z "$GW" ]]; then
        # Losing the default route entirely is what a dead modem looks like on
        # some setups, so it counts as a miss rather than an error.
        misses=$((misses + 1))
    elif probe "$GW"; then
        if (( misses > 0 )); then
            log "Modem $GW is back after $misses missed probe(s). Standing down."
        fi
        misses=0
        # Reset so a later, separate event banks its own fresh snapshot.
        snapshotted=0
    else
        misses=$((misses + 1))
        log "Modem $GW missed probe $misses (snapshot at $SNAPSHOT_AFTER, shutdown at $SHUTDOWN_AFTER)."
    fi

    # ── Stage 1: bank the data early, while it is still cheap to be wrong ──
    if (( misses >= SNAPSHOT_AFTER && snapshotted == 0 )); then
        if [[ "$ENABLED" == "1" || "$DRYRUN" == "1" ]]; then
            take_snapshot
        else
            log "REPORT-ONLY: would take a snapshot now."
        fi
        snapshotted=1
    fi

    # ── Stage 2: the slow decision ────────────────────────────────────────
    if (( misses >= SHUTDOWN_AFTER )); then
        confirmed=1
        for _ in $(seq 1 "$CONFIRM_COUNT"); do
            if [[ -n "$GW" ]] && probe "$GW"; then
                confirmed=0
                break
            fi
            sleep 1
        done
        if (( confirmed == 0 )); then
            log "Modem answered during confirmation; standing down. The snapshot stays -- it costs nothing."
            misses=0
            snapshotted=0
        elif [[ "$ENABLED" != "1" ]]; then
            log "REPORT-ONLY: inverter presumed exhausted. Would power off now."
            misses=0
            snapshotted=0
        else
            log "Modem gone for $((POLL_SECONDS * misses))s. Treating the inverter as exhausted."
            power_off
            exit 0
        fi
    fi

    sleep "$POLL_SECONDS"
done
