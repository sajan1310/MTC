"""RPC method registry -- the allowlist for POST /api/erp/rpc/<method>.

Ports the ~117-method surface of Apps Script's google.script.run bridge.
Each ERP service function registers itself under its original Apps Script
method name via @rpc_method(...), so the frontend port (Script_ApiCore.html's
_apiCall) can call methods by name exactly as it does today.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable


@dataclass(frozen=True)
class RpcSpec:
    name: str
    func: Callable[..., Any]
    mutation: bool = False
    offline: bool = False
    bom_gated: bool = False
    # Authorization mechanism (plumbing only -- see rpc.py's enforcement).
    # None (the default, and today the value for all 135 registered methods)
    # means "no restriction beyond @login_required", i.e. today's actual
    # behaviour is completely unchanged by this field's existence. A method
    # can opt in later by passing roles={"manager", "admin"} to @rpc_method;
    # the dispatcher then requires current_user.has_role() to match one of
    # them (User.has_role(), app/models/user.py, already treats "admin" as
    # a superuser wildcard for any role check).
    #
    # Deliberately NOT populated for any real method yet: which of the 82
    # mutating methods should require which role is a business decision
    # (who may delete records, adjust stock, trigger backups), not a
    # technical one -- see PYTHON_BACKEND_REVIEW.md PY-009. Assigning that
    # is next; this field makes it a one-line change per method once the
    # answer exists, with no dispatcher change required.
    roles: frozenset[str] | None = None


RPC_METHODS: dict[str, RpcSpec] = {}


def rpc_method(
    name: str,
    *,
    mutation: bool = False,
    offline: bool = False,
    bom_gated: bool = False,
    roles: frozenset[str] | set[str] | None = None,
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Register `func` under `name` in RPC_METHODS.

    Raises on duplicate registration -- two services accidentally claiming
    the same Apps Script method name is a bug, not something to silently
    overwrite.
    """

    def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
        if name in RPC_METHODS:
            raise ValueError(f"RPC method '{name}' is already registered")
        RPC_METHODS[name] = RpcSpec(
            name=name,
            func=func,
            mutation=mutation,
            offline=offline,
            bom_gated=bom_gated,
            roles=frozenset(roles) if roles is not None else None,
        )
        return func

    return decorator
