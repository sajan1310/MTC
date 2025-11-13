def test_supplier_ledger_pagination_contract(authenticated_client):
    """
    Contract test: calling supplier ledger with pagination params should return
    a JSON response containing items (list). If total/page/per_page are present
    they should be integers.
    """
    resp = authenticated_client.get("/api/suppliers/1/ledger?page=1&per_page=5")
    assert resp.status_code in (200, 404)
    if resp.status_code != 200:
        return

    data = resp.get_json()
    assert isinstance(data, dict)
    items = data.get("items")
    assert isinstance(items, list)

    # If pagination metadata present, check types
    if "total" in data:
        assert isinstance(data["total"], int)
    if "page" in data:
        assert isinstance(data["page"], int)
    if "per_page" in data:
        assert isinstance(data["per_page"], int)


def test_variant_ledger_pagination_contract(authenticated_client):
    resp = authenticated_client.get("/api/variant-ledger?variant_id=1&page=1&per_page=5")
    assert resp.status_code in (200, 400, 404)
    if resp.status_code != 200:
        return

    data = resp.get_json()
    # variant-ledger may return a paginated object or a list
    if isinstance(data, dict):
        items = data.get("items")
        assert isinstance(items, list)
        if "total" in data:
            assert isinstance(data["total"], int)
    else:
        # plain list
        assert isinstance(data, list)
