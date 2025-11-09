from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Ensure repository root is on sys.path for direct module import
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from enhanced_project_auditor import EnhancedFlaskAuditor


@pytest.fixture(scope="module")
def auditor():
    aud = EnhancedFlaskAuditor("Project-root")
    # Core extraction steps (no DB or Flask runtime needed)
    bp_map = aud.extract_blueprints()
    aud.extract_routes_with_blueprints(bp_map)
    aud.extract_javascript_api_calls()
    aud.synchronize_routes_and_calls()
    return aud


def _routes(aud: EnhancedFlaskAuditor):
    return aud.results["flask_routes"]


def _by_full_path(aud: EnhancedFlaskAuditor, full_path: str):
    return [r for r in _routes(aud) if r.get("full_path") == full_path]


def _by_route(aud: EnhancedFlaskAuditor, file: str, route: str):
    return [r for r in _routes(aud) if r.get("file") == file and r.get("route") == route]


def test_extracts_multiline_process_get(auditor: EnhancedFlaskAuditor):
    """Multi-line decorator in process_management should be captured.
    Expected: GET /api/upf/processes/<int:process_id>
    """
    matches = _by_full_path(auditor, "/api/upf/processes/<int:process_id>")
    assert matches, "Expected GET /api/upf/processes/<int:process_id> to be extracted"
    assert any("GET" in r["methods"] for r in matches), "GET method missing on process detail route"


def test_compat_login_route_present(auditor: EnhancedFlaskAuditor):
    """Compatibility route in main_bp should be picked up: POST /api/login."""
    matches = _by_route(auditor, "app\\main\\routes.py", "/api/login")
    assert matches, "Expected POST /api/login from main_bp to be extracted"
    assert any("POST" in r["methods"] for r in matches), "POST method missing for /api/login"


def test_helper_pattern_detected_and_skipped(auditor: EnhancedFlaskAuditor):
    """Helper patterns like /api${path} should be detected but skipped in sync results."""
    api_calls = auditor.results["javascript_api_calls"]
    # At least one helper pattern should be detected from inventory_alerts.js
    assert any(call["url"] == "__HELPER_FUNCTION_PATTERN__" for call in api_calls), (
        "Expected helper pattern to be marked as __HELPER_FUNCTION_PATTERN__"
    )

    # Ensure sync did not count helper pattern as missing or matched
    sync = auditor.results["route_api_sync"]
    assert all(entry["url"] != "__HELPER_FUNCTION_PATTERN__" for entry in sync["matched"])
    assert all(entry["url"] != "__HELPER_FUNCTION_PATTERN__" for entry in sync["missing_backend"])


def test_normalize_path_equivalence():
    """JS template literal and Flask param forms should normalize equivalently."""
    aud = EnhancedFlaskAuditor("Project-root")
    flask_path = aud._normalize_path("/api/upf/processes/<int:process_id>")
    js_path = aud._normalize_path("/api/upf/processes/${processId}")
    assert flask_path == js_path == "/api/upf/processes/\\d+"


def test_zero_missing_backend_after_sync(auditor: EnhancedFlaskAuditor):
    sync = auditor.results["route_api_sync"]
    assert len(sync["missing_backend"]) == 0, (
        f"Expected 0 missing backend routes, found {len(sync['missing_backend'])}: {sync['missing_backend'][:3]}"
    )
