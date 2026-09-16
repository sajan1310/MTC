#!/usr/bin/env bash
#
# Detect mains failure by watching the modem, snapshot, then shut down cleanly.
#
# Installed as mains-watch.service by deploy/ups-setup.sh --mains-watch, or by
# hand. Runs forever; systemd restarts it if it dies.
#
# Why the modem is the sensor
# ---------------------------
# This site has no UPS data link -- the inverter carries the load and says
# nothing -- so there is no direct way to ask "is mains up?". The modem
# answers it indirectly, and the server's own journal proved it. From the last
# hard cut:
#
#   08:59:57  tailscaled: connectivity impacted
#   09:00:57  tailscaled: "Your Internet connection might be down"
#   09:01:57  <log ends; machine dead>
#
# The modem died about two minutes before the server did, because the server
# is on the inverter and the modem effectively is not. That two-minute lead is
# the entire budget this script spends: a snapshot takes about three seconds
# and a clean shutdown well under a minute.
#
# Gateway down, NOT internet down
# -------------------------------
# These are different events and conflating them is how you shut a factory's
# ERP down for no reason:
#
#   gateway unreachable      -> the modem has no power  -> MAINS IS OUT -> act
#   gateway fine, WAN down   -> the ISP has a problem   -> do nothing, log it
#
# The journal shows isolated "connectivity impacted" entries on days with no
# outage at all (Sep 15, Sep 17). Those are ISP blips. Acting on them would
# power the server off mid-workday, and -- because nothing then powers it back
# on -- leave it off until somebody walks over to the machine.
#
# Safety
# ------
# This script can power off the production server, so it does nothing until
# explicitly switched on:
#
#   MAINS_WATCH_ENABLE=1   required, or it only reports what it would do
#   MAINS_WATCH_DRYRUN=1   detect and snapshot, but never actually power off
#
# Watch it work:  journalctl -t mtc-mains -f
set -uo pipefail

APP_DIR="${MTC_APP_DIR:-/opt/mtc/src/Project-root}"
VENV_PY="${MTC_VENV_PYTHON:-/opt/mtc/venv/bin/python}"
APP_USER="${MTC_APP_USER:-mtc}"

ENABLED="${MAINS_WATCH_ENABLE:-0}"
DRYRUN="${MAINS_WATCH_DRYRUN:-0}"

# Seconds between probes, and how many consecutive misses mean "gone".
# 4 x 5s = 20s of continuous silence before acting. Long enough that a single
# dropped packet or a modem reboot does not count; short enough to leave most
# of the two-minute budget for the snapshot and the shutdown.
POLL_SECONDS="${MAINS_WATCH_POLL:-5}"
FAIL_THRESHOLD="${MAINS_WATCH_THRESHOLD:-4}"

# A last, more patient burst before committing to a shutdown. The cost of a
# false positive is the ERP being off until someone notices; two extra seconds
# of checking is cheap against that.
CONFIRM_COUNT="${MAINS_WATCH_CONFIRM:-3}"

log() {
    if command -v systemd-cat >/dev/null 2>&1; then
        printf '%s\n' "$*" | systemd-cat -t mtc-mains -p info
    else
        printf '[mtc-mains] %s\n' "$*" >&2
    fi
}

detect_gateway() {
    # An explicit target wins. Two uses: rehearsing this script against an
    # address known to be dead, and installations where the thing worth
    # watching is not the default route -- a separate AP or switch that shares
    # the modem's power but not its role.
    if [[ -n "${MAINS_WATCH_GATEWAY:-}" ]]; then
        printf '%s' "$MAINS_WATCH_GATEWAY"
        return
    fi
    # Re-read every time rather than caching: DHCP can hand out a different
    # gateway after the modem reboots, and a cached one would then look
    # permanently dead and trigger a shutdown on a perfectly healthy network.
    ip route show default 2>/dev/null | awk '/default/ {print $3; exit}'
}

probe() {
    local gw="$1"
    ping -c 1 -W 1 "$gw" >/dev/null 2>&1
}

snapshot_now() {
    if [[ ! -x "$VENV_PY" ]]; then
        log "Cannot snapshot: interpreter $VENV_PY not found."
        return 1
    fi
    local -a prefix=()
    if [[ "$(id -u)" == "0" ]] && id -u "$APP_USER" >/dev/null 2>&1; then
        prefix=(runuser -u "$APP_USER" --)
    fi
    # --no-send on purpose. The modem is dead, so SMTP cannot succeed; trying
    # would spend the battery on a 45-second timeout. The snapshot is marked
    # pending and mailed once the network is back.
    log "Taking an immediate snapshot before shutting down..."
    if "${prefix[@]}" "$VENV_PY" "$APP_DIR/scripts/emergency_backup.py" \
        --reason MAINS --no-send --budget 60 2>&1 | while IFS= read -r l; do log "  $l"; done
    then
        return 0
    fi
    return 1
}

power_off() {
    if [[ "$DRYRUN" == "1" ]]; then
        log "DRY RUN: would now run 'systemctl poweroff'. Not doing it."
        return 0
    fi
    log "Shutting down cleanly while the inverter still has charge."
    # systemd stops mtc.service before postgresql.service on its own, because
    # the unit declares Requires=/After= on it -- so gunicorn drains first and
    # PostgreSQL gets its final checkpoint, which is the whole point of
    # shutting down rather than being cut off.
    systemctl poweroff || shutdown -h now
}

on_mains_lost() {
    log "Gateway has been unreachable for $((POLL_SECONDS * FAIL_THRESHOLD))s -- treating this as mains failure."
    snapshot_now || log "Snapshot did not complete; shutting down anyway -- committed data is already on disk."
    power_off
}

# ── Main loop ────────────────────────────────────────────────────────────
GW="$(detect_gateway)"
if [[ -z "$GW" ]]; then
    log "No default gateway on this host; nothing to watch. Exiting."
    exit 0
fi

if [[ "$ENABLED" != "1" ]]; then
    log "Watching $GW in REPORT-ONLY mode (set MAINS_WATCH_ENABLE=1 to arm)."
else
    log "Armed. Watching gateway $GW every ${POLL_SECONDS}s; ${FAIL_THRESHOLD} consecutive misses triggers snapshot + shutdown."
fi

misses=0
while :; do
    GW="$(detect_gateway)"
    if [[ -z "$GW" ]]; then
        # No route at all. Treated like a miss rather than an error: losing the
        # default route is what a dead modem looks like on some setups.
        misses=$((misses + 1))
    elif probe "$GW"; then
        if (( misses > 0 )); then
            log "Gateway $GW is back after $misses missed probe(s)."
        fi
        misses=0
    else
        misses=$((misses + 1))
        log "Gateway $GW missed probe $misses/$FAIL_THRESHOLD."
    fi

    if (( misses >= FAIL_THRESHOLD )); then
        # Final confirmation burst. One more chance for a modem that is merely
        # rebooting to answer before the ERP goes down over it.
        confirmed=1
        for _ in $(seq 1 "$CONFIRM_COUNT"); do
            if [[ -n "$GW" ]] && probe "$GW"; then
                confirmed=0
                break
            fi
            sleep 1
        done
        if (( confirmed == 0 )); then
            log "Gateway answered during confirmation; standing down."
            misses=0
        elif [[ "$ENABLED" != "1" ]]; then
            log "REPORT-ONLY: mains failure detected. Would snapshot and power off now."
            misses=0
        else
            on_mains_lost
            exit 0
        fi
    fi

    sleep "$POLL_SECONDS"
done
