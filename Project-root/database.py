import os
import psycopg2
import psycopg2.extras
from psycopg2 import pool
from contextlib import contextmanager
from flask import current_app

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
    min_conn = int(app.config.get('DB_POOL_MIN', 4 if app.config.get('ENV') == 'production' else 2))
    max_conn = int(app.config.get('DB_POOL_MAX', 20))
    
    # Connection timeout in seconds (fail fast on unreachable DB)
    connect_timeout = int(app.config.get('DB_CONNECT_TIMEOUT', 10))
    
    # Query timeout in milliseconds (prevent runaway queries)
    statement_timeout = int(app.config.get('DB_STATEMENT_TIMEOUT', 60000))  # 60 seconds
    
    try:
        db_pool = pool.ThreadedConnectionPool(
            min_conn,
            max_conn,
            host=app.config['DB_HOST'],
            database=app.config['DB_NAME'],
            user=app.config['DB_USER'],
            password=app.config['DB_PASS'],
            connect_timeout=connect_timeout,
            keepalives=1,  # Enable TCP keepalives
            keepalives_idle=30,  # Start keepalives after 30s idle
            keepalives_interval=10,  # Send keepalive every 10s
            keepalives_count=5,  # Drop connection after 5 failed keepalives
            options=f'-c statement_timeout={statement_timeout}'
        )
        app.logger.info(
            f"Database pool initialized: {min_conn}-{max_conn} connections "
            f"(timeout: {connect_timeout}s, query timeout: {statement_timeout}ms)"
        )
        
        # Test initial connection
        with get_conn() as (conn, cur):
            cur.execute('SELECT 1')
            app.logger.info("Database connectivity verified")
            
    except psycopg2.OperationalError as e:
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
            current_app.logger.warning("Stale connection detected, reconnecting...")
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
        current_app.logger.error(f"Database connection error: {e}")
        if conn and not autocommit:
            conn.rollback()
        # Close bad connection instead of returning to pool
        if conn:
            db_pool.putconn(conn, close=True)
            conn = None
        raise
        
    except psycopg2.IntegrityError as e:
        # Constraint violation (unique, foreign key, etc.)
        current_app.logger.warning(f"Database integrity error: {e}")
        if conn and not autocommit:
            conn.rollback()
        raise
        
    except Exception as e:
        # General error (syntax, logic, etc.)
        current_app.logger.error(f"Database error: {e}")
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
        current_app.logger.info("Database pool closed")
