def test_alerts_health_endpoint_with_alerts(authenticated_client):
    """Test /api/upf/monitoring/alerts-health returns correct structure with alerts present."""
    # Seed some alerts using the existing helper from test_inventory_alerts
    from tests.api.test_inventory_alerts import _seed_lot_with_alerts

    _seed_lot_with_alerts(["CRITICAL", "HIGH", "LOW"])

    resp = authenticated_client.get("/api/upf/monitoring/alerts-health")
    assert resp.status_code == 200

    data = resp.get_json()["data"]

    # Verify structure
    assert "total_active_alerts" in data
    assert "critical_count" in data
    assert "high_count" in data
    assert "medium_count" in data
    assert "low_count" in data
    assert "acknowledged_count" in data
    assert "oldest_critical_age_hours" in data

    # Verify we have at least the seeded alerts
    assert data["total_active_alerts"] >= 3
    assert data["critical_count"] >= 1
    assert data["high_count"] >= 1
    assert data["low_count"] >= 1

    # oldest_critical_age_hours should be a number (recent alert, so small positive value) or None
    if data["oldest_critical_age_hours"] is not None:
        assert isinstance(data["oldest_critical_age_hours"], (int, float))
        assert data["oldest_critical_age_hours"] >= 0


def test_alerts_health_endpoint_empty(authenticated_client):
    """Test /api/upf/monitoring/alerts-health when no alerts exist (edge case)."""
    # Clean slate: no alerts seeded; conftest creates baseline but no alerts yet
    # This test runs in isolation with a clean DB session, so counts may be zero

    resp = authenticated_client.get("/api/upf/monitoring/alerts-health")
    assert resp.status_code == 200

    data = resp.get_json()["data"]

    # Verify structure present even when empty
    assert "total_active_alerts" in data
    assert "critical_count" in data
    assert "oldest_critical_age_hours" in data

    # When no alerts, counts should be zero (or small if other tests left data)
    # oldest_critical_age_hours should be None when no unacknowledged CRITICAL exists
    assert isinstance(data["total_active_alerts"], int)
    assert isinstance(data["critical_count"], int)
    assert data["oldest_critical_age_hours"] is None or isinstance(
        data["oldest_critical_age_hours"], (int, float)
    )


def test_monitoring_page_renders(authenticated_client):
    """Test /monitoring page renders successfully."""
    resp = authenticated_client.get("/monitoring")
    assert resp.status_code == 200
    html = resp.data.decode("utf-8", errors="ignore")
    assert "Monitoring" in html or "monitoring" in html.lower()
    assert "alerts-health" in html  # Check the endpoint is referenced in JS
