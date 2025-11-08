import json

with open("Project-root/enhanced_audit_report.json", "r", encoding="utf-8") as f:
    data = json.load(f)

print("=" * 70)
print("MISSING BACKEND ROUTES (Frontend calling non-existent endpoints):")
print("=" * 70)
for i, r in enumerate(data["route_api_sync"]["missing_backend"], 1):
    print(f"\n{i}. {r['url']} [{r['method']}]")
    print(f"   Called from: {r['file']}")
    print(f"   Issue: {r['message']}")

print("\n" + "=" * 70)
print("HTTP METHOD MISMATCHES:")
print("=" * 70)
for i, m in enumerate(data["route_api_sync"]["method_mismatches"], 1):
    print(f"\n{i}. {m['url']}")
    print(f"   Backend supports: {', '.join(m['available_methods'])}")
    print(f"   Frontend uses: {m['method']}")
    print(f"   Called from: {m['file']}")
    print(f"   Issue: {m['message']}")

print("\n" + "=" * 70)
print("RECOMMENDED DATABASE INDEXES (for performance):")
print("=" * 70)
for idx in data["database"]["missing_indexes"]:
    print(f"  • {idx}")

print("\n" + "=" * 70)
print("STATIC ASSET RECOMMENDATIONS:")
print("=" * 70)
total_assets = len(data["static_assets"]["css_files"]) + len(
    data["static_assets"]["js_files"]
)
minified = data["static_assets"]["minified_count"]
print(f"  • Only {minified}/{total_assets} assets are minified")
print(
    f"  • Consider minifying CSS/JS for production ({data['static_assets']['total_size'] / 1024:.1f} KB total)"
)

# Show large files
print("\n  Large files (>50KB):")
for asset_type in ["css_files", "js_files"]:
    for asset in data["static_assets"][asset_type]:
        if asset["size"] > 50000:
            print(f"    - {asset['path']} ({asset['size'] / 1024:.1f} KB)")
