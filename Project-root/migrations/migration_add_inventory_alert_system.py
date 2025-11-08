# Auto-import handled by migrations.py runner
import os
import sys

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from database import get_conn


def upgrade():
    with get_conn() as (conn, cur):
        print("Creating inventory alert tables...")
        cur.execute(
            "CREATE TABLE IF NOT EXISTS inventory_alert_rules (alert_rule_id SERIAL PRIMARY KEY, variant_id BIGINT REFERENCES item_variant(variant_id) ON DELETE CASCADE, safety_stock_quantity INTEGER NOT NULL DEFAULT 10, reorder_point_quantity INTEGER NOT NULL DEFAULT 20, alert_threshold_percentage DECIMAL(5,2) NOT NULL DEFAULT 75.00, is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, created_by BIGINT REFERENCES users(user_id));"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_variant_active ON inventory_alert_rules (variant_id, is_active);"
        )
        cur.execute(
            "CREATE TABLE IF NOT EXISTS production_lot_inventory_alerts (alert_id SERIAL PRIMARY KEY, production_lot_id BIGINT REFERENCES production_lots(id) ON DELETE CASCADE, variant_id BIGINT REFERENCES item_variant(variant_id) ON DELETE CASCADE, alert_severity VARCHAR(20) CHECK (alert_severity IN ('CRITICAL','HIGH','MEDIUM','LOW','OK')), current_stock_quantity INTEGER NOT NULL, required_quantity INTEGER NOT NULL, shortfall_quantity INTEGER NOT NULL, suggested_procurement_quantity INTEGER, user_acknowledged BOOLEAN DEFAULT FALSE, acknowledged_at TIMESTAMP, user_action VARCHAR(50) CHECK (user_action IN ('PROCEED','DELAY','SUBSTITUTE','PARTIAL_FULFILL')), action_notes TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_lot_severity ON production_lot_inventory_alerts (production_lot_id, alert_severity);"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_variant_created ON production_lot_inventory_alerts (variant_id, created_at);"
        )
        print(" Inventory alert system created")


def downgrade():
    with get_conn() as (conn, cur):
        cur.execute("DROP TABLE IF EXISTS production_lot_inventory_alerts CASCADE;")
        cur.execute("DROP TABLE IF EXISTS inventory_alert_rules CASCADE;")
