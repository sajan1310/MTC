# GitHub Actions Workflows Documentation

This directory contains GitHub Actions workflows that automate the build, test, and validation processes for the MTC Flask application.

## 📋 Table of Contents

- [Overview](#overview)
- [Workflows](#workflows)
  - [CI Pipeline](#ci-pipeline-ciyml)
  - [Test Suite](#test-suite-testyml)
- [Configuration](#configuration)
- [Secrets Required](#secrets-required)
- [Usage Guide](#usage-guide)
- [Troubleshooting](#troubleshooting)

---

## Overview

The MTC project uses two main GitHub Actions workflows:

1. **CI Pipeline** (`ci.yml`) - Comprehensive continuous integration with linting, security checks, build validation, and testing
2. **Test Suite** (`test.yml`) - Dedicated testing workflow with detailed coverage reporting and matrix testing

Both workflows are designed to:
- ✅ Provide fast feedback on code quality
- 🔒 Ensure security through dependency scanning
- 🧪 Maintain code coverage standards
- 🚀 Enable confident deployments
- 📊 Generate detailed reports and artifacts

---

## Workflows

### CI Pipeline (`ci.yml`)

**Purpose**: Automated continuous integration that validates every push and pull request.

**Triggers**:
- Push to `main` or `develop` branches
- Pull requests to `main` or `develop` branches

**Jobs**:

#### 1. **Lint** - Code Quality Checks
- Runs Ruff linter on all Python code
- Checks code formatting
- Fails on critical linting errors
- **Runtime**: ~1-2 minutes

#### 2. **Security** - Vulnerability Scanning
- Uses `pip-audit` to scan dependencies
- Identifies known security vulnerabilities
- Generates JSON security report
- **Runtime**: ~2-3 minutes
- **Artifact**: `security-report.json`

#### 3. **Build** - Build Validation
- Verifies all dependencies install correctly
- Checks for Python syntax errors
- Validates Flask application structure
- **Runtime**: ~2-3 minutes
- **Depends on**: Lint job must pass first

#### 4. **Test** - Test Execution
- Runs full test suite with coverage
- Matrix testing across Python 3.10, 3.11, and 3.12
- PostgreSQL integration tests
- Coverage threshold validation (25% minimum)
- **Runtime**: ~5-7 minutes per Python version
- **Depends on**: Build job must pass first
- **Artifacts**: Coverage reports (XML, HTML)

**Features**:
- 🎯 Parallel job execution (lint and security run simultaneously)
- 💾 Dependency caching for faster builds
- 🔄 Concurrency control (cancels outdated runs)
- 📦 Artifact uploads for debugging
- 🎨 GitHub Actions annotations for errors

**Example Run Time**: ~8-10 minutes total

---

### Test Suite (`test.yml`)

**Purpose**: Focused testing with comprehensive coverage and detailed reporting.

**Triggers**:
- Manual trigger via `workflow_dispatch`
- Push to `main`/`develop` (when Python files change)
- Pull requests (when Python files change)
- Optional: Nightly scheduled runs (commented out by default)

**Jobs**:

#### 1. **Unit Tests** - Fast Feedback
- Runs tests marked with `@pytest.mark.unit`
- No database required
- Quick execution for rapid feedback
- **Runtime**: ~2-3 minutes

#### 2. **Integration Tests** - Database Testing
- Runs tests marked with `@pytest.mark.integration`
- PostgreSQL service container
- Full database integration testing
- **Runtime**: ~3-5 minutes

#### 3. **Full Test Suite** - Comprehensive Coverage
- Runs ALL tests with coverage reporting
- Matrix testing (Python 3.10, 3.11, 3.12)
- Generates detailed coverage reports
- Uploads to Codecov (if configured)
- **Runtime**: ~5-7 minutes per Python version
- **Artifacts**: 
  - `coverage-report-py{version}` - Coverage XML and HTML
  - `test-results-py{version}` - Test execution results

#### 4. **Test Summary** - Reporting
- Aggregates results from all jobs
- Generates GitHub summary
- Lists all artifacts
- Overall pass/fail status
- **Runtime**: ~30 seconds

**Features**:
- 🔀 Three-tier testing strategy (unit → integration → full)
- 📊 Detailed coverage reporting with HTML output
- 🎯 Selective test execution via workflow inputs
- ⏰ Optional scheduled testing
- 📈 Coverage trend tracking via Codecov

**Example Run Time**: ~15-20 minutes total (all matrix combinations)

---

## Configuration

### Environment Variables

Both workflows use these environment variables:

```yaml
DATABASE_URL: postgresql://testuser:testpass@127.0.0.1:5432/testdb
FLASK_ENV: testing
SECRET_KEY: test-secret-key-for-ci
RATELIMIT_STORAGE_URL: memory://
PYTHONIOENCODING: utf-8
```

### Python Versions

Currently testing against:
- Python 3.10
- Python 3.11 (primary)
- Python 3.12

### Coverage Thresholds

- **Minimum Coverage**: 25%
- **Mode**: Soft threshold (warns but doesn't fail)
- **Strict Mode**: Can be enabled via environment variable

---

## Secrets Required

### Required Secrets

None - workflows run with defaults.

### Optional Secrets

Configure these in GitHub Settings → Secrets and variables → Actions:

| Secret | Purpose | Required For |
|--------|---------|--------------|
| `TEST_SECRET_KEY` | Flask secret key for testing | Enhanced security |
| `CODECOV_TOKEN` | Upload coverage to Codecov | Coverage tracking |
| `DATABASE_URL` | Override default test database | Custom DB testing |

### Adding Secrets

1. Navigate to your repository on GitHub
2. Click **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Add the secret name and value
5. Click **Add secret**

---

## Usage Guide

### Running Workflows

#### Automatic Triggers

Both workflows run automatically on:
```bash
# Push to main or develop
git push origin main

# Create a pull request
gh pr create --base main
```

#### Manual Trigger (Test Workflow Only)

Run the test workflow manually:

1. Go to **Actions** tab in GitHub
2. Select **Test Suite** workflow
3. Click **Run workflow**
4. Optional: Specify Python version or test pattern
5. Click **Run workflow** button

**CLI Method**:
```bash
# Run all tests
gh workflow run test.yml

# Run specific Python version
gh workflow run test.yml -f python-version=3.11

# Run specific tests
gh workflow run test.yml -f test-pattern=test_auth.py
```

### Viewing Results

#### Workflow Status

- **GitHub UI**: Actions tab shows all workflow runs
- **Pull Requests**: Status checks appear on PR page
- **Badges**: Add status badges to README

#### Artifacts

Download artifacts from completed runs:

```bash
# List artifacts
gh run list --workflow=ci.yml

# Download coverage report
gh run download <run-id>
```

#### Coverage Reports

1. **GitHub Artifacts**: Download HTML coverage from artifacts
2. **Codecov**: View at https://codecov.io/gh/YOUR_ORG/MTC (if configured)
3. **PR Comments**: Coverage changes appear in PR (if Codecov configured)

---

## Troubleshooting

### Common Issues

#### ❌ Lint Job Fails

**Error**: `Ruff found linting errors`

**Solution**:
```bash
# Run locally
cd Project-root
ruff check . --fix

# Check formatting
ruff format .
```

#### ❌ Security Scan Reports Vulnerabilities

**Error**: `pip-audit found vulnerabilities`

**Solution**:
```bash
# Review locally
pip-audit -r Project-root/requirements.txt

# Update vulnerable packages
pip install --upgrade <package-name>
```

#### ❌ Tests Fail - Database Connection

**Error**: `could not connect to server`

**Solution**:
- Check PostgreSQL service health in workflow logs
- Verify `DATABASE_URL` environment variable
- Ensure tests use correct database connection

#### ❌ Coverage Below Threshold

**Warning**: `Coverage X% is below threshold 25%`

**Solution**:
```bash
# Run coverage locally
cd Project-root
pytest --cov=app --cov-report=html

# View HTML report
open htmlcov/index.html  # macOS
start htmlcov/index.html  # Windows
```

#### ❌ Dependency Installation Fails

**Error**: `Could not install packages`

**Solution**:
1. Check `requirements.txt` for syntax errors
2. Verify package versions are compatible
3. Check for platform-specific dependencies

### Debug Mode

Enable debug logging in workflows:

1. Go to **Settings** → **Secrets and variables** → **Actions**
2. Add variable: `ACTIONS_STEP_DEBUG` = `true`
3. Re-run workflow for detailed logs

### Local Testing

Test workflows locally using [act](https://github.com/nektos/act):

```bash
# Install act
# macOS: brew install act
# Windows: choco install act-cli

# Run CI workflow
act push

# Run test workflow
act workflow_dispatch -W .github/workflows/test.yml

# Run specific job
act -j test
```

---

## Workflow Optimization

### Caching Strategy

Both workflows use pip caching:

```yaml
- uses: actions/setup-python@v5
  with:
    cache: 'pip'
    cache-dependency-path: 'Project-root/requirements.txt'
```

**Benefits**:
- ⚡ 50-70% faster dependency installation
- 💰 Reduced GitHub Actions minutes usage
- 🔄 Automatic cache invalidation on requirements change

### Concurrency Control

Prevents wasted resources:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

**Effect**: Cancels outdated workflow runs when new commits are pushed

### Matrix Strategy

Parallel testing across Python versions:

```yaml
strategy:
  matrix:
    python-version: ['3.10', '3.11', '3.12']
```

**Runtime**: All versions run in parallel (~7 minutes) instead of sequential (~21 minutes)

---

## Best Practices

### For Developers

1. **Run tests locally** before pushing:
   ```bash
   cd Project-root
   pytest --cov=app
   ruff check .
   ```

2. **Check workflow status** in PRs before merging

3. **Review artifacts** when tests fail for detailed debugging

4. **Keep dependencies updated** to avoid security warnings

### For Maintainers

1. **Monitor workflow run times** - optimize if exceeding 15 minutes
2. **Review security reports** weekly
3. **Update action versions** quarterly
4. **Adjust coverage thresholds** as codebase matures
5. **Enable scheduled runs** for nightly regression testing

---

## Advanced Configuration

### Enable Scheduled Testing

Uncomment in `test.yml`:

```yaml
schedule:
  - cron: '0 2 * * *'  # 2 AM UTC daily
```

### Strict Coverage Mode

Enable hard coverage threshold:

```yaml
env:
  MIN_COVERAGE: 25
  STRICT_MODE: true  # Fail if below threshold
```

### Custom Test Patterns

Run specific tests manually:

```bash
gh workflow run test.yml -f test-pattern="test_auth or test_api"
```

### Notification Setup

Add Slack/Discord notifications:

```yaml
- name: Notify on failure
  if: failure()
  uses: 8398a7/action-slack@v3
  with:
    status: ${{ job.status }}
```

---

## Resources

- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [pytest Documentation](https://docs.pytest.org/)
- [Ruff Documentation](https://docs.astral.sh/ruff/)
- [pip-audit Documentation](https://pypi.org/project/pip-audit/)
- [Codecov Documentation](https://docs.codecov.com/)

---

## Support

For issues or questions:

1. Check the [Troubleshooting](#troubleshooting) section
2. Review workflow logs in the Actions tab
3. Open an issue in the repository
4. Contact the maintainers

---

**Last Updated**: November 2025  
**Maintained By**: MTC Development Team
