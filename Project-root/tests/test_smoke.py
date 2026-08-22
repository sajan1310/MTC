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
