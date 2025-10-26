import sys
import os
from dotenv import load_dotenv

# Add project root to the Python path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from database import get_conn

load_dotenv()

def get_constraint_name(cur, table_name, column_name):
    """Helper to find the name of a unique constraint on a column."""
    cur.execute("""
        SELECT tc.constraint_name
        FROM information_schema.table_constraints AS tc 
        JOIN information_schema.key_column_usage AS kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'UNIQUE'
          AND tc.table_name = %s
          AND kcu.column_name = %s
          AND tc.table_schema = 'public';
    """, (table_name, column_name))
    result = cur.fetchone()
    return result[0] if result else None

def upgrade():
    """
    Removes the unique constraint from the 'model_name' column in 'model_master'.
    """
    with get_conn() as (conn, cur):
        constraint_name = get_constraint_name(cur, 'model_master', 'model_name')
        if constraint_name:
            cur.execute(f"ALTER TABLE model_master DROP CONSTRAINT {constraint_name};")
            print(f"Upgrade complete: Dropped unique constraint '{constraint_name}' from model_master.")
        else:
            print("No unique constraint found on model_master(model_name). No action needed.")
        conn.commit()

def downgrade():
    """
    Re-adds the unique constraint to the 'model_name' column in 'model_master'.
    """
    with get_conn() as (conn, cur):
        cur.execute("ALTER TABLE model_master ADD CONSTRAINT model_master_model_name_key UNIQUE (model_name);")
        print("Downgrade complete: Re-added unique constraint to model_master(model_name).")
        conn.commit()
