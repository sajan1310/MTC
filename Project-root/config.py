"""
Environment-specific configuration for the Flask app.

Includes Base (Config), Development, Testing, and Production classes.
Provides sensible defaults and environment-variable overrides.
"""

from __future__ import annotations

import os
from urllib.parse import urlparse

from dotenv import load_dotenv

# Load .env if present
load_dotenv()


class Config:
    """Base configuration shared by all environments."""

    # Security
    SECRET_KEY = os.getenv("SECRET_KEY") or "dev-insecure-key"

    # OAuth
    GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID")
    GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET")
    GOOGLE_DISCOVERY_URL = os.getenv(
        "GOOGLE_DISCOVERY_URL",
        "https://accounts.google.com/.well-known/openid-configuration",
    )

    # Rate limiting storage (Redis by default)
    RATELIMIT_STORAGE_URL = os.getenv(
        "RATELIMIT_STORAGE_URL", "redis://localhost:6379/0"
    )
    # Example: 'redis://:password@localhost:6379/0?max_connections=50&decode_responses=True'

    # File Upload
    MAX_CONTENT_LENGTH = 16 * 1024 * 1024  # 16MB
    UPLOAD_FOLDER = "static/uploads"
    ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "gif", "webp"}

    # URL generation and base
    BASE_URL = os.getenv("BASE_URL", "http://127.0.0.1:5000")
    SERVER_NAME = os.getenv("SERVER_NAME") or BASE_URL.replace("http://", "").replace(
        "https://", ""
    )

    # Session lifetime
    PERMANENT_SESSION_LIFETIME = int(os.getenv("PERMANENT_SESSION_LIFETIME", 86400))

    # Database
    DATABASE_URL = os.getenv("DATABASE_URL")
    # Legacy fields for existing database.py helper
    DB_HOST = os.getenv("DB_HOST", "127.0.0.1")
    DB_NAME = os.getenv("DB_NAME", "MTC")
    DB_USER = os.getenv("DB_USER", "postgres")
    DB_PASS = os.getenv("DB_PASS", "abcd")

    # Connection pool tuning
    DB_POOL_MIN = int(os.getenv("DB_POOL_MIN", 2))
    DB_POOL_MAX = int(os.getenv("DB_POOL_MAX", 20))
    DB_CONNECT_TIMEOUT = int(os.getenv("DB_CONNECT_TIMEOUT", 10))
    DB_STATEMENT_TIMEOUT = int(os.getenv("DB_STATEMENT_TIMEOUT", 60000))

    # Import configuration
    IMPORT_BATCH_SIZE = int(os.getenv("IMPORT_BATCH_SIZE", 1000))
    IMPORT_MAX_ROWS = int(os.getenv("IMPORT_MAX_ROWS", 50000))
    IMPORT_TIMEOUT_SECONDS = int(os.getenv("IMPORT_TIMEOUT_SECONDS", 600))
    IMPORT_BACKGROUND_THRESHOLD = int(os.getenv("IMPORT_BACKGROUND_THRESHOLD", 1000))

    # Redis configuration for progress tracking
    REDIS_PROGRESS_EXPIRY = int(os.getenv("REDIS_PROGRESS_EXPIRY", 86400))  # 24 hours

    # Cache busting version
    import time as _time

    VERSION = str(int(_time.time()))

    @staticmethod
    def apply_database_url(cfg: "Config") -> None:
        """If DATABASE_URL is set, parse it into legacy DB_* fields for compatibility."""
        url = cfg.DATABASE_URL
        if not url:
            return
        parsed = urlparse(url)
        if parsed.scheme.startswith("postgres"):
            cfg.DB_HOST = parsed.hostname or cfg.DB_HOST
            cfg.DB_USER = parsed.username or cfg.DB_USER
            cfg.DB_PASS = parsed.password or cfg.DB_PASS
            cfg.DB_NAME = (parsed.path or "").lstrip("/") or cfg.DB_NAME


class DevelopmentConfig(Config):
    DEBUG = True
    TESTING = False
    SESSION_COOKIE_SECURE = False


class TestingConfig(Config):
    DEBUG = False
    TESTING = True
    # Relax requirements for tests; external DB may be mocked/available in CI
    SESSION_COOKIE_SECURE = False
    # Use memory storage for rate limiter in tests to avoid Redis warning
    RATELIMIT_STORAGE_URL = "memory://"
    
    # Test database configuration - use testuser database
    # Can be overridden by environment variables or conftest.py
    DB_NAME = os.getenv("TEST_DB_NAME", "testuser")
    DB_HOST = os.getenv("TEST_DB_HOST", os.getenv("DB_HOST", "127.0.0.1"))
    DB_USER = os.getenv("TEST_DB_USER", os.getenv("DB_USER", "postgres"))
    DB_PASS = os.getenv("TEST_DB_PASS", os.getenv("DB_PASS", "abcd"))


class ProductionConfig(Config):
    DEBUG = False
    TESTING = False
    SESSION_COOKIE_SECURE = True
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"


# Configuration mapping
config = {
    "development": DevelopmentConfig,
    "testing": TestingConfig,
    "production": ProductionConfig,
    "default": ProductionConfig,
}


def get_config():
    """Compatibility helper: return config class based on FLASK_ENV."""
    env = os.getenv("FLASK_ENV", "production")
    cls = config.get(env, config["default"])
    # Apply DATABASE_URL parsing side-effect for legacy DB_* usage
    cls.apply_database_url(cls)
    return cls
