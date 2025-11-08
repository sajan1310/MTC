import json

with open("Project-root/enhanced_audit_report.json", "r") as f:
    data = json.load(f)

print("=" * 70)
print("MISSING BACKEND ROUTES:")
print("=" * 70)
for i, r in enumerate(data["route_api_sync"]["missing_backend"], 1):
    print(f"\n{i}. {r['url']} [{r['method']}]")
    print(f"   Called from: {r['file']}")
    print(f"   Message: {r['message']}")

print("\n" + "=" * 70)
print("HTTP METHOD MISMATCHES:")
print("=" * 70)
for i, m in enumerate(data["route_api_sync"]["method_mismatches"], 1):
    print(f"\n{i}. {m['url']}")
    print(f"   Backend supports: {', '.join(m['available_methods'])}")
    print(f"   Frontend uses: {m['method']}")
    print(f"   Called from: {m['file']}")
    print(f"   Message: {m['message']}")

print("\n" + "=" * 70)
print(f"UNUSED BACKEND ROUTES: {len(data['route_api_sync']['unused_backend'])} total")
print("=" * 70)
print("(Showing first 20 for review)")
for i, route in enumerate(data["route_api_sync"]["unused_backend"][:20], 1):
    methods = ", ".join(route.get("methods", []))
    path = route.get("full_path", route.get("path", "unknown"))
    print(f"{i}. {path} [{methods}]")
