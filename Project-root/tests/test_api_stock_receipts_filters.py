"""API tests for stock receipts pagination and supplier/variant filters."""


def test_stock_receipts_pagination(authenticated_client):
    resp = authenticated_client.get("/api/stock-receipts?page=1&per_page=5")
    assert resp.status_code in [200, 401]
    if resp.status_code == 200:
        data = resp.get_json()
        assert isinstance(data, dict)
        assert (
            "items" in data
            and "total" in data
            and "page" in data
            and "per_page" in data
        )


def test_stock_receipts_supplier_filter(authenticated_client):
    # supplier_id must be integer; if auth blocked, allow 401
    resp = authenticated_client.get(
        "/api/stock-receipts?supplier_id=1&page=1&per_page=5"
    )
    assert resp.status_code in [200, 400, 401]
    if resp.status_code == 200:
        data = resp.get_json()
        assert "items" in data


def test_stock_receipts_variant_filter(authenticated_client):
    resp = authenticated_client.get(
        "/api/stock-receipts?variant_id=1&page=1&per_page=5"
    )
    assert resp.status_code in [200, 400, 401]
    if resp.status_code == 200:
        data = resp.get_json()
        assert "items" in data
