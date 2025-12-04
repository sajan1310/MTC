"""
Migration: Universal Process Framework
Date: 2025-11-04
Description: Adds complete process management framework with subprocesses,
             variant usage, OR/substitute groups, worst-case costing,
             production lots, and profitability tracking.

This migration creates 15 new tables to support:
- Process and subprocess management
- Variant usage with multi-supplier pricing
- OR/Substitute groups for production-time flexibility
- Worst-case scenario costing
- Production lot management with variant selections
- Real-time profitability calculations
- Process timing and conditional logic
- Comprehensive audit trails

CRITICAL: This migration is designed for ZERO regression.
All existing functionality remains unchanged.
"""

import os
import sys

from dotenv import load_dotenv

# Add project root to the Python path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from database import get_conn

load_dotenv()


def upgrade():
    """
    Creates all Universal Process Framework tables and indexes.
    """
    with get_conn() as (conn, cur):
        print("Starting Universal Process Framework migration...")

        # ===== TABLE 1: PROCESS MANAGEMENT =====
        print("Creating processes table...")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS processes (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                description TEXT,
                class VARCHAR(50) CHECK (class IN ('assembly', 'manufacturing', 'packaging',
                                                   'maintenance', 'service', 'procurement')),
                user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
                status VARCHAR(50) DEFAULT 'draft' CHECK (status IN ('draft', 'active',
                                                                      'archived', 'inactive')),
                version INTEGER DEFAULT 1,
                is_deleted BOOLEAN DEFAULT FALSE,
                deleted_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(id, user_id)
            );
        """
        )

        # ===== TABLE 2: SUBPROCESS MANAGEMENT =====
        print("Creating subprocesses table...")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS subprocesses (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                description TEXT,
                reusable BOOLEAN DEFAULT FALSE,
                version INTEGER DEFAULT 1,
                user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
                is_deleted BOOLEAN DEFAULT FALSE,
                deleted_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """
        )

        # ===== TABLE 3: PROCESS-SUBPROCESS ASSOCIATION =====
        print("Creating process_subprocesses table...")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS process_subprocesses (
                id SERIAL PRIMARY KEY,
                process_id INTEGER NOT NULL REFERENCES processes(id) ON DELETE CASCADE,
                subprocess_id INTEGER NOT NULL REFERENCES subprocesses(id) ON DELETE RESTRICT,
                custom_name VARCHAR(255),
                sequence_order INTEGER NOT NULL,
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(process_id, subprocess_id, sequence_order)
            );
        """
        )

        # ===== TABLE 4: VARIANT USAGE IN SUBPROCESS =====
        print("Creating variant_usage table...")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS variant_usage (
                id SERIAL PRIMARY KEY,
                process_subprocess_id INTEGER NOT NULL REFERENCES process_subprocesses(id) ON DELETE CASCADE,
                variant_id INTEGER NOT NULL REFERENCES item_variant(variant_id) ON DELETE RESTRICT,
                quantity NUMERIC(10,4) NOT NULL CHECK (quantity > 0),
                cost_per_unit NUMERIC(10,2),
                total_cost NUMERIC(12,2),
                substitute_group_id INTEGER,
                is_alternative BOOLEAN DEFAULT FALSE,
                alternative_order INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """
        )

        # ===== TABLE 5: COST ITEMS =====
        print("Creating cost_items table...")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS cost_items (
                id SERIAL PRIMARY KEY,
                process_subprocess_id INTEGER NOT NULL REFERENCES process_subprocesses(id) ON DELETE CASCADE,
                cost_type VARCHAR(50) NOT NULL CHECK (cost_type IN ('labor', 'electricity',
                                                                     'maintenance', 'service',
                                                                     'overhead', 'packing',
                                                                     'inspection', 'other')),
                description TEXT,
                quantity NUMERIC(10,4) NOT NULL CHECK (quantity > 0),
                rate_per_unit NUMERIC(10,2) NOT NULL,
                total_cost NUMERIC(12,2),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """
        )

        # ===== TABLE 6: ADDITIONAL OVERALL COSTS =====
        print("Creating additional_costs table...")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS additional_costs (
                id SERIAL PRIMARY KEY,
                process_id INTEGER NOT NULL REFERENCES processes(id) ON DELETE CASCADE,
                cost_type VARCHAR(50) NOT NULL,
                description TEXT,
                amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
                is_fixed BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """
        )

        # ===== TABLE 7: PROCESS TIMING =====
        print("Creating process_timing table...")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS process_timing (
                id SERIAL PRIMARY KEY,
                process_subprocess_id INTEGER NOT NULL REFERENCES process_subprocesses(id) ON DELETE CASCADE,
                estimated_duration NUMERIC(10,2),
                actual_duration NUMERIC(10,2),
                duration_unit VARCHAR(20) DEFAULT 'minutes' CHECK (duration_unit IN ('minutes',
                                                                                     'hours', 'days')),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """
        )

        # ===== TABLE 8: CONDITIONAL FLAGS =====
        print("Creating conditional_flags table...")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS conditional_flags (
                id SERIAL PRIMARY KEY,
                process_subprocess_id INTEGER NOT NULL REFERENCES process_subprocesses(id) ON DELETE CASCADE,
                condition_type VARCHAR(50) CHECK (condition_type IN ('quality_check', 'rework',
                                                                     'alternative_path', 'skip_step')),
                description TEXT,
                is_enabled BOOLEAN DEFAULT FALSE,
                condition_value VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """
        )

        # ===== TABLE 9: PROFITABILITY TRACKING =====
        print("Creating profitability table...")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS profitability (
                id SERIAL PRIMARY KEY,
                process_id INTEGER NOT NULL REFERENCES processes(id) ON DELETE CASCADE,
                total_worst_case_cost NUMERIC(12,2),
                estimated_sales_price NUMERIC(12,2),
                profit_margin NUMERIC(10,2),
                profit_amount NUMERIC(12,2),
                last_calculated TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(process_id)
            );
        """
        )

        # ===== TABLE 10: SUBSTITUTE/ALTERNATIVE GROUPS =====
        print("Creating substitute_groups table...")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS substitute_groups (
                id SERIAL PRIMARY KEY,
                process_subprocess_id INTEGER NOT NULL REFERENCES process_subprocesses(id) ON DELETE CASCADE,
                group_name VARCHAR(255) NOT NULL,
                group_description TEXT,
                selection_method VARCHAR(50) DEFAULT 'dropdown' CHECK (selection_method IN ('dropdown',
                                                                                            'radio', 'list')),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """
        )

        # Add foreign key constraint for substitute groups
        cur.execute(
            """
            ALTER TABLE variant_usage
            ADD CONSTRAINT fk_substitute_group
            FOREIGN KEY (substitute_group_id)
            REFERENCES substitute_groups(id)
            ON DELETE CASCADE;
        """
        )

        # ===== TABLE 11: SUPPLIER PRICING FOR VARIANTS =====
        print("Creating variant_supplier_pricing table...")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS variant_supplier_pricing (
                id SERIAL PRIMARY KEY,
                variant_id INTEGER NOT NULL REFERENCES item_variant(variant_id) ON DELETE CASCADE,
                supplier_id INTEGER REFERENCES suppliers(supplier_id) ON DELETE CASCADE,
                cost_per_unit NUMERIC(10,2) NOT NULL CHECK (cost_per_unit >= 0),
                currency VARCHAR(3) DEFAULT 'INR',
                minimum_order_qty INTEGER DEFAULT 1 CHECK (minimum_order_qty > 0),
                effective_from TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                effective_to TIMESTAMP,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(variant_id, supplier_id, effective_from)
            );
        """
        )

        # ===== TABLE 12: WORST-CASE COSTING TRACKING =====
        print("Creating process_worst_case_costing table...")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS process_worst_case_costing (
                id SERIAL PRIMARY KEY,
                process_id INTEGER NOT NULL REFERENCES processes(id) ON DELETE CASCADE,
                process_subprocess_id INTEGER REFERENCES process_subprocesses(id) ON DELETE CASCADE,
                variant_id INTEGER REFERENCES item_variant(variant_id) ON DELETE SET NULL,
                supplier_id INTEGER REFERENCES suppliers(supplier_id) ON DELETE SET NULL,
                worst_case_cost NUMERIC(10,2) NOT NULL,
                quantity NUMERIC(10,4) NOT NULL CHECK (quantity > 0),
                total_worst_case_cost NUMERIC(12,2),
                is_substitute_group BOOLEAN DEFAULT FALSE,
                selected_alternative_variant_id INTEGER REFERENCES item_variant(variant_id) ON DELETE SET NULL,
                cost_calculation_method VARCHAR(50) DEFAULT 'worst_case' CHECK (cost_calculation_method IN
                                                                                ('worst_case', 'best_case', 'average')),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """
        )

        # ===== TABLE 13: PRODUCTION LOTS =====
        print("Creating production_lots table...")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS production_lots (
                id SERIAL PRIMARY KEY,
                process_id INTEGER NOT NULL REFERENCES processes(id) ON DELETE RESTRICT,
                lot_number VARCHAR(100) NOT NULL UNIQUE,
                user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
                status VARCHAR(50) DEFAULT 'draft' CHECK (status IN ('draft', 'ready',
                                                                     'in_progress', 'completed',
                                                                     'cancelled')),
                quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
                worst_case_estimated_cost NUMERIC(12,2),
                total_cost NUMERIC(12,2),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                started_at TIMESTAMP,
                completed_at TIMESTAMP,
                UNIQUE(id, process_id)
            );
        """
        )

        # ===== TABLE 14: PRODUCTION LOT VARIANT SELECTIONS =====
        print("Creating production_lot_selections table...")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS production_lot_selections (
                id SERIAL PRIMARY KEY,
                production_lot_id INTEGER NOT NULL REFERENCES production_lots(id) ON DELETE CASCADE,
                substitute_group_id INTEGER NOT NULL REFERENCES substitute_groups(id) ON DELETE RESTRICT,
                selected_variant_id INTEGER NOT NULL REFERENCES item_variant(variant_id) ON DELETE RESTRICT,
                selected_supplier_id INTEGER REFERENCES suppliers(supplier_id) ON DELETE SET NULL,
                selected_cost NUMERIC(10,2),
                selected_quantity NUMERIC(10,4),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(production_lot_id, substitute_group_id)
            );
        """
        )

        # ===== TABLE 15: PRODUCTION LOT ACTUAL COSTING =====
        print("Creating production_lot_actual_costing table...")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS production_lot_actual_costing (
                id SERIAL PRIMARY KEY,
                production_lot_id INTEGER NOT NULL REFERENCES production_lots(id) ON DELETE CASCADE,
                variant_id INTEGER NOT NULL REFERENCES item_variant(variant_id) ON DELETE RESTRICT,
                supplier_id INTEGER REFERENCES suppliers(supplier_id) ON DELETE SET NULL,
                worst_case_estimated NUMERIC(10,2),
                actual_cost_paid NUMERIC(10,2),
                variance NUMERIC(10,2),
                variance_percentage NUMERIC(5,2),
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """
        )

        # ===== PERFORMANCE INDEXES =====
        print("Creating performance indexes...")

        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_processes_user_id ON processes(user_id);"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_processes_status ON processes(status);"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_processes_class ON processes(class);"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_processes_deleted ON processes(is_deleted);"
        )

        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_subprocesses_reusable ON subprocesses(reusable);"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_subprocesses_user_id ON subprocesses(user_id);"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_subprocesses_deleted ON subprocesses(is_deleted);"
        )

        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_process_subprocesses_process_id ON process_subprocesses(process_id);"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_process_subprocesses_subprocess_id ON process_subprocesses(subprocess_id);"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_process_subprocesses_sequence ON process_subprocesses(process_id, sequence_order);"
        )

        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_variant_usage_process_subprocess ON variant_usage(process_subprocess_id);"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_variant_usage_variant ON variant_usage(variant_id);"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_variant_usage_substitute_group ON variant_usage(substitute_group_id);"
        )

        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_cost_items_process_subprocess ON cost_items(process_subprocess_id);"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_additional_costs_process ON additional_costs(process_id);"
        )

        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_substitute_groups_process_subprocess ON substitute_groups(process_subprocess_id);"
        )

        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_variant_supplier_pricing_variant ON variant_supplier_pricing(variant_id);"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_variant_supplier_pricing_supplier ON variant_supplier_pricing(supplier_id);"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_variant_supplier_pricing_active ON variant_supplier_pricing(is_active, effective_from);"
        )

        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_process_worst_case_costing_process ON process_worst_case_costing(process_id);"
        )

        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_production_lots_process_id ON production_lots(process_id);"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_production_lots_status ON production_lots(status);"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_production_lots_user_id ON production_lots(user_id);"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_production_lots_lot_number ON production_lots(lot_number);"
        )

        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_production_lot_selections_lot ON production_lot_selections(production_lot_id);"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_production_lot_selections_group ON production_lot_selections(substitute_group_id);"
        )

        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_production_lot_actual_costing_lot ON production_lot_actual_costing(production_lot_id);"
        )

        # ===== TRIGGERS FOR AUTO-UPDATE TIMESTAMPS =====
        print("Creating update timestamp triggers...")

        cur.execute(
            """
            CREATE OR REPLACE FUNCTION update_updated_at_column()
            RETURNS TRIGGER AS $$
            BEGIN
                NEW.updated_at = CURRENT_TIMESTAMP;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
        """
        )

        # Apply triggers to tables with updated_at columns
        tables_with_updated_at = [
            "processes",
            "subprocesses",
            "variant_usage",
            "cost_items",
            "process_timing",
            "conditional_flags",
            "profitability",
            "substitute_groups",
            "variant_supplier_pricing",
            "process_worst_case_costing",
            "production_lot_selections",
        ]

        for table in tables_with_updated_at:
            cur.execute(
                f"""
                DROP TRIGGER IF EXISTS update_{table}_updated_at ON {table};
                CREATE TRIGGER update_{table}_updated_at
                BEFORE UPDATE ON {table}
                FOR EACH ROW
                EXECUTE FUNCTION update_updated_at_column();
            """
            )

        conn.commit()
        print("✅ Universal Process Framework migration completed successfully!")
        print("📊 Created 15 tables with comprehensive indexes and triggers")
        print("🔒 All foreign key constraints and data integrity checks in place")
        print("⚡ Performance indexes optimized for common query patterns")


def downgrade():
    """
    Drops all Universal Process Framework tables and related objects.
    WARNING: This is a destructive operation and will result in data loss.
    """
    with get_conn() as (conn, cur):
        print(
            "WARNING: Starting downgrade - this will DELETE all process framework data!"
        )

        # Drop tables in reverse dependency order
        print("Dropping tables...")

        cur.execute("DROP TABLE IF EXISTS production_lot_actual_costing CASCADE;")
        cur.execute("DROP TABLE IF EXISTS production_lot_selections CASCADE;")
        cur.execute("DROP TABLE IF EXISTS production_lots CASCADE;")
        cur.execute("DROP TABLE IF EXISTS process_worst_case_costing CASCADE;")
        cur.execute("DROP TABLE IF EXISTS variant_supplier_pricing CASCADE;")
        cur.execute("DROP TABLE IF EXISTS substitute_groups CASCADE;")
        cur.execute("DROP TABLE IF EXISTS profitability CASCADE;")
        cur.execute("DROP TABLE IF EXISTS conditional_flags CASCADE;")
        cur.execute("DROP TABLE IF EXISTS process_timing CASCADE;")
        cur.execute("DROP TABLE IF EXISTS additional_costs CASCADE;")
        cur.execute("DROP TABLE IF EXISTS cost_items CASCADE;")
        cur.execute("DROP TABLE IF EXISTS variant_usage CASCADE;")
        cur.execute("DROP TABLE IF EXISTS process_subprocesses CASCADE;")
        cur.execute("DROP TABLE IF EXISTS subprocesses CASCADE;")
        cur.execute("DROP TABLE IF EXISTS processes CASCADE;")

        # Drop the update function
        cur.execute("DROP FUNCTION IF EXISTS update_updated_at_column() CASCADE;")

        conn.commit()
        print(
            "✅ Downgrade complete: All process framework tables and triggers removed."
        )


if __name__ == "__main__":
    import sys
    from database import init_app

    class MockApp:
        def __init__(self):
            self.config = {
                "DB_HOST": os.getenv("DB_HOST", "127.0.0.1"),
                "DB_NAME": os.getenv("DB_NAME", "testuser"),
                "DB_USER": os.getenv("DB_USER", "postgres"),
                "DB_PASS": os.getenv("DB_PASS", "abcd"),
                "TESTING": True,
            }
            self.logger = type(
                "obj",
                (object,),
                {"info": print, "warning": print, "error": print, "critical": print},
            )()

        def get(self, key, default=None):
            return self.config.get(key, default)

    if len(sys.argv) > 1 and sys.argv[1] == "downgrade":
        response = input(
            "⚠️  WARNING: This will DELETE all process framework data. Type 'YES' to confirm: "
        )
        if response == "YES":
            init_app(MockApp())
            downgrade()
        else:
            print("Downgrade cancelled.")
    else:
        init_app(MockApp())
        upgrade()
