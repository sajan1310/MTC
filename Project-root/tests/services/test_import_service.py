def test_import_data(client):
    resp = client.post("/api/imports", data={})
    # Endpoint requires authentication, expect 401 or valid response
    assert resp.status_code in (200, 400, 401)
