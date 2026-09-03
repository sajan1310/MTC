"""Backup -> restore -> row-count comparison (DATA-001).

This is the test whose absence made the old backup system dangerous. There
were tests for the backup service, and they passed, and they asserted that a
file appeared on disk -- which was never evidence of anything, because the
files it produced could not be restored:

* no ``CREATE TABLE``, no sequences, no constraints
* ``public.users`` and ``public.custom_roles`` omitted entirely
* JSONB written as Python ``repr`` (``'[{''itemName'': ...}]'``), which
  Postgres rejects
* a failed table written into the output as an SQL comment while the run
  still reported success

The only way to know a backup works is to restore it. That is what this does:
snapshot the test database, restore into a scratch database created for the
purpose, and compare every table's row count in both directions.

Skips (rather than fails) when the connected role cannot CREATE DATABASE, so
a developer on a restricted database still gets a green suite -- CI runs as
the postgres superuser, where it does execute.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import uuid
from types import SimpleNamespace

import psycopg2
import pytest
from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT

from app.erp.services import db_backup

pytestmark = pytest.mark.integration


def _test_cfg():
    return SimpleNamespace(
        DATABASE_URL=None,
        DB_HOST=os.getenv("TEST_DB_HOST", os.getenv("DB_HOST", "127.0.0.1")),
        DB_NAME=os.getenv("TEST_DB_NAME", "testdb"),
        DB_USER=os.getenv("TEST_DB_USER", os.getenv("DB_USER", "postgres")),
        DB_PASS=os.getenv("TEST_DB_PASS", os.getenv("DB_PASS", "abcd")),
        TESTING=True,
    )


def _connect(dbname: str):
    cfg = _test_cfg()
    return psycopg2.connect(
        host=cfg.DB_HOST, dbname=dbname, user=cfg.DB_USER, password=cfg.DB_PASS
    )


def _table_row_counts(dbname: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    conn = _connect(dbname)
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT table_schema, table_name
                FROM information_schema.tables
                WHERE table_schema IN ('public', 'erp') AND table_type = 'BASE TABLE'
                """
            )
            for schema, table in cur.fetchall():
                inner = conn.cursor()
                inner.execute(f'SELECT count(*) FROM "{schema}"."{table}"')
                counts[f"{schema}.{table}"] = inner.fetchone()[0]
                inner.close()
    finally:
        conn.close()
    return counts


@pytest.fixture
def scratch_database():
    """An empty database to restore into, dropped afterwards."""
    if not shutil.which("pg_dump") or not shutil.which("pg_restore"):
        pytest.skip("PostgreSQL client tools (pg_dump/pg_restore) are not on PATH")

    name = f"mtc_restore_test_{uuid.uuid4().hex[:10]}"
    try:
        admin = _connect("postgres")
    except psycopg2.OperationalError as exc:
        pytest.skip(f"cannot reach the postgres maintenance database: {exc}")

    admin.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
    try:
        with admin.cursor() as cur:
            cur.execute(f'CREATE DATABASE "{name}"')
    except psycopg2.errors.InsufficientPrivilege:
        admin.close()
        pytest.skip("connected role may not CREATE DATABASE")
    admin.close()

    yield name

    admin = _connect("postgres")
    admin.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
    with admin.cursor() as cur:
        cur.execute(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = %s",
            (name,),
        )
        cur.execute(f'DROP DATABASE IF EXISTS "{name}"')
    admin.close()


@pytest.fixture
def seeded_account():
    """A known user and custom role, planted before the snapshot is taken.

    The test below used to assert `count(*) > 0` on public.users, which
    passed only because migrations/init_schema.sql seeded two admin accounts.
    No migration seeds accounts any more (MIG-001, and there is a test
    enforcing that), so the table starts empty -- and "some rows exist" was
    never the property worth asserting anyway. Planting identifiable rows
    lets the restore be checked for those exact rows.
    """
    marker = uuid.uuid4().hex[:10]
    email = f"restore-probe-{marker}@example.invalid"
    role_key = f"restore_probe_{marker}"

    conn = _connect(os.getenv("TEST_DB_NAME", "testdb"))
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO public.custom_roles (role_key, role_name, permissions) "
                "VALUES (%s, %s, %s::jsonb)",
                (role_key, f"Restore Probe {marker}", '{"stockTab": "viewer"}'),
            )
            cur.execute(
                "INSERT INTO public.users (name, email, password_hash, role) "
                "VALUES (%s, %s, %s, %s)",
                ("Restore Probe", email, "not-a-real-hash", role_key),
            )
    finally:
        conn.close()

    yield SimpleNamespace(email=email, role_key=role_key)

    conn = _connect(os.getenv("TEST_DB_NAME", "testdb"))
    try:
        with conn, conn.cursor() as cur:
            cur.execute("DELETE FROM public.users WHERE email = %s", (email,))
            cur.execute(
                "DELETE FROM public.custom_roles WHERE role_key = %s", (role_key,)
            )
    finally:
        conn.close()


@pytest.fixture
def snapshot(tmp_path):
    """One verified snapshot of the test database."""
    if not shutil.which("pg_dump"):
        pytest.skip("pg_dump is not on PATH")
    snap = db_backup.create_snapshot(str(tmp_path), config=_test_cfg())
    yield snap


def _restore(snapshot_path: str, into: str) -> subprocess.CompletedProcess:
    cfg = _test_cfg()
    env = dict(os.environ)
    if cfg.DB_PASS:
        env["PGPASSWORD"] = cfg.DB_PASS
    return subprocess.run(
        [
            shutil.which("pg_restore"),
            "--no-owner",
            "--no-privileges",
            # Any error at all fails the restore. A backup that restores "mostly"
            # is the thing this whole finding is about.
            "--exit-on-error",
            "--dbname",
            f"postgresql://{cfg.DB_USER}@{cfg.DB_HOST}:5432/{into}",
            snapshot_path,
        ],
        env=env,
        capture_output=True,
        text=True,
        timeout=600,
    )


# ── The acceptance test ──────────────────────────────────────────────────


def test_snapshot_restores_into_an_empty_database_with_matching_row_counts(
    snapshot, scratch_database
):
    """The whole finding, in one assertion set."""
    result = _restore(snapshot.path, scratch_database)
    assert result.returncode == 0, (
        f"pg_restore --exit-on-error failed:\n{result.stderr[:2000]}"
    )

    source = _table_row_counts(os.getenv("TEST_DB_NAME", "testdb"))
    restored = _table_row_counts(scratch_database)

    missing = sorted(set(source) - set(restored))
    assert not missing, f"tables absent from the restore: {missing}"

    mismatched = {
        table: (source[table], restored[table])
        for table in source
        if source[table] != restored[table]
    }
    assert not mismatched, f"row counts differ (source, restored): {mismatched}"


def test_restore_contains_the_user_accounts(seeded_account, snapshot, scratch_database):
    """public.users and public.custom_roles were never in the old dumps at
    all: a restore lost every account and every permission map, while
    updated_by/created_by foreign keys across erp.* still referenced them.

    `seeded_account` is requested before `snapshot` so its rows exist when
    the dump is taken -- fixture arguments are set up left to right, and
    getting that order wrong would silently make this test vacuous again.
    """
    assert _restore(snapshot.path, scratch_database).returncode == 0

    conn = _connect(scratch_database)
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                "SELECT name, role FROM public.users WHERE email = %s",
                (seeded_account.email,),
            )
            user_row = cur.fetchone()
            cur.execute(
                "SELECT role_name, permissions FROM public.custom_roles WHERE role_key = %s",
                (seeded_account.role_key,),
            )
            role_row = cur.fetchone()
    finally:
        conn.close()

    assert user_row is not None, "the seeded account did not survive the restore"
    assert user_row[0] == "Restore Probe"
    # The account's role is a custom role key, so this is also the check that
    # the two tables came back consistent with each other.
    assert user_row[1] == seeded_account.role_key

    assert role_row is not None, "the seeded custom role did not survive the restore"
    # The permission map is JSONB -- the column type the old dump wrote as a
    # Python repr that Postgres then refused.
    assert role_row[1] == {"stockTab": "viewer"}


def test_restore_preserves_sequences(snapshot, scratch_database):
    """Sequences were absent from the old dumps, so a restored database
    re-issued primary keys and document numbers already in use --
    erp.dispatch_number_seq drives customer-facing dispatch numbers."""
    assert _restore(snapshot.path, scratch_database).returncode == 0

    conn = _connect(scratch_database)
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                """SELECT count(*) FROM information_schema.sequences
                   WHERE sequence_schema IN ('public', 'erp')"""
            )
            assert cur.fetchone()[0] > 0, "no sequences survived the restore"
    finally:
        conn.close()


def test_restore_preserves_jsonb_exactly(scratch_database, tmp_path):
    """erp.production.components_consumed is JSONB. psycopg2 returns it as a
    Python list, and the old serialiser fell through to str(), emitting
    ``'[{''itemName'': ''Rim 26"''}]'`` -- Python repr, not JSON, which
    Postgres rejects with 'invalid input syntax for type json'. Every
    production row failed to restore, and production rows are one of the five
    terms in the Current Stock formula.

    The payload below carries a double quote, an apostrophe, an ampersand and
    an angle bracket, because those are what broke it.
    """
    lot = f"LOT-JSONB-{uuid.uuid4().hex[:8]}"
    payload = '[{"itemName": "Rim 26\\"", "qty": 4, "note": "O\'Brien & Co <b>"}]'

    conn = _connect(os.getenv("TEST_DB_NAME", "testdb"))
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                """INSERT INTO erp.production
                   (lot_number, production_date, status, qty, assigned_to,
                    process_id, components_consumed)
                   VALUES (%s, CURRENT_DATE, 'Completed', 10, 'Operator A',
                           'PRC-TEST', %s::jsonb)""",
                (lot, payload),
            )
    finally:
        conn.close()

    try:
        snap = db_backup.create_snapshot(str(tmp_path), config=_test_cfg())
        assert _restore(snap.path, scratch_database).returncode == 0

        conn = _connect(scratch_database)
        try:
            with conn, conn.cursor() as cur:
                cur.execute(
                    "SELECT components_consumed FROM erp.production WHERE lot_number = %s",
                    (lot,),
                )
                row = cur.fetchone()
        finally:
            conn.close()

        assert row is not None, "the production row did not survive the restore"
        restored = row[0]
        assert isinstance(restored, list)
        assert restored[0]["itemName"] == 'Rim 26"'
        assert restored[0]["note"] == "O'Brien & Co <b>"
        assert restored[0]["qty"] == 4
    finally:
        conn = _connect(os.getenv("TEST_DB_NAME", "testdb"))
        try:
            with conn, conn.cursor() as cur:
                cur.execute("DELETE FROM erp.production WHERE lot_number = %s", (lot,))
        finally:
            conn.close()


# ── Verification refuses what it should ──────────────────────────────────


def test_verification_rejects_a_dump_missing_public_schema(tmp_path):
    """The old system's exact blind spot. An erp-only dump must not be
    accepted as a backup."""
    if not shutil.which("pg_dump"):
        pytest.skip("pg_dump is not on PATH")

    cfg = _test_cfg()
    env = dict(os.environ)
    if cfg.DB_PASS:
        env["PGPASSWORD"] = cfg.DB_PASS
    erp_only = str(tmp_path / "erp_only.dump")
    subprocess.run(
        [
            shutil.which("pg_dump"),
            "--format=custom",
            "--no-owner",
            "--no-privileges",
            "--schema=erp",
            "--file",
            erp_only,
            f"postgresql://{cfg.DB_USER}@{cfg.DB_HOST}:5432/{cfg.DB_NAME}",
        ],
        env=env,
        check=True,
        capture_output=True,
    )

    with pytest.raises(db_backup.BackupError) as exc:
        db_backup.verify_snapshot(erp_only, cfg.DB_PASS)
    assert "public.users" in str(exc.value)


def test_verification_rejects_a_truncated_dump(snapshot, tmp_path):
    corrupt = tmp_path / "corrupt.dump"
    with open(snapshot.path, "rb") as src:
        corrupt.write_bytes(src.read(512))

    with pytest.raises(db_backup.BackupError):
        db_backup.verify_snapshot(str(corrupt), _test_cfg().DB_PASS)


def test_a_failed_snapshot_leaves_no_partial_file_behind(tmp_path, monkeypatch):
    """An unverified file must never be left where a human could reach for it
    during a recovery and believe it is a backup."""
    monkeypatch.setattr(
        db_backup,
        "verify_snapshot",
        lambda *a, **k: (_ for _ in ()).throw(db_backup.BackupError("forced")),
    )
    with pytest.raises(db_backup.BackupError):
        db_backup.create_snapshot(str(tmp_path), config=_test_cfg())

    assert list(tmp_path.glob("*.dump")) == []
    assert list(tmp_path.glob("*.partial")) == []


# ── Checksum and retention ───────────────────────────────────────────────


def test_snapshot_writes_a_checksum_sidecar(snapshot):
    sidecar = snapshot.path + ".sha256"
    assert os.path.exists(sidecar)
    assert snapshot.sha256 in open(sidecar, encoding="utf-8").read()
    assert len(snapshot.sha256) == 64


def test_retention_keeps_recent_snapshots_and_prunes_the_rest(tmp_path):
    """Nothing pruned backups/ at all, so it grew without bound -- on a
    machine whose disk filling up is itself a way to lose the database."""
    import datetime as dt

    made = []
    for days_ago in range(0, 40):
        when = dt.datetime(2026, 8, 25) - dt.timedelta(days=days_ago)
        path = tmp_path / f"mtc_{when.strftime('%Y%m%d_%H%M%S')}.dump"
        path.write_bytes(b"x")
        made.append(path)

    removed = db_backup.prune_snapshots(str(tmp_path))
    remaining = sorted(p.name for p in tmp_path.glob("mtc_*.dump"))

    assert removed, "retention removed nothing from a 40-snapshot directory"
    assert len(remaining) < len(made)
    # The most recent RETAIN_DAILY are always kept.
    for path in made[: db_backup.RETAIN_DAILY]:
        assert path.name in remaining, (
            f"{path.name} was pruned but is within daily retention"
        )


def test_retention_never_removes_the_only_snapshot(tmp_path):
    only = tmp_path / "mtc_20260825_120000.dump"
    only.write_bytes(b"x")
    db_backup.prune_snapshots(str(tmp_path))
    assert only.exists()
