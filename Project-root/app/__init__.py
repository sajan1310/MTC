"""
Flask Application Factory and shared extensions.

This module provides the :func:`create_app` application factory and
initializes shared extension objects without reassigning module-level
instances. Changes below fix a number of security and lifecycle issues:

- Use a single module-level `limiter` instance and configure it via
  `app.config` before calling `limiter.init_app(app)` (prevents accidental
  multiple instances).
- Apply `csrf.exempt()` to blueprints before registration where appropriate
  to avoid nested blueprint timing issues.
- Add database teardown to close DB connections on app context teardown.
- Make ProxyFix configuration driven by environment and conservative by
  default to avoid trusting proxy headers unless explicitly configured.
- Move all Flask imports to module level to avoid repeated imports in
  hot paths and potential performance issues.
- Improve logging configuration error handling in production (propagate
  fatal errors except ImportError).
- Record alias registration failures via `app.logger.debug()` instead of
  silently swallowing them.
- Add module-level deprecation warning cache to avoid unbounded growth.
"""

from __future__ import annotations

import logging
import os
from logging.handlers import RotatingFileHandler
from typing import Any

from flask import (
    Flask,
    jsonify,
    render_template,
    request,
    redirect,
    url_for,
    g,
)
from flask_cors import CORS
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from flask_login import LoginManager
from flask_wtf import CSRFProtect
from flask_wtf.csrf import CSRFError
from werkzeug.middleware.proxy_fix import ProxyFix

# Shared extension instances (do not reassign these later)
csrf = CSRFProtect()
login_manager = LoginManager()
# Module-level limiter instance; configure storage and defaults via app.config
# and call limiter.init_app(app) exactly once in create_app.
limiter = Limiter(key_func=get_remote_address)

# Module-level cache for deprecation warnings to avoid unbounded growth
# (warn once per unique path).
_DEPRECATION_WARNED: set[str] = set()


def validate_password(password: str) -> tuple[bool, str]:
    """Validate password strength.

    Maintains the previous behavior but keeps imports at module scope.
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

    Raises RuntimeError on missing required settings in non-testing modes.
    In testing mode, PHASE 1C also validates that test DB != production DB.
    """
    from config import config as CONFIG_MAP  # type: ignore

    cfg_cls = CONFIG_MAP.get(config_name) or CONFIG_MAP.get("production")
    if cfg_cls is None:
        raise RuntimeError(f"Unknown config name: {config_name}")
    
    # PHASE 1C: For TestingConfig, instantiate to trigger __init__ validation
    # that prevents test DB from being set to production DB name
    if config_name == "testing":
        cfg_instance = cfg_cls()  # Instantiate to trigger __init__ checks
        app.config.from_object(cfg_instance)
    else:
        app.config.from_object(cfg_cls)

    # Allow overriding a small set of critical keys from environment
    app.config.update(
        {k: v for k, v in os.environ.items() if k in {
            "SECRET_KEY",
            "DATABASE_URL",
            "GOOGLE_CLIENT_ID",
            "GOOGLE_CLIENT_SECRET",
            "RATELIMIT_STORAGE_URL",
            "BASE_URL",
            "SERVER_NAME",
        }}
    )

    app.config.setdefault("RATELIMIT_STORAGE_URL", "redis://localhost:6379/0")
    app.config.setdefault("RATELIMIT_STRATEGY", "fixed-window")
    app.config.setdefault("PERMANENT_SESSION_LIFETIME", 86400)

    # Fail-fast validation in production
    missing: list[str] = []
    required = ["SECRET_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]
    if not (
        app.config.get("DATABASE_URL")
        or (
            app.config.get("DB_HOST")
            and app.config.get("DB_NAME")
            and app.config.get("DB_USER")
        )
    ):
        missing.append("DATABASE_URL or DB_HOST/DB_NAME/DB_USER")
    for key in required:
        if not app.config.get(key):
            missing.append(key)

    if app.config.get("TESTING"):
        missing = []

    if missing:
        raise RuntimeError(f"Missing required configuration keys: {', '.join(missing)}")


def _init_logging(app: Flask) -> None:
    """Initialize logging handlers; allow ImportError to be handled but do not
    silently swallow configuration errors in production.

    Previously this function swallowed any exception which could hide
    misconfigurations. We now only catch ImportError for optional logging
    modules and re-raise other exceptions in production so outages are
    visible.
    """
    level = logging.DEBUG if app.debug else logging.INFO
    app.logger.setLevel(level)

    formatter = logging.Formatter(
        "%(asctime)s %(levelname)s: %(message)s [in %(pathname)s:%(lineno)d]"
    )

    import sys

    sh = logging.StreamHandler(stream=sys.stdout)
    sh.setFormatter(formatter)
    sh.setLevel(level)

    root_logger = logging.getLogger()
    werk_logger = logging.getLogger("werkzeug")

    root_has_stream = any(isinstance(h, logging.StreamHandler) for h in root_logger.handlers)
    werk_has_stream = any(isinstance(h, logging.StreamHandler) for h in werk_logger.handlers)
    app_has_stream = any(isinstance(h, logging.StreamHandler) for h in app.logger.handlers)
    if not app_has_stream and not (root_has_stream or werk_has_stream):
        app.logger.addHandler(sh)
    if not root_has_stream:
        root_logger.addHandler(sh)
    if not werk_has_stream:
        werk_logger.addHandler(sh)

    os.makedirs("logs", exist_ok=True)
    fh = RotatingFileHandler("logs/app.log", maxBytes=10_000_000, backupCount=10)
    fh.setFormatter(formatter)
    fh.setLevel(logging.INFO)

    file_on_app = any(
        isinstance(h, RotatingFileHandler) and getattr(h, "baseFilename", "").endswith("logs/app.log")
        for h in app.logger.handlers
    )
    file_on_root = any(
        isinstance(h, RotatingFileHandler) and getattr(h, "baseFilename", "").endswith("logs/app.log")
        for h in root_logger.handlers
    )

    if not (file_on_app or file_on_root):
        root_logger.addHandler(fh)


def _register_error_handlers(app: Flask) -> None:
    @app.errorhandler(404)
    def not_found(_e):
        return render_template("404.html"), 404

    @app.errorhandler(500)
    def server_error(_e):
        return render_template("500.html"), 500

    @app.errorhandler(429)
    def ratelimit_handler(_e):
        return render_template("429.html"), 429

    @app.errorhandler(CSRFError)
    def handle_csrf_error(e):
        if request.path.startswith("/api/"):
            return jsonify({"error": e.description}), 400
        return render_template("500.html"), 400


def _parse_proxy_fix() -> dict[str, int]:
    """Parse PROXY_FIX env var into kwargs for ProxyFix.

    Expected format: "x_for=1,x_proto=1". Values default to 0 for safety.
    """
    raw = os.getenv("PROXY_FIX", "")
    result: dict[str, int] = {"x_for": 0, "x_proto": 0, "x_host": 0, "x_port": 0}
    if not raw:
        # Conservative default: do not trust proxy headers unless explicitly configured
        return result
    for part in raw.split(","):
        if "=" not in part:
            continue
        k, v = part.split("=", 1)
        k = k.strip()
        try:
            iv = int(v)
        except Exception:
            continue
        if k in result:
            result[k] = max(0, min(255, iv))
    return result


def create_app(config_name: str | None = None) -> Flask:
    """Application Factory.

    Builds and configures the Flask app. The function ensures shared
    extensions are initialized exactly once and critical lifecycle hooks are
    registered.
    """
    config_name = config_name or os.getenv("FLASK_ENV", "production")
    app = Flask(__name__, static_folder="../static", template_folder="../templates")

    # Configure ProxyFix conservatively based on environment variable
    proxy_kwargs = _parse_proxy_fix()
    if any(v for v in proxy_kwargs.values()):
        app.wsgi_app = ProxyFix(app.wsgi_app, **proxy_kwargs)

    # Load configuration and validate
    _load_config(app, config_name)

    # Initialize extensions (use module-level instances; don't reassign)
    csrf.init_app(app)
    login_manager.init_app(app)
    login_manager.login_view = "auth.login"

    # Configure rate limiter via app.config before init_app
    # Keep defaults in a config key so we don't reassign limiter objects
    app.config.setdefault("RATELIMIT_STORAGE_URL", app.config.get("RATELIMIT_STORAGE_URL"))
    app.config.setdefault("RATELIMIT_STRATEGY", app.config.get("RATELIMIT_STRATEGY", "fixed-window"))
    # Set default limits via config so limiter picks them up on init.
    # Use a comma-separated string by default because some config loaders
    # may coerce lists to strings; we also normalise any list/tuple values
    # into the internal structure expected by flask-limiter after init.
    app.config.setdefault("RATELIMIT_DEFAULT", "200 per day,50 per hour")

    # Attempt to validate Redis connectivity if a non-memory store is configured
    # PHASE 1B: Harden rate limiter - in production, fail-fast if Redis is misconfigured
    storage = str(app.config.get("RATELIMIT_STORAGE_URL", "")).strip()
    is_production = config_name == "production" or app.config.get("ENV") == "production"
    
    if storage and not storage.startswith("memory://"):
        try:
            from redis import Redis, ConnectionPool  # type: ignore

            pool = ConnectionPool.from_url(storage, max_connections=50, decode_responses=True,
                                            socket_connect_timeout=1, socket_timeout=1)
            client = Redis(connection_pool=pool)
            client.ping()
            # Store pool on app so we can close it in teardown
            app.extensions["ratelimit_redis_pool"] = pool
            app.logger.info("[RATE LIMIT] Redis connectivity validated; rate limiter using Redis backend.")
        except ImportError:
            # Optional dependency missing
            if is_production:
                raise RuntimeError(
                    "FATAL: redis package required for production rate limiting but not installed. "
                    "Install redis package or set RATELIMIT_STORAGE_URL=memory:// to fallback (not recommended for production)."
                )
            app.logger.warning("[RATE LIMIT] redis package not installed; falling back to in-memory rate limit (development only)")
            app.config["RATELIMIT_STORAGE_URL"] = "memory://"
        except Exception as e:
            # Connection failed
            if is_production:
                raise RuntimeError(
                    f"FATAL: Redis rate limiter backend unreachable in production: {e}. "
                    f"Verify RATELIMIT_STORAGE_URL={storage} is correct and Redis is running."
                )
            app.logger.warning("[RATE LIMIT] Redis unavailable in development, falling back to in-memory: %s", e)
            app.config["RATELIMIT_STORAGE_URL"] = "memory://"

    # Initialize limiter with the configured app-level settings (single instance)
    limiter.init_app(app)

    # Normalise RATELIMIT_DEFAULT into the internal form expected by
    # flask-limiter to avoid parse errors. The manager expects an iterable
    # of iterables (e.g., (('200 per day', '50 per hour'),)). App config
    # values may arrive as lists, tuples, comma-separated strings, or even
    # stringified Python lists ("['a','b']"). We handle common forms here
    # and set limiter._default_limits explicitly to avoid runtime parsing
    # errors during requests.
    try:
        raw_default = app.config.get("RATELIMIT_DEFAULT")
        # If someone set a Python-list-like string ("['a','b']"), try to parse it safely
        if isinstance(raw_default, str):
            import ast

            parsed = None
            try:
                parsed = ast.literal_eval(raw_default)
            except Exception:
                parsed = None

            if isinstance(parsed, (list, tuple)):
                limiter._default_limits = tuple((str(item),) for item in parsed)
            else:
                # If it's a comma-separated string, let the extension parse it;
                # but ensure manager._default_limits is a safe iterable-of-iterables
                if "," in raw_default and not getattr(limiter, "_default_limits", None):
                    # leave string in app.config and let extension parse when needed
                    pass
        elif isinstance(raw_default, (list, tuple)):
            limiter._default_limits = tuple((str(item),) for item in raw_default)
    except Exception:
        app.logger.debug("Failed to normalise RATELIMIT_DEFAULT", exc_info=True)

    # Database initialization
    import database

    database.init_app(app)

    # Ensure session cookie security defaults
    if not app.debug:
        app.config.update(
            SESSION_COOKIE_SECURE=True,
            SESSION_COOKIE_HTTPONLY=True,
            SESSION_COOKIE_SAMESITE="Strict",
        )
    else:
        app.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax")

    # CORS: restrict to development origins when in debug
    if app.debug:
        CORS(app, supports_credentials=True, origins=["http://127.0.0.1:5000"],
             allow_headers=["Content-Type", "X-CSRFToken"],
             methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"])
    else:
        CORS(app, supports_credentials=True, origins=[app.config.get("BASE_URL", "https://yourdomain.com")],
             allow_headers=["Content-Type", "X-CSRFToken"],
             methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"])

    # Logging: prefer production logging config but don't silently swallow errors
    if config_name == "production" or app.config.get("ENV") == "production":
        try:
            import logging_config

            logging_config.setup_logging(app)
            # These helpers may raise if misconfigured; let them surface so ops
            # can fix configuration rather than failing silently.
            logging_config.log_request_info(app)
            logging_config.log_errors(app)
        except ImportError as e:
            # Optional structured logging package missing: fallback safe handler
            app.logger.warning("Optional production logging package missing: %s", e)
        except Exception:
            # In production, propagate logging configuration errors to surface
            # problems to the operator instead of hiding them.
            raise

    # Local logging handlers
    _init_logging(app)

    if app.config.get("BASE_URL", "").startswith("https://"):
        app.config["PREFERRED_URL_SCHEME"] = "https"

    # Request ID middleware (optional)
    if not app.config.get("DISABLE_REQUEST_ID_MIDDLEWARE"):
        try:
            from app.middleware import setup_request_id_middleware

            setup_request_id_middleware(app)
        except Exception:
            app.logger.exception("Failed to initialize request id middleware")

    # Error handlers
    _register_error_handlers(app)

    # User loader (keep import at module-level where possible for performance)
    import psycopg2.extras  # noqa: E402
    from .models import User  # noqa: E402

    @login_manager.user_loader
    def load_user(user_id: str):
        try:
            with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
                cur.execute("SELECT * FROM users WHERE user_id = %s", (user_id,))
                row = cur.fetchone()
                if row:
                    return User(row)
        except Exception as e:
            app.logger.error("Error loading user %s: %s", user_id, e)
        return None

    # Blueprints: import first so we can apply CSRF exemptions before register
    from .api import api_bp
    from .api.file_routes import files_bp
    from .api.process_management import process_api_bp
    from .api.reports import reports_api_bp
    from .api.production_lot import production_api_bp
    from .api.subprocess_management import subprocess_api_bp
    from .api.variant_management import variant_api_bp
    from .api.inventory_alerts import inventory_alerts_bp
    from .auth.routes import auth_bp
    from .main.routes import main_bp

    # PHASE 1: Re-enable CSRF protection by removing blanket blueprint exemptions.
    # Instead, only exempt specific webhook endpoints that require it.
    # JSON API endpoints are protected via CORS + origin validation in production.
    # No blueprints are exempt; individual view functions are exempted as needed below.

    # Now register blueprints
    app.register_blueprint(auth_bp, url_prefix="/auth")
    app.register_blueprint(api_bp)
    app.register_blueprint(files_bp)
    app.register_blueprint(main_bp)

    app.register_blueprint(process_api_bp, url_prefix="/api/upf")
    app.register_blueprint(reports_api_bp, url_prefix="/api/upf")
    app.register_blueprint(variant_api_bp, url_prefix="/api/upf")
    app.register_blueprint(production_api_bp, url_prefix="/api/upf")
    app.register_blueprint(subprocess_api_bp, url_prefix="/api/upf")
    app.register_blueprint(inventory_alerts_bp, url_prefix="/api/upf")

    app.logger.info("Universal Process Framework API blueprints registered and CSRF exemptions applied where configured")

    # If specific view function names need exemption but are only available
    # after registration, we try to exempt them but log missing keys.
    # Only exempt explicit endpoints that require CSRF exemption:
    # - JSON login/signup/forgot-password endpoints (for API clients without session)
    # - External webhook endpoints (if any exist)
    for view_name in ("auth.api_login", "auth.api_signup", "auth.api_forgot_password",
                      "main.compat_api_login", "main.compat_api_signup", "main.compat_api_forgot_password"):
        try:
            func = app.view_functions.get(view_name)
            if func:
                csrf.exempt(func)
                app.logger.debug("CSRF exemption applied to view: %s (authenticated API endpoint)", view_name)
        except Exception as e:
            app.logger.debug("Failed to exempt view %s from CSRF: %s", view_name, e)

    # Compatibility aliases: add URL rules but log any failures for debugging
    alias_map = {
        "home": "main.home",
        "dashboard": "main.dashboard",
        "inventory": "main.inventory",
        "suppliers": "main.suppliers",
        "purchase_orders": "main.purchase_orders",
        "stock_ledger": "main.stock_ledger",
        "master_data": "main.master_data",
        "profile": "main.profile",
        "user_management": "main.user_management",
    }
    for alias, target in alias_map.items():
        if alias in app.view_functions:
            continue
        target_func = app.view_functions.get(target)
        if not target_func:
            continue
        target_rule = next((r for r in app.url_map.iter_rules() if r.endpoint == target), None)
        if not target_rule:
            continue
        methods = (sorted(list((target_rule.methods or set()) - {"HEAD", "OPTIONS"})) or None)
        try:
            app.add_url_rule(target_rule.rule, endpoint=alias, view_func=target_func, methods=methods)
        except Exception as e:
            # Log failure reason for easier debugging rather than failing silently
            app.logger.debug("Failed to add alias %s -> %s: %s", alias, target, e)

    # Route registry debug (optional)
    if app.debug:
        app.logger.info("Registered routes:")
        for rule in app.url_map.iter_rules():
            methods = ",".join(sorted(rule.methods - {"OPTIONS", "HEAD"}))
            if methods:
                app.logger.info(f"{rule.endpoint:40} {methods:10} {rule.rule}")

    # Compatibility middleware: warn when clients call underscore-style API paths
    @app.before_request
    def _underscore_api_deprecation_check():
        from .middleware.error_handling import request_id_middleware
        
        # PHASE 5: Initialize request ID middleware for tracking
        request_id_middleware()
        
        path = request.path or ""
        if path.startswith("/api/") and "_" in path:
            if path in _DEPRECATION_WARNED:
                return
            suggested = path.replace("_", "-")
            app.logger.warning("Deprecated API path used: %s — prefer %s (hyphenated).", path, suggested)
            _DEPRECATION_WARNED.add(path)
            # Store suggestion to attach to the response later
            g._api_deprecation_suggestion = suggested

    @app.after_request
    def _attach_deprecation_header(response):
        from .middleware.error_handling import log_response_handler
        
        try:
            suggestion = getattr(g, "_api_deprecation_suggestion", None)
            if suggestion and response.status_code < 400:
                response.headers.setdefault("X-API-Deprecation", suggestion)
        except Exception:
            app.logger.debug("Error attaching deprecation header", exc_info=True)
        
        # PHASE 5: Log response with request tracking
        return log_response_handler()(response)

    # Teardown handlers: ensure DB and redis pools are closed
    @app.teardown_appcontext
    def _close_db_and_pools(exception: Any = None) -> None:
        # Be defensive: teardown should never raise to the caller. Probe the
        # `database` module for common cleanup APIs and call whichever exists.
        try:
            db_cleanup_candidates = (
                "close_connection",
                "close_pool",
                "close",
                "shutdown",
                "dispose",
                "teardown",
            )
            for name in db_cleanup_candidates:
                fn = getattr(database, name, None)
                if callable(fn):
                    try:
                        fn()
                        app.logger.info("Database cleanup: called %s()", name)
                    except Exception:
                        app.logger.debug("Database cleanup %s() raised", name, exc_info=True)
                    break
            else:
                # No known cleanup function found; try to close a connection pool
                pool_obj = getattr(database, "pool", None)
                if pool_obj is not None:
                    try:
                        close_fn = getattr(pool_obj, "close", None) or getattr(pool_obj, "disconnect", None)
                        if callable(close_fn):
                            close_fn()
                            app.logger.info("Database pool closed via pool.close()/disconnect().")
                    except Exception:
                        app.logger.debug("Database pool cleanup failed", exc_info=True)

            # Close redis pool if we created one during init; be permissive about API
            pool = app.extensions.get("ratelimit_redis_pool")
            if pool is not None:
                try:
                    # ConnectionPool from redis-py exposes disconnect()
                    if hasattr(pool, "disconnect") and callable(getattr(pool, "disconnect")):
                        pool.disconnect()
                        app.logger.info("[RATE LIMIT] Redis connection pool disconnected.")
                    # aioredis or other clients may provide close()
                    elif hasattr(pool, "close") and callable(getattr(pool, "close")):
                        pool.close()
                        app.logger.info("[RATE LIMIT] Redis pool closed via close().")
                except Exception:
                    app.logger.warning("[RATE LIMIT] Redis pool cleanup failed", exc_info=True)
        except Exception:
            # Teardown must not propagate errors to the WSGI server
            app.logger.debug("Error during teardown_appcontext", exc_info=True)

    # Production debug mode sanity check: do not allow app.debug in production
    if (config_name == "production" or app.config.get("ENV") == "production") and app.debug:
        raise RuntimeError("Application running with debug=True in production environment")

    return app


# Backwards-compatible exports
from .utils import get_or_create_user  # re-export for backward compatibility in tests
from .utils.response import APIResponse  # ensure response utility is imported and available

__all__ = [
    "create_app",
    "validate_password",
    "get_or_create_user",
    "APIResponse",
    "csrf",
    "login_manager",
    "limiter",
]
