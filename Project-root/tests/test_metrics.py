"""The /metrics endpoint (OBS-002).

The audit found no metrics, no APM and no `pg_stat_statements`: the only way
to learn the application was unwell was for a person to notice.

Two things are being pinned here, and the second matters as much as the first.

**It is not public.** The body names internal tables and counts. An
unauthenticated endpoint reporting whether the mutation backlog is growing is
reconnaissance for free.

**It does not report request rates.** Gunicorn runs 4 workers behind one
port, so a scrape reaches one of them at the OS's choosing. A per-worker
request counter would report a random quarter of the traffic and lurch
between scrapes -- confidently wrong rather than approximately right, which
is worse than absent. Everything exposed here is either database-wide (the
same from any worker, by construction) or explicitly labelled with the worker
pid so it can never be summed as though it were global.
"""

from __future__ import annotations

import pytest


def _parse(body: str) -> dict[str, float]:
    """Metric name (with labels stripped) -> value, ignoring HELP/TYPE."""
    out = {}
    for line in body.splitlines():
        if not line or line.startswith("#"):
            continue
        name, _, value = line.rpartition(" ")
        out[name.split("{")[0]] = float(value)
    return out


@pytest.fixture
def scraper(app):
    app.config["METRICS_TOKEN"] = "scrape-me-please"
    client = app.test_client()
    client.environ_base["HTTP_AUTHORIZATION"] = "Bearer scrape-me-please"
    return client


# ── Access control ───────────────────────────────────────────────────────


def test_an_unauthenticated_scrape_is_refused(app):
    app.config["METRICS_TOKEN"] = "scrape-me-please"
    assert app.test_client().get("/metrics").status_code == 404


def test_the_refusal_does_not_confirm_the_endpoint_exists(app):
    """404 rather than 401: a prober learns nothing from the response."""
    app.config["METRICS_TOKEN"] = "scrape-me-please"
    response = app.test_client().get("/metrics")
    assert response.status_code == 404
    assert "metric" not in response.get_data(as_text=True).lower()


def test_a_wrong_token_is_refused(app):
    app.config["METRICS_TOKEN"] = "scrape-me-please"
    client = app.test_client()
    response = client.get("/metrics", headers={"Authorization": "Bearer wrong"})
    assert response.status_code == 404


def test_a_prefix_of_the_token_is_refused(app):
    """compare_digest, not ==: a plain comparison leaks the matching prefix
    and the length through timing."""
    app.config["METRICS_TOKEN"] = "scrape-me-please"
    client = app.test_client()
    assert client.get(
        "/metrics", headers={"Authorization": "Bearer scrape-me"}
    ).status_code == 404


def test_the_right_token_is_accepted(scraper):
    assert scraper.get("/metrics").status_code == 200


# ── Format ───────────────────────────────────────────────────────────────


def test_the_content_type_is_the_prometheus_exposition_format(scraper):
    content_type = scraper.get("/metrics").headers["Content-Type"]
    assert content_type.startswith("text/plain")
    assert "version=0.0.4" in content_type


def test_every_metric_has_help_and_type(scraper):
    """A scrape without them still parses, but nothing downstream can say
    what the number means or whether it may be rate()d."""
    body = scraper.get("/metrics").get_data(as_text=True)
    described = {
        line.split()[2] for line in body.splitlines() if line.startswith("# HELP ")
    }
    typed = {
        line.split()[2] for line in body.splitlines() if line.startswith("# TYPE ")
    }
    emitted = set(_parse(body))
    assert emitted <= described, sorted(emitted - described)
    assert emitted <= typed, sorted(emitted - typed)


def test_every_value_is_numeric(scraper):
    body = scraper.get("/metrics").get_data(as_text=True)
    for line in body.splitlines():
        if line and not line.startswith("#"):
            float(line.rpartition(" ")[2])  # raises if it is not a number


# ── What it reports ──────────────────────────────────────────────────────


def test_it_reports_the_things_this_application_actually_fails_at(scraper):
    """Connection exhaustion, a mutation backlog, migration drift, and the
    over-allocated warehouse rows DATA-002 is about."""
    metrics = _parse(scraper.get("/metrics").get_data(as_text=True))
    for name in (
        "mtc_db_connections",
        "mtc_db_max_connections",
        "mtc_mutations_in_progress",
        "mtc_migrations_applied",
        "mtc_warehouse_pool_negative_rows",
        "mtc_admin_accounts",
        "mtc_database_up",
    ):
        assert name in metrics, f"{name} missing from the scrape"


def test_the_database_is_reported_up(scraper):
    assert _parse(scraper.get("/metrics").get_data(as_text=True))["mtc_database_up"] == 1


def test_per_worker_gauges_carry_a_worker_label(scraper):
    """So they can never be silently summed across workers as though they
    were global."""
    body = scraper.get("/metrics").get_data(as_text=True)
    worker_lines = [
        line for line in body.splitlines()
        if line.startswith("mtc_worker_") and not line.startswith("#")
    ]
    assert worker_lines
    for line in worker_lines:
        assert 'worker="' in line, line


def test_no_request_counters_are_exposed(scraper):
    """Deliberate. With 4 workers behind one port, a scrape reaches one of
    them, so a per-worker request counter reports a random fraction of the
    traffic. Absent beats wrong; the reverse proxy's access log has the real
    numbers. If multiprocess mode is ever configured, this test is the note
    saying what changed."""
    body = scraper.get("/metrics").get_data(as_text=True)
    names = set(_parse(body))
    for forbidden in (
        "mtc_http_requests_total",
        "mtc_requests_total",
        "mtc_request_duration_seconds",
    ):
        assert forbidden not in names


# ── Failure behaviour ────────────────────────────────────────────────────


def test_a_database_failure_is_reported_not_raised(app, monkeypatch):
    """A scrape must never 500. The endpoint's own inability to reach the
    database is itself the most important thing it can report."""
    import app.metrics as metrics_module

    def _explode(*_args, **_kwargs):
        raise RuntimeError("pool is gone")

    monkeypatch.setattr(metrics_module.database, "get_conn", _explode)
    app.config["METRICS_TOKEN"] = "scrape-me-please"
    client = app.test_client()

    response = client.get("/metrics", headers={"Authorization": "Bearer scrape-me-please"})
    assert response.status_code == 200
    assert _parse(response.get_data(as_text=True))["mtc_database_up"] == 0


def test_a_database_failure_does_not_leak_connection_details(app, monkeypatch):
    """psycopg2 errors quote the DSN -- host, user and password included."""
    import app.metrics as metrics_module

    def _explode(*_args, **_kwargs):
        raise RuntimeError(
            "connection to server at 'db.internal' failed: password "
            "authentication failed for user 'mtc_prod'"
        )

    monkeypatch.setattr(metrics_module.database, "get_conn", _explode)
    app.config["METRICS_TOKEN"] = "scrape-me-please"
    body = app.test_client().get(
        "/metrics", headers={"Authorization": "Bearer scrape-me-please"}
    ).get_data(as_text=True)

    assert "db.internal" not in body
    assert "mtc_prod" not in body


def test_the_scrape_is_exempt_from_the_rate_limiter(app):
    """RATELIMIT_DEFAULT is "200 per day"; a scrape every 15s is 5,760. Without
    the exemption the metrics go dark within the hour -- exactly when a
    deployment is busy enough to be worth watching."""
    app.config["METRICS_TOKEN"] = "scrape-me-please"
    client = app.test_client()
    for _ in range(30):
        response = client.get(
            "/metrics", headers={"Authorization": "Bearer scrape-me-please"}
        )
        assert response.status_code == 200
