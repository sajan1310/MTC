import pytest


def test_app_creation(app):
    """Test that the Flask app is created."""
    assert app is not None


@pytest.mark.parametrize(
    "path, expected_status",
    [
        ("/auth/login", 200),
        ("/dashboard", [200, 302]),  # 200 with LOGIN_DISABLED, 302 normally
    ],
)
def test_pages_load(client, path, expected_status):
    """Test that key pages load with the correct status code."""
    response = client.get(path)
    if isinstance(expected_status, list):
        assert response.status_code in expected_status
    else:
        assert response.status_code == expected_status


class TestHealthEndpoint:
    """/health is a deployment contract, not a convenience route.

    DEPLOYMENT.md's post-deployment step 1, its Kubernetes livenessProbe
    example and PRODUCTION_READINESS.md's load-balancer checklist all tell
    operators to point infrastructure at this path. It was documented for
    months without existing, so every one of those checks 404'd. These tests
    exist so that regression is loud rather than silent.
    """

    def test_health_returns_documented_shape(self, client):
        response = client.get("/health")

        assert response.status_code == 200
        body = response.get_json()
        # The exact keys DEPLOYMENT.md publishes as the response.
        assert body["status"] == "healthy"
        assert body["database"] == "connected"
        assert body["timestamp"].endswith("Z")

    def test_health_needs_no_authentication(self, app, client):
        """A probe has no session; requiring one would fail every check."""
        assert "health" in app.view_functions
        assert client.get("/health").status_code == 200

    def test_health_reports_503_when_database_is_down(self, client, monkeypatch):
        """The status code is the only part a load balancer reads.

        A health check that stays 2xx while the database is unreachable keeps
        a broken instance in rotation, which is the failure it was added to
        prevent.
        """
        import database

        monkeypatch.setattr(database, "db_pool", None)

        response = client.get("/health")

        assert response.status_code == 503
        body = response.get_json()
        assert body["status"] == "unhealthy"
        assert body["database"] == "error"

    def test_health_does_not_leak_connection_details(self, client, monkeypatch):
        """psycopg2 errors quote the DSN -- host, user and password included.

        This endpoint is public and unauthenticated by necessity, so the
        failure body must stay a fixed string and the detail must go to the
        log instead.
        """
        import database

        def _boom(*_args, **_kwargs):
            raise RuntimeError(
                "connection to server at 'db.internal' failed: "
                "password authentication failed for user 'mtc_prod'"
            )

        monkeypatch.setattr(database, "get_conn", _boom)

        body = client.get("/health").get_data(as_text=True)

        assert "mtc_prod" not in body
        assert "db.internal" not in body
        assert "password" not in body.lower()


class TestHealthVitals:
    """The richer answer, for an operator on the box rather than a probe.

    /health stays three keys for anyone out on the network -- that is a
    published contract and a load balancer reads it. The vitals ride along
    only for callers who have earned them.
    """

    def test_local_caller_gets_the_vitals(self, client):
        body = client.get("/health").get_json()

        assert "vitals" in body
        for section in ("app", "database", "redis", "backups", "disk"):
            assert section in body["vitals"], f"{section} missing from vitals"

    def test_the_documented_three_keys_survive(self, client):
        """Adding vitals must not disturb what infrastructure already reads."""
        body = client.get("/health").get_json()

        assert body["status"] == "healthy"
        assert body["database"] == "connected"
        assert body["timestamp"].endswith("Z")

    def test_a_public_caller_gets_nothing_extra(self, client):
        """nginx APPENDS the connecting address to X-Forwarded-For, so the
        last entry is the one a caller cannot forge. A public address gets
        the three documented keys and nothing else."""
        body = client.get("/health", headers={"X-Forwarded-For": "8.8.8.8"}).get_json()

        assert "vitals" not in body
        assert set(body) == {"status", "database", "timestamp"}

    def test_a_tailnet_caller_gets_the_vitals(self, client):
        """Remote access to this server is a tailnet. Excluding 100.64/10
        would make the vitals unreadable from anywhere but a shell on the
        box, which is the opposite of what they are for."""
        body = client.get(
            "/health", headers={"X-Forwarded-For": "100.93.74.28"}
        ).get_json()

        assert "vitals" in body

    def test_a_lan_caller_gets_the_vitals(self, client):
        body = client.get(
            "/health", headers={"X-Forwarded-For": "192.168.31.50"}
        ).get_json()

        assert "vitals" in body

    def test_scope_local_shuts_the_lan_out_again(self, client, monkeypatch):
        monkeypatch.setenv("HEALTH_VITALS_SCOPE", "local")
        body = client.get(
            "/health", headers={"X-Forwarded-For": "192.168.31.50"}
        ).get_json()

        assert "vitals" not in body

    def test_a_forged_header_cannot_buy_access(self, client, monkeypatch):
        """Only the LAST entry is trusted -- the one nginx appended. A client
        that sends its own X-Forwarded-For prepends to it."""
        monkeypatch.setenv("HEALTH_VITALS_SCOPE", "private")
        body = client.get(
            "/health", headers={"X-Forwarded-For": "127.0.0.1, 8.8.8.8"}
        ).get_json()

        assert "vitals" not in body

    def test_durability_settings_are_reported(self, client):
        """fsync, synchronous_commit and full_page_writes are what decide
        whether a power cut costs committed data. Turning one off to make the
        box 'faster' would otherwise go unnoticed until the day it matters."""
        durability = client.get("/health").get_json()["vitals"]["database"][
            "durability"
        ]

        assert set(durability) >= {
            "fsync",
            "synchronous_commit",
            "full_page_writes",
            "ok",
        }

    def test_a_broken_section_does_not_break_the_endpoint(self, client, monkeypatch):
        """A status panel has to work on the day something is broken -- which
        is the day a half-broken one would throw instead."""
        from app import health

        def _boom():
            raise RuntimeError("disk on fire")

        monkeypatch.setitem(health._SECTIONS, "backups", _boom)

        response = client.get("/health")

        assert response.status_code == 200
        assert response.get_json()["vitals"]["backups"] == {"error": "RuntimeError"}

    def test_a_broken_section_reports_its_type_and_not_its_message(
        self, client, monkeypatch
    ):
        """Same reasoning as test_health_does_not_leak_connection_details:
        psycopg2 spells its failures with the host, user and password in one
        string, and gating the payload is not a licence to include them."""
        from app import health

        def _boom():
            raise RuntimeError(
                "connection to server at 'db.internal' failed: "
                "password authentication failed for user 'mtc_prod'"
            )

        monkeypatch.setitem(health._SECTIONS, "database", _boom)

        body = client.get("/health").get_data(as_text=True)

        assert "mtc_prod" not in body
        assert "db.internal" not in body
        assert "RuntimeError" in body
