import database

def up():
    """
    Run the upgrade migration.
    """
    with database.get_conn() as (conn, cur):
        # Add 'notes' and 'status' columns to the purchase_orders table
        cur.execute("""
            ALTER TABLE purchase_orders
            ADD COLUMN IF NOT EXISTS notes TEXT,
            ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'Draft' NOT NULL;
        """)
        
        conn.commit()
    print("Purchase orders table updated with notes and status columns.")

def down():
    """
    Run the downgrade migration.
    """
    with database.get_conn() as (conn, cur):
        # Remove 'notes' and 'status' columns from the purchase_orders table
        cur.execute("""
            ALTER TABLE purchase_orders
            DROP COLUMN IF EXISTS notes,
            DROP COLUMN IF EXISTS status;
        """)
        
        conn.commit()
    print("Purchase orders table reverted.")

if __name__ == '__main__':
    # To run this migration standalone, we need to initialize the database
    # connection pool, which requires a Flask app context.
    from flask import Flask
    from dotenv import load_dotenv
    import os

    # Load environment variables from .env file
    dotenv_path = os.path.join(os.path.dirname(__file__), '.env')
    if os.path.exists(dotenv_path):
        load_dotenv(dotenv_path)
    else:
        # If running from a different directory, you might need to adjust the path
        # For this project, we assume it's in the Project-root
        load_dotenv()

    # Create a minimal Flask app
    app = Flask(__name__)
    
    # The database.init_app function needs the app context to work
    with app.app_context():
        database.init_app(app)
        
        # Simple command-line interface to run migrations
        import sys
        if len(sys.argv) > 1 and sys.argv[1] == 'down':
            down()
        else:
            up()
