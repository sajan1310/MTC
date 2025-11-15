import json
from pathlib import Path

ROOT = Path.cwd()
file = ROOT / "migration_candidate_usages.json"
if not file.exists():
    print("missing file")
    raise SystemExit(1)
data = json.loads(file.read_text())
counts = []
for k, v in data.items():
    counts.append((k, len(v)))
counts.sort(key=lambda x: -x[1])
out = {"counts": counts}
print(json.dumps(out, indent=2))
with open(ROOT / "migration_candidate_counts.json", "w") as fh:
    json.dump(out, fh, indent=2)
print("wrote migration_candidate_counts.json")
