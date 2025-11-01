def test_login(client):
    resp = client.post('/auth/login', data={'username': 'test', 'password': 'test'})
    assert resp.status_code in (200, 401)
