#!/usr/bin/env sh
set -e

# The public schema first. runner.py applies only migrations/erp/*.sql,
# which build the `erp` schema; the core tables -- users above all -- come
# from init_schema.sql. Without this, a VIRGIN database dies at
# 003_masters.sql with `relation "public.users" does not exist` and the
# container never starts. Existing deployments never noticed because their
# database was bootstrapped by hand long ago.
#
# Idempotent: every CREATE in init_schema.sql is IF NOT EXISTS, so this is a
# no-op on an already-provisioned database.
echo "Applying base schema..."
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -q -f migrations/init_schema.sql

echo "Applying ERP migrations..."
python migrations/erp/runner.py

echo "Starting gunicorn..."
exec gunicorn wsgi:app --bind 0.0.0.0:"${PORT:-8000}" --workers "${WEB_CONCURRENCY:-4}" \
    --timeout 120 --log-file - --log-level info --access-logfile - --error-logfile -
