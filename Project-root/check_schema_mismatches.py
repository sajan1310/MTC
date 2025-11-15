"""Check for column name mismatches between database and models."""

from database import get_conn
import psycopg2.extras
from app import create_app

# Create Flask app context
app = create_app()

with app.app_context():
    with get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (conn, cur):

        # Check critical tables
        tables_to_check = [
            "process_subprocesses",
            "variant_usage",
            "subprocess_inputs",
            "production_lots",
            "inventory_alerts",
        ]

        print("=== DATABASE SCHEMA CHECK ===\n")

        for table in tables_to_check:
            cur.execute(
                """
                SELECT column_name, data_type 
                FROM information_schema.columns 
                WHERE table_name = %s 
                ORDER BY ordinal_position
            """,
                (table,),
            )

            columns = cur.fetchall()
            if columns:
                print(f"\n{table}:")
                for col in columns:
                    print(f"  - {col['column_name']} ({col['data_type']})")
            else:
                print(f"\n{table}: TABLE NOT FOUND")
