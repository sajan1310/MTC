# GitHub Actions Workflows - Quick Reference

## 🚀 Quick Start

### View Workflow Status
```bash
# All workflows
gh run list

# Specific workflow
gh run list --workflow=ci.yml
gh run list --workflow=test.yml

# Watch current run
gh run watch
```

### Manual Test Execution
```bash
# Run all tests
gh workflow run test.yml

# Specific Python version
gh workflow run test.yml -f python-version=3.11

# Specific test file
gh workflow run test.yml -f test-pattern=test_auth.py
```

### Download Artifacts
```bash
# List available artifacts
gh run list --workflow=ci.yml --limit 1
gh run view <run-id>

# Download specific artifact
gh run download <run-id> -n coverage-py3.11

# Download all artifacts
gh run download <run-id>
```

---

## 📊 Workflow Structure

### CI Pipeline (ci.yml)

```
┌─────────────────────────────────────────┐
│           CI Pipeline                   │
├─────────────────────────────────────────┤
│                                         │
│  ┌──────────┐      ┌──────────┐       │
│  │   Lint   │      │ Security │       │
│  └─────┬────┘      └──────────┘       │
│        │                                │
│  ┌─────▼────┐                          │
│  │  Build   │                          │
│  └─────┬────┘                          │
│        │                                │
│  ┌─────▼────┐                          │
│  │   Test   │ (Matrix: 3.10, 3.11, 3.12)│
│  └──────────┘                          │
│                                         │
└─────────────────────────────────────────┘
```

**Total Runtime**: ~8-10 minutes

### Test Suite (test.yml)

```
┌──────────────────────────────────────────────┐
│              Test Suite                      │
├──────────────────────────────────────────────┤
│                                              │
│  ┌────────────┐  ┌──────────────┐          │
│  │ Unit Tests │  │ Integration  │          │
│  │ (Parallel) │  │    Tests     │          │
│  └────────────┘  └──────────────┘          │
│                                              │
│         ┌──────────────────┐                │
│         │  Full Test Suite │                │
│         │ (Matrix Testing) │                │
│         └─────────┬────────┘                │
│                   │                          │
│         ┌─────────▼────────┐                │
│         │  Test Summary    │                │
│         └──────────────────┘                │
│                                              │
└──────────────────────────────────────────────┘
```

**Total Runtime**: ~15-20 minutes

---

## 🎯 Common Commands

### Local Development

```bash
# Run linter
cd Project-root
ruff check .
ruff check . --fix  # Auto-fix issues
ruff format .       # Format code

# Run security scan
pip-audit -r requirements.txt

# Run tests
pytest
pytest --cov=app
pytest --cov=app --cov-report=html

# Run specific test
pytest tests/test_auth.py
pytest tests/test_auth.py::test_login
pytest -m unit  # Unit tests only
pytest -m integration  # Integration tests only
```

### Workflow Management

```bash
# Enable workflow
gh workflow enable ci.yml

# Disable workflow
gh workflow disable test.yml

# View workflow definition
gh workflow view ci.yml

# Cancel running workflow
gh run cancel <run-id>

# Re-run failed jobs
gh run rerun <run-id> --failed

# Re-run entire workflow
gh run rerun <run-id>
```

---

## 📦 Artifacts Reference

### CI Workflow Artifacts

| Artifact Name | Contents | Retention |
|--------------|----------|-----------|
| `security-report` | JSON security scan results | 30 days |
| `coverage-py{version}` | Coverage XML + HTML report | 30 days |

### Test Workflow Artifacts

| Artifact Name | Contents | Retention |
|--------------|----------|-----------|
| `coverage-report-py{version}` | Full coverage reports | 30 days |
| `test-results-py{version}` | Pytest cache and results | 14 days |

### Downloading Artifacts

```bash
# Via CLI
gh run download <run-id> -n coverage-py3.11

# Via Web
Actions → Workflow Run → Artifacts section → Download

# Programmatically
curl -L \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  https://api.github.com/repos/OWNER/REPO/actions/artifacts/ARTIFACT_ID/zip \
  -o artifact.zip
```

---

## 🔧 Environment Variables

### CI Workflow

```yaml
DATABASE_URL: postgresql://testuser:testpass@127.0.0.1:5432/testdb
FLASK_ENV: testing
SECRET_KEY: ${{ secrets.TEST_SECRET_KEY || 'test-secret-key-for-ci' }}
RATELIMIT_STORAGE_URL: memory://
PYTHONIOENCODING: utf-8
```

### Test Workflow

```yaml
DATABASE_URL: postgresql://testuser:testpass@127.0.0.1:5432/testdb
FLASK_ENV: testing
SECRET_KEY: test-secret-integration
RATELIMIT_STORAGE_URL: memory://
PYTHONIOENCODING: utf-8
MIN_COVERAGE: 25
STRICT_MODE: false
```

---

## 🎭 Matrix Testing

### Python Versions

```yaml
matrix:
  python-version: ['3.10', '3.11', '3.12']
```

**Coverage**: Tests run on all supported Python versions

### Adding New Version

1. Edit workflow file
2. Add version to matrix
3. Update documentation
4. Test locally first

---

## 🐛 Troubleshooting Guide

### Workflow Fails Immediately

```bash
# Check syntax
gh workflow view ci.yml

# Check recent runs
gh run list --workflow=ci.yml --limit 5

# View failure logs
gh run view <run-id> --log-failed
```

### Linting Failures

```bash
# Check locally
ruff check Project-root/ --output-format=github

# Auto-fix
ruff check Project-root/ --fix

# Check formatting
ruff format --check Project-root/
```

### Test Failures

```bash
# Run same test locally
cd Project-root
pytest tests/test_that_failed.py -v

# With database
DATABASE_URL=postgresql://user:pass@localhost/testdb pytest

# Debug mode
pytest --pdb tests/test_that_failed.py
```

### Coverage Issues

```bash
# Generate local report
pytest --cov=app --cov-report=html

# View in browser
start htmlcov/index.html  # Windows
open htmlcov/index.html   # macOS

# Missing coverage
pytest --cov=app --cov-report=term-missing
```

### Database Connection Issues

```bash
# Check PostgreSQL service
psql "postgresql://testuser:testpass@localhost:5432/testdb" -c '\q'

# Create test database
createdb -U testuser testdb

# Reset database
dropdb testdb && createdb testdb
```

---

## 📊 Status Badges

Add to your README.md:

### CI Status
```markdown
![CI](https://github.com/YOUR_ORG/MTC/actions/workflows/ci.yml/badge.svg)
```

### Test Status
```markdown
![Tests](https://github.com/YOUR_ORG/MTC/actions/workflows/test.yml/badge.svg)
```

### Coverage
```markdown
[![codecov](https://codecov.io/gh/YOUR_ORG/MTC/branch/main/graph/badge.svg)](https://codecov.io/gh/YOUR_ORG/MTC)
```

---

## ⚡ Performance Tips

### Speed Up Workflows

1. **Use caching** (already enabled)
2. **Limit matrix** to essential versions
3. **Run fast jobs first** (lint before test)
4. **Use fail-fast: false** for better feedback
5. **Parallelize** independent jobs

### Reduce GitHub Actions Minutes

1. **Cancel outdated runs** (concurrency control enabled)
2. **Skip redundant workflows** (path filters configured)
3. **Use self-hosted runners** for high volume
4. **Cache dependencies** (pip cache enabled)

---

## 🔐 Security Best Practices

### Secrets Management

```bash
# List secrets (names only)
gh secret list

# Set secret
gh secret set TEST_SECRET_KEY

# Delete secret
gh secret delete OLD_SECRET
```

### Security Scanning

```bash
# Manual security audit
pip-audit -r Project-root/requirements.txt

# With auto-fix suggestions
pip-audit -r Project-root/requirements.txt --fix --dry-run

# JSON output
pip-audit -r Project-root/requirements.txt --format json
```

---

## 📈 Monitoring

### Workflow Metrics

```bash
# Recent run times
gh run list --workflow=ci.yml --json createdAt,conclusion,startedAt,updatedAt

# Success rate
gh run list --workflow=ci.yml --json conclusion | jq '[.[] | .conclusion] | group_by(.) | map({key: .[0], value: length}) | from_entries'
```

### Coverage Trends

Use Codecov or similar service for:
- Coverage over time
- Coverage per PR
- Uncovered lines
- Coverage diff

---

## 🎓 Learning Resources

- [GitHub Actions Docs](https://docs.github.com/en/actions)
- [pytest Best Practices](https://docs.pytest.org/en/stable/goodpractices.html)
- [Ruff Configuration](https://docs.astral.sh/ruff/configuration/)
- [Flask Testing](https://flask.palletsprojects.com/en/latest/testing/)

---

## 📞 Getting Help

1. **Check workflow logs** in Actions tab
2. **Run locally** to reproduce
3. **Review error messages** carefully
4. **Search existing issues** on GitHub
5. **Open new issue** with logs and context

---

**Quick Tip**: Bookmark this page for fast reference during development!
