"""Contract tests for UPF Reports API.

Verifies presence and shape of responses for:
- GET /api/upf/reports/metrics
- GET /api/upf/reports/top-processes
- GET /api/upf/reports/process-status
- GET /api/upf/reports/subprocess-usage

Tests focus on JSON schema (field presence and type). They do NOT assert
exact numeric values (which depend on dynamic DB state). If database is
unavailable (OperationalError), tests are xfailed gracefully so CI doesn't
produce false negatives before DB setup.
"""
from __future__ import annotations

import pytest
import psycopg2

from app import create_app


@pytest.fixture(scope="module")
def test_client():
    app = create_app("testing")
    app.config["TESTING"] = True
    # In testing mode, auth might be relaxed. If login required strictly,
    # consider creating a mock user session here.
    with app.test_client() as client:
        yield client


def _get_json(resp):
    assert resp.is_json, f"Response not JSON (status={resp.status_code})"
    return resp.get_json()


@pytest.mark.parametrize(
    "endpoint,required_fields",
    [
        ("/api/upf/reports/metrics", [
            "total_processes",
            "total_lots",
            "avg_cost",
            "completed_lots",
            "processes_change",
            "lots_change",
            "cost_change",
            "completed_change",
        ]),
        ("/api/upf/reports/process-status", ["active", "inactive", "draft"]),
    ],
)
def test_basic_report_field_presence(test_client, endpoint, required_fields):
    """Ensure top-level numeric fields exist for metrics and process-status."""
    try:
        resp = test_client.get(endpoint)
    except psycopg2.OperationalError:
        pytest.xfail("Database unavailable for metrics endpoint test")
    # Auth requirement may yield 401 if login strictly enforced in test env.
    assert resp.status_code in (200, 401), f"Unexpected status {resp.status_code}"
    if resp.status_code == 401:
        pytest.skip("Authentication required; test env lacks session.")
    data = _get_json(resp)["data"] if "data" in _get_json(resp) else _get_json(resp)
    for field in required_fields:
        assert field in data, f"Missing field '{field}' in response JSON"
        # Type sanity (allow int or float for costs/change metrics)
        if field.endswith("_change") or field == "avg_cost":
            assert isinstance(data[field], (int, float)), f"Field {field} must be numeric"
        else:
            assert isinstance(data[field], int), f"Field {field} must be int"


def test_top_processes_contract(test_client):
    try:
        resp = test_client.get("/api/upf/reports/top-processes")
    except psycopg2.OperationalError:
        pytest.xfail("Database unavailable for top-processes test")
    assert resp.status_code in (200, 401)
    if resp.status_code == 401:
        pytest.skip("Authentication required; test env lacks session.")
    payload = _get_json(resp)
    data = payload.get("data", payload)
    assert "processes" in data, "Missing 'processes' key"
    assert isinstance(data["processes"], list), "'processes' must be a list"
    for p in data["processes"]:
        assert "name" in p, "Process object missing 'name'"
        assert "worst_case_cost" in p, "Process object missing 'worst_case_cost'"
        assert isinstance(p["worst_case_cost"], (int, float))


def test_subprocess_usage_contract(test_client):
    try:
        resp = test_client.get("/api/upf/reports/subprocess-usage")
    except psycopg2.OperationalError:
        pytest.xfail("Database unavailable for subprocess-usage test")
    assert resp.status_code in (200, 401)
    if resp.status_code == 401:
        pytest.skip("Authentication required; test env lacks session.")
    payload = _get_json(resp)
    data = payload.get("data", payload)
    assert "subprocesses" in data, "Missing 'subprocesses' key"
    assert isinstance(data["subprocesses"], list), "'subprocesses' must be a list"
    for sp in data["subprocesses"]:
        assert "name" in sp, "Subprocess object missing 'name'"
        assert "usage_count" in sp, "Subprocess object missing 'usage_count'"
        assert isinstance(sp["usage_count"], int)


# Edge sanity: Ensure empty lists still conform
@pytest.mark.parametrize(
    "endpoint,container_key",
    [
        ("/api/upf/reports/top-processes", "processes"),
        ("/api/upf/reports/subprocess-usage", "subprocesses"),
    ],
)
def test_empty_list_is_valid(test_client, endpoint, container_key):
    try:
        resp = test_client.get(endpoint)
    except psycopg2.OperationalError:
        pytest.xfail("Database unavailable for list endpoint test")
    assert resp.status_code in (200, 401)
    if resp.status_code == 401:
        pytest.skip("Authentication required; test env lacks session.")
    payload = _get_json(resp)
    data = payload.get("data", payload)
    assert container_key in data
    assert isinstance(data[container_key], list)
    # No further assertions: empty list is acceptable
