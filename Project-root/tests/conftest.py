import os
import sys

import pytest

# Migration scripts print Unicode characters (checkmarks, etc.). On Windows,
# stdout defaults to the system codepage (e.g. cp1252) instead of UTF-8, which
# raises UnicodeEncodeError and aborts the migration mid-transaction. CI
# (Linux, UTF-8 by default) never hits this, which is why it stays hidden
# until someone runs the suite fresh on Windows.
if sys.platform == "win32":
    for _stream in (sys.stdout, sys.stderr):
        if hasattr(_stream, "reconfigure"):
            _stream.reconfigure(encoding="utf-8", errors="replace")

# PERF-003: fail the suite on nested pooled-connection acquisition.
#
# A function that already holds a connection and opens a second one halves
# effective concurrency, adds a connection establishment to the request
# (measured at 65ms for a 0.6ms query), and -- because
# ThreadedConnectionPool.getconn() RAISES rather than waiting when the pool is
# full -- turns load into a wall of 500s instead of a queue.
#
# Set BEFORE `database` is imported, since it reads the flag at module scope.
# A test that genuinely needs two connections (proving lock contention, which
# one connection cannot demonstrate) opts out explicitly with
# database.allow_nested_connections().
os.environ.setdefault("STRICT_NESTED_CONNECTIONS", "1")

# Add the project root to the Python path to allow for absolute imports
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app import create_app


import psycopg2
from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT


@pytest.fixture(scope="session", autouse=True)
def setup_test_db():
    """Build the test database schema before any test runs.

    Uses migrations/erp/runner.py -- the same code the deploy path runs, and
    the only migration path there is (MIG-001). It builds the public core
    tables (000_public_core.sql) and then the whole erp schema, tracked in
    erp.migrations_applied.

    This used to run migrations/init_schema.sql followed by ~29 legacy
    migration_*.py scripts in retry passes, because alphabetical order is not
    dependency order. That produced a test database with 52 public tables
    against production's 3: every session rebuilt 47 tables that production
    does not have and no test asserts anything about. Those scripts now live
    in migrations/legacy/ and nothing executes them -- see that directory's
    README for the evidence.
    """
    # Get database connection info from environment.
    # DB_NAME must NEVER be used as a fallback here: it points at the
    # production database, and this fixture runs schema migrations and
    # seeds data against whatever database it resolves to.
    db_host = os.getenv("TEST_DB_HOST", os.getenv("DB_HOST", "127.0.0.1"))
    db_name = os.getenv("TEST_DB_NAME", "testdb")
    db_user = os.getenv("TEST_DB_USER", os.getenv("DB_USER", "postgres"))
    db_pass = os.getenv("TEST_DB_PASS", os.getenv("DB_PASS", "abcd"))

    prod_db = os.getenv("DB_NAME", "MTC")
    if db_name == prod_db and db_name != "testdb":
        raise RuntimeError(
            f"FATAL: setup_test_db resolved to production database '{db_name}'. "
            f"Set TEST_DB_NAME to a dedicated test database (e.g. 'testdb') before running tests."
        )

    print("\n" + "=" * 80)
    print("Setting up test database...")
    print("=" * 80)

    # Step 0: Create the test database if it doesn't exist
    print(f"Ensuring database '{db_name}' exists...")
    try:
        # Connect to the default 'postgres' database to create our test database
        conn_admin = psycopg2.connect(
            host=db_host, database="postgres", user=db_user, password=db_pass
        )
        conn_admin.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
        cur_admin = conn_admin.cursor()

        # Check if database exists. The test database is intentionally
        # disposable, so recreate it from scratch to avoid schema drift from
        # previous runs or half-applied migrations.
        cur_admin.execute("SELECT 1 FROM pg_database WHERE datname = %s;", (db_name,))
        exists = cur_admin.fetchone()

        if exists:
            print(f"  Recreating existing database '{db_name}'...")
            cur_admin.execute(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = %s AND pid <> pg_backend_pid();",
                (db_name,),
            )
            cur_admin.execute(f'DROP DATABASE IF EXISTS "{db_name}";')
            cur_admin.execute(f'CREATE DATABASE "{db_name}";')
            print(f"  [OK] Database '{db_name}' recreated successfully")
        else:
            print(f"  Creating database '{db_name}'...")
            cur_admin.execute(f'CREATE DATABASE "{db_name}";')
            print(f"  [OK] Database '{db_name}' created successfully")

        cur_admin.close()
        conn_admin.close()
    except Exception as e:
        print(f"  [WARNING] Could not verify/create database: {e}")
        print("  Proceeding anyway - database may already exist")

    # Step 1: Apply the migration chain -- the SAME runner the deploy path
    # uses, against the disposable test database. Explicit connection kwargs
    # are mandatory here: the runner prefers DATABASE_URL when none are
    # given, and config.py's load_dotenv() repopulates that from .env the
    # moment `app` is imported, which points at production.
    print("\nApplying migrations (migrations/erp/runner.py)...")
    from migrations.erp.runner import run_pending_migrations

    applied = run_pending_migrations(
        host=db_host, dbname=db_name, user=db_user, password=db_pass
    )
    print(f"  [OK] applied {len(applied)} migration(s)")

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
        # The connection pool the non-Flask fixtures use directly.
        import database

        class MockApp:
            def __init__(self):
                class MockLogger:
                    def info(self, msg):
                        print(f"INFO: {msg}")

                    def critical(self, msg):
                        print(f"CRITICAL: {msg}")

                    def warning(self, msg):
                        print(f"WARNING: {msg}")

                self.logger = MockLogger()
                self.config = {
                    "DATABASE_URL": f"postgresql://{db_user}:{db_pass}@{db_host}/{db_name}",
                    "DB_HOST": db_host,
                    "DB_NAME": db_name,
                    "DB_USER": db_user,
                    "DB_PASS": db_pass,
                    "DB_POOL_MIN": 2,
                    "DB_POOL_MAX": 10,
                    "DB_CONNECT_TIMEOUT": 10,
                    "DB_STATEMENT_TIMEOUT": 60000,
                    "TESTING": True,
                    "ENV": "testing",
                }

            def get(self, key, default=None):
                return self.config.get(key, default)

        try:
            database.init_app(MockApp())
            print("  [OK] Database connection pool initialized")
        except Exception as e:
            print(f"  [WARNING] Database pool initialization: {e}")

        # The schema this leaves behind is production's, exactly: 3 public
        # tables and the erp schema. Asserted rather than assumed, because a
        # test database that quietly drifts from production is how a whole
        # suite passes against tables production does not have.
        cur.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"
        )
        public_tables = {row[0] for row in cur.fetchall()}
        expected = {"users", "password_reset_tokens", "custom_roles"}
        if public_tables != expected:
            raise RuntimeError(
                f"Test database public schema does not match production. "
                f"Expected {sorted(expected)}, got {sorted(public_tables)}. "
                f"Extra: {sorted(public_tables - expected)}, "
                f"missing: {sorted(expected - public_tables)}."
            )
        print(f"  [OK] public schema matches production: {sorted(public_tables)}")

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
