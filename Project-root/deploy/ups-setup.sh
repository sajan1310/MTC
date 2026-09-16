#!/usr/bin/env bash
#
# MTC ERP — give the server a DATA LINK to its UPS, and wire the emergency
# snapshot to it.
#
#   sudo ./deploy/ups-setup.sh              # detect, configure, enable
#   sudo ./deploy/ups-setup.sh --detect     # just show what is on the USB bus
#
# Idempotent. Every file it writes is backed up beside itself first.
#
# The problem this solves
# -----------------------
# An inverter is already installed at this site and it is not enough. It
# carries the load and then dies silently, so the server takes the same hard
# cut it would have taken without one, several hours later. Capacity only
# moves the failure; there is always an outage longer than the battery.
#
# What removes it is the server HEARING how much battery is left, over USB or
# serial, so it can shut down cleanly while power remains. A clean shutdown
# needs no WAL replay, no fsck and no luck.
#
# Two ways to get there:
#   * a UPS with a USB/serial port carrying the server and the network gear
#   * the existing inverter as bulk supply, with a small line-interactive UPS
#     BETWEEN it and the server -- that buys the data link plus the few final
#     minutes the shutdown actually needs
#
# Either way the UPS must be on USB/serial. A socket the server is plugged
# into tells it nothing.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_USER="${MTC_APP_USER:-mtc}"

# Thresholds. Runtime, not percent -- on lead-acid the reported percentage is
# inferred from voltage, a crude estimate that degrades badly as the battery
# ages, and a tired battery's "20%" can be under a minute.
#
# 300s is sized from what THIS server's clean stop actually needs:
# mtc.service allows TimeoutStopSec=45 for gunicorn alone, then PostgreSQL
# shuts down with a final checkpoint, then the OS halts. Two minutes is a
# comfortable estimate, so five is margin. Measure it with `upsmon -c fsd`
# and set this to roughly three times what you observe.
RUNTIME_LOW="${UPS_RUNTIME_LOW:-300}"
CHARGE_LOW="${UPS_CHARGE_LOW:-40}"

log()  { printf '\n==> %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run with sudo."

backup_file() {
    [[ -f "$1" ]] || return 0
    local dest="$1.pre-mtc.$(date +%Y%m%d_%H%M%S)"
    cp -a "$1" "$dest"
    echo "    backed up $1 -> $(basename "$dest")"
}

# ── Detect ───────────────────────────────────────────────────────────────
log "Installing NUT"
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nut nut-client nut-server >/dev/null

log "Looking for a UPS on the USB bus"
SCAN="$(nut-scanner -q -U 2>/dev/null || true)"
if [[ -z "$SCAN" ]]; then
    warn "nut-scanner found nothing."
    warn ""
    warn "This almost always means one of:"
    warn "  * the UPS data cable is not plugged into this machine"
    warn "  * the unit is an inverter with no data port at all -- the common"
    warn "    case here, and the reason this script exists"
    warn "  * it speaks serial, not USB: try 'nut-scanner -S'"
    warn ""
    warn "Check 'lsusb' for anything resembling a UPS, then re-run."
    [[ "${1:-}" == "--detect" ]] && exit 0
    die "No UPS detected -- refusing to write a configuration that cannot work."
fi
echo "$SCAN"
[[ "${1:-}" == "--detect" ]] && exit 0

DRIVER="$(sed -n 's/^[[:space:]]*driver[[:space:]]*=[[:space:]]*"\(.*\)"/\1/p' <<<"$SCAN" | head -1)"
PORT="$(sed -n 's/^[[:space:]]*port[[:space:]]*=[[:space:]]*"\(.*\)"/\1/p' <<<"$SCAN" | head -1)"
[[ -n "$DRIVER" ]] || die "Could not read a driver out of nut-scanner's output."
PORT="${PORT:-auto}"
log "Using driver=$DRIVER port=$PORT"

# ── Configure ────────────────────────────────────────────────────────────
MONPASS="$(openssl rand -hex 16)"

backup_file /etc/nut/ups.conf
cat > /etc/nut/ups.conf <<CONF
# Managed by deploy/ups-setup.sh -- re-running overwrites this file.
pollinterval = 5

[ups]
    driver = $DRIVER
    port = $PORT
    desc = "MTC ERP server UPS"

    # Our own low-battery thresholds, overriding whatever the firmware
    # decided. Whichever trips first raises the LB flag that upsmon acts on.
    # See the RUNTIME_LOW comment at the top of the script for the sizing.
    override.battery.runtime.low = $RUNTIME_LOW
    override.battery.charge.low = $CHARGE_LOW
CONF

backup_file /etc/nut/upsd.users
cat > /etc/nut/upsd.users <<CONF
# Managed by deploy/ups-setup.sh.
[upsmon]
    password = $MONPASS
    upsmon primary
CONF
chown root:nut /etc/nut/upsd.users
chmod 640 /etc/nut/upsd.users

backup_file /etc/nut/upsmon.conf
cat > /etc/nut/upsmon.conf <<CONF
# Managed by deploy/ups-setup.sh.
MONITOR ups@localhost 1 upsmon $MONPASS primary

MINSUPPLIES 1
SHUTDOWNCMD "/sbin/shutdown -h +0"
POWERDOWNFLAG /etc/killpower

# Seconds between the final warning and SHUTDOWNCMD. Short on purpose: by
# this point the decision is made and the battery is paying for the delay.
FINALDELAY 5

# The handler decides what each event means. ONBATT starts the emergency
# snapshot; LOWBATT kills it so nothing competes with the shutdown. See
# deploy/ups-notify.sh, which explains why it is that way round.
NOTIFYCMD $HERE/ups-notify.sh

NOTIFYFLAG ONBATT   SYSLOG+WALL+EXEC
NOTIFYFLAG LOWBATT  SYSLOG+WALL+EXEC
NOTIFYFLAG ONLINE   SYSLOG+WALL+EXEC
NOTIFYFLAG COMMBAD  SYSLOG+EXEC
NOTIFYFLAG NOCOMM   SYSLOG+EXEC
NOTIFYFLAG REPLBATT SYSLOG+WALL+EXEC
CONF
chown root:nut /etc/nut/upsmon.conf
chmod 640 /etc/nut/upsmon.conf

backup_file /etc/nut/nut.conf
echo 'MODE=standalone' > /etc/nut/nut.conf

chmod 755 "$HERE/ups-notify.sh" 2>/dev/null || true

# ── Start ────────────────────────────────────────────────────────────────
log "Enabling NUT"
systemctl enable --now nut-server nut-monitor >/dev/null 2>&1 || true
systemctl restart nut-server nut-monitor

sleep 3
log "What the UPS reports"
if ! upsc ups 2>/dev/null | grep -E 'battery\.(charge|runtime)|ups\.status'; then
    warn "upsc could not read the UPS. Check 'journalctl -u nut-server -n 50'."
fi

cat <<'NEXT'

==> Configured. Two things remain, and neither is optional.

1. REHEARSE THE SHUTDOWN. A UPS integration nobody has tested is a UPS
   integration that does not work. Pick a quiet moment and run:

       sudo upsmon -c fsd

   That forces the real sequence. Time it from trigger to power-off, then
   set UPS_RUNTIME_LOW to about three times what you measured and re-run
   this script.

2. PROVE THE EMERGENCY SNAPSHOT SENDS, without waiting for a power cut:

       sudo -u mtc /opt/mtc/venv/bin/python \
           /opt/mtc/src/Project-root/scripts/emergency_backup.py --dry-run

   Drop --dry-run once the dry run looks right, and check the mailbox.

   Watch it during a real event with:  journalctl -t mtc-ups -f

NEXT
