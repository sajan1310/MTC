"""The user activity log (AUDIT-001).

The application had no record of who did what. Each table's `updated_by`
column holds the LAST writer only -- no history, nothing for deletes, and
nothing at all for sign-ins or refused actions. `app/erp/services/
activity_service.py` restores that; these tests hold it to the four
properties it is worth having:

  * it records what happened, including the failures and the refusals;
  * it never breaks the action it is describing;
  * it never stores a password;
  * it does not grow without bound, and not everyone can read it.
"""

from __future__ import annotations

import uuid

import psycopg2.extras
import pytest

import database
from app.erp.services import activity_service

pytestmark = pytest.mark.integration


def _rpc(client, method, args=None, mutation=False, mutation_id=None):
    headers = {}
    if mutation:
        headers["X-Mutation-Id"] = mutation_id or str(uuid.uuid4())
    return client.post(
        f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers
    )


def _rows(where_sql: str, params: tuple) -> list[dict]:
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_c, cur):
        cur.execute(
            f"SELECT * FROM erp.activity_log WHERE {where_sql} ORDER BY id", params
        )
        return [dict(r) for r in cur.fetchall()]


@pytest.fixture
def vendor_name():
    """A throwaway vendor name, with its vendor row and audit rows removed."""
    name = f"ActivityVendor-{uuid.uuid4().hex[:8]}"
    yield name
    try:
        with database.get_conn() as (_c, cur):
            cur.execute("DELETE FROM erp.vendors WHERE vendor_name = %s", (name,))
            cur.execute(
                "DELETE FROM erp.activity_log WHERE args::text LIKE %s", (f"%{name}%",)
            )
    except Exception:  # noqa: BLE001 -- best-effort teardown
        pass


# ── the mutation path ────────────────────────────────────────────────────


def test_a_successful_mutation_is_recorded(erp_client, erp_test_user, vendor_name):
    """The base case, and the one the whole feature exists for: a save leaves
    a row naming the user, the method, the module and the outcome."""
    response = _rpc(
        erp_client, "saveVendor", [{"vendorName": vendor_name}], mutation=True
    )
    assert response.status_code == 200
    assert response.get_json()["success"] is True

    rows = _rows(
        "action = %s AND args::text LIKE %s", ("saveVendor", f"%{vendor_name}%")
    )
    assert len(rows) == 1
    row = rows[0]
    assert row["user_id"] == erp_test_user
    assert row["category"] == "rpc"
    assert row["status"] == "success"
    assert row["entity_type"] == "vendors_service"
    assert vendor_name in row["detail"]
    # Named from the service's own signature, not arg0/arg1 -- that naming is
    # what makes a row readable a year later.
    assert row["args"]["form_data"]["vendorName"] == vendor_name
    assert row["request_id"]
    assert row["duration_ms"] is not None


def test_a_rejected_mutation_is_recorded_with_its_reason(erp_client, erp_test_user):
    """A save the user was told no to is exactly as interesting as one that
    worked -- more so, when the question is why a number never appeared."""
    mutation_id = str(uuid.uuid4())
    response = _rpc(
        erp_client,
        "saveVendor",
        [{"vendorName": "  "}],
        mutation=True,
        mutation_id=mutation_id,
    )
    assert response.status_code == 200
    assert response.get_json()["success"] is False

    rows = _rows(
        "action = %s AND request_id IS NOT NULL AND status = %s",
        ("saveVendor", "failure"),
    )
    assert rows, "a domain rejection must still be recorded"
    row = rows[-1]
    assert row["status"] == "failure"
    assert "Vendor name cannot be empty" in row["detail"]

    with database.get_conn() as (_c, cur):
        cur.execute("DELETE FROM erp.activity_log WHERE id = %s", (row["id"],))


def test_a_replayed_mutation_id_records_only_one_row(erp_client, vendor_name):
    """The second call returns the stored envelope without executing, so it
    must not claim the action happened twice."""
    mutation_id = str(uuid.uuid4())
    first = _rpc(
        erp_client,
        "saveVendor",
        [{"vendorName": vendor_name}],
        mutation=True,
        mutation_id=mutation_id,
    )
    second = _rpc(
        erp_client,
        "saveVendor",
        [{"vendorName": vendor_name}],
        mutation=True,
        mutation_id=mutation_id,
    )
    assert first.get_json() == second.get_json()

    rows = _rows(
        "action = %s AND args::text LIKE %s", ("saveVendor", f"%{vendor_name}%")
    )
    assert len(rows) == 1


def test_reads_are_not_recorded(erp_client):
    """Deliberate: getDashboardData alone is polled on a timer by every open
    tab. Logging reads would bury the actions that matter."""
    before = _rows("action = %s", ("getVendorsData",))
    assert _rpc(erp_client, "getVendorsData").status_code == 200
    assert len(_rows("action = %s", ("getVendorsData",))) == len(before)


# ── the security path ────────────────────────────────────────────────────


def test_an_authorization_refusal_is_recorded(erp_client, erp_test_user):
    """The only signal this application has that someone is probing what they
    can reach. Recorded for reads too -- getActivityLog is one -- because a
    refused read is as interesting as a refused write."""
    response = _rpc(erp_client, "getActivityLog")
    assert response.status_code == 403

    rows = _rows(
        "action = %s AND user_id = %s AND status = %s",
        ("getActivityLog", erp_test_user, "denied"),
    )
    assert rows, "a 403 must leave a trace"
    assert "user" in rows[-1]["detail"]

    with database.get_conn() as (_c, cur):
        cur.execute("DELETE FROM erp.activity_log WHERE id = %s", (rows[-1]["id"],))


def test_passwords_are_never_stored(erp_admin_client, erp_admin_user):
    """createUser(name, email, password, confirm_password, role). Redaction is
    driven by the PARAMETER NAME, so it covers methods added later too --
    which is the only version of this that stays true."""
    email = f"activity-{uuid.uuid4().hex[:8]}@example.invalid"
    secret = "Sup3rSecret!Passw0rd"
    response = _rpc(
        erp_admin_client,
        "createUser",
        ["Activity Test", email, secret, secret, "user"],
        mutation=True,
    )
    assert response.status_code == 200

    rows = _rows("action = %s AND args::text LIKE %s", ("createUser", f"%{email}%"))
    assert len(rows) == 1
    args = rows[0]["args"]
    assert args["email"] == email
    assert args["password"] == "***"
    assert args["confirm_password"] == "***"
    assert secret not in rows[0]["args"].__str__()

    with database.get_conn() as (_c, cur):
        cur.execute("DELETE FROM erp.activity_log WHERE id = %s", (rows[0]["id"],))
        cur.execute("DELETE FROM users WHERE email = %s", (email,))


def test_reading_the_log_requires_admin(erp_client, erp_admin_client):
    assert _rpc(erp_client, "getActivityLog").status_code == 403
    assert _rpc(erp_admin_client, "getActivityLog").status_code == 200


def test_get_activity_log_paginates_and_filters(
    erp_admin_client, erp_app, erp_admin_user
):
    marker = f"marker-{uuid.uuid4().hex[:8]}"
    with erp_app.app_context():
        for index in range(3):
            activity_service.record(
                category="rpc",
                action="testMarkerAction",
                status="success",
                detail=f"{marker} #{index}",
                user_id=erp_admin_user,
            )

    response = _rpc(erp_admin_client, "getActivityLog", [{"search": marker}, 1, 2])
    data = response.get_json()["data"]
    assert data["total"] == 3
    assert data["totalPages"] == 2
    assert len(data["entries"]) == 2
    # Newest first, so page 1 holds #2 and #1.
    assert data["entries"][0]["detail"].endswith("#2")
    assert data["entries"][0]["action"] == "testMarkerAction"

    filtered = _rpc(
        erp_admin_client,
        "getActivityLog",
        [{"action": "testMarkerAction", "status": "failure"}],
    )
    assert filtered.get_json()["data"]["total"] == 0

    with database.get_conn() as (_c, cur):
        cur.execute(
            "DELETE FROM erp.activity_log WHERE action = %s", ("testMarkerAction",)
        )


# ── the failure policy ───────────────────────────────────────────────────


def test_record_never_raises(erp_app, monkeypatch):
    """The whole design rests on this: an audit write that fails must not turn
    a saved bill into an error the user sees."""

    def _explode(*args, **kwargs):
        raise RuntimeError("pool is gone")

    monkeypatch.setattr(database, "get_conn", _explode)
    with erp_app.app_context():
        activity_service.record(category="rpc", action="anything", status="success")


def test_a_broken_activity_log_does_not_break_the_action(
    erp_client, vendor_name, monkeypatch
):
    """Same guarantee, proven end to end through the dispatcher."""

    def _explode(**kwargs):
        raise RuntimeError("activity log is down")

    monkeypatch.setattr(activity_service, "record", _explode)
    response = _rpc(
        erp_client, "saveVendor", [{"vendorName": vendor_name}], mutation=True
    )
    assert response.status_code == 200
    assert response.get_json()["success"] is True


def test_a_failed_write_through_a_caller_cursor_leaves_the_transaction_usable(erp_app):
    """The signup route passes its own cursor so the audit row commits with the
    account. That must not mean a broken audit log rolls the account back: in
    Postgres ANY failed statement aborts the whole transaction, so without the
    SAVEPOINT the `SELECT 1` below raises InFailedSqlTransaction and the
    signup's own commit fails."""
    with erp_app.app_context():
        with database.get_conn() as (_conn, cur):
            # user_id is INTEGER; this fails in Postgres, not in Python, which
            # is the case that matters -- a value record() cannot pre-validate.
            activity_service.record(
                category="auth",
                action="savepointTest",
                status="success",
                user_id="not-an-integer",
                cur=cur,
            )
            cur.execute("SELECT 1")
            assert cur.fetchone()[0] == 1

    assert _rows("action = %s", ("savepointTest",)) == []


def test_a_write_through_a_caller_cursor_shares_its_transaction(erp_app):
    """The other half of the same bargain: if the caller's transaction rolls
    back, the row goes with it. A signup that never happened must not leave a
    "signed up" row behind."""
    action = f"cursorTest-{uuid.uuid4().hex[:6]}"
    with erp_app.app_context():
        with pytest.raises(RuntimeError):
            with database.get_conn() as (_conn, cur):
                activity_service.record(
                    category="auth", action=action, status="success", cur=cur
                )
                raise RuntimeError("caller failed after the audit write")

    assert _rows("action = %s", (action,)) == []


# ── retention ────────────────────────────────────────────────────────────


def test_prune_deletes_only_rows_past_the_window(erp_app):
    """An audit log with no ceiling is a disk outage on a schedule."""
    action = f"pruneTest-{uuid.uuid4().hex[:6]}"
    with database.get_conn() as (_c, cur):
        cur.execute(
            "INSERT INTO erp.activity_log (logged_at, category, action, status) "
            "VALUES (NOW() - INTERVAL '400 days', 'rpc', %s, 'success'), (NOW(), 'rpc', %s, 'success')",
            (action, action),
        )

    with erp_app.app_context():
        removed = activity_service.prune_old_activity(retention_days=90)

    assert removed >= 1
    surviving = _rows("action = %s", (action,))
    assert len(surviving) == 1

    with database.get_conn() as (_c, cur):
        cur.execute("DELETE FROM erp.activity_log WHERE action = %s", (action,))


# ── argument capture ─────────────────────────────────────────────────────


def test_oversized_arguments_are_replaced_not_stored():
    """A dispatch save can carry hundreds of lines. The `args` blob is a
    debugging aid, not a second copy of the database."""
    payload = describe = activity_service.describe_args(
        None, [{"note": "x" * 50} for _ in range(500)]
    )
    assert "__omitted__" in describe, payload


def test_unnamed_arguments_still_produce_a_usable_row():
    """A method whose signature cannot be read falls back to positions rather
    than recording nothing -- 'saveBill was called' without the id is a row
    nobody can act on."""
    assert activity_service.describe_args(None, [7, "abc"]) == {
        "arg0": 7,
        "arg1": "abc",
    }
    assert activity_service.describe_args(None, []) is None
