from contextlib import contextmanager
from urllib.parse import urlparse

import psycopg2
import psycopg2.extras
from psycopg2 import pool

db_pool = None


def init_app(app):
    """
    Initialize database connection pool with production-grade settings.

    Uses ThreadedConnectionPool for better concurrency handling.
    Pool sizing follows best practices: min = cores, max = 2-3x workers.
    """
    global db_pool

    # Production-optimized pool sizing
    # min_conn: Keep warm connections ready (default: 2 for dev, 4 for prod)
    # max_conn: Handle burst traffic (default: 20)
    min_conn = int(
        app.config.get("DB_POOL_MIN", 4 if app.config.get("ENV") == "production" else 2)
    )
    max_conn = int(app.config.get("DB_POOL_MAX", 20))

    # Connection timeout in seconds (fail fast on unreachable DB)
    connect_timeout = int(app.config.get("DB_CONNECT_TIMEOUT", 10))

    # Query timeout in milliseconds (prevent runaway queries)
    statement_timeout = int(app.config.get("DB_STATEMENT_TIMEOUT", 60000))  # 60 seconds

    try:
        # Prefer DATABASE_URL if provided; fallback to discrete DB_* settings
        db_kwargs = {
            "host": app.config.get("DB_HOST"),
            "database": app.config.get("DB_NAME"),
            "user": app.config.get("DB_USER"),
            "password": app.config.get("DB_PASS"),
        }
        if app.config.get("DATABASE_URL"):
            parsed = urlparse(
                app.config["DATABASE_URL"]
            )  # e.g., postgres://user:pass@host:port/db
            if parsed.scheme.startswith("postgres"):
                db_kwargs["host"] = parsed.hostname or db_kwargs.get("host")
                db_kwargs["user"] = parsed.username or db_kwargs.get("user")
                db_kwargs["password"] = parsed.password or db_kwargs.get("password")
                # Remove leading '/' from path to get database name
                dbname = (parsed.path or "").lstrip("/")
                if dbname:
                    db_kwargs["database"] = dbname
                if parsed.port:
                    db_kwargs["port"] = parsed.port

        db_pool = pool.ThreadedConnectionPool(
            min_conn,
            max_conn,
            connect_timeout=connect_timeout,
            keepalives=1,  # Enable TCP keepalives
            keepalives_idle=30,  # Start keepalives after 30s idle
            keepalives_interval=10,  # Send keepalive every 10s
            keepalives_count=5,  # Drop connection after 5 failed keepalives
            options=f"-c statement_timeout={statement_timeout}",
            **db_kwargs,
        )
        app.logger.info(
            f"Database pool initialized: {min_conn}-{max_conn} connections "
            f"(timeout: {connect_timeout}s, query timeout: {statement_timeout}ms)"
        )

        # Test initial connection (skip in testing to avoid local DB requirement)
        if not app.config.get("TESTING"):
            with get_conn() as (conn, cur):
                cur.execute("SELECT 1")
                app.logger.info("Database connectivity verified")

    except psycopg2.OperationalError as e:
        if app.config.get("TESTING"):
            # In tests, allow app to start without an available DB; tests may mock DB
            app.logger.warning(
                f"[TESTING] Database not reachable; proceeding without DB pool: {e}"
            )
            db_pool = None
            return
        app.logger.critical(f"FATAL: Could not connect to database: {e}")
        app.logger.critical("   Please verify DATABASE_URL and database availability")
        db_pool = None
        raise  # Re-raise to prevent app startup with broken DB
    except Exception as e:
        app.logger.critical(f"FATAL: Database initialization error: {e}")
        db_pool = None
        raise


@contextmanager
def get_conn(cursor_factory=None, autocommit=False):
    """
    Production-grade context manager for database connections.

    Features:
    - Automatic connection pool management
    - Transaction rollback on errors
    - Connection health monitoring
    - Proper resource cleanup

    Usage:
        with get_conn() as (conn, cur):
            cur.execute("SELECT * FROM table")
            results = cur.fetchall()

    Args:
        cursor_factory: psycopg2 cursor factory (e.g., RealDictCursor)
        autocommit: If True, each statement commits immediately
    """
    if not db_pool:
        raise ConnectionError(
            "Database pool is not available. "
            "Ensure init_app() was called and DATABASE_URL is configured."
        )

    conn = None
    cur = None
    try:
        # Get connection from pool
        conn = db_pool.getconn()

        # Verify connection is still alive (handles stale connections)
        if conn.closed:
            # Try to log warning if Flask app context is available
            try:
                from flask import current_app

                current_app.logger.warning("Stale connection detected, reconnecting...")
            except (ImportError, RuntimeError):
                print("WARNING: Stale connection detected, reconnecting...")
            db_pool.putconn(conn, close=True)
            conn = db_pool.getconn()

        conn.autocommit = autocommit
        cur = conn.cursor(cursor_factory=cursor_factory)

        yield conn, cur

        # Commit transaction if not in autocommit mode
        if not autocommit:
            conn.commit()

    except psycopg2.OperationalError as e:
        # Connection-level error (network, server crash, etc.)
        try:
            from flask import current_app

            current_app.logger.error(f"Database connection error: {e}")
        except (ImportError, RuntimeError):
            print(f"ERROR: Database connection error: {e}")
        if conn and not autocommit:
            conn.rollback()
        # Close bad connection instead of returning to pool
        if conn:
            db_pool.putconn(conn, close=True)
            conn = None
        raise

    except psycopg2.IntegrityError as e:
        # Constraint violation (unique, foreign key, etc.)
        try:
            from flask import current_app

            current_app.logger.warning(f"Database integrity error: {e}")
        except (ImportError, RuntimeError):
            print(f"WARNING: Database integrity error: {e}")
        if conn and not autocommit:
            conn.rollback()
        raise

    except Exception as e:
        # General error (syntax, logic, etc.)
        try:
            from flask import current_app

            current_app.logger.error(f"Database error: {e}")
        except (ImportError, RuntimeError):
            print(f"ERROR: Database error: {e}")
        if conn and not autocommit:
            conn.rollback()
        raise

    finally:
        # Always clean up resources
        if cur:
            cur.close()
        if conn:
            # Return connection to pool (or was closed above)
            db_pool.putconn(conn)


def close_db_pool():
    """Close all database connections. Call on application shutdown."""
    if db_pool:
        db_pool.closeall()


def transactional(func):
    """
    Decorator for automatic transaction management.

    Wraps a function to automatically:
    - Start a database transaction
    - Commit on success
    - Rollback on any exception
    - Properly clean up resources

    The decorated function must accept 'conn' and 'cur' as first two arguments
    (or as keyword arguments).

    Usage:
        @transactional
        def update_process(conn, cur, process_id, **kwargs):
            cur.execute("UPDATE processes SET ...")
            # Transaction auto-commits on success
            return result

    Example:
        @transactional
        def create_process_with_subprocesses(conn, cur, name, subprocess_ids):
            cur.execute("INSERT INTO processes ...")
            process_id = cur.fetchone()['id']
            for sp_id in subprocess_ids:
                cur.execute("INSERT INTO process_subprocesses ...")
            # All-or-nothing: commits if all succeed, rolls back on any error
            return process_id
    """
    from functools import wraps

    @wraps(func)
    def wrapper(*args, **kwargs):
        with get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (conn, cur):
            try:
                # Call the wrapped function with conn and cur
                result = func(conn, cur, *args, **kwargs)
                # Transaction is committed by get_conn context manager
                return result
            except Exception as e:
                # get_conn context manager handles rollback
                try:
                    from flask import current_app

                    current_app.logger.error(
                        f"Transaction failed in {func.__name__}: {e}", exc_info=True
                    )
                except (ImportError, RuntimeError):
                    print(f"ERROR: Transaction failed in {func.__name__}: {e}")
                raise

    return wrapper
