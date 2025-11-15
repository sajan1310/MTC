import json
import os
import re

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
MIGRATIONS_DIR = os.path.join(ROOT, "Project-root", "migrations")


def load_candidates(path):
    with open(path, "r", encoding="utf-8") as f:
        j = json.load(f)
    return j.get("candidate_missing", [])


def read_migrations_text():
    texts = []
    if not os.path.isdir(MIGRATIONS_DIR):
        return texts
    for fn in os.listdir(MIGRATIONS_DIR):
        p = os.path.join(MIGRATIONS_DIR, fn)
        if os.path.isfile(p):
            try:
                with open(p, "r", encoding="utf-8", errors="ignore") as f:
                    texts.append((fn, f.read()))
            except Exception:
                continue
    return texts


def classify_candidate(token, migrations_texts, usages_snippets):
    t = token.lower()
    classification = "other"

    # check for explicit CREATE TABLE or CREATE VIEW
    create_table_re = re.compile(
        r"create\s+table\s+if\s+not\s+exists\s+" + re.escape(t), re.I
    )
    create_view_re = re.compile(
        r"create\s+view\s+if\s+not\s+exists\s+" + re.escape(t), re.I
    )
    alter_add_column_re = re.compile(
        r"alter\s+table\s+\w+\s+add\s+column\s+if\s+not\s+exists\s+" + re.escape(t),
        re.I,
    )
    # also allow ALTER TABLE ... ADD COLUMN <colname>
    alter_any_add_col_re = re.compile(
        r"alter\s+table[\s\S]{0,80}add\s+column[\s\S]{0,40}" + re.escape(t), re.I
    )

    for fn, text in migrations_texts:
        low = text.lower()
        if create_table_re.search(low):
            return "table"
        if create_view_re.search(low) or re.search(
            r"create\s+view\s+" + re.escape(t), low
        ):
            return "view"
        if alter_add_column_re.search(low) or alter_any_add_col_re.search(low):
            # if candidate looks like a column name in migrations
            return "column"

    # if usages show pattern 'token AS (' it's likely a CTE alias
    for s in usages_snippets:
        if re.search(r"\b" + re.escape(token) + r"\s+as\s*\(", s, re.I):
            return "cte"

    # Heuristics: token looks like a column name (contains underscore and ends with common suffixes)
    if re.match(r"[a-z0-9_]+_[a-z0-9_]+$", t):
        # many of these are columns rather than tables
        return "column"

    # system/pg names
    if t.startswith("pg_") or t in (
        "information_schema",
        "key_column_usage",
        "table_constraints",
        "pg_class",
        "pg_tables",
    ):
        return "system_view"

    # python/module false positives
    if t.startswith("flask_") or t.startswith("__"):
        return "code_module"

    return classification


def gather_usages(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def main():
    cand_path = os.path.join(ROOT, "migration_candidate_missing.json")
    usages_path = os.path.join(ROOT, "migration_candidate_usages.json")

    candidates = load_candidates(cand_path) if os.path.exists(cand_path) else []
    usages = gather_usages(usages_path) if os.path.exists(usages_path) else {}

    migrations_texts = read_migrations_text()

    out = {}
    for c in candidates:
        snippets = []
        for u in usages.get(c, []):
            snippets.append(u.get("snippet", "") if isinstance(u, dict) else str(u))
        cls = classify_candidate(c, migrations_texts, snippets)
        out[c] = {
            "classification": cls,
            "usage_count": len(snippets),
            "sample_usages": snippets[:6],
        }

    out_path = os.path.join(ROOT, "migration_candidate_classification.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)

    print("Wrote", out_path)


if __name__ == "__main__":
    main()
