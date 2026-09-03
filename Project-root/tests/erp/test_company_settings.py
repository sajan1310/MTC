"""Company Logo RPC tests, ported behavior from Apps_Script/utils.js's
saveLogo/getLogo/clearLogo.

erp.company_settings is a true singleton (always id=1, no per-test
isolation via unique names like every other module's tests use) -- each
test below is written to be correct regardless of what a previous test
left behind, rather than assuming a pristine initial state.
"""

from __future__ import annotations

import uuid


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(
        f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers
    )


def test_save_then_get_logo_round_trips(erp_client):
    chunks = ["data:image/png;base64,AAAA", "BBBB", "CCCC"]
    saved = _rpc(erp_client, "saveLogo", [chunks], mutation=True)
    assert saved.status_code == 200
    assert saved.get_json()["success"] is True

    fetched = _rpc(erp_client, "getLogo")
    assert fetched.status_code == 200
    body = fetched.get_json()
    assert body["success"] is True
    assert (
        body["data"] == "data:image/png;base64,AAAABBBBCCCC"
    )  # chunks rejoined, not chunked server-side


def test_save_logo_overwrites_previous_value(erp_client):
    _rpc(erp_client, "saveLogo", [["first-value"]], mutation=True)
    _rpc(erp_client, "saveLogo", [["second-value"]], mutation=True)

    fetched = _rpc(erp_client, "getLogo").get_json()
    assert (
        fetched["data"] == "second-value"
    )  # singleton row -- second save replaces, doesn't append


def test_save_logo_rejects_empty_chunks(erp_client):
    resp = _rpc(erp_client, "saveLogo", [[]], mutation=True)
    body = resp.get_json()
    assert body["success"] is False


def test_clear_logo_removes_it(erp_client):
    _rpc(erp_client, "saveLogo", [["some-logo-data"]], mutation=True)
    cleared = _rpc(erp_client, "clearLogo", mutation=True)
    assert cleared.get_json()["success"] is True

    fetched = _rpc(erp_client, "getLogo").get_json()
    assert fetched["success"] is True
    assert fetched["data"] is None


def test_get_logo_before_any_save_is_null_not_an_error(erp_client):
    _rpc(
        erp_client, "clearLogo", mutation=True
    )  # guarantee a clean slate regardless of test order

    fetched = _rpc(erp_client, "getLogo").get_json()
    assert fetched["success"] is True
    assert fetched["data"] is None
