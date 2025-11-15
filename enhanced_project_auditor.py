"""
Enhanced Flask Project Auditor - Version 3.0
=============================================
Comprehensive auditing for Flask applications with UPF support.

ENHANCEMENTS v3.0:
- UPF Inventory Alert System analysis
- Database schema and migration verification
- Test coverage statistics
- Documentation completeness check
- Security configuration audit

NOTE: Uses ASCII-safe output for Windows PowerShell compatibility
- Performance bottleneck detection
- Static asset analysis

ENHANCEMENTS v2.0:
- Detects @blueprint.route() patterns (api_bp, auth_bp, main_bp, etc.)
- Traces Blueprint registrations and URL prefixes
- Maps complete API endpoint paths
- Better handling of dynamic routes with <parameters>
"""

import re
import json
from pathlib import Path
from collections import defaultdict
from typing import Dict, List, Any
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
                "method_mismatches": [],
            },
            "upf_alert_system": {
                "process_bom_architecture": {},
                "production_lot_alerts": {},
                "alert_technical": {},
                "data_flow_integration": {},
                "alert_endpoints": {},
                "completeness": {},
            },
            "database": {
                "models": [],
                "migrations": [],
                "tables_found": [],
                "indexes": [],
                "missing_indexes": [],
            },
            "tests": {
                "test_files": [],
                "total_tests": 0,
                "coverage_summary": {},
                "missing_tests": [],
            },
            "documentation": {
                "markdown_files": [],
                "api_docs": [],
                "deployment_guides": [],
                "completeness_score": 0,
            },
            "security": {
                "env_vars_documented": [],
                "secrets_exposed": [],
                "csrf_protected": True,
                "https_enforced": False,
                "recommendations": [],
            },
            "performance": {
                "large_files": [],
                "unoptimized_queries": [],
                "missing_caching": [],
                "recommendations": [],
            },
            "static_assets": {
                "css_files": [],
                "js_files": [],
                "total_size": 0,
                "minified_count": 0,
            },
            "incomplete_functions": [],
            "duplicate_functions": [],
            "statistics": {},
            "errors": [],
        }

        # Enhanced pattern for Blueprint routes
        # Note: Don't use re.DOTALL to prevent matching across multiple decorators
        self.route_pattern = re.compile(
            r"@(?:app|api_bp|auth_bp|main_bp|files_bp|process_api_bp|production_api_bp|"
            r"subprocess_api_bp|variant_api_bp|reports_api_bp|inventory_alerts_bp|bp|blueprint)\.route\(\s*"
            r'[\'"]([^\'"]+)[\'"](?:.*?methods\s*=\s*\[([^\]]+)\])?',
            re.DOTALL,
        )

        # Blueprint registration pattern
        self.blueprint_reg_pattern = re.compile(
            r'app\.register_blueprint\((\w+)(?:,\s*url_prefix=[\'"]([^\'"]+)[\'"])?\)',
            re.DOTALL,
        )

        # Blueprint definition pattern
        self.blueprint_def_pattern = re.compile(
            r'(\w+)\s*=\s*Blueprint\([\'"]([^\'"]+)[\'"]', re.DOTALL
        )

        # JS API call patterns
        # Match fetch() calls and look for method in the immediate options object only (within 200 chars)
        self.fetch_pattern = re.compile(
            r'fetch\(\s*[\'"`]([^\'")`]+)[\'"`]\s*(?:,\s*\{.{0,200}?method:\s*[\'"`](\w+)[\'"`])?',
            re.DOTALL,
        )
        self.ajax_pattern = re.compile(
            r'\$\.ajax\(\{[^}]*url:\s*[\'"`]([^\'")`]+)[\'"`][^}]*type:\s*[\'"`](\w+)[\'"`]',
            re.DOTALL,
        )
        self.axios_pattern = re.compile(
            r'axios\.(\w+)\([\'"`]([^\'")`]+)[\'"`]', re.DOTALL
        )

    def log_error(self, error_msg: str, file_path: str = None):
        """Log an error."""
        error_entry = {"message": error_msg, "timestamp": datetime.now().isoformat()}
        if file_path:
            error_entry["file"] = str(file_path)
        self.results["errors"].append(error_entry)
        print(f"[!] ERROR: {error_msg}")

    def extract_blueprints(self) -> Dict[str, str]:
        """
        Extract Blueprint definitions and their URL prefixes.
        First looks at register_blueprint() calls, then checks Blueprint() definitions.

        Returns:
            Dict mapping blueprint variable names to their URL prefixes
        """
        print("[?] Extracting Blueprint registrations...")

        blueprint_map = {}

        # Find __init__.py which typically contains Blueprint registrations
        init_file = self.project_root / "app" / "__init__.py"

        if not init_file.exists():
            self.log_error(
                "app/__init__.py not found - cannot determine Blueprint prefixes"
            )
            return blueprint_map

        try:
            with open(init_file, "r", encoding="utf-8") as f:
                content = f.read()

            # Find Blueprint registrations
            matches = self.blueprint_reg_pattern.finditer(content)

            for match in matches:
                bp_var = match.group(1)
                url_prefix = match.group(2) or ""
                blueprint_map[bp_var] = url_prefix

                self.results["blueprints"].append(
                    {
                        "variable": bp_var,
                        "url_prefix": url_prefix,
                        "file": "app/__init__.py",
                    }
                )

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

            print(f"   [+] Found {len(blueprint_map)} Blueprint registrations")

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
                re.DOTALL,
            )

            for search_path in search_paths:
                if search_path.exists():
                    with open(search_path, "r", encoding="utf-8") as f:
                        content = f.read()
                        match = pattern.search(content)
                        if match:
                            return match.group(1)
        except Exception:
            pass

        return ""

    def extract_routes_with_blueprints(
        self, blueprint_map: Dict[str, str]
    ) -> List[Dict[str, Any]]:
        """
        Extract all Flask routes including Blueprint routes.

        Args:
            blueprint_map: Mapping of Blueprint variables to URL prefixes

        Returns:
            List of route definitions
        """
        print("[ROUTES]  Extracting Flask routes (Blueprint-aware)...")

        routes = []
        python_files = list(self.project_root.rglob("*.py"))

        for py_file in python_files:
            if any(
                excluded in str(py_file) for excluded in ["venv", "__pycache__", ".git"]
            ):
                continue

            try:
                with open(py_file, "r", encoding="utf-8") as f:
                    content = f.read()

                # Find route decorators
                matches = self.route_pattern.finditer(content)

                for match in matches:
                    bp_var = match.group(0).split(".")[0].strip("@")
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
                        methods = [
                            m.strip().strip("'\"") for m in methods_str.split(",")
                        ]
                    else:
                        methods = ["GET"]

                    # Find function name
                    start_pos = match.end()
                    remaining_content = content[start_pos : start_pos + 500]
                    func_match = re.search(r"def\s+(\w+)\s*\(", remaining_content)
                    func_name = func_match.group(1) if func_match else "unknown"

                    routes.append(
                        {
                            "file": str(py_file.relative_to(self.project_root)),
                            "blueprint": bp_var,
                            "route": route_path,
                            "full_path": full_path,
                            "methods": methods,
                            "handler": func_name,
                        }
                    )

                # Fallback: simple pattern for missed single-line routes
                # e.g. @main_bp.route("/api/login", methods=["POST"])
                simple_pattern = re.compile(
                    r"@(\w+)\.route\(\s*[\'\"]([^\'\"]+)[\'\"]\s*,\s*methods=\[([^\]]+)\]\s*\)",
                    re.DOTALL,
                )
                for sm in simple_pattern.finditer(content):
                    bp_var = sm.group(1)
                    route_path = sm.group(2)
                    methods_str = sm.group(3)
                    url_prefix = blueprint_map.get(bp_var, "")
                    full_path = (
                        f"{url_prefix}{route_path}" if url_prefix else route_path
                    )
                    methods = [m.strip().strip("'\"") for m in methods_str.split(",")]
                    # Skip if already captured
                    if any(
                        r["file"] == str(py_file.relative_to(self.project_root))
                        and r["route"] == route_path
                        and r["blueprint"] == bp_var
                        for r in routes
                    ):
                        continue
                    routes.append(
                        {
                            "file": str(py_file.relative_to(self.project_root)),
                            "blueprint": bp_var,
                            "route": route_path,
                            "full_path": full_path,
                            "methods": methods,
                            "handler": "unknown",
                            "extraction": "fallback_simple_pattern",
                        }
                    )

            except Exception as e:
                self.log_error(
                    f"Error extracting routes from {py_file}: {str(e)}", str(py_file)
                )

        self.results["flask_routes"] = routes

        # Generate summary
        self.results["route_summary"] = {
            "total_routes": len(routes),
            "by_method": self._count_by_method(routes),
            "by_blueprint": self._count_by_blueprint(routes),
        }

        print(f"   [+] Found {len(routes)} Flask routes")
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
        print("[SYNC] Extracting JavaScript API calls...")

        api_calls = []
        js_files = list(self.project_root.rglob("*.js"))
        html_files = list(self.project_root.rglob("*.html"))

        for file in js_files + html_files:
            if any(
                excluded in str(file) for excluded in ["venv", "node_modules", ".git"]
            ):
                continue

            try:
                with open(file, "r", encoding="utf-8", errors="ignore") as f:
                    content = f.read()

                # Fetch calls
                for match in self.fetch_pattern.finditer(content):
                    url = match.group(1)
                    method = match.group(2) if match.group(2) else "GET"
                    api_calls.append(
                        {
                            "file": str(file.relative_to(self.project_root)),
                            "url": self._normalize_api_call_url(url),
                            "method": method.upper(),
                            "type": "fetch",
                        }
                    )

                # jQuery AJAX
                for match in self.ajax_pattern.finditer(content):
                    api_calls.append(
                        {
                            "file": str(file.relative_to(self.project_root)),
                            "url": self._normalize_api_call_url(match.group(1)),
                            "method": match.group(2).upper(),
                            "type": "ajax",
                        }
                    )

                # Axios
                for match in self.axios_pattern.finditer(content):
                    api_calls.append(
                        {
                            "file": str(file.relative_to(self.project_root)),
                            "url": self._normalize_api_call_url(match.group(2)),
                            "method": match.group(1).upper(),
                            "type": "axios",
                        }
                    )

            except Exception as e:
                self.log_error(
                    f"Error extracting API calls from {file}: {str(e)}", str(file)
                )

        self.results["javascript_api_calls"] = api_calls
        print(f"   [+] Found {len(api_calls)} JavaScript API calls")
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
        url = re.sub(r"\$\{App\.config\.apiBase\}", "/api", url)
        url = re.sub(r"\$\{config\.apiBase\}", "/api", url)
        url = re.sub(r"\$\{apiBase\}", "/api", url)

        # Handle helper function patterns like `/api${path}` where path is a variable
        # These are template concatenations, not actual URLs - skip them
        if re.match(r"^/api\$\{[^}]+\}$", url):
            # This is a helper function pattern, mark as invalid
            return "__HELPER_FUNCTION_PATTERN__"

        # Remove leading/trailing whitespace
        url = url.strip()

        return url

    def synchronize_routes_and_calls(self):
        """Compare backend routes with frontend API calls."""
        print("[LOOP] Synchronizing routes with API calls...")

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

            # Skip helper function patterns
            if url == "__HELPER_FUNCTION_PATTERN__":
                continue

            # Skip external URLs
            if url.startswith("http://") or url.startswith("https://"):
                if not any(domain in url for domain in ["localhost", "127.0.0.1"]):
                    continue

            # Skip template syntax
            if "{{" in url or "{%" in url:
                continue

            # Extract path
            path = url.split("?")[0].rstrip("/")
            if path.startswith("http"):
                path = "/" + "/".join(path.split("/")[3:])

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
                        self.results["route_api_sync"]["matched"].append(
                            {
                                "url": url,
                                "method": method,
                                "route": route_pattern,
                                "file": call["file"],
                            }
                        )
                    break

            if not matched:
                self.results["route_api_sync"]["missing_backend"].append(
                    {
                        "url": url,
                        "method": method,
                        "file": call["file"],
                        "message": f"No backend route found for {method} {url}",
                    }
                )
            elif not method_match:
                self.results["route_api_sync"]["method_mismatches"].append(
                    {
                        "url": url,
                        "method": method,
                        "available_methods": available_methods,
                        "file": call["file"],
                        "message": f"Method {method} not allowed, available: {', '.join(available_methods)}",
                    }
                )

        # Find unused routes
        called_paths = set()
        for call in api_calls:
            path = call["url"].split("?")[0].rstrip("/")
            if path.startswith("http"):
                path = "/" + "/".join(path.split("/")[3:])
            called_paths.add(self._normalize_path(path))

        for route in routes:
            normalized = self._normalize_path(route["full_path"])
            if not any(
                self._route_matches(normalized, called) for called in called_paths
            ):
                # Skip admin/static/internal routes
                if not any(
                    special in normalized
                    for special in ["/static/", "/admin/", "/_", "/auth/"]
                ):
                    self.results["route_api_sync"]["unused_backend"].append(
                        {
                            "route": route["full_path"],
                            "methods": route["methods"],
                            "handler": route["handler"],
                            "file": route["file"],
                            "message": "Route defined but not called from frontend",
                        }
                    )

        print(f"   [+] Matched: {len(self.results['route_api_sync']['matched'])}")
        print(
            f"   [!]  Missing backend: {len(self.results['route_api_sync']['missing_backend'])}"
        )
        print(
            f"   [!]  Method mismatches: {len(self.results['route_api_sync']['method_mismatches'])}"
        )
        print(
            f"   [i]  Unused backend: {len(self.results['route_api_sync']['unused_backend'])}"
        )

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
        path = re.sub(r"<int:\w+>", r"\\d+", path)
        path = re.sub(r"<float:\w+>", r"[\\d\\.]+", path)
        path = re.sub(r"<path:\w+>", r".+", path)
        path = re.sub(r"<string:\w+>", r"[^/]+", path)
        path = re.sub(r"<str:\w+>", r"[^/]+", path)
        path = re.sub(r"<uuid:\w+>", r"[a-f0-9\\-]+", path)
        path = re.sub(r"<\w+:\w+>", r"[^/]+", path)  # Generic typed parameter
        path = re.sub(r"<\w+>", r"[^/]+", path)  # Untyped parameter

        # Handle JavaScript template literals (assume numeric IDs for process/item IDs)
        # ${this.processId} -> \d+
        # ${processId} -> \d+
        # ${id} -> \d+
        # ${usageId} -> \d+
        # ${groupId} -> \d+
        path = re.sub(r"\$\{[^}]*[iI]d[^}]*\}", r"\\d+", path)
        path = re.sub(r"\$\{[^}]*process[^}]*\}", r"\\d+", path)
        path = re.sub(r"\$\{[^}]*lot[^}]*\}", r"\\d+", path)
        path = re.sub(r"\$\{[^}]*item[^}]*\}", r"\\d+", path)

        # Generic JS template literal fallback
        path = re.sub(r"\$\{[^}]+\}", r"[^/]+", path)

        # Handle regular curly braces {id}
        path = re.sub(r"\{[^}]*[iI]d[^}]*\}", r"\\d+", path)
        path = re.sub(r"\{[^}]+\}", r"[^/]+", path)

        return path.rstrip("/")

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
            if "/processes/" in route_pattern and "/process/" in actual_path:
                alt_pattern = route_pattern.replace("/processes/", "/process/")
                if re.match(f"^{alt_pattern}$", actual_path):
                    return True
            elif "/process/" in route_pattern and "/processes/" in actual_path:
                alt_pattern = route_pattern.replace("/process/", "/processes/")
                if re.match(f"^{alt_pattern}$", actual_path):
                    return True

            # Same for subprocesses
            if "/subprocesses/" in route_pattern and "/subprocess/" in actual_path:
                alt_pattern = route_pattern.replace("/subprocesses/", "/subprocess/")
                if re.match(f"^{alt_pattern}$", actual_path):
                    return True
            elif "/subprocess/" in route_pattern and "/subprocesses/" in actual_path:
                alt_pattern = route_pattern.replace("/subprocess/", "/subprocesses/")
                if re.match(f"^{alt_pattern}$", actual_path):
                    return True

            # Same for production lots
            if (
                "/production-lots/" in route_pattern
                and "/production_lot/" in actual_path
            ):
                alt_pattern = route_pattern.replace(
                    "/production-lots/", "/production_lot/"
                )
                if re.match(f"^{alt_pattern}$", actual_path):
                    return True
            elif (
                "/production_lot/" in route_pattern
                and "/production-lots/" in actual_path
            ):
                alt_pattern = route_pattern.replace(
                    "/production_lot/", "/production-lots/"
                )
                if re.match(f"^{alt_pattern}$", actual_path):
                    return True

            return False

        except Exception:
            # Fallback to simple comparison
            return route_pattern == actual_path

    def audit_upf_alert_system(self):
        """Audit the complete UPF framework implementation against executive summary."""
        print("[ALERT] Auditing Universal Process Framework (UPF) Implementation...")

        upf_data = self.results["upf_alert_system"]

        # === 1. Advanced BOM-Centric Process Architecture ===
        print("   [LIST] Auditing Process/BOM Architecture...")
        upf_data["process_bom_architecture"] = self._audit_process_bom_architecture()

        # === 2. Production Lot Architecture with Alert System ===
        print("   [PROD] Auditing Production Lot Alert System...")
        upf_data["production_lot_alerts"] = self._audit_production_lot_alerts()

        # === 3. Alert System Technical Architecture ===
        print("   [GEAR]  Auditing Alert Technical Architecture...")
        upf_data["alert_technical"] = self._audit_alert_technical_architecture()

        # === 4. Data Flow and Integration ===
        print("   [LOOP] Auditing Data Flow Integration...")
        upf_data["data_flow_integration"] = self._audit_data_flow_integration()

        # === 5. Legacy Alert System Checks (from original) ===
        print("   [BELL] Auditing Alert System Endpoints...")
        upf_data["alert_endpoints"] = self._audit_alert_endpoints()

        # Calculate overall completeness
        upf_data["completeness"] = self._calculate_upf_completeness(upf_data)

        print(
            f"   [OK] UPF Framework Completeness: {upf_data['completeness']['overall_score']:.1f}%"
        )

    def _audit_process_bom_architecture(self) -> Dict[str, Any]:
        """Audit Section 1: Advanced BOM-Centric Process Architecture."""
        results = {
            "process_as_bom": {"present": False, "files": []},
            "subprocess_templates": {"present": False, "files": []},
            "variant_cost_supplier": {"present": False, "files": []},
            "user_experience": {"present": False, "files": []},
            "audit_trail": {"present": False, "files": []},
            "completeness": 0,
        }

        # Check for process models and services
        process_files = [
            "app/models/process.py",
            "app/services/process_service.py",
            "app/api/process_management.py",
        ]
        for file in process_files:
            if (self.project_root / file).exists():
                results["process_as_bom"]["files"].append(file)
                results["process_as_bom"]["present"] = True

        # Check for subprocess template system
        subprocess_files = [
            "app/models/process.py",  # Subprocess class
            "app/services/subprocess_service.py",
            "app/api/subprocess_management.py",
        ]
        for file in subprocess_files:
            if (self.project_root / file).exists():
                results["subprocess_templates"]["files"].append(file)
                results["subprocess_templates"]["present"] = True

        # Check for variant/cost/supplier integration
        variant_files = [
            "app/services/variant_service.py",
            "app/services/costing_service.py",
            "app/models/process.py",  # VariantSupplierPricing
        ]
        for file in variant_files:
            if (self.project_root / file).exists():
                results["variant_cost_supplier"]["files"].append(file)
                # Check for supplier pricing logic
                try:
                    with open(self.project_root / file, "r", encoding="utf-8") as f:
                        content = f.read()
                        if "supplier" in content.lower() and "cost" in content.lower():
                            results["variant_cost_supplier"]["present"] = True
                except Exception:
                    pass

        # Check for user experience features (drag-drop, search, validation)
        ux_files = [
            "templates/upf_process_editor.html",
            "static/js/process_editor.js",
            "app/validators/process_validator.py",
        ]
        for file in ux_files:
            if (self.project_root / file).exists():
                results["user_experience"]["files"].append(file)
                results["user_experience"]["present"] = True

        # Check for audit trail and state management
        audit_files = [
            "app/models/process.py",  # Check for created_at, updated_at fields
            "app/services/process_service.py",
        ]
        for file in audit_files:
            if (self.project_root / file).exists():
                results["audit_trail"]["files"].append(file)
                try:
                    with open(self.project_root / file, "r", encoding="utf-8") as f:
                        content = f.read()
                        if "created_at" in content and "updated_at" in content:
                            results["audit_trail"]["present"] = True
                except Exception:
                    pass

        # Calculate completeness
        checks = [
            results["process_as_bom"]["present"],
            results["subprocess_templates"]["present"],
            results["variant_cost_supplier"]["present"],
            results["user_experience"]["present"],
            results["audit_trail"]["present"],
        ]
        results["completeness"] = sum(checks) / len(checks) * 100

        return results

    def _audit_production_lot_alerts(self) -> Dict[str, Any]:
        """Audit Section 2: Production Lot Architecture with Integrated Alert System."""
        results = {
            "lot_creation": {"present": False, "files": []},
            "realtime_stock_analysis": {"present": False, "files": []},
            "alert_severity_levels": {"present": False, "details": []},
            "alert_display_interaction": {"present": False, "files": []},
            "automatic_procurement": {"present": False, "files": []},
            "item_requirement_sheet": {"present": False, "files": []},
            "lot_audit_trail": {"present": False, "files": []},
            "completeness": 0,
        }

        # Check lot creation workflow
        lot_files = [
            "app/services/production_service.py",
            "app/api/production_lot.py",
            "templates/upf_production_lots.html",
        ]
        for file in lot_files:
            if (self.project_root / file).exists():
                results["lot_creation"]["files"].append(file)
                results["lot_creation"]["present"] = True

        # Check for real-time stock analysis
        alert_service = self.project_root / "app/services/inventory_alert_service.py"
        if alert_service.exists():
            results["realtime_stock_analysis"]["files"].append(
                str(alert_service.relative_to(self.project_root))
            )
            try:
                with open(alert_service, "r", encoding="utf-8") as f:
                    content = f.read()
                    if (
                        "check_inventory_levels" in content
                        or "evaluate_variant_stock" in content
                    ):
                        results["realtime_stock_analysis"]["present"] = True
            except Exception:
                pass

        # Check for alert severity levels (CRITICAL, HIGH, MEDIUM, LOW, OK)
        severity_patterns = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "OK"]
        db_files = [
            "migrations/migration_add_inventory_alert_system.py",
            "app/services/inventory_alert_service.py",
        ]
        for file in db_files:
            if (self.project_root / file).exists():
                try:
                    with open(self.project_root / file, "r", encoding="utf-8") as f:
                        content = f.read()
                        found_severities = [
                            s for s in severity_patterns if s in content
                        ]
                        if len(found_severities) >= 4:  # At least 4 severity levels
                            results["alert_severity_levels"]["present"] = True
                            results["alert_severity_levels"][
                                "details"
                            ] = found_severities
                except Exception:
                    pass

        # Check for alert display and user interaction
        ui_files = [
            "templates/upf_production_lot_detail.html",
            "static/js/production_lot_alerts.js",
        ]
        for file in ui_files:
            if (self.project_root / file).exists():
                results["alert_display_interaction"]["files"].append(file)
                results["alert_display_interaction"]["present"] = True

        # Check for automatic procurement alerts
        procurement_files = [
            "app/services/inventory_alert_service.py",
            "migrations/migration_add_inventory_alert_system.py",
        ]
        for file in procurement_files:
            if (self.project_root / file).exists():
                try:
                    with open(self.project_root / file, "r", encoding="utf-8") as f:
                        content = f.read()
                        if "procurement_recommendation" in content.lower():
                            results["automatic_procurement"]["files"].append(file)
                            results["automatic_procurement"]["present"] = True
                except Exception:
                    pass

        # Check for Item Requirement Sheet generation
        irs_patterns = ["requirement", "sheet", "IRS"]
        service_files = [
            "app/services/production_service.py",
            "templates/upf_production_lot_detail.html",
        ]
        for file in service_files:
            if (self.project_root / file).exists():
                try:
                    with open(self.project_root / file, "r", encoding="utf-8") as f:
                        content = f.read()
                        if any(p.lower() in content.lower() for p in irs_patterns):
                            results["item_requirement_sheet"]["files"].append(file)
                            results["item_requirement_sheet"]["present"] = True
                except Exception:
                    pass

        # Check for lot audit trail
        audit_columns = [
            "inventory_validated_at",
            "inventory_validated_by",
            "alert_summary_json",
        ]
        migration_files = [
            self.project_root / "migrations/migration_add_inventory_alert_system.py",
            self.project_root
            / "Project-root/migrations/migration_add_inventory_alert_system.py",
            self.project_root
            / "migrations/migration_add_inventory_alert_system_temp.py",
        ]
        for migration_file in migration_files:
            if migration_file.exists():
                try:
                    with open(migration_file, "r", encoding="utf-8") as f:
                        content = f.read()
                        if all(col in content for col in audit_columns):
                            results["lot_audit_trail"]["files"].append(
                                str(migration_file.relative_to(self.project_root))
                            )
                            results["lot_audit_trail"]["present"] = True
                            break
                except Exception:
                    pass

        # Calculate completeness
        checks = [
            results["lot_creation"]["present"],
            results["realtime_stock_analysis"]["present"],
            results["alert_severity_levels"]["present"],
            results["alert_display_interaction"]["present"],
            results["automatic_procurement"]["present"],
            results["item_requirement_sheet"]["present"],
            results["lot_audit_trail"]["present"],
        ]
        results["completeness"] = sum(checks) / len(checks) * 100

        return results

    def _audit_alert_technical_architecture(self) -> Dict[str, Any]:
        """Audit Section 3: Alert System Technical Architecture."""
        results = {
            "realtime_inventory_query": {"present": False, "files": []},
            "alert_escalation_rules": {"present": False, "files": []},
            "safety_stock_reorder": {"present": False, "files": []},
            "completeness": 0,
        }

        # Check for real-time inventory query integration
        query_files = [
            "app/services/inventory_alert_service.py",
            "app/services/variant_service.py",
        ]
        for file in query_files:
            if (self.project_root / file).exists():
                try:
                    with open(self.project_root / file, "r", encoding="utf-8") as f:
                        content = f.read()
                        if "opening_stock" in content or "current_stock" in content:
                            results["realtime_inventory_query"]["files"].append(file)
                            results["realtime_inventory_query"]["present"] = True
                except Exception:
                    pass

        # Check for alert escalation rules
        alert_service = self.project_root / "app/services/inventory_alert_service.py"
        if alert_service.exists():
            try:
                with open(alert_service, "r", encoding="utf-8") as f:
                    content = f.read()
                    # Look for severity logic
                    if "CRITICAL" in content and "required_quantity" in content:
                        results["alert_escalation_rules"]["files"].append(
                            str(alert_service.relative_to(self.project_root))
                        )
                        results["alert_escalation_rules"]["present"] = True
            except Exception:
                pass

        # Check for safety stock and reorder points
        migration_file = (
            self.project_root / "migrations/migration_add_inventory_alert_system.py"
        )
        if migration_file.exists():
            try:
                with open(migration_file, "r", encoding="utf-8") as f:
                    content = f.read()
                    if "safety_stock" in content and "reorder_point" in content:
                        results["safety_stock_reorder"]["files"].append(
                            str(migration_file.relative_to(self.project_root))
                        )
                        results["safety_stock_reorder"]["present"] = True
            except Exception:
                pass

        # Calculate completeness
        checks = [
            results["realtime_inventory_query"]["present"],
            results["alert_escalation_rules"]["present"],
            results["safety_stock_reorder"]["present"],
        ]
        results["completeness"] = sum(checks) / len(checks) * 100

        return results

    def _audit_data_flow_integration(self) -> Dict[str, Any]:
        """Audit Section 4: Data Flow Overview."""
        results = {
            "inventory_system": {"present": False, "files": []},
            "supplier_vendor_db": {"present": False, "files": []},
            "process_bom_library": {"present": False, "files": []},
            "alert_notification_engine": {"present": False, "files": []},
            "ledger_reporting": {"present": False, "files": []},
            "completeness": 0,
        }

        # Check inventory system integration
        inventory_files = [
            "app/models/process.py",  # VariantSupplierPricing
            "app/services/variant_service.py",
        ]
        for file in inventory_files:
            if (self.project_root / file).exists():
                results["inventory_system"]["files"].append(file)
                results["inventory_system"]["present"] = True

        # Check supplier/vendor database
        supplier_patterns = ["supplier", "vendor"]
        db_files = [
            "app/models/process.py",
            "app/services/variant_service.py",
        ]
        for file in db_files:
            if (self.project_root / file).exists():
                try:
                    with open(self.project_root / file, "r", encoding="utf-8") as f:
                        content = f.read()
                        if any(p in content.lower() for p in supplier_patterns):
                            results["supplier_vendor_db"]["files"].append(file)
                            results["supplier_vendor_db"]["present"] = True
                except Exception:
                    pass

        # Check process/BOM library
        process_files = [
            "app/models/process.py",
            "app/services/process_service.py",
            "app/services/subprocess_service.py",
        ]
        for file in process_files:
            if (self.project_root / file).exists():
                results["process_bom_library"]["files"].append(file)
                results["process_bom_library"]["present"] = True

        # Check alert & notification engine
        alert_files = [
            "app/services/inventory_alert_service.py",
            "app/api/inventory_alerts.py",
        ]
        for file in alert_files:
            if (self.project_root / file).exists():
                results["alert_notification_engine"]["files"].append(file)
                results["alert_notification_engine"]["present"] = True

        # Check ledger/reporting
        ledger_patterns = [
            "created_at",
            "updated_at",
            "timestamp",
            "track",
            "history",
            "audit",
        ]
        reporting_files = [
            "app/services/production_service.py",
            "app/models/production_lot.py",
            "migrations/migration_add_inventory_alert_system.py",
        ]
        for file in reporting_files:
            if (self.project_root / file).exists():
                try:
                    with open(self.project_root / file, "r", encoding="utf-8") as f:
                        content = f.read()
                        # Check for audit/tracking features (at least 2 patterns)
                        found = sum(1 for p in ledger_patterns if p in content.lower())
                        if found >= 2:
                            results["ledger_reporting"]["files"].append(file)
                            results["ledger_reporting"]["present"] = True
                            break
                except Exception:
                    pass

        # Calculate completeness
        checks = [
            results["inventory_system"]["present"],
            results["supplier_vendor_db"]["present"],
            results["process_bom_library"]["present"],
            results["alert_notification_engine"]["present"],
            results["ledger_reporting"]["present"],
        ]
        results["completeness"] = sum(checks) / len(checks) * 100

        return results

    def _audit_alert_endpoints(self) -> Dict[str, Any]:
        """Audit alert system API endpoints (legacy check)."""
        results = {
            "endpoints": [],
            "services": [],
            "templates": [],
            "static_assets": [],
            "tests": [],
            "documentation": [],
        }

        # Check for alert endpoints
        alert_endpoints = [
            "/api/inventory-alerts",
            "/api/inventory-alert-rules",
            "/api/procurement-recommendations",
            "/upf/production-lots",
            "/upf/production-lot/",
            "/monitoring",
        ]

        for route in self.results["flask_routes"]:
            if any(endpoint in route["full_path"] for endpoint in alert_endpoints):
                results["endpoints"].append(route)

        # Check for alert service
        service_file = self.project_root / "app/services/inventory_alert_service.py"
        if service_file.exists():
            results["services"].append(str(service_file.relative_to(self.project_root)))

        # Check templates
        template_files = [
            "templates/upf_production_lots.html",
            "templates/upf_production_lot_detail.html",
            "templates/monitoring.html",
        ]
        for template in template_files:
            if (self.project_root / template).exists():
                results["templates"].append(template)

        # Check static assets
        static_files = [
            "static/js/production_lot_alerts.js",
            "static/css/inventory_alerts.css",
        ]
        for asset in static_files:
            if (self.project_root / asset).exists():
                results["static_assets"].append(asset)

        # Check tests
        test_files = [
            "tests/api/test_inventory_alerts.py",
            "tests/api/test_monitoring.py",
            "tests/ui/test_upf_pages.py",
        ]
        for test in test_files:
            if (self.project_root / test).exists():
                results["tests"].append(test)

        # Check documentation
        doc_files = [
            "docs/UPF_INVENTORY_ALERTS_USAGE.md",
            "docs/ALERT_UI_INTEGRATION.md",
            "API_REFERENCE_INVENTORY_ALERTS.md",
        ]
        for doc in doc_files:
            if (self.project_root / doc).exists():
                results["documentation"].append(doc)

        return results

    def _calculate_upf_completeness(self, upf_data: Dict[str, Any]) -> Dict[str, Any]:
        """Calculate overall UPF framework completeness."""
        completeness = {}

        # Section scores
        completeness["process_bom"] = upf_data["process_bom_architecture"][
            "completeness"
        ]
        completeness["production_lot_alerts"] = upf_data["production_lot_alerts"][
            "completeness"
        ]
        completeness["alert_technical"] = upf_data["alert_technical"]["completeness"]
        completeness["data_flow"] = upf_data["data_flow_integration"]["completeness"]

        # Endpoint/file counts
        alert_ep = upf_data["alert_endpoints"]
        completeness["endpoints"] = (
            f"{len(alert_ep['endpoints'])}/6 ({len(alert_ep['endpoints']) / 6 * 100:.0f}%)"
        )
        completeness["services"] = (
            f"{len(alert_ep['services'])}/1 ({len(alert_ep['services']) * 100:.0f}%)"
        )
        completeness["templates"] = (
            f"{len(alert_ep['templates'])}/3 ({len(alert_ep['templates']) / 3 * 100:.0f}%)"
        )
        completeness["static_assets"] = (
            f"{len(alert_ep['static_assets'])}/2 ({len(alert_ep['static_assets']) / 2 * 100:.0f}%)"
        )
        completeness["tests"] = (
            f"{len(alert_ep['tests'])}/3 ({len(alert_ep['tests']) / 3 * 100:.0f}%)"
        )
        completeness["documentation"] = (
            f"{len(alert_ep['documentation'])}/3 ({len(alert_ep['documentation']) / 3 * 100:.0f}%)"
        )

        # Overall score (weighted average)
        section_scores = [
            completeness["process_bom"],
            completeness["production_lot_alerts"],
            completeness["alert_technical"],
            completeness["data_flow"],
        ]
        completeness["overall_score"] = sum(section_scores) / len(section_scores)

        return completeness

    def audit_database(self):
        """Audit database models and migrations."""
        print("[FILE]  Auditing Database...")

        db_data = self.results["database"]

        # Find models
        models_file = self.project_root / "app" / "models.py"
        if models_file.exists():
            db_data["models"].append("app/models.py")

        models_dir = self.project_root / "app" / "models"
        if models_dir.exists():
            for model_file in models_dir.glob("*.py"):
                if model_file.name != "__init__.py":
                    db_data["models"].append(
                        str(model_file.relative_to(self.project_root))
                    )

        # Find migrations
        migrations_dir = self.project_root / "migrations"
        if migrations_dir.exists():
            for migration in migrations_dir.glob("*.sql"):
                db_data["migrations"].append(
                    str(migration.relative_to(self.project_root))
                )

        # Check for alert table in migrations
        for migration in db_data["migrations"]:
            try:
                with open(self.project_root / migration, "r", encoding="utf-8") as f:
                    content = f.read().lower()
                    if "production_lot_inventory_alerts" in content:
                        db_data["tables_found"].append(
                            "production_lot_inventory_alerts"
                        )
            except Exception:
                pass

        # Check for recommended indexes
        recommended_indexes = [
            "idx_inventory_alerts_lot_id",
            "idx_inventory_alerts_severity",
            "idx_production_lots_status",
        ]

        for migration in db_data["migrations"]:
            try:
                with open(self.project_root / migration, "r", encoding="utf-8") as f:
                    content = f.read()
                    for idx in recommended_indexes:
                        if idx in content:
                            db_data["indexes"].append(idx)
            except Exception:
                pass

        for idx in recommended_indexes:
            if idx not in db_data["indexes"]:
                db_data["missing_indexes"].append(idx)

        print(f"   [+] Found {len(db_data['models'])} model files")
        print(f"   [+] Found {len(db_data['migrations'])} migration files")
        print(f"   [+] Found {len(db_data['indexes'])} indexes")

    def audit_tests(self):
        """Audit test coverage."""
        print("[TEST] Auditing Tests...")

        test_data = self.results["tests"]

        # Find test files
        tests_dir = self.project_root / "tests"
        if tests_dir.exists():
            for test_file in tests_dir.rglob("test_*.py"):
                test_data["test_files"].append(
                    str(test_file.relative_to(self.project_root))
                )

                # Count tests in file
                try:
                    with open(test_file, "r", encoding="utf-8") as f:
                        content = f.read()
                        test_count = len(re.findall(r"def test_\w+", content))
                        test_data["total_tests"] += test_count
                except Exception:
                    pass

        # Check for pytest coverage
        pytest_ini = self.project_root / "pytest.ini"
        if pytest_ini.exists():
            test_data["coverage_summary"]["pytest_configured"] = True

        # Check for UPF alert tests
        upf_tests = [
            "tests/api/test_inventory_alerts.py",
            "tests/api/test_monitoring.py",
        ]
        for test_file in upf_tests:
            if (self.project_root / test_file).exists():
                test_data["coverage_summary"]["upf_alerts_tested"] = True

        print(f"   [+] Found {len(test_data['test_files'])} test files")
        print(f"   [+] Total test functions: {test_data['total_tests']}")

    def audit_documentation(self):
        """Audit documentation completeness."""
        print("[DOCS] Auditing Documentation...")

        doc_data = self.results["documentation"]

        # Find all markdown files
        for md_file in self.project_root.rglob("*.md"):
            if any(
                excluded in str(md_file)
                for excluded in ["venv", "node_modules", ".git"]
            ):
                continue
            doc_data["markdown_files"].append(
                str(md_file.relative_to(self.project_root))
            )

        # Check for key documentation
        key_docs = {
            "README.md": 0,
            "DEPLOYMENT.md": 0,
            "docs/DEPLOYMENT_DOCKER.md": 0,
            "docs/PRODUCTION_READINESS.md": 0,
            "docs/UPF_INVENTORY_ALERTS_USAGE.md": 0,
            "docs/ALERT_UI_INTEGRATION.md": 0,
        }

        for doc in key_docs:
            if (self.project_root / doc).exists():
                key_docs[doc] = 1
                if "DEPLOYMENT" in doc or "PRODUCTION" in doc:
                    doc_data["deployment_guides"].append(doc)
                elif "UPF" in doc or "ALERT" in doc:
                    doc_data["api_docs"].append(doc)

        doc_data["completeness_score"] = sum(key_docs.values()) / len(key_docs) * 100

        print(f"   [+] Found {len(doc_data['markdown_files'])} documentation files")
        print(
            f"   [+] Documentation completeness: {doc_data['completeness_score']:.0f}%"
        )

    def audit_security(self):
        """Audit security configuration."""
        print("[LOCK] Auditing Security...")

        sec_data = self.results["security"]

        # Check for .env.example or production.env.example
        env_examples = list(self.project_root.glob("*.env.example"))
        if env_examples:
            try:
                with open(env_examples[0], "r", encoding="utf-8") as f:
                    content = f.read()
                    env_vars = re.findall(r"^([A-Z_]+)=", content, re.MULTILINE)
                    sec_data["env_vars_documented"] = env_vars
            except Exception:
                pass

        # Check for exposed secrets in code
        python_files = list(self.project_root.rglob("*.py"))
        secret_patterns = [
            r'SECRET_KEY\s*=\s*[\'"][^\'"]{10,}[\'"]',
            r'password\s*=\s*[\'"][^\'"]+[\'"]',
            r'api_key\s*=\s*[\'"][^\'"]+[\'"]',
        ]

        for py_file in python_files:
            if any(
                excluded in str(py_file) for excluded in ["venv", "__pycache__", "test"]
            ):
                continue
            try:
                with open(py_file, "r", encoding="utf-8") as f:
                    content = f.read()
                    for pattern in secret_patterns:
                        if re.search(pattern, content, re.IGNORECASE):
                            sec_data["secrets_exposed"].append(
                                str(py_file.relative_to(self.project_root))
                            )
                            break
            except Exception:
                pass

        # Check for CSRF protection
        config_file = self.project_root / "config.py"
        if config_file.exists():
            try:
                with open(config_file, "r", encoding="utf-8") as f:
                    content = f.read()
                    if "WTF_CSRF_ENABLED" in content or "SECRET_KEY" in content:
                        sec_data["csrf_protected"] = True
            except Exception:
                pass

        # Add recommendations
        if len(sec_data["secrets_exposed"]) > 0:
            sec_data["recommendations"].append(
                "[!]  Hardcoded secrets found - use environment variables"
            )
        if len(sec_data["env_vars_documented"]) < 5:
            sec_data["recommendations"].append(
                "[i]  Document all required environment variables"
            )

        print(
            f"   [+] {len(sec_data['env_vars_documented'])} environment variables documented"
        )
        print(f"   [!]  {len(sec_data['secrets_exposed'])} potential secret exposures")

    def audit_static_assets(self):
        """Audit static assets."""
        print("[PKG] Auditing Static Assets...")

        static_data = self.results["static_assets"]

        static_dir = self.project_root / "static"
        if static_dir.exists():
            # Find CSS files
            for css_file in static_dir.rglob("*.css"):
                file_size = css_file.stat().st_size
                static_data["css_files"].append(
                    {
                        "path": str(css_file.relative_to(self.project_root)),
                        "size": file_size,
                        "minified": ".min.css" in css_file.name,
                    }
                )
                static_data["total_size"] += file_size
                if ".min.css" in css_file.name:
                    static_data["minified_count"] += 1

            # Find JS files
            for js_file in static_dir.rglob("*.js"):
                file_size = js_file.stat().st_size
                static_data["js_files"].append(
                    {
                        "path": str(js_file.relative_to(self.project_root)),
                        "size": file_size,
                        "minified": ".min.js" in js_file.name,
                    }
                )
                static_data["total_size"] += file_size
                if ".min.js" in js_file.name:
                    static_data["minified_count"] += 1

        total_assets = len(static_data["css_files"]) + len(static_data["js_files"])
        print(
            f"   [+] Found {total_assets} static assets ({static_data['total_size'] / 1024:.1f} KB)"
        )
        print(f"   [+] Minified: {static_data['minified_count']}/{total_assets}")

    def run_audit(self) -> Dict[str, Any]:
        """Run the complete enhanced audit."""
        print("\n" + "=" * 60)
        print("[>>] Starting Comprehensive Flask Project Audit v3.0")
        print("=" * 60 + "\n")

        try:
            # Extract Blueprint mappings
            blueprint_map = self.extract_blueprints()

            # Extract routes with Blueprint awareness
            self.extract_routes_with_blueprints(blueprint_map)

            # Extract JavaScript API calls
            self.extract_javascript_api_calls()

            # Synchronize routes and calls
            self.synchronize_routes_and_calls()

            # NEW v3.0 audits
            self.audit_upf_alert_system()
            self.audit_database()
            self.audit_tests()
            self.audit_documentation()
            self.audit_security()
            self.audit_static_assets()

            # Generate statistics
            self.results["statistics"] = {
                "total_routes": len(self.results["flask_routes"]),
                "total_api_calls": len(self.results["javascript_api_calls"]),
                "matched_routes": len(self.results["route_api_sync"]["matched"]),
                "missing_backend": len(
                    self.results["route_api_sync"]["missing_backend"]
                ),
                "method_mismatches": len(
                    self.results["route_api_sync"]["method_mismatches"]
                ),
                "unused_backend": len(self.results["route_api_sync"]["unused_backend"]),
                "upf_overall_score": self.results["upf_alert_system"][
                    "completeness"
                ].get("overall_score", 0),
                "upf_process_bom_score": self.results["upf_alert_system"][
                    "process_bom_architecture"
                ].get("completeness", 0),
                "upf_production_lot_score": self.results["upf_alert_system"][
                    "production_lot_alerts"
                ].get("completeness", 0),
                "upf_alert_technical_score": self.results["upf_alert_system"][
                    "alert_technical"
                ].get("completeness", 0),
                "upf_data_flow_score": self.results["upf_alert_system"][
                    "data_flow_integration"
                ].get("completeness", 0),
                "test_files": len(self.results["tests"]["test_files"]),
                "total_tests": self.results["tests"]["total_tests"],
                "documentation_score": self.results["documentation"][
                    "completeness_score"
                ],
                "security_issues": len(self.results["security"]["secrets_exposed"]),
                "static_assets": len(self.results["static_assets"]["css_files"])
                + len(self.results["static_assets"]["js_files"]),
                "errors": len(self.results["errors"]),
            }

            print("\n" + "=" * 60)
            print("[OK] Comprehensive Audit Complete!")
            print("=" * 60)

            return self.results

        except Exception as e:
            self.log_error(f"Fatal error during audit: {str(e)}")
            return self.results

    def save_report(self, output_file: str = "enhanced_audit_report.json"):
        """Save the audit report."""
        try:
            output_path = self.project_root / output_file

            with open(output_path, "w", encoding="utf-8") as f:
                json.dump(self.results, f, indent=2, ensure_ascii=False)

            print(f"\n[DOC] Report saved to: {output_path}")
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

    print(f"\n[DIR] Project root: {project_root}\n")

    auditor = EnhancedFlaskAuditor(project_root)
    results = auditor.run_audit()
    auditor.save_report()

    # Print comprehensive summary
    print("\n" + "=" * 60)
    print("[LIST] COMPREHENSIVE AUDIT SUMMARY")
    print("=" * 60)
    stats = results["statistics"]

    print("\n[ROUTES]  ROUTES & API SYNC:")
    print(f"  Total backend routes: {stats['total_routes']}")
    print(f"  Total frontend API calls: {stats['total_api_calls']}")
    print(f"  [OK] Matched & synchronized: {stats['matched_routes']}")
    print(f"  [X] Missing backend routes: {stats['missing_backend']}")
    print(f"  [!]  HTTP method mismatches: {stats['method_mismatches']}")
    print(f"  [i]  Unused backend routes: {stats['unused_backend']}")

    print("\n[ALERT] UPF INVENTORY ALERT SYSTEM:")
    print(f"  Overall Framework Completeness: {stats['upf_overall_score']:.1f}%")
    print(f"  +-- Process/BOM Architecture: {stats['upf_process_bom_score']:.1f}%")
    print(f"  +-- Production Lot Alerts: {stats['upf_production_lot_score']:.1f}%")
    print(
        f"  +-- Alert Technical Architecture: {stats['upf_alert_technical_score']:.1f}%"
    )
    print(f"  +-- Data Flow Integration: {stats['upf_data_flow_score']:.1f}%")

    # Detailed UPF subsystem breakdown
    upf = results["upf_alert_system"]

    print("\n  [LIST] Process/BOM Architecture:")
    pba = upf["process_bom_architecture"]
    print(
        f"    [+] Process as BOM: {'[OK] Yes' if pba['process_as_bom']['present'] else '[X] No'}"
    )
    print(
        f"    [+] Subprocess Templates: {'[OK] Yes' if pba['subprocess_templates']['present'] else '[X] No'}"
    )
    print(
        f"    [+] Variant/Cost/Supplier: {'[OK] Yes' if pba['variant_cost_supplier']['present'] else '[X] No'}"
    )
    print(
        f"    [+] User Experience: {'[OK] Yes' if pba['user_experience']['present'] else '[X] No'}"
    )
    print(
        f"    [+] Audit Trail: {'[OK] Yes' if pba['audit_trail']['present'] else '[X] No'}"
    )

    print("\n  [PROD] Production Lot Alert System:")
    pla = upf["production_lot_alerts"]
    print(
        f"    [+] Lot Creation Workflow: {'[OK] Yes' if pla['lot_creation']['present'] else '[X] No'}"
    )
    print(
        f"    [+] Real-time Stock Analysis: {'[OK] Yes' if pla['realtime_stock_analysis']['present'] else '[X] No'}"
    )
    print(
        f"    [+] Alert Severity Levels: {'[OK] Yes' if pla['alert_severity_levels']['present'] else '[X] No'} {pla['alert_severity_levels']['details']}"
    )
    print(
        f"    [+] Alert Display/Interaction: {'[OK] Yes' if pla['alert_display_interaction']['present'] else '[X] No'}"
    )
    print(
        f"    [+] Automatic Procurement: {'[OK] Yes' if pla['automatic_procurement']['present'] else '[X] No'}"
    )
    print(
        f"    [+] Item Requirement Sheet: {'[OK] Yes' if pla['item_requirement_sheet']['present'] else '[X] No'}"
    )
    print(
        f"    [+] Lot Audit Trail: {'[OK] Yes' if pla['lot_audit_trail']['present'] else '[X] No'}"
    )

    print("\n  [GEAR]  Alert Technical Architecture:")
    ata = upf["alert_technical"]
    print(
        f"    [+] Real-time Inventory Query: {'[OK] Yes' if ata['realtime_inventory_query']['present'] else '[X] No'}"
    )
    print(
        f"    [+] Alert Escalation Rules: {'[OK] Yes' if ata['alert_escalation_rules']['present'] else '[X] No'}"
    )
    print(
        f"    [+] Safety Stock/Reorder Points: {'[OK] Yes' if ata['safety_stock_reorder']['present'] else '[X] No'}"
    )

    print("\n  [LOOP] Data Flow Integration:")
    dfi = upf["data_flow_integration"]
    print(
        f"    [+] Inventory System: {'[OK] Yes' if dfi['inventory_system']['present'] else '[X] No'}"
    )
    print(
        f"    [+] Supplier/Vendor DB: {'[OK] Yes' if dfi['supplier_vendor_db']['present'] else '[X] No'}"
    )
    print(
        f"    [+] Process/BOM Library: {'[OK] Yes' if dfi['process_bom_library']['present'] else '[X] No'}"
    )
    print(
        f"    [+] Alert Notification Engine: {'[OK] Yes' if dfi['alert_notification_engine']['present'] else '[X] No'}"
    )
    print(
        f"    [+] Ledger/Reporting: {'[OK] Yes' if dfi['ledger_reporting']['present'] else '[X] No'}"
    )

    print("\n  [SYNC] API Endpoints & Assets:")
    completeness = upf["completeness"]
    print(f"    Endpoints: {completeness.get('endpoints', 'N/A')}")
    print(f"    Services: {completeness.get('services', 'N/A')}")
    print(f"    Templates: {completeness.get('templates', 'N/A')}")
    print(f"    Static Assets: {completeness.get('static_assets', 'N/A')}")
    print(f"    Tests: {completeness.get('tests', 'N/A')}")
    print(f"    Documentation: {completeness.get('documentation', 'N/A')}")

    print("\n[FILE]  DATABASE:")
    db = results["database"]
    print(f"  Model files: {len(db['models'])}")
    print(f"  Migration files: {len(db['migrations'])}")
    print(f"  Indexes found: {len(db['indexes'])}")
    if db["missing_indexes"]:
        print(f"  [!]  Missing indexes: {', '.join(db['missing_indexes'])}")

    print("\n[TEST] TESTS:")
    print(f"  Test files: {stats['test_files']}")
    print(f"  Total test functions: {stats['total_tests']}")

    print("\n[DOCS] DOCUMENTATION:")
    print(f"  Completeness score: {stats['documentation_score']:.0f}%")
    print(f"  Deployment guides: {len(results['documentation']['deployment_guides'])}")
    print(f"  API docs: {len(results['documentation']['api_docs'])}")

    print("\n[LOCK] SECURITY:")
    print(
        f"  Environment vars documented: {len(results['security']['env_vars_documented'])}"
    )
    if stats["security_issues"] > 0:
        print(f"  [!]  Potential secret exposures: {stats['security_issues']}")
    if results["security"]["recommendations"]:
        for rec in results["security"]["recommendations"]:
            print(f"  {rec}")

    print("\n[PKG] STATIC ASSETS:")
    print(f"  Total assets: {stats['static_assets']}")
    print(f"  Total size: {results['static_assets']['total_size'] / 1024:.1f} KB")
    print(
        f"  Minified: {results['static_assets']['minified_count']}/{stats['static_assets']}"
    )

    print("\n[!]  ISSUES:")
    print(f"  Errors encountered: {stats['errors']}")

    print("=" * 60 + "\n")

    if stats["missing_backend"] > 0:
        print("[!]  WARNING: Frontend is calling backend routes that don't exist!")
    if stats["method_mismatches"] > 0:
        print("[!]  WARNING: HTTP method mismatches detected!")
    if stats["security_issues"] > 0:
        print("[!]  WARNING: Potential security issues found!")

    print("\n[*] Review the detailed report in 'enhanced_audit_report.json'\n")


if __name__ == "__main__":
    main()
