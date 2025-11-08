"""
Analyze Dependencies for Production Lot Table
Location: /scripts/analyze_dependencies.py
Output: dependency_report.json documenting all touchpoints
Dependencies: os, re, json, glob
"""

import os
import re
import json
import glob

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
REPORT_FILE = os.path.join(PROJECT_ROOT, "dependency_report.json")

SEARCH_TERMS = ["production_lots", "ProductionLot", "/api/upf/production"]

FRONTEND_EXTENSIONS = [".html", ".js"]


def find_references(term):
    matches = []
    for root, _, files in os.walk(PROJECT_ROOT):
        for file in files:
            if file.endswith(".py") or file.endswith(".js") or file.endswith(".html"):
                path = os.path.join(root, file)
                try:
                    with open(path, "r", encoding="utf-8") as f:
                        content = f.read()
                        for match in re.finditer(re.escape(term), content):
                            matches.append(
                                {
                                    "file": path,
                                    "line": content.count("\n", 0, match.start()) + 1,
                                    "context": content[
                                        max(0, match.start() - 40) : match.end() + 40
                                    ],
                                }
                            )
                except Exception:
                    continue
    return matches


def document_production_lot_fields():
    # Find model definition and field usage
    fields = set()
    model_files = glob.glob(
        os.path.join(PROJECT_ROOT, "**", "models.py"), recursive=True
    )
    for file in model_files:
        with open(file, "r", encoding="utf-8") as f:
            for line in f:
                if "production_lots" in line or "ProductionLot" in line:
                    fields.update(re.findall(r"(\w+)[ =:]", line))
    return list(fields)


def list_frontend_templates_and_js():
    templates = []
    js_files = []
    for root, _, files in os.walk(PROJECT_ROOT):
        for file in files:
            if file.endswith(".html") and "lot" in file:
                templates.append(os.path.join(root, file))
            if file.endswith(".js") and ("lot" in file or "production" in file):
                js_files.append(os.path.join(root, file))
    return templates, js_files


def create_dependency_map(references):
    # Map: service -> API -> template
    dep_map = {}
    for ref in references:
        file = ref["file"]
        if "/services/" in file:
            dep_map.setdefault("services", []).append(file)
        elif "/api/" in file:
            dep_map.setdefault("api", []).append(file)
        elif "/templates/" in file or file.endswith(".html"):
            dep_map.setdefault("templates", []).append(file)
        elif file.endswith(".js"):
            dep_map.setdefault("js", []).append(file)
    return dep_map


def main():
    all_refs = []
    for term in SEARCH_TERMS:
        refs = find_references(term)
        all_refs.extend(refs)
    fields = document_production_lot_fields()
    templates, js_files = list_frontend_templates_and_js()
    dep_map = create_dependency_map(all_refs)
    report = {
        "references": all_refs,
        "production_lot_fields": fields,
        "frontend_templates": templates,
        "frontend_js_files": js_files,
        "dependency_map": dep_map,
    }
    with open(REPORT_FILE, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print(f"Dependency report written to {REPORT_FILE}")


if __name__ == "__main__":
    main()
