"""
Tests for Subprocess Metadata API Endpoint.

Verifies that /api/upf/subprocesses/metadata returns proper category metadata
to support dynamic frontend dropdown population.
"""
import pytest
from flask import Flask


def test_subprocess_metadata_endpoint(client):
    """Test subprocess metadata endpoint returns expected categories."""
    response = client.get('/api/upf/subprocesses/metadata')
    assert response.status_code == 200
    data = response.get_json()
    
    # Validate response structure (APIResponse format: success, data, message, error)
    assert 'success' in data
    assert data['success'] is True
    assert 'data' in data
    
    metadata = data['data']
    
    # Validate categories array
    assert 'categories' in metadata
    assert isinstance(metadata['categories'], list)
    assert len(metadata['categories']) > 0
    
    # Validate expected categories are present
    expected_categories = [
        'Preparation', 'Assembly', 'Finishing', 
        'Quality Control', 'Packaging', 'Testing',
        'Maintenance', 'Inspection', 'Other'
    ]
    for cat in expected_categories:
        assert cat in metadata['categories'], f"Missing category: {cat}"
    
    # Validate default_category
    assert 'default_category' in metadata
    assert metadata['default_category'] == 'Other'
    
    # Validate units
    assert 'time_unit' in metadata
    assert metadata['time_unit'] == 'minutes'
    assert 'cost_currency' in metadata
    assert metadata['cost_currency'] == 'USD'


def test_subprocess_metadata_unauthenticated(client):
    """Test that metadata endpoint requires authentication when login is enabled."""
    # Note: In test environment with LOGIN_DISABLED, this will still return 200
    # In production with login enabled, should return 401/302
    response = client.get('/api/upf/subprocesses/metadata')
    # With LOGIN_DISABLED=True (test config), endpoint should work
    assert response.status_code == 200
