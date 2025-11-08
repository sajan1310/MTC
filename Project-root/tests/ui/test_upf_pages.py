import pytest
import database
import psycopg2.extras
import uuid


def test_upf_production_lots_page(authenticated_client):
    resp = authenticated_client.get("/upf/production-lots")
    assert resp.status_code == 200
    # Basic smoke checks for expected content and asset references
    html = resp.data.decode("utf-8", errors="ignore")
    assert "Production Lots" in html or "🏭 Production Lots" in html
    assert "lots-table" in html  # table container id
    # Ensure the page loads the production lots JS (from template)
    assert "js/production_lots.js" in html


def test_upf_production_lot_detail_page(authenticated_client):
    """Smoke test: production lot detail page renders with proper alert integration."""
    # Create a minimal lot for testing using same logic as inventory alert tests
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        conn,
        cur,
    ):
        # Copy existing process if available, otherwise skip test
        cur.execute("SELECT id FROM processes LIMIT 1")
        existing = cur.fetchone()
        if not existing:
            pytest.skip("No processes available for testing")

        process_id = existing["id"] if isinstance(existing, dict) else existing[0]

        # Insert production lot with unique lot number (use migration_add_upf_tables.py schema)
        unique_lot_number = f"TEST-LOT-DETAIL-{uuid.uuid4().hex[:8]}"
        cur.execute(
            "INSERT INTO production_lots (process_id, lot_number, quantity, status, created_by) VALUES (%s,%s,%s,%s,%s) RETURNING id",
            (process_id, unique_lot_number, 10, "Planning", 1),
        )
        row = cur.fetchone()
        lot_id = row["id"] if isinstance(row, dict) else row[0]
        conn.commit()

    # Test detail page render
    resp = authenticated_client.get(f"/upf/production-lot/{lot_id}")
    assert resp.status_code == 200
    html = resp.data.decode("utf-8", errors="ignore")

    # Verify key elements present
    assert "Production Lot" in html or "🏭 Production Lot" in html
    assert "Inventory Alerts" in html
    assert "critical-alert-banner" in html  # Banner element
    assert "finalize-btn" in html  # Finalize button
    assert "alerts-table" in html  # Alerts table
    assert "bulk-acknowledge-btn" in html  # Bulk action button

    # Verify static assets loaded
    assert "inventory_alerts.css" in html
    assert "production_lot_alerts.js" in html
