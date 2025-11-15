from pathlib import Path
import re
import json

ROOT = Path.cwd()
scan_root = ROOT / "Project-root" if (ROOT / "Project-root").exists() else ROOT
cand_file = ROOT / "migration_candidate_missing.json"
if not cand_file.exists():
    print("candidate file missing")
    raise SystemExit(1)
cands = json.loads(cand_file.read_text())["candidate_missing"]
# normalize
cands = [c.strip() for c in cands]
results = {}
for c in cands:
    results[c] = []
    # search all .py .sql .html .js .md
    for ext in ("*.py", "*.sql", "*.html", "*.js", "*.md"):
        for f in scan_root.rglob(ext):
            if any(
                x in str(f).lower()
                for x in ("venv", "venv2", "site-packages", "backups", "logs")
            ):
                continue
            try:
                txt = f.read_text(encoding="utf-8", errors="ignore")
            except Exception:
                continue
            if c in txt:
                # collect small context
                for i, line in enumerate(txt.splitlines(), start=1):
                    if c in line:
                        results[c].append(
                            {"file": str(f), "line": i, "snippet": line.strip()[:400]}
                        )

print(json.dumps(results, indent=2)[:10000])
with open(ROOT / "migration_candidate_usages.json", "w", encoding="utf-8") as fh:
    json.dump(results, fh, indent=2)
print("\nWrote migration_candidate_usages.json")
