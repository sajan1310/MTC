from app import validate_password
from flask import request

def test_home_redirect(client):
    """Test that the home route redirects to the login page for unauthenticated users."""
    response = client.get('/', follow_redirects=True)
    assert response.status_code == 200
    assert b"Sign in with Google" in response.data  # Check for content on the login page

def test_validate_password():
    """Test the password validation logic."""
    assert validate_password("password")[0] is False
    assert validate_password("Password123")[0] is False
    assert validate_password("Password123!")[0] is True
