import sys
import os
import json
from pathlib import Path

# Ensure project root (Project-root) is on sys.path so `app` package can be imported
base = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(base))

try:
    from app import create_app
    from app.services.production_service import ProductionService
except Exception as e:
    print('IMPORT_ERROR', repr(e))
    raise

app = create_app('testing') if 'testing' in sys.argv else create_app()
# Allow bypassing auth for debug where code checks LOGIN_DISABLED
app.config['LOGIN_DISABLED'] = True
app.config['TESTING'] = True

LOT_ID = int(sys.argv[1]) if len(sys.argv) > 1 else 124

with app.app_context():
    try:
        print('Fetching production lot via ProductionService.get_production_lot(%d)' % LOT_ID)
        lot = ProductionService.get_production_lot(LOT_ID)
        print('LOT_RESULT')
        print(json.dumps(lot or {}, default=str, indent=2))
    except Exception as e:
        print('ERROR fetching lot:', repr(e))

    # Try to run variant_options SQL similar to the API to inspect subprocesses
    try:
        from database import get_conn
        from psycopg2.extras import RealDictCursor

        if not lot:
            print('No lot found; skipping variant options SQL')
        else:
            process_id = lot.get('process_id')
            print('Lot.process_id =', process_id)
            with get_conn() as (conn, cur):
                cur = conn.cursor(cursor_factory=RealDictCursor)

                # Check column existence helpers
                def _column_exists(table: str, column: str) -> bool:
                    cur.execute(
                        """
                        SELECT 1 FROM information_schema.columns
                        WHERE table_schema = current_schema() AND table_name = %s AND column_name = %s
                        """,
                        (table, column),
                    )
                    return bool(cur.fetchone())

                ps_has_deleted = _column_exists('process_subprocesses', 'deleted_at')
                s_has_deleted = _column_exists('subprocesses', 'deleted_at')
                vu_has_deleted = _column_exists('variant_usage', 'deleted_at')

                print('ps_has_deleted=', ps_has_deleted, 's_has_deleted=', s_has_deleted, 'vu_has_deleted=', vu_has_deleted)

                base_subprocess_q = (
                    """
                    SELECT
                        ps.id as process_subprocess_id,
                        ps.id as sequence_order,
                        s.id as subprocess_id,
                        s.name as subprocess_name,
                        ps.custom_name
                    FROM process_subprocesses ps
                    JOIN subprocesses s ON s.id = ps.subprocess_id
                    WHERE ps.process_id = %s
                    """
                )

                if ps_has_deleted:
                    base_subprocess_q += "\n  AND ps.deleted_at IS NULL"
                if s_has_deleted:
                    base_subprocess_q += "\n  AND s.deleted_at IS NULL"

                base_subprocess_q += "\nORDER BY ps.id"

                cur.execute(base_subprocess_q, (process_id,))
                subprocesses = cur.fetchall()
                print('SUBPROCESS_COUNT=', len(subprocesses))
                if subprocesses:
                    print('FIRST_SUBPROCESS=', json.dumps(dict(subprocesses[0]), default=str, indent=2))

                    # For the first subprocess, fetch variants
                    sp = subprocesses[0]
                    base_variants_q = (
                        """
                        SELECT
                            vu.id as usage_id,
                            vu.variant_id,
                            vu.quantity,
                            iv.unit,
                            vu.substitute_group_id,
                            vu.is_alternative,
                            vu.alternative_order,
                            im.name as item_number,
                            im.description,
                            iv.opening_stock,
                            COALESCE((
                                SELECT rate FROM supplier_item_rates sir WHERE sir.item_id = iv.item_id ORDER BY rate ASC LIMIT 1
                            ), 0) as unit_price,
                            iv.item_id
                        FROM variant_usage vu
                        JOIN item_variant iv ON iv.variant_id = vu.variant_id
                        LEFT JOIN item_master im ON im.item_id = iv.item_id
                        WHERE vu.process_subprocess_id = %s
                        """
                    )
                    if vu_has_deleted:
                        base_variants_q += "\n  AND vu.deleted_at IS NULL"

                    base_variants_q += "\nORDER BY vu.substitute_group_id NULLS FIRST, vu.alternative_order NULLS LAST"
                    cur.execute(base_variants_q, (sp['process_subprocess_id'],))
                    variants = cur.fetchall()
                    print('VARIANT_COUNT_FOR_FIRST_SUBPROCESS=', len(variants))
                    if variants:
                        print('FIRST_VARIANT=', json.dumps(dict(variants[0]), default=str, indent=2))
                else:
                    print('No subprocess rows returned for process_id', process_id)

    except Exception as e:
        print('ERROR during variant_options SQL check:', repr(e))

print('\nDebug script finished')
