from pathlib import Path
import re
import json

ROOT = Path.cwd()
scan_root = ROOT / "Project-root" if (ROOT / "Project-root").exists() else ROOT


def _read_text(p):
    try:
        return Path(p).read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return ""


# Gather migration CREATE TABLE tokens
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
            migration_tables.add(m.group(1))

# Gather code-used table tokens from .py and .sql
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
        name = m.group(1)
        if not name:
            continue
        if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", name):
            continue
        code_tables.add(name)

missing = sorted([t for t in code_tables if t not in migration_tables])
extra_in_migrations = sorted([t for t in migration_tables if t not in code_tables])

out = {
    "migration_tables_count": len(migration_tables),
    "code_tables_count": len(code_tables),
    "missing_tables_count": len(missing),
    "missing_tables": missing[:200],
    "migration_only_count": len(extra_in_migrations),
    "migration_only": extra_in_migrations[:200],
}
print(json.dumps(out, indent=2))
with open(ROOT / "migration_triage.json", "w", encoding="utf-8") as fh:
    json.dump(out, fh, indent=2)
print("\nWrote migration_triage.json")
