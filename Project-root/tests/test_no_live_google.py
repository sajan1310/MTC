"""The suite must not be able to reach the real Google spreadsheet.

On 2026-09-30 a local run of this suite exported a developer's five-day-old
copy of the database into the spreadsheet production mirrors into. One test
called backup_service.perform_full_backup() with the snapshot mocked and the
environment left alone -- and on a machine whose .env holds the real
service-account key and spreadsheet ID, that is a real export. The local log
showed the same thing on every full run since 2026-09-17, twenty times, and
not one failure: CI has no .env, so there the same call is skipped.

The guard is `no_live_google` in tests/conftest.py. These pin it from the only
angle that matters, a machine that HAS the settings -- and do it without being
able to cause what they guard against.
"""

from __future__ import annotations

import os
from unittest.mock import MagicMock, patch

import pytest

from app.erp.services import backup_service


@pytest.fixture(scope="module")
def a_machine_with_the_real_settings(tmp_path_factory):
    """What load_dotenv(override=True) leaves behind where .env is the real
    one: a key file that exists, and a spreadsheet to write to.

    Module-scoped so that it is in place BEFORE the per-test guard runs,
    which is the order the two meet in practice.
    """
    key = tmp_path_factory.mktemp("google") / "service-account.json"
    key.write_text("{}")
    settings = {
        "GOOGLE_APPLICATION_CREDENTIALS": str(key),
        "BACKUP_SPREADSHEET_ID": "the-production-spreadsheet",
    }
    saved = {name: os.environ.get(name) for name in settings}
    os.environ.update(settings)
    yield
    for name, value in saved.items():
        if value is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = value


def test_the_live_google_settings_are_gone_by_the_time_a_test_runs(
    a_machine_with_the_real_settings, no_live_google
):
    assert "GOOGLE_APPLICATION_CREDENTIALS" in no_live_google
    for name in no_live_google:
        assert name not in os.environ


def test_a_backup_run_inside_the_suite_stays_on_this_machine(
    a_machine_with_the_real_settings, monkeypatch
):
    """The call that did it, with the two doors to Google replaced by alarms:
    if the guard ever goes, this fails here instead of exporting anything."""

    def _reached_google():
        raise AssertionError("a test reached the Google Sheets export")

    monkeypatch.setattr(backup_service, "_migration_module", _reached_google)
    monkeypatch.setattr(backup_service, "_mirror_module", _reached_google)
    monkeypatch.setattr(
        backup_service,
        "_LAST_BACKUP_STATUS",
        dict(backup_service._LAST_BACKUP_STATUS),
    )

    with patch.object(backup_service, "db_backup") as mock_db_backup:
        mock_db_backup.create_snapshot.return_value = MagicMock(
            path="/tmp/x.dump",
            size_bytes=1,
            sha256="a" * 64,
            table_count=1,
            verified=True,
            filename="x.dump",
        )
        mock_db_backup.prune_snapshots.return_value = []
        res = backup_service.perform_full_backup()

    assert "reached the Google Sheets export" not in res["message"]
    assert res["spreadsheet_id"] is None
    # Both the export and the mirror, each skipped for want of credentials.
    assert res["message"].count("GOOGLE_APPLICATION_CREDENTIALS is not configured") == 2
