#!/usr/bin/env bash
#
# Pull the newest verified database snapshots to THIS machine.
#
# Runs on the laptop (or a NAS, or any always-on box), NOT on the server.
# Over Tailscale the server's tailnet name is a stable address from anywhere,
# so this works from the factory, from home, or from a hotel, with no port
# forwarding and no dynamic DNS.
#
#   ./offsite-pull.sh --source mtc-server:/opt/mtc/src/backups --dest ~/mtc-backups
#   ./offsite-pull.sh --source /mnt/nas/mtc --dest ~/mtc-backups   # local/mounted
#
# Windows laptops: run it under Git Bash, which ships with Git for Windows
# and provides bash, ssh, scp and sha256sum already. No WSL, no PowerShell
# port to keep in step with this one.
#
# Why pull and not push
# --------------------
# The server could push after each nightly run -- it knows exactly when a
# fresh verified dump exists. It should not. A push needs the server to hold
# an SSH key for the laptop, which turns a server compromise into laptop
# access. Pulling keeps the credential on the machine being protected, and
# costs only that a missed run has to catch up.
#
# Catching up is free here because this script is idempotent: it fetches
# whatever it does not already have and verifies what it does. A laptop that
# was closed for three days collects all three snapshots on its next run.
#
# What this deliberately does NOT do
# ----------------------------------
# It never deletes a local snapshot because the server no longer has it.
# That is the difference between a backup and a mirror: a mirror faithfully
# reproduces the deletion that destroyed the original. Local retention is
# --keep, applied to what is here, and nothing the source does can reach it.
#
# A copy that fails its checksum is deleted rather than kept. An unverified
# file under a trusted name is the failure mode create_snapshot goes out of
# its way to avoid on the server; it would be perverse to reintroduce it on
# the machine that exists to hold the last good copy.
set -uo pipefail

SOURCE=""
DEST=""
KEEP=14

usage() {
    sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'
    exit "${1:-0}"
}

while (( $# )); do
    case "$1" in
        --source) SOURCE="${2:-}"; shift 2 ;;
        --dest)   DEST="${2:-}";   shift 2 ;;
        --keep)   KEEP="${2:-}";   shift 2 ;;
        -h|--help) usage 0 ;;
        *) echo "Unknown argument: $1" >&2; usage 2 ;;
    esac
done

[[ -n "$SOURCE" ]] || { echo "ERROR: --source is required." >&2; usage 2; }
[[ -n "$DEST"   ]] || { echo "ERROR: --dest is required." >&2; usage 2; }
[[ "$KEEP" =~ ^[0-9]+$ ]] && (( KEEP >= 1 )) || {
    echo "ERROR: --keep must be a positive integer." >&2; exit 2; }

mkdir -p "$DEST" || { echo "ERROR: cannot create $DEST" >&2; exit 1; }

# A source containing a colon before any slash is remote (host:/path), which
# is scp's own rule. Everything else is a path on this machine -- a mounted
# NAS, a USB disk, or a directory used to rehearse this before pointing it
# at the real server.
REMOTE_HOST=""
REMOTE_DIR="$SOURCE"
if [[ "$SOURCE" == *:* && "${SOURCE%%:*}" != *"/"* ]]; then
    REMOTE_HOST="${SOURCE%%:*}"
    REMOTE_DIR="${SOURCE#*:}"
fi

log()  { printf '%s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }

# Portability shims. This script is meant to run on the machine holding the
# copy, which is a Windows laptop (Git Bash), a Mac, or a Linux box -- so it
# avoids GNU-only spellings. `find -printf` and bare `sha256sum` are both
# absent on macOS.
sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print tolower($1)}'
    else
        shasum -a 256 "$1" | awk '{print tolower($1)}'
    fi
}

# Local snapshot basenames, oldest first. A glob that matches nothing expands
# to itself, hence the -e guard.
list_local() {
    local f
    for f in "$DEST"/mtc_*.dump; do
        [[ -e "$f" ]] || continue
        basename "$f"
    done | sort
}

# ── Source listing ───────────────────────────────────────────────────────
# Snapshot names are mtc_YYYYMMDD_HHMMSS.dump, so lexical order IS
# chronological order and `sort` needs no date parsing. That is a property of
# db_backup.py's naming, not an accident -- _SNAPSHOT_RE pins the format.
list_source() {
    if [[ -n "$REMOTE_HOST" ]]; then
        # `|| true`: an empty backups directory makes the glob fail, which is
        # a legitimate state (no backup has run yet), not an error.
        ssh -o BatchMode=yes "$REMOTE_HOST" \
            "ls -1 '$REMOTE_DIR'/mtc_*.dump 2>/dev/null || true"
    else
        ls -1 "$REMOTE_DIR"/mtc_*.dump 2>/dev/null || true
    fi
}

fetch() {
    local remote_file="$1" local_file="$2"
    if [[ -n "$REMOTE_HOST" ]]; then
        scp -q -o BatchMode=yes "$REMOTE_HOST:$remote_file" "$local_file"
    else
        cp -- "$remote_file" "$local_file"
    fi
}

# ── Verification ─────────────────────────────────────────────────────────
# The sidecar is written by db_backup.py as "<hex>  <basename>\n" (two
# spaces, sha256sum's own format). Only the hash is read: the basename in it
# describes the file at the moment it was written on the server, and a
# renamed local copy is still a valid copy.
verify() {
    local dump="$1" sidecar="$1.sha256"
    [[ -s "$dump" && -s "$sidecar" ]] || return 1
    local expected actual
    expected="$(awk 'NR==1 {print tolower($1)}' "$sidecar")"
    [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || return 1
    actual="$(sha256_of "$dump")"
    [[ "$expected" == "$actual" ]]
}

# ── Pull ─────────────────────────────────────────────────────────────────
mapfile -t available < <(list_source | sort)
if (( ${#available[@]} == 0 )); then
    warn "No snapshots found at $SOURCE. Has a backup run yet?"
    exit 1
fi

# Newest KEEP entries: anything older is outside local retention, so there is
# no point spending bandwidth on it only to prune it below.
wanted=("${available[@]: -KEEP}")

fetched=0 skipped=0 failed=0
for remote_dump in "${wanted[@]}"; do
    name="$(basename "$remote_dump")"
    local_dump="$DEST/$name"

    if verify "$local_dump"; then
        (( skipped++ ))
        continue
    fi

    log "Fetching $name"
    # Download to a .part name so an interrupted transfer -- a closed lid, a
    # dropped tunnel -- cannot leave a short file sitting under the final
    # name, where the next run's verify() would reject it and re-fetch
    # anyway but a human reaching for it might not check.
    if ! fetch "$remote_dump" "$local_dump.part" \
        || ! fetch "$remote_dump.sha256" "$local_dump.sha256.part"; then
        warn "Transfer failed for $name"
        rm -f -- "$local_dump.part" "$local_dump.sha256.part"
        (( failed++ ))
        continue
    fi
    mv -- "$local_dump.part" "$local_dump"
    mv -- "$local_dump.sha256.part" "$local_dump.sha256"

    if verify "$local_dump"; then
        log "  verified $name"
        (( fetched++ ))
    else
        warn "CHECKSUM MISMATCH on $name -- discarding the copy."
        warn "The transfer corrupted it, or the snapshot on the source is"
        warn "damaged. Check the source before trusting its other snapshots."
        rm -f -- "$local_dump" "$local_dump.sha256"
        (( failed++ ))
    fi
done

# ── Local retention ──────────────────────────────────────────────────────
# Applied to what is HERE, never to what the source still has. See the
# header: this is a backup, not a mirror.
mapfile -t held < <(list_local)
if (( ${#held[@]} > KEEP )); then
    for name in "${held[@]:0:${#held[@]}-KEEP}"; do
        rm -f -- "$DEST/$name" "$DEST/$name.sha256"
        log "Pruned local $name (beyond --keep $KEEP)"
    done
fi

log "---"
log "Fetched $fetched, already held $skipped, failed $failed. Local copies: $(
    list_local | wc -l | tr -d ' ')"

# A run that fetched nothing new is only healthy if it had nothing to fetch.
# Non-zero on any failure so Task Scheduler / cron surfaces it rather than
# letting the copy quietly go stale -- the way a backup usually dies.
(( failed == 0 )) || exit 1
