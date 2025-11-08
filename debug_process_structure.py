#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Database Diagnostic Tool for Process Structure Errors

This script helps diagnose the 500 error on /api/upf/processes/<id>/structure endpoint
by checking database tables, schema, and data integrity.

Usage:
    python debug_process_structure.py [process_id]

Example:
    python debug_process_structure.py 7
"""

import sys
import os

# Configure UTF-8 encoding for Windows console
if sys.platform == "win32":
    import codecs

    sys.stdout = codecs.getwriter("utf-8")(sys.stdout.buffer, "strict")
    sys.stderr = codecs.getwriter("utf-8")(sys.stderr.buffer, "strict")

# Change to Project-root directory and add to path
project_root = os.path.join(os.path.dirname(__file__), "Project-root")
os.chdir(project_root)
sys.path.insert(0, project_root)

try:
    # Initialize Flask app context for database
    from app import create_app
    import database  # type: ignore  # Dynamic import after path manipulation
    import psycopg2.extras

    app = create_app("development")
except ImportError as e:
    print(f"❌ Error importing modules: {e}")
    print("Make sure you're in the MTC directory and database.py exists")
    sys.exit(1)


def check_table_exists(cur, table_name):
    """Check if a table exists in the database"""
    cur.execute(
        """
        SELECT EXISTS (
            SELECT FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name = %s
        ) as exists
    """,
        (table_name,),
    )
    return cur.fetchone()["exists"]


def check_process_exists(cur, process_id):
    """Check if a process with the given ID exists"""
    cur.execute("SELECT * FROM processes WHERE id = %s", (process_id,))
    return cur.fetchone()


def check_process_subprocesses(cur, process_id):
    """Check subprocesses for the given process"""
    cur.execute(
        """
        SELECT ps.*, s.name as subprocess_name
        FROM process_subprocesses ps
        LEFT JOIN subprocesses s ON s.id = ps.subprocess_id
        WHERE ps.process_id = %s
        ORDER BY ps.id
    """,
        (process_id,),
    )
    return cur.fetchall()


def main():
    # Get process ID from command line or use default
    process_id = int(sys.argv[1]) if len(sys.argv) > 1 else 7

    print(f"\n{'=' * 60}")
    print(f"🔍 DIAGNOSTIC CHECK FOR PROCESS ID {process_id}")
    print(f"{'=' * 60}\n")

    try:
        # Use Flask app context for database operations
        with app.app_context():
            with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
                conn,
                cur,
            ):
                # 1. Check Required Tables
                print("📋 CHECKING REQUIRED TABLES...")
                print("-" * 60)

                required_tables = [
                    "processes",
                    "subprocesses",
                    "process_subprocesses",
                    "item_variant",
                    "variant_usage",
                    "cost_items",
                    "substitute_groups",
                    "additional_costs",
                    "profitability",
                ]

                missing_tables = []
                for table in required_tables:
                    exists = check_table_exists(cur, table)
                    status = "✅" if exists else "❌"
                    print(f"{status} {table}")
                    if not exists:
                        missing_tables.append(table)

                if missing_tables:
                    print(f"\n⚠️  WARNING: {len(missing_tables)} tables are missing:")
                for table in missing_tables:
                    print(f"   - {table}")
                print(
                    "\n💡 These tables need to be created for the endpoint to work properly."
                )
                return

            print("\n✅ All required tables exist!\n")

            # 2. Check if Process Exists
            print("🔍 CHECKING PROCESS...")
            print("-" * 60)

            process = check_process_exists(cur, process_id)

            if not process:
                print(f"❌ Process with ID {process_id} does NOT exist!")
                print("\n📝 Available processes:")
                cur.execute(
                    "SELECT id, name, status FROM processes ORDER BY id LIMIT 10"
                )
                processes = cur.fetchall()
                if processes:
                    for p in processes:
                        print(
                            f"   - ID: {p['id']}, Name: {p['name']}, Status: {p['status']}"
                        )
                else:
                    print("   No processes found in database.")
                return

            print("✅ Process found!")
            print(f"   ID: {process['id']}")
            print(f"   Name: {process['name']}")
            print(f"   Description: {process.get('description', 'N/A')}")
            print(f"   Status: {process.get('status', 'N/A')}")
            print(f"   Created by: {process.get('created_by', 'N/A')}")
            print()

            # 3. Check Subprocesses
            print("🔧 CHECKING SUBPROCESSES...")
            print("-" * 60)

            subprocesses = check_process_subprocesses(cur, process_id)

            if not subprocesses:
                print(f"⚠️  No subprocesses found for process {process_id}")
                print(
                    "   This is OK - the process just doesn't have any subprocesses yet."
                )
            else:
                print(f"✅ Found {len(subprocesses)} subprocess(es):")
                for sp in subprocesses:
                    print(
                        f"   - ID: {sp.get('id')}, Subprocess: {sp.get('subprocess_name', 'N/A')}"
                    )

                    # Check variants for each subprocess
                    if check_table_exists(cur, "variant_usage"):
                        cur.execute(
                            """
                            SELECT COUNT(*) as count 
                            FROM variant_usage 
                            WHERE process_subprocess_id = %s
                        """,
                            (sp["id"],),
                        )
                        variant_count = cur.fetchone()["count"]
                        print(f"     └─ Variants: {variant_count}")

            print()

            # 4. Check Additional Data
            print("📊 CHECKING ADDITIONAL DATA...")
            print("-" * 60)

            if check_table_exists(cur, "additional_costs"):
                cur.execute(
                    "SELECT COUNT(*) as count FROM additional_costs WHERE process_id = %s",
                    (process_id,),
                )
                cost_count = cur.fetchone()["count"]
                print(f"✅ Additional costs: {cost_count}")

            if check_table_exists(cur, "profitability"):
                cur.execute(
                    "SELECT * FROM profitability WHERE process_id = %s", (process_id,)
                )
                profitability = cur.fetchone()
                if profitability:
                    print("✅ Profitability data exists")
                else:
                    print("⚠️  No profitability data")

            print()

            # 5. Final Summary
            print("=" * 60)
            print("📊 DIAGNOSTIC SUMMARY")
            print("=" * 60)
            print("✅ Database connection: OK")
            print("✅ Required tables: OK")
            print(f"✅ Process {process_id}: EXISTS")
            print(
                f"{'✅' if subprocesses else '⚠️ '} Subprocesses: {len(subprocesses)} found"
            )
            print()
            print("💡 CONCLUSION:")
            if not subprocesses:
                print("   Process exists but has no subprocesses. This might cause")
                print("   the endpoint to return an empty structure, which is OK.")
            else:
                print(
                    "   Process structure looks good! If you're still seeing 500 errors,"
                )
                print("   check the Flask server logs for the actual error message.")
            print()
            print("🧪 TO TEST THE ENDPOINT:")
            print(
                f"   curl http://localhost:5000/api/upf/processes/{process_id}/structure \\"
            )
            print("     -H 'Content-Type: application/json' \\")
            print("     --cookie 'session=YOUR_SESSION_COOKIE'")
            print()

    except Exception as e:
        print(f"\n❌ ERROR: {e}")
        print("\nFull error details:")
        import traceback

        traceback.print_exc()
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
