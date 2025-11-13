from pathlib import Path
import importlib.util
import psycopg2.extras

# Load 'database' module from the project root explicitly to avoid unresolved import
project_root = Path(r'c:\Users\erkar\OneDrive\Desktop\MTC\Project-root')
db_path = project_root / 'database.py'
spec = importlib.util.spec_from_file_location("database", str(db_path))
database = importlib.util.module_from_spec(spec)
spec.loader.exec_module(database)

with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (conn, cur):
    cur.execute("SELECT column_name FROM information_schema.columns WHERE table_name='process_subprocesses' ORDER BY ordinal_position")
    columns = [row['column_name'] for row in cur.fetchall()]
    print("process_subprocesses columns:", columns)
