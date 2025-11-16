"""Canonical project runner.

This script is the single recommended entrypoint for running the application
locally. It reads `FLASK_ENV` (defaults to "development" for convenience),
initializes the application via the package-level `create_app`, and starts
the development server binding to `0.0.0.0` by default.

Usage:
    python run.py
    FLASK_ENV=production python run.py
"""

import os

from app import create_app


def main() -> None:
    # Default to development for local developer convenience. In production
    # deployments you should set FLASK_ENV=production (or use a WSGI server).
    config_env = os.getenv("FLASK_ENV", "development")

    # Create the Flask app using the application factory.
    app = create_app(config_env)

    # Determine debug mode and host/port from environment.
    debug = config_env == "development"
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", 5000))

    # Run the built-in dev server (not for production use).
    app.run(host=host, port=port, debug=debug)


if __name__ == "__main__":
    main()
