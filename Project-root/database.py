import os
import psycopg2
import psycopg2.extras
from psycopg2 import pool
from contextlib import contextmanager
from flask import current_app

db_pool = None

def init_app(app):
    """
    Initialize database connection pool with optimized settings.
    
    Uses ThreadedConnectionPool for better concurrency handling.
    """
    global db_pool
    
    # Get configuration from Flask app config
    min_conn = int(app.config.get('DB_POOL_MIN', 2))
    max_conn = int(app.config.get('DB_POOL_MAX', 20))
    
    try:
        db_pool = pool.ThreadedConnectionPool(
            min_conn,
            max_conn,
            host=app.config['DB_HOST'],
            database=app.config['DB_NAME'],
            user=app.config['DB_USER'],
            password=app.config['DB_PASS'],
            connect_timeout=5,
            options='-c statement_timeout=30000'  # 30 second query timeout
        )
        app.logger.info(f"✅ Database pool initialized: {min_conn}-{max_conn} connections")
    except psycopg2.OperationalError as e:
        app.logger.critical(f"❌ FATAL: Could not connect to database: {e}")
        db_pool = None

@contextmanager
def get_conn(cursor_factory=None, autocommit=False):
    """
    Context manager for database connections with automatic cleanup.
    
    Usage:
        with get_conn() as (conn, cur):
            cur.execute("SELECT * FROM table")
            results = cur.fetchall()
    """
    if not db_pool:
        raise ConnectionError("Database pool is not available. Check DB credentials.")
    
    conn = None
    cur = None
    try:
        conn = db_pool.getconn()
        conn.autocommit = autocommit
        cur = conn.cursor(cursor_factory=cursor_factory)
        yield conn, cur
    except Exception as e:
        print(f"Database error: {e}")
        if conn:
            conn.rollback()
        raise
    finally:
        if cur:
            cur.close()
        if conn:
            db_pool.putconn(conn)

def close_db_pool():
    """Close all database connections. Call on application shutdown."""
    if db_pool:
        db_pool.closeall()
        current_app.logger.info("Database pool closed")
