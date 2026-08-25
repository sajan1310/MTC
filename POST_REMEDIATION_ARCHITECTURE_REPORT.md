# Post-Remediation Architecture Report

**Application** Maharaja Bikes ERP (MTC)
**Baseline** `APPLICATION_ARCHITECTURE_AND_PRODUCT_READINESS_AUDIT.md` — 24 Aug 2026, verdict **NO-GO**
**This pass** 25 Aug 2026
**Tracker** `AUDIT_REMEDIATION_STATUS.md` · **Deployment** `PRODUCTION_REMEDIATION_RUNBOOK.md`

---

## 1. Executive summary

**All four P0 findings are closed, each with a test that fails against the old
code.** The application no longer has an authentication bypass, no longer
hands out privileged accounts to anyone who can reach the login page, no
longer accepts an OAuth callback with no CSRF protection, and — for the first
time — produces backups that have been *demonstrated* to restore.

That last one is the finding I would have been least comfortable leaving. The
old backup system wrote hand-rolled `INSERT` statements with no schema, no
sequences, `public.users` omitted entirely, JSONB serialised as Python `repr`,
and a per-table failure written into the output file as a comment while the run
still reported success. A snapshot from the new engine now restores into an
empty database with **101 of 101 tables present and zero row-count
mismatches**, `pg_restore --exit-on-error` exiting 0, JSONB byte-identical, and
103 sequences restored. That is verified by an automated test, not by
inspection.

**Phase 1's correctness work is also done.** The dispatch over-allocation race
is closed: every availability-consuming path now takes a transaction-scoped
advisory lock before it reads the number it is about to act on. Mutation
idempotency is atomic — the id is claimed *before* execution rather than
recorded after it, and the client mints one id per user action instead of per
network call, which is what makes double-submit protection real on desktop
rather than a disabled button. Both are held by 17 concurrency tests, a
category that did not exist before.

Beyond that: stored XSS closed with regression tests, the whole business API
brought under per-user rate limiting, reset tokens made single-use with session
invalidation, the Redis pool no longer destroyed on every request, migrations
serialised by an advisory lock, client requests given a timeout, and the
per-bill-save full-table scan replaced with an indexed lookup.

**The quality gates now work.** 404 frontend tests and three linters that
existed but had never run in CI are now a blocking job; `pip-audit`,
`ruff format` and the coverage check can now fail a build, which none of them
previously could.

**The performance work is measured, and one of its headline numbers was
wrong.** Nested connection acquisition (PERF-003) is closed and now guarded in
CI — a depth check found **326 nested acquisitions across 4 readers**, against
the audit's estimate of 8 sites, and the suite reports 0. The dashboard
(PERF-006) went **796 ms → 466 ms**, with its production derivations
**26.6× faster**. But the audit projected 10–50× for the Current Stock
aggregation and the measured figure is **1.25×**; §6 explains why, and why
that changes what should be done next.

**What is not done is substantial and I want to be direct about it.** Phases 2
through 5 — UX, accessibility, responsive design, and all intelligence and AI
work — are untouched, as is the frontend build step (PERF-004), Decimal money
(MONEY-001) and the audit log (AUDIT-001). Within PERF-002, step 3
(materialised balances) is where the order-of-magnitude lives and it remains
open.

**Verdict: CONDITIONAL GO.** The blockers that made this NO-GO are gone. The
conditions are named in §10.

---

## 2. What changed

### Security

| | Before | After |
|---|---|---|
| `SECRET_KEY` | Fell back to a value committed to this repo; the production guard tested truthiness and so could never fire | No fallback outside `DevelopmentConfig`; guard rejects unset, empty, weak and short values, and never echoes the value into the error |
| Password signup | `role="user"` — immediate unrestricted access to every ledger | `role="pending_approval"`, blocked by the RPC gate; DB column default changed too; `ALLOW_SELF_SIGNUP` kill switch |
| OAuth `state` | Skipped entirely when the session had none — i.e. exactly when it mattered — and skipped under `TESTING`, so untestable | Fails closed on missing *or* mismatched, constant-time compare, and the branch is now exercised by 13 tests |
| Vendor ledger | Six user-controlled fields interpolated raw into `innerHTML`, under a CSP with `'unsafe-inline'` | All escaped; 7 regression tests assert payloads render as text |
| RPC surface | `limiter.exempt(erp_rpc_bp)` — all 166 methods unlimited | Per-**user** tiered limits (per-IP is meaningless behind factory NAT) |
| Reset tokens | Signed-and-timed only: replayable for the full hour, valid even after use, and sessions survived a reset | Bound to a credential fingerprint — using one invalidates it *and* every session pinned to the old credential |
| `DB_PASS` | Defaulted to `"abcd"` | Removed; required by the startup guard |
| `X-Request-ID` | Taken verbatim into logs — newline injection | UUID-parsed or discarded, in **both** competing middlewares |
| Logout | `GET` with no CSRF — an `<img>` tag signed users out | `GET` confirms, `POST` + token acts |

### Data integrity

The backup rewrite is the headline. Also: migrations are serialised by
`pg_advisory_lock` (a data-recalculation migration applied twice produces wrong
money, and the `UNIQUE`-constraint accident that saved it only worked because
every statement happened to be transactional), and deactivation now means the
same thing on all four paths — password login, Google login, password reset,
session loading.

### Reliability

All three OAuth calls have timeouts. `requests` defaults to *no* timeout, and
with four sync gunicorn workers, four users signing in through a slow Google
took the whole ERP offline — including for people not using Google sign-in.
The discovery document is now cached, removing two round trips per login.

### Performance

**Connection handling (PERF-003).** A depth guard in `get_conn`, enabled for
the entire test suite, found **326 nested pooled-connection acquisitions
across 4 distinct readers** — the audit had identified 8 sites by inspection.
All are fixed by passing the held cursor down; the suite now reports zero and
fails if one returns. Profiling had measured **65 ms in `psycopg2._connect`
for a 0.6 ms query** on the Stock path. One exemption is documented and
bounded: the hourly ledger audit holds a transaction-scoped lock across a
five-ledger compute.

**The dashboard (PERF-006), the landing page, on a 5-minute auto-refresh.**
It was fetching every production lot — parsing two JSONB columns per row,
~18,000 `json.loads` calls — to compute four scalars and a pipeline that
discards all non-active lots on its first line. Now: SQL aggregates for the
counts, and only active lots fetched for the pipeline, with only the columns
it reads. Measured **26.6× on that term (315 ms → 11.9 ms)** and
**1.71× end to end (796 ms → 466 ms)**.

**Current Stock (PERF-002 steps 1–2).** The four line-table terms moved into
one SQL aggregate; production consumption is expanded and pre-aggregated in
SQL with unit conversion still in Python, once per group rather than per
component. `getStockData` gained an additive pagination contract whose
paginated path narrows the aggregation to the page, turning four full scans
into index lookups. **1.25× unpaginated, 1.39× paginated — not the 10–50× the
audit projected.** See §6.

The Redis pool was being destroyed on every request by a
`teardown_appcontext` handler — a TCP connect added to every limited request,
and an INFO log line per request filling a 10 MB × 10 capped log with noise.
Pool lifetime is now process-scoped. The same handler's database half was
entirely dead code probing for six functions that do not exist and then a
module attribute mistaken for a pool object; it is gone.

`checkStockAdjustmentConflicts` ran on every bill save and pulled the whole
adjustments table into Python to answer a question about a handful of items.
It is now a `DISTINCT ON` lookup over just those items, with a matching index.
A blind `LIMIT` was deliberately *not* used: the same RPC method feeds mobile's
item ledger, which legitimately needs full history, so capping it there would
have silently truncated real data.

---

## 3. Testing

| | Before | After |
|---|---:|---:|
| Backend tests | 713 | **1005** |
| Backend coverage | 85% | **86.5%** |
| Frontend tests | 383 | **404** |
| Frontend tests running in CI | **0** | **404** |

The audit's central testing finding was that coverage was *inverted* — business
services at 86–96% while the code deciding who may do what sat far lower, and
all three P0 security findings lived in those untested lines.

| Module | Before | After |
|---|---:|---:|
| `app/erp/rpc.py` (the dispatcher's permission gate) | 77% | **100%** |
| `roles_service.py` (custom-role permissions) | 36% | **100%** |
| `users_service.py` (role assignment) | 67% | **100%** |
| `app/erp/mutations.py` (idempotency claims) | 87% | **100%** |
| `auth/routes.py` | 49% | **72%** |
| `app/utils.py` (`role_required`) | 38% | **82%** |

One honest note on that last row: part of the rise is 22 statements of dead
code removed — `get_or_create_master_id` and `get_or_create_item_master_id`,
which targeted legacy `public` tables and had no callers anywhere — not new
tests. The CI floor for that module is set on the honest number.

### The gate tests were mutation-tested, not trusted

`rpc.py`'s per-tab gate reaching 100% only says the lines executed, not that
anything would notice if they stopped working. So each of four ways of
breaking it was injected into the real file and the suite re-run:

| Mutation | Caught |
|---|---|
| gate never runs at all | ✅ 6 failures |
| no-grant check disabled (fail open on an unknown role) | ✅ 3 failures |
| mutation-level check disabled (a viewer may write) | ✅ 3 failures |
| level check inverted to `== "editor"` | ✅ 4 failures |

`rpc.py` was restored byte-identical afterwards and the restoration verified
by comparison, not by assumption.

The new authorization suite tests the boundary itself: the permission matrix,
that `usersTab` can never be granted to a custom role, that a role cannot be
named after a built-in one (slugging "Super Admin" would otherwise mint real
`super_admin`), and that an unknown role fails closed.

**Concurrency tests now exist: 17 of them.** The audit noted that not one
test exercised two simultaneous requests, which is precisely why DATA-002 and
DATA-003 survived a suite of 713 otherwise-good tests — a sequential test
cannot observe a lost update. These run two real transactions on two real
connections and force them to interleave at the dangerous point.

I verified the key one is not vacuous by running the same interleaving with
the lock removed: **both transactions read `0` and both inserted**. The locked
version asserts `[0, 1]`, so it fails against the pre-fix code.

---

## 4. CI/CD

Three gates existed and none could fail:

```yaml
pip-audit ... || true          # exit code swallowed
  continue-on-error: true      # step swallowed
ruff format --check
  continue-on-error: true
MIN_COVERAGE: 25               # actual was 85
  sys.exit(0)                  # passed even when below
```

All three are now blocking, plus a new `frontend` job running
`npm run verify` (eslint + stylelint + jest). Schema initialisation is fatal
instead of `continue-on-error` with `|| echo`.

The coverage gate uses **per-module floors set just under currently achieved
values** rather than a round 80%. That is deliberate: a gate that always fails
is a gate everyone learns to ignore, which is exactly how the
25%-and-`exit(0)` one came to mean nothing. These are floors to hold and then
raise — and they have now been raised once, which is the point of a ratchet:

| Module | Floor before | Floor now | Measured |
|---|---:|---:|---:|
| `app/erp/rpc.py` | 85% | **97%** | 100% |
| `app/erp/mutations.py` | — | **95%** | 100% |
| `roles_service.py` | 95% | **98%** | 100% |
| `users_service.py` | 65% | **97%** | 100% |
| `app/utils.py` | 55% | **75%** | 82% |
| overall | 85% | **86%** | 86.5% |

I dry-ran the gate logic against the real `coverage.xml` before trusting it,
and caught a bug: `--cov=app` makes paths relative to `app/`, so my initial
keys matched nothing and every module reported `NOT MEASURED` — a silent
failure for a reason unrelated to coverage.

---

## 5. Verification performed

| Check | Result |
|---|---|
| Backend suite | **1005 passed**, 0 failed, 0 errors |
| Frontend suite | **390 passed**, 0 failed |
| `ruff check` | All checks passed |
| `eslint` | 0 errors |
| `stylelint` | clean |
| Workflow YAML | both files parse; jobs enumerated |
| Coverage gate dry-run | PASS on real data; correctly FAILs below floor |
| Migration replay | 36 applied, replay re-applied **0** |
| **Backup → restore → row counts** | **101/101 tables, 0 mismatches, exit 0** |
| JSONB fidelity | `Rim 26"` / `O'Brien & Co <b>` survive byte-identical |
| Sequences | 103 restored, `dispatch_number_seq` at its live value |
| Verification rejects an incomplete dump | erp-only dump refused, naming `public.users` |
| Verification rejects a truncated dump | refused |
| Failed snapshot leaves no partial file | confirmed |
| SECRET_KEY fail-fast | production boot with no key raises `RuntimeError` |
| Rate limiting | blueprint no longer exempt; 40/min vs 600/min tiers confirmed |
| Pool cleanup | fires once at process exit, not per request |

Two things I found by testing rather than by reading, both worth recording:

- A schema-filtered `pg_dump` emits `CREATE SCHEMA public`, which every fresh
  database already has, so `pg_restore --exit-on-error` aborts on the first
  statement. Dumping the whole database avoids it — and cannot silently miss a
  future schema, which is the same class of bug that lost `public.users`.
- `backup_service` imported `from config import Config` — the *base* class —
  so under pytest, with `.env` present, it resolved to the **production**
  database and a test run would snapshot production. `pg_dump` is read-only so
  nothing was corrupted, but this is the same mistake that once wrote ~180
  fixture rows into production. Fixed by preferring `current_app.config`, plus
  a guard that refuses a production database name while `TESTING` is set.

---

## 6. Where the audit's 10–50× went

The baseline audit projected **10–50×** for moving the Current Stock
aggregation into SQL. Measured, it is **1.25×**. I would rather record that
plainly than ship the smaller number quietly, because the gap changes the
recommendation.

The test database holds 40 bill lines and can demonstrate nothing, so I built
a benchmark at the audit's own five-year projection — 19,200 bill lines, 6,000
production lots, 800 items — and ran the original and current implementations
**interleaved in one process against one dataset**, 11 rounds, medians:

| Variant | median | vs original |
|---|---:|---:|
| Original (Python folds + nested `get_units_map`) | 294 ms | 1.00× |
| PERF-003 only | 285 ms | 1.03× |
| PERF-002 + 003 (SQL aggregation) | 234 ms | 1.25× |
| …paginated, page 1 of 50 | 212 ms | 1.39× |

Moving aggregation into SQL removes the row transfer and the Python fold. That
is real, but it is not the dominant term: expanding every completed lot's JSONB
and scanning four line tables is still **O(all history)**. The constant
improved; the slope did not. **The order-of-magnitude belongs to step 3 —
materialised balances — which is still open.**

Three findings from measuring rather than reasoning:

- **Filtering production by item made it 5–8× slower** (82 ms → 397/642 ms).
  A row-wise `IN` is evaluated per expanded component and JSONB contents
  cannot be indexed for it. Removed. The movement half keeps its filter, where
  the existing expression indexes take it 60 ms → 18 ms.
- **PERF-003's 1.03× here understates it.** The benchmark is single-threaded
  against a warm pool, so `getconn()` returns instantly. Its value is avoiding
  pool growth and the `PoolError` cliff under concurrency — availability, not
  single-threaded latency.
- **A normalised `production_components` table would give 4.6× on that term.**
  Measured and deliberately not built: it adds a JSONB-vs-table
  synchronisation burden to every production write while leaving the growth
  curve unchanged.

The contrast that makes the point: the dashboard's production derivations came
out at **26.6×**, because that code was genuinely doing wasted work — fetching
and JSONB-parsing every lot ever recorded to produce four scalars. Where the
removed work is wasted, the number is large. Where it is inherent, it is not,
and no amount of rewriting the same computation will change that.

---

## 7. What was deliberately not done

**MONEY-001 (float money, unstored totals).** This touches every financial
path and needs a backfill migration plus reconciliation before and after. Doing
it in the same release as an authentication change would make both harder to
verify and harder to roll back. It deserves its own window.

**Phases 4 and 5 (intelligence, AI).** The original plan gates these behind
Phase 3, and correctly: natural-language query needs the pagination API that
does not exist yet, and invoice extraction needs attachment storage that does
not exist at all. Building either on the current whole-table read model would
put an expensive layer over the data-access pattern that is itself the problem.

**The `'unsafe-inline'` CSP removal.** The six XSS sinks are closed, but the
structural fix — an escape-by-default tagged template, and moving ~40 inline
handlers to event delegation — is a larger change than this release should
carry.

---

## 8. Remaining risk, honestly

| Risk | Severity | Why it is still open |
|---|---|---|
| **PERF-002 step 3** — no materialised balances | High, growing | Steps 1–2 improved the constant; the curve is still O(all history), so every read gets slower every month. This is also what would let DATA-002's invariant become a database `CHECK` rather than an advisory lock. |
| **Paginated contract has no caller** | Medium | `getStockData` accepts `page/pageSize/search/sort/direction` and nothing uses it, so that work delivers nothing to users yet. Migrating a module changes search semantics, select-all and export — it needs UI verification, not just green tests. |
| **PERF-004** unbundled frontend | Medium | 3.36 MB, three hand-maintained cache-busting schemes. |
| **AUDIT-001** no before/after history | Medium | Still cannot answer "who changed this and what was it before". |
| **Off-site/encrypted backups** | Medium | Snapshots are verified but local and plaintext. Operational, in the runbook. |
| **Rate-limit tuning** | Low | Limits are first-guess; watch rejections for a week. |
| **31 test accounts in production, 4 of them Admin** | High | Found while verifying MIG-001 against the live database. Not code: removing accounts from a production `users` table is an operator's decision. The *mechanism* that seeded two of them is closed — no migration seeds accounts now, and a test enforces it. Runbook §3b. |

---

## 9. Production readiness

| Dimension | Before | After | Note |
|---|---:|---:|---|
| Security | 3/10 | **7/10** | Four P0s closed; XSS and rate limiting done; CSP hardening and per-account lockout remain |
| Data Integrity | 4/10 | **8/10** | Backups genuinely work; concurrency invariants now locked and tested; money unchanged |
| Reliability | 5/10 | **8/10** | Server and client timeouts, pool lifecycle fixed, nested acquisition eliminated and guarded; background jobs still in web workers |
| Testing | 7/10 | **9/10** | +292 backend / +21 frontend tests; the authorization and idempotency path at 100% and mutation-tested; 17 concurrency tests; one migration path with a guard suite |
| Observability | 4/10 | 4/10 | Log injection closed; still no metrics or APM |
| Performance | 4/10 | **6/10** | Dashboard 1.71× (its production term 26.6×), connection handling fixed and CI-guarded, Stock 1.25–1.39×. The read architecture is still O(history) — see §6. |
| UX / A11y / Responsive | 6/6/6 | 6/6/6 | Untouched |
| **Production Readiness** | **3/10** | **8/10** | |

---

## 10. Verdict

# CONDITIONAL GO

The four P0 findings that made this NO-GO are closed, each with evidence that
the original failure condition no longer occurs. The application can be
deployed, **subject to these conditions**:

1. **Rotate `SECRET_KEY`** as part of the deployment. If any deployment ran on
   the committed fallback, existing sessions and reset tokens are forgeable.
   Runbook step 2b.
2. **Run the account audit** in runbook step 3 and demote anything
   unrecognised. Strongly consider `ALLOW_SELF_SIGNUP=false`.
3. **Take and restore-test a backup before deploying** — runbook step 1,
   including the scratch-database restore. Do not accept "a file was created".
4. **Get a backup copy off the machine** and schedule that.
5. **Expect HTTP 409 on a genuine double-submit.** A duplicate mutation now
   gets "This action is already being processed" instead of silently
   executing twice. That is the correct behaviour, but it is new and the shop
   floor should be told it means "wait, then check — do not re-enter".

The concurrency condition from the first pass is **discharged**: DATA-002 and
DATA-003 are closed with advisory locks and an atomic claim, and 17 tests hold
them. So is the availability cliff — **PERF-003 is closed and now guarded in
CI**, after a depth check found 326 nested acquisitions where the audit had
identified 8 sites.

What remains before an unconditional **GO** is no longer a correctness or
availability risk; it is the read architecture. `getDashboardData` is 466 ms
and `getStockData` 234 ms at five years of projected volume, both still
O(all history). That is a curve to bend (PERF-002 step 3), not a fire to put
out — and §6 sets out honestly why steps 1 and 2 bought 1.25× rather than the
10–50× the audit projected.

---

*Every "FIXED" in the tracker is backed by a test that fails against the
previous code, or by a reproduction run recorded here. No test was deleted, no
lint rule disabled, no `continue-on-error` added, and no finding closed without
evidence.*
