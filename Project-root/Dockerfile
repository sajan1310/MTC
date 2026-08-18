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
# --with-deps pulls the shared libraries headless Chromium needs on slim.
# This is the largest layer in the image by some margin (~400 MB); it is
# placed after pip and before the app source so it is not rebuilt on every
# code change.
RUN playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

COPY . .

RUN chmod +x docker-entrypoint.sh

EXPOSE 8000

ENTRYPOINT ["./docker-entrypoint.sh"]
