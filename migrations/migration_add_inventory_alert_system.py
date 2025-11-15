"""
Migration Script: Add Inventory Alert System
Location: /migrations/migration_add_inventory_alert_system.py
Format: Python script with up() and down() functions
Includes: Transaction safety, rollback logic, data validation
"""

import psycopg2
import os

# Database configuration - reads from environment variables (CI-compatible)
# CI sets: DB_USER=postgres, DB_PASS=testpass, DB_NAME=testdb, DB_HOST=127.0.0.1
DB_NAME = os.getenv("DB_NAME", "MTC")
DB_USER = os.getenv("DB_USER", "postgres")
DB_HOST = os.getenv("DB_HOST", "127.0.0.1")
DB_PORT = os.getenv("DB_PORT", "5432")
DB_PASSWORD = os.getenv("DB_PASS", "abcd")


def get_conn():
    return psycopg2.connect(
        dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD, host=DB_HOST, port=DB_PORT
    )


def up():
    conn = get_conn()
    cur = conn.cursor()
    try:
        # 1. Create inventory_alert_rules
        cur.execute(
            """
        CREATE TABLE IF NOT EXISTS inventory_alert_rules (
            alert_rule_id SERIAL PRIMARY KEY,
                variant_id BIGINT REFERENCES item_variant(variant_id) ON DELETE CASCADE,
            safety_stock_quantity INTEGER NOT NULL DEFAULT 10,
            reorder_point_quantity INTEGER NOT NULL DEFAULT 20,
            alert_threshold_percentage DECIMAL(5,2) NOT NULL DEFAULT 75.00,
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            created_by BIGINT REFERENCES users(user_id)
        );
        """
        )
        cur.execute(
            """
    CREATE INDEX IF NOT EXISTS idx_variant_active ON inventory_alert_rules (variant_id, is_active);
        """
        )
        # 2. Create production_lot_inventory_alerts
        cur.execute(
            """
        CREATE TABLE IF NOT EXISTS production_lot_inventory_alerts (
            alert_id SERIAL PRIMARY KEY,
                production_lot_id BIGINT REFERENCES production_lots(id) ON DELETE CASCADE,
                variant_id BIGINT REFERENCES item_variant(variant_id) ON DELETE CASCADE,
            alert_severity VARCHAR(20) CHECK (alert_severity IN ('CRITICAL','HIGH','MEDIUM','LOW','OK')),
            current_stock_quantity INTEGER NOT NULL,
            required_quantity INTEGER NOT NULL,
            shortfall_quantity INTEGER NOT NULL,
            suggested_procurement_quantity INTEGER,
            user_acknowledged BOOLEAN DEFAULT FALSE,
            acknowledged_at TIMESTAMP,
            user_action VARCHAR(50) CHECK (user_action IN ('PROCEED','DELAY','SUBSTITUTE','PARTIAL_FULFILL')),
            action_notes TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_lot_severity ON production_lot_inventory_alerts (production_lot_id, alert_severity);
            CREATE INDEX IF NOT EXISTS idx_variant_created ON production_lot_inventory_alerts (variant_id, created_at);
        """
        )
        # 3. Create production_lot_procurement_recommendations
        cur.execute(
            """
        CREATE TABLE IF NOT EXISTS production_lot_procurement_recommendations (
            recommendation_id SERIAL PRIMARY KEY,
                production_lot_id BIGINT REFERENCES production_lots(id) ON DELETE CASCADE,
                variant_id BIGINT REFERENCES item_variant(variant_id) ON DELETE CASCADE,
            supplier_id BIGINT REFERENCES suppliers(supplier_id),
            recommended_quantity INTEGER NOT NULL,
            required_delivery_date DATE NOT NULL,
            procurement_status VARCHAR(30) CHECK (procurement_status IN ('RECOMMENDED','ORDERED','RECEIVED','PARTIAL','CANCELLED')),
            purchase_order_id BIGINT REFERENCES purchase_orders(po_id) ON DELETE SET NULL,
            estimated_cost DECIMAL(12,2),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_lot_status ON production_lot_procurement_recommendations (production_lot_id, procurement_status);
        CREATE INDEX IF NOT EXISTS idx_supplier_delivery ON production_lot_procurement_recommendations (supplier_id, required_delivery_date);
        """
        )
        # 4. Alter production_lots table
        cur.execute(
            """
        ALTER TABLE production_lots ADD COLUMN IF NOT EXISTS lot_status_inventory VARCHAR(30) DEFAULT 'READY' CHECK (lot_status_inventory IN ('READY','PENDING_PROCUREMENT','PARTIAL_FULFILLMENT_REQUIRED','ON_HOLD'));
        ALTER TABLE production_lots ADD COLUMN IF NOT EXISTS alert_summary_json JSONB DEFAULT '{}';
        ALTER TABLE production_lots ADD COLUMN IF NOT EXISTS inventory_validated_at TIMESTAMP;
    ALTER TABLE production_lots ADD COLUMN IF NOT EXISTS inventory_validated_by BIGINT REFERENCES users(user_id);
        CREATE INDEX IF NOT EXISTS idx_lot_status_inventory ON production_lots (lot_status_inventory);
        """
        )
        # 5. Create trigger function for lot inventory status
        cur.execute(
            """
        CREATE OR REPLACE FUNCTION update_lot_inventory_status() RETURNS TRIGGER AS $$
        BEGIN
            -- Recalculate lot_status_inventory based on alert severities
            IF EXISTS (SELECT 1 FROM production_lot_inventory_alerts WHERE production_lot_id = NEW.production_lot_id AND alert_severity = 'CRITICAL') THEN
                UPDATE production_lots SET lot_status_inventory = 'PENDING_PROCUREMENT' WHERE lot_id = NEW.production_lot_id;
            ELSIF EXISTS (SELECT 1 FROM production_lot_inventory_alerts WHERE production_lot_id = NEW.production_lot_id AND alert_severity = 'HIGH') THEN
                UPDATE production_lots SET lot_status_inventory = 'PARTIAL_FULFILLMENT_REQUIRED' WHERE lot_id = NEW.production_lot_id;
            ELSE
                UPDATE production_lots SET lot_status_inventory = 'READY' WHERE lot_id = NEW.production_lot_id;
            END IF;
            -- Update alert_summary_json
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
        """
        )
        cur.execute(
            """
        DROP TRIGGER IF EXISTS trg_update_lot_inventory_status ON production_lot_inventory_alerts;
        CREATE TRIGGER trg_update_lot_inventory_status
        AFTER INSERT OR UPDATE OR DELETE ON production_lot_inventory_alerts
        FOR EACH ROW EXECUTE FUNCTION update_lot_inventory_status();
        """
        )
        # 6. Create index on variant_usage
        cur.execute(
            """
    CREATE INDEX IF NOT EXISTS idx_variant_usage ON variant_usage (process_subprocess_id, variant_id);
        """
        )
        conn.commit()
        print("Migration up() completed successfully.")
    except Exception as e:
        conn.rollback()
        print(f"Migration up() failed: {e}")
    finally:
        cur.close()
        conn.close()


def down():
    conn = get_conn()
    cur = conn.cursor()
    try:
        cur.execute(
            """
        DROP TRIGGER IF EXISTS trg_update_lot_inventory_status ON production_lot_inventory_alerts;
        DROP FUNCTION IF EXISTS update_lot_inventory_status();
        DROP INDEX IF EXISTS idx_variant_usage;
        DROP INDEX IF EXISTS idx_lot_status_inventory;
        DROP INDEX IF EXISTS idx_lot_severity;
        DROP INDEX IF EXISTS idx_variant_created;
        DROP INDEX IF EXISTS idx_lot_status;
        DROP INDEX IF EXISTS idx_supplier_delivery;
        ALTER TABLE production_lots DROP COLUMN IF EXISTS lot_status_inventory;
        ALTER TABLE production_lots DROP COLUMN IF EXISTS alert_summary_json;
        ALTER TABLE production_lots DROP COLUMN IF EXISTS inventory_validated_at;
        ALTER TABLE production_lots DROP COLUMN IF EXISTS inventory_validated_by;
        DROP TABLE IF EXISTS production_lot_procurement_recommendations;
        DROP TABLE IF EXISTS production_lot_inventory_alerts;
        DROP TABLE IF EXISTS inventory_alert_rules;
        """
        )
        conn.commit()
        print("Migration down() completed successfully.")
    except Exception as e:
        conn.rollback()
        print(f"Migration down() failed: {e}")
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "down":
        down()
    else:
        up()
