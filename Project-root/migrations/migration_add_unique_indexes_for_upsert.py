"""
Migration: Add UNIQUE indexes for UPSERT operations
Created: 2024-11-01
Purpose: Prepare database for UPSERT-based import system by adding unique indexes
         on conflict columns with WHERE deleted_at IS NULL clause for soft-delete support.

This migration:
1. Creates unique indexes on item_master(name), color_master(color_name), size_master(size_name)
2. Creates covering indexes for performance optimization
3. Ensures indexes exclude soft-deleted records (WHERE deleted_at IS NULL)
4. Adds indexes for frequently filtered columns (category, updated_at, etc.)
"""

from database import get_conn


def upgrade():
    """
    Creates unique indexes required for ON CONFLICT (UPSERT) operations.
    These indexes enable efficient conflict detection and resolution during bulk imports.
    """
    with get_conn() as (conn, cur):
        print("Creating unique indexes for UPSERT operations...")

        # ============================================
        # ITEM_MASTER TABLE INDEXES
        # ============================================

        # Primary unique index for item names (required for UPSERT)
        # Partial index excludes soft-deleted records
        cur.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_item_master_name_unique
            ON item_master(name)
            WHERE deleted_at IS NULL;
        """
        )
        print("✅ Created unique index on item_master(name)")

        # Performance index for category filtering
        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_item_master_category
            ON item_master(category)
            WHERE deleted_at IS NULL;
        """
        )
        print("✅ Created index on item_master(category)")

        # Performance index for updated_at (useful for tracking recent changes)
        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_item_master_updated_at
            ON item_master(updated_at DESC)
            WHERE deleted_at IS NULL;
        """
        )
        print("✅ Created index on item_master(updated_at)")

        # Composite index for model/variation lookups (if these columns exist)
        cur.execute(
            """
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name='item_master' AND column_name='model_id'
                ) THEN
                    CREATE INDEX IF NOT EXISTS idx_item_master_model_variation
                    ON item_master(model_id, variation_id)
                    WHERE deleted_at IS NULL;
                END IF;
            END$$;
        """
        )
        print("✅ Created composite index on item_master(model_id, variation_id)")

        # ============================================
        # COLOR_MASTER TABLE INDEXES
        # ============================================

        # Primary unique index for color names (required for UPSERT)
        cur.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_color_master_name_unique
            ON color_master(color_name)
            WHERE deleted_at IS NULL;
        """
        )
        print("✅ Created unique index on color_master(color_name)")

        # Optional: Index on color_code if it exists
        cur.execute(
            """
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name='color_master' AND column_name='color_code'
                ) THEN
                    CREATE INDEX IF NOT EXISTS idx_color_master_code
                    ON color_master(color_code)
                    WHERE deleted_at IS NULL;
                END IF;
            END$$;
        """
        )
        print("✅ Created index on color_master(color_code) if column exists")

        # ============================================
        # SIZE_MASTER TABLE INDEXES
        # ============================================

        # Primary unique index for size names (required for UPSERT)
        cur.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_size_master_name_unique
            ON size_master(size_name)
            WHERE deleted_at IS NULL;
        """
        )
        print("✅ Created unique index on size_master(size_name)")

        # Performance index for size_code if it exists
        cur.execute(
            """
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name='size_master' AND column_name='size_code'
                ) THEN
                    CREATE UNIQUE INDEX IF NOT EXISTS idx_size_master_code_unique
                    ON size_master(size_code)
                    WHERE deleted_at IS NULL;
                END IF;
            END$$;
        """
        )
        print("✅ Created unique index on size_master(size_code) if column exists")

        # ============================================
        # MODEL_MASTER & VARIATION_MASTER INDEXES
        # ============================================

        # Model master unique index
        cur.execute(
            """
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.tables
                    WHERE table_name='model_master'
                ) THEN
                    CREATE UNIQUE INDEX IF NOT EXISTS idx_model_master_name_unique
                    ON model_master(model_name)
                    WHERE deleted_at IS NULL;
                END IF;
            END$$;
        """
        )
        print("✅ Created unique index on model_master(model_name)")

        # Variation master unique index
        cur.execute(
            """
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.tables
                    WHERE table_name='variation_master'
                ) THEN
                    CREATE UNIQUE INDEX IF NOT EXISTS idx_variation_master_name_unique
                    ON variation_master(variation_name)
                    WHERE deleted_at IS NULL;
                END IF;
            END$$;
        """
        )
        print("✅ Created unique index on variation_master(variation_name)")

        # ============================================
        # ITEM_VARIANT TABLE INDEXES
        # ============================================

        # Composite unique index for item+color+size combinations
        # This prevents duplicate variants and enables UPSERT on variants
        cur.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_item_variant_unique_combo
            ON item_variant(item_id, color_id, size_id)
            WHERE deleted_at IS NULL;
        """
        )
        print("✅ Created unique index on item_variant(item_id, color_id, size_id)")

        # Performance index for stock lookups
        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_item_variant_stock
            ON item_variant(opening_stock)
            WHERE deleted_at IS NULL AND opening_stock < threshold;
        """
        )
        print("✅ Created index on item_variant for low stock queries")

        conn.commit()
        print("\n✅ Migration completed successfully!")
        print("   All unique indexes created for UPSERT operations")
        print("   Partial indexes exclude soft-deleted records")


def downgrade():
    """
    Removes the unique indexes created for UPSERT operations.
    WARNING: This will break UPSERT-based imports if they rely on these indexes.
    """
    with get_conn() as (conn, cur):
        print("Removing UPSERT-related indexes...")

        # Drop all indexes created in upgrade()
        indexes = [
            "idx_item_master_name_unique",
            "idx_item_master_category",
            "idx_item_master_updated_at",
            "idx_item_master_model_variation",
            "idx_color_master_name_unique",
            "idx_color_master_code",
            "idx_size_master_name_unique",
            "idx_size_master_code_unique",
            "idx_model_master_name_unique",
            "idx_variation_master_name_unique",
            "idx_item_variant_unique_combo",
            "idx_item_variant_stock",
        ]

        for index in indexes:
            cur.execute(f"DROP INDEX IF EXISTS {index};")
            print(f"✅ Dropped index {index}")

        conn.commit()
        print("\n✅ Downgrade completed: All UPSERT indexes removed")


if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "downgrade":
        downgrade()
    else:
        upgrade()
