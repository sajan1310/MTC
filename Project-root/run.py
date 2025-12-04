"""Development-only Flask runner with safe defaults and validation.

PRIMARY DEVELOPMENT RUNNER for the Inventory Management System.

This module provides a secure developer entrypoint intended strictly for
local development and CI environments. It performs preflight checks and
validates environment variables before calling the application factory.

Note: All deprecated app.py files have been removed. This run.py file is the
single, unified development runner. For production, use run_production.py or
a WSGI server (see below).

Important:
- This runner will REFUSE to enable the Flask debugger in a production
  environment. If you intend to run in production, use a WSGI server such as
  `gunicorn`, `waitress`, or `uWSGI` and call :func:`create_app` from your
  WSGI entrypoint.

Usage (development):
    python run.py

Other runners:
- run_production.py: Production-grade deployment server selector
- wsgi.py: WSGI entry point for gunicorn / waitress / uWSGI

Environment variables used:
- FLASK_ENV: 'development' (default) | 'testing' | 'production'
- HOST: network interface to bind (defaults to '127.0.0.1')
- PORT: port number (defaults to 5000)
- RUN_IN_DOCKER: if truthy, allows binding to 0.0.0.0
"""

from __future__ import annotations

import os
import sys
import socket
import logging
from typing import Tuple

from app import create_app


def preflight_checks(env: str, host: str, port: int) -> None:
    """Perform environment and networking validations before starting app.

    - Disallow debug or running the dev server when `env` is 'production'.
    - Validate `host` is allowed (127.0.0.1 default). Allow 0.0.0.0 only when
      `RUN_IN_DOCKER` or `RUN_IN_CONTAINER` is set to a truthy value.
    - Validate `port` is an integer in the 1-65535 range.
    - Test binding to the requested (host,port) to catch immediate bind errors.
    """

    # Disallow dev server usage in production
    if env == "production":
        raise RuntimeError(
            "Refusing to run development server in production environment. "
            "Use a WSGI server (gunicorn, uWSGI, waitress) and call create_app()."
        )

    # Host validation: prefer loopback by default
    allowed_direct = {"127.0.0.1", "::1", "localhost"}
    docker_allowed = os.getenv("RUN_IN_DOCKER", "").lower() in ("1", "true", "yes")

    if host == "0.0.0.0" and not docker_allowed:
        raise ValueError(
            "Refusing to bind to 0.0.0.0 by default. "
            "Set RUN_IN_DOCKER=1 when you intend to bind to all interfaces (e.g. in Docker)."
        )

    if host not in ("0.0.0.0", "::", *allowed_direct):
        # Try to resolve hostname to ensure it is valid
        try:
            socket.gethostbyname(host)
        except Exception as exc:  # narrow: we want any resolution error
            raise ValueError(f"HOST '{host}' is not a valid or resolvable hostname: {exc}")

    # Port range validation
    if not (1 <= port <= 65535):
        raise ValueError("PORT must be an integer between 1 and 65535")

    # Test binding quickly to fail fast if port is in use or permission denied.
    # Use SO_REUSEADDR to avoid long waits in some platforms.
    sock = None
    try:
        sock = socket.socket(socket.AF_INET6 if ":" in host else socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        # Bind to host/port; if that fails, raise a clear error
        sock.bind((host, port))
    except OSError as e:
        raise OSError(f"Unable to bind to {host}:{port} — {e}")
    finally:
        if sock:
            sock.close()


def parse_port(value: str | None, default: int = 5000) -> int:
    """Safely parse port from environment with validation.

    Returns a valid port integer or raises ValueError.
    """
    if value is None or value == "":
        return default
    try:
        p = int(value)
    except (TypeError, ValueError):
        raise ValueError(f"Invalid PORT value: {value!r}")
    if not (1 <= p <= 65535):
        raise ValueError(f"PORT out of range (1-65535): {p}")
    return p


def main() -> None:
    # Configure basic logging for startup info
    logging.basicConfig(level=logging.INFO)
    log = logging.getLogger("run")

    config_env = os.getenv("FLASK_ENV", "development").lower()

    # Determine host and port from environment with safe defaults
    host = os.getenv("HOST", "127.0.0.1")
    try:
        port = parse_port(os.getenv("PORT", "5000"))
    except ValueError as e:
        log.error("Invalid PORT environment variable: %s", e)
        sys.exit(2)

    # Perform preflight checks before importing/creating the app
    try:
        preflight_checks(config_env, host, port)
    except Exception as e:
        log.error("Preflight checks failed: %s", e)
        sys.exit(2)

    # Create and run the app with robust error handling
    try:
        app = create_app(config_env)
    except Exception as e:
        log.exception("Failed to create Flask application: %s", e)
        # Provide actionable guidance
        if config_env == "production":
            log.error(
                "Application factory failed in production. Ensure environment "
                "and configuration files are correct and run under a WSGI server."
            )
        sys.exit(3)

    # Prevent accidentally enabling debug in production via other env vars
    if config_env == "production" and app.debug:
        log.error(
            "Application debug mode detected while FLASK_ENV=production — refusing to start."
        )
        sys.exit(4)

    # Final startup info
    log.info("Starting development server: env=%s host=%s port=%s", config_env, host, port)
    log.info("Use a WSGI server in production (gunicorn / uWSGI / waitress)")

    try:
        # This call is development-only. For production use, run a WSGI server.
        app.run(host=host, port=port, debug=app.debug, use_reloader=False)
    except KeyboardInterrupt:
        log.info("Shutdown requested, exiting.")
    except Exception as e:
        log.exception("Error while running development server: %s", e)
        sys.exit(1)


if __name__ == "__main__":
    main()
