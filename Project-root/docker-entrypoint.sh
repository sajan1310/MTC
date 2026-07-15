#!/usr/bin/env sh
set -e

echo "Applying ERP migrations..."
python migrations/erp/runner.py

echo "Starting gunicorn..."
exec gunicorn wsgi:app --bind 0.0.0.0:"${PORT:-8000}" --workers "${WEB_CONCURRENCY:-4}" \
    --timeout 120 --log-file - --log-level info --access-logfile - --error-logfile -
