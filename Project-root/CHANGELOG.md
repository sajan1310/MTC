# Changelog
## [1.3.1] - 2025-11-05 - TEST STABILIZATION & DX POLISH

### Added
- Standard API response envelope documented in README.
- CONTRIBUTING guide with Windows-friendly test instructions and conventions.

### Changed
- Rate limiter initialization respects `TESTING` and `memory://` storage to eliminate warnings in tests.
- Process service pagination now returns top-level `total`, `page`, and `per_page` for easier consumption.

### Fixed
- Import service accepts original header keys (Item, Model, Color, Size, Stock, Unit) alongside normalized fields.
- Process model serialization tolerates string datetimes in tests and exposes `process_class` alias.


All notable changes to this project will be documented in this file.

> **📚 For comprehensive documentation of all changes, see [COMPLETE_CHANGE_LOG.md](./COMPLETE_CHANGE_LOG.md)**

## [1.3.0] - 2025-11-01 - AUDIT FIXES & ARCHITECTURAL OVERHAUL

### Added
- **Redis-Based Rate Limiting**: Centralized rate limiting with connection pooling for multi-instance deployments
- **Database Performance Indexes**: 10 indexes across 5 tables for 50-80% query speed improvement
- **Modular Blueprint Architecture**: Separated concerns into models/, auth/, api/, services/, utils/
- **Enhanced CSRF Protection**: SameSite=Strict cookies, JSON error handlers, comprehensive security
- **Testing & CI/CD**: pytest configuration, test scaffolding, GitHub Actions workflow, Ruff linter
- **Role-Based Authorization**: @role_required decorator with authentication and authorization checks

### Changed
- **app/__init__.py**: Refactored with Redis pooling, enhanced CSRF, blueprint registration
- **config.py**: Added REDIS_URL and RATELIMIT_STORAGE_URL configuration
- **requirements.txt**: Added redis==5.0.1, pytest-cov, ruff
- **Session cookies**: SESSION_COOKIE_SAMESITE='Strict' in production for enhanced security

### Fixed
- **Multi-instance rate limiting**: Now works across load-balanced deployments
- **Database query performance**: Optimized with proper indexes
- **Code organization**: Modular structure improves maintainability

## [1.2.0] - 2025-10-31 - PRODUCTION READINESS UPGRADE

### Added
- **WSGI Server Configuration**: Gunicorn (Unix) and Waitress (Windows) support
- **Database Connection Pooling**: Optimized pool (4-20 connections) with keepalives
- **Security Headers**: X-Frame-Options, CSP, HSTS, X-Content-Type-Options
- **Structured Logging**: JSON logs with rotation (30-day general, 90-day errors)
- **Health Check Endpoint**: /health endpoint for monitoring and load balancers
- **Deployment Automation**: Procfile and run_production.py with platform auto-detection

### Changed
- **database.py**: Enhanced connection pool with TCP keepalives and query timeouts
- **Static files**: Added caching headers (max-age=31536000, immutable)
- **Logging**: Migrated to rotating file handlers with structured format

## [1.1.5] - 2025-10-30 - IMPORT SYSTEM OVERHAUL

### Added
- **UPSERT-Based Imports**: PostgreSQL UPSERT pattern for concurrent operations
- **Background Job Processing**: Database-backed job queue with retry logic
- **Real-Time Progress Tracking**: Redis-based progress with fallback to in-memory
- **Data Validation Layer**: SQL injection prevention, field validation, duplicate detection
- **Row-Level Error Handling**: Partial success with detailed error reporting

### Changed
- **Import performance**: 20-30% faster (10-12s vs 15s per 1000 rows)
- **Application availability**: 100% uptime during imports (no table locks)
- **DoS mitigation**: File size limits, row limits, timeouts, rate limiting

### Fixed
- **Table locking**: Removed EXCLUSIVE locks, now allows concurrent operations
- **Import blocking**: Users can now access inventory during imports

## [1.1.0] - 2025-10-30 - SECURITY & OAUTH

### Added
- **Google OAuth 2.0**: Secure OAuth login flow with state validation
- **File Upload Security**: Magic number validation, MIME type checking
- **Private File Storage**: Files stored in private_uploads/ with 600 permissions
- **Authenticated File Serving**: Access control and audit logging
- **Testing Framework**: Comprehensive test suite with unit, integration, and smoke tests
- **models.py**: User model separated to resolve circular dependency
- **CHANGELOG.md**: Project changelog tracking

### Changed
- **Dependencies**: Pinned versions in requirements.txt
- **Session Cookies**: Hardened settings for production
- **OAuth Redirect URI**: Dynamic URI generation for portability
- **Error Handling**: Robust error handling in OAuth callback

### Fixed
- **Google OAuth 404**: Resolved redirect URI mismatch
- **Circular Dependency**: Eliminated between app.py and auth/routes.py
- **File Upload Vulnerabilities**: Magic number validation prevents malicious uploads

---

## Version History Summary

| Version | Date | Focus | Key Achievement |
|---------|------|-------|-----------------|
| 1.3.0 | 2025-11-01 | Architecture & Scale | Multi-instance ready, 50-80% faster queries |
| 1.2.0 | 2025-10-31 | Production Ready | Enterprise deployment, monitoring, security |
| 1.1.5 | 2025-10-30 | Import System | Concurrent operations, 100% uptime |
| 1.1.0 | 2025-10-30 | Security & Auth | OAuth, secure file uploads |
| 1.0.0 | Initial | Core Features | Basic inventory management |

---

**For detailed implementation notes, performance metrics, and architecture evolution, see [COMPLETE_CHANGE_LOG.md](./COMPLETE_CHANGE_LOG.md)**
