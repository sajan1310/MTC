# Security Policy

> **Audience:** Developers, security researchers, and operations teams.

## Overview

This document describes the security architecture, policies, and best practices for the MTC application. Security is implemented through multiple layers: authentication, authorization, CSRF protection, CORS policy, secrets management, and secure defaults.

---

## 1. Authentication & Authorization

### User Authentication

**Backend:** Flask-Login with PostgreSQL user storage.

**Password Requirements:**
- Minimum 8 characters
- At least 1 uppercase letter
- At least 1 lowercase letter
- At least 1 number
- At least 1 special character: `!@#$%^&*()_-+=[]{}; '",.<>?/\|`~`

**Password Storage:**
- Hashed with `werkzeug.security.generate_password_hash` (PBKDF2-SHA256)
- Never stored in plaintext
- No password recovery—only secure reset via time-limited tokens

**Password Reset Flow:**
1. User requests reset via `/auth/forgot-password` (email-based)
2. Server generates time-limited token (24h expiry) stored in `password_resets` table
3. Token sent via email (not logged or displayed)
4. User submits new password at `/auth/reset-password/:token`
5. Token validated and immediately invalidated after use

### OAuth (Google Sign-In)

**Configuration:**
- Google OAuth 2.0 via `oauthlib` and `requests-oauthlib`
- Client ID and secret stored in environment variables (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`)
- Redirect URI: `{BASE_URL}/auth/callback/google`
- State parameter for CSRF protection (random token per auth request)

**User Creation:**
- OAuth users auto-created on first login with `oauth_provider='google'` and `oauth_id` (Google user ID)
- Email verified by Google (no manual verification needed)
- Default role: `user`

**Testing Bypass:**
- In `TESTING=True` environments, OAuth flow returns a deterministic test user to avoid network dependencies
- Production always enforces real OAuth flow

### Role-Based Access Control (RBAC)

**Roles:**
- `admin`: Full access to all resources, user management
- `manager`: Create/edit processes, production lots, reports
- `user`: View-only access, basic data entry

**Enforcement:**
- `@login_required` decorator on protected routes
- Role checks in views: `if current_user.role != 'admin': abort(403)`
- API endpoints return 401 Unauthorized for unauthenticated requests, 403 Forbidden for insufficient permissions

---

## 2. CSRF Protection

### Flask-WTF CSRFProtect

**Enabled globally via `CSRFProtect()`** in `app/__init__.py`.

**How It Works:**
1. Server generates CSRF token on session creation
2. HTML forms include hidden `csrf_token` field (auto-injected by Flask-WTF)
3. JavaScript apps include `X-CSRFToken` header in fetch/AJAX requests
4. Server validates token on POST/PUT/DELETE/PATCH requests
5. Mismatch or missing token → 400 Bad Request

### CSRF Exemptions

**Endpoints exempted from CSRF validation:**
- Universal Process Framework APIs (`/api/upf/*`): JSON-only APIs with CORS preflight checks
- Auth JSON endpoints: `/auth/api_login`, `/auth/api_signup`, `/auth/api_forgot_password`
- Compatibility routes: `/api/login`, `/api/signup`, `/api/forgot_password`

**Rationale:**
- JSON APIs are accessed via `fetch()` without traditional form submissions
- CORS policy restricts origins to trusted domains
- Exemptions are explicit via `csrf.exempt(blueprint)` or `csrf.exempt(view_function)`

**Security Note:**
- CSRF exemptions are safe only when combined with strict CORS policy and origin validation
- Never exempt endpoints that accept cookie-based auth without additional origin checks

---

## 3. CORS (Cross-Origin Resource Sharing)

### Policy

**Development:**
```python
CORS(app, supports_credentials=True, 
     origins=["http://127.0.0.1:5000"],
     allow_headers=["Content-Type", "X-CSRFToken"],
     methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"])
```

**Production:**
```python
CORS(app, supports_credentials=True, 
     origins=[app.config.get('BASE_URL', 'https://yourdomain.com')],
     allow_headers=["Content-Type", "X-CSRFToken"],
     methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"])
```

**Key Settings:**
- `supports_credentials=True`: Allows cookies (session, CSRF) in cross-origin requests
- `origins`: Whitelist of allowed origins (never use `*` in production with credentials)
- `allow_headers`: Explicitly allows `X-CSRFToken` for JavaScript clients
- `methods`: Standard HTTP verbs (no unsafe methods like TRACE)

### Preflight Requests

**OPTIONS requests handled automatically by Flask-CORS:**
- Browser sends OPTIONS preflight before POST/PUT/DELETE with custom headers
- Server responds with `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods`, etc.
- If preflight succeeds, browser sends actual request

**Example:**
```http
OPTIONS /api/upf/processes HTTP/1.1
Origin: http://127.0.0.1:5000
Access-Control-Request-Method: POST
Access-Control-Request-Headers: Content-Type, X-CSRFToken

HTTP/1.1 200 OK
Access-Control-Allow-Origin: http://127.0.0.1:5000
Access-Control-Allow-Credentials: true
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Allow-Headers: Content-Type, X-CSRFToken
```

---

## 4. Secrets Management

### Environment Variables

**Never hardcode secrets in source code.** All sensitive configuration stored in environment variables:

**Required Secrets:**
- `SECRET_KEY`: Flask session signing key (64+ random characters)
- `DATABASE_URL`: PostgreSQL connection string with credentials
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`: OAuth credentials
- `REDIS_URL`: Redis connection string (for rate limiting in production)

**Optional Secrets:**
- `JWT_SECRET_KEY`: If using JWT for API tokens (not currently implemented)
- `SMTP_PASSWORD`: If sending email for password resets

**Loading Secrets:**
```python
# config.py
import os
SECRET_KEY = os.environ.get('SECRET_KEY') or 'fallback-dev-key'
```

**Production Example (.env file via python-dotenv):**
```bash
SECRET_KEY=0x3f8a2b...c7d9e1f4  # 64 hex chars
DATABASE_URL=postgresql://user:password@host:5432/dbname
GOOGLE_CLIENT_ID=123456789.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-abc123...xyz789
```

### Secrets Scanning

**Pre-commit hook: `detect-secrets`**
- Scans staged files for hardcoded secrets (API keys, passwords, tokens)
- Baseline: `.secrets.baseline` (false positives excluded)
- Excluded: Test files (may contain fake credentials for testing)

**To update baseline after legitimate changes:**
```powershell
detect-secrets scan --baseline .secrets.baseline
```

**To audit new secrets:**
```powershell
detect-secrets audit .secrets.baseline
```

---

## 5. Secure Defaults

### Session Cookies

**Production:**
```python
SESSION_COOKIE_SECURE = True      # HTTPS-only
SESSION_COOKIE_HTTPONLY = True    # No JavaScript access
SESSION_COOKIE_SAMESITE = 'Strict'  # No cross-site requests
```

**Development:**
```python
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = 'Lax'   # Allow same-site navigation
```

### URL Scheme

**Force HTTPS in production:**
```python
if app.config.get('BASE_URL', '').startswith('https://'):
    app.config['PREFERRED_URL_SCHEME'] = 'https'
```

This ensures `url_for(..., _external=True)` generates HTTPS URLs even behind a reverse proxy.

### Proxy Support

**ProxyFix middleware** corrects `X-Forwarded-*` headers when behind a reverse proxy (Nginx, AWS ALB):
```python
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_port=1)
```

**Security Note:** Only enable ProxyFix when behind a trusted proxy; otherwise, clients can spoof headers.

---

## 6. Input Validation & SQL Injection Prevention

### Parameterized Queries

**Always use parameterized queries (never string concatenation):**

**Bad:**
```python
cur.execute(f"SELECT * FROM users WHERE email = '{email}'")  # SQL injection!
```

**Good:**
```python
cur.execute("SELECT * FROM users WHERE email = %s", (email,))
```

### Validator Layer

**All user input validated via `app/validators/`:**
- `import_validators.py`: CSV import data
- Custom validation for process/subprocess/variant creation

**Example:**
```python
def validate_email(email: str) -> bool:
    import re
    return bool(re.match(r'^[\w\.-]+@[\w\.-]+\.\w+$', email))
```

### File Upload Validation

**`app/utils/file_validation.py`:**
- MIME type validation (via `python-magic`)
- File extension allowlist (`.csv`, `.xlsx`, `.pdf`, `.jpg`, `.png`)
- File size limits (configurable, default 10MB)
- Virus scanning (optional integration via `virus_scan.py`)

**Never trust user-supplied filenames:** Sanitize before saving to disk.

---

## 7. Rate Limiting

### Flask-Limiter

**Default Limits:**
- 200 requests per day (global)
- 50 requests per hour (global)
- Specific endpoints: Custom limits (e.g., `/auth/login`: 5/minute)

**Backend:**
- **Production:** Redis-backed (`RATELIMIT_STORAGE_URL`)
- **Testing:** In-memory (`storage_uri='memory://'`)

**Headers:**
```http
X-RateLimit-Limit: 50
X-RateLimit-Remaining: 47
X-RateLimit-Reset: 1699200000
```

**Exceeded Limit:**
```http
HTTP/1.1 429 Too Many Requests
Retry-After: 3600
```

**Bypass (Testing):**
```python
limiter.enabled = False  # In test fixtures
```

---

## 8. Logging & Audit Trail

### Application Logs

**Location:** `logs/app.log` (rotating file, 10MB max, 5 backups)

**Sensitive Data Exclusion:**
- Never log passwords, tokens, or full credit card numbers
- Request IDs included for tracing (see `docs/LOGGING.md`)

**Example:**
```python
app.logger.info(f"User {user_id} logged in successfully")  # OK
app.logger.debug(f"Password: {password}")  # NEVER DO THIS
```

### Audit Log (Database)

**Table:** `audit_log`
- Tracks critical actions: user creation, role changes, process modifications
- Fields: `user_id`, `action`, `entity_type`, `entity_id`, `timestamp`, `ip_address`, `changes` (JSON)

**Example:**
```python
AuditService.log(
    user_id=current_user.id,
    action='update',
    entity_type='process',
    entity_id=process_id,
    changes={'name': {'old': 'Old Name', 'new': 'New Name'}}
)
```

---

## 9. Dependency Security

### Bandit (Security Linter)

**Pre-commit hook scans for:**
- Hardcoded passwords (B105, B106)
- SQL injection risks (B608)
- Use of `exec()` or `eval()` (B102, B307)
- Insecure deserialization (B301, B302, B403)
- Weak crypto (B303, B304, B305, B306, B308)

**Excluded:** Test files (asserts, subprocess calls are valid in tests)

**Run manually:**
```powershell
bandit -r Project-root/app -c pyproject.toml
```

### Ruff Security Rules

**Pre-commit hook includes `-S` rules:**
- S001-S999: Security-focused checks (SQL injection, assert usage, hardcoded secrets)
- Overlaps with Bandit but runs faster (Rust-based)

### Dependency Scanning

**Recommended (not yet implemented):**
- `pip-audit`: Scan `requirements.txt` for known CVEs
- Dependabot / Snyk: Automated PR for vulnerable dependencies

**Run manually:**
```powershell
pip install pip-audit
pip-audit
```

---

## 10. Security Checklist

### Pre-Deployment
- [ ] `SECRET_KEY` is 64+ random characters (not default/example value)
- [ ] `DATABASE_URL` uses strong password (20+ chars, mixed case, symbols)
- [ ] `GOOGLE_CLIENT_SECRET` restricted to production redirect URI
- [ ] `SESSION_COOKIE_SECURE=True` (HTTPS enforced)
- [ ] CORS origins whitelist production domain only (no wildcards)
- [ ] All database queries use parameterized placeholders
- [ ] File uploads validated (MIME type, extension, size)
- [ ] Rate limiting enabled with Redis backend
- [ ] Logs exclude sensitive data (passwords, tokens, PII)
- [ ] Pre-commit hooks installed (`pre-commit install`)
- [ ] Dependencies audited (`pip-audit`)

### Ongoing Monitoring
- [ ] Review `audit_log` table weekly for suspicious activity
- [ ] Monitor failed login attempts (potential brute force)
- [ ] Check Redis health (rate limiter uptime)
- [ ] Rotate `SECRET_KEY` annually (invalidates sessions—plan maintenance window)
- [ ] Update dependencies monthly (security patches)

---

## 11. Incident Response

### Reporting Vulnerabilities

**DO NOT open public GitHub issues for security vulnerabilities.**

**Contact:** Email security contact or project maintainer with:
- Description of vulnerability
- Steps to reproduce
- Impact assessment (CVSS score if known)
- Suggested fix (optional)

**Response Time:**
- Acknowledgment: 48 hours
- Initial triage: 7 days
- Fix timeline: 30 days (critical), 90 days (medium)

### Disclosure Policy

- Coordinated disclosure: 90 days from initial report
- Credit given to reporter (if desired)
- CVE ID requested for critical vulnerabilities

---

## 12. Compliance & Standards

**Frameworks:**
- OWASP Top 10 (2021): Covered
  - A01 Broken Access Control: RBAC + auth checks
  - A02 Cryptographic Failures: Secure password hashing, HTTPS
  - A03 Injection: Parameterized queries
  - A04 Insecure Design: Defense in depth (CSRF + CORS + rate limits)
  - A05 Security Misconfiguration: Secure defaults, no debug in prod
  - A06 Vulnerable Components: Dependency scanning
  - A07 Authentication Failures: Strong passwords, account lockout (future)
  - A08 Software Integrity Failures: Code review, version control
  - A09 Logging Failures: Comprehensive logging, audit trail
  - A10 SSRF: No user-controlled URLs in HTTP requests

**Compliance (Future):**
- GDPR: User data export/deletion endpoints (not yet implemented)
- SOC 2 Type II: Audit logs, access reviews (in progress)
- PCI DSS: Not applicable (no credit card storage)

---

## 13. References

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Flask Security Best Practices](https://flask.palletsprojects.com/en/stable/security/)
- [NIST Password Guidelines](https://pages.nist.gov/800-63-3/sp800-63b.html)
- [CWE/SANS Top 25 Software Errors](https://cwe.mitre.org/top25/)

---

**Last Updated:** November 2025  
**Next Review:** May 2026
