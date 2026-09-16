"""Emergency snapshot delivery over SMTP.

No network here. Everything that opens a socket is covered by the manual
rehearsal in deploy/ups-setup.sh's closing instructions; what these tests
pin down is the logic that decides WHETHER to open one, and what would go
down the wire if it did -- which is the part that has to be right on a
machine that is losing power.
"""

from __future__ import annotations

import pytest

from app.erp.services import backup_mail


@pytest.fixture
def snapshot(tmp_path):
    """A file shaped like a real snapshot, sidecar and all."""
    dump = tmp_path / "mtc_20260917_020000.dump"
    dump.write_bytes(b"PGDMP fake payload")
    dump.with_name(dump.name + ".sha256").write_text(
        "a" * 64 + f"  {dump.name}\n", encoding="utf-8"
    )
    return dump


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for key in (
        "MAIL_SERVER",
        "MAIL_PORT",
        "MAIL_USERNAME",
        "MAIL_PASSWORD",
        "MAIL_USE_TLS",
        "MAIL_USE_SSL",
        "MAIL_DEFAULT_SENDER",
        "EMERGENCY_BACKUP_TO",
    ):
        monkeypatch.delenv(key, raising=False)


def test_not_configured_without_a_relay(monkeypatch):
    monkeypatch.setenv("MAIL_DEFAULT_SENDER", "ops@example.com")
    assert backup_mail.is_configured() is False


def test_not_configured_without_a_recipient(monkeypatch):
    monkeypatch.setenv("MAIL_SERVER", "smtp.example.com")
    assert backup_mail.is_configured() is False


def test_emergency_recipient_wins_over_the_sender_address(monkeypatch):
    """MAIL_DEFAULT_SENDER is who mail comes FROM and is not necessarily a
    mailbox anyone reads; the emergency copy has to be steerable elsewhere."""
    monkeypatch.setenv("MAIL_DEFAULT_SENDER", "no-reply@example.com")
    monkeypatch.setenv("EMERGENCY_BACKUP_TO", "owner@example.com")
    assert backup_mail.recipient() == "owner@example.com"


def test_oversized_snapshot_is_refused_before_connecting(monkeypatch, snapshot):
    """The relay rejects an oversized message only AFTER the whole attachment
    has gone up the wire, which on a dying battery is the most expensive
    possible way to discover a limit."""
    monkeypatch.setenv("MAIL_SERVER", "smtp.invalid")
    monkeypatch.setenv("EMERGENCY_BACKUP_TO", "owner@example.com")

    with pytest.raises(backup_mail.BackupMailError) as excinfo:
        backup_mail.email_snapshot(str(snapshot), max_bytes=4)

    message = str(excinfo.value)
    # It must say the snapshot itself survived, or an operator reading this
    # at 2am concludes the backup failed when only the copy did.
    assert "still written and verified locally" in message
    assert "offsite-pull.sh" in message


def test_missing_snapshot_is_refused(monkeypatch, tmp_path):
    monkeypatch.setenv("MAIL_SERVER", "smtp.invalid")
    monkeypatch.setenv("EMERGENCY_BACKUP_TO", "owner@example.com")
    with pytest.raises(backup_mail.BackupMailError, match="No such snapshot"):
        backup_mail.email_snapshot(str(tmp_path / "absent.dump"))


def test_dry_run_builds_everything_and_sends_nothing(monkeypatch, snapshot):
    """What ups-setup.sh tells an operator to run before trusting the wiring.
    MAIL_SERVER points at a host that does not resolve: reaching the network
    at all would fail the test rather than silently pass it."""
    monkeypatch.setenv("MAIL_SERVER", "smtp.invalid")
    monkeypatch.setenv("EMERGENCY_BACKUP_TO", "owner@example.com")

    result = backup_mail.email_snapshot(str(snapshot), dry_run=True)

    assert result.to == "owner@example.com"
    assert result.attachment == snapshot.name
    assert result.size_bytes == snapshot.stat().st_size


def test_message_carries_the_dump_as_an_attachment(snapshot):
    message = backup_mail.build_message(
        str(snapshot),
        to="owner@example.com",
        sender="no-reply@example.com",
        subject="subject",
        body="body",
    )
    attachments = list(message.iter_attachments())
    assert len(attachments) == 1
    assert attachments[0].get_filename() == snapshot.name
    assert attachments[0].get_payload(decode=True) == snapshot.read_bytes()


def test_body_records_the_checksum_so_the_mail_is_its_own_receipt(
    monkeypatch, snapshot
):
    """A copy nobody can verify is a file, not a backup. The sha256 travels
    in the body as well as the sidecar, so the mail alone is enough to check
    a download against."""
    monkeypatch.setenv("MAIL_SERVER", "smtp.invalid")
    monkeypatch.setenv("EMERGENCY_BACKUP_TO", "owner@example.com")

    captured = {}
    original = backup_mail.build_message

    def spy(path, **kwargs):
        captured.update(kwargs)
        return original(path, **kwargs)

    monkeypatch.setattr(backup_mail, "build_message", spy)
    backup_mail.email_snapshot(str(snapshot), dry_run=True)

    assert "a" * 64 in captured["body"]
    assert "pg_restore" in captured["body"]
