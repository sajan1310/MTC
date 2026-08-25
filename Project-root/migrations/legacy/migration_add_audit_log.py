"""
Migration: Add Audit Log Table
Purpose: Track all create, update, delete operations in UPF for compliance and debugging
Author: System
Date: 2024
"""

import os
import sys

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import psycopg2
from config import Config


def _migration_database_url():
    """Prefer TEST_DB_NAME so this migration never touches production when
    invoked from the test harness (tests/conftest.py)."""
    test_db_name = os.getenv("TEST_DB_NAME")
    if not test_db_name:
        return Config.DATABASE_URL
    host = os.getenv("TEST_DB_HOST", os.getenv("DB_HOST", "127.0.0.1"))
    user = os.getenv("TEST_DB_USER", os.getenv("DB_USER", "postgres"))
    password = os.getenv("TEST_DB_PASS", os.getenv("DB_PASS", "abcd"))
    return f"postgresql://{user}:{password}@{host}/{test_db_name}"


def up():
    """Create audit_log table"""
    conn = psycopg2.connect(_migration_database_url())
    cur = conn.cursor()

    try:
        print("Creating audit_log table...")

        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS audit_log (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                action_type VARCHAR(50) NOT NULL,  -- CREATE, UPDATE, DELETE, EXECUTE
                entity_type VARCHAR(100) NOT NULL, -- process, subprocess, variant_usage, etc.
                entity_id INTEGER,                 -- ID of affected entity (nullable for batch operations)
                entity_name VARCHAR(255),          -- Name/description of entity for readability
                changes JSONB,                     -- Detailed change data (old/new values)
                metadata JSONB,                    -- Additional context (IP, user agent, etc.)
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                deleted_at TIMESTAMP DEFAULT NULL,

                FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
            );
        """
        )

        # Indexes for performance
        print("Creating indexes on audit_log...")

        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_audit_user_id
            ON audit_log(user_id) WHERE deleted_at IS NULL;
        """
        )

        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_audit_entity
            ON audit_log(entity_type, entity_id) WHERE deleted_at IS NULL;
        """
        )

        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_audit_timestamp
            ON audit_log(timestamp DESC) WHERE deleted_at IS NULL;
        """
        )

        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_audit_action_type
            ON audit_log(action_type) WHERE deleted_at IS NULL;
        """
        )

        conn.commit()
        print("✓ Audit log table created successfully")

    except psycopg2.Error as e:
        conn.rollback()
        print(f"✗ Error creating audit_log table: {e}")
        raise
    finally:
        cur.close()
        conn.close()


def down():
    """Drop audit_log table"""
    conn = psycopg2.connect(_migration_database_url())
    cur = conn.cursor()

    try:
        print("Dropping audit_log table...")
        cur.execute("DROP TABLE IF EXISTS audit_log CASCADE;")
        conn.commit()
        print("✓ Audit log table dropped successfully")

    except psycopg2.Error as e:
        conn.rollback()
        print(f"✗ Error dropping audit_log table: {e}")
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "down":
        down()
    else:
        up()
