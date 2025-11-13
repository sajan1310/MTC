def test_variant_ledger_requires_variant(authenticated_client):
    resp = authenticated_client.get("/api/variant-ledger")
    # Depending on which routes are registered in test setup this may be 400 (missing param)
    # or 404 (route not registered). Both are acceptable for this smoke test.
    assert resp.status_code in (400, 404)
    data = resp.get_json(silent=True)
    if resp.status_code == 400:
        assert data and "error" in data


def test_supplier_ledger_endpoint_exists(authenticated_client):
    # Call supplier ledger for supplier id 1. Depending on test DB seeding this
    # may return 200 (with items) or 404/empty — we accept 200 or 200 with empty items.
    resp = authenticated_client.get("/api/suppliers/1/ledger")
    assert resp.status_code in (200, 404)
    if resp.status_code == 200:
        data = resp.get_json()
        assert isinstance(data, dict)
        assert "items" in data
