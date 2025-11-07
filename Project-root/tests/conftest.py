import os
import sys

import pytest

# Add the project root to the Python path to allow for absolute imports
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app import create_app


import pathlib
import importlib.util
import psycopg2
from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT

@pytest.fixture(scope="session", autouse=True)
def setup_test_db():
    """
    Ensure the test database schema is created before any tests run.
    This runs the migrations/init_schema.sql script followed by Python migrations.
    """
    # Get database connection info from environment
    db_host = os.getenv("DB_HOST", "127.0.0.1")
    db_name = os.getenv("DB_NAME", "testuser")
    db_user = os.getenv("DB_USER", "postgres")
    db_pass = os.getenv("DB_PASS", "abcd")
    
    print("\n" + "=" * 80)
    print("Setting up test database...")
    print("=" * 80)
    
    # Step 0: Create the test database if it doesn't exist
    print(f"Ensuring database '{db_name}' exists...")
    try:
        # Connect to the default 'postgres' database to create our test database
        conn_admin = psycopg2.connect(
            host=db_host,
            database="postgres",
            user=db_user,
            password=db_pass
        )
        conn_admin.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
        cur_admin = conn_admin.cursor()
        
        # Check if database exists
        cur_admin.execute(
            "SELECT 1 FROM pg_database WHERE datname = %s;",
            (db_name,)
        )
        exists = cur_admin.fetchone()
        
        if not exists:
            print(f"  Creating database '{db_name}'...")
            cur_admin.execute(f'CREATE DATABASE "{db_name}";')
            print(f"  [OK] Database '{db_name}' created successfully")
        else:
            print(f"  [OK] Database '{db_name}' already exists")
        
        cur_admin.close()
        conn_admin.close()
    except Exception as e:
        print(f"  [WARNING] Could not verify/create database: {e}")
        print("  Proceeding anyway - database may already exist")
    
    # Step 1: Run SQL schema initialization
    print("\nInitializing database schema...")
    migrations_dir = pathlib.Path(__file__).parent.parent / "migrations"
    sql_path = migrations_dir / "init_schema.sql"
    
    with open(sql_path, "r", encoding="utf-8") as f:
        sql = f.read()
    
    db_config = {
        "host": db_host,
        "database": db_name,
        "user": db_user,
        "password": db_pass,
    }
    
    conn = psycopg2.connect(**db_config)
    conn.autocommit = True
    cur = conn.cursor()
    
    try:
        # Execute the entire SQL file as one statement to handle dollar-quoted strings correctly
        cur.execute(sql)
        
        print("[OK] SQL schema initialization completed")
        
        # Step 2: Run Python-based migrations
        print("\nApplying Python migrations...")
        
        # Ensure schema_migrations table exists
        cur.execute("""
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version VARCHAR(255) PRIMARY KEY,
                applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        """)
        
        # Get applied migrations
        cur.execute("SELECT version FROM schema_migrations;")
        applied_migrations = {row[0] for row in cur.fetchall()}
        
        # Discover and apply pending migrations
        migration_files = sorted(
            [f for f in migrations_dir.glob("migration_*.py")]
        )
        
        for migration_file in migration_files:
            version = migration_file.stem  # filename without .py extension
            
            if version not in applied_migrations:
                print(f"  Applying migration: {version}...")
                try:
                    # Load the migration module
                    spec = importlib.util.spec_from_file_location(version, migration_file)
                    migration_module = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(migration_module)
                    
                    # Run the upgrade function if it exists
                    if hasattr(migration_module, 'upgrade'):
                        migration_module.upgrade()
                    
                    # Record migration
                    cur.execute(
                        "INSERT INTO schema_migrations (version) VALUES (%s) ON CONFLICT DO NOTHING;",
                        (version,)
                    )
                    
                    print(f"  [OK] {version} applied successfully")
                except Exception as e:
                    print(f"  [SKIP] Skipping migration {version}: {e}")
                    # Continue with other migrations even if one fails
                    continue
            else:
                print(f"  [SKIP] Already applied: {version}")
        
        print("\n" + "=" * 80)
        print("Test database setup complete!")
        print("=" * 80 + "\n")
        
    finally:
        cur.close()
        conn.close()

@pytest.fixture
def app():
    """Create and configure a new app instance for each test using the factory."""
    flask_app = create_app("testing")
    flask_app.config.update(
        {
            "TESTING": True,
            "WTF_CSRF_ENABLED": False,
            "LOGIN_DISABLED": True,  # Disable login checks in tests to avoid 302 redirects
            "SECRET_KEY": "test-secret-key",
            "SERVER_NAME": "localhost.localdomain",  # Required for url_for with _external=True
            "RATELIMIT_STORAGE_URI": "memory://",  # Explicit memory storage for rate limiter
            # Test database configuration
            "DB_NAME": "testuser",  # Use testuser database for tests
            "DB_HOST": os.getenv("DB_HOST", "127.0.0.1"),
            "DB_USER": os.getenv("DB_USER", "postgres"),
            "DB_PASS": os.getenv("DB_PASS", "abcd"),
        }
    )
    yield flask_app


@pytest.fixture
def client(app):
    """A test client for the app."""
    return app.test_client()


@pytest.fixture
def authenticated_client(app):
    """
    Create an authenticated test client.
    
    Since LOGIN_DISABLED=True in test config, this client will bypass
    authentication checks automatically. This fixture is used for testing
    endpoints that would normally require authentication.
    """
    with app.test_client() as client:
        with app.app_context():
            # With LOGIN_DISABLED=True, no actual login is needed
            # The @login_required decorator will be bypassed
            yield client


@pytest.fixture
def runner(app):
    """A test runner for the app's Click commands."""
    return app.test_cli_runner()
