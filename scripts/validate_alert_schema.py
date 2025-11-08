"""
Schema Validation Script for Inventory Alert System Migration
Location: /scripts/validate_alert_schema.py
Output: schema_validation_report.txt with all checks PASSED/FAILED
Dependencies: psycopg2, json, datetime
"""

import psycopg2
import os
import datetime

DB_NAME = os.getenv("DB_NAME", "MTC")
DB_USER = os.getenv("DB_USER", "postgres")
DB_HOST = os.getenv("DB_HOST", "127.0.0.1")
DB_PORT = os.getenv("DB_PORT", "5432")
DB_PASSWORD = os.getenv("DB_PASS", "abcd")

REPORT_FILE = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "../schema_validation_report.txt")
)

TABLES = [
    "inventory_alert_rules",
    "production_lot_inventory_alerts",
    "production_lot_procurement_recommendations",
    "production_lots",
]

INDEXES = [
    "idx_variant_active",
    "idx_lot_severity",
    "idx_variant_created",
    "idx_lot_status",
    "idx_supplier_delivery",
    "idx_lot_status_inventory",
    "idx_variant_usage",
]

TRIGGER = "trg_update_lot_inventory_status"
FUNCTION = "update_lot_inventory_status"


def get_conn():
    return psycopg2.connect(
        dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD, host=DB_HOST, port=DB_PORT
    )


def check_table_exists(cur, table):
    cur.execute(
        """
        SELECT EXISTS (
            SELECT FROM information_schema.tables 
            WHERE table_name = %s
        );
    """,
        (table,),
    )
    return cur.fetchone()[0]


def check_index_exists(cur, index):
    cur.execute(
        """
        SELECT EXISTS (
            SELECT FROM pg_indexes WHERE indexname = %s
        );
    """,
        (index,),
    )
    return cur.fetchone()[0]


def check_trigger_exists(cur, trigger):
    cur.execute(
        """
        SELECT EXISTS (
            SELECT 1 FROM pg_trigger WHERE tgname = %s
        );
    """,
        (trigger,),
    )
    return cur.fetchone()[0]


def check_function_exists(cur, function):
    cur.execute(
        """
        SELECT EXISTS (
            SELECT 1 FROM pg_proc WHERE proname = %s
        );
    """,
        (function,),
    )
    return cur.fetchone()[0]


def check_column_exists(cur, table, column):
    cur.execute(
        """
        SELECT EXISTS (
            SELECT 1 FROM information_schema.columns WHERE table_name = %s AND column_name = %s
        );
    """,
        (table, column),
    )
    return cur.fetchone()[0]


def test_sample_inserts(cur):
    try:
        # Fetch latest valid IDs
        cur.execute(
            "SELECT variant_id FROM item_variant ORDER BY variant_id DESC LIMIT 1;"
        )
        variant_id = cur.fetchone()[0]
        cur.execute("SELECT id FROM production_lots ORDER BY id DESC LIMIT 1;")
        lot_id = cur.fetchone()[0]
        cur.execute(
            "SELECT supplier_id FROM suppliers ORDER BY supplier_id DESC LIMIT 1;"
        )
        supplier_id = cur.fetchone()[0]
        cur.execute("SELECT user_id FROM users ORDER BY user_id DESC LIMIT 1;")
        user_id = cur.fetchone()[0]
        # Insert into inventory_alert_rules
        cur.execute(
            """
            INSERT INTO inventory_alert_rules (variant_id, safety_stock_quantity, reorder_point_quantity, alert_threshold_percentage, created_by)
            VALUES (%s, 10, 20, 75.00, %s) RETURNING alert_rule_id;
        """,
            (variant_id, user_id),
        )
        cur.execute(
            "DELETE FROM inventory_alert_rules WHERE alert_rule_id = (SELECT MAX(alert_rule_id) FROM inventory_alert_rules);"
        )
        # Insert into production_lot_inventory_alerts
        cur.execute(
            """
            INSERT INTO production_lot_inventory_alerts (production_lot_id, variant_id, alert_severity, current_stock_quantity, required_quantity, shortfall_quantity)
            VALUES (%s, %s, 'CRITICAL', 0, 10, 10) RETURNING alert_id;
        """,
            (lot_id, variant_id),
        )
        cur.execute(
            "DELETE FROM production_lot_inventory_alerts WHERE alert_id = (SELECT MAX(alert_id) FROM production_lot_inventory_alerts);"
        )
        # Insert into production_lot_procurement_recommendations
        cur.execute(
            """
            INSERT INTO production_lot_procurement_recommendations (production_lot_id, variant_id, supplier_id, recommended_quantity, required_delivery_date, procurement_status)
            VALUES (%s, %s, %s, 10, CURRENT_DATE, 'RECOMMENDED') RETURNING recommendation_id;
        """,
            (lot_id, variant_id, supplier_id),
        )
        cur.execute(
            "DELETE FROM production_lot_procurement_recommendations WHERE recommendation_id = (SELECT MAX(recommendation_id) FROM production_lot_procurement_recommendations);"
        )
        return True, "Sample inserts succeeded."
    except Exception as e:
        return False, f"Sample inserts failed: {e}"


def test_jsonb_column(cur):
    try:
        # Use a valid existing lot id
        cur.execute("SELECT id FROM production_lots ORDER BY id DESC LIMIT 1;")
        row = cur.fetchone()
        if not row:
            return False, "No production_lots rows to test JSONB update."
        lot_id = row[0]
        cur.execute(
            """
            UPDATE production_lots SET alert_summary_json = '{"CRITICAL":1,"HIGH":2}' WHERE id = %s;
        """,
            (lot_id,),
        )
        return True, "JSONB column accepts valid JSON."
    except Exception as e:
        return False, f"JSONB column test failed: {e}"


def test_cascade_delete(cur):
    try:
        # Create a temporary lot with minimal required fields
        cur.execute("SELECT user_id FROM users ORDER BY user_id DESC LIMIT 1;")
        user_id = cur.fetchone()[0]
        cur.execute(
            "SELECT variant_id FROM item_variant ORDER BY variant_id DESC LIMIT 1;"
        )
        variant_id = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO production_lots (process_id, lot_number, created_by, status, quantity) VALUES (%s, %s, %s, %s, %s) RETURNING id;",
            (
                1,
                f"LOT-VALID-{int(datetime.datetime.now().timestamp() * 1000)}",
                user_id,
                "Planning",
                1,
            ),
        )
        new_lot_id = cur.fetchone()[0]
        # Insert related alert row
        cur.execute(
            """
            INSERT INTO production_lot_inventory_alerts (production_lot_id, variant_id, alert_severity, current_stock_quantity, required_quantity, shortfall_quantity)
            VALUES (%s, %s, 'LOW', 5, 10, 5);
            """,
            (new_lot_id, variant_id),
        )
        # Delete the lot (should cascade delete the alert)
        cur.execute("DELETE FROM production_lots WHERE id = %s;", (new_lot_id,))
        cur.execute(
            "SELECT COUNT(*) FROM production_lot_inventory_alerts WHERE production_lot_id = %s;",
            (new_lot_id,),
        )
        count = cur.fetchone()[0]
        if count == 0:
            return True, "Cascade delete on production_lots works."
        else:
            return False, "Cascade delete failed: orphaned alerts remain."
    except Exception as e:
        return False, f"Cascade delete test failed: {e}"


def test_performance(cur):
    try:
        cur.execute("""
            EXPLAIN ANALYZE SELECT * FROM production_lot_inventory_alerts WHERE alert_severity = 'CRITICAL' LIMIT 1000000;
        """)
        _ = cur.fetchall()  # Execute query but don't need result
        return True, "Performance test query executed."
    except Exception as e:
        return False, f"Performance test failed: {e}"


def main():
    report = []
    conn = get_conn()
    cur = conn.cursor()
    # 1. Verify tables
    for table in TABLES:
        exists = check_table_exists(cur, table)
        report.append(f"Table {table}: {'PASSED' if exists else 'FAILED'}")
    # 2. Verify indexes
    for index in INDEXES:
        exists = check_index_exists(cur, index)
        report.append(f"Index {index}: {'PASSED' if exists else 'FAILED'}")
    # 3. Verify trigger and function
    trig_exists = check_trigger_exists(cur, TRIGGER)
    func_exists = check_function_exists(cur, FUNCTION)
    report.append(f"Trigger {TRIGGER}: {'PASSED' if trig_exists else 'FAILED'}")
    report.append(f"Function {FUNCTION}: {'PASSED' if func_exists else 'FAILED'}")
    # 4. Check columns
    columns = [
        ("production_lots", "lot_status_inventory"),
        ("production_lots", "alert_summary_json"),
        ("production_lots", "inventory_validated_at"),
        ("production_lots", "inventory_validated_by"),
    ]
    for table, column in columns:
        exists = check_column_exists(cur, table, column)
        report.append(f"Column {table}.{column}: {'PASSED' if exists else 'FAILED'}")
    # 5. Test sample inserts
    ok, msg = test_sample_inserts(cur)
    report.append(f"Sample inserts: {'PASSED' if ok else 'FAILED'} - {msg}")
    # 6. Test cascade delete
    ok, msg = test_cascade_delete(cur)
    report.append(f"Cascade delete: {'PASSED' if ok else 'FAILED'} - {msg}")
    # 7. Test JSONB column
    ok, msg = test_jsonb_column(cur)
    report.append(f"JSONB column: {'PASSED' if ok else 'FAILED'} - {msg}")
    # 8. Performance test
    ok, msg = test_performance(cur)
    report.append(f"Performance test: {'PASSED' if ok else 'FAILED'} - {msg}")
    cur.close()
    conn.close()
    with open(REPORT_FILE, "w", encoding="utf-8") as f:
        f.write(f"Schema Validation Report - {datetime.datetime.now()}\n\n")
        for line in report:
            f.write(line + "\n")
    print(f"Schema validation report written to {REPORT_FILE}")


if __name__ == "__main__":
    main()
