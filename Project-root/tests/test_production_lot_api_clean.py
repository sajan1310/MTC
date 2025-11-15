from app.services.production_service import ProductionService
import uuid
import database
import psycopg2.extras


def _get_any_process_id():
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        conn,
        cur,
    ):
        cur.execute("SELECT id FROM processes LIMIT 1")
        row = cur.fetchone()
        return int(row["id"]) if row else None


def _create_subprocess_for_process(process_id):
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        conn,
        cur,
    ):
        cur.execute(
            "SELECT column_name FROM information_schema.columns WHERE table_name='subprocesses'"
        )
        sub_cols = {r["column_name"] for r in cur.fetchall()}

        unique_name = f"Test Subprocess {uuid.uuid4()}"
        fields = ["name", "description"]
        placeholders = ["%s", "%s"]
        params = [unique_name, "For variant options test"]

        if "user_id" in sub_cols:
            fields.append("user_id")
            placeholders.append("%s")
            params.append(1)

        sql = f"INSERT INTO subprocesses ({', '.join(fields)}) VALUES ({', '.join(placeholders)}) RETURNING id"
        cur.execute(sql, tuple(params))
        sp_id = int(cur.fetchone()["id"])

        cur.execute(
            "SELECT column_name FROM information_schema.columns WHERE table_name='process_subprocesses'"
        )
        ps_cols = {r["column_name"] for r in cur.fetchall()}

        ps_required = ["process_id", "subprocess_id"]
        ps_fields = []
        ps_placeholders = []
        ps_params = []

        for col in ps_required:
            if col in ps_cols:
                ps_fields.append(col)
                ps_placeholders.append("%s")
                ps_params.append(process_id if col == "process_id" else sp_id)

        seq_candidates = [
            "sequence_order",
            "sequence",
            "position",
            "order_index",
            "seq",
        ]
        seq_col = None
        for c in seq_candidates:
            if c in ps_cols:
                seq_col = c
                break
        if seq_col:
            ps_fields.append(seq_col)
            ps_placeholders.append("%s")
            ps_params.append(1)

        if "custom_name" in ps_cols:
            ps_fields.append("custom_name")
            ps_placeholders.append("%s")
            ps_params.append(f"Test SP {uuid.uuid4()}")

        if not ps_fields:
            raise RuntimeError(
                "Cannot determine insertable columns for process_subprocesses table in test DB"
            )

        sql2 = f"INSERT INTO process_subprocesses ({', '.join(ps_fields)}) VALUES ({', '.join(ps_placeholders)}) RETURNING id"
        cur.execute(sql2, tuple(ps_params))
        ps_id = int(cur.fetchone()["id"])

        conn.commit()
        return ps_id


def test_get_production_lot_includes_created_by_username(authenticated_client, app):
    with app.app_context():
        process_id = _get_any_process_id()
        assert process_id is not None

        lot = ProductionService.create_production_lot(
            process_id=process_id,
            user_id=1,
            quantity=1,
            lot_number=f"test-{uuid.uuid4()}",
        )
        lot_id = int(lot.get("id") or lot.get("lot_id") or 0)
        assert lot_id > 0

    resp = authenticated_client.get(f"/api/upf/production-lots/{lot_id}")
    assert resp.status_code == 200
    payload = resp.get_json()
    data = payload.get("data")
    assert data is not None
    assert "created_by_username" in data or "created_by_id" in data


def test_recalculate_endpoint_returns_consistent_shape(authenticated_client, app):
    with app.app_context():
        process_id = _get_any_process_id()
        assert process_id is not None
        lot = ProductionService.create_production_lot(
            process_id=process_id,
            user_id=1,
            quantity=2,
            lot_number=f"test-{uuid.uuid4()}",
        )
        lot_id = int(lot.get("id") or lot.get("lot_id") or 0)

    resp = authenticated_client.get(f"/api/upf/production-lots/{lot_id}/recalculate")
    assert resp.status_code == 200
    payload = resp.get_json().get("data")
    assert payload is not None
    assert "total_cost" in payload
    assert "data" in payload and "total_cost" in payload["data"]
    assert float(payload["total_cost"]) == float(payload["data"]["total_cost"])


def test_variant_options_by_subprocess_returns_expected_shape(authenticated_client, app):
    with app.app_context():
        process_id = _get_any_process_id()
        assert process_id is not None
        ps_id = _create_subprocess_for_process(process_id)

    resp = authenticated_client.get(f"/api/upf/subprocess/{ps_id}/variant-options")
    assert resp.status_code == 200
    data = resp.get_json().get("data")
    assert data is not None
    assert "subprocesses" in data
    subprocesses = data["subprocesses"]
    assert isinstance(subprocesses, list)
    assert len(subprocesses) == 1
    sp = subprocesses[0]
    assert "grouped_variants" in sp
    assert "standalone_variants" in sp
