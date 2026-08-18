#!/usr/bin/env sh
# Install the Chromium build that server-side PDF rendering needs
# (app/erp/services/pdf_render_service.py, docs/audit/PDF_GENERATION_REVIEW.md
# PDF-002). Safe to use as a build step on any platform.
#
# Two things this handles that a bare `playwright install --with-deps chromium`
# does not:
#
#   1. It never fails the build. `--with-deps` apt-gets Chromium's system
#      libraries, which needs root and a Debian-ish base -- Render's native
#      Python environment has neither. Rather than breaking the deploy, this
#      retries without the deps and says clearly what is now degraded. The app
#      runs either way: without a usable browser it falls back to rendering
#      PDFs in the client, which works but produces images instead of
#      searchable documents.
#
#   2. It installs into a fixed, user-independent directory by default. The
#      Playwright default is the *installing user's* home cache, so a VPS that
#      installs as root and serves as www-data ends up with the browser on disk
#      but invisible to the app.
#
# Override the location with PLAYWRIGHT_BROWSERS_PATH; anything else is left to
# Playwright.
set -e

: "${PLAYWRIGHT_BROWSERS_PATH:=/ms-playwright}"
export PLAYWRIGHT_BROWSERS_PATH

echo "[chromium] installing into ${PLAYWRIGHT_BROWSERS_PATH}"

if mkdir -p "${PLAYWRIGHT_BROWSERS_PATH}" 2>/dev/null; then
    :
else
    echo "[chromium] cannot create ${PLAYWRIGHT_BROWSERS_PATH}; falling back to the default user cache"
    unset PLAYWRIGHT_BROWSERS_PATH
fi

if playwright install --with-deps chromium; then
    echo "[chromium] installed with system dependencies"
    exit 0
fi

echo "[chromium] '--with-deps' failed (usually: not root, or no apt on this image)."
echo "[chromium] retrying without it -- the browser will download, but may not"
echo "[chromium] start if the host lacks its shared libraries."

if playwright install chromium; then
    echo "[chromium] browser installed WITHOUT system dependencies."
    echo "[chromium] If PDF export logs 'missing its system libraries', run"
    echo "[chromium]   playwright install-deps chromium   (as root)"
    echo "[chromium] or deploy the Docker image, which bundles them."
    exit 0
fi

echo "[chromium] install failed. The app will still run: PDF export falls back"
echo "[chromium] to client-side rendering, producing images rather than"
echo "[chromium] searchable documents. See DEPLOYMENT.md > PDF Rendering."
exit 0
