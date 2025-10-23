import os
import psycopg2
from dotenv import load_dotenv

# Load environment variables from a .env file
load_dotenv()

def run_migration():
    conn = None
    try:
        conn = psycopg2.connect(
            host=os.environ.get('DB_HOST', '127.0.0.1'),
            database=os.environ.get('DB_NAME', 'MTC'),
            user=os.environ.get('DB_USER', 'postgres'),
            password=os.environ.get('DB_PASS')
        )
        cur = conn.cursor()

        # Drop the existing constraint if it exists, to make the script re-runnable
        cur.execute("ALTER TABLE item_master DROP CONSTRAINT IF EXISTS unique_item_definition;")

        # Add the new composite unique constraint.
        # Using COALESCE to treat NULLs as empty strings for the purpose of the constraint.
        cur.execute("""
            CREATE UNIQUE INDEX unique_item_definition 
            ON item_master (name, COALESCE(model, ''), COALESCE(variation, ''), COALESCE(description, ''));
        """)
        
        conn.commit()
        print("Migration successful: unique_item_definition constraint created.")

    except Exception as e:
        print(f"An error occurred: {e}")
        if conn:
            conn.rollback()
    finally:
        if conn:
            conn.close()

if __name__ == '__main__':
    run_migration()
