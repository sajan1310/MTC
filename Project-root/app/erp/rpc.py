"""The RPC bridge: POST /api/erp/rpc/<method>.

Stands in for Apps Script's google.script.run so the ported frontend JS can
call server methods by name with positional args, unchanged. Domain errors
come back as HTTP 200 with {success:false}; 401/403/404 are reserved for
auth/BOM-gate/unknown-method (BOM gate lands in a later phase).
"""

from __future__ import annotations

from flask import jsonify, request
from flask_login import login_required

from . import erp_rpc_bp
from .envelope import build_response
from .registry import RPC_METHODS


@erp_rpc_bp.route("/rpc/<method>", methods=["POST"])
@login_required
def call(method: str):
    spec = RPC_METHODS.get(method)
    if spec is None:
        return jsonify(build_response(False, None, f"Unknown method: {method}")), 404

    if spec.mutation and not request.headers.get("X-Mutation-Id"):
        return jsonify(build_response(False, None, "X-Mutation-Id header is required for this method")), 400

    payload = request.get_json(silent=True) or {}
    args = payload.get("args") or []

    try:
        result = spec.func(*args)
    except Exception as exc:  # noqa: BLE001 -- domain errors become {success:false}, not 500s
        return jsonify(build_response(False, None, str(exc))), 200

    return jsonify(result), 200
