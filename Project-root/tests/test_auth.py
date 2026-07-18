from unittest.mock import patch

from app.models import User


def test_login_page(client):
    """Test that the login page loads correctly with email/password form."""
    response = client.get("/auth/login")
    assert response.status_code == 200
    # Check for core elements of the new login page
    assert b"Welcome back" in response.data or b"Login" in response.data
    assert b'name="email"' in response.data
    assert b'name="password"' in response.data


def test_signup_page(client):
    response = client.get("/auth/signup")
    assert response.status_code == 200
    assert b"Create your account" in response.data or b"Create account" in response.data


def test_forgot_password_page(client):
    response = client.get("/auth/forgot-password")
    assert response.status_code == 200
    assert b"Reset your password" in response.data


@patch("auth.routes.get_google_provider_cfg")
@patch("auth.routes.requests")
@patch("app.get_or_create_user")
def test_google_login(
    mock_get_or_create_user, mock_requests, mock_get_cfg, client, monkeypatch
):
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
    mock_get_or_create_user.return_value = (
        User(
            {
                "user_id": 1,
                "name": "Test User",
                "email": "test@example.com",
                "role": "user",
            }
        ),
        True,
    )

    response = client.get("/auth/google", follow_redirects=False)
    assert response.status_code == 302
    assert "accounts.google.com" in response.location

    response = client.get("/auth/google/callback?code=test_code", follow_redirects=True)
    assert response.status_code == 200
    assert b"Maharaja Bikes" in response.data


def test_api_login_demo_credentials(client, app):
    # Uses demo credentials available under TESTING
    payload = {
        "email": app.config.get("DEMO_USER_EMAIL", "demo@example.com"),
        "password": app.config.get("DEMO_USER_PASSWORD", "Demo@1234"),
    }
    response = client.post("/auth/api/login", json=payload)
    assert response.status_code == 200
    data = response.get_json()
    assert data.get("success") is True
    assert "redirect_url" in data


def test_load_user_reconstructs_demo_account(app):
    # Regression test: the demo user (id -1, from api_login()'s dev/test
    # fallback) has no row in `users`. load_user() must special-case that
    # id and reconstruct it directly rather than querying the DB -- a DB
    # lookup for id -1 always misses, so the session would silently drop
    # the demo user on the very next request after a successful login.
    # (Flask's test client preserves app context across sequential
    # requests on the same client under TESTING=True, which masks this bug
    # if tested via client.post() + client.get() -- calling the callback
    # directly is what actually exercises the fixed code path.)
    from app.auth.routes import DEMO_USER_ID

    with app.app_context():
        user = app.login_manager._user_callback(str(DEMO_USER_ID))

    assert user is not None
    assert user.get_id() == str(DEMO_USER_ID)
    assert user.email == app.config.get("DEMO_USER_EMAIL", "demo@example.com")


def test_zzz_debug_no_login(app):
    app.config["LOGIN_DISABLED"] = False
    print("ZZZDEBUG CONFIG LOGIN_DISABLED:", app.config.get("LOGIN_DISABLED"))
    with app.test_client() as client:
        r = client.get("/erp")
        print("ZZZDEBUG no-login /erp status:", r.status_code, "location:", r.headers.get("Location"))
