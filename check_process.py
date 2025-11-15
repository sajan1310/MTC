#!/usr/bin/env python3
"""
Quick Database Check for Process ID

Usage: python check_process.py [process_id]
"""

import sys
import os

# Change to Project-root directory and add to path
project_root = os.path.join(os.path.dirname(__file__), "Project-root")
os.chdir(project_root)
sys.path.insert(0, project_root)

# Import Flask app and database
# ruff: noqa: E402
from app import create_app

# Dynamically load the database module from the project root to avoid static-import resolution errors
import importlib.util

db_path = os.path.join(project_root, "database.py")
spec = importlib.util.spec_from_file_location("database", db_path)
database = importlib.util.module_from_spec(spec)
if spec.loader is None:
    raise ImportError(f"Cannot load database module from {db_path}")
spec.loader.exec_module(database)

import psycopg2.extras

# Create app context
app = create_app("development")


def main():
    process_id = int(sys.argv[1]) if len(sys.argv) > 1 else 7

    print(f"\n{'=' * 60}")
    print(f"🔍 CHECKING PROCESS ID {process_id}")
    print(f"{'=' * 60}\n")

    with app.app_context():
        try:
            with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
                conn,
                cur,
            ):
                # Check if process exists
                cur.execute("SELECT * FROM processes WHERE id = %s", (process_id,))
                process = cur.fetchone()

                if not process:
                    print(f"❌ Process {process_id} NOT FOUND\n")
                    print("Available processes:")
                    cur.execute(
                        "SELECT id, name, status FROM processes ORDER BY id LIMIT 10"
                    )
                    for p in cur.fetchall():
                        print(f"  - ID {p['id']}: {p['name']} ({p['status']})")
                    return 1

                print("✅ Process FOUND")
                print(f"   ID: {process['id']}")
                print(f"   Name: {process['name']}")
                print(f"   Status: {process.get('status', 'N/A')}")
                print(
                    f"   Created by: {process.get('created_by') or process.get('user_id', 'N/A')}"
                )
                print()

                # Check subprocesses
                cur.execute(
                    """
                    SELECT ps.*, s.name as subprocess_name
                    FROM process_subprocesses ps
                    LEFT JOIN subprocesses s ON s.id = ps.subprocess_id
                    WHERE ps.process_id = %s
                """,
                    (process_id,),
                )
                subprocesses = cur.fetchall()

                print(f"🔧 Subprocesses: {len(subprocesses)}")
                for sp in subprocesses:
                    print(f"   - {sp.get('subprocess_name', 'N/A')}")

                print(f"\n✅ Process {process_id} is ready to use!")
                print("\n💡 Test the endpoint:")
                print(
                    f"   Open http://127.0.0.1:5000/upf/processes/{process_id}/editor"
                )

                return 0

        except Exception as e:
            print(f"❌ ERROR: {e}")
            import traceback

            traceback.print_exc()
            return 1


if __name__ == "__main__":
    sys.exit(main())
