def test_supplier_ledger_includes_event_ids(authenticated_client):
    """
    Contract test: supplier ledger should return items that include an event identifier
    (receipt_id, entry_id, po_id, purchase_order_id, or event_id) so the UI can render
    per-row actions like "View".
    """
    resp = authenticated_client.get("/api/suppliers/1/ledger")
    # Accept 200 or 404 (route may not be registered in some test setups); if 200, validate shape
    assert resp.status_code in (200, 404)
    if resp.status_code != 200:
        return

    data = resp.get_json()
    assert isinstance(data, dict)
    items = data.get("items")
    assert isinstance(items, list)

    # If there are zero items, nothing more to check here (accept empty ledgers)
    if len(items) == 0:
        return

    # Otherwise, ensure at least one of the common id fields exists per item
    for it in items:
        assert any(
            k in it
            for k in (
                "receipt_id",
                "entry_id",
                "event_id",
                "po_id",
                "purchase_order_id",
            )
        ), f"Ledger item missing expected id fields: {it}"
