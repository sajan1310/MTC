"""Migration: Correct update_lot_inventory_status function USES id instead of lot_id

Wraps the previously standalone SQL file fix_update_lot_inventory_status_function.sql
into the automated Python migration pipeline.

Upgrade: applies the corrected function & trigger.
Downgrade: attempts to restore previous buggy definition (for reversibility) using lot_id references.
"""

import os
import sys
from dotenv import load_dotenv

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from database import get_conn

load_dotenv()

SQL_FIX_PATH = os.path.abspath(
    os.path.join(
        os.path.dirname(__file__), "fix_update_lot_inventory_status_function.sql"
    )
)


def upgrade():
    with open(SQL_FIX_PATH, "r", encoding="utf-8") as f:
        sql = f.read()
    with get_conn() as (conn, cur):
        cur.execute(sql)
        conn.commit()
        print("Applied corrected update_lot_inventory_status function (uses id).")


def downgrade():
    # Recreate the previous buggy function for completeness; trigger recreated.
    buggy_function_sql = """
    BEGIN;
    CREATE OR REPLACE FUNCTION update_lot_inventory_status() RETURNS TRIGGER AS $$
    BEGIN
        IF EXISTS (SELECT 1 FROM production_lot_inventory_alerts WHERE production_lot_id = NEW.production_lot_id AND alert_severity = 'CRITICAL') THEN
            UPDATE production_lots SET lot_status_inventory = 'PENDING_PROCUREMENT' WHERE lot_id = NEW.production_lot_id;
        ELSIF EXISTS (SELECT 1 FROM production_lot_inventory_alerts WHERE production_lot_id = NEW.production_lot_id AND alert_severity = 'HIGH') THEN
            UPDATE production_lots SET lot_status_inventory = 'PARTIAL_FULFILLMENT_REQUIRED' WHERE lot_id = NEW.production_lot_id;
        ELSE
            UPDATE production_lots SET lot_status_inventory = 'READY' WHERE lot_id = NEW.production_lot_id;
        END IF;
        UPDATE production_lots SET alert_summary_json = (
            SELECT jsonb_build_object(
                'CRITICAL', COUNT(*) FILTER (WHERE alert_severity = 'CRITICAL'),
                'HIGH', COUNT(*) FILTER (WHERE alert_severity = 'HIGH'),
                'MEDIUM', COUNT(*) FILTER (WHERE alert_severity = 'MEDIUM'),
                'LOW', COUNT(*) FILTER (WHERE alert_severity = 'LOW'),
                'OK', COUNT(*) FILTER (WHERE alert_severity = 'OK')
            ) FROM production_lot_inventory_alerts WHERE production_lot_id = NEW.production_lot_id
        ) WHERE id = NEW.production_lot_id;
        RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS trg_update_lot_inventory_status ON production_lot_inventory_alerts;
    CREATE TRIGGER trg_update_lot_inventory_status
    AFTER INSERT OR UPDATE OR DELETE ON production_lot_inventory_alerts
    FOR EACH ROW EXECUTE FUNCTION update_lot_inventory_status();
    COMMIT;"""
    with get_conn() as (conn, cur):
        cur.execute(buggy_function_sql)
        conn.commit()
        print(
            "Reverted to buggy legacy update_lot_inventory_status function (uses lot_id)."
        )
