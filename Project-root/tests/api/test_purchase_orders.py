def test_get_purchase_orders(client):
    resp = client.get('/api/purchase-orders')
    assert resp.status_code == 200
    data = resp.get_json()
    assert data['success']
    assert isinstance(data['data'], list)
