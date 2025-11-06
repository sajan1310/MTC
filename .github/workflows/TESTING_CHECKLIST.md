# GitHub Actions Workflow Testing Checklist

Use this checklist to verify that the CI/CD workflows are functioning correctly.

---

## 📋 Pre-Deployment Checklist

### 1. Local Validation

- [ ] Validate YAML syntax locally
  ```bash
  python .github/workflows/simple_validate.py
  ```

- [ ] Run tests locally to ensure they pass
  ```bash
  cd Project-root
  pytest --cov=app --cov-report=term-missing
  ```

- [ ] Run linter locally
  ```bash
  ruff check Project-root/
  ruff format --check Project-root/
  ```

- [ ] Check for security vulnerabilities
  ```bash
  pip-audit -r Project-root/requirements.txt
  ```

### 2. Repository Configuration

- [ ] Verify workflows are in correct location
  - `.github/workflows/ci.yml` ✅
  - `.github/workflows/test.yml` ✅

- [ ] Check branch names match triggers
  - `main` branch exists ✅
  - `develop` branch exists (optional)

- [ ] Review required secrets (optional but recommended)
  - [ ] `TEST_SECRET_KEY` - For enhanced security
  - [ ] `CODECOV_TOKEN` - For coverage tracking

---

## 🧪 Testing Workflow Execution

### Test 1: CI Workflow - Push to Main

**Purpose**: Verify CI runs on main branch push

**Steps**:
1. [ ] Make a small change (e.g., add comment to README)
2. [ ] Commit and push to main
   ```bash
   git add README.md
   git commit -m "test: trigger CI workflow"
   git push origin main
   ```
3. [ ] Go to Actions tab on GitHub
4. [ ] Verify "CI Pipeline" workflow started
5. [ ] Wait for completion (~8-10 minutes)

**Expected Results**:
- [ ] ✅ Lint job passes
- [ ] ⚠️ Security job completes (may have warnings)
- [ ] ✅ Build job passes
- [ ] ✅ Test job passes (all 3 Python versions)
- [ ] 📦 Artifacts uploaded (coverage reports)

---

### Test 2: CI Workflow - Pull Request

**Purpose**: Verify CI runs on PR creation

**Steps**:
1. [ ] Create a new branch
   ```bash
   git checkout -b test-ci-workflow
   ```
2. [ ] Make a small change
3. [ ] Push branch
   ```bash
   git push origin test-ci-workflow
   ```
4. [ ] Create pull request
   ```bash
   gh pr create --base main --title "Test CI Workflow"
   ```
5. [ ] Check PR status checks

**Expected Results**:
- [ ] ✅ CI workflow runs automatically
- [ ] ✅ Status checks appear on PR
- [ ] ✅ All jobs pass
- [ ] 📝 Coverage report visible (if Codecov configured)

---

### Test 3: Test Workflow - Manual Trigger

**Purpose**: Verify test workflow can be triggered manually

**Steps**:
1. [ ] Go to Actions tab on GitHub
2. [ ] Select "Test Suite" workflow
3. [ ] Click "Run workflow"
4. [ ] Leave inputs empty
5. [ ] Click "Run workflow" button
6. [ ] Wait for completion (~15-20 minutes)

**Expected Results**:
- [ ] ✅ Unit tests complete
- [ ] ✅ Integration tests complete
- [ ] ✅ Full test suite passes (all 3 Python versions)
- [ ] ✅ Test summary generated
- [ ] 📦 Multiple artifacts uploaded

---

### Test 4: Test Workflow - Specific Python Version

**Purpose**: Verify manual workflow inputs work

**Steps**:
1. [ ] Go to Actions → Test Suite → Run workflow
2. [ ] Enter `3.11` for Python version
3. [ ] Run workflow

**Expected Results**:
- [ ] ✅ All jobs run
- [ ] 📦 Artifacts named with `py3.11`

---

### Test 5: Linting Failure

**Purpose**: Verify linting job catches errors

**Steps**:
1. [ ] Create test branch
2. [ ] Add intentionally bad code
   ```python
   # In a Python file, add:
   def bad_function( ):
       x=1+1  # Bad formatting
       return x
   ```
3. [ ] Push and create PR

**Expected Results**:
- [ ] ❌ Lint job fails
- [ ] 📝 GitHub annotations show errors
- [ ] ⛔ CI status check fails
- [ ] 🚫 PR cannot be merged

**Cleanup**:
- [ ] Close PR and delete branch

---

### Test 6: Test Failure Handling

**Purpose**: Verify test failures are caught

**Steps**:
1. [ ] Create test branch
2. [ ] Add a failing test
   ```python
   # In tests/test_temp.py
   def test_intentional_failure():
       assert False, "This should fail"
   ```
3. [ ] Push and create PR

**Expected Results**:
- [ ] ❌ Test job fails
- [ ] 📝 Clear error message in logs
- [ ] 📦 Artifacts still uploaded
- [ ] 🚫 PR blocked by failed checks

**Cleanup**:
- [ ] Delete test file
- [ ] Close PR and delete branch

---

### Test 7: Coverage Threshold

**Purpose**: Verify coverage threshold warnings

**Steps**:
1. [ ] Check current coverage in latest run
2. [ ] If coverage is low (<25%), verify warning appears
3. [ ] Check workflow logs for coverage message

**Expected Results**:
- [ ] 📊 Coverage percentage shown in logs
- [ ] ⚠️ Warning if below threshold
- [ ] ✅ Job still passes (soft threshold)

---

### Test 8: Artifact Downloads

**Purpose**: Verify artifacts are accessible

**Steps**:
1. [ ] Find a completed workflow run
2. [ ] Scroll to Artifacts section
3. [ ] Download coverage report
   ```bash
   gh run download <run-id> -n coverage-py3.11
   ```
4. [ ] Extract and view HTML report

**Expected Results**:
- [ ] 📦 Artifact downloads successfully
- [ ] 📊 HTML coverage report opens in browser
- [ ] 📄 coverage.xml file present

---

### Test 9: Concurrency Control

**Purpose**: Verify old runs are cancelled

**Steps**:
1. [ ] Push commit to branch
2. [ ] Wait 10 seconds
3. [ ] Push another commit to same branch
4. [ ] Check Actions tab

**Expected Results**:
- [ ] 🚫 First workflow run cancelled
- [ ] ✅ Second workflow run continues
- [ ] 💰 Saves GitHub Actions minutes

---

### Test 10: Caching Effectiveness

**Purpose**: Verify dependency caching works

**Steps**:
1. [ ] Note first run time for a workflow
2. [ ] Push another commit (no requirements.txt changes)
3. [ ] Compare run times

**Expected Results**:
- [ ] ⚡ Second run is faster (~50-70% improvement)
- [ ] 📝 Logs show "Cache restored" message
- [ ] ✅ All dependencies still installed correctly

---

## 🔍 Validation Checks

### After All Tests Complete

- [ ] Review workflow run history
  ```bash
  gh run list --workflow=ci.yml --limit 10
  ```

- [ ] Check success rate
  ```bash
  gh run list --workflow=ci.yml --json conclusion
  ```

- [ ] Verify artifacts are being stored
  ```bash
  gh run list --workflow=ci.yml --limit 1
  gh run view <run-id>
  ```

- [ ] Check total run times meet expectations
  - CI: ~8-10 minutes ✅
  - Test: ~15-20 minutes ✅

- [ ] Confirm caching is reducing run times ✅

- [ ] Verify security reports are generated ✅

---

## 📊 Performance Benchmarks

Record these metrics from your test runs:

| Workflow | Job | First Run | Cached Run | Target |
|----------|-----|-----------|------------|--------|
| CI | Lint | _____ min | _____ min | 1-2 min |
| CI | Security | _____ min | _____ min | 2-3 min |
| CI | Build | _____ min | _____ min | 2-3 min |
| CI | Test (3.11) | _____ min | _____ min | 5-7 min |
| **Total CI** | | _____ min | _____ min | **8-10 min** |
| Test | Unit | _____ min | _____ min | 2-3 min |
| Test | Integration | _____ min | _____ min | 3-5 min |
| Test | Full (3.11) | _____ min | _____ min | 5-7 min |
| **Total Test** | | _____ min | _____ min | **15-20 min** |

---

## 🎯 Success Criteria

All tests must meet these criteria:

### CI Workflow
- [x] Runs on push to main/develop
- [x] Runs on pull requests
- [x] Lint job catches formatting issues
- [x] Security scan generates reports
- [x] Build validation passes
- [x] Tests pass on Python 3.10, 3.11, 3.12
- [x] Coverage reports uploaded
- [x] Total runtime < 15 minutes

### Test Workflow
- [x] Manual trigger works
- [x] Input parameters work correctly
- [x] Unit tests run independently
- [x] Integration tests use PostgreSQL
- [x] Full test suite generates coverage
- [x] Test summary aggregates results
- [x] All artifacts uploaded correctly

### General
- [x] YAML syntax is valid
- [x] No hardcoded secrets
- [x] Caching works effectively
- [x] Concurrency control functions
- [x] Error messages are clear
- [x] Artifacts accessible and useful

---

## 🐛 Known Issues / Notes

Record any issues discovered during testing:

| Issue | Severity | Status | Notes |
|-------|----------|--------|-------|
| | | | |
| | | | |
| | | | |

---

## ✅ Final Approval

Once all tests pass:

- [ ] All checklist items completed
- [ ] Performance benchmarks within targets
- [ ] No critical issues found
- [ ] Documentation reviewed and accurate
- [ ] Team trained on workflow usage

**Approved By**: _________________  
**Date**: _________________  
**Status**: ⬜ Pending / ⬜ Approved / ⬜ Needs Work

---

## 📞 Support

If any tests fail:

1. Check workflow logs in Actions tab
2. Review error messages carefully
3. Consult `.github/workflows/README.md`
4. Check `.github/workflows/QUICK_REFERENCE.md`
5. Run validation script locally
6. Review this checklist again

---

**Last Updated**: November 6, 2025  
**Version**: 1.0
