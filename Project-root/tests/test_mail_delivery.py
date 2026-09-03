"""Outbound mail cannot hang a worker (REL-004).

`mail.send()` ran inside the request, and flask-mail 0.10 builds its
connection as `smtplib.SMTP(server, port)` with **no timeout argument** -- so
it inherits `socket.getdefaulttimeout()`, which Python leaves at `None`.

That is the part worth being precise about: an unreachable or deliberately
slow SMTP host did not merely make a password reset slow, it blocked that
gunicorn worker permanently. Four such requests against a four-worker
deployment and the application stops answering anything at all, with nothing
in its own logs pointing at the mail server.

The send now happens on a bounded pool, and the connection has a timeout.
"""

from __future__ import annotations

import smtplib
import threading
import time

import pytest


@pytest.fixture
def mail_app(app):
    app.config.update(
        MAIL_SERVER="smtp.example.invalid",
        MAIL_PORT=587,
        MAIL_USERNAME=None,
        MAIL_PASSWORD=None,
        MAIL_SUPPRESS_SEND=True,
    )
    return app


# ── The request thread is not the sending thread ─────────────────────────


def test_sending_does_not_block_the_caller(mail_app, monkeypatch):
    """THE regression test. The old code awaited the SMTP conversation
    inline, so this call took as long as the mail server chose to take."""
    import app.auth.routes as routes

    started = threading.Event()
    release = threading.Event()

    def _slow_deliver(app_, to_email, message):
        started.set()
        release.wait(timeout=5)
        return True

    monkeypatch.setattr(routes, "_deliver", _slow_deliver)

    with mail_app.app_context():
        began = time.monotonic()
        accepted = routes.send_reset_email("someone@example.invalid", "https://x/reset")
        elapsed = time.monotonic() - began

    assert accepted is True
    # The delivery is still sitting in _slow_deliver at this point.
    assert started.wait(timeout=5), "the send never started"
    assert elapsed < 1.0, f"send_reset_email blocked for {elapsed:.2f}s"
    release.set()


def test_delivery_runs_on_a_named_pool_thread(mail_app, monkeypatch):
    import app.auth.routes as routes

    seen = {}
    done = threading.Event()

    def _record(app_, to_email, message):
        seen["thread"] = threading.current_thread().name
        done.set()
        return True

    monkeypatch.setattr(routes, "_deliver", _record)

    with mail_app.app_context():
        routes.send_reset_email("someone@example.invalid", "https://x/reset")

    assert done.wait(timeout=5)
    assert seen["thread"] != threading.main_thread().name
    assert seen["thread"].startswith("mtc-mail")


def test_the_pool_is_bounded(mail_app):
    """Unbounded threads would let a broken relay accumulate one stuck thread
    per reset request, which converts a mail outage into a memory problem."""
    import app.auth.routes as routes

    assert routes._MAIL_POOL._max_workers == 2


# ── The connection has a timeout ─────────────────────────────────────────


def test_the_smtp_connection_sets_a_timeout(mail_app, monkeypatch):
    """flask-mail's own configure_host passes no timeout at all. Without the
    subclass, this is None -- block forever."""
    import app.auth.routes as routes

    captured = {}

    class _FakeSMTP:
        def __init__(self, host, port, timeout=None):
            captured["timeout"] = timeout

        def set_debuglevel(self, _level):
            pass

        def starttls(self):
            pass

        def login(self, *_args):
            pass

    monkeypatch.setattr(smtplib, "SMTP", _FakeSMTP)

    with mail_app.app_context():
        connection = routes._TimeoutConnection(routes.mail)
        connection.configure_host()

    assert captured["timeout"] == routes._SMTP_TIMEOUT_SECONDS
    assert isinstance(captured["timeout"], (int, float))
    assert captured["timeout"] > 0


def test_the_ssl_connection_sets_a_timeout_too(mail_app, monkeypatch):
    """The SSL branch is a separate constructor call and would be easy to fix
    on one side only."""
    import app.auth.routes as routes

    captured = {}

    class _FakeSMTPSSL:
        def __init__(self, host, port, timeout=None):
            captured["timeout"] = timeout

        def set_debuglevel(self, _level):
            pass

        def login(self, *_args):
            pass

    monkeypatch.setattr(smtplib, "SMTP_SSL", _FakeSMTPSSL)
    # Set on the object configure_host actually reads -- the extension
    # instance itself, not app.extensions["mail"].
    monkeypatch.setattr(routes.mail, "use_ssl", True, raising=False)
    monkeypatch.setattr(routes.mail, "use_tls", False, raising=False)

    with mail_app.app_context():
        routes._TimeoutConnection(routes.mail).configure_host()

    assert captured["timeout"] == routes._SMTP_TIMEOUT_SECONDS


# ── Failures stay contained ──────────────────────────────────────────────


def test_a_broken_relay_does_not_reach_the_user(mail_app, monkeypatch, caplog):
    """A reset must answer the same way whether or not the mail worked --
    otherwise the response tells an attacker which addresses have accounts."""
    import app.auth.routes as routes

    def _explode(*_args, **_kwargs):
        raise smtplib.SMTPException("relay refused")

    monkeypatch.setattr(routes._TimeoutConnection, "configure_host", _explode)
    mail_app.config["MAIL_SEND_SYNCHRONOUSLY"] = True

    with mail_app.app_context():
        with caplog.at_level("ERROR"):
            delivered = routes.send_reset_email(
                "someone@example.invalid", "https://x/reset"
            )

    assert delivered is False
    assert any("SMTP send failed" in r.getMessage() for r in caplog.records)


def test_a_queueing_failure_never_raises(mail_app, monkeypatch, caplog):
    """A mail problem must not turn a reset request into a 500."""
    import app.auth.routes as routes

    monkeypatch.setattr(
        routes._MAIL_POOL,
        "submit",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("pool is shut down")),
    )

    with mail_app.app_context():
        with caplog.at_level("ERROR"):
            assert (
                routes.send_reset_email("someone@example.invalid", "https://x/reset")
                is False
            )
    assert any("Could not queue" in r.getMessage() for r in caplog.records)


def test_the_forgot_password_endpoint_still_answers_generically(mail_app, monkeypatch):
    """End to end: the endpoint's contract is unchanged by the move to async."""
    import app.auth.routes as routes

    monkeypatch.setattr(routes, "_deliver", lambda *a, **k: True)
    client = mail_app.test_client()

    known = client.post(
        "/auth/api/forgot-password", json={"email": "nobody@example.invalid"}
    )
    assert known.status_code == 200
    assert "reset" in known.get_json().get("message", "").lower()
