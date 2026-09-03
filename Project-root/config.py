"""
Environment-specific configuration for the Flask app.

Includes Base (Config), Development, Testing, and Production classes.
Provides sensible defaults and environment-variable overrides.
"""

from __future__ import annotations

import os
from urllib.parse import urlparse

from dotenv import load_dotenv

# Load .env if present. override=True ensures the repo's .env is
# authoritative for local dev even if a stale value lingers in the OS
# environment (e.g. a leftover `setx` from an old credential).
load_dotenv(override=True)


def _static_asset_fingerprint() -> str:
    """Newest mtime under static/, as a compact token.

    One walk at import, over a directory of a few hundred files -- a couple
    of milliseconds, once per process. Deliberately not a content hash: that
    would mean reading 3.36 MB at every worker start to distinguish cases
    mtime already distinguishes.

    Falls back to a fixed token if static/ cannot be read, rather than to
    time.time(): an unreadable asset directory is not a reason to hand every
    user a fresh cache-busting token on every restart, which is the exact
    behaviour PERF-007 is about.
    """
    static_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
    newest = 0.0
    try:
        for root, _dirs, files in os.walk(static_dir):
            for name in files:
                try:
                    mtime = os.stat(os.path.join(root, name)).st_mtime
                except OSError:
                    continue
                if mtime > newest:
                    newest = mtime
    except OSError:
        return "static"
    return str(int(newest)) if newest else "static"


class Config:
    """Base configuration shared by all environments."""

    # Security
    #
    # NO FALLBACK. This used to read `os.getenv("SECRET_KEY") or
    # "dev-insecure-key"`, which silently defeated the production fail-fast in
    # app/__init__.py's _load_config(): that guard only tests truthiness
    # (`if not app.config.get(key)`), and a non-empty default string is always
    # truthy, so SECRET_KEY could never appear in `missing`. A production
    # deployment with no SECRET_KEY in its environment therefore booted
    # normally on a key published in this repository -- forgeable session
    # cookies for any user id (load_user then grants that user's real role) and
    # forgeable itsdangerous password-reset tokens for any address.
    #
    # DevelopmentConfig below re-adds a fallback for local convenience. It is
    # deliberately NOT on the base class: production and testing must inherit
    # the None so the guard can see it.
    SECRET_KEY = os.getenv("SECRET_KEY")
    WTF_CSRF_TIME_LIMIT = None  # Session-lifetime bound CSRF token for SPA/RPC calls

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

    # Per-user ceilings for the ERP RPC surface (SEC-005). Both are per user
    # id, not per IP -- the factory shares one public address.
    #
    # The default is deliberately loose: a single page load fires dozens of
    # calls and the mobile outbox flushes a whole queue in a burst after
    # reconnecting, neither of which may be mistaken for abuse. The expensive
    # tier covers the whole-table reads listed in
    # app/__init__.py's EXPENSIVE_RPC_METHODS, where a loop is a genuine
    # denial of service; it can rise once PERF-002 makes those reads cheap.
    RATELIMIT_RPC_DEFAULT = os.getenv("RATELIMIT_RPC_DEFAULT", "600 per minute")
    RATELIMIT_RPC_EXPENSIVE = os.getenv("RATELIMIT_RPC_EXPENSIVE", "40 per minute")

    # Per-ACCOUNT login throttle (SEC-009). The existing "10 per minute" on
    # /auth/api/login is keyed on the client IP, which protects the server but
    # not any particular account: an attacker spreading attempts across
    # addresses gets unlimited guesses at one password, while a whole office
    # behind one NAT shares a single 10/minute budget between them.
    #
    # This one is keyed on the submitted address instead, and -- crucially --
    # only counts FAILED attempts (deduct_when on a 401), so signing in
    # correctly, repeatedly, from anywhere never consumes it. 10 failures per
    # 15 minutes leaves room for a person misremembering which password they
    # used while making online guessing useless.
    RATELIMIT_LOGIN_PER_ACCOUNT = os.getenv(
        "RATELIMIT_LOGIN_PER_ACCOUNT", "10 per 15 minutes"
    )

    # Where database snapshots are written. None keeps the historical
    # behaviour (a `backups/` directory beside the checkout), which is right
    # for the systemd deployment where that path belongs to the app user.
    #
    # It has to be overridable because the same computation lands on
    # `/backups` inside the container -- the filesystem root -- which was
    # writable only because the container ran as root. It no longer does
    # (DEPLOY-001), so the image sets this explicitly.
    BACKUP_DIR = os.getenv("BACKUP_DIR")

    # Bearer token for /metrics (OBS-002). Unset means the endpoint is
    # reachable only by an admin session -- which is the safe default, since
    # the body names internal tables and counts and an unauthenticated
    # endpoint reporting whether the mutation backlog is growing is a
    # reconnaissance gift. Set this to let a scraper in without a login.
    METRICS_TOKEN = os.getenv("METRICS_TOKEN")
    # Example: 'redis://:password@localhost:6379/0?max_connections=50&decode_responses=True'

    # Outbound email (password-reset links). MAIL_SERVER unset means "no SMTP
    # configured" -- app/auth/routes.py falls back to logging the reset link
    # instead of emailing it (and, in dev/testing only, returning it in the
    # API response) rather than failing the request.
    MAIL_SERVER = os.getenv("MAIL_SERVER")
    MAIL_PORT = int(os.getenv("MAIL_PORT", 587))
    MAIL_USE_TLS = os.getenv("MAIL_USE_TLS", "true").lower() not in ("false", "0", "")
    MAIL_USERNAME = os.getenv("MAIL_USERNAME")
    MAIL_PASSWORD = os.getenv("MAIL_PASSWORD")
    MAIL_DEFAULT_SENDER = os.getenv("MAIL_DEFAULT_SENDER", MAIL_USERNAME)

    # Whether POST /auth/api/signup accepts new registrations (SEC-002).
    #
    # Defaults to on, so this does not silently remove a workflow the business
    # may rely on. The privilege escalation is closed by the role a new account
    # receives (auth/routes.py's NEW_ACCOUNT_ROLE = "pending_approval"), not by
    # this switch -- but for a single-factory ERP, where every legitimate user
    # is known in advance, ALLOW_SELF_SIGNUP=false removes the unauthenticated
    # write path altogether and is the stronger setting.
    ALLOW_SELF_SIGNUP = os.getenv("ALLOW_SELF_SIGNUP", "true").strip().lower() not in (
        "0",
        "false",
        "no",
        "off",
    )

    # Request body size limit
    MAX_CONTENT_LENGTH = 16 * 1024 * 1024  # 16MB

    # URL generation and base
    BASE_URL = os.getenv("BASE_URL", "http://127.0.0.1:5000")
    # Only set SERVER_NAME when explicitly configured — Flask enforces host-matching
    # when this is set, which breaks url_for() in CLI contexts and dev environments.
    SERVER_NAME = os.getenv("SERVER_NAME") or None

    # Session lifetime
    PERMANENT_SESSION_LIFETIME = int(os.getenv("PERMANENT_SESSION_LIFETIME", 86400))

    # Database
    DATABASE_URL = os.getenv("DATABASE_URL")
    # Legacy fields for existing database.py helper
    DB_HOST = os.getenv("DB_HOST", "127.0.0.1")
    DB_NAME = os.getenv("DB_NAME", "MTC")
    DB_USER = os.getenv("DB_USER", "postgres")
    # No "abcd" fallback -- same class of defect as SECRET_KEY above. A
    # deployment missing DB_PASS must fail at boot with a clear message, not
    # attempt a connection with a guessable password (or, worse, succeed
    # against a trust-auth database and hide the misconfiguration).
    # TestingConfig overrides this with its own TEST_DB_PASS chain.
    DB_PASS = os.getenv("DB_PASS")

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

    # Cache-busting token for ?v= on every stylesheet and script (PERF-007).
    #
    # This was `str(int(time.time()))`, evaluated at class-definition time --
    # so every gunicorn worker computed its own. With 4 workers a user got up
    # to 4 different URLs for the same unchanged file depending on which
    # worker rendered the page, and each one is a separate entry in the
    # browser cache and a separate download. Worse, a single page could pull
    # styles.css?v=A and core.js?v=B from different workers, so a deploy's
    # assets could be mixed across versions.
    #
    # It also changed on every restart, which threw away every returning
    # user's entire asset cache for a restart that shipped no new assets.
    #
    # Now derived from the assets themselves: the newest mtime under static/,
    # which is identical in every worker on a machine, stable across
    # restarts, and changes exactly when a file does. ASSET_VERSION overrides
    # it for deployments that would rather pin the token to a release or a
    # commit -- and is the right answer for multi-machine deployments, where
    # mtimes can differ between hosts after separate checkouts.
    VERSION = os.getenv("ASSET_VERSION") or _static_asset_fingerprint()

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
    # Development-only convenience fallbacks. These live HERE, not on Config,
    # so that production and testing inherit Config's None and _load_config()'s
    # fail-fast can actually fire. WEAK_SECRET_KEYS in app/__init__.py lists
    # this exact string, so if this config class is ever selected in a
    # production environment the guard still rejects it.
    SECRET_KEY = os.getenv("SECRET_KEY") or "dev-insecure-key"
    DB_PASS = os.getenv("DB_PASS") or "abcd"


class TestingConfig(Config):
    DEBUG = False
    TESTING = True
    # Relax requirements for tests; external DB may be mocked/available in CI
    SESSION_COOKIE_SECURE = False
    # Use memory storage for rate limiter in tests to avoid Redis warning
    RATELIMIT_STORAGE_URL = "memory://"

    # Test database configuration - defaults match CI environment
    # CI workflow sets: POSTGRES_USER=postgres, POSTGRES_PASSWORD=testpass, POSTGRES_DB=testdb
    DB_NAME = os.getenv("TEST_DB_NAME", os.getenv("DB_NAME", "testdb"))
    DB_HOST = os.getenv("TEST_DB_HOST", os.getenv("DB_HOST", "127.0.0.1"))
    DB_USER = os.getenv("TEST_DB_USER", os.getenv("DB_USER", "postgres"))
    DB_PASS = os.getenv("TEST_DB_PASS", os.getenv("DB_PASS", "testpass"))
    # CRITICAL: must override Config.DATABASE_URL (which reads DATABASE_URL
    # from the environment -- typically pointing at the real production DB
    # via .env) rather than inherit it. database.py's init_app() prefers
    # DATABASE_URL over DB_HOST/DB_NAME/DB_USER/DB_PASS whenever it's set,
    # so leaving this inherited silently sent every test run's actual
    # mutating RPC traffic (savePO, saveItem, etc. -- not just this class's
    # own tests/erp/conftest.py schema-migration connection) at the real
    # database instead of DB_NAME above, regardless of TEST_DB_NAME being
    # set correctly. Confirmed live: this wrote ~180 test-fixture rows
    # (vendors/items/POs with names like "LowRateVendor-<hex>") directly
    # into the production database during a full-suite run.
    DATABASE_URL = None

    def __init__(self):
        """PHASE 1C: Prevent test config using production DB.

        Raises RuntimeError if TEST_DB_NAME equals production DB_NAME.
        This ensures tests cannot accidentally run against production data.

        DATABASE_URL is a separate risk this doesn't need to re-check here:
        DATABASE_URL = None above (a class attribute, not environment-read)
        plus _load_config()'s override_keys excluding "DATABASE_URL" under
        "testing" together guarantee database.py never sees a DATABASE_URL
        for this config, regardless of what's in the environment -- no
        unsetting required. An additional check here that inspected
        os.getenv("DATABASE_URL") directly would fire on every normal test
        run (since .env always sets it) without adding real protection.
        """
        super().__init__()
        # Get the production database name for comparison
        prod_db = os.getenv("DB_NAME", "MTC")  # production default
        test_db = self.DB_NAME

        if test_db == prod_db and test_db != "testdb":
            raise RuntimeError(
                f"FATAL: TestingConfig is configured to use production database '{test_db}'. "
                f"This is a safety violation. Please ensure TEST_DB_NAME is set to a dedicated test database "
                f"(default: 'testdb', not '{prod_db}'). "
                f"Set TEST_DB_NAME environment variable to a test database name."
            )


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
