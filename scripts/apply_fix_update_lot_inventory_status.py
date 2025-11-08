import os
import psycopg2

DB_NAME = os.getenv("DB_NAME", "MTC")
DB_USER = os.getenv("DB_USER", "postgres")
DB_HOST = os.getenv("DB_HOST", "127.0.0.1")
DB_PORT = os.getenv("DB_PORT", "5432")
DB_PASSWORD = os.getenv("DB_PASS", "abcd")

SQL_PATH = os.path.abspath(
    os.path.join(
        os.path.dirname(__file__),
        "..",
        "migrations",
        "fix_update_lot_inventory_status_function.sql",
    )
)


def main():
    with open(SQL_PATH, "r", encoding="utf-8") as f:
        sql = f.read()
    conn = psycopg2.connect(
        dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD, host=DB_HOST, port=DB_PORT
    )
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(sql)
        print("Applied migration: fix_update_lot_inventory_status_function.sql")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
