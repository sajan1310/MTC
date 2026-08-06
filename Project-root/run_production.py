#!/usr/bin/env python3
"""
Production-grade startup script for the Inventory Management System.
Automatically detects environment and selects appropriate WSGI server.
"""

import os
import subprocess
import sys


def check_environment():
    """Detect deployment environment."""
    if os.getenv("DYNO"):  # Heroku
        return "heroku"
    elif os.getenv("RAILWAY_ENVIRONMENT"):  # Railway
        return "railway"
    elif os.getenv("RENDER"):  # Render
        return "render"
    elif os.getenv("FLASK_ENV") == "production" or os.getenv("ENV") == "production":
        return "production"
    else:
        return "development"


def validate_environment_variables():
    """Ensure critical environment variables are set."""
    required_vars = [
        "SECRET_KEY",
        "DATABASE_URL",
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
    ]

    missing_vars = [var for var in required_vars if not os.getenv(var)]

    if missing_vars:
        print("❌ ERROR: Missing required environment variables:")
        for var in missing_vars:
            print(f"   - {var}")
        print("\nPlease set these variables in your .env file or environment.")
        sys.exit(1)

    print("✅ All required environment variables are set")


def check_database_connection():
    """Verify database connection before starting server."""
    try:
        from database import db
        from app import create_app

        # Create app instance for context
        app = create_app(os.getenv("FLASK_ENV", "production"))

        with app.app_context():
            # Test database connection
            result = db.session.execute(db.text("SELECT 1")).scalar()
            if result == 1:
                print("✅ Database connection successful")
                return True
    except Exception as e:
        print(f"❌ Database connection failed: {e}")
        print("   Please verify DATABASE_URL and ensure database is accessible")
        return False


def run_production_server(env_type):
    """Start production WSGI server based on environment."""
    port = int(os.getenv("PORT", 5000))
    workers = int(os.getenv("WEB_CONCURRENCY", 4))

    print(f"\n🚀 Starting production server in {env_type.upper()} mode")
    print(f"   Port: {port}")
    print(f"   Workers: {workers}")

    if sys.platform == "win32":
        # Windows: Use waitress
        print("   Server: Waitress (Windows)")
        try:
            subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "waitress",
                    "--port",
                    str(port),
                    "--threads",
                    str(workers * 2),
                    "wsgi:app",
                ],
                check=True,
            )
        except subprocess.CalledProcessError as e:
            print(f"❌ Waitress failed to start: {e}")
            sys.exit(1)
    else:
        # Unix/Linux: Use gunicorn
        print("   Server: Gunicorn (Unix/Linux)")
        try:
            subprocess.run(
                [
                    "gunicorn",
                    "wsgi:app",
                    "--bind",
                    f"0.0.0.0:{port}",
                    "--workers",
                    str(workers),
                    "--timeout",
                    "120",
                    "--log-level",
                    "info",
                    "--access-logfile",
                    "-",
                    "--error-logfile",
                    "-",
                    "--capture-output",
                    "--enable-stdio-inheritance",
                ],
                check=True,
            )
        except subprocess.CalledProcessError as e:
            print(f"❌ Gunicorn failed to start: {e}")
            sys.exit(1)


def run_development_server():
    """Start Flask development server."""
    print("\n🔧 Starting DEVELOPMENT server")
    print("   ⚠️  WARNING: NOT for production use!")
    print("   Use 'python run_production.py' for production deployment\n")

    from app import create_app

    app = create_app(os.getenv("FLASK_ENV", "development"))
    port = int(os.getenv("PORT", 5000))
    # Loopback-only by default and debug is opt-in: this path runs whenever
    # check_environment() *fails* to detect a production platform, so a
    # misconfigured/unrecognized prod host must never end up handing out
    # the Werkzeug debugger (RCE via its console) on a network interface.
    host = os.getenv("HOST", "127.0.0.1")
    debug = os.getenv("FLASK_DEBUG", "0") == "1"
    app.run(host=host, port=port, debug=debug)


def main():
    """Main entry point."""
    print("=" * 60)
    print("  Inventory Management System - Production Startup")
    print("=" * 60)

    # Detect environment
    env_type = check_environment()
    print(f"\n🌍 Environment: {env_type.upper()}")

    # Validate configuration
    print("\n📋 Validating configuration...")
    validate_environment_variables()

    # Check database
    print("\n🗄️  Checking database connection...")
    if not check_database_connection():
        sys.exit(1)

    # Start appropriate server
    if env_type == "development":
        run_development_server()
    else:
        run_production_server(env_type)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\n⏹️  Server stopped by user")
        sys.exit(0)
    except Exception as e:
        print(f"\n❌ Fatal error: {e}")
        import traceback

        traceback.print_exc()
        sys.exit(1)
