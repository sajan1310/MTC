"""
Application configuration classes for different environments.
"""
from dotenv import load_dotenv
import os

# Load environment variables from .env file
load_dotenv()
from datetime import timedelta

class Config:
    """Base configuration."""
    
    # Security
    SECRET_KEY = os.environ.get('SECRET_KEY')
    if not SECRET_KEY:
        raise ValueError(
            "SECRET_KEY must be set in the environment. "
            "It is used for session signing and security. "
            "You can generate a key with: python -c 'import secrets; print(secrets.token_hex(16))'"
        )
    
    # Database
    DB_HOST = os.environ.get('DB_HOST', '127.0.0.1')
    DB_NAME = os.environ.get('DB_NAME', 'MTC')
    DB_USER = os.environ.get('DB_USER', 'postgres')
    DB_PASS = os.environ.get('DB_PASS','abcd')

    # Google OAuth
    GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", None)
    GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", None)
    GOOGLE_DISCOVERY_URL = os.environ.get("GOOGLE_DISCOVERY_URL", "https://accounts.google.com/.well-known/openid-configuration")
    
    # ✅ OAUTH FIX: Warn if credentials are missing (moved session config to app.py to avoid circular import)
    if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
        import warnings
        warnings.warn(
            "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set. "
            "Google OAuth login will not work. Set these in your .env file."
        )
       
    # File Upload
    MAX_CONTENT_LENGTH = 16 * 1024 * 1024  # 16MB max upload
    UPLOAD_FOLDER = 'static/uploads'
    ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'webp'}
    
    # Server Name for URL generation
    BASE_URL = os.environ.get('BASE_URL', 'http://127.0.0.1:5000')
    SERVER_NAME = BASE_URL.replace('http://', '').replace('https://', '')

    # Cache busting version
    import time
    VERSION = str(int(time.time()))


class DevelopmentConfig(Config):
    """Development environment configuration."""
    DEBUG = True
    TESTING = False
    
    # Less strict in development
    SESSION_COOKIE_SECURE = False


class ProductionConfig(Config):
    """Production environment configuration."""
    DEBUG = False
    TESTING = False
    
    # Strict security in production
    SESSION_COOKIE_SECURE = True
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = 'Lax'


class TestingConfig(Config):
    """Testing environment configuration."""
    DEBUG = True
    TESTING = True
    
    # Use test database
    DB_NAME = 'MTC'


# Configuration dictionary
config = {
    'development': DevelopmentConfig,
    'production': ProductionConfig,
    'testing': TestingConfig,
    'default': DevelopmentConfig
}


def get_config():
    """Get configuration based on FLASK_ENV environment variable."""
    env = os.environ.get('FLASK_ENV', 'development')
    return config.get(env, config['default'])
