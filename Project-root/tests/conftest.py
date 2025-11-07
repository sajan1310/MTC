import os
import sys

import pytest

# Add the project root to the Python path to allow for absolute imports
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app import create_app


@pytest.fixture
def app():
    """Create and configure a new app instance for each test using the factory."""
    flask_app = create_app("testing")
    flask_app.config.update(
        {
            "TESTING": True,
            "WTF_CSRF_ENABLED": False,
            "LOGIN_DISABLED": True,  # Disable login checks in tests to avoid 302 redirects
            "SECRET_KEY": "test-secret-key",
            "SERVER_NAME": "localhost.localdomain",  # Required for url_for with _external=True
            "RATELIMIT_STORAGE_URI": "memory://",  # Explicit memory storage for rate limiter
            # Test database configuration
            "DB_NAME": "testuser",  # Use testuser database for tests
            "DB_HOST": os.getenv("DB_HOST", "127.0.0.1"),
            "DB_USER": os.getenv("DB_USER", "postgres"),
            "DB_PASS": os.getenv("DB_PASS", "abcd"),
        }
    )
    yield flask_app


@pytest.fixture
def client(app):
    """A test client for the app."""
    return app.test_client()


@pytest.fixture
def authenticated_client(app):
    """
    Create an authenticated test client.
    
    Since LOGIN_DISABLED=True in test config, this client will bypass
    authentication checks automatically. This fixture is used for testing
    endpoints that would normally require authentication.
    """
    with app.test_client() as client:
        with app.app_context():
            # With LOGIN_DISABLED=True, no actual login is needed
            # The @login_required decorator will be bypassed
            yield client


@pytest.fixture
def runner(app):
    """A test runner for the app's Click commands."""
    return app.test_cli_runner()
