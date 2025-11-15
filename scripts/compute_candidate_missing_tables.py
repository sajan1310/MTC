from pathlib import Path
import re

ROOT = Path.cwd()
scan_root = ROOT / "Project-root" if (ROOT / "Project-root").exists() else ROOT


def _read_text(p):
    try:
        return Path(p).read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return ""


# gather migration tables
migrations = (
    list((scan_root / "migrations").rglob("*"))
    if (scan_root / "migrations").exists()
    else []
)
table_re = re.compile(
    r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:\w+\.)?\"?([a-zA-Z0-9_]+)\"?", re.I
)
migration_tables = set()
for f in migrations:
    if f.is_file():
        txt = _read_text(f)
        for m in table_re.finditer(txt):
            migration_tables.add(m.group(1).lower())

# gather code tokens
files = list(scan_root.rglob("*.py")) + list(scan_root.rglob("*.sql"))
pat = re.compile(r"\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:\w+\.)?\"?([a-zA-Z0-9_]+)\"?", re.I)
code_tables = set()
for f in files:
    if any(
        x in str(f).lower()
        for x in ("venv", "venv2", "site-packages", "backups", "logs")
    ):
        continue
    txt = _read_text(f)
    for m in pat.finditer(txt):
        name = m.group(1).lower()
        if not name:
            continue
        if not re.match(r"^[a-z_][a-z0-9_]*$", name):
            continue
        code_tables.add(name)

# filter candidates: likely table-like tokens
stopwords = set(
    [
        "api",
        "app",
        "flask",
        "tests",
        "test",
        "postgres",
        "psycopg2",
        "import",
        "from",
        "select",
        "where",
        "join",
        "on",
        "and",
        "or",
        "in",
        "not",
        "as",
        "is",
        "set",
        "table",
        "columns",
        "column",
        "create",
        "if",
        "exists",
        "return",
        "def",
        "class",
        "current_timestamp",
        "now",
    ]
)
candidates = sorted(
    [
        t
        for t in code_tables
        if len(t) > 3 and t not in migration_tables and t not in stopwords and "_" in t
    ]
)

out = {
    "migration_tables_count": len(migration_tables),
    "code_tables_count": len(code_tables),
    "candidate_missing_count": len(candidates),
    "candidate_missing": candidates[:200],
}
print(out)
with open(ROOT / "migration_candidate_missing.json", "w", encoding="utf-8") as fh:
    import json

    json.dump(out, fh, indent=2)
print("wrote migration_candidate_missing.json")
