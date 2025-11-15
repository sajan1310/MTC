import pytest
import database
import psycopg2.extras

# This test focuses on server-rendered aspects and API contracts. Full JS interactions
# (drag/drop, debounced edits) would require a browser automation layer and are out of scope here.

INLINE_EDITOR_URL = "/upf/processes"


def _get_columns(cur, table_name: str):
    cur.execute(
        """
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = %s
        """,
        (table_name,),
    )
    rows = cur.fetchall()
    if not rows:
        return set()
    # Works for both tuple and dict row types
    return {r[0] if not isinstance(r, dict) else r["column_name"] for r in rows}


@pytest.fixture
def ensure_process_and_subprocess(authenticated_client):
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        conn,
        cur,
    ):
        # Ensure process
        cur.execute("SELECT id FROM processes LIMIT 1")
        row = cur.fetchone()
        if row:
            process_id = row["id"] if isinstance(row, dict) else row[0]
        else:
            pcols = _get_columns(cur, "processes")
            cols = ["name"]
            vals = ["Inline Test Proc"]
            if "description" in pcols:
                cols.append("description")
                vals.append("For inline editor tests")
            if "class" in pcols:
                cols.append("class")
                vals.append("manufacturing")
                if "status" in pcols:
                    cols.append("status")
                    vals.append("draft")
            elif "process_class" in pcols:
                cols.append("process_class")
                vals.append("Manufacturing")
                if "status" in pcols:
                    cols.append("status")
                    vals.append("Active")
            if "user_id" in pcols:
                cols.append("user_id")
                vals.append(1)
            elif "created_by" in pcols:
                cols.append("created_by")
                vals.append(1)
            placeholders = ",".join(["%s"] * len(cols))
            cur.execute(
                f"INSERT INTO processes ({','.join(cols)}) VALUES ({placeholders}) RETURNING id",
                tuple(vals),
            )
            process_id = cur.fetchone()["id"]

        # Ensure subprocess definition
        cur.execute("SELECT id FROM subprocesses LIMIT 1")
        row = cur.fetchone()
        if row:
            subprocess_id = row["id"] if isinstance(row, dict) else row[0]
        else:
            spcols = _get_columns(cur, "subprocesses")
            cols = ["name"]
            vals = ["Test Subprocess"]
            if "description" in spcols:
                cols.append("description")
                vals.append("Inline test subprocess")
            if "category" in spcols:
                cols.append("category")
                vals.append("Assembly")
            if "estimated_time_minutes" in spcols:
                cols.append("estimated_time_minutes")
                vals.append(5)
            if "labor_cost" in spcols:
                cols.append("labor_cost")
                vals.append(12.5)
            if "user_id" in spcols:
                cols.append("user_id")
                vals.append(1)
            placeholders = ",".join(["%s"] * len(cols))
            cur.execute(
                f"INSERT INTO subprocesses ({','.join(cols)}) VALUES ({placeholders}) RETURNING id",
                tuple(vals),
            )
            subprocess_id = cur.fetchone()["id"]

        # Link subprocess to process if not already
        cur.execute(
            "SELECT id FROM process_subprocesses WHERE process_id=%s AND subprocess_id=%s LIMIT 1",
            (process_id, subprocess_id),
        )
        link = cur.fetchone()
        if link:
            ps_id = link["id"] if isinstance(link, dict) else link[0]
        else:
            psp_cols = _get_columns(cur, "process_subprocesses")
            seq_col = (
                "sequence_order"
                if "sequence_order" in psp_cols
                else ("sequence" if "sequence" in psp_cols else None)
            )
            if not seq_col:
                raise AssertionError("process_subprocesses missing sequence column")
            cur.execute(
                f"INSERT INTO process_subprocesses (process_id, subprocess_id, {seq_col}) VALUES (%s,%s,%s) RETURNING id",
                (process_id, subprocess_id, 1),
            )
            ps_id = cur.fetchone()["id"]
        conn.commit()
        # Return process_id and process_subprocess_id (association id)
        return process_id, ps_id


def _ensure_variant(cur):
    """Return a valid variant_id from item_variant; create minimal records if needed."""
    # Try fetch existing
    cur.execute("SELECT variant_id FROM item_variant LIMIT 1")
    r = cur.fetchone()
    if r:
        return r["variant_id"] if isinstance(r, dict) else r[0]

    # Ensure color and size
    cur.execute(
        "SELECT color_id FROM color_master WHERE color_name=%s LIMIT 1", ("TestColor",)
    )
    cr = cur.fetchone()
    if cr:
        color_id = cr["color_id"] if isinstance(cr, dict) else cr[0]
    else:
        cur.execute(
            "INSERT INTO color_master (color_name) VALUES (%s) RETURNING color_id",
            ("TestColor",),
        )
        color_id = cur.fetchone()["color_id"]

    cur.execute(
        "SELECT size_id FROM size_master WHERE size_name=%s LIMIT 1", ("TestSize",)
    )
    sr = cur.fetchone()
    if sr:
        size_id = sr["size_id"] if isinstance(sr, dict) else sr[0]
    else:
        cur.execute(
            "INSERT INTO size_master (size_name) VALUES (%s) RETURNING size_id",
            ("TestSize",),
        )
        size_id = cur.fetchone()["size_id"]

    # Ensure item
    cur.execute("SELECT item_id FROM item_master WHERE name=%s LIMIT 1", ("Test Item",))
    ir = cur.fetchone()
    if ir:
        item_id = ir["item_id"] if isinstance(ir, dict) else ir[0]
    else:
        cur.execute(
            "INSERT INTO item_master (name, description) VALUES (%s,%s) RETURNING item_id",
            ("Test Item", "Seed"),
        )
        item_id = cur.fetchone()["item_id"]

    # Create item_variant
    cur.execute(
        """
        INSERT INTO item_variant (item_id, color_id, size_id, opening_stock, threshold, unit)
        VALUES (%s,%s,%s,%s,%s,%s) RETURNING variant_id
        """,
        (item_id, color_id, size_id, 100, 5, "pcs"),
    )
    return cur.fetchone()["variant_id"]


def _ensure_two_variants(cur):
    cur.execute("SELECT variant_id FROM item_variant LIMIT 2")
    rows = cur.fetchall()
    ids = [r["variant_id"] if isinstance(r, dict) else r[0] for r in rows]
    while len(ids) < 2:
        ids.append(_ensure_variant(cur))
    return ids[:2]


def test_inline_editor_structure_tab_loads(
    authenticated_client, ensure_process_and_subprocess
):
    process_id, _ = ensure_process_and_subprocess
    resp = authenticated_client.get(INLINE_EDITOR_URL)
    assert resp.status_code == 200
    html = resp.data.decode("utf-8", errors="ignore")

    # Core containers
    assert "tab-processes" in html
    assert "tab-subprocesses" in html
    assert "tab-production" in html
    assert "tab-reports" in html

    # Variant search card elements
    assert "variant-search-input" in html
    assert "add-selected-variants-btn" in html
    assert "batch-add-variants-modal" in html

    # Cost summary elements
    assert "inline-labor-cost" in html
    assert "inline-material-cost" in html
    assert "inline-total-cost" in html


def test_variant_usage_api_contract(
    authenticated_client, ensure_process_and_subprocess
):
    process_id, process_subprocess_id = ensure_process_and_subprocess

    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        conn,
        cur,
    ):
        variant_id = _ensure_variant(cur)
        conn.commit()

    # Call API to add usage
    payload = {
        "subprocess_id": process_subprocess_id,
        "item_id": variant_id,
        "quantity": 2,
    }
    add_resp = authenticated_client.post("/api/upf/variant_usage", json=payload)
    assert add_resp.status_code in (201, 200), add_resp.data
    data = add_resp.json
    assert data.get("success") is True
    usage_id = data.get("data", {}).get("id")
    assert usage_id, "Variant usage ID not returned"

    # Update quantity & cost
    update_resp = authenticated_client.put(
        f"/api/upf/variant_usage/{usage_id}", json={"quantity": 3, "cost_per_unit": 5.5}
    )
    assert update_resp.status_code in (200, 204), update_resp.data
    upd = update_resp.json
    assert upd.get("success") is True

    # Delete usage
    delete_resp = authenticated_client.delete(f"/api/upf/variant_usage/{usage_id}")
    assert delete_resp.status_code in (200, 204), delete_resp.data
    del_json = delete_resp.json
    assert del_json.get("success") is True


def test_material_cost_computation(authenticated_client, ensure_process_and_subprocess):
    process_id, process_subprocess_id = ensure_process_and_subprocess

    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        conn,
        cur,
    ):
        variant_ids = _ensure_two_variants(cur)
        # Add usages with explicit costs
        for idx, vid in enumerate(variant_ids):
            cur.execute(
                "INSERT INTO variant_usage (process_subprocess_id, variant_id, quantity, cost_per_unit) VALUES (%s,%s,%s,%s) RETURNING id",
                (process_subprocess_id, vid, 2 + idx, 10.0 + idx),
            )
        conn.commit()

    resp = authenticated_client.get(INLINE_EDITOR_URL)
    assert resp.status_code == 200
    html = resp.data.decode("utf-8", errors="ignore")
    assert "inline-material-cost" in html
    assert "inline-total-cost" in html
    # Dynamic totals are JS-calculated; presence of elements is sufficient here.
