#!/usr/bin/env python3
"""
Production Lot Fixes Verification Script

Verifies that all changes have been properly implemented and working.
Run this script after deployment to ensure everything is configured correctly.

Usage:
    python verify_production_lot_fixes.py
    
Output:
    Detailed verification report with pass/fail status for each check
"""

import sys
import os
from pathlib import Path

# Add project root to path
project_root = Path(__file__).parent / "Project-root"
sys.path.insert(0, str(project_root))

# Color codes for output
class Colors:
    GREEN = '\033[92m'
    RED = '\033[91m'
    YELLOW = '\033[93m'
    BLUE = '\033[94m'
    END = '\033[0m'
    
    @staticmethod
    def success(msg):
        return f"{Colors.GREEN}✓ {msg}{Colors.END}"
    
    @staticmethod
    def error(msg):
        return f"{Colors.RED}✗ {msg}{Colors.END}"
    
    @staticmethod
    def warning(msg):
        return f"{Colors.YELLOW}⚠ {msg}{Colors.END}"
    
    @staticmethod
    def info(msg):
        return f"{Colors.BLUE}ℹ {msg}{Colors.END}"


def verify_file_exists(filepath, description):
    """Check if a file exists."""
    p = Path(filepath)
    if p.exists():
        print(Colors.success(f"{description}: {filepath}"))
        return True
    else:
        print(Colors.error(f"{description} NOT FOUND: {filepath}"))
        return False


def verify_function_exists(module_path, function_name, description):
    """Check if a function exists in a module."""
    try:
        # Import module
        import importlib.util
        spec = importlib.util.spec_from_file_location("temp_module", module_path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        
        # Check function
        if hasattr(module, function_name):
            print(Colors.success(f"Function {description}: {function_name}()"))
            return True
        else:
            print(Colors.error(f"Function {description} NOT FOUND: {function_name}()"))
            return False
    except Exception as e:
        print(Colors.error(f"Error checking function {description}: {str(e)}"))
        return False


def verify_database_table(table_name):
    """Check if a database table exists."""
    try:
        import database
        
        with database.get_conn() as (conn, cur):
            cur.execute("""
                SELECT 1 FROM information_schema.tables 
                WHERE table_name = %s
            """, (table_name,))
            
            if cur.fetchone():
                print(Colors.success(f"Database table exists: {table_name}"))
                return True
            else:
                print(Colors.warning(f"Database table NOT FOUND: {table_name}"))
                return False
    except Exception as e:
        print(Colors.error(f"Error checking database table {table_name}: {str(e)}"))
        return False


def verify_imports():
    """Verify that all new modules can be imported."""
    print(f"\n{Colors.info('Checking Imports...')}")
    
    checks = [
        ("app.utils.production_lot_utils", "Cost validation utilities"),
        ("app.services.production_lot_subprocess_manager", "Subprocess manager"),
        ("app.validators.production_lot_validator", "Production lot validator"),
        ("app.services.production_service", "Production service"),
    ]
    
    passed = 0
    failed = 0
    
    for module_name, description in checks:
        try:
            __import__(module_name)
            print(Colors.success(f"Import {description}: {module_name}"))
            passed += 1
        except ImportError as e:
            print(Colors.error(f"Import FAILED {description}: {str(e)}"))
            failed += 1
        except Exception as e:
            print(Colors.error(f"Import ERROR {description}: {str(e)}"))
            failed += 1
    
    return passed, failed


def verify_files():
    """Verify that all new/modified files exist."""
    print(f"\n{Colors.info('Checking Files...')}")
    
    files_to_check = [
        ("Project-root/app/utils/production_lot_utils.py", "Production Lot Utils Module"),
        ("Project-root/app/services/production_lot_subprocess_manager.py", "Subprocess Manager Module"),
        ("Project-root/app/validators/production_lot_validator.py", "Validator Module"),
        ("Project-root/app/services/production_service.py", "Production Service"),
        ("Project-root/migrations/migration_add_production_lot_subprocesses.py", "Database Migration"),
        ("Project-root/tests/test_production_lot_lifecycle.py", "Integration Tests"),
        ("PRODUCTION_LOT_FIXES_COMPLETE.md", "Fixes Documentation"),
        ("DEPLOYMENT_GUIDE.md", "Deployment Guide"),
    ]
    
    passed = 0
    failed = 0
    
    for filepath, description in files_to_check:
        if verify_file_exists(filepath, description):
            passed += 1
        else:
            failed += 1
    
    return passed, failed


def verify_functions():
    """Verify that key functions exist."""
    print(f"\n{Colors.info('Checking Functions...')}")
    
    functions_to_check = [
        ("Project-root/app/utils/production_lot_utils.py", "validate_cost_breakdown", "Cost Breakdown Validation"),
        ("Project-root/app/utils/production_lot_utils.py", "validate_cost_calculation", "Cost Calculation Validation"),
        ("Project-root/app/utils/production_lot_utils.py", "log_zero_cost_analysis", "Zero Cost Analysis Logging"),
        ("Project-root/app/utils/production_lot_utils.py", "validate_status_transition", "Status Transition Validation"),
        ("Project-root/app/services/production_lot_subprocess_manager.py", "link_subprocesses_to_production_lot", "Subprocess Linking"),
        ("Project-root/app/services/production_lot_subprocess_manager.py", "get_production_lot_subprocesses", "Get Subprocesses"),
        ("Project-root/app/services/production_lot_subprocess_manager.py", "update_subprocess_status", "Update Subprocess Status"),
        ("Project-root/app/validators/production_lot_validator.py", "validate_variant_selection", "Variant Selection Validation"),
        ("Project-root/app/validators/production_lot_validator.py", "validate_lot_status_transition", "Lot Status Transition Validation"),
    ]
    
    passed = 0
    failed = 0
    
    for filepath, function, description in functions_to_check:
        if verify_function_exists(filepath, function, description):
            passed += 1
        else:
            failed += 1
    
    return passed, failed


def verify_database():
    """Verify database tables exist."""
    print(f"\n{Colors.info('Checking Database...')}")
    
    tables_to_check = [
        "production_lots",
        "production_lot_variant_selections",
        "production_lot_inventory_alerts",
    ]
    
    passed = 0
    failed = 0
    
    for table in tables_to_check:
        if verify_database_table(table):
            passed += 1
        else:
            failed += 1
    
    # Check for new table
    print(f"\n{Colors.info('Checking New Tables (Post-Migration)...')}")
    if verify_database_table("production_lot_subprocesses"):
        print(Colors.warning("New table exists (migration applied)"))
        passed += 1
    else:
        print(Colors.warning("New table NOT FOUND (migration not yet applied)"))
    
    return passed, failed


def verify_code_quality():
    """Check for key code patterns."""
    print(f"\n{Colors.info('Checking Code Quality...')}")
    
    checks = [
        ("Project-root/app/services/production_service.py", "validate_cost_calculation", "Cost validation in create_production_lot"),
        ("Project-root/app/services/production_service.py", "COALESCE(pl.total_cost, 0)", "Cost coalescing in queries"),
        ("Project-root/app/services/production_service.py", "link_subprocesses_to_production_lot", "Subprocess linking in create_production_lot"),
        ("Project-root/app/validators/production_lot_validator.py", "logger.warning", "Logging for zero costs"),
    ]
    
    passed = 0
    failed = 0
    
    for filepath, pattern, description in checks:
        try:
            with open(filepath, 'r') as f:
                content = f.read()
                if pattern in content:
                    print(Colors.success(f"Code pattern found: {description}"))
                    passed += 1
                else:
                    print(Colors.error(f"Code pattern NOT FOUND: {description}"))
                    failed += 1
        except Exception as e:
            print(Colors.error(f"Error checking code pattern: {str(e)}"))
            failed += 1
    
    return passed, failed


def main():
    """Run all verification checks."""
    print("=" * 70)
    print("PRODUCTION LOT FIXES - VERIFICATION REPORT")
    print("=" * 70)
    
    total_passed = 0
    total_failed = 0
    
    # Check files
    p, f = verify_files()
    total_passed += p
    total_failed += f
    
    # Check functions
    p, f = verify_functions()
    total_passed += p
    total_failed += f
    
    # Check imports
    p, f = verify_imports()
    total_passed += p
    total_failed += f
    
    # Check database (may fail if no DB connection)
    try:
        p, f = verify_database()
        total_passed += p
        total_failed += f
    except Exception as e:
        print(Colors.warning(f"Database checks skipped: {str(e)}"))
    
    # Check code quality
    p, f = verify_code_quality()
    total_passed += p
    total_failed += f
    
    # Print summary
    print("\n" + "=" * 70)
    print("VERIFICATION SUMMARY")
    print("=" * 70)
    
    print(f"Total Checks Passed: {Colors.success(str(total_passed))}")
    print(f"Total Checks Failed: {Colors.error(str(total_failed))}")
    
    if total_failed == 0:
        print(f"\n{Colors.success('ALL CHECKS PASSED - DEPLOYMENT READY')}")
        return 0
    else:
        print(f"\n{Colors.error('SOME CHECKS FAILED - REVIEW ABOVE')}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
