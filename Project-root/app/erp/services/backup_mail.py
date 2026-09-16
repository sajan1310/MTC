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


def recipient(explicit: str | None = None) -> str | None:
    """Where the emergency copy goes.

    EMERGENCY_BACKUP_TO first so the destination can differ from the address
    the application sends password resets FROM, which is what
    MAIL_DEFAULT_SENDER means and is not necessarily a mailbox anyone reads.
    """
    return explicit or _env("EMERGENCY_BACKUP_TO") or _env("MAIL_DEFAULT_SENDER")


def is_configured(explicit_to: str | None = None) -> bool:
    return bool(_env("MAIL_SERVER") and recipient(explicit_to))


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in ("1", "true", "yes", "on")


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
    username = _env("MAIL_USERNAME")
    password = _env("MAIL_PASSWORD")
    use_ssl = _truthy(_env("MAIL_USE_SSL"))
    use_tls = _truthy(_env("MAIL_USE_TLS", "true"))

    try:
        if use_ssl:
            smtp = smtplib.SMTP_SSL(
                server,
                port,
                timeout=SMTP_TIMEOUT_SECONDS,
                context=ssl.create_default_context(),
            )
        else:
            smtp = smtplib.SMTP(server, port, timeout=SMTP_TIMEOUT_SECONDS)
        with smtp:
            smtp.ehlo()
            if use_tls and not use_ssl:
                smtp.starttls(context=ssl.create_default_context())
                smtp.ehlo()
            if username and password:
                smtp.login(username, password)
            smtp.send_message(message)
    except Exception as exc:  # noqa: BLE001 -- every failure is the same failure here
        raise BackupMailError(
            f"SMTP delivery of {name} to {target} failed: {type(exc).__name__}: {exc}"
        ) from exc

    logger.info("[backup_mail] Mailed %s (%s bytes) to %s", name, f"{size:,}", target)
    return MailResult(to=target, subject=subject, attachment=name, size_bytes=size)
