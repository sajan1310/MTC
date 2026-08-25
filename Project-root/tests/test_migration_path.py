"""One migration path, one tracker (MIG-001).

The audit found three migration trackers. Two of them described a schema
production no longer had:

  - erp.migrations_applied      38 rows, current, written by erp/runner.py
  - public.schema_migrations    29 rows, written by tests/conftest.py, for
                                tables production dropped in the ERP rewrite
  - public.migrations_applied    2 rows, written by migration_tracker.py, one
                                of them status='failed'

and the public core tables -- `users`, which every migration from 003 on has
a foreign key to -- were created by a `psql -f init_schema.sql` step in the
deploy scripts, outside all three.

That is fixed by erp/000_public_core.sql plus the retirement of everything in
migrations/legacy/. These tests exist so it does not come back: the failure
mode is silent (someone adds a script to migrations/, it works on their
machine because their database already has the tables, and a virgin deploy
dies) and it took a production outage to find last time.
"""

from __future__ import annotations

import ast
import pathlib
import re
import warnings

import pytest

PROJECT_ROOT = pathlib.Path(__file__).parent.parent
MIGRATIONS = PROJECT_ROOT / "migrations"
ERP = MIGRATIONS / "erp"
LEGACY = MIGRATIONS / "legacy"


# ── The layout ───────────────────────────────────────────────────────────


def test_the_only_runnable_migrations_live_in_erp():
    """A .py or .sql file loose in migrations/ is the shape the old mess had:
    something that looks runnable, that the runner does not run, and that
    someone will eventually run by hand against production."""
    stray = [
        p.name
        for p in MIGRATIONS.iterdir()
        if p.is_file() and p.suffix in (".py", ".sql") and p.name != "__init__.py"
    ]
    assert stray == [], (
        f"{stray} sit loose in migrations/. Put schema changes in "
        f"migrations/erp/ where the runner will apply them, or in "
        f"migrations/legacy/ if they are history."
    )


def test_legacy_scripts_are_quarantined_not_deleted():
    """Kept for reading. If this directory ever empties, the evidence in its
    README goes with it."""
    assert LEGACY.is_dir()
    assert (LEGACY / "README.md").is_file()
    assert len(list(LEGACY.glob("*.py"))) > 20


def _docstring_lines(source):
    """Line numbers occupied by docstrings, so prose can be told from code.

    A `#` comment is easy to skip; a module or function docstring is not, and
    several of the files here explain the retired migration path in exactly
    that place. ast gives the precise spans.
    """
    try:
        with warnings.catch_warnings():
            # Some files carry `\d` outside a raw string; ast re-emits that as
            # a SyntaxWarning and it has nothing to do with what is being
            # checked here.
            warnings.simplefilter("ignore")
            tree = ast.parse(source)
    except SyntaxError:
        return set()
    spans = set()
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        body = getattr(node, "body", None)
        if not body:
            continue
        first = body[0]
        if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) \
                and isinstance(first.value.value, str):
            spans.update(range(first.lineno, (first.end_lineno or first.lineno) + 1))
    return spans


def _executable_lines(path):
    """Lines that would actually run: comments, blank lines and docstrings
    stripped.

    Deliberately mention-tolerant. A comment or docstring saying "this
    replaces the init_schema.sql step" is the history worth keeping -- what
    must not come back is a line that RUNS it.
    """
    source = path.read_text(encoding="utf-8", errors="ignore")
    skip = _docstring_lines(source) if path.suffix == ".py" else set()
    for number, raw in enumerate(source.splitlines(), start=1):
        line = raw.strip()
        if line and not line.startswith("#") and number not in skip:
            yield line


def _source_files(*suffixes):
    seen = set()
    for suffix in suffixes:
        for path in PROJECT_ROOT.rglob(f"*{suffix}"):
            seen.add(path)
    for path in sorted(seen):
        if not path.is_file():
            continue
        rel = path.relative_to(PROJECT_ROOT).as_posix()
        if rel.startswith("migrations/legacy/") or "node_modules" in rel or ".venv" in rel:
            continue
        if rel == "tests/test_migration_path.py":
            continue
        yield rel, path


def test_nothing_executes_a_legacy_script():
    """The deploy scripts ran init_schema.sql on every deploy, and
    README/DEPLOYMENT told operators to run run_migration.py. Both are gone;
    this keeps them gone -- without forbidding anyone from writing about
    them."""
    offenders = []
    for rel, path in _source_files(".py", ".sh"):
        for line in _executable_lines(path):
            for needle in ("init_schema.sql", "run_migration.py", "migration_tracker"):
                if needle in line:
                    offenders.append(f"{rel}: {line[:90]}")
    assert offenders == [], offenders


# ── The chain itself ─────────────────────────────────────────────────────


def test_the_public_core_runs_before_anything_references_it():
    """Every migration from 003 on has a foreign key to public.users. If the
    file that creates it does not sort first, a virgin database dies at 003
    with `relation "public.users" does not exist` -- which is exactly how the
    deploy used to fail before init_schema.sql was bolted on in front."""
    names = sorted(p.stem for p in ERP.glob("*.sql"))
    assert names[0] == "000_public_core", names[:3]

    core = (ERP / "000_public_core.sql").read_text(encoding="utf-8")
    assert "CREATE TABLE IF NOT EXISTS public.users" in core
    assert "CREATE TABLE IF NOT EXISTS public.password_reset_tokens" in core


def test_no_migration_seeds_a_user_account():
    """init_schema.sql ended with two INSERTs into users, both role 'admin'
    (admin@mtc.local and demo@example.com). Because the deploy re-ran that
    file every time, deleting those accounts did not keep them deleted; both
    are still in production today. A schema migration must never mint an
    account."""
    offenders = []
    for path in sorted(ERP.glob("*.sql")):
        body = re.sub(r"--[^\n]*", "", path.read_text(encoding="utf-8"))
        if re.search(r"INSERT\s+INTO\s+(public\.)?users\b", body, re.I):
            offenders.append(path.name)
    assert offenders == [], f"{offenders} seed rows into users"


def test_every_migration_is_numbered_and_unique():
    """The runner applies sorted(*.sql). Two files sharing a number means the
    order between them is alphabetical accident."""
    numbers = [p.name[:3] for p in ERP.glob("*.sql")]
    assert all(n.isdigit() for n in numbers), [p.name for p in ERP.glob("*.sql")]
    duplicates = {n for n in numbers if numbers.count(n) > 1}
    assert not duplicates, f"duplicate migration numbers: {sorted(duplicates)}"


# ── The tracker ──────────────────────────────────────────────────────────


def test_only_one_tracker_table_is_written_anywhere():
    """public.schema_migrations and public.migrations_applied are the two dead
    trackers. Nothing should read or write either again -- but describing them
    in a docstring is fine, so this looks for SQL, not for the word."""
    statement = re.compile(
        r"(INSERT\s+INTO|CREATE\s+TABLE(\s+IF\s+NOT\s+EXISTS)?|FROM|UPDATE|DELETE\s+FROM)"
        r"\s+(public\.)?(schema_migrations|migrations_applied)\b",
        re.I,
    )
    offenders = []
    for rel, path in _source_files(".py", ".sql"):
        for line in _executable_lines(path):
            match = statement.search(line)
            # erp.migrations_applied is the live one and is always allowed.
            if match and "erp.migrations_applied" not in line:
                offenders.append(f"{rel}: {line[:90]}")
    assert offenders == [], offenders


def test_the_runner_takes_an_advisory_lock():
    """deploy/mtc.service runs the migrations from ExecStartPre with
    Restart=always, so a restart loop or a rolling deploy can easily have two
    instances applying the same pending set at once. CREATE TABLE IF NOT
    EXISTS survives that; a data migration does not."""
    runner = (ERP / "runner.py").read_text(encoding="utf-8")
    assert "pg_advisory_lock" in runner
    assert "pg_advisory_unlock" in runner


# ── The deploy path ──────────────────────────────────────────────────────


@pytest.mark.parametrize("script", ["docker-entrypoint.sh", "deploy/deploy.sh"])
def test_the_deploy_path_runs_the_runner_and_nothing_else(script):
    path = PROJECT_ROOT / script
    assert "migrations/erp/runner.py" in path.read_text(encoding="utf-8")
    # No second schema source. (`psql` for anything else -- a backup, a
    # status query -- would be fine; applying schema is what must not happen
    # outside the runner.)
    applies_sql = [
        line for line in _executable_lines(path)
        if re.search(r"\bpsql\b.*-f\b.*\.sql", line)
    ]
    assert applies_sql == [], f"{script} applies a .sql file outside the runner: {applies_sql}"
