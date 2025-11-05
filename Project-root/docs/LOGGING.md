# Logging Guide

This document describes the logging configuration, best practices, and how to use request IDs for distributed tracing.

## Log Levels

The application uses standard Python logging levels:

- **DEBUG**: Detailed information for diagnosing problems (development only).
- **INFO**: Confirmation that things are working as expected (default for production).
- **WARNING**: Indication of potential issues or unexpected behavior.
- **ERROR**: Due to a more serious problem, the app has not been able to perform a function.
- **CRITICAL**: A serious error indicating the program may be unable to continue.

Set the log level via the `LOG_LEVEL` environment variable (default: `INFO` in production, `DEBUG` in development).

## Log Locations

- **Development**: Logs are output to the console/terminal.
- **Production**: 
  - Application logs: `logs/app.log` (rotating, max 10MB per file, 10 backup files)
  - Error logs: Console (captured by WSGI server or systemd)

Log rotation is automatic using Python's `RotatingFileHandler`. Old logs are archived with numeric suffixes: `app.log.1`, `app.log.2`, etc.

## Request ID Tracking

Every incoming request is automatically assigned a unique request ID (UUID) for distributed tracing:

- **Request Header**: Clients can send `X-Request-ID` to propagate IDs across services.
- **Response Header**: The app returns `X-Request-ID` in all responses.
- **Logging**: Request IDs are logged at DEBUG level for request start.

### Usage in Code

```python
from app.middleware import get_request_id

def some_function():
    request_id = get_request_id()
    logger.info(f"[{request_id}] Processing user action")
```

### Disabling Request ID Middleware

Set `DISABLE_REQUEST_ID_MIDDLEWARE=true` in your environment or config to disable request ID tracking (useful for minimal overhead in high-throughput scenarios).

## Structured Logging (Optional)

For production environments with centralized logging (e.g., ELK stack, Datadog, Splunk), consider structured JSON logging:

```python
import json
import logging

class JSONFormatter(logging.Formatter):
    def format(self, record):
        from app.middleware import get_request_id
        log_data = {
            'timestamp': self.formatTime(record),
            'level': record.levelname,
            'message': record.getMessage(),
            'module': record.module,
            'request_id': get_request_id(),
        }
        if record.exc_info:
            log_data['exception'] = self.formatException(record.exc_info)
        return json.dumps(log_data)

# Apply to handlers in _init_logging
```

## Best Practices

1. **Use appropriate log levels**: Avoid excessive DEBUG logs in production; reserve ERROR for actual failures.
2. **Include context**: Log request IDs, user IDs, or resource IDs to trace events.
3. **Avoid logging sensitive data**: Do not log passwords, tokens, or PII.
4. **Use structured fields**: When possible, log structured data (JSON) for easier parsing.
5. **Monitor log volume**: Excessive logging can impact performance and storage.

## Monitoring Integration

- **Sentry**: For error tracking, set `SENTRY_DSN` in production (see `production.env.example`).
- **New Relic**: For APM, set `NEW_RELIC_LICENSE_KEY` and `NEW_RELIC_APP_NAME`.
- **ELK/Splunk**: Ship JSON logs via Filebeat, Fluentd, or rsyslog for centralized analysis.

## Example Log Output

**Console (Development)**:
```
2025-01-12 10:15:23,456 INFO: Application started in DEVELOPMENT mode
2025-01-12 10:15:30,123 DEBUG: [abc123-def456] GET /api/items
2025-01-12 10:15:30,456 INFO: [abc123-def456] Retrieved 42 items for user 5
```

**File (Production)**:
```
2025-01-12 10:15:23,456 INFO: [RATE LIMIT] Redis-based rate limiting enabled.
2025-01-12 10:15:30,123 INFO: Request ID middleware enabled
2025-01-12 10:15:35,789 WARNING: [xyz789-abc123] Low stock alert: item_id=12, stock=3
```

## Troubleshooting

- **No logs appearing**: Check file permissions on `logs/` directory; ensure log level is appropriate.
- **Disk space issues**: Reduce `LOG_BACKUP_COUNT` or adjust rotation policy in `_init_logging`.
- **Request IDs not propagating**: Ensure clients send `X-Request-ID` headers if using distributed tracing.
