import re
import json
from pathlib import Path
import sys


ROOT = Path.cwd()


def _read_text(path: Path):
    try:
        return path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return ""


# directories to ignore while scanning
SKIP_DIRS = ("venv", "venv2", "site-packages", "backups", "logs")


def gather_backend_routes(root: Path):
    """Scan python files for Flask-style route declarations and return a set of routes and a map of occurrences."""
    route_re = re.compile(r"@[^\n]*\.route\(\s*['\"]([^'\"]+)['\"]")
    add_rule_re = re.compile(r"add_url_rule\(\s*['\"]([^'\"]+)['\"]")
    routes = []
    files = list(root.rglob("*.py"))
    for f in files:
        # skip virtualenvs and bulky non-source directories
        if any(s in str(f).lower() for s in SKIP_DIRS):
            continue
        txt = _read_text(f)
        for m in route_re.finditer(txt):
            routes.append((m.group(1), str(f)))
        for m in add_rule_re.finditer(txt):
            routes.append((m.group(1), str(f)))
    route_map = {}
    for r, f in routes:
        route_map.setdefault(r, []).append(f)
    return route_map


def gather_frontend_endpoints(root: Path):
    """Scan JS files for fetch/axios calls and return a set of endpoint paths used in frontend."""
    js_files = list(root.rglob("*.js"))
    endpoints = []
    # Matches fetch('/api/xyz' or fetch(`/api/...`) or axios.get('/api/..')
    pattern1 = re.compile(r"fetch\(\s*['\"]([^'\"]+)['\"]\)")
    pattern2 = re.compile(r"fetch\(\s*`([^`]+)`\)")
    pattern3 = re.compile(r"axios\.[a-zA-Z]+\(\s*['\"]([^'\"]+)['\"]\)")
    pattern4 = re.compile(r"['\"](/api[^'\"]+)['\"]")
    for f in js_files:
        if any(s in str(f).lower() for s in SKIP_DIRS):
            continue
        txt = _read_text(f)
        for m in pattern1.finditer(txt):
            endpoints.append((m.group(1), str(f)))
        for m in pattern2.finditer(txt):
            endpoints.append((m.group(1), str(f)))
        for m in pattern3.finditer(txt):
            endpoints.append((m.group(1), str(f)))
        # fallback - catch /api/... strings
        for m in pattern4.finditer(txt):
            endpoints.append((m.group(1), str(f)))
    ep_map = {}
    for e, f in endpoints:
        ep_map.setdefault(e, []).append(f)
    return ep_map


def gather_migration_tables(root: Path):
    """Parse migration SQL/Python migrations for CREATE TABLE occurrences."""
    # Kept for backward compatibility; prefer gather_migration_db_objects below.
    migrations = list(root.rglob("migrations/*"))
    table_re = re.compile(
        r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:\w+\.)?\"?([a-zA-Z0-9_]+)\"?",
        re.I,
    )
    tables = set()
    for f in migrations:
        if f.is_file():
            txt = _read_text(f)
            for m in table_re.finditer(txt):
                tables.add(m.group(1))
    return tables


def gather_migration_db_objects(root: Path):
    """Scan migrations for CREATE TABLE, CREATE VIEW, and column definitions (including ALTER TABLE ADD COLUMN).

    Returns a tuple of (tables_set, views_set, columns_set).
    """
    migrations = list(root.rglob("migrations/*"))
    table_re = re.compile(
        r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:\w+\.)?\"?([a-zA-Z0-9_]+)\"?",
        re.I,
    )
    view_re = re.compile(
        r"CREATE\s+(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:\w+\.)?\"?([a-zA-Z0-9_]+)\"?",
        re.I,
    )
    alter_add_col_re = re.compile(
        r"ALTER\s+TABLE\s+(?:\w+\.)?\"?[a-zA-Z0-9_]+\"?\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?\"?([a-zA-Z0-9_]+)\"?",
        re.I,
    )
    # crude column definition detection inside CREATE TABLE blocks or standalone column defs
    col_def_re = re.compile(
        r"\b([a-zA-Z_][a-zA-Z0-9_]*)\s+(?:integer|bigint|serial|text|varchar|character varying|timestamp|boolean|jsonb|uuid)\b",
        re.I,
    )

    tables = set()
    views = set()
    columns = set()
    for f in migrations:
        if f.is_file():
            txt = _read_text(f)
            low = txt
            for m in table_re.finditer(low):
                tables.add(m.group(1))
            for m in view_re.finditer(low):
                views.add(m.group(1))
            for m in alter_add_col_re.finditer(low):
                columns.add(m.group(1))
            for m in col_def_re.finditer(low):
                columns.add(m.group(1))
    return tables, views, columns


def gather_cte_aliases(root: Path):
    """Find common CTE aliases in SQL strings (e.g. 'my_cte AS ('). These are not DB objects to migrate."""
    files = list(root.rglob("*.py")) + list(root.rglob("*.sql"))
    cte_re = re.compile(r"\b([a-zA-Z_][a-zA-Z0-9_]*)\s+AS\s*\(", re.I)
    ctes = set()
    for f in files:
        if any(s in str(f).lower() for s in SKIP_DIRS):
            continue
        txt = _read_text(f)
        for m in cte_re.finditer(txt):
            ctes.add(m.group(1))
    return ctes


def is_noise_token(name: str):
    n = name.lower()
    if n.startswith("flask_") or n.startswith("__") or n.startswith("pg_"):
        return True
    if n in (
        "information_schema",
        "generate_series",
        "key_column_usage",
        "table_constraints",
        "table_name",
    ):
        return True
    if n.startswith("test_") or n.endswith("_data"):
        # many test helpers and ephemeral CTE-style aliases end with _data
        return True
    return False


def gather_blueprint_prefixes(root: Path):
    """Find Blueprint definitions and app.register_blueprint calls to extract url_prefix values.

    Returns a list of prefixes (strings).
    """
    prefixes = set()
    files = list(root.rglob("*.py"))
    bp_def_re = re.compile(
        r"(\w+)\s*=\s*Blueprint\([^\)]*?url_prefix\s*=\s*['\"]([^'\"]+)['\"]", re.I
    )
    reg_bp_re = re.compile(
        r"register_blueprint\(\s*(\w+)\s*,\s*url_prefix\s*=\s*['\"]([^'\"]+)['\"]", re.I
    )
    for f in files:
        if any(s in str(f).lower() for s in SKIP_DIRS):
            continue
        txt = _read_text(f)
        for m in bp_def_re.finditer(txt):
            prefixes.add(m.group(2))
        for m in reg_bp_re.finditer(txt):
            prefixes.add(m.group(2))
    return sorted(prefixes)


def gather_tables_used_in_code(root: Path):
    """Heuristic: find bare table names used in SQL strings inside .py and .sql files."""
    files = list(root.rglob("*.py")) + list(root.rglob("*.sql"))
    usage = set()
    # look for simple patterns: FROM table_name, INTO table_name, JOIN table_name
    pat = re.compile(
        r"\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:\w+\.)?\"?([a-zA-Z0-9_]+)\"?", re.I
    )
    for f in files:
        if any(s in str(f).lower() for s in SKIP_DIRS):
            continue
        txt = _read_text(f)
        for m in pat.finditer(txt):
            name = m.group(1)
            # heuristic: skip purely numeric tokens and short noise tokens
            if not name:
                continue
            if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", name):
                continue
            usage.add(name)
    return usage


def find_sensitive_files(root: Path):
    patterns = [".env", ".pem", ".key", ".pfx", "id_rsa", "secrets", ".DS_Store"]
    hits = []
    for f in root.rglob("*"):
        if not f.is_file():
            continue
        # skip virtualenvs, backups and site-packages to avoid false positives
        if any(
            x in str(f).lower() for x in ("venv", "venv2", "site-packages", "backups")
        ):
            continue
        name = f.name.lower()
        for pat in patterns:
            if pat in name:
                hits.append(str(f))
    return hits


def parse_requirements(root: Path):
    req = root / "requirements.txt"
    pkgs = set()
    if req.exists():
        for line in _read_text(req).splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            pkg = re.split(r"[<>=]", line)[0].strip()
            if pkg:
                pkgs.add(pkg.lower())
    return pkgs


def gather_python_imports(root: Path):
    imports = set()
    for f in root.rglob("*.py"):
        if any(s in str(f).lower() for s in SKIP_DIRS):
            continue
        txt = _read_text(f)
        for m in re.finditer(r"^\s*import\s+([\w\.]+)", txt, re.M):
            name = m.group(1).split(".")[0].lower()
            if re.match(r"^[a-zA-Z_][a-zA-Z0-9_]*$", name):
                imports.add(name)
        for m in re.finditer(r"^\s*from\s+([\w\.]+)\s+import", txt, re.M):
            name = m.group(1).split(".")[0].lower()
            if re.match(r"^[a-zA-Z_][a-zA-Z0-9_]*$", name):
                imports.add(name)
    return imports


def file_size_warnings(root: Path, threshold_bytes=200_000):
    large = []
    for f in root.rglob("*"):
        if any(s in str(f).lower() for s in SKIP_DIRS):
            continue
        try:
            if f.is_file() and f.stat().st_size > threshold_bytes:
                large.append((str(f), f.stat().st_size))
        except Exception:
            continue
    return large


def test_project_audit():
    """Comprehensive project audit that fails if it finds critical mismatches.

    This test performs a battery of safe, read-only checks and reports findings.
    """
    root = ROOT
    scan_root = root / "Project-root" if (root / "Project-root").exists() else root
    errors = []
    warnings = []

    # 1) Backend routes
    backend = gather_backend_routes(scan_root)
    if not backend:
        warnings.append(
            "No backend routes found (no @app.route or add_url_rule patterns)."
        )
    # Enrich backend routes with blueprint prefixes so frontend /api/... can match bp.route('/...')
    bp_prefixes = gather_blueprint_prefixes(scan_root)
    enriched_backend = set(backend.keys())
    for p in bp_prefixes:
        for r in list(backend.keys()):
            if r.startswith("/"):
                enriched_backend.add(p.rstrip("/") + r)
    backend_routes = enriched_backend

    # 2) Frontend endpoints
    frontend = gather_frontend_endpoints(scan_root)
    if not frontend:
        warnings.append("No frontend API endpoints were detected in JS files.")

    # 3) Missing backend handlers for frontend endpoints
    missing_endpoints = []
    backend_routes = set(backend.keys())
    for ep, files in frontend.items():
        # Normalize template params to path up to query/param
        norm = ep.split("?")[0]
        # if endpoint contains template variables, strip to static prefix before ${
        norm = (
            re.split(r"\$\{.*|\\{.*|\%s", norm)[0]
            if "${" in norm or "{" in norm
            else norm
        )
        # check for direct and prefix matches
        if not any(
            norm == r
            or norm.startswith(r.rstrip("/") + "/")
            or r.startswith(norm.rstrip("/") + "/")
            for r in backend_routes
        ):
            missing_endpoints.append((ep, files))
    if missing_endpoints:
        errors.append(
            f"{len(missing_endpoints)} frontend API endpoint(s) have no matching backend route."
        )
        # include first few details in message
        details = [
            f"{ep} referenced in {files[:2]}" for ep, files in missing_endpoints[:10]
        ]
        errors.extend(details)

    # 4) Duplicate backend routes (now treated as warnings)
    dupes = {r: fs for r, fs in backend.items() if len(set(fs)) > 1}
    if dupes:
        warnings.append(f"{len(dupes)} duplicate backend route(s) found across files.")
        for r, fs in list(dupes.items())[:10]:
            warnings.append(f"Route {r} declared in: {sorted(set(fs))[:3]}")

    # 5) Migrations vs code table usage (improved)
    migration_tables, migration_views, migration_columns = gather_migration_db_objects(
        scan_root
    )
    code_tables = gather_tables_used_in_code(scan_root)
    cte_aliases = gather_cte_aliases(scan_root)

    missing_db_objects = []
    for t in sorted(code_tables):
        if is_noise_token(t):
            continue
        if t in migration_tables or t in migration_views:
            continue
        if t in migration_columns:
            # token is present as a column in migrations
            continue
        if t in cte_aliases:
            # token is a CTE alias used in queries
            continue
        # otherwise, consider as a potentially missing DB object (table/view)
        missing_db_objects.append(t)

    if missing_db_objects:
        warnings.append(
            f"{len(missing_db_objects)} DB object(s) are referenced in code but not found in migrations (tables/views/columns): {missing_db_objects[:10]}"
        )

    # 6) Sensitive/unwanted files
    sens = find_sensitive_files(scan_root)
    if sens:
        warnings.append(
            f"Found {len(sens)} potentially sensitive/unwanted files: {sens[:10]}"
        )

    # 7) Dependency consistency: imports vs requirements
    reqs = parse_requirements(scan_root)
    imports = gather_python_imports(scan_root)
    missing_reqs = sorted(
        [
            imp
            for imp in imports
            if imp not in reqs
            and imp
            not in ("__future__", "os", "sys", "re", "json", "pathlib", "typing")
        ]
    )
    if missing_reqs:
        warnings.append(
            f"{len(missing_reqs)} top-level imports not listed in requirements.txt (heuristic): {missing_reqs[:20]}"
        )

    # 8) Large files that may affect performance or maintenance
    large_files = file_size_warnings(scan_root)
    if large_files:
        warnings.append(
            f"{len(large_files)} large file(s) >200KB detected: {large_files[:10]}"
        )

    # 9) Migration file naming or duplication issues
    migration_dir = root / "Project-root" / "migrations"
    if migration_dir.exists():
        names = [p.name for p in migration_dir.iterdir() if p.is_file()]
        dup_names = sorted([n for n in set(names) if names.count(n) > 1])
        if dup_names:
            warnings.append(f"Duplicate migration filenames detected: {dup_names}")

    # 10) Summarize and assert
    report_lines = []
    if errors:
        report_lines.append("ERRORS:")
        report_lines.extend(errors)
    if warnings:
        report_lines.append("WARNINGS:")
        report_lines.extend(warnings)

    # Write a JSON artifact for easier machine consumption
    artifact = {
        "errors": errors,
        "warnings": warnings,
        "counts": {
            "backend_routes": len(backend_routes),
            "frontend_endpoints": len(frontend),
            "migration_tables": len(migration_tables),
            "code_tables": len(code_tables),
        },
    }
    out = Path("audit_report.json")
    try:
        out.write_text(json.dumps(artifact, indent=2))
    except Exception:
        pass

    if report_lines:
        summary = "\n".join(report_lines)
        # fail the test if there are errors; if only warnings, still pass but show them
        if errors:
            pytest_msg = f"Project audit found critical issues:\n{summary}"
            # Use pytest.fail if pytest is available
            try:
                import pytest

                pytest.fail(pytest_msg)
            except Exception:
                raise AssertionError(pytest_msg)
        else:
            # print warnings so they appear in pytest output
            print("Project audit warnings:\n", "\n".join(warnings))
