"""
Migration Tracker - Idempotent migration management system.

Tracks which migrations have been applied to the database and ensures
pending migrations are executed in order. Maintains a complete audit trail.

Usage:
    python migrations/migration_tracker.py           # Run all pending migrations
    python migrations/migration_tracker.py --status   # Show migration status
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import List, Tuple

# Ensure project root is on path
sys.path.insert(0, str(Path(__file__).parent.parent))

# Initialize Flask app and database
os.environ.setdefault("FLASK_ENV", os.environ.get("FLASK_ENV", "development"))

from app import create_app
import database

# Create app context for database operations
app = create_app()
app_context = app.app_context()
app_context.push()


def init_migrations_table() -> None:
    """Create migrations_applied table if it doesn't exist.
    
    This table tracks which migrations have been applied to ensure
    idempotent execution and proper ordering.
    """
    with database.get_conn() as (conn, cur):
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS migrations_applied (
                id SERIAL PRIMARY KEY,
                migration_name VARCHAR(255) NOT NULL UNIQUE,
                applied_at TIMESTAMP DEFAULT NOW(),
                status VARCHAR(50) DEFAULT 'completed',
                error_message TEXT
            );
            """
        )
        conn.commit()
        print("[OK] migrations_applied table created/verified")


def get_applied_migrations() -> set[str]:
    """Get set of migration names that have been applied.
    
    Returns:
        Set of migration names (e.g., {'001_create_migration_tracking', '002_...'})
    """
    with database.get_conn() as (conn, cur):
        cur.execute(
            "SELECT migration_name FROM migrations_applied WHERE status = 'completed'"
        )
        return {row[0] for row in cur.fetchall()}


def mark_migration_applied(migration_name: str, status: str = "completed", error: str = None) -> None:
    """Record that a migration has been applied.
    
    Args:
        migration_name: Name of the migration (e.g., '001_create_migration_tracking')
        status: 'completed' or 'failed'
        error: Error message if status is 'failed'
    """
    with database.get_conn() as (conn, cur):
        cur.execute(
            """
            INSERT INTO migrations_applied (migration_name, status, error_message)
            VALUES (%s, %s, %s)
            ON CONFLICT (migration_name) DO UPDATE
            SET status = EXCLUDED.status, error_message = EXCLUDED.error_message
            """,
            (migration_name, status, error),
        )
        conn.commit()


def get_pending_migrations() -> List[Tuple[str, Path]]:
    """Get list of pending migrations in order.
    
    Migrations are numbered (001_, 002_, etc.) to ensure deterministic ordering.
    Only .py files in migrations/ directory are considered.
    
    Returns:
        List of (migration_name, migration_path) tuples sorted by name
    """
    migrations_dir = Path(__file__).parent
    applied = get_applied_migrations()
    
    pending = []
    for migration_file in sorted(migrations_dir.glob("*.py")):
        # Skip this tracker script and __pycache__
        if migration_file.name in ("migration_tracker.py", "__init__.py"):
            continue
        if migration_file.name.startswith("__"):
            continue
            
        migration_name = migration_file.stem  # e.g., '001_create_migration_tracking'
        
        # Skip already-applied migrations
        if migration_name in applied:
            continue
            
        pending.append((migration_name, migration_file))
    
    return pending


def run_pending_migrations() -> None:
    """Execute all pending migrations in order.
    
    Migrations are executed as Python files and expected to have an upgrade() function
    or execute their logic at module level.
    """
    # Ensure migrations table exists first
    init_migrations_table()
    
    pending = get_pending_migrations()
    if not pending:
        print("[OK] No pending migrations")
        return
    
    print(f"Running {len(pending)} pending migration(s)...")
    for migration_name, migration_path in pending:
        try:
            print(f"  Applying {migration_name}...", end=" ")
            
            # Load and execute migration module
            spec = __import__("importlib.util").util.spec_from_file_location(
                migration_name, migration_path
            )
            module = __import__("importlib.util").util.module_from_spec(spec)
            sys.modules[migration_name] = module
            spec.loader.exec_module(module)
            
            # Try to call upgrade() if it exists, otherwise migration ran at module level
            if hasattr(module, "upgrade"):
                module.upgrade()
            
            mark_migration_applied(migration_name, "completed")
            print("[OK]")
            
        except Exception as e:
            error_msg = f"{type(e).__name__}: {e}"
            mark_migration_applied(migration_name, "failed", error_msg)
            print(f"[FAIL] {error_msg}")
            raise


def show_migration_status() -> None:
    """Display current migration status."""
    init_migrations_table()
    
    applied = get_applied_migrations()
    pending = get_pending_migrations()
    
    print("\n=== Migration Status ===")
    print(f"\nApplied ({len(applied)}):")
    with database.get_conn() as (conn, cur):
        cur.execute(
            "SELECT migration_name, applied_at, status FROM migrations_applied ORDER BY applied_at"
        )
        for row in cur.fetchall():
            status_icon = "[OK]" if row[2] == "completed" else "[FAIL]"
            print(f"  {status_icon} {row[0]} ({row[1]})")
    
    print(f"\nPending ({len(pending)}):")
    if pending:
        for migration_name, _ in pending:
            print(f"  - {migration_name}")
    else:
        print("  (none)")
    
    print()


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="Run pending database migrations")
    parser.add_argument(
        "--status",
        action="store_true",
        help="Show migration status instead of running migrations"
    )
    
    args = parser.parse_args()
    
    if args.status:
        show_migration_status()
    else:
        run_pending_migrations()
        print("\n[OK] All migrations completed successfully")
