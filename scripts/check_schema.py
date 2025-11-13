"""Schema verification helper for MTC.

Usage (offline):
  python scripts\check_schema.py

Usage (online, with DB):
  set SCHEMA_CHECK_DSN=postgres://user:pass@host:port/dbname
  python scripts\check_schema.py

Or pass --dsn "postgres://..." on the command line.

The script will read migration_candidate_classification.json and migration_candidate_counts.json
if present to prioritize checks. If a DSN is provided and psycopg2 is installed, it will connect
to Postgres and verify object existence (tables/views/columns). Otherwise it will perform an
offline check using the migration files to see whether the objects are created/altered in code.

Writes scripts/schema_check_report.json with results.
"""

import os
import json
import argparse
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "scripts" / "schema_check_report.json"


def _read_text(p: Path):
    try:
        return p.read_text(encoding='utf-8', errors='ignore')
    except Exception:
        return ""


def load_candidates():
    cand = ROOT / "migration_candidate_classification.json"
    counts = ROOT / "migration_candidate_counts.json"
    candidates = []
    if cand.exists():
        try:
            j = json.loads(cand.read_text(encoding='utf-8'))
            for k, v in j.items():
                candidates.append((k, v.get('classification', 'unknown')))
        except Exception:
            pass
    elif counts.exists():
        try:
            j = json.loads(counts.read_text(encoding='utf-8'))
            for k, cnt in j.get('counts', []):
                candidates.append((k, 'unknown'))
        except Exception:
            pass
    else:
        # fallback: scan gather_tables_used_in_code (simple heuristic)
        # we'll scan migrations directory for tokens; keep small set
        candidates = []
    return candidates


def scan_migrations_for_objects():
    mig_dir = ROOT / "Project-root" / "migrations"
    table_re = re.compile(r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:\w+\.)?\"?([a-zA-Z0-9_]+)\"?", re.I)
    view_re = re.compile(r"CREATE\s+(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:\w+\.)?\"?([a-zA-Z0-9_]+)\"?", re.I)
    col_re = re.compile(r"ALTER\s+TABLE[\s\S]{0,200}ADD\s+COLUMN[\s\S]{0,40}\"?([a-zA-Z0-9_]+)\"?", re.I)
    tables = set()
    views = set()
    cols = set()
    if not mig_dir.exists():
        return tables, views, cols
    for p in mig_dir.iterdir():
        if not p.is_file():
            continue
        txt = _read_text(p)
        for m in table_re.finditer(txt):
            tables.add(m.group(1))
        for m in view_re.finditer(txt):
            views.add(m.group(1))
        for m in col_re.finditer(txt):
            cols.add(m.group(1))
    return tables, views, cols


def check_online(dsn, checks):
    try:
        import psycopg2
    except Exception as e:
        print("psycopg2 not available; install it to run online checks:")
        print("pip install psycopg2-binary")
        return None

    res = {}
    try:
        conn = psycopg2.connect(dsn)
        cur = conn.cursor()
    except Exception as e:
        print("Failed to connect to DB:", e)
        return None

    for name, kind in checks:
        entry = {"expected_kind": kind, "present": False, "details": None}
        try:
            # check view
            cur.execute("SELECT to_regclass(%s)", (f'public.{name}',))
            reg = cur.fetchone()[0]
            if reg:
                entry['present'] = True
                entry['details'] = 'regclass'
                res[name] = entry
                continue
            # check table
            cur.execute("SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=%s)", (name,))
            if cur.fetchone()[0]:
                entry['present'] = True
                entry['details'] = 'table'
                res[name] = entry
                continue
            # check column in any table
            cur.execute("SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns WHERE column_name=%s LIMIT 1", (name,))
            row = cur.fetchone()
            if row:
                entry['present'] = True
                entry['details'] = {'column_in_table': {'schema': row[0], 'table': row[1], 'column': row[2], 'data_type': row[3]}}
                res[name] = entry
                continue
            res[name] = entry
        except Exception as e:
            res[name] = {"expected_kind": kind, "present": False, "error": str(e)}

    try:
        cur.close()
        conn.close()
    except Exception:
        pass
    return res


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dsn", help="Postgres DSN (postgres://user:pass@host:port/db)", default=os.environ.get('SCHEMA_CHECK_DSN'))
    args = parser.parse_args()

    candidates = load_candidates()
    if not candidates:
        # fallback: take top few tokens from migration_candidate_counts if exists
        countsf = ROOT / "migration_candidate_counts.json"
        if countsf.exists():
            try:
                j = json.loads(countsf.read_text(encoding='utf-8'))
                candidates = [(k, 'unknown') for k, _ in j.get('counts', [])[:40]]
            except Exception:
                candidates = []

    mig_tables, mig_views, mig_columns = scan_migrations_for_objects()

    offline_report = {}
    for name, kind in candidates:
        status = {
            'expected_kind': kind,
            'in_migrations_table': name in mig_tables,
            'in_migrations_view': name in mig_views,
            'in_migrations_column': name in mig_columns,
        }
        offline_report[name] = status

    report = {'mode': 'offline', 'offline': offline_report}

    if args.dsn:
        online = check_online(args.dsn, candidates)
        if online is not None:
            report['mode'] = 'online'
            report['online'] = online

    OUT.write_text(json.dumps(report, indent=2))
    print('Wrote', OUT)


if __name__ == '__main__':
    main()
