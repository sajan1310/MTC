def test_process_metadata(client):
    # The test client is authenticated via LOGIN_DISABLED in conftest
    resp = client.get("/api/upf/processes/metadata")
    assert resp.status_code == 200
    data = resp.get_json()
    assert "data" in data
    payload = data["data"]

    # Should include schema flag and arrays
    assert payload.get("schema") in ("new", "legacy")
    assert isinstance(payload.get("classes"), list)
    assert isinstance(payload.get("statuses"), list)
    assert payload.get("default_status")

    # Basic sanity: display classes should mirror classes in count
    classes = payload["classes"]
    display = payload.get("classes_display", [])
    if display:
        assert len(display) == len(classes)

    # Values should align to known sets for either schema
    if payload["schema"] == "new":
        assert set(classes) >= set(["assembly", "manufacturing", "packaging"])
        # Status lowercase set includes at least these
        assert set(payload["statuses"]) >= set(["draft", "active"])
    else:
        # legacy title-case
        assert set(classes) >= set(["Manufacturing", "Assembly", "Packaging"])
        assert set(payload["statuses"]) >= set(["Draft", "Active"])
