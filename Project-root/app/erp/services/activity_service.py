"""User activity log -- who did what, when, from where (AUDIT-001).

Restores the capability the pre-port `app/services/audit_service.py` +
`public.audit_log` provided before cbd1c80 dropped them. See
`migrations/erp/041_activity_log.sql` for the history and the table.

Where the writes come from
--------------------------
The old AuditService had to be called by hand from every mutating endpoint,
which is why coverage was patchy -- a handful of call sites for a hundred-odd
mutations. This version is wired into the two places every user action
already funnels through, so a new RPC method is logged the day it is
registered without anyone remembering to add a line:

  * `app/erp/rpc.py` -- every `RpcSpec.mutation` call (success, domain
    failure and unhandled error alike), plus every authorization refusal on
    any method, mutating or not.
  * `app/auth/routes.py` -- sign-in (success and failure), sign-out, signup,
    and the password reset request/completion pair.

Reads are deliberately not logged. `getDashboardData` alone is polled on a
timer by every open tab; logging reads would bury the actions that matter
under millions of rows that say nothing happened.

Failure policy
--------------
`record()` never raises and never blocks the action it describes. An audit
write that fails must not turn a saved bill into an error the user sees --
it degrades to a WARNING in the application log, which is itself a signal
that the table or the pool is unhealthy.
"""

from __future__ import annotations

import inspect
import json
import logging
import os
import re
from typing import Any, Callable

import psycopg2.extras

import database
from .current_user import (
    get_current_user_email,
    get_current_user_id,
    get_current_user_role,
)
from ..envelope import build_response
from ..registry import rpc_method

logger = logging.getLogger(__name__)

# Categories and statuses. Kept as constants rather than a DB enum so adding
# one is a code change, not a migration -- the column is a plain VARCHAR.
CATEGORY_RPC = "rpc"
CATEGORY_AUTH = "auth"

STATUS_SUCCESS = "success"
STATUS_FAILURE = "failure"  # the user was told no (validation, business rule)
STATUS_DENIED = "denied"  # authorization refused
STATUS_ERROR = "error"  # unhandled exception -- a bug

# Any argument whose PARAMETER NAME matches is stored as "***" instead of its
# value. Matching on the name, not the value, is what makes this hold for
# methods added later: `changeMyPassword(current_password, new_password,
# confirm_password)`, `createUser(..., password, confirm_password, ...)` and
# `verifyBOMAccess(password)` are all covered today, and so is whatever the
# next one is called, as long as it names its parameter honestly.
_SENSITIVE_PARAM_RE = re.compile(
    r"pass|secret|token|credential|otp|hash", re.IGNORECASE
)
_REDACTED = "***"

# Size caps. An `args` blob is a debugging aid, not a second copy of the
# database: a dispatch save can carry hundreds of lines, and storing them all
# would make this table larger than the tables it describes.
_MAX_STRING = 200
_MAX_SEQUENCE = 20
_MAX_MAPPING = 40
_MAX_ARGS_BYTES = 8_000

_MAX_DETAIL = 2_000
_MAX_USER_AGENT = 255

# How long rows are kept. Pruned by the nightly job in backup_service.py.
# Longer than erp.rpc_mutations' 7 days on purpose -- that table exists to
# answer "did this retry already run", this one exists to answer "who changed
# this in March", and a quarter is the shortest window that survives a
# month-end close plus the argument about it.
RETENTION_DAYS = int(os.getenv("ACTIVITY_LOG_RETENTION_DAYS", "90"))


def _summarise(value: Any, depth: int = 0) -> Any:
    """Shrink `value` to something worth storing, recursively.

    Long strings are truncated, long lists and dicts are clipped with a
    marker saying how much was dropped, and anything unrecognised becomes its
    truncated repr -- so an argument that is not JSON-serialisable can never
    make the whole write fail.
    """
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        if len(value) <= _MAX_STRING:
            return value
        return value[:_MAX_STRING] + f"...(+{len(value) - _MAX_STRING} chars)"
    if depth >= 4:
        return "...(nested)"
    if isinstance(value, (list, tuple)):
        kept = [_summarise(v, depth + 1) for v in value[:_MAX_SEQUENCE]]
        if len(value) > _MAX_SEQUENCE:
            kept.append(f"...(+{len(value) - _MAX_SEQUENCE} more)")
        return kept
    if isinstance(value, dict):
        items = list(value.items())[:_MAX_MAPPING]
        out = {
            str(k): (
                _REDACTED
                if _SENSITIVE_PARAM_RE.search(str(k))
                else _summarise(v, depth + 1)
            )
            for k, v in items
        }
        if len(value) > _MAX_MAPPING:
            out["...(truncated)"] = f"+{len(value) - _MAX_MAPPING} more keys"
        return out
    return _summarise(repr(value), depth + 1)


def _parameter_names(func: Callable[..., Any]) -> list[str]:
    """The names of `func`'s positional parameters, as the RPC caller sees them.

    Most services are wrapped in `@database.transactional`, which injects
    `conn, cur` ahead of the caller's arguments. `functools.wraps` keeps
    `__wrapped__` intact so `inspect.signature` reports the ORIGINAL
    signature -- including those two -- while `spec.func(*args)` supplies
    only what came after them. Dropping a leading `conn, cur` pair realigns
    the names with the values; a service that is not transactional has no
    such pair and is left alone.
    """
    try:
        names = [
            p.name
            for p in inspect.signature(func).parameters.values()
            if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD, p.VAR_POSITIONAL)
        ]
    except (TypeError, ValueError):
        return []
    if names[:2] == ["conn", "cur"]:
        return names[2:]
    return names


def describe_args(func: Callable[..., Any] | None, args: Any) -> dict | None:
    """Build the redacted, size-capped `args` payload for one RPC call.

    Named arguments where the signature is readable ({"billId": 7, ...}),
    positional fallbacks otherwise ({"arg0": 7, ...}) -- never nothing, since
    "saveBill was called" without the id is a row nobody can act on.
    """
    if not isinstance(args, (list, tuple)):
        args = [args] if args is not None else []
    if not args:
        return None

    names = _parameter_names(func) if func is not None else []
    payload: dict[str, Any] = {}
    try:
        for index, value in enumerate(args):
            name = names[index] if index < len(names) else f"arg{index}"
            payload[name] = (
                _REDACTED if _SENSITIVE_PARAM_RE.search(name) else _summarise(value)
            )
    except Exception:  # noqa: BLE001 -- an argument whose repr() raises is not
        # worth losing the row over, let alone failing the request it describes.
        return {"__unsummarisable__": True}

    try:
        encoded = json.dumps(payload, default=str)
    except (TypeError, ValueError):
        return {"__unserialisable__": True}
    if len(encoded) > _MAX_ARGS_BYTES:
        return {"__omitted__": f"arguments too large to store ({len(encoded)} bytes)"}
    return payload


def _request_context() -> tuple[str | None, str | None, str | None]:
    """(ip_address, user_agent, request_id), or (None, None, None) off-request.

    Everything here is best-effort: `record()` is also called from the auth
    routes and could one day be called from a background job, and no part of
    it is worth failing an audit write over.
    """
    try:
        from flask import has_request_context, request
    except Exception:  # noqa: BLE001 -- Flask absent is not this module's problem
        return None, None, None

    if not has_request_context():
        return None, None, None

    try:
        # ProxyFix-aware: app/__init__.py puts it in front when the app runs
        # behind a reverse proxy, so remote_addr is the real client there and
        # the raw socket peer in development.
        ip = request.remote_addr
        agent = (request.user_agent.string or "")[:_MAX_USER_AGENT] or None
    except Exception:  # noqa: BLE001
        ip, agent = None, None

    try:
        from app.middleware.request_id import get_request_id

        request_id = get_request_id()
    except Exception:  # noqa: BLE001
        request_id = None

    return ip, agent, request_id


_INSERT_SQL = """
    INSERT INTO erp.activity_log
        (user_id, user_email, user_role, category, action, entity_type,
         status, detail, args, ip_address, user_agent, request_id, duration_ms)
    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
"""


def record(
    *,
    category: str,
    action: str,
    status: str,
    entity_type: str | None = None,
    detail: str | None = None,
    args: dict | None = None,
    duration_ms: float | None = None,
    user_id: int | None = None,
    user_email: str | None = None,
    user_role: str | None = None,
    cur=None,
) -> None:
    """Write one activity row. Never raises.

    Identity defaults to the logged-in user. The auth routes pass it
    explicitly instead, because at sign-in time there is no session yet and
    at sign-out time the session has already been torn down.

    Pass `cur` when the caller already holds a pooled connection -- the same
    convention as `units_service.get_units_map(cur)`. database.get_conn()
    refuses to nest (STRICT_NESTED_CONNECTIONS), so acquiring a second one
    from inside a transaction would silently lose the row to this function's
    own except block. The trade-off is that the audit row then shares the
    caller's transaction and rolls back with it -- which is what you want at
    the only call site that needs it (a signup that rolls back created no
    account, so it should leave no "signed up" row either).
    """
    try:
        if user_id is None:
            user_id = get_current_user_id()
        if user_email is None:
            user_email = get_current_user_email() or None
        if user_role is None:
            user_role = get_current_user_role() or None

        ip, agent, request_id = _request_context()

        if detail is not None:
            detail = str(detail)[:_MAX_DETAIL] or None

        params = (
            user_id,
            user_email[:255] if user_email else None,
            user_role[:50] if user_role else None,
            category[:20],
            action[:100],
            entity_type[:100] if entity_type else None,
            status[:20],
            detail,
            psycopg2.extras.Json(args) if args is not None else None,
            ip[:45] if ip else None,
            agent,
            str(request_id)[:64] if request_id else None,
            round(float(duration_ms), 2) if duration_ms is not None else None,
        )

        if cur is not None:
            # Wrapped in a SAVEPOINT, because in Postgres ANY failed statement
            # aborts the whole transaction: without this, a missing table or a
            # too-long value here would roll back the very signup the row was
            # meant to describe -- the audit log breaking the action it
            # documents, which is the one thing this module must never do.
            cur.execute("SAVEPOINT activity_log")
            try:
                cur.execute(_INSERT_SQL, params)
            except Exception:
                cur.execute("ROLLBACK TO SAVEPOINT activity_log")
                raise  # caught below, and logged like any other write failure
            cur.execute("RELEASE SAVEPOINT activity_log")
        else:
            with database.get_conn() as (_conn, own_cur):
                own_cur.execute(_INSERT_SQL, params)
    except Exception:  # noqa: BLE001 -- see the module docstring's failure policy
        # .warning not .exception: if the table is missing or the pool is
        # exhausted this fires on every single mutation, and a full traceback
        # per request would bury the cause in its own noise.
        logger.warning(
            "Activity logging failed for %s/%s -- the action itself was unaffected",
            category,
            action,
            exc_info=logger.isEnabledFor(logging.DEBUG),
        )


def prune_old_activity(retention_days: int = RETENTION_DAYS) -> int:
    """Delete rows past the retention window. Returns rows removed.

    Called from backup_service.py's nightly job, alongside the equivalent
    prune for erp.rpc_mutations -- an audit log with no ceiling is a disk
    outage on a schedule.
    """
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "DELETE FROM erp.activity_log WHERE logged_at < NOW() - make_interval(days => %s)",
            (retention_days,),
        )
        return cur.rowcount or 0


_PAGE_SIZE_DEFAULT = 50
_PAGE_SIZE_MAX = 200

# Filter keys accepted from the client, mapped to their column. An allowlist,
# not string interpolation of whatever arrives -- the column name is chosen
# here and the value is always a bound parameter.
_EQUALITY_FILTERS = {
    "action": "action",
    "entityType": "entity_type",
    "category": "category",
    "status": "status",
}


@rpc_method("getActivityLog", roles=frozenset({"admin"}))
def get_activity_log(filters=None, page=1, page_size=_PAGE_SIZE_DEFAULT):
    """Read the activity log, newest first (admin-only).

    `filters` is an optional object: {userId, action, entityType, category,
    status, fromDate, toDate, search}. `search` matches the user's email or
    the detail text.

    Admin-only for the obvious reason -- this is the record of everyone's
    actions, including their failures. `roles=frozenset({"admin"})` is what
    rpc.py enforces, and User.has_role() already treats super_admin as a
    superset of admin.
    """
    filters = filters if isinstance(filters, dict) else {}

    try:
        page = max(1, int(page or 1))
    except (TypeError, ValueError):
        page = 1
    try:
        page_size = min(_PAGE_SIZE_MAX, max(1, int(page_size or _PAGE_SIZE_DEFAULT)))
    except (TypeError, ValueError):
        page_size = _PAGE_SIZE_DEFAULT

    where: list[str] = []
    params: list[Any] = []

    if filters.get("userId") not in (None, ""):
        try:
            where.append("user_id = %s")
            params.append(int(filters["userId"]))
        except (TypeError, ValueError):
            raise ValueError("userId must be a number.")

    for key, column in _EQUALITY_FILTERS.items():
        value = str(filters.get(key) or "").strip()
        if value:
            where.append(f"{column} = %s")
            params.append(value)

    if str(filters.get("fromDate") or "").strip():
        where.append("logged_at >= %s::date")
        params.append(str(filters["fromDate"]).strip())
    if str(filters.get("toDate") or "").strip():
        # Inclusive of the whole end day, which is what a date picker means.
        where.append("logged_at < (%s::date + INTERVAL '1 day')")
        params.append(str(filters["toDate"]).strip())

    search = str(filters.get("search") or "").strip()
    if search:
        where.append("(user_email ILIKE %s OR detail ILIKE %s)")
        params.extend([f"%{search}%", f"%{search}%"])

    where_sql = f"WHERE {' AND '.join(where)}" if where else ""

    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        _conn,
        cur,
    ):
        cur.execute(
            f"SELECT COUNT(*) AS total FROM erp.activity_log {where_sql}", params
        )
        total = int(cur.fetchone()["total"])

        cur.execute(
            f"""
            SELECT id, logged_at, user_id, user_email, user_role, category, action,
                   entity_type, status, detail, args, ip_address, request_id, duration_ms
            FROM erp.activity_log
            {where_sql}
            ORDER BY logged_at DESC, id DESC
            LIMIT %s OFFSET %s
            """,
            [*params, page_size, (page - 1) * page_size],
        )
        rows = cur.fetchall()

    entries = [
        {
            "id": row["id"],
            "timestamp": row["logged_at"].isoformat() if row["logged_at"] else None,
            "userId": row["user_id"],
            "userEmail": row["user_email"],
            "userRole": row["user_role"],
            "category": row["category"],
            "action": row["action"],
            "entityType": row["entity_type"],
            "status": row["status"],
            "detail": row["detail"],
            "args": row["args"],
            "ipAddress": row["ip_address"],
            "requestId": row["request_id"],
            "durationMs": (
                float(row["duration_ms"]) if row["duration_ms"] is not None else None
            ),
        }
        for row in rows
    ]

    return build_response(
        True,
        {
            "entries": entries,
            "total": total,
            "page": page,
            "pageSize": page_size,
            "totalPages": (total + page_size - 1) // page_size if total else 0,
        },
    )
