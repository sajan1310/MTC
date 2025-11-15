"""
Flask Project Auditor
=====================
Comprehensive audit tool for Flask-PostgreSQL applications.

This script performs:
1. Project directory structure scanning
2. Python file analysis for incomplete functions
3. Flask route extraction and mapping
4. JavaScript API call detection
5. Route vs API call synchronization check
6. Duplicate function detection
7. JSON report generation

Safe to run - performs READ-ONLY operations.
"""

import os
import re
import json
import ast
from pathlib import Path
from collections import defaultdict
from typing import Dict, List, Any
from datetime import datetime


class FlaskProjectAuditor:
    """Main auditor class for Flask project analysis."""

    def __init__(self, project_root: str):
        """
        Initialize the auditor.

        Args:
            project_root: Path to the Flask project root directory
        """
        self.project_root = Path(project_root)
        self.results = {
            "audit_timestamp": datetime.now().isoformat(),
            "project_root": str(self.project_root),
            "directory_structure": {},
            "incomplete_functions": [],
            "flask_routes": [],
            "javascript_api_calls": [],
            "route_api_mismatches": [],
            "duplicate_functions": [],
            "statistics": {},
            "errors": [],
        }

        # Patterns for detection
        self.route_pattern = re.compile(
            r'@(?:app|bp|blueprint)\.route\([\'"]([^\'"]+)[\'"](?:.*?methods=\[([^\]]+)\])?',
            re.DOTALL,
        )
        self.fetch_pattern = re.compile(
            r'fetch\([\'"`]([^\'")`]+)[\'"`](?:.*?method:\s*[\'"`](\w+)[\'"`])?',
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
        """Log an error to the results."""
        error_entry = {"message": error_msg, "timestamp": datetime.now().isoformat()}
        if file_path:
            error_entry["file"] = str(file_path)
        self.results["errors"].append(error_entry)
        print(f"⚠️  ERROR: {error_msg}")

    def scan_directory_structure(self) -> Dict[str, Any]:
        """
        Scan and map the project directory structure.

        Returns:
            Dictionary representing the directory tree
        """
        print("📁 Scanning directory structure...")

        excluded_dirs = {
            "__pycache__",
            "venv",
            "venv2",
            "env",
            "node_modules",
            ".git",
            ".vscode",
            ".idea",
            "dist",
            "build",
            ".pytest_cache",
        }

        structure = {
            "total_files": 0,
            "python_files": 0,
            "javascript_files": 0,
            "html_files": 0,
            "css_files": 0,
            "directories": [],
        }

        try:
            for root, dirs, files in os.walk(self.project_root):
                # Filter out excluded directories
                dirs[:] = [d for d in dirs if d not in excluded_dirs]

                rel_path = Path(root).relative_to(self.project_root)

                for file in files:
                    structure["total_files"] += 1

                    if file.endswith(".py"):
                        structure["python_files"] += 1
                    elif file.endswith(".js"):
                        structure["javascript_files"] += 1
                    elif file.endswith(".html"):
                        structure["html_files"] += 1
                    elif file.endswith(".css"):
                        structure["css_files"] += 1

                if files:
                    structure["directories"].append(
                        {
                            "path": str(rel_path),
                            "files": files,
                            "file_count": len(files),
                        }
                    )

            self.results["directory_structure"] = structure
            print(
                f"   ✓ Found {structure['total_files']} files in {len(structure['directories'])} directories"
            )
            return structure

        except Exception as e:
            self.log_error(f"Directory scan failed: {str(e)}")
            return structure

    def find_incomplete_functions(self) -> List[Dict[str, Any]]:
        """
        Find Python functions that are incomplete (contain only 'pass').

        Returns:
            List of incomplete function definitions
        """
        print("🔍 Analyzing Python files for incomplete functions...")

        incomplete = []
        python_files = list(self.project_root.rglob("*.py"))

        for py_file in python_files:
            if any(
                excluded in str(py_file) for excluded in ["venv", "__pycache__", ".git"]
            ):
                continue

            try:
                with open(py_file, "r", encoding="utf-8") as f:
                    content = f.read()

                try:
                    tree = ast.parse(content)

                    for node in ast.walk(tree):
                        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                            # Check if function body is only 'pass' or docstring + 'pass'
                            body = node.body

                            # Skip docstring if present
                            if (
                                body
                                and isinstance(body[0], ast.Expr)
                                and isinstance(body[0].value, ast.Constant)
                            ):
                                body = body[1:]

                            # Check if remaining body is only pass statements
                            if len(body) == 1 and isinstance(body[0], ast.Pass):
                                incomplete.append(
                                    {
                                        "file": str(
                                            py_file.relative_to(self.project_root)
                                        ),
                                        "function": node.name,
                                        "line": node.lineno,
                                        "type": (
                                            "async"
                                            if isinstance(node, ast.AsyncFunctionDef)
                                            else "sync"
                                        ),
                                        "args": [arg.arg for arg in node.args.args],
                                    }
                                )

                            # Also check for functions with TODO comments
                            elif any(
                                isinstance(stmt, ast.Expr)
                                and isinstance(stmt.value, ast.Constant)
                                and "TODO" in str(stmt.value.value)
                                for stmt in body
                            ):
                                incomplete.append(
                                    {
                                        "file": str(
                                            py_file.relative_to(self.project_root)
                                        ),
                                        "function": node.name,
                                        "line": node.lineno,
                                        "type": "todo",
                                        "args": [arg.arg for arg in node.args.args],
                                    }
                                )

                except SyntaxError as e:
                    self.log_error(f"Syntax error in {py_file}: {str(e)}", str(py_file))

            except Exception as e:
                self.log_error(f"Error reading {py_file}: {str(e)}", str(py_file))

        self.results["incomplete_functions"] = incomplete
        print(f"   ✓ Found {len(incomplete)} incomplete functions")
        return incomplete

    def extract_flask_routes(self) -> List[Dict[str, Any]]:
        """
        Extract all Flask route definitions.

        Returns:
            List of route definitions with methods and handlers
        """
        print("🛣️  Extracting Flask routes...")

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
                    route_path = match.group(1)
                    methods_str = match.group(2)

                    # Parse methods
                    if methods_str:
                        methods = [
                            m.strip().strip("'\"") for m in methods_str.split(",")
                        ]
                    else:
                        methods = ["GET"]  # Default method

                    # Try to find the function name following the decorator
                    start_pos = match.end()
                    remaining_content = content[start_pos : start_pos + 500]
                    func_match = re.search(r"def\s+(\w+)\s*\(", remaining_content)
                    func_name = func_match.group(1) if func_match else "unknown"

                    routes.append(
                        {
                            "file": str(py_file.relative_to(self.project_root)),
                            "route": route_path,
                            "methods": methods,
                            "handler": func_name,
                        }
                    )

            except Exception as e:
                self.log_error(
                    f"Error extracting routes from {py_file}: {str(e)}", str(py_file)
                )

        self.results["flask_routes"] = routes
        print(f"   ✓ Found {len(routes)} Flask routes")
        return routes

    def extract_javascript_api_calls(self) -> List[Dict[str, Any]]:
        """
        Extract API calls from JavaScript files.

        Returns:
            List of API call definitions
        """
        print("📡 Extracting JavaScript API calls...")

        api_calls = []
        js_files = list(self.project_root.rglob("*.js"))
        html_files = list(self.project_root.rglob("*.html"))

        all_files = js_files + html_files

        for js_file in all_files:
            if any(
                excluded in str(js_file)
                for excluded in ["venv", "node_modules", ".git"]
            ):
                continue

            try:
                with open(js_file, "r", encoding="utf-8", errors="ignore") as f:
                    content = f.read()

                # Find fetch calls
                fetch_matches = self.fetch_pattern.finditer(content)
                for match in fetch_matches:
                    url = match.group(1)
                    method = match.group(2) if match.group(2) else "GET"
                    api_calls.append(
                        {
                            "file": str(js_file.relative_to(self.project_root)),
                            "url": url,
                            "method": method.upper(),
                            "type": "fetch",
                        }
                    )

                # Find jQuery AJAX calls
                ajax_matches = self.ajax_pattern.finditer(content)
                for match in ajax_matches:
                    url = match.group(1)
                    method = match.group(2).upper()
                    api_calls.append(
                        {
                            "file": str(js_file.relative_to(self.project_root)),
                            "url": url,
                            "method": method,
                            "type": "ajax",
                        }
                    )

                # Find axios calls
                axios_matches = self.axios_pattern.finditer(content)
                for match in axios_matches:
                    method = match.group(1).upper()
                    url = match.group(2)
                    api_calls.append(
                        {
                            "file": str(js_file.relative_to(self.project_root)),
                            "url": url,
                            "method": method,
                            "type": "axios",
                        }
                    )

            except Exception as e:
                self.log_error(
                    f"Error extracting API calls from {js_file}: {str(e)}", str(js_file)
                )

        self.results["javascript_api_calls"] = api_calls
        print(f"   ✓ Found {len(api_calls)} JavaScript API calls")
        return api_calls

    def compare_routes_and_calls(self) -> List[Dict[str, Any]]:
        """
        Compare Flask routes with JavaScript API calls to find mismatches.

        Returns:
            List of mismatches and inconsistencies
        """
        print("🔄 Comparing routes with API calls...")

        mismatches = []

        # Build route lookup
        route_map = defaultdict(set)
        for route in self.results["flask_routes"]:
            # Normalize route path (remove trailing slashes, handle variable parts)
            normalized = route["route"].rstrip("/")
            for method in route["methods"]:
                route_map[normalized].add(method.upper())

        # Check each API call
        for call in self.results["javascript_api_calls"]:
            url = call["url"]
            method = call["method"]

            # Skip external URLs
            if url.startswith("http://") or url.startswith("https://"):
                if not any(domain in url for domain in ["localhost", "127.0.0.1"]):
                    continue

            # Extract path from URL
            path = url.split("?")[0]  # Remove query params
            if path.startswith("http"):
                path = "/" + "/".join(path.split("/")[3:])

            # Normalize path
            normalized_path = path.rstrip("/")

            # Check if route exists
            route_found = False
            method_matches = False

            for route, methods in route_map.items():
                # Simple match or pattern match
                if route == normalized_path or self._route_matches(
                    route, normalized_path
                ):
                    route_found = True
                    if method in methods:
                        method_matches = True
                    break

            if not route_found:
                mismatches.append(
                    {
                        "type": "missing_route",
                        "api_call_file": call["file"],
                        "url": url,
                        "method": method,
                        "message": f"API call to '{url}' but no matching Flask route found",
                    }
                )
            elif not method_matches:
                mismatches.append(
                    {
                        "type": "method_mismatch",
                        "api_call_file": call["file"],
                        "url": url,
                        "method": method,
                        "available_methods": list(route_map.get(normalized_path, [])),
                        "message": f"Method '{method}' not allowed for route '{normalized_path}'",
                    }
                )

        # Check for unused routes
        used_routes = set()
        for call in self.results["javascript_api_calls"]:
            url = call["url"]
            path = url.split("?")[0].rstrip("/")
            if path.startswith("http"):
                path = "/" + "/".join(path.split("/")[3:])
            used_routes.add(path)

        for route in self.results["flask_routes"]:
            normalized = route["route"].rstrip("/")
            if normalized not in used_routes and not any(
                self._route_matches(normalized, used) for used in used_routes
            ):
                # Check if it's a special route (static, admin, etc.)
                if not any(
                    special in normalized for special in ["/static/", "/admin/", "/_"]
                ):
                    mismatches.append(
                        {
                            "type": "unused_route",
                            "route_file": route["file"],
                            "route": route["route"],
                            "methods": route["methods"],
                            "handler": route["handler"],
                            "message": f"Route '{route['route']}' defined but no JavaScript calls found",
                        }
                    )

        self.results["route_api_mismatches"] = mismatches
        print(f"   ✓ Found {len(mismatches)} route/API mismatches")
        return mismatches

    def _route_matches(self, route_pattern: str, actual_path: str) -> bool:
        """
        Check if a Flask route pattern matches an actual path.

        Args:
            route_pattern: Flask route with potential <variable> parts
            actual_path: Actual URL path to match

        Returns:
            True if the pattern matches the path
        """
        # Convert Flask route to regex
        pattern = re.sub(r"<[^>]+>", r"[^/]+", route_pattern)
        pattern = f"^{pattern}$"
        return bool(re.match(pattern, actual_path))

    def find_duplicate_functions(self) -> List[Dict[str, Any]]:
        """
        Find duplicate function definitions across the project.

        Returns:
            List of duplicate function groups
        """
        print("🔎 Detecting duplicate functions...")

        function_map = defaultdict(list)
        python_files = list(self.project_root.rglob("*.py"))

        for py_file in python_files:
            if any(
                excluded in str(py_file) for excluded in ["venv", "__pycache__", ".git"]
            ):
                continue

            try:
                with open(py_file, "r", encoding="utf-8") as f:
                    content = f.read()

                try:
                    tree = ast.parse(content)

                    for node in ast.walk(tree):
                        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                            function_map[node.name].append(
                                {
                                    "file": str(py_file.relative_to(self.project_root)),
                                    "line": node.lineno,
                                    "args": [arg.arg for arg in node.args.args],
                                }
                            )

                except SyntaxError:
                    pass  # Already logged in previous step

            except Exception:
                pass  # Already logged in previous step

        # Find duplicates
        duplicates = []
        for func_name, locations in function_map.items():
            if len(locations) > 1:
                duplicates.append(
                    {
                        "function_name": func_name,
                        "count": len(locations),
                        "locations": locations,
                    }
                )

        self.results["duplicate_functions"] = duplicates
        print(f"   ✓ Found {len(duplicates)} duplicate function names")
        return duplicates

    def generate_statistics(self):
        """Generate summary statistics."""
        print("📊 Generating statistics...")

        self.results["statistics"] = {
            "total_python_files": self.results["directory_structure"].get(
                "python_files", 0
            ),
            "total_javascript_files": self.results["directory_structure"].get(
                "javascript_files", 0
            ),
            "total_routes": len(self.results["flask_routes"]),
            "total_api_calls": len(self.results["javascript_api_calls"]),
            "incomplete_functions": len(self.results["incomplete_functions"]),
            "duplicate_functions": len(self.results["duplicate_functions"]),
            "route_mismatches": len(
                [
                    m
                    for m in self.results["route_api_mismatches"]
                    if m["type"] in ["missing_route", "method_mismatch"]
                ]
            ),
            "unused_routes": len(
                [
                    m
                    for m in self.results["route_api_mismatches"]
                    if m["type"] == "unused_route"
                ]
            ),
            "errors_encountered": len(self.results["errors"]),
        }

    def run_audit(self) -> Dict[str, Any]:
        """
        Run the complete audit process.

        Returns:
            Complete audit results
        """
        print("\n" + "=" * 60)
        print("🚀 Starting Flask Project Audit")
        print("=" * 60 + "\n")

        try:
            # Phase 1: Directory structure
            self.scan_directory_structure()

            # Phase 2: Incomplete functions
            self.find_incomplete_functions()

            # Phase 3: Flask routes
            self.extract_flask_routes()

            # Phase 4: JavaScript API calls
            self.extract_javascript_api_calls()

            # Phase 5: Compare routes and calls
            self.compare_routes_and_calls()

            # Phase 6: Duplicate functions
            self.find_duplicate_functions()

            # Phase 7: Statistics
            self.generate_statistics()

            print("\n" + "=" * 60)
            print("✅ Audit Complete!")
            print("=" * 60)

            return self.results

        except Exception as e:
            self.log_error(f"Fatal error during audit: {str(e)}")
            return self.results

    def save_report(self, output_file: str = "project_audit_report.json"):
        """
        Save the audit report to a JSON file.

        Args:
            output_file: Name of the output file
        """
        try:
            output_path = self.project_root / output_file

            with open(output_path, "w", encoding="utf-8") as f:
                json.dump(self.results, f, indent=2, ensure_ascii=False)

            print(f"\n📄 Report saved to: {output_path}")
            print(f"   File size: {output_path.stat().st_size / 1024:.2f} KB")

        except Exception as e:
            self.log_error(f"Failed to save report: {str(e)}")
            print(f"\n❌ Could not save report: {str(e)}")


def main():
    """Main entry point for the auditor script."""
    import sys

    # Determine project root
    if len(sys.argv) > 1:
        project_root = sys.argv[1]
    else:
        # Use current directory or Project-root subdirectory
        current_dir = Path.cwd()
        if (current_dir / "Project-root").exists():
            project_root = current_dir / "Project-root"
        else:
            project_root = current_dir

    print(f"\n📂 Project root: {project_root}\n")

    # Run audit
    auditor = FlaskProjectAuditor(project_root)
    results = auditor.run_audit()

    # Save report
    auditor.save_report()

    # Print summary
    print("\n" + "=" * 60)
    print("📋 AUDIT SUMMARY")
    print("=" * 60)
    stats = results["statistics"]
    print(f"  Python files analyzed: {stats['total_python_files']}")
    print(f"  JavaScript files analyzed: {stats['total_javascript_files']}")
    print(f"  Flask routes found: {stats['total_routes']}")
    print(f"  API calls found: {stats['total_api_calls']}")
    print(f"  Incomplete functions: {stats['incomplete_functions']}")
    print(f"  Duplicate functions: {stats['duplicate_functions']}")
    print(f"  Route mismatches: {stats['route_mismatches']}")
    print(f"  Unused routes: {stats['unused_routes']}")
    print(f"  Errors encountered: {stats['errors_encountered']}")
    print("=" * 60 + "\n")

    # Print critical issues
    if stats["incomplete_functions"] > 0:
        print("⚠️  CRITICAL: Found incomplete function implementations")
    if stats["route_mismatches"] > 0:
        print("⚠️  WARNING: Found route/API call mismatches")
    if stats["errors_encountered"] > 0:
        print("⚠️  ERRORS: Some files could not be analyzed")

    print("\n✨ Review the detailed report in 'project_audit_report.json'\n")


if __name__ == "__main__":
    main()
