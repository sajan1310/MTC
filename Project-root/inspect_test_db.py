import os
import psycopg2

host = os.getenv('TEST_DB_HOST', os.getenv('DB_HOST', '127.0.0.1'))
db = os.getenv('TEST_DB_NAME', 'testdb')
user = os.getenv('TEST_DB_USER', os.getenv('DB_USER', 'postgres'))
pw = os.getenv('TEST_DB_PASS', os.getenv('DB_PASS', 'abcd'))

conn = psycopg2.connect(host=host, database='postgres', user=user, password=pw)
conn.autocommit = True
cur = conn.cursor()
cur.execute("SELECT datname FROM pg_database WHERE datname = %s", (db,))
print('exists', cur.fetchone() is not None)
cur.close()
conn.close()
