import os
import sys

# Add project root to the Python path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from database import get_conn


def upgrade():
    with get_conn() as (conn, cur):
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS password_reset_tokens (
                token_id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
                token TEXT NOT NULL UNIQUE,
                expires_at TIMESTAMPTZ NOT NULL,
                used BOOLEAN NOT NULL DEFAULT FALSE,
                used_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id);
            CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires ON password_reset_tokens(expires_at);
            """
        )
        conn.commit()
        print("Upgrade complete: password_reset_tokens table created.")


def downgrade():
    with get_conn() as (conn, cur):
        cur.execute("DROP TABLE IF EXISTS password_reset_tokens;")
        conn.commit()
        print("Downgrade complete: password_reset_tokens table dropped.")
