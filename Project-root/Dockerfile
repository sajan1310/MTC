FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# libpango/libharfbuzz back WeasyPrint (app/erp/services/pdf_render_service.py),
# which renders the Download PDF exports. Tens of megabytes, not the ~400 MB a
# headless browser cost -- which is why this one is installed unconditionally
# rather than hidden behind a build arg that defaulted to off.
#
# postgresql-client is no longer needed to apply the schema -- the ERP
# runner does the whole job now (MIG-001) -- but pg_dump/pg_restore ARE
# required at runtime by app/erp/services/db_backup.py, which refuses to
# run without them. A few MB, and it doubles as the tool you want when
# debugging a container that cannot reach its database.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libpq-dev gcc \
        postgresql-client \
        libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN chmod +x docker-entrypoint.sh

# Run as an unprivileged user (DEPLOY-001).
#
# Until this, the container ran everything as root: the migrations, gunicorn,
# and therefore every request handler. A file-write bug, a dependency with a
# deserialisation flaw or a template injection would all have been running as
# uid 0 inside the container -- and with the default Docker configuration,
# uid 0 in the container is uid 0 on the host for anything bind-mounted. The
# systemd path (deploy/mtc.service) has always run as the `mtc` user; this
# brings the Docker path in line with it.
#
# --system: no password, no shell login, no home directory. The uid is pinned
# at 10001 so a bind-mounted volume's ownership stays predictable across
# rebuilds instead of shifting with the base image's useradd counter.
RUN groupadd --system --gid 10001 mtc \
    && useradd --system --uid 10001 --gid mtc \
         --no-create-home --shell /usr/sbin/nologin mtc \
    && mkdir -p /app/backups \
    && chown -R mtc:mtc /app

# WeasyPrint writes a font cache and gunicorn wants somewhere for temporary
# upload files; both default to $HOME, which a --no-create-home user does not
# have. /tmp is writable by any uid and is not persisted, which is what both
# of these actually want.
# BACKUP_DIR is set explicitly because get_backup_dir()'s "four directories
# up" computation lands on /backups -- the filesystem root -- inside this
# image. That was writable only while the container ran as root; uid 10001
# cannot create it, and triggerBackup would fail with a PermissionError.
ENV HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    BACKUP_DIR=/app/backups

USER mtc

EXPOSE 8000

ENTRYPOINT ["./docker-entrypoint.sh"]
