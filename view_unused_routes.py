import json

with open('Project-root/enhanced_audit_report.json', 'r') as f:
    data = json.load(f)

routes = data['route_api_sync']['unused_backend']
print(f'Total unused routes: {len(routes)}\n')
print('First 40 unused routes:\n')
print('=' * 100)

for i, r in enumerate(routes[:40], 1):
    path = r.get('full_path', '?')
    methods = ', '.join(r.get('methods', []))
    blueprint = r.get('blueprint', 'N/A')
    print(f'{i:2}. {path:60} [{methods:20}] Blueprint: {blueprint}')

print('\n' + '=' * 100)
print('\nRoute categories:')
print(f'  - Authentication routes: {sum(1 for r in routes if "/auth/" in r.get("full_path", ""))}')
print(f'  - API routes: {sum(1 for r in routes if "/api/" in r.get("full_path", ""))}')
print(f'  - UI/Page routes: {sum(1 for r in routes if not "/api/" in r.get("full_path", "") and not "/auth/" in r.get("full_path", ""))}')
print(f'  - Static routes: {sum(1 for r in routes if "/static/" in r.get("full_path", ""))}')
