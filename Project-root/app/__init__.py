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
import shutil
from logging.handlers import RotatingFileHandler
from typing import Any

from flask import (
    Flask,
    jsonify,
    redirect,
    render_template,
    request,
    url_for,
    g,
)
from flask_cors import CORS
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from flask_login import LoginManager
from flask_mail import Mail
from flask_talisman import Talisman
from flask_wtf import CSRFProtect
from flask_wtf.csrf import CSRFError
from werkzeug.middleware.proxy_fix import ProxyFix

# Shared extension instances (do not reassign these later)
csrf = CSRFProtect()
login_manager = LoginManager()
mail = Mail()
# Module-level limiter instance; configure storage and defaults via app.config
# and call limiter.init_app(app) exactly once in create_app.
limiter = Limiter(key_func=get_remote_address)

# Module-level cache for deprecation warnings to avoid unbounded growth
# (warn once per unique path).
_DEPRECATION_WARNED: set[str] = set()


class _SafeRotatingFileHandler(RotatingFileHandler):
    """RotatingFileHandler that tolerates Windows rename-lock failures.

    On Windows, os.rename() (used by doRollover) raises PermissionError if
    another process -- OneDrive/Dropbox syncing the log, a lingering dev
    server from a previous run, another gunicorn/waitress worker -- has the
    file open. Left uncaught, that turns into an unlogged, unrecoverable
    error on every subsequent emit() once the file is past maxBytes,
    flooding stderr with a traceback per log line.

    Simply skipping the failed rotation avoids that flood but silently
    surrenders the size cap: nothing else ever shrinks this file, so
    maxBytes/backupCount stop meaning anything and the log grows without
    bound. That is not hypothetical -- this project lives inside a OneDrive
    folder, which holds the log open to sync it, so the rename fails on
    essentially every attempt. Observed in practice at 1.06 GB against a
    configured 10 MB cap.

    So a failed rename now falls back to copy-then-truncate: stream the
    current contents into the .1 backup, then truncate the original IN
    PLACE. Truncating never renames, never re-creates and never moves the
    inode, so it succeeds against exactly the shared-read lock that defeats
    os.rename, and any other process holding the file open (including our
    own reopened stream) keeps writing to it afterwards. The cap is
    enforced and the content is preserved.

    Both paths are still wrapped: if even the fallback fails, skipping this
    rollover and retrying on the next record remains better than raising
    per log line.
    """

    def doRollover(self) -> None:
        try:
            super().doRollover()
            return
        except OSError:
            pass

        try:
            # super() closes the stream before its first rename, but it can
            # also fail before reaching that point -- close defensively so
            # the copy below reads a fully flushed file either way.
            if self.stream:
                self.stream.close()
                self.stream = None

            if self.backupCount > 0:
                dfn = self.rotation_filename(self.baseFilename + ".1")
                with open(self.baseFilename, "rb") as src, open(dfn, "wb") as dst:
                    shutil.copyfileobj(src, dst)

            with open(self.baseFilename, "r+b") as f:
                f.truncate(0)
        except OSError:
            pass
        finally:
            # FileHandler.emit reopens a None stream on its own, but doing it
            # here keeps the handler in the same state a successful rollover
            # would have left it in.
            if not self.delay and self.stream is None:
                try:
                    self.stream = self._open()
                except OSError:
                    pass


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

    # Allow overriding a small set of critical keys from environment.
    # DATABASE_URL is deliberately excluded under "testing": TestingConfig
    # above sets DATABASE_URL=None specifically so its own DB_HOST/DB_NAME/
    # DB_USER/DB_PASS (test DB) win in database.py's connection logic --
    # reapplying os.environ["DATABASE_URL"] here would silently clobber
    # that back to whatever DATABASE_URL resolves to in the environment
    # (typically the real database via .env), which is exactly how a full
    # test run ended up writing ~180 test-fixture rows into production.
    override_keys = {
        "SECRET_KEY",
        "DATABASE_URL",
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
        "RATELIMIT_STORAGE_URL",
        "BASE_URL",
        "SERVER_NAME",
    }
    if config_name == "testing":
        override_keys.discard("DATABASE_URL")
    app.config.update(
        {k: v for k, v in os.environ.items() if k in override_keys}
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

    # Compared as a resolved path, not with .endswith("logs/app.log"):
    # logging absolutises baseFilename, so on Windows it reads
    # ...\\Project-root\\logs\\app.log -- backslashes, which that suffix can
    # never match. The guard was therefore always False and every
    # create_app() added ANOTHER handler to the (process-global) root
    # logger. One app per process hides it; a pytest session building ~150
    # apps in one process writes every log line ~150 times, which is what
    # turned this file into a multi-gigabyte one. normcase covers Windows
    # being case-insensitive about paths.
    log_path = os.path.normcase(os.path.abspath(os.path.join("logs", "app.log")))

    def _writes_to_log_file(handler) -> bool:
        base = getattr(handler, "baseFilename", None)
        return (
            isinstance(handler, RotatingFileHandler)
            and base is not None
            and os.path.normcase(os.path.abspath(base)) == log_path
        )

    file_on_app = any(_writes_to_log_file(h) for h in app.logger.handlers)
    file_on_root = any(_writes_to_log_file(h) for h in root_logger.handlers)

    if not (file_on_app or file_on_root):
        fh = _SafeRotatingFileHandler(log_path, maxBytes=10_000_000, backupCount=10)
        fh.setFormatter(formatter)
        fh.setLevel(logging.INFO)
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
            return jsonify({"success": False, "message": f"CSRF error: {e.description}", "error": e.description}), 400
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
    mail.init_app(app)

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

    # Security headers (CSP/HSTS/X-Frame-Options/etc). Skipped under TESTING:
    # force_https redirects every plain-http request (the test client's
    # default), which would 302 every single test instead of hitting the
    # view.
    #
    # force_https/HSTS/secure-cookies are gated on BASE_URL actually being
    # https://, not on app.debug: this app has several ways to start it
    # (flask run, run_production.py, wsgi.py, python app.py) that don't all
    # reliably land on DevelopmentConfig's DEBUG=True, and Talisman only
    # auto-skips force_https when app.debug is True -- gating on app.debug
    # alone force-redirected plain http://127.0.0.1:5000 to a https:// port
    # nothing is listening on, breaking local access entirely the first
    # time this shipped. BASE_URL's scheme is the one signal this app
    # already uses elsewhere (PREFERRED_URL_SCHEME below) to mean "this
    # deployment is actually fronted by TLS".
    serve_over_https = app.config.get("BASE_URL", "").startswith("https://")
    # Kept so /health below can opt out of force_https per-view; None under
    # TESTING, where Talisman is never constructed.
    talisman = None
    if not app.config.get("TESTING"):
        csp = {
            "default-src": "'self'",
            "object-src": "'none'",
            "base-uri": "'self'",
            "frame-ancestors": "'self'",
            "manifest-src": "'self'",
            "worker-src": "'self'",
            # 'unsafe-inline' is required by the inline <script>/<style>
            # blocks in templates/erp/index.html and the auth pages; the
            # CDN hosts are the third-party libs static/erp/*.js loads
            # (jQuery, Bootstrap, Select2, Chart.js, SheetJS).
            #
            # cdnjs.cloudflare.com was dropped with html2pdf.js itself: PDF
            # export is the browser's own print engine and loads no library
            # to static/erp/vendor/ -- it was that host's only use, and 'self'
            # now covers it. Do not re-add a CDN host without also adding an
            # SRI hash at the call site (see PDF-003).
            "script-src": [
                "'self'",
                "'unsafe-inline'",
                "https://code.jquery.com",
                "https://cdn.jsdelivr.net",
            ],
            "style-src": [
                "'self'",
                "'unsafe-inline'",
                "https://cdn.jsdelivr.net",
                "https://fonts.googleapis.com",
            ],
            # cdn.jsdelivr.net is required here too, not just script/style-src:
            # Bootstrap Icons (<i class="bi bi-*">) is an icon *font* whose
            # CSS and .woff2 file are both served from that same CDN --
            # without it every "bi bi-*" glyph silently renders blank.
            "font-src": ["'self'", "https://fonts.gstatic.com", "https://cdn.jsdelivr.net", "data:"],
            "img-src": ["'self'", "data:", "https:"],
            "connect-src": ["'self'", "https://cdn.jsdelivr.net"],
        }
        talisman = Talisman(
            app,
            content_security_policy=csp,
            frame_options="SAMEORIGIN",
            force_https=serve_over_https,
            session_cookie_secure=serve_over_https,
            session_cookie_http_only=True,
            session_cookie_samesite="Strict" if not app.debug else "Lax",
            strict_transport_security=serve_over_https,
        )

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
    from .auth.routes import DEMO_USER_ID, build_demo_user  # noqa: E402

    @login_manager.user_loader
    def load_user(user_id: str):
        # The demo account (api_login()'s dev/test fallback) has no row in
        # `users` -- it must be reconstructed here rather than queried, or
        # the session silently drops it on every request after login.
        if (app.debug or app.config.get("TESTING")) and user_id == str(DEMO_USER_ID):
            return build_demo_user()
        try:
            with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
                # deleted_at IS NULL: a deactivated user (users_service.py's
                # deactivateUser) must not keep an existing session alive --
                # otherwise "deactivate" only blocked future logins, not the
                # session already in the browser.
                cur.execute("SELECT * FROM users WHERE user_id = %s AND deleted_at IS NULL", (user_id,))
                row = cur.fetchone()
                if row:
                    return User(row)
        except Exception as e:
            app.logger.error("Error loading user %s: %s", user_id, e)
        return None

    # Blueprints: import first so we can apply CSRF exemptions before register
    from .auth.routes import auth_bp
    from .erp import erp_bp, erp_rpc_bp

    # PHASE 1: Re-enable CSRF protection by removing blanket blueprint exemptions.
    # Instead, only exempt specific webhook endpoints that require it.
    # JSON API endpoints are protected via CORS + origin validation in production.
    # No blueprints are exempt; individual view functions are exempted as needed below.

    # ERP is the only UI this app serves; "/" and "/dashboard" redirect into it.
    app.register_blueprint(auth_bp, url_prefix="/auth")
    app.register_blueprint(erp_bp)
    app.register_blueprint(erp_rpc_bp, url_prefix="/api/erp")
    limiter.exempt(erp_rpc_bp)

    # Say once, at boot, whether Download PDF can produce a file here. Without
    # it the only signal is a 503 on somebody's first export, and the client
    # falls back to the print dialog silently -- so bulk export as separate
    # files is simply absent and nobody finds out why.
    if not app.config.get("TESTING"):
        try:
            from .erp.services.pdf_render_service import log_availability

            log_availability(app.logger)
        except Exception as exc:  # never let a diagnostic stop the app booting
            app.logger.debug("[PDF] availability check skipped: %s", exc)

    def _erp_home_redirect():
        return redirect(url_for("erp.index"))

    # auth's post-login redirects and the error-page templates reference
    # these endpoint names directly, so they stay registered even though
    # main_bp itself no longer exists.
    app.add_url_rule("/", endpoint="main.home", view_func=_erp_home_redirect)
    app.add_url_rule(
        "/dashboard", endpoint="main.dashboard", view_func=_erp_home_redirect
    )
    app.add_url_rule("/", endpoint="home", view_func=_erp_home_redirect)
    app.add_url_rule(
        "/dashboard", endpoint="dashboard", view_func=_erp_home_redirect
    )

    # /health -- the endpoint DEPLOYMENT.md's post-deployment step 1, its
    # Kubernetes livenessProbe example and PRODUCTION_READINESS.md's
    # load-balancer checklist all already instruct operators to point at.
    # It did not exist, so every one of those checks 404'd: a load balancer
    # reads that as "this instance is dead" and drains it, and an uptime
    # monitor pages on it. Documented contract, kept verbatim:
    #     {"status": ..., "database": ..., "timestamp": ...}
    #
    # It probes the DATABASE rather than only proving Flask can answer. An
    # instance whose connection pool has died still returns a static 200
    # while every real request 500s -- precisely the outage a health check
    # exists to catch.
    def _health():
        from datetime import datetime, timezone

        timestamp = (
            datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        )
        try:
            with database.get_conn() as (_conn, cur):
                cur.execute("SELECT 1")
                cur.fetchone()
        except Exception as exc:
            # Logged, never returned. psycopg2 connection errors quote the
            # DSN, which carries the database host, user and password, and
            # this endpoint is public and unauthenticated by necessity.
            app.logger.error("Health check failed: %s", exc)
            return (
                jsonify(status="unhealthy", database="error", timestamp=timestamp),
                503,
            )
        return jsonify(status="healthy", database="connected", timestamp=timestamp), 200

    # Talisman's force_https 302-redirects plain http. Probes hit the pod or
    # container directly over http, and k8s counts any 3xx as a pass -- so
    # the probe would "succeed" on a redirect it never followed, without ever
    # reaching the database check above. Opting this one view out means the
    # 200 is real. Everything else still redirects.
    if talisman is not None:
        _health = talisman(force_https=False)(_health)

    # 503, not 200-with-a-sad-body: the status code is the only part a load
    # balancer or k8s probe reads, so anything 2xx keeps a broken instance in
    # rotation no matter what the JSON says.
    #
    # Exempt from the rate limiter because RATELIMIT_DEFAULT is "200 per day"
    # (see above) and a probe every 10s is 8,640 requests/day. Without this
    # the limiter starts returning 429 within the hour, every instance fails
    # its health check at once, and the rate limiter takes down the whole
    # deployment -- a self-inflicted outage with no bad traffic involved.
    limiter.exempt(_health)

    app.add_url_rule("/health", endpoint="health", view_func=_health, methods=["GET"])

    app.logger.info("Registered auth_bp + erp_bp + erp_rpc_bp only")

    # Internal ledger-reconciliation audit (Apps_Script/module_audit.js) --
    # unattended, hourly, not wired into the UI. No-ops under TESTING/the
    # outer reloader process -- see start_ledger_audit_scheduler()'s guards.
    from .erp.services import ledger_audit_service, backup_service

    ledger_audit_service.start_ledger_audit_scheduler(app)
    backup_service.start_backup_scheduler(app)


    # If specific view function names need exemption but are only available
    # after registration, we try to exempt them but log missing keys.
    # Only exempt explicit endpoints that require CSRF exemption:
    # - JSON login/signup/forgot-password endpoints (for API clients without session)
    # - External webhook endpoints (if any exist)
    for view_name in ("auth.api_login", "auth.api_signup", "auth.api_forgot_password"):
        try:
            func = app.view_functions.get(view_name)
            if func:
                csrf.exempt(func)
                app.logger.debug("CSRF exemption applied to view: %s (authenticated API endpoint)", view_name)
        except Exception as e:
            app.logger.debug("Failed to exempt view %s from CSRF: %s", view_name, e)

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
from .utils import get_or_create_user  # re-export for backward compatibility in tests  # noqa: E402

__all__ = [
    "create_app",
    "validate_password",
    "get_or_create_user",
    "csrf",
    "login_manager",
    "mail",
    "limiter",
]
