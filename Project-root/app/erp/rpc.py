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

import time
import uuid

from flask import current_app, jsonify, request
from flask_login import current_user, login_required

from app.middleware.request_id import get_request_id

from . import erp_rpc_bp
from .envelope import build_response
from . import mutations
from .registry import RPC_METHODS, RpcSpec
from .services import activity_service
from .services.roles_service import TAB_BY_SERVICE_MODULE, get_effective_tab_level

# The service layer's own vocabulary for "expected, user-correctable"
# failures (verified: 222 raise ValueError + 5 raise RuntimeError sites
# across app/erp/services, 0 other exception types raised deliberately).
# Anything else reaching this handler is a bug, not a validation message,
# and must not be shown to the user verbatim -- see the except block below.
_DOMAIN_ERROR_TYPES = (ValueError, RuntimeError)


def _deny(spec: RpcSpec, reason: str, message: str):
    """Refuse a call with 403, and record the refusal (AUDIT-001).

    Every one of these is a user asking for something their role does not
    allow. Individually that is usually a stale browser tab holding a UI a
    demotion has since taken away; in a pattern it is the only signal this
    application has that someone is probing what they can reach. Neither is
    visible if the refusal only ever produces an HTTP status.

    Recorded for reads as well as mutations -- unlike the success path below,
    which covers mutations only -- because a refused read is exactly as
    interesting as a refused write and there is no volume problem: a refusal
    is rare by construction.
    """
    try:
        activity_service.record(
            category=activity_service.CATEGORY_RPC,
            action=spec.name,
            status=activity_service.STATUS_DENIED,
            entity_type=spec.module or None,
            detail=reason,
        )
    except Exception:  # noqa: BLE001 -- a refusal must still be a 403, not a 500
        current_app.logger.warning("Activity logging failed for denied %s", spec.name)
    return jsonify(build_response(False, None, message)), 403


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
        return _deny(
            spec,
            "Account is pending admin approval",
            "Your account is awaiting admin approval. You'll get access once an admin approves it.",
        )

    # Authorization (see RpcSpec.roles in registry.py). spec.roles is None
    # for most methods -- current_user is guaranteed authenticated here by
    # @login_required.
    if spec.roles is not None and not any(current_user.has_role(r) for r in spec.roles):
        return _deny(
            spec,
            f"Role '{getattr(current_user, 'role', None)}' is not one of {sorted(spec.roles)}",
            f"Not authorized to call {method}.",
        )

    # Custom-role per-tab permission gate (see roles_service.py). Only ever
    # runs for a role outside the 4 built-in ones -- user/admin/super_admin
    # keep their exact previous behaviour, completely untouched by this
    # check (get_effective_tab_level returns "editor" for all three
    # unconditionally, so the check below can never fire for them; this
    # early role-name comparison just skips the extra DB lookup for the
    # common case). A module absent from TAB_BY_SERVICE_MODULE (Units,
    # Company Settings, this user's own Profile, ...) is cross-cutting and
    # always allowed, same as today.
    if current_user.role not in ("user", "admin", "super_admin"):
        tab = TAB_BY_SERVICE_MODULE.get(spec.module)
        if tab is not None:
            level = get_effective_tab_level(current_user.role, tab)
            if level is None:
                return _deny(
                    spec,
                    f"Custom role '{current_user.role}' has no grant on tab '{tab}'",
                    f"Not authorized to call {method}.",
                )
            if spec.mutation and level != "editor":
                # Viewer can't mutate at all; Commenter's one narrow
                # exception (updateEntityRemarks) lives in remarks_service.py,
                # outside TAB_BY_SERVICE_MODULE, so it never reaches this
                # branch in the first place.
                return _deny(
                    spec,
                    f"Custom role '{current_user.role}' is '{level}', not 'editor', on tab '{tab}'",
                    f"Not authorized to call {method}.",
                )

    mutation_id = request.headers.get("X-Mutation-Id")
    if spec.mutation:
        if not mutation_id:
            return jsonify(
                build_response(
                    False, None, "X-Mutation-Id header is required for this method"
                )
            ), 400
        try:
            uuid.UUID(mutation_id)
        except ValueError:
            return jsonify(
                build_response(False, None, "X-Mutation-Id must be a UUID")
            ), 400

        # Claim the id BEFORE executing (DATA-003). This used to be a
        # SELECT-then-execute-then-INSERT, so two requests with the same id
        # arriving together both found no row, both ran the method, and the
        # loser's envelope was silently dropped by ON CONFLICT DO NOTHING --
        # the mutation ran twice while the caller was told it ran once.
        try:
            cached = mutations.claim(mutation_id, method)
        except mutations.MutationInProgress:
            # A concurrent duplicate, most often a double-submit. Answer
            # honestly rather than executing again or pretending success --
            # the client can retry the same id once the first one lands, and
            # will then get its stored envelope.
            return jsonify(
                build_response(
                    False,
                    None,
                    "This action is already being processed. Give it a moment, "
                    "then check whether it completed before trying again.",
                )
            ), 409

        if cached is not None:
            return jsonify(cached), 200

    payload = request.get_json(silent=True) or {}
    args = payload.get("args") or []

    # Tracks whether the claim taken above has been resolved. If the request
    # dies in a way that stores no envelope -- including a BaseException such
    # as a SIGTERM landing mid-execution during a gunicorn recycle -- the
    # finally block drops the claim, so a legitimate retry is not made to wait
    # out STALE_CLAIM_SECONDS for nothing.
    claim_settled = False
    # AUDIT-001 bookkeeping. `unhandled` distinguishes "the user was told no"
    # (a domain error -- expected, their input) from "this is broken" (any
    # other exception -- a bug), which the {success:false} envelope alone
    # cannot: both produce the same shape on the wire.
    unhandled = False
    started_at = time.perf_counter()
    try:
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
            unhandled = True
            request_id = get_request_id()
            current_app.logger.exception(
                "RPC method %s failed unexpectedly (user=%s, request_id=%s)",
                method,
                getattr(current_user, "id", None)
                if current_user and current_user.is_authenticated
                else None,
                request_id,
            )
            result = build_response(
                False,
                None,
                f"Something went wrong on our end. If this keeps happening, "
                f"quote reference {request_id} to support.",
            )

        if spec.mutation:
            # Both success and domain-failure envelopes are stored,
            # deliberately: a replayed duplicate of a rejected save must fail
            # identically rather than get a second attempt (see
            # migrations/erp/002's own note).
            mutations.complete(mutation_id, result)
            claim_settled = True
    finally:
        if spec.mutation and not claim_settled:
            try:
                mutations.release(mutation_id)
            except Exception:  # noqa: BLE001 -- cleanup must never mask the real error
                current_app.logger.warning(
                    "Failed to release mutation claim %s after an error", mutation_id
                )

    # The activity log (AUDIT-001). Mutations only: reads are polled on a
    # timer by every open tab and logging them would bury the actions that
    # matter. Written AFTER mutations.complete() so the idempotency envelope
    # -- the thing a retry depends on -- is durable first, and outside the
    # try/finally above so it can play no part in claim handling.
    #
    # A replayed X-Mutation-Id returns from the cache further up and so
    # records nothing, which is correct: the row describes the action, and the
    # action happened once.
    #
    # The try/except is not redundant with record()'s own: record() can only
    # guard what happens INSIDE it, and by this point the mutation has already
    # committed. Summarising the arguments, or anything else evaluated on the
    # way in, would otherwise turn a saved bill into a 500 the user sees and
    # retries -- the exact failure this whole feature must never cause.
    if spec.mutation:
        try:
            activity_service.record(
                category=activity_service.CATEGORY_RPC,
                action=method,
                status=(
                    activity_service.STATUS_ERROR
                    if unhandled
                    else activity_service.STATUS_SUCCESS
                    if isinstance(result, dict) and result.get("success")
                    else activity_service.STATUS_FAILURE
                ),
                entity_type=spec.module or None,
                detail=result.get("message") if isinstance(result, dict) else None,
                args=activity_service.describe_args(spec.func, args),
                duration_ms=(time.perf_counter() - started_at) * 1000,
            )
        except Exception:  # noqa: BLE001 -- see above
            current_app.logger.warning(
                "Activity logging failed for %s -- the mutation itself succeeded",
                method,
            )

    return jsonify(result), 200
