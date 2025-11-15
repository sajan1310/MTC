import sys

# Ensure project-root is on path so we import the package app instead of top-level app.py
sys.path.insert(0, r"c:\Users\erkar\OneDrive\Desktop\MTC\Project-root")
from app import create_app

app = create_app("development")
for r in sorted(app.url_map.iter_rules(), key=lambda x: x.rule):
    methods = ",".join([m for m in r.methods if m not in ("HEAD", "OPTIONS")])
    print(f"{r.rule:60} {methods:15} -> {r.endpoint}")
