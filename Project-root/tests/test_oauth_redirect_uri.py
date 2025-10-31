"""Test that OAuth redirect URI is generated correctly and routes exist."""
import pytest
from flask import url_for

def test_oauth_redirect_uri_matches_expected(app, client):
    """Verify the OAuth callback route exists and generates correct external URL."""
    with app.test_request_context():
        # Test that the callback route exists
        all_endpoints = [rule.endpoint for rule in app.url_map.iter_rules()]
        assert 'auth.auth_google_callback' in all_endpoints, \
            f"OAuth callback route not registered. Available endpoints: {all_endpoints}"
        
        # Generate the redirect URI
        redirect_uri = url_for('auth.auth_google_callback', _external=True)
        
        # Verify it's an absolute URL
        assert redirect_uri.startswith('http://') or redirect_uri.startswith('https://'), \
            f"Redirect URI must be absolute, got: {redirect_uri}"
        
        # Verify it contains the callback path
        assert '/auth/google/callback' in redirect_uri, \
            f"Redirect URI must contain /auth/google/callback, got: {redirect_uri}"
        
        print(f"\n✓ Generated redirect URI: {redirect_uri}")
        print(f"✓ Add this EXACT URL to Google Cloud Console -> Authorized redirect URIs")

def test_oauth_initiate_returns_redirect_to_google(client):
    """Test that /auth/google redirects to Google OAuth."""
    response = client.get('/auth/google', follow_redirects=False)
    
    assert response.status_code == 302, f"Should redirect to Google, got status {response.status_code}"
    location = response.headers.get('Location')
    
    assert 'accounts.google.com' in location, \
        f"Should redirect to accounts.google.com, got: {location}"
    assert 'redirect_uri=' in location, \
        f"Redirect must include redirect_uri parameter, got: {location}"
    
    # Extract redirect_uri from query string
    import urllib.parse
    parsed = urllib.parse.urlparse(location)
    params = urllib.parse.parse_qs(parsed.query)
    redirect_uri = params.get('redirect_uri', [None])[0]
    
    print(f"\n✓ Redirect URI sent to Google: {redirect_uri}")
    assert redirect_uri, "redirect_uri parameter missing from Google auth URL"
    assert '/auth/google/callback' in redirect_uri, \
        f"redirect_uri must end with /auth/google/callback, got: {redirect_uri}"

def test_callback_route_exists_and_accepts_get(client):
    """Test that the callback route exists and accepts GET requests."""
    # Simulate Google redirect (will fail due to missing/invalid code, but shouldn't 404)
    response = client.get('/auth/google/callback?code=fake_code&state=fake_state')
    
    # Should NOT be 404
    assert response.status_code != 404, \
        "Callback route returned 404 - route not registered or path mismatch!"
    
    # Will likely be 400 or 500 due to invalid token, but that's OK for this test
    print(f"\n✓ Callback route exists (status: {response.status_code})")

def test_callback_route_handles_missing_code(client):
    """Test that callback route properly handles missing authorization code."""
    response = client.get('/auth/google/callback')
    
    assert response.status_code == 400, \
        f"Should return 400 for missing code, got: {response.status_code}"
    assert b'Missing authorization code' in response.data or b'code' in response.data.lower()

def test_callback_route_handles_google_error(client):
    """Test that callback route properly handles error from Google."""
    response = client.get('/auth/google/callback?error=access_denied')
    
    assert response.status_code == 400, \
        f"Should return 400 for Google error, got: {response.status_code}"
    assert b'error' in response.data.lower()

def test_config_has_oauth_credentials(app):
    """Verify OAuth credentials are loaded from config."""
    # May be None if not set, but config should have the keys
    assert 'GOOGLE_CLIENT_ID' in app.config, \
        "GOOGLE_CLIENT_ID not in app.config"
    assert 'GOOGLE_CLIENT_SECRET' in app.config, \
        "GOOGLE_CLIENT_SECRET not in app.config"
    
    if app.config.get('GOOGLE_CLIENT_ID') and app.config.get('GOOGLE_CLIENT_SECRET'):
        print(f"\n✓ OAuth credentials configured")
    else:
        print(f"\n⚠️  OAuth credentials not set (expected for testing)")

def test_login_route_exists(client):
    """Test that the login route exists."""
    response = client.get('/login')
    assert response.status_code == 200, f"Login route should return 200, got: {response.status_code}"
    assert b'google' in response.data.lower() or b'sign' in response.data.lower()
