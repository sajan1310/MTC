# Contributing

Thanks for your interest in improving MTC! This guide helps you set up a local dev environment, run tests, and follow conventions.

## Prerequisites
- Python 3.11+
- PostgreSQL 14+ (for integration tests or local runs)
- Redis (optional; production use). Tests use in-memory rate limiting.

## Quick Start (Windows PowerShell)

```powershell
# Clone and create venv
git clone <repo-url>
cd MTC\Project-root
python -m venv ..\venv2
& ..\venv2\Scripts\Activate.ps1

# Install dependencies and run tests
pip install -r requirements.txt
python -m pytest -q
```

## Project Structure
- app/ — Flask application package (blueprints, services, validators)
- migrations/ — SQL and Python migrations
- tests/ — pytest suites (unit, integration, smoke)

## Coding Conventions
- Responses: use the APIResponse envelope (success, data, message, error).
- Keep services stateless; business logic lives in app/services/*.
- Validators normalize fields (e.g., opening_stock) but maintain compatibility aliases for common import headers (Stock, Color, Size).

## Authentication in Tests
- Production endpoints enforce auth. In TESTING, select endpoints are bypassed to keep tests focused and fast.
- OAuth flows include deterministic short-circuits in TESTING to avoid network flakiness.

## Rate Limiting
- Production: Redis-backed limiter with connection pooling.
- Testing: In-memory limiter via `storage_uri='memory://'` (no warnings; no external deps).

## Running Specific Tests
```powershell
# Single test file
python -m pytest tests\services\test_process_service_coverage.py -q

# Single test
python -m pytest tests\api\test_items.py::test_get_items -q
```

## Running with coverage locally
```powershell
# From Project-root
python -m pytest --cov-report=xml --cov-report=html -q
# See coverage.xml and open htmlcov\index.html in a browser
```

## Submitting Changes
1. Create a feature branch.
2. Add/adjust tests for user-facing changes.
3. Run the full suite and ensure all tests pass.
4. Update CHANGELOG.md when behavior changes or fixes are notable.
5. Open a pull request with a concise description of changes and rationale.

## Troubleshooting
- Unicode errors on Windows consoles: ensure logs avoid non-ASCII; this repo already avoids emojis in logs.
- If libmagic issues arise on Windows, see python-magic docs. The suite skips the CSV MIME test on Windows.

## Logging Best Practices
- Use appropriate log levels: DEBUG for dev, INFO for production, ERROR for failures.
- Include request IDs for distributed tracing: `from app.middleware import get_request_id`.
- Avoid logging secrets or PII.
- See `docs/LOGGING.md` for detailed configuration and structured logging examples.

## Performance Optimization
- Always use indexes for frequently queried columns (WHERE, JOIN, ORDER BY).
- Test slow queries with `EXPLAIN ANALYZE` before deploying.
- Avoid N+1 queries: use bulk fetches or eager loading.
- See `docs/PERFORMANCE.md` for index audit, EXPLAIN examples, and query patterns.

## Security Best Practices
- **Never commit secrets:** All credentials go in `.env` files (excluded from git).
- **Pre-commit hooks:** detect-secrets, Bandit, and Ruff security rules run automatically.
- **Parameterized queries:** Always use `%s` placeholders (never f-strings with user input).
- **Report vulnerabilities privately:** Email maintainers—do not open public issues for security bugs.
- See `docs/SECURITY.md` for CSRF/CORS policies, password requirements, OAuth flow, and incident response.

## Optional: pre-commit hooks
To apply basic hygiene checks and Ruff auto-fixes on commit:

```powershell
pip install pre-commit
pre-commit install
# Run on all files once
pre-commit run --all-files
```
