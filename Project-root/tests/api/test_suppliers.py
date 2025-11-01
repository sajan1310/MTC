def test_get_suppliers(client):
    resp = client.get('/api/suppliers')
    assert resp.status_code == 200
    data = resp.get_json()
    assert data['success']
    assert isinstance(data['data'], list)
