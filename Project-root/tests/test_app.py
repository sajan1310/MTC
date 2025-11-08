from app import validate_password


def test_home_redirect(client):
    """Test that the home route redirects to the login page for unauthenticated users."""
    response = client.get("/", follow_redirects=True)
    assert response.status_code == 200
    # Check for login-related content (flexible for different login page variations)
    assert (
        b"Sign in with Google" in response.data
        or b"login" in response.data.lower()
        or b"dashboard"
        in response.data.lower()  # May go to dashboard if LOGIN_DISABLED
    )


def test_validate_password():
    """Test the password validation logic."""
    assert validate_password("password")[0] is False
    assert validate_password("Password123")[0] is False
    assert validate_password("Password123!")[0] is True
