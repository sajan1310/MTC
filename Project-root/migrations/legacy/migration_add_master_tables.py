import os
import sys

from dotenv import load_dotenv

# Add project root to the Python path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from database import get_conn

load_dotenv()


def upgrade():
    """
    Creates master tables for models and variations, migrates existing data,
    and adds foreign key constraints to the item_master table.
    """
    with get_conn() as (conn, cur):
        # Create master tables
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS model_master (
                model_id SERIAL PRIMARY KEY,
                model_name VARCHAR(255) UNIQUE NOT NULL
            );
        """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS variation_master (
                variation_id SERIAL PRIMARY KEY,
                variation_name VARCHAR(255) UNIQUE NOT NULL
            );
        """
        )

        # Populate master tables
        cur.execute(
            """
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='item_master' AND column_name='model') THEN
                    INSERT INTO model_master (model_name)
                    SELECT DISTINCT model FROM item_master WHERE model IS NOT NULL AND model != ''
                    ON CONFLICT (model_name) DO NOTHING;
                END IF;
            END$$;
        """
        )
        cur.execute(
            """
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='item_master' AND column_name='variation') THEN
                    INSERT INTO variation_master (variation_name)
                    SELECT DISTINCT variation FROM item_master WHERE variation IS NOT NULL AND variation != ''
                    ON CONFLICT (variation_name) DO NOTHING;
                END IF;
            END$$;
        """
        )

        # Add foreign key columns
        cur.execute(
            "ALTER TABLE item_master ADD COLUMN IF NOT EXISTS model_id INTEGER REFERENCES model_master(model_id);"
        )
        cur.execute(
            "ALTER TABLE item_master ADD COLUMN IF NOT EXISTS variation_id INTEGER REFERENCES variation_master(variation_id);"
        )

        # Update foreign key references
        cur.execute(
            """
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='item_master' AND column_name='model') THEN
                    UPDATE item_master
                    SET model_id = m.model_id
                    FROM model_master m
                    WHERE item_master.model = m.model_name;
                END IF;
            END$$;
        """
        )
        cur.execute(
            """
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='item_master' AND column_name='variation') THEN
                    UPDATE item_master
                    SET variation_id = v.variation_id
                    FROM variation_master v
                    WHERE item_master.variation = v.variation_name;
                END IF;
            END$$;
        """
        )

        conn.commit()
        print("Upgrade complete: Master tables created and data migrated.")


def downgrade():
    """
    Removes the foreign key constraints and master tables.
    Note: This is a destructive operation and will result in data loss.
    """
    with get_conn() as (conn, cur):
        # Remove foreign key columns
        cur.execute("ALTER TABLE item_master DROP COLUMN IF EXISTS model_id;")
        cur.execute("ALTER TABLE item_master DROP COLUMN IF EXISTS variation_id;")

        # Drop master tables
        cur.execute("DROP TABLE IF EXISTS model_master;")
        cur.execute("DROP TABLE IF EXISTS variation_master;")

        conn.commit()
        print("Downgrade complete: Master tables and foreign keys removed.")
