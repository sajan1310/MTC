"""Authentication and authorization decorators."""
from functools import wraps
from flask import jsonify, current_app
from flask_login import current_user

def role_required(role: str):
    """
    Decorator to require specific role for a route.
    
    Args:
        role: Required role ('admin', 'manager', 'user', etc.)
    
    Returns:
        Decorated function that checks user role before execution.
        Returns 401 if not authenticated, 403 if insufficient permissions.
    """
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            if not current_user.is_authenticated:
                current_app.logger.warning(f"[AUTH] Unauthenticated access attempt to {f.__name__}")
                return jsonify({
                    'success': False, 
                    'data': {}, 
                    'error': 'Authentication required'
                }), 401
            
            # Admin role has access to everything
            if current_user.role == 'admin':
                return f(*args, **kwargs)
            
            # Check if user has required role
            if current_user.role != role:
                current_app.logger.warning(
                    f"[AUTH] Insufficient permissions | "
                    f"user={current_user.email} | "
                    f"required={role} | "
                    f"actual={current_user.role}"
                )
                return jsonify({
                    'success': False, 
                    'data': {}, 
                    'error': 'Insufficient permissions'
                }), 403
            
            return f(*args, **kwargs)
        return decorated_function
    return decorator
