import os
import psycopg2

host = os.getenv("TEST_DB_HOST", os.getenv("DB_HOST", "127.0.0.1"))
db = os.getenv("TEST_DB_NAME", "testdb")
user = os.getenv("TEST_DB_USER", os.getenv("DB_USER", "postgres"))
pw = os.getenv("TEST_DB_PASS", os.getenv("DB_PASS", "abcd"))

conn = psycopg2.connect(host=host, database=db, user=user, password=pw)
cur = conn.cursor()
cur.execute(
    "SELECT column_name FROM information_schema.columns WHERE table_name=%s ORDER BY ordinal_position",
    ("processes",),
)
print(cur.fetchall())
cur.close()
conn.close()
