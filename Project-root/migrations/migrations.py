import os
import sys

from dotenv import load_dotenv

# Add project root to the Python path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from database import get_conn, init_app

load_dotenv()


# Mock Flask app for context
class MockApp:
    def __init__(self):
        self.logger = lambda: None
        self.logger.info = print
        self.logger.critical = print


def run_sql(sql, params=None, fetch=None):
    """Helper to run SQL commands using the connection context manager."""
    with get_conn() as (conn, cur):
        cur.execute(sql, params)
        if fetch == "one":
            return cur.fetchone()
        if fetch == "all":
            return cur.fetchall()
        conn.commit()


def initialize_migrations_table():
    """Ensure the schema_migrations table exists."""
    run_sql("""
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version VARCHAR(255) PRIMARY KEY,
            applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    """)
    print("✅ schema_migrations table initialized.")


def get_applied_migrations():
    """Fetch the set of already applied migration versions."""
    rows = run_sql("SELECT version FROM schema_migrations;", fetch="all")
    return {row[0] for row in rows}


import importlib.util


def run_migrations():
    """Discover and apply all pending Python-based migrations."""
    init_app(MockApp())
    initialize_migrations_table()
    applied_migrations = get_applied_migrations()

    migrations_dir = os.path.dirname(os.path.abspath(__file__))
    migration_files = sorted(
        [
            f
            for f in os.listdir(migrations_dir)
            if f.startswith("migration_") and f.endswith(".py")
        ]
    )

    for filename in migration_files:
        version = filename.replace(".py", "")
        if version not in applied_migrations:
            print(f"Applying migration: {version}...")
            try:
                spec = importlib.util.spec_from_file_location(
                    version, os.path.join(migrations_dir, filename)
                )
                migration_module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(migration_module)

                migration_module.upgrade()

                # Record migration
                run_sql(
                    "INSERT INTO schema_migrations (version) VALUES (%s);", (version,)
                )
                print(f"✅ {version} applied successfully.")

            except Exception as e:
                print(f"❌ Failed to apply migration {version}: {e}")
                break
        else:
            print(f"Skipping already applied migration: {version}")


if __name__ == "__main__":
    run_migrations()
