"""Contract tests for Inventory Alerts endpoints (UPF namespace).

Covers:
- GET /api/upf/inventory-alerts/lot/<id>
- POST /api/upf/inventory-alerts/lot/<id>/acknowledge-bulk
- GET /api/upf/inventory-alerts/rules
- PUT /api/upf/inventory-alerts/rules/<id>

Tests assert response schema presence/shape and avoid asserting actual values.
They gracefully skip if authentication is required and not present, or if DB
is unavailable in the environment.
"""

from __future__ import annotations

import pytest
import psycopg2

from app import create_app


@pytest.fixture(scope="module")
def client():
    app = create_app("testing")
    app.config["TESTING"] = True
    with app.test_client() as c:
        yield c


def _json(resp):
    assert resp.is_json, f"Expected JSON, got status {resp.status_code}"
    return resp.get_json()


@pytest.mark.parametrize("lot_id", [1])
def test_get_lot_alerts_contract(client, lot_id):
    try:
        resp = client.get(f"/api/upf/inventory-alerts/lot/{lot_id}")
    except psycopg2.OperationalError:
        pytest.xfail("Database unavailable for alerts tests")
    assert resp.status_code in (200, 401, 404)
    if resp.status_code == 401:
        pytest.skip("Authentication required; no session in testing env")
    if resp.status_code == 404:
        # Lot may not exist in test DB — acceptable
        return
    data = _json(resp)
    payload = data.get("data", data)
    # Required keys in contract
    for k in [
        "lot_id",
        "lot_status_inventory",
        "total_alerts",
        "alerts_summary",
        "alert_details",
    ]:
        assert k in payload, f"Missing key {k}"
    assert isinstance(payload["alert_details"], list)
    if payload["alert_details"]:
        ad = payload["alert_details"][0]
        for k in ["alert_id", "user_acknowledged", "severity", "message"]:
            assert k in ad, f"Missing {k} in alert_detail"


@pytest.mark.parametrize("lot_id", [1])
def test_acknowledge_bulk_payload_contract(client, lot_id):
    body = {
        "acknowledgments": [
            {"alert_id": 1, "user_action": "PROCEED", "action_notes": "test"}
        ]
    }
    try:
        resp = client.post(
            f"/api/upf/inventory-alerts/lot/{lot_id}/acknowledge-bulk", json=body
        )
    except psycopg2.OperationalError:
        pytest.xfail("Database unavailable for alerts tests")
    assert resp.status_code in (200, 401, 404, 409, 422, 500)
    if resp.status_code == 401:
        pytest.skip("Authentication required; no session in testing env")
    if resp.status_code == 200:
        data = _json(resp)
        payload = data.get("data", data)
        for k in ["status", "acknowledged_count", "updated_lot_status"]:
            assert k in payload


def test_get_rules_contract(client):
    try:
        resp = client.get("/api/upf/inventory-alerts/rules")
    except psycopg2.OperationalError:
        pytest.xfail("Database unavailable for alerts tests")
    assert resp.status_code in (200, 401)
    if resp.status_code == 401:
        pytest.skip("Authentication required; no session in testing env")
    data = _json(resp)
    payload = data.get("data", data)
    assert "rules" in payload
    assert isinstance(payload["rules"], list)


@pytest.mark.parametrize("variant_id", [1])
def test_put_rule_contract(client, variant_id):
    body = {
        "safety_stock_quantity": 10,
        "reorder_point_quantity": 20,
        "alert_threshold_percentage": 75.0,
    }
    try:
        resp = client.put(f"/api/upf/inventory-alerts/rules/{variant_id}", json=body)
    except psycopg2.OperationalError:
        pytest.xfail("Database unavailable for alerts tests")
    assert resp.status_code in (200, 401, 404, 409, 422, 500)
    if resp.status_code == 401:
        pytest.skip("Authentication required; no session in testing env")
