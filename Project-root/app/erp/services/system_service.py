"""System/health RPC methods, ported from Apps_Script/main.js (testConnection,
getSystemStatus). The Apps Script versions report on the Google Sheet
(spreadsheet id, per-tab row/col counts); here there's a Postgres schema
instead of a spreadsheet, so getSystemStatus reports on that instead.
"""

from __future__ import annotations

from datetime import datetime, timezone

import psycopg2.extras

import database
from ..envelope import build_response
from ..registry import rpc_method

APP_TITLE = "Maharaja Bikes ERP"


@rpc_method("testConnection")
def test_connection():
    try:
        with database.get_conn() as (_conn, cur):
            cur.execute("SELECT 1")
            cur.fetchone()
        return build_response(
            True,
            {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "appTitle": APP_TITLE,
                "dbAvailable": True,
            },
            "Connection successful",
        )
    except Exception as exc:  # noqa: BLE001
        return build_response(False, None, f"Connection test failed: {exc}")


@rpc_method("getSystemStatus")
def get_system_status():
    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (
            _conn,
            cur,
        ):
            cur.execute(
                """
                SELECT table_name
                FROM information_schema.tables
                WHERE table_schema = 'erp'
                ORDER BY table_name
                """
            )
            tables = [row["table_name"] for row in cur.fetchall()]
        return build_response(
            True,
            {
                "appTitle": APP_TITLE,
                "environment": "production",
                "schema": "erp",
                "tables": tables,
            },
        )
    except Exception as exc:  # noqa: BLE001
        return build_response(False, None, f"Failed to get system status: {exc}")
