-- Migration: Fix update_lot_inventory_status function to use correct primary key column
-- Date: 2025-11-08
-- Description: Replace incorrect references to lot_id with id in production_lots updates.

BEGIN;

-- Recreate function with corrected WHERE clause
CREATE OR REPLACE FUNCTION update_lot_inventory_status() RETURNS TRIGGER AS $$
BEGIN
    -- Recalculate lot_status_inventory based on alert severities
    IF EXISTS (SELECT 1 FROM production_lot_inventory_alerts WHERE production_lot_id = NEW.production_lot_id AND alert_severity = 'CRITICAL') THEN
        UPDATE production_lots SET lot_status_inventory = 'PENDING_PROCUREMENT' WHERE id = NEW.production_lot_id;
    ELSIF EXISTS (SELECT 1 FROM production_lot_inventory_alerts WHERE production_lot_id = NEW.production_lot_id AND alert_severity = 'HIGH') THEN
        UPDATE production_lots SET lot_status_inventory = 'PARTIAL_FULFILLMENT_REQUIRED' WHERE id = NEW.production_lot_id;
    ELSE
        UPDATE production_lots SET lot_status_inventory = 'READY' WHERE id = NEW.production_lot_id;
    END IF;

    -- Update alert_summary_json aggregation
    UPDATE production_lots pl
    SET alert_summary_json = (
        SELECT jsonb_build_object(
            'CRITICAL', COALESCE(SUM(CASE WHEN alert_severity='CRITICAL' THEN 1 END),0),
            'HIGH', COALESCE(SUM(CASE WHEN alert_severity='HIGH' THEN 1 END),0),
            'MEDIUM', COALESCE(SUM(CASE WHEN alert_severity='MEDIUM' THEN 1 END),0),
            'LOW', COALESCE(SUM(CASE WHEN alert_severity='LOW' THEN 1 END),0)
        )
        FROM production_lot_inventory_alerts a
        WHERE a.production_lot_id = NEW.production_lot_id
    )
    WHERE pl.id = NEW.production_lot_id;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Ensure trigger exists (recreate to be safe)
DROP TRIGGER IF EXISTS trg_update_lot_inventory_status ON production_lot_inventory_alerts;
CREATE TRIGGER trg_update_lot_inventory_status
AFTER INSERT OR UPDATE OR DELETE ON production_lot_inventory_alerts
FOR EACH ROW EXECUTE FUNCTION update_lot_inventory_status();

COMMIT;
