"""
Request ID middleware for distributed tracing.

Assigns a unique request ID to every incoming request for tracking across logs,
making it easier to correlate events in distributed systems or multi-worker deployments.
"""

import uuid
from flask import g, request
import logging

logger = logging.getLogger(__name__)


def _sanitize_request_id(value):
    """Return `value` if it is a well-formed UUID, else None.

    Parsing as a UUID rather than pattern-stripping is deliberate: it accepts
    exactly the shape this application generates, and rejects everything else
    outright instead of trying to make a hostile string safe. Nothing with a
    newline, a control character, an ANSI escape or an unbounded length can
    get through.
    """
    if not value or not isinstance(value, str):
        return None
    candidate = value.strip()
    # uuid.UUID() tolerates surrounding braces, urn: prefixes and missing
    # hyphens, so compare the canonical form back to the input to keep the
    # id we log identical to the id the client sent.
    try:
        parsed = uuid.UUID(candidate)
    except (ValueError, AttributeError, TypeError):
        return None
    return candidate if str(parsed) == candidate.lower() else str(parsed)


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
        # A client-supplied X-Request-ID is accepted for trace correlation,
        # but only if it IS a UUID (SEC-011).
        #
        # It used to be taken verbatim. This value is written into log lines
        # and echoed back in a response header, so an arbitrary string is a
        # log-injection primitive: embedded newlines let a caller forge
        # whole log entries -- inventing errors that never happened, or
        # burying real ones under plausible-looking noise -- and an
        # attacker-chosen id also lets them collide deliberately with
        # somebody else's trace.
        request_id = _sanitize_request_id(request.headers.get("X-Request-ID"))
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
