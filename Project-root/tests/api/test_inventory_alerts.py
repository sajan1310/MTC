"""Integration tests for Inventory Alert & Procurement endpoints.

Focus:
* Lot alert summary retrieval
* Bulk acknowledgment workflow
* Finalize blocking on CRITICAL alerts

Schema Variants Handled:
The project contains multiple migrations defining slightly different column
names for process and production lot tables (e.g. processes.class vs
processes.process_class; production_lots.user_id vs production_lots.created_by;
production_lots.status with capitalized values). These tests dynamically
introspect the actual columns present to remain robust across both variants.
"""

import uuid
from typing import List
import psycopg2.extras
import database

ALERT_BULK_ENDPOINT = "/api/upf/inventory-alerts/lot/{lot_id}/acknowledge-bulk"
ALERT_SUMMARY_ENDPOINT = "/api/upf/inventory-alerts/lot/{lot_id}"
FINALIZE_ENDPOINT = "/api/upf/production-lots/{lot_id}/finalize"


def _detect_column(cur, table: str, candidates: List[str]) -> str:
    """Return the first existing column name from candidates for given table."""
    cur.execute(
        """
        SELECT column_name FROM information_schema.columns
        WHERE table_name = %s
        """,
        (table,),
    )
    rows = cur.fetchall() or []
    existing = {r[0] if not isinstance(r, dict) else r.get("column_name") for r in rows}
    for c in candidates:
        if c in existing:
            return c
    raise AssertionError(f"None of {candidates} found in {table} columns={existing}")


def _seed_lot_with_alerts(severities: List[str]) -> int:
    """Create a minimal process, production lot and seed alerts of provided severities.
    Returns lot_id.
    """
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        conn,
        cur,
    ):
        # Determine column variants
        process_class_col = _detect_column(cur, "processes", ["process_class", "class"])
        process_user_col = _detect_column(cur, "processes", ["created_by", "user_id"])
        lot_user_col = _detect_column(cur, "production_lots", ["created_by", "user_id"])
        lot_cost_col = _detect_column(
            cur, "production_lots", ["total_cost", "worst_case_estimated_cost"]
        )

        # Insert process (handle differing check constraints on process_class)
        # Strategy: discover allowed values from table CHECK constraints first, then try
        # to copy an existing process, finally try inserting with a discovered value.
        process_id = None
        unique_sfx = uuid.uuid4().hex[:8]

        # Discover allowed values from table CHECK constraints (Postgres)
        proc_class_candidates = []
        try:
            cur.execute(
                """
                SELECT pg_get_constraintdef(c.oid) as def
                FROM pg_constraint c
                JOIN pg_class t ON c.conrelid = t.oid
                WHERE t.relname = 'processes' AND c.contype = 'c';
                """
            )
            defs = [
                r[0] if not isinstance(r, dict) else r.get("def")
                for r in cur.fetchall()
            ]
            for d in defs:
                if not d:
                    continue
                # Look for patterns like: CHECK (process_class IN ('A','B')) or CHECK (class IN ('a','b'))
                import re

                m = re.search(r"\b(process_class|class)\b\s+IN\s*\(([^)]+)\)", d)
                if m:
                    vals = m.group(2)
                    # Split and clean quoted values
                    candidates = [v.strip().strip("'\"") for v in vals.split(",")]
                    proc_class_candidates.extend(candidates)
        except Exception:
            pass

        # Fallback known candidates (cover both capitalized and lowercase variants)
        fallback = [
            "Manufacturing",
            "manufacturing",
            "Assembly",
            "assembly",
            "Packaging",
            "packaging",
            "Maintenance",
            "maintenance",
            "Service",
            "service",
            "Procurement",
            "procurement",
        ]

        # Deduplicate while preserving order
        seen = set()
        proc_class_candidates = [
            c
            for c in (proc_class_candidates + fallback)
            if not (c in seen or seen.add(c))
        ]

        # Attempt to copy an existing process (simplest fallback - conftest should have seeded one)
        try:
            cur.execute("SELECT id FROM processes LIMIT 1")
            existing = cur.fetchone()
            if existing:
                # Copy that row's values for required columns to create a new distinct process name
                cur.execute(
                    f"SELECT {process_class_col}, status FROM processes LIMIT 1"
                )
                src = cur.fetchone()
                src_class = (
                    src[0] if not isinstance(src, dict) else src.get(process_class_col)
                )
                src_status = src[1] if not isinstance(src, dict) else src.get("status")
                try:
                    cur.execute(
                        f"""
                        INSERT INTO processes (name, description, {process_class_col}, status, {process_user_col})
                        VALUES (%s,%s,%s,%s,1) RETURNING id
                        """,
                        (
                            f"Test Process {unique_sfx}",
                            "Proc for alerts",
                            src_class,
                            src_status,
                        ),
                    )
                    row = cur.fetchone()
                    if row:
                        process_id = (
                            row[0] if not isinstance(row, dict) else row.get("id")
                        )
                        conn.commit()
                except Exception:
                    conn.rollback()
        except Exception:
            pass

        # If still not inserted, try inserting using discovered candidate class values
        if not process_id:
            # Try a matrix of class candidates and status candidates for broader compatibility
            status_candidates = []
            try:
                # Prefer using an existing row's status if available
                cur.execute("SELECT status FROM processes LIMIT 1")
                srow = cur.fetchone()
                if srow:
                    status_candidates.append(
                        srow[0] if not isinstance(srow, dict) else srow.get("status")
                    )
            except Exception:
                pass
            # Add common fallbacks
            for s in ["draft", "Draft", "active", "Active", "planning", "Planning"]:
                if s not in status_candidates:
                    status_candidates.append(s)

            inserted = False
            for candidate in proc_class_candidates:
                for st in status_candidates:
                    try:
                        cur.execute(
                            f"""
                            INSERT INTO processes (name, description, {process_class_col}, status, {process_user_col})
                            VALUES (%s,%s,%s,%s,1) RETURNING id
                            """,
                            (
                                f"Test Process {unique_sfx}",
                                "Proc for alerts",
                                candidate,
                                st,
                            ),
                        )
                        row = cur.fetchone()
                        if row:
                            process_id = (
                                row[0] if not isinstance(row, dict) else row.get("id")
                            )
                            conn.commit()
                            inserted = True
                            break
                    except Exception:
                        conn.rollback()
                        continue
                if inserted:
                    break

        assert process_id is not None, (
            f"Failed to insert process; tried classes: {proc_class_candidates}"
        )

        # Insert production lot (status value may differ across schemas; use 'Planning')
        cur.execute(
            f"""
            INSERT INTO production_lots (process_id, lot_number, quantity, status, {lot_cost_col}, {lot_user_col})
            VALUES (%s,%s,%s,%s,%s,1) RETURNING id
            """,
            (process_id, f"LOT-ALERT-{unique_sfx}", 10, "Planning", 0),
        )
        row = cur.fetchone()
        assert row is not None, "Failed to insert lot"
        lot_id = row["id"] if isinstance(row, dict) else row[0]

        # Minimal variant dependencies
        cur.execute(
            "INSERT INTO item_master (name) VALUES (%s) ON CONFLICT DO NOTHING RETURNING item_id",
            ("Test Item",),
        )
        row = cur.fetchone()
        if not row:
            cur.execute(
                "SELECT item_id FROM item_master WHERE name = %s", ("Test Item",)
            )
            row = cur.fetchone()
        assert row is not None, "Failed to insert/retrieve item_master"
        item_id = row["item_id"] if isinstance(row, dict) else row[0]

        cur.execute(
            "INSERT INTO color_master (color_name) VALUES (%s) ON CONFLICT DO NOTHING RETURNING color_id",
            ("Red",),
        )
        row = cur.fetchone()
        if not row:
            cur.execute(
                "SELECT color_id FROM color_master WHERE color_name = %s", ("Red",)
            )
            row = cur.fetchone()
        assert row is not None, "Failed to insert/retrieve color_master"
        color_id = row["color_id"] if isinstance(row, dict) else row[0]

        cur.execute(
            "INSERT INTO size_master (size_name) VALUES (%s) ON CONFLICT DO NOTHING RETURNING size_id",
            ("M",),
        )
        row = cur.fetchone()
        if not row:
            cur.execute("SELECT size_id FROM size_master WHERE size_name = %s", ("M",))
            row = cur.fetchone()
        assert row is not None, "Failed to insert/retrieve size_master"
        size_id = row["size_id"] if isinstance(row, dict) else row[0]
        # Insert or fetch the same variant to avoid unique conflicts across tests
        cur.execute(
            "INSERT INTO item_variant (item_id, color_id, size_id, opening_stock, threshold, unit) VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING RETURNING variant_id",
            (item_id, color_id, size_id, 5, 2, "pcs"),
        )
        row = cur.fetchone()
        if not row:
            cur.execute(
                "SELECT variant_id FROM item_variant WHERE item_id=%s AND color_id=%s AND size_id=%s",
                (item_id, color_id, size_id),
            )
            row = cur.fetchone()
        assert row is not None, "Failed to insert/retrieve item_variant"
        variant_id = row["variant_id"] if isinstance(row, dict) else row[0]

        # Seed alerts
        for sev in severities:
            cur.execute(
                """
                INSERT INTO production_lot_inventory_alerts (
                    production_lot_id, variant_id, alert_severity,
                    current_stock_quantity, required_quantity, shortfall_quantity,
                    suggested_procurement_quantity, user_acknowledged
                ) VALUES (%s,%s,%s,%s,%s,%s,%s,FALSE)
                """,
                (lot_id, variant_id, sev, 5, 15, 10, 10),
            )
        conn.commit()
    return lot_id


def test_alert_summary_endpoint(authenticated_client):
    lot_id = _seed_lot_with_alerts(["CRITICAL", "HIGH", "LOW"])
    resp = authenticated_client.get(ALERT_SUMMARY_ENDPOINT.format(lot_id=lot_id))
    assert resp.status_code == 200
    data = resp.get_json()["data"]
    assert data["lot_id"] == lot_id
    # Ensure counts present
    summary = data["alerts_summary"]
    assert summary["CRITICAL"] == 1
    assert summary["HIGH"] == 1
    assert summary["LOW"] == 1
    assert data["total_alerts"] == 3


def test_bulk_acknowledge_keeps_pending_status(authenticated_client):
    lot_id = _seed_lot_with_alerts(["CRITICAL", "HIGH"])  # CRITICAL remains
    payload = {
        "acknowledgments": [
            {
                "alert_id": a["alert_id"],
                "user_action": "PROCEED",
                "action_notes": "Approved",
            }
            for a in _fetch_alerts_for_lot(lot_id)
        ]
    }
    resp = authenticated_client.post(
        ALERT_BULK_ENDPOINT.format(lot_id=lot_id), json=payload
    )
    assert resp.status_code == 200
    data = resp.get_json()["data"]
    # Status should still reflect CRITICAL presence after acknowledgment
    assert data["updated_lot_status"] == "PENDING_PROCUREMENT"
    assert data["acknowledged_count"] == 2


def test_finalize_blocking_on_critical(authenticated_client):
    lot_id = _seed_lot_with_alerts(["CRITICAL", "HIGH"])  # CRITICAL present
    resp = authenticated_client.put(FINALIZE_ENDPOINT.format(lot_id=lot_id))
    # Expect conflict due to unacknowledged CRITICAL
    assert resp.status_code == 409
    err = resp.get_json()["error"]
    assert err["code"] == "conflict"
    assert "Critical inventory alerts" in err["message"]


# Helper to fetch alerts from DB for building acknowledgments


def _fetch_alerts_for_lot(lot_id: int):
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        conn,
        cur,
    ):
        cur.execute(
            "SELECT alert_id, alert_severity FROM production_lot_inventory_alerts WHERE production_lot_id = %s",
            (lot_id,),
        )
        return [dict(r) for r in cur.fetchall()]
