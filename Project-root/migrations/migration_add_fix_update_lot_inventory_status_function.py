"""Migration: Correct update_lot_inventory_status function (use production_lots.id consistently)

This migration used to rely on an external SQL file; that file is not guaranteed to be present
when tests run. Embed the corrected function SQL inline and apply via alembic.op for stability
in test and CI environments.

Upgrade: create or replace the corrected function that consistently uses production_lots.id
for updates and (re)create the trigger.
Downgrade: recreate the previous buggy variant which used production_lots.lot_id for updates
so the migration is reversible.
"""

from database import get_conn


def upgrade():
    corrected_sql = """
    BEGIN;
    CREATE OR REPLACE FUNCTION update_lot_inventory_status() RETURNS TRIGGER AS $$
    BEGIN
        IF EXISTS (
            SELECT 1 FROM production_lot_inventory_alerts
            WHERE production_lot_id = NEW.production_lot_id AND alert_severity = 'CRITICAL'
        ) THEN
            UPDATE production_lots SET lot_status_inventory = 'PENDING_PROCUREMENT' WHERE id = NEW.production_lot_id;
        ELSIF EXISTS (
            SELECT 1 FROM production_lot_inventory_alerts
            WHERE production_lot_id = NEW.production_lot_id AND alert_severity = 'HIGH'
        ) THEN
            UPDATE production_lots SET lot_status_inventory = 'PARTIAL_FULFILLMENT_REQUIRED' WHERE id = NEW.production_lot_id;
        ELSE
            UPDATE production_lots SET lot_status_inventory = 'READY' WHERE id = NEW.production_lot_id;
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
    COMMIT;
    """
    with get_conn() as (conn, cur):
        cur.execute(corrected_sql)
        conn.commit()


def downgrade():
    # Recreate the previous buggy function (uses lot_id for updates) so downgrade is reversible
    buggy_sql = """
    BEGIN;
    CREATE OR REPLACE FUNCTION update_lot_inventory_status() RETURNS TRIGGER AS $$
    BEGIN
        IF EXISTS (
            SELECT 1 FROM production_lot_inventory_alerts
            WHERE production_lot_id = NEW.production_lot_id AND alert_severity = 'CRITICAL'
        ) THEN
            UPDATE production_lots SET lot_status_inventory = 'PENDING_PROCUREMENT' WHERE lot_id = NEW.production_lot_id;
        ELSIF EXISTS (
            SELECT 1 FROM production_lot_inventory_alerts
            WHERE production_lot_id = NEW.production_lot_id AND alert_severity = 'HIGH'
        ) THEN
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
    COMMIT;
    """
    with get_conn() as (conn, cur):
        cur.execute(buggy_sql)
        conn.commit()
