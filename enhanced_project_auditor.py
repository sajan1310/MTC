"""
Enhanced Flask Project Auditor - Version 2.0
=============================================
Improved route detection for Blueprint-based Flask applications.

ENHANCEMENTS:
- Detects @blueprint.route() patterns (api_bp, auth_bp, main_bp, etc.)
- Traces Blueprint registrations and URL prefixes
- Maps complete API endpoint paths
- Better handling of dynamic routes with <parameters>
"""

import os
import re
import json
import ast
from pathlib import Path
from collections import defaultdict
from typing import Dict, List, Set, Tuple, Any
from datetime import datetime


class EnhancedFlaskAuditor:
    """Enhanced auditor with Blueprint-aware route detection."""
    
    def __init__(self, project_root: str):
        self.project_root = Path(project_root)
        self.results = {
            "audit_timestamp": datetime.now().isoformat(),
            "project_root": str(self.project_root),
            "blueprints": [],
            "flask_routes": [],
            "route_summary": {},
            "javascript_api_calls": [],
            "route_api_sync": {
                "matched": [],
                "missing_backend": [],
                "unused_backend": [],
                "method_mismatches": []
            },
            "incomplete_functions": [],
            "duplicate_functions": [],
            "statistics": {},
            "errors": []
        }
        
        # Enhanced pattern for Blueprint routes
        # Note: Don't use re.DOTALL to prevent matching across multiple decorators
        self.route_pattern = re.compile(
            r'@(?:app|api_bp|auth_bp|main_bp|files_bp|process_api_bp|production_api_bp|'
            r'subprocess_api_bp|variant_api_bp|bp|blueprint)\.route\('
            r'[\'"]([^\'"]+)[\'"](?:[^\n]*?methods=\[([^\]]+)\])?'
        )
        
        # Blueprint registration pattern
        self.blueprint_reg_pattern = re.compile(
            r'app\.register_blueprint\((\w+)(?:,\s*url_prefix=[\'"]([^\'"]+)[\'"])?\)',
            re.DOTALL
        )
        
        # Blueprint definition pattern
        self.blueprint_def_pattern = re.compile(
            r'(\w+)\s*=\s*Blueprint\([\'"]([^\'"]+)[\'"]',
            re.DOTALL
        )
        
        # JS API call patterns
        self.fetch_pattern = re.compile(
            r'fetch\([\'"`]([^\'")`]+)[\'"`](?:.*?method:\s*[\'"`](\w+)[\'"`])?',
            re.DOTALL
        )
        self.ajax_pattern = re.compile(
            r'\$\.ajax\(\{[^}]*url:\s*[\'"`]([^\'")`]+)[\'"`][^}]*type:\s*[\'"`](\w+)[\'"`]',
            re.DOTALL
        )
        self.axios_pattern = re.compile(
            r'axios\.(\w+)\([\'"`]([^\'")`]+)[\'"`]',
            re.DOTALL
        )
    
    def log_error(self, error_msg: str, file_path: str = None):
        """Log an error."""
        error_entry = {
            "message": error_msg,
            "timestamp": datetime.now().isoformat()
        }
        if file_path:
            error_entry["file"] = str(file_path)
        self.results["errors"].append(error_entry)
        print(f"⚠️  ERROR: {error_msg}")
    
    def extract_blueprints(self) -> Dict[str, str]:
        """
        Extract Blueprint definitions and their URL prefixes.
        First looks at register_blueprint() calls, then checks Blueprint() definitions.
        
        Returns:
            Dict mapping blueprint variable names to their URL prefixes
        """
        print("🔍 Extracting Blueprint registrations...")
        
        blueprint_map = {}
        
        # Find __init__.py which typically contains Blueprint registrations
        init_file = self.project_root / "app" / "__init__.py"
        
        if not init_file.exists():
            self.log_error("app/__init__.py not found - cannot determine Blueprint prefixes")
            return blueprint_map
        
        try:
            with open(init_file, 'r', encoding='utf-8') as f:
                content = f.read()
            
            # Find Blueprint registrations
            matches = self.blueprint_reg_pattern.finditer(content)
            
            for match in matches:
                bp_var = match.group(1)
                url_prefix = match.group(2) or ""
                blueprint_map[bp_var] = url_prefix
                
                self.results["blueprints"].append({
                    "variable": bp_var,
                    "url_prefix": url_prefix,
                    "file": "app/__init__.py"
                })
            
            # For blueprints with empty prefix from register_blueprint(),
            # check if they have url_prefix in their Blueprint() definition
            for bp_var, prefix in list(blueprint_map.items()):
                if not prefix:  # Empty prefix, need to check definition
                    bp_prefix = self._find_blueprint_definition_prefix(bp_var)
                    if bp_prefix:
                        blueprint_map[bp_var] = bp_prefix
                        # Update results
                        for bp in self.results["blueprints"]:
                            if bp["variable"] == bp_var:
                                bp["url_prefix"] = bp_prefix
                                bp["source"] = "Blueprint definition"
                                break
            
            print(f"   ✓ Found {len(blueprint_map)} Blueprint registrations")
            
        except Exception as e:
            self.log_error(f"Error reading app/__init__.py: {str(e)}")
        
        return blueprint_map
    
    def _find_blueprint_definition_prefix(self, bp_var: str) -> str:
        """
        Find the url_prefix from a Blueprint() definition.
        
        Args:
            bp_var: Blueprint variable name (e.g., 'api_bp')
            
        Returns:
            URL prefix string or empty string if not found
        """
        try:
            # Search in common locations
            search_paths = [
                self.project_root / "app" / "api" / "__init__.py",
                self.project_root / "app" / "auth" / "__init__.py",
                self.project_root / "app" / "main" / "__init__.py",
                self.project_root / "app" / "__init__.py",
            ]
            
            # Pattern to match: bp_var = Blueprint(..., url_prefix="/something")
            pattern = re.compile(
                rf'{bp_var}\s*=\s*Blueprint\([^)]*url_prefix\s*=\s*[\'"]([^\'"]+)[\'"]',
                re.DOTALL
            )
            
            for search_path in search_paths:
                if search_path.exists():
                    with open(search_path, 'r', encoding='utf-8') as f:
                        content = f.read()
                        match = pattern.search(content)
                        if match:
                            return match.group(1)
        except Exception:
            pass
        
        return ""
    
    def extract_routes_with_blueprints(self, blueprint_map: Dict[str, str]) -> List[Dict[str, Any]]:
        """
        Extract all Flask routes including Blueprint routes.
        
        Args:
            blueprint_map: Mapping of Blueprint variables to URL prefixes
            
        Returns:
            List of route definitions
        """
        print("🛣️  Extracting Flask routes (Blueprint-aware)...")
        
        routes = []
        python_files = list(self.project_root.rglob("*.py"))
        
        for py_file in python_files:
            if any(excluded in str(py_file) for excluded in ['venv', '__pycache__', '.git']):
                continue
            
            try:
                with open(py_file, 'r', encoding='utf-8') as f:
                    content = f.read()
                
                # Find route decorators
                matches = self.route_pattern.finditer(content)
                
                for match in matches:
                    bp_var = match.group(0).split('.')[0].strip('@')
                    route_path = match.group(1)
                    methods_str = match.group(2)
                    
                    # Determine URL prefix
                    url_prefix = blueprint_map.get(bp_var, "")
                    
                    # Build full path
                    if url_prefix:
                        full_path = f"{url_prefix}{route_path}"
                    else:
                        full_path = route_path
                    
                    # Parse methods
                    if methods_str:
                        methods = [m.strip().strip('\'"') for m in methods_str.split(',')]
                    else:
                        methods = ['GET']
                    
                    # Find function name
                    start_pos = match.end()
                    remaining_content = content[start_pos:start_pos+500]
                    func_match = re.search(r'def\s+(\w+)\s*\(', remaining_content)
                    func_name = func_match.group(1) if func_match else "unknown"
                    
                    routes.append({
                        "file": str(py_file.relative_to(self.project_root)),
                        "blueprint": bp_var,
                        "route": route_path,
                        "full_path": full_path,
                        "methods": methods,
                        "handler": func_name
                    })
                
            except Exception as e:
                self.log_error(f"Error extracting routes from {py_file}: {str(e)}", str(py_file))
        
        self.results["flask_routes"] = routes
        
        # Generate summary
        self.results["route_summary"] = {
            "total_routes": len(routes),
            "by_method": self._count_by_method(routes),
            "by_blueprint": self._count_by_blueprint(routes)
        }
        
        print(f"   ✓ Found {len(routes)} Flask routes")
        return routes
    
    def _count_by_method(self, routes: List[Dict]) -> Dict[str, int]:
        """Count routes by HTTP method."""
        counts = defaultdict(int)
        for route in routes:
            for method in route["methods"]:
                counts[method] += 1
        return dict(counts)
    
    def _count_by_blueprint(self, routes: List[Dict]) -> Dict[str, int]:
        """Count routes by blueprint."""
        counts = defaultdict(int)
        for route in routes:
            counts[route["blueprint"]] += 1
        return dict(counts)
    
    def extract_javascript_api_calls(self) -> List[Dict[str, Any]]:
        """Extract API calls from JavaScript and HTML files."""
        print("📡 Extracting JavaScript API calls...")
        
        api_calls = []
        js_files = list(self.project_root.rglob("*.js"))
        html_files = list(self.project_root.rglob("*.html"))
        
        for file in js_files + html_files:
            if any(excluded in str(file) for excluded in ['venv', 'node_modules', '.git']):
                continue
            
            try:
                with open(file, 'r', encoding='utf-8', errors='ignore') as f:
                    content = f.read()
                
                # Fetch calls
                for match in self.fetch_pattern.finditer(content):
                    url = match.group(1)
                    method = match.group(2) if match.group(2) else 'GET'
                    api_calls.append({
                        "file": str(file.relative_to(self.project_root)),
                        "url": self._normalize_api_call_url(url),
                        "method": method.upper(),
                        "type": "fetch"
                    })
                
                # jQuery AJAX
                for match in self.ajax_pattern.finditer(content):
                    api_calls.append({
                        "file": str(file.relative_to(self.project_root)),
                        "url": self._normalize_api_call_url(match.group(1)),
                        "method": match.group(2).upper(),
                        "type": "ajax"
                    })
                
                # Axios
                for match in self.axios_pattern.finditer(content):
                    api_calls.append({
                        "file": str(file.relative_to(self.project_root)),
                        "url": self._normalize_api_call_url(match.group(2)),
                        "method": match.group(1).upper(),
                        "type": "axios"
                    })
                
            except Exception as e:
                self.log_error(f"Error extracting API calls from {file}: {str(e)}", str(file))
        
        self.results["javascript_api_calls"] = api_calls
        print(f"   ✓ Found {len(api_calls)} JavaScript API calls")
        return api_calls
    
    def _normalize_api_call_url(self, url: str) -> str:
        """
        Normalize API call URLs by resolving common configuration patterns.
        
        Args:
            url: Raw URL from JavaScript code
            
        Returns:
            Normalized URL with config variables resolved
        """
        # Handle ${App.config.apiBase} and similar patterns
        # These typically resolve to /api in most Flask apps
        url = re.sub(r'\$\{App\.config\.apiBase\}', '/api', url)
        url = re.sub(r'\$\{config\.apiBase\}', '/api', url)
        url = re.sub(r'\$\{apiBase\}', '/api', url)
        
        # Remove leading/trailing whitespace
        url = url.strip()
        
        return url
    
    def synchronize_routes_and_calls(self):
        """Compare backend routes with frontend API calls."""
        print("🔄 Synchronizing routes with API calls...")
        
        routes = self.results["flask_routes"]
        api_calls = self.results["javascript_api_calls"]
        
        # Build route lookup map
        route_map = defaultdict(set)
        for route in routes:
            normalized_path = self._normalize_path(route["full_path"])
            for method in route["methods"]:
                route_map[normalized_path].add(method.upper())
        
        # Check each API call
        for call in api_calls:
            url = call["url"]
            method = call["method"]
            
            # Skip external URLs
            if url.startswith('http://') or url.startswith('https://'):
                if not any(domain in url for domain in ['localhost', '127.0.0.1']):
                    continue
            
            # Skip template syntax
            if '{{' in url or '{%' in url:
                continue
            
            # Extract path
            path = url.split('?')[0].rstrip('/')
            if path.startswith('http'):
                path = '/' + '/'.join(path.split('/')[3:])
            
            normalized_path = self._normalize_path(path)
            
            # Find matching route
            matched = False
            method_match = False
            available_methods = []
            
            for route_pattern, methods in route_map.items():
                if self._route_matches(route_pattern, normalized_path):
                    matched = True
                    available_methods = list(methods)
                    if method in methods:
                        method_match = True
                        self.results["route_api_sync"]["matched"].append({
                            "url": url,
                            "method": method,
                            "route": route_pattern,
                            "file": call["file"]
                        })
                    break
            
            if not matched:
                self.results["route_api_sync"]["missing_backend"].append({
                    "url": url,
                    "method": method,
                    "file": call["file"],
                    "message": f"No backend route found for {method} {url}"
                })
            elif not method_match:
                self.results["route_api_sync"]["method_mismatches"].append({
                    "url": url,
                    "method": method,
                    "available_methods": available_methods,
                    "file": call["file"],
                    "message": f"Method {method} not allowed, available: {', '.join(available_methods)}"
                })
        
        # Find unused routes
        called_paths = set()
        for call in api_calls:
            path = call["url"].split('?')[0].rstrip('/')
            if path.startswith('http'):
                path = '/' + '/'.join(path.split('/')[3:])
            called_paths.add(self._normalize_path(path))
        
        for route in routes:
            normalized = self._normalize_path(route["full_path"])
            if not any(self._route_matches(normalized, called) for called in called_paths):
                # Skip admin/static/internal routes
                if not any(special in normalized for special in ['/static/', '/admin/', '/_', '/auth/']):
                    self.results["route_api_sync"]["unused_backend"].append({
                        "route": route["full_path"],
                        "methods": route["methods"],
                        "handler": route["handler"],
                        "file": route["file"],
                        "message": f"Route defined but not called from frontend"
                    })
        
        print(f"   ✓ Matched: {len(self.results['route_api_sync']['matched'])}")
        print(f"   ⚠️  Missing backend: {len(self.results['route_api_sync']['missing_backend'])}")
        print(f"   ⚠️  Method mismatches: {len(self.results['route_api_sync']['method_mismatches'])}")
        print(f"   ℹ️  Unused backend: {len(self.results['route_api_sync']['unused_backend'])}")
    
    def _normalize_path(self, path: str) -> str:
        """Normalize URL path for comparison - Enhanced to handle JS template literals."""
        # Convert Flask/JS variable syntax to regex patterns
        # <int:id> -> \d+
        # <path:filename> -> .+
        # <str:name> -> [^/]+
        # ${id} -> \d+ (assuming numeric IDs)
        # ${this.processId} -> \d+
        # {id} -> \d+
        
        # First, handle Flask parameter types
        path = re.sub(r'<int:\w+>', r'\\d+', path)
        path = re.sub(r'<float:\w+>', r'[\\d\\.]+', path)
        path = re.sub(r'<path:\w+>', r'.+', path)
        path = re.sub(r'<string:\w+>', r'[^/]+', path)
        path = re.sub(r'<str:\w+>', r'[^/]+', path)
        path = re.sub(r'<uuid:\w+>', r'[a-f0-9\\-]+', path)
        path = re.sub(r'<\w+:\w+>', r'[^/]+', path)  # Generic typed parameter
        path = re.sub(r'<\w+>', r'[^/]+', path)  # Untyped parameter
        
        # Handle JavaScript template literals (assume numeric IDs for process/item IDs)
        # ${this.processId} -> \d+
        # ${processId} -> \d+
        # ${id} -> \d+
        # ${usageId} -> \d+
        # ${groupId} -> \d+
        path = re.sub(r'\$\{[^}]*[iI]d[^}]*\}', r'\\d+', path)
        path = re.sub(r'\$\{[^}]*process[^}]*\}', r'\\d+', path)
        path = re.sub(r'\$\{[^}]*lot[^}]*\}', r'\\d+', path)
        path = re.sub(r'\$\{[^}]*item[^}]*\}', r'\\d+', path)
        
        # Generic JS template literal fallback
        path = re.sub(r'\$\{[^}]+\}', r'[^/]+', path)
        
        # Handle regular curly braces {id}
        path = re.sub(r'\{[^}]*[iI]d[^}]*\}', r'\\d+', path)
        path = re.sub(r'\{[^}]+\}', r'[^/]+', path)
        
        return path.rstrip('/')
    
    def _route_matches(self, route_pattern: str, actual_path: str) -> bool:
        """
        Check if a route pattern matches an actual path.
        Enhanced to handle dual routing (plural/singular) and template literals.
        """
        try:
            # Exact match first (fastest)
            if route_pattern == actual_path:
                return True
            
            # Try regex pattern matching
            pattern = f"^{route_pattern}$"
            if re.match(pattern, actual_path):
                return True
            
            # Handle dual routing: try both singular and plural forms
            # /processes/\d+ should match /process/\d+
            if '/processes/' in route_pattern and '/process/' in actual_path:
                alt_pattern = route_pattern.replace('/processes/', '/process/')
                if re.match(f"^{alt_pattern}$", actual_path):
                    return True
            elif '/process/' in route_pattern and '/processes/' in actual_path:
                alt_pattern = route_pattern.replace('/process/', '/processes/')
                if re.match(f"^{alt_pattern}$", actual_path):
                    return True
            
            # Same for subprocesses
            if '/subprocesses/' in route_pattern and '/subprocess/' in actual_path:
                alt_pattern = route_pattern.replace('/subprocesses/', '/subprocess/')
                if re.match(f"^{alt_pattern}$", actual_path):
                    return True
            elif '/subprocess/' in route_pattern and '/subprocesses/' in actual_path:
                alt_pattern = route_pattern.replace('/subprocess/', '/subprocesses/')
                if re.match(f"^{alt_pattern}$", actual_path):
                    return True
            
            # Same for production lots
            if '/production-lots/' in route_pattern and '/production_lot/' in actual_path:
                alt_pattern = route_pattern.replace('/production-lots/', '/production_lot/')
                if re.match(f"^{alt_pattern}$", actual_path):
                    return True
            elif '/production_lot/' in route_pattern and '/production-lots/' in actual_path:
                alt_pattern = route_pattern.replace('/production_lot/', '/production-lots/')
                if re.match(f"^{alt_pattern}$", actual_path):
                    return True
            
            return False
            
        except Exception as e:
            # Fallback to simple comparison
            return route_pattern == actual_path
    
    def run_audit(self) -> Dict[str, Any]:
        """Run the complete enhanced audit."""
        print("\n" + "="*60)
        print("🚀 Starting Enhanced Flask Project Audit")
        print("="*60 + "\n")
        
        try:
            # Extract Blueprint mappings
            blueprint_map = self.extract_blueprints()
            
            # Extract routes with Blueprint awareness
            self.extract_routes_with_blueprints(blueprint_map)
            
            # Extract JavaScript API calls
            self.extract_javascript_api_calls()
            
            # Synchronize routes and calls
            self.synchronize_routes_and_calls()
            
            # Generate statistics
            self.results["statistics"] = {
                "total_routes": len(self.results["flask_routes"]),
                "total_api_calls": len(self.results["javascript_api_calls"]),
                "matched_routes": len(self.results["route_api_sync"]["matched"]),
                "missing_backend": len(self.results["route_api_sync"]["missing_backend"]),
                "method_mismatches": len(self.results["route_api_sync"]["method_mismatches"]),
                "unused_backend": len(self.results["route_api_sync"]["unused_backend"]),
                "errors": len(self.results["errors"])
            }
            
            print("\n" + "="*60)
            print("✅ Enhanced Audit Complete!")
            print("="*60)
            
            return self.results
            
        except Exception as e:
            self.log_error(f"Fatal error during audit: {str(e)}")
            return self.results
    
    def save_report(self, output_file: str = "enhanced_audit_report.json"):
        """Save the audit report."""
        try:
            output_path = self.project_root / output_file
            
            with open(output_path, 'w', encoding='utf-8') as f:
                json.dump(self.results, f, indent=2, ensure_ascii=False)
            
            print(f"\n📄 Report saved to: {output_path}")
            print(f"   File size: {output_path.stat().st_size / 1024:.2f} KB")
            
        except Exception as e:
            self.log_error(f"Failed to save report: {str(e)}")


def main():
    """Main entry point."""
    import sys
    
    if len(sys.argv) > 1:
        project_root = sys.argv[1]
    else:
        current_dir = Path.cwd()
        if (current_dir / "Project-root").exists():
            project_root = current_dir / "Project-root"
        else:
            project_root = current_dir
    
    print(f"\n📂 Project root: {project_root}\n")
    
    auditor = EnhancedFlaskAuditor(project_root)
    results = auditor.run_audit()
    auditor.save_report()
    
    # Print summary
    print("\n" + "="*60)
    print("📋 AUDIT SUMMARY")
    print("="*60)
    stats = results["statistics"]
    print(f"  Total backend routes: {stats['total_routes']}")
    print(f"  Total frontend API calls: {stats['total_api_calls']}")
    print(f"  ✅ Matched & synchronized: {stats['matched_routes']}")
    print(f"  ❌ Missing backend routes: {stats['missing_backend']}")
    print(f"  ⚠️  HTTP method mismatches: {stats['method_mismatches']}")
    print(f"  ℹ️  Unused backend routes: {stats['unused_backend']}")
    print(f"  ⚠️  Errors encountered: {stats['errors']}")
    print("="*60 + "\n")
    
    if stats['missing_backend'] > 0:
        print("⚠️  WARNING: Frontend is calling backend routes that don't exist!")
    if stats['method_mismatches'] > 0:
        print("⚠️  WARNING: HTTP method mismatches detected!")
    
    print("\n✨ Review the detailed report in 'enhanced_audit_report.json'\n")


if __name__ == "__main__":
    main()
