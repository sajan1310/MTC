"""
Production-grade logging configuration for the Inventory Management System.

Features:
- Rotating file handlers to prevent disk space issues
- Structured JSON logging for machine parsing
- Separate error log file for critical issues
- Console handler for development
- Request/response logging middleware
"""

import json
import logging
import logging.handlers
from datetime import datetime
from pathlib import Path


class JsonFormatter(logging.Formatter):
    """
    Custom JSON formatter for structured logging.
    Makes logs machine-readable for log aggregation tools (Splunk, ELK, etc.)
    """

    def format(self, record):
        log_data = {
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "module": record.module,
            "function": record.funcName,
            "line": record.lineno,
        }

        # Add exception info if present
        if record.exc_info:
            log_data["exception"] = self.formatException(record.exc_info)

        # Add extra fields
        if hasattr(record, "user_id"):
            log_data["user_id"] = record.user_id
        if hasattr(record, "request_id"):
            log_data["request_id"] = record.request_id
        if hasattr(record, "ip_address"):
            log_data["ip_address"] = record.ip_address

        return json.dumps(log_data)


def setup_logging(app):
    """
    Configure production-grade logging for Flask application.

    Creates:
    - logs/app.log: General application logs (rotated daily, 30 day retention)
    - logs/error.log: Error and critical logs only (rotated weekly, 90 day retention)
    - Console output: Colored logs for development

    Usage:
        from logging_config import setup_logging
        setup_logging(app)
    """

    # Create logs directory
    log_dir = Path(app.root_path) / "logs"
    log_dir.mkdir(exist_ok=True)

    # Get log level from environment
    log_level = getattr(logging, app.config.get("LOG_LEVEL", "INFO").upper())

    # Configure root logger
    root_logger = logging.getLogger()
    root_logger.setLevel(log_level)

    # Remove existing handlers to avoid duplicates
    root_logger.handlers = []

    # === FILE HANDLER: General Application Logs ===
    # Rotates daily, keeps 30 days of logs
    file_handler = logging.handlers.TimedRotatingFileHandler(
        filename=log_dir / "app.log",
        when="midnight",
        interval=1,
        backupCount=30,
        encoding="utf-8",
    )
    file_handler.setLevel(logging.INFO)

    # Use JSON format for production, plain text for development
    if app.config.get("ENV") == "production":
        file_handler.setFormatter(JsonFormatter())
    else:
        file_formatter = logging.Formatter(
            "[%(asctime)s] %(levelname)s in %(module)s: %(message)s"
        )
        file_handler.setFormatter(file_formatter)

    root_logger.addHandler(file_handler)

    # === FILE HANDLER: Error Logs Only ===
    # Rotates weekly, keeps 90 days of logs
    error_handler = logging.handlers.TimedRotatingFileHandler(
        filename=log_dir / "error.log",
        when="W0",  # Monday
        interval=1,
        backupCount=12,  # ~3 months
        encoding="utf-8",
    )
    error_handler.setLevel(logging.ERROR)
    error_handler.setFormatter(JsonFormatter())
    root_logger.addHandler(error_handler)

    # === CONSOLE HANDLER: Development Output ===
    console_handler = logging.StreamHandler()
    console_handler.setLevel(logging.DEBUG if app.debug else logging.INFO)

    # Colored output for console (optional)
    console_formatter = logging.Formatter(
        "%(asctime)s | %(levelname)-8s | %(name)s | %(message)s", datefmt="%H:%M:%S"
    )
    console_handler.setFormatter(console_formatter)
    root_logger.addHandler(console_handler)

    # === CONFIGURE THIRD-PARTY LOGGERS ===
    # Reduce noise from verbose libraries
    logging.getLogger("werkzeug").setLevel(logging.WARNING)
    logging.getLogger("urllib3").setLevel(logging.WARNING)
    logging.getLogger("psycopg2").setLevel(logging.WARNING)

    # Log configuration completion
    app.logger.info(
        f"Logging configured: level={logging.getLevelName(log_level)}, "
        f"logs_dir={log_dir}, env={app.config.get('ENV', 'development')}"
    )


def log_request_info(app):
    """
    Middleware to log all incoming requests with timing.

    Logs:
    - HTTP method and path
    - Query parameters
    - Client IP address
    - User agent
    - Request duration
    """
    import time

    from flask import g, request

    @app.before_request
    def before_request():
        g.start_time = time.time()

        # Log request details
        app.logger.info(
            f"REQUEST: {request.method} {request.path}",
            extra={
                "ip_address": request.remote_addr,
                "user_agent": request.user_agent.string,
                "query_params": dict(request.args),
            },
        )

    @app.after_request
    def after_request(response):
        # Calculate request duration
        duration = time.time() - g.start_time

        # Log response details
        app.logger.info(
            f"RESPONSE: {response.status_code} | {request.method} {request.path} | {duration:.3f}s",
            extra={
                "status_code": response.status_code,
                "duration_ms": round(duration * 1000, 2),
            },
        )

        return response


def log_errors(app):
    """
    Global error handler to log all unhandled exceptions.
    """

    @app.errorhandler(Exception)
    def handle_exception(e):
        # Log the exception with full stack trace
        app.logger.error(
            f"Unhandled exception: {str(e)}",
            exc_info=True,
            extra={
                "exception_type": type(e).__name__,
            },
        )

        # Return generic error to user (don't leak details)
        return {"error": "Internal server error"}, 500


# === EXAMPLE USAGE ===
if __name__ == "__main__":
    from flask import Flask

    app = Flask(__name__)
    app.config["ENV"] = "production"
    app.config["LOG_LEVEL"] = "INFO"

    setup_logging(app)
    log_request_info(app)
    log_errors(app)

    @app.route("/test")
    def test():
        app.logger.info("Test endpoint called")
        return {"status": "ok"}

    app.run(debug=False)
