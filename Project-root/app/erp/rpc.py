"""The RPC bridge: POST /api/erp/rpc/<method>.

Stands in for Apps Script's google.script.run so the ported frontend JS can
call server methods by name with positional args, unchanged. Domain errors
come back as HTTP 200 with {success:false}; 401/403/404 are reserved for
auth/BOM-gate/unknown-method (BOM gate lands in a later phase).

Mutating methods are idempotent by X-Mutation-Id: a replayed id returns the
envelope stored from its first execution instead of re-running the method
(see mutations.py / erp.rpc_mutations).
"""

from __future__ import annotations

import uuid

from flask import current_app, jsonify, request
from flask_login import current_user, login_required

from app.middleware.request_id import get_request_id

from . import erp_rpc_bp
from .envelope import build_response
from .mutations import get_cached_result, store_result
from .registry import RPC_METHODS

# The service layer's own vocabulary for "expected, user-correctable"
# failures (verified: 222 raise ValueError + 5 raise RuntimeError sites
# across app/erp/services, 0 other exception types raised deliberately).
# Anything else reaching this handler is a bug, not a validation message,
# and must not be shown to the user verbatim -- see the except block below.
_DOMAIN_ERROR_TYPES = (ValueError, RuntimeError)


@erp_rpc_bp.route("/rpc/<method>", methods=["POST"])
@login_required
def call(method: str):
    spec = RPC_METHODS.get(method)
    if spec is None:
        return jsonify(build_response(False, None, f"Unknown method: {method}")), 404

    # A brand-new Google OAuth signup (app/utils.py's get_or_create_user)
    # defaults to role="pending_approval" -- until this check existed,
    # nothing anywhere read that value, so @login_required alone was
    # sufficient for full, unrestricted access to every one of the 135+
    # methods below. Blanket block, unconditional (not spec.roles-gated,
    # and not routed through has_role() -- that method treats "admin" as a
    # wildcard for any role check, which is the wrong semantics for "is this
    # account blocked", not "does it have permission X"). The only way out
    # is an admin's updateUserRole (users_service.py).
    if getattr(current_user, "role", None) == "pending_approval":
        return jsonify(build_response(
            False, None,
            "Your account is awaiting admin approval. You'll get access once an admin approves it.",
        )), 403

    # Authorization (see RpcSpec.roles in registry.py). spec.roles is None
    # for most methods -- current_user is guaranteed authenticated here by
    # @login_required.
    if spec.roles is not None and not any(current_user.has_role(r) for r in spec.roles):
        return jsonify(build_response(False, None, f"Not authorized to call {method}.")), 403

    mutation_id = request.headers.get("X-Mutation-Id")
    if spec.mutation:
        if not mutation_id:
            return jsonify(build_response(False, None, "X-Mutation-Id header is required for this method")), 400
        try:
            uuid.UUID(mutation_id)
        except ValueError:
            return jsonify(build_response(False, None, "X-Mutation-Id must be a UUID")), 400

        cached = get_cached_result(mutation_id)
        if cached is not None:
            return jsonify(cached), 200

    payload = request.get_json(silent=True) or {}
    args = payload.get("args") or []

    try:
        result = spec.func(*args)
    except _DOMAIN_ERROR_TYPES as exc:
        # Expected, user-correctable (bad input, business-rule violation) --
        # safe to show verbatim, same behaviour as before this change.
        result = build_response(False, None, str(exc))
    except Exception:  # noqa: BLE001 -- see _DOMAIN_ERROR_TYPES above
        # Anything else is a bug, not a validation message: str(exc) here
        # could be a raw psycopg2/AttributeError/KeyError message exposing
        # internals to the client, and -- critically -- until this change
        # nothing ever logged it, so the application could be substantially
        # broken while reporting HTTP 200 {success:false} on every request
        # with no server-side trace of why. Log with enough context to find
        # it, tell the user only that something went wrong plus a reference
        # id they can quote to support.
        request_id = get_request_id()
        current_app.logger.exception(
            "RPC method %s failed unexpectedly (user=%s, request_id=%s)",
            method,
            getattr(current_user, "id", None) if current_user and current_user.is_authenticated else None,
            request_id,
        )
        result = build_response(
            False, None,
            f"Something went wrong on our end. If this keeps happening, "
            f"quote reference {request_id} to support.",
        )

    if spec.mutation:
        store_result(mutation_id, method, result)

    return jsonify(result), 200
