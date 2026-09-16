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
    # The super_admin lookup is cached for the life of the process; without
    # this every test after the first would reuse the first one's answer.
    monkeypatch.setattr(backup_mail, "_SUPER_ADMIN_CACHE", None, raising=False)
    for key in (
        "MAIL_SERVER",
        "MAIL_PORT",
        "MAIL_USERNAME",
        "MAIL_PASSWORD",
        "MAIL_USE_TLS",
        "MAIL_USE_SSL",
        "MAIL_ALLOW_INSECURE",
        "MAIL_DEFAULT_SENDER",
        "EMERGENCY_BACKUP_TO",
    ):
        monkeypatch.delenv(key, raising=False)


def test_not_configured_without_a_relay(monkeypatch):
    monkeypatch.setenv("MAIL_DEFAULT_SENDER", "ops@example.com")
    assert backup_mail.is_configured() is False


def test_not_configured_without_a_recipient(monkeypatch):
    """No env recipient AND no super_admin in the database. The stub matters:
    without it this reaches the real database, finds the real super_admin,
    and is correctly configured -- which is the new behaviour, not a bug."""
    monkeypatch.setenv("MAIL_SERVER", "smtp.example.com")
    monkeypatch.setattr(backup_mail, "super_admin_emails", list)
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


# ── Who the backup goes to ───────────────────────────────────────────────
#
# The super_admin in the database is the real answer: that is the person who
# owns the system, and the address stays correct when it changes there rather
# than needing an env file edited on a server nobody wants to touch.


def test_super_admin_from_the_database_beats_the_sender_address(monkeypatch):
    monkeypatch.setenv("MAIL_DEFAULT_SENDER", "no-reply@example.com")
    monkeypatch.setattr(backup_mail, "super_admin_emails", lambda: ["boss@example.com"])
    assert backup_mail.recipient() == "boss@example.com"


def test_several_super_admins_all_get_it(monkeypatch):
    monkeypatch.setenv("MAIL_DEFAULT_SENDER", "no-reply@example.com")
    monkeypatch.setattr(
        backup_mail,
        "super_admin_emails",
        lambda: ["a@example.com", "b@example.com"],
    )
    assert backup_mail.recipient() == "a@example.com, b@example.com"


def test_explicit_override_still_wins_over_the_database(monkeypatch):
    """An operator needs a way to redirect this without editing the user
    table -- during a restore drill, say."""
    monkeypatch.setenv("EMERGENCY_BACKUP_TO", "ops@example.com")
    monkeypatch.setattr(backup_mail, "super_admin_emails", lambda: ["boss@example.com"])
    assert backup_mail.recipient() == "ops@example.com"


def test_unreadable_database_falls_back_instead_of_failing(monkeypatch):
    """A database that cannot be read is not a reason to fail to send a
    backup -- which is exactly the situation this runs in. The real lookup
    swallows its errors and returns an empty list, so this asserts what the
    caller then does with that."""
    monkeypatch.setenv("MAIL_DEFAULT_SENDER", "fallback@example.com")
    monkeypatch.setattr(backup_mail, "super_admin_emails", list)
    assert backup_mail.recipient() == "fallback@example.com"


def test_super_admin_lookup_itself_never_raises(monkeypatch):
    """The real function swallows everything; only the monkeypatched stub
    above can raise. Point psycopg2 at nothing and confirm."""
    monkeypatch.setattr(backup_mail, "_SUPER_ADMIN_CACHE", None, raising=False)
    monkeypatch.setenv("DB_HOST", "127.0.0.1")
    monkeypatch.setenv("DB_PORT", "1")  # nothing listens here
    monkeypatch.delenv("DATABASE_URL", raising=False)
    assert backup_mail.super_admin_emails() == []


# ── The transport itself ─────────────────────────────────────────────────


def test_refuses_to_send_in_the_clear(monkeypatch, snapshot):
    """The attachment is the entire vendor, client, costing and payment
    history, and SMTP AUTH sends the password base64-encoded -- which is
    encoding, not encryption. Both would have crossed the network in the
    clear with MAIL_USE_TLS=false, and nothing objected."""
    monkeypatch.setenv("MAIL_SERVER", "smtp.invalid")
    monkeypatch.setenv("EMERGENCY_BACKUP_TO", "owner@example.com")
    monkeypatch.setenv("MAIL_USE_TLS", "false")
    monkeypatch.setenv("MAIL_USE_SSL", "false")

    with pytest.raises(backup_mail.BackupMailError) as excinfo:
        backup_mail.email_snapshot(str(snapshot))

    message = str(excinfo.value)
    assert "unencrypted" in message
    # The refusal has to say how to fix it, or it is just an obstacle.
    assert "MAIL_USE_TLS" in message


def test_the_insecure_override_is_honoured(monkeypatch, snapshot):
    """Defensible against a relay on localhost, and nowhere else. It must get
    past the refusal and fail on the connection instead."""
    monkeypatch.setenv("MAIL_SERVER", "smtp.invalid")
    monkeypatch.setenv("EMERGENCY_BACKUP_TO", "owner@example.com")
    monkeypatch.setenv("MAIL_USE_TLS", "false")
    monkeypatch.setenv("MAIL_ALLOW_INSECURE", "1")

    with pytest.raises(backup_mail.BackupMailError) as excinfo:
        backup_mail.email_snapshot(str(snapshot))

    assert "unencrypted" not in str(excinfo.value)


def test_tls_context_verifies_chain_and_hostname():
    """Stated rather than inherited: this connection carries the whole
    database and an SMTP password."""
    import ssl

    context = backup_mail.tls_context()

    assert context.check_hostname is True
    assert context.verify_mode == ssl.CERT_REQUIRED
    assert context.minimum_version >= ssl.TLSVersion.TLSv1_2
