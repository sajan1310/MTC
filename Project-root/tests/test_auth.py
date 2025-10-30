from unittest.mock import patch
from flask import url_for, request
from models import User

def test_login_page(client):
    """Test that the login page loads correctly."""
    response = client.get('/login')
    assert response.status_code == 200
    assert b"Sign in with Google" in response.data

@patch('auth.routes.get_google_provider_cfg')
@patch('auth.routes.requests')
@patch('app.get_or_create_user')
def test_google_login(mock_get_or_create_user, mock_requests, mock_get_cfg, client, monkeypatch):
    """Test the Google OAuth login flow."""
    monkeypatch.setenv("OAUTHLIB_INSECURE_TRANSPORT", "1")
    mock_get_cfg.return_value = {
        "authorization_endpoint": "https://accounts.google.com/o/oauth2/auth",
        "token_endpoint": "https://oauth2.googleapis.com/token",
        "userinfo_endpoint": "https://openidconnect.googleapis.com/v1/userinfo",
    }
    mock_requests.post.return_value.json.return_value = {
        "access_token": "test_token",
        "expires_in": 3600,
        "token_type": "Bearer",
        "id_token": "test_id_token",
    }
    mock_requests.get.return_value.json.return_value = {
        "email": "test@example.com",
        "email_verified": True,
        "name": "Test User",
    }
    mock_get_or_create_user.return_value = (User({
        'user_id': 1,
        'name': 'Test User',
        'email': 'test@example.com',
        'role': 'user',
    }), True)

    response = client.get('/auth/google', follow_redirects=False)
    assert response.status_code == 302
    assert "accounts.google.com" in response.location

    response = client.get('/auth/google/callback?code=test_code', follow_redirects=True)
    assert response.status_code == 200
    assert b"Dashboard" in response.data
