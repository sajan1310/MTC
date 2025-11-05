def test_get_items(client):
    resp = client.get("/api/items")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["success"]
    assert isinstance(data["data"], list)
