"""Company Logo management, ported from Apps_Script/utils.js's
saveLogo/getLogo/clearLogo (wired from Script_Core.html's App.Logo).

Source stored the logo as a base64 data URL split across multiple
PropertiesService entries -- each property value is capped at ~9KB, too
small for a compressed logo data URL to fit in one, hence the client-side
chunking. Postgres has no such limit, so this is stored as a single TEXT
value in a singleton row (erp.company_settings, id always 1) -- the chunks
are simply joined back together here; chunking itself is not reproduced,
it was purely an Apps Script storage workaround, not a feature in its own
right.
"""

from __future__ import annotations

import psycopg2.extras

import database
from .current_user import get_current_user_id
from ..envelope import build_response
from ..registry import rpc_method


@rpc_method("getLogo")
def get_logo():
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        cur.execute("SELECT logo_data_url FROM erp.company_settings WHERE id = 1")
        row = cur.fetchone()
    return build_response(True, row["logo_data_url"] if row else None)


@rpc_method("saveLogo", mutation=True)
@database.transactional
def save_logo(conn, cur, chunks):
    data_url = "".join(chunks or [])
    if not data_url:
        raise ValueError("No logo data received.")

    cur.execute(
        """
        INSERT INTO erp.company_settings (id, logo_data_url, updated_by)
        VALUES (1, %s, %s)
        ON CONFLICT (id) DO UPDATE SET
            logo_data_url = EXCLUDED.logo_data_url,
            updated_at = NOW(),
            updated_by = EXCLUDED.updated_by
        """,
        (data_url, get_current_user_id()),
    )
    return build_response(True)


@rpc_method("clearLogo", mutation=True)
@database.transactional
def clear_logo(conn, cur):
    cur.execute(
        """
        INSERT INTO erp.company_settings (id, logo_data_url, updated_by)
        VALUES (1, NULL, %s)
        ON CONFLICT (id) DO UPDATE SET
            logo_data_url = NULL,
            updated_at = NOW(),
            updated_by = EXCLUDED.updated_by
        """,
        (get_current_user_id(),),
    )
    return build_response(True)
