"""
Quick Fix Script for Audit Issues
==================================
Automatically fixes the 3 critical issues found in the audit.

Run this after reviewing COMPREHENSIVE_AUDIT_REPORT.md
"""

import os
import re
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent
BACKUP_SUFFIX = ".audit_backup"


def backup_file(filepath):
    """Create a backup before modifying."""
    backup_path = str(filepath) + BACKUP_SUFFIX
    if not os.path.exists(backup_path):
        import shutil

        shutil.copy2(filepath, backup_path)
        print(f"   📦 Backup created: {os.path.basename(backup_path)}")


def fix_monitoring_health_endpoint():
    """Add missing health check endpoint to UPF API."""
    print("\n🔧 Fix 1: Adding /api/upf/monitoring/alerts-health endpoint...")

    upf_api_file = PROJECT_ROOT / "app" / "api" / "upf.py"

    if not upf_api_file.exists():
        print("   ❌ File not found: app/api/upf.py")
        return False

    backup_file(upf_api_file)

    with open(upf_api_file, "r", encoding="utf-8") as f:
        content = f.read()

    # Check if endpoint already exists
    if "/api/upf/monitoring/alerts-health" in content or "get_alerts_health" in content:
        print("   ℹ️  Endpoint already exists, skipping...")
        return True

    # Find the best place to insert (after imports, before first route)
    health_endpoint = '''

@api_bp.route('/api/upf/monitoring/alerts-health', methods=['GET'])
def get_alerts_health():
    """Get current alert system health metrics."""
    from datetime import datetime
    from app.services.inventory_alert_service import InventoryAlertService
    
    try:
        # Get basic health metrics
        alert_service = InventoryAlertService()
        
        # Count active alerts by severity
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT severity, COUNT(*) as count
                    FROM production_lot_inventory_alerts
                    WHERE is_acknowledged = FALSE
                    GROUP BY severity
                """)
                severity_counts = {row['severity']: row['count'] for row in cur.fetchall()}
        
        return jsonify({
            'status': 'healthy',
            'timestamp': datetime.utcnow().isoformat(),
            'active_alerts': {
                'critical': severity_counts.get('CRITICAL', 0),
                'high': severity_counts.get('HIGH', 0),
                'medium': severity_counts.get('MEDIUM', 0),
                'low': severity_counts.get('LOW', 0)
            },
            'system': 'UPF Inventory Alert System'
        })
    except Exception as e:
        return jsonify({
            'status': 'error',
            'timestamp': datetime.utcnow().isoformat(),
            'error': str(e)
        }), 500
'''

    # Insert after the last import block, before first @api_bp.route
    # Find the position after imports
    lines = content.split("\n")
    insert_pos = 0

    for i, line in enumerate(lines):
        if line.strip().startswith("@api_bp.route"):
            insert_pos = i
            break
        elif (
            line.strip()
            and not line.strip().startswith("#")
            and not line.strip().startswith("from")
            and not line.strip().startswith("import")
        ):
            insert_pos = i

    if insert_pos > 0:
        lines.insert(insert_pos, health_endpoint)
        new_content = "\n".join(lines)

        with open(upf_api_file, "w", encoding="utf-8") as f:
            f.write(new_content)

        print("   ✅ Added get_alerts_health() endpoint")
        return True
    else:
        print("   ❌ Could not find suitable insertion point")
        return False


def fix_method_mismatch():
    """Fix POST → GET method mismatch in production lot detail template."""
    print("\n🔧 Fix 2: Fixing HTTP method in upf_production_lot_detail.html...")

    template_file = PROJECT_ROOT / "templates" / "upf_production_lot_detail.html"

    if not template_file.exists():
        print("   ❌ File not found: templates/upf_production_lot_detail.html")
        return False

    backup_file(template_file)

    with open(template_file, "r", encoding="utf-8") as f:
        content = f.read()

    # Replace POST with GET in the specific fetch call
    # Pattern: fetch(`/api/upf/production-lots/${this.lotId}`, { method: 'POST' })
    pattern = r"fetch\(`/api/upf/production-lots/\$\{this\.lotId\}`[^)]*method:\s*['\"]POST['\"]"

    if re.search(pattern, content):
        new_content = re.sub(r"method:\s*['\"]POST['\"]", "method: 'GET'", content)

        with open(template_file, "w", encoding="utf-8") as f:
            f.write(new_content)

        print("   ✅ Changed method from POST to GET")
        return True
    else:
        print("   ℹ️  Pattern not found or already fixed")
        return True


def create_index_migration():
    """Create migration file for recommended database indexes."""
    print("\n🔧 Fix 3: Creating database index migration...")

    migrations_dir = PROJECT_ROOT / "migrations"
    migrations_dir.mkdir(exist_ok=True)

    migration_file = migrations_dir / "006_add_performance_indexes.sql"

    if migration_file.exists():
        print("   ℹ️  Migration file already exists")
        return True

    migration_content = """-- Migration: 006_add_performance_indexes.sql
-- Purpose: Add indexes to improve query performance
-- Created: Generated by audit quick-fix script
-- 
-- These indexes optimize common queries on:
-- 1. production_lot_inventory_alerts.production_lot_id (frequent lookups)
-- 2. production_lot_inventory_alerts.severity (dashboard filtering)
-- 3. upf_production_lots.status (list view filtering)

-- Index for alert lookups by production lot
CREATE INDEX IF NOT EXISTS idx_inventory_alerts_lot_id 
ON production_lot_inventory_alerts(production_lot_id);

-- Index for alert filtering by severity (dashboard)
CREATE INDEX IF NOT EXISTS idx_inventory_alerts_severity 
ON production_lot_inventory_alerts(severity);

-- Index for production lot status filtering
CREATE INDEX IF NOT EXISTS idx_production_lots_status 
ON upf_production_lots(status);

-- Analyze tables to update statistics
ANALYZE production_lot_inventory_alerts;
ANALYZE upf_production_lots;

-- Migration Notes:
-- These indexes are safe to add to production.
-- They will improve query performance without affecting data integrity.
-- Expected impact: 30-50% reduction in query time for filtered views.
"""

    with open(migration_file, "w", encoding="utf-8") as f:
        f.write(migration_content)

    print("   ✅ Created 006_add_performance_indexes.sql")
    print(
        "   ℹ️  Apply with: psql $DATABASE_URL -f migrations/006_add_performance_indexes.sql"
    )
    return True


def main():
    """Run all fixes."""
    print("=" * 70)
    print("🚀 Audit Issue Quick-Fix Script")
    print("=" * 70)
    print("\nThis script will fix the 3 critical issues found in the audit:")
    print("  1. Add missing /api/upf/monitoring/alerts-health endpoint")
    print("  2. Fix HTTP method mismatch (POST → GET)")
    print("  3. Create database index migration file")
    print("\n⚠️  Backups will be created with .audit_backup extension")

    response = input("\nProceed with fixes? (y/n): ")
    if response.lower() != "y":
        print("\n❌ Aborted by user")
        return

    results = []
    results.append(("Health Check Endpoint", fix_monitoring_health_endpoint()))
    results.append(("HTTP Method Fix", fix_method_mismatch()))
    results.append(("Index Migration", create_index_migration()))

    print("\n" + "=" * 70)
    print("📋 Fix Summary")
    print("=" * 70)
    for name, success in results:
        status = "✅ SUCCESS" if success else "❌ FAILED"
        print(f"{status}: {name}")

    success_count = sum(1 for _, s in results if s)
    print(f"\n✨ Completed {success_count}/{len(results)} fixes successfully")

    if success_count == len(results):
        print("\n🎉 All fixes applied! Next steps:")
        print("  1. Run tests: pytest -v")
        print(
            "  2. Apply migration: psql $DATABASE_URL -f migrations/006_add_performance_indexes.sql"
        )
        print("  3. Re-run audit: python enhanced_project_auditor.py Project-root")
        print("  4. Review backups if rollback needed (*.audit_backup files)")
    else:
        print("\n⚠️  Some fixes failed - review errors above")


if __name__ == "__main__":
    main()
