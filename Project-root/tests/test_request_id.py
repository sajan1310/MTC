"""One request id per request, from one generator (OBS-001, SEC-011).

Two request-ID implementations ran on every request. app/middleware/
request_id.py's before_request set ``g.request_id`` first; app/middleware/
error_handling.py's ``request_id_middleware()`` ran second and OVERWROTE it
with a freshly generated UUID. Every request therefore minted two ids and
discarded the first, and the two ``get_request_id()`` accessors agreed only
because the second happened to run last -- coincidence, not design.

That matters beyond tidiness: rpc.py hands the user a reference id to quote to
support when a method fails unexpectedly, and the response carries an
``X-Request-ID`` header. Those must be the same string as the one in the log,
or the reference is useless.

SEC-011 is pinned here too: a client-supplied ``X-Request-ID`` is honoured only
when it is a well-formed UUID, because the value reaches log lines and an
arbitrary string is a log-injection primitive.
"""

from __future__ import annotations

import re
import uuid

import pytest

UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I
)


@pytest.fixture
def probe(app):
    """A route that reports what each accessor sees for this request."""
    from flask import g

    from app.middleware.error_handling import RequestContext

    @app.route("/__request_id_probe")
    def _probe():
        from app.middleware.request_id import get_request_id

        return {
            "g": getattr(g, "request_id", None),
            "accessor": get_request_id(),
            "context": RequestContext.get_request_id(),
        }

    return app.test_client()


# ── One id, everywhere ───────────────────────────────────────────────────


def test_both_accessors_and_g_agree(probe):
    """THE regression test: the two implementations must report one id."""
    body = probe.get("/__request_id_probe").get_json()
    assert body["g"], "no request id was assigned"
    assert body["g"] == body["accessor"] == body["context"], body


def test_the_response_header_matches_what_the_handler_saw(probe):
    """Otherwise the id a user quotes from a failed request does not match
    the id in the log."""
    response = probe.get("/__request_id_probe")
    assert response.headers.get("X-Request-ID") == response.get_json()["g"]


def test_the_id_is_a_uuid(probe):
    assert UUID_RE.match(probe.get("/__request_id_probe").get_json()["g"])


def test_each_request_gets_its_own_id(probe):
    first = probe.get("/__request_id_probe").get_json()["g"]
    second = probe.get("/__request_id_probe").get_json()["g"]
    assert first != second


# ── Client correlation (SEC-011) ─────────────────────────────────────────


def test_a_valid_client_uuid_is_honoured_by_every_accessor(probe):
    """Correlation is the point of accepting the header at all -- but it only
    works if the adopted id reaches all three places."""
    supplied = str(uuid.uuid4())
    response = probe.get("/__request_id_probe", headers={"X-Request-ID": supplied})
    body = response.get_json()
    assert body["g"] == body["accessor"] == body["context"] == supplied
    assert response.headers.get("X-Request-ID") == supplied


# Newline payloads are NOT in this list: Werkzeug refuses to construct a
# header containing one ("Header values must not contain newline characters"),
# so the test client cannot transmit it and neither can a real client through
# a conforming server. That is defence in depth ahead of the sanitiser, not a
# reason to drop the case -- it is covered directly against
# _sanitize_request_id below, which is the layer that has to hold if anything
# ever hands us a header by another route.
@pytest.mark.parametrize(
    "hostile",
    [
        "not-a-uuid",
        "../../etc/passwd",
        "\x1b[31mred",
        "x" * 5000,
        "<script>alert(1)</script>",
        "'; DROP TABLE users; --",
    ],
)
def test_a_hostile_header_is_discarded_not_sanitised(probe, hostile):
    """Rejected outright and replaced with a fresh UUID -- never trimmed into
    something 'safe enough' to log."""
    body = probe.get(
        "/__request_id_probe", headers={"X-Request-ID": hostile}
    ).get_json()
    assert UUID_RE.match(body["g"]), body["g"]
    assert hostile not in body["g"]
    # And still consistent across all three.
    assert body["g"] == body["accessor"] == body["context"]


def test_an_empty_header_falls_back_to_a_generated_id(probe):
    body = probe.get("/__request_id_probe", headers={"X-Request-ID": ""}).get_json()
    assert UUID_RE.match(body["g"])


# ── The sanitiser itself ─────────────────────────────────────────────────


def test_sanitiser_accepts_a_canonical_uuid():
    from app.middleware.request_id import _sanitize_request_id

    value = str(uuid.uuid4())
    assert _sanitize_request_id(value) == value


def test_sanitiser_normalises_a_non_canonical_uuid():
    """uuid.UUID() tolerates braces, urn: prefixes and missing hyphens. Those
    forms are normalised to canonical, so what reaches the log is a real UUID
    rather than whatever punctuation the client wrapped around it."""
    from app.middleware.request_id import _sanitize_request_id

    canonical = str(uuid.uuid4())
    assert _sanitize_request_id("{%s}" % canonical) == canonical
    assert _sanitize_request_id(canonical.replace("-", "")) == canonical
    assert _sanitize_request_id("urn:uuid:" + canonical) == canonical


def test_sanitiser_echoes_case_back_to_the_client():
    """An UPPERCASE uuid comes back as sent, deliberately: the point of
    honouring a client-supplied id is correlation, and a client greps its own
    logs for the string it generated. Case carries no injection risk -- it is
    still hex -- so echoing is both safe and more useful than normalising."""
    from app.middleware.request_id import _sanitize_request_id

    upper = str(uuid.uuid4()).upper()
    assert _sanitize_request_id(upper) == upper


@pytest.mark.parametrize(
    "payload",
    [
        "abc\nERROR fabricated log line",
        "abc\r\nWARNING forged",
        "\n\n2026-01-01 ERROR: invented",
        # A VALID uuid with a forged line appended -- what an attacker would
        # actually try, and the case a naive "does it contain a uuid?" check
        # would wave through.
        "550e8400-e29b-41d4-a716-446655440000\nERROR: not real",
    ],
)
def test_sanitiser_rejects_newline_payloads(payload):
    """The log-injection case (SEC-011). Werkzeug blocks these at the header
    layer, but the sanitiser must not depend on that."""
    from app.middleware.request_id import _sanitize_request_id

    assert _sanitize_request_id(payload) is None


@pytest.mark.parametrize("bad", [None, "", "   ", 12345, b"bytes", [], "nope"])
def test_sanitiser_rejects_everything_else(bad):
    from app.middleware.request_id import _sanitize_request_id

    assert _sanitize_request_id(bad) is None
