FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# libpango/libharfbuzz back WeasyPrint (app/erp/services/pdf_render_service.py),
# which renders the Download PDF exports. Tens of megabytes, not the ~400 MB a
# headless browser cost -- which is why this one is installed unconditionally
# rather than hidden behind a build arg that defaulted to off.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libpq-dev gcc \
        libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN chmod +x docker-entrypoint.sh

EXPOSE 8000

ENTRYPOINT ["./docker-entrypoint.sh"]
