"""Authentication blueprint."""
# Note: auth_bp is defined in routes.py and imported here for backward compatibility
from .routes import auth_bp

__all__ = ['auth_bp']
