import os
import psycopg2
import psycopg2.extras
from psycopg2 import pool
from contextlib import contextmanager
from flask import current_app

db_pool = None

def init_app(app):
    global db_pool
    try:
        db_pool = pool.SimpleConnectionPool(
            1, 10,
            host=os.environ.get('DB_HOST', '127.0.0.1'),
            database=os.environ.get('DB_NAME', 'MTC'),
            user=os.environ.get('DB_USER', 'postgres'),
            password=os.environ.get('DB_PASS')
        )
    except psycopg2.OperationalError as e:
        app.logger.critical(f"FATAL: Could not connect to the database: {e}")
        db_pool = None

@contextmanager
def get_conn(cursor_factory=None, autocommit=False):
    if not db_pool:
        raise ConnectionError("Database pool is not available.")
    conn = None
    try:
        conn = db_pool.getconn()
        conn.autocommit = autocommit
        cur = conn.cursor(cursor_factory=cursor_factory)
        yield conn, cur
    except Exception as e:
        current_app.logger.error(f"Database transaction error: {e}")
        if conn:
            conn.rollback()
        raise
    finally:
        if conn:
            db_pool.putconn(conn)

def close_db_pool():
    if db_pool:
        db_pool.closeall()
