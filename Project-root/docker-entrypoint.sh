#!/usr/bin/env sh
set -e

# One migration path (MIG-001). runner.py now builds the public core tables
# too, via 000_public_core.sql, so a virgin database comes up complete from
# this single command -- no psql step, no second untracked schema source.
#
# The step this replaces ran migrations/init_schema.sql on every start. That
# file also created 17 tables this application no longer uses and seeded two
# admin accounts (admin@mtc.local, demo@example.com); see
# migrations/legacy/README.md.
echo "Applying migrations..."
python migrations/erp/runner.py

echo "Starting gunicorn..."
exec gunicorn wsgi:app --bind 0.0.0.0:"${PORT:-8000}" --workers "${WEB_CONCURRENCY:-4}" \
    --timeout 120 --log-file - --log-level info --access-logfile - --error-logfile -
