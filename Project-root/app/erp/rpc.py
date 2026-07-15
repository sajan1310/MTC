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

from flask import jsonify, request
from flask_login import login_required

from . import erp_rpc_bp
from .envelope import build_response
from .mutations import get_cached_result, store_result
from .registry import RPC_METHODS


@erp_rpc_bp.route("/rpc/<method>", methods=["POST"])
@login_required
def call(method: str):
    spec = RPC_METHODS.get(method)
    if spec is None:
        return jsonify(build_response(False, None, f"Unknown method: {method}")), 404

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
    except Exception as exc:  # noqa: BLE001 -- domain errors become {success:false}, not 500s
        result = build_response(False, None, str(exc))

    if spec.mutation:
        store_result(mutation_id, method, result)

    return jsonify(result), 200
