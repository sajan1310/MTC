"""Email a verified snapshot off the machine, over SMTP.

Why this exists
---------------
The Drive push cannot work here: the credentials are a service account, a
service account owns what it uploads, and service accounts have zero Drive
storage. Only a Shared Drive bypasses that, and Shared Drives are a Google
Workspace feature the site's consumer Gmail account does not have. Email
sidesteps the whole problem, because the relay authenticates as the OWNER of
the mailbox rather than as a robot with no quota of its own.

It is also small enough to be sensible. A compressed custom-format dump of
this database measures about 1 MB; base64 inflates it to roughly 1.4 MB
against a Mailjet message ceiling near 15 MB. Ten times the headroom -- but
see MAX_ATTACHMENT_BYTES, because that ratio is a fact about today's data,
not a law.

Why not flask-mail
------------------
app/auth/routes.py sends through flask-mail inside an application context,
which needs the app booted and its database pool up. This runs on a machine
that is losing power, invoked from a shell by the UPS handler. Booting Flask
to send one message would cost seconds that the battery is paying for, and
would fail outright if the database were already stopping. Plain smtplib
needs neither, and takes an explicit timeout -- which flask-mail 0.10 does
not expose at all, the very gap _TimeoutConnection exists to patch.
"""

from __future__ import annotations

import dataclasses
import logging
import mimetypes
import os
import smtplib
import socket
import ssl
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

logger = logging.getLogger(__name__)

# The relay's ceiling is on the WHOLE message after base64, which costs
# 4 bytes for every 3. 10 MB of attachment is about 13.7 MB encoded, which
# clears Mailjet's ~15 MB with room for headers and the body.
#
# Checked before connecting, deliberately. An oversized message is rejected
# only after the entire attachment has been pushed up the wire, which on a
# dying battery is the most expensive possible way to discover a limit.
MAX_ATTACHMENT_BYTES = int(os.getenv("EMERGENCY_MAIL_MAX_BYTES", str(10 * 1024 * 1024)))

# Finite, and short. This runs while a battery drains; a black hole must be
# distinguishable from a slow relay long before the power goes.
SMTP_TIMEOUT_SECONDS = int(os.getenv("EMERGENCY_MAIL_TIMEOUT", "45"))


class BackupMailError(RuntimeError):
    """The snapshot could not be mailed."""


@dataclasses.dataclass(frozen=True)
class MailResult:
    to: str
    subject: str
    attachment: str
    size_bytes: int


def _env(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name)
    return value if value not in (None, "") else default


_SUPER_ADMIN_CACHE: list[str] | None = None


def super_admin_emails() -> list[str]:
    """Every active super_admin's address, straight from the database.

    Connects directly with psycopg2 rather than through database.get_conn():
    that pool belongs to a running Flask app, and this is called from a shell
    on a machine that may be losing power, where no app exists. Same env
    resolution as migrations/erp/runner.py, for the same reason.

    Never raises. A database that cannot be read is not a reason to fail to
    send a backup -- the caller falls back to the configured address. Cached
    for the life of the process so that is_configured() does not open a
    connection every time it is asked a question.
    """
    global _SUPER_ADMIN_CACHE
    if _SUPER_ADMIN_CACHE is not None:
        return _SUPER_ADMIN_CACHE

    _SUPER_ADMIN_CACHE = []
    try:
        import psycopg2

        dsn = _env("DATABASE_URL")
        kwargs = (
            {"dsn": dsn}
            if dsn
            else {
                "host": _env("DB_HOST", "127.0.0.1"),
                "port": _env("DB_PORT", "5432"),
                "dbname": _env("DB_NAME", "MTC"),
                "user": _env("DB_USER", "postgres"),
                "password": _env("DB_PASS", ""),
            }
        )
        # Short: this runs on a battery, and an unreachable database must not
        # hold up a snapshot that is already written.
        with psycopg2.connect(connect_timeout=5, **kwargs) as conn:
            with conn.cursor() as cur:
                cur.execute("SET LOCAL statement_timeout = 5000")
                cur.execute(
                    """
                    SELECT email
                      FROM public.users
                     WHERE role = 'super_admin'
                       AND deleted_at IS NULL
                       AND email IS NOT NULL
                       AND email <> ''
                     ORDER BY user_id
                    """
                )
                _SUPER_ADMIN_CACHE = [row[0].strip() for row in cur.fetchall()]
        conn.close()
    except Exception as exc:  # noqa: BLE001 -- see the docstring
        logger.warning(
            "[backup_mail] Could not read super_admin addresses (%s); "
            "falling back to the configured recipient.",
            exc,
        )
    return _SUPER_ADMIN_CACHE


def recipient(explicit: str | None = None) -> str | None:
    """Where the backup goes.

    The super_admin in the database is the real answer -- that is the person
    who owns this system, and the address stays right when it changes there
    rather than needing an env file edited on a server nobody wants to touch.

    EMERGENCY_BACKUP_TO still wins when it is set, because an operator needs
    a way to redirect this without editing the user table. MAIL_DEFAULT_SENDER
    is only the last resort: it is who mail comes FROM, and that is not
    necessarily a mailbox anyone reads.
    """
    if explicit:
        return explicit
    override = _env("EMERGENCY_BACKUP_TO")
    if override:
        return override
    admins = super_admin_emails()
    if admins:
        return ", ".join(admins)
    return _env("MAIL_DEFAULT_SENDER")


def is_configured(explicit_to: str | None = None) -> bool:
    return bool(_env("MAIL_SERVER") and recipient(explicit_to))


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in ("1", "true", "yes", "on")


def tls_context() -> ssl.SSLContext:
    """A context that verifies the chain AND the hostname, on TLS 1.2+.

    ``ssl.create_default_context()`` already does all three on every Python
    this runs on, so the assignments below change no behaviour. They are here
    to state it rather than inherit it: this connection carries the entire
    database and an SMTP password, and "the defaults were fine when we wrote
    it" is not a property a reader can check at a glance.
    """
    context = ssl.create_default_context()
    context.check_hostname = True
    context.verify_mode = ssl.CERT_REQUIRED
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    return context


def _deliver(message, *, server: str, port: int) -> None:
    """Open the connection, secure it, authenticate, send.

    Split out of email_snapshot so the transport decisions sit together and
    can be read without the message-building around them.
    """
    username = _env("MAIL_USERNAME")
    password = _env("MAIL_PASSWORD")
    use_ssl = _truthy(_env("MAIL_USE_SSL"))
    use_tls = _truthy(_env("MAIL_USE_TLS", "true"))

    # Refuse plaintext before opening anything. The attachment is the entire
    # vendor, client, costing and payment history, and SMTP AUTH sends the
    # password base64-encoded, which is encoding and not encryption. With
    # MAIL_USE_TLS=false both would have crossed the network in the clear,
    # and nothing here would have objected.
    if not use_ssl and not use_tls and not _truthy(_env("MAIL_ALLOW_INSECURE")):
        raise BackupMailError(
            "Refusing to send a database backup over an unencrypted "
            "connection. Set MAIL_USE_TLS=true (STARTTLS, the usual choice on "
            "port 587) or MAIL_USE_SSL=true (implicit TLS, port 465). "
            "MAIL_ALLOW_INSECURE=1 overrides it, and is only defensible "
            "against a relay on localhost."
        )

    context = tls_context()
    if use_ssl:
        smtp = smtplib.SMTP_SSL(
            server, port, timeout=SMTP_TIMEOUT_SECONDS, context=context
        )
    else:
        smtp = smtplib.SMTP(server, port, timeout=SMTP_TIMEOUT_SECONDS)

    with smtp:
        smtp.ehlo()
        if use_tls and not use_ssl:
            # Raises SMTPNotSupportedError when the relay cannot upgrade,
            # which is the right outcome: carrying on in the clear is exactly
            # what the check above exists to prevent.
            smtp.starttls(context=context)
            smtp.ehlo()
        if username and password:
            smtp.login(username, password)
        smtp.send_message(message)


def build_message(
    path: str,
    *,
    to: str,
    sender: str,
    subject: str,
    body: str,
) -> EmailMessage:
    """Assemble the message. Separated from sending so a test can inspect
    exactly what would go out without opening a socket."""
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = sender
    message["To"] = to
    message["Date"] = formatdate(localtime=True)
    message["Message-ID"] = make_msgid(domain="mtc.local")
    # Survives a mailbox rule that files these away, and makes the whole set
    # findable later with one search.
    message["X-MTC-Backup"] = os.path.basename(path)
    message.set_content(body)

    guessed, _ = mimetypes.guess_type(path)
    maintype, _, subtype = (guessed or "application/octet-stream").partition("/")
    with open(path, "rb") as handle:
        message.add_attachment(
            handle.read(),
            maintype=maintype,
            subtype=subtype or "octet-stream",
            filename=os.path.basename(path),
        )
    return message


def email_snapshot(
    path: str,
    *,
    to: str | None = None,
    subject: str | None = None,
    body: str | None = None,
    max_bytes: int | None = None,
    dry_run: bool = False,
) -> MailResult:
    """Send `path` as an attachment. Raises BackupMailError on any failure.

    `dry_run` builds and validates the message without connecting, which is
    how the UPS rehearsal proves the wiring without mailing a database.
    """
    target = recipient(to)
    server = _env("MAIL_SERVER")
    if not server or not target:
        raise BackupMailError(
            "Emergency mail is not configured: MAIL_SERVER and one of "
            "EMERGENCY_BACKUP_TO / MAIL_DEFAULT_SENDER must be set."
        )
    if not os.path.isfile(path):
        raise BackupMailError(f"No such snapshot to mail: {path}")

    size = os.path.getsize(path)
    ceiling = MAX_ATTACHMENT_BYTES if max_bytes is None else max_bytes
    if size > ceiling:
        raise BackupMailError(
            f"{os.path.basename(path)} is {size:,} bytes, over the "
            f"{ceiling:,}-byte limit for mailing (base64 would make it about "
            f"{int(size * 4 / 3):,}). The snapshot is still written and "
            f"verified locally -- only the emailed copy was skipped. Raise "
            f"EMERGENCY_MAIL_MAX_BYTES if the relay genuinely accepts more, "
            f"or move the off-site copy to deploy/offsite-pull.sh."
        )

    sender = _env("MAIL_DEFAULT_SENDER") or target
    name = os.path.basename(path)
    host = socket.gethostname()
    subject = subject or f"[MTC] Emergency database snapshot {name} from {host}"

    checksum = ""
    sidecar = path + ".sha256"
    if os.path.isfile(sidecar):
        try:
            with open(sidecar, "r", encoding="utf-8") as handle:
                checksum = handle.readline().split()[0]
        except (OSError, IndexError):
            checksum = ""

    body = body or (
        f"Automatic snapshot from {host}.\n\n"
        f"  file    : {name}\n"
        f"  size    : {size:,} bytes\n"
        f"  sha256  : {checksum or '(sidecar missing)'}\n\n"
        "Verify after downloading, then restore with:\n"
        f"  sha256sum -c {name}.sha256\n"
        f"  pg_restore --clean --if-exists --no-owner --dbname MTC {name}\n\n"
        "This attachment is the whole database. Keep the mailbox private.\n"
    )

    message = build_message(path, to=target, sender=sender, subject=subject, body=body)

    if dry_run:
        logger.info(
            "[backup_mail] DRY RUN: would send %s (%s bytes) to %s",
            name,
            f"{size:,}",
            target,
        )
        return MailResult(to=target, subject=subject, attachment=name, size_bytes=size)

    port = int(_env("MAIL_PORT", "587") or 587)
    try:
        _deliver(message, server=server, port=port)
    except BackupMailError:
        # Already explained -- a refusal to send in the clear, say. Wrapping
        # it again would bury the instruction under a second message.
        raise
    except Exception as exc:  # noqa: BLE001 -- every failure is the same failure here
        raise BackupMailError(
            f"SMTP delivery of {name} to {target} failed: {type(exc).__name__}: {exc}"
        ) from exc

    logger.info("[backup_mail] Mailed %s (%s bytes) to %s", name, f"{size:,}", target)
    return MailResult(to=target, subject=subject, attachment=name, size_bytes=size)
