#!/usr/bin/env bash
#
# MTC ERP — one-command first install on Ubuntu 24.04 LTS.
#
#   sudo ./install.sh --repo https://github.com/sajan1310/MTC.git \
#                     --base-url http://192.168.1.50
#
# Wraps provision.sh (host setup) and deploy.sh (code) so a fresh server
# goes from nothing to a running app in one step. Both remain usable on
# their own -- this only removes the awkward part of doing it by hand,
# which was cloning the repo twice: once somewhere temporary to get at
# provision.sh, and again into /opt/mtc/src once provision.sh had created
# the user that should own it. Here it is cloned once, as root, and handed
# over afterwards.
#
# Needs the internet. That is deliberate: apt and pip both reach out, and
# an offline install would need a bundle of .debs and wheels built on a
# matching Ubuntu 24.04 host, which is a different tool.
#
# Idempotent. Re-running updates the checkout and re-applies both scripts.
set -euo pipefail

REPO=""
REF=""
BASE_URL=""
RUN_DEPLOY=1

APP_USER=mtc
APP_DIR=/opt/mtc
SRC_DIR="$APP_DIR/src"
ENV_FILE=/etc/mtc/mtc.env

log()  { printf '\n==> %s\n' "$*"; }
fail() { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }

usage() {
    cat <<USAGE
Usage: sudo ./install.sh --repo <git-url> --base-url <url> [--ref <ref>] [--no-deploy]

  --repo       Git URL to clone. Required on a fresh machine; optional if
               $SRC_DIR already exists.
  --base-url   The URL browsers will actually use, INCLUDING the scheme and
               any non-standard port. Required, and not cosmetic: its scheme
               decides whether HTTPS is enforced and whether the session
               cookie is marked Secure. Get it wrong on a plain-http LAN and
               nobody can stay logged in.
                 LAN example:  http://192.168.1.50
                 TLS example:  https://mtc.example.com
  --ref        Branch or tag to deploy. Defaults to the repo's default branch.
               Prefer a tag: "deploy.sh --ref v1.2.0" is a far better rollback
               story than a moving branch head.
  --no-deploy  Provision the host and place the code, but stop before
               starting the app. Use when you want to edit $ENV_FILE first.
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --repo)      REPO="$2"; shift 2 ;;
        --ref)       REF="$2"; shift 2 ;;
        --base-url)  BASE_URL="$2"; shift 2 ;;
        --no-deploy) RUN_DEPLOY=0; shift ;;
        -h|--help)   usage; exit 0 ;;
        *) usage; fail "Unknown argument: $1" ;;
    esac
done

[[ $EUID -eq 0 ]] || { usage; fail "Run with sudo."; }
[[ -n "$BASE_URL" ]] || { usage; fail "--base-url is required."; }
[[ "$BASE_URL" =~ ^https?:// ]] || fail "--base-url must start with http:// or https://"
[[ -n "$REPO" || -d "$SRC_DIR/.git" ]] || { usage; fail "--repo is required (no checkout at $SRC_DIR)."; }

if ! grep -q 'VERSION_ID="24.04"' /etc/os-release 2>/dev/null; then
    printf 'WARN: not Ubuntu 24.04. python3 --version should be 3.10-3.12;\n' >&2
    printf 'WARN: outside that range the app runs on a version CI never tests.\n' >&2
fi

# ── Code ─────────────────────────────────────────────────────────────────
# Cloned as root, before the mtc user exists; deploy.sh chowns it afterwards.
log "Installing git"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends git ca-certificates

if [[ -d "$SRC_DIR/.git" ]]; then
    log "Updating the existing checkout at $SRC_DIR"
    git -C "$SRC_DIR" fetch --all --tags --prune
    [[ -n "$REF" ]] && git -C "$SRC_DIR" checkout --force "$REF"
else
    log "Cloning $REPO"
    mkdir -p "$APP_DIR"
    if [[ -n "$REF" ]]; then
        git clone --branch "$REF" "$REPO" "$SRC_DIR"
    else
        git clone "$REPO" "$SRC_DIR"
    fi
fi

PROJECT_DIR="$SRC_DIR/Project-root"
[[ -x "$PROJECT_DIR/deploy/provision.sh" ]] \
    || fail "$PROJECT_DIR/deploy/provision.sh missing or not executable -- wrong repo or ref?"

# ── Host ─────────────────────────────────────────────────────────────────
log "Provisioning the host"
bash "$PROJECT_DIR/deploy/provision.sh"

# ── Configuration ────────────────────────────────────────────────────────
# provision.sh seeds $ENV_FILE with a generated SECRET_KEY and DATABASE_URL.
# Two values it cannot know are filled in here.
log "Configuring $ENV_FILE"
CORES=$(nproc)
WORKERS=$((CORES * 2 + 1))

# sed with | as the delimiter: the URL contains forward slashes.
sed -i "s|^BASE_URL=.*|BASE_URL=$BASE_URL|" "$ENV_FILE"
sed -i "s|^WEB_CONCURRENCY=.*|WEB_CONCURRENCY=$WORKERS|" "$ENV_FILE"
echo "    BASE_URL=$BASE_URL"
echo "    WEB_CONCURRENCY=$WORKERS  ($CORES cores)"

if [[ "$BASE_URL" == http://* ]]; then
    cat <<'PLAINHTTP'

    Plain http, so the session cookie is issued without Secure and HSTS
    stays off -- which is what lets a LAN deployment log in at all. The
    cookie does cross the network in the clear. Anyone with the WiFi
    password is on the same broadcast domain, so prefer an internal
    certificate when you can: issue one, set BASE_URL=https://..., and
    every hardening flag turns itself back on with no other change.
PLAINHTTP
fi

# ── App ──────────────────────────────────────────────────────────────────
if [[ $RUN_DEPLOY -eq 1 ]]; then
    log "Deploying"
    # --no-pull: the checkout above is already at the wanted ref, and
    # deploy.sh's own pull would fail anyway -- it runs git as the mtc user,
    # which has no credentials for a private remote.
    bash "$PROJECT_DIR/deploy/deploy.sh" --no-pull
else
    chown -R "$APP_USER:$APP_USER" "$SRC_DIR"
    log "Stopping before deploy, as asked"
fi

cat <<DONE

────────────────────────────────────────────────────────────────────────
Installed. $( [[ $RUN_DEPLOY -eq 1 ]] && echo "The app is running at $BASE_URL" || echo "Not started yet." )

Still to do:

  1. Create the first admin. Sign up at $BASE_URL/auth/signup, then
     promote yourself -- signup creates role 'user', and admin needs
     'admin' or 'super_admin':

       sudo -u postgres psql -d mtc \\
         -c "UPDATE users SET role='admin' WHERE email='you@company.com';"

     Log out and back in for it to take effect.

  2. Google Sign-In is set to placeholders. It cannot work on a private
     address anyway -- Google rejects private-IP redirect URIs -- so on a
     LAN, leave them and use email + password. On a public domain, put the
     real values in $ENV_FILE and restart.

  3. TLS, if this is internet-facing:
       sudo certbot --nginx -d your.domain
     then set BASE_URL=https://... in $ENV_FILE and: systemctl restart mtc

Updating later:

  sudo $PROJECT_DIR/deploy/deploy.sh --ref v1.2.0

Remember that any edit under static/erp/ needs CACHE_NAME bumped in
sw.js, or installed clients keep serving their cached copy.
────────────────────────────────────────────────────────────────────────

DONE
