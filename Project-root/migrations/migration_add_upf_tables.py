"""
Universal Process Framework Database Migration
Creates all 15 tables with proper indexes, foreign keys, triggers, and constraints
"""

import os
import sys

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import psycopg2
import psycopg2.extras
from config import Config


def create_upf_tables():
    DATABASE_URL = Config.DATABASE_URL
    """Create all UPF database tables"""

    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()

    try:
        print("=" * 80)
        print("UNIVERSAL PROCESS FRAMEWORK - DATABASE MIGRATION")
        print("=" * 80)

        # ===== TABLE 1: PROCESSES =====
        print("\n[1/15] Creating 'processes' table...")
        cur.execute("""
            CREATE TABLE IF NOT EXISTS processes (
                id SERIAL PRIMARY KEY,
                name VARCHAR(200) NOT NULL,
                description TEXT,
                process_class VARCHAR(50) CHECK (process_class IN ('Manufacturing', 'Assembly', 'Packaging', 'Testing', 'Logistics')),
                status VARCHAR(20) DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive', 'Draft')),
                worst_case_cost DECIMAL(12, 2) DEFAULT 0.00,
                sales_price DECIMAL(12, 2),
                created_by INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT unique_process_name UNIQUE(name)
            );

            CREATE INDEX IF NOT EXISTS idx_processes_status ON processes(status);
            CREATE INDEX IF NOT EXISTS idx_processes_class ON processes(process_class);
            CREATE INDEX IF NOT EXISTS idx_processes_created_by ON processes(created_by);
        """)
        print("   ✅ 'processes' table created")

        # ===== TABLE 2: SUBPROCESSES =====
        print("\n[2/15] Creating 'subprocesses' table...")
        cur.execute("""
            CREATE TABLE IF NOT EXISTS subprocesses (
                id SERIAL PRIMARY KEY,
                name VARCHAR(200) NOT NULL,
                description TEXT,
                category VARCHAR(100),
                estimated_time_minutes INTEGER DEFAULT 0,
                labor_cost DECIMAL(10, 2) DEFAULT 0.00,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT unique_subprocess_name UNIQUE(name)
            );

            CREATE INDEX IF NOT EXISTS idx_subprocesses_category ON subprocesses(category);
        """)
        print("   ✅ 'subprocesses' table created")

        # ===== TABLE 3: PROCESS_SUBPROCESSES =====
        print("\n[3/15] Creating 'process_subprocesses' table...")
        cur.execute("""
            CREATE TABLE IF NOT EXISTS process_subprocesses (
                id SERIAL PRIMARY KEY,
                process_id INTEGER NOT NULL REFERENCES processes(id) ON DELETE CASCADE,
                subprocess_id INTEGER NOT NULL REFERENCES subprocesses(id) ON DELETE RESTRICT,
                sequence INTEGER NOT NULL,
                custom_name VARCHAR(200),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT unique_process_subprocess UNIQUE(process_id, subprocess_id, sequence)
            );

            CREATE INDEX IF NOT EXISTS idx_process_subprocesses_process ON process_subprocesses(process_id);
            CREATE INDEX IF NOT EXISTS idx_process_subprocesses_subprocess ON process_subprocesses(subprocess_id);
            CREATE INDEX IF NOT EXISTS idx_process_subprocesses_sequence ON process_subprocesses(process_id, sequence);
        """)
        print("   ✅ 'process_subprocesses' table created")

        # ===== TABLE 4: VARIANTS (Link to existing inventory) =====
        print("\n[4/15] Creating 'variants' view (links to item_variant)...")
        cur.execute("""
            CREATE OR REPLACE VIEW variants AS
            SELECT
                v.variant_id as id,
                CONCAT(i.name, ' - ', c.color_name, ' - ', s.size_name) as name,
                COALESCE(mm.model_name, 'N/A') as model,
                COALESCE(vm.variation_name, 'Standard') as brand,
                'Product' as category,
                NULL::integer as category_id,
                COALESCE(sir.rate, 0) as unit_price,
                v.opening_stock as quantity,
                v.threshold as reorder_level,
                COALESCE(v.unit, 'pcs') as unit
            FROM item_variant v
            JOIN item_master i ON v.item_id = i.item_id
            JOIN color_master c ON v.color_id = c.color_id
            JOIN size_master s ON v.size_id = s.size_id
            LEFT JOIN model_master mm ON i.model_id = mm.model_id
            LEFT JOIN variation_master vm ON i.variation_id = vm.variation_id
            LEFT JOIN LATERAL (
                SELECT rate
                FROM supplier_item_rates
                WHERE item_id = v.item_id
                ORDER BY rate ASC
                LIMIT 1
            ) sir ON true;
        """)
        print("   ✅ 'variants' view created (links to item_variant)")

        # ===== TABLE 5: PROCESS_VARIANTS =====
        print("\n[5/15] Creating 'process_variants' table...")
        cur.execute("""
            CREATE TABLE IF NOT EXISTS process_variants (
                id SERIAL PRIMARY KEY,
                process_subprocess_id INTEGER NOT NULL REFERENCES process_subprocesses(id) ON DELETE CASCADE,
                variant_id INTEGER NOT NULL REFERENCES item_variant(variant_id) ON DELETE RESTRICT,
                quantity DECIMAL(10, 3) NOT NULL,
                unit VARCHAR(20) DEFAULT 'pcs',
                or_group_id INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_process_variants_subprocess ON process_variants(process_subprocess_id);
            CREATE INDEX IF NOT EXISTS idx_process_variants_variant ON process_variants(variant_id);
            CREATE INDEX IF NOT EXISTS idx_process_variants_or_group ON process_variants(or_group_id);
        """)
        print("   ✅ 'process_variants' table created")

        # ===== TABLE 6: OR_GROUPS =====
        print("\n[6/15] Creating 'or_groups' table...")
        cur.execute("""
            CREATE TABLE IF NOT EXISTS or_groups (
                id SERIAL PRIMARY KEY,
                process_subprocess_id INTEGER NOT NULL REFERENCES process_subprocesses(id) ON DELETE CASCADE,
                name VARCHAR(200),
                description TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT unique_or_group UNIQUE(process_subprocess_id, id)
            );

            CREATE INDEX IF NOT EXISTS idx_or_groups_subprocess ON or_groups(process_subprocess_id);
        """)
        print("   ✅ 'or_groups' table created")

        # ===== TABLE 7: OR_GROUP_VARIANTS =====
        print("\n[7/15] Creating 'or_group_variants' table...")
        cur.execute("""
            CREATE TABLE IF NOT EXISTS or_group_variants (
                id SERIAL PRIMARY KEY,
                or_group_id INTEGER NOT NULL REFERENCES or_groups(id) ON DELETE CASCADE,
                variant_id INTEGER NOT NULL REFERENCES item_variant(variant_id) ON DELETE RESTRICT,
                quantity DECIMAL(10, 3) NOT NULL,
                unit VARCHAR(20) DEFAULT 'pcs',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT unique_or_group_variant UNIQUE(or_group_id, variant_id)
            );

            CREATE INDEX IF NOT EXISTS idx_or_group_variants_group ON or_group_variants(or_group_id);
            CREATE INDEX IF NOT EXISTS idx_or_group_variants_variant ON or_group_variants(variant_id);
        """)
        print("   ✅ 'or_group_variants' table created")

        # ===== TABLE 8: PRODUCTION_LOTS =====
        print("\n[8/15] Creating 'production_lots' table...")
        cur.execute("""
            CREATE TABLE IF NOT EXISTS production_lots (
                id SERIAL PRIMARY KEY,
                lot_number VARCHAR(50) NOT NULL,
                process_id INTEGER NOT NULL REFERENCES processes(id) ON DELETE RESTRICT,
                quantity INTEGER NOT NULL,
                status VARCHAR(20) DEFAULT 'Planning' CHECK (status IN ('Planning', 'Ready', 'In Progress', 'Completed', 'Failed')),
                total_cost DECIMAL(12, 2),
                started_at TIMESTAMP,
                completed_at TIMESTAMP,
                created_by INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                notes TEXT,
                CONSTRAINT unique_lot_number UNIQUE(lot_number)
            );

            CREATE INDEX IF NOT EXISTS idx_production_lots_process ON production_lots(process_id);
            CREATE INDEX IF NOT EXISTS idx_production_lots_status ON production_lots(status);
            CREATE INDEX IF NOT EXISTS idx_production_lots_created_by ON production_lots(created_by);
        """)
        print("   ✅ 'production_lots' table created")

        # ===== TABLE 9: PRODUCTION_LOT_VARIANTS =====
        print("\n[9/15] Creating 'production_lot_variants' table...")
        cur.execute("""
            CREATE TABLE IF NOT EXISTS production_lot_variants (
                id SERIAL PRIMARY KEY,
                production_lot_id INTEGER NOT NULL REFERENCES production_lots(id) ON DELETE CASCADE,
                or_group_id INTEGER REFERENCES or_groups(id) ON DELETE SET NULL,
                variant_id INTEGER NOT NULL REFERENCES item_variant(variant_id) ON DELETE RESTRICT,
                quantity_per_unit DECIMAL(10, 3) NOT NULL,
                total_quantity DECIMAL(10, 3) NOT NULL,
                unit VARCHAR(20) DEFAULT 'pcs',
                unit_cost DECIMAL(10, 2),
                total_cost DECIMAL(12, 2),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_production_lot_variants_lot ON production_lot_variants(production_lot_id);
            CREATE INDEX IF NOT EXISTS idx_production_lot_variants_variant ON production_lot_variants(variant_id);
        """)
        print("   ✅ 'production_lot_variants' table created")

        # ===== TABLE 10: PRODUCTION_LOT_SUBPROCESSES =====
        print("\n[10/15] Creating 'production_lot_subprocesses' table...")
        cur.execute("""
            CREATE TABLE IF NOT EXISTS production_lot_subprocesses (
                id SERIAL PRIMARY KEY,
                production_lot_id INTEGER NOT NULL REFERENCES production_lots(id) ON DELETE CASCADE,
                subprocess_id INTEGER NOT NULL REFERENCES subprocesses(id) ON DELETE RESTRICT,
                sequence INTEGER NOT NULL,
                status VARCHAR(20) DEFAULT 'Pending' CHECK (status IN ('Pending', 'In Progress', 'Completed', 'Skipped')),
                started_at TIMESTAMP,
                completed_at TIMESTAMP,
                notes TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_production_lot_subprocesses_lot ON production_lot_subprocesses(production_lot_id);
            CREATE INDEX IF NOT EXISTS idx_production_lot_subprocesses_status ON production_lot_subprocesses(status);
        """)
        print("   ✅ 'production_lot_subprocesses' table created")

        # ===== TABLE 11: INVENTORY_TRANSACTIONS =====
        print("\n[11/15] Creating 'inventory_transactions' table...")
        cur.execute("""
            CREATE TABLE IF NOT EXISTS inventory_transactions (
                id SERIAL PRIMARY KEY,
                variant_id INTEGER NOT NULL REFERENCES item_variant(variant_id) ON DELETE RESTRICT,
                production_lot_id INTEGER REFERENCES production_lots(id) ON DELETE SET NULL,
                transaction_type VARCHAR(20) CHECK (transaction_type IN ('Debit', 'Credit', 'Production', 'Adjustment')),
                quantity DECIMAL(10, 3) NOT NULL,
                unit VARCHAR(20),
                reference_type VARCHAR(50),
                reference_id INTEGER,
                notes TEXT,
                created_by INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_inventory_transactions_variant ON inventory_transactions(variant_id);
            CREATE INDEX IF NOT EXISTS idx_inventory_transactions_lot ON inventory_transactions(production_lot_id);
            CREATE INDEX IF NOT EXISTS idx_inventory_transactions_type ON inventory_transactions(transaction_type);
            CREATE INDEX IF NOT EXISTS idx_inventory_transactions_created_at ON inventory_transactions(created_at);
        """)
        print("   ✅ 'inventory_transactions' table created")

        # ===== TABLE 12: COST_HISTORY =====
        print("\n[12/15] Creating 'cost_history' table...")
        cur.execute("""
            CREATE TABLE IF NOT EXISTS cost_history (
                id SERIAL PRIMARY KEY,
                process_id INTEGER NOT NULL REFERENCES processes(id) ON DELETE CASCADE,
                worst_case_cost DECIMAL(12, 2) NOT NULL,
                calculated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                calculated_by INTEGER REFERENCES users(user_id) ON DELETE SET NULL
            );

            CREATE INDEX IF NOT EXISTS idx_cost_history_process ON cost_history(process_id);
            CREATE INDEX IF NOT EXISTS idx_cost_history_calculated_at ON cost_history(calculated_at);
        """)
        print("   ✅ 'cost_history' table created")

        # ===== TABLE 13: PROCESS_AUDIT_LOG =====
        print("\n[13/15] Creating 'process_audit_log' table...")
        cur.execute("""
            CREATE TABLE IF NOT EXISTS process_audit_log (
                id SERIAL PRIMARY KEY,
                table_name VARCHAR(100) NOT NULL,
                record_id INTEGER NOT NULL,
                action VARCHAR(20) CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
                old_values JSONB,
                new_values JSONB,
                changed_by INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
                changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_process_audit_log_table ON process_audit_log(table_name);
            CREATE INDEX IF NOT EXISTS idx_process_audit_log_record ON process_audit_log(table_name, record_id);
            CREATE INDEX IF NOT EXISTS idx_process_audit_log_changed_at ON process_audit_log(changed_at);
        """)
        print("   ✅ 'process_audit_log' table created")

        # ===== TRIGGERS =====
        print("\n[14/15] Creating triggers for updated_at timestamps...")

        # Trigger function
        cur.execute("""
            CREATE OR REPLACE FUNCTION update_updated_at_column()
            RETURNS TRIGGER AS $$
            BEGIN
                NEW.updated_at = CURRENT_TIMESTAMP;
                RETURN NEW;
            END;
            $$ language 'plpgsql';
        """)

        # Apply to relevant tables
        tables_with_updated_at = ["processes", "subprocesses"]
        for table in tables_with_updated_at:
            cur.execute(f"""
                DROP TRIGGER IF EXISTS update_{table}_updated_at ON {table};
                CREATE TRIGGER update_{table}_updated_at
                    BEFORE UPDATE ON {table}
                    FOR EACH ROW
                    EXECUTE FUNCTION update_updated_at_column();
            """)

        print("   ✅ Triggers created")

        # ===== SEQUENCE AUTO-GENERATION =====
        print("\n[15/15] Creating trigger for lot number auto-generation...")
        cur.execute("""
            CREATE OR REPLACE FUNCTION generate_lot_number()
            RETURNS TRIGGER AS $$
            BEGIN
                IF NEW.lot_number IS NULL OR NEW.lot_number = '' THEN
                    NEW.lot_number := 'LOT-' || TO_CHAR(CURRENT_DATE, 'YYYYMMDD') || '-' ||
                                      LPAD(NEXTVAL('production_lots_id_seq')::TEXT, 6, '0');
                END IF;
                RETURN NEW;
            END;
            $$ language 'plpgsql';

            DROP TRIGGER IF EXISTS generate_lot_number_trigger ON production_lots;
            CREATE TRIGGER generate_lot_number_trigger
                BEFORE INSERT ON production_lots
                FOR EACH ROW
                EXECUTE FUNCTION generate_lot_number();
        """)
        print("   ✅ Lot number auto-generation trigger created")

        conn.commit()

        # ===== VERIFICATION =====
        print("\n" + "=" * 80)
        print("VERIFYING TABLES...")
        print("=" * 80)

        cur.execute("""
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
            AND table_name IN (
                'processes', 'subprocesses', 'process_subprocesses',
                'process_variants', 'or_groups', 'or_group_variants',
                'production_lots', 'production_lot_variants', 'production_lot_subprocesses',
                'inventory_transactions', 'cost_history', 'process_audit_log'
            )
            ORDER BY table_name;
        """)

        tables = cur.fetchall()
        print(f"\n✅ {len(tables)} tables created successfully:")
        for table in tables:
            print(f"   - {table[0]}")

        # Count indexes
        cur.execute("""
            SELECT COUNT(*)
            FROM pg_indexes
            WHERE schemaname = 'public'
            AND tablename LIKE '%process%' OR tablename LIKE '%production%' OR tablename = 'or_groups';
        """)
        index_count = cur.fetchone()[0]
        print(f"\n✅ {index_count} indexes created")

        # Count triggers
        cur.execute("""
            SELECT COUNT(*)
            FROM pg_trigger
            WHERE tgname LIKE '%process%' OR tgname LIKE '%lot%';
        """)
        trigger_count = cur.fetchone()[0]
        print(f"✅ {trigger_count} triggers created")

        print("\n" + "=" * 80)
        print("✅ UNIVERSAL PROCESS FRAMEWORK MIGRATION COMPLETED SUCCESSFULLY!")
        print("=" * 80)

    except Exception as e:
        conn.rollback()
        print(f"\n❌ Error during migration: {e}")
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    create_upf_tables()
