"""ERP-specific test fixtures.

Builds on the base test-DB bootstrap in tests/conftest.py (setup_test_db)
rather than replacing it: that fixture drops/recreates TEST_DB_NAME and runs
the legacy migrations, and this module additionally applies
migrations/erp/*.sql against the same database, then skips the whole ERP
test session (not fails it) if Postgres isn't reachable.

Unlike the base `app`/`authenticated_client` fixtures in tests/conftest.py
(which set LOGIN_DISABLED=True and never actually log in), erp_client does a
real flask-login session login so @login_required is genuinely exercised on
the RPC path.
"""

from __future__ import annotations

import os

import psycopg2
import pytest

import database
from app import create_app
from migrations.erp.runner import run_pending_migrations


def _test_db_kwargs() -> dict:
    return {
        "host": os.getenv("TEST_DB_HOST", os.getenv("DB_HOST", "127.0.0.1")),
        "dbname": os.getenv("TEST_DB_NAME", "testdb"),
        "user": os.getenv("TEST_DB_USER", os.getenv("DB_USER", "postgres")),
        "password": os.getenv("TEST_DB_PASS", os.getenv("DB_PASS", "abcd")),
    }


@pytest.fixture(scope="session", autouse=True)
def setup_erp_schema(setup_test_db):
    """Apply migrations/erp/*.sql against the test DB setup_test_db built.

    Skips every ERP test for the session if Postgres isn't reachable,
    instead of failing them.
    """
    try:
        applied = run_pending_migrations(**_test_db_kwargs())
    except psycopg2.OperationalError as exc:
        pytest.skip(f"Postgres not reachable for ERP tests: {exc}")
        return
    yield applied


@pytest.fixture
def erp_app(setup_erp_schema):
    """create_app('testing') with real login enforcement.

    Deliberately does NOT set LOGIN_DISABLED=True (unlike the base `app`
    fixture in tests/conftest.py) so @login_required on the RPC dispatcher
    is actually exercised.
    """
    flask_app = create_app("testing")
    flask_app.config.update(
        TESTING=True,
        WTF_CSRF_ENABLED=False,
        SECRET_KEY="test-secret-key",
        SERVER_NAME="localhost.localdomain",
        RATELIMIT_STORAGE_URI="memory://",
    )
    return flask_app


@pytest.fixture
def erp_test_user(erp_app):
    """Insert (or reuse) a throwaway public.users row; return its user_id."""
    with erp_app.app_context():
        with database.get_conn() as (_conn, cur):
            cur.execute(
                """
                INSERT INTO users (name, email, password_hash, role)
                VALUES (%s, %s, %s, 'user')
                ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
                RETURNING user_id
                """,
                ("ERP Test User", "erp-test-user@example.invalid", "not-a-real-hash"),
            )
            return cur.fetchone()[0]


@pytest.fixture
def erp_client(erp_app, erp_test_user):
    """A test client with a real flask-login session (not LOGIN_DISABLED)."""
    client = erp_app.test_client()
    with client.session_transaction() as sess:
        sess["_user_id"] = str(erp_test_user)
        sess["_fresh"] = True
    return client


@pytest.fixture
def erp_admin_user(erp_app):
    """Same pattern as erp_test_user, role='admin' -- for RpcSpec.roles-gated
    methods (users_service.py) that a plain 'user' role must be denied."""
    with erp_app.app_context():
        with database.get_conn() as (_conn, cur):
            cur.execute(
                """
                INSERT INTO users (name, email, password_hash, role)
                VALUES (%s, %s, %s, 'admin')
                ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, role = 'admin'
                RETURNING user_id
                """,
                ("ERP Admin Test User", "erp-admin-test-user@example.invalid", "not-a-real-hash"),
            )
            return cur.fetchone()[0]


@pytest.fixture
def erp_admin_client(erp_app, erp_admin_user):
    client = erp_app.test_client()
    with client.session_transaction() as sess:
        sess["_user_id"] = str(erp_admin_user)
        sess["_fresh"] = True
    return client


@pytest.fixture
def erp_super_admin_user(erp_app):
    """Same pattern as erp_admin_user, role='super_admin' -- 'super_admin'
    isn't in users_service.ROLES (it's not a role updateUserRole can ever
    promote someone TO, only a status a user can already hold), so this
    seeds it directly, same as the real bootstrap path would."""
    with erp_app.app_context():
        with database.get_conn() as (_conn, cur):
            cur.execute(
                """
                INSERT INTO users (name, email, password_hash, role)
                VALUES (%s, %s, %s, 'super_admin')
                ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, role = 'super_admin'
                RETURNING user_id
                """,
                ("ERP Super Admin Test User", "erp-super-admin-test-user@example.invalid", "not-a-real-hash"),
            )
            return cur.fetchone()[0]


@pytest.fixture
def erp_super_admin_client(erp_app, erp_super_admin_user):
    client = erp_app.test_client()
    with client.session_transaction() as sess:
        sess["_user_id"] = str(erp_super_admin_user)
        sess["_fresh"] = True
    return client
