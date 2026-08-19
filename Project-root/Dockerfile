FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends libpq-dev gcc \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Chromium for server-side vector PDF rendering
# (app/erp/services/pdf_render_service.py). pip installs the Playwright
# library but never the browser itself, so without this the /erp/render-pdf
# endpoint returns 503 and every client falls back to its own raster
# renderer -- the app keeps working, the PDFs just go back to being
# unsearchable images. See docs/audit/PDF_GENERATION_REVIEW.md PDF-002.
#
# Installed into a fixed path rather than the default per-user cache, and the
# same value is exported at runtime: Playwright installs into the *installing*
# user's home, so a build that runs as root and a container that later drops to
# another user would otherwise leave the browser present but invisible.
#
# --with-deps pulls the shared libraries headless Chromium needs on slim. This
# is the largest layer in the image by some margin (~400 MB); it sits after pip
# and before the app source so ordinary code changes do not rebuild it.
#
# Off by default, because it is a ~400 MB layer for a quality improvement
# rather than a working feature: without it the app still exports PDFs, the
# browser just renders them as images instead of searchable documents, and
# Print -> Save as PDF remains available for a searchable one. Turn it on with:
#
#     docker build --build-arg INSTALL_CHROMIUM=true .
#
# and set PDF_SERVER_RENDER=off (the default is "auto") when you leave it off,
# so the startup log reports a deliberate choice rather than warning about a
# broken deploy.
ARG INSTALL_CHROMIUM=false
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY scripts/install_chromium.sh /tmp/install_chromium.sh
RUN if [ "$INSTALL_CHROMIUM" = "true" ]; then \
        sh /tmp/install_chromium.sh \
        && chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH" \
        && rm -rf /var/lib/apt/lists/*; \
    else \
        echo "[chromium] skipped (INSTALL_CHROMIUM=$INSTALL_CHROMIUM)."; \
        echo "[chromium] PDFs will be rendered in the browser as images."; \
        echo "[chromium] Set PDF_SERVER_RENDER=off to make that a stated choice."; \
    fi \
    && rm -f /tmp/install_chromium.sh

COPY . .

RUN chmod +x docker-entrypoint.sh

EXPOSE 8000

ENTRYPOINT ["./docker-entrypoint.sh"]
