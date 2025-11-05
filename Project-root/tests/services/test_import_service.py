def test_import_data(client):
    resp = client.post("/api/imports", data={})
    assert resp.status_code in (200, 400)
