def test_get_suppliers(client):
    """Test fetching suppliers returns APIResponse envelope with data list."""
    resp = client.get("/api/suppliers")
    assert resp.status_code == 200
    
    data = resp.get_json()
    # Verify APIResponse envelope structure
    assert isinstance(data, dict), "Response should be a dictionary (APIResponse envelope)"
    assert "success" in data, "Response should have 'success' field"
    assert "data" in data, "Response should have 'data' field"
    assert "message" in data, "Response should have 'message' field"
    
    # Verify response values
    assert data["success"] is True, "Success should be True for get_suppliers"
    assert isinstance(data["data"], list), "Data should be a list of suppliers"
    assert isinstance(data["message"], str), "Message should be a string"
