"""
PHASE 5: Request ID Middleware & Centralized Error Handling
Provides request tracking, structured logging, and error observability
"""

import uuid
import logging
import json
import time
import traceback
from datetime import datetime
from functools import wraps
from typing import Optional, Dict, Any

from flask import request, g, current_app
from werkzeug.exceptions import HTTPException


class RequestContext:
    """
    Manages request-scoped context including request ID and correlation tracking.
    Enables tracing requests across multiple services and log aggregation.
    """

    # Thread-local storage for request context
    _context: Dict[str, Any] = {}

    @classmethod
    def initialize(cls, request_id: Optional[str] = None) -> str:
        """
        Initialize request context with unique request ID.

        Args:
            request_id: Optional existing request ID for correlation

        Returns:
            str: The request ID for this request
        """
        rid = request_id or str(uuid.uuid4())
        cls._context["request_id"] = rid
        cls._context["start_time"] = time.time()
        cls._context["events"] = []
        return rid

    @classmethod
    def get_request_id(cls) -> str:
        """Get current request ID."""
        return cls._context.get("request_id", "unknown")

    @classmethod
    def log_event(cls, event_type: str, data: Dict[str, Any]) -> None:
        """
        Log an event within the request context.

        Args:
            event_type: Type of event (query, auth, validation, etc.)
            data: Event data
        """
        event = {
            "type": event_type,
            "timestamp": datetime.utcnow().isoformat(),
            "data": data,
        }
        cls._context.get("events", []).append(event)

    @classmethod
    def get_duration_ms(cls) -> float:
        """Get elapsed time since request started."""
        start = cls._context.get("start_time", time.time())
        return (time.time() - start) * 1000

    @classmethod
    def get_context_dict(cls) -> Dict[str, Any]:
        """Get full context as dictionary."""
        return {
            "request_id": cls.get_request_id(),
            "duration_ms": cls.get_duration_ms(),
            "events": cls._context.get("events", []),
        }

    @classmethod
    def clear(cls) -> None:
        """Clear request context (call after request completes)."""
        cls._context.clear()


class StructuredLogger:
    """
    Provides structured logging with consistent format for log aggregation.
    Includes request ID, severity, timestamps, and contextual data.
    """

    def __init__(self, name: str):
        self.logger = logging.getLogger(name)

    def _build_log_entry(
        self,
        level: str,
        message: str,
        error_code: Optional[str] = None,
        context: Optional[Dict[str, Any]] = None,
        exception: Optional[Exception] = None,
    ) -> str:
        """Build structured log entry in JSON format."""
        entry = {
            "timestamp": datetime.utcnow().isoformat(),
            "level": level,
            "message": message,
            "request_id": RequestContext.get_request_id(),
            "duration_ms": RequestContext.get_duration_ms(),
        }

        if error_code:
            entry["error_code"] = error_code

        if context:
            entry["context"] = context

        if exception:
            entry["exception"] = {
                "type": type(exception).__name__,
                "message": str(exception),
                "traceback": traceback.format_exc(),
            }

        return json.dumps(entry)

    def info(self, message: str, context: Optional[Dict[str, Any]] = None) -> None:
        """Log info level message."""
        log_entry = self._build_log_entry("INFO", message, context=context)
        self.logger.info(log_entry)

    def warning(
        self,
        message: str,
        error_code: Optional[str] = None,
        context: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Log warning level message."""
        log_entry = self._build_log_entry("WARNING", message, error_code, context)
        self.logger.warning(log_entry)

    def error(
        self,
        message: str,
        error_code: Optional[str] = None,
        context: Optional[Dict[str, Any]] = None,
        exception: Optional[Exception] = None,
    ) -> None:
        """Log error level message."""
        log_entry = self._build_log_entry(
            "ERROR", message, error_code, context, exception
        )
        self.logger.error(log_entry)

    def debug(
        self, message: str, context: Optional[Dict[str, Any]] = None
    ) -> None:
        """Log debug level message."""
        log_entry = self._build_log_entry("DEBUG", message, context=context)
        self.logger.debug(log_entry)


class ErrorHandler:
    """
    Centralized error handler with standardized error responses
    and error code categorization.
    """

    # Error code to HTTP status code mapping
    ERROR_STATUS_MAP = {
        "validation_error": 400,
        "authentication_error": 401,
        "authorization_error": 403,
        "not_found_error": 404,
        "conflict_error": 409,
        "rate_limit_error": 429,
        "server_error": 500,
        "unavailable_error": 503,
    }

    # Error categorization for logging
    ERROR_CATEGORIES = {
        "validation_error": "Client Error",
        "authentication_error": "Security",
        "authorization_error": "Security",
        "not_found_error": "Client Error",
        "conflict_error": "Data Integrity",
        "rate_limit_error": "Rate Limiting",
        "server_error": "System",
        "unavailable_error": "System",
    }

    @staticmethod
    def get_status_code(error_code: str) -> int:
        """Get HTTP status code for error code."""
        return ErrorHandler.ERROR_STATUS_MAP.get(error_code, 500)

    @staticmethod
    def categorize(error_code: str) -> str:
        """Categorize error for logging."""
        return ErrorHandler.ERROR_CATEGORIES.get(error_code, "Unknown")

    @staticmethod
    def format_response(
        error_code: str, message: str, data: Optional[Dict] = None
    ) -> Dict[str, Any]:
        """
        Format standardized error response.

        Returns:
            Dict with success=False, error, message, and optional data
        """
        return {
            "success": False,
            "error": error_code,
            "message": message,
            "data": data,
        }


def request_id_middleware():
    """
    Flask request_id middleware function.
    Initializes request context with unique ID for tracking.

    Usage:
        @app.before_request
        def before_request():
            request_id_middleware()
    """
    # Extract request ID from headers (for correlation) or generate new one
    request_id = request.headers.get("X-Request-ID")
    rid = RequestContext.initialize(request_id)

    # Store in Flask g object for access in handlers
    g.request_id = rid

    # Log request start
    current_app.logger.debug(
        json.dumps(
            {
                "event": "request_start",
                "request_id": rid,
                "method": request.method,
                "path": request.path,
                "remote_addr": request.remote_addr,
                "user_agent": request.user_agent.string,
            }
        )
    )


def log_response_handler():
    """
    Flask response handler for logging response details.

    Usage:
        @app.after_request
        def after_request(response):
            return log_response_handler()(response)
    """

    def handler(response):
        rid = RequestContext.get_request_id()
        duration = RequestContext.get_duration_ms()

        # Log response
        current_app.logger.info(
            json.dumps(
                {
                    "event": "request_end",
                    "request_id": rid,
                    "method": request.method,
                    "path": request.path,
                    "status_code": response.status_code,
                    "duration_ms": duration,
                }
            )
        )

        # Add request ID to response headers
        response.headers["X-Request-ID"] = rid

        return response

    return handler


def handle_error(
    error_code: str, message: str, status_code: Optional[int] = None, data=None
):
    """
    Decorator for error handling in route handlers.

    Usage:
        @app.route('/api/users')
        @handle_error('server_error', 'Failed to fetch users')
        def get_users():
            return {'id': 1, 'name': 'User'}
    """

    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            try:
                return f(*args, **kwargs)
            except HTTPException as e:
                # Werkzeug HTTP exceptions
                rid = RequestContext.get_request_id()
                current_app.logger.warning(
                    json.dumps(
                        {
                            "event": "http_error",
                            "request_id": rid,
                            "error_code": error_code,
                            "status_code": e.code,
                            "message": str(e),
                        }
                    )
                )
                return (
                    ErrorHandler.format_response(error_code, str(e.description)),
                    e.code,
                )
            except Exception as e:
                # Catch all exceptions
                rid = RequestContext.get_request_id()
                category = ErrorHandler.categorize(error_code)

                current_app.logger.error(
                    json.dumps(
                        {
                            "event": "unhandled_error",
                            "request_id": rid,
                            "error_code": error_code,
                            "category": category,
                            "message": message,
                            "exception": str(e),
                            "traceback": traceback.format_exc(),
                        }
                    )
                )

                http_status = status_code or ErrorHandler.get_status_code(error_code)
                return (
                    ErrorHandler.format_response(
                        error_code, message, {"error_details": str(e)}
                    ),
                    http_status,
                )

        return decorated_function

    return decorator


def log_database_query(operation: str, table: str, duration_ms: float):
    """
    Log database query for observability.

    Args:
        operation: SQL operation (SELECT, INSERT, UPDATE, DELETE)
        table: Table name
        duration_ms: Query duration in milliseconds
    """
    rid = RequestContext.get_request_id()
    RequestContext.log_event(
        "database_query",
        {
            "operation": operation,
            "table": table,
            "duration_ms": duration_ms,
        },
    )


def log_authentication_attempt(
    username: str, success: bool, method: str, reason: Optional[str] = None
):
    """
    Log authentication attempt for security auditing.

    Args:
        username: Username attempting to login
        success: Whether authentication succeeded
        method: Authentication method (oauth, password, etc.)
        reason: Reason for failure if unsuccessful
    """
    rid = RequestContext.get_request_id()
    RequestContext.log_event(
        "authentication_attempt",
        {
            "username": username,
            "success": success,
            "method": method,
            "reason": reason,
        },
    )


def log_authorization_check(
    resource: str, action: str, allowed: bool, reason: Optional[str] = None
):
    """
    Log authorization check for audit trail.

    Args:
        resource: Resource being accessed
        action: Action being attempted
        allowed: Whether action was allowed
        reason: Reason if denied
    """
    rid = RequestContext.get_request_id()
    RequestContext.log_event(
        "authorization_check",
        {
            "resource": resource,
            "action": action,
            "allowed": allowed,
            "reason": reason,
        },
    )


def get_request_logger(name: str) -> StructuredLogger:
    """
    Get a structured logger for the given name.

    Usage:
        logger = get_request_logger(__name__)
        logger.info("User login successful", context={"user_id": 123})
    """
    return StructuredLogger(name)
