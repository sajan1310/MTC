"""
Pre-Integration Backup Script for UPF Alert System Integration
Location: /scripts/pre_integration_backup.py
Dependencies: psycopg2, datetime, subprocess, git
Output: Timestamped backup files in /backups/ directory with manifest
"""
import os
import sys
import subprocess
import datetime
import json
import psycopg2
from psycopg2 import sql

BACKUP_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '../backups'))
MANIFEST_FILE = os.path.join(BACKUP_DIR, 'backup_manifest.json')
DB_NAME = os.getenv('DB_NAME', 'MTC')
DB_USER = os.getenv('DB_USER', 'postgres')
DB_HOST = os.getenv('DB_HOST', '127.0.0.1')
DB_PORT = os.getenv('DB_PORT', '5432')
DB_PASSWORD = os.getenv('DB_PASS', 'abcd')

GIT_BRANCH = 'feature/upf-alert-system-integration'

TABLES_TO_BACKUP = [
    'production_lots', 'item_variant', 'users', 'suppliers', 'purchase_orders',
    # Add other relevant tables here
]

SERVICE_DIRS = [
    os.path.abspath(os.path.join(os.path.dirname(__file__), '../app/services')),
    os.path.abspath(os.path.join(os.path.dirname(__file__), '../app/api')),
]


def timestamp():
    return datetime.datetime.now().strftime('%Y%m%d_%H%M%S')


def backup_database():
    backup_file = os.path.join(BACKUP_DIR, f'db_backup_{timestamp()}.sql')
    cmd = [
        'pg_dump',
        '-h', DB_HOST,
        '-U', DB_USER,
        '-d', DB_NAME,
        '-F', 'c',
        '-f', backup_file
    ]
    env = os.environ.copy()
    env['PGPASSWORD'] = DB_PASSWORD
    print(f"Backing up database to {backup_file}...")
    subprocess.run(cmd, env=env, check=True)
    return backup_file


def backup_code():
    code_snapshot_file = os.path.join(BACKUP_DIR, f'code_snapshot_{timestamp()}.zip')
    print(f"Creating code snapshot at {code_snapshot_file}...")
    subprocess.run(['git', 'archive', '--format=zip', 'HEAD', '-o', code_snapshot_file], check=True)
    return code_snapshot_file


def create_git_branch():
    print(f"Creating git feature branch: {GIT_BRANCH}")
    subprocess.run(['git', 'checkout', '-b', GIT_BRANCH], check=True)


def get_table_row_counts():
    print("Documenting current table row counts...")
    conn = psycopg2.connect(dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD, host=DB_HOST, port=DB_PORT)
    cur = conn.cursor()
    row_counts = {}
    for table in TABLES_TO_BACKUP:
        cur.execute(sql.SQL("SELECT COUNT(*) FROM {};").format(sql.Identifier(table)))
        count = cur.fetchone()[0]
        row_counts[table] = count
    cur.close()
    conn.close()
    return row_counts


def snapshot_service_functions():
    print("Creating pre-integration snapshot of service functions...")
    service_functions = {}
    for service_dir in SERVICE_DIRS:
        for root, _, files in os.walk(service_dir):
            for file in files:
                if file.endswith('.py'):
                    path = os.path.join(root, file)
                    with open(path, 'r', encoding='utf-8') as f:
                        service_functions[path] = f.read()
    snapshot_file = os.path.join(BACKUP_DIR, f'service_functions_snapshot_{timestamp()}.json')
    with open(snapshot_file, 'w', encoding='utf-8') as f:
        json.dump(service_functions, f, indent=2)
    return snapshot_file


def verify_tests():
    print("Verifying all existing tests pass...")
    result = subprocess.run([sys.executable, '-m', 'pytest'], capture_output=True, text=True)
    print(result.stdout)
    if result.returncode != 0:
        print("Some tests failed. Please fix before proceeding.")
        sys.exit(1)
    print("All tests passed.")


def main():
    os.makedirs(BACKUP_DIR, exist_ok=True)
    db_backup = backup_database()
    code_backup = backup_code()
    create_git_branch()
    row_counts = get_table_row_counts()
    service_snapshot = snapshot_service_functions()
    verify_tests()
    manifest = {
        'timestamp': timestamp(),
        'db_backup': db_backup,
        'code_backup': code_backup,
        'row_counts': row_counts,
        'service_snapshot': service_snapshot
    }
    with open(MANIFEST_FILE, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, indent=2)
    print(f"Backup manifest written to {MANIFEST_FILE}")

if __name__ == '__main__':
    main()
