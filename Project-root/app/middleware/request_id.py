"""
Request ID middleware for distributed tracing.

Assigns a unique request ID to every incoming request for tracking across logs,
making it easier to correlate events in distributed systems or multi-worker deployments.
"""

import uuid
from flask import g, request
import logging

logger = logging.getLogger(__name__)


def setup_request_id_middleware(app):
    """
    Register before_request and after_request handlers to track request IDs.

    Usage in app factory:
        from app.middleware.request_id import setup_request_id_middleware
        setup_request_id_middleware(app)
    """

    @app.before_request
    def assign_request_id():
        """Assign a unique request ID to the request context."""
        # Check if client sent X-Request-ID header (for downstream propagation)
        request_id = request.headers.get("X-Request-ID")
        if not request_id:
            request_id = str(uuid.uuid4())

        g.request_id = request_id

        # Optional: log request start with ID
        if app.config.get("LOG_LEVEL") == "DEBUG":
            logger.debug(f"[{request_id}] {request.method} {request.path}")

    @app.after_request
    def add_request_id_header(response):
        """Add X-Request-ID to response headers for client tracing."""
        if hasattr(g, "request_id"):
            response.headers["X-Request-ID"] = g.request_id
        return response

    app.logger.info("Request ID middleware enabled")


def get_request_id():
    """
    Get the current request ID from Flask g context.

    Returns:
        str: Request ID or 'no-request-context' if outside request context.
    """
    return getattr(g, "request_id", "no-request-context")
