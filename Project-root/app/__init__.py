"""
Flask Application Factory and shared extensions.

create_app(config_name='production') builds and configures the Flask app.
Also re-exports commonly used utilities for backward compatibility.
"""
from __future__ import annotations
import os
import logging
from logging.handlers import RotatingFileHandler
from typing import Dict, Any

from flask import Flask
from flask_wtf import CSRFProtect
from flask_login import LoginManager
from flask_limiter.util import get_remote_address
from flask_limiter import Limiter
from werkzeug.middleware.proxy_fix import ProxyFix
from flask_cors import CORS
from flask import render_template, request, jsonify
from flask_wtf.csrf import CSRFError

# Shared extensions (init in create_app)
csrf = CSRFProtect()
login_manager = LoginManager()
limiter = Limiter(key_func=get_remote_address)

# Local imports inside functions to avoid circulars


def validate_password(password: str) -> tuple[bool, str]:
    """Strong password policy.
    - Min 8 chars, 1 upper, 1 lower, 1 digit, 1 special
    Returns (is_valid, message).
    """
    import re
    if len(password or "") < 8:
        return False, "Password must be at least 8 characters long"
    if not re.search(r"[A-Z]", password or ""):
        return False, "Password must contain at least one uppercase letter"
    if not re.search(r"[a-z]", password or ""):
        return False, "Password must contain at least one lowercase letter"
    if not re.search(r"[0-9]", password or ""):
        return False, "Password must contain at least one number"
    if not re.search(r"[!@#$%^&*()_\-+=\[\]{};:'\",.<>?/\\|`~]", password or ""):
        return False, "Password must contain at least one special character"
    return True, "Password is strong"


def _load_config(app: Flask, config_name: str) -> None:
    """Load configuration from config.py and environment.
    Supports development/testing/production. Validates critical keys.
    """
    from config import config as CONFIG_MAP  # type: ignore

    cfg_cls = CONFIG_MAP.get(config_name) or CONFIG_MAP.get('production')
    if cfg_cls is None:
        raise RuntimeError(f"Unknown config name: {config_name}")
    app.config.from_object(cfg_cls)

    # Allow overriding with env vars
    app.config.update({
        k: v for k, v in os.environ.items() if k in {
            'SECRET_KEY', 'DATABASE_URL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
            'RATELIMIT_STORAGE_URL', 'BASE_URL', 'SERVER_NAME'
        }
    })

    # Sensible defaults
    app.config.setdefault('RATELIMIT_STORAGE_URL', 'redis://localhost:6379/0')
    app.config.setdefault('PERMANENT_SESSION_LIFETIME', 86400)

    # Fail-fast validation in production
    missing: list[str] = []
    required = ['SECRET_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']
    # DATABASE_URL is recommended; allow existing legacy DB_* to pass for now
    if not (app.config.get('DATABASE_URL') or (app.config.get('DB_HOST') and app.config.get('DB_NAME') and app.config.get('DB_USER'))):
        missing.append('DATABASE_URL or DB_HOST/DB_NAME/DB_USER')
    for key in required:
        if not app.config.get(key):
            missing.append(key)

    if app.config.get('TESTING'):
        # Relax checks for tests
        missing = []

    if missing:
        raise RuntimeError(f"Missing required configuration keys: {', '.join(missing)}")


def _init_logging(app: Flask) -> None:
    level = logging.DEBUG if app.debug else logging.INFO
    app.logger.setLevel(level)
    if not app.debug:
        os.makedirs('logs', exist_ok=True)
        fh = RotatingFileHandler('logs/app.log', maxBytes=10_000_000, backupCount=10)
        fh.setFormatter(logging.Formatter('%(asctime)s %(levelname)s: %(message)s [in %(pathname)s:%(lineno)d]'))
        fh.setLevel(logging.INFO)
        app.logger.addHandler(fh)


def _register_error_handlers(app: Flask) -> None:
    @app.errorhandler(404)
    def not_found(_e):
        return render_template('404.html'), 404

    @app.errorhandler(500)
    def server_error(_e):
        return render_template('500.html'), 500

    @app.errorhandler(429)
    def ratelimit_handler(_e):
        return render_template('429.html'), 429

    @app.errorhandler(CSRFError)
    def handle_csrf_error(e):
        if request.path.startswith('/api/'):
            return jsonify({'error': e.description}), 400
        return render_template('500.html'), 400


def create_app(config_name: str | None = None) -> Flask:
    """Application Factory.

    Args:
        config_name: 'development' | 'testing' | 'production'. Defaults to env FLASK_ENV or 'production'.

    Returns:
        Configured Flask application instance.
    """
    config_name = config_name or os.getenv('FLASK_ENV', 'production')
    app = Flask(__name__, static_folder='../static', template_folder='../templates')

    # Proxy and basic security headers
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_port=1)

    # Load configuration and validate
    _load_config(app, config_name)

    # Initialize extensions
    csrf.init_app(app)
    login_manager.init_app(app)
    login_manager.login_view = 'auth.login'

    # Setup Redis-based rate limiting
    from redis import ConnectionPool, Redis
    from flask_limiter.util import get_remote_address
    from flask_limiter import Limiter
    import logging
    redis_url = app.config.get('RATELIMIT_STORAGE_URL', 'redis://localhost:6379/0')
    try:
        pool = ConnectionPool.from_url(redis_url, max_connections=50, decode_responses=True)
        redis_client = Redis(connection_pool=pool)
        # Test Redis connectivity
        redis_client.ping()
        limiter = Limiter(
            key_func=get_remote_address,
            storage_uri=redis_url,
            strategy="fixed-window",
        )
        limiter.init_app(app)
        app.logger.info("[RATE LIMIT] Redis-based rate limiting enabled.")
        # Clean up pool on shutdown
        @app.teardown_appcontext
        def close_redis_pool(exception=None):
            try:
                pool.disconnect()
                app.logger.info("[RATE LIMIT] Redis connection pool closed.")
            except Exception as e:
                app.logger.warning(f"[RATE LIMIT] Redis pool cleanup failed: {e}")
    except Exception as e:
        app.logger.warning(f"[RATE LIMIT] Redis unavailable, falling back to in-memory rate limiting: {e}")
        limiter = Limiter(key_func=get_remote_address)
        limiter.init_app(app)
    # Set defaults if not provided by config
    limiter.default_limits = ["200 per day", "50 per hour"]

    # Database
    import database
    database.init_app(app)

    # Security: cookies and session
    if not app.debug:
        app.config.update(
            SESSION_COOKIE_SECURE=True,
            SESSION_COOKIE_HTTPONLY=True,
            SESSION_COOKIE_SAMESITE='Strict',  # Enhanced CSRF protection
        )
    else:
        app.config.update(
            SESSION_COOKIE_HTTPONLY=True,
            SESSION_COOKIE_SAMESITE='Lax',
        )

    # CORS
    if app.debug:
        CORS(app, supports_credentials=True, origins=["http://127.0.0.1:5000"],
             allow_headers=["Content-Type", "X-CSRFToken"], methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"]) 
    else:
        CORS(app, supports_credentials=True, origins=[app.config.get('BASE_URL', 'https://yourdomain.com')],
             allow_headers=["Content-Type", "X-CSRFToken"], methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"]) 

    # Logging and URL scheme
    _init_logging(app)
    if app.config.get('BASE_URL', '').startswith('https://'):
        app.config['PREFERRED_URL_SCHEME'] = 'https'

    # Error handlers
    _register_error_handlers(app)

    # User loader
    from .models import User  # noqa: WPS433 local import
    import psycopg2.extras  # noqa

    @login_manager.user_loader
    def load_user(user_id: str):
        try:
            with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
                cur.execute("SELECT * FROM users WHERE user_id = %s", (user_id,))
                row = cur.fetchone()
                if row:
                    return User(row)
        except Exception as e:
            app.logger.error(f"Error loading user {user_id}: {e}")
        return None

    # Blueprints
    from .auth.routes import auth_bp
    from .api.routes import api_bp
    from .api.file_routes import files_bp
    from .main.routes import main_bp

    app.register_blueprint(auth_bp, url_prefix='/auth')
    app.register_blueprint(api_bp, url_prefix='/api')
    app.register_blueprint(files_bp)  # No prefix, uses /api/files routes
    app.register_blueprint(main_bp)

    # Exempt select auth JSON endpoints from CSRF
    try:
        csrf.exempt(app.view_functions['auth.api_login'])
        csrf.exempt(app.view_functions['auth.api_signup'])
        csrf.exempt(app.view_functions['auth.api_forgot_password'])
    except KeyError:
        pass
    
    # Also exempt compat routes that forward to auth endpoints
    try:
        csrf.exempt(app.view_functions['main.compat_api_login'])
        csrf.exempt(app.view_functions['main.compat_api_signup'])
        csrf.exempt(app.view_functions['main.compat_api_forgot_password'])
    except KeyError:
        pass

    # Compatibility: alias common endpoints without blueprint prefixes
    # This preserves templates using url_for('dashboard') etc.
    alias_map = {
        'home': 'main.home',
        'dashboard': 'main.dashboard',
        'inventory': 'main.inventory',
        'suppliers': 'main.suppliers',
        'purchase_orders': 'main.purchase_orders',
        'stock_ledger': 'main.stock_ledger',
        'master_data': 'main.master_data',
        'profile': 'main.profile',
        'user_management': 'main.user_management',
    }
    for alias, target in alias_map.items():
        if alias in app.view_functions:
            continue
        target_func = app.view_functions.get(target)
        if not target_func:
            continue
        # Find a representative rule for the target endpoint
        target_rule = next((r for r in app.url_map.iter_rules() if r.endpoint == target), None)
        if not target_rule:
            continue
        methods = sorted(list((target_rule.methods or set()) - {'HEAD', 'OPTIONS'})) or None
        try:
            app.add_url_rule(target_rule.rule, endpoint=alias, view_func=target_func, methods=methods)
        except Exception:
            # If adding the alias fails for any reason, skip silently
            pass

    # Route registry debug (optional)
    if app.debug:
        app.logger.info("Registered routes:")
        for rule in app.url_map.iter_rules():
            methods = ','.join(sorted(rule.methods - {'OPTIONS', 'HEAD'}))
            if methods:
                app.logger.info(f"{rule.endpoint:40} {methods:10} {rule.rule}")

    return app


# Backwards-compatible exports
from .utils import get_or_create_user  # re-export for backward compatibility in tests

__all__ = [
    'create_app',
    'validate_password',
    'get_or_create_user',
    'csrf', 'login_manager', 'limiter',
]
