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


# ── Offline password for Google-created accounts ──────────────────────────
# get_or_create_user (app/utils.py) inserts name/email/role/profile_picture
# and no password_hash, so every account made through Google sign-in has no
# password. Harmless while the internet is up; total once it is not. On the
# factory LAN there is no route to accounts.google.com, and Google will not
# register a private-IP redirect URI anyway, so such an account has no way
# in at all. These cover the two halves of the way back: knowing the account
# needs a password, and being able to set one.


def test_user_reports_whether_it_can_sign_in_without_google():
    """The banner in index.html is driven entirely by this flag."""
    google_only = User(
        {"user_id": 1, "name": "G", "email": "g@example.com", "role": "user"}
    )
    assert google_only.has_password is False

    with_password = User(
        {
            "user_id": 2,
            "name": "P",
            "email": "p@example.com",
            "role": "user",
            "password_hash": "pbkdf2:sha256:x$y$z",
        }
    )
    assert with_password.has_password is True


def test_user_never_carries_the_password_hash_itself():
    """has_password is a bool. The hash has no business on the object that
    templates render from."""
    user = User(
        {
            "user_id": 3,
            "name": "P",
            "email": "p@example.com",
            "role": "user",
            "password_hash": "pbkdf2:sha256:secret",
        }
    )
    assert "secret" not in repr(vars(user))
    assert not hasattr(user, "password_hash")


def test_forgot_password_reaches_an_account_that_has_no_password(app, client):
    """This route used to filter on password_hash IS NOT NULL, which shut out
    exactly the accounts with no other way in -- a Google-created user could
    not sign in with a password and could not use this route to set one."""
    import database

    email = "google-only-reset@example.com"
    with app.app_context():
        with database.get_conn() as (conn, cur):
            cur.execute("DELETE FROM users WHERE email = %s", (email,))
            cur.execute(
                "INSERT INTO users (name, email, role, password_hash) "
                "VALUES (%s, %s, %s, NULL)",
                ("Google Only", email, "user"),
            )
            conn.commit()

    # No SMTP configured is both the LAN reality and what makes this
    # observable: with MAIL_SERVER unset the route returns the reset link in
    # the response under TESTING instead of emailing it, so its presence is
    # what proves the account was found. The developer .env sets MAIL_SERVER,
    # which would otherwise send the mail and tell the test nothing.
    app.config["MAIL_SERVER"] = None

    try:
        response = client.post("/auth/api/forgot-password", json={"email": email})
        assert response.status_code == 200
        assert response.get_json().get("reset_url"), (
            "no reset link issued -- the account was filtered out"
        )
    finally:
        with app.app_context():
            with database.get_conn() as (conn, cur):
                cur.execute("DELETE FROM users WHERE email = %s", (email,))
                conn.commit()


def test_forgot_password_says_nothing_about_whether_an_account_exists(app, client):
    """Response for an unknown address must be indistinguishable from the
    one above, or this becomes an account-enumeration oracle. Same no-SMTP
    config as the test above, so the two are actually comparable."""
    app.config["MAIL_SERVER"] = None
    response = client.post(
        "/auth/api/forgot-password", json={"email": "nobody-here@example.com"}
    )
    assert response.status_code == 200
    assert not response.get_json().get("reset_url")
